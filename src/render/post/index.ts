// FRONT ULTRA — post-processing pipeline (owner: globe).
// STUB by the architect: renders straight to the canvas with ACES tone mapping, then composites a
// full-screen overlay quad for flashes and fades. The globe owner replaces it with the HDR pipeline
// (EffectComposer: HalfFloat targets, bloom, AA per quality, cinematic grading, flash/fade/shake FX).
// Keep the export: createPostPipeline(ctx): PostApi. post.render() is the ONLY path to the screen.

import * as THREE from 'three';
import type { FrameInfo, GameContext, PostApi } from '../../shared/api';
import { clamp01 } from '../../shared/math';

export function createPostPipeline(ctx: GameContext): PostApi {
  const renderer = ctx.renderer;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const overlayScene = new THREE.Scene();
  const overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const overlayMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMat);
  quad.frustumCulled = false;
  overlayScene.add(quad);

  let flashLevel = 0, flashDecay = 1, flashColor = new THREE.Color(0xffffff);
  let fade = 0;
  let fadeAnim: { from: number; to: number; t: number; dur: number; resolve: () => void } | null = null;
  let exposure = 1;

  return {
    async init(progress) {
      progress(1);
    },
    update() {},
    render(scene: THREE.Scene, camera: THREE.Camera, frame: FrameInfo) {
      if (fadeAnim) {
        fadeAnim.t += frame.dt * 1000;
        const k = clamp01(fadeAnim.t / fadeAnim.dur);
        fade = fadeAnim.from + (fadeAnim.to - fadeAnim.from) * k;
        if (k >= 1) {
          const f = fadeAnim;
          fadeAnim = null;
          f.resolve();
        }
      }
      flashLevel = Math.max(0, flashLevel - frame.dt * flashDecay);
      renderer.toneMappingExposure = exposure;
      renderer.autoClear = true;
      renderer.render(scene, camera);
      const a = Math.max(clamp01(flashLevel), fade);
      if (a > 0.001) {
        overlayMat.color.copy(fade >= flashLevel ? new THREE.Color(0x000000) : flashColor);
        overlayMat.opacity = a;
        renderer.autoClear = false;
        renderer.render(overlayScene, overlayCam);
        renderer.autoClear = true;
      }
    },
    flash(intensity, durationMs, color = 0xffffff) {
      if (!ctx.settings.get().screenShake) intensity *= 0.3;
      flashLevel = Math.max(flashLevel, intensity);
      flashDecay = Math.max(0.01, intensity / (durationMs / 1000));
      flashColor = new THREE.Color(color);
    },
    fadeTo(opacity, durationMs) {
      fadeAnim?.resolve();
      return new Promise<void>((resolve) => {
        fadeAnim = { from: fade, to: opacity, t: 0, dur: Math.max(1, durationMs), resolve };
      });
    },
    setExposure(v) {
      exposure = v;
    },
    resize() {},
  };
}
