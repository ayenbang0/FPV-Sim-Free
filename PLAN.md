# FPV Sim Realism Overhaul — Execution Plan

## Context

The user wants `fpv-sim` (a browser sim: Vite, three 0.185.1, cannon-es 0.20) to become a realistic FPV simulator that borrows from SimITL/KwadSim (a physical motor, prop and battery model), Betaflight (rates, RC smoothing, feedforward, PID, filters, mixer), GodotDrone (a true fisheye FPV lens, MultiGP gate sizes) and the other listed references. It also needs very good graphics and real radio support. It must run with no external game engine.

Priorities, in order:
1. **Graphics.** Migrate to three's WebGPURenderer and TSL. The user chose this over WebGL2.
2. **In-flight physics.** Write a faithful JS port of Betaflight 2025.12 and a physical quad model. The user chose a JS port over a WASM build.
3. **Radio connection.** Support EdgeTX/ELRS USB and BLE joysticks, WebSerial CRSF and SBUS, and Betaflight-style AUX switches.
4. **Gate spec toggle.** Add a League/MultiGP setting.

End state:
- `npm run dev` gives a WebGPU (WebGL2-fallback) renderer with a TSL post stack and a fisheye FPV feed.
- Flight runs through Betaflight algorithms at a 1 kHz FC and physics loop.
- A real transmitter flies it, with switch arming and switch modes.
- `npm test` passes with re-baselined physics tests.

Betaflight source for porting is the `master` branch, fetched 2026-09-24 at `https://raw.githubusercontent.com/betaflight/betaflight/master/src/main/…`. The plan quotes the constants that were verified from it. Where it says "port verbatim", fetch that function and translate it line by line. Keep a `// BF: <file>:<function>` comment on each ported function. The ported code is GPL-3.0-derived, so `package.json` gets `"license": "GPL-3.0-or-later"` and the README gets a license section.

## Approach

Phases run in order. After each phase, `npm test` and `npm run build` must pass.

### Phase 0 — Plan file
1. Copy this plan to `PLAN.md` at the repo root, if it is not already there.

### Phase 1 — Graphics: WebGPU/TSL migration (priority #1)

**1.1 Use a single three instance.**
- In `vite.config.js`, add `resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] }`. Without it, three/examples addons that import `'three'` would pull in a second copy of the core, and `instanceof` checks would fail across the two.
- Codemod every `from 'three'` in `src/**` to `from 'three/webgpu'`. Import TSL from `'three/tsl'`.
- Test with `node -e "import('three/webgpu').then(m=>console.log(m.REVISION))"`.
  - If Node can import `three/webgpu`, change the imports in `tests/*.mjs` to match.
  - If it cannot (top-level browser globals), leave `src` importing `'three'` and let the Vite alias do the redirect. In that case, add `tests/_node-loader.mjs`, a `module.register` resolve hook that maps `three/tsl` to a stub exporting no-op node functions, and run the tests with `node --import ./tests/_node-loader.mjs`. Update the `npm test` script accordingly.

**1.2 Renderer (`src/main.js` `_buildRenderer`, ~L175–211).**
- Replace `WebGLRenderer` with `new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance', forceWebGL: settings.get('renderBackend') === 'webgl2' })`, then `await renderer.init()`. `init()` becomes async and is awaited before the first frame.
- Fallback chain: WebGPU, then `forceWebGL: true`, then the existing `#fatal` panel.
- Keep `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping` (per-map exposures in Atmosphere are tuned for ACES) and `shadowMap.enabled`. Set `shadowMap.type = THREE.PCFSoftShadowMap`.
- Replace context-loss handling with `renderer.onDeviceLost = (info) => …`. It rebuilds through the same fallback chain; the WebGL backend keeps the `webglcontextlost` listener.
- New setting `renderBackend: 'auto' | 'webgpu' | 'webgl2'`, default `'auto'`. It is validated with `oneOf`, shown in Settings → Graphics, and applies on reload (show a hint saying so).
- Anisotropy uses `renderer.getMaxAnisotropy()`.
- `src/render/Quality.js`: `detectQualityTier(renderer)` becomes async.
  - WebGPU: read `(await navigator.gpu.requestAdapter()).info` (`vendor`, `architecture`, `description`). Software or fallback adapter gives `low`; `intel` or `apple` with `architecture` matching `/gen-?(9|11|12)|m1$/i` gives `medium`; anything else gives `high`.
  - WebGL backend: keep the existing `WEBGL_debug_renderer_info` path through `renderer.backend.gl`.
  - Any error gives `medium`.

**1.3 Port every GLSL path to TSL.** When this step is done, a grep for `onBeforeCompile|ShaderMaterial|gl_FragColor|ShaderPass|EffectComposer` must return 0 hits in `src/`.
- **Sky.** `src/render/Atmosphere.js` `FpvSky` `ShaderMaterial` (~L410) becomes a `MeshBasicNodeMaterial` with `colorNode = Fn(() => …)`: a line-for-line TSL port of `SKY_SHADER` (Preetham scattering, clouds, ground hemisphere). Use `three/examples/jsm/objects/SkyMesh.js` as the TSL reference. Every existing uniform becomes a `uniform()` node with the same name and the same JS update site. `side: BackSide`, `depthWrite: false`.
- **PMREM.** Use the `PMREMGenerator` from `three/webgpu` and delete the `compileCubemapShader()` call. `captureEnvironment` keeps `fromScene`.
- **Terrain.** `src/world/TerrainMaterial.js` `onBeforeCompile` (~L71) becomes a `MeshStandardNodeMaterial`. The splat blend (grass, dirt, gravel/sand, forest floor, slope rock, altitude snow) is ported into `colorNode`, `roughnessNode` and `normalNode`, using the same textures, uniforms and thresholds. The function signature and return value stay the same, so callers are unchanged.
- **Grass.** `src/world/Grass.js` `onBeforeCompile` (~L122) becomes a `MeshStandardNodeMaterial`.
  - `positionNode` ports the instance offset, wind sway (`uWind`), `tHeight` sampling, `uHRect`, the slope/water/fade mask (`uWater`) and the `tGSplat` dry tint.
  - Per-instance attributes are read with `attribute('aOffset')`.
- **CRT.** `CRT_SHADER` in `CameraRig.js` is replaced by the video node in 1.6.

**1.4 New post pipeline: `src/render/PostStack.js`** (new; nothing equivalent exists).
- `export class PostStack { constructor(renderer, scene, camera); setQuality(preset); setFpvLens(lensState); setVideo(videoState); resize(w,h); render(); dispose(); }`, built on `new THREE.RenderPipeline(renderer)`.
- Graph:
  - `scenePass = pass(scene, camera)` with `setMRT(mrt({ output, normal: normalView, velocity }))`
  - then `ao(depth, normal, camera)`: GTAONode, multiplied into the lit colour
  - then `ssr(...)`: SSRNode, ultra only
  - then `bloom(color, strength, radius, threshold 0.9)`: BloomNode, always built, strength from `bloomStrength`
  - then `lensflare(...)`: LensflareNode, sun on outdoor maps
  - then `motionBlur(color, velocity)`: MotionBlur, when `motionBlur` is on
  - then AA: `traa(...)` (TRAANode) on high/ultra, `smaa(...)` (SMAANode) on low/medium
  - then the FPV lens node (1.5)
  - then the video-system node (1.6)
  - then `renderOutput()`, which does tone mapping and sRGB.
- Tier matrix. Add these fields to `QUALITY_PRESETS` in `Quality.js`:

