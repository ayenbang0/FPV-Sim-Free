/**
 * tests/flight-model.test.mjs
 * ---------------------------------------------------------------------------
 * Headless validation of the flight model: no DOM, no renderer, no browser —
 * just PhysicsWorld + DroneController stepped at the real 120 Hz substep.
 *
 * This exists because the numbers that decide whether the simulator is
 * *flyable* (thrust-to-weight, PID gains, mix signs) produce a perfectly clean
 * build and a perfectly rendered scene when they are wrong. The only way to
 * catch an inverted roll axis or a quad that cannot lift its own weight is to
 * fly it and measure.
 *
 * Run with:  npm test
 */
import * as CANNON from 'cannon-es';
import { PhysicsWorld, GROUP } from '../src/core/PhysicsWorld.js';
import { DroneController, HOVER_THROTTLE, MASS, MOTOR_MAX_THRUST } from '../src/core/DroneController.js';
import { settings } from '../src/core/Settings.js';

const DT = 1 / 120;

function makeSim(spawnY = 3) {
  const physics = new PhysicsWorld({ fixedTimeStep: DT });
  const ground = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    material: physics.hardMaterial,
    collisionFilterGroup: GROUP.WORLD,
    collisionFilterMask: GROUP.DRONE,
  });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  physics.addBody(ground);

  const drone = new DroneController(physics);
  drone.setSpawn({ x: 0, y: spawnY, z: 0 }, 0, 0);
  drone.respawn();
  return { physics, drone };
}

function run(drone, physics, seconds, controlsFn) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const c = controlsFn(i * DT);
    drone.update(DT, c);
    physics.step(DT);
    physics.sanitizeBody(drone.body);
    drone.afterStep();
  }
}

function finite(drone) {
  const p = drone.body.position, v = drone.body.velocity, q = drone.body.quaternion;
  return [p.x, p.y, p.z, v.x, v.y, v.z, q.x, q.y, q.z, q.w].every(Number.isFinite);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`--- constants ---`);
console.log(`mass=${MASS}kg  motorMax=${MOTOR_MAX_THRUST}N  TWR=${(4 * MOTOR_MAX_THRUST / (MASS * 9.81)).toFixed(2)}:1  hoverThrottle=${HOVER_THROTTLE.toFixed(3)}`);
console.log('');

/* ---------- 1. hover: throttle at HOVER_THROTTLE should roughly hold altitude ---------- */
{
  const { physics, drone } = makeSim();
  settings.set('flightMode', 'angle');
  drone.setArmed(true);
  const y0 = drone.body.position.y;
  run(drone, physics, 4, () => ({ throttle: HOVER_THROTTLE, pitch: 0, roll: 0, yaw: 0 }));
  const dy = drone.body.position.y - y0;
  check('hover holds altitude (±1.2 m over 4 s)', Math.abs(dy) < 1.2,
    `Δalt=${dy.toFixed(2)} m, vy=${drone.body.velocity.y.toFixed(2)} m/s`);
}

