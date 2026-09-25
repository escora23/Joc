// FRONT ULTRA — sim-ai shots (owner: sim-ai). Main thread only (imported by src/app/shots.ts, never by the worker).
//
// The AI and the world events are judged on their own here, independent of how the globe renders them:
//   ?shot=ai-world       2D "war room" ~12 game minutes into a 40-nation game: territories, alliances (green arcs),
//                        wars (red arrows sized by troops), naval invasions, nukes in flight, fallout, active world
//                        events; leaderboard with personalities and allies, personality mix, doomsday clock.
//                        &tick=N picks another moment, &difficulty=easy|normal|hard|insane.
//   ?shot=world-events   every world event staged at once on a 2D map (hurricane track, earthquake, rebellion,
//                        gold rush, pandemic, doomsday) with the breaking-news headlines they produced.
//   ?shot=event-earthquake / event-rebellion / event-doomsday
//                        the real game view with the HUD, camera on the event, breaking-news ticker and HUD clock.

import { HUMAN_ID, MAP_H, MAP_W } from '../../shared/constants';
import type { GameContext } from '../../shared/api';
import { latLonToTile, tileToLatLon, worldTimeForSubsolarLon } from '../../shared/geo';
import { countryName, formatCompact, playerName, registerDictionary, t } from '../../shared/i18n';
import { registerShot, type ShotContext } from '../../shared/shots';
import type { SimEvent } from '../../shared/protocol';
import { TERRAIN_CLASS_MASK, TerrainClass, UnitType, type Difficulty, type PlayerView, type WorldEventKind } from '../../shared/types';

registerDictionary('es', {
  'ai.room.title': 'Sala de guerra · IA',
  'ai.room.minute': 'T+{m} min',
  'ai.room.alive': '{n} naciones vivas',
  'ai.room.wars': '{n} frentes activos',
  'ai.room.alliances': '{n} alianzas',
  'ai.room.personalities': 'Doctrinas',
  'ai.room.doomsday': 'Reloj del Apocalipsis',
  'ai.room.midnight': '{m} min para la medianoche',
  'ai.room.inactive': 'detenido',
  'ai.room.headlines': 'Titulares',
  'ai.room.legend': 'Alianza · Guerra · Invasión naval · Misil nuclear · Lluvia radiactiva',
  'ai.room.events': 'Eventos mundiales en curso',
  'ai.room.land': 'Tierra',
  'ai.room.troops': 'Tropas',
  'ai.room.allies': 'Aliados',
  'ai.room.traitor': 'traidor',
  'ai.event.earthquake': 'Terremoto M{m}',
  'ai.event.hurricane': 'Huracán cat. {m}',
  'ai.event.rebellion': 'Rebelión',
  'ai.event.goldRush': 'Fiebre del oro',
  'ai.event.pandemic': 'Pandemia · {m} naciones',
  'ai.event.doomsday': 'Reloj del Apocalipsis',
});
registerDictionary('en', {
  'ai.room.title': 'War room · AI',
  'ai.room.minute': 'T+{m} min',
  'ai.room.alive': '{n} nations alive',
  'ai.room.wars': '{n} active fronts',
  'ai.room.alliances': '{n} alliances',
  'ai.room.personalities': 'Doctrines',
  'ai.room.doomsday': 'Doomsday Clock',
  'ai.room.midnight': '{m} min to midnight',
  'ai.room.inactive': 'stopped',
  'ai.room.headlines': 'Headlines',
  'ai.room.legend': 'Alliance · War · Naval invasion · Nuclear missile · Fallout',
  'ai.room.events': 'World events in progress',
  'ai.room.land': 'Land',
  'ai.room.troops': 'Troops',
  'ai.room.allies': 'Allies',
  'ai.room.traitor': 'traitor',
  'ai.event.earthquake': 'Earthquake M{m}',
  'ai.event.hurricane': 'Hurricane cat. {m}',
  'ai.event.rebellion': 'Rebellion',
  'ai.event.goldRush': 'Gold rush',
  'ai.event.pandemic': 'Pandemic · {m} nations',
  'ai.event.doomsday': 'Doomsday Clock',
});

// =================================================================================================
// Drawing helpers
// =================================================================================================

const FONT = '"Barlow Condensed", "Rajdhani", sans-serif';
const MONO = '"JetBrains Mono", monospace';
const PERSONA_COLOR: Record<string, string> = {
  conqueror: '#ff6b57', turtle: '#57c7ff', trader: '#ffd166', nuker: '#b388ff', opportunist: '#7ee081',
};
const PERSONA_TAG: Record<string, string> = { conqueror: 'CQ', turtle: 'TU', trader: 'TR', nuker: 'NK', opportunist: 'OP' };
/** Latitude window of the map (Antarctica is not playable). */
const LAT_TOP = 80, LAT_BOTTOM = -58;

