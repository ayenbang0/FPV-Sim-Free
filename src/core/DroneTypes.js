/**
 * core/DroneTypes.js
 * ---------------------------------------------------------------------------
 * The airframes: a physical description of each quad (mass, geometry, motor,
 * ESC, propeller, battery and drag figures) plus its stock Betaflight tune.
 * QuadPhysics.js turns the physical numbers into forces; src/fc runs the tune.
 *
 * Every performance number the UI shows — thrust-to-weight, hover throttle,
 * top RPM — is *derived* here from those physical figures, never typed in:
 *
 *   V      = cells · 3.9                        loaded nominal pack voltage
 *   ωmax   = Kv_rad·(V − Rm·(qRatio·Tmax/Kt + I0))   full-throttle rotor speed
 *   kT     = Tmax / ωmax²                        static thrust coefficient
 *            (then refined against the steady-state bus solve, so Tmax is
 *            exactly the full-duty static thrust on a fresh pack)
 *   kQ     = qRatio · kT                         torque coefficient
 *   hover  = bisection on the steady-state bus solve (4 motors lifting weight)
 *
 * Top speed and idle sink depend on the whole closed loop, so they are
 * measured by flying the model (tests/fit-aero.mjs) and recorded per airframe.
 *
 * Stock tunes are Betaflight units (P/I/D/Dmax/F), rates are Actual rates:
 * `rcRates` = centre ÷ 10, `rates` = max ÷ 10, `rcExpo` = expo %. Yaw uses the
 * roll curve with 0.8 × the roll max.
 */

import { motorConstants, steadyState, cellOcv } from './QuadPhysics.js';

/**
 * Stock Actual-rates profile in BF integer units.
 * @param {number} center  deg/s
 * @param {number} max     deg/s (roll and pitch; yaw gets 0.8×)
 * @param {number} expo    %
 */
function actualRates(center, max, expo) {
  return {
    type: 'actual',
    rcRates: [center / 10, center / 10, center / 10],
    rates: [max / 10, max / 10, Math.round(0.8 * max) / 10],
    rcExpo: [expo, expo, expo],
    thrMid: 50,
    thrExpo: 0,
    rateLimit: [1998, 1998, 1998],
  };
}

/**
 * @typedef {object} AirframeSpec
 * @property {string}  id
 * @property {number}  mass          kg, all-up weight
 * @property {number}  arm           m, motor offset from centre on X and Z
 * @property {number[]} body         collider dimensions (w, h, d), m
 * @property {number}  kv            motor KV, rpm/V
 * @property {number}  rm            winding resistance, Ω
 * @property {number}  i0            no-load current, A
 * @property {number}  escLimit      ESC current limit, A
 * @property {number}  tmax          static thrust per motor at full throttle, N
 * @property {number}  propDiameter  m
 * @property {number}  propPitch     m
 * @property {number}  qRatio        prop torque / thrust, m
 * @property {number}  jrot          rotor (motor bell + prop) inertia, kg·m²
 * @property {number}  rotorDrag     H-force coefficient, N/(rad/s)/(m/s)
 * @property {number[]} cdA          body drag area [side, top, front], m²
 * @property {number}  auxCurrent    FC + VTX + camera draw, A
 * @property {number}  dshotIdle     motor idle, fraction of full duty
 * @property {number}  vibration     gyro vibration at full RPM, deg/s
 * @property {number}  propHeight    prop plane above the CG, m
 * @property {object}  battery       { chemistry, cells, label, mah, resistance }
 * @property {object}  tune          stock Betaflight tune { pid, filters, rates, angleLimit }
 */

