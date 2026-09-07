/**
 * maps/HouseMap.js
 * ---------------------------------------------------------------------------
 * Map 1 — Indoor House. The "learn your throttle" map.
 *
 * A 15 x 15 m single-storey residence with 2.7 m ceilings: garage, living
 * room, kitchen with an island, a full-length hallway, two bedrooms, and a
 * bathroom. Tight, technical, and unforgiving of ham-fisted throttle work —
 * which is exactly what makes it the best place to learn.
 *
 * The signature feature is the **gap dive**: the bathroom door is deliberately
 * only 0.62 m wide. A 250 mm quad is a quarter of a metre across, so it fits
 * with room to spare in principle and almost none in practice.
 *
 * Walls are built by `_wallRun`, which takes a start and end point plus a list
 * of door openings and emits the two-or-three boxes needed to leave a hole.
 * Doing it that way (rather than hand-placing every wall fragment) is what
 * keeps a floor plan this fiddly readable.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import {
  plasterTexture, woodPlankTexture, tileTexture, fabricTexture,
  paintedMetalTexture, crateWoodTexture,
} from '../assets/procedural.js';

const W = 15;              // footprint, metres
const D = 15;
const CEIL = 2.7;          // ceiling height
const WALL_T = 0.14;       // wall thickness
const HALF_W = W / 2;
const HALF_D = D / 2;

/** Interior wall x/z lines used by the floor plan. */
const X_HALL_L = -0.5;     // hallway west wall
const X_HALL_R = 1.5;      // hallway east wall
const Z_KITCHEN = -3.0;    // kitchen / living-room divide
const Z_GARAGE = 2.5;      // living room / garage divide
const Z_BED_SPLIT = -2.0;  // bedroom 1 / bedroom 2 divide
const Z_BATH = 3.0;        // bedroom 2 / bathroom divide

export const HOUSE_META = {
  id: 'house',
  displayName: 'Indoor House',
  description: 'Tight technical indoor flying. Seven rooms, real furniture, and one 0.62 m doorway.',
  accent: 'linear-gradient(160deg, #d9c4a3 0%, #b08a5f 50%, #6b4c33 100%)',
};

