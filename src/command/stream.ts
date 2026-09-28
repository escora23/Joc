// FRONT ULTRA — command mode: streamed terrain from the real heightfield (DESIGN_V2 §9.4; owner: W5-command-v2).
//
// The ground is a set of square chunks on a fixed grid of the session's map frame (frame.ts), in three levels:
//   near     2 km chunks (tank) at 129² samples, 5 × 5 around the vehicle, prefetched two chunks ahead;
//   mid      8 km chunks at 65², out to ~24 km;
//   horizon  one 120 km patch at 129², rebuilt every 15 km.
// (jet: 8 / 32 / 400 km; ship: 4 / 16 / 200 km.) Each chunk comes from the data layer's local heightfield — the real
// NASA relief plus the deterministic detail — built in a worker (terrain/worker.ts) with a 4-cell border, so that
// neighbours meet exactly on their shared edge (same projection via `refLat`, same noise lattice, per-sample
// ruggedness) and normals are continuous across it. Every chunk carries a skirt hanging below its edges, and a coarser
// level is discarded in the shader wherever the finer level is built (a mask texture of ready cells), so levels never
// overlap and never leave a hole: where a near chunk is still missing, the mid chunk shows.
//
// Main-thread work (turning worker data into meshes, masks, water depth) runs under a 6 ms budget per frame; the time
// actually spent is published as __cmdStats.chunkMsPerFrame. Travel compression is throttled by stream readiness:
// `readyAheadM()` and `missingAround()` tell the command mode how far it may go before an unbuilt chunk.

import * as THREE from 'three';
import type { CommandKind } from '../shared/types';
import { createTerrainMaterial } from './env/ground';
import type { LocalFrame } from './frame';
import { TerrainClient, type ChunkData } from './terrain/client';

/** Samples of border around every chunk: keeps the 4× noise lattice aligned between neighbours (see file header). */
const PAD = 4;
/** Main-thread budget per frame (ms). */
export const FRAME_BUDGET_MS = 6;

interface LodSpec {
  /** Chunk size (m). */
  size: number;
  /** Samples per edge (inner grid, (res − 1) % 4 == 0). */
  res: number;
  /** Chunks kept in view around the vehicle: a (2r + 1)² square. */
  r: number;
  /** Skirt depth (m). */
  skirt: number;
}

interface StreamSpec {
  near: LodSpec;
  mid: LodSpec;
  /** Horizon patch size (m), samples, rebuild distance (m). */
  horizon: { size: number; res: number; rebuild: number };
  /** Water depth maps: near and far extents (m). */
  depthNear: number;
  depthFar: number;
}

export function streamSpec(kind: CommandKind, detail: number): StreamSpec {
  const nres = detail >= 0.8 ? 129 : detail >= 0.45 ? 97 : 65;
  if (kind === 'jet') {
    return {
      near: { size: 8000, res: nres, r: 2, skirt: 260 }, mid: { size: 32000, res: 65, r: 3, skirt: 900 },
      horizon: { size: 400_000, res: 129, rebuild: 60_000 }, depthNear: 48_000, depthFar: 240_000,
    };
  }
  if (kind === 'ship') {
    return {
      near: { size: 4000, res: detail >= 0.45 ? 97 : 65, r: 2, skirt: 120 }, mid: { size: 16000, res: 65, r: 3, skirt: 500 },
      horizon: { size: 200_000, res: 129, rebuild: 30_000 }, depthNear: 24_000, depthFar: 120_000,
    };
  }
  return {
    near: { size: 2000, res: nres, r: 2, skirt: 60 }, mid: { size: 8000, res: 65, r: 3, skirt: 260 },
    horizon: { size: 120_000, res: 129, rebuild: 15_000 }, depthNear: 12_000, depthFar: 60_000,
  };
}

type ChunkState = 'queued' | 'loading' | 'data' | 'built';

interface Chunk {
  lod: 0 | 1;
  ix: number;
  iz: number;
  state: ChunkState;
  data: ChunkData | null;
  mesh: THREE.Mesh | null;
  /** Padded heights (res + 2·PAD)². */
  h: Float32Array | null;
  minH: number;
  maxH: number;
  /** Generation (requests of an old session are dropped). */
  gen: number;
}

