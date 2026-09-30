// FRONT ULTRA — shared readings of naval warfare for the HUD (owner item 30; owner: ui). The blockade dialog, the
// Guerra panel's «Mar» tab, the map chips, the port card and the alerts all name blockades, specs and ships the same
// way, from the same rule set as the sim (shared/naval.ts).

import { HUMAN_ID, MAP_W, PORT_TRADE_GOLD_PER_HOUR, UNIT_DEFS, structureLevel } from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import {
  BLOCKADE_RADIUS_TILES, CHOKEPOINTS, blockadeApplies, chokepointNear, chokepointTile, pathCrossesZone,
  type BlockadeRelations, type BlockadeSpec, type BlockadeView,
} from '../../shared/naval';
import { StructureType, UnitType, type UnitView } from '../../shared/types';
import type { GameView } from '../../shared/api';
import { describeXY } from '../places';
import type { HudShared } from './shared';

/** The relations a blockade filter reads, from the client's view. */
export function viewRelations(view: GameView): BlockadeRelations {
  return {
    atWar: (a, b) => view.pairState(a, b) === 'war',
    allied: (a, b) => view.players[a]?.allies.includes(b) ?? false,
    embargoes: (a, b) => view.players[a]?.embargoes.includes(b) ?? false,
  };
}

/** A blockade's place: «el estrecho de Gibraltar», «el puerto de Nápoles», «la ruta frente a Orán». */
export function blockadePlace(hs: HudShared, b: { kind: BlockadeView['kind']; key?: string; portId?: number; x: number; y: number }): string {
  const view = hs.ctx.sim.view;
  if (b.kind === 'strait' && b.key) return t(`naval.cp.${b.key}`);
  if (b.kind === 'port' && b.portId) {
    const s = view.structures.get(b.portId);
    if (s) return t('naval.place.port', { place: describeXY(view, (s.tile % MAP_W) + 0.5, Math.floor(s.tile / MAP_W) + 0.5).name, name: hs.name(s.owner) });
  }
  return t('naval.place.sea', { place: describeXY(view, b.x, b.y).text });
}

/** Whom a spec stops, in one line: «solo naciones en guerra contigo · todos los barcos · abordar». */
export function specText(hs: HudShared, s: BlockadeSpec): string {
  const who = s.who === 'list' ? t('naval.who.listNames', { names: (s.nations ?? []).map((n) => hs.name(n)).join(', ') || '—' }) : t(`naval.who.${s.who}.short`);
  return t('naval.spec.line', { who, ships: t(`naval.ships.${s.ships}.short`), action: t(`naval.action.${s.action}.short`) });
}

/** What passes through a zone now: per nation, merchants (with the trade gold per hour they carry) and troop convoys. */
export interface ShipsThrough {
  owner: number;
  trade: number;
  tradeGoldH: number;
  convoys: number;
  troops: number;
  ids: number[];
}

/** Trade gold per hour a merchant earns its port (its slot of the port's rate). */
export function merchantRate(view: GameView, u: UnitView): number {
  const home = view.structures.get(u.home);
  const lv = Math.max(1, Math.min(3, home?.level ?? 1));
  const ships = structureLevel(StructureType.Port, lv).tradeShips ?? 2 * lv;
  return PORT_TRADE_GOLD_PER_HOUR[lv] / ships;
}

