/**
 * fc/filters.js
 * ---------------------------------------------------------------------------
 * Digital filters of the flight controller, ported from Betaflight 2025.12
 * `src/main/common/filter.c` (GPL-3.0-or-later). Pure JS: no three, no DOM.
 *
 * Every filter carries its state in the instance, the way BF carries it in a
 * struct; `apply(x)` is the BF `*FilterApply` and `updateCutoff(k)` the BF
 * `*FilterUpdateCutoff`. Gains are computed by the free functions below, as in
 * BF, so callers can retune a filter without resetting its state.
 *
 * Nyquist: a low-pass whose cutoff is at or above 0.5/dT (or zero) is built as
 * a pass-through, matching the Nyquist check BF performs before choosing a
 * filter implementation (`gyroInitLowpassFilterLpf`, `pidInitFilters`).
 */

const PI = Math.PI;

/** BF: common/filter.c — shift f_cut to satisfy the −3 dB cutoff condition. */
export const CUTOFF_CORRECTION_PT2 = 1.553773974;
export const CUTOFF_CORRECTION_PT3 = 1.961459177;

// BF: common/filter.c:nullFilterApply
export function nullFilterApply(input) {
  return input;
}

/** True when a low-pass at `fHz` cannot be built at loop period `dT`. */
export function isAboveNyquist(fHz, dT) {
  return !(fHz > 0) || fHz >= 0.5 / dT;
}

// ---------------------------------------------------------------------------
// PT1
// ---------------------------------------------------------------------------

// BF: common/filter.c:pt1FilterGain
export function pt1FilterGain(fCut, dT) {
  const omega = 2.0 * PI * fCut * dT;
  return omega / (omega + 1.0);
}

// BF: common/filter.c:pt1FilterGainFromDelay
export function pt1FilterGainFromDelay(delay, dT) {
  if (delay <= 0) {
    return 1.0; // gain = 1 means no filtering
  }
  return dT / (dT + delay);
}

export class Pt1 {
  // BF: common/filter.c:pt1FilterInit
  constructor(k = 1) {
    this.state = 0.0;
    this.k = k;
  }

  // BF: common/filter.c:pt1FilterUpdateCutoff
  updateCutoff(k) {
    this.k = k;
  }

  // BF: common/filter.c:pt1FilterApply
  apply(input) {
    this.state = this.state + this.k * (input - this.state);
    return this.state;
  }

  reset(value = 0) {
    this.state = value;
  }
}

// ---------------------------------------------------------------------------
// PT2
// ---------------------------------------------------------------------------

// BF: common/filter.c:pt2FilterGain
export function pt2FilterGain(fCut, dT) {
  // shift f_cut to satisfy -3dB cutoff condition
  return pt1FilterGain(fCut * CUTOFF_CORRECTION_PT2, dT);
}

// BF: common/filter.c:pt2FilterGainFromDelay
export function pt2FilterGainFromDelay(delay, dT) {
  if (delay <= 0) {
    return 1.0;
  }
  return dT / (dT + delay * CUTOFF_CORRECTION_PT2);
}

export class Pt2 {
  // BF: common/filter.c:pt2FilterInit
  constructor(k = 1) {
    this.state = 0.0;
    this.state1 = 0.0;
    this.k = k;
  }

  // BF: common/filter.c:pt2FilterUpdateCutoff
  updateCutoff(k) {
    this.k = k;
  }

  // BF: common/filter.c:pt2FilterApply
  apply(input) {
    this.state1 = this.state1 + this.k * (input - this.state1);
    this.state = this.state + this.k * (this.state1 - this.state);
    return this.state;
  }

  reset(value = 0) {
    this.state = this.state1 = value;
  }
}

// ---------------------------------------------------------------------------
// PT3
// ---------------------------------------------------------------------------

// BF: common/filter.c:pt3FilterGain
export function pt3FilterGain(fCut, dT) {
  // shift f_cut to satisfy -3dB cutoff condition
  return pt1FilterGain(fCut * CUTOFF_CORRECTION_PT3, dT);
}

// BF: common/filter.c:pt3FilterGainFromDelay
export function pt3FilterGainFromDelay(delay, dT) {
  if (delay <= 0) {
    return 1.0;
  }
  return dT / (dT + delay * CUTOFF_CORRECTION_PT3);
}