interface Horizon {
  cx: number;
  cz: number;
  mesh: THREE.Mesh | null;
  h: Float32Array | null;
  data: ChunkData | null;
  loading: boolean;
  gen: number;
  size: number;
  res: number;
}

const MASK_N = 32;

export interface SurfaceSample {
  /** 8 splat weights 0..1: sand, grass, forest, rock, snow, urban, dirt, wet. */
  splat: Float32Array;
  /** Regional tint (sRGB 0..1). */
  tint: [number, number, number];
}

export class Ground {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly midMaterial: THREE.MeshStandardMaterial;
  private readonly horMaterial: THREE.MeshStandardMaterial;
  private readonly client = new TerrainClient(2);
  private frame: LocalFrame | null = null;
  private spec: StreamSpec = streamSpec('tank', 1);
  private gen = 0;
  private readonly chunks: [Map<string, Chunk>, Map<string, Chunk>] = [new Map(), new Map()];
  private readonly buildQueue: Chunk[] = [];
  private horizon: Horizon = { cx: 0, cz: 0, mesh: null, h: null, data: null, loading: false, gen: 0, size: 0, res: 0 };
  private readonly indexCache = new Map<number, THREE.BufferAttribute>();
  private refLat = 0;
  private active = false;
  // Masks: 1 where the finer level is built (near → discards mid; mid → discards horizon).
  private readonly masks: THREE.DataTexture[];
  private readonly maskOrigin = [new THREE.Vector2(), new THREE.Vector2()];
  private readonly maskCellOrigin = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  private maskDirty = [true, true];
  /** Water depth (0..40 m → 0..255) around the vehicle for the water shader: near and far maps. */
  depthNear: THREE.DataTexture;
  depthFar: THREE.DataTexture;
  readonly depthCenterNear = new THREE.Vector2();
  readonly depthCenterFar = new THREE.Vector2();
  private depthJob: { tex: 0 | 1; row: number; cx: number; cz: number; size: number; data: Uint8Array } | null = null;
  private depthAbs = [{ x: 1e12, z: 1e12 }, { x: 1e12, z: 1e12 }];
  private depthDirty = [true, true];
  private anyWater = false;
  // Stats
  readonly stats = {
    chunkMsPerFrame: 0, msHistory: [] as number[], built: 0, requested: 0, workerMs: 0, missingAhead: 0, mainThread: false,
    nearBuilt: 0, midBuilt: 0,
  };
  private vx = 0;
  private vz = 0;
  private dirX = 0;
  private dirZ = -1;

  constructor(noise: THREE.Texture) {
    this.group.name = 'cmd-ground';
    this.masks = [0, 1].map(() => {
      const t = new THREE.DataTexture(new Uint8Array(MASK_N * MASK_N), MASK_N, MASK_N, THREE.RedFormat, THREE.UnsignedByteType);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    });
    this.material = createTerrainMaterial(noise, null);
    this.midMaterial = createTerrainMaterial(noise, { tex: this.masks[0], origin: this.maskOrigin[0], cell: { value: 2000 }, n: MASK_N });
    this.horMaterial = createTerrainMaterial(noise, { tex: this.masks[1], origin: this.maskOrigin[1], cell: { value: 8000 }, n: MASK_N });
    this.depthNear = mkDepth(2);
    this.depthFar = mkDepth(2);
  }

  /** Placeholder mesh so the terrain programs compile during loading. */
  warmupMesh(): THREE.Mesh {
    const g = new THREE.PlaneGeometry(10, 10, 1, 1).rotateX(-Math.PI / 2);
    const n = g.attributes.position.count;
    g.setAttribute('splatA', new THREE.BufferAttribute(new Uint8Array(n * 4).fill(64), 4, true));
    g.setAttribute('splatB', new THREE.BufferAttribute(new Uint8Array(n * 4).fill(0), 4, true));
    g.setAttribute('tint', new THREE.BufferAttribute(new Uint8Array(n * 3).fill(128), 3, true));
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    const m2 = new THREE.Mesh(g, this.midMaterial);
    const m3 = new THREE.Mesh(g, this.horMaterial);
    m.add(m2, m3);
    return m;
  }

  get nearSize(): number {
    return this.spec.near.size;
  }

