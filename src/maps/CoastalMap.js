/**
 * maps/CoastalMap.js
 * ---------------------------------------------------------------------------
 * Coastal Cliffs — 2 km of coastline. Beach runs, sea stacks and a hard edge.
 *
 * Open sea to the west, a long sand beach backed by dunes and a fishing
 * village, and to the north a 55 m headland plateau that drops sheer into
 * the water, crowned by a lighthouse, with three sea stacks off its tip. A
 * 200 m pleasure pier on piles runs out from the beach — the course goes
 * underneath it.
 *
 * Ten 4 m gates: up the beach, under the pier, round a sea stack, up the
 * cliff onto the plateau, past the lighthouse, a dive off the tip to sea
 * level, back along the cliff foot, through the village and over the dunes.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import { OutdoorWorld, scatter } from '../world/OutdoorKit.js';
import { Simplex, smoothstep, DistanceField, smoothPath } from '../world/Noise.js';
import { facadeTexture, corrugatedMetalTexture, crateWoodTexture } from '../assets/procedural.js';

const CELL = 4;
const CHUNK_CELLS = 64;
const CHUNKS = 8;
const SIZE = CELL * CHUNK_CELLS * CHUNKS;   // 2048 m
const HALF = SIZE / 2;
const HEAD = { x: -250, z: -350, rx: 380, rz: 170, h: 55 };
const PIER_Z = -80;
const STACKS = [[-690, -290, 11, 42], [-665, -430, 9, 34], [-740, -370, 7, 28]];

const noise = new Simplex(6112);

/** Shoreline x as a function of z (sea is west of it). */
export function shoreX(z) {
  return -150 + 40 * Math.sin(z * 0.004) + 25 * Math.sin(z * 0.011 + 2);
}

export function coastalHeight(x, z) {
  const d = x - shoreX(z);               // + inland, - seaward
  let h;
  if (d < 0) {
    h = Math.max(-26, d * 0.09) + noise.fbm(x * 0.01, z * 0.01, 3) * 1.5;
  } else {
    const beach = Math.min(d, 40) * 0.055;
    const dunes = smoothstep(35, 70, d) * (1 - smoothstep(110, 150, d)) * (3 + 3 * noise.ridged(x * 0.02, z * 0.02, 3));
    const inland = smoothstep(60, 260, d) * (5 + 9 * noise.fbm(x * 0.004 + 5, z * 0.004, 4));
    h = beach + dunes + inland;
  }
  // The headland plateau with near-vertical cliffs.
  const e = Math.hypot((x - HEAD.x) / HEAD.rx, (z - HEAD.z) / HEAD.rz);
  const plateau = HEAD.h * (1 - smoothstep(0.86, 1.0, e)) + 6 * noise.fbm(x * 0.008, z * 0.008, 3) * (1 - smoothstep(0.7, 1.0, e));
  h = Math.max(h, plateau - (e > 1.0 ? 30 : 0));
  // Rising hills at the landward edge.
  h += smoothstep(500, 900, x) * 60;
  return h;
}

export const COASTAL_META = {
  id: 'coastal',
  displayName: 'Coastal Cliffs',
  description: '2 km coastline: 55 m cliffs, lighthouse, sea stacks, a pier to fly under, village and dunes.',
  accent: 'linear-gradient(160deg, #5fa8cf 0%, #9fd0c0 55%, #c2b280 100%)',
  category: 'Long range',
  size: '2 × 2 km',
  gates: 10,
  courseKey: 'coastal.v2',
  outdoor: true,
  ambient: 'field',
};

