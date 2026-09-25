/**
 * fc/FlightController.js
 * ---------------------------------------------------------------------------
 * The flight controller facade: RX frames and sensor truth in, motor duty
 * out. Wires the Betaflight 2025.12 port together in BF's loop order
 * (`fc/core.c`: processRx → processRcCommand → gyro → pidController →
 * mixTable) and implements the subset of BF's arming, failsafe and mode
 * logic the sim needs. GPL-3.0-or-later (derived from Betaflight).
 * Pure JS: no three, no DOM.
 *
 *   const fc = new FlightController(tune);
 *   fc.onRxFrame(channelsUs, tSim);            // whenever a frame arrives
 *   const out = fc.update(dT, { trueRatesDps, attitudeDeg, motorRpm, vbat });
 *   out.motors  // Float32Array(4), -1..1 duty (negative = crash-flip reverse)
 *
 * `tune` uses the Settings v3 shapes: `{ rates, pid, filters, misc, rc,
 * modes, cells }` (see buildFcTune in core/Settings.js).
 *
 * Arming. Two sources, as the plan specifies:
 *   'switch'  the ARM mode on an AUX channel (BF Modes tab). Arms on the
 *             switch's off→on edge when nothing blocks it; a switch that is
 *             already on at link-up, or never seen off, blocks (ARMSWITCH).
 *   'toggle'  keyboard / gamepad arm button: `requestArm(true)` makes one
 *             arming attempt on the next loop with a live link;
 *             `requestArm(false)` disarms.
 * Arming is refused, with `armBlockReason`, for: THROTTLE (throttle not
 * low), ARMSWITCH, ANGLE (tilt > small_angle 25°, unless the crash-flip
 * switch is on), RXLOSS, BROWNOUT, NOPREARM (a PREARM mode is configured and
 * off).
 *
 * Failsafe: no RX frame for 300 ms is an immediate stage-2 drop — disarm,
 * RXLOSS until frames resume and the arm switch has been seen off.
 * Brownout (1S only): terminal cell voltage below 2.9 V for 50 ms reboots
 * the FC — disarm, BROWNOUT for 1.5 s.
 */

import { RcProcessor, CH_THROTTLE, CH_AUX1, RC_CHANNEL_COUNT, FD_ROLL, FD_PITCH, FD_YAW } from './rc.js';
import { PidController } from './pid.js';
import { Gyro } from './gyro.js';
import { Mixer } from './mixer.js';

export const FLIGHT_MODES = ['angle', 'horizon', 'acro'];
export const MODE_NAMES = ['ARM', 'ANGLE', 'HORIZON', 'FLIPOVERAFTERCRASH', 'BEEPER', 'PREARM'];

/** Default Modes-tab ranges (0-based channel; 4 = AUX1). */
export const DEFAULT_MODES = Object.freeze([
  Object.freeze({ mode: 'ARM', channel: 4, min: 1700, max: 2100 }),
  Object.freeze({ mode: 'ANGLE', channel: 5, min: 900, max: 1300 }),
  Object.freeze({ mode: 'HORIZON', channel: 5, min: 1300, max: 1700 }),
  Object.freeze({ mode: 'FLIPOVERAFTERCRASH', channel: 6, min: 1700, max: 2100 }),
]);

export const FAILSAFE_TIMEOUT_S = 0.3;
export const SMALL_ANGLE_DEG = 25;
export const BROWNOUT_CELL_V = 2.9;
export const BROWNOUT_TIME_S = 0.05;
export const BROWNOUT_REBOOT_S = 1.5;
export const AIRMODE_START_THROTTLE_PERCENT = 25;   // BF airModeActivateThreshold
const MINCHECK = 1050;
const PWM_RANGE_MAX = 2000;

/** Map Settings v3 `fcRates` onto the RcProcessor rate profile. */
function ratesConfig(r = {}) {
  return {
    type: r.type || 'actual',
    rcRates: Array.isArray(r.rcRates) ? r.rcRates.slice(0, 3) : [7, 7, 7],
    rates: Array.isArray(r.rates) ? r.rates.slice(0, 3) : [67, 67, 67],
    rcExpo: Array.isArray(r.rcExpo) ? r.rcExpo.slice(0, 3) : [0, 0, 0],
    quickRatesRcExpo: r.quickRatesRcExpo ? 1 : 0,
    rateLimit: Array.isArray(r.rateLimit) ? r.rateLimit.slice(0, 3) : [1998, 1998, 1998],
    thrMid: Number.isFinite(r.thrMid) ? r.thrMid : 50,
    thrExpo: Number.isFinite(r.thrExpo) ? r.thrExpo : 0,
    thrHover: Number.isFinite(r.thrHover) ? r.thrHover : 50,
  };
}

