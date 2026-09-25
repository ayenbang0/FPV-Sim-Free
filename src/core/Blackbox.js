/**
 * core/Blackbox.js
 * ---------------------------------------------------------------------------
 * Flight-data recorder in the Betaflight Blackbox mould: a bounded ring
 * buffer of per-substep loop data, exportable as CSV.
 *
 * The controller pushes one row per flight-controller loop (guarded by the
 * `blackbox` settings flag at the call site, so this module costs nothing
 * when recording is off). The buffer holds 30 s at 1 kHz (30000 rows); older
 * rows are dropped. `downloadCsv()` emits a Blob download whose columns
 * follow Betaflight's blackbox CSV export names, with `time` in sim seconds.
 *
 * Teardown-safe: download degrades silently without DOM.
 */

const MAX_ROWS = 30000;   // 30 s at 1 kHz

const HEADER = [
  'loopIteration', 'time',
  'rcCommand0', 'rcCommand1', 'rcCommand2', 'rcCommand3',
  'setpoint0', 'setpoint1', 'setpoint2',
  'gyroADC0', 'gyroADC1', 'gyroADC2',
  'axisP0', 'axisP1', 'axisP2',
  'axisI0', 'axisI1', 'axisI2',
  'axisD0', 'axisD1', 'axisD2',
  'axisF0', 'axisF1', 'axisF2',
  'motor0', 'motor1', 'motor2', 'motor3',
  'rpm0', 'rpm1', 'rpm2', 'rpm3',
  'vbat', 'amperage',
];

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

const at = (a, i) => num(a ? a[i] : 0);

class Blackbox {
  constructor() {
    this.rows = [];
    this._head = 0;   // index of the oldest row once the buffer is full
    this.iteration = 0;
  }

  /**
   * Record one FC loop: `{ loopIteration, time, rcCommand[4], setpoint[3],
   * gyroADC[3], axisP/I/D/F[3], motor[4], rpm[4], vbat, amperage }`.
   * Non-finite fields become 0.
   */
  push(row) {
    if (!row) return;
    const r = [
      Number.isFinite(row.loopIteration) ? row.loopIteration : this.iteration,
      num(row.time),
    ];
    for (let i = 0; i < 4; i++) r.push(at(row.rcCommand, i));
    for (const k of ['setpoint', 'gyroADC', 'axisP', 'axisI', 'axisD', 'axisF']) {
      for (let i = 0; i < 3; i++) r.push(at(row[k], i));
    }
    for (let i = 0; i < 4; i++) r.push(at(row.motor, i));
    for (let i = 0; i < 4; i++) r.push(Math.round(at(row.rpm, i)));
    r.push(num(row.vbat), num(row.amperage));
    this.iteration++;
    // Ring buffer: overwrite the oldest row once full (O(1) per loop).
    if (this.rows.length < MAX_ROWS) {
      this.rows.push(r);
    } else {
      this.rows[this._head] = r;
      this._head = (this._head + 1) % MAX_ROWS;
    }
  }

  clear() {
    this.rows.length = 0;
    this._head = 0;
    this.iteration = 0;
  }

  toCsv() {
    const lines = [HEADER.join(',')];
    const n = this.rows.length;
    for (let k = 0; k < n; k++) lines.push(this.rows[(this._head + k) % n].join(','));
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
export { Blackbox, MAX_ROWS, HEADER };
