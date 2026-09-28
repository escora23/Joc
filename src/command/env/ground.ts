// FRONT ULTRA — command mode: the terrain material (owner: command).
// One splat material shades every streamed chunk (sand / grass / forest / rock / snow / urban / dirt / wet from the
// data layer's weights + the NASA regional tint + multi-scale world-space noise). Coarser levels take a mask of the
// finer level's built cells and discard their fragments there (stream.ts), so levels never overlap.
// The streamed ground itself (chunks, queries) lives in ../stream.ts.

import * as THREE from 'three';

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
  float vd = length(vViewPosition);
  float bh = texture2D(uNoise, bp * 0.11).b * 0.32 + texture2D(uNoise, bp * 1.7).g * 0.016 * (1.0 - smoothstep(6.0, 22.0, vd));
  float fade = 1.0 - smoothstep(40.0, 260.0, vd);
  bh *= fade;
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
  vec3 sand = mix(vec3(0.36, 0.285, 0.18), vec3(0.48, 0.39, 0.26), nB);
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
  // Broad patches (moisture / soil) + mid-scale mottling; the finest octave fades with distance so it never
  // turns into speckle.
  float dist = length(vViewPosition);
  float fineK = 1.0 - smoothstep(25.0, 140.0, dist);
  col *= 0.8 + nA * 0.32;
  col *= 0.86 + nC * 0.24 + (nD - 0.5) * 0.1 * fineK;
  // Pebbles and dry litter right around the vehicle.
  float pebble = texture2D(uNoise, wp * 2.3).g;
  col *= 1.0 + (pebble - 0.5) * 0.22 * (1.0 - smoothstep(8.0, 30.0, dist));
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

export interface TerrainMask {
  tex: THREE.Texture;
  /** Scene position of the mask's cell (0, 0) corner. */
  origin: THREE.Vector2;
  /** Cell size (m) of the finer level. */
  cell: { value: number };
  n: number;
}

export function createTerrainMaterial(noise: THREE.Texture, mask: TerrainMask | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const scorch = { value: 0 };
  mat.userData.scorch = scorch;
  if (mask) mat.userData.maskCell = mask.cell;
  const maskPars = mask ? `uniform sampler2D uMask;\nuniform vec2 uMaskOrigin;\nuniform float uMaskCell;\n` : '';
  const maskTest = mask
    ? `{
  vec2 mc = (vWPos.xz - uMaskOrigin) / uMaskCell;
  if (mc.x >= 0.0 && mc.y >= 0.0 && mc.x < ${mask.n.toFixed(1)} && mc.y < ${mask.n.toFixed(1)}) {
    if (texture2D(uMask, (floor(mc) + 0.5) / ${mask.n.toFixed(1)}).r > 0.5) discard;
  }
}
`
    : '';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: noise };
    shader.uniforms.uScorch = scorch;
    if (mask) {
      shader.uniforms.uMask = { value: mask.tex };
      shader.uniforms.uMaskOrigin = { value: mask.origin };
      shader.uniforms.uMaskCell = mask.cell;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERT_PARS}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSplatA = splatA; vSplatB = splatB; vTint = tint; vUp = normal.y;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}${maskPars}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${maskTest}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${TERRAIN_FRAG}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${TERRAIN_BUMP}`);
  };
  mat.customProgramCacheKey = () => (mask ? 'fu-cmd-terrain-masked' : 'fu-cmd-terrain');
  return mat;
}

export type { Ground } from '../stream';
