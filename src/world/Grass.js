/**
 * world/Grass.js
 * ---------------------------------------------------------------------------
 * GPU meadow grass: tens of thousands of individual blades around the camera,
 * for one draw call and almost no CPU.
 *
 * The blades live in a square tile of side 2·range. Each instance stores a
 * fixed position *inside the tile*; the vertex shader wraps that position
 * toroidally around the camera (`mod`), so as the camera moves, blades that
 * fall off the back edge reappear at the front. Nothing is ever rebuilt or
 * re-uploaded, and because a blade's world position only depends on its own
 * tile slot, blades never swim or pop as the camera moves.
 *
 * Each blade samples the terrain height (manual bilinear on a float texture,
 * so it works without float-linear filtering support) and the splat map, and
 * hides itself on dirt, gravel, forest floor, steep rock and under water. The
 * outer 30 % of the range fades blades down to nothing, so there is no edge.
 *
 * Lighting uses a stock MeshStandardNodeMaterial (sun, shadows, fog, IBL) with
 * a mostly-up normal, which is how real grass reads from above: a lit carpet,
 * not a field of dark vertical slivers. The placement runs in the material's
 * `positionNode` (TSL), which also rewrites the vertex normal.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, ivec2, uniform, texture, textureLoad, attribute, varyingProperty,
  clamp, cos, sin, floor, length, mix, mod, normalize, smoothstep, step,
  positionGeometry, normalLocal,
} from 'three/tsl';
import { makeRng } from '../assets/procedural.js';
import { activeQuality } from '../render/Quality.js';

export class Grass {
  /**
   * @param {object} o
   * @param {import('./Terrain.js').Terrain} o.terrain
   * @param {number} [o.seed]
   * @param {number} [o.waterLevel]  blades below this height are hidden
   * @param {number} [o.bladeHeight] metres
   * @param {number} [o.baseDensity] blades per m² before the quality multiplier
   * @param {THREE.Color|number} [o.tint]
   */
  constructor({
    terrain, seed = 5, waterLevel = -9999, bladeHeight = 0.42,
    baseDensity = 5, tint = 0x8fb04a, dryTint = 0xc8b46a,
  }) {
    this.terrain = terrain;
    const q = activeQuality;
    this.range = Math.max(20, q.grassRange || 50);
    const tile = this.range * 2;
    const density = baseDensity * (Number.isFinite(q.grassDensity) ? q.grassDensity : 0.75);
    const count = Math.max(0, Math.min(320000, Math.floor(tile * tile * density)));
    this.count = count;
    this.mesh = null;
    if (count === 0) return;

    /* ---- one blade: 2 segments + tip, tapered ---- */
    const blade = new THREE.BufferGeometry();
    const w = 0.055;
    const pos = new Float32Array([
      -w / 2, 0, 0, w / 2, 0, 0,
      -w * 0.36, 0.45, 0, w * 0.36, 0.45, 0,
      0, 1, 0,
    ]);
    const idx = [0, 1, 3, 0, 3, 2, 2, 3, 4];
    blade.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const nrm = new Float32Array(15);
    for (let i = 1; i < 15; i += 3) nrm[i] = 1;
    blade.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    blade.setIndex(idx);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(blade.index);
    geo.setAttribute('position', blade.attributes.position);
    geo.setAttribute('normal', blade.attributes.normal);
    geo.instanceCount = count;

    const rng = makeRng(seed);
    const off = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Mild clumping: bias a share of blades toward a few hundred centres.
      let x = rng() * tile;
      let z = rng() * tile;
      if (rng() < 0.45) {
        const cx = Math.floor(x / 3.1) * 3.1 + 1.55;
        const cz = Math.floor(z / 3.1) * 3.1 + 1.55;
        x = cx + (x - cx) * 0.55;
        z = cz + (z - cz) * 0.55;
      }
      off[i * 4] = x;
      off[i * 4 + 1] = z;
      off[i * 4 + 2] = rng();
      off[i * 4 + 3] = 0.55 + rng() * rng() * 1.1;
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 4));
    // Everything is placed in the shader: the CPU-side bounds mean nothing.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6));
    this._blade = blade;
    this.geometry = geo;

    const heightTex = terrain.heightTexture();
    const splatTex = terrain.splatTexture();
    const hs = terrain._heightTexSize || 1024;

    // Same names as the former GLSL uniforms; `update()` writes the values.
    this.uniforms = {
      uCam: uniform(new THREE.Vector2()),
      uTile: uniform(tile),
      uRange: uniform(this.range),
      uTime: uniform(0),
      uBladeH: uniform(bladeHeight),
      uWind: uniform(new THREE.Vector2(0.18, 0.08)),
      uWater: uniform(waterLevel),
      tHeight: heightTex,
      uHRect: uniform(new THREE.Vector4(-terrain.half, -terrain.half, terrain.size, hs)),
      tGSplat: texture(splatTex),
      uSRect: uniform(new THREE.Vector4(-terrain.half, -terrain.half, terrain.size, terrain.size)),
      uTint: uniform(new THREE.Color(tint)),
      uDry: uniform(new THREE.Color(dryTint)),
    };
    const U = this.uniforms;

    const mat = new THREE.MeshStandardNodeMaterial({
      color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    });
    mat.name = 'GrassMaterial';

    const aOffset = attribute('aOffset', 'vec4');
    const vGT = varyingProperty('float', 'vGT');
    const vGDry = varyingProperty('float', 'vGDry');

    /** Manual bilinear height (texelFetch) plus its gradient, in metres. */
    const gHeightAt = (wxz) => {
      const n = U.uHRect.w;
      const uv = clamp(wxz.sub(U.uHRect.xy).div(U.uHRect.z).mul(n.sub(1.0)), vec2(0.0), vec2(n.sub(1.001))).toVar();
      const i = floor(uv);
      const f = uv.sub(i).toVar();
      const p = ivec2(i).toVar();
      const a = textureLoad(U.tHeight, p, 0).r.toVar();
      const b = textureLoad(U.tHeight, p.add(ivec2(1, 0)), 0).r.toVar();
      const c = textureLoad(U.tHeight, p.add(ivec2(0, 1)), 0).r.toVar();
      const d = textureLoad(U.tHeight, p.add(ivec2(1, 1)), 0).r.toVar();
      const cellM = U.uHRect.z.div(n.sub(1.0));
      const grad = vec2(mix(b.sub(a), d.sub(c), f.y), mix(c.sub(a), d.sub(b), f.x)).div(cellM);
      const h = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      return { h, grad };
    };

    mat.positionNode = Fn(() => {
      const rel = mod(aOffset.xy.sub(U.uCam).add(U.uTile.mul(0.5)), U.uTile).sub(U.uTile.mul(0.5)).toVar();
      const wxz = U.uCam.add(rel).toVar();
      const dist = length(rel);
      const fade = float(1.0).sub(smoothstep(U.uRange.mul(0.62), U.uRange.mul(0.98), dist));
      const hg = gHeightAt(wxz);
      const h = hg.h.toVar();
      const grad = hg.grad.toVar();
      const sp = U.tGSplat.sample(wxz.sub(U.uSRect.xy).div(U.uSRect.zw)).toVar();
      const slope = length(grad);
      const mask = float(1.0).sub(smoothstep(0.25, 0.55, sp.r))
        .mul(float(1.0).sub(smoothstep(0.25, 0.55, sp.b)))
        .mul(float(1.0).sub(smoothstep(0.3, 0.8, sp.a).mul(0.75)))
        .mul(float(1.0).sub(smoothstep(0.45, 0.8, slope)))
        .mul(step(U.uWater.add(0.12), h));
      const scale = fade.mul(mask).mul(aOffset.w).toVar();
      vGDry.assign(sp.g);
      const rot = aOffset.z.mul(6.2831853).toVar();
      const cs = cos(rot);
      const sn = sin(rot);
      // Blades widen with distance so the thinning outer ring still reads as a carpet.
      const widen = float(1.0).add(dist.mul(1.6).div(U.uRange));
      const px = positionGeometry.x.mul(widen);
      const r = vec3(px.mul(cs), 0.0, px.mul(sn));
      const t = positionGeometry.y;
      const hgt = U.uBladeH.mul(scale).mul(float(0.8).add(sp.g.mul(0.4)));
      const gust = sin(U.uTime.mul(1.9).add(wxz.x.mul(0.23)).add(wxz.y.mul(0.17))).mul(0.55)
        .add(sin(U.uTime.mul(3.7).add(wxz.x.mul(0.61)).sub(wxz.y.mul(0.43))).mul(0.25)).add(0.45);
      const lean = U.uWind.mul(gust).add(vec2(cos(rot.mul(1.7)), sin(rot.mul(1.3))).mul(0.12));
      const bladePos = vec3(wxz.x, h, wxz.y).add(r.mul(scale)).add(vec3(0.0, t.mul(hgt), 0.0))
        .add(vec3(lean.x, 0.0, lean.y).mul(t).mul(t).mul(hgt));
      // Mostly-up normal, tilted a touch toward the blade face.
      normalLocal.assign(normalize(vec3(grad.x.negate(), 1.0, grad.y.negate()).add(vec3(sn, 0.0, cs.negate()).mul(0.25))));
      vGT.assign(t);
      return bladePos;
    })();

    const gCol = mix(U.uTint, U.uDry, clamp(vGDry.mul(0.8), 0.0, 1.0));
    mat.colorNode = vec4(gCol.mul(mix(0.38, 1.08, vGT)), 1.0);
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'grass';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this._time = 0;
  }

  /** Follow the camera and advance the wind. */
  update(cameraPos, dt, windDir = null) {
    if (!this.mesh || !cameraPos) return;
    this.uniforms.uCam.value.set(cameraPos.x, cameraPos.z);
    this._time += Number.isFinite(dt) ? Math.min(dt, 0.1) : 0.016;
    this.uniforms.uTime.value = this._time;
    if (windDir) this.uniforms.uWind.value.set(windDir.x, windDir.y);
    // Nothing to see from high altitude: skip the vertex work entirely.
    const agl = cameraPos.y - this.terrain.heightAt(cameraPos.x, cameraPos.z);
    this.mesh.visible = agl < this.range * 0.9;
  }

  dispose() {
    try { this.geometry?.dispose(); } catch (_e) { /* ignore */ }
    try { this._blade?.dispose(); } catch (_e) { /* ignore */ }
    try { this.material?.dispose(); } catch (_e) { /* ignore */ }
    this.mesh?.parent?.remove(this.mesh);
    this.mesh = null;
  }
}
