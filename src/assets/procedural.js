/**
 * assets/procedural.js
 * ---------------------------------------------------------------------------
 * Every texture in this project is drawn at runtime into a 2D canvas and handed
 * to Three.js as a CanvasTexture. No image files, no loaders, no license
 * headaches, and nothing that can 404 halfway through a map build.
 *
 * The stability contract for this module: **a generator may never throw**.
 * Canvas allocation can fail on memory-constrained devices, and 2D contexts can
 * come back null in exotic browser configurations. Every public function here
 * therefore runs inside `safeTexture()`, which catches, warns once, and returns
 * `null`. Callers treat a null texture as "just use the flat base colour",
 * which is exactly the graceful degradation section 3 of the spec asks for.
 */

import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  LinearMipmapLinearFilter,
  LinearFilter,
} from 'three';

/* ========================================================================== *
 * Deterministic randomness
 * ========================================================================== */

/**
 * mulberry32 — a tiny, fast, seedable PRNG.
 *
 * Maps are built from a fixed seed so the warehouse looks the same every time
 * you load it. `Math.random()` would give a different building on every reset,
 * which makes learning a course impossible.
 */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in [min, max) from a seeded rng. */
export function rf(rng, min, max) {
  return min + rng() * (max - min);
}

/** Random integer in [min, max] from a seeded rng. */
export function ri(rng, min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

/** Pick a random element from an array. */
export function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

/* ========================================================================== *
 * Canvas plumbing
 * ========================================================================== */

let warnedOnce = false;

/**
 * Anisotropic filtering for every generated texture. Floors and walls are
 * almost always seen at grazing angles from an FPV camera, which is exactly
 * where the default filtering smears them into mush. main.js raises this to
 * the quality tier's value (clamped to the GPU's own limit) before a map builds.
 */
let ANISOTROPY = 4;

export function setTextureAnisotropy(n) {
  if (Number.isFinite(n) && n >= 1) ANISOTROPY = Math.min(16, Math.floor(n));
}

export function textureAnisotropy() {
  return ANISOTROPY;
}

/**
 * Allocate a canvas + 2D context, or return null if the browser refuses.
 * Size is always a power of two so mipmapping works without resampling.
 */
function makeCanvas(size) {
  try {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    return { canvas: c, ctx };
  } catch (_e) {
    return null;
  }
}

/**
 * Wrap a drawing routine so a failure degrades to "no texture" instead of
 * killing the map build. `draw(ctx, size, rng)` paints into the canvas.
 */
function safeTexture(size, seed, draw, { repeat = [1, 1], srgb = true, filter = true } = {}) {
  try {
    const made = makeCanvas(size);
    if (!made) throw new Error('2D canvas unavailable');

    draw(made.ctx, size, makeRng(seed));

    const tex = new CanvasTexture(made.canvas);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
    // Colour maps live in sRGB; data maps (roughness/normal) must stay linear.
    if (srgb) tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = ANISOTROPY;
    tex.minFilter = filter ? LinearMipmapLinearFilter : LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = filter;
    tex.needsUpdate = true;
    return tex;
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[procedural] texture generation failed; falling back to flat colours.', err);
    }
    return null;
  }
}

/* ========================================================================== *
 * Noise helpers (drawn directly into the 2D context)
 * ========================================================================== */

/**
 * Value-noise field sampled on a coarse lattice and bilinearly interpolated.
 * Cheaper than real Perlin and completely adequate for surface grain, since
 * these textures are only ever seen at a few metres' distance at speed.
 */
function valueNoise(rng, cells) {
  const g = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < g.length; i++) g[i] = rng();

  // Wrap the far edge back to the near edge so the texture tiles seamlessly.
  for (let i = 0; i <= cells; i++) {
    g[i * (cells + 1) + cells] = g[i * (cells + 1)];
    g[cells * (cells + 1) + i] = g[i];
  }

  return function sample(u, v) {
    const x = u * cells;
    const y = v * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    // Smoothstep the interpolation weights: kills the lattice's boxy look.
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const i00 = g[y0 * (cells + 1) + x0];
    const i10 = g[y0 * (cells + 1) + x0 + 1];
    const i01 = g[(y0 + 1) * (cells + 1) + x0];
    const i11 = g[(y0 + 1) * (cells + 1) + x0 + 1];
    return (i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy;
  };
}