export class CoastalMap {
  constructor() {
    this.id = 'coastal';
    const z = 40;
    const x = shoreX(z) + 26;
    this.spawnPoint = new THREE.Vector3(x, coastalHeight(x, z) + 0.2, z);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF + 30, -30, -HALF + 30),
      max: new THREE.Vector3(HALF - 30, 500, HALF - 30),
    };
    this.viewDistance = 4000;
    this.link = { range: 1100, indoor: false };
    this.environment = {
      mode: 'outdoor', sunElevation: 26, sunAzimuth: 205, turbidity: 3.4, clouds: 0.4,
      fogDensity: 0.00032, groundColor: 0x6d7a5a, exposure: 0.58,
    };
    this.builder = null;
    this.world = null;
  }

  getGroundHeight(x, z) {
    const h = this.world ? this.world.surfaceAt(x, z) : Math.max(0, coastalHeight(x, z));
    return Number.isFinite(h) ? h : 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 6112, name: 'coastal-map', streaming: { cellSize: 32 } });
    this.builder = b;
    const w = new OutdoorWorld(b, physics, {
      heightFn: coastalHeight, cell: CELL, chunkCells: CHUNK_CELLS, chunks: CHUNKS, waterLevel: 0,
      look: { rockSlope: 0.34, lushness: 0.55, grassScale: 0.3, dryTint: 0xd8c690 },
    });
    this.world = w;
    const shore = [];
    for (let z = -HALF; z <= HALF; z += 10) shore.push({ x: shoreX(z), z });
    const road = [];
    for (let z = -150; z <= 500; z += 20) road.push({ x: shoreX(z) + 125, z });
    this._road = smoothPath(road, 6);
    const roadField = new DistanceField(HALF, 2, 12).addPolyline(this._road);
    this._roadDist = (x, z) => roadField.at(x, z);

    yield* w.generate(0.02, 0.2);
    {
      const sp = this.spawnPoint;
      sp.y = Math.max(w.heightAt(sp.x, sp.z), w.heightAt(sp.x + CELL, sp.z), w.heightAt(sp.x - CELL, sp.z),
        w.heightAt(sp.x, sp.z + CELL), w.heightAt(sp.x, sp.z - CELL)) + 0.2;
    }
    yield* w.build({
      progress: [0.2, 0.52],
      grassOpts: { seed: 61, tint: 0x8aa65a, dryTint: 0xcbb97a, bladeHeight: 0.38 },
      splat: (x, z, h, slope, out) => {
        const d = x - shoreX(z);
        out[2] = (d < 55 && h < 7) ? 1 - smoothstep(35, 55, d) : 0;            // sand
        out[2] = Math.max(out[2], d > 40 && d < 150 ? 0.55 * (1 - smoothstep(110, 150, d)) : 0); // dunes
        out[0] = 1 - smoothstep(2.4, 4.2, this._roadDist(x, z));
        out[1] = 0.35 + 0.45 * smoothstep(0, 1, noise.fbm(x * 0.006, z * 0.006, 2) + 0.4);
      },
    });

    yield { progress: 0.54, label: 'Lighthouse' };
    this._buildLighthouse(b);
    yield { progress: 0.6, label: 'Sea stacks' };
    this._buildStacks(b);
    yield { progress: 0.66, label: 'Pier' };
    this._buildPier(b);
    yield { progress: 0.74, label: 'Village' };
    this._buildVillage(b);
    yield { progress: 0.82, label: 'Pines' };
    this._plantTrees(b);
    yield { progress: 0.9, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.6 });
    w.primeView(this.spawnPoint);
    yield { progress: 1, label: 'Ready' };
  }

  _buildLighthouse(b) {
    const w = this.world;
    const x = HEAD.x - HEAD.rx * 0.78;
    const z = HEAD.z - 20;
    const g = w.heightAt(x, z);
    this._lighthouse = { x, z, g };
    const white = b.standard('lh-white', { color: 0xf2f2ee, roughness: 0.6 });
    const red = b.standard('lh-red', { color: 0xb3261e, roughness: 0.6 });
    const H = 26;
    const bands = 6;
    for (let i = 0; i < bands; i++) {
      const y0 = (i / bands) * H;
      const r0 = 3.6 - 1.2 * (i / bands);
      const r1 = 3.6 - 1.2 * ((i + 1) / bands);
      b.cylinder({ radiusTop: r1, radiusBottom: r0, height: H / bands, segments: 20, position: [x, g + y0 + H / (2 * bands), z], material: i % 2 ? red : white });
    }
    b.cylinder({ radiusTop: 3.4, radiusBottom: 3.4, height: 0.3, segments: 20, position: [x, g + H + 0.15, z], material: white });
    const lamp = b.material('lh-lamp', () => new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 3, transparent: true, opacity: 0.85 }));
    b.cylinder({ radiusTop: 1.6, radiusBottom: 1.6, height: 2.6, segments: 16, position: [x, g + H + 1.6, z], material: lamp });
    b.cylinder({ radiusTop: 0.2, radiusBottom: 2.0, height: 1.6, segments: 16, position: [x, g + H + 3.7, z], material: red });
    // Keeper's cottage.
    b.box({ size: [8, 4, 6], position: [x + 14, g + 2, z + 6], material: white });
    b.box({ size: [8.6, 0.3, 6.6], position: [x + 14, g + 4.2, z + 6], material: red });
  }

  _buildStacks(b) {
    const w = this.world;
    const rockMat = b.standard('stack-rock', { color: 0x8a8378, roughness: 0.95 });
    for (const [x, z, r, h] of STACKS) {
      const base = Math.min(0, w.heightAt(x, z));
      const geo = b.geometry(`stack:${x}`, () => {
        const g = new THREE.CylinderGeometry(r * 0.75, r, h - base, 14, 6);
        const p = g.attributes.position;
        const rng = b.rng;
        for (let i = 0; i < p.count; i++) {
          const k = 1 + (rng() - 0.5) * 0.3;
          p.setX(i, p.getX(i) * k);
          p.setZ(i, p.getZ(i) * k);
        }
        g.computeVertexNormals();
        return g;
      });
      const mesh = new THREE.Mesh(geo, rockMat);
      mesh.position.set(x, (h + base) / 2, z);
      b.root.add(mesh);
      b.cylinder({ radiusTop: r * 0.7, radiusBottom: r * 0.95, height: h - base, segments: 8, position: [x, (h + base) / 2, z], material: rockMat, collide: true }).visible = false;
      // A green cap.
      const cap = b.standard('stack-grass', { color: 0x6a8a4a, roughness: 1 });
      b.cylinder({ radiusTop: r * 0.5, radiusBottom: r * 0.78, height: 1.4, segments: 14, position: [x, h + 0.5, z], material: cap, collide: false });
    }
  }

  _buildPier(b) {
    const x0 = shoreX(PIER_Z) + 10;
    const len = 200;
    const deckY = 6;
    this._pier = { x0, len, deckY };
    const wood = b.material('pier-wood', () => {
      const t = b.tex(crateWoodTexture(6120, [20, 1]));
      return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0x8a6a48, map: t, roughness: 0.9 });
    });
    const iron = b.standard('pier-iron', { color: 0x3a4a52, roughness: 0.6, metalness: 0.6 });
    b.box({ size: [len, 0.4, 8], position: [x0 - len / 2, deckY, PIER_Z], material: wood });
    const piles = [];
    for (let x = x0; x >= x0 - len; x -= 8) {
      for (const oz of [-3.5, 3.5]) {
        const g = this.world.heightAt(x, PIER_Z + oz);
        const hgt = deckY - g;
        piles.push({ size: [0.5, hgt, 0.5], position: [x, g + hgt / 2, PIER_Z + oz] });
      }
      // Cross bracing under the deck (above the course's under-pass height).
      piles.push({ size: [0.2, 0.2, 7], position: [x, deckY - 0.7, PIER_Z] });
    }
    b.boxes(piles, iron, { collide: true });
    // Railings and a pavilion at the seaward end.
    for (const s of [-1, 1]) b.box({ size: [len, 1.0, 0.1], position: [x0 - len / 2, deckY + 0.7, PIER_Z + s * 3.9], material: iron });
    const pav = b.standard('pavilion', { color: 0xeae4d6, roughness: 0.6 });
    b.box({ size: [16, 5, 12], position: [x0 - len + 4, deckY + 2.7, PIER_Z], material: pav });
    const roof = b.material('pav-roof', () => {
      const t = b.tex(corrugatedMetalTexture(6121, [4, 2]));
      return new THREE.MeshStandardMaterial({ color: t ? 0x4a8a8a : 0x3a7070, map: t, roughness: 0.5, metalness: 0.4 });
    });
    b.cylinder({ radiusTop: 0.5, radiusBottom: 10, height: 4, segments: 4, position: [x0 - len + 4, deckY + 7.2, PIER_Z], material: roof, rotationY: Math.PI / 4 });
  }

  _buildVillage(b) {
    const w = this.world;
    const roofMat = b.material('vil-roof', () => {
      const t = b.tex(corrugatedMetalTexture(6130, [3, 2]));
      return new THREE.MeshStandardMaterial({ color: t ? 0x9a4a3a : 0x8a3a2a, map: t, roughness: 0.7, metalness: 0.2 });
    });
    const palette = [[226, 214, 190], [196, 214, 226], [230, 200, 180], [210, 226, 200]];
    let k = 0;
    for (let z = -120; z <= 460; z += 26) {
      for (const side of [-1, 1]) {
        if (b.rng() < 0.2) continue;
        const rx = shoreX(z) + 125 + side * 16;
        const x = rx + rnd(b, -1, 1);
        const g = w.heightAt(x, z);
        const wd = rnd(b, 8, 11);
        const dp = rnd(b, 7, 9);
        const ht = rnd(b, 5.5, 8);
        const col = palette[k % palette.length];
        const mat = b.material(`vil-wall-${k % 4}`, () => {
          const t = b.tex(facadeTexture(6131 + (k % 4), [2, 2], { base: col, lit: 0.08, broken: 0 }));
          return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0xd8d0c0, map: t, roughness: 0.85 });
        });
        b.box({ size: [wd, ht, dp], position: [x, g + ht / 2 - 0.5, z], material: mat });
        const slope = 0.55;
        const rl = (dp / 2) / Math.cos(slope) + 0.5;
        for (const s of [-1, 1]) {
          b.box({ size: [wd + 0.6, 0.25, rl], position: [x, g + ht - 0.5 + (dp / 4) * Math.tan(slope), z + s * dp / 4], rotation: [s * slope, 0, 0], material: roofMat });
        }
        b.boxBody({ size: [wd, dp * 0.5 * Math.tan(slope), dp * 0.6], position: [x, g + ht - 0.3, z] });
        k++;
      }
    }
  }

  _plantTrees(b) {
    const w = this.world;
    const sp = w.createForest();
    const pts = scatter(b.rng, {
      minX: -300, maxX: 900, minZ: -900, maxZ: 900, count: 5200, minDist: 7,
      accept: (x, z) => {
        const d = x - shoreX(z);
        const h = w.heightAt(x, z);
        if (d < 150 || h < 4 || this._roadDist(x, z) < 22) return false;
        if (Math.hypot((x - HEAD.x) / HEAD.rx, (z - HEAD.z) / HEAD.rz) < 1.1) return false;
        return noise.fbm(x * 0.006 - 3, z * 0.006 + 8, 3) > 0.05;
      },
    });
    for (const p of pts) {
      const h = rnd(b, 9, 18);
      w.forest.plant(sp.conifer, p.x, w.heightAt(p.x, p.z), p.z, h, h * 0.62, rnd(b, 0, 6));
    }
    w.buildForest();
  }

  _buildGates(b) {
    const w = this.world;
    const lh = this._lighthouse;
    const pier = this._pier;
    const gx = (z, off) => shoreX(z) + off;
    const ground = (x, z) => Math.max(0, w.heightAt(x, z));
    const at = (x, z, extra = 2.45) => ({ x, z, y: ground(x, z) + extra, ground: ground(x, z) });
    const pierGapX = pier.x0 - 8 * 3 - 4;
    const tip = HEAD.x - HEAD.rx;
    const layout = [
      at(gx(-10, 24), -10),                                        // 1 up the beach
      { x: pierGapX, z: PIER_Z, y: 2.7, ground: 0, yaw: 0 },       // 2 under the pier
      at(STACKS[0][0] + 26, STACKS[0][1] + 34),                    // 3 round the first stack
      at(HEAD.x - 150, HEAD.z + 60),                               // 4 up onto the plateau
      at(lh.x + 18, lh.z - 22),                                    // 5 past the lighthouse
      { x: tip - 40, z: HEAD.z + 70, y: 4, ground: 0 },            // 6 dive off the tip
      at(gx(-160, -30), -160),                                     // 7 along the cliff foot
      at(gx(60, 125), 60),                                         // 8 village street
      at(gx(200, 95), 200),                                        // 9 over the dunes
      at(gx(110, 30), 110),                                        // 10 beach finish
    ].map((p) => ({ ...p, w: 4, h: 4 }));
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 4, beaconHeight: 30, padColors: ['#ff3d3d', '#f2f2f2'],
    });
  }

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
