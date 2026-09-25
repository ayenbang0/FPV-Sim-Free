/**
 * fc/rc.js
 * ---------------------------------------------------------------------------
 * RC processing: RX frames in, smoothed rate setpoints, feedforward and
 * throttle out. Ported from Betaflight 2025.12 `src/main/fc/rc.c` (and the
 * feedforward/RC-smoothing parts of `flight/pid_init.c`), GPL-3.0-or-later.
 * Pure JS: no three, no DOM.
 *
 * Split, as in BF:
 *   onRxFrame()  runs once per received frame — BF `updateRcRefreshRate`,
 *                `updateRcCommands` and the new-data half of
 *                `processRcCommand` (smoothing-rate tracking, rates,
 *                feedforward).
 *   update()     runs once per FC loop — BF `processRcSmoothingFilter`, the
 *                PT3 smoothing of setpoint, feedforward and throttle.
 *
 * Axis convention (see src/fc/mixer.js): roll + = right wing down, pitch + =
 * nose down, yaw + = nose right. That is the sim's stick convention, so unlike
 * BF there is no yaw-stick negation in `updateRcCommands`.
 *
 * Channel order is AETR after the radio's channel map has been applied
 * (InputManager): ch[0] roll, ch[1] pitch, ch[2] throttle, ch[3] yaw,
 * ch[4..15] AUX1..AUX12, all in µs (1000..2000, centre 1500).
 */

import {
  Pt1, Pt3, LaggedMovingAverage,
  pt1FilterGainFromDelay, pt3FilterGain, constrainf, fapplyDeadband,
} from './filters.js';
import {
  applyRates, maxRcRate as rateMax, generateThrottleCurve, rcLookupThrottle,
  PWM_RANGE_MIN, PWM_RANGE_MAX,
} from './rates.js';

export const CH_ROLL = 0;
export const CH_PITCH = 1;
export const CH_THROTTLE = 2;
export const CH_YAW = 3;
export const CH_AUX1 = 4;
export const RC_CHANNEL_COUNT = 16;

export const FD_ROLL = 0;
export const FD_PITCH = 1;
export const FD_YAW = 2;
export const THROTTLE = 3;

export const RX_INTERVAL_MIN_US = 800;   // 0.800ms to fit 1kHz without an issue
export const RX_INTERVAL_MAX_US = 65500; // 65.5ms or 15.26hz

/** BF feedforward_averaging: OFF, 2_POINT, 3_POINT, 4_POINT. */
export const FEEDFORWARD_AVERAGING = { off: 0, '2_point': 1, '3_point': 2, '4_point': 3 };

export const RC_DEFAULTS = Object.freeze({
  midrc: 1500,
  mincheck: 1050,
  deadband: 0,
  yawDeadband: 0,
  rcSmoothing: true,
  rcSmoothingAutoFactorRpy: 30,
  rcSmoothingAutoFactorThrottle: 30,
  rcSmoothingSetpointCutoff: 0,
  rcSmoothingThrottleCutoff: 0,
  feedforwardAveraging: FEEDFORWARD_AVERAGING['2_point'],
  feedforwardMaxRateLimit: 90,
  feedforwardSmoothFactor: 65,
  feedforwardJitterFactor: 7,
  feedforwardBoost: 15,
  feedforwardTransition: 0,
  feedforwardYawHoldGain: 15,
  feedforwardYawHoldTime: 100,
  // BF: false only for CRSF receivers (pid_init.c: feedforwardInterpolate).
  feedforwardInterpolate: true,
});

