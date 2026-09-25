/**
 * core/PhysicsWorld.js
 * ---------------------------------------------------------------------------
 * Owns the cannon-es world: gravity, solver configuration, contact materials,
 * collision groups, and — most importantly — the per-step **safety net**.
 *
 * Rigid-body solvers are numerically fragile. A deep interpenetration, a huge
 * impulse, or a single division by a near-zero mass can put an Infinity into a
 * body's velocity, and from there NaN spreads through position, quaternion, and
 * finally the render matrix, at which point Three.js silently stops drawing the
 * object and the app looks "crashed" even though nothing threw.
 *
 * So this module treats invalid state as an expected condition rather than an
 * exceptional one. After every step we sanitise the drone body: any non-finite
 * component is replaced from the last known-good snapshot, velocities are
 * clamped to physically sane ceilings, and the quaternion is re-normalised
 * unconditionally (cheap, and it stops slow drift from accumulating).
 *
 * Section 4 of the spec asks for these ceilings *inside* the physics step, not
 * just at the input layer — that is why `step()` does the clamping rather than
 * DroneController.
 */

import * as CANNON from 'cannon-es';

/* --------------------------------------------------------------------------
 * Collision groups. Bit flags: a body collides with another only when each
 * side's mask includes the other's group.
 * -------------------------------------------------------------------------- */
export const GROUP = {
  WORLD: 1,   // static level geometry — walls, floors, props
  DRONE: 2,   // the player's quad
  PROP: 4,    // dynamic-ish scenery (currently all static, reserved)
};

/** Hard ceilings applied every substep. Generous enough never to be felt in
 *  normal flight, tight enough to stop a solver blow-up from launching the
 *  drone to the far side of the float range. */
export const LIMITS = {
  MAX_LINEAR_VELOCITY: 90,     // m/s  — well past any achievable dive speed
  MAX_ANGULAR_VELOCITY: 60,    // rad/s — ~3400 deg/s, far above the 600 deg/s rates
  MAX_POSITION_DELTA: 6,       // m per substep; at 1/120s that is 720 m/s
  MAX_ABS_POSITION: 4000,      // m from origin before we force a respawn
};

