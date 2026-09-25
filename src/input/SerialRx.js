/**
 * input/SerialRx.js
 * ---------------------------------------------------------------------------
 * A real radio receiver over WebSerial: an ELRS/Crossfire receiver speaking
 * CRSF, or an SBUS receiver, wired to a USB-serial adapter (or an FC in
 * serial passthrough). Frames arrive with their own wall-clock stamps, so the
 * link's true 250/500 Hz timing reaches the flight controller's RC smoothing
 * and feedforward.
 *
 *   const rx = new SerialRx();
 *   rx.onFrame((chUs, tWall) => ...);
 *   await rx.connect({ protocol: 'crsf', baud: 420000 });   // user gesture
 *
 * The parsers are exported separately so they can be unit-tested without a
 * serial port.
 */

export const CRSF_SYNC = [0xC8, 0xEE, 0xEA];
export const CRSF_FRAMETYPE_RC_CHANNELS_PACKED = 0x16;
export const CRSF_FRAMETYPE_LINK_STATISTICS = 0x14;

/** 11-bit RC value (CRSF/SBUS) → µs. 992 is centre; 172..1811 spans 988..2012. */
export function rcValueToUs(v) {
  return 1500 + (v - 992) * 5 / 8;
}

/** CRC-8 DVB-S2 (polynomial 0xD5) over a byte range. */
export function crc8DvbS2(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0xD5) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** Unpack 16 little-endian 11-bit channels from 22 bytes. */
export function unpack11(bytes, offset, out) {
  let bitBuf = 0;
  let bits = 0;
  let ch = 0;
  for (let i = 0; i < 22 && ch < 16; i++) {
    bitBuf |= bytes[offset + i] << bits;
    bits += 8;
    while (bits >= 11 && ch < 16) {
      out[ch++] = rcValueToUs(bitBuf & 0x7ff);
      bitBuf >>>= 11;
      bits -= 11;
    }
  }
  return out;
}

