/**
 * render/Atmosphere.js
 * ---------------------------------------------------------------------------
 * Sky, sun, image-based lighting, aerial perspective and shadows — the part of
 * the renderer that decides whether an outdoor scene reads as a photograph or
 * as a pile of coloured boxes.
 *
 * Four pieces, all driven from one sun direction so they can never disagree:
 *
 *   1. A Preetham analytic sky dome (with drifting procedural clouds).
 *   2. Image-based lighting: the sky (plus a ground hemisphere below the
 *      horizon, standing in for bounce light) is rendered once into a PMREM
 *      environment map and set as `scene.environment`. Every PBR material in
 *      the scene then gets a correctly tinted ambient term and sky reflections
 *      for free — windows, water and wet rock stop looking painted.
 *   3. Sunlight colour and fog colour are computed on the CPU by evaluating the
 *      same scattering model the sky shader uses (a straight JS port). A low
 *      sun therefore turns the light warm and the haze orange *automatically*,
 *      and distant terrain fades into exactly the colour of the sky behind it.
 *   4. A single shadow-casting sun whose orthographic shadow frustum follows the
 *      drone, snapped to whole shadow-map texels so the shadows stay crisp and
 *      do not shimmer as it moves. A 2 km map gets centimetre-sharp shadows
 *      exactly where the pilot is looking, for the cost of one shadow map.
 *
 * Indoor maps skip the sky and instead capture their *own* lit interior into
 * the environment map after they build (`captureEnvironment`), which gives
 * reflections and ambient that actually match the room.
 *
 * Stability contract, same as the rest of the renderer: nothing in here may
 * take the frame down. PMREM generation, render-target reads and shader
 * compiles are all wrapped; a failure leaves the scene lit by the plain lights.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, uniform, varying,
  acos, clamp, cos, dot, exp, floor, fract, max, mix, normalize, pow, smoothstep,
  cameraPosition, modelViewProjection, positionWorld, property,
} from 'three/tsl';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';
import { activeQuality } from './Quality.js';
import { sunState } from './SunState.js';

const DEG = Math.PI / 180;

/** Default outdoor look — a clear late-morning sky. Maps override any field. */
const OUTDOOR_DEFAULTS = {
  sunElevation: 38,        // degrees above the horizon
  sunAzimuth: 135,         // degrees, 0 = +X, increasing toward +Z
  turbidity: 3.0,
  rayleigh: 1.25,
  mieCoefficient: 0.0045,
  mieDirectionalG: 0.8,
  clouds: 0.32,            // 0..1 coverage
  cloudDensity: 0.62,
  cloudScale: 1.0,
  exposure: 0.58,
  sunIntensity: 3.4,
  envIntensity: 1.0,
  hemiIntensity: 0.18,
  fogDensity: 0.00042,     // FogExp2 density, 1/m
  fogTint: 1.0,            // multiplier on the sampled horizon colour
  groundColor: 0x55603c,   // bounce colour below the horizon (albedo-ish, sRGB)
  shadowStrength: 1.0,
};

/* ========================================================================== *
 * Sky material (TSL)
 * ========================================================================== */

/**
 * Preetham sky, adapted from three's Sky shader with three changes:
 *   - the lower hemisphere fades into a ground colour instead of repeating the
 *     horizon, so the environment map has a believable bounce term;
 *   - clouds are lit relative to the sky's own brightness (computed once in
 *     the vertex stage), which keeps them white at noon and pink at dusk;
 *   - clouds self-shadow with a second sample offset toward the sun.
 *
 * This is a line-for-line TSL port of the original GLSL (three's SkyMesh is
 * the reference for the node idioms). Every former uniform is a `uniform()`
 * node under the same name in `material.uniforms`, so the update sites below
 * (`u.turbidity.value = …`) are unchanged. Values that the GLSL computed in
 * the vertex stage stay there, through `varying()`.
 */
