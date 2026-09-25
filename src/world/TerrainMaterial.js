/**
 * world/TerrainMaterial.js
 * ---------------------------------------------------------------------------
 * The ground material: a MeshStandardNodeMaterial (so it keeps three's
 * lighting, shadows, fog and image-based lighting) whose albedo, roughness and
 * normal come from a per-fragment blend of surface types, written in TSL.
 *
 * Surface weights come from three places:
 *   - the splat map painted by the map (world-aligned RGBA8):
 *       R  bare dirt / tracks        G  dry grass
 *       B  gravel / sand / shingle   A  forest floor
 *   - slope: steep ground becomes rock, sampled triplanar so cliffs do not
 *     smear the texture vertically;
 *   - altitude: snow above `snowLine`, broken up by noise and slope.
 *
 * Tiling is the classic giveaway of a game ground texture, so every surface is
 * sampled twice — at two scales and a rotation — and blended by a low-frequency
 * noise field, then modulated by two octaves of macro variation (lighter and
 * darker patches, lusher and drier swathes). Over a kilometre the repetition
 * disappears.
 *
 * The normal is the geometric normal plus a short-range bump from the blended
 * albedo's luminance (strongest on rock), faded out with distance so far
 * ground does not shimmer.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, texture,
  clamp, mix, normalize, pow, abs, smoothstep, dot, length,
  positionWorld, normalWorldGeometry, cameraPosition, bumpMap,
} from 'three/tsl';
import { fpvNoise, fpvFbm } from './Noise.js';

/**
 * @param {object} o
 * @param {import('./Terrain.js').Terrain} o.terrain
 * @param {object} o.textures  { grass, dirt, rock, gravel, forest } (any may be null)
 * @param {object} [o.look]    tint and threshold overrides
 */
