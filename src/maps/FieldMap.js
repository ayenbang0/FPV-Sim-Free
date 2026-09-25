/**
 * maps/FieldMap.js
 * ---------------------------------------------------------------------------
 * Open Field — high-speed, long-range farmland. 1.5 km square.
 *
 * Rolling fields ringed by higher ground, cut by dirt farm tracks and
 * hedgerows, with copses and a forest block, a farmstead (fly-through barn,
 * farmhouse, grain silos, tractor shed), a pond, round hay bales in a mown
 * meadow, and an overhead power line for pilots who want something genuinely
 * hard to thread.
 *
 * Built on the kilometre-scale terrain kit: a chunked LOD heightmap with
 * streamed Heightfield colliders, a splat-blended ground shader, GPU grass
 * around the camera and an instanced LOD forest. The sky, sun, fog and
 * image-based lighting come from the physically based Atmosphere.
 *
 * The course: twelve full-size 3 m gates on a ~2.5 km circuit — under the
 * power line, along the forest edge, over the hill, across the pond and
 * finishing through the barn.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import { OutdoorWorld, scatter } from '../world/OutdoorKit.js';
import { Simplex, smoothstep, smoothPath, DistanceField } from '../world/Noise.js';
import {
  barnWoodTexture, corrugatedMetalTexture, dirtTexture, brickTexture, paintedMetalTexture,
} from '../assets/procedural.js';
import { waterNormalTexture } from '../world/TerrainTextures.js';

const CELL = 3;
const CHUNK_CELLS = 64;
const CHUNKS = 8;
const SIZE = CELL * CHUNK_CELLS * CHUNKS;   // 1536 m
const HALF = SIZE / 2;
const BOUND = HALF - 20;

const FARM = { x: -60, z: 40, r: 75 };
const BARN = { x: -60, z: 40, w: 14, d: 24, h: 7 };
const POND = { x: 60, z: 20, r: 22 };
const POWER_Z = -120;

/* Course control points (x, z). Heights come from the terrain. */
const COURSE = [
  [-40, -10], [-10, -90], [40, POWER_Z], [180, -200], [320, -120], [360, 40],
  [240, 160], [100, 220], [POND.x, POND.z], [-80, 160], [-200, 80], [BARN.x, BARN.z],
];

const noise = new Simplex(4021);

/** Raw rolling land, before the farmstead pad is flattened into it. */
function rawHeight(x, z) {
  let h =
    4.0 * Math.sin(x * 0.006 + 0.3) * Math.cos(z * 0.005) +
    2.0 * Math.sin(x * 0.013 + 1.7) * Math.cos(z * 0.011 - 0.6) +
    0.7 * Math.sin(x * 0.031 - 2.1) * Math.cos(z * 0.027 + 1.2) +
    3.0 * noise.fbm(x * 0.0022, z * 0.0022, 4);
  // A proper hill in the east for the course to climb over.
  h += 16 * Math.exp(-(((x - 360) / 90) ** 2 + ((z - 40) / 110) ** 2));
  // Higher ground rings the map so the edge is a skyline, not a drop.
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += smoothstep(480, HALF - 30, edge) * (38 + 30 * noise.fbm(x * 0.004 + 9, z * 0.004 - 3, 3));
  return h;
}

const FARM_H = rawHeight(FARM.x, FARM.z);
const POND_H = rawHeight(POND.x, POND.z) - 1.4;

/** The terrain: raw land with a levelled farmstead and a scooped pond. */
export function fieldHeight(x, z) {
  let h = rawHeight(x, z);
  const df = Math.hypot(x - FARM.x, z - FARM.z);
  h += (FARM_H - h) * (1 - smoothstep(FARM.r * 0.6, FARM.r, df));
  const dp = Math.hypot(x - POND.x, z - POND.z);
  if (dp < POND.r + 14) {
    const bowl = 1 - smoothstep(POND.r * 0.3, POND.r + 12, dp);
    h = h * (1 - bowl) + (POND_H - 1.8) * bowl;
  }
  return h;
}

