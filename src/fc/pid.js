/**
 * fc/pid.js
 * ---------------------------------------------------------------------------
 * The rate PID controller and self-levelling, ported from Betaflight 2025.12
 * `src/main/flight/pid.c` and `pid_init.c` (GPL-3.0-or-later). Pure JS.
 *
 * Kept: the `pidController` loop body (error, I-term relax, P with the yaw
 * P low-pass, I, D with D-max, feedforward, anti-gravity P boost, sum),
 * `pidLevel` / `calcHorizonLevelStrength` with earth-referenced yaw, TPA
 * (classic curve with the low-throttle section), anti-gravity, the D-term
 * filter chain and dynamic D-term low-pass, thrust linearization, and yaw
 * spin recovery.
 * Skipped (as the plan specifies): wing / S-term / SPA, launch control, acro
 * trainer, chirp, GPS rescue and position hold, crash recovery (off by BF
 * default), acceleration limit (off by default), iterm rotation (off).
 *
 * Attitude comes from the physics body — a perfect attitude estimate in place
 * of BF's IMU — as `{ rollDeg, pitchDeg }` in BF's sign convention (roll + =
 * right wing down, pitch + = nose down).
 *
 * Axis convention: roll + = right wing down, pitch + = nose down, yaw + =
 * nose right. BF's yaw is + = nose left; the only place that difference is
 * visible inside the PID is the earth-referenced angle mode, where
 * `angleYawSetpoint` is stored in BF's sign.
 */

import {
  Pt1, Pt2, Pt3, PassThrough, makeLowpass, SvfNotch,
  pt1FilterGain, pt2FilterGain, pt3FilterGain, filterGetNotchQ, constrainf,
} from './filters.js';
import { FD_ROLL, FD_PITCH, FD_YAW } from './rc.js';

// BF: flight/pid.h
export const PID_MIXER_SCALING = 1000.0;
export const PIDSUM_LIMIT = 500;
export const PIDSUM_LIMIT_YAW = 400;
export const PIDSUM_LIMIT_MIN = 100;
export const PIDSUM_LIMIT_MAX = 1000;
export const PID_GAIN_MAX = 250;
export const F_GAIN_MAX = 1000;
export const PTERM_SCALE = 0.032029;
export const ITERM_SCALE = 0.244381;
export const DTERM_SCALE = 0.000529;
export const FEEDFORWARD_SCALE = 0.013754;
export const ITERM_RELAX_SETPOINT_THRESHOLD = 40.0;
export const ITERM_RELAX_CUTOFF_DEFAULT = 15;
export const ANTIGRAVITY_KI = 0.34;
export const ANTIGRAVITY_KP = 0.0034;

// BF: flight/pid_init.c
const D_MAX_RANGE_HZ = 85;    // PT2 lowpass input cutoff to peak D around propwash frequencies
const D_MAX_LOWPASS_HZ = 35;  // PT2 lowpass cutoff to smooth the boost effect
const D_MAX_GYRO_GAIN_FACTOR = 0.00008;
const D_MAX_SETPOINT_GAIN_FACTOR = 0.00008;
const ATTITUDE_CUTOFF_HZ = 50;

// BF: common/maths.h — RAD
const DEG2RAD = Math.PI / 180;

/**
 * BF 2025.12 `resetPidProfile` defaults, in BF units. `pid` holds P/I/D/Dmax/F
 * per axis (BF stores Dmax separately as `d_max[axis]`).
 */