const num = (v, d) => (Number.isFinite(v) ? v : d);

export class FlightController {
  constructor(tune = {}, loopHz = 1000) {
    this.dT = 1 / loopHz;
    this.timeS = 0;
    this._loopCount = 0;

    this.armed = false;
    this.armBlockReason = null;
    this.flightMode = 'acro';
    this.crashflipActive = false;
    this.beeper = false;
    this.failsafeActive = true;   // no link until the first frame
    this.rxLinkUp = false;
    this._everReceived = false;
    this.lastFrameT = -Infinity;

    this.armSource = 'toggle';
    this._requestedArmSource = 'toggle';
    this._armRequest = null;       // pending toggle request {t}
    this._rxlossLatch = false;     // failsafe: RXLOSS until frames resume and ARM is seen off
    this._armSwitchSeenOff = false;
    this._armSwitchOnWhenDisabled = false;
    this._notDisarmed = false;
    this._prevArmModeActive = false;
    this._rcDisarmTicks = 0;
    this._fallbackMode = 'angle';

    this._airmodeActive = false;
    this._throttleRaised = false;

    this._brownoutTimer = 0;
    this._rebootTimer = 0;

    this.modeActive = { ARM: false, ANGLE: false, HORIZON: false, FLIPOVERAFTERCRASH: false, BEEPER: false, PREARM: false };
    this.modeMapped = { ARM: false, ANGLE: false, HORIZON: false, FLIPOVERAFTERCRASH: false, BEEPER: false, PREARM: false };
    this.forcedModes = { FLIPOVERAFTERCRASH: false };

    this.motors = new Float32Array(4);
    this.debug = {
      setpoint: new Float32Array(3),
      gyro: new Float32Array(3),
      P: new Float32Array(3), I: new Float32Array(3), D: new Float32Array(3), F: new Float32Array(3),
      rcCommand: new Float32Array(4),
      throttle: 0,
      motorOutputs: new Float32Array(4),
    };
    this._out = { motors: this.motors, armed: false, flightMode: 'acro', crashflip: false, debug: this.debug };

    this.setTune(tune);
  }

  /* ---------------------------------------------------------------------- *
   * Configuration
   * ---------------------------------------------------------------------- */

