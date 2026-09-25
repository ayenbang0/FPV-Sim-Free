/**
 * render/SunState.js
 * ---------------------------------------------------------------------------
 * The current sun, shared by reference. Atmosphere writes it whenever the sun
 * moves or recolours; materials that need it (WaterMesh's glint and diffuse
 * terms) bind these exact objects as uniform values, so they follow the sun
 * with no per-frame plumbing and no import cycle through Atmosphere.
 */

import * as THREE from 'three/webgpu';

export const sunState = {
  /** Unit vector toward the sun, world space. */
  direction: new THREE.Vector3(0.4, 0.6, 0.4).normalize(),
  /** Linear sun colour, scaled to roughly unit brightness. */
  color: new THREE.Color(1, 0.97, 0.92),
};
