// FRONT ULTRA — photoreal Earth surface (owner: globe).
// One shader, two meshes:
//   * the global sphere (vertex-displaced by the real relief), and
//   * a camera-following lat/lon "near patch" (warped grid, denser at the target) that replaces the sphere
//     under the camera at low altitude, so the ground matches data.sampleElevation exactly up close.
// Shading: Blue Marble albedo, relief lighting from the topology-derived slope map (+ procedural detail up
// close), GGX ocean with sun glint, fresnel sky reflection and animated micro-normals, cloud shadows,
// night lights with a warm twilight band, aerial perspective (single scattering) and the territory overlay
// (fills, anti-aliased glowing borders, hot front lines, capture flashes, ally hatching, fallout scars, hover).

import * as THREE from 'three';
import { EARTH_RADIUS_KM, MAP_H, MAP_W, RELIEF_EXAGGERATION, TOPO_MAX_METERS } from '../../shared/constants';
import { GLSL_ATMOSPHERE, GLSL_COLOR, GLSL_CONSTANTS, GLSL_GEO, GLSL_NOISE } from './glsl';
import { MAX_SCARS, PAL_ALLY, PAL_ALIVE, PAL_HUMAN, PAL_TRAITOR, type TerritoryLayer } from './territory';
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
  };
}

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
#define SLOPE_RANGE ${SLOPE_RANGE.toFixed(1)}
#define MAX_SCARS ${MAX_SCARS}
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uRelief;
uniform sampler2D uWater;
uniform sampler2D uClouds;
uniform sampler2D uOwner;
uniform sampler2D uPalette;
uniform sampler2D uHeat;
uniform sampler2D uGlow;
uniform vec3 uSunDir;
uniform float uSunE;
uniform float uSkyE;
uniform float uTime;
uniform vec2 uCloudOffset;
uniform float uCloudShadow;
uniform float uNormalBoost;
uniform float uNightE;
uniform float uTick;
uniform float uHoverOwner;
uniform float uHoverAmt;
uniform float uTerritoryOpacity;
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

int ownerAt(ivec2 p, out float stamp) {
  p.x = p.x - ${MAP_W} * int(floor(float(p.x) / ${MAP_W}.0));
  p.y = clamp(p.y, 0, ${MAP_H - 1});
  vec4 t = texelFetch(uOwner, p, 0);
  stamp = floor(t.b * 255.0 + 0.5) + floor(t.a * 255.0 + 0.5) * 256.0;
  return int(t.r * 255.0 + 0.5) + int(t.g * 255.0 + 0.5) * 256;
}