export const PID_PROFILE_DEFAULTS = Object.freeze({
  pid: {
    roll: { p: 45, i: 80, d: 30, dMax: 40, f: 120 },
    pitch: { p: 47, i: 84, d: 34, dMax: 46, f: 125 },
    yaw: { p: 45, i: 80, d: 0, dMax: 0, f: 120 },
  },
  levelP: 50,
  levelI: 75,
  levelD: 75,
  levelF: 50,
  angleLimit: 60,
  pidSumLimit: PIDSUM_LIMIT,
  pidSumLimitYaw: PIDSUM_LIMIT_YAW,
  yawLowpassHz: 100,
  dtermNotchHz: 0,
  dtermNotchCutoff: 0,
  itermWindup: 80,
  antiGravityGain: 80,
  antiGravityCutoffHz: 5,
  antiGravityPGain: 100,
  horizonLimitDegrees: 135,
  horizonIgnoreSticks: false,
  horizonDelayMs: 500,
  angleEarthRef: 100,
  angleFeedforwardSmoothingMs: 80,
  itermRelax: 'rp',               // off | rp | rpy | rp_inc | rpy_inc
  itermRelaxType: 'setpoint',     // gyro | setpoint
  itermRelaxCutoff: ITERM_RELAX_CUTOFF_DEFAULT,
  dtermLpf1StaticHz: 75,
  dtermLpf1DynMinHz: 75,
  dtermLpf1DynMaxHz: 150,
  dtermLpf1DynExpo: 5,
  dtermLpf2StaticHz: 150,
  tpaMode: 'd',                   // pd | d
  tpaRate: 65,
  tpaBreakpoint: 1350,
  tpaLowRate: 20,
  tpaLowBreakpoint: 1050,
  tpaLowAlways: 0,
  dMaxGain: 0,
  dMaxAdvance: 35,
  thrustLinearization: 0,
  throttleBoost: 5,
  throttleBoostCutoff: 15,
  motorOutputLimit: 100,
});

const PWM_RANGE_MIN = 1000;

/** Deep-merge a partial tune over the BF defaults. */
export function resolvePidProfile(tune) {
  const t = tune || {};
  const base = PID_PROFILE_DEFAULTS;
  const axis = (name) => ({ ...base.pid[name], ...((t.pid && t.pid[name]) || {}) });
  return { ...base, ...t, pid: { roll: axis('roll'), pitch: axis('pitch'), yaw: axis('yaw') } };
}

// BF: flight/pid.c:dynLpfCutoffFreq
export function dynLpfCutoffFreq(throttle, dynLpfMin, dynLpfMax, expo) {
  const expof = expo / 10.0;
  const curve = throttle * (1 - throttle) * expof + throttle;
  return (dynLpfMax - dynLpfMin) * curve + dynLpfMin;
}

// BF: sensors/gyro.c:dynThrottle
export function dynThrottle(throttle) {
  return throttle * (1 - (throttle * throttle) / 3.0) * 1.5;
}

const AXIS_NAMES = ['roll', 'pitch', 'yaw'];

export class PidController {
  /**
   * @param {object} tune  partial PID profile (see PID_PROFILE_DEFAULTS)
   * @param {number} dT    PID loop period, s
   */
  constructor(tune, dT) {
    /** pidData[axis] */
    this.P = new Float64Array(3);
    this.I = new Float64Array(3);
    this.D = new Float64Array(3);
    this.F = new Float64Array(3);
    this.Sum = new Float64Array(3);

    this.previousGyroRateDterm = new Float64Array(3);
    this.previousPidSetpoint = new Float64Array(3);
    this.angleTarget = new Float64Array(2);
    this.angleYawSetpoint = 0.0;
    this.axisInAngleMode = [false, false, false];

    this.antiGravityThrottleD = 0.0;
    this.itermAccelerator = 0.0;
    this.antiGravityEnabled = true;
    this.pidStabilisationEnabled = true;
    this.zeroThrottleItermReset = false;
    this._agPreviousThrottle = 0.0;
    this._isTpaLowFaded = false;
    this.tpaFactor = 1.0;

    this.init(tune, dT);
  }

  // BF: flight/pid_init.c:pidInit
  init(tune, dT) {
    this.profile = resolvePidProfile(tune);
    // BF: flight/pid_init.c:pidSetTargetLooptime
    this.dT = dT;
    this.pidFrequency = 1.0 / dT;
    this.initFilters();
    this.initConfig();
  }

  /** Re-read the profile without resetting filter state (BF pidInitConfig). */
  setTune(tune) {
    const prev = this.profile;
    this.profile = resolvePidProfile(tune);
    const p = this.profile;
    const filtersChanged = !prev
      || prev.dtermLpf1StaticHz !== p.dtermLpf1StaticHz
      || prev.dtermLpf1DynMinHz !== p.dtermLpf1DynMinHz
      || prev.dtermLpf1DynMaxHz !== p.dtermLpf1DynMaxHz
      || prev.dtermLpf2StaticHz !== p.dtermLpf2StaticHz
      || prev.yawLowpassHz !== p.yawLowpassHz
      || prev.itermRelaxCutoff !== p.itermRelaxCutoff
      || prev.antiGravityCutoffHz !== p.antiGravityCutoffHz
      || prev.dtermNotchHz !== p.dtermNotchHz
      || prev.dtermNotchCutoff !== p.dtermNotchCutoff
      || prev.angleFeedforwardSmoothingMs !== p.angleFeedforwardSmoothingMs
      || prev.horizonDelayMs !== p.horizonDelayMs;
    if (filtersChanged) this.initFilters();
    this.initConfig();
  }