| field | low | medium | high | ultra |
|---|---|---|---|---|
| `gtao` | false | true (half res) | true | true |
| `ssr` | false | false | false | true |
| `aa` | 'smaa' | 'smaa' | 'traa' | 'traa' |
| `lensflare` | false | true | true | true |
| `csmCascades` | 0 | 2 | 3 | 4 |
| `cubeFaceSize` | 384 | 512 | 768 | 1024 |
| `godrays` | false | false | true | true |

- Delete the stale `antialias` field from all four presets.
- `CameraRig.render()` delegates to `PostStack.render()`. Remove `_buildComposer`, `_disposeComposer`, `fxKey`, `AfterimagePass`, the `EffectComposer` imports and `CRT_SHADER`.
- If building the stack throws, keep the existing `_composerFailed` semantics: log and fall back to `renderer.render(scene, camera)`.
- `main._applyQualityTier` calls `camera.postStack.setQuality(activeQuality)`.

**1.5 True fisheye FPV lens (GodotDrone style), `src/render/FpvLens.js`.**
- Setting `fpvLens: 'rectilinear' | 'fisheye' | 'fisheye-cube'`, default `'fisheye'`.
- The `fov` setting is redefined as the horizontal FOV of the FPV image in degrees: range 70–170, default 145. The camera's vertical fov is computed from the aspect ratio.
- `lensFisheye` (0–1, default 0.8) replaces `lensDistortion`. Delete `lensDistortion` from `defaultSettings` and `sanitize`.
- Projection model, used for all modes. With output normalised radius `r` (0 at the centre, 1 at the horizontal edge) and `θmax = fov/2`:
  - find θ by solving `r·F = (1−k)·tan θ + k·θ`, where `F = (1−k)·tan θmax + k·θmax` and `k = lensFisheye`;
  - use 8 Newton iterations in the shader, starting from `θ = r·θmax`.
- `'rectilinear'`: plain `PerspectiveCamera`. Clamp the horizontal fov to 150.
- `'fisheye'` (fast, keeps GTAO/TRAA/motion blur):
  - render the scene pass rectilinear at horizontal FOV `min(2·θmax, 150°)`, with the render resolution scaled ×1.25;
  - the lens node remaps each output pixel through θ to rectilinear UV `tan θ / tan(θrender)`;
  - pixels with θ > θrender are filled with the vignette black. Real lenses vignette there too.
- `'fisheye-cube'` (true 170°+, the GodotDrone approach):
  - a `CubeCamera` with `new THREE.CubeRenderTarget(activeQuality.cubeFaceSize)` at the FPV camera pose renders 5 faces; the back face is skipped via `cubeCamera.children[i].layers` disabled for index +Z;
  - the lens node samples `cubeTexture(target.texture, dirWorld)` with `dirWorld` from θ and φ rotated by the camera quaternion;
  - GTAO, SSR, TRAA and motion blur are skipped in this mode, and the settings UI says so.
- Jello: `_applyJello` currently uses `setViewOffset`. Reimplement it as a UV shear inside the lens node: row offset ∝ `angularVelocity × rowTime`, with rolling shutter readout 8 ms for HD and 0 for analog. Delete the `setViewOffset` use.
- Uptilt (`cameraTilt`) is unchanged.
- `setMount(spec.cameraMount)` is unchanged.

**1.6 Video system (replaces `crtFilter`).**
- Setting `videoSystem: 'hd' | 'analog'`, default `'hd'`. Delete `crtFilter`.
- TSL node in `src/render/FpvVideo.js`.
- `'hd'` (DJI O4/Walksnail look):
  - sharp image, mild radial chromatic aberration `0.0012·r²`;
  - as RSSI falls below 0.4, 16×16 px macroblock quantisation (`floor(uv·res/16)`) blends in;
  - below 0.15 the frame freezes: keep the last output in a `RenderTarget` and hold it.
- `'analog'`:
  - port every current CRT feature (tear below RSSI 0.35, CA, scanlines, noise, desaturation, vignette);
  - add chroma bleed: a 5-tap horizontal blur of chroma only (YIQ split);
  - pillarbox the image to 4:3 when the viewport is wider than 4:3.
- `vtxBreakup` and `vtxMode` keep their meaning.
- `fpvLatency` defaults to 28 ms for HD and 12 ms for analog. Switching `videoSystem` in the UI writes that default into `fpvLatency`.

**1.7 Content upgrades.**
- **Cascaded shadows.** On outdoor maps with `csmCascades > 0`, `Atmosphere` uses `CSMShadowNode` from `three/examples/jsm/csm/CSMShadowNode.js` (`cascades = csmCascades`, `maxFar = shadowRange·4`, mode `'practical'`) on the sun `DirectionalLight`. This replaces `_followShadow` outdoors. Indoor and part-roofed maps keep the single pinned shadow map.
- **Water.** Replace `OutdoorKit._buildWater` (~L148) and the FieldMap pond material (~L318) with `WaterMesh` from `three/examples/jsm/objects/WaterMesh.js`. Use the existing `waterNormalTexture` as `waterNormals`, `sunDirection` from Atmosphere, and `waterColor` 0x1b3a46 (0x1d3c40 for the pond). The collider boxes are unchanged.
- **Detailed drone model.** Rewrite `DroneController._buildMesh` into a new `src/render/DroneModel.js` (`export function buildDroneModel(spec) → { object3d, propGroups[4], propDiscs[4], dispose() }`):
  - **Carbon and frame:** carbon plates using `MeshPhysicalMaterial` with `clearcoat 0.6` and a new 2×2 twill `carbonWeaveTexture` in `procedural.js`; standoffs.
  - **Electronics and camera:** stack; TPU canopy (accent colour); camera with a glass lens (`transmission 1`); lollipop VTX antenna.
  - **Motors:** bell motors (cylinder bell and base, plus 6 stator-slot boxes visible through the bell gap).
  - **Props:** tri-blade props from `ExtrudeGeometry` of a blade outline, where the whoop uses 4 blades inside its duct and the others 3.
  - **Prop blur:** per-prop `propDiscs`, a `CircleGeometry` with a radial-gradient alpha texture; opacity = `smoothstep(1500, 6000, rpm)·0.55`, while blade meshes fade out over the same range.
  - **LEDs:** an emissive LED strip under the arms, which blooms.
- **Props in view.** Setting `propsInView` (default true). In FPV mode, only the four `propDiscs` are rendered (layer 1, enabled on the FPV camera), so props appear at the frame edges as on a real 5" with a wide lens.
- **Gate LEDs.** `_gateLedMaterials` emissive intensity goes 0.9 → 2.4 so the gate LEDs pass the 0.9 bloom threshold.
- **Godrays.** On high/ultra, indoor maps that already build sunbeam meshes (Warehouse, Factory) enable `GodraysNode` from the sun light; the existing beam meshes stay.

**1.8 Performance guard.**
- `main._trackPerformance` keeps stepping the pixel ratio.
- Add a second rung: when the pixel ratio is already at its 0.75 floor and still over budget, drop GTAO, then TRAA→SMAA. It calls `PostStack.setQuality` with a copy of the preset that has those flags off, and toasts "Reduced effects for frame rate".

### Phase 2 — Physics: Betaflight port + physical quad (priority #2)

All new FC code lives in `src/fc/` and is pure JS: no three, no DOM.
- Units follow Betaflight: deg/s, throttle 0..1, pidSum in BF units.
- Axis convention inside the FC: index 0 roll (+ = right wing down), 1 pitch (+ = nose down), 2 yaw (+ = nose right). This matches the current sim convention and InputManager, so there is **no** BF yaw-stick negation and **no** `-scaledAxisPidYaw`. Instead the mixer yaw column below already encodes the sign.
- Write the following sign table as a comment block at the top of `src/fc/mixer.js`, and add a test asserting each row:

