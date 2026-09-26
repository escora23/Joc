// FRONT ULTRA — explanation content for the top bar (DESIGN_V2 §12.1–§12.2, §6.7; owner: ui, built by W3).
//
// Content functions, never hand-written numbers: they read the sim's published economy terms (TickUpdate.economy, the
// same formulas as economy.ts yieldOf), the view (isOccupied, wars, clock) and the gold the human actually received
// from trade, trains and conquest over the last game day.

import type { TipData } from '../tooltip';
import type { HudShared } from './shared';
import { HUMAN_ID } from '../../shared/constants';
import { formatCompact, formatNumber, t } from '../../shared/i18n';

const pct = (v: number) => `${Math.round(v * 100)} %`;
const perH = (v: number) => t('tip.perHour', { v: formatCompact(Math.round(v)) });

/** Gold received from trade, trains, conquest and events, per game hour over the last game day. */
export function createBonusLedger(hs: HudShared): () => Record<string, number> {
  const list: { tick: number; gold: number; reason: string }[] = [];
  hs.ctx.bus.on('goldBonus', (e) => {
    if (e.playerId !== HUMAN_ID) return;
    list.push({ tick: e.tick, gold: e.gold, reason: e.reason });
    if (list.length > 4000) list.splice(0, list.length - 4000);
  });
  hs.ctx.bus.on('gameTornDown', () => (list.length = 0));
  return () => {
    const now = hs.ctx.sim.view.tick;
    const span = Math.max(10, Math.min(240, now));
    const out: Record<string, number> = { trade: 0, train: 0, conquest: 0, event: 0 };
    for (const b of list) if (now - b.tick <= span) out[b.reason] = (out[b.reason] ?? 0) + b.gold;
    for (const k of Object.keys(out)) out[k] = (out[k] / span) * 10;
    return out;
  };
}

export function troopsTip(hs: HudShared): TipData {
  const v = hs.ctx.sim.view;
  const p = v.human;
  const e = v.economy;
  if (!p) return { title: t('hud.troops') };
  const now: [string, string][] = [
    [t('tb.troops.home'), formatNumber(Math.round(p.troops))],
    [t('tb.troops.offensives'), formatNumber(Math.round(p.attackingTroops))],
    [t('tb.troops.cap'), formatNumber(Math.round(p.maxTroops))],
    [t('tb.troops.growth'), perH(e ? e.growthPerHour : p.troopGrowth)],
  ];
  const lines: string[] = [];
  if (e) {
    const m = e.cap.mul;
    lines.push(t('tb.troops.capTerms', {
      base: formatCompact(e.cap.base * m), land: formatCompact(e.cap.territory * m), cities: formatCompact(e.cap.cities * m), army: formatCompact(e.cap.armyBases * m),
    }));
    if (e.occupied > 0 || e.fallout > 0) lines.push(t('tb.troops.occupied', { occ: formatNumber(e.occupied), fallout: formatNumber(e.fallout) }));
    lines.push(t('tb.troops.recruit', { f: pct(e.fPop), occ: e.tiles > 0 ? (1 - (0.5 * e.occupied) / e.tiles).toFixed(2).replace('.', t('num.dec')) : '1', r: pct(e.recruitment) }));
    if (e.atWar) lines.push(t('tb.troops.war'));
  }
  lines.push(t('tb.troops.formula'));
  return { title: t('hud.troops'), text: t('tb.troops.purpose'), now, lines };
}

