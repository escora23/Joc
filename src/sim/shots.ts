// FRONT ULTRA — simulation shots (owner: sim-core). A 2D "war room" plot of the live simulation drawn over the
// game, so the sim can be judged on its own (territory, borders, fronts, units, structures, fallout, labels,
// leaderboard, territory-over-time and timelapse), independent of how the globe renders it.
//
//   ?shot=sim-map        tick 3000: the whole world ~5 minutes in (24 AI nations + tribes, human at Madrid)
//   ?shot=sim-europe     tick 3000: close plot of Europe
//   ?shot=sim-war        staged total war over western Europe: nukes, MIRV, SAMs, aircraft, navies, armor
//   ?shot=sim-timelapse  tick 6000: timelapse frames and the territory graph (end-screen data)
// Imported by src/sim/client.ts (main thread only).

import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import type { GameContext } from '../shared/api';
import { latLonToTile } from '../shared/geo';
import { registerShot } from '../shared/shots';
import { TERRAIN_CLASS_MASK, TerrainClass, StructureType, UnitType } from '../shared/types';

const STRUCT_GLYPH: Record<number, string> = {
  [StructureType.City]: 'C', [StructureType.Port]: 'P', [StructureType.Factory]: 'F', [StructureType.DefensePost]: 'D',
  [StructureType.SamSite]: 'S', [StructureType.MissileSilo]: 'M', [StructureType.Airbase]: 'A', [StructureType.ArmyBase]: 'B',
  [StructureType.NavalYard]: 'N', [StructureType.Radar]: 'R',
};

function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
function css(c: number, a = 1): string {
  const [r, g, b] = rgb(c);
  return `rgba(${r},${g},${b},${a})`;
}
function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

interface Viewport {
  /** Tile-space window. */
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Fullscreen overlay canvas (shots only; never created in normal play). */
function overlay(): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  document.getElementById('sim-shot-overlay')?.remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'sim-shot-overlay';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', zIndex: '500', width: '100%', height: '100%', background: '#05080d' });
  document.body.appendChild(canvas);
  return { canvas, g: canvas.getContext('2d')! };
}

