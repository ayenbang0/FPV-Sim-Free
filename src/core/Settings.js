/**
 * core/Settings.js
 * ---------------------------------------------------------------------------
 * A single source of truth for every user-tunable value, plus a persistence
 * layer that degrades to session-only storage when `localStorage` is
 * unavailable.
 *
 * (This file is a small addition to the file tree in the build spec. Input,
 * physics, camera, HUD, and audio all need the same tuning values; threading
 * them through constructors would have meant every settings change rebuilding
 * half the object graph. A tiny observable store is the cheaper, less
 * crash-prone option — see the README's "Deviations" note.)
 *
 * Storage rules:
 *   - `localStorage` throws in Safari private mode and when a site is denied
 *     storage access. Every read and write is wrapped; a failure downgrades
 *     `persistent` to false and the sim keeps running with in-memory settings.
 *   - Values loaded from storage are *validated*, not trusted. A hand-edited
 *     or version-skewed blob must not be able to inject a NaN into the flight
 *     model, so every field is coerced and range-checked on load.
 */

import { DRONE_TYPE_IDS, DEFAULT_DRONE_TYPE, getAirframe } from './DroneTypes.js';

const STORAGE_KEY = 'fpv-sim.settings.v2';

/** Factory so every caller gets an independent copy — no shared nested refs. */
export function defaultSettings() {
  return {
    /* ---- airframe ---- */
    droneType: DEFAULT_DRONE_TYPE,   // 'tinywhoop' | 'freestyle' | 'racer'

    /* ---- input ---- */
    inputMode: 'auto',          // 'auto' | 'keyboard' | 'gamepad'
    deadzone: 0.10,             // 0.00 – 0.40, rescaled (not merely clipped)
    expo: 0.50,                 // 0.00 – 1.00 stick curve
    sensitivity: { roll: 1.0, pitch: 1.0, yaw: 1.0 },
    // Seeded from the default airframe; `loadAirframeProfile()` rewrites these
    // whenever the pilot changes craft, exactly as a flight controller loads a
    // per-craft profile. The sliders then edit the loaded values.
    rates: { ...getAirframe(DEFAULT_DRONE_TYPE).rates },
    springThrottle: false,      // true for spring-centred gamepad sticks
    gamepadMapping: defaultGamepadMapping(),

    /* ---- simulation ---- */
    // Physics/flight-controller rate in Hz. Real flight controllers run their
    // rate loop in the kilohertz; 240 is the sweet spot in a browser, where a
    // higher number is free until the collision solver becomes the bottleneck.
    simRate: 240,               // 120 | 240 | 480 | 960
    adaptiveQuality: true,      // drop render resolution before dropping ticks

    flightMode: 'angle',        // 'angle' (assisted) | 'acro' (rate-only) | 'horizon'
    maxTilt: getAirframe(DEFAULT_DRONE_TYPE).maxTilt,   // deg, Angle-mode ceiling
    wind: false,                // outdoor maps only
    windSpeed: 2.5,             // m/s, 0..12 (Dryden-lite turbulence base)
    windGust: 0.5,              // 0..1 gust intensity scale

    // Betaflight-style rate curve. `rates` above stays the deg/s ceiling;
    // this shapes the curve under it. `useLegacy` reverts to `cmd*maxRate`.
    rateProfile: {
      roll: { rcRate: 1.0, superRate: 0.75, expo: 0.0 },
      pitch: { rcRate: 1.0, superRate: 0.75, expo: 0.0 },
      yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.0 },
      useLegacy: false,
    },
    // Betaflight Actual Rates (default since BF 4.3): center sensitivity
    // (deg/s per unit stick near centre) + max rate, expo shifts the kink.
    // `rateMode` picks which curve the flight loop evaluates.
    rateMode: 'betaflight',      // 'betaflight' | 'actual'
    actualProfile: {
      roll: { center: 90, expo: 0.4 },
      pitch: { center: 90, expo: 0.4 },
      yaw: { center: 110, expo: 0.35 },
    },
    ratePreset: 'stock',         // last-applied community preset id
    tpa: { start: 0.65, amount: 0.35 },   // throttle-PID-attenuation
    feedforward: 0.35,          // 0..1
    pidScale: { p: 1, i: 1, d: 1 },   // 0..2 per-term multipliers on the derived Kp/Ki/Kd
    // Motor thrust-curve exponent (thrust = max · cmd^k). Seeded from the
    // active craft and reseeded by loadAirframeProfile() on every switch,
    // exactly like rates/maxTilt — the raw exponent is a property of the
    // craft's props, the slider trims around it. 1..2.5.
    throttleCurve: getAirframe(DEFAULT_DRONE_TYPE).thrustExponent,
    horizonBlend: 0.5,          // 0..1, angle/acro blend in Horizon mode
    airmode: true,              // keep rotation authority at full throttle

    /* ---- rc link ---- */
    rcLatencyMs: 12,            // 0..60
    rcLoss: 0,                  // 0..5 %

    /* ---- fpv video ---- */
    fpvLatency: 28,             // 0..60 ms
    vtxBreakup: true,           // signal noise/tearing with distance
    vtxMode: 'distance',        // 'distance' (LOS falloff) | 'random' (link events)

    /* ---- environment ---- */
    sunAngle: 0.5,              // 0..1
    overcast: 0,                // 0..1
    dynamicWeather: false,      // slow cloud dimming + gust fronts (wind+dim only, no rain)

    /* ---- telemetry ---- */
    blackbox: false,

    /* ---- camera ---- */
    fov: 130,                   // deg, 90–150
    cameraTilt: 25,             // deg of uptilt on the cam mount
    cameraSmoothing: 0.75,      // 0 = rigid 1:1, 1 = very soft analog feel
    crtFilter: false,           // analog-goggle post FX
    lensDistortion: 0.14,       // 0..0.3 goggle barrel distortion; 0.14 = legacy FOV-linked look
    shake: 1.0,                 // camera-shake multiplier, 0 disables

    /* ---- graphics ---- */
    // Quality tier for the world renderer: shadow resolution, view distance,
    // grass/tree density, texture filtering. 'auto' picks from the GPU.
    graphicsQuality: 'auto',    // 'auto' | 'low' | 'medium' | 'high' | 'ultra'
    shadows: true,              // sun shadow map (resolution follows the quality tier)
    bloom: false,               // selective glow on lamps/windows/emissives
    bloomStrength: 0.55,        // 0..1.2
    motionBlur: false,          // cheap afterimage blur, FPV feel at speed

    /* ---- audio ---- */
    volume: 0.55,
    sfx: true,
    ghostVolume: 0.5,           // 0..1 rival-ghost motor level
    onboardAudio: false,        // true = onboard mic (no distance attenuation); false = grid (legacy)

    /* ---- ui ---- */
    hudVisible: true,
    horizonLadder: true,

    /* ---- progress ---- */
    bestTimes: {},              // mapId -> seconds
    ghostVisible: true,         // Nemesis ghost rival shown during time trials
  };
}

