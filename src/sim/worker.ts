// FRONT ULTRA — sim Web Worker entry (owner: sim-core).
//
// v2 clock (DESIGN_V2 §2.2): the world advances by accumulating fractional ticks. Every loop (~100 ms of wall time)
// the worker adds `rate × elapsed / 360` ticks, where `rate` is game seconds per real second, and runs the whole
// ticks accumulated. The rate comes from the clock mode:
//   * strategic    3,600 × speed (0.5x .. 4x): 1 real second = speed game hours;
//   * crisis       60, whatever the speed, while a nuclear weapon flies (decided HERE from the units in flight and
//                  the player's `crisisTime` setting); holds 2 real s after the last one lands, then ramps back 1.5 s;
//   * observation  60 while the camera is below ~70 km (requested by the main thread with a `clock` message);
//   * tactical / travel: command mode (rate given by the main thread; crisis never engages there).
// One coalesced TickUpdate is posted per loop that ran ticks (and every ~500 ms while idle), always carrying the clock.
// While paused, human commands are still applied (plan on a frozen world).
// fastForward runs ticks synchronously, streaming 50-tick updates (visual events filtered out) so the client's
// history and timelapse stay complete, then posts a full resync.

/// <reference lib="webworker" />
import {
  CRISIS_HOLD_SEC, CRISIS_RAMP_SEC, CRISIS_RATE, GAME_SECONDS_PER_TICK, HUMAN_ID, OBSERVATION_RAMP_SEC, OBSERVATION_RATE,
  STRATEGIC_RATE, UPDATE_INTERVAL_MS,
} from '../shared/constants';
import { tickUpdateTransferables, type FromWorker, type ToWorker } from '../shared/protocol';
import { UnitType, type ClockMode, type ClockView } from '../shared/types';
import { FF_EVENT_TYPES, Game } from './game';
import { SaveReader, SaveWriter } from './save';

declare const self: DedicatedWorkerGlobalScope;

let game: Game | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let idleCounter = 0;
let forcePost = false;
let errorsPosted = 0;
/**
 * Scripted sessions (shots, playtests: auto-spawned human + instant start) hold the clock once the playing phase
 * begins, until the client sends a speed or fastForward message. Staging actions (conquer, spawnStructure...) then
 * land on a deterministic tick, so the same seed always stages the same world regardless of wall-clock timing.
 */
let held = false;

// --- clock state -------------------------------------------------------------------------------------
const settings = { crisisTime: 'always' as 'always' | 'mine' | 'off', observationTime: true };
const request: { mode: 'strategic' | 'observation' | 'tactical' | 'travel'; rate: number; throttled: boolean } = {
  mode: 'strategic', rate: 0, throttled: false,
};
let accTicks = 0;
let lastLoopMs = 0;
/** Wall ms until which crisis time holds (refreshed while a relevant nuclear weapon flies). */
let crisisHoldUntil = -1;
/**
 * 0..1 blend toward the slow clock (crisis: instant in, ramped out; observation: ramped both ways). The ramps follow
 * wall time (not loop counts), so a starved worker still meets the 0.5 s / 1.5 s ramp times.
 */
let crisisLevel = 0;
let obsLevel = 0;
let obsFrom = 0;
let obsTarget = 0;
let obsChangedAt = -1;
let clock: ClockView = { mode: 'strategic', rate: STRATEGIC_RATE, tickPeriodMs: 100, speed: 1 };
let lastReportedMode: ClockMode = 'strategic';

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function postError(message: string, stack?: string): void {
  if (errorsPosted++ > 40) return;
  post({ kind: 'error', message, stack });
}

function postUpdate(ticks: number, tickMs: number, full = false): void {
  if (!game) return;
  const u = game.buildUpdate(ticks, full);
  u.tickMs = tickMs;
  u.clock = { ...clock, wallMs: Date.now() };
  post({ kind: 'update', u }, tickUpdateTransferables(u));
}

/** A nuclear weapon in flight that engages crisis time under the current `crisisTime` setting (§8.5). */
function crisisRelevantNukeInFlight(g: Game): boolean {
  if (settings.crisisTime === 'off') return false;
  const human = g.playerById[HUMAN_ID];
  for (const u of g.unitMap.values()) {
    if (u.dead) continue;
    if (u.type !== UnitType.AtomBomb && u.type !== UnitType.HydrogenBomb && u.type !== UnitType.Mirv && u.type !== UnitType.MirvWarhead) continue;
    if (settings.crisisTime === 'always') return true;
    // 'mine': the target tile is ours or an ally's, or we launched it.
    if (u.owner === HUMAN_ID) return true;
    const target = u.targetTile >= 0 ? g.owner[u.targetTile] : u.targetPlayer;
    if (target === HUMAN_ID || (target > 0 && human?.allies.has(target))) return true;
  }
  return false;
}

