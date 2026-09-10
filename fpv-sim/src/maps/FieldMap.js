/**
 * maps/FieldMap.js
 * ---------------------------------------------------------------------------
 * Map 3 — Open Field. The high-speed, long-range map.
 *
 * 512 m of gently rolling terrain with a barn, a tree line, fencing, a pond,
 * and a power-line run strung between poles for pilots who want something
 * genuinely hard to thread.
 *
 * Terrain is the interesting part. A single `terrainHeight(x, z)` function is
 * the source of truth for *both* the displaced visual mesh and the cannon
 * Heightfield collider, and every prop is seated by sampling it. That is the
 * only way the two stay in agreement — computing them independently is how you
 * end up with trees floating a metre above a hill.
 *
 * If the Heightfield shape cannot be built (it is the most complex collider
 * cannon has), we fall back to a flat ground slab. The field stays flyable and
 * only the hill contact is approximate — degradation, not failure.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { MapBuilder, rnd, rndInt } from './MapKit.js';
import { GROUP } from '../core/PhysicsWorld.js';
import {
  grassTexture, dirtTexture, barnWoodTexture, barkTexture,
  foliageTexture, skyTexture, waterTexture, corrugatedMetalTexture,
  paintedMetalTexture,
} from '../assets/procedural.js';

/* --- Terrain extents ----------------------------------------------------- */
const TERRAIN_SIZE = 512;          // m across, centred on the origin
const HF_CELLS = 64;               // Heightfield grid resolution
const HF_ELEMENT = TERRAIN_SIZE / HF_CELLS;   // 8 m per cell
const HALF = TERRAIN_SIZE / 2;

/** Playable volume; leaving it triggers an auto-respawn. */
const BOUND_XZ = 250;
const BOUND_Y = 220;

/**
 * Rolling ground: three octaves of sin/cos at decreasing wavelength and
 * amplitude. Analytic rather than sampled noise so the visual mesh, the
 * collider grid, and every prop placement can evaluate the *exact* same
 * surface at arbitrary coordinates without sharing a lattice.
 */
export function terrainHeight(x, z) {
  return (
    1.85 * Math.sin(x * 0.0125) * Math.cos(z * 0.0104) +
    0.90 * Math.sin(x * 0.0310 + 1.7) * Math.cos(z * 0.0270 - 0.6) +
    0.32 * Math.sin(x * 0.0830 - 2.1) * Math.cos(z * 0.0710 + 1.2)
  );
}

export const FIELD_META = {
  id: 'field',
  displayName: 'Open Field',
  description: 'Open-space long-range. Rolling terrain, a barn, a tree line, and power lines for the brave.',
  accent: 'linear-gradient(160deg, #7fb2d9 0%, #a9c98a 55%, #6f8f4e 100%)',
};