function createSkyMaterial() {
  const U = {
    turbidity: uniform(3),
    rayleigh: uniform(1.2),
    mieCoefficient: uniform(0.005),
    mieDirectionalG: uniform(0.8),
    sunPosition: uniform(new THREE.Vector3(0, 1, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    uGround: uniform(new THREE.Color(0x2c3322)),
    uCloudCover: uniform(0.3),
    uCloudDensity: uniform(0.6),
    uCloudScale: uniform(1.0),
    uTime: uniform(0),
    uShowSun: uniform(1),
  };

  const pi = float(3.141592653589793);
  const e = float(2.718281828459045);
  const totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
  const cutoffAngle = float(1.6110731556870734);
  const steepness = float(1.5);
  const EE = float(1000.0);

  const sunIntensity = (zenithAngleCos) => {
    const z = clamp(zenithAngleCos, -1.0, 1.0);
    return EE.mul(max(0.0, float(1.0).sub(pow(e, cutoffAngle.sub(acos(z)).div(steepness).negate()))));
  };
  const totalMie = (T) => {
    const c = float(0.2).mul(T).mul(10E-18);
    return float(0.434).mul(c).mul(MieConst);
  };
  const rayleighPhase = (cosTheta) => float(0.05968310365946075).mul(float(1.0).add(cosTheta.mul(cosTheta)));
  const hgPhase = (cosTheta, g) => {
    const g2 = g.mul(g);
    return float(0.07957747154594767).mul(float(1.0).sub(g2).div(pow(float(1.0).sub(float(2.0).mul(g).mul(cosTheta)).add(g2), 1.5)));
  };
  /** Optical-length factor for a zenith angle (the GLSL `inverse`). */
  const opticalInverse = (zenithAngle) => float(1.0).div(
    cos(zenithAngle).add(float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0).div(pi)), -1.253))),
  );

  /* ---- vertex stage (per-draw constants, carried as varyings) ---- */
  const sunDirV = normalize(U.sunPosition);
  const betaRV = totalRayleigh.mul(U.rayleigh);
  const betaMV = totalMie(U.turbidity).mul(U.mieCoefficient);
  const sunEV = sunIntensity(dot(sunDirV, U.up));

  const skyAt = (direction) => {
    const zenithAngle = acos(max(0.0, dot(U.up, direction)));
    const inv = opticalInverse(zenithAngle);
    const Fex = exp(betaRV.mul(8.4E3).mul(inv).add(betaMV.mul(1.25E3).mul(inv)).negate());
    const cosTheta = dot(direction, sunDirV);
    const bR = betaRV.mul(rayleighPhase(cosTheta.mul(0.5).add(0.5)));
    const bM = betaMV.mul(hgPhase(cosTheta, U.mieDirectionalG));
    const ratio = bR.add(bM).div(betaRV.add(betaMV));
    const Lin = pow(sunEV.mul(ratio).mul(float(1.0).sub(Fex)), vec3(1.5)).mul(
      mix(vec3(1.0), pow(sunEV.mul(ratio).mul(Fex), vec3(0.5)), clamp(pow(float(1.0).sub(dot(U.up, sunDirV)), 5.0), 0.0, 1.0)),
    );
    return Lin.add(vec3(0.1).mul(Fex)).mul(0.04);
  };

  // Reference brightness for cloud lighting: the sky 30 degrees up, facing
  // away from the sun. Same for every vertex; costs nothing.
  const away = normalize(vec3(sunDirV.x.negate(), 0.0, sunDirV.z.negate()).add(vec3(0.0, 0.58, 0.0)));
  const za = acos(max(0.0, dot(U.up, sunDirV)));
  const invSun = opticalInverse(za);

  const vSunDirection = varying(sunDirV, 'vSunDirection');
  const vBetaR = varying(betaRV, 'vBetaR');
  const vBetaM = varying(betaMV, 'vBetaM');
  const vSunE = varying(sunEV, 'vSunE');
  const vSkyRef = varying(skyAt(away), 'vSkyRef');
  // Sun transmittance tint for cloud tops.
  const vSunTint = varying(exp(betaRV.mul(8.4E3).mul(invSun).add(betaMV.mul(1.25E3).mul(invSun)).negate()), 'vSunTint');

  /* ---- fragment stage ---- */
  const h12 = (p) => {
    const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
    p3.addAssign(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
  };
  const vnoise = Fn(([pIn]) => {
    const p = vec2(pIn);
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(
      mix(h12(i), h12(i.add(vec2(1, 0))), u.x),
      mix(h12(i.add(vec2(0, 1))), h12(i.add(vec2(1, 1))), u.x),
      u.y,
    );
  });
  // mat2(0.8, -0.6, 0.6, 0.8) * p, written out (GLSL matrices are column-major).
  const rot = (p) => vec2(p.x.mul(0.8).add(p.y.mul(0.6)), p.x.mul(-0.6).add(p.y.mul(0.8)));
  const cfbm = Fn(([pIn]) => {
    const p = vec2(pIn).toVar();
    const v = float(0.0).toVar();
    let a = 0.5;
    for (let i = 0; i < 5; i++) {
      v.addAssign(vnoise(p).mul(a));
      p.assign(rot(p).mul(2.02));
      a *= 0.5;
    }
    return v;
  });

  // The sun disc's radiance, written by the colour stage and read back as
  // the emissive term (see below).
  const skySun = property('vec3', 'fpvSkySun');

  const colorNode = Fn(() => {
    const direction = normalize(positionWorld.sub(cameraPosition));

    const zenithAngle = acos(max(0.0, dot(U.up, direction)));
    const inverse = opticalInverse(zenithAngle);
    const Fex = exp(vBetaR.mul(8.4E3).mul(inverse).add(vBetaM.mul(1.25E3).mul(inverse)).negate());

    const cosTheta = dot(direction, vSunDirection);
    const betaRTheta = vBetaR.mul(rayleighPhase(cosTheta.mul(0.5).add(0.5)));
    const betaMTheta = vBetaM.mul(hgPhase(cosTheta, U.mieDirectionalG));
    const ratio = betaRTheta.add(betaMTheta).div(vBetaR.add(vBetaM));

    const Lin = pow(vSunE.mul(ratio).mul(float(1.0).sub(Fex)), vec3(1.5)).mul(
      mix(vec3(1.0), pow(vSunE.mul(ratio).mul(Fex), vec3(0.5)), clamp(pow(float(1.0).sub(dot(U.up, vSunDirection)), 5.0), 0.0, 1.0)),
    );

    const sunAngularDiameterCos = float(0.99995);
    const sundisc = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos.add(0.00002), cosTheta).mul(U.uShowSun);
    const L0 = vec3(0.1).mul(Fex);
    // The sun disc is carried separately as the material's emissive (below),
    // so the post pipeline's bloom target sees the sun and not the sky. The
    // sum colour + emissive is the GLSL's (Lin + L0 + disc) * 0.04.
    const sun = vSunE.mul(19000.0).mul(Fex).mul(sundisc).mul(0.04).toVar();

    const col = Lin.add(L0).mul(0.04).add(vec3(0.0, 0.0003, 0.00075)).toVar();

    // Clouds: one layer projected onto a plane, horizon-compressed.
    If(direction.y.greaterThan(0.0).and(U.uCloudCover.greaterThan(0.001)), () => {
      const uv = direction.xz.div(direction.y.add(0.14)).mul(1.6).mul(U.uCloudScale)
        .add(vec2(U.uTime.mul(0.0045), U.uTime.mul(0.0016))).toVar();
      const warp = vec2(cfbm(uv.mul(0.7).add(3.1)), cfbm(uv.mul(0.7).sub(1.7)));
      const n = cfbm(uv.add(warp.mul(0.6)));
      const cover = smoothstep(float(1.0).sub(U.uCloudCover).sub(0.02), float(1.0).sub(U.uCloudCover).add(0.32), n);
      // Self-shadowing: denser cloud between this point and the sun darkens it.
      const nSun = cfbm(uv.add(warp.mul(0.6)).add(normalize(vSunDirection.xz.add(1e-4)).mul(0.09)));
      const shade = clamp(float(0.62).add(n.sub(nSun).mul(4.0)), 0.25, 1.15);
      const lum = dot(vSkyRef, vec3(0.2126, 0.7152, 0.0722));
      const sunLit = vSunTint.div(max(max(vSunTint.r, max(vSunTint.g, vSunTint.b)), 1e-4));
      const cloudCol = lum.mul(2.6).mul(mix(vec3(0.62, 0.66, 0.74), sunLit.mul(1.12), shade))
        // Forward-scatter glow around the sun.
        .add(lum.mul(1.4).mul(sunLit).mul(pow(max(cosTheta, 0.0), 12.0)).mul(float(1.0).sub(cover.mul(0.5))));
      const fade = smoothstep(0.0, 0.16, direction.y);
      const cloudMix = cover.mul(U.uCloudDensity).mul(fade);
      col.assign(mix(col, cloudCol, cloudMix));
      sun.mulAssign(float(1.0).sub(cloudMix));
    });

    // Below the horizon: fade to a lit ground colour (bounce light for IBL).
    // (GLSL smoothstep(0.0, -0.06, y), written with ordered edges for WGSL.)
    const below = float(1.0).sub(smoothstep(-0.06, 0.0, direction.y));
    const groundLight = dot(vSkyRef, vec3(0.2126, 0.7152, 0.0722)).mul(1.6)
      .mul(float(0.35).add(float(0.65).mul(clamp(vSunDirection.y.mul(2.0), 0.0, 1.0))));
    col.assign(mix(col, U.uGround.mul(groundLight), below));
    sun.mulAssign(float(1.0).sub(below));

    // The disc is ~6e5 in these units, which overflows the half-float scene
    // buffer to infinity and would smear NaN through bloom. ACES is flat
    // white long before 64, so the cap is invisible except in the glow.
    skySun.assign(sun.min(64.0));
    return vec4(col.min(64.0), 1.0);
  })();

  const material = new THREE.MeshBasicNodeMaterial({
    name: 'FpvSky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  // Pin the dome to the far plane (the GLSL `gl_Position.z = gl_Position.w`).
  material.vertexNode = Fn(() => {
    const position = modelViewProjection.toVar();
    position.z.assign(position.w);
    return position;
  })();
  material.colorNode = colorNode;
  material.emissiveNode = skySun;
  material.uniforms = U;
  return material;
}

/* ========================================================================== *
 * CPU port of the scattering model (sun colour, fog colour, sky ambient)
 * ========================================================================== */

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

function sunIntensityJs(zenithCos) {
  const z = Math.min(1, Math.max(-1, zenithCos));
  return 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(z)) / 1.5)));
}

