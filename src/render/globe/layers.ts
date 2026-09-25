// FRONT ULTRA — atmosphere shell and cloud layer (owner: globe).
// Atmosphere: a back-face shell integrating Rayleigh + Mie single scattering along each view ray (limb glow
// from space, blue sky and horizon haze from low altitude, sunset colors at the terminator). Premultiplied
// blend (inscatter + background * transmittance) so stars dim behind the limb.
// Clouds: NASA cloud cover drifting slowly, sun-lit with forward-scattering silver lining, dark on the night
// side, broken up by procedural erosion up close, with the same aerial perspective as the ground.

import * as THREE from 'three';
import { ATMOSPHERE, GLSL_ATMOSPHERE, GLSL_COLOR, GLSL_CONSTANTS, GLSL_GEO, GLSL_NOISE } from './glsl';
import type { PlanetUniforms } from './earth';

/** Shell geometry radius: room for the artistic halo beyond the physical atmosphere top. */
const HALO_R = 1.12;

const shellVert = /* glsl */ `
varying vec3 vWorld;
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vDir = normalize(position);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const atmFrag = /* glsl */ `
${GLSL_CONSTANTS}
#define HALO_R ${HALO_R.toFixed(3)}
${GLSL_GEO}
${GLSL_ATMOSPHERE}
uniform vec3 uSunDir;
uniform float uSkyE;
uniform float uHalo;
varying vec3 vWorld;
varying vec3 vDir;
void main() {
  vec3 L = normalize(uSunDir);
  vec3 rd = normalize(vWorld - cameraPosition);
#if ATM_Q >= 1
  vec2 tg = raySphere(cameraPosition, rd, 1.0);
  float tMax = tg.x > 0.0 ? tg.x : 1e9;
  vec3 ins, trans;
  atmosphere(cameraPosition, rd, tMax, L, ins, trans);
  vec3 c = ins * uSkyE;
  float a = clamp(1.0 - dot(trans, vec3(0.3333)), 0.0, 1.0);
#else
  // Cheap rim: brightness from how close the ray passes to the surface.
  vec3 oc = cameraPosition;
  float b = dot(oc, rd);
  float closest = sqrt(max(dot(oc, oc) - b * b, 0.0));
  float h = clamp((closest - 1.0) / (ATM_TOP - 1.0), 0.0, 1.0);
  vec3 pc = cameraPosition + rd * (-b);
  float lit = smoothstep(-0.25, 0.35, dot(normalize(pc), L));
  float g = pow(1.0 - h, 6.0) * lit;
  vec3 c = vec3(0.25, 0.5, 1.0) * g * 1.4;
  float a = g * 0.5;
#endif
  // Artistic outer halo: a soft sunlit glow beyond the physical shell, for rays that miss the planet.
  {
    float tb = -dot(cameraPosition, rd);
    vec3 pc = cameraPosition + rd * max(tb, 0.0);
    float rc = length(pc);
    float hc = max(rc - 1.0, 0.0);
    float camAlt = length(cameraPosition) - 1.0;
    float miss = step(1.0, rc);
    float toward = max(dot(rd, L), 0.0);
    float fwd = pow(toward, 10.0);
    float lit = max(smoothstep(-0.3, 0.5, dot(pc / rc, L)), fwd);
    float halo = (exp(-hc / 0.009) * 0.55 + exp(-hc / 0.03) * 0.22) * lit * miss * smoothstep(0.03, 0.4, camAlt)
               * smoothstep(HALO_R - 1.0, (HALO_R - 1.0) * 0.45, hc);
    vec3 haloCol = mix(vec3(0.28, 0.52, 1.0), vec3(1.0, 0.62, 0.3), fwd);
    c += haloCol * halo * uHalo * (1.0 + 4.0 * pow(toward, 80.0));
  }
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const cloudVert = /* glsl */ `
${GLSL_CONSTANTS}
${GLSL_GEO}
${GLSL_ATMOSPHERE}
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vDir;
varying vec3 vIns;
varying vec3 vTrans;
varying vec3 vSunT;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vDir = normalize(position);
  vUv = uv;
  vec3 L = normalize(uSunDir);
  vSunT = sunTransmittance(vDir * CLOUD_R, L);
#if ATM_Q >= 1
  vec3 tv = wp.xyz - cameraPosition;
  float d = length(tv);
  atmosphere(cameraPosition, tv / d, d, L, vIns, vTrans);
#else
  vIns = vec3(0.0);
  vTrans = vec3(1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const cloudFrag = /* glsl */ `
${GLSL_CONSTANTS}
${GLSL_NOISE}
${GLSL_GEO}
${GLSL_ATMOSPHERE}
${GLSL_COLOR}
uniform sampler2D uClouds;
uniform vec2 uCloudOffset;
uniform vec3 uSunDir;
uniform float uSunE;
uniform float uSkyE;
uniform float uTime;
uniform float uCloudOpacity;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vDir;
varying vec3 vIns;
varying vec3 vTrans;
varying vec3 vSunT;
void main() {
  vec3 up = normalize(vDir);
  vec3 L = normalize(uSunDir);
  vec3 camVec = cameraPosition - vWorld;
  float dist = length(camVec);
  vec3 V = camVec / dist;
  float c = texture2D(uClouds, vUv + uCloudOffset).a;
  float closeK = smoothstep(0.08, 0.008, dist);
  if (closeK > 0.0) {
    float n = fbm3(vWorld * 520.0 + vec3(uTime * 0.01, 0.0, 0.0)) * 0.5 + 0.5;
    c = clamp((c - closeK * 0.45 * (1.0 - n)) / (1.0 - closeK * 0.3), 0.0, 1.0);
  }
  c = smoothstep(0.02, 0.85, c);
  if (c < 0.004) discard;
  float muS = dot(up, L);
  vec3 sunT = vSunT;
  float lit = smoothstep(-0.08, 0.3, muS) * (0.55 + 0.45 * clamp(muS * 2.0, 0.0, 1.0));
  float thick = mix(1.0, 0.72, c);
  float fwd = phaseM(dot(-V, L)) * 0.9;
  vec3 col = sunT * uSunE * (lit * thick * 0.95 + fwd * (1.0 - c) * smoothstep(-0.05, 0.1, muS));
  col += vec3(0.09, 0.13, 0.22) * smoothstep(-0.2, 0.3, muS) * 0.9 + vec3(0.004, 0.005, 0.009);
  // Sunset tint on cloud tops at the terminator.
  col += vec3(1.0, 0.45, 0.16) * exp(-pow((muS - 0.03) / 0.06, 2.0)) * 0.22 * smoothstep(-0.06, 0.02, muS);
  col = col * vTrans + vIns * uSkyE;
  float a = c * uCloudOpacity;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface AtmosphereLayers {
  atmosphere: THREE.Mesh;
  clouds: THREE.Mesh;
  /** The same layer seen from below (camera under the cloud deck). Separate program, compiled at warm-up. */
  cloudsInner: THREE.Mesh;
  atmMaterial: THREE.ShaderMaterial;
  cloudMaterial: THREE.ShaderMaterial;
  setQuality(atmQ: number, cloudQ: number, detail: number): void;
  /** Per frame: cloud side (from inside vs outside the layer). */
  update(camDist: number): void;
  /** Cloud opacity multiplier (clouds clear away as the camera descends to the battlefield). */
  setCloudFade(v: number): void;
}

export function createAtmosphereLayers(planet: PlanetUniforms, clouds: THREE.Texture | null, atmQ: number, detail: number): AtmosphereLayers {
  const atmMaterial = new THREE.ShaderMaterial({
    vertexShader: shellVert,
    fragmentShader: atmFrag,
    uniforms: { uSunDir: planet.uSunDir, uSkyE: planet.uSkyE, uHalo: { value: 1.0 } },
    defines: { ATM_Q: atmQ >= 1 ? 1 : 0, ATM_SAMPLES: atmQ >= 2 ? 10 : 6 },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  atmMaterial.name = 'atmosphere';
  const seg = [64, 96, 128, 160][detail];
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(HALO_R, seg, seg / 2), atmMaterial);
  atmosphere.name = 'atmosphere';
  atmosphere.renderOrder = 40;

  const cloudMaterial = new THREE.ShaderMaterial({
    vertexShader: cloudVert,
    fragmentShader: cloudFrag,
    uniforms: {
      uClouds: { value: clouds },
      uCloudOffset: planet.uCloudOffset,
      uSunDir: planet.uSunDir,
      uSunE: planet.uSunE,
      uSkyE: planet.uSkyE,
      uTime: planet.uTime,
      uCloudOpacity: { value: 0.96 },
    },
    defines: { ATM_Q: atmQ >= 1 ? 1 : 0, ATM_SAMPLES: atmQ >= 2 ? 6 : 4 },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  cloudMaterial.name = 'clouds';
  const cseg = [128, 192, 256, 320][detail];
  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(ATMOSPHERE.cloudRadius, cseg, cseg / 2), cloudMaterial);
  cloudMesh.name = 'clouds';
  cloudMesh.renderOrder = 30;
  const innerMaterial = cloudMaterial.clone();
  innerMaterial.uniforms = cloudMaterial.uniforms;
  innerMaterial.side = THREE.BackSide;
  const cloudsInner = new THREE.Mesh(cloudMesh.geometry, innerMaterial);
  cloudsInner.name = 'clouds-inner';
  cloudsInner.renderOrder = 30;
  cloudsInner.visible = false;

  return {
    atmosphere,
    clouds: cloudMesh,
    cloudsInner,
    atmMaterial,
    cloudMaterial,
    setQuality(q, _cloudQ, d) {
      atmMaterial.defines.ATM_Q = q >= 1 ? 1 : 0;
      atmMaterial.defines.ATM_SAMPLES = q >= 2 ? 10 : 6;
      atmMaterial.needsUpdate = true;
      for (const m of [cloudMaterial, innerMaterial]) {
        m.defines.ATM_Q = q >= 1 ? 1 : 0;
        m.needsUpdate = true;
      }
      const s = [64, 96, 128, 160][d];
      atmosphere.geometry.dispose();
      atmosphere.geometry = new THREE.SphereGeometry(HALO_R, s, s / 2);
      const cs = [128, 192, 256, 320][d];
      cloudMesh.geometry.dispose();
      cloudMesh.geometry = new THREE.SphereGeometry(ATMOSPHERE.cloudRadius, cs, cs / 2);
      cloudsInner.geometry = cloudMesh.geometry;
    },
    setCloudFade(v) {
      cloudMaterial.uniforms.uCloudOpacity.value = 0.96 * v;
      const vis = v > 0.003;
      if (!vis) {
        cloudMesh.visible = false;
        cloudsInner.visible = false;
      }
    },
    update(camDist) {
      const below = camDist < ATMOSPHERE.cloudRadius;
      cloudsInner.visible = below;
      cloudMesh.visible = !below;
    },
  };
}