/** Pack 16 11-bit values into 22 bytes (test helper; inverse of unpack11). */
export function pack11(values) {
  const out = new Uint8Array(22);
  let bitBuf = 0;
  let bits = 0;
  let o = 0;
  for (let ch = 0; ch < 16; ch++) {
    bitBuf |= (values[ch] & 0x7ff) << bits;
    bits += 11;
    while (bits >= 8) {
      out[o++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bits -= 8;
    }
  }
  if (bits > 0 && o < 22) out[o] = bitBuf & 0xff;
  return out;
}

/** Build a CRSF RC_CHANNELS_PACKED frame (test helper). */
export function buildCrsfChannelsFrame(values11) {
  const payload = pack11(values11);
  const frame = new Uint8Array(2 + 1 + 22 + 1);
  frame[0] = 0xC8;
  frame[1] = 1 + 22 + 1;           // type + payload + crc
  frame[2] = CRSF_FRAMETYPE_RC_CHANNELS_PACKED;
  frame.set(payload, 3);
  frame[25] = crc8DvbS2(frame, 2, 25);
  return frame;
}

/**
 * Streaming CRSF parser: push bytes, get callbacks per valid frame. On a CRC
 * failure `errors` counts up and the parser resyncs on the next sync byte.
 */
export class CrsfParser {
  constructor() {
    this.buf = new Uint8Array(512);
    this.len = 0;
    this.errors = 0;
    this.lq = NaN;
    this.rssiDbm = NaN;
    this.onChannels = null;   // (chUs: Float32Array) => void
    this._ch = new Float32Array(16);
  }

  push(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      if (this.len >= this.buf.length) this.len = 0;
      this.buf[this.len++] = bytes[i];
      this._drain();
    }
  }

  _drain() {
    for (;;) {
      // Resync: discard until a sync byte heads the buffer.
      let s = 0;
      while (s < this.len && !CRSF_SYNC.includes(this.buf[s])) s++;
      if (s > 0) this._shift(s);
      if (this.len < 2) return;
      const frameLen = this.buf[1];
      if (frameLen < 2 || frameLen > 62) { this._shift(1); continue; }
      const total = frameLen + 2;
      if (this.len < total) return;
      const crc = crc8DvbS2(this.buf, 2, total - 1);
      if (crc !== this.buf[total - 1]) {
        this.errors++;
        this._shift(1);
        continue;
      }
      this._handle(this.buf[2], 3, frameLen - 2);
      this._shift(total);
    }
  }

  _handle(type, off, payloadLen) {
    if (type === CRSF_FRAMETYPE_RC_CHANNELS_PACKED && payloadLen >= 22) {
      unpack11(this.buf, off, this._ch);
      if (this.onChannels) this.onChannels(this._ch);
    } else if (type === CRSF_FRAMETYPE_LINK_STATISTICS && payloadLen >= 3) {
      this.rssiDbm = -this.buf[off];
      this.lq = this.buf[off + 2];
    }
  }

  _shift(n) {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
}

/**
 * Streaming SBUS parser: 25-byte frames `0x0F [22 bytes] [flags] 0x00`.
 * flags bit 2 = frame lost (counted), bit 3 = failsafe (no frame emitted, so
 * the flight controller's own failsafe takes over).
 */
export class SbusParser {
  constructor() {
    this.buf = new Uint8Array(64);
    this.len = 0;
    this.errors = 0;
    this.lostFrames = 0;
    this.failsafe = false;
    this.onChannels = null;
    this._ch = new Float32Array(16);
  }

  push(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      if (this.len >= this.buf.length) this.len = 0;
      this.buf[this.len++] = bytes[i];
      this._drain();
    }
  }

  _drain() {
    for (;;) {
      let s = 0;
      while (s < this.len && this.buf[s] !== 0x0F) s++;
      if (s > 0) this._shift(s);
      if (this.len < 25) return;
      if (this.buf[24] !== 0x00) {
        this.errors++;
        this._shift(1);
        continue;
      }
      const flags = this.buf[23];
      if (flags & 0x04) this.lostFrames++;
      this.failsafe = !!(flags & 0x08);
      if (!this.failsafe) {
        unpack11(this.buf, 1, this._ch);
        if (this.onChannels) this.onChannels(this._ch);
      }
      this._shift(25);
    }
  }

  _shift(n) {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
}

/** Build an SBUS frame (test helper). */
export function buildSbusFrame(values11, flags = 0) {
  const f = new Uint8Array(25);
  f[0] = 0x0F;
  f.set(pack11(values11), 1);
  f[23] = flags;
  f[24] = 0x00;
  return f;
}

export class SerialRx {
  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  constructor() {
    this.port = null;
    this.reader = null;
    this.protocol = 'crsf';
    this._cb = null;
    this._onDisconnect = null;
    this.stats = { fps: 0, lq: NaN, rssiDbm: NaN, lastFrameWall: -Infinity, errors: 0 };
    this._fpsCount = 0;
    this._fpsT0 = 0;
  }

  /** @param {(chUs: Float32Array, tWall: number) => void} cb */
  onFrame(cb) {
    this._cb = cb;
  }

  onDisconnect(cb) {
    this._onDisconnect = cb;
  }

  get connected() {
    return !!this.port;
  }

  /** Open a port (must be called from a user gesture). */
  async connect({ protocol = 'crsf', baud = 420000 } = {}) {
    if (!SerialRx.supported()) throw new Error('WebSerial needs Chrome/Edge');
    await this.disconnect();
    this.protocol = protocol === 'sbus' ? 'sbus' : 'crsf';
    const port = await navigator.serial.requestPort();
    const opts = this.protocol === 'sbus'
      ? { baudRate: 100000, dataBits: 8, parity: 'even', stopBits: 2 }
      : { baudRate: baud || 420000, dataBits: 8, parity: 'none', stopBits: 1 };
    await port.open(opts);
    this.port = port;
    const parser = this.protocol === 'sbus' ? new SbusParser() : new CrsfParser();
    this.parser = parser;
    parser.onChannels = (ch) => {
      const t = performance.now();
      this.stats.lastFrameWall = t;
      this._fpsCount++;
      if (t - this._fpsT0 >= 1000) {
        this.stats.fps = this._fpsCount * 1000 / (t - this._fpsT0);
        this._fpsCount = 0;
        this._fpsT0 = t;
      }
      if (this._cb) this._cb(ch, t);
    };
    try {
      navigator.serial.addEventListener('disconnect', this._portGone = (e) => {
        if (e.target === this.port) {
          this.disconnect();
          if (this._onDisconnect) this._onDisconnect();
        }
      });
    } catch (_e) { /* ignore */ }
    this._readLoop(parser);
  }

  async _readLoop(parser) {
    const port = this.port;
    while (port && port.readable && this.port === port) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) parser.push(value);
          this.stats.errors = parser.errors;
          if (this.protocol === 'crsf') {
            this.stats.lq = parser.lq;
            this.stats.rssiDbm = parser.rssiDbm;
          }
        }
      } catch (_e) {
        // framing/parity errors surface as exceptions; keep reading
      } finally {
        try { this.reader.releaseLock(); } catch (_e) { /* ignore */ }
        this.reader = null;
      }
    }
  }

  async disconnect() {
    const port = this.port;
    this.port = null;
    if (!port) return;
    try { await this.reader?.cancel(); } catch (_e) { /* ignore */ }
    try { await port.close(); } catch (_e) { /* ignore */ }
    try { navigator.serial.removeEventListener('disconnect', this._portGone); } catch (_e) { /* ignore */ }
  }
}