/**
 * Evaluate sky radiance for a view direction, exactly as the shader does (sun
 * disc excluded). Returns linear RGB in the same HDR units the sky renders in.
 */
export function skyRadiance(dir, sunDir, p, out = [0, 0, 0]) {
  const sunE = sunIntensityJs(sunDir.y);
  const betaR = TOTAL_RAYLEIGH.map((v) => v * p.rayleigh);
  const c = 0.2 * p.turbidity * 10e-18;
  const betaM = MIE_CONST.map((v) => 0.434 * c * v * p.mieCoefficient);

  const zen = Math.acos(Math.max(0, dir.y));
  const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - (zen * 180) / Math.PI, -1.253));
  const cosT = dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z;
  const rc = (cosT * 0.5 + 0.5);
  const rPhase = 0.05968310365946075 * (1 + rc * rc);
  const g = p.mieDirectionalG;
  const g2 = g * g;
  const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * g * cosT + g2, 1.5));
  const horizonMix = Math.min(1, Math.max(0, Math.pow(1 - sunDir.y, 5)));
  for (let k = 0; k < 3; k++) {
    const fex = Math.exp(-(betaR[k] * 8.4e3 * inv + betaM[k] * 1.25e3 * inv));
    const ratio = (betaR[k] * rPhase + betaM[k] * mPhase) / (betaR[k] + betaM[k]);
    let lin = Math.pow(sunE * ratio * (1 - fex), 1.5);
    lin *= 1 + (Math.pow(sunE * ratio * fex, 0.5) - 1) * horizonMix;
    out[k] = (lin + 0.1 * fex) * 0.04 + (k === 1 ? 0.0003 : k === 2 ? 0.00075 : 0);
  }
  return out;
}

