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

    // SAP broadphase scales far better than the naive one once a map has a few
    // hundred static bodies (the warehouse does).
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
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
      this.world.addBody(body);
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
      this.world.removeBody(body);
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

    // Everything above is finite now, so this snapshot is safe to trust.
    if (safe) {
      safe.position.copy(body.position);
      safe.quaternion.copy(body.quaternion);
    }

    return { healed, reason };
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
