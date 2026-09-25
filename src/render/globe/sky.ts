// FRONT ULTRA — space backdrop (owner: globe).
//   * sky sphere: the NASA star field + a procedural Milky Way baked once on the GPU at load (galactic band,
//     warm bulge, dust lanes, faint emission nebulae);
//   * ~7000 crisp procedural stars (Points) with magnitude/temperature distribution and subtle twinkle;
//   * the sun: HDR disc, corona and starburst sprite (the post pipeline adds bloom and lens ghosts).
// Everything is camera-centred, drawn first (renderOrder -100) without depth, so it is never clipped.

import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const skyFrag = /* glsl */ `
#define PI 3.14159265358979
uniform sampler2D uStars;
uniform sampler2D uMilky;
uniform float uStarsE;
uniform float uMilkyE;
uniform float uFade;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(-d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
  vec3 stars = texture2D(uStars, uv).rgb;
  stars = max(stars - 0.02, 0.0);
  vec3 milky = texture2D(uMilky, uv).rgb;
  vec3 c = (stars * uStarsE + milky * uMilkyE) * uFade;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Procedural Milky Way, baked into an equirectangular HDR target.
const milkyFrag = /* glsl */ `
#define PI 3.14159265358979
${GLSL_NOISE}
uniform vec3 uPole;
uniform vec3 uCenter;
varying vec2 vUv;
void main() {
  float lon = (vUv.x - 0.5) * 2.0 * PI;
  float lat = (vUv.y - 0.5) * PI;
  vec3 d = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
  vec3 c0 = normalize(uCenter - uPole * dot(uCenter, uPole));
  vec3 c1 = cross(uPole, c0);
  float b = asin(clamp(dot(d, uPole), -1.0, 1.0));
  float l = atan(dot(d, c1), dot(d, c0));
  vec3 p = d * 3.0;
  float n1 = fbm3(p * 1.3) * 0.5 + 0.5;
  float n2 = fbm3(p * 4.1 + 7.0) * 0.5 + 0.5;
  float n3 = fbm3(p * 11.0 + 3.0) * 0.5 + 0.5;
  float width = 0.16 + 0.07 * (n1 - 0.5) + 0.1 * exp(-l * l * 1.6);
  float band = exp(-pow(b / width, 2.0));
  float core = exp(-(l * l) / 0.35 - (b * b) / 0.03);
  float clouds = band * (0.35 + 0.9 * n2 * n2) * (0.55 + 0.45 * n3);
  float dust = smoothstep(0.35, 0.75, fbm3(p * 5.3 + 11.0) * 0.5 + 0.5 + 0.2 * n2) * exp(-pow(b / (0.045 + 0.02 * n1), 2.0));
  float glow = clouds * (1.0 - 0.85 * dust) + core * (1.1 - 0.9 * dust);
  vec3 warm = vec3(1.0, 0.93, 0.86);
  vec3 cool = vec3(0.74, 0.82, 1.0);
  vec3 col = mix(cool, warm, clamp(core * 1.6, 0.0, 1.0)) * glow;
  col *= 0.55 + 0.9 * pow(n3, 2.0);
  float neb = smoothstep(0.72, 0.95, n3 * n2 * 1.6) * band;
  col += vec3(1.0, 0.25, 0.35) * neb * 0.35;
  col += vec3(0.5, 0.6, 1.0) * 0.02 * (fbm3(p * 0.8) * 0.5 + 0.5);
  gl_FragColor = vec4(col * 0.012, 1.0);
}`;

const pointsVert = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
uniform float uPx;
uniform float uFade;
varying vec3 vColor;
varying float vSize;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  float bright = pow(2.512, -aMag);
  float tw = 1.0 + 0.18 * sin(uTime * (1.3 + aPhase * 2.1) + aPhase * 40.0) * step(1.5, aMag);
  vSize = clamp(1.2 + bright * 2.2, 1.2, 3.6) * uPx;
  vColor = aColor * min(bright * 2.2, 3.0) * tw * uFade;
  gl_PointSize = vSize;
}`;

const pointsFrag = /* glsl */ `
varying vec3 vColor;
varying float vSize;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 3.0) * 0.25;
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const sunVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  // Screen-aligned billboard around the object origin.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(modelMatrix[0].xyz);
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}`;

