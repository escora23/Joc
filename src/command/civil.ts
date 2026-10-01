// FRONT ULTRA — command mode: the civil world around the vehicle (DESIGN_V2 §9.5; owner: W5-command-v2).
//
// What you see where there is no war: the real places of src/data/places.ts and the sim's City structures as towns
// with their names, villages seeded by the NASA night lights (bright = dense, dark = empty), roads linking them
// (deterministic, from their positions), the sim's rail graph (view.rail) with its trains, every structure in view
// (bases, SAM sites, radars, ports...) with its real model and level, and the borders: where tile ownership changes,
// a painted line in the neighbour's colour with posts every 500 m and a crossing gate where a road meets it.
// Everything is placed through the session frame at its real position and draped on the streamed ground; the layout
// is rebuilt (cheaply) when the vehicle has moved or finer terrain arrived under it.

import * as THREE from 'three';
import { nearestPlace, PLACES, placeKm } from '../data/places';
import { sampleNightLights } from '../data';
import { HUMAN_ID, MAP_H, MAP_W, TILE_KM } from '../shared/constants';
import { tileToLatLon } from '../shared/geo';
import { CITY_BLOCKS, collapsedBlocks, damageState, standingShare } from '../shared/damage';
import { getLanguage, t } from '../shared/i18n';
import type { GameView } from '../shared/api';
import { StructureType, UnitType, type CommandKind, type StructureView } from '../shared/types';
import { buildStructModel, levelKey, type StructModelKey } from '../render/units/models';
import type { LocalFrame } from './frame';
import type { Ground } from './stream';
import { houseGeometry } from './models/props';
import { buildCmdStructure } from './models/structures';

export interface CivilLabel {
  /** Scene position of the label anchor. */
  x: number;
  y: number;
  z: number;
  text: string;
  sub: string;
  /** 'force': a real unit of the simulation (division, ship, squadron, quick-reaction force), added by command/index.ts. */
  kind: 'capital' | 'town' | 'city' | 'base' | 'border' | 'force';
  color: string;
  /** 'force' only: hostile (red), at peace (amber) or own/allied (blue). */
  tone?: 'hostile' | 'neutral' | 'own';
  owner: number;
}

interface Town {
  key: string;
  name: string;
  lat: number;
  lon: number;
  ax: number;
  az: number;
  /** Built-up radius (m). */
  r: number;
  owner: number;
  capital: boolean;
  level: number;
  /** The sim City this town is (0 = a place or village the sim does not model): its houses are its blocks (#27). */
  cityId: number;
}

/** A house of a town in the scene (feedback 3, #27): what a shell can hit, and which city block it belongs to. */
export interface HouseRec {
  key: string;
  x: number;
  z: number;
  /** Ground height, half footprint (m, as a radius) and height (m). */
  y: number;
  r: number;
  h: number;
  inst: number;
  cityId: number;
  block: number;
  owner: number;
  down: boolean;
}

/** A structure's footprint in the scene with its standing height, for hits (#27). */
export interface StructRec {
  id: number;
  type: StructureType;
  owner: number;
  x: number;
  z: number;
  half: number;
  y0: number;
  y1: number;
}

/** Something burning or smoking in the scene (damaged structures, collapsed blocks, rubble): drawn by the effects. */
export interface Fire {
  x: number;
  y: number;
  z: number;
  /** 0..1: smoke only below 0.4, flames above. */
  heat: number;
  size: number;
}

/**
 * Real footprints (km) and the height (m) of the model's tallest part: the globe's models exaggerate height for
 * readability from orbit; here they stand at human scale (hangars ~20 m, a radar mast ~30 m).
 */
const STRUCT_KM: Record<number, { key: StructModelKey; km: number; tallM: number }> = {
  [StructureType.Port]: { key: 'port', km: 1.4, tallM: 28 },
  [StructureType.Factory]: { key: 'factory', km: 1.1, tallM: 26 },
  [StructureType.DefensePost]: { key: 'defensePost', km: 0.4, tallM: 7 },
  [StructureType.SamSite]: { key: 'samSite', km: 0.7, tallM: 12 },
  [StructureType.MissileSilo]: { key: 'silo', km: 0.8, tallM: 14 },
  [StructureType.Airbase]: { key: 'airbase', km: 3.2, tallM: 22 },
  [StructureType.ArmyBase]: { key: 'armyBase', km: 1.2, tallM: 16 },
  [StructureType.NavalYard]: { key: 'navalYard', km: 1.5, tallM: 34 },
  [StructureType.Radar]: { key: 'radar', km: 0.5, tallM: 32 },
};

const MAX_HOUSES = 3200;
const MAX_POSTS = 900;
const MAX_TRAIN_CARS = 40;

function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 100003) / 100003;
}

