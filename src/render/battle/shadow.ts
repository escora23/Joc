// FRONT ULTRA — ground battle: sun shadow map (owner: battle).
// A single orthographic shadow map around the view focus, rendered in the anchor's local frame (meters) so the
// precision is independent of the planet-scale world coordinates. Casters are drawn with depth-only twins of
// their own materials (same vertex animation: exaggerated units, wind, turrets), everything else is hidden for
// the pass. Receivers sample it through `battleShadow()` (5-tap PCF, edge fade). Long golden-hour shadows of
// trees, houses, vehicles and the relief itself.

import * as THREE from 'three';
import type { BattleUniforms } from './common';

/** Render layer used only by the battle shadow pass (casters are enabled on it for the duration of the pass). */
const SHADOW_LAYER = 7;
let lastCasters = 0, lastHidden = 0;
export function shadowStats(): string {
  return `casters=${lastCasters} hidden=${lastHidden}`;
}

export interface ShadowPass {
  readonly camera: THREE.OrthographicCamera;
  /** Render the shadow map for the near group. focus = local point (m), sunL = local sun direction. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, near: THREE.Group, focus: THREE.Vector3, sunL: THREE.Vector3, extent: number): void;
  setSize(size: number): void;
  dispose(): void;
  /** Debug: fraction of shadow-map texels covered by casters (reads the color attachment back). */
  coverage(renderer: THREE.WebGLRenderer): number;
}

export function createShadowPass(uniforms: BattleUniforms, size: number): ShadowPass {
  let rt: THREE.WebGLRenderTarget | null = null;
  const camera = new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, 1, 9000);
  camera.name = 'battle-shadow-camera';
  camera.layers.set(SHADOW_LAYER);
  const prevClear = new THREE.Color();
  const m = new THREE.Matrix4();
  const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
  const up = new THREE.Vector3();
  const localCam = new THREE.Object3D();
  const worldM = new THREE.Matrix4();
  const tmpScale = new THREE.Vector3();
  const projL = new THREE.Matrix4();

  function alloc(n: number): void {
    rt?.dispose();
    rt = null;
    if (n <= 0) {
      uniforms.uShadowInfo.value.x = 0;
      uniforms.uShadowMap.value = null;
      return;
    }
    const depth = new THREE.DepthTexture(n, n, THREE.UnsignedIntType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    rt = new THREE.WebGLRenderTarget(n, n, {
      depthBuffer: true, stencilBuffer: false, depthTexture: depth,
      type: THREE.UnsignedByteType, generateMipmaps: false,
    });
    rt.texture.name = 'battle-shadow-color';
    uniforms.uShadowMap.value = depth;
    uniforms.uShadowInfo.value.y = 1 / n;
  }
  alloc(size);

  return {
    camera,
    render(renderer, scene, near, focus, sunL, extent) {
      if (!rt) return;
      // Sun too low: no useful shadow (the terminator takes over).
      if (sunL.y < 0.01) {
        uniforms.uShadowInfo.value.x = 0;
        return;
      }
      // Build the light view in the anchor's local frame (meters), then express the camera in world space
      // (an unparented camera, world units) so three.js uses it directly.
      const dist = 4500;
      localCam.position.copy(focus).addScaledVector(sunL, dist);
      up.set(0, 1, 0);
      if (Math.abs(sunL.y) > 0.98) up.set(0, 0, 1);
      m.lookAt(localCam.position, focus, up);
      localCam.quaternion.setFromRotationMatrix(m);
      localCam.scale.set(1, 1, 1);
      localCam.updateMatrix();
      near.updateMatrixWorld(true);
      const unit = near.scale.x; // meters -> world units
      worldM.multiplyMatrices(near.matrixWorld, localCam.matrix);
      worldM.decompose(camera.position, camera.quaternion, tmpScale);
      camera.scale.set(1, 1, 1);
      camera.updateMatrixWorld(true);
      const h = (extent / 2) * unit;
      camera.left = -h;
      camera.right = h;
      camera.top = h;
      camera.bottom = -h;
      camera.near = 10 * unit;
      camera.far = dist * 2 * unit;
      camera.updateProjectionMatrix();
      // Casters (meshes whose material has a depth twin) go on the shadow layer with their depth material.
      swapped.length = 0;
      near.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const mesh = o as THREE.Mesh;
        const mat = mesh.material as THREE.Material;
        const depth = (mat as THREE.ShaderMaterial).userData?.depthMat as THREE.Material | undefined;
        if (depth && mesh.visible && !mesh.userData.noShadow) {
          swapped.push([mesh, mesh.material]);
          mesh.material = depth;
          mesh.layers.enable(SHADOW_LAYER);
        }
      });
      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.getClearColor(prevClear);
      const prevAlpha = renderer.getClearAlpha();
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);
      for (const [mesh, mat] of swapped) {
        mesh.material = mat;
        mesh.layers.disable(SHADOW_LAYER);
      }
      // Local (m) -> shadow clip, computed in double precision (same projection, expressed in meters).
      const hm = extent / 2;
      projL.makeOrthographic(-hm, hm, hm, -hm, 10, dist * 2);
      m.copy(localCam.matrix).invert().premultiply(projL);
      uniforms.uShadowMat.value.copy(m);
      uniforms.uShadowInfo.value.x = 1;
      lastCasters = swapped.length;
      lastHidden = 0;
      // ~0.9 m of depth bias.
      uniforms.uShadowInfo.value.z = 0.9 / (dist * 2 - 10);
      // Texel size in meters (normal offset).
      uniforms.uShadowInfo.value.w = extent * uniforms.uShadowInfo.value.y;
    },
    setSize(n) {
      alloc(n);
    },
    dispose() {
      rt?.dispose();
    },
    coverage(renderer) {
      if (!rt) return -1;
      const n = 64;
      const buf = new Uint8Array(n * n * 4);
      const x0 = Math.floor(rt.width / 2 - n / 2);
      renderer.readRenderTargetPixels(rt, x0, x0, n, n, buf);
      let c = 0;
      for (let i = 0; i < n * n; i++) if (buf[i * 4] > 128) c++;
      return c / (n * n);
    },
  };
}
