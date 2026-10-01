// FRONT ULTRA — the encyclopedia (DESIGN_V2 §12.4; W7 integration).
//
// One entry per structure, unit and weapon, generated from the shared tables (STRUCTURE_DEFS, STRUCTURE_LEVELS,
// UNIT_DEFS, NUKE_DEFS) and i18n, never hand-written numbers: icon, purpose, cost and times, a stats table per level
// (the same rows as the structure card, `levelEffects`), what it is for in a war, what counters it, and its orders.
// Shown as the «Enciclopedia» tab of Help (F1).

import { h } from './dom';
import { icon, type IconName } from './icons';
import { tip } from './tooltip';
import {
  levelEffects, maxLevel, reachLine, speedLine, structurePurpose,
} from './hud/forcesInfo';
import {
  ARMOR_RAIL_KMH, BUILDABLE_UNITS, NUKE_DEFS, STRUCTURE_DEFS, TILE_KM, UNIT_DEFS, WEAPONS, ballisticFlightTicks,
  upgradeCost, upgradeTicks,
} from '../shared/constants';
import { formatNumber, hasKey, t } from '../shared/i18n';
import { STRUCTURE_TYPES, StructureType, UnitType, type UnitOrderKind, type WeaponType } from '../shared/types';

type Entry = { kind: 'structure'; type: StructureType } | { kind: 'unit'; type: UnitType };

/** Orders each unit type accepts (the same set the sim's orderCheck admits), in the order a player meets them. */
const ORDERS: Partial<Record<UnitType, UnitOrderKind[]>> = {
  [UnitType.ArmoredDivision]: ['move', 'defend', 'attack', 'join', 'assault', 'raze', 'hold', 'return'],
  [UnitType.Warship]: ['move', 'patrol', 'blockade', 'bombard', 'escort', 'attack', 'return'],
  [UnitType.FighterSquadron]: ['cap', 'intercept', 'escort', 'rebase', 'return'],
  [UnitType.Bomber]: ['strike', 'rebase', 'return'],
  [UnitType.DroneSwarm]: ['support', 'strike', 'rebase', 'return'],
};
/** Silo level that unlocks each weapon (STRUCTURE_LEVELS.MissileSilo). */
const SILO_LEVEL: Record<number, number> = { [UnitType.CruiseMissile]: 1, [UnitType.AtomBomb]: 1, [UnitType.HydrogenBomb]: 2, [UnitType.Mirv]: 3 };
/** Escalation level a war must reach for the weapon (§5.10). */
const ESCALATION: Record<number, number> = { [UnitType.CruiseMissile]: 1, [UnitType.AtomBomb]: 3, [UnitType.HydrogenBomb]: 4, [UnitType.Mirv]: 4 };
/** Units that are not bought but matter to the player (they carry trade, troops and freight). */
const SUPPORT_UNITS: UnitType[] = [UnitType.TransportShip, UnitType.TradeShip, UnitType.Train];

const hoursText = (ticks: number) => t('ency.time', { h: formatNumber(Math.round(ticks / 10)), s: formatNumber(Math.round(ticks / 10)) });

function orderTip(type: UnitType, o: UnitOrderKind): string {
  if (o === 'return') return t(`order.return.tip.${type === UnitType.ArmoredDivision ? 'land' : type === UnitType.Warship ? 'sea' : 'air'}`);
  const special = `ency.order.${o}.${UNIT_DEFS[type].id}`;
  if (hasKey(special)) return t(special);
  if (hasKey(`order.${o}.tip`)) return t(`order.${o}.tip`);
  return t(`ency.order.${o}`);
}

function factTable(rows: [string, string][]): HTMLElement {
  const tb = h('table', { class: 'fu-ency-facts' });
  for (const [k, v] of rows) tb.append(h('tr', null, h('th', null, k), h('td', null, v)));
  return tb;
}

/** Levels shown in the per-level table: every level, except the city's ten (1, 2, 3, 5 and 10: it grows linearly). */
function levelsOf(type: StructureType): number[] {
  const max = maxLevel(type);
  if (max <= 4) return Array.from({ length: max }, (_, i) => i + 1);
  return [1, 2, 3, 5, max];
}