vec4 paletteAt(int id) { return texelFetch(uPalette, ivec2(id, 0), 0); }

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
  vec3 emissive = vec3(0.0);
  float terr = uTerritoryOpacity;
  if (terr > 0.001) {
    vec2 tp = vec2(uv.x * ${MAP_W}.0, uvT.y * ${MAP_H}.0) - 0.5;
    vec2 fw = fwidth(tp);
    float pxT = max(max(fw.x, fw.y), 1e-4);
    ivec2 i0 = ivec2(floor(tp));
    vec2 f = tp - floor(tp);
    float st00, st10, st01, st11;
    int o00 = ownerAt(i0, st00);
    int o10 = ownerAt(i0 + ivec2(1, 0), st10);
    int o01 = ownerAt(i0 + ivec2(0, 1), st01);
    int o11 = ownerAt(i0 + ivec2(1, 1), st11);
    float w00 = (1.0 - f.x) * (1.0 - f.y), w10 = f.x * (1.0 - f.y), w01 = (1.0 - f.x) * f.y, w11 = f.x * f.y;
    float s00 = w00 + (o10 == o00 ? w10 : 0.0) + (o01 == o00 ? w01 : 0.0) + (o11 == o00 ? w11 : 0.0);
    float s10 = w10 + (o00 == o10 ? w00 : 0.0) + (o01 == o10 ? w01 : 0.0) + (o11 == o10 ? w11 : 0.0);
    float s01 = w01 + (o00 == o01 ? w00 : 0.0) + (o10 == o01 ? w10 : 0.0) + (o11 == o01 ? w11 : 0.0);
    float s11 = w11 + (o00 == o11 ? w00 : 0.0) + (o10 == o11 ? w10 : 0.0) + (o01 == o11 ? w01 : 0.0);
    int O = o00; float best = s00; float stamp = st00;
    if (s10 > best) { O = o10; best = s10; stamp = st10; }
    if (s01 > best) { O = o01; best = s01; stamp = st01; }
    if (s11 > best) { O = o11; best = s11; stamp = st11; }
    float a = o00 == O ? 1.0 : 0.0, b = o10 == O ? 1.0 : 0.0, c = o01 == O ? 1.0 : 0.0, d = o11 == O ? 1.0 : 0.0;
    float fO = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    vec2 g = vec2(mix(b - a, d - c, f.y), mix(c - a, d - b, f.x));
    float gl = length(g);
    float distT = gl > 1e-4 ? max(fO - 0.5, 0.0) / gl : 3.0;
    float distPx = distT / pxT;

    // Fallout scars (also over unowned land).
    float scar = 0.0, scarRim = 0.0;
    for (int i = 0; i < MAX_SCARS; i++) {
      if (i >= uScarCount) break;
      vec4 s = uScars[i];
      float dx = tp.x + 0.5 - s.x;
      dx -= ${MAP_W}.0 * floor((dx + ${MAP_W / 2}.0) / ${MAP_W}.0);
      float dy = tp.y + 0.5 - s.y;
      float dd = length(vec2(dx * cos(lat), dy)) / s.z;
      float wob = 0.12 * fbm3(vec3(dx, dy, float(i) * 7.0) * 0.35);
      scar = max(scar, s.w * (1.0 - smoothstep(0.45, 1.0, dd + wob)));
      scarRim = max(scarRim, s.w * (exp(-pow((dd + wob - 0.9) * 7.0, 2.0)) * 0.5 + exp(-pow((dd + wob * 0.6 - 0.32) * 11.0, 2.0))));
    }
    if (scar > 0.0 || scarRim > 0.0) {
      float landS = 1.0 - water * 0.75;
      albedo = mix(albedo, vec3(0.022, 0.026, 0.016), 0.85 * scar * terr * landS);
      float pulse = 0.8 + 0.2 * sin(uTime * 2.1);
      float n = 0.5 + 0.5 * fbm3(vec3(tp * 0.9, uTime * 0.12));
      float specks = pow(n, 9.0) * 3.0;
      vec3 toxic = vec3(0.42, 1.0, 0.1);
      emissive += toxic * (scar * (0.012 + 0.05 * n * n + specks * 0.35) + scarRim * 0.3) * pulse * terr * landS;
    }
    if (O > 0) {
      vec4 pal = paletteAt(O);
      int flags = int(pal.a * 255.0 + 0.5);
      vec3 nat = srgbToLinear(pal.rgb);
      bool isHuman = (flags & ${PAL_HUMAN}) != 0;
      bool isAlly = (flags & ${PAL_ALLY}) != 0;
      bool isTraitor = (flags & ${PAL_TRAITOR}) != 0;
      bool alive = (flags & ${PAL_ALIVE}) != 0;
      float hover = (abs(float(O) - uHoverOwner) < 0.5 ? uHoverAmt : 0.0);
      float human = isHuman ? 1.0 : 0.0;

      // Fill: keep the terrain's luminance, take the nation's hue.
      float fill = (0.26 + 0.05 * human + 0.07 * hover) * (alive ? 1.0 : 0.5) * terr;
      float la = luma(albedo);
      // Keep the terrain's luminance and part of its own hue, wash it with the nation's color.
      vec3 tinted = nat * clamp(la / max(luma(nat), 0.03), 0.0, 3.0);
      tinted = mix(mix(vec3(la), albedo, 0.35) * 1.05, tinted, 0.75);
      albedo = mix(albedo, tinted, fill);
      emissive += nat * 0.05 * hover * terr * (0.8 + 0.2 * sin(uTime * 4.0));

      if (isAlly) {
        float k = (tp.x - tp.y) * 0.35;
        float s = abs(fract(k) - 0.5);
        float aa = fwidth(k) * 1.5;
        float hatch = smoothstep(0.16 + aa, 0.16 - aa, s) * smoothstep(1.2, 0.35, pxT);
        albedo = mix(albedo, vec3(0.9, 0.95, 1.0) * la * 1.6 + nat * 0.1, hatch * 0.35 * terr);
      }

      // Borders: crisp anti-aliased line + inner glow band + wide soft glow.
      float lineW = clamp(0.22 / pxT, 0.75, 2.4) * (1.0 + 0.35 * human + 0.5 * hover);
      float line = 1.0 - smoothstep(lineW - 0.8, lineW + 0.8, distPx);
      line *= clamp(1.6 / pxT, 0.35, 1.0);
      float inner = exp(-distT * 2.2) * step(distT, 2.5);
      float glow = smoothstep(0.03, 0.55, texture2D(uGlow, uvT).r);
      float lum = 1.0 + 0.5 * human + 0.9 * hover;
      float pulseH = 1.0 + 0.12 * human * sin(uTime * 2.2);
      vec3 borderCol = mix(nat, vec3(1.0), 0.18) * 2.4;
      if (isTraitor) borderCol = mix(borderCol, vec3(3.0, 0.2, 0.15), 0.5 + 0.5 * sin(uTime * 6.0));
      emissive += borderCol * line * lum * pulseH * terr;
      emissive += nat * (inner * 0.35 + glow * 0.22) * lum * pulseH * terr;
      // Night side: territories keep a faint glow (strategic readability, DEFCON vibe).
      float nightK = smoothstep(0.05, -0.2, muS);
      emissive += nat * 0.035 * nightK * fill;

      // Hot front lines where the sim reports fighting, and flashing freshly-captured ground.
      float heat = texture2D(uHeat, uvT).r;
      if (heat > 0.01) {
        // Fire running along the contact line: flickering embers, pulsing core, smouldering band behind it.
        float t = uTime;
        float fire = vnoise(vec3(tp * 0.55, t * 1.9)) * 0.5 + 0.5;
        float embers = pow(vnoise(vec3(tp * 2.3, t * 3.1)) * 0.5 + 0.5, 4.0) * 2.0;
        float pulse = 0.7 + 0.3 * sin(t * 5.0 + (tp.x + tp.y) * 0.35);
        vec3 hot = vec3(4.2, 1.25, 0.22) * pulse * (0.55 + 0.6 * fire);
        emissive += hot * heat * (line * 1.25 + inner * 0.3 * (0.4 + embers) + glow * 0.08) * terr;
      }
      float age = mod(uTick - stamp, 65536.0);
      if (age < 60.0) {
        float fresh = exp(-age / 9.0);
        emissive += mix(nat * 1.4, vec3(3.2, 1.3, 0.35), 0.35 + 0.4 * heat) * fresh * 0.9 * terr;
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
    ocean += vec3(0.8) * coast * smoothstep(0.2, 0.8, foamN) * closeK * sunLight * max(muS, 0.0) * 0.35;
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

  col += emissive;

  // --- aerial perspective -----------------------------------------------------------------------
#if ATM_Q >= 1
  col = col * vTrans + vIns * uSkyE;
#else
  float rim = pow(1.0 - max(dot(up, V), 0.0), 3.0);
  col = mix(col, vec3(0.3, 0.55, 1.0) * dayK * 0.8, rim * 0.6);
#endif

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
