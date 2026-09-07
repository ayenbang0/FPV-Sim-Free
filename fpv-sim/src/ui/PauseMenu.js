/**
 * ui/PauseMenu.js
 * ---------------------------------------------------------------------------
 * The mid-flight pause screen.
 *
 * Opening this does not merely hide the HUD — main.js stops calling both the
 * physics step and the render tick, and discards the elapsed wall-clock time on
 * resume. That matters: a paused tab that "catches up" on ten seconds of
 * simulation the moment you close the menu will fling the drone through a wall,
 * which is exactly the failure section 4 of the spec calls out.
 *
 * Shares its widgets with MainMenu so the two screens look like one product.
 */

import { settings } from '../core/Settings.js';
import { button, heading, kvTable, selectRow } from './MainMenu.js';
import { formatTime } from './HUD.js';

export class PauseMenu {
  /**
   * @param {HTMLElement} root the #menu-root element
   * @param {object} deps
   */
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;   // { maps, onResume, onRestart, onChangeMap, onDiagnostics, onSettings, onMainMenu, getStats }
    this.isOpen = false;
  }

  open() {
    this.isOpen = true;
    this.render();
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.root.innerHTML = '';
  }

  render() {
    if (!this.isOpen) return;
    this.root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'panel';

    const h1 = document.createElement('h1');
    h1.textContent = 'PAUSED';
    panel.append(h1);

    const stats = this.deps.getStats?.() ?? {};
    const tag = document.createElement('p');
    tag.className = 'tagline';
    tag.textContent = stats.mapName
      ? `${stats.mapName} · simulation halted`
      : 'Simulation halted';
    panel.append(tag);

    /* ---- primary actions ---- */
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      button('Resume', { primary: true, onClick: () => this.deps.onResume?.() }),
      button('Restart flight', { onClick: () => this.deps.onRestart?.() }),
      button('Change map', { onClick: () => this.deps.onChangeMap?.() }),
      button('Controller diagnostics', { onClick: () => this.deps.onDiagnostics?.() }),
      button('Settings', { onClick: () => this.deps.onSettings?.() }),
      button('Main menu', { ghost: true, onClick: () => this.deps.onMainMenu?.() }),
    );
    panel.append(row);

    /* ---- quick flight-mode switch (spec: available mid-flight) ---- */
    panel.append(heading('Flight mode'));
    panel.append(selectRow('Mode', {
      options: [
        { value: 'angle', label: 'Angle — self-levelling (beginner)' },
        { value: 'acro', label: 'Acro — rate only (realistic)' },
      ],
      value: settings.get('flightMode'),
      onChange: (v) => {
        settings.set('flightMode', v);
        this.deps.onSettingsChanged?.();
      },
    }));

    const modeHint = document.createElement('p');
    modeHint.className = 'hint';
    modeHint.innerHTML = 'Also switchable in flight with <kbd>1</kbd> (Acro) and <kbd>2</kbd> (Angle).';
    panel.append(modeHint);

    /* ---- session stats ---- */
    panel.append(heading('This flight'));
    const rows = [
      ['Flight time', formatTime(stats.elapsed || 0)],
      ['Top speed', `${(stats.topSpeed || 0).toFixed(1)} m/s  (${((stats.topSpeed || 0) * 3.6).toFixed(0)} km/h)`],
      ['Max altitude', `${(stats.maxAltitude || 0).toFixed(1)} m`],
      ['Crashes', String(stats.crashes ?? 0)],
      ['Battery', `${(stats.battery ?? 0).toFixed(1)} V`],
    ];
    if (stats.gateCount) {
      rows.push(['Gates', `${Math.min(stats.gateIndex ?? 0, stats.gateCount)} / ${stats.gateCount}`]);
      rows.push(['Best lap', stats.best ? formatTime(stats.best) : 'not set']);
    }
    panel.append(kvTable(rows));

    /* ---- quick reference ---- */
    panel.append(heading('Quick reference'));
    panel.append(kvTable([
      ['Space', 'Arm / disarm'],
      ['W / S', 'Throttle'],
      ['Arrows', 'Pitch and roll'],
      ['A / D', 'Yaw'],
      ['R', 'Respawn'],
      ['Shift', 'Turtle flip'],
      ['C', 'Camera view'],
      ['Tab', 'HUD'],
      ['Esc', 'Resume'],
    ]));

    this.root.append(panel);
  }
}
