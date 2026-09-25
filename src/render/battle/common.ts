// FRONT ULTRA — ground battle: shared constants, uniforms and GLSL chunks (owner: battle).
//
// Every battle material shares ONE uniform set (sun, sky, aerial perspective, camera, local lights, heights) so
// the whole battlefield is lit and hazed consistently with the globe's own atmosphere model, and a single
// update per frame drives everything.
//
// Coordinates: every battle mesh lives under an anchor Group placed on the globe (radius 1 = sea level) and
// scaled meters -> world units. Local frame: +X = east, +Y = up, +Z = south, 1 unit = 1 m, y = displayed height
// above sea level (the globe's exaggerated relief + real local detail, minus the Earth-curvature drop).
//
// Depth "pull": every battle vertex is moved toward the camera along its own view ray (screen position unchanged,
// only depth). The battlefield therefore always wins the depth test against the coarser globe surface underneath
// it (no z-fighting, no globe poking through valleys), while its internal occlusion order is preserved because
// the pull is monotonic along each ray.

import * as THREE from 'three';
import { EARTH_RADIUS_KM, RELIEF_EXAGGERATION } from '../../shared/constants';

export const R_M = EARTH_RADIUS_KM * 1000;
export const M_PER_DEG = (R_M * Math.PI) / 180;
export const EXAG = RELIEF_EXAGGERATION;
export const MAX_LIGHTS = 12;
export const FRONT_SAMPLES = 32;

/** Fine (inner) terrain grid: where the battle is fought. */
export const FINE_RES = 257;
export const FINE_SIZE_M = 5120;
/** Coarse (outer ring) terrain grid. */
export const COARSE_RES = 201;
export const COARSE_SIZE_M = 16000;
/** Outermost ring (400 m cells) that carries the battlefield's ground out to ~36 km and melts into the globe. */
export const OUTER_RES = 181;
export const OUTER_SIZE_M = 72000;

export interface BattleUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunCol: THREE.IUniform<THREE.Vector3>;
  uSkyCol: THREE.IUniform<THREE.Vector3>;
  uGndCol: THREE.IUniform<THREE.Vector3>;
  uFogSun: THREE.IUniform<THREE.Vector3>;
  uFogAnti: THREE.IUniform<THREE.Vector3>;
  uFogTrans: THREE.IUniform<THREE.Vector3>;
  uFogRef: THREE.IUniform<number>;
  uSmoke: THREE.IUniform<THREE.Vector4>;
  uCamL: THREE.IUniform<THREE.Vector3>;
  uFade: THREE.IUniform<number>;
  uLights: THREE.IUniform<THREE.Vector4[]>;
  uLightCol: THREE.IUniform<THREE.Vector4[]>;
  uLightCount: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
  uHFine: THREE.IUniform<THREE.Texture | null>;
  uHCoarse: THREE.IUniform<THREE.Texture | null>;
  uFineInfo: THREE.IUniform<THREE.Vector4>;
  uCoarseInfo: THREE.IUniform<THREE.Vector4>;
  uFrontC: THREE.IUniform<THREE.Vector2>;
  uFrontT: THREE.IUniform<THREE.Vector2>;
  uFrontN: THREE.IUniform<THREE.Vector2>;
  uFrontO: THREE.IUniform<number[]>;
  uFrontL: THREE.IUniform<number>;
  uBelt: THREE.IUniform<number>;
  uUnitScale: THREE.IUniform<THREE.Vector4>;
  uSunW: THREE.IUniform<THREE.Vector3>;
  uHazeK: THREE.IUniform<number>;
  uShadowMap: THREE.IUniform<THREE.Texture | null>;
  uShadowMat: THREE.IUniform<THREE.Matrix4>;
  /** x = on, y = texel size (uv), z = depth bias (0..1 depth units), w = unused */
  uShadowInfo: THREE.IUniform<THREE.Vector4>;
  /** 1: fade sprites where they cut into the battlefield ground (near layer), 0: off (far layer). */
  uGroundSoft: THREE.IUniform<number>;
}

