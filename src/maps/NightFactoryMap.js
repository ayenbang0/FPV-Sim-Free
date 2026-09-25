/**
 * maps/NightFactoryMap.js
 * ---------------------------------------------------------------------------
 * Night Factory — a steel works on the night shift.
 *
 * A 64 x 96 m melt shop, 20 m to the roof (about 10x the volume of the old
 * 32 x 46 m shed), lit almost entirely by what it makes: an electric arc
 * furnace pouring orange light, a glowing slab on the rolling-mill line,
 * sodium high-bays and dark skylights. An overhead bridge crane spans the hall
 * on 15 m rails — under it or over it — with a ladle hanging from the hook.
 * Stacks of steel coils, beam bundles and ladle cars on floor rails make the
 * slalom; a control-room gallery hangs off the east wall.
 *
 * Ten gates: down the mill line, around the coil stacks, under the crane
 * girder, over it, past the furnace, through the control-room gallery and
 * out through the scrap-bay door.
 */

import * as THREE from 'three';
import { MapBuilder, rnd } from './MapKit.js';
import {
  concreteTexture, corrugatedMetalTexture, rustTexture, paintedMetalTexture, hazardTexture,
} from '../assets/procedural.js';

const W = 64;
const L = 96;
const H = 20;
const HALF_W = W / 2;
const HALF_L = L / 2;
const RAIL_Y = 15;       // crane rail height
const WALL_T = 0.35;

export const NIGHT_FACTORY_META = {
  id: 'night-factory',
  displayName: 'Night Factory',
  description: 'Steel works on the night shift: arc furnace glow, bridge crane, rolling mill, sodium light. 10 gates.',
  accent: 'linear-gradient(160deg, #ff8a2a 0%, #3a1c0c 45%, #05070c 100%)',
  category: 'Racing',
  size: '64 × 96 × 20 m',
  gates: 10,
  courseKey: 'night-factory.v2',
  ambient: 'warehouse',
};