/** Recompute the clock for this loop (dtSec = wall seconds since the previous loop). */
function updateClock(g: Game, nowMs: number, dtSec: number): void {
  const speed = g.speed;
  const commandMode = request.mode === 'tactical' || request.mode === 'travel';
  // Crisis: decided here, never in command mode (tactical time is already slower).
  if (!commandMode && g.phase === 'playing' && crisisRelevantNukeInFlight(g)) {
    // Entering crisis: drop the fraction of a strategic tick already accumulated, so the flight's first tick lasts
    // a full crisis tick (6 real s) whatever the speed was.
    if (nowMs >= crisisHoldUntil) accTicks = 0;
    crisisHoldUntil = nowMs + CRISIS_HOLD_SEC * 1000;
    crisisLevel = 1;
  } else if (nowMs >= crisisHoldUntil) {
    crisisLevel = crisisHoldUntil < 0 ? 0 : Math.max(0, 1 - (nowMs - crisisHoldUntil) / (CRISIS_RAMP_SEC * 1000));
  }
  if (commandMode) {
    crisisLevel = 0;
    crisisHoldUntil = -1;
  }
  const target = request.mode === 'observation' && settings.observationTime ? 1 : 0;
  if (target !== obsTarget) {
    obsFrom = obsLevel;
    obsTarget = target;
    obsChangedAt = nowMs;
  }
  const f = obsChangedAt < 0 ? 1 : Math.min(1, (nowMs - obsChangedAt) / (OBSERVATION_RAMP_SEC * 1000));
  obsLevel = obsFrom + (obsTarget - obsFrom) * f;
  void dtSec;

  let mode: ClockMode;
  let rate: number;
  if (commandMode) {
    mode = request.mode;
    rate = Math.max(0, request.rate);
  } else {
    const strategic = STRATEGIC_RATE * speed;
    const slowRate = Math.min(CRISIS_RATE, OBSERVATION_RATE);
    const slow = Math.max(crisisLevel, obsLevel);
    // Geometric blend: the ramp feels even from 14,400 down to 60 game s per real s.
    rate = strategic > 0 ? Math.exp(Math.log(strategic) + (Math.log(Math.min(strategic, slowRate)) - Math.log(strategic)) * slow) : 0;
    mode = nowMs < crisisHoldUntil ? 'crisis' : obsTarget ? 'observation' : 'strategic';
  }
  if (speed === 0 && !commandMode) rate = 0;
  if (g.phase !== 'playing') {
    mode = 'strategic';
    rate = speed === 0 ? 0 : STRATEGIC_RATE;
  }
  clock = {
    mode, rate, speed,
    tickPeriodMs: rate > 0 ? (GAME_SECONDS_PER_TICK * 1000) / rate : 0,
    ...(commandMode && request.throttled ? { throttled: true } : {}),
  };
  if (mode !== lastReportedMode) {
    lastReportedMode = mode;
    g.pushClientEvent({ type: 'clockChanged', tick: g.tick, mode, rate });
    forcePost = true;
  }
}

function runTick(g: Game): number {
  const t0 = performance.now();
  try {
    g.tick1();
  } catch (err) {
    const e = err as Error;
    postError(`tick ${g.tick} failed: ${e?.message ?? String(err)}`, e?.stack);
  }
  return performance.now() - t0;
}

function loop(): void {
  if (!game) return;
  const g = game;
  const now = performance.now();
  // Real elapsed time (clamped: a stalled tab must not dump minutes of game time at once).
  const dtSec = lastLoopMs > 0 ? Math.min(0.25, Math.max(0, (now - lastLoopMs) / 1000)) : UPDATE_INTERVAL_MS / 1000;
  lastLoopMs = now;
  updateClock(g, now, dtSec);
  let n = 0;
  let ms = 0;
  if (g.phase === 'spawn') {
    // The spawn phase runs at a fixed 10 ticks per second (nothing moves; it waits for the human).
    if (g.speed !== 0) {
      ms += runTick(g);
      n = 1;
    }
  } else if (g.phase === 'playing' && !held && clock.rate > 0) {
    accTicks += (clock.rate * dtSec) / GAME_SECONDS_PER_TICK;
    // Command mode: the controlled unit and its surroundings advance between ticks (W5 registers the systems).
    if (clock.mode === 'tactical' || clock.mode === 'travel') g.subStep(clock.rate * dtSec);
    const whole = Math.min(16, Math.floor(accTicks));
    accTicks -= whole;
    if (accTicks > 1) accTicks = 1;
    for (let i = 0; i < whole; i++) {
      ms += runTick(g);
      n++;
      if (g.phase !== 'playing') break;
      // Crisis starts on the launch tick: stop here so the flight itself runs on the crisis clock.
      if (clock.mode !== 'tactical' && clock.mode !== 'travel' && clock.mode !== 'crisis' && crisisRelevantNukeInFlight(g)) {
        updateClock(g, performance.now(), 0);
        accTicks = 0;
        break;
      }
    }
  }
  if (n === 0) {
    const before = g.pendingEventCount;
    try {
      g.flushHumanCommandsBetweenTicks();
    } catch (err) {
      postError(String(err));
    }
    if (g.pendingEventCount !== before) forcePost = true;
    if (!forcePost && ++idleCounter % 5 !== 0) return;
  }
  forcePost = false;
  postUpdate(n, ms);
}