/** Sum several octaves of value noise into one fractal field in [0,1]. */
function fbm(rng, baseCells, octaves) {
  const layers = [];
  let cells = baseCells;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: valueNoise(rng, cells), amp });
    norm += amp;
    cells *= 2;
    amp *= 0.5;
  }
  return (u, v) => {
    let sum = 0;
    for (const l of layers) sum += l.n(u, v) * l.amp;
    return sum / norm;
  };
}

/** Paint a full-canvas fractal-noise wash, tinted between two RGB colours. */
function paintNoise(ctx, size, rng, colA, colB, baseCells, octaves, contrast = 1) {
  const f = fbm(rng, baseCells, octaves);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = f(x / size, y / size);
      // Push values away from the midpoint to increase apparent contrast.
      n = Math.min(1, Math.max(0, (n - 0.5) * contrast + 0.5));
      const i = (y * size + x) * 4;
      d[i] = colA[0] + (colB[0] - colA[0]) * n;
      d[i + 1] = colA[1] + (colB[1] - colA[1]) * n;
      d[i + 2] = colA[2] + (colB[2] - colA[2]) * n;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Sprinkle small speckles — dust, grit, rust flecks, wear. */
function speckle(ctx, size, rng, count, radius, colorFn) {
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = radius * (0.35 + rng() * 0.8);
    ctx.fillStyle = colorFn(rng);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ========================================================================== *
 * Interior surfaces (House map)
 * ========================================================================== */

/** Warm off-white plaster wall with a subtle roller-stipple. */
export function plasterTexture(seed = 11, repeat = [3, 3]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [222, 214, 200], [244, 239, 230], 8, 4, 1.1);
    speckle(ctx, size, rng, 900, 0.9, (r) => `rgba(205,198,186,${0.05 + r() * 0.10})`);
  }, { repeat });
}

/** Wood floorboards: planks with grain, staggered end joints, dark seams. */
export function woodPlankTexture(seed = 12, repeat = [6, 6], tone = 'warm') {
  const palettes = {
    warm: { base: [138, 96, 58], light: [176, 130, 84], seam: 'rgba(48,30,16,0.85)' },
    pale: { base: [176, 148, 112], light: [206, 182, 148], seam: 'rgba(96,72,48,0.7)' },
    dark: { base: [86, 58, 36], light: [116, 82, 52], seam: 'rgba(26,16,8,0.9)' },
  };
  const p = palettes[tone] || palettes.warm;

  return safeTexture(512, seed, (ctx, size, rng) => {
    const plankH = size / 8;             // 8 boards across the tile
    for (let row = 0; row < 8; row++) {
      const y = row * plankH;
      // Per-plank tone variation — real floors are never one flat colour.
      const shade = 0.82 + rng() * 0.36;
      const c = [
        Math.min(255, p.base[0] * shade),
        Math.min(255, p.base[1] * shade),
        Math.min(255, p.base[2] * shade),
      ];
      ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
      ctx.fillRect(0, y, size, plankH);

      // Grain: long, slightly wavy strokes running along the board.
      const grainCount = 22 + Math.floor(rng() * 18);
      for (let g = 0; g < grainCount; g++) {
        const gy = y + rng() * plankH;
        const alpha = 0.04 + rng() * 0.13;
        ctx.strokeStyle = rng() > 0.5
          ? `rgba(${p.light[0]},${p.light[1]},${p.light[2]},${alpha})`
          : `rgba(40,24,12,${alpha})`;
        ctx.lineWidth = 0.6 + rng() * 1.5;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        let cy = gy;
        for (let x = 0; x <= size; x += 24) {
          cy += (rng() - 0.5) * 1.7;
          ctx.lineTo(x, cy);
        }
        ctx.stroke();
      }

      // Staggered butt joints between boards.
      const jointX = rng() * size;
      ctx.strokeStyle = p.seam;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(jointX, y);
      ctx.lineTo(jointX, y + plankH);
      ctx.stroke();

      // Long seam between rows.
      ctx.beginPath();
      ctx.moveTo(0, y + plankH);
      ctx.lineTo(size, y + plankH);
      ctx.stroke();
    }
  }, { repeat });
}

/** Ceramic tile with grout lines — bathroom and kitchen. */
export function tileTexture(seed = 13, repeat = [4, 4], base = [232, 232, 228]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    const n = 4;
    const cell = size / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const s = 0.9 + rng() * 0.16;
        ctx.fillStyle = `rgb(${(base[0] * s) | 0},${(base[1] * s) | 0},${(base[2] * s) | 0})`;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.strokeStyle = 'rgba(150,148,142,0.9)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(size, i * cell); ctx.stroke();
    }
  }, { repeat });
}

