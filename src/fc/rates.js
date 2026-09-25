/**
 * fc/rates.js
 * ---------------------------------------------------------------------------
 * Stick-to-setpoint rate curves and the throttle curve, ported from
 * Betaflight 2025.12 `src/main/fc/rc.c` (GPL-3.0-or-later). Pure JS.
 *
 * `profile` uses BF's integer units, the same numbers the Configurator shows:
 *   rcRates[3]   RC Rate ×100 (Betaflight/Quick/Kiss), center ÷10 (Actual),
 *                rate (RaceFlight)
 *   rates[3]     Super rate ×100 (Betaflight/Kiss), max ÷10 (Actual/Quick),
 *                acro+ (RaceFlight)
 *   rcExpo[3]    expo %
 *   quickRatesRcExpo  0|1
 *   rateLimit[3] deg/s clamp, default 1998
 *   thrMid, thrExpo, thrHover   throttle curve, % (BF thrMid8/thrExpo8/thrHover8)
 */

import { constrainf, power3, power5 } from './filters.js';

export const RATES_TYPES = ['betaflight', 'raceflight', 'kiss', 'actual', 'quick'];

export const SETPOINT_RATE_LIMIT_MIN = -1998.0;
export const SETPOINT_RATE_LIMIT_MAX = 1998.0;
export const CONTROL_RATE_CONFIG_RATE_LIMIT_MAX = 1998;
export const RC_RATE_INCREMENTAL = 14.54;

/** BF `ratesSettingLimits`: max of { rcRates, rates, rcExpo } per type. */
export const RATES_SETTINGS_LIMITS = {
  betaflight: { rcRate: 255, rate: 100, expo: 100 },
  raceflight: { rcRate: 200, rate: 255, expo: 100 },
  kiss: { rcRate: 255, rate: 99, expo: 100 },
  actual: { rcRate: 200, rate: 200, expo: 100 },
  quick: { rcRate: 255, rate: 200, expo: 100 },
};

// BF: fc/rc.c:applyBetaflightRates
function applyBetaflightRates(axis, rcCommandf, rcCommandfAbs, p) {
  if (p.rcExpo[axis]) {
    const expof = p.rcExpo[axis] / 100.0;
    rcCommandf = rcCommandf * power3(rcCommandfAbs) * expof + rcCommandf * (1 - expof);
  }

  let rcRate = p.rcRates[axis] / 100.0;
  if (rcRate > 2.0) {
    rcRate += RC_RATE_INCREMENTAL * (rcRate - 2.0);
  }
  let angleRate = 200.0 * rcRate * rcCommandf;
  if (p.rates[axis]) {
    const rcSuperfactor = 1.0 / (constrainf(1.0 - (rcCommandfAbs * (p.rates[axis] / 100.0)), 0.01, 1.00));
    angleRate *= rcSuperfactor;
  }

  return angleRate;
}

// BF: fc/rc.c:applyRaceFlightRates
function applyRaceFlightRates(axis, rcCommandf, rcCommandfAbs, p) {
  // -1.0 to 1.0 ranged and curved
  rcCommandf = ((1.0 + 0.01 * p.rcExpo[axis] * (rcCommandf * rcCommandf - 1.0)) * rcCommandf);
  // convert to -2000 to 2000 range using acro+ modifier
  let angleRate = 10.0 * p.rcRates[axis] * rcCommandf;
  angleRate = angleRate * (1 + rcCommandfAbs * p.rates[axis] * 0.01);

  return angleRate;
}

// BF: fc/rc.c:applyKissRates
function applyKissRates(axis, rcCommandf, rcCommandfAbs, p) {
  const rcCurvef = p.rcExpo[axis] / 100.0;

  const kissRpyUseRates = 1.0 / (constrainf(1.0 - (rcCommandfAbs * (p.rates[axis] / 100.0)), 0.01, 1.00));
  const kissRcCommandf = (power3(rcCommandf) * rcCurvef + rcCommandf * (1 - rcCurvef)) * (p.rcRates[axis] / 1000.0);
  const kissAngle = constrainf(((2000.0 * kissRpyUseRates) * kissRcCommandf), SETPOINT_RATE_LIMIT_MIN, SETPOINT_RATE_LIMIT_MAX);

  return kissAngle;
}

