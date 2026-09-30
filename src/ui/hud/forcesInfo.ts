// FRONT ULTRA — what a unit or a structure is doing, in words and numbers (DESIGN_V2 §6, §7.5, §7.6; owner: ui, W4).
//
// One vocabulary for the Fuerzas panel, the unit and structure cards, the order chip and the tooltips: names with
// ordinals, state lines with their ETA in game hours and real seconds, where a unit is, what it adds to the war right
// now, its speed with the real-time equivalent, its reach and its endurance; the effects of a structure at its level and
// at the next one. Every number comes from UNIT_DEFS / STRUCTURE_LEVELS and the sim's published state.

import type { HudShared } from './shared';
import { unitLabel } from './news';
import { describeXY, frontPlace } from '../places';
import { kmhText, offensiveKmh } from './frontsInfo';
import {
  ARMOR_RAIL_KMH, BOMBARD_ATTACK_MUL, BOMBER_DIRECT_DMG, BOMBER_DIVISION_DMG, CAP_HIT_AIRCRAFT, CAP_RADIUS_TILES, DIVISION_ATTACH_TILES,
  DIVISION_FIELD_REPAIR, DIVISION_WEAR_ENGAGED, DRONE_ADVANCE_MUL, DRONE_DIRECT_DMG, DRONE_SUPPORT_TILES, HOLD_ORBIT_KM, HUMAN_ID,
  PORT_TRADE_GOLD_PER_HOUR, RADAR_SAM_RANGE_MUL, RADAR_SCRAMBLE_MUL, RAIL_GOLD_PER_HOUR, REARM_TICKS, STRUCTURE_DEFS,
  STRUCTURE_LEVELS, TILE_KM, UNIT_DEFS, WARSHIP_BOMBARD_TILES, WARSHIP_ENGAGE_TILES, structureLevel, upgradeCost, upgradeTicks,
} from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import {
  DEFEND_TILES, DIVISION_ARTILLERY_TILES, DIVISION_SHELL_PER_HOUR, RAZE_SHELL_MUL, isForce, offensiveOutlook, reachKm, type OutlookInput,
} from '../../shared/orders';
import {
  StructureType, UnitMode, UnitType, UNIT_ORDER_KINDS, type AttackView, type StructureView, type UnitView,
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

/** An aircraft left by the player on a holding orbit over a spot (released from command mode, feedback #18). */
/** An aircraft whose order is a station it keeps by rotating with its base (fighter patrol, drone support). */
export function stationOrder(u: UnitView): boolean {
  if (!UNIT_DEFS[u.type].airborne || u.order < 0) return false;
  const k = UNIT_ORDER_KINDS[u.order];
  return k === 'cap' || k === 'support';
}

export function holdingAir(u: UnitView): boolean {
  return !!UNIT_DEFS[u.type].airborne && u.mode === UnitMode.Patrol && u.order >= 0 && UNIT_ORDER_KINDS[u.order] === 'hold';
}

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
  // W6: a front is hundreds of km long — name it by the place nearest to any point of its line, or by the direction
  // from the nearest city, before falling back to a bearing from the capital.
  const fp = frontPlace(f);
  if (fp) return fp.dir ? t('front.nameDir', { place: fp.name, dir: fp.dir }) : t('front.name', { place: fp.name });
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

// =================================================================================================
// Feedback 3 (#28): missions
// =================================================================================================
export type MissionKind = 'join' | 'defend' | 'assault' | 'raze';

/** The division mission the unit carries out, if any. */
export function missionOf(u: UnitView): MissionKind | null {
  const k = u.order >= 0 ? UNIT_ORDER_KINDS[u.order] : null;
  return k === 'join' || k === 'defend' || k === 'assault' || k === 'raze' ? k : null;
}

/** The offensive a 'join' mission follows (its attack view), if it still runs. */
export function joinedOffensive(hs: HudShared, u: UnitView): AttackView | null {
  if (missionOf(u) !== 'join' || !u.mission) return null;
  return hs.ctx.sim.view.attacks.find((a) => a.id === u.mission) ?? null;
}

/** «Ofensiva sobre Zaragoza» — an offensive named by its axis point. */
export function offensiveName(hs: HudShared, a: AttackView): string {
  return t('off.named', { place: describeXY(hs.ctx.sim.view, a.x, a.y).name });
}

/** The structure an assault / raze mission targets (may be gone: destroyed or captured). */
export function missionStructure(hs: HudShared, u: UnitView): StructureView | null {
  const m = missionOf(u);
  if ((m !== 'assault' && m !== 'raze') || !u.mission) return null;
  return hs.ctx.sim.view.structures.get(u.mission) ?? null;
}

/** «→ Frente de Lyon · 6 h» — the state line of a row and a card. */
export function stateLine(hs: HudShared, u: UnitView): string {
  const view = hs.ctx.sim.view;
  // Feedback 3 (#28): a division on a mission says which one, with its target.
  const mission = missionOf(u);
  if (mission && u.type === UnitType.ArmoredDivision) {
    const moving = u.mode === UnitMode.Moving || u.mode === UnitMode.Rail;
    const eta = moving && u.etaTicks > 0 ? ` · ${etaText(hs, u.etaTicks, false)}` : '';
    if (mission === 'join') {
      const a = joinedOffensive(hs, u);
      return t(moving ? 'fstate.join.to' : 'fstate.join', { off: a ? offensiveName(hs, a) : t('fr.front') }) + eta;
    }
    if (mission === 'defend') {
      const at = (u.mission ?? 0) < 0 ? -(u.mission ?? 0) - 1 : -1;
      const px = at >= 0 ? (at % 1600) + 0.5 : u.targetX, py = at >= 0 ? Math.floor(at / 1600) + 0.5 : u.targetY;
      return t(moving ? 'fstate.defend.to' : u.mode === UnitMode.Front ? 'fstate.defend.fight' : 'fstate.defend', { place: describeXY(view, px, py).name }) + eta;
    }
    const s = missionStructure(hs, u);
    const name = s ? structureName(hs, s) : t('fstate.target');
    return t(`fstate.${mission}`, { target: name, hp: s ? Math.round(s.hp * 100) : 0 }) + eta;
  }
  const mode = t(`fmode.${MODE_IDS[u.mode] ?? 'idle'}`);
  const eta = u.etaTicks > 0 ? etaText(hs, u.etaTicks, false) : '';
  const front = frontName(hs, u.frontKey);
  const dest = () => describeXY(view, u.targetX, u.targetY).name;
  // Owner feedback #2 item 25: a patrol / drone support out of fuel flies home, refuels and goes back by itself.
  const rotating = stationOrder(u);
  if (rotating && u.mode === UnitMode.Returning) return t('fstate.refuel', { place: homeName(hs, u), eta });
  if (rotating && u.mode === UnitMode.Rearming) return t('fstate.rearmResume', { eta });
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
      // Released from command mode (owner feedback #18): holding over the spot with the fuel it has left.
      if (holdingAir(u)) return t('fstate.holding', { place: dest(), eta: etaText(hs, u.etaTicks, false) });
      if (rotating && eta) return t('fstate.overFuel', { mode, place: dest(), eta });
      return t('fstate.over', { mode, place: dest() });
    case UnitMode.Support:
      if (rotating && eta) return t('fstate.overFuel', { mode, place: front || dest(), eta });
      return t('fstate.over', { mode, place: front || dest() });
    case UnitMode.Blockade:
    case UnitMode.Bombard:
      return t('fstate.over', { mode, place: dest() });
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
  if (stationOrder(u) && (u.mode === UnitMode.Returning || u.mode === UnitMode.Rearming)) return t('effect.refuel');
  switch (u.type) {
    case UnitType.ArmoredDivision: {
      const mission = missionOf(u);
      if (mission === 'join') {
        const a = joinedOffensive(hs, u);
        if (a && u.mode === UnitMode.Offensive) {
          const now = offensiveOutlook(outlookOf(a));
          return t('effect.division.join', { off: offensiveName(hs, a), n: a.divAtk ?? 0, pct: Math.round((now.armorMul - 1) * 100), kmh: kmhText(liveKmh(hs, a)) });
        }
        if (a) return t('effect.division.joinMoving', { off: offensiveName(hs, a) });
      }
      if (mission === 'defend') {
        if (u.mode === UnitMode.Front) return t('effect.division.defendFight', { front: front || t('front.this'), km: Math.round(DEFEND_TILES * TILE_KM) });
        return t('effect.division.defendSector', { km: Math.round(DEFEND_TILES * TILE_KM) });
      }
      if (mission === 'assault' || mission === 'raze') {
        const st = missionStructure(hs, u);
        const dmg = DIVISION_SHELL_PER_HOUR * (mission === 'raze' ? RAZE_SHELL_MUL : 1);
        if (st) return t(`effect.division.${mission}`, { target: structureName(hs, st), km: Math.round(DIVISION_ARTILLERY_TILES * TILE_KM), dmg: Math.round(dmg * 100) });
      }
      if (u.mode === UnitMode.Offensive) return t('effect.division.attack', { front: front || t('front.this') });
      if (u.mode === UnitMode.Front) return t('effect.division.defend', { front: front || t('front.this') });
      if (u.mode === UnitMode.Moving || u.mode === UnitMode.Rail) return t('effect.division.moving');
      return t('effect.division.idle', { r: Math.round(DIVISION_ATTACH_TILES * TILE_KM) });
    }
    case UnitType.FighterSquadron:
      if (u.mode === UnitMode.Patrol && holdingAir(u)) return t('effect.fighter.hold', { r: HOLD_ORBIT_KM, km: Math.round(CAP_RADIUS_TILES * TILE_KM), eta: etaText(hs, u.etaTicks, true) });
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

/** The live figures of an offensive for offensiveOutlook. */
export function outlookOf(a: AttackView): OutlookInput {
  return {
    ratio: a.ratio, advanceKmh: a.advanceKmh, planKmh: a.planKmh, intensity: a.intensity, frontageTiles: a.frontageTiles,
    divAtk: a.divAtk, casAtk: a.casAtk, casDef: a.casDef, air: a.air, navalAtk: a.navalAtk,
  };
}

/** Feedback 3 (29a): the one km/h of an offensive every panel shows (frontsInfo.offensiveKmh). */
export function liveKmh(hs: HudShared, a: AttackView): number {
  return offensiveKmh(hs.ctx.sim.view, a);
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
