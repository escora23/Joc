// FRONT ULTRA — the front overlay seen from orbit (DESIGN_V2 §11.2; owner: battle, W6).
//
// From 150 km up, every front of the simulation reads as a map symbol drawn over the globe (and over the clouds):
//   * FRONT BAND along the sub-tile contact line, split lengthwise into the two nations' colours (side a behind the
//     line, side b ahead of it), 1.5 tiles wide in world space with a 14 px minimum. Chevrons scroll across it toward
//     the side that is losing ground, at a speed proportional to the MEASURED advance (FrontView.advanceKmh); there
//     are none while |momentum| <= 0.1. QUIET fronts (at war, no offensive) are a thin dashed two-colour line.
//   * OPERATIONAL ARROW per offensive (owner item #22 overrides the older «as wide as the corridor»): a SLIM shaft
//     (4-7 px, at most 5 % of the corridor) from 3 tiles behind the attacker's line to the axis point, whose tip lands on
//     it (or 2 tiles past the line when the line already went beyond it), a proportional head, attacker colour,
//     semi-transparent with a dark hairline. The corridor it pushes on (never wider than its front) is two faint dashed
//     rails, not a filled body. It is drawn BELOW the front bands and lets every border line show through it (the
//     territory owner texture knocks it out on borders), and fades out as the camera comes in: gone below 1,000 km,
//     where the band, its chevrons and the borders tell the battle.
//   * NAVAL INVASION arrows along the convoy's planned route, ending at the landing.
//   * MOBILIZATION arrows: while a war's aggressor mobilizes (tick < mobilizeUntilTick), short pulsing arrows on its
//     side of the border pointing at the target; they disappear with the mobilization window.
// The badges (ISO3 chips, tug-of-war bar, measured km/h, hover, click) are DOM, in src/ui/hud/frontBadges.ts.
//
// Two draw calls (bands, arrows), renderOrder 42/43 with depth test off: above the clouds (30) and the atmosphere
// (40), under the unit icons (45/46). An analytic horizon test fades the far side. Widths are extruded in screen space
// in the vertex shader from the world half-width and a pixel minimum, so the same geometry reads at every altitude.
// Geometry is rebuilt only when the sim publishes new fronts / offensives / wars (and twice a second for the moving
// convoys) into preallocated buffers: nothing is allocated per frame.

import * as THREE from 'three';
import type { GameContext } from '../../shared/api';
import { MAP_H, MAP_W, TILE_KM } from '../../shared/constants';
import { latLonToVec3, tileXYToLatLon, wrapDX } from '../../shared/geo';
import { smoothstep } from '../../shared/math';
import { UnitState, UnitType, type AttackView, type FrontView, type LatLon } from '../../shared/types';
import { inverseToneGlsl } from '../units/icons';
import { separateTeamColors } from './common';

/** Visible above this camera altitude (km), fully from OVERLAY_FULL_ALT. */
export const OVERLAY_MIN_ALT = 150;
const OVERLAY_FULL_ALT = 260;
const BAND_VERTS = 16384;
const ARROW_VERTS = 16384;
/** Half-width of an active band in km (1.5 tiles in all) and its pixel minimum; the same for quiet dashed lines. */
const BAND_HALF_KM = TILE_KM * 0.75;
const BAND_MIN_HALF_PX = 7;
const QUIET_HALF_KM = 5;
const QUIET_MIN_HALF_PX = 2.6;
/** A sample gap longer than this (tiles) breaks the band (a PCA-ordered cluster with a hole). */
const MAX_GAP_TILES = 4.5;
const R_KM = 6371;

export interface FrontOverlay {
  readonly group: THREE.Group;
  update(visualDt: number, altKm: number, visible: boolean): void;
  clear(): void;
  /** Verifiers: hide the arrows batch alone (the pixel difference is the drawn arrow). */
  setArrowsVisible(v: boolean): void;
  /** Verifiers: the arrows' fade at the current altitude (0 gone .. 1 full). */
  arrowFade(): number;
  /** Shots and verifiers: what was drawn at the last rebuild. */
  stats(): OverlayStats;
}

/** One operational arrow as drawn (verifiers project these points and measure the pixels independently). */
export interface ArrowStat {
  attackId: number;
  frontKey: number;
  attacker: number;
  /** Corridor as the sim publishes it, and as drawn (the rails' separation: never wider than the front). */
  corridorKm: number;
  railsKm: number;
  /** The front's own contact length. */
  frontKm: number;
  /** Shaft: world half-width and its pixel clamp; head: the same, and its length. */
  shaftHalfKm: number;
  shaftPx: [number, number];
  headHalfKm: number;
  headPx: [number, number];
  headLenKm: number;
  lengthKm: number;
  /** Where the symbol starts, where its tip lands and the offensive's axis point (lat, lon). */
  tail: [number, number];
  tip: [number, number];
  axis: [number, number];
  /** The shaft at its middle: a point and the next one along it (lat, lon), for a perpendicular pixel profile. */
  mid: [number, number, number, number];
}

export interface OverlayStats {
  fronts: number;
  quiet: number;
  arrows: ArrowStat[];
  naval: number;
  mobilization: number;
  /** Per front key: the chevron direction (+1 toward side b, -1 toward side a, 0 none) and their speed px/s. */
  chevrons: Record<number, { dir: number; speed: number }>;
  drawCalls: number;
  /** Draw order: the arrows under the bands (#22). */
  order: { bands: number; arrows: number };
  bandVerts: number;
  arrowVerts: number;
  rebuilds: number;
}

// -------------------------------------------------------------------------------------------------
// Shaders
// -------------------------------------------------------------------------------------------------

