// FRONT ULTRA — nuclear detonations, the showpiece (owner: units / fx).
// Per detonation ("slot"), all scaled by the bomb's yield:
//   * fireball: an instanced noise-turbulent HDR sphere cooling white -> yellow -> orange -> dull red, rising
//     into the cap,
//   * mushroom cloud: hundreds of CPU-animated, depth-SORTED volumetric puffs (stem, rolling toroidal cap, cap
//     dome, base surge skirt, condensation collar). Each puff is shaded as a sphere: sun-lit with the planet's
//     terminator, lit from below by the fireball (inverse-square), self-emissive while hot,
//   * shockwave: a surface-conforming ring racing across the planet out to the bomb's outer radius,
//   * condensation (Wilson) dome flashing out around the fireball,
//   * burning ground: a surface disk of embers that glows and fades over a minute (the scar itself is the
//     globe's fallout layer, driven by the sim's scars).
// Draw calls: fireballs 1, puffs 1, rings 1, domes 1, ground 1 (instanced across all live detonations).

import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/constants';
import { sharedUniforms } from '../units/common';

const MAX_SLOTS = 24;

const NOISE = /* glsl */ `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
vec3 blackbody(float t) {
  // t: 0 (cold) .. 1 (white hot). HDR.
  vec3 c = t > 0.75 ? mix(vec3(1.0, 0.72, 0.36) * 10.0, vec3(1.0, 0.95, 0.88) * 24.0, (t - 0.75) / 0.25)
         : t > 0.45 ? mix(vec3(1.0, 0.38, 0.08) * 4.0, vec3(1.0, 0.72, 0.36) * 10.0, (t - 0.45) / 0.3)
         : t > 0.15 ? mix(vec3(0.55, 0.1, 0.02) * 1.0, vec3(1.0, 0.38, 0.08) * 4.0, (t - 0.15) / 0.3)
         : mix(vec3(0.0), vec3(0.55, 0.1, 0.02), t / 0.15);
  return c;
}
`;

// ---------------------------------------------------------------------------------------------------------
// Fireball
// ---------------------------------------------------------------------------------------------------------
const FIRE_VERT = /* glsl */ `
attribute vec4 iFire; // temperature, intensity, time, alpha
varying vec3 vN;
varying vec3 vObj;
varying vec4 vFire;
varying vec3 vWorld;
void main() {
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(instanceMatrix) * normal);
  vObj = position;
  vFire = iFire;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FIRE_FRAG = /* glsl */ `
${NOISE}
varying vec3 vN;
varying vec3 vObj;
varying vec4 vFire;
varying vec3 vWorld;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(normalize(vN), V), 0.0, 1.0);
  float t = vFire.z;
  float n = fbm3(vObj * 3.2 + vec3(0.0, -t * 0.9, t * 0.3));
  float n2 = fbm3(vObj * 7.5 - vec3(t * 0.6));
  float temp = vFire.x * (0.72 + 0.45 * n + 0.2 * n2) * mix(0.72, 1.0, ndv);
  vec3 col = blackbody(clamp(temp, 0.0, 1.0)) * vFire.y;
  // Dark soot cells creeping in as it cools.
  float soot = smoothstep(0.55, 0.8, n2 + (1.0 - vFire.x) * 0.6);
  col *= 1.0 - soot * 0.75 * (1.0 - vFire.x);
  float a = vFire.w * mix(0.55, 1.0, smoothstep(0.0, 0.4, ndv));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------------------
