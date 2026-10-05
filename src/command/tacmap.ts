// FRONT ULTRA — command mode: the tactical map (`M`, DESIGN_V2 §9.10; owner: W5-command-v2, rebuilt in the
// command gauntlet fix round).
//
// A 2D map of 60 km (tank), 300 km (jet) or 150 km (ship) around the vehicle, north up, drawn like a staff map:
//   relief    a 256² local heightfield of the place (the same deterministic relief and biomes the scene streams),
//             muted biome colours under a standard hillshade (light from the north-west at 45°, z-factor 2), drawn
//             once into an offscreen canvas and scaled smoothly (no pixel blocks, no camouflage noise);
//   land      each nation's land as a translucent tint and the borders as one smooth line, from the same quadratic
//             B-spline coverage of the owner grid as the globe's borders (no 25 km staircase);
//   civil     roads and railways, towns with their names;
//   forces    structures and units with the strategic NATO symbols (frame by relation: own rectangle, ally dashed,
//             at war diamond, others rounded; fill in the owner's colour);
//   war       fronts at war as a thick line with its name;
//   you       your unit, the destination with its line, distance and march time; scale bar and north arrow.
// A click sets the autopilot destination; a right-click clears it. The world keeps its clock while it is open.

import * as THREE from 'three';
import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import { formatNumber, getLanguage, t } from '../shared/i18n';
import { nearestPlace } from '../data/places';
import { HOLD_BAND_KM, holderAt, publishedDepthAt, publishedLineOffset } from '../shared/localForces';
import type { GameView } from '../shared/api';
import { getLocalHeightfield } from '../data/index';
import type { LocalHeightfield } from '../data/types';
import { glyphRect, iconAtlasCanvas, structureGlyph, unitGlyph } from '../render/units/icons';
import { StructureType, UnitType, type CommandKind } from '../shared/types';
import { isWaterTerrain } from '../shared/terrain';
import type { Civil } from './civil';
import type { LocalFrame } from './frame';
import type { Ground } from './stream';

export const TACMAP_KM: Record<CommandKind, number> = { tank: 60, jet: 300, ship: 150 };

const CSS = /* css */ `
.fu-cmdx-map { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); pointer-events: auto; }
.fu-cmdx-map.show { display: flex; }
.fu-cmdx-map .card { padding: 0.7rem; }
.fu-cmdx-map .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.5rem;
  font: 700 0.8rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.2em; text-transform: uppercase; }
.fu-cmdx-map .hd span { font: 500 0.78rem/1.2 var(--fu-font, sans-serif); letter-spacing: 0; text-transform: none; color: var(--fu-text-2, #b3c4d6); }
.fu-cmdx-map canvas { display: block; cursor: crosshair; border: 1px solid rgba(132,196,255,0.25); }
.fu-cmdx-map .lg { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; margin-top: 0.45rem; max-width: min(620px, 78vh); font: 600 0.74rem/1.2 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); }
.fu-cmdx-map .lg span { display: inline-flex; align-items: center; gap: 0.3rem; }
.fu-cmdx-map .lg svg { flex: none; }
.fu-cmdx-map .dest { margin-top: 0.4rem; min-height: 1.1rem; max-width: min(620px, 78vh); font: 600 0.8rem/1.3 var(--fu-font, sans-serif); color: #ffd58a; }
`;
let cssDone = false;

/** Relation of a nation to the player, for the NATO frame (§10.7). */
type Rel = 'own' | 'ally' | 'war' | 'other';

/** Muted biome colours (sRGB 0..1) of the 8 splat layers: sand, grass, forest, rock, snow, urban, dirt, wet. */
const BIOME: [number, number, number][] = [
  [0.80, 0.75, 0.60], [0.60, 0.66, 0.47], [0.40, 0.50, 0.36], [0.60, 0.58, 0.54],
  [0.93, 0.94, 0.95], [0.66, 0.63, 0.60], [0.62, 0.55, 0.44], [0.50, 0.56, 0.47],
];
/** Hillshade light from the north-west (azimuth 315°) at 45° above the horizon: (east, north, up). */
const LIGHT = [-0.5, 0.5, Math.SQRT1_2];
const Z_FACTOR = 2;
/** Relief samples per side, and land cells per side. */
const RELIEF_N = 256;
const OWN_N = 200;