/**
 * Mode 2 layout, matching a real FPV transmitter and the spec's table.
 *
 * Axis bindings store the raw value at each end of travel (`lo` -> minimum
 * output, `hi` -> maximum) rather than an invert flag. One linear map then
 * covers a normal stick, a reversed one, and a partial-range transmitter pot,
 * and guided calibration can write measured endpoints straight in.
 *
 * These defaults are correct for a browser-reported `mapping: "standard"` pad.
 * Anything else is driver-defined and may need calibration.
 */
export function defaultGamepadMapping() {
  return {
    // Stick pushed up reports -1, and up must mean full power.
    throttle: { type: 'axis', index: 1, lo: 1,  hi: -1, mode: 'unipolar' },
    yaw:      { type: 'axis', index: 0, lo: -1, hi: 1,  mode: 'bipolar' },
    // Right-stick Y reports -1 when pushed away from the pilot, and pushing
    // away must mean "pitch forward".
    pitch:    { type: 'axis', index: 3, lo: 1,  hi: -1, mode: 'bipolar' },
    roll:     { type: 'axis', index: 2, lo: -1, hi: 1,  mode: 'bipolar' },

    arm:      { type: 'button', index: 0 },
    reset:    { type: 'button', index: 1 },
    mode:     { type: 'button', index: 2 },
    camera:   { type: 'button', index: 3 },
    turtle:   { type: 'button', index: 4 },
    pause:    { type: 'button', index: 9 },
  };
}

