# MASTER BUILD PROMPT: FPV Drone Flight Simulator (Web-Based)

> Copy everything below into your AI coding assistant as a single prompt. It merges a physics/content-detail spec with a stability/defensive-engineering spec, so the result should be both **deep** (real flight-model fidelity, rich environments) and **robust** (never crashes, degrades gracefully).

---

## ROLE

You are acting as an expert game developer, 3D graphics programmer, simulation/flight-dynamics engineer, UX designer, and performance engineer simultaneously. Build a **fully playable, browser-based FPV (First-Person View) drone flying simulator** — something that feels like a lightweight, polished FPV training tool, not a static 3D tech demo.

The simulator must let the user:

- Fly a drone in first-person FPV view
- Control it with **arrow keys** plus supplementary keyboard bindings
- Plug in a **USB/Bluetooth game controller, RC transmitter, or any HID device exposed through the Gamepad API** and fly with analog sticks
- Freely switch between keyboard and controller input, live, without restarting
- Choose between **three maps**: Indoor House, Abandoned Warehouse, Open Field
- Reset/respawn instantly, pause/resume, and adjust flight settings
- See basic flight telemetry (an FPV-style OSD)
- Practice hovering, turning, climbing, descending, strafing, gate-racing, and tight-space navigation

Prioritize, in this order: **stability → responsive/believable controls → good-looking environments → depth of physics/features**. A simpler feature that never crashes beats a sophisticated one that occasionally does. If a sophisticated feature can't be implemented reliably in the time/space you have, implement a simpler, stable version instead and say so in a comment.

---

## 1. TECH STACK

- **Three.js** (latest stable) for rendering/scene graph. React Three Fiber is acceptable if you're more reliable with it, but plain Three.js + Vite is preferred for simplicity and fewer moving parts.
- **Cannon-es** (or Rapier/WASM if you prefer) for rigid-body physics and collision.
- **Vite** + vanilla JavaScript or TypeScript (TypeScript preferred if you can keep it clean — it catches the NaN/undefined-shaped bugs this project is prone to).
- Native **Gamepad API** — implement raw polling yourself, no wrapper library.
- Single-page app, fully client-side, no backend, runs with `npm install && npm run dev`.
- Do **not** add dependencies you don't need. Avoid heavy asset pipelines — see Asset Strategy below.
- Primary target: desktop/laptop browsers — Chrome, Edge, Firefox, Safari where practical. No mobile-specific input required, but don't let a touch device crash the app either.

### Asset strategy
Do not rely on downloaded 3D models or texture files. Build all environments from **procedural Three.js primitives** (Box/Plane/Cylinder/Torus/InstancedMesh) with materials generated via `CanvasTexture`/noise functions for wood grain, concrete, rust, grass, etc. This keeps the project license-free, dependency-free, and instantly runnable. If a procedural asset ever fails to build, substitute a plain-colored primitive and keep running — never let a missing asset halt the app.

---

## 2. PROJECT STRUCTURE

```
fpv-sim/
├── index.html
├── package.json
├── vite.config.js
├── src/
│   ├── main.js                 // app entry, game loop, top-level state machine
│   ├── core/
│   │   ├── DroneController.js  // flight physics/model
│   │   ├── InputManager.js     // keyboard + gamepad → normalized controls
│   │   ├── CameraRig.js        // FPV camera, FOV, lag, shake
│   │   ├── PhysicsWorld.js     // cannon-es world, collision groups, safety clamps
│   │   └── MapManager.js       // load/unload/reset active map, spawn points, bounds
│   ├── maps/
│   │   ├── HouseMap.js
│   │   ├── WarehouseMap.js
│   │   └── FieldMap.js
│   ├── ui/
│   │   ├── HUD.js              // OSD overlay: battery, speed, timer, artificial horizon
│   │   ├── MainMenu.js         // map select, control select, settings
│   │   ├── PauseMenu.js
│   │   └── ControllerDiagnostics.js  // live stick/button visualization
│   └── assets/
│       └── (procedurally generated only — no external files required)
└── README.md
```

