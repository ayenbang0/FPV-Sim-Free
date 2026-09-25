/**
 * tests/tune-check.mjs
 * ---------------------------------------------------------------------------
 * Stock-tune acceptance for every airframe (a dev tool, not part of npm test).
 *
 * For each airframe: arm, hover at 60 m in acro at 1 kHz, then step the roll
 * stick to the deflection whose Betaflight rate is +500 deg/s (and, separately,
 * −500 deg/s) and measure the true body roll rate:
 *
 *   overshoot  peak / 500 − 1                          must be < 20 %
 *   settle     last time outside ±5 % of 500 during the
 *              400 ms transient window                 must be ≤ 150 ms
 *   ringing    RMS of (rate − 500) after 400 ms        must be < 3 % of 500
 *
 * By 400 ms the quad has rolled through inverted and is falling into its own
 * wash, so the tail also carries real propwash turbulence; the RMS bound
 * covers it, the settling bound deliberately does not.
 *
 * Run: node tests/tune-check.mjs [airframeId]
 */
import * as CANNON from 'cannon-es';
import { PhysicsWorld, GROUP } from '../src/core/PhysicsWorld.js';
import { DroneController } from '../src/core/DroneController.js';
import { listAirframes, getAirframe } from '../src/core/DroneTypes.js';
import { settings } from '../src/core/Settings.js';
import { applyRates } from '../src/fc/rates.js';

const DT = 1 / 1000;
const STEP = 500;

export function stickForRate(rates, target) {
  // Bisection on the (monotonic) rate curve.
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (applyRates(rates.type, 0, mid, rates) < target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function stepResponse(id, sign = 1) {
  const spec = getAirframe(id);
  const physics = new PhysicsWorld({ fixedTimeStep: DT });
  const ground = new CANNON.Body({
    mass: 0, shape: new CANNON.Plane(), material: physics.hardMaterial,
    collisionFilterGroup: GROUP.WORLD, collisionFilterMask: GROUP.DRONE,
  });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  physics.addBody(ground);
  settings.set('flightMode', 'acro');
  const drone = new DroneController(physics, id);
  drone.applyTune();
  drone.setSpawn({ x: 0, y: 60, z: 0 }, 0, 0);
  drone.respawn();
  drone.setArmed(true);

  const thr = 0.05 + 0.95 * spec.hoverThrottle;
  const step = (c) => {
    drone.update(DT, c);
    physics.step(DT);
    physics.sanitizeBody(drone.body);
    drone.afterStep();
  };
  for (let i = 0; i < 100; i++) step({ throttle: 0, pitch: 0, roll: 0, yaw: 0 });
  drone.body.velocity.set(0, 0, 0);
  for (let i = 0; i < 500; i++) step({ throttle: thr, pitch: 0, roll: 0, yaw: 0 });

  const stick = sign * stickForRate(settings.get('fcRates'), STEP);
  const trace = [];
  for (let i = 0; i < 700; i++) {
    step({ throttle: thr, pitch: 0, roll: stick, yaw: 0 });
    trace.push(sign * drone._rates[0]);
  }
  let peak = -Infinity;
  let lastOut = 0;
  for (let i = 0; i < trace.length; i++) {
    peak = Math.max(peak, trace[i]);
    if (i < 400 && Math.abs(trace[i] - STEP) > 0.05 * STEP) lastOut = (i + 1) * DT;
  }
  let sq = 0;
  let n = 0;
  for (let i = 400; i < trace.length; i++) { sq += (trace[i] - STEP) ** 2; n++; }
  const rms = Math.sqrt(sq / n);
  return {
    overshoot: peak / STEP - 1,
    settle: lastOut,
    rms: rms / STEP,
    armed: drone.armed,
  };
}

export function tunePasses(r) {
  return r.armed && r.overshoot < 0.20 && r.settle <= 0.150 && r.rms < 0.03;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const only = process.argv[2];
  let allOk = true;
  for (const spec of listAirframes()) {
    if (only && spec.id !== only) continue;
    settings.loadAirframeProfile(spec.id);
    for (const sign of [1, -1]) {
      const r = stepResponse(spec.id, sign);
      const ok = tunePasses(r);
      allOk = allOk && ok;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${spec.id.padEnd(14)} ${sign > 0 ? '+' : '-'}500  ` +
        `overshoot ${(r.overshoot * 100).toFixed(1)}%  settle ${(r.settle * 1000).toFixed(0)} ms  ` +
        `rms ${(r.rms * 100).toFixed(2)}%`);
    }
  }
  process.exit(allOk ? 0 : 1);
}