function css(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Ribbon builder: a strip of width w draped along a polyline (scene x, y, z). */
class Ribbon {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  add(pts: number[], w: number, r: number, g: number, b: number): void {
    const n = pts.length / 3;
    if (n < 2) return;
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let dx = pts[i1 * 3] - pts[i0 * 3], dz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const nx = -dz * w * 0.5, nz = dx * w * 0.5;
      this.pos.push(pts[i * 3] + nx, pts[i * 3 + 1], pts[i * 3 + 2] + nz, pts[i * 3] - nx, pts[i * 3 + 1], pts[i * 3 + 2] - nz);
      this.col.push(r, g, b, r, g, b);
      if (i < n - 1) {
        const a = base + i * 2;
        this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const nrm = new Float32Array(this.pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

export class Civil {
  readonly group = new THREE.Group();
  private readonly houses: THREE.InstancedMesh;
  private readonly posts: THREE.InstancedMesh;
  private readonly cars: THREE.InstancedMesh;
  private roads: THREE.Mesh | null = null;
  private borders: THREE.Mesh | null = null;
  private rails: THREE.Mesh | null = null;
  private readonly structGroup = new THREE.Group();
  private readonly lineMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  private readonly structMats = new Map<number, THREE.MeshStandardMaterial>();
  private readonly structGeos = new Map<string, THREE.BufferGeometry>();
  /** Highest point (m) of each built compound model (hit tests, labels). */
  private readonly structTops = new Map<string, number>();
  private frame: LocalFrame | null = null;
  private ground: Ground | null = null;
  private kind: CommandKind = 'tank';
  labels: CivilLabel[] = [];
  /** Town houses (scene x, z, radius): obstacles for ground vehicles. */
  readonly houseList: { x: number; z: number; r: number }[] = [];
  /** Feedback 3 (#27): every placed house (hit tests, collapse) and a 100 m grid over them. */
  readonly houseRecs: HouseRec[] = [];
  private houseGrid = new Map<string, number[]>();
  /** Structures in the scene (hit tests). */
  readonly structRecs: StructRec[] = [];
  /** Houses destroyed in this session (they stay down when the layout is rebuilt). */
  private readonly downHouses = new Set<string>();
  /** Fires and smoke of the damage in view. */
  fires: Fire[] = [];
  /** Rubble piles of destroyed structures in view. */
  private readonly rubble: THREE.InstancedMesh;
  /** Structure footprints (scene centre, half size): nothing spawns inside. */
  private readonly footprints: { x: number; z: number; half: number }[] = [];
  towns: Town[] = [];
  /** Road polylines in absolute map meters (for gates and keep-out), rebuilt with the towns. */
  private roadAbs: number[][] = [];
  private keepGrid = new Map<string, number[]>();
  /** Discs kept clear for the whole session (the entry point), absolute meters. */
  private readonly clearDiscs: number[] = [];
  private lastAx = 1e12;
  private lastAz = 1e12;
  private lastBuilt = -1;
  private lastRebuild = 0;
  private lastRail = -1;
  private lastStructSig = '';
  readonly stats = { towns: 0, houses: 0, roads: 0, borderKm: 0, posts: 0, gates: 0, structures: 0, rebuildMs: 0 };

  constructor(propMat: THREE.Material) {
    this.group.name = 'cmd-civil';
    const mk = (g: THREE.BufferGeometry, n: number, name: string) => {
      const im = new THREE.InstancedMesh(g, propMat, n);
      im.name = name;
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(im);
      return im;
    };
    this.houses = mk(houseGeometry(), MAX_HOUSES, 'civil-houses');
    const post = new THREE.CylinderGeometry(0.12, 0.15, 2.4, 6).translate(0, 1.2, 0);
    const pc = new Float32Array(post.attributes.position.count * 3).fill(1);
    post.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    this.posts = mk(post, MAX_POSTS, 'border-posts');
    const car = new THREE.BoxGeometry(3, 3.6, 18).translate(0, 2.2, 0);
    const cc = new Float32Array(car.attributes.position.count * 3).fill(1);
    car.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    this.cars = mk(car, MAX_TRAIN_CARS, 'train-cars');
    const deb = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const dc = new Float32Array(deb.attributes.position.count * 3).fill(1);
    deb.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    this.rubble = mk(deb, MAX_RUBBLE, 'rubble');
    this.group.add(this.structGroup);
  }

  begin(frame: LocalFrame, ground: Ground, kind: CommandKind): void {
    this.clear();
    this.frame = frame;
    this.ground = ground;
    this.kind = kind;
  }

  clear(): void {
    for (const m of [this.roads, this.borders, this.rails]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.roads = this.borders = this.rails = null;
    this.structGroup.clear();
    // Compound models are per structure (and state): dispose them with the session.
    for (const [k, g] of this.structGeos) {
      if (this.structTops.has(k) && !g.getAttribute('aColor')) {
        g.dispose();
        this.structGeos.delete(k);
        this.structTops.delete(k);
      }
    }
    this.gateGroup.clear();
    this.houses.count = 0;
    this.posts.count = 0;
    this.cars.count = 0;
    this.rubble.count = 0;
    this.houseRecs.length = 0;
    this.houseGrid.clear();
    this.structRecs.length = 0;
    this.downHouses.clear();
    this.fires = [];
    this.labels = [];
    this.towns = [];
    this.roadAbs = [];
    this.keepGrid.clear();
    this.clearDiscs.length = 0;
    this.lastAx = this.lastAz = 1e12;
    this.lastBuilt = -1;
    this.lastRail = -1;
    this.lastStructSig = '';
    this.group.position.set(0, 0, 0);
  }

  /** Floating origin moved: everything keeps its place. */
  rebase(dx: number, dz: number): void {
    this.group.position.x -= dx;
    this.group.position.z -= dz;
    for (const h of this.houseList) {
      h.x -= dx;
      h.z -= dz;
    }
    for (const fp of this.footprints) {
      fp.x -= dx;
      fp.z -= dz;
    }
    for (const r of this.houseRecs) {
      r.x -= dx;
      r.z -= dz;
    }
    this.regrid();
    for (const r of this.structRecs) {
      r.x -= dx;
      r.z -= dz;
    }
    for (const f of this.fires) {
      f.x -= dx;
      f.z -= dz;
    }
    for (const l of this.labels) {
      l.x -= dx;
      l.z -= dz;
    }
  }

  private get radii(): { town: number; house: number; road: number; border: number; struct: number; step: number } {
    if (this.kind === 'jet') return { town: 140_000, house: 30_000, road: 30_000, border: 60_000, struct: 60_000, step: 120 };
    if (this.kind === 'ship') return { town: 70_000, house: 14_000, road: 12_000, border: 30_000, struct: 30_000, step: 50 };
    return { town: 40_000, house: 9_000, road: 7_000, border: 9_000, struct: 16_000, step: 22 };
  }

  /** No trees or grass on roads and in town centres. */
  /** Whether (x, z) (scene) lies on a structure's footprint. */
  structureAt(x: number, z: number): boolean {
    return this.footprints.some((fp) => Math.abs(x - fp.x) < fp.half && Math.abs(z - fp.z) < fp.half);
  }

  /** Keep a disc clear of props for the whole session (scene coords). */
  clearDisc(x: number, z: number, r: number): void {
    const f = this.frame;
    if (f) this.clearDiscs.push(x + f.offX, z + f.offZ, r);
  }

  keepOut = (x: number, z: number): boolean => {
    const f = this.frame;
    if (!f) return false;
    const ax = x + f.offX, az = z + f.offZ;
    for (let i = 0; i < this.clearDiscs.length; i += 3) {
      const dx = ax - this.clearDiscs[i], dz = az - this.clearDiscs[i + 1];
      if (dx * dx + dz * dz < this.clearDiscs[i + 2] * this.clearDiscs[i + 2]) return true;
    }
    const list = this.keepGrid.get(`${Math.floor(ax / 200)},${Math.floor(az / 200)}`);
    if (!list) return false;
    for (let i = 0; i < list.length; i += 3) {
      const dx = ax - list[i], dz = az - list[i + 1];
      if (dx * dx + dz * dz < list[i + 2] * list[i + 2]) return true;
    }
    return false;
  };

  private keep(ax: number, az: number, r: number): void {
    const k = `${Math.floor(ax / 200)},${Math.floor(az / 200)}`;
    let l = this.keepGrid.get(k);
    if (!l) this.keepGrid.set(k, (l = []));
    l.push(ax, az, r);
  }

  /**
   * Per frame. `x, z` = vehicle scene position. Rebuilds the layout when it moved enough or finer terrain arrived,
   * at most every 1.2 s; moves the trains every frame.
   */
  update(view: GameView, x: number, z: number, nowMs: number, alpha: number): void {
    const f = this.frame, g = this.ground;
    if (!f || !g) return;
    const ax = x + f.offX, az = z + f.offZ;
    const R = this.radii;
    const moved = Math.hypot(ax - this.lastAx, az - this.lastAz);
    const builtChanged = g.stats.built !== this.lastBuilt;
    const structSig = this.structSignature(view, ax, az);
    if ((moved > R.road * 0.12 || (builtChanged && nowMs - this.lastRebuild > 1200) || structSig !== this.lastStructSig || view.railRev !== this.lastRail) && nowMs - this.lastRebuild > 400) {
      const t0 = performance.now();
      this.rebuild(view, ax, az);
      this.lastAx = ax;
      this.lastAz = az;
      this.lastBuilt = g.stats.built;
      this.lastRebuild = nowMs;
      this.lastRail = view.railRev;
      this.lastStructSig = structSig;
      this.stats.rebuildMs = performance.now() - t0;
    }
    this.updateTrains(view, ax, az, alpha);
  }

  private structSignature(view: GameView, ax: number, az: number): string {
    const f = this.frame!;
    const R = this.radii.struct;
    let sig = '';
    const p = { x: 0, z: 0 };
    for (const s of view.structures.values()) {
      const ll = tileToLatLon(s.tile);
      f.absOf(ll.lat, ll.lon, p);
      if (Math.abs(p.x - ax) > R || Math.abs(p.z - az) > R) continue;
      sig += `${s.id}:${s.level}:${s.owner}:${s.built >= 1 ? 1 : 0}:${damageState(s.hp)}:${s.blocks ?? 0};`;
    }
    for (const r of view.ruins ?? []) sig += `r${r.tile};`;
    return sig;
  }

  // ---------------------------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------------------------
  private rebuild(view: GameView, ax: number, az: number): void {
    const f = this.frame!;
    const R = this.radii;
    this.keepGrid.clear();
    this.labels = [];
    this.houseList.length = 0;
    this.footprints.length = 0;
    this.group.position.set(0, 0, 0);
    // 1. Towns: real places and the sim's cities.
    const towns: Town[] = [];
    const ll0 = f.latLonOfAbs(ax, az, { lat: 0, lon: 0 });
    const dDeg = R.town / 111_000 + 0.2;
    const es = getLanguage() === 'es';
    const p = { x: 0, z: 0 };
    const human = view.players[HUMAN_ID];
    const capTile = human?.capitalTile ?? -1;
    for (const pl of PLACES) {
      if (Math.abs(pl.lat - ll0.lat) > dDeg) continue;
      if (placeKm(ll0.lat, ll0.lon, pl.lat, pl.lon) * 1000 > R.town) continue;
      f.absOf(pl.lat, pl.lon, p);
      const tile = tileAt(pl.lat, pl.lon);
      towns.push({
        key: `p:${pl.nameEn}`, name: es ? pl.nameEs : pl.nameEn || pl.nameEs, lat: pl.lat, lon: pl.lon, ax: p.x, az: p.z,
        r: pl.rank <= 1 ? 3200 : pl.rank === 2 ? 2000 : 1100, owner: view.owner[tile] ?? 0, capital: pl.rank === 1, level: 0, cityId: 0,
      });
    }
    for (const s of view.structures.values()) {
      if (s.type !== StructureType.City) continue;
      const ll = tileToLatLon(s.tile);
      f.absOf(ll.lat, ll.lon, p);
      if (Math.hypot(p.x - ax, p.z - az) > R.town) continue;
      // A City on a named place is that place, grown by its level.
      let merged = false;
      for (const tw of towns) {
        if (tw.key.startsWith('p:') && Math.hypot(tw.ax - p.x, tw.az - p.z) < 12_000) {
          tw.level = Math.max(tw.level, s.level);
          tw.r = Math.max(tw.r, 700 + 260 * s.level);
          tw.owner = s.owner;
          tw.cityId = s.id;
          if (s.tile === capTile) tw.capital = true;
          merged = true;
          break;
        }
      }
      if (merged) continue;
      const np = nearestPlace(ll.lat, ll.lon, 120);
      const name = np ? t('command.town.near', { place: es ? np.nameEs : np.nameEn || np.nameEs }) : t('command.town.unnamed');
      towns.push({ key: `c:${s.id}`, name, lat: ll.lat, lon: ll.lon, ax: p.x, az: p.z, r: 700 + 260 * s.level, owner: s.owner, capital: s.tile === capTile, level: s.level, cityId: s.id });
    }
    // Villages from the night lights: one candidate per 4 km cell (world-anchored), kept where people live.
    const V = 4000;
    const vr = Math.min(R.house * 1.6, 24_000);
    for (let cz = Math.floor((az - vr) / V); cz <= Math.floor((az + vr) / V); cz++) {
      for (let cx = Math.floor((ax - vr) / V); cx <= Math.floor((ax + vr) / V); cx++) {
        const h1 = hash(cx, cz), h2 = hash(cz * 3 + 7, cx * 5 - 1);
        const vx = (cx + 0.2 + h1 * 0.6) * V, vz = (cz + 0.2 + h2 * 0.6) * V;
        if (Math.hypot(vx - ax, vz - az) > vr) continue;
        const ll = f.latLonOfAbs(vx, vz, { lat: 0, lon: 0 });
        const light = sampleNightLights(ll.lat, ll.lon);
        // Dark land still has hamlets now and then; lit land has a village in most cells.
        if (hash(cx * 11 + 5, cz * 13 + 3) > 0.12 + light * 2.2) continue;
        if (towns.some((tw) => Math.hypot(tw.ax - vx, tw.az - vz) < tw.r + 1500)) continue;
        const tile = tileAt(ll.lat, ll.lon);
        towns.push({ key: `v:${cx},${cz}`, name: '', lat: ll.lat, lon: ll.lon, ax: vx, az: vz, r: 220 + Math.min(1, light * 3) * 380, owner: view.owner[tile] ?? 0, capital: false, level: -1, cityId: 0 });
      }
    }
    this.towns = towns;
    // 2. Roads: every town and village to its two nearest neighbours (deterministic), bases to their nearest town.
    const nodes = towns.map((tw) => ({ x: tw.ax, z: tw.az, key: tw.key }));
    const structs: { s: StructureView; x: number; z: number }[] = [];
    for (const s of view.structures.values()) {
      if (s.type === StructureType.City || s.built < 1) continue;
      const ll = tileToLatLon(s.tile);
      f.absOf(ll.lat, ll.lon, p);
      if (Math.hypot(p.x - ax, p.z - az) > R.struct) continue;
      structs.push({ s, x: p.x, z: p.z });
    }
    const edges = new Set<string>();
    const roads: [number, number, number, number, string][] = [];
    const link = (a: { x: number; z: number; key: string }, b: { x: number; z: number; key: string }) => {
      const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
      if (edges.has(k)) return;
      edges.add(k);
      roads.push([a.x, a.z, b.x, b.z, k]);
    };
    for (const a of nodes) {
      const near = nodes.filter((b) => b !== a).map((b) => ({ b, d: Math.hypot(b.x - a.x, b.z - a.z) })).sort((u, v) => u.d - v.d);
      for (const { b, d } of near.slice(0, 2)) if (d < 60_000) link(a, b);
    }
    for (const st of structs) {
      let best: { x: number; z: number; key: string } | null = null, bd = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - st.x, n.z - st.z);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      if (best && bd < 40_000) link({ x: st.x, z: st.z, key: `s:${st.s.id}` }, best);
    }
    // Drape the roads that come within reach (gentle deterministic meanders), and remember them for gates.
    const rib = new Ribbon();
    this.roadAbs = [];
    let roadN = 0;
    for (const [x0, z0, x1, z1, k] of roads) {
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 50) continue;
      if (segDist(ax, az, x0, z0, x1, z1) > R.road + 2000) continue;
      const seed = hashStr(k);
      const ux = (x1 - x0) / L, uz = (z1 - z0) / L;
      const nx = -uz, nz = ux;
      const amp = Math.min(900, L * 0.05);
      const abs: number[] = [];
      const pts: number[] = [];
      const step = R.step;
      for (let s = 0; s <= L; s += step) {
        const tt = s / L;
        const wob = Math.sin(tt * Math.PI) * (Math.sin(tt * 5.1 + seed * 6.28) * 0.6 + Math.sin(tt * 13.7 + seed * 3.1) * 0.25) * amp;
        const px = x0 + ux * s + nx * wob, pz = z0 + uz * s + nz * wob;
        abs.push(px, pz);
        if (Math.hypot(px - ax, pz - az) > R.road) {
          if (pts.length >= 6) {
            rib.add(pts, this.kind === 'jet' ? 14 : 7, 0.19, 0.19, 0.2);
            roadN++;
          }
          pts.length = 0;
          continue;
        }
        const sx = px - f.offX, sz = pz - f.offZ;
        const h = this.ground!.heightAt(sx, sz);
        if (h < 0.3) {
          if (pts.length >= 6) rib.add(pts, 7, 0.19, 0.19, 0.2);
          pts.length = 0;
          continue;
        }
        pts.push(sx, h + 0.25, sz);
        if (s % (step * 4) < step) this.keep(px, pz, 9);
      }
      if (pts.length >= 6) {
        rib.add(pts, this.kind === 'jet' ? 14 : 7, 0.19, 0.19, 0.2);
        roadN++;
      }
      this.roadAbs.push(abs);
    }
    this.setMesh('roads', rib.build());
    this.stats.roads = roadN;
    // 3. Houses of towns and villages within reach; town labels.
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0);
    let nh = 0;
    this.houseRecs.length = 0;
    this.fires = [];
    for (const tw of towns) {
      const d = Math.hypot(tw.ax - ax, tw.az - az);
      // A sim city's damage: its collapsed blocks (the one mask the strategic model draws too) and its state.
      const city = tw.cityId ? view.structures.get(tw.cityId) : undefined;
      const mask = city ? collapsedBlocks(city.id, city.hp, city.blocks ?? 0) : 0;
      const burnt = new Set<number>();
      if (tw.level >= 0 || tw.key.startsWith('p:')) {
        const sx = tw.ax - f.offX, sz = tw.az - f.offZ;
        const h = this.ground!.heightAt(sx, sz);
        const owner = view.players[tw.owner];
        this.labels.push({
          x: sx, y: Math.max(0, h) + (this.kind === 'jet' ? 250 : 60), z: sz, text: tw.name,
          sub: tw.capital ? t('command.label.capital') : tw.level > 0 ? t('command.label.cityLevel', { n: tw.level }) : '',
          kind: tw.capital ? 'capital' : tw.level > 0 ? 'city' : 'town', color: owner ? css(owner.color) : '#d8d8d8', owner: tw.owner,
        });
      }
      if (d - tw.r > R.house) continue;
      this.keep(tw.ax, tw.az, tw.r * 0.25);
      // Density falls off from the centre; the jet sees blocks, not single houses.
      const cell = this.kind === 'jet' ? 90 : tw.level < 0 ? 26 : 32;
      const n = Math.min(900, Math.floor((Math.PI * tw.r * tw.r) / (cell * cell) * 0.55));
      const seed = hashStr(tw.key);
      for (let i = 0; i < n && nh < MAX_HOUSES; i++) {
        const a = hash(seed, i * 2) * Math.PI * 2, rr = Math.pow(hash(seed + 7, i * 2 + 1), 0.8) * tw.r;
        const hx = tw.ax + Math.cos(a) * rr, hz = tw.az + Math.sin(a) * rr;
        if (Math.hypot(hx - ax, hz - az) > R.house) continue;
        const sx = hx - f.offX, sz = hz - f.offZ;
        const hgt = this.ground!.heightAt(sx, sz);
        if (hgt < 0.8) continue;
        const k = 1 - rr / tw.r;
        const big = this.kind === 'jet' ? 3.5 : 1;
        const w = (8 + hash(seed, i + 101) * 10 + k * 10) * big, dd = (7 + hash(seed, i + 202) * 8 + k * 8) * big;
        const hh = (5 + hash(seed, i + 303) * 4 + (tw.level > 2 ? k * k * 30 : k * 6)) * (this.kind === 'jet' ? 1.6 : 1);
        Q.setFromAxisAngle(UP, Math.round(hash(seed, i + 404) * 4) * (Math.PI / 2) + (a % 0.4));
        const block = Math.floor((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * CITY_BLOCKS) % CITY_BLOCKS;
        const key = `${tw.key}:${i}`;
        const down = this.downHouses.has(key) || ((mask >>> block) & 1) === 1;
        const rec: HouseRec = { key, x: sx, z: sz, y: hgt, r: Math.max(w, dd) * 0.5, h: hh, inst: nh, cityId: tw.cityId, block, owner: tw.owner, down };
        this.houseRecs.push(rec);
        this.setHouse(rec, w, dd, Q, hash(seed, i + 505));
        if (down && !burnt.has(block)) {
          // One fire (or a smoke column when the city is only damaged) per collapsed block.
          burnt.add(block);
          this.fires.push({ x: sx, y: hgt + 2, z: sz, heat: city && damageState(city.hp) >= 2 ? 0.8 : 0.35, size: 2.2 });
        }
        if (this.kind === 'tank' && !down && Math.hypot(hx - ax, hz - az) < 3000) this.houseList.push({ x: sx, z: sz, r: Math.max(w, dd) * 0.55 });
        nh++;
      }
    }
    this.houses.count = nh;
    this.regrid();
    this.houses.instanceMatrix.needsUpdate = true;
    if (this.houses.instanceColor) this.houses.instanceColor.needsUpdate = true;
    this.stats.houses = nh;
    this.stats.towns = towns.length;
    // 4. Structures with their real models and levels, and their names.
    this.structGroup.clear();
    this.structRecs.length = 0;
    this.rubbleN = 0;
    for (const st of structs) this.placeStructure(view, st.s, st.x, st.z);
    this.stats.structures = structs.length;
    this.placeRubble(view, ax, az);
    // 5. Borders and gates.
    this.buildBorders(view, ax, az);
    // 6. Rail lines.
    this.buildRails(view, ax, az);
  }

  private setMesh(which: 'roads' | 'borders' | 'rails', g: THREE.BufferGeometry): void {
    const old = this[which];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
    }
    const m = new THREE.Mesh(g, this.lineMat);
    m.name = `civil-${which}`;
    m.receiveShadow = true;
    m.frustumCulled = false;
    this.group.add(m);
    this[which] = m;
  }

  private placeStructure(view: GameView, s: StructureView, x: number, z: number): void {
    const f = this.frame!;
    const info = STRUCT_KM[s.type];
    if (!info) return;
    const owner = view.players[s.owner];
    const col = owner?.color ?? 0x888888;
    // Feedback 3 (#27): the damage state (shared/damage.ts). Fix pass 3: the compound is built at its real size in
    // metres (models/structures.ts: halls, chimneys, cranes, runway…), its buildings scorched or collapsed by the state
    // and its level, instead of the strategic icon model stretched to the footprint.
    const state = damageState(s.hp);
    const standing = standingShare(s.hp);
    const size = info.km * 1000 * (1 + 0.1 * (Math.max(1, Math.min(3, s.level)) - 1));
    const gkey = `${s.type}:${s.level}:${state}:${col}:${s.id}`;
    let geo = this.structGeos.get(gkey);
    let top = this.structTops.get(gkey) ?? info.tallM;
    let yScale = 1;
    if (!geo) {
      const cm = buildCmdStructure(s.type, s.level, state, size, col, s.id);
      if (cm) {
        geo = cm.geo;
        top = cm.top;
      } else {
        geo = buildStructModel(levelKey(info.key, s.level));
        const c = geo.getAttribute('aColor');
        if (c) geo.setAttribute('color', c);
        if (!geo.boundingBox) geo.computeBoundingBox();
      }
      this.structGeos.set(gkey, geo);
      this.structTops.set(gkey, top);
    }
    const real = this.structTops.has(gkey) && !geo.getAttribute('aColor');
    if (!real) {
      if (!geo.boundingBox) geo.computeBoundingBox();
      yScale = (info.tallM / Math.max(0.02, geo.boundingBox!.max.y)) * Math.max(0.3, standing);
    }
    let mat = this.structMats.get(real ? 0 : col * 4 + state);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.05 });
      if (!real && state === 1) mat.color.setRGB(0.68, 0.64, 0.6);
      else if (!real && state >= 2) mat.color.setRGB(0.4, 0.35, 0.31);
      this.structMats.set(real ? 0 : col * 4 + state, mat);
    }
    const sx = x - f.offX, sz = z - f.offZ;
    // Ground the footprint: stand at the middle height of the footprint (the model's own apron hides the rest) with a
    // pad down to the lowest point so nothing floats on a slope.
    const hs: number[] = [];
    for (const [u, v] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45], [0, 0], [0, -0.3], [0, 0.3], [-0.3, 0], [0.3, 0]]) {
      hs.push(this.ground!.heightAt(sx + u * size, sz + v * size));
    }
    hs.sort((a, b) => a - b);
    const hmin = hs[0];
    const base = Math.max(0.5, hs[Math.floor(hs.length / 2)]);
    this.footprints.push({ x: sx, z: sz, half: size * 0.5 });
    const rotY = Math.round(hash(s.id, 17) * 4) * (Math.PI / 2);
    if (real && geo.userData.draped !== this.ground!.stats.built) this.drapeModel(geo, sx, sz, base, rotY);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(sx, base, sz);
    m.rotation.y = rotY;
    if (real) m.scale.set(1, 1, 1);
    else m.scale.set(size, yScale, size);
    const tallM = real ? top : info.tallM * Math.max(0.3, standing);
    this.structRecs.push({ id: s.id, type: s.type, owner: s.owner, x: sx, z: sz, half: size * 0.5, y0: hmin - 1, y1: base + tallM });
    if (state >= 1) {
      // Fires in the ruined buildings, spread over the compound (not one plume in the middle).
      const nF = state >= 2 ? 3 : 1;
      for (let i = 0; i < nF; i++) {
        const a = hash(s.id, 40 + i) * Math.PI * 2, rr = (i === 0 ? 0.1 : 0.3) * size;
        this.fires.push({ x: sx + Math.cos(a) * rr, y: base + 6, z: sz + Math.sin(a) * rr, heat: state >= 2 ? 0.9 : 0.3, size: Math.max(1.5, Math.min(4, size / 300)) });
      }
      this.addDebris(sx, sz, size * 0.5, state >= 2 ? 40 : 14, s.id, 0.7);
    }
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `struct-${s.id}`;
    this.structGroup.add(m);
    if (!real && base - hmin > 0.5) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(size * 0.96, base - hmin + 1, size * 0.96), PAD_MAT);
      pad.position.set(sx, (base + hmin) / 2 - 0.5, sz);
      pad.rotation.y = m.rotation.y;
      pad.receiveShadow = true;
      this.structGroup.add(pad);
    }
    this.keep(x, z, size * 0.55);
    const ll = tileToLatLon(s.tile);
    const np = nearestPlace(ll.lat, ll.lon, 80);
    const es = getLanguage() === 'es';
    const typeName = t(`structure.${STRUCT_ID[s.type]}`);
    this.labels.push({
      x: sx, y: base + tallM + 25, z: sz,
      text: np ? t('command.label.baseAt', { type: typeName, place: es ? np.nameEs : np.nameEn || np.nameEs }) : typeName,
      sub: state ? `${t('command.label.level', { n: s.level })} · ${t(`card.dmg.${DAMAGE_WORD[state]}`)}` : t('command.label.level', { n: s.level }), kind: 'base', color: css(col), owner: s.owner,
    });
  }

  /**
   * Fix pass 3: a compound model (models/structures.ts) set on the ground it stands on, once per built geometry: each
   * building rises from the ground under its own anchor (its footing goes down to the ground at every corner), and
   * aprons, runways and roads drape over the relief vertex by vertex. Model y is relative to `base` (the mesh's y).
   */
  private drapeModel(geo: THREE.BufferGeometry, sx: number, sz: number, base: number, rotY: number): void {
    const ranges = geo.userData.ranges as { n: number; ax: number; az: number; drape: boolean }[] | undefined;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    const g = this.ground;
    if (!ranges || !pos || !g) return;
    // From the model's own positions every time (finer terrain streams in under it: it is set again then).
    const orig = (geo.userData.orig as Float32Array | undefined) ?? (geo.userData.orig = Float32Array.from(pos.array as Float32Array));
    (pos.array as Float32Array).set(orig);
    const c = Math.cos(rotY), sn = Math.sin(rotY);
    // Model (x, z) → scene (x, z) for the mesh's rotation about y.
    const wx = (x: number, z: number) => sx + x * c + z * sn;
    const wz = (x: number, z: number) => sz - x * sn + z * c;
    let i = 0;
    for (const r of ranges) {
      if (r.drape) {
        for (let k = i; k < i + r.n; k++) {
          const x = pos.getX(k), z = pos.getZ(k);
          pos.setY(k, pos.getY(k) + g.heightAt(wx(x, z), wz(x, z)) - base);
        }
      } else {
        const off = g.heightAt(wx(r.ax, r.az), wz(r.ax, r.az)) - base;
        for (let k = i; k < i + r.n; k++) {
          const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
          // The footing: vertices at the bottom reach down to the ground under them (no building floats on a slope).
          const footing = y <= 0.6 ? Math.min(0, g.heightAt(wx(x, z), wz(x, z)) - base - off - 0.4) : 0;
          pos.setY(k, y + off + footing);
        }
      }
      i += r.n;
    }
    pos.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    geo.userData.draped = g.stats.built;
  }

  /** A house instance: standing, or a low scorched heap where it collapsed. */
  private setHouse(r: HouseRec, w: number, d: number, q: THREE.Quaternion, shade: number): void {
    const M = HM, P = HP, S = HS, C = HC;
    if (r.down) {
      S.set(w * 1.15, Math.min(2.2, r.h * 0.3), d * 1.15);
      C.setRGB(0.17 + shade * 0.05, 0.15 + shade * 0.04, 0.13 + shade * 0.03);
    } else {
      S.set(w, r.h, d);
      const v = 0.78 + shade * 0.3;
      C.setRGB(v, v * 0.96, v * 0.9);
    }
    P.set(r.x, r.y - 0.6, r.z);
    M.compose(P, q, S);
    this.houses.setMatrixAt(r.inst, M);
    this.houses.setColorAt(r.inst, C);
    HQ.copy(q);
    this.houseRot.set(r.inst, [q.x, q.y, q.z, q.w, w, d, shade]);
  }

  private readonly houseRot = new Map<number, number[]>();

  /** Knock a house down (a shell or bomb of command mode): it stays down for the session. */
  collapseHouse(r: HouseRec): void {
    if (r.down) return;
    r.down = true;
    this.downHouses.add(r.key);
    const k = this.houseRot.get(r.inst);
    if (k) {
      HQ.set(k[0], k[1], k[2], k[3]);
      this.setHouse(r, k[4], k[5], HQ, k[6]);
      this.houses.instanceMatrix.needsUpdate = true;
      if (this.houses.instanceColor) this.houses.instanceColor.needsUpdate = true;
    }
    const i = this.houseList.findIndex((h) => Math.abs(h.x - r.x) < 0.01 && Math.abs(h.z - r.z) < 0.01);
    if (i >= 0) this.houseList.splice(i, 1);
    this.fires.push({ x: r.x, y: r.y + 1.5, z: r.z, heat: 0.7, size: 1.4 });
  }

  /** Share of a city block's houses in the scene that are down (0..1), and how many houses it has here. */
  blockDown(cityId: number, block: number): { share: number; n: number } {
    let n = 0, d = 0;
    for (const r of this.houseRecs) {
      if (r.cityId !== cityId || r.block !== block) continue;
      n++;
      if (r.down) d++;
    }
    return { share: n ? d / n : 0, n };
  }

  private regrid(): void {
    this.houseGrid.clear();
    for (let i = 0; i < this.houseRecs.length; i++) {
      const r = this.houseRecs[i];
      const k = `${Math.floor(r.x / 100)},${Math.floor(r.z / 100)}`;
      let l = this.houseGrid.get(k);
      if (!l) this.houseGrid.set(k, (l = []));
      l.push(i);
    }
  }

  /**
   * The first structure or standing house the segment a→b enters (scene coords), with the entry point. Houses are
   * tested as boxes of their footprint radius and height; structures as their footprint up to their standing height.
   */
  hitTest(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): { house: HouseRec | null; struct: StructRec | null } | null {
    let bestT = Infinity;
    let house: HouseRec | null = null, struct: StructRec | null = null;
    const test = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number => {
      let t0 = 0, t1 = 1;
      const d = [b.x - a.x, b.y - a.y, b.z - a.z], o = [a.x, a.y, a.z], lo = [x0, y0, z0], hi = [x1, y1, z1];
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-9) {
          if (o[k] < lo[k] || o[k] > hi[k]) return Infinity;
          continue;
        }
        let ta = (lo[k] - o[k]) / d[k], tb = (hi[k] - o[k]) / d[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return Infinity;
      }
      return t0;
    };
    for (const r of this.structRecs) {
      const tt = test(r.x - r.half, r.x + r.half, r.y0, r.y1, r.z - r.half, r.z + r.half);
      if (tt < bestT) {
        bestT = tt;
        struct = r;
        house = null;
      }
    }
    // Houses: the grid cells along the segment.
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 60));
    const seen = new Set<number>();
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      const cx = Math.floor((a.x + (b.x - a.x) * f) / 100), cz = Math.floor((a.z + (b.z - a.z) * f) / 100);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const l = this.houseGrid.get(`${cx + dx},${cz + dz}`);
          if (!l) continue;
          for (const i of l) {
            if (seen.has(i)) continue;
            seen.add(i);
            const r = this.houseRecs[i];
            if (r.down) continue;
            const tt = test(r.x - r.r, r.x + r.r, r.y - 1, r.y + r.h - 0.6, r.z - r.r, r.z + r.r);
            if (tt < bestT) {
              bestT = tt;
              house = r;
              struct = null;
            }
          }
        }
      }
    }
    if (!Number.isFinite(bestT)) return null;
    out.copy(a).lerp(b, bestT);
    return { house, struct };
  }

  /** Houses within `radius` of a point (a bomb's blast). */
  housesNear(x: number, z: number, radius: number): HouseRec[] {
    const outL: HouseRec[] = [];
    const c = Math.ceil(radius / 100);
    const cx = Math.floor(x / 100), cz = Math.floor(z / 100);
    for (let dz = -c; dz <= c; dz++) {
      for (let dx = -c; dx <= c; dx++) {
        for (const i of this.houseGrid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const r = this.houseRecs[i];
          if (!r.down && Math.hypot(r.x - x, r.z - z) < radius + r.r) outL.push(r);
        }
      }
    }
    return outL;
  }

  private rubbleN = 0;
  /** Scattered scorched debris around a point (damaged structures, rubble piles). */
  private addDebris(x: number, z: number, radius: number, count: number, seed: number, scale: number): void {
    const M = HM, P = HP, S = HS, C = HC, Q = HQ;
    for (let i = 0; i < count && this.rubbleN < MAX_RUBBLE; i++) {
      const a = hash(seed, i * 3) * Math.PI * 2, rr = Math.sqrt(hash(seed + 5, i * 3 + 1)) * radius;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      const h = this.ground!.heightAt(px, pz);
      const k = (0.6 + hash(seed, i * 3 + 2) * 1.4) * scale;
      S.set(6 * k + hash(seed, i + 9) * 8 * k, 1.2 * k + hash(seed, i + 11) * 3 * k, 5 * k + hash(seed, i + 13) * 7 * k);
      Q.setFromAxisAngle(UPV, hash(seed, i + 17) * Math.PI);
      P.set(px, h - 0.3, pz);
      M.compose(P, Q, S);
      this.rubble.setMatrixAt(this.rubbleN, M);
      const g = 0.16 + hash(seed, i + 19) * 0.14;
      C.setRGB(g * 1.05, g, g * 0.92);
      this.rubble.setColorAt(this.rubbleN, C);
      this.rubbleN++;
    }
  }

  /** Rubble of destroyed structures in view (the sim's ruins), smoking for their first 2 game days. */
  private placeRubble(view: GameView, ax: number, az: number): void {
    const f = this.frame!;
    const p = { x: 0, z: 0 };
    for (const r of view.ruins ?? []) {
      const ll = tileToLatLon(r.tile);
      f.absOf(ll.lat, ll.lon, p);
      if (Math.hypot(p.x - ax, p.z - az) > this.radii.struct) continue;
      const info = STRUCT_KM[r.type];
      const size = (info?.km ?? 1.2) * 1000;
      const sx = p.x - f.offX, sz = p.z - f.offZ;
      this.addDebris(sx, sz, size * 0.45, 60, r.tile, 1.1);
      const y = this.ground!.heightAt(sx, sz);
      // Fix pass 3 (#27): the compound itself in ruins — every building a blackened heap with a wall stub, chimneys
      // broken, tanks burst — so the place still reads as what it was (a factory, a port) and plainly destroyed.
      const gkey = `ruin:${r.type}:${r.tile}`;
      let geo = this.structGeos.get(gkey);
      if (!geo) {
        const cm = buildCmdStructure(r.type, 1, 3, size, 0x4a4642, r.tile);
        if (cm) {
          geo = cm.geo;
          this.structGeos.set(gkey, geo);
          this.structTops.set(gkey, cm.top);
        }
      }
      if (geo) {
        let mat = this.structMats.get(-1);
        if (!mat) {
          mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
          mat.color.setRGB(0.62, 0.58, 0.55);
          this.structMats.set(-1, mat);
        }
        const rotY = Math.round(hash(r.tile, 17) * 4) * (Math.PI / 2);
        if (geo.userData.draped !== this.ground!.stats.built) this.drapeModel(geo, sx, sz, Math.max(0.5, y), rotY);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(sx, Math.max(0.5, y), sz);
        m.rotation.y = rotY;
        m.castShadow = m.receiveShadow = true;
        m.name = `ruin-${r.tile}`;
        this.structGroup.add(m);
      }
      if (view.tick - r.tick < 480) this.fires.push({ x: sx, y: y + 2, z: sz, heat: view.tick - r.tick < 120 ? 0.8 : 0.3, size: 3 });
      this.labels.push({
        x: sx, y: y + 30, z: sz, text: t('command.label.ruin', { type: t(`structure.${STRUCT_ID[r.type]}`) }),
        sub: r.by ? t('command.label.ruinBy', { nation: view.players[r.by] ? (view.players[r.by]!.name ?? '') : '' }) : '', kind: 'base', color: '#5a5048', owner: r.owner,
      });
    }
    this.rubble.count = this.rubbleN;
    this.rubble.instanceMatrix.needsUpdate = true;
    if (this.rubble.instanceColor) this.rubble.instanceColor.needsUpdate = true;
  }

  private buildBorders(view: GameView, ax: number, az: number): void {
    const f = this.frame!;
    const R = this.radii.border;
    const rib = new Ribbon();
    const ll = f.latLonOfAbs(ax, az, { lat: 0, lon: 0 });
    const tx = Math.floor(((ll.lon + 180) / 360) * MAP_W), ty = Math.floor(((90 - ll.lat) / 180) * MAP_H);
    const span = Math.ceil(R / (TILE_KM * 1000 * Math.max(0.2, Math.cos((ll.lat * Math.PI) / 180)))) + 1;
    const spanY = Math.ceil(R / (TILE_KM * 1000)) + 1;
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), C = new THREE.Color();
    let np = 0, km = 0, gates = 0;
    const own = (x: number, y: number) => (y < 0 || y >= MAP_H ? 0 : view.owner[y * MAP_W + (((x % MAP_W) + MAP_W) % MAP_W)] ?? 0);
    const a0 = { x: 0, z: 0 }, a1 = { x: 0, z: 0 };
    const edge = (lat0: number, lon0: number, lat1: number, lon1: number, oa: number, ob: number) => {
      f.absOf(lat0, lon0, a0);
      f.absOf(lat1, lon1, a1);
      const L = Math.hypot(a1.x - a0.x, a1.z - a0.z);
      if (L < 1 || segDist(ax, az, a0.x, a0.z, a1.x, a1.z) > R) return;
      // The colour of the other nation, seen from the human (or of the larger owner when neither is the human).
      const other = oa === HUMAN_ID ? ob : ob === HUMAN_ID ? oa : Math.max(oa, ob);
      const pc = view.players[other]?.color ?? 0xdddddd;
      C.setHex(pc);
      const pts: number[] = [];
      const step = this.kind === 'jet' ? 120 : 25;
      const flush = () => {
        if (pts.length >= 6) rib.add(pts, this.kind === 'jet' ? 30 : 3.5, C.r * 0.9, C.g * 0.9, C.b * 0.9);
        pts.length = 0;
      };
      for (let s = 0; s <= L; s += step) {
        const px = a0.x + ((a1.x - a0.x) * s) / L, pz = a0.z + ((a1.z - a0.z) * s) / L;
        if (Math.hypot(px - ax, pz - az) > R) {
          flush();
          continue;
        }
        const sx = px - f.offX, sz = pz - f.offZ;
        const h = this.ground!.heightAt(sx, sz);
        if (h < 0.2) {
          flush();
          continue;
        }
        pts.push(sx, h + 0.2, sz);
        km += step / 1000;
        // A post every 500 m, striped in the two nations' colours by alternation.
        if (this.kind !== 'jet' && Math.round(s) % 500 < step && np < MAX_POSTS) {
          P.set(sx, h, sz);
          M.compose(P, Q, S);
          this.posts.setMatrixAt(np, M);
          const c2 = view.players[np % 2 ? oa : ob]?.color ?? 0xeeeeee;
          this.posts.setColorAt(np, C.setHex(c2).multiplyScalar(1.1));
          C.setHex(pc);
          np++;
        }
      }
      flush();
      // Crossing gates where a road meets this border.
      if (this.kind !== 'jet') {
        for (const r of this.roadAbs) {
          for (let i = 0; i + 3 < r.length; i += 2) {
            const hit = segInter(r[i], r[i + 1], r[i + 2], r[i + 3], a0.x, a0.z, a1.x, a1.z);
            if (!hit || Math.hypot(hit[0] - ax, hit[1] - az) > R) continue;
            this.addGate(hit[0] - f.offX, hit[1] - f.offZ, Math.atan2(-(r[i + 2] - r[i]), -(r[i + 3] - r[i + 1])), pc);
            gates++;
          }
        }
      }
    };
    this.gateGroup.clear();
    for (let y = ty - spanY; y <= ty + spanY; y++) {
      for (let x = tx - span; x <= tx + span; x++) {
        const o = own(x, y);
        const oe = own(x + 1, y), os = own(x, y + 1);
        const lonE = ((x + 1) / MAP_W) * 360 - 180, lonW = (x / MAP_W) * 360 - 180;
        const latN = 90 - (y / MAP_H) * 180, latS = 90 - ((y + 1) / MAP_H) * 180;
        if (o !== oe && (o > 0 || oe > 0)) edge(latN, lonE, latS, lonE, o, oe);
        if (o !== os && (o > 0 || os > 0)) edge(latS, lonW, latS, lonE, o, os);
      }
    }
    this.posts.count = np;
    this.posts.instanceMatrix.needsUpdate = true;
    if (this.posts.instanceColor) this.posts.instanceColor.needsUpdate = true;
    this.setMesh('borders', rib.build());
    this.stats.borderKm = Math.round(km * 10) / 10;
    this.stats.posts = np;
    this.stats.gates = gates;
  }

  private readonly gateGroup = (() => {
    const g = new THREE.Group();
    g.name = 'border-gates';
    this.group.add(g);
    return g;
  })();

  private addGate(x: number, z: number, yaw: number, color: number): void {
    const h = this.ground!.heightAt(x, z);
    const g = new THREE.Group();
    const hut = new THREE.Mesh(GATE_HUT, GATE_MAT);
    hut.position.set(6, 1.4, 0);
    const bar = new THREE.Mesh(GATE_BAR, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    bar.position.set(0, 1.1, 0);
    const pole = new THREE.Mesh(GATE_POLE, GATE_MAT);
    pole.position.set(-4, 0.6, 0);
    g.add(hut, bar, pole);
    g.position.set(x, h, z);
    g.rotation.y = yaw + Math.PI / 2;
    this.gateGroup.add(g);
    const f = this.frame!;
    this.keep(x + f.offX, z + f.offZ, 14);
  }

  private buildRails(view: GameView, ax: number, az: number): void {
    const f = this.frame!;
    const R = this.radii.road * 1.2;
    const rib = new Ribbon();
    const rail = view.rail;
    const p0 = { x: 0, z: 0 }, p1 = { x: 0, z: 0 };
    for (let i = 0; i + 1 < rail.length; i += 2) {
      const a = view.structures.get(rail[i]), b = view.structures.get(rail[i + 1]);
      if (!a || !b) continue;
      const la = tileToLatLon(a.tile), lb = tileToLatLon(b.tile);
      f.absOf(la.lat, la.lon, p0);
      f.absOf(lb.lat, lb.lon, p1);
      const L = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (L < 10 || segDist(ax, az, p0.x, p0.z, p1.x, p1.z) > R) continue;
      const pts: number[] = [];
      const step = this.kind === 'jet' ? 150 : 30;
      const flush = () => {
        if (pts.length >= 6) rib.add(pts, this.kind === 'jet' ? 18 : 4.2, 0.28, 0.25, 0.22);
        pts.length = 0;
      };
      for (let s = 0; s <= L; s += step) {
        const px = p0.x + ((p1.x - p0.x) * s) / L, pz = p0.z + ((p1.z - p0.z) * s) / L;
        if (Math.hypot(px - ax, pz - az) > R) {
          flush();
          continue;
        }
        const sx = px - f.offX, sz = pz - f.offZ;
        const h = this.ground!.heightAt(sx, sz);
        if (h < 0.3) {
          flush();
          continue;
        }
        pts.push(sx, h + 0.35, sz);
        if (s % (step * 3) < step) this.keep(px, pz, 7);
      }
      flush();
    }
    this.setMesh('rails', rib.build());
  }

  /** Trains of the sim near the vehicle: a locomotive and wagons on the drawn line, at the train's interpolated place. */
  private updateTrains(view: GameView, ax: number, az: number, alpha: number): void {
    const f = this.frame!;
    const R = this.radii.road * 1.2;
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), C = new THREE.Color();
    const UP = new THREE.Vector3(0, 1, 0);
    let n = 0;
    const p = { x: 0, z: 0 };
    for (const u of view.units.values()) {
      if (u.type !== UnitType.Train || n >= MAX_TRAIN_CARS) continue;
      const x = u.prevX + (u.x - u.prevX) * alpha, y = u.prevY + (u.y - u.prevY) * alpha;
      f.absOf(90 - (y / MAP_H) * 180, (x / MAP_W) * 360 - 180, p);
      if (Math.hypot(p.x - ax, p.z - az) > R) continue;
      const yaw = -u.heading;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const owner = view.players[u.owner];
      for (let k = 0; k < 5 && n < MAX_TRAIN_CARS; k++) {
        const sx = p.x - fx * k * 19 - f.offX, sz = p.z - fz * k * 19 - f.offZ;
        const h = this.ground!.heightAt(sx, sz);
        Q.setFromAxisAngle(UP, yaw);
        P.set(sx, h + 0.35, sz);
        S.set(1, 1, 1);
        M.compose(P, Q, S);
        this.cars.setMatrixAt(n, M);
        C.setHex(k === 0 ? owner?.color ?? 0x884422 : 0x5a4a3a);
        this.cars.setColorAt(n, C);
        n++;
      }
    }
    this.cars.count = n;
    if (n) {
      this.cars.instanceMatrix.needsUpdate = true;
      if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;
    }
  }
}

