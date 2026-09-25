/**
 * world/OutdoorKit.js
 * ---------------------------------------------------------------------------
 * Everything a kilometre-scale open-air map needs, in one place:
 *
 *   - a chunked, LOD'd heightmap Terrain whose streamed Heightfield colliders
 *     are built from exactly the grid the pilot sees at full detail;
 *   - the splat-blended ground shader with photographic procedural textures
 *     (cached across map loads — they take a second or two to paint);
 *   - GPU grass around the camera;
 *   - an instanced, LOD'd forest with lazy colliders;
 *   - open water with scrolling ripple normals and sky reflections.
 *
 * Maps describe their land with a height function and a splat rule; this kit
 * does the rest and hands back `heightAt()` so every prop is seated on the
 * surface the drone actually collides with.
 */

import * as THREE from 'three';
import { Terrain } from './Terrain.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import {
  grassGroundTexture, dirtGroundTexture, rockGroundTexture, gravelGroundTexture,
  forestFloorTexture, waterNormalTexture,
} from './TerrainTextures.js';
import { Grass } from './Grass.js';
import { Forest, coniferGeometry, broadleafGeometry } from './Forest.js';
import { activeQuality } from '../render/Quality.js';
import { foliageTexture, barkTexture } from '../assets/procedural.js';

/**
 * Ground textures survive map switches: they are the slowest thing to
 * generate and every outdoor map uses the same five. ~30 MB of VRAM, once.
 */
const TEX_CACHE = new Map();

function cachedTexture(key, make) {
  if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
  const t = make();
  TEX_CACHE.set(key, t);
  return t;
}

export class OutdoorWorld {
  /**
   * @param {import('../maps/MapKit.js').MapBuilder} builder  (must be streaming)
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {object} o
   * @param {(x:number,z:number)=>number} o.heightFn
   * @param {number} o.cell         metres per grid cell
   * @param {number} o.chunkCells   cells per chunk side
   * @param {number} o.chunks       chunks per side
   * @param {number} [o.waterLevel] open water height, or null for none
   * @param {object} [o.look]       terrain shader tints/thresholds
   */
  constructor(builder, physics, {
    heightFn, cell = 2, chunkCells = 64, chunks = 8, waterLevel = null, look = {}, splatSize = 1024,
  }) {
    this.b = builder;
    this.physics = physics;
    this.terrain = new Terrain({ cell, chunkCells, chunks, heightFn, splatSize });
    this.waterLevel = Number.isFinite(waterLevel) ? waterLevel : null;
    this.look = look;
    this.grass = null;
    this.forest = null;
    this.water = null;
    this._waterNormal = null;
    this._t = 0;
  }

  get size() { return this.terrain.size; }
  get half() { return this.terrain.half; }

  /** Ground height (terrain only). */
  heightAt(x, z) {
    return this.terrain.heightAt(x, z);
  }

  /** Surface the quad would land on: terrain or water, whichever is higher. */
  surfaceAt(x, z) {
    const h = this.terrain.heightAt(x, z);
    return this.waterLevel !== null ? Math.max(h, this.waterLevel) : h;
  }

  /**
   * Generate the height grid. Separate from `build()` so a map can carve
   * roads, pads and lakes into the grid with `terrain.modify()` in between.
   */
  *generate(p0 = 0.05, p1 = 0.25) {
    yield* this.terrain.generate(p0, p1);
  }

  /**
   * Paint, texture, mesh and collide the terrain.
   * `splat(x, z, h, slope, out)` writes [dirt, dry grass, gravel, forest] 0..1.
   */
  *build({ splat, progress = [0.25, 0.5], grassOpts = {}, grass = true } = {}) {
    const t = this.terrain;
    const [pA, pB] = progress;
    const lerpP = (k) => pA + (pB - pA) * k;

    yield { progress: lerpP(0.05), label: 'Painting ground' };
    if (typeof splat === 'function') {
      yield* t.paintSplat((x, z, out) => splat(x, z, t.heightAt(x, z), t.slopeAt(x, z), out));
    }

    // Ground textures: one per step so the loading bar keeps moving.
    const size = activeQuality.tier === 'low' ? 512 : 1024;
    const textures = {};
    const makers = [
      ['grass', () => grassGroundTexture(101, size)],
      ['dirt', () => dirtGroundTexture(102, size)],
      ['rock', () => rockGroundTexture(103, size)],
      ['gravel', () => gravelGroundTexture(104, size)],
      ['forest', () => forestFloorTexture(105, Math.min(size, 1024))],
    ];
    let k = 0;
    for (const [name, make] of makers) {
      yield { progress: lerpP(0.2 + 0.1 * k++), label: `Ground textures (${name})` };
      textures[name] = cachedTexture(`${name}:${size}`, make);
    }

    yield { progress: lerpP(0.72), label: 'Terrain mesh' };
    const mat = this.b.material('terrain-ground', () => createTerrainMaterial({
      terrain: t, textures, look: this.look,
    }));
    t.buildRenderer(this.b.root, mat);

    yield { progress: lerpP(0.8), label: 'Ground collision' };
    const streamer = this.b.streamer;
    if (streamer) yield* t.buildColliders(streamer, this.physics.hardMaterial);

    if (this.waterLevel !== null) this._buildWater();

    if (grass) {
      yield { progress: lerpP(0.92), label: 'Grass' };
      try {
        this.grass = new Grass({ terrain: t, waterLevel: this.waterLevel ?? -9999, ...grassOpts });
        if (this.grass.mesh) this.b.root.add(this.grass.mesh);
      } catch (err) {
        console.warn('[OutdoorKit] grass unavailable.', err);
        this.grass = null;
      }
    }
  }