Every file must be **fully implemented**, not stubbed. If space runs short in your response, the non-negotiable core to prioritize completeness on is: `DroneController.js`, `InputManager.js`, `PhysicsWorld.js`, and all three map files — those four are what make this a simulator rather than a demo.

---

## 3. ABSOLUTE STABILITY REQUIREMENT (read this section as load-bearing, not optional polish)

**The application must never crash**, regardless of:

- Missing, unsupported, disconnecting, or reconnecting controller
- Window resizing, losing focus, tab backgrounding/visibility changes
- WebGL feature gaps or low-end hardware
- Any asset or texture failing to generate/load
- Invalid keyboard state (e.g., keyup missed due to focus loss)
- Physics instability: extreme velocity, NaN/Infinity creeping into state, invalid position/rotation
- Rapid map switching, repeated resets, repeated pause/resume, repeated input-mode switching
- Unsupported browser / missing Gamepad API entirely

Every subsystem must **fail gracefully and keep the simulator running**:

- **Gamepad API unavailable** → continue on keyboard, show a small non-blocking message: *"Game controller not detected — keyboard controls are active."*
- **WebGL feature missing** → fall back to a simpler render path; never let an exception propagate up and kill the app.
- **Procedural asset build fails** → substitute a primitive placeholder, log a warning, keep going.
- **Audio fails to init/play** → disable that sound only, continue silently.
- **Controller disconnects mid-flight** → clear its input immediately, force throttle/pitch/roll/yaw to a safe neutral state (not "last held value"), fall back to keyboard, show a toast. Never leave a stale throttle value driving the drone after disconnect.
- **Controller reconnects** → detect it, show its name, let the user reselect it if multiple are present.
- **Controller reports garbage values** (NaN, Infinity, out-of-range) → clamp/reject before they ever reach the Input Manager's normalized output.

Use defensive programming throughout: guard clauses, `Number.isFinite()` checks, clamped ranges, try/catch around anything touching external browser APIs (Gamepad API, localStorage, WebAudio, fullscreen, pointer lock).

**If any critical drone state becomes invalid at runtime, self-heal instead of crashing:**
- Position becomes NaN/Infinity → snap back to last known-valid position (or spawn point).
- Velocity becomes NaN/Infinity or exceeds a sane max → zero it out or clamp to max.
- Rotation/quaternion becomes invalid or non-normalized → reset orientation to level, re-normalize the quaternion every frame regardless as a cheap safety net.

---

## 4. GAME LOOP

- Fixed-timestep physics (e.g. 1/120s substeps) decoupled from variable render framerate, with interpolation for smooth visuals — physics behavior shouldn't change with monitor refresh rate.
- **Clamp delta time** each frame (e.g., max 0.1–0.25s per step). If a tab is backgrounded and comes back after 2 seconds, do **not** simulate 2 seconds of physics in one jump — clamp it so the drone doesn't fling itself through a wall or accumulate an absurd velocity spike.
- Apply hard safety ceilings inside the physics step itself, not just at the input layer: max linear velocity, max angular velocity, max single-frame position delta. If a value would exceed these, clamp it and continue — don't throw.
- Pausing must fully halt the physics/render tick (not just hide UI) and resuming must not "catch up" on the paused duration.

---

## 5. FLIGHT PHYSICS MODEL

Implement a **rate-based acro flight model** — the paradigm real FPV pilots fly (like Betaflight in ACRO mode), layered with an arcade-friendly Angle Mode for beginners. This should feel meaningfully more like an FPV quad than an airplane or a toy drone: twitchy, inertial, controllable.

### 5.1 Rigid body & motor mixing
- Drone = `CANNON.Body`, small box/sphere collider (~250mm-class quad scale), mass ≈ 0.5 kg.
- Four virtual motor thrust vectors at the four corners, each pointing along local +Y, magnitude from the standard X-frame motor mix:
  ```
  motorFL = throttle - pitch + roll - yaw
  motorFR = throttle - pitch - roll + yaw
  motorRL = throttle + pitch + roll + yaw
  motorRR = throttle + pitch - roll - yaw
  ```
  Clamp each motor to [0, 1]. Sum vertical thrust = `k_thrust * sum(motors)`, applied via `applyLocalForce` at each motor's local offset so roll/pitch/yaw torque emerges physically from the four discrete forces rather than being hand-applied separately.
