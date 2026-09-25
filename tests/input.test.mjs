/**
 * tests/input.test.mjs
 * ---------------------------------------------------------------------------
 * Headless checks for the gamepad axis pipeline, run against a **DirectInput**
 * style pad rather than the standard layout.
 *
 * This is the case that actually breaks. A Logitech F310 has a D/X switch on
 * the back: in XInput mode the browser reports `mapping: "standard"` and the
 * sticks are genuinely on axes 0-3, so the defaults work. In DirectInput mode
 * the layout is driver-defined, the sticks land on higher axes, and because the
 * *buttons* still line up the failure looks like "the sim ignores my
 * controller" rather than a mapping problem.
 *
 * Testing the standard layout again would prove nothing — it already passed.
 *
 * Run with:  npm test
 */
// Headless check of the axis reader + calibration math against a DirectInput
// style pad, where the sticks are NOT on axes 0-3.
import { InputManager, axisEndpoints } from '../src/core/InputManager.js';
import { settings } from '../src/core/Settings.js';

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

// D-mode: 6 axes, sticks on 2..5, axes 0/1 are a static D-pad hat.
const pad = {
  index: 0, connected: true, mapping: '',
  id: 'Logitech Logitech Dual Action (Vendor: 046d Product: c216)',
  axes: [0, 0, 0, 0, 0, 0],
  buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 })),
};
// Node 24 exposes a getter-only `navigator`, so define rather than assign.
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('navigator', { getGamepads: () => [pad] });
define('window', { addEventListener() {}, removeEventListener() {} });
define('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' });

// Link latency is emulated on wall-clock stamps; these checks tick faster
// than real time, so run the link with zero latency.
settings.set('rcLatencyMs', 0);
const inp = new InputManager();
const tick = (n = 3) => { for (let i = 0; i < n; i++) inp.update(1 / 60); };

tick();
check('adopts a non-standard pad', inp.rawGamepad.connected, `axes=${inp.rawGamepad.axes.length}`);

// Move the real sticks (axes 2..5). Default mapping reads 0..3 -> mostly dead.
let warned = null;
inp.onDeviceEvent = (lvl, msg) => { warned = { lvl, msg }; };
pad.axes = [0, 0, 1, -1, 1, -1];
tick(4);
check('stray-axis warning fires when sticks are on unmapped axes',
  !!warned && /calibrat/i.test(warned.msg), warned ? warned.msg.slice(0, 60) + '…' : 'none');

// --- guided calibration: throttle on axis 3, up = -1 ---
inp.beginAxisCalibration('throttle');
pad.axes = [0, 0, 0, 1, 0, 0];  tick(2);   // full down
pad.axes = [0, 0, 0, -1, 0, 0]; tick(2);   // full up, finish holding UP
const rt = inp.commitAxisCalibration();
check('throttle calibrates onto axis 3', rt.ok && rt.binding.index === 3,
  rt.ok ? `lo=${rt.binding.lo} hi=${rt.binding.hi}` : rt.reason);

// Spring detection resolves once the pilot lets go, so release and poll.
pad.axes = [0, 0, 0, 0, 0, 0]; tick(3);
check('spring-centred throttle detected on release',
  settings.get('springThrottle') === true, String(settings.get('springThrottle')));

// And a ratcheted throttle (one that stays where it is put) is not.
inp.beginAxisCalibration('throttle');
pad.axes = [0, 0, 0, 1, 0, 0];  tick(2);
pad.axes = [0, 0, 0, -1, 0, 0]; tick(2);
inp.commitAxisCalibration();
pad.axes = [0, 0, 0, -1, 0, 0]; tick(3);          // stays parked at the top
await new Promise((r) => setTimeout(r, 1600));
tick(3);
check('ratcheted throttle not flagged as spring',
  settings.get('springThrottle') === false, String(settings.get('springThrottle')));

// --- yaw on axis 2, right = +1 ---
inp.beginAxisCalibration('yaw');
pad.axes = [0, 0, -1, 0, 0, 0]; tick(2);
pad.axes = [0, 0, 1, 0, 0, 0];  tick(2);   // finish holding RIGHT
const ry = inp.commitAxisCalibration();
check('yaw calibrates onto axis 2', ry.ok && ry.binding.index === 2,
  ry.ok ? `lo=${ry.binding.lo} hi=${ry.binding.hi}` : ry.reason);

// --- roll on axis 4, right = +1 ---
inp.beginAxisCalibration('roll');
pad.axes = [0, 0, 0, 0, -1, 0]; tick(2);
pad.axes = [0, 0, 0, 0, 1, 0];  tick(2);
const rr = inp.commitAxisCalibration();
check('roll calibrates onto axis 4', rr.ok && rr.binding.index === 4, rr.ok ? '' : rr.reason);

