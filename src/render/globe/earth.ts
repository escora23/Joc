// FRONT ULTRA — photoreal Earth surface (owner: globe).
// One shader, two meshes:
//   * the global sphere (vertex-displaced by the real relief), and
//   * a camera-following lat/lon "near patch" (warped grid, denser at the target) that replaces the sphere
//     under the camera at low altitude, so the ground matches data.sampleElevation exactly up close.
// Shading: Blue Marble albedo, relief lighting from the topology-derived slope map (+ procedural detail up
// close), GGX ocean with sun glint, fresnel sky reflection and animated micro-normals, cloud shadows,
// night lights with a warm twilight band, aerial perspective (single scattering) and the territory overlay
// (DESIGN_V2 §10.1-10.4, §10.11): owner fills mixed into the ground by altitude, desaturated neutral land, smooth
// borders from a quadratic B-spline coverage of the owner grid (no 25 km staircase) with constant pixel widths,
// war-border cores, attacker-coloured conquest flashes, contested stripes, occupied stipple, ally hatch, rebel
// stripes, a readable night side, small-island shorelines, historical borders, fallout scars and the hover.
// In &mask=owner shots it writes the flat owner-id false colour instead (shared/shots.ts OWNER_MASK).

import * as THREE from 'three';
import { EARTH_RADIUS_KM, MAP_H, MAP_W, RELIEF_EXAGGERATION, TOPO_MAX_METERS } from '../../shared/constants';
import { HUMAN_ID } from '../../shared/constants';
import { OWNER_MASK } from '../../shared/shots';
import { GLSL_ATMOSPHERE, GLSL_COLOR, GLSL_CONSTANTS, GLSL_GEO, GLSL_NOISE, GLSL_TERRITORY_FILL } from './glsl';
import {
  MAX_SCARS, OWN_ISLAND, OWN_OCCUPIED, OWN_PLAYABLE, OWN_WATER, PAL_ALLY, PAL_ALIVE, PAL_HUMAN, PAL_INDEP, PAL_REBEL,
  PAL_TRAITOR, type TerritoryLayer,
} from './territory';
import { SLOPE_RANGE, type PlanetTextures } from './textures';

export interface PlanetUniforms {
  uSunDir: { value: THREE.Vector3 };
  uSunE: { value: number };
  uSkyE: { value: number };
  uTime: { value: number };
  uCloudOffset: { value: THREE.Vector2 };
  uCloudShadow: { value: number };
  uNormalBoost: { value: number };
  uNightE: { value: number };
  uHaze: { value: number };
  /** Territory look by camera altitude (set by the globe every frame, DESIGN_V2 §10.1-10.4). */
  uFill: { value: number };
  uNeutralK: { value: number };
  uNightFloor: { value: number };
  uBorderNoise: { value: number };
  uShoreK: { value: number };
  uCloseK: { value: number };
  /** Cloud thinning factors (human land, other land, ocean, fronts) for the current mode and altitude (§10.5). */
  uCloudK: { value: THREE.Vector4 };
  /** 1 in &mask=owner shots. */
  uMaskMode: { value: number };
  /** 1 during the spawn phase: free land glows with a slow pulse (§10.13). */
  uSpawn: { value: number };
}

export function createPlanetUniforms(): PlanetUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSunE: { value: 1.9 },
    uSkyE: { value: 7.5 },
    uTime: { value: 0 },
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudShadow: { value: 1 },
    uNormalBoost: { value: 2.5 },
    uNightE: { value: 4.0 },
    uHaze: { value: 1.0 },
    uFill: { value: 0.5 },
    uNeutralK: { value: 1 },
    uNightFloor: { value: 0.22 },
    uBorderNoise: { value: 0 },
    uShoreK: { value: 1 },
    uCloseK: { value: 0 },
    uCloudK: { value: new THREE.Vector4(1, 1, 1, 1) },
    uMaskMode: { value: 0 },
    uSpawn: { value: 0 },
  };
}

/**
 * Cloud thinning (DESIGN_V2 §10.5) from the cloud mask texel (R human land, G front heat, B land) and the factors
 * (x human land, y other land, z ocean, w fronts). Shared by the cloud layer and the cloud shadows on the ground.
 */
export const GLSL_CLOUD_THIN = /* glsl */ `
float cloudThin(vec4 m, vec4 k) {
  float landF = mix(k.y, k.x, m.r);
  landF = mix(landF, k.w, smoothstep(0.08, 0.35, m.g));
  return mix(k.z, landF, smoothstep(0.02, 0.45, m.b));
}
`;

const vert = /* glsl */ `
${GLSL_CONSTANTS}
${GLSL_GEO}
${GLSL_ATMOSPHERE}
uniform sampler2D uRelief;
uniform float uReliefScale;
uniform vec3 uSunDir;
uniform float uHaze;
varying vec3 vIns;
varying vec3 vTrans;
varying vec3 vSunT;
#ifdef PATCH
uniform vec4 uPatch;
uniform float uPatchWarp;
#endif
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vDir;
void main() {
#ifdef PATCH
  vec2 g = position.xy;
  g = g * (uPatchWarp + (1.0 - uPatchWarp) * abs(g));
  float lat = clamp(uPatch.x + g.y * uPatch.z, -1.5, 1.5);
  float lon = uPatch.y + g.x * uPatch.w;
  vec3 dir = latLonDir(lat, lon);
  vec2 tuv = vec2(lon / TAU + 0.5, lat / PI + 0.5);
#else
  vec3 dir = normalize(position);
  vec2 tuv = uv;
#endif
  float hg = textureLod(uRelief, vec2(tuv.x, 1.0 - tuv.y), 0.0).a;
  vec3 wp = (modelMatrix * vec4(dir * (1.0 + hg * uReliefScale), 1.0)).xyz;
  vUv = tuv;
  vDir = dir;
  vWorld = wp;
  vec3 L = normalize(uSunDir);
  // Sunlight color at the ground (reddened near the terminator), per vertex.
  vSunT = sunTransmittance(dir * 1.0005, L);
#if ATM_Q >= 1
  // Aerial perspective per vertex (smooth quantity; far cheaper than per pixel). Haze is integrated to the point
  // at its REAL (un-exaggerated) altitude so exaggerated peaks do not poke out of the air and look dark.
  vec3 pAir = dir * (1.0 + hg * uReliefScale / ${RELIEF_EXAGGERATION.toFixed(1)});
  vec3 toAir = pAir - cameraPosition;
  float dAir = length(toAir);
  atmosphere(cameraPosition, toAir / dAir, dAir, L, vIns, vTrans);
  // Thinner aerial perspective near the ground keeps close-up terrain readable.
  vIns *= uHaze;
  vTrans = pow(vTrans, vec3(uHaze));
#else
  vIns = vec3(0.0);
  vTrans = vec3(1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const frag = /* glsl */ `
