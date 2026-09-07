/**
 * core/MapManager.js
 * ---------------------------------------------------------------------------
 * Owns exactly one active map at a time and guarantees a clean handover
 * between them.
 *
 * Every map module implements the same small interface:
 *
 *   buildSteps(scene, physics)  generator — yields progress 0..1 as it works
 *   dispose(scene, physics)     tears down everything it created
 *   spawnPoint / spawnHeading   where the quad starts
 *   bounds                      { min, max } world-space limits
 *   gates                       ordered race gates (may be empty)
 *
 * Two things make this worth a dedicated class:
 *
 * 1. **Leaks.** Three.js does not garbage-collect GPU resources. A geometry,
 *    material, or texture that is merely dropped from the scene graph keeps
 *    its VRAM until `.dispose()` is called. Switching maps a dozen times
 *    without explicit disposal is a reliable way to exhaust GPU memory and get
 *    a context loss — which reads to the user as "the app crashed".
 *
 * 2. **Jank.** Building the warehouse means thousands of primitives. Doing it
 *    inside one frame locks the tab for a second or more. `buildSteps` is a
 *    generator, and this class pumps it against a per-frame time budget, so the
 *    loading screen actually animates and the browser stays responsive.
 *
 * If a map build throws part-way through, we tear down whatever it managed to
 * create and fall back to a minimal but flyable "void" map rather than leaving
 * the simulator in a half-built state.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from './PhysicsWorld.js';

/** Milliseconds of build work per frame. ~8 ms leaves room for a 60 fps tick. */
const BUILD_BUDGET_MS = 8;

