// FRONT ULTRA — sim Web Worker entry (owner: sim-core).
// Loop: every UPDATE_INTERVAL_MS of wall time run `speed` ticks (1 during the spawn phase) and post ONE coalesced
// TickUpdate with transferable typed arrays. While paused, human commands are still applied (plan on a frozen
// world) and an update is posted whenever something changed, else every ~500 ms.
// fastForward runs ticks synchronously, streaming 50-tick updates (visual events filtered out) so the client's
// history and timelapse stay complete, then posts a full resync.

/// <reference lib="webworker" />
import { UPDATE_INTERVAL_MS } from '../shared/constants';
import { tickUpdateTransferables, type FromWorker, type ToWorker } from '../shared/protocol';
import { FF_EVENT_TYPES, Game } from './game';

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
  post({ kind: 'update', u }, tickUpdateTransferables(u));
}

function runTicks(n: number): number {
  const g = game!;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    try {
      g.tick1();
    } catch (err) {
      const e = err as Error;
      postError(`tick ${g.tick} failed: ${e?.message ?? String(err)}`, e?.stack);
    }
  }
  return performance.now() - t0;
}

function loop(): void {
  if (!game) return;
  const g = game;
  const n = g.phase === 'spawn' ? (g.speed === 0 ? 0 : 1) : g.phase === 'playing' && !held ? g.speed : 0;
  let ms = 0;
  if (n === 0) {
    const before = g.pendingEventCount;
    try {
      g.flushHumanCommands();
    } catch (err) {
      postError(String(err));
    }
    if (g.pendingEventCount !== before) forcePost = true;
  } else ms = runTicks(n);
  if (n === 0 && !forcePost && ++idleCounter % 5 !== 0) return;
  forcePost = false;
  postUpdate(n, ms);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case 'init': {
        if (timer) clearInterval(timer);
        game = new Game(msg.config, msg.world);
        game.onError = postError;
        held = msg.config.instantStart && msg.config.autoSpawnTile >= 0;
        post({ kind: 'ready' });
        postUpdate(0, 0, true);
        timer = setInterval(loop, UPDATE_INTERVAL_MS);
        break;
      }
      case 'command':
        game?.queueHuman(msg.cmd);
        break;
      case 'debug':
        if (game) {
          game.applyDebug(msg.action);
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
      case 'fastForward': {
        if (!game) break;
        const g = game;
        const total = Math.max(0, Math.floor(msg.ticks));
        const keep = (e: { type: string }) => FF_EVENT_TYPES.has(e.type as never);
        let chunk = 0, chunkMs = 0;
        for (let i = 0; i < total; i++) {
          if (g.phase === 'ended') break;
          chunkMs += runTicks(1);
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