// --- pitch on axis 5, forward = -1 ---
inp.beginAxisCalibration('pitch');
pad.axes = [0, 0, 0, 0, 0, 1];  tick(2);
pad.axes = [0, 0, 0, 0, 0, -1]; tick(2);   // finish holding FORWARD
const rp = inp.commitAxisCalibration();
check('pitch calibrates onto axis 5', rp.ok && rp.binding.index === 5,
  rp.ok ? `lo=${rp.binding.lo} hi=${rp.binding.hi}` : rp.reason);

// --- now fly it ---
settings.set('springThrottle', false);   // test absolute throttle mapping
settings.set('rcDeadband', 10);
pad.axes = [0, 0, 1, -1, 1, -1];   // yaw right, throttle up, roll right, pitch fwd
tick(4);
const c = inp.controls;
check('calibrated sticks drive all four axes',
  c.throttle > 0.95 && c.yaw > 0.95 && c.roll > 0.95 && c.pitch > 0.95,
  `thr=${c.throttle.toFixed(2)} yaw=${c.yaw.toFixed(2)} roll=${c.roll.toFixed(2)} pitch=${c.pitch.toFixed(2)}`);

pad.axes = [0, 0, -1, 1, -1, 1];   // all the way the other way
tick(4);
check('reversed deflection gives the opposite sign',
  c.throttle < 0.05 && c.yaw < -0.95 && c.roll < -0.95 && c.pitch < -0.95,
  `thr=${c.throttle.toFixed(2)} yaw=${c.yaw.toFixed(2)} roll=${c.roll.toFixed(2)} pitch=${c.pitch.toFixed(2)}`);

pad.axes = [0, 0, 0, 0, 0, 0];     // centred
tick(4);
check('centre is neutral (throttle mid, rotations zero)',
  Math.abs(c.yaw) < 0.02 && Math.abs(c.roll) < 0.02 && Math.abs(c.pitch) < 0.02,
  `thr=${c.throttle.toFixed(2)} yaw=${c.yaw.toFixed(2)}`);

// --- partial-range pot (a transmitter that only reports -0.8..0.6) ---
inp.beginAxisCalibration('roll');
pad.axes = [0, 0, 0, 0, -0.8, 0]; tick(2);
pad.axes = [0, 0, 0, 0, 0.6, 0];  tick(2);
inp.commitAxisCalibration();
pad.axes = [0, 0, 0, 0, 0.6, 0];  tick(4);
check('partial-range pot still reaches full output', c.roll > 0.95, `roll=${c.roll.toFixed(3)}`);

// --- legacy invert-style binding still works ---
const legacy = axisEndpoints({ type: 'axis', index: 1, invert: true, mode: 'unipolar' });
check('legacy invert binding converts to endpoints', legacy.lo === 1 && legacy.hi === -1,
  `lo=${legacy.lo} hi=${legacy.hi}`);

// --- EdgeTX / OpenTX radio preset (USB joystick, AETR) ---
{
  settings.loadRadioPreset('edgetx');
  settings.set('inputMode', 'gamepad');
  const radio = {
    index: 0, connected: true, mapping: '', id: 'EdgeTX Radio Joystick',
    axes: [0, 0, -1, 0, 1, -1, 0, 0],
    buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })),
  };
  define('navigator', { getGamepads: () => [radio] });
  const rin = new InputManager();
  for (let i = 0; i < 4; i++) rin.update(1 / 60);
  const ch = rin.controls.channels;
  check('EdgeTX preset: roll 1500, throttle 1000, AUX1 2000',
    Math.abs(ch[0] - 1500) < 3 && Math.abs(ch[2] - 1000) < 3 && Math.abs(ch[4] - 2000) < 3,
    `roll=${ch[0].toFixed(0)} thr=${ch[2].toFixed(0)} aux1=${ch[4].toFixed(0)}`);
  check('EdgeTX preset: switch-based arming', rin.controls.switchArming === true);

  // ARM evaluates true once throttle is low and AUX1 was seen off first.
  const { FlightController } = await import('../src/fc/FlightController.js');
  const fc = new FlightController({ modes: settings.get('modes') }, 1000);
  fc.setArmSource('switch');
  let t = 0;
  const feed = (aux1, n) => {
    for (let i = 0; i < n; i++) {
      t += 0.001;
      if (i % 4 === 0) {
        radio.axes[4] = aux1;
        rin.update(1 / 250);
        fc.onRxFrame(rin.controls.channels, t);
      }
      fc.update(0.001, { trueRatesDps: [0, 0, 0], attitudeDeg: { rollDeg: 0, pitchDeg: 0 }, motorRpm: [0, 0, 0, 0], vbat: 25, t });
    }
  };
  feed(1, 40);
  const blockedFirst = !fc.armed && fc.armBlockReason === 'ARMSWITCH';
  feed(-1, 40);
  feed(1, 40);
  check('EdgeTX preset: ARM only after the switch was seen off', blockedFirst && fc.armed,
    `first=${blockedFirst} armed=${fc.armed} reason=${fc.armBlockReason}`);
  settings.loadRadioPreset('gamepad');
  settings.set('inputMode', 'auto');
}

console.log(`\n${pass}/${pass + fail} input checks passed`);
if (fail) process.exit(1);
