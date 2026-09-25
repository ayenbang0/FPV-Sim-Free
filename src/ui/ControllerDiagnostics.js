/**
 * ui/ControllerDiagnostics.js
 * ---------------------------------------------------------------------------
 * A live view of exactly what the Gamepad API is reporting.
 *
 * This panel exists because "my transmitter doesn't work" is almost never a
 * bug in the flight model — it is an axis reported on a different index, an
 * inverted throttle, or a device the browser never enumerated at all. Showing
 * raw axis numbers, live button states, and two stick dots lets a pilot
 * diagnose that in seconds instead of guessing.
 *
 * Toggle with `G`, or from the pause menu.
 */

import { settings, REMAPPABLE } from '../core/Settings.js';

const STICK_SIZE = 76;

export class ControllerDiagnostics {
  /**
   * @param {HTMLElement} root the #diag element
   * @param {import('../core/InputManager.js').InputManager} input
   */
  constructor(root, input) {
    this.root = root;
    this.input = input;
    this.open = false;

    this._axisRows = [];
    this._buttonDots = [];
    this._lastAxisCount = -1;
    this._lastButtonCount = -1;

    this._build();
  }

  _build() {
    this.root.innerHTML = '';

    this.title = div('title', 'CONTROLLER DIAGNOSTICS');
    this.status = div('', '');
    this.status.style.cssText = 'margin-bottom:8px; color: rgba(232,242,236,0.72); line-height:1.5;';
    this.linkLine = div('', '');
    this.linkLine.style.cssText = 'margin-bottom:8px; color: rgba(232,242,236,0.72); line-height:1.5;';

    // --- stick visualisation ---
    const pair = div('stick-pair');
    this.leftStick = makeStickBox('LEFT  (YAW / THR)');
    this.rightStick = makeStickBox('RIGHT (ROLL / PITCH)');
    pair.append(this.leftStick.wrap, this.rightStick.wrap);

    // --- live axes / buttons ---
    this.axesHost = div('');
    this.buttonsHost = div('btn-grid');

    const axesLabel = div('title', 'AXES');
    axesLabel.style.marginTop = '10px';
    const btnLabel = div('title', 'BUTTONS');
    btnLabel.style.marginTop = '10px';

    // --- remap ---
    const remapLabel = div('title', 'BINDINGS');
    remapLabel.style.marginTop = '12px';
    this.remapHost = div('');
    this._buildRemapRows();

    this.hint = div('hint', 'Click REMAP, then move the stick or press the button you want bound.');
    this.hint.style.marginTop = '8px';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ui small ghost';
    resetBtn.textContent = 'Reset bindings';
    resetBtn.style.marginTop = '8px';
    resetBtn.addEventListener('click', () => {
      settings.set('gamepadMapping', undefined);   // sanitize restores defaults
      this._buildRemapRows();
    });

    this.root.append(
      this.title, this.status, this.linkLine, pair,
      axesLabel, this.axesHost,
      btnLabel, this.buttonsHost,
      remapLabel, this.remapHost, this.hint, resetBtn,
    );
  }

  /* ====================================================================== *
   * Remap rows
   * ====================================================================== */

  _buildRemapRows() {
    this.remapHost.innerHTML = '';
    this._remapRows = new Map();
    const map = settings.get('gamepadMapping');

    for (const { key, label } of REMAPPABLE) {
      const row = div('remap-row');
      const fn = div('fn', label);
      const bd = div('bd', describeBinding(map[key]));

      const btn = document.createElement('button');
      btn.className = 'ui small';
      btn.textContent = 'Remap';
      btn.addEventListener('click', () => {
        if (this.input.remapTarget === key) {
          this.input.cancelRemap();
        } else {
          this.input.beginRemap(key);
        }
        this._refreshRemapRows();
      });

      row.append(fn, bd, btn);
      this.remapHost.append(row);
      this._remapRows.set(key, { row, bd });
    }

    // Re-render the binding text as soon as a capture completes.
    this.input.onRemapComplete = () => this._refreshRemapRows();
  }

  _refreshRemapRows() {
    if (!this._remapRows) return;
    const map = settings.get('gamepadMapping');
    for (const [key, { row, bd }] of this._remapRows) {
      const listening = this.input.remapTarget === key;
      row.classList.toggle('listening', listening);
      bd.textContent = listening ? 'Move a control…' : describeBinding(map[key]);
    }
  }

  /* ====================================================================== *
   * Visibility
   * ====================================================================== */

  setOpen(on) {
    this.open = !!on;
    this.root.classList.toggle('open', this.open);
    if (!this.open) this.input.cancelRemap();
    else this._refreshRemapRows();
  }

  toggle() {
    this.setOpen(!this.open);
    return this.open;
  }

  /* ====================================================================== *
   * Per-frame update
   * ====================================================================== */