/** Woven upholstery / carpet weave for soft furnishings. */
export function fabricTexture(seed = 14, repeat = [2, 2], base = [92, 96, 110]) {
  return safeTexture(128, seed, (ctx, size, rng) => {
    ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    ctx.fillRect(0, 0, size, size);
    // Cross-hatch to read as a weave at close range.
    for (let i = 0; i < size; i += 3) {
      ctx.strokeStyle = `rgba(255,255,255,${0.02 + rng() * 0.05})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
      ctx.strokeStyle = `rgba(0,0,0,${0.03 + rng() * 0.06})`;
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
    }
    speckle(ctx, size, rng, 400, 0.7, (r) => `rgba(255,255,255,${r() * 0.05})`);
  }, { repeat });
}

/* ========================================================================== *
 * Industrial surfaces (Warehouse map)
 * ========================================================================== */

/** Poured concrete slab: mottled grey, expansion joints, oil staining. */
export function concreteTexture(seed = 21, repeat = [10, 10]) {
  return safeTexture(512, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [104, 104, 106], [152, 152, 150], 6, 5, 1.25);

    // Aggregate pitting.
    speckle(ctx, size, rng, 2600, 1.1, (r) => `rgba(70,70,72,${0.10 + r() * 0.28})`);
    speckle(ctx, size, rng, 900, 0.9, (r) => `rgba(190,190,188,${0.06 + r() * 0.16})`);

    // Expansion joints along two edges so tiles form a slab grid.
    ctx.strokeStyle = 'rgba(58,58,60,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(size, 1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(1, 0); ctx.lineTo(1, size); ctx.stroke();

    // A couple of dark oil stains — cheap, sells "abandoned".
    for (let i = 0; i < 3; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 20 + rng() * 60;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(30,28,26,0.34)');
      grad.addColorStop(1, 'rgba(30,28,26,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }, { repeat });
}

/** Corrugated metal siding: vertical ribs with highlight/shadow, plus rust. */
export function corrugatedMetalTexture(seed = 22, repeat = [8, 4]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [96, 100, 104], [132, 137, 142], 4, 3, 1);

    // Ribs. Each is a lit face, a dark valley, and a specular edge.
    const ribW = size / 16;
    for (let i = 0; i < 16; i++) {
      const x = i * ribW;
      const grad = ctx.createLinearGradient(x, 0, x + ribW, 0);
      grad.addColorStop(0.00, 'rgba(0,0,0,0.34)');
      grad.addColorStop(0.32, 'rgba(255,255,255,0.14)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.05)');
      grad.addColorStop(1.00, 'rgba(0,0,0,0.30)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, ribW, size);
    }

    // Rust bleeding downward from random points.
    for (let i = 0; i < 16; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const h = 12 + rng() * 70;
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, `rgba(146,74,32,${0.22 + rng() * 0.34})`);
      grad.addColorStop(1, 'rgba(146,74,32,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - 2.5, y, 5 + rng() * 5, h);
    }
  }, { repeat });
}

/** Heavily oxidised steel — containers, machinery, drums. */
export function rustTexture(seed = 23, repeat = [2, 2]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [78, 46, 30], [148, 84, 44], 5, 4, 1.35);
    speckle(ctx, size, rng, 1600, 2.0, (r) => `rgba(${120 + r() * 90 | 0},${50 + r() * 40 | 0},20,${0.12 + r() * 0.4})`);
    speckle(ctx, size, rng, 500, 1.4, (r) => `rgba(52,52,56,${0.14 + r() * 0.34})`);
  }, { repeat });
}

/** Raw pine pallet / crate wood — lighter and rougher than floorboards. */
export function crateWoodTexture(seed = 24, repeat = [1, 1]) {
  return safeTexture(128, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [128, 100, 66], [176, 146, 104], 3, 3, 1.1);
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = `rgba(70,50,30,${0.08 + rng() * 0.2})`;
      ctx.lineWidth = 0.7 + rng() * 1.3;
      const y = rng() * size;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y + (rng() - 0.5) * 5);
      ctx.stroke();
    }
    // Board seams across the plank face.
    ctx.strokeStyle = 'rgba(50,34,20,0.55)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (size / 4) * i);
      ctx.lineTo(size, (size / 4) * i);
      ctx.stroke();
    }
  }, { repeat });
}

/* ========================================================================== *
 * Outdoor surfaces (Field map)
 * ========================================================================== */

/** Grass with patch variation — dry patches, clumps, scattered dirt. */
export function grassTexture(seed = 31, repeat = [90, 90]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [58, 88, 40], [104, 142, 62], 5, 4, 1.15);

    // Individual blades: short strokes at varied angles.
    for (let i = 0; i < 2400; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const len = 2 + rng() * 5;
      const ang = -Math.PI / 2 + (rng() - 0.5) * 1.1;
      const g = 70 + rng() * 90;
      ctx.strokeStyle = `rgba(${(g * 0.55) | 0},${g | 0},${(g * 0.42) | 0},${0.25 + rng() * 0.5})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      ctx.stroke();
    }

    // Dry / sun-bleached patches.
    for (let i = 0; i < 8; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 14 + rng() * 40;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(150,140,78,${0.16 + rng() * 0.2})`);
      grad.addColorStop(1, 'rgba(150,140,78,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }, { repeat });
}

/** Packed dirt for tracks and paths. */
export function dirtTexture(seed = 32, repeat = [8, 8]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [96, 74, 52], [148, 120, 88], 5, 4, 1.2);
    speckle(ctx, size, rng, 1400, 1.3, (r) => `rgba(${60 + r() * 60 | 0},${45 + r() * 45 | 0},${30 + r() * 30 | 0},${0.1 + r() * 0.35})`);
  }, { repeat });
}

/** Weathered barn siding — vertical red boards. */
export function barnWoodTexture(seed = 33, repeat = [6, 3]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    const boardW = size / 12;
    for (let i = 0; i < 12; i++) {
      const s = 0.72 + rng() * 0.5;
      ctx.fillStyle = `rgb(${(132 * s) | 0},${(44 * s) | 0},${(34 * s) | 0})`;
      ctx.fillRect(i * boardW, 0, boardW, size);
      // Vertical grain streaks.
      for (let g = 0; g < 8; g++) {
        ctx.strokeStyle = `rgba(30,12,8,${0.05 + rng() * 0.16})`;
        ctx.lineWidth = 0.7 + rng();
        const gx = i * boardW + rng() * boardW;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx + (rng() - 0.5) * 4, size); ctx.stroke();
      }
      // Gap between boards.
      ctx.fillStyle = 'rgba(20,10,8,0.65)';
      ctx.fillRect(i * boardW, 0, 1.6, size);
    }
  }, { repeat });
}

/** Tree bark for instanced trunks. */
export function barkTexture(seed = 34, repeat = [1, 2]) {
  return safeTexture(128, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [52, 40, 30], [96, 78, 58], 4, 3, 1.3);
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = `rgba(24,18,12,${0.14 + rng() * 0.3})`;
      ctx.lineWidth = 1 + rng() * 2.4;
      const x = rng() * size;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      let cx = x;
      for (let y = 0; y <= size; y += 14) {
        cx += (rng() - 0.5) * 4;
        ctx.lineTo(cx, y);
      }
      ctx.stroke();
    }
  }, { repeat });
}

/** Foliage canopy: mottled greens with soft alpha-free clumping. */
export function foliageTexture(seed = 35, repeat = [1, 1]) {
  return safeTexture(128, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [24, 54, 24], [72, 118, 50], 4, 4, 1.4);
    speckle(ctx, size, rng, 700, 2.2, (r) => `rgba(${40 + r() * 60 | 0},${80 + r() * 70 | 0},${30 + r() * 40 | 0},${0.15 + r() * 0.4})`);
  }, { repeat });
}

/**
 * Sky gradient strip, used on a large inverted sphere.
 *
 * Drawn as a 2 x N vertical gradient: horizon haze at the bottom, deep blue at
 * the top, with a few soft cloud bands scribbled across the upper half.
 */
export function skyTexture(seed = 36) {
  return safeTexture(512, seed, (ctx, size, rng) => {
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0.00, '#1b4f96');   // zenith
    grad.addColorStop(0.34, '#4d8fd0');
    grad.addColorStop(0.56, '#93bfe3');
    grad.addColorStop(0.70, '#cfe2ee');   // horizon haze
    grad.addColorStop(1.00, '#b9c9cf');   // below horizon (never really seen)
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Cloud bands: stacked soft ellipses in the upper two-thirds.
    for (let i = 0; i < 46; i++) {
      const y = rng() * size * 0.55 + size * 0.06;
      const x = rng() * size;
      const w = 30 + rng() * 150;
      const h = 7 + rng() * 20;
      const a = 0.06 + rng() * 0.24;
      const g2 = ctx.createRadialGradient(x, y, 0, x, y, w);
      g2.addColorStop(0, `rgba(255,255,255,${a})`);
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g2;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, h / w);
      ctx.beginPath();
      ctx.arc(0, 0, w, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, { repeat: [1, 1] });
}

/** Pond surface: subtle ripple pattern for a reflective-ish plane. */
export function waterTexture(seed = 37, repeat = [6, 6]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, [26, 58, 78], [56, 104, 128], 6, 4, 1.1);
    for (let i = 0; i < 120; i++) {
      ctx.strokeStyle = `rgba(200,232,246,${0.03 + rng() * 0.10})`;
      ctx.lineWidth = 0.8 + rng() * 1.4;
      const y = rng() * size;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= size; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.08 + i) * 2.2);
      ctx.stroke();
    }
  }, { repeat });
}

/* ========================================================================== *
 * Shared / misc
 * ========================================================================== */

/** Flat painted metal with light scuffing — appliances, machinery panels. */
export function paintedMetalTexture(seed = 41, repeat = [2, 2], base = [150, 152, 156]) {
  return safeTexture(128, seed, (ctx, size, rng) => {
    const lo = base.map((c) => Math.max(0, c - 26));
    const hi = base.map((c) => Math.min(255, c + 22));
    paintNoise(ctx, size, rng, lo, hi, 4, 3, 0.9);
    speckle(ctx, size, rng, 260, 1.1, (r) => `rgba(60,60,64,${0.05 + r() * 0.18})`);
  }, { repeat });
}

/**
 * Emissive checker for gate rings — bright, high-contrast, easy to pick out at
 * speed, which is the entire point of a race gate.
 */
export function gateStripeTexture(seed = 42, repeat = [10, 1], a = '#ffffff', b = '#ff2d55') {
  return safeTexture(64, seed, (ctx, size) => {
    ctx.fillStyle = a;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = b;
    ctx.fillRect(0, 0, size / 2, size);
  }, { repeat });
}

/* ========================================================================== *
 * Abandoned-industrial decals (Factory map)
 * ---------------------------------------------------------------------------
 * Cheap story-telling: grime streaks bleeding down walls, oil stains for the
 * floor, spray-paint tags for the "bando" read, and a hazard chevron for
 * machinery edges. All are meant for `MapBuilder.decal()` planes, not full
 * wall coverage — a few well-placed streaks sell "abandoned" better than a
 * uniformly dirty wall ever could.
 * ========================================================================== */

/** Vertical grime streaks on a transparent background — walls, columns. */
export function grimeTexture(seed = 61, repeat = [1, 1]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    ctx.clearRect(0, 0, size, size);
    // Streaks: dark translucent drips running top to bottom.
    for (let i = 0; i < 46; i++) {
      const x = rng() * size;
      const y0 = rng() * size * 0.4;
      const len = size * (0.2 + rng() * 0.7);
      const w = 2 + rng() * 9;
      const alpha = 0.10 + rng() * 0.30;
      const grad = ctx.createLinearGradient(x, y0, x, y0 + len);
      grad.addColorStop(0, `rgba(18,16,14,${alpha})`);
      grad.addColorStop(1, 'rgba(18,16,14,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - w / 2, y0, w, len);
    }
    // Blotches: soot and dust clumps.
    speckle(ctx, size, rng, 700, 2.4, (r) => `rgba(22,20,18,${0.08 + r() * 0.25})`);
    speckle(ctx, size, rng, 200, 1.2, (r) => `rgba(140,110,70,${0.05 + r() * 0.12})`);
  }, { repeat });
}

/** Round oil stain on transparent background — floor decals. */
export function oilStainTexture(seed = 62, repeat = [1, 1]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    ctx.clearRect(0, 0, size, size);
    for (let i = 0; i < 4; i++) {
      const x = size / 2 + (rng() - 0.5) * size * 0.3;
      const y = size / 2 + (rng() - 0.5) * size * 0.3;
      const r = size * (0.12 + rng() * 0.22);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(12,11,10,${0.5 + rng() * 0.25})`);
      grad.addColorStop(0.7, `rgba(20,17,12,${0.25 + rng() * 0.2})`);
      grad.addColorStop(1, 'rgba(20,17,12,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Rainbow sheen arc — thin, subtle, sells "oil" instantly.
    ctx.strokeStyle = 'rgba(120,140,180,0.18)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.24, rng() * 3, rng() * 3 + 1.4);
    ctx.stroke();
  }, { repeat });
}

/** Spray-paint tag: bold strokes + drips on transparent background. */
export function graffitiTexture(seed = 63, repeat = [1, 1], hue = null) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    ctx.clearRect(0, 0, size, size);
    const h = hue ?? Math.floor(rng() * 360);
    const col = (a) => `hsla(${h},85%,58%,${a})`;
    const colDark = (a) => `hsla(${(h + 40) % 360},80%,42%,${a})`;
    // Tag: 3-5 wild bezier strokes across the tile.
    ctx.lineCap = 'round';
    const strokes = 3 + Math.floor(rng() * 3);
    for (let s = 0; s < strokes; s++) {
      ctx.strokeStyle = rng() > 0.35 ? col(0.85) : colDark(0.85);
      ctx.lineWidth = 9 + rng() * 10;
      const y = size * (0.25 + rng() * 0.5);
      ctx.beginPath();
      ctx.moveTo(size * 0.08, y);
      ctx.bezierCurveTo(
        size * (0.2 + rng() * 0.2), y + (rng() - 0.5) * size * 0.5,
        size * (0.5 + rng() * 0.2), y + (rng() - 0.5) * size * 0.5,
        size * 0.92, y + (rng() - 0.5) * size * 0.3,
      );
      ctx.stroke();
      // Drips below the stroke ends.
      for (let d = 0; d < 4; d++) {
        const dx = size * (0.1 + rng() * 0.8);
        const len = 8 + rng() * 40;
        ctx.strokeStyle = col(0.5);
        ctx.lineWidth = 2.5 + rng() * 2;
        ctx.beginPath();
        ctx.moveTo(dx, y + 6);
        ctx.lineTo(dx, y + 6 + len);
        ctx.stroke();
      }
    }
    // Overspray halo.
    speckle(ctx, size, rng, 500, 1.6, (r) => col(0.04 + r() * 0.10));
  }, { repeat });
}

