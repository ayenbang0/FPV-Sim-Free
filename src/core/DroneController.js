/**
 * core/DroneController.js
 * ---------------------------------------------------------------------------
 * The quad in the world: a cannon-es rigid body flown by a Betaflight flight
 * controller (src/fc) through a physical motor/prop/battery model
 * (QuadPhysics.js).
 *
 * Each fixed substep:
 *
 *   RX frames (sim-timestamped) ──► FlightController.onRxFrame
 *   body rates + attitude ─────────► FlightController.update ──► motor duty
 *   duty, air-relative velocity ───► QuadPhysics.step ──► hub forces, couples
 *   forces at the four hubs, couples rotated to world ──► cannon body
 *
 * Roll and pitch torque are never applied by hand: they emerge from four
 * thrust vectors at four hub offsets. Yaw comes from the rotors' reaction
 * torque, gyroscopic precession from their angular momentum. All damping is
 * physical (rotor inflow, H-force, drag) — the body has no artificial
 * angular or linear damping.
 *
 * COORDINATE / SIGN CONVENTIONS (shared with InputManager and src/fc):
 *   Local axes: +X right, +Y up, −Z forward.
 *   pitch > 0 = nose down   roll > 0 = roll right   yaw > 0 = turn right
 *   Body rates are negated from cannon's right-handed axes into this frame.
 */

import * as THREE from 'three/webgpu';
import * as CANNON from 'cannon-es';
import { GROUP, clampSafe, isFiniteVec } from './PhysicsWorld.js';
import { settings, buildFcTune } from './Settings.js';
import { buildDroneModel } from '../render/DroneModel.js';
import { getAirframe, DEFAULT_DRONE_TYPE } from './DroneTypes.js';
import { QuadPhysics } from './QuadPhysics.js';
import { FlightController, FLIGHT_MODES as FC_FLIGHT_MODES } from '../fc/FlightController.js';
import { blackbox } from './Blackbox.js';

/* --- Crash handling ------------------------------------------------------ */
const CRASH_IMPACT_SPEED = 6.0;    // m/s along the contact normal
// 6 m/s is a ~1.8 m free fall. Below that, real quads bounce and keep
// flying, and treating every knock as a crash makes the sim exhausting.
const CRASH_STATE_TIME = 1.5;      // s the 'destroyed' state is reported
const TURTLE_DURATION = 1.5;       // s the keyboard crash-flip channel is held

/** Legacy-controls path: synthetic RX frames at a typical 250 Hz link. */
const SYNTH_RX_INTERVAL = 1 / 250;

export const FLIGHT_MODES = FC_FLIGHT_MODES;

const RAD2DEG = 180 / Math.PI;

export class DroneController {
  /**
   * @param {import('./PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(physics, airframeId = DEFAULT_DRONE_TYPE) {
    this.physics = physics;

    /** The active airframe (DroneTypes.js). */
    this.spec = getAirframe(airframeId);

    this.quad = new QuadPhysics(this.spec);
    this.fc = new FlightController(buildFcTune(settings.values, this.spec), 1000);
    this.fc.setFallbackFlightMode(settings.get('flightMode'));
    this.fc.gyro.setVibration({ vibration: this.spec.vibration, maxMotorHz: this.spec.motorRpmMax / 60, damage: 0 });

    /* ---- state ---- */
    this.armed = false;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = 0;
    this.damage = 0;
    this.simTime = 0;
    this._lastRxT = -Infinity;
    this._lastQueuedT = -Infinity;
    this._rxQueue = [];
    this._rxBatch = null;
    this._lastSynthT = -Infinity;
    this._armToggle = false;
    this._switchArming = false;

    this.batteryCharge = 1;
    this.batteryVoltage = this.spec.battery.FULL;
    this.packCurrent = 0;
    this.motorCutByBattery = false;
    this.throttleEverApplied = false;   // gates the Time Trial clock
    this.consumedMah = 0;
    this.flightTime = 0;
    this.powerScale = 1;                // kept for the HUD; the bus solve limits power physically