export class PhysicsWorld {
  constructor(options = {}) {
    this.fixedTimeStep = options.fixedTimeStep ?? 1 / 120;

    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.81, 0),
    });

    // The drone is the only thing that moves. A general broadphase (naive or
    // sweep-and-prune) spends its time pairing static bodies with each other
    // only to reject them; with thousands of rack uprights lined up along one
    // axis, SAP degrades to ~30 ms a substep. Testing each dynamic body
    // against everything is O(n) and costs microseconds.
    // Static colliders are kept *out of* world.bodies entirely, in a spatial
    // hash: cannon walks world.bodies several times per substep (solver
    // reset, integration, force clearing, sleep ticks), so a 3 000-collider
    // map would otherwise cost milliseconds per substep for bodies that
    // never move. The broadphase hands the drone its neighbours from the hash.
    this.staticIndex = new StaticIndex(8);
    this.world.broadphase = new DynamicBroadphase(this.staticIndex);
    this.world.broadphase.world = this.world;
    // cannon's dense collision matrix is n(n+1)/2 entries, cleared every
    // substep — 2 M writes at 2 000 bodies. Contacts only ever involve the
    // drone, so a sparse set of the live pairs does the same job.
    this.world.collisionMatrix = new SparseCollisionMatrix();
    this.world.collisionMatrixPrevious = new SparseCollisionMatrix();
    this.world.allowSleep = true;

    // Solver: more iterations = less interpenetration jitter when the quad is
    // resting on or grinding along geometry. 10 is a good stability/cost point.
    this.world.solver.iterations = 10;
    this.world.solver.tolerance = 0.001;

    this._buildMaterials();

    /** Bodies added through this class, so a map switch can guarantee a clean
     *  teardown even if a map module forgets to remove one of its own. */
    this.trackedBodies = new Set();

    /** Last known-good transform for each body we are protecting. */
    this._safeState = new WeakMap();

    /* Continuous-collision scratch. Allocated once — the sweep runs on every
     * substep of every protected body. */
    this._rayFrom = new CANNON.Vec3();
    this._rayTo = new CANNON.Vec3();
    this._rayResult = new CANNON.RaycastResult();
  }

  /* ---------------------------------------------------------------------- *
   * Materials
   * ---------------------------------------------------------------------- */

  _buildMaterials() {
    // Three surface classes is enough fidelity here: the frame, hard level
    // geometry, and soft furnishings that should absorb rather than bounce.
    this.droneMaterial = new CANNON.Material('drone');
    this.hardMaterial = new CANNON.Material('hard');
    this.softMaterial = new CANNON.Material('soft');

    // Quad against concrete/steel: low friction (props and arms skate along
    // walls rather than catching), modest restitution so grazes deflect.
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.droneMaterial, this.hardMaterial,
      { friction: 0.14, restitution: 0.22 },
    ));

    // Quad against a couch or bed: grabs and deadens.
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.droneMaterial, this.softMaterial,
      { friction: 0.55, restitution: 0.05 },
    ));

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.hardMaterial, this.hardMaterial,
      { friction: 0.4, restitution: 0.1 },
    ));

    this.world.defaultContactMaterial.friction = 0.3;
    this.world.defaultContactMaterial.restitution = 0.12;
  }

  /* ---------------------------------------------------------------------- *
   * Body lifecycle
   * ---------------------------------------------------------------------- */

  /** Add a body and remember it so `clearTrackedBodies()` can guarantee removal. */
  addBody(body) {
    if (!body) return null;
    try {
      if (body.type === CANNON.Body.STATIC) {
        this.staticIndex.add(body);
      } else {
        this.world.addBody(body);
      }
      this.trackedBodies.add(body);
    } catch (err) {
      console.warn('[PhysicsWorld] addBody failed', err);
    }
    return body;
  }

  /** Remove a single body. Safe to call with a body that was never added. */
  removeBody(body) {
    if (!body) return;
    try {
      if (this.staticIndex.has(body)) this.staticIndex.remove(body);
      else this.world.removeBody(body);
    } catch (_e) {
      /* already gone — not an error worth surfacing */
    }
    this.trackedBodies.delete(body);
  }

  /**
   * Remove every tracked body except the ones passed in `keep`.
   * Used on map switch: the drone survives, the level does not.
   */
  clearTrackedBodies(keep = []) {
    const keepSet = new Set(keep);
    for (const body of Array.from(this.trackedBodies)) {
      if (keepSet.has(body)) continue;
      this.removeBody(body);
    }
    // Contacts referencing removed bodies would otherwise linger for a step.
    try {
      this.world.contacts.length = 0;
    } catch (_e) { /* ignore */ }
  }

  /**
   * Register a body for NaN/limit protection and record its current transform
   * as the initial "known good" state.
   */
  protect(body) {
    if (!body) return;
    this._safeState.set(body, {
      position: body.position.clone(),
      quaternion: body.quaternion.clone(),
    });

    // Smallest half-extent of the body, used as the swept-collision threshold
    // and as the stand-off distance when we stop it at a surface.
    let radius = 0.05;
    try {
      const shape = body.shapes?.[0];
      if (shape?.halfExtents) {
        radius = Math.min(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
      } else if (Number.isFinite(shape?.radius)) {
        radius = shape.radius;
      }
    } catch (_e) { /* fall back to the default */ }
    body._ccdRadius = Math.max(0.005, radius);
  }

  /**
   * Swept-collision guard (a cheap continuous-collision pass).
   *
   * Discrete collision detection compares *positions*, so a body that travels
   * further in one substep than the thickness of what it hits can end up on the
   * far side without a contact ever being generated. At 1/120 s a 23 g whoop
   * moving 12 m/s covers 0.10 m per step against 0.14 m interior walls — right
   * on the edge — and it does in fact pass straight through them.
   *
   * The generic clamps cannot catch this: MAX_POSITION_DELTA is metres, and any
   * value tight enough to notice a 37 mm body would fire constantly in normal
   * flight. So instead we cast a ray along the path the body actually took and,
   * if it crossed something solid, put it back at the surface.
   *
   * Only runs when the step's travel exceeds the body's own smallest half-
   * extent, which is exactly the regime where discrete detection is unreliable
   * — so it costs one raycast per substep at speed and nothing at a hover.
   *
   * @returns {number} impact speed along the surface normal, or 0 for no hit
   */
  _sweepGuard(body, from) {
    const to = body.position;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist2 = dx * dx + dy * dy + dz * dz;

    const r = body._ccdRadius || 0.05;
    if (dist2 < r * r) return 0;          // short hop: discrete detection is fine

    try {
      this._rayFrom.set(from.x, from.y, from.z);
      this._rayTo.set(to.x, to.y, to.z);
      this._rayResult.reset();

      this.world.raycastClosest(this._rayFrom, this._rayTo, RAY_OPTIONS, this._rayResult);
      if (!this._rayResult.hasHit) return 0;

      const hit = this._rayResult.hitPointWorld;
      const n = this._rayResult.hitNormalWorld;
      if (!isFiniteVec(hit) || !isFiniteVec(n)) return 0;

      // Speed into the surface, for the caller's crash test.
      const vn = body.velocity.x * n.x + body.velocity.y * n.y + body.velocity.z * n.z;
      const impact = vn < 0 ? -vn : 0;

      // Park the body just clear of the surface it crossed. The next substep
      // then resolves the contact normally, so the usual collision response and
      // crash detection still apply — we have only prevented the pass-through.
      body.position.set(hit.x + n.x * r * 1.05, hit.y + n.y * r * 1.05, hit.z + n.z * r * 1.05);

      // Kill the inbound normal component and keep a little bounce, so the quad
      // stops at the wall instead of grinding into it for the next few steps.
      if (vn < 0) {
        body.velocity.set(
          body.velocity.x - n.x * vn * 1.2,
          body.velocity.y - n.y * vn * 1.2,
          body.velocity.z - n.z * vn * 1.2,
        );
      }
      return impact;
    } catch (err) {
      console.warn('[PhysicsWorld] swept-collision guard failed; skipping.', err);
      return 0;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Stepping
   * ---------------------------------------------------------------------- */

  /**
   * Advance the world by exactly one fixed substep.
   *
   * Note the single-argument form of `world.step()`. cannon-es' three-argument
   * form runs its *own* internal accumulator; combining that with the game
   * loop's accumulator in main.js would double-step the simulation and make
   * physics speed depend on framerate — precisely what section 4 forbids.
   */
  step(dt = this.fixedTimeStep) {
    const h = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : this.fixedTimeStep;
    try {
      this.world.step(h);
    } catch (err) {
      // A solver exception must not end the session. Skipping one substep is
      // visually imperceptible; crashing is not.
      console.warn('[PhysicsWorld] solver step threw; substep skipped.', err);
    }
  }

  /**
   * Validate and repair a body after stepping. Returns a short report so the
   * caller (DroneController) can react — e.g. trigger a respawn if the body
   * had to be teleported back.
   *
   * @returns {{ healed: boolean, reason: string|null }}
   */
  sanitizeBody(body) {
    if (!body) return { healed: false, reason: null };

    const safe = this._safeState.get(body);
    let healed = false;
    let reason = null;

    // --- velocity -------------------------------------------------------
    const v = body.velocity;
    if (!isFiniteVec(v)) {
      v.set(0, 0, 0);
      healed = true;
      reason = 'velocity was not finite';
    } else {
      const speed = v.length();
      if (speed > LIMITS.MAX_LINEAR_VELOCITY) {
        v.scale(LIMITS.MAX_LINEAR_VELOCITY / speed, v);
        healed = true;
        reason = 'velocity clamped';
      }
    }

    const av = body.angularVelocity;
    if (!isFiniteVec(av)) {
      av.set(0, 0, 0);
      healed = true;
      reason = 'angular velocity was not finite';
    } else {
      const spin = av.length();
      if (spin > LIMITS.MAX_ANGULAR_VELOCITY) {
        av.scale(LIMITS.MAX_ANGULAR_VELOCITY / spin, av);
        healed = true;
        reason = 'angular velocity clamped';
      }
    }

    // --- orientation ----------------------------------------------------
    const q = body.quaternion;
    if (!isFiniteQuat(q)) {
      if (safe) q.copy(safe.quaternion);
      else q.set(0, 0, 0, 1);
      healed = true;
      reason = 'orientation was not finite';
    } else {
      // Re-normalise every frame regardless. Repeated integration slowly
      // denormalises a quaternion; a drifting norm shears the render matrix.
      q.normalize();
    }

    // --- position -------------------------------------------------------
    const p = body.position;
    if (!isFiniteVec(p)) {
      if (safe) p.copy(safe.position);
      else p.set(0, 2, 0);
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      healed = true;
      reason = 'position was not finite';
    } else if (
      Math.abs(p.x) > LIMITS.MAX_ABS_POSITION ||
      Math.abs(p.y) > LIMITS.MAX_ABS_POSITION ||
      Math.abs(p.z) > LIMITS.MAX_ABS_POSITION
    ) {
      if (safe) p.copy(safe.position);
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      healed = true;
      reason = 'position left the world';
    } else if (safe) {
      // Tunnelling guard: a single substep should never move the body further
      // than MAX_POSITION_DELTA. If it did, the solver produced a bad impulse.
      const dx = p.x - safe.position.x;
      const dy = p.y - safe.position.y;
      const dz = p.z - safe.position.z;
      if (dx * dx + dy * dy + dz * dz > LIMITS.MAX_POSITION_DELTA ** 2) {
        p.copy(safe.position);
        body.velocity.scale(0.25, body.velocity);
        healed = true;
        reason = 'position delta clamped';
      }
    }

    // --- swept collision -------------------------------------------------
    // `safe.position` still holds the pre-step position at this point, which is
    // exactly the ray's origin.
    let impactSpeed = 0;
    if (safe && !healed) {
      impactSpeed = this._sweepGuard(body, safe.position);
      if (impactSpeed > 0) {
        healed = true;
        reason = 'swept collision: stopped at surface';
      }
    }

    // Everything above is finite now, so this snapshot is safe to trust.
    if (safe) {
      safe.position.copy(body.position);
      safe.quaternion.copy(body.quaternion);
    }

    return { healed, reason, impactSpeed };
  }

  /** Force a protected body's known-good snapshot — call after a respawn. */
  commitSafeState(body) {
    const safe = this._safeState.get(body);
    if (!safe) {
      this.protect(body);
      return;
    }
    safe.position.copy(body.position);
    safe.quaternion.copy(body.quaternion);
  }

  /* ---------------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------------- */

  dispose() {
    this.clearTrackedBodies();
    try {
      // Drop remaining bodies the world knows about but we never tracked.
      while (this.world.bodies.length) this.world.removeBody(this.world.bodies[0]);
    } catch (_e) { /* ignore */ }
  }
}

/**
 * Broadphase for a world with (almost) only static geometry: every awake
 * dynamic body is tested against every other body by AABB. O(dynamic × n).
 */
class DynamicBroadphase extends CANNON.Broadphase {
  constructor(staticIndex) {
    super();
    this.staticIndex = staticIndex;
    this._near = [];
  }

  collisionPairs(world, p1, p2) {
    const bodies = world.bodies;
    const n = bodies.length;
    for (let i = 0; i < n; i++) {
      const a = bodies[i];
      if (a.type === CANNON.Body.STATIC || a.sleepState === CANNON.Body.SLEEPING) continue;
      if (a.aabbNeedsUpdate) a.updateAABB();
      // Static neighbours from the hash.
      const near = this._near;
      near.length = 0;
      this.staticIndex.query(a.aabb, near);
      for (let k = 0; k < near.length; k++) {
        const b = near[k];
        if (this.needBroadphaseCollision(a, b)) {
          p1.push(a);
          p2.push(b);
        }
      }
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = bodies[j];
        // Two dynamic bodies: emit the pair once (from the lower index).
        if (b.type !== CANNON.Body.STATIC && b.sleepState !== CANNON.Body.SLEEPING && j < i) continue;
        if (!this.needBroadphaseCollision(a, b)) continue;
        if (b.aabbNeedsUpdate) b.updateAABB();
        if (a.aabb.overlaps(b.aabb)) {
          p1.push(a);
          p2.push(b);
        }
      }
    }
  }

  aabbQuery(world, aabb, result = []) {
    const bodies = world.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.aabbNeedsUpdate) b.updateAABB();
      if (b.aabb.overlaps(aabb)) result.push(b);
    }
    this.staticIndex.query(aabb, result);
    return result;
  }
}