/** Yellow/black hazard chevron strip — machinery bases, step edges. */
export function hazardTexture(seed = 64, repeat = [4, 1]) {
  return safeTexture(128, seed, (ctx, size) => {
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#17181a';
    const stripe = size / 4;
    for (let i = -1; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(i * stripe, size);
      ctx.lineTo(i * stripe + stripe, 0);
      ctx.lineTo(i * stripe + stripe * 1.5, 0);
      ctx.lineTo(i * stripe + stripe * 0.5, size);
      ctx.closePath();
      ctx.fill();
    }
    // Wear: scuff the paint back to metal in patches.
    ctx.fillStyle = 'rgba(90,92,96,0.35)';
    for (let i = 0; i < 60; i++) {
      ctx.fillRect(Math.random() * size, Math.random() * size, 2 + Math.random() * 5, 1 + Math.random() * 3);
    }
  }, { repeat });
}

/* ========================================================================== *
 * PBR data maps
 * ---------------------------------------------------------------------------
 * Grayscale companions to the colour maps above, built from the same
 * fractal-noise machinery so surface grain lines up under a material's
 * albedo without a second, unrelated lighting lookup. Kept as standalone
 * generators rather than changing what the colour generators return, so
 * every existing caller and its texture shape stays untouched.
 * ========================================================================== */