export function createBattleUniforms(): BattleUniforms {
  const lights: THREE.Vector4[] = [];
  const lcol: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_LIGHTS; i++) {
    lights.push(new THREE.Vector4());
    lcol.push(new THREE.Vector4());
  }
  const h = new THREE.DataTexture(new Float32Array(4), 2, 2, THREE.RedFormat, THREE.FloatType);
  h.needsUpdate = true;
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Vector3(2, 1.9, 1.7) },
    uSkyCol: { value: new THREE.Vector3(0.1, 0.15, 0.25) },
    uGndCol: { value: new THREE.Vector3(0.05, 0.05, 0.04) },
    uFogSun: { value: new THREE.Vector3() },
    uFogAnti: { value: new THREE.Vector3() },
    uFogTrans: { value: new THREE.Vector3(1, 1, 1) },
    uFogRef: { value: 8000 },
    // xy = battle centre (local m), z = radius (m), w = smoke density (1/m)
    uSmoke: { value: new THREE.Vector4(0, 0, 3000, 0) },
    uCamL: { value: new THREE.Vector3() },
    uFade: { value: 1 },
    uLights: { value: lights },
    uLightCol: { value: lcol },
    uLightCount: { value: 0 },
    uWind: { value: new THREE.Vector2(2.5, 0.8) },
    uHFine: { value: h },
    uHCoarse: { value: h },
    uFineInfo: { value: new THREE.Vector4(-FINE_SIZE_M / 2, -FINE_SIZE_M / 2, FINE_SIZE_M / (FINE_RES - 1), FINE_RES) },
    uCoarseInfo: { value: new THREE.Vector4(-COARSE_SIZE_M / 2, -COARSE_SIZE_M / 2, COARSE_SIZE_M / (COARSE_RES - 1), COARSE_RES) },
    uFrontC: { value: new THREE.Vector2() },
    uFrontT: { value: new THREE.Vector2(1, 0) },
    uFrontN: { value: new THREE.Vector2(0, 1) },
    uFrontO: { value: new Array<number>(FRONT_SAMPLES).fill(0) },
    uFrontL: { value: 6000 },
    uBelt: { value: 120 },
    // x = distance where unit exaggeration starts (m), y = max exaggeration, z = team-color boost start, w = end
    uUnitScale: { value: new THREE.Vector4(320, 3.2, 250, 1400) },
    uSunW: { value: new THREE.Vector3(1, 0, 0) },
    uHazeK: { value: 0.3 },
    uShadowMap: { value: null },
    uShadowMat: { value: new THREE.Matrix4() },
    uShadowInfo: { value: new THREE.Vector4(0, 1 / 2048, 0.0004, 0) },
    uGroundSoft: { value: 1 },
  };
}

/** Uniform declarations + helpers shared by every battle shader (vertex and fragment). */
export const GLSL_BATTLE_HEAD = /* glsl */ `
#define MAXL ${MAX_LIGHTS}
#define FRONT_N ${FRONT_SAMPLES}
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGndCol;
uniform vec3 uFogSun;
uniform vec3 uFogAnti;
uniform vec3 uFogTrans;
uniform float uFogRef;
uniform vec4 uSmoke;
uniform vec3 uCamL;
uniform float uFade;
uniform vec4 uLights[MAXL];
uniform vec4 uLightCol[MAXL];
uniform int uLightCount;
uniform vec2 uWind;
uniform vec2 uFrontC;
uniform vec2 uFrontT;
uniform vec2 uFrontN;
uniform float uFrontO[FRONT_N];
uniform float uFrontL;
uniform float uBelt;
uniform vec4 uUnitScale;

float bHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float bHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
// Along-front coordinate u and signed distance to the (meandering) contact line (> 0 on the defender side).
vec2 frontCoords(vec2 xz) {
  vec2 r = xz - uFrontC;
  float u = dot(r, uFrontT);
  float v = dot(r, uFrontN);
  float f = clamp((u + uFrontL) / (2.0 * uFrontL), 0.0, 1.0) * float(FRONT_N - 1);
  int i0 = int(floor(f));
  int i1 = min(i0 + 1, FRONT_N - 1);
  float o = mix(uFrontO[i0], uFrontO[i1], fract(f));
  return vec2(u, v - o);
}
`;