  /** Open water: one large plane with scrolling ripple normals. */
  _buildWater() {
    const t = this.terrain;
    const nrm = cachedTexture('water-normal', () => waterNormalTexture(71, 256));
    const mat = this.b.material('water', () => new THREE.MeshStandardMaterial({
      color: 0x1b3a46, roughness: 0.06, metalness: 0.0,
      normalMap: nrm || null,
      normalScale: new THREE.Vector2(0.35, 0.35),
      transparent: true, opacity: 0.88,
    }));
    if (nrm) {
      // The cached texture is shared: give this map its own repeat/offset.
      const own = nrm.clone();
      own.repeat.set(t.size / 14, t.size / 14);
      own.needsUpdate = true;
      this.b.tex(own);
      mat.normalMap = own;
      this._waterNormal = own;
    }
    const geo = this.b.geometry('water-plane', () => new THREE.PlaneGeometry(t.size * 1.6, t.size * 1.6));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = this.waterLevel;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.b.root.add(mesh);
    this.water = mesh;
    // Water is solid: ditching ends the run. Soft, so skimming bounces rather
    // than stops, the way a quad skips off a lake surface.
    this.b.boxBody({
      size: [t.size * 1.2, 1, t.size * 1.2],
      position: [0, this.waterLevel - 0.5, 0],
      surface: 'soft',
    });
  }

  /**
   * A standard mixed forest: conifers and broadleaves, near + far meshes.
   * Returns { conifer, broadleaf } species indices for `forest.plant()`.
   */
  createForest() {
    const leafTex = this.b.tex(foliageTexture(9301, [3, 3]));
    const bark = this.b.tex(barkTexture(9302, [1, 3]));
    this.forest = new Forest({ root: this.b.root, leafTexture: leafTex, barkTexture: bark });
    const conifer = this.forest.addSpecies({
      near: coniferGeometry(11, 0), far: coniferGeometry(11, 1), collide: 'conifer',
    });
    const broadleaf = this.forest.addSpecies({
      near: broadleafGeometry(12, 0), far: broadleafGeometry(12, 1), collide: 'broadleaf',
    });
    return { conifer, broadleaf };
  }

  /** Finalise the forest (after planting). */
  buildForest() {
    if (!this.forest) return;
    this.forest.build(this.b.streamer, { hard: this.physics.hardMaterial, soft: this.physics.softMaterial });
  }

  /** Per-frame view work: terrain LOD, grass, trees, ripples. */
  update(cameraPos, dt) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;
    this._t += step;
    try { this.terrain.mesh?.update(cameraPos); } catch (_e) { /* keep last LOD */ }
    this.grass?.update(cameraPos, step);
    this.forest?.update(cameraPos);
    if (this._waterNormal) {
      this._waterNormal.offset.set((this._t * 0.012) % 1, (this._t * 0.007) % 1);
    }
  }

  /** Build every chunk's LOD for the spawn view before the first frame. */
  primeView(pos) {
    try { this.terrain.mesh?.update(pos, true); } catch (_e) { /* ignore */ }
    this.forest?.update(pos, true);
  }

  dispose() {
    try { this.grass?.dispose(); } catch (_e) { /* ignore */ }
    try { this.forest?.dispose(); } catch (_e) { /* ignore */ }
    try { this.terrain.dispose(); } catch (_e) { /* ignore */ }
    this.grass = null;
    this.forest = null;
    this.water = null;
  }
}

/**
 * Scatter helper: Poisson-ish rejection sampling over a rectangle with a
 * per-point acceptance rule. Deterministic for a given rng.
 */
export function scatter(rng, { minX, maxX, minZ, maxZ, count, minDist = 0, accept }) {
  const out = [];
  const cell = minDist > 0 ? minDist : 1;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const tries = count * 6;
  for (let i = 0; i < tries && out.length < count; i++) {
    const x = minX + rng() * (maxX - minX);
    const z = minZ + rng() * (maxZ - minZ);
    if (accept && !accept(x, z, rng)) continue;
    if (minDist > 0) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      let clash = false;
      for (let dx = -1; dx <= 1 && !clash; dx++) {
        for (let dz = -1; dz <= 1 && !clash; dz++) {
          const list = grid.get(`${cx + dx},${cz + dz}`);
          if (!list) continue;
          for (const p of list) {
            if ((p.x - x) ** 2 + (p.z - z) ** 2 < minDist * minDist) { clash = true; break; }
          }
        }
      }
      if (clash) continue;
      const k = key(x, z);
      let list = grid.get(k);
      if (!list) { list = []; grid.set(k, list); }
      list.push({ x, z });
    }
    out.push({ x, z });
  }
  return out;
}
