// FRONT ULTRA — NATO-style 2D icon layer for units and structures (owner: units; built by W2 for DESIGN_V2 §10.7).
// From orbit the map shows clear symbols instead of toy-scale 3D models:
//   * frame by relation to the viewer (NATO convention): own = rectangle, ally = rectangle with a dashed outline,
//     at war = diamond, others = rounded square; fill = owner colour; glyph black or white, whichever has the higher
//     contrast (always ≥ 4.5:1);
//   * glyphs of DESIGN_V2 §6.5 drawn with canvas 2D at init into a 1024² atlas (64 px cells, mipmapped);
//   * structure level as 1-3 dots under the frame (cities show their number), unit integrity as a 2 px bar below
//     100 %, selection as a white outer ring, a count badge on clusters;
//   * same-owner icons of one category within 26 px merge into one with a count; clicking a cluster fans it out;
//   * screen-space quads in two instanced batches (structures, then units: 2 draw calls), renderOrder 45/46 with depth
//     test off, so they draw above clouds (30) and atmosphere (40); an analytic horizon test hides the far side;
//   * picking uses the icon rectangles (§7.2): own units first, then other units, then structures, nearest wins.
// The colours are pre-compensated for the post pipeline's ACES tone mapping, so an icon shows its owner's exact
// sRGB colour (the same swatch as the HUD).
// LOD hand-off with the 3D models (render/units/index.ts, models owned by W4): see iconLod() there.

import * as THREE from 'three';
import { HUMAN_ID } from '../../shared/constants';
import { StructureType, UnitType } from '../../shared/types';
import type { Relation } from '../relations';

const CELL = 64;
const ATLAS = 1024;
const COLS = ATLAS / CELL;

/** Glyph cells. */
export const G = {
  ARMOR: 0, WARSHIP: 1, FIGHTER: 2, BOMBER: 3, DRONE: 4, TRANSPORT: 5, TRADE: 6, CRUISE: 7, NUKE: 8, TRAIN: 9,
  CITY: 10, PORT: 11, FACTORY: 12, DEFENSE: 13, SAM: 14, SILO: 15, AIRBASE: 16, ARMYBASE: 17, YARD: 18, RADAR: 19,
  DIGIT0: 20, PLUS: 30, SHELL: 31, H: 32, D: 33, LT: 34,
} as const;

/** Glyph cell of a text character ('' / unknown = -1): digits, 'h', 'd', '<', '+'. */
export function textGlyph(ch: string): number {
  if (ch >= '0' && ch <= '9') return G.DIGIT0 + ch.charCodeAt(0) - 48;
  if (ch === 'h') return G.H;
  if (ch === 'd') return G.D;
  if (ch === '<') return G.LT;
  if (ch === '+') return G.PLUS;
  return -1;
}

export function unitGlyph(t: UnitType): number {
  switch (t) {
    case UnitType.ArmoredDivision: return G.ARMOR;
    case UnitType.Warship: return G.WARSHIP;
    case UnitType.FighterSquadron: return G.FIGHTER;
    case UnitType.Bomber: return G.BOMBER;
    case UnitType.DroneSwarm: return G.DRONE;
    case UnitType.TransportShip: return G.TRANSPORT;
    case UnitType.TradeShip: return G.TRADE;
    case UnitType.CruiseMissile: return G.CRUISE;
    case UnitType.AtomBomb:
    case UnitType.HydrogenBomb:
    case UnitType.Mirv:
    case UnitType.MirvWarhead: return G.NUKE;
    case UnitType.Train: return G.TRAIN;
    default: return G.SHELL;
  }
}

export function structureGlyph(t: StructureType): number {
  switch (t) {
    case StructureType.City: return G.CITY;
    case StructureType.Port: return G.PORT;
    case StructureType.Factory: return G.FACTORY;
    case StructureType.DefensePost: return G.DEFENSE;
    case StructureType.SamSite: return G.SAM;
    case StructureType.MissileSilo: return G.SILO;
    case StructureType.Airbase: return G.AIRBASE;
    case StructureType.ArmyBase: return G.ARMYBASE;
    case StructureType.NavalYard: return G.YARD;
    default: return G.RADAR;
  }
}

/** Cluster category of a unit type (same owner + same category within 26 px merge). */
export function unitCategory(t: UnitType): number {
  switch (t) {
    case UnitType.ArmoredDivision: return 1;
    case UnitType.Warship:
    case UnitType.TransportShip: return 2;
    case UnitType.TradeShip: return 3;
    case UnitType.FighterSquadron:
    case UnitType.Bomber:
    case UnitType.DroneSwarm: return 4;
    case UnitType.CruiseMissile:
    case UnitType.AtomBomb:
    case UnitType.HydrogenBomb:
    case UnitType.Mirv:
    case UnitType.MirvWarhead: return 5;
    case UnitType.Train: return 6;
    default: return 7;
  }
}

// -------------------------------------------------------------------------------------------------
// Atlas (canvas 2D, white glyphs on transparent)
// -------------------------------------------------------------------------------------------------

function drawAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ATLAS;
  c.height = ATLAS;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, ATLAS, ATLAS);
  const cell = (i: number, fn: (g: CanvasRenderingContext2D) => void) => {
    g.save();
    g.translate((i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 6;
    fn(g);
    g.restore();
  };
  const poly = (g: CanvasRenderingContext2D, pts: number[], fill = true) => {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
    if (fill) g.fill();
    else g.stroke();
  };
  const hull = (g: CanvasRenderingContext2D, y: number) => poly(g, [6, y, 58, y, 50, y + 12, 12, y + 12]);

  // --- units
  cell(G.ARMOR, (g) => {
    // NATO armour: an oval (stadium) inside the frame.
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(22, 20);
    g.lineTo(42, 20);
    g.arc(42, 32, 12, -Math.PI / 2, Math.PI / 2);
    g.lineTo(22, 44);
    g.arc(22, 32, 12, Math.PI / 2, (3 * Math.PI) / 2);
    g.closePath();
    g.stroke();
  });
  cell(G.WARSHIP, (g) => {
    hull(g, 38);
    g.fillRect(24, 28, 16, 10);
    g.fillRect(29, 18, 4, 12);
    g.fillRect(14, 33, 8, 5);
    g.fillRect(43, 33, 7, 5);
  });
  cell(G.FIGHTER, (g) => {
    // Swept-wing jet, nose up.
    poly(g, [32, 6, 36, 20, 36, 28, 56, 44, 56, 49, 36, 42, 35, 52, 42, 58, 22, 58, 29, 52, 28, 42, 8, 49, 8, 44, 28, 28, 28, 20]);
  });
  cell(G.BOMBER, (g) => {
    // Broad straight wings.
    poly(g, [32, 8, 36, 16, 36, 26, 60, 32, 60, 38, 36, 36, 35, 50, 44, 56, 20, 56, 29, 50, 28, 36, 4, 38, 4, 32, 28, 26, 28, 16]);
  });
  cell(G.DRONE, (g) => {
    // Small chevrons in a V.
    g.lineWidth = 5;
    const chev = (x: number, y: number) => {
      g.beginPath();
      g.moveTo(x - 8, y + 6);
      g.lineTo(x, y);
      g.lineTo(x + 8, y + 6);
      g.stroke();
    };
    chev(32, 16);
    chev(19, 30);
    chev(45, 30);
    chev(32, 42);
  });
  cell(G.TRANSPORT, (g) => {
    hull(g, 40);
    g.fillRect(18, 12, 28, 7);
    g.fillRect(28, 12, 8, 26);
  });
  cell(G.TRADE, (g) => {
    hull(g, 40);
    g.beginPath();
    g.arc(32, 22, 12, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.font = 'bold 18px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('$', 32, 23);
    g.globalCompositeOperation = 'source-over';
  });
  cell(G.CRUISE, (g) => {
    // Arrow.
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(10, 32);
    g.lineTo(48, 32);
    g.stroke();
    poly(g, [58, 32, 42, 20, 42, 44]);
  });
  cell(G.NUKE, (g) => {
    // Trefoil.
    g.beginPath();
    g.arc(32, 32, 6, 0, Math.PI * 2);
    g.fill();
    for (let k = 0; k < 3; k++) {
      const a0 = -Math.PI / 2 + (k * 2 * Math.PI) / 3 - Math.PI / 6;
      g.beginPath();
      g.moveTo(32 + Math.cos(a0) * 10, 32 + Math.sin(a0) * 10);
      g.arc(32, 32, 26, a0, a0 + Math.PI / 3);
      g.arc(32, 32, 10, a0 + Math.PI / 3, a0, true);
      g.closePath();
      g.fill();
    }
  });
  cell(G.TRAIN, (g) => {
    g.fillRect(10, 20, 44, 20);
    g.fillRect(40, 12, 10, 10);
    for (const x of [18, 32, 46]) {
      g.beginPath();
      g.arc(x, 44, 5, 0, Math.PI * 2);
      g.fill();
    }
  });
  cell(G.SHELL, (g) => {
    g.beginPath();
    g.arc(32, 32, 10, 0, Math.PI * 2);
    g.fill();
  });

  // --- structures
  cell(G.CITY, (g) => {
    g.fillRect(8, 30, 14, 26);
    g.fillRect(25, 12, 14, 44);
    g.fillRect(42, 24, 14, 32);
  });
  const anchor = (g: CanvasRenderingContext2D) => {
    g.lineWidth = 6;
    g.beginPath();
    g.arc(32, 13, 5, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(32, 18);
    g.lineTo(32, 54);
    g.moveTo(20, 26);
    g.lineTo(44, 26);
    g.stroke();
    g.beginPath();
    g.arc(32, 36, 18, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
  };
  cell(G.PORT, anchor);
  cell(G.FACTORY, (g) => {
    // Gear with a chimney.
    g.fillRect(40, 6, 9, 20);
    g.beginPath();
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const r = k % 2 === 0 ? 20 : 15;
      g.lineTo(28 + Math.cos(a) * r, 38 + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(28, 38, 7, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  });
  cell(G.DEFENSE, (g) => {
    // Bastion chevron: a pentagonal bastion outline with a chevron.
    g.lineWidth = 6;
    poly(g, [32, 8, 56, 26, 48, 56, 16, 56, 8, 26], false);
    g.beginPath();
    g.moveTo(20, 44);
    g.lineTo(32, 30);
    g.lineTo(44, 44);
    g.stroke();
  });
  cell(G.SAM, (g) => {
    // Upward arrow under an arc.
    g.lineWidth = 6;
    g.beginPath();
    g.arc(32, 44, 24, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
    g.beginPath();
    g.moveTo(32, 58);
    g.lineTo(32, 30);
    g.stroke();
    poly(g, [32, 16, 42, 32, 22, 32]);
  });
  cell(G.SILO, (g) => {
    // Vertical missile in a circle.
    g.lineWidth = 5;
    g.beginPath();
    g.arc(32, 32, 25, 0, Math.PI * 2);
    g.stroke();
    poly(g, [32, 12, 38, 22, 38, 44, 42, 50, 22, 50, 26, 44, 26, 22]);
  });
  cell(G.AIRBASE, (g) => {
    // Plane over a runway.
    g.fillRect(6, 50, 52, 6);
    poly(g, [32, 6, 35, 16, 35, 22, 52, 32, 52, 36, 35, 32, 34, 40, 40, 44, 24, 44, 30, 40, 29, 32, 12, 36, 12, 32, 29, 22, 29, 16]);
  });
  cell(G.ARMYBASE, (g) => {
    // Crossed swords over a flag.
    g.fillRect(12, 8, 3, 22);
    poly(g, [15, 8, 34, 12, 15, 18]);
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(16, 56);
    g.lineTo(50, 24);
    g.moveTo(48, 56);
    g.lineTo(18, 28);
    g.stroke();
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(14, 44);
    g.lineTo(26, 54);
    g.moveTo(50, 44);
    g.lineTo(38, 54);
    g.stroke();
  });
  cell(G.YARD, (g) => {
    // Anchor with a wrench.
    g.save();
    g.translate(-8, 0);
    g.scale(0.85, 0.85);
    anchor(g);
    g.restore();
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(40, 54);
    g.lineTo(54, 26);
    g.stroke();
    g.beginPath();
    g.arc(55, 21, 7, Math.PI * 0.2, Math.PI * 1.6);
    g.stroke();
  });
  cell(G.RADAR, (g) => {
    // Dish on a stand.
    g.lineWidth = 6;
    g.beginPath();
    g.arc(28, 26, 20, Math.PI * 0.05, Math.PI * 0.95, false);
    g.stroke();
    g.beginPath();
    g.moveTo(28, 26);
    g.lineTo(44, 12);
    g.stroke();
    g.beginPath();
    g.arc(46, 10, 4, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(28, 44);
    g.lineTo(28, 54);
    g.moveTo(16, 56);
    g.lineTo(40, 56);
    g.stroke();
  });
  // Digits, '+', and the letters of ETA labels (count badges, city levels, "12h").
  const chars: [number, string][] = [[G.PLUS, '+'], [G.H, 'h'], [G.D, 'd'], [G.LT, '<']];
  for (let d = 0; d < 10; d++) chars.push([G.DIGIT0 + d, String(d)]);
  for (const [idx, ch] of chars) {
    cell(idx, (g) => {
      g.font = 'bold 50px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(ch, 32, 35);
    });
  }
  return c;
}

// -------------------------------------------------------------------------------------------------
// Batch
// -------------------------------------------------------------------------------------------------

/**
 * Inverse of the post pipeline's ACES fit (render/post/shaders.ts): UI-like overlays (icons, route lines, island
 * markers) land on screen in their exact sRGB colour. Defines srgbToLin() and untone().
 */
export function inverseToneGlsl(): string {
  const inM = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777).invert();
  const outM = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602).invert();
  const m3 = (m: THREE.Matrix3) => `mat3(${m.elements.map((v) => v.toFixed(6)).join(', ')})`;
  return /* glsl */ `
const mat3 INV_IN = ${m3(inM)};
const mat3 INV_OUT = ${m3(outM)};
float invRrt(float y) {
  y = clamp(y, 0.0, 0.995);
  float a = 0.983729 * y - 1.0, b = 0.432951 * y - 0.0245786, c = 0.238081 * y + 0.000090537;
  return (-b - sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
}
vec3 srgbToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// Linear HDR value that the post pipeline turns back into the sRGB colour c.
vec3 untone(vec3 c) {
  // Capped a little below white so icons never cross the bloom threshold (no glow halos around UI symbols).
  vec3 u = INV_OUT * srgbToLin(min(c, vec3(0.9)));
  vec3 v = vec3(invRrt(u.r), invRrt(u.g), invRrt(u.b));
  return max(INV_IN * v * 0.6, 0.0);
}`;
}

const VERT = /* glsl */ `
attribute vec4 iRect;   // center x, y (px, top-left origin), quad half extent (px), frame half size S (px)
attribute vec4 iColor;  // owner sRGB, alpha
attribute vec4 iA;      // kind (0 icon, 1 pip), shape (0 own, 1 ally, 2 war, 3 other), glyph cell, flags
attribute vec4 iB;      // integrity (-1 none), dots (0-3), count (cluster, 0/1 none), city level (0 none)
uniform vec2 uRes;
varying vec2 vP;
varying vec4 vColor;
varying vec4 vA;
varying vec4 vB;
varying float vS;
void main() {
  vec2 local = position.xy * iRect.z;
  vec2 px = iRect.xy + local;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vP = local;
  vColor = iColor;
  vA = iA;
  vB = iB;
  vS = iRect.w;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vP;
varying vec4 vColor;
varying vec4 vA;
varying vec4 vB;
varying float vS;
${inverseToneGlsl()}

float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdRound(vec2 p, vec2 b, float r) { return sdBox(p, b - r) - r; }
float cellSample(float cellIdx, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float cx = mod(cellIdx, ${COLS}.0), cy = floor(cellIdx / ${COLS}.0);
  vec2 a = (vec2(cx, cy) + uv) / ${COLS}.0;
  return texture2D(uAtlas, a).a;
}
float relLum(vec3 c) { vec3 l = srgbToLin(c); return dot(l, vec3(0.2126, 0.7152, 0.0722)); }
// Up to three digits (value v, or '99+' when v > 99) centred at c, each drawn in an h x h px square advancing 0.52 h.
float digits(vec2 p, vec2 c, float v, float h) {
  float n = v > 99.0 ? 3.0 : v >= 10.0 ? 2.0 : 1.0;
  float adv = h * 0.52;
  float m = 0.0;
  for (int k = 0; k < 3; k++) {
    if (float(k) >= n) break;
    float d;
    if (v > 99.0) d = k < 2 ? 9.0 : 10.0;
    else if (n > 1.5) d = k == 0 ? floor(v / 10.0) : mod(v, 10.0);
    else d = v;
    vec2 ck = c + vec2((float(k) - (n - 1.0) * 0.5) * adv, 0.0);
    vec2 uv = (p - ck) / h + 0.5;
    m = max(m, cellSample(${G.DIGIT0}.0 + d, uv));
  }
  return m;
}
// Paint 'src' (straight colour, coverage a) over the accumulated premultiplied result.
void over(inout vec4 acc, vec3 col, float a) { acc = vec4(col * a, a) + acc * (1.0 - a); }

void main() {
  vec2 p = vP;
  float S = vS;
  int flags = int(vA.w + 0.5);
  vec3 owner = vColor.rgb;
  vec4 acc = vec4(0.0);
  if (vA.x > 2.5) {
    // Short text (ETA): up to four glyph cells in vB, on a dark pill.
    float n = vA.y;
    float h = S * 2.0, adv = h * 0.52;
    float pill = 1.0 - smoothstep(-0.5, 0.5, sdRound(p, vec2(n * adv * 0.5 + 3.0, h * 0.5 + 1.5), h * 0.5));
    over(acc, vec3(0.02, 0.03, 0.05), pill * 0.8);
    float m = 0.0;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= n) break;
      float cellIdx = k == 0 ? vB.x : k == 1 ? vB.y : k == 2 ? vB.z : vB.w;
      vec2 uv = (p - vec2((float(k) - (n - 1.0) * 0.5) * adv, 0.0)) / h + 0.5;
      m = max(m, cellSample(cellIdx, uv));
    }
    over(acc, owner, m);
  } else if (vA.x > 1.5) {
    // Sunk ship: a small red cross with a dark outline.
    vec2 q = abs(p);
    float d = min(abs(q.x - q.y), 99.0) * 0.7071 - 1.3;
    d = max(d, max(q.x, q.y) - S);
    over(acc, vec3(0.02), 1.0 - smoothstep(0.0, 1.8, d - 0.2));
    over(acc, vec3(0.95, 0.12, 0.08), 1.0 - smoothstep(-0.5, 0.5, d));
  } else if (vA.x > 0.5) {
    // Owner pip: a disc with a dark rim.
    float d = length(p) - S;
    float a = 1.0 - smoothstep(-0.5, 0.5, d);
    float rim = smoothstep(-1.6, -0.6, d);
    over(acc, mix(owner, vec3(0.02), rim * 0.9), a);
  } else {
    int shape = int(vA.y + 0.5);
    float d;
    if (shape == 2) {
      // At war: diamond.
      vec2 q = abs(p);
      d = (q.x + q.y - S * 1.12) * 0.7071;
    } else if (shape == 3) {
      d = sdRound(p, vec2(S * 0.92), S * 0.3);
    } else {
      d = sdBox(p, vec2(S * 1.22, S * 0.84));
    }
    // Selection: a white outer ring.
    if ((flags & 1) != 0) {
      float rr = abs(length(p) - S * 1.62);
      over(acc, vec3(1.0), (1.0 - smoothstep(0.9, 1.8, rr)) * 0.95);
    }
    // Ally: dashed white outline outside the frame.
    if (shape == 1) {
      float band = 1.0 - smoothstep(0.6, 1.4, abs(d - 2.2));
      float ang = atan(p.y, p.x);
      float dash = step(0.5, fract(ang * 3.0 / 3.14159));
      over(acc, vec3(1.0), band * dash);
    }
    float fill = 1.0 - smoothstep(-0.5, 0.5, d);
    float rim = smoothstep(-1.9, -0.9, d);
    vec3 frameCol = mix(owner, vec3(0.03), rim * 0.92);
    if ((flags & 2) != 0) frameCol = mix(frameCol, vec3(1.0), 0.18 * (1.0 - rim));
    over(acc, frameCol, fill);
    // Glyph: black or white, whichever contrasts more with the fill (≥ 4.5:1 either way).
    float Y = relLum(owner);
    vec3 glyphCol = (Y + 0.05) / 0.05 >= 1.05 / (Y + 0.05) ? vec3(0.0) : vec3(1.0);
    float gs = S * 0.95;
    vec2 guv = p / (2.0 * gs) + 0.5;
    float gm = cellSample(vA.z, guv) * fill * (1.0 - rim);
    over(acc, glyphCol, gm);
    float yb = (shape == 2 ? S * 1.12 : S * 0.84) + 1.0;
    // Integrity bar (2 px) when below 100 %.
    if (vB.x >= 0.0 && vB.x < 0.995) {
      vec2 bp = p - vec2(0.0, yb + 3.0);
      float w = S * 1.1;
      if (abs(bp.y) < 1.5 && abs(bp.x) < w + 1.0) {
        float t = (bp.x + w) / (2.0 * w);
        vec3 hc = mix(vec3(0.95, 0.2, 0.15), vec3(0.35, 0.9, 0.3), smoothstep(0.25, 0.75, vB.x));
        over(acc, t <= vB.x ? hc : vec3(0.08), 1.0);
      }
    }
    // Level: 1-3 dots under structures, the number under cities (a small dark pill).
    if (vB.w > 0.5) {
      vec2 c = vec2(0.0, yb + 6.5);
      float w = vB.w >= 10.0 ? 5.5 : 3.5;
      float pill = 1.0 - smoothstep(-0.5, 0.5, sdRound(p - c, vec2(w + 1.5, 5.0), 4.0));
      over(acc, vec3(0.03), pill * 0.85);
      over(acc, vec3(1.0), digits(p, c, vB.w, 10.0));
    } else if (vB.y > 0.5) {
      vec2 bp = p - vec2(0.0, yb + 4.0);
      float m = 0.0;
      for (int i = 0; i < 3; i++) {
        if (float(i) >= vB.y) break;
        float x = (float(i) - (vB.y - 1.0) * 0.5) * 5.0;
        float dd = length(bp - vec2(x, 0.0));
        m = max(m, 1.0 - smoothstep(1.4, 2.2, dd));
        over(acc, vec3(0.03), 1.0 - smoothstep(2.2, 3.0, dd));
      }
      over(acc, vec3(1.0), m);
    }
    // Cluster count badge (top right).
    if (vB.z > 1.5) {
      vec2 c = vec2(S * 1.15, -S * 0.85);
      vec2 bp = p - c;
      float r = vB.z > 9.5 ? 8.5 : 7.0;
      float dd = length(bp) - r;
      over(acc, vec3(0.04), 1.0 - smoothstep(-0.5, 0.5, dd));
      over(acc, owner, (1.0 - smoothstep(-0.5, 0.5, abs(dd + 0.6) - 0.6)));
      over(acc, vec3(1.0), digits(p, c, vB.z, 10.0));
    }
  }
  acc *= vColor.a;
  if (acc.a < 0.003) discard;
  // Un-premultiply, undo the tone curve, premultiply again.
  vec3 col = untone(acc.rgb / max(acc.a, 1e-4));
  gl_FragColor = vec4(col * acc.a, acc.a);
}`;

class IconBatch {
  readonly mesh: THREE.Mesh;
  readonly geo = new THREE.InstancedBufferGeometry();
  readonly rect: THREE.InstancedBufferAttribute;
  readonly color: THREE.InstancedBufferAttribute;
  readonly a: THREE.InstancedBufferAttribute;
  readonly b: THREE.InstancedBufferAttribute;
  n = 0;

  constructor(readonly cap: number, material: THREE.ShaderMaterial, name: string, order: number) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.rect = mk();
    this.color = mk();
    this.a = mk();
    this.b = mk();
    this.geo.setAttribute('iRect', this.rect);
    this.geo.setAttribute('iColor', this.color);
    this.geo.setAttribute('iA', this.a);
    this.geo.setAttribute('iB', this.b);
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
  }

  push(x: number, y: number, half: number, S: number, rgb: number, alpha: number, kind: number, shape: number, glyph: number, flags: number,
    hp: number, dots: number, count: number, level: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const r = this.rect.array as Float32Array, c = this.color.array as Float32Array, a = this.a.array as Float32Array, b = this.b.array as Float32Array;
    r[i * 4] = x; r[i * 4 + 1] = y; r[i * 4 + 2] = half; r[i * 4 + 3] = S;
    c[i * 4] = ((rgb >> 16) & 255) / 255; c[i * 4 + 1] = ((rgb >> 8) & 255) / 255; c[i * 4 + 2] = (rgb & 255) / 255; c[i * 4 + 3] = alpha;
    a[i * 4] = kind; a[i * 4 + 1] = shape; a[i * 4 + 2] = glyph; a[i * 4 + 3] = flags;
    b[i * 4] = hp; b[i * 4 + 1] = dots; b[i * 4 + 2] = count; b[i * 4 + 3] = level;
  }

  commit(): void {
    this.geo.instanceCount = this.n;
    for (const at of [this.rect, this.color, this.a, this.b]) {
      at.clearUpdateRanges();
      if (this.n > 0) at.addUpdateRange(0, this.n * 4);
      at.needsUpdate = true;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------------------

/** One unit or structure offered to the layer this frame. */
interface Src {
  structure: boolean;
  id: number;
  type: number;
  owner: number;
  rel: Relation;
  x: number;
  y: number;
  hp: number;
  level: number;
  selected: boolean;
  /** Unit icon size class: 0 full, 1 small (float above the model), 2 pip, 3 civilian (trade, trains). */
  size: number;
  cat: number;
  prio: number;
  head: number;
  count: number;
}

export interface IconHit {
  kind: 'unit' | 'structure' | 'cluster';
  id: number;
  owner: number;
  /** Members of the cluster (unit or structure ids), when kind = 'cluster'. */
  members: number[];
  structure: boolean;
}

export interface IconStats {
  unitIcons: number;
  structureIcons: number;
  pips: number;
  clusters: number;
  clusteredMembers: number;
  unitsInView: number;
  structuresInView: number;
  unitsRepresented: number;
  structuresRepresented: number;
  drawCalls: number;
  fanned: number;
}

const CLUSTER_PX = 26;
const PICK_PX = 14;

export class IconLayer {
  readonly group = new THREE.Group();
  private readonly structs: IconBatch;
  private readonly units: IconBatch;
  private readonly srcs: Src[] = [];
  private n = 0;
  private readonly heads: Src[] = [];
  private readonly grid = new Map<number, Src[]>();
  private prevHeads = new Set<number>();
  private readonly uRes: { value: THREE.Vector2 };
  private fan: { structure: boolean; head: number; owner: number; cat: number; until: number; members: number[] } | null = null;
  /** Hit rectangles of what was drawn this frame: x, y, half, kind (0 unit, 1 structure, 2 cluster), index into drawn. */
  private readonly hits: { x: number; y: number; half: number; kind: 0 | 1 | 2; id: number; owner: number; members: number[]; structure: boolean }[] = [];
  private hitN = 0;
  stats: IconStats = { unitIcons: 0, structureIcons: 0, pips: 0, clusters: 0, clusteredMembers: 0, unitsInView: 0, structuresInView: 0, unitsRepresented: 0, structuresRepresented: 0, drawCalls: 0, fanned: 0 };
  hoverKey = -1;

  constructor() {
    const tex = new THREE.CanvasTexture(drawAtlas());
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.flipY = false;
    this.uRes = { value: new THREE.Vector2(1, 1) };
    const mat = new THREE.ShaderMaterial({
      name: 'unit-icons', vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uAtlas: { value: tex }, uRes: this.uRes },
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    // Structures first, units on top: both above clouds (30) and the atmosphere (40).
    this.structs = new IconBatch(8192, mat, 'icons-structures', 45);
    this.units = new IconBatch(8192, mat, 'icons-units', 46);
    this.group.add(this.structs.mesh, this.units.mesh);
  }

  warmup(on: boolean): void {
    for (const b of [this.structs, this.units]) {
      if (on) {
        b.n = 0;
        b.push(-100, -100, 20, 10, 0xffffff, 1, 0, 0, 0, 0, -1, 0, 0, 0);
        b.commit();
      } else {
        b.n = 0;
        b.commit();
      }
    }
  }

  begin(width: number, height: number): void {
    this.uRes.value.set(width, height);
    this.n = 0;
    this.extras.length = 0;
  }

  /**
   * Offer an icon at screen position (x, y) in CSS px (already horizon-tested and on screen). `size`: unit size class,
   * ignored for structures.
   */
  add(structure: boolean, id: number, type: number, owner: number, rel: Relation, x: number, y: number, hp: number, level: number,
    selected: boolean, size: number, cat: number): void {
    let s = this.srcs[this.n];
    if (!s) {
      s = { structure, id, type, owner, rel, x, y, hp, level, selected, size, cat, prio: 0, head: -1, count: 0 };
      this.srcs.push(s);
    }
    this.n++;
    s.structure = structure;
    s.id = id;
    s.type = type;
    s.owner = owner;
    s.rel = rel;
    s.x = x;
    s.y = y;
    s.hp = hp;
    s.level = level;
    s.selected = selected;
    s.size = size;
    s.cat = cat;
    s.count = 0;
    s.head = -1;
    const relP = owner === HUMAN_ID ? 4 : rel === 'war' ? 3 : rel === 'ally' ? 2 : 1;
    s.prio = (selected ? 100 : 0) + relP * 10 + (this.prevHeads.has(structure ? -id - 1 : id) ? 5 : 0) + (structure ? 0 : 1);
  }

  /** Open a fanned cluster (members spread around its head) until `until` (real s) or the next click elsewhere. */
  openFan(hit: IconHit, until: number): void {
    if (hit.kind !== 'cluster') return;
    this.fan = { structure: hit.structure, head: hit.id, owner: hit.owner, cat: -1, until, members: hit.members.slice() };
  }

  closeFan(): void {
    this.fan = null;
  }

  get fanOpen(): boolean {
    return this.fan !== null;
  }

  end(now: number, sizes: { unitPx: number; smallPx: number; structPx: number; pipPx: number; unitsOn: boolean; structsOn: boolean }): void {
    if (this.fan && now > this.fan.until) this.fan = null;
    const srcs = this.srcs, n = this.n;
    // Cluster: stable order (priority, previous heads first), 26 px grid hash on heads.
    const order: Src[] = srcs.slice(0, n).sort((a, b) => b.prio - a.prio || a.id - b.id);
    this.heads.length = 0;
    this.grid.clear();
    const cellKey = (x: number, y: number) => (Math.floor(x / CLUSTER_PX) + 4096) * 8192 + (Math.floor(y / CLUSTER_PX) + 4096);
    const fanMembers = this.fan ? new Set(this.fan.members.map((m) => (this.fan!.structure ? -m - 1 : m))) : null;
    const headIndex = new Map<Src, number>();
    order.forEach((s, i) => headIndex.set(s, i));
    for (const s of order) {
      const key = s.structure ? -s.id - 1 : s.id;
      // Pips, selected icons and fanned members never merge.
      const mergeable = !s.selected && !(fanMembers?.has(key)) && !(s.structure ? false : s.size === 2);
      if (mergeable) {
        const cx = Math.floor(s.x / CLUSTER_PX), cy = Math.floor(s.y / CLUSTER_PX);
        let joined: Src | null = null;
        for (let dy = -1; dy <= 1 && !joined; dy++) {
          for (let dx = -1; dx <= 1 && !joined; dx++) {
            const l = this.grid.get((cx + dx + 4096) * 8192 + (cy + dy + 4096));
            if (!l) continue;
            for (const h of l) {
              if (h.structure !== s.structure || h.owner !== s.owner || h.cat !== s.cat || h.selected) continue;
              if ((h.x - s.x) ** 2 + (h.y - s.y) ** 2 <= CLUSTER_PX * CLUSTER_PX) {
                joined = h;
                break;
              }
            }
          }
        }
        if (joined) {
          joined.count++;
          s.head = joined.head;
          continue;
        }
      }
      s.count = 1;
      // A head refers to itself through its own index in `order`.
      s.head = headIndex.get(s) ?? -1;
      this.heads.push(s);
      if (mergeable) {
        const k = cellKey(s.x, s.y);
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(s);
      }
    }
    // Members per head (for picking / fans).
    const membersOf = new Map<Src, number[]>();
    for (const s of order) {
      const h = s.head >= 0 ? order[s.head] : s;
      let l = membersOf.get(h);
      if (!l) membersOf.set(h, (l = []));
      l.push(s.id);
    }
    this.prevHeads.clear();
    for (const h of this.heads) this.prevHeads.add(h.structure ? -h.id - 1 : h.id);

    // Draw.
    this.structs.n = 0;
    this.units.n = 0;
    this.hitN = 0;
    const st = this.stats;
    st.unitIcons = st.structureIcons = st.pips = st.clusters = st.clusteredMembers = 0;
    st.unitsInView = st.structuresInView = st.unitsRepresented = st.structuresRepresented = 0;
    st.fanned = 0;
    for (const s of order) {
      if (s.structure) st.structuresInView++;
      else st.unitsInView++;
    }
    // Heads in reverse priority so the most important draw on top.
    for (let i = this.heads.length - 1; i >= 0; i--) {
      const h = this.heads[i];
      const members = membersOf.get(h) ?? [h.id];
      this.drawOne(h, h.x, h.y, h.count, members, sizes);
      if (h.count > 1) {
        st.clusters++;
        st.clusteredMembers += h.count;
      }
      if (h.structure) st.structuresRepresented += h.count;
      else st.unitsRepresented += h.count;
    }
    // Fanned cluster: members on a ring around the head (kept even if the camera moved a little).
    if (this.fan) {
      const f = this.fan;
      const head = order.find((s) => s.structure === f.structure && s.id === f.head);
      if (!head) this.fan = null;
      else {
        const ms = order.filter((s) => s.structure === f.structure && f.members.includes(s.id));
        const R = Math.max(30, ms.length * 7);
        ms.forEach((m, k) => {
          const a = -Math.PI / 2 + (k / ms.length) * Math.PI * 2;
          this.drawOne(m, head.x + Math.cos(a) * R, head.y + Math.sin(a) * R, 1, [m.id], sizes);
        });
        st.fanned = ms.length;
      }
    }
    this.drawExtras();
    this.structs.commit();
    this.units.commit();
    st.structureIcons = this.structs.n;
    st.unitIcons = this.units.n;
    st.drawCalls = (this.structs.n > 0 ? 1 : 0) + (this.units.n > 0 ? 1 : 0);
  }

  private drawOne(s: Src, x: number, y: number, count: number, members: number[], sizes: { unitPx: number; smallPx: number; structPx: number; pipPx: number }): void {
    const shape = s.owner === HUMAN_ID ? 0 : s.rel === 'ally' ? 1 : s.rel === 'war' ? 2 : 3;
    const flags = (s.selected ? 1 : 0) | (this.hoverKey === (s.structure ? -s.id - 1 : s.id) ? 2 : 0);
    if (s.structure) {
      const S = sizes.structPx / 2;
      const isCity = s.type === StructureType.City;
      const dots = isCity ? 0 : Math.max(1, Math.min(3, s.level));
      this.structs.push(x, y, S * 2.2 + 8, S, this.ownerColor(s.owner), 1, 0, shape, structureGlyph(s.type as StructureType), flags,
        s.hp < 0.995 ? s.hp : -1, dots, count, isCity ? Math.max(1, s.level) : 0);
      this.hit(x, y, S * 1.25, count > 1 ? 2 : 1, s, members);
      return;
    }
    if (s.size === 2) {
      // Pip (below 600 km, and projectiles): a small owner disc.
      const r = s.type === UnitType.Shell || s.type === UnitType.SamInterceptor ? 2 : sizes.pipPx / 2;
      this.units.push(x, y, r + 2, r, this.ownerColor(s.owner), 1, 1, 0, 0, flags, -1, 0, 0, 0);
      this.stats.pips++;
      this.hit(x, y, Math.max(r, 6), 0, s, members);
      return;
    }
    const px = s.size === 1 ? sizes.smallPx : s.size === 3 ? Math.min(sizes.unitPx, 16) : sizes.unitPx;
    const S = px / 2;
    this.units.push(x, y, S * 2.2 + 6, S, this.ownerColor(s.owner), 1, 0, shape, unitGlyph(s.type as UnitType), flags,
      s.hp < 0.995 ? s.hp : -1, 0, count, 0);
    this.hit(x, y, S * 1.25, count > 1 ? 2 : 0, s, members);
  }

  /** Owner colour lookup, set by the renderer each frame. */
  ownerColor: (owner: number) => number = () => 0xcccccc;

  private readonly extras: number[] = [];

  /** A red cross where a ship sank (drawn in the unit batch, not pickable). Call between begin() and end(). */
  addCross(x: number, y: number, alpha: number): void {
    this.extras.push(0, x, y, alpha, 0, -1, -1, -1, -1);
  }

  /** A short text (digits, 'h', 'd', '<'; up to 4 characters) on a dark pill, coloured `rgb`. */
  addText(x: number, y: number, text: string, rgb: number): void {
    const cells = [-1, -1, -1, -1];
    let n = 0;
    for (const ch of text) {
      const c = textGlyph(ch);
      if (c < 0 || n >= 4) continue;
      cells[n++] = c;
    }
    if (n) this.extras.push(n, x, y, 1, rgb, cells[0], cells[1], cells[2], cells[3]);
  }

  private drawExtras(): void {
    const e = this.extras;
    for (let i = 0; i < e.length; i += 9) {
      const n = e[i];
      if (n === 0) this.units.push(e[i + 1], e[i + 2], 9, 5, 0xffffff, e[i + 3], 2, 0, 0, 0, -1, 0, 0, 0);
      else this.units.push(e[i + 1], e[i + 2], n * 6 + 10, 5, e[i + 4], 1, 3, n, 0, 0, e[i + 5], e[i + 6], e[i + 7], e[i + 8]);
    }
    e.length = 0;
  }

  private hit(x: number, y: number, half: number, kind: 0 | 1 | 2, s: Src, members: number[]): void {
    let h = this.hits[this.hitN];
    if (!h) this.hits.push((h = { x, y, half, kind, id: s.id, owner: s.owner, members, structure: s.structure }));
    this.hitN++;
    h.x = x;
    h.y = y;
    h.half = half;
    h.kind = kind;
    h.id = s.id;
    h.owner = s.owner;
    h.members = members;
    h.structure = s.structure;
  }

  /**
   * Icon under a point (CSS px relative to the canvas) within 14 px: own units first, then other units, then
   * structures; the nearest candidate wins, ties go to the smaller icon.
   */
  pick(x: number, y: number): IconHit | null {
    let best = -1, bestRank = -1, bestD = Infinity, bestHalf = Infinity;
    for (let i = 0; i < this.hitN; i++) {
      const h = this.hits[i];
      const dx = Math.max(0, Math.abs(x - h.x) - h.half), dy = Math.max(0, Math.abs(y - h.y) - h.half);
      const d = Math.hypot(dx, dy) + Math.hypot(x - h.x, y - h.y) * 0.01;
      if (Math.abs(x - h.x) > h.half + PICK_PX || Math.abs(y - h.y) > h.half + PICK_PX) continue;
      if (d > PICK_PX) continue;
      const rank = h.structure ? 0 : h.owner === HUMAN_ID ? 2 : 1;
      if (rank > bestRank || (rank === bestRank && (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && h.half < bestHalf)))) {
        best = i;
        bestRank = rank;
        bestD = d;
        bestHalf = h.half;
      }
    }
    if (best < 0) return null;
    const h = this.hits[best];
    return { kind: h.kind === 2 ? 'cluster' : h.structure ? 'structure' : 'unit', id: h.id, owner: h.owner, members: h.members, structure: h.structure };
  }

  clear(): void {
    this.n = 0;
    this.structs.n = 0;
    this.units.n = 0;
    this.structs.commit();
    this.units.commit();
    this.hitN = 0;
    this.fan = null;
    this.prevHeads.clear();
  }
}
