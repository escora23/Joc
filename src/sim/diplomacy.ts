// FRONT ULTRA — diplomacy (DESIGN_V2 §5.1–§5.6, §14.10). Owner: sim-core (W3). Worker-only.
//
// DiplomacySystem keeps what nations think of each other and what they have signed:
//
//   * Opinions (§5.1): every AI nation holds an opinion of every other player, −100…+100, as a sum of REASONS. Standing
//     reasons (a long border, a threatening neighbour, a treaty, a common enemy, a war, an embargo, personality) are
//     read from the world when asked; remembered reasons (a gift, a past war, a betrayal, a nuclear strike, a refused
//     call to arms…) are kept in a per-pair ledger with a half-life and decay in whole game days. The AIs' opinions of
//     the human are published with their reasons (TickUpdate.opinions).
//   * Treaties (§5.2): alliances (open-ended, 48 h notice to leave), non-aggression pacts (30 days), trade agreements
//     (+20 % trade gold between the pair) and open borders. A war ends every treaty of the pair. Breaking an alliance,
//     a pact or a truce by declaring war is a betrayal (§5.6): the war system asks `betrayalOf` at the declaration.
//   * Proposals (§5.3): every request (treaty, peace terms, call to arms, demand) is a proposal with a deliberation. An
//     AI receiver answers at `decideTick` through the AI director (ai/diplomacy.ts answerProposal) with the one or two
//     strongest reasons and, when it has one, a counter-offer. A human receiver answers from the inbox: the item waits
//     720 ticks (peace 1,200, call to arms 240, a demand its deadline) and never expires before it has been pending 60
//     unpaused real seconds (the worker reports real time with addRealTime). Expiry is never a refusal.
//   * Tension and ultimatums (§5.4): an AI states a grievance before any war (issueTension) and may issue a demand with
//     a deadline (issueUltimatum); an accepted ultimatum buys ULTIMATUM_PEACE_TICKS without war from that nation.
//   * Calls to arms (§5.5): the target of a declaration calls its allies; any player may ask its allies for help against
//     an enemy («Pedir ayuda»). Three refusals end an alliance; an expired call is not a refusal.
//
// v1 commands map onto proposals: allianceRequest → propose alliance, allianceReply → answer, breakAlliance → leave
// with notice, targetPlayer → calls to arms; emotes are gone (§1.3, H02).

import {
  ALLIANCE_NOTICE_TICKS, CESSION_DEPTH, CESSION_MAX_SHARE, DELIBERATION_TICKS, DEMAND_BAND_SHARE, DEMAND_TRIBUTE_MAX,
  DIFFICULTY_INDEX, HUMAN_ID, INBOX_MIN_REAL_MS, INBOX_TICKS, NAP_TICKS, OPINION_PERIOD_TICKS, PROPOSAL_COOLDOWN_TICKS,
  TICKS_PER_GAME_DAY, TRAITOR_TICKS, TREATY_WARNING_TICKS, ULTIMATUM_PEACE_TICKS, ULTIMATUM_TICKS,
} from '../shared/constants';
import type { SimEvent } from '../shared/protocol';
import type { ProposalAnswer, SimProposal } from '../shared/simapi';
import {
  StructureType, UnitType, type AllianceRequestView, type AllianceView, type Demand, type OpinionView, type PeaceTerms,
  type ProposalKind, type ProposalStatus, type ProposalView, type ReasonView, type TreatyKind, type TreatyView,
} from '../shared/types';
import { PERSONALITY } from './ai/profiles';
import { DONATE_COOLDOWN } from './balance';
import type { Game } from './game';
import type { Player } from './state';

const pairKey = (a: number, b: number): number => (a < b ? a * 4096 + b : b * 4096 + a);
/** Directed key: `of`'s view of `toward`. */
const dirKey = (of: number, toward: number): number => of * 4096 + toward;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Remembered reasons (§5.1): value, half-life in ticks, and the most the reason may add up to. */
export const REMEMBERED = {
  tradeVolume: { value: 1, halfLife: 2_400, cap: 10 },
  pastWar: { value: -30, halfLife: 4_800, cap: 30 },
  betrayedUs: { value: -60, halfLife: 9_600, cap: 60 },
  reputationTraitor: { value: -15, halfLife: 4_800, cap: 15 },
  unprovokedWar: { value: -10, halfLife: 4_800, cap: 10 },
  attackedAlly: { value: -30, halfLife: 4_800, cap: 30 },
  nuclearUse: { value: -25, halfLife: 7_200, cap: 25 },
  nukedUsOrAlly: { value: -90, halfLife: 14_400, cap: 90 },
  incursion: { value: -15, halfLife: 1_200, cap: 15 },
  gift: { value: 0, halfLife: 2_400, cap: 25 },
  rejectedUltimatum: { value: -15, halfLife: 2_400, cap: 15 },
  acceptedUltimatum: { value: 10, halfLife: 2_400, cap: 10 },
  refusedCallToArms: { value: -20, halfLife: 4_800, cap: 40 },
  answeredCallToArms: { value: 20, halfLife: 7_200, cap: 40 },
  leftAlliance: { value: -20, halfLife: 2_400, cap: 20 },
  leftTreaty: { value: -5, halfLife: 2_400, cap: 5 },
  demandedOfUs: { value: -5, halfLife: 2_400, cap: 10 },
} as const;
export type RememberedKey = keyof typeof REMEMBERED;

interface Remembered {
  key: string;
  value: number;
  tick: number;
  halfLife: number;
  cap: number;
  params?: Record<string, string | number>;
}

interface TreatyRec {
  a: number;
  b: number;
  kind: TreatyKind;
  sinceTick: number;
  untilTick: number;
  leavingTick: number;
  leaver: number;
  warned: boolean;
}

interface ProposalRec {
  id: number;
  from: number;
  to: number;
  kind: ProposalKind;
  terms?: PeaceTerms;
  demand?: Demand;
  war: number;
  target: number;
  gold: number;
  createdTick: number;
  decideTick: number;
  expiresTick: number;
  realMs: number;
  status: ProposalStatus;
  resolvedTick: number;
  reasons?: ReasonView[];
  counterId?: number;
  counterOf?: number;
  ultimatum?: boolean;
}

export interface ProposeOptions {
  terms?: PeaceTerms;
  demand?: Demand;
  war?: number;
  against?: number;
  gold?: number;
  /** A demand with a deadline and the threat of war (issueUltimatum). */
  ultimatum?: boolean;
  /** A counter-offer to proposal `counterOf`. */
  counterOf?: number;
  /** Skip the cooldown and duplicate checks (the system's own calls to arms, counter-offers). */
  system?: boolean;
  /** Override the inbox deadline (ultimatums). */
  expiresIn?: number;
  /** Do not announce yet (the caller announces it after the answer it belongs to). */
  silent?: boolean;
}

const OPEN = (r: { status: ProposalStatus }): boolean => r.status === 'considering' || r.status === 'pending';