  // BF: flight/pid_init.c:pidInitFilters
  initFilters() {
    const p = this.profile;
    const dT = this.dT;

    // limit to 95% of the nyquist to help with stability
    const pidFrequencyNyquist = Math.trunc((this.pidFrequency / 2.0) * 0.95);

    let dTermNotchHz;
    if (p.dtermNotchHz <= pidFrequencyNyquist) {
      dTermNotchHz = p.dtermNotchHz;
    } else if (p.dtermNotchCutoff < pidFrequencyNyquist) {
      dTermNotchHz = pidFrequencyNyquist;
    } else {
      dTermNotchHz = 0;
    }
    this.dtermNotch = [0, 1, 2].map(() => (dTermNotchHz !== 0 && p.dtermNotchCutoff !== 0
      ? new SvfNotch(dTermNotchHz, dT, filterGetNotchQ(dTermNotchHz, p.dtermNotchCutoff))
      : new PassThrough()));

    // 1st Dterm Lowpass Filter (PT1)
    let dtermLpf1InitHz = p.dtermLpf1StaticHz;
    if (p.dtermLpf1DynMinHz) {
      dtermLpf1InitHz = p.dtermLpf1DynMinHz;
    }
    this.dtermLowpass = [0, 1, 2].map(() => makeLowpass(1, dtermLpf1InitHz, dT));

    // 2nd Dterm Lowpass Filter (PT1)
    this.dtermLowpass2 = [0, 1, 2].map(() => makeLowpass(1, p.dtermLpf2StaticHz, dT));

    this.ptermYawLowpass = p.yawLowpassHz === 0
      ? new PassThrough()
      : makeLowpass(1, p.yawLowpassHz, dT);

    // USE_ITERM_RELAX
    this.windupLpf = [0, 1, 2].map(() => new Pt1(pt1FilterGain(p.itermRelaxCutoff, dT)));

    // USE_D_MAX
    this.dMaxRange = [0, 1, 2].map(() => new Pt2(pt2FilterGain(D_MAX_RANGE_HZ, dT)));
    this.dMaxLowpass = [0, 1, 2].map(() => new Pt2(pt2FilterGain(D_MAX_LOWPASS_HZ, dT)));

    // USE_ACC
    const k = pt3FilterGain(ATTITUDE_CUTOFF_HZ, dT);
    const angleCutoffHz = 1000.0 / (2.0 * Math.PI * p.angleFeedforwardSmoothingMs);
    const k2 = pt3FilterGain(angleCutoffHz, dT);
    this.horizonDelayMs = p.horizonDelayMs;
    if (this.horizonDelayMs) {
      const horizonSmoothingHz = 1e3 / (2.0 * Math.PI * p.horizonDelayMs);
      this.horizonSmoothingPt1 = new Pt1(pt1FilterGain(horizonSmoothingHz, dT));
    } else {
      this.horizonSmoothingPt1 = null;
    }
    this.attitudeFilter = [new Pt3(k), new Pt3(k)];
    this.angleFeedforwardPt3 = [new Pt3(k2), new Pt3(k2)];
    this.angleYawSetpoint = 0.0;

    this.antiGravityLpf = new Pt2(pt2FilterGain(p.antiGravityCutoffHz, dT));
  }

