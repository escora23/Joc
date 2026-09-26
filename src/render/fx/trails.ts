// FRONT ULTRA — ribbon trails: contrails, missile smoke, ship wakes, nuke arcs, tracers (owner: units / fx).
// Each trail keeps a small ring of world-space points (committed every `minSeg` km, the newest point follows the
// emitter live). Every frame all live trails are written into two preallocated dynamic buffers (alpha-blended and
// additive), expanded into camera-facing (or water-flat, for wakes) ribbons in the vertex shader with a
// minimum on-screen width, and softly faded along age and across the ribbon. Three draw calls: alpha-blended, additive, and the route lines (drawn without depth test above the clouds, horizon-tested).
// Released trails ("orphans": the unit died or landed) keep fading until their last point expires.
// Route styles (DESIGN_V2 §10.8, W2): crisp owner-coloured lines with a constant screen width, drawn solid, dashed
// (planned paths), with arrowheads (convoys) or a pulsing outline (enemy convoys heading to you); they keep every
// point from departure (decimating instead of dropping the oldest when full), and after release they stay for `hold`
// seconds before fading over `releaseFade`.

import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/constants';
import { sharedUniforms } from '../units/common';
import { inverseToneGlsl } from '../units/icons';

const RIBBON_ATTRS = ['position', 'aTan', 'aData', 'aCol', 'aAlong', 'aLook'];

export interface TrailStyle {
  /** Seconds a committed point lives. */
  life: number;
  /** Ribbon half-width (km) at the head and at the end of life. */
  w0: number;
  w1: number;
  /** Minimum on-screen half-width in px. */
  minPx: number;
  color: [number, number, number];
  alpha: number;
  additive: boolean;
  /** Lie flat on the surface (wakes) instead of facing the camera. */
  flat: boolean;
  /** Distance between committed points (km). */
  minSeg: number;
  maxPts: number;
  /** Alpha falloff exponent along age. */
  fade: number;
  /** Puffy breakup along the ribbon (smoke). */
  noise: number;
  /** When > 0, a released trail fades out over this many seconds (instead of waiting for its points to expire). */
  releaseFade: number;
  /** Seconds a released trail stays at full opacity before its releaseFade starts. */
  hold: number;
  /** Shader look: 0 soft legacy ribbon, 1 crisp line, 2 dashed, 3 arrowheads, 4 pulsing outline. */
  look: number;
  /** Keep the first point: when full, drop every other point (and double the spacing) instead of the oldest. */
  keepAll: boolean;
}

const S = (o: Partial<TrailStyle> & Pick<TrailStyle, 'life' | 'w0' | 'w1'>): TrailStyle => ({
  minPx: 1.5, color: [1, 1, 1], alpha: 1, additive: false, flat: false, minSeg: 2, maxPts: 32, fade: 1.5, noise: 0, releaseFade: 0,
  hold: 0, look: 0, keepAll: false, ...o,
});

/** Route line: never expires while its unit lives; kept 15 s after arrival, then fades out over 5 s (§10.8). */
const ROUTE = { life: 1e9, w0: 0.05, w1: 0.05, fade: 0, releaseFade: 5, hold: 15, keepAll: true, maxPts: 256, minSeg: 20 } as const;

