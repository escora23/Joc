// FRONT ULTRA — AI nations director (owner: sim-ai). Runs inside the sim worker, deterministic (game.rng only).
//
// createAiDirector(game) builds the AI side of a game:
//   * setup(): real nations at their capitals (weighted by geopolitical weight, signature colors, personality deck)
//     and neutral tribes on empty land (setup.ts).
//   * tick(): every AI player owns a Brain with independent, jittered decision clocks (war, build, military,
//     naval, nukes, diplomacy) whose periods come from the difficulty profile, so the work is spread over ticks and
//     the cost per tick stays small. Tribes and rebels run lighter brains. The human's nation is played too when
//     GameConfig.humanAutopilot is set (shots, playtests).
//   * onEvent(): the AI's senses — alliance requests (answered after a human-like delay), betrayals (remembered by
//     everyone), nukes (retaliation, emergency air defense), emotes and donations (trust), ally target marks,
//     world events (gold rushes attract armies, pandemics trigger quarantines, rebels fight their old masters).
//
// Modules: profiles.ts (personality x difficulty tables), setup.ts, perception.ts (front scans), war.ts,
// economy.ts, military.ts (units + nukes), naval.ts, diplomacy.ts, state.ts / context.ts / mapindex.ts.

import { HUMAN_ID } from '../../shared/constants';
import type { SimEvent } from '../../shared/protocol';
import type { AiDirector, SimGame, SimPlayer } from '../../shared/simapi';
import { StructureType, UnitType, type EmoteId, type Personality } from '../../shared/types';
import { alive, home, isMajor, relation, type AiContext } from './context';
import { allianceStillUseful, helpAlly, onAllianceRequest, onEmote, recordBetrayal, resolveReply, thinkDiplomacy } from './diplomacy';
import { placeFor, thinkBuild } from './economy';
import { MapIndex, dist2 } from './mapindex';
import { emergencyAirDefense, thinkMilitary, thinkNukes } from './military';
import { SETTLE_EVERY, thinkNaval, thinkSettle } from './naval';
import { AUTOPILOT_PERSONALITY, DIFFICULTY, PERSONALITY, REBEL_PERSONALITY, autopilotDifficulty } from './profiles';
import { setupWorld } from './setup';
import { sharedEventState } from '../events/bridge';
import { emptyFront, pairKey, type Brain, type WorldModel } from './state';
import { thinkTribe, thinkWar } from './war';

