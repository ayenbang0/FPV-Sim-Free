# FPV Drone Simulator

A browser-based FPV (first-person view) drone simulator with a rate-based acro
flight model, **seven flyable airframes**, thirteen full-scale procedurally generated
environments, and full keyboard + Gamepad API support. No backend, no asset
downloads, no build pipeline beyond Vite.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default <http://localhost:5173>).

One-click alternative on Windows: double-click **`Launch-Simulator.vbs`** —
it starts the dev server (installing dependencies first if needed) and opens
the browser for you.

```bash
npm run build     # production bundle into dist/
npm run preview   # serve the production bundle
npm test          # headless checks: flight model, collisions, input
```

---

## How to fly

1. Pick a map on the main menu and press **Start flight**.
2. Pick an aircraft. Start with the **Tinywhoop** — it is slow, light, and very
   hard to hurt yourself with.
3. Press **Space** to arm. Nothing happens until you do — a large red
   `DISARMED` sits in the middle of the screen until then.
4. Hold **W** to raise the throttle. Where hover sits depends on the aircraft
   (the selection card tells you: 55% on the whoop, 29% on the race quad), so
   keep feeding it in until the quad lifts.
5. **Arrow keys** tilt the quad. Pitching forward is what makes it *fly* rather
   than just hover — a quad has no forward thrust of its own, it leans and lets
   its lift push it along.
6. **R** respawns instantly. Use it liberally.

Start in **Angle mode** (the default). It self-levels the moment you release
the sticks, so you can concentrate on throttle. When hovering feels automatic,
press **1** for **Acro** — no self-levelling, the quad holds whatever attitude
you leave it in. That is what real FPV pilots fly, and it is much harder.

### Keyboard

| Key | Action |
|---|---|
| <kbd>↑</kbd> / <kbd>↓</kbd> | Pitch forward / back |
| <kbd>←</kbd> / <kbd>→</kbd> | Roll left / right |
| <kbd>A</kbd> / <kbd>D</kbd> | Yaw left / right |
| <kbd>W</kbd> / <kbd>S</kbd> | Throttle up / down (holds its position) |
| <kbd>Space</kbd> | Arm / disarm |
| <kbd>R</kbd> | Respawn at the spawn point |
| <kbd>Shift</kbd> | Turtle-mode recovery flip (when upside down) |
| <kbd>1</kbd> / <kbd>2</kbd> | Acro mode / Angle mode |
| <kbd>C</kbd> | Cycle camera — FPV → chase → cinematic |
| <kbd>Tab</kbd> | Toggle the HUD |
| <kbd>G</kbd> | Controller diagnostics panel |
| <kbd>M</kbd> | Map select |
| <kbd>Esc</kbd> or <kbd>P</kbd> | Pause / settings |

Keys are *ramped*, not on/off: holding an arrow key sweeps the axis to full
over ~150 ms so a keyboard feels a little like an analog stick.

### Connecting a controller

Plug in a USB/Bluetooth gamepad or an RC transmitter in joystick mode, then
**press a button or move a stick** — browsers deliberately hide gamepads until
they see input, so nothing appears until you do. A toast confirms the device
name, and the HUD's `INPUT:` field shows which device is currently flying.

Default mapping is **Mode 2**, matching a real transmitter:

| Control | Binding |
|---|---|
| Left stick Y (axis 1) | Throttle |
| Left stick X (axis 0) | Yaw |
| Right stick Y (axis 3) | Pitch |
| Right stick X (axis 2) | Roll |
| Button 0 (A / Cross) | Arm / disarm |
| Button 1 (B / Circle) | Reset |

Keyboard and controller are both live at once — whichever you touched most
recently takes over, with no restart and no setting to change.

**Using an Xbox/PlayStation pad?** Their left stick springs back to centre,
which parks the throttle at 50%. Turn on **Settings → Input → Spring-centred
throttle** to make the left stick behave like a throttle *rate* control (push
up to add power, release to hold) instead.

