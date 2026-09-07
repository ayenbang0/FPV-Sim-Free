/**
 * core/InputManager.js
 * ---------------------------------------------------------------------------
 * The one and only place where physical devices become flight commands.
 *
 *   Keyboard  ─┐
 *              ├─► InputManager ─► { throttle, pitch, roll, yaw } + action edges
 *   Gamepad   ─┘
 *
 * `DroneController` reads that normalised object and has no idea what produced
 * it. That is not just tidiness: it means device data is sanitised in exactly
 * one place, so a transmitter reporting NaN on axis 5 or a driver returning
 * fewer buttons than expected can never reach the physics step.
 *
 * Sign conventions used throughout (matched by DroneController's motor mix):
 *   throttle  0..1   0 = motors cut,        1 = full power
 *   pitch    -1..1  +1 = nose down/forward, -1 = nose up/back
 *   roll     -1..1  +1 = roll right,        -1 = roll left
 *   yaw      -1..1  +1 = rotate right,      -1 = rotate left
 *
 * Stability behaviours implemented here, per spec section 3:
 *   - Focus loss clears held-key state, so alt-tabbing away mid-throttle does
 *     not leave a phantom key accelerating the drone on return.
 *   - Controller disconnect zeroes that device's contribution immediately —
 *     never "last held value" — and falls back to keyboard.
 *   - Every axis is finite-checked and clamped before shaping.
 *   - The whole gamepad path is wrapped: browsers without the Gamepad API, or
 *     that throw from `getGamepads()`, simply run keyboard-only.
 */

import { settings } from './Settings.js';

/** Time for a digital key to ramp an axis from centre to full deflection. */
const KEY_RAMP_TIME = 0.15;   // seconds — spec section 7.2
/** How fast W/S move the (non-spring) keyboard throttle. */
const KEY_THROTTLE_RATE = 0.85; // units per second

/** A gamepad axis must move this far from its resting value to count as
 *  "the pilot is using the controller now" or to bind during a remap. */
const ACTIVITY_THRESHOLD = 0.22;
const REMAP_THRESHOLD = 0.55;

/** Flight keys we swallow so the page never scrolls underneath the sim. */
const CAPTURED_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Tab',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
]);

/** Discrete, edge-triggered commands. */
export const ACTIONS = Object.freeze({
  ARM: 'arm',
  RESET: 'reset',
  PAUSE: 'pause',
  MODE_ACRO: 'modeAcro',
  MODE_ANGLE: 'modeAngle',
  MODE_TOGGLE: 'modeToggle',
  CAMERA: 'camera',
  HUD: 'hud',
  TURTLE: 'turtle',
  MAP: 'map',
  DIAG: 'diag',
});

export class InputManager {
  constructor() {
    /* ---- normalised output (mutated in place; never reallocated) ---- */
    this.controls = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };

