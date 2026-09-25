/**
 * tests/flight-model.test.mjs
 * ---------------------------------------------------------------------------
 * Headless validation of the flight model: no DOM, no renderer, no browser —
 * PhysicsWorld + DroneController (Betaflight FC port + QuadPhysics) stepped at
 * the real 1 kHz loop, flown through RC channels like a real radio.
 *
 * The numbers that decide whether the simulator is *flyable* (thrust, hover,
 * mix signs, rate tracking) produce a clean build and a perfectly rendered
 * scene when they are wrong; the only way to catch them is to fly and measure.
 * Every physical check runs against every airframe.
 *
 * Run with:  npm test
 */
import * as CANNON from 'cannon-es';
import { PhysicsWorld, GROUP } from '../src/core/PhysicsWorld.js';
import { DroneController, CRASH_IMPACT_SPEED } from '../src/core/DroneController.js';
import { listAirframes, getAirframe, boxInertia } from '../src/core/DroneTypes.js';
import { QuadPhysics } from '../src/core/QuadPhysics.js';
import { settings } from '../src/core/Settings.js';
import { maxRcRate } from '../src/fc/rates.js';

const DT = 1 / 1000;

function makeSim(airframeId, spawnY = 3) {
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

  settings.loadAirframeProfile(airframeId);
  const drone = new DroneController(physics, airframeId);
  drone.applyTune();
  drone.setSpawn({ x: 0, y: spawnY, z: 0 }, 0, 0);
  drone.respawn();
  return { physics, drone };
}

function step(drone, physics, c) {
  drone.update(DT, c);
  physics.step(DT);
  const healed = physics.sanitizeBody(drone.body);
  if (healed.impactSpeed > 0) drone.registerImpact(healed.impactSpeed);
  drone.afterStep();
}

function run(drone, physics, seconds, controlsFn) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) step(drone, physics, controlsFn(i * DT));
}

/** Stick position (0..1 → 1000..2000 µs) that gives FC throttle `t` after mincheck. */
const stickFor = (t) => 0.05 + 0.95 * t;
const NEUTRAL = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };

/**
 * Arm on the pad the way a pilot does — throttle low, link up — then put the
 * quad back at its spawn at rest, so every check starts from a clean hover.
 */
function arm(drone, physics) {
  drone.setArmed(true);
  run(drone, physics, 0.1, () => NEUTRAL);
  drone.body.position.set(drone.spawnPoint.x, drone.spawnPoint.y, drone.spawnPoint.z);
  drone.body.velocity.set(0, 0, 0);
  drone.body.angularVelocity.set(0, 0, 0);
  drone.body.quaternion.set(0, 0, 0, 1);
  physics.commitSafeState(drone.body);
  return drone.armed;
}

function finite(drone) {
  const p = drone.body.position, v = drone.body.velocity, q = drone.body.quaternion;
  return [p.x, p.y, p.z, v.x, v.y, v.z, q.x, q.y, q.z, q.w].every(Number.isFinite);
}

const bodyRollRate = (drone) => -drone.body.quaternion.conjugate().vmult(drone.body.angularVelocity).z * 180 / Math.PI;
const bodyYawRate = (drone) => -drone.body.quaternion.conjugate().vmult(drone.body.angularVelocity).y * 180 / Math.PI;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Real-world envelopes (m/s): full-stick acro top speed and idle sink. */
const SPEED_ENVELOPE = {
  tinywhoop: { acro: [6, 10], sink: [2.5, 5] },
  freestyle: { acro: [33, 44], sink: [7, 15] },
  racer: { acro: [42, 53], sink: [7, 15] },
  toothpick: { acro: [19, 28], sink: [4, 8] },
  'freestyle-hd': { acro: [30, 42], sink: [7, 15] },
  'street-league': { acro: [33, 44], sink: [7, 15] },
  mega: { acro: [30, 42], sink: [7, 14] },
};

