/**
 * tests/collisions.test.mjs
 * ---------------------------------------------------------------------------
 * Map regression tests: no DOM, no renderer — build every registered map
 * headlessly and verify that what LOOKS solid IS solid, that what looks like
 * a gap really is one, and that no gate or spawn is buried in geometry.
 *
 * A missing collider is invisible in every other way: the build is clean,
 * the render is perfect, and the wall simply does not exist until a drone
 * flies through it. Clearance uses exact point-in-shape tests (mapcheck.mjs),
 * not AABBs, so rotated beams and trusses cannot produce false alarms.
 *
 * Run with:  npm test
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PhysicsWorld } from '../src/core/PhysicsWorld.js';
import { DroneController } from '../src/core/DroneController.js';
import { MAP_REGISTRY } from '../src/maps/registry.js';
import { staticBodies, blockedAt } from './mapcheck.mjs';

// Headless texture generators warn once about the missing canvas; mute it.
const warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes('[procedural]') && !String(a[0]).includes('[TerrainTextures]')) warn(...a); };

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function build(Ctor) {
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld({ fixedTimeStep: 1 / 240 });
  const map = new Ctor();
  for (const _ of map.buildSteps(scene, physics)) { /* exhaust */ }
  return { scene, physics, map };
}

/** Solid at p? Streams the colliders around p in first. */
function solidAt(map, physics, x, y, z, margin = 0) {
  const p = new THREE.Vector3(x, y, z);
  map.builder?.updateColliders?.(p);
  return blockedAt(staticBodies(physics), p, margin).length > 0;
}

const byId = Object.fromEntries(MAP_REGISTRY.map(([meta, Ctor]) => [meta.id, { meta, Ctor }]));

/* ========================================================================== *
 * A. Every map: builds, gates match the menu, spawn + gates in open air
 * ========================================================================== */

console.log('=== every map ===\n');
for (const [meta, Ctor] of MAP_REGISTRY) {
  let built;
  try {
    built = build(Ctor);
  } catch (err) {
    check(`${meta.id} builds headlessly`, false, String(err?.message || err).slice(0, 140));
    continue;
  }
  const { scene, physics, map } = built;
  check(`${meta.id} builds headlessly`, (map.builder?.colliderCount ?? 0) > 20, `${map.builder?.colliderCount} colliders`);
  check(`${meta.id} gate count matches the menu`, map.gates.length === meta.gates, `${map.gates.length} built, meta says ${meta.gates}`);

  const sp = map.spawnPoint;
  const spawnClear = !solidAt(map, physics, sp.x, sp.y, sp.z, 0.02) && !solidAt(map, physics, sp.x, sp.y + 0.3, sp.z, 0.02);
  check(`${meta.id} spawns in open air`, spawnClear, `(${sp.x.toFixed(1)}, ${sp.y.toFixed(2)}, ${sp.z.toFixed(1)})`);

  const blocked = [];
  for (const g of map.gates) {
    const pts = [g.position, g.position.clone().addScaledVector(g.normal, 1.5), g.position.clone().addScaledVector(g.normal, -1.5)];
    if (pts.some((p, i) => solidAt(map, physics, p.x, p.y, p.z, i === 0 ? 0.25 : 0.2))) blocked.push(`gate${g.index + 1}`);
  }
  check(`${meta.id} gate centres + approaches are open`, blocked.length === 0, blocked.join(' ') || `${map.gates.length} clear`);

  // Scene-graph sanity: a single NaN blanks the frame without throwing.
  let bad = 0;
  scene.traverse((o) => {
    if (!Number.isFinite(o.position.x + o.position.y + o.position.z + o.scale.x + o.scale.y + o.scale.z)) bad++;
    if (o.isInstancedMesh) {
      const a = o.instanceMatrix.array;
      for (let i = 0; i < Math.min(a.length, o.count * 16); i++) if (!Number.isFinite(a[i])) { bad++; break; }
    }
  });
  check(`${meta.id} transforms all finite`, bad === 0);

  const b = map.bounds;
  const inside = (p) => p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z;
  check(`${meta.id} spawn and gates inside bounds`, inside(sp) && map.gates.every((g) => inside(g.position)));

  // Drop a quad from 2 m above spawn: it must land, not fall through.
  const drone = new DroneController(physics, 'freestyle');
  drone.setSpawn(new THREE.Vector3(sp.x, sp.y + 2, sp.z), 0, 0);
  drone.respawn();
  for (let i = 0; i < 480; i++) {
    map.builder?.updateColliders?.(drone.body.position);
    drone.update(1 / 240, { throttle: 0, pitch: 0, roll: 0, yaw: 0 });
    physics.step(1 / 240);
    physics.sanitizeBody(drone.body);
    drone.afterStep();
  }
  const landed = drone.body.position.y > sp.y - 0.5 && Math.abs(drone.body.velocity.y) < 0.5;
  check(`${meta.id} ground catches a dropped quad`, landed, `y=${drone.body.position.y.toFixed(2)}`);
  drone.dispose();
  try { map.dispose(scene, physics); } catch (_e) { /* ignore */ }
}

