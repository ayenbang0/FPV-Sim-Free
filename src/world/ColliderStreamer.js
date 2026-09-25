/**
 * world/ColliderStreamer.js
 * ---------------------------------------------------------------------------
 * Keeps only the static colliders near the drone inside the physics world.
 *
 * A big map has thousands of static bodies: terrain chunks, every tree trunk,
 * every fence post, every shelving upright. cannon's broadphase walks all of
 * them every substep (and so does the swept-collision raycast), and at 240 Hz
 * that walk alone would eat the frame. The drone can only ever touch what is
 * within a few metres of it, so bodies are registered here into a coarse
 * spatial grid instead of the world, and only the cells around the drone are
 * live.
 *
 * Two kinds of entry:
 *
 *   body  — a concrete cannon Body, created up front and kept. Streaming only
 *           adds/removes it from the world.
 *   lazy  — a `build()` callback that makes the bodies on demand, the first
 *           time one of the entry's cells goes live, and drops them when the
 *           last one goes dark. A 3 km valley with 30 000 trees would need
 *           60 000 Body objects resident otherwise — hundreds of megabytes of
 *           Vec3s for colliders the pilot will never get near.
 *
 * Hysteresis: a cell is activated within `radius` cells of the drone and only
 * dropped beyond `radius + 1`, so hovering on a cell boundary does not thrash
 * bodies in and out every frame.
 */

import * as CANNON from 'cannon-es';
import { GROUP } from '../core/PhysicsWorld.js';

export class ColliderStreamer {
  /**
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {{ cellSize?: number, radius?: number }} opts
   */
  constructor(physics, { cellSize = 48, radius = 1 } = {}) {
    this.physics = physics;
    this.cellSize = cellSize;
    this.radius = radius;

    /** key -> Set<entry> */
    this._cells = new Map();
    /** every entry: { body?, build?, bodies?, refs } */
    this._entries = new Set();
    /** body -> entry, for concrete bodies (dedupe + `bodies` getter) */
    this._bodyEntry = new Map();
    this._activeCells = new Set();
    this._lastCx = null;
    this._lastCz = null;
    this.activeCount = 0;
  }

  _key(cx, cz) {
    return `${cx},${cz}`;
  }

  _footprintOf(body) {
    try {
      body.updateAABB();
      return {
        minX: body.aabb.lowerBound.x, maxX: body.aabb.upperBound.x,
        minZ: body.aabb.lowerBound.z, maxZ: body.aabb.upperBound.z,
      };
    } catch (_e) {
      return {
        minX: body.position.x, maxX: body.position.x,
        minZ: body.position.z, maxZ: body.position.z,
      };
    }
  }

