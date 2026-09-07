/**
 * maps/MapKit.js
 * ---------------------------------------------------------------------------
 * Shared construction kit for the three maps.
 *
 * All three need the same handful of operations — "put a box here with a
 * matching collider", "scatter 200 of these with one draw call", "hang a race
 * gate at this pose" — so they live here once instead of three times.
 *
 * The other job this class does is **resource ownership**. Every geometry,
 * material, texture, light, and physics body a map creates is registered here,
 * which turns teardown from "hope the map remembered everything" into a single
 * `dispose()` that provably releases the lot. That is what makes repeated map
 * switching leak-free.
 *
 * Geometries and materials are memoised by key, so a warehouse with 300 crates
 * holds one BoxGeometry and one material rather than 300 of each.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP } from '../core/PhysicsWorld.js';
import { makeRng } from '../assets/procedural.js';

export class MapBuilder {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {{ seed?: number, name?: string }} options
   */
  constructor(scene, physics, { seed = 1, name = 'map' } = {}) {
    this.scene = scene;
    this.physics = physics;
    this.rng = makeRng(seed);

    this.root = new THREE.Group();
    this.root.name = name;
    scene.add(this.root);

    /** @type {Map<string, THREE.BufferGeometry>} */
    this._geoCache = new Map();
    /** @type {Map<string, THREE.Material>} */
    this._matCache = new Map();
    /** @type {Set<THREE.Texture>} */
    this._textures = new Set();
    /** @type {CANNON.Body[]} */
    this._bodies = [];
    /** Geometries created outside the cache (merged/instanced one-offs). */
    this._looseGeometries = new Set();
  }

  /* ====================================================================== *
   * Resource memoisation
   * ====================================================================== */

  /** Get-or-create a shared geometry. `factory` runs at most once per key. */
  geometry(key, factory) {
    let g = this._geoCache.get(key);
    if (!g) {
      g = factory();
      this._geoCache.set(key, g);
    }
    return g;
  }

  /** Get-or-create a shared material. */
  material(key, factory) {
    let m = this._matCache.get(key);
    if (!m) {
      m = factory();
      this._matCache.set(key, m);
    }
    return m;
  }

  /**
   * Register a procedurally generated texture for disposal.
   * Accepts null (a failed generator) and passes it through unchanged, so
   * callers can write `map: this.tex(woodPlankTexture())` without a guard.
   */
  tex(texture) {
    if (texture) this._textures.add(texture);
    return texture || null;
  }

  /** Convenience: a standard material that tolerates a null texture map. */
  standard(key, { color = 0xffffff, map = null, roughness = 0.85, metalness = 0.0, ...rest } = {}) {
    return this.material(key, () => new THREE.MeshStandardMaterial({
      color, map: map || null, roughness, metalness, ...rest,
    }));
  }

  /* ====================================================================== *
   * Primitives
   * ====================================================================== */

  /**
   * A box with an optional matching static collider.
   *
   * @param {object} o
   * @param {[number,number,number]} o.size      full width/height/depth
   * @param {[number,number,number]} o.position  centre
   * @param {number} [o.rotationY]               yaw in radians
   * @param {THREE.Material} o.material
   * @param {boolean} [o.collide=true]
   * @param {'hard'|'soft'} [o.surface='hard']
   * @param {[number,number]} [o.uvScale]        repeat the material's map
   */
  box({
    size, position, rotationY = 0, rotation = null, material,
    collide = true, surface = 'hard', castShadow = false, receiveShadow = false,
  }) {
    const [w, h, d] = size;
    const key = `box:${w.toFixed(3)}:${h.toFixed(3)}:${d.toFixed(3)}`;
    const geo = this.geometry(key, () => new THREE.BoxGeometry(w, h, d));

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(position[0], position[1], position[2]);
    if (rotation) mesh.rotation.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
    else if (rotationY) mesh.rotation.y = rotationY;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    this.root.add(mesh);

    if (collide) {
      this.boxBody({ size, position, rotationY, rotation, surface });
    }
    return mesh;
  }

  /**
   * A static box collider with no visual — invisible walls, ceilings, and the
   * colliders behind merged geometry.
   *
   * `rotation` takes a full XYZ euler (for ramps and angled roofs);
   * `rotationY` is the common yaw-only shorthand.
   */
  boxBody({ size, position, rotationY = 0, rotation = null, surface = 'hard' }) {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)),
      material: surface === 'soft' ? this.physics.softMaterial : this.physics.hardMaterial,
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: GROUP.DRONE,
    });
    body.position.set(position[0], position[1], position[2]);
    if (rotation) {
      body.quaternion.setFromEuler(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
    } else if (rotationY) {
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotationY);
    }
    this.physics.addBody(body);
    this._bodies.push(body);
    return body;
  }

  /** A static sphere collider — cheapest shape cannon has. Trees, rocks. */
  sphereBody({ radius, position, surface = 'hard' }) {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Sphere(radius),
      material: surface === 'soft' ? this.physics.softMaterial : this.physics.hardMaterial,
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: GROUP.DRONE,
    });
    body.position.set(position[0], position[1], position[2]);
    this.physics.addBody(body);
    this._bodies.push(body);
    return body;
  }

  /**
   * A cylinder with a matching collider.
   *
   * cannon-es' Cylinder is a convex hull and gets expensive with many radial
   * segments, so the collider is built at a coarse 8 segments regardless of
   * the visual mesh's smoothness. At quad scale the difference is unnoticeable.
   */
  cylinder({
    radiusTop, radiusBottom, height, segments = 12,
    position, rotationY = 0, material, collide = true, surface = 'hard',
  }) {
    const key = `cyl:${radiusTop}:${radiusBottom}:${height}:${segments}`;
    const geo = this.geometry(key, () =>
      new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments));

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(position[0], position[1], position[2]);
    if (rotationY) mesh.rotation.y = rotationY;
    this.root.add(mesh);

    if (collide) {
      const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Cylinder(radiusTop, radiusBottom, height, 8),
        material: surface === 'soft' ? this.physics.softMaterial : this.physics.hardMaterial,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: GROUP.DRONE,
      });
      body.position.set(position[0], position[1], position[2]);
      if (rotationY) body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotationY);
      this.physics.addBody(body);
      this._bodies.push(body);
    }
    return mesh;
  }

  /** A visual plane (no collider) — floors get a box body instead. */
  plane({ width, depth, position, material, rotationX = -Math.PI / 2, segments = 1 }) {
    const key = `plane:${width}:${depth}:${segments}`;
    const geo = this.geometry(key, () =>
      new THREE.PlaneGeometry(width, depth, segments, segments));
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = rotationX;
    mesh.position.set(position[0], position[1], position[2]);
    this.root.add(mesh);
    return mesh;
  }

  /**
   * Floor: a thin visual plane plus a thick box collider underneath it.
   *
   * The collider is deliberately deep rather than an infinite cannon Plane so
   * a fast dive cannot tunnel straight through it between substeps.
   */
  floor({ width, depth, y = 0, position = [0, 0, 0], material, surface = 'hard' }) {
    const mesh = this.plane({
      width, depth, material,
      position: [position[0], y, position[2]],
    });
    this.boxBody({
      size: [width, 1.0, depth],
      position: [position[0], y - 0.5, position[2]],
      surface,
    });
    return mesh;
  }

  /* ====================================================================== *
   * Instancing and merging
   * ====================================================================== */

  /**
   * One draw call for many copies of the same geometry.
   *
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {Array<{position:[number,number,number], rotationY?:number, scale?:number|[number,number,number]}>} transforms
   */
  instanced(geometry, material, transforms) {
    const count = transforms.length;
    if (count === 0) return null;

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const t = transforms[i];
      p.set(t.position[0], t.position[1], t.position[2]);
      q.setFromAxisAngle(up, t.rotationY || 0);
      if (Array.isArray(t.scale)) s.set(t.scale[0], t.scale[1], t.scale[2]);
      else s.setScalar(Number.isFinite(t.scale) ? t.scale : 1);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Instanced bounds are not derived automatically; without this the whole
    // batch can be frustum-culled the moment the origin leaves the view.
    mesh.computeBoundingSphere();
    this.root.add(mesh);
    return mesh;
  }

  /**
   * Merge many static geometries into a single mesh — one draw call, no
   * per-object matrix updates. Used for wall runs and truss work where the
   * pieces differ in size (so instancing does not apply).
   *
   * Falls back to adding the parts individually if the merge fails, because a
   * missing wall is a far worse outcome than a few extra draw calls.
   */
  mergeStatic(parts, material, { name = 'merged' } = {}) {
    const geos = [];
    try {
      for (const part of parts) {
        const g = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0), part.rotationY || 0,
        );
        m.compose(
          new THREE.Vector3(part.position[0], part.position[1], part.position[2]),
          q, new THREE.Vector3(1, 1, 1),
        );
        g.applyMatrix4(m);
        geos.push(g);
      }

      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();

      if (!merged) throw new Error('mergeGeometries returned null');

      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      this.root.add(mesh);
      this._looseGeometries.add(merged);
      return mesh;
    } catch (err) {
      console.warn('[MapKit] geometry merge failed; falling back to separate meshes.', err);
      for (const g of geos) { try { g.dispose(); } catch (_e) { /* ignore */ } }
      for (const part of parts) {
        this.box({
          size: part.size, position: part.position,
          rotationY: part.rotationY || 0, material, collide: false,
        });
      }
      return null;
    }
  }

  /** Add colliders for a list of merge parts (merging is visual only). */
  collideParts(parts, surface = 'hard') {
    for (const part of parts) {
      this.boxBody({
        size: part.size, position: part.position,
        rotationY: part.rotationY || 0, surface,
      });
    }
  }

  /* ====================================================================== *
   * Race gates
   * ====================================================================== */

  /**
   * A race gate: a bright torus you fly through, plus the data the Time Trial
   * mode needs to detect a pass.
   *
   * Gates are *not* physics bodies. Colliding with the ring you are trying to
   * fly through would be maddening, and the pass test is a cheap plane
   * crossing done in main.js instead.
   */
  gate({ position, rotationY = 0, radius = 1.35, tube = 0.075, index = 0 }) {
    const geo = this.geometry(`gate:${radius}:${tube}`, () =>
      new THREE.TorusGeometry(radius, tube, 8, 28));

    const matIdle = this.material('gate-idle', () => new THREE.MeshStandardMaterial({
      color: 0x123f2c, emissive: 0x0d3524, emissiveIntensity: 0.6,
      roughness: 0.5, metalness: 0.1,
    }));
    const matActive = this.material('gate-active', () => new THREE.MeshStandardMaterial({
      color: 0x27ff9e, emissive: 0x27ff9e, emissiveIntensity: 1.5,
      roughness: 0.3, metalness: 0.1,
    }));
    const matDone = this.material('gate-done', () => new THREE.MeshStandardMaterial({
      color: 0x2b2f38, emissive: 0x101318, emissiveIntensity: 0.3,
      roughness: 0.8, metalness: 0.1,
    }));

    const mesh = new THREE.Mesh(geo, matIdle);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.y = rotationY;
    this.root.add(mesh);

    // Two uprights so the gate reads as a structure, not a floating ring.
    const postMat = this.standard('gate-post', { color: 0x1d2128, roughness: 0.7 });
    const postH = position[1] - radius;
    if (postH > 0.15) {
      for (const side of [-1, 1]) {
        const off = new THREE.Vector3(side * radius * 0.72, 0, 0)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
        this.box({
          size: [0.06, postH, 0.06],
          position: [position[0] + off.x, postH / 2, position[2] + off.z],
          material: postMat,
          collide: false,
        });
      }
    }

    // Gate normal: the axis you must cross. A torus lies in its local XY
    // plane, so its axis is local +Z rotated by the gate's yaw.
    const normal = new THREE.Vector3(0, 0, 1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY).normalize();

    return {
      index,
      mesh,
      position: new THREE.Vector3(position[0], position[1], position[2]),
      normal,
      radius,
      passed: false,
      setState(state) {
        mesh.material = state === 'active' ? matActive : state === 'done' ? matDone : matIdle;
      },
    };
  }

  /* ====================================================================== *
   * Lighting helpers
   * ====================================================================== */

  addLight(light) {
    this.root.add(light);
    return light;
  }

  /* ====================================================================== *
   * Teardown
   * ====================================================================== */

  /**
   * Release everything. Safe to call twice, and every individual disposal is
   * guarded so one bad resource cannot abort the rest of the teardown.
   */
  dispose(scene, physics) {
    try { scene.remove(this.root); } catch (_e) { /* ignore */ }

    // Detach children so any lingering reference cannot keep the tree alive.
    this.root.traverse((obj) => {
      if (obj.isInstancedMesh) {
        try { obj.dispose(); } catch (_e) { /* ignore */ }
      }
    });
    this.root.clear();

    for (const g of this._geoCache.values()) safeDispose(g);
    for (const g of this._looseGeometries) safeDispose(g);
    for (const m of this._matCache.values()) safeDispose(m);
    for (const t of this._textures) safeDispose(t);

    this._geoCache.clear();
    this._looseGeometries.clear();
    this._matCache.clear();
    this._textures.clear();

    for (const b of this._bodies) physics.removeBody(b);
    this._bodies.length = 0;
  }
}

function safeDispose(resource) {
  try {
    resource?.dispose?.();
  } catch (_e) {
    /* a failed dispose must never abort a map switch */
  }
}

/* ========================================================================== *
 * Small shared math helpers used by the map modules
 * ========================================================================== */

/** Random float in [min, max) from a builder's rng. */
export function rnd(builder, min, max) {
  return min + builder.rng() * (max - min);
}

/** Random integer in [min, max]. */
export function rndInt(builder, min, max) {
  return Math.floor(min + builder.rng() * (max - min + 1));
}

/** Pick one element at random. */
export function rndPick(builder, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(builder.rng() * arr.length))];
}
