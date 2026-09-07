/**
 * core/DroneController.js
 * ---------------------------------------------------------------------------
 * The flight model: a rate-based acro quad in the Betaflight mould, plus an
 * assisted Angle mode for beginners.
 *
 * The chain each substep is:
 *
 *   normalised sticks
 *        │
 *        ├─ Angle mode: stick -> target *attitude* -> P controller -> rate setpoint
 *        └─ Acro  mode: stick -> rate setpoint directly
 *        │
 *        ▼
 *   rate PID (error between setpoint and measured body rate)
 *        │
 *        ▼
 *   X-frame motor mix (+ air-mode throttle offset)
 *        │
 *        ▼
 *   four applyLocalForce() calls at the four arm tips
 *
 * That last step matters: roll and pitch torque is *never* applied by hand. It
 * emerges from four discrete thrust vectors at four offsets, exactly as on a
 * real quad, which is what gives the model its coupling — pitching forward
 * costs you lift, a hard roll sags the altitude, and prop-wash-style wobble
 * falls out for free. Yaw is the one exception: it comes from motor *reaction*
 * torque, which has no thrust-vector equivalent, so it is applied directly.
 *
 * COORDINATE / SIGN CONVENTIONS (shared with InputManager):
 *   Local axes: +X right, +Y up, -Z forward.
 *   pitch > 0 = nose down (fly forward)   roll > 0 = roll right   yaw > 0 = turn right
 *   Measured body rates are negated into this frame (see `_readBodyRates`).
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP, clampSafe, isFiniteVec } from './PhysicsWorld.js';
import { settings } from './Settings.js';
import { paintedMetalTexture } from '../assets/procedural.js';

/* ========================================================================== *
 * Airframe constants — a 250 mm-class 5" freestyle quad
 * ========================================================================== */

const MASS = 0.5;                  // kg
const ARM = 0.09;                  // m, motor offset from centre on X and Z
const BODY_HALF = new CANNON.Vec3(0.10, 0.03, 0.10);

/**
 * Peak thrust per motor. Four of these give 14.8 N against a 4.905 N weight,
 * so thrust-to-weight is ~3.0:1 — punchy enough to feel like a real freestyle
 * quad, gentle enough that a beginner can find hover.
 *
 * Hover therefore sits near 33% throttle, which is the single most important
 * number in this file: too high and the quad never leaves the ground, too low
 * and the bottom 10% of stick travel is unflyable.
 */
const MOTOR_MAX_THRUST = 3.7;      // N
const HOVER_THROTTLE = (MASS * 9.81) / (4 * MOTOR_MAX_THRUST); // ≈ 0.331

/** Peak yaw reaction torque at full mix, scaled by average motor load. */
const YAW_TORQUE = 0.14;           // N·m

/* --- Rate PID ------------------------------------------------------------
 * Tuned against the airframe above. Full mix authority produces roughly
 * 360 rad/s² about pitch/roll, so a P term of 0.09 closes the rate loop with a
 * ~25 ms time constant: crisp, and comfortably stable at the 120 Hz substep.
 * ------------------------------------------------------------------------ */
const PID = {
  roll:  { p: 0.090, i: 0.28, d: 0.00035 },
  pitch: { p: 0.090, i: 0.28, d: 0.00035 },
  yaw:   { p: 0.300, i: 0.50, d: 0.00000 },
};
const I_LIMIT = 0.25;              // cap on each integral term's contribution

/**
 * Derivative low-pass cutoff, in hertz.
 *
 * D is the term that wrecks a rate loop if you let it run raw. Full mix
 * authority is ~366 rad/s² about roll, so one substep of saturated output
 * changes the measured rate by ~3 rad/s; differentiating that gives 366 rad/s²,
 * and an unfiltered gain of even 0.0016 would feed back -0.59 x the *previous*
 * step's output. That is a two-step oscillator, and once the motors clip it
 * stops being marginally stable and starts tumbling.
 *
 * Expressed as a **frequency**, not a fixed blend factor, so the tune does not
 * change when the simulation rate does. The per-step coefficient is derived
 * from dt each substep (`dLpfAlpha`), which means the same gains behave
 * identically at 120, 240, or 960 Hz — otherwise raising the rate would
 * silently sharpen D and reintroduce the oscillation.
 */
const D_CUTOFF_HZ = 6;
const D_RC = 1 / (2 * Math.PI * D_CUTOFF_HZ);

/** First-order RC low-pass coefficient for this substep length. */
function dLpfAlpha(dt) {
  return dt / (dt + D_RC);
}

