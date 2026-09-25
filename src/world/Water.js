/**
 * world/Water.js
 * ---------------------------------------------------------------------------
 * Open water as three's WaterMesh (TSL): a planar reflection of the scene
 * (a half-resolution reflector render), distorted by four octaves of scrolling
 * ripple normals, with a Fresnel blend toward a scattering colour, a sun
 * glint and a soft diffuse term. It reflects the real sky, trees and gates
 * rather than a blurred environment map, which is what sells a lake from a
 * few metres up.
 *
 * The sun direction and colour are bound by reference to render/SunState.js,
 * so the glint follows the time-of-day slider.
 */

import * as THREE from 'three/webgpu';
import { WaterMesh } from 'three/examples/jsm/objects/WaterMesh.js';
import { sunState } from '../render/SunState.js';

let _flat = null;
/** 1×1 flat normal, for headless builds where the canvas texture is unavailable. */
function flatNormal() {
  if (_flat) return _flat;
  _flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
  _flat.wrapS = _flat.wrapT = THREE.RepeatWrapping;
  _flat.needsUpdate = true;
  return _flat;
}

/**
 * @param {THREE.BufferGeometry} geometry  flat in local XY (rotated flat by the caller)
 * @param {object} o
 * @param {THREE.Texture|null} o.normals   tileable ripple normal map
 * @param {number} o.waterColor            scattering colour (hex)
 * @param {number} [o.size]                ripple frequency multiplier
 * @param {number} [o.distortion]          reflection distortion strength
 * @param {number} [o.alpha]
 */
export function createWater(geometry, { normals, waterColor, size = 6, distortion = 3.7, alpha = 0.92 }) {
  const tex = normals || flatNormal();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const water = new WaterMesh(geometry, {
    waterNormals: tex,
    sunDirection: sunState.direction,
    sunColor: 0xffffff,
    waterColor,
    distortionScale: distortion,
    size,
    alpha,
    resolutionScale: 0.5,
  });
  // Bind the live sun colour (the constructor copies the hex into its own Color).
  water.sunColor.value = sunState.color;
  water.name = 'water';
  return water;
}
