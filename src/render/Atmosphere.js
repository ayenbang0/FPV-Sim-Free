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

import * as THREE from 'three';
import { activeQuality } from './Quality.js';

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
 * Sky shader
 * ========================================================================== */

/**
 * Preetham sky, adapted from three's Sky.SkyShader with three changes:
 *   - the lower hemisphere fades into a ground colour instead of repeating the
 *     horizon, so the environment map has a believable bounce term;
 *   - clouds are lit relative to the sky's own brightness (computed once in
 *     the vertex stage), which keeps them white at noon and pink at dusk;
 *   - clouds self-shadow with a second sample offset toward the sun.
 */
const SKY_SHADER = {
  uniforms: {
    turbidity: { value: 3 },
    rayleigh: { value: 1.2 },
    mieCoefficient: { value: 0.005 },
    mieDirectionalG: { value: 0.8 },
    sunPosition: { value: new THREE.Vector3(0, 1, 0) },
    up: { value: new THREE.Vector3(0, 1, 0) },
    uGround: { value: new THREE.Color(0x2c3322) },
    uCloudCover: { value: 0.3 },
    uCloudDensity: { value: 0.6 },
    uCloudScale: { value: 1.0 },
    uTime: { value: 0 },
    uShowSun: { value: 1 },
  },
  vertexShader: /* glsl */`
    uniform vec3 sunPosition;
    uniform float rayleigh;
    uniform float turbidity;
    uniform float mieCoefficient;
    uniform float mieDirectionalG;
    uniform vec3 up;

    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;
    varying vec3 vSkyRef;
    varying vec3 vSunTint;

    const float e = 2.718281828459045;
    const float pi = 3.141592653589793;
    const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
    const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
    const float cutoffAngle = 1.6110731556870734;
    const float steepness = 1.5;
    const float EE = 1000.0;

    float sunIntensity(float zenithAngleCos) {
      zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
      return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
    }
    vec3 totalMie(float T) {
      float c = (0.2 * T) * 10E-18;
      return 0.434 * c * MieConst;
    }
    float rayleighPhaseV(float cosTheta) { return 0.05968310365946075 * (1.0 + cosTheta * cosTheta); }
    float hgPhaseV(float cosTheta, float g) {
      float g2 = g * g;
      return 0.07957747154594767 * ((1.0 - g2) / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5));
    }
    vec3 skyAt(vec3 direction) {
      float zenithAngle = acos(max(0.0, dot(up, direction)));
      float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
      vec3 Fex = exp(-(vBetaR * 8.4E3 * inverse + vBetaM * 1.25E3 * inverse));
      float cosTheta = dot(direction, vSunDirection);
      vec3 bR = vBetaR * rayleighPhaseV(cosTheta * 0.5 + 0.5);
      vec3 bM = vBetaM * hgPhaseV(cosTheta, mieDirectionalG);
      vec3 ratio = (bR + bM) / (vBetaR + vBetaM);
      vec3 Lin = pow(vSunE * ratio * (1.0 - Fex), vec3(1.5));
      Lin *= mix(vec3(1.0), pow(vSunE * ratio * Fex, vec3(0.5)), clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));
      return (Lin + vec3(0.1) * Fex) * 0.04;
    }

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w;

      vSunDirection = normalize(sunPosition);
      vSunE = sunIntensity(dot(vSunDirection, up));
      vBetaR = totalRayleigh * rayleigh;
      vBetaM = totalMie(turbidity) * mieCoefficient;

      // Reference brightness for cloud lighting: the sky 30 degrees up, facing
      // away from the sun. Same for every vertex; costs nothing.
      vec3 away = normalize(vec3(-vSunDirection.x, 0.0, -vSunDirection.z) + vec3(0.0, 0.58, 0.0));
      vSkyRef = skyAt(away);
      // Sun transmittance tint for cloud tops.
      float za = acos(max(0.0, dot(up, vSunDirection)));
      float inv = 1.0 / (cos(za) + 0.15 * pow(93.885 - ((za * 180.0) / pi), -1.253));
      vSunTint = exp(-(vBetaR * 8.4E3 * inv + vBetaM * 1.25E3 * inv));
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;
    varying vec3 vSkyRef;
    varying vec3 vSunTint;

    uniform float mieDirectionalG;
    uniform vec3 up;
    uniform vec3 uGround;
    uniform float uCloudCover;
    uniform float uCloudDensity;
    uniform float uCloudScale;
    uniform float uTime;
    uniform float uShowSun;

    const float pi = 3.141592653589793;
    const float sunAngularDiameterCos = 0.99995;

    float rayleighPhase(float cosTheta) { return 0.05968310365946075 * (1.0 + cosTheta * cosTheta); }
    float hgPhase(float cosTheta, float g) {
      float g2 = g * g;
      return 0.07957747154594767 * ((1.0 - g2) / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5));
    }

    float h12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(h12(i), h12(i + vec2(1, 0)), u.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), u.x), u.y);
    }
    float cfbm(vec2 p) {
      float v = 0.0; float a = 0.5;
      mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
      for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = r * p * 2.02; a *= 0.5; }
      return v;
    }

    void main() {
      vec3 direction = normalize(vWorldPosition - cameraPosition);

      float zenithAngle = acos(max(0.0, dot(up, direction)));
      float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
      vec3 Fex = exp(-(vBetaR * 8.4E3 * inverse + vBetaM * 1.25E3 * inverse));

      float cosTheta = dot(direction, vSunDirection);
      vec3 betaRTheta = vBetaR * rayleighPhase(cosTheta * 0.5 + 0.5);
      vec3 betaMTheta = vBetaM * hgPhase(cosTheta, mieDirectionalG);
      vec3 ratio = (betaRTheta + betaMTheta) / (vBetaR + vBetaM);

      vec3 Lin = pow(vSunE * ratio * (1.0 - Fex), vec3(1.5));
      Lin *= mix(vec3(1.0), pow(vSunE * ratio * Fex, vec3(0.5)), clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));

      vec3 L0 = vec3(0.1) * Fex;
      float sundisc = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta) * uShowSun;
      L0 += (vSunE * 19000.0 * Fex) * sundisc;

      vec3 col = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);

      // Clouds: one layer projected onto a plane, horizon-compressed.
      if (direction.y > 0.0 && uCloudCover > 0.001) {
        vec2 uv = direction.xz / (direction.y + 0.14) * 1.6 * uCloudScale;
        uv += vec2(uTime * 0.0045, uTime * 0.0016);
        vec2 warp = vec2(cfbm(uv * 0.7 + 3.1), cfbm(uv * 0.7 - 1.7));
        float n = cfbm(uv + warp * 0.6);
        float cover = smoothstep(1.0 - uCloudCover - 0.02, 1.0 - uCloudCover + 0.32, n);
        // Self-shadowing: denser cloud between this point and the sun darkens it.
        float nSun = cfbm(uv + warp * 0.6 + normalize(vSunDirection.xz + 1e-4) * 0.09);
        float shade = clamp(0.62 + (n - nSun) * 4.0, 0.25, 1.15);
        float lum = dot(vSkyRef, vec3(0.2126, 0.7152, 0.0722));
        vec3 sunLit = vSunTint / max(max(vSunTint.r, max(vSunTint.g, vSunTint.b)), 1e-4);
        vec3 cloudCol = lum * 2.6 * mix(vec3(0.62, 0.66, 0.74), sunLit * 1.12, shade);
        // Forward-scatter glow around the sun.
        cloudCol += lum * 1.4 * sunLit * pow(max(cosTheta, 0.0), 12.0) * (1.0 - cover * 0.5);
        float fade = smoothstep(0.0, 0.16, direction.y);
        col = mix(col, cloudCol, cover * uCloudDensity * fade);
      }

      // Below the horizon: fade to a lit ground colour (bounce light for IBL).
      float below = smoothstep(0.0, -0.06, direction.y);
      float groundLight = dot(vSkyRef, vec3(0.2126, 0.7152, 0.0722)) * 1.6 * (0.35 + 0.65 * clamp(vSunDirection.y * 2.0, 0.0, 1.0));
      col = mix(col, uGround * groundLight, below);

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

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
   * @param {THREE.WebGLRenderer} renderer
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
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.name = 'atmosphere-sun';
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    this.sunTarget = new THREE.Object3D();
    this.sun.target = this.sunTarget;
    this.group.add(this.sun, this.sunTarget);

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
      this.sky = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.ShaderMaterial({
          name: 'FpvSky',
          uniforms: THREE.UniformsUtils.clone(SKY_SHADER.uniforms),
          vertexShader: SKY_SHADER.vertexShader,
          fragmentShader: SKY_SHADER.fragmentShader,
          side: THREE.BackSide,
          depthWrite: false,
          fog: false,
        }),
      );
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
    if (!this._pmrem) {
      this._pmrem = new THREE.PMREMGenerator(this.renderer);
      try { this._pmrem.compileCubemapShader(); } catch (_e) { /* optional */ }
    }
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
   * Capture the built scene itself into the environment map (indoor maps).
   * Hides the given objects (the drone) while rendering.
   */
  captureEnvironment(position, hide = []) {
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
    if (this.sun.visible && f && Number.isFinite(f.x)) this._followShadow(f);
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