const AIRFRAMES = [
  {
    id: 'tinywhoop',
    displayName: 'Tinywhoop',
    className: '65 mm · 28 g · 1S HV',
    description:
      'Ducted 65 mm micro on 1S HV. Slow, draggy and light enough to bounce off everything — the only sane choice indoors.',
    accent: 'linear-gradient(160deg, #8fd6ff 0%, #4f9fd4 55%, #2c5f80 100%)',

    mass: 0.028,
    arm: 0.023,
    body: [0.075, 0.028, 0.075],
    kv: 27000,
    rm: 1.2,
    i0: 0.1,
    escLimit: 5,
    tmax: 0.22,
    propDiameter: 0.031,
    propPitch: 0.02,
    qRatio: 0.003,
    jrot: 2.5e-8,
    rotorDrag: 1.2e-7,
    cdA: [0.00192, 0.0265, 0.00192],
    auxCurrent: 0.35,
    dshotIdle: 0.07,
    vibration: 25,
    propHeight: 0.012,
    battery: { chemistry: 'lihv', cells: 1, label: '1S', mah: 300, resistance: 0.06 },

    tune: {
      pid: {
        roll: { p: 124, i: 160, d: 89, dMax: 107, f: 60 },
        pitch: { p: 133, i: 171, d: 98, dMax: 117, f: 65 },
        yaw: { p: 143, i: 160, d: 0, dMax: 0, f: 60 },
      },
      filters: { dtermLpf1Min: 100, dtermLpf1Max: 200, dtermLpf2: 200 },
      rates: actualRates(200, 700, 50),
      angleLimit: 45,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 8.2,
    sinkRate: 3.8,

    visual: {
      ducted: true,
      propRadius: 0.0155,           // 31 mm props
      bodyColor: 0x2f3a44,
      accentColor: 0x59c8ff,
      motorColor: 0x9aa3ab,
      scale: 1,
    },
    // 0802 motors on 31 mm props: a high, thin mosquito whine.,
    audio: { base: 330, span: 900, idle: 0.10 },
    cameraMount: [0, 0.016, -0.012],
  },
  {
    id: 'freestyle',
    displayName: '5" Freestyle',
    className: '250 mm · 650 g · 6S',
    description:
      'The standard 5-inch quad on 6S. Honest handling, strong punch and around 140 km/h flat out. Start here.',
    accent: 'linear-gradient(160deg, #7fe6b0 0%, #2fae72 55%, #1a6444 100%)',

    mass: 0.65,
    arm: 0.09,
    body: [0.2, 0.06, 0.2],
    kv: 1860,
    rm: 0.07,
    i0: 1.4,
    escLimit: 55,
    tmax: 17.5,
    propDiameter: 0.1295,
    propPitch: 0.0914,
    qRatio: 0.0115,
    jrot: 6.5e-6,   // fitted: 10–90 % spool ≈ 80 ms
    rotorDrag: 2.0e-5,
    cdA: [0.0101, 0.0287, 0.0101],
    auxCurrent: 0.6,
    dshotIdle: 0.055,
    vibration: 40,
    propHeight: 0.028,
    battery: { chemistry: 'lipo', cells: 6, label: '6S', mah: 1300, resistance: 0.025 },

    tune: {
      pid: {
        roll: { p: 45, i: 80, d: 30, dMax: 40, f: 120 },
        pitch: { p: 47, i: 84, d: 34, dMax: 46, f: 125 },
        yaw: { p: 45, i: 80, d: 0, dMax: 0, f: 120 },
      },
      filters: {},
      rates: actualRates(100, 800, 55),
      angleLimit: 55,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 38.4,
    sinkRate: 10.8,

    visual: {
      ducted: false,
      propRadius: 0.0635,           // 5" props
      bodyColor: 0x2a2c30,
      accentColor: 0x18e08a,
      motorColor: 0x8a8d92,
      scale: 1,
    },
    // 2207 motors on 5" props: the familiar mid-range buzz.,
    audio: { base: 95, span: 420, idle: 0.07 },
    cameraMount: [0, 0.035, -0.03],
  },
  {
    id: 'racer',
    displayName: 'Race Quad',
    className: '210 mm · 580 g · 6S',
    description:
      'High-KV 6S race quad with a low-drag tuck and 900 deg/s rates. Hovers low on the stick and never stops accelerating. Punishing.',
    accent: 'linear-gradient(160deg, #ff9d6b 0%, #ff4d4d 50%, #8c1f36 100%)',

    mass: 0.58,
    arm: 0.0742,
    body: [0.19, 0.05, 0.19],
    kv: 2100,
    rm: 0.06,
    i0: 1.6,
    escLimit: 60,
    tmax: 19.0,
    propDiameter: 0.1295,
    propPitch: 0.104,
    qRatio: 0.0125,
    jrot: 5.1e-6,   // fitted: 10–90 % spool ≈ 80 ms
    rotorDrag: 1.8e-5,
    cdA: [0.00367, 0.0182, 0.00367],
    auxCurrent: 0.6,
    dshotIdle: 0.055,
    vibration: 45,
    propHeight: 0.024,
    battery: { chemistry: 'lipo', cells: 6, label: '6S', mah: 1100, resistance: 0.022 },

    tune: {
      pid: {
        roll: { p: 45, i: 80, d: 30, dMax: 40, f: 120 },
        pitch: { p: 47, i: 84, d: 34, dMax: 46, f: 125 },
        yaw: { p: 45, i: 80, d: 0, dMax: 0, f: 120 },
      },
      filters: {},
      rates: actualRates(250, 900, 20),
      angleLimit: 55,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 46.7,
    sinkRate: 10.8,

    visual: {
      ducted: false,
      propRadius: 0.0635,
      bodyColor: 0x24262b,
      accentColor: 0xff5a3c,
      motorColor: 0xb9424a,
      scale: 1,
    },
    // 6S on stiff props: lower fundamental, far more upper harmonic snarl.,
    audio: { base: 78, span: 560, idle: 0.08 },
    cameraMount: [0, 0.030, -0.028],
  },
  {
    id: 'toothpick',
    displayName: '3" Toothpick',
    className: '130 mm · 95 g · 4S',
    description:
      'Featherweight 3-inch on 4S. Floaty, efficient and quiet — gaps feel bigger, wind pushes it around.',
    accent: 'linear-gradient(160deg, #d3f79b 0%, #5cb85c 55%, #2d6a4f 100%)',

    mass: 0.095,
    arm: 0.046,
    body: [0.11, 0.035, 0.11],
    kv: 5000,
    rm: 0.25,
    i0: 0.4,
    escLimit: 20,
    tmax: 2.35,
    propDiameter: 0.0762,
    propPitch: 0.046,
    qRatio: 0.0068,
    jrot: 9.0e-7,
    rotorDrag: 4.0e-6,
    cdA: [0.0242, 0.00767, 0.0242],
    auxCurrent: 0.4,
    dshotIdle: 0.055,
    vibration: 35,
    propHeight: 0.016,
    battery: { chemistry: 'lipo', cells: 4, label: '4S', mah: 650, resistance: 0.05 },

    tune: {
      pid: {
        roll: { p: 70, i: 133, d: 50, dMax: 64, f: 110 },
        pitch: { p: 75, i: 141, d: 55, dMax: 70, f: 115 },
        yaw: { p: 70, i: 133, d: 0, dMax: 0, f: 110 },
      },
      filters: {},
      rates: actualRates(150, 800, 45),
      angleLimit: 55,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 25.2,
    sinkRate: 7.4,

    visual: {
      ducted: false,
      propRadius: 0.038,
      bodyColor: 0x2a2c30,
      accentColor: 0xa3e635,
      motorColor: 0x8a8d92,
      scale: 0.7,
    },
    audio: { base: 180, span: 600, idle: 0.07 },
    cameraMount: [0, 0.028, -0.022],
  },
  {
    id: 'freestyle-hd',
    displayName: '5.5" Freestyle HD',
    className: '270 mm · 720 g · 6S',
    description:
      'Locked-in 5.5\' 6S freestyle rig with HD camera weight. Planted, smooth, carries momentum through lines.',
    accent: 'linear-gradient(160deg, #b79bff 0%, #6d4fd4 55%, #35236e 100%)',

    mass: 0.72,
    arm: 0.096,
    body: [0.22, 0.065, 0.22],
    kv: 1750,
    rm: 0.07,
    i0: 1.3,
    escLimit: 55,
    tmax: 18.5,
    propDiameter: 0.1397,
    propPitch: 0.0889,
    qRatio: 0.012,
    jrot: 7.4e-6,   // fitted: 10–90 % spool ≈ 80 ms
    rotorDrag: 2.2e-5,
    cdA: [0.0154, 0.029, 0.0154],
    auxCurrent: 0.8,
    dshotIdle: 0.055,
    vibration: 38,
    propHeight: 0.03,
    battery: { chemistry: 'lipo', cells: 6, label: '6S', mah: 1300, resistance: 0.025 },

    tune: {
      pid: {
        roll: { p: 45, i: 80, d: 30, dMax: 40, f: 120 },
        pitch: { p: 47, i: 84, d: 34, dMax: 46, f: 125 },
        yaw: { p: 45, i: 80, d: 0, dMax: 0, f: 120 },
      },
      filters: {},
      rates: actualRates(90, 650, 55),
      angleLimit: 55,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 36.4,
    sinkRate: 10.8,

    visual: {
      ducted: false,
      propRadius: 0.07,
      bodyColor: 0x23242a,
      accentColor: 0xa78bfa,
      motorColor: 0x8a8d92,
      scale: 1.05,
    },
    audio: { base: 88, span: 440, idle: 0.07 },
    cameraMount: [0, 0.038, -0.032],
  },
  {
    id: 'street-league',
    displayName: 'Street League Spec',
    className: '220 mm · 600 g · 6S',
    description:
      'Spec-class street racer. Even field, predictable grip — precision over raw punch.',
    accent: 'linear-gradient(160deg, #ffd166 0%, #ef476f 55%, #6a1b3a 100%)',

    mass: 0.6,
    arm: 0.078,
    body: [0.19, 0.055, 0.19],
    kv: 1950,
    rm: 0.07,
    i0: 1.4,
    escLimit: 55,
    tmax: 17.0,
    propDiameter: 0.1295,
    propPitch: 0.0914,
    qRatio: 0.0115,
    jrot: 5.9e-6,   // fitted: 10–90 % spool ≈ 80 ms
    rotorDrag: 1.9e-5,
    cdA: [0.034, 0.0228, 0.034],
    auxCurrent: 0.6,
    dshotIdle: 0.055,
    vibration: 40,
    propHeight: 0.026,
    battery: { chemistry: 'lipo', cells: 6, label: '6S', mah: 1100, resistance: 0.024 },

    tune: {
      pid: {
        roll: { p: 45, i: 80, d: 30, dMax: 40, f: 120 },
        pitch: { p: 47, i: 84, d: 34, dMax: 46, f: 125 },
        yaw: { p: 45, i: 80, d: 0, dMax: 0, f: 120 },
      },
      filters: {},
      rates: actualRates(150, 800, 45),
      angleLimit: 55,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 39.7,
    sinkRate: 10.8,

    visual: {
      ducted: false,
      propRadius: 0.0635,
      bodyColor: 0x26262b,
      accentColor: 0xffd166,
      motorColor: 0x8a8d92,
      scale: 1,
    },
    audio: { base: 82, span: 520, idle: 0.08 },
    cameraMount: [0, 0.031, -0.029],
  },
  {
    id: 'mega',
    displayName: '7" Beast',
    className: '320 mm · 950 g · 6S2P Li-ion',
    description:
      'Seven-inch long-range cruiser on a Li-ion pack. Huge props, slow spool — dives for days, turns like a bus.',
    accent: 'linear-gradient(160deg, #9adcff 0%, #3a86ff 55%, #1b2a6b 100%)',

    mass: 0.95,
    arm: 0.113,
    body: [0.26, 0.07, 0.26],
    kv: 1300,
    rm: 0.065,
    i0: 1.0,
    escLimit: 55,
    tmax: 21.0,
    propDiameter: 0.178,
    propPitch: 0.089,
    qRatio: 0.016,
    jrot: 2.3e-5,
    rotorDrag: 3.2e-5,
    cdA: [0.00441, 0.0293, 0.00441],
    auxCurrent: 0.8,
    dshotIdle: 0.05,
    vibration: 30,
    propHeight: 0.034,
    battery: { chemistry: 'liion', cells: 6, label: '6S2P', mah: 4000, resistance: 0.045 },

    tune: {
      pid: {
        roll: { p: 42, i: 80, d: 34, dMax: 42, f: 100 },
        pitch: { p: 44, i: 84, d: 38, dMax: 48, f: 105 },
        yaw: { p: 40, i: 80, d: 0, dMax: 0, f: 100 },
      },
      filters: { dtermLpf1Min: 60, dtermLpf1Max: 120, dtermLpf2: 120 },
      rates: actualRates(70, 500, 50),
      angleLimit: 55,
    },

    // Measured by tests/fit-aero.mjs: full-stick acro top speed, idle sink (m/s).
    topSpeed: 35.6,
    sinkRate: 10.3,

    visual: {
      ducted: false,
      propRadius: 0.089,
      bodyColor: 0x23252b,
      accentColor: 0x3a86ff,
      motorColor: 0x8a8d92,
      scale: 1.25,
    },
    audio: { base: 65, span: 340, idle: 0.07 },
    cameraMount: [0, 0.04, -0.034],
  },
];

/* ========================================================================== *
 * Derivation
 * ========================================================================== */

/**
 * Principal moments of inertia for a solid box, matching cannon-es'
 * `Box.calculateInertia` exactly:
 *
 *     I_xx = m/12 · (h² + d²)     (pitch axis)
 *     I_yy = m/12 · (w² + d²)     (yaw axis)
 *     I_zz = m/12 · (w² + h²)     (roll axis)
 */
export function boxInertia(mass, [w, h, d]) {
  const k = mass / 12;
  return {
    x: k * (h * h + d * d),
    y: k * (w * w + d * d),
    z: k * (w * w + h * h),
  };
}

/** Per-cell thresholds on the rested (open-circuit) voltage. */
const CELL_LOW = 3.5;
const CELL_CRITICAL = 3.3;
const CELL_CUTOFF = 3.0;

/**
 * Expand a raw airframe into everything the physics and UI need.
 * Pure and deterministic. Throws if the motor cannot reach Tmax on its pack.
 */
export function derive(raw) {
  const spec = { ...raw, battery: { ...raw.battery } };
  const g = 9.81;
  spec.weight = spec.mass * g;
  spec.inertia = boxInertia(spec.mass, spec.body);

  const { kvRad, Kt } = motorConstants(spec.kv);
  const V = spec.battery.cells * 3.9;
  const omegaMax = kvRad * (V - spec.rm * (spec.qRatio * spec.tmax / Kt + spec.i0));
  if (!(omegaMax > 0)) {
    throw new Error(`[DroneTypes] ${spec.id}: motor cannot reach Tmax (ωmax=${omegaMax})`);
  }
  spec.kT = spec.tmax / (omegaMax * omegaMax);
  spec.kQ = spec.qRatio * spec.kT;

  // Refine: the fixed 3.9 V/cell is only an estimate of the loaded pack. Make
  // `tmax` exactly the static thrust at full duty on a fresh pack by solving
  // the steady-state bus (the real sag of this pack's R0 at this current).
  let w = omegaMax;
  for (let k = 0; k < 40; k++) {
    w = steadyState(spec, 1, 1).omega;
    spec.kT = spec.tmax / (w * w);
    spec.kQ = spec.qRatio * spec.kT;
  }
  spec.omegaMax = w;
  spec.motorRpmMax = w * 60 / (2 * Math.PI);
  spec.maxThrustTotal = 4 * spec.tmax;
  spec.thrustToWeight = spec.maxThrustTotal / spec.weight;

  // Battery read-outs on the rested voltage, per chemistry and cell count.
  const b = spec.battery;
  const cells = b.cells;
  b.FULL = cellOcv(b.chemistry, 1) * cells;
  b.EMPTY = cellOcv(b.chemistry, 0) * cells;
  b.LOW = CELL_LOW * cells;
  b.CRITICAL = CELL_CRITICAL * cells;
  b.CUTOFF = CELL_CUTOFF * cells;
  b.CAPACITY_MAH = b.mah;

  // Hover: the duty at which four motors, fresh pack, zero airspeed, lift
  // the weight — then as FC throttle above the idle floor.
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (4 * steadyState(spec, mid, 1).thrust > spec.weight) hi = mid; else lo = mid;
  }
  spec.hoverDuty = 0.5 * (lo + hi);
  spec.hoverThrottle = clamp01((spec.hoverDuty - spec.dshotIdle) / (1 - spec.dshotIdle));

  return spec;
}

/* ========================================================================== *
 * Registry
 * ========================================================================== */

const DERIVED = new Map();
for (const raw of AIRFRAMES) DERIVED.set(raw.id, derive(raw));

export const DRONE_TYPE_IDS = AIRFRAMES.map((a) => a.id);
export const DEFAULT_DRONE_TYPE = 'freestyle';

/** Look up a derived airframe. Unknown ids fall back to the 5" rather than throw. */
export function getAirframe(id) {
  return DERIVED.get(id) || DERIVED.get(DEFAULT_DRONE_TYPE);
}

/** All airframes, for the selection UI. */
export function listAirframes() {
  return DRONE_TYPE_IDS.map((id) => DERIVED.get(id));
}

/** Short spec lines for the selection card. */
export function airframeStats(spec) {
  const r = spec.tune.rates;
  return [
    ['Class', spec.className],
    ['Thrust', `${spec.thrustToWeight.toFixed(1)}:1`],
    ['Top speed', `${Math.round(spec.topSpeed)} m/s (${Math.round(spec.topSpeed * 3.6)} km/h)`],
    ['Motor', `${spec.kv} KV · ${Math.round(spec.motorRpmMax / 1000)}k RPM`],
    ['Rates', `${r.rates[0] * 10} / ${r.rates[2] * 10} deg/s`],
    ['Hover', `${Math.round(spec.hoverThrottle * 100)}% throttle`],
    ['Pack', `${spec.battery.label} ${spec.battery.mah}mAh`],
  ];
}

function clamp01(v) {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}
