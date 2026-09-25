// FRONT ULTRA — ground battle: GPU particle pools (owner: battle).
// Particles are fire-and-forget: the CPU writes one instance (spawn position/time, velocity, life, sizes, drag,
// gravity/buoyancy, color, kind) into a ring buffer; the vertex shader integrates the motion analytically
// (linear drag + constant acceleration + wind) and animates size/opacity over life. No per-frame CPU work per
// particle, uploads only the freshly written slots (addUpdateRange).
//   * alpha pool (premultiplied): lit billowy smoke, dust, dirt clods, debris chunks
//   * additive pool (HDR, drives bloom): fireballs, flames, muzzle flashes, sparks, tracers (velocity-stretched
//     streaks), glows

import * as THREE from 'three';
import { GLSL_BATTLE_FRAG, GLSL_BATTLE_HEAD, GLSL_BATTLE_HEIGHT, GLSL_BATTLE_VERT, GLSL_TAIL, type BattleUniforms } from './common';

export const PK = {
  Smoke: 0,
  Dust: 1,
  Debris: 2,
  Fire: 3,
  Flash: 4,
  Streak: 5,
  Glow: 6,
  Haze: 7,
} as const;

const vert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
attribute vec4 aP;
attribute vec4 aV;
attribute vec4 aS;
attribute vec4 aC;
attribute vec4 aX;
varying vec2 vUv;
varying vec4 vCol;
varying float vLt;
varying float vKind;
varying vec3 vPos;
varying float vSeed;
varying float vAge;
varying vec3 vCorner;
varying float vSize;

vec3 simPos(float t) {
  float k = aS.z;
  float kind = aX.x;
  float wk = kind < 1.5 || kind > 6.5 ? 1.0 : (kind > 2.5 && kind < 3.5 ? 0.6 : 0.15);
  vec3 acc = vec3(0.0, aS.w, 0.0);
  vec3 wind = vec3(uWind.x, 0.0, uWind.y) * wk;
  if (k > 0.01) {
    vec3 vt = acc / k + wind;
    return aP.xyz + vt * t + (aV.xyz - vt) * (1.0 - exp(-k * t)) / k;
  }
  return aP.xyz + (aV.xyz + wind) * t + 0.5 * acc * t * t;
}

