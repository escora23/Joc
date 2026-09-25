// FRONT ULTRA — command mode: sea / lake surface (owner: command). One camera-following quad at sea level with
// a custom shader: 3 scrolling noise normal layers, Fresnel sky reflection, HDR sun glitter, depth-tinted water from
// the terrain (shallows turn turquoise, the shoreline fades into wet sand), shore foam, whitecaps and exp² fog.

import * as THREE from 'three';
import type { Atmos } from './sky';

const WATER_VERT = /* glsl */ `
varying vec3 vWPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uDepthNear;
uniform sampler2D uDepthFar;
uniform float uNearSize;
uniform float uFarSize;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uWave;
varying vec3 vWPos;

float depthAt(vec2 p) {
  vec2 un = p / uNearSize + 0.5;
  if (un.x > 0.002 && un.x < 0.998 && un.y > 0.002 && un.y < 0.998) return texture2D(uDepthNear, un).r * 40.0;
  vec2 uf = p / uFarSize + 0.5;
  if (uf.x > 0.0 && uf.x < 1.0 && uf.y > 0.0 && uf.y < 1.0) return texture2D(uDepthFar, uf).r * 40.0;
  return 40.0;
}

vec2 grad(vec2 uv, int ch) {
  float e = 1.5 / 256.0;
  vec4 a = texture2D(uNoise, uv + vec2(e, 0.0));
  vec4 b = texture2D(uNoise, uv - vec2(e, 0.0));
  vec4 c = texture2D(uNoise, uv + vec2(0.0, e));
  vec4 d = texture2D(uNoise, uv - vec2(0.0, e));
  if (ch == 0) return vec2(a.r - b.r, c.r - d.r);
  if (ch == 1) return vec2(a.g - b.g, c.g - d.g);
  return vec2(a.b - b.b, c.b - d.b);
}

void main() {
  vec2 p = vWPos.xz;
  float t = uTime;
  vec3 toCam = cameraPosition - vWPos;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  // Fade the fine layers with distance to avoid shimmering.
  float fineFade = 1.0 - smoothstep(300.0, 2500.0, dist);
  vec2 g = grad(p * 0.0045 + vec2(t * 0.004, t * 0.0026), 0) * 1.4
         + grad(p * 0.021 - vec2(t * 0.011, -t * 0.007), 1) * 0.8
         + grad(p * 0.11 + vec2(t * 0.025, t * 0.018), 2) * 0.45 * fineFade;
  vec3 n = normalize(vec3(-g.x * uWave, 1.0, -g.y * uWave));
  float ndv = max(dot(n, v), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 r = reflect(-v, n);
  r.y = abs(r.y);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.5));
  float rs = max(dot(r, uSunDir), 0.0);
  vec3 spec = uSunColor * (pow(rs, 900.0) * 90.0 + pow(rs, 90.0) * 1.2) * uSunVis;
  float depth = depthAt(p);
  vec3 deep = vec3(0.006, 0.03, 0.05);
  vec3 shallow = vec3(0.03, 0.16, 0.16);
  vec3 body = mix(shallow, deep, smoothstep(0.5, 22.0, depth));
  float sunLight = 0.25 + 0.75 * clamp(uSunDir.y * 2.0, 0.0, 1.0);
  body *= (uAmbient * 0.9 + uSunColor * sunLight * 0.5);
  // Subsurface glow on wave crests facing the sun.
  body += uSunColor * shallow * pow(max(dot(-v, uSunDir), 0.0), 4.0) * 0.4 * uSunVis;
  vec3 col = mix(body, sky, fres) + spec;
  // Shore foam bands + whitecaps.
  float fn = texture2D(uNoise, p * 0.05 + vec2(t * 0.01, -t * 0.008)).a;
  float shore = smoothstep(2.6, 0.2, depth);
  float band = 0.5 + 0.5 * sin(depth * 4.0 - t * 1.6 + fn * 6.0);
  float foam = shore * smoothstep(0.35, 0.8, fn * 0.6 + band * 0.55);
  float caps = smoothstep(0.78, 0.9, texture2D(uNoise, p * 0.013 + vec2(t * 0.006, 0.0)).r) *
               smoothstep(0.55, 0.8, texture2D(uNoise, p * 0.07 - vec2(0.0, t * 0.02)).g) * 0.6 * uWave * 0.7;
  vec3 foamCol = (uAmbient * 0.8 + uSunColor * sunLight * 0.6) * 0.85;
  col = mix(col, foamCol, clamp(foam * 0.8 + caps * fineFade, 0.0, 1.0));
  float alpha = smoothstep(0.0, 1.2, depth) * 0.9 + 0.1 * step(0.05, depth);
  float ff = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, ff);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Water {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(noise: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: true,
      fog: false,
      uniforms: {
        uNoise: { value: noise },
        uDepthNear: { value: null },
        uDepthFar: { value: null },
        uNearSize: { value: 4000 },
        uFarSize: { value: 40000 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunVis: { value: 1 },
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uAmbient: { value: new THREE.Color() },
        uFogColor: { value: new THREE.Color() },
        uFogDensity: { value: 0.0003 },
        uTime: { value: 0 },
        uWave: { value: 1.0 },
      },
    });
    const g = new THREE.PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'cmd-water';
  }

  configure(depthNear: THREE.Texture, depthFar: THREE.Texture, nearSize: number, farSize: number, extent: number, wave: number): void {
    const u = this.material.uniforms;
    u.uDepthNear.value = depthNear;
    u.uDepthFar.value = depthFar;
    u.uNearSize.value = nearSize;
    u.uFarSize.value = farSize;
    u.uWave.value = wave;
    this.mesh.scale.set(extent, 1, extent);
  }

  apply(a: Atmos, fogDensity: number): void {
    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(a.sunDir.y > -0.05 ? a.sunDir : a.lightDir);
    (u.uSunColor.value as THREE.Color).copy(a.lightColor).multiplyScalar(a.lightIntensity / 3);
    u.uSunVis.value = a.sunDir.y > -0.02 ? 1 : 0.25;
    (u.uZenith.value as THREE.Color).copy(a.zenith);
    (u.uHorizon.value as THREE.Color).copy(a.horizon);
    (u.uAmbient.value as THREE.Color).copy(a.skyAmbient).multiplyScalar(a.ambientIntensity * 0.6);
    (u.uFogColor.value as THREE.Color).copy(a.fog);
    u.uFogDensity.value = fogDensity;
  }

  update(camera: THREE.Camera, time: number): void {
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.material.uniforms.uTime.value = time;
  }
}
