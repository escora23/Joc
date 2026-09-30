// FRONT ULTRA — unit orders from the strategic view (DESIGN_V2 §7.1–§7.4; owner: ui, W4).
//
// The right click with units selected resolves one order per unit by context (shared/orders.ts inferOrder, the rule
// the sim runs), previews it in the cursor chip before the click (order, distance, ETA in game hours and real seconds,
// road or rail, and the exact reason when a unit cannot comply, «3 de 5 unidades pueden cumplir esta orden») and sends
// one unitOrder per distinct (order, target). The sim validates with the same orderError, so the preview and the sim
// can never disagree (acceptance 3). A first strategic strike asks for confirmation (escalation L2, §5.10).

import { h } from '../dom';
import { openModal } from '../modal';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { etaText, offensiveName, outlookOf, structureName, unitName } from './forcesInfo';
import { kmhText, offensiveKmh } from './frontsInfo';
import { viewRules } from '../../sim/rulesView';
import {
  ARMOR_RAIL_KMH, BOMBER_DIRECT_DMG, BOMBER_DIVISION_DMG, BOMBER_GARRISON_SHARE, CAP_HIT_AIRCRAFT, CAP_RADIUS_TILES,
  DRONE_ADVANCE_MUL, DRONE_DIRECT_DMG, HUMAN_ID, MAP_W, TILE_KM, UNIT_DEFS, structureLevel,
} from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import {
  ASSAULT_FLOOR_HP, DEFEND_TILES, DIVISION_ARTILLERY_TILES, DIVISION_SHELL_PER_HOUR, JOIN_NEAR_TILES, RAZE_SHELL_MUL, hostileTo, inferOrder,
  offensiveNear, offensiveOutlook, orderCheck, planDivision, strikeTarget, tileCx, tileCy, tileKm, type OrderIssue,
} from '../../shared/orders';
import { StructureType, UnitMode, UnitType, type StructureView, type UnitOrderKind, type UnitView } from '../../shared/types';
import {
  CASUS_BELLI_TICKS, CIVILIAN_OPINION_ALLY, CIVILIAN_OPINION_VICTIM, CIVILIAN_OPINION_WORLD, cityCivilianLoss, cityTroopLoss,
} from '../../shared/damage';

export interface UnitOrderPlan {
  unitId: number;
  order: UnitOrderKind;
  targetId: number;
  issue: OrderIssue | null;
  km: number;
  hours: number;
  rail: boolean;
}

export interface OrderPreview {
  plans: UnitOrderPlan[];
  /** Units that take the order / units selected. */
  n: number;
  m: number;
  /** The order most units get (the chip's title). */
  order: UnitOrderKind;
  /** The first reason a unit refuses (i18n text), when any. */
  why: string | null;
  /** Needs the escalation confirmation (a first strategic strike). */
  confirm: boolean;
  /** The tile the preview was made for (the air orders' effect and risk are read there). */
  tile: number;
}

/** Own units currently selected (single or multi). */
export function selectedUnitIds(hs: HudShared): number[] {
  const s = hs.selection;
  const view = hs.ctx.sim.view;
  const ids = s.kind === 'unit' ? [s.id] : s.kind === 'units' ? s.ids : [];
  return ids.filter((id) => {
    const u = view.units.get(id);
    return !!u && u.owner === HUMAN_ID;
  });
}

