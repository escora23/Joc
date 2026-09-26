// FRONT ULTRA — main-thread sim client & GameView (owner: sim-core).
// Owns the worker, buffers its messages and applies them in pump() at the start of each frame, so every
// subsystem sees one consistent state per frame. Re-emits sim events on the bus, raises nuke alarms for the
// human, and records the stats history (every 5 s of game time) and the timelapse (400x200 RLE frames every 10 s).

import { GAME_SECONDS_PER_TICK, HUMAN_ID, MAP_H, MAP_W, STRUCTURE_DEFS, TILE_COUNT, UNIT_DEFS, structureCost } from '../shared/constants';
import { hasKey, inSentence, playerName, t } from '../shared/i18n';
import type { GameBus } from '../shared/events';
import type { GameView, ProgressFn, SimClientApi } from '../shared/api';
import {
  PF, PLAYER_STRIDE, UF, UNIT_STRIDE, unpackOwner, unpackTile,
  type FromWorker, type PlayerCommand, type SimEvent, type TickUpdate, type ToWorker,
} from '../shared/protocol';
import { clamp01, lerpAngle } from '../shared/math';
import {
  UnitType, emptyStats, type OpinionView, type ProposalView, type TreatyKind, type TreatyView, type AllianceRequestView, type AllianceView, type AttackView, type ClockView, type FrontView,
  type GameConfig, type GamePhase, type GameSpeed, type PairState, type PlayerView, type ScarView, type SiegeView,
  type StatsSample, type StructureType, type StructureView, type Timelapse, type UnitState, type UnitView, type WarView,
  type WorldData, type WorldEventView, type ProductionView, type UnitMode,
} from '../shared/types';
import { worldInit } from '../data';
import { unitPrice } from './balance';
import './shots';
import { registerSimStrings } from './strings';

const TL_W = 400;
const TL_H = 200;
const TL_EVERY_TICKS = 100;
const HISTORY_EVERY_TICKS = 50;

class RleTimelapse implements Timelapse {
  readonly width = TL_W;
  readonly height = TL_H;
  private frames: { tick: number; rle: Uint16Array }[] = [];
  private runs = new Uint16Array(TL_W * TL_H * 2);
  get frameCount(): number {
    return this.frames.length;
  }
  frameTick(i: number): number {
    return this.frames[i]?.tick ?? 0;
  }
  capture(tick: number, owner: Uint16Array): void {
    const sx = MAP_W / TL_W, sy = MAP_H / TL_H;
    const runs = this.runs;
    let n = 0;
    let cur = -1, len = 0;
    for (let y = 0; y < TL_H; y++) {
      const row = Math.floor((y + 0.5) * sy) * MAP_W;
      for (let x = 0; x < TL_W; x++) {
        const v = owner[row + Math.floor((x + 0.5) * sx)];
        if (v === cur && len < 65535) len++;
        else {
          if (len) {
            runs[n++] = cur;
            runs[n++] = len;
          }
          cur = v;
          len = 1;
        }
      }
    }
    if (len) {
      runs[n++] = cur;
      runs[n++] = len;
    }
    this.frames.push({ tick, rle: runs.slice(0, n) });
  }
  decode(i: number, out: Uint16Array): void {
    const f = this.frames[i];
    if (!f) return;
    let p = 0;
    const r = f.rle;
    for (let k = 0; k < r.length; k += 2) {
      out.fill(r[k], p, p + r[k + 1]);
      p += r[k + 1];
    }
  }
  clear(): void {
    this.frames = [];
  }
}

