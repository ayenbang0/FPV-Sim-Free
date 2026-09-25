/**
 * render/FpvLens.js
 * ---------------------------------------------------------------------------
 * The FPV camera lens: a true fisheye projection (the GodotDrone approach),
 * plus the rolling-shutter "jello" of a CMOS sensor, as TSL nodes for the
 * post pipeline (see PostStack.js).
 *
 * PROJECTION MODEL (shared by every mode)
 *
 * Work in output coordinates normalised to the *horizontal* half-width of the
 * FPV image: r = 0 at the centre, r = 1 at the left/right edge. With
 * θmax = fov/2 and k = lensFisheye, the view angle θ of an output pixel solves
 *
 *     r·F = (1−k)·tan θ + k·θ,        F = (1−k)·tan θmax + k·θmax
 *
 * k = 0 is a pinhole (rectilinear) lens, k = 1 is equidistant (θ ∝ r), and
 * real FPV micro-lenses sit around 0.7–0.9. The shader solves it with eight
 * Newton iterations starting from θ = r·θmax; the start (and every iterate) is
 * clamped to the bracket [atan(rF), rF], which always contains the root
 * (tan θ ≥ θ), so the solve is exact to ~1e-6 degrees over the whole 70–170°
 * range instead of stalling near tan's asymptote at wide FOVs.
 *
 * MODES
 *   rectilinear   plain perspective camera, horizontal FOV clamped to 150°.
 *   fisheye       the scene renders rectilinear at min(fov, 150°) and 1.25x
 *                 resolution (main.js scales the renderer's pixel ratio, so
 *                 every buffer in the chain stays the same size — TRAA's depth
 *                 history needs that); each output pixel is remapped through θ to the
 *                 rectilinear image (tan θ / tan θrender). Pixels whose θ lies
 *                 beyond θrender are vignette-black, as on a real lens. Cheap,
 *                 and keeps GTAO, TRAA and motion blur.
 *   fisheye-cube  a CubeCamera at the FPV pose renders five faces (the back
 *                 face is skipped) and the lens samples the cube along the
 *                 view direction for (θ, φ): true 170°+ with straight-line
 *                 bending that no single perspective render can produce.
 *
 * ROLLING SHUTTER
 *   A CMOS sensor reads rows top to bottom over `readout` seconds (8 ms on an
 *   HD camera, 0 for an analog CCD-style feed). A row read at time
 *   tRow = (v − ½)·readout sees the camera rotated by ω·tRow, so its pixels
 *   are sampled from the mid-frame image shifted by that angle. Yaw rate
 *   shears verticals, pitch rate stretches/squashes — the classic jello.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, cubeTexture,
  abs, atan, clamp, cos, length, max, min, select, sin, smoothstep, tan,
  screenUV,
} from 'three/tsl';

export const LENS_MODES = ['rectilinear', 'fisheye', 'fisheye-cube'];

/** Widest horizontal FOV a single perspective render is allowed. */
export const RECTILINEAR_MAX_HFOV = 150;

/** Scene-pass resolution multiplier in 'fisheye' mode (the centre is magnified). */
export const FISHEYE_RESOLUTION_SCALE = 1.25;

/** Rolling-shutter readout per video system, seconds. */
export const READOUT_SECONDS = { hd: 0.008, analog: 0 };

const DEG = Math.PI / 180;
const NEWTON_ITERATIONS = 8;
const THETA_CLAMP = 1.55;       // just short of π/2, where tan θ diverges

/* ========================================================================== *
 * CPU side (camera setup, tests)
 * ========================================================================== */

/** F in r·F = (1−k)·tan θ + k·θ. */
export function lensF(thetaMax, k) {
  return (1 - k) * Math.tan(thetaMax) + k * thetaMax;
}

/**
 * View angle θ (radians) for output radius r — the same bracketed Newton solve
 * the shader runs, for tests and CPU-side consumers.
 */
export function solveLensTheta(r, thetaMax, k) {
  const F = lensF(thetaMax, k);
  const rF = r * F;
  const lo = Math.atan(rF);
  const hi = Math.min(rF, THETA_CLAMP);
  let th = Math.min(Math.max(r * thetaMax, lo), hi);
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const t = Math.tan(th);
    const g = (1 - k) * t + k * th - rF;
    const gp = (1 - k) * (1 + t * t) + k;
    th = Math.min(Math.max(th - g / gp, lo), hi);
  }
  return th;
}