// Puffs (mushroom cloud)
// ---------------------------------------------------------------------------------------------------------
const PUFF_VERT = /* glsl */ `
attribute vec4 iPos;   // world xyz, radius (world units)
attribute vec4 iA;     // heat, alpha, ao, seed
attribute vec4 iF;     // fireball world xyz, fire light intensity
attribute vec4 iO;     // outward structural normal xyz, dustiness
uniform vec3 uSunDir;
uniform float uPixelK;
varying vec2 vUv;
varying vec2 vQ;
varying vec4 vA;
varying vec3 vOut;
varying vec3 vWorld;
varying vec3 vFireDir;
varying float vFireI;
varying float vDay;
varying float vDust;
varying vec3 vRight;
varying vec3 vUpv;
varying vec3 vToCam;
void main() {
  vec3 p = iPos.xyz;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 1e-6);
  float size = max(iPos.w, 2.0 * uPixelK * dist);
  float ang = iA.w * 6.2831;
  vec2 c = position.xy;
  vec2 rc = vec2(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
  mv.xy += c * size;
  mv.z += size * 0.6;
  gl_Position = projectionMatrix * mv;
  vUv = rc * 0.5 + 0.5;
  vQ = c;
  vA = iA;
  vOut = iO.xyz;
  vDust = iO.w;
  vWorld = p;
  vec3 fd = iF.xyz - p;
  float fl = length(fd);
  vFireDir = fd / max(fl, 1e-9);
  vFireI = iF.w;
  vec3 up = normalize(p);
  vDay = smoothstep(-0.12, 0.2, dot(up, uSunDir));
  // Camera basis in world space (rows of the view matrix).
  vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vUpv = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vToCam = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
}
`;
const PUFF_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D uAtlas;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec2 vQ;
varying vec4 vA;
varying vec3 vOut;
varying vec3 vWorld;
varying vec3 vFireDir;
varying float vFireI;
varying float vDay;
varying float vDust;
varying vec3 vRight;
varying vec3 vUpv;
varying vec3 vToCam;
void main() {
  vec2 cellO = vec2(vA.w > 0.5 ? 0.0 : 0.5, 0.0);
  vec4 tx = texture2D(uAtlas, cellO + clamp(vUv, 0.01, 0.99) * 0.5);
  float dens = tx.a;
  if (dens < 0.01) discard;
  // Sprite-as-sphere normal (unrotated quad coords give the true screen direction).
  vec2 d = vQ;
  float nz = sqrt(max(0.0, 1.0 - dot(d, d)));
  vec3 Ns = normalize(d.x * vRight + d.y * vUpv + nz * vToCam);
  vec3 N = normalize(Ns * 0.75 + vOut * 0.55);
  float wrap = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float sunUp = dot(normalize(vWorld), uSunDir);
  vec3 sunCol = mix(vec3(1.0, 0.45, 0.2), vec3(1.0, 0.93, 0.84), smoothstep(0.0, 0.35, sunUp)) * 1.7;
  float ao = vA.z;
  float thick = tx.g;
  // Cream-white condensation on top, dirty brown-gray debris below and in the stem.
  vec3 albedo = mix(vec3(0.46, 0.44, 0.42), vec3(0.27, 0.21, 0.16), vDust);
  float selfShadow = mix(0.25, 1.0, ao) * mix(0.7, 1.0, thick);
  vec3 sun = sunCol * pow(wrap, 2.2) * vDay * selfShadow;
  vec3 amb = mix(vec3(0.015, 0.017, 0.024), vec3(0.13, 0.155, 0.2), vDay) * (0.3 + 0.7 * ao);
  // Lit from below / inside by the fireball.
  float fdot = clamp(dot(N, vFireDir) * 0.6 + 0.4, 0.0, 1.0);
  vec3 fire = vec3(1.0, 0.42, 0.12) * vFireI * fdot * 3.2;
  vec3 col = albedo * (sun + amb + fire);
  // Self emission while hot (inner turbulence glows through).
  float n = vnoise(vWorld * 900.0 + vA.w * 10.0);
  col += blackbody(clamp(vA.x * (0.75 + 0.5 * n), 0.0, 1.0)) * vA.x * (0.25 + 0.75 * thick) * 0.8;
  float a = dens * vA.y;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------------------
// Surface layers: shockwave ring & burning ground (surface conforming, horizon-tested, additive)
// ---------------------------------------------------------------------------------------------------------
const SURF_VERT = /* glsl */ `
attribute vec4 iC;  // center (unit sphere dir) xyz, radius (world units)
attribute vec4 iE;  // east xyz, width (fraction of radius)
attribute vec4 iN;  // north xyz, strength
attribute vec4 iX;  // time, lift (world units), seed, kind
varying vec2 vLocal;
varying vec4 vX;
varying float vStrength;
varying float vWidth;
varying vec3 vWorld;
varying float vRadiusKm;
void main() {
  vec2 l = position.xy;
  vec3 dir = normalize(iC.xyz + (iE.xyz * l.x + iN.xyz * l.y) * iC.w);
  vec3 p = dir * (1.0 + iX.y);
  vLocal = l;
  vX = iX;
  vStrength = iN.w;
  vWidth = iE.w;
  vWorld = p;
  vRadiusKm = iC.w * ${EARTH_RADIUS_KM.toFixed(1)};
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const SURF_FRAG = /* glsl */ `
${NOISE}
varying vec2 vLocal;
varying vec4 vX;
varying float vStrength;
varying float vWidth;
varying vec3 vWorld;
varying float vRadiusKm;
void main() {
  // Horizon test: hide what the planet occludes (depth test is off so relief never swallows the ring).
  if (dot(normalize(vWorld), cameraPosition - vWorld) < 0.0) discard;
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  vec3 col;
  float a;
  if (vX.w < 0.5) {
    // Shockwave: a thin, broken, bright pressure front with a warm dust wall trailing it.
    float jitter = (vnoise(vec3(ang * 9.0, vX.z * 10.0, vX.x * 0.8)) - 0.5) * 0.018;
    float e = (r - 1.0 + jitter) / max(vWidth, 1e-4);
    float front = exp(-e * e * 5.0);
    float breakup = 0.55 + 0.45 * vnoise(vec3(ang * 22.0, r * 8.0, vX.z * 5.0 + vX.x * 0.3));
    float band = exp(-max(-e, 0.0) * 0.5) * step(e, 0.0);
    float dust = vnoise(vec3(vLocal * 18.0, vX.x * 0.5)) * 0.7 + 0.3;
    float glow = exp(-abs(e) * 0.9) * 0.18;
    col = vec3(1.25, 1.3, 1.45) * front * breakup * breakup + vec3(0.8, 0.85, 1.0) * glow + vec3(0.55, 0.42, 0.3) * band * dust * 0.3;
    a = vStrength;
    if (r > 1.0 + 3.0 * vWidth) discard;
  } else {
    // Burning ground: ember field with flickering hot spots, charred rim.
    float n = fbm3(vec3(vLocal * 7.0, vX.z * 13.0 + vX.x * 0.12));
    float n2 = vnoise(vec3(vLocal * 30.0, vX.x * 1.5 + vX.z));
    float fall = 1.0 - smoothstep(0.35, 1.0, r + (n - 0.5) * 0.4);
    float hot = smoothstep(0.45, 0.8, n) * (0.6 + 0.4 * n2);
    col = vec3(4.0, 1.3, 0.25) * hot * fall + vec3(0.8, 0.18, 0.03) * fall * 0.35;
    col += vec3(8.0, 5.0, 2.5) * smoothstep(0.35, 0.0, r) * smoothstep(8.0, 0.0, vX.x) * 0.5;
    a = vStrength;
    if (fall <= 0.001) discard;
  }
  gl_FragColor = vec4(col * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------------------
// Condensation (Wilson) dome
// ---------------------------------------------------------------------------------------------------------
const DOME_VERT = /* glsl */ `
attribute vec4 iD; // center xyz (ground), alpha
varying vec3 vN;
varying vec3 vWorld;
varying float vAlpha;
varying vec3 vCenter;
void main() {
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(instanceMatrix) * normal);
  vWorld = wp.xyz;
  vAlpha = iD.w;
  vCenter = iD.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const DOME_FRAG = /* glsl */ `
uniform vec3 uSunDir;
varying vec3 vN;
varying vec3 vWorld;
varying float vAlpha;
varying vec3 vCenter;
void main() {
  vec3 up = normalize(vCenter);
  if (dot(vWorld - vCenter, up) < 0.0) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  float f = 1.0 - abs(dot(normalize(vN), V));
  float rim = pow(f, 2.5);
  float day = smoothstep(-0.12, 0.2, dot(up, uSunDir));
  vec3 col = vec3(1.4, 1.45, 1.55) * (0.25 + 0.9 * day) + vec3(1.2, 0.6, 0.3) * 0.4;
  gl_FragColor = vec4(col, vAlpha * (0.08 + rim * 0.85));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------------------

export interface NukeParams {
  /** 1 = hydrogen bomb, ~0.62 atom bomb, ~0.42 MIRV warhead. */
  yieldK: number;
  /** Shockwave final radius (km). */
  outerKm: number;
  /** Burning ground radius (km). */
  innerKm: number;
}

interface Slot {
  active: boolean;
  t: number;
  p: NukeParams;
  up: THREE.Vector3;
  east: THREE.Vector3;
  north: THREE.Vector3;
  /** Ground point (world). */
  ground: THREE.Vector3;
  groundR: number;
  puffCount: number;
  /** Per puff: role, r0..r4 */
  rnd: Float32Array;
  seed: number;
  // Dimensions (world units).
  H: number;
  R: number;
  r: number;
  stemR: number;
  fbR: number;
  baseR: number;
  outer: number;
  inner: number;
  fireEmitAcc: number;
}

const ROLE_STEM = 0, ROLE_CAP = 1, ROLE_DOME = 2, ROLE_SKIRT = 3, ROLE_COLLAR = 4;
const LIFE = 120;

export interface NukeHooks {
  /** Spawn ground fires & smoke inside the burning disk (particles owned by fx). */
  groundFire(x: number, y: number, z: number, sizeUnits: number, t: number): void;
}

export class NukeSystem {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private fireMesh: THREE.InstancedMesh;
  private fireAttr: THREE.InstancedBufferAttribute;
  private puffGeo: THREE.InstancedBufferGeometry;
  private puffMesh: THREE.Mesh;
  private pPos: THREE.InstancedBufferAttribute;
  private pA: THREE.InstancedBufferAttribute;
  private pF: THREE.InstancedBufferAttribute;
  private pO: THREE.InstancedBufferAttribute;
  private surfGeo: THREE.InstancedBufferGeometry;
  private surfMesh: THREE.Mesh;
  private sC: THREE.InstancedBufferAttribute;
  private sE: THREE.InstancedBufferAttribute;
  private sN: THREE.InstancedBufferAttribute;
  private sX: THREE.InstancedBufferAttribute;
  private domeMesh: THREE.InstancedMesh;
  private domeAttr: THREE.InstancedBufferAttribute;
  private maxPuffs: number;
  private basePuffs: number;
  // Sorting scratch.
  private keys: Float64Array;
  private scratch: Float32Array;
  private m4 = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private hooks: NukeHooks;
  private puffAttrs: THREE.InstancedBufferAttribute[];
  private surfAttrs: THREE.InstancedBufferAttribute[];
  private seedCounter = 1;

  constructor(quality: number, atlas: THREE.Texture, hooks: NukeHooks) {
    this.hooks = hooks;
    // Puffs per H-bomb and global pool by particle budget.
    this.basePuffs = quality >= 30000 ? 1100 : quality >= 15000 ? 800 : quality >= 6000 ? 460 : 240;
    this.maxPuffs = this.basePuffs * 10;
    this.keys = new Float64Array(this.maxPuffs);
    this.scratch = new Float32Array(this.maxPuffs * 16);
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.slots.push({
        active: false, t: 0, p: { yieldK: 1, outerKm: 100, innerKm: 50 }, up: new THREE.Vector3(), east: new THREE.Vector3(),
        north: new THREE.Vector3(), ground: new THREE.Vector3(), groundR: 1, puffCount: 0, rnd: new Float32Array(this.basePuffs * 6),
        seed: 0, H: 0, R: 0, r: 0, stemR: 0, fbR: 0, baseR: 0, outer: 0, inner: 0, fireEmitAcc: 0,
      });
    }

    // Fireballs.
    const fireGeo = new THREE.IcosahedronGeometry(1, 3);
    const fireMat = new THREE.ShaderMaterial({
      name: 'fx-nuke-fireball', vertexShader: FIRE_VERT, fragmentShader: FIRE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.fireMesh = new THREE.InstancedMesh(fireGeo, fireMat, MAX_SLOTS);
    this.fireAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SLOTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    fireGeo.setAttribute('iFire', this.fireAttr);
    this.fireMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fireMesh.count = 0;
    this.fireMesh.frustumCulled = false;
    this.fireMesh.renderOrder = 54;

    // Puffs.
    const pg = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(2, 2);
    pg.index = quad.index;
    pg.setAttribute('position', quad.getAttribute('position'));
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(this.maxPuffs * n), n).setUsage(THREE.DynamicDrawUsage);
    this.pPos = mk(4);
    this.pA = mk(4);
    this.pF = mk(4);
    this.pO = mk(4);
    pg.setAttribute('iPos', this.pPos);
    pg.setAttribute('iA', this.pA);
    pg.setAttribute('iF', this.pF);
    pg.setAttribute('iO', this.pO);
    this.puffAttrs = [this.pPos, this.pA, this.pF, this.pO];
    pg.instanceCount = 0;
    this.puffGeo = pg;
    const puffMat = new THREE.ShaderMaterial({
      name: 'fx-nuke-puffs', vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG,
      uniforms: { uAtlas: { value: atlas }, uSunDir: sharedUniforms.uSunDir, uPixelK: sharedUniforms.uPixelK },
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.puffMesh = new THREE.Mesh(pg, puffMat);
    this.puffMesh.frustumCulled = false;
    this.puffMesh.renderOrder = 55;

    // Surface layers (ring + ground): 2 per slot.
    const ring = new THREE.RingGeometry(0.0, 1.35, 128, 6);
    const sg = new THREE.InstancedBufferGeometry();
    sg.index = ring.index;
    sg.setAttribute('position', ring.getAttribute('position'));
    const mks = () => new THREE.InstancedBufferAttribute(new Float32Array(MAX_SLOTS * 2 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sC = mks();
    this.sE = mks();
    this.sN = mks();
    this.sX = mks();
    sg.setAttribute('iC', this.sC);
    sg.setAttribute('iE', this.sE);
    sg.setAttribute('iN', this.sN);
    sg.setAttribute('iX', this.sX);
    this.surfAttrs = [this.sC, this.sE, this.sN, this.sX];
    sg.instanceCount = 0;
    this.surfGeo = sg;
    const surfMat = new THREE.ShaderMaterial({
      name: 'fx-nuke-surface', vertexShader: SURF_VERT, fragmentShader: SURF_FRAG,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.surfMesh = new THREE.Mesh(sg, surfMat);
    this.surfMesh.frustumCulled = false;
    this.surfMesh.renderOrder = 48;

    // Condensation domes.
    const domeGeo = new THREE.SphereGeometry(1, 32, 16);
    this.domeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SLOTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    domeGeo.setAttribute('iD', this.domeAttr);
    const domeMat = new THREE.ShaderMaterial({
      name: 'fx-nuke-dome', vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
      uniforms: { uSunDir: sharedUniforms.uSunDir },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.domeMesh = new THREE.InstancedMesh(domeGeo, domeMat, MAX_SLOTS);
    this.domeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.domeMesh.count = 0;
    this.domeMesh.frustumCulled = false;
    this.domeMesh.renderOrder = 56;

    this.group.add(this.surfMesh, this.fireMesh, this.puffMesh, this.domeMesh);
  }

  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  /** Age (s) of the most recent detonation, -1 if none. */
  latestAge(): number {
    let best = -1;
    for (const s of this.slots) if (s.active && (best < 0 || s.t < best)) best = s.t;
    return best;
  }

  /** Start a detonation at a ground point (world, on the surface). */
  detonate(ground: THREE.Vector3, p: NukeParams): void {
    let slot = this.slots.find((s) => !s.active);
    if (!slot) {
      // Recycle the oldest.
      slot = this.slots.reduce((a, b) => (a.t > b.t ? a : b));
    }
    slot.active = true;
    slot.t = 0;
    slot.p = { ...p };
    slot.ground.copy(ground);
    slot.groundR = ground.length();
    slot.up.copy(ground).normalize();
    const up = slot.up;
    slot.east.set(-up.z, 0, -up.x);
    if (slot.east.lengthSq() < 1e-8) slot.east.set(1, 0, 0);
    slot.east.normalize();
    slot.north.crossVectors(up, slot.east).normalize();
    slot.seed = this.seedCounter++;
    const y = Math.max(0.2, p.yieldK);
    const Hkm = 250 * Math.pow(y, 0.75);
    const u = 1 / EARTH_RADIUS_KM;
    slot.H = Hkm * u;
    slot.R = Hkm * 0.4 * u;
    slot.r = Hkm * 0.16 * u;
    slot.stemR = Hkm * 0.07 * u;
    slot.fbR = Hkm * 0.17 * u;
    slot.baseR = Hkm * 1.1 * u;
    slot.outer = p.outerKm * u;
    slot.inner = p.innerKm * u;
    slot.fireEmitAcc = 0;
    const n = Math.max(40, Math.min(this.basePuffs, Math.round(this.basePuffs * (0.3 + 0.7 * Math.min(1, y)))));
    slot.puffCount = n;
    // Deterministic per-slot random numbers.
    let st = (slot.seed * 2654435761) >>> 0;
    const rnd = () => {
      st = (Math.imul(st ^ (st >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
      st ^= st >>> 13;
      return (st >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const role = f < 0.19 ? ROLE_STEM : f < 0.7 ? ROLE_CAP : f < 0.83 ? ROLE_DOME : f < 0.96 ? ROLE_SKIRT : ROLE_COLLAR;
      slot.rnd[i * 6] = role;
      for (let k = 1; k < 6; k++) slot.rnd[i * 6 + k] = rnd();
    }
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
    this.fireMesh.count = 0;
    this.puffGeo.instanceCount = 0;
    this.surfGeo.instanceCount = 0;
    this.domeMesh.count = 0;
  }

  warmup(on: boolean): void {
    if (on) {
      this.fireMesh.count = 1;
      this.puffGeo.instanceCount = 1;
      this.surfGeo.instanceCount = 1;
      this.domeMesh.count = 1;
    } else {
      this.clear();
    }
  }

  update(dt: number, camPos: THREE.Vector3, camera: THREE.Camera): void {
    let fireN = 0, puffN = 0, surfN = 0, domeN = 0;
    camera.getWorldDirection(this.camFwd);
    const P = this.scratch;
    for (const s of this.slots) {
      if (!s.active) continue;
      s.t += dt;
      const t = s.t;
      if (t > LIFE) {
        s.active = false;
        continue;
      }
      const fade = 1 - smooth(60, LIFE, t);
      // --- shape over time
      const capH = s.H * (Math.pow(1 - Math.exp(-t / 4.2), 0.85) * 0.92 + 0.08 * smooth(12, 70, t));
      const R = s.R * (0.22 + 0.78 * (1 - Math.exp(-t / 5.5))) + s.R * 0.35 * smooth(15, 100, t);
      const r = s.r * (0.3 + 0.7 * (1 - Math.exp(-t / 3.2))) + s.r * 0.25 * smooth(20, 100, t);
      const fbR = s.fbR * (1 - Math.exp(-t / 0.16)) * (1 - 0.5 * smooth(2.5, 18, t));
      const fbH = Math.max(fbR * 0.55, (capH - r * 0.1) * smooth(0.4, 7, t));
      const temp = Math.max(0, 1 - t / 16) ** 1.3;
      const fireI = Math.exp(-t / 2.4) * 1.3 + 0.7 * Math.exp(-t / 14);
      const up = s.up, east = s.east, north = s.north, g = s.ground;
      // Fireball world position.
      const fx = g.x + up.x * fbH, fy = g.y + up.y * fbH, fz = g.z + up.z * fbH;

      // --- fireball instance
      if (fbR > 1e-9 && t < 22) {
        this.v.set(fx, fy, fz);
        this.q.identity();
        this.s.setScalar(fbR);
        this.m4.compose(this.v, this.q, this.s);
        this.fireMesh.setMatrixAt(fireN, this.m4);
        const fa = this.fireAttr.array as Float32Array;
        fa[fireN * 4] = Math.min(1, 0.25 + temp * 0.85);
        fa[fireN * 4 + 1] = 1.1 * Math.max(0.3, Math.exp(-t / 7));
        fa[fireN * 4 + 2] = t + s.seed * 3.7;
        fa[fireN * 4 + 3] = 1 - smooth(12, 22, t);
        fireN++;
      }

      // --- condensation dome
      if (t > 0.25 && t < 4.5) {
        const k = (t - 0.25) / 4.25;
        const dr = s.H * (0.35 + 0.9 * Math.pow(k, 0.6));
        this.v.copy(g);
        this.q.identity();
        this.s.setScalar(dr);
        this.m4.compose(this.v, this.q, this.s);
        this.domeMesh.setMatrixAt(domeN, this.m4);
        const da = this.domeAttr.array as Float32Array;
        da[domeN * 4] = g.x;
        da[domeN * 4 + 1] = g.y;
        da[domeN * 4 + 2] = g.z;
        da[domeN * 4 + 3] = Math.sin(Math.PI * k) * 0.65 * Math.min(1, s.p.yieldK * 1.3);
        domeN++;
      }

      // --- shockwave ring
      const ringT = t / (18 + 12 * s.p.yieldK);
      if (ringT < 1.25) {
        const k = Math.min(1, ringT);
        const radius = s.outer * (1 - Math.pow(1 - k, 2.2)) + 1e-6;
        const strength = (1 - smooth(0.55, 1.25, ringT)) * Math.min(1, t * 6) * 0.9;
        this.writeSurf(surfN++, s, radius, 0.018 + 0.03 * k, strength, t, 0.0004, 0);
      }
      // --- burning ground
      if (t < 70) {
        const strength = Math.min(1, t * 3) * (1 - smooth(18, 70, t)) * 0.8;
        this.writeSurf(surfN++, s, s.inner * (0.5 + 0.5 * smooth(0, 3, t)), 1, strength, t, 0.0002, 1);
        // Scattered ground fires.
        s.fireEmitAcc += dt * (t < 25 ? 10 : 3) * Math.min(1.5, s.p.yieldK + 0.3);
        while (s.fireEmitAcc > 1) {
          s.fireEmitAcc -= 1;
          const a = Math.random() * Math.PI * 2, rr = Math.pow(Math.random(), 0.7) * s.inner * 0.6;
          const px = g.x + (east.x * Math.cos(a) + north.x * Math.sin(a)) * rr;
          const py = g.y + (east.y * Math.cos(a) + north.y * Math.sin(a)) * rr;
          const pz = g.z + (east.z * Math.cos(a) + north.z * Math.sin(a)) * rr;
          this.v.set(px, py, pz).normalize().multiplyScalar(s.groundR);
          this.hooks.groundFire(this.v.x, this.v.y, this.v.z, s.H * 0.03, t);
        }
      }

      // --- mushroom puffs
      const n = s.puffCount;
      const heatT = Math.exp(-t / 6.5);
      const stemTop = Math.max(0, capH - r * 0.55);
      for (let i = 0; i < n && puffN < this.maxPuffs; i++) {
        const role = s.rnd[i * 6], r1 = s.rnd[i * 6 + 1], r2 = s.rnd[i * 6 + 2], r3 = s.rnd[i * 6 + 3], r4 = s.rnd[i * 6 + 4], r5 = s.rnd[i * 6 + 5];
        let h: number, rad: number, th: number, size: number, alpha: number, heat: number, ao: number, dust: number;
        let ox = 0, oy = 0, oz = 0; // outward normal in (radial, up) space
        th = r1 * Math.PI * 2;
        if (role === ROLE_STEM) {
          const hf = r2;
          h = hf * stemTop;
          const flare = 1 + 1.6 * Math.pow(1 - hf, 3);
          const sr = s.stemR * (0.55 + 0.45 * smooth(0, 6, t)) * flare;
          rad = sr * Math.sqrt(r3) * 0.7;
          th += t * 0.25 * (1 - hf);
          size = sr * (0.65 + 0.45 * r4);
          alpha = smooth(0.8, 4, t) * (0.5 + 0.25 * r5) * (1 - 0.6 * smooth(50, 110, t) * (1 - hf));
          heat = heatT * 0.55 * (0.4 + 0.6 * hf);
          ao = 0.35 + 0.4 * hf;
          dust = 0.6 * (1 - hf) + 0.25;
          ox = 1; oy = 0.1;
        } else if (role === ROLE_CAP) {
          const phi0 = r2 * Math.PI * 2;
          const phi = phi0 - t * 0.32 * (0.6 + 0.4 * r5) * Math.exp(-t / 45);
          const kk = 0.3 + 0.7 * Math.sqrt(r3);
          const cph = Math.cos(phi), sph = Math.sin(phi);
          rad = R + r * kk * cph * 1.15;
          h = capH + r * kk * sph * 0.8;
          size = r * (0.3 + 0.14 * r4) * (1.1 - 0.25 * kk);
          alpha = smooth(0.15, 1.8, t) * (0.45 + 0.3 * r5);
          heat = heatT * (0.75 + 0.25 * -cph) * (0.6 + 0.4 * (1 - kk));
          ao = 0.5 + 0.5 * sph;
          dust = 0.15 + 0.25 * (1 - sph) * 0.5;
          ox = cph; oy = sph;
        } else if (role === ROLE_DOME) {
          const rho = Math.sqrt(r2);
          rad = R * 0.95 * rho;
          h = capH + r * (0.35 + 0.45 * (1 - rho * rho)) * (0.9 + 0.2 * r3);
          size = r * (0.34 + 0.22 * r4);
          alpha = smooth(0.4, 2.5, t) * (0.5 + 0.25 * r5);
          heat = heatT * 0.7;
          ao = 0.95;
          dust = 0.12;
          ox = rho * 0.6; oy = 1;
        } else if (role === ROLE_SKIRT) {
          const grow = 1 - Math.exp(-t / 7);
          rad = s.baseR * (0.2 + 0.8 * r2) * (0.25 + 0.75 * grow);
          h = s.stemR * (0.2 + 0.6 * r3) * (0.4 + 0.6 * grow);
          size = s.stemR * (0.9 + 0.8 * r4) * (0.5 + 0.8 * grow);
          alpha = smooth(0.6, 3, t) * (0.3 + 0.2 * r5) * (1 - smooth(25, 80, t));
          heat = heatT * 0.12;
          ao = 0.55;
          dust = 0.95;
          ox = 0.6; oy = 0.8;
        } else {
          // Collar: condensation ring around the stem at mid height (white, transient).
          h = stemTop * (0.5 + 0.08 * r2);
          rad = s.stemR * (1.5 + 0.9 * r3) + R * 0.12 * smooth(2, 10, t);
          size = s.stemR * (0.35 + 0.3 * r4);
          alpha = smooth(1.5, 4, t) * (1 - smooth(8, 20, t)) * 0.3;
          heat = 0;
          ao = 1;
          dust = 0;
          ox = 0.8; oy = 0.6;
        }
        if (alpha * fade < 0.01) continue;
        // Jitter & slow boil.
        const boil = Math.sin(t * 0.7 + r5 * 20) * 0.08;
        size *= 1 + boil;
        const ct = Math.cos(th), sn = Math.sin(th);
        const dx = east.x * ct + north.x * sn, dy = east.y * ct + north.y * sn, dz = east.z * ct + north.z * sn;
        const px = g.x + dx * rad + up.x * h, py = g.y + dy * rad + up.y * h, pz = g.z + dz * rad + up.z * h;
        const o = puffN * 16;
        P[o] = px; P[o + 1] = py; P[o + 2] = pz; P[o + 3] = size;
        P[o + 4] = heat; P[o + 5] = alpha * fade; P[o + 6] = ao; P[o + 7] = r4;
        P[o + 8] = fx; P[o + 9] = fy; P[o + 10] = fz; P[o + 11] = fireI * (s.fbR * 2.2) / (s.fbR * 2.2 + Math.hypot(px - fx, py - fy, pz - fz));
        const onx = dx * ox + up.x * oy, ony = dy * ox + up.y * oy, onz = dz * ox + up.z * oy;
        const ol = Math.hypot(onx, ony, onz) || 1;
        P[o + 12] = onx / ol; P[o + 13] = ony / ol; P[o + 14] = onz / ol; P[o + 15] = dust;
        // Depth key: farther first (back to front).
        const depth = (px - camPos.x) * this.camFwd.x + (py - camPos.y) * this.camFwd.y + (pz - camPos.z) * this.camFwd.z;
        this.keys[puffN] = Math.floor(Math.max(0, Math.min(1, 1 - depth / 8)) * 1e9) * 65536 + puffN;
        puffN++;
      }
    }
    // Sort puffs back-to-front (packed keys, numeric sort: no allocation).
    if (puffN > 1) {
      const view = this.keys.subarray(0, puffN);
      view.sort();
    }
    const pp = this.pPos.array as Float32Array, pa = this.pA.array as Float32Array;
    const pf = this.pF.array as Float32Array, po = this.pO.array as Float32Array;
    for (let j = 0; j < puffN; j++) {
      const src = (this.keys[j] % 65536) * 16;
      const d = j * 4;
      pp[d] = P[src]; pp[d + 1] = P[src + 1]; pp[d + 2] = P[src + 2]; pp[d + 3] = P[src + 3];
      pa[d] = P[src + 4]; pa[d + 1] = P[src + 5]; pa[d + 2] = P[src + 6]; pa[d + 3] = P[src + 7];
      pf[d] = P[src + 8]; pf[d + 1] = P[src + 9]; pf[d + 2] = P[src + 10]; pf[d + 3] = P[src + 11];
      po[d] = P[src + 12]; po[d + 1] = P[src + 13]; po[d + 2] = P[src + 14]; po[d + 3] = P[src + 15];
    }
    for (const a of this.puffAttrs) {
      a.clearUpdateRanges();
      if (puffN > 0) a.addUpdateRange(0, puffN * 4);
      a.needsUpdate = puffN > 0 || this.puffGeo.instanceCount > 0;
    }
    this.puffGeo.instanceCount = puffN;
    this.fireMesh.count = fireN;
    if (fireN > 0) {
      this.fireMesh.instanceMatrix.needsUpdate = true;
      this.fireAttr.needsUpdate = true;
    }
    this.domeMesh.count = domeN;
    if (domeN > 0) {
      this.domeMesh.instanceMatrix.needsUpdate = true;
      this.domeAttr.needsUpdate = true;
    }
    this.surfGeo.instanceCount = surfN;
    if (surfN > 0) for (const a of this.surfAttrs) a.needsUpdate = true;
    this.group.visible = fireN + puffN + surfN + domeN > 0;
  }

  private writeSurf(i: number, s: Slot, radius: number, width: number, strength: number, t: number, lift: number, kind: number): void {
    const c = this.sC.array as Float32Array, e = this.sE.array as Float32Array;
    const n = this.sN.array as Float32Array, x = this.sX.array as Float32Array;
    const o = i * 4;
    c[o] = s.up.x; c[o + 1] = s.up.y; c[o + 2] = s.up.z; c[o + 3] = radius;
    e[o] = s.east.x; e[o + 1] = s.east.y; e[o + 2] = s.east.z; e[o + 3] = width;
    n[o] = s.north.x; n[o + 1] = s.north.y; n[o + 2] = s.north.z; n[o + 3] = strength;
    x[o] = t; x[o + 1] = s.groundR - 1 + lift; x[o + 2] = (s.seed * 0.137) % 1; x[o + 3] = kind;
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
