// FRONT ULTRA — what a unit or a structure is doing, in words and numbers (DESIGN_V2 §6, §7.5, §7.6; owner: ui, W4).
//
// One vocabulary for the Fuerzas panel, the unit and structure cards, the order chip and the tooltips: names with
// ordinals, state lines with their ETA in game hours and real seconds, where a unit is, what it adds to the war right
// now, its speed with the real-time equivalent, its reach and its endurance; the effects of a structure at its level and
// at the next one. Every number comes from UNIT_DEFS / STRUCTURE_LEVELS and the sim's published state.

import type { HudShared } from './shared';
import { unitLabel } from './news';
import { describeXY } from '../places';
import {
  ARMOR_RAIL_KMH, BOMBARD_ATTACK_MUL, BOMBER_DIRECT_DMG, BOMBER_DIVISION_DMG, CAP_HIT_AIRCRAFT, CAP_RADIUS_TILES, DIVISION_ATTACH_TILES,
  DIVISION_FIELD_REPAIR, DIVISION_WEAR_ENGAGED, DRONE_ADVANCE_MUL, DRONE_DIRECT_DMG, DRONE_SUPPORT_TILES, HUMAN_ID,
  PORT_TRADE_GOLD_PER_HOUR, RADAR_SAM_RANGE_MUL, RADAR_SCRAMBLE_MUL, RAIL_GOLD_PER_HOUR, REARM_TICKS, STRUCTURE_DEFS,
  STRUCTURE_LEVELS, TILE_KM, UNIT_DEFS, WARSHIP_BOMBARD_TILES, WARSHIP_ENGAGE_TILES, structureLevel, upgradeCost, upgradeTicks,
} from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import { isForce, reachKm } from '../../shared/orders';
import {
  StructureType, UnitMode, UnitType, UNIT_ORDER_KINDS, type StructureView, type UnitView,
} from '../../shared/types';

export const STRUCT_IDS = ['city', 'port', 'factory', 'defensePost', 'samSite', 'missileSilo', 'airbase', 'armyBase', 'navalYard', 'radar'];
export const structId = (s: number): string => STRUCT_IDS[s] ?? 'city';
export const unitId = (u: number): string => UNIT_DEFS[u as UnitType]?.id ?? 'armoredDivision';

/** Units the Fuerzas panel lists (the count the acceptance compares with view.units minus missiles, trade, trains). */
export function isListedForce(u: UnitView): boolean {
  return u.owner === HUMAN_ID && isForce(u.type);
}

export type Domain = 'land' | 'air' | 'sea';
export function domainOf(type: UnitType): Domain {
  if (type === UnitType.ArmoredDivision) return 'land';
  if (type === UnitType.FighterSquadron || type === UnitType.Bomber || type === UnitType.DroneSwarm) return 'air';
  return 'sea';
}

/** Group of the Fuerzas panel (§7.5). */
export type ForceGroup = 'combat' | 'moving' | 'patrol' | 'base' | 'production';
export function groupOf(u: UnitView): ForceGroup {
  switch (u.mode) {
    case UnitMode.Front:
    case UnitMode.Offensive:
    case UnitMode.Engaged:
    case UnitMode.Intercept:
    case UnitMode.Strike:
    case UnitMode.Bombard:
    case UnitMode.Blockade:
    case UnitMode.Support:
      return 'combat';
    case UnitMode.Moving:
    case UnitMode.Rail:
    case UnitMode.Returning:
    case UnitMode.Escort:
    case UnitMode.Embarking:
      return 'moving';
    case UnitMode.Patrol:
      return 'patrol';
    default:
      return 'base';
  }
}

export const MODE_IDS: Record<number, string> = {
  [UnitMode.Idle]: 'idle', [UnitMode.Moving]: 'moving', [UnitMode.Rail]: 'rail', [UnitMode.Front]: 'front',
  [UnitMode.Offensive]: 'offensive', [UnitMode.Returning]: 'returning', [UnitMode.Docked]: 'docked',
  [UnitMode.Rearming]: 'rearming', [UnitMode.Patrol]: 'patrol', [UnitMode.Intercept]: 'intercept',
  [UnitMode.Escort]: 'escort', [UnitMode.Strike]: 'strike', [UnitMode.Support]: 'support', [UnitMode.Blockade]: 'blockade',
  [UnitMode.Bombard]: 'bombard', [UnitMode.Embarking]: 'embarking', [UnitMode.Engaged]: 'engaged',
};

