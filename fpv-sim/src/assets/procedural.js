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
    tex.anisotropy = 4;
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