  /** Start a session around the vehicle (scene position x, z). */
  begin(frame: LocalFrame, kind: CommandKind, detail: number): void {
    this.clear();
    this.gen++;
    this.frame = frame;
    this.spec = streamSpec(kind, detail);
    this.refLat = frame.lat0;
    (this.midMaterial.userData.maskCell as { value: number }).value = this.spec.near.size;
    (this.horMaterial.userData.maskCell as { value: number }).value = this.spec.mid.size;
    this.client.start();
    this.stats.mainThread = !this.client.usingWorkers;
    this.active = true;
    this.maskDirty = [true, true];
    this.depthDirty = [true, true];
    this.depthAbs = [{ x: 1e12, z: 1e12 }, { x: 1e12, z: 1e12 }];
  }

  clear(): void {
    this.active = false;
    this.client.cancelAll();
    for (const m of this.chunks) {
      for (const c of m.values()) this.dispose(c);
      m.clear();
    }
    this.buildQueue.length = 0;
    if (this.horizon.mesh) {
      this.group.remove(this.horizon.mesh);
      this.horizon.mesh.geometry.dispose();
    }
    this.horizon = { cx: 0, cz: 0, mesh: null, h: null, data: null, loading: false, gen: 0, size: 0, res: 0 };
    for (const t of this.masks) {
      (t.image.data as Uint8Array).fill(0);
      t.needsUpdate = true;
    }
    this.stats.msHistory.length = 0;
    this.depthJob = null;
    this.anyWater = false;
  }

