/**
 * ui/HUD.js
 * ---------------------------------------------------------------------------
 * The on-screen display, styled after a real FPV goggle OSD: monospace, thin
 * green-on-transparent, parked in the screen corners so the centre of frame —
 * the part you actually fly with — stays clear.
 *
 * Implemented as DOM rather than drawn into the WebGL canvas. Text rendering in
 * Three.js means either a bitmap font atlas or an extra canvas texture upload
 * every frame; the browser's own text layout is sharper, free, and cannot fail
 * in a way that takes the renderer with it.
 *
 * Every field is written through a small `_set()` helper that skips the DOM
 * write when the value has not changed. At 120 fps, blindly assigning
 * `textContent` on a dozen nodes is enough layout churn to show up in a
 * profile; this keeps the HUD effectively free.
 */

import { BATT } from '../core/DroneController.js';
import { settings } from './../core/Settings.js';

export class HUD {
  /** @param {HTMLElement} root the #hud element */
  constructor(root) {
    this.root = root;
    this.visible = true;
    this._cache = new Map();

    this._build();
    this.setVisible(settings.get('hudVisible'));
  }

  /* ====================================================================== *
   * Construction
   * ====================================================================== */

  _build() {
    this.root.innerHTML = '';

    // --- top-left: battery + power -----------------------------------
    this.tl = el('div', 'hud-corner hud-tl');
    this.battVolts = el('div', 'hud-big');
    this.battBar = el('div', 'hud-label');
    this.battWarn = el('div', 'hud-med hud-danger');
    this.tl.append(this.battVolts, this.battBar, this.battWarn);

    // --- top-right: clock / lap --------------------------------------
    this.tr = el('div', 'hud-corner hud-tr');
    this.timerLabel = el('div', 'hud-label');
    this.timer = el('div', 'hud-big');
    this.gateInfo = el('div', 'hud-med');
    this.bestTime = el('div', 'hud-label');
    this.tr.append(this.timerLabel, this.timer, this.gateInfo, this.bestTime);

    // --- bottom-left: speed + altitude -------------------------------
    this.bl = el('div', 'hud-corner hud-bl');
    this.speed = el('div', 'hud-big');
    this.speedKmh = el('div', 'hud-label');
    this.altitude = el('div', 'hud-med');
    this.vario = el('div', 'hud-label');
    this.bl.append(this.speed, this.speedKmh, this.altitude, this.vario);

    // --- bottom-right: arm state + mode ------------------------------
    this.br = el('div', 'hud-corner hud-br');
    this.armState = el('div', 'hud-med');
    this.flightMode = el('div', 'hud-med');
    this.cameraMode = el('div', 'hud-label');
    this.inputSource = el('div', 'hud-label');
    this.mapName = el('div', 'hud-label');
    this.br.append(this.armState, this.flightMode, this.cameraMode, this.inputSource, this.mapName);

    // --- centre: reticle, horizon, big status ------------------------
    this.horizon = el('div', '');
    this.horizon.id = 'horizon';
    this.horizon.innerHTML = buildHorizonSvg();
    this.ladder = this.horizon.querySelector('#ladder');

    this.reticle = el('div', '');
    this.reticle.id = 'reticle';
    this.reticle.innerHTML = '<div class="v"></div><div class="h"></div><div class="dot"></div>';

    this.centerStatus = el('div', '');
    this.centerStatus.id = 'center-status';

    this.root.append(
      this.horizon, this.reticle, this.centerStatus,
      this.tl, this.tr, this.bl, this.br,
    );
  }

  /* ====================================================================== *
   * Visibility
   * ====================================================================== */

  setVisible(on) {
    this.visible = !!on;
    this.root.classList.toggle('hidden', !this.visible);
  }

  toggle() {
    this.setVisible(!this.visible);
    settings.set('hudVisible', this.visible);
    return this.visible;
  }

  /* ====================================================================== *
   * Per-frame update
   * ====================================================================== */

