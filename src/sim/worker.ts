// FRONT ULTRA — sim Web Worker entry (owner: sim-core).
// Loop: every UPDATE_INTERVAL_MS of wall time, run `speed` ticks and post ONE coalesced TickUpdate.
// While paused an update (0 ticks) is still posted every 500 ms so the client keeps receiving events.

/// <reference lib="webworker" />
import { UPDATE_INTERVAL_MS } from '../shared/constants';
import { tickUpdateTransferables, type FromWorker, type ToWorker } from '../shared/protocol';
import { Game } from './game';

declare const self: DedicatedWorkerGlobalScope;

let game: Game | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let idleCounter = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function postUpdate(ticks: number, full = false): void {
  if (!game) return;
  const t0 = performance.now();
  const u = game.buildUpdate(ticks, full);
  u.tickMs = performance.now() - t0;
  post({ kind: 'update', u }, tickUpdateTransferables(u));
}

function loop(): void {
  if (!game) return;
  const t0 = performance.now();
  const n = game.phase === 'spawn' ? 1 : game.speed;
  for (let i = 0; i < n; i++) game.tick1();
  if (n === 0 && ++idleCounter % 5 !== 0) return;
  const u = game.buildUpdate(n);
  u.tickMs = performance.now() - t0;
  post({ kind: 'update', u }, tickUpdateTransferables(u));
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case 'init':
        game = new Game(msg.config, msg.world);
        post({ kind: 'ready' });
        postUpdate(0, true);
        if (timer) clearInterval(timer);
        timer = setInterval(loop, UPDATE_INTERVAL_MS);
        break;
      case 'command':
        game?.queueHuman(msg.cmd);
        break;
      case 'debug':
        game?.applyDebug(msg.action);
        break;
      case 'speed':
        if (game) game.speed = msg.speed;
        break;
      case 'fastForward': {
        if (!game) break;
        const total = msg.ticks;
        for (let i = 0; i < total; i++) {
          game.tick1();
          if (i % 250 === 249) post({ kind: 'fastForwardProgress', requestId: msg.requestId, done: i + 1, total });
        }
        game.requestFull();
        postUpdate(total, true);
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
    post({ kind: 'error', message: e.message ?? String(err), stack: e.stack });
  }
};
