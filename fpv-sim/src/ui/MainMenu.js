/**
 * ui/MainMenu.js
 * ---------------------------------------------------------------------------
 * The front-end screen: map selection, settings, and the controls reference.
 *
 * Also exports the small widget helpers (`sliderRow`, `selectRow`,
 * `toggleRow`, `button`) that PauseMenu reuses, so the two screens share one
 * visual language without a third module.
 *
 * Every control writes straight through to the settings store, which validates
 * and clamps before anything reaches the flight model — a slider cannot inject
 * a bad value even if the DOM hands us something unexpected.
 */

import { settings, REMAPPABLE, defaultGamepadMapping } from '../core/Settings.js';
import { CALIBRATABLE_AXES, CALIBRATION_STEPS, axisEndpoints } from '../core/InputManager.js';
import { listAirframes, airframeStats } from '../core/DroneTypes.js';

/* ========================================================================== *
 * Shared widgets
 * ========================================================================== */

export function button(label, { primary = false, ghost = false, small = false, onClick } = {}) {
  const b = document.createElement('button');
  b.className = `ui${primary ? ' primary' : ''}${ghost ? ' ghost' : ''}${small ? ' small' : ''}`;
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/**
 * A labelled range slider bound to a settings key.
 * @param {string} label
 * @param {object} o  { min, max, step, value, format, onInput }
 */
export function sliderRow(label, { min, max, step, value, format, onInput }) {
  const row = document.createElement('div');
  row.className = 'row';

  const lab = document.createElement('label');
  lab.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const val = document.createElement('span');
  val.className = 'val';
  const render = (v) => { val.textContent = format ? format(v) : String(v); };
  render(value);

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    render(v);
    onInput?.(v);
  });

  row.append(lab, input, val);
  return row;
}

export function selectRow(label, { options, value, onChange }) {
  const row = document.createElement('div');
  row.className = 'row';

  const lab = document.createElement('label');
  lab.textContent = label;

  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange?.(sel.value));

  row.append(lab, sel);
  return row;
}

export function toggleRow(label, { value, onChange, hint }) {
  const row = document.createElement('div');
  row.className = 'row';

  const lab = document.createElement('label');
  lab.textContent = label;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!value;
  input.addEventListener('change', () => onChange?.(input.checked));

  row.append(lab, input);

  if (hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = hint;
    h.style.flex = '1';
    row.append(h);
  }
  return row;
}