    /** Populated each substep; read by the HUD and the audio engine. */
    this.motors = [0, 0, 0, 0];         // |duty| per motor, FL FR RL RR
    this.motorRPM = [0, 0, 0, 0];       // real RPM per motor
    this.motorRpmMax = this.spec.motorRpmMax;
    this.avgMotor = 0;
    this.armBlockReason = null;
    this.flightModeActive = 'angle';
    this.telemetry = {
      speed: 0, altitude: 0, verticalSpeed: 0,
      rollDeg: 0, pitchDeg: 0, headingDeg: 0,
      gForce: 1, mahDrawn: 0, mahCapacity: 1000, mahPercent: 1,
      flightTime: 0, powerLimited: false,
      cellVoltage: 0, current: 0,
    };

    /* ---- spawn ---- */
    this.spawnPoint = new THREE.Vector3(0, 1.2, 0);
    this.spawnHeading = 0;
    this.groundLevel = 0;

    /* ---- wind (outdoor maps): gust generator producing a wind vector ---- */
    this.windEnabled = false;
    this.windDirection = new THREE.Vector3(1, 0, 0.35).normalize();
    this._windPhase = 0;
    this._windStep = 0;
    this._turb = [0, 0, 0];
    this.wind = new THREE.Vector3();

    /* ---- callbacks ---- */
    this.onCrash = null;               // (impactSpeed, severity) => void
    this.onRespawn = null;
    this.onArmChange = null;           // (armed) => void
    this.onBatteryState = null;        // ('low' | 'critical' | 'cutoff') => void
    this._batteryStage = 'ok';

    /* ---- scratch ---- */
    this._invQ = new CANNON.Quaternion();
    this._localAV = new CANNON.Vec3();
    this._localVel = new CANNON.Vec3();
    this._vA = new CANNON.Vec3();
    this._vB = new CANNON.Vec3();
    this._zero = new CANNON.Vec3();
    this._hubOffsets = [new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3()];
    this._channels = new Float32Array(16);
    this._rates = new Float64Array(3);
    this._att = { rollDeg: 0, pitchDeg: 0 };
    this._stepIn = {
      duty: new Float64Array(4),
      bodyVel: new Float64Array(3),
      bodyRates: new Float64Array(3),
      agl: 0,
      gravityBody: new Float64Array(3),
    };
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
   * Airframe switching and tuning
   * ====================================================================== */

  /** Swap to a different airframe in place (the caller respawns afterwards). */
  setAirframe(airframeId) {
    const next = getAirframe(airframeId);
    if (next === this.spec) return false;

    const parent = this.object3d?.parent || null;
    this._disposeMesh();
    this.physics.removeBody(this.body);

    this.spec = next;
    this.motorRpmMax = next.motorRpmMax;
    this._buildBody();
    this._buildMesh();
    if (parent) parent.add(this.object3d);

    this.quad.setSpec(next);
    this.quad.reset();
    this.applyTune();
    this.fc.reset();
    this._setArmedState(false);
    this.damage = 0;
    this.motorCutByBattery = false;
    this._batteryStage = 'ok';
    this.consumedMah = 0;
    this.flightTime = 0;
    this._syncBattery();
    return true;
  }

  /** Re-read the Betaflight settings (`fc*` keys) into the flight controller. */
  applyTune() {
    this.fc.setTune(buildFcTune(settings.values, this.spec));
    this.fc.setFallbackFlightMode(settings.get('flightMode'));
    this.fc.setArmSource(this._switchArming ? 'switch' : 'toggle');
    this.fc.gyro.setVibration({
      vibration: this.spec.vibration, maxMotorHz: this.spec.motorRpmMax / 60, damage: this.damage,
    });
  }

  /** Hub positions for the current airframe, FL FR RL RR. */
  _applyArmGeometry() {
    const a = this.spec.arm;
    const h = this.spec.propHeight;
    this._hubOffsets[0].set(-a, h, -a);
    this._hubOffsets[1].set(+a, h, -a);
    this._hubOffsets[2].set(-a, h, +a);
    this._hubOffsets[3].set(+a, h, +a);
  }