/** «1.ª División acorazada» (or the type when unnamed). */
export function unitName(u: UnitView): string {
  return unitLabel(u.type, u.serial);
}

/**
 * Name of a front by its key: «Frente de Lyon» / «Lyon front». Where no place is near, the label is built from the
 * bearing phrase instead: «Frente de la zona situada a 370 km al NO de Madrid» / «Front 370 km NW of Madrid» (never
 * «the area 370 km NW of Madrid front»).
 */
export function frontName(hs: HudShared, key: number): string {
  if (!key) return '';
  const f = hs.ctx.sim.view.frontByKey.get(key);
  if (!f) return '';
  const p = describeXY(hs.ctx.sim.view, f.x, f.y);
  if (p.named && p.name !== t('place.yourCapital')) return t('front.name', { place: p.name });
  return t('front.nameAt', { name: p.name, where: p.text });
}

/** Game hours + real seconds at the current clock: «6 h (6 s a 1x)». */
export function etaText(hs: HudShared, ticks: number, withReal = true): string {
  if (ticks < 0) return '';
  const hours = ticks / 10;
  const h = hours < 1 ? t('eta.lessHour') : t('eta.hours', { n: formatNumber(hours, hours < 10 ? 1 : 0) });
  if (!withReal) return h;
  const view = hs.ctx.sim.view;
  const rate = view.clock?.rate ?? 3600;
  const speed = view.speed || 1;
  const sec = rate > 0 ? (hours * 3600) / rate : hours / speed;
  const sx = speed === 0.5 ? '0,5' : String(speed);
  return t('eta.withReal', { h, s: formatNumber(sec, sec < 10 ? 1 : 0), speed: rate > 0 && view.clock.mode !== 'strategic' ? t(`clockMode.${view.clock.mode}`) : `${sx}x` });
}

/** Where the unit is: «cerca de Zaragoza (España)». */
export function placeOf(hs: HudShared, u: UnitView): string {
  return describeXY(hs.ctx.sim.view, u.x, u.y).text;
}

/** «→ Frente de Lyon · 6 h» — the state line of a row and a card. */
export function stateLine(hs: HudShared, u: UnitView): string {
  const view = hs.ctx.sim.view;
  const mode = t(`fmode.${MODE_IDS[u.mode] ?? 'idle'}`);
  const eta = u.etaTicks > 0 ? etaText(hs, u.etaTicks, false) : '';
  const front = frontName(hs, u.frontKey);
  const dest = () => describeXY(view, u.targetX, u.targetY).name;
  switch (u.mode) {
    case UnitMode.Moving:
    case UnitMode.Rail:
    case UnitMode.Returning:
      return t('fstate.to', { mode, place: u.mode === UnitMode.Returning ? homeName(hs, u) : front || dest(), eta });
    case UnitMode.Front:
    case UnitMode.Offensive:
      return front ? t('fstate.at', { mode, place: front }) : mode;
    case UnitMode.Strike:
      return t('fstate.to', { mode, place: dest(), eta });
    case UnitMode.Patrol:
    case UnitMode.Support:
    case UnitMode.Blockade:
    case UnitMode.Bombard:
      return t('fstate.over', { mode, place: u.mode === UnitMode.Support && front ? front : dest() });
    case UnitMode.Rearming:
      return t('fstate.eta', { mode, eta });
    case UnitMode.Docked:
      return t('fstate.at', { mode, place: homeName(hs, u) });
    case UnitMode.Embarking:
      return t('fstate.eta', { mode, eta });
    default:
      return mode;
  }
}

export function homeName(hs: HudShared, u: UnitView): string {
  const s = hs.ctx.sim.view.structures.get(u.home);
  if (!s) return t('fstate.noBase');
  return structureName(hs, s);
}

/** «Base aérea de Zaragoza». */
export function structureName(hs: HudShared, s: StructureView): string {
  const view = hs.ctx.sim.view;
  const x = (s.tile % 1600) + 0.5, y = Math.floor(s.tile / 1600) + 0.5;
  return t('structure.named', { s: t(`structure.${structId(s.type)}`), place: describeXY(view, x, y).name });
}

