// FRONT ULTRA — territory data textures for the planet shader (owner: globe).
//   * owner texture (1600x800 RGBA8, nearest): RG = owner id, BA = capture tick stamp (16 bit). Updated from
//     'tilesChanged' deltas by 64x64 dirty blocks (texSubImage2D through copyTextureToTexture), never a
//     full re-upload per tick.
//   * palette (2048x1 RGBA8): nation color + flags (human / ally / traitor / alive).
//   * border glow (800x400, GPU): edge detect + separable blur, re-run at most ~6x per second.
//   * front heat (400x200 R8): splats of the sim's front polylines (pulsing hot front lines).
//   * scars: fallout craters as a small uniform array.

import * as THREE from 'three';
import type { GameContext } from '../../shared/api';
import { HUMAN_ID, MAP_H, MAP_W, TILE_COUNT } from '../../shared/constants';
import { unpackOwner, unpackTile } from '../../shared/protocol';
import type { FrontView, ScarView } from '../../shared/types';

const BLOCK = 64;
const BX = Math.ceil(MAP_W / BLOCK);
const BY = Math.ceil(MAP_H / BLOCK);
const PALETTE_SIZE = 2048;
const HEAT_W = 400, HEAT_H = 200;
const GLOW_W = 800, GLOW_H = 400;
export const MAX_SCARS = 16;

export const PAL_HUMAN = 1, PAL_ALLY = 2, PAL_TRAITOR = 4, PAL_ALIVE = 8;

const fsVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const edgeFrag = /* glsl */ `
uniform sampler2D uOwner;
varying vec2 vUv;
int ownerAt(ivec2 p) {
  p.x = (p.x + ${MAP_W}) % ${MAP_W};
  p.y = clamp(p.y, 0, ${MAP_H - 1});
  vec4 t = texelFetch(uOwner, p, 0);
  return int(t.r * 255.0 + 0.5) + int(t.g * 255.0 + 0.5) * 256;
}
void main() {
  ivec2 base = ivec2(floor(gl_FragCoord.xy)) * 2;
  float e = 0.0;
  int o[16];
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) o[j * 4 + i] = ownerAt(base + ivec2(i - 1, j - 1));
  for (int j = 1; j < 3; j++) for (int i = 1; i < 3; i++) {
    int c = o[j * 4 + i];
    if (c == 0) continue;
    if (o[j * 4 + i - 1] != c || o[j * 4 + i + 1] != c || o[(j - 1) * 4 + i] != c || o[(j + 1) * 4 + i] != c) e = 1.0;
  }
  gl_FragColor = vec4(e, 0.0, 0.0, 1.0);
}`;