  _buildBody() {
    this._applyArmGeometry();
    const [bw, bh, bd] = this.spec.body;
    this.body = new CANNON.Body({
      mass: this.spec.mass,
      shape: new CANNON.Box(new CANNON.Vec3(bw / 2, bh / 2, bd / 2)),
      material: this.physics.droneMaterial,
      linearDamping: 0,        // all drag is physical (QuadPhysics)
      angularDamping: 0,
      collisionFilterGroup: GROUP.DRONE,
      collisionFilterMask: GROUP.WORLD | GROUP.PROP,
    });
    this.body.isDrone = true;
    this.body.allowSleep = false;
    this.body.position.set(0, 1.2, 0);
    this.body.addEventListener('collide', (e) => this._onCollide(e));
    this.physics.addBody(this.body);
    this.physics.protect(this.body);
  }

  _buildMesh() {
    this.model = buildDroneModel(this.spec);
    this.object3d = this.model.object3d;
    this.propMeshes = this.model.propGroups;
  }

  _disposeMesh() {
    try { this.model?.dispose(); } catch (_e) { /* teardown must never throw */ }
    this.model = null;
    this.propMeshes = [];
  }

  /** FPV shows only the prop discs (if `propsInView`); other views show the quad. */
  setViewMode(fpv, propsInView = true) {
    this.model?.setFpv(fpv, propsInView);
  }

  /* ====================================================================== *
   * Spawn / reset
   * ====================================================================== */

  setSpawn(position, headingRadians = 0, groundLevel = 0) {
    if (position) this.spawnPoint.set(position.x, position.y, position.z);
    this.spawnHeading = Number.isFinite(headingRadians) ? headingRadians : 0;
    this.groundLevel = Number.isFinite(groundLevel) ? groundLevel : 0;
  }

  /** Full respawn: transform, velocities, FC state, and (by default) a fresh pack. */
  respawn({ resetBattery = true } = {}) {
    const b = this.body;
    b.position.set(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.force.set(0, 0, 0);
    b.torque.set(0, 0, 0);
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), this.spawnHeading);
    b.quaternion.normalize();

    this.damage = 0;
    this.motors = [0, 0, 0, 0];
    this.motorRPM = [0, 0, 0, 0];
    this.avgMotor = 0;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = 0;
    this.fc.setForcedCrashflip(false);
    this.throttleEverApplied = false;

    if (resetBattery) {
      this.quad.reset();
      this.motorCutByBattery = false;
      this._batteryStage = 'ok';
      this.consumedMah = 0;
      this.flightTime = 0;
      this.powerScale = 1;
    } else {
      this.quad.stopRotors();
    }
    this.quad.tmaxScale.fill(1);
    this.fc.gyro.setVibration({ damage: 0 });
    this.fc.reset();
    this._armToggle = false;
    this._syncBattery();

    this._setArmedState(false);
    this.physics.commitSafeState(b);
    this._syncSnapshots(true);