/** Human-readable labels for the remap screen. */
export const REMAPPABLE = [
  { key: 'throttle', label: 'Throttle', kind: 'axis' },
  { key: 'yaw',      label: 'Yaw',      kind: 'axis' },
  { key: 'pitch',    label: 'Pitch',    kind: 'axis' },
  { key: 'roll',     label: 'Roll',     kind: 'axis' },
  { key: 'arm',      label: 'Arm / Disarm', kind: 'button' },
  { key: 'reset',    label: 'Reset',    kind: 'button' },
  { key: 'mode',     label: 'Flight mode', kind: 'button' },
  { key: 'camera',   label: 'Camera view', kind: 'button' },
  { key: 'turtle',   label: 'Turtle flip', kind: 'button' },
  { key: 'pause',    label: 'Pause',    kind: 'button' },
];

/* ========================================================================== *
 * Safe storage
 * ========================================================================== */

function storageRead(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch (_e) {
    return null;
  }
}

function storageWrite(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch (_e) {
    // QuotaExceeded, private browsing, or storage blocked by policy.
    return false;
  }
}

/* ========================================================================== *
 * Validation
 * ========================================================================== */

const num = (v, min, max, fallback) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

/**
 * Merge a stored blob over the defaults, coercing every field.
 * Unknown keys are dropped; malformed values fall back silently.
 */
