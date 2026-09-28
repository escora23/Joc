// FRONT ULTRA — command mode: the tactical map (`M`, DESIGN_V2 §9.10; owner: W5-command-v2).
//
// A 2D overlay of 60 km (tank), 300 km (jet) or 150 km (ship) around the vehicle, north up: relief shading from the
// streamed ground, tile ownership tinted in each nation's colour with the borders, towns, known forces as icons
// (divisions, ships, squadrons, structures; own blue, at war red, at peace amber), fronts, and the destination.
// A click sets the autopilot destination; a right-click clears it. The world keeps its clock while it is open.

import * as THREE from 'three';
import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import { formatNumber, t } from '../shared/i18n';
import type { GameView } from '../shared/api';
import { StructureType, UnitType, type CommandKind } from '../shared/types';
import type { Civil } from './civil';
import type { LocalFrame } from './frame';
import type { Ground } from './stream';

export const TACMAP_KM: Record<CommandKind, number> = { tank: 60, jet: 300, ship: 150 };

const CSS = /* css */ `
.fu-cmdx-map { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); pointer-events: auto; }
.fu-cmdx-map.show { display: flex; }
.fu-cmdx-map .card { padding: 0.7rem; }
.fu-cmdx-map .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.5rem;
  font: 700 0.8rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.2em; text-transform: uppercase; }
.fu-cmdx-map .hd span { font: 500 0.78rem/1.2 var(--fu-font, sans-serif); letter-spacing: 0; text-transform: none; color: var(--fu-text-2, #b3c4d6); }
.fu-cmdx-map canvas { display: block; cursor: crosshair; border: 1px solid rgba(132,196,255,0.25); }
.fu-cmdx-map .lg { display: flex; flex-wrap: wrap; gap: 0.9rem; margin-top: 0.5rem; font: 600 0.74rem/1 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); }
.fu-cmdx-map .lg i { display: inline-block; width: 0.7rem; height: 0.7rem; margin-right: 0.3rem; vertical-align: -0.1rem; border-radius: 2px; }
`;
let cssDone = false;

