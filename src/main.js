/**
 * main.js
 * ---------------------------------------------------------------------------
 * Application entry point: renderer setup, the top-level state machine, and
 * the fixed-timestep game loop that ties every subsystem together.
 *
 * THE LOOP
 * --------
 * Physics runs at a fixed high rate (240 Hz by default, up to 960); rendering
 * runs at whatever the display does.
 * An accumulator bridges the two, and the leftover fraction (`alpha`) is used
 * to interpolate the drone's transform so motion stays smooth at 60, 75, or
 * 144 fps without the flight model behaving differently on any of them.
 *
 * Three guards keep that from going wrong:
 *   1. The frame delta is clamped (0.25 s). Coming back to a backgrounded tab
 *      must not simulate ten seconds of physics in one go.
 *   2. Substeps per frame are capped. A machine that cannot keep up runs in
 *      slow motion rather than entering a death spiral where each frame takes
 *      longer, demanding more substeps, taking longer still.
 *   3. Pausing stops physics *and* rendering, and resuming resets the clock
 *      instead of catching up.
 *
 * PROTECTING THE FLIGHT LOOP
 * --------------------------
 * Control feel matters more than pixels, so when a machine cannot afford both,
 * the renderer gives way first: `_trackPerformance` walks the device pixel
 * ratio down while the tick rate stays where it is. Only if the *physics* is
 * itself over budget do we step the simulation rate down a notch, and never
 * below 120 Hz.
 *
 * FAILURE POLICY
 * --------------
 * The loop body is wrapped. A subsystem that throws gets logged and the frame
 * continues; only a long unbroken run of failures escalates to the fatal card.
 * GPU device loss is handled explicitly (WebGPU `onDeviceLost`, WebGL context
 * events), because on laptops with switchable graphics it is a routine event
 * rather than an exotic one.
 */

import * as THREE from 'three/webgpu';

import { PhysicsWorld } from './core/PhysicsWorld.js';
import { DroneController } from './core/DroneController.js';
import { InputManager, ACTIONS } from './core/InputManager.js';
import { CameraRig } from './core/CameraRig.js';
import { MapManager } from './core/MapManager.js';
import { AudioEngine } from './core/AudioEngine.js';
import { settings } from './core/Settings.js';
import { Atmosphere } from './render/Atmosphere.js';
import { resolveQuality, setActiveQuality, activeQuality, detectQualityTier } from './render/Quality.js';
import { setTextureAnisotropy } from './assets/procedural.js';
import { installWebGpuCompat } from './render/webgpuCompat.js';
import { FISHEYE_RESOLUTION_SCALE } from './render/FpvLens.js';

import { MAP_REGISTRY } from './maps/registry.js';

import { HUD } from './ui/HUD.js';
import { MainMenu } from './ui/MainMenu.js';
import { PauseMenu } from './ui/PauseMenu.js';
import { ControllerDiagnostics } from './ui/ControllerDiagnostics.js';

/* --- Loop constants ------------------------------------------------------ */
const MAX_FRAME_DT = 0.25;     // hard clamp on a single frame's delta

/**
 * Simulation / flight-controller loop rates offered, fastest first for the
 * auto-downgrade walk. The Betaflight port runs its PID loop at this rate, as
 * a real FC does (BF's default is 8 kHz gyro / 4 kHz PID; 1 kHz is the
 * sim's default and 500 Hz the adaptive floor).
 */
const SIM_RATES = [2000, 1000, 500];

/**
 * Time-trial layout id for best times: MultiGP-spec gates are a different
 * course, so their records are kept apart (`:mgp`).
 */
export function raceLayoutId(mapId) {
  return settings.get('gateSpec') === 'multigp' ? `${mapId}:mgp` : mapId;
}

/** Substep cap, scaled so the ceiling is a ~40 ms frame at any rate. */
function substepCap(rate) {
  return Math.max(4, Math.ceil(rate / 24));
}

class Simulator {
  constructor() {
    this.state = 'boot';       // boot | menu | loading | flying | paused
    this.elapsed = 0;          // wall clock since the map loaded
    this._lastTime = 0;
    this._accumulator = 0;
    this._consecutiveErrors = 0;

    /* ---- simulation rate ---- */
    this.simRate = settings.get('simRate');
    this.fixedDt = 1 / this.simRate;
    this.maxSubsteps = substepCap(this.simRate);

    /* ---- adaptive quality ---- */
    this._maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this._pixelRatio = this._maxPixelRatio;
    this._perf = { frames: 0, frameMs: 0, physicsMs: 0, overBudget: 0, lastAdapt: 0 };
    this.fps = 0;

    this.stats = { topSpeed: 0, maxAltitude: 0, crashes: 0 };
    this.race = { mode: 'free', running: false, elapsed: 0, gateIndex: 0, gateCount: 0, best: null };

    this._interpPos = new THREE.Vector3();
    this._interpQuat = new THREE.Quaternion();
    this._prevGatePos = new THREE.Vector3();
    this._scratchA = new THREE.Vector3();
    this._scratchB = new THREE.Vector3();
    this._envLights = null;
    this._envBase = null;

    this._loop = this._loop.bind(this);
  }

  /* ====================================================================== *
   * Boot
   * ====================================================================== */

  async init() {
    this.dom = {
      container: document.getElementById('canvas-container'),
      hud: document.getElementById('hud'),
      menuRoot: document.getElementById('menu-root'),
      diag: document.getElementById('diag'),
      toastRoot: document.getElementById('toast-root'),
      loading: document.getElementById('loading'),
      loadingBar: document.querySelector('#loading .lb i'),
      loadingSub: document.querySelector('#loading .ls'),
      crashFlash: document.getElementById('crash-flash'),
      fatal: document.getElementById('fatal'),
      fatalMsg: document.getElementById('fatal-msg'),
      fatalReload: document.getElementById('fatal-reload'),
    };

    this.dom.fatalReload?.addEventListener('click', () => location.reload());

    if (!(await this._buildRenderer())) return;
    await detectQualityTier(this.renderer);
    this._qualitySetting = settings.get('graphicsQuality');
    this._applyQualityTier(true);

    this.scene = new THREE.Scene();
    this.atmosphere = new Atmosphere(this.renderer, this.scene);
    this.physics = new PhysicsWorld({ fixedTimeStep: this.fixedDt });
    this.drone = new DroneController(this.physics, settings.get('droneType'));
    this.drone.body.isDrone = true;                 // MapManager keeps this body
    this.scene.add(this.drone.object3d);

    this.camera = new CameraRig(this.renderer, this.scene);
    this.camera.postStack.setQuality(activeQuality);
    // Cascaded shadows split the pilot's view frustum.
    this.atmosphere.setViewCamera(this.camera.camera);
    this.mapManager = new MapManager(this.scene, this.physics);
    this.input = new InputManager();
    this.audio = new AudioEngine();

    this._registerMaps();
    this._buildUi();
    this._wireCallbacks();

    this.input.attach();
    this._bindWindowEvents();
    this._resize();

    this.state = 'menu';
    this.input.setUiMode(true);
    this.mainMenu.open('main');

    this._lastTime = performance.now();
    requestAnimationFrame(this._loop);
  }