void main() {
  float age = uTime - aP.w;
  float life = aV.w;
  vKind = aX.x;
  vSeed = aX.w;
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float lt = age / life;
  vLt = lt;
  vAge = age;
  vCol = aC;
  vec3 p = simPos(age);
  vPos = p;
  float ms = length(modelViewMatrix[0].xyz);
  vec4 mv;
  if (aX.x > 4.5 && aX.x < 5.5) {
    // Velocity-stretched streak: tail trails the head by aS.y seconds.
    vec3 tp = simPos(max(age - aS.y, 0.0));
    vec4 hv = modelViewMatrix * vec4(p, 1.0);
    vec4 tv = modelViewMatrix * vec4(tp, 1.0);
    vec2 d = hv.xy / -hv.z - tv.xy / -tv.z;
    float dl = length(d);
    d = dl > 1e-7 ? d / dl : vec2(0.0, 1.0);
    vec2 n = vec2(-d.y, d.x);
    float f = position.y * 0.5 + 0.5;
    mv = mix(tv, hv, f);
    // Keep a minimum on-screen width (a pixel-ish) so far tracers stay visible.
    float wTrue = aS.x * ms, wMin = -mv.z * 0.0011;
    float w = max(wTrue, wMin);
    mv.xy += n * position.x * w;
    vUv = position.xy;
    vCorner = p;
    // Sub-pixel streaks are widened to a pixel: dim them by the coverage they really have.
    vSize = sqrt(clamp(wTrue / max(wMin, 1e-12), 0.0, 1.0));
  } else {
    float growth = 1.0 - (1.0 - lt) * (1.0 - lt);
    float size = mix(aS.x, aS.y, growth);
    float rot = aX.y + aX.z * age;
    float c = cos(rot), s = sin(rot);
    vec2 corner = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
    // Haze veils are wide and flat.
    if (aX.x > 6.5) corner = vec2(position.x * 2.2, position.y * 0.8);
    mv = modelViewMatrix * vec4(p, 1.0);
    // Screen-space minimum size for bright point sources (flashes stay visible from altitude).
    float minS = (aX.x > 3.5 && aX.x < 4.5) || aX.x > 5.5 && aX.x < 6.5 ? -mv.z * 0.0022 : 0.0;
    float sz = max(size * ms, minS);
    mv.xy += corner * sz;
    vUv = position.xy;
    // Local position of this billboard corner (for the soft fade where the sprite cuts into the ground).
    vec3 camRight = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]) / (ms * ms);
    vec3 camUp = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]) / (ms * ms);
    vCorner = p + (camRight * corner.x + camUp * corner.y) * sz;
    vSize = sz / ms;
  }
  gl_Position = projectionMatrix * pullMV(mv);
}`;

const frag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
${GLSL_BATTLE_HEIGHT}
uniform sampler2D uPuff;
uniform vec3 uSunView;
uniform float uAdditive;
varying vec2 vUv;
varying vec4 vCol;
varying float vLt;
varying float vKind;
varying vec3 vPos;
varying float vSeed;
varying float vAge;
varying vec3 vCorner;
varying float vSize;

uniform float uGroundSoft;
float groundSoft() {
  // Fade sprites where they would cut into the ground (no depth texture needed).
  if (uGroundSoft < 0.5) return 1.0;
  float g = battleHeight(vCorner.xz);
  return smoothstep(0.0, max(vSize * 0.35, 0.5), vCorner.y - g);
}

vec2 atlas(vec2 uv, float seed) {
  float q = floor(fract(seed * 7.13) * 4.0);
  vec2 o = vec2(mod(q, 2.0), floor(q / 2.0)) * 0.5;
  return o + (uv * 0.5 + 0.5) * 0.5;
}

void main() {
  float r2 = dot(vUv, vUv);
  float fadeIn, fadeOut;
  if (uAdditive < 0.5) {
    if (vKind > 6.5) {
      // Battlefield haze: very soft, flat-lit veil.
      vec4 t = texture2D(uPuff, atlas(vUv * 0.7, vSeed));
      fadeIn = smoothstep(0.0, 0.2, vLt);
      fadeOut = 1.0 - smoothstep(0.5, 1.0, vLt);
      vec3 V = normalize(vPos - uCamL);
      // A veil only reads as one when seen edge-on: fade it out when looking down on it.
      float edgeOn = 1.0 - smoothstep(0.3, 0.65, abs(V.y));
      float a = exp(-r2 * 2.8) * (0.55 + 0.45 * t.r) * vCol.a * fadeIn * fadeOut * uFade * groundSoft() * edgeOn;
      if (a < 0.003) discard;
      float back = pow(max(dot(V, uSunDir), 0.0), 4.0);
      vec3 col = vCol.rgb * (uSunCol * (0.45 + back * 1.5) + uSkyCol * 1.6);
      col = battleAir(col, vPos);
      gl_FragColor = vec4(col * a, a);
    } else if (vKind < 1.5) {
      // Smoke / dust: lit billowy puff.
      vec4 t = texture2D(uPuff, atlas(vUv, vSeed));
      fadeIn = smoothstep(0.0, vKind < 0.5 ? 0.08 : 0.03, vLt);
      fadeOut = 1.0 - smoothstep(0.45, 1.0, vLt);
      // Sprites that swallow the camera fade out instead of filling the screen.
      float nearF = smoothstep(vSize * 0.5, vSize * 2.2, length(vPos - uCamL));
      float a = t.r * vCol.a * fadeIn * fadeOut * uFade * groundSoft() * nearF;
      if (a < 0.004) discard;
      vec3 n = normalize(vec3((t.g - 0.5) * 2.0, (t.b - 0.5) * 2.0, 0.6));
      float lamb = clamp(dot(n, uSunView) * 0.4 + 0.55, 0.0, 1.0);
      vec3 V = normalize(vPos - uCamL);
      // Forward scattering through the thin parts when backlit (soft, no bright rim ring).
      float back = pow(max(dot(V, uSunDir), 0.0), 6.0) * (0.35 + 0.65 * (1.0 - t.r)) * smoothstep(0.02, 0.3, t.r) * 0.8;
      vec3 col = vCol.rgb * (uSunCol * (lamb * 0.85 + back) + uSkyCol * 0.8 + uGndCol * 1.2 + min(battleLights(vPos, vec3(0.0, -1.0, 0.0)) * 0.3, vec3(2.0)));
      col = battleAir(col, vPos);
      gl_FragColor = vec4(col * a, a);
    } else {
      // Debris chunk / dirt clod: small opaque-ish shard.
      if (max(abs(vUv.x), abs(vUv.y)) > 0.8) discard;
      fadeOut = 1.0 - smoothstep(0.8, 1.0, vLt);
      float a = vCol.a * fadeOut * uFade;
      vec3 col = vCol.rgb * (uSunCol * 0.6 + uSkyCol * 1.2 + battleLights(vPos, vec3(0.0, 1.0, 0.0)));
      col = battleAir(col, vPos);
      gl_FragColor = vec4(col * a, a);
    }
  } else {
    vec3 col;
    float e;
    if (vKind < 3.5) {
      // Fire: flame puff with a blackbody ramp over life.
      vec4 t = texture2D(uPuff, atlas(vUv, vSeed));
      float T = 1.0 - vLt;
      vec3 hot = mix(vec3(0.9, 0.12, 0.01), vec3(1.0, 0.55, 0.12), smoothstep(0.2, 0.6, T));
      hot = mix(hot, vec3(1.0, 0.9, 0.6), smoothstep(0.75, 1.0, T));
      e = t.a * smoothstep(0.0, 0.06, vLt) * (1.0 - smoothstep(0.35, 1.0, vLt));
      col = hot * vCol.rgb * vCol.a * e;
    } else if (vKind < 4.5) {
      // Flash: hot core + wide soft halo.
      float core = exp(-r2 * 9.0);
      float halo = exp(-r2 * 3.5) * 0.18;
      e = (core + halo) * (1.0 - vLt) * (1.0 - vLt);
      col = vCol.rgb * vCol.a * e;
    } else if (vKind < 5.5) {
      // Streak: bright head, fading tail.
      float across = exp(-vUv.x * vUv.x * 3.0);
      float along = mix(0.15, 1.0, vUv.y * 0.5 + 0.5);
      e = across * along * (1.0 - smoothstep(0.85, 1.0, vLt)) * mix(0.3, 1.0, vSize);
      col = vCol.rgb * vCol.a * e;
    } else {
      // Glow (embers, ground glow).
      e = exp(-r2 * 4.0) * (1.0 - vLt);
      col = vCol.rgb * vCol.a * e;
    }
    // Soft intersection with the ground for the big billboards (no hard horizontal cut through fireballs).
    if (vKind < 4.5 || vKind > 5.5) col *= groundSoft();
    // Attenuate through the air (no inscatter on additive light).
    vec3 v = vPos - uCamL;
    float k = length(v) / uFogRef;
    col *= pow(max(uFogTrans, vec3(1e-4)), vec3(k)) * uFade;
    if (max(col.r, max(col.g, col.b)) < 0.0005) discard;
    gl_FragColor = vec4(col, 1.0);
  }
  ${GLSL_TAIL}
}`;

