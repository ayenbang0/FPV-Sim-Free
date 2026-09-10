/**
 * tests/flight-model.test.mjs
 * ---------------------------------------------------------------------------
 * Headless validation of the flight model: no DOM, no renderer, no browser —
 * just PhysicsWorld + DroneController stepped at the real substep.
 *
 * This exists because the numbers that decide whether the simulator is
 * *flyable* (thrust-to-weight, PID gains, mix signs) produce a perfectly clean
 * build and a perfectly rendered scene when they are wrong. The only way to
 * catch an inverted roll axis, a quad that cannot lift its own weight, or a
 * rate loop that oscillates at 900 deg/s is to fly it and measure.
 *
 * Every physical check runs against **all three airframes**. Gains are derived
 * from mass and geometry (see DroneTypes.js), so a change to any airframe's
 * dimensions silently re-tunes its controller; these checks are what catch a
 * derivation that produced something unflyable.
 *
 * Run with:  npm test
 */
import * as CANNON from 'cannon-es';
import { PhysicsWorld, GROUP } from '../src/core/PhysicsWorld.js';
import { DroneController } from '../src/core/DroneController.js';
import { listAirframes, getAirframe, boxInertia } from '../src/core/DroneTypes.js';
import { settings } from '../src/core/Settings.js';

const DT = 1 / 120;

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

  const drone = new DroneController(physics, airframeId);
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
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Set the rate/tilt profile the airframe expects, as the app does on switch. */
function loadProfile(spec) {
  settings.set({ rates: { ...spec.rates }, maxTilt: spec.maxTilt });
}

/**
 * Real-world performance envelopes, in m/s. These are the numbers that make the
 * three feel like different aircraft rather than one aircraft with a multiplier,
 * and they are easy to break silently: drag is a single coefficient, and getting
 * it wrong produces a quad that builds, renders and flies — just far too fast.
 *
 * A BetaFPV Air65 does roughly 25 km/h, a 4S 5" freestyle about 100 km/h, and a
 * 6S race quad about 160 km/h.
 */
const SPEED_ENVELOPE = {
  tinywhoop: { acro: [5.5, 9], angle: [2.2, 4.5], sink: [2, 4.5] },
  freestyle: { acro: [24, 34], angle: [10, 18], sink: [7, 12] },
  racer:     { acro: [38, 50], angle: [12, 20], sink: [8, 14] },
};

/* ========================================================================== *
 * A. Derivation checks — no physics stepping, pure arithmetic
 * ========================================================================== */

console.log('=== airframe derivation ===\n');

for (const spec of listAirframes()) {
  console.log(`${spec.displayName} (${spec.className})`);
  console.log(`  TWR=${spec.thrustToWeight}:1  motorMax=${spec.motorMaxThrust.toFixed(2)}N  ` +
    `hover=${(spec.hoverThrottle * 100).toFixed(0)}% stick  top=${spec.topSpeed.toFixed(0)} m/s`);
  console.log(`  alphaMax roll=${spec.alphaMax.roll.toFixed(0)} rad/s²  ` +
    `Kp=${spec.pid.roll.p.toFixed(4)}  loop=${(spec.pid.roll.p * spec.alphaMax.roll).toFixed(1)}/s`);
}
console.log('');

{
  // The inertia formula in DroneTypes must match cannon's, or every derived
  // gain is wrong by whatever the discrepancy is. Compare against a real body.
  let worst = 0;
  for (const spec of listAirframes()) {
    const [w, h, d] = spec.body;
    const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
    const cannonI = new CANNON.Vec3();
    shape.calculateLocalInertia(spec.mass, cannonI);
    const ours = boxInertia(spec.mass, spec.body);
    for (const axis of ['x', 'y', 'z']) {
      const rel = Math.abs(ours[axis] - cannonI[axis]) / cannonI[axis];
      worst = Math.max(worst, rel);
    }
  }
  check('inertia formula matches cannon-es', worst < 1e-9,
    `worst relative error=${worst.toExponential(2)}`);
}

