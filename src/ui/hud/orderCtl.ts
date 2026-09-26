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
import { etaText, unitName } from './forcesInfo';
import { viewRules } from '../../sim/rulesView';
import { ARMOR_RAIL_KMH, HUMAN_ID, MAP_W, UNIT_DEFS } from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import {
  inferOrder, orderCheck, planDivision, reachKm, strikeTarget, tileCx, tileCy, tileKm, type OrderIssue,
} from '../../shared/orders';
import { StructureType, UnitMode, UnitType, type UnitOrderKind, type UnitView } from '../../shared/types';

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
    const km = tileKm(u.x, u.y, tx, ty);
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
  let why: string | null = null;
  let confirm = false;
  for (const id of ids) {
    const u = view.units.get(id);
    if (!u) continue;
    const o = forced
      ? { order: forced, targetId: hoverStructure > 0 ? hoverStructure : hoverUnit > 0 && hoverUnit !== id ? hoverUnit : 0 }
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
  return { plans, n, m: plans.length, order, why, confirm };
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
  if (pv.confirm && pv.n > 0) line = line ? `${line} · ${t('order.err.needsL2')}` : t('order.err.needsL2');
  if (!line && lead && pv.m === 1) {
    const u = view.units.get(lead.unitId);
    if (u) line = hintFor(pv.order, u);
  }
  return { title, line, bad: pv.n === 0 };
}

function hintFor(order: UnitOrderKind, u: UnitView): string {
  switch (order) {
    case 'attach': return t('chip.hint.attach');
    case 'attack': return t('chip.hint.attack');
    case 'cap': return t('chip.hint.cap', { km: formatNumber(reachKm(u.type)) });
    case 'strike': return t('chip.hint.strike');
    case 'support': return t('chip.hint.support');
    case 'blockade': return t('chip.hint.blockade');
    case 'bombard': return t('chip.hint.bombard');
    case 'patrol': return t('chip.hint.patrol');
    default: return t('chip.hint.shift');
  }
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
  const m = openModal({
    titleKey: 'order.confirmL2.title',
    kickerKey: 'order.confirmL2.kicker',
    narrow: true,
    body: [h('p', null, t('order.confirmL2.body', { unit: u ? unitName(u) : '', name: hs.name(target) }))],
    foot: [
      (() => {
        const b = h('button', { class: 'fu-btn' }, tx('common.cancel'));
        b.addEventListener('click', () => m.close());
        return b;
      })(),
      (() => {
        const b = h('button', { class: 'fu-btn fu-btn--danger' }, tx('order.confirmL2.go'));
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

/** Tile of continuous tile coords. */
export function tileAt(x: number, y: number): number {
  return Math.max(0, Math.min(799, Math.floor(y))) * MAP_W + (((Math.floor(x) % MAP_W) + MAP_W) % MAP_W);
}
