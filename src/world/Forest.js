/**
 * world/Forest.js
 * ---------------------------------------------------------------------------
 * Tens of thousands of trees for a handful of draw calls.
 *
 * Every species has two geometries — a detailed near mesh (layered cones or
 * clustered leaf masses, trunk, per-vertex tone variation) and a cheap far
 * mesh — each drawn as one InstancedMesh. Which trees go in which batch is
 * decided on the CPU from the camera position, but only when the camera has
 * moved far enough for it to matter: the bucketing pass copies precomputed
 * 16-float matrices into the batches (a memcpy per tree, no matrix maths), so
 * a 30 000-tree valley re-buckets in a millisecond or two, a couple of times a
 * second at racing speed.
 *
 * Near trees cast shadows; far ones do not (the sun's shadow frustum is only
 * ~100 m across anyway). Beyond the draw distance, trees are skipped outright
 * and the fog carries the horizon.
 *
 * Colliders are lazy (see ColliderStreamer.addLazy): a trunk box and one or
 * two soft canopy spheres per tree, built only while the drone is nearby.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP } from '../core/PhysicsWorld.js';
import { makeRng } from '../assets/procedural.js';
import { activeQuality } from '../render/Quality.js';

/* ========================================================================== *
 * Species geometry
 * ========================================================================== */

/** Colour a geometry's vertices with a tone that varies by height and noise. */
function paint(geo, base, rng, { dark = 0.62, jitter = 0.14, yMin = 0, yMax = 1 } = {}) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color(base);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - yMin) / Math.max(1e-3, yMax - yMin);
    const k = (dark + (1 - dark) * Math.min(1, Math.max(0, t))) * (1 - jitter / 2 + rng() * jitter);
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Jitter a geometry's vertices radially — breaks the machine-made silhouette. */
function jitter(geo, rng, amount) {
  const pos = geo.attributes.position;
  // Shared vertices must move together or the surface tears: key by position.
  const moved = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let d = moved.get(key);
    if (!d) {
      d = [(rng() - 0.5) * amount, (rng() - 0.5) * amount * 0.6, (rng() - 0.5) * amount];
      moved.set(key, d);
    }
    pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) + d[1], pos.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

function strip(geo) {
  // mergeGeometries needs identical attribute sets.
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color' && name !== 'uv') g.deleteAttribute(name);
  }
  return g;
}

/**
 * Unit-height conifer (spruce/fir): trunk plus stacked, drooping cone tiers.
 * Returns { trunk, leaves } geometries, each 1 m tall overall.
 */
export function coniferGeometry(seed = 1, lod = 0) {
  const rng = makeRng(seed);
  const segs = lod === 0 ? 9 : 5;
  const trunk = new THREE.CylinderGeometry(0.012, 0.03, lod === 0 ? 0.32 : 0.2, lod === 0 ? 6 : 4);
  trunk.translate(0, lod === 0 ? 0.16 : 0.1, 0);
  paint(trunk, 0x5a4330, rng, { dark: 0.7, yMax: 0.3 });

  const tiers = lod === 0 ? 5 : 2;
  const parts = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = 0.26 * (1 - t * 0.78) + 0.02;
    const h = lod === 0 ? 0.34 - t * 0.12 : 0.62 - t * 0.2;
    const y0 = 0.12 + t * (lod === 0 ? 0.7 : 0.55);
    const cone = new THREE.ConeGeometry(r, h, segs, 1, true);
    cone.translate(0, y0 + h / 2, 0);
    if (lod === 0) jitter(cone, rng, 0.03);
    paint(cone, 0x2f5a2c, rng, { dark: 0.45, jitter: 0.25, yMin: y0, yMax: y0 + h });
    parts.push(strip(cone));
  }
  const leaves = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const tr = strip(trunk);
  if (tr !== trunk) trunk.dispose();
  leaves.computeVertexNormals();
  return { trunk: tr, leaves };
}

/**
 * Unit-height broadleaf (oak/plane/birch-ish): trunk with a crown of
 * clustered lumpy leaf masses.
 */
