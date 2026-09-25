// FRONT ULTRA — command mode: local terrain from the real Earth (owner: command).
// Two LocalHeightfields from the data layer (getLocalHeightfield): a detailed near patch where the fight happens
// and a coarse far ring to the horizon (its inner part sinks below the near patch). One splat material shades both
// (sand / grass / forest / rock / snow / urban / dirt / wet from the data layer's weights + the NASA regional tint
// + multi-scale world-space noise). Height queries are bilinear on the same grids the meshes use.

import * as THREE from 'three';
import type { LocalHeightfield } from '../../data/types';

const TERRAIN_VERT_PARS = /* glsl */ `
attribute vec4 splatA;
attribute vec4 splatB;
attribute vec3 tint;
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec3 vTint;
varying vec3 vWPos;
varying float vUp;
`;

const TERRAIN_FRAG_PARS = /* glsl */ `
uniform sampler2D uNoise;
uniform float uScorch;
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec3 vTint;
varying vec3 vWPos;
varying float vUp;
`;

const TERRAIN_BUMP = /* glsl */ `
{
  // Micro-relief: derivative bump mapping from multi-scale noise (ruts, clods, tussocks) in view space.
  vec2 bp = vWPos.xz;
  float bh = texture2D(uNoise, bp * 0.11).b * 0.55 + texture2D(uNoise, bp * 0.43).a * 0.3 + texture2D(uNoise, bp * 1.7).g * 0.12;
  float fade = 1.0 - smoothstep(60.0, 400.0, length(vViewPosition));
  bh *= 0.9 * fade;
  vec3 vp = -vViewPosition;
  vec3 dpdx = dFdx(vp);
  vec3 dpdy = dFdy(vp);
  float dhdx = dFdx(bh);
  float dhdy = dFdy(bh);
  vec3 r1 = cross(dpdy, normal);
  vec3 r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  normal = normalize(abs(det) * normal - grad);
}
`;

const TERRAIN_FRAG = /* glsl */ `
{
  vec2 wp = vWPos.xz;
  float nA = texture2D(uNoise, wp * 0.0019).r;
  float nB = texture2D(uNoise, wp * 0.016).g;
  float nC = texture2D(uNoise, wp * 0.11).b;
  float nD = texture2D(uNoise, wp * 0.73).a;
  float micro = nC * 0.55 + nD * 0.45;
  vec3 sand = mix(vec3(0.50, 0.40, 0.26), vec3(0.64, 0.54, 0.36), nB);
  vec3 grass = mix(vec3(0.105, 0.15, 0.045), vec3(0.25, 0.27, 0.09), smoothstep(0.25, 0.75, nB * 0.55 + nA * 0.45));
  grass = mix(grass, vec3(0.32, 0.29, 0.14), smoothstep(0.62, 0.8, nC) * 0.45);
  vec3 forest = mix(vec3(0.05, 0.08, 0.03), vec3(0.09, 0.12, 0.05), nC);
  vec3 rock = mix(vec3(0.24, 0.22, 0.20), vec3(0.42, 0.39, 0.35), smoothstep(0.2, 0.8, nB * 0.6 + nD * 0.4));
  vec3 snow = vec3(0.80, 0.84, 0.90);
  vec3 urban = mix(vec3(0.28, 0.27, 0.25), vec3(0.46, 0.43, 0.38), nC);
  vec3 dirt = mix(vec3(0.24, 0.18, 0.11), vec3(0.36, 0.28, 0.18), nB);
  vec3 wet = vec3(0.15, 0.13, 0.10);
  vec4 sa = vSplatA;
  vec4 sb = vSplatB;
  // Steep faces are rock regardless of land cover.
  float steep = smoothstep(0.62, 0.8, 1.0 - vUp);
  vec3 col = sand * sa.x + grass * sa.y + forest * sa.z + rock * sa.w + snow * sb.x + urban * sb.y + dirt * sb.z + wet * sb.w;
  col = mix(col, rock, steep);
  col *= 0.74 + micro * 0.5;
  vec3 tl = pow(vTint, vec3(2.2));
  float lt = dot(tl, vec3(0.299, 0.587, 0.114));
  float lc = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, tl * (lc / max(lt, 0.02)), 0.3);
  // War-torn ground: churned mud patches across the battlefield.
  float churn = smoothstep(0.7, 0.86, texture2D(uNoise, wp * 0.013 + 0.37).a) * smoothstep(0.45, 0.7, nB) * uScorch;
  col = mix(col, vec3(0.16, 0.125, 0.09) * (0.7 + micro * 0.6), churn * 0.55);
  diffuseColor.rgb = col;
}
`;

