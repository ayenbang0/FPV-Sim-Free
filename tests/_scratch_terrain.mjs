import * as CANNON from 'cannon-es';
import { PhysicsWorld } from '../src/core/PhysicsWorld.js';
import { Terrain } from '../src/world/Terrain.js';
import { ColliderStreamer } from '../src/world/ColliderStreamer.js';
import { Simplex } from '../src/world/Noise.js';
const s = new Simplex(7);
const t = new Terrain({ cell: 2, chunkCells: 16, chunks: 4, heightFn: (x,z)=> 20*s.fbm(x/40, z/40, 4) });
for (const _ of t.generate()) {}
const physics = new PhysicsWorld({ fixedTimeStep: 1/240 });
const st = new ColliderStreamer(physics, { cellSize: 32, radius: 1 });
for (const _ of t.buildColliders(st, physics.hardMaterial)) {}
st.activateAll();
let worst = 0, n = 0;
const res = new CANNON.RaycastResult();
for (let k = 0; k < 4000; k++) {
  const x = (Math.random()-0.5) * (t.size - 4), z = (Math.random()-0.5) * (t.size - 4);
  res.reset();
  physics.world.raycastClosest(new CANNON.Vec3(x, 200, z), new CANNON.Vec3(x, -200, z), { skipBackfaces: false }, res);
  if (!res.hasHit) continue;
  const e = Math.abs(res.hitPointWorld.y - t.heightAt(x, z));
  worst = Math.max(worst, e); n++;
}
console.log('terrain size', t.size, 'bodies', st.size, 'rays hit', n, 'worst |collider - heightAt| =', worst.toFixed(5), 'm');