export class Pt3 {
  // BF: common/filter.c:pt3FilterInit
  constructor(k = 1) {
    this.state = 0.0;
    this.state1 = 0.0;
    this.state2 = 0.0;
    this.k = k;
  }

  // BF: common/filter.c:pt3FilterUpdateCutoff
  updateCutoff(k) {
    this.k = k;
  }

  // BF: common/filter.c:pt3FilterApply
  apply(input) {
    this.state1 = this.state1 + this.k * (input - this.state1);
    this.state2 = this.state2 + this.k * (this.state1 - this.state2);
    this.state = this.state + this.k * (this.state2 - this.state);
    return this.state;
  }

  reset(value = 0) {
    this.state = this.state1 = this.state2 = value;
  }
}

/**
 * A PT1/PT2/PT3 low-pass at `fHz`, or a pass-through when the cutoff is zero
 * or at/above Nyquist. The returned object always has `apply`,
 * `updateCutoff` and `passThrough`.
 */
export function makeLowpass(order, fHz, dT) {
  if (isAboveNyquist(fHz, dT)) return new PassThrough();
  if (order === 2) return new Pt2(pt2FilterGain(fHz, dT));
  if (order === 3) return new Pt3(pt3FilterGain(fHz, dT));
  return new Pt1(pt1FilterGain(fHz, dT));
}

export class PassThrough {
  constructor() {
    this.passThrough = true;
    this.state = 0;
  }
  updateCutoff() {}
  apply(input) {
    this.state = input;
    return input;
  }
  reset(value = 0) {
    this.state = value;
  }
}

// ---------------------------------------------------------------------------
// Biquad (BF 4.x `biquadFilter_t`, transposed direct form II)
// ---------------------------------------------------------------------------

export const BIQUAD_Q = 1.0 / Math.SQRT2; // Butterworth

// BF: common/filter.c:filterGetNotchQ
export function filterGetNotchQ(centerFreq, cutoffFreq) {
  return centerFreq * cutoffFreq / (centerFreq * centerFreq - cutoffFreq * cutoffFreq);
}

export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.weight = 1;
  }

  // BF: common/filter.c:biquadFilterInit (FILTER_NOTCH)
  initNotch(fHz, dT, Q) {
    this._update(fHz, dT, Q, 'notch', 1);
    this.x1 = this.x2 = 0;
    this.y1 = this.y2 = 0;
    return this;
  }

  // BF: common/filter.c:biquadFilterInitLPF
  initLpf(fHz, dT) {
    this._update(fHz, dT, BIQUAD_Q, 'lpf', 1);
    this.x1 = this.x2 = 0;
    this.y1 = this.y2 = 0;
    return this;
  }

  // BF: common/filter.c:biquadFilterUpdate
  _update(filterFreq, dT, Q, filterType, weight) {
    const omega = 2.0 * PI * filterFreq * dT;
    const sn = Math.sin(omega);
    const cs = Math.cos(omega);
    const alpha = sn / (2.0 * Q);

    if (filterType === 'lpf') {
      // 2nd order Butterworth (with Q=1/sqrt(2)) / Butterworth biquad section with Q
      this.b1 = 1 - cs;
      this.b0 = this.b1 * 0.5;
      this.b2 = this.b0;
      this.a1 = -2 * cs;
      this.a2 = 1 - alpha;
    } else if (filterType === 'notch') {
      this.b0 = 1;
      this.b1 = -2 * cs;
      this.b2 = 1;
      this.a1 = this.b1;
      this.a2 = 1 - alpha;
    } else {
      // FILTER_BPF
      this.b0 = alpha;
      this.b1 = 0;
      this.b2 = -alpha;
      this.a1 = -2 * cs;
      this.a2 = 1 - alpha;
    }

    const a0 = 1 + alpha;
    this.b0 /= a0;
    this.b1 /= a0;
    this.b2 /= a0;
    this.a1 /= a0;
    this.a2 /= a0;
    this.weight = weight;
  }

  // BF: common/filter.c:biquadFilterApply (transposed direct form II)
  apply(input) {
    const result = this.b0 * input + this.x1;
    this.x1 = this.b1 * input - this.a1 * result + this.x2;
    this.x2 = this.b2 * input - this.a2 * result;
    return result;
  }
}

