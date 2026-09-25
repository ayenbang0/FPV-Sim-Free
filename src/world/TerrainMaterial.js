/**
 * world/TerrainMaterial.js
 * ---------------------------------------------------------------------------
 * The ground shader: a MeshStandardMaterial (so it keeps three's lighting,
 * shadows, fog and image-based lighting) with its albedo and roughness
 * replaced by a per-fragment blend of surface types.
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
 */

import * as THREE from 'three';
import { GLSL_NOISE } from './Noise.js';

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

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0,
  });
  mat.name = 'TerrainMaterial';

  const white = whiteTexture();
  const uniforms = {
    tSplat: { value: terrain.splatTexture() },
    tGrass: { value: textures.grass || white },
    tDirt: { value: textures.dirt || white },
    tRock: { value: textures.rock || white },
    tGravel: { value: textures.gravel || white },
    tForest: { value: textures.forest || white },
    uHasTex: { value: textures.grass ? 1 : 0 },
    uRect: { value: new THREE.Vector4(-terrain.half, -terrain.half, terrain.size, terrain.size) },
    uGrassTint: { value: new THREE.Color(L.grassTint) },
    uDryTint: { value: new THREE.Color(L.dryTint) },
    uSnowLine: { value: L.snowLine },
    uRockSlope: { value: L.rockSlope },
    uRockScale: { value: L.rockScale },
    uGrassScale: { value: L.grassScale },
    uLush: { value: L.lushness },
  };
  mat.userData.terrainUniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n' +
        'vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' +
        'vTNormal = normalize(mat3(modelMatrix) * objectNormal);',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTWorld;
        varying vec3 vTNormal;
        uniform sampler2D tSplat;
        uniform sampler2D tGrass;
        uniform sampler2D tDirt;
        uniform sampler2D tRock;
        uniform sampler2D tGravel;
        uniform sampler2D tForest;
        uniform float uHasTex;
        uniform vec4 uRect;
        uniform vec3 uGrassTint;
        uniform vec3 uDryTint;
        uniform float uSnowLine;
        uniform float uRockSlope;
        uniform float uRockScale;
        uniform float uGrassScale;
        uniform float uLush;
        ${GLSL_NOISE}
        vec3 tSample2(sampler2D t, vec2 uv, float blend) {
          vec3 a = texture2D(t, uv).rgb;
          vec2 r = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.431 + vec2(0.37, 0.71);
          vec3 b = texture2D(t, r).rgb;
          return mix(a, b, blend);
        }
        float fpvTerrainRough;
      `)
      .replace('#include <map_fragment>', `
        {
          vec2 wxz = vTWorld.xz;
          vec3 N = normalize(vTNormal);
          vec4 sp = texture2D(tSplat, (wxz - uRect.xy) / uRect.zw);
          float slope = 1.0 - clamp(N.y, 0.0, 1.0);
          float macro = fpvFbm(wxz * 0.0045);
          float macro2 = fpvFbm(wxz * 0.023 + 17.0);
          float fine = fpvNoise(wxz * 0.9);
          float tb = smoothstep(0.25, 0.75, fpvNoise(wxz * 0.045 + 3.0));

          // Edges of painted regions: break the splat's texel grid with noise.
          float edgeN = (fpvNoise(wxz * 0.6) - 0.5) * 0.45 + (fine - 0.5) * 0.2;
          float wDirt = smoothstep(0.30, 0.70, sp.r + edgeN);
          float wDry = clamp(sp.g + (macro - 0.5) * 0.9 * (1.0 - uLush) + (macro2 - 0.5) * 0.25, 0.0, 1.0);
          float wGravel = smoothstep(0.30, 0.70, sp.b + edgeN);
          float wForest = smoothstep(0.25, 0.75, sp.a + edgeN * 0.8);
          float wRock = smoothstep(uRockSlope, uRockSlope + 0.16, slope + (macro2 - 0.5) * 0.14);
          float wSnow = smoothstep(uSnowLine, uSnowLine + 55.0, vTWorld.y + (macro - 0.5) * 90.0 + (fine - 0.5) * 8.0)
                      * (1.0 - smoothstep(0.42, 0.62, slope));

          vec3 grass, dirt, gravel, forest, rock;
          if (uHasTex > 0.5) {
            grass = tSample2(tGrass, wxz * uGrassScale, tb);
            dirt = tSample2(tDirt, wxz * 0.28, tb);
            gravel = tSample2(tGravel, wxz * 0.34, tb);
            forest = tSample2(tForest, wxz * 0.3, tb);
            vec3 bw = pow(abs(N), vec3(4.0));
            bw /= (bw.x + bw.y + bw.z + 1e-4);
            rock = texture2D(tRock, vTWorld.zy * uRockScale).rgb * bw.x
                 + texture2D(tRock, wxz * uRockScale).rgb * bw.y
                 + texture2D(tRock, vTWorld.xy * uRockScale).rgb * bw.z;
            // Rock detail at a second scale kills the triplanar repetition.
            rock *= 0.78 + 0.44 * texture2D(tRock, wxz * uRockScale * 0.19 + 0.3).g;
          } else {
            grass = vec3(0.16, 0.26, 0.08);
            dirt = vec3(0.30, 0.22, 0.14);
            gravel = vec3(0.48, 0.44, 0.36);
            forest = vec3(0.16, 0.12, 0.08);
            rock = vec3(0.34, 0.33, 0.31);
          }

          // Grass colour: lush <-> dry, with macro hue drift.
          vec3 gTint = mix(uGrassTint, uDryTint, wDry);
          gTint *= mix(vec3(0.92, 1.04, 0.9), vec3(1.06, 0.98, 0.9), macro2);
          vec3 col = grass * gTint;
          col = mix(col, forest, wForest);
          col = mix(col, dirt, wDirt);
          col = mix(col, gravel, wGravel);
          col = mix(col, rock, wRock);
          vec3 snow = vec3(0.86, 0.89, 0.93) * (0.9 + 0.1 * fine);
          col = mix(col, snow, wSnow);

          // Macro brightness: sunlit swathes and cloud-shadow-like patches.
          col *= 0.8 + 0.38 * macro;

          diffuseColor.rgb *= col;

          fpvTerrainRough = 0.96;
          fpvTerrainRough = mix(fpvTerrainRough, 0.9, wDirt);
          fpvTerrainRough = mix(fpvTerrainRough, 0.84, wGravel);
          fpvTerrainRough = mix(fpvTerrainRough, 0.78, wRock);
          fpvTerrainRough = mix(fpvTerrainRough, 0.55, wSnow);
        }
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = fpvTerrainRough;
      `);
  };

  // Distinct program cache key so the injected shader is not shared with plain
  // standard materials.
  mat.customProgramCacheKey = () => 'fpv-terrain-v1';
  return mat;
}

let _white = null;
function whiteTexture() {
  if (_white) return _white;
  const data = new Uint8Array([255, 255, 255, 255]);
  _white = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  _white.needsUpdate = true;
  return _white;
}