  /** Rebuild gains and filters from a Settings v3 tune. */
  setTune(tune = {}) {
    const t = tune || {};
    this.tune = t;
    const f = t.filters || {};
    const m = t.misc || {};
    const p = t.pid || {};
    const rc = t.rc || {};

    this.cells = num(t.cells, 0);
    this.airmode = m.airmode !== false;
    this.setModes(Array.isArray(t.modes) ? t.modes : DEFAULT_MODES);

    const rcConfig = {
      rates: ratesConfig(t.rates),
      deadband: num(rc.deadband, 0),
      yawDeadband: num(rc.yawDeadband, num(rc.deadband, 0)),
      feedforwardJitterFactor: num(m.ffJitter, 7),
      feedforwardSmoothFactor: num(m.ffSmooth, 65),
      feedforwardBoost: num(m.ffBoost, 15),
      feedforwardMaxRateLimit: num(m.ffMaxRateLimit, 90),
      rcSmoothingAutoFactorRpy: num(m.rcSmoothingAuto, 30),
      rcSmoothingAutoFactorThrottle: num(m.rcSmoothingAuto, 30),
      feedforwardInterpolate: rc.protocol !== 'crsf',
    };

    const axis = (a, d) => ({
      p: num(a?.p, d.p), i: num(a?.i, d.i), d: num(a?.d, d.d), dMax: num(a?.dMax, d.dMax), f: num(a?.f, d.f),
    });
    const pidTune = {
      pid: {
        roll: axis(p.roll, { p: 45, i: 80, d: 30, dMax: 40, f: 120 }),
        pitch: axis(p.pitch, { p: 47, i: 84, d: 34, dMax: 46, f: 125 }),
        yaw: axis(p.yaw, { p: 45, i: 80, d: 0, dMax: 0, f: 120 }),
      },
      levelP: num(p.levelP, 50),
      levelI: num(p.levelI, 75),
      levelD: num(p.levelD, 75),
      angleLimit: num(p.angleLimit, 55),
      dtermLpf1DynMinHz: num(f.dtermLpf1Min, 75),
      dtermLpf1DynMaxHz: num(f.dtermLpf1Max, 150),
      dtermLpf1StaticHz: num(f.dtermLpf1Min, 75),
      dtermLpf2StaticHz: num(f.dtermLpf2, 150),
      yawLowpassHz: num(f.yawLowpass, 100),
      antiGravityGain: num(m.antiGravityGain, 80),
      itermRelaxCutoff: num(m.itermRelaxCutoff, 15),
      tpaRate: num(m.tpaRate, 65),
      tpaBreakpoint: num(m.tpaBreakpoint, 1350),
      thrustLinearization: num(m.thrustLinear, 0),
      throttleBoost: num(m.throttleBoost, 5),
      motorOutputLimit: num(m.motorOutputLimit, 100),
    };
    const gyroCfg = {
      gyroLpf1DynMinHz: num(f.gyroLpf1Min, 250),
      gyroLpf1DynMaxHz: num(f.gyroLpf1Max, 500),
      gyroLpf1StaticHz: num(f.gyroLpf1Min, 250),
      gyroLpf2StaticHz: num(f.gyroLpf2, 500),
      rpmFilter: f.rpmFilter !== false,
      rpmFilterHarmonics: num(f.rpmHarmonics, 3),
    };
    const mixerCfg = {
      dshotIdle: num(m.dshotIdle, 5.5) / 100,
      motorOutputLimit: num(m.motorOutputLimit, 100),
      throttleBoost: num(m.throttleBoost, 5),
      thrustLinearization: num(m.thrustLinear, 0),
    };

    this._cfg = { rcConfig, pidTune, gyroCfg, mixerCfg };
    if (!this.rc) {
      this.rc = new RcProcessor(rcConfig, this.dT);
      this.pid = new PidController(pidTune, this.dT);
      this.gyro = new Gyro(gyroCfg, this.dT);
      this.mixer = new Mixer(mixerCfg, this.dT);
    } else {
      this.rc.configure(rcConfig, this.dT);
      this.pid.setTune(pidTune);
      this.gyro.configure(gyroCfg, this.dT);
      this.mixer.configure(mixerCfg, this.dT);
    }
  }

  /** PID loop rate, Hz. Filters are rebuilt for the new period. */
  setLoopRate(hz) {
    if (!(hz > 0)) return;
    const dT = 1 / hz;
    if (Math.abs(dT - this.dT) < 1e-12) return;
    this.dT = dT;
    const c = this._cfg;
    this.rc.configure(c.rcConfig, dT);
    this.pid.init(c.pidTune, dT);
    this.gyro.configure(c.gyroCfg, dT);
    this.mixer.configure(c.mixerCfg, dT);
  }

  /** Modes-tab ranges: `[{ mode, channel, min, max }]`. */
  setModes(modes) {
    this.modes = [];
    for (const k of Object.keys(this.modeMapped)) this.modeMapped[k] = false;
    for (const m of modes || []) {
      if (!m || !MODE_NAMES.includes(m.mode)) continue;
      const ch = m.channel | 0;
      if (ch < 4 || ch >= RC_CHANNEL_COUNT) continue;
      this.modes.push({ mode: m.mode, channel: ch, min: num(m.min, 900), max: num(m.max, 2100) });
      this.modeMapped[m.mode] = true;
    }
    this.setArmSource(this._requestedArmSource || 'toggle');
  }

  /** 'switch' (ARM mode on a channel) or 'toggle' (arm button). */
  setArmSource(source) {
    this._requestedArmSource = source;
    this.armSource = source === 'switch' && this.modeMapped.ARM ? 'switch' : 'toggle';
  }

  /** Flight mode used when no ANGLE/HORIZON range is mapped. */
  setFallbackFlightMode(mode) {
    this._fallbackMode = FLIGHT_MODES.includes(mode) ? mode : 'angle';
  }

  /** Keyboard crash-flip: hold the FLIPOVERAFTERCRASH mode on regardless of channels. */
  setForcedCrashflip(on) {
    this.forcedModes.FLIPOVERAFTERCRASH = !!on;
    if (this._everReceived) this._evaluateModes();
  }

  /** Toggle-source arming: one attempt on the next live loop, or disarm. */
  requestArm(on) {
    if (!on) {
      this._armRequest = null;
      this.disarm('user');
      return;
    }
    if (this.armed) return;
    this._armRequest = { t: this.timeS };
  }

  /* ---------------------------------------------------------------------- *
   * RX
   * ---------------------------------------------------------------------- */