// ---------------------------------------------------------------------------
// State-variable filters (BF 2025 notch implementation)
// ---------------------------------------------------------------------------

export class SvfNotch {
  // BF: common/filter.c:svfNotchInit
  constructor(filterFreq, dt, Q) {
    this.update(filterFreq, dt, Q);
    this.ic1q = 0.0;
    this.ic2 = 0.0;
  }

  // BF: common/filter.c:svfNotchUpdate
  update(filterFreq, dt, Q) {
    const f = Math.tan(PI * filterFreq * dt);
    const q = 1.0 / Q;
    const invDenom = 1.0 / (1.0 + f * (f + q));
    this.a1 = invDenom;
    this.a2q = (f * invDenom) * q;
    this.fq = f * Q;
  }

  // BF: common/filter.c:svfNotchApply
  apply(input) {
    const v3 = input - this.ic2;
    const v1q = this.a1 * this.ic1q + this.a2q * v3;
    const v2 = this.ic2 + this.fq * v1q;
    this.ic1q = 2.0 * v1q - this.ic1q;
    this.ic2 = 2.0 * v2 - this.ic2;
    return input - v1q;
  }
}

/**
 * One RPM-filter notch shared by the three gyro axes (BF `rpmNotch_t`): the
 * coefficients are common, the state is per axis.
 */
export class RpmNotch {
  // BF: common/filter.c:rpmNotchInit
  constructor(filterFreq, dt, Q, weight) {
    this.ic1 = new Float64Array(3);
    this.ic2 = new Float64Array(3);
    this.update(filterFreq, dt, Q, weight);
  }

  // BF: common/filter.c:rpmNotchUpdate
  update(filterFreq, dt, Q, weight) {
    const f = Math.tan(PI * filterFreq * dt);
    const q = 1.0 / Q;
    const a1 = 1.0 / (1.0 + f * (f + q));
    this.f = f;
    this.a1 = a1;
    this.a2 = f * a1;
    this.wq = q * weight;
  }

  // BF: common/filter.c:rpmNotchApply — filters `input[0..2]` in place.
  apply(input) {
    const a1 = this.a1;
    const a2 = this.a2;
    const f = this.f;
    const wq = this.wq;
    for (let i = 0; i < 3; i++) {
      const v3 = input[i] - this.ic2[i];
      const v1 = a1 * this.ic1[i] + a2 * v3;
      const v2 = this.ic2[i] + f * v1;
      this.ic1[i] = 2.0 * v1 - this.ic1[i];
      this.ic2[i] = 2.0 * v2 - this.ic2[i];
      input[i] -= wq * v1;
    }
  }
}

// ---------------------------------------------------------------------------
// Lagged moving average
// ---------------------------------------------------------------------------

export class LaggedMovingAverage {
  // BF: common/filter.c:laggedMovingAverageInit
  constructor(windowSize) {
    this.windowSize = windowSize;
    this.buf = new Float64Array(windowSize);
    this.movingWindowIndex = 0;
    this.movingSum = 0;
    this.primed = false;
  }

  // BF: common/filter.c:laggedMovingAverageUpdate
  update(input) {
    this.movingSum -= this.buf[this.movingWindowIndex];
    this.buf[this.movingWindowIndex] = input;
    this.movingSum += input;

    if (++this.movingWindowIndex === this.windowSize) {
      this.movingWindowIndex = 0;
      this.primed = true;
    }

    const denom = this.primed ? this.windowSize : this.movingWindowIndex;
    return this.movingSum / denom;
  }

  apply(input) {
    return this.update(input);
  }
}

// ---------------------------------------------------------------------------
// Small maths helpers used across the FC (BF common/maths.h)
// ---------------------------------------------------------------------------

export function constrainf(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

// BF: common/maths.c:scaleRangef
export function scaleRangef(x, srcFrom, srcTo, destFrom, destTo) {
  const a = (destTo - destFrom) * (x - srcFrom);
  const b = srcTo - srcFrom;
  return (a / b) + destFrom;
}

// BF: common/maths.c:fapplyDeadband
export function fapplyDeadband(value, deadband) {
  if (Math.abs(value) < deadband) {
    return 0;
  }
  return value >= 0 ? value - deadband : value + deadband;
}

export const power3 = (x) => x * x * x;
export const power5 = (x) => x * x * x * x * x;