    /* ---- keyboard ---- */
    this.keys = new Set();
    this._kb = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };
    this._kbActiveAt = 0;

    /* ---- gamepad ---- */
    this.gamepadSupported = typeof navigator !== 'undefined' &&
      typeof navigator.getGamepads === 'function';
    this.gamepadIndex = null;       // index into navigator.getGamepads()
    this.gamepadName = '';
    this.gamepadCount = 0;
    this._gp = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };
    this._gpActiveAt = 0;
    this._gpBaseline = null;        // axis snapshot taken on connect
    this._gpPrevButtons = [];       // for edge detection
    this._gpSpringThrottle = 0;     // integrated throttle in spring mode
    this.rawGamepad = { axes: [], buttons: [], connected: false, id: '' };

    /* ---- source arbitration ---- */
    this.activeSource = 'keyboard'; // 'keyboard' | 'gamepad'

    /* ---- discrete actions queued this frame ---- */
    this._actions = new Set();

    /* ---- remap state ---- */
    this.remapTarget = null;        // e.g. 'roll' while listening
    this.onRemapComplete = null;

    /* ---- misc ---- */
    this.uiMode = false;            // true while a menu owns the keyboard
    this._attached = false;
    this._notifiedNoGamepadApi = false;

    /** Consumers (main.js) subscribe for toasts about device changes. */
    this.onDeviceEvent = null;

    // Bound once so detach() can remove the exact same references.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onGamepadConnected = this._onGamepadConnected.bind(this);
    this._onGamepadDisconnected = this._onGamepadDisconnected.bind(this);
  }

  /* ====================================================================== *
   * Lifecycle
   * ====================================================================== */

  attach() {
    if (this._attached) return;
    this._attached = true;
    try {
      window.addEventListener('keydown', this._onKeyDown, { passive: false });
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      document.addEventListener('visibilitychange', this._onVisibility);
      window.addEventListener('gamepadconnected', this._onGamepadConnected);
      window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    } catch (err) {
      console.warn('[InputManager] failed to attach listeners', err);
    }

    if (!this.gamepadSupported && !this._notifiedNoGamepadApi) {
      this._notifiedNoGamepadApi = true;
      this._emitDevice('warn', 'Game controller not detected — keyboard controls are active.');
    }
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;
    try {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('gamepadconnected', this._onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    } catch (_e) { /* ignore */ }
    this.clearAll();
  }

  /** Menus set this so arrow keys navigate the UI instead of flying. */
  setUiMode(on) {
    const next = !!on;
    if (next === this.uiMode) return;
    this.uiMode = next;
    // Entering a menu must not leave keys latched down behind it.
    if (next) this.clearKeys();
  }

  /* ====================================================================== *
   * Keyboard
   * ====================================================================== */

  /** True when the event came from a text field — never steal those keys. */
  _isTypingTarget(e) {
    const t = e.target;
    if (!t || t === document.body || t === document) return false;
    const tag = (t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }

  _onKeyDown(e) {
    if (this._isTypingTarget(e)) return;

    // Escape and the menu keys work in every mode; flight keys do not.
    const code = e.code;

    if (!this.uiMode && CAPTURED_CODES.has(code)) {
      // Only swallow the browser's default while the sim actually owns input.
      e.preventDefault();
    }
    if (code === 'Escape' || code === 'Tab') {
      // Tab would move DOM focus off the canvas; Escape may exit fullscreen.
      if (code === 'Tab' && !this.uiMode) e.preventDefault();
    }

    // Auto-repeat must not re-fire discrete actions.
    if (e.repeat) return;

    if (!this.uiMode) {
      this.keys.add(code);
      if (isFlightKey(code)) this._kbActiveAt = now();
    }

    this._handleKeyAction(code, e);
  }

  _onKeyUp(e) {
    if (this._isTypingTarget(e)) return;
    this.keys.delete(e.code);
  }

  /** Map a keydown to a discrete action. Runs even in UI mode for menu keys. */
  _handleKeyAction(code, e) {
    switch (code) {
      case 'Escape':
        this._actions.add(ACTIONS.PAUSE);
        break;
      case 'KeyP':
        if (!this.uiMode) this._actions.add(ACTIONS.PAUSE);
        break;
      case 'Space':
        if (!this.uiMode) this._actions.add(ACTIONS.ARM);
        break;
      case 'KeyR':
        if (!this.uiMode) this._actions.add(ACTIONS.RESET);
        break;
      case 'Digit1':
        if (!this.uiMode) this._actions.add(ACTIONS.MODE_ACRO);
        break;
      case 'Digit2':
        if (!this.uiMode) this._actions.add(ACTIONS.MODE_ANGLE);
        break;
      case 'KeyC':
        if (!this.uiMode) this._actions.add(ACTIONS.CAMERA);
        break;
      case 'Tab':
        if (!this.uiMode) { e.preventDefault(); this._actions.add(ACTIONS.HUD); }
        break;
      case 'KeyM':
        if (!this.uiMode) this._actions.add(ACTIONS.MAP);
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        if (!this.uiMode) this._actions.add(ACTIONS.TURTLE);
        break;
      case 'KeyG':
        if (!this.uiMode) this._actions.add(ACTIONS.DIAG);
        break;
      default:
        break;
    }
  }

  _onBlur() {
    // The single most important stability behaviour in this file: a key held
    // when focus leaves never sends a keyup, so without this the drone keeps
    // accelerating forever once the user comes back.
    this.clearKeys();
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') this.clearKeys();
  }

  /** Drop all held keys and decay the ramped axes to neutral immediately. */
  clearKeys() {
    this.keys.clear();
    this._kb.pitch = 0;
    this._kb.roll = 0;
    this._kb.yaw = 0;
    // Throttle deliberately *keeps* its value: it models a ratcheted throttle
    // stick, and zeroing it on every alt-tab would drop the quad out of the
    // air. Motors are cut by the arm state instead, which is explicit.
  }

  /** Full neutral — used on disconnect, respawn, and crash lockout. */
  clearAll() {
    this.clearKeys();
    this._kb.throttle = 0;
    this._gp.throttle = 0;
    this._gp.pitch = 0;
    this._gp.roll = 0;
    this._gp.yaw = 0;
    this._gpSpringThrottle = 0;
    this.controls.throttle = 0;
    this.controls.pitch = 0;
    this.controls.roll = 0;
    this.controls.yaw = 0;
    this._actions.clear();
  }

  /** Ramp a digital key pair toward its target, simulating stick travel. */
  _rampKeyAxis(current, target, dt) {
    const step = dt / KEY_RAMP_TIME;
    const delta = target - current;
    if (Math.abs(delta) <= step) return target;
    return current + Math.sign(delta) * step;
  }

  _updateKeyboard(dt) {
    const k = this.keys;

    // Arrow keys are the primary flight controls (spec section 7.2).
    const pitchTarget = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    const rollTarget = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const yawTarget = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);

    this._kb.pitch = this._rampKeyAxis(this._kb.pitch, pitchTarget, dt);
    this._kb.roll = this._rampKeyAxis(this._kb.roll, rollTarget, dt);
    this._kb.yaw = this._rampKeyAxis(this._kb.yaw, yawTarget, dt);

    // Throttle is incremental and *holds* its position, like a real
    // non-spring throttle stick, rather than springing back to zero.
    const up = k.has('KeyW') ? 1 : 0;
    const down = k.has('KeyS') ? 1 : 0;
    if (up || down) {
      this._kb.throttle += (up - down) * KEY_THROTTLE_RATE * dt;
      this._kb.throttle = clamp(this._kb.throttle, 0, 1);
      this._kbActiveAt = now();
    }
  }

  /** Directly set keyboard throttle — used on arm/respawn. */
  setKeyboardThrottle(v) {
    this._kb.throttle = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    this._gpSpringThrottle = this._kb.throttle;
  }

  /* ====================================================================== *
   * Gamepad
   * ====================================================================== */

  _onGamepadConnected(e) {
    const pad = e && e.gamepad;
    if (!pad) return;
    this.gamepadIndex = pad.index;
    this.gamepadName = shortName(pad.id);
    this._gpBaseline = null;   // re-snapshot on the next poll
    this._gpPrevButtons = [];
    this._emitDevice('info', `Controller connected — ${this.gamepadName}`);
  }

  _onGamepadDisconnected(e) {
    const pad = e && e.gamepad;
    if (pad && this.gamepadIndex !== null && pad.index !== this.gamepadIndex) {
      // A secondary controller went away; the active one is unaffected.
      return;
    }
    const wasName = this.gamepadName || 'Controller';
    this._releaseGamepad();
    this._emitDevice('warn', `${wasName} disconnected — keyboard controls are active.`);
  }

  /**
   * Drop the active controller and neutralise its contribution *immediately*.
   * Holding the last-seen throttle here would leave a disconnected transmitter
   * flying the quad at whatever power it was at, which is exactly the failure
   * the spec calls out.
   */
  _releaseGamepad() {
    this.gamepadIndex = null;
    this.gamepadName = '';
    this._gpBaseline = null;
    this._gpPrevButtons = [];
    this._gp.throttle = 0;
    this._gp.pitch = 0;
    this._gp.roll = 0;
    this._gp.yaw = 0;
    this._gpSpringThrottle = 0;
    this.activeSource = 'keyboard';
    this.rawGamepad.connected = false;
    this.rawGamepad.axes = [];
    this.rawGamepad.buttons = [];
    this.remapTarget = null;
  }

  /** Snapshot of every connected pad, for the diagnostics and select UI. */
  listGamepads() {
    const out = [];
    for (const pad of this._getPads()) {
      if (pad) out.push({ index: pad.index, id: shortName(pad.id), axes: pad.axes?.length ?? 0, buttons: pad.buttons?.length ?? 0 });
    }
    return out;
  }

  /** Explicitly choose which connected controller flies the drone. */
  selectGamepad(index) {
    const pads = this._getPads();
    const pad = pads.find((p) => p && p.index === index);
    if (!pad) return false;
    this.gamepadIndex = pad.index;
    this.gamepadName = shortName(pad.id);
    this._gpBaseline = null;
    this._gpPrevButtons = [];
    return true;
  }

  /** `navigator.getGamepads()` behind a guard — it throws in some sandboxes. */
  _getPads() {
    if (!this.gamepadSupported) return [];
    try {
      const raw = navigator.getGamepads();
      if (!raw) return [];
      return Array.prototype.slice.call(raw);
    } catch (_e) {
      // Feature-detect once, then stop trying: repeated throws are expensive.
      this.gamepadSupported = false;
      return [];
    }
  }

  /** Read one axis defensively. Returns 0 for a missing or garbage axis. */
  _readAxis(pad, binding) {
    if (!binding || binding.type !== 'axis') return 0;
    const axes = pad.axes;
    if (!axes || binding.index < 0 || binding.index >= axes.length) return 0;

    let v = axes[binding.index];
    if (!Number.isFinite(v)) return 0;          // NaN / Infinity from a driver
    v = clamp(v, -1, 1);                        // some devices overshoot ±1
    if (binding.invert) v = -v;

    if (binding.mode === 'unipolar') {
      // A centre-resting ±1 axis becomes an absolute 0..1 throttle. Up on the
      // stick reads -1, so (1 - v) / 2 puts full-up at 1 and full-down at 0.
      return clamp((1 - v) / 2, 0, 1);
    }
    return v;
  }

  /** Read one button defensively across the several shapes drivers report. */
  _readButton(pad, binding) {
    if (!binding || binding.type !== 'button') return false;
    const btns = pad.buttons;
    if (!btns || binding.index < 0 || binding.index >= btns.length) return false;

    const b = btns[binding.index];
    if (b == null) return false;
    if (typeof b === 'number') return Number.isFinite(b) && b > 0.5;
    if (typeof b.pressed === 'boolean') return b.pressed;
    if (Number.isFinite(b.value)) return b.value > 0.5;
    return false;
  }

  _updateGamepad(dt) {
    const pads = this._getPads();
    this.gamepadCount = pads.reduce((n, p) => n + (p ? 1 : 0), 0);

    // Adopt the first available pad if we have none (covers the case where a
    // controller was already plugged in before the page loaded and the
    // connection event fired before our listener existed).
    let pad = this.gamepadIndex === null
      ? null
      : pads.find((p) => p && p.index === this.gamepadIndex) || null;

    if (!pad) {
      const first = pads.find((p) => p && p.connected !== false);
      if (first) {
        const isNew = this.gamepadIndex !== first.index;
        this.gamepadIndex = first.index;
        this.gamepadName = shortName(first.id);
        if (isNew) {
          this._gpBaseline = null;
          this._gpPrevButtons = [];
          this._emitDevice('info', `Controller connected — ${this.gamepadName}`);
        }
        pad = first;
      } else if (this.gamepadIndex !== null) {
        // Held an index for a pad that has vanished without an event.
        this._releaseGamepad();
      }
    }

    if (!pad) {
      this.rawGamepad.connected = false;
      return;
    }

    const axes = Array.isArray(pad.axes) ? pad.axes : Array.from(pad.axes || []);
    const buttons = [];
    const btnSrc = pad.buttons || [];
    for (let i = 0; i < btnSrc.length; i++) {
      const b = btnSrc[i];
      const pressed = typeof b === 'number' ? b > 0.5 : !!(b && (b.pressed || (Number.isFinite(b.value) && b.value > 0.5)));
      const value = typeof b === 'number' ? b : (Number.isFinite(b?.value) ? b.value : (pressed ? 1 : 0));
      buttons.push({ pressed, value: Number.isFinite(value) ? value : 0 });
    }

    this.rawGamepad.connected = true;
    this.rawGamepad.id = this.gamepadName;
    this.rawGamepad.axes = axes.map((a) => (Number.isFinite(a) ? clamp(a, -1, 1) : 0));
    this.rawGamepad.buttons = buttons;

    // Baseline: a spring-centred stick rests at 0, but an RC transmitter's
    // throttle rests at -1, and some pots rest slightly off-centre. Comparing
    // against the resting snapshot means a parked stick is never mistaken for
    // pilot activity, which would otherwise steal control from the keyboard.
    if (!this._gpBaseline || this._gpBaseline.length !== this.rawGamepad.axes.length) {
      this._gpBaseline = this.rawGamepad.axes.slice();
    }

    // --- remap capture ------------------------------------------------
    if (this.remapTarget) {
      this._tryCaptureRemap();
      // While binding, the controller must not also be flying the drone.
      this._gp.throttle = 0; this._gp.pitch = 0; this._gp.roll = 0; this._gp.yaw = 0;
      return;
    }

    // --- axes ---------------------------------------------------------
    const map = settings.get('gamepadMapping');
    const rawThrottle = this._readAxis(pad, map.throttle);
    this._gp.pitch = this._readAxis(pad, map.pitch);
    this._gp.roll = this._readAxis(pad, map.roll);
    this._gp.yaw = this._readAxis(pad, map.yaw);

    if (settings.get('springThrottle')) {
      // Spring-centred pads (Xbox/PlayStation) rest at 50% throttle, which
      // makes hovering a wrist exercise. In this mode the stick becomes a
      // rate control: hold up to climb the throttle, release to hold it.
      const delta = (rawThrottle - 0.5) * 2;                 // -1..1 around rest
      const shaped = Math.abs(delta) < 0.12 ? 0 : delta;     // small dead band
      this._gpSpringThrottle = clamp(
        this._gpSpringThrottle + shaped * KEY_THROTTLE_RATE * dt, 0, 1,
      );
      this._gp.throttle = this._gpSpringThrottle;
    } else {
      this._gp.throttle = rawThrottle;
    }

    // --- activity detection -------------------------------------------
    let active = false;
    for (let i = 0; i < this.rawGamepad.axes.length; i++) {
      if (Math.abs(this.rawGamepad.axes[i] - this._gpBaseline[i]) > ACTIVITY_THRESHOLD) {
        active = true;
        break;
      }
    }
    if (!active) {
      for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].pressed) { active = true; break; }
      }
    }
    if (active) this._gpActiveAt = now();

    // --- button edges -> actions ---------------------------------------
    this._gamepadActionEdges(pad, map, buttons);
    this._gpPrevButtons = buttons.map((b) => b.pressed);
  }

  _gamepadActionEdges(pad, map, buttons) {
    const edge = (key, action) => {
      const binding = map[key];
      if (!binding || binding.type !== 'button') return;
      const idx = binding.index;
      const nowPressed = idx < buttons.length ? buttons[idx].pressed : false;
      const wasPressed = this._gpPrevButtons[idx] === true;
      if (nowPressed && !wasPressed) this._actions.add(action);
    };

    edge('arm', ACTIONS.ARM);
    edge('reset', ACTIONS.RESET);
    edge('mode', ACTIONS.MODE_TOGGLE);
    edge('camera', ACTIONS.CAMERA);
    edge('turtle', ACTIONS.TURTLE);
    edge('pause', ACTIONS.PAUSE);
  }

  /* ---------------------------------------------------------------------- *
   * Remapping
   * ---------------------------------------------------------------------- */

  /** Begin listening for the next physical control the user moves. */
  beginRemap(functionKey) {
    this.remapTarget = functionKey;
    // Re-baseline so a stick already held off-centre does not instantly bind.
    this._gpBaseline = this.rawGamepad.axes.slice();
    this._gpPrevButtons = this.rawGamepad.buttons.map((b) => b.pressed);
  }

  cancelRemap() {
    this.remapTarget = null;
  }

  /** Bind the first axis or button that crosses the capture threshold. */
  _tryCaptureRemap() {
    const target = this.remapTarget;
    if (!target) return;

    const axes = this.rawGamepad.axes;
    const buttons = this.rawGamepad.buttons;
    const spec = REMAP_KIND[target] || 'axis';

    if (spec === 'button') {
      for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].pressed && this._gpPrevButtons[i] !== true) {
          this._commitRemap(target, { type: 'button', index: i });
          return;
        }
      }
      return;
    }

    for (let i = 0; i < axes.length; i++) {
      const base = this._gpBaseline[i] ?? 0;
      const delta = axes[i] - base;
      if (Math.abs(delta) > REMAP_THRESHOLD) {
        const mode = target === 'throttle' ? 'unipolar' : 'bipolar';
        // Bind the direction the pilot actually pushed as "positive". For a
        // bipolar axis a negative push means the axis needs inverting; for a
        // throttle, pushing up should read as more power.
        const invert = mode === 'unipolar' ? delta < 0 : delta < 0;
        this._commitRemap(target, { type: 'axis', index: i, invert, mode });
        return;
      }
    }
  }

  _commitRemap(target, binding) {
    const map = { ...settings.get('gamepadMapping'), [target]: binding };
    settings.set('gamepadMapping', map);
    this.remapTarget = null;
    this._gpBaseline = this.rawGamepad.axes.slice();
    if (typeof this.onRemapComplete === 'function') {
      try { this.onRemapComplete(target, binding); } catch (_e) { /* ignore */ }
    }
  }

  /* ====================================================================== *
   * Shaping pipeline
   * ====================================================================== */

  /**
   * Dead zone with **rescaling**. Simply zeroing everything below the
   * threshold leaves a visible jump at the boundary: the stick does nothing,
   * then suddenly commands `deadzone` worth of rate. Remapping the surviving
   * range back onto the full output keeps travel continuous.
   *
   *   |v| <= dz            -> 0
   *   |v| > dz             -> sign(v) * (|v| - dz) / (1 - dz)
   */
  static deadzoneBipolar(v, dz) {
    const a = Math.abs(v);
    if (a <= dz) return 0;
    if (dz >= 1) return 0;
    return Math.sign(v) * ((a - dz) / (1 - dz));
  }

  /**
   * Unipolar (throttle) dead zone: trim both ends so a worn pot still reaches
   * a true zero and a true full, and rescale the middle across 0..1.
   */
  static deadzoneUnipolar(v, dz) {
    const lo = dz * 0.5;
    const hi = 1 - dz * 0.5;
    if (hi <= lo) return clamp(v, 0, 1);
    return clamp((v - lo) / (hi - lo), 0, 1);
  }

  /**
   * Expo curve, per spec section 5.4:
   *
   *   output = input * (|input| * expo + (1 - expo))
   *
   * At expo = 0 this is the identity — linear sticks. At expo = 1 it becomes
   * input * |input|, a pure square curve where half stick yields a quarter of
   * the rate. The point is softer resolution around centre (where precision
   * flying happens) without giving up any of the maximum rate at full
   * deflection, since the curve still passes through ±1.
   */
  static expo(input, amount) {
    const a = clamp(amount, 0, 1);
    return input * (Math.abs(input) * a + (1 - a));
  }

  /** Full normalisation pass for the three rotational axes. */
  _shapeRotational(raw, sensitivity, dz, expoAmount) {
    if (!Number.isFinite(raw)) return 0;
    let v = clamp(raw, -1, 1);
    v = InputManager.deadzoneBipolar(v, dz);
    v = InputManager.expo(v, expoAmount);
    v *= Number.isFinite(sensitivity) ? sensitivity : 1;
    // Final hard clamp — sensitivity above 1.0 can push past the valid range.
    return clamp(v, -1, 1);
  }

  /* ====================================================================== *
   * Per-frame update
   * ====================================================================== */

  /**
   * Poll devices, arbitrate the active source, and publish `this.controls`.
   * Call exactly once per rendered frame (the Gamepad API is poll-only — it
   * never pushes analog axis events).
   */
  update(dtRaw) {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0.016;

    this._updateKeyboard(dt);

    try {
      this._updateGamepad(dt);
    } catch (err) {
      // A driver-level failure mid-poll drops us to keyboard rather than
      // taking the frame — and the whole app — down with it.
      console.warn('[InputManager] gamepad poll failed; falling back to keyboard.', err);
      this._releaseGamepad();
      this.gamepadSupported = false;
    }

    // --- source arbitration -------------------------------------------
    const override = settings.get('inputMode');
    if (override === 'keyboard') {
      this.activeSource = 'keyboard';
    } else if (override === 'gamepad') {
      this.activeSource = this.rawGamepad.connected ? 'gamepad' : 'keyboard';
    } else {
      // Auto: whichever device the pilot touched most recently wins, so they
      // can swap mid-flight without opening a menu.
      if (!this.rawGamepad.connected) this.activeSource = 'keyboard';
      else this.activeSource = this._gpActiveAt >= this._kbActiveAt ? 'gamepad' : 'keyboard';
    }

    const src = this.activeSource === 'gamepad' ? this._gp : this._kb;

    const dz = settings.get('deadzone');
    const ex = settings.get('expo');
    const sens = settings.get('sensitivity');

    // Keyboard axes are already shaped by the ramp and are exactly 0/±1, so
    // running a dead zone over them would only clip the ramp's early travel.
    const isPad = this.activeSource === 'gamepad';
    const padDz = isPad ? dz : 0;

    this.controls.pitch = this._shapeRotational(src.pitch, sens.pitch, padDz, ex);
    this.controls.roll = this._shapeRotational(src.roll, sens.roll, padDz, ex);
    this.controls.yaw = this._shapeRotational(src.yaw, sens.yaw, padDz, ex);

    // Throttle stays linear: an expo'd throttle makes hover trim unpredictable.
    let thr = Number.isFinite(src.throttle) ? clamp(src.throttle, 0, 1) : 0;
    if (isPad && !settings.get('springThrottle')) {
      thr = InputManager.deadzoneUnipolar(thr, dz);
    }
    this.controls.throttle = clamp(thr, 0, 1);

    return this.controls;
  }

  /** Drain queued discrete actions. Call once per frame after `update()`. */
  consumeActions() {
    if (this._actions.size === 0) return EMPTY_ACTIONS;
    const out = new Set(this._actions);
    this._actions.clear();
    return out;
  }

  /** Push an action programmatically (used by on-screen buttons). */
  queueAction(action) {
    if (action) this._actions.add(action);
  }

  /* ====================================================================== *
   * Status reporting
   * ====================================================================== */

  getStatus() {
    return {
      source: this.activeSource,
      sourceLabel: this.activeSource === 'gamepad'
        ? (this.gamepadName || 'CONTROLLER')
        : 'KEYBOARD',
      gamepadSupported: this.gamepadSupported,
      gamepadConnected: this.rawGamepad.connected,
      gamepadName: this.gamepadName,
      gamepadCount: this.gamepadCount,
      gamepadIndex: this.gamepadIndex,
      remapTarget: this.remapTarget,
    };
  }

  _emitDevice(level, message) {
    if (typeof this.onDeviceEvent === 'function') {
      try { this.onDeviceEvent(level, message); } catch (_e) { /* ignore */ }
    }
  }
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

const EMPTY_ACTIONS = new Set();

const REMAP_KIND = {
  throttle: 'axis', yaw: 'axis', pitch: 'axis', roll: 'axis',
  arm: 'button', reset: 'button', mode: 'button',
  camera: 'button', turtle: 'button', pause: 'button',
};

function isFlightKey(code) {
  return CAPTURED_CODES.has(code);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/** Gamepad `id` strings are long and vendor-noisy; trim for the HUD. */
function shortName(id) {
  if (!id || typeof id !== 'string') return 'Controller';
  // Strip the "(Vendor: 045e Product: 02ea)" suffix Chrome appends.
  const cleaned = id.replace(/\((?:Vendor|STANDARD GAMEPAD).*?\)/gi, '').trim();
  const out = cleaned || id;
  return out.length > 34 ? `${out.slice(0, 33)}…` : out;
}
