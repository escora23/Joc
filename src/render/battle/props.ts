// FRONT ULTRA — ground battle: roads, villages/towns and vegetation (owner: battle).
//   * roads: ribbon meshes draped on the terrain (asphalt supply roads crossing the front, dirt lateral roads),
//     also used as paths by columns and trucks;
//   * buildings: one instanced draw call (gable-roof houses, flat-roof blocks) with procedural walls, windows (lit at
//     night), roof tiles and war damage (collapsed roofs, charred walls) growing toward the contact line;
//     villages sit at road crossings, towns wherever the real city-lights/urban splat says so;
//   * trees: two instanced draw calls (conifers, broadleaf) scattered by the forest splat with density focused on
//     the battle centre, wind sway, shattered stumps in no-man's-land.

import * as THREE from 'three';
import {
  COARSE_SIZE_M, FINE_SIZE_M, FastRng, GLSL_BATTLE_FRAG, GLSL_BATTLE_HEAD, GLSL_BATTLE_VERT, GLSL_ROT, GLSL_TAIL, noise1,
  type BattleUniforms,
} from './common';
import { FIELD_ROW, FieldFrame, HEDGE_SEG, colHedge, isWoodlot, rowHedge, rowShift, rowWidth } from './fields';
import type { FrontGeom } from './front';
import { broadleafFarGeometry, broadleafGeometry, coniferFarGeometry, coniferGeometry, houseGeometry } from './models';
import type { TerrainPatch } from './terrain';
import { detailSampler, type DetailSampler } from './textures';
import type { Path } from './vehicles';

// ------------------------------------------------------------------------------------------------------------
// Shaders
// ------------------------------------------------------------------------------------------------------------

const roadVert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
attribute vec3 aRoad; // type, along (m), side (-1..1)
varying vec3 vPos;
varying vec3 vRoad;
void main() {
  vPos = position;
  vRoad = aRoad;
  gl_Position = battleProject(position);
}`;

const roadFrag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
uniform sampler2D uDetail;
varying vec3 vPos;
varying vec3 vRoad;
void main() {
  battleFadeDiscard();
  float r = length(vPos.xz);
  if (r > ${(COARSE_SIZE_M * 0.47).toFixed(1)}) discard;
  vec4 d = texture2D(uDetail, vPos.xz / 17.0);
  float side = abs(vRoad.z);
  vec3 alb;
  float a = 1.0;
  if (vRoad.x < 0.5) {
    alb = vec3(0.045, 0.043, 0.042) * (0.8 + 0.4 * d.r);
    float dash = step(0.5, fract(vRoad.y / 9.0)) * (1.0 - smoothstep(0.03, 0.06, side));
    alb = mix(alb, vec3(0.5, 0.48, 0.4), dash * 0.8 * (1.0 - smoothstep(1.0, 4.0, length(fwidth(vPos)))));
    alb = mix(alb, vec3(0.14, 0.11, 0.08), smoothstep(0.75, 1.0, side) * 0.8);
    a = 1.0 - smoothstep(0.9, 1.0, side + d.g * 0.08);
  } else {
    alb = mix(vec3(0.2, 0.15, 0.1), vec3(0.13, 0.1, 0.07), d.r);
    float ruts = smoothstep(0.1, 0.0, abs(side - 0.45)) * 0.4;
    alb *= 1.0 - ruts;
    a = 1.0 - smoothstep(0.6, 1.0, side + (d.g - 0.5) * 0.4);
  }
  // War: mud and scorch on roads in no-man's-land.
  vec2 fc = frontCoords(vPos.xz);
  float belt = 1.0 - smoothstep(uBelt * 0.5, uBelt * 1.3, abs(fc.y));
  alb = mix(alb, vec3(0.08, 0.06, 0.045), belt * 0.7);
  if (a < 0.02) discard;
  vec3 col = battleShade(alb, vec3(0.0, 1.0, 0.0), vPos, 1.0, 1.0);
  col = battleAir(col, vPos);
  gl_FragColor = vec4(col * a, a);
  ${GLSL_TAIL}
}`;

