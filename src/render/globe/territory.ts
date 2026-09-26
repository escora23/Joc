// FRONT ULTRA — territory data textures for the planet shader (owner: globe).
//   * owner texture (1600x800 RGBA8, nearest): R = owner low byte; G = owner bits 8-10 + static/dynamic tile flags
//     (water, small island, occupied, playable); BA = the conquest-flash stamp (real time, 1/32 s units, 16 bit).
//     Updated by 64x64 dirty blocks (copyTextureToTexture), never a full re-upload per tick.
//   * conquest wave: a batch of tile changes is revealed progressively in the sim's change order (BFS from the
//     front), spread over 0.1-2 s depending on its size, so a big transfer sweeps across the map instead of
//     appearing in one frame (DESIGN_V2 §4.13 "animated as a wave"; F3). The sim stays authoritative; the texture
//     lags it by at most the wave length.
//   * palette (2048x1 RGBA8): nation colour + flags (human / ally / traitor / alive / at war with the human /
//     independent / rebel).
//   * war pairs (512x512 R8): 255 where the two players (id & 511) are at war with each other (war-border cores).
//   * front heat (400x200 R8): splats of the sim's front polylines (contested stripes, cloud thinning over fronts).
//   * cloud mask (400x200 RGBA8, 4 Hz, dilated + blurred): R = the human's land, G = front heat, B = land. The cloud
//     shader samples it once (DESIGN_V2 §10.5).
//   * country raster (1600x800 RG8): historical (real-world) borders overlay.
//   * scars: fallout craters as a small uniform array.

import * as THREE from 'three';
import type { GameContext } from '../../shared/api';
import { HUMAN_ID, MAP_H, MAP_W, TILE_COUNT } from '../../shared/constants';
import { unpackOwner, unpackTile } from '../../shared/protocol';
import { isPlayableTerrain, isWaterTerrain } from '../../shared/terrain';
import type { FrontView, ScarView, WorldData } from '../../shared/types';
import { relationsFor } from '../relations';
import { landComponents } from './landComponents';

const BLOCK = 64;
const BX = Math.ceil(MAP_W / BLOCK);
const BY = Math.ceil(MAP_H / BLOCK);
const PALETTE_SIZE = 2048;
const HEAT_W = 400, HEAT_H = 200;
const MASK_W = 400, MASK_H = 200;
const PAIR_N = 512;
export const MAX_SCARS = 16;

/** Palette flags (alpha byte). */
export const PAL_HUMAN = 1, PAL_ALLY = 2, PAL_TRAITOR = 4, PAL_ALIVE = 8, PAL_WAR = 16, PAL_INDEP = 32, PAL_REBEL = 64;
/** Owner texture G-channel flags (bits 0-2 carry owner bits 8-10). */
export const OWN_WATER = 8, OWN_ISLAND = 16, OWN_OCCUPIED = 32, OWN_PLAYABLE = 64;

/** Flash stamps: 32 units per real second, 16-bit wrap (34 min) handled by periodic re-stamping. */
const FLASH_UNITS = 32;
const QUEUE_CAP = 1 << 18;

export interface TerritoryLayer {
  readonly uniforms: {
    uOwner: { value: THREE.Texture };
    uPalette: { value: THREE.Texture };
    uHeat: { value: THREE.Texture };
    uWarPairs: { value: THREE.Texture };
    uCountry: { value: THREE.Texture };
    uCloudMask: { value: THREE.Texture };
    uScars: { value: THREE.Vector4[] };
    uScarCount: { value: number };
    uFlashNow: { value: number };
    uHoverOwner: { value: number };
    uHoverAmt: { value: number };
    uTerritoryOpacity: { value: number };
    uHistorical: { value: number };
  };
  /** Mark everything for a full rebuild from ctx.sim.view.owner. */
  resetAll(): void;
  clear(): void;
  update(dt: number, realTime: number): void;
  setHoverOwner(owner: number): void;
  warmup(): void;
  /** Tiles still waiting in the conquest wave (debug / tests). */
  readonly pending: number;
  /** Is the tile shown as occupied (the sim's occupied set, view.isOccupied)? */
  isOccupied(tile: number): boolean;
}

