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
 * WebGL context loss is handled explicitly, because on laptops with switchable
 * graphics it is a routine event rather than an exotic one.
 */

import * as THREE from 'three';

import { PhysicsWorld } from './core/PhysicsWorld.js';
import { DroneController } from './core/DroneController.js';
import { InputManager, ACTIONS } from './core/InputManager.js';
import { CameraRig } from './core/CameraRig.js';
import { MapManager } from './core/MapManager.js';
import { AudioEngine } from './core/AudioEngine.js';
import { settings } from './core/Settings.js';

import { HouseMap, HOUSE_META } from './maps/HouseMap.js';
import { WarehouseMap, WAREHOUSE_META } from './maps/WarehouseMap.js';
import { FieldMap, FIELD_META } from './maps/FieldMap.js';

import { HUD } from './ui/HUD.js';
import { MainMenu } from './ui/MainMenu.js';
import { PauseMenu } from './ui/PauseMenu.js';
import { ControllerDiagnostics } from './ui/ControllerDiagnostics.js';

/* --- Loop constants ------------------------------------------------------ */
const MAX_FRAME_DT = 0.25;     // hard clamp on a single frame's delta

/**
 * Simulation rates offered, fastest first for the auto-downgrade walk.
 *
 * A real flight controller closes its rate loop in the kilohertz, and control
 * feel is dominated by how fresh the loop's view of the world is. 240 Hz is the
 * default because it halves the control latency of a 120 Hz loop (4.2 ms vs
 * 8.3 ms) at a cost that is invisible on any machine that can render the maps
 * at all. The PID tune is rate-independent (see D_CUTOFF_HZ in
 * DroneController), so changing this does not change how the quad flies —
 * only how finely it is resolved.
 */
