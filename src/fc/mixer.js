/**
 * fc/mixer.js
 * ---------------------------------------------------------------------------
 * The motor mixer, ported from Betaflight 2025.12 `src/main/flight/mixer.c`
 * and `mixer_init.c` (GPL-3.0-or-later). Pure JS.
 *
 * Motor order is the sim's: 0 FL, 1 FR, 2 RL, 3 RR.
 * FC axis convention: roll + = right wing down, pitch + = nose down,
 * yaw + = nose right. BF negates the yaw PID sum in the mixer (props-in,
 * `yaw_motors_reversed` off); here the yaw column below already carries that
 * sign, so the yaw PID sum is used as is.
 *
 *   SIGN TABLE — which motors a positive command speeds up / slows down
 *
 *   | command              | motors up                    | motors down        |
 *   |----------------------|------------------------------|--------------------|
 *   | +roll (right)        | FL, RL                       | FR, RR             |
 *   | +pitch (nose down)   | RL, RR                       | FL, FR             |
 *   | +yaw (nose right)    | FR, RL (CCW props, props-in) | FL, RR (CW props)  |
 *
 *   Mix table {thr, roll, pitch, yaw} (BF `mixerQuadX`, reordered):
 *     FL {1, +1, -1, -1}   FR {1, -1, -1, +1}
 *     RL {1, +1, +1, +1}   RR {1, -1, +1, -1}
 *
 * Output is a normalised motor duty: 0 = stopped (disarmed / DShot stop),
 * `motorOutputLow = dshotIdle` .. `motorOutputHigh = motor_output_limit/100`
 * while armed. Crash-flip (turtle) mode outputs negative duty: the ESC runs
 * the motor in reverse.
 */

import { Pt1, pt1FilterGain, constrainf, scaleRangef } from './filters.js';
import { PID_MIXER_SCALING, PIDSUM_LIMIT_MAX } from './pid.js';
import { FD_ROLL, FD_PITCH, FD_YAW } from './rc.js';

export const MOTOR_NAMES = ['FL', 'FR', 'RL', 'RR'];

/** {throttle, roll, pitch, yaw} per motor — rows of the sign table above. */
export const QUAD_X_MIX = Object.freeze([
  Object.freeze({ throttle: 1, roll: +1, pitch: -1, yaw: -1 }), // FL (CW)
  Object.freeze({ throttle: 1, roll: -1, pitch: -1, yaw: +1 }), // FR (CCW)
  Object.freeze({ throttle: 1, roll: +1, pitch: +1, yaw: +1 }), // RL (CCW)
  Object.freeze({ throttle: 1, roll: -1, pitch: +1, yaw: -1 }), // RR (CW)
]);

// BF: flight/mixer.c
const DYN_LPF_THROTTLE_STEPS = 100;
const DYN_LPF_THROTTLE_UPDATE_DELAY_US = 5000; // minimum of 5ms between updates
export const CRASHFLIP_MOTOR_DEADBAND = 0.02;  // 2%; send 'disarm' value to motors below this drive value
export const CRASHFLIP_STICK_DEADBAND = 0.15;  // 15%

/**
 * BF 2025.12 defaults. `crashflip_expo` no longer exists in 2025.12
 * `mixer.c`; its role is taken by `crashflip_rate` (stop pushing once the
 * quad is rotating) and the stick deadband.
 */
export const MIXER_DEFAULTS = Object.freeze({
  dshotIdle: 0.055,          // motorOutputLow, normalised (dshot_idle_value 550)
  motorOutputLimit: 100,     // %
  throttleBoost: 5,
  throttleBoostCutoff: 15,
  thrustLinearization: 0,
  mixerType: 'legacy',
  crashflipMotorPercent: 0,
  crashflipRate: 30,
});

// BF: flight/mixer.c:DEFINE_SCALE_FN(scaleAirmodeTransition, 0.0f, 0.5f, 0.5f, 1.0f)
export function scaleAirmodeTransition(x) {
  return scaleRangef(x, 0.0, 0.5, 0.5, 1.0);
}

export class Mixer {
  constructor(cfg, dT) {
    this.motor = new Float64Array(4);
    this.motorMix = new Float64Array(4);
    this.motorMixRange = 0;
    this.throttle = 0;
    this.rcThrottle = 0;
    this.mixerThrottle = 0;
    this.motorOutputMin = 0;
    this.motorRangeMin = 0;
    this.motorRangeMax = 1;
    this.motorOutputRange = 1;
    this.motorOutputMixSign = 1;
    this.crashflipSuccess = false;
    this._isTiltAngleAtStartSet = false;
    this._tiltAngleAtStart = 1.0;
    this._lastDynLpfUpdateUs = 0;
    this._dynLpfPreviousQuantizedThrottle = -1;
    this.configure(cfg, dT);
  }