export class NightFactoryMap {
  constructor() {
    this.id = 'night-factory';
    this.spawnPoint = new THREE.Vector3(-4, 0.12, HALF_L - 6);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF_W - 3, -3, -HALF_L - 20),
      max: new THREE.Vector3(HALF_W + 3, H + 6, HALF_L + 3),
    };
    this.viewDistance = 300;
    this.link = { range: 110, indoor: true };
    this.environment = {
      mode: 'indoor',
      exposure: 1.15,
      envIntensity: 0.5,
      hemiIntensity: 0,
      probe: [0, 6, 0],
    };
    this.builder = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._furnaceLight = null;
    this._flicker = null;
    this._dust = null;
  }

  getGroundHeight() {
    return 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 7301, name: 'night-factory-map', streaming: { cellSize: 24 } });
    this.builder = b;
    this._prevBackground = scene.background;
    this._prevFog = scene.fog;
    scene.background = new THREE.Color(0x05070c);
    scene.fog = new THREE.Fog(0x120d0a, 40, 160);

    yield { progress: 0.05, label: 'Shell' };
    this._buildShell(b);
    yield { progress: 0.25, label: 'Crane' };
    this._buildCrane(b);
    yield { progress: 0.4, label: 'Furnace' };
    this._buildFurnace(b);
    yield { progress: 0.55, label: 'Mill line' };
    this._buildMill(b);
    yield { progress: 0.68, label: 'Stock' };
    this._buildStock(b);
    yield { progress: 0.8, label: 'Control room' };
    this._buildControlRoom(b);
    yield { progress: 0.88, label: 'Lighting' };
    this._buildLighting(b);
    yield { progress: 0.94, label: 'Course' };
    this._buildGates(b);
    b.finalizeShadows({ castMinRadius: 0.6 });
    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;
    const floor = b.tex(concreteTexture(7302, [20, 30]));
    const wall = b.tex(corrugatedMetalTexture(7303, [20, 6]));
    const rust = b.tex(rustTexture(7304, [2, 2]));
    const steel = b.tex(paintedMetalTexture(7305, [2, 2], [70, 74, 80]));
    const yellow = b.tex(paintedMetalTexture(7306, [3, 1], [214, 170, 30]));
    this._mats = {
      floor: b.material('nf-floor', () => new THREE.MeshStandardMaterial({ color: floor ? 0x9a948c : 0x4a4640, map: floor, roughness: 0.9 })),
      wall: b.material('nf-wall', () => new THREE.MeshStandardMaterial({ color: wall ? 0x6a6660 : 0x3a3834, map: wall, roughness: 0.75, metalness: 0.4 })),
      rust: b.material('nf-rust', () => new THREE.MeshStandardMaterial({ color: rust ? 0xffffff : 0x6a3a22, map: rust, roughness: 0.9, metalness: 0.3 })),
      steel: b.material('nf-steel', () => new THREE.MeshStandardMaterial({ color: steel ? 0xffffff : 0x40444a, map: steel, roughness: 0.5, metalness: 0.8 })),
      yellow: b.material('nf-yellow', () => new THREE.MeshStandardMaterial({ color: yellow ? 0xffffff : 0xd6aa1e, map: yellow, roughness: 0.55, metalness: 0.5 })),
      coil: b.material('nf-coil', () => new THREE.MeshStandardMaterial({ color: 0x8e9398, roughness: 0.3, metalness: 0.95 })),
      hot: b.material('nf-hot', () => new THREE.MeshStandardMaterial({ color: 0x331000, emissive: 0xff6a10, emissiveIntensity: 3.2, roughness: 0.6 })),
      glowSodium: b.material('nf-sodium', () => new THREE.MeshBasicMaterial({ color: 0xffb45e })),
      skylight: b.material('nf-sky', () => new THREE.MeshBasicMaterial({ color: 0x1b2640, transparent: true, opacity: 0.9 })),
      hazard: b.material('nf-hazard', () => {
        const t = b.tex(hazardTexture(7307, [8, 1]));
        return new THREE.MeshStandardMaterial({ color: t ? 0xffffff : 0xc9a227, map: t, roughness: 0.8 });
      }),
      glass: b.material('nf-glass', () => new THREE.MeshStandardMaterial({ color: 0x9fd0ff, emissive: 0x2a6aa8, emissiveIntensity: 0.6, transparent: true, opacity: 0.35, depthWrite: false })),
    };
    return this._mats;
  }

  _buildShell(b) {
    const m = this._materials(b);
    b.floor({ width: W, depth: L + 30, position: [0, 0, -15], material: m.floor });
    b.box({ size: [WALL_T, H, L], position: [-HALF_W, H / 2, 0], material: m.wall });
    b.box({ size: [WALL_T, H, L], position: [HALF_W, H / 2, 0], material: m.wall });
    b.box({ size: [W, H, WALL_T], position: [0, H / 2, HALF_L], material: m.wall });
    // North wall with the scrap-bay door (8 x 9 m) at x = 12.
    const dx = 12;
    const dw = 8;
    const dh = 9;
    b.box({ size: [HALF_W + dx - dw / 2, H, WALL_T], position: [(-HALF_W + dx - dw / 2) / 2, H / 2, -HALF_L], material: m.wall });
    b.box({ size: [HALF_W - dx - dw / 2, H, WALL_T], position: [(HALF_W + dx + dw / 2) / 2, H / 2, -HALF_L], material: m.wall });
    b.box({ size: [dw, H - dh, WALL_T], position: [dx, dh + (H - dh) / 2, -HALF_L], material: m.wall });
    // Scrap yard outside the door: a walled pen with scrap heaps.
    for (const sx of [-1, 1]) b.box({ size: [WALL_T, 3, 16], position: [dx + sx * 12, 1.5, -HALF_L - 8], material: m.rust });
    b.box({ size: [24, 3, WALL_T], position: [dx, 1.5, -HALF_L - 16], material: m.rust });
    for (let i = 0; i < 40; i++) {
      const s = [rnd(b, 0.4, 2), rnd(b, 0.3, 1.2), rnd(b, 0.4, 2)];
      b.box({ size: s, position: [dx + rnd(b, -10, -3) * (i % 2 ? 1 : -1), s[1] / 2, -HALF_L - rnd(b, 8, 15)], rotationY: rnd(b, 0, 3), material: m.rust });
    }
    // Roof deck, trusses and dark skylight strips.
    const roof = b.box({ size: [W, 0.35, L], position: [0, H + 0.2, 0], material: m.steel });
    roof.userData.noCastShadow = true;
    const truss = [];
    for (let z = -HALF_L + 4; z <= HALF_L - 4; z += 8) {
      truss.push({ size: [W - 0.6, 0.3, 0.3], position: [0, H - 2.2, z] });
      for (let i = 0; i < 12; i++) {
        const x0 = -HALF_W + 0.3 + i * (W - 0.6) / 12;
        truss.push(MapBuilder.beamPart([x0, H - 2.2, z], [x0 + (W - 0.6) / 12, H, z], 0.14));
      }
      for (const sx of [-1, 1]) truss.push({ size: [0.6, H, 0.6], position: [sx * (HALF_W - 0.6), H / 2, z] });
    }
    b.mergeStatic(truss, m.steel, { name: 'nf-truss' });
    for (let z = -HALF_L + 4; z <= HALF_L - 4; z += 8) {
      b.boxBody({ size: [W - 0.6, 0.4, 0.4], position: [0, H - 2.2, z] });
      for (const sx of [-1, 1]) b.boxBody({ size: [0.6, H, 0.6], position: [sx * (HALF_W - 0.6), H / 2, z] });
    }
    const skyGeo = b.geometry('nf-sky', () => new THREE.PlaneGeometry(4, 80));
    for (const x of [-16, 0, 16]) {
      const p = new THREE.Mesh(skyGeo, m.skylight);
      p.rotation.x = Math.PI / 2;
      p.position.set(x, H - 0.02, 0);
      b.root.add(p);
    }
  }

  /** Crane rails on both walls and a bridge crane with a hanging ladle. */
  _buildCrane(b) {
    const m = this._materials(b);
    for (const sx of [-1, 1]) {
      b.box({ size: [0.8, 1.2, L - 2], position: [sx * (HALF_W - 1.5), RAIL_Y, 0], material: m.steel });
    }
    const cz = 0;           // between two roof trusses
    // Twin box girders spanning the hall, end carriages, trolley.
    for (const oz of [-1.6, 1.6]) {
      b.box({ size: [W - 3, 1.8, 0.8], position: [0, RAIL_Y + 1.5, cz + oz], material: m.yellow });
    }
    for (const sx of [-1, 1]) b.box({ size: [2, 1.4, 6], position: [sx * (HALF_W - 1.5), RAIL_Y + 1.3, cz], material: m.yellow });
    b.box({ size: [4, 1.6, 4.6], position: [-6, RAIL_Y + 3.0, cz], material: m.yellow });
    b.box({ size: [0.6, 0.12, 60], position: [0, RAIL_Y + 0.4, cz], material: m.hazard, collide: false });
    // Hoist ropes and the ladle (a tapered bucket) at 6 m.
    for (const ox of [-0.8, 0.8]) b.box({ size: [0.06, RAIL_Y - 8, 0.06], position: [-6 + ox, (RAIL_Y + 8) / 2, cz], material: m.steel, collide: false });
    b.box({ size: [3, 0.6, 0.6], position: [-6, 8, cz], material: m.steel });
    b.cylinder({ radiusTop: 2.2, radiusBottom: 1.7, height: 3.2, segments: 16, position: [-6, 5.9, cz], material: m.rust });
    this._craneZ = cz;
  }

  _buildFurnace(b) {
    const m = this._materials(b);
    // Arc furnace (north-west bay): shell, roof, electrode mast, tapping spout.
    const fx = -18;
    const fz = -30;
    b.cylinder({ radiusTop: 4.2, radiusBottom: 3.8, height: 5, segments: 20, position: [fx, 3.5, fz], material: m.rust });
    b.box({ size: [11, 1, 11], position: [fx, 0.5, fz], material: m.steel });
    b.cylinder({ radiusTop: 1.4, radiusBottom: 4.4, height: 1.6, segments: 20, position: [fx, 6.8, fz], material: m.steel });
    for (const [ox, oz] of [[-0.8, 0], [0.5, 0.7], [0.5, -0.7]]) {
      b.cylinder({ radiusTop: 0.3, radiusBottom: 0.3, height: 6, segments: 8, position: [fx + ox, 10, fz + oz], material: m.coil });
    }
    b.box({ size: [1.2, 12, 1.2], position: [fx - 6, 6, fz], material: m.steel });
    b.box({ size: [6, 1, 1], position: [fx - 3, 12.5, fz], material: m.steel });
    // Molten glow: the spout, a slag pot, and the pour.
    b.box({ size: [3, 0.5, 1.2], position: [fx + 5, 2.6, fz], rotation: [0, 0, -0.3], material: m.hot });
    b.cylinder({ radiusTop: 1.3, radiusBottom: 1.0, height: 1.6, segments: 14, position: [fx + 7.5, 0.8, fz], material: m.rust });
    b.cylinder({ radiusTop: 1.15, radiusBottom: 1.15, height: 0.1, segments: 14, position: [fx + 7.5, 1.62, fz], material: m.hot, collide: false });
    this._furnaceLight = new THREE.PointLight(0xff7a24, 900, 60, 1.8);
    this._furnaceLight.position.set(fx + 5, 4, fz);
    b.addLight(this._furnaceLight);
    this._sparks = b.dustCloud({ count: 260, area: [8, 6, 8], center: [fx + 6, 4, fz], color: 0xffa040, size: 0.09, opacity: 0.9, seed: 7390 });
  }

  _buildMill(b) {
    const m = this._materials(b);
    // Roller table down the east bay (z -30..36) at 0.9 m, stands every 9 m.
    const mx = 16;
    b.box({ size: [2.4, 0.9, 66], position: [mx, 0.45, 3], material: m.steel });
    for (let z = -26; z <= 32; z += 9) {
      b.box({ size: [5, 5.5, 2.4], position: [mx, 2.75, z], material: m.yellow });
      b.box({ size: [0.9, 1.4, 2.4], position: [mx - 2.9, 3.2, z], material: m.steel });
    }
    // A glowing slab passing through the stands.
    b.box({ size: [1.8, 0.3, 8], position: [mx, 1.05, -8], material: m.hot, collide: false });
    const slabLight = new THREE.PointLight(0xff8a30, 160, 24, 2);
    slabLight.position.set(mx, 2.5, -8);
    b.addLight(slabLight);
    // Floor rails for the ladle cars along the west bay.
    for (const ox of [-0.8, 0.8]) b.box({ size: [0.12, 0.1, L - 6], position: [-8 + ox, 0.05, 0], material: m.steel, collide: false });
    for (const z of [18, 30]) {
      b.box({ size: [3.4, 1.2, 5], position: [-8, 0.9, z], material: m.steel });
      b.cylinder({ radiusTop: 1.5, radiusBottom: 1.2, height: 2, segments: 14, position: [-8, 2.5, z], material: m.rust });
    }
  }

  _buildStock(b) {
    const m = this._materials(b);
    // Steel coils in pyramids (instanced, sphere-ish colliders per coil).
    const coilGeo = b.geometry('nf-coil', () => { const g = new THREE.CylinderGeometry(0.9, 0.9, 1.4, 20); g.rotateX(Math.PI / 2); return g; });
    const coils = [];
    for (const [cx, cz] of [[26, 30], [26, 22], [-26, 10], [-26, -2], [2, -40]]) {
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 3 - row; i++) {
          const x = cx + (i - (2 - row) / 2) * 1.9;
          const y = 0.9 + row * 1.55;
          coils.push({ position: [x, y, cz], rotationY: 0 });
          b.boxBody({ size: [1.8, 1.8, 1.4], position: [x, y, cz] });
        }
      }
    }
    b.instanced(coilGeo, m.coil, coils);
    // Bundles of I-beams.
    for (const [x, z, n] of [[-20, 28, 4], [8, 30, 3], [-2, -18, 5]]) {
      for (let i = 0; i < n; i++) {
        b.box({ size: [12, 0.35, 0.3], position: [x, 0.2 + (i % 2) * 0.35, z + i * 0.35], material: m.rust });
      }
    }
  }

  _buildControlRoom(b) {
    const m = this._materials(b);
    // A glazed pulpit hung on the east wall at 6 m, overlooking the mill,
    // with an open walkway through its north end (the gallery gate).
    const x0 = HALF_W - 6;
    const z0 = -12;
    const z1 = 6;
    b.box({ size: [6, 0.3, z1 - z0], position: [x0 + 3, 6, (z0 + z1) / 2], material: m.steel });
    b.box({ size: [6, 0.3, z1 - z0 - 6], position: [x0 + 3, 9.6, (z0 + 6 + z1) / 2], material: m.steel });
    const glass = new THREE.Mesh(b.geometry('nf-pulpit-glass', () => new THREE.PlaneGeometry(z1 - z0 - 6, 3.3)), m.glass);
    glass.position.set(x0, 7.8, (z0 + 6 + z1) / 2);
    glass.rotation.y = Math.PI / 2;
    b.root.add(glass);
    b.boxBody({ size: [0.05, 3.3, z1 - z0 - 6], position: [x0, 7.8, (z0 + 6 + z1) / 2] });
    b.box({ size: [6, 3.3, 0.2], position: [x0 + 3, 7.8, z0 + 6], material: m.wall });
    for (const z of [z0 + 1, z1 - 1]) b.beam({ from: [x0, 6, z], to: [HALF_W, 3, z], width: 0.2, material: m.steel });
    // Consoles glowing inside.
    b.box({ size: [1, 1, 8], position: [x0 + 1.2, 6.65, 1], material: m.glass, collide: false });
    const l = new THREE.PointLight(0x7ab8ff, 50, 14, 2);
    l.position.set(x0 + 3, 8.5, 0);
    b.addLight(l);
  }

  _buildLighting(b) {
    const m = this._materials(b);
    b.addLight(new THREE.HemisphereLight(0x2a3450, 0x1a120c, 0.5));
    const lamps = [];
    for (let z = -40; z <= 40; z += 16) {
      for (const x of [-18, 0, 18]) lamps.push([x, z]);
    }
    lamps.forEach(([x, z], i) => {
      b.box({ size: [1.0, 0.14, 0.5], position: [x, H - 3, z], material: m.glowSodium, collide: false });
      if (i % 2 === 0) {
        const light = new THREE.PointLight(0xffa64d, 140, 30, 2);
        light.position.set(x, H - 3.4, z);
        b.addLight(light);
        if (i === 6) this._flicker = light;
      }
    });
    this._dust = b.dustCloud({ count: 700, area: [W - 4, H - 2, L - 4], center: [0, (H - 2) / 2, 0], color: 0xffc080, size: 0.06, opacity: 0.4, seed: 7399 });
  }

  _buildGates(b) {
    const cz = this._craneZ;
    const layout = [
      { x: -4, y: 1.8, z: 34 },                          // 1 start straight
      { x: 8, y: 1.8, z: 20 },                           // 2 between the mill and the rails
      { x: 22, y: 2.2, z: 10 },                          // 3 behind the mill stands
      { x: 10, y: RAIL_Y - 3.2, z: cz + 6, legs: false }, // 4 up toward the crane
      { x: -12, y: RAIL_Y + 3.7, z: cz, legs: false },   // 5 over the crane girder
      { x: -8, y: 2.4, z: -14 },                         // 6 dive back to the floor
      { x: -8, y: 2.2, z: -38, w: 2.6, h: 2.6 },         // 7 past the furnace
      { x: HALF_W - 3, y: 7.6, z: -8, ground: 6.15 },    // 8 through the control-room walkway
      { x: 24, y: 2.0, z: -30 },                         // 9 back down past the coils
      { x: 12, y: 3, z: -HALF_L - 6, w: 3, h: 3 },       // 10 out through the scrap-bay door
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 2.0, beaconHeight: 6, padColors: ['#ff8a2a', '#1a1410'],
    });
  }

  update(dt, elapsed) {
    if (this._furnaceLight) {
      const f = 0.82 + 0.12 * Math.sin(elapsed * 9.1) + 0.06 * Math.sin(elapsed * 23.7);
      this._furnaceLight.intensity = 900 * f;
    }
    if (this._flicker) {
      const f = Math.sin(elapsed * 17.3) * Math.sin(elapsed * 4.9);
      this._flicker.intensity = f > 0.45 ? 15 : 140;
    }
    try { this._dust?.update(dt, elapsed); this._sparks?.update(dt * 3, elapsed); } catch (_e) { /* ignore */ }
  }

  updatePropwash(pos, motor) {
    if (!pos || !this._dust) return;
    try { this._dust.kick(pos.x, pos.y, pos.z, 2.2, 0.3 + (Number.isFinite(motor) ? motor : 0) * 1.4); } catch (_e) { /* ignore */ }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._dust = null;
    this._sparks = null;
    this._furnaceLight = null;
    this._flicker = null;
    this.gates = [];
    scene.background = this._prevBackground ?? null;
    scene.fog = this._prevFog ?? null;
  }
}