const STRUCT_ID: Record<number, string> = {
  [StructureType.City]: 'city', [StructureType.Port]: 'port', [StructureType.Factory]: 'factory', [StructureType.DefensePost]: 'defensePost',
  [StructureType.SamSite]: 'samSite', [StructureType.MissileSilo]: 'missileSilo', [StructureType.Airbase]: 'airbase',
  [StructureType.ArmyBase]: 'armyBase', [StructureType.NavalYard]: 'navalYard', [StructureType.Radar]: 'radar',
};

const DAMAGE_WORD = ['intact', 'damaged', 'heavy', 'destroyed'] as const;
const MAX_RUBBLE = 1400;
const HM = new THREE.Matrix4(), HP = new THREE.Vector3(), HS = new THREE.Vector3(), HC = new THREE.Color(), HQ = new THREE.Quaternion();
const UPV = new THREE.Vector3(0, 1, 0);

const PAD_MAT = new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 0.95 });
const GATE_MAT = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.8 });
const GATE_HUT = new THREE.BoxGeometry(3, 2.8, 3);
const GATE_BAR = new THREE.BoxGeometry(8, 0.18, 0.18);
const GATE_POLE = new THREE.BoxGeometry(0.4, 1.2, 0.4);

function tileAt(lat: number, lon: number): number {
  const x = Math.floor(((lon + 180) / 360) * MAP_W) % MAP_W, y = Math.max(0, Math.min(MAP_H - 1, Math.floor(((90 - lat) / 180) * MAP_H)));
  return y * MAP_W + ((x + MAP_W) % MAP_W);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100003) / 100003;
}

function segDist(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0, dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const tt = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(px - x0 - dx * tt, pz - z0 - dz * tt);
}

function segInter(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const r1x = bx - ax, r1z = bz - az, r2x = dx - cx, r2z = dz - cz;
  const den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return null;
  const u = ((cx - ax) * r2z - (cz - az) * r2x) / den;
  const v = ((cx - ax) * r1z - (cz - az) * r1x) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [ax + r1x * u, az + r1z * u];
}