/** Index of the route waypoint nearest to the unit (the part ahead of it starts there). */
function routeIndex(route: Int32Array, x: number, y: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < route.length; i++) {
    const tx = (route[i] % MAP_W) + 0.5, ty = Math.floor(route[i] / MAP_W) + 0.5;
    let dx = Math.abs(tx - x);
    if (dx > MAP_W / 2) dx = MAP_W - dx;
    const d = dx * dx + (ty - y) * (ty - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return Math.min(route.length - 1, best + 1);
}

/** Merchants and convoys whose route ahead crosses the zone at (x, y) now, by owner (the human's own excluded). */
export function shipsThrough(view: GameView, x: number, y: number, r = BLOCKADE_RADIUS_TILES): ShipsThrough[] {
  const by = new Map<number, ShipsThrough>();
  for (const u of view.units.values()) {
    if (u.type !== UnitType.TradeShip && u.type !== UnitType.TransportShip) continue;
    if (u.owner === HUMAN_ID) continue;
    const route = view.routes.get(u.id);
    let crosses = false;
    if (route && route.length > 1) crosses = pathCrossesZone(route, routeIndex(route, u.x, u.y), u.x, u.y, x, y, r);
    else crosses = pathCrossesZone([Math.floor(u.targetY) * MAP_W + ((Math.floor(u.targetX) % MAP_W) + MAP_W) % MAP_W], 0, u.x, u.y, x, y, r);
    if (!crosses) continue;
    let s = by.get(u.owner);
    if (!s) by.set(u.owner, (s = { owner: u.owner, trade: 0, tradeGoldH: 0, convoys: 0, troops: 0, ids: [] }));
    s.ids.push(u.id);
    if (u.type === UnitType.TradeShip) {
      s.trade++;
      s.tradeGoldH += merchantRate(view, u);
    } else {
      s.convoys++;
      s.troops += u.troops;
    }
  }
  return [...by.values()].sort((a, b) => b.trade + b.convoys * 2 - (a.trade + a.convoys * 2));
}

/** The human's merchants whose route ahead crosses the zone (its own exposure to a blockade there). */
export function ownShipsThrough(view: GameView, x: number, y: number): number {
  let n = 0;
  for (const u of view.units.values()) {
    if (u.owner !== HUMAN_ID || u.type !== UnitType.TradeShip) continue;
    const route = view.routes.get(u.id);
    if (route && route.length > 1 && pathCrossesZone(route, routeIndex(route, u.x, u.y), u.x, u.y, x, y, BLOCKADE_RADIUS_TILES)) n++;
  }
  return n;
}

/** The human's trade gold per hour with nation `p` (its merchants to their ports, theirs to ours: our share). */
export function tradeWith(view: GameView, p: number): number {
  let g = 0;
  for (const u of view.units.values()) {
    if (u.type !== UnitType.TradeShip) continue;
    const to = view.ownerAt(Math.floor(u.targetY) * MAP_W + ((Math.floor(u.targetX) % MAP_W) + MAP_W) % MAP_W);
    if (u.owner === HUMAN_ID && to === p) g += merchantRate(view, u);
    else if (u.owner === p && to === HUMAN_ID) g += merchantRate(view, u) * 0.5;
  }
  return g;
}

/** Does blockade spec `s` of the human stop ships of `owner` of this kind? */
export function humanStops(view: GameView, s: BlockadeSpec, owner: number, kind: 'trade' | 'transport'): boolean {
  return blockadeApplies(viewRelations(view), HUMAN_ID, s, owner, kind);
}

/** Blockades that stop the human's ships (standing ones). */
export function blockadesAgainstHuman(view: GameView): BlockadeView[] {
  const rel = viewRelations(view);
  return view.blockades.filter((b) => !b.endTick && b.owner !== HUMAN_ID && (blockadeApplies(rel, b.owner, b.spec, HUMAN_ID, 'trade') || blockadeApplies(rel, b.owner, b.spec, HUMAN_ID, 'transport')));
}

/** The strait (or port) a click near it would blockade: its zone centre and name. */
export function zoneAt(hs: HudShared, tile: number): { kind: BlockadeView['kind']; key?: string; portId?: number; x: number; y: number } {
  const view = hs.ctx.sim.view;
  const x = (tile % MAP_W) + 0.5, y = Math.floor(tile / MAP_W) + 0.5;
  const cp = chokepointNear(x, y);
  if (cp) {
    const ct = chokepointTile(cp);
    return { kind: 'strait', key: cp.key, x: (ct % MAP_W) + 0.5, y: Math.floor(ct / MAP_W) + 0.5 };
  }
  let port = 0, bd = BLOCKADE_RADIUS_TILES * BLOCKADE_RADIUS_TILES;
  for (const s of view.structures.values()) {
    if (s.type !== StructureType.Port || s.owner === HUMAN_ID) continue;
    const sx = (s.tile % MAP_W) + 0.5, sy = Math.floor(s.tile / MAP_W) + 0.5;
    let dx = Math.abs(sx - x);
    if (dx > MAP_W / 2) dx = MAP_W - dx;
    const d = dx * dx * Math.cos(((90 - (y / 800) * 180) * Math.PI) / 180) ** 2 + (sy - y) * (sy - y);
    if (d < bd) {
      bd = d;
      port = s.id;
    }
  }
  return port ? { kind: 'port', portId: port, x, y } : { kind: 'sea', x, y };
}

/** Km/h of merchants (a detour's hours in the preview). */
export const MERCHANT_KMH = UNIT_DEFS[UnitType.TradeShip].speedKmh;

/** «4 apresados · 1 hundido · 3 desviados» (the counts that are not zero). */
export function stopsText(b: { seized: number; sunk: number; turnedBack: number; rerouted: number; passed: number }): string {
  const parts: string[] = [];
  if (b.seized) parts.push(t('naval.n.seized', { n: b.seized }));
  if (b.sunk) parts.push(t('naval.n.sunk', { n: b.sunk }));
  if (b.turnedBack) parts.push(t('naval.n.turnedBack', { n: b.turnedBack }));
  if (b.rerouted) parts.push(t('naval.n.rerouted', { n: b.rerouted }));
  if (b.passed) parts.push(t('naval.n.passed', { n: b.passed }));
  return parts.length ? parts.join(' · ') : t('naval.n.none');
}

export const gold = (v: number): string => formatNumber(Math.round(v));

export { CHOKEPOINTS, chokepointTile };