export function createTerrainMaterial(noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const scorch = { value: 0 };
  mat.userData.scorch = scorch;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: noise };
    shader.uniforms.uScorch = scorch;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERT_PARS}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSplatA = splatA; vSplatB = splatB; vTint = tint; vUp = normal.y;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${TERRAIN_FRAG}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${TERRAIN_BUMP}`);
  };
  mat.customProgramCacheKey = () => 'fu-cmd-terrain';
  return mat;
}

interface Patch {
  hf: LocalHeightfield;
  size: number;
  half: number;
  res: number;
}

export class Ground {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private near: Patch | null = null;
  private far: Patch | null = null;
  private nearMesh: THREE.Mesh | null = null;
  private farMesh: THREE.Mesh | null = null;
  /** Water depth (0..40 m -> 0..255) textures for the water shader: near + far. */
  depthNear: THREE.DataTexture;
  depthFar: THREE.DataTexture;

  constructor(material: THREE.MeshStandardMaterial) {
    this.material = material;
    this.group.name = 'cmd-ground';
    this.depthNear = mkDepth(2);
    this.depthFar = mkDepth(2);
  }

  get nearHalf(): number {
    return this.near?.half ?? 1000;
  }
  get farHalf(): number {
    return this.far?.half ?? 10000;
  }

  /** Placeholder mesh so the terrain program compiles during loading. */
  warmupMesh(): THREE.Mesh {
    const g = new THREE.PlaneGeometry(10, 10, 1, 1).rotateX(-Math.PI / 2);
    const n = g.attributes.position.count;
    g.setAttribute('splatA', new THREE.BufferAttribute(new Uint8Array(n * 4).fill(64), 4, true));
    g.setAttribute('splatB', new THREE.BufferAttribute(new Uint8Array(n * 4).fill(0), 4, true));
    g.setAttribute('tint', new THREE.BufferAttribute(new Uint8Array(n * 3).fill(128), 3, true));
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    return m;
  }

  build(near: LocalHeightfield, far: LocalHeightfield): void {
    this.clear();
    this.near = { hf: near, size: near.sizeKm * 1000, half: (near.sizeKm * 1000) / 2, res: near.resolution };
    this.far = { hf: far, size: far.sizeKm * 1000, half: (far.sizeKm * 1000) / 2, res: far.resolution };
    this.nearMesh = this.buildMesh(this.near, null);
    this.farMesh = this.buildMesh(this.far, this.near);
    this.nearMesh.receiveShadow = true;
    this.farMesh.receiveShadow = true;
    this.group.add(this.farMesh, this.nearMesh);
    this.depthNear.dispose();
    this.depthFar.dispose();
    this.depthNear = depthTexture(near);
    this.depthFar = depthTexture(far);
  }

  clear(): void {
    for (const m of [this.nearMesh, this.farMesh]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.nearMesh = this.farMesh = null;
  }

  private buildMesh(p: Patch, hole: Patch | null): THREE.Mesh {
    const { res, size, hf } = p;
    const g = new THREE.PlaneGeometry(size, size, res - 1, res - 1);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    const H = hf.heights;
    const cell = size / (res - 1);
    const holeIn = hole ? hole.half - cell * 1.5 : -1;
    for (let i = 0; i < res; i++) {
      for (let j = 0; j < res; j++) {
        const k = i * res + j;
        let h = H[k];
        if (h < -60) h = -60;
        if (hole) {
          const x = pos.getX(k), z = pos.getZ(k);
          if (Math.abs(x) < holeIn && Math.abs(z) < holeIn) h -= 40;
        }
        pos.setY(k, h);
        const hl = H[i * res + Math.max(0, j - 1)], hr = H[i * res + Math.min(res - 1, j + 1)];
        const hu = H[Math.max(0, i - 1) * res + j], hd = H[Math.min(res - 1, i + 1) * res + j];
        // x = east (j), z = south (i)
        const nx = -(hr - hl) / (2 * cell), nz = -(hd - hu) / (2 * cell);
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nrm.setXYZ(k, nx * inv, inv, nz * inv);
      }
    }
    g.deleteAttribute('uv');
    g.setAttribute('splatA', new THREE.BufferAttribute(hf.splatA, 4, true));
    g.setAttribute('splatB', new THREE.BufferAttribute(hf.splatB, 4, true));
    g.setAttribute('tint', new THREE.BufferAttribute(hf.tint, 3, true));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const m = new THREE.Mesh(g, this.material);
    m.name = hole ? 'terrain-far' : 'terrain-near';
    return m;
  }

  /** Terrain height (m ASL, may be < 0 under water) at local x (east), z (south). */
  heightAt(x: number, z: number): number {
    const n = this.near;
    if (n && Math.abs(x) < n.half && Math.abs(z) < n.half) return sample(n, x, z);
    const f = this.far;
    if (f) return sample(f, Math.max(-f.half, Math.min(f.half, x)), Math.max(-f.half, Math.min(f.half, z)));
    return 0;
  }

  /** Walkable surface: terrain or the sea surface (0). */
  surfaceAt(x: number, z: number): number {
    return Math.max(0, this.heightAt(x, z));
  }

  normalAt(x: number, z: number, out: THREE.Vector3, d = 2): THREE.Vector3 {
    const hl = this.heightAt(x - d, z), hr = this.heightAt(x + d, z);
    const hu = this.heightAt(x, z - d), hd = this.heightAt(x, z + d);
    return out.set(-(hr - hl) / (2 * d), 1, -(hd - hu) / (2 * d)).normalize();
  }

  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < 0.4;
  }
}

function sample(p: Patch, x: number, z: number): number {
  const r1 = p.res - 1;
  const fj = Math.max(0, Math.min(r1, (x / p.size + 0.5) * r1));
  const fi = Math.max(0, Math.min(r1, (z / p.size + 0.5) * r1));
  const j0 = Math.min(r1 - 1, Math.floor(fj)), i0 = Math.min(r1 - 1, Math.floor(fi));
  const tj = fj - j0, ti = fi - i0;
  const H = p.hf.heights, res = p.res;
  const a = H[i0 * res + j0], b = H[i0 * res + j0 + 1], c = H[(i0 + 1) * res + j0], d = H[(i0 + 1) * res + j0 + 1];
  // Match the mesh triangulation (PlaneGeometry splits each quad along the a-d diagonal? it uses a,b,d / b,c,d):
  // plain bilinear is within centimetres at our cell sizes.
  return a + (b - a) * tj + (c - a) * ti + (a - b - c + d) * tj * ti;
}

function mkDepth(n: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(n * n), n, n, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Row 0 = north = -z. Texture v = 0 at row 0 (flipY false): v = z / size + 0.5. */
function depthTexture(hf: LocalHeightfield): THREE.DataTexture {
  const res = hf.resolution;
  const t = mkDepth(res);
  const data = t.image.data as Uint8Array;
  for (let i = 0; i < res * res; i++) data[i] = Math.max(0, Math.min(255, Math.round((-hf.heights[i] / 40) * 255)));
  t.needsUpdate = true;
  return t;
}