const blurFrag = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float w[5];
  w[0] = 0.2270270; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.0540540; w[4] = 0.0162162;
  float s = texture2D(uSrc, vUv).r * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i) * 1.6;
    s += (texture2D(uSrc, vUv + o).r + texture2D(uSrc, vUv - o).r) * w[i];
  }
  gl_FragColor = vec4(s, 0.0, 0.0, 1.0);
}`;

export interface TerritoryLayer {
  readonly uniforms: {
    uOwner: { value: THREE.Texture };
    uPalette: { value: THREE.Texture };
    uHeat: { value: THREE.Texture };
    uGlow: { value: THREE.Texture };
    uScars: { value: THREE.Vector4[] };
    uScarCount: { value: number };
    uTick: { value: number };
    uHoverOwner: { value: number };
    uHoverAmt: { value: number };
    uTerritoryOpacity: { value: number };
  };
  /** Mark everything for a full rebuild from ctx.sim.view.owner. */
  resetAll(): void;
  clear(): void;
  update(dt: number): void;
  setHoverOwner(owner: number): void;
  warmup(): void;
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

  const rtOpts = {
    type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: false, stencilBuffer: false,
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
  } as const;
  const glowA = new THREE.WebGLRenderTarget(GLOW_W, GLOW_H, rtOpts);
  const glowB = new THREE.WebGLRenderTarget(GLOW_W, GLOW_H, rtOpts);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsScene = new THREE.Scene();
  const edgeMat = new THREE.ShaderMaterial({ vertexShader: fsVert, fragmentShader: edgeFrag, uniforms: { uOwner: { value: ownerTex } }, depthTest: false, depthWrite: false });
  const blurMat = new THREE.ShaderMaterial({
    vertexShader: fsVert, fragmentShader: blurFrag, depthTest: false, depthWrite: false,
    uniforms: { uSrc: { value: glowA.texture }, uDir: { value: new THREE.Vector2() } },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edgeMat);
  quad.frustumCulled = false;
  fsScene.add(quad);

  const scars: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_SCARS; i++) scars.push(new THREE.Vector4());

  const uniforms = {
    uOwner: { value: ownerTex as THREE.Texture },
    uPalette: { value: palTex as THREE.Texture },
    uHeat: { value: heatTex as THREE.Texture },
    uGlow: { value: glowB.texture as THREE.Texture },
    uScars: { value: scars },
    uScarCount: { value: 0 },
    uTick: { value: 0 },
    uHoverOwner: { value: 0 },
    uHoverAmt: { value: 0 },
    uTerritoryOpacity: { value: 0 },
  };

  const dirty = new Uint8Array(BX * BY);
  let anyDirty = false;
  let fullDirty = true;
  let glowDirty = true;
  let glowTimer = 0;
  let lastFronts: readonly FrontView[] | null = null;
  let lastScars: readonly ScarView[] | null = null;
  let stampEpoch = -1;
  let hoverTarget = 0;
  let paletteTimer = 0;
  let knownPlayers = 0;
  const box = new THREE.Box2();
  const pos = new THREE.Vector2();

  function writeTile(tile: number, owner: number, stamp: number): void {
    const o = tile * 4;
    data[o] = owner & 255;
    data[o + 1] = (owner >> 8) & 255;
    data[o + 2] = stamp & 255;
    data[o + 3] = (stamp >> 8) & 255;
  }

  function rebuildAll(): void {
    const owner = ctx.sim.view.owner;
    const old = (ctx.sim.view.tick - 30_000) & 0xffff;
    for (let t = 0; t < TILE_COUNT; t++) writeTile(t, owner[t] ?? 0, old);
    fullDirty = true;
    glowDirty = true;
  }

  ctx.bus.on('tilesChanged', (e) => {
    if (e.full) {
      rebuildAll();
      return;
    }
    const stamp = ctx.sim.view.tick & 0xffff;
    for (let i = 0; i < e.count; i++) {
      const tile = unpackTile(e.packed[i]);
      writeTile(tile, unpackOwner(e.packed[i]), stamp);
      const x = tile % MAP_W, y = (tile / MAP_W) | 0;
      dirty[((y / BLOCK) | 0) * BX + ((x / BLOCK) | 0)] = 1;
    }
    if (e.count > 0) {
      anyDirty = true;
      glowDirty = true;
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
    const human = view.human;
    const allies = human ? human.allies : [];
    for (const p of view.playerList) {
      if (!p || p.id <= 0 || p.id >= PALETTE_SIZE) continue;
      const o = p.id * 4;
      palNext[o] = (p.color >> 16) & 255;
      palNext[o + 1] = (p.color >> 8) & 255;
      palNext[o + 2] = p.color & 255;
      let flags = 0;
      if (p.id === HUMAN_ID) flags |= PAL_HUMAN;
      if (allies.includes(p.id)) flags |= PAL_ALLY;
      if (p.traitorTicks > 0) flags |= PAL_TRAITOR;
      if (p.alive) flags |= PAL_ALIVE;
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

  function renderGlow(): void {
    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    quad.material = edgeMat;
    r.setRenderTarget(glowA);
    r.render(fsScene, fsCam);
    quad.material = blurMat;
    blurMat.uniforms.uSrc.value = glowA.texture;
    blurMat.uniforms.uDir.value.set(1 / GLOW_W, 0);
    r.setRenderTarget(glowB);
    r.render(fsScene, fsCam);
    blurMat.uniforms.uSrc.value = glowB.texture;
    blurMat.uniforms.uDir.value.set(0, 1 / GLOW_H);
    r.setRenderTarget(glowA);
    r.render(fsScene, fsCam);
    // Final result lives in glowA; swap the sampled texture.
    uniforms.uGlow.value = glowA.texture;
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
  }

  return {
    uniforms,
    resetAll() {
      rebuildAll();
      lastFronts = null;
      lastScars = null;
      heatF.fill(0);
      heatData.fill(0);
      heatTex.needsUpdate = true;
      updatePalette();
    },
    clear() {
      data.fill(0);
      fullDirty = true;
      glowDirty = true;
      dirty.fill(0);
      anyDirty = false;
      palData.fill(0);
      palTex.needsUpdate = true;
      heatData.fill(0);
      heatTex.needsUpdate = true;
      uniforms.uScarCount.value = 0;
      lastFronts = null;
      lastScars = null;
      stampEpoch = -1;
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
    update(dt) {
      const view = ctx.sim.view;
      const inSession = view.phase !== 'none';
      uniforms.uTick.value = view.tick + (inSession ? view.alpha : 0);
      uniforms.uHoverAmt.value += (hoverTarget - uniforms.uHoverAmt.value) * Math.min(1, dt * 10);
      if (!inSession) return;

      // Keep capture stamps from wrapping into "fresh" after 65536 ticks.
      const epoch = view.tick >> 14;
      if (stampEpoch < 0) stampEpoch = epoch;
      else if (epoch !== stampEpoch) {
        stampEpoch = epoch;
        const now = view.tick & 0xffff;
        const old = (view.tick - 30_000) & 0xffff;
        for (let t = 0; t < TILE_COUNT; t++) {
          const o = t * 4;
          const st = data[o + 2] | (data[o + 3] << 8);
          if (((now - st) & 0xffff) > 2000) {
            data[o + 2] = old & 255;
            data[o + 3] = old >> 8;
          }
        }
        fullDirty = true;
      }

      if (fullDirty) {
        ownerTex.needsUpdate = true;
        fullDirty = false;
        dirty.fill(0);
        anyDirty = false;
      } else if (anyDirty) {
        uploadDirty();
      }

      paletteTimer -= dt;
      if (paletteTimer <= 0 || view.playerList.length !== knownPlayers) {
        knownPlayers = view.playerList.length;
        paletteTimer = 0.25;
        updatePalette();
      }
      if (view.fronts !== lastFronts) {
        lastFronts = view.fronts;
        updateHeat(view.fronts);
      }
      if (view.scars !== lastScars) {
        lastScars = view.scars;
        updateScars(view.scars);
      }
      glowTimer -= dt;
      if (glowDirty && glowTimer <= 0) {
        glowDirty = false;
        glowTimer = 0.16;
        renderGlow();
      }
    },
    warmup() {
      renderGlow();
    },
  };
}