${GLSL_CONSTANTS}
${GLSL_NOISE}
${GLSL_GEO}
${GLSL_ATMOSPHERE}
${GLSL_COLOR}
${GLSL_TERRITORY_FILL}
${GLSL_CLOUD_THIN}
#define SLOPE_RANGE ${SLOPE_RANGE.toFixed(1)}
#define MAX_SCARS ${MAX_SCARS}
#define HUMAN_ID ${HUMAN_ID}
#define OWN_WATER ${OWN_WATER}
#define OWN_ISLAND ${OWN_ISLAND}
#define OWN_OCCUPIED ${OWN_OCCUPIED}
#define OWN_PLAYABLE ${OWN_PLAYABLE}
#define PAL_HUMAN ${PAL_HUMAN}
#define PAL_ALLY ${PAL_ALLY}
#define PAL_TRAITOR ${PAL_TRAITOR}
#define PAL_ALIVE ${PAL_ALIVE}
#define PAL_INDEP ${PAL_INDEP}
#define PAL_REBEL ${PAL_REBEL}
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uRelief;
uniform sampler2D uWater;
uniform sampler2D uClouds;
uniform sampler2D uOwner;
uniform sampler2D uPalette;
uniform sampler2D uHeat;
uniform sampler2D uWarPairs;
uniform sampler2D uCountry;
uniform sampler2D uCloudMask;
uniform vec3 uSunDir;
uniform float uSunE;
uniform float uSkyE;
uniform float uTime;
uniform vec2 uCloudOffset;
uniform float uCloudShadow;
uniform float uNormalBoost;
uniform float uNightE;
uniform float uFlashNow;
uniform float uHoverOwner;
uniform float uHoverAmt;
uniform float uTerritoryOpacity;
uniform float uHistorical;
uniform float uFill;
uniform float uNeutralK;
uniform float uNightFloor;
uniform float uBorderNoise;
uniform float uShoreK;
uniform float uCloseK;
uniform vec4 uCloudK;
uniform float uMaskMode;
uniform float uSpawn;
uniform vec4 uScars[MAX_SCARS];
uniform int uScarCount;
uniform vec4 uPatchCut;
uniform float uPatchActive;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vDir;
varying vec3 vIns;
varying vec3 vTrans;
varying vec3 vSunT;

vec2 decodeSlope(vec2 e) {
  e = e * 2.0 - 1.0;
  return sign(e) * e * e * SLOPE_RANGE;
}

// Owner texel: id (11 bits), flags (G bits 3-7) and the conquest-flash stamp (1/32 s units).
void ownerTexel(ivec2 p, out int id, out int flags, out float stamp) {
  p.x = p.x - ${MAP_W} * int(floor(float(p.x) / ${MAP_W}.0));
  p.y = clamp(p.y, 0, ${MAP_H - 1});
  vec4 t = texelFetch(uOwner, p, 0);
  int g = int(t.g * 255.0 + 0.5);
  id = int(t.r * 255.0 + 0.5) + (g & 7) * 256;
  flags = g & 248;
  stamp = floor(t.b * 255.0 + 0.5) + floor(t.a * 255.0 + 0.5) * 256.0;
}

vec4 paletteAt(int id) { return texelFetch(uPalette, ivec2(id, 0), 0); }
bool atWarPair(int a, int b) { return texelFetch(uWarPairs, ivec2(a & 511, b & 511), 0).r > 0.5; }
int countryAt(ivec2 p) {
  p.x = p.x - ${MAP_W} * int(floor(float(p.x) / ${MAP_W}.0));
  p.y = clamp(p.y, 0, ${MAP_H - 1});
  vec4 t = texelFetch(uCountry, p, 0);
  return int(t.r * 255.0 + 0.5) + int(t.g * 255.0 + 0.5) * 256;
}
// Pixel-footprint overlap of [s - 0.5, s + 0.5] with the band [a, b] (box-filtered line coverage).
float bandCov(float s, float a, float b) { return clamp(min(s + 0.5, b) - max(s - 0.5, a), 0.0, 1.0); }

// Soft cast shadows from the relief: march the heightmap toward the sun (curvature-aware). Mountain ranges
// throw long shadows at low sun angles, from orbit down to the ground.
#define SHADOW_EXAG 7.0
#define EARTH_M 6371000.0
float reliefShadow(vec2 uv, vec3 up, vec3 east, vec3 north, vec3 L, float h0, float lat) {
  vec2 dirT = vec2(dot(L, east), dot(L, north));
  float horiz = length(dirT);
  if (horiz < 1e-4) return 1.0;
  dirT /= horiz;
  float tanE = dot(L, up) / horiz;
  vec2 k = vec2(dirT.x / (TAU * EARTH_M * max(cos(lat), 0.05)), dirT.y / (PI * EARTH_M));
  float sh = 1.0;
  float dist = 3000.0;
  for (int i = 0; i < RELIEF_SHADOW_STEPS; i++) {
    vec2 suv = uv + k * dist;
    float lod = clamp(log2(dist / 20000.0) + 1.0, 0.0, 4.0);
    float hs = textureLod(uRelief, vec2(suv.x, 1.0 - suv.y), lod).a * TOPO_MAX;
    float margin = (h0 - hs) * SHADOW_EXAG + dist * tanE + dist * dist / (2.0 * EARTH_M);
    sh = min(sh, smoothstep(-0.02, 0.02, margin / dist));
    dist *= 1.45;
  }
  return sh;
}

