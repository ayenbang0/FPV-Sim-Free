/**
 * world/Noise.js
 * ---------------------------------------------------------------------------
 * Seeded coherent noise for terrain, scatter and texture generation, plus the
 * matching TSL noise functions the ground/grass node materials use.
 *
 * Everything here is deterministic from a seed: a map must look identical on
 * every load, or learning a line through a forest is impossible. The CPU side
 * is classic 2-D simplex (Gustavson), which is cheap enough to evaluate a few
 * million times while a big map builds, and isotropic enough that ridged and
 * warped variants do not show the axis-aligned streaks value noise does.
 */

import { Fn, float, vec2, vec3, dot, floor, fract, mix } from 'three/tsl';
import { makeRng } from '../assets/procedural.js';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 12 gradient directions, the usual simplex set projected to 2-D. */
const GRAD = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
  1, 1, -1, 1, 1, -1, -1, -1,
]);

/**
 * A seeded 2-D simplex noise source.
 *
 *   const n = new Simplex(42);
 *   n.noise(x, y)          // [-1, 1]
 *   n.fbm(x, y, 5)         // fractal sum, roughly [-1, 1]
 *   n.ridged(x, y, 5)      // [0, 1], sharp crests — mountain ridges
 */
export class Simplex {
  constructor(seed = 1) {
    const rng = makeRng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise(xin, yin) {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    // Scaled so the output spans very nearly [-1, 1].
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion: octaves of noise at doubling frequency. */
  fbm(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal: `1 - |noise|` folded and squared so zero crossings
   * become sharp crests, with each octave weighted by the one before it so
   * detail concentrates on the ridges — which is what real erosion produces.
   */
  ridged(x, y, octaves = 5, lacunarity = 2.05, gain = 0.5) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let weight = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x * freq, y * freq));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** fbm evaluated through a warped domain — breaks up the "noise look". */
  warped(x, y, octaves = 5, warp = 0.35) {
    const qx = this.fbm(x + 5.2, y + 1.3, 3);
    const qy = this.fbm(x - 3.7, y + 8.1, 3);
    return this.fbm(x + warp * qx, y + warp * qy, octaves);
  }
}

/* ========================================================================== *
 * Small math helpers shared by the world generators
 * ========================================================================== */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Distance from point p to segment ab, all in the XZ plane. Returns {d, t}. */
export function segmentDistance(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return { d: Math.sqrt(dx * dx + dz * dz), t };
}

/**
 * Distance from a point to a polyline (array of {x, z}), plus the arc-length
 * parameter of the closest point — used to carve rivers and roads.
 */
export function polylineDistance(px, pz, pts) {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const { d, t } = segmentDistance(px, pz, a.x, a.z, b.x, b.z);
    if (d < best) {
      best = d;
      bestS = acc + t * segLen;
    }
    acc += segLen;
  }
  return { d: best, s: bestS };
}

/** Catmull-Rom resample of a control polyline into evenly spaced points. */
export function smoothPath(ctrl, spacing = 4) {
  if (ctrl.length < 2) return ctrl.slice();
  const out = [];
  const P = (i) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(2, Math.ceil(segLen / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t, t3 = t2 * t;
      const cr = (a, b, c, d) =>
        0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const pt = { x: cr(p0.x, p1.x, p2.x, p3.x), z: cr(p0.z, p1.z, p2.z, p3.z) };
      if (p1.y !== undefined) pt.y = cr(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0);
      out.push(pt);
    }
  }
  out.push({ ...ctrl[ctrl.length - 1] });
  return out;
}

/* ========================================================================== *
 * TSL (GPU) noise
 * ========================================================================== */

/**
 * Hash + value noise + fbm as TSL functions, for the ground and grass node
 * materials. Value noise is enough on the GPU: it only breaks up tiling and
 * adds micro-variation, and it is several times cheaper than simplex per
 * fragment on integrated graphics. Same constants as the former GLSL
 * snippets, so the look is unchanged.
 */
export const fpvHash12 = /*@__PURE__*/ Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
}).setLayout({ name: 'fpvHash12', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

export const fpvNoise = /*@__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = fpvHash12(i);
  const b = fpvHash12(i.add(vec2(1.0, 0.0)));
  const c = fpvHash12(i.add(vec2(0.0, 1.0)));
  const d = fpvHash12(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}).setLayout({ name: 'fpvNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

export const fpvFbm = /*@__PURE__*/ Fn(([pIn]) => {
  const p = vec2(pIn).toVar();
  const v = float(0.0).toVar();
  let a = 0.5;
  for (let i = 0; i < 4; i++) {
    v.addAssign(fpvNoise(p).mul(a));
    // mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03 (GLSL matrices are column-major).
    p.assign(vec2(p.x.mul(0.8).add(p.y.mul(0.6)), p.x.mul(-0.6).add(p.y.mul(0.8))).mul(2.03));
    a *= 0.5;
  }
  return v;
}).setLayout({ name: 'fpvFbm', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/**
 * Distance-to-polylines on a regular grid, filled once and then sampled
 * bilinearly. Measuring every splat texel and every scatter candidate against
 * every road segment directly costs tens of millions of segment tests on a
 * kilometre map; this costs one pass over the cells near each segment.
 * Cells further than `maxDist` from any line read as `maxDist`.
 */
export class DistanceField {
  constructor(half, cell = 2, maxDist = 40) {
    this.half = half;
    this.cell = cell;
    this.n = Math.ceil((half * 2) / cell) + 1;
    this.maxDist = maxDist;
    this.d = new Float32Array(this.n * this.n).fill(maxDist);
  }

  addPolyline(pts) {
    const { half, cell, n, maxDist, d } = this;
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s];
      const b = pts[s + 1];
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - maxDist + half) / cell));
      const i1 = Math.min(n - 1, Math.ceil((Math.max(a.x, b.x) + maxDist + half) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - maxDist + half) / cell));
      const j1 = Math.min(n - 1, Math.ceil((Math.max(a.z, b.z) + maxDist + half) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = -half + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = -half + i * cell;
          const dist = segmentDistance(x, z, a.x, a.z, b.x, b.z).d;
          const k = j * n + i;
          if (dist < d[k]) d[k] = dist;
        }
      }
    }
    return this;
  }

  at(x, z) {
    const { half, cell, n, d, maxDist } = this;
    const fx = (x + half) / cell;
    const fz = (z + half) / cell;
    if (!(fx >= 0 && fz >= 0 && fx < n - 1 && fz < n - 1)) return maxDist;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * n + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + n] * (1 - u) + d[k + n + 1] * u) * v;
  }
}
