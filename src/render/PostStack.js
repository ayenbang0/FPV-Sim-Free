/**
 * render/PostStack.js
 * ---------------------------------------------------------------------------
 * The whole post pipeline, as one TSL node graph on three's RenderPipeline.
 *
 *   scenePass = pass(scene, camera)   MRT { output, normal: normalView (+ metal/rough), velocity, emissive }
 *        │
 *        ├─ ⊕ godrays                  shafts through skylights (sunbeam maps, high/ultra)
 *        ├─ × GTAO                     ambient occlusion, multiplied into the lit colour
 *        ├─ + SSR                      screen-space reflections (ultra)
 *        ├─ + bloom                    of the emissive target, threshold 0.9 — gate
 *        │                             LEDs, lamps, windows, the sun disc
 *        ├─ + lensflare                ghosts off the sun (outdoor maps)
 *        ├─ motion blur                per-pixel velocity, scaled with airspeed
 *        ├─ TRAA (high/ultra)          temporal AA, in linear HDR
 *        ▼
 *   renderOutput()                     ACES tone mapping + sRGB
 *        ├─ SMAA (low/medium)          morphological AA, in display space
 *        ▼
 *   FPV lens (FpvLens.js)              fisheye remap + rolling-shutter jello
 *        ▼
 *   video system (FpvVideo.js)         HD macroblocks/freeze or analog CRT
 *
 * Ordering note: the tone map sits before SMAA and the lens/video stage rather
 * than at the very end. SMAA's edge detection is designed for display-space
 * values, TRAA for linear ones (three's own examples use exactly this split),
 * and the video system's grain and scanline depths were tuned on the displayed
 * picture. The lens is a pure remap, so it is indifferent to the order.
 *
 * In 'fisheye-cube' mode the scene pass is replaced by a CubeCamera riding the
 * FPV camera (five faces; the back face renders nothing). The lens samples the
 * cube in linear HDR first, then bloom/lensflare/tone map/SMAA/video run on the
 * lensed image. GTAO, SSR, TRAA and motion blur need a single perspective
 * depth/velocity buffer and are skipped in that mode.
 *
 * The graph is rebuilt only when its *structure* changes (quality tier, lens
 * mode, video system, motion blur, map type); everything that moves per frame
 * is a uniform. If building or running the graph throws, the stack marks
 * itself failed and CameraRig renders the scene directly — the old
 * `_composerFailed` contract: never a black screen.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, pass, mrt, output, normalView, velocity, metalness, roughness, emissive,
  sample as sampleFn, uniform, vec2, vec3, vec4, float, abs, clamp, normalize, select,
  screenUV, convertToTexture, renderOutput, rtt,
} from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { ssr } from 'three/examples/jsm/tsl/display/SSRNode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { lensflare } from 'three/examples/jsm/tsl/display/LensflareNode.js';
import { gaussianBlur } from 'three/examples/jsm/tsl/display/GaussianBlurNode.js';
import { motionBlur } from 'three/examples/jsm/tsl/display/MotionBlur.js';
import { traa } from 'three/examples/jsm/tsl/display/TRAANode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';
import { godrays } from 'three/examples/jsm/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/examples/jsm/tsl/display/BilateralBlurNode.js';
import { depthAwareBlend } from 'three/examples/jsm/tsl/display/depthAwareBlend.js';

import { createLensUniforms, updateLensUniforms, createLensSampler } from './FpvLens.js';
import { PROP_LAYER } from './DroneModel.js';
import { createVideoUniforms, updateVideoUniforms, createVideoNode, HD_FREEZE_RSSI } from './FpvVideo.js';

/** Layer the prop-blur discs live on (see render/DroneModel.js). */
export { PROP_LAYER };

/** Index of the +Z face among CubeCamera's children (px, nx, py, ny, pz, nz). */
const CUBE_BACK_FACE = 4;

/** Octahedral normal encoding into [0,1]² (unit vector → 2 channels). */
const octEncode = Fn(([nIn]) => {
  const n = vec3(nIn).toVar();
  n.divAssign(abs(n.x).add(abs(n.y)).add(abs(n.z)));
  const sx = select(n.x.greaterThanEqual(0.0), float(1.0), float(-1.0));
  const sy = select(n.y.greaterThanEqual(0.0), float(1.0), float(-1.0));
  const wrapped = vec2(float(1.0).sub(abs(n.y)).mul(sx), float(1.0).sub(abs(n.x)).mul(sy));
  const xy = select(n.z.greaterThanEqual(0.0), n.xy, wrapped);
  return xy.mul(0.5).add(0.5);
});