void main() {
  vec3 up = normalize(vDir);
  vec3 east, north;
  tangentBasis(up, east, north);
  float lat = asin(clamp(up.y, -1.0, 1.0));
  float lon = atan(-up.z, up.x);

#ifndef PATCH
  if (uPatchActive > 0.5) {
    float dl = lon - uPatchCut.y;
    dl -= TAU * floor((dl + PI) / TAU);
    if (abs(lat - uPatchCut.x) < uPatchCut.z && abs(dl) < uPatchCut.w) discard;
  }
#endif

  vec2 uv = vUv;
  vec2 uvT = vec2(uv.x, 1.0 - uv.y);
  vec3 camVec = cameraPosition - vWorld;
  float dist = length(camVec);
  vec3 V = camVec / dist;
  vec3 L = normalize(uSunDir);
  float muS = dot(up, L);
  float pxWorld = length(fwidth(vWorld));

  // --- base maps -------------------------------------------------------------------------------
  vec3 albedo = texture2D(uDay, uv).rgb;
  float water = smoothstep(0.3, 0.7, texture2D(uWater, uv).r);
  vec4 rel = texture2D(uRelief, uvT);
  float elevM = rel.a * TOPO_MAX;
  float rugged = rel.b;

  // --- relief normal ---------------------------------------------------------------------------
  vec2 slope = decodeSlope(rel.xy) * uNormalBoost * (1.0 - water * 0.9);
  float closeK = smoothstep(0.09, 0.012, dist);
  if (closeK > 0.0 && water < 0.99) {
    float landK = closeK * (1.0 - water);
    // The 10 km albedo reads murky up close: lift and saturate it a little.
    float la0 = luma(albedo);
    albedo = mix(albedo, max(mix(vec3(la0), albedo, 1.25), 0.0) * 1.2, landK);
    // Ridged detail (sharp eroded crests) whose amplitude follows the real local ruggedness.
    vec3 g = vec3(0.0);
    vec3 dacc = vec3(0.0);
    float hd = 0.5, a = 0.5, fr = 1.0;
    vec3 p = vWorld * 420.0;
    // Erosion-style fbm: octaves are damped where the accumulated slope is steep, which leaves smooth
    // valleys and sharp crests. Rotated per octave so the value-noise lattice never lines up.
    const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    mat3 M = mat3(1.0);
    for (int i = 0; i < 8; i++) {
      // Stop before an octave gets smaller than ~3 pixels (no shimmering).
      if (1.0 / (420.0 * fr) < 3.0 * pxWorld) break;
      vec4 n = noised(M * p * fr + float(i) * 17.0);
      vec3 gp = fr * (transpose(M) * n.yzw);
      gp -= up * dot(gp, up);
      dacc += gp * a;
      float att = 1.0 / (1.0 + dot(dacc, dacc) * 0.6);
      hd += a * n.x * att * 0.5;
      g += a * gp * att;
      fr *= 2.02;
      a *= 0.5;
      M = ROT * M;
    }
    float amp = landK * (0.004 + 0.28 * rugged * rugged + 0.03 * rugged);
    slope += vec2(dot(g, east), dot(g, north)) * amp;
    float sl = length(slope);
    if (sl > 1.1) slope *= 1.1 / sl;
    float n2 = fbm3(vWorld * 2600.0);
    float fineK = clamp((1.0 / 21000.0) / max(pxWorld, 1e-9) / 3.0 - 1.0, 0.0, 1.0);
    float n3 = fineK > 0.0 ? fbm3(vWorld * 21000.0) * fineK : 0.0;
    albedo *= 1.0 + landK * (0.16 * n2 + 0.12 * n3 + 0.14 * (hd - 0.45));
    // Land-use patchwork on gentle ground (DESIGN_V2 §10.11): fields, pasture, ploughed and wooded plots of ~1.2 km
    // with darker hedgerows between them. The NASA albedo is ~1 km per texel, so without it the ground below 50 km
    // reads as a flat wash of colour. Irregular polygons: 3D cells cut by the sphere, edges wobbled by noise.
    float fieldK = landK * (1.0 - smoothstep(0.2, 0.55, rugged)) * (1.0 - smoothstep(0.3, 0.5, luma(albedo)))
                 * (1.0 - smoothstep(2400.0, 3400.0, elevM)) * clamp((1.0 / 5200.0) / max(pxWorld, 1e-9) / 6.0 - 1.0, 0.0, 1.0);
    if (fieldK > 0.001) {
      vec3 q = vWorld * 5200.0 + vec3(fbm3(vWorld * 1700.0), fbm3(vWorld * 1700.0 + 7.3), 0.0) * 0.45;
      vec3 cell = floor(q);
      float hv = hash13(cell), hv2 = hash13(cell + 17.0);
      vec3 f = fract(q);
      vec3 e3 = min(f, 1.0 - f);
      float edge = min(e3.x, min(e3.y, e3.z));
      float hedge = 1.0 - smoothstep(0.0, 0.05 + 2.0 * pxWorld * 5200.0, edge);
      vec3 fcol = hv < 0.3 ? albedo * vec3(1.2, 1.12, 0.82) : hv < 0.58 ? albedo * vec3(0.8, 1.0, 0.72)
                : hv < 0.8 ? albedo * vec3(0.78, 0.7, 0.62) : albedo * vec3(0.55, 0.68, 0.5);
      albedo = mix(albedo, fcol, fieldK * (0.6 + 0.3 * hv2));
      // Plots inside a field (~400 m strips) and the hedgerows between fields.
      vec3 q2 = q * 3.0;
      float hv3 = hash13(floor(q2) + cell * 3.0);
      albedo *= 1.0 + fieldK * 0.12 * (hv3 - 0.5);
      albedo = mix(albedo, albedo * vec3(0.55, 0.66, 0.5), hedge * fieldK * 0.7);
    }
    // Woods and scrub: dark irregular stands at ~400 m-2 km on vegetated ground, denser on hills (fields take the
    // flat land), so hilly country below 50 km is not a uniform blur either.
    float greenK = smoothstep(0.95, 1.25, albedo.g / max(albedo.r, 1e-3));
    float woodFade = clamp((1.0 / 9000.0) / max(pxWorld, 1e-9) / 4.0 - 1.0, 0.0, 1.0);
    if (woodFade > 0.001 && greenK > 0.001) {
      float wn = fbm3(vWorld * 9000.0 + 3.1) + 0.35 * fbm3(vWorld * 2300.0 - 1.7);
      float wood = smoothstep(0.02, 0.16, wn - 0.12 + 0.25 * rugged);
      albedo = mix(albedo, albedo * vec3(0.5, 0.62, 0.45), wood * greenK * woodFade * landK * 0.85);
    }
    // Rock on steep ground, snow on the high crests (the 10 km albedo is too soft this close).
    float steep = clamp(length(slope) * 1.1, 0.0, 1.0);
    albedo = mix(albedo, vec3(0.19, 0.175, 0.16), landK * steep * 0.45);
    float snow = smoothstep(3000.0, 4200.0, elevM + (hd - 0.4) * 900.0) * (1.0 - steep * 0.7);
    albedo = mix(albedo, vec3(0.8, 0.83, 0.88), snow * landK * 0.75);
    // Crevasses and gullies stay darker on rugged ground (reads as rock through the snow).
    albedo *= mix(1.0, clamp(0.6 + 0.8 * hd, 0.55, 1.1), landK * rugged);
  }
  vec3 N = normalize(up - east * slope.x - north * slope.y);

  // --- territory -------------------------------------------------------------------------------
  // Owner coverage from a cubic B-spline over the 4x4 nearest owner texels, land texels only (coasts follow the
  // real coastline and never get a border). The winner O and the runner-up Q decide the fill; their coverage
  // difference f = cO - cQ is zero on the border and its analytic gradient gives the distance in pixels, so corners
  // round off and the 25 km staircase disappears at every altitude (DESIGN_V2 §10.3).
  vec3 emissive = vec3(0.0);
  float terr = uTerritoryOpacity;
  float landK = 1.0 - water;
  int O = 0, Q = -1;
  float distPx = 1e4, distT = 1e4;
  float occ = 0.0, flash = 0.0, isl = 0.0, landCov = 1.0, shorePx = 1e4;
  bool playableHere = water < 0.5;
  vec2 tp0 = vec2(uv.x * ${MAP_W}.0, uvT.y * ${MAP_H}.0);
  vec2 tp = tp0;
  float pxT = 1.0;
  if (terr > 0.001 || uMaskMode > 0.5) {
    if (uBorderNoise > 0.0) {
      // A real border wanders: a few km of noise up close, none from orbit.
      vec3 q = vWorld * 1300.0;
      tp += uBorderNoise * vec2(vnoise(q) + 0.5 * vnoise(q * 2.3 + 7.1), vnoise(q + 19.3) + 0.5 * vnoise(q * 2.3 + 3.7));
    }
    vec2 x = tp - 0.5;
    vec2 dxdX = dFdx(x), dxdY = dFdy(x);
    pxT = max(length(vec2(dxdX.x, dxdY.x)), length(vec2(dxdX.y, dxdY.y)));
    vec2 i0 = floor(x);
    vec2 u = x - i0;
    ivec2 c = ivec2(i0);
    // Cubic B-spline weights (texels i0-1 .. i0+2) and their derivatives.
    vec2 u2 = u * u, u3 = u2 * u, v = 1.0 - u;
    vec4 wx = vec4(v.x * v.x * v.x, 3.0 * u3.x - 6.0 * u2.x + 4.0, -3.0 * u3.x + 3.0 * u2.x + 3.0 * u.x + 1.0, u3.x) / 6.0;
    vec4 wy = vec4(v.y * v.y * v.y, 3.0 * u3.y - 6.0 * u2.y + 4.0, -3.0 * u3.y + 3.0 * u2.y + 3.0 * u.y + 1.0, u3.y) / 6.0;
    vec4 dwx = vec4(-v.x * v.x, 3.0 * u2.x - 4.0 * u.x, -3.0 * u2.x + 2.0 * u.x + 1.0, u2.x) * 0.5;
    vec4 dwy = vec4(-v.y * v.y, 3.0 * u2.y - 4.0 * u.y, -3.0 * u2.y + 2.0 * u.y + 1.0, u2.y) * 0.5;
    int ids[16];
    float W[16];
    vec2 G[16];
    vec2 FO[16];
    float Lsum = 0.0;
    vec2 dL = vec2(0.0);
    int nearK = (u.x < 0.5 ? 1 : 2) + (u.y < 0.5 ? 1 : 2) * 4;
    for (int j = 0; j < 4; j++) {
      for (int i = 0; i < 4; i++) {
        int k = j * 4 + i;
        int id, fl;
        float st;
        ownerTexel(c + ivec2(i - 1, j - 1), id, fl, st);
        bool land = (fl & OWN_WATER) == 0;
        float w = land ? wx[i] * wy[j] : 0.0;
        vec2 g = land ? vec2(dwx[i] * wy[j], wx[i] * dwy[j]) : vec2(0.0);
        ids[k] = land ? id : -1;
        W[k] = w;
        G[k] = g;
        Lsum += w;
        dL += g;
        if ((fl & OWN_ISLAND) != 0 && i > 0 && i < 3 && j > 0 && j < 3) isl = 1.0;
        if (k == nearK) playableHere = (fl & OWN_PLAYABLE) != 0;
        // Conquest flash: full at capture, gone 2 real seconds later.
        float age = mod(uFlashNow - st, 65536.0) / 32.0;
        float fk = age < 2.0 ? (1.0 - age * 0.5) * (1.0 - age * 0.5) : 0.0;
        FO[k] = vec2(fk, (fl & OWN_OCCUPIED) != 0 ? 1.0 : 0.0);
      }
    }
    landCov = Lsum;
    if (Lsum > 1e-4) {
      // Candidates: the 2x2 texels around the fragment, then any other owner in the 4x4 as runner-up.
      int cand[4];
      cand[0] = ids[nearK]; cand[1] = ids[5]; cand[2] = ids[6]; cand[3] = ids[9];
      int cand4 = ids[10];
      float bestC = -1.0, secondC = -1.0;
      vec2 bestG = vec2(0.0), secondG = vec2(0.0);
      int best = -1, second = -1;
      for (int a = 0; a < 5; a++) {
        int A = a < 4 ? cand[a] : cand4;
        if (A < 0 || A == best || A == second) continue;
        float S = 0.0;
        vec2 dS = vec2(0.0);
        for (int k = 0; k < 16; k++) {
          if (ids[k] == A) { S += W[k]; dS += G[k]; }
        }
        float cA = S / Lsum;
        vec2 gA = (dS * Lsum - S * dL) / (Lsum * Lsum);
        if (cA > bestC) {
          second = best; secondC = bestC; secondG = bestG;
          best = A; bestC = cA; bestG = gA;
        } else if (cA > secondC) {
          second = A; secondC = cA; secondG = gA;
        }
      }
      for (int k = 0; k < 16; k++) {
        int A = ids[k];
        if (A < 0 || A == best || A == second) continue;
        float S = 0.0;
        vec2 dS = vec2(0.0);
        for (int m = 0; m < 16; m++) {
          if (ids[m] == A) { S += W[m]; dS += G[m]; }
        }
        float cA = S / Lsum;
        if (cA > secondC) {
          second = A; secondC = cA; secondG = (dS * Lsum - S * dL) / (Lsum * Lsum);
        }
      }
      O = max(best, 0);
      if (second >= 0) {
        Q = second;
        float fd = bestC - secondC;
        vec2 gf = bestG - secondG;
        float gl = length(vec2(dot(gf, dxdX), dot(gf, dxdY)));
        distPx = gl > 1e-6 ? fd / gl : 1e4;
        float glT = length(gf);
        distT = glT > 1e-6 ? fd / glT : 1e4;
      }
      // Flash and occupation averaged over O's texels with the same weights: soft, never square.
      float so = 0.0;
      for (int k = 0; k < 16; k++) {
        if (ids[k] == O) {
          so += W[k];
          flash += W[k] * FO[k].x;
          occ += W[k] * FO[k].y;
        }
      }
      if (so > 1e-5) {
        flash /= so;
        occ /= so;
      }
    }
    // Land coverage isoline: the rounded outline of small islands (white shoreline from orbit, §10.6). The 0.3 level
    // keeps single-tile islands (peak 0.44 with the cubic kernel) and sits just off the coast of larger ones.
    float glS = length(vec2(dot(dL, dxdX), dot(dL, dxdY)));
    shorePx = glS > 1e-6 ? (landCov - 0.3) / glS : 1e4;
  }

  // Line layers composited after lighting (borders stay emissive by day and by night, §10.4).
  vec3 lineCol = vec3(0.0);
  float lineCov = 0.0, coreCov = 0.0, outlineCov = 0.0, shoreCov = 0.0, histCov = 0.0;
  vec3 nightFill = vec3(0.0);
  if (terr > 0.001 && uMaskMode < 0.5) {
    // Fallout scars (also over unowned land).
    float scar = 0.0, scarRim = 0.0;
    for (int i = 0; i < MAX_SCARS; i++) {
      if (i >= uScarCount) break;
      vec4 s = uScars[i];
      float dx = tp0.x - s.x;
      dx -= ${MAP_W}.0 * floor((dx + ${MAP_W / 2}.0) / ${MAP_W}.0);
      float dy = tp0.y - s.y;
      float dd = length(vec2(dx * cos(lat), dy)) / s.z;
      float wob = 0.12 * fbm3(vec3(dx, dy, float(i) * 7.0) * 0.35);
      scar = max(scar, s.w * (1.0 - smoothstep(0.45, 1.0, dd + wob)));
      scarRim = max(scarRim, s.w * (exp(-pow((dd + wob - 0.9) * 7.0, 2.0)) * 0.5 + exp(-pow((dd + wob * 0.6 - 0.32) * 11.0, 2.0))));
    }
    if (scar > 0.0 || scarRim > 0.0) {
      float landS = 1.0 - water * 0.75;
      albedo = mix(albedo, vec3(0.022, 0.026, 0.016), 0.85 * scar * terr * landS);
      float pulse = 0.8 + 0.2 * sin(uTime * 2.1);
      float n = 0.5 + 0.5 * fbm3(vec3(tp0 * 0.9, uTime * 0.12));
      float specks = pow(n, 9.0) * 3.0;
      vec3 toxic = vec3(0.42, 1.0, 0.1);
      emissive += toxic * (scar * (0.012 + 0.05 * n * n + specks * 0.35) + scarRim * 0.3) * pulse * terr * landS;
    }

    float heat = texture2D(uHeat, uvT).r;
    vec3 natO = vec3(0.5);
    int flagsO = 0;
    float hoverO = 0.0;
    if (O > 0) {
      vec4 pal = paletteAt(O);
      flagsO = int(pal.a * 255.0 + 0.5);
      natO = srgbToLinear(pal.rgb);
      bool isHuman = (flagsO & PAL_HUMAN) != 0;
      bool alive = (flagsO & PAL_ALIVE) != 0;
      hoverO = abs(float(O) - uHoverOwner) < 0.5 ? uHoverAmt : 0.0;
      float fillA = (uFill + (isHuman ? 0.05 : 0.0) + 0.08 * hoverO) * (alive ? 1.0 : 0.5);
      // Occupied land: a dot stipple in the owner's colour over 70 % fill (§10.1).
      fillA *= mix(1.0, 0.7, occ);
      // Every nation reads against its ground (§16.3: ΔE >= 15 from orbit); up close (uCloseK) the ground detail must
      // read through the fill, so the floor drops.
      fillA = max(fillA, territoryMinFill(albedo, natO, mix(0.14, 0.07, uCloseK)) * (alive ? 1.0 : 0.6));
      fillA *= terr * landK;
      vec3 ground = albedo;
      albedo = territoryFill(albedo, natO, fillA);
      nightFill = territoryTarget(ground, natO) * fillA;
      emissive += natO * 0.05 * hoverO * terr * landK * (0.8 + 0.2 * sin(uTime * 4.0));

      if ((flagsO & PAL_ALLY) != 0) {
        // Allies: a wide diagonal hatch in the ally's colour.
        float k = (tp0.x - tp0.y) * 0.35;
        float s = abs(fract(k) - 0.5);
        float aa = fwidth(k) * 1.5;
        float hatch = smoothstep(0.1 + aa, 0.1 - aa, s) * smoothstep(1.2, 0.35, pxT);
        albedo = mix(albedo, mix(natO, vec3(1.0), 0.5) * 1.1, hatch * 0.28 * terr * landK);
      }
      if ((flagsO & PAL_REBEL) != 0) {
        // Rebels: thin stripes.
        float k = (tp0.x + tp0.y) * 1.1;
        float s = abs(fract(k) - 0.5);
        float aa = fwidth(k) * 1.5;
        float st = smoothstep(0.1 + aa, 0.1 - aa, s) * smoothstep(1.0, 0.3, pxT);
        albedo = mix(albedo, natO * 0.35, st * 0.55 * terr * landK);
      }
      if (occ > 0.01) {
        // Dots stay ~9 px apart at every zoom: the lattice doubles its density per octave of zoom and crossfades
        // between two octaves (no giant blobs up close, no moire from orbit).
        float octv = log2(max(1.0, (1.0 / pxT) / (9.0 * 2.5)));
        float o0 = floor(octv), ofr = fract(octv);
        float dotm = 0.0;
        for (int k = 0; k < 2; k++) {
          vec2 g = tp0 * 2.5 * exp2(o0 + float(k));
          g.x += 0.5 * mod(floor(g.y), 2.0);
          vec2 f = fract(g) - 0.5;
          float aa = max(fwidth(g.x), 1e-4) * 0.8;
          float dm = smoothstep(0.24 + aa, 0.24 - aa, length(f));
          float w1 = smoothstep(0.3, 0.7, ofr);
          dotm += dm * (k == 0 ? 1.0 - w1 : w1);
        }
        // Up close the stipple steps back (the land under it matters more than the pattern).
        dotm *= mix(1.0, 0.55, smoothstep(0.5, 3.0, octv));
        float vis = smoothstep(3.0, 6.0, 0.4 / pxT);
        albedo = mix(albedo, natO * 1.15, mix(0.3, dotm, vis) * occ * 0.9 * terr * landK);
      }
      // Conquest flash in the attacker's (new owner's) colour, 2 s.
      emissive += mix(natO, vec3(1.0), 0.25) * 1.7 * flash * terr * landK;
    } else if (landK > 0.0 && playableHere) {
      // Neutral land: desaturated 50 % and darkened 24 % from orbit, so owned land stands out (the design's 35 % / 10 %
      // measured ΔE 2.9 against the plain globe at 3,000 km; the readability target is ≥ 5).
      float l = luma(albedo);
      albedo = mix(albedo, mix(vec3(l), albedo, 0.5) * 0.76, uNeutralK * terr * landK * (1.0 - uSpawn));
      // Spawn phase: free land (where a capital can be founded) is brightened with a slow pulse.
      albedo *= 1.0 + uSpawn * terr * landK * (0.22 + 0.14 * sin(uTime * 1.7));
    }

    // Contested land (front heat): narrow animated diagonal stripes, orange-red, 1.5 tiles deep (§10.1).
    float contested = smoothstep(0.1, 0.22, heat) * (1.0 - smoothstep(1.1, 1.5, distT)) * landK * terr;
    if (contested > 0.001 && Q >= 0) {
      float k = (tp0.x + tp0.y) / 0.75 - uTime * 0.5;
      float s = abs(fract(k) - 0.5);
      float aa = fwidth(k) * 1.2;
      float stripe = smoothstep(0.22 + aa, 0.22 - aa, s);
      stripe = mix(0.45, stripe, smoothstep(4.0, 7.0, 0.75 / pxT));
      vec3 hot = vec3(0.95, 0.26, 0.07);
      albedo = mix(albedo, hot, stripe * contested * 0.6);
      emissive += hot * stripe * contested * 0.35;
    }

    // Borders: constant pixel widths, 1.4 px (human 2.4 px), split between the two owners' colours; a dark core
    // between players at war; a dark outline up close (ground-projected 2-3 px lines, §10.11).
    if (Q >= 0 && distPx < 10.0 && (O > 0 || Q > 0)) {
      vec3 natQ = vec3(0.5);
      int flagsQ = 0;
      float hoverQ = 0.0;
      if (Q > 0) {
        vec4 pq = paletteAt(Q);
        flagsQ = int(pq.a * 255.0 + 0.5);
        natQ = srgbToLinear(pq.rgb);
        hoverQ = abs(float(Q) - uHoverOwner) < 0.5 ? uHoverAmt : 0.0;
      }
      bool humanB = O == HUMAN_ID || Q == HUMAN_ID;
      bool indep = (O == 0 || (flagsO & PAL_INDEP) != 0) && (Q == 0 || (flagsQ & PAL_INDEP) != 0);
      float Wpx = humanB ? 2.4 : (indep ? 1.0 : 1.4);
      Wpx = mix(Wpx, humanB ? 3.0 : 2.2, uCloseK);
      float hO = O > 0 ? (Q > 0 ? Wpx * 0.5 : Wpx) : 0.0;
      float hQ = Q > 0 ? (O > 0 ? Wpx * 0.5 : Wpx) : 0.0;
      float s = distPx;
      float cO = bandCov(s, 0.0, hO), cQ = bandCov(s, -hQ, 0.0);
      float nightL = 1.0 - smoothstep(-0.12, 0.06, muS);
      float E = mix(1.5, 3.4, nightL);
      // At night the line leans further to white so it keeps >= 3:1 against the re-emitted fills (§10.4).
      float wl = mix(0.35, 0.55, nightL);
      vec3 colO = mix(natO, vec3(1.0), wl) * E * (1.0 + 0.25 * float(O == HUMAN_ID) + 0.5 * hoverO);
      vec3 colQ = mix(natQ, vec3(1.0), wl) * E * (1.0 + 0.25 * float(Q == HUMAN_ID) + 0.5 * hoverQ);
      if ((flagsO & PAL_TRAITOR) != 0) colO = mix(colO, vec3(3.0, 0.2, 0.15), 0.5 + 0.5 * sin(uTime * 6.0));
      if ((flagsQ & PAL_TRAITOR) != 0) colQ = mix(colQ, vec3(3.0, 0.2, 0.15), 0.5 + 0.5 * sin(uTime * 6.0));
      float fadeW = smoothstep(0.85, 0.35, water) * terr;
      lineCov = (cO + cQ) * fadeW;
      lineCol = (colO * cO + colQ * cQ) / max(cO + cQ, 1e-4);
      if (O > 0 && Q > 0 && atWarPair(O, Q)) coreCov = bandCov(s, -0.42, 0.42) * fadeW;
      outlineCov = (bandCov(s, hO, hO + 0.9) + bandCov(s, -hQ - 0.9, -hQ)) * fadeW * uCloseK;
      // The human's border: a 3 px inner glow.
      if (O == HUMAN_ID) emissive += natO * 0.45 * (1.0 - smoothstep(0.0, 3.0 + Wpx * 0.5, s)) * terr * landK;
    }

    // Small islands: a 1 px white shoreline from orbit (§10.6).
    if (isl > 0.5 && uShoreK > 0.0) shoreCov = bandCov(shorePx, -0.5, 0.5) * uShoreK * terr;

    // Historical (real-world) borders: 0.8 px dotted grey lines below 1,000 km when enabled (§10.3).
    if (uHistorical > 0.001 && landK > 0.2) {
      vec2 hx = tp0 - 0.5;
      ivec2 h0 = ivec2(floor(hx));
      vec2 hf = hx - floor(hx);
      int c00 = countryAt(h0), c10 = countryAt(h0 + ivec2(1, 0)), c01 = countryAt(h0 + ivec2(0, 1)), c11 = countryAt(h0 + ivec2(1, 1));
      int C = hf.x < 0.5 ? (hf.y < 0.5 ? c00 : c01) : (hf.y < 0.5 ? c10 : c11);
      if (C > 0) {
        float a = (c00 == C || c00 == 0) ? 1.0 : 0.0, b = (c10 == C || c10 == 0) ? 1.0 : 0.0;
        float cc = (c01 == C || c01 == 0) ? 1.0 : 0.0, d = (c11 == C || c11 == 0) ? 1.0 : 0.0;
        if (a + b + cc + d < 3.5) {
          float fC = mix(mix(a, b, hf.x), mix(cc, d, hf.x), hf.y);
          vec2 g = vec2(mix(b - a, d - cc, hf.y), mix(cc - a, d - b, hf.x));
          vec2 gpx = vec2(dot(g, dFdx(hx)), dot(g, dFdy(hx)));
          float gl = length(gpx);
          float hd = gl > 1e-6 ? (fC - 0.5) / gl : 1e4;
          vec2 along = gl > 1e-6 ? vec2(-gpx.y, gpx.x) / gl : vec2(1.0, 0.0);
          float dash = step(0.45, fract(dot(gl_FragCoord.xy, along) / 5.0));
          histCov = bandCov(hd, -0.4, 0.4) * dash * uHistorical * landK * terr;
        }
      }
    }
  }

  // --- lighting --------------------------------------------------------------------------------
  vec3 sunT = vSunT;
  float geoShadow = smoothstep(-0.035, 0.1, muS);
  float cloudShade = 1.0;
#if CLOUD_SHADOWS
  {
    float tanS = max(muS, 0.12);
    vec2 sd = vec2(dot(L, east), dot(L, north)) / tanS * (CLOUD_R - 1.0);
    vec2 suv = uv + uCloudOffset + vec2(sd.x / (TAU * max(cos(lat), 0.05)), sd.y / PI);
    float cs = texture2D(uClouds, suv).a;
    // Cloud shadows thin exactly like the clouds casting them (strategic mode, §10.5).
    cs *= cloudThin(texture2D(uCloudMask, uvT), uCloudK);
    cloudShade = 1.0 - 0.6 * cs * uCloudShadow;
  }
#endif
  float ndl = max(dot(N, L), 0.0);
  float castShadow = 1.0;
#if RELIEF_SHADOW_STEPS > 0
  if (water < 0.999 && muS > -0.04 && muS < 0.55 && rugged > 0.02) {
    castShadow = mix(1.0, reliefShadow(uv, up, east, north, L, elevM, lat), (1.0 - water) * smoothstep(0.55, 0.3, muS));
  }
#endif
  vec3 sunLight = sunT * uSunE * geoShadow * cloudShade;
  vec3 landSun = sunLight * castShadow;
  float dayK = smoothstep(-0.2, 0.25, muS);
  vec3 skyAmb = vec3(0.07, 0.12, 0.24) * dayK * 0.6 + vec3(0.016, 0.026, 0.055);
  vec3 col;

  // Land.
  vec3 land = albedo * (landSun * ndl + skyAmb);
  // Ocean (skipped entirely over dry land).
  vec3 ocean = vec3(0.0);
  if (water > 0.001) {
    vec3 Nw = up;
#if OCEAN_Q >= 1
    // Two wave scales (swell ~10 km, chop ~0.7 km), each faded out before it gets sub-pixel (no glitter aliasing).
    float swellK = clamp((1.0 / 650.0) / max(pxWorld, 1e-7) / 4.0 - 1.0, 0.0, 1.0);
    float chopK = clamp((1.0 / 9000.0) / max(pxWorld, 1e-7) / 4.0 - 1.0, 0.0, 1.0);
    if (swellK > 0.0) {
      vec3 gr = vec3(0.0);
      vec4 w0 = noised(vWorld * 650.0 + vec3(uTime * 0.02, 0.0, uTime * 0.013));
      gr += w0.yzw * 0.6 * swellK;
      if (chopK > 0.0) {
        vec3 p = vWorld * 9000.0;
        vec4 w1 = noised(p + vec3(uTime * 0.35, 0.0, uTime * 0.21));
        vec4 w2 = noised(p * 2.7 - vec3(uTime * 0.27, uTime * 0.4, 0.0));
        gr += (w1.yzw + w2.yzw * 0.55) * chopK;
      }
      gr -= up * dot(gr, up);
      Nw = normalize(up - gr * 0.04);
    }
#endif
    vec3 H = normalize(L + V);
    float nh = max(dot(Nw, H), 0.0);
    float nv = max(dot(Nw, V), 1e-3);
    float nl = max(dot(Nw, L), 0.0);
    float rough = mix(0.2, 0.46, smoothstep(0.0003, 0.004, pxWorld));
    float a2 = rough * rough * rough * rough;
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float k = rough * rough * 0.5;
    float vis = 1.0 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k));
    float vh = max(dot(V, H), 0.0);
    float Fs = 0.02 + 0.98 * pow(1.0 - vh, 5.0);
    float Fv = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    vec3 spec = sunLight * D * Fs * vis * nl * 0.25;
    vec3 deep = mix(albedo * vec3(0.8, 0.95, 1.1), vec3(0.004, 0.018, 0.045), 0.35);
    vec3 skyRefl = vec3(0.16, 0.32, 0.62) * dayK * 0.55;
    ocean = deep * (sunLight * smoothstep(-0.03, 0.25, muS) * max(muS + 0.03, 0.0) * 0.9 + skyAmb) * (1.0 - Fv) + skyRefl * Fv + spec;
