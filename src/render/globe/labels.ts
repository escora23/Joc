// FRONT ULTRA — nation labels on the globe (owner: globe; reworked by W2 for DESIGN_V2 §10.10).
// Name + compact troops at the sim's label anchor (largest interior area), 12-28 px by the nation's projected land,
// with a ★ for the human, crossed swords for nations at war with the human and a handshake for allies;
// independent territories show their name only, smaller. Placement is greedy by priority (the human, nations at war
// with the human, allies, then by land) and never lets two labels overlap: a label is dropped (fading out over
// 0.3 s) when its rectangle overlaps an already placed label, when its anchor sits near the limb
// (dot(normal, view) < 0.35) or when it would hide under a HUD panel (ctx.ui.getOccludedRects()). Hysteresis: a label
// placed last frame is ranked 30 % higher, so only a clearly more important label can take its slot.
// One instanced draw call: per-glyph instances reference a per-label row in a small float DataTexture (anchor, pixel
// size, colour, alpha) updated every frame; glyph layout is rebuilt only when texts change.

import * as THREE from 'three';
import type { GameContext } from '../../shared/api';
import { EARTH_RADIUS_KM, HUMAN_ID, TILE_KM } from '../../shared/constants';
import { tileXYToLatLon, latLonToVec3 } from '../../shared/geo';
import { formatCompact, playerName } from '../../shared/i18n';
import type { PlayerView } from '../../shared/types';
import { relationsFor, type Relation } from '../relations';
import { GLYPH_HANDSHAKE, GLYPH_STAR, GLYPH_SWORDS, type SdfFont } from './font';

const MAX_LABELS = 512;
const MAX_GLYPHS = 12_000;
const NUM_SCALE = 0.8;
/** Limb culling threshold: dot(surface normal, direction to the camera). */
const LIMB_DOT = 0.35;
/** Seconds for a dropped label to fade out (and a placed one to fade in). */
const FADE_SEC = 0.3;
/** Glyph line codes (aMeta.y): 0 name, 1 number, 2 star, 3 swords, 4 handshake. */
const LINE_STAR = 2, LINE_SWORDS = 3, LINE_HAND = 4;

const vert = /* glsl */ `
attribute vec4 aRect;
attribute vec4 aUv;
attribute vec2 aMeta; // label index, line
uniform sampler2D uLabels;
uniform vec2 uRes;
varying vec2 vUv;
varying vec4 vColor;
varying float vLine;
varying float vPx;
void main() {
  int idx = int(aMeta.x + 0.5);
  vec4 a = texelFetch(uLabels, ivec2(idx, 0), 0);
  vec4 col = texelFetch(uLabels, ivec2(idx, 1), 0);
  vec4 clip = projectionMatrix * viewMatrix * vec4(a.xyz, 1.0);
  vec2 corner = mix(aRect.xy, aRect.zw, position.xy) * a.w;
  clip.xy += corner * 2.0 / uRes * clip.w;
  clip.z = -clip.w * 0.9999;
  if (col.a < 0.003) clip = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = clip;
  vUv = mix(aUv.xy, aUv.zw, position.xy);
  vColor = col;
  vLine = aMeta.y;
  vPx = a.w;
}`;

