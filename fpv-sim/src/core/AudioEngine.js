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

    /* ---- reverb send, built once, wet amount set per map ---- */
    this._reverbSend = null;
    this._reverbConvolver = null;

    /* ---- listener distance/doppler, refreshed by updateListener() ---- */
    this._distGain = 1;
    this._doppler = 1;

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
      this._buildReverb();
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

  /**
   * A single generated impulse response — 0.6 s of decaying noise — shared by
   * motors and wind. Built once; failure (or an old browser without
   * ConvolverNode) simply leaves `_reverbSend` null and every sound stays dry.
   */
  _buildReverb() {
    try {
      const ctx = this.ctx;
      const len = Math.max(1, Math.floor(ctx.sampleRate * 0.6));
      const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const decay = Math.pow(1 - i / len, 2.2);
          data[i] = (Math.random() * 2 - 1) * decay;
        }
      }
      const convolver = ctx.createConvolver();
      convolver.buffer = impulse;

      const send = ctx.createGain();
      send.gain.value = 0;

      send.connect(convolver);
      convolver.connect(this._master);

      this._reverbSend = send;
      this._reverbConvolver = convolver;
    } catch (_e) {
      this._reverbSend = null;
      this._reverbConvolver = null;
    }
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
    if (this._reverbSend) {
      try { gain.connect(this._reverbSend); } catch (_e) { /* ignore */ }
    }

    oscA.start();
    oscB.start();

    this._motor = { oscA, oscB, gain, filter };
  }

  /**
   * @param {number} load   average motor command, 0..1
   * @param {boolean} armed
   * @param {object} [voice] per-airframe timbre: { base, span, idle }
   *
   * Motor pitch is a property of the aircraft, not of the throttle: a 0802
   * motor on a 31 mm prop screams somewhere around 400 Hz where a 2207 on a 5"
   * sits nearer 90 Hz. Passing the airframe's voice through is what stops all
   * three sounding like the same quad.
   */
  updateMotors(load, armed, voice, motors = null) {
    if (!this.ready || !this._motor) return;
    const l = Number.isFinite(load) ? Math.min(1, Math.max(0, load)) : 0;
    const base = Number.isFinite(voice?.base) ? voice.base : 95;
    const span = Number.isFinite(voice?.span) ? voice.span : 420;
    // Armed props never fully stop, so neither does the whine.
    const idle = Number.isFinite(voice?.idle) ? voice.idle : 0.05;

    // Per-motor spread — how far the four commands have drifted apart —
    // beats the two oscillators against each other harder, which is what
    // four motors running at slightly different RPM actually sounds like.
    let spread = 0;
    if (Array.isArray(motors) && motors.length) {
      let lo = Infinity, hi = -Infinity;
      for (const m of motors) {
        if (!Number.isFinite(m)) continue;
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
      if (hi >= lo) spread = hi - lo;
    }

    try {
      const t = this.ctx.currentTime;
      const distGain = Number.isFinite(this._distGain) ? this._distGain : 1;
      const target = (armed ? 0.055 + Math.max(l, idle) * 0.16 : 0) * distGain;
      // Short time constants so the whine tracks punch-outs, but not so short
      // that per-frame jitter turns into audible zipper noise.
      this._motor.gain.gain.setTargetAtTime(target, t, 0.04);

      let freq = base + Math.max(l, idle) * span;
      // ESC idle wobble: a slow low-amplitude drift seeded by how much the
      // props still spin at zero throttle.
      if (Number.isFinite(idle) && idle > 0) {
        freq += Math.sin(t * 2 * Math.PI * idle * 0.13) * idle * 2;
      }
      const doppler = Number.isFinite(this._doppler) ? this._doppler : 1;
      freq *= doppler;

      this._motor.oscA.frequency.setTargetAtTime(freq, t, 0.03);
      const wobble = Math.sin(t * 13.7) * freq * 0.004 * spread;
      this._motor.oscB.frequency.setTargetAtTime(freq * 1.507 + wobble, t, 0.03);
      // Opening the filter with load makes hard throttle sound brighter and
      // more strained, which is most of what sells "the motors are working".
      this._motor.filter.frequency.setTargetAtTime(base * 6 + l * span * 7, t, 0.06);
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
    if (this._reverbSend) {
      try { gain.connect(this._reverbSend); } catch (_e) { /* ignore */ }
    }
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

  /**
   * Distance + Doppler, driven from the render loop with the drone and
   * camera world positions. Missing/invalid inputs reset to "no effect"
   * rather than throwing or freezing at a stale value.
   */
  updateListener(dronePos, camPos, vel) {
    if (!this.ready) return;
    try {
      if (!dronePos || !camPos ||
        !Number.isFinite(dronePos.x) || !Number.isFinite(camPos.x)) {
        this._distGain = 1;
        this._doppler = 1;
        return;
      }
      const dx = camPos.x - dronePos.x;
      const dy = camPos.y - dronePos.y;
      const dz = camPos.z - dronePos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this._distGain = Number.isFinite(d) ? 1 / (1 + (d * d) / 40) : 1;

      let doppler = 1;
      if (d > 1e-3 && vel &&
        Number.isFinite(vel.x) && Number.isFinite(vel.y) && Number.isFinite(vel.z)) {
        const radialVel = (vel.x * dx + vel.y * dy + vel.z * dz) / d;
        if (Number.isFinite(radialVel)) doppler = 1 - radialVel / 343;
      }
      this._doppler = Number.isFinite(doppler) ? Math.min(1.08, Math.max(0.92, doppler)) : 1;
    } catch (_e) {
      this._distGain = 1;
      this._doppler = 1;
    }
  }

  /**
   * Per-map reverb wet level — a small room, an empty shed, and open field
   * all sound different even with identical source material.
   */
  setEnvironment(mapId) {
    if (!this.ready || !this._reverbSend) return;
    const presets = { house: 0.35, warehouse: 0.25, field: 0.06 };
    const level = Number.isFinite(presets[mapId]) ? presets[mapId] : 0.1;
    try {
      this._reverbSend.gain.setTargetAtTime(level, this.ctx.currentTime, 1.5);
    } catch (_e) { /* ignore */ }
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

  /**
   * A prop-strike graze: a shorter, brighter version of the crash thud —
   * reuses the same noise buffer, no new assets.
   */
  playStrike(intensity = 1) {
    if (!this.ready) return;
    const amp = Math.min(1, Math.max(0.1, Number.isFinite(intensity) ? intensity : 1));
    try {
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2800;
      f.Q.value = 3.5;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.4 * amp, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28 * 0.4);

      src.connect(f); f.connect(g); g.connect(this._master);
      src.start(now);
      src.stop(now + 0.3 * 0.4);
    } catch (_e) { /* one failed strike is not worth reporting */ }
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