/** Atmospheric transmittance along the sun direction (per channel, 0..1). */
function sunTransmittance(sunDir, p) {
  const betaR = TOTAL_RAYLEIGH.map((v) => v * p.rayleigh);
  const c = 0.2 * p.turbidity * 10e-18;
  const betaM = MIE_CONST.map((v) => 0.434 * c * v * p.mieCoefficient);
  const zen = Math.acos(Math.max(0.0, sunDir.y));
  const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(Math.max(93.885 - (zen * 180) / Math.PI, 1e-3), -1.253));
  return [0, 1, 2].map((k) => Math.exp(-(betaR[k] * 8.4e3 * inv + betaM[k] * 1.25e3 * inv)));
}

/* ========================================================================== *
 * Atmosphere
 * ========================================================================== */

export class Atmosphere {
  /**
   * @param {THREE.WebGPURenderer} renderer
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    /** 'none' until a map configures it; 'outdoor' | 'indoor' after. */
    this.mode = 'none';
    this.params = { ...OUTDOOR_DEFAULTS };
    this.sunDir = new THREE.Vector3(0.4, 0.6, 0.4).normalize();

    // Time-of-day / weather offsets from the settings sliders. 0.5 = the
    // map's authored sun; overcast 0 = the map's authored clouds.
    this._dayOffset = 0.5;
    this._overcast = 0;

    this.group = new THREE.Group();
    this.group.name = 'atmosphere';

    /* ---- sun ---- */
    this.sun = null;
    this.sunTarget = new THREE.Object3D();
    this.group.add(this.sunTarget);
    this._makeSun();

    /* ---- cascaded shadows (outdoor maps, see _setupCsm) ---- */
    this.csm = null;
    this._viewCamera = null;
    this._csmProjKey = '';

    this.hemi = new THREE.HemisphereLight(0xbfd6f0, 0x4a4a38, 0.2);
    this.hemi.name = 'atmosphere-hemi';
    this.group.add(this.hemi);

    /* ---- sky ---- */
    this.sky = null;
    this._envScene = null;
    this._envTarget = null;
    this._pmrem = null;
    this._envDirty = false;
    this._envTimer = 0;

    this.fogColor = new THREE.Color(0xb8c8d8);
    this._ownFog = null;          // the FogExp2 this module created, if any
    this._fixedFocus = null;      // indoor maps pin the shadow frustum
    this._snap = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._upv = new THREE.Vector3();
    this._fwd = new THREE.Vector3();