class ClientView implements GameView {
  config: GameConfig | null = null;
  world: WorldData | null = null;
  phase: GamePhase = 'none';
  speed: GameSpeed = 1;
  tick = 0;
  prevTick = 0;
  alpha = 1;
  simTime = 0;
  owner = new Uint16Array(TILE_COUNT);
  players: (PlayerView | undefined)[] = [];
  playerList: PlayerView[] = [];
  human: PlayerView | null = null;
  units = new Map<number, UnitView>();
  structures = new Map<number, StructureView>();
  attacks: AttackView[] = [];
  fronts: FrontView[] = [];
  scars: ScarView[] = [];
  worldEvents: WorldEventView[] = [];
  alliances: AllianceView[] = [];
  allianceRequests: AllianceRequestView[] = [];
  doomsday = 0;
  spawnDeadlineTick = 0;
  winner = 0;
  history: StatsSample[] = [];
  timelapse = new RleTimelapse();
  tickMs = 0;
  /** MIRVs the human launched (MIRV price escalates). */
  humanMirvs = 0;
  // --- v2 (W1) ---
  clock: ClockView = { mode: 'strategic', rate: 3600, tickPeriodMs: 100, speed: 1 };
  gameHours = 0;
  wars: WarView[] = [];
  sieges: SiegeView[] = [];
  frontByKey = new Map<number, FrontView>();
  /** Occupied tiles (mirror of the sim's occupation set). */
  readonly occupied = new Uint8Array(TILE_COUNT);
  readonly occupiedTiles = new Set<number>();
  // --- v2 (W4) ---
  /** Planned paths by unit (tile waypoints), from TickUpdate.routes; dropped when the unit leaves the view. */
  routes = new Map<number, Int32Array>();
  /** The sim's rail graph as station-id pairs. */
  rail: Int32Array = new Int32Array(0);
  /** Bumped whenever `rail` changes (renderers rebuild the lines). */
  railRev = 0;
  /** The human's production queue. */
  production: ProductionView[] = [];

  // --- v2 (W3) ---
  treaties: TreatyView[] = [];
  /** The AIs' opinions of the human, by AI id. */
  opinions = new Map<number, OpinionView>();
  /** The human's proposals (open ones and the latest answered), by id. */
  proposals = new Map<number, ProposalView>();
  /** Wall time (performance.now()) of the last proposals update, to count the real-time floor down between updates. */
  proposalsAtMs = 0;
  hasTreaty(a: number, b: number, kind: TreatyKind): boolean {
    for (const t of this.treaties) if (t.kind === kind && ((t.a === a && t.b === b) || (t.a === b && t.b === a))) return true;
    return false;
  }
  treatiesBetween(a: number, b: number): TreatyView[] {
    return this.treaties.filter((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a));
  }

  isOccupied(tile: number): boolean {
    return this.occupied[tile] === 1;
  }
  occupiedCount(player: number): number {
    let n = 0;
    for (const t of this.occupiedTiles) if (this.owner[t] === player) n++;
    return n;
  }
  warBetween(a: number, b: number): WarView | null {
    for (const w of this.wars) if ((w.aggressor === a && w.target === b) || (w.aggressor === b && w.target === a)) return w;
    return null;
  }
  /** Truces are published on the war list's companion: a pair with no war is at peace unless a truce view exists. */
  truces: { a: number; b: number; untilTick: number }[] = [];
  pairState(a: number, b: number): PairState {
    if (this.warBetween(a, b)) return 'war';
    for (const t of this.truces) if (((t.a === a && t.b === b) || (t.a === b && t.b === a)) && t.untilTick > this.tick) return 'truce';
    return 'peace';
  }

  ownerAt(tile: number): number {
    return this.owner[tile];
  }
  structureCost(type: StructureType): number {
    let n = 0;
    for (const s of this.structures.values()) if (s.owner === HUMAN_ID && s.type === type) n++;
    return structureCost(type, n);
  }
  unitCost(type: UnitType): number {
    if (type === UnitType.Mirv) return unitPrice(type, this.humanMirvs);
    // The sim prices by units owned plus units in production (v2 W4): the Arsenal shows what the next one costs.
    let n = 0;
    for (const u of this.units.values()) if (u.owner === HUMAN_ID && u.type === type && u.state !== 6) n++;
    for (const q of this.production) if (q.unit === type) n++;
    return unitPrice(type, n);
  }
  reset(): void {
    this.config = null;
    this.world = null;
    this.phase = 'none';
    this.tick = 0;
    this.prevTick = 0;
    this.alpha = 1;
    this.simTime = 0;
    this.owner.fill(0);
    this.players = [];
    this.playerList = [];
    this.human = null;
    this.units.clear();
    this.structures.clear();
    this.attacks = [];
    this.fronts = [];
    this.scars = [];
    this.worldEvents = [];
    this.alliances = [];
    this.allianceRequests = [];
    this.doomsday = 0;
    this.spawnDeadlineTick = 0;
    this.winner = 0;
    this.history = [];
    this.timelapse.clear();
    this.tickMs = 0;
    this.humanMirvs = 0;
    this.clock = { mode: 'strategic', rate: 3600, tickPeriodMs: 100, speed: 1 };
    this.gameHours = 0;
    this.wars = [];
    this.sieges = [];
    this.truces = [];
    this.treaties = [];
    this.opinions.clear();
    this.proposals.clear();
    this.proposalsAtMs = 0;
    this.frontByKey.clear();
    this.occupied.fill(0);
    this.occupiedTiles.clear();
    this.routes.clear();
    this.rail = new Int32Array(0);
    this.railRev++;
    this.production = [];
  }
}