export class DiplomacySystem {
  /** Remembered reasons per directed pair (dirKey). */
  private readonly ledger = new Map<number, Remembered[]>();
  /** Treaties per pair. */
  private readonly treaties = new Map<number, TreatyRec[]>();
  private readonly proposals = new Map<number, ProposalRec>();
  /** Answered proposals involving the human, newest last (the inbox history, saved). */
  private history: ProposalRec[] = [];
  /** Tension stated by `of` toward `toward` (dirKey) -> [tick, reason key]. */
  private readonly tension = new Map<number, [number, string]>();
  /** Accepted ultimatum: no war from `of` on `toward` before this tick (dirKey). */
  private readonly noWar = new Map<number, number>();
  /** Refused calls to arms: dirKey(asker, refuser) -> count (three end the alliance). */
  private readonly refused = new Map<number, number>();
  /** Cooldown after a rejection: `${from},${to},${kind}` -> tick. */
  private readonly cooldown = new Map<string, number>();
  private nextId = 1;
  /** Largest nation and its share of the world's land (runawayLeader), refreshed every game day. */
  private leader = 0;
  private leaderShare = 0;
  treatiesDirty = true;
  proposalsDirty = true;
  opinionsDirty = true;
  /** Set by the worker: the human's inbox honours the unpaused-real-time floor (headless runs have no human). */
  realTimeFloor = false;
  /** Opinion cache for the current tick (not saved). */
  private cacheTick = -1;
  private readonly cache = new Map<number, { score: number; reasons: ReasonView[] }>();

  constructor(private readonly g: Game) {}

  // =================================================================================================
  // Opinions (§5.1)
  // =================================================================================================
  /** `of`'s opinion of `toward`, −100…+100 (0 for players without opinions: the human, tribes, rebels). */
  opinion(of: number, toward: number): number {
    return this.evaluate(of, toward).score;
  }

  /** The reasons behind `of`'s opinion of `toward`, strongest first. */
  reasons(of: number, toward: number): ReasonView[] {
    return this.evaluate(of, toward).reasons;
  }

  /** Remember a reason (accumulates up to its cap; re-stamped now). */
  addReason(of: number, toward: number, key: RememberedKey | string, value?: number, params?: Record<string, string | number>): void {
    if (of === toward || of <= 0 || toward <= 0) return;
    const P = this.g.playerById[of];
    if (!P || P.kind !== 'nation') return;
    const spec = (REMEMBERED as Record<string, { value: number; halfLife: number; cap: number }>)[key] ?? { value: value ?? 0, halfLife: 4_800, cap: Math.abs(value ?? 0) };
    const v = value ?? spec.value;
    if (v === 0) return;
    const k = dirKey(of, toward);
    let list = this.ledger.get(k);
    if (!list) this.ledger.set(k, (list = []));
    const day = this.dayTick();
    let r = list.find((x) => x.key === key);
    if (r) {
      r.value = clamp(this.decayed(r, day) + v, -r.cap, r.cap);
      r.tick = day;
      if (params) r.params = params;
    } else {
      r = { key, value: clamp(v, -spec.cap, spec.cap), tick: day, halfLife: spec.halfLife, cap: spec.cap, params };
      list.push(r);
    }
    this.cacheTick = -1;
    if (toward === HUMAN_ID) this.opinionsDirty = true;
  }

  /** Gift value (§5.1): +1 per 5 % of one day of the receiver's income, at most +25. */
  giftValue(receiver: number, gold: number): number {
    const R = this.g.playerById[receiver];
    if (!R || !(gold > 0)) return 0;
    const day = Math.max(1, Math.max(R.income, R.incomeEma) * TICKS_PER_GAME_DAY);
    return clamp(Math.round(gold / (0.05 * day)), 1, 25);
  }

  /** Decay is evaluated in whole game days (§5.1), so a published reason does not flicker between updates. */
  private dayTick(): number {
    return Math.floor(this.g.tick / OPINION_PERIOD_TICKS) * OPINION_PERIOD_TICKS;
  }

  private decayed(r: Remembered, day: number): number {
    return r.value * Math.pow(0.5, Math.max(0, day - r.tick) / r.halfLife);
  }

  private evaluate(of: number, toward: number): { score: number; reasons: ReasonView[] } {
    const g = this.g;
    if (this.cacheTick !== g.tick) {
      this.cache.clear();
      this.cacheTick = g.tick;
    }
    const k = dirKey(of, toward);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const P = g.playerById[of], Q = g.playerById[toward];
    const out: ReasonView[] = [];
    if (P && Q && P.kind === 'nation' && of !== toward && P.alive) {
      this.standing(P, Q, out);
      const list = this.ledger.get(k);
      if (list) {
        const day = this.dayTick();
        for (let i = list.length - 1; i >= 0; i--) {
          const v = this.decayed(list[i], day);
          if (Math.abs(v) < 0.5) {
            list.splice(i, 1);
            continue;
          }
          out.push({ key: `diplo.reason.${list[i].key}`, value: Math.round(v), params: list[i].params });
        }
      }
    }
    let score = 0;
    for (const r of out) score += r.value ?? 0;
    out.sort((x, y) => Math.abs(y.value ?? 0) - Math.abs(x.value ?? 0));
    const res = { score: clamp(Math.round(score), -100, 100), reasons: out };
    this.cache.set(k, res);
    return res;
  }

  /** Reasons that hold while a condition holds (§5.1). */
  private standing(P: Player, Q: Player, out: ReasonView[]): void {
    const g = this.g;
    const push = (key: string, value: number, params?: Record<string, string | number>) => {
      const v = Math.round(value);
      if (v !== 0) out.push({ key: `diplo.reason.${key}`, value: v, params });
    };
    const c = g.contactCount(P.id, Q.id);
    if (c > 60) push('borderLong', -10);
    else if (c > 0) push('borderShort', -3);
    if (c > 0 && Q.tiles >= P.tiles * 2) push('sizeThreat', -Math.min(20, 5 + 7.5 * (Q.tiles / Math.max(1, P.tiles) - 2)));
    // runawayLeader: from 15 % of the world's land (the world starts to fear an empire), full at 35 %.
    if (this.leader === Q.id && this.leaderShare > 0.15) {
      const coalition = PERSONALITY[P.personality ?? 'opportunist']?.coalition ?? 0.5;
      push('runawayLeader', -30 * Math.min(1, (this.leaderShare - 0.15) / 0.2) * Math.min(1, 0.5 + coalition));
    }
    for (const t of this.treaties.get(pairKey(P.id, Q.id)) ?? []) {
      if (t.kind === 'alliance') push('alliance', 25);
      else if (t.kind === 'nap') push('nap', 10);
      else if (t.kind === 'trade') push('tradeAgreement', 15);
      else push('openBorders', 5);
    }
    if (g.war.atWar(P.id, Q.id)) push('atWar', -60);
    else {
      for (const e of g.war.enemiesOf(P.id)) {
        if (e !== Q.id && g.war.atWar(Q.id, e)) {
          push('commonEnemy', 20, { player: e });
          break;
        }
      }
    }
    if (Q.embargoes.has(P.id)) push('embargoOnUs', -20);
    // Personality affinity: traders like traders, conquerors distrust conquerors (the human has no personality).
    if (Q.personality && P.personality === Q.personality) {
      const v = P.personality === 'trader' ? 10 : P.personality === 'turtle' ? 5 : P.personality === 'conqueror' ? -10 : P.personality === 'nuker' ? -5 : 0;
      push(v > 0 ? 'personalityLike' : 'personalityDistrust', v);
    } else if (Q.personality === 'conqueror' && P.personality === 'turtle') push('personalityDistrust', -5);
  }

