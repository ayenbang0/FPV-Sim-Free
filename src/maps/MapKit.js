/**
 * maps/MapKit.js
 * ---------------------------------------------------------------------------
 * Shared construction kit for every map.
 *
 * All of them need the same handful of operations — "put a box here with a
 * matching collider", "scatter 200 of these with one draw call", "hang a race
 * gate at this pose" — so they live here once instead of once per map.
 *
 * The other job this class does is **resource ownership**. Every geometry,
 * material, texture, light, and physics body a map creates is registered here,
 * which turns teardown from "hope the map remembered everything" into a single
 * `dispose()` that provably releases the lot. That is what makes repeated map
 * switching leak-free.
 *
 * Geometries and materials are memoised by key, so a warehouse with 300 crates
 * holds one BoxGeometry and one material rather than 300 of each.
 *
 * COLLIDER STREAMING
 * ------------------
 * The full-scale maps carry thousands of static colliders. cannon walks its
 * broadphase (and the swept-collision guard walks every body's AABB) on every
 * substep, so at 240 Hz a map that simply dumped them all into the world would
 * spend its whole frame on physics. With `streaming` enabled the builder
 * registers bodies into a ColliderStreamer instead, and only the cells around
 * the drone are ever live — see world/ColliderStreamer.js. Maps opt in; the
 * API is identical either way.
 */

import * as THREE from 'three/webgpu';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP } from '../core/PhysicsWorld.js';
import { makeRng, roughFromNoise, bumpFromNoise, gateStripeTexture, shaftTexture } from '../assets/procedural.js';
import { ColliderStreamer } from '../world/ColliderStreamer.js';

const _UP = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);

/** Gate LED colours by state. */
const GATE_COLORS = {
  idle: 0x2f7dff,
  active: 0x27ff9e,
  done: 0x101318,
};

export class MapBuilder {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {{ seed?: number, name?: string, streaming?: boolean|{cellSize?:number, radius?:number} }} options
   */
  constructor(scene, physics, { seed = 1, name = 'map', streaming = false } = {}) {
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
    /** @type {CANNON.Body[]} bodies added straight to the world */
    this._bodies = [];
    /** Geometries created outside the cache (merged/instanced one-offs). */
    this._looseGeometries = new Set();

    /** Optional collider streamer for large maps. */
    this.streamer = null;
    if (streaming) {
      const opts = typeof streaming === 'object' ? streaming : {};
      this.streamer = new ColliderStreamer(physics, {
        cellSize: opts.cellSize ?? 32,
        radius: opts.radius ?? 1,
      });
    }

    this._beacon = null;
    this._beaconOwner = null;
  }

  /* ====================================================================== *
   * Physics registration
   * ====================================================================== */

  /**
   * Every static body funnels through here, so a map never has to care
   * whether it is streamed. `footprint` is optional ({minX,maxX,minZ,maxZ}).
   */
  addStaticBody(body, footprint = null) {
    if (!body) return body;
    if (this.streamer) {
      this.streamer.add(body, footprint);
    } else {
      this.physics.addBody(body);
      this._bodies.push(body);
    }
    return body;
  }

  /** Keep the colliders around `pos` live. Cheap when the drone has not moved cell. */
  updateColliders(pos) {
    if (this.streamer) this.streamer.update(pos);
  }

  /** Put every streamed body in the world at once — headless tests use this. */
  activateAllColliders() {
    if (this.streamer) this.streamer.activateAll();
  }

  /** Number of static bodies this map owns, streamed or not. */
  get colliderCount() {
    return this._bodies.length + (this.streamer ? this.streamer.size : 0);
  }

