/**
 * maps/HouseMap.js
 * ---------------------------------------------------------------------------
 * Indoor House — a two-storey family home, the "learn your throttle" map.
 *
 * 36 x 28 m, two floors (3.2 m + 3.0 m ceilings) around a double-height great
 * room with an open stair and a gallery landing — about 11x the volume of the
 * old 15 x 15 m bungalow. Ground floor: garage, kitchen with island, dining,
 * hall, study, laundry, bathroom and a glass sunroom. Upstairs: two bedrooms,
 * a third bedroom, a bathroom and the gallery. Real windows (glass, solid)
 * look out onto a garden; the sun comes in through them with real shadows.
 *
 * The signature is still the **gap dive**: both bathroom doors are 0.62 m
 * wide. A 250 mm quad fits with room to spare in principle and almost none in
 * practice.
 *
 * Walls are built by `_wallRun`, which takes a start and end point plus a list
 * of openings and emits the boxes needed to leave the holes — floor plans this
 * fiddly stay readable that way.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import {
  plasterTexture, woodPlankTexture, tileTexture, fabricTexture,
  paintedMetalTexture, crateWoodTexture, artTexture, foliageTexture,
  grassTexture, concreteTexture,
} from '../assets/procedural.js';

const HX = 18;             // half extents of the footprint
const HZ = 14;
const G_CEIL = 3.2;        // ground-floor ceiling
const UP_Y = 3.5;          // upper floor level (slab top)
const U_CEIL = 6.5;        // upper ceiling / roof underside
const WALL_T = 0.14;
const DOOR = 0.95;
const GAP = 0.62;          // the gap-dive doors
const SUN = [-0.45, 0.62, 0.55];   // late-afternoon sun from the south-west

export const HOUSE_META = {
  id: 'house',
  displayName: 'Indoor House',
  description: 'Two-storey home: great room with gallery, open stair, sunroom, and two 0.62 m bathroom doors.',
  accent: 'linear-gradient(160deg, #d9c4a3 0%, #b08a5f 50%, #6b4c33 100%)',
  category: 'Technical',
  size: '36 × 28 m, two floors',
  gates: 12,
  courseKey: 'house.v2',
  ambient: 'house',
};

export class HouseMap {
  constructor() {
    this.id = 'house';
    // Spawn in the garage, nose pointed north toward the kitchen door.
    this.spawnPoint = new THREE.Vector3(-11.5, 0.12, 12.2);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HX - 12, -2, -HZ - 12),
      max: new THREE.Vector3(HX + 12, U_CEIL + 8, HZ + 12),
    };
    this.viewDistance = 300;
    this.link = { range: 45, indoor: true };
    this.environment = {
      mode: 'indoor',
      exposure: 1.0,
      envIntensity: 0.7,
      hemiIntensity: 0,
      sun: { direction: SUN, color: 0xffe2bc, intensity: 3.2 },
      shadowRange: 34,
      shadowFocus: [0, 0, 0],
      probe: [3, 2.4, 6],
    };
    this.builder = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._flicker = null;
    this._dust = null;
  }

  getGroundHeight() {
    return 0;
  }

  /* ====================================================================== *
   * Build
   * ====================================================================== */

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 1701, name: 'house-map', streaming: { cellSize: 16 } });
    this.builder = b;
    this._prevBackground = scene.background;
    this._prevFog = scene.fog;
    scene.background = new THREE.Color(0x9ec3e6);
    scene.fog = new THREE.Fog(0xb9d2e8, 40, 140);

    yield { progress: 0.05, label: 'Garden' };
    this._buildGarden(b);
    yield { progress: 0.12, label: 'Floors & roof' };
    this._buildSlabs(b);
    yield { progress: 0.22, label: 'Walls' };
    this._buildGroundWalls(b);
    this._buildUpperWalls(b);
    yield { progress: 0.4, label: 'Stair & gallery' };
    this._buildStair(b);
    yield { progress: 0.48, label: 'Kitchen & dining' };
    this._buildKitchen(b);
    yield { progress: 0.56, label: 'Great room' };
    this._buildGreatRoom(b);
    yield { progress: 0.64, label: 'Garage & study' };
    this._buildGarage(b);
    this._buildStudy(b);
    yield { progress: 0.72, label: 'Baths & sunroom' };
    this._buildWetRooms(b);
    this._buildSunroom(b);
    yield { progress: 0.8, label: 'Bedrooms' };
    this._buildBedrooms(b);
    yield { progress: 0.88, label: 'Lighting' };
    this._buildLighting(b);
    yield { progress: 0.94, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.35 });
    yield { progress: 1, label: 'Ready' };
  }

  /* ---------------------------------------------------------------------- *
   * Materials
   * ---------------------------------------------------------------------- */

  _materials(b) {
    if (this._mats) return this._mats;
    const wallTex = b.tex(plasterTexture(1101, [8, 1.5]));
    const floorTex = b.tex(woodPlankTexture(1102, [16, 12], 'warm'));
    const upFloorTex = b.tex(woodPlankTexture(1105, [16, 12], 'light'));
    const tileTex = b.tex(tileTexture(1103, [6, 6]));
    const ceilTex = b.tex(plasterTexture(1104, [10, 10]));
    this._mats = {
      wall: b.material('wall', () => new THREE.MeshStandardMaterial({
        color: wallTex ? 0xffffff : 0xe4ddd0, map: wallTex, roughness: 0.95,
      })),
      floor: b.material('floor', () => new THREE.MeshStandardMaterial({
        color: floorTex ? 0xffffff : 0x8a6038, map: floorTex, roughness: 0.55,
      })),
      upFloor: b.material('up-floor', () => new THREE.MeshStandardMaterial({
        color: upFloorTex ? 0xffffff : 0xa47850, map: upFloorTex, roughness: 0.6,
      })),
      tile: b.material('tile', () => new THREE.MeshStandardMaterial({
        color: tileTex ? 0xffffff : 0xe6e6e2, map: tileTex, roughness: 0.3,
      })),
      ceiling: b.material('ceiling', () => new THREE.MeshStandardMaterial({
        color: ceilTex ? 0xf4f1ea : 0xf2efe8, map: ceilTex, roughness: 1,
      })),
      wood: b.material('wood-dark', () => new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.6 })),
      woodLight: b.material('wood-light', () => new THREE.MeshStandardMaterial({ color: 0xa8865c, roughness: 0.65 })),
      white: b.material('white', () => new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.5 })),
      glass: b.material('glass', () => new THREE.MeshStandardMaterial({
        color: 0xd6ebf2, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false,
      })),
      frame: b.material('window-frame', () => new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4 })),
      steel: b.material('steel', () => new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.28, metalness: 0.85 })),
      dark: b.material('dark', () => new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.6 })),
      porcelain: b.material('porcelain', () => new THREE.MeshStandardMaterial({ color: 0xf2f4f3, roughness: 0.18 })),
    };
    return this._mats;
  }

  _fabric(b, key, seed, rgb) {
    return b.material(key, () => {
      const t = b.tex(fabricTexture(seed, [2, 2], rgb));
      return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255), map: t, roughness: 1 });
    });
  }

  /* ---------------------------------------------------------------------- *
   * Garden outside the glass
   * ---------------------------------------------------------------------- */

  _buildGarden(b) {
    const m = this._materials(b);
    const grassTex = b.tex(grassTexture(1110, [40, 40]));
    const lawn = b.material('lawn', () => new THREE.MeshStandardMaterial({
      color: grassTex ? 0xffffff : 0x5e8a3e, map: grassTex, roughness: 0.95,
    }));
    b.floor({ width: 100, depth: 100, y: -0.02, material: lawn });
    const pathTex = b.tex(concreteTexture(1111, [2, 8]));
    const path = b.material('path', () => new THREE.MeshStandardMaterial({ color: pathTex ? 0xd8d2c6 : 0xb0a898, map: pathTex, roughness: 0.9 }));
    b.box({ size: [6, 0.04, 10], position: [-13, 0.0, HZ + 5.2], material: path, collide: false });   // driveway
    b.box({ size: [2.2, 0.04, 8], position: [4, 0.0, HZ + 4.2], material: path, collide: false });

    // Hedges and a boundary fence.
    const hedgeMat = b.material('hedge', () => {
      const t = b.tex(foliageTexture(1112, [6, 1]));
      return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0x3f6b30, map: t, roughness: 0.95 });
    });
    for (const [x, z, w, d] of [[0, -HZ - 8, 60, 1.2], [HX + 10, 0, 1.2, 44], [-HX - 10, 0, 1.2, 44]]) {
      b.box({ size: [w, 1.6, d], position: [x, 0.8, z], material: hedgeMat, surface: 'soft' });
    }
    // Garden trees (trunk + crown), visible through the sunroom glass.
    const crown = b.geometry('house-crown', () => new THREE.IcosahedronGeometry(2.2, 1));
    const crowns = [];
    for (const [x, z, s] of [[HX + 6, -8, 1.1], [HX + 7, 6, 1.3], [-6, -HZ - 5, 1.0], [8, -HZ - 5.5, 1.2]]) {
      b.cylinder({ radiusTop: 0.16 * s, radiusBottom: 0.24 * s, height: 3.2 * s, segments: 7, position: [x, 1.6 * s, z], material: m.wood });
      crowns.push({ position: [x, 3.2 * s + 1.4 * s, z], scale: s });
      b.sphereBody({ radius: 2.0 * s, position: [x, 4.6 * s, z], surface: 'soft' });
    }
    b.instanced(crown, hedgeMat, crowns);
  }

  /* ---------------------------------------------------------------------- *
   * Slabs: ground floor, upper floor (with the great-room void), roof
   * ---------------------------------------------------------------------- */

  _buildSlabs(b) {
    const m = this._materials(b);
    b.box({ size: [HX * 2, 0.1, HZ * 2], position: [0, -0.05, 0], material: m.floor });
    // Upper slab: west block + hall (x -18..-4) and the north strip (x -4..12, z -14..1).
    const slabs = [
      { size: [14, 0.3, HZ * 2], position: [-11, (G_CEIL + UP_Y) / 2, 0] },
      { size: [16, 0.3, 15], position: [4, (G_CEIL + UP_Y) / 2, -6.5] },
    ];
    for (const s of slabs) {
      // Wood on top, plaster ceiling underneath.
      b.box({ size: [s.size[0], 0.02, s.size[2]], position: [s.position[0], UP_Y - 0.01, s.position[2]], material: m.upFloor, collide: false });
      b.box({ size: [s.size[0], 0.28, s.size[2]], position: [s.position[0], s.position[1] - 0.01, s.position[2]], material: m.ceiling });
    }
    // Ground-floor ceiling over the sunroom is glass.
    b.box({ size: [6, 0.08, HZ * 2], position: [15, G_CEIL + 0.1, 0], material: m.glass, surface: 'hard' });
    for (let z = -HZ; z <= HZ; z += 3.5) b.box({ size: [6, 0.1, 0.08], position: [15, G_CEIL + 0.02, z], material: m.frame, collide: false });

    // Roof over the two-storey block.
    const roof = b.box({ size: [30.4, 0.3, HZ * 2 + 0.4], position: [-3, U_CEIL + 0.15, 0], material: m.ceiling });
    roof.userData.roof = true;
  }

  /* ---------------------------------------------------------------------- *
   * Walls
   * ---------------------------------------------------------------------- */

  /**
   * A straight, axis-aligned wall with openings, on a floor at `y0`.
   * `doors` entries are `{ at, width, sill?, head? }`, `at` measured from the
   * (x1,z1) end. A sill makes it a window: the wall continues underneath and
   * a glass pane (solid) fills the hole.
   */
  _wallRun(b, x1, z1, x2, z2, doors = [], y0 = 0, height = G_CEIL, material = null) {
    const m = this._materials(b);
    const mat = material || m.wall;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) return;
    const ux = dx / length;
    const uz = dz / length;
    const horizontal = Math.abs(ux) > Math.abs(uz);

    const openings = doors
      .map((d) => ({
        start: Math.max(0, d.at - d.width / 2),
        end: Math.min(length, d.at + d.width / 2),
        sill: d.sill ?? 0,
        head: Math.min(d.head ?? 2.1, height),
      }))
      .filter((d) => d.end > d.start)
      .sort((a, c) => a.start - c.start);

    const segment = (from, to, ya, yb) => {
      const len = to - from;
      const h = yb - ya;
      if (len <= 0.001 || h <= 0.001) return;
      const mid = (from + to) / 2;
      b.box({
        size: horizontal ? [len, h, WALL_T] : [WALL_T, h, len],
        position: [x1 + ux * mid, y0 + (ya + yb) / 2, z1 + uz * mid],
        material: mat,
      });
    };

    let cursor = 0;
    for (const o of openings) {
      segment(cursor, o.start, 0, height);
      if (o.sill > 0) {
        segment(o.start, o.end, 0, o.sill);
        // Glass pane + frame. Solid: windows stop quads, as they do in life.
        const len = o.end - o.start;
        const mid = (o.start + o.end) / 2;
        const cx = x1 + ux * mid;
        const cz = z1 + uz * mid;
        const h = o.head - o.sill;
        b.box({
          size: horizontal ? [len, h, 0.02] : [0.02, h, len],
          position: [cx, y0 + o.sill + h / 2, cz], material: m.glass,
        });
        b.box({
          size: horizontal ? [len, 0.06, WALL_T + 0.04] : [WALL_T + 0.04, 0.06, len],
          position: [cx, y0 + o.sill + 0.03, cz], material: m.frame, collide: false,
        });
      }
      segment(o.start, o.end, o.head, height);
      cursor = o.end;
    }
    segment(cursor, length, 0, height);
  }

  _buildGroundWalls(b) {
    const W = (at, width = 2.0) => ({ at, width, sill: 0.9, head: 2.4 });
    const D = (at, width = DOOR) => ({ at, width });

    // Exterior (ground floor). North wall x -18..12 (the sunroom's is glass).
    this._wallRun(b, -HX, -HZ, 12, -HZ, [W(3), W(7), W(18, 2.4), W(28, 1.6)]);
    // South wall: great-room glazing (the garage bay is built below).
    this._wallRun(b, -8, HZ, 12, HZ, [W(10, 3), W(16, 3)]);
    // West wall: dining and kitchen windows.
    this._wallRun(b, -HX, -HZ, -HX, HZ, [W(4), W(13)]);

    // Interior.
    this._wallRun(b, -8, -HZ, -8, HZ, [D(3), D(13), D(23)]);           // hall west wall
    this._wallRun(b, -HX, 4, -8, 4, [D(6, 1.2)]);                       // garage | kitchen
    this._wallRun(b, -HX, -6, -8, -6, [D(6, 1.8)]);                     // kitchen | dining
    this._wallRun(b, -4, -HZ, -4, -2, [D(6)]);                          // hall | study
    this._wallRun(b, -4, -2, -4, HZ, [D(15, 1.6)]);                     // hall | great room (arch at z = 13)
    this._wallRun(b, -4, -2, 12, -2, [D(4, 1.8), D(14)]);               // study/laundry | great room
    this._wallRun(b, 4, -HZ, 4, -2, [D(8)]);                            // study | bath
    this._wallRun(b, 8, -HZ, 8, -2, [D(4, GAP)]);                       // bath | laundry: GAP DIVE
    this._wallRun(b, 12, -HZ, 12, -2, [D(4)]);                          // laundry | sunroom
    this._wallRun(b, 12, -2, 12, HZ, [D(8, 2.4)]);                      // great room | sunroom: french doors

    // Garage bay: a 5.2 m door opening closed by a sectional panel.
    const m = this._materials(b);
    this._wallRun(b, -HX, HZ, -8, HZ, [{ at: 5, width: 5.2, head: 2.3 }]);
    b.box({ size: [5.2, 2.3, 0.06], position: [-13, 1.15, HZ], material: m.white });
  }

  _buildUpperWalls(b) {
    const W = (at, width = 1.6) => ({ at, width, sill: 0.9, head: 2.2 });
    const D = (at, width = DOOR) => ({ at, width });
    const h = U_CEIL - UP_Y;
    // Exterior, upper floor.
    this._wallRun(b, -HX, -HZ, 12, -HZ, [W(4), W(10), W(18), W(26)], UP_Y, h);
    this._wallRun(b, -HX, HZ, -4, HZ, [W(4), W(10)], UP_Y, h);
    this._wallRun(b, -HX, -HZ, -HX, HZ, [W(7), W(21)], UP_Y, h);
    this._wallRun(b, 12, -HZ, 12, 1, [W(6)], UP_Y, h);
    // Great-room double-height walls above the ground-floor runs.
    const gh = U_CEIL - G_CEIL;
    this._wallRun(b, -4, HZ, 12, HZ, [{ at: 5, width: 3, sill: 0.3, head: 2.8 }, { at: 11, width: 3, sill: 0.3, head: 2.8 }], G_CEIL, gh);
    this._wallRun(b, 12, 1, 12, HZ, [{ at: 7, width: 4, sill: 0.4, head: 2.6 }], G_CEIL, gh);

    // Interior, upper floor.
    this._wallRun(b, -6, -HZ, -6, HZ, [D(6), D(20)], UP_Y, h);          // bedrooms | upper hall
    this._wallRun(b, -HX, -2, -6, -2, [], UP_Y, h);                     // master | bedroom 2
    this._wallRun(b, -4, -HZ, -4, -2, [D(6)], UP_Y, h);                 // upper hall | bedroom 3
    this._wallRun(b, -4, -2, 12, -2, [D(6), D(13)], UP_Y, h);           // bedroom 3/bath 2 | gallery
    this._wallRun(b, 6, -HZ, 6, -2, [D(6, GAP)], UP_Y, h);              // bedroom 3 | bath 2: second gap

    // Gallery railing (z = 1) with a gap for the course, and the upper-hall
    // railing over the stair well (x = -4, z 2..14).
    const m = this._materials(b);
    const rails = [];
    const railRun = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      rails.push({
        size: alongX ? [len, 0.06, 0.08] : [0.08, 0.06, len],
        position: [(x0 + x1) / 2, UP_Y + 1.02, (z0 + z1) / 2],
      });
      for (let t = 0; t <= len; t += 0.12) {
        const px = x0 + (x1 - x0) * (t / len);
        const pz = z0 + (z1 - z0) * (t / len);
        rails.push({ size: [0.025, 1.0, 0.025], position: [px, UP_Y + 0.5, pz] });
      }
      b.boxBody({ size: alongX ? [len, 1.05, 0.1] : [0.1, 1.05, len], position: [(x0 + x1) / 2, UP_Y + 0.52, (z0 + z1) / 2] });
    };
    railRun(-2, 1, 3, 1);
    railRun(7.2, 1, 12, 1);
    railRun(-4, 2.2, -4, HZ);
    b.mergeStatic(rails, m.white, { name: 'gallery-rail' });
    // Gallery slab edge fascia.
    b.box({ size: [16, 0.35, 0.08], position: [4, G_CEIL + 0.15, 1.02], material: m.wall, collide: false });
  }

  /* ---------------------------------------------------------------------- *
   * Open stair: great room floor (z = 12.4) up to the gallery (z = 1.8)
   * ---------------------------------------------------------------------- */

  _buildStair(b) {
    const m = this._materials(b);
    const steps = 20;
    const run = 0.53;
    const rise = UP_Y / steps;
    for (let i = 0; i < steps; i++) {
      const z = 12.4 - i * run;
      b.box({ size: [1.5, 0.05, run + 0.03], position: [-2.75, rise * (i + 1) - 0.025, z], material: m.woodLight });
      b.boxBody({ size: [1.5, rise * (i + 1), run], position: [-2.75, (rise * (i + 1)) / 2, z] });
    }
    // Landing joining the gallery.
    b.box({ size: [2.2, 0.3, 1.6], position: [-3.0, UP_Y - 0.15, 1.8], material: m.woodLight });
    // Stringer and a glass balustrade on the open side.
    b.beam({ from: [-2.0, 0, 12.8], to: [-2.0, UP_Y, 2.2], width: 0.08, height: 0.3, material: m.wood });
    b.beam({ from: [-2.0, 1.0, 12.6], to: [-2.0, UP_Y + 1.0, 2.2], width: 0.05, height: 0.05, material: m.steel, collide: false });
    const len = Math.hypot(10.4, UP_Y);
    const glass = b.box({
      size: [0.02, 0.9, len], position: [-2.0, UP_Y / 2 + 0.55, 7.3],
      rotation: [Math.atan2(UP_Y, 10.4), 0, 0], material: m.glass,
    });
    glass.renderOrder = 2;
  }

  /* ---------------------------------------------------------------------- *
   * Rooms, ground floor
   * ---------------------------------------------------------------------- */

  _buildKitchen(b) {
    const m = this._materials(b);
    const counterTop = b.material('counter-top', () => new THREE.MeshStandardMaterial({ color: 0x2f3238, roughness: 0.3, metalness: 0.2 }));
    const cabTex = b.tex(paintedMetalTexture(1301, [2, 2], [214, 210, 200]));
    const cabinet = b.material('cabinet', () => new THREE.MeshStandardMaterial({ color: cabTex ? 0xffffff : 0xd6d2c8, map: cabTex, roughness: 0.5 }));
    // Base units + counter along the west wall, wall cupboards above.
    b.box({ size: [0.62, 0.88, 8.4], position: [-17.6, 0.44, -1], material: cabinet });
    b.box({ size: [0.66, 0.05, 8.4], position: [-17.6, 0.905, -1], material: counterTop });
    b.box({ size: [0.36, 0.75, 6.0], position: [-17.75, 2.1, -2.2], material: cabinet });
    b.box({ size: [0.72, 2.0, 0.72], position: [-17.5, 1.0, 3.4], material: m.steel });   // fridge
    b.box({ size: [0.62, 0.02, 0.8], position: [-17.55, 0.94, 0.5], material: m.steel, collide: false }); // sink
    // The island, with pendant lights over it (the course passes above).
    b.box({ size: [1.2, 0.88, 3.0], position: [-12, 0.44, -0.5], material: cabinet });
    b.box({ size: [1.3, 0.05, 3.1], position: [-12, 0.905, -0.5], material: counterTop });
    for (const z of [-1.8, -0.5, 0.8]) {
      b.cylinder({ radiusTop: 0.17, radiusBottom: 0.19, height: 0.66, segments: 10, position: [-11.1, 0.33, z], material: m.wood });
    }
    // Dining: table, eight chairs, sideboard, rug.
    const rug = this._fabric(b, 'rug-dining', 1202, [120, 74, 62]);
    b.box({ size: [3.4, 0.015, 4.2], position: [-11.5, 0.008, -10], material: rug, collide: false });
    b.box({ size: [1.05, 0.06, 2.3], position: [-11.5, 0.74, -10], material: m.wood });
    for (const [ox, oz] of [[-0.45, -1.05], [0.45, -1.05], [-0.45, 1.05], [0.45, 1.05]]) {
      b.box({ size: [0.07, 0.72, 0.07], position: [-11.5 + ox, 0.36, -10 + oz], material: m.wood });
    }
    for (const oz of [-0.75, 0, 0.75]) {
      for (const sx of [-1, 1]) {
        const cx = -11.5 + sx * 0.85;
        b.box({ size: [0.44, 0.05, 0.44], position: [cx, 0.46, -10 + oz], material: m.wood });
        b.box({ size: [0.05, 0.5, 0.42], position: [cx + sx * 0.2, 0.72, -10 + oz], material: m.wood });
      }
    }
    b.box({ size: [0.5, 0.85, 2.4], position: [-17.6, 0.43, -10], material: m.wood });
  }

  _buildGreatRoom(b) {
    const m = this._materials(b);
    const couch = this._fabric(b, 'couch', 1201, [86, 92, 108]);
    const rug = this._fabric(b, 'rug-great', 1203, [150, 128, 96]);
    b.box({ size: [5, 0.015, 4.2], position: [7.2, 0.008, 9.6], material: rug, collide: false });
    // L-shaped sectional facing the fireplace wall (east).
    const sofa = (cx, cz, len, alongZ) => {
      const size = alongZ ? [0.95, 0.44, len] : [len, 0.44, 0.95];
      b.box({ size, position: [cx, 0.22, cz], material: couch, surface: 'soft' });
      const back = alongZ ? [0.25, 0.5, len] : [len, 0.5, 0.25];
      const bo = alongZ ? [cx - 0.35, 0.69, cz] : [cx, 0.69, cz + 0.35];
      b.box({ size: back, position: bo, material: couch, surface: 'soft' });
    };
    sofa(5.0, 9.6, 3.2, true);
    sofa(7.4, 12.4, 3.0, false);
    // Coffee table and a fireplace + TV on the east wall.
    b.box({ size: [1.4, 0.06, 0.8], position: [7.4, 0.42, 9.6], material: m.wood });
    for (const [ox, oz] of [[-0.62, -0.32], [0.62, -0.32], [-0.62, 0.32], [0.62, 0.32]]) {
      b.box({ size: [0.06, 0.4, 0.06], position: [7.4 + ox, 0.2, 9.6 + oz], material: m.wood });
    }
    const stone = b.material('fireplace', () => new THREE.MeshStandardMaterial({ color: 0x8c877e, roughness: 0.9 }));
    b.box({ size: [0.9, G_CEIL + 1.5, 2.6], position: [11.5, (G_CEIL + 1.5) / 2, 11.2], material: stone });
    const fire = b.material('fire', () => new THREE.MeshStandardMaterial({ color: 0x100804, emissive: 0xff7a2a, emissiveIntensity: 1.8 }));
    b.box({ size: [0.05, 0.6, 1.0], position: [11.03, 0.5, 11.2], material: fire, collide: false });
    const screen = b.material('screen', () => new THREE.MeshStandardMaterial({ color: 0x0d1014, roughness: 0.2, metalness: 0.4, emissive: 0x0a1a24, emissiveIntensity: 0.6 }));
    b.box({ size: [0.06, 0.9, 1.6], position: [11.02, 2.1, 11.2], material: screen });
    // Grand piano by the window (lid open) and a reading chair.
    b.box({ size: [1.5, 0.35, 1.9], position: [8.8, 0.85, 3.0], rotationY: 0.4, material: m.dark });
    b.box({ size: [0.1, 0.9, 1.7], position: [9.4, 1.35, 3.0], rotation: [0, 0.4, -0.5], material: m.dark });
    for (const [ox, oz] of [[-0.6, -0.8], [0.6, -0.8], [0, 0.8]]) b.box({ size: [0.1, 0.7, 0.1], position: [8.8 + ox, 0.35, 3.0 + oz], material: m.dark });
    b.box({ size: [0.9, 0.45, 0.9], position: [1.2, 0.22, 12.6], material: couch, surface: 'soft' });
    b.box({ size: [0.9, 0.55, 0.22], position: [1.2, 0.7, 13.0], material: couch, surface: 'soft' });
    // Bookcase wall under the gallery.
    b.box({ size: [4.0, 2.6, 0.4], position: [6, 1.3, -1.7], material: m.wood });
    const books = [];
    for (let y = 0.4; y < 2.5; y += 0.5) {
      for (let x = 4.2; x < 7.9; x += 0.09) {
        if (b.rng() < 0.15) continue;
        books.push({ size: [0.07, 0.26 + b.rng() * 0.08, 0.28], position: [x, y + 0.15, -1.45] });
      }
    }
    const bookMat = b.material('books', () => new THREE.MeshStandardMaterial({ color: 0x7a4a3a, roughness: 0.9 }));
    const bm = b.boxes(books, bookMat, { collide: false });
    if (bm) {
      const c = new THREE.Color();
      const hues = [0x7a4a3a, 0x2f4a6e, 0x3e5a3a, 0x8c7a4a, 0x5a2e3a, 0xd6d0c0];
      for (let i = 0; i < books.length; i++) bm.setColorAt(i, c.set(hues[i % hues.length]));
      bm.instanceColor.needsUpdate = true;
    }
    // Chandelier in the double-height void (solid — whoop height is anywhere).
    const glow = b.material('chandelier', () => new THREE.MeshStandardMaterial({ color: 0xfff2d8, emissive: 0xffd9a0, emissiveIntensity: 1.6 }));
    b.cylinder({ radiusTop: 0.02, radiusBottom: 0.02, height: 1.6, segments: 5, position: [6.5, U_CEIL - 0.8, 8.5], material: m.steel, collide: false });
    b.cylinder({ radiusTop: 0.35, radiusBottom: 0.7, height: 0.5, segments: 14, position: [6.5, U_CEIL - 1.85, 8.5], material: glow });
    // Plants.
    this._plant(b, 10.6, 0, 6, 1.2);
    this._plant(b, -3.2, 0, 13.3, 1.0);
    this._art(b, [-3.92, 4.8, 8], Math.PI / 2, 7101, [1.6, 1.1]);
  }

  _buildGarage(b) {
    const m = this._materials(b);
    const concreteTex = b.tex(concreteTexture(1501, [4, 4]));
    const concrete = b.material('garage-floor', () => new THREE.MeshStandardMaterial({ color: concreteTex ? 0xbfbfbf : 0x6e7175, map: concreteTex, roughness: 0.95 }));
    b.box({ size: [10, 0.012, 10], position: [-13, 0.006, 9], material: concrete, collide: false });
    // The car: body, cabin, glass, wheels. Solid boxes.
    const paint = b.material('car-paint', () => new THREE.MeshStandardMaterial({ color: 0x8e1e22, roughness: 0.25, metalness: 0.6 }));
    const cx = -15.8;
    const cz = 9;
    b.box({ size: [1.85, 0.75, 4.6], position: [cx, 0.62, cz], material: paint });
    b.box({ size: [1.6, 0.55, 2.4], position: [cx, 1.25, cz + 0.2], material: paint });
    b.box({ size: [1.62, 0.45, 2.2], position: [cx, 1.26, cz + 0.2], material: m.glass, collide: false });
    for (const [wx, wz] of [[-0.85, -1.5], [0.85, -1.5], [-0.85, 1.5], [0.85, 1.5]]) {
      const w = b.cylinder({ radiusTop: 0.33, radiusBottom: 0.33, height: 0.24, segments: 12, position: [cx + wx, 0.33, cz + wz], material: m.dark, collide: false });
      w.rotation.z = Math.PI / 2;
    }
    // Workbench, tool wall, shelving with boxes, a bike.
    b.box({ size: [2.6, 0.08, 0.7], position: [-9.6, 0.9, 11.5], rotationY: Math.PI / 2, material: m.wood });
    b.box({ size: [0.7, 0.86, 0.1], position: [-9.6, 0.43, 10.25], material: m.wood });
    b.box({ size: [0.7, 0.86, 0.1], position: [-9.6, 0.43, 12.75], material: m.wood });
    b.box({ size: [0.05, 1.2, 2.4], position: [-8.1, 1.8, 11.5], material: m.woodLight });
    b.box({ size: [0.5, 2.0, 2.6], position: [-17.7, 1.0, 5.8], material: m.steel });
    const crateTex = b.tex(crateWoodTexture(1502, [1, 1]));
    const crate = b.material('crate', () => new THREE.MeshStandardMaterial({ color: crateTex ? 0xffffff : 0x9d7c52, map: crateTex, roughness: 0.9 }));
    b.box({ size: [0.6, 0.6, 0.6], position: [-9.6, 0.3, 6.2], material: crate });
    b.box({ size: [0.6, 0.6, 0.6], position: [-9.6, 0.9, 6.3], material: crate });
    // Bare bulb — the flickering one.
    const bulbMat = b.material('bulb', () => new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffe8b8, emissiveIntensity: 2.2 }));
    b.cylinder({ radiusTop: 0.07, radiusBottom: 0.07, height: 0.12, segments: 8, position: [-13, G_CEIL - 0.25, 9], material: bulbMat, collide: false });
    this._flicker = pointLight(0xffe0aa, 14, 10, [-13, G_CEIL - 0.35, 9]);
    b.addLight(this._flicker);
  }

  _buildStudy(b) {
    const m = this._materials(b);
    b.box({ size: [1.8, 0.05, 0.8], position: [0, 0.76, -13.2], material: m.wood });
    b.box({ size: [0.5, 0.74, 0.7], position: [-0.6, 0.37, -13.2], material: m.wood });
    b.box({ size: [0.5, 0.74, 0.7], position: [0.6, 0.37, -13.2], material: m.wood });
    b.box({ size: [0.5, 0.5, 0.5], position: [0, 0.25, -12.4], material: m.dark });
    b.box({ size: [0.35, 2.4, 3.2], position: [3.7, 1.2, -9], material: m.wood });
    b.box({ size: [0.35, 2.4, 3.2], position: [-3.7, 1.2, -11.8], material: m.wood });
    this._art(b, [-3.84, 1.6, -5], Math.PI / 2, 7102);
    this._plant(b, 3.3, 0, -3.0, 0.8);
  }

  _buildWetRooms(b) {
    const m = this._materials(b);
    // Tile floors (ground bath + laundry).
    b.box({ size: [8, 0.012, 12], position: [8, 0.006, -8], material: m.tile, collide: false });
    // Bathroom (x 4..8): tub, vanity, toilet, mirror, shower glass.
    b.box({ size: [1.7, 0.55, 0.78], position: [6, 0.28, -13.5], material: m.porcelain });
    b.box({ size: [1.0, 0.85, 0.5], position: [4.3, 0.43, -4.2], rotationY: Math.PI / 2, material: m.wood });
    b.box({ size: [0.54, 0.08, 1.0], position: [4.32, 0.88, -4.2], material: m.porcelain });
    b.box({ size: [0.04, 0.7, 0.8], position: [4.09, 1.6, -4.2], material: m.steel });
    b.box({ size: [0.4, 0.42, 0.62], position: [7.6, 0.21, -3.0], material: m.porcelain });
    b.box({ size: [0.9, 1.9, 0.04], position: [6.8, 0.95, -12.2], material: m.glass });
    // Laundry (x 8..12): washer, dryer, sink, drying rack.
    b.box({ size: [0.65, 0.85, 0.62], position: [9.2, 0.43, -13.5], material: m.white });
    b.box({ size: [0.65, 0.85, 0.62], position: [10.0, 0.43, -13.5], material: m.white });
    b.box({ size: [0.65, 0.85, 0.62], position: [10.8, 0.43, -13.5], material: m.white });
    b.box({ size: [0.5, 0.9, 1.2], position: [11.6, 0.45, -5.2], material: m.white });
    b.box({ size: [1.4, 1.1, 0.05], position: [9.8, 0.55, -5.4], material: m.steel });
    // Upstairs bath 2 (x 6..12): tub, vanity, shower.
    b.box({ size: [8 - 2, 0.012, 12], position: [9, UP_Y + 0.006, -8], material: m.tile, collide: false });
    b.box({ size: [1.7, 0.55, 0.78], position: [10.6, UP_Y + 0.28, -13.4], material: m.porcelain });
    b.box({ size: [1.2, 0.85, 0.5], position: [11.6, UP_Y + 0.43, -6], rotationY: Math.PI / 2, material: m.wood });
    b.box({ size: [1.0, 1.9, 0.04], position: [7.4, UP_Y + 0.95, -11], material: m.glass });
    b.addLight(pointLight(0xdff0ff, 10, 7, [6, 2.8, -9]));
  }

  _buildSunroom(b) {
    const m = this._materials(b);
    // Glass on the three exterior sides (x 12..18), mullions every 1.75 m.
    const glassRuns = [
      { size: [6, G_CEIL - 0.3, 0.02], position: [15, (G_CEIL - 0.3) / 2 + 0.3, -HZ] },
      { size: [6, G_CEIL - 0.3, 0.02], position: [15, (G_CEIL - 0.3) / 2 + 0.3, HZ] },
      { size: [0.02, G_CEIL - 0.3, HZ * 2], position: [HX, (G_CEIL - 0.3) / 2 + 0.3, 0] },
    ];
    for (const g of glassRuns) b.box({ ...g, material: m.glass });
    const mull = [];
    for (let z = -HZ; z <= HZ; z += 1.75) mull.push({ size: [0.08, G_CEIL, 0.08], position: [HX, G_CEIL / 2, z] });
    for (let x = 12; x <= HX; x += 1.5) {
      mull.push({ size: [0.08, G_CEIL, 0.08], position: [x, G_CEIL / 2, -HZ] });
      mull.push({ size: [0.08, G_CEIL, 0.08], position: [x, G_CEIL / 2, HZ] });
    }
    for (const s of [-1, 1]) mull.push({ size: [6, 0.3, 0.1], position: [15, 0.15, s * HZ] });
    mull.push({ size: [0.1, 0.3, HZ * 2], position: [HX, 0.15, 0] });
    b.mergeStatic(mull, m.frame, { name: 'sunroom-mullions' });
    b.collideParts(mull);
    // Terracotta floor, planters along the glass, rattan chairs.
    const terra = b.material('terracotta', () => new THREE.MeshStandardMaterial({ color: 0xb4674a, roughness: 0.8 }));
    b.box({ size: [6, 0.012, HZ * 2], position: [15, 0.006, 0], material: terra, collide: false });
    for (const z of [-12.5, -4, 2, 12.5]) this._plant(b, 17.2, 0, z, 1.3);
    const rattan = b.material('rattan', () => new THREE.MeshStandardMaterial({ color: 0xc49a5c, roughness: 0.9 }));
    for (const z of [9.5, 11]) {
      b.box({ size: [0.8, 0.42, 0.8], position: [17, 0.21, z], material: rattan, surface: 'soft' });
      b.box({ size: [0.2, 0.5, 0.8], position: [17.3, 0.66, z], material: rattan, surface: 'soft' });
    }
    b.box({ size: [0.6, 0.45, 0.6], position: [15.6, 0.22, 10.2], material: rattan });
  }

  /* ---------------------------------------------------------------------- *
   * Upstairs bedrooms
   * ---------------------------------------------------------------------- */

  _buildBedrooms(b) {
    const m = this._materials(b);
    const bedding = this._fabric(b, 'bedding', 1401, [104, 112, 124]);
    const bedding2 = this._fabric(b, 'bedding2', 1402, [150, 120, 110]);
    const bed = (cx, cz, ry, mat, wide = 1.8) => {
      const y = UP_Y;
      b.box({ size: [wide, 0.3, 2.1], position: [cx, y + 0.15, cz], rotationY: ry, material: m.wood });
      b.box({ size: [wide - 0.05, 0.26, 2.05], position: [cx, y + 0.43, cz], rotationY: ry, material: mat, surface: 'soft' });
      const hx = cx - Math.sin(ry) * 1.08;
      const hz = cz - Math.cos(ry) * 1.08;
      b.box({ size: [wide, 1.1, 0.08], position: [hx, y + 0.6, hz], rotationY: ry, material: m.wood });
    };
    // Master (x -18..-6, z -14..-2): king bed, wardrobes, dresser, chair.
    bed(-12, -12.6 + 1.08, 0, bedding, 2.0);
    b.box({ size: [0.62, 2.2, 3.6], position: [-17.6, UP_Y + 1.1, -6.5], material: m.woodLight });
    b.box({ size: [1.4, 0.8, 0.5], position: [-8.2, UP_Y + 0.4, -3.0], material: m.wood });
    b.box({ size: [0.5, 0.6, 0.45], position: [-14.0, UP_Y + 0.3, -13.3], material: m.wood });
    b.box({ size: [0.5, 0.6, 0.45], position: [-10.0, UP_Y + 0.3, -13.3], material: m.wood });
    this._art(b, [-12, UP_Y + 1.8, -13.9], 0, 7103, [1.4, 0.8]);
    b.addLight(pointLight(0xffd4a0, 10, 9, [-12, U_CEIL - 0.4, -8]));
    // Bedroom 2 (x -18..-6, z -2..14): double bed, desk, bookshelf.
    bed(-15.6, 10.8, Math.PI, bedding2);
    b.box({ size: [1.4, 0.75, 0.6], position: [-8.8, UP_Y + 0.38, 13.4], material: m.woodLight });
    b.box({ size: [0.35, 2.0, 1.4], position: [-17.7, UP_Y + 1.0, 3.2], material: m.wood });
    this._plant(b, -7.0, UP_Y, -1.2, 0.8);
    b.addLight(pointLight(0xffd4a0, 10, 9, [-12, U_CEIL - 0.4, 6]));
    // Bedroom 3 (x -4..6, z -14..-2): single bed, toy chest.
    bed(2.5, -12.6 + 1.08, 0, bedding, 1.1);
    b.box({ size: [0.9, 0.5, 0.5], position: [-2.6, UP_Y + 0.25, -13.4], material: m.woodLight });
    b.addLight(pointLight(0xffd4a0, 8, 8, [1, U_CEIL - 0.4, -8]));
  }

  /* ---------------------------------------------------------------------- *
   * Decor helpers
   * ---------------------------------------------------------------------- */

  _plant(b, x, y, z, s) {
    const potMat = b.material('pot', () => new THREE.MeshStandardMaterial({ color: 0xa85f3c, roughness: 0.9 }));
    const leafMat = b.material('house-leaf', () => {
      const t = b.tex(foliageTexture(7107));
      return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0x3f6b30, map: t, roughness: 0.95 });
    });
    b.cylinder({ radiusTop: 0.22 * s, radiusBottom: 0.16 * s, height: 0.38 * s, segments: 10, position: [x, y + 0.19 * s, z], material: potMat });
    const geo = b.geometry('house-blob', () => new THREE.IcosahedronGeometry(0.3, 1));
    const blobs = [
      { position: [x, y + 0.68 * s, z], scale: s, rotationY: rnd(b, 0, 3) },
      { position: [x + 0.14 * s, y + 0.92 * s, z - 0.1 * s], scale: 0.72 * s, rotationY: 0 },
      { position: [x - 0.12 * s, y + 0.86 * s, z + 0.12 * s], scale: 0.62 * s, rotationY: 1 },
    ];
    b.instanced(geo, leafMat, blobs);
    b.sphereBody({ radius: 0.32 * s, position: [x, y + 0.72 * s, z], surface: 'soft' });
  }

  _art(b, pos, ry, seed, size = [0.92, 0.72]) {
    const m = this._materials(b);
    const canvas = b.tex(artTexture(seed, [1, 1]));
    b.box({ size: [0.06, size[1], size[0]], position: pos, rotationY: ry, material: m.wood });
    const facing = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    b.decal({
      size: [size[0] * 0.85, size[1] * 0.8],
      position: [pos[0] + facing.x * 0.035, pos[1], pos[2] + facing.z * 0.035],
      rotationY: ry + Math.PI / 2, texture: canvas, color: 0x2a2d33, opacity: 1,
    });
  }

  /* ---------------------------------------------------------------------- *
   * Lighting & course
   * ---------------------------------------------------------------------- */

  _buildLighting(b) {
    b.addLight(new THREE.HemisphereLight(0xc6d6e8, 0x5a4a38, 0.6));
    b.addLight(pointLight(0xffdcb0, 18, 12, [-13, G_CEIL - 0.3, -1]));     // kitchen
    b.addLight(pointLight(0xffdcb0, 12, 9, [-12, G_CEIL - 0.3, -10]));     // dining
    b.addLight(pointLight(0xe8eef5, 8, 10, [-6, G_CEIL - 0.3, 0]));        // hall
    b.addLight(pointLight(0xffd9a0, 30, 16, [6.5, 4.3, 8.5]));             // chandelier
    b.addLight(pointLight(0xffe0b0, 8, 8, [0, G_CEIL - 0.3, -8]));         // study
    b.addLight(pointLight(0xe8eef5, 8, 10, [-5, U_CEIL - 0.3, 0]));        // upper hall
    this._dust = b.dustCloud({
      count: 420, area: [34, 6, 26], center: [0, 3.2, 0], color: 0xe8e2d0, size: 0.02, opacity: 0.5, seed: 1790,
    });
  }

  /**
   * Garage -> over the island -> dining -> hall -> study -> great room ->
   * sunroom -> laundry -> GAP DIVE into the bath -> climb the double-height
   * void onto the gallery -> upper hall -> bedroom 2.
   */
  _buildGates(b) {
    const pads = ['#e8e0cf', '#8a5a3a'];
    const layout = [
      { x: -12, y: 1.2, z: 8 },                          // 1 garage
      { x: -12, y: 1.95, z: -0.5, legs: false },          // 2 over the island
      { x: -15, y: 1.2, z: -10 },                         // 3 dining
      { x: -6, y: 1.3, z: -11 },                          // 4 hall
      { x: 0, y: 1.3, z: -8 },                            // 5 study
      { x: 2, y: 1.6, z: 5 },                             // 6 great room
      { x: 15, y: 1.3, z: 6 },                            // 7 sunroom
      { x: 15, y: 1.4, z: -8 },                           // 8 sunroom south
      { x: 10, y: 1.2, z: -10 },                          // 9 laundry
      { x: 6, y: 1.2, z: -10, w: 0.9, h: 1.0 },           // 10 bath, past the gap
      { x: 5, y: UP_Y + 1.35, z: 0.2, ground: UP_Y, yaw: 0 }, // 11 gallery
      { x: -12, y: UP_Y + 1.3, z: 6, ground: UP_Y },      // 12 bedroom 2 finish
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 1.1, padColors: pads, beaconHeight: 0,
    });
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  update(dt, elapsed) {
    if (this._flicker) {
      const f = Math.sin(elapsed * 21.3) * Math.sin(elapsed * 7.7) * Math.sin(elapsed * 43.1);
      this._flicker.intensity = f > 0.55 ? 2 : 14;
    }
    if (this._dust) {
      try { this._dust.update(dt, elapsed); } catch (_e) { /* ignore */ }
    }
  }

  updatePropwash(pos, motor) {
    if (!pos || !this._dust) return;
    try {
      this._dust.kick(pos.x, pos.y, pos.z, 1.6, 0.3 + (Number.isFinite(motor) ? motor : 0) * 1.2);
    } catch (_e) { /* ignore */ }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._flicker = null;
    this._dust = null;
    this.gates = [];
    scene.background = this._prevBackground ?? null;
    scene.fog = this._prevFog ?? null;
  }
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function pointLight(color, intensity, distance, [x, y, z]) {
  const l = new THREE.PointLight(color, intensity, distance, 2);
  l.position.set(x, y, z);
  return l;
}
