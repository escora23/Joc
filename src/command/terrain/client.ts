// FRONT ULTRA — command mode: terrain chunk requests (owner: W5-command-v2).
// Two workers build heightfield chunks for the streamer (§9.4: chunks over the 6 ms frame budget move off the main
// thread). The world fields they need are posted once per page load. Requests are prioritised by the streamer (it
// only keeps a few in flight). Without Worker support the chunks are built on the main thread, one per call.

import { buildLocalHeightfield, getLoadedWorld, getWorldAux } from '../../data';
import type { LocalHeightfieldOptions } from '../../data/types';
import type { ChunkReply } from './worker';

export interface ChunkData {
  heights: Float32Array;
  water: Uint8Array;
  splatA: Uint8Array;
  splatB: Uint8Array;
  tint: Uint8Array;
  minHeight: number;
  maxHeight: number;
  /** Worker build time (ms), or main-thread build time without workers. */
  ms: number;
  mainThread: boolean;
}

type Pending = { resolve: (d: ChunkData | null) => void };

export class TerrainClient {
  private workers: Worker[] = [];
  private readyWorkers = 0;
  private inFlight = new Map<number, Pending>();
  private load: number[] = [];
  private nextId = 1;
  private failed = false;
  /** Worker ms of the last chunks (stats). */
  lastMs = 0;

  constructor(private readonly count = 2) {}

  /** Start the workers (idempotent): the world fields are copied to each once. */
  start(): void {
    if (this.workers.length || this.failed) return;
    const world = getLoadedWorld();
    const aux = getWorldAux(world);
    if (!world || typeof Worker === 'undefined') {
      this.failed = true;
      return;
    }
    const w0 = { relief: world.relief, terrain: world.terrain, width: world.width, height: world.height };
    const a0 = aux ? { day: aux.day, lights: aux.lights, waterFrac: aux.waterFrac, biome: aux.biome } : null;
    try {
      for (let i = 0; i < this.count; i++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `cmd-terrain-${i}` });
        w.onmessage = (ev) => this.onMessage(i, ev.data as ChunkReply | { type: 'ready' } | { type: 'error'; id: number; message: string });
        w.onerror = (e) => {
          console.warn('[command] terrain worker failed; building chunks on the main thread', e.message);
          this.failed = true;
          for (const p of this.inFlight.values()) p.resolve(null);
          this.inFlight.clear();
        };
        w.postMessage({ type: 'init', world: w0, aux: a0 });
        this.workers.push(w);
        this.load.push(0);
      }
    } catch (err) {
      console.warn('[command] no terrain workers', err);
      this.failed = true;
    }
  }

  get usingWorkers(): boolean {
    return !this.failed && this.workers.length > 0;
  }

  get pending(): number {
    return this.inFlight.size;
  }

  private onMessage(wi: number, m: ChunkReply | { type: 'ready' } | { type: 'error'; id: number; message: string }): void {
    if (m.type === 'ready') {
      this.readyWorkers++;
      return;
    }
    const p = this.inFlight.get(m.id);
    this.load[wi] = Math.max(0, this.load[wi] - 1);
    if (!p) return;
    this.inFlight.delete(m.id);
    if (m.type === 'error') {
      console.warn('[command] chunk failed', m.message);
      p.resolve(null);
      return;
    }
    this.lastMs = m.ms;
    p.resolve({
      heights: m.heights, water: m.water, splatA: m.splatA, splatB: m.splatB, tint: m.tint, minHeight: m.minHeight,
      maxHeight: m.maxHeight, ms: m.ms, mainThread: false,
    });
  }

  request(lat: number, lon: number, sizeKm: number, res: number, opts: LocalHeightfieldOptions): Promise<ChunkData | null> {
    if (!this.usingWorkers) {
      const t0 = performance.now();
      const hf = buildLocalHeightfield(getLoadedWorld()!, getWorldAux(), lat, lon, sizeKm, res, opts);
      return Promise.resolve({
        heights: hf.heights, water: hf.water, splatA: hf.splatA, splatB: hf.splatB, tint: hf.tint, minHeight: hf.minHeight,
        maxHeight: hf.maxHeight, ms: performance.now() - t0, mainThread: true,
      });
    }
    const id = this.nextId++;
    let wi = 0;
    for (let i = 1; i < this.load.length; i++) if (this.load[i] < this.load[wi]) wi = i;
    this.load[wi]++;
    return new Promise((resolve) => {
      this.inFlight.set(id, { resolve });
      this.workers[wi].postMessage({ type: 'chunk', id, lat, lon, sizeKm, res, opts });
    });
  }

  /** Drop the answers of requests still in flight (session end). */
  cancelAll(): void {
    for (const p of this.inFlight.values()) p.resolve(null);
    this.inFlight.clear();
    this.load.fill(0);
  }
}
