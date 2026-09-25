/**
 * maps/AlpineMap.js
 * ---------------------------------------------------------------------------
 * Alpine Valley — 3 km of mountain terrain for long-range and cinematic
 * flying, and a downhill race.
 *
 * A glacial valley runs north to south between ridged peaks (snow above
 * ~250 m, bare rock on the steeps, pine forest to the tree line), with a
 * braided gravel riverbed down the middle, a stone railway viaduct striding
 * across it on 30 m arches, a chair lift climbing the eastern slope, and a
 * cluster of chalets on the shore of the lake at the valley mouth.
 *
 * The race starts on the high col at the head of the valley and drops ~150 m
 * over 3.5 km: through the forest, under the lift cable, through an arch of
 * the viaduct, along the river and out over the lake to a floating finish.
 *
 * Everything scales from the terrain kit (see world/OutdoorKit.js): LOD
 * chunks and streamed colliders keep the physics cost the same as a room.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import { OutdoorWorld, scatter } from '../world/OutdoorKit.js';
import { Simplex, smoothstep, clamp, DistanceField, smoothPath } from '../world/Noise.js';
import { barnWoodTexture, corrugatedMetalTexture, brickTexture, concreteTexture } from '../assets/procedural.js';
import { activeQuality } from '../render/Quality.js';

const CELL = 4;
const CHUNK_CELLS = 64;
const CHUNKS = 12;
const SIZE = CELL * CHUNK_CELLS * CHUNKS;   // 3072 m
const HALF = SIZE / 2;
const LAKE = { z: 1220, rx: 380, rz: 250 };
const VIADUCT_Z = 200;

const noise = new Simplex(7702);

/** Valley centre line (x) as a function of z. */
export function valleyX(z) {
  return 70 * Math.sin(z * 0.0019) + 34 * Math.sin(z * 0.0051 + 1.1);
}

/** Valley floor height before detail: 150 m at the col, ~8 m at the lake. */
function floorAt(z) {
  return 8 + 142 * smoothstep(1300, -1300, z);
}

const SPAWN_Z = -1150;
const SPAWN_X = valleyX(SPAWN_Z) + 10;

export function alpineHeight(x, z) {
  const h = rawHeight(x, z);
  // A levelled launch pad at the start so a parked quad does not slide.
  const d = Math.hypot(x - SPAWN_X, z - SPAWN_Z);
  if (d > 22) return h;
  const t = smoothstep(10, 22, d);
  return PAD_H + (h - PAD_H) * t;
}

function rawHeight(x, z) {
  const xc = valleyX(z);
  const d = Math.abs(x - xc);
  let h = floorAt(z);
  // U-shaped glacial trough, then the mountains proper.
  h += 0.00022 * d * d;
  const walls = smoothstep(120, 700, d);
  h += walls * (60 + 380 * noise.ridged(x * 0.0011 + 3, z * 0.0011 - 7, 6));
  h += 7 * noise.fbm(x * 0.006, z * 0.006, 4) + 2 * noise.fbm(x * 0.03, z * 0.03, 2);
  // Braided riverbed: a shallow channel along the centre line.
  h -= 2.2 * (1 - smoothstep(6, 26, d));
  // Lake basin at the valley mouth (water sits at 0).
  const e = Math.hypot((x - xc) / LAKE.rx, (z - LAKE.z) / LAKE.rz);
  h -= 34 * (1 - smoothstep(0.55, 1.05, e));
  return h;
}

const PAD_H = rawHeight(SPAWN_X, SPAWN_Z);

/* Race control points: z and an x offset from the valley centre. */
const COURSE_Z = [
  [-1050, 20], [-820, -40], [-560, 35], [-340, 205], [-60, -30],
  [VIADUCT_Z, 0], [460, 40], [720, -35], [960, 20], [1180, 0],
];

export const ALPINE_META = {
  id: 'alpine',
  displayName: 'Alpine Valley',
  description: '3 km glacial valley: snow peaks, pine forest, viaduct arches, chair lift, lake. 3.5 km downhill race.',
  accent: 'linear-gradient(160deg, #cfe3f5 0%, #6d93b8 45%, #2f4a3a 100%)',
  category: 'Long range',
  size: '3 × 3 km',
  gates: 10,
  badge: 'NEW',
  courseKey: 'alpine.v1',
  outdoor: true,
  ambient: 'field',
};