/** 10–90 % RPM rise time bounds, ms, hover → full duty. */
const SPOOL_BOUNDS = {
  tinywhoop: [40, 200],
  freestyle: [20, 90], racer: [20, 90], 'freestyle-hd': [20, 90], 'street-league': [20, 90],
  mega: [40, 150],
};

/* ========================================================================== *
 * A. Derivation checks
 * ========================================================================== */

console.log('=== airframe derivation ===\n');
for (const spec of listAirframes()) {
  console.log(`${spec.displayName} (${spec.className})  TWR=${spec.thrustToWeight.toFixed(1)}:1  ` +
    `hover=${(spec.hoverThrottle * 100).toFixed(1)}%  rpmMax=${Math.round(spec.motorRpmMax)}  top=${spec.topSpeed} m/s`);
}
console.log('');

{
  let worst = 0;
  for (const spec of listAirframes()) {
    const [w, h, d] = spec.body;
    const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
    const cannonI = new CANNON.Vec3();
    shape.calculateLocalInertia(spec.mass, cannonI);
    const ours = boxInertia(spec.mass, spec.body);
    for (const axis of ['x', 'y', 'z']) {
      worst = Math.max(worst, Math.abs(ours[axis] - cannonI[axis]) / cannonI[axis]);
    }
  }
  check('inertia formula matches cannon-es', worst < 1e-9, `worst relative error=${worst.toExponential(2)}`);
}

{
  // Static thrust: duty 1, fresh pack, zero airspeed → Tmax per motor.
  let ok = true;
  const detail = [];
  for (const spec of listAirframes()) {
    const q = new QuadPhysics(spec);
    for (let i = 0; i < 3000; i++) {
      q.step(DT, { duty: [1, 1, 1, 1], bodyVel: [0, 0, 0], bodyRates: [0, 0, 0], agl: 100, gravityBody: [0, -1, 0] });
      q.soc = 1;
      q.consumedAh = 0;
    }
    const rel = q.thrust[0] / spec.tmax;
    if (Math.abs(rel - 1) > 0.05) ok = false;
    detail.push(`${spec.id}=${(rel * 100).toFixed(1)}%`);
  }
  check('static thrust at full duty equals Tmax (±5 %)', ok, detail.join(' '));
}

{
  let ok = true;
  const detail = [];
  for (const s of listAirframes()) {
    const env = SPEED_ENVELOPE[s.id];
    if (!env || s.topSpeed < env.acro[0] || s.topSpeed > env.acro[1]) ok = false;
    detail.push(`${s.id}=${s.topSpeed}`);
  }
  check('recorded top speeds sit in their envelopes', ok, detail.join(' '));
}

/* ========================================================================== *
 * B. Per-airframe flight checks
 * ========================================================================== */