{
  // Kd * alphaMax is the quantity that destabilises the derivative term, so it
  // must stay constant across airframes rather than tracking Kp.
  const vals = listAirframes().map((s) => s.pid.roll.d * s.alphaMax.roll);
  const spread = Math.max(...vals) - Math.min(...vals);
  check('Kd·alphaMax constant across airframes', spread < 1e-9,
    `values=[${vals.map((v) => v.toFixed(4)).join(', ')}]`);
}

{
  // Closed-loop rate gain must equal 1/tau for each airframe.
  let ok = true;
  const detail = [];
  for (const s of listAirframes()) {
    const loop = s.pid.roll.p * s.alphaMax.roll;
    const want = 1 / s.tau;
    if (Math.abs(loop - want) / want > 1e-6) ok = false;
    detail.push(`${s.id}=${loop.toFixed(1)}`);
  }
  check('rate loop gain equals 1/tau', ok, detail.join(' '));
}

{
  // Hover must invert the thrust curve, not the linear formula. A linear
  // HOVER_THROTTLE would put the freestyle at 31% instead of 50%.
  let ok = true;
  const detail = [];
  for (const s of listAirframes()) {
    const cmd = s.motorIdle + (1 - s.motorIdle) * s.hoverThrottle;
    const thrust = 4 * s.motorMaxThrust * Math.pow(cmd, s.thrustExponent);
    const rel = Math.abs(thrust - s.weight) / s.weight;
    if (rel > 1e-6) ok = false;
    detail.push(`${s.id}=${(s.hoverThrottle * 100).toFixed(0)}%`);
  }
  check('hover throttle inverts the thrust curve', ok, detail.join(' '));
}

{
  // Declared envelopes. Cheap, and the first thing to trip if someone edits a
  // drag coefficient without thinking about what speed it implies.
  let ok = true;
  const detail = [];
  for (const s of listAirframes()) {
    const env = SPEED_ENVELOPE[s.id];
    if (!env) { ok = false; continue; }
    const inAcro = s.topSpeed >= env.acro[0] && s.topSpeed <= env.acro[1];
    const inAngle = s.angleTopSpeed >= env.angle[0] && s.angleTopSpeed <= env.angle[1];
    const inSink = s.sinkRate >= env.sink[0] && s.sinkRate <= env.sink[1];
    if (!inAcro || !inAngle || !inSink) ok = false;
    detail.push(`${s.id}=${s.topSpeed.toFixed(0)}/${s.angleTopSpeed.toFixed(0)}`);
  }
  check('top speeds sit in their real-world envelopes', ok, detail.join(' '));
}

/* ========================================================================== *
 * B. Per-airframe flight checks
 * ========================================================================== */