  // BF: flight/mixer_init.c:initEscEndpoints, flight/pid_init.c (throttle boost)
  configure(cfg, dT) {
    const c = { ...MIXER_DEFAULTS, ...(cfg || {}) };
    this.cfg = c;
    this.dT = dT;
    let motorOutputLimit = 1.0;
    if (c.motorOutputLimit < 100) {
      motorOutputLimit = c.motorOutputLimit / 100.0;
    }
    // dshotInitEndpoints: low = MIN + idle offset, high = MAX − range·(1 − limit)
    this.motorOutputLow = constrainf(c.dshotIdle, 0, 0.5);
    this.motorOutputHigh = motorOutputLimit;
    this.disarmMotorOutput = 0;
    this.throttleBoost = c.throttleBoost * 0.1;
    const k = pt1FilterGain(c.throttleBoostCutoff, dT);
    if (this.throttleLpf) this.throttleLpf.updateCutoff(k);
    else this.throttleLpf = new Pt1(k);
    this.currentMixer = QUAD_X_MIX;
  }

  reset() {
    this.motor.fill(0);
    this.throttleLpf.reset(0);
    this._isTiltAngleAtStartSet = false;
  }

  // BF: flight/mixer.c:calculateThrottleAndCurrentMotorEndpoints (non-3D branch)
  _calculateThrottleAndCurrentMotorEndpoints(rcThrottle01) {
    this.throttle = rcThrottle01;
    this.motorRangeMax = this.motorOutputHigh;
    this.motorRangeMin = this.motorOutputLow;
    this.motorOutputMin = this.motorRangeMin;
    this.motorOutputRange = this.motorRangeMax - this.motorRangeMin;
    this.motorOutputMixSign = 1;
    this.throttle = constrainf(this.throttle, 0.0, 1.0);
    this.rcThrottle = this.throttle;
  }

  // BF: flight/mixer.c:applyCrashFlipModeToMotors
  _applyCrashFlipModeToMotors(s) {
    if (!s.crashflipActive) {
      // keep clearing the tiltAngleSet flag while crashFlip mode is not active
      this._isTiltAngleAtStartSet = false;
      return false;
    }
    const rc = s.rc;
    const stickDeflectionPitchAbs = rc.getRcDeflectionAbs(FD_PITCH);
    const stickDeflectionRollAbs = rc.getRcDeflectionAbs(FD_ROLL);
    const stickDeflectionYawAbs = rc.getRcDeflectionAbs(FD_YAW);

    let signPitch = rc.getRcDeflection(FD_PITCH) < 0 ? 1 : -1;
    let signRoll = rc.getRcDeflection(FD_ROLL) < 0 ? 1 : -1;
    // BF: (getRcDeflection(FD_YAW) < 0 ? 1 : -1) * (yaw_motors_reversed ? 1 : -1),
    // with BF's yaw deflection being the negative of ours.
    let signYaw = (rc.getRcDeflection(FD_YAW) > 0 ? 1 : -1) * -1;

    let stickDeflectionLength = Math.sqrt(stickDeflectionPitchAbs * stickDeflectionPitchAbs + stickDeflectionRollAbs * stickDeflectionRollAbs);

    if (stickDeflectionYawAbs > Math.max(stickDeflectionPitchAbs, stickDeflectionRollAbs)) {
      // If yaw is the dominant, disable pitch and roll
      stickDeflectionLength = stickDeflectionYawAbs;
      signRoll = 0;
      signPitch = 0;
    } else {
      // If pitch/roll dominant, disable yaw
      signYaw = 0;
    }

    const cosPhi = (stickDeflectionLength > 0) ? (stickDeflectionPitchAbs + stickDeflectionRollAbs) / (Math.sqrt(2.0) * stickDeflectionLength) : 0;
    const cosThreshold = Math.sqrt(3.0) / 2.0; // cos(30 deg)

    if (cosPhi < cosThreshold) {
      // Enforce either roll or pitch exclusively, if not on diagonal
      if (stickDeflectionRollAbs > stickDeflectionPitchAbs) {
        signPitch = 0;
      } else {
        signRoll = 0;
      }
    }

    // Calculate crashflipPower from stick deflection with a reasonable amount of stick deadband
    let crashflipPower = stickDeflectionLength > CRASHFLIP_STICK_DEADBAND ? stickDeflectionLength : 0.0;

    // calculate flipPower attenuators
    let crashflipRateAttenuator = 1.0;
    let crashflipAttitudeAttenuator = 1.0;
    const crashflipRateLimit = this.cfg.crashflipRate * 10.0; // eg 35 = no power by 350 deg/s
    const halfComplete = 0.5; // attitude or rate changes less that this will be ignored

    if (crashflipRateLimit > 0) {
      // Attitude attenuator (the sim always has an attitude estimate)
      const tiltAngle = s.cosTilt; // -1 if flat inverted, 0 when 90° (on edge), +1 when flat and upright
      if (!this._isTiltAngleAtStartSet) {
        this._tiltAngleAtStart = tiltAngle;
        this._isTiltAngleAtStartSet = true;
        this.crashflipSuccess = false;
      }
      // attitudeChangeNeeded is 1.0 at the start, decreasing to 0 when attitude change exceeds approx 90 degrees
      const attitudeChangeNeeded = Math.max(1.0 - Math.abs(tiltAngle - this._tiltAngleAtStart), 0.0);
      crashflipAttitudeAttenuator = attitudeChangeNeeded > halfComplete ? 1.0 : attitudeChangeNeeded / halfComplete;
      this.crashflipSuccess = attitudeChangeNeeded === 0.0;

      const gyroRate = Math.max(Math.abs(s.gyroADCf[FD_ROLL]), Math.abs(s.gyroADCf[FD_PITCH]));
      const gyroRateChange = Math.min(gyroRate / crashflipRateLimit, 1.0);
      // no attenuation unless a significant gyro rate change has occurred
      crashflipRateAttenuator = gyroRateChange < halfComplete ? 1.0 : (1.0 - gyroRateChange) / halfComplete;

      crashflipPower *= crashflipAttitudeAttenuator * crashflipRateAttenuator;
    }

    for (let i = 0; i < 4; ++i) {
      const m = this.currentMixer[i];
      let motorOutputNormalised = signPitch * m.pitch + signRoll * m.roll + signYaw * m.yaw;

      if (motorOutputNormalised < 0) {
        if (this.cfg.crashflipMotorPercent > 0) {
          motorOutputNormalised = -motorOutputNormalised * this.cfg.crashflipMotorPercent / 100.0;
        } else {
          motorOutputNormalised = 0;
        }
      }

      motorOutputNormalised = Math.min(1.0, crashflipPower * motorOutputNormalised);
      let motorOutput = this.motorOutputMin + motorOutputNormalised * this.motorOutputRange;

      // set motors to disarm value when intended increase is less than deadband value
      motorOutput = (motorOutputNormalised < CRASHFLIP_MOTOR_DEADBAND) ? this.disarmMotorOutput : motorOutput;

      // reversed spin direction (DSHOT_CMD_SPIN_DIRECTION_REVERSED)
      this.motor[i] = -motorOutput;
    }
    return true;
  }