const COMMON_VERT = /* glsl */ `
uniform vec2 uRes;
uniform float uPx;
varying float vVis;
// Screen-space extrusion of a centreline vertex p (world) across the projected tangent, toward the projected 'ref'
// (a world direction across the line), by max(halfKm in pixels, minPx). Returns the clip position; outputs the pixel
// half-width and the pixels per km at this vertex.
vec4 extrude(vec3 p, vec3 tan, vec3 ref, float side, float halfKm, float minPx, float maxPx, out float halfPx, out float pxPerKm) {
  mat4 pv = projectionMatrix * viewMatrix;
  vec4 c0 = pv * vec4(p, 1.0);
  const float EPS = 0.002; // world units (12.7 km)
  vec4 c1 = pv * vec4(p + tan * EPS, 1.0);
  vec4 c2 = pv * vec4(p + ref * EPS, 1.0);
  vec2 h = 0.5 * uRes;
  vec2 s0 = c0.xy / c0.w * h, s1 = c1.xy / c1.w * h, s2 = c2.xy / c2.w * h;
  vec2 dt = s1 - s0;
  float lt = length(dt);
  dt = lt > 1e-5 ? dt / lt : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dt.y, dt.x);
  vec2 dr = s2 - s0;
  if (dot(nrm, dr) < 0.0) nrm = -nrm;
  pxPerKm = max(length(dr), lt) / (EPS * ${R_KM.toFixed(1)});
  halfPx = min(max(minPx * uPx, halfKm * pxPerKm), maxPx * uPx);
  c0.xy += nrm * side * halfPx / h * c0.w;
  // Analytic horizon: fade what lies behind the limb.
  vec3 n = normalize(p);
  vVis = smoothstep(-0.015, 0.03, dot(n, normalize(cameraPosition - p)));
  if (c0.w <= 0.0) vVis = 0.0;
  return c0;
}`;

const BAND_VERT = /* glsl */ `
attribute vec3 aTan;
attribute vec3 aRef;
attribute vec3 aGeo;   // cross (-1 side a .. +1 side b), u (km along the line), half-width km
attribute vec3 aColA;
attribute vec3 aColB;
attribute vec4 aInfo;  // chevron dir (+1 toward b, -1 toward a, 0 none), chevron speed px/s, quiet, emphasis
varying vec3 vColA;
varying vec3 vColB;
varying vec4 vInfo;
varying float vCross;
varying float vUpx;
varying float vHalfPx;
${COMMON_VERT}
void main() {
  bool quiet = aInfo.z > 0.5;
  float halfPx, pxPerKm;
  float minPx = quiet ? ${QUIET_MIN_HALF_PX.toFixed(2)} + aInfo.w * 0.8 : ${BAND_MIN_HALF_PX.toFixed(2)} + aInfo.w * 1.0;
  gl_Position = extrude(position, aTan, aRef, aGeo.x, aGeo.z, minPx, 1e5, halfPx, pxPerKm);
  vColA = aColA;
  vColB = aColB;
  vInfo = aInfo;
  vCross = aGeo.x;
  vUpx = aGeo.y * pxPerKm;
  vHalfPx = halfPx;
}`;

