/**
 * render/FpvVideo.js
 * ---------------------------------------------------------------------------
 * The FPV video system: what the picture looks like after it has been through
 * a camera, a video transmitter and a pair of goggles. A TSL node for the post
 * pipeline (PostStack.js); it reads the lensed image through the sampler that
 * FpvLens builds, so every tap goes through the same projection.
 *
 *   'hd'      DJI O4 / Walksnail. A sharp digital picture with a mild radial
 *             chromatic aberration (0.0012·r²). As the link weakens (RSSI
 *             below 0.4) 16×16-pixel macroblocks blend in, the way an H.265
 *             stream starves; below 0.15 the frame freezes on the last good
 *             picture (PostStack holds it in a render target).
 *
 *   'analog'  A 5.8 GHz analog feed on a CRT-style goggle: everything the old
 *             CRT filter did (tearing below RSSI 0.35, colour fringing,
 *             rolling scanlines, grain, desaturation and snow as the link
 *             fades, vignette) plus chroma bleed — a 5-tap horizontal blur of
 *             the chroma only, split in YIQ, because composite video carries
 *             colour at a third of the luma bandwidth. The picture is 4:3 and
 *             is pillarboxed on wider screens.
 *
 * `vtxBreakup` off pins RSSI at 1 (clean picture); `vtxMode` decides how RSSI
 * moves (CameraRig).
 */

import {
  Fn, float, vec2, vec3, vec4, uniform,
  abs, dot, floor, fract, length, max, mix, sin, smoothstep, step,
  screenUV, screenSize,
} from 'three/tsl';

export const VIDEO_SYSTEMS = ['hd', 'analog'];

/** Default goggle latency per system (ms), written into `fpvLatency` on switch. */
export const VIDEO_LATENCY_MS = { hd: 28, analog: 12 };

/** Below this RSSI an HD link freezes its last frame. */
export const HD_FREEZE_RSSI = 0.15;

export function createVideoUniforms() {
  return {
    uTime: uniform(0),
    uRssi: uniform(1),
    uVideoOn: uniform(1),
  };
}

export function updateVideoUniforms(V, s) {
  V.uTime.value = Number.isFinite(s.time) ? s.time : 0;
  const rssi = Number.isFinite(s.rssi) ? Math.min(1, Math.max(0, s.rssi)) : 1;
  V.uRssi.value = s.breakup === false ? 1 : rssi;
  V.uVideoOn.value = s.active === false ? 0 : 1;
}

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

/**
 * Image-local centred coordinates (−0.5..0.5 across the FPV image, not the
 * pillarboxed viewport) and the viewport-uv scale that converts back.
 */
function imageCentered(L, uv) {
  const sx = L.uViewAspect.div(L.uImageAspect);
  return { centered: vec2(uv.x.sub(0.5).mul(sx), uv.y.sub(0.5)), sx };
}

/**
 * @param {string} system   'hd' | 'analog'
 * @param {object} V        video uniforms
 * @param {object} L        lens uniforms (image/viewport aspect)
 * @param {(uv) => vec4} sample  lensed-image sampler
 */
