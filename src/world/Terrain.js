/**
 * world/Terrain.js
 * ---------------------------------------------------------------------------
 * Kilometre-scale heightmap terrain: one height grid, three consumers.
 *
 *   1. Rendering — the grid is cut into square chunks, each drawn at one of
 *      five levels of detail chosen by distance to the camera. Every level
 *      samples the *same* grid points (a stride of 1, 2, 4, 8 or 16 cells), so
 *      a chunk changing LOD never changes the terrain's silhouette in a way the
 *      eye catches, and each chunk carries a short skirt that hides the
 *      hairline cracks where two levels meet.
 *   2. Collision — each chunk also gets a cannon Heightfield built from exactly
 *      the grid points LOD 0 draws, so what the pilot sees at full detail is
 *      what the quad hits. Chunks are registered with the ColliderStreamer and
 *      only the ones under the drone are live.
 *   3. Queries — `heightAt` / `normalAt` for prop placement, AGL, ground
 *      effect, and a float height texture the GPU grass samples so every blade
 *      sits on the ground.
 *
 * Normals are computed from the full-resolution grid for every LOD, so a
 * distant hill is lit exactly like the near one it turns into.
 *
 * The splat map (RGBA8 over the whole terrain) is painted by the map with
 * whatever surface types it wants — see TerrainMaterial for the channel
 * meanings. It is sampled per-fragment, so a 1 m wide footpath can wander for
 * two kilometres at the cost of one texture.
 */

import * as THREE from 'three/webgpu';
import * as CANNON from 'cannon-es';
import { GROUP } from '../core/PhysicsWorld.js';
import { activeQuality } from '../render/Quality.js';

const LOD_STRIDES = [1, 2, 4, 8, 16];

export class Terrain {
  /**
   * @param {object} o
   * @param {number} o.cell         metres between grid points at full detail
   * @param {number} o.chunkCells   grid cells per chunk side (power of two, ≥ 16)
   * @param {number} o.chunks       chunks per side
   * @param {(x:number, z:number) => number} o.heightFn   world height
   * @param {number} [o.splatSize]  splat texture resolution
   */
  constructor({ cell = 2, chunkCells = 64, chunks = 16, heightFn, splatSize = 1024 }) {
    this.cell = cell;
    this.chunkCells = chunkCells;
    this.chunks = chunks;
    this.cells = chunkCells * chunks;          // grid cells per side
    this.size = this.cells * cell;             // metres per side
    this.half = this.size / 2;
    this.n = this.cells + 1;                   // grid points per side
    this.heightFn = heightFn;

    this.heights = new Float32Array(this.n * this.n);
    this.minHeight = 0;
    this.maxHeight = 0;

    this.splatSize = splatSize;
    this.splat = new Uint8Array(splatSize * splatSize * 4);

    this.mesh = null;          // TerrainRenderer once built
    this._heightTex = null;
    this._splatTex = null;
  }

  /* ---------------------------------------------------------------------- *
   * Generation
   * ---------------------------------------------------------------------- */

  /** Fill the height grid. A generator so a big map keeps the loader alive. */
  *generate(progressFrom = 0, progressTo = 0.2) {
    const { n, cell, half, heights, heightFn } = this;
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = 0; j < n; j++) {
      const z = -half + j * cell;
      const row = j * n;
      for (let i = 0; i < n; i++) {
        let h = heightFn(-half + i * cell, z);
        if (!Number.isFinite(h)) h = 0;
        heights[row + i] = h;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
      if ((j & 31) === 0) {
        yield { progress: progressFrom + (progressTo - progressFrom) * (j / n), label: 'Terrain' };
      }
    }
    this.minHeight = mn;
    this.maxHeight = mx;
  }

  /** Apply a function to every grid height: `h = fn(x, z, h)`. For carving. */
  *modify(fn, label = 'Shaping terrain') {
    const { n, cell, half, heights } = this;
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = 0; j < n; j++) {
      const z = -half + j * cell;
      const row = j * n;
      for (let i = 0; i < n; i++) {
        let h = fn(-half + i * cell, z, heights[row + i]);
        if (!Number.isFinite(h)) h = heights[row + i];
        heights[row + i] = h;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
      if ((j & 63) === 0) yield { label };
    }
    this.minHeight = mn;
    this.maxHeight = mx;
  }