/** Terrain + territory bitmap of a tile window, scaled to (pw x ph) pixels. `owners` overrides the live map. */
function territoryImage(ctx: GameContext, vp: Viewport, pw: number, ph: number, owners?: Uint16Array, ow = MAP_W, oh = MAP_H): ImageData {
  const view = ctx.sim.view;
  const world = view.world!;
  const img = new ImageData(pw, ph);
  const d = img.data;
  const colors: [number, number, number][] = [];
  for (const p of view.playerList) colors[p.id] = rgb(p.color);
  const owner = owners ?? view.owner;
  const sx = ow / MAP_W, sy = oh / MAP_H;
  const own = (x: number, y: number) => owner[Math.floor(y * sy) * ow + Math.floor(x * sx)];
  for (let py = 0; py < ph; py++) {
    const ty = Math.min(MAP_H - 1, Math.floor(vp.y0 + ((py + 0.5) / ph) * vp.h));
    for (let px = 0; px < pw; px++) {
      const tx = (((Math.floor(vp.x0 + ((px + 0.5) / pw) * vp.w)) % MAP_W) + MAP_W) % MAP_W;
      const t = ty * MAP_W + tx;
      const cls = world.terrain[t] & TERRAIN_CLASS_MASK;
      let r: number, g: number, b: number;
      if (cls === TerrainClass.Ocean || cls === TerrainClass.Lake) {
        r = 10; g = 24; b = 44;
      } else if (cls === TerrainClass.Ice) {
        r = 190; g = 200; b = 210;
      } else {
        const e = Math.max(0, world.elevation[t]) / 4000;
        const shade = cls === TerrainClass.Mountains ? 0.72 : cls === TerrainClass.Hills ? 0.86 : 1;
        r = (66 + 60 * e) * shade; g = (74 + 40 * e) * shade; b = (58 + 30 * e) * shade;
      }
      const o = own(tx, ty);
      if (o > 0 && colors[o]) {
        const c = colors[o];
        // Border tiles are drawn brighter so nation outlines read clearly.
        const edge = own((tx + MAP_W - 1) % MAP_W, ty) !== o || own((tx + 1) % MAP_W, ty) !== o
          || (ty > 0 && own(tx, ty - 1) !== o) || (ty < MAP_H - 1 && own(tx, ty + 1) !== o);
        const k = edge ? 0.95 : 0.62;
        const lift = edge ? 30 : 0;
        r = r * (1 - k) + c[0] * k + lift;
        g = g * (1 - k) + c[1] * k + lift;
        b = b * (1 - k) + c[2] * k + lift;
      }
      const i = (py * pw + px) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return img;
}

function drawMap(ctx: GameContext, g: CanvasRenderingContext2D, vp: Viewport, X: number, Y: number, W: number, H: number): void {
  const view = ctx.sim.view;
  g.putImageData(territoryImage(ctx, vp, Math.round(W), Math.round(H)), X, Y);
  const k = W / vp.w;
  const px = (x: number) => X + ((((x - vp.x0) % MAP_W) + MAP_W) % MAP_W) * k;
  const py = (y: number) => Y + (y - vp.y0) * k;
  const inside = (x: number, y: number) => {
    const a = px(x), b = py(y);
    return a >= X - 20 && a <= X + W + 20 && b >= Y - 20 && b <= Y + H + 20;
  };
  g.save();
  g.beginPath();
  g.rect(X, Y, W, H);
  g.clip();
  // Fallout scars.
  for (const s of view.scars) {
    if (!inside(s.x, s.y)) continue;
    const grad = g.createRadialGradient(px(s.x), py(s.y), 0, px(s.x), py(s.y), s.radius * k);
    grad.addColorStop(0, `rgba(170,255,60,${0.45 * s.strength})`);
    grad.addColorStop(0.6, `rgba(120,220,40,${0.18 * s.strength})`);
    grad.addColorStop(1, 'rgba(120,220,40,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(px(s.x), py(s.y), s.radius * k, 0, Math.PI * 2);
    g.fill();
  }
  // Active world events.
  for (const e of view.worldEvents) {
    if (e.radius <= 0 || !inside(e.x, e.y)) continue;
    g.strokeStyle = 'rgba(120,200,255,0.8)';
    g.setLineDash([6, 4]);
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(px(e.x), py(e.y), e.radius * k, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#bfe4ff';
    g.font = '600 12px monospace';
    g.textAlign = 'center';
    g.fillText(e.kind.toUpperCase(), px(e.x), py(e.y) - e.radius * k - 6);
  }
  // Fronts: glowing polylines, hotter = brighter.
  for (const f of view.fronts) {
    const s = f.samples;
    if (s.length < 4) continue;
    g.strokeStyle = `rgba(255,${Math.round(210 - 160 * f.intensity)},60,${0.6 + 0.4 * f.intensity})`;
    g.lineWidth = Math.max(1.5, k * 0.8);
    g.shadowColor = 'rgba(255,120,40,0.9)';
    g.shadowBlur = 10 * f.intensity;
    g.beginPath();
    for (let i = 0; i < s.length; i += 2) {
      const a = px(s[i]), b = py(s[i + 1]);
      if (i === 0 || Math.abs(s[i] - s[i - 2]) > 6 || Math.abs(s[i + 1] - s[i - 1]) > 6) g.moveTo(a, b);
      else g.lineTo(a, b);
    }
    g.stroke();
    if (inside(f.x, f.y)) {
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,235,170,0.95)';
      const ax = px(f.x), ay = py(f.y);
      g.beginPath();
      g.moveTo(ax + f.dirX * 10, ay + f.dirY * 10);
      g.lineTo(ax - f.dirY * 4.5, ay + f.dirX * 4.5);
      g.lineTo(ax + f.dirY * 4.5, ay - f.dirX * 4.5);
      g.fill();
    }
  }
  g.shadowBlur = 0;
  // Structures.
  const glyph = Math.max(8, Math.min(12, k * 2.2));
  g.font = `bold ${glyph}px monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const s of view.structures.values()) {
    const x = (s.tile % MAP_W) + 0.5, y = Math.floor(s.tile / MAP_W) + 0.5;
    if (!inside(x, y)) continue;
    const p = view.players[s.owner];
    const r = Math.max(3.5, Math.min(8, k * 1.2));
    g.fillStyle = 'rgba(8,10,14,0.85)';
    g.strokeStyle = p ? css(p.color) : '#fff';
    g.lineWidth = 1.4;
    g.beginPath();
    g.rect(px(x) - r, py(y) - r, r * 2, r * 2);
    g.fill();
    g.stroke();
    if (r >= 5) {
      g.fillStyle = s.built < 1 ? '#888' : '#fff';
      g.fillText(STRUCT_GLYPH[s.type] ?? '?', px(x), py(y) + 0.5);
    }
  }
  // Units.
  for (const u of view.units.values()) {
    if (!inside(u.x, u.y)) continue;
    const p = view.players[u.owner];
    const col = p ? css(p.color) : '#fff';
    const x = px(u.x), y = py(u.y);
    if (u.type === UnitType.AtomBomb || u.type === UnitType.HydrogenBomb || u.type === UnitType.Mirv
      || u.type === UnitType.MirvWarhead || u.type === UnitType.CruiseMissile) {
      // Flight path from the launch point to the aim point.
      g.strokeStyle = 'rgba(255,90,60,0.85)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(px(u.originX), py(u.originY));
      g.lineTo(x, y);
      g.lineTo(px(u.targetX), py(u.targetY));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffdd55';
      g.beginPath();
      g.arc(x, y, u.type === UnitType.HydrogenBomb || u.type === UnitType.Mirv ? 5 : 3.5, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    g.save();
    g.translate(x, y);
    g.rotate(u.heading);
    switch (u.type) {
      case UnitType.Shell:
      case UnitType.SamInterceptor:
        g.fillStyle = u.type === UnitType.SamInterceptor ? '#7fe3ff' : '#ffffff';
        g.fillRect(-1, -4, 2, 8);
        break;
      case UnitType.Train:
        g.fillStyle = '#f5c542';
        g.fillRect(-2, -4, 4, 8);
        break;
      case UnitType.FighterSquadron:
      case UnitType.Bomber:
      case UnitType.DroneSwarm: {
        const s = u.type === UnitType.Bomber ? 1.3 : u.type === UnitType.DroneSwarm ? 0.8 : 1;
        g.fillStyle = col;
        g.strokeStyle = '#fff';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, -7 * s);
        g.lineTo(6 * s, 5 * s);
        g.lineTo(0, 2 * s);
        g.lineTo(-6 * s, 5 * s);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      }
      case UnitType.ArmoredDivision:
        g.fillStyle = col;
        g.strokeStyle = '#fff';
        g.lineWidth = 1.2;
        g.fillRect(-6, -4.5, 12, 9);
        g.strokeRect(-6, -4.5, 12, 9);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -9);
        g.stroke();
        break;
      default:
        // Ships.
        g.fillStyle = u.type === UnitType.TradeShip ? '#d9c38a' : col;
        g.strokeStyle = u.type === UnitType.Warship ? '#fff' : 'rgba(0,0,0,0.6)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, -7);
        g.lineTo(3.5, 5);
        g.lineTo(-3.5, 5);
        g.closePath();
        g.fill();
        g.stroke();
    }
    g.restore();
  }
  // Nation labels.
  g.textAlign = 'center';
  for (const p of view.playerList) {
    if (!p.alive || p.labelSize <= 0 || !inside(p.labelX, p.labelY)) continue;
    const size = Math.min(26, Math.max(8, p.labelSize * k * 0.2));
    if (size < 10 && p.kind === 'tribe') continue;
    const name = p.id === HUMAN_ID ? `★ ${p.name}` : p.name;
    g.font = `600 ${size}px sans-serif`;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.fillStyle = '#fff';
    g.strokeText(name, px(p.labelX), py(p.labelY));
    g.fillText(name, px(p.labelX), py(p.labelY));
    g.font = `${Math.max(8, size * 0.72)}px monospace`;
    g.strokeText(compact(p.troops), px(p.labelX), py(p.labelY) + size * 0.95);
    g.fillStyle = '#ffd98a';
    g.fillText(compact(p.troops), px(p.labelX), py(p.labelY) + size * 0.95);
  }
  g.restore();
  g.strokeStyle = 'rgba(120,180,255,0.35)';
  g.lineWidth = 1;
  g.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1);
}

function drawLeaderboard(ctx: GameContext, g: CanvasRenderingContext2D, X: number, Y: number, W: number, rows = 14): number {
  const view = ctx.sim.view;
  const land = view.world?.landTiles ?? 1;
  const list = view.playerList.filter((p) => p.alive && p.tiles > 0).sort((a, b) => b.tiles - a.tiles).slice(0, rows);
  const h = 40 + rows * 22;
  g.fillStyle = 'rgba(12,18,28,0.92)';
  g.fillRect(X, Y, W, h);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = '#9fd3ff';
  g.font = '600 12px monospace';
  g.fillText(`T+${(view.tick / 600).toFixed(1)} MIN · ${view.playerList.filter((p) => p.alive).length} ALIVE · ${view.attacks.length} ATTACKS · ${view.units.size} UNITS`, X + 10, Y + 16);
  g.font = '10px monospace';
  g.fillStyle = '#6f8aa6';
  g.textAlign = 'right';
  g.fillText('LAND', X + W - 150, Y + 32);
  g.fillText('TROOPS', X + W - 85, Y + 32);
  g.fillText('GOLD', X + W - 12, Y + 32);
  g.textAlign = 'left';
  list.forEach((p, i) => {
    const y = Y + 48 + i * 22;
    g.fillStyle = css(p.color);
    g.fillRect(X + 10, y - 7, 12, 14);
    g.fillStyle = p.id === HUMAN_ID ? '#ffe28a' : '#e8eef5';
    g.font = '12px sans-serif';
    g.fillText(p.name.slice(0, 22), X + 30, y);
    g.font = '12px monospace';
    g.textAlign = 'right';
    g.fillStyle = '#b8c7d9';
    g.fillText(`${((100 * p.tiles) / land).toFixed(1)}%`, X + W - 150, y);
    g.fillText(compact(p.troops), X + W - 85, y);
    g.fillStyle = '#f2c14e';
    g.fillText(compact(p.gold), X + W - 12, y);
    g.textAlign = 'left';
  });
  return h;
}

function drawGraph(ctx: GameContext, g: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number): void {
  const view = ctx.sim.view;
  const hist = view.history;
  const land = view.world?.landTiles ?? 1;
  g.fillStyle = 'rgba(12,18,28,0.92)';
  g.fillRect(X, Y, W, H);
  g.fillStyle = '#9fd3ff';
  g.font = '600 12px monospace';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(`TERRITORY OVER TIME (${hist.length} samples)`, X + 10, Y + 14);
  if (hist.length < 2) return;
  const top = view.playerList.filter((p) => p.alive).sort((a, b) => b.tiles - a.tiles).slice(0, 8);
  let maxShare = 0.05;
  for (const s of hist) for (const p of top) maxShare = Math.max(maxShare, (s.tiles[p.id] ?? 0) / land);
  const gx = X + 10, gy = Y + 28, gw = W - 20, gh = H - 38;
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    g.beginPath();
    g.moveTo(gx, gy + (gh * i) / 4);
    g.lineTo(gx + gw, gy + (gh * i) / 4);
    g.stroke();
  }
  const t0 = hist[0].tick, t1 = hist[hist.length - 1].tick;
  for (const p of top) {
    g.strokeStyle = css(p.color);
    g.lineWidth = p.id === HUMAN_ID ? 2.5 : 1.6;
    g.beginPath();
    hist.forEach((s, i) => {
      const x = gx + ((s.tick - t0) / Math.max(1, t1 - t0)) * gw;
      const y = gy + gh - ((s.tiles[p.id] ?? 0) / land / maxShare) * gh;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }
}

async function stageWorld(ctx: GameContext, ticks: number): Promise<void> {
  await ctx.app.startScriptedGame({ ticks, speed: 0, seed: 1337, aiCount: 24, tribeCount: 40 });
}

registerShot('sim-map', 'sim-core', '2D war-room plot of the whole simulated world (~5 game minutes in)', async ({ ctx, waitFrames, params }) => {
  await stageWorld(ctx, Number(params.get('tick') ?? 3000));
  await waitFrames(5);
  const { canvas, g } = overlay();
  const W = canvas.width, H = canvas.height;
  const mapW = W - 360;
  drawMap(ctx, g, { x0: 0, y0: 0, w: MAP_W, h: MAP_H }, 10, 10, mapW, Math.min(Math.round(mapW / 2), H - 20));
  const lh = drawLeaderboard(ctx, g, W - 340, 10, 330);
  drawGraph(ctx, g, W - 340, 20 + lh, 330, Math.max(120, H - 30 - lh));
});

registerShot('sim-europe', 'sim-core', 'Close 2D plot of Europe: borders, fronts, units, structures', async ({ ctx, waitFrames, params }) => {
  await stageWorld(ctx, Number(params.get('tick') ?? 3000));
  await waitFrames(5);
  const { canvas, g } = overlay();
  const W = canvas.width, H = canvas.height;
  const x0 = ((-12 + 180) / 360) * MAP_W, y0 = ((90 - 62) / 180) * MAP_H;
  const w = (46 / 360) * MAP_W;
  drawMap(ctx, g, { x0, y0, w, h: w * (H / W) }, 0, 0, W, H);
  drawLeaderboard(ctx, g, W - 340, 10, 330, 10);
});

registerShot('sim-war', 'sim-core', 'Staged total war over western Europe: nukes, MIRV, SAMs, aircraft, navies, armor (2D plot)', async ({ ctx, waitFrames, wait, params }) => {
  await stageWorld(ctx, 3000);
  const T = (lat: number, lon: number) => latLonToTile(lat, lon);
  const view = ctx.sim.view;
  const paris = T(48.86, 2.35);
  // A fixed two-nation theatre (whatever the AI did before): the enemy holds France, we hold Iberia.
  const enemy = view.playerList.find((p) => p.alive && p.kind === 'nation')?.id ?? 2;
  const dbg = (a: Parameters<typeof ctx.sim.debug>[0]) => ctx.sim.debug(a);
  dbg({ type: 'conquer', playerId: enemy, centerTile: T(48.3, 4.0), radius: 30 });
  dbg({ type: 'conquer', playerId: HUMAN_ID, centerTile: T(40.4, -3.7), radius: 24 });
  dbg({ type: 'addGold', playerId: HUMAN_ID, amount: 200_000_000 });
  dbg({ type: 'addTroops', playerId: HUMAN_ID, amount: 600_000 });
  dbg({ type: 'addTroops', playerId: enemy, amount: 900_000 });
  dbg({ type: 'spawnStructure', structure: StructureType.MissileSilo, owner: HUMAN_ID, tile: T(40.0, -4.5), level: 3 });
  dbg({ type: 'spawnStructure', structure: StructureType.Airbase, owner: HUMAN_ID, tile: T(41.2, -2.0), level: 3 });
  dbg({ type: 'spawnStructure', structure: StructureType.City, owner: HUMAN_ID, tile: T(40.4, -3.7), level: 5 });
  dbg({ type: 'spawnStructure', structure: StructureType.Port, owner: HUMAN_ID, tile: T(43.4, -3.8), level: 2 });
  dbg({ type: 'spawnStructure', structure: StructureType.SamSite, owner: enemy, tile: T(48.3, 3.0), level: 3 });
  dbg({ type: 'spawnStructure', structure: StructureType.Radar, owner: enemy, tile: T(47.8, 1.0), level: 1 });
  dbg({ type: 'spawnStructure', structure: StructureType.City, owner: enemy, tile: paris, level: 4 });
  dbg({ type: 'spawnStructure', structure: StructureType.Airbase, owner: enemy, tile: T(47.2, 0.5), level: 2 });
  dbg({ type: 'spawnStructure', structure: StructureType.DefensePost, owner: enemy, tile: T(44.8, 0.0), level: 2 });
  dbg({ type: 'spawnStructure', structure: StructureType.Factory, owner: enemy, tile: T(46.2, 1.0), level: 2 });
  dbg({ type: 'launchNuke', weapon: UnitType.HydrogenBomb, owner: HUMAN_ID, fromTile: T(40.0, -4.5), targetTile: T(49.6, 7.2) });
  dbg({ type: 'launchNuke', weapon: UnitType.AtomBomb, owner: enemy, fromTile: paris, targetTile: T(41.5, 1.5) });
  dbg({ type: 'launchNuke', weapon: UnitType.AtomBomb, owner: HUMAN_ID, fromTile: T(40.0, -4.5), targetTile: T(48.8, 2.4) });
  dbg({ type: 'launchNuke', weapon: UnitType.CruiseMissile, owner: HUMAN_ID, fromTile: T(40.0, -4.5), targetTile: T(47.8, 1.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.Bomber, owner: HUMAN_ID, tile: T(41.2, -2.0), targetTile: T(46.2, 1.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.DroneSwarm, owner: HUMAN_ID, tile: T(41.2, -2.0), targetTile: T(45.8, 3.5) });
  dbg({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: enemy, tile: T(47.2, 0.5), targetTile: T(45.0, -0.5) });
  dbg({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: HUMAN_ID, tile: T(41.2, -2.0), targetTile: T(44.0, -1.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.Warship, owner: HUMAN_ID, tile: T(44.0, -4.0), targetTile: T(45.8, -2.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.Warship, owner: HUMAN_ID, tile: T(44.2, -6.5), targetTile: T(46.8, -3.5) });
  dbg({ type: 'spawnUnit', unit: UnitType.Warship, owner: enemy, tile: T(47.3, -3.5), targetTile: T(45.0, -3.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.TradeShip, owner: HUMAN_ID, tile: T(43.8, -8.5), targetTile: T(50.0, -5.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile: T(42.6, -1.8), targetTile: T(44.8, 0.0) });
  dbg({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile: T(42.3, 1.2), targetTile: T(44.5, 2.5) });
  // v2: offensives need a declared war (staged without mobilization).
  dbg({ type: 'war', a: HUMAN_ID, b: enemy });
  ctx.sim.send({ type: 'attack', target: enemy, ratio: 0.35, tile: T(45.0, 1.0) });
  // Let the exchange play out (flight times are ~6-9 s of game time), then freeze with the MIRV in the air.
  ctx.sim.setSpeed(4);
  await wait(Number(params.get('ms') ?? 3500));
  dbg({ type: 'launchNuke', weapon: UnitType.Mirv, owner: HUMAN_ID, fromTile: T(40.0, -4.5), targetTile: T(47.5, 3.5) });
  await wait(Number(params.get('ms2') ?? 2600));
  ctx.sim.setSpeed(0);
  await waitFrames(5);
  const { canvas, g } = overlay();
  const W = canvas.width, H = canvas.height;
  const x0 = ((-14 + 180) / 360) * MAP_W, y0 = ((90 - 56) / 180) * MAP_H;
  const w = (34 / 360) * MAP_W;
  drawMap(ctx, g, { x0, y0, w, h: w * (H / W) }, 0, 0, W, H);
  drawLeaderboard(ctx, g, W - 340, 10, 330, 8);
});

registerShot('sim-timelapse', 'sim-core', 'Timelapse frames + territory graph recorded by the sim client (end-screen data)', async ({ ctx, waitFrames, params }) => {
  await stageWorld(ctx, Number(params.get('tick') ?? 6000));
  await waitFrames(5);
  const { canvas, g } = overlay();
  const W = canvas.width, H = canvas.height;
  const tl = ctx.sim.view.timelapse;
  const n = tl.frameCount;
  const cols = 4, rows = 2;
  const cw = Math.floor((W - 30) / cols), ch = Math.floor(cw / 2);
  const buf = new Uint16Array(tl.width * tl.height);
  for (let i = 0; i < cols * rows && n > 0; i++) {
    const f = Math.round((i / (cols * rows - 1)) * (n - 1));
    tl.decode(f, buf);
    const img = territoryImage(ctx, { x0: 0, y0: 0, w: MAP_W, h: MAP_H }, cw, ch, buf, tl.width, tl.height);
    const x = 10 + (i % cols) * (cw + 3), y = 10 + Math.floor(i / cols) * (ch + 22);
    g.putImageData(img, x, y);
    g.fillStyle = '#9fd3ff';
    g.font = '12px monospace';
    g.textAlign = 'left';
    g.fillText(`frame ${f + 1}/${n} · ${(tl.frameTick(f) / 600).toFixed(1)} min`, x + 4, y + ch + 12);
  }
  const gy = 20 + rows * (ch + 22);
  drawGraph(ctx, g, 10, gy, W - 360, H - gy - 10);
  drawLeaderboard(ctx, g, W - 340, gy, 330, Math.max(4, Math.floor((H - gy - 54) / 22)));
});