const BAND_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform float uPx;
varying vec3 vColA;
varying vec3 vColB;
varying vec4 vInfo;
varying float vCross;
varying float vUpx;
varying float vHalfPx;
varying float vVis;
${inverseToneGlsl()}
void main() {
  float a = uAlpha * vVis;
  if (a < 0.003) discard;
  float side = vCross;
  vec3 col = side < 0.0 ? vColA : vColB;
  float edgePx = (1.0 - abs(side)) * vHalfPx;
  float midPx = abs(side) * vHalfPx;
  if (vInfo.z > 0.5) {
    // Quiet front: a dashed two-colour line.
    float dash = fract(vUpx / (20.0 * uPx));
    if (dash > 0.6) discard;
    col = mix(col, vec3(0.02), (1.0 - smoothstep(0.6, 1.4, edgePx / uPx)) * 0.8);
    gl_FragColor = vec4(untone(col), a * 0.95);
    return;
  }
  // The contact seam and a dark outline keep both colours legible over any territory.
  col = mix(col, vec3(0.02), (1.0 - smoothstep(0.35, 1.1, midPx / uPx)) * 0.9);
  col = mix(col, vec3(0.02), (1.0 - smoothstep(0.9, 2.0, edgePx / uPx)) * 0.9);
  // Chevrons toward the side losing ground: bold Λ marks (light core, dark rim) across the whole band, scrolling
  // toward their apex at a speed that follows the measured advance.
  if (abs(vInfo.x) > 0.5) {
    float y = side * vHalfPx * vInfo.x;
    float P = max(22.0 * uPx, vHalfPx * 2.4);
    float cx = mod(vUpx, P) - 0.5 * P;
    float d = y + abs(cx) * 0.9 - uTime * vInfo.y * uPx;
    float per = vHalfPx * 1.35;
    float f = fract(d / per);
    float inCell = 1.0 - smoothstep(0.4 * P, 0.46 * P, abs(cx));
    float core = smoothstep(0.1, 0.14, f) * (1.0 - smoothstep(0.48, 0.52, f));
    float rim = smoothstep(0.03, 0.07, f) * (1.0 - smoothstep(0.56, 0.6, f)) - core;
    float inside = 1.0 - smoothstep(0.8, 1.6, edgePx / uPx);
    col = mix(col, vec3(0.02), max(rim, 0.0) * inCell * 0.85 * (1.0 - inside));
    col = mix(col, vec3(0.98, 0.96, 0.9), core * inCell * 0.95 * (1.0 - inside));
  }
  gl_FragColor = vec4(untone(col), a * 0.94);
}`;

const ARROW_VERT = /* glsl */ `
attribute vec3 aTan;
attribute vec3 aRef;
attribute vec3 aGeo;   // side (-1..1), u (0 at the tail .. 1 at the tip), half-width km
attribute vec3 aCol;
attribute vec4 aInfo;  // kind (0 operational, 1 naval, 2 mobilization, 3 corridor rail), min half px, phase (rail: length km), max half px
varying vec3 vCol;
varying vec4 vInfo;
varying float vSide;
varying float vU;
varying float vHalfPx;
varying vec3 vWorld;
${COMMON_VERT}
void main() {
  float halfPx, pxPerKm;
  gl_Position = extrude(position, aTan, aRef, aGeo.x, aGeo.z, aInfo.y, aInfo.w, halfPx, pxPerKm);
  // The fragment's own ground point (the extrusion is in screen space): the border knock-out samples ownership there.
  vec3 nn = normalize(position);
  vec3 across = aRef - dot(aRef, nn) * nn;
  float al = length(across);
  vWorld = position + (al > 1e-9 ? across / al : vec3(0.0)) * aGeo.x * (halfPx / max(pxPerKm, 1e-6)) / ${R_KM.toFixed(1)};
  vCol = aCol;
  vInfo = aInfo;
  vSide = aGeo.x;
  vU = aGeo.y;
  vHalfPx = halfPx;
}`;

const ARROW_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform float uArrowFill;
uniform float uPx;
uniform sampler2D uOwner;
uniform float uOwnerOn;
varying vec3 vCol;
varying vec4 vInfo;
varying float vSide;
varying float vU;
varying float vHalfPx;
varying float vVis;
varying vec3 vWorld;
${inverseToneGlsl()}
float ownerAt(vec2 uv) {
  vec4 o = texture2D(uOwner, uv);
  return floor(o.r * 255.0 + 0.5) + mod(floor(o.g * 255.0 + 0.5), 8.0) * 256.0;
}
// 1 where a border (or a coast) passes within ~1.6 px of this fragment: the symbol lets it show through.
float borderHere() {
  vec3 n = normalize(vWorld);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  vec2 uv = vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.1415927);
  vec2 d = min(fwidth(uv) * 1.6, vec2(0.004));
  float c = ownerAt(uv);
  float b = 0.0;
  b = max(b, step(0.5, abs(ownerAt(uv + vec2(d.x, 0.0)) - c)));
  b = max(b, step(0.5, abs(ownerAt(uv - vec2(d.x, 0.0)) - c)));
  b = max(b, step(0.5, abs(ownerAt(uv + vec2(0.0, d.y)) - c)));
  b = max(b, step(0.5, abs(ownerAt(uv - vec2(0.0, d.y)) - c)));
  return b * uOwnerOn;
}
void main() {
  float a = uAlpha * vVis;
  if (a < 0.003) discard;
  float edgePx = (1.0 - abs(vSide)) * vHalfPx;
  float outline = 1.0 - smoothstep(0.6 * uPx, 1.3 * uPx, edgePx);
  vec3 col = mix(vCol, vec3(0.02), outline * 0.85);
  float alpha;
  if (vInfo.x < 0.5) {
    // Operational arrow (#22): a slim, semi-transparent shaft and head with a dark hairline; the tail fades in; the
    // whole symbol fades out as the camera comes in (gone below 1,000 km) and never covers a border.
    alpha = mix(0.58, 0.8, outline) * smoothstep(0.0, 0.15, vU) * uArrowFill;
    if (alpha < 0.003) discard;
    alpha *= 1.0 - 0.88 * borderHere();
  } else if (vInfo.x > 3.5) {
    // The axis point: a small ring where the tip lands (the place the offensive drives to).
    alpha = 0.9 * uArrowFill;
    if (alpha < 0.003) discard;
  } else if (vInfo.x > 2.5) {
    // Corridor rail: a faint dashed hairline along each flank of the corridor.
    float dash = fract(vU * vInfo.z / 22.0);
    if (dash > 0.55) discard;
    col = mix(vCol, vec3(0.97, 0.96, 0.92), 0.3);
    alpha = 0.5 * uArrowFill;
    if (alpha < 0.003) discard;
    alpha *= 1.0 - 0.88 * borderHere();
  } else if (vInfo.x < 1.5) {
    alpha = 0.85 * smoothstep(0.0, 0.08, vU);
  } else {
    // Mobilization: pulsing.
    alpha = (0.45 + 0.45 * sin(uTime * 4.2 + vInfo.z)) * smoothstep(0.0, 0.25, vU);
  }
  gl_FragColor = vec4(untone(col), a * alpha);
}`;

// -------------------------------------------------------------------------------------------------
// Buffers
// -------------------------------------------------------------------------------------------------

interface Batch {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  tan: Float32Array;
  ref: Float32Array;
  geoA: Float32Array;
  info: Float32Array;
  colA: Float32Array;
  colB: Float32Array | null;
  index: Uint32Array;
  nv: number;
  ni: number;
  cap: number;
}

function makeBatch(cap: number, two: boolean, mat: THREE.ShaderMaterial, order: number): Batch {
  const geo = new THREE.BufferGeometry();
  const attr = (name: string, n: number) => {
    const arr = new Float32Array(cap * n);
    const a = new THREE.BufferAttribute(arr, n);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return arr;
  };
  const pos = attr('position', 3);
  const tan = attr('aTan', 3);
  const ref = attr('aRef', 3);
  const geoA = attr('aGeo', 3);
  const info = attr('aInfo', 4);
  const colA = attr(two ? 'aColA' : 'aCol', 3);
  const colB = two ? attr('aColB', 3) : null;
  const index = new Uint32Array(cap * 3);
  const ia = new THREE.BufferAttribute(index, 1);
  ia.setUsage(THREE.DynamicDrawUsage);
  geo.setIndex(ia);
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return { mesh, geo, pos, tan, ref, geoA, info, colA, colB, index, nv: 0, ni: 0, cap };
}

function flush(b: Batch): void {
  const g = b.geo;
  for (const k of ['position', 'aTan', 'aRef', 'aGeo', 'aInfo', 'aColA', 'aCol', 'aColB']) {
    const a = g.getAttribute(k) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    a.clearUpdateRanges();
    a.addUpdateRange(0, b.nv * a.itemSize);
    a.needsUpdate = true;
  }
  const ix = g.getIndex()!;
  ix.clearUpdateRanges();
  ix.addUpdateRange(0, b.ni);
  ix.needsUpdate = true;
  g.setDrawRange(0, b.ni);
}