  private dispose(c: Chunk): void {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh = null;
    }
    c.h = null;
    c.data = null;
  }

  /** Floating origin moved: shift every mesh (the grid is anchored in absolute map meters). */
  rebase(dx: number, dz: number): void {
    for (const m of this.chunks) for (const c of m.values()) if (c.mesh) c.mesh.position.x -= dx, c.mesh.position.z -= dz;
    if (this.horizon.mesh) {
      this.horizon.mesh.position.x -= dx;
      this.horizon.mesh.position.z -= dz;
    }
    this.maskDirty = [true, true];
    this.depthCenterNear.x -= dx;
    this.depthCenterNear.y -= dz;
    this.depthCenterFar.x -= dx;
    this.depthCenterFar.y -= dz;
  }

  // ---------------------------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------------------------
  /**
   * Per frame: `x, z` = vehicle scene position, `vx, vz` = its velocity (m/s scene, for prefetch). Runs under the
   * frame budget; returns the main-thread ms spent.
   */
  update(x: number, z: number, vx: number, vz: number): number {
    if (!this.active || !this.frame) return 0;
    const t0 = performance.now();
    const f = this.frame;
    const ax = x + f.offX, az = z + f.offZ;
    const sp = Math.hypot(vx, vz);
    if (sp > 0.5) {
      this.dirX = vx / sp;
      this.dirZ = vz / sp;
    }
    this.vx = vx;
    this.vz = vz;
    // 1. Wanted cells per level, nearest (and ahead) first.
    for (const lod of [0, 1] as const) {
      const L = lod === 0 ? this.spec.near : this.spec.mid;
      const cx = Math.floor(ax / L.size), cz = Math.floor(az / L.size);
      const keep = L.r + 2;
      const map = this.chunks[lod];
      // Drop far chunks.
      for (const [k, c] of map) {
        if (Math.abs(c.ix - cx) > keep || Math.abs(c.iz - cz) > keep) {
          this.dispose(c);
          map.delete(k);
          this.maskDirty[lod] = true;
        }
      }
      for (let dz = -L.r; dz <= L.r; dz++) for (let dx = -L.r; dx <= L.r; dx++) this.want(lod, cx + dx, cz + dz);
      // Prefetch two (near) or one (mid) chunks beyond the ring in the direction of travel.
      const ahead = lod === 0 ? 2 : 1;
      for (let k = 1; k <= L.r + ahead; k++) {
        const px = Math.floor((ax + this.dirX * k * L.size) / L.size), pz = Math.floor((az + this.dirZ * k * L.size) / L.size);
        for (let s = -1; s <= 1; s++) {
          if (Math.abs(this.dirX) > Math.abs(this.dirZ)) this.want(lod, px, pz + s);
          else this.want(lod, px + s, pz);
        }
      }
    }
    // 2. Issue requests, closest first (a few in flight per worker).
    const inflightCap = this.client.usingWorkers ? 6 : 1;
    if (this.client.pending < inflightCap) {
      const queued: Chunk[] = [];
      for (const m of this.chunks) for (const c of m.values()) if (c.state === 'queued') queued.push(c);
      queued.sort((a, b) => this.priority(a, ax, az) - this.priority(b, ax, az));
      for (const c of queued) {
        if (this.client.pending >= inflightCap) break;
        this.request(c);
        if (!this.client.usingWorkers) break;
      }
    }
    // 3. Horizon patch.
    const H = this.spec.horizon;
    if (!this.horizon.loading && (Math.hypot(ax - this.horizon.cx, az - this.horizon.cz) > H.rebuild || !this.horizon.mesh)) {
      const snap = this.spec.mid.size;
      this.requestHorizon(Math.round(ax / snap) * snap, Math.round(az / snap) * snap);
    }
    // 4. Build meshes from arrived data under the budget (always the chunk under the vehicle first).
    this.buildQueue.sort((a, b) => this.priority(a, ax, az) - this.priority(b, ax, az));
    while (this.buildQueue.length) {
      const c = this.buildQueue[0];
      const critical = c.lod === 0 && Math.abs(c.ix - Math.floor(ax / this.spec.near.size)) <= 1 && Math.abs(c.iz - Math.floor(az / this.spec.near.size)) <= 1;
      if (performance.now() - t0 > FRAME_BUDGET_MS - 1.8 && !critical) break;
      this.buildQueue.shift();
      if (c.state !== 'data' || c.gen !== this.gen) continue;
      this.buildChunk(c);
      if (performance.now() - t0 > FRAME_BUDGET_MS) break;
    }
    if (this.horizon.data && performance.now() - t0 < FRAME_BUDGET_MS - 2) this.buildHorizon();
    // 5. Masks.
    for (const lod of [0, 1] as const) this.updateMask(lod, ax, az);
    // 6. Water depth maps (time-sliced).
    this.updateDepth(ax, az, t0);
    const ms = performance.now() - t0;
    this.stats.chunkMsPerFrame = ms;
    this.stats.msHistory.push(ms);
    if (this.stats.msHistory.length > 600) this.stats.msHistory.shift();
    this.stats.missingAhead = this.missingAround(x, z);
    let nb = 0, mb = 0;
    for (const c of this.chunks[0].values()) if (c.state === 'built') nb++;
    for (const c of this.chunks[1].values()) if (c.state === 'built') mb++;
    this.stats.nearBuilt = nb;
    this.stats.midBuilt = mb;
    return ms;
  }

  private priority(c: Chunk, ax: number, az: number): number {
    const L = c.lod === 0 ? this.spec.near : this.spec.mid;
    const ccx = (c.ix + 0.5) * L.size, ccz = (c.iz + 0.5) * L.size;
    const dx = ccx - ax, dz = ccz - az;
    const d = Math.hypot(dx, dz) / L.size;
    const along = (dx * this.dirX + dz * this.dirZ) / L.size;
    // Near level first; within a level, closest first with a bonus ahead.
    return c.lod * 50 + d - Math.max(0, along) * 0.35;
  }

  private want(lod: 0 | 1, ix: number, iz: number): void {
    const k = `${ix},${iz}`;
    if (this.chunks[lod].has(k)) return;
    this.chunks[lod].set(k, { lod, ix, iz, state: 'queued', data: null, mesh: null, h: null, minH: 0, maxH: 0, gen: this.gen });
  }

  private request(c: Chunk): void {
    const f = this.frame!;
    const L = c.lod === 0 ? this.spec.near : this.spec.mid;
    c.state = 'loading';
    const cell = L.size / (L.res - 1);
    const padded = L.res + 2 * PAD;
    const sizeKm = (cell * (padded - 1)) / 1000;
    const ll = f.latLonOfAbs((c.ix + 0.5) * L.size, (c.iz + 0.5) * L.size, { lat: 0, lon: 0 });
    const gen = this.gen;
    this.stats.requested++;
    void this.client.request(ll.lat, ll.lon, sizeKm, padded, { seed: 0, refLat: this.refLat, seamless: true }).then((d) => {
      if (gen !== this.gen || !this.chunks[c.lod].has(`${c.ix},${c.iz}`)) return;
      if (!d) {
        c.state = 'queued';
        return;
      }
      c.data = d;
      c.state = 'data';
      this.stats.workerMs = d.ms;
      this.buildQueue.push(c);
    });
  }

  private requestHorizon(ax: number, az: number): void {
    const f = this.frame!;
    const H = this.spec.horizon;
    const ll = f.latLonOfAbs(ax, az, { lat: 0, lon: 0 });
    const gen = this.gen;
    this.horizon.loading = true;
    void this.client.request(ll.lat, ll.lon, H.size / 1000, H.res, { seed: 0, refLat: this.refLat, seamless: true, detail: 0.6 }).then((d) => {
      if (gen !== this.gen) return;
      this.horizon.loading = false;
      if (!d) return;
      this.horizon.data = d;
      this.horizon.cx = ax;
      this.horizon.cz = az;
      this.horizon.size = H.size;
      this.horizon.res = H.res;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Meshes
  // ---------------------------------------------------------------------------------------------
  private indexFor(res: number): THREE.BufferAttribute {
    let a = this.indexCache.get(res);
    if (a) return a;
    // (res + 2)² vertices: the inner grid with a skirt ring around it.
    const R = res + 2;
    const idx = new Uint32Array((R - 1) * (R - 1) * 6);
    let o = 0;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < R - 1; j++) {
        const a0 = i * R + j, b0 = a0 + 1, c0 = a0 + R, d0 = c0 + 1;
        idx[o++] = a0; idx[o++] = c0; idx[o++] = b0;
        idx[o++] = b0; idx[o++] = c0; idx[o++] = d0;
      }
    }
    a = new THREE.BufferAttribute(idx, 1);
    this.indexCache.set(res, a);
    return a;
  }

  /**
   * Geometry for an inner res² grid of `size` meters taken from padded data (pad samples of border): positions local
   * to the chunk centre, normals from the padded heights (continuous across chunks), splat and tint, skirt ring.
   */
  private makeGeometry(d: ChunkData, res: number, pad: number, size: number, skirt: number): THREE.BufferGeometry {
    const P = res + 2 * pad;
    const R = res + 2;
    const n = R * R;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const sa = new Uint8Array(n * 4), sb = new Uint8Array(n * 4), tn = new Uint8Array(n * 3);
    const cell = size / (res - 1);
    const H = d.heights;
    const inv2 = 1 / (2 * cell);
    for (let gi = 0; gi < R; gi++) {
      const i = Math.min(res - 1, Math.max(0, gi - 1));
      const skirtRow = gi === 0 || gi === R - 1;
      for (let gj = 0; gj < R; gj++) {
        const j = Math.min(res - 1, Math.max(0, gj - 1));
        const skirtV = skirtRow || gj === 0 || gj === R - 1;
        const pi = i + pad, pj = j + pad;
        const k = pi * P + pj;
        let h = H[k];
        if (h < -60) h = -60;
        const v = gi * R + gj;
        pos[v * 3] = -size / 2 + j * cell;
        pos[v * 3 + 1] = skirtV ? h - skirt : h;
        pos[v * 3 + 2] = -size / 2 + i * cell;
        const hl = Math.max(-60, H[k - 1]), hr = Math.max(-60, H[k + 1]), hu = Math.max(-60, H[k - P]), hd = Math.max(-60, H[k + P]);
        const nx = -(hr - hl) * inv2, nz = -(hd - hu) * inv2;
        const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nrm[v * 3] = nx * il;
        nrm[v * 3 + 1] = il;
        nrm[v * 3 + 2] = nz * il;
        for (let c = 0; c < 4; c++) {
          sa[v * 4 + c] = d.splatA[k * 4 + c];
          sb[v * 4 + c] = d.splatB[k * 4 + c];
        }
        tn[v * 3] = d.tint[k * 3];
        tn[v * 3 + 1] = d.tint[k * 3 + 1];
        tn[v * 3 + 2] = d.tint[k * 3 + 2];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('splatA', new THREE.BufferAttribute(sa, 4, true));
    g.setAttribute('splatB', new THREE.BufferAttribute(sb, 4, true));
    g.setAttribute('tint', new THREE.BufferAttribute(tn, 3, true));
    g.setIndex(this.indexFor(res));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-size / 2, d.minHeight - skirt, -size / 2), new THREE.Vector3(size / 2, d.maxHeight + 5, size / 2));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    return g;
  }

  private buildChunk(c: Chunk): void {
    const d = c.data!;
    const L = c.lod === 0 ? this.spec.near : this.spec.mid;
    const g = this.makeGeometry(d, L.res, PAD, L.size, L.skirt);
    const m = new THREE.Mesh(g, c.lod === 0 ? this.material : this.midMaterial);
    m.name = c.lod === 0 ? 'terrain-near' : 'terrain-mid';
    m.receiveShadow = c.lod === 0;
    const f = this.frame!;
    m.position.set((c.ix + 0.5) * L.size - f.offX, 0, (c.iz + 0.5) * L.size - f.offZ);
    m.matrixAutoUpdate = true;
    this.group.add(m);
    c.mesh = m;
    c.h = d.heights;
    c.minH = d.minHeight;
    c.maxH = d.maxHeight;
    if (d.minHeight < 1) this.anyWater = true;
    // Keep only what height and surface queries need.
    c.data = { ...d, water: new Uint8Array(0) };
    c.state = 'built';
    this.maskDirty[c.lod] = true;
    this.depthDirty[c.lod] = true;
    this.stats.built++;
  }

  private buildHorizon(): void {
    const hz = this.horizon;
    const d = hz.data!;
    hz.data = null;
    const g = this.makeGeometry(d, hz.res, 0, hz.size, 1200);
    if (hz.mesh) {
      this.group.remove(hz.mesh);
      hz.mesh.geometry.dispose();
    }
    const m = new THREE.Mesh(g, this.horMaterial);
    m.name = 'terrain-horizon';
    const f = this.frame!;
    m.position.set(hz.cx - f.offX, 0, hz.cz - f.offZ);
    this.group.add(m);
    hz.mesh = m;
    hz.h = d.heights;
    if (d.minHeight < 1) this.anyWater = true;
    this.depthDirty[1] = true;
  }

  private updateMask(lod: 0 | 1, ax: number, az: number): void {
    const L = lod === 0 ? this.spec.near : this.spec.mid;
    const cx = Math.floor(ax / L.size) - MASK_N / 2, cz = Math.floor(az / L.size) - MASK_N / 2;
    const o = this.maskCellOrigin[lod];
    if (o.x !== cx || o.z !== cz) {
      o.x = cx;
      o.z = cz;
      this.maskDirty[lod] = true;
    }
    const f = this.frame!;
    this.maskOrigin[lod].set(cx * L.size - f.offX, cz * L.size - f.offZ);
    if (!this.maskDirty[lod]) return;
    this.maskDirty[lod] = false;
    const t = this.masks[lod];
    const a = t.image.data as Uint8Array;
    a.fill(0);
    for (const c of this.chunks[lod].values()) {
      if (c.state !== 'built') continue;
      const i = c.ix - cx, k = c.iz - cz;
      if (i < 0 || k < 0 || i >= MASK_N || k >= MASK_N) continue;
      a[k * MASK_N + i] = 255;
    }
    t.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------
  private chunkAt(lod: 0 | 1, ax: number, az: number): Chunk | null {
    const L = lod === 0 ? this.spec.near : this.spec.mid;
    const c = this.chunks[lod].get(`${Math.floor(ax / L.size)},${Math.floor(az / L.size)}`);
    return c && c.state === 'built' ? c : null;
  }

  /** Terrain height (m ASL, may be < 0 under water) at scene x (east), z (south): the finest built level. */
  heightAt(x: number, z: number): number {
    const f = this.frame;
    if (!f) return 0;
    const ax = x + f.offX, az = z + f.offZ;
    for (const lod of [0, 1] as const) {
      const c = this.chunkAt(lod, ax, az);
      if (!c || !c.h) continue;
      const L = lod === 0 ? this.spec.near : this.spec.mid;
      return sampleGrid(c.h, L.res + 2 * PAD, PAD, (ax - c.ix * L.size) / L.size * (L.res - 1), (az - c.iz * L.size) / L.size * (L.res - 1));
    }
    const hz = this.horizon;
    if (hz.h && hz.mesh) {
      const u = ((ax - hz.cx) / hz.size + 0.5) * (hz.res - 1), v = ((az - hz.cz) / hz.size + 0.5) * (hz.res - 1);
      return sampleGrid(hz.h, hz.res, 0, u, v);
    }
    return 0;
  }

  /** Walkable surface: terrain or the sea surface (0). */
  surfaceAt(x: number, z: number): number {
    return Math.max(0, this.heightAt(x, z));
  }

  normalAt(x: number, z: number, out: THREE.Vector3, d = 2): THREE.Vector3 {
    const hl = this.heightAt(x - d, z), hr = this.heightAt(x + d, z);
    const hu = this.heightAt(x, z - d), hd = this.heightAt(x, z + d);
    return out.set(-(hr - hl) / (2 * d), 1, -(hd - hu) / (2 * d)).normalize();
  }

  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < 0.4;
  }

  /** Whether the near chunk under (x, z) is built (physics and props are exact there). */
  nearReady(x: number, z: number): boolean {
    const f = this.frame;
    if (!f) return false;
    return !!this.chunkAt(0, x + f.offX, z + f.offZ);
  }

  /** Splat and tint of the near level at (x, z) (nearest sample); false where no near chunk is built. */
  sample(x: number, z: number, out: SurfaceSample): boolean {
    const f = this.frame;
    if (!f) return false;
    const ax = x + f.offX, az = z + f.offZ;
    const c = this.chunkAt(0, ax, az);
    if (!c || !c.data) return false;
    const L = this.spec.near;
    const P = L.res + 2 * PAD;
    const j = Math.round((ax - c.ix * L.size) / L.size * (L.res - 1)) + PAD, i = Math.round((az - c.iz * L.size) / L.size * (L.res - 1)) + PAD;
    const k = Math.max(0, Math.min(P - 1, i)) * P + Math.max(0, Math.min(P - 1, j));
    const d = c.data;
    for (let q = 0; q < 4; q++) {
      out.splat[q] = d.splatA[k * 4 + q] / 255;
      out.splat[4 + q] = d.splatB[k * 4 + q] / 255;
    }
    out.tint[0] = d.tint[k * 3] / 255;
    out.tint[1] = d.tint[k * 3 + 1] / 255;
    out.tint[2] = d.tint[k * 3 + 2] / 255;
    return true;
  }

  /** Near chunks not built in the vehicle's 3 × 3 neighbourhood (§9.4: must stay 0). */
  missingAround(x: number, z: number): number {
    const f = this.frame;
    if (!f) return 9;
    const L = this.spec.near;
    const cx = Math.floor((x + f.offX) / L.size), cz = Math.floor((z + f.offZ) / L.size);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = this.chunks[0].get(`${cx + dx},${cz + dz}`);
      if (!c || c.state !== 'built') n++;
    }
    return n;
  }

  /**
   * How far (m) the vehicle may travel along (dx, dz) before its 3 × 3 neighbourhood would include an unbuilt near
   * chunk: the travel throttle keeps the next real second of movement inside this distance.
   */
  readyAheadM(x: number, z: number, dx: number, dz: number): number {
    const f = this.frame;
    if (!f) return 0;
    const L = this.spec.near;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return this.missingAround(x, z) === 0 ? L.size : 0;
    const ux = dx / l, uz = dz / l;
    const ax = x + f.offX, az = z + f.offZ;
    const step = L.size / 4;
    for (let s = 0; s <= L.size * 6; s += step) {
      const px = ax + ux * s, pz = az + uz * s;
      const cx = Math.floor(px / L.size), cz = Math.floor(pz / L.size);
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const c = this.chunks[0].get(`${cx + ox},${cz + oz}`);
        if (!c || c.state !== 'built') return Math.max(0, s - step);
      }
    }
    return L.size * 6;
  }

  /** p95 of the main-thread ms per frame over the last 600 frames. */
  p95(): number {
    const h = [...this.stats.msHistory].sort((a, b) => a - b);
    return h.length ? h[Math.min(h.length - 1, Math.floor(h.length * 0.95))] : 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Water depth maps
  // ---------------------------------------------------------------------------------------------
  private updateDepth(ax: number, az: number, t0: number): void {
    if (!this.anyWater) return;
    const f = this.frame!;
    if (!this.depthJob) {
      for (const k of [0, 1] as const) {
        const size = k === 0 ? this.spec.depthNear : this.spec.depthFar;
        const c = this.depthAbs[k];
        if (!this.depthDirty[k] && Math.hypot(ax - c.x, az - c.z) < size * 0.2) continue;
        this.depthDirty[k] = false;
        this.depthJob = { tex: k, row: 0, cx: ax, cz: az, size, data: new Uint8Array(256 * 256) };
        break;
      }
    }
    const job = this.depthJob;
    if (!job) return;
    const N = 256;
    while (job.row < N && performance.now() - t0 < FRAME_BUDGET_MS) {
      const z = job.cz + (job.row / (N - 1) - 0.5) * job.size - f.offZ;
      for (let j = 0; j < N; j++) {
        const x = job.cx + (j / (N - 1) - 0.5) * job.size - f.offX;
        const h = this.heightAt(x, z);
        job.data[job.row * N + j] = Math.max(0, Math.min(255, Math.round((-h / 40) * 255)));
      }
      job.row++;
    }
    if (job.row < N) return;
    const t = mkDepth(N);
    (t.image.data as Uint8Array).set(job.data);
    t.needsUpdate = true;
    if (job.tex === 0) {
      this.depthNear.dispose();
      this.depthNear = t;
      this.depthCenterNear.set(job.cx - f.offX, job.cz - f.offZ);
    } else {
      this.depthFar.dispose();
      this.depthFar = t;
      this.depthCenterFar.set(job.cx - f.offX, job.cz - f.offZ);
    }
    this.depthAbs[job.tex] = { x: job.cx, z: job.cz };
    this.depthJob = null;
    this.onDepth?.();
  }

  get depthSizes(): [number, number] {
    return [this.spec.depthNear, this.spec.depthFar];
  }

  /** Called when a depth map was replaced (the water shader rebinds it). */
  onDepth: (() => void) | null = null;

  /** Chunks ready around (x, z) right now: near level, (2r + 1)² ring (entry wait). */
  ringReady(x: number, z: number, r = 1): boolean {
    const f = this.frame;
    if (!f) return false;
    const L = this.spec.near;
    const cx = Math.floor((x + f.offX) / L.size), cz = Math.floor((z + f.offZ) / L.size);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const c = this.chunks[0].get(`${cx + dx},${cz + dz}`);
      if (!c || c.state !== 'built') return false;
    }
    return !!this.horizon.mesh;
  }

  /** Every near chunk built right now (verifier: the mesh ring around the vehicle). */
  builtNear(): { ix: number; iz: number }[] {
    const out: { ix: number; iz: number }[] = [];
    for (const c of this.chunks[0].values()) if (c.state === 'built') out.push({ ix: c.ix, iz: c.iz });
    return out;
  }

  /** Velocity last passed to update (m/s). */
  get velocity(): [number, number] {
    return [this.vx, this.vz];
  }
}

function sampleGrid(H: Float32Array, stride: number, pad: number, fu: number, fv: number): number {
  const r1 = stride - 2 * pad - 1;
  fu = Math.max(0, Math.min(r1, fu));
  fv = Math.max(0, Math.min(r1, fv));
  const j0 = Math.min(r1 - 1, Math.floor(fu)), i0 = Math.min(r1 - 1, Math.floor(fv));
  const tj = fu - j0, ti = fv - i0;
  const base = (i0 + pad) * stride + j0 + pad;
  const a = H[base], b = H[base + 1], c = H[base + stride], d = H[base + stride + 1];
  // Same triangulation as the mesh (a-c-b / b-c-d): exact on the drawn surface, so wheels never float or sink.
  if (tj + ti <= 1) return a + (b - a) * tj + (c - a) * ti;
  return d + (c - d) * (1 - tj) + (b - d) * (1 - ti);
}

function mkDepth(n: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(n * n), n, n, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}
