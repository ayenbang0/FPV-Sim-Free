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
    wind: false,                // Field map only
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
    tpa: { start: 0.65, amount: 0.35 },   // throttle-PID-attenuation
    feedforward: 0.35,          // 0..1
    airmode: true,              // full authority at max throttle
    horizonBlend: 0.5,          // 0..1, angle/acro blend in Horizon mode

    /* ---- rc link ---- */
    rcLatencyMs: 12,            // 0..60
    rcLoss: 0,                  // 0..5 %

    /* ---- fpv video ---- */
    fpvLatency: 28,             // 0..60 ms
    vtxBreakup: true,           // signal noise/tearing with distance

    /* ---- environment ---- */
    sunAngle: 0.5,              // 0..1
    overcast: 0,                // 0..1

    /* ---- telemetry ---- */
    blackbox: false,

    /* ---- camera ---- */
    fov: 130,                   // deg, 90–150
    cameraTilt: 25,             // deg of uptilt on the cam mount
    cameraSmoothing: 0.75,      // 0 = rigid 1:1, 1 = very soft analog feel
    crtFilter: false,           // analog-goggle post FX
    shake: 1.0,                 // camera-shake multiplier, 0 disables

    /* ---- audio ---- */
    volume: 0.55,
    sfx: true,

    /* ---- ui ---- */
    hudVisible: true,
    horizonLadder: true,

    /* ---- progress ---- */
    bestTimes: {},              // mapId -> seconds
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
  d.airmode = bool(raw.airmode, d.airmode);
  d.horizonBlend = num(raw.horizonBlend, 0, 1, d.horizonBlend);

  d.rcLatencyMs = num(raw.rcLatencyMs, 0, 60, d.rcLatencyMs);
  d.rcLoss = num(raw.rcLoss, 0, 5, d.rcLoss);

  d.fpvLatency = num(raw.fpvLatency, 0, 60, d.fpvLatency);
  d.vtxBreakup = bool(raw.vtxBreakup, d.vtxBreakup);

  d.sunAngle = num(raw.sunAngle, 0, 1, d.sunAngle);
  d.overcast = num(raw.overcast, 0, 1, d.overcast);

  d.blackbox = bool(raw.blackbox, d.blackbox);

  d.fov = num(raw.fov, 70, 155, d.fov);
  d.cameraTilt = num(raw.cameraTilt, 0, 55, d.cameraTilt);
  d.cameraSmoothing = num(raw.cameraSmoothing, 0, 1, d.cameraSmoothing);
  d.crtFilter = bool(raw.crtFilter, d.crtFilter);
  d.shake = num(raw.shake, 0, 2, d.shake);

  d.volume = num(raw.volume, 0, 1, d.volume);
  d.sfx = bool(raw.sfx, d.sfx);

  d.hudVisible = bool(raw.hudVisible, d.hudVisible);
  d.horizonLadder = bool(raw.horizonLadder, d.horizonLadder);

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
      rateProfile: {
        roll: { rcRate: 1.0, superRate, expo: 0.0 },
        pitch: { rcRate: 1.0, superRate, expo: 0.0 },
        yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.0 },
        useLegacy: this.values.rateProfile?.useLegacy ?? false,
      },
    });
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
