// FRONT ULTRA — post-processing shaders (owner: globe/post).
// Physically-based bloom (13-tap downsample with Karis average on the first mip, 9-tap tent upsample),
// the final composite (chromatic aberration, bloom + lens dirt, pseudo lens ghosts & halo from the brightest
// sources, flash/whiteout, ACES filmic tone mapping, vignette, film grain, fade, sRGB + dither).

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const DOWNSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * contrib;
}
float karis(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tSrc, vUv + t * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture2D(tSrc, vUv + t * vec2(0.0, 2.0)).rgb;
  vec3 c = texture2D(tSrc, vUv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture2D(tSrc, vUv + t * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(tSrc, vUv + t * vec2(0.0, -2.0)).rgb;
  vec3 i = texture2D(tSrc, vUv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture2D(tSrc, vUv + t * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture2D(tSrc, vUv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(tSrc, vUv + t * vec2(1.0, -1.0)).rgb;
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average per 2x2 group kills fireflies (sun glints, tiny tracers) before they smear.
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    g0 = prefilter(g0); g1 = prefilter(g1); g2 = prefilter(g2); g3 = prefilter(g3); g4 = prefilter(g4);
    float w0 = karis(g0) * 0.125, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(w0 + w1 + w2 + w3 + w4, 1e-4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

export const UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += (texture2D(tSrc, vUv + vec2(-t.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb
      + texture2D(tSrc, vUv + vec2(0.0, -t.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb
     + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(s / 16.0 * uWeight, 1.0);
}`;

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tFlare;
uniform sampler2D tDirt;
uniform vec2 uRes;
uniform float uBloom;
uniform float uFlare;
uniform float uDirt;
uniform float uExposure;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uCA;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uFade;
uniform float uSaturation;
uniform float uCinematic;
uniform float uRaw;
varying vec2 vUv;

const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  c = ACES_IN * (c / 0.6);
  c = rrtOdt(c);
  return clamp(ACES_OUT * c, 0.0, 1.0);
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 flareSample(vec2 uv) {
  // Only the very brightest sources (sun, nukes) produce ghosts.
  vec3 c = texture2D(tFlare, uv).rgb;
  return max(c - vec3(2.5), 0.0);
}
vec3 ghosts(vec2 uv) {
  vec2 tc = vec2(1.0) - uv;
  vec2 gv = (vec2(0.5) - tc) * 0.42;
  vec3 acc = vec3(0.0);
  vec3 tints[5];
  tints[0] = vec3(1.0, 0.75, 0.45);
  tints[1] = vec3(0.45, 0.8, 1.0);
  tints[2] = vec3(0.8, 1.0, 0.55);
  tints[3] = vec3(1.0, 0.55, 0.85);
  tints[4] = vec3(0.6, 0.7, 1.0);
  for (int i = 0; i < 5; i++) {
    vec2 o = tc + gv * float(i + 1) * (i == 2 ? -0.7 : 1.0);
    if (o.x < 0.0 || o.x > 1.0 || o.y < 0.0 || o.y > 1.0) continue;
    float w = pow(1.0 - clamp(length(vec2(0.5) - o) / 0.7071, 0.0, 1.0), 6.0);
    acc += flareSample(o) * w * tints[i];
  }
  // Halo ring with chromatic dispersion.
  vec2 hv = normalize(gv + 1e-5) * 0.46;
  vec2 ho = tc + hv;
  float hw = pow(1.0 - clamp(length(vec2(0.5) - fract(ho)) / 0.7071, 0.0, 1.0), 8.0);
  vec2 cd = normalize(gv + 1e-5) * 0.012;
  acc += vec3(flareSample(ho - cd).r, flareSample(ho).g, flareSample(ho + cd).b) * hw * 0.7;
  return acc;
}
void main() {
  vec2 uv = vUv;
  if (uRaw > 0.5) {
    // Measurement mask (&mask=owner): the scene values, untouched.
    gl_FragColor = vec4(texture2D(tScene, uv).rgb, 1.0);
    return;
  }
  vec2 dc = uv - 0.5;
  vec3 col;
  if (uCA > 1e-5) {
    vec2 off = dc * uCA * (0.4 + length(dc) * 1.6);
    col = vec3(texture2D(tScene, uv - off).r, texture2D(tScene, uv).g, texture2D(tScene, uv + off).b);
  } else {
    col = texture2D(tScene, uv).rgb;
  }
  vec3 dirt = texture2D(tDirt, uv).rgb;
#if BLOOM
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloom * (1.0 + dirt * uDirt);
#endif
#if FLARES
  col += ghosts(uv) * uFlare * (0.5 + dirt * uDirt * 1.5);
#endif
  col *= uExposure;
  col += uFlashColor * uFlash * 5.0;
  vec3 mapped = aces(col);
  float lm = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
  mapped = max(mix(vec3(lm), mapped, uSaturation), 0.0);
  // Whiteout: a hard flash saturates to the flash color.
  mapped = mix(mapped, mix(vec3(1.0), uFlashColor, 0.25), clamp(uFlash - 0.55, 0.0, 1.0));
  // Vignette.
  float asp = uRes.x / uRes.y;
  float vr = length(dc * vec2(asp, 1.0)) / length(vec2(asp, 1.0) * 0.5);
  mapped *= mix(1.0, 1.0 - smoothstep(0.45, 1.15, vr) * 0.75, uVignette);
  // Output encoding (sRGB).
  vec3 srgb = mix(mapped * 12.92, 1.055 * pow(max(mapped, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, mapped));
  // Film grain (luminance weighted) + dither.
  float n = hash(uv * uRes + fract(uTime * 13.37) * 311.0) - 0.5;
  srgb += n * uGrain * (1.0 - lm * 0.6);
  srgb += (hash(uv * uRes * 1.37 + 7.1) - 0.5) / 255.0;
  srgb *= 1.0 - uFade;
  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}`;