  /**
   * @param {object} s
   * @param {import('../core/DroneController.js').DroneController} s.drone
   * @param {object} s.input        InputManager.getStatus()
   * @param {string} s.cameraLabel
   * @param {object} s.race         { mode, elapsed, gateIndex, gateCount, best }
   * @param {string} s.mapName
   */
  update(s) {
    if (!this.visible) return;

    const d = s.drone;
    const t = d.telemetry;

    /* ---- battery ---- */
    const v = d.batteryVoltage;
    this._set(this.battVolts, `${v.toFixed(1)}V`);
    this._set(this.battBar, `${batteryBar(d.batteryCharge)}  ${Math.round(d.batteryCharge * 100)}%`);

    const stage = d.getBatteryStage();
    this.battVolts.classList.toggle('hud-warn', stage === 'low');
    this.battVolts.classList.toggle('hud-danger', stage === 'critical' || stage === 'cutoff');

    let warn = '';
    if (stage === 'cutoff') warn = 'PACK DEAD';
    else if (stage === 'critical') warn = 'LAND NOW';
    else if (stage === 'low') warn = 'LOW BATTERY';
    this._set(this.battWarn, warn);
    this.battWarn.classList.toggle('blink', stage === 'critical' || stage === 'cutoff');
    this.battWarn.classList.toggle('hud-warn', stage === 'low');
    this.battWarn.classList.toggle('hud-danger', stage !== 'low');

    /* ---- timer / race ---- */
    const race = s.race || {};
    this._set(this.timerLabel, race.mode === 'timetrial' ? 'TIME TRIAL' : 'CLOCK');
    this._set(this.timer, formatTime(race.elapsed || 0));

    if (race.mode === 'timetrial' && race.gateCount > 0) {
      this._set(this.gateInfo, `GATE ${Math.min(race.gateIndex + 1, race.gateCount)}/${race.gateCount}`);
      this._set(this.bestTime, race.best ? `BEST ${formatTime(race.best)}` : 'BEST --:--.--');
    } else {
      this._set(this.gateInfo, '');
      this._set(this.bestTime, '');
    }

    /* ---- speed / altitude ---- */
    this._set(this.speed, `${t.speed.toFixed(1)} m/s`);
    this._set(this.speedKmh, `${(t.speed * 3.6).toFixed(0)} KM/H`);
    this._set(this.altitude, `ALT ${t.altitude.toFixed(1)} m`);
    const vs = t.verticalSpeed;
    this._set(this.vario, `${vs >= 0 ? '▲' : '▼'} ${Math.abs(vs).toFixed(1)} m/s   HDG ${Math.round(t.headingDeg).toString().padStart(3, '0')}°`);

    /* ---- arm / modes ---- */
    this._set(this.armState, d.armed ? 'ARMED' : 'DISARMED');
    this.armState.classList.toggle('hud-danger', !d.armed);
    this._set(this.flightMode, `MODE: ${String(settings.get('flightMode')).toUpperCase()}`);
    this._set(this.cameraMode, `CAM: ${s.cameraLabel || 'FPV'}`);

    const inp = s.input || {};
    this._set(this.inputSource, `INPUT: ${inp.sourceLabel || 'KEYBOARD'}`);
    this._set(this.mapName, String(s.mapName || '').toUpperCase());

    /* ---- centre status ---- */
    let status = '';
    if (d.crashed) status = 'CRASHED<span class="sub">Press R to respawn</span>';
    else if (d.motorCutByBattery) status = 'BATTERY CUTOFF<span class="sub">Press R for a fresh pack</span>';
    else if (!d.armed) status = 'DISARMED<span class="sub">Press SPACE to arm</span>';
    this._setHtml(this.centerStatus, status);

    /* ---- artificial horizon ---- */
    this._updateHorizon(t.rollDeg, t.pitchDeg);
  }

  /**
   * Roll and pitch ladder.
   *
   * The ladder counter-rotates against roll and slides vertically with pitch,
   * so it stays aligned with the real horizon in the video feed. Sign note:
   * `pitchDeg` is positive nose-*down*, so the ladder slides down as the nose
   * drops — which is what puts the horizon line up near the top of frame.
   */
  _updateHorizon(rollDeg, pitchDeg) {
    if (!this.ladder) return;
    const on = settings.get('horizonLadder');
    if (this.horizon.style.display !== (on ? '' : 'none')) {
      this.horizon.style.display = on ? '' : 'none';
    }
    if (!on) return;

    const roll = Number.isFinite(rollDeg) ? rollDeg : 0;
    const pitch = clamp(Number.isFinite(pitchDeg) ? pitchDeg : 0, -90, 90);

    const transform = `rotate(${(-roll).toFixed(2)}) translate(0 ${(pitch * 4).toFixed(1)})`;
    if (this._lastHorizon !== transform) {
      this._lastHorizon = transform;
      this.ladder.setAttribute('transform', transform);
    }
  }

  /* ====================================================================== *
   * Helpers
   * ====================================================================== */

  /** Write text only when it actually changed. */
  _set(node, text) {
    const prev = this._cache.get(node);
    if (prev === text) return;
    this._cache.set(node, text);
    node.textContent = text;
  }

  _setHtml(node, html) {
    const prev = this._cache.get(node);
    if (prev === html) return;
    this._cache.set(node, html);
    node.innerHTML = html;
  }

  dispose() {
    this.root.innerHTML = '';
    this._cache.clear();
  }
}

/* ========================================================================== *
 * Pure helpers
 * ========================================================================== */

function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

/** mm:ss.hh — the format every race timer uses. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Ten-cell block gauge, the way a real OSD draws pack capacity. */
function batteryBar(charge) {
  const filled = Math.round(clamp(charge, 0, 1) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * The horizon ladder as static SVG: a long horizon bar plus pitch rungs every
 * 10 degrees, labelled. 4 px per degree matches `_updateHorizon`.
 */
function buildHorizonSvg() {
  const PX_PER_DEG = 4;
  const parts = [];

  // Horizon line, with a gap in the middle so it never hides the reticle.
  parts.push('<line x1="-190" y1="0" x2="-46" y2="0" stroke="currentColor" stroke-width="1.6"/>');
  parts.push('<line x1="46" y1="0" x2="190" y2="0" stroke="currentColor" stroke-width="1.6"/>');

  for (let deg = -60; deg <= 60; deg += 10) {
    if (deg === 0) continue;
    const y = deg * PX_PER_DEG;
    const half = deg % 20 === 0 ? 56 : 32;
    const dash = deg > 0 ? ' stroke-dasharray="7 5"' : '';   // below-horizon rungs dashed
    parts.push(`<line x1="${-half}" y1="${y}" x2="${-22}" y2="${y}" stroke="currentColor" stroke-width="1.2"${dash}/>`);
    parts.push(`<line x1="${22}" y1="${y}" x2="${half}" y2="${y}" stroke="currentColor" stroke-width="1.2"${dash}/>`);
    if (deg % 20 === 0) {
      const label = Math.abs(deg);
      parts.push(`<text x="${-half - 8}" y="${y + 4}" fill="currentColor" font-size="10" text-anchor="end" font-family="monospace">${label}</text>`);
      parts.push(`<text x="${half + 8}" y="${y + 4}" fill="currentColor" font-size="10" font-family="monospace">${label}</text>`);
    }
  }

  return `<svg width="440" height="460" viewBox="-220 -230 440 460" style="color: var(--osd)">
    <g id="ladder">${parts.join('')}</g>
  </svg>`;
}

export { BATT };
