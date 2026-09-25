/**
 * maps/BandoMap.js
 * ---------------------------------------------------------------------------
 * Bando — an abandoned, unfinished concrete-frame tower block on a hoarded
 * city site. The freestyle classic.
 *
 * Five storeys of bare slabs on a column grid (72 x 40 m, 4.2 m floor to
 * floor, 21 m to the roof — ~8x the volume of the old single slab), with an
 * atrium shaft open from the roof to the ground, slab collapses to punch up
 * or down through, two stair cores, a half-built east roof, scaffolding up
 * the south face, and a tower crane with its jib over the site. Outside:
 * plywood hoarding, site cabins, rubble, and the neighbours' facades.
 *
 * Ten gates weave floor to floor: through the ground floor, up through a
 * collapse, out the west face, back in on the third floor, onto the roof,
 * a gate hanging from the crane hook, and a dive down the atrium shaft.
 */

import * as THREE from 'three/webgpu';
import { MapBuilder, rnd } from './MapKit.js';
import {
  concreteTexture, rustTexture, crateWoodTexture, paintedMetalTexture, graffitiTexture,
  grimeTexture, facadeTexture, netTexture, dirtTexture,
} from '../assets/procedural.js';

const HX = 36;              // half width (x)
const HZ = 20;              // half depth (z)
const FLOOR_H = 4.2;
const FLOORS = 5;           // slabs at 4.2, 8.4, 12.6, 16.8 + roof at 21
const ROOF = FLOOR_H * FLOORS;
const SLAB_T = 0.3;
const COL = 0.6;
const XS = Array.from({ length: 11 }, (_, i) => -HX + i * 7.2);
const ZS = Array.from({ length: 7 }, (_, i) => -HZ + i * (40 / 6));
const ATRIUM = [-6, 6, -6, 6];                 // x0, x1, z0, z1
const CORES = [[-30, -24, -14, -8], [24, 30, 8, 14]];
const HOLES = {
  1: [[16, 22, -12, -6]],
  2: [[-22, -17, 8, 14]],
  3: [[20, 26, 2, 8]],
  4: [[-34, -28, -18, -12]],
  5: [[22, HX, -HZ, HZ], [-20, -12, 10, 16]],   // roof: east end never finished
};
const CRANE = { x: 46, z: -30, h: 45, jib: 56 };

export const BANDO_META = {
  id: 'bando',
  displayName: 'Bando',
  description: 'Unfinished 5-storey concrete tower: atrium dive, slab collapses, scaffolding, tower crane. 10 gates.',
  accent: 'linear-gradient(160deg, #8a8d90 0%, #5c5f63 50%, #33363b 100%)',
  category: 'Freestyle',
  size: '72 × 40 × 21 m tower + site',
  gates: 10,
  courseKey: 'bando.v2',
  outdoor: true,
  ambient: 'warehouse',
};

