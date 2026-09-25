/**
 * maps/WarehouseMap.js
 * ---------------------------------------------------------------------------
 * Abandoned Warehouse — a derelict regional distribution centre.
 *
 * 84 x 124 m under a 23 m roof (8.6x the volume of the old 40 x 60 m shed).
 * The racing is in the racking: seven double rows of 11 m pallet racking with
 * 5.5 m forklift aisles and a cross-aisle, half-stocked, with empty bays you
 * can thread and one collapsed run. Around it: a mezzanine office deck on the
 * east wall, an overhead conveyor bridge spanning the building at 5 m, a
 * staging floor of pallets, forklifts and wrapped goods, and a south wall of
 * dock doors — three open onto the truck yard outside.
 *
 * Daylight is real: a shadow-casting sun comes through rows of skylights in
 * an otherwise solid roof, so the floor carries hard-edged pools of light and
 * every skylight throws a sunbeam through the dust. High-bay fixtures (one of
 * them dying) and a captured environment map fill in the rest.
 *
 * Twelve gates: down an aisle, under the conveyor, through the cross-aisle, a
 * climb over the racking, a dive back into it, a hairpin on the mezzanine
 * deck, over the conveyor and out through a dock door into the yard.
 *
 * Streamed colliders: ~2 500 static bodies, but only the few hundred around
 * the quad are ever in the physics world.
 */

import * as THREE from 'three/webgpu';
import { MapBuilder, rnd, rndInt } from './MapKit.js';
import {
  concreteTexture, corrugatedMetalTexture, rustTexture, crateWoodTexture,
  paintedMetalTexture, hazardTexture, grimeTexture, graffitiTexture, oilStainTexture,
  netTexture,
} from '../assets/procedural.js';

const W = 84;             // x
const L = 124;            // z
const H = 20;             // truss bottom chord
const ROOF_Y = 23;        // roof deck
const HALF_W = W / 2;
const HALF_L = L / 2;
const WALL_T = 0.35;

/* Racking */
const RACK_ROWS = [-34, -26, -18, -10, -2, 6, 14];   // double-row centres (x)
const RACK_Z0 = -54;
const RACK_Z1 = 10;
const CROSS_Z = [-25, -19];                         // cross-aisle gap
const BAY = 2.8;
const RACK_DEPTH = 1.1;
const FLUE = 0.3;
const LEVELS = [0, 1.7, 3.4, 5.1, 6.8, 8.5, 10.2];  // beam heights (0 = floor bay)
const RACK_H = 11.0;

/* Mezzanine (east) */
const MEZ_X0 = 31;
const MEZ_X1 = HALF_W - WALL_T / 2;
const MEZ_Z0 = -40;
const MEZ_Z1 = 28;
const MEZ_Y = 6;

/* Conveyor bridge */
const CONV_Z = 18;
const CONV_Y = 5;

/* Truck yard (outside the south wall, 1.2 m lower: dock height) */
const YARD_Y = -1.2;
const YARD_Z1 = HALF_L + 34;

const SUN_DIR = [0.34, 1, 0.42];

export const WAREHOUSE_META = {
  id: 'warehouse',
  displayName: 'Abandoned Warehouse',
  description: 'Derelict distribution centre: 11 m racking aisles, mezzanine, conveyor bridge, sunbeams, dock yard.',
  accent: 'linear-gradient(160deg, #6f7a85 0%, #4a5158 45%, #2a2f36 100%)',
  category: 'Racing',
  size: '84 × 124 × 23 m',
  gates: 12,
  courseKey: 'warehouse.v2',
  ambient: 'warehouse',
};