export class TacMap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly title: HTMLElement;
  private readonly size = 620;
  private relief: ImageData | null = null;
  private reliefAt = { x: 1e12, z: 1e12 };
  private open = false;
  private kind: CommandKind = 'tank';
  private cx = 0;
  private cz = 0;
  /** Set by the command mode: a click on the map (scene x, z), or null to clear. */
  onPick: (p: { x: number; z: number } | null) => void = () => undefined;

  constructor(parent: HTMLElement) {
    if (!cssDone) {
      cssDone = true;
      const s = document.createElement('style');
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = document.createElement('div');
    this.root.className = 'fu-cmdx-map fu-cmd-interactive';
    const card = document.createElement('div');
    card.className = 'card fu-cmd-panel';
    const hd = document.createElement('div');
    hd.className = 'hd';
    this.title = document.createElement('b');
    const hint = document.createElement('span');
    hd.append(this.title, hint);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.size;
    this.canvas.style.width = this.canvas.style.height = `min(${this.size}px, 78vh)`;
    this.g = this.canvas.getContext('2d')!;
    const lg = document.createElement('div');
    lg.className = 'lg';
    card.append(hd, this.canvas, lg);
    this.root.appendChild(card);
    parent.appendChild(this.root);
    this.canvas.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const u = (ev.clientX - r.left) / r.width, v = (ev.clientY - r.top) / r.height;
      const half = (TACMAP_KM[this.kind] * 1000) / 2;
      if (ev.button === 2) this.onPick(null);
      else this.onPick({ x: this.cx + (u - 0.5) * 2 * half, z: this.cz + (v - 0.5) * 2 * half });
    });
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    this.root.addEventListener('mousedown', (ev) => ev.stopPropagation());
    this.labels = () => {
      hint.textContent = t('command.map.hint');
      lg.innerHTML = [
        ['#3fd0ff', 'command.map.you'], ['#ffd58a', 'command.map.waypoint'], ['#ff5a4a', 'command.map.enemy'],
        ['#6fb6ff', 'command.map.friendly'], ['#ffb53d', 'command.map.neutral'], ['#ff8a3d', 'command.map.front'], ['#ffffff', 'command.map.border'],
      ].map(([c, k]) => `<span><i style="background:${c}"></i>${t(k)}</span>`).join('');
    };
  }

  private labels: () => void;

  get isOpen(): boolean {
    return this.open;
  }

  toggle(kind: CommandKind): void {
    this.kind = kind;
    this.open = !this.open;
    this.root.classList.toggle('show', this.open);
    if (this.open) {
      this.labels();
      this.relief = null;
    }
  }

  close(): void {
    this.open = false;
    this.root.classList.remove('show');
  }

  /** Redraw (call ~2 times a second while open). */
  draw(view: GameView, frame: LocalFrame, ground: Ground, civil: Civil, player: THREE.Vector3, playerYaw: number, waypoint: THREE.Vector3 | null, controlledId: number): void {
    if (!this.open) return;
    const km = TACMAP_KM[this.kind];
    this.title.textContent = t('command.map.title', { km: formatNumber(km) });
    const S = this.size, half = (km * 1000) / 2;
    this.cx = player.x;
    this.cz = player.z;
    const g = this.g;
    const toPx = (x: number, z: number): [number, number] => [((x - this.cx) / (2 * half) + 0.5) * S, ((z - this.cz) / (2 * half) + 0.5) * S];
    // Relief (cached until the vehicle has moved 1/8 of the map).
    const ax = player.x + frame.offX, az = player.z + frame.offZ;
    if (!this.relief || Math.hypot(ax - this.reliefAt.x, az - this.reliefAt.z) > half / 4) {
      const N = 124;
      const img = g.createImageData(S, S);
      const hs = new Float32Array(N * N);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) hs[i * N + j] = ground.heightAt(this.cx + (j / (N - 1) - 0.5) * 2 * half, this.cz + (i / (N - 1) - 0.5) * 2 * half);
      const cell = (2 * half) / (N - 1);
      for (let y = 0; y < S; y++) {
        const fi = (y / (S - 1)) * (N - 1);
        const i = Math.min(N - 2, Math.floor(fi));
        for (let x = 0; x < S; x++) {
          const fj = (x / (S - 1)) * (N - 1);
          const j = Math.min(N - 2, Math.floor(fj));
          const h = hs[i * N + j];
          const dx = hs[i * N + j + 1] - h, dz = hs[(i + 1) * N + j] - h;
          const shade = Math.max(0.35, Math.min(1.3, 0.85 + (-dx - dz) / cell * 6));
          const o = (y * S + x) * 4;
          if (h < 0.3) {
            img.data[o] = 22; img.data[o + 1] = 48; img.data[o + 2] = 72;
          } else {
            const e = Math.min(1, h / 2500);
            img.data[o] = (70 + e * 90) * shade; img.data[o + 1] = (86 + e * 60) * shade; img.data[o + 2] = (56 + e * 50) * shade;
          }
          img.data[o + 3] = 255;
        }
      }
      this.relief = img;
      this.reliefAt = { x: ax, z: az };
    }
    g.putImageData(this.relief, 0, 0);
    // Ownership tint and borders (tile edges), in each nation's colour.
    const ll = frame.latLonOfScene(this.cx, this.cz, { lat: 0, lon: 0 });
    const tx0 = Math.floor(((ll.lon + 180) / 360) * MAP_W), ty0 = Math.floor(((90 - ll.lat) / 180) * MAP_H);
    const spanX = Math.ceil(half / 1000 / (25 * Math.max(0.2, Math.cos((ll.lat * Math.PI) / 180)))) + 2, spanY = Math.ceil(half / 25_000) + 2;
    const p0 = { x: 0, z: 0 }, p1 = { x: 0, z: 0 };
    for (let ty = ty0 - spanY; ty <= ty0 + spanY; ty++) {
      if (ty < 0 || ty >= MAP_H) continue;
      for (let tx = tx0 - spanX; tx <= tx0 + spanX; tx++) {
        const x = ((tx % MAP_W) + MAP_W) % MAP_W;
        const o = view.owner[ty * MAP_W + x];
        frame.sceneOfTile(tx, ty, p0);
        frame.sceneOfTile(tx + 1, ty + 1, p1);
        const [x0, y0] = toPx(p0.x, p0.z), [x1, y1] = toPx(p1.x, p1.z);
        if (o) {
          const pl = view.players[o];
          g.fillStyle = `#${(pl?.color ?? 0x888888).toString(16).padStart(6, '0')}`;
          g.globalAlpha = o === HUMAN_ID ? 0.16 : 0.24;
          g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          g.globalAlpha = 1;
        }
        const oe = view.owner[ty * MAP_W + ((x + 1) % MAP_W)], os = ty + 1 < MAP_H ? view.owner[(ty + 1) * MAP_W + x] : o;
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 1.5;
        if (oe !== o) {
          g.beginPath();
          g.moveTo(x1, y0);
          g.lineTo(x1, y1);
          g.stroke();
        }
        if (os !== o) {
          g.beginPath();
          g.moveTo(x0, y1);
          g.lineTo(x1, y1);
          g.stroke();
        }
      }
    }
    // Fronts.
    g.strokeStyle = '#ff8a3d';
    g.lineWidth = 3;
    for (const f of view.fronts) {
      const s = f.samples;
      g.beginPath();
      for (let i = 0; i + 1 < s.length; i += 2) {
        frame.sceneOfTile(s[i], s[i + 1], p0);
        const [x, y] = toPx(p0.x, p0.z);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    // Towns.
    g.font = '600 11px "Barlow", sans-serif';
    g.textAlign = 'center';
    for (const tw of civil.towns) {
      const [x, y] = toPx(tw.ax - frame.offX, tw.az - frame.offZ);
      if (x < 0 || y < 0 || x > S || y > S) continue;
      g.fillStyle = tw.level < 0 ? 'rgba(230,220,200,0.6)' : '#fff3d8';
      const r = tw.level < 0 ? 1.8 : 3.5;
      g.fillRect(x - r, y - r, r * 2, r * 2);
      if (tw.name) {
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.fillText(tw.name, x + 1, y - 6);
        g.fillStyle = '#fff3d8';
        g.fillText(tw.name, x, y - 7);
      }
    }
    // Structures and units.
    const rel = (o: number): string => (o === HUMAN_ID || view.hasTreaty(HUMAN_ID, o, 'alliance') ? '#6fb6ff' : view.pairState(HUMAN_ID, o) === 'war' ? '#ff5a4a' : '#ffb53d');
    for (const s of view.structures.values()) {
      if (s.type === StructureType.City) continue;
      const lat = 90 - (((s.tile / MAP_W) | 0) + 0.5) / MAP_H * 180, lon = ((s.tile % MAP_W) + 0.5) / MAP_W * 360 - 180;
      frame.sceneOf(lat, lon, p0);
      const [x, y] = toPx(p0.x, p0.z);
      if (x < 0 || y < 0 || x > S || y > S) continue;
      g.strokeStyle = rel(s.owner);
      g.lineWidth = 2;
      g.strokeRect(x - 4, y - 4, 8, 8);
    }
    for (const u of view.units.values()) {
      if (u.id === controlledId) continue;
      if (u.type !== UnitType.ArmoredDivision && u.type !== UnitType.Warship && u.type !== UnitType.FighterSquadron && u.type !== UnitType.Bomber) continue;
      frame.sceneOfTile(u.x, u.y, p0);
      const [x, y] = toPx(p0.x, p0.z);
      if (x < 0 || y < 0 || x > S || y > S) continue;
      g.fillStyle = rel(u.owner);
      g.beginPath();
      if (u.type === UnitType.ArmoredDivision) g.ellipse(x, y, 6, 4, 0, 0, Math.PI * 2);
      else if (u.type === UnitType.Warship) {
        g.moveTo(x, y - 6);
        g.lineTo(x + 4, y + 5);
        g.lineTo(x - 4, y + 5);
      } else {
        g.moveTo(x, y - 6);
        g.lineTo(x + 6, y + 4);
        g.lineTo(x - 6, y + 4);
      }
      g.fill();
    }
    // Waypoint and route.
    const [px, py] = toPx(player.x, player.z);
    if (waypoint) {
      const [wx, wy] = toPx(waypoint.x, waypoint.z);
      g.setLineDash([6, 5]);
      g.strokeStyle = 'rgba(255,213,138,0.9)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(wx, wy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd58a';
      g.beginPath();
      g.moveTo(wx, wy - 8);
      g.lineTo(wx + 6, wy);
      g.lineTo(wx, wy + 8);
      g.lineTo(wx - 6, wy);
      g.fill();
      const d = Math.hypot(waypoint.x - player.x, waypoint.z - player.z);
      g.fillText(`${formatNumber(d / 1000, 1)} km`, wx, wy - 12);
    }
    // You.
    g.save();
    g.translate(px, py);
    g.rotate(-playerYaw);
    g.fillStyle = '#3fd0ff';
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.restore();
    // Scale bar.
    const barKm = km >= 200 ? 50 : km >= 100 ? 20 : 10;
    const barPx = (barKm * 1000 / (2 * half)) * S;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(10, S - 26, barPx + 12, 18);
    g.fillStyle = '#fff';
    g.fillRect(16, S - 14, barPx, 3);
    g.textAlign = 'left';
    g.fillText(`${barKm} km`, 18, S - 17);
  }
}