export function createVideoNode(system, V, L, sample) {
  const uv0 = screenUV;
  const clean = sample(uv0);

  if (system === 'analog') {
    const processed = Fn(() => {
      const rssi = V.uRssi.clamp(0.0, 1.0);
      const t = V.uTime;
      const res = screenSize;
      const uv = vec2(uv0).toVar();

      // VTX signal loss: a horizontal tear that grows as link quality drops.
      const tearOn = step(rssi, 0.35);
      uv.x.assign(uv.x.add(step(0.9, fract(uv.y.mul(3.0).add(t))).mul(0.02).mul(float(0.35).sub(rssi)).mul(tearOn)));

      const { centered, sx } = imageCentered(L, uv);
      const r2 = dot(centered, centered);

      // Chromatic aberration: zero at the centre, growing toward the corners.
      const ca = float(0.0022).mul(r2).mul(4.0);
      const off = vec2(centered.x.div(sx), centered.y).mul(ca);
      const cr = sample(uv.add(off)).r;
      const cg = sample(uv).g;
      const cb = sample(uv.sub(off)).b;
      const col = vec3(cr, cg, cb).toVar();

      // Chroma bleed: luma from the centre tap, chroma (I, Q) from a 5-tap
      // [1 2 3 2 1] horizontal blur at composite-video chroma bandwidth.
      const dx = float(1.0 / 640.0).div(sx);
      const toI = (c) => dot(c, vec3(0.596, -0.274, -0.322));
      const toQ = (c) => dot(c, vec3(0.211, -0.523, 0.312));
      const w = [1, 2, 3, 2, 1];
      let iSum = float(0.0);
      let qSum = float(0.0);
      for (let k = 0; k < 5; k++) {
        const c = sample(uv.add(vec2(dx.mul(k - 2), 0.0))).rgb;
        iSum = iSum.add(toI(c).mul(w[k] / 9));
        qSum = qSum.add(toQ(c).mul(w[k] / 9));
      }
      const Y = dot(col, vec3(0.299, 0.587, 0.114));
      col.assign(vec3(
        Y.add(iSum.mul(0.956)).add(qSum.mul(0.621)),
        Y.sub(iSum.mul(0.272)).sub(qSum.mul(0.647)),
        Y.sub(iSum.mul(1.106)).add(qSum.mul(1.703)),
      ));

      // Scanlines, slowly rolling so they never sit still on the panel.
      const lines = sin(uv.y.add(t.mul(0.02)).mul(res.y).mul(1.6));
      col.mulAssign(float(1.0).sub(float(0.085).mul(lines.mul(0.5).add(0.5))));

      // Signal noise, strongest where the picture is darkest.
      const n = hash(uv.mul(res).mul(0.5).add(t.mul(60.0)));
      col.addAssign(n.sub(0.5).mul(0.045).mul(float(1.2).sub(dot(col, vec3(0.333)))));

      // VTX breakup: extra luma noise and desaturation as RSSI drops.
      const bn = hash(uv.mul(res).mul(0.37).add(t.mul(91.0)));
      col.addAssign(float(1.0).sub(rssi).mul(bn.sub(0.5)).mul(0.35));
      const luma = dot(col, vec3(0.299, 0.587, 0.114));
      col.assign(mix(col, vec3(luma), float(1.0).sub(rssi).mul(0.6)));

      // Vignette (GLSL smoothstep(0.92, 0.22, r2), with ordered edges).
      col.mulAssign(float(1.0).sub(smoothstep(0.22, 0.92, r2)));

      // Pillarbox: the lens sampler already returns black in the bars; keep
      // the grain out of them too.
      const inside = float(1.0).sub(step(0.5, abs(centered.x)));
      return vec4(col.max(0.0).mul(inside), 1.0);
    })();
    return mix(clean, processed, V.uVideoOn);
  }

  // HD
  const processed = Fn(() => {
    const rssi = V.uRssi.clamp(0.0, 1.0);
    const uv = vec2(uv0);
    const { centered, sx } = imageCentered(L, uv);
    // Radial CA in lens-plane units: r = 1 at the image's horizontal edge.
    const rr = centered.x.mul(2.0);
    const r2 = rr.mul(rr).add(centered.y.mul(2.0).div(L.uImageAspect).pow(2.0));
    const dir = vec2(centered.x.div(sx), centered.y);
    const off = dir.div(max(length(dir), 1e-5)).mul(float(0.0012).mul(r2));
    const sharp = vec3(sample(uv.add(off)).r, sample(uv).g, sample(uv.sub(off)).b);

    // Macroblocking below RSSI 0.4: each 16×16 block reads its centre texel.
    const block = floor(uv.mul(screenSize).div(16.0)).add(0.5).mul(16.0).div(screenSize);
    const blocky = sample(block).rgb;
    const mb = float(1.0).sub(smoothstep(HD_FREEZE_RSSI, 0.4, rssi));
    return vec4(mix(sharp, blocky, mb), 1.0);
  })();
  return mix(clean, processed, V.uVideoOn);
}