export interface ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  emit(
    x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number,
    size0: number, size1: number, drag: number, grav: number,
    r: number, g: number, b: number, a: number, kind: number, rot: number, rotSpeed: number, t0: number,
  ): void;
  /** Upload the slots written since the last flush. */
  flush(): void;
  /** Kill everything (e.g. re-anchor). */
  clear(): void;
  resize(capacity: number): void;
}

export function createParticlePool(uniforms: BattleUniforms, puff: THREE.Texture, additive: boolean, capacity: number, sunView: THREE.IUniform<THREE.Vector3>): ParticlePool {
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { ...uniforms, uPuff: { value: puff }, uSunView: sunView, uAdditive: { value: additive ? 1 : 0 } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
  });
  mat.name = additive ? 'battle-particles-add' : 'battle-particles-alpha';
  const mesh = new THREE.Mesh(quad, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = additive ? 52 : 51;
  mesh.name = mat.name;

  let cap = 0;
  let aP!: THREE.InstancedBufferAttribute, aV!: THREE.InstancedBufferAttribute, aS!: THREE.InstancedBufferAttribute;
  let aC!: THREE.InstancedBufferAttribute, aX!: THREE.InstancedBufferAttribute;
  let cursor = 0;
  let dirtyStart = -1, dirtyCount = 0;
  let wrapped = false;

  function alloc(n: number): void {
    cap = n;
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    aP = mk(); aV = mk(); aS = mk(); aC = mk(); aX = mk();
    // Mark everything dead: spawn time far in the future is "not yet born", but life 0 also kills.
    for (let i = 0; i < n; i++) aP.array[i * 4 + 3] = -1e9;
    quad.setAttribute('aP', aP); quad.setAttribute('aV', aV); quad.setAttribute('aS', aS);
    quad.setAttribute('aC', aC); quad.setAttribute('aX', aX);
    quad.instanceCount = n;
    cursor = 0;
    dirtyStart = -1;
    dirtyCount = 0;
    wrapped = false;
  }
  alloc(Math.max(64, capacity));

  const attrs = () => [aP, aV, aS, aC, aX];

  return {
    mesh,
    get capacity() {
      return cap;
    },
    emit(x, y, z, vx, vy, vz, life, size0, size1, drag, grav, r, g, b, a, kind, rot, rotSpeed, t0) {
      const i = cursor;
      const o = i * 4;
      const P = aP.array as Float32Array, V = aV.array as Float32Array, S = aS.array as Float32Array;
      const C = aC.array as Float32Array, X = aX.array as Float32Array;
      P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = t0;
      V[o] = vx; V[o + 1] = vy; V[o + 2] = vz; V[o + 3] = life;
      S[o] = size0; S[o + 1] = size1; S[o + 2] = drag; S[o + 3] = grav;
      C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = a;
      X[o] = kind; X[o + 1] = rot; X[o + 2] = rotSpeed; X[o + 3] = ((i * 0.618034) % 1) + 0.001;
      if (dirtyStart < 0) {
        dirtyStart = i;
        dirtyCount = 1;
      } else {
        dirtyCount++;
      }
      cursor++;
      if (cursor >= cap) {
        cursor = 0;
        wrapped = true;
      }
    },
    flush() {
      if (dirtyStart < 0) return;
      for (const a of attrs()) {
        if (dirtyCount >= cap) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, cap * 4);
        } else if (wrapped && dirtyStart + dirtyCount > cap) {
          a.addUpdateRange(dirtyStart * 4, (cap - dirtyStart) * 4);
          a.addUpdateRange(0, (dirtyStart + dirtyCount - cap) * 4);
        } else {
          a.addUpdateRange(dirtyStart * 4, dirtyCount * 4);
        }
        a.needsUpdate = true;
      }
      dirtyStart = -1;
      dirtyCount = 0;
      wrapped = false;
    },
    clear() {
      const P = aP.array as Float32Array;
      for (let i = 0; i < cap; i++) P[i * 4 + 3] = -1e9;
      aP.clearUpdateRanges();
      aP.needsUpdate = true;
      dirtyStart = -1;
      dirtyCount = 0;
      wrapped = false;
    },
    resize(n) {
      if (n === cap) return;
      alloc(Math.max(64, n));
    },
  };
}