const houseVert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
${GLSL_ROT}
attribute vec2 aPart;
attribute vec4 iP; // x y z yaw
attribute vec4 iS; // w h d roofH
attribute vec4 iK; // wall tone, roof tone, damage, seed
varying vec3 vN;
varying vec3 vPos;
varying vec3 vObj;
varying vec3 vSize;
varying float vMat;
varying vec4 vK;
void main() {
  vec3 p = position;
  int part = int(aPart.x + 0.5);
  float dmg = iK.z;
  vec3 s = iS.xyz;
  vec3 q;
  if (part == 0) {
    q = p * s;
  } else {
    float roofH = iS.w * (1.0 - smoothstep(0.55, 0.75, dmg));
    q = vec3(p.x * s.x, s.y + (p.y - 1.0) * roofH, p.z * s.z);
  }
  // Collapse: upper wall vertices drop irregularly.
  if (dmg > 0.3 && p.y > 0.5) {
    float h = fract(sin(dot(floor(p.xz * 2.0 + 0.5) + iK.w * 13.0, vec2(12.9898, 78.233))) * 43758.5453);
    q.y -= s.y * clamp((dmg - 0.3) * 1.4, 0.0, 0.85) * (0.4 + 0.6 * h);
  }
  vec3 n = normal;
  vObj = vec3(p.x * s.x, q.y, p.z * s.z);
  vSize = s;
  q = rotY(q, iP.w); n = rotY(n, iP.w);
  vec3 wp = iP.xyz + q;
  vPos = wp;
  vN = n;
  vMat = aPart.y;
  vK = iK;
  gl_Position = battleProject(wp);
}`;

const houseFrag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
uniform float uNight;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vObj;
varying vec3 vSize;
varying float vMat;
varying vec4 vK;
void main() {
  battleFadeDiscard();
  int m = int(vMat + 0.5);
  vec3 N = normalize(vN);
  float dmg = vK.z;
  vec3 alb;
  vec3 emit = vec3(0.0);
  if (m == 0) {
    vec3 wallA = vec3(0.52, 0.46, 0.38), wallB = vec3(0.4, 0.4, 0.39), wallC = vec3(0.5, 0.38, 0.28);
    alb = vK.x < 0.4 ? wallA : vK.x < 0.75 ? wallB : wallC;
    alb *= 0.85 + 0.15 * fract(sin(dot(floor(vObj.xy * 3.0), vec2(4.1, 7.7))) * 43.1);
    // Windows: floors every 3 m, bays every 3.2 m along the facade.
    float facadeU = abs(N.x) > 0.5 ? vObj.z : vObj.x;
    float fy = fract(vObj.y / 3.0);
    float fx = fract(facadeU / 3.2 + 0.5);
    float win = step(0.35, fy) * step(fy, 0.8) * step(0.3, fx) * step(fx, 0.7) * step(0.8, vObj.y) * step(abs(N.y), 0.5);
    float bay = floor(facadeU / 3.2 + 0.5) + floor(vObj.y / 3.0) * 7.0 + vK.w * 91.0;
    float lit = step(0.55, fract(sin(bay * 12.9898) * 43758.5453)) * (1.0 - step(0.4, dmg));
    alb = mix(alb, vec3(0.02, 0.025, 0.03), win);
    emit = vec3(1.0, 0.62, 0.3) * win * lit * uNight * 2.2;
  } else if (m == 1) {
    vec3 roofA = vec3(0.3, 0.09, 0.05), roofB = vec3(0.09, 0.09, 0.1), roofC = vec3(0.22, 0.12, 0.08);
    alb = vK.y < 0.5 ? roofA : vK.y < 0.8 ? roofB : roofC;
    alb *= 0.8 + 0.2 * step(0.5, fract(vObj.y * 4.0));
  } else {
    alb = vec3(0.25, 0.2, 0.17);
  }
  // Soot and char grow with damage.
  float soot = smoothstep(0.1, 0.9, dmg) * (0.5 + 0.5 * fract(sin(dot(floor(vObj.xz * 1.3 + vObj.y), vec2(3.1, 5.7))) * 91.3));
  alb = mix(alb, vec3(0.025, 0.02, 0.018), soot * 0.85);
  float ao = mix(0.55, 1.0, smoothstep(0.0, 2.5, vObj.y));
  vec3 col = battleShade(alb, N, vPos, ao, 1.0) + emit;
  col = battleAir(col, vPos);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_TAIL}
}`;

const treeVert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
attribute vec2 aPart;
attribute vec4 iT; // x y z scale
attribute vec4 iU; // hue, seed, broken, yaw
varying vec3 vN;
varying vec3 vPos;
varying float vMat;
varying vec4 vU;
varying float vH;
void main() {
  vec3 p = position;
  vec3 n = normal;
  int part = int(aPart.x + 0.5);
  float broken = iU.z;
  if (broken > 0.5) {
    if (part == 1) p = vec3(0.0, 1.8, 0.0);
    else p.y *= 0.55 + 0.3 * fract(iU.y * 7.0);
  }
  float c = cos(iU.w), s = sin(iU.w);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  p *= iT.w;
  // Wind sway grows with height.
  float h = p.y;
  float sway = sin(uTime * 1.1 + iU.y * 30.0 + iT.x * 0.05) * 0.5 + sin(uTime * 2.3 + iU.y * 11.0) * 0.25;
  p.xz += uWind * sway * h * h * 0.0009;
  vec3 wp = iT.xyz + p;
  vPos = wp;
  vN = n;
  vMat = aPart.y;
  vU = iU;
  vH = position.y;
  gl_Position = battleProject(wp);
}`;

const treeFrag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
uniform vec3 uFoliage;
varying vec3 vN;
varying vec3 vPos;
varying float vMat;
varying vec4 vU;
varying float vH;
void main() {
  battleFadeDiscard();
  vec3 N = normalize(vN);
  vec3 alb;
  float ao = 1.0;
  if (vMat < 0.5) {
    alb = vU.z > 0.5 ? vec3(0.03, 0.025, 0.02) : vec3(0.1, 0.075, 0.05);
  } else {
    alb = uFoliage * (0.75 + 0.5 * vU.x);
    alb = mix(alb, alb * vec3(1.5, 1.15, 0.55), smoothstep(0.85, 1.0, vU.x));
    ao = 0.45 + 0.55 * smoothstep(2.0, 9.0, vH);
  }
  vec3 col = battleShade(alb, N, vPos, ao, 1.0);
  if (vMat > 0.5) {
    // Leaf translucency when backlit.
    vec3 V = normalize(uCamL - vPos);
    float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
    col += alb * uSunCol * back * 0.25;
  }
  col = battleAir(col, vPos);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_TAIL}
}`;

