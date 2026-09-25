// FRONT ULTRA — diplomacy: alliance requests/acceptance/expiry/betrayal (traitor debuff), embargoes (permanent and
// automatic temporary ones after being attacked), donations, emotes and target marking. Owner: sim-core.

import { BALANCE, HUMAN_ID } from '../shared/constants';
import type { AllianceRequestView, AllianceView, EmoteId } from '../shared/types';
import { ALLIANCE_REQUEST_COOLDOWN, DONATE_COOLDOWN, EMOTE_COOLDOWN } from './balance';
import type { Game } from './game';
import type { Player } from './state';

interface AllianceRec {
  a: number;
  b: number;
  expiresTick: number;
  warned: boolean;
}

interface RequestRec {
  from: number;
  to: number;
  expiresTick: number;
}

export class Diplomacy {
  private readonly alliances = new Map<number, AllianceRec>();
  private requests: RequestRec[] = [];

  constructor(private readonly g: Game) {}

  allianceViews(): AllianceView[] {
    return [...this.alliances.values()].map((r) => ({ a: r.a, b: r.b, expiresTick: r.expiresTick }));
  }

  requestViews(): AllianceRequestView[] {
    return this.requests.map((r) => ({ from: r.from, to: r.to, expiresTick: r.expiresTick }));
  }

  request(p: Player, target: number): boolean {
    const g = this.g;
    const t = g.playerObj(target);
    if (!t || !t.alive || target === p.id || g.phase !== 'playing') return false;
    if (p.allies.has(target)) return false;
    // v2: enemies make peace first (§4.1).
    if (g.war.atWar(p.id, target)) {
      g.message(p.id, 'msg.atWarNoAlliance');
      return false;
    }
    if (t.kind === 'tribe' || t.kind === 'rebel') {
      g.message(p.id, 'msg.cannotAllyTribe');
      return false;
    }
    const ready = p.allianceRequestReady.get(target) ?? 0;
    if (ready > g.tick) {
      g.message(p.id, 'msg.cooldown', 'info');
      return false;
    }
    if (this.requests.some((r) => r.from === p.id && r.to === target)) return false;
    // They already asked us: accept on the spot.
    const reverse = this.requests.findIndex((r) => r.from === target && r.to === p.id);
    if (reverse >= 0) {
      this.requests.splice(reverse, 1);
      this.form(target, p.id);
      return true;
    }
    this.requests.push({ from: p.id, to: target, expiresTick: g.tick + BALANCE.allianceRequestTimeoutTicks });
    p.allianceRequestReady.set(target, g.tick + ALLIANCE_REQUEST_COOLDOWN);
    g.alliancesDirty = true;
    g.emit({ type: 'allianceRequested', tick: g.tick, from: p.id, to: target });
    return true;
  }

  reply(p: Player, from: number, accept: boolean): boolean {
    const g = this.g;
    const i = this.requests.findIndex((r) => r.from === from && r.to === p.id);
    if (i < 0) return false;
    this.requests.splice(i, 1);
    g.alliancesDirty = true;
    const f = g.playerObj(from);
    if (!f || !f.alive) return false;
    if (accept && g.war.atWar(from, p.id)) accept = false;
    if (accept) this.form(from, p.id);
    else g.emit({ type: 'allianceRejected', tick: g.tick, from, to: p.id });
    return true;
  }