/* ---------- 2. full throttle climbs hard ---------- */
{
  const { physics, drone } = makeSim();
  drone.setArmed(true);
  const y0 = drone.body.position.y;
  run(drone, physics, 2, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
  const dy = drone.body.position.y - y0;
  check('full throttle climbs > 8 m in 2 s', dy > 8, `Δalt=${dy.toFixed(2)} m`);
}

/* ---------- 3. zero throttle falls ---------- */
{
  const { physics, drone } = makeSim();
  drone.setArmed(true);
  const y0 = drone.body.position.y;
  run(drone, physics, 0.8, () => ({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }));
  const dy = drone.body.position.y - y0;
  check('zero throttle descends', dy < -1, `Δalt=${dy.toFixed(2)} m`);
}

/* ---------- 4. ACRO roll rate tracks the commanded rate ----------
 * Flown high: a quad rolling continuously has no net lift (the thrust vector
 * sweeps through a full circle), so at low altitude this measures the crash
 * handler rather than the rate loop. */
{
  const { physics, drone } = makeSim(120);
  settings.set({ flightMode: 'acro', rates: { roll: 600, pitch: 600, yaw: 400 } });
  drone.setArmed(true);
  run(drone, physics, 1.0, () => ({ throttle: HOVER_THROTTLE, pitch: 0, roll: 1, yaw: 0 }));
  // measured roll rate in the control frame = -localAV.z
  const invQ = drone.body.quaternion.conjugate(new CANNON.Quaternion());
  const lav = invQ.vmult(drone.body.angularVelocity, new CANNON.Vec3());
  const rollRateDeg = (-lav.z) * 180 / Math.PI;
  check('acro roll reaches ~600 deg/s (within 15%)', Math.abs(rollRateDeg - 600) < 90,
    `measured=${rollRateDeg.toFixed(0)} deg/s`);
}

/* ---------- 5. ACRO yaw rate tracks ---------- */
{
  const { physics, drone } = makeSim(120);
  settings.set({ flightMode: 'acro' });
  drone.setArmed(true);
  run(drone, physics, 1.5, () => ({ throttle: HOVER_THROTTLE, pitch: 0, roll: 0, yaw: 1 }));
  const invQ = drone.body.quaternion.conjugate(new CANNON.Quaternion());
  const lav = invQ.vmult(drone.body.angularVelocity, new CANNON.Vec3());
  const yawRateDeg = (-lav.y) * 180 / Math.PI;
  check('acro yaw reaches ~400 deg/s (within 25%)', Math.abs(yawRateDeg - 400) < 100,
    `measured=${yawRateDeg.toFixed(0)} deg/s`);
}

/* ---------- 6. ANGLE mode self-levels after a disturbance ----------
 * Flown high with enough throttle to hold altitude while banked: a quad at
 * exactly hover throttle sinks the moment it tilts, and hitting the ground
 * mid-measurement would be testing the crash handler, not self-levelling. */
{
  const { physics, drone } = makeSim(60);
  settings.set({ flightMode: 'angle' });
  drone.setArmed(true);
  run(drone, physics, 0.6, () => ({ throttle: 0.45, pitch: 0, roll: 1, yaw: 0 }));
  const banked = Math.abs(drone.telemetry.rollDeg);
  run(drone, physics, 2.0, () => ({ throttle: 0.45, pitch: 0, roll: 0, yaw: 0 }));
  const levelled = Math.abs(drone.telemetry.rollDeg);
  check('angle mode self-levels', banked > 15 && levelled < 5,
    `banked=${banked.toFixed(1)}° -> levelled=${levelled.toFixed(1)}°, alt=${drone.body.position.y.toFixed(1)}`);
}

/* ---------- 7. ANGLE mode respects the tilt cap ---------- */
{
  const { physics, drone } = makeSim(60);
  settings.set({ flightMode: 'angle', maxTilt: 35 });
  drone.setArmed(true);
  run(drone, physics, 2.0, () => ({ throttle: 0.5, pitch: 0, roll: 1, yaw: 0 }));
  const roll = Math.abs(drone.telemetry.rollDeg);
  check('angle mode caps tilt near 35°', Math.abs(roll - 35) < 6,
    `roll=${roll.toFixed(1)}°, alt=${drone.body.position.y.toFixed(1)}`);
}

/* ---------- 8. pitch forward produces forward motion (-Z) ---------- */
{
  const { physics, drone } = makeSim(60);
  settings.set({ flightMode: 'angle' });
  drone.setArmed(true);
  run(drone, physics, 2.5, () => ({ throttle: 0.55, pitch: 1, roll: 0, yaw: 0 }));
  const vz = drone.body.velocity.z;
  check('pitch forward flies toward -Z', vz < -3, `vz=${vz.toFixed(2)} m/s`);
}

/* ---------- 9. roll right produces motion toward +X ---------- */
{
  const { physics, drone } = makeSim(60);
  settings.set({ flightMode: 'angle' });
  drone.setArmed(true);
  run(drone, physics, 2.5, () => ({ throttle: 0.55, pitch: 0, roll: 1, yaw: 0 }));
  const vx = drone.body.velocity.x;
  check('roll right flies toward +X', vx > 3, `vx=${vx.toFixed(2)} m/s`);
}

/* ---------- 10. yaw right increases heading ---------- */
{
  const { physics, drone } = makeSim(60);
  settings.set({ flightMode: 'acro' });
  drone.setArmed(true);
  const h0 = drone.telemetry.headingDeg;
  run(drone, physics, 0.4, () => ({ throttle: HOVER_THROTTLE, pitch: 0, roll: 0, yaw: 1 }));
  const h1 = drone.telemetry.headingDeg;
  let delta = h1 - h0; if (delta < -180) delta += 360; if (delta > 180) delta -= 360;
  check('yaw right increases heading (clockwise)', delta > 5, `Δhdg=${delta.toFixed(1)}°`);
}

/* ---------- 11. garbage input cannot produce NaN ---------- */
{
  const { physics, drone } = makeSim();
  settings.set({ flightMode: 'acro' });
  drone.setArmed(true);
  run(drone, physics, 2, () => ({ throttle: NaN, pitch: Infinity, roll: -Infinity, yaw: NaN }));
  check('NaN/Infinity input keeps state finite', finite(drone),
    `pos=(${drone.body.position.x.toFixed(2)}, ${drone.body.position.y.toFixed(2)}, ${drone.body.position.z.toFixed(2)})`);
}

/* ---------- 12. long random-stick soak stays finite and bounded ---------- */
{
  const { physics, drone } = makeSim(120);
  settings.set({ flightMode: 'acro' });
  drone.setArmed(true);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  run(drone, physics, 30, () => ({
    throttle: rnd(), pitch: rnd() * 2 - 1, roll: rnd() * 2 - 1, yaw: rnd() * 2 - 1,
  }));
  const speed = drone.body.velocity.length();
  check('30 s random-stick soak stays finite', finite(drone) && speed < 90,
    `speed=${speed.toFixed(1)} m/s, alt=${drone.body.position.y.toFixed(1)} m`);
}

/* ---------- 13. battery drains and cuts off ---------- */
{
  const { physics, drone } = makeSim();
  drone.setArmed(true);
  run(drone, physics, 60, () => ({ throttle: 0.9, pitch: 0, roll: 0, yaw: 0 }));
  check('battery drains under load', drone.batteryCharge < 0.95 && drone.batteryVoltage < 16.8,
    `charge=${(drone.batteryCharge * 100).toFixed(1)}%, V=${drone.batteryVoltage.toFixed(2)}`);
}

/* ---------- 14. disarmed means zero motors ---------- */
{
  const { physics, drone } = makeSim();
  drone.setArmed(false);
  run(drone, physics, 1, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
  check('disarmed ignores throttle', drone.motors.every((m) => m === 0) && drone.body.position.y < 3.01,
    `motors=[${drone.motors.join(',')}], y=${drone.body.position.y.toFixed(2)}`);
}

console.log('');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exitCode = 1;
}
