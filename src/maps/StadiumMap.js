/**
 * maps/StadiumMap.js
 * ---------------------------------------------------------------------------
 * Stadium Bowl — a full-size football stadium at dusk, taken over for a race.
 *
 * A 105 x 68 m pitch inside a two-tier bowl: a 20-row lower tier, a 16-row
 * upper tier on a concourse deck, a steel roof canopy over every stand on
 * cantilever trusses, floodlight gantries along the roof edge, big screens in
 * two corners and a players' tunnel under the main stand. About 190 x 150 m
 * and 36 m to the roof edge — far beyond 8x the old 64 x 44 m field.
 *
 * The course uses the whole bowl: a start straight down the pitch, a dive
 * off a scaffold tower, a slalom through the goalmouth, a climb into the
 * upper tier, a run under the roof canopy, down through the players' tunnel
 * and a finish on the centre spot.
 */

import * as THREE from 'three/webgpu';
import { MapBuilder, rnd } from './MapKit.js';
import {
  grassTexture, concreteTexture, paintedMetalTexture, bannerTexture, corrugatedMetalTexture,
} from '../assets/procedural.js';

const PITCH_W = 105;          // x
const PITCH_L = 68;           // z
const RUNOFF = 6;
const IN_X = PITCH_W / 2 + RUNOFF;   // bowl inner edge
const IN_Z = PITCH_L / 2 + RUNOFF;
const LOWER_ROWS = 20;
const UPPER_ROWS = 16;
const ROW_H = 0.42;
const ROW_D = 0.8;
const CONCOURSE_D = 5;
const UPPER_Y0 = LOWER_ROWS * ROW_H + 4.5;     // upper tier starts above the concourse
const ROOF_Y = 36;
const BOUND_X = IN_X + 48;
const BOUND_Z = IN_Z + 48;

export const STADIUM_META = {
  id: 'stadium',
  displayName: 'Stadium Bowl',
  description: 'Full-size football stadium at dusk: two-tier bowl, roof canopy, players\' tunnel. 12 gates.',
  accent: 'linear-gradient(160deg, #3fae5a 0%, #1f6b3a 55%, #0d2f1c 100%)',
  category: 'Racing',
  size: '190 × 150 × 36 m',
  gates: 12,
  courseKey: 'stadium.v2',
  outdoor: true,
  ambient: 'field',
};