### Sticks doing nothing while the buttons work?

That is a **mapping** problem, not a broken controller, and it has one cause:
the browser only guarantees which axis is which when it reports the pad as a
*standard* gamepad. Anything else — a Logitech F310 with the D/X switch on the
back set to **D**, most RC transmitters — puts the sticks on whatever axes its
driver chose. The buttons still line up, so you get every button working and no
stick working at all.

Two fixes:

1. **If it is an F310, flip the switch on the back to `X`** and replug. That is
   the mode browsers understand natively, and the defaults will just work.
2. **Otherwise, calibrate.** The sim detects this case and says so, then opens
   **Settings → Controller setup** for you. Press *Calibrate* next to each
   control, sweep that stick to both extremes, and finish holding the direction
   you want to be "positive" (throttle up, yaw right, pitch forward, roll
   right). It binds whatever actually moved and records the real endpoints, so
   partial-range and reversed axes work too.

Calibration also works out whether your throttle stick self-centres and sets
**Spring-centred throttle** accordingly.

**Want to see the raw numbers?** The Controller setup page has a live readout of
every axis, and pressing <kbd>G</kbd> opens the diagnostics panel with button
states and both stick positions.

---

## The three aircraft

Pick one on the main menu, or swap mid-flight from the pause menu (<kbd>Esc</kbd>
-> Craft). Each one loads its own rate and tilt profile, exactly as a flight
controller loads a per-craft profile; the settings sliders then edit whatever is
loaded.

| | Tinywhoop | 5" Freestyle | Race Quad |
|---|---|---|---|
| Class | 65 mm · 23 g · 1S | 250 mm · 650 g · 6S | 210 mm · 580 g · 6S |
| Thrust | 2.4:1 | 6.5:1 | 8.0:1 |
| Top speed (acro) | 7 m/s · 25 km/h | 38 m/s · 137 km/h | 44 m/s · 160 km/h |
| Top speed (angle) | 3.2 m/s | 12.5 m/s | 15.6 m/s |
| Climb / sink | 3.5 / 3.0 m/s | 21 / 9.0 m/s | 29.1 / 11.0 m/s |
| Rates | 500 / 330 deg/s | 800 / 550 deg/s | 900 / 650 deg/s |
| Angle-mode tilt | 25° | 35° | 45° |
| Hover | 57% throttle | 32% | 29% |
| Pack | 1S 300 mAh | 6S 1300 mAh | 6S 1100 mAh |
| Wind | blown sideways at 11 m/s² | 1.2 m/s² | 1.2 m/s² |

Four more airframes hangar alongside these: 3" Toothpick, 5.5" Freestyle HD,
Street League Spec, and the 7" Beast (6S2P Li-Ion, ~10 min cruise).

Modelled on a BetaFPV Air65, a standard 5-inch freestyle build, and a 6S race
quad respectively.

**They are genuinely different to fly, and not because of a difficulty
multiplier.** Every number above falls out of the airframe's physical
description — mass, arm length, frame dimensions, prop size, drag area — and the
controller gains are *derived* from those rather than typed in (see
`src/core/DroneTypes.js`). Three consequences do most of the work:

- **Where hover sits.** Propeller thrust goes as the square of RPM, so thrust is
  markedly non-linear in the motor command. Inverting that curve puts the race
  quad's hover at 29% of the stick — all its authority crammed into the first
  third of the travel, which is exactly why a 6S racer feels twitchy — and the
  whoop's at 55%, right at mid-stick, which is why it feels docile.
- **Inertia versus authority.** The whoop's tiny moment of inertia makes it dart
  rotationally while its ducts make it hopeless in a straight line. The racer is
  the reverse: enormous thrust, low drag, and barely any rotational damping, so
  it holds whatever rotation you give it and you have to actively stop it.