export class BandoMap {
  constructor() {
    this.id = 'bando';
    this.spawnPoint = new THREE.Vector3(-18, 0.12, 32);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-110, -3, -110),
      max: new THREE.Vector3(110, 90, 110),
    };
    this.viewDistance = 1500;
    this.link = { range: 220, indoor: false };
    this.environment = {
      mode: 'outdoor',
      sunElevation: 30,
      sunAzimuth: 225,
      turbidity: 6,
      clouds: 0.72,
      cloudDensity: 0.8,
      exposure: 0.62,
      fogDensity: 0.0024,
      groundColor: 0x5a5852,
      shadowRange: 70,
      shadowFocus: [0, 0, -4],
    };
    this.builder = null;
  }

  getGroundHeight() {
    return 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 5101, name: 'bando-map', streaming: { cellSize: 24 } });
    this.builder = b;
    yield { progress: 0.05, label: 'Site' };
    this._buildSite(b);
    yield { progress: 0.18, label: 'Frame' };
    yield* this._buildFrame(b);
    yield { progress: 0.5, label: 'Cores & walls' };
    this._buildCores(b);
    this._buildInfill(b);
    yield { progress: 0.62, label: 'Scaffold' };
    this._buildScaffold(b);
    yield { progress: 0.72, label: 'Crane' };
    this._buildCrane(b);
    yield { progress: 0.8, label: 'Neighbours' };
    this._buildNeighbours(b);
    yield { progress: 0.88, label: 'Rubble' };
    this._buildRubble(b);
    yield { progress: 0.94, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.5 });
    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;
    const conc = b.tex(concreteTexture(5102, [8, 8]));
    const concRough = b.tex(concreteTexture(5103, [2, 6]));
    const rust = b.tex(rustTexture(5104, [2, 2]));
    const ply = b.tex(crateWoodTexture(5105, [2, 1]));
    const steel = b.tex(paintedMetalTexture(5106, [2, 2], [226, 186, 40]));
    const dirt = b.tex(dirtTexture(5107, [40, 40]));
    this._mats = {
      slab: b.material('bd-slab', () => new THREE.MeshStandardMaterial({ color: conc ? 0xd4d2cc : 0x8f8d88, map: conc, roughness: 0.95 })),
      column: b.material('bd-col', () => new THREE.MeshStandardMaterial({ color: concRough ? 0xc8c6c0 : 0x8a8884, map: concRough, roughness: 0.95 })),
      rust: b.material('bd-rust', () => new THREE.MeshStandardMaterial({ color: rust ? 0xffffff : 0x7a4426, map: rust, roughness: 0.9, metalness: 0.3 })),
      ply: b.material('bd-ply', () => new THREE.MeshStandardMaterial({ color: ply ? 0xffffff : 0xa88a5a, map: ply, roughness: 0.9 })),
      crane: b.material('bd-crane', () => new THREE.MeshStandardMaterial({ color: steel ? 0xffffff : 0xe2ba28, map: steel, roughness: 0.5, metalness: 0.5 })),
      scaffold: b.material('bd-scaffold', () => new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.8 })),
      ground: b.material('bd-ground', () => new THREE.MeshStandardMaterial({ color: dirt ? 0xb0a898 : 0x6a6258, map: dirt, roughness: 1 })),
      dark: b.material('bd-dark', () => new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.8 })),
      net: b.material('bd-net', () => {
        const t = b.tex(netTexture(5108, [20, 10]));
        return new THREE.MeshStandardMaterial({ color: 0x3a7a4a, map: t, alphaTest: 0.5, side: THREE.DoubleSide, transparent: !t, opacity: t ? 1 : 0.25 });
      }),
      block: b.material('bd-block', () => new THREE.MeshStandardMaterial({ color: 0x9c9892, roughness: 0.95 })),
    };
    return this._mats;
  }

  /* ---------------------------------------------------------------------- *
   * Site: ground, hoarding, cabins
   * ---------------------------------------------------------------------- */

  _buildSite(b) {
    const m = this._materials(b);
    b.floor({ width: 240, depth: 240, material: m.ground });
    // Plywood hoarding around the site, with a gap at the south gate.
    const H = 2.4;
    const runs = [
      [-70, -60, 70, -60], [70, -60, 70, 55], [-70, -60, -70, 55],
      [-70, 55, -8, 55], [8, 55, 70, 55],
    ];
    for (const [x0, z0, x1, z1] of runs) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const alongX = Math.abs(x1 - x0) > 0.1;
      b.box({ size: alongX ? [len, H, 0.1] : [0.1, H, len], position: [(x0 + x1) / 2, H / 2, (z0 + z1) / 2], material: m.ply });
    }
    // Site cabins (stacked), a skip, a mixer truck.
    const cabin = b.standard('bd-cabin', { color: 0x2f6aa8, roughness: 0.6, metalness: 0.3 });
    for (const [x, z, lvl] of [[-58, -48, 0], [-58, -48, 1], [-50, -48, 0]]) {
      b.box({ size: [7, 2.6, 3], position: [x, 1.3 + lvl * 2.6, z], material: cabin });
    }
    b.box({ size: [4, 1.6, 2], position: [-44, 0.8, 44], material: m.rust });
    const truck = b.standard('bd-truck', { color: 0xdedede, roughness: 0.5 });
    b.box({ size: [2.5, 2.2, 3], position: [52, 1.6, 30], material: truck });
    b.box({ size: [2.4, 1.2, 6], position: [52, 1.0, 25.5], material: m.dark });
    const drum = b.cylinder({ radiusTop: 1.0, radiusBottom: 1.3, height: 4.2, segments: 12, position: [52, 2.8, 25], material: m.rust, collide: false });
    drum.rotation.x = 1.3;
    b.boxBody({ size: [2.6, 2.6, 4.2], position: [52, 2.8, 25] });
  }

  /* ---------------------------------------------------------------------- *
   * Frame: columns and slabs with openings
   * ---------------------------------------------------------------------- */

  /** Rectangles covering the footprint minus `holes` (x0,x1,z0,z1). */
  _slabPieces(holes) {
    const xs = new Set([-HX, HX]);
    for (const h of holes) { xs.add(Math.max(-HX, h[0])); xs.add(Math.min(HX, h[1])); }
    const xe = [...xs].sort((a, c) => a - c);
    const pieces = [];
    for (let i = 0; i < xe.length - 1; i++) {
      const x0 = xe[i];
      const x1 = xe[i + 1];
      if (x1 - x0 < 0.01) continue;
      const xm = (x0 + x1) / 2;
      const blocked = holes.filter((h) => xm > h[0] && xm < h[1]).map((h) => [h[2], h[3]]).sort((a, c) => a[0] - c[0]);
      let z = -HZ;
      for (const [z0, z1] of blocked) {
        if (z0 > z) pieces.push([x0, x1, z, Math.min(z0, HZ)]);
        z = Math.max(z, z1);
      }
      if (z < HZ) pieces.push([x0, x1, z, HZ]);
    }
    return pieces;
  }

  *_buildFrame(b) {
    const m = this._materials(b);
    // Ground slab.
    b.box({ size: [HX * 2 + 1, 0.3, HZ * 2 + 1], position: [0, 0.15 - 0.3, 0], material: m.slab });
    const cols = [];
    for (let f = 1; f <= FLOORS; f++) {
      const y = f * FLOOR_H;
      const holes = [ATRIUM, ...CORES, ...(HOLES[f] || [])];
      const pieces = this._slabPieces(holes).map(([x0, x1, z0, z1]) => ({
        size: [x1 - x0, SLAB_T, z1 - z0], position: [(x0 + x1) / 2, y - SLAB_T / 2, (z0 + z1) / 2],
      }));
      b.mergeStatic(pieces, m.slab, { name: `slab-${f}` });
      b.collideParts(pieces);
      // Ragged broken edges around each collapse: tilted slab fragments.
      for (const h of HOLES[f] || []) {
        if (h[1] - h[0] > 12) continue;
        b.box({
          size: [h[1] - h[0] - 1.5, 0.25, 1.1], position: [(h[0] + h[1]) / 2, y - 0.9, h[2] + 0.45],
          rotation: [0.6, 0, 0.05], material: m.slab,
        });
      }
      // Columns up to this slab (the roof has none above).
      for (const x of XS) {
        for (const z of ZS) {
          // East end of the top storey was never cast.
          if (f === FLOORS && x > 22) continue;
          // The atrium shaft is column-free top to bottom.
          if (x > ATRIUM[0] && x < ATRIUM[1] && z > ATRIUM[2] && z < ATRIUM[3]) continue;
          cols.push({ size: [COL, FLOOR_H - SLAB_T, COL], position: [x, y - FLOOR_H / 2 - SLAB_T / 2, z] });
        }
      }
      yield { progress: 0.18 + 0.3 * (f / FLOORS), label: 'Frame' };
    }
    b.boxes(cols, m.column, { collide: true });
    // Rebar starters sticking up from the unfinished east columns and roof.
    const rebar = [];
    for (const x of XS) {
      for (const z of ZS) {
        const top = x > 22 ? ROOF - FLOOR_H : ROOF;
        if (b.rng() < 0.4) continue;
        if (x > ATRIUM[0] && x < ATRIUM[1] && z > ATRIUM[2] && z < ATRIUM[3]) continue;
        for (const [ox, oz] of [[-0.2, -0.2], [0.2, 0.2], [-0.2, 0.2], [0.2, -0.2]]) {
          rebar.push({ size: [0.03, rnd(b, 0.8, 1.6), 0.03], position: [x + ox, top + 0.5, z + oz], rotation: [rnd(b, -0.15, 0.15), 0, rnd(b, -0.15, 0.15)] });
        }
      }
    }
    b.mergeStatic(rebar, m.rust, { name: 'rebar' });
    // Roof parapet on the finished part.
    const par = [
      { size: [58, 1.1, 0.25], position: [-7, ROOF + 0.55, -HZ] },
      { size: [58, 1.1, 0.25], position: [-7, ROOF + 0.55, HZ] },
      { size: [0.25, 1.1, HZ * 2], position: [-HX, ROOF + 0.55, 0] },
    ];
    for (const p of par) b.box({ ...p, material: m.slab });
  }

  _buildCores(b) {
    const m = this._materials(b);
    for (const [x0, x1, z0, z1] of CORES) {
      const t = 0.25;
      const w = x1 - x0;
      const d = z1 - z0;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      // Three solid walls, the fourth with a door on every floor.
      b.box({ size: [w, ROOF + 2, t], position: [cx, (ROOF + 2) / 2, z0], material: m.block });
      b.box({ size: [w, ROOF + 2, t], position: [cx, (ROOF + 2) / 2, z1], material: m.block });
      b.box({ size: [t, ROOF + 2, d], position: [x0, (ROOF + 2) / 2, cz], material: m.block });
      for (let f = 0; f < FLOORS; f++) {
        const y0 = f * FLOOR_H;
        // Door 1.4 wide x 2.4 tall in the east/west face at each level.
        b.box({ size: [t, FLOOR_H - 2.4, d], position: [x1, y0 + 2.4 + (FLOOR_H - 2.4) / 2, cz], material: m.block });
        b.box({ size: [t, 2.4, (d - 1.4) / 2], position: [x1, y0 + 1.2, z0 + (d - 1.4) / 4], material: m.block });
        b.box({ size: [t, 2.4, (d - 1.4) / 2], position: [x1, y0 + 1.2, z1 - (d - 1.4) / 4], material: m.block });
        // Two stair flights per floor inside the core.
        b.beam({ from: [x0 + 1, y0, z0 + 1], to: [x0 + 1, y0 + FLOOR_H / 2, z1 - 1], width: 1.4, height: 0.3, material: m.slab });
        b.beam({ from: [x0 + 3.2, y0 + FLOOR_H / 2, z1 - 1], to: [x0 + 3.2, y0 + FLOOR_H, z0 + 1], width: 1.4, height: 0.3, material: m.slab });
      }
      // Tags on the core walls.
      for (let f = 0; f < 3; f++) {
        const tag = b.tex(graffitiTexture(5120 + f + (x0 > 0 ? 10 : 0), [1, 1], [320, 180, 45][f]));
        b.decal({ size: [4.5, 2.4], position: [cx, f * FLOOR_H + 1.7, z1 + t / 2 + 0.03], texture: tag, opacity: 0.9 });
      }
    }
  }

  /** Blockwork infill on the ground floor, with window/door holes. */
  _buildInfill(b) {
    const m = this._materials(b);
    const grime = b.tex(grimeTexture(5130, [1, 1]));
    // North wall of the ground floor, block with openings every other bay.
    for (let i = 0; i < XS.length - 1; i++) {
      const x0 = XS[i] + COL / 2;
      const x1 = XS[i + 1] - COL / 2;
      const w = x1 - x0;
      const cx = (x0 + x1) / 2;
      if (i % 2 === 0) {
        b.box({ size: [w, FLOOR_H - SLAB_T, 0.2], position: [cx, (FLOOR_H - SLAB_T) / 2, -HZ], material: m.block });
      } else {
        b.box({ size: [w, 1.0, 0.2], position: [cx, 0.5, -HZ], material: m.block });
        b.box({ size: [w, 0.8, 0.2], position: [cx, FLOOR_H - SLAB_T - 0.4, -HZ], material: m.block });
      }
      b.decal({ size: [w * 0.8, 2.6], position: [cx, 2, -HZ - 0.12], rotationY: Math.PI, texture: grime, opacity: 0.5 });
    }
    // Big tags on the south face slabs.
    for (let i = 0; i < 4; i++) {
      const tag = b.tex(graffitiTexture(5140 + i, [1, 1], [280, 20, 160, 90][i]));
      b.decal({ size: [7, 3], position: [-24 + i * 14, FLOOR_H * (i % 2 ? 2 : 1) + 0.2, HZ + 0.02], texture: tag, opacity: 0.9 });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Scaffolding up the south face (west half)
   * ---------------------------------------------------------------------- */

  _buildScaffold(b) {
    const m = this._materials(b);
    const zIn = HZ + 0.5;
    const zOut = HZ + 1.8;
    const x0 = -34;
    const x1 = -8;
    const top = FLOOR_H * 4 + 1;
    const tubes = [];
    for (let x = x0; x <= x1 + 0.01; x += 2.6) {
      for (const z of [zIn, zOut]) tubes.push({ size: [0.05, top, 0.05], position: [x, top / 2, z] });
    }
    for (let y = 2; y <= top; y += 2.1) {
      for (const z of [zIn, zOut]) tubes.push({ size: [x1 - x0, 0.05, 0.05], position: [(x0 + x1) / 2, y, z] });
    }
    b.mergeStatic(tubes, m.scaffold, { name: 'scaffold-tubes' });
    for (let x = x0; x <= x1 + 0.01; x += 2.6) {
      for (const z of [zIn, zOut]) b.boxBody({ size: [0.08, top, 0.08], position: [x, top / 2, z] });
    }
    // Boards at each lift, and green debris netting on the outside.
    for (let y = FLOOR_H; y <= top; y += FLOOR_H) {
      b.box({ size: [x1 - x0, 0.06, zOut - zIn], position: [(x0 + x1) / 2, y, (zIn + zOut) / 2], material: m.ply });
    }
    const net = new THREE.Mesh(b.geometry('bd-net', () => new THREE.PlaneGeometry(x1 - x0, top)), m.net);
    net.position.set((x0 + x1) / 2, top / 2, zOut + 0.05);
    b.root.add(net);
    b.boxBody({ size: [x1 - x0, top, 0.05], position: [(x0 + x1) / 2, top / 2, zOut + 0.05], surface: 'soft' });
  }

  /* ---------------------------------------------------------------------- *
   * Tower crane north of the building, jib swung over the site
   * ---------------------------------------------------------------------- */

  _buildCrane(b) {
    const m = this._materials(b);
    const { x, z, h, jib } = CRANE;
    const s = 1.8;   // mast section
    const lat = [];
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) lat.push({ size: [0.14, h, 0.14], position: [x + ox * s / 2, h / 2, z + oz * s / 2] });
    for (let y = 0; y < h - 1; y += 2) {
      for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [-1, 1, 1, 1], [-1, -1, -1, 1], [1, -1, 1, 1]]) {
        lat.push(MapBuilder.beamPart([x + ax * s / 2, y, z + az * s / 2], [x + bx * s / 2, y + 2, z + bz * s / 2], 0.07));
      }
    }
    // Jib toward -X (over the site), counter-jib toward +X.
    const jy = h + 0.8;
    for (const oz of [-0.6, 0.6]) {
      lat.push({ size: [jib, 0.12, 0.12], position: [x - jib / 2, jy, z + oz] });
      lat.push({ size: [16, 0.12, 0.12], position: [x + 8, jy, z + oz] });
    }
    lat.push({ size: [jib, 0.12, 0.12], position: [x - jib / 2, jy + 1.4, z] });
    for (let t = 0; t < jib; t += 2.2) lat.push(MapBuilder.beamPart([x - t, jy, z - 0.6], [x - t - 1.1, jy + 1.4, z], 0.06));
    b.mergeStatic(lat, m.crane, { name: 'crane' });
    b.boxBody({ size: [s, h, s], position: [x, h / 2, z] });
    b.boxBody({ size: [jib, 1.6, 1.4], position: [x - jib / 2, jy + 0.7, z] });
    b.boxBody({ size: [16, 1.6, 1.4], position: [x + 8, jy + 0.7, z] });
    // Cab, apex, counterweights, trolley + hook cable.
    b.box({ size: [2.2, 2.2, 2.4], position: [x, h - 1.4, z + 1.8], material: m.crane });
    b.box({ size: [1.2, 5, 1.2], position: [x, h + 3.3, z], material: m.crane });
    b.box({ size: [4, 2.2, 2.4], position: [x + 14, jy - 1.4, z], material: m.block });
    this._hookX = x - 26;
    b.box({ size: [2.2, 0.6, 1.8], position: [this._hookX, jy - 0.5, z], material: m.dark });
  }

  _buildNeighbours(b) {
    const m = this._materials(b);
    const blocks = [
      { x: -92, z: -20, w: 30, d: 60, h: 46, seed: 5150 },
      { x: 92, z: 10, w: 30, d: 50, h: 34, seed: 5151 },
      { x: -20, z: -92, w: 70, d: 26, h: 58, seed: 5152 },
      { x: 40, z: 92, w: 50, d: 26, h: 28, seed: 5153 },
      { x: -60, z: 92, w: 40, d: 26, h: 40, seed: 5154 },
    ];
    for (const n of blocks) {
      const mat = b.material(`bd-facade-${n.seed}`, () => {
        const t = b.tex(facadeTexture(n.seed, [Math.round(n.w / 6), Math.round(n.h / 3.6)], { base: [150, 146, 138], lit: 0.15, broken: 0.05 }));
        return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0x8f8b84, map: t, roughness: 0.85 });
      });
      b.box({ size: [n.w, n.h, n.d], position: [n.x, n.h / 2, n.z], material: mat });
      b.box({ size: [n.w + 0.6, 0.6, n.d + 0.6], position: [n.x, n.h + 0.3, n.z], material: m.dark });
    }
  }

  _buildRubble(b) {
    const m = this._materials(b);
    const geo = b.geometry('bd-chunk', () => new THREE.BoxGeometry(1, 1, 1));
    const chunks = [];
    const piles = [[-30, 34], [30, 34], [-48, 0], [58, -12], [8, -40], [26, 13]];
    for (const [px, pz] of piles) {
      for (let i = 0; i < 26; i++) {
        const x = px + rnd(b, -4, 4);
        const z = pz + rnd(b, -4, 4);
        const s = [rnd(b, 0.3, 1.4), rnd(b, 0.2, 0.8), rnd(b, 0.3, 1.4)];
        const y = s[1] / 2 + rnd(b, 0, 0.8) * (1 - Math.hypot(x - px, z - pz) / 6);
        const ry = rnd(b, 0, 6);
        chunks.push({ position: [x, Math.max(s[1] / 2, y), z], rotationY: ry, scale: s });
        if (s[1] > 0.5) b.boxBody({ size: s, position: [x, Math.max(s[1] / 2, y), z], rotationY: ry });
      }
    }
    b.instanced(geo, m.slab, chunks);
    // Pallets of blocks and a rebar bundle.
    for (const [x, z] of [[-40, 30], [-38, 26], [40, 40]]) {
      b.box({ size: [1.2, 1.0, 1.0], position: [x, 0.5, z], material: m.block });
    }
    for (let i = 0; i < 12; i++) {
      b.box({ size: [12, 0.03, 0.03], position: [30 + 6, 0.2 + (i % 3) * 0.05, -44 + i * 0.05], material: m.rust, collide: false });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Course
   * ---------------------------------------------------------------------- */

  _buildGates(b) {
    const m = this._materials(b);
    const mid = (a) => a + 3.6;
    const layout = [
      { x: -18, y: 1.8, z: 16.67 },                                   // 1 in through the south face
      { x: 10.8, y: 1.8, z: 3.33 },                                   // 2 ground floor
      { x: 19, y: FLOOR_H - 0.15, z: -9, style: 'dive', w: 2.8, legs: false }, // 3 up through the collapse
      { x: -10.8, y: FLOOR_H + 2.0, z: -10 },                         // 4 first floor
      { x: -46, y: 10.5, z: -6, w: 3, h: 3 },                         // 5 out of the west face
      { x: mid(-28.8), y: FLOOR_H * 3 + 2.0, z: 3.33 },               // 6 back in on the third floor
      { x: 10.8, y: ROOF + 1.9, z: -10, ground: ROOF },               // 7 on the roof
      { x: this._hookX, y: CRANE.h - 9, z: CRANE.z, legs: false, w: 3, h: 3 }, // 8 on the crane hook
      { x: 0, y: ROOF - 0.15, z: 0, style: 'dive', w: 3.2, legs: false },      // 9 down the atrium
      { x: 0, y: 2.2, z: 30, w: 3, h: 3 },                            // 10 out to the finish
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 2.0, beaconHeight: 12, padColors: ['#ff4d2e', '#1a1c20'],
    });
    // Hook cable from the trolley down to gate 8.
    const g8 = this.gates[7];
    const top = g8.position.y + 1.7;
    b.box({ size: [0.04, CRANE.h + 0.3 - top, 0.04], position: [g8.position.x, (CRANE.h + 0.3 + top) / 2, g8.position.z], material: m.dark, collide: false });
    b.box({ size: [0.5, 0.6, 0.3], position: [g8.position.x, top, g8.position.z], material: m.crane, collide: false });
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this.gates = [];
  }
}