/**
 * Uniform XZ spatial hash of static bodies. Static bodies never move, so each
 * is bucketed once by its AABB footprint; a query touches only the few cells
 * under the asking AABB and de-duplicates with a stamp, so its cost depends on
 * what is *near*, not on how many colliders the map has.
 */
class StaticIndex {
  constructor(cellSize = 8) {
    this.cell = cellSize;
    this._cells = new Map();
    this._bodyCells = new Map();
    /** Bodies too large to bucket (infinite planes, map-wide slabs). */
    this._big = new Set();
    this._stamp = 0;
  }

  _k(ix, iz) {
    return ix * 73856093 ^ iz * 19349663;
  }

  has(body) {
    return this._bodyCells.has(body) || this._big.has(body);
  }

  add(body) {
    if (this.has(body)) return;
    body.updateAABB();
    body.aabbNeedsUpdate = false;
    const lo = body.aabb.lowerBound;
    const hi = body.aabb.upperBound;
    const c = this.cell;
    const spanX = (hi.x - lo.x) / c;
    const spanZ = (hi.z - lo.z) / c;
    if (!(spanX < 64 && spanZ < 64)) {
      // Infinite planes, whole-map slabs, or a non-finite AABB: test these
      // on every query instead of bucketing thousands of cells.
      body._staticStamp = 0;
      this._big.add(body);
      return;
    }
    const x0 = Math.floor(lo.x / c), x1 = Math.floor(hi.x / c);
    const z0 = Math.floor(lo.z / c), z1 = Math.floor(hi.z / c);
    const keys = [];
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this._k(ix, iz);
        let list = this._cells.get(k);
        if (!list) { list = []; this._cells.set(k, list); }
        list.push(body);
        keys.push(k);
      }
    }
    body._staticStamp = 0;
    this._bodyCells.set(body, keys);
  }

  remove(body) {
    if (this._big.delete(body)) return;
    const keys = this._bodyCells.get(body);
    if (!keys) return;
    for (const k of keys) {
      const list = this._cells.get(k);
      if (!list) continue;
      const i = list.indexOf(body);
      if (i >= 0) {
        list[i] = list[list.length - 1];
        list.pop();
      }
      if (list.length === 0) this._cells.delete(k);
    }
    this._bodyCells.delete(body);
  }

  query(aabb, out) {
    const lo = aabb.lowerBound;
    const hi = aabb.upperBound;
    if (![lo.x, lo.z, hi.x, hi.z].every(Number.isFinite)) return out;
    const c = this.cell;
    const x0 = Math.floor(lo.x / c), x1 = Math.floor(hi.x / c);
    const z0 = Math.floor(lo.z / c), z1 = Math.floor(hi.z / c);
    // A ray across the whole map would touch thousands of cells; beyond a
    // modest span it is cheaper to test every static body once.
    for (const b of this._big) if (b.aabb.overlaps(aabb)) out.push(b);
    if (!((x1 - x0 + 1) * (z1 - z0 + 1) <= 400)) {
      for (const b of this._bodyCells.keys()) if (b.aabb.overlaps(aabb)) out.push(b);
      return out;
    }
    const stamp = ++this._stamp;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this._cells.get(this._k(ix, iz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (b._staticStamp === stamp) continue;
          b._staticStamp = stamp;
          if (b.aabb.overlaps(aabb)) out.push(b);
        }
      }
    }
    return out;
  }

  get size() {
    return this._bodyCells.size + this._big.size;
  }

  clear() {
    this._cells.clear();
    this._bodyCells.clear();
    this._big.clear();
  }
}