- **Mass versus area.** Wind force scales with frontal area but acceleration
  divides by mass. The whoop has roughly a third of the 5"'s frontal area and a
  twenty-eighth of its mass, so it gets about nine times the acceleration —
  which is why a 23 g quad is unflyable outdoors in a breeze a 5" ignores.

The whoop is the right tool for the Indoor House, the freestyle for anything,
and the racer for the Open Field.

### Why hover sits near half throttle

On the whoop it is 57%, and that is correct rather than a bug. Hover throttle is
set by thrust-to-weight and the shape of the thrust curve, and a 2.4:1 micro
simply has to run its motors past halfway to hold itself up — real whoop pilots
hover around there too. A 6S race quad at 8:1 hovers at 29% for the same reason
in reverse.

What *was* wrong, and is now fixed, is what happened next: the whoop used to top
out at 12 m/s, which in a 15 m living room is the whole width of the house in a
little over a second. Drag is now solved backwards from measured hardware
(~25 km/h flat out, ~3 m/s sink), and Angle mode's 25° tilt cap holds it to about
3 m/s — walking pace. Taking off still needs hover plus a margin; it just no
longer rockets across the room once it is up.

## The maps

Thirteen sceneries, all at real-world scale. Every former "room" is now at
least 8x its old volume, and the racing maps are full-size courses with
league-size gates (2-4 m padded square gates with solid frames, dive gates,
ladders), a next-gate beacon, and the distance to the next gate on the OSD.

| Map | Size | What it's for |
|---|---|---|
| **Apex Arena** | 150 x 80 x 26 m hall | Championship night: grandstand crowd, LED rigs, video walls. 12 gates incl. double gate, three-high ladder, 8 m dive tower, hurdle, flag slalom. |
| **Abandoned Warehouse** | 84 x 124 x 23 m | Distribution centre: 11 m pallet racking aisles, collapsed run, mezzanine, conveyor bridge, sunbeams through skylights, dock yard. 12 gates. |
| **Abandoned Factory** | 120 x 88 x 24 m hall + yard | Half-roofed machine hall: fly-through 10 m presses, tanks, mezzanine, bridge, 56 m chimney yard. 12 gates. |
| **Indoor House** | 36 x 28 m, two floors | Great room with gallery and open stair, sunroom, garage, garden outside real glass. Two 0.62 m gap-dive bathroom doors. 12 gates. |
| **Open Field** | 1.5 x 1.5 km terrain | Farmland: fly-through barn, silos, pond, forest, hedgerows, power line. 2.5 km circuit, 12 gates. |
| **Alpine Valley** | 3 x 3 km terrain | Glacial valley: snow peaks, pine forest, stone viaduct arches, chair lift, lake. 3.5 km downhill race, 10 gates. |
| **Coastal Cliffs** | 2 x 2 km terrain | Beach, dunes, 55 m headland, lighthouse, sea stacks, a pier to fly under, village. 10 gates. |
| **Stadium Bowl** | 190 x 150 x 36 m | Full-size football stadium at dusk: two tiers, roof canopy, players' tunnel. 12 gates. |
| **Bando** | 72 x 40 x 21 m tower + site | Unfinished five-storey concrete frame: atrium dive, slab collapses, scaffolding, tower crane. 10 gates. |
| **Night Factory** | 64 x 96 x 20 m | Steel works at night: arc-furnace glow, bridge crane, rolling mill. 10 gates. |
| **Blank Canvas (Day / Night)** | 400 x 400 m | Empty practice field with an eight-gate line. |

Each map has a Time Trial. The clock starts on your first real throttle
input and stops at the final gate; the next gate glows green with a light
column above it. Best times are saved per course layout, so the rebuilt
courses start with a clean board.

---

## How it works

