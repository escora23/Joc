// FRONT ULTRA — shared HUD state (owner: ui): attack ratio, interaction mode, selection, hover, and a tiny
// local signal so HUD widgets react to each other without a framework.

import type { GameContext } from '../../shared/api';
import { HUMAN_ID, MAP_W, STRUCTURE_DEFS, TILE_COUNT } from '../../shared/constants';
import type { UiSoundKind, WorldPointerEvent } from '../../shared/events';
import { playerName } from '../../shared/i18n';
import { isNavigableTerrain, isPlayableTerrain } from '../../shared/terrain';
import type { PlayerView, StructureType, WeaponType } from '../../shared/types';

export type Mode =
  | { kind: 'none' }
  | { kind: 'build'; structure: StructureType }
  | { kind: 'target'; weapon: WeaponType }
  | { kind: 'order'; unitId: number };

export type Selection =
  | { kind: 'none' }
  | { kind: 'unit'; id: number }
  | { kind: 'structure'; id: number }
  | { kind: 'nation'; id: number };

export type HudSignal = 'mode' | 'selection' | 'ratio' | 'radial' | 'layout';

export interface HoverInfo {
  tile: number;
  unitId: number;
  structureId: number;
  clientX: number;
  clientY: number;
  shift: boolean;
  /** Small-island marker line under the pointer (DESIGN_V2 §10.6), when any. */
  islandLabel?: string;
}

export class HudShared {
  attackRatio = 0.3;
  mode: Mode = { kind: 'none' };
  selection: Selection = { kind: 'none' };
  hover: HoverInfo = { tile: -1, unitId: -1, structureId: -1, clientX: -1, clientY: -1, shift: false };
  radialOpen = false;
  /** Tutorial bookkeeping. */
  flags = { ratioChanged: false, radialOpened: false, commandEntered: false, proposalSent: false, proposalAnswered: false, nationsOpened: false, speedUnderstood: false };
  private listeners = new Map<HudSignal, Set<() => void>>();
  /** v2 (W3): open the nations drawer (on a nation's detail) / the inbox; set by the HUD assembly. */
  openNations: (id?: number) => void = () => undefined;
  openInbox: (proposalId?: number) => void = () => undefined;

  constructor(readonly ctx: GameContext, readonly sound: (k: UiSoundKind) => void) {}