  /**
   * Create the renderer: three's WebGPURenderer, which drives either a WebGPU
   * device or (with `forceWebGL`) a WebGL2 context through the same node
   * materials and post pipeline.
   *
   * Fallback chain: WebGPU, then WebGL2, then the fatal card. The
   * `renderBackend` setting ('auto' | 'webgpu' | 'webgl2') picks the first
   * rung; 'webgl2' skips WebGPU entirely. `init()` is async (it requests the
   * adapter and device), so the first frame waits for it.
   */
  async _buildRenderer() {
    installWebGpuCompat();
    const pref = settings.get('renderBackend');
    const attempts = pref === 'webgl2' ? [true] : [false, true];

    for (const forceWebGL of attempts) {
      let renderer = null;
      try {
        renderer = new THREE.WebGPURenderer({
          antialias: false,
          powerPreference: 'high-performance',
          forceWebGL,
        });
        await renderer.init();
        renderer.setPixelRatio(this._effectivePixelRatio());
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        // ACES: the per-map exposures in Atmosphere are tuned for it.
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        // Disabled entirely when the shadows setting is off (see _applySettings).
        renderer.shadowMap.enabled = settings.get('shadows') !== false;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this._adoptRenderer(renderer);
        const kind = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
        console.info(`[main] renderer: ${kind}`);
        return true;
      } catch (err) {
        console.warn(`[main] renderer attempt failed (${forceWebGL ? 'WebGL2' : 'WebGPU'})`, err);
        try { renderer?.dispose(); } catch (_e) { /* ignore */ }
      }
    }

    this._fatal(
      'Could not create a WebGPU or WebGL2 context.\n\n' +
      'This simulator needs hardware-accelerated graphics. Check that it is enabled in your ' +
      'browser settings, or try a different browser.',
    );
    return false;
  }

  /** Install a freshly initialised renderer: canvas, loss handlers, consumers. */
  _adoptRenderer(renderer) {
    const old = this.renderer;
    this.renderer = renderer;
    if (old?.domElement?.parentNode) old.domElement.remove();
    this.dom.container.appendChild(renderer.domElement);

    // WebGPU reports device loss through the renderer; the WebGL backend
    // reports it through canvas events. Both rebuild through the same chain.
    renderer.onDeviceLost = (info) => this._onDeviceLost(info);
    if (renderer.backend?.isWebGLBackend) this._bindContextLoss(renderer.domElement);

    // Consumers created before a rebuild hold the old renderer.
    if (this.atmosphere) this.atmosphere.renderer = renderer;
    if (this.camera) this.camera.setRenderer(renderer);
    if (old && old !== renderer) {
      try { old.dispose(); } catch (_e) { /* ignore */ }
    }
  }

  /**
   * GPU device lost (driver reset, GPU switch, a laptop waking from sleep).
   * Build a new renderer through the same fallback chain and hand it to every
   * consumer; the scene graph keeps its CPU-side data, so everything re-uploads.
   */
  async _onDeviceLost(info) {
    if (this._rebuilding) return;
    this._rebuilding = true;
    this._contextLost = true;
    if (this.state === 'flying') this.pause();
    this.toast('danger', 'Graphics device lost — rebuilding the renderer.');
    console.warn('[main] device lost', info);
    try {
      const ok = await this._buildRenderer();
      if (ok) {
        this._contextLost = false;
        this._resize();
        try { this.atmosphere?.rebuildEnvironment?.(); } catch (_e) { /* ignore */ }
        this.toast('info', 'Graphics restored.');
      }
    } finally {
      this._rebuilding = false;
    }
  }

