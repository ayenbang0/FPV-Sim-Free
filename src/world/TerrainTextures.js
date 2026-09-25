/**
 * world/TerrainTextures.js
 * ---------------------------------------------------------------------------
 * Photographic-looking ground textures, drawn at load time.
 *
 * Real ground is not "noise tinted green". Grass is thousands of individual
 * blades with dark gaps of soil between them; a dirt track is compacted earth
 * with embedded pebbles; rock has strata and lichen. Each generator below
 * builds that structure explicitly — a noise base for the large tonal
 * variation, then thousands of wrapped strokes/ellipses for the small-scale
 * detail the eye actually reads as "real" — and every one tiles seamlessly,
 * because the terrain shader samples them at two scales and rotations to hide
 * repetition over kilometres.
 *
 * Contract shared with assets/procedural.js: a generator never throws. Without
 * a DOM (headless tests) or with a refused canvas, it returns null and the
 * terrain shader falls back to flat colours.
 */

import * as THREE from 'three/webgpu';
import { makeRng } from '../assets/procedural.js';

/* ========================================================================== *
 * Plumbing
 * ========================================================================== */

function canvas(size) {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return ctx ? { c, ctx } : null;
  } catch (_e) {
    return null;
  }
}

function toTexture(c, { srgb = true, anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[TerrainTextures] generation failed; using flat ground colours.', err);
    return null;
  }
}

/** Periodic value noise on an integer lattice — tiles over `period` cells. */
function periodicNoise(rng, period) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0], b = g[y0 * period + x1];
    const c = g[y1 * period + x0], d = g[y1 * period + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

/** Tileable fbm over the unit square: u,v in [0,1). */
function tileFbm(rng, baseCells, octaves) {
  const layers = [];
  let cells = baseCells;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: periodicNoise(rng, cells), cells, amp });
    norm += amp;
    cells *= 2;
    amp *= 0.5;
  }
  return (u, v) => {
    let s = 0;
    for (const l of layers) s += l.n(u * l.cells, v * l.cells) * l.amp;
    return s / norm;
  };
}

/** Fill the canvas from a per-pixel colour function (u,v) -> [r,g,b] 0..255. */
function fillPixels(ctx, size, fn) {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const out = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x / size, y / size, out);
      const i = (y * size + x) * 4;
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Draw a shape at (x, y) and at every wrapped copy that could cross an edge. */
function wrapped(size, x, y, reach, draw) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const px = x + ox * size;
      const py = y + oy * size;
      if (px < -reach || px > size + reach || py < -reach || py > size + reach) continue;
      draw(px, py);
    }
  }
}

const rgb = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

/* ========================================================================== *
 * Grass
 * ========================================================================== */

/**
 * Meadow grass seen from above: dark soil base, then layered blade strokes
 * from dark/long underneath to bright/short on top, with clumping so it does
 * not read as uniform static.
 */
export function grassGroundTexture(seed = 11, size = 1024) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const base = tileFbm(rng, 4, 5);
    const clump = tileFbm(rng, 8, 3);

    fillPixels(ctx, size, (u, v, o) => {
      const n = base(u, v);
      const k = clump(u, v);
      o[0] = 38 + n * 22 + k * 8;
      o[1] = 52 + n * 26 + k * 10;
      o[2] = 22 + n * 10;
    });

    const scale = size / 1024;
    const layers = [
      { count: 26000, len: [10, 24], w: [1.6, 2.6], col: () => [44 + rng() * 22, 70 + rng() * 26, 24 + rng() * 12], a: 0.85 },
      { count: 30000, len: [8, 18], w: [1.2, 2.0], col: () => [62 + rng() * 30, 98 + rng() * 34, 32 + rng() * 16], a: 0.9 },
      { count: 22000, len: [6, 14], w: [1.0, 1.6], col: () => [90 + rng() * 40, 126 + rng() * 34, 44 + rng() * 20], a: 0.9 },
      { count: 5000, len: [5, 11], w: [0.9, 1.3], col: () => [150 + rng() * 40, 150 + rng() * 30, 70 + rng() * 25], a: 0.7 },
    ];
    ctx.lineCap = 'round';
    for (const L of layers) {
      for (let i = 0; i < L.count * scale * scale; i++) {
        const x = rng() * size;
        const y = rng() * size;
        const k = clump(x / size, y / size);
        if (rng() > 0.35 + k * 0.9) continue;
        const len = (L.len[0] + rng() * (L.len[1] - L.len[0])) * scale;
        const ang = rng() * Math.PI * 2;
        const bend = (rng() - 0.5) * 0.9;
        const [r, g, b] = L.col();
        ctx.strokeStyle = rgb(r, g, b, L.a);
        ctx.lineWidth = (L.w[0] + rng() * (L.w[1] - L.w[0])) * scale;
        wrapped(size, x, y, len, (px, py) => {
          ctx.beginPath();
          ctx.moveTo(px, py);
          const mx = px + Math.cos(ang + bend) * len * 0.5;
          const my = py + Math.sin(ang + bend) * len * 0.5;
          ctx.quadraticCurveTo(mx, my, px + Math.cos(ang) * len, py + Math.sin(ang) * len);
          ctx.stroke();
        });
      }
    }
    return toTexture(c);
  });
}