  // BF: flight/pid_init.c:pidInitConfig
  initConfig() {
    const p = this.profile;
    this.Kp = new Float64Array(3);
    this.Ki = new Float64Array(3);
    this.Kd = new Float64Array(3);
    this.Kf = new Float64Array(3);
    for (let axis = FD_ROLL; axis <= FD_YAW; axis++) {
      const g = p.pid[AXIS_NAMES[axis]];
      this.Kp[axis] = PTERM_SCALE * g.p;
      this.Ki[axis] = ITERM_SCALE * g.i;
      this.Kd[axis] = DTERM_SCALE * g.d;
      this.Kf[axis] = FEEDFORWARD_SCALE * (g.f * 0.01);
    }
    this.Ki[FD_YAW] *= 2.5;
    this.angleGain = p.levelP / 10.0;
    this.angleFeedforwardGain = p.levelF / 100.0;
    this.angleEarthRef = p.angleEarthRef / 100.0;
    this.horizonGain = Math.min(p.levelI / 100.0, 1.0);
    this.horizonIgnoreSticks = p.horizonIgnoreSticks ? 1.0 : 0.0;

    this.horizonLimitSticks = p.levelD / 100.0;
    this.horizonLimitSticksInv = p.levelD ? 1.0 / this.horizonLimitSticks : 1.0;
    this.horizonLimitDegrees = p.horizonLimitDegrees;
    this.horizonLimitDegreesInv = p.horizonLimitDegrees ? 1.0 / this.horizonLimitDegrees : 1.0;
    this.horizonDelayMs = p.horizonDelayMs;

    this.antiGravityGain = p.antiGravityGain;
    this.itermLimit = 0.01 * p.itermWindup * p.pidSumLimit;
    this.itermLimitYaw = 0.01 * p.itermWindup * p.pidSumLimitYaw;
    this.pidSumLimit = p.pidSumLimit;
    this.pidSumLimitYaw = p.pidSumLimitYaw;
    this.antiGravityPGain = (p.antiGravityPGain / 100.0) * ANTIGRAVITY_KP;

    this.itermRelax = p.itermRelax;
    this.itermRelaxType = p.itermRelaxType;
    this.itermRelaxCutoff = p.itermRelaxCutoff;

    // USE_DYN_LPF (D-term lowpass 1 is PT1)
    this.dynLpfEnabled = p.dtermLpf1DynMinHz > 0;
    this.dynLpfMin = p.dtermLpf1DynMinHz;
    this.dynLpfMax = p.dtermLpf1DynMaxHz;
    this.dynLpfCurveExpo = p.dtermLpf1DynExpo;

    this.thrustLinearization = p.thrustLinearization / 100.0;

    // USE_D_MAX
    this.dMaxPercent = new Float64Array(3);
    for (let axis = FD_ROLL; axis <= FD_YAW; axis++) {
      const g = p.pid[AXIS_NAMES[axis]];
      const dMax = g.dMax;
      if ((g.d > 0) && dMax > g.d) {
        this.dMaxPercent[axis] = dMax / g.d;
      } else {
        this.dMaxPercent[axis] = 1.0;
      }
    }
    const dmaxLpfInv = 1.0 / D_MAX_LOWPASS_HZ;
    this.dMaxGyroGain = D_MAX_GYRO_GAIN_FACTOR * p.dMaxGain * dmaxLpfInv;
    this.dMaxSetpointGain = D_MAX_SETPOINT_GAIN_FACTOR * p.dMaxAdvance * dmaxLpfInv;

    this.tpaMode = p.tpaMode;
    this.tpaBreakpoint = constrainf((p.tpaBreakpoint - PWM_RANGE_MIN) / 1000.0, 0.0, 0.99);
    this.tpaMultiplier = (p.tpaRate / 100.0) / (1.0 - this.tpaBreakpoint);
    this.tpaLowBreakpoint = constrainf((p.tpaLowBreakpoint - PWM_RANGE_MIN) / 1000.0, 0.01, 1.0);
    this.tpaLowBreakpoint = Math.min(this.tpaLowBreakpoint, this.tpaBreakpoint);
    this.tpaLowMultiplier = p.tpaLowRate / (100.0 * this.tpaLowBreakpoint);
    this.tpaLowAlways = p.tpaLowAlways;
  }

  /* ---------------------------------------------------------------------- *
   * State hooks called from the FC core and the mixer
   * ---------------------------------------------------------------------- */

  // BF: flight/pid.c:pidResetIterm
  resetIterm() {
    this.I[0] = this.I[1] = this.I[2] = 0.0;
  }

  // BF: flight/pid.c:pidSetItermReset
  setItermReset(enabled) {
    this.zeroThrottleItermReset = !!enabled;
  }

  // BF: flight/pid.c:pidStabilisationState
  setStabilisationState(on) {
    this.pidStabilisationEnabled = !!on;
  }