  onRxFrame(channelsUs, tSim) {
    if (this._rebootTimer > 0) return;   // FC is rebooting: frames are lost
    const t = Number.isFinite(tSim) ? tSim : this.timeS;
    const justGotRxBack = !this.rxLinkUp;
    this.lastFrameT = t;
    this.rxLinkUp = true;
    this._everReceived = true;
    this.rc.onRxFrame(channelsUs, t);
    this._evaluateModes();

    // BF: fc/core.c:updateArmingStatus — arm switch already on when the link comes up
    if (justGotRxBack && this.modeActive.ARM) {
      this._notDisarmed = true;
    } else if (!this.modeActive.ARM) {
      this._notDisarmed = false;
    }
    if (!this.modeActive.ARM) this._armSwitchSeenOff = true;

    if (this.failsafeActive && justGotRxBack) this.failsafeActive = false;
    if (this._rxlossLatch && (this.armSource !== 'switch' || !this.modeActive.ARM)) {
      this._rxlossLatch = false;
    }

    this._processRcStickPositions();
  }

  // BF: fc/rc_modes.c:updateActivatedModes (range test: isRangeActive)
  _evaluateModes() {
    const rcData = this.rc.rcData;
    for (const k of Object.keys(this.modeActive)) this.modeActive[k] = false;
    for (const m of this.modes) {
      const v = rcData[m.channel];
      if (v >= m.min && v < m.max) this.modeActive[m.mode] = true;
    }
    if (this.forcedModes.FLIPOVERAFTERCRASH) this.modeActive.FLIPOVERAFTERCRASH = true;
    this.beeper = this.modeActive.BEEPER;
  }

  // BF: fc/rc_controls.c:processRcStickPositions (ARM box handling)
  _processRcStickPositions() {
    if (this.armSource !== 'switch') return;
    if (this.modeActive.ARM) {
      this._rcDisarmTicks = 0;
      if (!this._prevArmModeActive || !this.armed) this._tryArm();
    } else {
      this._armSwitchOnWhenDisabled = false;
      if (this.armed) {
        this._rcDisarmTicks++;
        if (this._rcDisarmTicks > 3) {
          this.disarm('switch');
        }
      }
    }
    this._prevArmModeActive = this.modeActive.ARM;
  }

  /* ---------------------------------------------------------------------- *
   * Arming
   * ---------------------------------------------------------------------- */

  /** Throttle stick below mincheck (BF calculateThrottleStatus). */
  _throttleLow() {
    return this.rc.rcData[CH_THROTTLE] < MINCHECK;
  }

  /** The first arming-disable reason, in BF's flag order; null when clear. */
  _armingDisabledReason(forSwitch) {
    if (this._rebootTimer > 0) return 'BROWNOUT';
    if (this.failsafeActive || !this.rxLinkUp || this._rxlossLatch) return 'RXLOSS';
    if (forSwitch && this._notDisarmed) return 'ARMSWITCH';
    if (!this._throttleLow()) return 'THROTTLE';
    if (!this._isUpright() && !this.modeActive.FLIPOVERAFTERCRASH) return 'ANGLE';
    if (this.modeMapped.PREARM && !this.modeActive.PREARM) return 'NOPREARM';
    if (forSwitch && (this._armSwitchOnWhenDisabled || !this._armSwitchSeenOff)) return 'ARMSWITCH';
    return null;
  }

  _isUpright() {
    return this._cosTilt > Math.cos(SMALL_ANGLE_DEG * Math.PI / 180);
  }

  // BF: fc/core.c:tryArm
  _tryArm() {
    if (this.armed) return true;
    const forSwitch = this.armSource === 'switch';
    const reason = this._armingDisabledReason(forSwitch);
    if (reason) {
      this.armBlockReason = reason;
      // BF: arming disabled while the ARM switch is on latches ARM_SWITCH
      if (forSwitch && this.modeActive.ARM) this._armSwitchOnWhenDisabled = true;
      return false;
    }
    this.crashflipActive = this.modeActive.FLIPOVERAFTERCRASH;
    this.armed = true;
    this.armBlockReason = null;
    this._rcDisarmTicks = 0;
    this._throttleRaised = false;
    this._airmodeActive = false;
    this.pid.resetIterm();
    this.mixer.reset();
    return true;
  }

  // BF: fc/core.c:disarm
  disarm(_reason) {
    if (this.armed) {
      this.armed = false;
      // Terminate crashflip mode in any disarm
      this.crashflipActive = false;
    }
    this._throttleRaised = false;
    this._airmodeActive = false;
    this.pid.resetIterm();
    for (let i = 0; i < 4; i++) this.motors[i] = 0;
  }