  private refreshLeader(): void {
    let top: Player | null = null;
    for (const p of this.g.playerArr) {
      if (!p.alive || (p.kind !== 'nation' && p.kind !== 'human')) continue;
      if (!top || p.tiles > top.tiles) top = p;
    }
    this.leader = top ? top.id : 0;
    this.leaderShare = top ? top.tiles / Math.max(1, this.g.landTiles) : 0;
  }

  // =================================================================================================
  // Treaties (§5.2)
  // =================================================================================================
  hasTreaty(a: number, b: number, kind: TreatyKind): boolean {
    if (a === b) return false;
    const list = this.treaties.get(pairKey(a, b));
    return !!list && list.some((t) => t.kind === kind);
  }

  treaty(a: number, b: number, kind: TreatyKind): TreatyRec | undefined {
    return this.treaties.get(pairKey(a, b))?.find((t) => t.kind === kind);
  }

  treatiesOf(p: number): TreatyView[] {
    const out: TreatyView[] = [];
    for (const list of this.treaties.values()) for (const t of list) if (t.a === p || t.b === p) out.push(this.treatyView(t));
    return out;
  }

  /** Divisions of `unitOwner` may be on land of `tileOwner`: its own, an ally's or with open borders (§5.2). */
  canTransit(unitOwner: number, tileOwner: number): boolean {
    if (unitOwner === tileOwner || tileOwner === 0) return true;
    if (this.g.isAllied(unitOwner, tileOwner)) return true;
    return this.hasTreaty(unitOwner, tileOwner, 'openBorders');
  }

  /** Trade gold multiplier between two players (+20 % with a trade agreement, §5.2). */
  tradeMul(a: number, b: number): number {
    return this.hasTreaty(a, b, 'trade') ? 1.2 : 1;
  }

  /** What declaring war on `target` would break (§5.6): 'alliance', 'nap', 'truce' or null. */
  betrayalOf(aggressor: number, target: number): 'alliance' | 'nap' | 'truce' | null {
    if (this.g.isAllied(aggressor, target)) return 'alliance';
    if (this.hasTreaty(aggressor, target, 'nap')) return 'nap';
    if (this.g.war.pairState(aggressor, target) === 'truce') return 'truce';
    return null;
  }

  private sign(a: number, b: number, kind: TreatyKind, reasonKey: string): boolean {
    const g = this.g;
    if (this.hasTreaty(a, b, kind) || g.war.atWar(a, b)) return false;
    const k = pairKey(a, b);
    let list = this.treaties.get(k);
    if (!list) this.treaties.set(k, (list = []));
    const t: TreatyRec = {
      a: Math.min(a, b), b: Math.max(a, b), kind, sinceTick: g.tick, untilTick: kind === 'nap' ? g.tick + NAP_TICKS : 0,
      leavingTick: 0, leaver: 0, warned: false,
    };
    list.push(t);
    if (kind === 'alliance') {
      const pa = g.playerById[a]!, pb = g.playerById[b]!;
      pa.allies.add(b);
      pb.allies.add(a);
      pa.metaDirty = pb.metaDirty = true;
      pa.tempEmbargo.delete(b);
      pb.tempEmbargo.delete(a);
      g.attacks.cancelBetween(a, b);
      g.hostility.delete(g.pairKey(a, b));
      g.alliancesDirty = true;
      g.emit({ type: 'allianceFormed', tick: g.tick, a, b });
    }
    this.touch(a, b);
    g.emit({ type: 'treatyChanged', tick: g.tick, a, b, treaty: kind, active: true, reasonKey });
    return true;
  }

  /** End a treaty now (expiry, notice run out, war, refusals, a player gone). */
  private end(a: number, b: number, kind: TreatyKind, reasonKey: string): boolean {
    const g = this.g;
    const k = pairKey(a, b);
    const list = this.treaties.get(k);
    if (!list) return false;
    const i = list.findIndex((t) => t.kind === kind);
    if (i < 0) return false;
    list.splice(i, 1);
    if (list.length === 0) this.treaties.delete(k);
    if (kind === 'alliance') {
      const pa = g.playerById[a], pb = g.playerById[b];
      pa?.allies.delete(b);
      pb?.allies.delete(a);
      if (pa) pa.metaDirty = true;
      if (pb) pb.metaDirty = true;
      g.alliancesDirty = true;
    }
    this.touch(a, b);
    g.emit({ type: 'treatyChanged', tick: g.tick, a, b, treaty: kind, active: false, reasonKey });
    return true;
  }

  /**
   * Leave a treaty (§5.2): an alliance after 48 h of notice (−20 opinion from the partner), the others at once (−5).
   * v1's breakAlliance command lands here: leaving is never a betrayal; declaring war on a partner is.
   */
  leaveTreaty(p: Player, target: number, kind: TreatyKind): boolean {
    const g = this.g;
    const t = this.treaty(p.id, target, kind);
    if (!t) {
      g.message(p.id, 'msg.noTreaty');
      return false;
    }
    if (kind === 'nap') {
      // A pact binds for its term: leaving early is only possible by declaring war (a betrayal).
      g.message(p.id, 'msg.napBinding', 'warning', { hours: Math.max(0, Math.round((t.untilTick - g.tick) / 10)) });
      return false;
    }
    if (kind === 'alliance') {
      if (t.leavingTick > 0) return false;
      t.leavingTick = g.tick + ALLIANCE_NOTICE_TICKS;
      t.leaver = p.id;
      this.touch(p.id, target);
      g.emit({ type: 'treatyChanged', tick: g.tick, a: p.id, b: target, treaty: kind, active: true, reasonKey: 'treaty.reason.notice', leavingTick: t.leavingTick });
      this.addReason(target, p.id, 'leftAlliance');
      return true;
    }
    this.addReason(target, p.id, 'leftTreaty');
    return this.end(p.id, target, kind, 'treaty.reason.left');
  }

  private touch(a: number, b: number): void {
    this.treatiesDirty = true;
    this.cacheTick = -1;
    if (a === HUMAN_ID || b === HUMAN_ID) this.opinionsDirty = true;
  }

