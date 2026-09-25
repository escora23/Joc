// FRONT ULTRA — surface ribbons: the rail network between cities/ports/factories and order-path previews
// (owner: units). Ribbons hug the relief (sampled surface radius), are expanded across the ground in the vertex
// shader with a minimum on-screen width, and draw rails + sleepers when close, a clean line from orbit.

import * as THREE from 'three';
import { EARTH_RADIUS_KM, MAP_W, TILE_COUNT } from '../../shared/constants';
import { latLonToVec3, tileToLatLon, tileX, tileY, wrapDX } from '../../shared/geo';
import { isPlayableTerrain } from '../../shared/terrain';
import { StructureType, type LatLon, type StructureView, type WorldData } from '../../shared/types';
import { sharedUniforms } from './common';

const SURF_ATTRS = ['position', 'aSide', 'aInfo', 'aCol'];

const VERT = /* glsl */ `
attribute vec3 aSide;
attribute vec2 aInfo;  // side (-1/1), along (km)
attribute vec3 aCol;
uniform float uPixelK;
uniform float uWidthKm;
uniform float uMinPx;
uniform float uLift;
varying float vSide;
varying float vAlong;
varying vec3 vCol;
varying float vPx;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  float dist = distance(cameraPosition, p);
  float wWorld = uWidthKm / ${EARTH_RADIUS_KM.toFixed(1)};
  float pxw = uPixelK * dist;
  float w = max(wWorld, uMinPx * pxw);
  vPx = wWorld / pxw;
  p += aSide * w * aInfo.x;
  p += normalize(p) * (uLift + pxw * 0.5);
  vSide = aInfo.x;
  vAlong = aInfo.y;
  vCol = aCol;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uTime;
uniform float uDash;
uniform float uOpacity;
uniform float uGlow;
varying float vSide;
varying float vAlong;
varying vec3 vCol;
varying float vPx;
varying vec3 vWorld;
void main() {
  if (dot(normalize(vWorld), cameraPosition - vWorld) < 0.0) discard;
  float day = smoothstep(-0.15, 0.15, dot(normalize(vWorld), uSunDir));
  float across = abs(vSide);
  vec3 col;
  float a;
  if (uDash > 0.0) {
    // Order path: animated dashes flowing toward the target.
    float d = fract(vAlong / uDash - uTime * 1.5);
    a = step(d, 0.55) * (1.0 - across * across) * uOpacity;
    col = vCol * (1.5 + uGlow);
  } else {
    // Rails: two rails + sleepers when the ribbon is wide on screen, a soft line otherwise.
    float close = smoothstep(2.0, 6.0, vPx);
    float rails = max(step(abs(across - 0.55), 0.12), 0.0);
    float sleepers = step(fract(vAlong / 0.35), 0.35) * step(across, 0.85);
    float detail = max(rails, sleepers * 0.6);
    float line = 1.0 - smoothstep(0.35, 1.0, across);
    a = mix(line * 0.7, max(detail * 0.8, 0.3), close) * uOpacity;
    vec3 steel = vec3(0.2, 0.2, 0.2) * (0.25 + 0.9 * day);
    vec3 bed = vec3(0.07, 0.065, 0.06) + vCol * 0.08;
    col = mix(bed * (0.4 + 0.6 * day), steel, close * rails);
    // A faint nation-tinted glow at night so the network still reads on the dark side.
    col += vCol * (1.0 - day) * 0.03;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SurfaceRibbon {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private side: Float32Array;
  private info: Float32Array;
  private col: Float32Array;
  private idx: Uint32Array;
  private nv = 0;
  private ni = 0;
  readonly maxV: number;
  readonly material: THREE.ShaderMaterial;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private t = new THREE.Vector3();
  private s = new THREE.Vector3();
  private u = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(maxV: number, opts: { widthKm: number; minPx: number; dash?: number; opacity?: number; lift?: number; depthTest?: boolean; name: string; renderOrder: number }) {
    this.maxV = maxV;
    this.pos = new Float32Array(maxV * 3);
    this.side = new Float32Array(maxV * 3);
    this.info = new Float32Array(maxV * 2);
    this.col = new Float32Array(maxV * 3);
    this.idx = new Uint32Array(maxV * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(this.side, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      name: opts.name,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPixelK: sharedUniforms.uPixelK,
        uSunDir: sharedUniforms.uSunDir,
        uTime: sharedUniforms.uTime,
        uWidthKm: { value: opts.widthKm },
        uMinPx: { value: opts.minPx },
        uDash: { value: opts.dash ?? 0 },
        uOpacity: { value: opts.opacity ?? 1 },
        uLift: { value: (opts.lift ?? 0.05) / EARTH_RADIUS_KM },
        uGlow: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder;
    this.mesh.name = opts.name;
  }

  begin(): void {
    this.nv = 0;
    this.ni = 0;
  }

  /** Add a great-circle ribbon between two lat/lons, draped on the surface. */
  addArc(a: LatLon, b: LatLon, color: number, radiusAt: (lat: number, lon: number) => number, segKm = 12, liftKm = 0): void {
    const A = latLonToVec3(a.lat, a.lon, 1, this.a);
    const B = latLonToVec3(b.lat, b.lon, 1, this.b);
    const ang = Math.acos(Math.max(-1, Math.min(1, A.dot(B))));
    const lenKm = ang * EARTH_RADIUS_KM;
    const n = Math.max(2, Math.min(96, Math.ceil(lenKm / segKm) + 1));
    if (this.nv + n * 2 > this.maxV) return;
    this.c.setHex(color);
    const sinA = Math.sin(ang) || 1;
    const base = this.nv;
    const ll: LatLon = { lat: 0, lon: 0 };
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let ka: number, kb: number;
      if (ang < 1e-6) {
        ka = 1 - t;
        kb = t;
      } else {
        ka = Math.sin((1 - t) * ang) / sinA;
        kb = Math.sin(t * ang) / sinA;
      }
      const u = this.u.set(A.x * ka + B.x * kb, A.y * ka + B.y * kb, A.z * ka + B.z * kb).normalize();
      ll.lat = Math.asin(Math.max(-1, Math.min(1, u.y))) * (180 / Math.PI);
      ll.lon = Math.atan2(-u.z, u.x) * (180 / Math.PI);
      const r = radiusAt(ll.lat, ll.lon) + liftKm / EARTH_RADIUS_KM;
      // Tangent along the arc, side = tangent x up.
      this.t.subVectors(B, A);
      this.t.addScaledVector(u, -this.t.dot(u));
      if (this.t.lengthSq() < 1e-12) this.t.set(0, 0, 1);
      this.s.crossVectors(this.t, u).normalize();
      for (let k = 0; k < 2; k++) {
        const v = this.nv++;
        this.pos[v * 3] = u.x * r;
        this.pos[v * 3 + 1] = u.y * r;
        this.pos[v * 3 + 2] = u.z * r;
        this.side[v * 3] = this.s.x;
        this.side[v * 3 + 1] = this.s.y;
        this.side[v * 3 + 2] = this.s.z;
        this.info[v * 2] = k === 0 ? -1 : 1;
        this.info[v * 2 + 1] = t * lenKm;
        this.col[v * 3] = this.c.r;
        this.col[v * 3 + 1] = this.c.g;
        this.col[v * 3 + 2] = this.c.b;
      }
      if (i > 0) {
        const v0 = base + (i - 1) * 2, v1 = base + i * 2;
        this.idx[this.ni++] = v0;
        this.idx[this.ni++] = v0 + 1;
        this.idx[this.ni++] = v1;
        this.idx[this.ni++] = v1;
        this.idx[this.ni++] = v0 + 1;
        this.idx[this.ni++] = v1 + 1;
      }
    }
  }

  end(): void {
    for (const name of SURF_ATTRS) {
      const at = this.geo.getAttribute(name) as THREE.BufferAttribute;
      at.clearUpdateRanges();
      if (this.nv > 0) at.addUpdateRange(0, this.nv * at.itemSize);
      at.needsUpdate = true;
    }
    const ix = this.geo.index!;
    ix.clearUpdateRanges();
    if (this.ni > 0) ix.addUpdateRange(0, this.ni);
    ix.needsUpdate = true;
    this.geo.setDrawRange(0, this.ni);
  }

  get empty(): boolean {
    return this.ni === 0;
  }
}

// -------------------------------------------------------------------------------------------------
// Rail network (client-side reconstruction of the sim's station graph: same owner or allies, nearest
// stations within reach, straight lines over land).
// -------------------------------------------------------------------------------------------------

const STATION = new Set<number>([StructureType.City, StructureType.Port, StructureType.Factory]);
const MAX_LINK_TILES = 75;
const MAX_LINKS = 4;

export function buildRailLinks(
  structures: Iterable<StructureView>, world: WorldData | null, allied: (a: number, b: number) => boolean,
): [StructureView, StructureView][] {
  const st: StructureView[] = [];
  for (const s of structures) if (STATION.has(s.type) && s.built >= 1) st.push(s);
  st.sort((a, b) => a.id - b.id);
  const links: [StructureView, StructureView][] = [];
  const count = new Map<number, number>();
  const has = new Set<string>();
  const cand: { s: StructureView; d: number }[] = [];
  for (const a of st) {
    cand.length = 0;
    const ax = tileX(a.tile), ay = tileY(a.tile);
    for (const b of st) {
      if (b === a) continue;
      if (b.owner !== a.owner && !allied(a.owner, b.owner)) continue;
      const dx = wrapDX(ax, tileX(b.tile)), dy = tileY(b.tile) - ay;
      const d = dx * dx + dy * dy;
      if (d > MAX_LINK_TILES * MAX_LINK_TILES) continue;
      cand.push({ s: b, d });
    }
    cand.sort((x, y) => x.d - y.d || x.s.id - y.s.id);
    let n = count.get(a.id) ?? 0;
    for (let i = 0; i < cand.length && i < 12 && n < MAX_LINKS; i++) {
      const b = cand[i].s;
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (has.has(key)) continue;
      if ((count.get(b.id) ?? 0) >= MAX_LINKS + 2) continue;
      if (world && !landLine(world, a.tile, b.tile)) continue;
      has.add(key);
      links.push([a, b]);
      n++;
      count.set(a.id, n);
      count.set(b.id, (count.get(b.id) ?? 0) + 1);
    }
  }
  return links;
}

function landLine(world: WorldData, ta: number, tb: number): boolean {
  const ax = tileX(ta) + 0.5, ay = tileY(ta) + 0.5;
  const dx = wrapDX(tileX(ta), tileX(tb)), dy = tileY(tb) - tileY(ta);
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len / 0.5);
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const x = ((Math.floor(ax + dx * f) % MAP_W) + MAP_W) % MAP_W;
    const y = Math.floor(ay + dy * f);
    const t = y * MAP_W + x;
    if (t < 0 || t >= TILE_COUNT || !isPlayableTerrain(world.terrain[t])) return false;
  }
  return true;
}

export function stationLatLon(s: StructureView, out: LatLon): LatLon {
  return tileToLatLon(s.tile, out);
}