function sanitize(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;

  d.droneType = oneOf(raw.droneType, DRONE_TYPE_IDS, d.droneType);
  d.inputMode = oneOf(raw.inputMode, ['auto', 'keyboard', 'gamepad'], d.inputMode);
  d.deadzone = num(raw.deadzone, 0, 0.4, d.deadzone);
  d.expo = num(raw.expo, 0, 1, d.expo);
  d.springThrottle = bool(raw.springThrottle, d.springThrottle);

  if (raw.sensitivity && typeof raw.sensitivity === 'object') {
    d.sensitivity.roll = num(raw.sensitivity.roll, 0.2, 2, d.sensitivity.roll);
    d.sensitivity.pitch = num(raw.sensitivity.pitch, 0.2, 2, d.sensitivity.pitch);
    d.sensitivity.yaw = num(raw.sensitivity.yaw, 0.2, 2, d.sensitivity.yaw);
  }
  if (raw.rates && typeof raw.rates === 'object') {
    d.rates.roll = num(raw.rates.roll, 100, 1400, d.rates.roll);
    d.rates.pitch = num(raw.rates.pitch, 100, 1400, d.rates.pitch);
    d.rates.yaw = num(raw.rates.yaw, 50, 900, d.rates.yaw);
  }

  d.gamepadMapping = sanitizeMapping(raw.gamepadMapping);

  d.simRate = [120, 240, 480, 960].includes(raw.simRate) ? raw.simRate : d.simRate;
  d.adaptiveQuality = bool(raw.adaptiveQuality, d.adaptiveQuality);

  d.flightMode = oneOf(raw.flightMode, ['angle', 'acro', 'horizon'], d.flightMode);
  d.maxTilt = num(raw.maxTilt, 10, 75, d.maxTilt);
  d.wind = bool(raw.wind, d.wind);
  d.windSpeed = num(raw.windSpeed, 0, 12, d.windSpeed);
  d.windGust = num(raw.windGust, 0, 1, d.windGust);

  d.ratePreset = oneOf(raw.ratePreset, RATE_PRESET_IDS, d.ratePreset);
  d.rateMode = oneOf(raw.rateMode, ['betaflight', 'actual'], d.rateMode);
  if (raw.actualProfile && typeof raw.actualProfile === 'object') {
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const src = raw.actualProfile[axis];
      if (src && typeof src === 'object') {
        d.actualProfile[axis].center = num(src.center, 10, 2000, d.actualProfile[axis].center);
        d.actualProfile[axis].expo = num(src.expo, 0, 1, d.actualProfile[axis].expo);
      }
    }
  }
  if (raw.rateProfile && typeof raw.rateProfile === 'object') {
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const src = raw.rateProfile[axis];
      if (src && typeof src === 'object') {
        d.rateProfile[axis].rcRate = num(src.rcRate, 0.5, 2.5, d.rateProfile[axis].rcRate);
        d.rateProfile[axis].superRate = num(src.superRate, 0, 1, d.rateProfile[axis].superRate);
        d.rateProfile[axis].expo = num(src.expo, 0, 1, d.rateProfile[axis].expo);
      }
    }
    d.rateProfile.useLegacy = bool(raw.rateProfile.useLegacy, d.rateProfile.useLegacy);
  }
  if (raw.tpa && typeof raw.tpa === 'object') {
    d.tpa.start = num(raw.tpa.start, 0, 1, d.tpa.start);
    d.tpa.amount = num(raw.tpa.amount, 0, 0.6, d.tpa.amount);
  }
  d.feedforward = num(raw.feedforward, 0, 1, d.feedforward);
  // Per-term PID trims. Out-of-range values clamp; non-numeric garbage falls
  // back to the default (neutral 1.0), never NaN — the rate loop multiplies
  // by these every substep, so a poisoned value would tumble the quad.
  if (raw.pidScale && typeof raw.pidScale === 'object') {
    d.pidScale.p = num(raw.pidScale.p, 0, 2, d.pidScale.p);
    d.pidScale.i = num(raw.pidScale.i, 0, 2, d.pidScale.i);
    d.pidScale.d = num(raw.pidScale.d, 0, 2, d.pidScale.d);
  }
  d.throttleCurve = num(raw.throttleCurve, 1, 2.5, d.throttleCurve);
  d.airmode = bool(raw.airmode, d.airmode);
  d.horizonBlend = num(raw.horizonBlend, 0, 1, d.horizonBlend);

  d.rcLatencyMs = num(raw.rcLatencyMs, 0, 60, d.rcLatencyMs);
  d.rcLoss = num(raw.rcLoss, 0, 5, d.rcLoss);

  d.fpvLatency = num(raw.fpvLatency, 0, 60, d.fpvLatency);
  d.vtxBreakup = bool(raw.vtxBreakup, d.vtxBreakup);
  d.vtxMode = oneOf(raw.vtxMode, ['distance', 'random'], d.vtxMode);

  d.sunAngle = num(raw.sunAngle, 0, 1, d.sunAngle);
  d.overcast = num(raw.overcast, 0, 1, d.overcast);
  d.dynamicWeather = bool(raw.dynamicWeather, d.dynamicWeather);

  d.blackbox = bool(raw.blackbox, d.blackbox);

  d.fov = num(raw.fov, 70, 155, d.fov);
  d.cameraTilt = num(raw.cameraTilt, 0, 55, d.cameraTilt);
  d.cameraSmoothing = num(raw.cameraSmoothing, 0, 1, d.cameraSmoothing);
  d.crtFilter = bool(raw.crtFilter, d.crtFilter);
  d.lensDistortion = num(raw.lensDistortion, 0, 0.3, d.lensDistortion);
  d.shake = num(raw.shake, 0, 2, d.shake);

  d.graphicsQuality = oneOf(raw.graphicsQuality, ['auto', 'low', 'medium', 'high', 'ultra'], d.graphicsQuality);
  d.shadows = bool(raw.shadows, d.shadows);
  d.bloom = bool(raw.bloom, d.bloom);
  d.bloomStrength = num(raw.bloomStrength, 0, 1.2, d.bloomStrength);
  d.motionBlur = bool(raw.motionBlur, d.motionBlur);

  d.volume = num(raw.volume, 0, 1, d.volume);
  d.sfx = bool(raw.sfx, d.sfx);
  d.ghostVolume = num(raw.ghostVolume, 0, 1, d.ghostVolume);
  d.onboardAudio = bool(raw.onboardAudio, d.onboardAudio);

  d.hudVisible = bool(raw.hudVisible, d.hudVisible);
  d.horizonLadder = bool(raw.horizonLadder, d.horizonLadder);
  d.ghostVisible = bool(raw.ghostVisible, d.ghostVisible);

  if (raw.bestTimes && typeof raw.bestTimes === 'object') {
    for (const [k, v] of Object.entries(raw.bestTimes)) {
      const t = num(v, 0.01, 99999, NaN);
      if (Number.isFinite(t)) d.bestTimes[String(k).slice(0, 40)] = t;
    }
  }

  return d;
}