export class HouseMap {
  constructor() {
    this.id = 'house';

    // Spawn in the garage, nose pointed down the house toward the living room.
    this.spawnPoint = new THREE.Vector3(-4.8, 1.0, 5.6);
    this.spawnHeading = 0;          // local -Z is forward, so this faces -Z
    this.groundLevel = 0;

    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF_W - 3, -2, -HALF_D - 3),
      max: new THREE.Vector3(HALF_W + 3, CEIL + 4, HALF_D + 3),
    };

    this.builder = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._flicker = null;
  }

  getGroundHeight() {
    return 0;
  }

  /* ====================================================================== *
   * Build
   * ====================================================================== */

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 1701, name: 'house-map' });
    this.builder = b;

    this._prevBackground = scene.background;
    this._prevFog = scene.fog;
    // Indoors there is no sky; a near-black surround keeps window glow reading
    // as the only real light source.
    scene.background = new THREE.Color(0x0a0c0f);
    scene.fog = null;

    yield { progress: 0.05, label: 'Shell' };
    this._buildShell(b);

    yield { progress: 0.24, label: 'Interior walls' };
    this._buildInteriorWalls(b);

    yield { progress: 0.42, label: 'Living room' };
    this._buildLivingRoom(b);

    yield { progress: 0.54, label: 'Kitchen' };
    this._buildKitchen(b);

    yield { progress: 0.66, label: 'Bedrooms' };
    this._buildBedrooms(b);

    yield { progress: 0.76, label: 'Bathroom & garage' };
    this._buildBathroom(b);
    this._buildGarage(b);

    yield { progress: 0.86, label: 'Lighting' };
    this._buildLighting(b);

    yield { progress: 0.94, label: 'Course' };
    this._buildGates(b);

    yield { progress: 1, label: 'Ready' };
  }

  /* ---------------------------------------------------------------------- *
   * Materials
   * ---------------------------------------------------------------------- */

  _materials(b) {
    if (this._mats) return this._mats;

    const wallTex = b.tex(plasterTexture(1101, [4, 1.2]));
    const floorTex = b.tex(woodPlankTexture(1102, [7, 7], 'warm'));
    const tileTex = b.tex(tileTexture(1103, [6, 6]));
    const ceilTex = b.tex(plasterTexture(1104, [6, 6]));

    this._mats = {
      wall: b.material('wall', () => new THREE.MeshStandardMaterial({
        color: wallTex ? 0xffffff : 0xe4ddd0, map: wallTex, roughness: 0.95,
      })),
      floor: b.material('floor', () => new THREE.MeshStandardMaterial({
        color: floorTex ? 0xffffff : 0x8a6038, map: floorTex, roughness: 0.72,
      })),
      tile: b.material('tile', () => new THREE.MeshStandardMaterial({
        color: tileTex ? 0xffffff : 0xe6e6e2, map: tileTex, roughness: 0.35,
      })),
      ceiling: b.material('ceiling', () => new THREE.MeshStandardMaterial({
        color: ceilTex ? 0xf4f1ea : 0xf2efe8, map: ceilTex, roughness: 1,
      })),
      wood: b.material('wood-dark', () => new THREE.MeshStandardMaterial({
        color: 0x6b4a2f, roughness: 0.6, metalness: 0.05,
      })),
      woodLight: b.material('wood-light', () => new THREE.MeshStandardMaterial({
        color: 0xa8865c, roughness: 0.65,
      })),
    };
    return this._mats;
  }

  /* ---------------------------------------------------------------------- *
   * Shell
   * ---------------------------------------------------------------------- */

  _buildShell(b) {
    const m = this._materials(b);

    // Floor and ceiling.
    b.floor({ width: W, depth: D, y: 0, material: m.floor });
    b.plane({
      width: W, depth: D, position: [0, CEIL, 0],
      material: m.ceiling, rotationX: Math.PI / 2,
    });
    b.boxBody({ size: [W, 0.3, D], position: [0, CEIL + 0.15, 0] });

    // Exterior walls, with window openings punched into three of them. The
    // openings are what let daylight in and give the interior its contrast.
    this._wallRun(b, m.wall, -HALF_W, -HALF_D, HALF_W, -HALF_D, [
      { at: 4.0, width: 2.0, sill: 0.9, head: 2.2 },
      { at: 11.0, width: 2.0, sill: 0.9, head: 2.2 },
    ]);
    this._wallRun(b, m.wall, HALF_W, -HALF_D, HALF_W, HALF_D, [
      { at: 3.5, width: 1.8, sill: 0.9, head: 2.2 },
      { at: 10.5, width: 1.8, sill: 0.9, head: 2.2 },
    ]);
    this._wallRun(b, m.wall, HALF_W, HALF_D, -HALF_W, HALF_D, [
      { at: 7.5, width: 2.2, sill: 0.9, head: 2.2 },
    ]);
    this._wallRun(b, m.wall, -HALF_W, HALF_D, -HALF_W, -HALF_D, [
      { at: 5.0, width: 2.0, sill: 0.9, head: 2.2 },
    ]);

    this._buildWindowGlow(b);
  }

  /**
   * Window light: an emissive plane just inside each opening plus a soft point
   * light. Cheaper and far more reliable than trying to bounce a directional
   * light through a hole in the geometry, and it reads correctly on the FPV
   * camera, which is all that matters here.
   */
  _buildWindowGlow(b) {
    const glow = b.material('window-glow', () => new THREE.MeshBasicMaterial({
      color: 0xdcecff, transparent: true, opacity: 0.62, side: THREE.DoubleSide, fog: false,
    }));
    const geo = b.geometry('window-pane', () => new THREE.PlaneGeometry(1.9, 1.25));

    const windows = [
      { pos: [-3.5, 1.55, -HALF_D + 0.09], ry: 0 },
      { pos: [3.5, 1.55, -HALF_D + 0.09], ry: 0 },
      { pos: [HALF_W - 0.09, 1.55, -4.0], ry: Math.PI / 2 },
      { pos: [HALF_W - 0.09, 1.55, 3.0], ry: Math.PI / 2 },
      { pos: [0, 1.55, HALF_D - 0.09], ry: 0 },
      { pos: [-HALF_W + 0.09, 1.55, 2.5], ry: Math.PI / 2 },
    ];

    for (const win of windows) {
      const pane = new THREE.Mesh(geo, glow);
      pane.position.set(win.pos[0], win.pos[1], win.pos[2]);
      pane.rotation.y = win.ry;
      b.root.add(pane);

      const light = new THREE.PointLight(0xbcd6f5, 5.5, 9, 2);
      light.position.set(
        win.pos[0] + (win.ry ? -Math.sign(win.pos[0]) * 0.6 : 0),
        1.8,
        win.pos[2] + (win.ry ? 0 : -Math.sign(win.pos[2]) * 0.6),
      );
      b.addLight(light);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Interior walls
   * ---------------------------------------------------------------------- */

  _buildInteriorWalls(b) {
    const m = this._materials(b);
    const STD_DOOR = 0.95;

    // Hallway: two long walls running the full depth of the house.
    // West side — openings into the kitchen and the living room.
    this._wallRun(b, m.wall, X_HALL_L, -HALF_D, X_HALL_L, HALF_D, [
      { at: 2.6, width: STD_DOOR },     // kitchen
      { at: 7.6, width: 1.25 },         // living room (wide opening)
      { at: 12.4, width: STD_DOOR },    // garage
    ]);
    // East side — bedrooms and the tight bathroom door.
    this._wallRun(b, m.wall, X_HALL_R, -HALF_D, X_HALL_R, HALF_D, [
      { at: 3.0, width: STD_DOOR },     // bedroom 1
      { at: 8.2, width: STD_DOOR },     // bedroom 2
      // *** the gap dive *** — 62 cm, versus a 25 cm quad.
      { at: 12.6, width: 0.62 },
    ]);

    // Kitchen / living-room divide (west block).
    this._wallRun(b, m.wall, -HALF_W, Z_KITCHEN, X_HALL_L, Z_KITCHEN, [
      { at: 4.2, width: 1.4 },
    ]);
    // Living room / garage divide.
    this._wallRun(b, m.wall, -HALF_W, Z_GARAGE, X_HALL_L, Z_GARAGE, [
      { at: 2.4, width: 1.1 },
    ]);
    // Bedroom split (east block).
    this._wallRun(b, m.wall, X_HALL_R, Z_BED_SPLIT, HALF_W, Z_BED_SPLIT, []);
    // Bedroom 2 / bathroom divide.
    this._wallRun(b, m.wall, X_HALL_R, Z_BATH, HALF_W, Z_BATH, []);

    // Bathroom gets a tiled floor laid over the boards.
    b.plane({
      width: HALF_W - X_HALL_R, depth: HALF_D - Z_BATH,
      position: [(X_HALL_R + HALF_W) / 2, 0.012, (Z_BATH + HALF_D) / 2],
      material: m.tile,
    });
  }

  /**
   * Build a straight, axis-aligned wall with door/window openings.
   *
   * `doors` entries are `{ at, width, sill?, head? }` where `at` is the
   * distance in metres from the (x1,z1) end. A plain door leaves a gap from
   * the floor to `head`; giving a `sill` makes it a window instead, so the
   * wall continues underneath.
   */
  _wallRun(b, material, x1, z1, x2, z2, doors = [], height = CEIL) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) return;

    const ux = dx / length;
    const uz = dz / length;
    const horizontal = Math.abs(ux) > Math.abs(uz);

    // Sort openings and walk the wall, emitting the solid spans between them.
    const openings = doors
      .map((d) => ({
        start: Math.max(0, d.at - d.width / 2),
        end: Math.min(length, d.at + d.width / 2),
        sill: d.sill ?? 0,
        head: d.head ?? 2.05,
      }))
      .filter((d) => d.end > d.start)
      .sort((a, b2) => a.start - b2.start);

    const segment = (from, to, y0, y1) => {
      const len = to - from;
      const h = y1 - y0;
      if (len <= 0.001 || h <= 0.001) return;
      const mid = (from + to) / 2;
      const cx = x1 + ux * mid;
      const cz = z1 + uz * mid;
      b.box({
        size: horizontal ? [len, h, WALL_T] : [WALL_T, h, len],
        position: [cx, (y0 + y1) / 2, cz],
        material,
      });
    };

    let cursor = 0;
    for (const o of openings) {
      segment(cursor, o.start, 0, height);          // solid wall before it
      if (o.sill > 0) segment(o.start, o.end, 0, o.sill);   // under a window
      segment(o.start, o.end, o.head, height);      // lintel above
      cursor = o.end;
    }
    segment(cursor, length, 0, height);
  }

  /* ---------------------------------------------------------------------- *
   * Rooms
   * ---------------------------------------------------------------------- */

  _buildLivingRoom(b) {
    const m = this._materials(b);
    const couchTex = b.tex(fabricTexture(1201, [2, 2], [86, 92, 108]));
    const couch = b.material('couch', () => new THREE.MeshStandardMaterial({
      color: couchTex ? 0xffffff : 0x5a6070, map: couchTex, roughness: 1,
    }));
    const rugTex = b.tex(fabricTexture(1202, [3, 3], [120, 74, 62]));
    const rug = b.material('rug', () => new THREE.MeshStandardMaterial({
      color: rugTex ? 0xffffff : 0x7a4a3e, map: rugTex, roughness: 1,
    }));

    // Rug (visual only — you can fly a centimetre off it).
    b.plane({ width: 3.6, depth: 2.6, position: [-3.6, 0.014, 0.2], material: rug });

    // Three-seat couch against the west wall: base, back, two arms.
    b.box({ size: [0.95, 0.42, 2.3], position: [-6.4, 0.21, 0.1], material: couch, surface: 'soft' });
    b.box({ size: [0.28, 0.55, 2.3], position: [-6.85, 0.62, 0.1], material: couch, surface: 'soft' });
    b.box({ size: [0.95, 0.30, 0.24], position: [-6.4, 0.55, -1.13], material: couch, surface: 'soft' });
    b.box({ size: [0.95, 0.30, 0.24], position: [-6.4, 0.55, 1.33], material: couch, surface: 'soft' });

    // Coffee table — a good low gap to slalom under is the top of the legs.
    b.box({ size: [1.35, 0.06, 0.68], position: [-4.3, 0.42, 0.2], material: m.wood });
    for (const [ox, oz] of [[-0.58, -0.26], [0.58, -0.26], [-0.58, 0.26], [0.58, 0.26]]) {
      b.box({ size: [0.07, 0.4, 0.07], position: [-4.3 + ox, 0.2, 0.2 + oz], material: m.wood });
    }

    // TV unit and screen.
    b.box({ size: [0.42, 0.5, 2.0], position: [-1.3, 0.25, 0.2], material: m.wood });
    const screen = b.material('screen', () => new THREE.MeshStandardMaterial({
      color: 0x0d1014, roughness: 0.25, metalness: 0.4,
      emissive: 0x0a1a24, emissiveIntensity: 0.5,
    }));
    b.box({ size: [0.06, 0.72, 1.28], position: [-1.15, 1.1, 0.2], material: screen });

    // Bookshelf against the kitchen wall.
    b.box({ size: [0.34, 1.85, 1.1], position: [-2.2, 0.93, -2.6], material: m.wood });

    // Floor lamp — a slim vertical obstacle right where you want to cut a corner.
    const lampMat = b.material('lamp', () => new THREE.MeshStandardMaterial({
      color: 0xf5e6c8, emissive: 0xffdca8, emissiveIntensity: 1.6, roughness: 0.7,
    }));
    b.cylinder({
      radiusTop: 0.04, radiusBottom: 0.16, height: 1.5, segments: 8,
      position: [-6.6, 0.75, 2.0], material: m.wood,
    });
    b.cylinder({
      radiusTop: 0.2, radiusBottom: 0.26, height: 0.3, segments: 10,
      position: [-6.6, 1.65, 2.0], material: lampMat, collide: false,
    });
    b.addLight(pointLight(0xffd9a0, 7, 5.5, [-6.6, 1.6, 2.0]));

    // Armchair.
    b.box({ size: [0.8, 0.4, 0.8], position: [-2.4, 0.2, 1.9], material: couch, surface: 'soft' });
    b.box({ size: [0.8, 0.5, 0.22], position: [-2.4, 0.65, 2.29], material: couch, surface: 'soft' });
  }

  _buildKitchen(b) {
    const m = this._materials(b);
    const counterTop = b.material('counter-top', () => new THREE.MeshStandardMaterial({
      color: 0x2f3238, roughness: 0.35, metalness: 0.2,
    }));
    const cabTex = b.tex(paintedMetalTexture(1301, [2, 2], [214, 210, 200]));
    const cabinet = b.material('cabinet', () => new THREE.MeshStandardMaterial({
      color: cabTex ? 0xffffff : 0xd6d2c8, map: cabTex, roughness: 0.55,
    }));
    const steel = b.material('steel', () => new THREE.MeshStandardMaterial({
      color: 0xb8bcc2, roughness: 0.28, metalness: 0.85,
    }));

    // Run of base units along the south wall.
    b.box({ size: [5.6, 0.86, 0.62], position: [-4.2, 0.43, -6.9], material: cabinet });
    b.box({ size: [5.6, 0.06, 0.66], position: [-4.2, 0.89, -6.9], material: counterTop });
    // Wall units — the gap between counter and cupboard is a nice tight line.
    b.box({ size: [3.4, 0.72, 0.36], position: [-5.3, 1.85, -7.02], material: cabinet });

    // Fridge.
    b.box({ size: [0.72, 1.85, 0.68], position: [-7.0, 0.93, -5.4], material: steel });

    // The island: the map's signature obstacle. Orbit it, or thread the gap
    // between it and the counter run.
    b.box({ size: [2.4, 0.86, 1.0], position: [-3.4, 0.43, -4.6], material: cabinet });
    b.box({ size: [2.5, 0.06, 1.1], position: [-3.4, 0.89, -4.6], material: counterTop });

    // Bar stools tucked against the island.
    for (const ox of [-0.7, 0, 0.7]) {
      b.cylinder({
        radiusTop: 0.16, radiusBottom: 0.18, height: 0.62, segments: 8,
        position: [-3.4 + ox, 0.31, -3.85], material: m.wood,
      });
    }

    // Dining table and chairs by the window.
    b.box({ size: [1.7, 0.06, 0.95], position: [-5.6, 0.74, -3.9], material: m.wood });
    for (const [ox, oz] of [[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]]) {
      b.box({ size: [0.08, 0.72, 0.08], position: [-5.6 + ox, 0.36, -3.9 + oz], material: m.wood });
    }
    for (const [cx, cz] of [[-6.6, -3.9], [-4.6, -3.9]]) {
      b.box({ size: [0.42, 0.06, 0.42], position: [cx, 0.45, cz], material: m.wood });
      b.box({ size: [0.42, 0.5, 0.07], position: [cx, 0.72, cz + (cx < -5.6 ? -0.2 : 0.2)], material: m.wood });
    }

    b.addLight(pointLight(0xffe0b0, 9, 7, [-4.0, 2.35, -5.2]));
  }

  _buildBedrooms(b) {
    const m = this._materials(b);
    const bedTex = b.tex(fabricTexture(1401, [2, 2], [104, 112, 124]));
    const bedding = b.material('bedding', () => new THREE.MeshStandardMaterial({
      color: bedTex ? 0xffffff : 0x68707c, map: bedTex, roughness: 1,
    }));

    /** One bed: frame, mattress, headboard, and a nightstand beside it. */
    const bed = (cx, cz, ry) => {
      b.box({ size: [1.45, 0.28, 2.0], position: [cx, 0.14, cz], rotationY: ry, material: m.wood });
      b.box({ size: [1.4, 0.24, 1.95], position: [cx, 0.40, cz], rotationY: ry, material: bedding, surface: 'soft' });
      const hx = cx - Math.sin(ry) * 1.05;
      const hz = cz - Math.cos(ry) * 1.05;
      b.box({ size: [1.45, 0.85, 0.09], position: [hx, 0.55, hz], rotationY: ry, material: m.wood });
    };

    // Bedroom 1 (south-east).
    bed(4.4, -5.4, 0);
    b.box({ size: [0.45, 0.5, 0.42], position: [6.0, 0.25, -6.3], material: m.wood });
    b.box({ size: [0.6, 1.95, 1.4], position: [7.0, 0.98, -3.2], material: m.wood });   // wardrobe
    b.addLight(pointLight(0xffd4a0, 5.5, 6, [4.6, 2.3, -4.6]));

    // Bedroom 2 (east, mid).
    bed(4.2, 0.6, Math.PI);
    b.box({ size: [0.45, 0.5, 0.42], position: [5.9, 0.25, 1.7], material: m.wood });
    b.box({ size: [1.3, 0.75, 0.45], position: [3.2, 0.38, 2.6], material: m.wood });   // desk
    b.box({ size: [0.5, 0.06, 0.5], position: [3.2, 0.45, 2.0], material: m.wood });    // chair
    b.addLight(pointLight(0xffd4a0, 5.5, 6, [4.4, 2.3, 0.6]));
  }

  _buildBathroom(b) {
    const m = this._materials(b);
    const porcelain = b.material('porcelain', () => new THREE.MeshStandardMaterial({
      color: 0xf2f4f3, roughness: 0.2, metalness: 0.05,
    }));

    // Bath, basin unit, and a shower screen.
    b.box({ size: [1.7, 0.55, 0.78], position: [6.4, 0.28, 6.4], material: porcelain });
    b.box({ size: [1.0, 0.85, 0.5], position: [2.6, 0.43, 6.6], material: m.wood });
    b.box({ size: [1.0, 0.08, 0.54], position: [2.6, 0.88, 6.6], material: porcelain });
    b.box({ size: [0.06, 1.9, 0.9], position: [4.6, 0.95, 4.2], material: b.material('glass', () =>
      new THREE.MeshStandardMaterial({
        color: 0xcfe4ea, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32,
      })) });

    b.addLight(pointLight(0xdff0ff, 5, 5.5, [5.0, 2.35, 5.4]));
  }

  _buildGarage(b) {
    const m = this._materials(b);
    const concrete = b.material('garage-floor', () => new THREE.MeshStandardMaterial({
      color: 0x6e7175, roughness: 1,
    }));
    const crateTex = b.tex(crateWoodTexture(1501, [1, 1]));
    const crate = b.material('crate', () => new THREE.MeshStandardMaterial({
      color: crateTex ? 0xffffff : 0x9d7c52, map: crateTex, roughness: 0.9,
    }));

    // Bare concrete pad over the boards.
    b.plane({
      width: 5.5, depth: HALF_D - Z_GARAGE,
      position: [-4.75, 0.012, (Z_GARAGE + HALF_D) / 2], material: concrete,
    });

    // Workbench and shelving — clutter to weave through on the way out.
    b.box({ size: [2.6, 0.08, 0.66], position: [-6.0, 0.9, 3.4], material: m.wood });
    for (const ox of [-1.2, 1.2]) {
      b.box({ size: [0.09, 0.9, 0.6], position: [-6.0 + ox, 0.45, 3.4], material: m.wood });
    }
    b.box({ size: [0.4, 1.9, 1.6], position: [-7.1, 0.95, 5.6], material: m.wood });

    // Stacked crates.
    b.box({ size: [0.7, 0.7, 0.7], position: [-2.9, 0.35, 4.2], material: crate });
    b.box({ size: [0.7, 0.7, 0.7], position: [-2.9, 1.05, 4.2], material: crate });
    b.box({ size: [0.62, 0.62, 0.62], position: [-2.85, 0.31, 5.1], material: crate });

    // Bare bulb — the flickering one.
    const bulbMat = b.material('bulb', () => new THREE.MeshStandardMaterial({
      color: 0xfff2d0, emissive: 0xffe8b8, emissiveIntensity: 2.2,
    }));
    b.cylinder({
      radiusTop: 0.07, radiusBottom: 0.07, height: 0.12, segments: 8,
      position: [-4.8, 2.45, 5.0], material: bulbMat, collide: false,
    });
    this._flicker = pointLight(0xffe0aa, 6, 7, [-4.8, 2.4, 5.0]);
    b.addLight(this._flicker);
  }

  /* ---------------------------------------------------------------------- *
   * Lighting & course
   * ---------------------------------------------------------------------- */

  _buildLighting(b) {
    // Deliberately dim and contrasty: indoors should feel nothing like the
    // open field. The point lights above do the real work.
    b.addLight(new THREE.HemisphereLight(0xb9c6d6, 0x2c2620, 0.55));
    const fill = new THREE.DirectionalLight(0xffe9d0, 0.35);
    fill.position.set(-6, 8, -4);
    b.addLight(fill);

    b.addLight(pointLight(0xffdcb0, 6, 7, [-4.0, 2.4, 0.4]));   // living room
    b.addLight(pointLight(0xe8eef5, 4, 8, [0.5, 2.4, 0.0]));    // hallway
    b.addLight(pointLight(0xe8eef5, 3.5, 7, [0.5, 2.4, -5.0]));
  }

  /** Living room -> hallway -> kitchen island -> bedroom -> garage. */
  _buildGates(b) {
    const layout = [
      { x: -4.0, y: 1.25, z: 1.2, ry: Math.PI / 2, r: 0.62 },   // living room
      { x: 0.5, y: 1.25, z: -1.0, ry: 0, r: 0.55 },             // hallway
      { x: -3.4, y: 1.55, z: -4.6, ry: Math.PI / 2, r: 0.6 },   // over the island
      { x: 4.2, y: 1.35, z: -3.0, ry: 0, r: 0.62 },             // bedroom 1
      { x: 0.5, y: 1.3, z: 4.6, ry: 0, r: 0.55 },               // hallway north
      { x: -4.8, y: 1.3, z: 4.6, ry: Math.PI / 2, r: 0.62 },    // garage finish
    ];

    this.gates = layout.map((g, i) => b.gate({
      position: [g.x, g.y, g.z],
      rotationY: g.ry,
      radius: g.r,
      tube: 0.04,
      index: i,
    }));
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  update(dt, elapsed) {
    // Failing garage bulb: two noise-ish sine terms so the stutter never
    // settles into an obvious rhythm.
    if (this._flicker) {
      const f = Math.sin(elapsed * 21.3) * Math.sin(elapsed * 7.7) * Math.sin(elapsed * 43.1);
      this._flicker.intensity = f > 0.55 ? 1.2 : 6;
    }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._flicker = null;
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
