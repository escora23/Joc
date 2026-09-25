// FRONT ULTRA — ground battle: effects director (owner: battle).
// High-level combat effects built on the two GPU particle pools: muzzle flashes, tracers, tank rounds, artillery
// shells on ballistic arcs, rockets with smoke trails, explosions (flash, fireball, dirt plume, debris, sparks,
// smoke), craters (instanced decals), persistent fires with smoke columns (burning buildings and wrecks),
// drifting battlefield haze and short-lived local lights that illuminate terrain, units and smoke.

import * as THREE from 'three';
import {
  FastRng, GLSL_BATTLE_FRAG, GLSL_BATTLE_HEAD, GLSL_BATTLE_VERT, GLSL_TAIL, MAX_LIGHTS, type BattleUniforms,
} from './common';
import { decalGeometry } from './models';
import { PK, createParticlePool, type ParticlePool } from './particles';

// ------------------------------------------------------------------------------------------------------------
// Craters (instanced decals)
// ------------------------------------------------------------------------------------------------------------

const decalVert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
attribute vec4 iD;
attribute vec4 iE;
varying vec2 vUv;
varying vec3 vPos;
varying float vBirth;
varying float vSeed;
void main() {
  vec3 n = normalize(vec3(iE.z, 1.0, iE.w));
  vec3 t = normalize(cross(vec3(0.0, 0.0, 1.0), n));
  vec3 b = cross(n, t);
  vec3 p = iD.xyz + (t * position.x + b * position.z) * iD.w + n * 0.12;
  vUv = position.xz;
  vPos = p;
  vBirth = iE.x;
  vSeed = iE.y;
  gl_Position = battleProject(p);
}`;

const decalFrag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
varying vec2 vUv;
varying vec3 vPos;
varying float vBirth;
varying float vSeed;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float rays = bHash12(vec2(floor((ang + 3.1416) * 7.0), vSeed * 97.0));
  float edge = 0.62 + 0.18 * bHash12(vec2(floor((ang + 3.1416) * 5.0), vSeed * 31.0)) + rays * 0.25;
  float a = 1.0 - smoothstep(edge * 0.8, edge, r);
  float core = 1.0 - smoothstep(0.1, 0.45, r);
  float rim = smoothstep(0.32, 0.45, r) * (1.0 - smoothstep(0.45, 0.62, r));
  vec3 alb = mix(vec3(0.11, 0.085, 0.06), vec3(0.02, 0.018, 0.015), core * 0.9);
  alb = mix(alb, vec3(0.17, 0.135, 0.095), rim * 0.35);
  // Bowl normal for lighting.
  vec2 g = vUv * (r < 0.45 ? -1.0 : 0.6);
  vec3 N = normalize(vec3(g.x * 0.9, 1.0, g.y * 0.9));
  vec3 col = battleShade(alb, N, vPos, 1.0 - core * 0.4, 1.0);
  // Fresh craters glow for a moment.
  float age = uTime - vBirth;
  col += vec3(3.0, 0.9, 0.2) * core * exp(-age * 1.6) * 1.5;
  col = battleAir(col, vPos);
  float fadeIn = smoothstep(0.0, 0.15, age);
  a *= fadeIn * uFade * 0.8;
  gl_FragColor = vec4(col * a, a);
  ${GLSL_TAIL}
}`;

interface Decals {
  mesh: THREE.Mesh;
  add(x: number, y: number, z: number, radius: number, nx: number, nz: number, birth: number, seed: number): void;
  flush(): void;
  clear(): void;
  resize(n: number): void;
}

