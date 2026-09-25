/**
 * fc/gyro.js
 * ---------------------------------------------------------------------------
 * The gyro: a sensor model that turns the physics body's true angular rates
 * into what an MPU/ICM gyro on a vibrating frame reports, followed by the
 * Betaflight 2025.12 gyro filter chain (`sensors/gyro.c`,
 * `sensors/gyro_filter_impl.c`, `sensors/gyro_init.c`,
 * `flight/rpm_filter.c`; GPL-3.0-or-later). Pure JS.
 *
 * Sensor model (per axis, deg/s):
 *   white noise    σ = 0.35 deg/s
 *   vibration      each motor adds a sine at its rotation frequency with
 *                  amplitude vibration·(rpm/maxRpm)²·(1 + 4·damage) and a
 *                  per-motor random phase. The sine is evaluated at loop
 *                  time, so anything above 0.5/dT aliases exactly the way
 *                  real undersampling does. Roll and pitch see the full
 *                  amplitude and yaw half of it: an imbalanced prop shakes
 *                  the frame mostly in the prop plane.
 *   full scale     ±2000 deg/s, as the sensor's range (gyro_high_fsr off).
 *
 * Filter order, as in BF (gyro_filter_impl.c):
 *   gyro LPF2 (static PT1 500, the sample-stage filter)
 *   → RPM filter (per motor, harmonics 1..3)
 *   → gyro LPF1 (dynamic PT1 250..500 on throttle)
 * The dynamic notch (FFT) is not modelled; the RPM filter covers motor noise.
 */

import {
  RpmNotch, makeLowpass, pt1FilterGain, constrainf,
} from './filters.js';
import { dynLpfCutoffFreq, dynThrottle } from './pid.js';

export const GYRO_NOISE_SIGMA = 0.35;       // deg/s, white
export const GYRO_FULL_SCALE_DPS = 2000;

// BF: sensors/gyro.c:gyroConfig reset (yaw_spin_threshold) — see yaw spin below
export const YAW_SPIN_THRESHOLD = 1950;

// BF: flight/rpm_filter.c
const RPM_FILTER_DURATION_S = 0.001;  // Maximum duration allowed to update all RPM notches once
export const RPM_FILTER_HARMONICS_MAX = 3;

export const GYRO_FILTER_DEFAULTS = Object.freeze({
  gyroLpf1DynMinHz: 250,
  gyroLpf1DynMaxHz: 500,
  gyroLpf1DynExpo: 5,
  gyroLpf1StaticHz: 250,
  gyroLpf2StaticHz: 500,
  rpmFilter: true,
  rpmFilterHarmonics: 3,
  rpmFilterMinHz: 100,
  rpmFilterFadeRangeHz: 50,
  rpmFilterQ: 500,
  rpmFilterWeights: [100, 0, 100],
});

