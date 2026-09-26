// FRONT ULTRA — shared GLSL chunks for the planet (owner: globe).
// Atmospheric scattering (Rayleigh + Mie, analytic Chapman light depth), noise with analytic derivatives,
// geo helpers. Everything is in world units (1.0 = Earth radius = 6371 km).

import { EARTH_RADIUS_KM, TOPO_MAX_METERS } from '../../shared/constants';

const f = (n: number): string => {
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

/** Atmosphere model constants (world units). Slightly thicker than reality so the haze reads from orbit. */
export const ATMOSPHERE = {
  /** Top of the atmosphere shell radius. */
  top: 1 + 95 / EARTH_RADIUS_KM,
  /** Rayleigh / Mie scale heights. */
  hr: 9.0 / EARTH_RADIUS_KM,
  hm: 1.6 / EARTH_RADIUS_KM,
  /** Cloud layer radius (below the most exaggerated peaks: they pierce the clouds). */
  cloudRadius: 1 + 14 / EARTH_RADIUS_KM,
};

export const GLSL_CONSTANTS = /* glsl */ `
#define PI 3.14159265358979
#define TAU 6.28318530717959
#define EARTH_KM ${f(EARTH_RADIUS_KM)}
#define TOPO_MAX ${f(TOPO_MAX_METERS)}
#define ATM_TOP ${f(ATMOSPHERE.top)}
#define ATM_HR ${f(ATMOSPHERE.hr)}
#define ATM_HM ${f(ATMOSPHERE.hm)}
#define CLOUD_R ${f(ATMOSPHERE.cloudRadius)}
`;

/** Hashes and value noise with analytic derivatives (quintic), fbm helpers. */
export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// Value noise in [-1,1] with analytic gradient: returns (value, dvalue/dx, dvalue/dy, dvalue/dz).
vec4 noised(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float f1 = hash13(i + vec3(1.0, 0.0, 1.0));
  float g = hash13(i + vec3(0.0, 1.0, 1.0));
  float h = hash13(i + vec3(1.0, 1.0, 1.0));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a;
  float k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g + h;
  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 dv = du * vec3(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(v * 2.0 - 1.0, dv * 2.0);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * (3.0 - 2.0 * w);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z) * 2.0 - 1.0;
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
// fbm with derivatives (sum of noised), gradient w.r.t. p.
vec4 fbmd(vec3 p, int oct) {
  vec4 s = vec4(0.0);
  float a = 0.5, fr = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    vec4 n = noised(p * fr);
    s += a * vec4(n.x, n.yzw * fr);
    fr *= 2.07; a *= 0.5;
  }
  return s;
}
`;

/** Geo helpers (the same convention as shared/geo.ts). */
export const GLSL_GEO = /* glsl */ `
vec3 latLonDir(float lat, float lon) {
  float c = cos(lat);
  return vec3(c * cos(lon), sin(lat), -c * sin(lon));
}
// Tangent frame from the up (radial) direction. Stable except exactly at the poles.
void tangentBasis(vec3 up, out vec3 east, out vec3 north) {
  vec3 e = vec3(up.z, 0.0, -up.x);
  float l = length(e);
  east = l > 1e-5 ? e / l : vec3(0.0, 0.0, -1.0);
  north = cross(up, east);
}
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
`;

/**
 * Single scattering (Rayleigh + Mie). Light optical depth uses Schueler's Chapman approximation, so each
 * view sample costs no secondary march. ATM_SAMPLES must be defined by the including material.
 */
export const GLSL_ATMOSPHERE = /* glsl */ `
const vec3 BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6) * 6.371e6;
const float BETA_M = 1.3e-5 * 6.371e6;
const float MIE_G = 0.78;

float chapman(float X, float h, float cosZ) {
  float c = sqrt(X + h);
  if (cosZ >= 0.0) {
    return c / (c * cosZ + 1.0) * exp(-h);
  }
  float x0 = sqrt(max(0.0, 1.0 - cosZ * cosZ)) * (X + h);
  float c0 = sqrt(x0);
  return 2.0 * c0 * exp(min(X - x0, 60.0)) - c / (1.0 - c * cosZ) * exp(-h);
}

// Transmittance of sunlight reaching point p (world units) from direction L.
vec3 sunTransmittance(vec3 p, vec3 L) {
  float r = length(p);
  float h = max(r - 1.0, 0.0);
  float cosZ = dot(p / r, L);
  float odR = ATM_HR * chapman(1.0 / ATM_HR, h / ATM_HR, cosZ);
  float odM = ATM_HM * chapman(1.0 / ATM_HM, h / ATM_HM, cosZ);
  return exp(-(BETA_R * odR + BETA_M * 1.1 * odM));
}

float phaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float phaseM(float mu) {
  float g2 = MIE_G * MIE_G;
  return 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * MIE_G * mu, 1e-4), 1.5));
}

// Integrates inscattered light along ro + rd * [0, tMax] (clipped to the atmosphere).
void atmosphere(vec3 ro, vec3 rd, float tMax, vec3 L, out vec3 inscatter, out vec3 transmittance) {
  inscatter = vec3(0.0);
  transmittance = vec3(1.0);
  vec2 ta = raySphere(ro, rd, ATM_TOP);
  if (ta.y < 0.0 || ta.x > ta.y) return;
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  if (t1 <= t0) return;
  float ds = (t1 - t0) / float(ATM_SAMPLES);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  for (int i = 0; i < ATM_SAMPLES; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float h = max(length(p) - 1.0, 0.0);
    float dR = exp(-h / ATM_HR) * ds;
    float dM = exp(-h / ATM_HM) * ds;
    odR += dR * 0.5; odM += dM * 0.5;
    vec3 tv = exp(-(BETA_R * odR + BETA_M * 1.1 * odM));
    vec3 ts = sunTransmittance(p, L);
    sumR += dR * tv * ts;
    sumM += dM * tv * ts;
    odR += dR * 0.5; odM += dM * 0.5;
  }
  float mu = dot(rd, L);
  inscatter = sumR * BETA_R * phaseR(mu) + sumM * BETA_M * phaseM(mu);
  transmittance = exp(-(BETA_R * odR + BETA_M * 1.1 * odM));
}
`;

/** ACES-ish helpers shared by materials that want luminance. */
export const GLSL_COLOR = /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
`;

/**
 * Territory fill (DESIGN_V2 §10.1), shared by the globe surface, its near patch and the battle terrain rim so owned
 * land looks the same everywhere (no seam between them): the owner colour is mixed into the ground keeping 30 % of
 * the ground's luminance variation, so relief and land cover still read through the colour.
 * Needs GLSL_COLOR (luma). `owner` is linear RGB; `fill` comes from territoryFillAmount() (CPU) or uFill.
 */
export const GLSL_TERRITORY_FILL = /* glsl */ `
#define TERR_LUM_AVG 0.15
vec3 territoryTarget(vec3 ground, vec3 owner) {
  return owner * clamp(0.7 + 0.3 * luma(ground) / TERR_LUM_AVG, 0.6, 1.4);
}
vec3 territoryFill(vec3 ground, vec3 owner, float fill) {
  return mix(ground, territoryTarget(ground, owner), fill);
}
// The smallest fill that still changes the ground by a perceptual step \`t\` (measured in sqrt-linear RGB, close to a
// gamma-encoded difference; t = 0.18 is about 18-20 CIELAB ΔE after tone mapping). Where the owner colour is close to the
// ground it covers (a sand-coloured nation over desert, a green one over forest, a muted independent territory) the
// base fill would barely show, so the fill rises until the nation reads (capped at 0.85: some relief stays visible).
float territoryMinFill(vec3 ground, vec3 owner, float t) {
  vec3 d = sqrt(max(territoryTarget(ground, owner), 0.0)) - sqrt(max(ground, 0.0));
  // Bright ground (desert, snow) sits in the shoulder of the tone curve, where the same linear step reads smaller.
  return min(0.85, t * (1.0 + 2.0 * luma(ground)) / max(length(d), 1e-3));
}
`;

/**
 * Base fill strength by camera altitude (DESIGN_V2 §10.1), log-interpolated: ≥ 6,000 km 0.55; 1,500 km 0.45;
 * 300 km 0.35; ≤ 40 km 0.25. Add 0.05 for the human's land and 0.08 under the hover.
 */
export function territoryFillAmount(altKm: number): number {
  const K: readonly [number, number][] = [[40, 0.25], [300, 0.35], [1500, 0.45], [6000, 0.55]];
  if (altKm <= K[0][0]) return K[0][1];
  for (let i = 1; i < K.length; i++) {
    if (altKm <= K[i][0]) {
      const t = Math.log(altKm / K[i - 1][0]) / Math.log(K[i][0] / K[i - 1][0]);
      return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * t;
    }
  }
  return K[K.length - 1][1];
}