export function createTerrainMaterial({ terrain, textures = {}, look = {} }) {
  const L = {
    grassTint: 0xffffff,
    dryTint: 0xd8c38a,
    snowLine: 99999,
    rockSlope: 0.32,
    rockScale: 0.07,
    grassScale: 0.36,
    lushness: 0.5,
    ...look,
  };

  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0,
  });
  mat.name = 'TerrainMaterial';

  const white = whiteTexture();
  const hasTex = !!textures.grass;
  // Same names and values as the former GLSL uniforms.
  const uniforms = {
    tSplat: texture(terrain.splatTexture() || white),
    tGrass: texture(textures.grass || white),
    tDirt: texture(textures.dirt || white),
    tRock: texture(textures.rock || white),
    tGravel: texture(textures.gravel || white),
    tForest: texture(textures.forest || white),
    uHasTex: uniform(hasTex ? 1 : 0),
    uRect: uniform(new THREE.Vector4(-terrain.half, -terrain.half, terrain.size, terrain.size)),
    uGrassTint: uniform(new THREE.Color(L.grassTint)),
    uDryTint: uniform(new THREE.Color(L.dryTint)),
    uSnowLine: uniform(L.snowLine),
    uRockSlope: uniform(L.rockSlope),
    uRockScale: uniform(L.rockScale),
    uGrassScale: uniform(L.grassScale),
    uLush: uniform(L.lushness),
  };
  mat.userData.terrainUniforms = uniforms;
  const U = uniforms;

  /** Two samples at two scales and a rotation, blended by `blend`. */
  const tSample2 = (tex, uv, blend) => {
    const a = tex.sample(uv).rgb;
    const r = vec2(uv.x.mul(0.8).add(uv.y.mul(0.6)), uv.x.mul(-0.6).add(uv.y.mul(0.8))).mul(0.431).add(vec2(0.37, 0.71));
    const b = tex.sample(r).rgb;
    return mix(a, b, blend);
  };

  /* ---- surface weights (shared by colour, roughness and normal) ---- */
  const wxz = positionWorld.xz.toVar('tWxz');
  const N = normalize(normalWorldGeometry).toVar('tN');
  const sp = U.tSplat.sample(wxz.sub(U.uRect.xy).div(U.uRect.zw)).toVar('tSplatS');
  const slope = float(1.0).sub(clamp(N.y, 0.0, 1.0)).toVar('tSlope');
  const macro = fpvFbm(wxz.mul(0.0045)).toVar('tMacro');
  const macro2 = fpvFbm(wxz.mul(0.023).add(17.0)).toVar('tMacro2');
  const fine = fpvNoise(wxz.mul(0.9)).toVar('tFine');
  const tb = smoothstep(0.25, 0.75, fpvNoise(wxz.mul(0.045).add(3.0))).toVar('tTb');

  // Edges of painted regions: break the splat's texel grid with noise.
  const edgeN = fpvNoise(wxz.mul(0.6)).sub(0.5).mul(0.45).add(fine.sub(0.5).mul(0.2)).toVar('tEdge');
  const wDirt = smoothstep(0.30, 0.70, sp.r.add(edgeN)).toVar('tWDirt');
  const wDry = clamp(sp.g.add(macro.sub(0.5).mul(0.9).mul(float(1.0).sub(U.uLush))).add(macro2.sub(0.5).mul(0.25)), 0.0, 1.0).toVar('tWDry');
  const wGravel = smoothstep(0.30, 0.70, sp.b.add(edgeN)).toVar('tWGravel');
  const wForest = smoothstep(0.25, 0.75, sp.a.add(edgeN.mul(0.8))).toVar('tWForest');
  const wRock = smoothstep(U.uRockSlope, U.uRockSlope.add(0.16), slope.add(macro2.sub(0.5).mul(0.14))).toVar('tWRock');
  const wSnow = smoothstep(U.uSnowLine, U.uSnowLine.add(55.0), positionWorld.y.add(macro.sub(0.5).mul(90.0)).add(fine.sub(0.5).mul(8.0)))
    .mul(float(1.0).sub(smoothstep(0.42, 0.62, slope))).toVar('tWSnow');

  /* ---- albedo ---- */
  const albedo = Fn(() => {
    let grass, dirt, gravel, forest, rock;
    if (hasTex) {
      grass = tSample2(U.tGrass, wxz.mul(U.uGrassScale), tb);
      dirt = tSample2(U.tDirt, wxz.mul(0.28), tb);
      gravel = tSample2(U.tGravel, wxz.mul(0.34), tb);
      forest = tSample2(U.tForest, wxz.mul(0.3), tb);
      const bw = pow(abs(N), vec3(4.0)).toVar();
      bw.divAssign(bw.x.add(bw.y).add(bw.z).add(1e-4));
      const rs = U.uRockScale;
      rock = U.tRock.sample(positionWorld.zy.mul(rs)).rgb.mul(bw.x)
        .add(U.tRock.sample(wxz.mul(rs)).rgb.mul(bw.y))
        .add(U.tRock.sample(positionWorld.xy.mul(rs)).rgb.mul(bw.z))
        // Rock detail at a second scale kills the triplanar repetition.
        .mul(float(0.78).add(U.tRock.sample(wxz.mul(rs).mul(0.19).add(0.3)).g.mul(0.44)));
    } else {
      grass = vec3(0.16, 0.26, 0.08);
      dirt = vec3(0.30, 0.22, 0.14);
      gravel = vec3(0.48, 0.44, 0.36);
      forest = vec3(0.16, 0.12, 0.08);
      rock = vec3(0.34, 0.33, 0.31);
    }

    // Grass colour: lush <-> dry, with macro hue drift.
    const gTint = mix(U.uGrassTint, U.uDryTint, wDry)
      .mul(mix(vec3(0.92, 1.04, 0.9), vec3(1.06, 0.98, 0.9), macro2));
    const col = grass.mul(gTint).toVar();
    col.assign(mix(col, forest, wForest));
    col.assign(mix(col, dirt, wDirt));
    col.assign(mix(col, gravel, wGravel));
    col.assign(mix(col, rock, wRock));
    const snow = vec3(0.86, 0.89, 0.93).mul(float(0.9).add(fine.mul(0.1)));
    col.assign(mix(col, snow, wSnow));

    // Macro brightness: sunlit swathes and cloud-shadow-like patches.
    col.mulAssign(float(0.8).add(macro.mul(0.38)));
    return col;
  })().toVar('tAlbedo');

  mat.colorNode = vec4(albedo, 1.0);

  mat.roughnessNode = Fn(() => {
    const r = float(0.96).toVar();
    r.assign(mix(r, 0.9, wDirt));
    r.assign(mix(r, 0.84, wGravel));
    r.assign(mix(r, 0.78, wRock));
    r.assign(mix(r, 0.55, wSnow));
    return r;
  })();

  // Detail normal: bump from the blended albedo's luminance, strongest on rock
  // and faded out beyond ~60 m (derivative bumps alias at grazing distance).
  const dist = length(positionWorld.sub(cameraPosition));
  const bumpStrength = float(0.35).add(wRock.mul(0.9)).mul(float(1.0).sub(smoothstep(15.0, 60.0, dist)));
  const height = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  mat.normalNode = bumpMap(height, bumpStrength);

  return mat;
}

let _white = null;
function whiteTexture() {
  if (_white) return _white;
  const data = new Uint8Array([255, 255, 255, 255]);
  _white = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  _white.colorSpace = THREE.SRGBColorSpace;
  _white.needsUpdate = true;
  return _white;
}