export class StadiumMap {
  constructor() {
    this.id = 'stadium';
    this.spawnPoint = new THREE.Vector3(0, 0.12, 8);
    this.spawnHeading = Math.PI / 2;      // facing -X... up the pitch toward the west goal
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-BOUND_X, -3, -BOUND_Z),
      max: new THREE.Vector3(BOUND_X, ROOF_Y + 40, BOUND_Z),
    };
    this.viewDistance = 1600;
    this.link = { range: 500, indoor: false };
    this.environment = {
      mode: 'outdoor',
      sunElevation: 5,
      sunAzimuth: 200,
      turbidity: 5,
      clouds: 0.42,
      exposure: 0.9,
      hemiIntensity: 0.25,
      fogDensity: 0.0009,
      groundColor: 0x3c4a34,
      shadowRange: 110,
      shadowFocus: [0, 0, 0],
    };
    this.builder = null;
  }

  getGroundHeight() {
    return 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 8401, name: 'stadium-map', streaming: { cellSize: 32 } });
    this.builder = b;
    yield { progress: 0.05, label: 'Pitch' };
    this._buildPitch(b);
    yield { progress: 0.2, label: 'Stands' };
    yield* this._buildStands(b);
    yield { progress: 0.62, label: 'Roof' };
    this._buildRoof(b);
    yield { progress: 0.76, label: 'Floodlights' };
    this._buildLights(b);
    yield { progress: 0.84, label: 'Course' };
    this._buildCourse(b);
    b.finalizeShadows({ castMinRadius: 0.6 });
    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;
    const grassTex = b.tex(grassTexture(8402, [60, 40]));
    const concTex = b.tex(concreteTexture(8403, [30, 6]));
    const steelTex = b.tex(paintedMetalTexture(8404, [2, 2], [196, 200, 206]));
    const roofTex = b.tex(corrugatedMetalTexture(8405, [40, 4]));
    this._mats = {
      grass: b.material('st-grass', () => new THREE.MeshStandardMaterial({ color: grassTex ? 0xffffff : 0x3f8f4a, map: grassTex, roughness: 0.96 })),
      stripe: b.material('st-stripe', () => new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 0.96, transparent: true, opacity: 0.35, depthWrite: false })),
      concrete: b.material('st-conc', () => new THREE.MeshStandardMaterial({ color: concTex ? 0xcfd2d6 : 0x8a8d92, map: concTex, roughness: 0.9 })),
      seatA: b.material('st-seat-a', () => new THREE.MeshStandardMaterial({ color: 0x1f5fa8, roughness: 0.7 })),
      seatB: b.material('st-seat-b', () => new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.7 })),
      steel: b.material('st-steel', () => new THREE.MeshStandardMaterial({ color: steelTex ? 0xffffff : 0x9aa0a8, map: steelTex, roughness: 0.45, metalness: 0.7 })),
      roof: b.material('st-roof', () => new THREE.MeshStandardMaterial({ color: roofTex ? 0xe8eaee : 0xb8bcc2, map: roofTex, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide })),
      line: b.material('st-line', () => new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.8 })),
      flood: b.material('st-flood', () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 3.5 })),
      dark: b.material('st-dark', () => new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.7 })),
      net: b.material('st-net', () => new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.8, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })),
    };
    return this._mats;
  }

  _buildPitch(b) {
    const m = this._materials(b);
    b.floor({ width: BOUND_X * 2 + 60, depth: BOUND_Z * 2 + 60, material: m.grass });
    // Mowing stripes.
    for (let i = 0; i < 14; i += 2) {
      b.box({ size: [PITCH_W / 14, 0.004, PITCH_L], position: [-PITCH_W / 2 + (i + 0.5) * PITCH_W / 14, 0.003, 0], material: m.stripe, collide: false });
    }
    // Markings.
    const hw = PITCH_W / 2;
    const hl = PITCH_L / 2;
    const lines = [
      { size: [PITCH_W, 0.01, 0.12], position: [0, 0.006, -hl] },
      { size: [PITCH_W, 0.01, 0.12], position: [0, 0.006, hl] },
      { size: [0.12, 0.01, PITCH_L], position: [-hw, 0.006, 0] },
      { size: [0.12, 0.01, PITCH_L], position: [hw, 0.006, 0] },
      { size: [0.12, 0.01, PITCH_L], position: [0, 0.006, 0] },
    ];
    for (const s of [-1, 1]) {
      lines.push({ size: [0.12, 0.01, 40.3], position: [s * (hw - 16.5), 0.006, 0] });
      lines.push({ size: [16.5, 0.01, 0.12], position: [s * (hw - 8.25), 0.006, -20.15] });
      lines.push({ size: [16.5, 0.01, 0.12], position: [s * (hw - 8.25), 0.006, 20.15] });
      lines.push({ size: [0.12, 0.01, 18.3], position: [s * (hw - 5.5), 0.006, 0] });
      lines.push({ size: [5.5, 0.01, 0.12], position: [s * (hw - 2.75), 0.006, -9.15] });
      lines.push({ size: [5.5, 0.01, 0.12], position: [s * (hw - 2.75), 0.006, 9.15] });
    }
    b.mergeStatic(lines, m.line, { name: 'pitch-lines' });
    const ring = new THREE.Mesh(b.geometry('st-circle', () => new THREE.RingGeometry(9.1, 9.22, 64)), m.line);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.007;
    b.root.add(ring);
    // Goals: posts, crossbar, net box.
    for (const s of [-1, 1]) {
      const gx = s * hw;
      for (const pz of [-3.66, 3.66]) b.box({ size: [0.12, 2.44, 0.12], position: [gx, 1.22, pz], material: m.line });
      b.box({ size: [0.12, 0.12, 7.44], position: [gx, 2.44, 0], material: m.line });
      const net = b.box({ size: [2, 2.44, 7.32], position: [gx + s * 1.06, 1.22, 0], material: m.net, surface: 'soft' });
      net.renderOrder = 2;
    }
    // Perimeter advertising boards.
    const names = ['APEX FPV', 'SKYLINE CUP', 'VOLT MOTORS', 'KESTREL PROPS'];
    const boardMats = names.map((n, i) => b.material(`st-board-${i}`, () => {
      const t = b.tex(bannerTexture(8420 + i, n, '#0a0d16', '#ffffff', ['#ff5a1f', '#2fd8ff', '#ffd23f', '#27ff9e'][i]));
      return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: t ? 0.9 : 0.1 });
    }));
    const geo = b.geometry('st-board', () => new THREE.BoxGeometry(5, 0.9, 0.15));
    let k = 0;
    const put = (x, z, ry) => {
      const mesh = new THREE.Mesh(geo, boardMats[k++ % boardMats.length]);
      mesh.position.set(x, 0.45, z);
      mesh.rotation.y = ry;
      b.root.add(mesh);
      b.boxBody({ size: [5, 0.9, 0.15], position: [x, 0.45, z], rotationY: ry });
    };
    for (let x = -hw + 3; x <= hw - 3; x += 5.2) { put(x, -hl - 3, 0); put(x, hl + 3, Math.PI); }
    for (let z = -hl + 3; z <= hl - 3; z += 5.2) {
      if (Math.abs(z) < 7) continue;
      put(-hw - 3, z, Math.PI / 2); put(hw + 3, z, -Math.PI / 2);
    }
  }

  /**
   * Four straight stands plus corner fills. Each row is one long box
   * (collider included); seat colour bands ride the treads.
   */
  *_buildStands(b) {
    const m = this._materials(b);
    const sides = [
      { axis: 'x', inner: -IN_Z, dir: -1, len: IN_X * 2 },   // north
      { axis: 'x', inner: IN_Z, dir: 1, len: IN_X * 2 },     // south (main stand)
      { axis: 'z', inner: -IN_X, dir: -1, len: IN_Z * 2 },   // west
      { axis: 'z', inner: IN_X, dir: 1, len: IN_Z * 2 },     // east
    ];
    this._sides = sides;
    const place = (side, off, y, h, depth, lenExtra, mat, collide = true) => {
      const len = side.len + lenExtra;
      const size = side.axis === 'x' ? [len, h, depth] : [depth, h, len];
      const c = side.inner + side.dir * off;
      const pos = side.axis === 'x' ? [0, y, c] : [c, y, 0];
      return b.box({ size, position: pos, material: mat, collide });
    };
    let done = 0;
    for (const side of sides) {
      const main = side.axis === 'x' && side.dir > 0;
      // Lower tier. The main stand leaves a gap for the players' tunnel.
      for (let r = 0; r < LOWER_ROWS; r++) {
        const top = (r + 1) * ROW_H + 1.0;     // 1 m pitch wall
        const off = r * ROW_D + ROW_D / 2;
        if (main) {
          // Two halves either side of a 5 m tunnel mouth (x -2.5..2.5).
          for (const s of [-1, 1]) {
            const len = side.len / 2 + r * ROW_D - 2.5;
            b.box({ size: [len, top, ROW_D], position: [s * (2.5 + len / 2), top / 2, side.inner + off], material: m.concrete });
            b.box({ size: [len * 0.97, 0.4, ROW_D * 0.45], position: [s * (2.5 + len / 2), top + 0.2, side.inner + off + 0.15], material: r % 6 < 3 ? m.seatA : m.seatB, collide: false });
          }
        } else {
          place(side, off, top / 2, top, ROW_D, r * ROW_D * 2, m.concrete);
          place(side, off + 0.15, top + 0.2, 0.4, ROW_D * 0.45, r * ROW_D * 2 - 2, r % 6 < 3 ? m.seatA : m.seatB, false);
        }
      }
      // Concourse deck and the upper tier above it.
      const lowerDepth = LOWER_ROWS * ROW_D;
      const deckOff = lowerDepth + CONCOURSE_D / 2;
      if (main) {
        // Main stand: a 6 m hole in the concourse above the tunnel's back
        // end, so the course can drop from the concourse into the tunnel.
        const full = side.len + lowerDepth * 2 + CONCOURSE_D * 2;
        for (const s of [-1, 1]) {
          const len = full / 2 - 3;
          b.box({ size: [len, 0.4, CONCOURSE_D], position: [s * (3 + len / 2), UPPER_Y0 - 0.2, side.inner + deckOff], material: m.concrete });
        }
      } else {
        place(side, deckOff, UPPER_Y0 - 0.2, 0.4, CONCOURSE_D, lowerDepth * 2 + CONCOURSE_D * 2, m.concrete);
      }
      // Concourse support wall below the deck.
      place(side, lowerDepth + CONCOURSE_D, (UPPER_Y0 - 0.4) / 2, UPPER_Y0 - 0.4, 0.6, lowerDepth * 2 + CONCOURSE_D * 2, m.concrete);
      for (let r = 0; r < UPPER_ROWS; r++) {
        const rise = (r + 1) * ROW_H * 1.25;
        const off = lowerDepth + CONCOURSE_D + r * ROW_D + ROW_D / 2;
        const extra = (lowerDepth + CONCOURSE_D + r * ROW_D) * 2;
        place(side, off, UPPER_Y0 + rise / 2, rise, ROW_D, extra, m.concrete);
        place(side, off + 0.15, UPPER_Y0 + rise + 0.2, 0.4, ROW_D * 0.45, extra - 2, r % 6 < 3 ? m.seatB : m.seatA, false);
      }
      // Back wall to the roof.
      const backOff = lowerDepth + CONCOURSE_D + UPPER_ROWS * ROW_D + 0.4;
      const extra = backOff * 2;
      place(side, backOff, ROOF_Y / 2, ROOF_Y, 0.6, extra, m.concrete);
      yield { progress: 0.2 + 0.4 * (++done / sides.length), label: 'Stands' };
    }
    // Players' tunnel under the main stand: walls, ceiling and a back door.
    const tz0 = IN_Z;
    const tz1 = IN_Z + LOWER_ROWS * ROW_D;
    b.box({ size: [5, 0.4, tz1 - tz0], position: [0, 3.2, (tz0 + tz1) / 2], material: m.concrete });
    for (const s of [-1, 1]) b.box({ size: [0.3, 3.2, tz1 - tz0], position: [s * 2.5, 1.6, (tz0 + tz1) / 2], material: m.dark });
    const tunnelLight = new THREE.PointLight(0xdff0ff, 30, 16, 2);
    tunnelLight.position.set(0, 2.8, (tz0 + tz1) / 2);
    b.addLight(tunnelLight);
    // A little crowd in the main stand (mostly empty — it's a race night).
    const person = b.geometry('st-person', () => new THREE.CapsuleGeometry(0.22, 0.5, 3, 6));
    const people = [];
    for (let r = 2; r < LOWER_ROWS; r += 1) {
      const z = IN_Z + r * ROW_D + ROW_D * 0.62;
      const y = (r + 1) * ROW_H + 1.0 + 0.7;
      for (let x = -40; x <= 40; x += 0.7) {
        if (Math.abs(x) < 3.5 || b.rng() > 0.18) continue;
        people.push({ position: [x, y, z], rotationY: Math.PI + rnd(b, -0.3, 0.3) });
      }
    }
    const pm = b.instanced(person, b.material('st-crowd', () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 })), people);
    if (pm) {
      const c = new THREE.Color();
      const cols = [0x1f5fa8, 0xd8dce2, 0xe63946, 0x222222, 0xffb703];
      for (let i = 0; i < people.length; i++) pm.setColorAt(i, c.set(cols[i % cols.length]));
      pm.instanceColor.needsUpdate = true;
    }
  }

  _buildRoof(b) {
    const m = this._materials(b);
    const depthOf = LOWER_ROWS * ROW_D + CONCOURSE_D + UPPER_ROWS * ROW_D + 0.4;
    for (const side of this._sides) {
      // Canopy slab from the back wall out over the stand, sloping up.
      const reach = depthOf + 2;
      const len = side.len + depthOf * 2;
      const tilt = 0.08;
      const c = side.inner + side.dir * (depthOf - reach / 2 + 2);
      const rot = side.axis === 'x' ? [side.dir * tilt, 0, 0] : [0, 0, -side.dir * tilt];
      const size = side.axis === 'x' ? [len, 0.4, reach] : [reach, 0.4, len];
      const pos = side.axis === 'x' ? [0, ROOF_Y - 1, c] : [c, ROOF_Y - 1, 0];
      b.box({ size, position: pos, rotation: rot, material: m.roof });
      // Cantilever trusses every 12 m.
      const trusses = [];
      for (let t = -len / 2 + 6; t <= len / 2 - 6; t += 12) {
        const back = side.inner + side.dir * depthOf;
        const front = side.inner + side.dir * (depthOf - reach + 2);
        const a = side.axis === 'x' ? [t, ROOF_Y + 5, back] : [back, ROOF_Y + 5, t];
        const f = side.axis === 'x' ? [t, ROOF_Y - 0.8, front] : [front, ROOF_Y - 0.8, t];
        const bb = side.axis === 'x' ? [t, ROOF_Y - 3, back] : [back, ROOF_Y - 3, t];
        trusses.push(MapBuilder.beamPart(a, f, 0.35), MapBuilder.beamPart(bb, f, 0.3));
        trusses.push({ size: [0.4, 8, 0.4], position: side.axis === 'x' ? [t, ROOF_Y + 1, back] : [back, ROOF_Y + 1, t] });
      }
      b.mergeStatic(trusses, m.steel, { name: 'roof-truss' });
      b.collideParts(trusses);
    }
    // Two corner screens.
    const screenTex = b.tex(bannerTexture(8430, 'RACE NIGHT', '#050810', '#ffffff', '#27ff9e'));
    const screenMat = b.material('st-screen', () => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: screenTex ? 1.2 : 0.2 }));
    for (const [x, z, ry] of [[-IN_X - 6, -IN_Z - 6, Math.PI / 4], [IN_X + 6, IN_Z + 6, Math.PI + Math.PI / 4]]) {
      b.box({ size: [16, 9, 1.2], position: [x, 20, z], rotationY: ry, material: m.dark });
      const s = new THREE.Mesh(b.geometry('st-screen', () => new THREE.PlaneGeometry(15, 8)), screenMat);
      s.position.set(x + Math.sin(ry) * 0.65, 20, z + Math.cos(ry) * 0.65);
      s.rotation.y = ry;
      b.root.add(s);
    }
  }

  _buildLights(b) {
    const m = this._materials(b);
    const heads = [];
    for (const side of this._sides) {
      const edge = side.inner + side.dir * (LOWER_ROWS * ROW_D + CONCOURSE_D + UPPER_ROWS * ROW_D - 18);
      const len = side.len;
      for (let t = -len / 2 + 5; t <= len / 2 - 5; t += 4) {
        heads.push({ size: [1.4, 0.5, 0.9], position: side.axis === 'x' ? [t, ROOF_Y - 2.4, edge] : [edge, ROOF_Y - 2.4, t] });
      }
    }
    const hm = b.mergeStatic(heads, m.flood, { name: 'floods' });
    if (hm) hm.userData.noCastShadow = true;
    // The wash itself: four big lights high over the corners of the pitch.
    for (const [x, z] of [[-40, -28], [40, -28], [-40, 28], [40, 28]]) {
      const l = new THREE.PointLight(0xe6efff, 2600, 170, 1.6);
      l.position.set(x, ROOF_Y - 4, z);
      b.addLight(l);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Course
   * ---------------------------------------------------------------------- */

  _buildCourse(b) {
    const m = this._materials(b);
    const hw = PITCH_W / 2;
    const southUpperZ = IN_Z + LOWER_ROWS * ROW_D + CONCOURSE_D / 2;
    const layout = [
      { x: -20, y: 1.6, z: 8 },                                       // 1 start straight west
      { x: -38, y: 1.6, z: -10 },                                     // 2
      { x: -hw + 8, y: 7.5, z: -18, style: 'dive', w: 3 },            // 3 dive tower by the goal
      { x: -hw + 3, y: 1.4, z: 0, w: 2.0, h: 2.0 },                   // 4 through the goalmouth
      { x: -30, y: 1.6, z: 24 },                                      // 5 slalom
      { x: 0, y: 2.2, z: -24, w: 3, h: 3 },                           // 6 across the halfway line
      { x: 36, y: 1.6, z: -8 },                                       // 7
      { x: IN_X + LOWER_ROWS * ROW_D + CONCOURSE_D / 2, y: UPPER_Y0 + 1.5, z: 0, ground: UPPER_Y0 }, // 8 east concourse
      { x: 30, y: ROOF_Y - 8, z: IN_Z + 14, legs: false, w: 3, h: 3 }, // 9 under the south canopy
      { x: -24, y: UPPER_Y0 + 1.5, z: southUpperZ, ground: UPPER_Y0 },  // 10 south concourse, then drop
      { x: 0, y: 1.6, z: IN_Z + 6, yaw: 0, w: 2.2, h: 2.2 },          // 11 out of the players' tunnel
      { x: 0, y: 2.2, z: 0, w: 3, h: 3 },                              // 12 centre-spot finish
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 2.4, beaconHeight: 14, padColors: ['#1f5fa8', '#f2f2f2'],
    });
    // Dive tower scaffold for gate 3 (braces on three faces).
    const g = this.gates[2];
    const half = 1.5 + 0.2;
    const top = g.position.y - 0.25;
    for (const [ax, az, bx, bz] of [[-half, -half, half, -half], [-half, half, half, half], [half, -half, half, half]]) {
      b.beam({ from: [g.position.x + ax, 0.2, g.position.z + az], to: [g.position.x + bx, top, g.position.z + bz], width: 0.06, material: m.steel });
    }
    for (const [x, z, c] of [[-24, 18, '#ff3d3d'], [-36, 28, '#ffd23f'], [20, -18, '#ff3d3d'], [28, -2, '#2fd8ff']]) {
      b.flag({ position: [x, 0, z], color: c, height: 3.4 });
    }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this.gates = [];
  }
}