  update() {
    if (!this.open) return;

    const st = this.input.getStatus();
    const raw = this.input.rawGamepad;

    /* ---- status block ---- */
    let text;
    if (!st.gamepadSupported) {
      text = 'Gamepad API not available in this browser.\nKeyboard controls are active.';
    } else if (!st.gamepadConnected) {
      text = 'CONTROLLER: Not connected\nPlug in a gamepad or transmitter and press a button to wake it.';
    } else {
      text = `CONTROLLER: Connected\n${st.gamepadName}\n${raw.axes.length} axes · ${raw.buttons.length} buttons` +
        (st.gamepadCount > 1 ? `\n${st.gamepadCount} devices detected — using #${st.gamepadIndex}` : '');
    }
    if (this._lastStatus !== text) {
      this._lastStatus = text;
      this.status.textContent = text;
    }

    /* ---- link status ---- */
    const latency = Number.isFinite(this.input.linkLatencyMs) ? `${Math.round(this.input.linkLatencyMs)}ms` : 'n/a';
    const loss = Number.isFinite(this.input.linkLossPct) ? `${this.input.linkLossPct.toFixed(1)}%` : 'n/a';
    const hold = typeof this.input.linkHeld === 'boolean' ? (this.input.linkHeld ? 'HOLD' : 'OK') : 'n/a';
    const failsafe = typeof this.input.linkFailsafe === 'boolean' ? (this.input.linkFailsafe ? 'FAILSAFE' : 'OK') : 'n/a';
    const linkText = `link: ${latency} ${loss} ${hold} ${failsafe}`;
    if (this._lastLinkText !== linkText) {
      this._lastLinkText = linkText;
      this.linkLine.textContent = linkText;
    }

    /* ---- sticks ---- */
    const c = this.input.controls;
    // Left stick: yaw on X, throttle on Y (drawn from the bottom, like a real
    // throttle stick, so the dot rests low at zero rather than centred).
    drawStick(this.leftStick.ctx, c.yaw, 1 - c.throttle * 2);
    drawStick(this.rightStick.ctx, c.roll, c.pitch);

    /* ---- axes ---- */
    if (raw.axes.length !== this._lastAxisCount) {
      this._lastAxisCount = raw.axes.length;
      this.axesHost.innerHTML = '';
      this._axisRows = raw.axes.map((_, i) => {
        const row = div('axis-line');
        const nm = div('nm', `AX${i}`);
        const bar = div('bar');
        const fill = document.createElement('i');
        bar.append(fill);
        const nv = div('nv', '0.00');
        row.append(nm, bar, nv);
        this.axesHost.append(row);
        return { fill, nv };
      });
    }
    for (let i = 0; i < raw.axes.length; i++) {
      const v = raw.axes[i];
      const r = this._axisRows[i];
      if (!r) continue;
      // Bar grows from the centre so the sign is readable at a glance.
      const half = Math.abs(v) * 50;
      r.fill.style.left = `${v < 0 ? 50 - half : 50}%`;
      r.fill.style.width = `${half}%`;
      const txt = v.toFixed(2);
      if (r.nv.textContent !== txt) r.nv.textContent = txt;
    }

    /* ---- buttons ---- */
    if (raw.buttons.length !== this._lastButtonCount) {
      this._lastButtonCount = raw.buttons.length;
      this.buttonsHost.innerHTML = '';
      this._buttonDots = raw.buttons.map((_, i) => {
        const d = div('btn-dot', String(i));
        this.buttonsHost.append(d);
        return d;
      });
    }
    for (let i = 0; i < raw.buttons.length; i++) {
      const dot = this._buttonDots[i];
      if (dot) dot.classList.toggle('on', raw.buttons[i].pressed);
    }

    /* ---- remap feedback ---- */
    if (this.input.remapTarget !== this._lastRemapTarget) {
      this._lastRemapTarget = this.input.remapTarget;
      this._refreshRemapRows();
    }
  }

  dispose() {
    this.input.onRemapComplete = null;
    this.root.innerHTML = '';
  }
}

/* ========================================================================== *
 * Rendering helpers
 * ========================================================================== */

function div(className, text) {
  const n = document.createElement('div');
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function makeStickBox(caption) {
  const wrap = div('stick-box');
  const canvas = document.createElement('canvas');
  canvas.width = STICK_SIZE;
  canvas.height = STICK_SIZE;
  const cap = div('cap', caption);
  wrap.append(canvas, cap);

  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (_e) { ctx = null; }
  return { wrap, canvas, ctx };
}

/**
 * Draw one stick as a dot inside a circle.
 * @param {CanvasRenderingContext2D|null} ctx
 * @param {number} x  -1..1
 * @param {number} y  -1..1 (positive draws downward, matching stick feel)
 */
function drawStick(ctx, x, y) {
  if (!ctx) return;
  const s = STICK_SIZE;
  const r = s / 2 - 3;

  ctx.clearRect(0, 0, s, s);

  ctx.strokeStyle = 'rgba(77,255,166,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(77,255,166,0.14)';
  ctx.beginPath();
  ctx.moveTo(s / 2, 3); ctx.lineTo(s / 2, s - 3);
  ctx.moveTo(3, s / 2); ctx.lineTo(s - 3, s / 2);
  ctx.stroke();

  const cx = s / 2 + clamp(x, -1, 1) * r;
  const cy = s / 2 + clamp(y, -1, 1) * r;

  ctx.fillStyle = '#4dffa6';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return 0;
  return v < min ? min : v > max ? max : v;
}

/** Human-readable description of a binding, for the remap list. */
function describeBinding(binding) {
  if (!binding) return 'unbound';
  if (binding.type === 'axis') {
    const mode = binding.mode === 'unipolar' ? ' abs' : '';
    return `Axis ${binding.index}${binding.invert ? ' (inv)' : ''}${mode}`;
  }
  return `Button ${binding.index}`;
}
