/**
 * core/DroneTypes.js
 * ---------------------------------------------------------------------------
 * Three airframes, and the machinery that turns a physical description of one
 * into a stable controller tune.
 *
 *   tinywhoop  BetaFPV Air65 class — 65 mm, 23 g, 1S. Slow, draggy, blown
 *              around by a breeze, and completely at home inside a house.
 *   freestyle  250 mm, 650 g, 4S. The everyday 5" quad. Balanced.
 *   racer      210 mm, 580 g, 6S. 8:1 thrust, 900 deg/s rates, low drag.
 *              Enormously fast and utterly unforgiving.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GAINS ARE DERIVED RATHER THAN TYPED IN
 *
 * A rate PID is not tuned against a feeling, it is tuned against the airframe's
 * *angular acceleration authority* — how hard the motors can twist the frame.
 * Hand-typing three sets of gains means three chances to produce a quad that
 * oscillates, and the failure is invisible: it builds clean, renders clean, and
 * only shows up as a tumble when you actually fly it.
 *
 * So each airframe declares its physical properties, and `derive()` computes:
 *
 *     alphaMax = (2 · arm · thrustMax) / I          rad/s² at full mix
 *     Kp       = 1 / (tau · alphaMax)               closed-loop time constant tau
 *     Ki       = Kp / integralTime
 *     Kd       = D_AUTHORITY / alphaMax
 *
 * The `2 ·` in alphaMax is the air-mode halving: a full pitch command produces
 * motors [0, 0, 1, 1], so two motors push and two idle — not four.
 *
 * Kd deliberately does **not** scale with Kp. What destabilises the derivative
 * term is the product `Kd · alphaMax` (one saturated substep changes the
 * measured rate by alphaMax · dt, and D feeds that straight back). The whoop has
 * ~1.4x the 5"'s authority but a *lower* Kp, so scaling Kd off Kp would push it
 * the wrong way and tumble the smallest airframe. Holding `Kd · alphaMax`
 * constant is what actually keeps the loop equivalent across all three.
 *
 * ---------------------------------------------------------------------------
 * THRUST CURVE
 *
 * Propeller thrust goes as the square of RPM, and an ESC maps its command
 * roughly linearly onto RPM. Treating thrust as linear in the motor command —
 * which the first version of this simulator did — makes the bottom half of the
 * throttle range far too strong and the top half too weak.
 *
 *     thrust = thrustMax · command^k          k ≈ 1.7 - 2.0
 *
 * This is why hover does not sit at `weight / maxThrust`. Inverting the curve
 * gives the real hover command, and it lands somewhere genuinely useful: 27% of
 * stick on the racer (twitchy, all the authority is in the first third) versus
 * 56% on the whoop (docile, hover is right at mid-stick). That single
 * consequence does more to differentiate how the three feel than any other
 * number in this file.
 *
 * Motors also idle rather than stopping (`motorIdle`), like a real quad with a
 * DShot idle offset. Without it, the thrust curve's near-zero slope at zero
 * command would collapse attitude authority whenever the pilot chopped throttle.
 */

/* ========================================================================== *
 * Tuning constants shared by all airframes
 * ========================================================================== */

/**
 * Closed-loop time constant for the rate controller, per axis group.
 * Smaller = crisper. These are the only "feel" numbers here; everything else
 * follows from physics.
 */
const YAW_TAU = 0.079;             // s — yaw is always softer than roll/pitch

/** Integral time constant: Ki = Kp / INTEGRAL_TIME. */
const INTEGRAL_TIME = 0.321;       // s
const YAW_INTEGRAL_TIME = 0.600;   // s

/**
 * The invariant that keeps the D term safe across airframes.
 * Equals the 5" reference tune's Kd · alphaMax (0.00035 × 366).
 */
const D_AUTHORITY = 0.128;

/** Wind is a pressure (N/m²); each airframe multiplies by its own frontal area. */
export const WIND_PRESSURE = 34;

/* ========================================================================== *
 * Airframe definitions
 * ========================================================================== */