export function createTerritoryLayer(ctx: GameContext): TerritoryLayer {
  const data = new Uint8Array(TILE_COUNT * 4);
  const ownerTex = new THREE.DataTexture(data, MAP_W, MAP_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  ownerTex.flipY = false;
  ownerTex.colorSpace = THREE.NoColorSpace;
  ownerTex.magFilter = THREE.NearestFilter;
  ownerTex.minFilter = THREE.NearestFilter;
  ownerTex.generateMipmaps = false;
  ownerTex.needsUpdate = true;
  // CPU-side twin (never bound): source for sub-rectangle uploads.
  const ownerSrc = new THREE.DataTexture(data, MAP_W, MAP_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  ownerSrc.flipY = false;

  const palData = new Uint8Array(PALETTE_SIZE * 4);
  const palTex = new THREE.DataTexture(palData, PALETTE_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  palTex.flipY = false;
  palTex.colorSpace = THREE.NoColorSpace;
  palTex.magFilter = THREE.NearestFilter;
  palTex.minFilter = THREE.NearestFilter;
  palTex.generateMipmaps = false;
  palTex.needsUpdate = true;
  const palNext = new Uint8Array(PALETTE_SIZE * 4);

  const pairData = new Uint8Array(PAIR_N * PAIR_N);
  const pairTex = new THREE.DataTexture(pairData, PAIR_N, PAIR_N, THREE.RedFormat, THREE.UnsignedByteType);
  pairTex.flipY = false;
  pairTex.colorSpace = THREE.NoColorSpace;
  pairTex.magFilter = THREE.NearestFilter;
  pairTex.minFilter = THREE.NearestFilter;
  pairTex.generateMipmaps = false;
  pairTex.needsUpdate = true;

  const heatF = new Float32Array(HEAT_W * HEAT_H);
  const heatData = new Uint8Array(HEAT_W * HEAT_H);
  const heatTex = new THREE.DataTexture(heatData, HEAT_W, HEAT_H, THREE.RedFormat, THREE.UnsignedByteType);
  heatTex.flipY = false;
  heatTex.colorSpace = THREE.NoColorSpace;
  heatTex.magFilter = THREE.LinearFilter;
  heatTex.minFilter = THREE.LinearFilter;
  heatTex.wrapS = THREE.RepeatWrapping;
  heatTex.generateMipmaps = false;
  heatTex.needsUpdate = true;

  const maskData = new Uint8Array(MASK_W * MASK_H * 4);
  const maskTex = new THREE.DataTexture(maskData, MASK_W, MASK_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  maskTex.flipY = false;
  maskTex.colorSpace = THREE.NoColorSpace;
  maskTex.magFilter = THREE.LinearFilter;
  maskTex.minFilter = THREE.LinearFilter;
  maskTex.wrapS = THREE.RepeatWrapping;
  maskTex.wrapT = THREE.ClampToEdgeWrapping;
  maskTex.generateMipmaps = false;
  maskTex.needsUpdate = true;
  const humanCnt = new Uint8Array(MASK_W * MASK_H);
  const landCnt = new Uint8Array(MASK_W * MASK_H);
  const maskA = new Float32Array(MASK_W * MASK_H * 3);
  const maskB = new Float32Array(MASK_W * MASK_H * 3);

  const countryData = new Uint8Array(TILE_COUNT * 2);
  const countryTex = new THREE.DataTexture(countryData, MAP_W, MAP_H, THREE.RGFormat, THREE.UnsignedByteType);
  countryTex.flipY = false;
  countryTex.colorSpace = THREE.NoColorSpace;
  countryTex.magFilter = THREE.NearestFilter;
  countryTex.minFilter = THREE.NearestFilter;
  countryTex.generateMipmaps = false;
  countryTex.needsUpdate = true;

  const scars: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_SCARS; i++) scars.push(new THREE.Vector4());

  const uniforms = {
    uOwner: { value: ownerTex as THREE.Texture },
    uPalette: { value: palTex as THREE.Texture },
    uHeat: { value: heatTex as THREE.Texture },
    uWarPairs: { value: pairTex as THREE.Texture },
    uCountry: { value: countryTex as THREE.Texture },
    uCloudMask: { value: maskTex as THREE.Texture },
    uScars: { value: scars },
    uScarCount: { value: 0 },
    uFlashNow: { value: 0 },
    uHoverOwner: { value: 0 },
    uHoverAmt: { value: 0 },
    uTerritoryOpacity: { value: 0 },
    uHistorical: { value: 0 },
  };

  const relations = relationsFor(ctx);
  const mirror = new Uint16Array(TILE_COUNT);
  /** Tiles whose occupied flag may differ from the sim's: recently changed tiles and every tile shown occupied. */
  const occCand = new Set<number>();
  const dirty = new Uint8Array(BX * BY);
  let anyDirty = false;
  let fullDirty = true;
  let staticWorld: WorldData | null = null;
  let lastFronts: readonly FrontView[] | null = null;
  let lastScars: readonly ScarView[] | null = null;
  let hoverTarget = 0;
  let paletteTimer = 0;
  let maskTimer = 0;
  let occTimer = 0;
  let restampTimer = 0;
  let knownPlayers = 0;
  let pairsRev = -1;
  let flashNow = 0;
  let realNow = 0;
  /** Tiles stamped in the last seconds (debug hook __territory.flashing()): tile, new owner, stamp (1/32 s units). */
  const recent: { tile: number; owner: number; stamp: number }[] = [];
  /** Shots: the flash clock pinned at this age (s) after the newest stamp, or null to follow real time. */
  let flashPin: number | null = null;
  const box = new THREE.Box2();
  const pos = new THREE.Vector2();

  // Conquest wave queue (ring buffer, due times non-decreasing).
  const qTile = new Int32Array(QUEUE_CAP);
  const qOwner = new Uint16Array(QUEUE_CAP);
  const qDue = new Float64Array(QUEUE_CAP);
  let qHead = 0, qLen = 0;
  let lastDue = 0;

  function markDirty(tile: number): void {
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    dirty[((y / BLOCK) | 0) * BX + ((x / BLOCK) | 0)] = 1;
    anyDirty = true;
  }

  function occupiedNow(tile: number): boolean {
    // The sim is the source of truth (§4.13, occupied in §14.5), never the client capture stamp.
    return ctx.sim.view.isOccupied?.(tile) === true;
  }

  function writeOwner(tile: number, owner: number, stamp: number): void {
    const o = tile * 4;
    data[o] = owner & 255;
    data[o + 1] = (data[o + 1] & (OWN_WATER | OWN_ISLAND | OWN_PLAYABLE)) | ((owner >> 8) & 7) | (occupiedNow(tile) ? OWN_OCCUPIED : 0);
    data[o + 2] = stamp & 255;
    data[o + 3] = (stamp >> 8) & 255;
  }

  function setStaticFlags(world: WorldData | null): void {
    if (!world || world === staticWorld) return;
    staticWorld = world;
    const comps = landComponents(world);
    for (let t = 0; t < TILE_COUNT; t++) {
      const tr = world.terrain[t];
      let f = 0;
      if (isWaterTerrain(tr)) f |= OWN_WATER;
      if (isPlayableTerrain(tr)) f |= OWN_PLAYABLE;
      data[t * 4 + 1] = (data[t * 4 + 1] & ~(OWN_WATER | OWN_ISLAND | OWN_PLAYABLE)) | f;
      const c = world.country[t] ?? 0;
      countryData[t * 2] = c & 255;
      countryData[t * 2 + 1] = (c >> 8) & 255;
    }
    for (const c of comps.small) {
      if (!c.tiles) continue;
      for (const t of c.tiles) data[t * 4 + 1] |= OWN_ISLAND;
    }
    landCnt.fill(0);
    for (let t = 0; t < TILE_COUNT; t++) {
      if (!isPlayableTerrain(world.terrain[t])) continue;
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      landCnt[(y >> 2) * MASK_W + (x >> 2)]++;
    }
    countryTex.needsUpdate = true;
    fullDirty = true;
  }

  function rebuildAll(): void {
    const view = ctx.sim.view;
    setStaticFlags(view.world ?? ctx.world);
    const owner = view.owner;
    // An old stamp: no flash anywhere after a resync (fast-forward, shots).
    const old = (flashNow - 20_000) & 0xffff;
    recent.length = 0;
    mirror.set(owner);
    qLen = 0;
    qHead = 0;
    humanCnt.fill(0);
    occCand.clear();
    for (let t = 0; t < TILE_COUNT; t++) {
      const o = owner[t] ?? 0;
      writeOwner(t, o, old);
      if (data[t * 4 + 1] & OWN_OCCUPIED) occCand.add(t);
      if (o === HUMAN_ID) {
        const x = t % MAP_W, y = (t / MAP_W) | 0;
        humanCnt[(y >> 2) * MASK_W + (x >> 2)]++;
      }
    }
    fullDirty = true;
    maskTimer = 0;
  }

  function applyTile(tile: number, owner: number): void {
    writeOwner(tile, owner, flashNow);
    if (recent.length >= 4096) recent.splice(0, 1024);
    recent.push({ tile, owner, stamp: flashNow });
    markDirty(tile);
  }

  function flushQueue(limitDue: number): void {
    while (qLen > 0 && qDue[qHead] <= limitDue) {
      applyTile(qTile[qHead], qOwner[qHead]);
      qHead = (qHead + 1) % QUEUE_CAP;
      qLen--;
    }
  }

  // Debug / verification hook (DESIGN_V2 §10.3 conquest flash): the tiles flashing now with their colour and age, and
  // a pin that holds the flash clock at a given age after the newest capture (deterministic shots).
  (window as unknown as { __territory?: unknown }).__territory = {
    flashing(): { tile: number; owner: number; color: string; age: number }[] {
      const now = uniforms.uFlashNow.value;
      const out: { tile: number; owner: number; color: string; age: number }[] = [];
      for (const r of recent) {
        const age = (((now - r.stamp) % 65536) + 65536) % 65536 / FLASH_UNITS;
        if (age >= 2 || mirror[r.tile] !== r.owner) continue;
        const c = ctx.sim.view.players[r.owner]?.color ?? 0;
        out.push({ tile: r.tile, owner: r.owner, color: '#' + c.toString(16).padStart(6, '0'), age: +age.toFixed(3) });
      }
      return out;
    },
    pinFlash(ageSec: number | null): void {
      flashPin = ageSec;
      if (ageSec === null || recent.length === 0) return;
      let newest = recent[recent.length - 1].stamp;
      for (const r of recent) if (((r.stamp - newest) & 0xffff) < 0x8000) newest = r.stamp;
      uniforms.uFlashNow.value = (newest + ageSec * FLASH_UNITS) % 65536;
    },
    queued: () => qLen,
  };

  ctx.bus.on('tilesChanged', (e) => {
    if (e.full) {
      rebuildAll();
      return;
    }
    const n = e.count;
    if (n <= 0) return;
    if (qLen + n > QUEUE_CAP) flushQueue(Infinity);
    // Wave length: one update interval for the everyday trickle, up to 2 s for a big transfer.
    const span = Math.min(2, 0.1 + n / 600);
    const start = Math.max(realNow, lastDue);
    for (let i = 0; i < n; i++) {
      const tile = unpackTile(e.packed[i]);
      const owner = unpackOwner(e.packed[i]);
      const prev = mirror[tile];
      mirror[tile] = owner;
      if (prev === HUMAN_ID || owner === HUMAN_ID) {
        const x = tile % MAP_W, y = (tile / MAP_W) | 0;
        const cell = (y >> 2) * MASK_W + (x >> 2);
        if (prev === HUMAN_ID && humanCnt[cell] > 0) humanCnt[cell]--;
        if (owner === HUMAN_ID) humanCnt[cell]++;
      }
      occCand.add(tile);
      const due = start + (span * i) / n;
      const k = (qHead + qLen) % QUEUE_CAP;
      qTile[k] = tile;
      qOwner[k] = owner;
      qDue[k] = due;
      qLen++;
      lastDue = due;
    }
  });

  function uploadDirty(): void {
    const r = ctx.renderer;
    for (let by = 0; by < BY; by++) {
      let bx = 0;
      while (bx < BX) {
        if (!dirty[by * BX + bx]) {
          bx++;
          continue;
        }
        const start = bx;
        while (bx < BX && dirty[by * BX + bx]) dirty[by * BX + bx++] = 0;
        const x0 = start * BLOCK, y0 = by * BLOCK;
        const x1 = Math.min(MAP_W, bx * BLOCK), y1 = Math.min(MAP_H, y0 + BLOCK);
        box.min.set(x0, y0);
        box.max.set(x1, y1);
        pos.set(x0, y0);
        r.copyTextureToTexture(ownerSrc, ownerTex, box, pos);
      }
    }
    anyDirty = false;
  }

  function updatePalette(): void {
    const view = ctx.sim.view;
    palNext.fill(0);
    for (const p of view.playerList) {
      if (!p || p.id <= 0 || p.id >= PALETTE_SIZE) continue;
      const o = p.id * 4;
      palNext[o] = (p.color >> 16) & 255;
      palNext[o + 1] = (p.color >> 8) & 255;
      palNext[o + 2] = p.color & 255;
      let flags = 0;
      const rel = relations.relationTo(p.id);
      if (p.id === HUMAN_ID) flags |= PAL_HUMAN;
      if (rel === 'ally') flags |= PAL_ALLY;
      if (rel === 'war') flags |= PAL_WAR;
      if (p.traitorTicks > 0) flags |= PAL_TRAITOR;
      if (p.alive) flags |= PAL_ALIVE;
      if (p.kind === 'tribe') flags |= PAL_INDEP;
      if (p.kind === 'rebel') flags |= PAL_REBEL;
      palNext[o + 3] = flags;
    }
    let changed = false;
    for (let i = 0; i < palNext.length; i++) {
      if (palNext[i] !== palData[i]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      palData.set(palNext);
      palTex.needsUpdate = true;
    }
  }

  function updatePairs(): void {
    pairData.fill(0);
    for (const [a, b] of relations.pairs) {
      const ia = a & (PAIR_N - 1), ib = b & (PAIR_N - 1);
      pairData[ia * PAIR_N + ib] = 255;
      pairData[ib * PAIR_N + ia] = 255;
    }
    pairTex.needsUpdate = true;
  }

  function updateHeat(fronts: readonly FrontView[]): void {
    heatF.fill(0);
    const sx = HEAT_W / MAP_W, sy = HEAT_H / MAP_H;
    for (const f of fronts) {
      const k = 0.35 + 0.65 * Math.min(1, Math.max(0, f.intensity));
      const s = f.samples;
      const n = s.length >> 1;
      const splat = (fx: number, fy: number) => {
        const cx = fx * sx, cy = fy * sy;
        const rad = 2.2;
        const x0 = Math.floor(cx - rad), x1 = Math.ceil(cx + rad);
        const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(HEAT_H - 1, Math.ceil(cy + rad));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rad;
            if (d >= 1) continue;
            const v = k * (1 - d * d);
            const i = y * HEAT_W + ((x % HEAT_W) + HEAT_W) % HEAT_W;
            if (v > heatF[i]) heatF[i] = v;
          }
        }
      };
      if (n === 0) splat(f.x, f.y);
      for (let i = 0; i < n; i++) {
        splat(s[i * 2], s[i * 2 + 1]);
        // Fill gaps between consecutive samples.
        if (i + 1 < n) {
          const ax = s[i * 2], ay = s[i * 2 + 1], bx = s[i * 2 + 2], by = s[i * 2 + 3];
          const d = Math.hypot(bx - ax, by - ay);
          if (d > 6 && d < 60) {
            const steps = Math.floor(d / 5);
            for (let j = 1; j < steps; j++) splat(ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps);
          }
        }
      }
    }
    for (let i = 0; i < heatData.length; i++) heatData[i] = Math.min(255, Math.round(heatF[i] * 255));
    heatTex.needsUpdate = true;
  }

  /**
   * Cloud mask (DESIGN_V2 §10.5): per 4x4-tile cell the human's land share (R), the front heat (G) and the land share
   * (B), dilated by one cell (so the thinning always covers the whole of the land it belongs to) and blurred by one
   * cell (so it feathers out instead of punching country-shaped holes in the cloud deck).
   */
  function composeMask(): void {
    const N = MASK_W * MASK_H;
    for (let i = 0; i < N; i++) {
      const land = landCnt[i];
      maskA[i * 3] = land > 0 ? Math.min(1, (humanCnt[i] * 2) / land) : 0;
      maskA[i * 3 + 1] = Math.min(1, heatF[i] * 1.6);
      maskA[i * 3 + 2] = Math.min(1, land / 8);
    }
    // Dilate (3x3 max), x wraps.
    for (let y = 0; y < MASK_H; y++) {
      for (let x = 0; x < MASK_W; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= MASK_H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const k = (yy * MASK_W + ((x + dx + MASK_W) % MASK_W)) * 3;
            if (maskA[k] > r) r = maskA[k];
            if (maskA[k + 1] > g) g = maskA[k + 1];
            if (maskA[k + 2] > b) b = maskA[k + 2];
          }
        }
        const o = (y * MASK_W + x) * 3;
        maskB[o] = r;
        maskB[o + 1] = g;
        maskB[o + 2] = b;
      }
    }
    // Blur: separable [1 2 1] / 4, twice (about 1.4 cells).
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < MASK_H; y++) {
        for (let x = 0; x < MASK_W; x++) {
          const l = (y * MASK_W + ((x + MASK_W - 1) % MASK_W)) * 3, c = (y * MASK_W + x) * 3, r = (y * MASK_W + ((x + 1) % MASK_W)) * 3;
          for (let ch = 0; ch < 3; ch++) maskA[c + ch] = (maskB[l + ch] + 2 * maskB[c + ch] + maskB[r + ch]) * 0.25;
        }
      }
      for (let y = 0; y < MASK_H; y++) {
        const yu = Math.max(0, y - 1), yd = Math.min(MASK_H - 1, y + 1);
        for (let x = 0; x < MASK_W; x++) {
          const u = (yu * MASK_W + x) * 3, c = (y * MASK_W + x) * 3, d = (yd * MASK_W + x) * 3;
          for (let ch = 0; ch < 3; ch++) maskB[c + ch] = (maskA[u + ch] + 2 * maskA[c + ch] + maskA[d + ch]) * 0.25;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      maskData[i * 4] = Math.round(Math.min(1, maskB[i * 3]) * 255);
      maskData[i * 4 + 1] = Math.round(Math.min(1, maskB[i * 3 + 1]) * 255);
      maskData[i * 4 + 2] = Math.round(Math.min(1, maskB[i * 3 + 2]) * 255);
      maskData[i * 4 + 3] = 255;
    }
    maskTex.needsUpdate = true;
  }

  function updateScars(list: readonly ScarView[]): void {
    const n = Math.min(MAX_SCARS, list.length);
    // Most recent/strongest first.
    const sorted = list.length > MAX_SCARS ? [...list].sort((a, b) => b.strength - a.strength) : list;
    for (let i = 0; i < n; i++) {
      const s = sorted[i];
      scars[i].set(s.x, s.y, Math.max(1.5, s.radius), Math.min(1, Math.max(0, s.strength)));
    }
    uniforms.uScarCount.value = n;
  }

  /** Follow the sim's occupied set (§4.13) and keep flash stamps from wrapping into "fresh" after 34 minutes. */
  function housekeeping(dt: number): void {
    occTimer -= dt;
    if (occTimer <= 0 && occCand.size) {
      occTimer = 0.5;
      const view = ctx.sim.view;
      for (const t of occCand) {
        const want = occupiedNow(t);
        const has = (data[t * 4 + 1] & OWN_OCCUPIED) !== 0;
        const shownOwner = data[t * 4] | ((data[t * 4 + 1] & 7) << 8);
        // Wait for the conquest wave to reveal the new owner before stippling it.
        if (want && !has && shownOwner === view.owner[t]) {
          data[t * 4 + 1] |= OWN_OCCUPIED;
          markDirty(t);
        } else if (!want && has) {
          data[t * 4 + 1] &= ~OWN_OCCUPIED;
          markDirty(t);
        }
        if (!want && shownOwner === view.owner[t]) occCand.delete(t);
      }
    }
    restampTimer -= dt;
    if (restampTimer <= 0) {
      restampTimer = 240;
      const now = flashNow;
      const old = (now - 1000) & 0xffff;
      for (let t = 0; t < TILE_COUNT; t++) {
        const o = t * 4;
        const st = data[o + 2] | (data[o + 3] << 8);
        if (((now - st) & 0xffff) > 16_000) {
          data[o + 2] = old & 255;
          data[o + 3] = old >> 8;
          markDirty(t);
        }
      }
    }
  }

  return {
    uniforms,
    get pending() {
      return qLen;
    },
    isOccupied(tile) {
      return occupiedNow(tile);
    },
    resetAll() {
      rebuildAll();
      lastFronts = null;
      lastScars = null;
      heatF.fill(0);
      heatData.fill(0);
      heatTex.needsUpdate = true;
      pairsRev = -1;
      updatePalette();
    },
    clear() {
      for (let t = 0; t < TILE_COUNT; t++) {
        const o = t * 4;
        data[o] = 0;
        data[o + 1] &= OWN_WATER | OWN_ISLAND | OWN_PLAYABLE;
      }
      mirror.fill(0);
      occCand.clear();
      qLen = 0;
      qHead = 0;
      fullDirty = true;
      dirty.fill(0);
      anyDirty = false;
      palData.fill(0);
      palTex.needsUpdate = true;
      pairData.fill(0);
      pairTex.needsUpdate = true;
      heatData.fill(0);
      heatF.fill(0);
      heatTex.needsUpdate = true;
      humanCnt.fill(0);
      maskData.fill(0);
      maskTex.needsUpdate = true;
      uniforms.uScarCount.value = 0;
      lastFronts = null;
      lastScars = null;
    },
    setHoverOwner(owner) {
      if (owner !== uniforms.uHoverOwner.value) {
        if (owner > 0) {
          uniforms.uHoverOwner.value = owner;
          uniforms.uHoverAmt.value = 0;
        }
        hoverTarget = owner > 0 ? 1 : 0;
      }
      if (owner <= 0) hoverTarget = 0;
    },
    update(dt, realTime) {
      realNow = realTime;
      flashNow = Math.floor(realTime * FLASH_UNITS) & 0xffff;
      if (flashPin === null) uniforms.uFlashNow.value = (realTime * FLASH_UNITS) % 65536;
      // Forget stamps older than the flash (2 s) plus a margin.
      while (recent.length > 0 && ((flashNow - recent[0].stamp) & 0xffff) > 5 * FLASH_UNITS && flashPin === null) recent.shift();
      const view = ctx.sim.view;
      const inSession = view.phase !== 'none';
      uniforms.uHoverAmt.value += (hoverTarget - uniforms.uHoverAmt.value) * Math.min(1, dt * 10);
      if (!inSession) return;
      if (!staticWorld) setStaticFlags(view.world ?? ctx.world);

      flushQueue(realNow);
      // A backlog longer than 3 s means updates arrive faster than the wave can show them: catch up.
      if (qLen > 0 && lastDue - realNow > 3) flushQueue(lastDue - 3);
      housekeeping(dt);

      if (fullDirty) {
        ownerTex.needsUpdate = true;
        fullDirty = false;
        dirty.fill(0);
        anyDirty = false;
      } else if (anyDirty) {
        uploadDirty();
      }

      const relChanged = relations.refresh(realTime);
      paletteTimer -= dt;
      if (relChanged || paletteTimer <= 0 || view.playerList.length !== knownPlayers) {
        knownPlayers = view.playerList.length;
        paletteTimer = 0.25;
        updatePalette();
      }
      if (relations.rev !== pairsRev) {
        pairsRev = relations.rev;
        updatePairs();
      }
      if (view.fronts !== lastFronts) {
        lastFronts = view.fronts;
        updateHeat(view.fronts);
      }
      if (view.scars !== lastScars) {
        lastScars = view.scars;
        updateScars(view.scars);
      }
      maskTimer -= dt;
      if (maskTimer <= 0) {
        maskTimer = 0.25;
        composeMask();
      }
    },
    warmup() {
      composeMask();
    },
  };
}
