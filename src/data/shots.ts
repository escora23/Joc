// FRONT ULTRA — data-layer debug shots (owner: data).
//
//   ?shot=data-debug   the 1600x800 tile grid as a flat equirectangular map: nation colors over hillshade, borders,
//                      shore rims, lakes, capitals as dots, stats + legend strip. Knobs:
//                        &mode=political|terrain|biome|coast   (default political)
//                        &region=world|europe|med|asia|seasia|americas|caribbean|africa|oceania|arctic|
//                                lakes|caspian|japan|uk|nz   or &box=lonW,latN,lonE,latS
//                        &labels=0 hides capital names in zoomed views
//   ?shot=data-terrain / data-biome / data-coast   same as data-debug with that mode
//   ?shot=data-europe                               political, Europe zoom with capital names
//   ?shot=data-local   getLocalHeightfield() gallery: 6 real places, shaded relief colored by splat weights

import { MAP_H, MAP_W } from '../shared/constants';
import { hexToCss } from '../shared/color';
import { registerShot, type ShotContext } from '../shared/shots';
import { getLanguage, t } from '../shared/i18n';
import type { WorldData } from '../shared/types';
import { renderDebugMap, DETAIL_RGB, BIOME_RGB, type DebugMapMode } from './debugmap';
import { getLocalHeightfield, getWorldAux } from './index';
import { BIOME_KEYS, TERRAIN_DETAIL_KEYS, type CountryInfo, type LocalHeightfield } from './types';

const VIEW_W = 1600;
const VIEW_H = 900;
const MAP_VIEW_H = 800;

/** Named regions [lonW, latN, lonE, latS]. */
const REGIONS: Record<string, [number, number, number, number]> = {
  world: [-180, 90, 180, -90],
  europe: [-26, 72, 46, 34],
  med: [-10, 47, 38, 29],
  asia: [60, 60, 150, 0],
  seasia: [92, 24, 156, -12],
  americas: [-170, 75, -30, -58],
  caribbean: [-92, 28, -58, 8],
  africa: [-20, 38, 55, -36],
  oceania: [108, 2, 180, -50],
  arctic: [-130, 84, 60, 60],
  lakes: [-94, 50, -74, 40],
  caspian: [42, 48, 58, 35],
  japan: [126, 46, 148, 30],
  uk: [-11, 61, 3, 49],
  nz: [164, -33, 180, -48],
};

function makeLayer(ctx: ShotContext['ctx']): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:500;background:#050a14;pointer-events:none';
  const g = canvas.getContext('2d')!;
  // The layer lives in #ui so &hud=0 would hide it: force the UI root visible (the layer covers the HUD anyway).
  ctx.uiRoot.style.visibility = 'visible';
  ctx.uiRoot.appendChild(canvas);
  return { canvas, g };
}

interface Box { lonW: number; latN: number; lonE: number; latS: number }

function parseBox(params: URLSearchParams, fallbackRegion: string): Box {
  const b = params.get('box');
  if (b) {
    const v = b.split(',').map(Number);
    if (v.length === 4 && v.every((n) => Number.isFinite(n))) return { lonW: v[0], latN: v[1], lonE: v[2], latS: v[3] };
  }
  const r = REGIONS[params.get('region') ?? fallbackRegion] ?? REGIONS.world;
  return { lonW: r[0], latN: r[1], lonE: r[2], latS: r[3] };
}

/** Fit the box into the map viewport keeping the equirectangular aspect (1 deg lon == 1 deg lat on screen). */
function fitBox(box: Box): { lonW: number; latN: number; scale: number; ox: number; oy: number } {
  const dLon = box.lonE - box.lonW, dLat = box.latN - box.latS;
  const scale = Math.min(VIEW_W / dLon, MAP_VIEW_H / dLat); // px per degree
  const ox = (VIEW_W - dLon * scale) / 2, oy = (MAP_VIEW_H - dLat * scale) / 2;
  return { lonW: box.lonW, latN: box.latN, scale, ox, oy };
}