/** Distance and hours of one unit's order (the chip's numbers). */
function measure(hs: HudShared, u: UnitView, order: UnitOrderKind, tile: number, targetId: number): { km: number; hours: number; rail: boolean } {
  const r = viewRules(hs.ctx.sim.view);
  const view = hs.ctx.sim.view;
  const d = UNIT_DEFS[u.type];
  const tx = tileCx(tile), ty = tileCy(tile);
  if (order === 'hold') return { km: 0, hours: 0, rail: false };
  if (u.type === UnitType.ArmoredDivision) {
    if (order === 'move' || order === 'return') {
      const target = order === 'return' ? baseTile(hs, u) : tile;
      if (target < 0) return { km: 0, hours: 0, rail: false };
      const p = planDivision(r, u, target);
      return { km: p.km, hours: p.hours, rail: p.rail };
    }
    if (order === 'defend') {
      const p = planDivision(r, u, tile);
      return { km: p.km, hours: p.hours, rail: p.rail };
    }
    let gx = tx, gy = ty;
    if (order === 'join') {
      const a = r.offensive(targetId);
      if (a) { gx = a.x; gy = a.y; }
    } else if (order === 'assault' || order === 'raze') {
      const s = view.structures.get(targetId);
      if (s) { gx = tileCx(s.tile); gy = tileCy(s.tile); }
    }
    const km = tileKm(u.x, u.y, gx, gy);
    return { km, hours: km / d.speedKmh, rail: false };
  }
  let fx = u.x, fy = u.y;
  const base = view.structures.get(u.home);
  if ((u.mode === UnitMode.Docked || u.mode === UnitMode.Rearming) && base) {
    fx = tileCx(base.tile);
    fy = tileCy(base.tile);
  }
  let gx = tx, gy = ty;
  if (targetId > 0) {
    const tu = view.units.get(targetId);
    const ts = view.structures.get(targetId);
    if (tu) { gx = tu.x; gy = tu.y; } else if (ts) { gx = tileCx(ts.tile); gy = tileCy(ts.tile); }
  } else if (order === 'strike') {
    const st = strikeTarget(r, tile, 0);
    if (st) { gx = st.x; gy = st.y; }
  }
  if (order === 'return' && base) { gx = tileCx(base.tile); gy = tileCy(base.tile); }
  // Ships follow water paths: the great circle is a lower bound (the chip says «≈»).
  const km = tileKm(fx, fy, gx, gy) * (u.type === UnitType.Warship ? 1.15 : 1);
  return { km, hours: km / d.speedKmh, rail: false };
}

function baseTile(hs: HudShared, u: UnitView): number {
  let best = -1, bd = Infinity;
  for (const s of hs.ctx.sim.view.structures.values()) {
    if (s.owner !== HUMAN_ID || s.built < 1) continue;
    if (s.type !== StructureType.ArmyBase) continue;
    const d = tileKm(u.x, u.y, tileCx(s.tile), tileCy(s.tile));
    if (d < bd) { bd = d; best = s.tile; }
  }
  return best;
}

/** What a right click at `tile` (with a unit / structure under the cursor) would order the selected units. */
export function previewOrders(hs: HudShared, ids: number[], tile: number, hoverUnit: number, hoverStructure: number, shift: boolean, forced?: UnitOrderKind): OrderPreview | null {
  if (!ids.length || tile < 0) return null;
  const view = hs.ctx.sim.view;
  const r = viewRules(view);
  const plans: UnitOrderPlan[] = [];
  const count = new Map<UnitOrderKind, number>();
  // A card button's order (touchpads): its target under the cursor. Feedback 3: an assault / raze aims at the structure
  // on the tile, a join at our offensive whose contact is nearest the click.
  const forcedTarget = (order: UnitOrderKind, id: number): number => {
    if (order === 'join') {
      const o = view.owner[tile] ?? 0;
      return offensiveNear(r, HUMAN_ID, o, tile, JOIN_NEAR_TILES * 3)?.id ?? 0;
    }
    if (order === 'assault' || order === 'raze') return hoverStructure > 0 ? hoverStructure : r.structureAt(tile)?.id ?? 0;
    return hoverStructure > 0 ? hoverStructure : hoverUnit > 0 && hoverUnit !== id ? hoverUnit : 0;
  };
  let why: string | null = null;
  let confirm = false;
  for (const id of ids) {
    const u = view.units.get(id);
    if (!u) continue;
    const o = forced
      ? { order: forced, targetId: forcedTarget(forced, id) }
      : inferOrder(r, id, tile, hoverUnit, hoverStructure, shift);
    const issue = orderCheck(r, id, o.order, tile, o.targetId);
    const m = issue && !issue.confirm ? { km: 0, hours: 0, rail: false } : measure(hs, u, o.order, tile, o.targetId);
    plans.push({ unitId: id, order: o.order, targetId: o.targetId, issue, ...m });
    count.set(o.order, (count.get(o.order) ?? 0) + 1);
    if (issue?.confirm) confirm = true;
    else if (issue && !why) why = reasonText(hs, issue);
  }
  let order: UnitOrderKind = plans[0]?.order ?? 'move';
  let best = 0;
  for (const [k, n] of count) if (n > best) { best = n; order = k; }
  const n = plans.filter((p) => !p.issue || p.issue.confirm).length;
  return { plans, n, m: plans.length, order, why, confirm, tile };
}

/** The i18n reason with its parameters («Base llena (3/3)», «En paz con Francia…»). */
export function reasonText(hs: HudShared, issue: OrderIssue): string {
  const p: Record<string, string | number> = { ...(issue.params ?? {}) };
  if (typeof p.player === 'number') p.name = hs.name(p.player);
  if (typeof p.km === 'number') p.km = formatNumber(p.km);
  return t(issue.key, p);
}