export class WarehouseMap {
  constructor() {
    this.id = 'warehouse';
    this.spawnPoint = new THREE.Vector3(0, 0.12, 52);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF_W - 3, -6, -HALF_L - 3),
      max: new THREE.Vector3(HALF_W + 3, ROOF_Y + 4, YARD_Z1 + 3),
    };
    this.viewDistance = 400;
    this.link = { range: 120, indoor: true };
    this.environment = {
      mode: 'indoor',
      exposure: 1.0,
      envIntensity: 0.6,
      hemiIntensity: 0,
      sun: { direction: SUN_DIR, color: 0xfff0dc, intensity: 3.4 },
      shadowRange: 88,
      shadowFocus: [0, 0, 16],
      probe: [0, 6, 24],
      // Skylight sunbeams: the post pipeline adds screen-space godrays from
      // the sun's shadow map on high/ultra (the beam cards stay).
      godrays: true,
    };
    this.builder = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._dust = null;
    this._flicker = null;
  }

  getGroundHeight(x, z) {
    return z > HALF_L ? YARD_Y : 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 2207, name: 'warehouse-map', streaming: { cellSize: 32 } });
    this.builder = b;
    this._prevBackground = scene.background;
    this._prevFog = scene.fog;
    scene.background = new THREE.Color(0xa9bccb);
    scene.fog = new THREE.Fog(0x2a2f35, 70, 230);

    yield { progress: 0.03, label: 'Slab & walls' };
    this._buildShell(b);
    yield { progress: 0.1, label: 'Roof & skylights' };
    yield* this._buildRoof(b);
    yield { progress: 0.24, label: 'Racking' };
    yield* this._buildRacking(b);
    yield { progress: 0.52, label: 'Mezzanine' };
    this._buildMezzanine(b);
    yield { progress: 0.6, label: 'Conveyor' };
    this._buildConveyor(b);
    yield { progress: 0.66, label: 'Staging floor' };
    yield* this._buildStaging(b);
    yield { progress: 0.78, label: 'Truck yard' };
    this._buildYard(b);
    yield { progress: 0.86, label: 'Lighting' };
    this._buildLighting(b);
    yield { progress: 0.92, label: 'Race course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.6 });
    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;
    const floorTex = b.tex(concreteTexture(2101, [28, 40]));
    const wallTex = b.tex(corrugatedMetalTexture(2102, [28, 8]));
    const rustTex = b.tex(rustTexture(2103, [2, 2]));
    const crateTex = b.tex(crateWoodTexture(2104, [1, 1]));
    const steelTex = b.tex(paintedMetalTexture(2105, [2, 2], [118, 122, 128]));
    const blueTex = b.tex(paintedMetalTexture(2106, [2, 2], [38, 74, 140]));
    const orangeTex = b.tex(paintedMetalTexture(2107, [4, 1], [214, 106, 32]));
    this._mats = {
      floor: b.material('wh-floor', () => new THREE.MeshStandardMaterial({
        color: floorTex ? 0xd8d8d8 : 0x7c7e80, map: floorTex, roughness: 0.82,
      })),
      wall: b.material('wh-wall', () => new THREE.MeshStandardMaterial({
        color: wallTex ? 0xc9ccd0 : 0x6a6f74, map: wallTex, roughness: 0.72, metalness: 0.45, side: THREE.DoubleSide,
      })),
      rust: b.material('wh-rust', () => new THREE.MeshStandardMaterial({
        color: rustTex ? 0xffffff : 0x7a4426, map: rustTex, roughness: 0.95, metalness: 0.2,
      })),
      crate: b.material('wh-crate', () => new THREE.MeshStandardMaterial({
        color: crateTex ? 0xffffff : 0x9a7a50, map: crateTex, roughness: 0.92,
      })),
      steel: b.material('wh-steel', () => new THREE.MeshStandardMaterial({
        color: steelTex ? 0xffffff : 0x767b81, map: steelTex, roughness: 0.55, metalness: 0.7,
      })),
      upright: b.material('wh-upright', () => new THREE.MeshStandardMaterial({
        color: blueTex ? 0xffffff : 0x264a8c, map: blueTex, roughness: 0.5, metalness: 0.5,
      })),
      beam: b.material('wh-beam', () => new THREE.MeshStandardMaterial({
        color: orangeTex ? 0xffffff : 0xd66a20, map: orangeTex, roughness: 0.5, metalness: 0.4,
      })),
      dark: b.material('wh-dark', () => new THREE.MeshStandardMaterial({
        color: 0x30343a, roughness: 0.8, metalness: 0.4,
      })),
      wrap: b.material('wh-wrap', () => new THREE.MeshStandardMaterial({
        color: 0xdfe6ea, roughness: 0.28, metalness: 0.05, transparent: false,
      })),
      cardboard: b.material('wh-cardboard', () => new THREE.MeshStandardMaterial({
        color: 0xa87f52, roughness: 0.95,
      })),
      yellow: b.material('wh-yellow', () => new THREE.MeshStandardMaterial({
        color: 0xe8b21e, roughness: 0.6, metalness: 0.2,
      })),
      paint: b.material('wh-paint', () => new THREE.MeshStandardMaterial({
        color: 0xd9b020, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1,
      })),
      hazard: b.material('wh-hazard', () => {
        const t = b.tex(hazardTexture(2108, [6, 1]));
        return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0xc9a227, map: t, roughness: 0.8 });
      }),
      glass: b.material('wh-glass', () => new THREE.MeshStandardMaterial({
        color: 0xcfe2ee, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.18, depthWrite: false,
      })),
      fixture: b.material('wh-fixture', () => new THREE.MeshStandardMaterial({
        color: 0xffe9c4, emissive: 0xffe2b0, emissiveIntensity: 2.6, roughness: 0.6,
      })),
      asphalt: b.material('wh-asphalt', () => {
        const t = b.tex(concreteTexture(2109, [20, 10]));
        return new THREE.MeshStandardMaterial({ color: t ? 0x6c6e72 : 0x3b3d40, map: t, roughness: 0.95 });
      }),
      fence: b.material('wh-fence', () => {
        const t = b.tex(netTexture(2110, [60, 1.5]));
        return new THREE.MeshStandardMaterial({
          color: 0x8a9096, map: t, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5,
          transparent: !t, opacity: t ? 1 : 0.2,
        });
      }),
    };
    return this._mats;
  }

  /* ---------------------------------------------------------------------- *
   * Shell: slab, walls, dock doors
   * ---------------------------------------------------------------------- */

  _buildShell(b) {
    const m = this._materials(b);
    b.floor({ width: W, depth: L, material: m.floor });

    // Painted aisle lines and walkway markings (visual only).
    const lines = [];
    for (const x of [-14, 20]) lines.push({ size: [0.12, 0.01, 44], position: [x, 0.006, 38] });
    lines.push({ size: [60, 0.01, 0.12], position: [-4, 0.006, 14.5] });
    lines.push({ size: [60, 0.01, 0.12], position: [-4, 0.006, 21.5] });
    for (const x of RACK_ROWS) {
      for (const s of [-1, 1]) {
        lines.push({ size: [0.1, 0.01, RACK_Z1 - RACK_Z0 + 2], position: [x + s * 2.0, 0.006, (RACK_Z0 + RACK_Z1) / 2] });
      }
    }
    b.mergeStatic(lines, m.paint, { name: 'wh-lines' });

    const wallH = ROOF_Y;
    b.box({ size: [WALL_T, wallH, L], position: [-HALF_W, wallH / 2, 0], material: m.wall });
    b.box({ size: [WALL_T, wallH, L], position: [HALF_W, wallH / 2, 0], material: m.wall });
    b.box({ size: [W, wallH, WALL_T], position: [0, wallH / 2, -HALF_L], material: m.wall });

    // South wall: six dock doors (4 m x 4.5 m) at dock height; three open.
    const doors = [-30, -18, -6, 6, 18, 30];
    const open = new Set([-18, 6, 30]);
    const doorW = 4;
    const doorH = 4.5;
    let cursor = -HALF_W;
    for (const dx of doors) {
      const x0 = dx - doorW / 2;
      if (x0 > cursor) {
        b.box({ size: [x0 - cursor, wallH, WALL_T], position: [(cursor + x0) / 2, wallH / 2, HALF_L], material: m.wall });
      }
      b.box({ size: [doorW, wallH - doorH, WALL_T], position: [dx, doorH + (wallH - doorH) / 2, HALF_L], material: m.wall });
      if (!open.has(dx)) {
        // Closed roller shutter, set just inside the opening.
        b.box({ size: [doorW, doorH, 0.12], position: [dx, doorH / 2, HALF_L - 0.3], material: m.steel });
      } else {
        // Rolled-up drum above an open door.
        const drum = b.cylinder({
          radiusTop: 0.35, radiusBottom: 0.35, height: doorW, segments: 10,
          position: [dx, doorH + 0.4, HALF_L - 0.5], material: m.steel, collide: false,
        });
        drum.rotation.z = Math.PI / 2;
      }
      // Dock bumpers + hazard sill.
      b.box({ size: [doorW + 0.6, 0.15, 0.3], position: [dx, 0.075, HALF_L - 0.3], material: m.hazard, collide: false });
      cursor = dx + doorW / 2;
    }
    b.box({ size: [HALF_W - cursor, wallH, WALL_T], position: [(cursor + HALF_W) / 2, wallH / 2, HALF_L], material: m.wall });

    // Grime and tags on the walls.
    const grime = b.tex(grimeTexture(2120, [1, 1]));
    for (let i = 0; i < 10; i++) {
      const z = -54 + i * 12;
      b.decal({ size: [4, 7], position: [-HALF_W + WALL_T / 2 + 0.05, 5, z], rotationY: Math.PI / 2, texture: grime, opacity: 0.55 });
    }
    const hues = [310, 190, 40, 120];
    for (let i = 0; i < 4; i++) {
      const tag = b.tex(graffitiTexture(2130 + i, [1, 1], hues[i]));
      b.decal({
        size: [7, 3.8], position: [-18 + i * 12, 3, -HALF_L + WALL_T / 2 + 0.05],
        texture: tag, opacity: 0.9,
      });
    }
    this._openDoors = [...open];
  }

  /* ---------------------------------------------------------------------- *
   * Roof: trusses, purlins, deck with skylight openings, sunbeams
   * ---------------------------------------------------------------------- */

  *_buildRoof(b) {
    const m = this._materials(b);

    // Skylight grid: 4 columns x 6 rows of 4 x 9 m openings.
    const skyCols = [-30, -10, 10, 30];
    const skyRows = [-48, -28, -8, 12, 32, 50];
    const SKW = 4;
    const SKL = 9;
    this._skylights = [];

    // Deck built as strips around the openings.
    const deck = [];
    const xEdges = [-HALF_W];
    for (const cx of skyCols) xEdges.push(cx - SKW / 2, cx + SKW / 2);
    xEdges.push(HALF_W);
    for (let i = 0; i < xEdges.length - 1; i++) {
      const x0 = xEdges[i];
      const x1 = xEdges[i + 1];
      const isSky = i % 2 === 1;
      if (!isSky) {
        deck.push({ size: [x1 - x0, 0.3, L], position: [(x0 + x1) / 2, ROOF_Y, 0] });
        continue;
      }
      let z = -HALF_L;
      for (const cz of skyRows) {
        const z0 = cz - SKL / 2;
        deck.push({ size: [x1 - x0, 0.3, z0 - z], position: [(x0 + x1) / 2, ROOF_Y, (z + z0) / 2] });
        z = cz + SKL / 2;
        this._skylights.push({ x: (x0 + x1) / 2, z: cz });
      }
      deck.push({ size: [x1 - x0, 0.3, HALF_L - z], position: [(x0 + x1) / 2, ROOF_Y, (z + HALF_L) / 2] });
    }
    b.mergeStatic(deck, m.dark, { name: 'wh-roof' });
    b.collideParts(deck);

    // Glazing: most panes intact (transparent, lets the sun through), a few
    // smashed out. Frames around every opening.
    const pane = b.geometry('wh-pane', () => new THREE.PlaneGeometry(SKW, SKL));
    const frames = [];
    for (const s of this._skylights) {
      if (b.rng() > 0.25) {
        const p = new THREE.Mesh(pane, m.glass);
        p.rotation.x = Math.PI / 2;
        p.position.set(s.x, ROOF_Y - 0.05, s.z);
        b.root.add(p);
      }
      frames.push({ size: [SKW, 0.12, 0.12], position: [s.x, ROOF_Y - 0.2, s.z - SKL / 2] });
      frames.push({ size: [SKW, 0.12, 0.12], position: [s.x, ROOF_Y - 0.2, s.z + SKL / 2] });
    }
    b.mergeStatic(frames, m.steel, { name: 'wh-skyframes' });
    yield { progress: 0.14, label: 'Roof trusses' };

    // Portal trusses every 8 m, bottom chord at H, Pratt web up to the deck.
    const parts = [];
    for (let z = -HALF_L + 4; z <= HALF_L - 4; z += 8) {
      parts.push({ size: [W - 0.8, 0.34, 0.34], position: [0, H, z] });
      parts.push({ size: [W - 0.8, 0.28, 0.28], position: [0, ROOF_Y - 0.4, z] });
      const bays = 14;
      const bw = (W - 0.8) / bays;
      for (let i = 0; i < bays; i++) {
        const x0 = -(W - 0.8) / 2 + i * bw;
        parts.push({ size: [0.14, ROOF_Y - 0.4 - H, 0.14], position: [x0, (H + ROOF_Y - 0.4) / 2, z] });
        parts.push(MapBuilder.beamPart([x0, H, z], [x0 + bw, ROOF_Y - 0.4, z], 0.12));
      }
      // Wall columns under each truss end.
      for (const sx of [-1, 1]) parts.push({ size: [0.45, H, 0.45], position: [sx * (HALF_W - 0.5), H / 2, z] });
      b.boxBody({ size: [W - 0.8, 0.4, 0.4], position: [0, H, z] });
      for (const sx of [-1, 1]) b.boxBody({ size: [0.5, H, 0.5], position: [sx * (HALF_W - 0.5), H / 2, z] });
    }
    for (let x = -HALF_W + 3; x <= HALF_W - 3; x += 6) {
      parts.push({ size: [0.16, 0.16, L - 1], position: [x, ROOF_Y - 0.25, 0] });
    }
    b.mergeStatic(parts, m.steel, { name: 'wh-truss' });

    // Sunbeams through every open or glazed skylight.
    const d = [-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]];
    for (const s of this._skylights) {
      b.sunShaft({ top: [s.x, ROOF_Y, s.z], dir: d, length: 26, width: 4.2, opacity: 0.2 });
    }
    yield { progress: 0.22, label: 'Roof trusses' };
  }

  /* ---------------------------------------------------------------------- *
   * Racking
   * ---------------------------------------------------------------------- */

  *_buildRacking(b) {
    const m = this._materials(b);
    const uprights = [];
    const beams = [];
    const loads = [];     // pallets: { size, position, rotationY, kind }
    const decks = [];
    const bayZ = [];
    for (let z = RACK_Z0; z + BAY <= RACK_Z1 + 0.01; z += BAY) {
      const z1 = z + BAY;
      // Leave the cross-aisle open.
      if (z1 > CROSS_Z[0] && z < CROSS_Z[1]) continue;
      bayZ.push([z, z1]);
    }
    // Upright lines: every bay boundary that has a bay on either side.
    const upZ = new Set();
    for (const [z0, z1] of bayZ) { upZ.add(z0.toFixed(2)); upZ.add(z1.toFixed(2)); }

    let r = 0;
    for (const cx of RACK_ROWS) {
      // Two single racks back to back: faces at cx ± (FLUE/2 + RACK_DEPTH).
      const faces = [
        [cx - FLUE / 2 - RACK_DEPTH, cx - FLUE / 2],
        [cx + FLUE / 2, cx + FLUE / 2 + RACK_DEPTH],
      ];
      // One run in this row is collapsed: the uprights buckled and the
      // loads dumped into the aisle. It is the map's "bando" moment.
      const collapsedRow = r === 3;
      for (const zs of upZ) {
        const z = parseFloat(zs);
        for (const [x0, x1] of faces) {
          for (const x of [x0 + 0.05, x1 - 0.05]) {
            if (collapsedRow && z > -50 && z < -32) continue;
            uprights.push({ size: [0.1, RACK_H, 0.08], position: [x, RACK_H / 2, z] });
          }
        }
        // Flue ties.
        if (!(collapsedRow && z > -50 && z < -32)) {
          uprights.push({ size: [FLUE + 0.1, 0.06, 0.06], position: [cx, RACK_H * 0.5, z] });
        }
      }

      for (const [z0, z1] of bayZ) {
        const zc = (z0 + z1) / 2;
        const collapsed = collapsedRow && zc > -50 && zc < -32;
        for (const [x0, x1] of faces) {
          const xc = (x0 + x1) / 2;
          for (let li = 1; li < LEVELS.length; li++) {
            const y = LEVELS[li];
            if (collapsed) continue;
            beams.push({ size: [0.08, 0.14, BAY], position: [x0 + 0.05, y, zc] });
            beams.push({ size: [0.08, 0.14, BAY], position: [x1 - 0.05, y, zc] });
            decks.push({ size: [RACK_DEPTH, 0.03, BAY - 0.1], position: [xc, y + 0.08, zc] });
          }
          // Loads: most bays stocked, emptier high up (the place was
          // being cleared when it closed).
          for (let li = 0; li < LEVELS.length; li++) {
            if (collapsed) continue;
            const fill = li === 0 ? 0.75 : 0.72 - li * 0.08;
            if (b.rng() > fill) continue;
            const y = LEVELS[li] + (li === 0 ? 0 : 0.09);
            const h = rnd(b, 0.7, 1.35);
            const kind = b.rng();
            for (const pz of [zc - BAY / 4, zc + BAY / 4]) {
              if (b.rng() < 0.12) continue;
              loads.push({
                size: [RACK_DEPTH - 0.08, h, BAY / 2 - 0.16],
                position: [xc, y + 0.14 + h / 2, pz + rnd(b, -0.04, 0.04)],
                rotationY: rnd(b, -0.02, 0.02),
                kind,
              });
            }
          }
        }
      }
      // Beam-level colliders per face, one per run between gaps.
      for (const [x0, x1] of faces) {
        for (let li = 1; li < LEVELS.length; li++) {
          const y = LEVELS[li];
          const runs = [[RACK_Z0, CROSS_Z[0]], [CROSS_Z[1], RACK_Z1]];
          for (const [za, zb] of runs) {
            if (collapsedRow && za < -32 && zb > -50) {
              for (const [ra, rb] of [[za, -50], [-32, zb]]) {
                if (rb - ra < 0.5) continue;
                b.boxBody({ size: [x1 - x0, 0.16, rb - ra], position: [(x0 + x1) / 2, y, (ra + rb) / 2] });
              }
              continue;
            }
            b.boxBody({ size: [x1 - x0, 0.16, zb - za], position: [(x0 + x1) / 2, y, (za + zb) / 2] });
          }
        }
      }
      r++;
      yield { progress: 0.24 + 0.18 * (r / RACK_ROWS.length), label: 'Racking' };
    }

    b.boxes(uprights, m.upright, { collide: true });
    b.mergeStatic(beams, m.beam, { name: 'wh-beams' });
    b.boxes(decks, m.steel, { collide: false });

    // Pallets (wood base) under every load + the load itself by kind.
    const pallets = loads.map((l) => ({
      size: [l.size[0] + 0.04, 0.14, l.size[2] + 0.06],
      position: [l.position[0], l.position[1] - l.size[1] / 2 - 0.07, l.position[2]],
      rotationY: l.rotationY,
    }));
    b.boxes(pallets, m.crate, { collide: false });
    const byKind = [[], [], []];
    for (const l of loads) byKind[l.kind < 0.45 ? 0 : l.kind < 0.8 ? 1 : 2].push(l);
    b.boxes(byKind[0], m.cardboard, { collide: true });
    b.boxes(byKind[1], m.wrap, { collide: true });
    b.boxes(byKind[2], m.crate, { collide: true });
    yield { progress: 0.46, label: 'Racking' };

    // The collapse: buckled uprights and a spill of loads into the aisle.
    const cx = RACK_ROWS[3];
    const spill = [];
    for (let i = 0; i < 26; i++) {
      const z = rnd(b, -50, -32);
      const x = cx + rnd(b, -4.5, 4.5);
      const s = rnd(b, 0.7, 1.3);
      spill.push({
        size: [s * 1.05, s * rnd(b, 0.6, 1.1), s * 1.2],
        position: [x, s * 0.4 + (i % 3) * 0.5 * s * (b.rng() < 0.5 ? 1 : 0), z],
        rotationY: rnd(b, 0, Math.PI),
      });
    }
    b.boxes(spill, m.cardboard, { collide: true });
    for (let i = 0; i < 6; i++) {
      const z = -48 + i * 3;
      b.beam({
        from: [cx + rnd(b, -1.5, 1.5), 0.1, z],
        to: [cx + rnd(b, -3, 3), rnd(b, 2, 7), z + rnd(b, -2, 2)],
        width: 0.1, material: m.upright,
      });
    }
    for (let i = 0; i < 5; i++) {
      const z = -49 + i * 3.8;
      b.beam({
        from: [cx - 1.3, rnd(b, 0.2, 1.4), z],
        to: [cx + 1.8, rnd(b, 1.5, 4.5), z + rnd(b, -2.5, 2.5)],
        width: 0.12, height: 0.14, material: m.beam,
      });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Mezzanine office deck (east wall)
   * ---------------------------------------------------------------------- */

  _buildMezzanine(b) {
    const m = this._materials(b);
    const w = MEZ_X1 - MEZ_X0;
    const l = MEZ_Z1 - MEZ_Z0;
    const xc = (MEZ_X0 + MEZ_X1) / 2;
    const zc = (MEZ_Z0 + MEZ_Z1) / 2;
    b.box({ size: [w, 0.3, l], position: [xc, MEZ_Y, zc], material: m.steel });
    // Columns under the deck edge and mid-line.
    for (let z = MEZ_Z0 + 1; z <= MEZ_Z1 - 1; z += 6) {
      for (const x of [MEZ_X0 + 0.4, MEZ_X0 + 5.5]) {
        b.box({ size: [0.3, MEZ_Y - 0.15, 0.3], position: [x, (MEZ_Y - 0.15) / 2, z], material: m.upright });
      }
    }
    // Handrail along the open edge, with a gap for the course.
    const rails = [];
    const gap = [-20, 4];
    for (let z = MEZ_Z0; z <= MEZ_Z1; z += 2) {
      if (z > gap[0] && z < gap[1]) continue;
      rails.push({ size: [0.06, 1.1, 0.06], position: [MEZ_X0 + 0.1, MEZ_Y + 0.7, z] });
    }
    for (const [z0, z1] of [[MEZ_Z0, gap[0]], [gap[1], MEZ_Z1]]) {
      rails.push({ size: [0.08, 0.08, z1 - z0], position: [MEZ_X0 + 0.1, MEZ_Y + 1.2, (z0 + z1) / 2] });
      b.boxBody({ size: [0.12, 1.1, z1 - z0], position: [MEZ_X0 + 0.1, MEZ_Y + 0.7, (z0 + z1) / 2] });
    }
    b.mergeStatic(rails, m.yellow, { name: 'wh-mez-rail' });

    // Offices at the north end: two rooms with window bands and doors.
    const ox0 = MEZ_X0 + 5.5;
    for (const [z0, z1] of [[MEZ_Z0, MEZ_Z0 + 8], [MEZ_Z0 + 8, MEZ_Z0 + 16]]) {
      const zm = (z0 + z1) / 2;
      const wallY = MEZ_Y + 0.15;
      b.box({ size: [0.15, 1.0, z1 - z0], position: [ox0, wallY + 0.5, zm], material: m.wall });
      b.box({ size: [0.15, 0.6, z1 - z0], position: [ox0, wallY + 2.6, zm], material: m.wall });
      const win = new THREE.Mesh(b.geometry('wh-office-win', () => new THREE.PlaneGeometry(8, 1.5)), m.glass);
      win.position.set(ox0, wallY + 1.75, zm);
      win.rotation.y = Math.PI / 2;
      b.root.add(win);
      b.box({ size: [MEZ_X1 - ox0, 0.15, z1 - z0], position: [(ox0 + MEZ_X1) / 2, wallY + 2.95, zm], material: m.dark });
      b.box({ size: [MEZ_X1 - ox0, 3.0, 0.15], position: [(ox0 + MEZ_X1) / 2, wallY + 1.5, z1], material: m.wall });
      // Desks and a filing cabinet.
      b.box({ size: [1.6, 0.75, 0.8], position: [ox0 + 2, wallY + 0.38, zm - 1.5], material: m.dark });
      b.box({ size: [0.5, 1.3, 0.6], position: [MEZ_X1 - 0.5, wallY + 0.65, zm + 2], material: m.steel });
    }
    // Stair up to the deck at the south end.
    const steps = 20;
    for (let i = 0; i < steps; i++) {
      b.box({
        size: [1.4, 0.12, 0.4],
        position: [MEZ_X0 + 2.5, 0.2 + (i * (MEZ_Y - 0.2)) / (steps - 1), MEZ_Z1 + 7.6 - i * 0.4],
        material: m.steel,
      });
    }
    // Racking of archive boxes under the deck.
    const under = [];
    for (let z = MEZ_Z0 + 2; z < MEZ_Z1 - 2; z += 3.2) {
      if (b.rng() < 0.3) continue;
      under.push({ size: [2.2, rnd(b, 1.2, 3.8), 1.2], position: [MEZ_X1 - 2, 0, z] });
    }
    for (const u of under) u.position[1] = u.size[1] / 2;
    b.boxes(under, m.cardboard, { collide: true });
  }

  /* ---------------------------------------------------------------------- *
   * Conveyor bridge across the building
   * ---------------------------------------------------------------------- */

  _buildConveyor(b) {
    const m = this._materials(b);
    const x0 = -38;
    const x1 = MEZ_X0 + 1;
    const len = x1 - x0;
    const xc = (x0 + x1) / 2;
    // Belt deck + rollers side frames + guard rails.
    b.box({ size: [len, 0.35, 1.3], position: [xc, CONV_Y, CONV_Z], material: m.dark });
    const rails = [];
    for (const s of [-1, 1]) {
      rails.push({ size: [len, 0.3, 0.08], position: [xc, CONV_Y + 0.3, CONV_Z + s * 0.68] });
      rails.push({ size: [len, 0.06, 0.06], position: [xc, CONV_Y + 0.85, CONV_Z + s * 0.68] });
    }
    for (let x = x0 + 1; x < x1; x += 3) {
      for (const s of [-1, 1]) rails.push({ size: [0.05, 0.55, 0.05], position: [x, CONV_Y + 0.6, CONV_Z + s * 0.68] });
    }
    b.mergeStatic(rails, m.yellow, { name: 'wh-conv-rail' });
    b.boxBody({ size: [len, 0.9, 1.45], position: [xc, CONV_Y + 0.4, CONV_Z] });
    // Legs (A-frames) every 6 m, skipping the course's underpass at x = -6.
    for (let x = x0 + 2; x < x1; x += 6) {
      if (Math.abs(x + 6) < 2.5) continue;
      for (const s of [-1, 1]) {
        b.beam({ from: [x - 0.6, 0, CONV_Z + s * 0.55], to: [x, CONV_Y - 0.2, CONV_Z + s * 0.55], width: 0.1, material: m.steel });
        b.beam({ from: [x + 0.6, 0, CONV_Z + s * 0.55], to: [x, CONV_Y - 0.2, CONV_Z + s * 0.55], width: 0.1, material: m.steel });
      }
    }
    // Boxes riding the belt.
    const riding = [];
    for (let x = x0 + 3; x < x1 - 2; x += rnd(b, 3.5, 7)) {
      riding.push({ size: [0.6, 0.45, 0.5], position: [x, CONV_Y + 0.4, CONV_Z + rnd(b, -0.2, 0.2)], rotationY: rnd(b, -0.3, 0.3) });
    }
    b.boxes(riding, m.cardboard, { collide: false });
  }

  /* ---------------------------------------------------------------------- *
   * Staging floor: pallet stacks, forklifts, wrapped goods, bins
   * ---------------------------------------------------------------------- */

  *_buildStaging(b) {
    const m = this._materials(b);
    // Zones kept clear of the racing line (see the course comment).
    const zones = [
      { x0: -40, x1: -12, z0: 25, z1: 58 },
      { x0: 24, x1: 40, z0: 34, z1: 58 },
    ];
    const stacks = [];
    const pallets = [];
    for (const zn of zones) {
      for (let x = zn.x0 + 1.5; x < zn.x1 - 1; x += 3.4) {
        for (let z = zn.z0 + 1.5; z < zn.z1 - 1; z += 3.6) {
          if (b.rng() < 0.35) continue;
          const n = rndInt(b, 1, 4);
          const jx = x + rnd(b, -0.4, 0.4);
          const jz = z + rnd(b, -0.4, 0.4);
          const ry = rnd(b, -0.1, 0.1) + (b.rng() < 0.3 ? Math.PI / 2 : 0);
          let y = 0;
          for (let i = 0; i < n; i++) {
            pallets.push({ size: [1.2, 0.14, 1.0], position: [jx, y + 0.07, jz], rotationY: ry });
            const h = rnd(b, 0.8, 1.3);
            stacks.push({ size: [1.15, h, 0.95], position: [jx, y + 0.14 + h / 2, jz], rotationY: ry, kind: b.rng() });
            y += 0.14 + h;
          }
        }
      }
      yield { progress: 0.7, label: 'Staging floor' };
    }
    b.boxes(pallets, m.crate, { collide: false });
    b.boxes(stacks.filter((s) => s.kind < 0.5), m.wrap, { collide: true });
    b.boxes(stacks.filter((s) => s.kind >= 0.5), m.cardboard, { collide: true });

    // Empty pallet piles (low obstacles in the open).
    const empty = [];
    for (const [x, z] of [[-10, 46], [26, 28], [-30, 18.5], [-36, 4], [22, -40], [26, -20]]) {
      const n = rndInt(b, 5, 14);
      empty.push({ size: [1.2, 0.15 * n, 1.0], position: [x, 0.075 * n, z], rotationY: rnd(b, 0, 1) });
    }
    b.boxes(empty, m.crate, { collide: true });

    // Forklifts: chassis, counterweight, overhead guard, mast + forks.
    const forklift = (x, z, ry, liftH) => {
      const rot = (lx, lz) => [x + lx * Math.cos(ry) + lz * Math.sin(ry), z - lx * Math.sin(ry) + lz * Math.cos(ry)];
      const at = (lx, y, lz, size, mat, collide = true) => {
        const [wx, wz] = rot(lx, lz);
        b.box({ size, position: [wx, y, wz], rotationY: ry, material: mat, collide });
      };
      at(0, 0.6, 0, [1.2, 0.9, 2.2], m.yellow);
      at(0, 0.8, 1.0, [1.15, 1.1, 0.5], m.dark);
      for (const [lx, lz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.6], [0.55, 0.6]]) {
        at(lx, 1.55, lz, [0.07, 1.4, 0.07], m.dark, false);
      }
      at(0, 2.25, 0.02, [1.2, 0.06, 1.3], m.dark);
      at(0, 1.6 + liftH / 2, -1.25, [0.9, 3.0 + liftH, 0.12], m.steel);
      at(-0.3, 0.1 + liftH, -1.85, [0.12, 0.06, 1.1], m.steel, false);
      at(0.3, 0.1 + liftH, -1.85, [0.12, 0.06, 1.1], m.steel, false);
    };
    forklift(-20, 30, 0.4, 0);
    forklift(30, 40, -1.1, 1.2);
    forklift(-30, -22, Math.PI / 2, 2.4);
    forklift(26, -36, 0.2, 0);

    // Oil stains and floor debris.
    const oil = b.tex(oilStainTexture(2140, [1, 1]));
    for (const [x, z, s] of [[-20, 32, 3], [30, 40, 2.5], [4, 30, 3.5], [-6, -8, 2.5], [10, -44, 3]]) {
      b.decal({ size: [s, s], position: [x, 0.012, z], tiltX: -Math.PI / 2, texture: oil, opacity: 0.75 });
    }
    const debrisGeo = b.geometry('wh-debris', () => new THREE.BoxGeometry(1, 0.04, 1));
    const debris = [];
    for (let i = 0; i < 220; i++) {
      debris.push({
        position: [rnd(b, -HALF_W + 2, HALF_W - 2), 0.02, rnd(b, -HALF_L + 2, HALF_L - 2)],
        rotationY: rnd(b, 0, Math.PI * 2),
        scale: [rnd(b, 0.2, 1.2), 1, rnd(b, 0.2, 1.0)],
      });
    }
    b.instanced(debrisGeo, m.dark, debris);
  }

  /* ---------------------------------------------------------------------- *
   * Truck yard outside the south dock doors
   * ---------------------------------------------------------------------- */

  _buildYard(b) {
    const m = this._materials(b);
    const depth = YARD_Z1 - HALF_L;
    const zc = (HALF_L + YARD_Z1) / 2;
    // Yard slab (top at YARD_Y) and the dock face below the doors.
    const slab = b.box({ size: [W + 20, 1, depth], position: [0, YARD_Y - 0.5, zc], material: m.asphalt });
    slab.receiveShadow = true;
    b.box({ size: [W, -YARD_Y + 0.02, 1.2], position: [0, YARD_Y / 2, HALF_L + 0.6], material: m.floor });
    // Dock levellers outside each open door.
    for (const dx of this._openDoors) {
      b.box({ size: [2.2, 0.1, 2.2], position: [dx, -0.05, HALF_L + 1.1], material: m.steel });
    }
    // Trailers at the closed doors (box, chassis, wheels).
    for (const dx of [-30, -6, 18]) {
      const tz = HALF_L + 1.3 + 6.8;
      b.box({ size: [2.55, 2.8, 13.6], position: [dx, YARD_Y + 1.25 + 1.4, tz], material: m.wall });
      b.box({ size: [2.4, 0.3, 13.2], position: [dx, YARD_Y + 1.1, tz], material: m.dark });
      for (const wz of [tz + 4.5, tz + 5.8]) {
        for (const sx of [-1, 1]) {
          b.box({ size: [0.4, 1.0, 1.0], position: [dx + sx * 1.0, YARD_Y + 0.5, wz], material: m.dark, collide: false });
        }
      }
      b.boxBody({ size: [2.4, 1.0, 3], position: [dx, YARD_Y + 0.5, tz + 5.2] });
      b.box({ size: [0.2, 1.0, 0.2], position: [dx - 1, YARD_Y + 0.5, tz - 5], material: m.dark });
      b.box({ size: [0.2, 1.0, 0.2], position: [dx + 1, YARD_Y + 0.5, tz - 5], material: m.dark });
    }
    // Perimeter fence (chain-link) around the yard.
    const fenceH = 3;
    const runs = [
      { x: 0, z: YARD_Z1, w: W + 20, d: 0.06 },
      { x: -HALF_W - 10, z: zc, w: 0.06, d: depth },
      { x: HALF_W + 10, z: zc, w: 0.06, d: depth },
    ];
    for (const r of runs) {
      const g = b.geometry(`wh-fence:${r.w}:${r.d}`, () => new THREE.PlaneGeometry(Math.max(r.w, r.d), fenceH));
      const f = new THREE.Mesh(g, m.fence);
      f.position.set(r.x, YARD_Y + fenceH / 2, r.z);
      if (r.w < 1) f.rotation.y = Math.PI / 2;
      b.root.add(f);
      b.boxBody({ size: [Math.max(r.w, 0.1), fenceH, Math.max(r.d, 0.1)], position: [r.x, YARD_Y + fenceH / 2, r.z], surface: 'soft' });
      const len = Math.max(r.w, r.d);
      for (let t = -len / 2; t <= len / 2; t += 3) {
        const px = r.w > 1 ? r.x + t : r.x;
        const pz = r.w > 1 ? r.z : r.z + t;
        b.box({ size: [0.06, fenceH, 0.06], position: [px, YARD_Y + fenceH / 2, pz], material: m.steel, collide: false });
      }
    }
    // Yard lamp masts.
    for (const x of [-24, 24]) {
      b.box({ size: [0.25, 10, 0.25], position: [x, YARD_Y + 5, YARD_Z1 - 4], material: m.steel });
      b.box({ size: [1.2, 0.2, 0.5], position: [x, YARD_Y + 10, YARD_Z1 - 4.4], material: m.fixture, collide: false });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Lighting and dust
   * ---------------------------------------------------------------------- */

  _buildLighting(b) {
    const m = this._materials(b);
    b.addLight(new THREE.HemisphereLight(0xa9bdd0, 0x2a2b2e, 0.9));

    // High-bay fixtures: emissive discs on drop rods, a handful of real lights.
    const fixGeo = b.geometry('wh-highbay', () => new THREE.CylinderGeometry(0.45, 0.6, 0.35, 12));
    const fix = [];
    const rods = [];
    for (let z = -52; z <= 52; z += 13) {
      for (const x of [-30, -12, 6, 24]) {
        fix.push({ position: [x, H - 2.2, z] });
        rods.push({ size: [0.04, 2.0, 0.04], position: [x, H - 1.1, z] });
      }
    }
    const fm = b.instanced(fixGeo, m.fixture, fix);
    if (fm) fm.userData.noCastShadow = true;
    const rm = b.mergeStatic(rods, m.dark, { name: 'wh-rods' });
    if (rm) rm.userData.noCastShadow = true;
    const lamps = [[-12, -40], [6, -14], [-12, 12], [6, 38], [24, -40], [-30, 38]];
    lamps.forEach(([x, z], i) => {
      const l = new THREE.PointLight(0xffe0b0, 160, 34, 2);
      l.position.set(x, H - 2.6, z);
      b.addLight(l);
      if (i === 2) this._flicker = l;
    });
    // Mezzanine office glow.
    const office = new THREE.PointLight(0xcfe0ff, 60, 18, 2);
    office.position.set(MEZ_X0 + 8, MEZ_Y + 2.2, MEZ_Z0 + 8);
    b.addLight(office);

    this._dust = b.dustCloud({
      count: 1100, area: [W - 4, H - 2, L - 4], center: [0, (H - 2) / 2 + 0.5, 0],
      color: 0xe8e0d0, size: 0.06, opacity: 0.5, seed: 2299,
    });
  }

  /* ---------------------------------------------------------------------- *
   * Race course
   * ---------------------------------------------------------------------- */

  /**
   * Down the staging floor, under the conveyor, north along an aisle, west
   * through the cross-aisle, up another aisle, over the top of the racking,
   * dive back into an aisle, east under nothing to the mezzanine, hairpin on
   * the deck, over the conveyor and out of dock door 4 into the yard.
   */
  _buildGates(b) {
    const hazard = ['#e8b21e', '#16181c'];
    const layout = [
      { x: 0, y: 1.6, z: 38 },                                  // 1 staging straight
      { x: -6, y: 2.0, z: CONV_Z },                             // 2 under the conveyor
      { x: -6, y: 3.0, z: 0 },                                  // 3 aisle
      { x: -22, y: 2.6, z: -22 },                               // 4 cross-aisle
      { x: -22, y: 5.5, z: -40 },                               // 5 up the next aisle
      { x: -14, y: 13.6, z: -50, legs: false },                 // 6 over the racking
      { x: 10, y: 4.0, z: -36 },                                // 7 dive into the aisle
      { x: 10, y: 2.5, z: 4 },                                  // 8 aisle exit
      { x: 26, y: 2.2, z: 10 },                                 // 9 open floor
      { x: 36, y: 7.8, z: -12, ground: MEZ_Y + 0.15 },          // 10 mezzanine hairpin
      { x: 20, y: 7.6, z: CONV_Z, legs: false },                // 11 over the conveyor
      { x: 5, y: 1.8, z: HALF_L + 8, ground: YARD_Y, w: 2.6, h: 2.6 }, // 12 out the dock door
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 2.0, padColors: hazard, beaconHeight: 6,
    });
    // Hang the floating gates from the truss on chains.
    const m = this._materials(b);
    for (const gi of [5, 10]) {
      const g = this.gates[gi];
      const top = g.position.y + 1.15;
      for (const s of [-1, 1]) {
        const x = g.position.x + g.right.x * 1.1 * s;
        const z = g.position.z + g.right.z * 1.1 * s;
        b.box({ size: [0.04, H - top, 0.04], position: [x, (H + top) / 2, z], material: m.dark, collide: false });
      }
    }
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  update(dt, elapsed) {
    if (this._dust) {
      try { this._dust.update(dt, elapsed); } catch (_e) { /* ignore */ }
    }
    if (this._flicker) {
      const f = Math.sin(elapsed * 17.7) * Math.sin(elapsed * 5.3);
      this._flicker.intensity = f > 0.42 ? 20 : 160;
    }
  }

  updatePropwash(pos, motor) {
    if (!pos || !this._dust) return;
    try {
      this._dust.kick(pos.x, pos.y, pos.z, 2.2, 0.3 + (Number.isFinite(motor) ? motor : 0) * 1.4);
    } catch (_e) { /* ignore */ }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._dust = null;
    this._flicker = null;
    this._skylights = null;
    this.gates = [];
    scene.background = this._prevBackground ?? null;
    scene.fog = this._prevFog ?? null;
  }
}