async function stageDebugMap(s: ShotContext, forcedMode?: DebugMapMode, region = 'world'): Promise<void> {
  const { ctx, params } = s;
  const world = ctx.world;
  if (!world) throw new Error('world not loaded');
  const aux = getWorldAux(world);
  const mode = (forcedMode ?? (params.get('mode') as DebugMapMode | null) ?? 'political') as DebugMapMode;
  const fit = fitBox(parseBox(params, region));
  const zoomed = fit.scale > 5;
  const { g } = makeLayer(ctx);

  // Grid image at native resolution, then nearest-neighbour scaled (tiles stay crisp squares).
  const px = renderDebugMap(world, aux, mode);
  const src = document.createElement('canvas');
  src.width = MAP_W;
  src.height = MAP_H;
  const sg = src.getContext('2d')!;
  const img = sg.createImageData(MAP_W, MAP_H);
  img.data.set(px);
  sg.putImageData(img, 0, 0);
  g.fillStyle = '#050a14';
  g.fillRect(0, 0, VIEW_W, VIEW_H);
  g.imageSmoothingEnabled = false;
  const tilesPerDeg = MAP_W / 360;
  const dw = VIEW_W - 2 * fit.ox, dh = MAP_VIEW_H - 2 * fit.oy;
  const sx = (fit.lonW + 180) * tilesPerDeg, sy = (90 - fit.latN) * tilesPerDeg;
  const sw = (dw / fit.scale) * tilesPerDeg, sh = (dh / fit.scale) * tilesPerDeg;
  // Draw with wrap (boxes may cross the antimeridian): clip each copy of the source to its valid range.
  for (const shift of [-MAP_W, 0, MAP_W]) {
    const a = Math.max(sx, shift), b = Math.min(sx + sw, shift + MAP_W);
    if (b <= a) continue;
    const dx0 = fit.ox + ((a - sx) / sw) * dw, dx1 = fit.ox + ((b - sx) / sw) * dw;
    g.drawImage(src, a - shift, sy, b - a, sh, dx0, fit.oy, dx1 - dx0, dh);
  }
  const toScreen = (lat: number, lon: number): [number, number] => {
    let dl = lon - fit.lonW;
    while (dl < 0) dl += 360;
    while (dl >= 360) dl -= 360;
    return [fit.ox + dl * fit.scale, fit.oy + (fit.latN - lat) * fit.scale];
  };

  // Graticule every 30 deg (every 10 deg when zoomed).
  const step = zoomed ? 10 : 30;
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 1;
  g.beginPath();
  for (let lon = -180; lon <= 180; lon += step) {
    const x = fit.ox + (lon - fit.lonW) * fit.scale;
    if (x < fit.ox || x > VIEW_W - fit.ox) continue;
    g.moveTo(Math.round(x) + 0.5, fit.oy);
    g.lineTo(Math.round(x) + 0.5, MAP_VIEW_H - fit.oy);
  }
  for (let lat = -90; lat <= 90; lat += step) {
    const y = fit.oy + (fit.latN - lat) * fit.scale;
    if (y < fit.oy || y > MAP_VIEW_H - fit.oy) continue;
    g.moveTo(fit.ox, Math.round(y) + 0.5);
    g.lineTo(VIEW_W - fit.ox, Math.round(y) + 0.5);
  }
  g.stroke();

  // Capitals (white = on the country's own land, red = off-land: a data error to fix).
  const countries = world.countries as CountryInfo[];
  const es = getLanguage() === 'es';
  const showLabels = zoomed && params.get('labels') !== '0';
  const sorted = countries.slice(1).sort((a, b) => b.weight - a.weight);
  const placed: [number, number, number, number][] = [];
  g.textBaseline = 'middle';
  for (const c of sorted) {
    const [x, y] = toScreen(c.capital.lat, c.capital.lon);
    if (x < fit.ox - 4 || x > VIEW_W - fit.ox + 4 || y < fit.oy - 4 || y > MAP_VIEW_H - fit.oy + 4) continue;
    const r = (zoomed ? 2.6 : 1.4) + c.weight * (zoomed ? 3 : 2);
    g.beginPath();
    g.arc(x, y, r + 1.3, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.85)';
    g.fill();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = capitalOk(c) ? '#ffffff' : '#ff3355';
    g.fill();
    if (showLabels && (c.weight > 0.12 || fit.scale > 25)) {
      const name = es ? c.nameEs : c.nameEn;
      const cap = es ? c.capitalNameEs : c.capitalNameEn;
      const fs = Math.round(10 + c.weight * 6);
      g.font = `600 ${fs}px system-ui, sans-serif`;
      const w = Math.max(g.measureText(name).width, g.measureText(cap).width * 0.85);
      const lx = x + r + 4, ly = y;
      const rect: [number, number, number, number] = [lx - 2, ly - fs, lx + w + 2, ly + fs];
      if (placed.some((p) => rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1])) continue;
      placed.push(rect);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.fillStyle = '#fff';
      g.strokeText(name, lx, ly - fs * 0.35);
      g.fillText(name, lx, ly - fs * 0.35);
      g.font = `${Math.round(fs * 0.8)}px system-ui, sans-serif`;
      g.fillStyle = 'rgba(210,225,255,0.9)';
      g.strokeText(cap, lx, ly + fs * 0.5);
      g.fillText(cap, lx, ly + fs * 0.5);
    }
  }

  drawFooter(g, world, mode);
  await s.waitFrames(3);
}