/**
 * @typedef {object} AirframeSpec
 * @property {string}  id
 * @property {string}  displayName
 * @property {string}  className        e.g. "65 mm · 1S"
 * @property {string}  description      one line for the selection card
 * @property {number}  mass             kg, all-up weight
 * @property {number}  arm              m, motor offset from centre on X and Z
 * @property {[number,number,number]} body  full collider dimensions (w, h, d)
 * @property {number}  thrustToWeight   static thrust ratio
 * @property {number}  thrustExponent   k in thrust = max · command^k
 * @property {number}  motorIdle        minimum armed motor command
 * @property {number}  motorTau         s, first-order ESC+motor spool lag
 * @property {number}  propDiameterM    m, prop disc diameter
 * @property {number}  propPitchM       m, prop geometric pitch
 * @property {number}  escIdleHz        Hz, audible idle wobble seed
 * @property {number}  packResistance   ohms, full-pack internal resistance
 * @property {number}  yawTorqueCoef    reaction torque as a fraction of arm·thrust
 * @property {number}  tau              rate-loop time constant (s)
 * @property {{roll:number,pitch:number,yaw:number}} rates  deg/s at full stick
 * @property {number}  dragLateral      quadratic drag coefficient, X/Z
 * @property {number}  dragVertical     quadratic drag coefficient, Y
 * @property {number}  angularDamping   cannon angular damping
 * @property {number}  windArea         m², frontal area the wind pushes on
 * @property {number}  maxTilt          deg, Angle-mode ceiling
 * @property {object}  battery          cell chemistry and endurance
 * @property {object}  visual           mesh proportions and colours
 * @property {[number,number,number]} cameraMount  FPV camera offset, m
 */

