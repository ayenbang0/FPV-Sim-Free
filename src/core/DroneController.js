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
import { getAirframe, DEFAULT_DRONE_TYPE, WIND_PRESSURE } from './DroneTypes.js';
import { blackbox } from './Blackbox.js';

/* ========================================================================== *
 * Tuning that is genuinely airframe-independent
 * ==========================================================================
 * Everything with a mass, a size, or a thrust figure now lives in
 * DroneTypes.js and reaches this file as `this.spec`. What stays here is the
 * handful of numbers that describe the *controller*, not the aircraft.
 * ========================================================================== */

/** Cap on each integral term's contribution to a +/-1 mix command.
 *  Airframe-independent by construction: it is expressed in mix units. */
const I_LIMIT = 0.25;

/**
 * Derivative low-pass cutoff, in hertz.
 *
 * D is the term that wrecks a rate loop if you let it run raw. One substep of
 * saturated output changes the measured rate by alphaMax * dt, and D feeds
 * that straight back; unfiltered, that is a two-step oscillator that stops
 * being marginally stable the moment the motors clip.
 *
 * Expressed as a **frequency**, not a fixed blend factor, so the tune does not
 * change when the simulation rate does. The per-step coefficient is derived
 * from dt each substep, which means the same gains behave identically at 120,
 * 240, or 960 Hz.
 *
 * The companion protection is in DroneTypes.derive(), which holds
 * `Kd * alphaMax` constant across airframes.
 */
const D_CUTOFF_HZ = 6;
const D_RC = 1 / (2 * Math.PI * D_CUTOFF_HZ);

/** First-order RC low-pass coefficient for this substep length. */
function dLpfAlpha(dt) {
  return dt / (dt + D_RC);
}

/**
 * Throttle-PID-attenuation factor for a throttle position: 1.0 below the
 * cutoff, ramping down by `amount` at full stick. Fully guarded — garbage in
 * (NaN settings, NaN throttle) yields 1.0, i.e. no attenuation, never NaN.
 */
function tpaFactorFor(thr) {
  const tpa = settings.get('tpa') || { start: 0.65, amount: 0.35 };
  const start = Number.isFinite(tpa.start) ? clamp(tpa.start, 0, 0.99) : 0.65;
  const amount = Number.isFinite(tpa.amount) ? clamp(tpa.amount, 0, 0.6) : 0.35;
  const throttle = Number.isFinite(thr) ? thr : 0;
  return 1 - amount * clamp((throttle - start) / Math.max(1 - start, 1e-3), 0, 1);
}
/**
 * Mirror a craft's thrust exponent into `settings.throttleCurve`. Writes only
 * when the value actually differs, so the settings store (and its listeners)
 * is undisturbed when the seed already matches — e.g. main.js called
 * loadAirframeProfile() first. Guards the exponent the same way sanitize()
 * does; a malformed spec leaves the last-good value alone.
 */
function seedThrottleCurve(spec) {
  const k = Number.isFinite(spec?.thrustExponent) ? clamp(spec.thrustExponent, 1, 2.5) : NaN;
  if (!Number.isFinite(k)) return;
  if (settings.get('throttleCurve') !== k) settings.set('throttleCurve', k);
}

/** Deterministic pseudo-random noise in [0,1), seeded by an integer step
 *  counter. Cheap and reproducible — no RNG state to manage or reset. */