export class AlpineMap {
  constructor() {
    this.id = 'alpine';
    const z = SPAWN_Z;
    const x = SPAWN_X;
    this.spawnPoint = new THREE.Vector3(x, alpineHeight(x, z) + 0.2, z);
    this.spawnHeading = Math.PI;           // facing +Z, down the valley
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF + 30, -30, -HALF + 30),
      max: new THREE.Vector3(HALF - 30, 900, HALF - 30),
    };
    this.viewDistance = 6000;
    this.link = { range: 1400, indoor: false };
    this.environment = {
      mode: 'outdoor',
      sunElevation: 34,
      sunAzimuth: 70,
      turbidity: 2.4,
      rayleigh: 1.1,
      clouds: 0.28,
      cloudScale: 0.8,
      fogDensity: 0.00022,
      groundColor: 0x4f5a42,
      exposure: 0.6,
    };
    this.builder = null;
    this.world = null;
  }

  getGroundHeight(x, z) {
    const h = this.world ? this.world.surfaceAt(x, z) : Math.max(0, alpineHeight(x, z));
    return Number.isFinite(h) ? h : 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 7702, name: 'alpine-map', streaming: { cellSize: 32 } });
    this.builder = b;
    const w = new OutdoorWorld(b, physics, {
      heightFn: alpineHeight, cell: CELL, chunkCells: CHUNK_CELLS, chunks: CHUNKS, waterLevel: 0,
      look: { snowLine: 250, rockSlope: 0.3, lushness: 0.72, grassScale: 0.28, rockScale: 0.05 },
    });
    this.world = w;

    const river = [];
    for (let z = -HALF; z <= LAKE.z; z += 12) river.push({ x: valleyX(z), z });
    this._line = smoothPath(COURSE_Z.map(([z, dx]) => ({ x: valleyX(z) + dx, z })), 10);
    const roadPts = [];
    for (let z = -HALF + 60; z <= LAKE.z - 200; z += 20) roadPts.push({ x: valleyX(z) - 110 - 25 * Math.sin(z * 0.004), z });
    this._road = smoothPath(roadPts, 6);
    const riverField = new DistanceField(HALF, 4, 60).addPolyline(river);
    const roadField = new DistanceField(HALF, 2, 14).addPolyline(this._road);
    const lineField = new DistanceField(HALF, 4, 60).addPolyline(this._line);
    this._riverDist = (x, z) => riverField.at(x, z);
    this._roadDist = (x, z) => roadField.at(x, z);
    this._lineDist = (x, z) => lineField.at(x, z);

    yield* w.generate(0.02, 0.2);
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
      progress: [0.2, 0.5],
      grassOpts: { seed: 77, tint: 0x86a84a, dryTint: 0xbfae70, bladeHeight: 0.34 },
      splat: (x, z, h, slope, out) => {
        const dr = this._riverDist(x, z);
        out[2] = 1 - smoothstep(10, 22, dr);                               // gravel bed
        out[0] = Math.max(1 - smoothstep(2.2, 4, this._roadDist(x, z)), h < 1.5 && h > -3 ? 0.8 : 0);
        out[1] = clamp(0.25 + (h - 60) / 260 + noise.fbm(x * 0.004, z * 0.004, 2) * 0.4, 0, 0.9);
        out[3] = this._forestAt(x, z, h, slope) ? 0.85 : 0;
      },
    });

    yield { progress: 0.52, label: 'Viaduct' };
    this._buildViaduct(b);
    yield { progress: 0.6, label: 'Chair lift' };
    this._buildLift(b);
    yield { progress: 0.66, label: 'Chalets' };
    this._buildChalets(b);
    yield { progress: 0.72, label: 'Forest' };
    this._plantForest(b);
    yield { progress: 0.86, label: 'Boulders' };
    this._buildRocks(b);
    yield { progress: 0.92, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.6 });
    w.primeView(this.spawnPoint);
    yield { progress: 1, label: 'Ready' };
  }

  _forestAt(x, z, h, slope) {
    if (h < 3 || h > 225 || slope > 0.42) return false;
    const n = noise.fbm(x * 0.005 + 20, z * 0.005 - 5, 3);
    const valleyFloor = floorAt(z) + 12;
    // Meadows on the valley floor, dense forest on the lower slopes.
    return h > valleyFloor ? n > -0.25 : n > 0.3;
  }

  _clear(x, z, gap = 45) {
    if (this._lineDist(x, z) < gap) return false;
    if (this._riverDist(x, z) < 26) return false;
    if (this._roadDist(x, z) < 8) return false;
    if (Math.abs(z - VIADUCT_Z) < 22) return false;
    return true;
  }

  /* ---------------------------------------------------------------------- *
   * Stone viaduct across the valley
   * ---------------------------------------------------------------------- */

  _buildViaduct(b) {
    const w = this.world;
    const stoneTex = b.tex(brickTexture(7710, [2, 6], [150, 140, 124]));
    const stone = b.material('viaduct-stone', () => new THREE.MeshStandardMaterial({ color: stoneTex ? 0xffffff : 0x8f877a, map: stoneTex, roughness: 0.95 }));
    const xc = valleyX(VIADUCT_Z);
    const deckY = floorAt(VIADUCT_Z) + 46;
    const span = 30;
    const pierW = 5;
    const depth = 7;
    const deckLen = 540;
    const x0 = xc - deckLen / 2;
    this._viaduct = { xc, deckY, span };
    // Deck with parapets and a single track.
    b.box({ size: [deckLen, 2.2, depth], position: [xc, deckY + 1.1, VIADUCT_Z], material: stone });
    for (const s of [-1, 1]) b.box({ size: [deckLen, 1.1, 0.5], position: [xc, deckY + 2.75, VIADUCT_Z + s * (depth / 2 - 0.25)], material: stone });
    const rail = b.standard('rail', { color: 0x4a4440, roughness: 0.5, metalness: 0.7 });
    for (const s of [-0.72, 0.72]) b.box({ size: [deckLen, 0.16, 0.08], position: [xc, deckY + 2.28, VIADUCT_Z + s], material: rail, collide: false });
    // Piers every 30 m down to the ground, with arches between them.
    const arch = [];
    for (let px = x0; px <= x0 + deckLen + 0.1; px += span) {
      const g = w.heightAt(px, VIADUCT_Z);
      const hgt = deckY - g + 2;
      if (hgt < 1) continue;
      b.box({ size: [pierW, hgt, depth + 1], position: [px, g - 2 + hgt / 2, VIADUCT_Z], material: stone });
      // Arch ring: segments of a half circle from this pier to the next.
      const r = (span - pierW) / 2;
      const cx = px + span / 2;
      const springY = deckY - r - 0.6;
      if (px + span > x0 + deckLen) continue;
      const segs = 9;
      for (let i = 0; i < segs; i++) {
        const a0 = Math.PI - (i / segs) * Math.PI;
        const a1 = Math.PI - ((i + 1) / segs) * Math.PI;
        arch.push(MapBuilder.beamPart(
          [cx + Math.cos(a0) * r, springY + Math.sin(a0) * r, VIADUCT_Z],
          [cx + Math.cos(a1) * r, springY + Math.sin(a1) * r, VIADUCT_Z], depth, 1.4,
        ));
      }
      // Spandrel fill above the arch haunches (solid, as built).
      for (const sx of [-1, 1]) {
        arch.push({ size: [r * 0.55, r * 0.55, depth], position: [cx + sx * r * 0.78, deckY - r * 0.28, VIADUCT_Z] });
      }
    }
    b.mergeStatic(arch, stone, { name: 'viaduct-arches' });
    b.collideParts(arch);
  }

  /* ---------------------------------------------------------------------- *
   * Chair lift up the eastern slope
   * ---------------------------------------------------------------------- */

  _buildLift(b) {
    const w = this.world;
    const steel = b.standard('lift-steel', { color: 0x9aa3ab, roughness: 0.4, metalness: 0.8 });
    const cableMat = b.standard('lift-cable', { color: 0x202224, roughness: 0.5, metalness: 0.6 });
    const zA = -330;
    const xA = valleyX(zA) + 170;
    const xB = xA + 620;
    const zB = zA - 180;
    const towers = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = xA + (xB - xA) * t;
      const z = zA + (zB - zA) * t;
      const g = w.heightAt(x, z);
      const hgt = i === 0 || i === n ? 9 : 14;
      towers.push({ x, z, top: g + hgt });
      b.box({ size: [0.9, hgt, 0.9], position: [x, g + hgt / 2, z], material: steel });
      b.box({ size: [0.5, 0.5, 6], position: [x, g + hgt, z], rotationY: Math.atan2(xB - xA, zB - zA) + Math.PI / 2, material: steel });
    }
    // Stations at each end.
    const wood = b.material('lift-wood', () => {
      const t = b.tex(barnWoodTexture(7720, [3, 2]));
      return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0x7a5a3a, map: t, roughness: 0.9 });
    });
    for (const [x, z] of [[xA - 12, zA + 4], [xB + 12, zB - 4]]) {
      const g = w.heightAt(x, z);
      b.box({ size: [12, 6, 9], position: [x, g + 3, z], material: wood });
    }
    // Two cables (up and down line) with sag, and chairs hanging off them.
    const cable = [];
    const chairs = [];
    const dir = new THREE.Vector3(xB - xA, 0, zB - zA).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (const s of [-2.6, 2.6]) {
      for (let i = 0; i < towers.length - 1; i++) {
        const a = towers[i];
        const c = towers[i + 1];
        const SEG = 6;
        for (let k = 0; k < SEG; k++) {
          const t0 = k / SEG;
          const t1 = (k + 1) / SEG;
          const y = (t) => a.top + (c.top - a.top) * t - 3.5 * Math.sin(Math.PI * t) - 0.3;
          const p0 = [a.x + (c.x - a.x) * t0 + side.x * s, y(t0), a.z + (c.z - a.z) * t0 + side.z * s];
          const p1 = [a.x + (c.x - a.x) * t1 + side.x * s, y(t1), a.z + (c.z - a.z) * t1 + side.z * s];
          cable.push(MapBuilder.beamPart(p0, p1, 0.06));
          if (k % 2 === 1) chairs.push({ position: [p1[0], p1[1] - 2.0, p1[2]], rotationY: Math.atan2(dir.x, dir.z) });
        }
      }
    }
    b.mergeStatic(cable, cableMat, { name: 'lift-cable' });
    b.collideParts(cable);
    const chairGeo = b.geometry('chair', () => {
      const g = new THREE.BoxGeometry(1.8, 0.1, 0.6);
      g.translate(0, 0, 0);
      return g;
    });
    b.instanced(chairGeo, steel, chairs);
    for (const c of chairs) b.boxBody({ size: [1.8, 2.0, 0.6], position: [c.position[0], c.position[1] + 1.0, c.position[2]], rotationY: c.rotationY });
  }

  /* ---------------------------------------------------------------------- *
   * Chalets on the lake shore
   * ---------------------------------------------------------------------- */

  _buildChalets(b) {
    const w = this.world;
    const wood = b.material('chalet-wood', () => {
      const t = b.tex(barnWoodTexture(7730, [3, 2]));
      return new THREE.MeshStandardMaterial({ color: t ? 0xc8a47a : 0x8a6a48, map: t, roughness: 0.9 });
    });
    const roofMat = b.material('chalet-roof', () => {
      const t = b.tex(corrugatedMetalTexture(7731, [4, 2]));
      return new THREE.MeshStandardMaterial({ color: t ? 0x6a3a30 : 0x5a3028, map: t, roughness: 0.7, metalness: 0.3 });
    });
    const base = b.material('chalet-base', () => {
      const t = b.tex(concreteTexture(7732, [2, 1]));
      return new THREE.MeshStandardMaterial({ color: t ? 0xbdb6a8 : 0x9a9488, map: t, roughness: 0.95 });
    });
    const spots = [[-150, 880], [-95, 905], [-40, 870], [60, 900], [115, 870], [170, 905], [-10, 820]];
    for (const [dx, z] of spots) {
      const x = valleyX(z) + dx;
      if (this._lineDist(x, z) < 30) continue;
      const g = w.heightAt(x, z);
      const W = 9;
      const D = 11;
      const ry = rnd(b, -0.3, 0.3);
      b.box({ size: [W, 3, D], position: [x, g + 1.2, z], rotationY: ry, material: base });
      b.box({ size: [W, 3.2, D], position: [x, g + 4.3, z], rotationY: ry, material: wood });
      const slope = 0.62;
      const len = (W / 2) / Math.cos(slope) + 0.8;
      for (const s of [-1, 1]) {
        const ox = Math.cos(ry) * s * W / 4;
        const oz = -Math.sin(ry) * s * W / 4;
        b.box({ size: [len, 0.3, D + 1.6], position: [x + ox, g + 7.2, z + oz], rotation: [0, ry, -s * slope], material: roofMat });
      }
      b.boxBody({ size: [W * 0.7, 2.4, D], position: [x, g + 7.0, z], rotationY: ry });
    }
    // A jetty out into the lake.
    const jz = LAKE.z - LAKE.rz * 0.72;
    const jx = valleyX(jz) - 60;
    b.box({ size: [3, 0.3, 60], position: [jx, 1.2, jz + 30], material: wood });
    for (let z = jz + 3; z < jz + 60; z += 6) {
      for (const s of [-1, 1]) b.box({ size: [0.3, 4, 0.3], position: [jx + s * 1.3, -0.8, z], material: wood });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Forest and rocks
   * ---------------------------------------------------------------------- */

  _plantForest(b) {
    const w = this.world;
    const sp = w.createForest();
    const q = activeQuality.detailProps ?? 0.8;
    const count = Math.round(32000 * Math.max(0.4, q));
    const pts = scatter(b.rng, {
      minX: -HALF + 60, maxX: HALF - 60, minZ: -HALF + 60, maxZ: HALF - 60,
      count, minDist: 6,
      accept: (x, z) => {
        const h = w.heightAt(x, z);
        return this._forestAt(x, z, h, w.terrain.slopeAt(x, z)) && this._clear(x, z);
      },
    });
    for (const p of pts) {
      const h = w.heightAt(p.x, p.z);
      // Trees shrink toward the tree line.
      const shrink = 1 - smoothstep(140, 225, h) * 0.55;
      const conifer = h > floorAt(p.z) + 20 || b.rng() < 0.7;
      const th = (conifer ? rnd(b, 14, 28) : rnd(b, 9, 16)) * shrink;
      w.forest.plant(conifer ? sp.conifer : sp.broadleaf, p.x, h, p.z, th, th * (conifer ? 0.46 : 0.8), rnd(b, 0, 6.28));
    }
    w.buildForest();
  }

  _buildRocks(b) {
    const w = this.world;
    const rockGeo = b.geometry('boulder', () => new THREE.IcosahedronGeometry(1, 1));
    const rockMat = b.standard('boulder', { color: 0x8c8a86, roughness: 0.95 });
    const rocks = [];
    const pts = scatter(b.rng, {
      minX: -HALF + 80, maxX: HALF - 80, minZ: -HALF + 80, maxZ: HALF - 80, count: 900, minDist: 14,
      accept: (x, z) => {
        const h = w.heightAt(x, z);
        return h > 1 && (w.terrain.slopeAt(x, z) > 0.12 || this._riverDist(x, z) < 22) && this._lineDist(x, z) > 20;
      },
    });
    for (const p of pts) {
      const s = rnd(b, 0.8, 4.5);
      const y = w.heightAt(p.x, p.z) + s * 0.25;
      rocks.push({ position: [p.x, y, p.z], scale: [s, s * rnd(b, 0.5, 0.8), s * rnd(b, 0.8, 1.3)], rotationY: rnd(b, 0, 6.28) });
      if (s > 1.2) b.sphereBody({ radius: s * 0.62, position: [p.x, y, p.z] });
    }
    b.instanced(rockGeo, rockMat, rocks);
  }

  /* ---------------------------------------------------------------------- *
   * Course
   * ---------------------------------------------------------------------- */

  _buildGates(b) {
    const w = this.world;
    const pts = COURSE_Z.map(([z, dx], i) => {
      const x = valleyX(z) + dx;
      let ground = w.surfaceAt(x, z);
      let y = ground + 2.45;
      const size = 4;
      if (i === COURSE_Z.length - 1) {
        // Floating finish on a pontoon.
        ground = 0.4;
        y = 2.9;
      }
      if (z === VIADUCT_Z) {
        // Through an arch: centre of the span nearest the valley centre.
        const v = this._viaduct;
        const k = Math.round((x - (v.xc - 270) - v.span / 2) / v.span);
        const ax = v.xc - 270 + v.span / 2 + k * v.span;
        return { x: ax, z, y: w.heightAt(ax, z) + 6, ground: w.heightAt(ax, z), w: 8, h: 8, yaw: 0 };
      }
      return { x, z, y, ground, w: size, h: size };
    });
    this.gates = b.course(pts, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 4, beaconHeight: 40, padColors: ['#ff3d3d', '#f2f2f2'],
    });
    // Pontoon under the finish.
    const f = pts[pts.length - 1];
    const pont = b.standard('pontoon', { color: 0xd8d8d8, roughness: 0.6 });
    b.box({ size: [10, 0.6, 6], position: [f.x, 0.3, f.z], material: pont });
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  updateView(cameraPos, dronePos, dt) {
    this.world?.update(cameraPos, dt);
  }

  dispose(scene, physics) {
    try { this.world?.dispose(); } catch (_e) { /* ignore */ }
    this.world = null;
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this.gates = [];
  }
}