/**
 * Speed line (§7.6): «40 km/h ≈ 40 km por segundo a 1x»; aircraft «misión 400 km/h (crucero 850 km/h)». A division
 * travelling by rail (§2.3) moves at 100 km/h: «100 km/h en tren (40 km/h por carretera)», so the card agrees with the
 * rail ETA it shows. `rail` is the unit's current mode (UnitMode.Rail); build/catalogue cards pass nothing.
 */
export function speedLine(type: UnitType, rail = false): string {
  const d = UNIT_DEFS[type];
  if (d.airborne && d.cruiseKmh !== d.speedKmh) return t('card.speed.air', { m: formatNumber(d.speedKmh), c: formatNumber(d.cruiseKmh) });
  if (rail && type === UnitType.ArmoredDivision) return t('card.speed.rail', { v: formatNumber(ARMOR_RAIL_KMH), r: formatNumber(d.speedKmh) });
  return t('card.speed.surface', { v: formatNumber(d.speedKmh) });
}
export function speedRealLine(type: UnitType, rail = false): string {
  const v = rail && type === UnitType.ArmoredDivision ? ARMOR_RAIL_KMH : UNIT_DEFS[type].speedKmh;
  return t('card.speed.real', { v: formatNumber(v) });
}

/** Reach (§6.3): aircraft km from their base; divisions own/allied land; ships navigable water. */
export function reachLine(type: UnitType): string {
  const r = reachKm(type);
  if (r > 0 && UNIT_DEFS[type].airborne) return t('card.reach.air', { km: formatNumber(r) });
  if (type === UnitType.ArmoredDivision) return t('card.reach.division');
  return t('card.reach.sea');
}

/** «≈ 20 días de combate» at −0.2 %/h engaged, from the current integrity. */
export function enduranceLine(u: UnitView): string {
  const hours = u.hp / DIVISION_WEAR_ENGAGED;
  return t('card.endurance', { d: formatNumber(Math.round(hours / 24)) });
}

/** What the unit adds to the war right now (§7.6 «el efecto que está produciendo»). */
export function effectLine(hs: HudShared, u: UnitView): string {
  const front = frontName(hs, u.frontKey);
  const view = hs.ctx.sim.view;
  const place = () => describeXY(view, u.targetX, u.targetY).name;
  switch (u.type) {
    case UnitType.ArmoredDivision:
      if (u.mode === UnitMode.Offensive) return t('effect.division.attack', { front: front || t('front.this') });
      if (u.mode === UnitMode.Front) return t('effect.division.defend', { front: front || t('front.this') });
      if (u.mode === UnitMode.Moving || u.mode === UnitMode.Rail) return t('effect.division.moving');
      return t('effect.division.idle', { r: Math.round(DIVISION_ATTACH_TILES * TILE_KM) });
    case UnitType.FighterSquadron:
      if (u.mode === UnitMode.Patrol) return t('effect.fighter.cap', { km: Math.round(CAP_RADIUS_TILES * TILE_KM), place: place(), p: Math.round(CAP_HIT_AIRCRAFT * 100) });
      if (u.mode === UnitMode.Intercept) return t('effect.fighter.intercept');
      if (u.mode === UnitMode.Escort) return t('effect.fighter.escort');
      if (u.mode === UnitMode.Docked) return t('effect.fighter.docked', { km: Math.round(16 * TILE_KM), radar: RADAR_SCRAMBLE_MUL });
      return t('effect.none.returning');
    case UnitType.Bomber:
      if (u.mode === UnitMode.Strike) return t('effect.bomber.strike', { place: place(), s: BOMBER_DIRECT_DMG, d: Math.round(BOMBER_DIVISION_DMG * 100) });
      if (u.mode === UnitMode.Rearming) return t('effect.rearming');
      return t('effect.bomber.ready', { km: formatNumber(reachKm(u.type)) });
    case UnitType.DroneSwarm:
      if (u.mode === UnitMode.Support) return t('effect.drone.support', { front: front || place(), mul: DRONE_ADVANCE_MUL.toFixed(2).replace('.', t('num.dec')) });
      if (u.mode === UnitMode.Strike) return t('effect.drone.strike', { place: place(), s: DRONE_DIRECT_DMG });
      if (u.mode === UnitMode.Rearming) return t('effect.rearming');
      return t('effect.drone.ready', { km: formatNumber(reachKm(u.type)), r: Math.round(DRONE_SUPPORT_TILES * TILE_KM) });
    case UnitType.Warship:
      if (u.mode === UnitMode.Blockade) return t('effect.warship.blockade', { km: Math.round(WARSHIP_ENGAGE_TILES * TILE_KM) });
      if (u.mode === UnitMode.Bombard) return t('effect.warship.bombard', { pct: Math.round((BOMBARD_ATTACK_MUL - 1) * 100), km: Math.round(WARSHIP_BOMBARD_TILES * TILE_KM) });
      if (u.mode === UnitMode.Escort) return t('effect.warship.escort');
      if (u.mode === UnitMode.Engaged) return t('effect.warship.engaged');
      return t('effect.warship.patrol', { km: Math.round(WARSHIP_ENGAGE_TILES * TILE_KM) });
    case UnitType.TransportShip:
      return t('effect.convoy', { n: formatNumber(Math.round(u.troops)) });
    default:
      return '';
  }
}