/** Chip lines for a preview: title «Mover · 480 km · 12 h (12 s a 1x) · carretera» and the second line. */
export function chipText(hs: HudShared, pv: OrderPreview): { title: string; line: string; bad: boolean } {
  const lead = pv.plans.find((p) => p.order === pv.order && (!p.issue || p.issue.confirm)) ?? pv.plans[0];
  const view = hs.ctx.sim.view;
  const orderName = t(`order.${pv.order}`);
  const parts: string[] = [orderName];
  if (lead && lead.km > 0 && (!lead.issue || lead.issue.confirm)) {
    const approx = view.units.get(lead.unitId)?.type === UnitType.Warship ? '≈ ' : '';
    parts.push(`${approx}${formatNumber(Math.round(lead.km / 10) * 10)} km`);
    parts.push(etaText(hs, Math.round(lead.hours * 10)));
    const u = view.units.get(lead.unitId);
    if (u?.type === UnitType.ArmoredDivision && (pv.order === 'move' || pv.order === 'return')) parts.push(lead.rail ? t('route.rail', { v: ARMOR_RAIL_KMH }) : t('route.road'));
  }
  const title = parts.join(' · ');
  let line = '';
  if (pv.m > 1) line = t('chip.nOfM', { n: pv.n, m: pv.m });
  if (pv.n === 0 && pv.why) line = pv.m > 1 ? `${line} · ${pv.why}` : pv.why;
  else if (pv.why && pv.m > 1) line = `${line} · ${pv.why}`;
  if (pv.confirm && pv.n > 0) {
    const c = pv.plans.find((p) => p.issue?.confirm)?.issue;
    const why = c ? reasonText(hs, c) : t('order.err.needsL2');
    line = line ? `${line} · ${why}` : why;
  }
  if (!line && lead && pv.m === 1) {
    const u = view.units.get(lead.unitId);
    if (u) line = hintFor(hs, pv.order, u, lead.targetId, pv.tile);
  }
  return { title, line, bad: pv.n === 0 };
}

function hintFor(hs: HudShared, order: UnitOrderKind, u: UnitView, targetId: number, tile: number): string {
  switch (order) {
    case 'attach': return t('chip.hint.attach');
    case 'defend': return t('chip.hint.defend', { km: Math.round(DEFEND_TILES * TILE_KM) });
    case 'join': {
      const a = hs.ctx.sim.view.attacks.find((x) => x.id === targetId);
      if (!a) return t('chip.hint.joinNone');
      const now = offensiveKmh(hs.ctx.sim.view, a), next = offensiveOutlook(outlookOf(a), { divisions: 1 });
      return t('chip.hint.join', { off: offensiveName(hs, a), pct: Math.round((next.armorMul / Math.min(2, 1 + 0.25 * (a.divAtk ?? 0)) - 1) * 100), from: kmhText(now), to: kmhText(next.kmh) });
    }
    case 'assault':
    case 'raze': {
      const s = hs.ctx.sim.view.structures.get(targetId);
      const perH = DIVISION_SHELL_PER_HOUR * (order === 'raze' ? RAZE_SHELL_MUL : 1);
      const civil = s && s.type === StructureType.City ? ` ${t('chip.hint.civil')}` : '';
      return t(`chip.hint.${order}`, { km: Math.round(DIVISION_ARTILLERY_TILES * TILE_KM), pct: Math.round(perH * 100), floor: Math.round(ASSAULT_FLOOR_HP * 100) }) + civil;
    }
    case 'attack': return t('chip.hint.attack');
    case 'cap': return `${t('air.hint.cap', { km: formatNumber(Math.round(CAP_RADIUS_TILES * TILE_KM / 10) * 10) })} ${airRisk(hs, tile, u)}`;
    case 'strike': {
      const st = strikeTarget(viewRules(hs.ctx.sim.view), tile, targetId);
      const kind = st?.kind ?? 'front';
      const drone = u.type === UnitType.DroneSwarm;
      const pct = kind === 'structure' ? Math.round((drone ? DRONE_DIRECT_DMG : BOMBER_DIRECT_DMG) * 100)
        : kind === 'division' ? Math.round(BOMBER_DIVISION_DMG * 100) : Math.round(BOMBER_GARRISON_SHARE * 100 * (drone ? 0.4 : 1));
      const at = st ? { x: st.x, y: st.y } : null;
      return `${t(`air.hint.strike.${kind}`, { pct })} ${airRisk(hs, tile, u, at)}`;
    }
    case 'support': return `${t('air.hint.support', { pct: Math.round((DRONE_ADVANCE_MUL - 1) * 100) })} ${airRisk(hs, tile, u)}`;
    case 'escort': return t('air.hint.escort');
    case 'intercept': return t('air.hint.intercept', { pct: Math.round(CAP_HIT_AIRCRAFT * 100) });
    case 'blockade': return t('chip.hint.blockade');
    case 'bombard': return t('chip.hint.bombard');
    case 'patrol': return t('chip.hint.patrol');
    default: return t('chip.hint.shift');
  }
}

