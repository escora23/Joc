// FRONT ULTRA — the unit/structure model shader (owner: units).
// One ShaderMaterial family for every instanced model on the globe:
//   * nation tint through the aMask.x paint mask and instanceColor (setColorAt with the nation color),
//   * sun lighting with the globe's terminator (dusk tint, planet shadow), sky ambient, fresnel rim,
//   * night lights (windows, runway lights, street grids) that switch on after sunset,
//   * engine heat glow, selection highlight pulse, "under construction" hologram (aH above the build line),
//   * ANCHORED: screen-space minimum size about a per-instance anchor (structures & city buildings), so the
//     structure stays readable from orbit with zero CPU work while the camera moves,
//   * CITY: procedural window grids on skyscraper facades (floors/columns per instance).
// Outputs linear HDR (post does tone mapping), ends with the tonemapping/colorspace chunks (ARCHITECTURE §5.4).

import * as THREE from 'three';
import { sharedUniforms } from './common';

export interface ModelMaterialOpts {
  anchored?: boolean;
  city?: boolean;
  ghost?: boolean;
  beacon?: boolean;
  /** Minimum on-screen size in px for anchored models (relative to the anchor's real size). */
  minPx?: number;
}

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec3 aMask;
attribute float aH;
attribute vec4 iParams;
#ifdef ANCHORED
attribute vec4 iAnchor;
uniform float uMinPx;
uniform float uMinPxScale;
#endif
uniform float uPixelK;
varying vec3 vColor;
varying vec3 vMask;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vUp;
varying vec4 vParams;
varying float vH;
varying vec3 vTeam;
#ifdef CITY
varying vec3 vLocal;
varying vec3 vLocalN;
varying float vSeed;
#endif

void main() {
  mat4 im = instanceMatrix;
  vec4 wp = modelMatrix * im * vec4(position, 1.0);
  mat3 m3 = mat3(modelMatrix) * mat3(im);
  vec3 inv = vec3(1.0 / max(dot(m3[0], m3[0]), 1e-30), 1.0 / max(dot(m3[1], m3[1]), 1e-30), 1.0 / max(dot(m3[2], m3[2]), 1e-30));
  vNormal = normalize(m3 * (normal * inv));
#ifdef ANCHORED
  float d = distance(cameraPosition, iAnchor.xyz);
  float s = max(1.0, uMinPx * uMinPxScale * uPixelK * d / max(iAnchor.w, 1e-9));
  wp.xyz = iAnchor.xyz + (wp.xyz - iAnchor.xyz) * s;
  vUp = normalize(iAnchor.xyz);
#else
  vUp = normalize((modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0)).xyz);
#endif
  vWorld = wp.xyz;
  vColor = aColor;
  vMask = aMask;
  vH = aH;
  vParams = iParams;
#ifdef USE_INSTANCING_COLOR
  vTeam = instanceColor;
#else
  vTeam = vec3(1.0);