  private form(a: number, b: number): void {
    const g = this.g;
    const pa = g.playerObj(a)!, pb = g.playerObj(b)!;
    pa.allies.add(b);
    pb.allies.add(a);
    pa.metaDirty = pb.metaDirty = true;
    pa.tempEmbargo.delete(b);
    pb.tempEmbargo.delete(a);
    if (pa.targetPlayer === b) pa.targetPlayer = 0;
    if (pb.targetPlayer === a) pb.targetPlayer = 0;
    this.alliances.set(g.pairKey(a, b), { a, b, expiresTick: g.tick + BALANCE.allianceDurationTicks, warned: false });
    // Drop any request between them.
    this.requests = this.requests.filter((r) => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
    g.alliancesDirty = true;
    g.attacks.cancelBetween(a, b);
    g.hostility.delete(g.pairKey(a, b));
    g.emit({ type: 'allianceFormed', tick: g.tick, a, b });
  }

  breakAlliance(p: Player, target: number): boolean {
    const g = this.g;
    const t = g.playerObj(target);
    if (!t || !p.allies.has(target)) return false;
    this.remove(p.id, target);
    p.traitorUntilTick = g.tick + BALANCE.traitorDurationTicks;
    p.metaDirty = true;
    g.emit({ type: 'allianceBroken', tick: g.tick, breaker: p.id, victim: target });
    if (target === HUMAN_ID) g.message(HUMAN_ID, 'msg.betrayed', 'danger', { player: p.id });
    return true;
  }

  /**
   * v2 (W1): a declaration of war on an ally breaks the alliance (the war system marks the traitor and emits the war;
   * this only dissolves the treaty and tells the victim).
   */
  breakAllianceForWar(breaker: number, victim: number): void {
    const g = this.g;
    const p = g.playerObj(breaker);
    if (!p || !p.allies.has(victim)) return;
    this.remove(breaker, victim);
    g.emit({ type: 'allianceBroken', tick: g.tick, breaker, victim });
    if (victim === HUMAN_ID) g.message(HUMAN_ID, 'msg.betrayed', 'danger', { player: breaker });
  }

  private remove(a: number, b: number): void {
    const g = this.g;
    const pa = g.playerObj(a), pb = g.playerObj(b);
    pa?.allies.delete(b);
    pb?.allies.delete(a);
    if (pa) pa.metaDirty = true;
    if (pb) pb.metaDirty = true;
    this.alliances.delete(g.pairKey(a, b));
    g.alliancesDirty = true;
  }

  embargo(p: Player, target: number, active: boolean): boolean {
    const g = this.g;
    if (target === p.id || !g.playerObj(target)) return false;
    if (active === p.embargoes.has(target)) return true;
    if (active) p.embargoes.add(target);
    else {
      p.embargoes.delete(target);
      p.tempEmbargo.delete(target);
    }
    p.metaDirty = true;
    g.emit({ type: 'embargoChanged', tick: g.tick, from: p.id, to: target, active });
    return true;
  }

  donate(p: Player, target: number, gold: number, troops: number): boolean {
    const g = this.g;
    const t = g.playerObj(target);
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

  emote(p: Player, target: number, emote: EmoteId): boolean {
    const g = this.g;
    if (p.emoteReadyTick > g.tick) return false;
    p.emoteReadyTick = g.tick + EMOTE_COOLDOWN;
    g.emit({ type: 'emote', tick: g.tick, from: p.id, to: target, emote });
    return true;
  }

  targetPlayer(p: Player, target: number): boolean {
    const g = this.g;
    if (target !== 0) {
      const t = g.playerObj(target);
      if (!t || !t.alive || target === p.id || p.allies.has(target)) return false;
    }
    p.targetPlayer = target;
    for (const a of p.allies) {
      g.emit({ type: 'message', tick: g.tick, playerId: a, key: 'msg.allyTarget', params: { from: p.id, target }, severity: 'info' });
    }
    return true;
  }

  /** A player died: dissolve its alliances and requests. */
  dropPlayer(pid: number): void {
    const g = this.g;
    for (const r of [...this.alliances.values()]) if (r.a === pid || r.b === pid) this.remove(r.a, r.b);
    this.requests = this.requests.filter((r) => r.from !== pid && r.to !== pid);
    for (const p of g.playerArr) {
      if (p.targetPlayer === pid) p.targetPlayer = 0;
      if (p.embargoes.delete(pid) || p.tempEmbargo.delete(pid)) p.metaDirty = true;
    }
    g.alliancesDirty = true;
  }

  step(): void {
    const g = this.g;
    const tick = g.tick;
    for (const r of [...this.alliances.values()]) {
      if (!r.warned && r.expiresTick - tick <= 300) {
        r.warned = true;
        if (r.a === HUMAN_ID || r.b === HUMAN_ID) g.message(HUMAN_ID, 'msg.allianceExpiring', 'info', { player: r.a === HUMAN_ID ? r.b : r.a });
      }
      if (r.expiresTick <= tick) {
        this.remove(r.a, r.b);
        g.emit({ type: 'allianceExpired', tick, a: r.a, b: r.b });
      }
    }
    if (this.requests.length) {
      const keep: RequestRec[] = [];
      for (const r of this.requests) {
        if (r.expiresTick > tick) keep.push(r);
        else g.emit({ type: 'allianceRejected', tick, from: r.from, to: r.to });
      }
      if (keep.length !== this.requests.length) {
        this.requests = keep;
        g.alliancesDirty = true;
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
  }
}
