/**
 * maps/WarehouseMap.js
 * ---------------------------------------------------------------------------
 * Map 2 — Abandoned Warehouse. The gate-racing map.
 *
 * A 40 x 60 m industrial shell with a 10 m ceiling: exposed steel truss work,
 * a concrete slab, corrugated siding, a catwalk reachable by stairs, and an
 * eight-gate course threaded through the whole volume.
 *
 * This map has by far the most props, so it leans hardest on the performance
 * tools: pallet stacks, shelving uprights, and debris all go through
 * `InstancedMesh`, and the roof truss — hundreds of individual members — is
 * merged into a single static geometry. Without that, the truss alone would be
 * ~400 draw calls for something you mostly see as a silhouette.
 *
 * Atmosphere is deliberately cheap. Real volumetric light is out of the
 * question at 60 fps, so shafts are faked with a handful of large transparent
 * angled planes under the skylights, and dust is a single additive points
 * cloud that drifts on the CPU. Both cost almost nothing and do most of the
 * work of selling "abandoned".
 */

import * as THREE from 'three';
import { MapBuilder, rnd, rndInt } from './MapKit.js';
import {
  concreteTexture, corrugatedMetalTexture, rustTexture,
  crateWoodTexture, paintedMetalTexture,
} from '../assets/procedural.js';

const W = 40;             // width  (x)
const L = 60;             // length (z)
const H = 10;             // eaves height
const HALF_W = W / 2;
const HALF_L = L / 2;
const WALL_T = 0.3;

const CATWALK_Y = 5.2;

export const WAREHOUSE_META = {
  id: 'warehouse',
  displayName: 'Abandoned Warehouse',
  description: 'Mid-speed gate racing. Eight gates, a catwalk, and 60 m of dusty industrial shell.',
  accent: 'linear-gradient(160deg, #6f7a85 0%, #4a5158 45%, #2a2f36 100%)',
};