// -------------------------------------------------------------------------------------------------
// The overlay
// -------------------------------------------------------------------------------------------------

export function createFrontOverlay(ctx: GameContext): FrontOverlay {
  const ownerFallback = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  ownerFallback.needsUpdate = true;
  const group = new THREE.Group();
  group.name = 'front-overlay';
  const uniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uPx: { value: 1 },
    uTime: { value: 0 },
    uAlpha: { value: 1 },
    uArrowFill: { value: 1 },
    uOwner: { value: ownerFallback as THREE.Texture },
    uOwnerOn: { value: 0 },
  };
  const mk = (vs: string, fs: string, name: string) => new THREE.ShaderMaterial({
    name, uniforms, vertexShader: vs, fragmentShader: fs, transparent: true, depthTest: false, depthWrite: false,
    side: THREE.DoubleSide,
  });
  const bands = makeBatch(BAND_VERTS, true, mk(BAND_VERT, BAND_FRAG, 'front-bands'), 43);
  const arrows = makeBatch(ARROW_VERTS, false, mk(ARROW_VERT, ARROW_FRAG, 'front-arrows'), 42);
  // (st.order is filled below from the meshes themselves.)
  group.add(arrows.mesh, bands.mesh);

  // ---- scratch (no allocation in the hot paths) ----
  const ll: LatLon = { lat: 0, lon: 0 };
  const P = new THREE.Vector3(), Q = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), R = new THREE.Vector3();
  const U = new THREE.Vector3();
  const lineX = new Float32Array(80), lineY = new Float32Array(80);
  const curveX = new Float32Array(64), curveY = new Float32Array(64);
  const rgbA: [number, number, number] = [0, 0, 0];
  const rgbB: [number, number, number] = [0, 0, 0];
  const st: OverlayStats = { fronts: 0, quiet: 0, arrows: [], naval: 0, mobilization: 0, chevrons: {}, drawCalls: 2, order: { bands: 43, arrows: 42 }, bandVerts: 0, arrowVerts: 0, rebuilds: 0 };

  st.order.bands = bands.mesh.renderOrder;
  st.order.arrows = arrows.mesh.renderOrder;
  let lastFronts: readonly FrontView[] | null = null;
  let lastAttacks: readonly AttackView[] | null = null;
  let lastWars: unknown = null;
  let lastTick = -1;
  let rebuildAcc = 0;
  let time = 0;

  const surf = (lat: number, lon: number) => ctx.globe.surfaceRadiusAt(lat, lon) + 0.00012;
  /** World position of a continuous tile point on the ground. */
  function world(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const yy = Math.min(MAP_H - 1e-3, Math.max(1e-3, y));
    tileXYToLatLon(((x % MAP_W) + MAP_W) % MAP_W, yy, ll);
    return latLonToVec3(ll.lat, ll.lon, surf(ll.lat, ll.lon), out);
  }
  function rgb(c: number, out: [number, number, number]): [number, number, number] {
    out[0] = ((c >> 16) & 255) / 255;
    out[1] = ((c >> 8) & 255) / 255;
    out[2] = (c & 255) / 255;
    return out;
  }
  const colorOf = (id: number) => ctx.sim.view.players[id]?.color ?? 0x9a9a9a;

  // ---- vertex writers ----
  function bandVert(p: THREE.Vector3, tan: THREE.Vector3, ref: THREE.Vector3, cross: number, u: number, halfKm: number,
    info0: number, info1: number, info2: number, info3: number): number {
    const b = bands;
    const i = b.nv++;
    b.pos[i * 3] = p.x; b.pos[i * 3 + 1] = p.y; b.pos[i * 3 + 2] = p.z;
    b.tan[i * 3] = tan.x; b.tan[i * 3 + 1] = tan.y; b.tan[i * 3 + 2] = tan.z;
    b.ref[i * 3] = ref.x; b.ref[i * 3 + 1] = ref.y; b.ref[i * 3 + 2] = ref.z;
    b.geoA[i * 3] = cross; b.geoA[i * 3 + 1] = u; b.geoA[i * 3 + 2] = halfKm;
    b.info[i * 4] = info0; b.info[i * 4 + 1] = info1; b.info[i * 4 + 2] = info2; b.info[i * 4 + 3] = info3;
    b.colA[i * 3] = rgbA[0]; b.colA[i * 3 + 1] = rgbA[1]; b.colA[i * 3 + 2] = rgbA[2];
    b.colB![i * 3] = rgbB[0]; b.colB![i * 3 + 1] = rgbB[1]; b.colB![i * 3 + 2] = rgbB[2];
    return i;
  }
  function arrowVert(p: THREE.Vector3, tan: THREE.Vector3, ref: THREE.Vector3, side: number, u: number, halfKm: number,
    kind: number, minPx: number, phase: number, maxPx: number): number {
    const b = arrows;
    const i = b.nv++;
    b.pos[i * 3] = p.x; b.pos[i * 3 + 1] = p.y; b.pos[i * 3 + 2] = p.z;
    b.tan[i * 3] = tan.x; b.tan[i * 3 + 1] = tan.y; b.tan[i * 3 + 2] = tan.z;
    b.ref[i * 3] = ref.x; b.ref[i * 3 + 1] = ref.y; b.ref[i * 3 + 2] = ref.z;
    b.geoA[i * 3] = side; b.geoA[i * 3 + 1] = u; b.geoA[i * 3 + 2] = halfKm;
    b.info[i * 4] = kind; b.info[i * 4 + 1] = minPx; b.info[i * 4 + 2] = phase; b.info[i * 4 + 3] = maxPx;
    b.colA[i * 3] = rgbA[0]; b.colA[i * 3 + 1] = rgbA[1]; b.colA[i * 3 + 2] = rgbA[2];
    return i;
  }
  function quad(b: Batch, i0: number, i1: number, i2: number, i3: number): void {
    // i0, i1: previous pair (left, right); i2, i3: next pair.
    const ix = b.index;
    ix[b.ni++] = i0; ix[b.ni++] = i1; ix[b.ni++] = i2;
    ix[b.ni++] = i1; ix[b.ni++] = i3; ix[b.ni++] = i2;
  }

  /** Tangent-plane 'across' direction at p for a tangent t, oriented toward the tile-space direction (dx, dy). */
  function crossDir(p: THREE.Vector3, t: THREE.Vector3, x: number, y: number, dx: number, dy: number, out: THREE.Vector3): THREE.Vector3 {
    N.copy(p).normalize();
    out.crossVectors(N, t).normalize();
    world(x + dx * 0.4, y + dy * 0.4, Q).sub(p);
    if (out.dot(Q) < 0) out.negate();
    return out;
  }

  // ---- fronts -------------------------------------------------------------------------------------
  function addFront(f: FrontView, human: number): void {
    const s = f.samples;
    const n = Math.min(s.length >> 1, lineX.length);
    if (n < 1) return;
    const aPush = f.offensiveA !== 0, bPush = !aPush && f.offensiveB !== 0;
    // The contact line: half a tile ahead of side a's contact tiles, moved into the tile being taken by its
    // pressure progress where the sim publishes it (near the observation focus).
    for (let v = 0; v < n; v++) {
      const pr = f.progress && v < f.progress.length ? f.progress[v] / 255 : 0;
      const off = aPush ? 0.5 + pr : bPush ? 0.5 - pr : 0.5;
      lineX[v] = s[v * 2] + f.dirX * off;
      lineY[v] = s[v * 2 + 1] + f.dirY * off;
    }
    for (let v = 1; v < n; v++) lineX[v] = lineX[v - 1] + wrapDX(lineX[v - 1], lineX[v]);
    const quiet = f.quiet || (!aPush && !bPush);
    const emph = f.a === human || f.b === human ? 1 : 0;
    let chev = 0, speed = 0;
    if (!quiet && Math.abs(f.momentum) > 0.1) {
      chev = f.momentum > 0 ? 1 : -1;
      speed = 7 + Math.min(10, f.advanceKmh) * 2.6;
    }
    st.chevrons[f.key] = { dir: chev, speed };
    rgb(colorOf(f.a), rgbA);
    rgb(separateTeamColors(colorOf(f.a), colorOf(f.b)), rgbB);
    const halfKm = quiet ? QUIET_HALF_KM : BAND_HALF_KM;
    const qf = quiet ? 1 : 0;
    // A single-sample front: a short stub across the advance.
    const segs = n === 1 ? 1 : n - 1;
    if (bands.nv + (segs + 1) * 2 + 4 > bands.cap) return;
    let prevL = -1, prevR = -1, u = 0;
    for (let v = 0; v <= segs; v++) {
      let x: number, y: number;
      if (n === 1) {
        // Perpendicular to dir, ±0.6 tile.
        const k = v === 0 ? -0.6 : 0.6;
        x = lineX[0] - f.dirY * k;
        y = lineY[0] + f.dirX * k;
      } else {
        x = lineX[v];
        y = lineY[v];
      }
      world(x, y, P);
      // Tangent: central difference along the line.
      const v0 = Math.max(0, v - 1), v1 = Math.min(n === 1 ? 1 : n - 1, v + 1);
      const x0 = n === 1 ? lineX[0] + f.dirY * 0.6 : lineX[v0], y0 = n === 1 ? lineY[0] - f.dirX * 0.6 : lineY[v0];
      const x1 = n === 1 ? lineX[0] - f.dirY * 0.6 : lineX[v1], y1 = n === 1 ? lineY[0] + f.dirX * 0.6 : lineY[v1];
      world(x1, y1, T);
      world(x0, y0, Q);
      T.sub(Q);
      if (T.lengthSq() < 1e-14) T.set(1, 0, 0);
      T.normalize();
      crossDir(P, T, x, y, f.dirX, f.dirY, R);
      if (v > 0) {
        const gap = Math.hypot(wrapDX(lineX[v - 1], x) * Math.cos((ll.lat * Math.PI) / 180), y - lineY[v - 1]);
        u += gap * TILE_KM;
        if (n > 1 && Math.hypot(wrapDX(lineX[v - 1], x), y - lineY[v - 1]) > MAX_GAP_TILES) prevL = -1;
      }
      const l = bandVert(P, T, R, -1, u, halfKm, chev, speed, qf, emph);
      const r = bandVert(P, T, R, 1, u, halfKm, chev, speed, qf, emph);
      if (prevL >= 0) quad(bands, prevL, prevR, l, r);
      prevL = l;
      prevR = r;
    }
    st.fronts++;
    if (quiet) st.quiet++;
  }

  // ---- arrows -------------------------------------------------------------------------------------
  /** Length (km) of the tile-space polyline curveX/Y[0..m). */
  function curveLen(m: number): number {
    let len = 0;
    for (let k = 1; k < m; k++) {
      const cl = Math.cos(((90 - (curveY[k] / MAP_H) * 180) * Math.PI) / 180);
      len += Math.hypot(wrapDX(curveX[k - 1], curveX[k]) * cl, curveY[k] - curveY[k - 1]) * TILE_KM;
    }
    return len;
  }

  /**
   * An arrow along the tile-space polyline curveX/Y[0..m): shaft half-width halfKm clamped to [minPx, maxPx] on screen;
   * a head of half-width headHalfKm ([headMinPx, headMaxPx]) and length headLenKm ending exactly on the last point
   * (headLenKm 0: no head, a plain line). kind 0 operational, 1 naval, 2 mobilization, 3 corridor rail.
   */
  function addArrow(m: number, kind: number, halfKm: number, minPx: number, maxPx: number,
    headHalfKm: number, headMinPx: number, headMaxPx: number, headLenKm: number, phase: number): number {
    if (m < 2) return 0;
    const len = curveLen(m);
    if (len < 1) return 0;
    const headLen = Math.min(len * 0.5, headLenKm);
    const ph = kind === 3 ? len : phase;
    if (arrows.nv + m * 2 + 8 > arrows.cap) return 0;
    let acc = 0, prevL = -1, prevR = -1;
    const shaftEnd = len - headLen;
    let lastX = curveX[0], lastY = curveY[0];
    for (let k = 0; k < m; k++) {
      const x = curveX[k], y = curveY[k];
      if (k > 0) {
        const cl = Math.cos(((90 - (y / MAP_H) * 180) * Math.PI) / 180);
        acc += Math.hypot(wrapDX(lastX, x) * cl, y - lastY) * TILE_KM;
      }
      lastX = x;
      lastY = y;
      const tailEnd = (headLen > 0 && acc >= shaftEnd) || k === m - 1;
      // Clamp this vertex to the head base.
      let px = x, py = y, u = acc;
      if (tailEnd && headLen > 0) {
        // Interpolate the head base point on the previous segment.
        const over = acc - shaftEnd;
        if (k > 0) {
          const cl = Math.cos(((90 - (y / MAP_H) * 180) * Math.PI) / 180);
          const segKm = Math.max(1e-6, Math.hypot(wrapDX(curveX[k - 1], x) * cl, y - curveY[k - 1]) * TILE_KM);
          const tt = Math.max(0, Math.min(1, 1 - over / segKm));
          px = curveX[k - 1] + wrapDX(curveX[k - 1], x) * tt;
          py = curveY[k - 1] + (y - curveY[k - 1]) * tt;
        }
        u = shaftEnd;
      }
      world(px, py, P);
      const k0 = Math.max(0, k - 1), k1 = Math.min(m - 1, k + 1);
      world(curveX[k1], curveY[k1], T);
      world(curveX[k0], curveY[k0], Q);
      T.sub(Q).normalize();
      N.copy(P).normalize();
      R.crossVectors(N, T).normalize();
      const l = arrowVert(P, T, R, -1, u / len, halfKm, kind, minPx, ph, maxPx);
      const r = arrowVert(P, T, R, 1, u / len, halfKm, kind, minPx, ph, maxPx);
      if (prevL >= 0) quad(arrows, prevL, prevR, l, r);
      prevL = l;
      prevR = r;
      if (tailEnd) {
        if (headLen > 0) {
          // Head: base (wide) at the shaft end, tip exactly at the last point.
          const bl = arrowVert(P, T, R, -1, u / len, headHalfKm, kind, headMinPx, ph, headMaxPx);
          const br = arrowVert(P, T, R, 1, u / len, headHalfKm, kind, headMinPx, ph, headMaxPx);
          world(curveX[m - 1], curveY[m - 1], U);
          // A blunt apex (1 px each side) so the head reads right up to the point it lands on.
          const tl = arrowVert(U, T, R, -1, 1, 0.001, kind, 1, ph, 1);
          const tr = arrowVert(U, T, R, 1, 1, 0.001, kind, 1, ph, 1);
          quad(arrows, bl, br, tl, tr);
        }
        break;
      }
    }
    return len;
  }

  /** Quadratic curve from (sx, sy) to (ex, ey) bending by `bend` of its length, into curveX/Y; returns the count. */
  function curve(sx: number, sy: number, ex: number, ey: number, bend: number, steps: number): number {
    const dx = wrapDX(sx, ex), dy = ey - sy;
    const cx = sx + dx * 0.5 - dy * bend, cy = sy + dy * 0.5 + dx * bend;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, it = 1 - t;
      curveX[k] = it * it * sx + 2 * it * t * cx + t * t * (sx + dx);
      curveY[k] = it * it * sy + 2 * it * t * cy + t * t * ey;
    }
    return steps + 1;
  }

  function addOffensive(a: AttackView, f: FrontView | undefined, human: number): void {
    if (a.defender === 0 || a.naval || a.state === 'retreating') return;
    const cosL = Math.max(0.2, Math.cos(((90 - (a.y / MAP_H) * 180) * Math.PI) / 180));
    // Axis ray: origin -> axis point (km-isotropic), fallback: the front's advance direction.
    let ox = a.originX, oy = a.originY;
    let ux = wrapDX(ox, a.x) * cosL, uy = a.y - oy;
    let ul = Math.hypot(ux, uy);
    if (ox < 0 || ul < 0.5) {
      if (!f) return;
      const sgn = a.attacker === f.a ? 1 : -1;
      ux = f.dirX * cosL * sgn;
      uy = f.dirY * sgn;
      ul = Math.hypot(ux, uy) || 1;
      ox = a.x - (ux / ul / cosL) * 6;
      oy = a.y - (uy / ul) * 6;
    }
    ux /= ul;
    uy /= ul;
    // Where the axis crosses the front line: the offensive's live contact (the sim's, where its axis ray meets its
    // frontier now); without one, the line vertex nearest the ray, ahead of the origin.
    let lx = ox, ly = oy, best = Infinity;
    if (a.contactX >= 0) {
      lx = a.contactX;
      ly = a.contactY;
      // The advance runs from the origin through the contact; the arrow points at the axis point when it lies ahead.
      let ax = wrapDX(ox, lx) * cosL, ay = ly - oy;
      const al = Math.hypot(ax, ay);
      if (al > 1) {
        ax /= al;
        ay /= al;
        const tx = wrapDX(lx, a.x) * cosL, ty = a.y - ly;
        const tl = Math.hypot(tx, ty);
        if (tl > 1 && (tx * ax + ty * ay) / tl > 0.3) {
          ux = tx / tl;
          uy = ty / tl;
        } else {
          ux = ax;
          uy = ay;
        }
      }
    } else if (f) {
      const s = f.samples;
      const sgn = a.attacker === f.a ? 1 : -1;
      for (let v = 0; v < s.length >> 1; v++) {
        const px = s[v * 2] + f.dirX * 0.5 * sgn, py = s[v * 2 + 1] + f.dirY * 0.5 * sgn;
        const rx = wrapDX(ox, px) * cosL, ry = py - oy;
        const along = rx * ux + ry * uy;
        const perp = Math.abs(rx * uy - ry * ux);
        const score = perp + (along < -2 ? 50 : 0);
        if (score < best) {
          best = score;
          lx = ox + (along * ux) / cosL;
          ly = oy + along * uy;
        }
      }
    }
    // Tail 3 tiles behind the line; the tip lands ON the axis point (the place the offensive drives to) whenever it
    // lies ahead of the line. When the line has just reached or passed it (the sim moves it forward half a tile past,
    // or keeps it where the ray leaves the enemy's land), the tip points up to 2 tiles past the line along the axis,
    // but only as far as the enemy's land goes: never onto the sea or a third nation's ground.
    const corridorKm = Math.max(1, a.frontageTiles) * TILE_KM;
    const frontKm = f ? Math.max(TILE_KM, f.length * TILE_KM) : corridorKm;
    const railsKm = Math.min(corridorKm, frontKm);
    const axAlong = wrapDX(lx, a.x) * cosL * ux + (a.y - ly) * uy;
    const onAxis = axAlong >= 0.5;
    let reach = onAxis ? axAlong : 2;
    if (!onAxis) {
      const own = ctx.sim.view.owner;
      for (; reach > 0.5; reach -= 0.25) {
        const qy = Math.floor(ly + uy * reach);
        if (qy < 0 || qy >= MAP_H) continue;
        const qx = ((Math.floor(lx + (ux * reach) / cosL) % MAP_W) + MAP_W) % MAP_W;
        if (own[qy * MAP_W + qx] === a.defender) break;
      }
    }
    const back = 3;
    const sx = lx - (ux * back) / cosL, sy = ly - uy * back;
    const ex = onAxis ? lx + wrapDX(lx, a.x) : lx + (ux * reach) / cosL, ey = onAxis ? a.y : ly + uy * reach;
    rgb(colorOf(a.attacker), rgbA);
    const emph = a.attacker === human || a.defender === human ? 1 : 0;
    // The corridor: two faint dashed rails along its flanks, from a tile behind the line to the tip's depth.
    const h = railsKm / 2 / TILE_KM;
    const px = -uy, py = ux;
    for (const sgn of [-1, 1]) {
      const ox = (px * h * sgn) / cosL, oy = py * h * sgn;
      const m2 = curve(lx - ux / cosL + ox, ly - uy + oy, lx + (ux * reach) / cosL + ox, ly + uy * reach + oy, 0, 6);
      addArrow(m2, 3, 0.01, 0.75, 0.75, 0, 0, 0, 0, 0);
    }
    // The shaft: slim (at most 5 % of the corridor, 2-3.5 px half-width), a head three times as wide and tipped on
    // the axis point.
    const m = curve(sx, sy, ex, ey, 0.06, 20);
    const len0 = curveLen(m);
    const shaftHalfKm = Math.min(railsKm * 0.05, 12);
    const shaftPx: [number, number] = [1.8 + 0.4 * emph, 3];
    const headHalfKm = shaftHalfKm * 3;
    const headPx: [number, number] = [shaftPx[0] * 3, shaftPx[1] * 3];
    const headLenKm = Math.min(len0 * 0.3, Math.max(45, headHalfKm * 2.4));
    const len = addArrow(m, 0, shaftHalfKm, shaftPx[0], shaftPx[1], headHalfKm, headPx[0], headPx[1], headLenKm, 0);
    if (len > 0) {
      const toLL = (x: number, y: number): [number, number] => {
        tileXYToLatLon(((x % MAP_W) + MAP_W) % MAP_W, y, ll);
        return [+ll.lat.toFixed(4), +ll.lon.toFixed(4)];
      };
      const mi = Math.floor(m * 0.4);
      const tl = toLL(curveX[0], curveY[0]), tp = toLL(curveX[m - 1], curveY[m - 1]), ax = toLL(a.x, a.y);
      const m0 = toLL(curveX[mi], curveY[mi]), m1 = toLL(curveX[mi + 1], curveY[mi + 1]);
      st.arrows.push({
        attackId: a.id, frontKey: a.frontKey, attacker: a.attacker, corridorKm, railsKm, frontKm: Math.round(frontKm),
        shaftHalfKm: +shaftHalfKm.toFixed(2), shaftPx, headHalfKm: +headHalfKm.toFixed(2), headPx, headLenKm: Math.round(headLenKm),
        lengthKm: Math.round(len), tail: tl, tip: tp, axis: ax, mid: [m0[0], m0[1], m1[0], m1[1]],
      });
    }
    if (onAxis && len > 0) {
      // A small ring on the axis point, so the tip visibly lands on the place (a sub-pixel apex alone does not read).
      const rT = 14 / TILE_KM;
      const k = 16;
      for (let q = 0; q <= k; q++) {
        const th = (q / k) * Math.PI * 2;
        curveX[q] = a.x + (Math.cos(th) * rT) / cosL;
        curveY[q] = a.y + Math.sin(th) * rT;
      }
      addArrow(k + 1, 4, 0.01, 1, 1, 0, 0, 0, 0, 0);
    }
  }

  function addNaval(): void {
    const view = ctx.sim.view;
    for (const u of view.units.values()) {
      if (u.type !== UnitType.TransportShip || u.state === UnitState.Destroyed) continue;
      const route = view.routes.get(u.id);
      let m = 0;
      curveX[m] = u.x;
      curveY[m++] = u.y;
      if (route && route.length > 1) {
        // Continue from the waypoint nearest to the ship (the rest of the voyage), subsampled to fit.
        let bi = 0, bd = Infinity;
        for (let k = 0; k < route.length; k++) {
          const t = route[k];
          const d = Math.hypot(wrapDX(u.x, (t % MAP_W) + 0.5), ((t / MAP_W) | 0) + 0.5 - u.y);
          if (d < bd) {
            bd = d;
            bi = k;
          }
        }
        const rest = route.length - 1 - bi;
        const step = Math.max(1, Math.ceil(rest / (curveX.length - 3)));
        for (let k = bi + 1; k < route.length && m < curveX.length - 1; k += step) {
          const t = route[k];
          curveX[m] = (t % MAP_W) + 0.5;
          curveY[m++] = ((t / MAP_W) | 0) + 0.5;
        }
        const last = route[route.length - 1];
        curveX[m] = (last % MAP_W) + 0.5;
        curveY[m++] = ((last / MAP_W) | 0) + 0.5;
      } else {
        curveX[m] = u.targetX;
        curveY[m++] = u.targetY;
      }
      for (let k = 1; k < m; k++) curveX[k] = curveX[k - 1] + wrapDX(curveX[k - 1], curveX[k]);
      rgb(colorOf(u.owner), rgbA);
      if (addArrow(m, 1, 7, 3, 1e4, 7 * 1.55, 3 * 1.9, 1e4, Math.max(25, 7 * 2.1), 0) > 0) st.naval++;
    }
  }

  function addMobilization(human: number): void {
    const view = ctx.sim.view;
    for (const w of view.wars) {
      if (view.tick >= w.mobilizeUntilTick) continue;
      rgb(colorOf(w.aggressor), rgbA);
      const emph = w.aggressor === human || w.target === human ? 1 : 0;
      for (const f of view.fronts) {
        if (!((f.a === w.aggressor && f.b === w.target) || (f.b === w.aggressor && f.a === w.target))) continue;
        const s = f.samples;
        const n = s.length >> 1;
        if (n < 1) continue;
        // Unit direction from the aggressor into the target (tile space).
        const sgn = f.a === w.aggressor ? 1 : -1;
        const dx = f.dirX * sgn, dy = f.dirY * sgn;
        // One arrow every ~2.5 samples (~90 km of border), massing on the aggressor's side up to the border.
        const count = Math.max(2, Math.min(12, Math.round(n / 2.5)));
        for (let c = 0; c < count; c++) {
          const v = Math.min(n - 1, Math.floor(((c + 0.5) / count) * n));
          // The border: half a tile from side a's contact tiles along dir.
          const bx = s[v * 2] + f.dirX * 0.5, by = s[v * 2 + 1] + f.dirY * 0.5;
          const m = curve(bx - dx * 3.6, by - dy * 3.6, bx - dx * 0.6, by - dy * 0.6, 0, 3);
          if (addArrow(m, 2, 13, 5 + emph, 1e4, 13 * 1.55, (5 + emph) * 1.9, 1e4, 13 * 2.1, c * 1.3 + f.key) > 0) st.mobilization++;
        }
      }
    }
  }

  function rebuild(): void {
    const view = ctx.sim.view;
    bands.nv = bands.ni = arrows.nv = arrows.ni = 0;
    st.fronts = st.quiet = st.naval = st.mobilization = 0;
    st.arrows.length = 0;
    for (const k in st.chevrons) delete st.chevrons[k];
    const human = view.human?.id ?? 1;
    if (view.phase === 'playing' || view.phase === 'ended') {
      for (const f of view.fronts) if (f.b !== 0 && f.a !== 0) addFront(f, human);
      for (const a of view.attacks) addOffensive(a, a.frontKey ? view.frontByKey.get(a.frontKey) : undefined, human);
      addNaval();
      addMobilization(human);
    }
    flush(bands);
    flush(arrows);
    st.bandVerts = bands.nv;
    st.arrowVerts = arrows.nv;
    st.rebuilds++;
  }

  const size = new THREE.Vector2();
  return {
    group,
    update(visualDt, altKm, visible) {
      const view = ctx.sim.view;
      const fade = visible ? smoothstep(OVERLAY_MIN_ALT, OVERLAY_FULL_ALT, altKm) : 0;
      group.visible = fade > 0.002 && view.phase !== 'none';
      time += visualDt;
      rebuildAcc += visualDt;
      if (!group.visible) return;
      if (view.fronts !== lastFronts || view.attacks !== lastAttacks || view.wars !== lastWars || rebuildAcc > 0.5 || lastTick < 0) {
        lastFronts = view.fronts;
        lastAttacks = view.attacks;
        lastWars = view.wars;
        lastTick = view.tick;
        rebuildAcc = 0;
        rebuild();
      }
      ctx.renderer.getDrawingBufferSize(size);
      uniforms.uRes.value.copy(size);
      uniforms.uPx.value = ctx.renderer.getPixelRatio();
      uniforms.uTime.value = time;
      uniforms.uAlpha.value = fade;
      // Operational arrows (#22): full from 1,700 km, gone below 1,000 km (the band and the borders tell it there).
      uniforms.uArrowFill.value = smoothstep(1000, 1700, altKm);
      if (!uniforms.uOwnerOn.value) {
        const tex = ctx.globe.ownerTexture?.();
        if (tex) {
          uniforms.uOwner.value = tex;
          uniforms.uOwnerOn.value = 1;
        }
      }
    },
    clear() {
      bands.nv = bands.ni = arrows.nv = arrows.ni = 0;
      flush(bands);
      flush(arrows);
      lastFronts = null;
      lastAttacks = null;
      lastWars = null;
      lastTick = -1;
    },
    stats() {
      return st;
    },
    setArrowsVisible(v) {
      arrows.mesh.visible = v;
    },
    arrowFade() {
      return uniforms.uArrowFill.value;
    },
  };
}
