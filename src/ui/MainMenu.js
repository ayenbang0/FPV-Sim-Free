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

import { settings, REMAPPABLE, defaultGamepadMapping, RATE_PRESETS, RATE_PRESET_IDS, RATES_TYPES, RADIO_PRESETS } from '../core/Settings.js';
import { SerialRx } from '../input/SerialRx.js';
import { applyRates, maxRcRate } from '../fc/rates.js';
import { CALIBRATABLE_AXES, CALIBRATION_STEPS, axisEndpoints } from '../core/InputManager.js';
import { listAirframes, airframeStats } from '../core/DroneTypes.js';
import { formatTime } from './HUD.js';
import { VIDEO_LATENCY_MS } from '../render/FpvVideo.js';

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

function numberCell(value, { min, max, step = 1, onChange }) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.style.width = '4.2em';
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    const c = Math.min(max, Math.max(min, v));
    input.value = String(c);
    onChange?.(c);
  });
  return input;
}

const RATE_LABELS = {
  actual: ['Center', 'Max', 'Expo'],
  betaflight: ['RC Rate', 'Super', 'Expo'],
  quick: ['RC Rate', 'Max', 'Expo'],
  kiss: ['RC Rate', 'Rate', 'RC Curve'],
  raceflight: ['Rate', 'Acro+', 'Expo'],
};

/** Draw all three axis curves of the current fcRates into a canvas. */
function drawRateCurve(canvas, rates) {
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const maxes = [0, 1, 2].map((a) => maxRcRate(rates.type, a, rates));
  const top = Math.max(200, ...maxes) * 1.05;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = h - (g / 4) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const colors = ['#ff6b6b', '#6bd4ff', '#ffd166'];
  for (let a = 0; a < 3; a++) {
    ctx.strokeStyle = colors[a];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      const v = applyRates(rates.type, a, x, rates);
      const px = x * w;
      const py = h - (v / top) * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = colors[a];
    ctx.font = '11px monospace';
    ctx.fillText(`${['R', 'P', 'Y'][a]} ${Math.round(maxes[a])}°/s`, 6, 14 + a * 13);
  }
}

/**
 * The Betaflight tuning widgets (rates, PIDs, masters, filters, airmode),
 * shared by the main Settings page and the pause menu.
 * @param {HTMLElement} panel
 * @param {() => void} changed   called after every settings write
 * @param {() => void} [rerender] rebuild the page (rates type / reset)
 */