  // =================================================================================================
  // War hooks (called by WarSystem)
  // =================================================================================================
  /**
   * A war was declared (§4.2, §5.6): the pair's treaties end, the aggressor's reputation pays for a betrayal and for an
   * unprovoked war, the target's allies resent it; open proposals between them are cancelled.
   */
  onWarDeclared(aggressor: number, target: number, goal: string, join: boolean, betrayal: 'alliance' | 'nap' | 'truce' | null): void {
    const g = this.g;
    for (const t of [...(this.treaties.get(pairKey(aggressor, target)) ?? [])]) {
      if (t.kind === 'alliance' && betrayal === 'alliance') this.breakAllianceForWar(aggressor, target);
      else this.end(aggressor, target, t.kind, betrayal ? 'treaty.reason.betrayal' : 'treaty.reason.war');
    }
    for (const r of [...this.proposals.values()]) {
      if (!OPEN(r)) continue;
      const pair = (r.from === aggressor && r.to === target) || (r.from === target && r.to === aggressor);
      if (pair && r.kind !== 'peace') this.close(r, 'cancelled', [{ key: 'answer.warStarted' }]);
    }
    if (betrayal) {
      this.addReason(target, aggressor, 'betrayedUs', undefined, { treaty: betrayal });
      for (const p of g.playerArr) if (p.id !== aggressor && p.id !== target && p.alive && p.kind === 'nation') this.addReason(p.id, aggressor, 'reputationTraitor');
    }
    if (join) return;
    const provoked = goal === 'retaliation' || goal === 'defense' || goal === 'liberation' || goal === 'coalition' || this.opinion(target, aggressor) <= -50;
    const T = g.playerById[target];
    for (const p of g.playerArr) {
      if (!p.alive || p.kind !== 'nation' || p.id === aggressor || p.id === target) continue;
      if (T && T.allies.has(p.id)) this.addReason(p.id, aggressor, 'attackedAlly', undefined, { player: target });
      else if (!provoked && !p.allies.has(aggressor)) this.addReason(p.id, aggressor, 'unprovokedWar', undefined, { player: target });
    }
    this.opinionsDirty = true;
  }

  /** A war ended: both remember it (§5.1 pastWar); its open peace proposals and calls to arms are settled. */
  onWarEnded(a: number, b: number): void {
    this.addReason(a, b, 'pastWar');
    this.addReason(b, a, 'pastWar');
    for (const r of [...this.proposals.values()]) {
      if (!OPEN(r)) continue;
      const pair = (r.from === a && r.to === b) || (r.from === b && r.to === a);
      if (pair && r.kind === 'peace') this.close(r, 'cancelled', [{ key: 'answer.warOver' }]);
      else if (r.kind === 'callToArms' && ((r.from === a && r.target === b) || (r.from === b && r.target === a))) this.close(r, 'cancelled', [{ key: 'answer.warOver' }]);
    }
    this.opinionsDirty = true;
  }