export function broadleafGeometry(seed = 2, lod = 0) {
  const rng = makeRng(seed);
  const trunk = new THREE.CylinderGeometry(0.018, 0.034, 0.5, lod === 0 ? 6 : 4);
  trunk.translate(0, 0.25, 0);
  paint(trunk, 0x5b4a3a, rng, { dark: 0.7, yMax: 0.5 });

  const parts = [];
  const blobs = lod === 0 ? 6 : 1;
  for (let i = 0; i < blobs; i++) {
    const r = lod === 0 ? 0.13 + rng() * 0.08 : 0.3;
    const g = new THREE.IcosahedronGeometry(r, lod === 0 ? 1 : 0);
    const a = (i / blobs) * Math.PI * 2 + rng();
    const rr = lod === 0 ? (i === 0 ? 0 : 0.12 + rng() * 0.06) : 0;
    const y = lod === 0 ? (i === 0 ? 0.74 : 0.56 + rng() * 0.26) : 0.66;
    g.translate(Math.cos(a) * rr, y, Math.sin(a) * rr);
    if (lod === 0) jitter(g, rng, 0.05);
    g.scale(1, 0.86, 1);
    paint(g, 0x3f6a2e, rng, { dark: 0.5, jitter: 0.3, yMin: 0.4, yMax: 0.95 });
    parts.push(strip(g));
  }
  const leaves = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const tr = strip(trunk);
  if (tr !== trunk) trunk.dispose();
  leaves.computeVertexNormals();
  return { trunk: tr, leaves };
}

/* ========================================================================== *
 * Forest
 * ========================================================================== */

