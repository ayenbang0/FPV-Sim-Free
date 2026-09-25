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

const STORAGE_KEY = 'fpv-sim.settings.v3';
const LEGACY_STORAGE_KEY = 'fpv-sim.settings.v2';
/** v2 keys that survive the v3 migration; everything else resets. */
const V2_CARRY_OVER = ['gamepadMapping', 'bestTimes', 'volume', 'graphicsQuality', 'droneType'];

/** Factory so every caller gets an independent copy — no shared nested refs. */
export function defaultSettings() {
  return {
    /* ---- airframe ---- */
    droneType: DEFAULT_DRONE_TYPE,   // 'tinywhoop' | 'freestyle' | 'racer'

    /* ---- input ---- */
    inputMode: 'auto',          // 'auto' | 'keyboard' | 'gamepad' | 'serial'
    rcDeadband: 10,             // µs, 0–50, applied by the FC (BF deadband / yaw_deadband)
    rxChannelMap: 'AETR',       // 'AETR' | 'TAER' — order of the source's first four channels
    springThrottle: false,      // true for spring-centred gamepad sticks
    gamepadMapping: defaultGamepadMapping(),
    // Betaflight Modes tab: { mode, channel (0-based, 4 = AUX1), min, max } µs
    modes: defaultModes(),
    serialProtocol: 'crsf',     // 'crsf' | 'sbus'
    serialBaud: 420000,

    /* ---- simulation ---- */
    // Physics / flight-controller loop rate in Hz (Betaflight PID loop).
    simRate: 1000,              // 2000 | 1000 | 500
    adaptiveQuality: true,      // drop render resolution before dropping ticks

    flightMode: 'angle',        // fallback when no ANGLE/HORIZON mode range is mapped
    wind: false,                // outdoor maps only
    windSpeed: 2.5,             // m/s, 0..12 (Dryden-lite turbulence base)
    windGust: 0.5,              // 0..1 gust intensity scale

    /* ---- flight controller (Betaflight units) ---- */
    // Seeded from the default airframe's stock tune; loadAirframeProfile()
    // rewrites them whenever the pilot changes craft.
    fcRates: fcRatesFromTune(getAirframe(DEFAULT_DRONE_TYPE).tune),
    fcPid: fcPidFromTune(getAirframe(DEFAULT_DRONE_TYPE).tune),
    fcFilters: fcFiltersFromTune(getAirframe(DEFAULT_DRONE_TYPE).tune),
    fcMisc: defaultFcMisc(getAirframe(DEFAULT_DRONE_TYPE)),
    ratePreset: 'stock',         // last-applied rate preset id

    /* ---- gates ---- */
    gateSpec: 'league',         // 'league' | 'multigp' — applied on the next map load

    /* ---- rc link ---- */
    rcLatencyMs: 12,            // 0..60
    rcLoss: 0,                  // 0..5 %

    /* ---- fpv video ---- */
    videoSystem: 'hd',          // 'hd' (DJI O4 / Walksnail) | 'analog' (4:3, CRT goggle)
    fpvLatency: 28,             // 0..60 ms; switching videoSystem in the UI writes 28 (HD) / 12 (analog)
    vtxBreakup: true,           // signal noise/tearing with distance
    vtxMode: 'distance',        // 'distance' (LOS falloff) | 'random' (link events)

    /* ---- environment ---- */
    sunAngle: 0.5,              // 0..1
    overcast: 0,                // 0..1
    dynamicWeather: false,      // slow cloud dimming + gust fronts (wind+dim only, no rain)

    /* ---- telemetry ---- */
    blackbox: false,

    /* ---- camera ---- */
    fov: 145,                   // deg, 70–170: horizontal FOV of the FPV image
    fpvLens: 'fisheye',         // 'rectilinear' | 'fisheye' | 'fisheye-cube' (see render/FpvLens.js)
    lensFisheye: 0.8,           // 0 = pinhole, 1 = equidistant fisheye
    propsInView: true,          // prop blur visible at the frame edges in FPV
    cameraTilt: 25,             // deg of uptilt on the cam mount
    cameraSmoothing: 0.75,      // 0 = rigid 1:1, 1 = very soft analog feel
    shake: 1.0,                 // camera-shake multiplier, 0 disables

    /* ---- graphics ---- */
    // Quality tier for the world renderer: shadow resolution, view distance,
    // grass/tree density, texture filtering. 'auto' picks from the GPU.
    graphicsQuality: 'auto',    // 'auto' | 'low' | 'medium' | 'high' | 'ultra'
    renderBackend: 'auto',      // 'auto' | 'webgpu' | 'webgl2' — applies on reload
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
  { key: 'aux1',     label: 'AUX 1 (switch)', kind: 'axis' },
  { key: 'aux2',     label: 'AUX 2 (switch)', kind: 'axis' },
  { key: 'aux3',     label: 'AUX 3 (switch)', kind: 'axis' },
  { key: 'aux4',     label: 'AUX 4 (switch)', kind: 'axis' },
  { key: 'aux5',     label: 'AUX 5', kind: 'axis' },
  { key: 'aux6',     label: 'AUX 6', kind: 'axis' },
  { key: 'aux7',     label: 'AUX 7', kind: 'axis' },
  { key: 'aux8',     label: 'AUX 8', kind: 'axis' },
];

export const AUX_KEYS = ['aux1', 'aux2', 'aux3', 'aux4', 'aux5', 'aux6', 'aux7', 'aux8'];

/**
 * Gamepad-as-radio presets (EdgeTX/OpenTX USB joystick, ELRS BLE joystick).
 * Each writes a complete mapping plus the channel order; `axisBindings`
 * follow the same lo/hi endpoint convention as the default mapping.
 */
export const RADIO_PRESETS = {
  edgetx: {
    label: 'EdgeTX / OpenTX (AETR)',
    rxChannelMap: 'AETR',
    mapping: () => ({
      ...defaultGamepadMapping(),
      roll: { type: 'axis', index: 0, lo: -1, hi: 1, mode: 'bipolar' },
      pitch: { type: 'axis', index: 1, lo: -1, hi: 1, mode: 'bipolar' },
      // Radios send throttle as a full −1..1 axis: map it across the whole range.
      throttle: { type: 'axis', index: 2, lo: -1, hi: 1, mode: 'unipolar' },
      yaw: { type: 'axis', index: 3, lo: -1, hi: 1, mode: 'bipolar' },
      aux1: { type: 'axis', index: 4, lo: -1, hi: 1, mode: 'bipolar' },
      aux2: { type: 'axis', index: 5, lo: -1, hi: 1, mode: 'bipolar' },
      aux3: { type: 'axis', index: 6, lo: -1, hi: 1, mode: 'bipolar' },
      aux4: { type: 'axis', index: 7, lo: -1, hi: 1, mode: 'bipolar' },
    }),
  },
  taer: {
    label: 'Spektrum / Futaba order (TAER)',
    rxChannelMap: 'TAER',
    mapping: () => ({
      ...defaultGamepadMapping(),
      throttle: { type: 'axis', index: 0, lo: -1, hi: 1, mode: 'unipolar' },
      roll: { type: 'axis', index: 1, lo: -1, hi: 1, mode: 'bipolar' },
      pitch: { type: 'axis', index: 2, lo: -1, hi: 1, mode: 'bipolar' },
      yaw: { type: 'axis', index: 3, lo: -1, hi: 1, mode: 'bipolar' },
      aux1: { type: 'axis', index: 4, lo: -1, hi: 1, mode: 'bipolar' },
      aux2: { type: 'axis', index: 5, lo: -1, hi: 1, mode: 'bipolar' },
      aux3: { type: 'axis', index: 6, lo: -1, hi: 1, mode: 'bipolar' },
      aux4: { type: 'axis', index: 7, lo: -1, hi: 1, mode: 'bipolar' },
    }),
  },
  gamepad: {
    label: 'Xbox / PlayStation pad (standard)',
    rxChannelMap: 'AETR',
    mapping: () => defaultGamepadMapping(),
  },
};

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
  d.inputMode = oneOf(raw.inputMode, ['auto', 'keyboard', 'gamepad', 'serial'], d.inputMode);
  d.rcDeadband = num(raw.rcDeadband, 0, 50, d.rcDeadband);
  d.rxChannelMap = oneOf(raw.rxChannelMap, ['AETR', 'TAER'], d.rxChannelMap);
  d.springThrottle = bool(raw.springThrottle, d.springThrottle);
  d.gamepadMapping = sanitizeMapping(raw.gamepadMapping);
  d.modes = sanitizeModes(raw.modes, d.modes);
  d.serialProtocol = oneOf(raw.serialProtocol, ['crsf', 'sbus'], d.serialProtocol);
  d.serialBaud = oneOf(raw.serialBaud, [420000, 416666, 921600, 100000], d.serialBaud);

  d.simRate = SIM_RATE_OPTIONS.includes(raw.simRate) ? raw.simRate : d.simRate;
  d.adaptiveQuality = bool(raw.adaptiveQuality, d.adaptiveQuality);

  d.flightMode = oneOf(raw.flightMode, ['angle', 'acro', 'horizon'], d.flightMode);
  d.wind = bool(raw.wind, d.wind);
  d.windSpeed = num(raw.windSpeed, 0, 12, d.windSpeed);
  d.windGust = num(raw.windGust, 0, 1, d.windGust);

  d.fcRates = sanitizeFcRates(raw.fcRates, d.fcRates);
  d.fcPid = sanitizeFcPid(raw.fcPid, d.fcPid);
  d.fcFilters = sanitizeFcFilters(raw.fcFilters, d.fcFilters);
  d.fcMisc = sanitizeFcMisc(raw.fcMisc, d.fcMisc);
  d.ratePreset = oneOf(raw.ratePreset, RATE_PRESET_IDS, d.ratePreset);
  d.gateSpec = oneOf(raw.gateSpec, ['league', 'multigp'], d.gateSpec);

  d.rcLatencyMs = num(raw.rcLatencyMs, 0, 60, d.rcLatencyMs);
  d.rcLoss = num(raw.rcLoss, 0, 5, d.rcLoss);

  d.videoSystem = oneOf(raw.videoSystem, ['hd', 'analog'], d.videoSystem);
  d.fpvLatency = num(raw.fpvLatency, 0, 60, d.fpvLatency);
  d.vtxBreakup = bool(raw.vtxBreakup, d.vtxBreakup);
  d.vtxMode = oneOf(raw.vtxMode, ['distance', 'random'], d.vtxMode);

  d.sunAngle = num(raw.sunAngle, 0, 1, d.sunAngle);
  d.overcast = num(raw.overcast, 0, 1, d.overcast);
  d.dynamicWeather = bool(raw.dynamicWeather, d.dynamicWeather);

  d.blackbox = bool(raw.blackbox, d.blackbox);

  d.fov = num(raw.fov, 70, 170, d.fov);
  d.fpvLens = oneOf(raw.fpvLens, ['rectilinear', 'fisheye', 'fisheye-cube'], d.fpvLens);
  d.lensFisheye = num(raw.lensFisheye, 0, 1, d.lensFisheye);
  d.propsInView = bool(raw.propsInView, d.propsInView);
  d.cameraTilt = num(raw.cameraTilt, 0, 55, d.cameraTilt);
  d.cameraSmoothing = num(raw.cameraSmoothing, 0, 1, d.cameraSmoothing);
  d.shake = num(raw.shake, 0, 2, d.shake);

  d.graphicsQuality = oneOf(raw.graphicsQuality, ['auto', 'low', 'medium', 'high', 'ultra'], d.graphicsQuality);
  d.renderBackend = oneOf(raw.renderBackend, ['auto', 'webgpu', 'webgl2'], d.renderBackend);
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
    const index = num(b.index, 0, 63, d[key]?.index ?? NaN);
    if (!Number.isInteger(index)) continue;

    if (type === 'axis') {
      const mode = oneOf(b.mode, ['bipolar', 'unipolar'], key === 'throttle' ? 'unipolar' : 'bipolar');
      if (!Number.isFinite(index)) continue;
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
 * Flight-controller settings (Betaflight units)
 * ========================================================================== */

export const SIM_RATE_OPTIONS = [2000, 1000, 500];
export const RATES_TYPES = ['actual', 'betaflight', 'quick', 'kiss', 'raceflight'];

/** Default Betaflight Modes-tab ranges. */
export function defaultModes() {
  return [
    { mode: 'ARM', channel: 4, min: 1700, max: 2100 },
    { mode: 'ANGLE', channel: 5, min: 900, max: 1300 },
    { mode: 'HORIZON', channel: 5, min: 1300, max: 1700 },
    { mode: 'FLIPOVERAFTERCRASH', channel: 6, min: 1700, max: 2100 },
  ];
}
const MODE_IDS = ['ARM', 'ANGLE', 'HORIZON', 'FLIPOVERAFTERCRASH', 'BEEPER', 'PREARM'];

function sanitizeModes(raw, fallback) {
  if (!Array.isArray(raw)) return fallback;
  const out = [];
  for (const m of raw.slice(0, 12)) {
    if (!m || typeof m !== 'object' || !MODE_IDS.includes(m.mode)) continue;
    const channel = Math.round(num(m.channel, 4, 15, NaN));
    if (!Number.isFinite(channel)) continue;
    const min = Math.round(num(m.min, 900, 2100, 900));
    const max = Math.round(num(m.max, 900, 2100, 2100));
    out.push({ mode: m.mode, channel, min: Math.min(min, max), max: Math.max(min, max) });
  }
  return out;
}

function fcRatesFromTune(tune) {
  const r = tune.rates;
  return {
    type: r.type,
    rcRates: r.rcRates.slice(),
    rates: r.rates.slice(),
    rcExpo: r.rcExpo.slice(),
    thrMid: r.thrMid ?? 50,
    thrExpo: r.thrExpo ?? 0,
    rateLimit: (r.rateLimit || [1998, 1998, 1998]).slice(),
  };
}

function fcPidFromTune(tune) {
  const axis = (a) => ({ p: a.p, i: a.i, d: a.d, dMax: a.dMax, f: a.f });
  return {
    roll: axis(tune.pid.roll),
    pitch: axis(tune.pid.pitch),
    yaw: axis(tune.pid.yaw),
    levelP: 50,
    levelI: 75,
    levelD: 75,
    angleLimit: tune.angleLimit ?? 55,
  };
}

function fcFiltersFromTune(tune) {
  const f = tune.filters || {};
  return {
    dtermLpf1Min: f.dtermLpf1Min ?? 75,
    dtermLpf1Max: f.dtermLpf1Max ?? 150,
    dtermLpf2: f.dtermLpf2 ?? 150,
    gyroLpf1Min: f.gyroLpf1Min ?? 250,
    gyroLpf1Max: f.gyroLpf1Max ?? 500,
    gyroLpf2: f.gyroLpf2 ?? 500,
    rpmFilter: f.rpmFilter ?? true,
    rpmHarmonics: f.rpmHarmonics ?? 3,
    yawLowpass: f.yawLowpass ?? 100,
  };
}

function defaultFcMisc(spec) {
  return {
    airmode: true,
    antiGravityGain: 80,
    itermRelaxCutoff: 15,
    tpaRate: 65,
    tpaBreakpoint: 1350,
    throttleBoost: 5,
    thrustLinear: 0,
    motorOutputLimit: 100,
    dshotIdle: Math.round((spec?.dshotIdle ?? 0.055) * 1000) / 10,
    ffJitter: 7,
    ffSmooth: 65,
    ffBoost: 15,
    ffMaxRateLimit: 90,
    rcSmoothingAuto: 30,
  };
}

const int = (v, min, max, fallback) => Math.round(num(v, min, max, fallback));
const arr3 = (v, fn, fallback) => (Array.isArray(v) ? [0, 1, 2].map((i) => fn(v[i], fallback[i])) : fallback.slice());

function sanitizeFcRates(raw, d) {
  if (!raw || typeof raw !== 'object') return d;
  const type = oneOf(raw.type, RATES_TYPES, d.type);
  const rateMax = type === 'actual' ? 200 : 255;
  return {
    type,
    rcRates: arr3(raw.rcRates, (v, f) => int(v, 1, 255, f), d.rcRates),
    rates: arr3(raw.rates, (v, f) => int(v, 0, rateMax, f), d.rates),
    rcExpo: arr3(raw.rcExpo, (v, f) => int(v, 0, 100, f), d.rcExpo),
    thrMid: int(raw.thrMid, 0, 100, d.thrMid),
    thrExpo: int(raw.thrExpo, 0, 100, d.thrExpo),
    rateLimit: arr3(raw.rateLimit, (v, f) => int(v, 200, 1998, f), d.rateLimit),
  };
}

function sanitizeFcPid(raw, d) {
  if (!raw || typeof raw !== 'object') return d;
  const axis = (a, f) => (a && typeof a === 'object' ? {
    p: int(a.p, 0, 250, f.p), i: int(a.i, 0, 250, f.i), d: int(a.d, 0, 250, f.d),
    dMax: int(a.dMax, 0, 250, f.dMax), f: int(a.f, 0, 1000, f.f),
  } : { ...f });
  return {
    roll: axis(raw.roll, d.roll),
    pitch: axis(raw.pitch, d.pitch),
    yaw: axis(raw.yaw, d.yaw),
    levelP: int(raw.levelP, 0, 250, d.levelP),
    levelI: int(raw.levelI, 0, 250, d.levelI),
    levelD: int(raw.levelD, 0, 250, d.levelD),
    angleLimit: int(raw.angleLimit, 10, 90, d.angleLimit),
  };
}

function sanitizeFcFilters(raw, d) {
  if (!raw || typeof raw !== 'object') return d;
  return {
    dtermLpf1Min: int(raw.dtermLpf1Min, 0, 1000, d.dtermLpf1Min),
    dtermLpf1Max: int(raw.dtermLpf1Max, 0, 1000, d.dtermLpf1Max),
    dtermLpf2: int(raw.dtermLpf2, 0, 1000, d.dtermLpf2),
    gyroLpf1Min: int(raw.gyroLpf1Min, 0, 1000, d.gyroLpf1Min),
    gyroLpf1Max: int(raw.gyroLpf1Max, 0, 1000, d.gyroLpf1Max),
    gyroLpf2: int(raw.gyroLpf2, 0, 1000, d.gyroLpf2),
    rpmFilter: bool(raw.rpmFilter, d.rpmFilter),
    rpmHarmonics: int(raw.rpmHarmonics, 0, 3, d.rpmHarmonics),
    yawLowpass: int(raw.yawLowpass, 0, 500, d.yawLowpass),
  };
}

function sanitizeFcMisc(raw, d) {
  if (!raw || typeof raw !== 'object') return d;
  return {
    airmode: bool(raw.airmode, d.airmode),
    antiGravityGain: int(raw.antiGravityGain, 0, 250, d.antiGravityGain),
    itermRelaxCutoff: int(raw.itermRelaxCutoff, 1, 50, d.itermRelaxCutoff),
    tpaRate: int(raw.tpaRate, 0, 100, d.tpaRate),
    tpaBreakpoint: int(raw.tpaBreakpoint, 1000, 2000, d.tpaBreakpoint),
    throttleBoost: int(raw.throttleBoost, 0, 100, d.throttleBoost),
    thrustLinear: int(raw.thrustLinear, 0, 150, d.thrustLinear),
    motorOutputLimit: int(raw.motorOutputLimit, 1, 100, d.motorOutputLimit),
    dshotIdle: Math.round(num(raw.dshotIdle, 0, 20, d.dshotIdle) * 10) / 10,
    ffJitter: int(raw.ffJitter, 0, 20, d.ffJitter),
    ffSmooth: int(raw.ffSmooth, 0, 95, d.ffSmooth),
    ffBoost: int(raw.ffBoost, 0, 50, d.ffBoost),
    ffMaxRateLimit: int(raw.ffMaxRateLimit, 0, 150, d.ffMaxRateLimit),
    rcSmoothingAuto: int(raw.rcSmoothingAuto, 1, 250, d.rcSmoothingAuto),
  };
}

/**
 * The FlightController tune for the current settings: the `fc*` keys plus
 * the airframe's pack and the radio settings.
 */
export function buildFcTune(values, spec) {
  return {
    rates: values.fcRates,
    pid: values.fcPid,
    filters: values.fcFilters,
    misc: values.fcMisc,
    rc: { deadband: values.rcDeadband, protocol: values.inputMode === 'serial' ? values.serialProtocol : 'none' },
    modes: values.modes,
    cells: spec?.battery?.cells ?? 0,
  };
}

/* ========================================================================== *
 * Rate presets (applied to fcRates; Betaflight units)
 * --------------------------------------------------------------------------
 * Actual: [center/10, max/10, expo]. Betaflight: [rcRate×100, super×100, expo].
 * ========================================================================== */

const actualPreset = (rp, yaw = rp) => ({
  type: 'actual',
  rcRates: [rp[0], rp[0], yaw[0]], rates: [rp[1], rp[1], yaw[1]], rcExpo: [rp[2], rp[2], yaw[2]],
});
const bfPreset = (rp, yaw = rp) => ({
  type: 'betaflight',
  rcRates: [rp[0], rp[0], yaw[0]], rates: [rp[1], rp[1], yaw[1]], rcExpo: [rp[2], rp[2], yaw[2]],
});

export const RATE_PRESETS = {
  stock: { label: 'Stock (per-craft tune)', apply: null },
  'bf-default': { label: 'Betaflight default — Actual 70 / 670', apply: actualPreset([7, 67, 0]) },
  freestyle800: { label: 'Freestyle 800°/s — Actual', apply: actualPreset([10, 80, 55], [10, 64, 55]) },
  race900: { label: 'Race 900°/s — Actual', apply: actualPreset([25, 90, 20], [25, 72, 20]) },
  cinematic450: { label: 'Cinematic 450°/s — Actual', apply: actualPreset([6, 45, 30]) },
  whoop700: { label: 'Whoop 700°/s — Actual', apply: actualPreset([20, 70, 50]) },
  velocidrone: { label: 'Velocidrone parity — Betaflight rates', apply: bfPreset([100, 70, 0], [100, 65, 0]) },
  liftoff: { label: 'Liftoff parity — Betaflight rates', apply: bfPreset([120, 72, 25], [110, 65, 20]) },
  custom: { label: 'Custom (hand-edited)', apply: null },
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

    this.values = sanitize(safeParse(storageRead(STORAGE_KEY)) || migrateV2());
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
   * Adopt an airframe's stock Betaflight tune: rates, PIDs, filters and motor
   * idle, as a flight controller loads a per-craft profile. The Betaflight
   * settings then edit whatever is loaded.
   */
  loadAirframeProfile(droneType) {
    const spec = getAirframe(droneType);
    this.set({
      droneType: spec.id,
      fcRates: fcRatesFromTune(spec.tune),
      fcPid: fcPidFromTune(spec.tune),
      fcFilters: fcFiltersFromTune(spec.tune),
      fcMisc: { ...this.values.fcMisc, dshotIdle: Math.round(spec.dshotIdle * 1000) / 10 },
      ratePreset: 'stock',
    });
  }

  /** Apply a rate preset to fcRates. Returns true when something was applied. */
  loadRatePreset(presetId) {
    const preset = RATE_PRESETS[presetId];
    if (!preset || !preset.apply) {
      if (presetId === 'stock') {
        const spec = getAirframe(this.values.droneType);
        this.set({ fcRates: fcRatesFromTune(spec.tune), ratePreset: 'stock' });
        return true;
      }
      return false;
    }
    const a = preset.apply;
    this.set({
      ratePreset: presetId,
      fcRates: {
        ...this.values.fcRates,
        type: a.type,
        rcRates: a.rcRates.slice(),
        rates: a.rates.slice(),
        rcExpo: a.rcExpo.slice(),
      },
    });
    return true;
  }

  /** Apply a gamepad-as-radio preset (mapping + channel order + deadband 0). */
  loadRadioPreset(presetId) {
    const p = RADIO_PRESETS[presetId];
    if (!p) return false;
    this.set({
      gamepadMapping: p.mapping(),
      rxChannelMap: p.rxChannelMap,
      rcDeadband: presetId === 'gamepad' ? 10 : 0,
    });
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

/**
 * First load of v3: carry over the few v2 keys whose meaning did not change,
 * then drop the v2 blob. Returns null when there is nothing to migrate.
 */
function migrateV2() {
  const old = safeParse(storageRead(LEGACY_STORAGE_KEY));
  if (!old || typeof old !== 'object') return null;
  const carried = {};
  for (const k of V2_CARRY_OVER) if (k in old) carried[k] = old[k];
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (_e) { /* ignore */ }
  const migrated = sanitize(carried);
  // The carried craft brings its own stock tune.
  const spec = getAirframe(migrated.droneType);
  migrated.fcRates = fcRatesFromTune(spec.tune);
  migrated.fcPid = fcPidFromTune(spec.tune);
  migrated.fcFilters = fcFiltersFromTune(spec.tune);
  migrated.fcMisc = defaultFcMisc(spec);
  storageWrite(STORAGE_KEY, JSON.stringify(migrated));
  return migrated;
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
