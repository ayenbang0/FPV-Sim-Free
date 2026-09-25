/**
 * render/Quality.js
 * ---------------------------------------------------------------------------
 * Graphics quality tiers.
 *
 * Every expensive system in the world renderer — shadow resolution, grass
 * density, tree draw distance, terrain detail, post effects — reads its budget
 * from one of these presets instead of hard-coding a number. That keeps the big
 * outdoor maps flyable on integrated graphics (an Iris Xe laptop is the
 * reference low end) while a discrete GPU gets dense meadows and long views.
 *
 * `auto` resolves once at boot from the GPU adapter (see detectQualityTier):
 * software adapters start on `low`, older integrated parts on `medium`,
 * everything else on `high`. Adaptive quality in main.js still walks the pixel
 * ratio down on top of whichever tier is set, then sheds GTAO and TRAA.
 *
 * Post-processing budget per tier (see render/PostStack.js):
 *
 *   field        low     medium          high    ultra
 *   gtao         false   true (half res) true    true
 *   ssr          false   false           false   true
 *   aa           smaa    smaa            traa    traa
 *   lensflare    false   true            true    true
 *   csmCascades  0       2               3       4
 *   cubeFaceSize 384     512             768     1024
 *   godrays      false   false           true    true
 */

export const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];

export const QUALITY_PRESETS = {
  low: {
    label: 'Low — integrated GPUs, max framerate',
    anisotropy: 2,
    pixelRatioCap: 1.0,
    shadowMapSize: 1024,
    shadowRange: 42,
    shadowRadius: 1.5,
    grassDensity: 0.45,
    grassRange: 38,
    treeLod0: 70,
    treeLod1: 260,
    treeDrawDistance: 1100,
    terrainLodScale: 0.7,
    envMapSize: 128,
    viewDistance: 2600,
    detailProps: 0.5,
    gtao: false,
    gtaoHalfRes: false,
    ssr: false,
    aa: 'smaa',
    lensflare: false,
    csmCascades: 0,
    cubeFaceSize: 384,
    godrays: false,
  },
  medium: {
    label: 'Medium — balanced',
    anisotropy: 4,
    pixelRatioCap: 1.25,
    shadowMapSize: 2048,
    shadowRange: 60,
    shadowRadius: 2.0,
    grassDensity: 0.75,
    grassRange: 52,
    treeLod0: 110,
    treeLod1: 380,
    treeDrawDistance: 1700,
    terrainLodScale: 1.0,
    envMapSize: 256,
    viewDistance: 3600,
    detailProps: 0.8,
    gtao: true,
    gtaoHalfRes: true,
    ssr: false,
    aa: 'smaa',
    lensflare: true,
    csmCascades: 2,
    cubeFaceSize: 512,
    godrays: false,
  },
  high: {
    label: 'High — discrete GPUs',
    anisotropy: 8,
    pixelRatioCap: 1.5,
    shadowMapSize: 4096,
    shadowRange: 85,
    shadowRadius: 2.5,
    grassDensity: 1.0,
    grassRange: 70,
    treeLod0: 170,
    treeLod1: 560,
    treeDrawDistance: 2600,
    terrainLodScale: 1.4,
    envMapSize: 256,
    viewDistance: 5200,
    detailProps: 1.0,
    gtao: true,
    gtaoHalfRes: false,
    ssr: false,
    aa: 'traa',
    lensflare: true,
    csmCascades: 3,
    cubeFaceSize: 768,
    godrays: true,
  },
  ultra: {
    label: 'Ultra — high-end GPUs',
    anisotropy: 16,
    pixelRatioCap: 2.0,
    shadowMapSize: 4096,
    shadowRange: 110,
    shadowRadius: 3.0,
    grassDensity: 1.45,
    grassRange: 95,
    treeLod0: 240,
    treeLod1: 800,
    treeDrawDistance: 3600,
    terrainLodScale: 2.0,
    envMapSize: 512,
    viewDistance: 7000,
    detailProps: 1.0,
    gtao: true,
    gtaoHalfRes: false,
    ssr: true,
    aa: 'traa',
    lensflare: true,
    csmCascades: 4,
    cubeFaceSize: 1024,
    godrays: true,
  },
};

let _detectedTier = null;

/**
 * Guess a sensible starting tier from the GPU the browser reports. Async,
 * because the WebGPU adapter description is only available from
 * `navigator.gpu.requestAdapter()`.
 *
 *   WebGPU backend:  the adapter info (vendor, architecture, description) of
 *                    the renderer's device (`device.adapterInfo`).
 *                    A software/fallback adapter is `low`; Intel or Apple
 *                    parts whose architecture reads gen-9/11/12 or M1 are
 *                    `medium`; anything else is `high`.
 *   WebGL backend:   the unmasked renderer string from
 *                    WEBGL_debug_renderer_info, through `renderer.backend.gl`.
 *
 * Any error — no adapter, a privacy mode that strips the strings — is
 * `medium`, the safe middle.
 */
export async function detectQualityTier(renderer) {
  if (_detectedTier) return _detectedTier;
  let tier = 'medium';
  try {
    const backend = renderer?.backend;
    if (backend?.isWebGPUBackend === true && typeof navigator !== 'undefined' && navigator.gpu) {
      // Prefer the renderer's own device: requesting a second adapter can
      // invalidate the first on some Chrome builds (a spurious device loss).
      let info = backend.device?.adapterInfo || null;
      let fallback = info?.isFallbackAdapter === true;
      if (!info) {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('no WebGPU adapter');
        info = adapter.info || {};
        fallback = adapter.isFallbackAdapter === true || info.isFallbackAdapter === true;
      }
      const vendor = String(info?.vendor || '').toLowerCase();
      const arch = String(info?.architecture || '').toLowerCase();
      const desc = String(info?.description || '').toLowerCase();
      if (fallback || /swiftshader|llvmpipe|software|microsoft basic/.test(`${vendor} ${arch} ${desc}`)) {
        tier = 'low';
      } else if (/intel|apple/.test(vendor) && /gen-?(9|11|12)|m1$/i.test(arch)) {
        tier = 'medium';
      } else {
        tier = 'high';
      }
    } else {
      const gl = backend?.gl || renderer?.getContext?.();
      const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '').toLowerCase();
      if (!name) tier = 'medium';
      else if (/swiftshader|llvmpipe|software|microsoft basic/.test(name)) tier = 'low';
      else if (/intel|iris|uhd|hd graphics|mali|adreno|powervr|apple gpu|videocore/.test(name)) tier = 'medium';
      else tier = 'high';
    }
  } catch (_e) {
    tier = 'medium';
  }
  _detectedTier = tier;
  return tier;
}

/** The tier `auto` resolved to at boot (null before detection has run). */
export function detectedQualityTier() {
  return _detectedTier;
}

/** Resolve a stored setting ('auto' | tier) into a concrete preset object. */
export function resolveQuality(setting) {
  const tier = QUALITY_TIERS.includes(setting) ? setting : (_detectedTier || 'medium');
  return { tier, ...QUALITY_PRESETS[tier] };
}

/**
 * The currently active preset, shared by every world system. main.js writes it
 * whenever the setting changes; builders read it when they allocate.
 */
export const activeQuality = { tier: 'medium', ...QUALITY_PRESETS.medium };

export function setActiveQuality(preset) {
  Object.assign(activeQuality, preset);
  return activeQuality;
}