export function createSimClient(bus: GameBus): SimClientApi {
  registerSimStrings();
  const view = new ClientView();
  let worker: Worker | null = null;
  /** Worker messages with their arrival time (the interpolation runs on wall time, not on frame time). */
  const queue: { msg: FromWorker; at: number }[] = [];
  // v2 interpolation (§2.5): every update that carries ticks starts a segment from the position the units are drawn
  // at right now to the new sim position, spanning max(1, ticks) × the clock's tick period. Starting from the drawn
  // position (not the previous sample) keeps motion continuous when updates arrive early or late; a clock change
  // mid-segment rebases the span so the interpolation factor never jumps.
  // Jitter buffer (§2.5): every segment lasts one worker loop longer than the time its ticks cover. Segments start from
  // the drawn position, so the steady on-screen velocity is still exactly the sim's (the display trails 0.1 s more), and
  // an update that arrives up to 100 ms late (a busy worker or main thread) no longer stops every unit for a frame
  // and then makes it jump (T40).
  const INTERP_BUFFER_MS = 100;
  let segStartMs = 0;
  let segSpanMs = 100;
  let segTicks = 1;
  let segStartTick = 0;
  let frozenAlpha = -1;
  let saveSeq = 1;
  const saveWaiters = new Map<number, (r: { blob: ArrayBuffer; tick: number }) => void>();
  let loadWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let clockSettings: { crisisTime: 'always' | 'mine' | 'off'; observationTime: boolean } | null = null;

  function onWorkerMessage(msg: FromWorker, mySession: number): void {
    if (mySession !== session) return;
    // The clock is metadata: expose it as soon as it arrives (a stalled frame must not delay "what clock runs now").
    const at = performance.now();
    if (msg.kind === 'update' && msg.u.clock) view.clock = msg.u.clock;
    if (msg.kind === 'update' && api.onArrival) api.onArrival(msg.u, at);
    queue.push({ msg, at });
  }

  function segmentAlpha(now: number): number {
    if (frozenAlpha >= 0) return frozenAlpha;
    if (segSpanMs <= 0) return 1;
    return clamp01((now - segStartMs) / segSpanMs);
  }

  /** Tick period the running segment is timed with (the view's clock may already be newer: it updates on arrival). */
  let segClock: ClockView = { mode: 'strategic', rate: 3600, tickPeriodMs: 100, speed: 1 };
  function applyClock(c: ClockView, now: number): void {
    const prev = segClock;
    segClock = c;
    if (c.rate <= 0) {
      // Paused: the world freezes where it is drawn.
      if (frozenAlpha < 0) frozenAlpha = segmentAlpha(now);
      return;
    }
    const newSpan = Math.max(1, segTicks) * c.tickPeriodMs + INTERP_BUFFER_MS;
    if (frozenAlpha >= 0) {
      segStartMs = now - frozenAlpha * newSpan;
      frozenAlpha = -1;
    } else if (prev.tickPeriodMs !== c.tickPeriodMs) {
      const a = segmentAlpha(now);
      segStartMs = now - a * newSpan;
    }
    segSpanMs = newSpan;
  }
  let readyResolve: (() => void) | null = null;
  let ffSeq = 1;
  const ffWaiters = new Map<number, { resolve: () => void; progress?: ProgressFn }>();
  let unitGen = 0;
  const unitSeen = new Map<number, number>();
  let session = 0;

  function postToWorker(m: ToWorker): void {
    worker?.postMessage(m);
  }

  function ensurePlayer(id: number): PlayerView {
    let p = view.players[id];
    if (!p) {
      p = {
        id, name: `#${id}`, kind: 'nation', personality: null, color: 0x888888, countryIndex: 0, alive: true,
        spawned: false, capitalTile: -1, tiles: 0, troops: 0, maxTroops: 0, troopGrowth: 0, gold: 0, income: 0,
        population: 0, attackingTroops: 0, allies: [], embargoes: [], traitorTicks: 0, labelX: 0, labelY: 0,
        labelSize: 0, stats: emptyStats(),
      };
      view.players[id] = p;
      view.playerList.push(p);
      view.playerList.sort((a, b) => a.id - b.id);
      if (id === HUMAN_ID) view.human = p;
    }
    return p;
  }

  // Speed set by the page but not yet echoed by the worker: updates already in flight still carry the old speed and
  // must not undo it (a quick double '+' would otherwise read the stale speed and stop at 2x).
  let pendingSpeed: GameSpeed | null = null;
  let pendingSpeedAt = 0;

  function apply(u: TickUpdate, now: number): void {
    // Where the units are drawn right now (before this update): the start of the new segment.
    const a0 = segmentAlpha(now);
    const drawnTick = segStartTick + (view.tick - segStartTick) * a0;
    const resync = !!u.fullOwners;
    if (u.ticks > 0 || resync) {
      view.prevTick = resync ? u.tick : view.tick;
      segStartTick = resync ? u.tick : drawnTick;
      segStartMs = now;
      segTicks = Math.max(1, u.ticks);
      frozenAlpha = -1;
    }
    view.tick = u.tick;
    if (pendingSpeed === null || u.speed === pendingSpeed || now - pendingSpeedAt > 2000) {
      view.speed = u.speed;
      pendingSpeed = null;
    }
    view.phase = u.phase;
    view.tickMs = u.tickMs ?? 0;
    if (u.clock) applyClock(u.clock, now);
    if (u.ticks > 0 && !resync) segSpanMs = segTicks * (segClock.tickPeriodMs || 100) + INTERP_BUFFER_MS;
    if (u.clock && u.clock.rate <= 0 && u.ticks > 0) frozenAlpha = 0;

    // Tiles.
    if (u.fullOwners) {
      view.owner.set(u.fullOwners);
      bus.emit('tilesChanged', { packed: new Uint32Array(0), count: 0, full: true });
    } else if (u.owners.length) {
      const o = view.owner;
      const packed = u.owners;
      for (let i = 0; i < packed.length; i++) o[unpackTile(packed[i])] = unpackOwner(packed[i]);
      bus.emit('tilesChanged', { packed, count: packed.length, full: false });
    }

    // Players.
    if (u.playerMeta) {
      for (const m of u.playerMeta) {
        const p = ensurePlayer(m.id);
        p.name = m.name;
        p.kind = m.kind;
        p.personality = m.personality;
        p.color = m.color;
        p.countryIndex = m.countryIndex;
        p.allies = m.allies;
        p.embargoes = m.embargoes;
      }
    }
    const P = u.players;
    for (let o = 0; o < P.length; o += PLAYER_STRIDE) {
      const p = ensurePlayer(P[o + PF.id]);
      p.alive = P[o + PF.alive] === 1;
      p.tiles = P[o + PF.tiles];
      p.troops = P[o + PF.troops];
      p.maxTroops = P[o + PF.maxTroops];
      p.troopGrowth = P[o + PF.troopGrowth];
      p.gold = P[o + PF.gold];
      p.income = P[o + PF.income];
      p.population = P[o + PF.population];
      p.attackingTroops = P[o + PF.attackingTroops];
      p.labelX = P[o + PF.labelX];
      p.labelY = P[o + PF.labelY];
      p.labelSize = P[o + PF.labelSize];
      p.traitorTicks = P[o + PF.traitorTicks];
      p.spawned = P[o + PF.spawned] === 1;
      p.capitalTile = P[o + PF.capitalTile];
    }
    if (u.playerStats) for (const s of u.playerStats) ensurePlayer(s.id).stats = s.stats;

    // Units: full list each update; objects stay stable for renderers.
    const U = u.units;
    const gen = ++unitGen;
    for (let o = 0; o < U.length; o += UNIT_STRIDE) {
      const id = U[o + UF.id];
      unitSeen.set(id, gen);
      let un = view.units.get(id);
      const x = U[o + UF.x], y = U[o + UF.y], h = U[o + UF.heading], alt = U[o + UF.alt];
      if (!un) {
        un = {
          id, type: U[o + UF.type] as UnitType, owner: U[o + UF.owner], x, y, prevX: x, prevY: y, heading: h,
          prevHeading: h, alt, prevAlt: alt, state: U[o + UF.state] as UnitState, hp: U[o + UF.hp],
          troops: U[o + UF.troops], targetX: U[o + UF.targetX], targetY: U[o + UF.targetY],
          originX: U[o + UF.originX], originY: U[o + UF.originY], bornTick: u.tick,
          mode: U[o + UF.mode] as UnitMode, order: U[o + UF.order], etaTicks: U[o + UF.eta], frontKey: U[o + UF.frontKey],
          home: U[o + UF.home], serial: U[o + UF.serial],
        };
        view.units.set(id, un);
      } else {
        if (resync) {
          un.prevX = x;
          un.prevY = y;
          un.prevHeading = h;
          un.prevAlt = alt;
        } else if (u.ticks > 0) {
          // The new segment starts where the unit is drawn now.
          un.prevX = un.prevX + (un.x - un.prevX) * a0;
          un.prevY = un.prevY + (un.y - un.prevY) * a0;
          un.prevHeading = lerpAngle(un.prevHeading, un.heading, a0);
          un.prevAlt = un.prevAlt + (un.alt - un.prevAlt) * a0;
        } else if (x !== un.x || y !== un.y) {
          // Moved without a tick (staging, command-mode sub-steps): no segment to glide along.
          un.prevX = x;
          un.prevY = y;
          un.prevHeading = h;
          un.prevAlt = alt;
        }
        if (un.prevX >= MAP_W) un.prevX -= MAP_W;
        else if (un.prevX < 0) un.prevX += MAP_W;
        // Keep interpolation continuous across the horizontal wrap.
        if (x - un.prevX > MAP_W / 2) un.prevX += MAP_W;
        else if (un.prevX - x > MAP_W / 2) un.prevX -= MAP_W;
        un.x = x;
        un.y = y;
        un.heading = h;
        un.alt = alt;
        un.owner = U[o + UF.owner];
        un.state = U[o + UF.state] as UnitState;
        un.hp = U[o + UF.hp];
        un.troops = U[o + UF.troops];
        un.targetX = U[o + UF.targetX];
        un.targetY = U[o + UF.targetY];
        un.originX = U[o + UF.originX];
        un.originY = U[o + UF.originY];
        un.mode = U[o + UF.mode] as UnitMode;
        un.order = U[o + UF.order];
        un.etaTicks = U[o + UF.eta];
        un.frontKey = U[o + UF.frontKey];
        un.home = U[o + UF.home];
        un.serial = U[o + UF.serial];
      }
    }
    for (const id of view.units.keys()) {
      if (unitSeen.get(id) !== gen) {
        view.units.delete(id);
        unitSeen.delete(id);
        view.routes.delete(id);
      }
    }
    if (u.routes) for (const r of u.routes) view.routes.set(r.unitId, r.tiles);
    if (u.rail) {
      view.rail = u.rail;
      view.railRev++;
    }
    if (u.production) view.production = u.production;

    if (u.structures) {
      view.structures.clear();
      for (const s of u.structures) view.structures.set(s.id, s);
    }
    if (u.attacks) view.attacks = u.attacks;
    if (u.fronts) {
      view.fronts = u.fronts;
      view.frontByKey.clear();
      for (const f of u.fronts) view.frontByKey.set(f.key, f);
    }
    if (u.wars) view.wars = u.wars;
    if (u.sieges) view.sieges = u.sieges;
    if (u.truces) view.truces = u.truces;
    if (u.treaties) view.treaties = u.treaties;
    if (u.opinions) {
      view.opinions.clear();
      for (const o of u.opinions) view.opinions.set(o.of, o);
    }
    if (u.proposals) {
      view.proposals.clear();
      for (const p of u.proposals) view.proposals.set(p.id, p);
      view.proposalsAtMs = performance.now();
    }
    if (u.occupiedFull) {
      view.occupied.fill(0);
      view.occupiedTiles.clear();
      for (const t of u.occupiedFull) {
        view.occupied[t] = 1;
        view.occupiedTiles.add(t);
      }
    } else if (u.occupied) {
      for (const v of u.occupied) {
        const t = Math.abs(v) - 1;
        if (v > 0) {
          view.occupied[t] = 1;
          view.occupiedTiles.add(t);
        } else {
          view.occupied[t] = 0;
          view.occupiedTiles.delete(t);
        }
      }
    }
    if (u.scars) view.scars = u.scars;
    if (u.worldEvents) view.worldEvents = u.worldEvents;
    if (u.alliances) view.alliances = u.alliances;
    if (u.allianceRequests) view.allianceRequests = u.allianceRequests;
    if (u.doomsday !== undefined) view.doomsday = u.doomsday;
    if (u.spawnDeadlineTick !== undefined) view.spawnDeadlineTick = u.spawnDeadlineTick;
    if (u.winner) view.winner = u.winner;

    // History & timelapse (sampled from the mirrored state).
    if (view.phase === 'playing' || view.phase === 'ended') {
      const last = view.history[view.history.length - 1];
      if (!last || u.tick - last.tick >= HISTORY_EVERY_TICKS || (view.phase === 'ended' && last.tick !== u.tick)) {
        const n = view.players.length;
        const s: StatsSample = { tick: u.tick, tiles: new Uint32Array(n), troops: new Float32Array(n), gold: new Float32Array(n) };
        for (const p of view.playerList) {
          s.tiles[p.id] = p.tiles;
          s.troops[p.id] = p.troops;
          s.gold[p.id] = p.gold;
        }
        view.history.push(s);
      }
      const lt = view.timelapse.frameCount ? view.timelapse.frameTick(view.timelapse.frameCount - 1) : -Infinity;
      if (u.tick - lt >= TL_EVERY_TICKS || (view.phase === 'ended' && lt !== u.tick)) view.timelapse.capture(u.tick, view.owner);
    }

    for (const e of u.events) emitSim(e);
    bus.emit('simTick', { tick: u.tick, ticks: u.ticks });
  }

  /** Message params carry ids; add their localised names so UI strings can say {playerName} / {structureName}. */
  function enrichMessage(e: Extract<SimEvent, { type: 'message' }>): void {
    const p = e.params;
    if (typeof p.player === 'number') {
      const pv = view.players[p.player];
      p.playerName = pv ? playerName(pv, view.world) : `#${p.player}`;
    }
    if (typeof p.structure === 'number') {
      const d = STRUCTURE_DEFS[p.structure as StructureType];
      if (d) {
        p.structureName = inSentence(t(`structure.${d.id}`));
        p.g = t(`structure.${d.id}.g`) === 'f' ? 'f' : 'm';
        // A sentence written for this structure (gender, article and adjective agree) wins over the generic one.
        if (hasKey(`${e.key}.${d.id}`)) e.key = `${e.key}.${d.id}`;
      }
    }
    if (typeof p.weapon === 'number') {
      const d = UNIT_DEFS[p.weapon as UnitType];
      if (d) p.weaponName = t(`unit.${d.id}`);
    }
  }

  function emitSim(e: SimEvent): void {
    if (e.type === 'message') enrichMessage(e);
    (bus.emit as (t: string, p: unknown) => void)(e.type, e);
    if (e.type === 'nukeLaunched') {
      if (e.owner === HUMAN_ID && e.weapon === UnitType.Mirv) view.humanMirvs++;
      if (e.targetOwner === HUMAN_ID && e.owner !== HUMAN_ID) {
        // Real seconds to impact at the clock now running (crisis time: one tick every 6 s, §2.2).
        const period = view.clock.rate > 0 ? (GAME_SECONDS_PER_TICK * 1000) / view.clock.rate : 100;
        bus.emit('nukeAlarm', { unitId: e.unitId, targetTile: e.targetTile, etaSec: (e.flightTicks * period) / 1000, weapon: e.weapon });
      }
    }
  }

  const api: SimClientApi = {
    onArrival: null,
    view,
    get running() {
      return worker !== null;
    },
    start(config: GameConfig, world: WorldData): Promise<void> {
      this.stop();
      view.reset();
      view.config = config;
      view.world = world;
      view.speed = config.speed;
      session++;
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'front-ultra-sim' });
      const mySession = session;
      worker.onmessage = (ev: MessageEvent<FromWorker>) => onWorkerMessage(ev.data, mySession);
      worker.onerror = (ev) => console.error('[sim] worker error', ev.message);
      const p = new Promise<void>((resolve) => (readyResolve = resolve));
      postToWorker({ kind: 'init', config, world: worldInit(world) });
      if (clockSettings) postToWorker({ kind: 'settings', ...clockSettings });
      return p;
    },
    load(blob: ArrayBuffer, world: WorldData): Promise<void> {
      this.stop();
      view.reset();
      view.world = world;
      session++;
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'front-ultra-sim' });
      const mySession = session;
      worker.onmessage = (ev: MessageEvent<FromWorker>) => onWorkerMessage(ev.data, mySession);
      worker.onerror = (ev) => console.error('[sim] worker error', ev.message);
      const p = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        loadWaiter = { resolve, reject };
      });
      worker.postMessage({ kind: 'load', blob, world: worldInit(world) } satisfies ToWorker, [blob]);
      if (clockSettings) postToWorker({ kind: 'settings', ...clockSettings });
      return p;
    },
    save(): Promise<{ blob: ArrayBuffer; tick: number }> {
      const requestId = saveSeq++;
      return new Promise((resolve, reject) => {
        if (!worker) {
          reject(new Error('no game running'));
          return;
        }
        saveWaiters.set(requestId, resolve);
        postToWorker({ kind: 'save', requestId });
      });
    },
    setClock(mode, rate, focus, throttled) {
      postToWorker({ kind: 'clock', mode, rate, focus, throttled });
    },
    setClockSettings(crisisTime, observationTime) {
      clockSettings = { crisisTime, observationTime };
      postToWorker({ kind: 'settings', crisisTime, observationTime });
    },
    send(cmd: PlayerCommand): void {
      postToWorker({ kind: 'command', playerId: HUMAN_ID, cmd });
    },
    debug(action) {
      postToWorker({ kind: 'debug', action });
    },
    setSpeed(speed: GameSpeed): void {
      view.speed = speed;
      pendingSpeed = speed;
      pendingSpeedAt = performance.now();
      postToWorker({ kind: 'speed', speed });
      bus.emit('speedChanged', { speed });
    },
    fastForward(ticks: number, onProgress?: ProgressFn): Promise<void> {
      const requestId = ffSeq++;
      return new Promise<void>((resolve) => {
        if (!worker) {
          resolve();
          return;
        }
        ffWaiters.set(requestId, { resolve, progress: onProgress });
        postToWorker({ kind: 'fastForward', ticks, requestId });
      });
    },
    pump(now: number): void {
      while (queue.length) {
        const { msg, at } = queue.shift()!;
        switch (msg.kind) {
          case 'update':
            // Segments start when the update arrived, so motion depends on wall time only (not on frame timing).
            apply(msg.u, Math.min(now, at));
            if (readyResolve) {
              readyResolve();
              readyResolve = null;
            }
            break;
          case 'fastForwardProgress':
            ffWaiters.get(msg.requestId)?.progress?.(msg.done / msg.total);
            break;
          case 'fastForwardDone': {
            const w = ffWaiters.get(msg.requestId);
            ffWaiters.delete(msg.requestId);
            w?.resolve();
            break;
          }
          case 'error':
            console.error('[sim] worker error:', msg.message, msg.stack ?? '');
            break;
          case 'saved': {
            const w = saveWaiters.get(msg.requestId);
            saveWaiters.delete(msg.requestId);
            w?.({ blob: msg.blob, tick: msg.tick });
            break;
          }
          case 'loadFailed':
            loadWaiter?.reject(new Error(msg.message));
            loadWaiter = null;
            readyResolve = null;
            break;
          case 'ready':
            break;
        }
      }
      view.alpha = view.phase !== 'playing' ? 1 : segmentAlpha(now);
      const t = view.phase !== 'playing' ? view.tick : segStartTick + (view.tick - segStartTick) * view.alpha;
      // Presentation seconds = game hours = ticks / 10 (1 per real second at 1x, §2.5).
      view.simTime = t / 10;
      view.gameHours = t / 10;
    },
    stop(): void {
      if (worker) {
        postToWorker({ kind: 'stop' });
        worker.terminate();
        worker = null;
      }
      session++;
      queue.length = 0;
      for (const w of ffWaiters.values()) w.resolve();
      ffWaiters.clear();
      readyResolve = null;
      unitSeen.clear();
      view.reset();
    },
  };
  return api;
}
