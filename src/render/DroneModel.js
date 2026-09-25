/**
 * render/DroneModel.js
 * ---------------------------------------------------------------------------
 * The visible quad, built procedurally from the airframe spec: every size is
 * a proportion of the spec's arm length, body box and prop radius, so the same
 * builder makes a 65 mm whoop and a 7" long-range rig.
 *
 *   frame      carbon plates (MeshPhysicalMaterial, clear coat over a 2×2 twill
 *              weave), aluminium standoffs, the FC/ESC stack
 *   camera     a TPU canopy in the accent colour, the camera body tilted up,
 *              and a glass lens (transmission 1)
 *   antenna    a lollipop VTX antenna on a rear TPU mount
 *   motors     bell motors: base, bell, and six stator slots visible through
 *              the gap between them
 *   props      extruded blade outlines with pitch — tri-blades, or 4-blade
 *              props inside a duct on the whoop
 *   prop blur  one translucent disc per prop whose opacity follows RPM
 *              (smoothstep(1500, 6000, rpm)·0.55) while the blades fade out
 *              over the same range — a real prop is a disc on camera
 *   LEDs       an emissive strip under each arm, bright enough to bloom
 *
 * The prop discs live on their own render layer (PROP_LAYER) so the FPV view
 * can show them alone, at the frame edges, as a real wide lens does.
 *
 * Motor order is the flight model's: FL, FR, RL, RR (−Z is forward). FL and
 * RR spin clockwise seen from above, FR and RL counter-clockwise (props-in).
 */

import * as THREE from 'three/webgpu';
import { carbonWeaveTexture, propDiscTexture } from '../assets/procedural.js';

/** Layer for the prop-blur discs; CameraRig enables it on the FPV camera. */
export const PROP_LAYER = 1;

/** Spin direction per motor, +1 = counter-clockwise seen from above. */
export const PROP_SPIN = [-1, +1, +1, -1];

const TAU = Math.PI * 2;

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * @param {object} spec  airframe (DroneTypes): arm, body, visual, cameraMount, propHeight
 * @returns {{ object3d: THREE.Group, bodyGroup: THREE.Group, propGroups: THREE.Group[],
 *             propDiscs: THREE.Mesh[], setRpm: Function, setFpv: Function, dispose: Function }}
 */
