/**
 * maps/ArenaMap.js
 * ---------------------------------------------------------------------------
 * Apex Arena — a full-scale indoor league race.
 *
 * A 150 x 80 m exhibition hall with a 24 m clear height, dressed for a
 * championship night: steel roof trusses carrying LED rigs, hanging video
 * walls, a 14-row grandstand with a crowd behind a safety net, the pilots'
 * stand and pit tents opposite, and LED sponsor boards around the circuit.
 *
 * The course is a real league layout at real dimensions, not a scaled toy:
 * 2.0 m padded square gates (solid frames, like the real thing), a double
 * gate, a three-high ladder you take at the top, a 2.6 m dive gate on an 8 m
 * scaffold tower, a flag slalom, a high gate on a 7 m scaffold, a hurdle, and
 * 3.2 m arches at the far turn and the finish. About 420 m a lap; a clean lap
 * on a 5" is ~20 s.
 *
 * Lighting is an overhead stage wash (a shadow-casting light pinned over the
 * whole hall — the roof itself is excluded from the shadow pass, so it lights
 * the floor like an arena rig rather than blocking a sun), plus coloured
 * accent washes and emissive fixtures. The interior is then captured into an
 * environment map, which is what makes the polished floor reflect the rigs.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import {
  concreteTexture, corrugatedMetalTexture, paintedMetalTexture, fabricTexture,
  bannerTexture, netTexture, launchPadTexture,
} from '../assets/procedural.js';

const HALL_L = 150;          // z
const HALL_W = 80;           // x
const HALL_H = 24;           // truss bottom chord
const ROOF_Y = 26.5;
const HALF_L = HALL_L / 2;
const HALF_W = HALL_W / 2;
const WALL_T = 0.4;

const STAND_X0 = 28.5;       // front of the grandstand
const STAND_ROWS = 14;
const ROW_H = 0.5;
const ROW_D = 0.78;

const GATE = 2.0;            // league gate opening

export const ARENA_META = {
  id: 'arena',
  displayName: 'Apex Arena',
  description: 'Championship night in a 150 m exhibition hall. League-size solid gates, ladder, dive tower, crowd.',
  accent: 'linear-gradient(160deg, #ff5a1f 0%, #7a1fa8 50%, #0b0f1e 100%)',
  category: 'Racing',
  size: '150 × 80 × 26 m hall',
  gates: 12,
  badge: 'NEW',
  courseKey: 'arena.v1',
  ambient: 'warehouse',
};

export class ArenaMap {
  constructor() {
    this.id = 'arena';
    this.spawnPoint = new THREE.Vector3(-1.5, 0.14, 64);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF_W - 2, -3, -HALF_L - 2),
      max: new THREE.Vector3(HALF_W + 2, ROOF_Y + 4, HALF_L + 2),
    };
    this.viewDistance = 420;
    this.link = { range: 160, indoor: true };
    this.environment = {
      mode: 'indoor',
      exposure: 1.0,
      envIntensity: 0.55,
      hemiIntensity: 0,
      sun: { direction: [0.16, 1, 0.1], color: 0xeef2ff, intensity: 3.2 },
      shadowRange: 88,
      shadowFocus: [0, 0, 0],
      probe: [0, 7, 20],
    };
    this.builder = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._dust = null;
    this._sweep = [];
  }

  getGroundHeight() {
    return 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 12001, name: 'arena-map', streaming: { cellSize: 32 } });
    this.builder = b;
    this._prevBackground = scene.background;
    this._prevFog = scene.fog;
    scene.background = new THREE.Color(0x05070c);
    scene.fog = new THREE.Fog(0x0b0e16, 90, 260);

    yield { progress: 0.04, label: 'Hall' };
    this._buildShell(b);
    yield { progress: 0.16, label: 'Roof trusses' };
    yield* this._buildRoof(b);
    yield { progress: 0.36, label: 'Grandstand' };
    yield* this._buildStands(b);
    yield { progress: 0.56, label: 'Pits' };
    this._buildPits(b);
    yield { progress: 0.66, label: 'Boards & nets' };
    this._buildBoards(b);
    yield { progress: 0.76, label: 'Course' };
    this._buildCourse(b);
    yield { progress: 0.9, label: 'Lighting' };
    this._buildLighting(b);
    b.finalizeShadows({ castMinRadius: 0.5 });
    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;
    const floorTex = b.tex(concreteTexture(12002, [22, 40]));
    const wallTex = b.tex(corrugatedMetalTexture(12003, [30, 6]));
    const steelTex = b.tex(paintedMetalTexture(12004, [2, 2], [44, 47, 54]));
    const standTex = b.tex(concreteTexture(12005, [30, 4]));
    this._mats = {
      floor: b.material('ar-floor', () => new THREE.MeshStandardMaterial({
        color: floorTex ? 0x9ea3a8 : 0x6c7075, map: floorTex, roughness: 0.34, metalness: 0.0,
      })),
      wall: b.material('ar-wall', () => new THREE.MeshStandardMaterial({
        color: wallTex ? 0x565b64 : 0x3a3e45, map: wallTex, roughness: 0.7, metalness: 0.4,
      })),
      steel: b.material('ar-steel', () => new THREE.MeshStandardMaterial({
        color: steelTex ? 0xffffff : 0x2b2e34, map: steelTex, roughness: 0.5, metalness: 0.7,
      })),
      dark: b.material('ar-dark', () => new THREE.MeshStandardMaterial({
        color: 0x14161b, roughness: 0.8, metalness: 0.2,
      })),
      stand: b.material('ar-stand', () => new THREE.MeshStandardMaterial({
        color: standTex ? 0x8d9096 : 0x6d7076, map: standTex, roughness: 0.9,
      })),
      seatA: b.material('ar-seat-a', () => new THREE.MeshStandardMaterial({ color: 0x1d3f8a, roughness: 0.6 })),
      seatB: b.material('ar-seat-b', () => new THREE.MeshStandardMaterial({ color: 0xc8401e, roughness: 0.6 })),
      led: b.material('ar-led', () => new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xf4f6ff, emissiveIntensity: 3.0, roughness: 0.4,
      })),
      ledMagenta: b.material('ar-led-m', () => new THREE.MeshStandardMaterial({
        color: 0xff3fd0, emissive: 0xff2fc8, emissiveIntensity: 2.4, roughness: 0.4,
      })),
      ledCyan: b.material('ar-led-c', () => new THREE.MeshStandardMaterial({
        color: 0x3fe8ff, emissive: 0x2fd8ff, emissiveIntensity: 2.4, roughness: 0.4,
      })),
      net: b.material('ar-net', () => {
        const t = b.tex(netTexture(12006, [60, 4]));
        return new THREE.MeshStandardMaterial({
          color: 0x202226, map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9,
          transparent: !t, opacity: t ? 1 : 0.15,
        });
      }),
      table: b.material('ar-table', () => new THREE.MeshStandardMaterial({ color: 0xd9dade, roughness: 0.5 })),
      tent: b.material('ar-tent', () => {
        const t = b.tex(fabricTexture(12007, [2, 2], [210, 70, 34]));
        return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0xd24622, map: t, roughness: 0.9, side: THREE.DoubleSide });
      }),
    };
    return this._mats;
  }

  /* ---------------------------------------------------------------------- *
   * Shell
   * ---------------------------------------------------------------------- */

  _buildShell(b) {
    const m = this._materials(b);
    b.floor({ width: HALL_W, depth: HALL_L, material: m.floor });

    // Walls, full height to the roof deck.
    const wallH = ROOF_Y;
    b.box({ size: [WALL_T, wallH, HALL_L], position: [-HALF_W, wallH / 2, 0], material: m.wall });
    b.box({ size: [WALL_T, wallH, HALL_L], position: [HALF_W, wallH / 2, 0], material: m.wall });
    b.box({ size: [HALL_W, wallH, WALL_T], position: [0, wallH / 2, -HALF_L], material: m.wall });
    b.box({ size: [HALL_W, wallH, WALL_T], position: [0, wallH / 2, HALF_L], material: m.wall });

    // Closed loading doors (dark insets) — scale cues on the end walls.
    for (const z of [-HALF_L + 0.25, HALF_L - 0.25]) {
      for (const x of [-22, 0, 22]) {
        b.box({ size: [9, 8, 0.1], position: [x, 4, z], material: m.dark, collide: false });
      }
    }

    // Roof deck (excluded from the shadow pass: it would block the rig wash).
    const roof = b.box({ size: [HALL_W, 0.4, HALL_L], position: [0, ROOF_Y + 0.2, 0], material: m.dark });
    roof.userData.noCastShadow = true;
    // Walls also stay out of the caster set for the same reason.
    b.root.traverse((o) => { if (o.isMesh && o.material === m.wall) o.userData.noCastShadow = true; });
  }

  /* ---------------------------------------------------------------------- *
   * Roof: trusses every 10 m, LED rigs, video walls
   * ---------------------------------------------------------------------- */

  *_buildRoof(b) {
    const m = this._materials(b);
    const parts = [];
    for (let z = -HALF_L + 5; z <= HALF_L - 5; z += 10) {
      parts.push({ size: [HALL_W - 1, 0.35, 0.35], position: [0, HALL_H, z] });
      parts.push({ size: [HALL_W - 1, 0.3, 0.3], position: [0, ROOF_Y - 0.35, z] });
      const bays = 16;
      const bw = (HALL_W - 1) / bays;
      for (let i = 0; i < bays; i++) {
        const x0 = -(HALL_W - 1) / 2 + i * bw;
        const up = i % 2 === 0;
        parts.push(MapBuilder.beamPart(
          [x0, up ? HALL_H : ROOF_Y - 0.35, z], [x0 + bw, up ? ROOF_Y - 0.35 : HALL_H, z], 0.14,
        ));
        parts.push({ size: [0.12, ROOF_Y - 0.35 - HALL_H, 0.12], position: [x0, (HALL_H + ROOF_Y - 0.35) / 2, z] });
      }
      // Bottom chord is solid — the one truss member a climb-out can reach.
      b.boxBody({ size: [HALL_W - 1, 0.4, 0.4], position: [0, HALL_H, z] });
      yield { progress: 0.16 + 0.12 * ((z + HALF_L) / HALL_L), label: 'Roof trusses' };
    }
    for (let x = -HALF_W + 4; x <= HALF_W - 4; x += 6) {
      parts.push({ size: [0.16, 0.16, HALL_L - 2], position: [x, ROOF_Y - 0.1, 0] });
    }
    const truss = b.mergeStatic(parts, m.steel, { name: 'arena-truss' });
    if (truss) truss.userData.noCastShadow = true;

    // LED light rigs: rectangular truss frames at 17 m carrying fixture rows.
    const rigs = [];
    const fixtures = [];
    for (const rz of [-45, -15, 15, 45]) {
      for (const rx of [-14, 14]) {
        const w = 18;
        const d = 12;
        const y = 17;
        rigs.push({ size: [w, 0.4, 0.4], position: [rx, y, rz - d / 2] });
        rigs.push({ size: [w, 0.4, 0.4], position: [rx, y, rz + d / 2] });
        rigs.push({ size: [0.4, 0.4, d], position: [rx - w / 2, y, rz] });
        rigs.push({ size: [0.4, 0.4, d], position: [rx + w / 2, y, rz] });
        // Chain hoists up to the truss.
        for (const [hx, hz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
          rigs.push({ size: [0.05, HALL_H - y, 0.05], position: [rx + hx, (HALL_H + y) / 2, rz + hz] });
        }
        for (let i = 0; i < 6; i++) {
          fixtures.push({ size: [0.7, 0.28, 0.7], position: [rx - w / 2 + 1.5 + i * 3, y - 0.35, rz - d / 2] });
          fixtures.push({ size: [0.7, 0.28, 0.7], position: [rx - w / 2 + 1.5 + i * 3, y - 0.35, rz + d / 2] });
        }
      }
    }
    const rigMesh = b.mergeStatic(rigs, m.steel, { name: 'arena-rigs' });
    if (rigMesh) rigMesh.userData.noCastShadow = true;
    const fixMesh = b.mergeStatic(fixtures, m.led, { name: 'arena-fixtures' });
    if (fixMesh) fixMesh.userData.noCastShadow = true;
    // Rig frames are solid (they hang at 17 m — a high gate line passes near).
    for (const r of rigs) if (r.size[1] < 1) b.boxBody({ size: r.size, position: r.position });

    // Video walls over each end of the course.
    const screenTex = b.tex(bannerTexture(12010, 'APEX ARENA', '#060912', '#ffffff', '#ff5a1f'));
    const screenMat = b.material('ar-screen', () => new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: screenTex ? 1.4 : 0.2,
      roughness: 0.3,
    }));
    for (const [z, ry] of [[-HALF_L + 5, 0], [HALF_L - 5, Math.PI]]) {
      const frame = b.box({ size: [24.6, 7.0, 0.5], position: [0, 18.5, z], material: m.dark });
      frame.userData.noCastShadow = true;
      const screen = new THREE.Mesh(b.geometry('ar-screen', () => new THREE.PlaneGeometry(24, 6.2)), screenMat);
      screen.position.set(0, 18.5, z + (ry === 0 ? 0.26 : -0.26));
      screen.rotation.y = ry;
      b.root.add(screen);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Grandstand + crowd
   * ---------------------------------------------------------------------- */

  *_buildStands(b) {
    const m = this._materials(b);
    const zLen = 96;
    for (let r = 0; r < STAND_ROWS; r++) {
      const top = (r + 1) * ROW_H;
      const x = STAND_X0 + r * ROW_D + ROW_D / 2;
      b.box({ size: [ROW_D, top, zLen], position: [x, top / 2, 0], material: m.stand });
      // Seat band on each tread.
      b.box({
        size: [ROW_D * 0.45, 0.42, zLen - 1], position: [x + ROW_D * 0.2, top + 0.21, 0],
        material: r % 4 < 2 ? m.seatA : m.seatB, collide: false,
      });
    }
    // Back wall + side walls of the stand.
    const backX = STAND_X0 + STAND_ROWS * ROW_D + 0.25;
    b.box({ size: [0.5, STAND_ROWS * ROW_H + 2.5, zLen], position: [backX, (STAND_ROWS * ROW_H + 2.5) / 2, 0], material: m.stand });
    for (const sz of [-1, 1]) {
      b.box({
        size: [STAND_ROWS * ROW_D, STAND_ROWS * ROW_H + 1.2, 0.5],
        position: [STAND_X0 + (STAND_ROWS * ROW_D) / 2, (STAND_ROWS * ROW_H + 1.2) / 2, sz * zLen / 2],
        material: m.stand,
      });
    }
    // Front parapet.
    b.box({ size: [0.3, 1.1, zLen], position: [STAND_X0 - 0.15, 0.55, 0], material: m.dark });
    yield { progress: 0.44, label: 'Crowd' };

    // Crowd: capsule bodies + heads, one draw call each, instance-coloured.
    const bodyGeo = b.geometry('ar-person', () => new THREE.CapsuleGeometry(0.21, 0.5, 3, 7));
    const headGeo = b.geometry('ar-head', () => new THREE.SphereGeometry(0.11, 8, 6));
    const bodies = [];
    const heads = [];
    for (let r = 0; r < STAND_ROWS; r++) {
      const x = STAND_X0 + r * ROW_D + ROW_D * 0.62;
      const y = (r + 1) * ROW_H + 0.42;
      for (let z = -zLen / 2 + 1; z < zLen / 2 - 1; z += 0.62) {
        if (b.rng() > 0.52) continue;
        const jz = z + rnd(b, -0.08, 0.08);
        const stand = b.rng() < 0.25 ? 0.28 : 0;
        bodies.push({ position: [x, y + 0.2 + stand, jz], rotationY: rnd(b, -0.4, 0.4) - Math.PI / 2 });
        heads.push({ position: [x - 0.03, y + 0.72 + stand, jz] });
      }
    }
    const crowdMat = b.material('ar-crowd', () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }));
    const skinMat = b.material('ar-skin', () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }));
    const shirts = [0xe63946, 0x1d3557, 0xf1faee, 0xffb703, 0x2a9d8f, 0x222222, 0x8338ec, 0xfb5607, 0x3a86ff, 0x6c757d];
    const skins = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
    const bm = b.instanced(bodyGeo, crowdMat, bodies);
    const hm = b.instanced(headGeo, skinMat, heads);
    const col = new THREE.Color();
    if (bm) {
      for (let i = 0; i < bodies.length; i++) bm.setColorAt(i, col.set(shirts[Math.floor(b.rng() * shirts.length)]));
      bm.instanceColor.needsUpdate = true;
    }
    if (hm) {
      for (let i = 0; i < heads.length; i++) hm.setColorAt(i, col.set(skins[Math.floor(b.rng() * skins.length)]));
      hm.instanceColor.needsUpdate = true;
    }
    this._crowd = bm;
    this._crowdCount = bodies.length;

    // Safety net in front of the stand, floor to 8 m. Soft collider.
    const netH = 8;
    const net = new THREE.Mesh(b.geometry('ar-net-stand', () => new THREE.PlaneGeometry(zLen + 4, netH)), m.net);
    net.position.set(STAND_X0 - 1.2, netH / 2, 0);
    net.rotation.y = Math.PI / 2;
    b.root.add(net);
    b.boxBody({ size: [0.1, netH, zLen + 4], position: [STAND_X0 - 1.2, netH / 2, 0], surface: 'soft' });
    for (let z = -zLen / 2 - 2; z <= zLen / 2 + 2; z += 8) {
      b.box({ size: [0.14, netH, 0.14], position: [STAND_X0 - 1.2, netH / 2, z], material: m.steel });
    }
    yield { progress: 0.54, label: 'Crowd' };
  }

  /* ---------------------------------------------------------------------- *
   * Pilots' stand and pit tents (west side)
   * ---------------------------------------------------------------------- */

  _buildPits(b) {
    const m = this._materials(b);
    // Raised pilots' stand: deck, rail, six chairs and a timing screen.
    const px = -35;
    b.box({ size: [6, 1.2, 22], position: [px, 0.6, 20], material: m.dark });
    b.box({ size: [0.1, 1.0, 22], position: [px + 3, 1.7, 20], material: m.steel });
    for (let i = 0; i < 6; i++) {
      const z = 11 + i * 3.6;
      b.box({ size: [0.5, 0.5, 0.5], position: [px - 0.4, 1.45, z], material: m.dark, collide: false });
      b.box({ size: [0.08, 0.6, 0.5], position: [px - 0.66, 1.9, z], material: m.dark, collide: false });
    }
    // Stairs up to the deck.
    for (let i = 0; i < 5; i++) {
      b.box({ size: [1.4, 0.24, 0.36], position: [px + 1.5, 0.12 + i * 0.24, 31.4 + (4 - i) * 0.36], material: m.steel });
    }

    // Pit tents: 3 x 3 m pop-ups with tables.
    const canopyGeo = b.geometry('ar-canopy', () => {
      const g = new THREE.ConeGeometry(2.25, 0.8, 4, 1, true);
      g.rotateY(Math.PI / 4);
      return g;
    });
    for (let i = 0; i < 6; i++) {
      const z = -48 + i * 9;
      const x = -33.5;
      for (const [lx, lz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
        b.box({ size: [0.05, 2.4, 0.05], position: [x + lx, 1.2, z + lz], material: m.steel });
      }
      const canopy = new THREE.Mesh(canopyGeo, m.tent);
      canopy.position.set(x, 2.8, z);
      b.root.add(canopy);
      b.boxBody({ size: [3.1, 0.5, 3.1], position: [x, 2.65, z], surface: 'soft' });
      b.box({ size: [2.2, 0.05, 0.8], position: [x, 0.75, z - 0.6], material: m.table });
      b.box({ size: [2.1, 0.7, 0.05], position: [x, 0.37, z - 0.95], material: m.table, collide: false });
      // Cases and chargers on the table.
      b.box({ size: [0.5, 0.18, 0.35], position: [x - 0.5, 0.87, z - 0.6], material: m.dark, collide: false });
      b.box({ size: [0.3, 0.12, 0.2], position: [x + 0.5, 0.84, z - 0.55], material: m.dark, collide: false });
    }
  }

  /* ---------------------------------------------------------------------- *
   * LED boards around the circuit + end nets
   * ---------------------------------------------------------------------- */

  _buildBoards(b) {
    const m = this._materials(b);
    const names = ['APEX FPV', 'SKYLINE CUP', 'VOLT MOTORS', 'KESTREL PROPS', 'NIGHTSHIFT'];
    const accents = ['#ff5a1f', '#2fd8ff', '#ffd23f', '#ff2fc8', '#27ff9e'];
    const mats = names.map((n, i) => b.material(`ar-board-${i}`, () => {
      const t = b.tex(bannerTexture(12020 + i, n, '#0a0d16', '#ffffff', accents[i]));
      return new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: t ? 0.9 : 0.1, roughness: 0.4,
      });
    }));
    const boardGeo = b.geometry('ar-board', () => new THREE.BoxGeometry(4, 1, 0.12));
    // West run (course side of the pits) and the two ends.
    let k = 0;
    const put = (x, z, ry) => {
      const mesh = new THREE.Mesh(boardGeo, mats[k++ % mats.length]);
      mesh.position.set(x, 0.5, z);
      mesh.rotation.y = ry;
      b.root.add(mesh);
      b.boxBody({ size: [4, 1, 0.12], position: [x, 0.5, z], rotationY: ry });
    };
    for (let z = -64; z <= 64; z += 4.2) put(-29, z, Math.PI / 2);
    for (let x = -26; x <= 24; x += 4.2) put(x, -69, 0);

    // Net curtains behind the far turn (north) so an overshoot is caught.
    const netH = 12;
    const endNet = new THREE.Mesh(b.geometry('ar-net-end', () => new THREE.PlaneGeometry(HALL_W - 2, netH)), m.net);
    endNet.position.set(0, netH / 2, -71);
    b.root.add(endNet);
    b.boxBody({ size: [HALL_W - 2, netH, 0.1], position: [0, netH / 2, -71], surface: 'soft' });
  }

  /* ---------------------------------------------------------------------- *
   * The course
   * ---------------------------------------------------------------------- */

  _buildCourse(b) {
    const m = this._materials(b);

    // Launch pads at the start.
    ['1', '2', '3', '4'].forEach((label, i) => {
      const t = b.tex(launchPadTexture(12030 + i, label, ['#e8452c', '#2f7dff', '#ffd23f', '#27ff9e'][i]));
      const mat = b.material(`ar-pad-${i}`, () => new THREE.MeshStandardMaterial({
        color: t ? 0xffffff : 0x333333, map: t, roughness: 0.9,
      }));
      b.box({ size: [1.2, 0.03, 1.2], position: [-4.5 + i * 3, 0.015, 64], material: mat, collide: false });
    });

    const pads = ['#f25c05', '#16181c'];
    const layout = [
      { x: 0, y: 1.45, z: 50 },                                           // 1 start straight
      { x: -5, y: 1.45, z: 34 },                                          // 2 double gate...
      { x: -5, y: 1.45, z: 30 },                                          // 3 ...second half
      { x: -21, y: 6.35, z: 10, legs: false },                            // 4 ladder, top rung
      { x: -18, y: 8.2, z: -24, style: 'dive', w: 2.6 },                  // 5 dive tower
      { x: -6, y: 1.45, z: -46 },                                         // 6 low gate
      { x: 12, y: 2.0, z: -62, w: 3.2, h: 3.0, colors: ['#2fd8ff', '#101624'] }, // 7 far-turn arch
      { x: 22, y: 1.45, z: -38 },                                         // 8 after the slalom
      { x: 22, y: 7.45, z: -10 },                                         // 9 high gate on scaffold
      { x: 12, y: 1.45, z: 16 },                                          // 10 dive back down
      { x: 17, y: 1.45, z: 38 },                                          // 11 over the hurdle
      { x: 5, y: 2.0, z: 56, w: 3.2, h: 3.0, colors: ['#27ff9e', '#101624'] },   // 12 finish arch
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: GATE, padColors: pads, beaconHeight: 9,
    });

    // Ladder: two lower rungs under gate 4 on shared uprights (decoys — only
    // the top opening scores).
    const g4 = this.gates[3];
    const yaw = Math.atan2(g4.normal.x, g4.normal.z);
    for (const [k, y] of [[0, 1.45], [1, 3.9]]) {
      b.gate({
        position: [g4.position.x, y, g4.position.z], rotationY: yaw, style: 'square',
        width: GATE, index: 100 + k, legs: k === 0, padColors: pads,
      });
    }

    // Ladder uprights: one post each side, floor to above the top rung.
    for (const sgn of [-1, 1]) {
      const off = GATE / 2 + 0.24;
      b.box({
        size: [0.1, 7.6, 0.1],
        position: [g4.position.x + g4.right.x * off * sgn, 3.8, g4.position.z + g4.right.z * off * sgn],
        material: m.steel,
      });
    }

    // Dive tower: scaffold braces on three faces; the north face stays open
    // as the exit after the dive.
    const g5 = this.gates[4];
    const half = 2.6 / 2 + 0.2;
    const top = g5.position.y - 0.2;
    const cx = g5.position.x;
    const cz = g5.position.z;
    for (const [ax, az, bx, bz] of [
      [-half, half, half, half],      // south face
      [-half, -half, -half, half],    // west face
      [half, -half, half, half],      // east face
    ]) {
      b.beam({ from: [cx + ax, 0.2, cz + az], to: [cx + bx, top, cz + bz], width: 0.06, material: m.steel });
      b.beam({ from: [cx + bx, 0.2, cz + bz], to: [cx + ax, top, cz + az], width: 0.06, material: m.steel });
      b.beam({ from: [cx + ax, top * 0.5, cz + az], to: [cx + bx, top * 0.5, cz + bz], width: 0.06, material: m.steel });
    }

    // High-gate scaffold (gate 9): cross braces between its legs.
    const g9 = this.gates[8];
    const r9 = g9.right;
    const w9 = GATE / 2 + 0.16;
    const legTop = g9.position.y - GATE / 2 - 0.3;
    const la = [g9.position.x - r9.x * w9, g9.position.z - r9.z * w9];
    const lb = [g9.position.x + r9.x * w9, g9.position.z + r9.z * w9];
    b.beam({ from: [la[0], 0.2, la[1]], to: [lb[0], legTop, lb[1]], width: 0.06, material: m.steel });
    b.beam({ from: [lb[0], 0.2, lb[1]], to: [la[0], legTop, la[1]], width: 0.06, material: m.steel });

    // Flag slalom between the far-turn arch and gate 8.
    const a7 = this.gates[6].position;
    const a8 = this.gates[7].position;
    const flagCols = ['#ff3d3d', '#ffd23f', '#ff3d3d'];
    for (let i = 0; i < 3; i++) {
      const t = 0.3 + i * 0.2;
      const px = a7.x + (a8.x - a7.x) * t;
      const pz = a7.z + (a8.z - a7.z) * t;
      const side = i % 2 === 0 ? 1.1 : -1.1;
      b.flag({ position: [px + side, 0, pz], color: flagCols[i], height: 3.4 });
    }

    // Hurdle between gates 10 and 11: padded bar at 1.1 m, fly over it.
    const a10 = this.gates[9].position;
    const a11 = this.gates[10].position;
    const hx = (a10.x + a11.x) / 2;
    const hz = (a10.z + a11.z) / 2;
    const hyaw = Math.atan2(a11.x - a10.x, a11.z - a10.z);
    const padMat = b.material('ar-hurdle', () => new THREE.MeshStandardMaterial({ color: 0xf25c05, roughness: 0.8 }));
    b.box({ size: [4, 0.22, 0.22], position: [hx, 1.1, hz], rotationY: hyaw, material: padMat, surface: 'soft' });
    for (const s of [-1, 1]) {
      const ox = Math.cos(hyaw) * 2 * s;
      const oz = -Math.sin(hyaw) * 2 * s;
      b.box({ size: [0.07, 1.1, 0.07], position: [hx + ox, 0.55, hz + oz], material: m.steel });
    }

    // Course-side marker flags along the long straights (visual rhythm).
    for (let z = -30; z <= 40; z += 14) b.flag({ position: [-26, 0, z], color: '#2fd8ff', height: 3.0 });
  }

  /* ---------------------------------------------------------------------- *
   * Lighting
   * ---------------------------------------------------------------------- */

  _buildLighting(b) {
    const m = this._materials(b);
    b.addLight(new THREE.HemisphereLight(0x8a9cc4, 0x2a2c32, 0.9));

    // Coloured washes on the long walls — the "event" look.
    const washes = [
      [-38, 8, -40, 0xff2fc8], [-38, 8, 30, 0x2fd8ff],
      [38, 12, -55, 0x2fd8ff], [0, 10, -72, 0xff2fc8],
    ];
    for (const [x, y, z, c] of washes) {
      const l = new THREE.PointLight(c, 260, 70, 2);
      l.position.set(x, y, z);
      b.addLight(l);
    }
    // Pilots' stand and pits: warm work light.
    const pits = new THREE.PointLight(0xffd9a8, 120, 40, 2);
    pits.position.set(-33, 6, 0);
    b.addLight(pits);

    // LED strips along the walls at 4 m (emissive, no light cost).
    const strips = [];
    for (const x of [-HALF_W + 0.25, HALF_W - 0.25]) {
      strips.push({ size: [0.1, 0.12, HALL_L - 2], position: [x, 4, 0] });
    }
    const sm = b.mergeStatic(strips.slice(0, 1), m.ledMagenta, { name: 'ar-strip-w' });
    const sc = b.mergeStatic(strips.slice(1), m.ledCyan, { name: 'ar-strip-e' });
    for (const s of [sm, sc]) if (s) s.userData.noCastShadow = true;

    // Haze: sparse motes that catch the rig light.
    this._dust = b.dustCloud({
      count: 700, area: [HALL_W - 4, 18, HALL_L - 4], center: [0, 9.5, 0],
      color: 0xd0d8ff, size: 0.07, opacity: 0.45, seed: 12099,
    });
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  update(dt, elapsed) {
    if (this._dust) {
      try { this._dust.update(dt, elapsed); } catch (_e) { /* ignore */ }
    }
  }

  updatePropwash(pos, motor) {
    if (!pos || !this._dust) return;
    try {
      this._dust.kick(pos.x, pos.y, pos.z, 2.4, 0.3 + (Number.isFinite(motor) ? motor : 0) * 1.4);
    } catch (_e) { /* ignore */ }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._dust = null;
    this._crowd = null;
    this.gates = [];
    scene.background = this._prevBackground ?? null;
    scene.fog = this._prevFog ?? null;
  }
}