**The loop.** Physics runs at a fixed rate — 240 Hz by default, selectable up
to 960 — while rendering runs at whatever the display does. An accumulator
bridges the two and the leftover fraction interpolates the drone's transform,
so the flight model behaves identically at 60, 75, or 144 fps. Frame deltas are
clamped and substeps capped, so a backgrounded tab cannot come back and
simulate ten seconds at once, and a slow machine runs in slow motion rather
than spiralling.

Control feel is treated as more important than pixels: when a machine cannot
afford both, `_trackPerformance` walks the render resolution down while leaving
the tick rate alone, and only steps the simulation rate down if the *physics*
itself is over budget. The PID tune is rate-independent, so changing the tick
rate changes how finely the quad is resolved, never how it flies.

**The flight model.** Sticks become a rate setpoint (directly in Acro; via an
attitude P-loop in Angle mode), a rate PID turns the error into mix values, and
an X-frame motor mix with air-mode throttle offset turns those into four motor
commands, which a non-linear thrust curve converts into newtons. Those are applied as four `applyLocalForce` calls at the four arm
tips — roll and pitch torque is never applied by hand, it *emerges* from the
four thrust vectors exactly as on a real quad. That is what gives the model its
coupling: pitching forward costs you lift, and a hard roll sags the altitude.
Yaw is the one exception, since motor reaction torque has no thrust-vector
equivalent.

**Controller gains are derived, not typed.** A rate PID is tuned against an
airframe's angular-acceleration authority, so hand-writing three sets of gains
would be three chances to produce a quad that oscillates — a failure that builds
clean, renders clean, and only shows up as a tumble in flight. Instead each
airframe declares its physical properties and `derive()` computes
`alphaMax = 2·arm·thrustMax / I`, then `Kp = 1/(tau·alphaMax)`. Notably `Kd` is
*not* scaled off `Kp`: what destabilises the derivative term is the product
`Kd·alphaMax`, and the whoop has more authority than the 5" but a lower `Kp`, so
scaling off `Kp` would push the smallest airframe the wrong way. Holding
`Kd·alphaMax` constant is what keeps all three equivalent.

**Input normalisation.** Keyboard and gamepad both funnel into one
`InputManager` that clamps ranges, rejects `NaN`/`Infinity`, applies a
*rescaled* dead zone (so there is no jump at the threshold), and applies expo —
all in one place. `DroneController` never learns which device produced a value,
which is what makes bad device data impossible to propagate.

**Maps.** All three implement the same interface (`buildSteps`, `dispose`,
`spawnPoint`, `bounds`, `gates`). `buildSteps` is a generator that `MapManager`
pumps against a per-frame time budget, so building the warehouse's thousands of
primitives never locks the tab. Every geometry, material, texture, and physics
body is owned by a `MapBuilder`, so a map switch provably releases the lot —
Three.js does not garbage-collect GPU resources, and repeated switching without
explicit disposal is a reliable way to exhaust VRAM.

**Assets.** Everything is procedural. Textures are drawn into 2D canvases at
runtime, geometry is Three.js primitives, and terrain comes from an analytic
height function shared by the visual mesh, the cannon `Heightfield` collider,
and every prop's placement — which is the only way they stay in agreement.
Audio is synthesised with Web Audio; there are no sample files.

### Stability

The app is built so that it never crashes, only degrades:

- Missing Gamepad API, or a controller that disconnects mid-flight → input is
  neutralised **immediately** (never "last held value") and keyboard takes over.
- Focus loss clears held keys, so alt-tabbing away mid-throttle does not leave a
  phantom key accelerating the drone when you return.
- WebGL context loss is caught and recovered; the renderer degrades through
  three configurations before giving up.
- Any procedural texture that fails to generate falls back to a flat colour.
- Audio failures disable one sound, not the engine.
- `localStorage` failures downgrade settings to session-only rather than throwing.
- Every substep validates the drone body: non-finite position, velocity, or
  quaternion is repaired from the last known-good state, velocities are clamped,
  and the quaternion is re-normalised unconditionally.