/**
 * Camera and render parameters for a lens state.
 *
 * @param {object} o
 * @param {string} o.mode         'rectilinear' | 'fisheye' | 'fisheye-cube'
 * @param {number} o.hfovDeg      horizontal FOV of the output image, degrees
 * @param {number} o.imageAspect  width/height of the FPV image (4:3 when pillarboxed)
 * @returns {{ renderHfovDeg:number, vfovDeg:number, tanHalfV:number, thetaMax:number,
 *             thetaRender:number, resolutionScale:number }}
 */
export function lensSetup({ mode, hfovDeg, imageAspect }) {
  const aspect = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 16 / 9;
  let hfov = Number.isFinite(hfovDeg) ? hfovDeg : 145;
  if (mode === 'rectilinear') hfov = Math.min(hfov, RECTILINEAR_MAX_HFOV);
  const thetaMax = (hfov / 2) * DEG;
  const renderHfovDeg = Math.min(hfov, RECTILINEAR_MAX_HFOV);
  const thetaRender = (renderHfovDeg / 2) * DEG;
  // The perspective render spans `renderHfov` across the *image* width, so
  // its vertical half-angle follows from the image aspect.
  const tanHalfV = Math.tan(thetaRender) / aspect;
  const vfovDeg = 2 * Math.atan(tanHalfV) / DEG;
  return {
    renderHfovDeg,
    vfovDeg,
    tanHalfV,
    thetaMax,
    thetaRender,
    resolutionScale: mode === 'fisheye' ? FISHEYE_RESOLUTION_SCALE : 1,
  };
}

/* ========================================================================== *
 * GPU side
 * ========================================================================== */

/** Uniform set shared by the lens node and the video node. */
export function createLensUniforms() {
  return {
    uThetaMax: uniform(72.5 * DEG),
    uThetaRender: uniform(72.5 * DEG),
    uF: uniform(lensF(72.5 * DEG, 0.8)),
    uK: uniform(0.8),
    uTanThetaMax: uniform(Math.tan(72.5 * DEG)),
    uTanHalfV: uniform(1),         // source camera tan(vfov/2)
    uViewAspect: uniform(16 / 9),
    uImageAspect: uniform(16 / 9),
    uRates: uniform(new THREE.Vector2()),   // (yaw, pitch) rad/s in the camera frame
    uReadout: uniform(0.008),
    uLensOn: uniform(1),           // 0 = identity (chase cameras)
  };
}

/** Push a lens state (see CameraRig) into the uniforms. */
export function updateLensUniforms(U, s) {
  const setup = lensSetup(s);
  const k = Number.isFinite(s.k) ? Math.min(1, Math.max(0, s.k)) : 0.8;
  U.uThetaMax.value = setup.thetaMax;
  U.uThetaRender.value = setup.thetaRender;
  U.uK.value = k;
  U.uF.value = lensF(setup.thetaMax, s.mode === 'rectilinear' ? 0 : k);
  U.uTanThetaMax.value = Math.tan(setup.thetaMax);
  U.uTanHalfV.value = setup.tanHalfV;
  U.uViewAspect.value = s.viewAspect > 0 ? s.viewAspect : 16 / 9;
  U.uImageAspect.value = s.imageAspect > 0 ? s.imageAspect : U.uViewAspect.value;
  const rates = s.rates || { yaw: 0, pitch: 0 };
  U.uRates.value.set(Number.isFinite(rates.yaw) ? rates.yaw : 0, Number.isFinite(rates.pitch) ? rates.pitch : 0);
  U.uReadout.value = Number.isFinite(s.readout) ? Math.max(0, s.readout) : 0;
  U.uLensOn.value = s.fpv === false ? 0 : 1;
  return setup;
}

/**
 * Output pixel (screen uv) → lens-plane point p, in units of the image's
 * horizontal half-width, y up. Returns { p, inside } where `inside` is 0 in
 * the pillarbox bars.
 */
export function lensPlanePoint(U, uvNode = screenUV) {
  const xImg = uvNode.x.sub(0.5).mul(U.uViewAspect.div(U.uImageAspect));
  const inside = float(1.0).sub(smoothstep(0.4995, 0.5005, abs(xImg)));
  const p = vec2(xImg.mul(2.0), float(0.5).sub(uvNode.y).mul(2.0).div(U.uImageAspect));
  // Rolling shutter: rows further down were read later.
  const tRow = uvNode.y.sub(0.5).mul(U.uReadout).mul(U.uLensOn);
  const shift = vec2(U.uRates.x.negate(), U.uRates.y).mul(tRow).div(U.uF);
  return { p: p.add(shift), inside };
}

