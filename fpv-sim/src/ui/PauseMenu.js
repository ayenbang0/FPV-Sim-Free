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
import { button, heading, kvTable, selectRow, sliderRow, toggleRow } from './MainMenu.js';
import { formatTime } from './HUD.js';
import { listAirframes } from '../core/DroneTypes.js';

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
      button('Controller setup', { onClick: () => this.deps.onControllerSetup?.() }),
      button('Controller diagnostics', { onClick: () => this.deps.onDiagnostics?.() }),
      button('Settings', { onClick: () => this.deps.onSettings?.() }),
      button('Main menu', { ghost: true, onClick: () => this.deps.onMainMenu?.() }),
    );
    panel.append(row);

    /* ---- quick flight-mode switch (spec: available mid-flight) ---- */
    panel.append(heading('Aircraft'));
    panel.append(selectRow('Craft', {
      value: settings.get('droneType'),
      options: listAirframes().map((a) => ({ value: a.id, label: `${a.displayName} — ${a.className}` })),
      onChange: (v) => {
        // Loads the craft's rate/tilt profile too, then main.js rebuilds the
        // body and respawns — a 23 g whoop must not inherit a racer's velocity.
        settings.loadAirframeProfile(v);
        this.deps.onSettingsChanged?.();
        this.render();
      },
    }));

    const craftHint = document.createElement('p');
    craftHint.className = 'hint';
    const cur = listAirframes().find((a) => a.id === settings.get('droneType'));
    if (cur) {
      craftHint.textContent =
        `${cur.thrustToWeight.toFixed(1)}:1 thrust · ${Math.round(cur.topSpeed)} m/s top speed · ` +
        `hover near ${Math.round(cur.hoverThrottle * 100)}% throttle · ${cur.battery.label} pack. ` +
        'Switching craft respawns you at the spawn point.';
    }
    panel.append(craftHint);

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

    /* ---- flight tuning ---- */
    panel.append(heading('Flight tuning'));
    panel.append(sliderRow('TPA amount', {
      min: 0, max: 0.6, step: 0.01, value: settings.get('tpa').amount,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => {
        settings.set('tpa', { ...settings.get('tpa'), amount: v });
        this.deps.onSettingsChanged?.();
      },
    }));
    panel.append(sliderRow('Feedforward', {
      min: 0, max: 1, step: 0.01, value: settings.get('feedforward'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('feedforward', v); this.deps.onSettingsChanged?.(); },
    }));
    panel.append(toggleRow('Airmode', {
      value: settings.get('airmode'),
      hint: 'Keeps full stick authority at max throttle instead of clamping.',
      onChange: (v) => { settings.set('airmode', v); this.deps.onSettingsChanged?.(); },
    }));

    /* ---- visuals ---- */
    panel.append(heading('Visuals'));
    panel.append(sliderRow('FPV latency', {
      min: 0, max: 60, step: 1, value: settings.get('fpvLatency'),
      format: (v) => `${Math.round(v)} ms`,
      onInput: (v) => { settings.set('fpvLatency', v); this.deps.onSettingsChanged?.(); },
    }));
    panel.append(toggleRow('VTX breakup', {
      value: settings.get('vtxBreakup'),
      hint: 'Signal noise and tearing that grows with distance from spawn.',
      onChange: (v) => { settings.set('vtxBreakup', v); this.deps.onSettingsChanged?.(); },
    }));
    panel.append(sliderRow('Sun angle', {
      min: 0, max: 1, step: 0.01, value: settings.get('sunAngle'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('sunAngle', v); this.deps.onSettingsChanged?.(); },
    }));
    panel.append(sliderRow('Overcast', {
      min: 0, max: 1, step: 0.01, value: settings.get('overcast'),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { settings.set('overcast', v); this.deps.onSettingsChanged?.(); },
    }));

    /* ---- blackbox ---- */
    panel.append(heading('Blackbox'));
    panel.append(button('Download Blackbox CSV', {
      onClick: () => {
        import('../core/Blackbox.js')
          .then((m) => m.blackbox.downloadCsv())
          .catch(() => { /* blackbox unavailable or empty — no-op */ });
      },
    }));

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
