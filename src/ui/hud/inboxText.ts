// FRONT ULTRA — the words of diplomacy (DESIGN_V2 §5.3, §8.2; owner: ui, built by W3).
//
// Shared by the alert feed and the nations panel: what a proposal is called («alianza», «paz con cesión de 38
// casillas»), the answer as a sentence with its one or two reasons («Italia rechaza la alianza: «Tu ejército en nuestra
// frontera nos inquieta» (−10)»), countdowns in game hours and real seconds, and the client preview of a ceded band
// (the same breadth-first order from the border the sim uses).

import type { HudShared } from './shared';
import { describeTile } from '../places';
import type { AlertInput } from '../../shared/events';
import { DELIBERATION_TICKS, HUMAN_ID, INBOX_MIN_REAL_MS, MAP_W, TILE_COUNT } from '../../shared/constants';
import { neighbors4, tileToLatLon } from '../../shared/geo';
import { formatCompact, formatNumber, t } from '../../shared/i18n';
import type { ProposalView, ReasonView } from '../../shared/types';

export const OPEN_STATUS = (s: string) => s === 'considering' || s === 'pending';

export function isHumanFacingProposal(p: ProposalView): boolean {
  return p.from === HUMAN_ID || p.to === HUMAN_ID;
}

/** A reason as a readable clause, its parameters resolved («Compartimos un enemigo: Alemania»). */
export function reasonText(hs: HudShared, r: ReasonView): string {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(r.params ?? {})) {
    if ((k === 'player' || k === 'enemy' || k === 'ally' || k === 'target') && typeof v === 'number') params[k] = v === HUMAN_ID ? t('news.you') : hs.name(v) || t('news.rebels');
    else if (k === 'gold' && typeof v === 'number') params[k] = formatCompact(v);
    else if (k === 'troops' && typeof v === 'number') params[k] = formatCompact(v);
    else if (k === 'treaty' && typeof v === 'string') params[k] = t(`treaty.kind.${v}`);
    else if (k === 'goal' && typeof v === 'string') params[k] = t(`war.goal.${v}`);
    else if (typeof v === 'number') params[k] = formatNumber(v);
    else params[k] = v;
  }
  return t(r.key, params);
}

/** «Compartimos un enemigo: Alemania» (+20) — value shown for opinion reasons. */
export function reasonLine(hs: HudShared, r: ReasonView): string {
  const text = reasonText(hs, r);
  if (r.value === undefined || r.key.startsWith('answer.')) return text;
  return `${text} (${r.value > 0 ? '+' : r.value < 0 ? '−' : ''}${Math.abs(r.value)})`;
}

/** The answer's reasons quoted: «…» · «…». */
export function reasonsQuoted(hs: HudShared, rs: ReasonView[] | undefined): string {
  if (!rs || !rs.length) return '';
  return rs.map((r) => t('answer.quote', { text: reasonLine(hs, r) })).join(' · ');
}

/** What is proposed, as a noun phrase («una alianza», «la paz con cesión de 38 casillas»). */
export function proposalWhat(hs: HudShared, p: ProposalView): string {
  switch (p.kind) {
    case 'peace': {
      const tm = p.terms ?? { kind: 'white' };
      if (tm.kind === 'cede') return t('proposal.what.peaceCede', { tiles: formatNumber(tm.tiles ?? 0), loser: tm.loser === HUMAN_ID ? t('proposal.you') : hs.name(tm.loser ?? 0) });
      if (tm.kind === 'tribute') return t('proposal.what.peaceTribute', { loser: tm.loser === HUMAN_ID ? t('proposal.you') : hs.name(tm.loser ?? 0) });
      return t('proposal.what.peaceWhite');
    }
    case 'callToArms':
      return t('proposal.what.callToArms', { enemy: hs.name(p.target) });
    case 'demand': {
      const d = p.demand;
      if (!d) return t('proposal.what.demand');
      if (d.kind === 'cede') return t('proposal.what.demandCede', { tiles: formatNumber(d.tiles ?? 0) });
      if (d.kind === 'tribute') return t('proposal.what.demandTribute', { gold: formatCompact(d.gold ?? 0) });
      if (d.kind === 'breakAlliance') return t('proposal.what.demandBreak', { name: hs.name(d.target ?? 0) });
      if (d.kind === 'endEmbargo') return t('proposal.what.demandEmbargo');
      return t('proposal.what.demandWithdraw');
    }
    default:
      return t(`proposal.what.${p.kind}`);
  }
}

