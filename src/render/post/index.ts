// FRONT ULTRA — HDR post-processing pipeline (owner: globe).
// scene -> HalfFloat HDR target (MSAA x4 on Ultra) -> PBR bloom mip chain -> composite (lens dirt, ghosts,
// chromatic aberration, flash/whiteout, ACES filmic, vignette, grain, fade, sRGB) -> FXAA / SMAA -> canvas.
// post.render() is the ONLY path to the screen. flash() drives the nuke whiteout + chromatic aberration pulse.
// All post programs are compiled during init (never mid-game).

import * as THREE from 'three';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { FrameInfo, GameContext, PostApi } from '../../shared/api';
import type { QualityProfile } from '../../shared/quality';
import { clamp01 } from '../../shared/math';
import { presentationTime, shotView } from '../../shared/shots';
import { COMPOSITE_FRAG, DOWNSAMPLE_FRAG, FS_VERT, UPSAMPLE_FRAG } from './shaders';

interface PostSettings {
  bloomLevels: number;
  /** First bloom mip resolution divisor. */
  bloomDiv: number;
  bloom: boolean;
  flares: boolean;
  cinematic: boolean;
  aa: QualityProfile['antialias'];
}

function settingsFor(q: QualityProfile): PostSettings {
  return {
    bloom: q.bloom > 0,
    bloomLevels: q.bloom >= 2 ? 6 : 4,
    bloomDiv: q.bloom >= 2 ? 2 : 4,
    flares: q.cinematicPost,
    cinematic: q.cinematicPost,
    aa: q.antialias,
  };
}

