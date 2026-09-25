/**
 * core/QuadPhysics.js
 * ---------------------------------------------------------------------------
 * The physical quad: battery, ESC/motor, propeller and airframe aerodynamics,
 * as pure maths. No three, no cannon — DroneController feeds it the rigid
 * body's state and applies what it returns.
 *
 *   const quad = new QuadPhysics(spec);
 *   const out = quad.step(dt, { duty, bodyVel, bodyRates, agl, gravityBody });
 *
 * Frames and signs. Everything here is in the body frame of the sim:
 * +X right, +Y up, −Z forward, angular velocity right-handed (rad/s).
 * Motors are 0 FL, 1 FR, 2 RL, 3 RR; FL and RR spin clockwise seen from
 * above (spin vector −Y), FR and RL counter-clockwise (+Y) — Betaflight's
 * default "props in". Rotor speed ω is signed in each prop's own sense:
 * positive is its normal direction, negative is crash-flip reverse.
 *
 * Per step:
 *   battery   OCV(soc)·cells from the chemistry table, Rpack = R0·(1+1.5(1−soc)³)
 *   bus       one closed-form solve for the bus voltage given every motor's
 *             duty and back-EMF, then per-motor currents clamped to the ESC
 *             limit (damped light: braking current flows while driving; a
 *             motor commanded exactly 0 — DShot stop — is not driven)
 *   motor     τm = Kt·(I − sign(I)·I0) beyond the no-load current
 *   prop      T0 = kT·ω², Q0 = kQ·ω² with inflow, ground effect, vortex-ring
 *             loss and turbulence, translational lift; H-force (rotor drag);
 *             windmill-brake drag when air rises through the disc well past
 *             the vortex ring (fast descent), ½ρ·A·Cd·va² with Cd = 1 — the
 *             disc then behaves like a parachute, which is what sets a flat
 *             idle sink rate (the inflow factor alone caps at 1.4 × idle
 *             thrust and would let every quad drop at body-drag terminal speed)
 *   rotor     semi-implicit ω update against motor and prop torque
 *   body      thrust and H-force at each hub, rotor reaction and gyroscopic
 *             couples, quadratic body drag
 */

export const RHO = 1.225;          // kg/m³, sea-level air
export const G = 9.81;

/** SOC grid for the open-circuit-voltage tables, fraction 0..1. */
export const SOC_GRID = [0, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00];

/** Per-cell rested voltage over SOC_GRID. */
export const OCV_TABLES = {
  lipo: [3.00, 3.30, 3.45, 3.60, 3.68, 3.73, 3.78, 3.83, 3.90, 3.98, 4.08, 4.20],
  lihv: [3.00, 3.35, 3.50, 3.65, 3.73, 3.79, 3.85, 3.92, 4.00, 4.10, 4.22, 4.35],
  liion: [2.80, 3.10, 3.25, 3.42, 3.52, 3.60, 3.68, 3.76, 3.85, 3.95, 4.05, 4.20],
};

/** Clockwise props (seen from above) spin about −Y; FL and RR (BF props-in). */
export const PROP_SPIN_Y = [-1, +1, +1, -1];

/** Per-cell OCV at a state of charge. */
export function cellOcv(chemistry, soc) {
  const table = OCV_TABLES[chemistry] || OCV_TABLES.lipo;
  const s = soc <= 0 ? 0 : soc >= 1 ? 1 : soc;
  for (let i = 1; i < SOC_GRID.length; i++) {
    if (s <= SOC_GRID[i]) {
      const a = SOC_GRID[i - 1];
      const b = SOC_GRID[i];
      const f = (s - a) / (b - a);
      return table[i - 1] + (table[i] - table[i - 1]) * f;
    }
  }
  return table[table.length - 1];
}

/** State of charge for a per-cell rested voltage (inverse of cellOcv). */
export function socForCellVoltage(chemistry, v) {
  const table = OCV_TABLES[chemistry] || OCV_TABLES.lipo;
  if (v <= table[0]) return 0;
  for (let i = 1; i < table.length; i++) {
    if (v <= table[i]) {
      const f = (v - table[i - 1]) / (table[i] - table[i - 1]);
      return SOC_GRID[i - 1] + (SOC_GRID[i] - SOC_GRID[i - 1]) * f;
    }
  }
  return 1;
}

/** Pack internal resistance at a state of charge. */
export function packResistance(R0, soc) {
  const d = 1 - (soc <= 0 ? 0 : soc >= 1 ? 1 : soc);
  return R0 * (1 + 1.5 * d * d * d);
}

/**
 * Motor constants in SI.
 * @returns {{kvRad:number, Kt:number}}
 */
export function motorConstants(kv) {
  const kvRad = kv * 2 * Math.PI / 60;   // rad/s per volt
  return { kvRad, Kt: 1 / kvRad };        // N·m per amp
}