/** Drop-in for cannon's ArrayCollisionMatrix that stores only set pairs. */
class SparseCollisionMatrix {
  constructor() {
    this._set = new Set();
  }

  _key(bi, bj) {
    // Body ids, not indices: static bodies live outside world.bodies.
    let i = bi.id;
    let j = bj.id;
    if (j > i) { const t = j; j = i; i = t; }
    return i * 16777216 + j;
  }

  get(bi, bj) {
    return this._set.has(this._key(bi, bj));
  }

  set(bi, bj, value) {
    const k = this._key(bi, bj);
    if (value) this._set.add(k);
    else this._set.delete(k);
  }

  reset() {
    this._set.clear();
  }

  setNumObjects() { /* sparse: nothing to size */ }
}

/**
 * Ray options for the swept-collision guard. Restricting the mask to WORLD
 * means the ray cannot hit the drone itself, and skipping backfaces stops a
 * body that is already inside geometry from being flung back out.
 */
const RAY_OPTIONS = {
  collisionFilterGroup: GROUP.DRONE,
  collisionFilterMask: GROUP.WORLD,
  skipBackfaces: true,
};

/* ========================================================================== *
 * Small validity helpers — hoisted so the hot path avoids closure allocation.
 * ========================================================================== */

export function isFiniteVec(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function isFiniteQuat(q) {
  return (
    !!q &&
    Number.isFinite(q.x) && Number.isFinite(q.y) &&
    Number.isFinite(q.z) && Number.isFinite(q.w) &&
    // A zero quaternion is finite but has no valid normalisation.
    (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) > 1e-8
  );
}

/** Clamp with NaN rejection — returns `fallback` for non-finite input. */
export function clampSafe(value, min, max, fallback = 0) {
  if (!Number.isFinite(value)) return fallback;
  return value < min ? min : value > max ? max : value;
}