function fractSinNoise(step) {
  const x = Math.sin(step * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Angle-mode attitude loop gain.
 *
 * This is the outer loop of a cascade, so it must be comfortably slower than
 * the rate loop it drives — otherwise the two fight and the quad hunts. The
 * rate loops settle in 22-30 ms; 6.0 gives the attitude loop a ~170 ms time
 * constant, a healthy separation on every airframe.
 */
const ANGLE_P = 6.0;               // 1/s

/** Angle mode never commands the full acro rate — it would slam into the cap. */
const ANGLE_MAX_RATE = 360 * Math.PI / 180;   // rad/s

/**
 * Time constant for the voltage the cutoff logic watches.
 *
 * Long enough that a punch-out sag rides straight through it, short enough that
 * a genuinely flat pack still cuts within a couple of seconds.
 */
const BATTERY_FILTER_TAU = 1.5;   // s

/* --- Crash handling ------------------------------------------------------ */
const CRASH_IMPACT_SPEED = 6.0;    // m/s along the contact normal
// 6 m/s is a ~1.8 m free fall. Below that, real quads bounce and keep
// flying, and treating every knock as a crash makes the sim exhausting.
const CRASH_LOCKOUT = 1.5;         // s of ignored input after a crash
const TURTLE_DURATION = 1.5;       // s of righting torque before we give up

export const FLIGHT_MODES = ['angle', 'horizon', 'acro'];

export class DroneController {
  /**
   * @param {import('./PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(physics, airframeId = DEFAULT_DRONE_TYPE) {
    this.physics = physics;

    /** The active airframe. Every mass, size, thrust, drag and gain figure in
     *  this class reads from here — see DroneTypes.js. */
    this.spec = getAirframe(airframeId);
    // Mirror the craft's thrust exponent into settings so _motorThrust reads
    // the right curve even when the craft is adopted directly (tests, respawn
    // paths) rather than through settings.loadAirframeProfile(). Same value
    // that flow writes, so this is a no-op there — and a pilot trim is only
    // ever clobbered by switching craft, exactly like the rates profile.
    seedThrottleCurve(this.spec);

    /* ---- state ---- */
    this.armed = false;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = 0;
    this.batteryCharge = 1;
    this.batteryVoltage = this.spec.battery.FULL;
    this.motorRPM = [0, 0, 0, 0];   // per-motor spool state (0..1 of command)
    this._vRest = this.spec.battery.FULL;  // unloaded pack voltage
    this._vScale = 1;                // thrust scale from terminal voltage
    this._vFiltered = NaN;           // filtered volts for cutoff decisions
    this.packCurrent = 0;            // A, for the HUD
    this.motorCutByBattery = false;
    this.throttleEverApplied = false;   // gates the Time Trial clock
    this.consumedMah = 0;               // mAh drawn from the pack this flight
    this.flightTime = 0;                // s since arming (resets on respawn)
    this.powerScale = 1;                // motor power-limit multiplier (1 = free)

    /** Populated each substep; read by the HUD and the audio engine. */
    this.motors = [0, 0, 0, 0];        // FL, FR, RL, RR in 0..1
    this.avgMotor = 0;
    this.telemetry = {
      speed: 0, altitude: 0, verticalSpeed: 0,
      rollDeg: 0, pitchDeg: 0, headingDeg: 0,
      gForce: 1, mahDrawn: 0, mahCapacity: 1000, mahPercent: 1,
      flightTime: 0, powerLimited: false,
    };

    /* ---- spawn ---- */
    this.spawnPoint = new THREE.Vector3(0, 1.2, 0);
    this.spawnHeading = 0;             // radians about world Y
    this.groundLevel = 0;              // for AGL altitude readout

    /* ---- wind (Field map) ---- */
    this.windEnabled = false;
    this.windDirection = new THREE.Vector3(1, 0, 0.35).normalize();
    // Wind is a pressure; each airframe multiplies by its own frontal area.
    // That is what makes a 23 g whoop unflyable in a breeze that a 5" barely
    // notices — the force ratio is ~3:1 but the mass ratio is ~28:1.
    this.windPressure = WIND_PRESSURE;
    this._windPhase = 0;

    /* ---- aerodynamics: propwash + turbulence state ---- */
    this._washV = 0;                   // low-pass of body-frame vertical velocity
    this._washPhase = 0;
    this._washRateNoise = 0;           // injected into _readBodyRates while in own wash
    this._washAxis = [0, 0, 0];         // per-axis wash turbulence (roll, pitch, yaw)
    this._inflowScale = 1;              // prop thrust fraction left after axial inflow
    this._turb = [0, 0, 0];            // low-passed turbulence per world axis
    this._windStep = 0;                // deterministic pseudo-noise counter

    /* ---- PID integrators / derivative memory ---- */
    this._i = { roll: 0, pitch: 0, yaw: 0 };
    this._prevRate = { roll: 0, pitch: 0, yaw: 0 };
    this._dLpf = { roll: 0, pitch: 0, yaw: 0 };

    /* ---- FC realism: feedforward, gyro noise, crash damage ---- */
    this._prevSP = { roll: 0, pitch: 0, yaw: 0 };  // for feedforward d/dt of setpoint
    this._gyroN = { roll: 0, pitch: 0, yaw: 0 };   // low-passed synthetic gyro noise
    this._gyroStep = 0;                             // deterministic pseudo-noise counter
    this.damage = 0;                                // 0..1, accumulated crash damage

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
    // Arm-tip positions, in the order FL, FR, RL, RR (-Z is forward).
    // Populated from the airframe by _applyArmGeometry().
    this._motorOffsets = [
      new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3(),
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
   * Airframe switching
   * ====================================================================== */

  /**
   * Swap to a different airframe in place.
   *
   * The collider shape, mass, damping, arm geometry and visual mesh all change,
   * so the cleanest route is to tear the body and mesh down and rebuild. The
   * caller is expected to respawn afterwards; `main.js` does.
   */
  setAirframe(airframeId) {
    const next = getAirframe(airframeId);
    if (next === this.spec) return false;

    const parent = this.object3d?.parent || null;

    this._disposeMesh();
    this.physics.removeBody(this.body);

    this.spec = next;
    seedThrottleCurve(this.spec);
    this._buildBody();
    this._buildMesh();

    if (parent) parent.add(this.object3d);

    // A fresh pack with the new chemistry, and no stale controller state.
    this.batteryCharge = 1;
    this.batteryVoltage = this.spec.battery.FULL;
    this.motorRPM = [0, 0, 0, 0];
    this._vRest = this.spec.battery.FULL;
    this._vScale = 1;
    this.motorCutByBattery = false;
    this._batteryStage = 'ok';
    this.consumedMah = 0;
    this.flightTime = 0;
    this.powerScale = 1;
    this._prevSP.roll = 0; this._prevSP.pitch = 0; this._prevSP.yaw = 0;

    return true;
  }

  /** Arm-tip offsets for the current airframe. */
  _applyArmGeometry() {
    const a = this.spec.arm;
    this._motorOffsets[0].set(-a, 0, -a);   // FL
    this._motorOffsets[1].set(+a, 0, -a);   // FR
    this._motorOffsets[2].set(-a, 0, +a);   // RL
    this._motorOffsets[3].set(+a, 0, +a);   // RR
  }

  /* ====================================================================== *
   * Construction
   * ====================================================================== */

  _buildBody() {
    this._applyArmGeometry();

    const [bw, bh, bd] = this.spec.body;
    this.body = new CANNON.Body({
      mass: this.spec.mass,
      shape: new CANNON.Box(new CANNON.Vec3(bw / 2, bh / 2, bd / 2)),
      material: this.physics.droneMaterial,
      linearDamping: 0.03,     // residual only; real drag is applied as a force
      // Rotational settling on top of the PID. Ducted micros damp hard; a race
      // quad barely damps at all and has to be stopped by the pilot.
      angularDamping: this.spec.angularDamping,
      collisionFilterGroup: GROUP.DRONE,
      collisionFilterMask: GROUP.WORLD | GROUP.PROP,
    });
    this.body.isDrone = true;
    // The world allows sleeping for the benefit of static level geometry; the
    // quad must never sleep or applyLocalForce would silently do nothing.
    this.body.allowSleep = false;
    this.body.position.set(0, 1.2, 0);

    this.body.addEventListener('collide', (e) => this._onCollide(e));

    this.physics.addBody(this.body);
    this.physics.protect(this.body);
  }

  /**
   * A procedural airframe sized from the spec. Invisible in FPV (that is the
   * whole point of first-person view) but needed for the chase and cinematic
   * cameras, and for the model shown on the selection screen.
   *
   * The whoop gets prop ducts, which is most of what makes it recognisable at
   * a glance; the other two get bare arms and exposed props.
   */
  _buildMesh() {
    const v = this.spec.visual;
    const arm = this.spec.arm;
    const [bw, bh, bd] = this.spec.body;

    this.object3d = new THREE.Group();
    this.object3d.name = 'drone';

    const carbonTex = paintedMetalTexture(51, [1, 1], [42, 44, 48]);
    const carbon = new THREE.MeshStandardMaterial({
      color: v.bodyColor, roughness: 0.62, metalness: 0.25, map: carbonTex,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: v.accentColor, roughness: 0.4, metalness: 0.1,
      emissive: v.accentColor, emissiveIntensity: 0.45,
    });
    const motorMat = new THREE.MeshStandardMaterial({
      color: v.motorColor, roughness: 0.35, metalness: 0.85,
    });
    this._materials = [carbon, accent, motorMat];
    this._textures = [carbonTex];
    this._geometries = [];

    const track = (geo) => { this._geometries.push(geo); return geo; };

    // Centre stack, proportioned to the frame rather than fixed in metres.
    const plate = new THREE.Mesh(
      track(new THREE.BoxGeometry(bw * 0.42, bh * 0.45, bd * 0.55)), carbon,
    );
    this.object3d.add(plate);

    const canopy = new THREE.Mesh(
      track(new THREE.BoxGeometry(bw * 0.28, bh * 0.55, bd * 0.25)), accent,
    );
    canopy.position.set(0, bh * 0.42, -bd * 0.09);
    this.object3d.add(canopy);

    // Arms, motors, props.
    this.propMeshes = [];
    const armGeo = track(new THREE.BoxGeometry(arm * 0.19, arm * 0.09, arm * 1.28));
    const motorGeo = track(new THREE.CylinderGeometry(
      v.propRadius * 0.22, v.propRadius * 0.24, v.propRadius * 0.30, 10,
    ));
    const propGeo = track(new THREE.BoxGeometry(
      v.propRadius * 2, v.propRadius * 0.028, v.propRadius * 0.17,
    ));
    const ductGeo = v.ducted
      ? track(new THREE.TorusGeometry(v.propRadius * 1.08, v.propRadius * 0.12, 6, 18))
      : null;

    for (let i = 0; i < 4; i++) {
      const sx = i === 0 || i === 2 ? -1 : 1;   // FL/RL are on -X
      const sz = i < 2 ? -1 : 1;                // FL/FR are on -Z

      const a = new THREE.Mesh(armGeo, carbon);
      a.position.set(sx * arm * 0.55, 0, sz * arm * 0.55);
      a.rotation.y = sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4;
      this.object3d.add(a);

      const motor = new THREE.Mesh(motorGeo, motorMat);
      motor.position.set(sx * arm, bh * 0.24, sz * arm);
      this.object3d.add(motor);

      const prop = new THREE.Mesh(propGeo, carbon);
      prop.position.set(sx * arm, bh * 0.44, sz * arm);
      this.object3d.add(prop);
      this.propMeshes.push(prop);

      if (ductGeo) {
        const duct = new THREE.Mesh(ductGeo, accent);
        duct.position.set(sx * arm, bh * 0.44, sz * arm);
        duct.rotation.x = Math.PI / 2;   // torus lies in XY; lay it flat
        this.object3d.add(duct);
      }
    }

    this._propSpin = 0;

    // The drone grounds itself with a real shadow in chase/cinematic views
    // (invisible in FPV, where the body is hidden anyway). One small object.
    this.object3d.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  }

  /** Release the mesh's GPU resources. Used by setAirframe() and dispose(). */
  _disposeMesh() {
    try {
      this.object3d?.parent?.remove(this.object3d);
      for (const g of this._geometries || []) g?.dispose?.();
      for (const m of this._materials || []) m?.dispose?.();
      for (const t of this._textures || []) t?.dispose?.();
    } catch (_e) { /* teardown must never throw */ }
    this._geometries = [];
    this._materials = [];
    this._textures = [];
    this.propMeshes = [];
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
    this._prevSP.roll = 0; this._prevSP.pitch = 0; this._prevSP.yaw = 0;
    this.damage = 0;
    this._inflowScale = 1;
    this._washAxis[0] = this._washAxis[1] = this._washAxis[2] = 0;

    this.motors = [0, 0, 0, 0];
    this.avgMotor = 0;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = 0;
    this.throttleEverApplied = false;

    if (resetBattery) {
      this.batteryCharge = 1;
      this.batteryVoltage = this.spec.battery.FULL;
      this._vRest = this.spec.battery.FULL;
      this._vScale = 1;
      this.motorCutByBattery = false;
      this._batteryStage = 'ok';
      this._vFiltered = NaN;
      // Every respawn is a fresh pack off the charger: charge, mAh counter,
      // flight timer, and power-limit state all start over. Landing with 40%
      // left and pressing R must not inherit the old pack's sag.
      this.consumedMah = 0;
      this.flightTime = 0;
      this.powerScale = 1;
    }
    this.motorRPM = [0, 0, 0, 0];

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
      this._prevSP.roll = 0; this._prevSP.pitch = 0; this._prevSP.yaw = 0;
      this.motors = [0, 0, 0, 0];
      this.motorRPM = [0, 0, 0, 0];
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
      const impact = Math.abs(contact.getImpactVelocityAlongNormal());
      if (!Number.isFinite(impact)) return;
      this.registerImpact(impact);
    } catch (err) {
      console.warn('[DroneController] collide handler failed', err);
    }
  }

  /**
   * Classify an impact speed into destroyed / hard / graze.
   *
   * Shared by the contact-event path (_onCollide) and the swept-collision
   * guard path (main.js forwards `sanitizeBody().impactSpeed` here). The
   * second path matters: the sweep parks a tunneling body at the surface and
   * kills its inbound velocity, so by the time the contact solver sees it the
   * impact reads as a gentle touch. Without this, a 40 m/s wall hit that the
   * sweep caught would stop dead with no crash, no disarm, and no sound.
   */
  registerImpact(speed) {
    try {
      const impact = Number.isFinite(speed) ? speed : 0;
      if (!(impact > 0) || this.crashed) return;

      if (impact >= CRASH_IMPACT_SPEED) {
        this.crashed = true;
        this.crashTimer = CRASH_LOCKOUT;
        this.setArmed(false);
        this.motors = [0, 0, 0, 0];
        this.avgMotor = 0;
        this.damage = clamp((Number.isFinite(this.damage) ? this.damage : 0) + 0.25, 0, 1);
        if (typeof this.onCrash === 'function') this.onCrash(impact, 'destroyed');
      } else if (impact >= 2.5) {
        // Hard knock: a brief input dip while the frame settles, but no
        // disarm — real pilots clip a gate post and keep flying.
        this.crashed = true;
        this.crashTimer = 0.4;
        if (typeof this.onCrash === 'function') this.onCrash(impact, 'hard');
      } else {
        // Graze: a wall tap that barely registers — audio only, no state change.
        if (typeof this.onCrash === 'function') this.onCrash(impact, 'graze');
      }
    } catch (err) {
      console.warn('[DroneController] impact handler failed', err);
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
    this._v2.set(0, this.spec.weight * 1.15, 0);
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
    this._updateInflow();
    this._updateBattery(dt, thr);

    if (!this.armed || this.motorCutByBattery) {
      this.motors[0] = this.motors[1] = this.motors[2] = this.motors[3] = 0;
      this.motorRPM[0] = this.motorRPM[1] = this.motorRPM[2] = this.motorRPM[3] = 0;
      this.avgMotor = 0;
    } else {
      this._flightControl(dt, thr, cmdPitch, cmdRoll, cmdYaw);
    }

    this._applyAerodynamics();
    this._applyGroundEffect();
    this._applyPropwash(dt);
    this._applyTranslationalLift();
    this._applyInducedDrag();
    if (this.windEnabled) this._applyWind(dt);

    this._updateTelemetry();

    if (settings.get('blackbox') === true) {
      try {
        blackbox.push({
          t: performance.now() / 1000,
          thr, pitch: cmdPitch, roll: cmdRoll, yaw: cmdYaw,
          spRoll: this._prevSP.roll, spPitch: this._prevSP.pitch, spYaw: this._prevSP.yaw,
          m0: this.motors[0], m1: this.motors[1], m2: this.motors[2], m3: this.motors[3],
          vbat: this.batteryVoltage,
          gyroR: this._prevRate.roll, gyroP: this._prevRate.pitch, gyroY: this._prevRate.yaw,
        });
      } catch (_e) { /* blackbox failure must never break flight */ }
    }
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
  _readBodyRates(out, dt = 1 / 240) {
    this.body.quaternion.conjugate(this._invQ);
    this._invQ.vmult(this.body.angularVelocity, this._localAV);

    // Negations map cannon's right-handed axes onto the stick convention:
    // +ωx is nose-up but +pitch is nose-down, and likewise for roll and yaw.
    out.pitch = -this._localAV.x;
    out.yaw = -this._localAV.y;
    out.roll = -this._localAV.z;

    // Propwash-induced rate noise: injected here (not into physics angular
    // velocity) so the PID fights it exactly like real gyro turbulence.
    // Each axis gets its own turbulence (a real wash buffets roll and pitch
    // independently, and yaw far less), not one shared wobble.
    const wa = this._washAxis;
    out.roll += Number.isFinite(wa[0]) ? wa[0] : 0;
    out.pitch += Number.isFinite(wa[1]) ? wa[1] : 0;
    out.yaw += Number.isFinite(wa[2]) ? wa[2] : 0;

    // Synthetic gyro noise: a real FC's D-term filters exactly this kind of
    // sensor noise, so injecting it here (rather than skipping it) is what
    // makes the D filter and gyro filter settings actually matter. Damage
    // raises the noise floor — a bent prop shakes the frame harder.
    const dmg = Number.isFinite(this.damage) ? clamp(this.damage, 0, 1) : 0;
    const sigma = 0.015 * (1 + dmg * 3);
    const alpha = dLpfAlpha(Number.isFinite(dt) && dt > 0 ? dt : 1 / 240);
    for (const axis of ['roll', 'pitch', 'yaw']) {
      this._gyroStep = (this._gyroStep + 1) % 1e6;
      const hash = fractSinNoise(this._gyroStep);
      const white = (hash - 0.5) * 2 * sigma;
      let n = this._gyroN[axis] + alpha * (white - this._gyroN[axis]);
      if (!Number.isFinite(n)) n = 0;
      this._gyroN[axis] = n;
      out[axis] += n;
    }
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

    const rp = settings.get('rateProfile') || {};
    const rRoll = rp.roll || { rcRate: 1, superRate: 0.75, expo: 0 };
    const rPitch = rp.pitch || { rcRate: 1, superRate: 0.75, expo: 0 };
    const rYaw = rp.yaw || { rcRate: 1, superRate: 0.65, expo: 0 };
    const useLegacy = !!rp.useLegacy;
    // Betaflight Actual Rates (default since BF 4.3): center sensitivity and
    // max rate are independent, expo shifts the kink. Community presets
    // (Velocidrone/Liftoff parity, race, cinematic) live in Settings.js.
    const rateMode = settings.get('rateMode') === 'actual' ? 'actual' : 'betaflight';
    const ap = settings.get('actualProfile') || {};
    const aRoll = ap.roll || { center: 90, expo: 0.4 };
    const aPitch = ap.pitch || { center: 90, expo: 0.4 };
    const aYaw = ap.yaw || { center: 110, expo: 0.35 };
    const rateFor = (cmd, bf, actual, maxRate) => {
      if (useLegacy) return cmd * maxRate;
      if (rateMode === 'actual') {
        return actualRates(cmd, deg2rad(actual.center), maxRate, actual.expo);
      }
      return betaflightRate(cmd, bf.rcRate, bf.superRate, bf.expo, maxRate);
    };

    // --- 1. rate setpoints --------------------------------------------
    let spRoll, spPitch;
    const spYaw = rateFor(cmdYaw, rYaw, aYaw, maxYaw);

    const acroPitch = rateFor(cmdPitch, rPitch, aPitch, maxPitch);
    const acroRoll = rateFor(cmdRoll, rRoll, aRoll, maxRoll);

    if (mode === 'angle' || mode === 'horizon') {
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
      const anglePitch = clamp(ANGLE_P * (cmdPitch * maxTilt - pitchNow), -capPitch, capPitch);
      const angleRoll = clamp(ANGLE_P * (cmdRoll * maxTilt - rollNow), -capRoll, capRoll);

      if (mode === 'horizon') {
        // Horizon: blend the self-levelling angle response with the acro
        // rate response, weighted toward acro as the stick moves off centre
        // — full deflection behaves like acro, centred sticks self-level.
        const hb = Number.isFinite(settings.get('horizonBlend'))
          ? clamp(settings.get('horizonBlend'), 0, 1) : 0.5;
        const blendFor = (cmd) => {
          const a = Math.abs(cmd);
          let b = clamp(a / 0.5, 0, 1) * hb + (a > 0.85 ? 1 : 0);
          return clamp(b, 0, 1);
        };
        const bPitch = blendFor(cmdPitch);
        const bRoll = blendFor(cmdRoll);
        spPitch = (1 - bPitch) * anglePitch + bPitch * acroPitch;
        spRoll = (1 - bRoll) * angleRoll + bRoll * acroRoll;
      } else {
        spPitch = anglePitch;
        spRoll = angleRoll;
      }
    } else {
      // Acro: the stick *is* the rate command. Nothing self-levels, so the
      // quad holds whatever attitude the pilot leaves it in.
      spPitch = acroPitch;
      spRoll = acroRoll;
    }

    // --- 2. rate PID ---------------------------------------------------
    this._readBodyRates(RATE_SCRATCH, dt);

    const ffRoll = spRoll - this._prevSP.roll;
    const ffPitch = spPitch - this._prevSP.pitch;
    const ffYaw = spYaw - this._prevSP.yaw;
    this._prevSP.roll = Number.isFinite(spRoll) ? spRoll : 0;
    this._prevSP.pitch = Number.isFinite(spPitch) ? spPitch : 0;
    this._prevSP.yaw = Number.isFinite(spYaw) ? spYaw : 0;

    // TPA: bleed off P/D authority at high throttle, where a quad is already
    // at its most authoritative and prone to overshoot. Applied to the P and
    // D terms inside _pidAxis — I and feedforward hold, so altitude and stick
    // anticipation survive the cutoff. Yaw passes 1.0 (unattenuated), as before.
    const tpaFactor = tpaFactorFor(thr);
    let mixRoll = this._pidAxis('roll', spRoll, RATE_SCRATCH.roll, dt, ffRoll, tpaFactor);
    let mixPitch = this._pidAxis('pitch', spPitch, RATE_SCRATCH.pitch, dt, ffPitch, tpaFactor);
    const mixYaw = this._pidAxis('yaw', spYaw, RATE_SCRATCH.yaw, dt, ffYaw);

    // --- 3. X-frame motor mix -----------------------------------------
    const damageYaw = mixYaw + (Number.isFinite(this.damage) ? this.damage : 0) * 0.15;
    this._mix(thr, mixPitch, mixRoll, damageYaw);

    // --- 4. motor spool + thrust --------------------------------------
    // Real ESCs + motors cannot change RPM instantly: each motor chases its
    // mixed command through a first-order lag (motorTau), and the thrust it
    // produces sags with terminal voltage (vScale^2 — thrust goes as RPM^2
    // and RPM goes roughly linearly with volts).
    // Props spool down slower than they spool up: an ESC can drive a motor
    // hard but only brakes it gently (and not at all without damped light),
    // so chopping throttle leaves a short tail of thrust.
    const upAlpha = dt / (dt + this.spec.motorTau);
    const downAlpha = dt / (dt + this.spec.motorTau * 1.6);
    for (let i = 0; i < 4; i++) {
      const spoolAlpha = this.motors[i] >= this.motorRPM[i] ? upAlpha : downAlpha;
      let rpm = this.motorRPM[i] + (this.motors[i] - this.motorRPM[i]) * spoolAlpha;
      if (!Number.isFinite(rpm)) rpm = 0;
      this.motorRPM[i] = rpm < 0 ? 0 : rpm > 1 ? 1 : rpm;
      const f = this._motorThrust(this.motorRPM[i], this._vScale);
      if (f <= 0) continue;
      this._forceVec.set(0, f, 0);
      this.body.applyLocalForce(this._forceVec, this._motorOffsets[i]);
    }

    // --- 5. yaw reaction torque ---------------------------------------
    // Spinning props drag air; the frame feels the equal-and-opposite twist.
    // Authority scales with motor load because a quad at idle barely yaws.
    const authority = 0.35 + 0.65 * this.avgMotor;
    const localTorqueY = -mixYaw * this.spec.yawTorque * authority;
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
  _pidAxis(axis, setpoint, measured, dt, ffDelta = 0, tpaFactor = 1) {
    const gains = this.spec.pid[axis];
    // Pilot PID trims: per-term multipliers on the derived gains (0..2,
    // 1 = the airframe tune). Guarded individually so one poisoned term
    // cannot take the whole axis down — it just flies untrimmed.
    const scale = settings.get('pidScale') || {};
    const kp = gains.p * (Number.isFinite(scale.p) ? clamp(scale.p, 0, 2) : 1);
    const ki = gains.i * (Number.isFinite(scale.i) ? clamp(scale.i, 0, 2) : 1);
    const kd = gains.d * (Number.isFinite(scale.d) ? clamp(scale.d, 0, 2) : 1);
    // TPA attenuates P and D only — the I term holds altitude through the
    // cutoff instead of sagging, and feedforward (below) stays anticipatory.
    const tpa = Number.isFinite(tpaFactor) ? clamp(tpaFactor, 0, 1) : 1;
    const error = setpoint - measured;
    const iMax = I_LIMIT / Math.max(ki, 1e-6);
    // Derivative on the *measurement*, low-pass filtered. Differentiating the
    // error instead would spike every time the pilot slams a stick
    // ("derivative kick"); leaving it unfiltered would oscillate (see D_LPF).
    const rawD = (measured - this._prevRate[axis]) / dt;
    this._prevRate[axis] = measured;
    if (Number.isFinite(rawD)) {
      this._dLpf[axis] += dLpfAlpha(dt) * (rawD - this._dLpf[axis]);
    }
    if (!Number.isFinite(this._dLpf[axis])) this._dLpf[axis] = 0;
    const dTerm = kd * this._dLpf[axis];

    // Provisional integration.
    const prevI = this._i[axis];
    let integral = clamp(prevI + error * dt, -iMax, iMax);
    if (!Number.isFinite(integral)) integral = 0;

    let out = kp * error * tpa + ki * integral - dTerm * tpa;

    // Conditional integration (anti-windup): if the output is already clipped
    // and the error is pushing it further past the rail, integrating does
    // nothing except store up a correction that has to be unwound later — the
    // classic cause of a control loop that lags long after the stick centred.
    if (Math.abs(out) > 1 && Math.sign(out) === Math.sign(error)) {
      integral = prevI;
      out = kp * error * tpa + ki * integral - dTerm * tpa;
    }

    this._i[axis] = integral;
    if (!Number.isFinite(out)) out = 0;

    // Feedforward: a term proportional to how fast the *setpoint* is moving,
    // not the error — it anticipates a stick move instead of waiting for the
    // rate loop to notice the quad hasn't caught up yet.
    const ff = Number.isFinite(settings.get('feedforward')) ? clamp(settings.get('feedforward'), 0, 1) : 0.35;
    const tauAxis = axis === 'yaw' ? 0.079 : (Number.isFinite(this.spec.tau) ? this.spec.tau : 0.028);
    const safeDt = Math.max(dt, 1e-4);
    const ffTerm = Number.isFinite(ffDelta) ? ff * (ffDelta / safeDt) * tauAxis * 0.5 : 0;
    if (Number.isFinite(ffTerm)) out += ffTerm;
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
    if (settings.get('airmode') === false) {
      // Airmode off: naive per-motor clamp. Authority collapses at full
      // throttle exactly like a real quad with airmode disabled — this is
      // the historically accurate "bad" behavior, kept as an opt-out.
      const fl = throttle + (-pitch + roll - yaw);
      const fr = throttle + (-pitch - roll + yaw);
      const rl = throttle + (+pitch + roll + yaw);
      const rr = throttle + (+pitch - roll - yaw);
      this.motors[0] = clamp(fl, 0, 1);
      this.motors[1] = clamp(fr, 0, 1);
      this.motors[2] = clamp(rl, 0, 1);
      this.motors[3] = clamp(rr, 0, 1);
      this.avgMotor = (this.motors[0] + this.motors[1] + this.motors[2] + this.motors[3]) * 0.25;
      if (!Number.isFinite(this.avgMotor)) this.avgMotor = 0;
      this._applyDamageCap();
      return;
    }

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
    this._applyDamageCap();
  }

  /**
   * Bent-prop crash damage caps the top of the throttle range — scaling the
   * mixed motor commands before they enter the spool loop is equivalent to
   * capping thrust (the thrust curve is monotonic in command) without
   * touching the spool/thrust pipeline itself.
   */
  _applyDamageCap() {
    const damage = Number.isFinite(this.damage) ? clamp(this.damage, 0, 1) : 0;
    if (damage <= 0) return;
    const capScale = 1 - damage * 0.2;
    for (let i = 0; i < 4; i++) {
      this.motors[i] *= capScale;
    }
    this.avgMotor *= capScale;
    if (!Number.isFinite(this.avgMotor)) this.avgMotor = 0;
  }

  /**
   * Convert a motor *command* (0..1) into thrust in newtons.
   *
   *   thrust = thrustMax * (idle + (1 - idle) * command) ^ k
   *
   * Two things are happening. The idle offset models a real ESC's DShot idle:
   * armed props never stop, which both sounds right and — more importantly —
   * keeps the curve off its flat region near zero, where attitude authority
   * would otherwise collapse the instant the pilot chopped throttle.
   *
   * The exponent is the real physics: propeller thrust goes as the square of
   * RPM while an ESC maps its command roughly linearly onto RPM, so thrust is
   * markedly non-linear in the command. Modelling it as linear (as this file
   * originally did) makes the bottom of the throttle range far too strong.
   * It is also what puts hover at 30% of the stick on the racer and 55% on the
   * whoop, which is most of what makes the three feel different.
   */
  _motorThrust(command, voltageScale = 1) {
    if (!Number.isFinite(command) || command <= 0) return 0;
    const spec = this.spec;
    const c = command > 1 ? 1 : command;
    const effective = spec.motorIdle + (1 - spec.motorIdle) * c;
    const vs = Number.isFinite(voltageScale) ? voltageScale : 1;
    // Tunable thrust-curve exponent, seeded from the active craft whenever it
    // is adopted (constructor/setAirframe/loadAirframeProfile), so the default
    // is exactly the airframe's own exponent and stock physics are untouched.
    // Garbage falls back to the spec value, never NaN.
    const tc = settings.get('throttleCurve');
    const k = Number.isFinite(tc) ? clamp(tc, 1, 2.5)
      : (Number.isFinite(spec.thrustExponent) ? spec.thrustExponent : 1.85);
    // Prop deformation under load (Velocidrone 2025 added the same): blades
    // flex and lose a little bite at full demand — up to ~3% at full stick,
    // a fraction of a percent at hover, so hover and cruise never notice it
    // but punch-outs stop feeling artificially perfect.
    const deform = 1 - 0.03 * c * c * c;
    const inflow = Number.isFinite(this._inflowScale) ? this._inflowScale : 1;
    return spec.motorMaxThrust * Math.pow(effective, k) * vs * vs * deform * inflow;
  }

  /**
   * Axial inflow loss (advance ratio). A propeller's thrust falls as the air
   * arriving at the disc speeds up toward the prop's pitch speed, reaching
   * zero somewhat above it. That is what really caps a quad's top speed and
   * makes a punch-out go soft as it builds speed; a static-thrust model keeps
   * pulling just as hard at 40 m/s as in a hover.
   *
   * Modelled on the body-up component of velocity (air flowing down through
   * the disc), against the pitch speed at the current average RPM. Descending
   * into the disc (negative inflow) is left at static thrust.
   */
  _updateInflow() {
    const v = this.body.velocity;
    const spec = this.spec;
    if (!isFiniteVec(v) || !Number.isFinite(spec.propPitchM) || !Number.isFinite(spec.motorMaxRPM)) {
      this._inflowScale = 1;
      return;
    }
    const axial = v.x * this._up.x + v.y * this._up.y + v.z * this._up.z;
    if (!(axial > 0)) { this._inflowScale = 1; return; }
    const rpm = (this.motorRPM[0] + this.motorRPM[1] + this.motorRPM[2] + this.motorRPM[3]) * 0.25;
    const eff = spec.motorIdle + (1 - spec.motorIdle) * clamp(rpm, 0, 1);
    // Zero-thrust inflow sits ~25 % above geometric pitch speed.
    const vZero = Math.max(3, (spec.motorMaxRPM / 60) * eff * spec.propPitchM * 1.25);
    const loss = 0.4 * clamp(axial / vZero, 0, 1);
    this._inflowScale = Number.isFinite(loss) ? 1 - loss : 1;
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
      -this.spec.dragLateral * Math.abs(lx) * lx,
      -this.spec.dragVertical * Math.abs(ly) * ly,
      -this.spec.dragLateral * Math.abs(lz) * lz,
    );

    this.body.quaternion.vmult(this._v1, this._v2);
    // NOTE: applyForce's second argument is an offset *relative to the centre
    // of mass*, not a world position. Passing body.position here would apply
    // drag on a lever arm equal to the altitude, generating a phantom torque
    // that grows as you climb — and silently cancels roll authority.
    if (isFiniteVec(this._v2)) this.body.applyForce(this._v2);
  }

  /** Sum of current per-motor thrust, in newtons — used by ground-effect and
   *  translational-lift, both of which scale the *existing* thrust rather
   *  than invent a new force from nothing. */
  _totalThrust() {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += this._motorThrust(this.motorRPM[i], this._vScale);
    return Number.isFinite(sum) ? sum : 0;
  }

  /**
   * Ground effect: within a few prop radii of the floor, downwash recirculates
   * off the surface instead of escaping, and the disc effectively gets more
   * lift for the same thrust. Real pilots feel this as a "floaty" low hover
   * and a sudden sink climbing out past ~4 radii.
   */
  _applyGroundEffect() {
    if (!this.armed) return;
    const R = this.spec.visual?.propRadius;
    if (!Number.isFinite(R) || R <= 0) return;

    const agl = this.body.position.y - this.groundLevel;
    if (!Number.isFinite(agl)) return;
    const span = 4 * R;
    if (agl >= span) return;

    const cosTilt = clamp(this._up.y, 0, 1);
    const frac = clamp(1 - agl / span, 0, 1);
    const boost = 1 + 0.18 * Math.pow(frac, 1.5) * cosTilt;

    const totalThrust = this._totalThrust();
    const extra = totalThrust * (boost - 1);
    if (!Number.isFinite(extra) || extra === 0) return;

    this._v1.set(0, extra, 0);
    if (isFiniteVec(this._v1)) this.body.applyForce(this._v1);
  }

  /**
   * Propwash: descending back into your own downwash recirculates momentum
   * instead of shedding it, which adds an extra sink and a body-rate wobble.
   * The wobble is injected into the *measurement* the PID sees (_readBodyRates),
   * not the physics angular velocity, so it reads exactly like the turbulent
   * gyro noise a real FC fights rather than a scripted physics kick.
   */
  _applyPropwash(dt) {
    const vel = this.body.velocity;
    if (!isFiniteVec(vel)) {
      this._washRateNoise = 0;
      this._washAxis[0] = this._washAxis[1] = this._washAxis[2] = 0;
      return;
    }

    this.body.quaternion.conjugate(this._invQ);
    this._invQ.vmult(vel, this._localVel);

    const alpha = dt / (dt + 0.25);
    const ly = Number.isFinite(this._localVel.y) ? this._localVel.y : 0;
    const washV = (Number.isFinite(this._washV) ? this._washV : 0) + (ly - (Number.isFinite(this._washV) ? this._washV : 0)) * alpha;
    this._washV = Number.isFinite(washV) ? washV : 0;

    const phase = (Number.isFinite(this._washPhase) ? this._washPhase : 0) + dt * 37;
    this._washPhase = Number.isFinite(phase) ? phase : 0;

    const inWash = this.armed && this._localVel.y > 1.5 && this.avgMotor > 0.25 && this._up.y > 0.906;
    if (inWash) {
      const suck = Math.min(
        this.spec.dragVertical * 0.9 * this._washV * this._washV,
        0.35 * this.spec.weight,
      );
      if (Number.isFinite(suck) && suck > 0) {
        this._v1.set(0, -suck, 0);
        if (isFiniteVec(this._v1)) this.body.applyForce(this._v1);
      }
      const p = this._washPhase;
      const amp = this._washV * 0.06;
      this._washAxis[0] = Math.sin(p) * amp;
      this._washAxis[1] = Math.sin(p * 1.37 + 2.1) * amp;
      this._washAxis[2] = Math.sin(p * 0.71 + 4.3) * amp * 0.35;
      this._washRateNoise = this._washAxis[0];
    } else {
      this._washRateNoise = 0;
      this._washAxis[0] = this._washAxis[1] = this._washAxis[2] = 0;
    }
  }

  /**
   * Translational lift: clean forward-flight air is more efficient than a
   * hover, giving a small extra lift along body-up. Parasite drag is fully
   * covered by the per-axis quadratic drag in _applyAerodynamics() — adding
   * a second term here duplicated it and halved the fitted terminal speeds.
   */
  _applyTranslationalLift() {
    if (!this.armed) return;

    const forwardSpeed = -this._localVel.z;
    if (!Number.isFinite(forwardSpeed)) return;
    const totalThrust = this._totalThrust();
    const extraLift = totalThrust * 0.06 * Math.tanh(forwardSpeed / 8);
    if (!Number.isFinite(extraLift) || extraLift === 0) return;
    this._v1.set(0, extraLift, 0);
    this.body.quaternion.vmult(this._v1, this._v2);
    if (isFiniteVec(this._v2)) this.body.applyForce(this._v2);
  }

  /**
   * Induced drag: the price of making lift. A powered rotor accelerates air
   * downwards, and dragging the disc through the air costs extra force that
   * scales with thrust squared — which is why powered dives feel mushier than
   * the parasite-drag curve alone predicts, and why the old model felt floaty
   * coming down under power.
   *
   * Applied on the body-vertical axis only: in level flight vertical speed is
   * ~0 so cruise and top speed are untouched, while powered descents and
   * punch-outs pick up the extra damping a real disc produces.
   */
  _applyInducedDrag() {
    if (!this.armed) return;
    const vel = this.body.velocity;
    if (!isFiniteVec(vel)) return;

    this.body.quaternion.conjugate(this._invQ);
    this._invQ.vmult(vel, this._localVel);
    const vy = Number.isFinite(this._localVel.y) ? this._localVel.y : 0;
    if (vy === 0) return;

    const load = this._totalThrust() / this.spec.weight;
    if (!Number.isFinite(load) || load <= 0) return;
    // 0.3 keeps the effect honest but subordinate: a powered dive picks up
    // clear extra damping without the climb-rate tests noticing the difference
    // between a real disc and the parasite curve alone.
    const extra = this.spec.dragVertical * 0.3 * load * load * Math.abs(vy) * vy;
    if (!Number.isFinite(extra) || extra === 0) return;

    this._v1.set(0, -extra, 0);
    this.body.quaternion.vmult(this._v1, this._v2);
    if (isFiniteVec(this._v2)) this.body.applyForce(this._v2);
  }

  /**
   * Dryden-lite turbulent wind: a directional base speed plus two
   * irrational-ratio gust sines (never quite repeats) low-passed together
   * with deterministic per-substep pseudo-noise into a 3-axis turbulence
   * state. Force is proportional to *relative* airspeed (wind minus drone
   * velocity), not wind alone, so a quad flying with the wind feels nothing.
   */
  _applyWind(dt) {
    const speedSetting = settings.get('windSpeed');
    const baseSpeed = Number.isFinite(speedSetting) ? speedSetting : 2.5;
    const gustSetting = settings.get('windGust');
    const gustAmp = Number.isFinite(gustSetting) ? gustSetting : 0.5;

    const phase = (Number.isFinite(this._windPhase) ? this._windPhase : 0) + dt;
    this._windPhase = Number.isFinite(phase) ? phase : 0;

    const s = Math.sin(this._windPhase * 2 * Math.PI * 0.43) * 0.8
      + Math.sin(this._windPhase * 2 * Math.PI * 0.13 + 1.7) * 0.5;

    // Deterministic per-substep pseudo-noise — no Math.random, so a replayed
    // blackbox log reproduces the same gust.
    this._windStep = (Number.isFinite(this._windStep) ? this._windStep : 0) + 1;
    const hash = Math.sin(this._windStep * 12.9898) * 43758.5;
    const hashNoise = hash - Math.floor(hash);
    const white = (hashNoise - 0.5) * 0.5;

    // Low-pass the sine + noise drive at 2 Hz into a 3-axis turbulence vector.
    const turbAlpha = dt / (dt + 1 / (2 * Math.PI * 2));
    if (!Array.isArray(this._turb) || this._turb.length !== 3) this._turb = [0, 0, 0];
    const drive = white + s;
    for (let i = 0; i < 3; i++) {
      const t = this._turb[i] + (drive - this._turb[i]) * turbAlpha;
      this._turb[i] = Number.isFinite(t) ? t : 0;
    }

    const wd = this.windDirection;
    const windX = wd.x * baseSpeed + gustAmp * this._turb[0];
    const windY = gustAmp * this._turb[1];
    const windZ = wd.z * baseSpeed + gustAmp * this._turb[2];

    const vel = this.body.velocity;
    const relX = windX - (Number.isFinite(vel.x) ? vel.x : 0);
    const relY = windY - (Number.isFinite(vel.y) ? vel.y : 0);
    const relZ = windZ - (Number.isFinite(vel.z) ? vel.z : 0);

    // Force scales with frontal area; the acceleration it produces then
    // divides by mass, which is where the whoop's vulnerability comes from.
    // Vertical coupling is weak — wind mostly pushes sideways, not up/down.
    const f = this.windPressure * this.spec.windArea;
    if (!Number.isFinite(f)) return;
    this._v3.set(f * relX, f * 0.3 * relY, f * relZ);
    if (isFiniteVec(this._v3)) this.body.applyForce(this._v3);   // centre of mass — see _applyAerodynamics
  }

  /**
   * Per-chemistry LiPo model: charge drains with motor load (tracked as mAh
   * against the pack's real capacity), and terminal voltage is the resting
   * curve minus load sag. Sag is what makes a tired pack read fine at
   * idle and then dip into the warning band the moment you punch out.
   */
  _updateBattery(dt, throttle) {
    // Hover is the reference load; heavier throttle drains super-linearly.
    const load = this.armed ? Math.max(this.avgMotor, throttle * 0.6) : 0;
    const batt = this.spec.battery;
    const cap = (Number.isFinite(batt.CAPACITY_MAH) && batt.CAPACITY_MAH > 0)
      ? batt.CAPACITY_MAH : 1000;
    const hoverI = (Number.isFinite(batt.HOVER_CURRENT) && batt.HOVER_CURRENT >= 0)
      ? batt.HOVER_CURRENT : 5;
    const peak = Number.isFinite(batt.PEAK_CURRENT) ? batt.PEAK_CURRENT : 0;

    // Thrust-based current draw: idle sips, hover sips a little more, and a
    // punch-out drinks. Two regions — below hover thrust the motors are just
    // spinning (descents), above it the props bite super-linearly. A linear
    // `peak × avgMotor` model would claim 32 A in a 5 A hover; this one reads
    // ~5 A hovering and ~100 A punching, like the OSD on a real quad.
    if (!this.armed) {
      this.packCurrent = 0;
    } else {
      const tMax = this.spec.maxThrustTotal;
      const tNow = this._totalThrust();
      const idleI = 0.15 * hoverI;
      if (tNow >= this.spec.weight) {
        let x = (tNow - this.spec.weight) / Math.max(tMax - this.spec.weight, 1e-6);
        x = clamp(x, 0, 1);
        this.packCurrent = hoverI + (peak - hoverI) * Math.pow(x, 1.6);
      } else {
        const f = clamp(tNow / this.spec.weight, 0, 1);
        this.packCurrent = idleI + (hoverI - idleI) * f;
      }
      if (!Number.isFinite(this.packCurrent) || this.packCurrent < 0) this.packCurrent = 0;
    }

    // Charge follows the mAh counter, never a separate clock — the OSD's mAh
    // and % can never contradict each other, and a punch-heavy flight lands
    // sooner than a hovering one, exactly like real packs.
    if (this.packCurrent > 0) {
      this.consumedMah += (this.packCurrent * dt * 1000) / 3600;
      if (!Number.isFinite(this.consumedMah)) this.consumedMah = 0;
    }
    if (this.armed) this.flightTime += dt;
    this.batteryCharge = clamp(1 - this.consumedMah / cap, 0, 1);

    // Resting curve: fairly flat through the middle, knees hard at the end.
    const rest = batt.EMPTY + (batt.FULL - batt.EMPTY) * Math.pow(this.batteryCharge, 0.45);
    if (!Number.isFinite(rest)) this._vRest = batt.FULL;
    else this._vRest = rest;
    // Terminal voltage: resting curve minus ohmic drop (total pack current
    // through the pack resistance). Current is thrust-based (see above), so
    // the punch-out dip lands in the right band for each pack size.
    const packR = Number.isFinite(this.spec.packResistance) ? this.spec.packResistance : 0;

    // Ohmic drop only. The older `batt.SAG * avgMotor` term modelled the same
    // physics a second time, and the two together pulled a healthy pack below
    // its cutoff the instant the throttle went to full — which cut the motors
    // and made the quad undroppable-but-unflyable.
    const sag = this.packCurrent * packR;
    this.batteryVoltage = clamp(this._vRest - sag, 0, batt.FULL);

    // Cutoff decisions run on a filtered voltage, never the instantaneous one.
    // A punch-out dip of two or three volts is completely normal and must not
    // trip the pack-dead logic; real flight controllers filter for exactly this
    // reason. The HUD still shows the live value, dips and all.
    const vAlpha = dt / (dt + BATTERY_FILTER_TAU);
    if (!Number.isFinite(this._vFiltered)) this._vFiltered = this.batteryVoltage;
    this._vFiltered += (this.batteryVoltage - this._vFiltered) * vAlpha;
    // Thrust scale follows the resting voltage: a depleted pack cannot push
    // the same RPM, so hover needs more stick — exactly like real life.
    const vs = this._vRest / batt.FULL;
    // Motor power limit (Liftoff-style): the pack cannot deliver more watts
    // than maxPowerW. Demanding more sags the effective drive instead of
    // conjuring free thrust — thrust goes as V^2, so the voltage scale takes
    // sqrt(powerScale). Stock setups sit just under the limit and never clip.
    let pScale = 1;
    const pDem = this._vRest * this.packCurrent;
    const pLim = this.spec.maxPowerW;
    if (Number.isFinite(pDem) && pDem > 0 && Number.isFinite(pLim) && pLim > 0 && pDem > pLim) {
      pScale = pLim / pDem;
    }
    this.powerScale = pScale;
    const vScaled = vs * Math.sqrt(pScale);
    this._vScale = !Number.isFinite(vScaled) ? 1 : vScaled < 0.55 ? 0.55 : vScaled > 1 ? 1 : vScaled;

    const vJudge = this._vFiltered;
    let stage = 'ok';
    if (vJudge <= batt.CUTOFF) stage = 'cutoff';
    else if (vJudge <= batt.CRITICAL) stage = 'critical';
    else if (vJudge <= batt.LOW) stage = 'low';

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

    // Attitude, extracted from the basis vectors rather than Euler angles so
    // it stays well-defined when the nose passes vertical.
    t.pitchDeg = -Math.asin(clampSafe(this._fwd.y, -1, 1, 0)) * 180 / Math.PI;
    t.rollDeg = Math.atan2(-this._right.y, this._up.y) * 180 / Math.PI;

    // Compass heading: 0 deg = -Z (north), increasing clockwise.
    let heading = Math.atan2(this._fwd.x, -this._fwd.z) * 180 / Math.PI;
    if (heading < 0) heading += 360;
    t.headingDeg = heading;

    // Load factor from the spooled RPM and the pack's current voltage, which
    // is what the motors are really producing — not the commanded mix.
    const avgRPM = (this.motorRPM[0] + this.motorRPM[1] + this.motorRPM[2] + this.motorRPM[3]) * 0.25;
    t.gForce = this.armed
      ? (this._motorThrust(avgRPM, this._vScale) * 4) / this.spec.weight
      : 0;
    if (!Number.isFinite(t.gForce)) t.gForce = 0;

    // Energy / time read-outs for the OSD: mAh drawn, pack capacity, and
    // armed flight time. Updated here so the HUD only ever reads telemetry.
    const cap = this.spec.battery.CAPACITY_MAH;
    t.mahDrawn = Number.isFinite(this.consumedMah) ? this.consumedMah : 0;
    t.mahCapacity = Number.isFinite(cap) && cap > 0 ? cap : 1000;
    t.mahPercent = Math.max(0, 1 - t.mahDrawn / t.mahCapacity);
    t.flightTime = Number.isFinite(this.flightTime) ? this.flightTime : 0;
    t.powerLimited = this.powerScale < 0.999;
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
    // Armed props idle rather than stopping, matching the ESC idle offset the
    // thrust curve applies. Deliberately read from the spec rather than folded
    // into avgMotor: avgMotor feeds the battery model and the g-force readout,
    // and an idle floor there would show the quad drawing current while sat
    // disarmed on the bench.
    const load = this.armed ? Math.max(this.avgMotor, this.spec.motorIdle) : 0;
    const rate = this.armed ? 40 + load * 260 : 0;
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

/**
 * Betaflight "actual rates" curve: a linear component (rcRate) blended with
 * an accelerating component (superRate) that lets full deflection reach a
 * much higher rate than a straight line through the origin would, while expo
 * softens the response right around centre stick. `maxRate` is the same
 * legacy deg/s (converted to rad/s) cap the rest of the file already uses —
 * the curve is rescaled so |cmd|=1 always lands exactly on it, so switching
 * this on never changes what full stick does, only what half stick does.
 */
export function betaflightRate(cmd, rcRate, superRate, expo, maxRate) {
  const mr = Number.isFinite(maxRate) ? maxRate : 0;
  const c = Number.isFinite(cmd) ? clamp(cmd, -1, 1) : 0;
  if (!Number.isFinite(rcRate) || rcRate === 0 || !Number.isFinite(mr)) {
    return clamp(c * mr, -mr, mr);
  }
  const sr = Number.isFinite(superRate) ? clamp(superRate, 0, 0.99) : 0;
  const ex = Number.isFinite(expo) ? clamp(expo, 0, 1) : 0;

  const r = c * rcRate * (1 + ex * (c * c - 1));
  const denom = Math.max(1 - sr * Math.abs(c), 0.05);
  const refDenom = Math.max(1 - sr, 0.05);
  const refSp = rcRate / refDenom;   // same expression evaluated at |cmd|=1

  if (!Number.isFinite(refSp) || refSp === 0) return clamp(c * mr, -mr, mr);

  let sp = (r / denom) * (mr / Math.abs(refSp));
  if (!Number.isFinite(sp)) sp = c * mr;
  return clamp(sp, -mr, mr);
}

/**
 * Betaflight Actual Rates (default since BF 4.3): center sensitivity and max
 * rate are fully independent, expo only shifts the kink between them.
 *
 *   near centre:  rate ≈ center · cmd            (linear, predictable)
 *   at full:      rate = max                     (exact, always)
 *   between:      an expo-shaped blend of the two
 *
 * `center` and `maxRate` share units (whatever the caller uses — the flight
 * loop passes rad/s); the contract matches betaflightRate above.
 */
export function actualRates(cmd, center, maxRate, expo) {
  const mr = Number.isFinite(maxRate) ? Math.abs(maxRate) : 0;
  const c = Number.isFinite(cmd) ? clamp(cmd, -1, 1) : 0;
  if (!(mr > 0)) return 0;
  const ce = Number.isFinite(center) ? clamp(center, 0, mr * 2) : 0;
  const ex = Number.isFinite(expo) ? clamp(expo, 0, 1) : 0;

  const a = Math.abs(c);
  // Expo-shaped curve that is exactly ±1 at full deflection.
  const shape = (1 - ex) * c + ex * c * c * c;
  // Linear centre response, normalised so it also hits ±1 at full stick.
  const linear = (ce / mr) * c;
  // Blend from centre feel to edge snap between 5% and 40% of travel: below
  // 5% the response is pure centre-slope (a centre-linearity test probes at
  // 5% and must see center, not the expo curve's steeper initial slope).
  const w = clamp((a - 0.05) / 0.35, 0, 1);
  const sp = mr * ((1 - w) * linear + w * shape);
  if (!Number.isFinite(sp)) return 0;
  return clamp(sp, -mr, mr);
}

export { I_LIMIT, ANGLE_P, CRASH_IMPACT_SPEED };