/**
 * Roughness data map: a fractal grain field around a mid-grey base, so worn
 * high points and grimy low points both read under `roughnessMap` without
 * needing per-material tuning.
 */
export function roughFromNoise(seed = 51, repeat = [1, 1], { size = 128, base = 0.82, contrast = 0.32 } = {}) {
  return safeTexture(size, seed, (ctx, sz, rng) => {
    const f = fbm(rng, 6, 4);
    const img = ctx.createImageData(sz, sz);
    const d = img.data;
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const n = f(x / sz, y / sz);
        const v = Math.min(1, Math.max(0, base + (n - 0.5) * contrast));
        const g = Math.round(v * 255);
        const i = (y * sz + x) * 4;
        d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, { repeat, srgb: false });
}

/**
 * Bump data map: a lower-frequency fractal field, distinct from the
 * roughness pass so the two do not read as a literal copy of each other.
 */
export function bumpFromNoise(seed = 52, repeat = [1, 1], { size = 128, contrast = 0.55 } = {}) {
  return safeTexture(size, seed, (ctx, sz, rng) => {
    const f = fbm(rng, 5, 3);
    const img = ctx.createImageData(sz, sz);
    const d = img.data;
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const n = f(x / sz, y / sz);
        const v = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * contrast));
        const g = Math.round(v * 255);
        const i = (y * sz + x) * 4;
        d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, { repeat, srgb: false });
}