function hex(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Quadratic B-spline weights of the three taps around the nearest sample (d = offset from it, −0.5…0.5). */
function bspline(d: number, out: Float32Array): void {
  out[0] = 0.5 * (0.5 - d) * (0.5 - d);
  out[1] = 0.75 - d * d;
  out[2] = 0.5 * (0.5 + d) * (0.5 + d);
}

export interface TacMapInput {
  view: GameView;
  frame: LocalFrame;
  ground: Ground;
  civil: Civil;
  player: THREE.Vector3;
  playerYaw: number;
  waypoint: THREE.Vector3 | null;
  controlledId: number;
  /** The unit's march speed (km/h): the destination's march time. */
  speedKmh: number;
  /** Tile terrain bytes (water tiles hold no land and draw no border). */
  terrain: Uint8Array | null;
  nameOf: (owner: number) => string;
}

export class TacMap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly title: HTMLElement;
  private readonly dest: HTMLElement;
  private readonly size = 620;
  /** The static layers (relief, land tint, borders) for the centre they were built at. */
  private base: HTMLCanvasElement | null = null;
  private baseAt = { x: 1e12, z: 1e12, sig: '' };
  /**
   * The contact lines in the base: per pair of owners at war, the border cell nearest the map's centre (base pixels).
   * The front is drawn on the smoothed border itself, so it never runs apart from the land it divides.
   */
  private warTags = new Map<number, { x: number; y: number }>();
  private open = false;
  private kind: CommandKind = 'tank';
  private cx = 0;
  private cz = 0;
  /** Tools: what the last draw put on the map. */
  readonly stats = { roads: 0, rails: 0, towns: 0, named: 0, structures: 0, units: 0, offensives: 0, fronts: 0, borderCells: 0, reliefMs: 0, landMs: 0 };
  /** Set by the command mode: a click on the map (scene x, z), or null to clear. */
  onPick: (p: { x: number; z: number } | null) => void = () => undefined;

  constructor(parent: HTMLElement) {
    if (!cssDone) {
      cssDone = true;
      const s = document.createElement('style');
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = document.createElement('div');
    this.root.className = 'fu-cmdx-map fu-cmd-interactive';
    const card = document.createElement('div');
    card.className = 'card fu-cmd-panel';
    const hd = document.createElement('div');
    hd.className = 'hd';
    this.title = document.createElement('b');
    const hint = document.createElement('span');
    hd.append(this.title, hint);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.size;
    this.canvas.style.width = this.canvas.style.height = `min(${this.size}px, 78vh)`;
    this.g = this.canvas.getContext('2d')!;
    this.dest = document.createElement('div');
    this.dest.className = 'dest';
    const lg = document.createElement('div');
    lg.className = 'lg';
    card.append(hd, this.canvas, this.dest, lg);
    this.root.appendChild(card);
    parent.appendChild(this.root);
    this.canvas.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const u = (ev.clientX - r.left) / r.width, v = (ev.clientY - r.top) / r.height;
      const half = (TACMAP_KM[this.kind] * 1000) / 2;
      if (ev.button === 2) this.onPick(null);
      else this.onPick({ x: this.cx + (u - 0.5) * 2 * half, z: this.cz + (v - 0.5) * 2 * half });
    });
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    this.root.addEventListener('mousedown', (ev) => ev.stopPropagation());
    this.labels = () => {
      hint.textContent = t('command.map.hint');
      const sw = (body: string) => `<svg width="18" height="14" viewBox="0 0 18 14">${body}</svg>`;
      const curve = 'M1 9 C5 4 10 12 17 5';
      const items: [string, string][] = [
        [sw('<path d="M9 1 L14 13 L9 10 L4 13 Z" fill="#3fd0ff"/>'), 'command.map.you'],
        [sw('<path d="M9 1 L14 7 L9 13 L4 7 Z" fill="#ffd58a"/>'), 'command.map.waypoint'],
        [sw('<rect x="2" y="2" width="14" height="10" fill="#4a7bd0" stroke="#fff" stroke-width="1.2"/>'), 'command.map.friendly'],
        [sw('<rect x="2" y="2" width="14" height="10" fill="#4aa0d0" stroke="#fff" stroke-width="1.2" stroke-dasharray="2 1.5"/>'), 'command.map.ally'],
        [sw('<path d="M9 0.5 L16.5 7 L9 13.5 L1.5 7 Z" fill="#d04a3a" stroke="#fff" stroke-width="1.2"/>'), 'command.map.enemy'],
        [sw('<rect x="2" y="2" width="14" height="10" rx="4" fill="#c9a24a" stroke="#fff" stroke-width="1.2"/>'), 'command.map.neutral'],
        [sw(`<path d="${curve}" fill="none" stroke="#ff7a3d" stroke-width="3.2"/>`), 'command.map.front'],
        [sw(`<path d="${curve}" fill="none" stroke="#fff" stroke-width="1.8"/>`), 'command.map.border'],
        [sw('<path d="M1 10 L17 4" stroke="#5a4a32" stroke-width="3.4"/><path d="M1 10 L17 4" stroke="#f2e6c8" stroke-width="1.8"/>'), 'command.map.road'],
        [sw('<path d="M1 10 L17 4" stroke="#2a2a2a" stroke-width="2.4" stroke-dasharray="3 2"/>'), 'command.map.rail'],
        [sw('<rect x="5" y="3" width="8" height="8" fill="#fff3d8" stroke="#3a3026" stroke-width="1.2"/>'), 'command.map.town'],
        [sw('<path d="M1 5.5 L10 5.5 L10 2 L17 7 L10 12 L10 8.5 L1 8.5 Z" fill="#c9524a" stroke="#1a0a0a" stroke-width="0.8"/>'), 'command.map.offensiveKey'],
      ];
      lg.innerHTML = items.map(([svg, k]) => `<span>${svg}${t(k)}</span>`).join('');
    };
  }

  private labels: () => void;

  get isOpen(): boolean {
    return this.open;
  }

  toggle(kind: CommandKind): void {
    this.kind = kind;
    this.open = !this.open;
    this.root.classList.toggle('show', this.open);
    if (this.open) {
      this.labels();
      this.base = null;
    }
  }

  close(): void {
    this.open = false;
    this.root.classList.remove('show');
  }

  /** Redraw (call ~2 times a second while open). */
  draw(inp: TacMapInput): void {
    if (!this.open) return;
    const { view, frame, civil, player, waypoint } = inp;
    const km = TACMAP_KM[this.kind];
    this.title.textContent = t('command.map.title', { km: formatNumber(km) });
    const S = this.size, half = (km * 1000) / 2;
    this.cx = player.x;
    this.cz = player.z;
    const g = this.g;
    const toPx = (x: number, z: number): [number, number] => [((x - this.cx) / (2 * half) + 0.5) * S, ((z - this.cz) / (2 * half) + 0.5) * S];
    const inMap = (x: number, y: number, m = 0) => x >= -m && y >= -m && x <= S + m && y <= S + m;
    // Static layers: rebuilt when the vehicle has moved 1/8 of the map or a tile in view changed hands; between
    // rebuilds the base is shifted by how far the vehicle moved.
    const ax = player.x + frame.offX, az = player.z + frame.offZ;
    const sig = this.ownerSig(inp, half);
    if (!this.base || Math.hypot(ax - this.baseAt.x, az - this.baseAt.z) > half / 4 || sig !== this.baseAt.sig) {
      this.buildBase(inp, half);
      this.baseAt = { x: ax, z: az, sig };
    }
    const sx = ((this.baseAt.x - ax) / (2 * half)) * S, sz = ((this.baseAt.z - az) / (2 * half)) * S;
    g.fillStyle = '#26323c';
    g.fillRect(0, 0, S, S);
    g.drawImage(this.base!, sx, sz);
    const p0 = { x: 0, z: 0 }, p1 = { x: 0, z: 0 };
    const st = this.stats;
    // Railways (the sim's rail graph between structures), then the roads as cased ribbons.
    st.rails = 0;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const rail = view.rail;
    g.setLineDash([5, 3]);
    g.strokeStyle = 'rgba(30,30,30,0.85)';
    g.lineWidth = 2.2;
    for (let i = 0; i + 1 < rail.length; i += 2) {
      const a = view.structures.get(rail[i]), b = view.structures.get(rail[i + 1]);
      if (!a || !b) continue;
      frame.sceneOfTile((a.tile % MAP_W) + 0.5, Math.floor(a.tile / MAP_W) + 0.5, p0);
      frame.sceneOfTile((b.tile % MAP_W) + 0.5, Math.floor(b.tile / MAP_W) + 0.5, p1);
      const [x0, y0] = toPx(p0.x, p0.z), [x1, y1] = toPx(p1.x, p1.z);
      if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > S || Math.max(y0, y1) < 0 || Math.min(y0, y1) > S) continue;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      st.rails++;
    }
    g.setLineDash([]);
    const roads = civil.mapRoads;
    g.beginPath();
    for (const line of roads) {
      for (let i = 0; i + 1 < line.length; i += 2) {
        const [x, y] = toPx(line[i] - frame.offX, line[i + 1] - frame.offZ);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
    const wRoad = this.kind === 'tank' ? 1 : this.kind === 'ship' ? 0.8 : 0.65;
    g.strokeStyle = 'rgba(70,56,36,0.75)';
    g.lineWidth = 3.4 * wRoad;
    g.stroke();
    g.strokeStyle = 'rgba(246,234,204,0.95)';
    g.lineWidth = 1.7 * wRoad;
    g.stroke();
    st.roads = roads.length;
    // Fronts at war: a thick orange line, named on the stretch nearest the map's centre.
    st.fronts = 0;
    const fronts: { label: string; x: number; y: number }[] = [];
    for (const f of view.fronts) {
      if (view.pairState(f.a, f.b) !== 'war') continue;
      const foe = f.a === HUMAN_ID ? f.b : f.b === HUMAN_ID ? f.a : 0;
      const s = f.samples;
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < s.length; i += 2) {
        frame.sceneOfTile(s[i], s[i + 1], p0);
        pts.push(toPx(p0.x, p0.z));
      }
      const tag = this.warTags.get(f.a < f.b ? f.a * 4096 + f.b : f.b * 4096 + f.a);
      const label = foe ? t('command.map.frontWith', { nation: inp.nameOf(foe) }) : t('command.map.frontOf', { a: inp.nameOf(f.a), b: inp.nameOf(f.b) });
      if (tag && inMap(tag.x + sx, tag.y + sz, -30)) {
        // The front is the war border already drawn in the base: only its name here.
        st.fronts++;
        if (!fronts.some((q) => q.label === label)) fronts.push({ label, x: tag.x + sx, y: tag.y + sz });
        continue;
      }
      if (!pts.some(([x, y]) => inMap(x, y))) continue;
      st.fronts++;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.strokeStyle = 'rgba(40,10,0,0.55)';
      g.lineWidth = 6.5;
      g.stroke();
      g.strokeStyle = foe ? '#ff7a3d' : '#ffb07a';
      g.lineWidth = foe ? 3.6 : 2.2;
      g.stroke();
      let best = -1, bd = Infinity;
      pts.forEach(([x, y], i) => {
        if (!inMap(x, y, -30)) return;
        const d = Math.hypot(x - S / 2, y - S / 2);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) fronts.push({ label, x: pts[best][0], y: pts[best][1] });
    }
    // Towns: places and the sim's cities by size with their names, villages as small squares.
    st.towns = st.named = 0;
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    const free = (x: number, y: number, w: number, h: number) => !taken.some((o) => Math.abs(o.x - x) * 2 < o.w + w && Math.abs(o.y - y) * 2 < o.h + h);
    const [px, py] = toPx(player.x, player.z);
    taken.push({ x: px, y: py, w: 26, h: 26 });
    const towns = [...civil.towns].sort((a, b) => b.level - a.level || b.r - a.r);
    g.font = '600 11.5px "Barlow", sans-serif';
    for (const tw of towns) {
      const [x, y] = toPx(tw.ax - frame.offX, tw.az - frame.offZ);
      if (!inMap(x, y)) continue;
      st.towns++;
      // Villages read as small light blocks with a dark rim (a dark dot vanished on the brown relief).
      const r = tw.level < 0 ? 3 : Math.max(3, Math.min(9, (tw.r / (2 * half)) * S * 0.9));
      g.fillStyle = tw.level < 0 ? 'rgba(236,226,206,0.92)' : '#fff3d8';
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.strokeStyle = tw.level < 0 ? 'rgba(40,30,20,0.75)' : 'rgba(40,30,20,0.9)';
      g.lineWidth = 1;
      g.strokeRect(x - r, y - r, r * 2, r * 2);
    }
    for (const tw of towns) {
      if (!tw.name) continue;
      const [x, y] = toPx(tw.ax - frame.offX, tw.az - frame.offZ);
      if (!inMap(x, y)) continue;
      const big = tw.capital || tw.level >= 4;
      g.font = `${big ? 700 : 600} ${big ? 13 : 11.5}px "Barlow", sans-serif`;
      const w = g.measureText(tw.name).width + 6;
      const r = Math.max(3, Math.min(9, (tw.r / (2 * half)) * S * 0.9));
      const ly = y - r - 7;
      if (!free(x, ly - 4, w, 15)) continue;
      taken.push({ x, y: ly - 4, w, h: 15 });
      this.halo(tw.name, x, ly, '#fff6e0');
      st.named++;
    }
    // No named town on the sheet (open country): point to the nearest real place at the edge, with its distance, so the
    // map still says where it is.
    if (st.named === 0) {
      const ll = frame.latLonOfAbs(ax, az, { lat: 0, lon: 0 });
      const np = nearestPlace(ll.lat, ll.lon, 250);
      if (np) {
        const pp = frame.sceneOf(np.lat, np.lon, { x: 0, z: 0 });
        const [qx, qy] = toPx(pp.x, pp.z);
        const dx = qx - px, dy = qy - py, dl = Math.hypot(dx, dy) || 1;
        // Where the ray from the unit leaves the sheet (a margin inside it).
        const m = 40, kx = dx > 0 ? (S - m - px) / dx : dx < 0 ? (m - px) / dx : Infinity, ky = dy > 0 ? (S - m - py) / dy : dy < 0 ? (m - py) / dy : Infinity;
        const k = Math.min(kx, ky);
        const ex = px + dx * k, ey = py + dy * k;
        g.save();
        g.translate(ex, ey);
        g.rotate(Math.atan2(dy, dx));
        g.fillStyle = '#fff6e0';
        g.strokeStyle = 'rgba(20,16,10,0.85)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(12, 0);
        g.lineTo(-4, -7);
        g.lineTo(-4, 7);
        g.closePath();
        g.stroke();
        g.fill();
        g.restore();
        const name = getLanguage() === 'es' ? np.nameEs : np.nameEn || np.nameEs;
        g.font = '600 11.5px "Barlow", sans-serif';
        this.halo(t('command.map.placeOff', { place: name, km: formatNumber(np.km, 0) }), ex - (dx / dl) * 26, ey - (dy / dl) * 18 + 4, '#fff6e0');
      }
    }
    // Structures and units: the strategic NATO symbols, framed by relation, filled with the owner's colour.
    const rel = (o: number): Rel => (o === HUMAN_ID ? 'own' : view.hasTreaty(HUMAN_ID, o, 'alliance') || view.human?.allies.includes(o) ? 'ally' : view.pairState(HUMAN_ID, o) === 'war' ? 'war' : 'other');
    st.structures = 0;
    for (const s of view.structures.values()) {
      if (s.type === StructureType.City) continue;
      frame.sceneOfTile((s.tile % MAP_W) + 0.5, Math.floor(s.tile / MAP_W) + 0.5, p0);
      const [x, y] = toPx(p0.x, p0.z);
      if (!inMap(x, y, -8)) continue;
      this.symbol(x, y, 8, structureGlyph(s.type), view.players[s.owner]?.color ?? 0x888888, rel(s.owner), s.hp < 0.999 ? s.hp : -1);
      st.structures++;
    }
    st.units = 0;
    for (const u of view.units.values()) {
      if (u.id === inp.controlledId || !(u.hp > 0)) continue;
      if (u.type !== UnitType.ArmoredDivision && u.type !== UnitType.Warship && u.type !== UnitType.FighterSquadron && u.type !== UnitType.Bomber && u.type !== UnitType.TransportShip && u.type !== UnitType.TradeShip) continue;
      frame.sceneOfTile(u.x, u.y, p0);
      const [x, y] = toPx(p0.x, p0.z);
      if (!inMap(x, y, -8)) continue;
      this.symbol(x, y, 9.5, unitGlyph(u.type), view.players[u.owner]?.color ?? 0x888888, rel(u.owner), u.hp < 0.999 ? u.hp : -1);
      st.units++;
    }
    // Known forces on the fronts: each land offensive as an attack arrow in its army's colour, ending where it fights
    // now, with the troops it has committed (the masses of men the line is made of: no division symbol stands for them).
    st.offensives = 0;
    const kmPerPx = (2 * half) / 1000 / S;
    for (const at of view.attacks) {
      if (at.naval || at.contactX < 0 || at.defender <= 0) continue;
      if (view.pairState(at.attacker, at.defender) !== 'war') continue;
      frame.sceneOfTile(at.contactX, at.contactY, p0);
      frame.sceneOfTile(at.originX, at.originY, p1);
      const [cx, cy] = toPx(p0.x, p0.z);
      if (!inMap(cx, cy, -6)) continue;
      const [ox, oy] = toPx(p1.x, p1.z);
      let dx = cx - ox, dy = cy - oy;
      const dl = Math.hypot(dx, dy);
      if (dl < 1) continue;
      dx /= dl;
      dy /= dl;
      // The arrow covers the last ~9 km of the axis (or all of it if shorter), at least 26 px.
      const len = Math.max(26, Math.min(dl, 9 / kmPerPx));
      const bx = cx - dx * len, by = cy - dy * len;
      const col = '#' + (view.players[at.attacker]?.color ?? 0x888888).toString(16).padStart(6, '0');
      const nx = -dy, ny = dx, w = 5, hw = 10, hl = 13;
      const hx = cx - dx * hl, hy = cy - dy * hl;
      g.beginPath();
      g.moveTo(bx + nx * w * 0.6, by + ny * w * 0.6);
      g.lineTo(hx + nx * w, hy + ny * w);
      g.lineTo(hx + nx * hw, hy + ny * hw);
      g.lineTo(cx, cy);
      g.lineTo(hx - nx * hw, hy - ny * hw);
      g.lineTo(hx - nx * w, hy - ny * w);
      g.lineTo(bx - nx * w * 0.6, by - ny * w * 0.6);
      g.closePath();
      g.globalAlpha = 0.85;
      g.fillStyle = col;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = at.attacker === HUMAN_ID ? 'rgba(255,255,255,0.95)' : 'rgba(20,10,10,0.9)';
      g.lineWidth = 1.4;
      g.stroke();
      g.font = '700 11px "Barlow Condensed", "Barlow", sans-serif';
      const lbl = t('command.map.offensive', { n: formatNumber(Math.round(at.troops)) });
      const lx = bx - dx * 4, ly = by - dy * 4 + 4;
      if (free(lx, ly - 4, g.measureText(lbl).width + 6, 15)) {
        taken.push({ x: lx, y: ly - 4, w: g.measureText(lbl).width + 6, h: 15 });
        this.halo(lbl, lx, ly, at.attacker === HUMAN_ID ? '#cfe6ff' : '#ffd0c0');
      }
      st.offensives++;
    }
    for (const f of fronts) this.tag(f.label, f.x, f.y - 16, '#ffc8a8', 'rgba(44,14,0,0.85)');
    // The destination: dashed line, marker, distance and march time.
    if (waypoint) {
      const [wx, wy] = toPx(waypoint.x, waypoint.z);
      g.setLineDash([7, 5]);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(wx, wy);
      g.stroke();
      g.strokeStyle = 'rgba(255,213,138,0.95)';
      g.lineWidth = 2;
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd58a';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(wx, wy - 9);
      g.lineTo(wx + 7, wy);
      g.lineTo(wx, wy + 9);
      g.lineTo(wx - 7, wy);
      g.closePath();
      g.fill();
      g.stroke();
      const d = Math.hypot(waypoint.x - player.x, waypoint.z - player.z) / 1000;
      const h = d / Math.max(1, inp.speedKmh);
      const time = h >= 1 ? `${formatNumber(h, 1)} h` : `${Math.max(1, Math.round(h * 60))} min`;
      const kmTxt = formatNumber(d, d < 10 ? 1 : 0);
      this.tag(`${kmTxt} km · ${time}`, wx, wy - 22, '#ffd58a', 'rgba(20,14,4,0.85)');
      this.dest.textContent = t('command.map.destLine', { km: kmTxt, time, kmh: formatNumber(inp.speedKmh) });
    } else this.dest.textContent = t('command.map.noDest');
    // You.
    g.save();
    g.translate(px, py);
    g.rotate(-inp.playerYaw);
    g.fillStyle = '#3fd0ff';
    g.strokeStyle = 'rgba(0,20,30,0.9)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(8, 9);
    g.lineTo(0, 4.5);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // Scale bar (bottom left) and north arrow (top right).
    const barKm = km >= 200 ? 50 : km >= 100 ? 20 : 10;
    const barPx = ((barKm * 1000) / (2 * half)) * S;
    g.fillStyle = 'rgba(8,12,18,0.72)';
    g.fillRect(10, S - 36, barPx + 32, 28);
    g.fillStyle = '#fff';
    g.fillRect(22, S - 17, barPx / 2, 4);
    g.fillStyle = '#222';
    g.fillRect(22 + barPx / 2, S - 17, barPx / 2, 4);
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.strokeRect(22.5, S - 16.5, barPx, 4);
    g.font = '600 11px "Barlow", sans-serif';
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.fillText('0', 22, S - 21);
    g.fillText(`${barKm} km`, 22 + barPx, S - 21);
    const nx = S - 28, ny = 30;
    g.fillStyle = 'rgba(8,12,18,0.72)';
    g.beginPath();
    g.arc(nx, ny, 19, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(nx, ny - 14);
    g.lineTo(nx + 6, ny + 5);
    g.lineTo(nx, ny + 1);
    g.closePath();
    g.fill();
    g.fillStyle = '#8b98a8';
    g.beginPath();
    g.moveTo(nx, ny - 14);
    g.lineTo(nx - 6, ny + 5);
    g.lineTo(nx, ny + 1);
    g.closePath();
    g.fill();
    g.font = '700 10px "Barlow Condensed", sans-serif';
    g.fillStyle = '#fff';
    g.fillText('N', nx, ny + 15);
  }

  /** A signature of the ownership of the tiles in view (the land layer is rebuilt when a tile changes hands). */
  private ownerSig(inp: TacMapInput, half: number): string {
    const { view, frame } = inp;
    const a = frame.tileOfScene(this.cx - half, this.cz - half, { x: 0, y: 0 });
    const b = frame.tileOfScene(this.cx + half, this.cz + half, { x: 0, y: 0 });
    let h = 0;
    const x0 = Math.floor(a.x) - 1, x1 = Math.floor(b.x) + 1;
    const span = x1 >= x0 ? x1 - x0 : x1 + MAP_W - x0;
    for (let ty = Math.floor(a.y) - 1; ty <= Math.floor(b.y) + 1; ty++) {
      if (ty < 0 || ty >= MAP_H) continue;
      for (let k = 0; k <= span; k++) {
        const i = ty * MAP_W + ((x0 + k) % MAP_W);
        const o = view.owner[i] ?? 0;
        h = (Math.imul(h, 31) + o * 7 + i + (o > 0 && o !== HUMAN_ID && view.pairState(HUMAN_ID, o) === 'war' ? 101 : 0)) | 0;
      }
    }
    // The published front lines move inside their tiles: half-kilometre steps of their depth rebuild the land layer.
    for (const f of view.fronts) {
      if (!f.line || (f.a !== HUMAN_ID && f.b !== HUMAN_ID)) continue;
      h = (Math.imul(h, 31) + Math.round(publishedDepthAt(f.line, view.tick) * 2) + f.key) | 0;
    }
    return String(h);
  }

  /** Relief, land tint and borders for the current centre, into an offscreen canvas of the map's size. */
  private buildBase(inp: TacMapInput, half: number): void {
    const S = this.size;
    const { frame, view } = inp;
    const t0 = performance.now();
    // 1. Relief: the local heightfield of the place (the scene's relief and biomes), hillshaded, smoothly scaled.
    const ll = frame.latLonOfScene(this.cx, this.cz, { lat: 0, lon: 0 });
    const N = RELIEF_N;
    let hf: LocalHeightfield | null = null;
    try {
      hf = getLocalHeightfield(ll.lat, ll.lon, (2 * half) / 1000, N, { seed: 0, refLat: frame.lat0, seamless: true, detail: 0.6 });
    } catch {
      hf = null;
    }
    const hs = new Float32Array(N * N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        hs[i * N + j] = hf ? hf.heights[i * N + j] : inp.ground.heightAt(this.cx + (j / (N - 1) - 0.5) * 2 * half, this.cz + (i / (N - 1) - 0.5) * 2 * half);
      }
    }
    const cell = (2 * half) / (N - 1);
    const at = (i: number, j: number) => hs[Math.max(0, Math.min(N - 1, i)) * N + Math.max(0, Math.min(N - 1, j))];
    const rc = document.createElement('canvas');
    rc.width = rc.height = N;
    const rg = rc.getContext('2d')!;
    const img = rg.createImageData(N, N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const k = i * N + j, o = k * 4;
        const h = hs[k];
        const water = hf ? hf.water[k] / 255 : h < 0.3 ? 1 : 0;
        // Standard hillshade: the surface normal (east, north, up) with the z-factor against the light.
        const dEast = ((at(i, j + 1) - at(i, j - 1)) / (2 * cell)) * Z_FACTOR;
        const dNorth = ((at(i - 1, j) - at(i + 1, j)) / (2 * cell)) * Z_FACTOR;
        const shade = Math.max(0, (-dEast * LIGHT[0] - dNorth * LIGHT[1] + LIGHT[2]) / Math.hypot(dEast, dNorth, 1));
        // Flat ground keeps its colour; slopes facing the light brighten, slopes away from it darken.
        const m = 0.45 + 0.55 * (shade / LIGHT[2]);
        let r: number, gg: number, b: number;
        if (hf) {
          r = gg = b = 0;
          for (let q = 0; q < 8; q++) {
            const w = (q < 4 ? hf.splatA[k * 4 + q] : hf.splatB[k * 4 + q - 4]) / 255;
            r += BIOME[q][0] * w;
            gg += BIOME[q][1] * w;
            b += BIOME[q][2] * w;
          }
          // A little of the real regional colour.
          r = r * 0.75 + (hf.tint[k * 3] / 255) * 0.25;
          gg = gg * 0.75 + (hf.tint[k * 3 + 1] / 255) * 0.25;
          b = b * 0.75 + (hf.tint[k * 3 + 2] / 255) * 0.25;
        } else {
          const e = Math.min(1, Math.max(0, h) / 2500);
          r = 0.55 + e * 0.25;
          gg = 0.6 + e * 0.12;
          b = 0.45 + e * 0.15;
        }
        // Muted toward grey (a map, not a photo), high ground a touch lighter.
        const grey = (r + gg + b) / 3;
        const lift = Math.min(0.12, Math.max(0, h) / 25000);
        let R = Math.min(1, (r * 0.78 + grey * 0.22 + lift) * m);
        let G2 = Math.min(1, (gg * 0.78 + grey * 0.22 + lift) * m);
        let B = Math.min(1, (b * 0.78 + grey * 0.22 + lift) * m);
        if (water > 0.02) {
          const depth = Math.min(1, Math.max(0, -h) / 60);
          R = R * (1 - water) + (0.3 - depth * 0.08) * water;
          G2 = G2 * (1 - water) + (0.44 - depth * 0.08) * water;
          B = B * (1 - water) + (0.56 - depth * 0.06) * water;
        }
        img.data[o] = R * 255;
        img.data[o + 1] = G2 * 255;
        img.data[o + 2] = B * 255;
        img.data[o + 3] = 255;
      }
    }
    rg.putImageData(img, 0, 0);
    const base = (this.base ??= document.createElement('canvas'));
    base.width = base.height = S;
    const bg = base.getContext('2d')!;
    bg.imageSmoothingEnabled = true;
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(rc, 0, 0, N, N, 0, 0, S, S);
    const t1 = performance.now();
    // 2. Land: per cell the quadratic B-spline coverage of the owner grid (land tiles vote, water does not). The
    // winner tints the cell; where the winner changes the border runs, faded by how level the two owners are.
    const M = OWN_N;
    const win = new Int32Array(M * M);
    const lead = new Float32Array(M * M);
    const wx = new Float32Array(3), wy = new Float32Array(3);
    const own: number[] = [], cov: number[] = [];
    const tp = { x: 0, y: 0 };
    const terr = inp.terrain;
    const lines = view.fronts.filter((f) => f.line && f.b !== 0 && (f.a === HUMAN_ID || f.b === HUMAN_ID));
    const hasLines = lines.length > 0;
    // Within a published line's window and band (where holderAt reads the line, not the tile).
    const inBand = (x: number, y: number) => lines.some((f) => {
      const po = publishedLineOffset(f.line!, x, y, view.tick);
      return Math.abs(po.alongKm) <= f.line!.halfKm && Math.abs(po.offsetKm) <= HOLD_BAND_KM;
    });
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) {
        frame.tileOfScene(this.cx + ((j + 0.5) / M - 0.5) * 2 * half, this.cz + ((i + 0.5) / M - 0.5) * 2 * half, tp);
        const u = tp.x - 0.5, v = tp.y - 0.5;
        const nu = Math.round(u), nv = Math.round(v);
        bspline(u - nu, wx);
        bspline(v - nv, wy);
        own.length = cov.length = 0;
        let wsum = 0;
        for (let b = 0; b < 3; b++) {
          const ty = nv + b - 1;
          if (ty < 0 || ty >= MAP_H) continue;
          for (let a = 0; a < 3; a++) {
            const ti = ty * MAP_W + ((((nu + a - 1) % MAP_W) + MAP_W) % MAP_W);
            if (terr && isWaterTerrain(terr[ti])) continue;
            const w = wx[a] * wy[b];
            const o = view.owner[ti] ?? 0;
            wsum += w;
            const q = own.indexOf(o);
            if (q < 0) {
              own.push(o);
              cov.push(w);
            } else cov[q] += w;
          }
        }
        let best = -1, bc = -1, second = 0;
        for (let q = 0; q < own.length; q++) {
          if (cov[q] > bc) {
            second = Math.max(second, bc);
            bc = cov[q];
            best = own[q];
          } else if (cov[q] > second) second = cov[q];
        }
        const k = i * M + j;
        win[k] = wsum > 0 ? best : -1;
        lead[k] = wsum > 0 ? (bc - second) / wsum : 1;
        // Near our fronts the ground is held by the side of the published sub-tile line (holderAt, the one source of
        // truth of the battle, the HUD and local forces), not by the 25 km tile's owner: the map shows the line where
        // the fighting is, and the land behind it as ours, as the HUD says.
        if (win[k] > 0 && hasLines) {
          if (inBand(tp.x, tp.y)) {
            const h = holderAt(view, tp.x, tp.y, HUMAN_ID);
            if (h > 0) {
              win[k] = h;
              lead[k] = 1;
            }
          }
        }
      }
    }
    const oc = document.createElement('canvas');
    oc.width = oc.height = M;
    const og = oc.getContext('2d')!;
    const tint = og.createImageData(M, M);
    const lc = document.createElement('canvas');
    lc.width = lc.height = M;
    const lg = lc.getContext('2d')!;
    const line = lg.createImageData(M, M);
    let borderCells = 0;
    const wc = document.createElement('canvas');
    wc.width = wc.height = M;
    const wgc = wc.getContext('2d')!;
    const wline = wgc.createImageData(M, M);
    const atWar = (a: number, b: number) => a > 0 && b > 0 && a !== b && view.pairState(a, b) === 'war';
    const pk = (a: number, b: number) => (a < b ? a * 4096 + b : b * 4096 + a);
    this.warTags.clear();
    const warD = new Map<number, number>();
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) {
        const k = i * M + j, o = k * 4;
        const w0 = win[k];
        if (w0 < 0) continue;
        if (w0 > 0) {
          const c = view.players[w0]?.color ?? 0x888888;
          tint.data[o] = (c >> 16) & 255;
          tint.data[o + 1] = (c >> 8) & 255;
          tint.data[o + 2] = c & 255;
          // Our own land lighter: the map is read from our side; the others' land clearly theirs.
          tint.data[o + 3] = w0 === HUMAN_ID ? 40 : 70;
        }
        let edge = false;
        if (j + 1 < M && win[k + 1] >= 0 && win[k + 1] !== w0) edge = true;
        if (i + 1 < M && win[k + M] >= 0 && win[k + M] !== w0) edge = true;
        if (j > 0 && win[k - 1] >= 0 && win[k - 1] !== w0) edge = true;
        if (i > 0 && win[k - M] >= 0 && win[k - M] !== w0) edge = true;
        // A border with a neighbour at war is the contact line: drawn as the front (orange, thicker), not white.
        let foe = 0;
        for (const n of [j + 1 < M ? k + 1 : -1, i + 1 < M ? k + M : -1, j > 0 ? k - 1 : -1, i > 0 ? k - M : -1]) {
          if (n >= 0 && atWar(w0, win[n])) foe = win[n];
        }
        if (foe) {
          wline.data[o] = 255;
          wline.data[o + 1] = 122;
          wline.data[o + 2] = 61;
          wline.data[o + 3] = 255;
          const key = pk(w0, foe);
          // (Named off the vehicle's own mark: the nearest stretch at least ~80 px from the centre.)
          const dc = Math.hypot(j + 0.5 - M / 2, i + 0.5 - M / 2);
          const d = dc < (80 / S) * M ? 1e6 - dc : dc;
          if (d < (warD.get(key) ?? Infinity)) {
            warD.set(key, d);
            this.warTags.set(key, { x: ((j + 0.5) / M) * S, y: ((i + 0.5) / M) * S });
          }
          borderCells++;
        } else if (edge) {
          line.data[o] = line.data[o + 1] = line.data[o + 2] = 255;
          line.data[o + 3] = Math.round(255 * Math.max(0.4, Math.min(1, 1.15 - lead[k] * 2)));
          borderCells++;
        }
      }
    }
    og.putImageData(tint, 0, 0);
    lg.putImageData(line, 0, 0);
    bg.drawImage(oc, 0, 0, M, M, 0, 0, S, S);
    // The border line: a dark halo (blurred), then the white line, both scaled smoothly from the cell grid.
    bg.save();
    bg.filter = 'blur(1.5px) brightness(0)';
    bg.globalAlpha = 0.55;
    bg.drawImage(lc, 0, 0, M, M, 0, 0, S, S);
    bg.restore();
    bg.drawImage(lc, 0, 0, M, M, 0, 0, S, S);
    // The fronts on the same border, a little thicker (drawn twice, offset by a pixel) over a dark halo.
    wgc.putImageData(wline, 0, 0);
    bg.save();
    bg.filter = 'blur(2px) brightness(0)';
    bg.globalAlpha = 0.6;
    bg.drawImage(wc, 0, 0, M, M, 0, 0, S, S);
    bg.restore();
    for (const [ox, oy] of [[-0.8, 0], [0.8, 0], [0, -0.8], [0, 0.8]]) bg.drawImage(wc, 0, 0, M, M, ox, oy, S, S);
    this.stats.borderCells = borderCells;
    this.stats.reliefMs = Math.round(t1 - t0);
    this.stats.landMs = Math.round(performance.now() - t1);
  }

  /** Text with a dark halo (names). */
  private halo(text: string, x: number, y: number, color: string): void {
    const g = this.g;
    g.textAlign = 'center';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(20,16,10,0.85)';
    g.lineWidth = 3.2;
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  /** A small label on a dark plate, kept inside the map (front names, the destination). */
  private tag(text: string, x: number, y: number, color: string, plate: string): void {
    const g = this.g;
    g.font = '700 11.5px "Barlow Condensed", "Barlow", sans-serif';
    const w = g.measureText(text).width + 10;
    const S = this.size;
    const lx = Math.max(4, Math.min(S - w - 4, x - w / 2));
    const ly = Math.max(52, Math.min(S - 58, y - 9));
    g.fillStyle = plate;
    g.fillRect(lx, ly, w, 17);
    g.fillStyle = color;
    g.textAlign = 'left';
    g.fillText(text, lx + 5, ly + 12.5);
  }

  /** A NATO symbol: frame by relation, filled with the owner's colour, the glyph in white or black, an hp bar if hurt. */
  private symbol(x: number, y: number, r: number, glyph: number, color: number, rel: Rel, hp: number): void {
    const g = this.g;
    g.save();
    g.beginPath();
    if (rel === 'war') {
      g.moveTo(x, y - r * 1.3);
      g.lineTo(x + r * 1.3, y);
      g.lineTo(x, y + r * 1.3);
      g.lineTo(x - r * 1.3, y);
      g.closePath();
    } else if (rel === 'other') {
      const w = r * 1.3, h = r * 0.95, k = r * 0.45;
      g.moveTo(x - w + k, y - h);
      g.arcTo(x + w, y - h, x + w, y + h, k);
      g.arcTo(x + w, y + h, x - w, y + h, k);
      g.arcTo(x - w, y + h, x - w, y - h, k);
      g.arcTo(x - w, y - h, x + w, y - h, k);
      g.closePath();
    } else g.rect(x - r * 1.3, y - r * 0.95, r * 2.6, r * 1.9);
    g.fillStyle = hex(color);
    g.fill();
    g.lineWidth = 2.6;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.stroke();
    if (rel === 'ally') g.setLineDash([3, 2]);
    g.lineWidth = 1.2;
    g.strokeStyle = '#fff';
    g.stroke();
    g.setLineDash([]);
    // The glyph in white or black, whichever reads better on the fill.
    const lum = 0.2126 * ((color >> 16) & 255) + 0.7152 * ((color >> 8) & 255) + 0.0722 * (color & 255);
    const atlas = lum > 150 ? darkAtlas() : iconAtlasCanvas();
    const [gx, gy, gs] = glyphRect(glyph);
    const sz = r * 1.75;
    g.drawImage(atlas, gx, gy, gs, gs, x - sz / 2, y - sz / 2, sz, sz);
    if (hp >= 0) {
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(x - r * 1.3, y + r * 1.3, r * 2.6, 3);
      g.fillStyle = hp > 0.6 ? '#45f0a0' : hp > 0.3 ? '#ffc44a' : '#ff5a4a';
      g.fillRect(x - r * 1.3, y + r * 1.3, r * 2.6 * Math.max(0, Math.min(1, hp)), 3);
    }
    g.restore();
  }
}

/** The glyph atlas in black (glyphs on light fills). */
let dark: HTMLCanvasElement | null = null;
function darkAtlas(): HTMLCanvasElement {
  if (dark) return dark;
  const src = iconAtlasCanvas();
  dark = document.createElement('canvas');
  dark.width = src.width;
  dark.height = src.height;
  const g = dark.getContext('2d')!;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#111';
  g.fillRect(0, 0, dark.width, dark.height);
  return dark;
}