  /* ---------------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------------- */

  /** Raw grid height at integer indices (clamped). */
  gridHeight(i, j) {
    const n = this.n;
    const ii = i < 0 ? 0 : i >= n ? n - 1 : i;
    const jj = j < 0 ? 0 : j >= n ? n - 1 : j;
    return this.heights[jj * n + ii];
  }

  /**
   * Height at a world position, interpolated on the same triangle split the
   * render mesh and the cannon Heightfield use, so props sit on the surface
   * the quad actually collides with.
   *
   * The split is the (i,j)-(i+1,j+1) diagonal. That is not arbitrary: cannon
   * triangulates its Heightfield along the other diagonal *in its own frame*,
   * and the body is rotated -90° about X to lie flat, which mirrors Z and so
   * flips the diagonal in world space to this one.
   */
  heightAt(x, z) {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    if (!Number.isFinite(fx) || !Number.isFinite(fz)) return 0;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h00 = this.gridHeight(i, j);
    const h10 = this.gridHeight(i + 1, j);
    const h01 = this.gridHeight(i, j + 1);
    const h11 = this.gridHeight(i + 1, j + 1);
    if (v >= u) return h00 + (h11 - h01) * u + (h01 - h00) * v;
    return h00 + (h10 - h00) * u + (h11 - h10) * v;
  }

