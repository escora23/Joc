// FRONT ULTRA — command mode: sky dome, sun, clouds and the atmosphere palette (owner: command).
// The palette is derived from the local sun elevation (from the globe's world time at the battle's lat/lon) so the
// sky, fog, ambient light, sun color and water reflections all agree with the strategic globe's terminator.

import * as THREE from 'three';

export interface Atmos {
  /** Unit vector toward the sun in local ENU (x = east, y = up, z = south). */
  sunDir: THREE.Vector3;
  /** Direction of the main light (sun by day, moon by night). */
  lightDir: THREE.Vector3;
  lightColor: THREE.Color;
  lightIntensity: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  skyAmbient: THREE.Color;
  groundAmbient: THREE.Color;
  ambientIntensity: number;
  fog: THREE.Color;
  /** 0 = full day .. 1 = full night. */
  night: number;
  /** 0..1 golden-hour warmth. */
  golden: number;
}

const C = (hex: number) => new THREE.Color(hex);
const DAY = { zenith: C(0x2a64b8), horizon: C(0xaecbe4), light: C(0xfff3e2), fog: C(0xa9c0d6), sky: C(0xb8d4ff), ground: C(0x5d5444) };
const GOLD = { zenith: C(0x3358a0), horizon: C(0xf2c08c), light: C(0xffc58a), fog: C(0xd8b394), sky: C(0x9bb2da), ground: C(0x5a4636) };
const DUSK = { zenith: C(0x16244a), horizon: C(0xc2684a), light: C(0xff8a5a), fog: C(0x7a5a5a), sky: C(0x4a5a88), ground: C(0x2e2630) };
const NIGHT = { zenith: C(0x02050d), horizon: C(0x0e1a2c), light: C(0x9fb4e0), fog: C(0x0f1a2a), sky: C(0x2a3a60), ground: C(0x14161e) };

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function computeAtmos(sunDir: THREE.Vector3, out?: Atmos): Atmos {
  const a: Atmos = out ?? {
    sunDir: new THREE.Vector3(), lightDir: new THREE.Vector3(), lightColor: new THREE.Color(), lightIntensity: 1,
    zenith: new THREE.Color(), horizon: new THREE.Color(), skyAmbient: new THREE.Color(), groundAmbient: new THREE.Color(),
    ambientIntensity: 1, fog: new THREE.Color(), night: 0, golden: 0,
  };
  a.sunDir.copy(sunDir).normalize();
  const e = Math.asin(Math.max(-1, Math.min(1, a.sunDir.y))) * (180 / Math.PI);
  // Blend weights: day (>18°), golden (4..18), dusk (-4..4), night (< -8).
  const wDay = smooth(8, 22, e);
  const wGold = smooth(-2, 8, e) * (1 - wDay);
  const wDusk = smooth(-9, -1, e) * (1 - wDay - wGold);
  const wNight = Math.max(0, 1 - wDay - wGold - wDusk);
  const mix = (key: 'zenith' | 'horizon' | 'light' | 'fog' | 'sky' | 'ground', target: THREE.Color) => {
    target.setRGB(0, 0, 0);
    target.r = DAY[key].r * wDay + GOLD[key].r * wGold + DUSK[key].r * wDusk + NIGHT[key].r * wNight;
    target.g = DAY[key].g * wDay + GOLD[key].g * wGold + DUSK[key].g * wDusk + NIGHT[key].g * wNight;
    target.b = DAY[key].b * wDay + GOLD[key].b * wGold + DUSK[key].b * wDusk + NIGHT[key].b * wNight;
  };
  mix('zenith', a.zenith);
  mix('horizon', a.horizon);
  mix('light', a.lightColor);
  mix('fog', a.fog);
  mix('sky', a.skyAmbient);
  mix('ground', a.groundAmbient);
  a.night = wNight + wDusk * 0.5;
  a.golden = wGold + wDusk * 0.4;
  if (e > -3) {
    a.lightDir.copy(a.sunDir);
    if (a.lightDir.y < 0.08) a.lightDir.y = 0.08;
    a.lightDir.normalize();
    a.lightIntensity = 0.4 + 2.9 * smooth(-3, 20, e);
  } else {
    // Moonlight from roughly opposite the sun, high in the sky.
    a.lightDir.set(-a.sunDir.x, 0, -a.sunDir.z);
    if (a.lightDir.lengthSq() < 1e-4) a.lightDir.set(0.3, 0, 0.2);
    a.lightDir.normalize().multiplyScalar(0.6);
    a.lightDir.y = 0.8;
    a.lightDir.normalize();
    a.lightIntensity = 0.9;
  }
  a.ambientIntensity = 0.6 + 0.5 * (1 - a.night);
  return a;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  p.z = p.w * 0.99995;
  gl_Position = p;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform float uNight;
uniform float uGolden;
uniform float uTime;
uniform float uCloud;
uniform sampler2D uNoise;
varying vec3 vDir;

float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float mu = dot(d, uSunDir);
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
  // Horizon glow toward the sun (warm at dusk).
  float toward = pow(max(mu, 0.0), 3.0) * (1.0 - clamp(h * 2.5, 0.0, 1.0));
  col += uSunColor * toward * (0.25 + uGolden * 0.9) * (1.0 - uNight * 0.8);
  // Below the horizon: haze into the ground color.
  col = mix(col, uGround, smoothstep(0.0, -0.25, h) * 0.85);
  // Sun disc + mie halo (HDR, drives bloom).
  float sunVis = smoothstep(-0.06, 0.02, uSunDir.y);
  float disc = smoothstep(0.99955, 0.99975, mu);
  col += uSunColor * (disc * 40.0 + pow(max(mu, 0.0), 350.0) * 3.0 + pow(max(mu, 0.0), 24.0) * 0.35) * sunVis;
  // Stars at night.
  if (uNight > 0.01 && h > 0.0) {
    vec3 sp = floor(d * 1500.0);
    float s = hash(sp);
    float star = step(0.9992, s) * pow(hash(sp + 7.0), 3.0);
    col += vec3(0.9, 0.95, 1.0) * star * uNight * 2.2 * smoothstep(0.05, 0.3, h);
  }
  // Clouds: two noise layers projected on a flat layer.
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.12);
    float n = texture2D(uNoise, uv * 0.11 + vec2(uTime * 0.002, uTime * 0.0012)).r * 0.65
            + texture2D(uNoise, uv * 0.37 - vec2(uTime * 0.003, 0.0)).g * 0.35;
    float cov = smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.28, n);
    float lit = 0.75 + 0.35 * pow(max(mu, 0.0), 4.0);
    vec3 cloudCol = mix(uHorizon * 1.05 + vec3(0.08), uSunColor * 0.9 + uHorizon * 0.25, 0.35 + uGolden * 0.3) * lit;
    cloudCol = mix(cloudCol, uZenith * 0.9 + vec3(0.012, 0.016, 0.026), uNight * 0.9);
    col = mix(col, cloudCol, cov * smoothstep(0.0, 0.12, h) * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(noise: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uNight: { value: 0 },
        uGolden: { value: 0 },
        uTime: { value: 0 },
        uCloud: { value: 0.45 },
        uNoise: { value: noise },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.scale.setScalar(1000);
  }

  apply(a: Atmos, cloud: number): void {
    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(a.sunDir);
    (u.uZenith.value as THREE.Color).copy(a.zenith);
    (u.uHorizon.value as THREE.Color).copy(a.horizon);
    (u.uGround.value as THREE.Color).copy(a.fog).multiplyScalar(0.8);
    (u.uSunColor.value as THREE.Color).copy(a.lightColor);
    u.uNight.value = a.night;
    u.uGolden.value = a.golden;
    u.uCloud.value = cloud;
  }

  update(camera: THREE.Camera, time: number): void {
    this.mesh.position.copy(camera.position);
    this.material.uniforms.uTime.value = time;
  }
}
