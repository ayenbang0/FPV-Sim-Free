/**
 * tests/fc.test.mjs
 * ---------------------------------------------------------------------------
 * Unit checks for the Betaflight port in src/fc and the receiver parsers:
 * rate curves, filter gains, mixer signs and airmode, I-term relax,
 * feedforward, and the CRSF/SBUS decoders. Pure maths — no physics world.
 *
 * Run with:  npm test
 */
import { applyRates } from '../src/fc/rates.js';
import { pt1FilterGain } from '../src/fc/filters.js';
import { Mixer, QUAD_X_MIX } from '../src/fc/mixer.js';
import { PidController } from '../src/fc/pid.js';
import { RcProcessor } from '../src/fc/rc.js';
import {
  CrsfParser, SbusParser, buildCrsfChannelsFrame, buildSbusFrame,
} from '../src/input/SerialRx.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- rates ---- */
{
  const actual = { rcRates: [7, 7, 7], rates: [67, 67, 67], rcExpo: [0, 0, 0] };
  const a1 = applyRates('actual', 0, 1, actual);
  const a05 = applyRates('actual', 0, 0.5, actual);
  check('Actual 7/67/0: 670.0 at full stick', near(a1, 670, 1e-9), `got ${a1}`);
  check('Actual 7/67/0: 185.0 at half stick', near(a05, 185, 1e-9), `got ${a05}`);

  const bf = { rcRates: [100, 100, 100], rates: [70, 70, 70], rcExpo: [0, 0, 0] };
  const b1 = applyRates('betaflight', 0, 1, bf);
  const b05 = applyRates('betaflight', 0, 0.5, bf);
  check('Betaflight 100/70/0: 666.67 at full stick', near(b1, 666.67, 0.01), `got ${b1.toFixed(3)}`);
  check('Betaflight 100/70/0: 153.85 at half stick', near(b05, 153.85, 0.01), `got ${b05.toFixed(3)}`);
}

/* ---- filters ---- */
{
  const k = pt1FilterGain(100, 0.001);
  check('pt1FilterGain(100, 0.001) = 0.3859', near(k, 0.3859, 1e-4), `got ${k.toFixed(5)}`);
}

/* ---- mixer ---- */
function mixOnce(sum, throttleUs = 1500, airmode = true) {
  const dT = 0.001;
  const rc = new RcProcessor({}, dT);
  const ch = new Float32Array(16).fill(1500);
  ch[2] = throttleUs;
  rc.cfg.rcSmoothing = false;   // raw throttle for a single-shot mix
  rc.onRxFrame(ch, 0.001);
  rc.update(false);
  const pid = new PidController({ throttleBoost: 0 }, dT);
  pid.Sum[0] = sum[0]; pid.Sum[1] = sum[1]; pid.Sum[2] = sum[2];
  const mixer = new Mixer({ throttleBoost: 0 }, dT);
  const m = mixer.mixTable({
    timeUs: 1000, rc, pid, gyro: null, gyroADCf: [0, 0, 0], armed: true,
    airmodeEnabled: airmode, crashflipActive: false, yawSpinDetected: false, cosTilt: 1,
  });
  return Array.from(m);
}
{
  const [FL, FR, RL, RR] = [0, 1, 2, 3];
  const roll = mixOnce([100, 0, 0]);
  check('sign table: +roll speeds FL, RL and slows FR, RR',
    roll[FL] > roll[FR] && roll[FL] > roll[RR] && roll[RL] > roll[FR] && roll[RL] > roll[RR],
    roll.map((v) => v.toFixed(3)).join(' '));
  const pitch = mixOnce([0, 100, 0]);
  check('sign table: +pitch (nose down) speeds RL, RR and slows FL, FR',
    pitch[RL] > pitch[FL] && pitch[RL] > pitch[FR] && pitch[RR] > pitch[FL] && pitch[RR] > pitch[FR],
    pitch.map((v) => v.toFixed(3)).join(' '));
  const yaw = mixOnce([0, 0, 100]);
  check('sign table: +yaw (nose right) speeds FR, RL (CCW) and slows FL, RR (CW)',
    yaw[FR] > yaw[FL] && yaw[FR] > yaw[RR] && yaw[RL] > yaw[FL] && yaw[RL] > yaw[RR],
    yaw.map((v) => v.toFixed(3)).join(' '));
  check('mix table rows match the sign table',
    JSON.stringify(QUAD_X_MIX.map((m) => [m.roll, m.pitch, m.yaw])) ===
      JSON.stringify([[1, -1, -1], [-1, -1, 1], [1, 1, 1], [-1, 1, -1]]));

  // Airmode at full throttle with roll/pitch saturated: the motor spread keeps
  // min(1, range) of the output range instead of clipping to nothing.
  const sat = mixOnce([500, 500, 0], 2000, true);
  const idle = 0.055;
  const spread = (Math.max(...sat) - Math.min(...sat)) / (1 - idle);
  const range = 2 * (500 + 500) / 1000;   // mix range of the demanded roll+pitch
  check('airmode keeps the motor spread at min(1, range) at full throttle',
    near(spread, Math.min(1, range), 1e-6), `spread=${spread.toFixed(4)}`);
}