/** Dispose a texture without caring whether it exists. */
export function disposeTexture(tex) {
  try {
    if (tex && typeof tex.dispose === 'function') tex.dispose();
  } catch (_e) {
    /* a failed dispose must never break a map switch */
  }
}

/* ========================================================================== *
 * Framed wall art (House map)
 * ---------------------------------------------------------------------------
 * Small abstract canvases for picture frames: hazy gradient skies, a sun or
 * moon disc, and layered hill silhouettes. Three moods by seed — the frame
 * moulding itself is a plain box from the map, so the texture only paints
 * what hangs inside it.
 * ========================================================================== */

/** Abstract landscape canvas — dusk, day, or night by seed. */
export function artTexture(seed = 71, repeat = [1, 1]) {
  return safeTexture(128, seed, (ctx, size, rng) => {
    const mood = Math.floor(rng() * 3);
    const skies = [
      ['#2b3a67', '#c96f4a', '#e8b04b'],   // dusk
      ['#7fb2d9', '#cfe8ef', '#f5efdd'],   // day
      ['#0b1026', '#1c2a4a', '#9fc4e8'],   // night
    ];
    const [top, mid, bot] = skies[mood];
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, top);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, bot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    // Sun / moon disc.
    const sx = size * (0.25 + rng() * 0.5);
    const sy = size * (0.25 + rng() * 0.3);
    const sr = size * (0.08 + rng() * 0.06);
    const disc = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 2.4);
    disc.addColorStop(0, mood === 2 ? '#f4f1de' : '#ffe9a8');
    disc.addColorStop(0.4, mood === 2 ? 'rgba(244,241,222,0.9)' : 'rgba(255,233,168,0.9)');
    disc.addColorStop(1, 'rgba(255,233,168,0)');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(sx, sy, sr * 2.4, 0, Math.PI * 2);
    ctx.fill();
    // Layered hills, darkening toward the viewer.
    for (let i = 0; i < 3; i++) {
      const yBase = size * (0.55 + i * 0.15);
      ctx.fillStyle = `rgba(${20 + i * 8},${28 + i * 10},${34 + i * 10},${0.55 + i * 0.15})`;
      ctx.beginPath();
      ctx.moveTo(0, yBase);
      for (let x = 0; x <= size; x += 8) {
        ctx.lineTo(x, yBase + Math.sin(x * 0.05 + i * 2 + seed) * size * 0.05 - rng() * 3);
      }
      ctx.lineTo(size, size);
      ctx.lineTo(0, size);
      ctx.closePath();
      ctx.fill();
    }
  }, { repeat });
}