- Battery cutoff runs on a *filtered* voltage. A punch-out sags a healthy 4S by
  three volts or more, and judging the cutoff on the instantaneous reading cuts
  the motors every time the throttle goes to full.
- A swept-collision guard raycasts along the path each substep actually took.
  Discrete collision detection compares positions, so a small fast body can end
  up past a thin wall without a contact ever being generated — a 23 g whoop at
  12 m/s covers 0.10 m per substep against 0.14 m interior walls. The generic
  position clamps cannot catch that (any threshold tight enough to notice a
  37 mm body fires constantly in normal flight), so the sweep runs only when a
  step's travel exceeds the body's own smallest half-extent.
- The loop body is wrapped — a subsystem that throws loses its frame, not the
  session.

### Stick feel: community presets + Actual Rates

Settings → Rate presets ships Velocidrone-parity, Liftoff-parity, Race
1000°/s, Freestyle 800°/s, Cinematic, Whoop, and Betaflight Actual Rates
(center + max + expo, BF 4.3+ style) recipes. A preset is a starting point —
every slider stays editable afterwards, and switching craft reloads the
per-craft stock tune.

### Graphics

Settings -> Graphics -> **Quality** (Auto / Low / Medium / High / Ultra) sets
shadow resolution and range, view distance, grass and tree density, terrain
detail and texture filtering; Auto picks from the GPU the browser reports.

- **Sky and light:** outdoor maps use an analytic (Preetham) sky with drifting
  clouds, a sun whose colour and the fog colour come from the same scattering
  model, and image-based lighting rendered from that sky. The time-of-day and
  overcast sliders drive it. Indoor maps capture their own lit interior into
  an environment map for matching ambient and reflections.
- **Shadows:** one sun shadow map that follows the drone (outdoors) or is
  pinned over the whole building (indoors / part-roofed), so skylights and
  windows throw real pools of light and sunbeams.
- **Terrain:** chunked LOD heightmaps with a splat-blended ground shader
  (grass, dirt, gravel/sand, forest floor, slope rock, altitude snow), GPU
  grass around the camera, and instanced two-LOD forests of tens of thousands
  of trees.
- Bloom and motion blur remain one toggle each and cost nothing when off.

### Physics at map scale

Only the drone moves, so static colliders live outside cannon's body list in
a spatial hash, and a dynamic-vs-static broadphase hands the drone just its
neighbours. Colliders are also streamed by area, and large sets (terrain
chunks, trees) are built lazily when the drone approaches. A physics substep
costs ~0.03-0.06 ms whether the map has 50 colliders or 30 000.

### Flight-model realism

On top of the derived rate PID, thrust curve, battery sag, ground effect,
propwash and wind: propeller thrust now fades with axial inflow toward the
prop's pitch speed (which is what really caps top speed and softens
punch-outs), motors spool down more slowly than they spool up, and propwash
buffets each axis independently.

### Testing

`npm test` runs three headless suites — no browser, no renderer.

- `tests/flight-model.test.mjs` (173 checks, all seven airframes): hover,
  climb, descent, rate tracking, Angle-mode levelling and tilt cap, axis
  directions, garbage input, a random-stick soak, measured terminal speed and
  sink rate against the model, battery, power limit, tunnelling guard.
- `tests/collisions.test.mjs` builds **every registered map** and checks:
  the gate count matches the menu, spawn and every gate centre (plus 1.5 m
  either side) are in open air using exact point-in-shape tests, transforms are
  finite, a dropped quad lands on the ground, plus signature features — the
  house gap doors, press slots, rack aisles, barn doors, arena gate frames, the
  bando atrium — and that collider streaming loads only what is near.
- `tests/input.test.mjs` covers the gamepad pipeline and calibration.

---

## Layout