// ------------------------------------------------------------------------------------------------------------

export interface PropsShared {
  roadMat: THREE.ShaderMaterial;
  houseMat: THREE.ShaderMaterial;
  coniferMat: THREE.ShaderMaterial;
  broadMat: THREE.ShaderMaterial;
  houseGeo: THREE.BufferGeometry;
  coniferGeo: THREE.BufferGeometry;
  broadGeo: THREE.BufferGeometry;
  coniferFarGeo: THREE.BufferGeometry;
  broadFarGeo: THREE.BufferGeometry;
  /** CPU sampler of the ground detail texture (woods follow the ground shader's canopy mask). */
  detailAt: DetailSampler;
}

export function createPropsShared(uniforms: BattleUniforms, detail: THREE.DataTexture): PropsShared {
  const roadMat = new THREE.ShaderMaterial({
    vertexShader: roadVert, fragmentShader: roadFrag, uniforms: { ...uniforms, uDetail: { value: detail } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  roadMat.name = 'battle-roads';
  const houseMat = new THREE.ShaderMaterial({ vertexShader: houseVert, fragmentShader: houseFrag, uniforms: { ...uniforms, uNight: { value: 0 } } });
  houseMat.name = 'battle-houses';
  const foliageC = { value: new THREE.Vector3(0.016, 0.03, 0.02) };
  const foliageB = { value: new THREE.Vector3(0.03, 0.047, 0.018) };
  const coniferMat = new THREE.ShaderMaterial({ vertexShader: treeVert, fragmentShader: treeFrag, uniforms: { ...uniforms, uFoliage: foliageC } });
  coniferMat.name = 'battle-trees';
  const broadMat = new THREE.ShaderMaterial({ vertexShader: treeVert, fragmentShader: treeFrag, uniforms: { ...uniforms, uFoliage: foliageB } });
  broadMat.name = 'battle-trees';
  return {
    roadMat, houseMat, coniferMat, broadMat, houseGeo: houseGeometry(), coniferGeo: coniferGeometry(), broadGeo: broadleafGeometry(),
    coniferFarGeo: coniferFarGeometry(), broadFarGeo: broadleafFarGeometry(),
    detailAt: detailSampler(detail),
  };
}

export interface BuildingInfo {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  damage: number;
  burning: boolean;
}

export interface PropsResult {
  group: THREE.Group;
  paths: Path[];
  buildings: BuildingInfo[];
  treeCount: number;
  /** Re-sort the trees into the full-detail (near the camera) and low-poly (far) instanced meshes. */
  updateLod(camX: number, camZ: number): void;
  dispose(): void;
}

export interface PropsOptions {
  treeBudget: number;
  buildingBudget: number;
  conifer: number; // 0..1 share of conifers
  seed: number;
  /** Rotation of the farmland grid (./fields), same as the ground shader's uFieldRot. */
  fieldAngle: number;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** A road polyline across the patch: along the front normal (crossing) or along the tangent (lateral). */
function makeRoad(front: FrontGeom, kind: 'cross' | 'lateral', at: number, seed: number, terrain: TerrainPatch): Float32Array {
  const pts: number[] = [];
  const tmp = new THREE.Vector3();
  const R = COARSE_SIZE_M * 0.5;
  const step = 12;
  for (let s = -R * 1.05; s <= R * 1.05; s += step) {
    let u: number, v: number;
    if (kind === 'cross') {
      v = s;
      u = at + noise1(s / 700, seed) * 180 + noise1(s / 190, seed + 5) * 25;
    } else {
      u = s;
      v = at + noise1(s / 800, seed) * 150 + noise1(s / 230, seed + 9) * 30;
    }
    front.toXZ(u, v, tmp);
    // Straight line space (no meander) for lateral roads: remove the front meander so roads do not wiggle with it.
    if (kind === 'lateral') {
      const off = front.offsetAt(u);
      tmp.x -= front.nx * off;
      tmp.z -= front.nz * off;
    }
    if (Math.hypot(tmp.x, tmp.z) > R * 0.99) continue;
    void terrain;
    pts.push(tmp.x, tmp.z);
  }
  return Float32Array.from(pts);
}

function pathFrom(pts: Float32Array, reverse: boolean, cutAtV: number, front: FrontGeom): Path {
  const n = pts.length / 2;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(reverse ? n - 1 - i : i);
  const uv = new THREE.Vector2();
  const out: number[] = [];
  for (const i of order) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    front.coords(x, z, uv);
    out.push(x, z);
    // Stop just before the contact line.
    if (Math.abs(uv.y) < cutAtV) break;
  }
  const p = Float32Array.from(out);
  const m = p.length / 2;
  const cum = new Float32Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return { pts: p, cum, length: m > 0 ? cum[m - 1] : 0 };
}

function ribbon(pts: Float32Array, width: number, type: number, terrain: TerrainPatch, pos: number[], attr: number[], idx: number[]): void {
  const n = pts.length / 2;
  if (n < 2) return;
  let along = 0;
  const base = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let dx = pts[i1 * 2] - pts[i0 * 2], dz = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    if (i > 0) along += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    for (const s of [-1, 1]) {
      const px = x - dz * s * width * 0.5, pz = z + dx * s * width * 0.5;
      const y = Math.max(terrain.heightAt(px, pz), terrain.heightAt(x, z) - 0.6) + 0.3;
      pos.push(px, y, pz);
      attr.push(type, along, s);
    }
    if (i < n - 1) {
      const a = base + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
}

export function buildProps(terrain: TerrainPatch, front: FrontGeom, shared: PropsShared, opts: PropsOptions): PropsResult {
  const group = new THREE.Group();
  group.name = 'battle-props';
  const rng = new FastRng(opts.seed);
  const splat = new Float32Array(8);
  const tmp = new THREE.Vector3();
  const uv = new THREE.Vector2();
  const R = COARSE_SIZE_M * 0.5;

  const isWater = (x: number, z: number) => terrain.splatAt(x, z, splat) > 0.35 || terrain.heightAt(x, z) < 0.5 && terrain.hasWater;

  // --- roads -------------------------------------------------------------------------------------------------
  const crossA = rng.range(-1400, -300), crossB = rng.range(300, 1400);
  const latA = -rng.range(700, 1100), latB = rng.range(800, 1300);
  const roadCrossA = makeRoad(front, 'cross', crossA, opts.seed + 1, terrain);
  const roadCrossB = makeRoad(front, 'cross', crossB, opts.seed + 2, terrain);
  const roadLatA = makeRoad(front, 'lateral', latA, opts.seed + 3, terrain);
  const roadLatB = makeRoad(front, 'lateral', latB, opts.seed + 4, terrain);
  const pos: number[] = [], attr: number[] = [], idx: number[] = [];
  ribbon(roadCrossA, 7.5, 0, terrain, pos, attr, idx);
  ribbon(roadCrossB, 7.5, 0, terrain, pos, attr, idx);
  ribbon(roadLatA, 5, 1, terrain, pos, attr, idx);
  ribbon(roadLatB, 5, 1, terrain, pos, attr, idx);
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  roadGeo.setAttribute('aRoad', new THREE.Float32BufferAttribute(attr, 3));
  roadGeo.setIndex(idx);
  const roadMesh = new THREE.Mesh(roadGeo, shared.roadMat);
  roadMesh.frustumCulled = false;
  roadMesh.renderOrder = 11;
  roadMesh.name = 'battle-roads';
  group.add(roadMesh);
  // Paths: team 0 (A, v < 0) drives up crossA from its rear; team 1 (B) down crossB from its rear.
  // roadCross samples run from v = -R (A rear) to v = +R (B rear).
  const paths: Path[] = [pathFrom(roadCrossA, false, 260, front), pathFrom(roadCrossB, true, 260, front)];

  // Occupancy grid (16 m cells): 1 = road, 2 = building. O(1) lookups for tree/house placement.
  const MC = 16, MN = Math.ceil(COARSE_SIZE_M / MC);
  const mask = new Uint8Array(MN * MN);
  const cellOf = (x: number, z: number) => {
    const i = Math.floor((z + R) / MC), j = Math.floor((x + R) / MC);
    return i < 0 || j < 0 || i >= MN || j >= MN ? -1 : i * MN + j;
  };
  for (const r of [roadCrossA, roadCrossB, roadLatA, roadLatB]) {
    for (let i = 0; i < r.length; i += 2) {
      const c = cellOf(r[i], r[i + 1]);
      if (c >= 0) mask[c] = 1;
    }
  }
  const nearRoad = (x: number, z: number): boolean => {
    const c = cellOf(x, z);
    return c >= 0 && mask[c] === 1;
  };
  const stampBuilding = (x: number, z: number, w: number, d: number) => {
    const r = Math.max(w, d) * 0.6;
    for (let dz = -r; dz <= r; dz += MC * 0.5) for (let dx = -r; dx <= r; dx += MC * 0.5) {
      const c = cellOf(x + dx, z + dz);
      if (c >= 0 && mask[c] === 0) mask[c] = 2;
    }
  };

  // --- buildings -----------------------------------------------------------------------------------------------
  const buildings: BuildingInfo[] = [];
  const houseP: number[] = [], houseS: number[] = [], houseK: number[] = [];
  const addHouse = (x: number, z: number, yaw: number, w: number, h: number, d: number, roof: number) => {
    if (buildings.length >= opts.buildingBudget) return;
    if (Math.hypot(x, z) > R * 0.9) return;
    if (isWater(x, z)) return;
    // Foundation at the lowest corner-ish point so houses do not float on slopes.
    const y = Math.min(terrain.heightAt(x - w * 0.4, z - d * 0.4), terrain.heightAt(x + w * 0.4, z + d * 0.4), terrain.heightAt(x, z)) - 0.3;
    front.coords(x, z, uv);
    const near = 1 - smooth(120, 900, Math.abs(uv.y));
    const damage = Math.min(1, near * rng.range(0.2, 1.25) + (rng.chance(0.06) ? 0.5 : 0));
    const burning = damage > 0.3 && rng.chance(0.35 + near * 0.35);
    houseP.push(x, y, z, yaw);
    houseS.push(w, h + 0.3, d, roof);
    houseK.push(rng.next(), rng.next(), damage, rng.next());
    buildings.push({ x, y, z, w, h, d, damage, burning });
    stampBuilding(x, z, w, d);
  };
  // Villages at road crossings.
  const crossings: [number, number][] = [];
  for (const [cu, lv] of [[crossA, latA], [crossA, latB], [crossB, latA], [crossB, latB]] as const) {
    front.toXZ(cu, lv, tmp);
    const off = front.offsetAt(cu);
    crossings.push([tmp.x - front.nx * off, tmp.z - front.nz * off]);
  }
  // A hamlet right behind each line too (burning farms).
  for (const s of [-1, 1]) {
    front.toXZ(rng.range(-900, 900), s * rng.range(260, 480), tmp);
    crossings.push([tmp.x, tmp.z]);
  }
  for (const [cx, cz] of crossings) {
    if (isWater(cx, cz)) continue;
    const size = rng.range(12, 30);
    const ang = Math.atan2(front.tx, front.tz) + rng.range(-0.2, 0.2);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let k = 0; k < size; k++) {
      // Houses along the two streets of the crossing.
      const street = rng.int(2);
      const along = rng.range(-160, 160);
      const side = rng.chance(0.5) ? -1 : 1;
      const set = rng.range(9, 16) * side;
      const lx = street === 0 ? along : set, lz = street === 0 ? set : along;
      const x = cx + lx * ca + lz * sa, z = cz - lx * sa + lz * ca;
      if (nearRoad(x, z) && rng.chance(0.7)) continue;
      const big = rng.chance(0.15);
      addHouse(x, z, ang + (street === 0 ? 0 : Math.PI / 2) + rng.range(-0.05, 0.05),
        rng.range(7, big ? 18 : 11), big ? rng.range(7, 10) : rng.range(3.5, 6.5), rng.range(7, big ? 14 : 10), rng.range(2.5, 4.5));
    }
  }
  // Towns where the data says urban.
  const cellT = 42;
  const angT = rng.range(0, Math.PI);
  const cT = Math.cos(angT), sT = Math.sin(angT);
  for (let gz = -R; gz < R && buildings.length < opts.buildingBudget; gz += cellT) {
    for (let gx = -R; gx < R && buildings.length < opts.buildingBudget; gx += cellT) {
      const x = gx * cT - gz * sT, z = gx * sT + gz * cT;
      if (Math.hypot(x, z) > R * 0.85) continue;
      terrain.splatAt(x, z, splat);
      const urban = splat[5];
      if (urban < 0.25 || !rng.chance(Math.min(1, urban * 1.6))) continue;
      const blocks = urban > 0.6 ? 2 : 1;
      for (let b = 0; b < blocks; b++) {
        const ox = x + rng.range(-12, 12), oz = z + rng.range(-12, 12);
        const tall = urban > 0.55 && rng.chance(0.4);
        addHouse(ox, oz, angT + (rng.chance(0.5) ? 0 : Math.PI / 2), rng.range(9, tall ? 22 : 14), tall ? rng.range(10, 24) : rng.range(4, 8), rng.range(8, tall ? 18 : 12), tall ? 0 : rng.range(2.5, 4));
      }
    }
  }
  // Scattered farms.
  for (let k = 0; k < 90 && buildings.length < opts.buildingBudget; k++) {
    const x = rng.range(-R, R) * 0.8, z = rng.range(-R, R) * 0.8;
    terrain.splatAt(x, z, splat);
    if (splat[1] < 0.3 && splat[6] < 0.3) continue;
    const yaw = rng.range(0, Math.PI);
    addHouse(x, z, yaw, rng.range(8, 12), rng.range(4, 6), rng.range(7, 10), rng.range(3, 4.5));
    if (rng.chance(0.7)) addHouse(x + Math.cos(yaw) * 18, z - Math.sin(yaw) * 18, yaw, rng.range(10, 20), rng.range(5, 8), rng.range(10, 16), rng.range(3, 5));
  }
  const nb = buildings.length;
  let houseMesh: THREE.Mesh | null = null;
  if (nb > 0) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', shared.houseGeo.getAttribute('position'));
    geo.setAttribute('normal', shared.houseGeo.getAttribute('normal'));
    geo.setAttribute('aPart', shared.houseGeo.getAttribute('aPart'));
    geo.setAttribute('iP', new THREE.InstancedBufferAttribute(Float32Array.from(houseP), 4));
    geo.setAttribute('iS', new THREE.InstancedBufferAttribute(Float32Array.from(houseS), 4));
    geo.setAttribute('iK', new THREE.InstancedBufferAttribute(Float32Array.from(houseK), 4));
    geo.instanceCount = nb;
    houseMesh = new THREE.Mesh(geo, shared.houseMat);
    houseMesh.frustumCulled = false;
    houseMesh.renderOrder = 20;
    houseMesh.name = 'battle-houses';
    group.add(houseMesh);
  }

  // --- trees -----------------------------------------------------------------------------------------------------
  const occupied = (x: number, z: number) => {
    const c = cellOf(x, z);
    return c < 0 || mask[c] !== 0;
  };
  const tC: number[] = [], uC: number[] = [], tB: number[] = [], uB: number[] = [];
  let trees = 0;
  // Trees come from three sources, all thinned by one distance falloff and scaled to fit the budget (two passes:
  // estimate, then place), so the density never shows a seam:
  //   * forests of the land-cover data (stratified on 26 m cells, in groves with clearings),
  //   * hedgerows along the field boundaries of ./fields (exactly where the ground shader paints hedge bases),
  //   * woodlots (whole fields of trees).
  const CELL = 26;
  const Rt = R * 0.82;
  const dens0 = 1 / 70;
  const HEDGE_STEP = 8.5;
  const WOOD_AREA = 55;
  // Same woods/clearings mask as the ground shader (canopy from the forest share + thresholded detail noise).
  const D = shared.detailAt;
  const canopyAt = (x: number, z: number) => {
    let sum = 1e-4;
    for (let c = 0; c < 8; c++) sum += splat[c];
    const fw = splat[2] / sum;
    if (fw < 0.02) return 0;
    const n = D(x / 97 + 0.37, z / 97 + 0.37, 0) * 0.55 + D(x / 480 + 0.71, z / 480 + 0.71, 1) * 0.45 + (D(x / 23, z / 23, 2) - 0.5) * 0.12;
    return smooth(0.02, 0.1, fw - (n - 0.25) * 1.4);
  };
  const falloff = (d: number) => Math.pow(600 / (600 + d), 2);
  const openGround = (x: number, z: number) => {
    if (terrain.splatAt(x, z, splat) > 0.15) return 0;
    let sum = 1e-4;
    for (let c = 0; c < 8; c++) sum += splat[c];
    return 1 - smooth(0.4, 0.7, (splat[2] + splat[3] + splat[4] + splat[5]) / sum);
  };
  const ff = new FieldFrame();
  ff.setAngle(opts.fieldAngle);
  const pt = { x: 0, y: 0 };
  const farm = terrain.farmland;
  const rows0 = Math.floor(-Rt / FIELD_ROW) - 1, rows1 = Math.ceil(Rt / FIELD_ROW) + 1;
  /** Visit hedge segments / woodlots: cb(kind, fx0, fy0, fx1, fy1) in field space. kind 0 hedge line, 1 woodlot rect. */
  const visitFarm = (cb: (kind: number, ax: number, ay: number, bx: number, by: number) => void) => {
    if (farm < 0.05) return;
    for (let r = rows0; r <= rows1; r++) {
      const fy = r * FIELD_ROW;
      // Row boundary hedges, by segment.
      const s0 = Math.floor(-Rt / HEDGE_SEG) - 1, s1 = Math.ceil(Rt / HEDGE_SEG);
      for (let sg = s0; sg <= s1; sg++) if (rowHedge(r, (sg + 0.5) * HEDGE_SEG)) cb(0, sg * HEDGE_SEG, fy, (sg + 1) * HEDGE_SEG, fy);
      // Field-end hedges and woodlots in this row.
      const w = rowWidth(r), sh = rowShift(r);
      const c0 = Math.floor((-Rt + sh) / w) - 1, c1 = Math.ceil((Rt + sh) / w) + 1;
      for (let c = c0; c <= c1; c++) {
        const fx = c * w - sh;
        if (colHedge(c, r)) cb(0, fx, fy, fx, fy + FIELD_ROW);
        if (isWoodlot(c, r)) cb(1, fx, fy, fx + w, fy + FIELD_ROW);
      }
    }
  };
  // Pass 1: candidate counts and their distance falloff. Then solve for the density gain K so that
  // sum(n * min(1, K * falloff)) fits the budget: full density near the battle centre, thinning with distance.
  const candN: number[] = [], candF: number[] = [];
  for (let z = -Rt; z < Rt; z += CELL) {
    for (let x = -Rt; x < Rt; x += CELL) {
      const d = Math.hypot(x, z);
      if (d > Rt) continue;
      terrain.splatAt(x, z, splat);
      candN.push((canopyAt(x, z) + 0.02) * dens0 * CELL * CELL);
      candF.push(falloff(d));
    }
  }
  visitFarm((kind, ax, ay, bx, by) => {
    ff.toLocal((ax + bx) * 0.5, (ay + by) * 0.5, pt);
    const d = Math.hypot(pt.x, pt.y);
    if (d > Rt) return;
    const n = kind === 0 ? Math.hypot(bx - ax, by - ay) / HEDGE_STEP * 0.8 : ((bx - ax) * (by - ay)) / WOOD_AREA;
    candN.push(n * farm * 0.8);
    candF.push(falloff(d));
  });
  const total = (K: number) => {
    let t = 0;
    for (let i = 0; i < candN.length; i++) t += candN[i] * Math.min(1, K * candF[i]);
    return t;
  };
  let lo = 0, hi = 1;
  while (total(hi) < opts.treeBudget && hi < 1e5) hi *= 4;
  if (total(hi) <= opts.treeBudget) lo = hi;
  else for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) * 0.5;
    if (total(mid) > opts.treeBudget) hi = mid;
    else lo = mid;
  }
  const K = lo;
  const accept = (d: number) => Math.min(1, K * falloff(d));
  const plant = (tx: number, tz: number, conifer: boolean, sc: number) => {
    if (trees >= opts.treeBudget) return;
    if (Math.hypot(tx, tz) > Rt || occupied(tx, tz)) return;
    front.coords(tx, tz, uv);
    const inBelt = Math.abs(uv.y) < 150 && Math.abs(uv.x) < front.halfLen * 0.9;
    const broken = inBelt && rng.chance(0.85) ? 1 : 0;
    const y = terrain.heightAt(tx, tz) - 0.3;
    const arrT = conifer ? tC : tB, arrU = conifer ? uC : uB;
    arrT.push(tx, y, tz, sc);
    arrU.push(rng.next(), rng.next(), broken, rng.range(0, Math.PI * 2));
    trees++;
  };
  for (let z = -Rt; z < Rt; z += CELL) {
    for (let x = -Rt; x < Rt; x += CELL) {
      const d = Math.hypot(x, z);
      if (d > Rt) continue;
      terrain.splatAt(x, z, splat);
      const forest = canopyAt(x, z) + 0.02;
      let nExp = forest * dens0 * CELL * CELL * accept(d);
      while (nExp > 0 && trees < opts.treeBudget) {
        if (nExp < 1 && rng.next() > nExp) break;
        nExp -= 1;
        const tx = x + rng.next() * CELL, tz = z + rng.next() * CELL;
        if (terrain.splatAt(tx, tz, splat) > 0.2) continue;
        const c = canopyAt(tx, tz);
        // Inside the woods, or a lone tree in the open now and then.
        if (c < 0.5 && !rng.chance(0.04)) continue;
        plant(tx, tz, rng.next() < opts.conifer + splat[4] * 0.5, rng.range(0.7, 1.45));
      }
    }
  }
  visitFarm((kind, ax, ay, bx, by) => {
    ff.toLocal((ax + bx) * 0.5, (ay + by) * 0.5, pt);
    const d = Math.hypot(pt.x, pt.y);
    if (d > Rt + 200) return;
    const k = accept(d) * farm;
    if (kind === 0) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.floor(len / HEDGE_STEP);
      for (let i = 0; i < n; i++) {
        if (rng.next() > k) continue;
        const f = (i + rng.range(0.2, 0.8)) / n;
        const fx = ax + (bx - ax) * f + (ax === bx ? rng.range(-1.2, 1.2) : 0);
        const fy = ay + (by - ay) * f + (ay === by ? rng.range(-1.2, 1.2) : 0);
        ff.toLocal(fx, fy, pt);
        if (openGround(pt.x, pt.y) < 0.5) continue;
        // Gaps in the hedge.
        if (noise1(f * len / 60 + ax * 0.01 + ay * 0.013, opts.seed + 21) < -0.45) continue;
        plant(pt.x, pt.y, rng.chance(opts.conifer * 0.3), rng.range(0.75, 1.5));
      }
    } else {
      const n = ((bx - ax) * (by - ay)) / WOOD_AREA;
      let nExp = n * k;
      while (nExp > 0 && trees < opts.treeBudget) {
        if (nExp < 1 && rng.next() > nExp) break;
        nExp -= 1;
        ff.toLocal(rng.range(ax + 3, bx - 3), rng.range(ay + 3, by - 3), pt);
        if (openGround(pt.x, pt.y) < 0.5) continue;
        plant(pt.x, pt.y, rng.next() < opts.conifer, rng.range(0.8, 1.6));
      }
    }
  });
  // Two LODs per tree kind (full model within TREE_LOD_M of the camera, a ~20-triangle stand-in beyond), re-sorted
  // on the CPU only when the camera has moved: 4 draw calls for every tree on the battlefield.
  const TREE_LOD_M = 650;
  interface TreeSet { T: Float32Array; U: Float32Array; n: number; near: THREE.InstancedBufferGeometry; far: THREE.InstancedBufferGeometry }
  const treeSets: TreeSet[] = [];
  const treeMeshes: THREE.Mesh[] = [];
  const mkTrees = (T: number[], U: number[], geoNear: THREE.BufferGeometry, geoFar: THREE.BufferGeometry, mat: THREE.ShaderMaterial, name: string) => {
    const n = T.length / 4;
    if (n === 0) return;
    const mk = (src: THREE.BufferGeometry, suffix: string) => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', src.getAttribute('position'));
      geo.setAttribute('normal', src.getAttribute('normal'));
      geo.setAttribute('aPart', src.getAttribute('aPart'));
      const iT = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      const iU = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      iT.setUsage(THREE.DynamicDrawUsage);
      iU.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iT', iT);
      geo.setAttribute('iU', iU);
      geo.instanceCount = 0;
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 20;
      m.name = name + suffix;
      group.add(m);
      treeMeshes.push(m);
      return geo;
    };
    treeSets.push({ T: Float32Array.from(T), U: Float32Array.from(U), n, near: mk(geoNear, '-near'), far: mk(geoFar, '-far') });
  };
  mkTrees(tC, uC, shared.coniferGeo, shared.coniferFarGeo, shared.coniferMat, 'battle-conifers');
  mkTrees(tB, uB, shared.broadGeo, shared.broadFarGeo, shared.broadMat, 'battle-broadleaf');
  let lodX = Infinity, lodZ = Infinity;
  const updateLod = (camX: number, camZ: number) => {
    if (Math.hypot(camX - lodX, camZ - lodZ) < 45) return;
    lodX = camX;
    lodZ = camZ;
    const r2 = TREE_LOD_M * TREE_LOD_M;
    for (const ts of treeSets) {
      const nT = ts.near.getAttribute('iT') as THREE.InstancedBufferAttribute, nU = ts.near.getAttribute('iU') as THREE.InstancedBufferAttribute;
      const fT = ts.far.getAttribute('iT') as THREE.InstancedBufferAttribute, fU = ts.far.getAttribute('iU') as THREE.InstancedBufferAttribute;
      const NT = nT.array as Float32Array, NU = nU.array as Float32Array, FT = fT.array as Float32Array, FU = fU.array as Float32Array;
      let a = 0, b = 0;
      for (let i = 0; i < ts.n; i++) {
        const o = i * 4;
        const dx = ts.T[o] - camX, dz = ts.T[o + 2] - camZ;
        if (dx * dx + dz * dz < r2) {
          const q = a * 4;
          for (let k = 0; k < 4; k++) { NT[q + k] = ts.T[o + k]; NU[q + k] = ts.U[o + k]; }
          a++;
        } else {
          const q = b * 4;
          for (let k = 0; k < 4; k++) { FT[q + k] = ts.T[o + k]; FU[q + k] = ts.U[o + k]; }
          b++;
        }
      }
      ts.near.instanceCount = a;
      ts.far.instanceCount = b;
      for (const [attr, c] of [[nT, a], [nU, a], [fT, b], [fU, b]] as const) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, Math.max(1, c) * 4);
        attr.needsUpdate = true;
      }
    }
  };
  updateLod(0, 0);

  return {
    group, paths, buildings, treeCount: trees, updateLod,
    dispose() {
      roadGeo.dispose();
      houseMesh?.geometry.dispose();
      for (const m of treeMeshes) m.geometry.dispose();
    },
  };
}