/**
 * The risk an aircraft runs over a point (#25): hostile SAM sites whose range covers it, hostile fighter patrols whose
 * circle covers it and hostile airbases close enough to scramble against it. The same figures the sim uses.
 */
export function airThreat(hs: HudShared, x: number, y: number, owner: number): { sams: number; fighters: number; bases: number } {
  const view = hs.ctx.sim.view;
  const r = viewRules(view);
  let sams = 0, fighters = 0, bases = 0;
  for (const s of view.structures.values()) {
    if (s.built < 1 || s.owner === owner || !hostileTo(r, owner, s.owner)) continue;
    const d = tileKm(x, y, tileCx(s.tile), tileCy(s.tile));
    if (s.type === StructureType.SamSite && d <= (structureLevel(s.type, s.level).rangeTiles ?? 8) * TILE_KM) sams++;
    else if (s.type === StructureType.Airbase && d <= (structureLevel(s.type, s.level).scrambleTiles ?? 16) * TILE_KM) bases++;
  }
  for (const o of view.units.values()) {
    if (o.type !== UnitType.FighterSquadron || o.owner === owner || o.mode === UnitMode.Docked || o.mode === UnitMode.Rearming) continue;
    if (!hostileTo(r, owner, o.owner)) continue;
    if (tileKm(x, y, o.x, o.y) <= CAP_RADIUS_TILES * TILE_KM * 1.5) fighters++;
  }
  return { sams, fighters, bases };
}

function airRisk(hs: HudShared, tile: number, u: UnitView, at: { x: number; y: number } | null = null): string {
  if (tile < 0) return '';
  const x = at?.x ?? tileCx(tile), y = at?.y ?? tileCy(tile);
  const th = airThreat(hs, x, y, u.owner);
  const score = th.sams * 2 + th.fighters * 2 + th.bases;
  const level = score === 0 ? 'low' : score <= 2 ? 'mid' : 'high';
  const parts: string[] = [];
  if (th.sams) parts.push(t('air.risk.sams', { n: th.sams }));
  if (th.fighters) parts.push(t('air.risk.fighters', { n: th.fighters }));
  if (th.bases) parts.push(t('air.risk.bases', { n: th.bases }));
  return t('air.risk', { level: t(`air.risk.${level}`), why: parts.length ? parts.join(', ') : t('air.risk.none') });
}

/**
 * Send the orders of a preview: one unitOrder per (order, target); units that refuse are sent anyway so the sim's ack
 * explains it (no silent drop). A first strategic strike asks for confirmation first.
 */
