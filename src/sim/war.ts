// FRONT ULTRA — war state (DESIGN_V2 §4.1, §4.2, §4.13, §4.15, §4.16, §5.10). Owner: sim-core (W1). Worker-only.
//
// Every pair of players is at peace, at war or in a truce. Wars are declared (with a goal and a stated reason),
// every aggressor mobilizes before its first offensive, and wars end with a peace treaty (white peace, a ceded border
// band or a tribute) or a capitulation. The system keeps the per-war accounting the AI and the UI read: war score,
// exhaustion, the per-war logistics bucket of each defender (§4.5), escalation levels and the capital of each side.
//
// v2-stub(W1→W3): betrayal is detected against v1 alliances (and our own truces) only; defensive allies of the
// target answer the call to arms by the rule of §5.5 inside this system; the human's allies are told but cannot answer
// until W3's inbox lands.

import {
  AI_MOBILIZE_TICKS, CAPITULATION_EXHAUSTION, CAPITULATION_EXHAUSTION_MIN, CAPITULATION_LAND_LOST, CAPITULATION_LAND_LOST_MIN, CAPITULATION_ODDS_SLOPE, CAPITULATION_ARMY_BROKEN, DIFFICULTY_INDEX, HUMAN_GRACE_TICKS, HUMAN_ID,
  HUMAN_MOBILIZE_TICKS, JOIN_MOBILIZE_TICKS, LOGISTICS_FLOOR, LOGISTICS_SHARE, LOGISTICS_WINDOW, REBEL_MOBILIZE_TICKS,
  TENSION_LEAD_TICKS, TICKS_PER_GAME_DAY, TRAITOR_TICKS, TRUCE_TICKS,
} from '../shared/constants';
import type { PeaceTerms, WarGoal, WarView } from '../shared/types';
import { PERSONALITY } from './ai/profiles';
import type { Game } from './game';
import { neighbors4 } from './game';
import type { SaveReader, SaveWriter } from './save';

export interface War {
  id: number;
  /** Side 0 = aggressor, side 1 = target. */
  a: number;
  b: number;
  parentWar: number;
  startTick: number;
  goal: WarGoal;
  reasonKey: string;
  /** The aggressor may not start offensives before this tick (the target defends at once). */
  mobilizeUntilTick: number;
  escalation: [number, number];
  tilesAtStart: [number, number];
  capAtStart: [number, number];
  capitalAtStart: [number, number];
  /** Net tiles side a took from side b in this war (negative: lost). */
  net: number;
  /** Troops each side lost fighting the other in this war. */
  casualties: [number, number];
  /** Side lost its capital to the other during this war. */
  capitalLost: [boolean, boolean];
  /** Logistics bucket of each side AS DEFENDER (tiles it may still lose this window) and its size. */
  bucket: [number, number];
  budget: [number, number];
  /** Joined through a call to arms (no betrayal, own mobilization). */
  joined: boolean;
  betrayal: boolean;
}

/** An offensive ordered during the aggressor's mobilization: it starts by itself when the mobilization ends. */
interface Queued {
  war: number;
  attacker: number;
  target: number;
  tile: number;
  ratio: number;
  naval: boolean;
}

interface CallToArms {
  ally: number;
  war: number;
  decideTick: number;
  /**
   * An aggressor's request for help against its target (§5.5 «Pedir ayuda contra X»; v2-stub(W1→W3): AI allies of an
   * AI aggressor only, decided here). Absent = a defensive call to arms.
   */
  offense?: boolean;
}

/** A treaty transfer of land (cession, capitulation), animated as a wave from the winner's border. */
interface Transfer {
  from: number;
  to: number;
  tiles: number[];
  next: number;
  perTick: number;
  reason: 'cession' | 'capitulation';
}

export interface DeclareOptions {
  queuedAttack?: { tile: number; ratio: number; naval?: boolean };
  /** Joining an ally's war through a call to arms. */
  join?: boolean;
  parentWar?: number;
  /** Mobilization override (rebels: REBEL_MOBILIZE_TICKS). */
  mobilizeTicks?: number;
  /** Staging only: skip the guards (grace, tension lead, caps). */
  force?: boolean;
}