function sanitizeMapping(raw) {
  const d = defaultGamepadMapping();
  if (!raw || typeof raw !== 'object') return d;

  for (const { key, kind } of REMAPPABLE) {
    const b = raw[key];
    if (!b || typeof b !== 'object') continue;

    const type = oneOf(b.type, ['axis', 'button'], kind);
    const index = num(b.index, 0, 63, d[key].index);
    if (!Number.isInteger(index)) continue;

    if (type === 'axis') {
      const mode = oneOf(b.mode, ['bipolar', 'unipolar'], key === 'throttle' ? 'unipolar' : 'bipolar');
      const binding = { type: 'axis', index, mode };

      // Calibrated endpoints win; otherwise fall back to the legacy invert
      // flag so a mapping stored by an older build still loads.
      const lo = num(b.lo, -1, 1, NaN);
      const hi = num(b.hi, -1, 1, NaN);
      if (Number.isFinite(lo) && Number.isFinite(hi) && Math.abs(hi - lo) > 0.2) {
        binding.lo = lo;
        binding.hi = hi;
      } else if (bool(b.invert, false)) {
        binding.lo = 1;
        binding.hi = -1;
      } else {
        binding.lo = -1;
        binding.hi = 1;
      }
      d[key] = binding;
    } else {
      d[key] = { type: 'button', index };
    }
  }
  return d;
}

/* ========================================================================== *
 * Community rate presets (Velocidrone / Liftoff parity + style baselines)
 * --------------------------------------------------------------------------
 * Each preset is a complete stick-feel recipe: the curve mode, the per-axis
 * curve values, and the deg/s ceilings. Applying one writes the same keys the
 * sliders edit, so a preset is a starting point, never a lock-in.
 * Values follow published community baselines (Oscar Liang, UAVMODEL 2026):
 * racers ~linear at 550-1000 deg/s, freestyle soft-centre at 700-900,
 * cinematic flat at ~450, whoops gentle at ~550.
 * ========================================================================== */

export const RATE_PRESETS = {
  stock: { label: 'Stock (per-craft defaults)', apply: null },
  custom: { label: 'Custom (hand-edited)', apply: null },
  velocidrone: {
    label: 'Velocidrone parity — linear race',
    apply: {
      rateMode: 'betaflight',
      rates: { roll: 700, pitch: 700, yaw: 600 },
      rateProfile: {
        roll: { rcRate: 1.0, superRate: 0.65, expo: 0.15 },
        pitch: { rcRate: 1.0, superRate: 0.65, expo: 0.15 },
        yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.10 },
      },
    },
  },
  liftoff: {
    label: 'Liftoff parity — soft freestyle',
    apply: {
      rateMode: 'betaflight',
      rates: { roll: 750, pitch: 750, yaw: 650 },
      rateProfile: {
        roll: { rcRate: 1.2, superRate: 0.70, expo: 0.25 },
        pitch: { rcRate: 1.2, superRate: 0.70, expo: 0.25 },
        yaw: { rcRate: 1.1, superRate: 0.65, expo: 0.20 },
      },
    },
  },
  race1000: {
    label: 'Race 1000°/s — aggressive linear',
    apply: {
      rateMode: 'betaflight',
      rates: { roll: 1000, pitch: 1000, yaw: 900 },
      rateProfile: {
        roll: { rcRate: 1.6, superRate: 0.78, expo: 0.10 },
        pitch: { rcRate: 1.6, superRate: 0.78, expo: 0.10 },
        yaw: { rcRate: 1.5, superRate: 0.70, expo: 0.10 },
      },
    },
  },
  freestyle800: {
    label: 'Freestyle 800°/s — snappy centre',
    apply: {
      rateMode: 'betaflight',
      rates: { roll: 800, pitch: 800, yaw: 700 },
      rateProfile: {
        roll: { rcRate: 1.4, superRate: 0.75, expo: 0.15 },
        pitch: { rcRate: 1.4, superRate: 0.75, expo: 0.15 },
        yaw: { rcRate: 1.3, superRate: 0.65, expo: 0.15 },
      },
    },
  },
  cinematic450: {
    label: 'Cinematic 450°/s — smooth cruiser',
    apply: {
      rateMode: 'betaflight',
      rates: { roll: 450, pitch: 450, yaw: 400 },
      rateProfile: {
        roll: { rcRate: 1.0, superRate: 0.60, expo: 0.40 },
        pitch: { rcRate: 1.0, superRate: 0.60, expo: 0.40 },
        yaw: { rcRate: 1.0, superRate: 0.55, expo: 0.35 },
      },
    },
  },
  whoop550: {
    label: 'Whoop 550°/s — gentle indoor',
    apply: {
      rateMode: 'betaflight',
      rates: { roll: 550, pitch: 550, yaw: 450 },
      rateProfile: {
        roll: { rcRate: 1.0, superRate: 0.70, expo: 0.50 },
        pitch: { rcRate: 1.0, superRate: 0.70, expo: 0.50 },
        yaw: { rcRate: 1.0, superRate: 0.60, expo: 0.40 },
      },
    },
  },
  actual800: {
    label: 'Actual Rates 800°/s — BF 4.3+ style',
    apply: {
      rateMode: 'actual',
      rates: { roll: 800, pitch: 800, yaw: 700 },
      actualProfile: {
        roll: { center: 90, expo: 0.40 },
        pitch: { center: 90, expo: 0.40 },
        yaw: { center: 110, expo: 0.35 },
      },
    },
  },
};