/* ---- I-term relax ---- */
{
  const dT = 0.001;
  const run = (relax) => {
    const pid = new PidController({ itermRelax: relax ? 'rp' : 'off', antiGravityGain: 0 }, dT);
    pid.setStabilisationState(true);
    pid.setItermReset(false);
    const rc = {
      getSetpointRate: (a) => (a === 0 ? 500 : 0),
      getFeedforward: () => 0,
      getRcDeflection: () => 0,
      getMaxRcRate: () => 670,
    };
    for (let i = 0; i < 20; i++) {
      pid.run({ rc, gyroADCf: [0, 0, 0], attitude: { rollDeg: 0, pitchDeg: 0 }, angleMode: false, horizonMode: false, yawSpinActive: false });
    }
    return Math.abs(pid.I[0]);
  };
  const withRelax = run(true);
  const without = run(false);
  check('I-term relax: 500 deg/s step changes I by < 5 % of no-relax over 20 ms',
    withRelax < 0.05 * without, `relax=${withRelax.toFixed(3)} none=${without.toFixed(3)}`);
}

/* ---- feedforward ---- */
{
  const dT = 0.001;
  const rc = new RcProcessor({ rates: { type: 'actual', rcRates: [7, 7, 7], rates: [67, 67, 67], rcExpo: [0, 0, 0] } }, dT);
  const ch = new Float32Array(16).fill(1500);
  ch[2] = 1000;
  let t = 0;
  let maxDuring = 0;
  let peak = 0;
  let after = [];
  // settle the link first
  for (let i = 0; i < 200; i++) {
    t += dT;
    if (i % 4 === 0) rc.onRxFrame(ch, t);
    rc.update(false);
  }
  for (let i = 0; i < 400; i++) {
    t += dT;
    if (i % 4 === 0) {
      if (i < 100) ch[0] = 1500 + 4 * i;   // 100 ms ramp to 1900 µs
      rc.onRxFrame(ch, t);
    }
    rc.update(false);
    const f = rc.getFeedforward(0);
    if (i < 100) maxDuring = Math.max(maxDuring, f);
    peak = Math.max(peak, f);
    if (i >= 200) after.push(Math.abs(f));
  }
  const tail = Math.max(...after);
  check('feedforward is positive during a 250 Hz stick ramp', maxDuring > 0, `max=${maxDuring.toFixed(1)}`);
  check('feedforward decays below 5 % within 100 ms after the ramp stops',
    tail < 0.05 * peak, `peak=${peak.toFixed(1)} after=${tail.toFixed(2)}`);
}

/* ---- CRSF / SBUS ---- */
{
  const vals = new Array(16).fill(992);
  const p = new CrsfParser();
  let got = null;
  p.onChannels = (c) => { got = Array.from(c); };
  p.push(buildCrsfChannelsFrame(vals));
  check('CRSF: a [992…] channel packet decodes to 1500 µs', got && got.every((v) => v === 1500),
    got ? `ch0=${got[0]}` : 'no frame');
  const bad = buildCrsfChannelsFrame(vals);
  bad[8] ^= 0x5a;
  const before = p.errors;
  got = null;
  p.push(bad);
  check('CRSF: a corrupted CRC increments errors', p.errors === before + 1 && got === null,
    `errors=${p.errors}`);

  const s = new SbusParser();
  let frames = 0;
  s.onChannels = () => { frames++; };
  s.push(buildSbusFrame(vals, 0));
  s.push(buildSbusFrame(vals, 0x08));
  check('SBUS: failsafe bit set emits no frame', frames === 1 && s.failsafe, `frames=${frames}`);
}

console.log(`\n${pass}/${pass + fail} fc checks passed`);
if (fail) process.exit(1);