/** Vertex helpers: depth pull + height lookup on the battlefield grids (exact triangle interpolation). */
export const GLSL_BATTLE_HEIGHT = /* glsl */ `
uniform sampler2D uHFine;
uniform sampler2D uHCoarse;
uniform vec4 uFineInfo;
uniform vec4 uCoarseInfo;
float gridHeight(sampler2D tex, vec4 info, vec2 xz) {
  vec2 g = (xz - info.xy) / info.z;
  float n = info.w - 1.0;
  g = clamp(g, vec2(0.0), vec2(n - 0.001));
  vec2 c = floor(g);
  vec2 f = g - c;
  ivec2 ic = ivec2(c);
  // Grid row index = z (north->south), column = x. Texture x = column, y = row.
  float a = texelFetch(tex, ic, 0).r;
  float b = texelFetch(tex, ic + ivec2(1, 0), 0).r;
  float cc = texelFetch(tex, ic + ivec2(0, 1), 0).r;
  float d = texelFetch(tex, ic + ivec2(1, 1), 0).r;
  if (f.x + f.y <= 1.0) return a + (b - a) * f.x + (cc - a) * f.y;
  return d + (cc - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
}
float battleHeight(vec2 xz) {
  vec2 lf = xz - uFineInfo.xy;
  float sf = uFineInfo.z * (uFineInfo.w - 1.0);
  if (lf.x >= 0.0 && lf.y >= 0.0 && lf.x <= sf && lf.y <= sf) return gridHeight(uHFine, uFineInfo, xz);
  return gridHeight(uHCoarse, uCoarseInfo, xz);
}
`;

export const GLSL_BATTLE_VERT = /* glsl */ `
${GLSL_BATTLE_HEIGHT}
vec4 pullMV(vec4 mv) {
  float d = length(mv.xyz);
  // d is in world units; the model matrix scales meters -> units, so convert to meters.
  float dm = d * ${R_M.toFixed(1)};
  float pullM = min(dm * 0.5, 150.0) + dm * 0.02;
  mv.xyz *= (dm - pullM) / max(dm, 1e-3);
  return mv;
}
vec4 battleProject(vec3 p) {
#ifdef DEPTH_PASS
  return projectionMatrix * modelViewMatrix * vec4(p, 1.0);
#else
  return projectionMatrix * pullMV(modelViewMatrix * vec4(p, 1.0));
#endif
}
// Screen-size exaggeration of small units with distance (readable armies from altitude), 1 up close.
float unitExaggeration(vec3 p) {
  float d = length(p - uCamL);
  return clamp(d / uUnitScale.x, 1.0, uUnitScale.y);
}
`;

/**
 * Per-vertex aerial perspective with the globe's own single-scattering model (Rayleigh + Mie, Chapman light
 * depth; identical coefficients), integrated from the camera to the vertex in planet space. Used by the terrain so
 * its far rim matches the globe exactly. Output: vIns (already scaled by the sky gain and haze), vTrans.
 */