export const TRAIL_STYLES = {
  contrail: S({ life: 8, w0: 0.04, w1: 2.6, minPx: 1.2, color: [0.95, 0.96, 1.0], alpha: 0.55, minSeg: 1.5, maxPts: 40, fade: 1.3, noise: 0.25 }),
  smoke: S({ life: 10, w0: 0.15, w1: 7, minPx: 1.8, color: [0.78, 0.77, 0.75], alpha: 0.65, minSeg: 3, maxPts: 48, fade: 1.2, noise: 0.6 }),
  samSmoke: S({ life: 5, w0: 0.1, w1: 3.5, minPx: 1.6, color: [0.92, 0.92, 0.93], alpha: 0.75, minSeg: 1.5, maxPts: 36, fade: 1.3, noise: 0.5 }),
  wake: S({ life: 7, w0: 0.12, w1: 2.6, minPx: 1.5, color: [0.75, 0.82, 0.9], alpha: 0.9, additive: true, flat: true, minSeg: 0.6, maxPts: 36, fade: 1.1 }),
  nukeSmoke: S({ life: 40, w0: 1.2, w1: 11, minPx: 2.0, color: [0.86, 0.85, 0.84], alpha: 0.5, minSeg: 14, maxPts: 110, fade: 1.2, noise: 0.5, releaseFade: 6 }),
  exhaust: S({ life: 1.2, w0: 1.4, w1: 0.2, minPx: 2.0, color: [4.5, 2.2, 0.8], alpha: 1, additive: true, minSeg: 2, maxPts: 20, fade: 1.5, releaseFade: 0.4 }),
  arc: S({ life: 70, w0: 0.6, w1: 0.6, minPx: 1.0, color: [1, 1, 1], alpha: 0.7, additive: true, minSeg: 20, maxPts: 128, fade: 0.6, releaseFade: 1.5 }),
  tracer: S({ life: 0.3, w0: 0.1, w1: 0.03, minPx: 1.6, color: [9, 6, 2.5], alpha: 1, additive: true, minSeg: 0.4, maxPts: 10, fade: 1 }),
  shell: S({ life: 0.9, w0: 0.25, w1: 0.06, minPx: 2.2, color: [10, 5.5, 2], alpha: 1, additive: true, minSeg: 0.5, maxPts: 16, fade: 1 }),
  dust: S({ life: 4, w0: 0.08, w1: 1.2, minPx: 1.0, color: [0.5, 0.42, 0.3], alpha: 0.45, flat: true, minSeg: 0.4, maxPts: 24, fade: 1.4, noise: 0.5 }),
  // --- routes (minPx = half width in px)
  /** Ship route, 2 px, owner colour. */
  route: S({ ...ROUTE, minPx: 1.0, alpha: 0.95, look: 1 }),
  /** Transport convoy, 3 px with an arrowhead every 150 px. */
  routeConvoy: S({ ...ROUTE, minPx: 4.5, alpha: 1, look: 3 }),
  /** Trade ship, 1 px at 30 % opacity. */
  routeTrade: S({ ...ROUTE, minPx: 0.5, alpha: 0.3, look: 1, hold: 6, releaseFade: 3 }),
  /** Warship leg, 1.5 px while moving. */
  routeWarship: S({ ...ROUTE, minPx: 0.75, alpha: 0.85, look: 1, hold: 8 }),
  /** Aircraft sortie, drawn progressively from take-off; kept 10 s after landing. */
  routeAir: S({ ...ROUTE, minPx: 0.8, alpha: 0.9, look: 1, hold: 10, minSeg: 10 }),
  /** Planned path ahead (dashed, 40 %). Rebuilt by setPath(). */
  plan: S({ ...ROUTE, minPx: 1.0, alpha: 0.4, look: 2, hold: 0, releaseFade: 0.3 }),
  /** Red pulsing outline under an enemy convoy heading to the human. */
  routeAlert: S({ ...ROUTE, minPx: 3.0, color: [1.0, 0.12, 0.08], alpha: 0.55, look: 4 }),
} as const;
export type TrailStyleKey = keyof typeof TRAIL_STYLES;

export class Trail {
  style: TrailStyle;
  pts: Float32Array;
  times: Float32Array;
  along: Float32Array;
  /** Index of the newest (live) point. */
  head = 0;
  count = 0;
  released = true;
  releasedAt = 0;
  inUse = false;
  color = new THREE.Color(1, 1, 1);
  /** Extra alpha multiplier (e.g. fade with camera altitude). */
  opacity = 1;
  /** Maximum ribbon length in world units (0 = only limited by point lifetime). */
  maxLen = 0;
  /** Point spacing override in km (0 = the style's minSeg). */
  minSegKm = 0;

  constructor(maxPts: number, style: TrailStyle) {
    this.style = style;
    this.pts = new Float32Array(maxPts * 3);
    this.times = new Float32Array(maxPts);
    this.along = new Float32Array(maxPts);
  }
}