for (const spec of listAirframes()) {
  console.log(`\n=== ${spec.displayName} ===`);
  const id = spec.id;
  const hover = stickFor(spec.hoverThrottle);

  /* ---------- hover equilibrium (Angle) ---------- */
  {
    settings.set('flightMode', 'angle');
    const { physics, drone } = makeSim(id, 20);
    const armed = arm(drone, physics);
    // Let the props spool from idle to hover before measuring the hold.
    run(drone, physics, 0.5, () => ({ throttle: hover, pitch: 0, roll: 0, yaw: 0 }));
    const y0 = drone.body.position.y;
    run(drone, physics, 4, () => ({ throttle: hover, pitch: 0, roll: 0, yaw: 0 }));
    const dy = drone.body.position.y - y0;
    const vy = drone.body.velocity.y;
    check('arms on the pad with throttle low', armed, `reason=${drone.armBlockReason}`);
    check('hover holds altitude (±1.8 m over 4 s, drift < 0.6 m/s)',
      Math.abs(dy) < 1.8 && Math.abs(vy) < 0.6, `Δalt=${dy.toFixed(2)} m, vy=${vy.toFixed(2)} m/s`);
  }

  /* ---------- climb ---------- */
  {
    const { physics, drone } = makeSim(id);
    arm(drone, physics);
    const y0 = drone.body.position.y;
    run(drone, physics, 2, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
    const dy = drone.body.position.y - y0;
    check('full throttle climbs > 3 m in 2 s', dy > 3, `Δalt=${dy.toFixed(2)} m`);
  }

  /* ---------- descent ---------- */
  {
    const { physics, drone } = makeSim(id, 40);
    arm(drone, physics);
    const y0 = drone.body.position.y;
    run(drone, physics, 2, () => NEUTRAL);
    const dy = drone.body.position.y - y0;
    check('zero throttle descends', dy < -1, `Δalt=${dy.toFixed(2)} m`);
  }

  /* ---------- acro rate tracking ---------- */
  {
    settings.set('flightMode', 'acro');
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    const target = maxRcRate(settings.get('fcRates').type, 0, settings.get('fcRates'));
    let reached = -1;
    for (let i = 0; i < 400; i++) {
      step(drone, physics, { throttle: hover, pitch: 0, roll: 1, yaw: 0 });
      if (reached < 0 && Math.abs(bodyRollRate(drone) - target) <= 0.1 * target) reached = (i + 1) * DT;
    }
    check(`acro roll reaches ${Math.round(target)} deg/s (±10 %) within 0.4 s`, reached > 0,
      reached > 0 ? `at ${(reached * 1000).toFixed(0)} ms` : `rate=${bodyRollRate(drone).toFixed(0)}`);
  }

  {
    settings.set('flightMode', 'acro');
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    const target = maxRcRate(settings.get('fcRates').type, 2, settings.get('fcRates'));
    run(drone, physics, 1.0, () => ({ throttle: hover, pitch: 0, roll: 0, yaw: 1 }));
    const measured = bodyYawRate(drone);
    check(`acro yaw tracks ${Math.round(target)} deg/s (within 25 %)`,
      Math.abs(measured - target) / target < 0.25, `measured=${measured.toFixed(0)} deg/s`);
  }

  /* ---------- angle mode ---------- */
  {
    settings.set('flightMode', 'angle');
    const { physics, drone } = makeSim(id, 80);
    arm(drone, physics);
    run(drone, physics, 1.5, () => ({ throttle: hover, pitch: 0, roll: 1, yaw: 0 }));
    const banked = drone.telemetry.rollDeg;
    run(drone, physics, 3.0, () => ({ throttle: hover, pitch: 0, roll: 0, yaw: 0 }));
    const levelled = drone.telemetry.rollDeg;
    check('angle mode self-levels', Math.abs(levelled) < 4 && Math.abs(banked) > 8,
      `banked=${banked.toFixed(1)}° -> levelled=${levelled.toFixed(1)}°`);
  }

  {
    settings.set('flightMode', 'angle');
    const { physics, drone } = makeSim(id, 80);
    arm(drone, physics);
    let maxTilt = 0;
    const limit = settings.get('fcPid').angleLimit;
    for (let i = 0; i < 2500; i++) {
      step(drone, physics, { throttle: hover, pitch: 0, roll: 1, yaw: 0 });
      if (i > 300) maxTilt = Math.max(maxTilt, Math.abs(drone.telemetry.rollDeg));
    }
    check(`angle-mode tilt ≤ angle limit ${limit}° + 5°`, maxTilt <= limit + 5 && maxTilt > limit - 15,
      `max roll=${maxTilt.toFixed(1)}°`);
  }

  /* ---------- control axis directions ---------- */
  {
    settings.set('flightMode', 'angle');
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    run(drone, physics, 2, () => ({ throttle: hover, pitch: 1, roll: 0, yaw: 0 }));
    check('pitch forward flies toward -Z', drone.body.velocity.z < -1, `vz=${drone.body.velocity.z.toFixed(2)} m/s`);
  }
  {
    settings.set('flightMode', 'angle');
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    run(drone, physics, 2, () => ({ throttle: hover, pitch: 0, roll: 1, yaw: 0 }));
    check('roll right flies toward +X', drone.body.velocity.x > 1, `vx=${drone.body.velocity.x.toFixed(2)} m/s`);
  }
  {
    settings.set('flightMode', 'acro');
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    // Unwrapped heading change: fast yaw passes 180° within the window.
    let prev = drone.telemetry.headingDeg;
    let dh = 0;
    run(drone, physics, 0.5, () => {
      const h = drone.telemetry.headingDeg;
      let d = h - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      dh += d;
      prev = h;
      return { throttle: hover, pitch: 0, roll: 0, yaw: 1 };
    });
    check('yaw right increases heading (clockwise)', dh > 20, `Δhdg=${dh.toFixed(1)}°`);
  }

  /* ---------- garbage input cannot poison state ---------- */
  {
    const { physics, drone } = makeSim(id);
    arm(drone, physics);
    run(drone, physics, 1, () => ({ throttle: NaN, pitch: Infinity, roll: -Infinity, yaw: NaN }));
    const p = drone.body.position;
    check('NaN/Infinity input keeps state finite', finite(drone),
      `pos=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
  }

  /* ---------- random-stick soak ---------- */
  {
    settings.set('flightMode', 'acro');
    const { physics, drone } = makeSim(id, 120);
    arm(drone, physics);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    let held = NEUTRAL;
    run(drone, physics, 30, (t) => {
      // new random sticks every 20 ms, like a pilot rather than white noise
      if (Math.round(t * 1000) % 20 === 0) held = { throttle: Math.abs(rnd()), pitch: rnd(), roll: rnd(), yaw: rnd() };
      return held;
    });
    check('30 s random-stick soak stays finite', finite(drone),
      `speed=${drone.telemetry.speed.toFixed(1)} m/s, alt=${drone.telemetry.altitude.toFixed(1)} m`);
  }

  /* ---------- idle sink ---------- */
  {
    const { physics, drone } = makeSim(id, 600);
    arm(drone, physics);
    run(drone, physics, 25, () => NEUTRAL);
    const sink = -drone.body.velocity.y;
    const env = SPEED_ENVELOPE[id].sink;
    check(`idle sink in ${env[0]}–${env[1]} m/s`, sink >= env[0] && sink <= env[1], `sink=${sink.toFixed(1)} m/s`);
  }

  /* ---------- battery ---------- */
  {
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    run(drone, physics, 20, () => ({ throttle: stickFor(0.85), pitch: 0, roll: 0, yaw: 0 }));
    const drained = drone.batteryCharge < 0.99;
    const inRange = drone.batteryVoltage > 0 && drone.batteryVoltage <= spec.battery.FULL;
    check(`battery drains on ${spec.battery.label}`, drained && inRange,
      `charge=${(drone.batteryCharge * 100).toFixed(1)}%, V=${drone.batteryVoltage.toFixed(2)}`);
  }

  /* ---------- motor spool (10–90 % RPM rise) ----------
   * The motor, prop and bus on their own (zero airspeed): a free-flight climb
   * would unload the props and stretch the tail with inflow, not spool. */
  if (SPOOL_BOUNDS[id]) {
    const q = new QuadPhysics(spec);
    const still = { bodyVel: [0, 0, 0], bodyRates: [0, 0, 0], agl: 100, gravityBody: [0, -1, 0] };
    const hoverDuty = [spec.hoverDuty, spec.hoverDuty, spec.hoverDuty, spec.hoverDuty];
    for (let i = 0; i < 1500; i++) q.step(DT, { ...still, duty: hoverDuty });
    const lo = q.rpm[0];
    const trace = [];
    for (let i = 0; i < 600; i++) {
      q.step(DT, { ...still, duty: [1, 1, 1, 1] });
      trace.push(q.rpm[0]);
    }
    const hi = trace[trace.length - 1];
    const t10 = trace.findIndex((r) => r >= lo + 0.1 * (hi - lo));
    const t90 = trace.findIndex((r) => r >= lo + 0.9 * (hi - lo));
    const rise = (t90 - t10) * DT * 1000;
    const [a, b] = SPOOL_BOUNDS[id];
    check(`motor spool 10–90 % in ${a}–${b} ms`, t10 >= 0 && t90 >= 0 && rise >= a && rise <= b,
      `rise=${rise.toFixed(0)} ms`);
  }

  /* ---------- disarmed means disarmed ---------- */
  {
    const { physics, drone } = makeSim(id, 0.4);
    drone.setArmed(false);
    run(drone, physics, 1.5, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
    const still = drone.motors.every((m) => m === 0);
    check('disarmed ignores throttle', still && drone.body.position.y < 0.4,
      `motors=[${drone.motors.join(',')}], y=${drone.body.position.y.toFixed(2)}`);
  }

  /* ---------- arming refused with throttle up ---------- */
  {
    const { physics, drone } = makeSim(id, 0.4);
    drone.setArmed(true);
    run(drone, physics, 0.1, () => ({ throttle: 0.6, pitch: 0, roll: 0, yaw: 0 }));
    check('arming refused with throttle up (THROTTLE)', !drone.armed && drone.armBlockReason === 'THROTTLE',
      `reason=${drone.armBlockReason}`);
  }

  /* ---------- failsafe ---------- */
  {
    const { physics, drone } = makeSim(id, 30);
    arm(drone, physics);
    run(drone, physics, 0.2, () => ({ throttle: hover, pitch: 0, roll: 0, yaw: 0 }));
    let disarmedAt = -1;
    for (let i = 0; i < 600; i++) {
      step(drone, physics, { rxFrames: [] });   // the link goes silent
      if (disarmedAt < 0 && !drone.armed) disarmedAt = (i + 1) * DT;
    }
    check('failsafe disarms within 0.35 s of the last frame', disarmedAt > 0 && disarmedAt <= 0.35 &&
      drone.armBlockReason === 'RXLOSS', `at ${(disarmedAt * 1000).toFixed(0)} ms, reason=${drone.armBlockReason}`);
  }

  /* ---------- every respawn is a fresh pack ---------- */
  {
    const { physics, drone } = makeSim(id);
    arm(drone, physics);
    run(drone, physics, 20, () => ({ throttle: stickFor(0.85), pitch: 0, roll: 0, yaw: 0 }));
    const usedBefore = drone.consumedMah;
    drone.respawn();
    const fresh =
      drone.batteryCharge === 1 &&
      drone.consumedMah === 0 &&
      drone.flightTime === 0 &&
      Math.abs(drone.batteryVoltage - spec.battery.FULL) < 1e-9 &&
      drone.getBatteryStage() === 'ok';
    check('respawn delivers a fresh pack', fresh && usedBefore > 0,
      `used=${usedBefore.toFixed(1)} mAh before, charge=${(drone.batteryCharge * 100).toFixed(0)}% after`);
  }

  /* ---------- mAh counter ---------- */
  {
    const { physics, drone } = makeSim(id, 60);
    arm(drone, physics);
    run(drone, physics, 10, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
    const cap = spec.battery.CAPACITY_MAH;
    check('mAh counter tracks real draw', drone.consumedMah > 0 && drone.consumedMah < cap * 2,
      `used=${drone.consumedMah.toFixed(1)} mAh of ${cap}`);
  }

  /* ---------- crash flip ---------- */
  {
    const { physics, drone } = makeSim(id, spec.body[1] / 2 + 0.01);
    // Upside down on the ground plane.
    drone.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI);
    physics.commitSafeState(drone.body);
    run(drone, physics, 0.3, () => NEUTRAL);
    drone.requestTurtle();   // FLIPOVERAFTERCRASH on + arm request
    let upright = -1;
    for (let i = 0; i < 3000; i++) {
      step(drone, physics, { throttle: 0, pitch: 0, roll: 1, yaw: 0 });
      drone._readOrientation();
      if (upright < 0 && drone._up.y > 0.7) upright = (i + 1) * DT;
      if (drone.turtleTimer > 0 && drone.turtleTimer < 0.1) drone.turtleTimer = 1.5;   // hold the switch
    }
    check('crash flip rights an inverted quad within 3 s', upright > 0,
      upright > 0 ? `upright at ${upright.toFixed(2)} s` : `up.y=${drone._up.y.toFixed(2)}`);
  }
}

/* ========================================================================== *
 * B2. Measured top speed (40 s, full throttle, level) — envelope check
 * ========================================================================== */

console.log('\n=== measured top speed ===');
for (const spec of listAirframes()) {
  settings.loadAirframeProfile(spec.id);
  settings.set({ flightMode: 'angle', fcPid: { ...settings.get('fcPid'), angleLimit: 85 } });
  const { physics, drone } = (() => {
    const physics = new PhysicsWorld({ fixedTimeStep: DT });
    const drone = new DroneController(physics, spec.id);
    drone.applyTune();
    drone.setSpawn({ x: 0, y: 2000, z: 0 }, 0, 0);
    drone.respawn();
    return { physics, drone };
  })();
  arm(drone, physics);
  let theta = 45;
  for (let i = 0; i < 40000; i++) {
    theta = Math.min(84, Math.max(5, theta + DT * 8 * drone.body.velocity.y));
    step(drone, physics, { throttle: 1, pitch: theta / 85, roll: 0, yaw: 0 });
    drone.quad.soc = 1;
    drone.quad.consumedAh = 0;
  }
  const v = Math.hypot(drone.body.velocity.x, drone.body.velocity.z);
  const env = SPEED_ENVELOPE[spec.id].acro;
  check(`${spec.displayName} top speed in ${env[0]}–${env[1]} m/s`, v >= env[0] && v <= env[1], `${v.toFixed(1)} m/s`);
}

/* ========================================================================== *
 * C. Airframe switching
 * ========================================================================== */

console.log('\n=== airframe switching ===');
{
  const { physics, drone } = makeSim('freestyle');
  let ok = true;
  const seen = [];
  for (const id of ['tinywhoop', 'racer', 'freestyle', 'tinywhoop']) {
    drone.setAirframe(id);
    drone.setSpawn({ x: 0, y: 3, z: 0 }, 0, 0);
    drone.respawn();
    settings.loadAirframeProfile(id);
    drone.applyTune();
    arm(drone, physics);
    run(drone, physics, 1.5, () => ({
      throttle: stickFor(getAirframe(id).hoverThrottle), pitch: 0.3, roll: 0, yaw: 0,
    }));
    if (!finite(drone) || drone.spec.id !== id) ok = false;
    seen.push(`${id}:${drone.body.mass.toFixed(3)}kg`);
  }
  check('repeated airframe switches stay valid', ok, seen.join(' '));

  drone.setAirframe('tinywhoop');
  const he = drone.body.shapes[0].halfExtents;
  const want = getAirframe('tinywhoop').body;
  const matches = Math.abs(he.x * 2 - want[0]) < 1e-9 && Math.abs(he.y * 2 - want[1]) < 1e-9;
  check('collider resizes with the airframe', matches,
    `half extents=(${he.x.toFixed(4)}, ${he.y.toFixed(4)}, ${he.z.toFixed(4)})`);
}

/* ========================================================================== *
 * C2. Tunnelling — a small, fast body must not pass through a thin wall
 * ========================================================================== */

console.log('\n=== wall containment ===');
for (const spec of listAirframes()) {
  const physics = new PhysicsWorld({ fixedTimeStep: DT });
  const wall = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(20, 20, 0.07)),   // 0.14 m thick
    material: physics.hardMaterial,
    collisionFilterGroup: GROUP.WORLD,
    collisionFilterMask: GROUP.DRONE,
  });
  wall.position.set(0, 2, 0);
  physics.addBody(wall);

  const drone = new DroneController(physics, spec.id);
  drone.setSpawn({ x: 0, y: 2, z: 3 }, 0, 0);
  drone.respawn();
  drone.body.position.set(0, 2, 3);
  drone.body.velocity.set(0, 0, -spec.topSpeed);

  let passed = false;
  let sawCrash = false;
  let maxImpact = 0;
  for (let i = 0; i < Math.round(1.5 / DT); i++) {
    drone.update(DT, NEUTRAL);
    physics.step(DT);
    const healed = physics.sanitizeBody(drone.body);
    if (healed.impactSpeed > 0) {
      maxImpact = Math.max(maxImpact, healed.impactSpeed);
      drone.registerImpact(healed.impactSpeed);
    }
    drone.afterStep();
    if (drone.crashed) sawCrash = true;
    if (drone.body.position.z < -0.5) { passed = true; break; }
  }
  check(`${spec.displayName} stopped by a 0.14 m wall at ${spec.topSpeed.toFixed(0)} m/s`,
    !passed, `final z=${drone.body.position.z.toFixed(2)} m`);
  check(`${spec.displayName} wall impacts classify consistently`,
    sawCrash || maxImpact < CRASH_IMPACT_SPEED,
    `maxImpact=${maxImpact.toFixed(1)} m/s${sawCrash ? ', crashed' : ''}`);
}

/* ========================================================================== *
 * C2b. High-speed impact classification (sweep-guard path)
 * ========================================================================== */

console.log('\n=== sweep impact classification ===');
{
  const physics = new PhysicsWorld({ fixedTimeStep: DT });
  const wall = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(20, 20, 0.05)),   // 0.1 m thin
    material: physics.hardMaterial,
    collisionFilterGroup: GROUP.WORLD,
    collisionFilterMask: GROUP.DRONE,
  });
  wall.position.set(0, 2, 0);
  physics.addBody(wall);

  const drone = new DroneController(physics, 'racer');
  drone.setSpawn({ x: 0, y: 2, z: 0.6 }, 0, 0);
  drone.respawn();
  drone.body.position.set(0, 2, 0.6);
  drone.body.velocity.set(0, 0, -44);
  physics.commitSafeState(drone.body);

  drone.body.position.set(0, 2, -0.5);
  const healed = physics.sanitizeBody(drone.body);
  check('sweep guard catches a clean tunnel', healed.impactSpeed > 30,
    `impactSpeed=${healed.impactSpeed.toFixed(1)} m/s`);
  check('tunnelled body parked at the surface',
    drone.body.position.z > -0.05 && drone.body.position.z < 0.35,
    `z=${drone.body.position.z.toFixed(3)} m`);

  drone.registerImpact(healed.impactSpeed);
  check('caught tunnel impact destroys', drone.crashed && !drone.armed,
    drone.crashed ? 'disarmed via sweep impact' : 'no crash seen');
}

/* ========================================================================== *
 * D. Relative character — the airframes must actually feel different
 * ========================================================================== */

console.log('\n=== relative character ===');
{
  const whoop = getAirframe('tinywhoop');
  const free = getAirframe('freestyle');
  const race = getAirframe('racer');

  check('racer hovers lowest on the stick',
    race.hoverThrottle < free.hoverThrottle && free.hoverThrottle < whoop.hoverThrottle,
    `${(whoop.hoverThrottle * 100).toFixed(0)}% / ${(free.hoverThrottle * 100).toFixed(0)}% / ${(race.hoverThrottle * 100).toFixed(0)}%`);

  check('top speed ordering whoop < freestyle < racer',
    whoop.topSpeed < free.topSpeed && free.topSpeed < race.topSpeed,
    `${whoop.topSpeed} / ${free.topSpeed} / ${race.topSpeed} m/s`);

  // Wind acceleration ∝ drag area / mass: the whoop is far more affected.
  const windAccel = (s) => s.cdA[0] / s.mass;
  check('wind hits the whoop hardest', windAccel(whoop) > 4 * windAccel(free),
    `${windAccel(whoop).toFixed(3)} vs ${windAccel(free).toFixed(3)}`);

  const maxRoll = (s) => s.tune.rates.rates[0] * 10;
  check('racer rotates fastest', maxRoll(race) > maxRoll(free) && maxRoll(free) > maxRoll(whoop),
    `${maxRoll(whoop)} / ${maxRoll(free)} / ${maxRoll(race)} deg/s`);
}

/* ========================================================================== *
 * Summary
 * ========================================================================== */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}