for (const spec of listAirframes()) {
  console.log(`\n=== ${spec.displayName} ===`);
  const id = spec.id;

  /* ---------- hover equilibrium ---------- */
  {
    const { physics, drone } = makeSim(id);
    loadProfile(spec);
    settings.set('flightMode', 'angle');
    drone.setArmed(true);
    const y0 = drone.body.position.y;
    run(drone, physics, 4, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 0, yaw: 0 }));
    const dy = drone.body.position.y - y0;
    const vy = drone.body.velocity.y;
    // Tolerance allows for pack sag: the battery model drops terminal voltage
    // as charge falls, thrust follows voltage squared, so holding a *fixed*
    // hover stick genuinely does sink slowly — real pilots trim up as they fly.
    // The residual rate matters more than the displacement; a quad that cannot
    // hover at all diverges far faster than this.
    check('hover holds altitude (±1.8 m over 4 s, drift < 0.6 m/s)',
      Math.abs(dy) < 1.8 && Math.abs(vy) < 0.6,
      `Δalt=${dy.toFixed(2)} m, vy=${vy.toFixed(2)} m/s`);
  }

  /* ---------- climb ---------- */
  {
    const { physics, drone } = makeSim(id);
    loadProfile(spec);
    drone.setArmed(true);
    const y0 = drone.body.position.y;
    run(drone, physics, 2, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
    const dy = drone.body.position.y - y0;
    // Even the 2.6:1 whoop must clear 3 m in 2 s from a standing start.
    check('full throttle climbs > 3 m in 2 s', dy > 3, `Δalt=${dy.toFixed(2)} m`);
  }

  /* ---------- descent ---------- */
  {
    const { physics, drone } = makeSim(id, 40);
    loadProfile(spec);
    drone.setArmed(true);
    const y0 = drone.body.position.y;
    run(drone, physics, 2, () => ({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }));
    const dy = drone.body.position.y - y0;
    check('zero throttle descends', dy < -1, `Δalt=${dy.toFixed(2)} m`);
  }

  /* ---------- acro rate tracking ---------- */
  {
    const { physics, drone } = makeSim(id, 60);
    loadProfile(spec);
    settings.set('flightMode', 'acro');
    drone.setArmed(true);
    run(drone, physics, 1.2, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 1, yaw: 0 }));
    const measured = -drone.body.quaternion.conjugate().vmult(drone.body.angularVelocity).z * 180 / Math.PI;
    const target = spec.rates.roll;
    const err = Math.abs(measured - target) / target;
    check(`acro roll tracks ${target} deg/s (within 15%)`, err < 0.15,
      `measured=${measured.toFixed(0)} deg/s`);
  }

  {
    const { physics, drone } = makeSim(id, 60);
    loadProfile(spec);
    settings.set('flightMode', 'acro');
    drone.setArmed(true);
    run(drone, physics, 1.5, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 0, yaw: 1 }));
    const measured = -drone.body.quaternion.conjugate().vmult(drone.body.angularVelocity).y * 180 / Math.PI;
    const target = spec.rates.yaw;
    const err = Math.abs(measured - target) / target;
    check(`acro yaw tracks ${target} deg/s (within 25%)`, err < 0.25,
      `measured=${measured.toFixed(0)} deg/s`);
  }

  /* ---------- angle mode self-levels ---------- */
  {
    const { physics, drone } = makeSim(id, 80);
    loadProfile(spec);
    settings.set('flightMode', 'angle');
    drone.setArmed(true);
    run(drone, physics, 1.5, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 1, yaw: 0 }));
    const banked = drone.telemetry.rollDeg;
    run(drone, physics, 3.0, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 0, yaw: 0 }));
    const levelled = drone.telemetry.rollDeg;
    check('angle mode self-levels', Math.abs(levelled) < 4 && Math.abs(banked) > 8,
      `banked=${banked.toFixed(1)}° -> levelled=${levelled.toFixed(1)}°`);
  }

  /* ---------- angle mode respects its tilt cap ---------- */
  {
    const { physics, drone } = makeSim(id, 80);
    loadProfile(spec);
    settings.set('flightMode', 'angle');
    drone.setArmed(true);
    run(drone, physics, 2.5, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 1, yaw: 0 }));
    const roll = Math.abs(drone.telemetry.rollDeg);
    check(`angle mode caps tilt near ${spec.maxTilt}°`, Math.abs(roll - spec.maxTilt) < 6,
      `roll=${roll.toFixed(1)}°`);
  }

  /* ---------- control axis directions ---------- */
  {
    const { physics, drone } = makeSim(id, 60);
    loadProfile(spec);
    settings.set('flightMode', 'angle');
    drone.setArmed(true);
    run(drone, physics, 2, () => ({ throttle: spec.hoverThrottle, pitch: 1, roll: 0, yaw: 0 }));
    check('pitch forward flies toward -Z', drone.body.velocity.z < -1,
      `vz=${drone.body.velocity.z.toFixed(2)} m/s`);
  }

  {
    const { physics, drone } = makeSim(id, 60);
    loadProfile(spec);
    settings.set('flightMode', 'angle');
    drone.setArmed(true);
    run(drone, physics, 2, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 1, yaw: 0 }));
    check('roll right flies toward +X', drone.body.velocity.x > 1,
      `vx=${drone.body.velocity.x.toFixed(2)} m/s`);
  }

  {
    const { physics, drone } = makeSim(id, 60);
    loadProfile(spec);
    settings.set('flightMode', 'acro');
    drone.setArmed(true);
    const h0 = drone.telemetry.headingDeg;
    run(drone, physics, 0.5, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 0, yaw: 1 }));
    let dh = drone.telemetry.headingDeg - h0;
    if (dh < -180) dh += 360;
    check('yaw right increases heading (clockwise)', dh > 20, `Δhdg=${dh.toFixed(1)}°`);
  }

  /* ---------- garbage input cannot poison state ---------- */
  {
    const { physics, drone } = makeSim(id);
    loadProfile(spec);
    drone.setArmed(true);
    run(drone, physics, 1, () => ({
      throttle: NaN, pitch: Infinity, roll: -Infinity, yaw: NaN,
    }));
    const p = drone.body.position;
    check('NaN/Infinity input keeps state finite', finite(drone),
      `pos=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
  }

  /* ---------- random-stick soak ---------- */
  {
    const { physics, drone } = makeSim(id, 120);
    loadProfile(spec);
    settings.set('flightMode', 'acro');
    drone.setArmed(true);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    run(drone, physics, 30, () => ({
      throttle: Math.abs(rnd()), pitch: rnd(), roll: rnd(), yaw: rnd(),
    }));
    check('30 s random-stick soak stays finite', finite(drone),
      `speed=${drone.telemetry.speed.toFixed(1)} m/s, alt=${drone.telemetry.altitude.toFixed(1)} m`);
  }

  /* ---------- measured terminal velocity ----------
   * The analytic `angleTopSpeed` and what the simulation actually reaches can
   * diverge once the thrust curve is non-linear and a PID is in the loop, so
   * fly it and measure rather than trusting the formula.
   */
  {
    const { physics, drone } = makeSim(id, 400);
    loadProfile(spec);
    settings.set('flightMode', 'angle');
    drone.setArmed(true);

    // Throttle that holds altitude at the tilt cap: leaning by theta costs a
    // factor of 1/cos(theta) in thrust just to stay level.
    const tilt = spec.maxTilt * Math.PI / 180;
    const needed = spec.weight / Math.cos(tilt);
    const cmd = Math.pow(needed / spec.maxThrustTotal, 1 / spec.thrustExponent);
    const stick = Math.min(1, (cmd - spec.motorIdle) / (1 - spec.motorIdle));

    run(drone, physics, 30, () => ({ throttle: stick, pitch: 1, roll: 0, yaw: 0 }));
    const v = drone.body.velocity;
    const horizontal = Math.hypot(v.x, v.z);
    const err = Math.abs(horizontal - spec.angleTopSpeed) / spec.angleTopSpeed;

    check('measured Angle-mode terminal speed matches the model (within 20%)',
      err < 0.20,
      `measured=${horizontal.toFixed(1)} m/s, predicted=${spec.angleTopSpeed.toFixed(1)} m/s`);
  }

  /* ---------- measured sink rate ---------- */
  {
    const { physics, drone } = makeSim(id, 400);
    loadProfile(spec);
    drone.setArmed(true);
    run(drone, physics, 25, () => ({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }));
    const sink = -drone.body.velocity.y;
    const err = Math.abs(sink - spec.sinkRate) / spec.sinkRate;
    check('measured sink rate matches the model (within 20%)', err < 0.20,
      `measured=${sink.toFixed(1)} m/s, predicted=${spec.sinkRate.toFixed(1)} m/s`);
  }

  /* ---------- battery drains and reads the right chemistry ---------- */
  {
    const { physics, drone } = makeSim(id, 60);
    loadProfile(spec);
    drone.setArmed(true);
    run(drone, physics, 20, () => ({ throttle: 0.85, pitch: 0, roll: 0, yaw: 0 }));
    const drained = drone.batteryCharge < 0.99;
    const inRange = drone.batteryVoltage > 0 && drone.batteryVoltage <= spec.battery.FULL;
    check(`battery drains on ${spec.battery.label}`, drained && inRange,
      `charge=${(drone.batteryCharge * 100).toFixed(1)}%, V=${drone.batteryVoltage.toFixed(2)}`);
  }
  /* ---------- motors spool with first-order lag, not instantly ---------- */
  {
    const { physics: p2, drone: d2 } = makeSim(id, 60);
    loadProfile(spec);
    settings.set('flightMode', 'acro');
    d2.setArmed(true);
    run(d2, p2, 1, () => ({ throttle: spec.hoverThrottle, pitch: 0, roll: 0, yaw: 0 }));
    const lo = d2.motorRPM[0];
    const target = lo + 0.632 * (1 - lo);
    let crossed = -1;
    const steps = Math.round(0.5 / DT);
    for (let i = 0; i < steps; i++) {
      d2.update(DT, { throttle: 1, pitch: 0, roll: 0, yaw: 0 });
      p2.step(DT);
      p2.sanitizeBody(d2.body);
      d2.afterStep();
      if (crossed < 0 && d2.motorRPM[0] >= target) crossed = (i + 1) * DT;
    }
    const tau = spec.motorTau;
    const ok = crossed > 0 && Math.abs(crossed - tau) <= Math.max(0.3 * tau, DT);
    check(`motor spool reaches 63% in motorTau+-30% (${(tau * 1000).toFixed(0)}ms)`, ok,
      `measured=${crossed < 0 ? 'never' : (crossed * 1000).toFixed(1) + 'ms'}`);
  }

  /* ---------- disarmed means disarmed ---------- */
  {
    const { physics, drone } = makeSim(id, 0.4);
    loadProfile(spec);
    drone.setArmed(false);
    run(drone, physics, 1.5, () => ({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }));
    const still = drone.motors.every((m) => m === 0);
    check('disarmed ignores throttle', still && drone.body.position.y < 0.4,
      `motors=[${drone.motors.join(',')}], y=${drone.body.position.y.toFixed(2)}`);
  }
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
    loadProfile(getAirframe(id));
    drone.setArmed(true);
    run(drone, physics, 1.5, () => ({
      throttle: getAirframe(id).hoverThrottle, pitch: 0.3, roll: 0, yaw: 0,
    }));
    if (!finite(drone) || drone.spec.id !== id) ok = false;
    seen.push(`${id}:${drone.body.mass.toFixed(3)}kg`);
  }
  check('repeated airframe switches stay valid', ok, seen.join(' '));

  // The collider must actually change with the airframe, or the whoop would
  // still be flying a 200 mm box through 65 mm gaps.
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
{
  // The House map's interior walls are 0.14 m thick and the whoop's collider is
  // only 0.075 m across, so this is the geometry most at risk of tunnelling.
  // PhysicsWorld's MAX_POSITION_DELTA is far too coarse to catch a body this
  // small, so the real defence is the substep length — which is what this
  // measures, per airframe, at its own top speed.
  for (const spec of listAirframes()) {
    const physics = new PhysicsWorld({ fixedTimeStep: DT });
    const wall = new CANNON.Body({
      mass: 0,
      // Deliberately huge in X and Y: the point of this test is the 0.14 m
      // *thickness*, and a short wall would let the slow whoop simply sink
      // below it during the run-up and score a false pass.
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

    // Fire it at the wall at the airframe's own terminal speed.
    drone.body.position.set(0, 2, 3);
    drone.body.velocity.set(0, 0, -spec.topSpeed);

    let passed = false;
    for (let i = 0; i < Math.round(1.5 / DT); i++) {
      drone.update(DT, { throttle: 0, pitch: 0, roll: 0, yaw: 0 });
      physics.step(DT);
      physics.sanitizeBody(drone.body);
      drone.afterStep();
      if (drone.body.position.z < -0.5) { passed = true; break; }
    }
    check(`${spec.displayName} stopped by a 0.14 m wall at ${spec.topSpeed.toFixed(0)} m/s`,
      !passed, `final z=${drone.body.position.z.toFixed(2)} m`);
  }
}

/* ========================================================================== *
 * D. Relative character — the three must actually feel different
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
    `${whoop.topSpeed.toFixed(0)} / ${free.topSpeed.toFixed(0)} / ${race.topSpeed.toFixed(0)} m/s`);

  // Wind acceleration = pressure · area / mass. The whoop's area is ~3x smaller
  // but its mass is ~28x smaller, so it is far more affected.
  const windAccel = (s) => (34 * s.windArea) / s.mass;
  check('wind hits the whoop hardest',
    windAccel(whoop) > 4 * windAccel(free),
    `${windAccel(whoop).toFixed(1)} vs ${windAccel(free).toFixed(2)} m/s²`);

  check('racer rotates fastest', race.rates.roll > free.rates.roll && free.rates.roll > whoop.rates.roll,
    `${whoop.rates.roll} / ${free.rates.roll} / ${race.rates.roll} deg/s`);
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