  /** Remembered sim events: gifts, trade, nuclear use (§5.1). */
  onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'donation':
        // Troops count at twice their number in gold (roughly what recruiting them would cost in a day).
        if (e.gold > 0 || e.troops > 0) this.addReason(e.to, e.from, 'gift', this.giftValue(e.to, e.gold + e.troops * 2), { gold: e.gold, troops: e.troops });
        return;
      case 'tradeCompleted':
        if (e.partner > 0 && e.partner !== e.owner) {
          this.addReason(e.owner, e.partner, 'tradeVolume');
          this.addReason(e.partner, e.owner, 'tradeVolume');
        }
        return;
      case 'nukeLaunched': {
        if (e.weapon === UnitType.CruiseMissile || e.weapon === UnitType.MirvWarhead) return;
        const g = this.g;
        const victim = g.playerById[e.targetOwner];
        for (const p of g.playerArr) {
          if (!p.alive || p.kind !== 'nation' || p.id === e.owner) continue;
          if (p.id === e.targetOwner || (victim && victim.allies.has(p.id))) this.addReason(p.id, e.owner, 'nukedUsOrAlly', undefined, { player: e.targetOwner });
          else this.addReason(p.id, e.owner, 'nuclearUse');
        }
        return;
      }
    }
  }

  // =================================================================================================
  // Tension, ultimatums (§5.4)
  // =================================================================================================
  /** An AI states a grievance publicly (the warning that precedes any war, T9). */
  issueTension(from: number, to: number, reasonKey: string, params: Record<string, string | number> = {}): void {
    const g = this.g;
    this.tension.set(dirKey(from, to), [g.tick, reasonKey]);
    g.war.recordTension(from, to);
    if (to === HUMAN_ID) this.opinionsDirty = true;
    g.emit({ type: 'tension', tick: g.tick, from, to, reasonKey, params });
  }

  lastTension(from: number, to: number): number {
    return this.tension.get(dirKey(from, to))?.[0] ?? -1;
  }

  /** A demand with a deadline (§5.4): «cede la franja … en 24 h o habrá guerra». */
  issueUltimatum(from: number, to: number, demand: Demand): SimProposal | null {
    const d = DIFFICULTY_INDEX[this.g.difficulty];
    return this.propose(from, to, 'demand', { demand, ultimatum: true, system: true, expiresIn: ULTIMATUM_TICKS[d] });
  }

  /** No war from `of` on `toward` before this tick (an accepted ultimatum). */
  noWarUntil(of: number, toward: number): number {
    return this.noWar.get(dirKey(of, toward)) ?? 0;
  }

  refusals(asker: number, refuser: number): number {
    return this.refused.get(dirKey(asker, refuser)) ?? 0;
  }

  // =================================================================================================
  // Proposals (§5.3)
  // =================================================================================================
  proposal(id: number): SimProposal | undefined {
    return this.proposals.get(id) ?? this.history.find((r) => r.id === id);
  }

  /** Open proposals (considering or pending), optionally involving `p`. */
  openProposals(p = 0): SimProposal[] {
    const out: SimProposal[] = [];
    for (const r of this.proposals.values()) {
      if (!OPEN(r)) continue;
      if (p === 0 || r.from === p || r.to === p) out.push(r);
    }
    return out;
  }

  /** Why `from` may not send this proposal now (i18n key + params), or null. */
  proposeError(from: number, to: number, kind: ProposalKind, o: ProposeOptions = {}): [string, Record<string, string | number>?] | null {
    const g = this.g;
    const F = g.playerById[from], T = g.playerById[to];
    if (g.phase !== 'playing') return ['msg.notYet'];
    if (!F || !T || !F.alive || !T.alive || from === to || !F.spawned || !T.spawned) return ['msg.cannotPropose'];
    if (T.kind === 'tribe' || T.kind === 'rebel' || F.kind === 'tribe') return ['msg.cannotAllyTribe'];
    const gold = Math.max(0, Math.floor(o.gold ?? 0));
    if (gold > F.gold) return ['msg.notEnoughGold'];
    if (!o.system) {
      for (const r of this.proposals.values()) {
        if (OPEN(r) && r.from === from && r.to === to && r.kind === kind) return ['msg.proposalPending'];
      }
      const cd = this.cooldown.get(`${from},${to},${kind}`) ?? 0;
      if (cd > g.tick) return ['msg.proposalCooldown', { hours: Math.ceil((cd - g.tick) / 10) }];
    }
    const atWar = g.war.atWar(from, to);
    switch (kind) {
      case 'alliance': case 'nap': case 'trade': case 'openBorders':
        if (atWar) return ['msg.atWarNoAlliance'];
        if (this.hasTreaty(from, to, kind)) return ['msg.treatyExists'];
        if (kind === 'nap' && g.isAllied(from, to)) return ['msg.treatyExists'];
        if (kind === 'openBorders' && g.isAllied(from, to)) return ['msg.alliesTransit'];
        return null;
      case 'peace':
        if (!atWar) return ['msg.notAtWar'];
        if (!o.terms) return ['msg.cannotPropose'];
        if ((o.terms.kind === 'cede' || o.terms.kind === 'tribute') && o.terms.loser !== from && o.terms.loser !== to) return ['msg.cannotPropose'];
        return null;
      case 'callToArms': {
        const X = o.against ?? 0;
        if (!g.isAllied(from, to)) return ['msg.callAlliesOnly'];
        if (!(X > 0) || !g.war.atWar(from, X)) return ['msg.notAtWar'];
        if (g.war.atWar(to, X)) return ['msg.allyAlreadyAtWar'];
        if (g.isAllied(to, X)) return ['msg.allyAlliedToEnemy'];
        return null;
      }
      case 'demand': {
        const d = o.demand;
        if (!d) return ['msg.cannotPropose'];
        if (atWar) return ['msg.demandAtWar'];
        if (d.kind === 'cede' && !g.sharesBorder(from, to)) return ['msg.demandNoBorder'];
        if (d.kind === 'tribute' && !((d.gold ?? 0) > 0) && !((T.gold ?? 0) > 0)) return ['msg.cannotPropose'];
        if (d.kind === 'breakAlliance' && !(d.target && g.isAllied(to, d.target))) return ['msg.cannotPropose'];
        if (d.kind === 'endEmbargo' && !T.embargoes.has(from)) return ['msg.noEmbargo'];
        return null;
      }
    }
    return ['msg.cannotPropose'];
  }

  /**
   * Create a proposal. An AI receiver deliberates (DELIBERATION_TICKS); a human receiver finds it in the inbox. The
   * sweetener is held from the sender now and paid on acceptance (refunded otherwise).
   */
  propose(from: number, to: number, kind: ProposalKind, o: ProposeOptions = {}): ProposalRec | null {
    const g = this.g;
    const err = this.proposeError(from, to, kind, o);
    if (err) {
      g.message(from, err[0], 'warning', err[1] ?? {});
      return null;
    }
    const F = g.playerById[from]!, T = g.playerById[to]!;
    const gold = Math.max(0, Math.floor(o.gold ?? 0));
    const demand = o.demand ? this.clampDemand(from, to, o.demand) : undefined;
    const terms = o.terms ? this.clampTerms(o.terms) : undefined;
    const [lo, hi] = DELIBERATION_TICKS[kind];
    const human = T.kind === 'human';
    const deadline = o.expiresIn ?? (kind === 'peace' ? INBOX_TICKS.peace : kind === 'callToArms' ? INBOX_TICKS.callToArms : INBOX_TICKS.default);
    const war = kind === 'peace' ? g.war.between(from, to)?.id ?? 0 : kind === 'callToArms' ? g.war.between(from, o.against ?? 0)?.id ?? 0 : 0;
    const r: ProposalRec = {
      id: this.nextId++, from, to, kind, terms, demand, war, target: kind === 'callToArms' ? o.against ?? 0 : demand?.target ?? 0,
      gold, createdTick: g.tick, decideTick: human ? 0 : g.tick + lo + g.rngDiplo.int(hi - lo + 1),
      expiresTick: human ? g.tick + deadline : 0, realMs: 0, status: human ? 'pending' : 'considering', resolvedTick: 0,
    };
    if (o.counterOf) r.counterOf = o.counterOf;
    if (o.ultimatum) r.ultimatum = true;
    if (gold > 0) F.gold -= gold;
    this.proposals.set(r.id, r);
    if (kind === 'demand' && T.kind === 'nation' && F.kind === 'human') this.addReason(to, from, 'demandedOfUs');
    if (!o.silent) this.changed(r);
    return r;
  }

  /** A band ≤ 5 % of the receiver's land contiguous to the sender; a tribute of 20–40 % of its gold (§5.3, §5.4). */
  private clampDemand(from: number, to: number, d: Demand): Demand {
    const T = this.g.playerById[to]!;
    if (d.kind === 'cede') {
      const max = Math.max(1, Math.floor(T.tiles * DEMAND_BAND_SHARE));
      return { kind: 'cede', tiles: clamp(Math.floor(d.tiles ?? max), 1, max), target: from };
    }
    if (d.kind === 'tribute') return { kind: 'tribute', gold: Math.round(clamp(d.gold ?? T.gold * 0.3, 0, T.gold * DEMAND_TRIBUTE_MAX)) };
    return { ...d };
  }

  private clampTerms(t: PeaceTerms): PeaceTerms {
    if (t.kind === 'cede') {
      const L = this.g.playerById[t.loser ?? 0];
      const max = L ? Math.max(1, Math.floor(L.tiles * CESSION_MAX_SHARE)) : 0;
      return { kind: 'cede', loser: t.loser, tiles: clamp(Math.floor(t.tiles ?? max), 1, max) };
    }
    if (t.kind === 'tribute') return { kind: 'tribute', loser: t.loser };
    return { kind: 'white' };
  }

  /** The human (or an AI) answers a proposal addressed to it. */
  answer(p: Player, id: number, accept: boolean): boolean {
    const r = this.proposals.get(id);
    if (!r || r.to !== p.id || r.status !== 'pending') return false;
    if (accept) {
      const why = this.applyError(r);
      if (why) {
        this.g.message(p.id, why);
        return false;
      }
      this.accept(r, [{ key: 'answer.youAccepted' }]);
    } else this.reject(r, [{ key: 'answer.youRefused' }]);
    return true;
  }

  /** Can an accepted proposal still be carried out? i18n key or null. */
  private applyError(r: ProposalRec): string | null {
    const g = this.g;
    const F = g.playerById[r.from], T = g.playerById[r.to];
    if (!F || !T || !F.alive || !T.alive) return 'msg.cannotPropose';
    if (r.kind === 'callToArms' && (g.war.atWar(r.to, r.target) || !g.war.atWar(r.from, r.target))) return 'msg.allyAlreadyAtWar';
    if ((r.kind === 'alliance' || r.kind === 'nap' || r.kind === 'trade' || r.kind === 'openBorders') && g.war.atWar(r.from, r.to)) return 'msg.atWarNoAlliance';
    if (r.kind === 'peace' && !g.war.atWar(r.from, r.to)) return 'msg.notAtWar';
    return null;
  }

  private accept(r: ProposalRec, reasons: ReasonView[]): void {
    const g = this.g;
    r.status = 'accepted';
    r.resolvedTick = g.tick;
    r.reasons = reasons;
    const T = g.playerById[r.to]!;
    if (r.gold > 0) {
      T.gold += r.gold;
      g.emit({ type: 'donation', tick: g.tick, from: r.from, to: r.to, gold: r.gold, troops: 0 });
    }
    // The answer is announced before its consequences (the treaty, the peace, the war it starts).
    this.changed(r);
    switch (r.kind) {
      case 'alliance': case 'nap': case 'trade': case 'openBorders':
        // An alliance supersedes a pact.
        if (r.kind === 'alliance' && this.hasTreaty(r.from, r.to, 'nap')) this.end(r.from, r.to, 'nap', 'treaty.reason.superseded');
        this.sign(r.from, r.to, r.kind, 'treaty.reason.signed');
        break;
      case 'peace': {
        const t = r.terms ?? { kind: 'white' };
        g.war.makePeace(r.from, r.to, t, 'peace.reason.treaty', t.kind === 'cede' || t.kind === 'tribute' ? t.loser ?? 0 : 0);
        break;
      }
      case 'callToArms': {
        const w = g.war.get(r.war) ?? g.war.between(r.from, r.target);
        const offense = !!w && w.a === r.from;
        const joined = g.war.declare(r.to, r.target, offense ? 'coalition' : 'defense', offense ? 'war.reason.allyRequest' : 'war.reason.callToArms', { join: true, parentWar: w?.id ?? 0 });
        if (joined) this.addReason(r.from, r.to, 'answeredCallToArms', undefined, { player: r.target });
        break;
      }
      case 'demand':
        this.applyDemand(r.from, r.to, r.demand!);
        if (r.ultimatum) {
          this.noWar.set(dirKey(r.from, r.to), g.tick + ULTIMATUM_PEACE_TICKS);
          this.addReason(r.from, r.to, 'acceptedUltimatum');
          this.opinionsDirty = true;
        }
        break;
    }
  }

  private applyDemand(from: number, to: number, d: Demand): void {
    const g = this.g;
    const T = g.playerById[to]!;
    switch (d.kind) {
      case 'cede':
        g.war.cede(to, from, d.tiles ?? 0);
        break;
      case 'tribute': {
        const gold = Math.min(T.gold, d.gold ?? 0);
        if (gold <= 0) break;
        T.gold -= gold;
        g.addGold(from, gold);
        break;
      }
      case 'breakAlliance':
        if (d.target && g.isAllied(to, d.target)) {
          this.addReason(d.target, to, 'leftAlliance');
          this.end(to, d.target, 'alliance', 'treaty.reason.demand');
        }
        break;
      case 'endEmbargo':
        if (T.embargoes.has(from)) this.embargo(T, from, false);
        break;
      case 'withdraw':
        // Command-mode incursions (W5) pull the unit back; nothing else changes here.
        break;
    }
  }

  private reject(r: ProposalRec, reasons: ReasonView[], counter?: ProposalAnswer['counter']): void {
    const g = this.g;
    r.status = counter ? 'countered' : 'rejected';
    r.resolvedTick = g.tick;
    r.reasons = reasons;
    this.refund(r);
    this.cooldown.set(`${r.from},${r.to},${r.kind}`, g.tick + PROPOSAL_COOLDOWN_TICKS);
    let endAlliance = false;
    if (r.kind === 'callToArms') {
      this.addReason(r.from, r.to, 'refusedCallToArms', undefined, { player: r.target });
      const k = dirKey(r.from, r.to);
      const n = (this.refused.get(k) ?? 0) + 1;
      this.refused.set(k, n);
      if (n >= 3 && g.isAllied(r.from, r.to)) {
        this.refused.delete(k);
        endAlliance = true;
      }
      if (r.from === HUMAN_ID || r.to === HUMAN_ID) this.opinionsDirty = true;
    }
    if (r.kind === 'demand' && r.ultimatum) this.addReason(r.from, r.to, 'rejectedUltimatum');
    // Planned counter-offer first, so the answer event can name it.
    let c: ProposalRec | null = null;
    if (counter) {
      c = this.propose(r.to, r.from, counter.kind, { terms: counter.terms, counterOf: r.id, system: true, silent: true });
      if (c) r.counterId = c.id;
      else r.status = 'rejected';
    }
    // The counter-offer is announced after the answer that carries it.
    this.changed(r);
    if (c) this.changed(c);
    if (endAlliance) this.end(r.from, r.to, 'alliance', 'treaty.reason.refusals');
    // A nation that refuses the human's demand says so publicly: tension, never a war by itself (§5.3).
    if (r.kind === 'demand' && !r.ultimatum && g.playerById[r.from]?.kind === 'human' && g.playerById[r.to]?.kind === 'nation') {
      this.tension.set(dirKey(r.to, r.from), [g.tick, 'tension.demandRefused']);
      g.emit({ type: 'tension', tick: g.tick, from: r.to, to: r.from, reasonKey: 'tension.demandRefused', params: {} });
      this.opinionsDirty = true;
    }
  }

  /** Expired (never a refusal, §5.3) or cancelled (the situation changed). */
  private close(r: ProposalRec, status: 'expired' | 'cancelled', reasons: ReasonView[]): void {
    r.status = status;
    r.resolvedTick = this.g.tick;
    r.reasons = reasons;
    this.refund(r);
    this.changed(r);
  }

  private refund(r: ProposalRec): void {
    if (r.gold <= 0) return;
    const F = this.g.playerById[r.from];
    if (F && F.alive) F.gold += r.gold;
  }

  private changed(r: ProposalRec): void {
    const g = this.g;
    if (!OPEN(r) && this.proposals.get(r.id) === r) {
      this.proposals.delete(r.id);
      if (r.from === HUMAN_ID || r.to === HUMAN_ID) {
        this.history.push(r);
        if (this.history.length > 40) this.history.splice(0, this.history.length - 40);
      }
    }
    if (r.from === HUMAN_ID || r.to === HUMAN_ID) this.proposalsDirty = true;
    g.emit({ type: 'proposal', tick: g.tick, proposal: this.view(r) });
  }

  /** The AI (or the fallback) answers an AI-addressed proposal at its decide tick. */
  private decide(r: ProposalRec): void {
    const g = this.g;
    if (this.applyError(r)) {
      this.close(r, 'cancelled', [{ key: 'answer.obsolete' }]);
      return;
    }
    let ans: ProposalAnswer | null = null;
    try {
      ans = g.answerProposal(r);
    } catch {
      ans = null;
    }
    ans ??= this.defaultAnswer(r);
    if (ans.accept) this.accept(r, ans.reasons.length ? ans.reasons.slice(0, 2) : [{ key: 'answer.agreed' }]);
    else this.reject(r, ans.reasons.length ? ans.reasons.slice(0, 2) : [{ key: 'answer.declined' }], ans.counter);
  }

  /** Minimal evaluation when the AI director does not answer (fallback AI): the opinion thresholds of §5.2. */
  defaultAnswer(r: SimProposal): ProposalAnswer {
    const o = this.opinion(r.to, r.from) + this.giftValue(r.to, r.gold);
    const need: Record<ProposalKind, number> = { alliance: 35, nap: 0, trade: -10, openBorders: 20, peace: -100, callToArms: 20, demand: 1000 };
    if (r.kind === 'peace') {
      const ex = this.g.war.exhaustion(r.to);
      return ex >= 35 ? { accept: true, reasons: [{ key: 'answer.exhausted', params: { ex: Math.round(ex) } }] } : { accept: false, reasons: [{ key: 'answer.notTired', params: { ex: Math.round(ex) } }] };
    }
    const ok = o >= need[r.kind];
    return { accept: ok, reasons: [{ key: ok ? 'answer.goodRelations' : 'answer.lowOpinion', params: { score: Math.round(o), need: need[r.kind] } }] };
  }

  /** Worker: unpaused real time for the human's pending items (§5.3). */
  addRealTime(ms: number): void {
    if (!(ms > 0)) return;
    for (const r of this.proposals.values()) {
      if (r.status !== 'pending') continue;
      r.realMs += ms;
    }
  }

  // =================================================================================================
  // v1 commands mapped onto proposals
  // =================================================================================================
  request(p: Player, target: number): boolean {
    // They already asked us: accept on the spot.
    for (const r of this.proposals.values()) {
      if (r.kind === 'alliance' && r.from === target && r.to === p.id && r.status === 'pending') return this.answer(p, r.id, true);
    }
    return !!this.propose(p.id, target, 'alliance');
  }

  reply(p: Player, from: number, accept: boolean): boolean {
    for (const r of this.proposals.values()) {
      if (r.kind === 'alliance' && r.from === from && r.to === p.id && r.status === 'pending') return this.answer(p, r.id, accept);
    }
    return false;
  }

  /** v1 breakAlliance: leave with notice (declaring war is the betrayal path). */
  breakAlliance(p: Player, target: number): boolean {
    return this.leaveTreaty(p, target, 'alliance');
  }

  /** A nuclear detonation on an ally's land ends the alliance at once (weapons.ts). */
  breakAllianceByStrike(breaker: number, victim: number): void {
    const g = this.g;
    if (!g.isAllied(breaker, victim)) return;
    this.end(breaker, victim, 'alliance', 'treaty.reason.nuked');
    const B = g.playerById[breaker];
    if (B) {
      B.traitorUntilTick = g.tick + TRAITOR_TICKS;
      B.metaDirty = true;
    }
    this.addReason(victim, breaker, 'betrayedUs', undefined, { treaty: 'alliance' });
    g.emit({ type: 'allianceBroken', tick: g.tick, breaker, victim });
    if (victim === HUMAN_ID) g.message(HUMAN_ID, 'msg.betrayed', 'danger', { player: breaker });
  }

  /** A declaration on an ally breaks the alliance (the war system marks the traitor). */
  breakAllianceForWar(breaker: number, victim: number): void {
    const g = this.g;
    if (!g.isAllied(breaker, victim)) return;
    this.end(breaker, victim, 'alliance', 'treaty.reason.betrayal');
    g.emit({ type: 'allianceBroken', tick: g.tick, breaker, victim });
  }

  /** «Pedir ayuda contra X» (v1 targetPlayer): a call to arms to every ally not yet at war with X. */
  askHelp(p: Player, target: number): boolean {
    const g = this.g;
    if (!(target > 0) || !g.war.atWar(p.id, target)) {
      g.message(p.id, 'msg.notAtWar');
      return false;
    }
    let n = 0;
    for (const a of [...p.allies]) {
      if (g.war.atWar(a, target) || g.isAllied(a, target)) continue;
      if (this.propose(p.id, a, 'callToArms', { against: target })) n++;
    }
    if (n === 0) g.message(p.id, 'msg.noAllyToCall');
    return n > 0;
  }

  /**
   * The allies the target of a declaration by `aggressor` would call to arms (§4.2, §5.5): the same rule as callAllies,
   * for the declaration dialog.
   */
  defendersOf(aggressor: number, target: number): number[] {
    const g = this.g;
    const B = g.playerById[target];
    if (!B) return [];
    const out: number[] = [];
    for (const ally of B.allies) {
      if (ally === aggressor || !g.war.canWage(ally) || g.war.atWar(ally, aggressor)) continue;
      if (g.playerById[ally]!.allies.has(aggressor)) continue;
      out.push(ally);
    }
    return out;
  }

  /** The target of a declaration calls its allies to arms (§5.5); an AI conqueror asks its own (convergence). */
  callAllies(w: { id: number; a: number; b: number; goal: string }): void {
    const g = this.g;
    const A = g.playerById[w.a], B = g.playerById[w.b];
    if (!A || !B) return;
    for (const ally of this.defendersOf(w.a, w.b)) this.propose(w.b, ally, 'callToArms', { against: w.a, system: true });
    // An AI conqueror asks its own allies for help against the target (§5.5 «Pedir ayuda», §4.18 convergence). Never
    // against the human (§4.16), never an ally that is also the target's ally.
    if (A.kind === 'nation' && B.kind === 'nation' && (w.goal === 'conquest' || w.goal === 'coalition')) {
      for (const ally of [...A.allies]) {
        if (ally === w.b || !g.war.canWage(ally) || g.war.pairState(ally, w.b) !== 'peace') continue;
        const ap = g.playerById[ally]!;
        if (ap.kind !== 'nation' || ap.allies.has(w.b)) continue;
        this.propose(w.a, ally, 'callToArms', { against: w.b, system: true });
      }
    }
  }

  /** Emotes are gone (§1.3, H02): the command is accepted by no one. */
  emote(): boolean {
    return false;
  }

  embargo(p: Player, target: number, active: boolean): boolean {
    const g = this.g;
    if (target === p.id || !g.playerById[target]) return false;
    if (active === p.embargoes.has(target)) return true;
    if (active) p.embargoes.add(target);
    else {
      p.embargoes.delete(target);
      p.tempEmbargo.delete(target);
    }
    p.metaDirty = true;
    this.touch(p.id, target);
    g.emit({ type: 'embargoChanged', tick: g.tick, from: p.id, to: target, active });
    return true;
  }

  donate(p: Player, target: number, gold: number, troops: number): boolean {
    const g = this.g;
    const t = g.playerById[target];
    if (!t || !t.alive || target === p.id) return false;
    if (p.donateReadyTick > g.tick) {
      g.message(p.id, 'msg.cooldown', 'info');
      return false;
    }
    const gAmt = Math.max(0, Math.min(p.gold, Number.isFinite(gold) ? gold : 0));
    let tAmt = Math.max(0, Math.min(p.troops, Number.isFinite(troops) ? troops : 0));
    if (tAmt > 0 && !p.allies.has(target)) {
      g.message(p.id, 'msg.donateAlliesOnly');
      tAmt = 0;
    }
    if (gAmt <= 0 && tAmt <= 0) return false;
    p.gold -= gAmt;
    p.troops -= tAmt;
    t.gold += gAmt;
    t.troops += tAmt;
    p.donateReadyTick = g.tick + DONATE_COOLDOWN;
    g.emit({ type: 'donation', tick: g.tick, from: p.id, to: target, gold: Math.round(gAmt), troops: Math.round(tAmt) });
    return true;
  }

  /** A player died: its treaties end and its proposals are cancelled. */
  dropPlayer(pid: number): void {
    const g = this.g;
    for (const list of [...this.treaties.values()]) {
      for (const t of [...list]) if (t.a === pid || t.b === pid) this.end(t.a, t.b, t.kind, 'treaty.reason.gone');
    }
    for (const r of [...this.proposals.values()]) {
      if (r.from === pid || r.to === pid || r.target === pid) this.close(r, 'cancelled', [{ key: 'answer.gone' }]);
    }
    for (const p of g.playerArr) {
      if (p.embargoes.delete(pid) || p.tempEmbargo.delete(pid)) p.metaDirty = true;
      if (p.targetPlayer === pid) p.targetPlayer = 0;
    }
    for (const k of [...this.ledger.keys()]) if (Math.floor(k / 4096) === pid || k % 4096 === pid) this.ledger.delete(k);
    g.alliancesDirty = true;
    this.opinionsDirty = true;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    const tick = g.tick;
    // Proposals: AI deliberations end; the human's inbox items expire (tick deadline and the real-time floor).
    for (const r of [...this.proposals.values()]) {
      if (r.status === 'considering') {
        if (tick >= r.decideTick) this.decide(r);
      } else if (r.status === 'pending') {
        if (this.applyError(r)) this.close(r, 'cancelled', [{ key: 'answer.obsolete' }]);
        else if (tick >= r.expiresTick && (!this.realTimeFloor || r.realMs >= INBOX_MIN_REAL_MS)) this.close(r, 'expired', [{ key: 'answer.expired' }]);
      }
    }
    // Treaties: pacts end at their term (announced 24 h before by the client), notice periods run out.
    for (const list of [...this.treaties.values()]) {
      for (const t of [...list]) {
        if (t.kind === 'nap' && t.untilTick > 0) {
          if (!t.warned && t.untilTick - tick <= TREATY_WARNING_TICKS) {
            t.warned = true;
            this.treatiesDirty = true;
          }
          if (tick >= t.untilTick) this.end(t.a, t.b, 'nap', 'treaty.reason.expired');
        } else if (t.leavingTick > 0 && tick >= t.leavingTick) this.end(t.a, t.b, t.kind, 'treaty.reason.left');
      }
    }
    if (tick % 50 === 0) {
      for (const p of g.playerArr) {
        for (const [t, until] of p.tempEmbargo) {
          if (until <= tick) {
            p.tempEmbargo.delete(t);
            p.metaDirty = true;
          }
        }
      }
    }
    if (tick % OPINION_PERIOD_TICKS === 0) {
      this.refreshLeader();
      this.cacheTick = -1;
      this.opinionsDirty = true;
      for (const [k, v] of this.tension) if (tick - v[0] > 4_800) this.tension.delete(k);
      for (const [k, v] of this.noWar) if (v <= tick) this.noWar.delete(k);
      for (const [k, v] of this.cooldown) if (v <= tick) this.cooldown.delete(k);
    }
  }

  // =================================================================================================
  // Views
  // =================================================================================================
  private treatyView(t: TreatyRec): TreatyView {
    return { a: t.a, b: t.b, kind: t.kind, sinceTick: t.sinceTick, untilTick: t.untilTick, leavingTick: t.leavingTick, leaver: t.leaver };
  }

  treatyViews(): TreatyView[] {
    const out: TreatyView[] = [];
    for (const list of this.treaties.values()) for (const t of list) out.push(this.treatyView(t));
    return out;
  }

  view(r: ProposalRec): ProposalView {
    const v: ProposalView = {
      id: r.id, from: r.from, to: r.to, kind: r.kind, war: r.war, target: r.target, gold: r.gold,
      createdTick: r.createdTick, decideTick: r.decideTick, expiresTick: r.expiresTick, realMs: Math.round(r.realMs), status: r.status,
      resolvedTick: r.resolvedTick,
    };
    if (r.terms) v.terms = { ...r.terms };
    if (r.demand) v.demand = { ...r.demand };
    if (r.reasons) v.reasons = r.reasons.map((x) => ({ ...x }));
    if (r.counterId) v.counterId = r.counterId;
    if (r.counterOf) v.counterOf = r.counterOf;
    if (r.ultimatum) v.ultimatum = true;
    return v;
  }

  /** The human's proposals: open ones and the latest answered (the inbox). */
  proposalViews(): ProposalView[] {
    const out: ProposalView[] = [];
    for (const r of this.history) out.push(this.view(r));
    for (const r of this.proposals.values()) if (r.from === HUMAN_ID || r.to === HUMAN_ID) out.push(this.view(r));
    return out;
  }

  /** Every AI nation's opinion of the human, with its reasons (§5.1). */
  opinionViews(): OpinionView[] {
    const out: OpinionView[] = [];
    for (const p of this.g.playerArr) {
      if (!p.alive || p.kind !== 'nation' || !p.spawned) continue;
      const e = this.evaluate(p.id, HUMAN_ID);
      const v: OpinionView = { of: p.id, toward: HUMAN_ID, score: e.score, reasons: e.reasons.map((x) => ({ ...x })) };
      const t = this.tension.get(dirKey(p.id, HUMAN_ID));
      if (t) {
        v.tensionTick = t[0];
        v.tensionKey = t[1];
      }
      const nw = this.noWar.get(dirKey(p.id, HUMAN_ID));
      if (nw && nw > this.g.tick) v.noWarUntil = nw;
      const rf = this.refused.get(dirKey(HUMAN_ID, p.id));
      if (rf) v.refusals = rf;
      out.push(v);
    }
    return out;
  }

  /** v1 views kept for older consumers (alliances as open-ended treaties; pending alliance offers). */
  allianceViews(): AllianceView[] {
    const out: AllianceView[] = [];
    for (const list of this.treaties.values()) for (const t of list) if (t.kind === 'alliance') out.push({ a: t.a, b: t.b, expiresTick: t.leavingTick });
    return out;
  }

  requestViews(): AllianceRequestView[] {
    const out: AllianceRequestView[] = [];
    for (const r of this.proposals.values()) if (r.kind === 'alliance' && r.status === 'pending') out.push({ from: r.from, to: r.to, expiresTick: r.expiresTick });
    return out;
  }

  /** Staging / tests: sign a treaty directly. */
  debugSign(a: number, b: number, kind: TreatyKind): boolean {
    if (kind === 'alliance' && this.hasTreaty(a, b, 'nap')) this.end(a, b, 'nap', 'treaty.reason.superseded');
    return this.sign(a, b, kind, 'treaty.reason.signed');
  }

  hasPorts(p: number): boolean {
    return (this.g.playerById[p]?.structCount[StructureType.Port] ?? 0) > 0;
  }

  /** Band of `loser`'s tiles next to `winner` (preview order = transfer order). */
  band(loser: number, winner: number, tiles: number): number[] {
    return this.g.war.waveOrder(loser, winner, CESSION_DEPTH).slice(0, Math.max(0, tiles));
  }
}
