// FRONT ULTRA — small-island markers (owner: globe; built by W2 for DESIGN_V2 §10.6).
// About 480 of the world's 557 land components have 20 tiles or fewer: from orbit they are 1-3 px and the player
// could not know they exist until the cursor happened to cross them (F6). Every such component gets a screen-space
// marker: a ring of diameter max(8 px, projected island size + 4 px), 1.5 px stroke, filled with the owner's colour
// when owned and a white outline when free; markers closer than 10 px merge into one archipelago marker with a count;
// a marker hides once the island itself is larger than 16 px on screen. Drawn above the clouds (renderOrder 44,
// no depth test) in one instanced draw call. Hovering or clicking a marker acts on the island's tile (the input
// router asks pickIsland()), and the tooltip names it: «Malta · 1 casilla · libre».

import * as THREE from 'three';
import type { GameContext } from '../../shared/api';
import { EARTH_RADIUS_KM, MAP_W, TILE_KM } from '../../shared/constants';
import { latLonToVec3, tileToLatLon, tileXYToLatLon } from '../../shared/geo';
import { countryName, playerName, registerDictionary, t, tn } from '../../shared/i18n';
import type { LatLon } from '../../shared/types';
import { landComponents, type LandComponent } from './landComponents';

registerDictionary('es', {
  'island.of': 'Isla de {country}',
  'island.unnamed': 'Isla',
  'island.tiles.one': '{count} casilla',
  'island.tiles.other': '{count} casillas',
  'island.free': 'libre',
  'island.archipelago': 'Archipiélago · {n} islas',
});
registerDictionary('en', {
  'island.of': 'Island of {country}',
  'island.unnamed': 'Island',
  'island.tiles.one': '{count} tile',
  'island.tiles.other': '{count} tiles',
  'island.free': 'free',
  'island.archipelago': 'Archipelago · {n} islands',
});

const MAX_MARKERS = 1024;
const MERGE_PX = 10;
const HIDE_PX = 16;
const MIN_D_PX = 8;

const VERT = /* glsl */ `
attribute vec4 iRect;   // center x, y (px), radius (px), count
attribute vec4 iColor;  // rgb (sRGB), filled (1) / outline only (0)
uniform vec2 uRes;
varying vec2 vP;
varying vec4 vColor;
varying float vR;
varying float vCount;
void main() {
  float ext = iRect.z + 12.0;
  vec2 local = position.xy * ext;
  vec2 px = iRect.xy + local;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vP = local;
  vColor = iColor;
  vR = iRect.z;
  vCount = iRect.w;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uDigits;
varying vec2 vP;
varying vec4 vColor;
varying float vR;
varying float vCount;
vec3 srgbToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void over(inout vec4 acc, vec3 col, float a) { acc = vec4(col * a, a) + acc * (1.0 - a); }
float digit(vec2 p, vec2 c, float d, float h) {
  vec2 uv = (p - c) / h + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(uDigits, vec2((d + uv.x) / 10.0, uv.y)).a;
}
void main() {
  float r = length(vP);
  float d = r - vR;
  vec4 acc = vec4(0.0);
  vec3 col = vColor.rgb;
  // Soft dark halo so the ring reads over bright cloud and ice.
  over(acc, vec3(0.0), (1.0 - smoothstep(0.0, 2.5, abs(d))) * 0.35);
  if (vColor.a > 0.5) over(acc, col, (1.0 - smoothstep(-0.5, 0.5, d)) * 0.55);
  over(acc, vColor.a > 0.5 ? col : vec3(1.0), 1.0 - smoothstep(0.35, 1.1, abs(d)));
  if (vCount > 1.5) {
    // Archipelago: count badge at the lower right.
    vec2 c = vec2(vR * 0.72 + 5.0, vR * 0.72 + 5.0);
    float bd = length(vP - c) - 6.5;
    over(acc, vec3(0.03), 1.0 - smoothstep(-0.5, 0.5, bd));
    float n = vCount >= 10.0 ? 2.0 : 1.0;
    float m = 0.0;
    if (n > 1.5) {
      m = max(digit(vP, c - vec2(2.3, 0.0), floor(vCount / 10.0), 9.0), digit(vP, c + vec2(2.3, 0.0), mod(vCount, 10.0), 9.0));
    } else m = digit(vP, c, vCount, 9.0);
    over(acc, vec3(1.0), m);
  }
  if (acc.a < 0.003) discard;
  // Linear output: ACES keeps these mid values close; cap below the bloom threshold.
  vec3 lin = min(srgbToLin(acc.rgb / acc.a) * 0.95, vec3(1.0));
  gl_FragColor = vec4(lin * acc.a, acc.a);
}`;