  // BF: flight/pid.c:pidSetAntiGravityState
  setAntiGravityState(newState) {
    if (newState !== this.antiGravityEnabled) {
      // reset the accelerator on state changes
      this.itermAccelerator = 0.0;
    }
    this.antiGravityEnabled = newState;
  }

  // BF: flight/pid.c:getTpaFactorClassic
  _getTpaFactorClassic(tpaArgument) {
    const isThrottlePastTpaLowBreakpoint = (tpaArgument >= this.tpaLowBreakpoint || this.tpaLowBreakpoint <= 0.01);
    let tpaRate = 0.0;
    if (isThrottlePastTpaLowBreakpoint || this._isTpaLowFaded) {
      tpaRate = this.tpaMultiplier * Math.max(tpaArgument - this.tpaBreakpoint, 0.0);
      if (!this.tpaLowAlways && !this._isTpaLowFaded) {
        this._isTpaLowFaded = true;
      }
    } else {
      tpaRate = this.tpaLowMultiplier * (this.tpaLowBreakpoint - tpaArgument);
    }
    return 1.0 - tpaRate;
  }

  // BF: flight/pid.c:pidUpdateTpaFactor
  updateTpaFactor(throttle) {
    const tpaArgument = constrainf(throttle, 0.0, 1.0);
    this.tpaFactor = this._getTpaFactorClassic(tpaArgument);
  }

  // BF: flight/pid.c:getTpaFactor
  _getTpaFactor(term) {
    if (term === 'P') {
      return this.tpaMode === 'pd' ? this.tpaFactor : 1.0;
    }
    if (term === 'D') {
      return this.tpaFactor;
    }
    return 1.0;
  }

  // BF: flight/pid.c:pidUpdateAntiGravityThrottleFilter
  updateAntiGravityThrottleFilter(throttle) {
    const previousThrottle = this._agPreviousThrottle;
    const throttleInv = 1.0 - throttle;
    let throttleDerivative = Math.abs(throttle - previousThrottle) * this.pidFrequency;
    throttleDerivative *= throttleInv * throttleInv;
    // generally focus on the low throttle period
    if (throttle > previousThrottle) {
      throttleDerivative *= throttleInv * 0.5;
      // when increasing throttle, focus even more on the low throttle range
    }
    this._agPreviousThrottle = throttle;
    throttleDerivative = this.antiGravityLpf.apply(throttleDerivative);
    this.antiGravityThrottleD = throttleDerivative;
  }

  // BF: flight/pid.c:dynLpfDTermUpdate (PT1 D-term lowpass 1)
  dynLpfDTermUpdate(throttle) {
    if (!this.dynLpfEnabled) return;
    let cutoffFreq;
    if (this.dynLpfCurveExpo > 0) {
      cutoffFreq = dynLpfCutoffFreq(throttle, this.dynLpfMin, this.dynLpfMax, this.dynLpfCurveExpo);
    } else {
      cutoffFreq = Math.max(dynThrottle(throttle) * this.dynLpfMax, this.dynLpfMin);
    }
    this.dtermLpfCutoffHz = cutoffFreq;
    const k = pt1FilterGain(cutoffFreq, this.dT);
    for (let axis = FD_ROLL; axis <= FD_YAW; axis++) {
      this.dtermLowpass[axis].updateCutoff(k);
    }
  }

  // BF: flight/pid.c:pidApplyThrustLinearization
  applyThrustLinearization(motorOutput) {
    const e = this.thrustLinearization;
    const inv = 1.0 - motorOutput;
    motorOutput *= 1.0 + e * inv * (1.0 + e * (inv - motorOutput));
    return motorOutput;
  }

  // BF: flight/pid.c:pidCompensateThrustLinearization
  compensateThrustLinearization(throttle) {
    if (this.thrustLinearization !== 0.0) {
      const e = this.thrustLinearization;
      throttle *= 1.0 - e * (1.0 - throttle);
    }
    return throttle;
  }

  /* ---------------------------------------------------------------------- *
   * Self-levelling
   * ---------------------------------------------------------------------- */