  _insert(entry, fp) {
    if (![fp.minX, fp.maxX, fp.minZ, fp.maxZ].every(Number.isFinite)) return false;
    const cs = this.cellSize;
    const cx0 = Math.floor(fp.minX / cs), cx1 = Math.floor(fp.maxX / cs);
    const cz0 = Math.floor(fp.minZ / cs), cz1 = Math.floor(fp.maxZ / cs);
    this._entries.add(entry);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = this._key(cx, cz);
        let set = this._cells.get(k);
        if (!set) { set = new Set(); this._cells.set(k, set); }
        set.add(entry);
        // An entry landing in a cell that is already live must become solid
        // now — update() only walks cells that *change* state.
        if (this._activeCells.has(k)) this._retain(entry);
      }
    }
    return true;
  }

  /**
   * Register a static body. Its XZ footprint is taken from its AABB unless an
   * explicit `{ minX, maxX, minZ, maxZ }` is supplied.
   */
  add(body, footprint = null) {
    if (!body || this._bodyEntry.has(body)) return body;
    const entry = { body, refs: 0 };
    if (this._insert(entry, footprint || this._footprintOf(body))) {
      this._bodyEntry.set(body, entry);
    }
    return body;
  }

  /**
   * Register colliders that are only built while their footprint is live.
   * `build()` returns a Body or an array of Bodies; it may be called many
   * times over a session (each time the area comes back into range).
   */
  addLazy(footprint, build) {
    if (typeof build !== 'function' || !footprint) return;
    this._insert({ build, bodies: null, refs: 0 }, footprint);
  }

  /** Convenience: a static box body registered for streaming. */
  box({ size, position, rotationY = 0, rotation = null, material }) {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)),
      material,
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: GROUP.DRONE,
    });
    body.position.set(position[0], position[1], position[2]);
    if (rotation) body.quaternion.setFromEuler(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
    else if (rotationY) body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotationY);
    return this.add(body);
  }

  /**
   * Re-evaluate which cells are live around `pos`. Cheap when the drone has
   * not changed cell (the common case): one division and a compare.
   */
  update(pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;
    const cs = this.cellSize;
    const cx = Math.floor(pos.x / cs);
    const cz = Math.floor(pos.z / cs);
    if (cx === this._lastCx && cz === this._lastCz) return;
    this._lastCx = cx;
    this._lastCz = cz;

    const want = new Set();
    const r = this.radius;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) want.add(this._key(cx + dx, cz + dz));
    }
    // Keep a one-cell hysteresis ring alive if it already is.
    const keepR = r + 1;
    for (const k of this._activeCells) {
      if (want.has(k)) continue;
      const [kx, kz] = k.split(',').map(Number);
      if (Math.abs(kx - cx) <= keepR && Math.abs(kz - cz) <= keepR) want.add(k);
    }

    // Activate first, then deactivate: an entry spanning an outgoing and an
    // incoming cell then never drops to zero refs and gets rebuilt.
    for (const k of want) {
      if (this._activeCells.has(k)) continue;
      const set = this._cells.get(k);
      if (set) for (const e of set) this._retain(e);
    }
    for (const k of this._activeCells) {
      if (want.has(k)) continue;
      const set = this._cells.get(k);
      if (set) for (const e of set) this._release(e);
    }
    this._activeCells = want;
  }

  _retain(entry) {
    entry.refs++;
    if (entry.refs !== 1) return;
    if (entry.body) {
      this.physics.addBody(entry.body);
      this.activeCount++;
      return;
    }
    let made = null;
    try {
      made = entry.build();
    } catch (err) {
      console.warn('[ColliderStreamer] lazy collider build failed; area left open.', err);
    }
    const list = Array.isArray(made) ? made : made ? [made] : [];
    entry.bodies = list;
    for (const b of list) {
      this.physics.addBody(b);
      this.activeCount++;
    }
  }

  _release(entry) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs !== 0) return;
    if (entry.body) {
      this.physics.removeBody(entry.body);
      this.activeCount--;
      return;
    }
    for (const b of entry.bodies || []) {
      this.physics.removeBody(b);
      this.activeCount--;
    }
    entry.bodies = null;
  }

  /** Put every registered collider in the world — for headless tests. */
  activateAll() {
    for (const k of this._cells.keys()) {
      if (this._activeCells.has(k)) continue;
      this._activeCells.add(k);
      for (const e of this._cells.get(k)) this._retain(e);
    }
    this._lastCx = null;
    this._lastCz = null;
  }

  /** Number of registered entries (concrete bodies + lazy groups). */
  get size() {
    return this._entries.size;
  }

  /** Every concrete registered body, live or not. */
  get bodies() {
    return this._bodyEntry.keys();
  }

  dispose() {
    for (const e of this._entries) {
      const list = e.body ? [e.body] : (e.bodies || []);
      for (const b of list) {
        try { this.physics.removeBody(b); } catch (_e) { /* ignore */ }
      }
      e.bodies = null;
      e.refs = 0;
    }
    this._entries.clear();
    this._bodyEntry.clear();
    this._cells.clear();
    this._activeCells.clear();
    this._lastCx = null;
    this._lastCz = null;
    this.activeCount = 0;
  }
}