function makeLensDirt(): THREE.Texture {
  const W = 512, H = 288;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(18,18,20)';
  g.fillRect(0, 0, W, H);
  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W, y = rnd() * H;
    const r = 4 + Math.pow(rnd(), 2.5) * 38;
    const a = 0.03 + rnd() * 0.09;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const tint = 200 + Math.floor(rnd() * 55);
    grd.addColorStop(0, `rgba(${tint},${tint},255,${a})`);
    grd.addColorStop(0.7, `rgba(${tint},${tint},${tint},${a * 0.6})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // A few smudge streaks.
  for (let i = 0; i < 14; i++) {
    g.save();
    g.translate(rnd() * W, rnd() * H);
    g.rotate(rnd() * Math.PI);
    const len = 40 + rnd() * 140;
    const grd = g.createLinearGradient(-len / 2, 0, len / 2, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.5, `rgba(255,255,255,${0.03 + rnd() * 0.04})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(-len / 2, -3 - rnd() * 6, len, 6 + rnd() * 10);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const SLOW_FRAME_MS = 900;

function detectSoftwareGl(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch {
    return false;
  }
}

export function createPostPipeline(ctx: GameContext): PostApi {
  const renderer = ctx.renderer;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  let cfg = settingsFor(ctx.quality);
  // Software rasterisers (SwiftShader/llvmpipe: headless capture & CI) take seconds per frame. There we re-render
  // the 3D image at most once per SLOW_FRAME_MS and let the frames in between present the previous image, so
  // frame-counting stagers and playtests keep moving. Real GPUs never take this path.
  const slowGpu = detectSoftwareGl(renderer);
  let lastFullRender = -1e9;
  const size = new THREE.Vector2(1, 1);

  const hdrOpts = {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false,
  } as const;
  let sceneRT = new THREE.WebGLRenderTarget(1, 1, { ...hdrOpts, depthBuffer: true, samples: cfg.aa === 'msaa4' ? 4 : 0 });
  const bloomRTs: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < 6; i++) bloomRTs.push(new THREE.WebGLRenderTarget(1, 1, hdrOpts));
  const ldrRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false,
  });

  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fsCam.position.z = 0.5;
  fsCam.updateMatrixWorld();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  fsScene.add(quad);

  const downMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: DOWNSAMPLE_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 },
      uThreshold: { value: 1.1 }, uKnee: { value: 0.6 },
    },
  });
  const upMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: UPSAMPLE_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending, transparent: true,
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 }, uWeight: { value: 1.0 } },
  });
  const dirtTex = makeLensDirt();
  const compUniforms = {
    tScene: { value: sceneRT.texture as THREE.Texture },
    tBloom: { value: bloomRTs[0].texture as THREE.Texture },
    tFlare: { value: bloomRTs[2].texture as THREE.Texture },
    tDirt: { value: dirtTex as THREE.Texture },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBloom: { value: 0.55 },
    uFlare: { value: 0.24 },
    uDirt: { value: 1.6 },
    uExposure: { value: 1.0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uCA: { value: 0 },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.035 },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uSaturation: { value: 1.06 },
    uCinematic: { value: 1 },
    uRaw: { value: 0 },
  };
  const compMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: compUniforms, defines: { BLOOM: cfg.bloom ? 1 : 0, FLARES: cfg.flares ? 1 : 0 },
  });
  const fxaaMat = new THREE.ShaderMaterial({
    vertexShader: FXAAShader.vertexShader, fragmentShader: FXAAShader.fragmentShader, toneMapped: false,
    uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false,
  });
  let smaa: SMAAPass | null = null;

  // Effect state.
  let flashLevel = 0, flashDecay = 1;
  let lastUpdateNow = 0;
  const flashColor = new THREE.Color(1, 1, 1);
  let caPulse = 0, caDecay = 1;
  let fade = 0;
  let fadeAnim: { from: number; to: number; t: number; dur: number; resolve: () => void } | null = null;
  let exposure = 1;
  let bloomLevels = cfg.bloomLevels;

  function allocate(): void {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.floor(size.x)), h = Math.max(1, Math.floor(size.y));
    sceneRT.setSize(w, h);
    ldrRT.setSize(w, h);
    let bw = Math.max(1, Math.floor(w / cfg.bloomDiv)), bh = Math.max(1, Math.floor(h / cfg.bloomDiv));
    bloomLevels = 0;
    for (let i = 0; i < 6; i++) {
      bloomRTs[i].setSize(bw, bh);
      if (i < cfg.bloomLevels && bw >= 4 && bh >= 4) bloomLevels = i + 1;
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    compUniforms.tFlare.value = bloomRTs[Math.min(2, Math.max(0, bloomLevels - 1))].texture;
    compUniforms.uRes.value.set(w, h);
    (fxaaMat.uniforms.resolution.value as THREE.Vector2).set(1 / w, 1 / h);
    smaa?.setSize(w, h);
  }

  function applyConfig(q: QualityProfile): void {
    const next = settingsFor(q);
    const samples = next.aa === 'msaa4' ? 4 : 0;
    if (samples !== sceneRT.samples) {
      sceneRT.dispose();
      sceneRT = new THREE.WebGLRenderTarget(1, 1, { ...hdrOpts, depthBuffer: true, samples });
      compUniforms.tScene.value = sceneRT.texture;
    }
    cfg = next;
    compMat.defines.BLOOM = cfg.bloom ? 1 : 0;
    compMat.defines.FLARES = cfg.flares ? 1 : 0;
    compMat.needsUpdate = true;
    compUniforms.uVignette.value = cfg.cinematic ? 0.38 : 0.18;
    compUniforms.uGrain.value = cfg.cinematic ? 0.03 : 0;
    compUniforms.uBloom.value = q.bloom >= 2 ? 0.55 : 0.45;
    if (cfg.aa === 'smaa' && !smaa) smaa = new SMAAPass();
    allocate();
  }

  function pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null, clear = true): void {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.autoClear = clear;
    renderer.render(fsScene, fsCam);
  }

  function renderBloom(): void {
    // Down chain.
    let src: THREE.Texture = sceneRT.texture;
    let sw = sceneRT.width, sh = sceneRT.height;
    for (let i = 0; i < bloomLevels; i++) {
      downMat.uniforms.tSrc.value = src;
      (downMat.uniforms.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      pass(downMat, bloomRTs[i]);
      src = bloomRTs[i].texture;
      sw = bloomRTs[i].width;
      sh = bloomRTs[i].height;
    }
    // Up chain: mip[i-1] += tent(mip[i]).
    for (let i = bloomLevels - 1; i > 0; i--) {
      upMat.uniforms.tSrc.value = bloomRTs[i].texture;
      (upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / bloomRTs[i].width, 1 / bloomRTs[i].height);
      upMat.uniforms.uWeight.value = 0.85;
      pass(upMat, bloomRTs[i - 1], false);
    }
  }

  (window as unknown as { __post?: unknown }).__post = { ca: () => compUniforms.uCA.value };
  const api: PostApi = {
    async init(progress) {
      applyConfig(ctx.quality);
      // Compile every post program now (and warm the SMAA lookup textures), never mid-game.
      const compileScene = new THREE.Scene();
      for (const m of [downMat, upMat, compMat, fxaaMat]) {
        const q = new THREE.Mesh(quad.geometry, m);
        q.frustumCulled = false;
        compileScene.add(q);
      }
      try {
        await renderer.compileAsync(compileScene, fsCam);
        // SMAA builds its programs on first use: run it once now (hidden under the loading screen).
        if (smaa) {
          smaa.renderToScreen = true;
          smaa.render(renderer, null as unknown as THREE.WebGLRenderTarget, ldrRT, 0, false);
          renderer.setRenderTarget(null);
        }
      } catch (err) {
        console.warn('[post] precompile failed', err);
      }
      progress(1);
    },
    warmup(on) {
      // Scene programs must be compiled in the variant they are drawn with: into the linear HDR target
      // (no tone mapping, linear output). Bind it while the app runs compileAsync().
      if (on) {
        allocate();
        renderer.setRenderTarget(sceneRT);
      } else {
        renderer.setRenderTarget(null);
      }
    },
    update(frame: FrameInfo) {
      // Screen-space timings (fades, flash) follow wall-clock time: frame.dt is clamped to 0.1 s, which would
      // stretch a 2 s whiteout to half a minute on a slow (software-rendered) frame rate.
      const realDt = lastUpdateNow > 0 ? Math.min(0.5, Math.max(0, (frame.now - lastUpdateNow) / 1000)) : frame.dt;
      lastUpdateNow = frame.now;
      if (fadeAnim) {
        fadeAnim.t += realDt * 1000;
        const k = clamp01(fadeAnim.t / fadeAnim.dur);
        const e = k * k * (3 - 2 * k);
        fade = fadeAnim.from + (fadeAnim.to - fadeAnim.from) * e;
        if (k >= 1) {
          const f = fadeAnim;
          fadeAnim = null;
          f.resolve();
        }
      }
      flashLevel = Math.max(0, flashLevel - realDt * flashDecay);
      caPulse = Math.max(0, caPulse - realDt * caDecay);
      compUniforms.uTime.value = presentationTime(frame.time);
    },
    render(scene: THREE.Scene, camera: THREE.Camera, _frame: FrameInfo) {
      if (slowGpu) {
        const now = performance.now();
        if (now - lastFullRender < SLOW_FRAME_MS) return;
        lastFullRender = now;
      }
      renderer.getDrawingBufferSize(size);
      if (Math.floor(size.x) !== sceneRT.width || Math.floor(size.y) !== sceneRT.height) allocate();
      const prevAuto = renderer.autoClear;

      renderer.setRenderTarget(sceneRT);
      renderer.autoClear = true;
      renderer.render(scene, camera);

      if (shotView.mask && scene === ctx.scene) {
        // &mask=owner: the flat owner-id image straight to the canvas (no bloom, grading, grain or AA).
        compUniforms.uRaw.value = 1;
        pass(compMat, null);
        compUniforms.uRaw.value = 0;
        renderer.setRenderTarget(null);
        renderer.autoClear = prevAuto;
        return;
      }

      if (cfg.bloom && bloomLevels > 0) renderBloom();

      const f = flashLevel;
      compUniforms.uFlash.value = Math.min(1.6, f);
      compUniforms.uFlashColor.value.copy(flashColor);
      // No chromatic aberration in the strategic view (text and borders never get RGB fringes, DESIGN_V2 §10.10):
      // only command mode and cinematic camera shots keep the lens look.
      const lensLook = ctx.app.state === 'command' || ctx.cameraRig.mode === 'cinematic';
      compUniforms.uCA.value = lensLook ? (cfg.cinematic ? 0.0022 : 0) + caPulse : 0;
      compUniforms.uExposure.value = exposure * (1 + Math.min(f, 1) * 0.6);
      compUniforms.uFade.value = fade;

      const aa = cfg.aa;
      if (aa === 'fxaa') {
        pass(compMat, ldrRT);
        fxaaMat.uniforms.tDiffuse.value = ldrRT.texture;
        pass(fxaaMat, null);
      } else if (aa === 'smaa' && smaa) {
        pass(compMat, ldrRT);
        smaa.renderToScreen = true;
        smaa.render(renderer, null as unknown as THREE.WebGLRenderTarget, ldrRT, 0, false);
      } else {
        pass(compMat, null);
      }
      renderer.setRenderTarget(null);
      renderer.autoClear = prevAuto;
    },
    flash(intensity, durationMs, color = 0xffffff) {
      if (!ctx.settings.get().screenShake) intensity *= 0.35;
      flashLevel = Math.max(flashLevel, intensity);
      flashDecay = Math.max(0.01, flashLevel / Math.max(0.001, durationMs / 1000));
      flashColor.setHex(color);
      // Chromatic aberration pulse rides on every flash (shockwave distortion).
      caPulse = Math.max(caPulse, Math.min(0.05, intensity * 0.028));
      caDecay = caPulse / Math.max(0.05, (durationMs / 1000) * 0.8);
    },
    fadeTo(opacity, durationMs) {
      fadeAnim?.resolve();
      return new Promise<void>((resolve) => {
        fadeAnim = { from: fade, to: clamp01(opacity), t: 0, dur: Math.max(1, durationMs), resolve };
      });
    },
    setExposure(v) {
      exposure = v;
    },
    resize() {
      allocate();
    },
    setQuality(q) {
      applyConfig(q);
    },
  };
  return api;
}