| command | motors up | motors down |
|---|---|---|
| +roll (right) | FL, RL | FR, RR |
| +pitch (nose down) | RL, RR | FL, FR |
| +yaw (nose right) | FR, RL (CCW props, props-in) | FL, RR (CW props) |

**2.1 `src/fc/filters.js`** (BF `common/filter.c`, ported verbatim):
- `pt1FilterGain(f, dT)`: `ω = 2π f dT; k = ω/(ω+1)`
- `pt2FilterGain`: cutoff × 1.553773974
- `pt3FilterGain`: cutoff × 1.961459177
- `pt1FilterGainFromDelay`
- classes `Pt1`, `Pt2`, `Pt3` with `apply(x)` and `updateCutoff(k)`
- `Biquad` with `initNotch(fHz, dT, Q)`, `initLpf(fHz, dT)` (Q = 1/√2) and `apply`
- `LaggedMovingAverage(n)`

Any filter whose cutoff is ≥ 0.5/dT is constructed as a pass-through, the same as BF's Nyquist check.

**2.2 `src/fc/rates.js`:**
- Port these verbatim from `fc/rc.c` into `applyRates(type, axis, rcCommandf, profile)`: `applyBetaflightRates` (including `RC_RATE_INCREMENTAL 14.54` above rcRate 2.0), `applyRaceFlightRates`, `applyKissRates`, `applyActualRates` and `applyQuickRates`.
- The profile uses BF integer units: `rcRates[axis]`, `rates[axis]`, `rcExpo[axis]`, `quickRatesRcExpo`, `rateLimit[axis]` (default 1998).
- Clamp the result to ±`rateLimit`.
- `maxRcRate(type, axis, profile) = applyRates(type, axis, 1, profile)`.
- Throttle curve: port `generateThrottleCurve` (with `thrMid8`, `thrExpo8`) and `rcLookupThrottle` (`THROTTLE_LOOKUP_LENGTH 12`) verbatim.

**2.3 `src/fc/rc.js`, `class RcProcessor`** (BF `fc/rc.c`):
- `onRxFrame(channelsUs[16], tSimSeconds)` handles a new RX frame:
  - rx interval, constrained to 800–65500 µs;
  - `shouldUpdateSmoothing` (ported verbatim: 0.1 smoothing factor, 20 % outlier rule, 3-count rules);
  - `rcCommand` from µs with `deadband`/`yaw_deadband` (defaults 0 and 0);
  - `rawSetpoint` through `applyRates`;
  - `calculateFeedforward`, ported verbatim from the rc.c text quoted in research: duplicate interpolation, jitter attenuator, PT1 speed/delta smoothing, boost, `feedforward_max_rate_limit`, yaw hold, transition, lagged 2-point averaging.
- `update(dT)` runs once per FC loop: PT3 setpoint, feedforward and throttle smoothing (`rcSmoothingSetFilterCutoffs`, ported verbatim).
  - `autoSmoothnessFactor = 1.5/(1 + rc_smoothing_auto_factor/10)`, with the auto factor for setpoint and for throttle both defaulting to 30. Before coding, verify this formula against `rcSmoothingFilterInit` in rc.c; if BF differs, use BF.
- Getters: `getSetpointRate(axis)`, `getFeedforward(axis)`, `getRcDeflection(axis)`, `getThrottle()` (0..1 after the throttle curve and smoothing).
- Feedforward defaults: `feedforward_averaging` 2-point, `feedforward_max_rate_limit` 90, `feedforward_smooth_factor` 65, `feedforward_jitter_factor` 7, `feedforward_boost` 15, `feedforward_yaw_hold_gain` 15, `feedforward_yaw_hold_time` 100.

**2.4 `src/fc/pid.js`, `class PidController`** (BF `flight/pid.c` and `pid_init.c`):
- Scaling constants: `PTERM_SCALE 0.032029`, `ITERM_SCALE 0.244381`, `DTERM_SCALE 0.000529`, `FEEDFORWARD_SCALE 0.013754`.
- Gains: `Kp = PTERM_SCALE·P`, `Ki = ITERM_SCALE·I` (yaw ×2.5), `Kd = DTERM_SCALE·D`, `Kf = FEEDFORWARD_SCALE·F/100`.
- Limits: `pidSumLimit 500`, yaw 400; `itermWindup 80` gives `itermLimit = 0.8·pidSumLimit` (yaw 0.8·400).
- Port verbatim:
  - `pidController` loop body: error, I-term relax, P (yaw P through a PT1 at `yaw_lowpass_hz 100`), I, D with D-max, F, anti-gravity P boost, Sum;
  - `applyItermRelax`: `ITERM_RELAX_RP`, type SETPOINT, cutoff 15, threshold 40, ×0.2 in angle mode;
  - `pidLevel` and `calcHorizonLevelStrength`: `angle_limit 60`, level P 50 → `angleGain 5`, level I 75 → `horizonGain 0.75`, level D 75 → horizon stick limit 0.75, `horizon_limit_degrees 135`, `horizon_delay_ms 500`, `angle_earth_ref 100`, `angle_feedforward_smoothing_ms 80`;
  - the anti-gravity throttle-derivative path: `anti_gravity_gain 80`, `ANTIGRAVITY_KI 0.34`, `anti_gravity_p_gain 100` × `ANTIGRAVITY_KP 0.0034`, PT2 cutoff `anti_gravity_cutoff_hz 5`;
  - `getTpaFactorClassic` and `getTpaFactor`: `tpa_mode D`, `tpa_rate 65`, `tpa_breakpoint 1350`, `tpa_low_rate 20`, `tpa_low_breakpoint 1050`, `tpa_low_always 0`;
  - D-max: `d_max {40,46,0}`, `d_max_gain 0`, `d_max_advance 35`.
- Skip: wing, S-term, launch control, acro trainer, chirp and GPS paths.
- Attitude input is `{ rollDeg, pitchDeg }` from the physics body. It replaces BF's IMU with a perfect attitude estimate.
- Crash recovery is off (the BF default).
- **Yaw spin recovery:** port `yaw_spin_recovery auto` (threshold 1950 deg/s): above the threshold, zero P/I/D/F on roll and pitch and I on yaw until the rate falls below 50 % of the threshold.

**2.5 `src/fc/gyro.js`, `class Gyro`:**
- `sample(trueRatesDps[3], motorHz[4], throttle, dT)` returns filtered `gyroADCf[3]`.
- **Sensor model:**
  - white noise σ = 0.35 deg/s;
  - vibration: for each motor, a sine at `motorHz[i]` (the fundamental) with amplitude `vibration·(rpm/maxRpm)²·(1 + 4·damage)` deg/s and a per-motor random phase. `vibration` is a per-airframe spec field (table 2.8);
  - frequencies above 0.5/dT are aliased by true sampling, because we sample the analytic sine at loop time. That is intentional and what real undersampling does.