const pairKey = (a: number, b: number): number => (a < b ? a * 4096 + b : b * 4096 + a);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class WarSystem {
  private readonly wars = new Map<number, War>();
  private readonly byPair = new Map<number, War>();
  /** Truces: pairKey -> tick the truce ends. */
  private readonly truces = new Map<number, number>();
  private readonly queued: Queued[] = [];
  private readonly calls: CallToArms[] = [];
  private readonly transfers: Transfer[] = [];
  /** Exhaustion carried after a war ends, decaying 2 per game day at peace: player -> [value, tick]. */
  private readonly residual = new Map<number, [number, number]>();
  /** Latest tension emitted by an AI toward the human (pairs), for the tension-lead rule of §2.4 / T9. */
  private readonly tension = new Map<number, number>();
  private nextWarId = 1;
  dirty = true;
  trucesDirty = true;

  constructor(private readonly g: Game) {}

  // =================================================================================================
  // Queries
  // =================================================================================================
  pairState(a: number, b: number): 'peace' | 'war' | 'truce' {
    if (a === b) return 'peace';
    const k = pairKey(a, b);
    if (this.byPair.has(k)) return 'war';
    const t = this.truces.get(k);
    return t !== undefined && t > this.g.tick ? 'truce' : 'peace';
  }

  atWar(a: number, b: number): boolean {
    return a !== b && this.byPair.has(pairKey(a, b));
  }

  between(a: number, b: number): War | undefined {
    return this.byPair.get(pairKey(a, b));
  }

  get(id: number): War | undefined {
    return this.wars.get(id);
  }

  list(): IterableIterator<War> {
    return this.wars.values();
  }

  /** Wars `p` takes part in. */
  warsOf(p: number): War[] {
    const out: War[] = [];
    for (const w of this.wars.values()) if (w.a === p || w.b === p) out.push(w);
    return out;
  }

  /** Enemies `p` is at war with. */
  enemiesOf(p: number): number[] {
    const out: number[] = [];
    for (const w of this.wars.values()) {
      if (w.a === p) out.push(w.b);
      else if (w.b === p) out.push(w.a);
    }
    return out;
  }

  side(w: War, p: number): 0 | 1 {
    return w.a === p ? 0 : 1;
  }

  /** Tick until which `attacker` may not start an offensive against `target` (0 = free). */
  mobilizingUntil(attacker: number, target: number): number {
    const w = this.between(attacker, target);
    if (!w || w.a !== attacker) return 0;
    return w.mobilizeUntilTick > this.g.tick ? w.mobilizeUntilTick : 0;
  }

  /** Days at war (game days since the declaration). */
  days(w: War): number {
    return (this.g.tick - w.startTick) / TICKS_PER_GAME_DAY;
  }

  /** Exhaustion 0..100 of side `s` in war `w` (§4.15). */
  exhaustionOf(w: War, s: 0 | 1): number {
    const lost = s === 0 ? Math.max(0, -w.net) : Math.max(0, w.net);
    const v = this.days(w) + 40 * (w.casualties[s] / Math.max(1, w.capAtStart[s])) + 60 * (lost / Math.max(1, w.tilesAtStart[s]));
    return clamp(v, 0, 100);
  }

  /** A player's exhaustion: its worst war, or what is left of its last wars (decaying 2 per day at peace). */
  exhaustion(p: number): number {
    let v = 0;
    for (const w of this.wars.values()) {
      if (w.a === p) v = Math.max(v, this.exhaustionOf(w, 0));
      else if (w.b === p) v = Math.max(v, this.exhaustionOf(w, 1));
    }
    const r = this.residual.get(p);
    if (r) v = Math.max(v, Math.max(0, r[0] - 2 * ((this.g.tick - r[1]) / TICKS_PER_GAME_DAY)));
    return v;
  }

  /** War score of `p` in its war with `q`, -100..100 (§4.15). */
  warScore(p: number, q: number): number {
    const w = this.between(p, q);
    if (!w) return 0;
    const s = this.side(w, p);
    const o: 0 | 1 = s === 0 ? 1 : 0;
    const g = this.g;
    const netMine = s === 0 ? w.net : -w.net;
    let score = 60 * (Math.max(0, netMine) / Math.max(1, w.tilesAtStart[o])) - 60 * (Math.max(0, -netMine) / Math.max(1, w.tilesAtStart[s]));
    const theirCap = w.capitalAtStart[o], myCap = w.capitalAtStart[s];
    if (theirCap >= 0 && g.owner[theirCap] === p) score += 20;
    if (myCap >= 0 && g.owner[myCap] === q) score -= 20;
    const me = g.playerById[p];
    score += 20 * Math.tanh((w.casualties[o] - w.casualties[s]) / Math.max(1, me?.maxTroops ?? 1));
    return clamp(score, -100, 100);
  }

  escalation(p: number, q: number): number {
    const w = this.between(p, q);
    return w ? w.escalation[this.side(w, p)] : 0;
  }

  /** Tiles `defender` may still lose to `attacker` this logistics window (Infinity when not a war). */
  logistics(attacker: number, defender: number): number {
    const w = this.between(attacker, defender);
    if (!w) return Infinity;
    return w.bucket[this.side(w, defender)];
  }

  // =================================================================================================
  // Declaring war (§4.2)
  // =================================================================================================
  /** Players that can be at war: nations, the human and rebel movements (independent territories are outside). */
  canWage(p: number): boolean {
    const pl = this.g.playerById[p];
    return !!pl && pl.alive && pl.spawned && (pl.kind === 'nation' || pl.kind === 'human' || pl.kind === 'rebel');
  }

  /** Why `aggressor` may not declare on `target` now (i18n key), or null. */
  declareError(aggressor: number, target: number, opts: DeclareOptions = {}): string | null {
    const g = this.g;
    if (g.phase !== 'playing') return 'msg.notYet';
    if (aggressor === target || !this.canWage(aggressor) || !this.canWage(target)) return 'msg.cannotDeclare';
    if (this.atWar(aggressor, target)) return 'msg.alreadyAtWar';
    if (opts.force) return null;
    const A = g.playerById[aggressor]!;
    // Protecting the human (§4.16): grace, tension lead and the early-war cap bind AI aggressors only.
    if (target === HUMAN_ID && A.kind !== 'human' && !opts.join) {
      const d = DIFFICULTY_INDEX[g.difficulty];
      if (g.tick < HUMAN_GRACE_TICKS[d]) return 'msg.grace';
      const t = this.tension.get(aggressor);
      if (t === undefined || g.tick - t < TENSION_LEAD_TICKS[d]) return 'msg.tensionFirst';
    }
    if (target === HUMAN_ID && A.kind !== 'human' && g.tick < 18_000) {
      const d = DIFFICULTY_INDEX[g.difficulty];
      const cap = d >= 2 ? 2 : 1;
      let n = 0;
      for (const w of this.wars.values()) if (w.b === HUMAN_ID && w.a !== HUMAN_ID && (!w.parentWar || this.wars.get(w.parentWar)?.b === HUMAN_ID)) n++;
      if (n >= cap && !(opts.join && this.wars.get(opts.parentWar ?? 0)?.a === HUMAN_ID)) return 'msg.warCap';
    }
    return null;
  }

  /** An AI states a grievance toward the human: the warning that must precede any declaration on it (T9). */
  recordTension(from: number, to: number): void {
    if (to === HUMAN_ID) this.tension.set(from, this.g.tick);
  }

  lastTension(from: number): number {
    return this.tension.get(from) ?? -1;
  }

  /**
   * Declare war. Returns the war, or null (with a message to the human) when not allowed. Consequences (§4.2): world
   * news (warDeclared), the target's defensive allies are called to arms, a betrayal flags the aggressor as traitor,
   * trade between the pair stops (hasEmbargo reads the war), and the queued offensive starts when mobilization ends.
   */
  declare(aggressor: number, target: number, goal: WarGoal, reasonKey: string, opts: DeclareOptions = {}): War | null {
    const g = this.g;
    const err = this.declareError(aggressor, target, opts);
    if (err) {
      g.message(aggressor, err);
      return null;
    }
    const A = g.playerById[aggressor]!, B = g.playerById[target]!;
    const k = pairKey(aggressor, target);
    // Betrayal (v2-stub(W1→W3): alliances and truces only; W3 adds non-aggression pacts).
    let betrayal = false;
    if (!opts.join && (A.allies.has(target) || (this.truces.get(k) ?? 0) > g.tick)) {
      betrayal = true;
      if (A.allies.has(target)) g.diplomacy.breakAllianceForWar(aggressor, target);
      A.traitorUntilTick = g.tick + TRAITOR_TICKS;
      A.metaDirty = true;
    }
    this.truces.delete(k);
    const d = DIFFICULTY_INDEX[g.difficulty];
    const mob = opts.mobilizeTicks ?? (opts.join ? JOIN_MOBILIZE_TICKS : A.kind === 'human' ? HUMAN_MOBILIZE_TICKS[d] : A.kind === 'rebel' ? REBEL_MOBILIZE_TICKS : AI_MOBILIZE_TICKS[d]);
    const budgetA = Math.max(LOGISTICS_SHARE * A.tiles, LOGISTICS_FLOOR);
    const budgetB = Math.max(LOGISTICS_SHARE * B.tiles, LOGISTICS_FLOOR);
    const w: War = {
      id: this.nextWarId++, a: aggressor, b: target, parentWar: opts.parentWar ?? 0, startTick: g.tick, goal, reasonKey,
      mobilizeUntilTick: g.tick + mob, escalation: [0, 0], tilesAtStart: [Math.max(1, A.tiles), Math.max(1, B.tiles)],
      capAtStart: [Math.max(1, A.maxTroops), Math.max(1, B.maxTroops)], capitalAtStart: [A.capitalTile, B.capitalTile],
      net: 0, casualties: [0, 0], capitalLost: [false, false], bucket: [budgetA / 6, budgetB / 6], budget: [budgetA, budgetB],
      joined: !!opts.join, betrayal,
    };
    this.wars.set(w.id, w);
    this.byPair.set(k, w);
    this.dirty = true;
    // Trade stops (hasEmbargo reads the war); the embargo lists shown to the client change.
    A.metaDirty = B.metaDirty = true;
    // Fronts that exist at the declaration start at their target garrison share (§4.4).
    g.fronts.onWarDeclared(w);
    if (opts.queuedAttack && opts.queuedAttack.tile >= 0) {
      this.queued.push({ war: w.id, attacker: aggressor, target, tile: opts.queuedAttack.tile, ratio: opts.queuedAttack.ratio, naval: !!opts.queuedAttack.naval });
    }
    g.emit({
      type: 'warDeclared', tick: g.tick, war: w.id, aggressor, target, goal, reasonKey, mobilizeUntilTick: w.mobilizeUntilTick,
      betrayal, parentWar: w.parentWar,
    });
    g.invariants?.onWarDeclared(w);
    // Defensive allies of the target are called to arms (§5.5). Joiners do not cascade further.
    if (!opts.join) {
      for (const ally of B.allies) {
        if (ally === aggressor || !this.canWage(ally) || this.atWar(ally, aggressor)) continue;
        const ap = g.playerById[ally]!;
        if (ap.allies.has(aggressor)) continue;
        if (ap.kind === 'human') {
          // v2-stub(W1→W3): the human answers calls to arms from W3's inbox.
          g.message(HUMAN_ID, 'msg.allyAttacked', 'warning', { player: target, attacker: aggressor });
          continue;
        }
        this.calls.push({ ally, war: w.id, decideTick: g.tick + 20 + g.rngWar.int(41) });
      }
      // An AI conqueror asks its own allies for help against the target (§4.18 convergence: a coalition splits the
      // target's garrisons; §5.5 «Pedir ayuda contra X»). Never against the human (§4.16: W3 routes those through the
      // human's own diplomacy), never an ally that is also the target's ally.
      if (A.kind === 'nation' && B.kind === 'nation' && (goal === 'conquest' || goal === 'coalition')) {
        for (const ally of A.allies) {
          if (ally === target || !this.canWage(ally) || this.atWar(ally, target)) continue;
          const ap = g.playerById[ally]!;
          if (ap.kind !== 'nation' || ap.allies.has(target)) continue;
          this.calls.push({ ally, war: w.id, decideTick: g.tick + 20 + g.rngWar.int(41), offense: true });
        }
      }
    }
    return w;
  }

  /** Queue (or replace) an offensive ordered while the aggressor still mobilizes. */
  queue(attacker: number, target: number, tile: number, ratio: number, naval: boolean): boolean {
    const w = this.between(attacker, target);
    if (!w) return false;
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const q = this.queued[i];
      if (q.attacker === attacker && q.target === target && q.naval === naval) this.queued.splice(i, 1);
    }
    this.queued.push({ war: w.id, attacker, target, tile, ratio, naval });
    this.dirty = true;
    return true;
  }

  queuedOf(attacker: number): readonly Queued[] {
    return this.queued.filter((q) => q.attacker === attacker);
  }

  allQueued(): readonly Queued[] {
    return this.queued;
  }

  raiseEscalation(p: number, q: number, level: number, reasonKey: string): boolean {
    const w = this.between(p, q);
    if (!w) return false;
    const s = this.side(w, p);
    const lv = clamp(Math.floor(level), 0, 4);
    if (lv <= w.escalation[s]) return false;
    w.escalation[s] = lv;
    this.dirty = true;
    this.g.emit({ type: 'escalation', tick: this.g.tick, war: w.id, by: p, against: q, level: lv, reasonKey });
    return true;
  }

  // =================================================================================================
  // Accounting hooks (called by Game.setOwner and the attack system)
  // =================================================================================================
  onTileTransfer(prev: number, next: number): void {
    const w = this.byPair.get(pairKey(prev, next));
    if (!w) return;
    if (next === w.a) w.net++;
    else w.net--;
  }

  onCapitalLost(loser: number, by: number): void {
    const w = this.byPair.get(pairKey(loser, by));
    if (w) w.capitalLost[this.side(w, loser)] = true;
  }

  addCasualties(p: number, q: number, lostByP: number, lostByQ: number): void {
    const w = this.byPair.get(pairKey(p, q));
    if (!w) return;
    const s = this.side(w, p);
    w.casualties[s] += lostByP;
    w.casualties[s === 0 ? 1 : 0] += lostByQ;
  }

  /** A tile of `defender` falls to `attacker`: take one token from the defender's logistics bucket. */
  consumeLogistics(attacker: number, defender: number): void {
    const w = this.byPair.get(pairKey(attacker, defender));
    if (!w) return;
    const s = this.side(w, defender);
    if (w.bucket[s] < 1) this.g.invariants?.onBucketOverdraw(w, defender);
    w.bucket[s] = Math.max(0, w.bucket[s] - 1);
  }

  // =================================================================================================
  // Peace, truce, capitulation (§4.13, §4.15)
  // =================================================================================================
  /**
   * End the war between a and b with `terms` (the loser is the side that cedes or pays; white peace has none).
   * Starts a 4,800-tick truce; sub-wars joined through calls to arms end with the same terms.
   */
  makePeace(a: number, b: number, terms: PeaceTerms, reasonKey = 'peace.reason.treaty', loser = 0): boolean {
    const g = this.g;
    const w = this.between(a, b);
    if (!w) return false;
    const winner = loser === 0 ? 0 : loser === w.a ? w.b : w.a;
    this.endWar(w, winner, terms, reasonKey);
    if (loser > 0 && terms.kind === 'cede') this.cedeBand(loser, winner, terms.tiles ?? 0);
    if (loser > 0 && terms.kind === 'tribute') {
      const L = g.playerById[loser], W = g.playerById[winner];
      if (L && W) {
        const gold = L.gold * 0.3;
        L.gold -= gold;
        g.addGold(winner, gold);
        L.tributeTo = winner;
        L.tributeShare = 0.2;
        L.tributeUntil = g.tick + 2_400;
      }
    }
    // Allies who joined this war through a call to arms get their own peace with the same terms.
    for (const sub of [...this.wars.values()]) {
      if (sub.parentWar !== w.id) continue;
      this.endWar(sub, 0, { kind: 'white' }, reasonKey);
    }
    return true;
  }

  private endWar(w: War, winner: number, terms: PeaceTerms, reasonKey: string): void {
    const g = this.g;
    this.wars.delete(w.id);
    this.byPair.delete(pairKey(w.a, w.b));
    this.truces.set(pairKey(w.a, w.b), g.tick + TRUCE_TICKS);
    this.trucesDirty = true;
    this.dirty = true;
    for (let i = this.queued.length - 1; i >= 0; i--) if (this.queued[i].war === w.id) this.queued.splice(i, 1);
    for (const [s, p] of [[0, w.a], [1, w.b]] as const) {
      const ex = this.exhaustionOf(w, s);
      const r = this.residual.get(p);
      const cur = r ? Math.max(0, r[0] - 2 * ((g.tick - r[1]) / TICKS_PER_GAME_DAY)) : 0;
      this.residual.set(p, [Math.max(cur, ex), g.tick]);
      const pl = g.playerById[p];
      if (pl) pl.metaDirty = true;
    }
    g.attacks.endBetween(w.a, w.b);
    g.fronts.onWarEnded(w);
    g.emit({ type: 'warEnded', tick: g.tick, war: w.id, a: w.a, b: w.b, winner, terms, reasonKey });
  }

  /** The loser hands every remaining tile to the winner, as a wave from the winner's border over 20 ticks (§4.13). */
  capitulate(loser: number, winner: number): boolean {
    const g = this.g;
    const L = g.playerById[loser];
    if (!L || !L.alive || L.tiles === 0) return false;
    const w = this.between(loser, winner);
    const tiles = this.waveOrder(loser, winner, Infinity);
    g.emit({ type: 'capitulation', tick: g.tick, loser, winner, tiles: tiles.length, war: w?.id ?? 0 });
    if (w) this.endWar(w, winner, { kind: 'capitulation', tiles: tiles.length }, 'peace.reason.capitulation');
    // The loser's other wars end with it (its enemies keep what they took).
    for (const other of this.warsOf(loser)) this.endWar(other, other.a === loser ? other.b : other.a, { kind: 'white' }, 'peace.reason.capitulation');
    this.transfers.push({ from: loser, to: winner, tiles, next: 0, perTick: Math.max(1, Math.ceil(tiles.length / 20)), reason: 'capitulation' });
    return true;
  }

  /** Cede a band of the loser's tiles within 4 tiles of the current fronts, contiguous to the winner (≤ 15 %). */
  private cedeBand(loser: number, winner: number, want: number): void {
    const L = this.g.playerById[loser];
    if (!L) return;
    const cap = Math.floor(L.tiles * 0.15);
    const n = Math.min(cap, want > 0 ? want : cap);
    if (n <= 0) return;
    const tiles = this.waveOrder(loser, winner, 4).slice(0, n);
    this.transfers.push({ from: loser, to: winner, tiles, next: 0, perTick: Math.max(1, Math.ceil(tiles.length / 20)), reason: 'cession' });
  }

  /** Tiles of `from`, breadth-first from the border with `to` (within maxDepth tiles of it). */
  waveOrder(from: number, to: number, maxDepth: number): number[] {
    const g = this.g;
    const out: number[] = [];
    const depth = new Map<number, number>();
    const P = g.playerById[from];
    if (!P) return out;
    const nb = new Int32Array(4);
    for (const t of P.border) {
      const n = neighbors4(t, nb);
      for (let k = 0; k < n; k++) {
        if (g.owner[nb[k]] === to) {
          depth.set(t, 0);
          out.push(t);
          break;
        }
      }
    }
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      const d = depth.get(t)!;
      if (d + 1 > maxDepth) continue;
      const n = neighbors4(t, nb);
      for (let k = 0; k < n; k++) {
        const q = nb[k];
        if (g.owner[q] !== from || depth.has(q)) continue;
        depth.set(q, d + 1);
        out.push(q);
      }
    }
    if (maxDepth === Infinity && out.length < P.tiles) {
      // Exclaves not reachable from the border with the winner go last.
      for (let t = 0; t < g.owner.length; t++) if (g.owner[t] === from && !depth.has(t)) out.push(t);
    }
    return out;
  }

  /** Cleanup when a player is eliminated: its wars end (the other side wins). */
  dropPlayer(p: number): void {
    for (const w of this.warsOf(p)) this.endWar(w, w.a === p ? w.b : w.a, { kind: 'white' }, 'peace.reason.eliminated');
    for (let i = this.queued.length - 1; i >= 0; i--) if (this.queued[i].attacker === p || this.queued[i].target === p) this.queued.splice(i, 1);
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    const tick = g.tick;
    // Logistics buckets refill budget / 60 per tick and hold at most budget / 6 (§4.5). The budget follows the
    // defender's CURRENT land (max(0.9 %, 45 tiles)), so a shrinking empire never loses a growing share per window (T19).
    for (const w of this.wars.values()) {
      for (const s of [0, 1] as const) {
        const P = g.playerById[s === 0 ? w.a : w.b];
        w.budget[s] = Math.max(LOGISTICS_SHARE * (P ? P.tiles : 0), LOGISTICS_FLOOR);
        w.bucket[s] = Math.min(w.budget[s] / 6, w.bucket[s] + w.budget[s] / LOGISTICS_WINDOW);
      }
    }
    // Queued offensives start exactly when the aggressor's mobilization ends.
    for (let i = 0; i < this.queued.length; i++) {
      const q = this.queued[i];
      const w = this.wars.get(q.war);
      if (!w) {
        this.queued.splice(i--, 1);
        continue;
      }
      if (tick < w.mobilizeUntilTick) continue;
      this.queued.splice(i--, 1);
      const p = g.playerById[q.attacker];
      if (!p || !p.alive) continue;
      if (!q.naval && g.sharesBorder(q.attacker, q.target)) g.attacks.command(p, q.target, q.ratio, q.tile);
      else g.unitSys.boatAttack(p, q.tile, q.ratio);
    }
    // Calls to arms (v2-stub(W1→W3): AI allies decide here with the rule of §5.5).
    for (let i = 0; i < this.calls.length; i++) {
      const c = this.calls[i];
      if (tick < c.decideTick) continue;
      this.calls.splice(i--, 1);
      this.answerCall(c);
    }
    // Treaty transfers (cessions and capitulations), one wave step per tick.
    for (let i = 0; i < this.transfers.length; i++) {
      const tr = this.transfers[i];
      const end = Math.min(tr.tiles.length, tr.next + tr.perTick);
      const moved: number[] = [];
      for (; tr.next < end; tr.next++) {
        const t = tr.tiles[tr.next];
        if (g.owner[t] === tr.from) moved.push(t);
      }
      if (moved.length) g.transferByTreaty(moved, tr.to);
      if (tr.next >= tr.tiles.length) this.transfers.splice(i--, 1);
    }
    // Truces expire into peace.
    if (tick % 50 === 0) {
      for (const [k, until] of this.truces) {
        if (until <= tick) {
          this.truces.delete(k);
          this.trucesDirty = true;
        }
      }
    }
    // Capitulation (AI only, §4.13): see checkCapitulations.
    if (tick % 60 === 0) this.checkCapitulations();
    if (tick % 10 === 0) this.dirty = true;
  }

  private answerCall(c: CallToArms): void {
    const g = this.g;
    if (c.offense) return this.answerHelp(c);
    const w = this.wars.get(c.war);
    const ally = g.playerById[c.ally];
    if (!w || !ally || !ally.alive || this.atWar(c.ally, w.a) || !ally.allies.has(w.b)) return;
    const loyalty = PERSONALITY[ally.personality ?? 'opportunist']?.loyalty ?? 0.5;
    const borders = g.sharesBorder(c.ally, w.a);
    const navy = ally.unitCount[2] > 0;
    const p = (borders || navy ? 0.5 : 0.3) + 0.5 * loyalty;
    if (g.rngWar.next() >= p) return;
    this.declare(c.ally, w.a, 'defense', 'war.reason.callToArms', { join: true, parentWar: w.id });
  }

  /**
   * An ally asked to join an offensive war (§5.5 odds, lower than for a defensive call: nobody owes an aggressor):
   * 0.35 + 0.3·loyalty when it borders the target (0.15 + 0.3·loyalty with a navy only, never otherwise), and only
   * when it can hold its own front (≥ 40 % of the target's troops) and is not already fighting elsewhere.
   */
  private answerHelp(c: CallToArms): void {
    const g = this.g;
    const w = this.wars.get(c.war);
    const ally = g.playerById[c.ally];
    const T = w ? g.playerById[w.b] : undefined;
    if (!w || !ally || !T || !ally.alive || !T.alive || this.pairState(c.ally, w.b) !== 'peace' || !ally.allies.has(w.a) || ally.allies.has(w.b)) return;
    if (this.enemiesOf(c.ally).length > 0 || this.exhaustion(c.ally) > 40) return;
    if (ally.troops < T.troops * 0.4) return;
    const loyalty = PERSONALITY[ally.personality ?? 'opportunist']?.loyalty ?? 0.5;
    const borders = g.sharesBorder(c.ally, w.b);
    const navy = ally.unitCount[2] > 0;
    if (!borders && !navy) return;
    const p = (borders ? 0.35 : 0.15) + 0.3 * loyalty;
    if (g.rngWar.next() >= p) return;
    this.declare(c.ally, w.b, 'coalition', 'war.reason.allyRequest', { join: true, parentWar: w.id });
  }

  /**
   * Capitulation (AI only, §4.13): the capital lost in one of its current wars (or its army broken), ≥ CAPITULATION_LAND_LOST of its pre-war
   * land gone (the land it held before the first of its current wars: a nation beaten on several fronts at once
   * collapses as surely as one beaten on one), and exhaustion ≥ CAPITULATION_EXHAUSTION. It capitulates to the enemy
   * that took the most of its land (a nation or the human; a rebel movement never receives a capitulation, T20).
   */
  private checkCapitulations(): void {
    const g = this.g;
    const seen = new Set<number>();
    for (const w0 of [...this.wars.values()]) {
      for (const loser of [w0.a, w0.b]) {
        if (seen.has(loser)) continue;
        seen.add(loser);
        const L = g.playerById[loser];
        if (!L || !L.alive || L.kind !== 'nation') continue;
        let capital = false, base = 0;
        const mine = this.warsOf(loser);
        for (const o of mine) {
          const s = this.side(o, loser);
          if (o.capitalLost[s]) capital = true;
          base = Math.max(base, o.tilesAtStart[s]);
        }
        // Its capital taken, or its army broken (home troops under CAPITULATION_ARMY_BROKEN of the cap: nothing left
        // to defend the land with, the way armies rather than capitals ended most wars).
        if (!capital) {
          let army = L.troops;
          for (const a of g.outgoingAttacks(loser)) army += a.troops;
          if (army >= L.maxTroops * CAPITULATION_ARMY_BROKEN) continue;
        }
        // The odds it faces: its enemies' combined land against its own pre-war land (hopeless resistance ends sooner).
        let enemyLand = 0;
        for (const o of mine) enemyLand += g.playerById[o.a === loser ? o.b : o.a]?.tiles ?? 0;
        const odds = Math.max(0, enemyLand / Math.max(1, base) - 1);
        const landNeed = Math.max(CAPITULATION_LAND_LOST_MIN, CAPITULATION_LAND_LOST - CAPITULATION_ODDS_SLOPE * odds);
        const exNeed = Math.max(CAPITULATION_EXHAUSTION_MIN, CAPITULATION_EXHAUSTION - 5 * odds);
        if (L.tiles > base * (1 - landNeed)) continue;
        if (this.exhaustion(loser) < exNeed) continue;
        // To the enemy that took the most of its land.
        let best: War | null = null, bestTaken = 0;
        for (const o of mine) {
          const e = g.playerById[o.a === loser ? o.b : o.a];
          if (!e || (e.kind !== 'nation' && e.kind !== 'human')) continue;
          const taken = o.a === loser ? -o.net : o.net;
          if (taken > bestTaken) {
            bestTaken = taken;
            best = o;
          }
        }
        if (!best) continue;
        this.capitulate(loser, best.a === loser ? best.b : best.a);
      }
    }
  }

  // =================================================================================================
  // Views & save
  // =================================================================================================
  views(): WarView[] {
    const out: WarView[] = [];
    for (const w of this.wars.values()) {
      out.push({
        id: w.id, aggressor: w.a, target: w.b, parentWar: w.parentWar, startTick: w.startTick, goal: w.goal,
        reasonKey: w.reasonKey, mobilizeUntilTick: w.mobilizeUntilTick, escalationA: w.escalation[0], escalationB: w.escalation[1],
        scoreA: Math.round(this.warScore(w.a, w.b)), exhaustionA: Math.round(this.exhaustionOf(w, 0)),
        exhaustionB: Math.round(this.exhaustionOf(w, 1)), tilesA: w.net, casualtiesA: Math.round(w.casualties[0]),
        casualtiesB: Math.round(w.casualties[1]), logisticsA: Math.floor(w.bucket[0]), logisticsB: Math.floor(w.bucket[1]),
      });
    }
    return out;
  }

  truceViews(): { a: number; b: number; untilTick: number }[] {
    const out: { a: number; b: number; untilTick: number }[] = [];
    for (const [k, until] of this.truces) if (until > this.g.tick) out.push({ a: Math.floor(k / 4096), b: k % 4096, untilTick: until });
    return out;
  }

  serialize(w: SaveWriter): void {
    w.section('war');
    w.json({
      wars: [...this.wars.values()], truces: [...this.truces], queued: this.queued, calls: this.calls, transfers: this.transfers,
      residual: [...this.residual], tension: [...this.tension], nextWarId: this.nextWarId,
    });
  }

  restore(r: SaveReader): void {
    r.section('war');
    const d = r.json<{
      wars: War[]; truces: [number, number][]; queued: Queued[]; calls: CallToArms[]; transfers: Transfer[];
      residual: [number, [number, number]][]; tension: [number, number][]; nextWarId: number;
    }>();
    this.wars.clear();
    this.byPair.clear();
    for (const w of d.wars) {
      this.wars.set(w.id, w);
      this.byPair.set(pairKey(w.a, w.b), w);
    }
    this.truces.clear();
    for (const [k, v] of d.truces) this.truces.set(k, v);
    this.queued.splice(0, this.queued.length, ...d.queued);
    this.calls.splice(0, this.calls.length, ...d.calls);
    this.transfers.splice(0, this.transfers.length, ...d.transfers);
    this.residual.clear();
    for (const [k, v] of d.residual) this.residual.set(k, v);
    this.tension.clear();
    for (const [k, v] of d.tension) this.tension.set(k, v);
    this.nextWarId = d.nextWarId;
    this.dirty = true;
    this.trucesDirty = true;
  }
}

export { pairKey as warPairKey };