const AIRFRAMES = [
  /* ------------------------------------------------------------------ *
   * 1. Tinywhoop — BetaFPV Air65 class
   * ------------------------------------------------------------------ */
  {
    id: 'tinywhoop',
    displayName: 'Tinywhoop',
    className: '65 mm · 23 g · 1S',
    description:
      'Ducted 65 mm micro. About 7 m/s flat out, and barely 3 m/s in Angle mode — slow enough to thread a doorway and light enough to bounce off everything. The only sane choice indoors.',
    accent: 'linear-gradient(160deg, #8fd6ff 0%, #4f9fd4 55%, #2c5f80 100%)',

    mass: 0.023,
    arm: 0.023,                     // 65 mm wheelbase, motors on the diagonal
    body: [0.075, 0.028, 0.075],    // duct shroud included
    thrustToWeight: 2.4,            // measured Air65 figures sit around 2.3-2.5
    thrustExponent: 1.70,
    motorIdle: 0.06,
    motorTau: 0.035,                  // 0802 micros spool slower than 2207s
    propDiameterM: 0.031,             // 31 mm props
    propPitchM: 0.020,
    escIdleHz: 55,                    // high thin mosquito-whine wobble seed
    packResistance: 0.09,             // tired 1S sags hard under punch
    yawTorqueCoef: 0.105,
    tau: 0.028,

    rates: { roll: 500, pitch: 500, yaw: 330 },

    // Ducts are enormously draggy for their size. Coefficients are solved
    // backwards from measured behaviour rather than picked: ~7 m/s (25 km/h)
    // flat out in acro, and a ~3 m/s sink with the throttle chopped, which is
    // what makes a whoop survivable indoors. In Angle mode the 25 deg tilt cap
    // holds it to about 3 m/s — roughly walking pace, and the reason these are
    // the only thing worth flying in a living room.
    dragLateral: 0.01005,
    dragVertical: 0.02507,
    angularDamping: 0.55,
    windArea: 0.0075,
    maxTilt: 25,

    battery: {
      cells: 1, label: '1S',
      FULL: 4.35, LOW: 3.50, CRITICAL: 3.30, CUTOFF: 3.00, EMPTY: 2.90,
      HOVER_SECONDS: 240, SAG: 0.45,
      PEAK_CURRENT: 7,       // A, 0802 motors on a 300 mAh 1S
    },

    visual: {
      ducted: true,
      propRadius: 0.0155,           // 31 mm props
      bodyColor: 0x2f3a44,
      accentColor: 0x59c8ff,
      motorColor: 0x9aa3ab,
      scale: 1,
    },
    // 0802 motors on 31 mm props: a high, thin mosquito whine.
    audio: { base: 330, span: 900, idle: 0.10 },
    cameraMount: [0, 0.016, -0.012],
  },

  /* ------------------------------------------------------------------ *
   * 2. Freestyle — the everyday 5"
   * ------------------------------------------------------------------ */
  {
    id: 'freestyle',
    displayName: '5" Freestyle',
    className: '250 mm · 650 g · 4S',
    description:
      'The standard 5-inch quad. Three-to-one thrust, honest handling, and enough speed to be exciting without being frightening. Start here.',
    accent: 'linear-gradient(160deg, #7fe6b0 0%, #2fae72 55%, #1a6444 100%)',

    mass: 0.65,
    arm: 0.09,                      // 250 mm class
    body: [0.20, 0.06, 0.20],
    thrustToWeight: 3.2,
    thrustExponent: 1.85,
    motorIdle: 0.06,
    motorTau: 0.025,                  // 2207 on 5" props
    propDiameterM: 0.127,             // 5" props
    propPitchM: 0.114,
    escIdleHz: 38,
    packResistance: 0.035,            // healthy 4S
    yawTorqueCoef: 0.105,
    tau: 0.030,

    rates: { roll: 600, pitch: 600, yaw: 400 },

    // ~28 m/s (100 km/h) flat out, ~9 m/s flat sink. Typical for a 4S 5".
    dragLateral: 0.02472,
    dragVertical: 0.07872,
    angularDamping: 0.35,
    windArea: 0.022,
    maxTilt: 35,

    battery: {
      cells: 4, label: '4S',
      FULL: 16.8, LOW: 14.8, CRITICAL: 14.0, CUTOFF: 13.0, EMPTY: 12.8,
      HOVER_SECONDS: 300, SAG: 1.5,
      PEAK_CURRENT: 90,      // A, typical 4S 5" freestyle punch
    },

    visual: {
      ducted: false,
      propRadius: 0.0635,           // 5" props
      bodyColor: 0x2a2c30,
      accentColor: 0x18e08a,
      motorColor: 0x8a8d92,
      scale: 1,
    },
    // 2207 motors on 5" props: the familiar mid-range buzz.
    audio: { base: 95, span: 420, idle: 0.07 },
    cameraMount: [0, 0.035, -0.03],
  },

  /* ------------------------------------------------------------------ *
   * 3. Racer — 6S, 8:1, built for one thing
   * ------------------------------------------------------------------ */
  {
    id: 'racer',
    displayName: 'Race Quad',
    className: '210 mm · 580 g · 6S',
    description:
      'Eight-to-one thrust on 6S with 900 deg/s rates and a low-drag tuck. 160 km/h flat out and hover at under a third of the stick. Punishing.',
    accent: 'linear-gradient(160deg, #ff9d6b 0%, #ff4d4d 50%, #8c1f36 100%)',

    mass: 0.58,
    arm: 0.0742,                    // 210 mm, tighter than the freestyle
    body: [0.19, 0.05, 0.19],       // lower profile
    thrustToWeight: 8.0,
    thrustExponent: 1.95,             // stiff 5" props: thrust climbs steeply
    motorIdle: 0.07,
    motorTau: 0.018,                  // high-kV 6S spools fastest
    propDiameterM: 0.127,             // 5" race props
    propPitchM: 0.127,                // steep pitch bites harder
    escIdleHz: 42,
    packResistance: 0.022,            // low-IR 6S holds voltage under load
    yawTorqueCoef: 0.115,           // stiffer props bite harder in yaw
    tau: 0.022,                     // race tune: noticeably sharper

    rates: { roll: 900, pitch: 900, yaw: 650 },

    // Tucked and aerodynamic — a lower coefficient than the freestyle despite
    // similar size. ~44 m/s (160 km/h), which is a fast 6S race quad; the
    // 55 m/s the previous tune produced was a dedicated speed-build number.
    dragLateral: 0.02333,
    dragVertical: 0.04702,
    angularDamping: 0.22,           // holds rotation; demands active stopping
    windArea: 0.019,
    maxTilt: 45,

    battery: {
      cells: 6, label: '6S',
      FULL: 25.2, LOW: 22.2, CRITICAL: 21.0, CUTOFF: 19.8, EMPTY: 19.4,
      HOVER_SECONDS: 180, SAG: 2.4,
      PEAK_CURRENT: 120,     // A, 6S race quad on a hard punch-out
    },

    visual: {
      ducted: false,
      propRadius: 0.0635,
      bodyColor: 0x24262b,
      accentColor: 0xff5a3c,
      motorColor: 0xb9424a,
      scale: 1,
    },
    // 6S on stiff props: lower fundamental, far more upper harmonic snarl.
    audio: { base: 78, span: 560, idle: 0.08 },
    cameraMount: [0, 0.030, -0.028],
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
 *
 * These must agree with cannon's, or every derived gain is wrong by whatever
 * the discrepancy is. `tests/flight-model.test.mjs` asserts the agreement
 * against a real body's inertia tensor rather than trusting this comment.
 */
export function boxInertia(mass, [w, h, d]) {
  const k = mass / 12;
  return {
    x: k * (h * h + d * d),
    y: k * (w * w + d * d),
    z: k * (w * w + h * h),
  };
}

/**
 * Expand a raw airframe description into everything the flight model needs.
 * Pure and deterministic, so it can be unit-tested without a physics world.
 */
export function derive(raw) {
  const spec = { ...raw };

  const weight = spec.mass * 9.81;
  spec.weight = weight;

  // Static thrust available from one motor at full command.
  spec.motorMaxThrust = (weight * spec.thrustToWeight) / 4;
  spec.maxThrustTotal = spec.motorMaxThrust * 4;

  // Reference full-throttle RPM for the audio engine. Scales with specific
  // thrust (TWR) and inversely with disc size: small high-kV motors spin far
  // faster than 5" motors at the same load. Deterministic, audio-only.
  spec.motorMaxRPM = Math.round(
    12000 + 2200 * spec.thrustToWeight * (0.127 / spec.propDiameterM),
  );
  // Parasite-drag area backing translational-lift/induced-drag terms.
  // Solved from the tuned lateral coefficient so top speed is unchanged.
  spec.discArea = Math.PI * (spec.propDiameterM / 2) ** 2;
  spec.cda = (spec.dragLateral * 2) / 1.225;
  /* --- hover ---------------------------------------------------------- *
   * Invert the thrust curve. `motorHover` is the per-motor *command* that
   * balances weight; `hoverThrottle` is the stick position that produces it
   * once the idle offset is folded back in.
   */
  const thrustFraction = weight / spec.maxThrustTotal;          // 1 / TWR
  spec.motorHover = Math.pow(thrustFraction, 1 / spec.thrustExponent);
  spec.hoverThrottle = clamp01(
    (spec.motorHover - spec.motorIdle) / (1 - spec.motorIdle),
  );

  /* --- inertia and authority ------------------------------------------ */
  const I = boxInertia(spec.mass, spec.body);
  spec.inertia = I;

  // Air-mode halving: a saturated pitch command gives motors [0, 0, 1, 1].
  const pitchTorque = 2 * spec.arm * spec.motorMaxThrust;
  const rollTorque = 2 * spec.arm * spec.motorMaxThrust;
  spec.yawTorque = spec.yawTorqueCoef * 4 * spec.motorMaxThrust * spec.arm;

  spec.alphaMax = {
    pitch: pitchTorque / I.x,
    roll: rollTorque / I.z,
    yaw: spec.yawTorque / I.y,
  };

  /* --- gains ----------------------------------------------------------- */
  const gain = (alpha, tau) => 1 / (tau * alpha);

  const kpRoll = gain(spec.alphaMax.roll, spec.tau);
  const kpPitch = gain(spec.alphaMax.pitch, spec.tau);
  const kpYaw = gain(spec.alphaMax.yaw, YAW_TAU);

  spec.pid = {
    roll: {
      p: kpRoll,
      i: kpRoll / INTEGRAL_TIME,
      // Constant Kd · alphaMax — see the header note on why this is not Kp-scaled.
      d: D_AUTHORITY / spec.alphaMax.roll,
    },
    pitch: {
      p: kpPitch,
      i: kpPitch / INTEGRAL_TIME,
      d: D_AUTHORITY / spec.alphaMax.pitch,
    },
    yaw: {
      p: kpYaw,
      i: kpYaw / YAW_INTEGRAL_TIME,
      d: 0,
    },
  };

  /* --- derived read-outs for the UI ------------------------------------ */
  // Terminal speed at maximum sustainable tilt: the quad must still hold its
  // own weight, so cos(tilt) = 1/TWR and the surplus goes sideways.
  const horizontal = weight * Math.sqrt(Math.max(spec.thrustToWeight ** 2 - 1, 0));
  spec.topSpeed = Math.sqrt(horizontal / spec.dragLateral);

  // Angle mode caps the lean, so it caps the speed well below the acro figure.
  // Worth surfacing separately: it is the number a beginner actually meets, and
  // on the whoop it is the difference between 7 m/s and a walking pace.
  const angleHorizontal = weight * Math.tan(spec.maxTilt * Math.PI / 180);
  spec.angleTopSpeed = Math.sqrt(angleHorizontal / spec.dragLateral);

  // Steady-state climb rate at full throttle, where excess thrust balances the
  // prop disc's drag.
  spec.climbRate = Math.sqrt(
    Math.max(spec.maxThrustTotal - weight, 0) / spec.dragVertical,
  );
  // ...and the sink rate with the motors cut.
  spec.sinkRate = Math.sqrt(weight / spec.dragVertical);

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
  return [
    ['Class', spec.className],
    ['Thrust', `${spec.thrustToWeight.toFixed(1)}:1`],
    ['Top speed', `${Math.round(spec.topSpeed)} m/s acro · ${Math.round(spec.angleTopSpeed)} angle`],
    ['Climb', `${spec.climbRate.toFixed(1)} m/s`],
    ['Rates', `${spec.rates.roll} / ${spec.rates.yaw} deg/s`],
    ['Hover', `${Math.round(spec.hoverThrottle * 100)}% throttle`],
  ];
}

function clamp01(v) {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}