const frag = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
varying float vLine;
varying float vPx;
void main() {
  float d = texture2D(uAtlas, vUv).r;
  float w = max(fwidth(d), 1e-3) * 0.75;
  float fill = smoothstep(0.5 - w, 0.5 + w, d);
  // A dark outline and a soft dark halo keep the text readable over bright fills, deserts, ice and clouds.
  float ow = 0.17 + 0.08 * (1.0 - clamp((vPx - 12.0) / 14.0, 0.0, 1.0));
  float edge = smoothstep(0.5 - ow - w, 0.5 - ow + w, d);
  float halo = smoothstep(0.06, 0.5, d);
  vec3 nat = vColor.rgb;
  vec3 textCol;
  if (vLine < 0.5) textCol = mix(vec3(1.0, 0.98, 0.94), nat, 0.1) * 1.1;
  else if (vLine < 1.5) textCol = mix(vec3(1.0), nat, 0.4) * 1.05;
  else if (vLine < 2.5) textCol = vec3(1.0, 0.82, 0.3) * 1.3;
  else if (vLine < 3.5) textCol = vec3(1.0, 0.32, 0.26) * 1.3;
  else textCol = vec3(0.55, 1.0, 0.68) * 1.2;
  vec3 outline = vec3(0.012, 0.014, 0.02);
  vec3 c = mix(outline, textCol, fill);
  float a = max(fill, edge * 0.94);
  float ga = halo * 0.4;
  vec3 outc = mix(outline * ga, c, a);
  float outa = max(a, ga);
  gl_FragColor = vec4(outc * vColor.a, outa * vColor.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface LabelState {
  id: number;
  text: string;
  num: string;
  /** Icon glyph before the name ('' = none) and its line code. */
  icon: string;
  iconLine: number;
  indep: boolean;
  /** Layout widths in em: name line (icon included), number line. */
  wName: number;
  wNum: number;
  alpha: number;
  target: number;
  slot: number;
  // Screen placement (this frame, CSS px relative to the canvas).
  sx: number;
  sy: number;
  px: number;
  prio: number;
  visible: boolean;
  placed: boolean;
  limbDot: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedLabel {
  id: number;
  name: string;
  /** Rectangle in client (page) CSS pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  px: number;
  /** dot(surface normal, direction to the camera) at the anchor (≥ 0.35 when placed). */
  limbDot: number;
}

export interface NationLabels {
  mesh: THREE.Mesh;
  update(dt: number, opacity: number): void;
  clear(): void;
  markTextDirty(): void;
  /** Labels placed this frame (debug hook __labels.placed()). */
  placed(): PlacedLabel[];
}

/** Rectangles (canvas CSS px) of the nation labels placed and visible now; empty when labels are hidden. */
export interface LabelRect { x0: number; y0: number; x1: number; y1: number }
let visibleRects: readonly LabelRect[] = [];
/** The icon layer keeps its world-view icons off these rectangles (DESIGN_V2 §10.7, FEEDBACK-1 #4). */
export function labelRects(): readonly LabelRect[] {
  return visibleRects;
}

export function createNationLabels(ctx: GameContext, font: SdfFont | null): NationLabels {
  const labelData = new Float32Array(MAX_LABELS * 2 * 4);
  const labelTex = new THREE.DataTexture(labelData, MAX_LABELS, 2, THREE.RGBAFormat, THREE.FloatType);
  labelTex.flipY = false;
  labelTex.magFilter = THREE.NearestFilter;
  labelTex.minFilter = THREE.NearestFilter;
  labelTex.generateMipmaps = false;
  labelTex.needsUpdate = true;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const aRect = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
  const aUv = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
  const aMeta = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 2), 2);
  for (const a of [aRect, aUv, aMeta]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aRect', aRect);
  geo.setAttribute('aUv', aUv);
  geo.setAttribute('aMeta', aMeta);
  geo.instanceCount = 0;

  const uniforms = {
    uLabels: { value: labelTex },
    uAtlas: { value: font?.texture ?? null },
    uRes: { value: new THREE.Vector2(1, 1) },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, uniforms,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  material.name = 'nation-labels';
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'nation-labels';
  mesh.renderOrder = 60;
  mesh.frustumCulled = false;

  const relations = relationsFor(ctx);
  const states = new Map<number, LabelState>();
  const order: LabelState[] = [];
  const accepted: LabelState[] = [];
  visibleRects = accepted;
  let textDirty = true;
  let textTimer = 0;
  let nextSlot = 0;
  const freeSlots: number[] = [];
  const v = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const size = new THREE.Vector2();
  const ll = { lat: 0, lon: 0 };
  let canvasLeft = 0, canvasTop = 0;

  function layoutWidth(s: string, scale: number): number {
    if (!font) return 0;
    let w = 0;
    for (const ch of s) w += font.glyph(ch).adv * scale + (ch === ' ' ? 0.08 : 0.06) * scale;
    return w;
  }

  function iconFor(p: PlayerView, rel: Relation): [string, number] {
    if (p.id === HUMAN_ID) return [GLYPH_STAR, LINE_STAR];
    if (rel === 'war') return [GLYPH_SWORDS, LINE_SWORDS];
    if (rel === 'ally') return [GLYPH_HANDSHAKE, LINE_HAND];
    return ['', 0];
  }

  function rebuildGlyphs(): void {
    if (!font) return;
    let n = 0;
    const r = aRect.array as Float32Array, u = aUv.array as Float32Array, m = aMeta.array as Float32Array;
    const emit = (s: string, scale: number, x0: number, y: number, slot: number, line: number): number => {
      let x = x0;
      for (const ch of s) {
        const g = font.glyph(ch);
        if (ch !== ' ' && n < MAX_GLYPHS) {
          r[n * 4] = x + g.x0 * scale;
          r[n * 4 + 1] = y + g.y0 * scale;
          r[n * 4 + 2] = x + g.x1 * scale;
          r[n * 4 + 3] = y + g.y1 * scale;
          u[n * 4] = g.u0;
          u[n * 4 + 1] = g.v1;
          u[n * 4 + 2] = g.u1;
          u[n * 4 + 3] = g.v0;
          m[n * 2] = slot;
          m[n * 2 + 1] = line;
          n++;
        }
        x += g.adv * scale + (ch === ' ' ? 0.08 : 0.06) * scale;
      }
      return x;
    };
    for (const s of states.values()) {
      if (s.slot < 0) continue;
      const nameScale = s.indep ? 0.82 : 1;
      let x = -s.wName / 2;
      if (s.icon) x = emit(s.icon + ' ', nameScale, x, 0.08, s.slot, s.iconLine);
      emit(s.text, nameScale, x, 0.08, s.slot, 0);
      if (s.num) emit(s.num, NUM_SCALE, -s.wNum / 2, -0.78, s.slot, 1);
    }
    geo.instanceCount = n;
    aRect.clearUpdateRanges();
    aUv.clearUpdateRanges();
    aMeta.clearUpdateRanges();
    aRect.addUpdateRange(0, n * 4);
    aUv.addUpdateRange(0, n * 4);
    aMeta.addUpdateRange(0, n * 2);
    aRect.needsUpdate = true;
    aUv.needsUpdate = true;
    aMeta.needsUpdate = true;
  }

  function syncTexts(): boolean {
    const view = ctx.sim.view;
    const world = view.world ?? ctx.world;
    let changed = false;
    for (const p of view.playerList) {
      if (!p || (p.kind === 'tribe' && p.tiles < 60)) continue;
      let s = states.get(p.id);
      const alive = p.alive && p.tiles > 0 && p.labelSize > 0;
      if (!s) {
        if (!alive) continue;
        const slot = freeSlots.length ? freeSlots.pop()! : nextSlot < MAX_LABELS ? nextSlot++ : -1;
        s = {
          id: p.id, text: '', num: '', icon: '', iconLine: 0, indep: p.kind === 'tribe', wName: 0, wNum: 0, alpha: 0, target: 0, slot,
          sx: 0, sy: 0, px: 0, prio: 0, visible: false, placed: false, limbDot: 0, x0: 0, y0: 0, x1: 0, y1: 0,
        };
        states.set(p.id, s);
        order.push(s);
        changed = true;
      }
      const indep = p.kind === 'tribe';
      const text = playerName(p, world).toLocaleUpperCase();
      // Independent territories: name only (DESIGN_V2 §10.10).
      const num = indep ? '' : formatCompact(Math.max(0, Math.round(p.troops)));
      const [icon, iconLine] = iconFor(p, relations.relationTo(p.id));
      if (text !== s.text || num !== s.num || icon !== s.icon || indep !== s.indep) {
        s.text = text;
        s.num = num;
        s.icon = icon;
        s.iconLine = iconLine;
        s.indep = indep;
        const nameScale = indep ? 0.82 : 1;
        s.wName = layoutWidth((icon ? icon + ' ' : '') + text, nameScale);
        s.wNum = num ? layoutWidth(num, NUM_SCALE) : 0;
        changed = true;
      }
    }
    return changed;
  }

  function writeLabel(s: LabelState, p: PlayerView | undefined, x: number, y: number, z: number, px: number): void {
    if (s.slot < 0) return;
    const o = s.slot * 4;
    labelData[o] = x;
    labelData[o + 1] = y;
    labelData[o + 2] = z;
    labelData[o + 3] = px;
    const c = p?.color ?? 0xffffff;
    const o2 = (MAX_LABELS + s.slot) * 4;
    labelData[o2] = Math.pow(((c >> 16) & 255) / 255, 2.2);
    labelData[o2 + 1] = Math.pow(((c >> 8) & 255) / 255, 2.2);
    labelData[o2 + 2] = Math.pow((c & 255) / 255, 2.2);
    labelData[o2 + 3] = s.alpha;
  }

  const byRank = (a: LabelState, b: LabelState): number => (b.visible ? b.prio : -1) - (a.visible ? a.prio : -1);

  const api: NationLabels = {
    mesh,
    markTextDirty() {
      textDirty = true;
    },
    clear() {
      states.clear();
      order.length = 0;
      accepted.length = 0;
      freeSlots.length = 0;
      nextSlot = 0;
      labelData.fill(0);
      labelTex.needsUpdate = true;
      geo.instanceCount = 0;
    },
    placed() {
      const view = ctx.sim.view;
      const world = view.world ?? ctx.world;
      return accepted.map((s) => {
        const p = view.players[s.id];
        return {
          id: s.id, name: p ? playerName(p, world) : '?', x0: s.x0 + canvasLeft, y0: s.y0 + canvasTop, x1: s.x1 + canvasLeft, y1: s.y1 + canvasTop,
          px: s.px, limbDot: +s.limbDot.toFixed(3),
        };
      });
    },
    update(dt, opacity) {
      const view = ctx.sim.view;
      if (view.phase === 'none' || !font) {
        mesh.visible = false;
        accepted.length = 0;
        return;
      }
      mesh.visible = true;
      textTimer -= dt;
      if (textTimer <= 0) {
        textTimer = 0.3;
        if (syncTexts() || textDirty) {
          textDirty = false;
          rebuildGlyphs();
        }
      }
      const cam = ctx.camera;
      ctx.renderer.getSize(size);
      uniforms.uRes.value.copy(size);
      const cr = ctx.canvas.getBoundingClientRect();
      canvasLeft = cr.left;
      canvasTop = cr.top;
      const H = size.y;
      const focal = H / 2 / Math.tan((cam.fov * Math.PI) / 360);
      cam.getWorldDirection(camDir);
      const camDist = cam.position.length();
      const altKm = (camDist - 1) * EARTH_RADIUS_KM;
      // Labels belong to the strategic view: fade out as the camera gets down to the battlefield.
      const zoomFade = Math.min(1, Math.max(0, (altKm - 220) / 380));

      for (const s of order) {
        const p = view.players[s.id];
        s.visible = false;
        s.target = 0;
        if (!p || !p.alive || p.tiles <= 0 || p.labelSize <= 0 || s.slot < 0) continue;
        tileXYToLatLon(p.labelX, p.labelY, ll);
        latLonToVec3(ll.lat, ll.lon, ctx.globe.surfaceRadiusAt(ll.lat, ll.lon) + 0.0006, v);
        // Limb: the anchor must face the camera (dot(normal, view) ≥ 0.35).
        const r = v.length();
        const tx = cam.position.x - v.x, ty = cam.position.y - v.y, tz = cam.position.z - v.z;
        const tl = Math.hypot(tx, ty, tz);
        s.limbDot = (v.x * tx + v.y * ty + v.z * tz) / (r * tl);
        if (s.limbDot < LIMB_DOT) continue;
        const depth = (v.x - cam.position.x) * camDir.x + (v.y - cam.position.y) * camDir.y + (v.z - cam.position.z) * camDir.z;
        if (depth <= 0) continue;
        const sizeUnits = (p.labelSize * TILE_KM) / EARTH_RADIUS_KM;
        const extentPx = (sizeUnits * focal) / depth;
        const raw = (extentPx * 1.5) / Math.max(4, s.wName * 1.9);
        const isHuman = p.id === HUMAN_ID;
        const rel = relations.relationTo(p.id);
        // In the spawn phase every AI nation is labelled (§10.13): the player chooses where to start among them.
        const important = isHuman || rel === 'war' || (view.phase === 'spawn' && p.kind === 'nation');
        // Size 12-28 px by the nation's land as seen at this zoom; the human and its enemies never go below 16 px.
        const px = Math.min(s.indep ? 20 : 28, Math.max(important ? 16 : 12, raw));
        // Nations too small at this zoom stay unlabelled (the human and its enemies always get a label).
        if (!important && raw < 7) continue;
        v.project(cam);
        if (v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
        s.sx = (v.x * 0.5 + 0.5) * size.x;
        s.sy = (0.5 - v.y * 0.5) * size.y;
        s.px = px;
        const tier = isHuman ? 4 : rel === 'war' ? 3 : rel === 'ally' ? 2 : 1;
        const land = Math.sqrt(Math.max(1, p.tiles)) * (s.placed ? 1.3 : 1);
        s.prio = tier * 1e6 + Math.min(9.9e5, land * 100);
        const halfW = Math.max(s.wName * (s.indep ? 0.82 : 1), s.wNum * NUM_SCALE) * px * 0.5 + 4;
        s.x0 = s.sx - halfW;
        s.x1 = s.sx + halfW;
        s.y0 = s.sy - px * 0.95 - 3;
        s.y1 = s.sy + (s.num ? px * 0.95 : px * 0.25) + 3;
        s.visible = true;
      }
      // Greedy placement, most important first; never over another label, a HUD panel or off screen.
      order.sort(byRank);
      accepted.length = 0;
      const hud = ctx.ui?.getOccludedRects?.() ?? [];
      for (const s of order) {
        s.placed = false;
        if (!s.visible) continue;
        if (s.x1 < 0 || s.y1 < 0 || s.x0 > size.x || s.y0 > size.y) continue;
        let hit = false;
        for (const o of accepted) {
          if (s.x0 < o.x1 && s.x1 > o.x0 && s.y0 < o.y1 && s.y1 > o.y0) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          for (const r of hud) {
            const rx0 = r.left - canvasLeft, ry0 = r.top - canvasTop;
            if (s.x0 < rx0 + r.width && s.x1 > rx0 && s.y0 < ry0 + r.height && s.y1 > ry0) {
              hit = true;
              break;
            }
          }
        }
        if (hit) continue;
        s.placed = true;
        s.target = zoomFade;
        accepted.push(s);
      }
      const step = dt / FADE_SEC;
      for (const s of order) {
        const want = s.target * opacity;
        s.alpha = s.alpha < want ? Math.min(want, s.alpha + step) : Math.max(want, s.alpha - step);
        const p = view.players[s.id];
        if (p && s.slot >= 0) {
          tileXYToLatLon(p.labelX, p.labelY, ll);
          latLonToVec3(ll.lat, ll.lon, ctx.globe.surfaceRadiusAt(ll.lat, ll.lon) + 0.0006, v);
          writeLabel(s, p, v.x, v.y, v.z, s.px || 12);
        } else if (s.slot >= 0) {
          labelData[(MAX_LABELS + s.slot) * 4 + 3] = 0;
        }
      }
      labelTex.needsUpdate = true;
    },
  };
  (window as unknown as { __labels?: unknown }).__labels = { placed: () => api.placed() };
  return api;
}
