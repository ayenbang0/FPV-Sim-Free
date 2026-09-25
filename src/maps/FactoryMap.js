/**
 * maps/FactoryMap.js
 * ---------------------------------------------------------------------------
 * Abandoned Factory — a derelict French machine works at full scale.
 *
 * A 120 x 88 m machine hall with 24 m walls (8x the volume of the previous
 * 60 x 44 m hall), half roofed and half collapsed open to the sky, plus a
 * 64 m courtyard annex. Structures are full size — 10 m transfer presses you
 * fly *through*, 10 m process tanks, a two-storey mezzanine office, a catwalk
 * bridge across the hall at 6 m — while everything human-scale (drums,
 * handrails, stairs, pallets, trees, the flatbed) stays exactly real-size, so
 * the space reads as big rather than as a toy blown up.
 *
 * The yard: a 56 m brick chimney stack, a four-storey office block, a water
 * tower and a row of pollarded plane trees behind brick walls.
 *
 * Lit by the physically based sky: the standing roof and walls cast real
 * shadows (the frustum is pinned over the whole site), so the roofed north
 * half is dim and striped with skylight beams while the collapsed south half
 * and the yard sit in full sun.
 *
 * Twelve gates: conveyor straight, a double press slalom through the press
 * slots, a low cut, the mezzanine rail gap, a gate hung over the bridge, the
 * tank row, a scaffold gate in the roof hole, out of the wagon door, the
 * chimney yard, a gate cantilevered off the chimney, and the finish.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import {
  concreteTexture, corrugatedMetalTexture, rustTexture,
  crateWoodTexture, paintedMetalTexture, brickTexture, foliageTexture,
  grimeTexture, oilStainTexture, graffitiTexture, hazardTexture,
} from '../assets/procedural.js';

const W = 120;            // hall width  (x)
const L = 88;             // hall length (z)
const H = 24;             // wall / eaves height
const HALF_W = W / 2;
const HALF_L = L / 2;
const WALL_T = 0.6;
const MEZZ_Y = 6;         // mezzanine / bridge deck height
const ROOF_Y = H;         // standing roof plane (north half only)
// Courtyard annex east of the hall.
const YARD_X0 = HALF_W;   // 60
const YARD_X1 = 124;
const YARD_Z0 = -24;
const YARD_Z1 = 44;
const YARD_WALL_H = 3;
const CHIMNEY = { x: 100, z: 28, h: 56, r0: 4.8, r1: 3.0 };
const PRESSES = [[28, -24], [28, 4]];

export const FACTORY_META = {
  id: 'factory',
  displayName: 'Abandoned Factory',
  description: 'French machine works at full scale: 120 m hall, fly-through presses, mezzanine, 56 m chimney yard.',
  accent: 'linear-gradient(160deg, #c98f4a 0%, #7a5a34 50%, #33302b 100%)',
  category: 'Racing',
  size: '120 × 88 × 24 m hall + yard',
  gates: 12,
  courseKey: 'factory.v2',
  outdoor: true,
  ambient: 'warehouse',
};

export class FactoryMap {
  constructor() {
    this.id = 'factory';
    // South door end, facing north (-Z) down the conveyor line.
    this.spawnPoint = new THREE.Vector3(0, 0.12, HALF_L - 6);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF_W - 6, -3, -HALF_L - 6),
      max: new THREE.Vector3(YARD_X1 + 6, CHIMNEY.h + 20, Math.max(HALF_L, YARD_Z1) + 6),
    };
    this.viewDistance = 1200;
    this.link = { range: 180, indoor: true };
    this.environment = {
      mode: 'outdoor',
      sunElevation: 46,
      sunAzimuth: 118,
      turbidity: 4.2,
      clouds: 0.38,
      exposure: 0.56,
      envIntensity: 0.55,
      hemiIntensity: 0.12,
      fogDensity: 0.0016,
      groundColor: 0x6a655a,
      shadowRange: 100,
      shadowFocus: [32, 0, 0],
    };
    this.builder = null;
    this._dust = null;
    this._yardDust = null;
    this._flicker = null;
    this._flickerBase = 160;
  }

  getGroundHeight() {
    return 0;
  }

  /* ====================================================================== *
   * Build
   * ====================================================================== */

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 9001, name: 'factory-map', streaming: { cellSize: 32 } });
    this.builder = b;

    yield { progress: 0.04, label: 'Slab & walls' };
    this._buildShell(b);
    yield { progress: 0.18, label: 'Roof' };
    yield* this._buildRoof(b);
    yield { progress: 0.36, label: 'Mezzanine' };
    this._buildMezzanine(b);
    yield { progress: 0.48, label: 'Machines' };
    yield* this._buildMachines(b);
    yield { progress: 0.64, label: 'Clutter' };
    yield* this._buildClutter(b);
    yield { progress: 0.74, label: 'Yard' };
    yield* this._buildYard(b);
    yield { progress: 0.88, label: 'Atmosphere' };
    this._buildAtmosphere(b);
    yield { progress: 0.94, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.6 });
    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;
    const floorTex = b.tex(concreteTexture(9002, [26, 20]));
    const wallTex = b.tex(corrugatedMetalTexture(9003, [26, 6]));
    const rustTex = b.tex(rustTexture(9004, [2, 2]));
    const crateTex = b.tex(crateWoodTexture(9005, [1, 1]));
    const steelTex = b.tex(paintedMetalTexture(9006, [2, 2], [104, 100, 94]));
    const darkTex = b.tex(paintedMetalTexture(9007, [2, 2], [52, 54, 58]));
    const vendorUrl = 'assets/vendor/concrete-albedo.jpg';
    this._mats = {
      floor: b.material('fac-floor', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: floorTex, roughness: 0.95 });
        b.ccTexture(vendorUrl, mat, [26, 20]);
        return mat;
      }),
      wall: b.material('fac-wall', () => new THREE.MeshStandardMaterial({
        color: wallTex ? 0xcfc9bd : 0x6a655c, map: wallTex, roughness: 0.8, metalness: 0.3,
      })),
      rust: b.material('fac-rust', () => new THREE.MeshStandardMaterial({
        color: rustTex ? 0xffffff : 0x7a4426, map: rustTex, roughness: 0.95, metalness: 0.2,
      })),
      crate: b.material('fac-crate', () => new THREE.MeshStandardMaterial({
        color: crateTex ? 0xffffff : 0x9a7a50, map: crateTex, roughness: 0.92,
      })),
      steel: b.material('fac-steel', () => new THREE.MeshStandardMaterial({
        color: steelTex ? 0xffffff : 0x767b81, map: steelTex, roughness: 0.55, metalness: 0.65,
      })),
      dark: b.material('fac-dark', () => new THREE.MeshStandardMaterial({
        color: darkTex ? 0xffffff : 0x2a2c30, map: darkTex, roughness: 0.8, metalness: 0.45,
      })),
      hazard: b.material('fac-hazard', () => {
        const hz = b.tex(hazardTexture(9008, [6, 1]));
        return new THREE.MeshStandardMaterial({ color: hz ? 0xffffff : 0xc9a227, map: hz, roughness: 0.85 });
      }),
      glowWindow: b.material('fac-glow-window', () => new THREE.MeshBasicMaterial({
        color: 0xcfe4f2, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      })),
      glowSodium: b.material('fac-glow-sodium', () => new THREE.MeshBasicMaterial({ color: 0xffb45e })),
      belt: b.material('fac-belt', () => new THREE.MeshStandardMaterial({
        color: 0x1d1f22, roughness: 0.95, metalness: 0.1,
      })),
      brick: b.material('fac-brick', () => {
        const bt = b.tex(brickTexture(9201, [10, 4]));
        return new THREE.MeshStandardMaterial({ color: bt ? 0xffffff : 0x8a4a38, map: bt, roughness: 0.92 });
      }),
      brickTall: b.material('fac-brick-tall', () => {
        const bt = b.tex(brickTexture(9203, [6, 24]));
        return new THREE.MeshStandardMaterial({ color: bt ? 0xffffff : 0x8a4a38, map: bt, roughness: 0.92 });
      }),
      leaf: b.material('fac-leaf', () => {
        const lt = b.tex(foliageTexture(9202));
        return new THREE.MeshStandardMaterial({ color: lt ? 0xffffff : 0x4a7038, map: lt, roughness: 0.9 });
      }),
    };
    return this._mats;
  }

  /* ---------------------------------------------------------------------- *
   * Shell: slab, perimeter walls, window band, doors, column grid
   * ---------------------------------------------------------------------- */

  _buildShell(b) {
    const m = this._materials(b);
    b.floor({ width: W + 60, depth: L + 60, y: -0.02, position: [20, 0, 0], material: m.floor });
    b.box({ size: [W, 0.24, L], position: [0, -0.12, 0], material: m.floor });

    // West + north walls, full height.
    b.box({ size: [WALL_T, H, L], position: [-HALF_W, H / 2, 0], material: m.wall });
    b.box({ size: [W, H, WALL_T], position: [0, H / 2, -HALF_L], material: m.wall });

    // East wall: an 8 m rail-wagon door onto the yard (z 4..12, 8 m tall).
    {
      const doorH = 8;
      const dz0 = 4;
      const dz1 = 12;
      for (const s of [
        { z0: -HALF_L, z1: dz0, h: H, y0: 0 },
        { z0: dz1, z1: HALF_L, h: H, y0: 0 },
        { z0: dz0, z1: dz1, h: H - doorH, y0: doorH },
      ]) {
        b.box({
          size: [WALL_T, s.h, s.z1 - s.z0],
          position: [HALF_W, s.y0 + s.h / 2, (s.z0 + s.z1) / 2], material: m.wall,
        });
      }
      // Sliding door leaf, parked half open beside the opening.
      b.box({ size: [0.2, doorH - 0.3, 6.4], position: [HALF_W - 0.7, doorH / 2, dz1 + 3.6], material: m.rust });
      b.box({ size: [0.3, 0.3, 16], position: [HALF_W - 0.7, doorH + 0.3, dz1 + 2], material: m.dark });
    }

    // South wall: a 14 x 10 m roller door behind the spawn.
    const doorW = 14;
    const doorH = 10;
    const sideW = (W - doorW) / 2;
    for (const s of [-1, 1]) {
      b.box({ size: [sideW, H, WALL_T], position: [s * (W / 2 - sideW / 2), H / 2, HALF_L], material: m.wall });
    }
    b.box({ size: [doorW, H - doorH, WALL_T], position: [0, doorH + (H - doorH) / 2, HALF_L], material: m.wall });
    const drum = b.cylinder({
      radiusTop: 0.8, radiusBottom: 0.8, height: doorW, segments: 12,
      position: [0, doorH + 0.8, HALF_L - 0.2], material: m.rust, collide: false,
    });
    drum.rotation.z = Math.PI / 2;
    b.boxBody({ size: [doorW, 1.6, 1.6], position: [0, doorH + 0.8, HALF_L - 0.2] });

    // Clerestory glazing band on both long walls (emissive, sealed).
    const paneGeo = b.geometry('fac-pane', () => new THREE.PlaneGeometry(5.6, 3.2));
    for (const sx of [-1, 1]) {
      for (let z = -HALF_L + 5; z <= HALF_L - 5; z += 8) {
        if ((Math.round(z) * 13 + sx * 7) % 3 === 0) continue;   // missing pane = dark bay
        const pane = new THREE.Mesh(paneGeo, m.glowWindow);
        pane.position.set(sx * (HALF_W - WALL_T / 2 - 0.08), H - 4.5, z);
        pane.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
        b.root.add(pane);
      }
    }

    // Column grid: full height under the standing roof (north), broken stubs
    // where it collapsed (south) — the stubs are low racing obstacles.
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -2; iz <= 2; iz++) {
        const x = ix * 20;
        const z = iz * 15;
        if (Math.abs(x) < 3 && Math.abs(z) < 3) continue;
        if (z <= 0) {
          b.box({ size: [1.0, H, 1.0], position: [x, H / 2, z], material: m.steel });
        } else {
          const stubH = 4.4 + ((ix * 5 + iz * 3 + 20) % 4) * 1.8;
          b.box({ size: [1.0, stubH, 1.0], position: [x, stubH / 2, z], material: m.rust });
          if ((ix + iz) % 3 === 0) {
            b.box({ size: [0.4, 2.0, 0.4], position: [x + 0.2, stubH + 0.8, z], rotation: [0.3, 0, 0.2], material: m.rust });
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- *
   * Roof: standing deck with skylights over the north half; collapsed south
   * ---------------------------------------------------------------------- */

  *_buildRoof(b) {
    const m = this._materials(b);
    // Deck over the north half, built around 8 skylight openings.
    const skyX = [-30, -10, 10, 30];
    const skyZ = [-32, -16];
    const SW = 6.4;
    const SL = 12;
    this._skylights = [];
    const deck = [];
    const xEdges = [-HALF_W];
    for (const x of skyX) xEdges.push(x - SW / 2, x + SW / 2);
    xEdges.push(HALF_W);
    for (let i = 0; i < xEdges.length - 1; i++) {
      const x0 = xEdges[i];
      const x1 = xEdges[i + 1];
      if (i % 2 === 0) {
        deck.push({ size: [x1 - x0, 0.5, HALF_L], position: [(x0 + x1) / 2, ROOF_Y + 0.25, -HALF_L / 2] });
        continue;
      }
      let z = -HALF_L;
      for (const cz of skyZ) {
        deck.push({ size: [x1 - x0, 0.5, cz - SL / 2 - z], position: [(x0 + x1) / 2, ROOF_Y + 0.25, (z + cz - SL / 2) / 2] });
        z = cz + SL / 2;
        this._skylights.push({ x: (x0 + x1) / 2, z: cz });
      }
      deck.push({ size: [x1 - x0, 0.5, -z], position: [(x0 + x1) / 2, ROOF_Y + 0.25, z / 2] });
    }
    b.mergeStatic(deck, m.dark, { name: 'fac-roof' });
    b.collideParts(deck);
    // Ragged edge where the roof tore away.
    for (let x = -HALF_W + 2; x < HALF_W; x += 6) {
      b.box({
        size: [5.5, 0.4, rnd(b, 1, 4)], position: [x, ROOF_Y + 0.1 - rnd(b, 0, 0.6), rnd(b, 0.5, 2)],
        rotation: [rnd(b, -0.3, 0.1), 0, rnd(b, -0.08, 0.08)], material: m.dark,
      });
    }

    // Portal trusses under the standing deck (merged: one draw call).
    const parts = [];
    for (let z = -HALF_L + 4; z <= -2; z += 8) {
      parts.push({ size: [W - 1, 0.5, 0.5], position: [0, ROOF_Y - 2.4, z] });
      parts.push({ size: [W - 1, 0.4, 0.4], position: [0, ROOF_Y - 0.4, z] });
      const bays = 16;
      const bw = (W - 1) / bays;
      for (let i = 0; i < bays; i++) {
        const x0 = -(W - 1) / 2 + i * bw;
        parts.push(MapBuilder.beamPart([x0, ROOF_Y - 2.4, z], [x0 + bw, ROOF_Y - 0.4, z], 0.2));
        parts.push({ size: [0.2, 2.0, 0.2], position: [x0, ROOF_Y - 1.4, z] });
      }
      b.boxBody({ size: [W - 1, 0.6, 0.6], position: [0, ROOF_Y - 2.4, z] });
      yield { progress: 0.18 + 0.1 * ((z + HALF_L) / HALF_L), label: 'Roof' };
    }
    for (let x = -HALF_W + 4; x <= HALF_W - 4; x += 8) {
      parts.push({ size: [0.24, 0.24, HALF_L - 2], position: [x, ROOF_Y - 0.2, -HALF_L / 2] });
    }
    b.mergeStatic(parts, m.steel, { name: 'factory-truss' });

    // Collapsed half: fallen trusses, a leaning roof slab against the east
    // wall, and dangling purlins — the roof-hole dive backdrop.
    b.beam({ from: [-26, 0.3, 14], to: [-2, 9, 26], width: 0.9, height: 1.2, material: m.steel });
    b.beam({ from: [6, 0.4, 36], to: [26, 6.5, 20], width: 0.9, height: 1.2, material: m.rust });
    b.beam({ from: [-44, 0.3, 30], to: [-30, 12, 8], width: 0.7, height: 0.9, material: m.rust });
    b.box({ size: [18, 0.8, 10], position: [HALF_W - 8, 5.2, 16], rotation: [0, 0.2, 0.5], material: m.dark });
    for (const [x, z, len] of [[-18, 2, 9], [14, 3, 7], [36, 1, 11]]) {
      b.beam({ from: [x, ROOF_Y - 0.4, z - 1], to: [x + 1.5, ROOF_Y - len, z + 4], width: 0.25, material: m.steel });
    }
    // Chains from the standing deck.
    const chainGeo = b.geometry('fac-chain', () => new THREE.CylinderGeometry(0.05, 0.05, 6, 5));
    for (const [x, z] of [[-24, -24], [12, -12], [-40, -34], [44, -30]]) {
      const c = new THREE.Mesh(chainGeo, m.dark);
      c.position.set(x, ROOF_Y - 5.4, z);
      b.root.add(c);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Mezzanine office (west) + catwalk bridge across the hall
   * ---------------------------------------------------------------------- */

  _buildMezzanine(b) {
    const m = this._materials(b);
    const deckX = -HALF_W + 10;      // deck centre, 20 m deep
    const deckW = 20;
    const z0 = -36;
    const z1 = 4;
    b.box({ size: [deckW, 0.35, z1 - z0], position: [deckX, MEZZ_Y, (z0 + z1) / 2], material: m.steel });
    for (let z = z0 + 2; z <= z1 - 1; z += 6) {
      for (const dx of [-7, 0, 7]) {
        b.box({ size: [0.4, MEZZ_Y - 0.2, 0.4], position: [deckX + dx, (MEZZ_Y - 0.2) / 2, z], material: m.steel });
      }
    }
    // Railing on the open (east) edge; z -12..-4 left open for gate 5.
    const ex = deckX + deckW / 2 - 0.15;
    const rails = [];
    for (let z = z0; z <= z1; z += 2) {
      if (z > -12.5 && z < -3.5) continue;
      rails.push({ size: [0.07, 1.05, 0.07], position: [ex, MEZZ_Y + 0.7, z] });
    }
    for (const [a, c] of [[z0, -12], [-4, z1]]) {
      rails.push({ size: [0.09, 0.09, c - a], position: [ex, MEZZ_Y + 1.2, (a + c) / 2] });
      b.boxBody({ size: [0.12, 1.1, c - a], position: [ex, MEZZ_Y + 0.7, (a + c) / 2] });
    }
    b.mergeStatic(rails, m.steel, { name: 'mezz-rail' });

    // Offices: two partition walls with a window band, desks, cabinets.
    for (const pz of [-28, -18]) {
      b.box({ size: [deckW - 2, 0.9, 0.15], position: [deckX - 1, MEZZ_Y + 0.63, pz], material: m.wall });
      b.box({ size: [deckW - 2, 0.9, 0.15], position: [deckX - 1, MEZZ_Y + 2.65, pz], material: m.wall });
      for (let px = -8; px <= 6; px += 3.5) {
        b.box({ size: [0.6, 1.1, 0.15], position: [deckX + px, MEZZ_Y + 1.63, pz], material: m.wall });
      }
    }
    for (const [dx, dz] of [[-4, -23], [3, -23], [-4, -32], [4, -33]]) {
      b.box({ size: [1.6, 0.75, 0.8], position: [deckX + dx, MEZZ_Y + 0.55, dz], material: m.crate });
    }
    b.box({ size: [1.0, 1.9, 0.6], position: [deckX - 8, MEZZ_Y + 1.12, -34], material: m.dark });
    b.box({ size: [deckW, 3.2, 0.2], position: [deckX, MEZZ_Y + 1.8, z0], material: m.wall });

    // Stair from the floor (south) up to the deck edge at z = 4.
    const steps = 20;
    for (let i = 0; i < steps; i++) {
      b.box({
        size: [1.6, 0.12, 0.6],
        position: [deckX + 6, 0.2 + (i * (MEZZ_Y - 0.2)) / (steps - 1), 16 - i * 0.6],
        material: m.steel,
      });
    }

    // Catwalk bridge across the hall at deck height (z = -8).
    const bx0 = -40;
    const bx1 = 52;
    const bl = bx1 - bx0;
    const bcx = (bx0 + bx1) / 2;
    b.box({ size: [bl, 0.25, 2.0], position: [bcx, MEZZ_Y, -8], material: m.steel });
    const brails = [];
    for (let x = bx0; x <= bx1; x += 2.2) {
      brails.push({ size: [0.07, 1.0, 0.07], position: [x, MEZZ_Y + 0.62, -8.95] });
      brails.push({ size: [0.07, 1.0, 0.07], position: [x, MEZZ_Y + 0.62, -7.05] });
    }
    brails.push({ size: [bl, 0.08, 0.08], position: [bcx, MEZZ_Y + 1.12, -8.95] });
    brails.push({ size: [bl, 0.08, 0.08], position: [bcx, MEZZ_Y + 1.12, -7.05] });
    b.mergeStatic(brails, m.steel, { name: 'bridge-rail' });
    b.boxBody({ size: [bl, 1.0, 0.1], position: [bcx, MEZZ_Y + 0.62, -8.95] });
    b.boxBody({ size: [bl, 1.0, 0.1], position: [bcx, MEZZ_Y + 0.62, -7.05] });
    for (let x = bx0 + 6; x <= bx1 - 2; x += 12) {
      if (Math.abs(x - 6) < 3) continue;   // keep the hung gate clear
      for (const z of [-8.95, -7.05]) {
        b.box({ size: [0.1, ROOF_Y - 2.6 - MEZZ_Y, 0.1], position: [x, (ROOF_Y - 2.6 + MEZZ_Y) / 2, z], material: m.dark, collide: false });
      }
    }
  }

  /* ---------------------------------------------------------------------- *
   * Machines: presses, tanks, pipes, conveyor
   * ---------------------------------------------------------------------- */

  *_buildMachines(b) {
    const m = this._materials(b);

    // Two big transfer presses. Each is a real portal: two columns, a crown
    // beam and a hazard-striped bed, with a 5.2 m wide slot under the crown
    // (a ram block hangs in it at 4-5.4 m). Flown through along Z.
    for (const [px, pz] of PRESSES) {
      b.box({ size: [9.4, 1.0, 6.8], position: [px, 0.5, pz], material: m.hazard });
      for (const s of [-1, 1]) {
        b.box({ size: [2.0, 8.4, 6.4], position: [px + s * 3.6, 5.2, pz], material: m.rust });
      }
      b.box({ size: [9.2, 2.4, 6.4], position: [px, 10.6, pz], material: m.dark });
      b.box({ size: [2.4, 1.4, 3.2], position: [px, 4.7, pz], material: m.steel });
      b.box({ size: [0.3, 5.2, 0.3], position: [px, 7.3, pz], material: m.steel });
      // Control pendant and a walkway on top.
      b.box({ size: [0.5, 1.4, 0.4], position: [px + 5.2, 1.6, pz + 2.8], material: m.dark });
      b.box({ size: [9.2, 0.1, 1.2], position: [px, 11.9, pz + 3.8], material: m.steel });
      yield { progress: 0.5, label: 'Machines' };
    }

    // Vertical process tanks.
    for (const [tx, tz] of [[-12, -28], [-12, -19], [-2, -32]]) {
      b.cylinder({
        radiusTop: 3.2, radiusBottom: 3.2, height: 10.4, segments: 20,
        position: [tx, 5.2, tz], material: m.steel,
      });
      b.cylinder({
        radiusTop: 0.35, radiusBottom: 0.35, height: 2.4, segments: 8,
        position: [tx, 11.6, tz], material: m.rust,
      });
      // Ladder cage up the side.
      b.box({ size: [0.6, 10.4, 0.08], position: [tx + 3.3, 5.2, tz], material: m.dark, collide: false });
    }
    yield { progress: 0.56, label: 'Machines' };

    // Pipe runs along the east wall + droppers to the presses.
    for (const py of [11.2, 12.6]) {
      const pipe = b.cylinder({
        radiusTop: 0.45, radiusBottom: 0.45, height: L - 12, segments: 10,
        position: [HALF_W - 2, py, 0], material: m.rust, collide: false,
      });
      pipe.rotation.x = Math.PI / 2;
      b.boxBody({ size: [0.9, 0.9, L - 12], position: [HALF_W - 2, py, 0] });
    }
    for (const [, pz] of PRESSES) {
      b.beam({ from: [HALF_W - 2, 11.2, pz], to: [33.5, 7.8, pz], width: 0.4, material: m.rust });
    }

    // Conveyor line down the centre: belt, legs, drive drums, pallets.
    const cz0 = -32;
    const cz1 = 20;
    const cx = 8;
    b.box({ size: [1.8, 0.3, cz1 - cz0], position: [cx, 1.0, (cz0 + cz1) / 2], material: m.belt });
    for (let z = cz0 + 2; z <= cz1 - 2; z += 4) {
      for (const ox of [-0.7, 0.7]) b.box({ size: [0.12, 1.0, 0.12], position: [cx + ox, 0.5, z], material: m.dark });
    }
    for (const dz of [cz0, cz1]) {
      const d = b.cylinder({
        radiusTop: 0.4, radiusBottom: 0.4, height: 1.8, segments: 10,
        position: [cx, 1.0, dz], material: m.rust, collide: false,
      });
      d.rotation.z = Math.PI / 2;
      b.boxBody({ size: [1.8, 0.8, 0.8], position: [cx, 1.0, dz] });
    }
    for (let z = cz0 + 4; z < cz1 - 2; z += 6) {
      b.box({
        size: [1.3, 0.7, 1.1], position: [cx, 1.5, z],
        rotationY: rnd(b, -0.15, 0.15), material: m.crate, collide: false,
      });
    }
    // A second, raised conveyor feeding the presses at 3.2 m.
    b.box({ size: [12, 0.3, 1.4], position: [16, 3.2, -10], material: m.belt });
    for (const x of [11, 16, 21]) b.box({ size: [0.15, 3.1, 0.15], position: [x, 1.55, -10], material: m.dark });
    yield { progress: 0.62, label: 'Machines' };
  }

  /* ---------------------------------------------------------------------- *
   * Clutter: barrels, crates, rubble, pallets, decals
   * ---------------------------------------------------------------------- */

  *_buildClutter(b) {
    const m = this._materials(b);

    // Oil drums: real size, clustered in groups around the hall.
    const drumGeo = b.geometry('fac-drum', () => new THREE.CylinderGeometry(0.29, 0.29, 0.88, 12));
    const drums = [];
    const groups = [[-28, 16], [20, 20], [-36, -4], [40, -12], [-4, 24], [44, 24], [-50, 20], [16, -36], [-30, -40]];
    for (const [gx, gz] of groups) {
      const n = 3 + Math.floor(b.rng() * 6);
      for (let i = 0; i < n; i++) {
        const dx = gx + rnd(b, -1.6, 1.6);
        const dz = gz + rnd(b, -1.6, 1.6);
        const tipped = b.rng() < 0.2;
        drums.push(tipped
          ? { position: [dx, 0.3, dz], rotation: [Math.PI / 2, rnd(b, 0, 6), 0] }
          : { position: [dx, 0.44, dz], rotationY: rnd(b, 0, 6.28) });
        b.boxBody({ size: tipped ? [0.9, 0.6, 0.6] : [0.58, 0.88, 0.58], position: [dx, tipped ? 0.3 : 0.44, dz] });
      }
    }
    b.instanced(drumGeo, m.rust, drums);

    // Crate stacks worth hiding behind.
    const crates = [
      [-20, 24, 1.4], [24, -4, 1.2], [-24, -32, 1.5], [12, 28, 1.1], [36, 12, 1.3],
      [-40, 8, 1.0], [0, -36, 1.2], [-32, 24, 1.0], [48, -30, 1.4], [-50, 34, 1.2],
      [30, 34, 1.3], [-8, 36, 1.1],
    ];
    let i = 0;
    for (const [cx, cz, s] of crates) {
      b.box({ size: [s, s, s], position: [cx, s / 2, cz], rotationY: rnd(b, 0, 1.2), material: m.crate });
      if (i % 2 === 0) {
        b.box({
          size: [s * 0.7, s * 0.7, s * 0.7], position: [cx + 0.2, s + s * 0.35, cz],
          rotationY: rnd(b, 0, 1.2), material: m.crate,
        });
      }
      if ((++i & 3) === 0) yield { progress: 0.66, label: 'Clutter' };
    }

    // Rubble field in the collapsed half (instanced chunks, the big ones solid).
    const chunkGeo = b.geometry('fac-chunk', () => new THREE.BoxGeometry(1, 1, 1));
    const chunks = [];
    for (let k = 0; k < 440; k++) {
      const x = rnd(b, -HALF_W + 3, HALF_W - 3);
      const z = rnd(b, 3, HALF_L - 3);
      if (Math.abs(x) < 5 && z > HALF_L - 14) continue;     // spawn apron clear
      if (Math.abs(x - 28) < 3 && Math.abs(z - 9.8) < 3) continue; // gate 2 approach
      const s = [rnd(b, 0.3, 1.8), rnd(b, 0.2, 0.9), rnd(b, 0.3, 1.8)];
      const ry = rnd(b, 0, Math.PI * 2);
      chunks.push({ position: [x, s[1] / 2, z], rotationY: ry, scale: s });
      if (s[1] > 0.6) b.boxBody({ size: s, position: [x, s[1] / 2, z], rotationY: ry });
      if ((k & 63) === 0) yield { progress: 0.68 + 0.04 * (k / 440), label: 'Clutter' };
    }
    b.instanced(chunkGeo, m.floor, chunks);

    // Decals: oil near the machines, grime on columns, tags on the walls.
    const oilTex = b.tex(oilStainTexture(9101, [1, 1]));
    const grimeTex = b.tex(grimeTexture(9102, [1, 1]));
    for (const [ox, oz, s] of [[28, -16, 6], [26, 12, 5], [8, -28, 5], [-16, 12, 6], [0, 30, 5]]) {
      b.decal({ size: [s, s], position: [ox, 0.02, oz], tiltX: -Math.PI / 2, texture: oilTex, opacity: 0.8 });
    }
    for (const [gx, gz] of [[-20, 15], [20, 15], [0, -15], [-40, -15], [40, -30]]) {
      b.decal({ size: [3, 6], position: [gx, 3.5, gz + 0.52], texture: grimeTex, opacity: 0.6 });
    }
    const tagHues = [315, 200, 45, 120];
    for (let t = 0; t < 4; t++) {
      const tagTex = b.tex(graffitiTexture(9110 + t, [1, 1], tagHues[t]));
      b.decal({
        size: [8, 4.5], position: [HALF_W - WALL_T / 2 - 0.08, 3.2, -30 + t * 11],
        rotationY: -Math.PI / 2, texture: tagTex, opacity: 0.9,
      });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Yard annex: chimney stack, office block, water tower, plane trees
   * ---------------------------------------------------------------------- */

  *_buildYard(b) {
    const m = this._materials(b);
    const apron = b.box({
      size: [YARD_X1 - YARD_X0 + 8, 0.2, YARD_Z1 - YARD_Z0 + 8],
      position: [(YARD_X0 + YARD_X1) / 2, -0.14, (YARD_Z0 + YARD_Z1) / 2],
      material: m.floor,
    });
    apron.receiveShadow = true;

    // Perimeter brick walls with gaps.
    const runs = [
      { x0: YARD_X0, z0: YARD_Z0, x1: 88, z1: YARD_Z0 },
      { x0: 100, z0: YARD_Z0, x1: YARD_X1, z1: YARD_Z0 },
      { x0: YARD_X1, z0: YARD_Z0, x1: YARD_X1, z1: YARD_Z1 },
      { x0: YARD_X0, z0: YARD_Z1, x1: 104, z1: YARD_Z1 },
      { x0: 116, z0: YARD_Z1, x1: YARD_X1, z1: YARD_Z1 },
      { x0: YARD_X0, z0: HALF_L, x1: YARD_X0, z1: YARD_Z1 },
    ];
    for (const r of runs) {
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
      if (len < 0.5) continue;
      const alongX = Math.abs(r.x1 - r.x0) > Math.abs(r.z1 - r.z0);
      b.box({
        size: alongX ? [len, YARD_WALL_H, 0.5] : [0.5, YARD_WALL_H, len],
        position: [(r.x0 + r.x1) / 2, YARD_WALL_H / 2, (r.z0 + r.z1) / 2],
        material: m.brick,
      });
    }
    yield { progress: 0.76, label: 'Yard' };

    // The chimney: 56 m tapered brick stack, iron bands, soot cap.
    const C = CHIMNEY;
    b.cylinder({
      radiusTop: C.r1, radiusBottom: C.r0, height: C.h, segments: 20,
      position: [C.x, C.h / 2, C.z], material: m.brickTall,
    });
    b.box({ size: [C.r0 * 2 + 2, 3, C.r0 * 2 + 2], position: [C.x, 1.5, C.z], material: m.brick });
    for (const by of [10, 20, 30, 40, 48]) {
      const localR = C.r0 - (C.r0 - C.r1) * (by / C.h) + 0.08;
      b.cylinder({
        radiusTop: localR, radiusBottom: localR, height: 0.4, segments: 20,
        position: [C.x, by, C.z], material: m.dark, collide: false,
      });
    }
    b.cylinder({
      radiusTop: C.r1 + 0.3, radiusBottom: C.r1 + 0.3, height: 1.0, segments: 20,
      position: [C.x, C.h + 0.3, C.z], material: m.dark, collide: false,
    });
    // Service ladder.
    b.box({ size: [0.6, C.h - 3, 0.1], position: [C.x - C.r0 + 0.6, C.h / 2 + 1.5, C.z + 2.5], material: m.dark, collide: false });

    // Office block: four storeys + mansard attic, shuttered windows.
    const ox = 92;
    const oz = -10;
    b.box({ size: [24, 13, 16], position: [ox, 6.5, oz], material: m.brick });
    b.box({ size: [20, 4.2, 13], position: [ox, 15.1, oz], material: m.dark });
    b.box({ size: [21, 0.4, 14], position: [ox, 17.4, oz], material: m.dark });
    const winGeo = b.geometry('fac-office-win', () => new THREE.PlaneGeometry(1.2, 1.8));
    for (const wy of [2.2, 5.3, 8.4, 11.5]) {
      for (let wx = ox - 10; wx <= ox + 10; wx += 2.5) {
        for (const [fz, ry] of [[oz + 8.03, 0], [oz - 8.03, Math.PI]]) {
          const pane = new THREE.Mesh(winGeo, m.glowWindow);
          pane.position.set(wx, wy, fz);
          pane.rotation.y = ry;
          b.root.add(pane);
        }
      }
    }
    b.box({ size: [2.4, 3, 0.3], position: [ox - 6, 1.5, oz + 8.1], material: m.dark });
    yield { progress: 0.8, label: 'Yard' };

    // Water tower: four 18 m legs, riveted tank, cone cap, cross braces.
    const tx = 74;
    const tz = 34;
    for (const [lx, lz] of [[-2.8, -2.8], [2.8, -2.8], [-2.8, 2.8], [2.8, 2.8]]) {
      b.box({ size: [0.45, 18, 0.45], position: [tx + lx, 9, tz + lz], material: m.steel });
    }
    for (const y of [6, 12]) {
      b.beam({ from: [tx - 2.8, y - 3, tz - 2.8], to: [tx + 2.8, y + 3, tz - 2.8], width: 0.12, material: m.steel });
      b.beam({ from: [tx - 2.8, y - 3, tz + 2.8], to: [tx + 2.8, y + 3, tz + 2.8], width: 0.12, material: m.steel });
    }
    b.cylinder({ radiusTop: 4.4, radiusBottom: 4.4, height: 6.4, segments: 20, position: [tx, 21.2, tz], material: m.rust });
    b.cylinder({ radiusTop: 0.3, radiusBottom: 5.0, height: 3.2, segments: 20, position: [tx, 26, tz], material: m.dark });

    // Pollarded plane trees along both yard walls (real size).
    const trunkGeo = b.geometry('fac-pt-trunk', () => new THREE.CylinderGeometry(0.28, 0.42, 4.2, 8));
    const blobGeo = b.geometry('fac-pt-blob', () => new THREE.IcosahedronGeometry(1.6, 1));
    const treeXf = [];
    const blobXf = [];
    const treeSpots = [];
    for (let z = -16; z <= 36; z += 13) treeSpots.push([68, z]);
    for (let z = -12; z <= 36; z += 12) treeSpots.push([118, z]);
    for (const [px, pz] of treeSpots) {
      treeXf.push({ position: [px, 2.1, pz], rotationY: rnd(b, 0, 3) });
      b.boxBody({ size: [0.7, 4.2, 0.7], position: [px, 2.1, pz] });
      for (let k = 0; k < 4; k++) {
        const bx = px + rnd(b, -1.4, 1.4);
        const bz = pz + rnd(b, -1.4, 1.4);
        const by = 5.4 + rnd(b, -0.5, 1.0);
        blobXf.push({ position: [bx, by, bz], scale: rnd(b, 0.8, 1.25), rotationY: rnd(b, 0, 3) });
        b.sphereBody({ radius: 1.3, position: [bx, by, bz], surface: 'soft' });
      }
    }
    b.instanced(trunkGeo, m.dark, treeXf);
    b.instanced(blobGeo, m.leaf, blobXf);
    yield { progress: 0.84, label: 'Yard' };

    // Yard clutter: dumpster, pallet stacks, drums, flatbed truck.
    b.box({ size: [2.2, 1.3, 1.2], position: [80, 0.65, 24], material: m.dark });
    for (let k = 0; k < 7; k++) {
      b.box({
        size: [1.2, 0.9, 1.2], position: [110 + rnd(b, -1, 1), 0.45, -18 + k * 1.6],
        rotationY: rnd(b, 0, 1), material: m.crate,
      });
    }
    b.box({ size: [2.0, 0.35, 5.2], position: [88, 1.0, 4], material: m.rust });
    b.box({ size: [1.9, 1.5, 1.7], position: [88, 1.9, 6.6], material: m.dark });
    for (const wz of [2.2, 4.2, 6.2]) {
      for (const wx of [86.9, 89.1]) b.box({ size: [0.35, 0.9, 0.9], position: [wx, 0.45, wz], material: m.dark });
    }
    // Lamp posts with sodium heads.
    for (const [lx, lz] of [[84, 16], [108, -4]]) {
      b.box({ size: [0.2, 8, 0.2], position: [lx, 4, lz], material: m.dark });
      b.box({ size: [1.6, 0.12, 0.12], position: [lx + 0.7, 7.9, lz], material: m.dark, collide: false });
      b.box({ size: [0.7, 0.12, 0.3], position: [lx + 1.4, 7.82, lz], material: m.glowSodium, collide: false });
    }
    this._yardDust = b.dustCloud({ count: 260, area: [60, 10, 64], center: [92, 5, 10], seed: 9188 });
    const tagTex = b.tex(graffitiTexture(9131, [1, 1], 275));
    b.decal({ size: [5, 2.8], position: [112, 1.6, YARD_Z0 + 0.27], texture: tagTex, opacity: 0.9 });
  }

  /* ---------------------------------------------------------------------- *
   * Atmosphere: sodium fixtures, skylight shafts, dust
   * ---------------------------------------------------------------------- */

  _buildAtmosphere(b) {
    const m = this._materials(b);
    // Sodium work lights over the conveyor and the office; one flickers.
    for (let i = 0; i < 3; i++) {
      const z = -30 + i * 12;
      b.box({ size: [1.0, 0.14, 0.45], position: [8, 14, z], material: m.glowSodium, collide: false });
      const light = new THREE.PointLight(0xffa64d, 160, 40, 2);
      light.position.set(8, 13.6, z);
      b.addLight(light);
      if (i === 0) this._flicker = light;
    }
    const office = new THREE.PointLight(0xffc98c, 70, 26, 2);
    office.position.set(-HALF_W + 10, MEZZ_Y + 2.6, -24);
    b.addLight(office);

    // Sunbeams through the skylights (along the configured sun direction).
    const e = this.environment;
    const phi = (90 - e.sunElevation) * Math.PI / 180;
    const th = e.sunAzimuth * Math.PI / 180;
    const sun = new THREE.Vector3().setFromSphericalCoords(1, phi, th);
    for (const s of this._skylights || []) {
      b.sunShaft({ top: [s.x, ROOF_Y, s.z], dir: [-sun.x, -sun.y, -sun.z], length: 32, width: 6.2, opacity: 0.16 });
    }
    this._dust = b.dustCloud({
      count: 900, area: [W - 8, H - 2, L - 8], center: [0, (H - 2) / 2, 0], seed: 9177, size: 0.07,
    });
  }

  /* ---------------------------------------------------------------------- *
   * Course
   * ---------------------------------------------------------------------- */

  _buildGates(b) {
    const m = this._materials(b);
    const pads = ['#d9c7a3', '#2a2622'];
    const layout = [
      { x: 0, y: 1.6, z: 26 },                                   // 1 starter along the conveyor
      { x: 28, y: 2.4, z: 9.8 },                                 // 2 into press 1's slot
      { x: 28, y: 2.4, z: -17.8 },                               // 3 into press 2's slot
      { x: -4, y: 1.6, z: -14 },                                 // 4 low cut past the tanks
      { x: -46, y: MEZZ_Y + 1.6, z: -8, ground: MEZZ_Y + 0.18 }, // 5 mezzanine rail gap
      { x: 6, y: MEZZ_Y + 2.4, z: -8, legs: false },             // 6 hung over the bridge
      { x: -21, y: 2.4, z: -24 },                                // 7 tank row
      { x: 4, y: 15, z: 20, w: 2.6, h: 2.6 },                    // 8 roof-hole scaffold
      { x: 66, y: 2.2, z: 8 },                                   // 9 out of the wagon door
      { x: 88, y: 9, z: 20 },                                    // 10 chimney yard
      { x: 92.5, y: 22, z: 28, legs: false },                    // 11 off the chimney
      { x: 74, y: 2.0, z: -14, w: 3.2, h: 3.0 },                 // 12 finish
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 2.0, padColors: pads, beaconHeight: 10,
    });

    // Gate 6: hangers up to the truss. Gate 11: a cantilever off the stack.
    const g6 = this.gates[5];
    for (const s of [-1, 1]) {
      const x = g6.position.x + g6.right.x * 1.15 * s;
      const z = g6.position.z + g6.right.z * 1.15 * s;
      const top = g6.position.y + 1.15;
      b.box({ size: [0.06, ROOF_Y - 2.6 - top, 0.06], position: [x, (ROOF_Y - 2.6 + top) / 2, z], material: m.dark, collide: false });
    }
    const g11 = this.gates[10];
    const rAt = CHIMNEY.r0 - (CHIMNEY.r0 - CHIMNEY.r1) * (g11.position.y / CHIMNEY.h);
    const dir = new THREE.Vector3(g11.position.x - CHIMNEY.x, 0, g11.position.z - CHIMNEY.z).normalize();
    for (const dy of [-1.25, 1.25]) {
      b.beam({
        from: [CHIMNEY.x + dir.x * (rAt - 0.1), g11.position.y + dy, CHIMNEY.z + dir.z * (rAt - 0.1)],
        to: [g11.position.x - dir.x * 1.2, g11.position.y + dy, g11.position.z - dir.z * 1.2],
        width: 0.18, material: m.steel,
      });
    }
    // Scaffold braces under gate 8.
    const g8 = this.gates[7];
    const hw = 1.3 + 0.2;
    const pa = [g8.position.x - g8.right.x * hw, g8.position.z - g8.right.z * hw];
    const pb = [g8.position.x + g8.right.x * hw, g8.position.z + g8.right.z * hw];
    const top = g8.position.y - 1.5;
    for (let y = 0; y < top - 1; y += 3.5) {
      b.beam({ from: [pa[0], y + 0.1, pa[1]], to: [pb[0], y + 3.4, pb[1]], width: 0.06, material: m.steel });
    }
  }

  /* ====================================================================== *
   * Per-frame
   * ====================================================================== */

  update(dt, elapsed) {
    if (this._dust) {
      try { this._dust.update(dt, elapsed); } catch (_e) { /* ignore */ }
    }
    if (this._yardDust) {
      try { this._yardDust.update(dt, elapsed); } catch (_e) { /* ignore */ }
    }
    if (this._flicker) {
      const f = Math.sin(elapsed * 19.3) * Math.sin(elapsed * 6.1 + 0.7);
      this._flicker.intensity = f > 0.35 ? 20 : this._flickerBase;
    }
  }

  updatePropwash(pos, motor) {
    if (!pos) return;
    try {
      const strength = 0.3 + (Number.isFinite(motor) ? motor : 0) * 1.4;
      if (this._dust) this._dust.kick(pos.x, pos.y, pos.z, 2.2, strength);
      if (this._yardDust) this._yardDust.kick(pos.x, pos.y, pos.z, 2.2, strength);
    } catch (_e) { /* ignore */ }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._dust = null;
    this._yardDust = null;
    this._flicker = null;
    this._skylights = null;
    this.gates = [];
  }
}
