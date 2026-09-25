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
 * `auto` resolves once at boot from the WebGL renderer string: integrated and
 * mobile GPUs start on `medium`, everything else on `high`. Adaptive quality
 * in main.js still walks the pixel ratio down on top of whichever tier is set.
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
    antialias: false,
    detailProps: 0.5,
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
    antialias: true,
    detailProps: 0.8,
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
    antialias: true,
    detailProps: 1.0,
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
    antialias: true,
    detailProps: 1.0,
  },
};

let _detectedTier = null;

/**
 * Guess a sensible starting tier from the GPU the browser reports. Wrapped:
 * the debug-renderer extension is optional and some privacy modes strip it,
 * in which case `medium` is the safe middle.
 */
export function detectQualityTier(renderer) {
  if (_detectedTier) return _detectedTier;
  let tier = 'medium';
  try {
    const gl = renderer?.getContext?.();
    const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '').toLowerCase();
    if (!name) tier = 'medium';
    else if (/swiftshader|llvmpipe|software|microsoft basic/.test(name)) tier = 'low';
    else if (/intel|iris|uhd|hd graphics|mali|adreno|powervr|apple gpu|videocore/.test(name)) tier = 'medium';
    else if (/rtx|radeon rx|rx [5-9]\d{3}|gtx 1[06-9]|gtx 16|arc a/.test(name)) tier = 'high';
    else tier = 'high';
  } catch (_e) {
    tier = 'medium';
  }
  _detectedTier = tier;
  return tier;
}

/** Resolve a stored setting ('auto' | tier) into a concrete preset object. */
export function resolveQuality(setting, renderer) {
  const tier = QUALITY_TIERS.includes(setting) ? setting : detectQualityTier(renderer);
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