export class Forest {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root       parent for the batches
   * @param {THREE.Texture} [o.leafTexture]
   * @param {THREE.Texture} [o.barkTexture]
   */
  constructor({ root, leafTexture = null, barkTexture = null }) {
    this.root = root;
    const q = activeQuality;
    this.lod0 = q.treeLod0 || 110;
    this.lod1 = q.treeLod1 || 380;
    this.drawDistance = q.treeDrawDistance || 1700;

    this.leafMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, map: leafTexture || null, roughness: 0.92, metalness: 0,
    });
    this.trunkMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, map: barkTexture || null, roughness: 0.95,
    });
    this.species = [];
    this._last = null;
  }

  /** Register a species: its near/far geometries. Returns its index. */
  addSpecies({ near, far, collide = 'conifer' }) {
    this.species.push({
      near, far, collide,
      trees: [],          // { x, y, z, h, w, rot }
      matrices: null,     // Float32Array, 16 per tree
      batches: null,
    });
    return this.species.length - 1;
  }

  /**
   * Plant one tree at its base. `height` is metres; `width` is the horizontal
   * scale of the unit geometry (crown radius ≈ 0.25 × width for both species).
   */
  plant(speciesIndex, x, y, z, height, width, rot = 0) {
    const s = this.species[speciesIndex];
    if (!s || ![x, y, z, height, width].every(Number.isFinite)) return;
    s.trees.push({ x, y, z, h: height, w: width, rot });
  }

  get count() {
    let n = 0;
    for (const s of this.species) n += s.trees.length;
    return n;
  }

  /**
   * Build the batches and register lazy colliders with `streamer`.
   * `surfaces` supplies the cannon materials for trunks and canopies.
   */
  build(streamer, surfaces) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (const s of this.species) {
      const n = s.trees.length;
      s.matrices = new Float32Array(n * 16);
      for (let i = 0; i < n; i++) {
        const t = s.trees[i];
        q.setFromAxisAngle(UP, t.rot);
        m.compose(p.set(t.x, t.y - 0.1 * t.h * 0.05, t.z), q, sc.set(t.w, t.h, t.w));
        m.toArray(s.matrices, i * 16);
      }
      const mk = (geo, mat, cast) => {
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.root.add(mesh);
        return mesh;
      };
      s.batches = {
        nearTrunk: mk(s.near.trunk, this.trunkMat, true),
        nearLeaves: mk(s.near.leaves, this.leafMat, true),
        farTrunk: mk(s.far.trunk, this.trunkMat, false),
        farLeaves: mk(s.far.leaves, this.leafMat, false),
      };

      if (streamer) this._registerColliders(s, streamer, surfaces);
    }
  }

  /**
   * Lazy colliders grouped in 32 m buckets: one lazy entry per bucket keeps
   * the streamer's bookkeeping small even with tens of thousands of trees.
   */
  _registerColliders(s, streamer, surfaces) {
    const B = 32;
    const buckets = new Map();
    for (const t of s.trees) {
      const k = `${Math.floor(t.x / B)},${Math.floor(t.z / B)}`;
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(t);
    }
    const conifer = s.collide === 'conifer';
    for (const [k, trees] of buckets) {
      const [bx, bz] = k.split(',').map(Number);
      streamer.addLazy(
        { minX: bx * B, maxX: bx * B + B, minZ: bz * B, maxZ: bz * B + B },
        () => {
          const bodies = [];
          for (const t of trees) {
            const trunkW = Math.max(0.2, t.w * 0.06);
            const trunkH = t.h * (conifer ? 0.95 : 0.55);
            const trunk = new CANNON.Body({
              mass: 0,
              shape: new CANNON.Box(new CANNON.Vec3(trunkW / 2, trunkH / 2, trunkW / 2)),
              material: surfaces?.hard,
              collisionFilterGroup: GROUP.WORLD,
              collisionFilterMask: GROUP.DRONE,
            });
            trunk.position.set(t.x, t.y + trunkH / 2, t.z);
            bodies.push(trunk);
            // Canopy: soft spheres, a touch smaller than the visual so a
            // brushing pass through the outer twigs stays survivable.
            const spheres = conifer
              ? [[0.3, t.w * 0.2], [0.55, t.w * 0.13]]
              : [[0.7, t.w * 0.26]];
            for (const [fy, r] of spheres) {
              const c = new CANNON.Body({
                mass: 0,
                shape: new CANNON.Sphere(r),
                material: surfaces?.soft,
                collisionFilterGroup: GROUP.WORLD,
                collisionFilterMask: GROUP.DRONE,
              });
              c.position.set(t.x, t.y + t.h * fy, t.z);
              bodies.push(c);
            }
          }
          return bodies;
        },
      );
    }
  }

  /** Re-bucket near/far batches if the camera has moved enough. */
  update(cameraPos, force = false) {
    if (!cameraPos) return;
    const last = this._last;
    const moved = last ? Math.hypot(cameraPos.x - last.x, cameraPos.z - last.z) : Infinity;
    if (!force && moved < Math.max(12, this.lod0 * 0.12)) return;
    this._last = { x: cameraPos.x, z: cameraPos.z };

    const cx = cameraPos.x;
    const cz = cameraPos.z;
    const n0 = this.lod0 * this.lod0;
    const nd = this.drawDistance * this.drawDistance;
    for (const s of this.species) {
      if (!s.batches) continue;
      const b = s.batches;
      const nearArr = b.nearLeaves.instanceMatrix.array;
      const farArr = b.farLeaves.instanceMatrix.array;
      const nearTr = b.nearTrunk.instanceMatrix.array;
      const farTr = b.farTrunk.instanceMatrix.array;
      let ni = 0;
      let fi = 0;
      const M = s.matrices;
      const trees = s.trees;
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        const dx = t.x - cx;
        const dz = t.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > nd) continue;
        const src = M.subarray(i * 16, i * 16 + 16);
        if (d2 < n0) {
          nearArr.set(src, ni * 16);
          nearTr.set(src, ni * 16);
          ni++;
        } else {
          farArr.set(src, fi * 16);
          farTr.set(src, fi * 16);
          fi++;
        }
      }
      b.nearLeaves.count = ni;
      b.nearTrunk.count = ni;
      b.farLeaves.count = fi;
      b.farTrunk.count = fi;
      for (const mesh of [b.nearLeaves, b.nearTrunk, b.farLeaves, b.farTrunk]) {
        mesh.instanceMatrix.clearUpdateRanges?.();
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const s of this.species) {
      if (s.batches) {
        for (const mesh of Object.values(s.batches)) {
          mesh.parent?.remove(mesh);
          try { mesh.dispose(); } catch (_e) { /* ignore */ }
        }
      }
      for (const g of [s.near.trunk, s.near.leaves, s.far.trunk, s.far.leaves]) {
        try { g.dispose(); } catch (_e) { /* ignore */ }
      }
    }
    this.species.length = 0;
    try { this.leafMat.dispose(); } catch (_e) { /* ignore */ }
    try { this.trunkMat.dispose(); } catch (_e) { /* ignore */ }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