/**
 * Angle-mode attitude loop gain.
 *
 * This is the outer loop of a cascade, so it must be comfortably slower than
 * the rate loop it drives — otherwise the two fight and the quad hunts. The
 * rate loop settles in ~30 ms; 6.0 gives the attitude loop a ~170 ms time
 * constant, a healthy 5:1 separation.
 */
const ANGLE_P = 6.0;               // 1/s

/** Angle mode never commands the full acro rate — it would slam into the cap. */
const ANGLE_MAX_RATE = 360 * Math.PI / 180;   // rad/s

/* --- Aerodynamics --------------------------------------------------------
 * Quadratic drag in the *body* frame, so the quad is much draggier when the
 * prop disc faces the airflow (descending flat) than when it is knifing
 * forward — the spec's "higher facing into airflow".
 *
 * Note: cannon's own `linearDamping` is kept very low. It is a per-step
 * exponential decay, not a force, and stacking the spec's 0.15 on top of real
 * quadratic drag would double-count and make the quad feel like it is flying
 * through syrup.
 * ------------------------------------------------------------------------ */
const DRAG_LATERAL = 0.011;        // along X / Z — terminal ≈ 35 m/s
const DRAG_VERTICAL = 0.050;       // along Y — flat descent terminal ≈ 10 m/s

/* --- Battery (4S LiPo) --------------------------------------------------- */
const BATT = {
  FULL: 16.8, LOW: 14.8, CRITICAL: 14.0, CUTOFF: 13.0, EMPTY: 13.2,
  HOVER_SECONDS: 300,              // endurance at hover
  SAG: 1.5,                        // volts dropped at full load
};

/* --- Crash handling ------------------------------------------------------ */
const CRASH_IMPACT_SPEED = 4.5;    // m/s along the contact normal
const CRASH_LOCKOUT = 1.5;         // s of ignored input after a crash
const TURTLE_DURATION = 1.5;       // s of righting torque before we give up

export const FLIGHT_MODES = ['angle', 'acro'];

export class DroneController {
  /**
   * @param {import('./PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(physics) {
    this.physics = physics;

    /* ---- state ---- */
    this.armed = false;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = 0;
    this.batteryCharge = 1;
    this.batteryVoltage = BATT.FULL;
    this.motorCutByBattery = false;
    this.throttleEverApplied = false;   // gates the Time Trial clock

    /** Populated each substep; read by the HUD and the audio engine. */
    this.motors = [0, 0, 0, 0];        // FL, FR, RL, RR in 0..1
    this.avgMotor = 0;
    this.telemetry = {
      speed: 0, altitude: 0, verticalSpeed: 0,
      rollDeg: 0, pitchDeg: 0, headingDeg: 0,
      gForce: 1,
    };

    /* ---- spawn ---- */
    this.spawnPoint = new THREE.Vector3(0, 1.2, 0);
    this.spawnHeading = 0;             // radians about world Y
    this.groundLevel = 0;              // for AGL altitude readout

    /* ---- wind (Field map) ---- */
    this.windEnabled = false;
    this.windDirection = new THREE.Vector3(1, 0, 0.35).normalize();
    this.windStrength = 0.9;           // N at full gust
    this._windPhase = 0;

    /* ---- PID integrators / derivative memory ---- */
    this._i = { roll: 0, pitch: 0, yaw: 0 };
    this._prevRate = { roll: 0, pitch: 0, yaw: 0 };
    this._dLpf = { roll: 0, pitch: 0, yaw: 0 };

    /* ---- callbacks ---- */
    this.onCrash = null;               // (impactSpeed) => void
    this.onRespawn = null;
    this.onArmChange = null;           // (armed) => void
    this.onBatteryState = null;        // ('low' | 'critical' | 'cutoff') => void
    this._batteryStage = 'ok';

    /* ---- scratch vectors (allocated once — this runs 120x/second) ---- */
    this._v1 = new CANNON.Vec3();
    this._v2 = new CANNON.Vec3();
    this._v3 = new CANNON.Vec3();
    this._invQ = new CANNON.Quaternion();
    this._localAV = new CANNON.Vec3();
    this._localVel = new CANNON.Vec3();
    this._forceVec = new CANNON.Vec3();
    this._motorOffsets = [
      new CANNON.Vec3(-ARM, 0, -ARM),  // FL (front-left, -Z is forward)
      new CANNON.Vec3(+ARM, 0, -ARM),  // FR
      new CANNON.Vec3(-ARM, 0, +ARM),  // RL
      new CANNON.Vec3(+ARM, 0, +ARM),  // RR
    ];
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._tq = new THREE.Quaternion();