function startLoop(): void {
  if (timer) clearInterval(timer);
  accTicks = 0;
  lastLoopMs = 0;
  crisisHoldUntil = -1;
  crisisLevel = 0;
  obsLevel = 0;
  obsFrom = 0;
  obsTarget = 0;
  obsChangedAt = -1;
  lastReportedMode = 'strategic';
  timer = setInterval(loop, UPDATE_INTERVAL_MS);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case 'init': {
        game = new Game(msg.config, msg.world);
        game.onError = postError;
        held = msg.config.instantStart && msg.config.autoSpawnTile >= 0;
        clock = { mode: 'strategic', rate: STRATEGIC_RATE * game.speed, tickPeriodMs: game.speed > 0 ? 100 / game.speed : 0, speed: game.speed };
        post({ kind: 'ready' });
        postUpdate(0, 0, true);
        startLoop();
        break;
      }
      case 'load': {
        try {
          const g = Game.restore(new SaveReader(msg.blob), msg.world);
          game = g;
          g.onError = postError;
          held = false;
          clock = { mode: 'strategic', rate: 0, tickPeriodMs: 0, speed: g.speed };
          post({ kind: 'ready' });
          g.requestFull();
          postUpdate(0, 0, true);
          startLoop();
        } catch (err) {
          const e = err as Error;
          post({ kind: 'loadFailed', message: e?.message ?? String(err) });
        }
        break;
      }
      case 'save': {
        if (!game) break;
        const w = new SaveWriter();
        game.serialize(w);
        const blob = w.finish();
        post({ kind: 'saved', requestId: msg.requestId, blob, tick: game.tick }, [blob]);
        break;
      }
      case 'command':
        game?.queueHuman(msg.cmd);
        break;
      case 'debug':
        if (game) {
          game.applyDebugBetweenTicks(msg.action);
          forcePost = true;
        }
        break;
      case 'speed':
        held = false;
        if (game) {
          game.speed = msg.speed;
          forcePost = true;
        }
        break;
      case 'clock':
        request.mode = msg.mode;
        request.rate = msg.rate ?? 0;
        request.throttled = !!msg.throttled;
        if (game) game.observationFocus = msg.focus ? { x: msg.focus.x, y: msg.focus.y } : null;
        forcePost = true;
        break;
      case 'settings':
        settings.crisisTime = msg.crisisTime;
        settings.observationTime = msg.observationTime;
        console.info(`[sim] settings: crisisTime=${msg.crisisTime} observationTime=${msg.observationTime}`);
        forcePost = true;
        break;
      case 'fastForward': {
        if (!game) break;
        const g = game;
        const total = Math.max(0, Math.floor(msg.ticks));
        const keep = (e: { type: string }) => FF_EVENT_TYPES.has(e.type as never);
        let chunk = 0, chunkMs = 0;
        for (let i = 0; i < total; i++) {
          if (g.phase === 'ended') break;
          chunkMs += runTick(g);
          chunk++;
          if (chunk >= 50) {
            g.filterEvents(keep);
            postUpdate(chunk, chunkMs);
            chunk = 0;
            chunkMs = 0;
            post({ kind: 'fastForwardProgress', requestId: msg.requestId, done: i + 1, total });
          }
        }
        g.filterEvents(keep);
        g.requestFull();
        postUpdate(chunk, chunkMs, true);
        post({ kind: 'fastForwardDone', requestId: msg.requestId });
        break;
      }
      case 'stop':
        if (timer) clearInterval(timer);
        timer = null;
        game = null;
        self.close();
        break;
    }
  } catch (err) {
    const e = err as Error;
    postError(e?.message ?? String(err), e?.stack);
  }
};