export function buildDroneModel(spec) {
  const v = spec.visual || {};
  const arm = spec.arm;
  const [bw, bh, bd] = spec.body;
  const R = v.propRadius || arm * 0.7;
  const ducted = !!v.ducted;
  const propY = Number.isFinite(spec.propHeight) ? spec.propHeight : bh * 0.44;

  const geos = [];
  const mats = [];
  const texs = [];
  const G = (g) => { geos.push(g); return g; };
  const M = (m) => { mats.push(m); return m; };

  /* ---- materials ---- */
  const weave = carbonWeaveTexture(52, [3, 3]);
  if (weave) texs.push(weave);
  const carbon = M(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: weave || null, roughness: 0.5, metalness: 0.15,
    clearcoat: 0.6, clearcoatRoughness: 0.22,
  }));
  if (!weave) carbon.color.set(v.bodyColor ?? 0x24262b);
  const alu = M(new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.32, metalness: 0.9 }));
  const darkAlu = M(new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.45, metalness: 0.8 }));
  const bell = M(new THREE.MeshStandardMaterial({ color: v.motorColor ?? 0x8a8d92, roughness: 0.28, metalness: 0.92 }));
  const copper = M(new THREE.MeshStandardMaterial({ color: 0xb8733a, roughness: 0.35, metalness: 0.95 }));
  const tpu = M(new THREE.MeshStandardMaterial({ color: v.accentColor ?? 0x18e08a, roughness: 0.62, metalness: 0.0 }));
  const pcb = M(new THREE.MeshStandardMaterial({ color: 0x0f3b24, roughness: 0.55, metalness: 0.2 }));
  const chip = M(new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.4, metalness: 0.3 }));
  const camBody = M(new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.5, metalness: 0.4 }));
  const glass = M(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.02, metalness: 0, transmission: 1, thickness: 0.002, ior: 1.52,
    clearcoat: 1, clearcoatRoughness: 0.02,
  }));
  const coax = M(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7, metalness: 0.1 }));
  const led = M(new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: v.accentColor ?? 0x18e08a, emissiveIntensity: 2.6, roughness: 0.5,
  }));

  const root = new THREE.Group();
  root.name = 'drone';
  const body = new THREE.Group();
  body.name = 'drone-body';
  root.add(body);

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    body.add(m);
    return m;
  };

  /* ---- frame ---- */
  const plateT = Math.max(0.0012, arm * 0.055);
  const bottomY = -bh * 0.22;
  const standoffH = bh * 0.48;
  const topY = bottomY + standoffH;
  const armLen = arm * Math.SQRT2;
  const armW = Math.max(0.004, arm * 0.17);
  const motorR = R * 0.21;
  const motorH = R * 0.3;

  if (!ducted) {
    const armGeo = G(new THREE.BoxGeometry(armW, plateT, armLen * 1.02));
    const padGeo = G(new THREE.CylinderGeometry(motorR * 1.18, motorR * 1.18, plateT, 20));
    for (let i = 0; i < 4; i++) {
      const sx = i === 0 || i === 2 ? -1 : 1;
      const sz = i < 2 ? -1 : 1;
      add(armGeo, carbon, sx * arm * 0.5, bottomY, sz * arm * 0.5, 0, Math.atan2(sx, sz), 0);
      add(padGeo, carbon, sx * arm, bottomY, sz * arm);
    }
  }
  const coreGeo = G(new THREE.BoxGeometry(arm * 0.78, plateT, arm * 1.32));
  add(coreGeo, carbon, 0, bottomY, 0);
  const topGeo = G(new THREE.BoxGeometry(arm * 0.66, plateT * 0.8, arm * 1.16));
  add(topGeo, carbon, 0, topY, arm * 0.04);

  // Standoffs between the plates.
  const soGeo = G(new THREE.CylinderGeometry(arm * 0.028, arm * 0.028, standoffH, 8));
  for (const [x, z] of [[-0.27, -0.5], [0.27, -0.5], [-0.27, 0.5], [0.27, 0.5]]) {
    add(soGeo, alu, x * arm, bottomY + standoffH / 2, z * arm);
  }

  // Stack: ESC and FC boards with a few parts, and the low-ESR capacitor.
  const boardS = arm * 0.42;
  const boardGeo = G(new THREE.BoxGeometry(boardS, plateT * 0.35, boardS));
  const escY = bottomY + standoffH * 0.3;
  const fcY = bottomY + standoffH * 0.62;
  add(boardGeo, pcb, 0, escY, arm * 0.08);
  add(boardGeo, pcb, 0, fcY, arm * 0.08);
  const icGeo = G(new THREE.BoxGeometry(boardS * 0.3, plateT * 0.3, boardS * 0.3));
  add(icGeo, chip, 0, fcY + plateT * 0.3, arm * 0.08);
  for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
    add(icGeo, chip, x * boardS, escY + plateT * 0.3, arm * 0.08 + z * boardS);
  }
  const capGeo = G(new THREE.CylinderGeometry(arm * 0.06, arm * 0.06, arm * 0.3, 12));
  add(capGeo, chip, 0, bottomY + arm * 0.07, arm * 0.62, Math.PI / 2, 0, 0);

  /* ---- camera + TPU canopy ---- */
  const mount = Array.isArray(spec.cameraMount) ? spec.cameraMount : [0, 0.035, -0.03];
  const camS = Math.max(0.006, arm * 0.21);
  const camY = Math.min(mount[1], topY);
  const camZ = Math.min(mount[2], -arm * 0.45);
  const tilt = 25 * Math.PI / 180;
  const cam = new THREE.Group();
  cam.position.set(0, camY, camZ);
  cam.rotation.x = tilt;
  body.add(cam);
  const camMesh = new THREE.Mesh(G(new THREE.BoxGeometry(camS, camS, camS * 0.9)), camBody);
  cam.add(camMesh);
  const barrel = new THREE.Mesh(G(new THREE.CylinderGeometry(camS * 0.34, camS * 0.38, camS * 0.45, 16)), camBody);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -camS * 0.62;
  cam.add(barrel);
  const lens = new THREE.Mesh(G(new THREE.SphereGeometry(camS * 0.3, 16, 8, 0, TAU, 0, Math.PI / 2)), glass);
  lens.rotation.x = -Math.PI / 2;
  lens.position.z = -camS * 0.84;
  cam.add(lens);
  const sideGeo = G(new THREE.BoxGeometry(camS * 0.16, camS * 1.25, camS * 1.2));
  add(sideGeo, tpu, -camS * 0.6, camY, camZ, tilt * 0.3, 0, 0);
  add(sideGeo, tpu, camS * 0.6, camY, camZ, tilt * 0.3, 0, 0);

  /* ---- lollipop VTX antenna on a rear TPU mount ---- */
  const antLen = arm * (ducted ? 0.35 : 0.62);
  const antMount = add(G(new THREE.BoxGeometry(arm * 0.3, plateT * 3, arm * 0.2)), tpu, 0, topY + plateT * 1.5, arm * 0.55);
  void antMount;
  const ant = new THREE.Group();
  ant.position.set(0, topY + plateT * 2, arm * 0.6);
  ant.rotation.x = -0.55;   // raked back
  body.add(ant);
  const coaxMesh = new THREE.Mesh(G(new THREE.CylinderGeometry(arm * 0.012, arm * 0.012, antLen, 6)), coax);
  coaxMesh.position.y = antLen / 2;
  ant.add(coaxMesh);
  const lolly = new THREE.Mesh(G(new THREE.SphereGeometry(arm * 0.07, 14, 10)), tpu);
  lolly.scale.set(1, 0.55, 1);
  lolly.position.y = antLen;
  ant.add(lolly);

  /* ---- motors, props, LEDs ---- */
  const propGroups = [];
  const propDiscs = [];
  const bladeMats = [];
  const discMats = [];
  const discTex = propDiscTexture(53);
  if (discTex) texs.push(discTex);

  const baseGeo = G(new THREE.CylinderGeometry(motorR * 0.98, motorR * 1.05, motorH * 0.3, 20));
  const bellGeo = G(new THREE.CylinderGeometry(motorR, motorR, motorH * 0.55, 24, 1, true));
  const capTopGeo = G(new THREE.CylinderGeometry(motorR, motorR * 0.92, motorH * 0.08, 24));
  const slotGeo = G(new THREE.BoxGeometry(motorR * 0.22, motorH * 0.2, motorR * 0.5));
  const shaftGeo = G(new THREE.CylinderGeometry(motorR * 0.2, motorR * 0.2, motorH * 0.4, 10));
  const bladeGeo = G(makeBladeGeometry(R, motorR * 0.55));
  const discGeo = G(new THREE.CircleGeometry(R, 40));
  const ledGeo = G(new THREE.BoxGeometry(armW * 0.5, plateT * 0.6, armLen * 0.55));
  const ductGeo = ducted ? G(new THREE.TorusGeometry(R * 1.1, R * 0.1, 8, 28)) : null;
  const ductRingGeo = ducted ? G(new THREE.CylinderGeometry(R * 1.14, R * 1.14, R * 0.34, 28, 1, true)) : null;
  const blades = ducted ? 4 : 3;
  const propMat0 = new THREE.MeshStandardMaterial({
    color: v.propColor ?? v.accentColor ?? 0x9aa0a8, roughness: 0.35, metalness: 0.0,
    transparent: true, opacity: 0.9,
  });

  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 2 ? -1 : 1;
    const sz = i < 2 ? -1 : 1;
    const x = sx * arm;
    const z = sz * arm;
    const baseY = ducted ? bottomY : bottomY + plateT / 2;

    // Motor: base, stator slots in the gap, bell, top cap, shaft.
    add(baseGeo, darkAlu, x, baseY + motorH * 0.15, z);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      add(slotGeo, copper, x + Math.cos(a) * motorR * 0.62, baseY + motorH * 0.38, z + Math.sin(a) * motorR * 0.62, 0, -a, 0);
    }
    add(bellGeo, bell, x, baseY + motorH * 0.3 + motorH * 0.22 + motorH * 0.275, z);
    add(capTopGeo, bell, x, baseY + motorH * 0.97, z);
    add(shaftGeo, alu, x, baseY + motorH * 1.1, z);

    if (!ducted) {
      // LED strip under the arm.
      add(ledGeo, led, sx * arm * 0.5, bottomY - plateT * 0.7, sz * arm * 0.5, 0, Math.atan2(sx, sz), 0);
    } else {
      add(ductGeo, tpu, x, propY, z, Math.PI / 2, 0, 0);
      add(ductRingGeo, tpu, x, propY - R * 0.05, z);
      add(ledGeo, led, x * 0.5, bottomY - plateT, z * 0.5, 0, Math.atan2(sx, sz), 0);
    }

    // Prop: a spinning group of blades (mirrored pitch for CW props).
    const bladeMat = propMat0.clone();
    M(bladeMat);
    bladeMats.push(bladeMat);
    const pg = new THREE.Group();
    pg.position.set(x, propY, z);
    const spin = PROP_SPIN[i];
    for (let b = 0; b < blades; b++) {
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.rotation.y = (b / blades) * TAU;
      blade.scale.z = spin;   // mirror the pitch for the opposite rotation
      pg.add(blade);
    }
    const hub = new THREE.Mesh(shaftGeo, bladeMat);
    hub.scale.set(2.2, 0.6, 2.2);
    pg.add(hub);
    body.add(pg);
    propGroups.push(pg);

    // Blur disc: its own layer, never casts shadows, never writes depth.
    const discMat = new THREE.MeshBasicMaterial({
      color: v.propColor ?? v.accentColor ?? 0xb0b6be, map: discTex || null,
      transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    M(discMat);
    discMats.push(discMat);
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, propY + R * 0.01, z);
    disc.layers.set(PROP_LAYER);
    disc.castShadow = false;
    disc.receiveShadow = false;
    disc.renderOrder = 2;
    disc.visible = false;
    root.add(disc);
    propDiscs.push(disc);
  }
  propMat0.dispose();

  body.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  /* ---- runtime ---- */
  const angle = [0, 0, 0, 0];
  let fpv = false;
  let showDiscsInFpv = true;

  function applyVisibility() {
    body.visible = !fpv;
  }

  /**
   * @param {number[]} rpm  per-motor RPM (absolute)
   * @param {number} dt     render delta, seconds
   */
  function setRpm(rpm, dt) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    for (let i = 0; i < 4; i++) {
      const r = Number.isFinite(rpm?.[i]) ? Math.abs(rpm[i]) : 0;
      angle[i] = (angle[i] + PROP_SPIN[i] * (r / 60) * TAU * step) % TAU;
      propGroups[i].rotation.y = angle[i];
      const blur = smoothstep(1500, 6000, r);
      discMats[i].opacity = blur * 0.55;
      propDiscs[i].visible = blur > 0.01 && (!fpv || showDiscsInFpv);
      bladeMats[i].opacity = 0.9 * (1 - blur);
      bladeMats[i].visible = blur < 0.99;
      // The disc texture is radially symmetric; turning it keeps the banding alive.
      propDiscs[i].rotation.z = angle[i] * 0.25;
    }
  }

  /** FPV hides the body; the prop discs stay if `propsInView`. */
  function setFpv(isFpv, propsInView = true) {
    fpv = !!isFpv;
    showDiscsInFpv = propsInView !== false;
    applyVisibility();
  }

  function dispose() {
    try { root.parent?.remove(root); } catch (_e) { /* ignore */ }
    for (const g of geos) { try { g.dispose(); } catch (_e) { /* ignore */ } }
    for (const m of mats) { try { m.dispose(); } catch (_e) { /* ignore */ } }
    for (const t of texs) { try { t.dispose(); } catch (_e) { /* ignore */ } }
  }

  return { object3d: root, bodyGroup: body, propGroups, propDiscs, setRpm, setFpv, dispose };
}

/**
 * One blade: an outline extruded to a thin plate, laid flat along +X from the
 * hub to the tip, with the pitch as a twist about the span.
 */
function makeBladeGeometry(R, hubR) {
  const span = R - hubR;
  const chord = (t) => R * (0.12 + 0.16 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - t * 0.55));
  const lead = [];
  const trail = [];
  const N = 12;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const x = hubR + t * span;
    const c = chord(t) * (t > 0.9 ? Math.sqrt(Math.max(0, 1 - (t - 0.9) / 0.1)) * 0.7 + 0.3 : 1);
    // Sweep the leading edge slightly forward: the classic 5" blade outline.
    const sweep = R * 0.05 * t * t;
    lead.push(new THREE.Vector2(x, c * 0.45 + sweep));
    trail.push(new THREE.Vector2(x, -c * 0.55 + sweep));
  }
  const shape = new THREE.Shape([...lead, ...trail.reverse()]);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: R * 0.02, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -R * 0.01);
  // Lay flat (chord along −Z), then pitch the blade about its span.
  geo.rotateX(-Math.PI / 2);
  geo.rotateX(0.24);
  geo.computeVertexNormals();
  return geo;
}