#endif
#ifdef CITY
  vLocal = position;
  vLocalN = normal;
  vSeed = fract(sin(dot(im[3].xyz * 6371.0, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uTime;
uniform float uFade;
#ifdef GHOST
uniform vec3 uGhostColor;
#endif
varying vec3 vColor;
varying vec3 vMask;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vUp;
varying vec4 vParams;
varying float vH;
varying vec3 vTeam;
#ifdef CITY
varying vec3 vLocal;
varying vec3 vLocalN;
varying float vSeed;
#endif

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

#ifdef GHOST
  float scan = 0.55 + 0.45 * sin(vH * 60.0 - uTime * 7.0);
  vec3 g = uGhostColor * (0.35 + 1.6 * fres) * scan;
  gl_FragColor = vec4(g * 1.6, 0.55 + 0.3 * fres);
#else
  // LOD cross-fade with the icon layer (DESIGN_V2 §10.7): screen-door dissolve, no sorting needed.
  if (uFade < 0.999) {
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (n >= uFade) discard;
  }
  float built = vParams.x;
  float holo = 0.0;
  if (vH > built + 0.002) {
    if (fract(vH * 16.0 - uTime * 0.8) < 0.5) discard;
    holo = 1.0;
  }
  vec3 albedo = mix(vColor, vTeam * 0.85, vMask.x);
  float sunUp = dot(vUp, uSunDir);
  float dayK = smoothstep(-0.16, 0.14, sunUp);
  float geo = smoothstep(-0.07, 0.07, sunUp);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 sunCol = mix(vec3(1.0, 0.5, 0.26), vec3(1.0, 0.95, 0.88), smoothstep(0.0, 0.4, sunUp)) * 2.2;
  float upness = dot(N, vUp) * 0.5 + 0.5;
  vec3 amb = mix(vec3(0.02, 0.026, 0.045), vec3(0.17, 0.21, 0.3), dayK) * (0.45 + 0.55 * upness);
  float lights = vMask.y;
#ifdef CITY
  albedo = vColor * vTeam;
  // Facade windows: a floors x columns grid on side faces, a random subset lit at night.
  vec3 an = abs(vLocalN);
  if (an.y < 0.5) {
    float u = (an.x > an.z ? vLocal.z : vLocal.x) + 0.5;
    float v = vLocal.y;
    vec2 grid = vec2(u * vParams.w, v * vParams.z);
    vec2 cell = floor(grid);
    vec2 f = fract(grid);
    float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.78);
    float seed = hash12(cell + vec2(vSeed * 97.0, vSeed * 13.0));
    float lit = win * step(0.42, seed) * (0.6 + 0.8 * seed);
    // Anti-aliasing: when a window cell gets smaller than ~3 px, fade to its average (no sparkling moire).
    vec2 fw = fwidth(grid);
    float aa = clamp(1.6 - max(fw.x, fw.y) * 3.5, 0.0, 1.0);
    albedo = mix(albedo, albedo * 0.45 + vec3(0.05, 0.08, 0.12), mix(0.25, win * 0.8, aa));
    lights = mix(0.1, lit, aa);
  } else {
    albedo *= 0.8;
  }
#endif
  vec3 col = albedo * (sunCol * ndl * geo + amb);
  // Specular sheen (glass, metal decks) from the sun.
  vec3 H = normalize(uSunDir + V);
  col += sunCol * pow(max(dot(N, H), 0.0), 40.0) * 0.08 * geo;
  // Readability: nation-tinted rim, stronger at night.
  col += vTeam * fres * (0.12 + 0.35 * (1.0 - dayK)) * (0.25 + vMask.x);
  col += vTeam * vMask.x * 0.06 * (1.0 - dayK);
  // Night lights.
  float night = 1.0 - smoothstep(-0.12, 0.1, sunUp);
  float flick = 0.85 + 0.15 * sin(uTime * 3.0 + vWorld.x * 9000.0);
#ifndef CITY
  // Street lights / runway lights: sparkling points rather than flat emissive surfaces.
  float spark = hash12(floor(vWorld.xz * 16000.0) + floor(vWorld.y * 16000.0));
  lights *= 0.25 + 1.5 * step(0.7, spark);
#endif
  col += vec3(1.0, 0.78, 0.45) * lights * night * 3.0 * flick;
  col += vec3(1.0, 0.8, 0.5) * lights * (1.0 - night) * 0.05;
  // Engine / warning heat (always on).
  col += vec3(1.0, 0.45, 0.12) * vMask.z * 4.0;
  // Damage: charred & darker when hp is low.
  float dmg = 1.0 - clamp(vParams.z, 0.0, 1.0);
  col *= 1.0 - 0.55 * dmg;
  // Selection highlight.
  float pulse = 0.65 + 0.35 * sin(uTime * 5.0);
  col += vTeam * vParams.y * (0.25 + 1.4 * fres) * pulse;
  if (holo > 0.5) col = vTeam * (0.6 + 1.8 * fres) + vec3(0.1, 0.4, 0.6) * 0.4;
#ifdef BEACON
  col = vTeam * (0.55 + 0.35 * upness + 1.2 * fres) + vec3(0.08);
#endif
  gl_FragColor = vec4(col, 1.0);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createModelMaterial(o: ModelMaterialOpts = {}): THREE.ShaderMaterial {
  const defines: Record<string, string> = {};
  if (o.anchored) defines.ANCHORED = '';
  if (o.city) defines.CITY = '';
  if (o.ghost) defines.GHOST = '';
  if (o.beacon) defines.BEACON = '';
  const uniforms: Record<string, THREE.IUniform> = {
    uSunDir: sharedUniforms.uSunDir,
    uPixelK: sharedUniforms.uPixelK,
    uTime: sharedUniforms.uTime,
    uMinPx: { value: o.minPx ?? 24 },
    uMinPxScale: minPxScale,
    uFade: o.anchored || o.city || o.beacon ? structFade : unitFade,
  };
  if (o.ghost) uniforms.uGhostColor = { value: new THREE.Color(0.3, 1, 0.5) };
  const m = new THREE.ShaderMaterial({
    name: o.ghost ? 'unit-ghost' : o.city ? 'unit-city' : o.anchored ? 'unit-structure' : 'unit-model',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    defines,
    side: THREE.DoubleSide,
    transparent: !!o.ghost,
    depthWrite: !o.ghost,
    blending: o.ghost ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  return m;
}

/** Global multiplier for anchored minimum sizes (LOD: shrinks with altitude so orbit views stay clean). */
export const minPxScale = { value: 1 };
/** LOD cross-fade of unit models (1 = fully drawn, 0 = gone), set by the units renderer from the camera altitude. */
export const unitFade = { value: 1 };
/** LOD cross-fade of structure models. */
export const structFade = { value: 1 };