// BF: fc/rc.c:applyActualRates
function applyActualRates(axis, rcCommandf, rcCommandfAbs, p) {
  let expof = p.rcExpo[axis] / 100.0;
  expof = rcCommandfAbs * (power5(rcCommandf) * expof + rcCommandf * (1 - expof));

  const centerSensitivity = p.rcRates[axis] * 10.0;
  const stickMovement = Math.max(0, p.rates[axis] * 10.0 - centerSensitivity);
  const angleRate = rcCommandf * centerSensitivity + stickMovement * expof;

  return angleRate;
}

// BF: fc/rc.c:applyQuickRates
function applyQuickRates(axis, rcCommandf, rcCommandfAbs, p) {
  // uint16_t arithmetic in BF
  const rcRate = (p.rcRates[axis] * 2) & 0xffff;
  const maxDPS = Math.max(p.rates[axis] * 10, rcRate) & 0xffff;
  const expof = p.rcExpo[axis] / 100.0;
  const superFactorConfig = (maxDPS / rcRate - 1) / (maxDPS / rcRate);

  let curve;
  let superFactor;
  let angleRate;

  if (p.quickRatesRcExpo) {
    curve = power3(rcCommandf) * expof + rcCommandf * (1 - expof);
    superFactor = 1.0 / (constrainf(1.0 - (rcCommandfAbs * superFactorConfig), 0.01, 1.00));
    angleRate = constrainf(curve * rcRate * superFactor, SETPOINT_RATE_LIMIT_MIN, SETPOINT_RATE_LIMIT_MAX);
  } else {
    curve = power3(rcCommandfAbs) * expof + rcCommandfAbs * (1 - expof);
    superFactor = 1.0 / (constrainf(1.0 - (curve * superFactorConfig), 0.01, 1.00));
    angleRate = constrainf(rcCommandf * rcRate * superFactor, SETPOINT_RATE_LIMIT_MIN, SETPOINT_RATE_LIMIT_MAX);
  }

  return angleRate;
}

const RATE_FNS = {
  betaflight: applyBetaflightRates,
  raceflight: applyRaceFlightRates,
  kiss: applyKissRates,
  actual: applyActualRates,
  quick: applyQuickRates,
};

/** Rate function for a type; unknown types fall back to Betaflight, as BF does. */
export function ratesFunction(type) {
  return RATE_FNS[type] || applyBetaflightRates;
}

function rateLimitOf(profile, axis) {
  const lim = profile.rateLimit ? profile.rateLimit[axis] : CONTROL_RATE_CONFIG_RATE_LIMIT_MAX;
  return Number.isFinite(lim) ? lim : CONTROL_RATE_CONFIG_RATE_LIMIT_MAX;
}

// BF: fc/rc.c:processRcCommand (applyRates, then constrain to rate_limit)
/** Setpoint (deg/s) for a stick deflection −1..1, clamped to ±rateLimit. */
export function applyRates(type, axis, rcCommandf, profile) {
  const angleRate = ratesFunction(type)(axis, rcCommandf, Math.abs(rcCommandf), profile);
  const lim = rateLimitOf(profile, axis);
  return constrainf(angleRate, -lim, lim);
}

// BF: fc/rc.c:initRcProcessing (maxRcRate[i] = applyRates(i, 1.0f, 1.0f))
/**
 * Full-stick rate, taken through the same ±rateLimit clamp as the setpoint
 * so the angle-mode scale and the feedforward limit agree with the largest
 * setpoint the sticks can produce.
 */
export function maxRcRate(type, axis, profile) {
  return applyRates(type, axis, 1, profile);
}

// ---------------------------------------------------------------------------
// Throttle curve
// ---------------------------------------------------------------------------