export class RcProcessor {
  /**
   * @param {object} config  `{ rates: {type, rcRates, rates, rcExpo,
   *   quickRatesRcExpo, rateLimit, thrMid, thrExpo, thrHover}, ...RC_DEFAULTS }`
   * @param {number} dT      FC loop period, s
   */
  constructor(config, dT) {
    // --- rc.c file-scope state ---
    this.rawSetpoint = new Float64Array(3);
    this.setpointRate = new Float64Array(3);
    this.rcDeflection = new Float64Array(3);
    this.rcDeflectionAbs = new Float64Array(3);
    this.rcDeflectionSmoothed = new Float64Array(3);
    this.maxRcDeflectionAbs = 0;
    this.rcData = new Float64Array(RC_CHANNEL_COUNT).fill(1500);
    this.rcData[CH_THROTTLE] = 1000;
    // rcCommand[ROLL, PITCH, YAW] in ±500 units, [THROTTLE] in µs (1000..2000);
    // `rcCommandThrottleSmoothed` is what BF writes back into rcCommand[THROTTLE].
    this.rcCommand = new Float64Array(4);
    this.rcCommand[THROTTLE] = PWM_RANGE_MIN;
    this.rcCommandThrottleSmoothed = PWM_RANGE_MIN;

    this.currentRxIntervalUs = 0;
    this.previousRxIntervalUs = 0;
    this.currentRxRateHz = 0;
    this.smoothedRxRateHz = 100.0;
    this.isRxDataNew = false;
    this.isRxRateValid = false;
    this.lastRxTimeUs = 0;
    this._haveLastRxTime = false;   // BF tests `lastRxTimeUs != 0`; sim time may start at 0
    this.rxReceivingSignal = false;

    // shouldUpdateSmoothing() statics
    this._validCount = 0;
    this._outlierCount = 0;
    this._prevOutlierSign = 0;

    // processRcSmoothingFilter() statics: FAST_DATA_ZERO_INIT, so every PT3
    // starts with k = 0 until the first cutoff update.
    this.rxDataToSmooth = new Float64Array(4);
    this.filterSetpoint = [new Pt3(0), new Pt3(0), new Pt3(0), new Pt3(0)];
    this.filterFeedforward = [new Pt3(0), new Pt3(0), new Pt3(0)];
    this.filterRcDeflection = [new Pt3(0), new Pt3(0)];
    this.setpointCutoffFrequency = 0;
    this.throttleCutoffFrequency = 0;

    // feedforwardData_t
    this.ff = {
      prevRcCommand: new Float64Array(3),
      prevSetpoint: new Float64Array(3),
      prevSetpointSpeed: new Float64Array(3),
      prevSetpointSpeedDelta: new Float64Array(3),
      prevRcCommandDeltaAbs: new Float64Array(3),
      prevRxInterval: new Float64Array(3),
      isPrevPacketDuplicate: [false, false, false],
      filterSetpointSpeed: [new Pt1(0), new Pt1(0), new Pt1(0)],
      filterSetpointDelta: [new Pt1(0), new Pt1(0), new Pt1(0)],
    };
    this.feedforwardSmoothed = new Float64Array(3);
    this.feedforwardRaw = new Float64Array(3);
    this.feedforwardYawHoldLpf = new Pt1(0);
    this.feedforwardDeltaAvg = [null, null, null];

    this.maxRcRate = new Float64Array(3);
    this.configure(config, dT);
    this._initFeedforwardState();
  }

