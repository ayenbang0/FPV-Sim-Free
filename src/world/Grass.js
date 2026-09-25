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
 * Lighting uses the stock MeshStandardMaterial (sun, shadows, fog, IBL) with a
 * mostly-up normal, which is how real grass reads from above: a lit carpet,
 * not a field of dark vertical slivers.
 */

import * as THREE from 'three';
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

    this.uniforms = {
      uCam: { value: new THREE.Vector2() },
      uTile: { value: tile },
      uRange: { value: this.range },
      uTime: { value: 0 },
      uBladeH: { value: bladeHeight },
      uWind: { value: new THREE.Vector2(0.18, 0.08) },
      uWater: { value: waterLevel },
      tHeight: { value: heightTex },
      uHRect: { value: new THREE.Vector4(-terrain.half, -terrain.half, terrain.size, hs) },
      tGSplat: { value: splatTex },
      uSRect: { value: new THREE.Vector4(-terrain.half, -terrain.half, terrain.size, terrain.size) },
      uTint: { value: new THREE.Color(tint) },
      uDry: { value: new THREE.Color(dryTint) },
    };

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    });
    mat.name = 'GrassMaterial';
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aOffset;
          uniform vec2 uCam;
          uniform float uTile;
          uniform float uRange;
          uniform float uTime;
          uniform float uBladeH;
          uniform vec2 uWind;
          uniform float uWater;
          uniform sampler2D tHeight;
          uniform vec4 uHRect;
          uniform sampler2D tGSplat;
          uniform vec4 uSRect;
          varying float vGT;
          varying float vGDry;
          vec3 gBladePos;
          vec3 gBladeN;
          float gHeightAt(vec2 wxz, out vec2 grad) {
            float n = uHRect.w;
            vec2 uv = (wxz - uHRect.xy) / uHRect.z * (n - 1.0);
            uv = clamp(uv, vec2(0.0), vec2(n - 1.001));
            vec2 i = floor(uv);
            vec2 f = uv - i;
            ivec2 p = ivec2(i);
            float a = texelFetch(tHeight, p, 0).r;
            float b = texelFetch(tHeight, p + ivec2(1, 0), 0).r;
            float c = texelFetch(tHeight, p + ivec2(0, 1), 0).r;
            float d = texelFetch(tHeight, p + ivec2(1, 1), 0).r;
            float cellM = uHRect.z / (n - 1.0);
            grad = vec2(mix(b - a, d - c, f.y), mix(c - a, d - b, f.x)) / cellM;
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }
          void gBlade() {
            vec2 rel = mod(aOffset.xy - uCam + 0.5 * uTile, uTile) - 0.5 * uTile;
            vec2 wxz = uCam + rel;
            float dist = length(rel);
            float fade = 1.0 - smoothstep(uRange * 0.62, uRange * 0.98, dist);
            vec2 grad;
            float h = gHeightAt(wxz, grad);
            vec4 sp = texture2D(tGSplat, (wxz - uSRect.xy) / uSRect.zw);
            float slope = length(grad);
            float mask = (1.0 - smoothstep(0.25, 0.55, sp.r))
                       * (1.0 - smoothstep(0.25, 0.55, sp.b))
                       * (1.0 - 0.75 * smoothstep(0.3, 0.8, sp.a))
                       * (1.0 - smoothstep(0.45, 0.8, slope))
                       * step(uWater + 0.12, h);
            float scale = fade * mask * aOffset.w;
            vGDry = sp.g;
            float rot = aOffset.z * 6.2831853;
            float cs = cos(rot);
            float sn = sin(rot);
            // Blades widen with distance so the thinning outer ring still reads as a carpet.
            float widen = 1.0 + 1.6 * dist / uRange;
            vec3 p = position;
            p.x *= widen;
            vec3 r = vec3(p.x * cs, 0.0, p.x * sn);
            float t = p.y;
            float hgt = uBladeH * scale * (0.8 + 0.4 * sp.g);
            float gust = sin(uTime * 1.9 + wxz.x * 0.23 + wxz.y * 0.17) * 0.55
                       + sin(uTime * 3.7 + wxz.x * 0.61 - wxz.y * 0.43) * 0.25 + 0.45;
            vec2 lean = uWind * gust + vec2(cos(rot * 1.7), sin(rot * 1.3)) * 0.12;
            gBladePos = vec3(wxz.x, h, wxz.y) + r * scale + vec3(0.0, t * hgt, 0.0)
                      + vec3(lean.x, 0.0, lean.y) * t * t * hgt;
            gBladeN = normalize(vec3(-grad.x, 1.0, -grad.y) + vec3(sn, 0.0, -cs) * 0.25);
            vGT = t;
          }
        `)
        .replace('#include <beginnormal_vertex>', `gBlade();
          vec3 objectNormal = gBladeN;
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(1.0, 0.0, 0.0);
          #endif`)
        .replace('#include <begin_vertex>', 'vec3 transformed = gBladePos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uTint;
          uniform vec3 uDry;
          varying float vGT;
          varying float vGDry;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 gCol = mix(uTint, uDry, clamp(vGDry * 0.8, 0.0, 1.0));
          diffuseColor.rgb *= gCol * mix(0.38, 1.08, vGT);`);
    };
    mat.customProgramCacheKey = () => 'fpv-grass-v1';
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