  /** Surface normal from central differences on the full-res grid. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = this.cell;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** 0 = flat, 1 = vertical. */
  slopeAt(x, z) {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  contains(x, z, margin = 0) {
    return Math.abs(x) <= this.half - margin && Math.abs(z) <= this.half - margin;
  }

  /* ---------------------------------------------------------------------- *
   * Splat map
   * ---------------------------------------------------------------------- */

  /**
   * Paint the whole splat map from a function of world position. `fn(x, z)`
   * returns [r, g, b, a] in 0..1. A generator — at 1024² it is a million calls.
   */
  *paintSplat(fn) {
    const S = this.splatSize;
    const d = this.splat;
    const step = this.size / S;
    const out = [0, 0, 0, 0];
    for (let j = 0; j < S; j++) {
      const z = -this.half + (j + 0.5) * step;
      for (let i = 0; i < S; i++) {
        const x = -this.half + (i + 0.5) * step;
        out[0] = out[1] = out[2] = out[3] = 0;
        fn(x, z, out);
        const k = (j * S + i) * 4;
        d[k] = clampByte(out[0]);
        d[k + 1] = clampByte(out[1]);
        d[k + 2] = clampByte(out[2]);
        d[k + 3] = clampByte(out[3]);
      }
      if ((j & 63) === 0) yield { label: 'Painting ground' };
    }
    if (this._splatTex) this._splatTex.needsUpdate = true;
  }

  /** Read back a splat channel at a world position (0..1), for scatter rules. */
  splatAt(x, z, channel) {
    const S = this.splatSize;
    const i = Math.floor(((x + this.half) / this.size) * S);
    const j = Math.floor(((z + this.half) / this.size) * S);
    if (i < 0 || j < 0 || i >= S || j >= S) return 0;
    return this.splat[(j * S + i) * 4 + channel] / 255;
  }

  splatTexture() {
    if (this._splatTex) return this._splatTex;
    const S = this.splatSize;
    const tex = new THREE.DataTexture(this.splat, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this._splatTex = tex;
    return tex;
  }

  /**
   * Height as a float texture for GPU consumers (grass). Downsampled to at
   * most 1024² — grass only needs the ground to within a few centimetres.
   */
  heightTexture() {
    if (this._heightTex) return this._heightTex;
    const target = Math.min(1024, this.n);
    const data = new Float32Array(target * target);
    for (let j = 0; j < target; j++) {
      const z = -this.half + (j / (target - 1)) * this.size;
      for (let i = 0; i < target; i++) {
        const x = -this.half + (i / (target - 1)) * this.size;
        data[j * target + i] = this.heightAt(x, z);
      }
    }
    const tex = new THREE.DataTexture(data, target, target, THREE.RedFormat, THREE.FloatType);
    // Nearest: consumers read it with texelFetch and interpolate themselves,
    // because linear filtering of 32-bit float textures is an optional
    // extension and an unsupported filter makes the texture sample as zero.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this._heightTex = tex;
    this._heightTexSize = target;
    return tex;
  }

  /* ---------------------------------------------------------------------- *
   * Render mesh
   * ---------------------------------------------------------------------- */

  /**
   * Build the chunked LOD renderer and parent it under `root`.
   * @returns {TerrainRenderer}
   */
  buildRenderer(root, material) {
    this.mesh = new TerrainRenderer(this, root, material);
    return this.mesh;
  }

  /* ---------------------------------------------------------------------- *
   * Colliders
   * ---------------------------------------------------------------------- */

  /**
   * One Heightfield body per chunk, registered with the streamer. Only chunks
   * whose footprint intersects `region` (defaults to everything) get one —
   * distant mountainsides the drone cannot reach need no physics at all.
   */
  *buildColliders(streamer, material, region = null) {
    const { chunkCells, cell, chunks, half } = this;
    const span = chunkCells * cell;
    let done = 0;
    for (let cj = 0; cj < chunks; cj++) {
      for (let ci = 0; ci < chunks; ci++) {
        const x0 = -half + ci * span;
        const z0 = -half + cj * span;
        const x1 = x0 + span;
        const z1 = z0 + span;
        if (region && (x1 < region.minX || x0 > region.maxX || z1 < region.minZ || z0 > region.maxZ)) continue;
        // Lazy: the Heightfield is only built while the drone is near this
        // chunk. Building one is a few hundred microseconds; keeping several
        // hundred resident would cost tens of megabytes for no benefit.
        streamer.addLazy(
          { minX: x0, maxX: x1, minZ: z0, maxZ: z1 },
          () => this.chunkCollider(ci, cj, material),
        );
        if ((++done & 31) === 0) yield { label: 'Ground collision' };
      }
    }
  }

  /** One cannon Heightfield body for chunk (ci, cj), from the LOD-0 grid. */
  chunkCollider(ci, cj, material) {
    const { chunkCells, cell, half, n } = this;
    const span = chunkCells * cell;
    const x0 = -half + ci * span;
    const z1 = -half + (cj + 1) * span;
    // data[i][j]: i along +X, j along local +Y = world -Z (body rotated -90° about X).
    const data = [];
    const gi0 = ci * chunkCells;
    const gj1 = (cj + 1) * chunkCells;   // world z1 row
    for (let i = 0; i <= chunkCells; i++) {
      const col = new Array(chunkCells + 1);
      for (let j = 0; j <= chunkCells; j++) {
        const gj = gj1 - j;
        col[j] = this.heights[Math.min(n - 1, gj) * n + Math.min(n - 1, gi0 + i)];
      }
      data.push(col);
    }
    try {
      const shape = new CANNON.Heightfield(data, { elementSize: cell });
      const body = new CANNON.Body({
        mass: 0,
        material,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: GROUP.DRONE,
      });
      body.addShape(shape);
      body.position.set(x0, 0, z1);
      body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      body.isTerrain = true;
      return body;
    } catch (err) {
      console.warn('[Terrain] heightfield chunk failed; using a slab.', err);
      let mn = Infinity;
      for (const col of data) for (const h of col) mn = Math.min(mn, h);
      const body = new CANNON.Body({
        mass: 0,
        material,
        shape: new CANNON.Box(new CANNON.Vec3(span / 2, 1, span / 2)),
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: GROUP.DRONE,
      });
      body.position.set(x0 + span / 2, mn - 1, z1 - span / 2);
      return body;
    }
  }

  dispose() {
    this.mesh?.dispose();
    this.mesh = null;
    try { this._heightTex?.dispose(); } catch (_e) { /* ignore */ }
    try { this._splatTex?.dispose(); } catch (_e) { /* ignore */ }
    this._heightTex = null;
    this._splatTex = null;
  }
}

/* ========================================================================== *
 * Chunked LOD renderer
 * ========================================================================== */

class TerrainRenderer {
  constructor(terrain, root, material) {
    this.terrain = terrain;
    this.material = material;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    root.add(this.group);

    const { chunks, chunkCells, cell, half } = terrain;
    const span = chunkCells * cell;
    this.span = span;
    this.chunks = [];
    for (let cj = 0; cj < chunks; cj++) {
      for (let ci = 0; ci < chunks; ci++) {
        const x0 = -half + ci * span;
        const z0 = -half + cj * span;
        const mesh = new THREE.Mesh(undefined, material);
        mesh.name = `terrain-${ci}-${cj}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        this.group.add(mesh);
        this.chunks.push({
          ci, cj, x0, z0,
          cx: x0 + span / 2, cz: z0 + span / 2,
          mesh, lod: -1, geos: new Array(LOD_STRIDES.length).fill(null),
        });
      }
    }
    this._lastUpdate = null;
    this._budget = 0;
  }

  /** Pick LODs for the camera position. Builds at most a few geometries per call. */
  update(cameraPos, force = false) {
    if (!cameraPos) return;
    const last = this._lastUpdate;
    if (!force && last && Math.abs(last.x - cameraPos.x) < 4 && Math.abs(last.z - cameraPos.z) < 4 &&
        Math.abs(last.y - cameraPos.y) < 4 && this._pending === 0) return;
    this._lastUpdate = { x: cameraPos.x, y: cameraPos.y, z: cameraPos.z };

    const scale = activeQuality.terrainLodScale || 1;
    const thresholds = [150 * scale, 340 * scale, 720 * scale, 1500 * scale];
    let budget = force ? Infinity : 6;
    let pending = 0;
    const halfSpan = this.span / 2;

    for (const c of this.chunks) {
      const dx = Math.max(0, Math.abs(cameraPos.x - c.cx) - halfSpan);
      const dz = Math.max(0, Math.abs(cameraPos.z - c.cz) - halfSpan);
      const dy = Math.max(0, cameraPos.y - this.terrain.maxHeight);
      const d = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.25);
      let lod = LOD_STRIDES.length - 1;
      for (let k = 0; k < thresholds.length; k++) {
        if (d < thresholds[k]) { lod = k; break; }
      }
      if (lod === c.lod) continue;

      if (!c.geos[lod]) {
        if (budget <= 0) {
          // Keep showing the coarser/finer mesh we have until we get to it.
          pending++;
          if (c.lod === -1) {
            // Nothing shown yet: fall back to the cheapest level immediately.
            const cheap = LOD_STRIDES.length - 1;
            if (!c.geos[cheap]) c.geos[cheap] = this._buildChunk(c, cheap);
            c.mesh.geometry = c.geos[cheap];
            c.mesh.visible = true;
            c.lod = cheap;
          }
          continue;
        }
        c.geos[lod] = this._buildChunk(c, lod);
        budget--;
      }
      c.mesh.geometry = c.geos[lod];
      c.mesh.visible = true;
      c.lod = lod;

      // Free full-detail geometry of chunks that have moved well away.
      for (let k = 0; k < 2; k++) {
        if (k !== lod && c.geos[k] && d > thresholds[k] * 2.2) {
          c.geos[k].dispose();
          c.geos[k] = null;
        }
      }
    }
    this._pending = pending;
  }

  /**
   * Build one chunk at one LOD: a (m+1)² grid of vertices at `stride` cells
   * apart plus a skirt ring dropped below the surface.
   */
  _buildChunk(c, lod) {
    const t = this.terrain;
    const stride = LOD_STRIDES[lod];
    const m = t.chunkCells / stride;        // quads per side
    const vRow = m + 1;
    const gridVerts = vRow * vRow;
    const skirtVerts = 4 * vRow;
    const total = gridVerts + skirtVerts;

    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const gi0 = c.ci * t.chunkCells;
    const gj0 = c.cj * t.chunkCells;
    const n = t.n;
    const H = t.heights;
    const cell = t.cell;
    const skirt = 1.5 + stride * cell * 0.6;

    const put = (idx, gi, gj, drop) => {
      const ii = Math.min(n - 1, gi);
      const jj = Math.min(n - 1, gj);
      const h = H[jj * n + ii];
      pos[idx * 3] = -t.half + ii * cell;
      pos[idx * 3 + 1] = h - drop;
      pos[idx * 3 + 2] = -t.half + jj * cell;
      // Full-resolution central-difference normal, whatever the LOD.
      const hl = H[jj * n + Math.max(0, ii - 1)];
      const hr = H[jj * n + Math.min(n - 1, ii + 1)];
      const hd = H[Math.max(0, jj - 1) * n + ii];
      const hu = H[Math.min(n - 1, jj + 1) * n + ii];
      let nx = hl - hr;
      let ny = 2 * cell;
      let nz = hd - hu;
      const len = Math.hypot(nx, ny, nz) || 1;
      nor[idx * 3] = nx / len;
      nor[idx * 3 + 1] = ny / len;
      nor[idx * 3 + 2] = nz / len;
    };

    for (let j = 0; j < vRow; j++) {
      for (let i = 0; i < vRow; i++) put(j * vRow + i, gi0 + i * stride, gj0 + j * stride, 0);
    }
    // Skirt: north (j=0), south (j=m), west (i=0), east (i=m) edges.
    let s = gridVerts;
    const skirtStart = [s, s + vRow, s + 2 * vRow, s + 3 * vRow];
    for (let i = 0; i < vRow; i++) put(s++, gi0 + i * stride, gj0, skirt);
    for (let i = 0; i < vRow; i++) put(s++, gi0 + i * stride, gj0 + m * stride, skirt);
    for (let j = 0; j < vRow; j++) put(s++, gi0, gj0 + j * stride, skirt);
    for (let j = 0; j < vRow; j++) put(s++, gi0 + m * stride, gj0 + j * stride, skirt);

    const quadCount = m * m + 4 * m;
    const idx = new (total > 65535 ? Uint32Array : Uint16Array)(quadCount * 6);
    let k = 0;
    // Surface. Winding gives +Y normals; the a-d diagonal matches heightAt()
    // and the cannon Heightfield (see the note on heightAt).
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const a = j * vRow + i;
        const b = a + 1;
        const cI = a + vRow;
        const d = cI + 1;
        idx[k++] = a; idx[k++] = cI; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
    // Skirts, wound to face outward.
    for (let i = 0; i < m; i++) {
      // North edge (z min): outward is -Z.
      let a = i, b = i + 1, sa = skirtStart[0] + i, sb = sa + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = sa;
      idx[k++] = b; idx[k++] = sb; idx[k++] = sa;
      // South edge (z max): outward is +Z.
      a = m * vRow + i; b = a + 1; sa = skirtStart[1] + i; sb = sa + 1;
      idx[k++] = a; idx[k++] = sa; idx[k++] = b;
      idx[k++] = b; idx[k++] = sa; idx[k++] = sb;
    }
    for (let j = 0; j < m; j++) {
      // West edge (x min): outward is -X.
      let a = j * vRow, b = (j + 1) * vRow, sa = skirtStart[2] + j, sb = sa + 1;
      idx[k++] = a; idx[k++] = sa; idx[k++] = b;
      idx[k++] = b; idx[k++] = sa; idx[k++] = sb;
      // East edge (x max): outward is +X.
      a = j * vRow + m; b = (j + 1) * vRow + m; sa = skirtStart[3] + j; sb = sa + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = sa;
      idx[k++] = b; idx[k++] = sb; idx[k++] = sa;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  dispose() {
    for (const c of this.chunks) {
      for (const g of c.geos) g?.dispose();
      c.geos.fill(null);
    }
    this.group.parent?.remove(this.group);
    this.chunks.length = 0;
  }
}

function clampByte(v) {
  const x = Math.round(v * 255);
  return x < 0 ? 0 : x > 255 ? 255 : x;
}