/** The capital's own-country tile is within 2.5 tiles (~60 km) of the real capital (grid precision). */
function capitalOk(c: CountryInfo): boolean {
  if (c.capitalTile < 0) return false;
  const cx = ((c.capital.lon + 180) / 360) * MAP_W, cy = ((90 - c.capital.lat) / 180) * MAP_H;
  let dx = Math.abs((c.capitalTile % MAP_W) + 0.5 - cx);
  if (dx > MAP_W / 2) dx = MAP_W - dx;
  const dy = Math.floor(c.capitalTile / MAP_W) + 0.5 - cy;
  return Math.hypot(dx * Math.cos((c.capital.lat * Math.PI) / 180), dy) <= 2.5;
}

function drawFooter(g: CanvasRenderingContext2D, world: WorldData, mode: DebugMapMode): void {
  const aux = getWorldAux(world);
  const y0 = MAP_VIEW_H;
  const grad = g.createLinearGradient(0, y0, 0, VIEW_H);
  grad.addColorStop(0, '#0b1426');
  grad.addColorStop(1, '#060b16');
  g.fillStyle = grad;
  g.fillRect(0, y0, VIEW_W, VIEW_H - y0);
  g.fillStyle = 'rgba(120,180,255,0.35)';
  g.fillRect(0, y0, VIEW_W, 1);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#e8f0ff';
  g.font = '700 20px system-ui, sans-serif';
  g.fillText('FRONT ULTRA · WORLD DATA', 20, y0 + 30);
  g.fillStyle = '#8fb4e8';
  g.font = '600 13px system-ui, sans-serif';
  g.fillText(t(`data.debug.${mode}`).toUpperCase(), 20, y0 + 50);
  if (aux) {
    const st = aux.stats;
    const total = Object.values(st.timings).reduce((a, b) => a + b, 0);
    g.fillStyle = '#b8c8e0';
    g.font = '12px ui-monospace, monospace';
    g.fillText(
      `${st.landTiles} land · ${st.countries} countries · ${st.lakes} lakes · ${st.riverTiles} river · ${st.shoreTiles} shore · ${st.iceTiles} ice`,
      20, y0 + 70,
    );
    g.fillText(
      `plains ${st.plains} · hills ${st.hills} · mountains ${st.mountains} · capitals on own land ${st.capitalsOnOwnLand}/${st.countries} · ` +
        `${Math.round(total)} ms (${st.thread})`,
      20, y0 + 88,
    );
  }
  // Legend.
  let items: [string, [number, number, number]][];
  if (mode === 'biome') items = BIOME_KEYS.map((k, i) => [k, BIOME_RGB[i]]);
  else if (mode === 'coast') items = [['water', [60, 140, 220]], ['land', [200, 150, 60]], ['coastline', [255, 255, 255]], ['100 km bands', [120, 110, 90]]];
  else if (mode === 'political') {
    const countries = world.countries as CountryInfo[];
    const top = countries.slice(1).sort((a, b) => b.tiles - a.tiles).slice(0, 10);
    const es = getLanguage() === 'es';
    items = top.map((c) => [es ? c.nameEs : c.nameEn, hexRgb(c.color)]);
    items.push(['capital', [255, 255, 255]], ['capital off-land', [255, 51, 85]]);
  } else items = TERRAIN_DETAIL_KEYS.map((k, i) => [k, DETAIL_RGB[i]]);
  g.font = '12px system-ui, sans-serif';
  const colW = 148;
  const x0 = 720;
  items.forEach(([label, rgb], i) => {
    const col = Math.floor(i / 4), row = i % 4;
    const x = x0 + col * colW, y = y0 + 20 + row * 20;
    if (x + colW > VIEW_W + 40) return;
    g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    g.fillRect(x, y - 10, 14, 14);
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.strokeRect(x + 0.5, y - 9.5, 13, 13);
    g.fillStyle = '#d0dcf0';
    g.fillText(label, x + 20, y + 1);
  });
}