export class WarehouseMap {
  constructor() {
    this.id = 'warehouse';

    // Spawn at the roller door at the south end, facing down the length.
    this.spawnPoint = new THREE.Vector3(0, 1.3, HALF_L - 4);
    this.spawnHeading = 0;          // -Z is forward: straight down the shed
    this.groundLevel = 0;

    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-HALF_W - 4, -3, -HALF_L - 4),
      max: new THREE.Vector3(HALF_W + 4, H + 8, HALF_L + 4),
    };

    this.builder = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._dust = null;
    this._dustVel = null;
    this._flicker = null;
  }

  getGroundHeight() {
    return 0;
  }

  /* ====================================================================== *
   * Build
   * ====================================================================== */

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 2207, name: 'warehouse-map' });
    this.builder = b;

    this._prevBackground = scene.background;
    this._prevFog = scene.fog;
    scene.background = new THREE.Color(0x0f1216);
    // Light fog gives depth to a big empty volume and hides the far wall until
    // you commit to it — which is most of what makes the space feel large.
    scene.fog = new THREE.Fog(0x161a20, 18, 95);

    yield { progress: 0.04, label: 'Slab' };
    this._buildShell(b);

    yield { progress: 0.22, label: 'Roof truss' };
    yield* this._buildTruss(b);

    yield { progress: 0.42, label: 'Catwalk' };
    this._buildCatwalk(b);

    yield { progress: 0.52, label: 'Shelving' };
    yield* this._buildShelving(b);

    yield { progress: 0.66, label: 'Crates & containers' };
    yield* this._buildCrates(b);

    yield { progress: 0.78, label: 'Machinery & debris' };
    this._buildMachinery(b);

    yield { progress: 0.86, label: 'Atmosphere' };
    this._buildLighting(b);
    this._buildDust(b);

    yield { progress: 0.94, label: 'Race course' };
    this._buildGates(b);

    yield { progress: 1, label: 'Ready' };
  }

  _materials(b) {
    if (this._mats) return this._mats;

    const floorTex = b.tex(concreteTexture(2101, [14, 20]));
    const wallTex = b.tex(corrugatedMetalTexture(2102, [14, 5]));
    const rustTex = b.tex(rustTexture(2103, [2, 2]));
    const crateTex = b.tex(crateWoodTexture(2104, [1, 1]));
    const steelTex = b.tex(paintedMetalTexture(2105, [2, 2], [118, 122, 128]));

    this._mats = {
      floor: b.material('wh-floor', () => new THREE.MeshStandardMaterial({
        color: floorTex ? 0xffffff : 0x7c7e80, map: floorTex, roughness: 0.94,
      })),
      wall: b.material('wh-wall', () => new THREE.MeshStandardMaterial({
        color: wallTex ? 0xdcdcdc : 0x6a6f74, map: wallTex,
        roughness: 0.72, metalness: 0.45, side: THREE.DoubleSide,
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
      dark: b.material('wh-dark', () => new THREE.MeshStandardMaterial({
        color: 0x30343a, roughness: 0.8, metalness: 0.4,
      })),
    };
    return this._mats;
  }

  /* ---------------------------------------------------------------------- *
   * Shell
   * ---------------------------------------------------------------------- */

  _buildShell(b) {
    const m = this._materials(b);

    b.floor({ width: W, depth: L, y: 0, material: m.floor });

    // Roof deck (a plain dark ceiling above the truss).
    b.plane({
      width: W, depth: L, position: [0, H + 1.6, 0],
      material: m.dark, rotationX: Math.PI / 2,
    });
    b.boxBody({ size: [W, 0.4, L], position: [0, H + 1.8, 0] });

    // Side walls (east/west), full height.
    for (const sx of [-1, 1]) {
      b.box({
        size: [WALL_T, H + 1.6, L],
        position: [sx * HALF_W, (H + 1.6) / 2, 0],
        material: m.wall,
      });
    }

    // North end wall — solid, with a broken window band near the top.
    b.box({ size: [W, H + 1.6, WALL_T], position: [0, (H + 1.6) / 2, -HALF_L], material: m.wall });

    // South end wall with two open roller doors flanking a central pier.
    // The doors are the spawn and the course's finish gate.
    const doorW = 6.5;
    const doorH = 5.0;
    const pier = 3.0;
    const sideW = (W - doorW * 2 - pier) / 2;
    for (const s of [-1, 1]) {
      b.box({
        size: [sideW, H + 1.6, WALL_T],
        position: [s * (W / 2 - sideW / 2), (H + 1.6) / 2, HALF_L],
        material: m.wall,
      });
      b.box({
        size: [doorW, H + 1.6 - doorH, WALL_T],
        position: [s * (pier / 2 + doorW / 2), doorH + (H + 1.6 - doorH) / 2, HALF_L],
        material: m.wall,
      });
    }
    b.box({ size: [pier, H + 1.6, WALL_T], position: [0, (H + 1.6) / 2, HALF_L], material: m.wall });

    // Damaged section: a hole punched in the west wall lets outside light in
    // and gives a bail-out line for pilots who overcook the far turn.
    b.box({ size: [0.05, 3.2, 4.5], position: [-HALF_W + 0.2, 2.2, -14], material: m.rust, collide: false });

    // Skylight panels — bright strips overhead that read as roof openings.
    const sky = b.material('skylight', () => new THREE.MeshBasicMaterial({
      color: 0xd6e6f2, transparent: true, opacity: 0.55, fog: false, side: THREE.DoubleSide,
    }));
    const skyGeo = b.geometry('skylight-pane', () => new THREE.PlaneGeometry(5, 9));
    this._skylights = [];
    for (const z of [-20, -6, 8, 22]) {
      for (const x of [-9, 9]) {
        const pane = new THREE.Mesh(skyGeo, sky);
        pane.rotation.x = Math.PI / 2;
        pane.position.set(x, H + 1.55, z);
        b.root.add(pane);
        this._skylights.push({ x, z });
      }
    }

    this._buildLightShafts(b);
  }

  /**
   * Fake light shafts: large, very transparent, additive planes angled from
   * each skylight down to the floor. Two crossed quads per shaft read as a
   * volume from almost any angle at a fraction of the cost of the real thing.
   */
  _buildLightShafts(b) {
    const shaft = b.material('shaft', () => new THREE.MeshBasicMaterial({
      color: 0xbcd4e8,
      transparent: true,
      opacity: 0.045,
      blending: THREE.AdditiveBlending,
      depthWrite: false,          // never occlude what is behind the shaft
      side: THREE.DoubleSide,
      fog: false,
    }));
    const geo = b.geometry('shaft-quad', () => new THREE.PlaneGeometry(5.5, 12.5));

    for (const s of this._skylights) {
      for (let k = 0; k < 2; k++) {
        const q = new THREE.Mesh(geo, shaft);
        q.position.set(s.x - 1.6, (H + 1.5) / 2, s.z);
        q.rotation.set(0.16, k === 0 ? 0 : Math.PI / 2, 0.14);
        b.root.add(q);
      }
    }
  }

  /* ---------------------------------------------------------------------- *
   * Roof truss
   * ---------------------------------------------------------------------- */

  /**
   * Steel truss work across the roof: a portal frame every 5 m, each with a
   * zig-zag web, plus longitudinal purlins tying them together.
   *
   * All of it is merged into one geometry for drawing. Only the vertical
   * columns get colliders — the diagonal web is 6 m overhead and hitting it is
   * not something the map needs to simulate precisely.
   */
  *_buildTruss(b) {
    const m = this._materials(b);
    const parts = [];
    const columns = [];

    for (let z = -HALF_L + 2.5; z <= HALF_L - 2.5; z += 5) {
      // Columns down each side.
      for (const sx of [-1, 1]) {
        const x = sx * (HALF_W - 0.55);
        parts.push({ size: [0.32, H, 0.32], position: [x, H / 2, z] });
        columns.push({ x, z });
      }
      // Bottom and top chords.
      parts.push({ size: [W - 1.1, 0.26, 0.26], position: [0, H - 1.5, z] });
      parts.push({ size: [W - 1.1, 0.22, 0.22], position: [0, H + 0.2, z] });

      // Zig-zag web between the chords.
      const bays = 10;
      const bayW = (W - 1.1) / bays;
      for (let i = 0; i < bays; i++) {
        const x0 = -(W - 1.1) / 2 + i * bayW;
        parts.push({
          size: [Math.hypot(bayW, 1.7), 0.14, 0.14],
          position: [x0 + bayW / 2, H - 0.65, z],
          rotationY: 0,
        });
      }
      yield { progress: 0.22 + 0.12 * ((z + HALF_L) / L), label: 'Roof truss' };
    }

    // Longitudinal purlins.
    for (let x = -HALF_W + 3; x <= HALF_W - 3; x += 4) {
      parts.push({ size: [0.16, 0.16, L - 2], position: [x, H + 0.9, 0] });
    }

    b.mergeStatic(parts, m.steel, { name: 'truss' });

    // Colliders for the columns only.
    for (const c of columns) {
      b.boxBody({ size: [0.4, H, 0.4], position: [c.x, H / 2, c.z] });
    }
    yield { progress: 0.40, label: 'Roof truss' };
  }

  /* ---------------------------------------------------------------------- *
   * Catwalk
   * ---------------------------------------------------------------------- */

  _buildCatwalk(b) {
    const m = this._materials(b);

    // Elevated walkway down the east side, with a railing on the open edge.
    const x = HALF_W - 3.2;
    b.box({ size: [4.4, 0.18, 34], position: [x, CATWALK_Y, -4], material: m.steel });

    // Railing posts and a top rail. Merged: this is decoration, and the deck
    // below already does the job of stopping the quad.
    const rails = [];
    for (let z = -21; z <= 13; z += 2.2) {
      rails.push({ size: [0.07, 1.05, 0.07], position: [x - 2.1, CATWALK_Y + 0.6, z] });
    }
    rails.push({ size: [0.09, 0.09, 34], position: [x - 2.1, CATWALK_Y + 1.1, -4] });
    b.mergeStatic(rails, m.steel, { name: 'catwalk-rail' });
    b.boxBody({ size: [0.12, 1.1, 34], position: [x - 2.1, CATWALK_Y + 0.6, -4] });

    // Stair run up from the floor — a genuinely tight line to climb.
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      b.box({
        size: [1.5, 0.1, 0.42],
        position: [x + 0.9, 0.3 + i * (CATWALK_Y - 0.3) / steps, 14 + i * 0.44],
        material: m.steel,
      });
    }

    // A small mezzanine office at the north end of the walk.
    b.box({ size: [4.4, 0.16, 6], position: [x, CATWALK_Y, -24], material: m.steel });
    b.box({ size: [0.12, 2.6, 6], position: [x - 2.1, CATWALK_Y + 1.4, -24], material: m.dark });
    b.box({ size: [4.4, 0.16, 0.12], position: [x, CATWALK_Y + 2.7, -27], material: m.dark });
  }

  /* ---------------------------------------------------------------------- *
   * Shelving
   * ---------------------------------------------------------------------- */

  /**
   * Two long shelving runs forming a central "canyon". Uprights are instanced;
   * the horizontal beams are merged. This is where most of the racing line is.
   */
  *_buildShelving(b) {
    const m = this._materials(b);

    const uprightGeo = new THREE.BoxGeometry(0.12, 6.0, 0.12);
    b._looseGeometries.add(uprightGeo);
    const uprights = [];
    const beams = [];

    for (const sx of [-1, 1]) {
      const baseX = sx * 11.5;
      for (let z = -24; z <= 18; z += 3.0) {
        for (const ox of [-0.55, 0.55]) {
          uprights.push({ position: [baseX + ox, 3.0, z] });
          b.boxBody({ size: [0.16, 6.0, 0.16], position: [baseX + ox, 3.0, z] });
        }
        // Shelf beams at three levels between consecutive uprights.
        if (z < 18) {
          for (const y of [1.4, 3.0, 4.6]) {
            for (const ox of [-0.55, 0.55]) {
              beams.push({ size: [0.1, 0.14, 3.0], position: [baseX + ox, y, z + 1.5] });
            }
            beams.push({ size: [1.2, 0.06, 2.9], position: [baseX, y - 0.08, z + 1.5] });
          }
        }
      }
      yield { progress: 0.52 + 0.06 * (sx > 0 ? 1 : 0), label: 'Shelving' };
    }

    b.instanced(uprightGeo, m.steel, uprights);
    b.mergeStatic(beams, m.rust, { name: 'shelf-beams' });

    // One long collider per shelf level per run, instead of one per beam.
    for (const sx of [-1, 1]) {
      for (const y of [1.4, 3.0, 4.6]) {
        b.boxBody({ size: [1.3, 0.2, 42], position: [sx * 11.5, y, -3] });
      }
    }
    yield { progress: 0.64, label: 'Shelving' };
  }

  /* ---------------------------------------------------------------------- *
   * Crates, pallets, containers
   * ---------------------------------------------------------------------- */

  *_buildCrates(b) {
    const m = this._materials(b);

    // --- pallet-sized crates, instanced ---
    const crateGeo = new THREE.BoxGeometry(1.1, 0.9, 1.1);
    b._looseGeometries.add(crateGeo);
    const crates = [];

    /** A stack of 1–3 crates at a spot, with colliders. */
    const stack = (x, z, n) => {
      for (let i = 0; i < n; i++) {
        const jx = x + rnd(b, -0.1, 0.1);
        const jz = z + rnd(b, -0.1, 0.1);
        const y = 0.45 + i * 0.92;
        crates.push({ position: [jx, y, jz], rotationY: rnd(b, -0.25, 0.25) });
        b.boxBody({ size: [1.2, 0.95, 1.2], position: [jx, y, jz] });
      }
    };

    // Stacks along the shelving canyon and scattered through the open bays.
    for (let z = -22; z <= 20; z += 4.5) {
      stack(rnd(b, -7.5, -3.5), z + rnd(b, -1, 1), rndInt(b, 1, 3));
      stack(rnd(b, 3.5, 7.5), z + rnd(b, -1, 1), rndInt(b, 1, 3));
      if ((z + 22) % 9 < 4.5) yield { progress: 0.66 + 0.05 * ((z + 22) / 42), label: 'Crates' };
    }
    for (let i = 0; i < 16; i++) {
      stack(rnd(b, -17, 17), rnd(b, -27, 26), rndInt(b, 1, 2));
    }
    b.instanced(crateGeo, m.crate, crates);

    yield { progress: 0.73, label: 'Containers' };

    // --- shipping-container-sized blocks ---
    const containers = [
      { x: -15.5, z: -20, ry: 0.06, h: 2.6 },
      { x: -15.5, z: -13, ry: -0.04, h: 2.6 },
      { x: 15.5, z: 6, ry: 0.03, h: 2.6 },
      { x: 15.5, z: 13, ry: 0.0, h: 2.6 },
      { x: -15.5, z: 14, ry: 0.02, h: 2.6 },
    ];
    for (const c of containers) {
      b.box({
        size: [5.8, c.h, 2.4],
        position: [c.x, c.h / 2, c.z],
        rotationY: c.ry,
        material: m.rust,
      });
    }
    // One stacked pair to fly over or between.
    b.box({ size: [5.8, 2.6, 2.4], position: [-15.5, 3.9, -13], rotationY: -0.02, material: m.rust });

    yield { progress: 0.77, label: 'Containers' };
  }

  /* ---------------------------------------------------------------------- *
   * Machinery, pipes, chains, debris
   * ---------------------------------------------------------------------- */

  _buildMachinery(b) {
    const m = this._materials(b);

    // Old machinery blocks at the north end.
    b.box({ size: [3.2, 2.2, 2.0], position: [-6, 1.1, -25], material: m.dark });
    b.box({ size: [1.2, 1.4, 1.2], position: [-6, 2.9, -25], material: m.steel });
    b.box({ size: [4.0, 1.6, 1.6], position: [6.5, 0.8, -26], material: m.dark });
    b.cylinder({
      radiusTop: 0.9, radiusBottom: 0.9, height: 2.4, segments: 12,
      position: [10, 1.2, -22], material: m.rust,
    });
    b.cylinder({
      radiusTop: 0.55, radiusBottom: 0.55, height: 1.6, segments: 10,
      position: [-11, 0.8, -27], material: m.rust,
    });

    // Overhead pipe runs — low enough to matter at speed.
    const pipes = [];
    for (const x of [-4.5, -3.6, 4.0]) {
      pipes.push({ size: [0.28, 0.28, L - 6], position: [x, 7.4, 0] });
    }
    b.mergeStatic(pipes, m.rust, { name: 'pipes' });
    for (const x of [-4.5, -3.6, 4.0]) {
      b.boxBody({ size: [0.3, 0.3, L - 6], position: [x, 7.4, 0] });
    }

    // Hanging chains: static, collidable, and easy to clip.
    const chainMat = b.material('chain', () => new THREE.MeshStandardMaterial({
      color: 0x4a4d52, roughness: 0.6, metalness: 0.8,
    }));
    for (const [x, z] of [[-2, 10], [2.4, -3], [-8, -16], [9, 18], [0, -22]]) {
      const len = rnd(b, 2.2, 4.2);
      b.cylinder({
        radiusTop: 0.05, radiusBottom: 0.05, height: len, segments: 6,
        position: [x, H - 1.6 - len / 2, z], material: chainMat,
      });
    }

    // Floor debris: instanced flat slabs, no colliders (they are 5 cm thick and
    // catching on them would just be annoying).
    const debrisGeo = new THREE.BoxGeometry(1, 0.05, 1);
    b._looseGeometries.add(debrisGeo);
    const debris = [];
    for (let i = 0; i < 90; i++) {
      debris.push({
        position: [rnd(b, -18, 18), 0.03, rnd(b, -28, 28)],
        rotationY: rnd(b, 0, Math.PI * 2),
        scale: [rnd(b, 0.3, 1.4), 1, rnd(b, 0.3, 1.2)],
      });
    }
    b.instanced(debrisGeo, m.dark, debris);
  }

  /* ---------------------------------------------------------------------- *
   * Lighting and dust
   * ---------------------------------------------------------------------- */

  _buildLighting(b) {
    // Cool ambient from the skylights, warm industrial fixtures below.
    b.addLight(new THREE.HemisphereLight(0x93a8bd, 0x14171b, 0.85));

    const sun = new THREE.DirectionalLight(0xd8e6f2, 0.9);
    sun.position.set(20, 60, -10);
    b.addLight(sun);

    const fixture = b.material('fixture', () => new THREE.MeshStandardMaterial({
      color: 0xffe9c4, emissive: 0xffdca0, emissiveIntensity: 2.0, roughness: 0.6,
    }));

    const spots = [[0, -22], [0, -8], [0, 8], [0, 22], [-13, 0], [13, -14]];
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      b.box({
        size: [1.1, 0.14, 0.5], position: [x, H - 2.0, z],
        material: fixture, collide: false,
      });
      const light = new THREE.PointLight(0xffd9a4, 22, 26, 2);
      light.position.set(x, H - 2.2, z);
      b.addLight(light);
      // One fixture is on its way out.
      if (i === 3) this._flicker = light;
    }
  }

  /**
   * Dust motes: one additive Points cloud drifting slowly. A few hundred
   * points cost essentially nothing and do more for the atmosphere than any
   * amount of extra geometry would.
   */
  _buildDust(b) {
    const COUNT = 420;
    const positions = new Float32Array(COUNT * 3);
    const vel = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = rnd(b, -HALF_W + 2, HALF_W - 2);
      positions[i * 3 + 1] = rnd(b, 0.4, H - 1);
      positions[i * 3 + 2] = rnd(b, -HALF_L + 2, HALF_L - 2);
      vel[i * 3] = rnd(b, -0.09, 0.09);
      vel[i * 3 + 1] = rnd(b, -0.03, 0.05);
      vel[i * 3 + 2] = rnd(b, -0.09, 0.09);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    b._looseGeometries.add(geo);

    const mat = b.material('dust', () => new THREE.PointsMaterial({
      color: 0xd8e4ee,
      size: 0.055,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }));

    this._dust = new THREE.Points(geo, mat);
    this._dust.frustumCulled = false;   // the cloud spans the whole building
    b.root.add(this._dust);
    this._dustVel = vel;
  }

  /* ---------------------------------------------------------------------- *
   * Race course
   * ---------------------------------------------------------------------- */

  /**
   * Eight gates: down the canyon, up onto the catwalk level, a hairpin at the
   * north end, back down the far side, and out through the roller door.
   */
  _buildGates(b) {
    const layout = [
      { x: 0, y: 2.0, z: 18, ry: 0, r: 1.5 },              // start, down the shed
      { x: -9.0, y: 2.2, z: 6, ry: Math.PI * 0.18, r: 1.4 },
      { x: 0, y: 6.4, z: -4, ry: 0, r: 1.5 },              // climb over the shelving
      { x: 13.0, y: 2.4, z: -14, ry: Math.PI * 0.5, r: 1.4 },
      { x: 0, y: 2.0, z: -25, ry: Math.PI, r: 1.5 },       // hairpin at the north wall
      { x: -13.0, y: 5.6, z: -14, ry: Math.PI * 0.5, r: 1.4 },
      { x: -8.0, y: 2.2, z: 4, ry: Math.PI * 0.85, r: 1.4 },
      { x: 4.9, y: 2.4, z: HALF_L - 0.6, ry: 0, r: 1.6 },  // out through the door
    ];

    this.gates = layout.map((g, i) => b.gate({
      position: [g.x, g.y, g.z],
      rotationY: g.ry,
      radius: g.r,
      tube: 0.085,
      index: i,
    }));
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  update(dt, elapsed) {
    // Drift the dust, wrapping it back into the building at the edges so the
    // cloud never thins out.
    if (this._dust && this._dustVel) {
      const pos = this._dust.geometry.attributes.position;
      const arr = pos.array;
      const v = this._dustVel;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += v[i] * dt;
        arr[i + 1] += v[i + 1] * dt;
        arr[i + 2] += v[i + 2] * dt;

        if (arr[i] < -HALF_W + 1) arr[i] = HALF_W - 1;
        else if (arr[i] > HALF_W - 1) arr[i] = -HALF_W + 1;
        if (arr[i + 1] < 0.2) arr[i + 1] = H - 1;
        else if (arr[i + 1] > H - 0.5) arr[i + 1] = 0.3;
        if (arr[i + 2] < -HALF_L + 1) arr[i + 2] = HALF_L - 1;
        else if (arr[i + 2] > HALF_L - 1) arr[i + 2] = -HALF_L + 1;
      }
      pos.needsUpdate = true;
    }

    if (this._flicker) {
      const f = Math.sin(elapsed * 17.7) * Math.sin(elapsed * 5.3);
      this._flicker.intensity = f > 0.42 ? 3 : 22;
    }
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this._mats = null;
    this._dust = null;
    this._dustVel = null;
    this._flicker = null;
    this._skylights = null;
    this.gates = [];
    scene.background = this._prevBackground ?? null;
    scene.fog = this._prevFog ?? null;
  }
}