    if (typeof this.onRespawn === 'function') {
      try { this.onRespawn(); } catch (_e) { /* ignore */ }
    }
  }

  /* ====================================================================== *
   * Arming
   * ====================================================================== */

  /**
   * Arm or disarm from the keyboard / gamepad arm toggle (or code). Arming is
   * a request: the flight controller makes one attempt on its next loop and
   * refuses it for Betaflight's reasons (throttle up, tilted, no link…),
   * exposed as `armBlockReason`. With switch-based arming (a radio's ARM
   * switch) arm requests are ignored; disarm always works.
   */
  setArmed(next) {
    const want = !!next;
    if (want && (this.motorCutByBattery || this.crashed)) return;
    this._armToggle = want;
    this.fc.requestArm(want);
    if (!want) this._setArmedState(false);
  }

  toggleArmed() {
    this.setArmed(!(this.armed || this.fc._armRequest));
  }

  /** Switch-based arming (radio ARM switch) versus the arm toggle. */
  setSwitchArming(on) {
    this._switchArming = !!on;
    this.fc.setArmSource(this._switchArming ? 'switch' : 'toggle');
  }

  _setArmedState(value) {
    if (value === this.armed) return;
    this.armed = value;
    if (!value) {
      this.motors = [0, 0, 0, 0];
      this.avgMotor = 0;
    }
    if (typeof this.onArmChange === 'function') {
      try { this.onArmChange(this.armed); } catch (_e) { /* ignore */ }
    }
  }

  /* ====================================================================== *
   * Collisions
   * ====================================================================== */

  _onCollide(event) {
    try {
      const contact = event.contact;
      if (!contact) return;
      const impact = Math.abs(contact.getImpactVelocityAlongNormal());
      if (!Number.isFinite(impact)) return;
      this.registerImpact(impact);
    } catch (err) {
      console.warn('[DroneController] collide handler failed', err);
    }
  }

  /**
   * Classify an impact speed into destroyed / hard / graze. Shared by the
   * contact-event path and the swept-collision guard (main.js forwards
   * `sanitizeBody().impactSpeed` here).
   */
  registerImpact(speed) {
    try {
      const impact = Number.isFinite(speed) ? speed : 0;
      if (!(impact > 0) || this.crashed) return;

      if (impact >= CRASH_IMPACT_SPEED) {
        this.crashed = true;
        this.crashTimer = CRASH_STATE_TIME;
        this.fc.requestArm(false);
        this._armToggle = false;
        this._setArmedState(false);
        this.damage = clamp((Number.isFinite(this.damage) ? this.damage : 0) + 0.25, 0, 1);
        this._applyDamage();
        if (typeof this.onCrash === 'function') this.onCrash(impact, 'destroyed');
      } else if (impact >= 2.5) {
        // Hard knock: audio and the callback only — real pilots clip a gate
        // post and keep flying.
        if (typeof this.onCrash === 'function') this.onCrash(impact, 'hard');
      } else if (typeof this.onCrash === 'function') {
        this.onCrash(impact, 'graze');
      }
    } catch (err) {
      console.warn('[DroneController] impact handler failed', err);
    }
  }

  /** Damage shakes the gyro harder and bends one prop. */
  _applyDamage() {
    this.fc.gyro.setVibration({ damage: this.damage });
    const motor = Math.floor(Math.random() * 4);
    this.quad.setMotorDamage(motor, 1 - 0.3 * this.damage);
  }

  /* ====================================================================== *
   * Crash flip
   * ====================================================================== */

  /**
   * Keyboard crash flip: hold the FLIPOVERAFTERCRASH channel for 1.5 s and
   * (re)arm into it. Roll or pitch stick then picks the motors to spin in
   * reverse, as in Betaflight's turtle mode.
   */
  requestTurtle() {
    if (!this.isInverted() || this.motorCutByBattery) return;
    this.crashed = false;
    this.crashTimer = 0;
    this.turtleTimer = TURTLE_DURATION;
    this.fc.setForcedCrashflip(true);
    if (!this._switchArming) {
      if (this.armed && !this.fc.crashflipActive) {
        this.fc.requestArm(false);
        this._setArmedState(false);
      }
      this._armToggle = true;
      this.fc.requestArm(true);
    }
  }

  isInverted() {
    this._readOrientation();
    return this._up.y < 0.1;
  }

  /* ====================================================================== *
   * Per-substep update
   * ====================================================================== */

  /**
   * Advance by one fixed physics substep. Call immediately BEFORE
   * `physics.step()`.
   *
   * @param {number} dt
   * @param {object} controls  `{ rxFrames?: [{t, ch}], switchArming?,
   *   throttle, pitch, roll, yaw }` — without `rxFrames`, frames are
   *   synthesised from the legacy stick values at 250 Hz.
   */
  update(dt, controls) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    this.prevPosition.copy(this.currPosition);
    this.prevQuaternion.copy(this.currQuaternion);
    this.simTime += dt;

    if (this.crashed) {
      this.crashTimer -= dt;
      if (this.crashTimer <= 0) this.crashed = false;
    }
    if (this.turtleTimer > 0) {
      this.turtleTimer -= dt;
      if (this.turtleTimer <= 0) {
        this.turtleTimer = 0;
        this.fc.setForcedCrashflip(false);
      }
    }
    if (controls && typeof controls.switchArming === 'boolean' && controls.switchArming !== this._switchArming) {
      this.setSwitchArming(controls.switchArming);
    }
    this.fc.setFallbackFlightMode(settings.get('flightMode'));

    // --- 1. RX frames up to now ---------------------------------------------
    this._deliverRx(controls);

    // --- 2. truth for the FC ------------------------------------------------
    this._readOrientation();
    this._readBodyRates();
    this._updateAttitude();

    // --- 3. flight controller -------------------------------------------------
    const out = this.fc.update(dt, {
      trueRatesDps: this._rates,
      attitudeDeg: this._att,
      motorRpm: this.quad.rpm,
      vbat: this.quad.vbat,
      t: this.simTime,
    });
    this.armBlockReason = this.fc.armBlockReason;
    this.flightModeActive = out.crashflip ? 'crashflip' : out.flightMode;
    if (this.fc.armBlockReason === 'BROWNOUT' && !this.motorCutByBattery && this.spec.battery.cells === 1) {
      this.motorCutByBattery = true;
      this._armToggle = false;
      this._setBatteryStage('cutoff');
    }
    this._setArmedState(out.armed);

    // --- 4. physical quad ---------------------------------------------------
    const s = this._stepIn;
    for (let i = 0; i < 4; i++) s.duty[i] = this.motorCutByBattery ? 0 : out.motors[i];
    this._fillAeroInputs(dt);
    const q = this.quad.step(dt, s);

    // --- 5. loads on the body -------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const f = q.perMotorForce[i];
      if (!(Number.isFinite(f[0]) && Number.isFinite(f[1]) && Number.isFinite(f[2]))) continue;
      this._vA.set(f[0], f[1], f[2]);
      this.body.applyLocalForce(this._vA, this._hubOffsets[i]);
    }
    if (Number.isFinite(q.force[0] + q.force[1] + q.force[2])) {
      this._vA.set(q.force[0], q.force[1], q.force[2]);
      this.body.applyLocalForce(this._vA, this._zero);
    }
    if (Number.isFinite(q.torque[0] + q.torque[1] + q.torque[2])) {
      this._vA.set(q.torque[0], q.torque[1], q.torque[2]);
      this.body.quaternion.vmult(this._vA, this._vB);
      if (isFiniteVec(this._vB)) this.body.applyTorque(this._vB);
    }

    // --- 6. read-outs -------------------------------------------------------------
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(out.motors[i]);
      this.motors[i] = this.armed ? d : 0;
      sum += this.motors[i];
      this.motorRPM[i] = Math.abs(q.rpm[i]);
    }
    this.avgMotor = sum / 4;
    if (this.armed && this.fc.rc.getThrottle() > 0.02) this.throttleEverApplied = true;
    if (this.armed) this.flightTime += dt;
    this._syncBattery();
    this._updateBatteryStage();
    this._updateTelemetry(q);
    this._blackbox(out);
  }

  /** Deliver pending RX frames (radio path) or synthesise one (legacy path). */
  _deliverRx(controls) {
    const frames = controls?.rxFrames;
    if (Array.isArray(frames)) {
      // A new render frame's batch: queue it, so frames stamped after this
      // frame's last substep are delivered on the next one, not lost.
      if (frames !== this._rxBatch) {
        this._rxBatch = frames;
        for (const f of frames) {
          if (f && Number.isFinite(f.t) && f.t > this._lastQueuedT) {
            this._rxQueue.push(f);
            this._lastQueuedT = f.t;
          }
        }
        if (this._rxQueue.length > 256) this._rxQueue.splice(0, this._rxQueue.length - 256);
      }
      while (this._rxQueue.length && this._rxQueue[0].t <= this.simTime + 1e-9) {
        const f = this._rxQueue.shift();
        this.fc.onRxFrame(f.ch, f.t);
        this._lastRxT = f.t;
      }
      return;
    }
    if (this.simTime - this._lastSynthT < SYNTH_RX_INTERVAL - 1e-9) return;
    this._lastSynthT = this.simTime;
    const ch = this._channels;
    const stick = (v) => 1500 + 500 * clampSafe(v, -1, 1, 0);
    ch[0] = stick(controls?.roll);
    ch[1] = stick(controls?.pitch);
    ch[2] = 1000 + 1000 * clampSafe(controls?.throttle, 0, 1, 0);
    ch[3] = stick(controls?.yaw);
    ch[4] = this._armToggle ? 2000 : 1000;
    const mode = settings.get('flightMode');
    ch[5] = mode === 'angle' ? 1000 : mode === 'horizon' ? 1500 : 2000;
    ch[6] = this.turtleTimer > 0 ? 2000 : 1000;
    for (let i = 7; i < 16; i++) ch[i] = 1000;
    this.fc.onRxFrame(ch, this.simTime);
  }

  /** Cache the body's basis vectors. */
  _readOrientation() {
    const q = this.body.quaternion;
    this._tq.set(q.x, q.y, q.z, q.w);
    this._up.set(0, 1, 0).applyQuaternion(this._tq);
    this._fwd.set(0, 0, -1).applyQuaternion(this._tq);
    this._right.set(1, 0, 0).applyQuaternion(this._tq);
  }

  /**
   * True body rates in the FC convention (deg/s): world angular velocity
   * rotated into the body, then negated — cannon's +ωx is nose-up but +pitch
   * is nose-down, and likewise for roll and yaw.
   */
  _readBodyRates() {
    this.body.quaternion.conjugate(this._invQ);
    this._invQ.vmult(this.body.angularVelocity, this._localAV);
    const r = this._rates;
    r[0] = -this._localAV.z * RAD2DEG;   // roll
    r[1] = -this._localAV.x * RAD2DEG;   // pitch
    r[2] = -this._localAV.y * RAD2DEG;   // yaw
    for (let i = 0; i < 3; i++) if (!Number.isFinite(r[i])) r[i] = 0;
  }

  /** Attitude in BF's sign (roll + right wing down, pitch + nose down). */
  _updateAttitude() {
    const pitch = -Math.asin(clampSafe(this._fwd.y, -1, 1, 0)) * RAD2DEG;
    const roll = Math.atan2(-this._right.y, this._up.y) * RAD2DEG;
    this._att.rollDeg = Number.isFinite(roll) ? roll : 0;
    this._att.pitchDeg = Number.isFinite(pitch) ? pitch : 0;
  }

  /** Air-relative body velocity, body rates, AGL and gravity for QuadPhysics. */
  _fillAeroInputs(dt) {
    if (this.windEnabled) this._updateWind(dt);
    else this.wind.set(0, 0, 0);

    const v = this.body.velocity;
    this.body.quaternion.conjugate(this._invQ);
    this._vA.set(
      (Number.isFinite(v.x) ? v.x : 0) - this.wind.x,
      (Number.isFinite(v.y) ? v.y : 0) - this.wind.y,
      (Number.isFinite(v.z) ? v.z : 0) - this.wind.z,
    );
    this._invQ.vmult(this._vA, this._localVel);
    const s = this._stepIn;
    s.bodyVel[0] = this._localVel.x;
    s.bodyVel[1] = this._localVel.y;
    s.bodyVel[2] = this._localVel.z;
    s.bodyRates[0] = this._localAV.x;
    s.bodyRates[1] = this._localAV.y;
    s.bodyRates[2] = this._localAV.z;
    s.agl = (Number.isFinite(this.body.position.y) ? this.body.position.y : 0) - this.groundLevel;
    this._vA.set(0, -1, 0);
    this._invQ.vmult(this._vA, this._vB);
    s.gravityBody[0] = this._vB.x;
    s.gravityBody[1] = this._vB.y;
    s.gravityBody[2] = this._vB.z;
  }

  /**
   * Dryden-lite gusts: a directional base speed plus two irrational-ratio
   * sines low-passed with deterministic noise into a 3-axis turbulence
   * vector. The result is the wind *vector*; the aero model sees air-relative
   * velocity, so a quad flying with the wind feels nothing.
   */
  _updateWind(dt) {
    const speedSetting = settings.get('windSpeed');
    const baseSpeed = Number.isFinite(speedSetting) ? speedSetting : 2.5;
    const gustSetting = settings.get('windGust');
    const gustAmp = Number.isFinite(gustSetting) ? gustSetting : 0.5;

    this._windPhase = (Number.isFinite(this._windPhase) ? this._windPhase : 0) + dt;
    const s = Math.sin(this._windPhase * 2 * Math.PI * 0.43) * 0.8
      + Math.sin(this._windPhase * 2 * Math.PI * 0.13 + 1.7) * 0.5;

    this._windStep = (Number.isFinite(this._windStep) ? this._windStep : 0) + 1;
    const hash = Math.sin(this._windStep * 12.9898) * 43758.5;
    const white = (hash - Math.floor(hash) - 0.5) * 0.5;

    const turbAlpha = dt / (dt + 1 / (2 * Math.PI * 2));
    const drive = white + s;
    for (let i = 0; i < 3; i++) {
      const t = this._turb[i] + (drive - this._turb[i]) * turbAlpha;
      this._turb[i] = Number.isFinite(t) ? t : 0;
    }
    const wd = this.windDirection;
    // Gusts scale with the base wind (a calm day has no 3 m/s gusts).
    const g = gustAmp * Math.max(1, baseSpeed * 0.6);
    this.wind.set(
      wd.x * baseSpeed + g * this._turb[0],
      0.3 * g * this._turb[1],
      wd.z * baseSpeed + g * this._turb[2],
    );
  }

  /* ====================================================================== *
   * Battery and telemetry
   * ====================================================================== */

  _syncBattery() {
    const q = this.quad;
    this.batteryVoltage = q.vbat;
    this.batteryCharge = q.soc;
    this.packCurrent = q.packCurrent;
    this.consumedMah = q.consumedAh * 1000;
  }

  /** Stages from the rested (open-circuit) cell voltage. */
  _updateBatteryStage() {
    if (this.motorCutByBattery) return;
    const cellOcv = this.quad.ocv / this.spec.battery.cells;
    let stage = 'ok';
    if (cellOcv < 3.0) stage = 'cutoff';
    else if (cellOcv < 3.3) stage = 'critical';
    else if (cellOcv < 3.5) stage = 'low';
    this._setBatteryStage(stage);
  }

  _setBatteryStage(stage) {
    if (stage === this._batteryStage) return;
    this._batteryStage = stage;
    if (stage !== 'ok' && typeof this.onBatteryState === 'function') {
      try { this.onBatteryState(stage); } catch (_e) { /* ignore */ }
    }
  }

  _updateTelemetry(q) {
    const v = this.body.velocity;
    const p = this.body.position;
    const t = this.telemetry;
    t.speed = isFiniteVec(v) ? Math.hypot(v.x, v.y, v.z) : 0;
    t.verticalSpeed = Number.isFinite(v.y) ? v.y : 0;
    t.altitude = Math.max(0, (Number.isFinite(p.y) ? p.y : 0) - this.groundLevel);
    t.pitchDeg = this._att.pitchDeg;
    t.rollDeg = this._att.rollDeg;
    let heading = Math.atan2(this._fwd.x, -this._fwd.z) * RAD2DEG;
    if (heading < 0) heading += 360;
    t.headingDeg = Number.isFinite(heading) ? heading : 0;
    t.gForce = Number.isFinite(q.totalThrust) ? Math.max(0, q.totalThrust) / this.spec.weight : 0;
    const cap = this.spec.battery.mah;
    t.mahDrawn = Number.isFinite(this.consumedMah) ? this.consumedMah : 0;
    t.mahCapacity = cap;
    t.mahPercent = Math.max(0, 1 - t.mahDrawn / cap);
    t.flightTime = this.flightTime;
    t.powerLimited = false;
    t.cellVoltage = q.cellV;
    t.current = q.packCurrent;
  }

  _blackbox(out) {
    if (settings.get('blackbox') !== true) return;
    try {
      const d = out.debug;
      blackbox.push({
        loopIteration: this.fc._loopCount,
        time: this.simTime,
        rcCommand: d.rcCommand,
        setpoint: d.setpoint,
        gyroADC: d.gyro,
        axisP: d.P,
        axisI: d.I,
        axisD: d.D,
        axisF: d.F,
        motor: out.motors,
        rpm: this.quad.rpm,
        vbat: this.quad.vbat,
        amperage: this.quad.packCurrent,
      });
    } catch (_e) { /* blackbox failure must never break flight */ }
  }

  /* ====================================================================== *
   * Render-side sync
   * ====================================================================== */

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

  /** Spin the props (and fade in the blur discs) at each motor's real RPM. */
  updateVisuals(dtRender) {
    if (!this.model) return;
    for (let i = 0; i < 4; i++) RPM_SCRATCH[i] = this.quad.rpm[i];
    this.model.setRpm(RPM_SCRATCH, dtRender);
  }

  getBatteryStage() {
    return this._batteryStage;
  }

  dispose() {
    this.physics.removeBody(this.body);
    this._disposeMesh();
  }
}

const RPM_SCRATCH = [0, 0, 0, 0];

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export { CRASH_IMPACT_SPEED };