export const RATE_PRESET_IDS = Object.keys(RATE_PRESETS);

/* ========================================================================== *
 * Store
 * ========================================================================== */

class SettingsStore {
  constructor() {
    /** False once a write has failed — the UI surfaces this so the user knows
     *  their tweaks are session-only rather than silently discarded. */
    this.persistent = true;

    this.values = sanitize(safeParse(storageRead(STORAGE_KEY)));
    this._listeners = new Set();

    // Probe once at boot so `persistent` is accurate before the user changes
    // anything, rather than only after their first failed save.
    if (!storageWrite(STORAGE_KEY + '.probe', '1')) {
      this.persistent = false;
    } else {
      try { localStorage.removeItem(STORAGE_KEY + '.probe'); } catch (_e) { /* ignore */ }
    }
  }

  /** Read a top-level setting. */
  get(key) {
    return this.values[key];
  }

  /**
   * Write one or more settings and notify listeners.
   * Accepts either `set('fov', 120)` or `set({ fov: 120, expo: 0.4 })`.
   */
  set(keyOrPatch, maybeValue) {
    const patch = typeof keyOrPatch === 'string'
      ? { [keyOrPatch]: maybeValue }
      : keyOrPatch;

    if (!patch || typeof patch !== 'object') return;

    Object.assign(this.values, patch);
    // Re-run validation so a bad value from a UI control can never reach the
    // flight model — sliders are the most likely source of a stray NaN.
    this.values = sanitize(this.values);

    this.save();
    this._emit(Object.keys(patch));
  }