function digitAtlas(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.font = 'bold 26px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let d = 0; d < 10; d++) g.fillText(String(d), d * 32 + 16, 17);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

interface Marker {
  x: number;
  y: number;
  r: number;
  comps: LandComponent[];
  owner: number;
  mixed: boolean;
}

export interface IslandHit {
  tile: number;
  label: string;
}

export interface IslandInfo {
  x: number;
  y: number;
  diameterPx: number;
  components: number;
  owner: number;
}

export interface IslandMarkers {
  readonly mesh: THREE.Mesh;
  update(): void;
  pick(clientX: number, clientY: number): IslandHit | null;
  /** Small components in view that the player can see (marked, or big enough on screen by themselves). */
  visible(): number;
  details(): { markers: IslandInfo[]; marked: number; selfVisible: number; inView: number; minDiameterPx: number };
  clear(): void;
  warmup(on: boolean): void;
}

export function createIslandMarkers(ctx: GameContext): IslandMarkers {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const aRect = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKERS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKERS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iRect', aRect);
  geo.setAttribute('iColor', aColor);
  geo.instanceCount = 0;
  const uRes = { value: new THREE.Vector2(1, 1) };
  const material = new THREE.ShaderMaterial({
    name: 'island-markers', vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uRes, uDigits: { value: digitAtlas() } },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'island-markers';
  mesh.frustumCulled = false;
  mesh.renderOrder = 44;

  const v = new THREE.Vector3();
  const ll: LatLon = { lat: 0, lon: 0 };
  const markers: Marker[] = [];
  const cand: { c: LandComponent; x: number; y: number; r: number; owner: number }[] = [];
  let selfVisible = 0, inView = 0;
  let viewW = 1, viewH = 1;
  let rectLeft = 0, rectTop = 0;

  function componentOwner(c: LandComponent): number {
    const owner = ctx.sim.view.owner;
    if (!c.tiles) return owner[c.tile] ?? 0;
    // The owner of most of its tiles (small islands are usually one owner).
    let best = 0, bn = 0;
    for (let i = 0; i < c.tiles.length; i++) {
      const o = owner[c.tiles[i]];
      let n = 0;
      for (let j = 0; j < c.tiles.length; j++) if (owner[c.tiles[j]] === o) n++;
      if (n > bn) {
        bn = n;
        best = o;
      }
    }
    return best;
  }

  function project(c: LandComponent): boolean {
    tileXYToLatLon(((c.cx % MAP_W) + MAP_W) % MAP_W, c.cy, ll);
    latLonToVec3(ll.lat, ll.lon, 1.0002, v);
    const cam = ctx.camera.position;
    // Horizon: the anchor must face the camera.
    if (v.x * (cam.x - v.x) + v.y * (cam.y - v.y) + v.z * (cam.z - v.z) <= 0) return false;
    v.project(ctx.camera);
    if (v.z > 1) return false;
    const x = (v.x * 0.5 + 0.5) * viewW, y = (0.5 - v.y * 0.5) * viewH;
    if (x < -8 || y < -8 || x > viewW + 8 || y > viewH + 8) return false;
    v.x = x;
    v.y = y;
    return true;
  }

  function write(): void {
    const r = aRect.array as Float32Array, col = aColor.array as Float32Array;
    let n = 0;
    const view = ctx.sim.view;
    for (const m of markers) {
      if (n >= MAX_MARKERS) break;
      r[n * 4] = m.x;
      r[n * 4 + 1] = m.y;
      r[n * 4 + 2] = m.r;
      r[n * 4 + 3] = m.comps.length;
      const p = !m.mixed && m.owner > 0 ? view.players[m.owner] : undefined;
      const c = p ? p.color : 0xffffff;
      col[n * 4] = ((c >> 16) & 255) / 255;
      col[n * 4 + 1] = ((c >> 8) & 255) / 255;
      col[n * 4 + 2] = (c & 255) / 255;
      col[n * 4 + 3] = p ? 1 : 0;
      n++;
    }
    geo.instanceCount = n;
    for (const a of [aRect, aColor]) {
      a.clearUpdateRanges();
      if (n) a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
  }

  function labelFor(c: LandComponent, owner: number): string {
    const world = ctx.sim.view.world ?? ctx.world;
    const view = ctx.sim.view;
    let name = t('island.unnamed');
    if (world) {
      const ci = world.country[c.tile] ?? 0;
      const country = ci > 0 ? world.countries[ci] : undefined;
      if (country) name = country.tiles <= 20 ? countryName(country) : t('island.of', { country: countryName(country) });
    }
    const p = owner > 0 ? view.players[owner] : undefined;
    const who = p ? playerName(p, world) : t('island.free');
    return `${name} · ${tn('island.tiles', c.size)} · ${who}`;
  }

  return {
    mesh,
    warmup(on) {
      geo.instanceCount = on ? 1 : 0;
    },
    clear() {
      markers.length = 0;
      geo.instanceCount = 0;
    },
    update() {
      const view = ctx.sim.view;
      const world = view.world ?? ctx.world;
      mesh.visible = view.phase !== 'none' && !!world;
      markers.length = 0;
      cand.length = 0;
      selfVisible = 0;
      inView = 0;
      if (!mesh.visible || !world) {
        geo.instanceCount = 0;
        return;
      }
      viewW = Math.max(1, ctx.canvas.clientWidth || ctx.canvas.width);
      viewH = Math.max(1, ctx.canvas.clientHeight || ctx.canvas.height);
      uRes.value.set(viewW, viewH);
      const br = ctx.canvas.getBoundingClientRect();
      rectLeft = br.left;
      rectTop = br.top;
      const cam = ctx.camera;
      const H = viewH;
      const focal = H / 2 / Math.tan((cam.fov * Math.PI) / 360);
      const comps = landComponents(world).small;
      for (const c of comps) {
        if (!project(c)) continue;
        inView++;
        // Projected size of the island (its extent across) in px.
        tileToLatLon(c.tile, ll);
        latLonToVec3(ll.lat, ll.lon, 1, v);
        const depth = Math.max(1e-6, v.distanceTo(cam.position));
        const sizePx = ((c.radius * 2 * TILE_KM) / EARTH_RADIUS_KM) * focal / depth;
        if (sizePx > HIDE_PX) {
          selfVisible++;
          continue;
        }
        project(c);
        cand.push({ c, x: v.x, y: v.y, r: Math.max(MIN_D_PX, sizePx + 4) / 2, owner: componentOwner(c) });
      }
      // Greedy archipelago merge: markers within 10 px of each other become one.
      for (const k of cand) {
        let merged = false;
        for (const m of markers) {
          const d = Math.hypot(m.x - k.x, m.y - k.y);
          if (d < m.r + k.r + MERGE_PX) {
            const n = m.comps.length;
            m.comps.push(k.c);
            // One compact marker at the members' centroid with a count (a big enclosing ring would hide the sea).
            m.x = (m.x * n + k.x) / (n + 1);
            m.y = (m.y * n + k.y) / (n + 1);
            m.r = Math.min(9, Math.max(m.r, k.r) + 1);
            if (k.owner !== m.owner) m.mixed = true;
            merged = true;
            break;
          }
        }
        if (!merged) markers.push({ x: k.x, y: k.y, r: k.r, comps: [k.c], owner: k.owner, mixed: false });
      }
      write();
    },
    pick(clientX, clientY) {
      const x = clientX - rectLeft, y = clientY - rectTop;
      let best: Marker | null = null, bd = Infinity;
      for (const m of markers) {
        const d = Math.hypot(m.x - x, m.y - y);
        if (d <= m.r + 4 && d < bd) {
          bd = d;
          best = m;
        }
      }
      if (!best) return null;
      // An archipelago: the member island nearest the cursor.
      let comp = best.comps[0], cd = Infinity;
      if (best.comps.length > 1) {
        for (const c of best.comps) {
          if (!project(c)) continue;
          const d = Math.hypot(v.x - x, v.y - y);
          if (d < cd) {
            cd = d;
            comp = c;
          }
        }
      }
      const owner = componentOwner(comp);
      const label = best.comps.length > 1 ? `${labelFor(comp, owner)} · ${t('island.archipelago', { n: best.comps.length })}` : labelFor(comp, owner);
      return { tile: comp.tile, label };
    },
    visible() {
      let marked = 0;
      for (const m of markers) marked += m.comps.length;
      return marked + selfVisible;
    },
    details() {
      let marked = 0, minD = Infinity;
      for (const m of markers) {
        marked += m.comps.length;
        minD = Math.min(minD, m.r * 2);
      }
      return {
        markers: markers.map((m) => ({ x: m.x + rectLeft, y: m.y + rectTop, diameterPx: +(m.r * 2).toFixed(1), components: m.comps.length, owner: m.owner })),
        marked, selfVisible, inView, minDiameterPx: Number.isFinite(minD) ? +minD.toFixed(1) : 0,
      };
    },
  };
}