export class MapManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;

    this._registry = new Map();
    this.current = null;
    this.currentId = null;
    this.loading = false;

    /** (progress: 0..1, label: string) => void */
    this.onProgress = null;
    /** (level, message) => void — surfaced as toasts */
    this.onNotice = null;
  }

  /* ====================================================================== *
   * Registry
   * ====================================================================== */

  /**
   * @param {{ id:string, displayName:string, description:string, accent:string }} meta
   * @param {Function} Ctor map class
   */
  register(meta, Ctor) {
    this._registry.set(meta.id, { meta, Ctor });
  }

  get available() {
    return Array.from(this._registry.values()).map((e) => e.meta);
  }

  getMeta(id) {
    return this._registry.get(id)?.meta ?? null;
  }

  /* ====================================================================== *
   * Loading
   * ====================================================================== */

  /**
   * Dispose the current map and build `id` in its place, spreading the work
   * across frames. Resolves with the new map instance (or the fallback).
   */
  async load(id) {
    if (this.loading) return this.current;
    const entry = this._registry.get(id);
    if (!entry) {
      this._notice('danger', `Unknown map "${id}".`);
      return this.current;
    }

    this.loading = true;
    this._progress(0, 'Clearing');

    try {
      this.disposeCurrent();

      const map = new entry.Ctor();
      let built = false;

      try {
        built = await this._pump(map.buildSteps(this.scene, this.physics));
      } catch (err) {
        console.error(`[MapManager] "${id}" failed to build.`, err);
        built = false;
      }

      if (!built) {
        // Partial build: remove whatever landed, then fall back.
        try { map.dispose(this.scene, this.physics); } catch (_e) { /* ignore */ }
        this._notice('danger', 'Map failed to build — loaded a fallback environment.');
        this.current = buildFallbackMap(this.scene, this.physics);
        this.currentId = id;
        this._progress(1, 'Ready');
        return this.current;
      }

      this.current = map;
      this.currentId = id;
      this._progress(1, 'Ready');
      return map;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Drive a build generator against a wall-clock budget, yielding to the
   * browser between chunks so the loading bar paints and input stays live.
   */
  async _pump(iterator) {
    if (!iterator || typeof iterator.next !== 'function') return false;

    let guard = 0;
    for (;;) {
      const deadline = nowMs() + BUILD_BUDGET_MS;
      let progress = 0;
      let label = '';

      while (nowMs() < deadline) {
        const step = iterator.next();
        if (step.done) {
          this._progress(1, 'Ready');
          return true;
        }
        const v = step.value;
        if (typeof v === 'number') progress = v;
        else if (v && typeof v === 'object') {
          if (Number.isFinite(v.progress)) progress = v.progress;
          if (typeof v.label === 'string') label = v.label;
        }

        // A generator that never finishes would hang the app; bail out loudly.
        if (++guard > 500000) {
          console.error('[MapManager] build generator exceeded its step budget.');
          return false;
        }
      }

      this._progress(progress, label);
      await nextFrame();
    }
  }

  /**
   * Remove the active map completely: scene nodes, GPU resources, and every
   * physics body it registered.
   */
  disposeCurrent() {
    if (this.current) {
      try {
        this.current.dispose(this.scene, this.physics);
      } catch (err) {
        console.warn('[MapManager] map dispose threw; continuing teardown.', err);
      }
    }
    this.current = null;
    this.currentId = null;

    // Belt and braces: drop any body the map forgot, keeping the drone.
    const keep = [];
    for (const body of this.physics.trackedBodies) {
      if (body.isDrone) keep.push(body);
    }
    this.physics.clearTrackedBodies(keep);
  }

  /** Animated map elements (flickering lights, drifting dust, water shimmer). */
  update(dt, elapsed) {
    if (!this.current || typeof this.current.update !== 'function') return;
    try {
      this.current.update(dt, elapsed);
    } catch (err) {
      // An animation bug must not take the frame down. Disable it and move on.
      console.warn('[MapManager] map update threw; animation disabled.', err);
      this.current.update = null;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Convenience accessors used by main.js
   * ---------------------------------------------------------------------- */

  get spawnPoint() {
    return this.current?.spawnPoint ?? new THREE.Vector3(0, 1.5, 0);
  }

  get spawnHeading() {
    return this.current?.spawnHeading ?? 0;
  }

  get groundLevel() {
    return this.current?.groundLevel ?? 0;
  }

  get bounds() {
    return this.current?.bounds ?? null;
  }

  get gates() {
    return this.current?.gates ?? [];
  }

  /** True when the position has left the playable volume. */
  isOutOfBounds(position) {
    const b = this.bounds;
    if (!b || !position) return false;
    return (
      position.x < b.min.x || position.x > b.max.x ||
      position.y < b.min.y || position.y > b.max.y ||
      position.z < b.min.z || position.z > b.max.z
    );
  }

  _progress(value, label) {
    if (typeof this.onProgress === 'function') {
      try { this.onProgress(clamp01(value), label || ''); } catch (_e) { /* ignore */ }
    }
  }

  _notice(level, message) {
    if (typeof this.onNotice === 'function') {
      try { this.onNotice(level, message); } catch (_e) { /* ignore */ }
    }
  }
}

/* ========================================================================== *
 * Fallback map
 * ========================================================================== */

/**
 * The absolute minimum flyable environment: a lit ground plane inside a box of
 * bounds. Used when a real map fails to build, so the simulator degrades to
 * "less interesting" rather than "broken".
 */
function buildFallbackMap(scene, physics) {
  const group = new THREE.Group();
  group.name = 'fallback-map';

  const geo = new THREE.PlaneGeometry(200, 200);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3b4a3f, roughness: 1 });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = false;
  group.add(ground);

  const hemi = new THREE.HemisphereLight(0x9fc4e8, 0x3a4038, 1.6);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(40, 60, 20);
  group.add(sun);

  scene.add(group);
  scene.background = new THREE.Color(0x8fb3cc);
  scene.fog = null;

  // Static collider for the ground: an infinite cannon plane, rotated from
  // its default +Z normal up to +Y.
  const body = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    material: physics.hardMaterial,
    collisionFilterGroup: GROUP.WORLD,
    collisionFilterMask: GROUP.DRONE,
  });
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  physics.addBody(body);

  return {
    id: 'fallback',
    spawnPoint: new THREE.Vector3(0, 1.5, 0),
    spawnHeading: 0,
    groundLevel: 0,
    gates: [],
    bounds: {
      min: new THREE.Vector3(-100, -5, -100),
      max: new THREE.Vector3(100, 120, 100),
    },
    dispose(s, p) {
      s.remove(group);
      geo.dispose();
      mat.dispose();
      if (body) p.removeBody(body);
      s.background = null;
      s.fog = null;
    },
  };
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function nowMs() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

function clamp01(v) {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}
