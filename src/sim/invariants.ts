// FRONT ULTRA — invariant checker of DESIGN_V2 §4.17 (harness / pace-audit only). Owner: sim-core (W1). Worker-only.
//
// Enabled with Game.checkInvariants = true (off in the browser build). Every violation is counted per invariant and the
// first few are kept as readable samples, so `pace-audit invariants` can print a table of zeros (or of culprits).
//
//   1. setOwner(t, new) with old ≠ 0, old ≠ new needs atWar(old, new), a treaty transfer, a rebellion or old eliminated.
//   2. No tile flips twice in the same tick.
//   3. No AI offensive, strike, missile or naval invasion against a player it is not at war with.
//   4. No offensive by any aggressor before its mobilizeUntilTick.
//   5. Losses per tick ≤ 3 + 0.04 × frontier of the offensive; losses per war ≤ the logistics bucket.
//   6. No AI nuclear detonation whose outer radius covers land of a player not at war with the launcher.
//   7. No independent territory starts an offensive against a nation or the human.

import { HUMAN_ID, TILE_COUNT } from '../shared/constants';
import type { Game, TransferContext } from './game';
import type { Attack } from './state';
import type { War } from './war';

export interface InvariantReport {
  counts: number[];
  samples: string[];
}

export class InvariantChecker {
  /** counts[i] = violations of invariant i (index 0 unused). */
  readonly counts = [0, 0, 0, 0, 0, 0, 0, 0];
  readonly samples: string[] = [];
  private readonly lastFlip = new Int32Array(TILE_COUNT).fill(-1);

  constructor(private readonly g: Game) {}

  private flag(n: number, msg: string): void {
    this.counts[n]++;
    if (this.samples.length < 40) this.samples.push(`#${n} t${this.g.tick}: ${msg}`);
  }

  /** Invariants 1 and 2, from Game.setOwner. */
  onTransfer(tile: number, prev: number, next: number, ctx: TransferContext): void {
    const g = this.g;
    if (g.phase !== 'playing' || ctx === 'staging') return;
    if (this.lastFlip[tile] === g.tick && ctx !== 'cleanup') this.flag(2, `tile ${tile} flipped twice (${prev} -> ${next}, ${ctx})`);
    this.lastFlip[tile] = g.tick;
    if (prev === 0 || next === 0 || prev === next) return;
    if (ctx === 'treaty' || ctx === 'rebellion' || ctx === 'cleanup') return;
    const P = g.playerById[prev], N = g.playerById[next];
    if (!P || !P.alive) return;
    // Independent territories are fought without a declaration (§4.10).
    if (P.kind === 'tribe' || N?.kind === 'tribe') return;
    if (!g.war.atWar(prev, next)) this.flag(1, `tile ${tile} ${prev} -> ${next} at peace (${ctx})`);
  }

  /** Invariants 3, 4 and 7, when an offensive starts (land) or lands (naval). */
  onOffensiveStart(a: Attack): void {
    const g = this.g;
    const A = g.playerById[a.attacker], D = g.playerById[a.defender];
    if (!A || a.defender === 0 || !D) return;
    if (A.kind === 'tribe' && D.kind !== 'tribe') this.flag(7, `independent ${a.attacker} attacks ${a.defender}`);
    if (D.kind === 'tribe' || A.kind === 'tribe') return;
    const w = g.war.between(a.attacker, a.defender);
    if (!w) {
      if (A.id !== HUMAN_ID) this.flag(3, `AI ${a.attacker} offensive on ${a.defender} at peace`);
      else this.flag(3, `human offensive on ${a.defender} at peace`);
      return;
    }
    if (w.a === a.attacker && g.tick < w.mobilizeUntilTick) {
      this.flag(4, `${a.attacker} attacks ${a.defender} at ${g.tick} < mobilization ${w.mobilizeUntilTick}`);
    }
  }

  /** Invariant 3 for naval invasions (at the launch) and strikes / missiles (at the launch). */
  onHostileLaunch(owner: number, targetOwner: number, what: string): void {
    const g = this.g;
    if (owner === targetOwner || targetOwner === 0) return;
    const A = g.playerById[owner], D = g.playerById[targetOwner];
    if (!A || !D || D.kind === 'tribe' || A.kind === 'tribe') return;
    if (!g.war.atWar(owner, targetOwner)) this.flag(3, `${what} by ${owner} on ${targetOwner} at peace`);
    else if (what === 'invasion') {
      const w = g.war.between(owner, targetOwner)!;
      if (w.a === owner && g.tick < w.mobilizeUntilTick) this.flag(4, `invasion by ${owner} before mobilization ends`);
    }
  }

  /** Invariant 5: an offensive took more tiles this tick than its cap. */
  onCaptures(a: Attack, taken: number, cap: number): void {
    if (taken > cap) this.flag(5, `offensive ${a.id} took ${taken} > cap ${cap}`);
  }

  /** Invariant 5: a tile fell with the defender's logistics bucket empty. */
  onBucketOverdraw(w: War, defender: number): void {
    this.flag(5, `war ${w.id}: ${defender} lost a tile with an empty logistics bucket`);
  }

  /** Invariant 6: an AI nuclear detonation whose outer radius covers land of `victims` not at war with it. */
  onNuclearDetonation(owner: number, victims: Iterable<number>): void {
    const g = this.g;
    const A = g.playerById[owner];
    if (!A || A.kind === 'human') return;
    for (const v of victims) {
      if (v === 0 || v === owner) continue;
      if (!g.war.atWar(owner, v)) this.flag(6, `AI ${owner} nuclear detonation covers ${v} (not at war)`);
    }
  }

  onWarDeclared(_w: War): void {
    // Wars themselves are always legal; the rules above check what happens inside them.
  }

  report(): InvariantReport {
    return { counts: this.counts.slice(), samples: this.samples.slice() };
  }
}