  /**
   * Adopt an airframe's rate and tilt profile.
   *
   * Rates are a property of the craft, not of the pilot: 900 deg/s is right for
   * a race quad and unflyable on a whoop. Switching craft therefore reloads the
   * profile, and the settings sliders go on editing whatever is loaded.
   */
  loadAirframeProfile(droneType) {
    const spec = getAirframe(droneType);
    const superRateByType = { tinywhoop: 0.6, freestyle: 0.75, racer: 0.85 };
    const superRate = num(superRateByType[spec.id], 0, 1, 0.75);
    this.set({
      droneType: spec.id,
      rates: { ...spec.rates },
      maxTilt: spec.maxTilt,
      ratePreset: 'stock',
      // Stock craft tunes are Betaflight-curve based; a lingering Actual mode
      // would silently reinterpret the fresh ceilings, so it resets too.
      rateMode: 'betaflight',
      // The thrust exponent is a prop property like rates/maxTilt, so it
      // reloads with the craft. Deliberately NOT resetting pidScale: trims
      // are the pilot's, like feedforward and TPA.
      throttleCurve: num(spec.thrustExponent, 1, 2.5, this.values.throttleCurve),
      rateProfile: {
        roll: { rcRate: 1.0, superRate, expo: 0.0 },
        pitch: { rcRate: 1.0, superRate, expo: 0.0 },
        yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.0 },
        useLegacy: this.values.rateProfile?.useLegacy ?? false,
      },
    });
  }

  /**
   * Apply a community rate preset (see RATE_PRESETS). Writes the same keys
   * the sliders edit, so the result stays fully tunable afterwards.
   * Returns true when a real preset was applied.
   */
  loadRatePreset(presetId) {
    const preset = RATE_PRESETS[presetId];
    if (!preset || !preset.apply) {
      if (presetId === 'stock') {
        this.loadAirframeProfile(this.values.droneType);
        return true;
      }
      return false;
    }
    const patch = { ratePreset: presetId };
    if (preset.apply.rateMode) patch.rateMode = preset.apply.rateMode;
    if (preset.apply.rates) patch.rates = { ...preset.apply.rates };
    if (preset.apply.rateProfile) {
      patch.rateProfile = {
        roll: { ...preset.apply.rateProfile.roll },
        pitch: { ...preset.apply.rateProfile.pitch },
        yaw: { ...preset.apply.rateProfile.yaw },
        useLegacy: this.values.rateProfile?.useLegacy ?? false,
      };
    }
    if (preset.apply.actualProfile) {
      patch.actualProfile = {
        roll: { ...preset.apply.actualProfile.roll },
        pitch: { ...preset.apply.actualProfile.pitch },
        yaw: { ...preset.apply.actualProfile.yaw },
      };
    }
    this.set(patch);
    return true;
  }

  /** Record a Time Trial best, keeping only an improvement. */
  recordBestTime(mapId, seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const prev = this.values.bestTimes[mapId];
    if (Number.isFinite(prev) && prev <= seconds) return false;
    this.values.bestTimes[mapId] = seconds;
    this.save();
    this._emit(['bestTimes']);
    return true;
  }

  save() {
    const ok = storageWrite(STORAGE_KEY, JSON.stringify(this.values));
    if (!ok) this.persistent = false;
    return ok;
  }

  /** Restore factory defaults (keeps recorded best times). */
  reset() {
    const times = this.values.bestTimes;
    this.values = defaultSettings();
    this.values.bestTimes = times;
    this.save();
    this._emit(Object.keys(this.values));
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(changedKeys) {
    for (const fn of this._listeners) {
      // One misbehaving listener must not stop the others from updating.
      try {
        fn(this.values, changedKeys);
      } catch (err) {
        console.warn('[Settings] listener threw', err);
      }
    }
  }
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

/** Shared singleton — settings are global to the app by nature. */
export const settings = new SettingsStore();

/* ========================================================================== *
 * Nemesis ghosts (local time-trial recordings)
 * -------------------------------------------------------------------------- *
 * A ghost is one finished lap: `{ time, samples }` where `samples` holds
 * `{ t, pos: [x, y, z], quat: [x, y, z, w] }` recorded at 10 Hz and capped at
 * 3 minutes (1800 samples). Ghosts live in their own localStorage namespace —
 * a single lap is ~100+ KB of JSON, far too large for the settings blob —
 * keyed per map+airframe as `ghost.<map>.<airframe>` (see `ghostKey`).
 *
 * Quota bounding: at most GHOST_MAX_ENTRIES ghosts are kept across all pairs,
 * least-recently-stored first. Every write goes through the same try/catch
 * path (`storageWrite` never throws); when a write fails the oldest entry is
 * dropped and the write retried until it fits or nothing is left to drop.
 * Ghosts survive `reset()` alongside best times — both are earned records.
 * Every numeric field is validated on the way in AND on the way out, so a
 * hand-edited blob can never inject a NaN into the scene graph.
 * ========================================================================== */

/** localStorage namespace for ghosts, separate from the settings blob. */
const GHOST_STORAGE_KEY = 'fpv-sim.ghosts.v1';

/** Max ghosts kept across all map+airframe pairs; oldest dropped first (LRU). */
export const GHOST_MAX_ENTRIES = 3;

/** Ghosts are sampled at 10 Hz and capped at 3 minutes (1800 samples). */
export const GHOST_SAMPLE_DT = 0.1;
export const GHOST_MAX_SAMPLES = 1800;

/** Clamp for a stored world-position component (bounds stay ≤500 m; margin included). */
const GHOST_POS_LIMIT = 5000;   // the largest maps span ~3 km

/** Storage key fragment for one map+airframe pair: `ghost.<map>.<airframe>`. */
export function ghostKey(mapId, airframeId) {
  const m = String(mapId ?? 'unknown').slice(0, 40) || 'unknown';
  const a = String(airframeId ?? 'unknown').slice(0, 40) || 'unknown';
  return `${m}.${a}`;
}

function clampGhostNum(v, min, max) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.min(max, Math.max(min, n));
}

