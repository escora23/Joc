// FRONT ULTRA — command mode: combat effects (owner: command).
// Explosions (flash + fireball + smoke column + dirt/sparks + debris + point light + crater decal + camera shake +
// distance-attenuated sound), muzzle blasts, impacts, water columns, smoke screens, burning wrecks, dust, missile
// trails, and the decal layer (craters, scorch marks, tank track marks). A fixed pool of point lights lives in the
// scene from init so no program ever recompiles mid-battle.

import * as THREE from 'three';
import type { SfxCue } from '../../shared/api';
import { PK, Particles } from './particles';
import { Ribbons } from './ribbons';

const MAX_LIGHTS = 4;
const MAX_DEBRIS = 120;

export interface FxHooks {
  /** Play a sound at a world position (the effects layer attenuates by camera distance). */
  sound(cue: SfxCue, gain: number): void;
  /** Camera shake impulse (0..1+). */
  shake(amount: number): void;
}

interface LightSlot {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
}

interface Debris {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  rv: THREE.Vector3;
  s: number;
  life: number;
  burning: boolean;
}

const DECAL_VERT = /* glsl */ `
attribute vec4 iCell; // x = cell, y = alpha
varying vec2 vUv;
varying float vAlpha;
varying float vFog;
uniform float uFogDensity;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  float cell = iCell.x;
  vec2 off = vec2(mod(cell, 2.0) * 0.5, 0.5 - floor(cell / 2.0) * 0.5);
  vUv = uv * 0.5 + off;
  vAlpha = iCell.y;
  float d = length(mv.xyz);
  vFog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
}
`;
const DECAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
uniform vec3 uFogColor;
varying vec2 vUv;
varying float vAlpha;
varying float vFog;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  vec3 c = mix(t.rgb * uLight, uFogColor, vFog);
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class DecalPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly cells: Float32Array;
  private readonly attr: THREE.InstancedBufferAttribute;
  private next = 0;
  private used = 0;
  constructor(readonly cap: number, material: THREE.ShaderMaterial, name: string) {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.cells = new Float32Array(cap * 4);
    this.attr = new THREE.InstancedBufferAttribute(this.cells, 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iCell', this.attr);
    this.mesh = new THREE.InstancedMesh(g, material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }
  add(m: THREE.Matrix4, cell: number, alpha: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.used = Math.min(this.cap, this.used + 1);
    this.mesh.setMatrixAt(i, m);
    this.cells[i * 4] = cell;
    this.cells[i * 4 + 1] = alpha;
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.needsUpdate = true;
  }
  clear(): void {
    this.next = 0;
    this.used = 0;
    this.mesh.count = 0;
  }
}

export class Effects {
  readonly group = new THREE.Group();
  readonly particles: Particles;
  /** Wingtip vortices / vapor trails. */
  readonly ribbons = new Ribbons();
  private readonly lights: LightSlot[] = [];
  private readonly debris: Debris[] = [];
  private readonly debrisMesh: THREE.InstancedMesh;
  private readonly decalMat: THREE.ShaderMaterial;
  readonly craters: DecalPool;
  readonly tracks: DecalPool;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private rng = 12345;
  hooks: FxHooks = { sound: () => undefined, shake: () => undefined };
  /** Camera position (listener) for sound attenuation and shake falloff. */
  readonly listener = new THREE.Vector3();
  /** Ground height function (set by the world). */
  heightAt: (x: number, z: number) => number = () => 0;
  normalAt: (x: number, z: number, out: THREE.Vector3) => THREE.Vector3 = (_x, _z, o) => o.set(0, 1, 0);
  /** Prevailing wind (m/s) that bends smoke columns. */
  readonly wind = new THREE.Vector3(1.6, 0, 0.7);
  /** Distance scale for sound/shake falloff (jets fight over kilometres). */
  hearing = 600;

  constructor(atlas: THREE.Texture, decalAtlas: THREE.Texture, particleCap: number, decalCap: number, debrisMat: THREE.Material) {
    this.particles = new Particles(atlas, particleCap);
    this.group.add(this.particles.group, this.ribbons.mesh);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffa860, 0, 60, 2);
      l.castShadow = false;
      this.group.add(l);
      this.lights.push({ light: l, age: 1, life: 0, peak: 0 });
    }
    const dg = new THREE.BoxGeometry(1, 0.6, 1.4);
    this.debrisMesh = new THREE.InstancedMesh(dg, debrisMat, MAX_DEBRIS);
    this.debrisMesh.count = 0;
    this.debrisMesh.castShadow = true;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.name = 'debris';
    this.group.add(this.debrisMesh);
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), rv: new THREE.Vector3(), s: 1, life: 0, burning: false });
    }
    this.decalMat = new THREE.ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: {
        uMap: { value: decalAtlas },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uFogColor: { value: new THREE.Color() },
        uFogDensity: { value: 0.0003 },
      },
    });
    this.craters = new DecalPool(decalCap, this.decalMat, 'decals-craters');
    this.tracks = new DecalPool(1600, this.decalMat, 'decals-tracks');
    this.group.add(this.craters.mesh, this.tracks.mesh);
  }

  /** Pre-bound random (no per-call closure allocation in hot paths). */
  private readonly rnd = (): number => this.rand();

  rand(): number {
    let s = this.rng;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rng = s >>> 0 || 7;
    return this.rng / 4294967296;
  }
  private sr(): number {
    return this.rand() * 2 - 1;
  }

  seed(n: number): void {
    this.rng = (n >>> 0) || 7;
  }

  setAtmosphere(fog: THREE.Color, density: number, light: THREE.Color): void {
    this.particles.setFog(fog, density, light);
    this.ribbons.setFog(fog, density, light);
    (this.decalMat.uniforms.uFogColor.value as THREE.Color).copy(fog);
    this.decalMat.uniforms.uFogDensity.value = density;
    (this.decalMat.uniforms.uLight.value as THREE.Color).copy(light);
  }

  clear(): void {
    this.particles.clear();
    this.ribbons.clear();
    for (const l of this.lights) {
      l.light.intensity = 0;
      l.age = l.life = 1;
    }
    for (const d of this.debris) d.alive = false;
    this.debrisMesh.count = 0;
    this.craters.clear();
    this.tracks.clear();
  }

  warmup(on: boolean): void {
    this.particles.warmup(on);
    this.ribbons.warmup(on);
    if (on) {
      this.m.makeTranslation(0, 0, -5);
      this.craters.add(this.m, 0, 1);
      this.debrisMesh.count = 1;
      this.debrisMesh.setMatrixAt(0, this.m);
    } else {
      this.craters.clear();
      this.debrisMesh.count = 0;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private dist(p: THREE.Vector3): number {
    return this.listener.distanceTo(p);
  }

  playAt(cue: SfxCue, p: THREE.Vector3, gain: number): void {
    const d = this.dist(p);
    const g = gain / (1 + (d / this.hearing) * (d / this.hearing));
    if (g > 0.03) this.hooks.sound(cue, Math.min(1, g));
  }

  shakeAt(p: THREE.Vector3, amount: number, radius: number): void {
    const d = this.dist(p);
    const k = amount * Math.max(0, 1 - d / radius);
    if (k > 0.01) this.hooks.shake(k);
  }

  light(p: THREE.Vector3, intensity: number, life: number, range: number, color = 0xffa05a): void {
    let best = this.lights[0];
    for (const l of this.lights) if (l.age / Math.max(0.001, l.life) > best.age / Math.max(0.001, best.life)) best = l;
    best.light.position.copy(p);
    best.light.distance = range;
    best.light.color.setHex(color);
    best.peak = intensity;
    best.age = 0;
    best.life = life;
    best.light.intensity = intensity;
  }

  decal(x: number, z: number, size: number, cell: number, alpha: number, yaw?: number): void {
    const y = this.heightAt(x, z);
    if (y < -0.2) return;
    this.normalAt(x, z, this.v);
    this.q.setFromUnitVectors(this.up, this.v);
    this.q2.setFromAxisAngle(this.up, yaw ?? this.rand() * Math.PI * 2);
    this.q.multiply(this.q2);
    this.s.set(size, 1, size);
    this.m.compose(this.v.set(x, y + 0.08, z), this.q, this.s);
    this.craters.add(this.m, cell, alpha);
  }

  trackMark(x: number, z: number, yaw: number, width: number, len: number): void {
    const y = this.heightAt(x, z);
    if (y < 0) return;
    this.normalAt(x, z, this.v);
    this.q.setFromUnitVectors(this.up, this.v);
    this.q2.setFromAxisAngle(this.up, yaw);
    this.q.multiply(this.q2);
    this.s.set(width, 1, len);
    this.m.compose(this.v.set(x, y + 0.06, z), this.q, this.s);
    this.tracks.add(this.m, 2, 0.8);
  }

  // ---------------------------------------------------------------------------------------------
  // Composite effects
  // ---------------------------------------------------------------------------------------------

  /** Big explosion. kind: ground (dirt + crater), air (no crater), vehicle (debris + fire), water (column). */
  explosion(p: THREE.Vector3, scale: number, kind: 'ground' | 'air' | 'vehicle' | 'water'): void {
    const P = this.particles;
    const s = scale;
    const r = this.rnd;
    if (kind === 'water') {
      this.waterColumn(p, s * 1.4);
      P.emit(PK.Flash, p.x, p.y + 1, p.z, 0, 0, 0, 0.16, 4 * s, 9 * s, 2.6, 2.0, 1.5, 1);
      this.light(p, 14 * s, 0.25, 40 * s);
      this.playAt(s > 1.4 ? 'explosionLarge' : 'explosionSmall', p, 0.9);
      this.shakeAt(p, 0.35 * s, 140 * s);
      return;
    }
    // Flash + fireball
    P.emit(PK.Flash, p.x, p.y + 0.5 * s, p.z, 0, 0, 0, 0.14, 4 * s, 10 * s, 3.2, 2.4, 1.6, 1);
    P.emit(PK.Flash, p.x, p.y + 0.5 * s, p.z, 0, 0, 0, 0.5, 4 * s, 9 * s, 1.6, 0.8, 0.3, 0.7);
    const nFire = Math.round(14 + 10 * s);
    for (let i = 0; i < nFire; i++) {
      const vx = this.sr() * 9 * s, vy = (kind === 'air' ? this.sr() * 8 : 3 + r() * 13) * s, vz = this.sr() * 9 * s;
      P.emit(PK.Fire, p.x + this.sr() * s, p.y + r() * s, p.z + this.sr() * s, vx, vy, vz, 0.6 + r() * 0.8, (2 + r() * 2.5) * s, (5.5 + r() * 5) * s, 1, 1, 1, 0.95);
    }
    // Dense slow core so the fireball stays filled while the outer flames billow out.
    for (let i = 0; i < 6; i++) {
      P.emit(PK.Fire, p.x + this.sr() * s, p.y + (0.5 + r()) * s, p.z + this.sr() * s, this.sr() * 2 * s, (2 + r() * 4) * s, this.sr() * 2 * s,
        0.9 + r() * 0.6, (3 + r() * 2) * s, (6 + r() * 3) * s, 1, 1, 1, 0.9);
    }
    // Smoke column
    const nSmoke = Math.round(10 + 8 * s);
    for (let i = 0; i < nSmoke; i++) {
      const g = 0.07 + r() * 0.07;
      P.emit(PK.Smoke, p.x + this.sr() * 2 * s, p.y + r() * 3 * s, p.z + this.sr() * 2 * s,
        this.sr() * 4 * s, (2 + r() * 8) * s, this.sr() * 4 * s, 3.5 + r() * 5 * s, (2.5 + r() * 2) * s, (10 + r() * 8) * s, g, g * 0.95, g * 0.9, 0.85);
    }
    // Sparks / hot fragments
    for (let i = 0; i < 18 + 10 * s; i++) {
      const sp = (20 + r() * 40) * Math.sqrt(s);
      this.v.set(this.sr(), r() * 1.2 + 0.1, this.sr()).normalize().multiplyScalar(sp);
      P.emit(PK.Spark, p.x, p.y + 0.5, p.z, this.v.x, this.v.y, this.v.z, 0.6 + r() * 1.2, 0.25 * s, 0.1 * s, 3, 1.8, 0.8, 1);
    }
    if (kind === 'ground' || kind === 'vehicle') {
      // Dirt clods thrown up + dust ring
      const dirt = kind === 'ground' ? 26 + 16 * s : 10;
      for (let i = 0; i < dirt; i++) {
        this.v.set(this.sr() * 0.7, 0.6 + r() * 1.0, this.sr() * 0.7).normalize().multiplyScalar((10 + r() * 22) * Math.sqrt(s));
        P.emit(PK.Dirt, p.x, p.y + 0.3, p.z, this.v.x, this.v.y, this.v.z, 1.2 + r() * 1.2, 0.35 * s, 0.3 * s, 0.1, 0.075, 0.05, 1);
      }
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const sp = (8 + r() * 6) * s;
        P.emit(PK.Dust, p.x + Math.cos(a) * s, p.y + 0.5, p.z + Math.sin(a) * s, Math.cos(a) * sp, 0.8 + r(), Math.sin(a) * sp, 2.5 + r() * 2, 2 * s, 9 * s, 0.34, 0.29, 0.22, 0.6);
      }
      if (kind === 'ground') this.decal(p.x, p.z, 5 * s + 2, 1, 0.95);
    }
    if (kind === 'vehicle') {
      for (let i = 0; i < 6; i++) this.spawnDebris(p, s, i < 2);
      this.decal(p.x, p.z, 6 * s + 3, 0, 0.9);
    }
    this.light(p, 22 * s, 0.35 + 0.1 * s, 30 * s + 15);
    this.playAt(s > 1.3 ? 'explosionLarge' : 'explosionSmall', p, 1);
    this.shakeAt(p, 0.55 * s, 160 * s);
  }

  /** Small shell impact on ground / armor: flash + dirt spray, no crater light show. */
  impact(p: THREE.Vector3, n: THREE.Vector3, soft: boolean, metal: boolean): void {
    const P = this.particles;
    const r = this.rnd;
    P.emit(PK.Flash, p.x, p.y, p.z, 0, 0, 0, 0.1, 1.2, 3, 3, 2.3, 1.5, 1);
    if (metal) {
      for (let i = 0; i < 16; i++) {
        this.v.set(n.x + this.sr() * 0.8, n.y + this.sr() * 0.8, n.z + this.sr() * 0.8).normalize().multiplyScalar(15 + r() * 30);
        P.emit(PK.Spark, p.x, p.y, p.z, this.v.x, this.v.y, this.v.z, 0.3 + r() * 0.5, 0.18, 0.06, 3, 2, 1, 1);
      }
      P.emit(PK.Smoke, p.x, p.y, p.z, n.x, n.y + 1, n.z, 1.6, 0.8, 3.5, 0.12, 0.12, 0.12, 0.6);
    } else {
      for (let i = 0; i < (soft ? 10 : 6); i++) {
        this.v.set(n.x * 0.6 + this.sr() * 0.5, 0.7 + r(), n.z * 0.6 + this.sr() * 0.5).normalize().multiplyScalar(6 + r() * 12);
        P.emit(PK.Dirt, p.x, p.y + 0.1, p.z, this.v.x, this.v.y, this.v.z, 0.8 + r() * 0.6, 0.18, 0.14, 0.1, 0.08, 0.055, 1);
      }
      P.emit(PK.Dust, p.x, p.y + 0.3, p.z, 0, 1.2, 0, 1.6 + r(), 1, 4.5, 0.36, 0.31, 0.24, 0.7);
    }
  }

  /** Bullet hit puff (cheap). */
  bulletHit(p: THREE.Vector3, water: boolean): void {
    const P = this.particles;
    if (water) {
      P.emit(PK.Splash, p.x, p.y, p.z, 0, 5 + this.rand() * 4, 0, 0.7, 0.4, 1.4, 0.8, 0.85, 0.9, 0.7);
      return;
    }
    P.emit(PK.Dust, p.x, p.y + 0.1, p.z, this.sr(), 1.5, this.sr(), 0.7, 0.3, 1.4, 0.36, 0.31, 0.24, 0.6);
    if (this.rand() < 0.4) P.emit(PK.Spark, p.x, p.y + 0.1, p.z, this.sr() * 6, 4 + this.rand() * 5, this.sr() * 6, 0.25, 0.12, 0.05, 3, 2, 1, 1);
  }

  /** Big water column (shell splash). */
  waterColumn(p: THREE.Vector3, s: number): void {
    const P = this.particles;
    const r = this.rnd;
    for (let i = 0; i < 26; i++) {
      const up = (14 + r() * 22) * Math.sqrt(s);
      P.emit(PK.Splash, p.x + this.sr() * 1.5 * s, 0.3, p.z + this.sr() * 1.5 * s, this.sr() * 2.5 * s, up, this.sr() * 2.5 * s,
        1.6 + r() * 1.2, (1.2 + r()) * s, (5 + r() * 4) * s, 0.86, 0.9, 0.93, 0.85);
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      P.emit(PK.Foam, p.x + Math.cos(a) * s * 2, 0.2, p.z + Math.sin(a) * s * 2, Math.cos(a) * 6 * s, 0.2, Math.sin(a) * 6 * s, 3 + r() * 2, 3 * s, 10 * s, 0.8, 0.85, 0.88, 0.7);
    }
    P.emit(PK.Steam, p.x, 2, p.z, 0, 2, 0, 3, 4 * s, 14 * s, 0.85, 0.88, 0.9, 0.35);
    this.playAt('explosionSmall', p, 0.5 * s);
  }

  /** Cannon / gun muzzle blast along dir. scale 1 = tank gun. */
  muzzle(p: THREE.Vector3, dir: THREE.Vector3, scale: number, dust = true): void {
    const P = this.particles;
    const r = this.rnd;
    const s = scale;
    P.emit(PK.Flash, p.x + dir.x * 0.5 * s, p.y + dir.y * 0.5 * s, p.z + dir.z * 0.5 * s, 0, 0, 0, 0.09, 2 * s, 4 * s, 4, 3, 1.8, 1);
    for (let i = 0; i < 6; i++) {
      const k = 6 + i * 5;
      P.emit(PK.Muzzle, p.x, p.y, p.z, dir.x * k * s + this.sr() * 2, dir.y * k * s + this.sr() * 2, dir.z * k * s + this.sr() * 2, 0.12, 0.8 * s, 2.2 * s, 1.5, 0.85, 0.4, 1);
    }
    // Side blast from the muzzle brake
    for (let i = 0; i < 8; i++) {
      const sx = this.sr(), sz = this.sr();
      P.emit(PK.SmokeLight, p.x, p.y, p.z, dir.x * 12 * s + sx * 8, dir.y * 12 * s + r() * 2, dir.z * 12 * s + sz * 8, 1.6 + r() * 1.5, 0.8 * s, 5 * s, 0.5, 0.49, 0.46, 0.55);
    }
    if (dust) {
      for (let i = 0; i < 8; i++) {
        const a = r() * Math.PI * 2;
        P.emit(PK.Dust, p.x + Math.cos(a) * 3, this.heightAt(p.x, p.z) + 0.5, p.z + Math.sin(a) * 3, Math.cos(a) * 9 + dir.x * 6, 0.6, Math.sin(a) * 9 + dir.z * 6, 2 + r() * 1.5, 2, 7, 0.36, 0.31, 0.24, 0.5);
      }
    }
    this.light(p, 16 * s, 0.12, 22 * s);
  }

  /** Small arms / autocannon flash (no light, cheap). */
  gunFlash(p: THREE.Vector3, dir: THREE.Vector3, size: number): void {
    const P = this.particles;
    P.emit(PK.Muzzle, p.x + dir.x * size * 0.4, p.y + dir.y * size * 0.4, p.z + dir.z * size * 0.4, dir.x * 4, dir.y * 4, dir.z * 4, 0.05, size * 0.6, size, 2.2, 1.5, 0.7, 1);
  }

  /** Smoke screen grenades: dense white wall in front of dir. */
  smokeScreen(p: THREE.Vector3, dir: THREE.Vector3): void {
    const P = this.particles;
    const r = this.rnd;
    for (let i = 0; i < 70; i++) {
      const a = (r() - 0.5) * 2.2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = dir.x * ca - dir.z * sa, dz = dir.x * sa + dir.z * ca;
      const d = 18 + r() * 16;
      const x = p.x + dx * d, z = p.z + dz * d;
      P.emit(PK.SmokeLight, x, this.heightAt(x, z) + 1 + r() * 3, z, this.sr() * 1.2, 0.5 + r() * 0.6, this.sr() * 1.2, 14 + r() * 8, 5, 14 + r() * 6, 0.82, 0.83, 0.84, 0.9);
      P.setLastGravity(-0.05);
    }
    for (let i = 0; i < 8; i++) P.emit(PK.Flash, p.x + dir.x * 20 + this.sr() * 8, p.y + 2, p.z + dir.z * 20 + this.sr() * 8, 0, 0, 0, 0.2, 2, 4, 4, 3, 2, 1);
  }

  /** Burning wreck: call every frame with dt; intensity fades toward 0. `size` scales it (1 = tank, 3 = warship). */
  burn(p: THREE.Vector3, intensity: number, dt: number, size = 1): void {
    const P = this.particles;
    const r = this.rnd;
    const z = size, zs = Math.sqrt(size);
    const rate = 22 * intensity * zs;
    let n = rate * dt;
    while (n > 0) {
      if (r() < n) {
        P.emit(PK.Fire, p.x + this.sr() * 1.2 * z, p.y + r() * 0.8 * z, p.z + this.sr() * 1.2 * z, this.sr() * 0.8, (2 + r() * 3) * zs, this.sr() * 0.8, 0.5 + r() * 0.6, 1.0 * z, 2.6 * z, 1, 1, 1, 0.9 * intensity);
        if (r() < 0.6) {
          const g = 0.06 + r() * 0.06;
          P.emit(PK.Smoke, p.x + this.sr() * z, p.y + 1.5 * z, p.z + this.sr() * z, this.sr() * 0.8 + this.wind.x, (3.5 + r() * 2.5) * zs, this.sr() * 0.8 + this.wind.z, 9 + r() * 7, 2.6 * z, (20 + r() * 10) * z, g, g * 0.97, g * 0.94, 0.62);
          P.setLastGravity(-3.2 * zs);
        }
        if (r() < 0.2) P.emit(PK.Ember, p.x, p.y + 1, p.z, this.sr() * 3, 3 + r() * 5, this.sr() * 3, 1.5 + r(), 0.12, 0.05, 3, 1.5, 0.5, 1);
      }
      n -= 1;
    }
  }

  /** Burning warship: tall flames and a thick, roiling black smoke plume leaning downwind. Call every frame. */
  shipFire(p: THREE.Vector3, intensity: number, dt: number, size: number): void {
    const P = this.particles;
    const r = this.rnd;
    let n = 16 * intensity * dt;
    while (n > 0) {
      if (r() < n) {
        P.emit(PK.Fire, p.x + this.sr() * 3 * size, p.y + r() * 2, p.z + this.sr() * 3 * size, this.sr() * 1.5, 4 + r() * 5, this.sr() * 1.5,
          0.7 + r() * 0.7, 4 * size, 9 * size, 1, 1, 1, 0.95);
        const g = 0.035 + r() * 0.04;
        P.emit(PK.Smoke, p.x + this.sr() * 2 * size, p.y + 3 * size, p.z + this.sr() * 2 * size, this.wind.x * 2.5 + this.sr() * 1.5, 8 + r() * 5,
          this.wind.z * 2.5 + this.sr() * 1.5, 10 + r() * 7, 10 * size, (38 + r() * 18) * size, g, g * 0.96, g * 0.92, 0.85);
        P.setLastGravity(-2.5);
        if (r() < 0.3) P.emit(PK.Ember, p.x, p.y + 3, p.z, this.sr() * 6, 6 + r() * 8, this.sr() * 6, 2 + r(), 0.25, 0.1, 3, 1.5, 0.5, 1);
      }
      n -= 1;
    }
  }

  /** Tall distant smoke column (burning villages / vehicles on the horizon): call every frame. */
  column(p: THREE.Vector3, intensity: number, dt: number): void {
    if (this.rand() > dt * 2.2 * intensity) return;
    const g = 0.07 + this.rand() * 0.05;
    this.particles.emit(PK.Smoke, p.x + this.sr() * 4, p.y + 3, p.z + this.sr() * 4, this.wind.x * 1.4 + this.sr(), 5 + this.rand() * 2,
      this.wind.z * 1.4 + this.sr(), 26 + this.rand() * 10, 10, 60 + this.rand() * 25, g, g * 0.96, g * 0.92, 0.5);
    this.particles.setLastGravity(-5.5);
    if (this.rand() < 0.5) this.particles.emit(PK.Fire, p.x + this.sr() * 3, p.y + 1, p.z + this.sr() * 3, 0, 3, 0, 0.9, 4, 8, 1, 1, 1, 0.8);
  }

  /** Damage smoke from a hit vehicle (`size` 1 = tank, 3 = warship). */
  damageSmoke(p: THREE.Vector3, dt: number, amount: number, size = 1): void {
    if (this.rand() > amount * dt * 12 * Math.sqrt(size)) return;
    const g = 0.1 + this.rand() * 0.08;
    const z = size;
    this.particles.emit(PK.Smoke, p.x + this.sr() * 0.5 * z, p.y, p.z + this.sr() * 0.5 * z, this.sr() * 0.5 + 0.8 * z, 2.5 * Math.sqrt(z), this.sr() * 0.5 + 0.4 * z,
      3 + this.rand() * 3 * z, 0.8 * z, 5 * z * (1 + amount), g, g, g, 0.7);
  }

  /** Dust kicked up by tracks / wheels. */
  dust(x: number, y: number, z: number, vx: number, vz: number, amount: number): void {
    if (this.rand() > amount) return;
    this.particles.emit(PK.Dust, x + this.sr() * 0.6, y + 0.3, z + this.sr() * 0.6, vx * 0.3 + this.sr(), 0.6 + this.rand() * 0.8, vz * 0.3 + this.sr(), 1.8 + this.rand() * 1.6, 1.0, 4.5 + this.rand() * 2, 0.4, 0.34, 0.26, 0.45);
  }

  /** Missile / rocket exhaust trail puff + flame sprite. */
  trail(p: THREE.Vector3, v: THREE.Vector3, dense: number, flame = true): void {
    const P = this.particles;
    if (flame) P.glow(p.x, p.y, p.z, 2.2, 6, 3.4, 1.4, 1);
    if (this.rand() < dense) {
      P.emit(PK.SmokeLight, p.x, p.y, p.z, v.x * 0.03 + this.sr() * 0.8, v.y * 0.03 + this.sr() * 0.8, v.z * 0.03 + this.sr() * 0.8, 2.6 + this.rand() * 2.2, 0.9, 3.8, 0.78, 0.78, 0.8, 0.55);
      P.setLastGravity(-0.1);
    }
  }

  /** Continuous rocket-motor smoke trail between two positions (evenly spaced puffs). */
  trailSeg(a: THREE.Vector3, b: THREE.Vector3, scale: number): void {
    const P = this.particles;
    const d = a.distanceTo(b);
    const spacing = 1.3 * scale;
    const n = Math.min(18, Math.max(1, Math.floor(d / spacing)));
    for (let i = 0; i < n; i++) {
      const t = (i + this.rand()) / n;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      const life = 2.6 + this.rand() * 2.2;
      P.emit(PK.SmokeLight, x, y, z, this.sr() * 0.5, this.sr() * 0.5 + 0.3, this.sr() * 0.5, life, 0.9 * scale, 3.0 * scale, 0.82, 0.82, 0.84, 0.32);
      P.setLastGravity(-0.15);
    }
  }

  /** Ship wake foam + bow spray. */
  wake(p: THREE.Vector3, side: THREE.Vector3, speed: number, size: number): void {
    const P = this.particles;
    if (this.rand() > Math.min(0.45, speed / 20)) return;
    for (const s of [-1, 1]) {
      const k = 0.4 + this.rand() * 0.6;
      P.emit(PK.Foam, p.x + side.x * s * size * 0.45 * k, 0.25, p.z + side.z * s * size * 0.45 * k, side.x * s * (1.5 + this.rand() * 2.5), 0, side.z * s * (1.5 + this.rand() * 2.5),
        10 + this.rand() * 6, size * 0.3, size * 1.2, 0.8, 0.84, 0.88, 0.22);
    }
    // Propeller wash: churned turquoise-white centerline.
    P.emit(PK.Foam, p.x + this.sr() * 2, 0.2, p.z + this.sr() * 2, 0, 0, 0, 7 + this.rand() * 4, size * 0.25, size * 0.7, 0.7, 0.82, 0.84, 0.25);
  }

  bowSpray(p: THREE.Vector3, dir: THREE.Vector3, speed: number): void {
    if (this.rand() > speed / 14) return;
    const P = this.particles;
    for (const s of [-1, 1]) {
      P.emit(PK.Splash, p.x, 0.8, p.z, -dir.z * s * 5 + dir.x * 3, 4 + this.rand() * 4, dir.x * s * 5 + dir.z * 3, 1.0, 0.8, 3.2, 0.85, 0.9, 0.93, 0.6);
    }
  }

  /** Decoy flare (bright falling light with smoke). */
  flare(p: THREE.Vector3, v: THREE.Vector3): void {
    this.particles.emit(PK.Flare, p.x, p.y, p.z, v.x, v.y, v.z, 3.5, 2.8, 1.2, 12, 8, 4, 1);
  }

  private spawnDebris(p: THREE.Vector3, s: number, burning: boolean): void {
    let d = this.debris.find((x) => !x.alive);
    if (!d) d = this.debris[Math.floor(this.rand() * this.debris.length)];
    d.alive = true;
    d.p.copy(p);
    d.p.y += 1;
    d.v.set(this.sr() * 10, 8 + this.rand() * 14, this.sr() * 10).multiplyScalar(Math.sqrt(s));
    d.r.set(this.rand() * 6, this.rand() * 6, this.rand() * 6);
    d.rv.set(this.sr() * 8, this.sr() * 8, this.sr() * 8);
    d.s = 0.3 + this.rand() * 0.6 * s;
    d.life = 10 + this.rand() * 6;
    d.burning = burning;
  }

  /** Throw a large piece (e.g. a turret) as debris with an initial velocity. Returns nothing; purely visual. */
  update(dt: number): void {
    this.ribbons.update(dt);
    // Lights
    for (const l of this.lights) {
      if (l.age >= l.life) {
        l.light.intensity = 0;
        continue;
      }
      l.age += dt;
      const t = Math.min(1, l.age / l.life);
      l.light.intensity = l.peak * (1 - t) * (1 - t);
    }
    // Debris
    let n = 0;
    for (const d of this.debris) {
      if (!d.alive) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.alive = false;
        continue;
      }
      d.v.y -= 9.8 * dt;
      d.p.addScaledVector(d.v, dt);
      const gh = this.heightAt(d.p.x, d.p.z);
      if (d.p.y < gh + d.s * 0.3) {
        d.p.y = gh + d.s * 0.3;
        if (d.v.y < -2) {
          d.v.y *= -0.3;
          d.v.x *= 0.5;
          d.v.z *= 0.5;
          d.rv.multiplyScalar(0.5);
        } else {
          d.v.set(0, 0, 0);
          d.rv.set(0, 0, 0);
        }
      } else {
        d.r.x += d.rv.x * dt;
        d.r.y += d.rv.y * dt;
        d.r.z += d.rv.z * dt;
      }
      if (d.burning && d.life > 4) {
        if (this.rand() < dt * 30) this.particles.emit(PK.Fire, d.p.x, d.p.y, d.p.z, 0, 1, 0, 0.35, 0.5, 1.1, 1, 1, 1, 0.8);
        if (this.rand() < dt * 20) this.particles.emit(PK.Smoke, d.p.x, d.p.y, d.p.z, 0, 1, 0, 2.5, 0.5, 2.5, 0.06, 0.06, 0.06, 0.6);
      }
      this.q.setFromEuler(d.r);
      this.s.setScalar(d.s);
      this.m.compose(d.p, this.q, this.s);
      this.debrisMesh.setMatrixAt(n++, this.m);
    }
    this.debrisMesh.count = n;
    if (n > 0) this.debrisMesh.instanceMatrix.needsUpdate = true;
    this.particles.simulate(dt);
  }

  /** Discard the draw lists of an intermediate substep. */
  discard(): void {
    this.particles.discardFrame();
  }

  /** Upload particles (call once per frame after all immediates were pushed). */
  flush(): void {
    this.particles.flush();
  }
}