- Yaw torque additionally comes from reaction-torque differential between the two motor-spin-direction pairs (FL/BR vs FR/BL) — apply as `applyTorque` about local up.

### 5.2 Inertia, drag, damping
- Controls influence **acceleration and rotation**, never position/orientation directly — the drone must never teleport in response to input.
- Add linear drag (~0.15, higher facing into airflow) and angular damping (~0.4) so releasing a stick doesn't mean infinite momentum, but also doesn't mean instant stop — the craft should coast and gradually settle, consistent with the selected flight mode.
- Standard gravity (-9.81 m/s² world Y).

### 5.3 Flight modes (minimum two, selectable, clearly shown in UI as `MODE: ACRO` / `MODE: ANGLE`)
- **Angle Mode (beginner)**: self-leveling assist lerps pitch/roll euler angles toward 0 when sticks are centered; capped max tilt angle; easiest to hover in. Good default for first-time users.
- **Acro Mode (realistic)**: self-leveling fully disabled — the craft holds whatever attitude the pilot leaves it in, full rotational freedom, higher skill ceiling, more momentum-driven.
- Mode switch is available mid-flight from the pause/settings menu and via quick-keys (`1`/`2`).

### 5.4 Expo & rates
- Apply an expo curve to stick inputs before physics: `output = input * (|input| * expo + (1 - expo))`, expo ≈ 0.4–0.6 default, exposed as a 0–100% slider in settings (indoor/precision flying wants more expo; open-field bombing around wants less).
- Configurable max rotation rates per axis (deg/s), defaulting to Roll 600°/s, Pitch 600°/s, Yaw 400°/s at full deflection.

### 5.5 Crash & recovery behavior
- On collision above an impact-force/velocity threshold: zero all motor outputs, brief camera-shake + red flash, ~1.5s input lockout, then prompt respawn (or auto-respawn on keypress) at the last valid spawn/checkpoint.
- Below that threshold, just resolve normally through Cannon's collision response (bounce/slide) — real FPV pilots graze walls constantly; don't treat every bump as a crash.
- Add a "turtle mode" recovery key (`Shift`) that rights the drone if it lands upside down, as a quality-of-life feature.

---

## 6. FPV CAMERA

- Child object of the drone body, mounted slightly forward/up (like a real cam mount). FOV 120–150° by default, slider in settings.
- The user should not normally see the drone's own body — this is a first-person view.
- Camera should clearly telegraph: heading, current speed, tilt/bank angle, and nearby obstacles — visual effects must never sacrifice this readability.
- Apply a critically-damped spring-lerp on camera rotation (not a rigid 1:1 follow) so the camera trails the frame by a few milliseconds — mimics real analog FPV feed softness and reduces motion sickness.
- Procedural camera shake scaling with throttle/speed/acceleration (subtle high-frequency jitter under load).
- Optional, off-by-default CRT/analog-goggle post-process (chromatic aberration, scanlines, signal-noise vignette) via `EffectComposer` — purely cosmetic, toggle in settings, and cheap enough not to hurt framerate when enabled.
- Alternate camera modes cyclable with `C`: FPV (default), Chase Cam, Cinematic Slow-Mo — useful for lining up shots or just watching a replay-style view.

---

## 7. INPUT SYSTEM

Build a clean **Input Manager abstraction layer**. Keyboard and gamepad logic must **not** be mixed directly into physics code — both funnel into one normalized output object read once per frame:

```
Keyboard input  ↘
                  → InputManager → { throttle: 0..1, pitch: -1..1, roll: -1..1, yaw: -1..1, arm, mode, reset }
Gamepad input   ↗
```
`DroneController` only ever reads the normalized object — it has no knowledge of which physical device produced it. This keeps the system maintainable and is also a big part of what makes it crash-resistant: bad device data gets sanitized in exactly one place.