  on(sig: HudSignal, fn: () => void): () => void {
    let set = this.listeners.get(sig);
    if (!set) {
      set = new Set();
      this.listeners.set(sig, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(sig: HudSignal): void {
    const set = this.listeners.get(sig);
    if (set) for (const fn of set) fn();
  }

  setAttackRatio(v: number): void {
    const r = Math.min(1, Math.max(0.01, Math.round(v * 100) / 100));
    if (r === this.attackRatio) return;
    this.attackRatio = r;
    this.flags.ratioChanged = true;
    this.emit('ratio');
  }

  setMode(m: Mode): void {
    const prev = this.mode;
    this.mode = m;
    const bus = this.ctx.bus;
    if (prev.kind === 'build' && m.kind !== 'build') bus.emit('buildPreview', { structure: -1, tile: -1, valid: false });
    if (prev.kind === 'target' && m.kind !== 'target') bus.emit('targetPreview', { weapon: null, tile: -1, innerRadius: 0, outerRadius: 0, valid: false });
    if (prev.kind === 'order' && m.kind !== 'order') bus.emit('orderPreview', { unitId: -1, unit: -1, tile: -1, valid: false });
    this.emit('mode');
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.ctx.bus.emit('selectionChanged', {
      unitIds: sel.kind === 'unit' ? [sel.id] : [],
      structureId: sel.kind === 'structure' ? sel.id : -1,
    });
    this.emit('selection');
  }

  setHover(e: WorldPointerEvent): void {
    const hv = this.hover;
    hv.tile = e.tile;
    hv.unitId = e.unitId;
    hv.structureId = e.structureId;
    hv.clientX = e.clientX;
    hv.clientY = e.clientY;
    hv.shift = e.shift;
    hv.islandLabel = e.islandLabel;
  }

  // ---- queries ----------------------------------------------------------------------------------

  get human(): PlayerView | null {
    return this.ctx.sim.view.human;
  }

  name(id: number): string {
    const p = this.ctx.sim.view.players[id];
    return p ? playerName(p, this.ctx.sim.view.world) : '';
  }

  isAlly(id: number): boolean {
    const hu = this.human;
    return !!hu && hu.allies.includes(id);
  }

  /** Human structures of a type (operational only by default). Cached per applied sim update. */
  ownStructures(type: StructureType, operationalOnly = true): number {
    const view = this.ctx.sim.view;
    const c = this.sCache;
    if (c.tick !== view.tick || c.size !== view.structures.size || c.units !== view.units.size) {
      c.tick = view.tick;
      c.size = view.structures.size;
      c.units = view.units.size;
      c.op.fill(0);
      c.all.fill(0);
      c.unitCount.fill(0);
      for (const s of view.structures.values()) {
        if (s.owner !== HUMAN_ID) continue;
        c.all[s.type]++;
        if (s.built >= 1) c.op[s.type]++;
      }
      for (const u of view.units.values()) if (u.owner === HUMAN_ID) c.unitCount[u.type]++;
    }
    return operationalOnly ? c.op[type] : c.all[type];
  }

  /** Human units of a type (same cache as ownStructures). */
  ownUnits(type: number): number {
    this.ownStructures(0 as StructureType);
    return this.sCache.unitCount[type] ?? 0;
  }
  private sCache = { tick: -1, size: -1, units: -1, op: new Int32Array(16), all: new Int32Array(16), unitCount: new Int32Array(32) };

  /** Client-side mirror of the sim's build rules (preview only; the sim stays authoritative). */
  buildError(type: StructureType, tile: number): string | null {
    const view = this.ctx.sim.view;
    const world = view.world;
    if (!world || tile < 0 || tile >= TILE_COUNT) return 'msg.cannotBuild';
    if (view.owner[tile] !== HUMAN_ID || !isPlayableTerrain(world.terrain[tile])) return 'msg.buildOwnLand';
    if (STRUCTURE_DEFS[type].coastal && !this.isCoastal(tile)) return 'msg.buildCoastal';
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    for (const s of view.structures.values()) {
      if (s.tile === tile) return 'msg.buildOccupied';
      let dx = Math.abs((s.tile % MAP_W) - x);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      const dy = ((s.tile / MAP_W) | 0) - y;
      if (dx * dx + dy * dy < 9) return 'msg.buildTooClose';
    }
    for (const sc of view.scars) {
      const dx = sc.x - (x + 0.5), dy = sc.y - (y + 0.5);
      if (sc.strength > 0.05 && dx * dx + dy * dy < sc.radius * sc.radius) return 'msg.buildFallout';
    }
    if ((view.human?.gold ?? 0) < view.structureCost(type)) return 'msg.notEnoughGold';
    return null;
  }

  isCoastal(tile: number): boolean {
    // Same rule as the sim (sim/water.ts): a land tile 4-adjacent to navigable open water.
    const world = this.ctx.sim.view.world;
    if (!world) return false;
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    const nav = (t: number) => isNavigableTerrain(world.terrain[t]) && (world.terrain[t] & 0x0f) <= 1;
    return nav(y * MAP_W + ((x + MAP_W - 1) % MAP_W)) || nav(y * MAP_W + ((x + 1) % MAP_W))
      || (y > 0 && nav(tile - MAP_W)) || (y < world.height - 1 && nav(tile + MAP_W));
  }

  /** True when the human owns a tile 4-adjacent to one owned by `target` (0 = unclaimed playable land). */
  borders(target: number): boolean {
    const view = this.ctx.sim.view;
    const now = performance.now();
    const c = this.borderCache.get(target);
    if (c && now - c.at < 800 && c.tick === view.tick) return c.v;
    const own = view.owner;
    const world = view.world;
    let v = false;
    if (world) {
      const terr = world.terrain;
      const W = MAP_W, N = TILE_COUNT;
      const hit = (j: number) => own[j] === target && (target !== 0 || isPlayableTerrain(terr[j]));
      for (let i = 0; i < N && !v; i++) {
        if (own[i] !== HUMAN_ID) continue;
        const x = i % W;
        const l = x === 0 ? i + W - 1 : i - 1;
        const r = x === W - 1 ? i - W + 1 : i + 1;
        if (hit(l) || hit(r) || (i >= W && hit(i - W)) || (i + W < N && hit(i + W))) v = true;
      }
    }
    this.borderCache.set(target, { at: now, tick: view.tick, v });
    return v;
  }
  private borderCache = new Map<number, { at: number; tick: number; v: boolean }>();

  /** Nearest shore land tile owned by `owner` around `tile` (for naval invasions), -1 if none within r. */
  nearestShoreOf(owner: number, tile: number, r = 24): number {
    const view = this.ctx.sim.view;
    const world = view.world;
    if (!world) return -1;
    const x0 = tile % MAP_W, y0 = (tile / MAP_W) | 0;
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= world.height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dy * dy;
        if (d >= bd || d > r * r) continue;
        const t = y * MAP_W + ((x0 + dx + MAP_W) % MAP_W);
        if (view.owner[t] !== owner || !isPlayableTerrain(world.terrain[t])) continue;
        if (!this.isCoastal(t)) continue;
        bd = d;
        best = t;
      }
    }
    return best;
  }
}
