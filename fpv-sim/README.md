# FPV Drone Simulator

A browser-based FPV (first-person view) drone simulator with a rate-based acro
flight model, **three flyable airframes**, three procedurally generated
environments, and full keyboard + Gamepad API support. No backend, no asset
downloads, no build pipeline beyond Vite.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default <http://localhost:5173>).

```bash
npm run build     # production bundle into dist/
npm run preview   # serve the production bundle
npm test          # headless flight-model checks (no browser needed)
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
| Class | 65 mm · 23 g · 1S | 250 mm · 650 g · 4S | 210 mm · 580 g · 6S |
| Thrust | 2.4:1 | 3.2:1 | 8.0:1 |
| Top speed (acro) | 7 m/s · 25 km/h | 28 m/s · 100 km/h | 44 m/s · 160 km/h |
| Top speed (angle) | 3.2 m/s | 13.4 m/s | 15.6 m/s |
| Climb / sink | 3.5 / 3.0 m/s | 13.3 / 9.0 m/s | 29.1 / 11.0 m/s |
| Rates | 500 / 330 deg/s | 600 / 400 deg/s | 900 / 650 deg/s |
| Angle-mode tilt | 25° | 35° | 45° |
| Hover | 57% throttle | 50% | 29% |
| Wind | blown sideways at 11 m/s² | 1.2 m/s² | 1.2 m/s² |

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

## What's in the three maps

| Map | Size | What it's for |
|---|---|---|
| **Indoor House** | 15 × 15 m, 2.7 m ceilings | Tight technical flying. Seven rooms, real furniture, and a deliberately 0.62 m-wide bathroom door for a proper gap dive. |
| **Abandoned Warehouse** | 40 × 60 m, 10 m ceiling | The gate-racing map. Eight-gate course, shelving canyon, catwalk, truss work, dust and light shafts. |
| **Open Field** | 512 m of rolling terrain | High-speed and long-range. Barn, tree line, pond, fencing, ramps, and power lines strung between poles for pilots who want something genuinely hard. |

Each map has a **Time Trial** course. The clock starts on your first real
throttle input and stops at the final gate; the next gate always glows bright
green. Best times are saved per map.

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

### Testing

`npm test` runs the flight model headlessly at the real substep — no browser,
no renderer, 55 checks. Every physical check runs against **all three
airframes**: hover equilibrium, climb and descent, Acro rate tracking,
Angle-mode self-levelling and tilt cap, the direction of every control axis,
garbage-input rejection, a 30-second random-stick soak, battery drain on the
right chemistry, and containment by a 0.14 m wall at each airframe's own top
speed.

A second suite, `tests/input.test.mjs`, covers the gamepad pipeline against a
**DirectInput-style** pad whose sticks are deliberately *not* on axes 0-3 —
the layout that actually breaks. It checks that the wrong-layout warning fires
and names the dead controls, that guided calibration binds each function to the
axis that really moved, that a partial-range pot still reaches full output, that
spring-centred and ratcheted throttles are told apart, and that legacy stored
mappings still load.

The flight suite also checks the derivation itself: that the inertia formula agrees with
cannon-es' to floating-point precision, that `Kd·alphaMax` is constant across
airframes, that each rate loop's gain equals `1/tau`, and that hover throttle
inverts the thrust curve rather than the linear formula. Those matter because
gains are computed from geometry — changing an airframe's dimensions silently
re-tunes its controller.

Those numbers are worth testing precisely because getting them wrong still
produces a clean build and a correctly rendered scene. An inverted roll axis or
a quad that cannot lift its own weight only shows up if you fly it and measure.

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
│   │   ├── MapKit.js            shared builder: primitives, instancing, gates
│   │   ├── HouseMap.js
│   │   ├── WarehouseMap.js
│   │   └── FieldMap.js
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