  // BF: fc/rc.c:initRcProcessing, flight/pid_init.c:pidInitConfig (feedforward part)
  /**
   * Re-read the rate profile and RC settings. Link-rate tracking and filter
   * state survive, as they do on a BF rate-profile change.
   */
  configure(config, dT) {
    const c = { ...RC_DEFAULTS, ...(config || {}) };
    this.dT = dT;
    this.cfg = c;
    const r = c.rates || {};
    this.rateProfile = {
      rcRates: r.rcRates || [7, 7, 7],
      rates: r.rates || [67, 67, 67],
      rcExpo: r.rcExpo || [0, 0, 0],
      quickRatesRcExpo: r.quickRatesRcExpo ? 1 : 0,
      rateLimit: r.rateLimit || [1998, 1998, 1998],
    };
    this.ratesType = r.type || 'actual';

    // BF: fc/rc.c:initRcProcessing
    this.rcCommandDivider = 500.0 - c.deadband;
    this.rcCommandYawDivider = 500.0 - c.yawDeadband;
    this.lookupThrottleRC = generateThrottleCurve(
      Number.isFinite(r.thrMid) ? r.thrMid : 50,
      Number.isFinite(r.thrExpo) ? r.thrExpo : 0,
      Number.isFinite(r.thrHover) ? r.thrHover : 50,
    );

    // BF: fc/rc.c:initRcProcessing (USE_RC_SMOOTHING_FILTER)
    this.autoSmoothnessFactorSetpoint = 1.5 / (1.0 + (c.rcSmoothingAutoFactorRpy / 10.0));
    this.autoSmoothnessFactorThrottle = 1.5 / (1.0 + (c.rcSmoothingAutoFactorThrottle / 10.0));
    this.setpointCutoffSetting = c.rcSmoothingSetpointCutoff;
    this.throttleCutoffSetting = c.rcSmoothingThrottleCutoff;

    // BF: flight/pid_init.c:pidInitConfig (USE_FEEDFORWARD)
    this.feedforwardTransition = c.feedforwardTransition / 100.0;
    this.feedforwardTransitionInv = (c.feedforwardTransition === 0) ? 0.0 : 100.0 / c.feedforwardTransition;
    this.feedforwardAveraging = c.feedforwardAveraging;
    const scaledSmoothFactor = 0.01 * c.feedforwardSmoothFactor;
    const rxDt = 1.0 / 250.0;
    this.feedforwardSmoothFactor = (rxDt * scaledSmoothFactor) / (1.0 - scaledSmoothFactor);
    this.feedforwardJitterFactor = c.feedforwardJitterFactor;
    this.feedforwardJitterFactorInv = 1.0 / (1.0 + c.feedforwardJitterFactor);
    this.feedforwardBoostFactor = 0.001 * c.feedforwardBoost;
    this.feedforwardMaxRateLimit = c.feedforwardMaxRateLimit;
    this.feedforwardInterpolate = !!c.feedforwardInterpolate;
    this.feedforwardYawHoldTime = 0.001 * c.feedforwardYawHoldTime;
    this.feedforwardYawHoldGain = c.feedforwardYawHoldGain;
    if (c.feedforwardYawHoldTime < 100) {
      this.feedforwardYawHoldGain *= 150.0 / (c.feedforwardYawHoldTime + 50);
    }

    for (let i = 0; i < 3; i++) {
      this.maxRcRate[i] = rateMax(this.ratesType, i, this.rateProfile);
    }

    this._updateFeedforwardFilters();
    if (this.setpointCutoffFrequency > 0 || this.setpointCutoffSetting > 0 || this.throttleCutoffSetting > 0) {
      this._rcSmoothingSetFilterCutoffs();
    }
    if (this.feedforwardDeltaAvg[0] && this.feedforwardDeltaAvg[0].windowSize !== this.feedforwardAveraging + 1) {
      this._initFeedforwardState();
    }
  }