export const THROTTLE_LOOKUP_LENGTH = 12;
export const PWM_RANGE_MIN = 1000;
export const PWM_RANGE_MAX = 2000;
export const PWM_RANGE = PWM_RANGE_MAX - PWM_RANGE_MIN;

// BF: fc/rc.c:quadraticBezier
function quadraticBezier(x, p0x, p1x, p2x, p0y, p1y, p2y) {
  // Solve for t such that Bezier_x(t) = x
  const a = p0x - 2.0 * p1x + p2x;
  const b = 2.0 * p1x - 2.0 * p0x;
  const c = p0x - x;
  let t = 0.0;

  if (Math.abs(a) < 1e-6) { // Linear equation case (a is close to zero)
    if (Math.abs(b) > 1e-6) {
      t = -c / b;
    }
  } else {
    const disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      const sqrtD = Math.sqrt(disc);
      const t1 = (-b + sqrtD) / (2.0 * a);
      const t2 = (-b - sqrtD) / (2.0 * a);
      if (t1 >= 0.0 && t1 <= 1.0) {
        t = t1;
      } else {
        t = t2;
      }
    }
  }

  t = constrainf(t, 0.0, 1.0);
  return (1.0 - t) * (1.0 - t) * p0y + 2.0 * (1.0 - t) * t * p1y + t * t * p2y;
}

// BF: fc/rc.c:initRcProcessing (throttle-curve part)
/**
 * The throttle lookup table (µs, 1000..2000). BF 2025 replaced the older
 * `generateThrottleCurve` with this two-segment Bézier through the hover
 * point; thr_mid / thr_expo keep their meaning.
 */
export function generateThrottleCurve(thrMid8 = 50, thrExpo8 = 0, thrHover8 = 50) {
  const thrMid = thrMid8 / 100.0;
  const expo = thrExpo8 / 100.0;
  const thrHover = thrHover8 / 100.0;

  const cp1x = thrMid * 0.5;
  const cp1y = thrHover * 0.5 * (1.0 + expo);
  const cp2x = (1.0 + thrMid) * 0.5;
  const cp2y = (1.0 + ((thrHover - 1.0) * 0.5 * (1.0 + expo)));

  const table = new Int16Array(THROTTLE_LOOKUP_LENGTH);
  for (let i = 0; i < THROTTLE_LOOKUP_LENGTH; i++) {
    const x = i / (THROTTLE_LOOKUP_LENGTH - 1);
    let y;
    if (x <= thrMid) {
      y = quadraticBezier(x, 0.0, cp1x, thrMid, 0.0, cp1y, thrHover);
    } else {
      y = quadraticBezier(x, thrMid, cp2x, 1.0, thrHover, cp2y, 1.0);
    }
    // lrintf(scaleRangef(y, 0, 1, PWM_RANGE_MIN, PWM_RANGE_MAX))
    table[i] = Math.round(y * (PWM_RANGE_MAX - PWM_RANGE_MIN) + PWM_RANGE_MIN);
  }
  return table;
}

// BF: common/maths.c:scaleRange (integer, truncating division)
function scaleRangeInt(x, srcFrom, srcTo, destFrom, destTo) {
  const a = (destTo - destFrom) * (x - srcFrom);
  const b = srcTo - srcFrom;
  return Math.trunc(a / b) + destFrom;
}

// BF: fc/rc.c:rcLookupThrottle — `tmp` is 0..PWM_RANGE (integer).
export function rcLookupThrottle(table, tmp) {
  const steps = THROTTLE_LOOKUP_LENGTH - 1;
  const scaled = tmp * steps;
  const idx = Math.trunc(scaled / PWM_RANGE);
  const rem = scaled % PWM_RANGE;

  if (idx >= steps) {
    return table[steps];
  } else if (idx < 0) {
    return table[0];
  }
  return scaleRangeInt(rem, 0, PWM_RANGE, table[idx], table[idx + 1]);
}