/** Inverse of octEncode. */
const octDecode = Fn(([eIn]) => {
  const f = vec2(eIn).mul(2.0).sub(1.0).toVar();
  const n = vec3(f.x, f.y, float(1.0).sub(abs(f.x)).sub(abs(f.y))).toVar();
  const t = clamp(n.z.negate(), 0.0, 1.0);
  n.x.assign(n.x.add(select(n.x.greaterThanEqual(0.0), t.negate(), t)));
  n.y.assign(n.y.add(select(n.y.greaterThanEqual(0.0), t.negate(), t)));
  return normalize(n);
});

export class PostStack {
  /**
   * @param {THREE.WebGPURenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.pipeline = null;
    this.failed = false;
    this._key = null;

    this.quality = { gtao: false, gtaoHalfRes: false, ssr: false, aa: 'smaa', lensflare: false, cubeFaceSize: 512, godrays: false };
    this.lens = { mode: 'rectilinear', fpv: false };
    this.video = { system: 'hd', active: false, rssi: 1, breakup: true, time: 0 };
    this.fx = { bloom: false, bloomStrength: 0.55, motionBlur: false, speed: 0 };
    this.env = { outdoor: false, godrays: false, sun: null, shadows: true };

    this.L = createLensUniforms();
    this.V = createVideoUniforms();
    this.uBloomStrength = uniform(0);
    this.uBlurAmount = uniform(0.5);

    this._nodes = {};
    this._cube = null;
    this._frozen = false;

    /**
     * Developer aid: show one stage of the graph instead of the final image
     * ('scene' | 'display' | 'lensed'). Null in normal use.
     */
    this.debugView = null;
  }

  /** Point the stack at a new renderer (device-loss rebuild). */
  setRenderer(renderer) {
    if (renderer === this.renderer) return;
    this._disposeGraph();
    this._disposeCube();
    this.renderer = renderer;
    this.failed = false;
  }

  /* ---------------------------------------------------------------------- *
   * Inputs
   * ---------------------------------------------------------------------- */

  /** Adopt a quality preset (Quality.js); the graph rebuilds on the next frame if needed. */
  setQuality(preset) {
    if (!preset) return;
    this.quality = { ...this.quality, ...preset };
  }

  /** @param {object} s  see CameraRig._lensState() */
  setFpvLens(s) {
    this.lens = s;
    updateLensUniforms(this.L, s);
  }

  /** @param {{system:string, active:boolean, rssi:number, breakup:boolean, time:number}} s */
  setVideo(s) {
    this.video = s;
    updateVideoUniforms(this.V, s);
    // HD links freeze on the last good frame instead of breaking up further.
    const freeze = s.system === 'hd' && s.active !== false && s.breakup !== false &&
      Number.isFinite(s.rssi) && s.rssi < HD_FREEZE_RSSI;
    this._frozen = freeze;
    if (this._nodes.final) this._nodes.final.autoUpdate = !freeze;
  }

  /** Bloom, motion blur and the airspeed that scales the blur. */
  setEffects(fx) {
    this.fx = { ...this.fx, ...fx };
    const raw = Number.isFinite(this.fx.bloomStrength) ? Math.min(1.2, Math.max(0, this.fx.bloomStrength)) : 0.55;
    this.uBloomStrength.value = this.fx.bloom ? 0.15 + raw * 0.85 : 0;
    // Shutter fraction: a hover stays crisp, a 40 m/s dive smears.
    const speed = Number.isFinite(this.fx.speed) ? this.fx.speed : 0;
    this.uBlurAmount.value = Math.min(0.85, 0.25 + speed * 0.012);
  }

  /** Map-level switches: outdoor (lens flare), sunbeam godrays and the sun light. */
  setEnvironment(env) {
    this.env = { ...this.env, ...env };
  }

  resize(_w, _h) {
    // Every pass sizes itself from the renderer's drawing buffer each frame;
    // only the lens needs the aspect, which CameraRig pushes with the lens state.
  }

  /* ---------------------------------------------------------------------- *
   * Graph
   * ---------------------------------------------------------------------- */

  _effectiveLensMode() {
    const m = this.lens?.mode || 'rectilinear';
    // The cube only exists for the FPV feed; chase cameras read the plain render.
    if (m === 'fisheye-cube' && this.lens?.fpv === false) return 'fisheye';
    return m;
  }

  _godraysOn() {
    const sun = this.env.sun;
    return !!(this.quality.godrays && this.env.godrays && sun && sun.visible && sun.castShadow &&
      this.renderer?.shadowMap?.enabled !== false && !sun.shadow?.shadowNode);
  }

  _graphKey() {
    const q = this.quality;
    return [
      q.gtao, q.gtaoHalfRes, q.ssr, q.aa, q.lensflare, this._godraysOn(),
      this._effectiveLensMode(), this.video.system, !!this.fx.motionBlur,
      !!this.env.outdoor, q.cubeFaceSize, this.env.sun?.uuid || '', this.debugView || '',
    ].join('|');
  }

  _build() {
    this._disposeGraph();
    const renderer = this.renderer;
    const camera = this.camera;
    const q = this.quality;
    const mode = this._effectiveLensMode();
    const n = {};

    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputColorTransform = false;

    let sample;

    if (mode === 'fisheye-cube') {
      const cube = this._ensureCube(q.cubeFaceSize | 0 || 512);
      const lensed = convertToTexture(createLensSampler(this.L, 'fisheye-cube', cube.target.texture)(screenUV));
      n.lensed = lensed;
      let c = lensed;
      const b = bloom(lensed, 0, 0.5, 0.9);
      b.strength = this.uBloomStrength;
      n.bloom = b;
      c = vec4(c.rgb.add(b.getTextureNode().rgb), c.a);
      if (q.lensflare && this.env.outdoor) {
        n.flare = lensflare(b.getTextureNode(), { threshold: 0.5, ghostAttenuationFactor: 25, ghostSpacing: 0.25 });
        c = vec4(c.rgb.add(gaussianBlur(n.flare.getTextureNode(), 8).rgb), c.a);
      }
      let display = renderOutput(c);
      display = smaa(display).getTextureNode();
      sample = (uv) => display.sample(uv);
    } else {
      this._disposeCube();
      const scenePass = pass(this.scene, camera);
      // MRT: four attachments on every tier. WebGPU's baseline budget is 32
      // bytes per sample and it counts rgba8 and rgba16f alike as 8, so the
      // view normal is octahedral-packed into RG of one 8-bit target with
      // metalness and roughness (for SSR) in BA. `emissive` feeds the bloom.
      scenePass.setMRT(mrt({
        output,
        normal: vec4(octEncode(normalView), metalness, roughness),
        velocity,
        emissive: vec4(emissive, 1.0),
      }));
      scenePass.getTexture('normal').type = THREE.UnsignedByteType;
      n.scenePass = scenePass;

      const color = scenePass.getTextureNode('output');
      const depth = scenePass.getTextureNode('depth');
      const normalTex = scenePass.getTextureNode('normal');
      const normal = sampleFn((uv) => octDecode(normalTex.sample(uv).xy));
      const vel = scenePass.getTextureNode('velocity');
      const emissiveTex = scenePass.getTextureNode('emissive');

      // Godrays first, composited straight onto the scene-pass texture (the
      // form three's example uses). Compositing after GTAO would nest the AO
      // pass two render-to-texture levels deep, which mis-sequences it.
      let base = color;
      if (this._godraysOn()) {
        const sun = this.env.sun;
        const gr = godrays(depth, camera, sun);
        n.godrays = gr;
        const blurred = bilateralBlur(gr.getTextureNode());
        n.debugGodrays = gr.getTextureNode();
        n.debugGodraysBlur = blurred.getTextureNode();
        base = depthAwareBlend(color, blurred.getTextureNode(), depth, camera, {
          blendColor: uniform(sun.color), edgeRadius: 2, edgeStrength: 2,
        });
        n.debugComposite = base;
      }

      // Half-float overflow guard: a sun glint on wet or metallic surfaces can
      // exceed 65504 and store as infinity, which bloom and TRAA would spread
      // as NaN across the frame. Nothing above ~20 survives ACES anyway.
      let c = base.clamp(0.0, 4096.0);
      if (q.gtao) {
        const aoPass = ao(depth, normal, camera);
        aoPass.resolutionScale = q.gtaoHalfRes ? 0.5 : 1;
        n.ao = aoPass;
        n.debugAo = aoPass.getTextureNode();
        c = vec4(c.rgb.mul(aoPass.getTextureNode().r), c.a);
      }
      if (q.ssr) {
        const s = ssr(color, depth, normal, { metalnessNode: normalTex.b, roughnessNode: normalTex.a, camera });
        n.ssr = s;
        // SSR outputs premultiplied colour; blend additively.
        c = vec4(c.rgb.add(s.getTextureNode().rgb), c.a);
      }
      // Bloom reads the emissive target, not the lit colour: a daylight sky's
      // linear radiance sits well above the 0.9 threshold everywhere, and
      // blooming it washes the frame out. Emissives (gate LEDs, lamps,
      // windows, the drone's LED strips) and the sun disc (the sky writes it
      // into this target) are what should glow.
      const b = bloom(emissiveTex.clamp(0.0, 4096.0), 0, 0.5, 0.9);
      b.strength = this.uBloomStrength;
      n.bloom = b;
      c = vec4(c.rgb.add(b.getTextureNode().rgb), c.a);
      if (q.lensflare && this.env.outdoor) {
        n.flare = lensflare(b.getTextureNode(), { threshold: 0.5, ghostAttenuationFactor: 25, ghostSpacing: 0.25 });
        c = vec4(c.rgb.add(gaussianBlur(n.flare.getTextureNode(), 8).rgb), c.a);
      }
      if (this.fx.motionBlur) {
        c = motionBlur(convertToTexture(c), vel.mul(this.uBlurAmount));
      }
      n.debugPreAA = c;
      if (q.aa === 'traa') {
        const t = traa(c, depth, vel, camera);
        n.traa = t;
        c = t.getTextureNode();
      }
      let display = renderOutput(c);
      if (q.aa !== 'traa') display = smaa(display).getTextureNode();
      else display = convertToTexture(display);
      n.debugScene = renderOutput(color);
      n.debugDisplay = display;
      sample = createLensSampler(this.L, mode, display);
    }

    const video = createVideoNode(this.video.system === 'analog' ? 'analog' : 'hd', this.V, this.L, sample);
    // Rendered into its own target so an HD link can hold the last frame.
    const final = rtt(video);
    final.autoUpdate = !this._frozen;
    n.final = final;
    pipeline.outputNode = final;
    if (this.debugView === 'scene' && n.debugScene) pipeline.outputNode = n.debugScene;
    else if (this.debugView === 'display' && n.debugDisplay) pipeline.outputNode = n.debugDisplay;
    else if (this.debugView === 'lensed') pipeline.outputNode = sample(screenUV);
    else if (this.debugView === 'video') pipeline.outputNode = video;
    else if (this.debugView === 'godrays' && n.debugGodrays) pipeline.outputNode = vec4(n.debugGodrays.rrr, 1.0);
    else if (this.debugView === 'godraysBlur' && n.debugGodraysBlur) pipeline.outputNode = vec4(n.debugGodraysBlur.rgb, 1.0);
    else if (this.debugView === 'composite' && n.debugComposite) pipeline.outputNode = renderOutput(n.debugComposite);
    else if (this.debugView === 'ao' && n.debugAo) pipeline.outputNode = vec4(n.debugAo.rrr, 1.0);
    else if (this.debugView === 'preaa') pipeline.outputNode = renderOutput(n.debugPreAA);

    this.pipeline = pipeline;
    this._nodes = n;
  }

  /* ---------------------------------------------------------------------- *
   * Cube camera (fisheye-cube)
   * ---------------------------------------------------------------------- */

  _ensureCube(size) {
    if (this._cube && this._cube.size === size) return this._cube;
    this._disposeCube();
    const target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(0.04, this.camera.far, target);
    // The cube rides the FPV camera, so its +Z face looks backwards: skip it.
    // CubeCamera's faces share one Layers object, so each gets its own first.
    cam.children.forEach((c, i) => {
      c.layers = new THREE.Layers();
      if (i === CUBE_BACK_FACE) c.layers.disableAll();
      else c.layers.enable(PROP_LAYER);
    });
    this._cube = { size, target, cam };
    return this._cube;
  }

  _updateCube() {
    const cube = this._cube;
    if (!cube) return;
    const cam = cube.cam;
    cam.position.copy(this.camera.position);
    cam.quaternion.copy(this.camera.quaternion);
    for (const c of cam.children) {
      if (c.far !== this.camera.far) { c.far = this.camera.far; c.updateProjectionMatrix(); }
    }
    cam.updateMatrixWorld(true);
    cam.update(this.renderer, this.scene);
  }

  _disposeCube() {
    if (!this._cube) return;
    try { this._cube.target.dispose(); } catch (_e) { /* ignore */ }
    this._cube = null;
  }

  /* ---------------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------------- */

  /**
   * Draw one frame. Returns false when the stack is unavailable and the
   * caller should render directly.
   */
  render() {
    if (this.failed) return false;
    try {
      const key = this._graphKey();
      if (key !== this._key || !this.pipeline) {
        this._build();
        this._key = key;
      }
      if (this._cube && !this._frozen) this._updateCube();
      this.pipeline.render();
      return true;
    } catch (err) {
      console.warn('[PostStack] post-processing failed; reverting to direct render.', err);
      this.failed = true;
      this._disposeGraph();
      this._disposeCube();
      return false;
    }
  }

  _disposeGraph() {
    try { this.pipeline?.dispose(); } catch (_e) { /* ignore */ }
    for (const node of Object.values(this._nodes || {})) {
      try { node?.dispose?.(); } catch (_e) { /* ignore */ }
    }
    this.pipeline = null;
    this._nodes = {};
    this._key = null;
  }

  dispose() {
    this._disposeGraph();
    this._disposeCube();
  }
}