/** Game hours and real seconds left on a pending inbox item («48 h · ≥ 38 s reales»). */
export function inboxCountdown(hs: HudShared, p: ProposalView): { hours: number; realSec: number; text: string } {
  const v = hs.ctx.sim.view;
  const hours = Math.max(0, Math.ceil((p.expiresTick - v.tick) / 10));
  const extra = v.speed > 0 ? performance.now() - v.proposalsAtMs : 0;
  const floorLeft = Math.max(0, (INBOX_MIN_REAL_MS - p.realMs - extra) / 1000);
  // Real seconds at the current speed for the game-time part (1x: 1 h = 1 s), never under the floor.
  const rate = v.clock.rate > 0 ? v.clock.rate : 3600;
  const bySpeed = (hours * 3600) / rate;
  const realSec = Math.ceil(Math.max(floorLeft, bySpeed));
  const key = floorLeft >= bySpeed ? 'inbox.countdown.floor' : 'inbox.countdown';
  return { hours, realSec, text: t(key, { hours: formatNumber(hours), secs: formatNumber(realSec) }) };
}

/** Deliberation left on a proposal the AI is studying (game hours). */
export function deliberationLeft(hs: HudShared, p: ProposalView): number {
  return Math.max(0, Math.ceil((p.decideTick - hs.ctx.sim.view.tick) / 10));
}

export function deliberationRange(kind: ProposalView['kind']): string {
  const [lo, hi] = DELIBERATION_TICKS[kind];
  return t('proposal.delib', { lo: Math.round(lo / 10), hi: Math.round(hi / 10) });
}

/**
 * Preview of the band `loser` would hand to `winner`: `loser`'s tiles breadth-first from their common border, up to
 * `depth` tiles deep, the first `n` of them (the order the sim transfers them in).
 */
export function previewBand(hs: HudShared, loser: number, winner: number, n: number, depth = 4): number[] {
  const own = hs.ctx.sim.view.owner;
  const out: number[] = [];
  const seen = new Map<number, number>();
  const nb = new Int32Array(4);
  for (let i = 0; i < TILE_COUNT; i++) {
    if (own[i] !== loser) continue;
    const k = neighbors4(i, nb);
    for (let j = 0; j < k; j++) {
      if (own[nb[j]] === winner) {
        seen.set(i, 0);
        out.push(i);
        break;
      }
    }
  }
  for (let i = 0; i < out.length && out.length < n * 3 + 64; i++) {
    const d = seen.get(out[i])!;
    if (d + 1 > depth) continue;
    const k = neighbors4(out[i], nb);
    for (let j = 0; j < k; j++) {
      const q = nb[j];
      if (own[q] !== loser || seen.has(q)) continue;
      seen.set(q, d + 1);
      out.push(q);
    }
  }
  return out.slice(0, Math.max(0, n));
}

/** Centre of a tile list (for flying to a band). */
export function bandCentre(tiles: number[]): { lat: number; lon: number } | null {
  if (!tiles.length) return null;
  let sx = 0, sy = 0;
  const x0 = tiles[0] % MAP_W;
  for (const tl of tiles) {
    let x = tl % MAP_W;
    if (x - x0 > MAP_W / 2) x -= MAP_W;
    if (x0 - x > MAP_W / 2) x += MAP_W;
    sx += x;
    sy += (tl / MAP_W) | 0;
  }
  const cx = Math.round(sx / tiles.length), cy = Math.round(sy / tiles.length);
  return tileToLatLon(((cy * MAP_W + ((cx % MAP_W) + MAP_W) % MAP_W)) | 0);
}

