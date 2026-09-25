/**
 * core/CameraRig.js
 * ---------------------------------------------------------------------------
 * The FPV camera and its two alternates. The picture itself — fisheye lens,
 * rolling shutter, video system and the rest of the post pipeline — is built
 * by render/PostStack.js; this module decides where the camera is and hands
 * the stack a lens and video state every frame.
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

import * as THREE from 'three/webgpu';
import { settings } from './Settings.js';
import { PostStack, PROP_LAYER } from '../render/PostStack.js';
import { lensSetup, READOUT_SECONDS } from '../render/FpvLens.js';

export const CAMERA_MODES = ['fpv', 'chase', 'cinematic'];

const MODE_LABELS = { fpv: 'FPV', chase: 'CHASE', cinematic: 'CINEMATIC' };

/** Horizontal FOV of the third-person cameras (rectilinear), degrees. */
const CHASE_HFOV = 100;
const CINEMATIC_HFOV = 80;

/**
 * Where the camera sits on the frame: slightly forward of, and above, centre.
 * Scaled per airframe — a 65 mm whoop's camera is 1.6 cm up, a 5"'s is 3.5 cm,
 * and getting this wrong makes gap judgement feel subtly off.
 */
const DEFAULT_MOUNT = new THREE.Vector3(0, 0.035, -0.03);

export class CameraRig {
  /**
   * @param {THREE.WebGPURenderer} renderer
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    // `fov` here is a placeholder: the vertical FOV is derived every frame
    // from the lens state (the `fov` setting is the *horizontal* FOV of the
    // FPV image — see _applyLens).
    this.camera = new THREE.PerspectiveCamera(
      90,
      1,
      0.04,     // tight near plane — the quad flies through 40 cm gaps
      1800,     // replaced per map by setViewDistance()
    );
    this.camera.position.set(0, 2, 4);
    // Prop-blur discs live on their own layer so FPV can show them alone.
    this.camera.layers.enable(PROP_LAYER);

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

    /* ---- post pipeline (render/PostStack.js) ---- */
    this.postStack = new PostStack(renderer, scene, this.camera);
    this._size = { w: 1, h: 1 };
    this._camRates = { yaw: 0, pitch: 0 };
    this._invCamQ = new THREE.Quaternion();
    this._avWorld = new THREE.Vector3();

    /* ---- FPV latency queue (pose history for a lagged goggle feed) ---- */
    this._poseQ = [];

    /* ---- link quality, 0..1, drives VTX breakup in the video node ---- */
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

  /** Adopt a rebuilt renderer (device loss). */
  setRenderer(renderer) {
    this.renderer = renderer;
    this.postStack?.setRenderer(renderer);
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

  /** Sync the lens and tilt from the settings store. */
  applySettings() {
    this._applyLens();
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
    this._measureCameraRates(drone);
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
   * Body rates in the camera frame, for the lens node's rolling-shutter
   * shear (FpvLens.js). The picture is sheared in the shader rather than by
   * skewing the projection, so it composes with the fisheye and with TRAA's
   * sub-pixel jitter.
   */
  _measureCameraRates(drone) {
    this._camRates.yaw = 0;
    this._camRates.pitch = 0;
    const av = drone?.body?.angularVelocity;
    if (!av || !Number.isFinite(av.x) || !Number.isFinite(av.y) || !Number.isFinite(av.z)) return;
    this._invCamQ.copy(this.camera.quaternion).invert();
    this._avWorld.set(av.x, av.y, av.z).applyQuaternion(this._invCamQ);
    if (isFiniteVector(this._avWorld)) {
      this._camRates.yaw = this._avWorld.y;
      this._camRates.pitch = this._avWorld.x;
    }
  }

  /**
   * Lens and projection for the current mode. FPV uses the `fov` setting as
   * the horizontal FOV of the image through the chosen lens; the chase cameras
   * are fixed rectilinear views. The perspective camera's vertical FOV is
   * whatever the lens needs its source render to cover.
   */
  _applyLens() {
    const fpv = this.mode === 'fpv';
    const viewAspect = this._size.w / Math.max(1, this._size.h);
    const system = settings.get('videoSystem') === 'analog' ? 'analog' : 'hd';
    // Analog goggles show a 4:3 picture, pillarboxed on wider screens.
    const imageAspect = fpv && system === 'analog' ? Math.min(viewAspect, 4 / 3) : viewAspect;
    const lensMode = settings.get('fpvLens');
    const mode = fpv ? (['rectilinear', 'fisheye', 'fisheye-cube'].includes(lensMode) ? lensMode : 'fisheye') : 'rectilinear';
    const rawFov = settings.get('fov');
    const hfov = fpv
      ? (Number.isFinite(rawFov) ? Math.min(170, Math.max(70, rawFov)) : 145)
      : (this.mode === 'cinematic' ? CINEMATIC_HFOV : CHASE_HFOV);
    const k = settings.get('lensFisheye');
    const state = {
      mode,
      fpv,
      hfovDeg: hfov,
      k: Number.isFinite(k) ? k : 0.8,
      imageAspect,
      viewAspect,
      rates: fpv ? this._camRates : { yaw: 0, pitch: 0 },
      readout: fpv ? READOUT_SECONDS[system] : 0,
    };
    const setup = lensSetup(state);
    // Written as !(<=) so a NaN aspect also triggers the repair: TRAA's
    // jitter calls setViewOffset(), which overwrites `aspect` from its render
    // target and can leave NaN behind right after the graph is rebuilt.
    if (!(Math.abs(this.camera.fov - setup.vfovDeg) <= 1e-4) || !(Math.abs(this.camera.aspect - viewAspect) <= 1e-6)) {
      this.camera.fov = setup.vfovDeg;
      this.camera.aspect = viewAspect;
      this.camera.updateProjectionMatrix();
    }
    this._lensState = state;
    return state;
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
  }

  /* ====================================================================== *
   * Rendering / post-processing
   * ====================================================================== */

  resize(width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    this._size.w = w;
    this._size.h = h;
    this._applyLens();
    this.postStack?.resize(w, h);
  }

  /**
   * Draw the frame through the post pipeline. If the stack cannot be built or
   * throws mid-frame it marks itself failed and we render direct from then on
   * rather than leaving the user with a black screen.
   */
  render() {
    const stack = this.postStack;
    if (stack && !stack.failed) {
      try {
        const lens = this._applyLens();
        stack.setFpvLens(lens);
        const breakupSetting = settings.get('vtxBreakup');
        stack.setVideo({
          system: settings.get('videoSystem') === 'analog' ? 'analog' : 'hd',
          active: this.mode === 'fpv',
          rssi: clamp01(this.rssi),
          breakup: typeof breakupSetting === 'boolean' ? breakupSetting : true,
          time: performance.now() * 0.001,
        });
        let speed = 0;
        try {
          const v = this._lastDrone?.telemetry?.speed;
          if (Number.isFinite(v)) speed = v;
        } catch (_e) { /* ignore */ }
        stack.setEffects({
          bloom: settings.get('bloom') === true,
          bloomStrength: settings.get('bloomStrength'),
          motionBlur: settings.get('motionBlur') === true,
          speed,
        });
        if (stack.render()) return;
      } catch (err) {
        console.warn('[CameraRig] post pipeline failed; rendering direct.', err);
        stack.failed = true;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.postStack?.dispose();
  }
}

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