  /* ---------------------------------------------------------------------- *
   * Loop
   * ---------------------------------------------------------------------- */

  /**
   * One FC loop.
   * @param {number} dT
   * @param {object} s
   * @param {ArrayLike<number>} s.trueRatesDps  body rates, FC convention
   * @param {{rollDeg:number,pitchDeg:number}} s.attitudeDeg
   * @param {ArrayLike<number>} s.motorRpm      per-motor RPM (signed ok)
   * @param {number} s.vbat                     pack terminal voltage
   * @param {number} [s.t]                      sim time at this loop, s (the
   *                                            clock RX frame stamps use)
   */
  update(dT, s) {
    if (Number.isFinite(dT) && dT > 0 && Math.abs(dT - this.dT) > 1e-9) this.setLoopRate(1 / dT);
    this.timeS = Number.isFinite(s.t) ? s.t : this.timeS + this.dT;
    this._loopCount++;
    const timeUs = Math.round(this.timeS * 1e6);

    const att = s.attitudeDeg || { rollDeg: 0, pitchDeg: 0 };
    const rollDeg = num(att.rollDeg, 0);
    const pitchDeg = num(att.pitchDeg, 0);
    this._cosTilt = Math.cos(rollDeg * Math.PI / 180) * Math.cos(pitchDeg * Math.PI / 180);
    const attitude = { rollDeg, pitchDeg };

    // --- FC reboot (brownout) ---------------------------------------------
    if (this._rebootTimer > 0) {
      this._rebootTimer -= this.dT;
      if (this._rebootTimer <= 0) {
        this._rebootTimer = 0;
        if (this.armBlockReason === 'BROWNOUT') this.armBlockReason = null;
      }
      this.motors.fill(0);
      this._out.armed = false;
      this._out.crashflip = false;
      return this._out;
    }

    // --- brownout (1S only) -------------------------------------------------
    if (this.cells === 1 && Number.isFinite(s.vbat)) {
      if (s.vbat / this.cells < BROWNOUT_CELL_V) this._brownoutTimer += this.dT;
      else this._brownoutTimer = 0;
      if (this._brownoutTimer >= BROWNOUT_TIME_S) {
        this._brownoutTimer = 0;
        this._reboot();
        return this._out;
      }
    }

    // --- failsafe -----------------------------------------------------------
    if (this.rxLinkUp && this.timeS - this.lastFrameT > FAILSAFE_TIMEOUT_S) {
      this.rxLinkUp = false;
      this.failsafeActive = true;
      this.rc.onRxLoss();
      if (this.armed) this.disarm('failsafe');
      this.armBlockReason = 'RXLOSS';
      this._rxlossLatch = true;
      this._armSwitchSeenOff = false;
      this._armRequest = null;
    }

    // --- toggle arming --------------------------------------------------------
    if (this._armRequest) {
      if (this.armSource !== 'toggle') {
        this._armRequest = null;
      } else if (this.rxLinkUp) {
        this._armRequest = null;
        this._tryArm();
      } else if (this.timeS - this._armRequest.t > 0.1) {
        this._armRequest = null;
        this.armBlockReason = 'RXLOSS';
      }
    }

    // --- crashflip auto re-arm (BF updateArmingStatus, crashflip_auto_rearm) --
    if (this.armed && this.crashflipActive && !this.modeActive.FLIPOVERAFTERCRASH) {
      // terminate crashflip mode and set motor direction normal
      this.crashflipActive = false;
    }

    // --- flight mode --------------------------------------------------------
    let mode;
    if (this.modeMapped.ANGLE || this.modeMapped.HORIZON) {
      mode = this.modeActive.ANGLE ? 'angle' : (this.modeActive.HORIZON ? 'horizon' : 'acro');
    } else {
      mode = this._fallbackMode;
    }
    this.flightMode = mode;

    // --- BF: fc/core.c:processRx airmode / iterm-reset section --------------
    const rcThrottleUs = this.rc.rcData[CH_THROTTLE];
    const throttleActive = rcThrottleUs >= MINCHECK;
    const throttlePercent = Math.max(0, Math.min(100,
      Math.trunc(((Math.trunc(Math.min(Math.max(rcThrottleUs, 1000), PWM_RANGE_MAX)) - MINCHECK) * 100) / (PWM_RANGE_MAX - MINCHECK))));
    if (this.armed) {
      if (throttlePercent >= AIRMODE_START_THROTTLE_PERCENT) {
        this._throttleRaised = true; // Latch true until disarm
      }
      if (this.airmode) {
        this._airmodeActive = this._throttleRaised;
      }
    } else {
      this._throttleRaised = false;
      this._airmodeActive = false;
    }
    if (this.armed && (this._airmodeActive || throttleActive)) {
      this.pid.setItermReset(false);
      this.pid.setStabilisationState(true);
    } else {
      this.pid.setItermReset(true);
      this.pid.setStabilisationState(true); // pidAtMinThrottle = PID_STABILISATION_ON
    }
    this.pid.setAntiGravityState(true);   // FEATURE_ANTI_GRAVITY on by default

    // While disarmed the reason tracks whatever currently blocks arming
    // (BF shows its arming-disable flags the same way).
    if (!this.armed) this.armBlockReason = this._armingDisabledReason(this.armSource === 'switch');

    // --- BF loop: processRcCommand → gyro → pidController → mixTable -------
    this.rc.update(mode === 'horizon');

    const motorHz = MOTOR_HZ;
    const rpm = s.motorRpm || ZERO4;
    for (let i = 0; i < 4; i++) motorHz[i] = Math.abs(num(rpm[i], 0)) / 60;
    const gyroADCf = this.gyro.sample(s.trueRatesDps || ZERO4, motorHz);

    this.pid.run({
      rc: this.rc,
      gyroADCf,
      attitude,
      angleMode: mode === 'angle',
      horizonMode: mode === 'horizon',
      yawSpinActive: this.gyro.yawSpinDetected,
    });

    const motor = this.mixer.mixTable({
      timeUs,
      rc: this.rc,
      pid: this.pid,
      gyro: this.gyro,
      gyroADCf,
      armed: this.armed,
      airmodeEnabled: this.airmode,
      crashflipActive: this.crashflipActive,
      yawSpinDetected: this.gyro.yawSpinDetected,
      cosTilt: this._cosTilt,
    });
    for (let i = 0; i < 4; i++) {
      const v = this.armed ? motor[i] : 0;
      this.motors[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }

    // --- debug --------------------------------------------------------------
    const d = this.debug;
    for (let a = 0; a < 3; a++) {
      d.setpoint[a] = this.pid.previousPidSetpoint[a];
      d.gyro[a] = gyroADCf[a];
      d.P[a] = this.pid.P[a];
      d.I[a] = this.pid.I[a];
      d.D[a] = this.pid.D[a];
      d.F[a] = this.pid.F[a];
    }
    d.rcCommand[0] = this.rc.rcCommand[FD_ROLL];
    d.rcCommand[1] = this.rc.rcCommand[FD_PITCH];
    d.rcCommand[2] = this.rc.rcCommand[FD_YAW];
    d.rcCommand[3] = this.rc.getThrottleCommand();
    d.throttle = this.mixer.mixerThrottle;
    for (let i = 0; i < 4; i++) d.motorOutputs[i] = this.motors[i];

    this._out.armed = this.armed;
    this._out.flightMode = mode;
    this._out.crashflip = this.armed && this.crashflipActive;
    return this._out;
  }

  /** Brownout: the FC resets, drops the link and stays dark for 1.5 s. */
  _reboot() {
    this.disarm('brownout');
    this.armBlockReason = 'BROWNOUT';
    this._rebootTimer = BROWNOUT_REBOOT_S;
    this.rxLinkUp = false;
    this.failsafeActive = true;
    this._rxlossLatch = false;
    this._armSwitchSeenOff = false;
    this._armRequest = null;
    this.pid.init(this._cfg.pidTune, this.dT);
    this.gyro.configure(this._cfg.gyroCfg, this.dT);
    this.motors.fill(0);
    this._out.armed = false;
    this._out.crashflip = false;
  }

  /** Clear the flight state for a respawn (the radio link survives). */
  reset() {
    this.disarm('reset');
    this.armBlockReason = null;
    this._brownoutTimer = 0;
    this._rebootTimer = 0;
    this._armRequest = null;
    this.pid.init(this._cfg.pidTune, this.dT);
    this.gyro.configure(this._cfg.gyroCfg, this.dT);
    this.mixer.reset();
  }

  /** Channel index of the first AUX (for UIs). */
  static get AUX1() {
    return CH_AUX1;
  }
}

const MOTOR_HZ = new Float64Array(4);
const ZERO4 = [0, 0, 0, 0];