/* ========================================================================== *
 * Dirt / compacted earth track
 * ========================================================================== */

export function dirtGroundTexture(seed = 21, size = 1024) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const n1 = tileFbm(rng, 4, 6);
    const n2 = tileFbm(rng, 16, 3);
    fillPixels(ctx, size, (u, v, o) => {
      const a = n1(u, v);
      const b = n2(u, v);
      const t = a * 0.75 + b * 0.25;
      o[0] = 92 + t * 60;
      o[1] = 72 + t * 46;
      o[2] = 52 + t * 30;
    });
    const scale = size / 1024;
    // Embedded pebbles: a lit top, a shadowed lower edge.
    for (let i = 0; i < 5200 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const r = (1.2 + rng() * rng() * 7) * scale;
      const tone = 90 + rng() * 90;
      const rot = rng() * Math.PI;
      wrapped(size, x, y, r * 2, (px, py) => {
        ctx.fillStyle = rgb(30, 24, 18, 0.45);
        ctx.beginPath(); ctx.ellipse(px + r * 0.25, py + r * 0.35, r, r * 0.72, rot, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgb(tone, tone * 0.9, tone * 0.78, 1);
        ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.72, rot, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgb(tone + 40, tone * 0.9 + 36, tone * 0.78 + 30, 0.5);
        ctx.beginPath(); ctx.ellipse(px - r * 0.2, py - r * 0.25, r * 0.45, r * 0.3, rot, 0, Math.PI * 2); ctx.fill();
      });
    }
    // Hairline cracks.
    ctx.lineWidth = 1.1 * scale;
    for (let i = 0; i < 160 * scale; i++) {
      let x = rng() * size, y = rng() * size;
      let ang = rng() * Math.PI * 2;
      ctx.strokeStyle = rgb(40, 30, 22, 0.35);
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 8; s++) {
        ang += (rng() - 0.5) * 1.2;
        x += Math.cos(ang) * 9 * scale; y += Math.sin(ang) * 9 * scale;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Tyre-flattened grit sparkle.
    for (let i = 0; i < 9000 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const t = 150 + rng() * 80;
      ctx.fillStyle = rgb(t, t * 0.92, t * 0.82, 0.55);
      ctx.fillRect(x, y, 1.2 * scale, 1.2 * scale);
    }
    return toTexture(c);
  });
}

/* ========================================================================== *
 * Rock
 * ========================================================================== */

export function rockGroundTexture(seed = 31, size = 1024) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const n1 = tileFbm(rng, 3, 6);
    const n2 = tileFbm(rng, 6, 5);
    const n3 = tileFbm(rng, 24, 2);
    fillPixels(ctx, size, (u, v, o) => {
      const a = n1(u, v);
      // Strata: bands warped by a second field, sharpened into ledges.
      const band = 0.5 + 0.5 * Math.sin((v * 7 + n2(u, v) * 2.2) * Math.PI * 2);
      const ridge = Math.pow(1 - Math.abs(n2(u, v) * 2 - 1), 3);
      const g = n3(u, v);
      const t = a * 0.55 + band * 0.18 + g * 0.15 - ridge * 0.22;
      o[0] = 88 + t * 88;
      o[1] = 86 + t * 84;
      o[2] = 82 + t * 78;
    });
    const scale = size / 1024;
    // Lichen patches.
    for (let i = 0; i < 900 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const r = (2 + rng() * 9) * scale;
      const col = rng() < 0.6 ? [128, 132, 78] : [168, 150, 96];
      wrapped(size, x, y, r, (px, py) => {
        ctx.fillStyle = rgb(col[0], col[1], col[2], 0.22 + rng() * 0.2);
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      });
    }
    // Fractures.
    for (let i = 0; i < 110 * scale; i++) {
      let x = rng() * size, y = rng() * size;
      let ang = rng() * Math.PI * 2;
      ctx.lineWidth = (0.8 + rng() * 1.6) * scale;
      ctx.strokeStyle = rgb(38, 36, 34, 0.55);
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 12; s++) {
        ang += (rng() - 0.5) * 0.9;
        x += Math.cos(ang) * 10 * scale; y += Math.sin(ang) * 10 * scale;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return toTexture(c);
  });
}

/* ========================================================================== *
 * Gravel / sand
 * ========================================================================== */