```
fpv-sim/
├── index.html              app shell + all CSS
├── src/
│   ├── main.js             entry point, game loop, state machine, race logic
│   ├── core/
│   │   ├── DroneController.js   flight model: mix, rate PID, battery, crash
│   │   ├── InputManager.js      keyboard + gamepad -> normalised controls
│   │   ├── CameraRig.js         FPV camera, shake, CRT post-process
│   │   ├── DroneTypes.js        the three airframes + derived gains
│   │   ├── PhysicsWorld.js      cannon world, collision groups, safety clamps
│   │   ├── MapManager.js        map lifecycle, chunked builds, teardown
│   │   ├── Settings.js          validated, persisted settings store
│   │   └── AudioEngine.js       Web Audio synthesis
│   ├── maps/
│   │   ├── MapKit.js            shared builder: primitives, gates, streaming
│   │   ├── registry.js          every map, in menu order
│   │   └── *Map.js              thirteen maps
│   ├── render/                  Atmosphere (sky, IBL, shadows), Quality tiers
│   ├── world/                   Terrain, grass, forest, collider streaming
│   ├── ui/
│   │   ├── HUD.js               OSD overlay
│   │   ├── MainMenu.js          map select, settings, controls reference
│   │   ├── PauseMenu.js
│   │   └── ControllerDiagnostics.js
│   └── assets/procedural.js     runtime texture generation
└── tests/
    ├── flight-model.test.mjs headless physics checks (all three airframes)
    └── input.test.mjs        gamepad mapping + calibration checks
```

Three files sit outside the original spec's tree, all deliberately:
`core/Settings.js`, because input, physics, camera, HUD, and audio all need the
same tuning values and threading them through constructors would mean rebuilding
half the object graph on every settings change; `maps/MapKit.js`, because all
three maps need the same "box with a matching collider" and "scatter 200 of
these in one draw call" operations, and writing them three times would have
tripled the map code; and `core/DroneTypes.js`, which holds the airframe
definitions and the derivation that turns them into controller gains.

## Stack

- [three](https://threejs.org) `0.185.1` — rendering
- [cannon-es](https://pmndrs.github.io/cannon-es/) `0.20.0` — rigid-body physics
- [vite](https://vite.dev) `8.2.2` — dev server and bundler

No other runtime dependencies.

## Flight controller

`src/fc/` is a JavaScript port of the Betaflight 2025.12 flight-control path:
filters (`common/filter.c`), rates and RC smoothing/feedforward (`fc/rc.c`),
the PID controller with TPA, anti-gravity, I-term relax, D-max and
self-levelling (`flight/pid.c`, `pid_init.c`), the gyro filter chain with the
RPM filter (`sensors/gyro*.c`, `flight/rpm_filter.c`), and the mixer with
airmode and crash flip (`flight/mixer.c`). Every ported function carries a
`// BF: <file>:<function>` comment naming its source. Settings use Betaflight
units, so a tune or rate profile copies straight across from the Configurator.

`src/core/QuadPhysics.js` supplies the physical quad the FC flies: battery
open-circuit voltage and sag, a closed-form ESC/motor bus solve, propeller
thrust and torque with inflow, ground effect, vortex ring, translational lift
and rotor drag, rotor inertia and gyroscopic torque. Radios connect through
the Gamepad API (EdgeTX/OpenTX joystick presets) or WebSerial (CRSF/SBUS
receivers, `src/input/SerialRx.js`).

`tests/tune-check.mjs` is a development tool (not part of `npm test`) that
reports each airframe's stock-tune roll step response.

## License

The simulator as a whole is distributed under the **GNU General Public
License, version 3 or later** (`GPL-3.0-or-later`, full text in `COPYING`),
because `src/fc/` is derived from [Betaflight](https://github.com/betaflight/betaflight),
which is GPL-3.0-or-later.

The files not derived from Betaflight were first published under the Apache
License 2.0 (`LICENSE`). Apache-2.0 code may be included in a GPLv3 work, so
those files remain available under Apache-2.0 on their own, while the combined
program is under the GPL.