/** The feed entry for a proposal event involving the human (§8.2). */
export function proposalAlert(hs: HudShared, p: ProposalView): AlertInput | null {
  const v = hs.ctx.sim.view;
  const other = p.from === HUMAN_ID ? p.to : p.from;
  const name = hs.name(other);
  const what = proposalWhat(hs, p);
  const groupKey = `prop:${p.id}`;
  const base: Pick<AlertInput, 'actors' | 'groupKey' | 'proposalId'> = { actors: [other], groupKey, proposalId: p.id };
  if (p.from === HUMAN_ID) {
    if (p.status === 'considering') {
      return { ...base, kind: 'proposalSent', severity: 'info', icon: 'scroll', ttlSec: 40, title: t('proposal.studying', { name }), body: t('proposal.studying.body', { what, delib: deliberationRange(p.kind) }) };
    }
    if (p.status === 'pending') return null;
    const good = p.status === 'accepted';
    const sev = good ? 'info' : p.status === 'expired' || p.status === 'cancelled' ? 'info' : 'warning';
    const title = t(`proposal.answer.${p.status}`, { name, what });
    const body = reasonsQuoted(hs, p.reasons) + (p.gold > 0 ? ` · ${t(good ? 'proposal.goldPaid' : 'proposal.goldBack', { gold: formatCompact(p.gold) })}` : '');
    const kind = p.status === 'expired' || p.status === 'cancelled' ? 'proposalExpired' : 'proposalAnswered';
    return { ...base, kind, severity: sev, icon: good ? 'check' : 'scroll', ttlSec: 45, title, body };
  }
  // Addressed to the human.
  if (p.status === 'pending') {
    const cd = inboxCountdown(hs, p);
    let kind = 'proposal', severity: AlertInput['severity'] = 'info', autoPause: AlertInput['autoPause'] = 'proposal', icon = 'scroll';
    let title = t(p.counterOf ? 'proposal.incoming.counter' : 'proposal.incoming', { name, what });
    let tiles: number[] | undefined;
    let lat: number | undefined, lon: number | undefined;
    if (p.kind === 'peace') {
      kind = 'peaceOffer';
      autoPause = 'peaceOffer';
      icon = 'peace';
      if (p.terms?.kind === 'cede' && p.terms.loser === HUMAN_ID) tiles = previewBand(hs, HUMAN_ID, other, p.terms.tiles ?? 0);
    } else if (p.kind === 'callToArms') {
      kind = 'callToArms';
      severity = 'warning';
      autoPause = 'callToArms';
      icon = 'helpCall';
      title = t('proposal.incoming.callToArms', { name, enemy: hs.name(p.target) });
    } else if (p.kind === 'demand') {
      icon = 'demand';
      if (p.ultimatum) {
        kind = 'ultimatum';
        severity = 'danger';
        autoPause = 'ultimatum';
        title = t('proposal.incoming.ultimatum', { name, what, hours: formatNumber(cd.hours) });
      } else {
        severity = 'warning';
        title = t('proposal.incoming.demand', { name, what });
      }
      if (p.demand?.kind === 'cede') tiles = previewBand(hs, HUMAN_ID, other, p.demand.tiles ?? 0);
    } else if (p.kind === 'alliance') icon = 'alliance';
    else if (p.kind === 'nap') icon = 'nap';
    else if (p.kind === 'trade') icon = 'trade';
    else if (p.kind === 'openBorders') icon = 'openBorders';
    if (tiles && tiles.length) {
      const c = bandCentre(tiles);
      if (c) {
        lat = c.lat;
        lon = c.lon;
      }
    }
    const body = t(p.ultimatum ? 'proposal.incoming.ultimatumBody' : 'proposal.incoming.body', { countdown: cd.text, place: tiles && tiles.length ? describeTile(v, tiles[0]).name : '' });
    return { ...base, kind, severity, autoPause, icon, title, body, sticky: true, tiles, lat, lon };
  }
  if (p.status === 'expired') return { ...base, kind: 'proposalExpired', severity: 'info', icon: 'clock', ttlSec: 20, title: t('proposal.expired', { name, what }), body: t('proposal.expired.body') };
  if (p.status === 'cancelled') return { ...base, kind: 'proposalExpired', severity: 'info', icon: 'scroll', ttlSec: 15, title: t('proposal.cancelled', { name, what }), body: reasonsQuoted(hs, p.reasons) };
  // Answered by the human: the entry closes (the treaty, the peace or the war it starts has its own alert).
  return null;
}