function hexRgb(h: number): [number, number, number] {
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

// --- local heightfield gallery ------------------------------------------------------------------------------

const SPLAT_RGB: [number, number, number][] = [
  [214, 196, 150], // sand
  [104, 142, 64], // grass
  [44, 88, 42], // forest
  [128, 120, 112], // rock
  [240, 244, 250], // snow
  [150, 146, 140], // urban
  [140, 110, 76], // dirt
  [84, 90, 70], // wet
];

const LOCAL_SITES: { name: string; lat: number; lon: number; km: number }[] = [
  { name: 'Alps · Matterhorn', lat: 45.98, lon: 7.66, km: 40 },
  { name: 'Himalaya · Everest', lat: 27.99, lon: 86.93, km: 60 },
  { name: 'Norway · Sognefjord', lat: 61.1, lon: 6.6, km: 60 },
  { name: 'Meseta · Madrid', lat: 40.42, lon: -3.7, km: 30 },
  { name: 'Sahara · Tassili', lat: 25.5, lon: 8.5, km: 40 },
  { name: 'Normandy coast', lat: 49.35, lon: -0.6, km: 30 },
];

function renderLocal(hf: LocalHeightfield, out: ImageData): void {
  const res = hf.resolution;
  const d = out.data;
  const cell = hf.cellMeters;
  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      const p = i * res + j;
      const hL = hf.heights[i * res + Math.max(0, j - 1)], hR = hf.heights[i * res + Math.min(res - 1, j + 1)];
      const hU = hf.heights[Math.max(0, i - 1) * res + j], hD = hf.heights[Math.min(res - 1, i + 1) * res + j];
      // Light from the north-west.
      const nx = (hL - hR) / (2 * cell), ny = (hD - hU) / (2 * cell);
      const len = Math.hypot(nx, ny, 1);
      const shade = Math.max(0.25, Math.min(1.35, 0.45 + ((nx * -0.6 + ny * 0.6 + 0.75) / len) * 0.75));
      let r = 0, g = 0, b = 0;
      if (hf.water[p] > 127) {
        const depth = Math.min(1, -hf.heights[p] / 40);
        r = 30 - depth * 18; g = 90 - depth * 50; b = 130 - depth * 40;
      } else {
        for (let k = 0; k < 8; k++) {
          const w = (k < 4 ? hf.splatA[p * 4 + k] : hf.splatB[p * 4 + k - 4]) / 255;
          r += SPLAT_RGB[k][0] * w; g += SPLAT_RGB[k][1] * w; b += SPLAT_RGB[k][2] * w;
        }
        // 30% of the real regional tint.
        r = r * 0.7 + hf.tint[p * 3] * 0.3; g = g * 0.7 + hf.tint[p * 3 + 1] * 0.3; b = b * 0.7 + hf.tint[p * 3 + 2] * 0.3;
        r *= shade; g *= shade; b *= shade;
      }
      const o = p * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
}

async function stageLocal(s: ShotContext): Promise<void> {
  const { ctx } = s;
  if (!ctx.world) throw new Error('world not loaded');
  const { g } = makeLayer(ctx);
  g.fillStyle = '#060b16';
  g.fillRect(0, 0, VIEW_W, VIEW_H);
  const res = 256;
  const tile = 370;
  const cols = 3;
  const gapX = (VIEW_W - cols * tile) / (cols + 1);
  const img = g.createImageData(res, res);
  const tmp = document.createElement('canvas');
  tmp.width = res;
  tmp.height = res;
  const tg = tmp.getContext('2d')!;
  // Warm the JIT once so the reported timings are steady-state.
  let hf = getLocalHeightfield(46, 7.6, 20, res);
  for (let k = 0; k < LOCAL_SITES.length; k++) {
    const site = LOCAL_SITES[k];
    hf = getLocalHeightfield(site.lat, site.lon, site.km, res, { reuse: hf });
    renderLocal(hf, img);
    tg.putImageData(img, 0, 0);
    const col = k % cols, row = Math.floor(k / cols);
    const x = gapX + col * (tile + gapX), y = 36 + row * (tile + 62);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, x, y, tile, tile);
    g.strokeStyle = 'rgba(140,190,255,0.35)';
    g.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
    g.fillStyle = '#e8f0ff';
    g.font = '600 15px system-ui, sans-serif';
    g.fillText(site.name, x, y - 10);
    g.fillStyle = '#9fb6d8';
    g.font = '12px ui-monospace, monospace';
    g.fillText(`${site.km} km · ${res}² · ${Math.round(hf.minHeight)}…${Math.round(hf.maxHeight)} m · ${hf.ms.toFixed(1)} ms`, x, y + tile + 18);
  }
  // Splat legend.
  const names = ['sand', 'grass', 'forest', 'rock', 'snow', 'urban', 'dirt', 'wet', 'water'];
  const cols2: [number, number, number][] = [...SPLAT_RGB, [30, 80, 125]];
  g.font = '12px system-ui, sans-serif';
  names.forEach((n, i) => {
    const x = gapX + i * 110, y = VIEW_H - 10;
    g.fillStyle = hexToCss((cols2[i][0] << 16) | (cols2[i][1] << 8) | cols2[i][2]);
    g.fillRect(x, y - 11, 12, 12);
    g.fillStyle = '#c8d4ea';
    g.fillText(n, x + 18, y);
  });
  await s.waitFrames(3);
}

registerShot('data-debug', 'data', 'Tile grid debug: political map, terrain, capitals (&mode=, &region=, &box=)', (s) => stageDebugMap(s), 5);
registerShot('data-terrain', 'data', 'Tile grid debug: terrain detail classes, rivers, lakes', (s) => stageDebugMap(s, 'terrain'), 5);
registerShot('data-biome', 'data', 'Tile grid debug: biomes', (s) => stageDebugMap(s, 'biome'), 5);
registerShot('data-coast', 'data', 'Tile grid debug: signed coast distance', (s) => stageDebugMap(s, 'coast'), 5);
registerShot('data-europe', 'data', 'Tile grid debug: Europe close-up with capitals', (s) => stageDebugMap(s, 'political', 'europe'), 5);
registerShot('data-local', 'data', 'Local heightfield gallery (battle/command terrain source)', (s) => stageLocal(s), 5);