/** θ for lens radius r: eight bracketed Newton steps (see header). */
export function lensTheta(U, r) {
  return Fn(() => {
    const rF = r.mul(U.uF).toVar();
    const lo = atan(rF).toVar();
    const hi = min(rF, THETA_CLAMP).toVar();
    const k = U.uK;
    const th = clamp(r.mul(U.uThetaMax), lo, hi).toVar();
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const t = tan(th);
      const g = float(1.0).sub(k).mul(t).add(k.mul(th)).sub(rF);
      const gp = float(1.0).sub(k).mul(t.mul(t).add(1.0)).add(k);
      th.assign(clamp(th.sub(g.div(gp)), lo, hi));
    }
    return th;
  })();
}

/** Tan-plane point → uv in a perspective source render (y down, like screenUV). */
function perspectiveUV(U, tx, ty) {
  return vec2(
    float(0.5).add(tx.div(U.uTanHalfV.mul(U.uViewAspect).mul(2.0))),
    float(0.5).sub(ty.div(U.uTanHalfV.mul(2.0))),
  );
}

/** 1 inside [0,1]² with a one-texel soft edge, else 0. */
function uvInside(uv) {
  const e = 0.0015;
  return smoothstep(0.0, e, uv.x).mul(smoothstep(0.0, e, uv.y))
    .mul(smoothstep(0.0, e, float(1.0).sub(uv.x))).mul(smoothstep(0.0, e, float(1.0).sub(uv.y)));
}

/**
 * Build a sampler `(uvNode) => vec4` that reads the lensed FPV image at an
 * output uv. Video effects call it once per tap (chromatic aberration, chroma
 * bleed), so the lens and the video system share one full-screen pass.
 *
 * @param {object} U       lens uniforms
 * @param {string} mode    'rectilinear' | 'fisheye' | 'fisheye-cube'
 * @param {object} source  texture node (perspective modes) or cube texture (cube mode)
 */
export function createLensSampler(U, mode, source) {
  if (mode === 'fisheye-cube') {
    return (uvNode) => {
      const { p, inside } = lensPlanePoint(U, uvNode);
      const r = max(length(p), 1e-6);
      const theta = lensTheta(U, r);
      const d2 = p.div(r);
      // Camera-local direction (the cube camera rides the FPV camera, so its
      // faces are already rotated by the camera quaternion): -Z is forward.
      const dir = vec3(sin(theta).mul(d2.x), sin(theta).mul(d2.y), cos(theta).negate());
      const c = cubeTexture(source, dir);
      // The back face is never rendered: its nearest corner sits ~125° off
      // the view axis, so fade out before it (θ is clamped below 90° anyway
      // for the 70–170° FOV range).
      const keep = inside.mul(float(1.0).sub(smoothstep(2.12, 2.16, theta)));
      return vec4(c.rgb.mul(keep), 1.0);
    };
  }

  if (mode === 'fisheye') {
    return (uvNode) => {
      const { p, inside } = lensPlanePoint(U, uvNode);
      const r = max(length(p), 1e-6);
      const theta = lensTheta(U, r);
      const t = tan(min(theta, THETA_CLAMP));
      const d2 = p.div(r);
      const fishUV = perspectiveUV(U, t.mul(d2.x), t.mul(d2.y));
      // Chase cameras (uLensOn = 0) read the render straight through.
      const uv = select(U.uLensOn.greaterThan(0.5), fishUV, uvNode);
      const c = source.sample(uv);
      // Beyond the rendered cone: vignette black, with a soft 2° shoulder.
      const cone = float(1.0).sub(smoothstep(U.uThetaRender.sub(2 * DEG), U.uThetaRender, theta));
      const keep = select(U.uLensOn.greaterThan(0.5), cone.mul(inside).mul(uvInside(uv)), float(1.0));
      return vec4(c.rgb.mul(keep), 1.0);
    };
  }

  // Rectilinear: a straight remap (identity unless pillarboxed or jellied).
  return (uvNode) => {
    const { p, inside } = lensPlanePoint(U, uvNode);
    const rectUV = perspectiveUV(U, p.x.mul(U.uTanThetaMax), p.y.mul(U.uTanThetaMax));
    const uv = select(U.uLensOn.greaterThan(0.5), rectUV, uvNode);
    const c = source.sample(uv);
    const keep = select(U.uLensOn.greaterThan(0.5), inside.mul(uvInside(uv)), float(1.0));
    return vec4(c.rgb.mul(keep), 1.0);
  };
}