  // BF: flight/mixer.c:updateDynLpfCutoffs
  _updateDynLpfCutoffs(currentTimeUs, throttle, gyro, pid) {
    if (currentTimeUs - this._lastDynLpfUpdateUs >= DYN_LPF_THROTTLE_UPDATE_DELAY_US) {
      const quantizedThrottle = Math.round(throttle * DYN_LPF_THROTTLE_STEPS);
      if (quantizedThrottle !== this._dynLpfPreviousQuantizedThrottle) {
        const dynLpfThrottle = quantizedThrottle / DYN_LPF_THROTTLE_STEPS;
        if (gyro) gyro.dynLpfGyroUpdate(dynLpfThrottle);
        pid.dynLpfDTermUpdate(dynLpfThrottle);
        this._dynLpfPreviousQuantizedThrottle = quantizedThrottle;
        this._lastDynLpfUpdateUs = currentTimeUs;
      }
    }
  }

  // BF: flight/mixer.c:applyMixerAdjustment (MIXER_LEGACY)
  _applyMixerAdjustment(motorMix, motorMixMin, motorMixMax, airmodeEnabled) {
    let airmodeTransitionPercent = 1.0;

    if (!airmodeEnabled && this.throttle < 0.5) {
      // this scales the motor mix authority to be 0.5 at 0 throttle, and 1.0 at 0.5 throttle
      airmodeTransitionPercent = scaleAirmodeTransition(this.throttle);
    }

    const motorMixNormalizationFactor = this.motorMixRange > 1.0 ? airmodeTransitionPercent / this.motorMixRange : airmodeTransitionPercent;

    for (let i = 0; i < 4; i++) {
      motorMix[i] *= motorMixNormalizationFactor;
    }

    const normalizedMotorMixMin = motorMixMin * motorMixNormalizationFactor;
    const normalizedMotorMixMax = motorMixMax * motorMixNormalizationFactor;
    this.throttle = constrainf(this.throttle, -normalizedMotorMixMin, 1.0 - normalizedMotorMixMax);
  }