  // BF: flight/pid.c:calcHorizonLevelStrength
  _calcHorizonLevelStrength(rc, attitude) {
    const currentInclination = Math.max(Math.abs(attitude.rollDeg), Math.abs(attitude.pitchDeg));
    // 0 when level, 90 when vertical, 180 when inverted (degrees):
    const absMaxStickDeflection = Math.max(Math.abs(rc.getRcDeflection(FD_ROLL)), Math.abs(rc.getRcDeflection(FD_PITCH)));

    let horizonLevelStrength = Math.max((this.horizonLimitDegrees - currentInclination) * this.horizonLimitDegreesInv, 0.0);
    horizonLevelStrength *= Math.max((this.horizonLimitSticks - absMaxStickDeflection) * this.horizonLimitSticksInv, this.horizonIgnoreSticks);
    horizonLevelStrength *= this.horizonGain;

    if (this.horizonDelayMs && this.horizonSmoothingPt1) {
      const horizonLevelStrengthSmoothed = this.horizonSmoothingPt1.apply(horizonLevelStrength);
      horizonLevelStrength = Math.min(horizonLevelStrength, horizonLevelStrengthSmoothed);
    }
    return horizonLevelStrength;
  }

  // BF: flight/pid.c:pidLevel
  _pidLevel(axis, rc, attitude, currentPidSetpoint, horizonLevelStrength, angleModeActive) {
    const angleLimit = this.profile.angleLimit;
    let angleFeedforward = 0.0;
    const maxSetpointRateInv = 1.0 / rc.getMaxRcRate(axis);

    angleFeedforward = angleLimit * rc.getFeedforward(axis) * this.angleFeedforwardGain * maxSetpointRateInv;
    // angle feedforward must be heavily filtered, at the PID loop rate
    angleFeedforward = this.angleFeedforwardPt3[axis].apply(angleFeedforward);

    let angleTarget = angleLimit * currentPidSetpoint * maxSetpointRateInv;
    angleTarget = constrainf(angleTarget, -angleLimit, angleLimit);

    const currentAngle = axis === FD_ROLL ? attitude.rollDeg : attitude.pitchDeg;
    const errorAngle = angleTarget - currentAngle;
    let angleRate = errorAngle * this.angleGain + angleFeedforward;

    // minimise cross-axis wobble due to faster yaw responses than roll or pitch, and make co-ordinated yaw turns
    let sinAngle = Math.sin(this.angleTarget[axis === FD_ROLL ? FD_PITCH : FD_ROLL] * DEG2RAD);
    sinAngle *= (axis === FD_ROLL) ? -1.0 : 1.0; // must be negative for Roll
    const earthRefGain = this.angleEarthRef;
    angleRate += this.angleYawSetpoint * sinAngle * earthRefGain;
    this.angleTarget[axis] = angleTarget;

    // smooth final angle rate output to clean up attitude signal steps
    angleRate = this.attitudeFilter[axis].apply(angleRate);

    if (angleModeActive) {
      currentPidSetpoint = angleRate;
    } else {
      // can only be HORIZON mode - crossfade Angle rate and Acro rate
      currentPidSetpoint = currentPidSetpoint * (1.0 - horizonLevelStrength) + angleRate * horizonLevelStrength;
    }
    return currentPidSetpoint;
  }

  // BF: flight/pid.c:applyItermRelax
  _applyItermRelax(axis, iterm, gyroRate, itermErrorRate, currentPidSetpoint, angleModeActive) {
    const setpointLpf = this.windupLpf[axis].apply(currentPidSetpoint);
    const setpointHpf = Math.abs(currentPidSetpoint - setpointLpf);

    const mode = this.itermRelax;
    if (mode && mode !== 'off') {
      if (axis < FD_YAW || mode === 'rpy' || mode === 'rpy_inc') {
        let itermRelaxThreshold = ITERM_RELAX_SETPOINT_THRESHOLD;
        if (angleModeActive) {
          itermRelaxThreshold *= 0.2;
        }
        const itermRelaxFactor = Math.max(0, 1 - setpointHpf / itermRelaxThreshold);
        const isDecreasingI = ((iterm > 0) && (itermErrorRate < 0)) || ((iterm < 0) && (itermErrorRate > 0));
        if ((mode === 'rp_inc' || mode === 'rpy_inc') && isDecreasingI) {
          // Do Nothing, use the precalculed itermErrorRate
        } else if (this.itermRelaxType === 'setpoint') {
          itermErrorRate *= itermRelaxFactor;
        } else if (this.itermRelaxType === 'gyro') {
          const db = setpointHpf;
          const v = setpointLpf - gyroRate;
          itermErrorRate = Math.abs(v) < db ? 0 : (v >= 0 ? v - db : v + db);
        } else {
          itermErrorRate = 0.0;
        }
      }
    }
    return itermErrorRate;
  }