  // BF: fc/rc.c:initRcProcessing (USE_FEEDFORWARD part)
  _initFeedforwardState() {
    this.feedforwardYawHoldLpf = new Pt1(0.0);
    for (let i = 0; i < 3; i++) {
      this.feedforwardSmoothed[i] = 0.0;
      this.feedforwardRaw[i] = 0.0;
      this.feedforwardDeltaAvg[i] = this.feedforwardAveraging
        ? new LaggedMovingAverage(this.feedforwardAveraging + 1)
        : null;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Per-frame
   * ---------------------------------------------------------------------- */

  /**
   * A new RX frame arrived.
   * @param {ArrayLike<number>} channelsUs  16 channels, µs, AETR order
   * @param {number} tSim                   frame time, s (sim clock)
   */
  onRxFrame(channelsUs, tSim) {
    for (let i = 0; i < RC_CHANNEL_COUNT; i++) {
      const v = channelsUs ? channelsUs[i] : NaN;
      // A garbage channel reads as centre (throttle as low), never NaN.
      this.rcData[i] = Number.isFinite(v)
        ? constrainf(v, 750, 2250)
        : (i === CH_THROTTLE ? 1000 : 1500);
    }
    const tUs = Math.round((Number.isFinite(tSim) ? tSim : 0) * 1e6);
    this._updateRcRefreshRate(tUs, true);
    this._updateRcCommands();
    this._processRcCommandNewData();
  }

  /** No frame this loop and the link timed out (failsafe); BF keeps counts idle. */
  onRxLoss() {
    this.rxReceivingSignal = false;
  }

  // BF: fc/rc.c:updateRcRefreshRate
  _updateRcRefreshRate(currentTimeUs, rxReceivingSignal) {
    this.rxReceivingSignal = rxReceivingSignal;
    let delta = 0;

    if (rxReceivingSignal) {
      this.previousRxIntervalUs = this.currentRxIntervalUs;
      const rxTime = currentTimeUs;
      if (this._haveLastRxTime) {  // report delta only if previous time is available
        delta = rxTime - this.lastRxTimeUs;
      }
      this.lastRxTimeUs = rxTime;
      this._haveLastRxTime = true;
    } else if (this._haveLastRxTime) {
      delta = currentTimeUs - this.lastRxTimeUs;
    }

    this.currentRxIntervalUs = constrainf(delta, RX_INTERVAL_MIN_US, RX_INTERVAL_MAX_US);
    this.currentRxRateHz = 1e6 / this.currentRxIntervalUs;
    this.isRxRateValid = delta === this.currentRxIntervalUs;
  }

  // BF: fc/rc.c:updateRcCommands
  _updateRcCommands() {
    this.isRxDataNew = true;
    const c = this.cfg;
    const rcDataAxis = [this.rcData[CH_ROLL], this.rcData[CH_PITCH], this.rcData[CH_YAW]];

    for (let axis = 0; axis < 3; axis++) {
      const rc = constrainf(rcDataAxis[axis] - c.midrc, -500.0, 500.0);
      let rcDeadband = 0;
      if (axis === FD_ROLL || axis === FD_PITCH) {
        rcDeadband = c.deadband;
      } else {
        // BF negates yaw here (rc *= -GET_DIRECTION(yaw_control_reversed));
        // our yaw convention is already + = nose right, so it passes through.
        rcDeadband = c.yawDeadband;
      }
      this.rcCommand[axis] = fapplyDeadband(rc, rcDeadband);
    }

    let tmp = Math.trunc(constrainf(this.rcData[CH_THROTTLE], c.mincheck, PWM_RANGE_MAX));
    tmp = Math.trunc((tmp - c.mincheck) * PWM_RANGE_MIN / (PWM_RANGE_MAX - c.mincheck));
    this.rcCommand[THROTTLE] = rcLookupThrottle(this.lookupThrottleRC, tmp);
  }

  // BF: fc/rc.c:shouldUpdateSmoothing
  _shouldUpdateSmoothing() {
    const smoothingFactor = 0.1;

    if (this.rxReceivingSignal && this.isRxRateValid) {
      const deltaRateHz = this.currentRxRateHz - this.smoothedRxRateHz;
      const isOutlier = Math.abs(deltaRateHz) > (this.smoothedRxRateHz * 0.2);

      if (isOutlier) {
        const currentSign = (deltaRateHz < 0.0) ? -1 : 1;
        if (this._outlierCount === 0) {
          this._prevOutlierSign = currentSign;
          this._outlierCount++;
        } else if (currentSign !== this._prevOutlierSign) {
          // Reset outlier count if outlier sign reverses
          this._outlierCount = 0;
          this._prevOutlierSign = currentSign;
        } else {
          this._outlierCount++;
        }
        this._validCount = 0;
      } else {
        // First-order smoothing toward new value for non-outliers
        this.smoothedRxRateHz += smoothingFactor * (this.currentRxRateHz - this.smoothedRxRateHz);
        this._validCount++;
        this._outlierCount = 0;
      }

      if (this._validCount >= 3) {
        this._validCount = 0;
        return true;
      }
      if (this._outlierCount >= 3) {
        // Link rate likely changed — snap smoothing accumulator to current value
        this.smoothedRxRateHz = this.currentRxRateHz;
        this._outlierCount = 0;
      }
    } else {
      this._validCount = 0;
      this._outlierCount = 0;
    }
    return false;
  }

  // BF: fc/rc.c:rcSmoothingSetFilterCutoffs
  _rcSmoothingSetFilterCutoffs() {
    const minCutoffHz = 15.0; // don't let any RC smoothing filter cutoff go below 15Hz
    const dT = this.dT;

    this.setpointCutoffFrequency = this.setpointCutoffSetting === 0
      ? Math.max(minCutoffHz, this.smoothedRxRateHz * this.autoSmoothnessFactorSetpoint)
      : this.setpointCutoffSetting;

    this.throttleCutoffFrequency = this.throttleCutoffSetting === 0
      ? Math.max(minCutoffHz, this.smoothedRxRateHz * this.autoSmoothnessFactorThrottle)
      : this.throttleCutoffSetting;

    const pt3KSp = pt3FilterGain(this.setpointCutoffFrequency, dT);
    const pt3KThr = pt3FilterGain(this.throttleCutoffFrequency, dT);

    for (let i = FD_ROLL; i <= FD_YAW; i++) {
      this.filterSetpoint[i].updateCutoff(pt3KSp);
      this.filterFeedforward[i].updateCutoff(pt3KSp);
    }
    this.filterSetpoint[THROTTLE].updateCutoff(pt3KThr);
    for (let i = FD_ROLL; i <= FD_PITCH; i++) {
      this.filterRcDeflection[i].updateCutoff(pt3KSp);
    }
  }

  // BF: fc/rc.c:updateFeedforwardFilters
  _updateFeedforwardFilters() {
    const pt1K = pt1FilterGainFromDelay(this.feedforwardSmoothFactor, 1.0 / this.smoothedRxRateHz);
    for (let axis = FD_ROLL; axis <= FD_YAW; axis++) {
      this.ff.filterSetpointSpeed[axis].updateCutoff(pt1K);
      this.ff.filterSetpointDelta[axis].updateCutoff(pt1K);
    }
  }

  // BF: fc/rc.c:processRcCommand (the `isRxDataNew` half)
  _processRcCommandNewData() {
    const updateSmoothing = this._shouldUpdateSmoothing();
    if (updateSmoothing) {
      this._updateFeedforwardFilters();
      if (this.cfg.rcSmoothing) {
        this._rcSmoothingSetFilterCutoffs();
      }
    }
    this.maxRcDeflectionAbs = 0.0;

    for (let axis = FD_ROLL; axis <= FD_YAW; axis++) {
      // scale rcCommandf to range [-1.0, 1.0]
      const rcCommandf = axis === FD_YAW
        ? this.rcCommand[axis] / this.rcCommandYawDivider
        : this.rcCommand[axis] / this.rcCommandDivider;
      this.rcDeflection[axis] = rcCommandf;
      const rcCommandfAbs = Math.abs(rcCommandf);
      this.rcDeflectionAbs[axis] = rcCommandfAbs;
      this.maxRcDeflectionAbs = Math.max(this.maxRcDeflectionAbs, rcCommandfAbs);

      // applyRates() clamps to ±rate_limit, as processRcCommand does
      this.rawSetpoint[axis] = applyRates(this.ratesType, axis, rcCommandf, this.rateProfile);

      this._calculateFeedforward(axis);
    }

    // processRcSmoothingFilter(): capture new values to be smoothed
    for (let i = 0; i < 4; i++) {
      this.rxDataToSmooth[i] = i === THROTTLE ? this.rcCommand[i] : this.rawSetpoint[i];
    }
  }

  // BF: fc/rc.c:calculateFeedforward
  _calculateFeedforward(axis) {
    const d = this.ff;
    const rxInterval = this.currentRxIntervalUs * 1e-6; // seconds
    const rcCommandDelta = this.rcCommand[axis] - d.prevRcCommand[axis];
    let rcCommandDeltaAbs = Math.abs(rcCommandDelta);
    const isDuplicate = rcCommandDeltaAbs === 0;
    const setpoint = this.rawSetpoint[axis];
    const setpointDelta = setpoint - d.prevSetpoint[axis];

    d.prevRcCommand[axis] = this.rcCommand[axis];
    d.prevSetpoint[axis] = setpoint;

    let rxRate = this.currentRxRateHz;

    let setpointSpeed = 0.0;
    let setpointSpeedDelta = 0.0;
    let feedforward = 0.0;

    if (this.feedforwardInterpolate) {
      const prevRxInterval = d.prevRxInterval[axis];
      if (!isDuplicate) {
        // movement!
        if (d.isPrevPacketDuplicate[axis]) {
          rxRate = 1.0 / (rxInterval + prevRxInterval);
        }
        setpointSpeed = setpointDelta * rxRate;
      } else if (!d.isPrevPacketDuplicate[axis]) {
        // extrapolate a replacement setpointSpeed value for the first duplicate after normal movement
        // but not when about to hit max deflection
        if (Math.abs(setpoint) < 0.90 * this.maxRcRate[axis]) {
          setpointSpeed = d.prevSetpointSpeed[axis] + d.prevSetpointSpeedDelta[axis];
          // pretend that there was stick movement also, to hold the same jitter value
          rcCommandDeltaAbs = d.prevRcCommandDeltaAbs[axis];
        }
      } else {
        // for second and all subsequent duplicates, force setpoint speed to zero
        setpointSpeed = 0.0;
        d.prevSetpointSpeed[axis] = 0.0;
      }
      d.prevRxInterval[axis] = rxInterval;
    } else {
      setpointSpeed = setpointDelta * this.currentRxRateHz;
    }
    d.isPrevPacketDuplicate[axis] = isDuplicate;

    // Jitter attenuation factor calculation
    let jitterAttenuator = ((rcCommandDeltaAbs + d.prevRcCommandDeltaAbs[axis]) * 0.5 + 1.0) * this.feedforwardJitterFactorInv;
    jitterAttenuator = Math.min(jitterAttenuator, 1.0);
    d.prevRcCommandDeltaAbs[axis] = rcCommandDeltaAbs;

    // Smooth the setpointSpeed value
    setpointSpeed = d.filterSetpointSpeed[axis].apply(setpointSpeed);

    // Calculate setpointDelta from smoothed setpoint speed
    setpointSpeedDelta = setpointSpeed - d.prevSetpointSpeed[axis];
    d.prevSetpointSpeed[axis] = setpointSpeed;

    // Smooth the setpointDelta (2nd order smoothing)
    setpointSpeedDelta = d.filterSetpointDelta[axis].apply(setpointSpeedDelta);
    d.prevSetpointSpeedDelta[axis] = setpointSpeedDelta;

    // Calculate feedforward boost
    const feedforwardBoost = setpointSpeedDelta * rxRate * this.feedforwardBoostFactor;
    feedforward = setpointSpeed;

    if (axis === FD_ROLL || axis === FD_PITCH) {
      feedforward += feedforwardBoost;
      feedforward *= jitterAttenuator;
      if (this.feedforwardMaxRateLimit && feedforward * setpoint > 0.0) {
        const limit = (this.maxRcRate[axis] - Math.abs(setpoint)) * this.feedforwardMaxRateLimit;
        feedforward = (limit > 0.0) ? constrainf(feedforward, -limit, limit) : 0.0;
      }
    } else {
      feedforward *= jitterAttenuator;
      const gain = pt1FilterGainFromDelay(this.feedforwardYawHoldTime, rxInterval);
      this.feedforwardYawHoldLpf.updateCutoff(gain);
      const setpointLpfYaw = this.feedforwardYawHoldLpf.apply(setpoint);
      const feedforwardYawHold = this.feedforwardYawHoldGain * (setpoint - setpointLpfYaw);
      feedforward += feedforwardYawHold;
    }

    // Apply feedforward transition if configured
    const useTransition = (this.feedforwardTransition !== 0.0) && (this.rcDeflectionAbs[axis] < this.feedforwardTransition);
    if (useTransition) {
      feedforward *= this.rcDeflectionAbs[axis] * this.feedforwardTransitionInv;
    }

    // Final smoothing if configured
    if (this.feedforwardAveraging && this.feedforwardDeltaAvg[axis]) {
      feedforward = this.feedforwardDeltaAvg[axis].update(feedforward);
    }

    this.feedforwardRaw[axis] = Number.isFinite(feedforward) ? feedforward : 0;
  }

  /* ---------------------------------------------------------------------- *
   * Per-loop
   * ---------------------------------------------------------------------- */

  // BF: fc/rc.c:processRcSmoothingFilter
  /**
   * Once per FC loop.
   * @param {boolean} horizonMode  smooth the stick deflection for Horizon
   */
  update(horizonMode = false) {
    this.isRxDataNew = false;
    if (!this.cfg.rcSmoothing) {
      for (let i = 0; i < 3; i++) this.rcDeflectionSmoothed[i] = this.rcDeflection[i];
      this.rcCommandThrottleSmoothed = this.rcCommand[THROTTLE];
      return;
    }

    for (let i = 0; i < 4; i++) {
      const out = this.filterSetpoint[i].apply(this.rxDataToSmooth[i]);
      if (i === THROTTLE) this.rcCommandThrottleSmoothed = out;
      else this.setpointRate[i] = out;
    }
    for (let axis = FD_ROLL; axis <= FD_YAW; axis++) {
      this.feedforwardSmoothed[axis] = this.filterFeedforward[axis].apply(this.feedforwardRaw[axis]);
      this.rcDeflectionSmoothed[axis] = horizonMode && axis < FD_YAW
        ? this.filterRcDeflection[axis].apply(this.rcDeflection[axis])
        : this.rcDeflection[axis];
    }
  }

  /* ---------------------------------------------------------------------- *
   * Getters (BF rc.h)
   * ---------------------------------------------------------------------- */

  // BF: fc/rc.c:getSetpointRate
  getSetpointRate(axis) {
    return this.cfg.rcSmoothing ? this.setpointRate[axis] : this.rawSetpoint[axis];
  }

  // BF: fc/rc.c:getFeedforward
  getFeedforward(axis) {
    return this.cfg.rcSmoothing ? this.feedforwardSmoothed[axis] : this.feedforwardRaw[axis];
  }

  // BF: fc/rc.c:getRcDeflection
  getRcDeflection(axis) {
    return this.cfg.rcSmoothing ? this.rcDeflectionSmoothed[axis] : this.rcDeflection[axis];
  }

  // BF: fc/rc.c:getRcDeflectionAbs
  getRcDeflectionAbs(axis) {
    return this.rcDeflectionAbs[axis];
  }

  // BF: fc/rc.c:getMaxRcRate
  getMaxRcRate(axis) {
    return this.maxRcRate[axis];
  }

  /** rcCommand[THROTTLE] after the curve and smoothing, µs. */
  getThrottleCommand() {
    return this.cfg.rcSmoothing ? this.rcCommandThrottleSmoothed : this.rcCommand[THROTTLE];
  }

  // BF: flight/mixer.c:calculateThrottleAndCurrentMotorEndpoints (non-3D branch)
  /** Throttle 0..1 after the throttle curve and smoothing. */
  getThrottle() {
    const t = (this.getThrottleCommand() - PWM_RANGE_MIN) / (PWM_RANGE_MAX - PWM_RANGE_MIN);
    return constrainf(Number.isFinite(t) ? t : 0, 0.0, 1.0);
  }

  getCurrentRxRateHz() {
    return this.smoothedRxRateHz;
  }
}