const SIM_RATES = [960, 480, 240, 120];

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

    if (!this._buildRenderer()) return;

    this.scene = new THREE.Scene();
    this.physics = new PhysicsWorld({ fixedTimeStep: this.fixedDt });
    this.drone = new DroneController(this.physics);
    this.drone.body.isDrone = true;                 // MapManager keeps this body
    this.scene.add(this.drone.object3d);

    this.camera = new CameraRig(this.renderer, this.scene);
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
   * Create the WebGL renderer, degrading rather than failing: antialiasing and
   * a high-performance GPU hint are requested but a context without them is
   * accepted, and only a total inability to get any context is fatal.
   */
  _buildRenderer() {
    const attempts = [
      { antialias: true, powerPreference: 'high-performance' },
      { antialias: false, powerPreference: 'default' },
      {},
    ];

    for (const opts of attempts) {
      try {
        const renderer = new THREE.WebGLRenderer({ ...opts, alpha: false, stencil: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        this.renderer = renderer;
        this.dom.container.appendChild(renderer.domElement);
        this._bindContextLoss(renderer.domElement);
        return true;
      } catch (err) {
        console.warn('[main] renderer attempt failed', opts, err);
      }
    }

    this._fatal(
      'Could not create a WebGL context.\n\n' +
      'This simulator needs hardware-accelerated WebGL. Check that it is enabled in your ' +
      'browser settings, or try a different browser.',
    );
    return false;
  }

  /**
   * Context loss happens for mundane reasons (GPU switch, driver reset, laptop
   * waking from sleep). Calling preventDefault lets the browser restore it;
   * without that the canvas stays black forever and looks like a hard crash.
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
        this.renderer.setPixelRatio(this._pixelRatio);
        this._resize();
      } catch (_e) { /* ignore */ }
    }, false);
  }

  _registerMaps() {
    this.mapManager.register(HOUSE_META, HouseMap);
    this.mapManager.register(WAREHOUSE_META, WarehouseMap);
    this.mapManager.register(FIELD_META, FieldMap);
  }

  _buildUi() {
    this.hud = new HUD(this.dom.hud);
    this.diagnostics = new ControllerDiagnostics(this.dom.diag, this.input);

    this.mainMenu = new MainMenu(this.dom.menuRoot, {
      maps: this.mapManager.available,
      input: this.input,
      onStart: (id) => this.startFlight(id),
      onOpenDiagnostics: () => this.diagnostics.setOpen(true),
      onSettingsChanged: () => this._applySettings(),
    });

    this.pauseMenu = new PauseMenu(this.dom.menuRoot, {
      maps: this.mapManager.available,
      onResume: () => this.resume(),
      onRestart: () => { this.resume(); this.respawn({ full: true }); },
      onChangeMap: () => this._openMainMenu('main'),
      onDiagnostics: () => { this.resume(); this.diagnostics.setOpen(true); },
      onSettings: () => this._openMainMenu('settings', 'pause'),
      onMainMenu: () => this._openMainMenu('main'),
      onSettingsChanged: () => this._applySettings(),
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
    this.input.onDeviceEvent = (level, message) => this.toast(level, message);

    this.mapManager.onProgress = (p, label) => this._setLoadingProgress(p, label);
    this.mapManager.onNotice = (level, message) => this.toast(level, message);

    this.drone.onCrash = (impact) => {
      this.stats.crashes++;
      this._flashCrash();
      this.audio.playCrash(impact);
      this.toast('danger', 'Crashed — press R to respawn.');
    };

    this.drone.onArmChange = (armed) => {
      this.audio.playBlip(armed ? 1180 : 520, 0.08, 0.14);
    };

    this.drone.onBatteryState = (stage) => {
      if (stage === 'low') this.toast('warn', 'Low battery — 14.8 V.');
      else if (stage === 'critical') this.toast('danger', 'Land now — 14.0 V.');
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
    this.drone.windEnabled = mapId === 'field' && settings.get('wind');
    this.respawn({ full: true, silent: true });

    // Race setup.
    const gates = this.mapManager.gates;
    this.race.gateCount = gates.length;
    this.race.mode = gates.length ? 'timetrial' : 'free';
    this.race.best = settings.get('bestTimes')[mapId] ?? null;
    this._resetRace();

    this.elapsed = 0;
    this.stats.topSpeed = 0;
    this.stats.maxAltitude = 0;
    this.stats.crashes = 0;

    this.audio.init();
    this.audio.setAmbient(mapId);
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

    // Guard 2: cap substeps. If the machine cannot keep up we let the sim run
    // slow rather than spiralling, and drop the backlog so it recovers.
    let steps = 0;
    while (this._accumulator >= h && steps < this.maxSubsteps) {
      this._prevGatePos.copy(this.drone.currPosition);

      this.drone.update(h, this.input.controls);
      this.physics.step(h);

      const healed = this.physics.sanitizeBody(this.drone.body);
      if (healed.healed) this._onPhysicsHealed(healed.reason);

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

  _applyPixelRatio() {
    try {
      this.renderer.setPixelRatio(this._pixelRatio);
      this._resize();
    } catch (err) {
      console.warn('[main] could not change pixel ratio', err);
    }
  }

  /** Drop to the next slower simulation rate, never below the 120 Hz floor. */
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

    this.drone.windEnabled = this.mapManager.currentId === 'field' && settings.get('wind');
  }

  _renderFrame(alpha, renderDt) {
    this.drone.applyInterpolation(alpha, this._interpPos, this._interpQuat);
    this.drone.updateVisuals(renderDt);
    this.drone.object3d.visible = this.camera.showsDroneBody;

    this.camera.update(renderDt, this._interpPos, this._interpQuat, this.drone);
    this.mapManager.update(renderDt, this.elapsed);

    this.audio.updateMotors(this.drone.avgMotor, this.drone.armed);
    this.audio.updateWind(this.drone.telemetry.speed);

    this.hud.update({
      drone: this.drone,
      input: this.input.getStatus(),
      cameraLabel: this.camera.modeLabel,
      mapName: this.mapManager.getMeta(this.mapManager.currentId)?.displayName ?? '',
      race: this.race,
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
            this.toast('info', 'Turtle mode — righting the quad.');
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
    const axial = cross.dot(gate.normal);
    const radialSq = cross.lengthSq() - axial * axial;
    if (radialSq > gate.radius * gate.radius) return;   // went past outside the ring

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

    const improved = settings.recordBestTime(this.mapManager.currentId, time);
    this.race.best = settings.get('bestTimes')[this.mapManager.currentId] ?? time;

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
   * Presentation helpers
   * ====================================================================== */

  _applySettings() {
    try {
      this.setSimRate(settings.get('simRate'));
      this.camera.applySettings();
      this.audio.applySettings();
      this.hud.setVisible(settings.get('hudVisible'));
      this.drone.windEnabled = this.mapManager.currentId === 'field' && settings.get('wind');
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

  _flashCrash() {
    const el = this.dom.crashFlash;
    if (!el) return;
    el.style.transition = 'none';
    el.style.opacity = '0.42';
    // Force a reflow so the transition restarts from the new value.
    void el.offsetWidth;
    el.style.transition = 'opacity 420ms ease-out';
    el.style.opacity = '0';
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