    this.applyQuality();
  }

  /**
   * (Re)create the sun light. A fresh light per map lets the outdoor/indoor
   * shadow strategy change: the node system caches a light's shadow node the
   * first time a material is built against it, so swapping a live light from
   * a single shadow map to cascades would not take effect.
   */
  _makeSun() {
    const prev = this.sun;
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.name = 'atmosphere-sun';
    sun.castShadow = true;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.035;
    sun.target = this.sunTarget;
    if (prev) {
      sun.color.copy(prev.color);
      sun.intensity = prev.intensity;
      sun.position.copy(prev.position);
      this.group.remove(prev);
      try { prev.dispose(); } catch (_e) { /* ignore */ }
    }
    this.sun = sun;
    this.group.add(sun);
    return sun;
  }

  /** The camera the pilot sees through; cascaded shadows split its frustum. */
  setViewCamera(camera) {
    this._viewCamera = camera || null;
  }

  /**
   * Cascaded shadow maps for open maps: `csmCascades` shadow maps split along
   * the view frustum out to 4x the tier's shadow range, so the ground under
   * the quad is centimetre-sharp and the far hills still cast shadows. This
   * replaces the single frustum that _followShadow drags along with the drone.
   * Part-roofed and indoor maps keep the pinned single map (their whole
   * building has to be in the shadow volume at once).
   */
  _setupCsm() {
    this._disposeCsm();
    const q = activeQuality;
    const cascades = q.csmCascades | 0;
    if (cascades <= 0 || this._fixedFocus || !this._viewCamera) return;
    if (this.renderer?.shadowMap?.enabled === false) return;
    try {
      const csm = new CSMShadowNode(this.sun, {
        cascades,
        maxFar: this.shadowRange * 4,
        mode: 'practical',
        lightMargin: 300,
      });
      // Bind the cascades to the pilot's camera now. Left to itself the node
      // adopts whichever camera first compiles a lit material, which may be
      // the environment capture or the water reflector.
      csm._init({ camera: this._viewCamera, renderer: this.renderer });
      this.sun.shadow.shadowNode = csm;
      this.csm = csm;
      this._csmProjKey = '';
    } catch (err) {
      console.warn('[Atmosphere] cascaded shadows unavailable; using the follow-shadow.', err);
      this._disposeCsm();
    }
  }

  _disposeCsm() {
    if (!this.csm) return;
    try { this.csm.dispose(); } catch (_e) { /* ignore */ }
    if (this.sun?.shadow) this.sun.shadow.shadowNode = null;
    this.csm = null;
  }

  /* ---------------------------------------------------------------------- *
   * Quality
   * ---------------------------------------------------------------------- */

  /** Re-read shadow resolution/range from the active quality preset. */
  applyQuality() {
    const q = activeQuality;
    const size = Math.max(512, Math.min(8192, q.shadowMapSize | 0 || 2048));
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    this.shadowRange = Number.isFinite(q.shadowRange) ? q.shadowRange : 60;
    sh.radius = Number.isFinite(q.shadowRadius) ? q.shadowRadius : 2;
    const cam = sh.camera;
    const r = this._indoorShadowRange || this.shadowRange;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1;
    cam.far = 1200;
    cam.updateProjectionMatrix();
    // Normal bias has to grow with the texel footprint or acne returns on
    // the large-range presets.
    sh.normalBias = 0.02 + (2 * r / size) * 0.9;
  }

  /* ---------------------------------------------------------------------- *
   * Configuration
   * ---------------------------------------------------------------------- */

  /**
   * Switch to an open-air scene. `opts` overrides any of OUTDOOR_DEFAULTS.
   */
  setOutdoor(opts = {}) {
    this.reset();
    this.mode = 'outdoor';
    this.params = { ...OUTDOOR_DEFAULTS, ...opts };
    // Part-roofed sites (a half-collapsed factory) need the whole building in
    // the shadow map, exactly like an indoor map: pin the frustum if asked.
    this._indoorShadowRange = Number.isFinite(opts.shadowRange) ? opts.shadowRange : 0;
    this._fixedFocus = Array.isArray(opts.shadowFocus)
      ? new THREE.Vector3(opts.shadowFocus[0], opts.shadowFocus[1], opts.shadowFocus[2])
      : null;

    try {
      this.sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), createSkyMaterial());
      this.sky.name = 'atmosphere-sky';
      this.sky.scale.setScalar(9000);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -1000;
      this.group.add(this.sky);
    } catch (err) {
      console.warn('[Atmosphere] sky shader unavailable; using a flat background.', err);
      this.sky = null;
    }

    this.scene.add(this.group);
    this.sun.visible = true;
    this.sun.castShadow = true;
    this.applyQuality();
    this._setupCsm();
    this._applyOutdoor(true);
  }

  /**
   * Switch to an enclosed scene. The sun is optional (skylights, broken
   * roofs); ambient comes from `captureEnvironment` once the map is built.
   *
   * @param {object} o { sun?: {direction:[x,y,z], color, intensity}, exposure,
   *                     envIntensity, shadowRange, background }
   */
  setIndoor(o = {}) {
    this.reset();
    this.mode = 'indoor';
    this.params = { ...OUTDOOR_DEFAULTS, ...o };
    this.renderer.toneMappingExposure = Number.isFinite(o.exposure) ? o.exposure : 1.0;
    this.scene.environmentIntensity = Number.isFinite(o.envIntensity) ? o.envIntensity : 0.6;
    this._indoorShadowRange = Number.isFinite(o.shadowRange) ? o.shadowRange : 0;
    // A roofed building must be covered by the shadow map *in full*, or every
    // fragment outside the frustum reads as sunlit — the far end of a closed
    // hall would glow. Indoor maps therefore pin the frustum to the building
    // centre instead of letting it follow the drone.
    this._fixedFocus = Array.isArray(o.shadowFocus)
      ? new THREE.Vector3(o.shadowFocus[0], o.shadowFocus[1], o.shadowFocus[2])
      : null;

    this.scene.add(this.group);
    this.hemi.intensity = Number.isFinite(o.hemiIntensity) ? o.hemiIntensity : 0;
    if (o.sun) {
      const d = o.sun.direction || [0.3, 1, 0.2];
      this.sunDir.set(d[0], d[1], d[2]).normalize();
      this.sun.color.set(o.sun.color ?? 0xfff1dc);
      this.sun.intensity = Number.isFinite(o.sun.intensity) ? o.sun.intensity : 2.5;
      this.sun.visible = true;
      sunState.direction.copy(this.sunDir);
      sunState.color.copy(this.sun.color);
      this.sun.castShadow = o.sun.castShadow !== false;
    } else {
      this.sun.visible = false;
      this.sun.castShadow = false;
    }
    this.applyQuality();
  }

  /**
   * Adopt a legacy map that brought its own lights and sky: leave them alone,
   * but give its PBR materials an environment captured from the scene itself.
   */
  adoptLegacy(probePosition, { envIntensity = 0.45 } = {}) {
    if (this.mode !== 'none') return;
    this.mode = 'legacy';
    this.scene.environmentIntensity = envIntensity;
    this.captureEnvironment(probePosition);
  }

  /** Remove everything this module put into the scene. */
  reset() {
    try { this.scene.remove(this.group); } catch (_e) { /* ignore */ }
    this._disposeCsm();
    this._makeSun();
    if (this.sky) {
      try {
        this.group.remove(this.sky);
        this.sky.geometry.dispose();
        this.sky.material.dispose();
      } catch (_e) { /* ignore */ }
      this.sky = null;
    }
    this._disposeEnv();
    if (this.scene.environment) this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    if (this._ownFog && this.scene.fog === this._ownFog) this.scene.fog = null;
    this._ownFog = null;
    this._fixedFocus = null;
    this.mode = 'none';
    this._indoorShadowRange = 0;
    this.sun.visible = false;
    this.sun.castShadow = false;
    this.applyQuality();
  }

  /* ---------------------------------------------------------------------- *
   * Time of day / weather
   * ---------------------------------------------------------------------- */

  /**
   * Settings sliders: `dayOffset` 0..1 (0.5 = the map's authored sun, 0 =
   * early morning, 1 = evening) and `overcast` 0..1.
   */
  setTimeOfDay(dayOffset, overcast) {
    const d = Number.isFinite(dayOffset) ? Math.min(1, Math.max(0, dayOffset)) : 0.5;
    const o = Number.isFinite(overcast) ? Math.min(1, Math.max(0, overcast)) : 0;
    if (Math.abs(d - this._dayOffset) < 1e-4 && Math.abs(o - this._overcast) < 1e-4) return;
    this._dayOffset = d;
    this._overcast = o;
    if (this.mode === 'outdoor') this._applyOutdoor(false);
  }

  /** Effective sun elevation/azimuth after the time-of-day slider. */
  _effectiveSun() {
    const p = this.params;
    const t = (this._dayOffset - 0.5) * 2;       // -1 .. 1
    // Morning/evening swing the sun low toward east/west; noon is the map's own.
    const elev = t === 0 ? p.sunElevation
      : p.sunElevation + (Math.max(3, p.sunElevation * 0.12) - p.sunElevation) * Math.abs(t) ** 1.2;
    const az = p.sunAzimuth + t * 70;
    return { elev, az };
  }

  _applyOutdoor(immediate) {
    const p = this.params;
    const { elev, az } = this._effectiveSun();
    const phi = (90 - elev) * DEG;
    const theta = az * DEG;
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const oc = this._overcast;
    const turb = p.turbidity + oc * 6;
    const params = {
      rayleigh: p.rayleigh * (1 - oc * 0.35),
      turbidity: turb,
      mieCoefficient: p.mieCoefficient * (1 + oc * 2.5),
      mieDirectionalG: p.mieDirectionalG,
    };
    this._scatter = params;

    if (this.sky) {
      const u = this.sky.material.uniforms;
      u.sunPosition.value.copy(this.sunDir);
      u.turbidity.value = params.turbidity;
      u.rayleigh.value = params.rayleigh;
      u.mieCoefficient.value = params.mieCoefficient;
      u.mieDirectionalG.value = params.mieDirectionalG;
      u.uCloudCover.value = Math.min(0.95, p.clouds + oc * 0.7);
      u.uCloudDensity.value = Math.min(1, p.cloudDensity + oc * 0.4);
      u.uCloudScale.value = p.cloudScale;
      u.uGround.value.set(p.groundColor);
    }

    // --- sunlight: transmittance-tinted, faded out below the horizon ------
    const tr = sunTransmittance(this.sunDir, params);
    const mx = Math.max(tr[0], tr[1], tr[2], 1e-4);
    this.sun.color.setRGB(tr[0] / mx, tr[1] / mx, tr[2] / mx);
    const lum = 0.2126 * tr[0] + 0.7152 * tr[1] + 0.0722 * tr[2];
    const horizonFade = smooth(-0.02, 0.12, this.sunDir.y);
    this.sun.intensity = p.sunIntensity * Math.pow(lum, 0.5) * horizonFade * (1 - oc * 0.78);
    sunState.direction.copy(this.sunDir);
    sunState.color.copy(this.sun.color).multiplyScalar(Math.max(0.05, horizonFade * (1 - oc * 0.6)));
    this.sun.shadow.intensity = p.shadowStrength * (1 - oc * 0.6);

    // --- fog + hemisphere from the horizon/zenith sky colour --------------
    const hz = this._horizonColor(params);
    this.fogColor.setRGB(hz[0] * p.fogTint, hz[1] * p.fogTint, hz[2] * p.fogTint);
    if (!(this.scene.fog instanceof THREE.FogExp2)) {
      this.scene.fog = new THREE.FogExp2(this.fogColor.getHex(), p.fogDensity);
      this._ownFog = this.scene.fog;
    }
    this.scene.fog.color.copy(this.fogColor);
    this.scene.fog.density = p.fogDensity * (1 + oc * 1.6);

    const zen = skyRadiance({ x: 0, y: 1, z: 0 }, this.sunDir, params);
    this.hemi.color.setRGB(zen[0], zen[1], zen[2]).multiplyScalar(1 / Math.max(zen[1], 1e-3));
    this.hemi.groundColor.set(p.groundColor);
    this.hemi.intensity = p.hemiIntensity;

    this.scene.background = null;
    this.renderer.toneMappingExposure = p.exposure * (1 + (1 - horizonFade) * 0.6);
    this.scene.environmentIntensity = p.envIntensity;

    if (immediate) this._renderEnvironment();
    else { this._envDirty = true; this._envTimer = 0.12; }
  }

  /** Average sky colour a couple of degrees above the horizon, all azimuths. */
  _horizonColor(params) {
    const acc = [0, 0, 0];
    const tmp = [0, 0, 0];
    const N = 12;
    const el = 2.5 * DEG;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dir = { x: Math.cos(a) * Math.cos(el), y: Math.sin(el), z: Math.sin(a) * Math.cos(el) };
      skyRadiance(dir, this.sunDir, params, tmp);
      acc[0] += tmp[0]; acc[1] += tmp[1]; acc[2] += tmp[2];
    }
    return [acc[0] / N, acc[1] / N, acc[2] / N];
  }

  /* ---------------------------------------------------------------------- *
   * Environment maps
   * ---------------------------------------------------------------------- */

  _ensurePmrem() {
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
    return this._pmrem;
  }

  _disposeEnv() {
    try { this._envTarget?.dispose(); } catch (_e) { /* ignore */ }
    this._envTarget = null;
  }

  /** Render the sky (no sun disc) into a PMREM and use it as scene IBL. */
  _renderEnvironment() {
    if (!this.sky) return;
    try {
      const pmrem = this._ensurePmrem();
      if (!this._envScene) this._envScene = new THREE.Scene();
      const u = this.sky.material.uniforms;
      const parent = this.sky.parent;
      u.uShowSun.value = 0;
      this._envScene.add(this.sky);
      const prevTarget = this._envTarget;
      this._envTarget = pmrem.fromScene(this._envScene, 0, 0.1, 20000, {
        size: activeQuality.envMapSize || 256,
      });
      if (parent) parent.add(this.sky);
      u.uShowSun.value = 1;
      this.scene.environment = this._envTarget.texture;
      try { prevTarget?.dispose(); } catch (_e) { /* ignore */ }
      this._envDirty = false;
    } catch (err) {
      console.warn('[Atmosphere] environment map generation failed; PBR ambient disabled.', err);
      try { if (this.sky && !this.sky.parent) this.group.add(this.sky); } catch (_e) { /* ignore */ }
      if (this.sky) this.sky.material.uniforms.uShowSun.value = 1;
    }
  }

  /**
   * Re-create the environment map after a renderer rebuild (device loss):
   * the old PMREM target belonged to the lost device.
   */
  rebuildEnvironment(probe = null) {
    try { this._pmrem?.dispose(); } catch (_e) { /* ignore */ }
    this._pmrem = null;
    this._envTarget = null;
    if (this.mode === 'outdoor') this._renderEnvironment();
    else if (this.mode !== 'none') this.captureEnvironment(probe || this._lastProbe);
  }

  /**
   * Capture the built scene itself into the environment map (indoor maps).
   * Hides the given objects (the drone) while rendering.
   */
  captureEnvironment(position, hide = []) {
    this._lastProbe = position ? new THREE.Vector3(position.x, position.y, position.z) : null;
    try {
      const pmrem = this._ensurePmrem();
      const hidden = [];
      for (const o of hide) { if (o && o.visible) { o.visible = false; hidden.push(o); } }
      const prevEnv = this.scene.environment;
      this.scene.environment = null;
      const pos = position ? new THREE.Vector3(position.x, position.y, position.z) : new THREE.Vector3(0, 2, 0);
      const prevTarget = this._envTarget;
      this._envTarget = pmrem.fromScene(this.scene, 0.035, 0.05, 400, {
        size: Math.min(256, activeQuality.envMapSize || 256),
        position: pos,
      });
      this.scene.environment = this._envTarget.texture;
      try { if (prevTarget && prevTarget !== this._envTarget) prevTarget.dispose(); } catch (_e) { /* ignore */ }
      for (const o of hidden) o.visible = true;
      void prevEnv;
    } catch (err) {
      console.warn('[Atmosphere] scene capture failed; continuing without IBL.', err);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Per-frame
   * ---------------------------------------------------------------------- */

  /**
   * @param {number} dt
   * @param {THREE.Vector3} focus  where shadows must be sharpest (the drone)
   */
  update(dt, focus) {
    if (this.mode === 'none' || this.mode === 'legacy') return;
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;

    if (this.sky) this.sky.material.uniforms.uTime.value += step;

    if (this._envDirty) {
      this._envTimer -= step;
      if (this._envTimer <= 0) this._renderEnvironment();
    }

    const f = this._fixedFocus || focus;
    if (!this.sun.visible || !f || !Number.isFinite(f.x)) return;
    if (this.csm) this._aimCsm(f);
    else this._followShadow(f);
  }

  /**
   * With cascades the light only supplies a direction — each cascade fits
   * its own frustum slice. Re-split when the camera's projection changes
   * (FOV, lens mode, aspect).
   */
  _aimCsm(focus) {
    this.sunTarget.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 500);
    this.sunTarget.updateMatrixWorld();
    const cam = this._viewCamera;
    if (cam) {
      const e = cam.projectionMatrix.elements;
      const key = `${e[0].toFixed(5)}|${e[5].toFixed(5)}|${cam.near}|${cam.far}`;
      if (key !== this._csmProjKey) {
        this._csmProjKey = key;
        try { this.csm.updateFrustums(); } catch (_e) { /* ignore */ }
      }
    }
  }

  /**
   * Centre the shadow frustum on `focus`, snapped to whole texels in light
   * space. Without the snap every sub-texel move of the drone re-rasterises
   * shadow edges at a slightly different offset and they crawl visibly.
   */
  _followShadow(focus) {
    const dir = this.sunDir;
    const f = this._fwd.copy(dir).negate();
    const right = this._right.crossVectors(f, WORLD_UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = this._upv.crossVectors(right, f).normalize();

    const range = this.sun.shadow.camera.right;
    const texel = (2 * range) / this.sun.shadow.mapSize.x;
    const sr = Math.round(focus.dot(right) / texel) * texel;
    const su = Math.round(focus.dot(up) / texel) * texel;
    const sf = focus.dot(dir);

    const snapped = this._snap.set(0, 0, 0)
      .addScaledVector(right, sr)
      .addScaledVector(up, su)
      .addScaledVector(dir, sf);

    this.sunTarget.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(dir, 500);
    this.sunTarget.updateMatrixWorld();
  }

  dispose() {
    this.reset();
    try { this._pmrem?.dispose(); } catch (_e) { /* ignore */ }
    this._pmrem = null;
  }
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