  // BF: flight/mixer.c:applyMixToMotors
  _applyMixToMotors(motorMix, armed, pid) {
    for (let i = 0; i < 4; i++) {
      let motorOutput = this.motorOutputMixSign * motorMix[i] + this.throttle * this.currentMixer[i].throttle;
      motorOutput = pid.applyThrustLinearization(motorOutput);
      motorOutput = this.motorOutputMin + this.motorOutputRange * motorOutput;
      motorOutput = constrainf(motorOutput, this.motorRangeMin, this.motorRangeMax);
      this.motor[i] = motorOutput;
    }

    // Disarmed mode
    if (!armed) {
      for (let i = 0; i < 4; i++) {
        this.motor[i] = this.disarmMotorOutput;
      }
    }
  }

  // BF: flight/mixer.c:mixTable
  /**
   * @param {object} s
   * @param {number} s.timeUs          FC clock, µs
   * @param {import('./rc.js').RcProcessor} s.rc
   * @param {import('./pid.js').PidController} s.pid
   * @param {import('./gyro.js').Gyro} s.gyro
   * @param {Float64Array} s.gyroADCf
   * @param {boolean} s.armed
   * @param {boolean} s.airmodeEnabled   the airmode *setting* (isAirmodeEnabled)
   * @param {boolean} s.crashflipActive
   * @param {boolean} s.yawSpinDetected
   * @param {number}  s.cosTilt
   * @returns {Float64Array} motor duty, -1..1
   */
  mixTable(s) {
    const airmodeEnabled = !!s.airmodeEnabled;
    const pid = s.pid;

    // Find min and max throttle based on conditions. Throttle has to be known before mixing
    this._calculateThrottleAndCurrentMotorEndpoints(s.rc.getThrottle());

    if (s.armed && this._applyCrashFlipModeToMotors(s)) {
      // if crash flip mode is being applied to the motors, mixing is done
      return this.motor;
    }

    const activeMixer = this.currentMixer;

    // Calculate and Limit the PID sum
    const scaledAxisPidRoll = constrainf(pid.Sum[FD_ROLL], -pid.pidSumLimit, pid.pidSumLimit) / PID_MIXER_SCALING;
    const scaledAxisPidPitch = constrainf(pid.Sum[FD_PITCH], -pid.pidSumLimit, pid.pidSumLimit) / PID_MIXER_SCALING;

    let yawPidSumLimit = pid.pidSumLimitYaw;
    const yawSpinDetected = !!s.yawSpinDetected;
    if (yawSpinDetected) {
      yawPidSumLimit = PIDSUM_LIMIT_MAX; // Set to the maximum limit during yaw spin recovery
    }
    // No negation: the yaw column of QUAD_X_MIX already carries BF's sign.
    const scaledAxisPidYaw = constrainf(pid.Sum[FD_YAW], -yawPidSumLimit, yawPidSumLimit) / PID_MIXER_SCALING;

    // use scaled throttle, without dynamic idle throttle offset, as the input to antigravity
    pid.updateAntiGravityThrottleFilter(this.throttle);

    // and for TPA
    pid.updateTpaFactor(this.throttle);

    // keep the changes to dynamic lowpass clean, without unnecessary dynamic changes
    this._updateDynLpfCutoffs(s.timeUs, this.throttle, s.gyro, pid);

    // apply throttle boost when throttle moves quickly
    if (this.throttleBoost > 0.0) {
      const throttleHpf = this.throttle - this.throttleLpf.apply(this.throttle);
      this.throttle = constrainf(this.throttle + this.throttleBoost * throttleHpf, 0.0, 1.0);
    }

    // send throttle value to blackbox, including scaling and throttle boost, but not TL compensation, dyn idle or airmode
    this.mixerThrottle = this.throttle;

    // reduce throttle to offset additional motor output
    this.throttle = pid.compensateThrustLinearization(this.throttle);

    // Find roll/pitch/yaw desired output
    const motorMix = this.motorMix;
    let motorMixMax = 0;
    let motorMixMin = 0;
    for (let i = 0; i < 4; i++) {
      const mix =
        scaledAxisPidRoll * activeMixer[i].roll +
        scaledAxisPidPitch * activeMixer[i].pitch +
        scaledAxisPidYaw * activeMixer[i].yaw;

      if (mix > motorMixMax) {
        motorMixMax = mix;
      } else if (mix < motorMixMin) {
        motorMixMin = mix;
      }
      motorMix[i] = mix;
    }

    // 50% throttle provides the maximum authority for yaw recovery when airmode is not active.
    if (yawSpinDetected && !airmodeEnabled) {
      this.throttle = 0.5;
    }

    this.motorMixRange = motorMixMax - motorMixMin;

    this._applyMixerAdjustment(motorMix, motorMixMin, motorMixMax, airmodeEnabled);

    // FEATURE_MOTOR_STOP is off by default: always apply the mix
    this._applyMixToMotors(motorMix, s.armed, pid);
    return this.motor;
  }

  /** Motor outputs when the FC is not running the mixer (disarmed). */
  stop() {
    for (let i = 0; i < 4; i++) this.motor[i] = this.disarmMotorOutput;
    return this.motor;
  }
}
