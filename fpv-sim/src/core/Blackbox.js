/**
 * core/Blackbox.js
 * ---------------------------------------------------------------------------
 * Flight-data recorder in the Betaflight Blackbox mould: a bounded ring
 * buffer of per-substep loop data, exportable as CSV.
 *
 * The controller pushes one row per physics substep (guarded by the
 * `blackbox` settings flag at the call site, so this module costs nothing
 * when recording is off). The buffer holds 30 s at 240 Hz (7200 rows);
 * older rows are dropped. `downloadCsv()` emits a Blob download whose
 * column order matches the Betaflight blackbox CSV export header, so the
 * file opens in any spreadsheet or log viewer.
 *
 * Everything here is allocation-free on push (fixed row shape, shift() on a
 * capped array) and teardown-safe (download degrades silently without DOM).
 */

const MAX_ROWS = 7200;   // 30 s at 240 Hz

const HEADER = [
  'loopIteration', 'time',
  'thr', 'pitch', 'roll', 'yaw',
  'spRoll', 'spPitch', 'spYaw',
  'm0', 'm1', 'm2', 'm3',
  'vbat', 'gyroR', 'gyroP', 'gyroY',
];

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

class Blackbox {
  constructor() {
    this.rows = [];
    this.iteration = 0;
  }

  /** Record one substep. Row shape is fixed; non-finite fields become 0. */
  push(row) {
    if (!row) return;
    this.rows.push([
      this.iteration++,
      num(row.t),
      num(row.thr), num(row.pitch), num(row.roll), num(row.yaw),
      num(row.spRoll), num(row.spPitch), num(row.spYaw),
      num(row.m0), num(row.m1), num(row.m2), num(row.m3),
      num(row.vbat), num(row.gyroR), num(row.gyroP), num(row.gyroY),
    ]);
    if (this.rows.length > MAX_ROWS) {
      this.rows.splice(0, this.rows.length - MAX_ROWS);
    }
  }

  clear() {
    this.rows.length = 0;
    this.iteration = 0;
  }

  toCsv() {
    const lines = [HEADER.join(',')];
    for (const r of this.rows) lines.push(r.join(','));
    return lines.join('\n');
  }

  /** Trigger a `blackbox.csv` download. Silent no-op without DOM. */
  downloadCsv() {
    try {
      if (typeof document === 'undefined' || typeof Blob === 'undefined') return false;
      const blob = new Blob([this.toCsv()], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'blackbox.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (_e) {
      return false;
    }
  }
}

export const blackbox = new Blackbox();
export { Blackbox, MAX_ROWS };
