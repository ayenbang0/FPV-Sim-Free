/**
 * render/webgpuCompat.js
 * ---------------------------------------------------------------------------
 * Small shims that let three's WebGPU backend run on browsers that ship an
 * older draft of a WebGPU interface. Each shim is a no-op where the browser
 * already matches the spec three targets.
 *
 *   swizzle   three r185 writes `swizzle: 'rgba'` (the identity, i.e. the
 *             default) into every GPUTextureViewDescriptor. Chrome builds that
 *             shipped the earlier texture-component-swizzle draft type the
 *             field as a dictionary and reject the string, which fails every
 *             render pass. Dropping the identity value is exactly equivalent.
 */

let installed = false;

export function installWebGpuCompat() {
  if (installed) return;
  installed = true;
  try {
    if (typeof GPUTexture === 'undefined' || typeof GPUTexture.prototype.createView !== 'function') return;
    const createView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function createViewCompat(descriptor) {
      if (descriptor && descriptor.swizzle === 'rgba') {
        const copy = Object.assign({}, descriptor);
        delete copy.swizzle;
        return createView.call(this, copy);
      }
      return createView.call(this, descriptor);
    };
  } catch (_e) { /* leave the browser's implementation alone */ }
}