/* ========================================================================== *
 * French industrial brick (Factory yard)
 * ---------------------------------------------------------------------------
 * Weathered red-brown brick in running bond with pale mortar joints, soot
 * staining, and missing-mortar pitting. Drawn course by course so the joints
 * land on whole pixels; per-brick tone jitter keeps it from reading flat.
 * ========================================================================== */

/** Weathered brickwork — chimney stacks, yard walls, office blocks. */
export function brickTexture(seed = 65, repeat = [6, 3], base = [138, 72, 54]) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    // Mortar bed.
    ctx.fillStyle = 'rgb(168,160,148)';
    ctx.fillRect(0, 0, size, size);

    const courses = 16;
    const courseH = size / courses;
    const brickW = size / 8;
    for (let row = 0; row < courses; row++) {
      const y = row * courseH;
      const offset = (row % 2) * brickW * 0.5;
      for (let i = -1; i < 9; i++) {
        const x = i * brickW + offset;
        // Per-brick tone: kiln variation plus the odd over-burnt header.
        const burnt = rng() < 0.06;
        const s = burnt ? 0.45 + rng() * 0.2 : 0.78 + rng() * 0.44;
        const c = [
          Math.min(255, base[0] * s),
          Math.min(255, base[1] * s),
          Math.min(255, base[2] * s),
        ];
        ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        ctx.fillRect(x + 1, y + 1, brickW - 2, courseH - 2);
        // Top-lit edge / bottom shade for relief at grazing angles.
        ctx.fillStyle = 'rgba(255,235,210,0.10)';
        ctx.fillRect(x + 1, y + 1, brickW - 2, 1.5);
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(x + 1, y + courseH - 2.5, brickW - 2, 1.5);
      }
    }
    // Soot wash drifting up from the bottom courses.
    const grad = ctx.createLinearGradient(0, size, 0, size * 0.4);
    grad.addColorStop(0, 'rgba(25,22,20,0.35)');
    grad.addColorStop(1, 'rgba(25,22,20,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rng, 900, 1.4, (r) => `rgba(30,26,24,${0.08 + r() * 0.22})`);
  }, { repeat });
}