export function heading(text) {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

/* ========================================================================== *
 * MainMenu
 * ========================================================================== */

export class MainMenu {
  /**
   * @param {HTMLElement} root the #menu-root element
   * @param {object} deps
   */
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;                 // { maps, input, onStart, onOpenDiagnostics, onSettingsChanged }
    this.selectedMap = deps.maps[0]?.id ?? 'field';
    this.isOpen = false;
    this.page = 'main';
  }

  open(page = 'main') {
    this.page = page;
    this.isOpen = true;
    this.render();
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.root.innerHTML = '';
    this.deps.input?.cancelAxisCalibration?.();
    this._syncCalibrationTimer();
  }

  setSelectedMap(id) {
    this.selectedMap = id;
  }

  render() {
    if (!this.isOpen) return;
    this.root.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';

    if (this.page === 'settings') this._renderSettings(panel);
    else if (this.page === 'controls') this._renderControls(panel);
    else if (this.page === 'calibrate') this._renderCalibration(panel);
    else this._renderMain(panel);

    this.root.append(panel);

    // The calibration page shows live axis values, so it needs a repaint loop
    // for as long as it is the visible page.
    this._syncCalibrationTimer();
  }

  /* ---------------------------------------------------------------------- *
   * Main page
   * ---------------------------------------------------------------------- */

  _renderMain(panel) {
    const h1 = document.createElement('h1');
    h1.textContent = 'FPV DRONE SIMULATOR';
    const tag = document.createElement('p');
    tag.className = 'tagline';
    tag.textContent = 'Rate-based acro flight model · keyboard or gamepad · three environments';
    panel.append(h1, tag, heading('Select a map'));

    const grid = document.createElement('div');
    grid.className = 'map-grid';

    for (const meta of this.deps.maps) {
      const card = document.createElement('button');
      card.className = `map-card${meta.id === this.selectedMap ? ' selected' : ''}`;

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.style.background = meta.accent;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = meta.displayName;

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = meta.description;

      card.append(thumb, name, desc);
      // Single click selects; double click selects and launches.
      card.addEventListener('click', () => {
        this.selectedMap = meta.id;
        this.render();
      });
      card.addEventListener('dblclick', () => {
        this.selectedMap = meta.id;
        this._start();
      });
      grid.append(card);
    }
    panel.append(grid);

    panel.append(heading('Select an aircraft'));
    panel.append(this._buildDronePicker());

    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      button('Start flight', { primary: true, onClick: () => this._start() }),
      button('Settings', { onClick: () => this.open('settings') }),
      button('Controls', { onClick: () => this.open('controls') }),
    );
    panel.append(row);

    const status = this._inputStatusLine();
    panel.append(status);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '14px';
    const spec = listAirframes().find((a) => a.id === settings.get('droneType')) || listAirframes()[1];
    hint.innerHTML =
      'First time flying? Take the <strong>Tinywhoop</strong> indoors and leave the mode on <strong>ANGLE</strong> — ' +
      'it self-levels when you let go of the sticks. Press <kbd>Space</kbd> to arm, then hold <kbd>W</kbd> until you lift off ' +
      `(on the ${spec.displayName}, hover sits near <strong>${Math.round(spec.hoverThrottle * 100)}%</strong> throttle).`;
    panel.append(hint);
  }

  /**
   * Aircraft cards. Each one lists the handful of numbers that actually decide
   * how the thing flies — thrust ratio, top speed, rates, and where hover sits
   * on the stick — because those are what differ, and a pilot picking a craft
   * wants to compare them rather than read prose.
   */
  _buildDronePicker() {
    const grid = document.createElement('div');
    grid.className = 'map-grid';

    const current = settings.get('droneType');

    for (const spec of listAirframes()) {
      const card = document.createElement('button');
      card.className = `map-card${spec.id === current ? ' selected' : ''}`;

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.style.background = spec.accent;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = spec.displayName;

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = spec.description;

      const table = document.createElement('table');
      table.className = 'kv-table';
      table.style.marginTop = '10px';
      for (const [k, v] of airframeStats(spec)) {
        const tr = document.createElement('tr');
        const tdk = document.createElement('td');
        tdk.className = 'k';
        tdk.style.width = '86px';
        tdk.textContent = k;
        const tdv = document.createElement('td');
        tdv.className = 'v';
        tdv.textContent = v;
        tr.append(tdk, tdv);
        table.append(tr);
      }

      card.append(thumb, name, desc, table);
      card.addEventListener('click', () => {
        // Loading the profile also rewrites rates and tilt, which the settings
        // sliders then edit — the same way a flight controller loads a craft.
        settings.loadAirframeProfile(spec.id);
        this.deps.onSettingsChanged?.();
        this.render();
      });
      grid.append(card);
    }
    return grid;
  }

  /* ---------------------------------------------------------------------- *
   * Controller setup / calibration
   * ---------------------------------------------------------------------- */

  /**
   * Guided stick calibration.
   *
   * The default axis mapping is only reliable when the browser reports
   * `mapping: "standard"`. Everything else — a Logitech pad in DirectInput
   * mode, most RC transmitters — puts the sticks wherever its driver feels
   * like, so the only dependable way to bind them is to watch what actually
   * moves. Each step sweeps one control and takes the axis that travelled
   * furthest, recording the raw value at both ends.
   */
  _renderCalibration(panel) {
    const input = this.deps.input;
    const st = input.getStatus();

    const h1 = document.createElement('h1');
    h1.textContent = 'CONTROLLER SETUP';
    panel.append(h1);

    const tag = document.createElement('p');
    tag.className = 'tagline';
    tag.textContent = st.gamepadConnected
      ? `${st.gamepadName} — ${st.axisCount} axes, ${st.buttonCount} buttons`
      : 'No controller detected';
    panel.append(tag);

    if (!st.gamepadConnected) {
      const p0 = document.createElement('p');
      p0.className = 'hint';
      p0.innerHTML =
        'Plug the controller in and <strong>press a button or move a stick</strong> — ' +
        'browsers hide gamepads until they see input, so nothing shows up until you do.';
      panel.append(p0);
      panel.append(this._calibrationButtons());
      return;
    }

    if (!st.standardMapping) {
      const warn = document.createElement('p');
      warn.className = 'hint';
      warn.style.color = 'var(--warn)';
      warn.textContent =
        'This controller does not use the browser\'s standard layout, so the ' +
        'default axis assignments are a guess. Calibrating is recommended.';
      panel.append(warn);
    }

    /* ---- live axis monitor ---- */
    panel.append(heading('Live axes'));
    const mon = document.createElement('div');
    mon.id = 'cal-monitor';
    panel.append(mon);

    /* ---- calibration steps ---- */
    panel.append(heading('Calibrate sticks'));

    const stepWrap = document.createElement('div');
    stepWrap.id = 'cal-steps';
    panel.append(stepWrap);

    for (const key of CALIBRATABLE_AXES) {
      const row = document.createElement('div');
      row.className = 'remap-row';

      const fn = document.createElement('div');
      fn.className = 'fn';
      fn.textContent = cap(key);

      const bd = document.createElement('div');
      bd.className = 'bd';
      bd.dataset.calKey = key;

      const btn = button(input.calibrating === key ? 'Done' : 'Calibrate', {
        small: true,
        primary: input.calibrating === key,
        onClick: () => {
          if (input.calibrating === key) {
            const res = input.commitAxisCalibration();
            if (!res.ok) this.deps.onNotice?.('warn', res.reason);
            else this.deps.onNotice?.('info', `${cap(key)} bound to axis ${res.binding.index}.`);
          } else {
            input.beginAxisCalibration(key);
          }
          this.render();
        },
      });

      row.append(fn, bd, btn);
      stepWrap.append(row);
    }

    const instr = document.createElement('p');
    instr.className = 'hint';
    instr.id = 'cal-instruction';
    instr.style.minHeight = '2.4em';
    panel.append(instr);

    panel.append(this._calibrationButtons());
    this._paintCalibration();
  }

  _calibrationButtons() {
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      button('Back to settings', { onClick: () => this.open('settings') }),
      button('Reset to defaults', {
        ghost: true,
        onClick: () => {
          this.deps.input.cancelAxisCalibration();
          settings.set('gamepadMapping', defaultGamepadMapping());
          this.deps.onNotice?.('info', 'Controller mapping reset to the standard layout.');
          this.render();
        },
      }),
    );
    return row;
  }

  /** Repaint the live axis bars and the current step's instruction. */
  _paintCalibration() {
    if (this.page !== 'calibrate' || !this.isOpen) return;
    const input = this.deps.input;
    const axes = input.rawGamepad.axes;

    const mon = this.root.querySelector('#cal-monitor');
    if (mon) {
      const progress = input.getCalibrationProgress();
      const map = settings.get('gamepadMapping');
      const owner = {};
      for (const k of CALIBRATABLE_AXES) {
        const b = map[k];
        if (b && b.type === 'axis') owner[b.index] = k;
      }

      mon.innerHTML = '';
      for (let i = 0; i < axes.length; i++) {
        const line = document.createElement('div');
        line.className = 'axis-line';

        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = `AX${i}`;

        const bar = document.createElement('span');
        bar.className = 'bar';
        const fill = document.createElement('i');
        const v = axes[i] || 0;
        // Centre-anchored bar: neutral sits in the middle.
        fill.style.left = `${Math.min(50, 50 + v * 50)}%`;
        fill.style.width = `${Math.abs(v) * 50}%`;
        if (progress && progress.bestIndex === i) fill.style.background = 'var(--warn)';
        bar.append(fill);

        const nv = document.createElement('span');
        nv.className = 'nv';
        nv.textContent = v.toFixed(2);

        const tagEl = document.createElement('span');
        tagEl.className = 'nm';
        tagEl.style.flex = '0 0 62px';
        tagEl.style.textAlign = 'right';
        tagEl.textContent = owner[i] ? cap(owner[i]) : '';

        line.append(nm, bar, nv, tagEl);
        mon.append(line);
      }
    }

    // Current binding text per function.
    const map = settings.get('gamepadMapping');
    for (const key of CALIBRATABLE_AXES) {
      const el = this.root.querySelector(`[data-cal-key="${key}"]`);
      if (!el) continue;
      if (input.calibrating === key) {
        const pr = input.getCalibrationProgress();
        el.textContent = pr && pr.bestIndex >= 0
          ? `listening… axis ${pr.bestIndex} (${pr.bestRange.toFixed(2)} travel)${pr.ready ? ' ✓' : ''}`
          : 'listening… move the stick';
        el.parentElement.classList.add('listening');
      } else {
        const b = map[key];
        const { lo, hi } = b && b.type === 'axis' ? axisEndpoints(b) : { lo: 0, hi: 0 };
        el.textContent = b && b.type === 'axis'
          ? `axis ${b.index}  [${lo.toFixed(2)} → ${hi.toFixed(2)}]`
          : 'unbound';
        el.parentElement.classList.remove('listening');
      }
    }

    const instr = this.root.querySelector('#cal-instruction');
    if (instr) {
      instr.textContent = input.calibrating
        ? `${CALIBRATION_STEPS[input.calibrating]}  Then press Done.`
        : 'Press Calibrate next to a control, sweep that stick to both extremes, ' +
          'and finish holding the positive direction. Repeat for all four.';
    }
  }

  /** Run a light repaint loop only while the calibration page is visible. */
  _syncCalibrationTimer() {
    const wants = this.isOpen && this.page === 'calibrate';
    if (wants && !this._calTimer) {
      this._calTimer = setInterval(() => {
        try { this._paintCalibration(); } catch (_e) { /* never break the menu */ }
      }, 80);
    } else if (!wants && this._calTimer) {
      clearInterval(this._calTimer);
      this._calTimer = null;
    }
  }

  _inputStatusLine() {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.marginTop = '10px';
    const st = this.deps.input.getStatus();
    if (!st.gamepadSupported) {
      p.textContent = 'CONTROLLER: Gamepad API unavailable in this browser — keyboard controls are active.';
    } else if (st.gamepadConnected) {
      p.textContent = `CONTROLLER: Connected — ${st.gamepadName}`;
    } else {
      p.textContent = 'CONTROLLER: Not connected — keyboard controls are active. Plug one in and press a button.';
    }
    return p;
  }

  _start() {
    this.deps.onStart?.(this.selectedMap);
  }

  /* ---------------------------------------------------------------------- *
   * Settings page
   * ---------------------------------------------------------------------- */

  _renderSettings(panel) {
    const h1 = document.createElement('h1');
    h1.textContent = 'SETTINGS';
    panel.append(h1);

    if (!settings.persistent) {
      const warn = document.createElement('p');
      warn.className = 'tagline';
      warn.style.color = 'var(--warn)';
      warn.textContent =
        'Browser storage is unavailable, so these settings apply to this session only.';
      panel.append(warn);
    }

    const changed = () => this.deps.onSettingsChanged?.();

    /* ---- input ---- */
    panel.append(heading('Input'));
    panel.append(selectRow('Input method', {
      options: [
        { value: 'auto', label: 'Auto-detect (last device used)' },
        { value: 'keyboard', label: 'Keyboard only' },
        { value: 'gamepad', label: 'Controller only' },
      ],
      value: settings.get('inputMode'),
      onChange: (v) => { settings.set('inputMode', v); changed(); },
    }));

    panel.append(sliderRow('Dead zone', {
      min: 0, max: 0.4, step: 0.01, value: settings.get('deadzone'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('deadzone', v); changed(); },
    }));

    panel.append(sliderRow('Expo', {
      min: 0, max: 1, step: 0.01, value: settings.get('expo'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('expo', v); changed(); },
    }));

    panel.append(toggleRow('Spring-centred throttle', {
      value: settings.get('springThrottle'),
      hint: 'For Xbox/PlayStation pads whose left stick springs back to centre.',
      onChange: (v) => { settings.set('springThrottle', v); changed(); },
    }));

    const gpRow = document.createElement('div');
    gpRow.className = 'btn-row';
    gpRow.style.marginTop = '8px';
    gpRow.append(button('Controller setup', {
      primary: true, small: true,
      onClick: () => this.open('calibrate'),
    }));
    gpRow.append(button('Diagnostics & remap', {
      small: true,
      onClick: () => this.deps.onOpenDiagnostics?.(),
    }));
    panel.append(gpRow);

    const gpHint = document.createElement('p');
    gpHint.className = 'hint';
    gpHint.textContent =
      'Sticks not doing anything while the buttons work? Your controller reports ' +
      'them on different axes than the default mapping expects — run Controller ' +
      'setup and calibrate. (On a Logitech F310, the D/X switch on the back also ' +
      'changes the layout; X is the one browsers understand natively.)';
    panel.append(gpHint);

    /* ---- rates ---- */
    panel.append(heading('Rates & sensitivity'));
    for (const axis of ['roll', 'pitch', 'yaw']) {
      panel.append(sliderRow(`${cap(axis)} rate`, {
        min: 100, max: axis === 'yaw' ? 900 : 1400, step: 10,
        value: settings.get('rates')[axis],
        format: (v) => `${Math.round(v)}°/s`,
        onInput: (v) => {
          settings.set('rates', { ...settings.get('rates'), [axis]: v });
          changed();
        },
      }));
    }
    for (const axis of ['roll', 'pitch', 'yaw']) {
      panel.append(sliderRow(`${cap(axis)} sensitivity`, {
        min: 0.2, max: 2, step: 0.05,
        value: settings.get('sensitivity')[axis],
        format: (v) => `${v.toFixed(2)}x`,
        onInput: (v) => {
          settings.set('sensitivity', { ...settings.get('sensitivity'), [axis]: v });
          changed();
        },
      }));
    }

    /* ---- simulation ---- */
    panel.append(heading('Simulation'));
    panel.append(selectRow('Tick rate', {
      options: [
        { value: '960', label: '960 Hz — maximum fidelity' },
        { value: '480', label: '480 Hz — very high' },
        { value: '240', label: '240 Hz — recommended' },
        { value: '120', label: '120 Hz — lowest CPU cost' },
      ],
      value: String(settings.get('simRate')),
      onChange: (v) => { settings.set('simRate', parseInt(v, 10)); changed(); },
    }));
    const rateHint = document.createElement('p');
    rateHint.className = 'hint';
    rateHint.textContent =
      'How often the flight controller runs. Higher means lower control latency and crisper stick ' +
      'response; the tune is rate-independent, so the quad flies the same at every setting.';
    panel.append(rateHint);

    panel.append(toggleRow('Adaptive quality', {
      value: settings.get('adaptiveQuality'),
      hint: 'Lowers render resolution before ever lowering the tick rate.',
      onChange: (v) => { settings.set('adaptiveQuality', v); changed(); },
    }));

    /* ---- flight ---- */
    panel.append(heading('Flight'));
    panel.append(selectRow('Default flight mode', {
      options: [
        { value: 'angle', label: 'Angle — self-levelling (beginner)' },
        { value: 'acro', label: 'Acro — rate only (realistic)' },
      ],
      value: settings.get('flightMode'),
      onChange: (v) => { settings.set('flightMode', v); changed(); },
    }));
    panel.append(sliderRow('Angle-mode tilt limit', {
      min: 10, max: 75, step: 1, value: settings.get('maxTilt'),
      format: (v) => `${Math.round(v)}°`,
      onInput: (v) => { settings.set('maxTilt', v); changed(); },
    }));
    panel.append(toggleRow('Wind (Open Field)', {
      value: settings.get('wind'),
      hint: 'Adds a gusting lateral force. Good practice, harder hovering.',
      onChange: (v) => { settings.set('wind', v); changed(); },
    }));

    /* ---- camera ---- */
    panel.append(heading('Camera'));
    panel.append(sliderRow('Field of view', {
      min: 70, max: 155, step: 1, value: settings.get('fov'),
      format: (v) => `${Math.round(v)}°`,
      onInput: (v) => { settings.set('fov', v); changed(); },
    }));
    panel.append(sliderRow('Camera uptilt', {
      min: 0, max: 55, step: 1, value: settings.get('cameraTilt'),
      format: (v) => `${Math.round(v)}°`,
      onInput: (v) => { settings.set('cameraTilt', v); changed(); },
    }));
    panel.append(sliderRow('Feed softness', {
      min: 0, max: 1, step: 0.01, value: settings.get('cameraSmoothing'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('cameraSmoothing', v); changed(); },
    }));
    panel.append(sliderRow('Camera shake', {
      min: 0, max: 2, step: 0.05, value: settings.get('shake'),
      format: (v) => `${v.toFixed(2)}x`,
      onInput: (v) => { settings.set('shake', v); changed(); },
    }));
    panel.append(toggleRow('Analog goggle filter (CRT)', {
      value: settings.get('crtFilter'),
      hint: 'Scanlines, chromatic aberration, signal noise.',
      onChange: (v) => { settings.set('crtFilter', v); changed(); },
    }));
    panel.append(toggleRow('Artificial horizon ladder', {
      value: settings.get('horizonLadder'),
      onChange: (v) => { settings.set('horizonLadder', v); changed(); },
    }));

    /* ---- audio ---- */
    panel.append(heading('Audio'));
    panel.append(toggleRow('Sound effects', {
      value: settings.get('sfx'),
      onChange: (v) => { settings.set('sfx', v); changed(); },
    }));
    panel.append(sliderRow('Master volume', {
      min: 0, max: 1, step: 0.01, value: settings.get('volume'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('volume', v); changed(); },
    }));

    /* ---- actions ---- */
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      button('Back', { primary: true, onClick: () => this.open(this.deps.returnPage || 'main') }),
      button('Restore defaults', {
        ghost: true,
        onClick: () => { settings.reset(); changed(); this.render(); },
      }),
    );
    panel.append(row);
  }

  /* ---------------------------------------------------------------------- *
   * Controls page
   * ---------------------------------------------------------------------- */

  _renderControls(panel) {
    const h1 = document.createElement('h1');
    h1.textContent = 'CONTROLS';
    panel.append(h1);

    const cols = document.createElement('div');
    cols.className = 'cols2';

    /* --- keyboard --- */
    const kb = document.createElement('div');
    kb.append(heading('Keyboard'));
    kb.append(kvTable([
      ['↑ / ↓', 'Pitch forward / back'],
      ['← / →', 'Roll left / right'],
      ['A / D', 'Yaw left / right'],
      ['W / S', 'Throttle up / down (holds its position)'],
      ['Space', 'Arm / disarm'],
      ['R', 'Reset — respawn at the spawn point'],
      ['Shift', 'Turtle-mode recovery flip'],
      ['1 / 2', 'Acro mode / Angle mode'],
      ['C', 'Cycle camera (FPV → chase → cinematic)'],
      ['Tab', 'Toggle the HUD'],
      ['G', 'Controller diagnostics'],
      ['M', 'Map select'],
      ['Esc or P', 'Pause / settings'],
    ]));
    cols.append(kb);

    /* --- gamepad --- */
    const gp = document.createElement('div');
    gp.append(heading('Controller'));

    const st = this.deps.input.getStatus();
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = st.gamepadConnected
      ? `Detected: ${st.gamepadName}`
      : 'No controller detected. Bindings below are the defaults (Mode 2).';
    gp.append(note);

    const map = settings.get('gamepadMapping');
    gp.append(kvTable(REMAPPABLE.map(({ key, label }) => {
      const b = map[key];
      const desc = !b ? 'unbound'
        : b.type === 'axis'
          ? `Axis ${b.index}${b.invert ? ' (inverted)' : ''}`
          : `Button ${b.index}`;
      return [label, desc];
    })));

    const remapRow = document.createElement('div');
    remapRow.className = 'btn-row';
    remapRow.append(button('Remap controller', {
      small: true, onClick: () => this.deps.onOpenDiagnostics?.(),
    }));
    gp.append(remapRow);

    cols.append(gp);
    panel.append(cols);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '16px';
    hint.textContent =
      'Keyboard and controller are live at the same time — whichever you touch most recently takes over, ' +
      'with no need to restart or change a setting.';
    panel.append(hint);

    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(button('Back', { primary: true, onClick: () => this.open(this.deps.returnPage || 'main') }));
    panel.append(row);
  }
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

export function kvTable(pairs) {
  const t = document.createElement('table');
  t.className = 'kv-table';
  for (const [k, v] of pairs) {
    const tr = document.createElement('tr');
    const tdk = document.createElement('td');
    tdk.className = 'k';
    tdk.textContent = k;
    const tdv = document.createElement('td');
    tdv.className = 'v';
    tdv.textContent = v;
    tr.append(tdk, tdv);
    t.append(tr);
  }
  return t;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