export const GLSL_BATTLE_ATMO = /* glsl */ `
uniform vec3 uSunW;
uniform float uHazeK;
#define B_ATM_TOP ${(1 + 95 / EARTH_RADIUS_KM).toFixed(8)}
#define B_HR ${(9 / EARTH_RADIUS_KM).toFixed(8)}
#define B_HM ${(1.6 / EARTH_RADIUS_KM).toFixed(8)}
const vec3 B_BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6) * 6.371e6;
const float B_BETA_M = 1.3e-5 * 6.371e6;
float bChapman(float X, float h, float cosZ) {
  float c = sqrt(X + h);
  if (cosZ >= 0.0) return c / (c * cosZ + 1.0) * exp(-h);
  float x0 = sqrt(max(0.0, 1.0 - cosZ * cosZ)) * (X + h);
  float c0 = sqrt(x0);
  return 2.0 * c0 * exp(min(X - x0, 60.0)) - c / (1.0 - c * cosZ) * exp(-h);
}
vec3 bSunTrans(vec3 p, vec3 L) {
  float r = length(p);
  float h = max(r - 1.0, 0.0);
  float cosZ = dot(p / r, L);
  float odR = B_HR * bChapman(1.0 / B_HR, h / B_HR, cosZ);
  float odM = B_HM * bChapman(1.0 / B_HM, h / B_HM, cosZ);
  return exp(-(B_BETA_R * odR + B_BETA_M * 1.1 * odM));
}
void battleAtmo(vec3 ro, vec3 target, vec3 L, out vec3 ins, out vec3 trans) {
  vec3 rd = target - ro;
  float tMax = length(rd);
  rd /= max(tMax, 1e-9);
  ins = vec3(0.0);
  trans = vec3(1.0);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - B_ATM_TOP * B_ATM_TOP;
  float disc = b * b - c;
  if (disc < 0.0) return;
  float sq = sqrt(disc);
  float t0 = max(-b - sq, 0.0);
  float t1 = min(-b + sq, tMax);
  if (t1 <= t0) return;
  const int NS = 5;
  float ds = (t1 - t0) / float(NS);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  for (int i = 0; i < NS; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float h = max(length(p) - 1.0, 0.0);
    float dR = exp(-h / B_HR) * ds;
    float dM = exp(-h / B_HM) * ds;
    odR += dR * 0.5; odM += dM * 0.5;
    vec3 tv = exp(-(B_BETA_R * odR + B_BETA_M * 1.1 * odM));
    vec3 ts = bSunTrans(p, L);
    sumR += dR * tv * ts;
    sumM += dM * tv * ts;
    odR += dR * 0.5; odM += dM * 0.5;
  }
  float mu = dot(rd, L);
  float g2 = 0.78 * 0.78;
  float pR = 0.0596831 * (1.0 + mu * mu);
  float pM = 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * 0.78 * mu, 1e-4), 1.5));
  ins = (sumR * B_BETA_R * pR + sumM * B_BETA_M * pM) * 7.5 * uHazeK;
  trans = pow(exp(-(B_BETA_R * odR + B_BETA_M * 1.1 * odM)), vec3(uHazeK));
}
// World position of a local battle point with its altitude brought back to real (un-exaggerated) scale, as the
// globe does for its haze (exaggerated relief must not poke out of the air).
vec3 battleAirPoint(vec3 localPos) {
  vec3 w = (modelMatrix * vec4(localPos, 1.0)).xyz;
  float r = length(w);
  return w / r * (1.0 + (r - 1.0) / ${EXAG.toFixed(1)});
}
`;

