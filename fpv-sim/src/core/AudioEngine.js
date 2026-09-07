/**
 * core/AudioEngine.js
 * ---------------------------------------------------------------------------
 * All sound is synthesised with the Web Audio API — no sample files.
 *
 * Two reasons beyond staying dependency-free. First, motor noise *should* be
 * synthesised: its pitch and timbre track RPM continuously, and a looped sample
 * pitch-shifted over a 4:1 range sounds like a mosquito in a jar. Second, it
 * makes failure trivially non-fatal — there is nothing to 404, and every call
 * into the audio graph is wrapped so a single failed node disables one sound
 * rather than taking down the frame.
 *
 * Browsers block audio until a user gesture, so the context is created lazily
 * on the first real interaction and `resume()` is retried on later gestures. If
 * the context never starts, the simulator runs silently and says so once.
 */

import { settings } from './Settings.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.enabled = true;

    this._master = null;
    this._motor = null;      // { oscA, oscB, gain, filter }
    this._wind = null;       // { source, filter, gain }
    this._ambient = null;    // { source|osc, gain, filter }
    this._noiseBuffer = null;

    this._currentAmbient = null;
    this._lastCrash = 0;
  }

  /* ====================================================================== *
   * Lifecycle
   * ====================================================================== */

  /**
   * Create the audio graph. Safe to call repeatedly; only the first call that
   * succeeds does any work. Must be triggered from a user gesture.
   */
  init() {
    if (this.ready || this.failed) return this.ready;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio API unavailable');

      this.ctx = new Ctx();
      this._master = this.ctx.createGain();
      this._master.gain.value = this._targetMaster();
      this._master.connect(this.ctx.destination);

      this._noiseBuffer = this._makeNoiseBuffer();
      this._buildMotor();
      this._buildWind();

      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[AudioEngine] audio unavailable; continuing silently.', err);
      this.failed = true;
      this.ctx = null;
      return false;
    }
  }

  /** Browsers suspend contexts created before a gesture; nudge it awake. */
  resume() {
    if (!this.ctx) {
      this.init();
      return;
    }
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (_e) { /* nothing we can do; stay silent */ }
  }

  suspend() {
    try {
      if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    } catch (_e) { /* ignore */ }
  }

  _targetMaster() {
    if (!this.enabled || !settings.get('sfx')) return 0;
    const v = settings.get('volume');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) * 0.7 : 0.4;
  }

  /** Re-read volume/mute from settings. */
  applySettings() {
    if (!this.ready) return;
    try {
      this._master.gain.setTargetAtTime(this._targetMaster(), this.ctx.currentTime, 0.05);
    } catch (_e) { /* ignore */ }
  }

  /** One second of white noise, reused by wind, crashes, and ambience. */
  _makeNoiseBuffer() {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ====================================================================== *
   * Motors
   * ====================================================================== */

  /**
   * Motor whine: two detuned sawtooths through a lowpass.
   *
   * The detune is what makes it read as *four* motors rather than one siren —
   * two slightly mismatched oscillators beat against each other exactly the way
   * four props running at marginally different RPM do.
   */
  _buildMotor() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 1.2;

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = 120;

    const oscB = ctx.createOscillator();
    oscB.type = 'square';
    oscB.frequency.value = 121.7;      // deliberate mismatch -> beating
    const gainB = ctx.createGain();
    gainB.gain.value = 0.35;

    oscA.connect(filter);
    oscB.connect(gainB);
    gainB.connect(filter);
    filter.connect(gain);
    gain.connect(this._master);

    oscA.start();
    oscB.start();

    this._motor = { oscA, oscB, gain, filter };
  }

  /**
   * @param {number} load   average motor command, 0..1
   * @param {boolean} armed
   */
  updateMotors(load, armed) {
    if (!this.ready || !this._motor) return;
    const l = Number.isFinite(load) ? Math.min(1, Math.max(0, load)) : 0;

    try {
      const t = this.ctx.currentTime;
      const target = armed ? 0.055 + l * 0.16 : 0;
      // Short time constants so the whine tracks punch-outs, but not so short
      // that per-frame jitter turns into audible zipper noise.
      this._motor.gain.gain.setTargetAtTime(target, t, 0.04);

      const freq = 95 + l * 420;
      this._motor.oscA.frequency.setTargetAtTime(freq, t, 0.03);
      this._motor.oscB.frequency.setTargetAtTime(freq * 1.507, t, 0.03);
      // Opening the filter with load makes hard throttle sound brighter and
      // more strained, which is most of what sells "the motors are working".
      this._motor.filter.frequency.setTargetAtTime(600 + l * 3200, t, 0.06);
    } catch (_e) {
      this._motor = null;   // disable this one sound, keep the rest
    }
  }

  /* ====================================================================== *
   * Wind
   * ====================================================================== */

  _buildWind() {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 500;
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this._master);
    source.start();

    this._wind = { source, filter, gain };
  }

  /** @param {number} speed m/s */
  updateWind(speed) {
    if (!this.ready || !this._wind) return;
    const v = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    try {
      const t = this.ctx.currentTime;
      // Rush only becomes audible once you are actually moving; scaled so a
      // 30 m/s dive is loud but never drowns the motors.
      const target = Math.min(0.20, Math.max(0, (v - 3) / 34) * 0.22);
      this._wind.gain.gain.setTargetAtTime(target, t, 0.12);
      this._wind.filter.frequency.setTargetAtTime(320 + v * 42, t, 0.15);
    } catch (_e) {
      this._wind = null;
    }
  }

  /* ====================================================================== *
   * One-shots
   * ====================================================================== */

  /**
   * Crash thud: a short noise burst through a fast-decaying lowpass, plus a
   * low sine "body" hit. Nodes are created per shot and left to be collected
   * once they stop — cheap, and it cannot leak because they self-terminate.
   */
  playCrash(intensity = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastCrash < 0.12) return;   // de-bounce multi-contact hits
    this._lastCrash = now;

    const amp = Math.min(1, Math.max(0.2, intensity / 8));

    try {
      // Noise burst.
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(1800, now);
      f.frequency.exponentialRampToValueAtTime(160, now + 0.22);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.5 * amp, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

      src.connect(f); f.connect(g); g.connect(this._master);
      src.start(now);
      src.stop(now + 0.3);

      // Low-frequency body thump.
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.exponentialRampToValueAtTime(38, now + 0.18);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.42 * amp, now);
      og.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      osc.connect(og); og.connect(this._master);
      osc.start(now);
      osc.stop(now + 0.26);
    } catch (_e) { /* one failed thud is not worth reporting */ }
  }

  /** Short confirmation blip — arming, gate passes, mode changes. */
  playBlip(frequency = 880, duration = 0.07, volume = 0.16) {
    if (!this.ready) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(volume, now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(g); g.connect(this._master);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (_e) { /* ignore */ }
  }

  /* ====================================================================== *
   * Per-map ambience
   * ====================================================================== */

  /**
   * A quiet bed that places the map: room tone indoors, an industrial hum in
   * the warehouse, moving air outdoors. One filtered noise loop plus (for the
   * warehouse) a mains-frequency hum is enough to change the whole feel.
   */
  setAmbient(mapId) {
    if (!this.ready || this._currentAmbient === mapId) return;
    this._currentAmbient = mapId;
    this._teardownAmbient();

    const presets = {
      house:     { freq: 220, q: 0.6, gain: 0.030, hum: 0 },
      warehouse: { freq: 130, q: 1.1, gain: 0.045, hum: 58 },
      field:     { freq: 640, q: 0.5, gain: 0.055, hum: 0 },
    };
    const p = presets[mapId];
    if (!p) return;

    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      src.loop = true;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = p.freq;
      filter.Q.value = p.q;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;

      src.connect(filter); filter.connect(gain); gain.connect(this._master);
      src.start();
      gain.gain.setTargetAtTime(p.gain, this.ctx.currentTime, 1.2);

      let hum = null;
      let humGain = null;
      if (p.hum) {
        hum = this.ctx.createOscillator();
        hum.type = 'sawtooth';
        hum.frequency.value = p.hum;
        humGain = this.ctx.createGain();
        humGain.gain.value = 0;
        const humFilter = this.ctx.createBiquadFilter();
        humFilter.type = 'lowpass';
        humFilter.frequency.value = 180;
        hum.connect(humFilter); humFilter.connect(humGain); humGain.connect(this._master);
        hum.start();
        humGain.gain.setTargetAtTime(0.022, this.ctx.currentTime, 1.5);
      }

      this._ambient = { src, gain, hum, humGain };
    } catch (_e) {
      this._ambient = null;
    }
  }

  _teardownAmbient() {
    if (!this._ambient) return;
    try {
      this._ambient.src?.stop();
      this._ambient.hum?.stop();
    } catch (_e) { /* ignore */ }
    this._ambient = null;
  }

  /* ====================================================================== *
   * Teardown
   * ====================================================================== */

  dispose() {
    this._teardownAmbient();
    try {
      this._motor?.oscA?.stop();
      this._motor?.oscB?.stop();
      this._wind?.source?.stop();
      this.ctx?.close();
    } catch (_e) { /* ignore */ }
    this._motor = null;
    this._wind = null;
    this.ctx = null;
    this.ready = false;
  }
}