/** Deterministic PRNG (mulberry32), so a flight replays identically. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Gyro {
  /**
   * @param {object} cfg   filter config (GYRO_FILTER_DEFAULTS keys)
   * @param {number} dT    loop period, s
   * @param {number} seed  noise seed
   */
  constructor(cfg, dT, seed = 0x5eed) {
    this._rand = mulberry32(seed);
    this._spare = NaN;
    this.gyroADC = new Float64Array(3);   // raw sensor reading
    this.gyroADCf = new Float64Array(3);  // filtered
    this._vec = new Float64Array(3);
    this._phase = new Float64Array(4);
    this._phaseOffset = [0, 1, 2, 3].map(() => [0, 1, 2].map(() => this._rand() * 2 * Math.PI));

    this.vibration = 0;        // deg/s at full RPM (per airframe)
    this.maxMotorHz = 1;       // rotation frequency at full RPM
    this.damage = 0;

    this.yawSpinDetected = false;
    this.yawSpinThreshold = YAW_SPIN_THRESHOLD;
    this.configure(cfg, dT);
  }

  /** Per-airframe vibration model inputs. */
  setVibration({ vibration, maxMotorHz, damage }) {
    if (Number.isFinite(vibration)) this.vibration = Math.max(0, vibration);
    if (Number.isFinite(maxMotorHz) && maxMotorHz > 0) this.maxMotorHz = maxMotorHz;
    if (Number.isFinite(damage)) this.damage = constrainf(damage, 0, 1);
  }

  // BF: sensors/gyro_init.c:gyroInitFilters
  configure(cfg, dT) {
    const c = { ...GYRO_FILTER_DEFAULTS, ...(cfg || {}) };
    this.cfg = c;
    this.dT = dT;

    let gyroLpf1InitHz = c.gyroLpf1StaticHz;
    if (c.gyroLpf1DynMinHz > 0) {
      gyroLpf1InitHz = c.gyroLpf1DynMinHz;
    }
    this.lowpassFilter = [0, 1, 2].map(() => makeLowpass(1, gyroLpf1InitHz, dT));
    this.lowpass2Filter = [0, 1, 2].map(() => makeLowpass(1, c.gyroLpf2StaticHz, dT));

    // BF: sensors/gyro_init.c:dynLpfFilterInit (PT1)
    this.dynLpfEnabled = c.gyroLpf1DynMinHz > 0;
    this.dynLpfMin = c.gyroLpf1DynMinHz;
    this.dynLpfMax = c.gyroLpf1DynMaxHz;
    this.dynLpfCurveExpo = c.gyroLpf1DynExpo;

    this._rpmFilterInit(c, dT);
  }

  // BF: flight/rpm_filter.c:rpmFilterInit
  _rpmFilterInit(c, dT) {
    const rf = {
      numHarmonics: 0,
      weights: new Float64Array(RPM_FILTER_HARMONICS_MAX),
      minHz: c.rpmFilterMinHz,
      maxHz: 0.48 / dT, // don't go quite to nyquist to avoid oscillations
      fadeRangeHz: c.rpmFilterFadeRangeHz,
      q: c.rpmFilterQ / 100.0,
      dt: dT,
      notch: [],
      notchUpdatesPerIteration: 0,
      motorIndex: 0,
      harmonicIndex: 0,
    };
    this.rpmFilter = rf;
    if (!c.rpmFilter || !c.rpmFilterHarmonics) return;

    rf.numHarmonics = Math.min(RPM_FILTER_HARMONICS_MAX, c.rpmFilterHarmonics | 0);
    for (let n = 0; n < RPM_FILTER_HARMONICS_MAX; n++) {
      const w = c.rpmFilterWeights ? c.rpmFilterWeights[n] : 100;
      rf.weights[n] = constrainf((Number.isFinite(w) ? w : 0) / 100.0, 0.0, 1.0);
    }
    for (let motor = 0; motor < 4; motor++) {
      rf.notch[motor] = [];
      for (let i = 0; i < rf.numHarmonics; i++) {
        rf.notch[motor][i] = new RpmNotch(rf.minHz * (i + 1), rf.dt, rf.q, 0.0);
      }
    }
    const loopIterationsPerUpdate = RPM_FILTER_DURATION_S / dT;
    const numNotchesPerAxis = 4 * rf.numHarmonics;
    rf.notchUpdatesPerIteration = Math.ceil(numNotchesPerAxis / loopIterationsPerUpdate);
  }

  // BF: flight/rpm_filter.c:rpmFilterUpdate
  _rpmFilterUpdate(motorHz) {
    const rf = this.rpmFilter;
    if (!rf.numHarmonics) return;

    for (let i = 0; i < rf.notchUpdatesPerIteration; i++) {
      // Only bother updating notches which have an effect on filtered output
      if (rf.weights[rf.harmonicIndex] > 0.0) {
        const raw = (rf.harmonicIndex + 1) * motorHz[rf.motorIndex];
        const frequencyHz = constrainf(raw, rf.minHz, rf.maxHz);
        const marginHz = frequencyHz - rf.minHz;
        let weight = 1.0;

        // fade out notch when approaching minHz (turn it off)
        if (marginHz < rf.fadeRangeHz) {
          weight = marginHz / rf.fadeRangeHz;
        }

        // attenuate notches per harmonics group
        weight *= rf.weights[rf.harmonicIndex];

        // A harmonic at or above 0.48/dT is skipped rather than parked at
        // the ceiling: it has aliased and sits somewhere else in the band.
        if (!(raw < rf.maxHz)) weight = 0.0;

        rf.notch[rf.motorIndex][rf.harmonicIndex].update(frequencyHz, rf.dt, rf.q, weight);
      }

      // cycle through all notches on ROLL (takes RPM_FILTER_DURATION_S at max.)
      rf.harmonicIndex = (rf.harmonicIndex + 1) % rf.numHarmonics;
      if (rf.harmonicIndex === 0) {
        rf.motorIndex = (rf.motorIndex + 1) % 4;
      }
    }
  }

  // BF: flight/rpm_filter.c:rpmFilterApply
  _rpmFilterApply(input) {
    const rf = this.rpmFilter;
    for (let i = 0; i < rf.numHarmonics; i++) {
      if (rf.weights[i] <= 0.0) {
        continue; // skip harmonics which have no effect on filtered output
      }
      for (let motor = 0; motor < 4; motor++) {
        rf.notch[motor][i].apply(input);
      }
    }
  }

  // BF: sensors/gyro.c:dynLpfGyroUpdate (PT1)
  dynLpfGyroUpdate(throttle) {
    if (!this.dynLpfEnabled) return;
    let cutoffFreq;
    if (this.dynLpfCurveExpo > 0) {
      cutoffFreq = dynLpfCutoffFreq(throttle, this.dynLpfMin, this.dynLpfMax, this.dynLpfCurveExpo);
    } else {
      cutoffFreq = Math.max(dynThrottle(throttle) * this.dynLpfMax, this.dynLpfMin);
    }
    this.gyroLpfCutoffHz = cutoffFreq;
    const k = pt1FilterGain(cutoffFreq, this.dT);
    for (let axis = 0; axis < 3; axis++) {
      this.lowpassFilter[axis].updateCutoff(k);
    }
  }

  _gauss() {
    if (Number.isFinite(this._spare)) {
      const s = this._spare;
      this._spare = NaN;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = this._rand();
    const v = this._rand();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /**
   * One gyro sample plus filtering.
   * @param {ArrayLike<number>} trueRatesDps  body rates, FC convention, deg/s
   * @param {ArrayLike<number>} motorHz       per-motor rotation frequency, Hz
   * @returns {Float64Array} gyroADCf
   */
  sample(trueRatesDps, motorHz) {
    const dT = this.dT;

    // --- sensor ---------------------------------------------------------
    const vib = this.vibration * (1 + 4 * this.damage);
    let vr = 0, vp = 0, vy = 0;
    for (let m = 0; m < 4; m++) {
      const hz = Number.isFinite(motorHz[m]) ? Math.abs(motorHz[m]) : 0;
      let ph = this._phase[m] + 2 * Math.PI * hz * dT;
      if (ph > 2 * Math.PI) ph -= 2 * Math.PI * Math.floor(ph / (2 * Math.PI));
      this._phase[m] = ph;
      if (vib <= 0 || hz <= 0) continue;
      const frac = hz / this.maxMotorHz;
      const amp = vib * frac * frac;
      const off = this._phaseOffset[m];
      vr += amp * Math.sin(ph + off[0]);
      vp += amp * Math.sin(ph + off[1]);
      vy += 0.5 * amp * Math.sin(ph + off[2]);
    }
    const vibAxis = [vr, vp, vy];
    for (let axis = 0; axis < 3; axis++) {
      const t = Number.isFinite(trueRatesDps[axis]) ? trueRatesDps[axis] : 0;
      const raw = t + vibAxis[axis] + GYRO_NOISE_SIGMA * this._gauss();
      this.gyroADC[axis] = constrainf(raw, -GYRO_FULL_SCALE_DPS, GYRO_FULL_SCALE_DPS);
    }

    // --- BF: sensors/gyro_filter_impl.c:filterGyro ------------------------
    const v = this._vec;
    for (let axis = 0; axis < 3; axis++) {
      // gyro LPF2 runs in the sample stage (downsampleFilterEnabled)
      v[axis] = this.lowpass2Filter[axis].apply(this.gyroADC[axis]);
    }
    // BF: flight/rpm_filter.c:rpmFilterRun
    this._rpmFilterUpdate(motorHz);
    this._rpmFilterApply(v);
    for (let axis = 0; axis < 3; axis++) {
      let g = v[axis];
      g = this.lowpassFilter[axis].apply(g);
      this.gyroADCf[axis] = Number.isFinite(g) ? g : 0;
    }
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) {
      this.reset();
    }

    this._checkForYawSpin();
    return this.gyroADCf;
  }

  /**
   * Yaw spin recovery (BF `yaw_spin_recovery`), with the plan's fixed rule:
   * detected above 1950 deg/s on the filtered yaw gyro, released once the
   * rate falls below 50 % of that threshold.
   */
  // BF: sensors/gyro.c:checkForYawSpin
  _checkForYawSpin() {
    const yaw = Math.abs(this.gyroADCf[2]);
    if (this.yawSpinDetected) {
      if (yaw < 0.5 * this.yawSpinThreshold) this.yawSpinDetected = false;
    } else if (yaw > this.yawSpinThreshold) {
      this.yawSpinDetected = true;
    }
  }

  /** Zero every filter state (after a non-finite input). */
  reset() {
    this.configure(this.cfg, this.dT);
    this.gyroADCf.fill(0);
  }
}
