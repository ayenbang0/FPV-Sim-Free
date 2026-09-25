/**
 * maps/CanvasMap.js
 * ---------------------------------------------------------------------------
 * Blank Canvas — a flat 400 m field with an eight-gate practice line and
 * nothing else to hit. The practice room: test rates, PIDs and new airframes
 * without scenery getting in the way. (4x the area and twice the ceiling of
 * the old 200 m field.)
 *
 * Day and night variants share one class behind a `variant` option; two thin
 * subclasses keep the MapManager contract of a zero-argument constructor.
 * Both are lit by the physically based sky — night is the same sky with the
 * sun below the horizon, and the gates' LEDs become the brightest thing out.
 */

import * as THREE from 'three/webgpu';
import { MapBuilder } from './MapKit.js';
import { grassTexture } from '../assets/procedural.js';

const SIZE = 400;
const HALF = SIZE / 2;
const BOUND = 190;

export const CANVAS_META = {
  id: 'canvas',
  displayName: 'Blank Canvas (Day)',
  description: 'Empty 400 m field with an eight-gate practice line. Tune, test, repeat.',
  accent: 'linear-gradient(160deg, #7fb2d9 0%, #a9c98a 60%, #6f8f4e 100%)',
  category: 'Practice',
  size: '400 × 400 m',
  gates: 8,
  courseKey: 'canvas.v2',
  outdoor: true,
  ambient: 'field',
};

export const CANVAS_NIGHT_META = {
  id: 'canvas-night',
  displayName: 'Blank Canvas (Night)',
  description: 'The same empty field after dark. Gates glow; everything else is shadow.',
  accent: 'linear-gradient(160deg, #16233f 0%, #0b1224 60%, #04060c 100%)',
  category: 'Practice',
  size: '400 × 400 m',
  gates: 8,
  courseKey: 'canvas-night.v2',
  outdoor: true,
  ambient: 'field',
};

export class CanvasBaseMap {
  constructor({ variant = 'day' } = {}) {
    this.variant = variant === 'night' ? 'night' : 'day';
    this.night = this.variant === 'night';
    this.id = this.night ? 'canvas-night' : 'canvas';
    this.spawnPoint = new THREE.Vector3(0, 0.12, 40);
    this.spawnHeading = 0;
    this.groundLevel = 0;
    this.gates = [];
    this.bounds = {
      min: new THREE.Vector3(-BOUND, -3, -BOUND),
      max: new THREE.Vector3(BOUND, 120, BOUND),
    };
    this.viewDistance = 2400;
    this.link = { range: 700, indoor: false };
    this.environment = this.night
      ? {
        mode: 'outdoor', sunElevation: -9, sunAzimuth: 250, clouds: 0.15,
        exposure: 1.4, hemiIntensity: 0.35, envIntensity: 1.6, fogDensity: 0.0012,
        groundColor: 0x1a2230,
      }
      : { mode: 'outdoor', sunElevation: 44, sunAzimuth: 160, clouds: 0.25, fogDensity: 0.0006 };
    this.builder = null;
  }

  getGroundHeight() {
    return 0;
  }

  *buildSteps(scene, physics) {
    const b = new MapBuilder(scene, physics, { seed: this.night ? 6602 : 6601, name: `${this.id}-map`, streaming: { cellSize: 48 } });
    this.builder = b;

    yield { progress: 0.1, label: 'Field' };
    const tex = b.tex(grassTexture(6610, [140, 140]));
    const mat = b.material('canvas-grass', () => new THREE.MeshStandardMaterial({
      color: tex ? (this.night ? 0x9aa6b8 : 0xffffff) : 0x5e8a3e, map: tex, roughness: 0.96,
    }));
    b.floor({ width: SIZE * 3, depth: SIZE * 3, material: mat });

    // Distance markers every 25 m down the practice line, and a launch pad.
    const lineMat = b.material('canvas-line', () => new THREE.MeshStandardMaterial({ color: 0xeef2f5, roughness: 0.8 }));
    for (let z = 25; z >= -150; z -= 25) {
      b.box({ size: [6, 0.01, 0.2], position: [0, 0.005, z], material: lineMat, collide: false });
    }
    b.box({ size: [1.4, 0.02, 1.4], position: [0, 0.01, 40], material: lineMat, collide: false });

    yield { progress: 0.5, label: 'Gates' };
    // A snaking eight-gate line: two straights, a slalom, a dive, a hairpin.
    const layout = [
      { x: 0, y: 1.6, z: 10 },
      { x: 0, y: 1.6, z: -30 },
      { x: -14, y: 1.6, z: -60 },
      { x: 14, y: 1.6, z: -85 },
      { x: 0, y: 7, z: -115, style: 'dive', w: 2.6, h: 2.6 },
      { x: -20, y: 2.2, z: -140, w: 3, h: 3 },
      { x: -30, y: 1.6, z: -70 },
      { x: -18, y: 1.6, z: 10, w: 3, h: 3 },
    ];
    this.gates = b.course(layout, {
      spawn: { x: this.spawnPoint.x, z: this.spawnPoint.z },
      style: 'square', width: 2.0, beaconHeight: this.night ? 0 : 12,
    });
    for (const [x, z, c] of [[-8, -45, '#ff3d3d'], [8, -72, '#ffd23f'], [-26, -110, '#2fd8ff']]) {
      b.flag({ position: [x, 0, z], color: c, height: 3.2 });
    }

    if (this.night) {
      // A couple of pit lamps near the launch pad; the rest is gate glow.
      for (const x of [-6, 6]) {
        b.box({ size: [0.12, 4, 0.12], position: [x, 2, 46], material: lineMat });
        const l = new THREE.PointLight(0xffe2b8, 60, 40, 2);
        l.position.set(x, 4, 46);
        b.addLight(l);
      }
    }
    b.finalizeShadows({ castMinRadius: 0.3 });
    yield { progress: 1, label: 'Ready' };
  }

  dispose(scene, physics) {
    if (this.builder) this.builder.dispose(scene, physics);
    this.builder = null;
    this.gates = [];
  }
}

export class CanvasMap extends CanvasBaseMap {
  constructor() { super({ variant: 'day' }); }
}

export class CanvasNightMap extends CanvasBaseMap {
  constructor() { super({ variant: 'night' }); }
}
