/**
 * core/CameraRig.js
 * ---------------------------------------------------------------------------
 * The FPV camera and its two alternates, plus the optional analog-goggle
 * post-process.
 *
 * The important detail here is that the camera does **not** rigidly follow the
 * airframe. A real FPV feed reaches your eyes through a camera sensor, an
 * analog transmitter, and a pair of goggles, and the composite result lags the
 * frame by a few milliseconds. Copying the quaternion 1:1 looks subtly wrong
 * and — because a 600 deg/s roll then snaps the whole world around instantly —
 * is a reliable way to make people motion-sick.
 *
 * So orientation is slerped toward the frame with an exponential (critically
 * damped) response, while *position* is copied exactly. Lagging the position
 * too would let the camera drift through walls during hard manoeuvres.
 *
 * Camera modes, cycled with `C`:
 *   fpv       — the real thing: on the frame, uptilted, narrow near-plane
 *   chase     — third-person, smoothed, useful for learning orientation
 *   cinematic — wide, heavily damped, and runs the sim at half speed
 */

import * as THREE from 'three';
import { settings } from './Settings.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';

export const CAMERA_MODES = ['fpv', 'chase', 'cinematic'];

const MODE_LABELS = { fpv: 'FPV', chase: 'CHASE', cinematic: 'CINEMATIC' };

/**
 * Where the camera sits on the frame: slightly forward of, and above, centre.
 * Scaled per airframe — a 65 mm whoop's camera is 1.6 cm up, a 5"'s is 3.5 cm,
 * and getting this wrong makes gap judgement feel subtly off.
 */
const DEFAULT_MOUNT = new THREE.Vector3(0, 0.035, -0.03);

export class CameraRig {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(
      settings.get('fov'),
      1,
      0.04,     // tight near plane — the quad flies through 40 cm gaps
      1800,     // replaced per map by setViewDistance()
    );
    this.camera.position.set(0, 2, 4);

    this.mode = 'fpv';

    /* ---- smoothed state ---- */
    this._targetQuat = new THREE.Quaternion();
    this._smoothQuat = new THREE.Quaternion();
    this._chasePos = new THREE.Vector3(0, 2, 4);
    this._lookTarget = new THREE.Vector3();
    this._desired = new THREE.Vector3();

    /* ---- shake ---- */
    this._shakeTime = 0;
    this._shakeQuat = new THREE.Quaternion();
    this._shakeEuler = new THREE.Euler();

    /* ---- scratch ---- */
    this._tiltQuat = new THREE.Quaternion();
    this._mount = DEFAULT_MOUNT.clone();
    // Chase/cinematic standoff scales with the airframe: 2.1 m frames a 5"
    // quad nicely and makes a 75 mm whoop a speck. 1.0 = the 5" reference.
    this._rigScale = 1;
    this._tmpQuat = new THREE.Quaternion();
    this._tmpVec = new THREE.Vector3();

    /* ---- post-processing (built lazily) ---- */
    this._composer = null;
    this._crtPass = null;
    this._bloomPass = null;
    this._afterPass = null;
    this._composerFailed = false;
    this._fxKey = null;   // rebuild key: bloom|blur|crt — see render()
    this._size = { w: 1, h: 1 };

    /* ---- FPV latency queue (pose history for a lagged goggle feed) ---- */
    this._poseQ = [];

    /* ---- link quality, 0..1, drives VTX breakup in the CRT shader ---- */
    this.rssi = 1;
    // Video-link profile for the current map: `range` is the distance (m) at
    // which the picture is half-quality; `indoor` adds multipath flicker.
    // A 400 mW analog VTX holds a clean picture for hundreds of metres in the
    // open but loses it behind a few concrete walls — so the map decides.
    this._link = { range: 60, indoor: true };
    /* ---- dynamic weather state (consumed by physics/audio via `weather`) ---- */
    this.weather = { dim: 0, gust: 0 };
    this._weatherT = Math.random() * 100;
    this._envLights = null;
    this._envSceneSize = -1;
    this._lastWeatherQ = -1;