function levelTable(type: StructureType): HTMLElement {
  const levels = levelsOf(type);
  const cols = levels.map((l) => levelEffects(type, l));
  const head = h('tr', null, h('th', null, t('ency.level')), ...levels.map((l) => h('th', null, t('ency.levelN', { n: l }))));
  const tb = h('table', { class: 'fu-ency-levels' }, head);
  cols[0].forEach(([label], i) => tb.append(h('tr', null, h('th', null, label), ...cols.map((c) => h('td', null, c[i]?.[1] ?? '')))));
  tb.append(h('tr', { class: 'is-cost' }, h('th', null, t('ency.upgradeTo')),
    ...levels.map((l) => h('td', null, l === 1 ? '—' : t('ency.upgradeCost', { g: formatNumber(upgradeCost(type, l - 1)), h: formatNumber(Math.round(upgradeTicks(type) / 10)) })))));
  return tb;
}

function structureEntry(type: StructureType): HTMLElement {
  const d = STRUCTURE_DEFS[type];
  const id = d.id;
  const facts: [string, string][] = [
    [t('ency.cost'), t('ency.costStructure', { g: formatNumber(d.baseCost), step: Math.round(d.costStep * 100), max: formatNumber(d.maxCost) })],
    [t('ency.buildTime'), hoursText(d.buildTicks)],
    [t('ency.hotkey'), d.hotkey],
    [t('ency.maxLevel'), String(maxLevel(type))],
  ];
  if (d.coastal) facts.push([t('ency.placement'), t('hud.coastal')]);
  const produces = BUILDABLE_UNITS.filter((u) => UNIT_DEFS[u].producedBy === type).map((u) => t(`unit.${UNIT_DEFS[u].id}`));
  if (type === StructureType.MissileSilo) produces.push(...WEAPONS.map((w) => t(`unit.${UNIT_DEFS[w].id}`)));
  if (produces.length) facts.push([t('ency.produces'), produces.join(', ')]);
  return h('div', { class: 'fu-ency-entry' },
    h('div', { class: 'fu-ency-head' }, icon(id as IconName), h('div', null, h('h4', null, t(`structure.${id}`)), h('p', { class: 'fu-ency-purpose' }, structurePurpose(type)))),
    factTable(facts),
    h('h5', null, t('ency.perLevel')),
    levelTable(type),
    h('h5', null, t('ency.useTitle')),
    h('p', null, t(`ency.use.${id}`)),
    h('h5', null, t('ency.threatsTitle')),
    h('p', null, t(`ency.threats.${id}`)),
    h('p', { class: 'fu-ency-note' }, t('ency.damageNote')),
  );
}