/* ========================================================================== *
 * B. Signature features: solid where drawn, open where flown
 * ========================================================================== */

console.log('\n=== signature features ===\n');
{
  const { physics, map } = build(byId.house.Ctor);
  // Gap-dive door: the ground bath/laundry wall is x = 8, door centred z = -10.
  check('house gap door is open at its centre', !solidAt(map, physics, 8, 1.0, -10));
  check('house gap door is narrow (jamb 0.35 m off centre)', solidAt(map, physics, 8, 1.0, -10 + 0.35));
  check('house gap door still clears a 5" frame (±0.2 m)', !solidAt(map, physics, 8, 1.0, -10 + 0.2));
  check('house windows are solid glass', solidAt(map, physics, -18, 1.6, -10, 0.02));
  check('house gallery floor is solid', solidAt(map, physics, 0, 3.4, -1));
  check('house great-room void is open', !solidAt(map, physics, 6, 4.8, 8));
}
{
  const { physics, map } = build(byId.factory.Ctor);
  check('factory press column is solid', solidAt(map, physics, 28 + 3.6, 3, 4));
  check('factory press slot is open', !solidAt(map, physics, 28, 2.0, 4));
  check('factory press ram is solid', solidAt(map, physics, 28, 4.7, 4));
  check('factory standing roof is solid', solidAt(map, physics, 0, 24.2, -20));
  check('factory collapsed half is open sky', !solidAt(map, physics, 0, 24.2, 20));
  check('factory wagon door is open', !solidAt(map, physics, 60, 3, 8));
  check('factory chimney is solid', solidAt(map, physics, 100, 20, 28));
}
{
  const { physics, map } = build(byId.warehouse.Ctor);
  check('warehouse rack beam level is solid', solidAt(map, physics, -34 - 0.15 - 0.55, 3.4, -40));
  check('warehouse forklift aisle is open', !solidAt(map, physics, -30, 3, -40));
  check('warehouse cross-aisle is open', !solidAt(map, physics, -22, 5, -22));
  check('warehouse open dock door is open', !solidAt(map, physics, 6, 2, 62));
  check('warehouse closed dock door is solid', solidAt(map, physics, -30, 2, 61.7));
}
{
  const { physics, map } = build(byId.field.Ctor);
  const g = map.getGroundHeight(-60, 40);
  check('field barn side wall is solid', solidAt(map, physics, -67, g + 3, 40));
  check('field barn doors are open at both ends', !solidAt(map, physics, -60, g + 2.5, 28) && !solidAt(map, physics, -60, g + 2.5, 52));
  check('field barn roof is solid', solidAt(map, physics, -63.5, g + 8.8, 40, 0.05));
}
{
  const { physics, map } = build(byId.arena.Ctor);
  const g = map.gates[0];
  const barX = g.position.x + g.right.x * 1.1;
  const barZ = g.position.z + g.right.z * 1.1;
  check('arena gate frames are solid (league gates are real objects)', solidAt(map, physics, barX, g.position.y, barZ, 0.02));
  check('arena gate opening is open', !solidAt(map, physics, g.position.x, g.position.y, g.position.z));
}
{
  const { physics, map } = build(byId.bando.Ctor);
  check('bando slab is solid', solidAt(map, physics, -20, 8.25, -3));
  check('bando atrium shaft is open top to bottom', [2, 6, 10, 14, 18, 20.9].every((y) => !solidAt(map, physics, 0, y, 0)));
}

/* ========================================================================== *
 * C. Streaming: far colliders stay out of the world, near ones come in
 * ========================================================================== */

console.log('\n=== collider streaming ===\n');
{
  const { physics, map } = build(byId.alpine.Ctor);
  const sp = map.spawnPoint;
  map.builder.updateColliders(sp);
  const nearLive = physics.staticIndex.size;
  check('alpine streams only nearby colliders', nearLive > 0 && nearLive < map.builder.colliderCount,
    `${nearLive} live of ${map.builder.colliderCount} registered`);
  map.builder.updateColliders(new THREE.Vector3(sp.x, sp.y, sp.z + 1500));
  map.builder.updateColliders(sp);
  check('streaming back to spawn restores the same set', physics.staticIndex.size === nearLive);
}
{
  // Dynamic-vs-static broadphase must still collide with a plain plane.
  const physics = new PhysicsWorld({ fixedTimeStep: 1 / 240 });
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  physics.addBody(ground);
  const drone = new DroneController(physics, 'freestyle');
  drone.setSpawn(new THREE.Vector3(0, 2, 0), 0, 0);
  drone.respawn();
  for (let i = 0; i < 480; i++) {
    drone.update(1 / 240, { throttle: 0, pitch: 0, roll: 0, yaw: 0 });
    physics.step(1 / 240);
    physics.sanitizeBody(drone.body);
    drone.afterStep();
  }
  check('an infinite plane still stops the quad', drone.body.position.y > -0.1, `y=${drone.body.position.y.toFixed(2)}`);
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