export function issueOrders(hs: HudShared, pv: OrderPreview, tile: number): void {
  const groups = new Map<string, { order: UnitOrderKind; targetId: number; ids: number[] }>();
  for (const p of pv.plans) {
    const k = `${p.order}:${p.targetId}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { order: p.order, targetId: p.targetId, ids: [] }));
    g.ids.push(p.unitId);
  }
  const send = (confirm: boolean) => {
    for (const g of groups.values()) {
      hs.ctx.sim.send({ type: 'unitOrder', unitIds: g.ids, order: g.order, tile, targetId: g.targetId, ratio: g.order === 'attack' ? hs.attackRatio : undefined, confirm: confirm || undefined });
    }
  };
  if (!pv.confirm) {
    send(false);
    return;
  }
  const lead = pv.plans.find((p) => p.issue?.confirm);
  const u = lead ? hs.ctx.sim.view.units.get(lead.unitId) : undefined;
  const target = hs.ctx.sim.view.owner[tile] ?? 0;
  // Feedback 3 (#27): a city is a civilian target: the dialog spells out the price before anything is sent.
  const city = lead ? civilianTarget(hs, lead, tile) : null;
  const m = openModal({
    titleKey: city ? 'order.civil.title' : 'order.confirmL2.title',
    kickerKey: city ? 'order.civil.kicker' : 'order.confirmL2.kicker',
    narrow: true,
    className: city ? 'fu-civil-confirm' : undefined,
    body: city ? civilianBody(hs, u, city) : [h('p', null, t('order.confirmL2.body', { unit: u ? unitName(u) : '', name: hs.name(target) }))],
    foot: [
      (() => {
        const b = h('button', { class: 'fu-btn' }, tx('common.cancel'));
        b.addEventListener('click', () => m.close());
        return b;
      })(),
      (() => {
        const b = h('button', { class: 'fu-btn fu-btn--danger' }, tx(city ? 'order.civil.go' : 'order.confirmL2.go'));
        b.addEventListener('click', () => {
          send(true);
          hs.sound('confirm');
          m.close();
        });
        return b;
      })(),
    ],
  });
}

/** The city a confirmed order would hit (a strike or a raze on a City), if any. */
function civilianTarget(hs: HudShared, p: UnitOrderPlan, tile: number): StructureView | null {
  const view = hs.ctx.sim.view;
  if (p.order === 'raze' || p.order === 'assault') {
    const s = view.structures.get(p.targetId);
    return s && s.type === StructureType.City ? s : null;
  }
  if (p.order !== 'strike') return null;
  const st = strikeTarget(viewRules(view), tile, p.targetId);
  if (!st || st.kind !== 'structure' || st.structure !== StructureType.City) return null;
  return view.structures.get(st.id) ?? null;
}

/**
 * Feedback 3 (#27): the consequences of striking a city, in numbers (shared/damage.ts): civilians and troops killed
 * per hit, the opinion of the victim, of its allies and of the rest of the world, the casus belli it hands them, and
 * the escalation to L2. The same figures the sim applies.
 */
function civilianBody(hs: HudShared, u: UnitView | undefined, city: StructureView): HTMLElement[] {
  const view = hs.ctx.sim.view;
  const hit = u && u.type === UnitType.DroneSwarm ? DRONE_DIRECT_DMG : u && u.type === UnitType.ArmoredDivision ? DIVISION_SHELL_PER_HOUR * RAZE_SHELL_MUL * 10 : BOMBER_DIRECT_DMG;
  const civ = cityCivilianLoss(city.level, Math.min(1, hit));
  const owner = view.players[city.owner];
  const troops = cityTroopLoss(city.level, Math.min(1, hit), owner?.troops ?? 0);
  const allies = owner?.allies.length ?? 0;
  const li = (k: string, p: Record<string, string | number> = {}) => h('li', null, t(k, p));
  const name = hs.name(city.owner);
  return [
    h('p', null, t(u ? 'order.civil.body' : 'order.civil.bodyMissile', { unit: u ? unitName(u) : '', city: structureName(hs, city), name, level: city.level })),
    h('ul', { class: 'fu-civil-list' },
      li('order.civil.deaths', { civ: formatNumber(Math.round(civ / 1000) * 1000), troops: formatNumber(Math.round(troops / 100) * 100) }),
      li('order.civil.opinionVictim', { name, v: Math.abs(CIVILIAN_OPINION_VICTIM) }),
      allies > 0 ? li('order.civil.opinionAllies', { n: allies, v: Math.abs(CIVILIAN_OPINION_ALLY) }) : null,
      li('order.civil.opinionWorld', { v: Math.abs(CIVILIAN_OPINION_WORLD) }),
      li('order.civil.casusBelli', { name, days: Math.round(CASUS_BELLI_TICKS / 240) }),
      li('order.civil.escalation'),
    ),
    h('p', { class: 'fu-civil-note' }, t('order.civil.note')),
  ];
}

/** Feedback 3: confirm a cruise missile (or any weapon without a unit) on a city, with the same consequences. */
export function openCivilianConfirm(hs: HudShared, city: StructureView, go: () => void): void {
  const m = openModal({
    titleKey: 'order.civil.title', kickerKey: 'order.civil.kicker', narrow: true, className: 'fu-civil-confirm',
    body: civilianBody(hs, undefined, city),
    foot: [
      (() => {
        const b = h('button', { class: 'fu-btn' }, tx('common.cancel'));
        b.addEventListener('click', () => m.close());
        return b;
      })(),
      (() => {
        const b = h('button', { class: 'fu-btn fu-btn--danger' }, tx('order.civil.go'));
        b.addEventListener('click', () => {
          go();
          hs.sound('confirm');
          m.close();
        });
        return b;
      })(),
    ],
  });
}

/** Tile of continuous tile coords. */
export function tileAt(x: number, y: number): number {
  return Math.max(0, Math.min(799, Math.floor(y))) * MAP_W + (((Math.floor(x) % MAP_W) + MAP_W) % MAP_W);
}