export function createAiDirector(game: SimGame): AiDirector {
  // `let`: a save restores these objects wholesale (restoreState).
  let rng = game.rng.fork('ai');
  let world: WorldModel = {
    betrayals: new Map(), nukesBy: new Map(), detonations: 0, leader: 0, leaderShare: 0, secondShare: 0, leaderTick: -1,
    wars: new Map(), doomsday: 0, rushTile: -1, rushUntil: 0, infected: sharedEventState(game).infected,
    lastAiWarTick: -1_000_000, firstUses: 0, unprovoked: new Map(),
  };
  let brains = new Map<number, Brain>();
  let ctx: AiContext | null = null;
  let knownPlayers = 0;
  /** Rebel id -> the nation it broke away from (learned from rebellion events). */
  let rebelParents = new Map<number, number>();

  function context(): AiContext {
    if (!ctx) ctx = { g: game, rng, index: new MapIndex(game), world, brains };
    return ctx;
  }

  function makeBrain(p: SimPlayer, kind: Brain['kind']): Brain {
    const personality: Personality = kind === 'autopilot' || kind === 'rebel' ? 'conqueror' : p.personality ?? 'opportunist';
    const diff = kind === 'autopilot' ? autopilotDifficulty(game.difficulty) : DIFFICULTY[game.difficulty] ?? DIFFICULTY.normal;
    const t = game.tick;
    const b: Brain = {
      id: p.id, kind, personality, prof: kind === 'autopilot' ? AUTOPILOT_PERSONALITY : kind === 'rebel' ? REBEL_PERSONALITY : PERSONALITY[personality], diff,
      nextWar: t + rng.int(diff.warInterval), nextBuild: t + 30 + rng.int(diff.buildInterval),
      nextMilitary: t + 600 + rng.int(diff.militaryInterval), nextNaval: t + 300 + rng.int(diff.navalInterval),
      nextNuke: t + 1200 + rng.int(600), nextDiplomacy: t + 400 + rng.int(diff.diplomacyInterval),
      enemy: 0, enemySince: 0, retaliate: 0, retaliateUntil: 0, parent: rebelParents.get(p.id) ?? 0,
      relations: new Map(), front: emptyFront(), pending: [], lastTiles: 0, idleTicks: 0, rushTile: -1, rushUntil: 0,
      allyTarget: 0, allyTargetUntil: 0, buildFails: 0, lastBoatTick: -1_000_000, lastNukeTick: -1_000_000,
      nukesLaunched: 0, coalitionAnnounced: false, homeTile: p.capitalTile, homeCheckTick: -1_000_000, scratch: [],
      tension: null, lastDeclareTick: -1_000_000, plans: new Map(), nextPeace: t + 240 + rng.int(240), allyNukedBy: new Map(), offCooldown: new Map(), settleFail: new Map(), settling: new Map(), intel: new Map(), lastOffensiveTick: -1_000_000,
    };
    if (kind === 'rebel' && b.parent > 0) {
      b.enemy = b.parent;
      b.enemySince = t;
      relation(b, b.parent).trust = -1;
    }
    p.aiMemory = b;
    brains.set(p.id, b);
    return b;
  }

  /** Adopt players created after setup (rebels from world events, late joiners). */
  function adoptNewPlayers(): void {
    const list = game.players();
    if (list.length === knownPlayers) return;
    for (let i = knownPlayers; i < list.length; i++) {
      const p = list[i];
      if (brains.has(p.id)) continue;
      if (p.kind === 'nation') makeBrain(p, 'nation');
      else if (p.kind === 'tribe') makeBrain(p, 'tribe');
      else if (p.kind === 'rebel') makeBrain(p, 'rebel');
    }
    knownPlayers = list.length;
  }

  function jitter(interval: number): number {
    return Math.max(1, Math.round(interval * (0.75 + rng.next() * 0.5)));
  }

  /** Who is running away with the game (coalition trigger). */
  function updateLeader(): void {
    let top: SimPlayer | null = null, second: SimPlayer | null = null;
    for (const p of game.players()) {
      if (!alive(p) || !isMajor(p)) continue;
      if (!top || p.tiles > top.tiles) {
        second = top;
        top = p;
      } else if (!second || p.tiles > second.tiles) second = p;
    }
    const land = Math.max(1, game.world.landTiles);
    world.leaderShare = top ? top.tiles / land : 0;
    world.secondShare = second ? second.tiles / land : 0;
    // A leader only counts as "runaway" when clearly ahead of the pack.
    world.leader = top && world.leaderShare > 0.12 && world.leaderShare > world.secondShare * 1.5 ? top.id : 0;
    world.leaderTick = game.tick;
    for (const [k, t] of world.wars) if (game.tick - t > 3000) world.wars.delete(k);
  }

  function runPending(c: AiContext, b: Brain, p: SimPlayer): void {
    if (b.pending.length === 0) return;
    const now = game.tick;
    for (let i = 0; i < b.pending.length; i++) {
      const a = b.pending[i];
      if (a.at > now) continue;
      b.pending.splice(i--, 1);
      switch (a.kind) {
        case 'reply':
          resolveReply(c, b, p, a.other);
          break;
        case 'emote':
          game.issue(p.id, { type: 'emote', target: a.other, emote: a.data as EmoteId });
          break;
        case 'renew': {
          const q = game.player(a.other);
          if (!alive(q) || game.isAllied(p.id, q.id) || relation(b, q.id).trust <= -0.3) break;
          // Peace offers are always sent; renewals only when the alliance still serves us.
          if (a.data === 'peace' || allianceStillUseful(c, b, p, q)) game.issue(p.id, { type: 'allianceRequest', target: q.id });
          break;
        }
        case 'helpAlly':
          helpAlly(c, b, p, a.other);
          break;
        case 'sam': {
          if (emergencyAirDefense(c, b, p)) {
            const t = placeFor(c, b, p, StructureType.SamSite);
            if (t >= 0) game.issue(p.id, { type: 'build', structure: StructureType.SamSite, tile: t });
          }
          break;
        }
      }
    }
  }

  function insaneCheats(p: SimPlayer, b: Brain): void {
    if (b.diff.cheatGold > 0) game.addGold(p.id, p.income * 50 * b.diff.cheatGold);
    if (b.diff.cheatTroops > 0 && p.troops < p.maxTroops) game.addTroops(p.id, p.maxTroops * b.diff.cheatTroops);
  }

  function think(c: AiContext, b: Brain, p: SimPlayer): void {
    const t = game.tick;
    runPending(c, b, p);
    if (b.kind === 'tribe') {
      if (t >= b.nextWar) {
        b.nextWar = t + jitter(40);
        thinkTribe(c, b, p);
      }
      return;
    }
    const d = b.diff;
    home(c, b, p);
    if (t >= b.nextWar) {
      b.nextWar = t + jitter(d.warInterval);
      thinkWar(c, b, p, d.warInterval);
    }
    if (b.kind === 'rebel') return;
    if (t >= b.nextBuild) {
      b.nextBuild = t + jitter(d.buildInterval);
      thinkBuild(c, b, p);
    }
    if (t >= b.nextNaval) {
      b.nextNaval = t + jitter(d.navalInterval);
      thinkNaval(c, b, p);
    }
    // v2 (§10.6, T39): after the land race, settlers for the unclaimed islands within reach.
    if ((t + b.id * 37) % SETTLE_EVERY === 0) thinkSettle(c, b, p);
    if (t >= b.nextMilitary) {
      b.nextMilitary = t + jitter(d.militaryInterval);
      thinkMilitary(c, b, p);
    }
    if (t >= b.nextNuke) {
      b.nextNuke = t + jitter(160);
      thinkNukes(c, b, p);
    }
    if (t >= b.nextDiplomacy) {
      b.nextDiplomacy = t + jitter(d.diplomacyInterval);
      thinkDiplomacy(c, b, p);
    }
    if (game.difficulty === 'insane' && b.kind === 'nation' && (t + b.id) % 50 === 0) insaneCheats(p, b);
  }

  // =================================================================================================
  // Events (synchronous, from inside other systems: only update memory and queue work here)
  // =================================================================================================
  function onEvent(e: SimEvent): void {
    const c = ctx;
    if (!c) return;
    switch (e.type) {
      case 'attackStarted': {
        if (e.attacker <= 0 || e.defender <= 0) return;
        world.wars.set(pairKey(e.attacker, e.defender), e.tick);
        const b = brains.get(e.defender);
        if (b) {
          const r = relation(b, e.attacker);
          r.attackedTick = e.tick;
          r.trust = Math.max(-1, r.trust - 0.15);
          r.grievance += 0.5;
        }
        // Allies of the victim may come to help.
        const victim = game.player(e.defender);
        if (victim) {
          for (const a of victim.allies) {
            const ab = brains.get(a);
            if (!ab || ab.kind !== 'nation' || game.isAllied(a, e.attacker)) continue;
            const rv = relation(ab, e.defender);
            if (rng.next() < 0.3 + ab.prof.diplomacy * 0.4 + rv.trust * 0.2) {
              ab.allyTarget = e.attacker;
              ab.allyTargetUntil = e.tick + 1500;
              rv.sharedEnemyTick = e.tick;
            }
          }
        }
        return;
      }
      case 'allianceRequested': {
        const b = brains.get(e.to);
        if (b && b.kind !== 'tribe' && b.kind !== 'rebel') onAllianceRequest(c, b, e.from);
        return;
      }
      case 'allianceFormed': {
        for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
          const b = brains.get(x);
          if (!b) continue;
          const r = relation(b, y);
          r.alliedTick = e.tick;
          r.trust = Math.min(1, r.trust + 0.25);
          if (b.enemy === y) b.enemy = 0;
          if (b.allyTarget === y) b.allyTarget = 0;
        }
        world.wars.delete(pairKey(e.a, e.b));
        return;
      }
      case 'allianceBroken':
        recordBetrayal(c, e.breaker, e.victim);
        return;
      case 'allianceExpired': {
        // The friendlier side asks to renew if the alliance still serves it.
        const ba = brains.get(e.a), bb = brains.get(e.b);
        const asker = ba && bb ? (ba.prof.diplomacy >= bb.prof.diplomacy ? ba : bb) : ba ?? bb;
        if (!asker) return;
        const other = asker.id === e.a ? e.b : e.a;
        if (relation(asker, other).trust > 0 || rng.next() < asker.prof.diplomacy * 0.5) {
          asker.pending.push({ at: e.tick + 20 + rng.int(80), kind: 'renew', other, flag: false, data: '' });
        }
        return;
      }
      case 'warDeclared': {
        // §5.1 `unprovokedWar`: a war of choice on a nation that was not hostile (retaliation, defence, liberation and
        // wars on the runaway leader are provoked).
        if (e.goal !== 'retaliation' && e.goal !== 'defense' && e.goal !== 'liberation' && e.goal !== 'coalition' && !e.parentWar) {
          world.unprovoked.set(e.aggressor, e.tick);
        }
        return;
      }
      case 'nukeLaunched': {
        if (e.weapon === UnitType.CruiseMissile) return; // conventional
        world.nukesBy.set(e.owner, (world.nukesBy.get(e.owner) ?? 0) + 1);
        const b = brains.get(e.targetOwner);
        if (b && e.targetOwner !== e.owner) {
          const r = relation(b, e.owner);
          r.nukedTick = e.tick;
          r.nukesReceived = (r.nukesReceived ?? 0) + 1;
          r.trust = -1;
          r.grievance += 4;
          b.retaliate = e.owner;
          b.retaliateUntil = e.tick + Math.round(4000 * (0.6 + b.prof.vengeance));
          b.enemy = e.owner;
          b.enemySince = e.tick;
          b.nextNuke = Math.min(b.nextNuke, e.tick + 10 + rng.int(40));
          b.pending.push({ at: e.tick + 5 + rng.int(20), kind: 'sam', other: e.owner, flag: false, data: '' });
        }
        // Allies of the victim share the outrage.
        const victim = game.player(e.targetOwner);
        if (victim) {
          for (const a of victim.allies) {
            const ab = brains.get(a);
            if (ab) {
              const r = relation(ab, e.owner);
              r.trust = Math.max(-1, r.trust - 0.4);
              ab.allyNukedBy.set(e.owner, e.tick);
            }
          }
        }
        return;
      }
      case 'nukeDetonated':
        if (e.weapon !== UnitType.CruiseMissile) world.detonations++;
        return;
      case 'emote': {
        if (e.to <= 0 || e.from === e.to) return;
        const b = brains.get(e.to);
        if (b && b.kind !== 'tribe' && b.kind !== 'autopilot') onEmote(c, b, e.from, e.emote);
        return;
      }
      case 'donation': {
        const b = brains.get(e.to);
        if (!b) return;
        const r = relation(b, e.from);
        r.trust = Math.min(1, r.trust + Math.min(0.5, (e.gold / 1_000_000 + e.troops / 100_000) * 0.25 + 0.05));
        r.helpedTick = e.tick;
        if (e.from === HUMAN_ID && b.kind !== 'autopilot' && rng.next() < 0.95) {
          b.pending.push({ at: e.tick + 10 + rng.int(40), kind: 'emote', other: e.from, flag: false, data: 'heart' });
        }
        return;
      }
      case 'message': {
        // An ally marked a target: "help me against X".
        if (e.key !== 'msg.allyTarget') return;
        const b = brains.get(e.playerId);
        const from = Number(e.params.from), target = Number(e.params.target);
        if (!b || !(target > 0) || game.isAllied(b.id, target)) return;
        const willing = from === HUMAN_ID ? 0.8 + b.prof.diplomacy * 0.2 : 0.45 + b.prof.diplomacy * 0.45;
        if (relation(b, from).trust > -0.2 && rng.next() < willing) {
          b.allyTarget = target;
          b.allyTargetUntil = e.tick + 2400;
          if (from === HUMAN_ID) b.pending.push({ at: e.tick + 15 + rng.int(40), kind: 'emote', other: from, flag: false, data: 'thumbsUp' });
        }
        return;
      }
      case 'worldEvent': {
        if (e.stage !== 'start') return;
        if (e.kind === 'goldRush') {
          const tile = Math.floor(e.y) * game.world.width + Math.floor(e.x);
          world.rushTile = tile;
          world.rushUntil = e.tick + 1800;
          for (const b of brains.values()) {
            const p = game.player(b.id);
            if (!p || b.homeTile < 0 || b.kind === 'tribe') continue;
            if (dist2(b.homeTile, tile) < 160 * 160) {
              b.rushTile = tile;
              b.rushUntil = e.tick + 1800;
            }
          }
        } else if (e.kind === 'rebellion' && e.players.length >= 2) {
          const [parent, rebel] = e.players;
          rebelParents.set(rebel, parent);
          const rb = brains.get(rebel);
          if (rb) {
            rb.parent = parent;
            rb.enemy = parent;
          }
          const pb = brains.get(parent);
          if (pb) {
            pb.enemy = rebel;
            pb.enemySince = e.tick;
            pb.nextWar = Math.min(pb.nextWar, e.tick + 20);
          }
        }
        return;
      }
      case 'doomsday':
        world.doomsday = e.level;
        return;
      case 'nationEliminated': {
        const p = game.player(e.playerId);
        if (p && brains.has(e.playerId)) {
          p.aiMemory = null;
          brains.delete(e.playerId);
        }
        for (const o of brains.values()) {
          if (o.enemy === e.playerId) o.enemy = 0;
          if (o.retaliate === e.playerId) o.retaliate = 0;
          if (o.allyTarget === e.playerId) o.allyTarget = 0;
          o.relations.delete(e.playerId);
        }
        return;
      }
    }
  }

  return {
    setup() {
      const c = context();
      const res = setupWorld(game, rng, c.index);
      for (const n of res.nations) {
        const p = game.player(n.id);
        if (p) makeBrain(p, 'nation');
      }
      for (const id of res.tribes) {
        const p = game.player(id);
        if (p) makeBrain(p, 'tribe');
      }
      knownPlayers = game.players().length;
    },
    tick() {
      if (game.phase !== 'playing') return;
      const c = context();
      adoptNewPlayers();
      if (game.config.humanAutopilot && !brains.has(HUMAN_ID)) {
        const h = game.player(HUMAN_ID);
        if (h) makeBrain(h, 'autopilot');
      }
      if (game.tick - world.leaderTick >= 100) updateLeader();
      for (const b of brains.values()) {
        const p = game.player(b.id);
        if (!p || !p.alive || !p.spawned) continue;
        think(c, b, p);
      }
    },
    onEvent,
    // v2 (§12.8): everything the AI remembers, for saves (the map index is rebuilt on load).
    snapshotState() {
      return { brains, world, rng, knownPlayers, rebelParents };
    },
    restoreState(state: unknown) {
      const s = state as { brains: Map<number, Brain>; world: WorldModel; rng: typeof rng; knownPlayers: number; rebelParents: Map<number, number> };
      brains = s.brains;
      for (const b of brains.values()) {
        b.offCooldown ??= new Map();
        b.settleFail ??= new Map();
        b.settling ??= new Map();
        b.intel ??= new Map();
        b.lastOffensiveTick ??= -1_000_000;
      }
      world = s.world;
      world.firstUses ??= 0;
      world.unprovoked ??= new Map();
      rng = s.rng;
      knownPlayers = s.knownPlayers;
      rebelParents = s.rebelParents;
      sharedEventState(game).infected = world.infected;
      ctx = null;
    },
  };
}