export function gravelGroundTexture(seed = 41, size = 1024) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const n1 = tileFbm(rng, 5, 5);
    fillPixels(ctx, size, (u, v, o) => {
      const t = n1(u, v);
      o[0] = 150 + t * 50;
      o[1] = 138 + t * 44;
      o[2] = 112 + t * 38;
    });
    const scale = size / 1024;
    for (let i = 0; i < 16000 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const r = (0.8 + rng() * rng() * 4.5) * scale;
      const t = 110 + rng() * 120;
      const warm = rng() * 25;
      wrapped(size, x, y, r * 2, (px, py) => {
        ctx.fillStyle = rgb(40, 36, 30, 0.35);
        ctx.beginPath(); ctx.arc(px + r * 0.3, py + r * 0.3, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgb(t + warm, t, t - warm * 0.5, 1);
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      });
    }
    return toTexture(c);
  });
}

/* ========================================================================== *
 * Forest floor
 * ========================================================================== */

export function forestFloorTexture(seed = 51, size = 1024) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const n1 = tileFbm(rng, 4, 5);
    fillPixels(ctx, size, (u, v, o) => {
      const t = n1(u, v);
      o[0] = 46 + t * 34;
      o[1] = 36 + t * 26;
      o[2] = 24 + t * 16;
    });
    const scale = size / 1024;
    // Fallen needles.
    ctx.lineCap = 'round';
    for (let i = 0; i < 26000 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const len = (5 + rng() * 9) * scale;
      const ang = rng() * Math.PI * 2;
      const t = 70 + rng() * 70;
      ctx.strokeStyle = rgb(t + 30, t * 0.72, t * 0.42, 0.85);
      ctx.lineWidth = 0.9 * scale;
      wrapped(size, x, y, len, (px, py) => {
        ctx.beginPath(); ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
        ctx.stroke();
      });
    }
    // Leaves, moss and twigs.
    for (let i = 0; i < 2400 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const r = (2 + rng() * 5) * scale;
      const moss = rng() < 0.35;
      const col = moss ? [58 + rng() * 30, 78 + rng() * 30, 34] : [110 + rng() * 60, 70 + rng() * 40, 32 + rng() * 20];
      const rot = rng() * Math.PI;
      wrapped(size, x, y, r * 2, (px, py) => {
        ctx.fillStyle = rgb(col[0], col[1], col[2], moss ? 0.55 : 0.8);
        ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.55, rot, 0, Math.PI * 2); ctx.fill();
      });
    }
    return toTexture(c);
  });
}

/* ========================================================================== *
 * Asphalt
 * ========================================================================== */

export function asphaltTexture(seed = 61, size = 1024) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const n1 = tileFbm(rng, 4, 5);
    const n2 = tileFbm(rng, 64, 1);
    fillPixels(ctx, size, (u, v, o) => {
      const t = n1(u, v) * 0.6 + n2(u, v) * 0.4;
      const g = 52 + t * 34;
      o[0] = g; o[1] = g; o[2] = g + 2;
    });
    const scale = size / 1024;
    for (let i = 0; i < 40000 * scale * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const t = rng() < 0.5 ? 30 + rng() * 25 : 110 + rng() * 70;
      ctx.fillStyle = rgb(t, t, t, 0.8);
      ctx.fillRect(x, y, (1 + rng()) * scale, (1 + rng()) * scale);
    }
    // Tar patches.
    for (let i = 0; i < 40 * scale; i++) {
      const x = rng() * size, y = rng() * size;
      const w = (20 + rng() * 80) * scale, h = (10 + rng() * 40) * scale;
      wrapped(size, x, y, Math.max(w, h), (px, py) => {
        ctx.fillStyle = rgb(28, 28, 30, 0.35);
        ctx.fillRect(px, py, w, h);
      });
    }
    return toTexture(c);
  });
}

/** Everything the terrain material needs, sized for the quality tier. */
export function buildTerrainTextureSet(seed = 100, size = 1024) {
  return {
    grass: grassGroundTexture(seed + 1, size),
    dirt: dirtGroundTexture(seed + 2, size),
    rock: rockGroundTexture(seed + 3, size),
    gravel: gravelGroundTexture(seed + 4, size),
    forest: forestFloorTexture(seed + 5, Math.min(size, 1024)),
  };
}

/* ========================================================================== *
 * Water normals
 * ========================================================================== */

/**
 * Tileable ripple normal map: a sum of periodic noise octaves treated as a
 * height field and differentiated into tangent-space normals. Scrolled at two
 * speeds by the water material, it reads as wind-ruffled open water.
 */
export function waterNormalTexture(seed = 71, size = 256) {
  return safe(() => {
    const cv = canvas(size);
    if (!cv) return null;
    const { c, ctx } = cv;
    const rng = makeRng(seed);
    const f = tileFbm(rng, 6, 5);
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) h[y * size + x] = f(x / size, y / size);
    }
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const k = 5.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const l = h[y * size + ((x - 1 + size) % size)];
        const r = h[y * size + ((x + 1) % size)];
        const u = h[((y - 1 + size) % size) * size + x];
        const b = h[((y + 1) % size) * size + x];
        let nx = (l - r) * k;
        let ny = (u - b) * k;
        let nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const i = (y * size + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255;
        d[i + 1] = (ny * 0.5 + 0.5) * 255;
        d[i + 2] = (nz * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: false, anisotropy: 4 });
  });
}