/**
 * Steady-state operating point with all four motors at the same duty, zero
 * airspeed, out of ground effect: the ω where motor torque balances prop
 * torque, with the bus voltage solved for that load.
 * @returns {{omega:number, thrust:number, V:number, I:number, packCurrent:number}}
 */
export function steadyState(spec, duty, soc = 1) {
  const { kvRad, Kt } = motorConstants(spec.kv);
  const Rm = spec.rm;
  const I0 = spec.i0;
  const cells = spec.battery.cells;
  const ocv = cellOcv(spec.battery.chemistry, soc) * cells;
  const Rp = packResistance(spec.battery.resistance, soc);
  const kT = spec.kT;
  const kQ = spec.kQ;
  const d = Math.abs(duty);

  // f(ω) = τm(ω) − Q(ω); τm falls and Q rises with ω, so bisection is safe.
  const torqueNet = (w) => {
    const e = w / kvRad;
    const V = (ocv - Rp * (spec.auxCurrent - 4 * d * e / Rm)) / (1 + Rp * 4 * d * d / Rm);
    let I = (d * V - e) / Rm;
    I = Math.max(-spec.escLimit, Math.min(spec.escLimit, I));
    const tm = Math.abs(I) > I0 ? Kt * (I - Math.sign(I) * I0) : 0;
    return { net: tm - kQ * w * w, V, I };
  };
  let lo = 0;
  let hi = kvRad * ocv * 1.2;
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    if (torqueNet(mid).net > 0) lo = mid; else hi = mid;
  }
  const w = 0.5 * (lo + hi);
  const r = torqueNet(w);
  return { omega: w, thrust: kT * w * w, V: r.V, I: r.I, packCurrent: spec.auxCurrent + 4 * d * r.I };
}

/** Deterministic PRNG (mulberry32). */
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

const TURB_CUTOFF_HZ = 18;
const WINDMILL_CD = 1.0;