interface MapBox {
  X: number;
  Y: number;
  W: number;
  H: number;
}

function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

function overlay(): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  document.getElementById('ai-shot-overlay')?.remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'ai-shot-overlay';
  const dpr = 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  Object.assign(canvas.style, { position: 'fixed', inset: '0', zIndex: '600', width: '100%', height: '100%', background: '#04070c' });
  document.body.appendChild(canvas);
  return { canvas, g: canvas.getContext('2d')! };
}

const y0Tile = ((90 - LAT_TOP) / 180) * MAP_H;
const hTiles = ((LAT_TOP - LAT_BOTTOM) / 180) * MAP_H;

function project(box: MapBox, x: number, y: number): [number, number] {
  return [box.X + (x / MAP_W) * box.W, box.Y + ((y - y0Tile) / hTiles) * box.H];
}

function terrainAndTerritory(ctx: GameContext, box: MapBox): ImageData {
  const view = ctx.sim.view;
  const world = view.world!;
  const pw = Math.round(box.W), ph = Math.round(box.H);
  const img = new ImageData(pw, ph);
  const d = img.data;
  const colors: number[] = [];
  for (const p of view.playerList) colors[p.id] = p.color;
  const owner = view.owner;
  for (let py = 0; py < ph; py++) {
    const ty = Math.min(MAP_H - 1, Math.floor(y0Tile + ((py + 0.5) / ph) * hTiles));
    for (let px = 0; px < pw; px++) {
      const tx = Math.min(MAP_W - 1, Math.floor(((px + 0.5) / pw) * MAP_W));
      const t = ty * MAP_W + tx;
      const cls = world.terrain[t] & TERRAIN_CLASS_MASK;
      let r: number, g: number, b: number;
      if (cls === TerrainClass.Ocean || cls === TerrainClass.Lake) {
        // Deep navy with a faint graticule.
        const grid = tx % 67 === 0 || ty % 67 === 0 ? 8 : 0;
        r = 7 + grid; g = 17 + grid; b = 32 + grid * 1.5;
      } else if (cls === TerrainClass.Ice) {
        r = 150; g = 162; b = 176;
      } else {
        const e = Math.min(1, Math.max(0, world.elevation[t]) / 3500);
        r = 44 + 50 * e; g = 52 + 38 * e; b = 44 + 26 * e;
      }
      const o = owner[t];
      if (o > 0 && colors[o] !== undefined) {
        const c = colors[o];
        const cr = (c >> 16) & 255, cg = (c >> 8) & 255, cb = c & 255;
        const left = owner[ty * MAP_W + ((tx + MAP_W - 1) % MAP_W)], right = owner[ty * MAP_W + ((tx + 1) % MAP_W)];
        const up = ty > 0 ? owner[t - MAP_W] : o, down = ty < MAP_H - 1 ? owner[t + MAP_W] : o;
        const edge = left !== o || right !== o || up !== o || down !== o;
        const k = edge ? 1 : 0.62;
        r = r * (1 - k) + cr * k + (edge ? 40 : 0);
        g = g * (1 - k) + cg * k + (edge ? 40 : 0);
        b = b * (1 - k) + cb * k + (edge ? 40 : 0);
      }
      const i = (py * pw + px) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return img;
}

function arrow(g: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, color: string, width: number, bend: number): void {
  const mx = (ax + bx) / 2 - (by - ay) * bend, my = (ay + by) / 2 + (bx - ax) * bend;
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(ax, ay);
  g.quadraticCurveTo(mx, my, bx, by);
  g.stroke();
  const ang = Math.atan2(by - my, bx - mx);
  const s = 5 + width * 1.6;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(bx, by);
  g.lineTo(bx - Math.cos(ang - 0.45) * s, by - Math.sin(ang - 0.45) * s);
  g.lineTo(bx - Math.cos(ang + 0.45) * s, by - Math.sin(ang + 0.45) * s);
  g.closePath();
  g.fill();
}

/** Short screen distance between two label anchors, taking the wrap-around into account. */
function unwrapPair(box: MapBox, a: [number, number], b: [number, number]): [number, number] {
  let bx = b[0];
  if (bx - a[0] > box.W / 2) bx -= box.W;
  if (a[0] - bx > box.W / 2) bx += box.W;
  return [bx, b[1]];
}

function eventIcon(g: CanvasRenderingContext2D, kind: WorldEventKind, x: number, y: number, r: number, heading: number, progress: number): void {
  g.save();
  switch (kind) {
    case 'hurricane': {
      // Spiral bands around a calm eye.
      g.translate(x, y);
      for (let arm = 0; arm < 3; arm++) {
        g.strokeStyle = `rgba(210,235,255,${0.75 - arm * 0.12})`;
        g.lineWidth = 3 - arm * 0.6;
        g.beginPath();
        for (let k = 0; k <= 40; k++) {
          const a = arm * ((Math.PI * 2) / 3) + k * 0.16 + progress * 20;
          const rr = r * (0.15 + k / 46);
          const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
          if (k === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.stroke();
      }
      g.fillStyle = 'rgba(20,40,70,0.9)';
      g.beginPath();
      g.arc(0, 0, r * 0.14, 0, Math.PI * 2);
      g.fill();
      // Heading.
      g.strokeStyle = 'rgba(160,210,255,0.9)';
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.sin(heading) * r * 2.2, -Math.cos(heading) * r * 2.2);
      g.stroke();
      break;
    }
    case 'earthquake': {
      for (let k = 1; k <= 4; k++) {
        g.strokeStyle = `rgba(255,160,70,${0.95 - k * 0.2})`;
        g.lineWidth = 2.5 - k * 0.4;
        g.beginPath();
        g.arc(x, y, (r * k) / 4, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = '#ffb347';
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'goldRush': {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,215,90,0.55)');
      grad.addColorStop(1, 'rgba(255,200,60,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,214,102,0.95)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
      break;
    }
    case 'pandemic': {
      g.strokeStyle = 'rgba(190,120,255,0.9)';
      g.setLineDash([7, 5]);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(170,90,255,0.12)';
      g.fill();
      break;
    }
    case 'rebellion': {
      g.strokeStyle = 'rgba(255,70,70,0.95)';
      g.lineWidth = 2.5;
      g.setLineDash([3, 4]);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
      break;
    }
    default:
      break;
  }
  g.restore();
}

function eventLabel(kind: WorldEventKind, magnitude: number): string {
  const m = kind === 'earthquake' ? magnitude.toFixed(1) : String(Math.max(1, Math.round(magnitude)));
  return t(`ai.event.${kind}`, { m });
}

function drawMap(ctx: GameContext, g: CanvasRenderingContext2D, box: MapBox): void {
  const view = ctx.sim.view;
  const world = view.world!;
  g.putImageData(terrainAndTerritory(ctx, box), box.X, box.Y);
  g.save();
  g.beginPath();
  g.rect(box.X, box.Y, box.W, box.H);
  g.clip();
  const k = box.W / MAP_W;
  const anchor = (p: PlayerView): [number, number] => project(box, p.labelX, p.labelY);

  // Fallout.
  for (const s of view.scars) {
    const [x, y] = project(box, s.x, s.y);
    const r = Math.max(4, s.radius * k * 1.1);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(200,255,80,${0.6 * s.strength})`);
    grad.addColorStop(0.5, `rgba(140,230,50,${0.25 * s.strength})`);
    grad.addColorStop(1, 'rgba(120,220,40,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  // Alliances: green arcs between capitals.
  g.lineCap = 'round';
  for (const a of view.alliances) {
    const pa = view.players[a.a], pb = view.players[a.b];
    if (!pa || !pb || !pa.alive || !pb.alive || pa.labelSize <= 0 || pb.labelSize <= 0) continue;
    const A = anchor(pa), B = unwrapPair(box, A, anchor(pb));
    g.shadowColor = 'rgba(95,224,160,0.9)';
    g.shadowBlur = 8;
    g.strokeStyle = 'rgba(95,224,160,0.85)';
    g.lineWidth = 2;
    g.setLineDash([2, 5]);
    g.beginPath();
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2 - Math.hypot(B[0] - A[0], B[1] - A[1]) * 0.18;
    g.moveTo(A[0], A[1]);
    g.quadraticCurveTo(mx, my, B[0], B[1]);
    g.stroke();
    g.setLineDash([]);
  }
  g.shadowBlur = 0;

  // Wars: one arrow per attacker -> defender pair, thickness by committed troops.
  const pairs = new Map<string, { a: number; d: number; troops: number; naval: boolean }>();
  for (const at of view.attacks) {
    if (at.defender <= 0 || at.attacker <= 0) continue;
    const key = `${at.attacker}:${at.defender}:${at.naval ? 1 : 0}`;
    const rec = pairs.get(key) ?? { a: at.attacker, d: at.defender, troops: 0, naval: at.naval };
    rec.troops += at.troops;
    pairs.set(key, rec);
  }
  for (const w of pairs.values()) {
    const pa = view.players[w.a], pd = view.players[w.d];
    if (!pa || !pd || pa.labelSize <= 0 || pd.labelSize <= 0) continue;
    const A = anchor(pa), B = unwrapPair(box, A, anchor(pd));
    const width = Math.max(1.5, Math.min(7, Math.log10(Math.max(10, w.troops)) - 2.5) * 1.6);
    g.shadowColor = 'rgba(255,80,60,0.9)';
    g.shadowBlur = 10;
    if (w.naval) g.setLineDash([6, 5]);
    arrow(g, A[0], A[1], B[0], B[1], w.naval ? 'rgba(90,200,255,0.95)' : 'rgba(255,86,64,0.95)', width, 0.12);
    g.setLineDash([]);
  }
  g.shadowBlur = 0;

  // Transports at sea and nukes in flight.
  for (const u of view.units.values()) {
    const [x, y] = project(box, u.x, u.y);
    if (u.type === UnitType.TransportShip) {
      const p = view.players[u.owner];
      g.fillStyle = p ? rgba(p.color, 1) : '#fff';
      g.strokeStyle = '#dff6ff';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, 3.2, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      const [tx2, ty2] = project(box, u.targetX, u.targetY);
      g.strokeStyle = 'rgba(90,200,255,0.55)';
      g.setLineDash([3, 4]);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(tx2, ty2);
      g.stroke();
      g.setLineDash([]);
    } else if (u.type === UnitType.AtomBomb || u.type === UnitType.HydrogenBomb || u.type === UnitType.Mirv || u.type === UnitType.MirvWarhead) {
      const [ox, oy] = project(box, u.originX, u.originY);
      const [tx2, ty2] = project(box, u.targetX, u.targetY);
      g.strokeStyle = 'rgba(255,190,70,0.9)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(ox, oy);
      g.quadraticCurveTo((ox + tx2) / 2, Math.min(oy, ty2) - 40, tx2, ty2);
      g.stroke();
      g.fillStyle = '#fff3c4';
      g.shadowColor = '#ffb020';
      g.shadowBlur = 12;
      g.beginPath();
      g.arc(x, y, u.type === UnitType.AtomBomb ? 3 : 4.5, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }
  }

  // World events.
  for (const e of view.worldEvents) {
    if (e.radius <= 0) continue;
    const [x, y] = project(box, e.x, e.y);
    const r = Math.max(8, e.radius * k);
    eventIcon(g, e.kind, x, y, r, e.heading, e.progress);
    g.font = `600 13px ${FONT}`;
    g.textAlign = 'center';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    const label = eventLabel(e.kind, e.magnitude).toUpperCase();
    g.strokeText(label, x, y - r - 6);
    g.fillStyle = e.kind === 'goldRush' ? '#ffd666' : e.kind === 'pandemic' ? '#d6b0ff' : e.kind === 'rebellion' ? '#ff8a8a' : e.kind === 'earthquake' ? '#ffc070' : '#cfe8ff';
    g.fillText(label, x, y - r - 6);
  }

  // Nation labels with doctrine tags.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const sorted = view.playerList.filter((p) => p.alive && p.labelSize > 0 && p.kind !== 'tribe').sort((a, b) => b.tiles - a.tiles);
  for (const p of sorted) {
    const [x, y] = anchor(p);
    const size = Math.min(24, Math.max(10, Math.sqrt(p.tiles) * k * 0.55));
    if (size < 11 && p.tiles < 400) continue;
    const name = p.id === HUMAN_ID ? `★ ${p.name}` : playerName(p, world);
    g.font = `700 ${size}px ${FONT}`;
    g.lineWidth = 3.5;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText(name.toUpperCase(), x, y);
    g.fillStyle = '#fff';
    g.fillText(name.toUpperCase(), x, y);
    const tag = p.personality ? PERSONA_TAG[p.personality] : p.kind === 'rebel' ? 'RB' : 'YOU';
    const tagCol = p.personality ? PERSONA_COLOR[p.personality] : p.kind === 'rebel' ? '#ff5a5a' : '#ffe28a';
    g.font = `600 ${Math.max(9, size * 0.62)}px ${MONO}`;
    const line2 = `${tag} · ${formatCompact(p.troops)}`;
    g.strokeText(line2, x, y + size * 0.95);
    g.fillStyle = tagCol;
    g.fillText(line2, x, y + size * 0.95);
  }
  g.restore();
  g.strokeStyle = 'rgba(120,180,255,0.3)';
  g.lineWidth = 1;
  g.strokeRect(box.X + 0.5, box.Y + 0.5, box.W - 1, box.H - 1);
}

function panel(g: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, title: string): void {
  g.fillStyle = 'rgba(10,16,26,0.94)';
  g.fillRect(X, Y, W, H);
  g.strokeStyle = 'rgba(110,170,255,0.25)';
  g.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1);
  g.fillStyle = '#6fb6ff';
  g.fillRect(X, Y, 3, 22);
  g.font = `700 14px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = '#9fd3ff';
  g.fillText(title.toUpperCase(), X + 12, Y + 12);
}

function drawSidebar(ctx: GameContext, g: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number): void {
  const view = ctx.sim.view;
  const world = view.world!;
  const land = world.landTiles;
  const alive = view.playerList.filter((p) => p.alive && p.spawned && p.tiles > 0);
  const majors = alive.filter((p) => p.kind === 'nation' || p.kind === 'human' || p.kind === 'rebel');
  let y = Y;
  // Header.
  panel(g, X, y, W, 62, t('ai.room.title'));
  g.font = `500 12px ${MONO}`;
  g.fillStyle = '#c9d6e6';
  const fronts = new Set(view.attacks.filter((a) => a.defender > 0).map((a) => `${a.attacker}:${a.defender}`)).size;
  g.fillText(`${t('ai.room.minute', { m: (view.tick / 600).toFixed(1) })} · ${t('ai.room.alive', { n: majors.length })}`, X + 12, y + 34);
  g.fillText(`${t('ai.room.wars', { n: fronts })} · ${t('ai.room.alliances', { n: view.alliances.length })}`, X + 12, y + 50);
  y += 70;

  // Doctrines + doomsday.
  const docH = 104;
  const lbH = H - (y - Y) - docH - 8;
  const rows = Math.max(6, Math.floor((lbH - 44) / 21));
  panel(g, X, y, W, lbH, `${t('ai.room.land')} · ${t('ai.room.troops')} · ${t('ai.room.allies')}`);
  const top = majors.slice().sort((a, b) => b.tiles - a.tiles).slice(0, rows);
  top.forEach((p, i) => {
    const ry = y + 38 + i * 21;
    g.fillStyle = rgba(p.color, 1);
    g.fillRect(X + 12, ry - 6, 10, 12);
    g.font = `600 13px ${FONT}`;
    g.fillStyle = p.id === HUMAN_ID ? '#ffe28a' : p.kind === 'rebel' ? '#ff9a9a' : '#e8eef5';
    g.textAlign = 'left';
    const nm = (p.id === HUMAN_ID ? '★ ' + p.name : playerName(p, world)).slice(0, 19);
    g.fillText(nm, X + 28, ry);
    const tag = p.personality ? PERSONA_TAG[p.personality] : p.kind === 'rebel' ? 'RB' : '';
    g.font = `700 10px ${MONO}`;
    g.fillStyle = p.personality ? PERSONA_COLOR[p.personality] : '#ff5a5a';
    if (p.kind === 'rebel') g.fillStyle = '#ff5a5a';
    g.fillText(tag, X + 158, ry);
    if (p.traitorTicks > 0) {
      g.fillStyle = '#ff5a5a';
      g.fillText('✖', X + 180, ry);
    }
    g.font = `500 12px ${MONO}`;
    g.textAlign = 'right';
    g.fillStyle = '#b8c7d9';
    g.fillText(`${((100 * p.tiles) / land).toFixed(1)}%`, X + W - 108, ry);
    g.fillText(formatCompact(p.troops), X + W - 52, ry);
    // Allies as color chips.
    let ax = X + W - 12;
    for (const a of p.allies.slice(0, 3)) {
      const q = view.players[a];
      if (!q) continue;
      g.fillStyle = rgba(q.color, 1);
      g.fillRect(ax - 8, ry - 5, 8, 10);
      ax -= 11;
    }
    g.textAlign = 'left';
  });
  y += lbH + 8;

  panel(g, X, y, W, docH, `${t('ai.room.personalities')} · ${t('ai.room.doomsday')}`);
  const counts = new Map<string, number>();
  for (const p of majors) if (p.personality) counts.set(p.personality, (counts.get(p.personality) ?? 0) + 1);
  let px = X + 12, py = y + 36;
  g.font = `600 12px ${FONT}`;
  for (const k of ['conqueror', 'opportunist', 'trader', 'turtle', 'nuker']) {
    const label = `${t(`personality.${k}`)} ${counts.get(k) ?? 0}`;
    const w = g.measureText(label).width + 26;
    if (px + w > X + W - 8) {
      px = X + 12;
      py += 17;
    }
    g.fillStyle = PERSONA_COLOR[k];
    g.fillRect(px, py - 5, 9, 9);
    g.fillStyle = '#dbe6f2';
    g.fillText(label, px + 13, py);
    px += w;
  }
  const dd = view.doomsday;
  const barY = y + docH - 30;
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(X + 12, barY, W - 24, 9);
  const grad = g.createLinearGradient(X + 12, 0, X + W - 12, 0);
  grad.addColorStop(0, '#ffcc4d');
  grad.addColorStop(1, '#ff2d2d');
  g.fillStyle = grad;
  g.fillRect(X + 12, barY, (W - 24) * dd, 9);
  g.font = `600 12px ${MONO}`;
  g.fillStyle = dd > 0.75 ? '#ff6b6b' : '#ffd38a';
  g.fillText(dd > 0 ? t('ai.room.midnight', { m: ((1 - dd) * 12).toFixed(1) }) : t('ai.room.inactive'), X + 12, barY + 20);
}

/** Headlines (left) and the list of running world events (right) under the map. */
function drawBottom(ctx: GameContext, g: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, headlines: string[]): void {
  const view = ctx.sim.view;
  const evW = Math.round(W * 0.36);
  const hW = W - evW - 8;
  panel(g, X, Y, hW, H, t('ai.room.headlines'));
  g.font = `500 13px ${FONT}`;
  g.textAlign = 'left';
  const maxLines = Math.max(1, Math.floor((H - 40) / 19));
  let ly = Y + 38;
  for (const h of headlines.slice(-maxLines)) {
    g.fillStyle = '#ff4d4d';
    g.fillRect(X + 12, ly - 4, 4, 8);
    g.fillStyle = '#e6edf5';
    const max = Math.floor((hW - 40) / 6.2);
    g.fillText(h.length > max ? h.slice(0, max - 1) + '…' : h, X + 22, ly);
    ly += 19;
  }
  const ex = X + hW + 8;
  panel(g, ex, Y, evW, H, t('ai.room.events'));
  let ey = Y + 40;
  for (const e of view.worldEvents) {
    if (ey > Y + H - 16) break;
    g.font = `600 13px ${FONT}`;
    g.fillStyle = e.kind === 'goldRush' ? '#ffd666' : e.kind === 'pandemic' ? '#d6b0ff' : e.kind === 'rebellion' ? '#ff8a8a' : e.kind === 'earthquake' ? '#ffc070' : e.kind === 'doomsday' ? '#ff6b6b' : '#cfe8ff';
    const label = e.kind === 'doomsday' ? t('ai.event.doomsday') : eventLabel(e.kind, e.magnitude);
    g.fillText(label, ex + 12, ey);
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(ex + evW * 0.55, ey - 4, evW * 0.4, 7);
    g.fillStyle = 'rgba(160,210,255,0.8)';
    g.fillRect(ex + evW * 0.55, ey - 4, evW * 0.4 * Math.min(1, e.progress), 7);
    ey += 22;
  }
}

function drawLegend(g: CanvasRenderingContext2D, X: number, Y: number): void {
  g.font = `600 12px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const items: [string, boolean][] = [['#5fe0a0', true], ['#ff5640', false], ['#5ac8ff', true], ['#ffbe46', false], ['#b4ff50', false]];
  const names = t('ai.room.legend').split(' · ');
  let x = X;
  items.forEach(([c, dashed], i) => {
    g.strokeStyle = c;
    g.lineWidth = 3;
    if (dashed) g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(x, Y);
    g.lineTo(x + 22, Y);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#cfdbe8';
    const label = names[i] ?? '';
    g.fillText(label, x + 28, Y);
    x += 40 + g.measureText(label).width;
  });
}

// =================================================================================================
// Headlines (same wording as the HUD ticker)
// =================================================================================================

function newsText(ctx: GameContext, e: SimEvent): string | null {
  const view = ctx.sim.view;
  const world = view.world;
  const name = (id: number) => {
    const p = view.players[id];
    if (!p) return t('news.rebels');
    return id === HUMAN_ID ? t('news.you') : playerName(p, world);
  };
  const place = (tile: number) => {
    if (!world) return '';
    const c = world.countries[world.country[tile]];
    const n = countryName(c);
    if (n) return n;
    const o = view.owner[tile];
    return o ? name(o) : t('news.theOcean');
  };
  const minute = `${(e.tick / 600).toFixed(1)}′ `;
  switch (e.type) {
    case 'worldEvent': {
      if (e.stage === 'end' || e.kind === 'doomsday') return null;
      const tile = Math.floor(e.y) * MAP_W + Math.floor(e.x);
      const key = `news.event.${e.kind}${e.stage === 'warning' ? '.warning' : ''}`;
      return minute + t(key, { place: place(tile), a: e.players.length ? name(e.players[0]) : place(tile) });
    }
    case 'doomsday':
      return minute + t('news.doomsday', { m: Math.max(0, Math.round(e.minutesToMidnight)) });
    case 'allianceFormed':
      return minute + t('news.alliance', { a: name(e.a), b: name(e.b) });
    case 'allianceBroken':
      return minute + t('news.betrayal', { a: name(e.breaker), b: name(e.victim) });
    case 'nationEliminated': {
      const p = view.players[e.playerId];
      if (!p || (p.kind !== 'nation' && p.kind !== 'human')) return null;
      return minute + (e.by > 0 ? t('news.eliminatedBy', { a: name(e.playerId), b: name(e.by) }) : t('news.eliminated', { a: name(e.playerId) }));
    }
    case 'capitalCaptured':
      return minute + t('news.capitalCaptured', { a: name(e.by), b: name(e.playerId) });
    case 'nukeLaunched':
      if (e.weapon === UnitType.CruiseMissile) return null;
      return minute + t('news.launch', { a: name(e.owner), w: t(`news.art.${e.weapon === UnitType.HydrogenBomb ? 'hydrogenBomb' : e.weapon === UnitType.Mirv ? 'mirv' : 'atomBomb'}`), b: e.targetOwner ? name(e.targetOwner) : place(e.targetTile) });
    default:
      return null;
  }
}

function recordHeadlines(ctx: GameContext, out: string[]): () => void {
  const types: SimEvent['type'][] = ['worldEvent', 'doomsday', 'allianceFormed', 'allianceBroken', 'nationEliminated', 'capitalCaptured', 'nukeLaunched'];
  const offs = types.map((type) => ctx.bus.on(type as never, (e: SimEvent) => {
    const s = newsText(ctx, e);
    if (s && out[out.length - 1] !== s) out.push(s);
  }));
  return () => offs.forEach((f) => f());
}

// =================================================================================================
// Shots
// =================================================================================================

async function warRoom(s: ShotContext, headlines: string[]): Promise<void> {
  const { ctx } = s;
  await s.waitFrames(3);
  const { canvas, g } = overlay();
  const W = canvas.width, H = canvas.height;
  const side = Math.min(400, Math.round(W * 0.25));
  const mapW = W - side - 30;
  const mapH = Math.min(H - 200, Math.round((mapW * hTiles) / MAP_W));
  const box: MapBox = { X: 10, Y: 10, W: mapW, H: mapH };
  drawMap(ctx, g, box);
  drawLegend(g, 20, mapH + 26);
  drawBottom(ctx, g, 10, mapH + 44, mapW, H - mapH - 54, headlines);
  drawSidebar(ctx, g, W - side - 10, 10, side, H - 20);
}

registerShot('ai-world', 'sim-ai', 'AI war room ~12 min into a 40-nation game: alliances, wars, invasions, nukes, doctrines, doomsday', async (s) => {
  const { ctx, params } = s;
  const headlines: string[] = [];
  const off = recordHeadlines(ctx, headlines);
  await ctx.app.startScriptedGame({
    ticks: Number(params.get('tick') ?? 7200), speed: 0, seed: Number(params.get('seed') ?? 1337), aiCount: 40, tribeCount: 30,
    difficulty: (params.get('difficulty') as Difficulty | null) ?? 'hard', headStart: 0,
  });
  // A few more live-rate ticks so events that fast-forward filters out (nukes, world events) reach the headlines.
  ctx.sim.setSpeed(4);
  await s.wait(Number(params.get('ms') ?? 2500));
  ctx.sim.setSpeed(0);
  await s.wait(700);
  off();
  s.setUiVisible(false);
  await warRoom(s, headlines);
}, 5);

const T = (lat: number, lon: number) => latLonToTile(lat, lon);

/** The biggest non-human nation's heartland tile (for a rebellion that shows). */
function bigNationTile(ctx: GameContext): number {
  const p = ctx.sim.view.playerList.filter((q) => q.alive && q.kind === 'nation').sort((a, b) => b.tiles - a.tiles)[0];
  if (!p) return T(55, 60);
  // Far from the capital, inside the territory: walk from the label anchor away from the capital.
  const lx = Math.floor(p.labelX), ly = Math.floor(p.labelY);
  const cx = p.capitalTile % MAP_W, cy = Math.floor(p.capitalTile / MAP_W);
  for (let k = 1.6; k > 0; k -= 0.2) {
    const x = Math.round(lx + (lx - cx) * k), y = Math.round(ly + (ly - cy) * k);
    const tile = Math.max(0, Math.min(MAP_H - 1, y)) * MAP_W + ((x % MAP_W) + MAP_W) % MAP_W;
    if (ctx.sim.view.owner[tile] === p.id) return tile;
  }
  return ly * MAP_W + lx;
}

registerShot('world-events', 'sim-ai', 'Every world event at once on a 2D map (hurricane, earthquake, rebellion, gold rush, pandemic, doomsday) with headlines', async (s) => {
  const { ctx, params } = s;
  const headlines: string[] = [];
  await ctx.app.startScriptedGame({ ticks: Number(params.get('tick') ?? 6000), speed: 0, seed: 1337, aiCount: 40, tribeCount: 30, difficulty: 'hard', headStart: 0 });
  const off = recordHeadlines(ctx, headlines);
  const dbg = (kind: WorldEventKind, tile: number) => ctx.sim.debug({ type: 'worldEvent', kind, tile });
  dbg('hurricane', T(16.5, -52));
  dbg('earthquake', T(36.2, 138.5));
  dbg('goldRush', T(-26.2, 28.0));
  dbg('rebellion', bigNationTile(ctx));
  const pand = ctx.sim.view.playerList.filter((p) => p.alive && p.kind === 'nation' && p.capitalTile >= 0).sort((a, b) => b.tiles - a.tiles)[1];
  if (pand) dbg('pandemic', pand.capitalTile);
  dbg('doomsday', 0);
  await s.wait(900);
  // Let the storm travel and the outbreak spread (deterministic tick count).
  await ctx.sim.fastForward(Number(params.get('ff') ?? 420));
  await s.wait(300);
  off();
  s.setUiVisible(false);
  await warRoom(s, headlines);
}, 5);

// --- live game views ------------------------------------------------------------------------------
// The real game with the HUD: the event is forced, the world runs for a moment at 1x so the breaking-news ticker
// (which holds while paused) switches to it, then freezes. Daylight is placed over the event.

async function liveStart(s: ShotContext, lon: number): Promise<void> {
  await s.ctx.app.startScriptedGame({
    ticks: Number(s.params.get('tick') ?? 2400), speed: 0, seed: 1337, aiCount: 32, tribeCount: 24, difficulty: 'hard',
    worldTimeSec: worldTimeForSubsolarLon(lon + 25),
    // A passive player safe on an island (sea access: it cannot be encircled): no conquests of its own, so no
    // backlog of breaking news is queued ahead of the event.
    autopilot: false,
    humanSpawn: { lat: 64.9, lon: -18.6 },
  });
}

async function liveFinish(s: ShotContext, lat: number, lon: number, altitudeKm: number): Promise<void> {
  const { ctx } = s;
  ctx.cameraRig.setState({ lat, lon, altitudeKm, tilt: 0.32, heading: 0 });
  await s.wait(700);
  // The ticker only advances on unpaused frames (and frame dt is clamped): run a handful of frames at 1x.
  ctx.sim.setSpeed(1);
  await s.waitFrames(8);
  ctx.sim.setSpeed(0);
  ctx.cameraRig.setState({ lat, lon, altitudeKm, tilt: 0.32, heading: 0 });
  await s.waitFrames(10);
}

registerShot('event-earthquake', 'sim-ai', 'Live view: a major earthquake hits Japan (breaking news, camera on the epicentre)', async (s) => {
  await liveStart(s, 138.5);
  s.ctx.sim.debug({ type: 'worldEvent', kind: 'earthquake', tile: T(36.2, 138.5) });
  await liveFinish(s, 36.2, 138.5, 3200);
}, 20);

registerShot('event-doomsday', 'sim-ai', 'Live view: the Doomsday Clock two minutes to midnight (HUD clock + breaking news)', async (s) => {
  await liveStart(s, 10);
  s.ctx.sim.debug({ type: 'worldEvent', kind: 'doomsday', tile: 0 });
  await liveFinish(s, 42, 5, 9000);
}, 20);

registerShot('event-rebellion', 'sim-ai', 'Live view: a province of the dominant power in Central Asia rises in rebellion (new rebel state, breaking news)', async (s) => {
  const { ctx } = s;
  await liveStart(s, 62);
  // The nation holding most of the daylit region (lat 25..60, lon 35..95); the province furthest from its capital.
  const view = ctx.sim.view;
  const counts = new Map<number, number>();
  const samples: number[] = [];
  for (let lat = 25; lat <= 60; lat += 2.5) {
    for (let lon = 35; lon <= 95; lon += 2.5) {
      const t = T(lat, lon);
      const o = view.owner[t];
      const p = view.players[o];
      if (!p || p.kind !== 'nation' || p.tiles < 1500) continue;
      counts.set(o, (counts.get(o) ?? 0) + 1);
      samples.push(t);
    }
  }
  let owner = 0, best = 0;
  for (const [o, n] of counts) if (n > best) { best = n; owner = o; }
  let tile = -1, far = -1;
  const cap = view.players[owner]?.capitalTile ?? -1;
  for (const t of samples) {
    if (view.owner[t] !== owner) continue;
    const dx = Math.abs((t % MAP_W) - (cap % MAP_W)), dy = Math.floor(t / MAP_W) - Math.floor(cap / MAP_W);
    const d = cap >= 0 ? dx * dx + dy * dy : 0;
    if (d > far) { far = d; tile = t; }
  }
  if (tile < 0) tile = bigNationTile(ctx);
  ctx.sim.debug({ type: 'worldEvent', kind: 'rebellion', tile });
  const ll = tileToLatLon(tile);
  await liveFinish(s, ll.lat, ll.lon, 4200);
}, 20);