### 7.1 Input normalization (applies to every input source before it reaches physics)
- Clamp to valid range: throttle `[0,1]`, pitch/roll/yaw `[-1,1]`.
- Reject `NaN`/`Infinity` — fall back to the last known-good value or 0.
- Apply dead zone (see 7.3), sensitivity, and expo (see 5.4) before output.

### 7.2 Keyboard scheme
Since keyboards are digital, simulate analog stick feel with **ramped digital input** (ramp toward -1/0/1 over ~150ms, not an instant on/off snap):

| Key | Axis |
|---|---|
| Arrow Up / Down | Pitch forward / back |
| Arrow Left / Right | Roll left / right |
| `A` / `D` | Yaw left / right |
| `W` / `S` | Throttle up / down (incremental, holds last value like a real throttle stick — not spring-loaded) |
| `Space` | Arm / Disarm (and doubles as Pause when not flying, per original spec — pick one binding and document it clearly in the controls screen to avoid ambiguity, e.g. use `Space` for Arm/Disarm and `P`/`Esc` for Pause) |
| `R` | Reset / respawn at spawn point |
| `Shift` | Turtle-mode recovery flip |
| `1` / `2` | Quick-switch Acro / Angle mode |
| `C` | Cycle camera mode |
| `Tab` | Toggle HUD overlay |
| `M` | Open map-select menu |
| `Esc` | Pause / settings menu |

Implementation requirements (critical for stability):
- Track **key state**, not just discrete `keydown` events — physics reads a persistent "is this key currently held" map each frame.
- Handle `keydown`, `keyup`, **and** `window.blur`/visibility-change: on focus loss, **clear all held-key state immediately**. Otherwise a key held down when the user alt-tabs away will appear "stuck" and keep accelerating the drone when they return.
- `preventDefault()` on arrow keys/space while the simulator is active, to stop the browser page from scrolling — but only while the simulator has focus, and never while a text input (e.g. a settings field) is focused.

### 7.3 Gamepad support (native Gamepad API, required)
- Poll `navigator.getGamepads()` every render-loop frame — the Gamepad API doesn't push analog axis events, it must be polled.
- Listen for `gamepadconnected`/`gamepaddisconnected` to detect plug/unplug live; show a toast with the controller's name on connect, and immediately zero/neutralize its contribution to input on disconnect (see Stability section — no stale throttle values).
- Must not assume a single specific controller layout — support Xbox, PlayStation, generic USB gamepads, and RC transmitters exposed as HID/gamepad devices. Read raw `axes`/`buttons` arrays defensively (guard against a controller reporting fewer axes/buttons than expected).
- Default mapping (Mode 2, matches real FPV transmitters):
  - Left stick Y (axis 1) → Throttle
  - Left stick X (axis 0) → Yaw
  - Right stick Y (axis 3) → Pitch
  - Right stick X (axis 2) → Roll
  - Button 0 (A/Cross) → Arm/Disarm
  - Button 1 (B/Circle) → Reset
- Display `CONTROLLER: Connected — <device name>` or `CONTROLLER: Not connected` in the UI at all times.
- Build a **Controller Remap screen**: lists detected axes/buttons live, lets the user click "Remap" on a function and then move the physical control they want bound (listen for the first axis/button crossing a threshold and bind it). Persist mapping to `localStorage`; if `localStorage` is unavailable (e.g. private browsing), continue without persistence rather than throwing.
- Build a **Controller Diagnostics panel** (toggleable) showing the controller name, connection state, live numeric axis values, live button states, and a simple ASCII/canvas visualization of both sticks as a dot moving inside a circle — this lets the user visually confirm their transmitter is recognized and correctly mapped.

### 7.4 Dead zone
- Default dead zone ≈ 0.08–0.15, **rescaled, not just clipped** — don't simply zero out anything below the threshold and leave a "dead" jump at the boundary; remap the remaining range back to the full `0..1`/`-1..1` output so stick travel past the dead zone still uses the full control range smoothly.
- Every input value, after dead zone + expo + sensitivity, gets a final hard clamp to its valid range before being handed to physics.

---

## 8. MAPS