export class QuadPhysics {
  /** @param {object} spec  derived airframe (DroneTypes.derive) */
  constructor(spec) {
    this.omega = new Float64Array(4);
    this.rpm = new Float64Array(4);
    this.current = new Float64Array(4);
    this.thrust = new Float64Array(4);
    this._eta = new Float64Array(4);
    this._rand = [0, 1, 2, 3].map((i) => mulberry32(0x9e3779b1 ^ (i * 0x85ebca6b)));
    this._spare = [NaN, NaN, NaN, NaN];
    this.tmaxScale = new Float64Array([1, 1, 1, 1]);   // bent-prop damage per motor

    this.out = {
      force: new Float64Array(3),
      torque: new Float64Array(3),
      perMotorForce: [new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3)],
      rpm: this.rpm,
      packCurrent: 0,
      vbat: 0,
      cellV: 0,
      soc: 1,
      totalThrust: 0,
    };
    this.setSpec(spec);
    this.reset();
  }

  setSpec(spec) {
    this.spec = spec;
    const { kvRad, Kt } = motorConstants(spec.kv);
    this.kvRad = kvRad;
    this.Kt = Kt;
    this.kT = spec.kT;
    this.kQ = spec.kQ;
    this.R = spec.propDiameter / 2;
    this.A = Math.PI * this.R * this.R;
    this.capacityAh = spec.battery.mah / 1000;
    const a = spec.arm;
    const h = spec.propHeight;
    this.hubs = [[-a, h, -a], [+a, h, -a], [-a, h, +a], [+a, h, +a]];
  }

  /** A fresh pack, stopped props, no damage. */
  reset() {
    this.omega.fill(0);
    this.rpm.fill(0);
    this.current.fill(0);
    this.thrust.fill(0);
    this._eta.fill(0);
    this.tmaxScale.fill(1);
    this.consumedAh = 0;
    this.soc = 1;
    const b = this.spec.battery;
    this.ocv = cellOcv(b.chemistry, 1) * b.cells;
    this.vbat = this.ocv;
    this.packCurrent = 0;
    this.out.packCurrent = 0;
    this.out.vbat = this.vbat;
    this.out.cellV = this.vbat / b.cells;
    this.out.soc = 1;
  }

  /** Stop the rotors without touching the battery (respawn keeps charge off). */
  stopRotors() {
    this.omega.fill(0);
    this.rpm.fill(0);
    this._eta.fill(0);
  }

  /** Bent prop: scale one motor's thrust (and torque) coefficient. */
  setMotorDamage(index, scale) {
    if (index >= 0 && index < 4 && Number.isFinite(scale)) {
      this.tmaxScale[index] = Math.max(0.2, Math.min(1, scale));
    }
  }

  _gauss(i) {
    if (Number.isFinite(this._spare[i])) {
      const s = this._spare[i];
      this._spare[i] = NaN;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = this._rand[i]();
    const v = this._rand[i]();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare[i] = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /**
   * Advance one physics step.
   * @param {number} dt
   * @param {object} s
   * @param {ArrayLike<number>} s.duty         motor duty −1..1 (FC output)
   * @param {ArrayLike<number>} s.bodyVel      air-relative velocity, body frame, m/s
   * @param {ArrayLike<number>} s.bodyRates    angular velocity, body frame, rad/s
   * @param {number} s.agl                     height of the CG above ground, m
   * @param {ArrayLike<number>} s.gravityBody  unit gravity direction, body frame
   */
  step(dt, s) {
    const spec = this.spec;
    const bat = spec.battery;
    const out = this.out;
    const Rm = spec.rm;
    const I0 = spec.i0;
    const escLimit = spec.escLimit;
    const Jrot = spec.jrot;
    const kvRad = this.kvRad;
    const Kt = this.Kt;
    const R = this.R;
    const A = this.A;

    const vx = fin0(s.bodyVel?.[0]);
    const vy = fin0(s.bodyVel?.[1]);
    const vz = fin0(s.bodyVel?.[2]);
    const wx = fin0(s.bodyRates?.[0]);
    const wy = fin0(s.bodyRates?.[1]);
    const wz = fin0(s.bodyRates?.[2]);
    const agl = Number.isFinite(s.agl) ? s.agl : 1e3;
    const gUp = Number.isFinite(s.gravityBody?.[1]) ? s.gravityBody[1] : -1;

    // --- battery -------------------------------------------------------------
    const soc = this.soc;
    const ocv = cellOcv(bat.chemistry, soc) * bat.cells;
    const Rp = packResistance(bat.resistance, soc);
    this.ocv = ocv;

    // --- bus solve (closed form) -----------------------------------------------
    // V = (OCV − Rp·(I_aux − Σ dᵢeᵢ/Rm)) / (1 + Rp·Σ dᵢ²/Rm), signed d and e.
    let sumDE = 0;
    let sumD2 = 0;
    const duty = DUTY;
    for (let i = 0; i < 4; i++) {
      let d = Number.isFinite(s.duty?.[i]) ? s.duty[i] : 0;
      d = d < -1 ? -1 : d > 1 ? 1 : d;
      duty[i] = d;
      const e = this.omega[i] / kvRad;
      sumDE += d * e;
      sumD2 += d * d;
    }
    let V = (ocv - Rp * (spec.auxCurrent - sumDE / Rm)) / (1 + Rp * sumD2 / Rm);
    if (!Number.isFinite(V) || V < 0) V = 0;

    let clamped = false;
    let packCurrent = spec.auxCurrent;
    for (let i = 0; i < 4; i++) {
      const d = duty[i];
      let I = 0;
      if (d !== 0) {
        I = (d * V - this.omega[i] / kvRad) / Rm;
        if (I > escLimit) { I = escLimit; clamped = true; } else if (I < -escLimit) { I = -escLimit; clamped = true; }
      }
      this.current[i] = I;
      packCurrent += d * I;
    }
    // Equals the solved V unless a current was clamped, in which case this is
    // the recompute from the clamped currents (no second solve).
    let vbat = clamped ? ocv - Rp * packCurrent : V;
    if (!Number.isFinite(vbat) || vbat < 0) vbat = 0;

    // --- props, rotors, loads --------------------------------------------------
    const force = out.force;
    const torque = out.torque;
    force[0] = force[1] = force[2] = 0;
    torque[0] = torque[1] = torque[2] = 0;

    const upright = gUp < -0.5;
    const fge = upright
      ? Math.min(1.3, 1 / (1 - Math.pow(R / (4 * Math.max(agl, R / 2)), 2)))
      : 1;
    const turbK = 1 - Math.exp(-2 * Math.PI * TURB_CUTOFF_HZ * dt);
    const turbScale = Math.sqrt((2 - turbK) / turbK);   // unit-σ output

    let hy = 0;   // rotor angular momentum, body frame (along Y)
    let yawReaction = 0;
    let totalThrust = 0;

    for (let i = 0; i < 4; i++) {
      const hub = this.hubs[i];
      // Air velocity at the hub: v + Ω × r
      const ax = vx + (wy * hub[2] - wz * hub[1]);
      const ay = vy + (wz * hub[0] - wx * hub[2]);
      const az = vz + (wx * hub[1] - wy * hub[0]);

      const w = this.omega[i];
      const aw = Math.abs(w);
      const n = aw / (2 * Math.PI);
      const kTi = this.kT * this.tmaxScale[i];
      const kQi = this.kQ * this.tmaxScale[i];
      const T0 = kTi * w * w;
      const Q0 = kQi * w * w;

      // Axial inflow along the thrust direction (+Y forward-spinning, −Y reversed)
      const va = w >= 0 ? ay : -ay;
      let fin = 1;
      if (n > 1e-3) {
        fin = 1 - va / (1.25 * spec.propPitch * n);
        fin = fin < 0 ? 0 : fin > 1.4 ? 1.4 : fin;
      }
      const vh = Math.sqrt(T0 / (2 * RHO * A));

      // Vortex ring / propwash: loss and per-motor turbulence
      let wv = 0;
      if (vh > 0.5) {
        const x = -va / vh;
        const q = (x - 0.8) / 0.35;
        wv = Math.exp(-q * q);
      }
      const fvrs = 1 - 0.25 * wv;
      const white = this._gauss(i) * turbScale;
      this._eta[i] += turbK * (white - this._eta[i]);
      const eta = this._eta[i] * 0.18 * wv;

      // Translational lift from in-plane airflow
      const vEdge = Math.sqrt(ax * ax + az * az);
      const fetl = vh > 1e-6 ? 1 + 0.12 * (1 - Math.exp(-(vEdge / vh) * (vEdge / vh))) : 1;

      // Windmill-brake state: air rising through the disc beyond ~2 vh
      let Twm = 0;
      if (va < 0) {
        const xw = vh > 1e-3 ? -va / vh : 1e3;
        const u = xw <= 1.5 ? 0 : xw >= 3 ? 1 : (xw - 1.5) / 1.5;
        Twm = 0.5 * RHO * A * WINDMILL_CD * va * va * u * u * (3 - 2 * u);
      }

      let T;
      let Q;
      if (w >= 0) {
        T = T0 * fin * fge * fvrs * fetl * (1 + eta) + Twm;
        Q = Q0 * (0.6 + 0.4 * fin);
      } else {
        // Reversed rotation (crash flip): weak reverse thrust, torque sign flips
        T = -0.45 * kTi * w * w - Twm;
        Q = -Q0;
      }
      if (!Number.isFinite(T)) T = 0;
      if (!Number.isFinite(Q)) Q = 0;
      this.thrust[i] = T;
      totalThrust += T;

      // Motor torque beyond the no-load current
      const I = this.current[i];
      const tm = Math.abs(I) > I0 ? Kt * (I - Math.sign(I) * I0) : 0;

      // Rotor: J·dω/dt = τm − sign(ω)·|Q|, semi-implicit
      const f = (tm - Q) / Jrot;
      const dfdw = -(Kt * Kt / Rm * Math.abs(duty[i]) + 2 * kQi * aw) / Jrot;
      let wNew = w + dt * f / (1 - dt * dfdw);
      if (!Number.isFinite(wNew)) wNew = 0;
      const dwdt = (wNew - w) / dt;
      this.omega[i] = wNew;
      this.rpm[i] = wNew * 60 / (2 * Math.PI);

      // Loads at the hub: thrust along body +Y, H-force against in-plane air
      const pm = out.perMotorForce[i];
      const hf = -spec.rotorDrag * aw;
      pm[0] = hf * ax;
      pm[1] = T;
      pm[2] = hf * az;

      // Rotor reaction on the frame: opposite the spin, τ = Q + J·dω/dt
      const spinY = PROP_SPIN_Y[i];
      yawReaction += -spinY * (Q + Jrot * dwdt);
      hy += spinY * Jrot * wNew;
    }

    // Couples: rotor reaction about body Y, gyroscopic −Ω × h (h along Y)
    // With h = (0, hy, 0): −Ω × h = (wz·hy, 0, −wx·hy).
    torque[1] += yawReaction;
    torque[0] += wz * hy;
    torque[2] += -wx * hy;

    // Body drag at the CG: F = −½ρ·|v|·(CdA_side·vx, CdA_top·vy, CdA_front·vz)
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const q = 0.5 * RHO * speed;
    force[0] = -q * spec.cdA[0] * vx;
    force[1] = -q * spec.cdA[1] * vy;
    force[2] = -q * spec.cdA[2] * vz;

    // --- battery bookkeeping ------------------------------------------------------
    this.consumedAh += packCurrent * dt / 3600;
    if (this.consumedAh < 0) this.consumedAh = 0;
    this.soc = Math.max(0, Math.min(1, 1 - this.consumedAh / this.capacityAh));
    this.packCurrent = packCurrent;
    this.vbat = vbat;

    out.packCurrent = packCurrent;
    out.vbat = vbat;
    out.cellV = vbat / bat.cells;
    out.soc = this.soc;
    out.totalThrust = totalThrust;
    return out;
  }
}

const DUTY = new Float64Array(4);

function fin0(v) {
  return Number.isFinite(v) ? v : 0;
}