const sunFrag = /* glsl */ `
uniform float uSunVis;
uniform float uTime;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float disc = smoothstep(0.03, 0.024, r) * 40.0;
  float corona = exp(-r * 34.0) * 7.0 + exp(-r * 10.0) * 0.55 + exp(-r * 3.8) * 0.07;
  float rays = pow(abs(cos(a * 3.0 + 0.3)), 500.0) + pow(abs(cos(a * 5.0 + 1.1)), 900.0) * 0.45;
  float burst = rays * exp(-r * 7.0) * 1.3 * (0.92 + 0.08 * sin(uTime * 0.7));
  vec3 col = vec3(1.0, 0.96, 0.88) * (disc + corona + burst) * uSunVis;
  col *= smoothstep(1.0, 0.8, r);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface SpaceBackdrop {
  group: THREE.Group;
  setTextures(stars: THREE.Texture): void;
  /** Bake the Milky Way (needs the renderer). */
  bake(renderer: THREE.WebGLRenderer): void;
  update(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, time: number, dpr: number, starFade: number, sunVis: number): void;
}

export function createSpaceBackdrop(): SpaceBackdrop {
  const group = new THREE.Group();
  group.name = 'space';

  const milkyRT = new THREE.WebGLRenderTarget(2048, 1024, {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, generateMipmaps: false,
  });
  const skyUniforms = {
    uStars: { value: null as THREE.Texture | null },
    uMilky: { value: milkyRT.texture },
    uStarsE: { value: 0.45 },
    uMilkyE: { value: 1.0 },
    uFade: { value: 1 },
  };
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVert, fragmentShader: skyFrag, uniforms: skyUniforms,
    side: THREE.BackSide, depthTest: false, depthWrite: false,
  });
  skyMat.name = 'sky';
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat);
  sky.name = 'sky';
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  group.add(sky);

  // --- procedural stars (deterministic) -----------------------------------------------------------
  const N = 7000;
  const pos = new Float32Array(N * 3), mag = new Float32Array(N), colr = new Float32Array(N * 3), phase = new Float32Array(N);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
  const pole = new THREE.Vector3(0.35, 0.62, -0.7).normalize();
  for (let i = 0; i < N; i++) {
    // Concentrate ~40% of the stars toward the galactic plane.
    let x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    let l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    if (rnd() < 0.4) {
      const d = x * pole.x + y * pole.y + z * pole.z;
      const k = 0.85 * (1 - Math.abs(d) * 0.2);
      x -= pole.x * d * k; y -= pole.y * d * k; z -= pole.z * d * k;
      l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    // Magnitude distribution: many faint, few bright.
    mag[i] = 6.5 - Math.pow(rnd(), 3.2) * 7.5;
    const t = rnd();
    const c = t < 0.12 ? [0.7, 0.8, 1.0] : t < 0.55 ? [1.0, 0.98, 0.95] : t < 0.8 ? [1.0, 0.9, 0.72] : [1.0, 0.72, 0.5];
    colr[i * 3] = c[0]; colr[i * 3 + 1] = c[1]; colr[i * 3 + 2] = c[2];
    phase[i] = rnd();
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  sg.setAttribute('aColor', new THREE.BufferAttribute(colr, 3));
  sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const pointsUniforms = { uTime: { value: 0 }, uPx: { value: 1 }, uFade: { value: 1 } };
  const starMat = new THREE.ShaderMaterial({
    vertexShader: pointsVert, fragmentShader: pointsFrag, uniforms: pointsUniforms,
    // Opaque list (drawn before the planet by renderOrder) but blended additively.
    depthTest: false, depthWrite: false, transparent: false, blending: THREE.AdditiveBlending,
  });
  starMat.name = 'stars';
  const stars = new THREE.Points(sg, starMat);
  stars.name = 'stars';
  stars.renderOrder = -99;
  stars.frustumCulled = false;
  group.add(stars);

  // --- sun -----------------------------------------------------------------------------------------
  const sunUniforms = { uSunVis: { value: 1 }, uTime: { value: 0 } };
  const sunMat = new THREE.ShaderMaterial({
    vertexShader: sunVert, fragmentShader: sunFrag, uniforms: sunUniforms,
    depthTest: false, depthWrite: false, transparent: false, blending: THREE.AdditiveBlending,
  });
  sunMat.name = 'sun';
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sunMat);
  sun.name = 'sun';
  sun.renderOrder = -98;
  sun.frustumCulled = false;
  group.add(sun);

  let baked = false;
  return {
    group,
    setTextures(starsTex) {
      starsTex.generateMipmaps = false;
      starsTex.minFilter = THREE.LinearFilter;
      starsTex.needsUpdate = true;
      skyUniforms.uStars.value = starsTex;
    },
    bake(renderer) {
      if (baked) return;
      baked = true;
      const mat = new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: milkyFrag,
        uniforms: { uPole: { value: pole }, uCenter: { value: new THREE.Vector3(-0.55, -0.25, -0.8).normalize() } },
        depthTest: false, depthWrite: false,
      });
      const scene = new THREE.Scene();
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      q.frustumCulled = false;
      scene.add(q);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(milkyRT);
      renderer.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      renderer.setRenderTarget(prev);
      mat.dispose();
      q.geometry.dispose();
    },
    update(camera, sunDir, time, dpr, starFade, sunVis) {
      const r = (camera.near + camera.far) * 0.5;
      group.position.copy(camera.position);
      sky.scale.setScalar(r);
      stars.scale.setScalar(r);
      pointsUniforms.uTime.value = time;
      pointsUniforms.uPx.value = dpr;
      pointsUniforms.uFade.value = starFade;
      skyUniforms.uFade.value = starFade;
      sun.position.copy(sunDir).multiplyScalar(r * 0.9);
      // Sprite size: fixed angular size (~34 degrees of glare).
      sun.scale.setScalar(r * 0.9 * 0.3);
      sunUniforms.uSunVis.value = sunVis;
      sunUniforms.uTime.value = time;
    },
  };
}
