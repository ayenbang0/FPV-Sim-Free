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

export const CAMERA_MODES = ['fpv', 'chase', 'cinematic'];

const MODE_LABELS = { fpv: 'FPV', chase: 'CHASE', cinematic: 'CINEMATIC' };

/** Where the camera sits on the frame: slightly forward of, and above, centre. */
const MOUNT_OFFSET = new THREE.Vector3(0, 0.035, -0.03);

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
      1800,
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
    this._tmpQuat = new THREE.Quaternion();
    this._tmpVec = new THREE.Vector3();

    /* ---- post-processing (built lazily) ---- */
    this._composer = null;
    this._crtPass = null;
    this._composerFailed = false;
    this._size = { w: 1, h: 1 };

    this.applySettings();
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

    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0.016;

    if (this.mode === 'fpv') this._updateFpv(step, pos, quat);
    else if (this.mode === 'chase') this._updateChase(step, pos, quat);
    else this._updateCinematic(step, pos, quat);

    this._applyShake(step, drone);

    // A NaN in the camera transform blanks the screen without throwing, which
    // looks exactly like a crash to the user. Cheap insurance.
    if (!isFiniteVector(this.camera.position)) this.camera.position.copy(pos);
    if (!isFiniteQuaternion(this.camera.quaternion)) this.camera.quaternion.copy(quat);
  }

  _updateFpv(dt, pos, quat) {
    // Position: exact. Mount offset rotated into the frame's orientation.
    this._tmpVec.copy(MOUNT_OFFSET).applyQuaternion(quat);
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
  }

  _updateChase(dt, pos, quat) {
    // Sit behind and above the frame, but only follow its *heading*, not its
    // roll — a chase cam that barrel-rolls with the quad is unusable.
    const heading = headingOf(quat, this._tmpQuat);
    this._desired.set(0, 0.55, 2.1).applyQuaternion(heading).add(pos);

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
    this._desired.set(1.1, 0.85, 3.4).applyQuaternion(heading).add(pos);

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

  /** Snap the smoothed state to the frame — used after a respawn. */
  reset(pos, quat) {
    this._targetQuat.copy(quat).multiply(this._tiltQuat);
    this._smoothQuat.copy(this._targetQuat);
    this.camera.quaternion.copy(this._smoothQuat);
    this.camera.position.copy(pos);
    this._chasePos.copy(pos).add(new THREE.Vector3(0, 0.6, 2.2));
    this._lookTarget.copy(pos);
    this._shakeTime = 0;
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
   * Draw the scene, through the CRT composer when it is enabled and available.
   * Any failure in the post path permanently falls back to direct rendering
   * rather than leaving the user with a black screen.
   */
  render() {
    const wantCrt = settings.get('crtFilter') && !this._composerFailed;

    if (wantCrt) {
      if (!this._composer) this._buildComposer();
      if (this._composer) {
        try {
          if (this._crtPass) this._crtPass.uniforms.uTime.value = performance.now() * 0.001;
          this._composer.render();
          return;
        } catch (err) {
          console.warn('[CameraRig] post-processing failed; reverting to direct render.', err);
          this._composerFailed = true;
          this._disposeComposer();
        }
      }
    } else if (this._composer) {
      this._disposeComposer();
    }

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Build the analog-goggle chain, lazily, the first time the filter is
   * switched on. Everything is wrapped: if the composer cannot be created we
   * set _composerFailed and fall back to direct rendering permanently, rather
   * than retrying (and failing) on every single frame.
   */
  _buildComposer() {
    try {
      this._composer = new EffectComposer(this.renderer);
      this._composer.addPass(new RenderPass(this.scene, this.camera));

      this._crtPass = new ShaderPass(CRT_SHADER);
      this._crtPass.uniforms.uResolution.value.set(this._size.w, this._size.h);
      this._composer.addPass(this._crtPass);
      this._composer.setSize(this._size.w, this._size.h);
    } catch (err) {
      console.warn('[CameraRig] could not build post-processing chain.', err);
      this._composerFailed = true;
      this._composer = null;
      this._crtPass = null;
    }
  }

  _disposeComposer() {
    try {
      this._composer?.dispose?.();
      this._crtPass?.dispose?.();
    } catch (_e) { /* ignore */ }
    this._composer = null;
    this._crtPass = null;
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
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

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