  _surface(surface) {
    return surface === 'soft' ? this.physics.softMaterial : this.physics.hardMaterial;
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
  standard(key, { color = 0xffffff, map = null, roughness = 0.85, metalness = 0.0, grain = true, ...rest } = {}) {
    return this.material(key, () => {
      const mat = new THREE.MeshStandardMaterial({
        color, map: map || null, roughness, metalness, ...rest,
      });

      // PBR grain: only worth the extra texture uploads on materials that
      // already carry a procedural colour map — flat-shaded and emissive
      // materials (gate rings, UI accents) stay cheap and untouched. A
      // generation failure falls back to the flat-shaded material.
      if (map && grain) {
        try {
          const seed = hashKey(key);
          const rep = [map.repeat?.x || 1, map.repeat?.y || 1];
          const rough = this.tex(roughFromNoise(seed, rep));
          const bump = this.tex(bumpFromNoise(seed + 1, rep));
          if (rough) mat.roughnessMap = rough;
          if (bump) { mat.bumpMap = bump; mat.bumpScale = 0.02; }
        } catch (_e) {
          /* no PBR grain; the flat-shaded material still looks correct */
        }
      }
      return mat;
    });
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
  boxBody({ size, position, rotationY = 0, rotation = null, quaternion = null, surface = 'hard' }) {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)),
      material: this._surface(surface),
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: GROUP.DRONE,
    });
    body.position.set(position[0], position[1], position[2]);
    if (quaternion) {
      body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    } else if (rotation) {
      body.quaternion.setFromEuler(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
    } else if (rotationY) {
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotationY);
    }
    return this.addStaticBody(body);
  }

  /** A static sphere collider — cheapest shape cannon has. Trees, rocks. */
  sphereBody({ radius, position, surface = 'hard' }) {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Sphere(radius),
      material: this._surface(surface),
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: GROUP.DRONE,
    });
    body.position.set(position[0], position[1], position[2]);
    return this.addStaticBody(body);
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
        material: this._surface(surface),
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: GROUP.DRONE,
      });
      body.position.set(position[0], position[1], position[2]);
      if (rotationY) body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotationY);
      this.addStaticBody(body);
    }
    return mesh;
  }

  /**
   * A square-section member between two points — truss diagonals, fallen
   * beams, pipes, stair stringers, cables. The collider is a box on exactly
   * the same axis, so a diagonal brace stops the quad where it is drawn.
   */
  beam({ from, to, width = 0.2, height = null, material, collide = true, surface = 'hard', roll = 0 }) {
    const a = new THREE.Vector3(from[0], from[1], from[2]);
    const b = new THREE.Vector3(to[0], to[1], to[2]);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (!(len > 1e-4)) return null;
    dir.divideScalar(len);
    const h = height ?? width;
    const q = new THREE.Quaternion().setFromUnitVectors(_X, dir);
    if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(_X, roll));
    const mid = a.add(b).multiplyScalar(0.5);

    const key = `box:${len.toFixed(3)}:${h.toFixed(3)}:${width.toFixed(3)}`;
    const geo = this.geometry(key, () => new THREE.BoxGeometry(len, h, width));
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(mid);
    mesh.quaternion.copy(q);
    this.root.add(mesh);
    if (collide) {
      this.boxBody({ size: [len, h, width], position: [mid.x, mid.y, mid.z], quaternion: q, surface });
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
    // Ground sheets always receive shadows: the one shadow-casting sun per
    // map would otherwise light nothing, and a single receiver flag on a
    // static plane costs nothing at render time.
    mesh.receiveShadow = true;
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
   * @param {Array<{position:[number,number,number], rotationY?:number, rotation?:[number,number,number], scale?:number|[number,number,number]}>} transforms
   */
  instanced(geometry, material, transforms) {
    const count = transforms.length;
    if (count === 0) return null;

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const e = new THREE.Euler();

    for (let i = 0; i < count; i++) {
      const t = transforms[i];
      p.set(t.position[0], t.position[1], t.position[2]);
      if (t.rotation) q.setFromEuler(e.set(t.rotation[0] || 0, t.rotation[1] || 0, t.rotation[2] || 0));
      else q.setFromAxisAngle(_UP, t.rotationY || 0);
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
   * Boxes of many different sizes in one draw call: a unit cube instanced and
   * scaled per part. Optionally gives every part its matching collider.
   * `parts`: [{ size:[w,h,d], position:[x,y,z], rotationY? }]
   */
  boxes(parts, material, { collide = true, surface = 'hard' } = {}) {
    if (!parts.length) return null;
    const unit = this.geometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1));
    const mesh = this.instanced(unit, material, parts.map((p) => ({
      position: p.position, rotationY: p.rotationY || 0, scale: p.size,
    })));
    if (collide) {
      for (const p of parts) {
        this.boxBody({ size: p.size, position: p.position, rotationY: p.rotationY || 0, surface });
      }
    }
    return mesh;
  }

  /**
   * Merge many static geometries into a single mesh — one draw call, no
   * per-object matrix updates. Used for wall runs and truss work where the
   * pieces differ in size (so instancing does not apply).
   *
   * Parts may carry `rotationY`, a full `rotation` euler, or a `quaternion`.
   *
   * Falls back to adding the parts individually if the merge fails, because a
   * missing wall is a far worse outcome than a few extra draw calls.
   */
  mergeStatic(parts, material, { name = 'merged' } = {}) {
    const geos = [];
    try {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const one = new THREE.Vector3(1, 1, 1);
      const pos = new THREE.Vector3();
      for (const part of parts) {
        const g = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
        if (part.quaternion) q.copy(part.quaternion);
        else if (part.rotation) q.setFromEuler(e.set(part.rotation[0] || 0, part.rotation[1] || 0, part.rotation[2] || 0));
        else q.setFromAxisAngle(_UP, part.rotationY || 0);
        m.compose(pos.set(part.position[0], part.position[1], part.position[2]), q, one);
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
          rotationY: part.rotationY || 0, rotation: part.rotation || null, material, collide: false,
        });
      }
      return null;
    }
  }

  /**
   * A beam expressed as a merge part (for `mergeStatic`), so long runs of
   * diagonal truss members cost one draw call.
   */
  static beamPart(from, to, width = 0.15, height = null) {
    const a = new THREE.Vector3(from[0], from[1], from[2]);
    const b = new THREE.Vector3(to[0], to[1], to[2]);
    const dir = b.clone().sub(a);
    const len = dir.length() || 1e-3;
    dir.divideScalar(len);
    const q = new THREE.Quaternion().setFromUnitVectors(_X, dir);
    const mid = a.add(b).multiplyScalar(0.5);
    return { size: [len, height ?? width, width], position: [mid.x, mid.y, mid.z], quaternion: q };
  }

  /** Add colliders for a list of merge parts (merging is visual only). */
  collideParts(parts, surface = 'hard') {
    for (const part of parts) {
      this.boxBody({
        size: part.size, position: part.position,
        rotationY: part.rotationY || 0, rotation: part.rotation || null,
        quaternion: part.quaternion || null, surface,
      });
    }
  }

  /* ====================================================================== *
   * Race gates
   * ====================================================================== */

  /**
   * A race gate plus the data the Time Trial needs to detect a pass.
   *
   * Styles:
   *   ring    — the original torus. Not solid: a thin ring you are trying to
   *             fly through is maddening to clip on tight indoor lines.
   *   square  — a full-size padded race gate (the MultiGP/league shape): four
   *             foam bars with an LED strip on the inside edge, stood on legs.
   *             The frame IS solid (soft surface), exactly like the real thing.
   *   dive    — a square gate laid flat, flown through from above.
   *
   * @param {object} o
   * @param {[number,number,number]} o.position  centre of the opening
   * @param {number} [o.rotationY]   yaw; the pass normal is local +Z yawed
   * @param {number} [o.width]       square/dive inner opening, metres
   * @param {number} [o.height]      square inner opening height
   * @param {number} [o.groundY]     floor height under the gate (for legs)
   */
  gate({
    position, rotationY = 0, radius = 1.35, tube = 0.075, index = 0,
    style = 'ring', width = null, height = null, groundY = 0, legs = true,
    padColors = null, beaconHeight = 0,
  }) {
    const group = new THREE.Group();
    group.name = `gate-${index}`;
    this.root.add(group);

    const ledMats = this._gateLedMaterials();
    let setMeshes = [];
    let shape = 'ring';
    let halfW = radius;
    let halfH = radius;
    let normal;
    let right;
    let up;
    let topOffset;

    if (style === 'square' || style === 'dive') {
      shape = 'square';
      const dive = style === 'dive';
      const w = width ?? radius * 2;
      const h = dive ? w : (height ?? w);
      halfW = w / 2;
      halfH = h / 2;
      const t = Math.max(0.1, Math.min(0.28, w * 0.075));   // bar thickness
      const d = t * 1.3;                                      // bar depth

      const frame = new THREE.Object3D();
      frame.position.set(position[0], position[1], position[2]);
      frame.rotation.set(dive ? -Math.PI / 2 : 0, rotationY, 0, 'YXZ');
      frame.updateMatrixWorld(true);

      const bars = [
        { size: [w + 2 * t, t, d], pos: [0, h / 2 + t / 2, 0] },
        { size: [w + 2 * t, t, d], pos: [0, -h / 2 - t / 2, 0] },
        { size: [t, h, d], pos: [-(w / 2 + t / 2), 0, 0] },
        { size: [t, h, d], pos: [w / 2 + t / 2, 0, 0] },
      ];
      const strips = [
        { size: [w, 0.035, d * 0.7], pos: [0, h / 2 - 0.0175, 0] },
        { size: [w, 0.035, d * 0.7], pos: [0, -h / 2 + 0.0175, 0] },
        { size: [0.035, h, d * 0.7], pos: [-w / 2 + 0.0175, 0, 0] },
        { size: [0.035, h, d * 0.7], pos: [w / 2 - 0.0175, 0, 0] },
      ];

      const colors = padColors || ['#f25c05', '#16181c'];
      const padMat = this.material(`gate-pad:${colors[0]}:${colors[1]}`, () => {
        const tex = this.tex(gateStripeTexture(7700 + index % 3, [4, 1], colors[0], colors[1]));
        return new THREE.MeshStandardMaterial({
          color: tex ? 0xffffff : 0xd8581c, map: tex, roughness: 0.78, metalness: 0.02,
        });
      });

      const frameParts = bars.map((bar) => ({ size: bar.size, position: bar.pos }));
      const frameMesh = this.mergeStatic(frameParts, padMat, { name: `gate-frame-${index}` });
      const stripParts = strips.map((s) => ({ size: s.size, position: s.pos }));
      const stripMesh = this.mergeStatic(stripParts, ledMats.idle, { name: `gate-led-${index}` });
      for (const mesh of [frameMesh, stripMesh]) {
        if (!mesh) continue;
        this.root.remove(mesh);
        mesh.position.copy(frame.position);
        mesh.quaternion.copy(frame.quaternion);
        mesh.castShadow = true;
        group.add(mesh);
      }
      if (stripMesh) setMeshes = [stripMesh];

      // Solid frame: one soft collider per bar, posed exactly like the mesh.
      const wp = new THREE.Vector3();
      for (const bar of bars) {
        wp.set(bar.pos[0], bar.pos[1], bar.pos[2]).applyMatrix4(frame.matrixWorld);
        this.boxBody({ size: bar.size, position: [wp.x, wp.y, wp.z], quaternion: frame.quaternion, surface: 'soft' });
      }

      normal = new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quaternion).normalize();
      right = new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion).normalize();
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(frame.quaternion).normalize();

      // Legs down to the floor.
      const legMat = this.standard('gate-leg', { color: 0x2a2d33, roughness: 0.6, metalness: 0.5 });
      if (legs) {
        const corners = dive
          ? [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => new THREE.Vector3(
            sx * (w / 2 + t / 2), sz * (h / 2 + t / 2), 0).applyMatrix4(frame.matrixWorld))
          : [-1, 1].map((sx) => new THREE.Vector3(sx * (w / 2 + t / 2), -h / 2 - t, 0)
            .applyMatrix4(frame.matrixWorld));
        for (const c of corners) {
          const top = dive ? c.y - t / 2 : c.y;
          const legH = top - groundY;
          if (legH < 0.12) continue;
          const leg = this.box({
            size: [0.07, legH, 0.07], position: [c.x, groundY + legH / 2, c.z],
            material: legMat, collide: true,
          });
          this.root.remove(leg);
          group.add(leg);
          const foot = this.box({
            size: [0.6, 0.05, 0.6], position: [c.x, groundY + 0.025, c.z],
            rotationY, material: legMat, collide: false,
          });
          this.root.remove(foot);
          group.add(foot);
        }
      }
      topOffset = dive ? new THREE.Vector3(0, 0.3, 0) : up.clone().multiplyScalar(h / 2 + t);
    } else {
      const geo = this.geometry(`gate:${radius}:${tube}`, () =>
        new THREE.TorusGeometry(radius, tube, 10, 36));
      const mesh = new THREE.Mesh(geo, ledMats.idle);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.rotation.y = rotationY;
      mesh.castShadow = true;
      group.add(mesh);
      setMeshes = [mesh];

      // Two uprights so the gate reads as a structure, not a floating ring.
      const postMat = this.standard('gate-post', { color: 0x1d2128, roughness: 0.7 });
      const postH = position[1] - radius - groundY;
      if (postH > 0.15 && legs) {
        for (const side of [-1, 1]) {
          const off = new THREE.Vector3(side * radius * 0.72, 0, 0)
            .applyAxisAngle(_UP, rotationY);
          const post = this.box({
            size: [0.06, postH, 0.06],
            position: [position[0] + off.x, groundY + postH / 2, position[2] + off.z],
            material: postMat,
            collide: false,
          });
          this.root.remove(post);
          group.add(post);
        }
      }
      // Gate normal: the axis you must cross. A torus lies in its local XY
      // plane, so its axis is local +Z rotated by the gate's yaw.
      normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(_UP, rotationY).normalize();
      right = new THREE.Vector3(1, 0, 0).applyAxisAngle(_UP, rotationY).normalize();
      up = _UP.clone();
      topOffset = new THREE.Vector3(0, radius + tube, 0);
    }

    const center = new THREE.Vector3(position[0], position[1], position[2]);
    const builder = this;
    const beaconAt = center.clone().add(topOffset);
    const gateObj = {
      index,
      mesh: setMeshes[0] || null,
      group,
      shape,
      position: center,
      normal,
      right,
      up,
      radius: Math.max(halfW, halfH),
      halfW,
      halfH,
      passed: false,
      /** Is `offset` (crossing point minus centre, on the gate plane) inside? */
      contains(offset) {
        if (shape === 'ring') {
          const axial = offset.dot(normal);
          return offset.lengthSq() - axial * axial <= halfW * halfW;
        }
        return Math.abs(offset.dot(right)) <= halfW && Math.abs(offset.dot(up)) <= halfH;
      },
      setState(state) {
        const mat = state === 'active' ? ledMats.active : state === 'done' ? ledMats.done : ledMats.idle;
        for (const m of setMeshes) m.material = mat;
        if (beaconHeight > 0) {
          if (state === 'active') builder._showBeacon(gateObj, beaconAt, beaconHeight);
          else if (builder._beaconOwner === gateObj) builder._hideBeacon();
        }
      },
    };
    return gateObj;
  }

  _gateLedMaterials() {
    return {
      idle: this.material('gate-led-idle', () => new THREE.MeshStandardMaterial({
        // 2.4 clears the post pipeline's 0.9 bloom threshold, so idle gate
        // LEDs glow like the real strips do on camera.
        color: 0x16305c, emissive: GATE_COLORS.idle, emissiveIntensity: 2.4,
        roughness: 0.5, metalness: 0.1,
      })),
      active: this.material('gate-led-active', () => new THREE.MeshStandardMaterial({
        color: 0x27ff9e, emissive: GATE_COLORS.active, emissiveIntensity: 2.2,
        roughness: 0.3, metalness: 0.1,
      })),
      done: this.material('gate-led-done', () => new THREE.MeshStandardMaterial({
        color: 0x2b2f38, emissive: GATE_COLORS.done, emissiveIntensity: 0.3,
        roughness: 0.8, metalness: 0.1,
      })),
    };
  }

  /**
   * The next-gate beacon: a soft vertical column of light over the active
   * gate. On a kilometre-scale course the next gate can be 300 m away behind a
   * hill; the beacon is what lets the pilot pick the line without a minimap.
   */
  _showBeacon(owner, at, height) {
    if (!this._beacon) {
      const geo = new THREE.CylinderGeometry(0.45, 0.45, 1, 14, 1, true);
      geo.translate(0, 0.5, 0);
      this._looseGeometries.add(geo);
      const mat = this.material('gate-beacon', () => new THREE.MeshBasicMaterial({
        color: GATE_COLORS.active, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }));
      this._beacon = new THREE.Mesh(geo, mat);
      this._beacon.name = 'gate-beacon';
      this._beacon.frustumCulled = false;
      this.root.add(this._beacon);
    }
    this._beacon.position.copy(at);
    this._beacon.scale.set(1, height, 1);
    this._beacon.visible = true;
    this._beaconOwner = owner;
  }

  _hideBeacon() {
    if (this._beacon) this._beacon.visible = false;
    this._beaconOwner = null;
  }

  /**
   * Build a whole course from an ordered list of gate positions, deriving each
   * gate's heading from the racing line rather than hand-picking angles.
   *
   * Hand-authored headings are extremely easy to get wrong: a gate rotated even
   * 60 degrees off the line of travel is one the pilot flies *alongside* rather
   * than through, and because the pass test is a plane crossing, such a gate can
   * be almost impossible to trigger. Orienting each ring to bisect its incoming
   * and outgoing legs makes every gate face the pilot by construction.
   *
   * Point fields: x, y, z, and optionally r (ring radius), w / h (square
   * opening), style ('ring' | 'square' | 'dive'), yaw (explicit override),
   * ground (floor height under the gate).
   *
   * @param {Array<object>} points ordered gates
   * @param {object} opts
   */
  course(points, {
    spawn = null, radius = 1.4, tube = 0.09, style = 'ring', width = null, height = null,
    groundAt = null, beaconHeight = 0, padColors = null,
  } = {}) {
    const n = points.length;
    if (n === 0) return [];

    return points.map((pt, i) => {
      const prev = i > 0 ? points[i - 1] : (spawn ? { x: spawn.x, z: spawn.z } : pt);
      const next = i < n - 1 ? points[i + 1] : null;

      // Incoming leg, and the outgoing leg where one exists.
      let dx = pt.x - prev.x;
      let dz = pt.z - prev.z;
      const inLen = Math.hypot(dx, dz) || 1;
      dx /= inLen; dz /= inLen;

      if (next) {
        let ox = next.x - pt.x;
        let oz = next.z - pt.z;
        const outLen = Math.hypot(ox, oz) || 1;
        ox /= outLen; oz /= outLen;

        // Weighted bisector, biased toward the leg the pilot arrives on. An
        // even 50/50 bisect turns a 90-degree corner gate 45 degrees away from
        // the approach, which is nearly edge-on and very hard to read at speed;
        // 65/35 keeps it under 30 degrees while still leading into the exit.
        dx = dx * 0.65 + ox * 0.35;
        dz = dz * 0.65 + oz * 0.35;
        const bl = Math.hypot(dx, dz);
        if (bl > 1e-4) { dx /= bl; dz /= bl; }
      }

      // atan2(x, z) is the yaw that carries local +Z onto (dx, dz), and the
      // gate's pass axis is its local +Z — so this points it down the line.
      const rotationY = Number.isFinite(pt.yaw) ? pt.yaw : Math.atan2(dx, dz);
      const ground = Number.isFinite(pt.ground) ? pt.ground
        : (typeof groundAt === 'function' ? groundAt(pt.x, pt.z) : 0);

      return this.gate({
        position: [pt.x, pt.y, pt.z],
        rotationY,
        radius: pt.r ?? radius,
        tube,
        index: i,
        style: pt.style ?? style,
        width: pt.w ?? width,
        height: pt.h ?? height,
        groundY: ground,
        legs: pt.legs ?? true,
        beaconHeight,
        padColors: pt.colors ?? padColors,
      });
    });
  }

  /**
   * A racing feather flag: a curved banner on a pole. Visual marker for
   * turn-around points; the pole is solid, the fabric is not.
   */
  flag({ position, color = '#ff3d3d', height = 3.2, groundY = 0, rotationY = 0 }) {
    const poleMat = this.standard('flag-pole', { color: 0x9aa0a8, roughness: 0.4, metalness: 0.8 });
    const clothMat = this.material(`flag-cloth:${color}`, () => new THREE.MeshStandardMaterial({
      color: new THREE.Color(color), roughness: 0.85, side: THREE.DoubleSide,
      emissive: new THREE.Color(color), emissiveIntensity: 0.18,
    }));
    const x = position[0];
    const z = position[2];
    this.cylinder({
      radiusTop: 0.025, radiusBottom: 0.035, height, segments: 6,
      position: [x, groundY + height / 2, z], material: poleMat,
    });
    const geo = this.geometry(`flag-cloth:${height}`, () => {
      const w = 0.62;
      const h = height * 0.78;
      const g = new THREE.PlaneGeometry(w, h, 4, 8);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = (p.getX(i) + w / 2) / w;          // 0 at the pole
        const v = (p.getY(i) + h / 2) / h;          // 0 at the bottom
        // Feather shape: taper the free edge toward the bottom, curl slightly.
        p.setX(i, u * w * (0.35 + 0.65 * Math.sin(v * Math.PI * 0.55 + 0.25)));
        p.setZ(i, Math.sin(u * Math.PI) * 0.07);
      }
      g.computeVertexNormals();
      return g;
    });
    const cloth = new THREE.Mesh(geo, clothMat);
    cloth.position.set(x, groundY + height - height * 0.39 - 0.05, z);
    cloth.rotation.y = rotationY;
    cloth.castShadow = true;
    this.root.add(cloth);
    this.box({
      size: [0.5, 0.06, 0.5], position: [x, groundY + 0.03, z],
      material: poleMat, collide: false,
    });
    return cloth;
  }

  /* ====================================================================== *
   * Atmosphere: light shafts, dust, decals, external textures
   * ---------------------------------------------------------------------- *
   * Real volumetrics and screen-space GI are out of the question on the
   * performance-first budget (integrated GPUs must hold 60 fps while physics
   * stays at >=120 Hz). These helpers fake the same reads for almost nothing:
   * additive crossed quads for shafts, one Points cloud for dust, thin planes
   * for grime/graffiti decals.
   * ====================================================================== */

  /**
   * Fake volumetric shaft: two crossed additive quads slanting from a skylight
   * or broken roof section down to the floor. Reads as a volume from almost
   * any angle at the cost of 2 transparent quads.
   */
  lightShaft({
    position, width = 5, height = 12, color = 0xbcd4e8, opacity = 0.05,
    tilt = [0.16, 0, 0.14],
  }) {
    const key = `shaftmat:${color}:${opacity}`;
    const mat = this.material(key, () => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }));
    const geo = this.geometry(`shaftquad:${width}:${height}`, () =>
      new THREE.PlaneGeometry(width, height));
    const group = new THREE.Group();
    for (let k = 0; k < 2; k++) {
      const q = new THREE.Mesh(geo, mat);
      q.position.set(position[0], position[1], position[2]);
      q.rotation.set(tilt[0], (tilt[1] || 0) + (k === 0 ? 0 : Math.PI / 2), tilt[2] || 0);
      group.add(q);
    }
    this.root.add(group);
    return group;
  }

  /**
   * A sunbeam through a skylight or roof hole: two crossed additive cards laid
   * along the actual sun direction, textured to fade at the edges and toward
   * the floor. `top` is where the light enters; `dir` is the direction the
   * light travels (i.e. -sunDirection).
   */
  sunShaft({ top, dir, length = 20, width = 3, opacity = 0.35, color = 0xfff0d6 }) {
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    if (!(d.lengthSq() > 0)) return null;
    const mat = this.material(`sunshaft:${color}:${opacity}`, () => {
      const tex = this.tex(shaftTexture(86));
      return new THREE.MeshBasicMaterial({
        color, map: tex, transparent: true, opacity: tex ? opacity : opacity * 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
    });
    const geo = this.geometry(`sunshaft:${width}:${length}`, () => new THREE.PlaneGeometry(width, length));
    const mid = new THREE.Vector3(top[0], top[1], top[2]).addScaledVector(d, length / 2);
    // Plane local +Y (the texture's top) points back toward the source.
    const q = new THREE.Quaternion().setFromUnitVectors(_UP, d.clone().negate());
    const group = new THREE.Group();
    for (let k = 0; k < 2; k++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(mid);
      mesh.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(_UP, k * Math.PI / 2));
      mesh.renderOrder = 3;
      group.add(mesh);
    }
    this.root.add(group);
    return group;
  }

  /**
   * Drifting dust-mote cloud: one additive Points draw for the whole volume.
   * Returns a handle with `update(dt, elapsed)` (ambient drift) and
   * `kick(position, radius, strength)` (propwash push).
   */
  dustCloud({
    count = 320, area = [40, 10, 60], center = [0, 5, 0],
    color = 0xcfd8e2, size = 0.055, opacity = 0.55, seed = 7,
  } = {}) {
    const rng = makeRng(seed);
    const positions = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = center[0] + (rng() - 0.5) * area[0];
      positions[i * 3 + 1] = Math.max(0.2, center[1] + (rng() - 0.5) * area[1]);
      positions[i * 3 + 2] = center[2] + (rng() - 0.5) * area[2];
      vel[i * 3] = (rng() - 0.5) * 0.06;
      vel[i * 3 + 1] = (rng() - 0.5) * 0.03;
      vel[i * 3 + 2] = (rng() - 0.5) * 0.06;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._looseGeometries.add(geo);

    const mat = this.material(`dust:${color}:${size}`, () => new THREE.PointsMaterial({
      color, size, transparent: true, opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true,
    }));
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.root.add(points);

    const bounds = {
      x0: center[0] - area[0] / 2, x1: center[0] + area[0] / 2,
      y0: Math.max(0.15, center[1] - area[1] / 2),
      y1: center[1] + area[1] / 2,
      z0: center[2] - area[2] / 2, z1: center[2] + area[2] / 2,
    };
    let phase = rng() * 100;
    return {
      points,
      update(dt) {
        const step = Math.min(Math.max(dt, 0), 0.1);
        phase += step;
        const pos = geo.attributes.position;
        const arr = pos.array;
        for (let i = 0; i < count; i++) {
          const j = i * 3;
          arr[j] += (vel[j] + Math.sin(phase * 0.4 + i) * 0.02) * step * 8;
          arr[j + 1] += vel[j + 1] * step * 8;
          arr[j + 2] += (vel[j + 2] + Math.cos(phase * 0.33 + i * 1.7) * 0.02) * step * 8;
          // Soft-wrap inside the volume instead of dying at the edge.
          if (arr[j] < bounds.x0) arr[j] = bounds.x1;
          else if (arr[j] > bounds.x1) arr[j] = bounds.x0;
          if (arr[j + 2] < bounds.z0) arr[j + 2] = bounds.z1;
          else if (arr[j + 2] > bounds.z1) arr[j + 2] = bounds.z0;
          if (arr[j + 1] < bounds.y0) arr[j + 1] = bounds.y0;
          else if (arr[j + 1] > bounds.y1) arr[j + 1] = bounds.y1;
          if (!Number.isFinite(arr[j] + arr[j + 1] + arr[j + 2])) {
            arr[j] = center[0]; arr[j + 1] = center[1]; arr[j + 2] = center[2];
          }
        }
        pos.needsUpdate = true;
      },
      /** Propwash kick: shove motes away from a point (called per-frame). */
      kick(px, py, pz, radius = 2, strength = 1) {
        const pos = geo.attributes.position;
        const arr = pos.array;
        const r2 = radius * radius;
        for (let i = 0; i < count; i++) {
          const j = i * 3;
          const dx = arr[j] - px, dy = arr[j + 1] - py, dz = arr[j + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2 && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = ((1 - d / radius) * 2.2 * strength) / Math.max(d, 0.3);
            arr[j] += dx * push * 0.08;
            arr[j + 1] += (dy * push * 0.08 + 0.02 * strength);
            arr[j + 2] += dz * push * 0.08;
          }
        }
        pos.needsUpdate = true;
      },
    };
  }

  /**
   * Thin decal plane (grime streak, oil stain, graffiti tag) laid just off a
   * surface to avoid z-fighting. `texture` may be null → falls back to a
   * translucent dark grime tint, never a throw.
   */
  decal({
    size = [3, 2], position, rotationY = 0, tiltX = 0,
    texture = null, color = 0x14161a, opacity = 0.55,
  }) {
    const key = `decal:${color}:${opacity}:${texture ? texture.uuid || texture.id || 'tex' : 'flat'}`;
    const mat = this.material(key, () => new THREE.MeshBasicMaterial({
      color, map: texture || null, transparent: true, opacity,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    }));
    const geo = this.geometry(`decalquad:${size[0]}:${size[1]}`, () =>
      new THREE.PlaneGeometry(size[0], size[1]));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.set(tiltX, rotationY, 0, 'YXZ');
    mesh.renderOrder = 2;
    this.root.add(mesh);
    return mesh;
  }

  /**
   * Upgrade a material's map to a CC0/external texture when it loads.
   *
   * The material keeps its procedural map until (and unless) the download
   * succeeds — a 404, offline browser, or CORS refusal leaves the procedural
   * look in place instead of a blank texture.
   */
  ccTexture(url, material, repeat = null) {
    if (!url || !material) return;
    // Headless/test environments have no Image/document — stay procedural.
    if (typeof document === 'undefined' || typeof Image === 'undefined') return;
    try {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      loader.load(
        url,
        (tex) => {
          try {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            if (Array.isArray(repeat)) tex.repeat.set(repeat[0], repeat[1]);
            this._textures.add(tex);
            material.map = tex;
            material.needsUpdate = true;
          } catch (_e) { /* keep the procedural map */ }
        },
        undefined,
        () => { /* error: keep the procedural look */ },
      );
    } catch (_e) {
      /* loader construction failed — procedural look stands */
    }
  }

  /* ====================================================================== *
   * Lighting helpers
   * ====================================================================== */

  addLight(light) {
    this.root.add(light);
    return light;
  }

  /**
   * Shadow flags for the whole map in one pass, once it is built.
   *
   * Every lit opaque surface receives; anything with a bounding radius above
   * `castMinRadius` casts. Small clutter is left out of the caster set — it
   * adds shadow-pass draw calls for contact shadows nobody can see at speed.
   * Transparent, additive and unlit materials never take part.
   */
  finalizeShadows({ castMinRadius = 0.35, receive = true } = {}) {
    this.root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh)) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!mat || mat.transparent || mat.isMeshBasicMaterial || mat.isPointsMaterial) return;
      if (receive) o.receiveShadow = true;
      if (o.userData.noCastShadow) return;
      // Flat sheets (floors, decals, screens) never cast: a floor plane in the
      // caster set shadows *itself* and blacks out the whole level.
      const gt = o.geometry?.type;
      if (gt === 'PlaneGeometry' || gt === 'CircleGeometry' || gt === 'RingGeometry') return;
      try {
        const g = o.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        let r = g.boundingSphere ? g.boundingSphere.radius : 0;
        if (o.isInstancedMesh) {
          // Instanced batches cast when their *pieces* are sizeable.
          r = g.boundingSphere ? g.boundingSphere.radius : 0;
          const e = new THREE.Vector3();
          const tmp = new THREE.Matrix4();
          o.getMatrixAt(0, tmp);
          e.setFromMatrixScale(tmp);
          r *= Math.max(e.x, e.y, e.z);
        } else {
          r *= Math.max(o.scale.x, o.scale.y, o.scale.z);
        }
        if (r >= castMinRadius) o.castShadow = true;
      } catch (_e) { /* leave the flag as is */ }
    });
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
    if (this.streamer) {
      try { this.streamer.dispose(); } catch (_e) { /* ignore */ }
    }
    this._beacon = null;
    this._beaconOwner = null;
  }
}

/** Deterministic small-int seed from a material cache key, for PBR grain. */
function hashKey(str) {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) || 1;
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