function createDecals(uniforms: BattleUniforms, capacity: number): Decals {
  const base = decalGeometry();
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setIndex(base.getIndex());
  const mat = new THREE.ShaderMaterial({
    vertexShader: decalVert, fragmentShader: decalFrag, uniforms: { ...uniforms },
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  mat.name = 'battle-craters';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  mesh.name = 'battle-craters';
  let cap = 0, cursor = 0, count = 0, dirty = false;
  let iD!: THREE.InstancedBufferAttribute, iE!: THREE.InstancedBufferAttribute;
  function alloc(n: number): void {
    cap = n;
    iD = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    iE = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    iD.setUsage(THREE.DynamicDrawUsage);
    iE.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iD', iD);
    geo.setAttribute('iE', iE);
    cursor = 0;
    count = 0;
    geo.instanceCount = 0;
  }
  alloc(Math.max(8, capacity));
  return {
    mesh,
    add(x, y, z, radius, nx, nz, birth, seed) {
      const o = cursor * 4;
      const D = iD.array as Float32Array, E = iE.array as Float32Array;
      D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = radius;
      E[o] = birth; E[o + 1] = seed; E[o + 2] = nx; E[o + 3] = nz;
      cursor = (cursor + 1) % cap;
      count = Math.min(cap, count + 1);
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      iD.needsUpdate = true;
      iE.needsUpdate = true;
      geo.instanceCount = count;
      dirty = false;
    },
    clear() {
      cursor = 0;
      count = 0;
      geo.instanceCount = 0;
    },
    resize(n) {
      if (n !== cap) alloc(Math.max(8, n));
    },
  };
}

// ------------------------------------------------------------------------------------------------------------
// Effects
// ------------------------------------------------------------------------------------------------------------

export type BlastSize = 0 | 1 | 2 | 3; // small (grenade/mortar), medium (tank round), large (artillery), huge (bomb)

interface Light {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  i: number; radius: number;
  birth: number; decay: number; life: number;
  flicker: number;
}

interface Fire {
  x: number; y: number; z: number;
  radius: number;
  intensity: number;
  until: number;
  smoke: number;
  acc: number;
  accS: number;
  light: boolean;
}

interface Impact {
  t: number;
  x: number; y: number; z: number;
  size: BlastSize;
}

export interface EffectsHost {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  isWater(x: number, z: number): boolean;
  /** Called for every explosion (infantry casualties). */
  onBlast(x: number, z: number, radius: number, now: number): void;
  /** Camera distance attenuation: returns 0..1 how worthwhile an effect at (x,z) is to spawn in detail. */
  lod(x: number, y: number, z: number): number;
}

export interface Effects {
  readonly alpha: ParticlePool;
  readonly add: ParticlePool;
  readonly decals: THREE.Mesh;
  /** Sun direction in view space (particle lighting), set by the renderer each frame. */
  readonly sunView: THREE.Vector3;
  /** 0..1 violence of the last second (audio). */
  readonly violence: number;
  muzzle(x: number, y: number, z: number, dx: number, dz: number, scale: number, r: number, g: number, b: number, now: number): void;
  tracer(x: number, y: number, z: number, tx: number, ty: number, tz: number, speed: number, r: number, g: number, b: number, width: number, now: number): void;
  tankShot(x: number, y: number, z: number, dx: number, dy: number, dz: number, tx: number, tz: number, now: number, hit: boolean): void;
  artilleryShot(x: number, y: number, z: number, dx: number, dy: number, dz: number, tx: number, tz: number, now: number): void;
  rocket(x: number, y: number, z: number, tx: number, tz: number, now: number): void;
  aaBurst(x: number, y: number, z: number, dx: number, dy: number, dz: number, now: number, rng: FastRng): void;
  explosion(x: number, z: number, size: BlastSize, now: number, crater?: boolean): void;
  addFire(x: number, y: number, z: number, radius: number, intensity: number, until: number, smoke: number, light: boolean): void;
  haze(x: number, z: number, size: number, now: number): void;
  schedule(t: number, x: number, z: number, size: BlastSize): void;
  update(now: number, dt: number, uniforms: BattleUniforms, camX: number, camY: number, camZ: number): void;
  clear(): void;
  setBudgets(particles: number, decals: number): void;
  /** Pre-age the scene: craters and fires that exist before the camera arrives. */
  seedCrater(x: number, z: number, radius: number, birth: number, seed: number): void;
}

export function createEffects(uniforms: BattleUniforms, puff: THREE.Texture, host: EffectsHost, particleBudget: number, decalBudget: number): Effects {
  const sunView: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, 1) };
  const alpha = createParticlePool(uniforms, puff, false, Math.floor(particleBudget * 0.55), sunView);
  const add = createParticlePool(uniforms, puff, true, Math.floor(particleBudget * 0.45), sunView);
  const decals = createDecals(uniforms, decalBudget);
  const rng = new FastRng(9001);
  const lights: Light[] = [];
  const fires: Fire[] = [];
  const impacts: Impact[] = [];
  const nrm = new THREE.Vector3();
  let violence = 0;
  let violenceAcc = 0;

  function addLight(x: number, y: number, z: number, r: number, g: number, b: number, i: number, radius: number, now: number, decay: number, life: number, flicker = 0): void {
    if (lights.length >= 48) {
      // Replace the weakest.
      let w = 0, wi = Infinity;
      for (let k = 0; k < lights.length; k++) {
        const L = lights[k];
        const cur = L.i * Math.exp(-(now - L.birth) * L.decay);
        if (cur < wi) { wi = cur; w = k; }
      }
      lights.splice(w, 1);
    }
    lights.push({ x, y, z, r, g, b, i, radius, birth: now, decay, life, flicker });
  }

  const fx: Effects = {
    alpha, add,
    decals: decals.mesh,
    sunView: sunView.value,
    get violence() {
      return violence;
    },
    muzzle(x, y, z, dx, dz, scale, r, g, b, now) {
      const l = Math.hypot(dx, dz) || 1;
      const ux = dx / l, uz = dz / l;
      add.emit(x + ux * 0.6 * scale, y, z + uz * 0.6 * scale, 0, 0, 0, 0.06, 0.55 * scale, 0.9 * scale, 0, 0, r, g, b, 26, PK.Flash, 0, 0, now);
      violenceAcc += 0.02;
    },
    tracer(x, y, z, tx, ty, tz, speed, r, g, b, width, now) {
      const dx = tx - x, dy = ty - y, dz = tz - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const life = d / speed;
      add.emit(x, y, z, (dx / d) * speed, (dy / d) * speed, (dz / d) * speed, life, width, Math.min(18 / speed, life), 0, 0, r, g, b, 5, PK.Streak, 0, 0, now);
    },
    tankShot(x, y, z, dx, dy, dz, tx, tz, now, hit) {
      // Muzzle blast: flash, flame tongue, dust kicked off the ground, lingering smoke.
      add.emit(x, y, z, dx * 30, dy * 30, dz * 30, 0.08, 2.2, 4.5, 8, 0, 1, 0.75, 0.4, 6, PK.Flash, 0, 0, now);
      for (let k = 0; k < 4; k++) {
        const s = rng.range(10, 35);
        add.emit(x, y, z, dx * s, dy * s + rng.range(-1, 2), dz * s, rng.range(0.12, 0.25), 1.2, 3.2, 5, 1, 1, 0.9, 0.7, 5, PK.Fire, rng.range(0, 6), 0, now);
      }
      const gy = host.heightAt(x, z);
      // Blast-kicked dust: a low, wide, thin sheet rather than a ball.
      for (let k = 0; k < 7; k++) {
        const a = rng.range(0, Math.PI * 2);
        const s = rng.range(7, 15);
        alpha.emit(x + Math.cos(a) * 2, gy + 0.4, z + Math.sin(a) * 2, Math.cos(a) * s + dx * 6, rng.range(0.2, 0.9), Math.sin(a) * s + dz * 6, rng.range(2.5, 4.5), 2, 9, 1.4, 0.1, 0.16, 0.135, 0.105, 0.2, PK.Dust, rng.range(0, 6), rng.range(-0.3, 0.3), now);
      }
      for (let k = 0; k < 3; k++) {
        alpha.emit(x + dx * 3, y, z + dz * 3, dx * 4, rng.range(0.5, 1.5), dz * 4, rng.range(4, 7), 2.5, 10, 0.8, 0.4, 0.15, 0.145, 0.14, 0.28, PK.Smoke, rng.range(0, 6), 0.1, now);
      }
      addLight(x + dx * 3, y + 1, z + dz * 3, 1, 0.7, 0.35, 10, 16, now, 18, 0.25);
      // Shell: fast streak, impact after flight.
      const ty = host.heightAt(tx, tz) + (hit ? 1.2 : 0);
      const d = Math.hypot(tx - x, tz - z);
      const flight = Math.max(0.05, d / 1650);
      fx.tracer(x + dx * 5, y, z + dz * 5, tx, ty, tz, 1650, 1, 0.6, 0.3, 0.12, now);
      fx.schedule(now + flight, tx, tz, 1);
      violenceAcc += 0.15;
    },
    artilleryShot(x, y, z, dx, dy, dz, tx, tz, now) {
      add.emit(x, y, z, dx * 20, dy * 20, dz * 20, 0.1, 3.5, 8, 6, 0, 1, 0.72, 0.38, 6, PK.Flash, 0, 0, now);
      for (let k = 0; k < 6; k++) {
        const s = rng.range(12, 40);
        add.emit(x, y, z, dx * s, dy * s, dz * s, rng.range(0.15, 0.3), 2, 5, 4, 2, 1, 0.85, 0.6, 6, PK.Fire, rng.range(0, 6), 0, now);
      }
      for (let k = 0; k < 8; k++) {
        const s = rng.range(2, 9);
        alpha.emit(x + dx * 2, y, z + dz * 2, dx * s + rng.range(-1, 1), dy * s + rng.range(0, 1.5), dz * s + rng.range(-1, 1), rng.range(6, 10), 3, 14, 0.6, 0.5, 0.17, 0.165, 0.16, 0.35, PK.Smoke, rng.range(0, 6), 0.08, now);
      }
      const gy = host.heightAt(x, z);
      for (let k = 0; k < 10; k++) {
        const a = rng.range(0, Math.PI * 2), s = rng.range(8, 16);
        alpha.emit(x + Math.cos(a) * 3, gy + 0.5, z + Math.sin(a) * 3, Math.cos(a) * s, rng.range(0.5, 2), Math.sin(a) * s, rng.range(3, 5), 3, 12, 1.3, 0.2, 0.16, 0.135, 0.105, 0.3, PK.Dust, rng.range(0, 6), 0, now);
      }
      addLight(x + dx * 4, y + 2, z + dz * 4, 1, 0.68, 0.32, 16, 30, now, 12, 0.35);
      // Ballistic shell: launch so it lands at (tx, tz) after `flight` seconds (time-compressed arc).
      const ty = host.heightAt(tx, tz);
      const d = Math.hypot(tx - x, tz - z);
      const flight = 2.2 + d / 900;
      const g = -9.81 * 6;
      const vx = (tx - x) / flight, vz = (tz - z) / flight;
      const vy = (ty - y - 0.5 * g * flight * flight) / flight;
      add.emit(x + dx * 6, y + dy * 6, z + dz * 6, vx, vy, vz, flight, 0.1, 0.02, 0, g, 1, 0.55, 0.25, 0.45, PK.Streak, 0, 0, now);
      fx.schedule(now + flight, tx, tz, 2);
      violenceAcc += 0.25;
    },
    rocket(x, y, z, tx, tz, now) {
      const ty = host.heightAt(tx, tz) + 0.5;
      const dx = tx - x, dy = ty - y, dz = tz - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const sp = 320;
      const flight = d / sp;
      add.emit(x, y, z, (dx / d) * sp, (dy / d) * sp, (dz / d) * sp, flight, 0.3, 0.035, 0, 0, 1, 0.75, 0.4, 7, PK.Streak, 0, 0, now);
      add.emit(x, y, z, 0, 0, 0, 0.08, 1.2, 2, 0, 0, 1, 0.8, 0.5, 8, PK.Flash, 0, 0, now);
      const puffs = Math.min(40, Math.ceil(d / 12));
      for (let k = 0; k < puffs; k++) {
        const f = k / puffs;
        const t0 = now + f * flight;
        alpha.emit(x + dx * f, y + dy * f, z + dz * f, rng.range(-0.5, 0.5), rng.range(0.2, 0.8), rng.range(-0.5, 0.5), rng.range(2.5, 4.5), 1.2, 6, 0.5, 0.3, 0.26, 0.255, 0.25, 0.3, PK.Smoke, rng.range(0, 6), 0.2, t0);
      }
      fx.schedule(now + flight, tx, tz, 1);
      violenceAcc += 0.1;
    },
    aaBurst(x, y, z, dx, dy, dz, now, r) {
      const n = 4 + r.int(6);
      for (let k = 0; k < n; k++) {
        const t0 = now + k * 0.07;
        const sp = 950;
        const jx = dx + r.range(-0.04, 0.04), jy = dy + r.range(-0.03, 0.03), jz = dz + r.range(-0.04, 0.04);
        const life = r.range(0.8, 1.3);
        add.emit(x, y, z, jx * sp, jy * sp, jz * sp, life, 0.1, 0.03, 0.05, -9.81, 1, 0.45, 0.2, 1.2, PK.Streak, 0, 0, t0);
        if (k % 2 === 0) add.emit(x + dx * 3, y + dy * 3, z + dz * 3, 0, 0, 0, 0.05, 0.9, 1.4, 0, 0, 1, 0.8, 0.5, 8, PK.Flash, 0, 0, t0);
        // Airburst puffs where the rounds self-destruct.
        if (r.chance(0.25)) {
          const f = life * 0.9;
          alpha.emit(x + jx * sp * f * 0.88, y + jy * sp * f * 0.88 - 9.81 * f * f * 0.5, z + jz * sp * f * 0.88, 0, 0.2, 0, 3, 3, 8, 0.4, 0, 0.06, 0.06, 0.06, 0.35, PK.Smoke, 0, 0, t0 + f);
          add.emit(x + jx * sp * f * 0.88, y + jy * sp * f * 0.88 - 9.81 * f * f * 0.5, z + jz * sp * f * 0.88, 0, 0, 0, 0.12, 2, 4, 0, 0, 1, 0.75, 0.4, 10, PK.Flash, 0, 0, t0 + f);
        }
      }
      addLight(x, y + 2, z, 1, 0.7, 0.35, 5, 14, now, 4, 0.6);
    },
    explosion(x, z, size, now, crater = true) {
      const lod = host.lod(x, host.heightAt(x, z), z);
      const water = host.isWater(x, z);
      const y = water ? 0 : host.heightAt(x, z);
      const S = [1.7, 3.2, 5.5, 10][size];
      const detail = Math.max(0.35, lod);
      // Flash + light.
      add.emit(x, y + S * 0.6, z, 0, 0, 0, 0.12 + size * 0.03, S * 1.6, S * 2.4, 0, 0, 1, 0.78, 0.45, 1.3 + size * 0.2, PK.Flash, 0, 0, now);
      addLight(x, y + S * 1.4, z, 1, 0.62, 0.28, 3 + size * 3.5, 12 + S * 5, now, 5 - size * 0.8, 1.2 + size * 0.4);
      if (water) {
        // Water spout.
        const nW = Math.ceil((14 + size * 8) * detail);
        for (let k = 0; k < nW; k++) {
          const a = rng.range(0, Math.PI * 2), sp = rng.range(0, 6) * S * 0.4;
          alpha.emit(x, y, z, Math.cos(a) * sp, rng.range(12, 26) * (0.6 + size * 0.25), Math.sin(a) * sp, rng.range(1.5, 3), S * 0.5, S * 1.5, 0.6, -9.81, 0.55, 0.6, 0.62, 0.6, PK.Dust, rng.range(0, 6), 0, now);
        }
        violenceAcc += 0.2 + size * 0.2;
        host.onBlast(x, z, S * 3, now);
        return;
      }
      // Fireball.
      const nF = Math.ceil((4 + size * 3) * detail);
      for (let k = 0; k < nF; k++) {
        const a = rng.range(0, Math.PI * 2), sp = rng.range(2, 9) * S * 0.35;
        add.emit(x, y + S * 0.4, z, Math.cos(a) * sp, rng.range(3, 10) * S * 0.3, Math.sin(a) * sp, rng.range(0.45, 0.9) + size * 0.15, S * 0.9, S * 2.1, 2.2, 3, 1, 0.9, 0.75, 1.0 + size * 0.15, PK.Fire, rng.range(0, 6), rng.range(-1, 1), now + rng.range(0, 0.05));
      }
      // Dirt plume + clods (the column of earth thrown up by a shell).
      // The iconic shell burst: a column of earth thrown straight up, then collapsing.
      const nD = Math.ceil((8 + size * 10) * detail);
      const big = size >= 2 ? 1 : 0;
      for (let k = 0; k < nD; k++) {
        const a = rng.range(0, Math.PI * 2), sp = rng.range(0.5, 5) * S * (0.35 - big * 0.12);
        const up = rng.range(10, 26) * (0.55 + size * 0.28) * (1 + big * 0.35);
        alpha.emit(x, y + 0.5, z, Math.cos(a) * sp, up, Math.sin(a) * sp, rng.range(1.6, 3.2) * (1 + big * 0.6), S * 0.7, S * (2.6 + big), 0.9 - big * 0.3, -9.81 * 0.8, 0.08, 0.063, 0.045, 0.6, PK.Dust, rng.range(0, 6), rng.range(-0.5, 0.5), now + rng.range(0, 0.08));
      }
      const nC = Math.ceil((10 + size * 10) * detail);
      for (let k = 0; k < nC; k++) {
        const a = rng.range(0, Math.PI * 2), sp = rng.range(3, 12) * S * 0.3;
        alpha.emit(x, y + 0.5, z, Math.cos(a) * sp, rng.range(8, 24) * (0.6 + size * 0.2), Math.sin(a) * sp, rng.range(1.2, 2.6), S * 0.12, S * 0.12, 0.2, -9.81, 0.05, 0.04, 0.03, 1, PK.Debris, rng.range(0, 6), rng.range(-12, 12), now);
      }
      // Sparks.
      const nS = Math.ceil((6 + size * 6) * detail);
      for (let k = 0; k < nS; k++) {
        const a = rng.range(0, Math.PI * 2), el = rng.range(0.2, 1.2), sp = rng.range(20, 50) * (0.6 + size * 0.2);
        add.emit(x, y + 0.6, z, Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp, rng.range(0.5, 1.3), 0.12, 0.05, 1.2, -9.81, 1, 0.6, 0.25, 14, PK.Streak, 0, 0, now);
      }
      // Ground shock ring of dust.
      const nR = Math.ceil((8 + size * 4) * detail);
      for (let k = 0; k < nR; k++) {
        const a = (k / nR) * Math.PI * 2 + rng.range(-0.2, 0.2), sp = rng.range(8, 16) * (0.6 + size * 0.3);
        alpha.emit(x, y + 0.6, z, Math.cos(a) * sp, rng.range(0.3, 1.5), Math.sin(a) * sp, rng.range(2, 4), S * 0.9, S * 3.4, 1.4, 0.15, 0.12, 0.1, 0.08, 0.28, PK.Dust, rng.range(0, 6), 0, now);
      }
      // Lingering smoke.
      const nK = Math.ceil((5 + size * 4) * detail);
      for (let k = 0; k < nK; k++) {
        const g = rng.range(0.1, 0.15);
        alpha.emit(x + rng.range(-S, S) * 1.5, y + S * rng.range(0.5, 2), z + rng.range(-S, S) * 1.5, rng.range(-1.5, 1.5), rng.range(1, 4), rng.range(-1.5, 1.5), rng.range(8, 16) + size * 4, S * 1.5, Math.min(S * 5.5, 34), 0.35, 0.6, g, g * 0.9, g * 0.78, 0.17, PK.Smoke, rng.range(0, 6), rng.range(-0.1, 0.1), now + rng.range(0.2, 0.6));
      }
      if (crater) {
        host.normalAt(x, z, nrm);
        decals.add(x, y, z, S * rng.range(1.5, 2.1), nrm.x / Math.max(nrm.y, 0.3), nrm.z / Math.max(nrm.y, 0.3), now, rng.next());
      }
      if (size >= 3) fx.addFire(x, y, z, S * 1.5, 1.2, now + rng.range(20, 40), 1.4, true);
      host.onBlast(x, z, S * (size >= 2 ? 4.5 : 3), now);
      violenceAcc += 0.2 + size * 0.25;
    },
    addFire(x, y, z, radius, intensity, until, smoke, light) {
      if (fires.length >= 64) fires.shift();
      fires.push({ x, y, z, radius, intensity, until, smoke, acc: 0, accS: 0, light });
    },
    haze(x, z, size, now) {
      const y = host.heightAt(x, z);
      alpha.emit(x, y + size * 0.25, z, rng.range(-0.5, 0.5), rng.range(0.05, 0.3), rng.range(-0.5, 0.5), rng.range(25, 50), size * 1.2, size * 2.2, 0.05, 0.02, 0.3, 0.28, 0.26, 0.06, PK.Haze, rng.range(0, 6), rng.range(-0.02, 0.02), now);
    },
    schedule(t, x, z, size) {
      if (impacts.length > 200) return;
      impacts.push({ t, x, y: 0, z, size });
    },
    seedCrater(x, z, radius, birth, seed) {
      const y = host.heightAt(x, z);
      host.normalAt(x, z, nrm);
      decals.add(x, y, z, radius, nrm.x / Math.max(nrm.y, 0.3), nrm.z / Math.max(nrm.y, 0.3), birth, seed);
    },
    update(now, dt, u, camX, camY, camZ) {
      // Scheduled impacts.
      for (let k = impacts.length - 1; k >= 0; k--) {
        const im = impacts[k];
        if (now >= im.t) {
          impacts.splice(k, 1);
          fx.explosion(im.x, im.z, im.size, im.t);
        }
      }
      // Persistent fires + smoke columns.
      for (let k = fires.length - 1; k >= 0; k--) {
        const f = fires[k];
        if (now > f.until) {
          fires.splice(k, 1);
          continue;
        }
        const life = Math.min(1, (f.until - now) / 10);
        const lod = host.lod(f.x, f.y, f.z);
        f.acc += dt * f.intensity * 7 * life * Math.max(0.3, lod);
        while (f.acc > 1) {
          f.acc -= 1;
          const a = rng.range(0, Math.PI * 2), r = rng.range(0, f.radius);
          add.emit(f.x + Math.cos(a) * r, f.y + rng.range(0, f.radius * 0.3), f.z + Math.sin(a) * r, rng.range(-0.3, 0.3), rng.range(1.5, 4), rng.range(-0.3, 0.3), rng.range(0.6, 1.3), f.radius * 0.7, f.radius * 1.1, 0.5, 2.5, 1, 0.85, 0.7, 2.4 * f.intensity, PK.Fire, rng.range(0, 6), rng.range(-0.5, 0.5), now);
          if (rng.chance(0.15)) add.emit(f.x + rng.range(-f.radius, f.radius), f.y + f.radius * 0.5, f.z + rng.range(-f.radius, f.radius), rng.range(-1, 1), rng.range(3, 8), rng.range(-1, 1), rng.range(1, 2.5), 0.08, 0.04, 0.8, 1, 1, 0.55, 0.2, 10, PK.Streak, 0, 0, now);
        }
        f.accS += dt * f.smoke * 2.2 * life * Math.max(0.35, lod);
        while (f.accS > 1) {
          f.accS -= 1;
          // Black oily smoke at the foot, greying as it climbs and spreads into a leaning column.
          const g = rng.range(0.035, 0.075);
          const r0 = Math.min(f.radius, 6);
          alpha.emit(f.x + rng.range(-r0, r0) * 0.5, f.y + r0, f.z + rng.range(-r0, r0) * 0.5, rng.range(-0.4, 0.4), rng.range(3.5, 6.5), rng.range(-0.4, 0.4), rng.range(16, 26), r0 * 1.3, Math.min(r0 * 6, 26) + 6, 0.1, 0.4, g, g * 0.95, g * 0.9, 0.6, PK.Smoke, rng.range(0, 6), rng.range(-0.08, 0.08), now);
        }
      }
      // Violence meter.
      violence += (Math.min(1, violenceAcc * 0.9) - violence) * Math.min(1, dt * 2);
      violenceAcc *= Math.exp(-dt * 1.5);

      // Lights: drop dead ones, pick the strongest (distance-weighted) for the shaders.
      for (let k = lights.length - 1; k >= 0; k--) if (now - lights[k].birth > lights[k].life) lights.splice(k, 1);
      const cand = scratchCand;
      cand.length = 0;
      const put = (w: number, x: number, y: number, z: number, r: number, g: number, b: number, i: number, rad: number) => {
        const c = candAt(cand.length);
        c.w = w; c.x = x; c.y = y; c.z = z; c.r = r; c.g = g; c.b = b; c.i = i; c.rad = rad;
        cand.push(c);
      };
      for (const L of lights) {
        const age = now - L.birth;
        const i = L.i * Math.exp(-age * L.decay) * Math.min(1, age * 40 + 0.2);
        const d = Math.hypot(L.x - camX, L.y - camY, L.z - camZ);
        put(i / (1 + d * 0.002), L.x, L.y, L.z, L.r, L.g, L.b, i, L.radius);
      }
      for (const f of fires) {
        if (!f.light) continue;
        const fl = 0.8 + 0.2 * Math.sin(now * 13 + f.x) * Math.sin(now * 7.3 + f.z);
        const i = f.intensity * 1.6 * fl * Math.min(1, (f.until - now) / 10);
        const d = Math.hypot(f.x - camX, f.y - camY, f.z - camZ);
        put(i / (1 + d * 0.002), f.x, f.y + f.radius, f.z, 1, 0.5, 0.18, i, f.radius * 4 + 8);
      }
      cand.sort((a, b) => b.w - a.w);
      const nL = Math.min(MAX_LIGHTS, cand.length);
      const Lp = u.uLights.value, Lc = u.uLightCol.value;
      for (let k = 0; k < nL; k++) {
        const c = cand[k];
        Lp[k].set(c.x, c.y, c.z, c.i);
        Lc[k].set(c.r, c.g, c.b, c.rad);
      }
      u.uLightCount.value = nL;
      alpha.flush();
      add.flush();
      decals.flush();
    },
    clear() {
      alpha.clear();
      add.clear();
      decals.clear();
      lights.length = 0;
      fires.length = 0;
      impacts.length = 0;
      violence = 0;
      violenceAcc = 0;
    },
    setBudgets(particles, dec) {
      alpha.resize(Math.floor(particles * 0.55));
      add.resize(Math.floor(particles * 0.45));
      decals.resize(dec);
    },
  };
  return fx;
}

interface Cand { w: number; x: number; y: number; z: number; r: number; g: number; b: number; i: number; rad: number }
const candPool: Cand[] = [];
const scratchCand: Cand[] = [];
function candAt(k: number): Cand {
  while (candPool.length <= k) candPool.push({ w: 0, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, i: 0, rad: 0 });
  return candPool[k];
}