  /* ---------------------------------------------------------------------- *
   * The controller
   * ---------------------------------------------------------------------- */

  // BF: flight/pid.c:pidController
  /**
   * One PID loop.
   * @param {object} s
   * @param {import('./rc.js').RcProcessor} s.rc
   * @param {Float64Array|number[]} s.gyroADCf   filtered gyro, deg/s
   * @param {{rollDeg:number,pitchDeg:number}} s.attitude
   * @param {boolean} s.angleMode
   * @param {boolean} s.horizonMode
   * @param {boolean} s.yawSpinActive
   */
  run({ rc, gyroADCf, attitude, angleMode, horizonMode, yawSpinActive }) {
    let horizonLevelStrength = 0.0;
    let levelMode = 'off';
    if (angleMode || horizonMode) {
      levelMode = 'rp';
      if (horizonMode && !angleMode) {
        horizonLevelStrength = this._calcHorizonLevelStrength(rc, attitude);
      }
    }
    // ANGLE takes precedence over HORIZON (BF FLIGHT_MODE(ANGLE_MODE) tests).
    const angleModeActive = !!angleMode;

    // Anti Gravity
    if (this.antiGravityEnabled) {
      this.antiGravityThrottleD *= this.antiGravityGain;
      // used later to increase pTerm
      this.itermAccelerator = this.antiGravityThrottleD * ANTIGRAVITY_KI;
    } else {
      this.antiGravityThrottleD = 0.0;
      this.itermAccelerator = 0.0;
    }

    // Precalculate gyro delta for D-term here, this allows loop unrolling
    const gyroRateDterm = GYRO_RATE_DTERM;
    for (let axis = FD_ROLL; axis <= FD_YAW; ++axis) {
      let g = gyroADCf[axis];
      g = this.dtermNotch[axis].apply(g);
      g = this.dtermLowpass[axis].apply(g);
      g = this.dtermLowpass2[axis].apply(g);
      gyroRateDterm[axis] = g;
    }

    // ----------PID controller----------
    for (let axis = FD_ROLL; axis <= FD_YAW; ++axis) {
      let currentPidSetpoint = rc.getSetpointRate(axis);

      this.axisInAngleMode[axis] = false;
      if (axis < FD_YAW) {
        if (levelMode === 'rp') {
          this.axisInAngleMode[axis] = true;
          currentPidSetpoint = this._pidLevel(axis, rc, attitude, currentPidSetpoint, horizonLevelStrength, angleModeActive);
        }
      } else if (levelMode === 'rp') {
        // if earth referencing is requested, attenuate yaw axis setpoint when pitched or rolled
        // and send yawSetpoint to Angle code to modulate pitch and roll
        const earthRefGain = this.angleEarthRef;
        if (earthRefGain) {
          // Stored in BF's yaw sign (+ = nose left) for pidLevel's cross terms.
          this.angleYawSetpoint = -currentPidSetpoint;
          let maxAngleTargetAbs = earthRefGain * Math.max(Math.abs(this.angleTarget[FD_ROLL]), Math.abs(this.angleTarget[FD_PITCH]));
          maxAngleTargetAbs *= (horizonMode && !angleModeActive) ? horizonLevelStrength : 1.0;
          currentPidSetpoint *= Math.cos(maxAngleTargetAbs * DEG2RAD);
        }
      }

      // Handle yaw spin recovery - zero the setpoint on yaw to aid in recovery
      if ((axis === FD_YAW) && yawSpinActive) {
        currentPidSetpoint = 0.0;
      }

      // -----calculate error rate
      const gyroRate = gyroADCf[axis];
      let errorRate = currentPidSetpoint - gyroRate; // r - y

      const previousIterm = this.I[axis];
      let itermErrorRate = errorRate;

      itermErrorRate = this._applyItermRelax(axis, previousIterm, gyroRate, itermErrorRate, currentPidSetpoint, angleModeActive);
      errorRate = currentPidSetpoint - gyroRate;

      // -----calculate P component
      this.P[axis] = this.Kp[axis] * errorRate * this._getTpaFactor('P');
      if (axis === FD_YAW) {
        this.P[axis] = this.ptermYawLowpass.apply(this.P[axis]);
      }

      // -----calculate I component
      const Ki = this.Ki[axis];
      let itermLimit = this.itermLimit;
      if (axis === FD_YAW) {
        itermLimit = this.itermLimitYaw;
        this.itermAccelerator = 0.0; // no antigravity on yaw iTerm
      }

      const iTermChange = (Ki + this.itermAccelerator) * this.dT * itermErrorRate;
      this.I[axis] = constrainf(previousIterm + iTermChange, -itermLimit, itermLimit);

      // -----calculate D component
      let pidSetpointDelta = 0;
      if (angleModeActive && this.axisInAngleMode[axis]) {
        // this axis is fully under self-levelling control
        pidSetpointDelta = 0.0;
      } else {
        pidSetpointDelta = rc.getFeedforward(axis);
      }
      this.previousPidSetpoint[axis] = currentPidSetpoint;

      if (this.Kd[axis] > 0) {
        const delta = -(gyroRateDterm[axis] - this.previousGyroRateDterm[axis]) * this.pidFrequency;
        let preTpaD = this.Kd[axis] * delta;

        let dMaxMultiplier = 1.0;
        if (this.dMaxPercent[axis] > 1.0) {
          let dMaxGyroFactor = this.dMaxRange[axis].apply(delta);
          dMaxGyroFactor = Math.abs(dMaxGyroFactor) * this.dMaxGyroGain;
          const dMaxSetpointFactor = Math.abs(pidSetpointDelta) * this.dMaxSetpointGain;
          const dMaxBoost = Math.max(dMaxGyroFactor, dMaxSetpointFactor);
          // dMaxBoost starts at zero, and by 1.0 we get Dmax, but it can exceed 1.
          dMaxMultiplier += (this.dMaxPercent[axis] - 1.0) * dMaxBoost;
          dMaxMultiplier = this.dMaxLowpass[axis].apply(dMaxMultiplier);
          // limit the gain to the fraction that DMax is greater than Min
          dMaxMultiplier = Math.min(dMaxMultiplier, this.dMaxPercent[axis]);
        }
        preTpaD *= dMaxMultiplier;
        this.D[axis] = preTpaD * this._getTpaFactor('D');
      } else {
        this.D[axis] = 0;
      }

      this.previousGyroRateDterm[axis] = gyroRateDterm[axis];

      // -----calculate feedforward component
      this.F[axis] = this.Kf[axis] * pidSetpointDelta;

      if (yawSpinActive) {
        this.I[axis] = 0; // in yaw spin always disable I
        if (axis <= FD_PITCH) {
          // zero PIDs on pitch and roll leaving yaw P to correct spin
          this.P[axis] = 0;
          this.D[axis] = 0;
          this.F[axis] = 0;
        }
      }

      // Add P boost from antiGravity when sticks are close to zero
      if (axis !== FD_YAW) {
        let agSetpointAttenuator = Math.abs(currentPidSetpoint) / 50.0;
        agSetpointAttenuator = Math.max(agSetpointAttenuator, 1.0);
        // attenuate effect if turning more than 50 deg/s, half at 100 deg/s
        const antiGravityPBoost = 1.0 + (this.antiGravityThrottleD / agSetpointAttenuator) * this.antiGravityPGain;
        this.P[axis] *= antiGravityPBoost;
      }

      // calculating the PID sum
      this.Sum[axis] = this.P[axis] + this.I[axis] + this.D[axis] + this.F[axis];
    }

    // Disable PID control if at zero throttle or if gyro overflow detected
    if (!this.pidStabilisationEnabled) {
      for (let axis = FD_ROLL; axis <= FD_YAW; ++axis) {
        this.P[axis] = 0;
        this.I[axis] = 0;
        this.D[axis] = 0;
        this.F[axis] = 0;
        this.Sum[axis] = 0;
      }
    } else if (this.zeroThrottleItermReset) {
      this.resetIterm();
    }

    // A non-finite term (garbage upstream) must never reach the mixer.
    for (let axis = FD_ROLL; axis <= FD_YAW; ++axis) {
      if (!Number.isFinite(this.Sum[axis])) {
        this.P[axis] = this.I[axis] = this.D[axis] = this.F[axis] = this.Sum[axis] = 0;
      }
    }
  }
}

const GYRO_RATE_DTERM = new Float64Array(3);