const VERT = /* glsl */ `
attribute vec3 aTan;
attribute vec4 aData;  // side, age01, half width (world units), minPx (negative = flat on surface)
attribute vec4 aCol;   // rgb, alpha
attribute float aAlong;
attribute float aLook;
uniform float uPixelK;
varying vec4 vCol;
varying float vSide;
varying float vAge;
varying float vAlong;
varying float vLook;
varying float vAlongPx;
varying float vWpx;
varying vec3 vWorld;

void main() {
  vec3 p = position;
  vec3 up = normalize(p);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  toCam /= max(dist, 1e-9);
  float mp = aData.w;
  vec3 side;
  if (mp < 0.0) {
    side = normalize(cross(aTan, up) + 1e-9);
    mp = -mp;
  } else {
    side = normalize(cross(aTan, toCam) + 1e-9);
  }
  float w = max(aData.z, mp * uPixelK * dist);
  // Flat ribbons (wakes, dust) float a hair above the surface so the tessellated globe never swallows them.
  if (aData.w < 0.0) p += up * max(0.3 / ${EARTH_RADIUS_KM.toFixed(1)}, uPixelK * dist * 0.6);
  // Thin ribbons lose opacity instead of width once they are held at the pixel floor.
  float thin = clamp(aData.z / max(w, 1e-12), 0.0, 1.0);
  p += side * w * aData.x;
  vCol = aCol;
  // (Route lines are crisp constant-width lines in their owner's exact colour: no thinning.)
  if (aLook < 0.5) vCol.a *= mix(0.55, 1.0, thin);
  vSide = aData.x;
  vAge = aData.y;
  // Breakup scale follows the ribbon width (in km), so puffs look the same at every zoom.
  vAlong = aAlong / max(w * ${EARTH_RADIUS_KM.toFixed(1)} * 7.0, 1e-3);
  vLook = aLook;
  float ppx = uPixelK * dist;
  vAlongPx = aAlong / ${EARTH_RADIUS_KM.toFixed(1)} / max(ppx, 1e-12);
  vWpx = w / max(ppx, 1e-12);
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uNoise;
uniform float uTime;
varying vec4 vCol;
varying float vSide;
varying float vAge;
varying float vAlong;
varying float vLook;
varying float vAlongPx;
varying float vWpx;
varying vec3 vWorld;
${inverseToneGlsl()}

vec3 linToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float n11(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h11(i), h11(i + 1.0), f); }

void main() {
#ifdef ROUTE_LINES
  // Route lines draw without the depth buffer (above relief, the near patch, ocean swell and clouds); an analytic
  // horizon test hides the far side of the planet instead (as icons and order paths do).
  vec3 toC = cameraPosition - vWorld;
  if (dot(normalize(vWorld), toC) < 0.0) discard;
#endif
  float across = 1.0 - vSide * vSide;
  if (vLook > 0.5) {
    // Route lines: crisp edges at a constant pixel width.
    float px = abs(vSide) * vWpx;
    across = 1.0 - smoothstep(vWpx - 0.7, vWpx + 0.3, px);
    if (vLook > 1.5 && vLook < 2.5) {
      // Dashed (planned path): 9 px dashes, 6 px gaps.
      if (mod(vAlongPx, 15.0) > 9.0) discard;
    } else if (vLook > 2.5 && vLook < 3.5) {
      // Convoys: a 3 px core with arrowheads every 150 px pointing along the route (toward the ship).
      across = 1.0 - smoothstep(0.8, 1.8, px);
      float t = mod(vAlongPx, 150.0);
      float chev = (1.0 - smoothstep(0.9, 1.9, abs(t - 140.0 + px * 1.3))) * (1.0 - smoothstep(vWpx - 1.0, vWpx, px));
      across = max(across, chev);
    } else if (vLook > 3.5) {
      across *= 0.55 + 0.45 * sin(uTime * 5.0);
    }
  }
  float a = vCol.a * across;
  if (uNoise > 0.0) {
    float n = n11(vAlong + vSide * 1.7) * 0.6 + n11(vAlong * 2.7 - vSide * 3.1) * 0.4;
    a *= mix(1.0, 0.45 + 0.9 * n, uNoise * smoothstep(0.02, 0.3, vAge));
  }
  if (a < 0.003) discard;
  // Route lines show their owner's exact colour (the same swatch as the HUD and the icons).
  gl_FragColor = vec4(vLook > 0.5 && vLook < 3.5 ? untone(linToSrgb(vCol.rgb)) : vCol.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class RibbonBatch {
  readonly mesh: THREE.Mesh;
  readonly geo = new THREE.BufferGeometry();
  pos: Float32Array;
  tan: Float32Array;
  data: Float32Array;
  col: Float32Array;
  along: Float32Array;
  look: Float32Array;
  index: Uint32Array;
  nv = 0;
  ni = 0;
  readonly maxV: number;

  /** `routes`: crisp route lines drawn without depth test, above the clouds (renderOrder 43), horizon-tested. */
  constructor(maxV: number, additive: boolean, routes = false) {
    this.maxV = maxV;
    this.pos = new Float32Array(maxV * 3);
    this.tan = new Float32Array(maxV * 3);
    this.data = new Float32Array(maxV * 4);
    this.col = new Float32Array(maxV * 4);
    this.along = new Float32Array(maxV);
    this.look = new Float32Array(maxV);
    this.index = new Uint32Array(maxV * 3);
    const mk = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', mk(this.pos, 3));
    this.geo.setAttribute('aTan', mk(this.tan, 3));
    this.geo.setAttribute('aData', mk(this.data, 4));
    this.geo.setAttribute('aCol', mk(this.col, 4));
    this.geo.setAttribute('aAlong', mk(this.along, 1));
    this.geo.setAttribute('aLook', mk(this.look, 1));
    this.geo.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      name: routes ? 'fx-trails-route' : additive ? 'fx-trails-add' : 'fx-trails-alpha',
      defines: routes ? { ROUTE_LINES: 1 } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPixelK: sharedUniforms.uPixelK, uNoise: { value: additive ? 0 : 1 }, uTime: sharedUniforms.uTime },
      transparent: true,
      depthWrite: false,
      depthTest: !routes,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    // Routes: above clouds (30) and atmosphere (40), below island markers (44) and icons (45/46).
    this.mesh.renderOrder = routes ? 43 : additive ? 53 : 49;
    this.mesh.name = mat.name;
  }

  begin(): void {
    this.nv = 0;
    this.ni = 0;
  }

  end(): void {
    const g = this.geo;
    for (const name of RIBBON_ATTRS) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      if (this.nv > 0) a.addUpdateRange(0, this.nv * a.itemSize);
      a.needsUpdate = true;
    }
    const idx = g.index!;
    idx.clearUpdateRanges();
    if (this.ni > 0) idx.addUpdateRange(0, this.ni);
    idx.needsUpdate = true;
    g.setDrawRange(0, this.ni);
  }
}

const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tS0 = new THREE.Vector3(), tS1 = new THREE.Vector3();

export class TrailSystem {
  readonly group = new THREE.Group();
  private pool: Trail[] = [];
  private live: Trail[] = [];
  private alpha: RibbonBatch;
  private add: RibbonBatch;
  private routes: RibbonBatch;
  private now = 0;
  /** push() is inserting great-circle fill points (no nested fill). */
  private filling = false;
  private dist = new Float32Array(512);
  private tmpPts = new Float32Array(512 * 3);
  private tmpTimes = new Float32Array(512);
  private tmpAlong = new Float32Array(512);

  constructor(maxVerts: number) {
    this.alpha = new RibbonBatch(maxVerts, false);
    this.add = new RibbonBatch(Math.round(maxVerts * 0.5), true);
    this.routes = new RibbonBatch(Math.round(maxVerts * 0.75), false, true);
    this.group.add(this.alpha.mesh, this.add.mesh, this.routes.mesh);
  }

  setTime(t: number): void {
    this.now = t;
  }

  /** Start a new trail at a point. */
  start(key: TrailStyleKey, x: number, y: number, z: number, color?: THREE.Color): Trail {
    const style = TRAIL_STYLES[key];
    let tr: Trail | undefined;
    for (let i = 0; i < this.pool.length; i++) {
      if (this.pool[i].pts.length >= style.maxPts * 3) {
        tr = this.pool[i];
        this.pool[i] = this.pool[this.pool.length - 1];
        this.pool.pop();
        break;
      }
    }
    if (!tr) tr = new Trail(style.maxPts, style);
    tr.style = style;
    tr.inUse = true;
    tr.released = false;
    tr.opacity = 1;
    tr.maxLen = 0;
    tr.minSegKm = 0;
    tr.color.setRGB(style.color[0], style.color[1], style.color[2]);
    if (color) tr.color.copy(color);
    tr.count = 1;
    tr.head = 0;
    tr.pts[0] = x;
    tr.pts[1] = y;
    tr.pts[2] = z;
    tr.times[0] = this.now;
    tr.along[0] = 0;
    this.live.push(tr);
    return tr;
  }

  /** Move the live head; commits a new point once it moved `minSeg` km from the last committed one. */
  push(tr: Trail, x: number, y: number, z: number): void {
    const st = tr.style;
    const cap = st.maxPts;
    const h = tr.head;
    if (tr.count < 2) {
      // Commit a second point so the head can move independently.
      const n = (h + 1) % cap;
      tr.pts[n * 3] = x;
      tr.pts[n * 3 + 1] = y;
      tr.pts[n * 3 + 2] = z;
      tr.times[n] = this.now;
      tA.set(tr.pts[h * 3], tr.pts[h * 3 + 1], tr.pts[h * 3 + 2]);
      tr.along[n] = tr.along[h] + tA.distanceTo(tB.set(x, y, z)) * EARTH_RADIUS_KM;
      tr.head = n;
      tr.count = 2;
      return;
    }
    const seg = tr.minSegKm > 0 ? tr.minSegKm : st.minSeg;
    if (st.keepAll && !this.filling) {
      // Route lines follow the globe: a jump longer than two segments (a fast-forward, a stalled tab, a resync) is
      // filled with great-circle points instead of one straight chord that would cut under the surface.
      tA.set(tr.pts[h * 3], tr.pts[h * 3 + 1], tr.pts[h * 3 + 2]);
      tB.set(x, y, z);
      const jumpKm = tA.distanceTo(tB) * EARTH_RADIUS_KM;
      if (jumpKm > seg * 2) {
        const m = Math.min(512, Math.ceil(jumpKm / seg));
        const ra = tA.length(), rb = tB.length();
        const a0 = tS0.copy(tA).normalize(), b0 = tS1.copy(tB).normalize();
        const om = Math.acos(Math.min(1, Math.max(-1, a0.dot(b0))));
        const so = Math.sin(om);
        this.filling = true;
        for (let j = 1; j < m; j++) {
          const t = j / m;
          const ka = so > 1e-9 ? Math.sin((1 - t) * om) / so : 1 - t, kb = so > 1e-9 ? Math.sin(t * om) / so : t;
          const r = ra + (rb - ra) * t;
          this.push(tr, (a0.x * ka + b0.x * kb) * r, (a0.y * ka + b0.y * kb) * r, (a0.z * ka + b0.z * kb) * r);
        }
        this.filling = false;
      }
    }
    const h2 = tr.head;
    if (h2 !== h) {
      this.push(tr, x, y, z);
      return;
    }
    const p = (h - 1 + cap) % cap;
    tA.set(tr.pts[p * 3], tr.pts[p * 3 + 1], tr.pts[p * 3 + 2]);
    const dKm = tA.distanceTo(tB.set(x, y, z)) * EARTH_RADIUS_KM;
    if (dKm >= seg) {
      if (tr.count >= cap && st.keepAll) {
        this.decimate(tr);
        this.push(tr, x, y, z);
        return;
      }
      // Commit: the current head stays, a new live head is appended.
      const n = (h + 1) % cap;
      if (tr.count >= cap) tr.count--; // overwrite the oldest
      tr.head = n;
      tr.count++;
      tr.along[n] = tr.along[h] + tB.distanceTo(tA.set(tr.pts[h * 3], tr.pts[h * 3 + 1], tr.pts[h * 3 + 2])) * EARTH_RADIUS_KM;
    } else {
      tr.along[h] = tr.along[p] + dKm;
    }
    const hh = tr.head;
    tr.pts[hh * 3] = x;
    tr.pts[hh * 3 + 1] = y;
    tr.pts[hh * 3 + 2] = z;
    tr.times[hh] = this.now;
  }

  /** Keep the first point and every other one (and double the spacing): a route never loses its departure point. */
  private decimate(tr: Trail): void {
    const cap = tr.style.maxPts;
    const n = tr.count;
    const tmpP = this.tmpPts, tmpT = this.tmpTimes, tmpA = this.tmpAlong;
    let k = 0;
    for (let i = 0; i < n; i++) {
      // Oldest first; keep even indices, the newest committed point and the live head.
      if (i % 2 !== 0 && i < n - 2) continue;
      const src = (tr.head - (n - 1 - i) + cap * 2) % cap;
      tmpP[k * 3] = tr.pts[src * 3];
      tmpP[k * 3 + 1] = tr.pts[src * 3 + 1];
      tmpP[k * 3 + 2] = tr.pts[src * 3 + 2];
      tmpT[k] = tr.times[src];
      tmpA[k] = tr.along[src];
      k++;
    }
    for (let i = 0; i < k; i++) {
      tr.pts[i * 3] = tmpP[i * 3];
      tr.pts[i * 3 + 1] = tmpP[i * 3 + 1];
      tr.pts[i * 3 + 2] = tmpP[i * 3 + 2];
      tr.times[i] = tmpT[i];
      tr.along[i] = tmpA[i];
    }
    tr.count = k;
    tr.head = k - 1;
    tr.minSegKm = (tr.minSegKm > 0 ? tr.minSegKm : tr.style.minSeg) * 2;
  }

  /** Replace a trail's points (planned paths): `pts` = x,y,z triples, oldest first; the last one is the head. */
  setPath(tr: Trail, pts: ArrayLike<number>, n: number): void {
    const cap = tr.style.maxPts;
    const m = Math.min(n, cap);
    let along = 0;
    for (let i = 0; i < m; i++) {
      tr.pts[i * 3] = pts[i * 3];
      tr.pts[i * 3 + 1] = pts[i * 3 + 1];
      tr.pts[i * 3 + 2] = pts[i * 3 + 2];
      tr.times[i] = this.now;
      if (i > 0) {
        const dx = pts[i * 3] - pts[i * 3 - 3], dy = pts[i * 3 + 1] - pts[i * 3 - 2], dz = pts[i * 3 + 2] - pts[i * 3 - 1];
        along += Math.sqrt(dx * dx + dy * dy + dz * dz) * EARTH_RADIUS_KM;
      }
      tr.along[i] = along;
    }
    tr.count = m;
    tr.head = Math.max(0, m - 1);
  }

  /** Live (not released) trails by style (debug / budgets). */
  countLive(style: TrailStyle): number {
    let n = 0;
    for (const t of this.live) if (t.style === style && !t.released) n++;
    return n;
  }

  /** The emitter is gone: let the trail fade out on its own. */
  release(tr: Trail | null | undefined): void {
    if (tr && !tr.released) {
      tr.released = true;
      tr.releasedAt = this.now;
    }
  }

  /** Remove a trail now (no hold, no fade): it is recycled on the next update. */
  kill(tr: Trail | null | undefined): void {
    if (!tr) return;
    tr.released = true;
    tr.releasedAt = this.now;
    tr.count = 0;
  }

  clear(): void {
    for (const t of this.live) {
      t.inUse = false;
      this.pool.push(t);
    }
    this.live.length = 0;
    this.alpha.begin();
    this.alpha.end();
    this.add.begin();
    this.add.end();
    this.routes.begin();
    this.routes.end();
  }

  get liveCount(): number {
    return this.live.length;
  }

  update(): void {
    const now = this.now;
    this.alpha.begin();
    this.add.begin();
    this.routes.begin();
    for (let li = this.live.length - 1; li >= 0; li--) {
      const tr = this.live[li];
      const st = tr.style;
      const cap = st.maxPts;
      // Drop expired points from the tail.
      while (tr.count > 0) {
        const tail = (tr.head - tr.count + 1 + cap * 2) % cap;
        if (now - tr.times[tail] > st.life && (tr.released || tr.count > 2)) tr.count--;
        else break;
      }
      const rf = st.releaseFade > 0 && tr.released ? 1 - Math.max(0, now - tr.releasedAt - st.hold) / st.releaseFade : 1;
      if (tr.count < 2 || rf <= 0) {
        if (tr.released || tr.count === 0) {
          tr.inUse = false;
          this.live[li] = this.live[this.live.length - 1];
          this.live.pop();
          this.pool.push(tr);
        }
        continue;
      }
      const b = st.look > 0 ? this.routes : st.additive ? this.add : this.alpha;
      // Length limit: walk back from the head, stop one point past maxLen.
      let n = tr.count;
      let cutF = 1;
      const dist = this.dist;
      dist[0] = 0;
      for (let k = 1; k < tr.count; k++) {
        const i0 = (tr.head - k + 1 + cap) % cap, i1 = (tr.head - k + cap) % cap;
        const dx = tr.pts[i0 * 3] - tr.pts[i1 * 3], dy = tr.pts[i0 * 3 + 1] - tr.pts[i1 * 3 + 1], dz = tr.pts[i0 * 3 + 2] - tr.pts[i1 * 3 + 2];
        dist[k] = dist[k - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (tr.maxLen > 0 && dist[k] >= tr.maxLen) {
          n = k + 1;
          // The last segment is cut exactly at maxLen (sim ticks can leave long segments).
          const segLen = dist[k] - dist[k - 1];
          cutF = segLen > 1e-12 ? (tr.maxLen - dist[k - 1]) / segLen : 1;
          dist[k] = tr.maxLen;
          break;
        }
      }
      if (b.nv + n * 2 > b.maxV) continue;
      const base = b.nv;
      const minPx = st.flat ? -st.minPx : st.minPx;
      for (let k = 0; k < n; k++) {
        const i = (tr.head - k + cap) % cap; // k = 0 newest
        const iPrev = (i - 1 + cap) % cap, iNext = (i + 1) % cap;
        let px = tr.pts[i * 3], py = tr.pts[i * 3 + 1], pz = tr.pts[i * 3 + 2];
        if (k === n - 1 && cutF < 1 && k > 0) {
          const j = (i + 1) % cap;
          px = tr.pts[j * 3] + (px - tr.pts[j * 3]) * cutF;
          py = tr.pts[j * 3 + 1] + (py - tr.pts[j * 3 + 1]) * cutF;
          pz = tr.pts[j * 3 + 2] + (pz - tr.pts[j * 3 + 2]) * cutF;
        }
        // Tangent from neighbours (toward the head).
        let ax: number, ay: number, az: number;
        if (k === 0) {
          ax = px - tr.pts[iPrev * 3]; ay = py - tr.pts[iPrev * 3 + 1]; az = pz - tr.pts[iPrev * 3 + 2];
        } else if (k === n - 1) {
          ax = tr.pts[iNext * 3] - px; ay = tr.pts[iNext * 3 + 1] - py; az = tr.pts[iNext * 3 + 2] - pz;
        } else {
          ax = tr.pts[iNext * 3] - tr.pts[iPrev * 3]; ay = tr.pts[iNext * 3 + 1] - tr.pts[iPrev * 3 + 1]; az = tr.pts[iNext * 3 + 2] - tr.pts[iPrev * 3 + 2];
        }
        const lenK = tr.maxLen > 0 ? Math.min(1, dist[k] / tr.maxLen) : 0;
        const age = st.look > 0 ? 0 : Math.min(1, Math.max(lenK, (now - tr.times[i]) / st.life));
        const wKm = st.w0 + (st.w1 - st.w0) * Math.sqrt(age);
        const w = wKm / EARTH_RADIUS_KM;
        let a = st.alpha * tr.opacity * rf * Math.pow(1 - age, st.fade);
        if (st.look === 0) {
          // Fade in the very first segment at the emitter so the ribbon does not start with a hard cap.
          if (k === 0 && !st.additive) a *= 0.35;
          if (k === n - 1) a = 0;
        }
        for (let s = 0; s < 2; s++) {
          const v = b.nv++;
          b.pos[v * 3] = px; b.pos[v * 3 + 1] = py; b.pos[v * 3 + 2] = pz;
          b.tan[v * 3] = ax; b.tan[v * 3 + 1] = ay; b.tan[v * 3 + 2] = az;
          b.data[v * 4] = s === 0 ? -1 : 1;
          b.data[v * 4 + 1] = age;
          b.data[v * 4 + 2] = w;
          b.data[v * 4 + 3] = minPx;
          b.col[v * 4] = tr.color.r; b.col[v * 4 + 1] = tr.color.g; b.col[v * 4 + 2] = tr.color.b;
          b.col[v * 4 + 3] = a;
          b.along[v] = tr.along[i];
          b.look[v] = st.look;
        }
        if (k > 0) {
          const v0 = base + (k - 1) * 2, v1 = base + k * 2;
          b.index[b.ni++] = v0; b.index[b.ni++] = v0 + 1; b.index[b.ni++] = v1;
          b.index[b.ni++] = v1; b.index[b.ni++] = v0 + 1; b.index[b.ni++] = v1 + 1;
        }
      }
    }
    this.alpha.end();
    this.add.end();
    this.routes.end();
  }
}