- **Filters:**
  - gyro LPF1: dynamic PT1, min 250 max 500 by throttle, as `dyn_lpf_gyro` (port `dynLpfGyroUpdate`'s throttle curve);
  - gyro LPF2: PT1 500;
  - RPM filter: per motor, harmonics 1..3, notch Q 500, `rpm_filter_min_hz 100`, weights 100/0/100 (BF 2025 defaults), fade range 50 Hz; a notch is skipped when its frequency ≥ 0.48/dT;
  - a D-term input copy then goes through D-term LPF1 (dynamic PT1 75–150, `dterm_lpf1_dyn_expo 5`) and LPF2 (PT1 150). These live in `PidController`, following BF's order.
- Skip the dynamic notch (FFT). The RPM filter covers motor noise.

**2.6 `src/fc/mixer.js`, `class Mixer`** (BF `flight/mixer.c`):
- Motor order is ours: FL, FR, RL, RR.
- Table `{thr, roll, pitch, yaw}`: FL `{1,+1,-1,-1}`, FR `{1,-1,-1,+1}`, RL `{1,+1,+1,+1}`, RR `{1,-1,+1,-1}`. These are the rows of the sign table above.
- Port verbatim:
  - `mixTable` minus the 3D, servo, EZ-land, RPM-limit and autopilot branches;
  - `applyMixerAdjustment` (LEGACY), with `scaleAirmodeTransition(t) = 0.5 + t` for t < 0.5;
  - `pidSum/1000` after the ±limits;
  - throttle boost: `throttle_boost 5` ×0.1, with a PT1 at `throttle_boost_cutoff 15`;
  - thrust linearization (`thrustLinearization` 0 by default), via `pidApplyThrustLinearization` and `pidCompensateThrustLinearization` as quoted;
  - `applyMixToMotors`: `motor = motorOutputMin + range·(mix + throttle)`, constrained.
- Output is a normalised duty 0..1:
  - `motorOutputLow = dshotIdle` (per airframe, default 0.055);
  - `motorOutputHigh = motor_output_limit/100` (default 1);
  - disarmed output is exactly 0.
- Airmode:
  - setting `airmode` (default true);
  - it activates once, when throttle first exceeds `airmode_start_throttle_percent 25` while armed, and resets on disarm;
  - before activation, when throttle < 0.05, reset I-terms every loop (BF `zeroThrottleItermReset` behaviour).
- **Crash flip (turtle):** port `applyCrashFlipModeToMotors` from `mixer.c`:
  - stick direction picks the motor pair, as in BF;
  - output is negative duty, meaning a reversed direction;
  - `crashflip_motor_percent 0`, `crashflip_expo 35`, `CRASHFLIP_MOTOR_DEADBAND 0.02`.

**2.7 `src/fc/FlightController.js`, `class FlightController`** (facade):
- `constructor(tune)`
- `setTune(tune)` rebuilds gains and filters
- `setLoopRate(hz)`
- `onRxFrame(channelsUs, tSim)`
- `update(dT, { trueRatesDps, attitudeDeg, motorRpm[4], vbat })` returns `{ motors: Float32Array(4) /* -1..1 duty */, armed, flightMode, debug }`
- `debug` holds setpoint, gyro, and P/I/D/F per axis.

**Modes** come from channels via `modes` config (Phase 3). Fallback when no switch is mapped: `settings.flightMode` (keyboard `1`/`2`) and the keyboard/gamepad arm toggle.

**Arming rules** (BF `ARMING_DISABLED_*` subset). Arming is refused, and the reason is exposed as `armBlockReason`, with these strings:

| Condition | `armBlockReason` |
|---|---|
| throttle > 1050 µs | `THROTTLE` |
| arm switch already on at link-up, or the switch never saw off | `ARMSWITCH` |
| tilt > `small_angle 25°` | `ANGLE` |
| failsafe | `RXLOSS` |
| crash-flip switch on (arms in crash-flip mode instead) | none; arms in crash-flip mode |
| 1S brownout | `BROWNOUT` |

The HUD shows `armBlockReason` in the centre status.

- **Failsafe:** no RX frame for 300 ms means an immediate stage-2 drop: disarm, `armBlockReason = RXLOSS` until frames resume and the arm switch is seen off.
- **Brownout:** on 1S airframes only, if terminal cell voltage stays below 2.9 V for 50 ms, the FC reboots: disarm, `BROWNOUT` for 1.5 s.

**2.8 Physical quad model: `src/core/QuadPhysics.js`** (new, pure maths; replaces the thrust-curve internals).
- `export class QuadPhysics { constructor(spec); reset(); step(dt, { duty[4], bodyVel (body frame, m/s, air-relative), bodyRates, agl, gravityBody }) → { force[3], torque[3] (body frame, about CG), perMotorForce[4][3], rpm[4], packCurrent, vbat, cellV, soc } }`
- Constants: ρ = 1.225, `Kv_rad = KV·2π/60`, `Kt = 1/Kv_rad`.

**Battery:**
- `OCV(soc)` is the cell table for `spec.battery.chemistry`, interpolated linearly, times `cells`.
- SOC grid 0,5,10,20,30,40,50,60,70,80,90,100 %:

| chemistry | per-cell V |
|---|---|
| lipo | 3.00, 3.30, 3.45, 3.60, 3.68, 3.73, 3.78, 3.83, 3.90, 3.98, 4.08, 4.20 |
| lihv | 3.00, 3.35, 3.50, 3.65, 3.73, 3.79, 3.85, 3.92, 4.00, 4.10, 4.22, 4.35 |
| liion | 2.80, 3.10, 3.25, 3.42, 3.52, 3.60, 3.68, 3.76, 3.85, 3.95, 4.05, 4.20 |

- `Rpack = R0·(1 + 1.5·(1−soc)³)`, with `R0 = spec.battery.resistance`.

**Motor, ESC and bus solve** (implicit, closed form, once per step):
- back-EMF `e_i = ω_i/Kv_rad`; `d_i = |duty_i|`
- bus voltage: `V = (OCV − Rpack·(I_aux − Σ d_i·e_i/Rm)) / (1 + Rpack·Σ d_i²/Rm)`, with `I_aux = spec.auxCurrent`
- motor current: `I_i = clamp((d_i·V − e_i)/Rm, −escLimit, +escLimit)`. Damped light is always on, so braking current is allowed.
- `packCurrent = I_aux + Σ d_i·I_i`; `vbat = OCV − Rpack·packCurrent`.
- If any `I_i` was clamped, recompute `packCurrent` and `vbat` from the clamped currents (no second solve).
- Motor torque: `τm = Kt·(I_i − sign(I_i)·I0)` when `|I_i| > I0`, else `τm = 0`.

**Prop:**
- `n = ω/2π`
- static thrust `T0 = kT·ω²`; torque `Q0 = kQ·ω²`, with `kQ = qRatio·kT`
- axial inflow `va` = air velocity through the disc, positive when climbing along body-up
- inflow factor `fin = clamp(1 − va/(1.25·pitch·n), 0, 1.4)`
- hover induced velocity `vh = sqrt(T0/(2ρA))`, with `A = π(D/2)²`

**Ground effect:** `fge = 1/(1 − (R/(4·max(agl, R/2)))²)`, clamped to ≤ 1.3 and applied only when upright (`gravityBody·up < −0.5`).

**VRS / propwash:**
- `x = −va/vh`
- `w = exp(−((x−0.8)/0.35)²)` when `vh > 0.5`, else 0
- `fvrs = 1 − 0.25·w`
- per-motor turbulence `η_i` is band-limited noise (a PT1 at 18 Hz on white noise, seeded per motor) with σ = `0.18·w`
- thrust ×(1 + η_i)
- turbulence is a real thrust asymmetry, so it creates real torques the gyro sees. Delete the old `_washAxis` gyro injection.

**Translational lift:** `fetl = 1 + 0.12·(1 − exp(−(v_edge/vh)²))`, where `v_edge` is the in-plane airspeed magnitude.

**Thrust and torque:**
- `T_i = T0·fin·fge·fvrs·fetl·(1+η_i)`
- `Q_i = Q0·(0.6 + 0.4·fin)`
- Reversed rotation (crash flip, `duty < 0`): thrust `−0.45·kT·ω²`; the torque sign flips.

**Rotor drag (H-force):** `F_h,i = −spec.rotorDrag·|ω_i|·v_edge_vec`, applied at the prop hub.

**Rotor speed update** (semi-implicit):
- `f(ω) = (τm − sign(ω)·Q)/Jrot`
- `ω += dt·f/(1 − dt·∂f/∂ω)`, with `∂f/∂ω ≈ −(Kt²/Rm·d + 2kQ|ω|)/Jrot`

**Body loads:**
- thrust at the hub (`±arm, propHeight, ±arm`), along body +Y
- yaw reaction `Σ s_i·(Q_i + Jrot·dω_i/dt)` about body Y, with `s = −1` for CW props (FL, RR) and +1 for CCW props (FR, RL)
- gyroscopic `τ = −bodyRates × (Σ s_i·Jrot·ω_i·ŷ)`
- body drag `F = −½ρ·CdA_axis·|v|·v` per body axis, using `spec.cdA = [side, top, front]`

**Wind:** keep the gust generator from `_applyWind`, but output a wind *vector*. `bodyVel` becomes `vel − wind` (air-relative) for every aero term. Delete the separate wind force.

**Derived spec values** (`derive()` in DroneTypes, replacing all current gain derivation). Delete `pid`, `alphaMax`, `tau`, `thrustExponent`, `motorTau`, `motorIdle`, `yawTorqueCoef`, `maxPowerW`, `motorMaxRPM`, `dragLateral` and `dragVertical`, plus `INTEGRAL_TIME`, `YAW_TAU`, `YAW_INTEGRAL_TIME` and `D_AUTHORITY`.
- `V = cells·3.9` (loaded nominal)
- `ωmax = Kv_rad·(V − Rm·(qRatio·Tmax/Kt + I0))`; throw at module load if ≤ 0
- `kT = Tmax/ωmax²`
- `hoverThrottle` is found by bisection on the steady-state bus solve, with 4 motors at duty d producing weight: `hoverDuty`, then `hoverThrottle = (hoverDuty − dshotIdle)/(1 − dshotIdle)`
- `weight`, `inertia` (`boxInertia`, unchanged)
- `topSpeed` and `sinkRate` are estimated by a 40 s headless run in the tests only (not at module load)

**Airframe table** (replaces the propulsion and aero fields in `AIRFRAMES`; `id`, `displayName`, `className`, `description`, `accent`, `visual`, `audio` and `cameraMount` stay):

| id | mass kg | body m | KV | cells/chem | Rm Ω | I0 A | escLimit A | Tmax N/motor | D m | pitch m | qRatio m | Jrot kg·m² | rotorDrag | cdA [side,top,front] m² | R0 Ω | mAh | auxCurrent A | dshotIdle | vibration | propHeight m |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tinywhoop | 0.028 | .075,.028,.075 | 27000 | 1/lihv | 1.2 | 0.10 | 5 | 0.22 | 0.031 | 0.020 | 0.0030 | 2.5e-8 | 1.2e-7 | .0016,.0040,.0016 | 0.06 | 300 | 0.35 | 0.07 | 25 | 0.012 |
| freestyle | 0.65 | .20,.06,.20 | 1860 | 6/lipo | 0.070 | 1.4 | 55 | 17.5 | 0.1295 | 0.0914 | 0.0115 | 8.2e-6 | 2.0e-5 | .012,.030,.012 | 0.025 | 1300 | 0.6 | 0.055 | 40 | 0.028 |
| racer | 0.58 | .19,.05,.19 | 2100 | 6/lipo | 0.060 | 1.6 | 60 | 19.0 | 0.1295 | 0.104 | 0.0125 | 7.8e-6 | 1.8e-5 | .010,.026,.010 | 0.022 | 1100 | 0.6 | 0.055 | 45 | 0.024 |
| toothpick | 0.095 | .11,.035,.11 | 5000 | 4/lipo | 0.25 | 0.4 | 20 | 2.35 | 0.0762 | 0.046 | 0.0068 | 9.0e-7 | 4.0e-6 | .003,.008,.003 | 0.05 | 650 | 0.4 | 0.055 | 35 | 0.016 |
| freestyle-hd | 0.72 | .22,.065,.22 | 1750 | 6/lipo | 0.070 | 1.3 | 55 | 18.5 | 0.1397 | 0.0889 | 0.0120 | 9.5e-6 | 2.2e-5 | .014,.034,.014 | 0.025 | 1300 | 0.8 | 0.055 | 38 | 0.030 |
| street-league | 0.60 | .19,.055,.19 | 1950 | 6/lipo | 0.070 | 1.4 | 55 | 17.0 | 0.1295 | 0.0914 | 0.0115 | 8.0e-6 | 1.9e-5 | .011,.028,.011 | 0.024 | 1100 | 0.6 | 0.055 | 40 | 0.026 |
| mega | 0.95 | .26,.07,.26 | 1300 | 6/liion(6S2P) | 0.065 | 1.0 | 55 | 21.0 | 0.178 | 0.089 | 0.0160 | 2.3e-5 | 3.2e-5 | .018,.050,.018 | 0.045 | 4000 | 0.8 | 0.05 | 30 | 0.034 |

`arm` values stay as they are today (tinywhoop 0.023, freestyle 0.09, racer 0.0742, toothpick 0.046, freestyle-hd 0.096, street-league 0.078, mega 0.113).

**Stock tunes** (`spec.tune`, BF units; P/I/D/Dmax/F):

| Airframe(s) | Roll | Pitch | Yaw | Filters |
|---|---|---|---|---|
| 5" class (freestyle, racer, freestyle-hd, street-league) | 45/80/30/40/120 | 47/84/34/46/125 | 45/80/0/0/120 | BF defaults |
| toothpick | 40/75/28/36/110 | 42/78/31/40/115 | 40/75/0/0/110 | BF defaults |
| tinywhoop | 70/90/50/60/60 | 75/95/55/65/65 | 80/90/0/0/60 | `dterm_lpf1_dyn` 100–200, `dterm_lpf2` 200 |
| mega | 42/80/34/42/100 | 44/84/38/48/105 | 40/80/0/0/100 | `dterm_lpf1_dyn` 60–120, `dterm_lpf2` 120 |

Stock rates (Actual; `rcRates` = center/10, `rates` = max/10, expo %):

| Airframe | center | max | expo |
|---|---|---|---|
| tinywhoop | 200 | 700 | 50 |
| freestyle | 100 | 800 | 55 |
| racer | 250 | 900 | 20 |
| toothpick | 150 | 800 | 45 |
| freestyle-hd | 90 | 650 | 55 |
| street-league | 150 | 800 | 45 |
| mega | 70 | 500 | 50 |

Yaw is the same as roll except max = 0.8 × roll max. Angle limit is 55 for all airframes except the tinywhoop, which uses 45.

- **Tuning acceptance.** A new headless script `tests/tune-check.mjs` reports rate step response (a 0→±500 deg/s roll step at 1 kHz, hovering at 60 m) for each airframe. It must show overshoot < 20 %, settle to ±5 % within 150 ms, and no sustained oscillation (gyro RMS after 400 ms < 3 % of the step).
- If an airframe fails, multiply that airframe's P, I, D and Dmax together by 0.9 (overshoot or oscillation) or 1.1 (settling too slow), up to 6 iterations. Record the final numbers in DroneTypes. This script is kept as a permanent dev tool but not added to `npm test`.
- Fitting. After the tunes pass, run `tests/fit-aero.mjs`, a throwaway that is deleted after use. For each airframe it scales `cdA` uniformly until full-stick acro top speed lands mid-envelope:

| Airframe | Top speed envelope, m/s |
|---|---|
| whoop | 6–10 |
| freestyle | 33–44 |
| racer | 42–53 |
| toothpick | 19–28 |
| freestyle-hd | 30–42 |
| street-league | 33–44 |
| mega | 30–42 |

  Then write the fitted values into the airframe table.

**2.9 `DroneController` rewrite** (same file, same public facade; every member listed below keeps working).

Public members that must survive (used by main, HUD, Audio, CameraRig and tests):
- constructor `(physics, airframeId)`, `body`, `object3d`
- callbacks `onCrash(impact, severity)`, `onArmChange`, `onBatteryState(stage)`
- `batteryVoltage`, `batteryCharge`, `packCurrent`, `telemetry`
- `setSpawn`, `respawn`, `update(h, controls)`, `afterStep`, `registerImpact`
- `groundLevel`, `windEnabled`, `throttleEverApplied`, `currPosition`, `currQuaternion`
- `applyInterpolation`, `updateVisuals`, `avgMotor`, `armed`, `spec`, `motors`, `getBatteryStage`, `damage`, `motorCutByBattery`
- `toggleArmed`, `setArmed`, `isInverted`, `requestTurtle`, `setAirframe`, `spawnPoint`, `consumedMah`, `flightTime`, `crashed`

`update(dt, controls)` steps, per substep:
1. Deliver any RX frames whose timestamp is ≤ the current sim time from `controls.rxFrames` (Phase 3) into `fc.onRxFrame`.
2. Read true body rates (deg/s, FC convention; reuse the existing negation mapping from `_readBodyRates` without the noise and wash code) and attitude (`telemetry` formulas).
3. Run `fc.update`.
4. Run `quad.step`.
5. Apply `perMotorForce` with `body.applyLocalForce` at the hub offsets, and apply torques (the yaw reaction and gyroscopic terms, rotated to world) with `applyTorque`.
6. Telemetry.

Deletions (clean cutover):
- `_flightControl`, `_pidAxis`, `_mix`, `_applyDamageCap`
- `_motorThrust`, `_updateInflow`, `_applyAerodynamics`, `_totalThrust`
- `_applyGroundEffect`, `_applyPropwash`, `_applyTranslationalLift`, `_applyInducedDrag`
- `_updateBattery` internals, `_applyTurtle` (real crash-flip replaces it)
- `betaflightRate`, `actualRates`, `tpaFactorFor`, `seedThrottleCurve`, `fractSinNoise`
- `I_LIMIT`, `ANGLE_P`, `D_CUTOFF_HZ`, `ANGLE_MAX_RATE`, `CRASH_LOCKOUT`'s use for 'hard' hits

Changed members:
- `angularDamping` becomes 0 (all damping is now physical); `linearDamping` 0.
- `motorRPM` becomes the real RPM per motor. `motors` stays the duty 0..1 (absolute value).
- `avgMotor` = mean |duty|.
- New `motorRpmMax = ωmax·60/2π` for audio and visuals.
- `requestTurtle()` sets the momentary crash-flip channel for 1.5 s on the keyboard path. `isInverted` is unchanged.

Crash handling:
- **'destroyed'** (≥ 6 m/s): disarm plus damage, as today.
- **'hard'**: no input lockout, only audio and the callback.
- **Damage** raises `vibration` (it is already multiplied in by the gyro model) and scales `Tmax` on one random motor by `1 − 0.3·damage` (bent prop).

Battery stages, from rested cell voltage, i.e. OCV per cell:
- 'low' < 3.5
- 'critical' < 3.3
- 'cutoff' < 3.0

'cutoff' no longer disarms, except for the 1S brownout, which sets `motorCutByBattery = true`. Keep the `spec.battery.LOW/CRITICAL/CUTOFF/label/cells/FULL` fields, derived from chemistry and cells, so the main.js L376 and HUD reads keep working.

**2.10 Settings (`src/core/Settings.js`).**
- `STORAGE_KEY = 'fpv-sim.settings.v3'`. On first load, read `fpv-sim.settings.v2`, carry over only `gamepadMapping`, `bestTimes`, `volume`, `graphicsQuality` and `droneType`, then delete the v2 key.
- **Delete these keys:** `rates`, `rateProfile`, `rateMode`, `actualProfile`, `tpa`, `feedforward`, `pidScale`, `throttleCurve`, `horizonBlend`, `maxTilt`, `expo`, `sensitivity`, `crtFilter`, `lensDistortion`.
- **Add:**
  - `fcRates`: `{ type: 'actual'|'betaflight'|'quick'|'kiss'|'raceflight', rcRates:[3], rates:[3], rcExpo:[3], thrMid:50, thrExpo:0, rateLimit:[1998,1998,1998] }`. Integers: rcRates 1–255, rates 0–255 (actual 0–200), rcExpo 0–100.
  - `fcPid`: `{ roll:{p,i,d,dMax,f}, pitch:{…}, yaw:{…}, levelP:50, levelI:75, levelD:75, angleLimit:55 }`. Each 0–250 (`f` 0–1000); `angleLimit` 10–90.
  - `fcFilters`: `{ dtermLpf1Min:75, dtermLpf1Max:150, dtermLpf2:150, gyroLpf1Min:250, gyroLpf1Max:500, gyroLpf2:500, rpmFilter:true, rpmHarmonics:3, yawLowpass:100 }`
  - `fcMisc`: `{ airmode:true, antiGravityGain:80, itermRelaxCutoff:15, tpaRate:65, tpaBreakpoint:1350, throttleBoost:5, thrustLinear:0, motorOutputLimit:100, dshotIdle:5.5, ffJitter:7, ffSmooth:65, ffBoost:15, ffMaxRateLimit:90, rcSmoothingAuto:30 }`
  - `renderBackend`, `fpvLens`, `lensFisheye`, `videoSystem`, `propsInView`, `gateSpec` (Phase 4), plus the radio keys (Phase 3).
- `simRate` whitelist becomes `[2000, 1000, 500]`, default 1000. In `main.js`, set `SIM_RATES=[2000,1000,500]` and floor the adaptive step-down at 500. Keep the `substepCap` formula `max(4, ceil(rate/24))`.
- `loadAirframeProfile(id)` writes `droneType`, `fcRates`, `fcPid`, `fcFilters`, `fcMisc.dshotIdle` and `ratePreset:'stock'` from `spec.tune` and `spec.dshotIdle`.
- `RATE_PRESETS` are rewritten in BF units and applied to `fcRates`:

| id | type | roll & pitch | yaw |
|---|---|---|---|
| `stock` | per airframe | — | — |
| `bf-default` | actual | 7 / 67 / 0 | same |
| `freestyle800` | actual | 10 / 80 / 55 | 10 / 64 / 55 |
| `race900` | actual | 25 / 90 / 20 | 25 / 72 / 20 |
| `cinematic450` | actual | 6 / 45 / 30 | same |
| `whoop700` | actual | 20 / 70 / 50 | same |
| `velocidrone` | betaflight | 100 / 70 / 0 | 100 / 65 / 0 |
| `liftoff` | betaflight | 120 / 72 / 25 | 110 / 65 / 20 |
| `custom` | — | — | — |

  `velocidrone` and `liftoff` values are rcRate ×100 / super rate ×100 / expo.
- `DroneController` calls `fc.setTune(...)` whenever `main._applySettings` sees a change in any `fc*` key. Add a `drone.applyTune()` call there.

**2.11 UI.**
- `MainMenu._renderSettings` replaces the "Rates & sensitivity" and "Rate presets & curves" sections with a **Betaflight** section:
  - rates type select;
  - per-axis rows for the three BF rate fields (labels switch by type: Actual shows "Center / Max / Expo"; Betaflight shows "RC Rate / Super / Expo");
  - a 240×120 `<canvas>` live rate curve for all three axes via `maxRcRate` and `applyRates`, redrawn on input, showing the max deg/s for each axis;
  - a PID table (P/I/D/Dmax/F per axis as number inputs);
  - master sliders for Angle limit, Anti-gravity, I-relax cutoff, TPA rate/breakpoint, Throttle boost, Dshot idle and FF jitter/smooth/boost;
  - filter sliders;
  - an Airmode toggle;
  - a "Reset to airframe tune" button that calls `loadAirframeProfile`.
- `PauseMenu` Flight tuning uses the same widgets through a new exported helper `renderBetaflightTuning(panel, changed)` in `MainMenu.js`, so both menus share one implementation. Delete PauseMenu's `pidScale`, `tpa`, `feedforward` and `throttleCurve` rows.
- Flight mode select offers angle / horizon / acro.

**2.12 Blackbox (`src/core/Blackbox.js`).**
- Header: `loopIteration,time,rcCommand0..3,setpoint0..2,gyroADC0..2,axisP0..2,axisI0..2,axisD0..2,axisF0..2,motor0..3,rpm0..3,vbat,amperage`.
- `t` is sim time.
- `MAX_ROWS = 30000`.
- Pushed every FC loop when `blackbox` is true.
- Add a `blackbox` toggle to PauseMenu next to the download button.

**2.13 Audio.**
- `main.js` L774 passes `load = mean(motorRPM)/spec.motorRpmMax` instead of `avgMotor`.
- `AudioEngine.updateMotors` is unchanged. Motor spread now uses RPM spread.

### Phase 3 — Radio connection

**3.1 Channel model.**
- `InputManager.controls` gains `channels: Float32Array(16)` in µs (1000–2000, centre 1500) and `rxFrames: []`, an array of `{ t: simSeconds, ch: Float32Array(16) }` produced this render frame.
- `throttle`, `pitch`, `roll` and `yaw` are still written, for HUD and diagnostics.
- Channel order follows `rxChannelMap` (default `'AETR'`, oneOf `'AETR'` or `'TAER'`), applied when reading source channels.
- Sources:
  - keyboard: synthesises channels, with AUX1 = arm state from the Space toggle and AUX2 = mode from keys 1/2;
  - gamepad axes: via mapping;
  - serial: raw.
- Remove InputManager's own `expo` and `sensitivity` shaping (BF rates handle it). `deadzone` becomes `rcDeadband` in µs (0–50; default 0 for serial and radio presets, 10 for gamepads). It is applied by `RcProcessor`, not InputManager.
- **Timing.** A `setInterval(pollGamepad, 4)` samples the pad at 250 Hz into a ring buffer with `performance.now()` stamps. `main._stepPhysics` maps wall time to sim time for the frame: substep k of n covers `frameStartWall + k·h`. It hands each frame's samples to `controls.rxFrames` with sim timestamps. Keyboard produces frames at 100 Hz the same way.
- The RC link emulation (`rcLatencyMs`, `rcLoss`) is applied to the frame timestamps and drops for keyboard and gamepad only.

**3.2 Modes (Betaflight Modes tab).**
- Setting `modes`: array of `{ mode: 'ARM'|'ANGLE'|'HORIZON'|'FLIPOVERAFTERCRASH'|'BEEPER'|'PREARM', channel: 4..15 (0-based; 4 = AUX1), min: 900..2100, max: 900..2100 }`.
- Default: `[{ARM,4,1700,2100},{ANGLE,5,900,1300},{HORIZON,5,1300,1700},{FLIPOVERAFTERCRASH,6,1700,2100}]`.
- `FlightController` evaluates modes on every RX frame. Precedence: ANGLE > HORIZON > acro.
- **BEEPER** plays `audio.playBlip` in a 4 Hz loop.
- **Switch-based arming** takes over whenever the active source is serial or a gamepad whose mapping has `aux` axes bound. Gamepad and keyboard ARM button toggles are then ignored, and the toast "Arm with your ARM switch" is shown once.
- UI: a new Settings → **Radio** section containing:
  - source status;
  - a 16-channel live monitor (bars, µs values; reuse the `.axis-line` CSS);
  - a channel map select;
  - a modes editor (one row per mode: channel select plus min/max sliders, with the live channel value marker);
  - the serial connect UI (3.4).

**3.3 Gamepad-as-radio presets** (EdgeTX/OpenTX USB joystick, ELRS BLE joystick).
- `REMAPPABLE` gains `aux1`…`aux8` (kind axis). `sanitizeMapping` and `REMAP_KIND` are updated to match.
- `mode: 'bipolar'` maps to 1000–2000 µs.
- New "Load radio preset" select in Controller setup:
  - **EdgeTX / OpenTX (AETR):** roll axis 0, pitch axis 1 (lo -1, hi 1), throttle axis 2 (bipolar lo -1 hi 1, *not* unipolar), yaw axis 3, aux1..4 = axes 4..7;
  - **Spektrum/Futaba order (TAER):** throttle 0, roll 1, pitch 2, yaw 3, aux1..4 = axes 4..7;
  - **Xbox/PS pad (standard):** the current defaults.
- `settings.rxChannelMap` is set by the preset.
- Calibration keeps working. The existing `CALIBRATABLE_AXES` is extended with `aux1..aux4`; aux calibration records full range, and positive is "switch up".

**3.4 WebSerial receivers: `src/input/SerialRx.js`** (new).
- `export class SerialRx { static supported(); async connect({ protocol: 'crsf'|'sbus', baud }); disconnect(); onFrame(cb: (chUs: Float32Array, tWall) => void); stats: { fps, lq, rssiDbm, lastFrameWall, errors } }`
- `connect` calls `navigator.serial.requestPort()`, which requires a user gesture, so it is called from the button handler.
- **CRSF:**
  - `open({ baudRate: baud (default 420000; options 420000, 416666, 921600), dataBits 8, parity 'none', stopBits 1 })`;
  - frames are `[sync ∈ {0xC8,0xEE,0xEA}] [len 2..62] [type] [payload] [crc8]`, with CRC-8 DVB-S2 (poly 0xD5) over type+payload;
  - type 0x16 `RC_CHANNELS_PACKED`: 22 bytes, 16×11-bit little-endian, `us = 1500 + (v − 992)·5/8`;
  - type 0x14 `LINK_STATISTICS`: `lq = payload[2]`, `rssiDbm = −payload[0]`;
  - on CRC failure, increment `errors` and resync on the next sync byte.
- **SBUS:**
  - `open({ baudRate: 100000, dataBits 8, parity 'even', stopBits 2 })`;
  - 25-byte frames, `0x0F … flags 0x00`, 16×11-bit;
  - flags bit2 = frame lost (count it) and bit3 = failsafe (stop emitting frames, which triggers FC failsafe);
  - `us = 1500 + (v − 992)·5/8`.
  - The UI hint says SBUS needs an uninverted signal (an F4 uninverted pad or an inverter).
- InputManager adds source `'serial'` and `inputMode` option `'serial'`. In `'auto'`, serial wins whenever a frame arrived < 100 ms ago.
- Serial frames go straight into `rxFrames` with their own wall timestamps, so real ELRS 250/500 Hz timing reaches `RcProcessor`. No link emulation.
- On `navigator.serial` `disconnect`, emit `onDeviceEvent('warn', 'Receiver disconnected')`.
- Settings: `serialProtocol` ('crsf'), `serialBaud` (420000).
- Unsupported browsers (no `navigator.serial`): disable the button and show the hint "WebSerial needs Chrome/Edge".

**3.5 OSD.** HUD adds:
- LQ/RSSI (`LQ 100` from CRSF stats; otherwise the emulated `rssi`);
- average cell voltage;
- current (A);
- `armBlockReason` text in the centre;
- BF warning strings `LAND NOW` (critical), `LOW BATTERY` (low) and `RXLOSS`.

### Phase 4 — Gate spec toggle

- Setting `gateSpec: 'league' | 'multigp'`, default `'league'`.
- Shown as a select in the map launcher, and read by `MapKit` at build time. It is applied on the next map load; toast "Reload map to apply".
- In `MapKit.gate()`, when `settings.get('gateSpec') === 'multigp'` and `style` is `'square'` or `'dive'`:
  - if the requested `w ≥ 1.5·h`, it is a hurdle: `w = 3.048`, `h = 1.524`;
  - otherwise `w = h = 1.524`.
  - Bar thickness uses the existing formula. Position and rotation are unchanged. Rings are untouched.
  - Stacked ladders keep their authored centres, so the openings shrink in place.
- Best times key on layout. Append `:mgp` to the time-trial layout id when multigp, so records are separate. `recordBestTime` callers take the suffix from a helper `raceLayoutId(mapId)` in `main.js`.

## Critical files & anchors

- `src/core/DroneController.js`: `update` (~L656), `_readBodyRates` (~L735) and the facade members listed in 2.9. This is the physics/FC integration point, and main.js, HUD and tests depend on its surface.
- `src/core/CameraRig.js`: `render()` / `_buildComposer` (~L528–643), `_applyJello`, `applySettings`. All three are replaced by `PostStack` and `FpvLens`.
- `src/main.js`: `_buildRenderer` (~L175), `_stepPhysics` (~L590; the RX-frame sim-time mapping goes here), `SIM_RATES` (L74), `_applySettings` (~L1031), `_handleActions` ARM (~L853).
- `src/core/Settings.js`: `defaultSettings` (L27) and `sanitize` (L223). Keys not added to both are silently dropped.
- `src/core/InputManager.js`: `_updateLink`, `_shapeRotational`, source arbitration (~L963–976), `REMAP_KIND`.

## Verification

Working directory: repo root. Run `npm test` and `npm run build` after every phase.

**Graphics (Phase 1):**
1. `npm run dev`, then open it in Chrome with the browser tool. On the Open Field map, confirm:
   - the console shows no "Multiple instances of Three.js" warning;
   - `renderer.backend.isWebGPUBackend === true` (check via `tab.run`).
2. Take screenshots in FPV (fisheye), chase, `fpvLens='fisheye-cube'` at fov 170 (a curved horizon must be visible), `videoSystem='analog'` (4:3 pillarbox, scanlines), Coastal (WaterMesh reflections) and Warehouse (godrays).
3. Relaunch with `renderBackend='webgl2'`. The same maps must render without errors.
4. `grep -rE "onBeforeCompile|ShaderMaterial|gl_FragColor|EffectComposer|ShaderPass" src` must print nothing.

**Physics (Phase 2):** new `tests/fc.test.mjs`, added to `npm test`:
- Actual Rates with rc 7, rate 67, expo 0 gives 670.0 at stick 1 and 185.0 at stick 0.5.
- Betaflight rates with rcRate 100, super 70, expo 0 give 666.67 at stick 1 and 153.85 at stick 0.5 (±0.01).
- `pt1FilterGain(100, 0.001)` = 0.3859 ±1e-4.
- Mixer: pure +roll PID output gives FL and RL > FR and RR. Each sign-table row is asserted.
- With roll/pitch saturation at throttle 1, airmode keeps the motor spread equal to `min(1, range)`.
- I-term relax: a 500 deg/s setpoint step produces I change < 5 % of the no-relax value over 20 ms.
- Feedforward: a stick ramp at a 250 Hz RX rate gives F > 0 during the ramp and decays to < 5 % within 100 ms after it stops.
- CRSF parser: the channel packet built from `[992…]` decodes to 1500 µs, and a corrupted CRC increments `errors`.
- SBUS parser: failsafe bit set means no frame emitted.

**`tests/flight-model.test.mjs`**, re-baselined:
- `DT = 1/1000`.
- Delete section A's derived-gain checks (`Kd·alphaMax`, `Kp·alphaMax`, hover-thrust identity) and the `actualRates` import. Keep the `boxInertia` check.
- Add static thrust: at duty 1, a full pack and zero airspeed, `quad.step` steady-state thrust per motor = `Tmax` ±5 %.
- Hover uses `spec.hoverThrottle` sent through channels.
- Acro roll rate: full stick reaches `maxRcRate(roll)` ±10 % within 0.4 s.
- Motor spool: the 10–90 % RPM rise time from hover to full duty is within these bounds:

| Airframe | Rise time, ms |
|---|---|
| 5" class | 20–90 |
| whoop | 40–200 |
| mega | 40–150 |

- Crash flip: body inverted on the ground plane, armed in FLIPOVERAFTERCRASH with roll stick full; it must be upright (`up.y > 0.7`) within 3 s.
- SPEED_ENVELOPE: acro values from the 2.8 table. Angle envelopes are removed and replaced by "angle-mode tilt ≤ angleLimit + 5°".
- Sink at idle: whoop 2.5–5, 5" class 7–15, toothpick 4–8, mega 7–14 m/s.
- The failsafe case: stop sending frames and the drone must be disarmed within 0.35 s.
- The garbage-input, soak, disarmed, fresh-pack and collision (C, C2, C2b) cases are kept, with `registerImpact` semantics unchanged.
- `tests/collisions.test.mjs` runs unchanged, except its step is 1/1000.

**Radio (Phase 3):**
- `tests/input.test.mjs` adds an EdgeTX preset case. Fake pad axes `[0,0,-1,0,1,-1,0,0]` must give channels roll 1500, throttle 1000 and AUX1 2000, and ARM must evaluate true once the throttle is low and AUX1 has been seen off first.
- Manual check in Chrome with a real radio: connect → Radio monitor bars move → flip the ARM switch → the OSD shows armed. Report this as manual-only if no hardware is available.

**Gates (Phase 4):**
- `tests/collisions.test.mjs` adds a pass with `settings.set('gateSpec','multigp')` on Apex Arena. Each square gate's centre and centre ±0.6 m in-plane must be open air, and centre ±0.9 m must hit the frame.

## Assumptions & contingencies

- **WebGPU not in Node.** If `import('three/webgpu')` fails in Node, keep `src` importing `'three'` with the Vite alias doing the redirect, and use the Node loader stub described in 1.1.
- **Missing TSL node export.** If a TSL display node named here (e.g. `ssr`, `traa`, `lensflare`, `godrays`) has a different export name in the installed three 0.185.1, read the module under `node_modules/three/examples/jsm/tsl/display/` and use its actual export. If the node does not exist, drop that single effect from the tier matrix.
- **CSMShadowNode.** If it fails under the WebGL2 backend, gate it to WebGPU only and keep `_followShadow` on WebGL2.
- **Frame rate.** If a stock-tune airframe cannot pass tune-check at 500 Hz (the adaptive floor), raise the floor to 1000, and on slow machines drop render effects (1.8) instead of the sim rate.
- **Tuning and fitting are data-driven.** Airframe parameters in 2.8 are reference-build estimates. The fit and tune loops in 2.8 are authoritative, and their outputs overwrite the table.
- **No SimITL comparison.** SimITL is not built here, so there is no cross-validation against real Betaflight binaries. Rate and filter correctness rests on the verbatim ports and the numeric tests above.