`MapManager` owns the active map with a small consistent interface per map module: `build(scene, world)`, `dispose(scene, world)`, `spawnPoint`, `bounds`. Switching maps must: pause simulation → fully dispose the outgoing map's geometries/materials/textures and remove its Cannon bodies → build the incoming map (chunked/async if needed so it doesn't jank the main thread) → place the drone at the new spawn point with velocity and orientation reset → resume. No accumulation of orphaned objects across switches, no full page reload.

### 8.1 Map 1 — Indoor House
Believable residential interior, ~15m×15m per floor, ~2.7m ceilings — the "learn your throttle control" map, tight and technical.
- Rooms: living room, kitchen (with island obstacle), hallway, 2 bedrooms, bathroom, garage/utility area, optional staircase between floors.
- Obstacles as simple boxes/cylinders: couch, coffee table, dining table, chairs, kitchen island, counters/cabinets, beds, nightstands, lamps, shelves, doors — include at least one deliberately tight doorway clearance for a signature FPV "gap dive."
- Procedural materials: warm off-white wall noise texture, wood-plank floor, window cutouts with light glow through them.
- Lighting: warm point lights (simulated lamps) + soft ambient, moodier/more contrasty than the outdoor map to sell "indoors."
- Spawn: garage or front door, facing into the living room.
- Optional gates/checkpoints through key rooms (living room → hallway → kitchen island → bedroom → garage) for a light sense of progression, while free-flight remains fully available.

### 8.2 Map 2 — Abandoned Warehouse
Large industrial shell, ~40m×60m, ~10m ceiling, dark/dusty/eerie atmosphere — the gate-racing / mid-speed map.
- Structure: exposed steel truss/beam geometry, concrete floor, corrugated metal walls, broken windows/skylights.
- Obstacles: stacked pallet crates, rusted container-like blocks, shelving, pipes, debris, old machinery, hanging chains (static, collidable), damaged wall sections, open loading doors.
- Optional multiple levels if performance allows: ground floor + a catwalk/platform reachable by a stair structure.
- Atmosphere on a budget: cool gray ambient + a few warm industrial fixture lights, light fog, a handful of cheap particle "dust motes," maybe one flickering light — explicitly avoid expensive volumetric lighting; simulate light shafts with simple transparent angled planes/cones if you want the effect at all.
- Performance: this map has the most props, so lean hardest here on `InstancedMesh`, shared geometries/materials, and merged static geometry.
- Include 5–8 racing gates/hoops arranged as an actual timed course through the space (feeds Time Trial mode, section 9).
- Spawn: large roller door at one end, facing down the warehouse's length.

### 8.3 Map 3 — Open Field
Large outdoor terrain, ≥300m×300m (bounds out to ~500m before an invisible wall/auto-respawn triggers) — the high-speed/long-range map.
- Terrain: gently rolling ground via vertex-displaced noise (not flat), procedural grass texture with patch variation, procedural/gradient sky with sun and simple clouds.
- Features: a barn structure, a tree line (instanced, could be 200+ trees for near-zero draw-call cost), a fence line, a reflective pond plane, power lines strung between poles as an advanced obstacle for skilled pilots, dirt paths, scattered rocks/bushes, optional small ramps.
- Optional wind toggle in settings: adds a small constant force vector to the physics world for advanced practice.
- Spawn: open clearing near the barn.

---

## 9. GAME MODES

- **Free Flight** (default) — no goals, explore/practice.
- **Time Trial** — fly the numbered gates in sequence (all three maps should have at least a few placed, warehouse has the primary course); timer starts on first meaningful throttle input, stops at the final gate; best time saved to `localStorage` (degrade gracefully to session-only if unavailable).
- **Precision Landing** (bonus, house map) — land within a marked pad under a max impact-velocity threshold; score on softness + centering accuracy.

---

## 10. HUD / OSD

Recreate a real FPV-goggle OSD feel: monospace font, green-or-white-on-transparent, screen corners, toggleable with `Tab`.