export function renderBetaflightTuning(panel, changed, rerender) {
  const setRates = (patch) => {
    settings.set({ fcRates: { ...settings.get('fcRates'), ...patch }, ratePreset: 'custom' });
    changed();
  };
  const r = settings.get('fcRates');

  panel.append(heading('Betaflight — rates'));
  panel.append(selectRow('Rate preset', {
    options: RATE_PRESET_IDS.map((id) => ({ value: id, label: RATE_PRESETS[id].label })),
    value: settings.get('ratePreset'),
    onChange: (v) => { settings.loadRatePreset(v); changed(); rerender?.(); },
  }));
  panel.append(selectRow('Rates type', {
    options: RATES_TYPES.map((t) => ({ value: t, label: t === 'actual' ? 'Actual' : t === 'betaflight' ? 'Betaflight' : t === 'quick' ? 'Quick' : t === 'kiss' ? 'KISS' : 'RaceFlight' })),
    value: r.type,
    onChange: (v) => { setRates({ type: v }); rerender?.(); },
  }));

  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 120;
  canvas.style.cssText = 'display:block;margin:6px 0 10px;background:rgba(0,0,0,0.35);border-radius:4px';

  const labels = RATE_LABELS[r.type] || RATE_LABELS.betaflight;
  const table = document.createElement('table');
  table.className = 'kv';
  const head = document.createElement('tr');
  for (const t of ['', ...labels]) {
    const th = document.createElement('th');
    th.textContent = t;
    head.append(th);
  }
  table.append(head);
  const rateMax = r.type === 'actual' ? 200 : 255;
  ['Roll', 'Pitch', 'Yaw'].forEach((name, axis) => {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td');
    td0.textContent = name;
    tr.append(td0);
    for (const [key, min, max] of [['rcRates', 1, 255], ['rates', 0, rateMax], ['rcExpo', 0, 100]]) {
      const td = document.createElement('td');
      td.append(numberCell(settings.get('fcRates')[key][axis], {
        min, max,
        onChange: (v) => {
          const arr = settings.get('fcRates')[key].slice();
          arr[axis] = Math.round(v);
          setRates({ [key]: arr });
          drawRateCurve(canvas, settings.get('fcRates'));
        },
      }));
      tr.append(td);
    }
    table.append(tr);
  });
  panel.append(table, canvas);
  drawRateCurve(canvas, r);
  const unitHint = document.createElement('p');
  unitHint.className = 'hint';
  unitHint.textContent = r.type === 'actual'
    ? 'Actual rates, Betaflight units: Center and Max are deg/s ÷ 10, Expo in %.'
    : 'Betaflight units, exactly as the Configurator shows them (×100 values as integers).';
  panel.append(unitHint);

  /* ---- PIDs ---- */
  panel.append(heading('Betaflight — PID tuning'));
  const pt = document.createElement('table');
  pt.className = 'kv';
  const ph = document.createElement('tr');
  for (const t of ['', 'P', 'I', 'D', 'D max', 'F']) {
    const th = document.createElement('th');
    th.textContent = t;
    ph.append(th);
  }
  pt.append(ph);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td');
    td0.textContent = cap(axis);
    tr.append(td0);
    for (const [key, max] of [['p', 250], ['i', 250], ['d', 250], ['dMax', 250], ['f', 1000]]) {
      const td = document.createElement('td');
      td.append(numberCell(settings.get('fcPid')[axis][key], {
        min: 0, max,
        onChange: (v) => {
          const pid = settings.get('fcPid');
          settings.set('fcPid', { ...pid, [axis]: { ...pid[axis], [key]: Math.round(v) } });
          changed();
        },
      }));
      tr.append(td);
    }
    pt.append(tr);
  }
  panel.append(pt);

  const pidSlider = (label, key, min, max, fmt) => sliderRow(label, {
    min, max, step: 1, value: settings.get('fcPid')[key], format: fmt || ((v) => String(Math.round(v))),
    onInput: (v) => { settings.set('fcPid', { ...settings.get('fcPid'), [key]: Math.round(v) }); changed(); },
  });
  const misc = (label, key, min, max, step, fmt) => sliderRow(label, {
    min, max, step, value: settings.get('fcMisc')[key], format: fmt || ((v) => String(v)),
    onInput: (v) => { settings.set('fcMisc', { ...settings.get('fcMisc'), [key]: v }); changed(); },
  });
  const filt = (label, key, min, max) => sliderRow(label, {
    min, max, step: 1, value: settings.get('fcFilters')[key], format: (v) => (v > 0 ? `${Math.round(v)} Hz` : 'off'),
    onInput: (v) => { settings.set('fcFilters', { ...settings.get('fcFilters'), [key]: Math.round(v) }); changed(); },
  });

  panel.append(pidSlider('Angle limit', 'angleLimit', 10, 90, (v) => `${Math.round(v)}°`));
  panel.append(pidSlider('Angle strength (level P)', 'levelP', 0, 200));
  panel.append(misc('Anti-gravity gain', 'antiGravityGain', 0, 250, 1));
  panel.append(misc('I-term relax cutoff', 'itermRelaxCutoff', 1, 50, 1, (v) => `${v} Hz`));
  panel.append(misc('TPA rate', 'tpaRate', 0, 100, 1, (v) => `${v}%`));
  panel.append(misc('TPA breakpoint', 'tpaBreakpoint', 1000, 2000, 10, (v) => `${v} µs`));
  panel.append(misc('Throttle boost', 'throttleBoost', 0, 100, 1));
  panel.append(misc('Dshot idle', 'dshotIdle', 0, 20, 0.1, (v) => `${Number(v).toFixed(1)}%`));
  panel.append(misc('FF jitter reduction', 'ffJitter', 0, 20, 1));
  panel.append(misc('FF smoothness', 'ffSmooth', 0, 95, 1));
  panel.append(misc('FF boost', 'ffBoost', 0, 50, 1));
  panel.append(toggleRow('Airmode', {
    value: settings.get('fcMisc').airmode,
    hint: 'Full rotation authority at zero and full throttle.',
    onChange: (v) => { settings.set('fcMisc', { ...settings.get('fcMisc'), airmode: v }); changed(); },
  }));

  panel.append(heading('Betaflight — filters'));
  panel.append(filt('Gyro LPF1 dynamic min', 'gyroLpf1Min', 0, 1000));
  panel.append(filt('Gyro LPF1 dynamic max', 'gyroLpf1Max', 0, 1000));
  panel.append(filt('Gyro LPF2', 'gyroLpf2', 0, 1000));
  panel.append(filt('D-term LPF1 dynamic min', 'dtermLpf1Min', 0, 500));
  panel.append(filt('D-term LPF1 dynamic max', 'dtermLpf1Max', 0, 500));
  panel.append(filt('D-term LPF2', 'dtermLpf2', 0, 500));
  panel.append(filt('Yaw lowpass', 'yawLowpass', 0, 500));
  panel.append(toggleRow('RPM filter', {
    value: settings.get('fcFilters').rpmFilter,
    onChange: (v) => { settings.set('fcFilters', { ...settings.get('fcFilters'), rpmFilter: v }); changed(); },
  }));

  const row = document.createElement('div');
  row.className = 'btn-row';
  row.append(button('Reset to airframe tune', {
    small: true,
    onClick: () => { settings.loadAirframeProfile(settings.get('droneType')); changed(); rerender?.(); },
  }));
  panel.append(row);
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

  open(page = 'main', section = null) {
    this.page = page;
    // Deep-link target inside the launcher (e.g. 'maps', 'quads', 'modes',
    // 'settings'). The pause menu sets location.hash before returning here,
    // so in-game "back to X" links land on the right launcher section
    // without main.js having to thread another callback through.
    this.pendingSection = section;
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

    // Keyboard escape hatch: Esc on any subpage goes back, matching the
    // Back buttons below. Safe against main.js: in the launcher state its
    // own Esc path is a no-op (resume() only fires from 'paused').
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.page !== 'main') {
        e.stopPropagation();
        this.open(this.deps.returnPage || 'main');
      }
    });

    // The calibration page shows live axis values, so it needs a repaint loop
    // for as long as it is the visible page.
    this._syncCalibrationTimer();
  }

  /* ---------------------------------------------------------------------- *
   * Main page
   * ---------------------------------------------------------------------- */

  _renderMain(panel) {
    const maps = this.deps.maps;
    const quads = listAirframes();
    const h1 = document.createElement('h1');
    h1.textContent = 'FPV DRONE SIMULATOR';
    const tag = document.createElement('p');
    tag.className = 'tagline';
    tag.textContent =
      `Rate-based acro flight model · keyboard or gamepad · ${maps.length} sceneries · ${quads.length} quads`;
    panel.append(h1, tag);

    /* ---- in-launcher section nav (mouse + keyboard, mirrors pause back-links) ---- */
    const nav = document.createElement('nav');
    nav.className = 'section-nav';
    nav.setAttribute('aria-label', 'Launcher sections');
    const sections = [
      ['modes', 'Modes'],
      ['maps', 'Sceneries'],
      ['quads', 'Quads'],
      ['setup', 'Setup'],
    ];
    for (const [id, label] of sections) {
      const a = document.createElement('a');
      a.href = `#launch-${id}`;
      a.textContent = label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this._scrollToSection(id, true);
      });
      nav.append(a);
    }
    panel.append(nav);

    /* ---- 1. modes ---- */
    panel.append(this._sectionHead('launch-modes', 'Fly now — pick a mode'));
    panel.append(this._buildModeCards());

    /* ---- 2. sceneries ---- */
    panel.append(this._sectionHead('launch-maps', 'Sceneries'));
    panel.append(selectRow('Gate spec', {
      options: [
        { value: 'league', label: 'League gates (as built)' },
        { value: 'multigp', label: 'MultiGP spec (5 ft square, 10×5 ft hurdle)' },
      ],
      value: settings.get('gateSpec'),
      onChange: (v) => {
        settings.set('gateSpec', v);
        this.deps.onSettingsChanged?.();
        this.deps.onToast?.('info', 'Reload map to apply');
      },
    }));
    panel.append(this._buildMapGrid());

    /* ---- 3. quads ---- */
    panel.append(this._sectionHead('launch-quads', 'Quads'));
    panel.append(this._buildDronePicker());

    /* ---- 4. setup ---- */
    panel.append(this._sectionHead('launch-setup', 'Setup'));
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      button('Start flight', { primary: true, onClick: () => this._start() }),
      button('Settings', { onClick: () => this.open('settings') }),
      button('Controls', { onClick: () => this.open('controls') }),
    );
    panel.append(row);
    panel.append(this._inputStatusLine());

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '14px';
    const spec = quads.find((a) => a.id === settings.get('droneType')) || quads[1];
    hint.innerHTML =
      'First time flying? Take the <strong>Tinywhoop</strong> indoors and leave the mode on <strong>ANGLE</strong> — ' +
      'it self-levels when you let go of the sticks. Press <kbd>Space</kbd> to arm, then hold <kbd>W</kbd> until you lift off ' +
      `(on the ${spec.displayName}, hover sits near <strong>${Math.round(spec.hoverThrottle * 100)}%</strong> throttle).`;
    panel.append(hint);

    panel.append(this._navHints(
      '<kbd>Tab</kbd> move · <kbd>Enter</kbd> select / fly · <kbd>Esc</kbd> back · ' +
      'every card flies with one click on its Fly button, double-click also launches a scenery.',
    ));

    // Deep-link landing: pause-menu back-links (and a raw #hash on load) land here.
    const wanted = this.pendingSection || (location.hash || '').replace('#launch-', '');
    this.pendingSection = null;
    if (wanted && ['modes', 'maps', 'quads', 'setup'].includes(wanted)) {
      requestAnimationFrame(() => this._scrollToSection(wanted, false));
    }
  }

  /** h2 with a stable anchor id shared with the pause-menu back-links. */
  _sectionHead(id, text) {
    const wrap = document.createElement('div');
    wrap.className = 'launch-section';
    wrap.id = id;
    wrap.tabIndex = -1;
    const h = document.createElement('h2');
    h.textContent = text;
    h.style.marginBottom = '0';
    wrap.append(h);
    return wrap;
  }

  _scrollToSection(id, focus) {
    const target = this.root.querySelector(`#launch-${id}`);
    if (!target) return;
    try { location.hash = `launch-${id}`; } catch (_e) { /* hash optional */ }
    for (const s of this.root.querySelectorAll('.launch-section')) s.classList.remove('highlight');
    target.classList.add('highlight');
    try { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_e) { /* ignore */ }
    if (focus) {
      try { target.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
    }
  }

  /** Velocidrone-style mode cards: each one launches, none is a dead button. */
  _buildModeCards() {
    const grid = document.createElement('div');
    grid.className = 'map-grid';

    const weekly = this._weeklyInfo();
    const modes = [
      {
        name: 'Free Flight', desc: 'Clock only — explore the selected scenery at your own pace.',
        keys: 'Launches the selected scenery below',
        onFly: () => this._start(),
      },
      {
        name: 'Time Trial', desc: 'Gated sceneries run the trial clock automatically from first throttle.',
        keys: 'Launches the selected scenery below',
        onFly: () => this._start(),
      },
      {
        name: `Weekly: ${weekly.displayName}`,
        desc: `Week ${weekly.weekNumber} time trial — one scenery, same for everyone, all week.`,
        keys: 'One-click fly · Time Trial rules',
        onFly: () => this._startWeekly(weekly),
      },
    ];
    for (const m of modes) {
      const card = document.createElement('button');
      card.className = 'mode-card';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = m.name.toUpperCase();
      const ds = document.createElement('div');
      ds.className = 'desc';
      ds.textContent = m.desc;
      const ky = document.createElement('div');
      ky.className = 'keys';
      ky.textContent = m.keys;
      card.append(nm, ds, ky);
      card.addEventListener('click', m.onFly);
      grid.append(card);
    }

    const wrap = document.createElement('div');
    wrap.append(grid);

    // Weekly banner: names the pick and its local bests, with its own fly button.
    const banner = document.createElement('div');
    banner.className = 'weekly-banner';
    const best = settings.get('bestTimes') || {};
    const open = best[weekly.mapId] != null ? formatTime(best[weekly.mapId]) : '—';
    const wk = best[`weekly.${weekly.mapId}`] != null ? formatTime(best[`weekly.${weekly.mapId}`]) : '—';
    banner.innerHTML =
      `<strong>WEEK ${weekly.weekNumber}</strong> · ${weekly.displayName} — ` +
      `open best ${open} · weekly best ${wk}.`;
    const flyRow = document.createElement('div');
    flyRow.className = 'card-fly';
    flyRow.append(button('Fly the weekly', { primary: true, small: true, onClick: () => this._startWeekly(weekly) }));
    banner.append(flyRow);
    wrap.append(banner);

    // Nemesis ghost toggle lives with the modes (GhostWeekly owns the
    // playback in main.js; this only flips the shared settings key).
    wrap.append(toggleRow('Nemesis ghost rival', {
      value: settings.get('ghostVisible'),
      hint: 'Semi-transparent recording of the stored lap. N toggles it mid-flight.',
      onChange: (v) => { settings.set('ghostVisible', v); this.deps.onSettingsChanged?.(); },
    }));
    return wrap;
  }

  /**
   * This week's trial. Prefers GhostWeekly's wiring when main.js provides it;
   * otherwise falls back to the same deterministic pick locally so the card
   * still launches the right scenery.
   */
  _weeklyInfo() {
    try {
      const wired = this.deps.getWeeklyInfo?.();
      if (wired && wired.mapId) return wired;
    } catch (_e) { /* fall through to the local pick */ }
    const maps = this.deps.maps;
    const weekNumber = Math.floor(Date.now() / (7 * 86400 * 1000));
    const meta = maps.length ? maps[weekNumber % maps.length] : null;
    return {
      weekNumber,
      mapId: meta?.id ?? 'field',
      displayName: meta?.displayName ?? 'Open Field',
    };
  }

  _startWeekly(weekly) {
    const info = weekly || this._weeklyInfo();
    if (this.deps.onStartWeekly) this.deps.onStartWeekly(info.mapId);
    else this._start(info.mapId);
  }

  _buildMapGrid() {
    const grid = document.createElement('div');
    grid.className = 'map-grid';
    const bests = settings.get('bestTimes') || {};

    for (const meta of this.deps.maps) {
      const cell = document.createElement('div');
      const card = document.createElement('button');
      card.className = `map-card${meta.id === this.selectedMap ? ' selected' : ''}`;

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.style.background = meta.accent;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = meta.badge
        ? `${meta.displayName}  ★${meta.badge}`
        : meta.displayName;

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = meta.description;

      card.append(thumb, name, desc);
      const facts = [];
      if (meta.category) facts.push(meta.category);
      if (meta.size) facts.push(meta.size);
      if (meta.gates) facts.push(`${meta.gates}-gate course`);
      if (facts.length) {
        const line = document.createElement('div');
        line.className = 'desc';
        line.style.color = 'var(--osd-dim)';
        line.textContent = facts.join(' · ');
        card.append(line);
      }
      const best = bests[meta.courseKey || meta.id];
      if (Number.isFinite(best)) {
        const line = document.createElement('div');
        line.className = 'best-line';
        line.textContent = `BEST ${formatTime(best)}`;
        card.append(line);
      }
      // Single click selects; double click selects and launches.
      card.addEventListener('click', () => {
        this.selectedMap = meta.id;
        this.render();
        this._scrollToSection('maps', false);
      });
      card.addEventListener('dblclick', () => {
        this.selectedMap = meta.id;
        this._start();
      });
      cell.append(card);

      // One-click fly: keyboard users Tab here and press Enter.
      const flyRow = document.createElement('div');
      flyRow.className = 'card-fly';
      flyRow.append(button(`Fly ${meta.displayName}`, {
        small: true, primary: meta.id === this.selectedMap,
        onClick: () => { this.selectedMap = meta.id; this._start(); },
      }));
      cell.append(flyRow);
      grid.append(cell);
    }
    return grid;
  }

  _navHints(html) {
    const p = document.createElement('p');
    p.className = 'nav-hints';
    p.innerHTML = html;
    return p;
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
        this._scrollToSection('quads', false);
      });
      const cell = document.createElement('div');
      cell.append(card);
      // One-click fly: loads the profile, then launches the selected scenery.
      const flyRow = document.createElement('div');
      flyRow.className = 'card-fly';
      flyRow.append(button(`Fly ${spec.displayName}`, {
        small: true, primary: spec.id === current,
        onClick: () => {
          settings.loadAirframeProfile(spec.id);
          this.deps.onSettingsChanged?.();
          this._start();
        },
      }));
      cell.append(flyRow);
      grid.append(cell);
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

    panel.append(selectRow('Load radio preset', {
      options: [{ value: '', label: '— choose —' },
        ...Object.entries(RADIO_PRESETS).map(([id, p]) => ({ value: id, label: p.label }))],
      value: '',
      onChange: (v) => {
        if (!v) return;
        settings.loadRadioPreset(v);
        this.deps.onSettingsChanged?.();
        this.render();
      },
    }));

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

  _start(mapId) {
    this.deps.onStart?.(mapId ?? this.selectedMap);
  }

  /* ---------------------------------------------------------------------- *
   * Settings page
   * ---------------------------------------------------------------------- */

  /**
   * Settings → Radio: source status, 16-channel monitor, channel map, the
   * Betaflight Modes editor, and the WebSerial receiver connection.
   */
  _renderRadio(panel, changed) {
    const input = this.deps.input;
    panel.append(heading('Radio'));

    const status = document.createElement('p');
    status.className = 'hint';
    panel.append(status);

    const mon = document.createElement('div');
    const bars = [];
    const names = ['ROLL', 'PITCH', 'THR', 'YAW'];
    for (let i = 0; i < 16; i++) {
      const line = document.createElement('div');
      line.className = 'axis-line';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = i < 4 ? names[i] : `AUX${i - 3}`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.style.cssText = 'position:absolute;top:0;bottom:0;left:0;background:var(--accent,#5cf);opacity:0.8';
      bar.append(fill);
      const val = document.createElement('span');
      val.style.cssText = 'flex:0 0 44px;text-align:right';
      line.append(nm, bar, val);
      mon.append(line);
      bars.push({ fill, val });
    }
    panel.append(mon);

    const tickMonitor = () => {
      if (!mon.isConnected) return;
      const ch = input?.controls?.channels;
      if (ch) {
        for (let i = 0; i < 16; i++) {
          const v = ch[i];
          bars[i].fill.style.width = `${Math.max(0, Math.min(100, (v - 1000) / 10))}%`;
          bars[i].val.textContent = String(Math.round(v));
        }
      }
      const src = input?.activeSource || 'keyboard';
      const ser = input?.serial;
      status.textContent = `Source: ${src.toUpperCase()}` +
        (input?.controls?.switchArming ? ' · arming by ARM switch' : ' · arming by button / SPACE') +
        (ser && ser.connected ? ` · receiver ${Math.round(ser.stats.fps)} fps` +
          (Number.isFinite(ser.stats.lq) ? ` · LQ ${ser.stats.lq}` : '') + ` · ${ser.stats.errors} CRC errors` : '');
      requestAnimationFrame(tickMonitor);
    };
    requestAnimationFrame(tickMonitor);

    panel.append(selectRow('Channel map', {
      options: [{ value: 'AETR', label: 'AETR (Betaflight default)' }, { value: 'TAER', label: 'TAER (Spektrum / Futaba)' }],
      value: settings.get('rxChannelMap'),
      onChange: (v) => { settings.set('rxChannelMap', v); changed(); },
    }));

    /* ---- modes editor ---- */
    const modesHead = document.createElement('p');
    modesHead.className = 'hint';
    modesHead.textContent = 'Modes (Betaflight Modes tab): a mode is active while its channel is inside the range.';
    panel.append(modesHead);
    const modeIds = ['ARM', 'ANGLE', 'HORIZON', 'FLIPOVERAFTERCRASH', 'BEEPER', 'PREARM'];
    const writeModes = (list) => { settings.set('modes', list); changed(); };
    for (const id of modeIds) {
      const cur = settings.get('modes').find((m) => m.mode === id);
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = id === 'FLIPOVERAFTERCRASH' ? 'CRASH FLIP' : id;
      const sel = document.createElement('select');
      for (const [v, t] of [['-1', 'off'], ...Array.from({ length: 12 }, (_, i) => [String(i + 4), `AUX ${i + 1}`])]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if ((cur ? String(cur.channel) : '-1') === v) o.selected = true;
        sel.append(o);
      }
      const mk = (val) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '900'; inp.max = '2100'; inp.step = '25';
        inp.value = String(val); inp.style.width = '4.6em';
        return inp;
      };
      const lo = mk(cur ? cur.min : 1700);
      const hi = mk(cur ? cur.max : 2100);
      const commit = () => {
        const list = settings.get('modes').filter((m) => m.mode !== id);
        const chn = parseInt(sel.value, 10);
        if (chn >= 4) list.push({ mode: id, channel: chn, min: parseInt(lo.value, 10) || 900, max: parseInt(hi.value, 10) || 2100 });
        writeModes(list);
      };
      sel.addEventListener('change', commit);
      lo.addEventListener('change', commit);
      hi.addEventListener('change', commit);
      row.append(lab, sel, lo, hi);
      panel.append(row);
    }

    /* ---- serial receiver ---- */
    panel.append(selectRow('Serial protocol', {
      options: [{ value: 'crsf', label: 'CRSF (ELRS / Crossfire)' }, { value: 'sbus', label: 'SBUS' }],
      value: settings.get('serialProtocol'),
      onChange: (v) => { settings.set('serialProtocol', v); changed(); this.render(); },
    }));
    if (settings.get('serialProtocol') === 'crsf') {
      panel.append(selectRow('CRSF baud', {
        options: [420000, 416666, 921600].map((b) => ({ value: String(b), label: String(b) })),
        value: String(settings.get('serialBaud')),
        onChange: (v) => { settings.set('serialBaud', parseInt(v, 10)); changed(); },
      }));
    }
    const serRow = document.createElement('div');
    serRow.className = 'btn-row';
    const supported = SerialRx.supported();
    const connectBtn = button(input?.serial?.connected ? 'Reconnect receiver' : 'Connect receiver', {
      small: true, primary: true,
      onClick: async () => {
        try {
          await input.connectSerial({ protocol: settings.get('serialProtocol'), baud: settings.get('serialBaud') });
        } catch (err) {
          status.textContent = `Serial: ${err?.message || err}`;
        }
      },
    });
    connectBtn.disabled = !supported;
    serRow.append(connectBtn);
    panel.append(serRow);
    const serHint = document.createElement('p');
    serHint.className = 'hint';
    serHint.textContent = !supported
      ? 'WebSerial needs Chrome/Edge'
      : settings.get('serialProtocol') === 'sbus'
        ? 'SBUS needs an uninverted signal (an F4 uninverted pad or an inverter).'
        : 'Wire the receiver\'s TX to a USB-serial adapter (or use FC passthrough) and connect.';
    panel.append(serHint);
  }

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
        { value: 'serial', label: 'Serial receiver (CRSF / SBUS)' },
      ],
      value: settings.get('inputMode'),
      onChange: (v) => { settings.set('inputMode', v); changed(); },
    }));

    panel.append(sliderRow('RC deadband', {
      min: 0, max: 50, step: 1, value: settings.get('rcDeadband'),
      format: (v) => `${Math.round(v)} µs`,
      onInput: (v) => { settings.set('rcDeadband', Math.round(v)); changed(); },
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

    /* ---- Radio ---- */
    this._renderRadio(panel, changed);

    /* ---- Betaflight ---- */
    renderBetaflightTuning(panel, changed, () => this.render());

    /* ---- simulation ---- */
    panel.append(heading('Simulation'));
    panel.append(selectRow('Tick rate', {
      options: [
        { value: '2000', label: '2 kHz — maximum fidelity' },
        { value: '1000', label: '1 kHz — recommended' },
        { value: '500', label: '500 Hz — lowest CPU cost' },
      ],
      value: String(settings.get('simRate')),
      onChange: (v) => { settings.set('simRate', parseInt(v, 10)); changed(); },
    }));
    const rateHint = document.createElement('p');
    rateHint.className = 'hint';
    rateHint.textContent =
      'The Betaflight PID loop rate. Higher means lower control latency and cleaner filtering; ' +
      'the filters are rebuilt for the new rate, as on a real flight controller.';
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
        { value: 'horizon', label: 'Horizon — levels at centre stick' },
        { value: 'acro', label: 'Acro — rate only (realistic)' },
      ],
      value: settings.get('flightMode'),
      onChange: (v) => { settings.set('flightMode', v); changed(); },
    }));
    panel.append(toggleRow('Wind (outdoor maps)', {
      value: settings.get('wind'),
      hint: 'Adds a gusting lateral force. Good practice, harder hovering.',
      onChange: (v) => { settings.set('wind', v); changed(); },
    }));

    /* ---- camera ---- */
    panel.append(heading('Camera'));
    panel.append(selectRow('FPV lens', {
      options: [
        { value: 'fisheye', label: 'Fisheye — fast, full effects' },
        { value: 'fisheye-cube', label: 'Fisheye (cube) — true 170°, fewer effects' },
        { value: 'rectilinear', label: 'Rectilinear — flat perspective (max 150°)' },
      ],
      value: settings.get('fpvLens'),
      onChange: (v) => { settings.set('fpvLens', v); changed(); this.render(); },
    }));
    if (settings.get('fpvLens') === 'fisheye-cube') {
      const cubeHint = document.createElement('p');
      cubeHint.className = 'hint';
      cubeHint.textContent =
        'Cube mode renders five camera faces per frame. Ambient occlusion, reflections, ' +
        'temporal AA and motion blur are skipped in this mode.';
      panel.append(cubeHint);
    }
    panel.append(sliderRow('Field of view (horizontal)', {
      min: 70, max: 170, step: 1, value: settings.get('fov'),
      format: (v) => `${Math.round(v)}°`,
      onInput: (v) => { settings.set('fov', v); changed(); },
    }));
    panel.append(sliderRow('Fisheye strength', {
      min: 0, max: 1, step: 0.01, value: settings.get('lensFisheye'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('lensFisheye', v); changed(); },
    }));
    panel.append(toggleRow('Props in view', {
      value: settings.get('propsInView'),
      hint: 'Prop blur at the frame edges, like a real 5" on a wide lens.',
      onChange: (v) => { settings.set('propsInView', v); changed(); },
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
    panel.append(selectRow('Video system', {
      options: [
        { value: 'hd', label: 'HD digital (DJI O4 / Walksnail)' },
        { value: 'analog', label: 'Analog 5.8 GHz (4:3, CRT goggle)' },
      ],
      value: settings.get('videoSystem'),
      onChange: (v) => {
        // Each system brings its own glass-to-glass latency.
        settings.set({ videoSystem: v, fpvLatency: VIDEO_LATENCY_MS[v] ?? 28 });
        changed();
        this.render();
      },
    }));
    panel.append(toggleRow('Artificial horizon ladder', {
      value: settings.get('horizonLadder'),
      onChange: (v) => { settings.set('horizonLadder', v); changed(); },
    }));

    /* ---- graphics (performance-first: heavy FX default off) ---- */
    panel.append(heading('Graphics'));
    panel.append(selectRow('Quality', {
      options: [
        { value: 'auto', label: 'Auto — picked from your GPU' },
        { value: 'low', label: 'Low — integrated GPUs, max framerate' },
        { value: 'medium', label: 'Medium — balanced' },
        { value: 'high', label: 'High — discrete GPUs' },
        { value: 'ultra', label: 'Ultra — high-end GPUs' },
      ],
      value: settings.get('graphicsQuality') || 'auto',
      onChange: (v) => { settings.set('graphicsQuality', v); changed(); },
    }));
    panel.append(selectRow('Renderer', {
      options: [
        { value: 'auto', label: 'Auto — WebGPU, WebGL2 fallback' },
        { value: 'webgpu', label: 'WebGPU' },
        { value: 'webgl2', label: 'WebGL2 (compatibility)' },
      ],
      value: settings.get('renderBackend') || 'auto',
      onChange: (v) => { settings.set('renderBackend', v); changed(); this.render(); },
    }));
    const beHint = document.createElement('p');
    beHint.className = 'hint';
    beHint.textContent = 'Renderer changes apply when the page is reloaded.';
    panel.append(beHint);
    const qHint = document.createElement('p');
    qHint.className = 'hint';
    qHint.textContent =
      'Shadow sharpness and range, view distance, grass and tree density, texture filtering. ' +
      'Terrain and vegetation detail apply on the next map load.';
    panel.append(qHint);
    panel.append(toggleRow('Sun shadows', {
      value: settings.get('shadows'),
      hint: 'Cascaded sun shadows outdoors (medium and up). Off = fastest.',
      onChange: (v) => { settings.set('shadows', v); changed(); },
    }));
    panel.append(toggleRow('Bloom glow', {
      value: settings.get('bloom'),
      hint: 'Lamps, windows and gates glow. Costs a few ms.',
      onChange: (v) => { settings.set('bloom', v); changed(); },
    }));
    panel.append(sliderRow('Bloom strength', {
      min: 0, max: 1.2, step: 0.05, value: settings.get('bloomStrength'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('bloomStrength', v); changed(); },
    }));
    panel.append(toggleRow('Motion blur', {
      value: settings.get('motionBlur'),
      hint: 'Per-pixel velocity blur, stronger at speed.',
      onChange: (v) => { settings.set('motionBlur', v); changed(); },
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
