// FRONT ULTRA — minimap (owner: ui): equirectangular ownership map (400x200, one pixel per 4x4 tiles).
// The base layer is patched per changed tile from 'tilesChanged' (no full redraws except on resync) and
// blitted at <= 4 Hz; an overlay canvas draws the camera footprint, the capital, missiles in flight and
// world events. Click or drag to fly the camera.

import { h, toggleClass } from '../dom';
import { icon } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import type { CameraState } from '../../shared/api';
import { EARTH_RADIUS_KM, HUMAN_ID, MAP_H, MAP_W } from '../../shared/constants';
import { unpackOwner, unpackTile } from '../../shared/protocol';
import { isPlayableTerrain, isWaterTerrain } from '../../shared/terrain';
import { UnitType } from '../../shared/types';

const MW = 400, MH = 200, S = MAP_W / MW;

export interface Minimap {
  el: HTMLElement;
  reset(): void;
  refresh(): void;
  toggle(): void;
  /** v2 (W3): an expanding ring at a place for 1.5 s (§8.3). */
  ping(lat: number, lon: number, severity: string): void;
  /** Per frame: redraws the overlay while pings animate. */
  frame(): void;
  readonly pingCount: number;
}

export function createMinimap(hs: HudShared): Minimap {
  const ctx = hs.ctx;
  const base = h('canvas', { class: 'fu-mm-base', width: MW, height: MH }) as HTMLCanvasElement;
  const over = h('canvas', { class: 'fu-mm-over', width: MW * 2, height: MH * 2 }) as HTMLCanvasElement;
  const coords = h('span', { class: 'fu-mono fu-mm-coords' }, '');
  const hideBtn = h('button', { class: 'fu-lb-toggle', title: 'M' }, icon('chevronUp'));
  const el = h('div', { class: 'fu-mm fu-glass fu-brackets fu-interactive' },
    h('div', { class: 'fu-mm-head' }, h('div', { class: 'fu-panel-title' }, icon('map'), tx('hud.minimap')), coords, h('span', { class: 'fu-kbd' }, 'M'), hideBtn),
    h('div', { class: 'fu-mm-frame' }, base, over, h('div', { class: 'fu-mm-grid' })),
  );
  const g = base.getContext('2d', { alpha: false })!;
  const o = over.getContext('2d')!;
  const img = g.createImageData(MW, MH);
  const px = new Uint32Array(img.data.buffer);
  const terrainPx = new Uint32Array(MW * MH);
  const landMask = new Uint8Array(MW * MH);
  /** owner id -> ABGR (little endian) pixel. */
  const lut = new Uint32Array(2048);
  let dirty = true;
  let terrainBuilt = false;
  const cam: CameraState = { lat: 20, lon: 0, altitudeKm: 12000, tilt: 0, heading: 0 };

  const abgr = (r: number, gg: number, b: number) => (255 << 24) | (b << 16) | (gg << 8) | r;

  function buildTerrain(): void {
    const world = ctx.sim.view.world ?? ctx.world;
    if (!world) return;
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        let land = 0;
        for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
          const t = world.terrain[(y * S + sy) * MAP_W + x * S + sx];
          if (!isWaterTerrain(t)) land++;
        }
        const i = y * MW + x;
        const lat = 90 - ((y + 0.5) / MH) * 180;
        const shade = 1 - Math.abs(lat) / 140;
        if (land >= (S * S) / 2) {
          const ice = Math.abs(lat) > 62 && !isPlayableTerrain(world.terrain[(y * S + 2) * MAP_W + x * S + 2]);
          terrainPx[i] = ice ? abgr(96, 108, 122) : abgr(Math.round(52 * shade), Math.round(62 * shade), Math.round(70 * shade));
          landMask[i] = 1;
        } else {
          terrainPx[i] = land > 0 ? abgr(14, 30, 48) : abgr(Math.round(7 * shade), Math.round(17 * shade), Math.round(31 * shade));
          landMask[i] = 0;
        }
      }
    }
    terrainBuilt = true;
  }

  function colorFor(owner: number): number {
    if (owner === 0) return 0;
    const v = lut[owner];
    if (v) return v;
    const p = ctx.sim.view.players[owner];
    if (!p) return 0;
    const c = p.color;
    const col = abgr((c >> 16) & 255, (c >> 8) & 255, c & 255);
    lut[owner] = col;
    return col;
  }

  /** Owner of a 4x4-tile block: the most common owner among its tiles (0 when none), so small nations show too. */
  function blockOwner(x: number, y: number): number {
    const own = ctx.sim.view.owner;
    const at = (k: number) => own[(y * S + ((k / S) | 0)) * MAP_W + x * S + (k % S)];
    let best = 0, bn = 0;
    for (let k = 0; k < S * S; k++) {
      const o = at(k);
      if (!o || o === best) continue;
      // Counting from its first occurrence gives the owner's full count.
      let n = 0;
      for (let j = k; j < S * S; j++) if (at(j) === o) n++;
      if (n > bn) {
        bn = n;
        best = o;
      }
    }
    return best;
  }

  function fullRebuild(): void {
    if (!terrainBuilt) buildTerrain();
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const i = y * MW + x;
        const o0 = blockOwner(x, y);
        px[i] = o0 ? colorFor(o0) : terrainPx[i];
      }
    }
    dirty = true;
  }

  ctx.bus.on('tilesChanged', (e) => {
    if (!terrainBuilt) return;
    if (e.full) {
      lut.fill(0);
      fullRebuild();
      return;
    }
    const packed = e.packed;
    for (let k = 0; k < e.count; k++) {
      const tile = unpackTile(packed[k]);
      const owner = unpackOwner(packed[k]);
      const x = ((tile % MAP_W) / S) | 0, y = ((tile / MAP_W) | 0) / S | 0;
      const i = y * MW + x;
      const o0 = owner ? owner : blockOwner(x, y);
      px[i] = o0 ? colorFor(o0) : terrainPx[i];
    }
    dirty = true;
  });
  ctx.bus.on('cameraMoved', (c) => {
    cam.lat = c.lat;
    cam.lon = c.lon;
    cam.altitudeKm = c.altitudeKm;
    cam.heading = c.heading;
    cam.tilt = c.tilt;
  });

  // ---- interaction --------------------------------------------------------------------------------
  let dragging = false;
  const flyFromEvent = (e: PointerEvent, instant: boolean) => {
    const r = over.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const lat = 90 - v * 180, lon = u * 360 - 180;
    if (instant) ctx.cameraRig.setState({ lat: Math.max(-75, Math.min(80, lat)), lon });
    else ctx.bus.emit('focusRequest', { lat: Math.max(-75, Math.min(80, lat)), lon, durationMs: 900 });
  };
  over.addEventListener('pointerdown', (e) => {
    dragging = true;
    over.setPointerCapture(e.pointerId);
    hs.sound('click');
    flyFromEvent(e, false);
  });
  over.addEventListener('pointermove', (e) => {
    const r = over.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    coords.textContent = `${(90 - v * 180).toFixed(1)}°, ${(u * 360 - 180).toFixed(1)}°`;
    if (dragging && e.buttons) flyFromEvent(e, true);
  });
  over.addEventListener('pointerup', () => (dragging = false));
  over.addEventListener('pointerleave', () => (coords.textContent = ''));

  let hidden = false;
  const toggle = () => {
    hidden = !hidden;
    toggleClass(el, 'is-collapsed', hidden);
    hs.sound('toggle');
  };
  hideBtn.addEventListener('click', toggle);

  // ---- overlay ------------------------------------------------------------------------------------
  let blink = 0;
  const pings: { x: number; y: number; t0: number; color: string }[] = [];
  let pingTotal = 0;
  const PING_MS = 1500;
  function drawOverlay(): void {
    const view = ctx.sim.view;
    const W = over.width, H = over.height;
    o.clearRect(0, 0, W, H);
    const lx = (lon: number) => ((lon + 180) / 360) * W;
    const ly = (lat: number) => ((90 - lat) / 180) * H;
    // Camera footprint (approximate visible cap, clamped by the field of view).
    const R = EARTH_RADIUS_KM;
    const horizon = Math.acos(R / (R + cam.altitudeKm));
    const fovHalf = Math.atan(Math.tan((45 / 2) * Math.PI / 180) * cam.altitudeKm / R) * 1.15;
    const halfLatDeg = Math.min(horizon, fovHalf) * (180 / Math.PI);
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfLonDeg = Math.min(180, (halfLatDeg * aspect) / Math.max(0.2, Math.cos(cam.lat * Math.PI / 180)));
    o.lineWidth = 2;
    o.strokeStyle = 'rgba(255,255,255,0.85)';
    o.shadowColor = 'rgba(63,208,255,0.9)';
    o.shadowBlur = 6;
    const x0 = lx(cam.lon - halfLonDeg), x1 = lx(cam.lon + halfLonDeg);
    const y0 = ly(Math.min(90, cam.lat + halfLatDeg)), y1 = ly(Math.max(-90, cam.lat - halfLatDeg));
    const drawRect = (xa: number, xb: number) => {
      const w = xb - xa, hh = y1 - y0, c = Math.min(10, w / 4, hh / 4);
      o.beginPath();
      o.moveTo(xa, y0 + c); o.lineTo(xa, y0); o.lineTo(xa + c, y0);
      o.moveTo(xb - c, y0); o.lineTo(xb, y0); o.lineTo(xb, y0 + c);
      o.moveTo(xb, y1 - c); o.lineTo(xb, y1); o.lineTo(xb - c, y1);
      o.moveTo(xa + c, y1); o.lineTo(xa, y1); o.lineTo(xa, y1 - c);
      o.stroke();
      o.fillStyle = 'rgba(63,208,255,0.07)';
      o.fillRect(xa, y0, w, hh);
    };
    drawRect(x0, x1);
    if (x0 < 0) drawRect(x0 + W, x1 + W);
    if (x1 > W) drawRect(x0 - W, x1 - W);
    o.shadowBlur = 0;
    // Spawn phase (§10.13): every nation's capital as a dot in its colour, so the map shows who is where.
    if (view.phase === 'spawn') {
      for (const p of view.playerList) {
        if (!p.alive || p.capitalTile < 0 || p.kind !== 'nation') continue;
        const cx = ((p.capitalTile % MAP_W) + 0.5) / MAP_W * W, cy = (((p.capitalTile / MAP_W) | 0) + 0.5) / MAP_H * H;
        o.fillStyle = `#${p.color.toString(16).padStart(6, '0')}`;
        o.strokeStyle = 'rgba(0,0,0,0.7)';
        o.lineWidth = 1.5;
        o.beginPath();
        o.arc(cx, cy, 3.5, 0, Math.PI * 2);
        o.fill();
        o.stroke();
      }
    }
    // Human capital
    const me = view.human;
    blink = (blink + 1) % 8;
    if (me && me.capitalTile >= 0) {
      const cx = ((me.capitalTile % MAP_W) + 0.5) / MAP_W * W, cy = (((me.capitalTile / MAP_W) | 0) + 0.5) / MAP_H * H;
      o.strokeStyle = '#fff';
      o.lineWidth = 2;
      o.beginPath();
      o.arc(cx, cy, 5, 0, Math.PI * 2);
      o.stroke();
      o.fillStyle = '#ffd36b';
      o.fillRect(cx - 1.5, cy - 1.5, 3, 3);
    }
    // Missiles & nukes in flight
    for (const u of view.units.values()) {
      if (u.type !== UnitType.AtomBomb && u.type !== UnitType.HydrogenBomb && u.type !== UnitType.Mirv && u.type !== UnitType.MirvWarhead && u.type !== UnitType.CruiseMissile) continue;
      const ux = (u.x / MAP_W) * W, uy = (u.y / MAP_H) * H;
      const tx2 = (u.targetX / MAP_W) * W, ty2 = (u.targetY / MAP_H) * H;
      const hostile = u.owner !== HUMAN_ID;
      o.strokeStyle = hostile ? 'rgba(255,74,74,0.55)' : 'rgba(255,181,61,0.55)';
      o.setLineDash([4, 4]);
      o.lineWidth = 1.5;
      o.beginPath();
      o.moveTo(ux, uy);
      o.lineTo(tx2, ty2);
      o.stroke();
      o.setLineDash([]);
      o.fillStyle = hostile ? '#ff4a4a' : '#ffb53d';
      o.beginPath();
      o.arc(ux, uy, 3.5, 0, Math.PI * 2);
      o.fill();
      if (blink < 4) {
        o.strokeStyle = hostile ? '#ff4a4a' : '#ffb53d';
        o.beginPath();
        o.arc(tx2, ty2, 7, 0, Math.PI * 2);
        o.stroke();
      }
    }
    // v2 (W3, §8.3): fronts on us as persistent red marks, enemy convoys heading to us as red triangles with dashed
    // routes, and the alert pings (an expanding circle for 1.5 s).
    for (const f of view.fronts) {
      if (f.a !== HUMAN_ID && f.b !== HUMAN_ID) continue;
      const enemy = f.a === HUMAN_ID ? f.b : f.a;
      if (!enemy || view.pairState(HUMAN_ID, enemy) !== 'war') continue;
      const sm = f.samples;
      o.strokeStyle = f.quiet ? 'rgba(255,120,90,0.55)' : 'rgba(255,60,60,0.95)';
      o.lineWidth = f.quiet ? 2 : 3;
      o.beginPath();
      for (let i = 0; i + 1 < sm.length; i += 2) {
        const px = (sm[i] / MAP_W) * W, py = (sm[i + 1] / MAP_H) * H;
        if (i === 0 || Math.abs(px - (sm[i - 2] / MAP_W) * W) > W / 2) o.moveTo(px, py);
        else o.lineTo(px, py);
      }
      o.stroke();
    }
    for (const u of view.units.values()) {
      if (u.type !== UnitType.TransportShip || u.owner === HUMAN_ID) continue;
      const tt = Math.floor(u.targetY) * MAP_W + Math.floor(u.targetX);
      if (view.owner[tt] !== HUMAN_ID) continue;
      const ux = (u.x / MAP_W) * W, uy = (u.y / MAP_H) * H, txx = (u.targetX / MAP_W) * W, tyy = (u.targetY / MAP_H) * H;
      o.strokeStyle = 'rgba(255,74,74,0.8)';
      o.setLineDash([5, 4]);
      o.lineWidth = 1.5;
      o.beginPath();
      o.moveTo(ux, uy);
      o.lineTo(txx, tyy);
      o.stroke();
      o.setLineDash([]);
      const a = Math.atan2(tyy - uy, txx - ux);
      o.fillStyle = '#ff4a4a';
      o.beginPath();
      o.moveTo(ux + Math.cos(a) * 7, uy + Math.sin(a) * 7);
      o.lineTo(ux + Math.cos(a + 2.5) * 6, uy + Math.sin(a + 2.5) * 6);
      o.lineTo(ux + Math.cos(a - 2.5) * 6, uy + Math.sin(a - 2.5) * 6);
      o.closePath();
      o.fill();
    }
    const nowMs = performance.now();
    for (let i = pings.length - 1; i >= 0; i--) {
      const pg = pings[i];
      const k = (nowMs - pg.t0) / PING_MS;
      if (k >= 1) {
        pings.splice(i, 1);
        continue;
      }
      o.strokeStyle = pg.color;
      o.globalAlpha = 1 - k;
      o.lineWidth = 3;
      o.beginPath();
      o.arc(pg.x, pg.y, 4 + k * 30, 0, Math.PI * 2);
      o.stroke();
      o.beginPath();
      o.arc(pg.x, pg.y, 3, 0, Math.PI * 2);
      o.fillStyle = pg.color;
      o.fill();
      o.globalAlpha = 1;
    }
    // Active world events
    for (const ev of view.worldEvents) {
      if (ev.radius <= 0) continue;
      o.strokeStyle = 'rgba(255,181,61,0.8)';
      o.lineWidth = 1.5;
      o.beginPath();
      o.arc((ev.x / MAP_W) * W, (ev.y / MAP_H) * H, Math.max(4, (ev.radius / MAP_W) * W), 0, Math.PI * 2);
      o.stroke();
    }
  }

  function refresh(): void {
    if (hidden) return;
    if (!terrainBuilt) fullRebuild();
    if (dirty) {
      g.putImageData(img, 0, 0);
      dirty = false;
    }
    drawOverlay();
  }

  function reset(): void {
    lut.fill(0);
    fullRebuild();
  }

  return {
    el, refresh, reset, toggle,
    ping(lat, lon, severity) {
      pingTotal++;
      const W = over.width, H = over.height;
      const color = severity === 'info' ? '#3fd0ff' : severity === 'warning' ? '#ffb53d' : '#ff4a4a';
      pings.push({ x: ((lon + 180) / 360) * W, y: ((90 - lat) / 180) * H, t0: performance.now(), color });
      if (pings.length > 12) pings.shift();
    },
    frame() {
      if (pings.length && !hidden) drawOverlay();
    },
    get pingCount() {
      return pingTotal;
    },
  };
}