function unitEntry(type: UnitType): HTMLElement {
  const d = UNIT_DEFS[type];
  const id = d.id;
  const facts: [string, string][] = [];
  const weapon = (WEAPONS as readonly UnitType[]).includes(type);
  if (d.cost > 0) facts.push([t('ency.cost'), formatNumber(d.cost)]);
  if (d.productionTicks > 0) facts.push([t('ency.prodTime'), hoursText(d.productionTicks)]);
  if (d.producedBy !== -1) facts.push([t(weapon ? 'ency.launchedFrom' : 'ency.producedAt'), weapon
    ? t('ency.siloLevel', { n: SILO_LEVEL[type] ?? 1 })
    : t(`structure.${STRUCTURE_DEFS[d.producedBy].id}`)]);
  if (weapon) {
    const nd = NUKE_DEFS[type as WeaponType];
    facts.push([t('ency.reach'), t('ency.km', { km: formatNumber(d.rangeKm) })]);
    if (type === UnitType.CruiseMissile) facts.push([t('ency.speed'), speedLine(type)]);
    else facts.push([t('ency.flight'), t('ency.flightBallistic', { a: Math.round(ballisticFlightTicks(1000) * 6), b: Math.round(ballisticFlightTicks(8000) * 6) })]);
    const r = type === UnitType.Mirv ? NUKE_DEFS[UnitType.MirvWarhead].outerRadius : nd.outerRadius;
    facts.push([t('ency.blast'), t(type === UnitType.Mirv ? 'ency.blastMirv' : 'ency.blastR', { km: formatNumber(Math.round(r * TILE_KM)) })]);
    facts.push([t('ency.escalation'), t('ency.escalationNeed', { n: ESCALATION[type] ?? 1, name: t(`escalation.short.${ESCALATION[type] ?? 1}`) })]);
    facts.push([t('ency.hotkey'), { [UnitType.AtomBomb]: 'Z', [UnitType.HydrogenBomb]: 'X', [UnitType.Mirv]: 'C', [UnitType.CruiseMissile]: 'V' }[type as number] ?? '']);
  } else {
    facts.push([t('ency.speed'), type === UnitType.ArmoredDivision ? `${speedLine(type)} · ${t('ency.rail', { v: ARMOR_RAIL_KMH })}` : speedLine(type)]);
    if (d.command || d.rangeKm > 0 || type === UnitType.ArmoredDivision) facts.push([t('ency.reach'), reachLine(type)]);
    if (d.command) facts.push([t('ency.command'), t(`ency.command.${d.command}`)]);
  }
  const body = h('div', { class: 'fu-ency-entry' },
    h('div', { class: 'fu-ency-head' }, icon(id as IconName), h('div', null, h('h4', null, t(`unit.${id}`)), h('p', { class: 'fu-ency-purpose' }, t(d.roleKey)))),
    factTable(facts),
    h('h5', null, t('ency.useTitle')),
    h('p', null, t(`ency.use.${id}`)),
    h('h5', null, t('ency.threatsTitle')),
    h('p', null, t(`ency.threats.${id}`)),
  );
  const orders = ORDERS[type];
  if (orders) {
    body.append(h('h5', null, t('ency.ordersTitle')), h('p', { class: 'fu-ency-note' }, t('ency.ordersHow')));
    const ul = h('ul', { class: 'fu-ency-orders' });
    for (const o of orders) ul.append(h('li', null, h('b', null, t(`order.${o}`)), ' — ', orderTip(type, o)));
    body.append(ul);
  }
  return body;
}

/** The encyclopedia: a list of entries on the left, the chosen entry on the right. */
export function encyclopedia(onClick: () => void, start?: Entry): HTMLElement {
  const list = h('div', { class: 'fu-ency-list' });
  const view = h('div', { class: 'fu-ency-view' });
  const btns: [HTMLElement, Entry][] = [];
  const keyOf = (e: Entry) => `${e.kind}:${e.type}`;
  const show = (e: Entry) => {
    for (const [b, x] of btns) b.classList.toggle('is-on', keyOf(x) === keyOf(e));
    view.replaceChildren(e.kind === 'structure' ? structureEntry(e.type) : unitEntry(e.type));
    view.scrollTop = 0;
  };
  const group = (titleKey: string, entries: Entry[]) => {
    list.append(h('div', { class: 'fu-ency-group' }, t(titleKey)));
    for (const e of entries) {
      const id = e.kind === 'structure' ? STRUCTURE_DEFS[e.type].id : UNIT_DEFS[e.type].id;
      const name = t(e.kind === 'structure' ? `structure.${id}` : `unit.${id}`);
      const b = h('button', { class: 'fu-ency-item', 'data-ency': id }, icon(id as IconName), name);
      tip(b, () => ({ title: name, text: e.kind === 'structure' ? structurePurpose(e.type) : t(UNIT_DEFS[e.type].roleKey) }));
      b.addEventListener('click', () => {
        onClick();
        show(e);
      });
      btns.push([b, e]);
      list.append(b);
    }
  };
  group('ency.structures', STRUCTURE_TYPES.map((type) => ({ kind: 'structure', type })));
  group('ency.units', BUILDABLE_UNITS.map((type) => ({ kind: 'unit', type })));
  group('ency.weapons', WEAPONS.map((type) => ({ kind: 'unit', type })));
  group('ency.others', SUPPORT_UNITS.map((type) => ({ kind: 'unit', type })));
  show(start ?? btns[0][1]);
  return h('div', { class: 'fu-ency' }, list, view);
}