/* ========================================================================== *
 * Race-event dressing (Arena, Stadium, league courses)
 * ========================================================================== */

/**
 * Sponsor / LED-board banner: bold text on a coloured field with a thin
 * accent stripe. Wide aspect (4:1) so it maps onto perimeter boards.
 */
export function bannerTexture(seed = 81, text = 'APEX FPV', bg = '#101624', fg = '#ffffff', accent = '#ff5a1f') {
  return safeTexture(512, seed, (ctx, size) => {
    const w = size;
    const h = size;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = accent;
    ctx.fillRect(0, h * 0.84, w, h * 0.06);
    ctx.fillRect(0, h * 0.1, w, h * 0.03);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The texture is square but maps onto a 4:1 board: draw squashed text
    // that the board's aspect stretches back to normal proportions.
    ctx.save();
    ctx.scale(1, 4);
    ctx.font = `900 ${Math.floor(h * 0.16)}px "Arial Black", Arial, sans-serif`;
    ctx.fillText(text, w / 2, h * 0.118);
    ctx.restore();
  }, { repeat: [1, 1] });
}

/** Safety netting: a thin dark mesh grid on transparent — use with alphaTest. */
export function netTexture(seed = 82, repeat = [20, 6]) {
  return safeTexture(64, seed, (ctx, size) => {
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(20,22,26,0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 1.5); ctx.lineTo(size, 1.5);
    ctx.moveTo(1.5, 0); ctx.lineTo(1.5, size);
    ctx.stroke();
  }, { repeat });
}

/** Numbered launch pad: rubber square with a white border and pad number. */
export function launchPadTexture(seed = 83, label = '1', color = '#e8452c') {
  return safeTexture(256, seed, (ctx, size) => {
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = size * 0.05;
    ctx.strokeRect(size * 0.06, size * 0.06, size * 0.88, size * 0.88);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.floor(size * 0.32)}px Arial, sans-serif`;
    ctx.fillText(label, size / 2, size / 2 + size * 0.02);
  }, { repeat: [1, 1] });
}

/**
 * Building facade: a grid of windows, some lit, some dark, some broken —
 * city blocks, office buildings and the bando tower's neighbours.
 */
export function facadeTexture(seed = 84, repeat = [4, 6], { base = [120, 118, 112], lit = 0.35, broken = 0 } = {}) {
  return safeTexture(256, seed, (ctx, size, rng) => {
    paintNoise(ctx, size, rng, base.map((c) => c * 0.82), base, 6, 3, 1.1);
    const cols = 4;
    const rows = 4;
    const cw = size / cols;
    const rh = size / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw + cw * 0.16;
        const y = r * rh + rh * 0.2;
        const w = cw * 0.68;
        const h = rh * 0.58;
        const roll = rng();
        if (roll < broken) {
          ctx.fillStyle = '#0b0c0e';
        } else if (roll < broken + lit) {
          const warm = 200 + rng() * 55;
          ctx.fillStyle = `rgb(${warm | 0},${(warm * 0.86) | 0},${(warm * 0.6) | 0})`;
        } else {
          const b = 40 + rng() * 40;
          ctx.fillStyle = `rgb(${(b * 0.8) | 0},${(b * 0.95) | 0},${b | 0})`;
        }
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x, y, w, h * 0.12);
      }
    }
  }, { repeat });
}

/** Steel bar grating (catwalk decks) on transparent — use with alphaTest. */
export function gratingTexture(seed = 85, repeat = [8, 8]) {
  return safeTexture(64, seed, (ctx, size) => {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(96,100,106,1)';
    for (let i = 0; i < 4; i++) ctx.fillRect(0, i * (size / 4), size, size / 16);
    for (let i = 0; i < 2; i++) ctx.fillRect(i * (size / 2), 0, size / 20, size);
  }, { repeat });
}

/**
 * Soft light-shaft card for additive god-ray quads: bright core fading to
 * black at the sides and toward the far end. Additive black adds nothing, so
 * the quad's edges vanish instead of reading as a rectangle.
 */
export function shaftTexture(seed = 86) {
  return safeTexture(128, seed, (ctx, size) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1);                          // 0 = top (source)
      const along = Math.pow(1 - v, 0.8) * (0.35 + 0.65 * Math.min(1, v * 6));
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1);
        const across = Math.pow(Math.sin(u * Math.PI), 1.6);
        const k = Math.round(255 * along * across);
        const i = (y * size + x) * 4;
        d[i] = k; d[i + 1] = k; d[i + 2] = k; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, { repeat: [1, 1] });
}