/**
 * Validate one recorded sample. Returns a clean copy or null — the caller
 * drops nulls, so corrupt entries shrink the ghost instead of breaking it.
 */
export function sanitizeGhostSample(s) {
  if (!s || typeof s !== 'object') return null;
  const t = clampGhostNum(s.t, 0, 10800);
  if (!Number.isFinite(t)) return null;
  const p = s.pos;
  const q = s.quat;
  if (!Array.isArray(p) || p.length !== 3 || !Array.isArray(q) || q.length !== 4) return null;
  const pos = [
    clampGhostNum(p[0], -GHOST_POS_LIMIT, GHOST_POS_LIMIT),
    clampGhostNum(p[1], -GHOST_POS_LIMIT, GHOST_POS_LIMIT),
    clampGhostNum(p[2], -GHOST_POS_LIMIT, GHOST_POS_LIMIT),
  ];
  if (pos.some((v) => !Number.isFinite(v))) return null;
  const qr = [
    clampGhostNum(q[0], -1, 1),
    clampGhostNum(q[1], -1, 1),
    clampGhostNum(q[2], -1, 1),
    clampGhostNum(q[3], -1, 1),
  ];
  if (qr.some((v) => !Number.isFinite(v))) return null;
  const len = Math.hypot(qr[0], qr[1], qr[2], qr[3]);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { t, pos, quat: [qr[0] / len, qr[1] / len, qr[2] / len, qr[3] / len] };
}

function readGhostBlob() {
  const raw = safeParse(storageRead(GHOST_STORAGE_KEY));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function writeGhostBlob(blob) {
  let text = null;
  try {
    text = JSON.stringify(blob);
  } catch (_e) {
    return false;
  }
  return storageWrite(GHOST_STORAGE_KEY, text);
}

function sanitizeGhostEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const time = clampGhostNum(entry.time, 0.01, 99999);
  if (!Number.isFinite(time)) return null;
  if (!Array.isArray(entry.samples)) return null;
  const samples = [];
  for (const s of entry.samples) {
    const c = sanitizeGhostSample(s);
    if (c) samples.push(c);
    if (samples.length >= GHOST_MAX_SAMPLES) break;
  }
  if (samples.length === 0) return null;
  return { time, samples };
}

/** Load the stored ghost for one map+airframe pair, or null when absent/corrupt. */
export function loadGhost(mapId, airframeId) {
  const blob = readGhostBlob();
  return sanitizeGhostEntry(blob[ghostKey(mapId, airframeId)]);
}

/**
 * Store a finished lap as the pair's ghost. Returns true when stored.
 * Needs at least 2 samples; anything less is not a lap worth replaying.
 */
export function saveGhost(mapId, airframeId, time, samples) {
  if (!Number.isFinite(time) || !(time > 0)) return false;
  if (!Array.isArray(samples)) return false;
  const clean = [];
  for (const s of samples) {
    const c = sanitizeGhostSample(s);
    if (c) clean.push(c);
    if (clean.length >= GHOST_MAX_SAMPLES) break;
  }
  if (clean.length < 2) return false;
  const key = ghostKey(mapId, airframeId);
  const blob = readGhostBlob();
  // Refresh recency: re-insert at the tail so eviction drops the true oldest.
  if (Object.prototype.hasOwnProperty.call(blob, key)) delete blob[key];
  blob[key] = { time, samples: clean };
  while (Object.keys(blob).length > GHOST_MAX_ENTRIES) delete blob[Object.keys(blob)[0]];
  for (;;) {
    if (writeGhostBlob(blob)) return Object.prototype.hasOwnProperty.call(blob, key);
    const keys = Object.keys(blob);
    if (keys.length === 0) return false;
    delete blob[keys[0]];
  }
}