export const FIELD_META = {
  id: 'field',
  displayName: 'Open Field',
  description: '1.5 km of farmland: fly-through barn, silos, pond, forest, power lines, 2.5 km circuit.',
  accent: 'linear-gradient(160deg, #7fb2d9 0%, #a9c98a 55%, #6f8f4e 100%)',
  category: 'Long range',
  size: '1.5 × 1.5 km',
  gates: 12,
  courseKey: 'field.v2',
  outdoor: true,
  ambient: 'field',
};

export class FieldMap {
  constructor() {
    this.id = 'field';
    const sx = -40;
    const sz = 12;
    this.spawnPoint = new THREE.Vector3(sx, fieldHeight(sx, sz) + 0.2, sz);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-BOUND, -40, -BOUND),
      max: new THREE.Vector3(BOUND, 400, BOUND),
    };
    this.viewDistance = 3000;
    this.link = { range: 900, indoor: false };
    this.environment = {
      mode: 'outdoor',
      sunElevation: 40,
      sunAzimuth: 140,
      clouds: 0.34,
      fogDensity: 0.00045,
      groundColor: 0x5d6b45,
    };
    this.builder = null;
    this.world = null;
  }

  getGroundHeight(x, z) {
    const h = this.world ? this.world.heightAt(x, z) : fieldHeight(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  /* ====================================================================== *
   * Build
   * ====================================================================== */

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 4021, name: 'field-map', streaming: { cellSize: 32 } });
    this.builder = b;
    const w = new OutdoorWorld(b, physics, {
      heightFn: fieldHeight, cell: CELL, chunkCells: CHUNK_CELLS, chunks: CHUNKS,
      look: { lushness: 0.62, rockSlope: 0.42, grassScale: 0.3 },
    });
    this.world = w;
    this._line = smoothPath(COURSE.map(([x, z]) => ({ x, z })), 8);
    this._roads = [
      smoothPath([{ x: -60, z: 40 }, { x: -70, z: -60 }, { x: -40, z: -220 }, { x: 60, z: -380 }], 6),
      smoothPath([{ x: -60, z: 40 }, { x: 40, z: 60 }, { x: 180, z: 20 }, { x: 300, z: -60 }, { x: 460, z: -80 }], 6),
      smoothPath([{ x: -60, z: 40 }, { x: -160, z: 120 }, { x: -320, z: 140 }], 6),
    ];

    const roadField = new DistanceField(HALF, 1.5, 12);
    for (const r of this._roads) roadField.addPolyline(r);
    const lineField = new DistanceField(HALF, 3, 40).addPolyline(this._line);
    const road = (x, z) => roadField.at(x, z);
    this._road = road;
    this._lineDist = (x, z) => lineField.at(x, z);
    yield* w.generate(0.02, 0.18);
    // Seat the spawn on the collider grid, not the analytic surface: on a
    // slope the two differ by centimetres, which is enough to start inside.
    {
      const sp = this.spawnPoint;
      const t = w.terrain;
      const e = t.cell;
      const top = Math.max(t.heightAt(sp.x, sp.z), t.heightAt(sp.x + e, sp.z), t.heightAt(sp.x - e, sp.z),
        t.heightAt(sp.x, sp.z + e), t.heightAt(sp.x, sp.z - e));
      sp.y = top + 0.2;
    }
    yield* w.build({
      progress: [0.18, 0.5],
      grassOpts: { seed: 41, tint: 0x8fb04a, dryTint: 0xc9b46c },
      splat: (x, z, h, slope, out) => {
        const dr = road(x, z);
        out[0] = 1 - smoothstep(1.6, 3.2, dr);                              // dirt track
        // Field parcels: mown hay (dry) vs pasture, in a patchwork.
        const px = Math.floor((x + 1000) / 140);
        const pz = Math.floor((z + 1000) / 110);
        const parcel = ((px * 7 + pz * 13) % 5) / 4;
        out[1] = parcel > 0.6 ? 0.75 : parcel * 0.35;
        const df = Math.hypot(x - FARM.x, z - FARM.z);
        out[2] = 1 - smoothstep(18, 26, df);                                // yard gravel
        out[3] = this._inForest(x, z) ? 0.9 : 0;
        const dp = Math.hypot(x - POND.x, z - POND.z);
        if (dp < POND.r + 6) { out[0] = Math.max(out[0], 1 - smoothstep(POND.r, POND.r + 5, dp)); }
      },
    });

    yield { progress: 0.52, label: 'Farmstead' };
    this._buildFarm(b);
    yield { progress: 0.62, label: 'Pond' };
    this._buildPond(b);
    yield { progress: 0.66, label: 'Power lines' };
    this._buildPowerLines(b);
    yield { progress: 0.72, label: 'Trees' };
    this._plantTrees(b);
    yield { progress: 0.82, label: 'Hedgerows & fences' };
    this._buildHedges(b);
    yield { progress: 0.88, label: 'Hay & rocks' };
    this._buildScatter(b);
    yield { progress: 0.94, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.5 });
    w.primeView(this.spawnPoint);
    yield { progress: 1, label: 'Ready' };
  }

  _inForest(x, z) {
    // A forest block in the north-west plus noise-shaped copses.
    const block = x < -220 && z < -80 && x > -700 && z > -700;
    const n = noise.fbm(x * 0.006 + 40, z * 0.006 - 11, 3);
    return block ? n > -0.35 : n > 0.42;
  }

  /** Far enough from roads, the farm, the pond and the racing line? */
  _clearOf(x, z, lineGap = 26) {
    if (Math.hypot(x - FARM.x, z - FARM.z) < FARM.r) return false;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 8) return false;
    if (Math.abs(z - POWER_Z) < 16) return false;
    if (this._road(x, z) < 6) return false;
    if (this._lineDist(x, z) < lineGap) return false;
    return Math.abs(x) < HALF - 30 && Math.abs(z) < HALF - 30;
  }

  /* ---------------------------------------------------------------------- *
   * Farmstead: barn, farmhouse, silos, tractor shed
   * ---------------------------------------------------------------------- */

  _buildFarm(b) {
    const base = FARM_H;
    const wallTex = b.tex(barnWoodTexture(3301, [6, 3]));
    const wallMat = b.material('barn-wall', () => new THREE.MeshStandardMaterial({ color: wallTex ? 0xffffff : 0x8a3028, map: wallTex, roughness: 0.92 }));
    const roofTex = b.tex(corrugatedMetalTexture(3302, [8, 3]));
    const roofMat = b.material('barn-roof', () => new THREE.MeshStandardMaterial({ color: roofTex ? 0xdddddd : 0x6b6f74, map: roofTex, roughness: 0.55, metalness: 0.5 }));
    const floorTex = b.tex(dirtTexture(3303, [6, 8]));
    const floorMat = b.material('barn-floor', () => new THREE.MeshStandardMaterial({ color: floorTex ? 0xffffff : 0x6d5844, map: floorTex, roughness: 1 }));
    const brickTex = b.tex(brickTexture(3304, [4, 2], [196, 176, 150]));
    const houseMat = b.material('farmhouse', () => new THREE.MeshStandardMaterial({ color: brickTex ? 0xffffff : 0xc8b494, map: brickTex, roughness: 0.9 }));
    const steelTex = b.tex(paintedMetalTexture(3305, [2, 4], [196, 200, 204]));
    const siloMat = b.material('silo', () => new THREE.MeshStandardMaterial({ color: steelTex ? 0xffffff : 0xc4c8cc, map: steelTex, roughness: 0.4, metalness: 0.7 }));
    const dark = b.standard('farm-dark', { color: 0x2c2e31, roughness: 0.8 });
    const hayMat = b.standard('hay', { color: 0xc9ae62, roughness: 1 });

    // --- barn: fly-through, doors at both gable ends ---
    const { x: bx, z: bz, w: W, d: D, h: H } = BARN;
    b.box({ size: [W + 2, 0.5, D + 2], position: [bx, base + 0.0, bz], material: floorMat });
    const y0 = base + 0.25;
    b.box({ size: [0.4, H, D], position: [bx - W / 2, y0 + H / 2, bz], material: wallMat });
    b.box({ size: [0.4, H, D], position: [bx + W / 2, y0 + H / 2, bz], material: wallMat });
    const doorW = 5.2;
    const doorH = 5.2;
    const sideW = (W - doorW) / 2;
    for (const ez of [-1, 1]) {
      for (const s of [-1, 1]) {
        b.box({ size: [sideW, H, 0.4], position: [bx + s * (doorW / 2 + sideW / 2), y0 + H / 2, bz + ez * D / 2], material: wallMat });
      }
      b.box({ size: [doorW, H - doorH, 0.4], position: [bx, y0 + doorH + (H - doorH) / 2, bz + ez * D / 2], material: wallMat });
      // Gable, stepped (solid, axis-aligned colliders).
      for (let i = 0; i < 4; i++) {
        b.box({ size: [W * (1 - i / 4), 0.8, 0.35], position: [bx, y0 + H + 0.4 + i * 0.8, bz + ez * D / 2], material: wallMat });
      }
      // Sliding door leaves parked open.
      b.box({ size: [2.8, doorH, 0.12], position: [bx + ez * 4.4, y0 + doorH / 2, bz + ez * (D / 2 + 0.3)], material: wallMat, collide: true });
    }
    const slope = Math.atan2(3.2, W / 2);
    const slabLen = Math.hypot(W / 2, 3.2) + 0.5;
    for (const s of [-1, 1]) {
      b.box({ size: [slabLen, 0.3, D + 1], position: [bx + s * W / 4, y0 + H + 1.6, bz], rotation: [0, 0, -s * slope], material: roofMat });
    }
    // Hay loft along one side (flyable under), bales stacked on the other.
    b.box({ size: [4.5, 0.25, D - 2], position: [bx + W / 2 - 2.6, y0 + 3.6, bz], material: floorMat });
    for (let i = 0; i < 6; i++) {
      const z = bz - D / 2 + 3 + i * 3.4;
      b.box({ size: [1.5, 1.0, 1.0], position: [bx - W / 2 + 1.3, y0 + 0.5, z], rotationY: rnd(b, -0.2, 0.2), material: hayMat, surface: 'soft' });
      if (i % 2 === 0) b.box({ size: [1.5, 1.0, 1.0], position: [bx - W / 2 + 1.3, y0 + 1.5, z + 0.3], material: hayMat, surface: 'soft' });
    }
    // Barn interior light.
    const lamp = new THREE.PointLight(0xffd9a0, 30, 16, 2);
    lamp.position.set(bx, y0 + H - 0.6, bz);
    b.addLight(lamp);

    // --- farmhouse (two storeys, hipped roof) ---
    const hx = FARM.x + 34;
    const hz = FARM.z - 12;
    b.box({ size: [11, 6, 9], position: [hx, base + 3, hz], material: houseMat });
    const roof = b.cylinder({ radiusTop: 0.2, radiusBottom: 7.6, height: 3.4, segments: 4, position: [hx, base + 7.7, hz], material: roofMat, rotationY: Math.PI / 4 });
    roof.scale.set(1, 1, 0.82);
    b.boxBody({ size: [11, 3.4, 9], position: [hx, base + 7.2, hz] });
    b.box({ size: [0.8, 2.4, 0.8], position: [hx + 3, base + 9.5, hz + 2], material: houseMat });
    const winMat = b.material('farm-win', () => new THREE.MeshStandardMaterial({ color: 0x2a3442, roughness: 0.1, metalness: 0.4 }));
    for (const wy of [1.6, 4.4]) {
      for (const wx of [-3.5, 0, 3.5]) b.box({ size: [1.1, 1.3, 0.05], position: [hx + wx, base + wy, hz + 4.53], material: winMat, collide: false });
    }

    // --- grain silos with a conveyor leg ---
    for (const [i, [sx, sz]] of [[FARM.x - 26, FARM.z - 18], [FARM.x - 26, FARM.z - 28]].entries()) {
      b.cylinder({ radiusTop: 3.6, radiusBottom: 3.6, height: 15, segments: 20, position: [sx, base + 7.5, sz], material: siloMat });
      b.cylinder({ radiusTop: 0.4, radiusBottom: 3.8, height: 2.6, segments: 20, position: [sx, base + 16.3, sz], material: siloMat });
      if (i === 0) b.beam({ from: [sx + 3, base + 0.5, sz + 6], to: [sx, base + 17, sz], width: 0.5, material: dark });
    }

    // --- open-front tractor shed + tractor ---
    const tx = FARM.x + 30;
    const tz = FARM.z + 30;
    for (const px of [-9, -3, 3, 9]) b.box({ size: [0.3, 5, 0.3], position: [tx + px, base + 2.5, tz - 4], material: dark });
    b.box({ size: [20, 5, 0.3], position: [tx, base + 2.5, tz + 4], material: wallMat });
    b.box({ size: [21, 0.25, 9.4], position: [tx, base + 5.1, tz], rotation: [0.08, 0, 0], material: roofMat });
    const green = b.standard('tractor', { color: 0x2f7a33, roughness: 0.4, metalness: 0.3 });
    b.box({ size: [1.8, 1.2, 3.4], position: [tx - 4, base + 1.2, tz], material: green });
    b.box({ size: [1.5, 1.3, 1.4], position: [tx - 4, base + 2.4, tz + 0.7], material: winMat });
    for (const [wx, wz, r] of [[-1, 1.1, 0.8], [1, 1.1, 0.8], [-1, -1.2, 0.5], [1, -1.2, 0.5]]) {
      const wheel = b.cylinder({ radiusTop: r, radiusBottom: r, height: 0.45, segments: 14, position: [tx - 4 + wx, base + r, tz + wz], material: dark, collide: false });
      wheel.rotation.z = Math.PI / 2;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Pond
   * ---------------------------------------------------------------------- */

  _buildPond(b) {
    const y = POND_H;
    const nrm = b.tex(waterNormalTexture(3701, 256));
    if (nrm) nrm.repeat.set(4, 4);
    const mat = b.material('pond-water', () => new THREE.MeshStandardMaterial({
      color: 0x1d3c40, roughness: 0.05, metalness: 0, normalMap: nrm || null,
      normalScale: new THREE.Vector2(0.3, 0.3), transparent: true, opacity: 0.9,
    }));
    this._pondNormal = nrm;
    const geo = b.geometry('pond', () => new THREE.CircleGeometry(POND.r + 3, 48));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(POND.x, y, POND.z);
    b.root.add(mesh);
    b.cylinder({ radiusTop: POND.r + 2, radiusBottom: POND.r + 2, height: 1, segments: 16, position: [POND.x, y - 0.5, POND.z], material: mat, collide: true, surface: 'soft' }).visible = false;
    // Reeds around the rim.
    const reedGeo = b.geometry('reed', () => new THREE.ConeGeometry(0.05, 1.4, 4));
    const reedMat = b.standard('reed', { color: 0x6d7a3a, roughness: 1 });
    const reeds = [];
    for (let i = 0; i < 260; i++) {
      const a = b.rng() * Math.PI * 2;
      const r = POND.r + rnd(b, -1.5, 3);
      const x = POND.x + Math.cos(a) * r;
      const z = POND.z + Math.sin(a) * r;
      reeds.push({ position: [x, Math.max(y, this.world.heightAt(x, z)) + 0.6, z], scale: rnd(b, 0.6, 1.3), rotationY: rnd(b, 0, 3) });
    }
    b.instanced(reedGeo, reedMat, reeds);
  }

  /* ---------------------------------------------------------------------- *
   * Power lines: 13 m poles every 70 m, three sagging wires, all solid
   * ---------------------------------------------------------------------- */

  _buildPowerLines(b) {
    const poleMat = b.standard('pole', { color: 0x6b5943, roughness: 0.95 });
    const wireMat = b.standard('wire', { color: 0x1a1a1c, roughness: 0.6, metalness: 0.4 });
    const poleH = 13;
    const xs = [];
    for (let x = -630; x <= 630; x += 70) xs.push(x);
    const wires = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const base = this.world.heightAt(x, POWER_Z);
      b.cylinder({ radiusTop: 0.16, radiusBottom: 0.24, height: poleH, segments: 7, position: [x, base + poleH / 2, POWER_Z], material: poleMat });
      b.box({ size: [0.18, 0.18, 3.6], position: [x, base + poleH - 0.7, POWER_Z], material: poleMat });
      if (i === 0) continue;
      const xp = xs[i - 1];
      const yA = this.world.heightAt(xp, POWER_Z) + poleH - 0.8;
      const yB = base + poleH - 0.8;
      const SEG = 8;
      for (const off of [-1.5, 0, 1.5]) {
        for (let s = 0; s < SEG; s++) {
          const t0 = s / SEG;
          const t1 = (s + 1) / SEG;
          const sag = (t) => 2.2 * Math.sin(Math.PI * t);
          wires.push(MapBuilder.beamPart(
            [xp + (x - xp) * t0, yA + (yB - yA) * t0 - sag(t0), POWER_Z + off],
            [xp + (x - xp) * t1, yA + (yB - yA) * t1 - sag(t1), POWER_Z + off], 0.05,
          ));
        }
      }
    }
    b.mergeStatic(wires, wireMat, { name: 'wires' });
    b.collideParts(wires);
  }

  /* ---------------------------------------------------------------------- *
   * Trees: forest block, copses, orchard, hedgerow standards
   * ---------------------------------------------------------------------- */

  _plantTrees(b) {
    const w = this.world;
    const sp = w.createForest();
    const rng = b.rng;
    const pts = scatter(rng, {
      minX: -HALF + 40, maxX: HALF - 40, minZ: -HALF + 40, maxZ: HALF - 40,
      count: 16000, minDist: 5.5,
      accept: (x, z) => this._inForest(x, z) && this._clearOf(x, z),
    });
    for (const p of pts) {
      const y = w.heightAt(p.x, p.z);
      const conifer = noise.noise(p.x * 0.01, p.z * 0.01) > 0.1;
      const h = conifer ? rnd(b, 13, 24) : rnd(b, 9, 17);
      w.forest.plant(conifer ? sp.conifer : sp.broadleaf, p.x, y, p.z, h, h * (conifer ? 0.5 : 0.75), rnd(b, 0, 6.28));
    }
    // Orchard: a grid of small fruit trees east of the farmhouse.
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 6; j++) {
        const x = FARM.x + 90 + i * 8 + rnd(b, -0.6, 0.6);
        const z = FARM.z - 40 + j * 8 + rnd(b, -0.6, 0.6);
        if (!this._clearOf(x, z, 18) && Math.hypot(x - FARM.x, z - FARM.z) >= FARM.r) continue;
        w.forest.plant(sp.broadleaf, x, w.heightAt(x, z), z, rnd(b, 4.5, 6), rnd(b, 5, 6.5), rnd(b, 0, 6));
      }
    }
    // Hedgerow standards: big lone oaks along the field boundaries.
    for (const r of this._roads) {
      for (let i = 0; i < r.length; i += 7) {
        const p = r[i];
        const side = i % 14 === 0 ? 1 : -1;
        const x = p.x + side * 9;
        const z = p.z + 4;
        if (!this._clearOf(x, z)) continue;
        w.forest.plant(sp.broadleaf, x, w.heightAt(x, z), z, rnd(b, 12, 18), rnd(b, 14, 18), rnd(b, 0, 6));
      }
    }
    w.buildForest();
  }

  _buildHedges(b) {
    const hedgeMat = b.standard('hedge', { color: 0x44652f, roughness: 1 });
    const geo = b.geometry('hedge-seg', () => new THREE.BoxGeometry(1, 1, 1));
    const segs = [];
    // Parcel boundaries (every other one hedged), skipping gaps for the course.
    for (let gx = -8; gx <= 8; gx++) {
      const x = gx * 140 - 1000 % 140;
      if (gx % 2) continue;
      for (let z = -560; z < 560; z += 6) {
        if (!this._clearOf(x, z, 20)) continue;
        segs.push({ position: [x, this.world.heightAt(x, z) + 0.8, z + 3], scale: [1.6, 1.8, 6.2], rotationY: 0 });
      }
    }
    for (const s of segs) {
      this.builder.boxBody({ size: s.scale, position: s.position, surface: 'soft' });
    }
    b.instanced(geo, hedgeMat, segs);

    // Post-and-rail fence around the farm paddock.
    const woodMat = b.standard('fence-wood', { color: 0x8b7355, roughness: 0.95 });
    const rails = [];
    const R = FARM.r - 6;
    for (let i = 0; i < 64; i++) {
      const a0 = (i / 64) * Math.PI * 2;
      const a1 = ((i + 1) / 64) * Math.PI * 2;
      const x0 = FARM.x + Math.cos(a0) * R; const z0 = FARM.z + Math.sin(a0) * R;
      const x1 = FARM.x + Math.cos(a1) * R; const z1 = FARM.z + Math.sin(a1) * R;
      // Gate openings where the tracks and the course leave the yard.
      const mx = (x0 + x1) / 2; const mz = (z0 + z1) / 2;
      if (this._road(mx, mz) < 5 || this._lineDist(mx, mz) < 14) continue;
      const y = FARM_H;
      rails.push({ size: [0.14, 1.4, 0.14], position: [x0, y + 0.7, z0] });
      for (const hy of [0.55, 1.15]) rails.push(MapBuilder.beamPart([x0, y + hy, z0], [x1, y + hy, z1], 0.1));
    }
    b.mergeStatic(rails, woodMat, { name: 'paddock-fence' });
    b.collideParts(rails);
  }

  _buildScatter(b) {
    const w = this.world;
    // Round hay bales in the mown parcels.
    const baleGeo = b.geometry('bale', () => { const g = new THREE.CylinderGeometry(0.75, 0.75, 1.2, 16); g.rotateZ(Math.PI / 2); return g; });
    const baleMat = b.standard('bale', { color: 0xcdb36a, roughness: 1 });
    const bales = [];
    const pts = scatter(b.rng, {
      minX: -500, maxX: 500, minZ: -500, maxZ: 500, count: 180, minDist: 12,
      accept: (x, z) => {
        const px = Math.floor((x + 1000) / 140);
        const pz = Math.floor((z + 1000) / 110);
        return ((px * 7 + pz * 13) % 5) / 4 > 0.6 && this._clearOf(x, z, 10) && !this._inForest(x, z);
      },
    });
    for (const p of pts) {
      const y = w.heightAt(p.x, p.z) + 0.72;
      const ry = rnd(b, 0, Math.PI);
      bales.push({ position: [p.x, y, p.z], rotationY: ry });
      b.sphereBody({ radius: 0.75, position: [p.x, y, p.z], surface: 'soft' });
    }
    b.instanced(baleGeo, baleMat, bales);

    // Boulders.
    const rockGeo = b.geometry('rock', () => new THREE.IcosahedronGeometry(1, 1));
    const rockMat = b.standard('rock', { color: 0x8a8b86, roughness: 0.95 });
    const rocks = [];
    for (const p of scatter(b.rng, { minX: -700, maxX: 700, minZ: -700, maxZ: 700, count: 140, minDist: 20, accept: (x, z) => this._clearOf(x, z, 14) })) {
      const s = rnd(b, 0.6, 2.4);
      const y = w.heightAt(p.x, p.z) + s * 0.3;
      rocks.push({ position: [p.x, y, p.z], scale: [s, s * 0.7, s * rnd(b, 0.8, 1.2)], rotationY: rnd(b, 0, 6.28) });
      if (s > 1.1) b.sphereBody({ radius: s * 0.7, position: [p.x, y, p.z] });
    }
    b.instanced(rockGeo, rockMat, rocks);

    // Freestyle kickers by the farm.
    const rampMat = b.standard('ramp', { color: 0x6f5a3f, roughness: 0.9 });
    for (const [x, z, ry] of [[10, -30, 0.2], [-110, -10, 0.9], [150, 90, -0.5]]) {
      const y = w.heightAt(x, z);
      b.box({ size: [6, 0.35, 9], position: [x, y + 1.05, z], rotation: [0.26, ry, 0], material: rampMat });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Course
   * ---------------------------------------------------------------------- */

  _buildGates(b) {
    const pts = COURSE.map(([x, z], i) => {
      const g = i === 8 ? POND_H : this.world.heightAt(x, z);
      const ground = i === COURSE.length - 1 ? FARM_H + 0.25 : g;
      const size = i === COURSE.length - 1 ? 2.6 : 3.0;
      // The finish gate stands inside the barn, squared to its doors.
      const yaw = i === COURSE.length - 1 ? 0 : undefined;
      return { x, z, y: ground + size / 2 + 0.45, ground, w: size, h: size, yaw };
    });
    this.gates = b.course(pts, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 3.0, beaconHeight: 30, padColors: ['#ff5a1f', '#101216'],
    });
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  updateView(cameraPos, dronePos, dt) {
    this.world?.update(cameraPos, dt);
  }

  update(dt, elapsed) {
    if (this._pondNormal) this._pondNormal.offset.set((elapsed * 0.01) % 1, (elapsed * 0.006) % 1);
  }

  dispose(scene, physics) {
    try { this.world?.dispose(); } catch (_e) { /* ignore */ }
    this.world = null;
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this.gates = [];
  }
}