/** The order the unit is carrying out, as a word («Patrulla aérea»). */
export function orderWord(u: UnitView): string {
  const k = u.order >= 0 ? UNIT_ORDER_KINDS[u.order] : null;
  return k ? t(`order.${k}`) : '';
}

/** Integrity tooltip lines per type (§7.6). */
export function integrityHelp(type: UnitType): string {
  if (type === UnitType.ArmoredDivision) return t('card.integrity.division', { wear: (DIVISION_WEAR_ENGAGED * 100).toFixed(1).replace('.', t('num.dec')), rep: (DIVISION_FIELD_REPAIR * 100).toFixed(2).replace('.', t('num.dec')) });
  if (type === UnitType.Warship) return t('card.integrity.warship');
  return t('card.integrity.air', { h: Math.round((REARM_TICKS[type] ?? 20) / 10) });
}

// =================================================================================================
// Structures (§6.2): effects at a level, in numbers
// =================================================================================================
const pct = (v: number) => `${Math.round(v * 100)} %`;
const tiles = (v: number) => t('card.tilesKm', { n: formatNumber(v, 1), km: formatNumber(Math.round(v * TILE_KM)) });

/** [label, value] rows of a structure type at a level (§6.2). */
export function levelEffects(type: StructureType, level: number, live?: { tradeShips?: number; trains?: number; radar?: boolean }): [string, string][] {
  const L = structureLevel(type, level);
  const out: [string, string][] = [];
  const g = (n: number) => t('card.goldPerHour', { n: formatNumber(n) });
  switch (type) {
    case StructureType.City: {
      const cum = (k: 'troopCap' | 'goldPerHour' | 'population') => (L[k] ?? 0);
      out.push([t('eff.gold'), g(cum('goldPerHour'))], [t('eff.troopCap'), `+${formatNumber(cum('troopCap'))}`], [t('eff.population'), `+${formatNumber(cum('population') / 1e6, 1)} M`]);
      break;
    }
    case StructureType.Port:
      out.push([t('eff.trade'), g(PORT_TRADE_GOLD_PER_HOUR[Math.min(3, level)] ?? 0)],
        [t('eff.tradeShips'), live?.tradeShips !== undefined ? t('eff.ofShips', { n: live.tradeShips, of: L.tradeShips ?? 0 }) : String(L.tradeShips ?? 0)],
        [t('eff.embark'), t('eta.hours', { n: Math.round((L.embarkTicks ?? 60) / 10) })],
        [t('eff.shipRepair'), t('eff.repairIn', { p: pct(L.repairPerHour ?? 0), r: Math.round((L.repairTiles ?? 3) * TILE_KM) })]);
      break;
    case StructureType.Factory:
      out.push([t('eff.production'), g(L.goldPerHour ?? 0)], [t('eff.railFreight'), g(RAIL_GOLD_PER_HOUR[Math.min(3, level)] ?? 0)],
        [t('eff.trains'), live?.trains !== undefined ? t('eff.ofShips', { n: live.trains, of: L.trains ?? 0 }) : String(L.trains ?? 0)],
        [t('eff.railSlots'), String(L.railSlots ?? 0)]);
      break;
    case StructureType.DefensePost:
      out.push([t('eff.zone'), tiles(L.radiusTiles ?? 3)], [t('eff.enemyTime'), `×${formatNumber(L.timeMul ?? 1, 2)}`], [t('eff.enemyCasualties'), `×${formatNumber(L.casualtyMul ?? 1, 2)}`]);
      break;
    case StructureType.SamSite: {
      const k = live?.radar ? RADAR_SAM_RANGE_MUL : 1;
      out.push([t('eff.samAir'), `${tiles((L.rangeTiles ?? 8) * k)} · ${pct(L.hitAir ?? 0)}`], [t('eff.samAbm'), `${tiles((L.abmTiles ?? 5) * k)} · ${pct(L.hitBallistic ?? 0)}`],
        [t('eff.salvo'), t('eff.salvoN', { n: L.salvo ?? 1, h: Math.round((L.reloadTicks ?? 20) / 10) })]);
      break;
    }
    case StructureType.MissileSilo:
      out.push([t('eff.weapons'), (L.weapons ?? []).map((w) => t(`unit.${unitId(w)}`)).join(', ')], [t('eff.reload'), t('eta.hours', { n: Math.round((L.reloadTicks ?? 240) / 10) })]);
      break;
    case StructureType.Airbase:
      out.push([t('eff.capacity'), t('eff.squadrons', { n: L.capacity ?? 0 })], [t('eff.scramble'), `${tiles((L.scrambleTiles ?? 16) * (live?.radar ? RADAR_SCRAMBLE_MUL : 1))}`], [t('eff.repair'), t('eff.perHour', { p: pct(L.repairPerHour ?? 0) })]);
      break;
    case StructureType.ArmyBase:
      out.push([t('eff.capacity'), t('eff.divisions', { n: L.capacity ?? 0 })], [t('eff.troopCap'), `+${formatNumber(L.troopCap ?? 0)}`], [t('eff.divRepair'), t('eff.repairIn', { p: pct(L.repairPerHour ?? 0), r: Math.round((L.repairTiles ?? 5) * TILE_KM) })]);
      break;
    case StructureType.NavalYard:
      out.push([t('eff.capacity'), t('eff.warships', { n: L.capacity ?? 0 })], [t('eff.shipRepair'), t('eff.repairIn', { p: pct(L.repairPerHour ?? 0), r: Math.round((L.repairTiles ?? 3) * TILE_KM) })]);
      break;
    case StructureType.Radar:
      out.push([t('eff.coverage'), tiles(L.coverageTiles ?? 20)], [t('eff.radarDoes'), t('eff.radarDoes.v', { sam: RADAR_SAM_RANGE_MUL, sc: RADAR_SCRAMBLE_MUL })]);
      break;
  }
  return out;
}