    this.applySettings();
  }

  /**
   * Scale the third-person cameras to the airframe.
   *
   * `bodyWidth` is the collider's full width in metres, against a 0.20 m
   * reference (the 5" freestyle). Clamped at the bottom so a micro does not put
   * the camera inside its own props, and at the top so nothing drifts absurdly
   * far out.
   */
  setRigScale(bodyWidth) {
    const w = Number.isFinite(bodyWidth) && bodyWidth > 0 ? bodyWidth : 0.20;
    this._rigScale = Math.min(1.6, Math.max(0.34, w / 0.20));
  }

  /** Far clip plane for the current map (metres). */
  setViewDistance(far) {
    if (!Number.isFinite(far) || far <= 10) return;
    if (Math.abs(this.camera.far - far) < 1) return;
    this.camera.far = far;
    // A slightly deeper near plane keeps depth precision on kilometre maps;
    // the tight 4 cm plane only matters indoors.
    this.camera.near = far > 1500 ? 0.06 : 0.04;
    this.camera.updateProjectionMatrix();
  }

  /** Video-link profile for the current map: { range, indoor }. */
  setLinkProfile(profile) {
    const range = Number.isFinite(profile?.range) && profile.range > 5 ? profile.range : 60;
    this._link = { range, indoor: profile ? !!profile.indoor : true };
  }

  /** Adopt the active airframe's camera mount position. */
  setMount(offset) {
    if (Array.isArray(offset) && offset.every(Number.isFinite)) {
      this._mount.set(offset[0], offset[1], offset[2]);
    } else {
      this._mount.copy(DEFAULT_MOUNT);
    }
  }

  /** Sync FOV and tilt from the settings store. */
  applySettings() {
    const fov = settings.get('fov');
    if (Number.isFinite(fov) && Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const tilt = settings.get('cameraTilt') * Math.PI / 180;
    // Positive rotation about local +X lifts the view direction, which is
    // exactly what raising the camera mount on a real quad does.
    this._tiltQuat.setFromAxisAngle(UNIT_X, tilt);
  }

  /* ====================================================================== *
   * Modes
   * ====================================================================== */

  setMode(mode) {
    if (!CAMERA_MODES.includes(mode)) return;
    this.mode = mode;
  }

  cycleMode() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  get modeLabel() {
    return MODE_LABELS[this.mode] || 'FPV';
  }

  /** main.js multiplies its frame delta by this — cinematic runs at half speed. */
  get timeScale() {
    return this.mode === 'cinematic' ? 0.5 : 1;
  }

  /** The drone body should only be drawn when we are not looking through it. */
  get showsDroneBody() {
    return this.mode !== 'fpv';
  }

  /* ====================================================================== *
   * Per-frame update
   * ====================================================================== */

  /**
   * @param {number} dt          render delta (seconds, already clamped)
   * @param {THREE.Vector3} pos  interpolated drone position
   * @param {THREE.Quaternion} quat interpolated drone orientation
   * @param {object} drone       DroneController, for shake inputs
   */
  update(dt, pos, quat, drone) {
    this.applySettings();
    this._updateRssi(pos, drone);
    this._tickWeather(dt);
    this._lastDrone = drone || null;

    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;

    if (this.mode === 'fpv') this._updateFpv(step, pos, quat, drone);
    else if (this.mode === 'chase') this._updateChase(step, pos, quat);
    else this._updateCinematic(step, pos, quat);

    this._applyShake(step, drone);

    // A NaN in the camera transform blanks the screen without throwing, which
    // looks exactly like a crash to the user. Cheap insurance.
    if (!isFiniteVector(this.camera.position)) this.camera.position.copy(pos);
    if (!isFiniteQuaternion(this.camera.quaternion)) this.camera.quaternion.copy(quat);
  }

  _updateFpv(dt, pos, quat, drone) {
    // Position: exact. Mount offset rotated into the frame's orientation.
    this._tmpVec.copy(this._mount).applyQuaternion(quat);
    this.camera.position.copy(pos).add(this._tmpVec);

    // Orientation: frame orientation plus the fixed camera uptilt...
    this._targetQuat.copy(quat).multiply(this._tiltQuat);

    // ...then softened. `1 - e^(-k·dt)` is a frame-rate-independent
    // exponential approach: the same physical response whether we are running
    // at 60 or 240 fps, unlike a raw `slerp(target, 0.2)`.
    const smoothing = settings.get('cameraSmoothing');
    const k = 90 * (1 - smoothing * 0.86);
    const alpha = 1 - Math.exp(-k * dt);

    this._smoothQuat.slerp(this._targetQuat, clamp01(alpha));
    if (!isFiniteQuaternion(this._smoothQuat)) this._smoothQuat.copy(this._targetQuat);
    this.camera.quaternion.copy(this._smoothQuat);

    this._applyFpvLatency();
    this._applyJello(drone);
  }

  _updateChase(dt, pos, quat) {
    // Sit behind and above the frame, but only follow its *heading*, not its
    // roll — a chase cam that barrel-rolls with the quad is unusable.
    const heading = headingOf(quat, this._tmpQuat);
    this._desired.set(0, 0.55 * this._rigScale, 2.1 * this._rigScale)
      .applyQuaternion(heading).add(pos);

    const alpha = 1 - Math.exp(-6 * dt);
    this._chasePos.lerp(this._desired, clamp01(alpha));
    if (!isFiniteVector(this._chasePos)) this._chasePos.copy(this._desired);

    this.camera.position.copy(this._chasePos);

    this._lookTarget.lerp(pos, clamp01(1 - Math.exp(-12 * dt)));
    if (!isFiniteVector(this._lookTarget)) this._lookTarget.copy(pos);
    this.camera.lookAt(this._lookTarget);
    this._smoothQuat.copy(this.camera.quaternion);
  }

  _updateCinematic(dt, pos, quat) {
    // Wider standoff, much heavier damping, and a slight lead so the quad
    // sits off-centre in frame the way a real chase shot would.
    const heading = headingOf(quat, this._tmpQuat);
    this._desired.set(1.1 * this._rigScale, 0.85 * this._rigScale, 3.4 * this._rigScale)
      .applyQuaternion(heading).add(pos);

    const alpha = 1 - Math.exp(-1.8 * dt);
    this._chasePos.lerp(this._desired, clamp01(alpha));
    if (!isFiniteVector(this._chasePos)) this._chasePos.copy(this._desired);
    this.camera.position.copy(this._chasePos);

    this._lookTarget.lerp(pos, clamp01(1 - Math.exp(-3.5 * dt)));
    if (!isFiniteVector(this._lookTarget)) this._lookTarget.copy(pos);
    this.camera.lookAt(this._lookTarget);
    this._smoothQuat.copy(this.camera.quaternion);
  }

  /**
   * Procedural shake. Two incommensurate frequencies per axis so the motion
   * never visibly repeats, scaled by motor load and airspeed. Applied as
   * rotation rather than translation: rotational shake reads as vibration
   * without the parallax swimming that makes positional shake nauseating.
   */
  _applyShake(dt, drone) {
    const gain = settings.get('shake');
    if (gain <= 0.001 || !drone) return;

    const load = Number.isFinite(drone.avgMotor) ? drone.avgMotor : 0;
    const speed = Number.isFinite(drone.telemetry?.speed) ? drone.telemetry.speed : 0;
    const amp = gain * (0.0011 + load * 0.0042 + speed * 0.00013);
    if (amp < 1e-5) return;

    this._shakeTime += dt;
    const t = this._shakeTime;

    const rx = Math.sin(t * 61.3) * 0.6 + Math.sin(t * 143.7) * 0.4;
    const ry = Math.sin(t * 53.9) * 0.6 + Math.sin(t * 127.1) * 0.4;
    const rz = Math.sin(t * 71.7) * 0.5 + Math.sin(t * 167.3) * 0.5;

    this._shakeEuler.set(rx * amp, ry * amp, rz * amp * 0.6);
    this._shakeQuat.setFromEuler(this._shakeEuler);
    this.camera.quaternion.multiply(this._shakeQuat);
  }

  /**
   * Analog FPV latency: the camera's transform is held on a short queue and
   * replayed a fixed delay behind the frame, the way a real camera → VTX →
   * goggle chain does. Zero setting means zero behaviour change.
   */
  _applyFpvLatency() {
    const raw = settings.get('fpvLatency');
    const latency = Number.isFinite(raw) ? Math.min(60, Math.max(0, raw)) : 28;

    const q = this._poseQ;
    try {
      q.push({ p: this.camera.position.clone(), q: this.camera.quaternion.clone(), t: performance.now() });
    } catch (_e) { return; }
    while (q.length > 8) q.shift();

    if (latency <= 0) return;

    const now = performance.now();
    let chosen = null;
    for (let i = q.length - 1; i >= 0; i--) {
      if (now - q[i].t >= latency) { chosen = q[i]; break; }
    }
    if (chosen) {
      this.camera.position.copy(chosen.p);
      this.camera.quaternion.copy(chosen.q);
    }
  }

  /**
   * Rolling-shutter jello: a horizontal skew proportional to the current
   * body rate, exactly like a CMOS sensor reading out while the frame spins.
   */
  _applyJello(drone) {
    let rate = 0;
    try {
      rate = (drone && drone.body && drone.body.angularVelocity)
        ? drone.body.angularVelocity.length()
        : 0;
    } catch (_e) { rate = 0; }
    if (!Number.isFinite(rate)) rate = 0;
    const shear = Math.min(0.004, Math.max(0, rate * 0.00012));

    try {
      const w = this._size.w;
      const h = this._size.h;
      if (shear > 1e-5 && w > 0 && h > 0) {
        this.camera.setViewOffset(w, h, shear * w, 0, w, h);
      } else if (this.camera.view && this.camera.view.enabled) {
        this.camera.clearViewOffset();
      }
    } catch (_e) { /* some render targets do not support view offsets */ }
  }

  /**
   * Link quality feeding the VTX-breakup shader: falls off with distance
   * from the spawn point (a stand-in for the pilot's antenna), with a little
   * multipath flicker indoors. Missing drone/spawn data is full signal.
   */
  _updateRssi(pos, drone) {
    try {
      // Random mode: link events independent of position — mostly watchable
      // with occasional deep fades, for pilots who practise saving a dying
      // link. Distance (default) keeps the legacy spawn-range falloff.
      if (settings.get('vtxMode') === 'random') {
        const t = performance.now() * 0.001;
        const slow = 0.72 + 0.18 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.3);
        const jitter = (Math.random() - 0.5) * 0.22;
        this.rssi = clamp01(slow + jitter);
        return;
      }
      const spawn = drone?.spawnPoint;
      let d = 0;
      if (spawn && isFiniteVector(pos)) d = pos.distanceTo(spawn);
      if (!Number.isFinite(d)) d = 0;

      const range = this._link?.range || 60;
      let r = 1 / (1 + (d * d) / (range * range));

      if (this._link?.indoor) {
        r -= Math.abs(Math.sin(performance.now() * 0.001 * 37)) * 0.05;
      }
      this.rssi = clamp01(r);
    } catch (_e) {
      this.rssi = 1;
    }
  }
  /**
   * Dynamic weather (wind + light dimming only — there is no rain particle
   * system to drive, so rain is deliberately out of scope). When
   * `dynamicWeather` is off this is a no-op that restores full light. When on,
   * slow cloud passages dim the scene lights up to 35 % and gust fronts raise
   * `weather.gust` 0..1 for the physics/audio side to consume.
   */
  _tickWeather(dt) {
    try {
      if (settings.get('dynamicWeather') !== true) {
        if (this.weather.dim !== 0 || this.weather.gust !== 0) {
          this.weather.dim = 0;
          this.weather.gust = 0;
          this._lastWeatherQ = -1;
          this._applyWeatherDim();
        }
        return;
      }
      const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.5) : 0.016;
      const t = (Number.isFinite(this._weatherT) ? this._weatherT : 0) + step;
      this._weatherT = t;
      // ~45 s cloud passages, ~9 s gust fronts; products of sines so the
      // pattern never visibly repeats on a human timescale.
      const cloud = 0.5 + 0.5 * Math.sin(t * 0.14) * Math.sin(t * 0.043 + 2.1);
      const front = 0.5 + 0.5 * Math.sin(t * 0.7 + 1.0) * Math.sin(t * 0.23);
      this.weather.dim = clamp01(cloud);
      this.weather.gust = clamp01(front);
      this._applyWeatherDim();
    } catch (_e) { /* weather must never break the frame */ }
  }

  /**
   * Scale captured scene-light intensities by the current cloud dim. Light
   * refs are re-captured when the scene's top-level child count changes (map
   * switch), and a base is re-learned whenever a light disagrees with what we
   * last wrote — so the sun-angle/overcast path in main.js keeps working and
   * our dim composes with it instead of fighting it. Re-applies only when the
   * quantised dim moves, so steady weather costs nothing per frame.
   */
  _applyWeatherDim() {
    if (!this.scene) return;
    try {
      if (!this._envLights || this._envSceneSize !== this.scene.children.length) {
        this._captureWeatherLights();
      }
      const q = Math.round(clamp01(this.weather.dim) * 50) / 50;
      if (q === this._lastWeatherQ) return;
      const nextF = 1 - 0.35 * q;
      for (const entry of this._envLights || []) {
        const l = entry.light;
        if (!l || !Number.isFinite(l.intensity)) continue;
        const appliedF = Number.isFinite(entry.appliedF) && entry.appliedF > 1e-3 ? entry.appliedF : 1;
        // External write (sun slider, map lighting) since our last pass?
        // Re-learn the base rather than clobbering it.
        const expected = entry.base * appliedF;
        if (Math.abs(l.intensity - expected) > 0.02 * Math.max(1, Math.abs(entry.base))) {
          entry.base = l.intensity / appliedF;
        }
        if (!Number.isFinite(entry.base)) continue;
        l.intensity = entry.base * nextF;
        entry.appliedF = nextF;
      }
      this._lastWeatherQ = q;
    } catch (_e) { /* ignore */ }
  }

  _captureWeatherLights() {
    const q = Math.round(clamp01(this.weather.dim) * 50) / 50;
    const f = 1 - 0.35 * q;
    const found = [];
    try {
      this.scene.traverse((o) => {
        if (o && o.isLight && Number.isFinite(o.intensity)) {
          // Captured mid-weather, the light is already dimmed — divide the
          // current factor back out so the base stays undimmed.
          found.push({ light: o, base: o.intensity / f, appliedF: f });
        }
      });
    } catch (_e) { /* ignore */ }
    this._envLights = found;
    try {
      this._envSceneSize = this.scene.children.length;
    } catch (_e) {
      this._envSceneSize = -1;
    }
    this._lastWeatherQ = q;
  }


  /** Snap the smoothed state to the frame — used after a respawn. */
  reset(pos, quat) {
    this._targetQuat.copy(quat).multiply(this._tiltQuat);
    this._smoothQuat.copy(this._targetQuat);
    this.camera.quaternion.copy(this._smoothQuat);
    this.camera.position.copy(pos);
    this._chasePos.copy(pos).add(new THREE.Vector3(0, 0.6, 2.2));
    this._lookTarget.copy(pos);
    this._shakeTime = 0;
    this._poseQ.length = 0;
    try { this.camera.clearViewOffset(); } catch (_e) { /* ignore */ }
  }

  /* ====================================================================== *
   * Rendering / post-processing
   * ====================================================================== */

  resize(width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    this._size.w = w;
    this._size.h = h;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    if (this._composer) {
      try {
        this._composer.setSize(w, h);
        if (this._crtPass) this._crtPass.uniforms.uResolution.value.set(w, h);
      } catch (_e) { /* a resize failure must not kill the frame */ }
    }
  }

  /**
   * Draw the scene, through the post chain when any effect is enabled.
   * Chain order (all optional except the render): bloom → motion-blur trails
   * → analog CRT look. Any failure permanently falls back to direct rendering
   * rather than leaving the user with a black screen.
   *
   * Performance-first: with every toggle off this disposes the composer and
   * renders direct — zero post cost on integrated GPUs.
   */
  render() {
    const wantBloom = settings.get('bloom') === true && !this._composerFailed;
    const wantBlur = settings.get('motionBlur') === true && !this._composerFailed;
    const wantCrt = settings.get('crtFilter') && !this._composerFailed;
    const wantComposer = wantBloom || wantBlur || wantCrt;
    const fxKey = `${wantBloom}|${wantBlur}|${wantCrt}`;

    if (!wantComposer) {
      if (this._composer) this._disposeComposer();
      this._fxKey = null;
      this.renderer.render(this.scene, this.camera);
      return;
    }

    if (!this._composer || this._fxKey !== fxKey) this._buildComposer(wantBloom, wantBlur, wantCrt);
    if (this._composer) {
      try {
        if (this._bloomPass) {
          const raw = settings.get('bloomStrength');
          const s = Number.isFinite(raw) ? Math.min(1.2, Math.max(0, raw)) : 0.55;
          this._bloomPass.strength = 0.15 + s * 0.85;
        }
        if (this._afterPass && this._afterPass.uniforms && this._afterPass.uniforms.damp) {
          // Trail length scales with airspeed so hovering stays crisp while
          // a 40 m/s dive smears — the FPV speed feel, for one fullscreen pass.
          let speed = 0;
          try {
            const v = this._lastDrone?.telemetry?.speed;
            if (Number.isFinite(v)) speed = v;
          } catch (_e) { /* ignore */ }
          this._afterPass.uniforms.damp.value = 0.35 + Math.min(0.5, speed * 0.012);
        }
        if (this._crtPass) {
          this._crtPass.uniforms.uTime.value = performance.now() * 0.001;

          const fov = Number.isFinite(this.camera.fov) ? this.camera.fov : 130;
          // Lens slider 0..0.3 scales the legacy FOV-linked barrel term, so
          // the default (0.14) reproduces the old look exactly at every FOV
          // and 0 disables distortion entirely.
          const rawLens = settings.get('lensDistortion');
          const lens = Number.isFinite(rawLens) ? Math.min(0.3, Math.max(0, rawLens)) : 0.14;
          this._crtPass.uniforms.uLens.value = (0.08 + (fov - 90) * 0.0015) * (lens / 0.14);

          const breakupSetting = settings.get('vtxBreakup');
          const breakupOn = typeof breakupSetting === 'boolean' ? breakupSetting : true;
          this._crtPass.uniforms.uRssi.value = breakupOn ? clamp01(this.rssi) : 1;
        }
        this._composer.render();
        return;
      } catch (err) {
        console.warn('[CameraRig] post-processing failed; reverting to direct render.', err);
        this._composerFailed = true;
        this._disposeComposer();
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Build the post chain for exactly the enabled effects, lazily, the first
   * time they are switched on. Everything is wrapped: if the composer cannot
   * be created we set _composerFailed and fall back to direct rendering
   * permanently, rather than retrying (and failing) on every single frame.
   */
  _buildComposer(wantBloom = false, wantBlur = false, wantCrt = false) {
    this._disposeComposer();
    try {
      this._composer = new EffectComposer(this.renderer);
      this._composer.addPass(new RenderPass(this.scene, this.camera));

      this._bloomPass = null;
      this._afterPass = null;
      this._crtPass = null;

      if (wantBloom) {
        // Selective by luminance: threshold ~1.0 so only emissive lamps,
        // windows, and gate rings bloom — never the whole daylight scene.
        this._bloomPass = new UnrealBloomPass(
          new THREE.Vector2(this._size.w, this._size.h), 0.6, 0.5, 1.0,
        );
        this._composer.addPass(this._bloomPass);
      }
      if (wantBlur) {
        this._afterPass = new AfterimagePass();
        this._composer.addPass(this._afterPass);
      }
      if (wantCrt) {
        this._crtPass = new ShaderPass(CRT_SHADER);
        this._crtPass.uniforms.uResolution.value.set(this._size.w, this._size.h);
        this._composer.addPass(this._crtPass);
      }
      this._composer.setSize(this._size.w, this._size.h);
      this._fxKey = `${wantBloom}|${wantBlur}|${wantCrt}`;
    } catch (err) {
      console.warn('[CameraRig] could not build post-processing chain.', err);
      this._composerFailed = true;
      this._composer = null;
      this._crtPass = null;
      this._bloomPass = null;
      this._afterPass = null;
    }
  }

  _disposeComposer() {
    try {
      this._composer?.dispose?.();
      this._bloomPass?.dispose?.();
      this._afterPass?.dispose?.();
      this._crtPass?.dispose?.();
    } catch (_e) { /* ignore */ }
    this._composer = null;
    this._crtPass = null;
    this._bloomPass = null;
    this._afterPass = null;
  }

  dispose() {
    this._disposeComposer();
  }
}

/* ========================================================================== *
 * Post-processing chain
 * ========================================================================== */

/**
 * Cheap analog-video look: RGB split that grows toward the edges, rolling
 * scanlines, film-grain noise, and a signal vignette. One texture fetch per
 * channel and no blur passes, so it costs almost nothing.
 */
const CRT_SHADER = {
  name: 'AnalogGoggleShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uLens: { value: 0.12 },
    uRssi: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uLens;
    uniform float uRssi;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // Barrel distortion: a cheap lens, worse at wider FOV.
      uv += centered * r2 * uLens;

      float rssi = clamp(uRssi, 0.0, 1.0);
      // VTX signal loss: a horizontal tear that grows as link quality drops.
      if (rssi < 0.35) {
        float tear = step(0.9, fract(uv.y * 3.0 + uTime)) * 0.02 * (0.35 - rssi);
        uv.x += tear;
      }

      // Chromatic aberration: zero at the centre, growing toward the corners,
      // which is how a cheap lens and an analog link both actually fail.
      float ca = 0.0022 * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + centered * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - centered * ca).b;

      // Scanlines, slowly rolling so they never sit still on the panel.
      float lines = sin((uv.y + uTime * 0.02) * uResolution.y * 1.6);
      col *= 1.0 - 0.085 * (0.5 + 0.5 * lines);

      // Signal noise, strongest where the picture is darkest.
      float n = hash(uv * uResolution.xy * 0.5 + uTime * 60.0);
      col += (n - 0.5) * 0.045 * (1.2 - dot(col, vec3(0.333)));

      // VTX breakup: extra luma noise and desaturation as RSSI drops.
      float breakupN = hash(uv * uResolution.xy * 0.37 + uTime * 91.0);
      col += (1.0 - rssi) * (breakupN - 0.5) * 0.35;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(luma), (1.0 - rssi) * 0.6);

      // Vignette.
      col *= smoothstep(0.92, 0.22, r2);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

const UNIT_X = new THREE.Vector3(1, 0, 0);
const UNIT_Y = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Strip roll and pitch, leaving only the heading — for the chase cameras. */
function headingOf(quat, out) {
  _euler.setFromQuaternion(quat, 'YXZ');
  return out.setFromAxisAngle(UNIT_Y, _euler.y);
}

function clamp01(v) {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

function isFiniteVector(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function isFiniteQuaternion(q) {
  return Number.isFinite(q.x) && Number.isFinite(q.y) &&
    Number.isFinite(q.z) && Number.isFinite(q.w) &&
    (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) > 1e-8;
}