- Top-left: simulated battery voltage (e.g. starts 16.8V / 4S, drains with throttle usage over time, flashing "LOW BATTERY" under 14.8V, "LAND NOW" under 14.0V, auto motor cutoff at a critical voltage floor).
- Top-right: timer (mode clock / Time Trial stopwatch).
- Bottom-left: speed (m/s and km/h) and altitude (m AGL).
- Bottom-right: armed/disarmed state (large centered "DISARMED" in red when not armed) and current flight mode label.
- Center: small crosshair/reticle.
- Optional artificial-horizon ladder bar that tilts with roll/pitch — nice authentic touch, not mandatory for MVP.
- Input-method indicator showing which device is currently driving control (keyboard vs. named controller), consistent with the connection messaging from section 7.3.

---

## 11. MENUS & SETTINGS

- **Main Menu**: three map cards (with a short description each — "Tight technical indoor flying," "Mid-speed gate racing," "Open-space long-range"), Start Flight, Settings, Controls reference.
- **Settings** (persist to `localStorage`, degrade to session-only if storage is unavailable):
  - Input method (auto-detected label + manual override)
  - Controller remap screen
  - Dead zone, expo, and per-axis sensitivity/rate sliders
  - Default flight mode (Acro/Angle)
  - Camera FOV slider, CRT filter toggle
  - Master volume / SFX toggle
  - Wind toggle (field map)
- **Pause Menu** (`Esc` mid-flight): Resume, Restart Flight, Change Map, Controller Diagnostics, Back to Main Menu. Must fully halt the sim loop while open (see section 4) and never "catch up" simulated time on resume.
- **Controls reference**: keyboard bindings and currently-detected gamepad bindings shown side by side.

---

## 12. AUDIO

Prefer procedural/Web-Audio-generated sound over external files, to stay dependency-free and to make audio failures trivially non-fatal (wrap every audio call so a failure just disables that one sound):

- Motor whine: layered oscillator(s) (sawtooth/square) with pitch and volume driven by current motor RPM/throttle.
- Crash "thud": short generated noise burst.
- Wind at speed: filtered noise (bandpass on an `AudioBufferSourceNode`), volume tied to velocity.
- Light per-map ambient bed: quiet room tone (house), industrial hum (warehouse), wind/birds (field).

---

## 13. PERFORMANCE

- Target 60fps on mid-range hardware.
- `InstancedMesh` for all repeated geometry (trees, pallets, bricks, fence posts).
- Merge static geometry per map where practical (`BufferGeometryUtils.mergeGeometries`) to keep draw calls sane, especially in the warehouse.
- Frustum culling on (Three.js default).
- Responsive canvas: resize listener updates camera aspect + renderer size without leaking old render targets.
- Loading screen with progress indication while a map builds; chunk the build (e.g. via `requestIdleCallback` or spread across frames) so it doesn't block/jank the main thread on map load or switch.
- Reduce detail automatically on low-end hardware if feasible (e.g. a coarse FPS-based quality auto-adjust), but this is a nice-to-have, not a blocker.

---

## 14. CODE QUALITY

- Clean, commented code. Every file gets a top-of-file comment describing its responsibility.
- Non-trivial physics/math (motor mixing, expo curve, dead-zone rescale, camera spring-lerp) gets inline comments explaining the formula — this should be a learning-friendly codebase, not just a working one.
- Prefer many small guard clauses over deeply nested try/catch — but do wrap every touchpoint with a browser API that can throw or return unexpected shapes (Gamepad API, localStorage, WebAudio, fullscreen/pointer-lock APIs).

---

## 15. OUTPUT FORMAT FOR YOUR RESPONSE

1. A brief architecture summary (2–3 paragraphs): the game loop and physics/render decoupling, the input-normalization pipeline, and how the three maps share `MapManager`'s common interface.
2. The complete file tree from section 2, **fully implemented** — no `// TODO` stand-ins for required functionality.
3. `package.json` with exact pinned versions for `three` and `cannon-es`.
4. A short README "How to Fly" quickstart: install/run commands, default keyboard controls, and how to connect a controller.

If the full response would be too long, trim polish features (particles, CRT filter, artificial-horizon ladder, precision-landing mode) before trimming any of: `DroneController.js`, `InputManager.js`, `PhysicsWorld.js`, the three map files, or the stability/defensive-programming behaviors in sections 3–4 — those are the non-negotiable core of what makes this an actual simulator rather than a fragile demo.