  /**
   * WebGL backend only. Calling preventDefault lets the browser restore the
   * context; without that the canvas stays black forever and looks like a
   * hard crash.
   */
  _bindContextLoss(canvas) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      if (this.state === 'flying') this.pause();
      this.toast('danger', 'Graphics context lost — waiting for the browser to restore it.');
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      this._contextLost = false;
      this.toast('info', 'Graphics context restored.');
      try {
        this.renderer.setPixelRatio(this._effectivePixelRatio());
        this._resize();
      } catch (_e) { /* ignore */ }
    }, false);
  }

  _registerMaps() {
    for (const [meta, Ctor] of MAP_REGISTRY) this.mapManager.register(meta, Ctor);
  }

  /**
   * Resolve the graphics tier ('auto' picks from the GPU string) and push it
   * to every consumer: render resolution cap, texture filtering, shadow
   * resolution and view distance. World systems that allocate at build time
   * (grass density, tree LOD, terrain detail) read `activeQuality` when the
   * next map loads.
   */
  _applyQualityTier(initial = false) {
    try {
      const q = resolveQuality(settings.get('graphicsQuality'));
      const changed = this._qualityTier !== q.tier;
      this._qualityTier = q.tier;
      setActiveQuality(q);
      // A new tier restores every effect the performance guard shed.
      this._effectsReduced = 0;
      this.camera?.postStack?.setQuality(activeQuality);
      let maxAniso = 4;
      try { maxAniso = this.renderer.getMaxAnisotropy(); } catch (_e) { /* ignore */ }
      setTextureAnisotropy(Math.min(q.anisotropy || 4, maxAniso || 4));
      this._maxPixelRatio = Math.min(window.devicePixelRatio || 1, q.pixelRatioCap || 2);
      if (initial || this._pixelRatio > this._maxPixelRatio) {
        this._pixelRatio = this._maxPixelRatio;
        if (!initial) this._applyPixelRatio();
        else this.renderer.setPixelRatio(this._effectivePixelRatio());
      }
      if (!initial && changed) {
        this.atmosphere?.applyQuality();
        this._applyViewDistance();
        if (this.mapManager?.current) {
          this.toast('info', `Graphics: ${q.tier.toUpperCase()} — terrain, grass and trees update on the next map load.`);
        }
      }
    } catch (err) {
      console.warn('[main] could not apply the graphics tier', err);
    }
  }

  /** Camera far plane: the map's own extent, capped by the quality tier. */
  _applyViewDistance() {
    try {
      const map = this.mapManager?.current;
      const want = Number.isFinite(map?.viewDistance) ? map.viewDistance : 1800;
      const far = Math.max(300, Math.min(want, activeQuality.viewDistance || 3600));
      this.camera?.setViewDistance?.(far);
    } catch (_e) { /* ignore */ }
  }

  /** Wind blows on any open-air map (the flag lives in the map's meta). */
  _windAllowed() {
    const meta = this.mapManager?.getMeta(this.mapManager.currentId);
    return !!(meta?.outdoor && settings.get('wind'));
  }

  /** Best times are keyed per course layout, so a rebuilt course starts clean. */
  _courseKey(mapId = this.mapManager.currentId) {
    const meta = this.mapManager.getMeta(mapId);
    return raceLayoutId(meta?.courseKey || mapId);
  }

  _buildUi() {
    this.hud = new HUD(this.dom.hud);
    this.diagnostics = new ControllerDiagnostics(this.dom.diag, this.input);

    this.mainMenu = new MainMenu(this.dom.menuRoot, {
      maps: this.mapManager.available,
      input: this.input,
      onToast: (level, msg) => this.toast(level, msg),
      onStart: (id) => this.startFlight(id),
      onOpenDiagnostics: () => this.diagnostics.setOpen(true),
      onSettingsChanged: () => this._applySettings(),
      onNotice: (level, message) => this.toast(level, message),
    });

    this.pauseMenu = new PauseMenu(this.dom.menuRoot, {
      maps: this.mapManager.available,
      onResume: () => this.resume(),
      onRestart: () => { this.resume(); this.respawn({ full: true }); },
      onChangeMap: () => this._openMainMenu('main'),
      onControllerSetup: () => this._openMainMenu('calibrate'),
      onDiagnostics: () => { this.resume(); this.diagnostics.setOpen(true); },
      onSettings: () => this._openMainMenu('settings', 'pause'),
      onMainMenu: () => this._openMainMenu('main'),
      onSettingsChanged: () => this._applySettings(),
      getPackInfo: () => {
        try {
          const d = this.drone;
          const t = d.telemetry;
          return `${d.batteryVoltage.toFixed(1)} V · ${d.packCurrent.toFixed(1)} A · ` +
            `${t.mahDrawn.toFixed(0)}/${t.mahCapacity.toFixed(0)} mAh`;
        } catch (_e) { return null; }
      },
      getStats: () => ({
        mapName: this.mapManager.getMeta(this.mapManager.currentId)?.displayName ?? '',
        elapsed: this.elapsed,
        topSpeed: this.stats.topSpeed,
        maxAltitude: this.stats.maxAltitude,
        crashes: this.stats.crashes,
        battery: this.drone.batteryVoltage,
        gateCount: this.race.gateCount,
        gateIndex: this.race.gateIndex,
        best: this.race.best,
      }),
    });
  }

  _wireCallbacks() {
    this.input.onDeviceEvent = (level, message) => {
      this.toast(level, message);

      // A wrong axis layout is not something a toast can fix — the pilot has to
      // rebind. If they are not mid-flight, take them straight to the screen
      // that does it rather than leaving them to find it.
      if (level === 'danger' && /calibrat/i.test(message) && this.state !== 'flying') {
        this._openMainMenu('calibrate');
      }
    };

    this.mapManager.onProgress = (p, label) => this._setLoadingProgress(p, label);
    this.mapManager.onNotice = (level, message) => this.toast(level, message);

    this.drone.onCrash = (impact, severity) => {
      const sev = severity || 'destroyed';
      this.stats.crashes++;
      this._flashCrash(sev);
      try {
        if (sev === 'destroyed') {
          this.audio.playCrash(impact);
        } else {
          this.audio.playStrike?.(Math.min(1, impact / 8));
        }
      } catch (_e) { /* a failed crash sound must not break the frame */ }
      if (sev !== 'graze') {
        this.toast('danger', sev === 'hard' ? 'Hard knock — shake it off.' : 'Crashed — press R to respawn.');
      }
    };

    this.drone.onArmChange = (armed) => {
      this.audio.playBlip(armed ? 1180 : 520, 0.08, 0.14);
    };

    this.drone.onBatteryState = (stage) => {
      // Thresholds are per-pack: 3.5 V is a flat 1S and a dead-short 4S, so the
      // message has to quote the airframe's own numbers rather than the 4S ones.
      const b = this.drone.spec.battery;
      if (stage === 'low') this.toast('warn', `Low battery — ${b.LOW.toFixed(1)} V (${b.label}).`);
      else if (stage === 'critical') this.toast('danger', `Land now — ${b.CRITICAL.toFixed(1)} V (${b.label}).`);
      else if (stage === 'cutoff') this.toast('danger', 'Battery cutoff. Press R for a fresh pack.');
    };

    settings.subscribe(() => this._applySettings());
  }

  _bindWindowEvents() {
    window.addEventListener('resize', () => this._resize());

    // Losing focus mid-flight pauses rather than letting the quad fly on
    // unattended (InputManager separately clears held keys).
    window.addEventListener('blur', () => {
      if (this.state === 'flying') this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.state === 'flying') this.pause();
    });

    // Audio contexts may only start from a user gesture.
    const wake = () => {
      this.audio.resume();
      this._applySettings();
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);

    // Nothing below should ever fire, but if it does the app says so rather
    // than silently freezing.
    window.addEventListener('error', (e) => {
      console.error('[main] uncaught error', e.error || e.message);
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('[main] unhandled rejection', e.reason);
    });
  }

  /* ====================================================================== *
   * State transitions
   * ====================================================================== */

  async startFlight(mapId) {
    this.mainMenu.close();
    this.pauseMenu.close();
    this.state = 'loading';
    this.input.setUiMode(true);
    this._showLoading(true);

    // Tear down the previous map's sky, fog and exposure *before* the next
    // one builds: maps snapshot scene.fog/background on build and restore it
    // on dispose, so anything left here would leak into the following map.
    try {
      this.atmosphere.reset();
      this.mapManager.disposeCurrent();
      this.scene.fog = null;
      this.scene.background = null;
      this.renderer.toneMappingExposure = 1.05;
    } catch (_e) { /* ignore */ }

    await this.mapManager.load(mapId);

    this._showLoading(false);
    this._afterMapLoad(mapId);

    this.state = 'flying';
    this.input.setUiMode(false);
    this._lastTime = performance.now();
    this._accumulator = 0;
  }

  _afterMapLoad(mapId) {
    const map = this.mapManager.current;

    this.drone.setSpawn(
      this.mapManager.spawnPoint,
      this.mapManager.spawnHeading,
      this.mapManager.groundLevel,
    );
    this.drone.windEnabled = this._windAllowed();
    this._configureEnvironment(map);
    this.camera.postStack.setEnvironment({
      outdoor: this.atmosphere.mode === 'outdoor',
      // Maps that build sunbeam cards through skylights get real godrays too.
      godrays: !!map?.environment?.godrays,
      sun: this.atmosphere.sun,
    });
    this._applyViewDistance();
    this.camera.setLinkProfile?.(map?.link || null);
    this.respawn({ full: true, silent: true });

    // Race setup.
    const gates = this.mapManager.gates;
    this.race.gateCount = gates.length;
    this.race.mode = gates.length ? 'timetrial' : 'free';
    this.race.best = settings.get('bestTimes')[this._courseKey(mapId)] ?? null;
    this._resetRace();

    this.elapsed = 0;
    this.stats.topSpeed = 0;
    this.stats.maxAltitude = 0;
    this.stats.crashes = 0;

    this.audio.init();
    const ambient = this.mapManager.getMeta(mapId)?.ambient || mapId;
    this.audio.setAmbient(ambient);
    try { this.audio.setEnvironment?.(ambient); } catch (_e) { /* ignore */ }
    this._captureEnvironmentLights();
    this._applyEnvironmentLighting();
    this.mainMenu.setSelectedMap(mapId);

    const meta = this.mapManager.getMeta(mapId);
    this.toast('info', `${meta?.displayName ?? mapId} — press SPACE to arm, W for throttle.`);
    if (map && this.race.gateCount) {
      this.toast('info', `Time Trial: ${this.race.gateCount} gates. The clock starts on your first throttle input.`);
    }
  }

  pause() {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.input.setUiMode(true);
    this.input.clearKeys();
    this.audio.updateMotors(0, false);
    this.audio.updateWind(0);
    this.audio.suspend();

    // Draw one last frame so the paused scene sits behind the menu, then stop
    // rendering entirely (the spec requires the render tick to halt, not just
    // the physics).
    this._renderFrame(1, 0);
    this.pauseMenu.open();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pauseMenu.close();
    this.mainMenu.close();
    this.state = 'flying';
    this.input.setUiMode(false);
    this.audio.resume();

    // Critical: discard the paused duration. Without this the accumulator
    // would try to catch up on however long the menu was open.
    this._lastTime = performance.now();
    this._accumulator = 0;
  }

  _openMainMenu(page = 'main', returnPage = 'main') {
    this.state = 'menu';
    this.pauseMenu.close();
    this.input.setUiMode(true);
    this.mainMenu.deps.returnPage = returnPage === 'pause' ? 'main' : returnPage;
    this.mainMenu.open(page);
    this.audio.suspend();
  }

  respawn({ full = false, silent = false } = {}) {
    this.drone.respawn({ resetBattery: true });
    // Streamed maps: make the spawn's surroundings solid before the first step.
    this.mapManager.updateColliders(this.drone.body.position);
    this.camera.reset(this.drone.currPosition, this.drone.currQuaternion);
    this.input.clearAll();
    this.input.setKeyboardThrottle(0);
    this._resetRace();
    if (full) {
      this.elapsed = 0;
      this.stats.topSpeed = 0;
      this.stats.maxAltitude = 0;
    }
    if (!silent) this.toast('info', 'Respawned at the spawn point.');
  }

  /* ====================================================================== *
   * Game loop
   * ====================================================================== */

  _loop(now) {
    requestAnimationFrame(this._loop);

    try {
      const rawDt = (now - this._lastTime) / 1000;
      this._lastTime = now;

      // Guard 1: clamp the frame delta. A backgrounded tab can hand us a
      // multi-second delta; simulating all of it at once would teleport the
      // drone through the level.
      const frameDt = Number.isFinite(rawDt) ? Math.min(Math.max(rawDt, 0), MAX_FRAME_DT) : 0.016;

      // Input is polled every frame in every state: the Gamepad API only
      // reports axes on poll, and the diagnostics panel and menus need it too.
      this.input.update(frameDt);
      this._handleActions(this.input.consumeActions());
      this.diagnostics.update();

      if (this.state !== 'flying' || this._contextLost) {
        this._consecutiveErrors = 0;
        return;
      }

      // Cinematic camera runs the sim at half speed.
      const scaledDt = frameDt * this.camera.timeScale;
      this.elapsed += scaledDt;
      if (this.race.running) this.race.elapsed += scaledDt;

      const tPhysics = performance.now();
      this._stepPhysics(scaledDt);
      const physicsMs = performance.now() - tPhysics;

      const alpha = this._accumulator / this.fixedDt;
      this._renderFrame(alpha, frameDt);

      this._trackPerformance(frameDt, physicsMs, now);
      this._consecutiveErrors = 0;
    } catch (err) {
      this._onLoopError(err);
    }
  }

  _stepPhysics(dt) {
    this._accumulator += dt;
    const h = this.fixedDt;

    // Streamed colliders: the live set is at least one 32 m cell around the
    // quad, far more than it can travel in one frame's worth of substeps.
    this.mapManager.updateColliders(this.drone.body.position);

    // RX frames carry wall-clock stamps; map this render frame's wall span
    // onto the substeps about to run (substep k of n covers wallStart + k·h),
    // so the FC sees the link's real frame timing on the sim clock.
    const ctl = this.input.controls;
    ctl.switchArming = !!ctl.switchArming;
    this.input.armIndicator = this.drone.armed;
    const planned = Math.min(this.maxSubsteps, Math.floor(this._accumulator / h + 1e-9));
    const simStart = this.drone.simTime;
    const wallA = this.input.prevFrameWall;
    const wallB = this.input.frameWall;
    let lastT = Math.max(this.drone._lastQueuedT, simStart - 1);
    for (const f of ctl.rxFrames) {
      const u = wallB > wallA ? Math.min(1, Math.max(0, (f.tw - wallA) / (wallB - wallA))) : 1;
      let t = simStart + u * planned * h;
      if (!(t > lastT)) t = lastT + 1e-6;
      f.t = t;
      lastT = t;
    }

    // Guard 2: cap substeps. If the machine cannot keep up we let the sim run
    // slow rather than spiralling, and drop the backlog so it recovers.
    let steps = 0;
    while (this._accumulator >= h && steps < this.maxSubsteps) {
      this._prevGatePos.copy(this.drone.currPosition);

      this.drone.update(h, this.input.controls);
      this.physics.step(h);

      const healed = this.physics.sanitizeBody(this.drone.body);
      if (healed.healed) this._onPhysicsHealed(healed.reason);
      // Swept-collision impacts bypass the contact solver's velocity (the
      // guard parks the body and kills the inbound component), so report them
      // to the crash logic directly — otherwise a caught 40 m/s wall hit
      // stops dead with no crash, no disarm, and no sound.
      if (healed.impactSpeed > 0) {
        try { this.drone.registerImpact(healed.impactSpeed); } catch (_e) { /* ignore */ }
      }

      this.drone.afterStep();
      this._checkGates(this._prevGatePos, this.drone.currPosition);

      this._accumulator -= h;
      steps++;
    }

    if (steps >= this.maxSubsteps) {
      this._accumulator = 0;
      this._perf.overBudget++;
    }

    this._postPhysics();
  }

  /* ====================================================================== *
   * Adaptive performance
   * ====================================================================== */

  /**
   * Keep the flight loop fast, and pay for it with pixels rather than ticks.
   *
   * Rendering is elastic: dropping the device pixel ratio from 2.0 to 1.5 cuts
   * fragment work roughly in half and is barely visible in a 130-degree FPV
   * view. The tick rate is not elastic in the same way — halving it doubles
   * control latency, which you feel in the sticks immediately. So resolution is
   * always given up first, and the simulation rate steps down only when the
   * physics itself (rather than the renderer) is what is over budget.
   */
  _trackPerformance(frameDt, physicsMs, now) {
    const perf = this._perf;
    perf.frames++;
    perf.frameMs += frameDt * 1000;
    perf.physicsMs += physicsMs;

    if (perf.frames < 60) return;

    const avgFrame = perf.frameMs / perf.frames;
    const avgPhysics = perf.physicsMs / perf.frames;
    const overBudget = perf.overBudget;
    this.fps = 1000 / Math.max(avgFrame, 0.001);

    perf.frames = 0;
    perf.frameMs = 0;
    perf.physicsMs = 0;
    perf.overBudget = 0;

    if (!settings.get('adaptiveQuality')) return;
    if (now - perf.lastAdapt < 2500) return;   // never oscillate

    const struggling = avgFrame > 20.5;        // below ~49 fps
    const comfortable = avgFrame < 15.0;       // above ~66 fps

    if (struggling) {
      // Blowing the substep budget means the solver, not the GPU, is the
      // bottleneck — cutting resolution would not help.
      const physicsBound = avgPhysics > 9 || overBudget > 6;

      if (!physicsBound && this._pixelRatio > 0.75) {
        this._pixelRatio = Math.max(0.75, this._pixelRatio - 0.25);
        this._applyPixelRatio();
        perf.lastAdapt = now;
      } else if (!physicsBound && this._reduceEffects()) {
        perf.lastAdapt = now;
      } else if (physicsBound) {
        this._stepDownSimRate();
        perf.lastAdapt = now;
      }
    } else if (comfortable && this._pixelRatio < this._maxPixelRatio) {
      this._pixelRatio = Math.min(this._maxPixelRatio, this._pixelRatio + 0.25);
      this._applyPixelRatio();
      perf.lastAdapt = now;
    }
  }

  /**
   * Second rung, once the pixel ratio is already on its 0.75 floor: shed the
   * most expensive post effects — GTAO first, then TRAA for SMAA. Returns
   * true when something was dropped. A tier change restores them.
   */
  _reduceEffects() {
    const stack = this.camera?.postStack;
    if (!stack) return false;
    const level = this._effectsReduced | 0;
    const reduced = { ...activeQuality };
    if (level === 0 && activeQuality.gtao) {
      reduced.gtao = false;
      this._effectsReduced = 1;
    } else if (level <= 1 && activeQuality.aa === 'traa') {
      reduced.gtao = false;
      reduced.aa = 'smaa';
      this._effectsReduced = 2;
    } else {
      return false;
    }
    stack.setQuality(reduced);
    this.toast('warn', 'Reduced effects for frame rate');
    return true;
  }

  /**
   * The renderer's pixel ratio: the adaptive base, times the fisheye lens's
   * 1.25x supersample (its centre is magnified from a rectilinear render).
   * Scaling the whole drawing buffer rather than just the scene pass keeps
   * every buffer the same size, which TRAA's depth history requires.
   */
  _effectivePixelRatio() {
    const base = this._pixelRatio || Math.min(window.devicePixelRatio || 1, 2);
    return base * (settings.get('fpvLens') === 'fisheye' ? FISHEYE_RESOLUTION_SCALE : 1);
  }

  _applyPixelRatio() {
    try {
      this.renderer.setPixelRatio(this._effectivePixelRatio());
      this._resize();
    } catch (err) {
      console.warn('[main] could not change pixel ratio', err);
    }
  }

  /** Drop to the next slower simulation rate, never below the 500 Hz floor. */
  _stepDownSimRate() {
    const i = SIM_RATES.indexOf(this.simRate);
    const next = SIM_RATES[i + 1];
    if (!next) return;
    settings.set('simRate', next);
    this.toast('warn', `Simulation rate reduced to ${next} Hz to hold framerate.`);
  }

  /** Adopt a new simulation rate. Safe to call mid-flight. */
  setSimRate(rate) {
    if (!SIM_RATES.includes(rate) || rate === this.simRate) return;
    this.simRate = rate;
    this.fixedDt = 1 / rate;
    this.maxSubsteps = substepCap(rate);
    this.physics.fixedTimeStep = this.fixedDt;
    // Drop the backlog: an accumulator sized for the old step would burn a
    // burst of substeps on the next frame.
    this._accumulator = 0;
  }

  /** Book-keeping that only needs to happen once per rendered frame. */
  _postPhysics() {
    // BEEPER mode: a 4 Hz blip while the switch is on.
    if (this.drone.fc.beeper) {
      const t = performance.now();
      if (!(t - (this._beepAt || 0) < 250)) {
        this._beepAt = t;
        this.audio.playBlip(2200, 0.08, 0.12);
      }
    }
    const t = this.drone.telemetry;
    if (t.speed > this.stats.topSpeed) this.stats.topSpeed = t.speed;
    if (t.altitude > this.stats.maxAltitude) this.stats.maxAltitude = t.altitude;

    // AGL over rolling terrain: ask the map how high the ground is here.
    const map = this.mapManager.current;
    if (map && typeof map.getGroundHeight === 'function') {
      const p = this.drone.body.position;
      this.drone.groundLevel = map.getGroundHeight(p.x, p.z);
    }

    // Start the Time Trial clock on the first real throttle input.
    if (this.race.mode === 'timetrial' && !this.race.running && !this.race.finished &&
        this.drone.throttleEverApplied) {
      this.race.running = true;
    }

    if (this.mapManager.isOutOfBounds(this.drone.body.position)) {
      this.toast('warn', 'Left the flight area — respawning.');
      this.respawn({ silent: true });
    }

    this.drone.windEnabled = this._windAllowed();

    // Distance to the next gate, for the OSD.
    const next = this.race.mode === 'timetrial' && !this.race.finished
      ? this.mapManager.gates[this.race.gateIndex] : null;
    this.race.nextGateDist = next ? next.position.distanceTo(this.drone.currPosition) : null;
  }

  _renderFrame(alpha, renderDt) {
    this.drone.applyInterpolation(alpha, this._interpPos, this._interpQuat);
    this.drone.updateVisuals(renderDt);
    this.drone.setViewMode(!this.camera.showsDroneBody, settings.get('propsInView') !== false);

    this.camera.update(renderDt, this._interpPos, this._interpQuat, this.drone);
    this.mapManager.update(renderDt, this.elapsed);
    this.mapManager.updateView(this.camera.camera.position, this._interpPos, renderDt);
    try { this.atmosphere.update(renderDt, this._interpPos); } catch (_e) { /* never fatal */ }

    // Dust/propwash kick-up: skip when adaptive quality has already bottomed
    // out the pixel ratio and frames are still slow — a struggling machine
    // should not also pay for particle physics.
    const map = this.mapManager.current;
    const dustStarved = settings.get('adaptiveQuality') && this._pixelRatio <= 0.75 &&
      this.fps > 0 && this.fps < 45;
    if (map && !dustStarved && typeof map.updatePropwash === 'function') {
      try {
        map.updatePropwash(this._interpPos, this.drone.avgMotor, renderDt);
      } catch (_e) { /* a failed propwash update must not take the frame down */ }
    }

    const rpm = this.drone.motorRPM;
    const motorLoad = ((rpm[0] + rpm[1] + rpm[2] + rpm[3]) / 4) / this.drone.motorRpmMax;
    this.audio.updateMotors(Number.isFinite(motorLoad) ? motorLoad : 0, this.drone.armed, this.drone.spec.audio, this.drone.motors);
    this.audio.updateWind(this.drone.telemetry.speed);
    try {
      const camPos = this.camera.camera?.position;
      const vel = this.drone.body?.velocity;
      if (camPos && vel) {
        this.audio.updateListener?.(this._interpPos, camPos, { x: vel.x, y: vel.y, z: vel.z });
      }
    } catch (_e) { /* ignore */ }

    const windSpeedRaw = settings.get('windSpeed');
    this.hud.update({
      drone: this.drone,
      input: this.input.getStatus(),
      thr: this.input.controls?.throttle,
      cameraLabel: this.camera.modeLabel,
      mapName: this.mapManager.getMeta(this.mapManager.currentId)?.displayName ?? '',
      race: this.race,
      armed: this.drone.armed,
      flightMode: this.drone.flightModeActive,
      armBlockReason: this.drone.armBlockReason,
      switchArming: this.input.controls.switchArming,
      lq: this.input.controls.lq,
      batteryStage: this.drone.getBatteryStage(),
      rssi: this.camera?.rssi,
      damage: this.drone?.damage ?? 0,
      windSpeed: Number.isFinite(windSpeedRaw) ? windSpeedRaw : 2.5,
      linkHeld: this.input?.linkHeld,
      failsafe: this.input?.linkFailsafe,
    });

    this.camera.render();
  }

  /**
   * A subsystem threw mid-frame. One-off failures are logged and skipped; a
   * long unbroken run means something is structurally wrong and continuing
   * would just spam the console forever, so we surface it.
   */
  _onLoopError(err) {
    this._consecutiveErrors++;
    console.error(`[main] frame error (${this._consecutiveErrors})`, err);

    if (this._consecutiveErrors === 5) {
      this.toast('danger', 'Something went wrong — trying to recover.');
      try { this.respawn({ silent: true }); } catch (_e) { /* ignore */ }
    }
    if (this._consecutiveErrors >= 120) {
      this._fatal(`The simulation loop failed repeatedly.\n\n${err?.stack || err}`);
      this.state = 'boot';
    }
  }

  _onPhysicsHealed(reason) {
    // Throttled: a clamp can trip for several substeps in a row and we do not
    // want a wall of toasts.
    const now = performance.now();
    if (this._lastHealToast && now - this._lastHealToast < 3000) return;
    this._lastHealToast = now;
    console.warn('[main] physics state repaired:', reason);
    if (reason && reason.includes('not finite')) {
      this.toast('warn', 'Recovered from an unstable physics state.');
    }
  }

  /* ====================================================================== *
   * Actions
   * ====================================================================== */

  _handleActions(actions) {
    if (!actions || actions.size === 0) return;

    for (const action of actions) {
      switch (action) {
        case ACTIONS.PAUSE:
          if (this.state === 'flying') this.pause();
          else if (this.state === 'paused') this.resume();
          else if (this.state === 'menu' && this.mapManager.current) this.resume();
          break;

        case ACTIONS.ARM:
          if (this.state !== 'flying') break;
          if (this.drone.motorCutByBattery) {
            this.toast('warn', 'Battery is flat — press R for a fresh pack.');
            break;
          }
          if (this.input.controls.switchArming) {
            if (!this._armSwitchToastShown) {
              this._armSwitchToastShown = true;
              this.toast('info', 'Arm with your ARM switch');
            }
            break;
          }
          this.drone.toggleArmed();
          break;

        case ACTIONS.RESET:
          if (this.state === 'flying') this.respawn();
          break;

        case ACTIONS.MODE_ACRO:
          settings.set('flightMode', 'acro');
          this.toast('info', 'MODE: ACRO — no self-levelling.');
          break;

        case ACTIONS.MODE_ANGLE:
          settings.set('flightMode', 'angle');
          this.toast('info', 'MODE: ANGLE — self-levelling.');
          break;

        case ACTIONS.MODE_TOGGLE: {
          const next = settings.get('flightMode') === 'acro' ? 'angle' : 'acro';
          settings.set('flightMode', next);
          this.toast('info', `MODE: ${next.toUpperCase()}`);
          break;
        }

        case ACTIONS.CAMERA: {
          const mode = this.camera.cycleMode();
          this.toast('info', `Camera: ${mode.toUpperCase()}`);
          break;
        }

        case ACTIONS.HUD:
          this.hud.toggle();
          break;

        case ACTIONS.TURTLE:
          if (this.state !== 'flying') break;
          if (this.drone.isInverted()) {
            this.drone.requestTurtle();
            this.toast('info', 'Crash flip — push roll or pitch to flip it over.');
          }
          break;

        case ACTIONS.DIAG:
          this.diagnostics.toggle();
          break;

        case ACTIONS.MAP:
          this._openMainMenu('main');
          break;

        default:
          break;
      }
    }
  }

  /* ====================================================================== *
   * Race / gates
   * ====================================================================== */

  _resetRace() {
    this.race.running = false;
    this.race.finished = false;
    this.race.elapsed = 0;
    this.race.gateIndex = 0;
    const gates = this.mapManager.gates;
    for (let i = 0; i < gates.length; i++) {
      gates[i].passed = false;
      gates[i].setState(i === 0 ? 'active' : 'idle');
    }
  }

  /**
   * Gate detection by plane crossing.
   *
   * Rather than testing whether the drone is *inside* a torus (which a fast
   * quad can skip straight past between substeps), we ask whether the segment
   * from the previous position to the current one crossed the gate's plane,
   * and if so whether the crossing point was inside the ring. That cannot be
   * tunnelled through at any speed the sim allows.
   */
  _checkGates(prevPos, currPos) {
    if (this.race.mode !== 'timetrial' || this.race.finished) return;
    const gates = this.mapManager.gates;
    const gate = gates[this.race.gateIndex];
    if (!gate) return;

    const d0 = this._scratchA.copy(prevPos).sub(gate.position).dot(gate.normal);
    const d1 = this._scratchA.copy(currPos).sub(gate.position).dot(gate.normal);
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) return;
    if ((d0 > 0) === (d1 > 0)) return;              // did not cross the plane
    if (Math.abs(d0 - d1) < 1e-9) return;

    // Where on the plane did we cross?
    const t = d0 / (d0 - d1);
    const cross = this._scratchB.copy(prevPos).lerp(currPos, t).sub(gate.position);
    if (typeof gate.contains === 'function') {
      if (!gate.contains(cross)) return;                // went past outside the opening
    } else {
      const axial = cross.dot(gate.normal);
      const radialSq = cross.lengthSq() - axial * axial;
      if (radialSq > gate.radius * gate.radius) return;
    }

    // Pass registered.
    gate.passed = true;
    gate.setState('done');
    this.race.gateIndex++;
    this.race.running = true;

    const next = gates[this.race.gateIndex];
    if (next) {
      next.setState('active');
      this.audio.playBlip(1320, 0.06, 0.13);
    } else {
      this._finishRace();
    }
  }

  _finishRace() {
    this.race.finished = true;
    this.race.running = false;
    const time = this.race.elapsed;

    const key = this._courseKey();
    const improved = settings.recordBestTime(key, time);
    this.race.best = settings.get('bestTimes')[key] ?? time;

    this.audio.playBlip(1760, 0.22, 0.2);
    this.toast(
      improved ? 'info' : 'warn',
      improved
        ? `New best time: ${fmt(time)}${settings.persistent ? '' : ' (this session only)'}`
        : `Finished in ${fmt(time)} — best is ${fmt(this.race.best)}`,
    );
    this.toast('info', 'Press R to reset the course.');
  }

  /* ====================================================================== *
   * Airframe
   * ====================================================================== */

  /**
   * Switch to a different airframe.
   *
   * Rebuilding the body changes its mass, collider and arm geometry, so the
   * quad is respawned rather than left wherever the old one was — a 23 g whoop
   * inheriting a race quad's 50 m/s velocity is not a state worth supporting.
   * Idempotent, so `_applySettings()` can call it on every settings change.
   */
  setDroneType(typeId) {
    if (!this.drone) return false;
    if (this.drone.spec.id === typeId) return false;

    const changed = this.drone.setAirframe(typeId);
    if (!changed) return false;

    // The new mesh is a new object; re-add it and re-apply the FPV visibility
    // rule, or the chase camera ends up looking at nothing.
    if (this.drone.object3d.parent !== this.scene) this.scene.add(this.drone.object3d);
    this.drone.setViewMode(!this.camera.showsDroneBody, settings.get('propsInView') !== false);

    this.physics.protect(this.drone.body);

    this.respawn({ silent: true });
    this.toast('info', `${this.drone.spec.displayName} — ${this.drone.spec.className}`);
    return true;
  }

  /* ====================================================================== *
   * Presentation helpers
   * ====================================================================== */

  _applySettings() {
    try {
      this.setSimRate(settings.get('simRate'));
      this.camera.applySettings();
      if (this.renderer && Math.abs(this.renderer.getPixelRatio() - this._effectivePixelRatio()) > 1e-6) {
        this._applyPixelRatio();
      }
      this.audio.applySettings();
      this.hud.setVisible(settings.get('hudVisible'));
      if (this.renderer) {
        const wantShadows = settings.get('shadows') !== false;
        if (this.renderer.shadowMap.enabled !== wantShadows) {
          this.renderer.shadowMap.enabled = wantShadows;
          // Toggling needs a material recompile to take effect.
          try {
            this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
          } catch (_e) { /* ignore */ }
        }
      }
      this.drone.windEnabled = this._windAllowed();
      if (settings.get('graphicsQuality') !== this._qualitySetting) {
        this._qualitySetting = settings.get('graphicsQuality');
        this._applyQualityTier(false);
      }
      this.setDroneType(settings.get('droneType'));
      // Betaflight settings changed → rebuild gains and filters.
      const tuneKey = JSON.stringify([
        settings.get('fcRates'), settings.get('fcPid'), settings.get('fcFilters'), settings.get('fcMisc'),
        settings.get('modes'), settings.get('rcDeadband'), settings.get('inputMode'), settings.get('serialProtocol'),
        this.drone.spec.id,
      ]);
      if (tuneKey !== this._tuneKey) {
        this._tuneKey = tuneKey;
        this.drone.applyTune();
      }

      // Unconditional: setDroneType returns early when the craft is unchanged,
      // so the airframe the app booted with would otherwise never get its
      // camera mount or third-person standoff applied.
      this.camera.setMount(this.drone.spec.cameraMount);
      this.camera.setRigScale(this.drone.spec.body[0]);
      this._applyEnvironmentLighting();
    } catch (err) {
      console.warn('[main] failed to apply settings', err);
    }
  }

  _resize() {
    try {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.resize(w, h);
    } catch (err) {
      console.warn('[main] resize failed', err);
    }
  }

  _showLoading(on) {
    this.dom.loading.classList.toggle('open', !!on);
    if (on) this._setLoadingProgress(0, '');
  }

  _setLoadingProgress(p, label) {
    if (this.dom.loadingBar) this.dom.loadingBar.style.width = `${Math.round(p * 100)}%`;
    if (this.dom.loadingSub) this.dom.loadingSub.textContent = label || ' ';
  }

  _flashCrash(severity = 'destroyed') {
    if (severity === 'graze') return;
    const el = this.dom.crashFlash;
    if (!el) return;
    el.style.background = severity === 'hard' ? 'var(--warn)' : 'var(--danger)';
    el.style.transition = 'none';
    el.style.opacity = severity === 'hard' ? '0.28' : '0.42';
    // Force a reflow so the transition restarts from the new value.
    void el.offsetWidth;
    el.style.transition = 'opacity 420ms ease-out';
    el.style.opacity = '0';
  }

  /**
   * Light the freshly built map. Three kinds of map exist:
   *
   *   outdoor - declares `environment.mode = 'outdoor'` and brings no sun or
   *             sky of its own: the analytic sky, sun, fog and image-based
   *             lighting all come from Atmosphere, driven by one sun angle.
   *   indoor  - brings its own fixtures; Atmosphere optionally adds a
   *             shadow-casting sun through skylights, then captures the lit
   *             interior into an environment map so PBR materials get
   *             matching ambient and reflections.
   *   legacy  - no declaration: its lights stand, plus a captured env map.
   */
  _configureEnvironment(map) {
    const env = map?.environment;
    const sp = this.mapManager.spawnPoint;
    const probe = (Array.isArray(env?.probe) && env.probe) || [sp.x, sp.y + 1.6, sp.z];
    const probeVec = new THREE.Vector3(probe[0], probe[1], probe[2]);
    try {
      if (env?.mode === 'outdoor') {
        this.atmosphere.setOutdoor(env);
        this.atmosphere.setTimeOfDay(settings.get('sunAngle'), settings.get('overcast'));
      } else if (env?.mode === 'indoor') {
        this.atmosphere.setIndoor(env);
        this.atmosphere.update(0, probeVec);
        this.atmosphere.captureEnvironment(probeVec, [this.drone.object3d]);
      } else {
        this.atmosphere.adoptLegacy(probeVec, { envIntensity: env?.envIntensity ?? 0.45 });
      }
    } catch (err) {
      console.warn('[main] environment setup failed; plain lights only.', err);
    }
  }

  /**
   * Locate the hemisphere + directional lights the current map's builder
   * added to the scene, and snapshot their authored intensities/colours so
   * the sun-angle/overcast sliders have a stable baseline to scale from
   * instead of drifting further from the map's own art direction every time
   * a setting changes. Missing lights degrade to a no-op, never a throw.
   */
  _captureEnvironmentLights() {
    this._envLights = null;
    this._envBase = null;
    // Outdoor maps are lit by the physically based sky, which drives its own
    // sun from the time-of-day slider (see _applyEnvironmentLighting).
    if (this.atmosphere?.mode === 'outdoor') return;
    try {
      const hemis = [];
      const dirs = [];
      this.scene.traverse((obj) => {
        if (obj.isHemisphereLight) hemis.push(obj);
        else if (obj.isDirectionalLight) dirs.push(obj);
      });
      dirs.sort((a, b) => b.intensity - a.intensity);

      const hemi = hemis[0] || null;
      const sun = dirs[0] || null;
      const fill = dirs[1] || null;
      if (!hemi && !sun && !fill) return;

      this._envLights = { hemi, sun, fill };
      this._envBase = {
        hemiI: hemi ? hemi.intensity : 0,
        hemiSky: hemi ? hemi.color.clone() : null,
        hemiGround: hemi ? hemi.groundColor.clone() : null,
        sunI: sun ? sun.intensity : 0,
        sunColor: sun ? sun.color.clone() : null,
        fillI: fill ? fill.intensity : 0,
        fogNear: this.scene.fog ? this.scene.fog.near : null,
        fogFar: this.scene.fog ? this.scene.fog.far : null,
      };
    } catch (_e) {
      this._envLights = null;
      this._envBase = null;
    }
  }

  /** Drive the captured lights + fog from the `sunAngle`/`overcast` settings. */
  _applyEnvironmentLighting() {
    if (this.atmosphere?.mode === 'outdoor') {
      try { this.atmosphere.setTimeOfDay(settings.get('sunAngle'), settings.get('overcast')); } catch (_e) { /* ignore */ }
      return;
    }
    const base = this._envBase;
    if (!base) return;
    try {
      const { hemi, sun, fill } = this._envLights || {};

      const rawAngle = settings.get('sunAngle');
      const sunAngle = Number.isFinite(rawAngle) ? Math.min(1, Math.max(0, rawAngle)) : 0.5;
      const rawOvercast = settings.get('overcast');
      const overcast = Number.isFinite(rawOvercast) ? Math.min(1, Math.max(0, rawOvercast)) : 0;

      // 0 or 1 = grazing dawn/dusk light, 0.5 = overhead noon.
      const sunFactor = 0.35 + 0.65 * Math.sin(sunAngle * Math.PI);

      if (sun && Number.isFinite(base.sunI)) {
        sun.intensity = base.sunI * sunFactor * (1 - overcast * 0.7);
        if (base.sunColor) {
          const warm = this._scratchColor || (this._scratchColor = new THREE.Color());
          warm.set(0xffc78c);
          sun.color.copy(base.sunColor);
          sun.color.lerp(warm, (1 - Math.sin(sunAngle * Math.PI)) * (1 - overcast * 0.5));
          if (overcast > 0) sun.color.lerp(this._scratchColorB || (this._scratchColorB = new THREE.Color(0xffffff)), overcast * 0.4);
        }
      }
      if (fill && Number.isFinite(base.fillI)) {
        fill.intensity = base.fillI * (1 - overcast * 0.35);
      }
      if (hemi && Number.isFinite(base.hemiI)) {
        hemi.intensity = base.hemiI * (0.7 + 0.3 * sunFactor) * (1 - overcast * 0.15);
        if (base.hemiSky && base.hemiGround) {
          if (overcast > 0) {
            const grey = this._scratchColorC || (this._scratchColorC = new THREE.Color());
            grey.copy(base.hemiSky).lerp(base.hemiGround, 0.5);
            hemi.color.copy(base.hemiSky).lerp(grey, overcast);
            hemi.groundColor.copy(base.hemiGround).lerp(grey, overcast);
          } else {
            hemi.color.copy(base.hemiSky);
            hemi.groundColor.copy(base.hemiGround);
          }
        }
      }
      if (this.scene.fog && Number.isFinite(base.fogNear) && Number.isFinite(base.fogFar)) {
        const shrink = 1 - overcast * 0.55;
        this.scene.fog.near = Math.max(1, base.fogNear * shrink);
        this.scene.fog.far = Math.max(this.scene.fog.near + 1, base.fogFar * shrink);
      }
    } catch (_e) { /* guard missing lights */ }
  }

  toast(level, message) {
    try {
      const node = document.createElement('div');
      node.className = `toast${level === 'warn' ? ' warn' : level === 'danger' ? ' danger' : ''}`;
      node.textContent = message;
      this.dom.toastRoot.append(node);

      // Keep the stack short so a burst of events cannot fill the screen.
      while (this.dom.toastRoot.children.length > 4) {
        this.dom.toastRoot.firstChild.remove();
      }

      setTimeout(() => {
        node.classList.add('fading');
        setTimeout(() => node.remove(), 340);
      }, 3400);
    } catch (_e) { /* a failed toast is not worth escalating */ }
  }

  _fatal(message) {
    try {
      this.dom.fatalMsg.textContent = message;
      this.dom.fatal.classList.add('open');
    } catch (_e) {
      // Last resort if even the DOM is unavailable.
      console.error('[main] fatal:', message);
    }
  }
}

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return '--:--.--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/* ========================================================================== *
 * Bootstrap
 * ========================================================================== */

const sim = new Simulator();
sim.init().catch((err) => {
  console.error('[main] failed to start', err);
  try {
    document.getElementById('fatal-msg').textContent = String(err?.stack || err);
    document.getElementById('fatal').classList.add('open');
  } catch (_e) { /* nothing left to do */ }
});

// Handy for poking at the sim from the console while developing.
window.__fpv = sim;