    /* ---- interpolation snapshots ---- */
    this.prevPosition = new THREE.Vector3();
    this.prevQuaternion = new THREE.Quaternion();
    this.currPosition = new THREE.Vector3();
    this.currQuaternion = new THREE.Quaternion();

    this._buildBody();
    this._buildMesh();
  }

  /* ====================================================================== *
   * Construction
   * ====================================================================== */

  _buildBody() {
    this.body = new CANNON.Body({
      mass: MASS,
      shape: new CANNON.Box(BODY_HALF),
      material: this.physics.droneMaterial,
      linearDamping: 0.03,     // residual only; real drag is applied as a force
      angularDamping: 0.35,    // natural rotational settling on top of the PID
      collisionFilterGroup: GROUP.DRONE,
      collisionFilterMask: GROUP.WORLD | GROUP.PROP,
    });
    // The world allows sleeping for the benefit of static level geometry; the
    // quad must never sleep or applyLocalForce would silently do nothing.
    this.body.allowSleep = false;
    this.body.position.set(0, 1.2, 0);

    this.body.addEventListener('collide', (e) => this._onCollide(e));

    this.physics.addBody(this.body);
    this.physics.protect(this.body);
  }

  /**
   * A simple procedural airframe. Invisible in FPV (that is the whole point of
   * first-person view) but needed for the chase and cinematic cameras.
   */
  _buildMesh() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'drone';

    const carbonTex = paintedMetalTexture(51, [1, 1], [42, 44, 48]);
    const carbon = new THREE.MeshStandardMaterial({
      color: 0x2a2c30, roughness: 0.62, metalness: 0.25, map: carbonTex,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: 0x18e08a, roughness: 0.4, metalness: 0.1,
      emissive: 0x0d5c38, emissiveIntensity: 0.7,
    });
    const motorMat = new THREE.MeshStandardMaterial({
      color: 0x8a8d92, roughness: 0.35, metalness: 0.85,
    });
    this._materials = [carbon, accent, motorMat];
    this._textures = [carbonTex];

    // Centre stack
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.028, 0.11), carbon);
    this.object3d.add(plate);

    const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.032, 0.05), accent);
    canopy.position.set(0, 0.026, -0.018);
    this.object3d.add(canopy);

    // Arms + motors + props
    this.propMeshes = [];
    const armGeo = new THREE.BoxGeometry(0.017, 0.008, 0.115);
    const motorGeo = new THREE.CylinderGeometry(0.0135, 0.0145, 0.019, 10);
    const propGeo = new THREE.BoxGeometry(0.126, 0.0018, 0.011);

    for (let i = 0; i < 4; i++) {
      const sx = i === 0 || i === 2 ? -1 : 1;   // FL/RL are on -X
      const sz = i < 2 ? -1 : 1;                // FL/FR are on -Z

      const arm = new THREE.Mesh(armGeo, carbon);
      arm.position.set(sx * ARM * 0.55, 0, sz * ARM * 0.55);
      arm.rotation.y = sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4;
      this.object3d.add(arm);

      const motor = new THREE.Mesh(motorGeo, motorMat);
      motor.position.set(sx * ARM, 0.014, sz * ARM);
      this.object3d.add(motor);

      const prop = new THREE.Mesh(propGeo, carbon);
      prop.position.set(sx * ARM, 0.026, sz * ARM);
      this.object3d.add(prop);
      this.propMeshes.push(prop);
    }

    this._geometries = [
      plate.geometry, canopy.geometry, armGeo, motorGeo, propGeo,
    ];
    this._propSpin = 0;
  }

  /* ====================================================================== *
   * Spawn / reset
   * ====================================================================== */

  /** Point the drone at a map's spawn without stepping physics. */
  setSpawn(position, headingRadians = 0, groundLevel = 0) {
    if (position) this.spawnPoint.set(position.x, position.y, position.z);
    this.spawnHeading = Number.isFinite(headingRadians) ? headingRadians : 0;
    this.groundLevel = Number.isFinite(groundLevel) ? groundLevel : 0;
  }

  /**
   * Full respawn: position, orientation, velocities, controller integrators,
   * battery, and crash state. Called on `R`, on map load, and by the
   * out-of-bounds guard.
   */
  respawn({ resetBattery = true } = {}) {
    const b = this.body;

    b.position.set(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.force.set(0, 0, 0);
    b.torque.set(0, 0, 0);

    // Level, facing the spawn heading.
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), this.spawnHeading);
    b.quaternion.normalize();

    this._i.roll = 0; this._i.pitch = 0; this._i.yaw = 0;
    this._prevRate.roll = 0; this._prevRate.pitch = 0; this._prevRate.yaw = 0;
    this._dLpf.roll = 0; this._dLpf.pitch = 0; this._dLpf.yaw = 0;

    this.motors = [0, 0, 0, 0];
    this.avgMotor = 0;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = 0;
    this.throttleEverApplied = false;

    if (resetBattery) {
      this.batteryCharge = 1;
      this.batteryVoltage = BATT.FULL;
      this.motorCutByBattery = false;
      this._batteryStage = 'ok';
    }

    this.setArmed(false);
    this.physics.commitSafeState(b);
    this._syncSnapshots(true);

    if (typeof this.onRespawn === 'function') {
      try { this.onRespawn(); } catch (_e) { /* ignore */ }
    }
  }

  setArmed(next) {
    const value = !!next && !this.motorCutByBattery;
    if (value === this.armed) return;
    this.armed = value;
    if (!value) {
      // Disarm zeroes the integrators so the quad does not lurch when re-armed
      // with a stale accumulated correction.
      this._i.roll = 0; this._i.pitch = 0; this._i.yaw = 0;
      this.motors = [0, 0, 0, 0];
      this.avgMotor = 0;
    }
    if (typeof this.onArmChange === 'function') {
      try { this.onArmChange(this.armed); } catch (_e) { /* ignore */ }
    }
  }

  toggleArmed() {
    this.setArmed(!this.armed);
  }

  /* ====================================================================== *
   * Collisions
   * ====================================================================== */

  _onCollide(event) {
    try {
      const contact = event.contact;
      if (!contact) return;

      // Impact speed measured along the contact normal — a graze along a wall
      // has a large tangential speed but a tiny normal component, and real FPV
      // pilots clip walls constantly without it counting as a crash.
      let impact = Math.abs(contact.getImpactVelocityAlongNormal());
      if (!Number.isFinite(impact)) return;

      if (impact >= CRASH_IMPACT_SPEED && !this.crashed) {
        this.crashed = true;
        this.crashTimer = CRASH_LOCKOUT;
        this.setArmed(false);
        this.motors = [0, 0, 0, 0];
        this.avgMotor = 0;
        if (typeof this.onCrash === 'function') this.onCrash(impact);
      }
    } catch (err) {
      console.warn('[DroneController] collide handler failed', err);
    }
  }

  /* ====================================================================== *
   * Turtle mode
   * ====================================================================== */

  /** Kick off a righting manoeuvre if the quad is on its back. */
  requestTurtle() {
    if (this.isInverted()) this.turtleTimer = TURTLE_DURATION;
  }

  isInverted() {
    this._readOrientation();
    return this._up.y < 0.1;
  }

  /**
   * Apply a torque toward upright, plus a small upward force to unstick the
   * frame from the floor. If a real torque has not righted it within
   * TURTLE_DURATION we fall back to snapping level — the spec's "simpler,
   * stable version" rather than leaving the pilot permanently upside down.
   */
  _applyTurtle(dt) {
    this.turtleTimer -= dt;
    this._readOrientation();

    if (this._up.y > 0.75) { this.turtleTimer = 0; return; }

    if (this.turtleTimer <= 0) {
      this.body.quaternion.setFromAxisAngle(
        new CANNON.Vec3(0, 1, 0), this.telemetry.headingDeg * Math.PI / 180,
      );
      this.body.angularVelocity.set(0, 0, 0);
      this.body.position.y += 0.12;
      return;
    }

    // Rotation axis that carries the body's up-vector onto world up.
    const axis = new THREE.Vector3().crossVectors(this._up, WORLD_UP);
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);   // exactly inverted: pick one
    axis.normalize();

    const angle = Math.acos(clampSafe(this._up.dot(WORLD_UP), -1, 1, 0));
    const strength = 0.55 * angle;

    this._v1.set(axis.x * strength, axis.y * strength, axis.z * strength);
    this.body.applyTorque(this._v1);

    // Enough lift to break floor contact so the flip has room to happen.
    this._v2.set(0, MASS * 9.81 * 1.15, 0);
    this.body.applyForce(this._v2);
  }

  /* ====================================================================== *
   * Per-substep update
   * ====================================================================== */

  /**
   * Advance the flight controller by one fixed physics substep.
   * Must be called immediately BEFORE `physics.step()`.
   *
   * @param {number} dt      fixed substep in seconds
   * @param {{throttle:number,pitch:number,roll:number,yaw:number}} controls
   */
  update(dt, controls) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    // Snapshot the pre-step transform so the renderer can interpolate.
    this.prevPosition.copy(this.currPosition);
    this.prevQuaternion.copy(this.currQuaternion);

    // --- input gating -------------------------------------------------
    let thr = clampSafe(controls?.throttle, 0, 1, 0);
    let cmdPitch = clampSafe(controls?.pitch, -1, 1, 0);
    let cmdRoll = clampSafe(controls?.roll, -1, 1, 0);
    let cmdYaw = clampSafe(controls?.yaw, -1, 1, 0);

    if (this.crashed) {
      // Input lockout after a crash: sticks are ignored entirely.
      this.crashTimer -= dt;
      thr = 0; cmdPitch = 0; cmdRoll = 0; cmdYaw = 0;
      if (this.crashTimer <= 0) this.crashed = false;
    }

    if (this.turtleTimer > 0) {
      this._applyTurtle(dt);
      thr = 0; cmdPitch = 0; cmdRoll = 0; cmdYaw = 0;
    }

    if (thr > 0.02 && this.armed) this.throttleEverApplied = true;

    this._readOrientation();
    this._updateBattery(dt, thr);

    if (!this.armed || this.motorCutByBattery) {
      this.motors[0] = this.motors[1] = this.motors[2] = this.motors[3] = 0;
      this.avgMotor = 0;
    } else {
      this._flightControl(dt, thr, cmdPitch, cmdRoll, cmdYaw);
    }

    this._applyAerodynamics();
    if (this.windEnabled) this._applyWind(dt);

    this._updateTelemetry();
  }

  /** Cache the body's basis vectors as Three.js vectors for the frame. */
  _readOrientation() {
    const q = this.body.quaternion;
    this._tq.set(q.x, q.y, q.z, q.w);
    this._up.set(0, 1, 0).applyQuaternion(this._tq);
    this._fwd.set(0, 0, -1).applyQuaternion(this._tq);
    this._right.set(1, 0, 0).applyQuaternion(this._tq);
  }

  /**
   * Read body-frame angular velocity and convert into the control convention
   * (positive = nose down / roll right / yaw right).
   *
   * World angular velocity is rotated by the inverse body quaternion to get it
   * into the frame the motors actually live in — using world rates directly
   * would make the controller behave differently depending on heading.
   */
  _readBodyRates(out) {
    this.body.quaternion.conjugate(this._invQ);
    this._invQ.vmult(this.body.angularVelocity, this._localAV);

    // Negations map cannon's right-handed axes onto the stick convention:
    // +ωx is nose-up but +pitch is nose-down, and likewise for roll and yaw.
    out.pitch = -this._localAV.x;
    out.yaw = -this._localAV.y;
    out.roll = -this._localAV.z;

    if (!Number.isFinite(out.pitch)) out.pitch = 0;
    if (!Number.isFinite(out.yaw)) out.yaw = 0;
    if (!Number.isFinite(out.roll)) out.roll = 0;
  }

  _flightControl(dt, thr, cmdPitch, cmdRoll, cmdYaw) {
    const rates = settings.get('rates');
    const mode = settings.get('flightMode');

    const maxRoll = deg2rad(rates.roll);
    const maxPitch = deg2rad(rates.pitch);
    const maxYaw = deg2rad(rates.yaw);

    // --- 1. rate setpoints --------------------------------------------
    let spRoll, spPitch;
    const spYaw = cmdYaw * maxYaw;   // yaw is rate-controlled in both modes

    if (mode === 'angle') {
      // Angle mode: the stick commands an *attitude*, and an outer P loop
      // turns the attitude error into a rate request. Centring the sticks
      // therefore commands level, which is what makes it self-levelling.
      const maxTilt = deg2rad(settings.get('maxTilt'));

      // Yaw-independent attitude extraction. Reading Euler angles from the
      // quaternion directly would gimbal-lock when the nose passes vertical.
      const pitchNow = -Math.asin(clampSafe(this._fwd.y, -1, 1, 0));
      const rollNow = Math.atan2(-this._right.y, this._up.y);

      const capPitch = Math.min(maxPitch, ANGLE_MAX_RATE);
      const capRoll = Math.min(maxRoll, ANGLE_MAX_RATE);
      spPitch = clamp(ANGLE_P * (cmdPitch * maxTilt - pitchNow), -capPitch, capPitch);
      spRoll = clamp(ANGLE_P * (cmdRoll * maxTilt - rollNow), -capRoll, capRoll);
    } else {
      // Acro: the stick *is* the rate command. Nothing self-levels, so the
      // quad holds whatever attitude the pilot leaves it in.
      spPitch = cmdPitch * maxPitch;
      spRoll = cmdRoll * maxRoll;
    }

    // --- 2. rate PID ---------------------------------------------------
    this._readBodyRates(RATE_SCRATCH);

    const mixRoll = this._pidAxis('roll', spRoll, RATE_SCRATCH.roll, dt);
    const mixPitch = this._pidAxis('pitch', spPitch, RATE_SCRATCH.pitch, dt);
    const mixYaw = this._pidAxis('yaw', spYaw, RATE_SCRATCH.yaw, dt);

    // --- 3. X-frame motor mix -----------------------------------------
    this._mix(thr, mixPitch, mixRoll, mixYaw);

    // --- 4. apply thrust ----------------------------------------------
    for (let i = 0; i < 4; i++) {
      const f = this.motors[i] * MOTOR_MAX_THRUST;
      if (f <= 0) continue;
      this._forceVec.set(0, f, 0);
      this.body.applyLocalForce(this._forceVec, this._motorOffsets[i]);
    }

    // --- 5. yaw reaction torque ---------------------------------------
    // Spinning props drag air; the frame feels the equal-and-opposite twist.
    // Authority scales with motor load because a quad at idle barely yaws.
    const authority = 0.35 + 0.65 * this.avgMotor;
    const localTorqueY = -mixYaw * YAW_TORQUE * authority;
    this._v1.set(0, localTorqueY, 0);
    this.body.quaternion.vmult(this._v1, this._v2);
    if (isFiniteVec(this._v2)) this.body.applyTorque(this._v2);
  }

  /**
   * One axis of the rate PID.
   *
   * The derivative term differentiates the *measurement*, not the error. If it
   * differentiated the error, a step change in stick position would produce an
   * instantaneous spike ("derivative kick") that shows up as a twitch every
   * time the pilot slams a stick.
   */
  _pidAxis(axis, setpoint, measured, dt) {
    const gains = PID[axis];
    const error = setpoint - measured;
    const iMax = I_LIMIT / Math.max(gains.i, 1e-6);

    // Derivative on the *measurement*, low-pass filtered. Differentiating the
    // error instead would spike every time the pilot slams a stick
    // ("derivative kick"); leaving it unfiltered would oscillate (see D_LPF).
    const rawD = (measured - this._prevRate[axis]) / dt;
    this._prevRate[axis] = measured;
    if (Number.isFinite(rawD)) {
      this._dLpf[axis] += dLpfAlpha(dt) * (rawD - this._dLpf[axis]);
    }
    if (!Number.isFinite(this._dLpf[axis])) this._dLpf[axis] = 0;
    const dTerm = gains.d * this._dLpf[axis];

    // Provisional integration.
    const prevI = this._i[axis];
    let integral = clamp(prevI + error * dt, -iMax, iMax);
    if (!Number.isFinite(integral)) integral = 0;

    let out = gains.p * error + gains.i * integral - dTerm;

    // Conditional integration (anti-windup): if the output is already clipped
    // and the error is pushing it further past the rail, integrating does
    // nothing except store up a correction that has to be unwound later — the
    // classic cause of a control loop that lags long after the stick centred.
    if (Math.abs(out) > 1 && Math.sign(out) === Math.sign(error)) {
      integral = prevI;
      out = gains.p * error + gains.i * integral - dTerm;
    }

    this._i[axis] = integral;
    if (!Number.isFinite(out)) out = 0;

    // Mix terms live in motor-command units; ±1 is already full authority.
    return clamp(out, -1, 1);
  }

  /**
   * X-frame mix with air mode.
   *
   *   motorFL = throttle - pitch + roll - yaw
   *   motorFR = throttle - pitch - roll + yaw
   *   motorRL = throttle + pitch + roll + yaw
   *   motorRR = throttle + pitch - roll - yaw
   *
   * Naively clamping each motor to [0,1] destroys rotational authority the
   * moment any motor saturates: at full throttle the quad simply stops
   * responding to roll. Air mode fixes that by treating the rotation terms as
   * a rigid band and *sliding the throttle* until the whole band fits inside
   * the valid range, scaling the band down only if it is wider than the range.
   */
  _mix(throttle, pitch, roll, yaw) {
    let fl = -pitch + roll - yaw;
    let fr = -pitch - roll + yaw;
    let rl = +pitch + roll + yaw;
    let rr = +pitch - roll - yaw;

    let mn = Math.min(fl, fr, rl, rr);
    let mx = Math.max(fl, fr, rl, rr);
    const range = mx - mn;

    if (range > 1) {
      // Rotation demand alone exceeds the motors' whole range. Scale it back
      // proportionally so the *ratio* between axes — and therefore the
      // commanded rotation direction — is preserved.
      const s = 1 / range;
      fl *= s; fr *= s; rl *= s; rr *= s;
      mn *= s; mx *= s;
    }

    // Slide the throttle so the rotation band sits inside [0,1].
    const base = clamp(throttle, -mn, 1 - mx);

    this.motors[0] = clamp(base + fl, 0, 1);
    this.motors[1] = clamp(base + fr, 0, 1);
    this.motors[2] = clamp(base + rl, 0, 1);
    this.motors[3] = clamp(base + rr, 0, 1);

    this.avgMotor = (this.motors[0] + this.motors[1] + this.motors[2] + this.motors[3]) * 0.25;
    if (!Number.isFinite(this.avgMotor)) this.avgMotor = 0;
  }

  /**
   * Anisotropic quadratic drag, evaluated in the body frame.
   *
   *   F = -k * |v| * v     (per body axis)
   *
   * Quadratic rather than linear because that is what actually governs a quad
   * at flight speeds, and it gives a natural terminal velocity instead of an
   * ever-increasing dive.
   */
  _applyAerodynamics() {
    const vel = this.body.velocity;
    if (!isFiniteVec(vel)) return;

    this.body.quaternion.conjugate(this._invQ);
    this._invQ.vmult(vel, this._localVel);

    const lx = this._localVel.x;
    const ly = this._localVel.y;
    const lz = this._localVel.z;

    // The prop disc is a far bigger frontal area than the frame's edge, so
    // vertical drag dominates — this is why a quad drops slowly when flat.
    this._v1.set(
      -DRAG_LATERAL * Math.abs(lx) * lx,
      -DRAG_VERTICAL * Math.abs(ly) * ly,
      -DRAG_LATERAL * Math.abs(lz) * lz,
    );

    this.body.quaternion.vmult(this._v1, this._v2);
    // NOTE: applyForce's second argument is an offset *relative to the centre
    // of mass*, not a world position. Passing body.position here would apply
    // drag on a lever arm equal to the altitude, generating a phantom torque
    // that grows as you climb — and silently cancels roll authority.
    if (isFiniteVec(this._v2)) this.body.applyForce(this._v2);
  }

  /** Constant breeze plus a slow gust cycle — Field map practice aid. */
  _applyWind(dt) {
    this._windPhase += dt * 0.35;
    const gust = 0.65 + 0.35 * Math.sin(this._windPhase) * Math.sin(this._windPhase * 0.37);
    const f = this.windStrength * gust;
    this._v3.set(this.windDirection.x * f, 0, this.windDirection.z * f);
    this.body.applyForce(this._v3);   // centre of mass — see _applyAerodynamics
  }

  /**
   * 4S LiPo model: charge drains with motor load, and terminal voltage is the
   * resting curve minus load sag. Sag is what makes a tired pack read fine at
   * idle and then dip into the warning band the moment you punch out.
   */
  _updateBattery(dt, throttle) {
    // Hover is the reference load; heavier throttle drains super-linearly.
    const load = this.armed ? Math.max(this.avgMotor, throttle * 0.6) : 0;
    const drainPerSecond = (1 / BATT.HOVER_SECONDS) *
      (0.12 + 1.75 * Math.pow(load / Math.max(HOVER_THROTTLE, 1e-3), 1.4) * HOVER_THROTTLE);

    this.batteryCharge = clamp(this.batteryCharge - drainPerSecond * dt, 0, 1);

    // Resting curve: fairly flat through the middle, knees hard at the end.
    const rest = BATT.EMPTY + (BATT.FULL - BATT.EMPTY) * Math.pow(this.batteryCharge, 0.45);
    const sag = BATT.SAG * this.avgMotor;
    this.batteryVoltage = clamp(rest - sag, 10, BATT.FULL);

    let stage = 'ok';
    if (this.batteryVoltage <= BATT.CUTOFF) stage = 'cutoff';
    else if (this.batteryVoltage <= BATT.CRITICAL) stage = 'critical';
    else if (this.batteryVoltage <= BATT.LOW) stage = 'low';

    if (stage === 'cutoff' && !this.motorCutByBattery) {
      this.motorCutByBattery = true;
      this.setArmed(false);
    }

    if (stage !== this._batteryStage) {
      this._batteryStage = stage;
      if (stage !== 'ok' && typeof this.onBatteryState === 'function') {
        try { this.onBatteryState(stage); } catch (_e) { /* ignore */ }
      }
    }
  }

  _updateTelemetry() {
    const v = this.body.velocity;
    const p = this.body.position;
    const t = this.telemetry;

    t.speed = isFiniteVec(v) ? Math.hypot(v.x, v.y, v.z) : 0;
    t.verticalSpeed = Number.isFinite(v.y) ? v.y : 0;
    t.altitude = Math.max(0, (Number.isFinite(p.y) ? p.y : 0) - this.groundLevel);

    t.pitchDeg = -Math.asin(clampSafe(this._fwd.y, -1, 1, 0)) * 180 / Math.PI;
    t.rollDeg = Math.atan2(-this._right.y, this._up.y) * 180 / Math.PI;

    // Compass heading: 0° = -Z (north), increasing clockwise.
    let heading = Math.atan2(this._fwd.x, -this._fwd.z) * 180 / Math.PI;
    if (heading < 0) heading += 360;
    t.headingDeg = heading;

    t.gForce = this.armed ? (this.avgMotor * 4 * MOTOR_MAX_THRUST) / (MASS * 9.81) : 0;
    if (!Number.isFinite(t.gForce)) t.gForce = 0;
  }

  /* ====================================================================== *
   * Render-side sync
   * ====================================================================== */

  /** Copy the body transform into the interpolation snapshots. */
  _syncSnapshots(both = false) {
    const p = this.body.position;
    const q = this.body.quaternion;
    this.currPosition.set(p.x, p.y, p.z);
    this.currQuaternion.set(q.x, q.y, q.z, q.w);
    if (both) {
      this.prevPosition.copy(this.currPosition);
      this.prevQuaternion.copy(this.currQuaternion);
    }
  }

  /** Called by main.js after each physics substep completes. */
  afterStep() {
    this._syncSnapshots(false);
  }

  /**
   * Write the interpolated transform onto the visual mesh.
   * `alpha` is the leftover accumulator fraction, so visuals stay smooth even
   * when the render rate is not a multiple of the 120 Hz physics rate.
   */
  applyInterpolation(alpha, outPosition, outQuaternion) {
    const a = clampSafe(alpha, 0, 1, 1);

    outPosition.copy(this.prevPosition).lerp(this.currPosition, a);
    outQuaternion.copy(this.prevQuaternion).slerp(this.currQuaternion, a);

    if (!Number.isFinite(outPosition.x) || !Number.isFinite(outPosition.y) || !Number.isFinite(outPosition.z)) {
      outPosition.copy(this.currPosition);
    }

    this.object3d.position.copy(outPosition);
    this.object3d.quaternion.copy(outQuaternion);
  }

  /** Spin the prop meshes at a rate that reads as motor load. */
  updateVisuals(dtRender) {
    if (!this.propMeshes) return;
    const rate = this.armed ? 40 + this.avgMotor * 260 : 0;
    this._propSpin = (this._propSpin + rate * dtRender) % (Math.PI * 2);
    for (let i = 0; i < this.propMeshes.length; i++) {
      // Alternate direction per diagonal, like a real quad.
      const dir = i === 0 || i === 3 ? 1 : -1;
      this.propMeshes[i].rotation.y = this._propSpin * dir;
    }
  }

  /** Reported to the HUD so the pilot knows why the motors cut. */
  getBatteryStage() {
    return this._batteryStage;
  }

  /* ====================================================================== *
   * Teardown
   * ====================================================================== */

  dispose() {
    this.physics.removeBody(this.body);
    try {
      this.object3d.parent?.remove(this.object3d);
      for (const g of this._geometries || []) g?.dispose?.();
      for (const m of this._materials || []) m?.dispose?.();
      for (const t of this._textures || []) t?.dispose?.();
    } catch (_e) { /* teardown must never throw */ }
  }
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const RATE_SCRATCH = { roll: 0, pitch: 0, yaw: 0 };

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function deg2rad(d) {
  return (Number.isFinite(d) ? d : 0) * Math.PI / 180;
}

export { MASS, MOTOR_MAX_THRUST, HOVER_THROTTLE, BATT };