#if OCEAN_Q >= 2
    // Coastal foam / surf close up.
    float coast = water * (1.0 - smoothstep(0.55, 0.95, texture2D(uWater, uv).r));
    float foamN = vnoise(vWorld * 26000.0 + vec3(0.0, uTime * 0.6, 0.0));
    // Only once the ~250 m foam cells span a few pixels (from ~300 km they alias into white speckle).
    float foamVis = 1.0 - smoothstep(0.6e-5, 1.6e-5, pxWorld);
    ocean += vec3(0.8) * coast * smoothstep(0.2, 0.8, foamN) * closeK * foamVis * sunLight * max(muS, 0.0) * 0.35;
#endif
  }
  col = mix(land, ocean, water);

  // Twilight: warm light scattered around the terminator.
  float tw = exp(-pow((muS + 0.02) / 0.075, 2.0));
  col += albedo * vec3(1.0, 0.42, 0.16) * tw * 0.22;

  // Night side: city lights.
  float nightF = smoothstep(0.06, -0.14, muS) * (1.0 - water);
  if (nightF > 0.001) {
    vec3 lights = texture2D(uNight, uv).rgb;
    lights = max(lights - 0.025, 0.0);
    lights = lights * (0.25 + 3.2 * lights);
    // Up close the 10 km texels would read as flat blobs: break them into street-grid-like sparkle.
    float mag = smoothstep(0.004, 0.0006, pxWorld);
    if (mag > 0.0) {
      float n = vnoise(vWorld * 3200.0) * 0.5 + 0.5;
      float n2 = vnoise(vWorld * 11000.0) * 0.5 + 0.5;
      lights *= mix(1.0, (0.25 + 1.5 * n * n) * (0.5 + n2), mag);
    }
    col += lights * vec3(1.0, 0.9, 0.72) * uNightE * nightF;
  }

  // Night side (DESIGN_V2 §10.4): a bluish floor light so land, coasts and islands stay readable, and the territory
  // fill re-emitted at 50 % of its day brightness so nations keep their colours in the dark (70 % made the fills so
  // bright that the emissive borders fell below 3:1 contrast against them).
  float nightK = 1.0 - smoothstep(-0.12, 0.06, muS);
  if (nightK > 0.0) {
    col += albedo * vec3(0.55, 0.72, 1.0) * uNightFloor * nightK * (0.45 + 0.55 * landK);
    emissive += nightFill * uSunE * 0.75 * 0.5 * nightK;
  }
  col += emissive;

  // Line layers on top of the lit ground: borders (HDR, glow through bloom), war cores, close-up outlines,
  // island shorelines, historical borders.
  col = mix(col, lineCol, clamp(lineCov, 0.0, 1.0));
  col = mix(col, vec3(0.012, 0.01, 0.01), clamp(coreCov, 0.0, 1.0) * 0.9);
  col = mix(col, vec3(0.01), clamp(outlineCov, 0.0, 1.0) * 0.6);
  col = mix(col, vec3(1.7), clamp(shoreCov, 0.0, 1.0) * 0.85);
  col = mix(col, vec3(0.55), clamp(histCov, 0.0, 1.0) * 0.8);

  // --- aerial perspective -----------------------------------------------------------------------