/** Gold per hour a structure earns at a level (Ports, Factories, Cities), for the card header. */
export function goldPerHour(type: StructureType, level: number): number {
  const L = structureLevel(type, level);
  if (type === StructureType.Port) return PORT_TRADE_GOLD_PER_HOUR[Math.min(3, level)] ?? 0;
  if (type === StructureType.Factory) return (L.goldPerHour ?? 0) + (RAIL_GOLD_PER_HOUR[Math.min(3, level)] ?? 0);
  if (type === StructureType.City) return L.goldPerHour ?? 0;
  return 0;
}

export function maxLevel(type: StructureType): number {
  return Math.min(STRUCTURE_DEFS[type].maxLevel, STRUCTURE_LEVELS[type].length - 1);
}

export { upgradeCost, upgradeTicks };

/** The purpose line of a structure (§6.2 first column). */
export function structurePurpose(type: StructureType): string {
  return t(`structure.${structId(type)}.purpose`);
}

/** Human units hosted at a structure (airbase aircraft, army-base divisions, yard warships). */
export function hostedUnits(hs: HudShared, s: StructureView): UnitView[] {
  const out: UnitView[] = [];
  for (const u of hs.ctx.sim.view.units.values()) if (u.home === s.id && u.owner === s.owner && isForce(u.type) && u.type !== UnitType.TransportShip) out.push(u);
  out.sort((a, b) => a.type - b.type || a.serial - b.serial);
  return out;
}