export function goldTip(hs: HudShared, ledger: () => Record<string, number>): TipData {
  const v = hs.ctx.sim.view;
  const p = v.human;
  const e = v.economy;
  if (!p) return { title: t('hud.gold') };
  const b = ledger();
  const now: [string, string][] = [[t('tb.gold.have'), formatNumber(Math.round(p.gold))], [t('tb.gold.income'), perH(p.income)]];
  if (e) {
    const m = e.income.mul;
    now.push([t('tb.gold.base'), perH(e.income.base * m)], [t('tb.gold.land'), perH(e.income.territory * m)], [t('tb.gold.cities'), perH(e.income.cities * m)], [t('tb.gold.factories'), perH(e.income.factories * m)]);
  }
  now.push([t('tb.gold.trade'), perH(b.trade)], [t('tb.gold.trains'), perH(b.train)]);
  if (b.conquest > 0 || b.event > 0) now.push([t('tb.gold.other'), perH(b.conquest + b.event)]);
  const lines = [t('tb.gold.formula')];
  if (e && e.occupied > 0) lines.push(t('tb.gold.occupied', { n: formatNumber(e.occupied) }));
  if (e && e.fallout > 0) lines.push(t('tb.gold.fallout', { n: formatNumber(e.fallout) }));
  return { title: t('hud.gold'), text: t('tb.gold.purpose'), now, lines };
}

export function popTip(hs: HudShared): TipData {
  const v = hs.ctx.sim.view;
  const p = v.human;
  const e = v.economy;
  if (!p) return { title: t('hud.population') };
  if (!e) return { title: t('hud.population'), text: t('tb.pop.purpose') };
  const occFactor = e.tiles > 0 ? 1 - (0.5 * e.occupied) / e.tiles : 1;
  return {
    title: t('hud.population'), text: t('tb.pop.purpose'),
    now: [[t('tb.pop.now'), formatCompact(e.pop)], [t('tb.pop.target'), formatCompact(e.popTarget)], [t('tb.pop.factor'), pct(e.fPop)], [t('tb.pop.recruit'), pct(e.recruitment)]],
    lines: [
      t('tb.pop.sentence', { pop: formatCompact(e.pop), target: formatCompact(e.popTarget), f: pct(e.fPop), occ: occFactor.toFixed(2).replace('.', t('num.dec')), r: pct(e.recruitment) }),
      t('tb.pop.moves'),
    ],
  };
}

export function territoryTip(hs: HudShared): TipData {
  const v = hs.ctx.sim.view;
  const p = v.human;
  if (!p) return { title: t('hud.territory') };
  const land = v.world?.landTiles ?? 1;
  const occ = v.occupiedCount(HUMAN_ID);
  return {
    title: t('hud.territory'), text: t('tb.terr.purpose'),
    now: [[t('tb.terr.tiles'), formatNumber(p.tiles)], [t('tb.terr.share'), `${((p.tiles / land) * 100).toFixed(2).replace('.', t('num.dec'))} %`], [t('tb.terr.occupied'), formatNumber(occ)], [t('tb.terr.km2'), formatNumber(Math.round(p.tiles * 625 / 1000) * 1000)]],
    lines: [t('tb.terr.victory'), t('tb.terr.occupiedLine')],
  };
}

export function warsTip(hs: HudShared): TipData {
  const v = hs.ctx.sim.view;
  const mine = v.wars.filter((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID);
  const now: [string, string][] = mine.map((w) => {
    const enemy = w.aggressor === HUMAN_ID ? w.target : w.aggressor;
    const weA = w.aggressor === HUMAN_ID;
    const sc = Math.round(weA ? w.scoreA : -w.scoreA);
    return [hs.name(enemy), t('tb.wars.row', { score: sc > 0 ? `+${sc}` : `${sc}`, esc: t(`escalation.short.${Math.max(w.escalationA, w.escalationB)}`) })];
  });
  return { title: t('tb.wars'), text: t('tb.wars.purpose'), now, lines: [mine.length ? t('tb.wars.click') : t('tb.wars.none')] };
}

export function clockRateText(rate: number): string {
  // Game time per real second.
  if (rate >= 3600) return t('clock.per.hours', { n: rate / 3600 });
  if (rate >= 60) return t('clock.per.minutes', { n: Math.round(rate / 60) });
  return t('clock.per.seconds', { n: Math.round(rate) });
}