#if ATM_Q >= 1
  col = col * vTrans + vIns * uSkyE;
#else
  float rim = pow(1.0 - max(dot(up, V), 0.0), 3.0);
  col = mix(col, vec3(0.3, 0.55, 1.0) * dayK * 0.8, rim * 0.6);
#endif

  if (uMaskMode > 1.5) {
    // &mask=cloud: the ground is black, only the cloud deck writes values.
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (uMaskMode > 0.5) {
    // Flat owner-id false colour for tools/readability.mjs (shared/shots.ts OWNER_MASK), written raw.
    float nightB = muS < -0.02 ? ${OWNER_MASK.night}.0 : 0.0;
    vec3 m;
    if (water > 0.5) m = vec3(0.0, 0.0, ${OWNER_MASK.water}.0 + nightB);
    else if (O > 0) m = vec3(float(O & 255), float(O >> 8), ${OWNER_MASK.owned}.0 + nightB);
    else if (playableHere) m = vec3(0.0, 0.0, ${OWNER_MASK.neutral}.0 + nightB);
    else m = vec3(0.0, 0.0, ${OWNER_MASK.ice}.0 + nightB);
    gl_FragColor = vec4(m / 255.0, 1.0);
    return;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface EarthDefinesQ {
  RELIEF_SHADOW_STEPS: number;
  ATM_Q: number;
  ATM_SAMPLES: number;
  OCEAN_Q: number;
  CLOUD_SHADOWS: number;
}

export function earthDefines(q: { atmosphere: number; ocean: number; clouds: number; globeDetail: number }): EarthDefinesQ {
  return {
    RELIEF_SHADOW_STEPS: q.globeDetail >= 2 ? 10 : q.globeDetail === 1 ? 6 : 0,
    ATM_Q: q.atmosphere >= 1 ? 1 : 0,
    ATM_SAMPLES: q.atmosphere >= 2 ? 6 : 4,
    OCEAN_Q: q.ocean,
    CLOUD_SHADOWS: q.clouds >= 2 ? 1 : 0,
  };
}

export interface Earth {
  sphere: THREE.Mesh;
  patch: THREE.Mesh;
  material: THREE.ShaderMaterial;
  patchMaterial: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
  setDefines(d: EarthDefinesQ): void;
  setDetail(level: number): void;
}

/** Patch grid warp: local density factor at the centre (1 = uniform). */
export const PATCH_WARP = 0.35;
export const PATCH_RES = [96, 128, 176, 224];
export const SPHERE_SEGMENTS: readonly [number, number][] = [[256, 128], [384, 192], [512, 256], [768, 384]];

export function createEarth(tex: PlanetTextures | null, planet: PlanetUniforms, terr: TerritoryLayer, defines: EarthDefinesQ, detail: number): Earth {
  const uniforms: Record<string, THREE.IUniform> = {
    ...planet,
    ...terr.uniforms,
    uDay: { value: tex?.day ?? null },
    uNight: { value: tex?.night ?? null },
    uRelief: { value: tex?.relief ?? null },
    uWater: { value: tex?.water ?? null },
    uClouds: { value: tex?.clouds ?? null },
    uReliefScale: { value: (TOPO_MAX_METERS * RELIEF_EXAGGERATION) / (EARTH_RADIUS_KM * 1000) },
    uPatch: { value: new THREE.Vector4() },
    uPatchWarp: { value: PATCH_WARP },
    uPatchCut: { value: new THREE.Vector4() },
    uPatchActive: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, defines: { ...defines } });
  material.name = 'earth';
  const patchMaterial = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, uniforms, defines: { ...defines, PATCH: 1 },
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  patchMaterial.name = 'earth-patch';

  const [sw, sh] = SPHERE_SEGMENTS[detail];
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, sw, sh), material);
  sphere.name = 'earth';
  sphere.renderOrder = 0;
  const patch = new THREE.Mesh(makePatchGeometry(PATCH_RES[detail]), patchMaterial);
  patch.name = 'earth-near-patch';
  patch.frustumCulled = false;
  patch.renderOrder = 1;
  patch.visible = false;

  return {
    sphere, patch, material, patchMaterial, uniforms,
    setDefines(d) {
      for (const m of [material, patchMaterial]) {
        Object.assign(m.defines, d);
        m.needsUpdate = true;
      }
    },
    setDetail(level) {
      const [w, h] = SPHERE_SEGMENTS[level];
      sphere.geometry.dispose();
      sphere.geometry = new THREE.SphereGeometry(1, w, h);
      patch.geometry.dispose();
      patch.geometry = makePatchGeometry(PATCH_RES[level]);
    },
  };
}

function makePatchGeometry(n: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      pos[k++] = (i / n) * 2 - 1;
      pos[k++] = (j / n) * 2 - 1;
      pos[k++] = 0;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // Winding so the front faces point outward (radially) for a lat/lon grid (x = east, y = north).
      idx[k++] = a; idx[k++] = b; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = c;
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
