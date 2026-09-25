// FRONT ULTRA — main-thread sim client & GameView (owner: sim-core).
// Owns the worker, buffers its messages and applies them in pump() at the start of each frame, so every
// subsystem sees one consistent state per frame. Re-emits sim events on the bus, raises nuke alarms for the
// human, and records the stats history (every 5 s of game time) and the timelapse (400x200 RLE frames every 10 s).

import { HUMAN_ID, MAP_H, MAP_W, STRUCTURE_DEFS, TICK_MS, TILE_COUNT, UNIT_DEFS, UPDATE_INTERVAL_MS, structureCost } from '../shared/constants';
import { playerName, t } from '../shared/i18n';
import type { GameBus } from '../shared/events';
import type { GameView, ProgressFn, SimClientApi } from '../shared/api';
import {
  PF, PLAYER_STRIDE, UF, UNIT_STRIDE, unpackOwner, unpackTile,
  type FromWorker, type PlayerCommand, type SimEvent, type TickUpdate, type ToWorker,
} from '../shared/protocol';
import { clamp01 } from '../shared/math';
import {
  UnitType, emptyStats, type AllianceRequestView, type AllianceView, type AttackView, type FrontView, type GameConfig,
  type GamePhase, type GameSpeed, type PlayerView, type ScarView, type StatsSample, type StructureType,
  type StructureView, type Timelapse, type UnitState, type UnitView, type WorldData, type WorldEventView,
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
    let n = 0;
    for (const u of this.units.values()) if (u.owner === HUMAN_ID && u.type === type && u.state !== 6) n++;
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
  }
}

export function createSimClient(bus: GameBus): SimClientApi {
  registerSimStrings();
  const view = new ClientView();
  let worker: Worker | null = null;
  const queue: FromWorker[] = [];
  let lastUpdateAt = 0;
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
    view.prevTick = view.tick;
    view.tick = u.tick;
    if (pendingSpeed === null || u.speed === pendingSpeed || now - pendingSpeedAt > 2000) {
      view.speed = u.speed;
      pendingSpeed = null;
    }
    view.phase = u.phase;
    view.tickMs = u.tickMs ?? 0;
    lastUpdateAt = now;

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
        };
        view.units.set(id, un);
      } else {
        un.prevX = un.x;
        un.prevY = un.y;
        un.prevHeading = un.heading;
        un.prevAlt = un.alt;
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
      }
    }
    for (const id of view.units.keys()) {
      if (unitSeen.get(id) !== gen) {
        view.units.delete(id);
        unitSeen.delete(id);
      }
    }

    if (u.structures) {
      view.structures.clear();
      for (const s of u.structures) view.structures.set(s.id, s);
    }
    if (u.attacks) view.attacks = u.attacks;
    if (u.fronts) view.fronts = u.fronts;
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
      if (d) p.structureName = t(`structure.${d.id}`);
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
        bus.emit('nukeAlarm', { unitId: e.unitId, targetTile: e.targetTile, etaSec: (e.flightTicks * TICK_MS) / 1000, weapon: e.weapon });
      }
    }
  }

  return {
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
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        if (mySession === session) queue.push(ev.data);
      };
      worker.onerror = (ev) => console.error('[sim] worker error', ev.message);
      const p = new Promise<void>((resolve) => (readyResolve = resolve));
      postToWorker({ kind: 'init', config, world: worldInit(world) });
      return p;
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
        const msg = queue.shift()!;
        switch (msg.kind) {
          case 'update':
            apply(msg.u, now);
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
          case 'ready':
            break;
        }
      }
      view.alpha = view.speed === 0 || view.phase !== 'playing' ? 1 : clamp01((now - lastUpdateAt) / UPDATE_INTERVAL_MS);
      const t = view.prevTick + (view.tick - view.prevTick) * view.alpha;
      view.simTime = (t * TICK_MS) / 1000;
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
}