/** Fragment helpers: lighting, local lights, sun shadows, aerial perspective, fade dither. */
export const GLSL_BATTLE_FRAG = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMat;
uniform vec4 uShadowInfo;
float battleShadow(vec3 P, vec3 N, float biasK) {
  if (uShadowInfo.x < 0.5) return 1.0;
  // Normal offset + slope-scaled bias (the sun is often grazing at dawn and dusk).
  float ndl = clamp(dot(N, uSunDir), 0.05, 1.0);
  float slope = sqrt(1.0 - ndl * ndl) / ndl;
  vec3 Pn = P + N * uShadowInfo.w * (1.0 + slope * 0.5);
  vec4 sc = uShadowMat * vec4(Pn, 1.0);
  vec3 s = sc.xyz / sc.w * 0.5 + 0.5;
  vec2 e2 = (s.xy - 0.5) * 2.0;
  float edge = length(e2);
  if (edge >= 1.0 || s.z >= 1.0) return 1.0;
  float bias = uShadowInfo.z * biasK * (1.0 + min(slope, 8.0) * 0.6);
  float t = uShadowInfo.y;
  float sum = 0.0;
  sum += step(s.z - bias, texture2D(uShadowMap, s.xy).r);
  sum += step(s.z - bias, texture2D(uShadowMap, s.xy + vec2(-1.3, -0.6) * t).r);
  sum += step(s.z - bias, texture2D(uShadowMap, s.xy + vec2(0.6, -1.3) * t).r);
  sum += step(s.z - bias, texture2D(uShadowMap, s.xy + vec2(1.3, 0.6) * t).r);
  sum += step(s.z - bias, texture2D(uShadowMap, s.xy + vec2(-0.6, 1.3) * t).r);
  // Radial fade toward the edge of the map (no visible square boundary).
  return mix(sum / 5.0, 1.0, smoothstep(0.6, 0.98, edge));
}
vec3 battleLights(vec3 P, vec3 N) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < MAXL; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLights[i].xyz - P;
    float r2 = dot(d, d);
    float rad = uLightCol[i].w;
    float w = uLights[i].w / (1.0 + r2 / (rad * rad));
    float wrap = dot(N, d * inversesqrt(max(r2, 1e-4))) * 0.7 + 0.3;
    acc += uLightCol[i].rgb * w * max(wrap, 0.0);
  }
  return acc;
}
vec3 battleShade(vec3 albedo, vec3 N, vec3 P, float ao, float shadowK) {
  float ndl = max(dot(N, uSunDir), 0.0);
  float shadow = shadowK > 0.0 ? battleShadow(P, N, shadowK) : 1.0;
  vec3 amb = mix(uGndCol, uSkyCol, N.y * 0.5 + 0.5);
  return albedo * (uSunCol * ndl * shadow + amb * ao + battleLights(P, N));
}
vec3 battleSmoke(vec3 col, vec3 P) {
  // Battle smoke: extra haze along the part of the ray that crosses the smoky battle zone.
  vec3 v = P - uCamL;
  float d = length(v);
  vec2 hz = v.xz / max(length(v.xz), 1e-3);
  vec2 sh = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  float mu = dot(hz, sh) * 0.5 + 0.5;
  float inZone = 1.0 - smoothstep(uSmoke.z * 0.6, uSmoke.z, length(P.xz - uSmoke.xy));
  // The smoke is a ~250 m thick layer over the battlefield: the path through it is short when looking down.
  float path = min(min(d, 6000.0), 250.0 / max(abs(v.y) / max(d, 1.0), 0.04));
  float sm = 1.0 - exp(-uSmoke.w * path * inZone);
  vec3 smokeCol = mix(uFogAnti, uFogSun, mu * mu) * 0.6 + uSkyCol * 0.5;
  return mix(col, smokeCol, sm);
}
vec3 battleAir(vec3 col, vec3 P) {
  vec3 v = P - uCamL;
  float d = length(v);
  float k = d / uFogRef;
  vec3 tr = pow(max(uFogTrans, vec3(1e-4)), vec3(k));
  vec2 hz = v.xz / max(length(v.xz), 1e-3);
  vec2 sh = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  float mu = dot(hz, sh) * 0.5 + 0.5;
  vec3 insRef = mix(uFogAnti, uFogSun, mu * mu * mu);
  vec3 ins = insRef * (1.0 - tr) / max(vec3(1.0) - uFogTrans, vec3(1e-3));
  return battleSmoke(col * tr + ins, P);
}
void battleFadeDiscard() {
  if (uFade < 0.999) {
    float h = bHash12(floor(gl_FragCoord.xy));
    if (h > uFade) discard;
  }
}
`;

/** A GLSL rotation around Y. */
export const GLSL_ROT = /* glsl */ `
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
`;

/** Tail every battle fragment shader must end with (architecture §5.4). */
/** Fragment shader of every depth-only (shadow caster) variant. */
export const GLSL_DEPTH_FRAG = /* glsl */ `
void main() { gl_FragColor = vec4(1.0); }
`;

/** Depth-only twin of a battle material (same vertex shader and shared uniforms, DEPTH_PASS defined). */
export function depthVariant(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const d = new THREE.ShaderMaterial({
    vertexShader: m.vertexShader,
    fragmentShader: GLSL_DEPTH_FRAG,
    uniforms: m.uniforms,
    defines: { ...(m.defines ?? {}), DEPTH_PASS: 1 },
    side: THREE.DoubleSide,
  });
  d.name = `${m.name}-depth`;
  m.userData.depthMat = d;
  return d;
}

export const GLSL_TAIL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/** sRGB byte -> linear. */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(srgbToLinear((hex >> 16) & 255), srgbToLinear((hex >> 8) & 255), srgbToLinear(hex & 255));
}

/** Small fast deterministic PRNG for rendering (mulberry32). */
export class FastRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  gauss(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** 1D smooth value noise (deterministic) in [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    let t = Math.imul((n + seed * 7919) | 0, 0x27d4eb2d);
    t ^= t >>> 15;
    t = Math.imul(t, 0x2c1b3c6d);
    t ^= t >>> 12;
    return ((t >>> 0) / 4294967296) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}
