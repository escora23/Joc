// FRONT ULTRA — command mode: terrain chunk worker (DESIGN_V2 §9.4, §14.9; owner: W5-command-v2).
// Builds streamed heightfield chunks off the main thread (a 137² chunk costs 8–25 ms of JS, more than the 6 ms frame
// budget). It receives the world fields the local heightfield reads once per session, then answers chunk requests
// with transferable arrays.

/// <reference lib="webworker" />
import { buildLocalHeightfield } from '../../data/heightfield';
import type { LocalHeightfieldOptions, WorldAux } from '../../data/types';
import type { WorldData } from '../../shared/types';
import { buildChunkMesh, type ChunkMesh } from './mesh';

declare const self: DedicatedWorkerGlobalScope;

let world: WorldData | null = null;
let aux: WorldAux | null = null;

export interface ChunkRequest {
  type: 'chunk';
  id: number;
  lat: number;
  lon: number;
  sizeKm: number;
  res: number;
  opts: LocalHeightfieldOptions;
  /** Also build the render mesh arrays for the inner grid (res − 2·pad samples of `size` m) with a skirt. */
  mesh?: { pad: number; size: number; skirt: number };
}

export interface ChunkReply {
  type: 'chunk';
  id: number;
  ms: number;
  heights: Float32Array;
  water: Uint8Array;
  splatA: Uint8Array;
  splatB: Uint8Array;
  tint: Uint8Array;
  minHeight: number;
  maxHeight: number;
  mesh?: ChunkMesh;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { type: string } & Record<string, unknown>;
  if (m.type === 'init') {
    world = m.world as WorldData;
    aux = m.aux as WorldAux;
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'chunk' && world) {
    const r = m as unknown as ChunkRequest;
    const t0 = performance.now();
    try {
      const hf = buildLocalHeightfield(world, aux, r.lat, r.lon, r.sizeKm, r.res, r.opts);
      const mesh = r.mesh ? buildChunkMesh(hf, r.res, r.mesh.pad, r.mesh.size, r.mesh.skirt) : undefined;
      const reply: ChunkReply = {
        type: 'chunk', id: r.id, ms: performance.now() - t0, heights: hf.heights, water: hf.water, splatA: hf.splatA,
        splatB: hf.splatB, tint: hf.tint, minHeight: hf.minHeight, maxHeight: hf.maxHeight, mesh,
      };
      const tr: Transferable[] = [reply.heights.buffer, reply.water.buffer, reply.splatA.buffer, reply.splatB.buffer, reply.tint.buffer];
      if (mesh) tr.push(mesh.position.buffer, mesh.normal.buffer, mesh.splatA.buffer, mesh.splatB.buffer, mesh.tint.buffer);
      self.postMessage(reply, tr);
    } catch (err) {
      self.postMessage({ type: 'error', id: r.id, message: String(err) });
    }
  }
};