export class FieldMap {
  constructor() {
    this.id = 'field';

    // Spawn in the clearing just outside the barn, facing down the field.
    const sx = -26;
    const sz = 34;
    // Sat in the grass. The extra 6 cm over the collider's resting height
    // absorbs the small difference between the analytic terrain and the
    // heightfield's piecewise-linear approximation of it.
    this.spawnPoint = new THREE.Vector3(sx, terrainHeight(sx, sz) + 0.18, sz);
    // Heading 0 keeps local -Z pointing down-field, which puts gate 1 (at
    // z = 6, ~28 m ahead) directly in front of the pilot on spawn. The barn
    // sits behind-left as a landmark.
    this.spawnHeading = 0;

    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-BOUND_XZ, -12, -BOUND_XZ),
      max: new THREE.Vector3(BOUND_XZ, BOUND_Y, BOUND_XZ),
    };

    this.builder = null;
    this._sky = null;
    this._prevFog = null;
    this._prevBackground = null;
    this._water = null;
    this._dust = null;
    this._dustVel = null;
    this._dustPhase = 0;
    this._dustHalf = null;
  }

  /** AGL reference used by the HUD altimeter. */
  getGroundHeight(x, z) {
    const h = terrainHeight(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  /* ====================================================================== *
   * Build
   * ====================================================================== */

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: 4021, name: 'field-map' });
    this.builder = b;

    yield { progress: 0.02, label: 'Sky' };
    this._buildSky(scene, b);

    yield { progress: 0.12, label: 'Terrain' };
    yield* this._buildTerrain(b, physics);

    yield { progress: 0.42, label: 'Barn' };
    this._buildBarn(b);

    yield { progress: 0.54, label: 'Tree line' };
    yield* this._buildTrees(b);

    yield { progress: 0.70, label: 'Fencing' };
    this._buildFence(b);

    yield { progress: 0.78, label: 'Pond' };
    this._buildPond(b);

    yield { progress: 0.84, label: 'Power lines' };
    this._buildPowerLines(b);
    this._buildDust(b);

    yield { progress: 0.90, label: 'Scatter' };
    yield* this._buildScatter(b);

    yield { progress: 0.96, label: 'Course' };
    this._buildGates(b);

    yield { progress: 1, label: 'Ready' };
  }

  /* ---------------------------------------------------------------------- *
   * Sky and lighting
   * ---------------------------------------------------------------------- */

  _buildSky(scene, b) {
    this._prevBackground = scene.background;
    this._prevFog = scene.fog;

    const skyTex = b.tex(skyTexture(3601));
    if (skyTex) {
      const geo = b.geometry('sky', () => new THREE.SphereGeometry(1400, 24, 16));
      const mat = b.material('sky', () => new THREE.MeshBasicMaterial({
        map: skyTex,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }));
      this._sky = new THREE.Mesh(geo, mat);
      b.root.add(this._sky);
      scene.background = null;
    } else {
      // Texture generation failed — a flat sky colour keeps the map usable.
      scene.background = new THREE.Color(0x8fbcdd);
    }

    // Aerial perspective. Far enough out that it never obscures gameplay, but
    // it stops the terrain edge from ending in a hard line against the sky.
    scene.fog = new THREE.Fog(0xc3d6e2, 180, 900);

    b.addLight(new THREE.HemisphereLight(0xbcd8f2, 0x5d6b45, 1.55));

    const sun = new THREE.DirectionalLight(0xfff2d8, 2.1);
    sun.position.set(120, 165, -80);
    b.addLight(sun);

    // A dim fill from the opposite side keeps shadowed faces from going flat
    // black without paying for a second shadow-casting light.
    const fill = new THREE.DirectionalLight(0x9ab6d0, 0.45);
    fill.position.set(-90, 60, 110);
    b.addLight(fill);
  }

  /* ---------------------------------------------------------------------- *
   * Terrain
   * ---------------------------------------------------------------------- */

  *_buildTerrain(b, physics) {
    // --- visual mesh --------------------------------------------------
    const segments = 128;
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments);

    // PlaneGeometry is built in the XY plane; we displace Z and then rotate
    // the whole thing flat, so "Z" here becomes world height.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // After the -90° X rotation, local +Y maps to world -Z.
      pos.setZ(i, terrainHeight(x, -y));
      if ((i & 4095) === 0) yield { progress: 0.12 + 0.12 * (i / pos.count), label: 'Terrain' };
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    b._looseGeometries.add(geo);

    const grassTex = b.tex(grassTexture(3101, [110, 110]));
    const grassMat = b.material('grass', () => new THREE.MeshStandardMaterial({
      color: grassTex ? 0xffffff : 0x6d8f4a,
      map: grassTex,
      roughness: 0.98,
      metalness: 0,
    }));

    const ground = new THREE.Mesh(geo, grassMat);
    ground.rotation.x = -Math.PI / 2;
    b.root.add(ground);

    yield { progress: 0.28, label: 'Terrain' };

    // A large flat skirt so the horizon reads as continuous land rather than
    // a 512 m square floating in fog.
    const skirtGeo = b.geometry('skirt', () => new THREE.PlaneGeometry(2400, 2400));
    const skirtMat = b.material('skirt', () => new THREE.MeshStandardMaterial({
      color: 0x5f7a43, roughness: 1, metalness: 0, fog: true,
    }));
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.y = -2.6;
    b.root.add(skirt);

    yield { progress: 0.32, label: 'Ground collision' };

    // --- collider -----------------------------------------------------
    this._buildTerrainCollider(b, physics);

    yield { progress: 0.40, label: 'Ground collision' };
  }

  /**
   * cannon Heightfield matching the visual terrain.
   *
   * The shape is defined in its own local frame with height along local +Z, so
   * the body is rotated -90° about X to stand it up as ground. With that
   * rotation local +X maps to world +X and local +Y maps to world -Z, which is
   * why the sample below reads `terrainHeight(worldX, -localY)`.
   */
  _buildTerrainCollider(b, physics) {
    try {
      const data = [];
      for (let i = 0; i <= HF_CELLS; i++) {
        const col = [];
        const wx = -HALF + i * HF_ELEMENT;
        for (let j = 0; j <= HF_CELLS; j++) {
          const localY = j * HF_ELEMENT;
          // Body origin sits at (-HALF, 0, +HALF); local +Y runs toward -Z.
          const wz = HALF - localY;
          const h = terrainHeight(wx, wz);
          col.push(Number.isFinite(h) ? h : 0);
        }
        data.push(col);
      }

      const shape = new CANNON.Heightfield(data, { elementSize: HF_ELEMENT });
      const body = new CANNON.Body({
        mass: 0,
        material: physics.hardMaterial,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: GROUP.DRONE,
      });
      body.addShape(shape);
      body.position.set(-HALF, 0, HALF);
      body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);

      physics.addBody(body);
      b._bodies.push(body);
      this._usingHeightfield = true;
    } catch (err) {
      console.warn('[FieldMap] Heightfield unavailable; using a flat ground slab.', err);
      this._usingHeightfield = false;
      b.boxBody({
        size: [TERRAIN_SIZE * 1.4, 4, TERRAIN_SIZE * 1.4],
        position: [0, -2, 0],
      });
    }

    // Invisible ceiling so a vertical punch-out cannot leave the world.
    b.boxBody({ size: [TERRAIN_SIZE * 1.4, 2, TERRAIN_SIZE * 1.4], position: [0, BOUND_Y + 6, 0] });
  }

  /* ---------------------------------------------------------------------- *
   * Barn
   * ---------------------------------------------------------------------- */

  _buildBarn(b) {
    const bx = -34;
    const bz = 46;
    const base = terrainHeight(bx, bz);

    const W = 14, D = 20, H = 7;

    const wallTex = b.tex(barnWoodTexture(3301, [5, 3]));
    const wallMat = b.material('barn-wall', () => new THREE.MeshStandardMaterial({
      color: wallTex ? 0xffffff : 0x8a3028, map: wallTex, roughness: 0.92,
    }));
    const roofTex = b.tex(corrugatedMetalTexture(3302, [7, 3]));
    const roofMat = b.material('barn-roof', () => new THREE.MeshStandardMaterial({
      color: roofTex ? 0xdddddd : 0x6b6f74, map: roofTex, roughness: 0.6, metalness: 0.5,
    }));
    const floorTex = b.tex(dirtTexture(3303, [5, 6]));
    const floorMat = b.material('barn-floor', () => new THREE.MeshStandardMaterial({
      color: floorTex ? 0xffffff : 0x6d5844, map: floorTex, roughness: 1,
    }));

    // Levelled pad under the barn, so it does not sit on a slope.
    b.box({ size: [W + 2, 0.5, D + 2], position: [bx, base + 0.1, bz], material: floorMat });

    // Side walls (full length).
    b.box({ size: [0.4, H, D], position: [bx - W / 2, base + H / 2 + 0.3, bz], material: wallMat });
    b.box({ size: [0.4, H, D], position: [bx + W / 2, base + H / 2 + 0.3, bz], material: wallMat });

    // Back wall (solid).
    b.box({ size: [W, H, 0.4], position: [bx, base + H / 2 + 0.3, bz + D / 2], material: wallMat });

    // Front wall with a big central door opening — the barn is fly-through.
    const doorW = 5.0;
    const doorH = 5.0;
    const sideW = (W - doorW) / 2;
    for (const s of [-1, 1]) {
      b.box({
        size: [sideW, H, 0.4],
        position: [bx + s * (doorW / 2 + sideW / 2), base + H / 2 + 0.3, bz - D / 2],
        material: wallMat,
      });
    }
    // Lintel above the door.
    b.box({
      size: [doorW, H - doorH, 0.4],
      position: [bx, base + doorH + (H - doorH) / 2 + 0.3, bz - D / 2],
      material: wallMat,
    });

    // Gable roof: two slabs leaning against each other.
    const slope = Math.atan2(3.2, W / 2);
    const slabLen = Math.hypot(W / 2, 3.2) + 0.4;
    for (const s of [-1, 1]) {
      b.box({
        size: [slabLen, 0.3, D + 1],
        position: [bx + s * W / 4, base + H + 1.9, bz],
        rotation: [0, 0, -s * slope],
        material: roofMat,
      });
    }
    // Gable end triangles, approximated with a stepped stack of boxes.
    for (let i = 0; i < 4; i++) {
      const w = W * (1 - i / 4);
      const y = base + H + 0.3 + i * 0.8 + 0.4;
      for (const s of [-1, 1]) {
        b.box({
          size: [w, 0.8, 0.35],
          position: [bx, y, bz + s * D / 2],
          material: wallMat,
          collide: false,
        });
      }
    }

    // Hay bales inside — obstacles for a low pass straight through the barn.
    const hayMat = b.standard('hay', { color: 0xc9ae62, roughness: 1 });
    const balePositions = [
      [-3.4, 3.0], [-3.4, 5.2], [-3.4, 7.4],
      [3.6, -2.0], [3.6, 0.2],
      [0.2, 8.0],
    ];
    for (const [ox, oz] of balePositions) {
      b.box({
        size: [1.5, 1.0, 1.0],
        position: [bx + ox, base + 0.85, bz + oz],
        rotationY: rnd(b, -0.35, 0.35),
        material: hayMat,
        surface: 'soft',
      });
    }

    // A hay loft platform across the back third — flyable over or under.
    b.box({
      size: [W - 1, 0.25, 6],
      position: [bx, base + 4.2, bz + D / 2 - 3.5],
      material: floorMat,
    });

    this.barn = { x: bx, z: bz, base, width: W, depth: D };
  }

  /* ---------------------------------------------------------------------- *
   * Trees
   * ---------------------------------------------------------------------- */

  *_buildTrees(b) {
    const barkTex = b.tex(barkTexture(3401, [1, 3]));
    const trunkMat = b.material('trunk', () => new THREE.MeshStandardMaterial({
      color: barkTex ? 0xffffff : 0x5a462f, map: barkTex, roughness: 0.95,
    }));
    const leafTex = b.tex(foliageTexture(3402));
    const leafMat = b.material('leaf', () => new THREE.MeshStandardMaterial({
      color: leafTex ? 0xffffff : 0x3f6b30, map: leafTex, roughness: 0.9,
    }));

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 1, 6);
    const canopyGeo = new THREE.IcosahedronGeometry(1, 0);
    b._looseGeometries.add(trunkGeo);
    b._looseGeometries.add(canopyGeo);

    const trunks = [];
    const canopies = [];

    /** Place one tree, seated on the terrain, with a cheap box+sphere collider. */
    const plant = (x, z, scale) => {
      const y = terrainHeight(x, z);
      const trunkH = 4.2 * scale;
      const canopyR = 2.1 * scale;
      const canopyY = y + trunkH + canopyR * 0.45;

      trunks.push({ position: [x, y + trunkH / 2, z], scale: [scale, trunkH, scale], rotationY: rnd(b, 0, Math.PI) });
      canopies.push({ position: [x, canopyY, z], scale: canopyR * rnd(b, 0.85, 1.15), rotationY: rnd(b, 0, Math.PI) });

      // Box for the trunk (far cheaper than a convex cylinder hull) and a
      // sphere for the canopy — the two shapes cannon resolves fastest.
      b.boxBody({ size: [0.55 * scale, trunkH, 0.55 * scale], position: [x, y + trunkH / 2, z] });
      b.sphereBody({ radius: canopyR * 0.82, position: [x, canopyY, z], surface: 'soft' });
    };

    // A wind-break line along the north edge.
    for (let i = 0; i < 46; i++) {
      const x = -190 + i * 8.4 + rnd(b, -2.6, 2.6);
      const z = -150 + rnd(b, -6, 6);
      plant(x, z, rnd(b, 0.85, 1.35));
      if ((i % 12) === 0) yield { progress: 0.54 + 0.05 * (i / 46), label: 'Tree line' };
    }

    // A second line running down the east side.
    for (let i = 0; i < 34; i++) {
      const x = 168 + rnd(b, -7, 7);
      const z = -130 + i * 8.2 + rnd(b, -3, 3);
      plant(x, z, rnd(b, 0.8, 1.25));
    }
    yield { progress: 0.61, label: 'Tree line' };

    // Loose copses scattered across the field.
    for (let c = 0; c < 7; c++) {
      const cx = rnd(b, -170, 150);
      const cz = rnd(b, -90, 170);
      const n = rndInt(b, 4, 9);
      for (let i = 0; i < n; i++) {
        plant(cx + rnd(b, -13, 13), cz + rnd(b, -13, 13), rnd(b, 0.7, 1.3));
      }
      yield { progress: 0.61 + 0.08 * (c / 7), label: 'Tree line' };
    }

    b.instanced(trunkGeo, trunkMat, trunks);
    b.instanced(canopyGeo, leafMat, canopies);
    this._treeCount = trunks.length;
  }

  /* ---------------------------------------------------------------------- *
   * Fence
   * ---------------------------------------------------------------------- */

  _buildFence(b) {
    const woodMat = b.standard('fence-wood', { color: 0x8b7355, roughness: 0.95 });
    const postGeo = new THREE.BoxGeometry(0.13, 1.5, 0.13);
    b._looseGeometries.add(postGeo);

    const posts = [];
    const rails = [];

    // Two runs meeting at a corner, enclosing the paddock south of the barn.
    const runs = [
      { from: [-96, 96], to: [78, 96] },
      { from: [78, 96], to: [78, -34] },
    ];

    for (const run of runs) {
      const [x0, z0] = run.from;
      const [x1, z1] = run.to;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(2, Math.round(len / 3.2));
      const angle = Math.atan2(x1 - x0, z1 - z0);

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        posts.push({ position: [x, terrainHeight(x, z) + 0.75, z], rotationY: angle });
      }

      // Two horizontal rails per span, following the ground.
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const xa = x0 + (x1 - x0) * t0, za = z0 + (z1 - z0) * t0;
        const xb = x0 + (x1 - x0) * t1, zb = z0 + (z1 - z0) * t1;
        const mx = (xa + xb) / 2, mz = (za + zb) / 2;
        const my = (terrainHeight(xa, za) + terrainHeight(xb, zb)) / 2;
        const spanLen = Math.hypot(xb - xa, zb - za) + 0.1;
        for (const h of [0.55, 1.15]) {
          rails.push({
            size: [0.08, 0.14, spanLen],
            position: [mx, my + h, mz],
            rotationY: angle,
          });
        }
      }
    }

    b.instanced(postGeo, woodMat, posts);
    b.mergeStatic(rails, woodMat, { name: 'fence-rails' });

    // One long thin collider per run rather than one per rail: the quad only
    // needs to be stopped by the fence, not to feel each individual plank.
    for (const run of runs) {
      const [x0, z0] = run.from;
      const [x1, z1] = run.to;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const angle = Math.atan2(x1 - x0, z1 - z0);
      b.boxBody({
        size: [0.16, 1.5, len],
        position: [mx, terrainHeight(mx, mz) + 0.75, mz],
        rotationY: angle,
      });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Pond
   * ---------------------------------------------------------------------- */

  _buildPond(b) {
    const px = 46, pz = 12, r = 17;
    const y = terrainHeight(px, pz) - 0.55;

    const waterTex = b.tex(waterTexture(3701, [4, 4]));
    const waterMat = b.material('water', () => new THREE.MeshStandardMaterial({
      color: waterTex ? 0xffffff : 0x2d5f7a,
      map: waterTex,
      roughness: 0.12,     // low roughness reads as a wet, reflective surface
      metalness: 0.55,
      transparent: true,
      opacity: 0.92,
    }));

    const geo = b.geometry('pond', () => new THREE.CircleGeometry(r, 40));
    const mesh = new THREE.Mesh(geo, waterMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(px, y, pz);
    b.root.add(mesh);
    this._water = mesh;

    // Muddy rim so the water does not just stop against grass.
    const dirtTex = b.tex(dirtTexture(3702, [6, 6]));
    const rimMat = b.material('pond-rim', () => new THREE.MeshStandardMaterial({
      color: dirtTex ? 0xffffff : 0x6a563e, map: dirtTex, roughness: 1,
    }));
    const rimGeo = b.geometry('pond-rim', () => new THREE.RingGeometry(r, r + 3.2, 40));
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(px, y + 0.06, pz);
    b.root.add(rim);

    // The water surface is solid: ditching into it ends the run, as it should.
    b.boxBody({ size: [r * 1.7, 0.6, r * 1.7], position: [px, y - 0.3, pz], surface: 'soft' });
  }

  /* ---------------------------------------------------------------------- *
   * Power lines
   * ---------------------------------------------------------------------- */

  _buildPowerLines(b) {
    const poleMat = b.standard('pole', { color: 0x6b5943, roughness: 0.95 });
    const wireMat = b.standard('wire', { color: 0x1a1a1c, roughness: 0.6, metalness: 0.4 });

    const poleH = 11;
    const xs = [-150, -80, -10, 60, 130];
    const z = -62;

    const wireSegments = [];

    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const base = terrainHeight(x, z);

      b.cylinder({
        radiusTop: 0.19, radiusBottom: 0.28, height: poleH, segments: 8,
        position: [x, base + poleH / 2, z], material: poleMat,
      });
      // Crossarm.
      b.box({
        size: [3.4, 0.18, 0.18],
        position: [x, base + poleH - 0.7, z],
        material: poleMat,
      });

      // Wire spans between consecutive poles, with a shallow catenary sag.
      if (i > 0) {
        const xPrev = xs[i - 1];
        const yPrev = terrainHeight(xPrev, z) + poleH - 0.75;
        const yHere = base + poleH - 0.75;
        const SEGS = 7;
        for (const off of [-1.4, 0, 1.4]) {
          for (let s = 0; s < SEGS; s++) {
            const t0 = s / SEGS;
            const t1 = (s + 1) / SEGS;
            const sag = (t) => 1.5 * Math.sin(Math.PI * t);   // droop between poles
            const xa = xPrev + (x - xPrev) * t0;
            const xb = xPrev + (x - xPrev) * t1;
            const ya = yPrev + (yHere - yPrev) * t0 - sag(t0);
            const yb = yPrev + (yHere - yPrev) * t1 - sag(t1);
            const len = Math.hypot(xb - xa, yb - ya);
            wireSegments.push({
              size: [len, 0.055, 0.055],
              position: [(xa + xb) / 2, (ya + yb) / 2, z + off],
              rotation: [0, 0, Math.atan2(yb - ya, xb - xa)],
            });
          }
        }
      }
    }

    // Wires: merged for drawing, but each segment gets a real collider —
    // clipping a power line at 30 m/s should absolutely end your run.
    for (const seg of wireSegments) {
      b.box({
        size: seg.size, position: seg.position, rotation: seg.rotation,
        material: wireMat, collide: true,
      });
    }
  }

  /**
   * Dust/haze motes: a light additive cloud drifting low over the playable
   * core of the field (not the full 500 m extent — that would spread 1200
   * points too thin to read). Seated a few metres above the rolling terrain
   * so it never clips into a hillside.
   */
  _buildDust(b) {
    const COUNT = 1200;
    const HALF = 140;
    const positions = new Float32Array(COUNT * 3);
    const vel = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT; i++) {
      const x = rnd(b, -HALF, HALF);
      const z = rnd(b, -HALF, HALF);
      const ground = terrainHeight(x, z);
      const base = Number.isFinite(ground) ? ground : 0;
      positions[i * 3] = x;
      positions[i * 3 + 1] = base + rnd(b, 0.3, 9);
      positions[i * 3 + 2] = z;
      vel[i * 3] = rnd(b, -0.12, 0.12);
      vel[i * 3 + 1] = rnd(b, -0.03, 0.05);
      vel[i * 3 + 2] = rnd(b, -0.12, 0.12);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    b._looseGeometries.add(geo);

    const mat = b.material('dust', () => new THREE.PointsMaterial({
      color: 0xe8e0c8,
      size: 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }));

    this._dust = new THREE.Points(geo, mat);
    this._dust.frustumCulled = false;
    b.root.add(this._dust);
    this._dustVel = vel;
    this._dustHalf = HALF;
  }

  /* ---------------------------------------------------------------------- *
   * Scatter: rocks, bushes, ramps, tracks
   * ---------------------------------------------------------------------- */

  *_buildScatter(b) {
    // --- rocks --------------------------------------------------------
    const rockMat = b.standard('rock', { color: 0x8a8b86, roughness: 0.95 });
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    b._looseGeometries.add(rockGeo);

    const rocks = [];
    for (let i = 0; i < 54; i++) {
      const x = rnd(b, -200, 200);
      const z = rnd(b, -200, 200);
      const s = rnd(b, 0.5, 1.9);
      const y = terrainHeight(x, z) + s * 0.35;
      rocks.push({ position: [x, y, z], scale: [s, s * 0.7, s * rnd(b, 0.8, 1.2)], rotationY: rnd(b, 0, 6.28) });
      if (s > 1.1) b.sphereBody({ radius: s * 0.7, position: [x, y, z] });
    }
    b.instanced(rockGeo, rockMat, rocks);

    yield { progress: 0.92, label: 'Scatter' };

    // --- bushes (no colliders: brushing scrub should not end a run) ----
    const bushMat = b.standard('bush', { color: 0x4a6b34, roughness: 1 });
    const bushGeo = new THREE.IcosahedronGeometry(1, 0);
    b._looseGeometries.add(bushGeo);

    const bushes = [];
    for (let i = 0; i < 130; i++) {
      const x = rnd(b, -220, 220);
      const z = rnd(b, -220, 220);
      const s = rnd(b, 0.5, 1.25);
      bushes.push({
        position: [x, terrainHeight(x, z) + s * 0.5, z],
        scale: [s * 1.3, s * 0.8, s * 1.3],
        rotationY: rnd(b, 0, 6.28),
      });
    }
    b.instanced(bushGeo, bushMat, bushes);

    yield { progress: 0.94, label: 'Scatter' };

    // --- dirt track ----------------------------------------------------
    const trackTex = b.tex(dirtTexture(3801, [1, 26]));
    const trackMat = b.material('track', () => new THREE.MeshStandardMaterial({
      color: trackTex ? 0xffffff : 0x7a6449,
      map: trackTex, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2,   // avoid z-fighting the grass
    }));
    const trackGeo = new THREE.PlaneGeometry(6, 220, 1, 44);
    const tp = trackGeo.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      // Drape the track over the terrain and give it a gentle S-curve.
      const lx = tp.getX(i);
      const ly = tp.getY(i);
      const wx = lx + Math.sin(ly * 0.03) * 16 - 12;
      const wz = -ly + 30;
      tp.setX(i, wx);
      tp.setZ(i, terrainHeight(wx, wz) + 0.05);
      tp.setY(i, ly);
    }
    tp.needsUpdate = true;
    trackGeo.computeVertexNormals();
    b._looseGeometries.add(trackGeo);
    const track = new THREE.Mesh(trackGeo, trackMat);
    track.rotation.x = -Math.PI / 2;
    track.position.z = 30;
    b.root.add(track);

    // --- ramps ---------------------------------------------------------
    const rampMat = b.standard('ramp', { color: 0x6f5a3f, roughness: 0.9 });
    const ramps = [
      { x: 8, z: -6, ry: 0.0 },
      { x: -58, z: -22, ry: 0.9 },
      { x: 92, z: 62, ry: -0.5 },
    ];
    for (const r of ramps) {
      const y = terrainHeight(r.x, r.z);
      b.box({
        size: [6, 0.35, 9],
        position: [r.x, y + 1.05, r.z],
        rotation: [0.26, r.ry, 0],
        material: rampMat,
      });
    }

    yield { progress: 0.96, label: 'Scatter' };
  }

  /* ---------------------------------------------------------------------- *
   * Race course
   * ---------------------------------------------------------------------- */

  _buildGates(b) {
    // A long, fast circuit that loops around the pond and back past the barn.
    // Headings are derived from the racing line by `course()`.
    const layout = [
      { x: -26, z: 6, r: 2.6 },
      { x: 6, z: -34, r: 2.6 },
      { x: 62, z: -52, r: 2.4 },
      { x: 104, z: 4, r: 2.6 },
      { x: 46, z: 58, r: 2.6 },
      { x: -18, z: 74, r: 2.6 },
    ];

    const points = layout.map((g) => ({
      x: g.x,
      y: terrainHeight(g.x, g.z) + g.r + 1.4,
      z: g.z,
      r: g.r,
    }));

    this.gates = b.course(points, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      tube: 0.12,
    });
  }

  /* ====================================================================== *
   * Runtime
   * ====================================================================== */

  update(dt, elapsed) {
    // Drift the water texture to fake a moving surface — one uniform update,
    // no shader work.
    if (this._water?.material?.map) {
      const m = this._water.material.map;
      m.offset.x = (elapsed * 0.006) % 1;
      m.offset.y = (elapsed * 0.004) % 1;
    }
  }

  /**
   * Dust kick-up: points within 2 m of the drone get pushed away and up,
   * scaled by average motor load and inverse-square distance. Everything
   * else drifts on its ambient velocity, wrapping back inside the dust
   * volume at the edges. Called by the main loop each frame; args are
   * optional and guarded so a missing drone reference or a bad dt just
   * falls back to ambient drift.
   */
  updatePropwash(dronePos, avgMotor, dt) {
    if (!this._dust || !this._dustVel) return;
    const dtc = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    if (dtc <= 0) return;
    this._dustPhase = (Number.isFinite(this._dustPhase) ? this._dustPhase : 0) + dtc;
    const t = this._dustPhase;
    const half = Number.isFinite(this._dustHalf) ? this._dustHalf : 140;

    const pos = this._dust.geometry.attributes.position;
    const arr = pos.array;
    const v = this._dustVel;
    const motor = Number.isFinite(avgMotor) ? Math.max(0, Math.min(1, avgMotor)) : 0;
    const dx0 = dronePos && Number.isFinite(dronePos.x) ? dronePos.x : null;
    const dy0 = dronePos && Number.isFinite(dronePos.y) ? dronePos.y : null;
    const dz0 = dronePos && Number.isFinite(dronePos.z) ? dronePos.z : null;
    const hasDrone = dx0 !== null && dy0 !== null && dz0 !== null;

    for (let i = 0; i < arr.length; i += 3) {
      let px = arr[i], py = arr[i + 1], pz = arr[i + 2];

      if (hasDrone && motor > 0.02) {
        const ddx = px - dx0, ddy = py - dy0, ddz = pz - dz0;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < 4) {
          const d = Math.sqrt(d2) || 0.001;
          const kick = (motor / (1 + d2)) * dtc * 3;
          px += (ddx / d) * kick;
          py += ((ddy / d) * 0.5 + 0.7) * kick;
          pz += (ddz / d) * kick;
        }
      }

      px += v[i] * dtc + Math.sin(t * 0.6 + i) * 0.01 * dtc;
      py += v[i + 1] * dtc;
      pz += v[i + 2] * dtc + Math.cos(t * 0.5 + i) * 0.01 * dtc;

      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
        px = (Math.random() - 0.5) * half;
        py = 5 + Math.random() * 4;
        pz = (Math.random() - 0.5) * half;
      }

      if (px < -half) px = half; else if (px > half) px = -half;
      if (py < 0.2) py = 9; else if (py > 12) py = 0.3;
      if (pz < -half) pz = half; else if (pz > half) pz = -half;

      arr[i] = px; arr[i + 1] = py; arr[i + 2] = pz;
    }
    pos.needsUpdate = true;
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this.gates = [];
    this._water = null;
    this._dust = null;
    this._dustVel = null;
    this._dustPhase = 0;
    this._dustHalf = null;
    scene.background = this._prevBackground ?? null;
    scene.fog = this._prevFog ?? null;
  }
}
