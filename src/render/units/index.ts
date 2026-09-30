// FRONT ULTRA — units & structures on the globe (owner: units).
// Every simulation entity drawn with procedural low-poly instanced models tinted by nation:
//   * units interpolated between sim ticks (position, heading, altitude), formations (fighter V, drone swarm,
//     armored column, train consist), banking aircraft, missiles oriented along their ballistic arcs,
//   * screen-space minimum size (readable from orbit) with real-size floors up close, altitude LOD for structures
//     (detailed models -> glowing nation beacons from high orbit),
//   * trails via the FX trail system: ship wakes, contrails, missile smoke, nuke arcs, tank dust, shell tracers,
//   * structures: procedural city skylines that grow with level and light up at night, ports with cranes,
//     factories with smoking stacks, radars with rotating dishes, silos, SAM sites, airbases, army bases, yards,
//   * the rail network between stations, selection rings, build ghosts, targeting rings and order paths.
// Draw calls: one per model kind (~25) + rails + overlays + 2 icon batches. No per-frame allocations in the update loop.
// LOD (DESIGN_V2 §10.7, W2): from orbit units and structures are NATO-style 2D icons (icons.ts); 3D models cross-fade
// in below 1,200 km (units) and 900 km (structures) at a 12 px minimum size instead of the old 16-46 px inflation, and
// never smaller than 32 px below 600 km. W4 owns the models, rings and grounding; the hand-off thresholds live in iconLod().

import * as THREE from 'three';
import type { FrameInfo, GameContext, UnitsApi } from '../../shared/api';
import { FROZEN_TIME_SEC, presentationTime, shotView } from '../../shared/shots';
import { getWorldAux } from '../../data';
import { EARTH_RADIUS_KM, HOLD_ORBIT_KM, HUMAN_ID, MAP_H, MAP_W, RADAR_SAM_RANGE_MUL, RADAR_SCRAMBLE_MUL, TILE_KM, structureLevel } from '../../shared/constants';
import { labelRects } from '../globe/labels';
import { latLonToVec3, tangentFrame, tileToLatLon, tileX, tileXYToLatLon, tileY, vec3ToLatLon, wrapDX } from '../../shared/geo';
import { angleDelta, clamp, lerp, lerpAngle } from '../../shared/math';
import { hash3 } from '../../shared/rng';
import { isWaterTerrain } from '../../shared/terrain';
import { StructureType, UNIT_ORDER_KINDS, UnitMode, UnitState, UnitType, type LatLon, type StructureView, type UnitView } from '../../shared/types';
import { CITY_BLOCKS, collapsedBlocks, damageState, standingShare } from '../../shared/damage';
import { DEFEND_TILES, DIVISION_ARTILLERY_TILES, EFFECT_TILES, radarCovers, reachKm, tileCx, tileCy } from '../../shared/orders';
import { viewRules } from '../../sim/rulesView';
import { fxInternal, type FxInternal } from '../fx';
import { PK } from '../fx/particles';
import type { Trail, TrailStyleKey } from '../fx/trails';
import { airHeightKm, ballisticApexKm, env, refreshEnv, unitMinPxOf, unitSizeKm } from './common';
import { ModelBuilder } from './geom';
import { createModelMaterial, minPxScale, structFade, unitFade } from './material';
import { IconLayer, unitCategory, type IconHit } from './icons';
import { RouteManager, type RouteEnv } from './routes';
import { relationsFor } from '../relations';
import {
  AIRBASE_SLOTS, buildBuilding, buildSpire, buildStructModel, buildUnitModel, levelKey, STRUCT_MODELS, UNIT_MODELS,
  type StructModelKey, type UnitModelKey,
} from './models';
import { Overlays } from './overlays';
import { buildRailLinks, SurfaceRibbon } from './rails';

// -------------------------------------------------------------------------------------------------
// Tables
// -------------------------------------------------------------------------------------------------

const UNIT_CAP: Record<UnitModelKey, number> = {
  transport: 512, trade: 768, warship: 768, tank: 2048, fighter: 1536, bomber: 512, drone: 2048, cruise: 256,
  icbm: 160, warhead: 512, sam: 384, loco: 384, wagon: 1536,
};
/** Instance capacity per structure model key (level variants share the base type's budget). */
const STRUCT_CAP = ((): Record<StructModelKey, number> => {
  const base: Record<string, number> = {
    cityBase: 1536, port: 1024, factory: 1024, defensePost: 1536, samSite: 768, silo: 768, airbase: 768, armyBase: 768,
    navalYard: 768, radar: 768, radarDish: 768, beacon: 6144, pad: 8192, padRound: 4096, rubble: 4096,
  };
  const out = {} as Record<StructModelKey, number>;
  for (const k of STRUCT_MODELS) out[k] = base[k.replace(/[23]$/, '')] ?? 512;
  return out;
})();

/**
 * Structure footprint (km) and model key (DESIGN_V2 §6.5, §10.7: real footprints, 2.5–6 km; a city 2.5 km + 0.35 km
 * per level). The model changes with the level (levelKey), the footprint only slightly.
 */
const STRUCT_INFO: Record<StructureType, { key: StructModelKey; km: number }> = {
  [StructureType.City]: { key: 'cityBase', km: 2.5 },
  [StructureType.Port]: { key: 'port', km: 4 },
  [StructureType.Factory]: { key: 'factory', km: 3.5 },
  [StructureType.DefensePost]: { key: 'defensePost', km: 2.6 },
  [StructureType.SamSite]: { key: 'samSite', km: 3 },
  [StructureType.MissileSilo]: { key: 'silo', km: 3 },
  [StructureType.Airbase]: { key: 'airbase', km: 6 },
  [StructureType.ArmyBase]: { key: 'armyBase', km: 4 },
  [StructureType.NavalYard]: { key: 'navalYard', km: 4.5 },
  [StructureType.Radar]: { key: 'radar', km: 2.5 },
};

function structKm(type: StructureType, level: number): number {
  const base = STRUCT_INFO[type].km;
  if (type === StructureType.City) return base + 0.35 * Math.min(10, Math.max(1, level));
  // Each level adds 10 % to the footprint: an upgraded base is visibly bigger as well as busier (§6.5).
  return base * (1 + 0.1 * (Math.max(1, Math.min(3, level)) - 1));
}

/**
 * Per-type factor on the structure minimum on-screen size (lod.structMinPx): airbases and cities are drawn a little
 * larger than a radar or a bunker. Every part of one structure (foundation pad, model, city buildings, radar dish)
 * scales about the same anchor with the same size, so they never drift apart.
 */
const STRUCT_PX_K: Record<StructureType, number> = {
  [StructureType.City]: 1.2, [StructureType.Port]: 1.1, [StructureType.Factory]: 1.05, [StructureType.DefensePost]: 0.95,
  [StructureType.SamSite]: 1.0, [StructureType.MissileSilo]: 0.95, [StructureType.Airbase]: 1.3, [StructureType.ArmyBase]: 1.05,
  [StructureType.NavalYard]: 1.1, [StructureType.Radar]: 0.95,
};

/** Quantization of the drawn structure size on the CPU (quarter octaves): the relief fit is recomputed per step. */
const SCALE_STEPS_PER_OCTAVE = 4;

const MAX_BUILDINGS = 26000;
const MAX_SPIRES = 1536;

const BUILDING_COLORS = [0xc9c3b6, 0xa9b4bf, 0x8d9aa6, 0xd8d6d0, 0x6f7f8e, 0xb8a58f, 0x9fa9a3, 0x7d8ea1];

/**
 * Icon / model hand-off by camera altitude (DESIGN_V2 §10.7):
 *   > 1,500 km       icons only (units 22 px, structures 18 px)
 *   900-1,500 km     unit models fade in from 1,200 km (min 12 px); structures icons only
 *   600-900 km       unit icons shrink to 14 px and float above the models; structure models fade in from 900 km
 *   250-600 km       unit models with a 6 px owner pip above each; structures icons + models
 *   < 250 km         models only; structure level shown on hover/selection by the card
 * Minimum on-screen sizes grow as the camera descends (owner clarification to FEEDBACK-1: every model clearly
 * visible up close): units 34 px at 600 km, 46 at 300, 62 at 100, 80 at 30, 116 at 10 and 150 from 3 km (times their
 * UNIT_LOOK.pxK: a warship 200 px long at 3 km, one tank of a division 105 px);
 * structures 22 px at 600 km, 38 at 250, 54 at 100, 58 from 40 km (times STRUCT_PX_K). Below ~40 km most structures
 * are drawn at their real footprint (2.5-6.6 km), which is larger than the minimum.
 */
export interface IconLod {
  unitModelFade: number;
  structModelFade: number;
  /** 0 full icons, 1 small floating icons, 2 pips. */
  unitIconMode: 0 | 1 | 2;
  structIcons: boolean;
  unitMinPx: number;
  /** Minimum on-screen footprint of structure models (px, before STRUCT_PX_K). */
  structMinPx: number;
  /**
   * Strategic world view (above 8,000 km): only the human's and hostile-to-human military icons (clustered); trade
   * ships, trains, structures and other nations' units are hidden, and no icon covers a nation label (FEEDBACK-1 #4).
   */
  worldView: boolean;
}

/** Above this camera altitude the icon layer switches to the strategic world view (IconLod.worldView). */
export const WORLD_VIEW_KM = 8000;

/** [altitude km, px] from high to low; linear in log-altitude between points, flat beyond the ends. */
const UNIT_PX_CURVE: readonly [number, number][] = [[900, 12], [600, 34], [300, 46], [100, 62], [30, 80], [10, 116], [3, 150]];
const STRUCT_PX_CURVE: readonly [number, number][] = [[1200, 12], [600, 22], [250, 38], [100, 54], [40, 58]];
function pxCurve(altKm: number, c: readonly [number, number][]): number {
  if (altKm >= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (altKm >= c[i][0]) {
      const t = Math.log(c[i - 1][0] / altKm) / Math.log(c[i - 1][0] / c[i][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
    }
  }
  return c[c.length - 1][1];
}

export function iconLod(altKm: number, out: IconLod): IconLod {
  out.unitModelFade = clamp((1200 - altKm) / 300, 0, 1);
  out.structModelFade = clamp((900 - altKm) / 250, 0, 1);
  out.unitIconMode = altKm > 900 ? 0 : altKm > 600 ? 1 : 2;
  out.worldView = altKm > WORLD_VIEW_KM;
  out.structIcons = altKm > 250 && !out.worldView;
  // Models fade in small under the icons (12 px), then keep growing as the camera descends so that up close every
  // model is clearly visible (owner clarification to FEEDBACK-1), never a speck.
  out.unitMinPx = pxCurve(altKm, UNIT_PX_CURVE);
  out.structMinPx = pxCurve(altKm, STRUCT_PX_CURVE);
  return out;
}

interface InstMesh {
  mesh: THREE.InstancedMesh;
  params: THREE.InstancedBufferAttribute;
  anchor: THREE.InstancedBufferAttribute | null;
  n: number;
  cap: number;
}

interface Track {
  id: number;
  type: UnitType;
  seen: number;
  trails: (Trail | null)[];
  pos: THREE.Vector3;
  ground: THREE.Vector3;
  fwd: THREE.Vector3;
  hasPos: boolean;
  bank: number;
  size: number;
  lat: number;
  lon: number;
  idle: number;
  ship: boolean;
  range: number;
  apex: number;
}

interface CitySpec {
  level: number;
  capital: boolean;
  /** Per building: x, z, w, d, h, rot, color index, floors */
  b: Float32Array;
  n: number;
  spires: number;
}

interface RadarInfo { id: number; anchor: THREE.Vector3; e: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3; S: number; aS: number; col: THREE.Color; built: number; hp: number; sel: number; level: number }
interface FactoryInfo { anchor: THREE.Vector3; e: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3; S: number; k: number; acc: number; level: number }

export function createUnitsRenderer(ctx: GameContext): UnitsApi {
  const root = new THREE.Group();
  root.name = 'units';
  ctx.scene.add(root);

  const unitMeshes = {} as Record<UnitModelKey, InstMesh>;
  const structMeshes = {} as Record<StructModelKey, InstMesh>;
  let buildings: InstMesh | null = null;
  let spires: InstMesh | null = null;
  let rails: SurfaceRibbon | null = null;
  let overlays: Overlays | null = null;
  let icons: IconLayer | null = null;
  /** v2 (W6): divisions the ground battle draws at battle scale (not drawn here). */
  let battleOwned: ReadonlySet<number> | null = null;
  let built = false;
  const lod: IconLod = { unitModelFade: 0, structModelFade: 0, unitIconMode: 0, structIcons: true, unitMinPx: 12, structMinPx: 12, worldView: false };
  const relations = relationsFor(ctx);
  let structModelsOn = false;
  const routes = new RouteManager();
  // The after-arrival hold and fade of route lines run on real seconds (frozen with &freeze=1), evaluated every frame
  // and also on this timer, so a slow or stalled frame never leaves a line drawn past its hold + fade (§10.8).
  routes.clock = () => presentationTime(performance.now() / 1000);
  setInterval(() => routes.tickEnding(), 100);
  let routeEnv: RouteEnv | null = null;
  let hoverUnit = -1;
  let viewW = 1, viewH = 1;
  const scr = new THREE.Vector3();
  const scrXY = { x: 0, y: 0 };

  const tracks = new Map<number, Track>();
  const trackPool: Track[] = [];
  const structAnchor = new Map<number, THREE.Vector3>();
  const structHeading = new Map<number, number>();
  const cityCache = new Map<number, CitySpec>();
  const colorCache = new Map<number, THREE.Color>();
  const selectedUnits = new Set<number>();
  let selectedStructure = -1;
  let structDirty = true;
  let railDirty = true;
  let railBuiltAt = -10;
  let lastStructFirst: StructureView | undefined;
  let lastStructSize = -1;
  let lastStructSig = -1;
  let lastSigTick = -1;
  const detailMode = true;
  let seenGen = 0;
  const radarList: RadarInfo[] = [];
  const factoryList: FactoryInfo[] = [];

  // Previews from the UI.
  const preview = {
    build: { structure: -1 as number, tile: -1, valid: false },
    target: { weapon: null as number | null, tile: -1, inner: 0, outer: 0, valid: false },
    order: { unitId: -1, tile: -1, valid: false, unitIds: [] as number[], valids: [] as boolean[] },
    offensive: { tile: -1, frontage: 0, ratio: 0, valid: false, origin: -1, originFor: -1 },
  };

  // Scratch.
  const E = new THREE.Vector3(), N = new THREE.Vector3(), U = new THREE.Vector3();
  const F = new THREE.Vector3(), R = new THREE.Vector3(), B = new THREE.Vector3(), UP = new THREE.Vector3();
  const P = new THREE.Vector3(), Q = new THREE.Vector3(), T = new THREE.Vector3(), G = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const white = new THREE.Color(1, 1, 1);
  const tmpColor = new THREE.Color();
  const ll: LatLon = { lat: 0, lon: 0 };
  const ll2: LatLon = { lat: 0, lon: 0 };
  const camState = { lat: 0, lon: 0, altitudeKm: 0, tilt: 0, heading: 0 };
  const radiusAt = (lat: number, lon: number) => ctx.globe.surfaceRadiusAt(lat, lon);

  // -----------------------------------------------------------------------------------------------
  // Bus
  // -----------------------------------------------------------------------------------------------
  ctx.bus.on('selectionChanged', (e) => {
    selectedUnits.clear();
    for (const id of e.unitIds) selectedUnits.add(id);
    selectedStructure = e.structureId;
    structDirty = true;
  });
  ctx.bus.on('buildPreview', (e) => {
    preview.build.structure = e.structure;
    preview.build.tile = e.tile;
    preview.build.valid = e.valid;
  });
  ctx.bus.on('targetPreview', (e) => {
    preview.target.weapon = e.weapon;
    preview.target.tile = e.tile;
    preview.target.inner = e.innerRadius;
    preview.target.outer = e.outerRadius;
    preview.target.valid = e.valid;
  });
  ctx.bus.on('orderPreview', (e) => {
    preview.order.unitId = e.unitId;
    preview.order.tile = e.tile;
    preview.order.valid = e.valid;
    preview.order.unitIds = e.unitIds ?? [];
    preview.order.valids = e.valids ?? [];
  });
  ctx.bus.on('offensivePreview', (e) => {
    preview.offensive.tile = e.tile;
    preview.offensive.frontage = e.frontageTiles;
    preview.offensive.ratio = e.ratio;
    preview.offensive.valid = e.valid;
  });
  ctx.bus.on('simTick', (e) => sampleTrails(e));
  ctx.bus.on('worldHover', (e) => {
    if (icons) icons.hoverKey = e.unitId >= 0 ? e.unitId : e.structureId >= 0 ? -e.structureId - 1 : -1;
    hoverUnit = e.unitId;
  });
  ctx.bus.on('allianceFormed', () => (railDirty = true));
  ctx.bus.on('allianceBroken', () => (railDirty = true));
  ctx.bus.on('allianceExpired', () => (railDirty = true));

  // -----------------------------------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------------------------------
  function makeInst(geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, cap: number, anchored: boolean, name: string): InstMesh {
    const params = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iParams', params);
    let anchor: THREE.InstancedBufferAttribute | null = null;
    if (anchored) {
      anchor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iAnchor', anchor);
    }
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, white);
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    root.add(mesh);
    return { mesh, params, anchor, n: 0, cap };
  }

  function cityGhost(): THREE.BufferGeometry {
    const m = new ModelBuilder();
    m.cyl(0.5, 0.5, 0.01, 0, 0, 0, 0xffffff, 24);
    const hs = [0.5, 0.36, 0.3, 0.24, 0.2, 0.16, 0.14];
    hs.forEach((h, i) => {
      const a = i * 2.4, r = i === 0 ? 0 : 0.12 + i * 0.04;
      m.block(0.08, h, 0.08, Math.cos(a) * r, 0, Math.sin(a) * r, 0xffffff);
    });
    return m.build();
  }

  async function build(progress: (f: number) => void): Promise<void> {
    const unitMat = createModelMaterial();
    // One material for every structure part: the shader's minimum size is minPxScale (px, lod.structMinPx) against
    // the anchor size, which carries the per-type factor (see anchorSize()).
    const structMatAll = createModelMaterial({ anchored: true, minPx: 1 });
    const structMat = (_px: number) => structMatAll;
    let k = 0;
    const total = UNIT_MODELS.length + STRUCT_MODELS.length + 2;
    for (const key of UNIT_MODELS) {
      unitMeshes[key] = makeInst(buildUnitModel(key), unitMat, UNIT_CAP[key], false, `unit-${key}`);
      progress(++k / total);
      if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const beaconMat = createModelMaterial({ anchored: true, beacon: true, minPx: 0.4 });
    for (const key of STRUCT_MODELS) {
      const mat = key === 'beacon' ? beaconMat : structMat(1);
      structMeshes[key] = makeInst(buildStructModel(key), mat, STRUCT_CAP[key], true, `struct-${key}`);
      progress(++k / total);
      if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const cityMat = createModelMaterial({ anchored: true, city: true, minPx: 1 });
    buildings = makeInst(buildBuilding(), cityMat, MAX_BUILDINGS, true, 'city-buildings');
    spires = makeInst(buildSpire(), structMat(1), MAX_SPIRES, true, 'city-spires');
    progress(++k / total);
    rails = new SurfaceRibbon(60000, { widthKm: 0.14, minPx: 0.65, opacity: 0.85, lift: 1.2, name: 'units-rails', renderOrder: 6 });
    root.add(rails.mesh);
    overlays = new Overlays();
    root.add(overlays.group);
    icons = new IconLayer();
    icons.ownerColor = (o) => ctx.sim.view.players[o]?.color ?? 0xcccccc;
    root.add(icons.group);
    for (const t of Object.keys(STRUCT_INFO)) {
      const type = Number(t) as StructureType;
      const key = STRUCT_INFO[type].key;
      overlays.addGhost(String(type), type === StructureType.City ? cityGhost() : structMeshes[key].mesh.geometry);
    }
    progress(1);
    built = true;
  }

  // -----------------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------------
  function ownerColor(owner: number): THREE.Color {
    const p = ctx.sim.view.players[owner];
    let c = colorCache.get(owner);
    if (!c) {
      c = new THREE.Color();
      colorCache.set(owner, c);
    }
    c.setHex(p ? p.color : 0xcccccc);
    return c;
  }

  /** Write one instance: basis (right, up, back) scaled by sx/sy/sz at pos. */
  function put(im: InstMesh, pos: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, back: THREE.Vector3,
    sx: number, sy: number, sz: number, color: THREE.Color, p0: number, p1: number, p2: number, p3: number,
    anchor?: THREE.Vector3, anchorSize = 0): void {
    if (im.n >= im.cap) return;
    const i = im.n++;
    if (pbox.on) projectInstance(boxOf(im), pos, right, up, back, sx, sy, sz);
    const te = m4.elements;
    te[0] = right.x * sx; te[1] = right.y * sx; te[2] = right.z * sx; te[3] = 0;
    te[4] = up.x * sy; te[5] = up.y * sy; te[6] = up.z * sy; te[7] = 0;
    te[8] = back.x * sz; te[9] = back.y * sz; te[10] = back.z * sz; te[11] = 0;
    te[12] = pos.x; te[13] = pos.y; te[14] = pos.z; te[15] = 1;
    im.mesh.setMatrixAt(i, m4);
    im.mesh.setColorAt(i, color);
    const pa = im.params.array as Float32Array;
    pa[i * 4] = p0; pa[i * 4 + 1] = p1; pa[i * 4 + 2] = p2; pa[i * 4 + 3] = p3;
    if (im.anchor && anchor) {
      const aa = im.anchor.array as Float32Array;
      aa[i * 4] = anchor.x; aa[i * 4 + 1] = anchor.y; aa[i * 4 + 2] = anchor.z; aa[i * 4 + 3] = anchorSize;
    }
  }

  // Projected screen box (px) of the unit model instances put while pbox.on: what the player really sees of a model
  // (the minimum-size clamp and __units.stats().unitModelsInView measure this, not the intended size).
  const pbox = { on: false, x0: 0, y0: 0, x1: 0, y1: 0 };
  const corner = new THREE.Vector3();
  function boxOf(im: InstMesh): THREE.Box3 {
    const g = im.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox!;
  }
  function resetPBox(): void {
    pbox.x0 = pbox.y0 = Infinity;
    pbox.x1 = pbox.y1 = -Infinity;
  }
  function projectInstance(box: THREE.Box3, pos: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, back: THREE.Vector3,
    sx: number, sy: number, sz: number): void {
    for (let c = 0; c < 8; c++) {
      const bx = c & 1 ? box.max.x : box.min.x, by = c & 2 ? box.max.y : box.min.y, bz = c & 4 ? box.max.z : box.min.z;
      corner.copy(pos).addScaledVector(right, bx * sx).addScaledVector(up, by * sy).addScaledVector(back, bz * sz).project(ctx.camera);
      if (corner.z > 1) continue;
      const x = (corner.x * 0.5 + 0.5) * viewW, y = (0.5 - corner.y * 0.5) * viewH;
      if (x < pbox.x0) pbox.x0 = x;
      if (x > pbox.x1) pbox.x1 = x;
      if (y < pbox.y0) pbox.y0 = y;
      if (y > pbox.y1) pbox.y1 = y;
    }
  }
  const pboxPx = (): number => (pbox.x1 >= pbox.x0 ? Math.max(pbox.x1 - pbox.x0, pbox.y1 - pbox.y0) : 0);

  function commit(im: InstMesh): void {
    im.mesh.count = im.n;
    if (im.n === 0) return;
    im.mesh.instanceMatrix.clearUpdateRanges();
    im.mesh.instanceMatrix.addUpdateRange(0, im.n * 16);
    im.mesh.instanceMatrix.needsUpdate = true;
    const ic = im.mesh.instanceColor!;
    ic.clearUpdateRanges();
    ic.addUpdateRange(0, im.n * 3);
    ic.needsUpdate = true;
    im.params.clearUpdateRanges();
    im.params.addUpdateRange(0, im.n * 4);
    im.params.needsUpdate = true;
    if (im.anchor) {
      im.anchor.clearUpdateRanges();
      im.anchor.addUpdateRange(0, im.n * 4);
      im.anchor.needsUpdate = true;
    }
  }

  function modelFor(t: UnitType): UnitModelKey | null {
    switch (t) {
      case UnitType.TransportShip: return 'transport';
      case UnitType.TradeShip: return 'trade';
      case UnitType.Warship: return 'warship';
      case UnitType.ArmoredDivision: return 'tank';
      case UnitType.FighterSquadron: return 'fighter';
      case UnitType.Bomber: return 'bomber';
      case UnitType.DroneSwarm: return 'drone';
      case UnitType.CruiseMissile: return 'cruise';
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.Mirv: return 'icbm';
      case UnitType.MirvWarhead: return 'warhead';
      case UnitType.SamInterceptor: return 'sam';
      case UnitType.Train: return 'loco';
      default: return null;
    }
  }

  const isShip = (t: UnitType) => t === UnitType.TransportShip || t === UnitType.TradeShip || t === UnitType.Warship;
  const isBallistic = (t: UnitType) => t === UnitType.AtomBomb || t === UnitType.HydrogenBomb || t === UnitType.Mirv || t === UnitType.MirvWarhead;
  const isAir = (t: UnitType) => t === UnitType.FighterSquadron || t === UnitType.Bomber || t === UnitType.DroneSwarm;

  function rangeKm(u: UnitView): number {
    tileXYToLatLon(u.originX, u.originY, ll2);
    const la = ll2.lat, lo = ll2.lon;
    tileXYToLatLon(u.targetX, u.targetY, ll2);
    const dLat = (ll2.lat - la) * (Math.PI / 180);
    let dLon = ll2.lon - lo;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    const x = dLon * (Math.PI / 180) * Math.cos(((la + ll2.lat) / 2) * (Math.PI / 180));
    return Math.sqrt(dLat * dLat + x * x) * EARTH_RADIUS_KM;
  }

  function getTrack(u: UnitView): Track {
    let t = tracks.get(u.id);
    if (!t) {
      t = trackPool.pop() ?? {
        id: 0, type: UnitType.Shell as UnitType, seen: 0, trails: [], pos: new THREE.Vector3(), ground: new THREE.Vector3(), fwd: new THREE.Vector3(),
        hasPos: false, bank: 0, size: 0, lat: 0, lon: 0, idle: 0, ship: false, range: 0, apex: 0,
      };
      t.id = u.id;
      t.type = u.type;
      t.trails.length = 0;
      t.hasPos = false;
      t.bank = 0;
      t.idle = 0;
      t.fwd.set(0, 0, 0);
      tracks.set(u.id, t);
    }
    return t;
  }

  function releaseTrack(t: Track, fx: FxInternal | undefined): void {
    if (fx) for (const tr of t.trails) fx.trails.release(tr);
    t.trails.length = 0;
    tracks.delete(t.id);
    trackPool.push(t);
  }

  /** Trail lengths in multiples of the drawn unit size (0 = time-limited only). */
  const TRAIL_LEN: Partial<Record<TrailStyleKey, number>> = { wake: 5, contrail: 6, dust: 4, smoke: 14, samSmoke: 12, exhaust: 1.2, shell: 18 };

  function trail(fx: FxInternal, t: Track, slot: number, style: TrailStyleKey, p: THREE.Vector3, color?: THREE.Color): void {
    let tr = t.trails[slot];
    if (!tr) tr = t.trails[slot] = fx.trails.start(style, p.x, p.y, p.z, color);
    else fx.trails.push(tr, p.x, p.y, p.z);
    const k = TRAIL_LEN[style] ?? 0;
    tr.maxLen = k > 0 ? (k * t.size) / EARTH_RADIUS_KM : 0;
  }

  function stopTrail(fx: FxInternal, t: Track, slot: number): void {
    const tr = t.trails[slot];
    if (tr) {
      fx.trails.release(tr);
      t.trails[slot] = null;
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Units
  // -----------------------------------------------------------------------------------------------
  const nukeRefs: { x: number; y: number; apex: number }[] = [];
  let nukeRefN = 0;
  const arcColor = new THREE.Color();
  const TANK_OFFS = [[0, -1.0], [-0.7, 0.05], [0.7, 0.05], [0, 1.1]];
  const PA = new THREE.Vector3(), PB = new THREE.Vector3();

  function refreshNukeRefs(): void {
    nukeRefN = 0;
    for (const u of ctx.sim.view.units.values()) {
      if (!isBallistic(u.type)) continue;
      if (nukeRefN >= nukeRefs.length) nukeRefs.push({ x: 0, y: 0, apex: 0 });
      const r = nukeRefs[nukeRefN++];
      r.x = u.x;
      r.y = u.y;
      r.apex = ballisticApexKm(rangeKm(u));
    }
  }

  /** World position of unit u at sim coordinates (x, y, alt) with a given drawn size. */
  function worldAt(u: UnitView, t: Track, x: number, y: number, alt: number, sizeKm: number, out: THREE.Vector3): THREE.Vector3 {
    tileXYToLatLon(x, y, ll2);
    const gr = t.ship ? seaRadius(ll2.lat, ll2.lon) : ctx.globe.meshRadiusAt(ll2.lat, ll2.lon);
    const h = airHeightKm(u.type, alt, sizeKm, t.range, t.apex);
    return latLonToVec3(ll2.lat, ll2.lon, gr + h / EARTH_RADIUS_KM, out);
  }

  /**
   * Pose of unit u at (x, y, alt, heading): fills P (position), G (ground below), E/N/U (tangent frame) and the model
   * basis R/UP/B, and t.size / t.range / t.apex. Missiles and shells face along their sim-space velocity (so they pitch
   * along the ballistic arc), aircraft bank into turns. Returns the drawn size in world units.
   */
  function pose(u: UnitView, t: Track, x: number, y: number, alt: number, heading: number, unitK: number, bankRate: boolean): number {
    tileXYToLatLon(x, y, ll);
    tangentFrame(ll.lat, ll.lon, E, N, U);
    t.ship = isShip(u.type);
    // Land units stand on the relief as the globe mesh draws it (meshRadiusAt), like structures.
    const gr = t.ship ? seaRadius(ll.lat, ll.lon) : ctx.globe.meshRadiusAt(ll.lat, ll.lon);
    G.copy(U).multiplyScalar(gr);
    const sizeKm = unitSizeKm(u.type, env.camPos.distanceTo(G)) * (u.type === UnitType.Shell ? 1 : unitK);
    t.size = sizeKm;
    let apex = 0;
    if (u.type === UnitType.SamInterceptor && nukeRefN > 0) {
      let best = Infinity;
      for (let i = 0; i < nukeRefN; i++) {
        const r = nukeRefs[i];
        const dx = wrapDX(u.targetX, r.x), dy = r.y - u.targetY;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          apex = r.apex;
        }
      }
      if (best > 60 * 60) apex = 0;
    }
    t.apex = apex;
    t.range = u.type === UnitType.Shell || isBallistic(u.type) ? rangeKm(u) : 0;
    const hKm = airHeightKm(u.type, alt, sizeKm, t.range, apex);
    P.copy(U).multiplyScalar(gr + hKm / EARTH_RADIUS_KM);
    const s = sizeKm / EARTH_RADIUS_KM;
    const guided = isBallistic(u.type) || u.type === UnitType.SamInterceptor || u.type === UnitType.Shell || u.type === UnitType.CruiseMissile;
    F.copy(N).multiplyScalar(Math.cos(heading)).addScaledVector(E, Math.sin(heading));
    if (guided) {
      worldAt(u, t, u.prevX, u.prevY, u.prevAlt, sizeKm, PA);
      worldAt(u, t, u.x, u.y, u.alt, sizeKm, PB);
      PB.sub(PA);
      const d = PB.length();
      if (d > s * 0.01) {
        F.copy(PB).multiplyScalar(1 / d);
        t.fwd.copy(F);
      } else if (t.fwd.lengthSq() > 0.5) F.copy(t.fwd);
      else if (isBallistic(u.type) && u.type !== UnitType.MirvWarhead) F.lerp(U, 0.8).normalize();
    }
    UP.copy(U).addScaledVector(F, -U.dot(F));
    if (UP.lengthSq() < 1e-8) UP.copy(N);
    UP.normalize();
    R.crossVectors(F, UP).normalize();
    if (isAir(u.type)) {
      if (bankRate) {
        const rate = angleDelta(u.prevHeading, u.heading) / 0.1;
        t.bank = lerp(t.bank, clamp(rate * 0.5, -0.75, 0.75), 0.1);
      }
      const cb = Math.cos(t.bank), sb = Math.sin(t.bank);
      T.copy(R).multiplyScalar(cb).addScaledVector(UP, sb);
      UP.multiplyScalar(cb).addScaledVector(R, -sb);
      R.copy(T);
    }
    B.copy(F).negate();
    return s;
  }

  const RA = new THREE.Vector3(), RB = new THREE.Vector3();
  /**
   * A train rides the rail as drawn (FEEDBACK-1 item 15): the sim moves it in a straight line in map space between
   * stations, the rail is drawn as the great circle between their tile centres, so place it at the same fraction
   * along that great circle, facing the next station (sim-space headings skew by up to 1/cos(lat) off the line).
   * Rewrites P / G and the model basis; `s` is the drawn size (world units).
   */
  function railFrame(u: UnitView, x: number, y: number): void {
    const r = ctx.sim.view.routes.get(u.id);
    if (!r || r.length < 2) return;
    let best = Infinity, bi = -1, bt = 0;
    for (let i = 0; i + 1 < r.length; i++) {
      const ax = (r[i] % MAP_W) + 0.5, ay = Math.floor(r[i] / MAP_W) + 0.5;
      const dx = wrapDX(ax, (r[i + 1] % MAP_W) + 0.5), dy = Math.floor(r[i + 1] / MAP_W) + 0.5 - ay;
      const px = wrapDX(ax, x), py = y - ay;
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-9) continue;
      const t = clamp((px * dx + py * dy) / L2, 0, 1);
      const ex = t * dx - px, ey = t * dy - py, d = ex * ex + ey * ey;
      if (d < best) {
        best = d;
        bi = i;
        bt = t;
      }
    }
    if (bi < 0 || best > 4) return;
    tileToLatLon(r[bi], ll2);
    latLonToVec3(ll2.lat, ll2.lon, 1, RA);
    tileToLatLon(r[bi + 1], ll2);
    latLonToVec3(ll2.lat, ll2.lon, 1, RB);
    const ang = Math.acos(clamp(RA.dot(RB), -1, 1));
    if (ang < 1e-7) return;
    const sa = Math.sin(ang);
    const ka = Math.sin((1 - bt) * ang) / sa, kb = Math.sin(bt * ang) / sa;
    U.set(RA.x * ka + RB.x * kb, RA.y * ka + RB.y * kb, RA.z * ka + RB.z * kb).normalize();
    vec3ToLatLon(U, ll);
    const gr = ctx.globe.meshRadiusAt(ll.lat, ll.lon);
    G.copy(U).multiplyScalar(gr);
    P.copy(G);
    // Forward: the great circle's tangent toward the next station.
    F.copy(RB).addScaledVector(U, -RB.dot(U));
    if (F.lengthSq() < 1e-14) return;
    F.normalize();
    UP.copy(U);
    R.crossVectors(F, UP).normalize();
    B.copy(F).negate();
  }

  /**
   * Feed the unit's trails from the current pose. `frame` = per-frame live head (may also stop trails),
   * otherwise a sim-tick sample (commits points at sim rate, independent of the frame rate).
   */
  function emitTrails(fx: FxInternal, u: UnitView, t: Track, s: number, alt: number, active: boolean, surfaceMoving: boolean, frame: boolean): void {
    emitFx = fx;
    emitT = t;
    emitFrame = frame;
    switch (u.type) {
      case UnitType.FighterSquadron:
        for (let j = 0; j < 3; j++) {
          const ox = j === 0 ? 0 : j === 1 ? -0.95 : 0.95, oz = j === 0 ? 0 : 0.85;
          T.copy(P).addScaledVector(R, ox * s).addScaledVector(B, (oz + 0.5) * s);
          emit(j, 'contrail', T, active && alt > 0.35, alt <= 0.35);
        }
        return;
      case UnitType.Bomber:
        for (let j = 0; j < 2; j++) {
          T.copy(P).addScaledVector(R, (j === 0 ? -0.2 : 0.2) * s).addScaledVector(B, 0.2 * s);
          emit(j, 'contrail', T, active && alt > 0.35, alt <= 0.35);
        }
        return;
      case UnitType.ArmoredDivision:
        T.copy(G).addScaledVector(B, 1.6 * s);
        emit(0, 'dust', T, active && surfaceMoving, frame && t.idle > 1.5);
        return;
      case UnitType.TransportShip:
      case UnitType.TradeShip:
      case UnitType.Warship:
        // The white wake stays only up close (below 300 km); from higher up the owner-coloured route tells the story.
        T.copy(G).addScaledVector(B, 0.46 * s);
        emit(0, 'wake', T, active && surfaceMoving && env.altitudeKm < 300, frame && (t.idle > 1.5 || env.altitudeKm >= 300));
        return;
      case UnitType.Shell:
        emit(0, 'shell', P, active, false);
        return;
      case UnitType.DroneSwarm:
      case UnitType.Train:
        return;
    }
    T.copy(P).addScaledVector(B, 0.5 * s);
    if (isBallistic(u.type)) {
      if (u.type === UnitType.MirvWarhead) {
        emit(0, 'exhaust', T, active, false);
        emit(1, 'smoke', T, active, false);
      } else {
        emit(0, 'nukeSmoke', T, active, false);
        emit(1, 'exhaust', T, active, false);
        arcColor.copy(ownerColor(u.owner)).multiplyScalar(1.6);
        emit(2, 'arc', T, active, false, arcColor);
      }
    } else if (u.type === UnitType.CruiseMissile) {
      emit(0, 'smoke', T, active, false);
      emit(1, 'exhaust', T, active, false);
    } else if (u.type === UnitType.SamInterceptor) {
      emit(0, 'samSmoke', T, active, false);
      emit(1, 'exhaust', T, active, false);
    }
  }

  // Emitter context (module scratch instead of a per-call closure: no allocation in the frame loop).
  let emitFx: FxInternal | null = null;
  let emitT: Track | null = null;
  let emitFrame = false;
  /**
   * `want`: the emitter produces trail now. Otherwise, on frames, an existing trail's head still follows the
   * (interpolated) emitter so it stays attached while paused; it is released on the stop condition.
   */
  function emit(slot: number, style: TrailStyleKey, p: THREE.Vector3, want: boolean, stop: boolean, color?: THREE.Color): void {
    const fx = emitFx!, t = emitT!;
    if (want) trail(fx, t, slot, style, p, color);
    else if (stop) stopTrail(fx, t, slot);
    else if (emitFrame && t.trails[slot]) trail(fx, t, slot, style, p, color);
  }

  function unitScaleK(): number {
    return clamp(1.25 - env.altitudeKm / 30000, 0.65, 1);
  }

  /**
   * On every applied sim update, commit trail points at each unit's previous sim position (where the interpolated
   * render position is leaving from), so trails keep sim-rate detail at any frame rate and game speed.
   */
  function sampleTrails(e: { ticks: number }): void {
    const fx = fxInternal(ctx);
    if (!fx || !built || e.ticks <= 0 || ctx.app.state === 'command') return;
    refreshNukeRefs();
    const unitK = unitScaleK();
    for (const u of ctx.sim.view.units.values()) {
      if (isAir(u.type) && u.state === UnitState.Docked) continue;
      const t = getTrack(u);
      const moved = Math.abs(u.x - u.prevX) + Math.abs(u.y - u.prevY) > 1e-4;
      const s = pose(u, t, u.prevX, u.prevY, u.prevAlt, u.prevHeading, unitK, false);
      emitTrails(fx, u, t, s, u.prevAlt, true, moved, false);
    }
  }

  /** Screen position (CSS px, canvas-relative) of a world point, false when behind the planet or off screen. */
  function toScreen(p: THREE.Vector3, margin = 24): boolean {
    const c = env.camPos;
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    const dd = dx * dx + dy * dy + dz * dz;
    const t = clamp(-(c.x * dx + c.y * dy + c.z * dz) / Math.max(dd, 1e-12), 0, 1);
    if (t < 0.999) {
      const qx = c.x + dx * t, qy = c.y + dy * t, qz = c.z + dz * t;
      if (qx * qx + qy * qy + qz * qz < 0.997) return false;
    }
    scr.copy(p).project(ctx.camera);
    if (scr.z > 1) return false;
    scrXY.x = (scr.x * 0.5 + 0.5) * viewW;
    scrXY.y = (0.5 - scr.y * 0.5) * viewH;
    return scrXY.x > -margin && scrXY.x < viewW + margin && scrXY.y > -margin && scrXY.y < viewH + margin;
  }

  /** Icon size class of a unit: 0 full, 1 small floating, 2 pip, 3 civilian (trade ships, trains). */
  function iconSize(t: UnitType): number {
    if (t === UnitType.Shell || t === UnitType.SamInterceptor) return 2;
    if (lod.unitIconMode === 2) return 2;
    if (lod.unitIconMode === 1) return 1;
    return t === UnitType.TradeShip || t === UnitType.Train ? 3 : 0;
  }

  /** In the world view: only the human's and its enemies' military units get an icon, never over a nation label. */
  function worldViewHides(u: UnitView): boolean {
    if (u.type === UnitType.TradeShip || u.type === UnitType.Train) return true;
    if (u.owner !== HUMAN_ID && relations.relationTo(u.owner) !== 'war') return true;
    const r = 13;
    for (const q of labelRects()) {
      if (scrXY.x + r > q.x0 && scrXY.x - r < q.x1 && scrXY.y + r > q.y0 && scrXY.y - r < q.y1) return true;
    }
    return false;
  }

  const lineW = new THREE.Vector3(), ownW = new THREE.Vector3(), lineS = new THREE.Vector3(), ownS = new THREE.Vector3();
  const clearOff = { x: 0, y: 0 };
  /**
   * W6: a division attached to a front stands on the contact line; from orbit (icons only) its icon is drawn beside the
   * front's band on its own side, so the band, its chevrons and the arrows stay readable. Needs scrXY of the unit.
   */
  function frontClearOffset(u: UnitView, iconHalf: number): void {
    clearOff.x = clearOff.y = 0;
    if (u.type !== UnitType.ArmoredDivision || !u.frontKey || env.altitudeKm < 600) return;
    const f = ctx.sim.view.frontByKey.get(u.frontKey);
    if (!f || f.samples.length < 2) return;
    const s = f.samples;
    const n = s.length >> 1;
    let m = 0, bd = Infinity;
    for (let v = 0; v < n; v++) {
      const dx = wrapDX(u.x, s[v * 2]), dy = s[v * 2 + 1] - u.y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        m = v;
      }
    }
    const own = u.owner === f.a ? -1 : u.owner === f.b ? 1 : 0;
    if (!own) return;
    const lx = s[m * 2] + f.dirX * 0.5, ly = s[m * 2 + 1] + f.dirY * 0.5;
    const l0 = tileXYToLatLon(lx, ly), l1 = tileXYToLatLon(lx + f.dirX * own, ly + f.dirY * own);
    latLonToVec3(l0.lat, l0.lon, 1.003, lineW);
    latLonToVec3(l1.lat, l1.lon, 1.003, ownW);
    lineS.copy(lineW).project(ctx.camera);
    ownS.copy(ownW).project(ctx.camera);
    if (lineS.z > 1 || ownS.z > 1) return;
    const lxp = (lineS.x * 0.5 + 0.5) * viewW, lyp = (0.5 - lineS.y * 0.5) * viewH;
    let nx = (ownS.x * 0.5 + 0.5) * viewW - lxp, ny = (0.5 - ownS.y * 0.5) * viewH - lyp;
    const tilePx = Math.hypot(nx, ny);
    if (tilePx < 1e-3) return;
    nx /= tilePx;
    ny /= tilePx;
    // The band is 0.75 tile wide each side, at least 7 px; the icon clears it with a 3 px gap.
    const need = Math.max(9, tilePx * 0.75) + iconHalf + 3;
    const dist = (scrXY.x - lxp) * nx + (scrXY.y - lyp) * ny;
    if (dist >= need) return;
    clearOff.x = nx * (need - dist);
    clearOff.y = ny * (need - dist);
  }

  function offerUnitIcon(u: UnitView, pos: THREE.Vector3, sel: boolean, dxPx = 0, dyPx = 0): void {
    if (!icons || !toScreen(pos)) return;
    if (lod.worldView && !sel && worldViewHides(u)) return;
    if (lod.unitIconMode === 0) {
      const sx = scrXY.x, sy = scrXY.y;
      frontClearOffset(u, 11);
      scrXY.x = sx;
      scrXY.y = sy;
      dxPx += clearOff.x;
      dyPx += clearOff.y;
    }
    const size = iconSize(u.type);
    // Small icons float above the model; pips sit just above it.
    const lift = size === 1 ? 16 : size === 2 && lod.unitIconMode === 2 && u.type !== UnitType.Shell && u.type !== UnitType.SamInterceptor ? 11 : 0;
    icons.add(false, u.id, u.type, u.owner, relations.relationTo(u.owner), scrXY.x + dxPx, scrXY.y + dyPx - lift, u.hp, 0, sel, size, unitCategory(u.type));
  }

  /**
   * Waterline radius of a ship: the drawn sea surface (the globe mesh's relief, which near islands and coasts lifts the
   * water by up to a few hundred metres through texture filtering), plus 10 % of that lift for the mesh's own
   * interpolation. A ship at radius 1 sank under the drawn sea at close zoom (owner clarification to FEEDBACK-1).
   */
  function seaRadius(lat: number, lon: number): number {
    const r = ctx.globe.meshRadiusAt(lat, lon);
    return r + Math.max(0, r - 1) * 0.1;
  }

  /** Projectiles and sub-munitions are small by design (no minimum rendered size). */
  function isProjectile(t: UnitType): boolean {
    return t === UnitType.Shell || t === UnitType.SamInterceptor || t === UnitType.MirvWarhead;
  }

  function makeRouteEnv(fx: FxInternal): RouteEnv {
    if (!routeEnv) {
      routeEnv = {
        fx, now: 0, realNow: 0, altitudeKm: 0, frozen: false,
        pathOf: (id) => ctx.sim.view.routes.get(id),
        clearKm: (id) => {
          const t = tracks.get(id);
          return t && t.hasPos && lod.unitModelFade > 0 ? t.size * (isAir(t.type) ? 1.6 : 0.6) + 2 * env.pixelK * env.camPos.distanceTo(t.pos) * EARTH_RADIUS_KM : 0;
        },
        relationTo: (o) => relations.relationTo(o),
        radiusAt,
        ownerColor: (o) => ownerColor(o),
        ownerOfXY: (x, y) => ctx.sim.view.owner[Math.min(799, Math.max(0, Math.floor(y))) * MAP_W + ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W] ?? 0,
      };
    }
    routeEnv.fx = fx;
    // &freeze=1: route clocks stand still (plans rebuild when a unit moves, lines of vanished units go at once).
    routeEnv.frozen = shotView.freeze;
    routeEnv.now = shotView.freeze ? FROZEN_TIME_SEC : env.fxTime;
    routeEnv.realNow = routes.clock();
    routeEnv.altitudeKm = env.altitudeKm;
    return routeEnv;
  }

  /**
   * Parked aircraft on the apron: length as a fraction of the drawn airbase footprint (slots are 0.11 apart), and a
   * minimum on-screen length (px) so a docked squadron reads as an aircraft, not a speck, at 40 km and below.
   */
  const PARKED: Record<4 | 5 | 6, number> = { 4: 0.12, 5: 0.082, 6: 0.066 };
  const PARKED_PX: Record<4 | 5 | 6, number> = { 4: 26, 5: 28, 6: 20 };

  /** Apron slot of a docked aircraft: its rank among the docked aircraft of its base (by id), rebuilt per frame. */
  const dockRank = new Map<number, number>();
  let dockFrame = -1;
  function dockSlot(u: UnitView): number {
    if (dockFrame !== seenGen) {
      dockFrame = seenGen;
      dockRank.clear();
      const per = new Map<number, number[]>();
      for (const x of ctx.sim.view.units.values()) {
        if (!isAir(x.type) || x.state !== UnitState.Docked) continue;
        (per.get(x.home) ?? per.set(x.home, []).get(x.home)!).push(x.id);
      }
      for (const ids of per.values()) {
        ids.sort((a, b) => a - b);
        ids.forEach((id, i) => dockRank.set(id, i));
      }
    }
    return dockRank.get(u.id) ?? -1;
  }

  /** Relief radius under a world direction. */
  function radiusUnder(v: THREE.Vector3): number {
    const l = v.length();
    return ctx.globe.meshRadiusAt(Math.asin(clamp(v.y / l, -1, 1)) * (180 / Math.PI), Math.atan2(-v.z, v.x) * (180 / Math.PI));
  }

  /**
   * Stand one tank of size s (world units) on the relief at Q: its up vector follows the slope under its tracks
   * (front/back and left/right samples, at most 30 degrees), its base at the highest of the centre and the mean of the
   * samples, so an enlarged tank never sinks into a hillside nor hangs over it. Writes Q and the basis tR/tU/tB.
   */
  const tR = new THREE.Vector3(), tU = new THREE.Vector3(), tB = new THREE.Vector3(), tA = new THREE.Vector3();
  function groundTank(q: THREE.Vector3, s: number): void {
    q.normalize();
    const hC = radiusUnder(q);
    const hF = radiusUnder(tA.copy(q).addScaledVector(B, -0.42 * s)), hBk = radiusUnder(tA.copy(q).addScaledVector(B, 0.42 * s));
    const hR = radiusUnder(tA.copy(q).addScaledVector(R, 0.2 * s)), hL = radiusUnder(tA.copy(q).addScaledVector(R, -0.2 * s));
    const slopeF = clamp((hF - hBk) / (0.84 * s), -0.58, 0.58), slopeR = clamp((hR - hL) / (0.4 * s), -0.58, 0.58);
    tU.copy(q).addScaledVector(B, slopeF).addScaledVector(R, -slopeR).normalize();
    tR.copy(R).addScaledVector(tU, -R.dot(tU)).normalize();
    tB.copy(B).addScaledVector(tU, -B.dot(tU)).addScaledVector(tR, -B.dot(tR)).normalize();
    q.multiplyScalar(Math.max(hC, (hF + hBk + hR + hL) / 4));
  }

  function updateUnits(frame: FrameInfo, fx: FxInternal | undefined): void {
    const view = ctx.sim.view;
    modelView.n = 0;
    modelView.minPx = Infinity;
    modelView.list.length = 0;
    for (const key of UNIT_MODELS) unitMeshes[key].n = 0;
    const renv = fx ? makeRouteEnv(fx) : null;
    routes.focus.clear();
    for (const id of selectedUnits) routes.focus.add(id);
    if (hoverUnit >= 0) routes.focus.add(hoverUnit);
    routes.begin();
    const gen = ++seenGen;
    const a = clamp(frame.simAlpha, 0, 1);
    const unitK = unitScaleK();
    const active = env.fxDt > 0;
    refreshNukeRefs();
    for (const u of view.units.values()) {
      const key = modelFor(u.type);
      const t = getTrack(u);
      t.seen = gen;
      if (renv) routes.unit(renv, u, Math.abs(u.x - u.prevX) + Math.abs(u.y - u.prevY) > 1e-4);
      if (isAir(u.type) && u.state === UnitState.Docked) {
        if (fx) for (let s = 0; s < t.trails.length; s++) stopTrail(fx, t, s);
        // Docked aircraft (§7.2, W4): parked on their airbase's apron, one slot each, drawn as models when the base's
        // model is drawn, and pickable there; from orbit an icon beside the base (they cluster into one badge).
        const base = view.structures.get(u.home);
        const g = base ? grounds.get(base.id) : undefined;
        const slot = dockSlot(u);
        if (base && g && slot >= 0) {
          const [sx, sz] = AIRBASE_SLOTS[slot % AIRBASE_SLOTS.length];
          const Se = drawnStructSize(base, g);
          T.copy(g.anchor).addScaledVector(g.right, sx * Se).addScaledVector(g.back, sz * Se).addScaledVector(g.up, 0.006 * Se);
        } else {
          tileXYToLatLon(u.x, u.y, ll2);
          latLonToVec3(ll2.lat, ll2.lon, ctx.globe.surfaceRadiusAt(ll2.lat, ll2.lon), T);
        }
        t.pos.copy(T);
        t.ground.copy(T);
        vec3ToLatLon(T, ll2);
        t.lat = ll2.lat;
        t.lon = ll2.lon;
        t.hasPos = true;
        t.size = g ? g.S * 0.07 * EARTH_RADIUS_KM : 0.4;
        if (key && g && base && slot >= 0 && structModelsOn && lod.structModelFade > 0) {
          // The base as drawn this frame (its minimum on-screen size may enlarge it): slot positions and aircraft
          // follow it. Aircraft keep a small minimum on-screen size of their own, capped so neighbours never touch.
          const Se = drawnStructSize(base, g);
          const [sx, sz] = AIRBASE_SLOTS[slot % AIRBASE_SLOTS.length];
          T.copy(g.anchor).addScaledVector(g.right, sx * Se).addScaledVector(g.back, sz * Se).addScaledVector(g.up, 0.006 * Se);
          t.pos.copy(T);
          t.ground.copy(T);
          const frac = PARKED[u.type as 4 | 5 | 6] ?? 0.1;
          const wpp = env.pixelK * env.camPos.distanceTo(T);
          const s = Math.min(frac * Se * 1.1, Math.max(frac * Se, PARKED_PX[u.type as 4 | 5 | 6] * wpp));
          t.size = s * EARTH_RADIUS_KM;
          F.copy(g.back).negate();
          const sel = selectedUnits.has(u.id) ? 1 : 0;
          const col = ownerColor(u.owner);
          const im = unitMeshes[key];
          if (u.type === UnitType.DroneSwarm) {
            for (let j = 0; j < 3; j++) {
              Q.copy(T).addScaledVector(g.right, (j - 1) * s * 0.75).addScaledVector(g.back, (j === 1 ? -0.25 : 0.1) * s);
              put(im, Q, g.right, g.up, g.back, s * 0.7, s * 0.7, s * 0.7, col, 1, sel, u.hp, 0);
            }
          } else put(im, T, g.right, g.up, g.back, s, s, s, col, 1, sel, u.hp, 0);
        }
        if (lod.unitIconMode !== 2) offerUnitIcon(u, T, selectedUnits.has(u.id), 15, -12);
        continue;
      }
      const x = lerp(u.prevX, u.x, a), y = lerp(u.prevY, u.y, a);
      const alt = lerp(u.prevAlt, u.alt, a);
      const heading = lerpAngle(u.prevHeading, u.heading, a);
      let s = pose(u, t, x, y, alt, heading, unitK, true);
      // Minimum rendered size (owner clarification to FEEDBACK-1: close models clearly visible): the model's projected
      // bounding box must reach its minimum on-screen size (lod.unitMinPx x UNIT_LOOK.pxK: 40 px for a ship at 300 km,
      // 52 at 100 km, 64 from 30 km) whatever the view angle; a ship seen bow-on or a flat hull seen from above is
      // scaled up until its drawn box does (at most 4x).
      const measured = !!key && lod.unitModelFade > 0 && !isProjectile(u.type);
      if (measured && key) {
        const want = unitMinPxOf(u.type);
        resetPBox();
        projectInstance(boxOf(unitMeshes[key]), P, R, UP, B, s, s, s);
        const ext = pboxPx();
        if (ext > 0.5 && ext < want) s = pose(u, t, x, y, alt, heading, unitK * Math.min(4, want / ext), false);
      }
      t.lat = ll.lat;
      t.lon = ll.lon;
      t.ground.copy(G);
      t.pos.copy(P);
      t.hasPos = true;
      const col = ownerColor(u.owner);
      const sel = selectedUnits.has(u.id) ? 1 : 0;
      const hp = u.hp;
      const isMoving = Math.abs(u.x - u.prevX) + Math.abs(u.y - u.prevY) > 1e-4;
      t.idle = isMoving ? 0 : t.idle + frame.dt;
      if (fx) emitTrails(fx, u, t, s, alt, active, isMoving, true);
      // Above 1,200 km units are icons only: no model instances at all.
      if (!key || lod.unitModelFade <= 0) {
        offerUnitIcon(u, P, sel === 1);
        continue;
      }
      // v2 (W6): a division the visible ground battle draws at battle scale is not drawn twice.
      if (battleOwned && battleOwned.has(u.id)) continue;
      resetPBox();
      pbox.on = true;
      const im = unitMeshes[key];
      const seed = (u.id * 0.618) % 1;
      switch (u.type) {
        case UnitType.FighterSquadron: {
          for (let j = 0; j < 3; j++) {
            const ox = j === 0 ? 0 : j === 1 ? -0.95 : 0.95, oz = j === 0 ? 0 : 0.85;
            const bob = Math.sin(env.time * 1.3 + j * 2.1 + u.id) * 0.08;
            Q.copy(P).addScaledVector(R, ox * s).addScaledVector(B, oz * s).addScaledVector(UP, bob * s);
            put(im, Q, R, UP, B, s, s, s, col, 1, sel, hp, seed);
          }
          break;
        }
        case UnitType.DroneSwarm: {
          // Five drones in a loose, slowly weaving formation (fewer and larger reads better than a cloud of specks).
          for (let j = 0; j < 5; j++) {
            const ang = j * 2.39996 + env.time * 0.4 * (j % 2 === 0 ? 1 : -1);
            const rr = j === 0 ? 0 : 0.85 + 0.3 * (j % 2);
            const bob = Math.sin(env.time * 2 + j * 1.7) * 0.15;
            Q.copy(P).addScaledVector(R, Math.cos(ang) * rr * s).addScaledVector(B, Math.sin(ang) * rr * s + 0.3 * s).addScaledVector(UP, bob * s);
            put(im, Q, R, UP, B, s, s, s, col, 1, sel, hp, seed + j * 0.1);
          }
          break;
        }
        case UnitType.ArmoredDivision: {
          // One tank per 25 % of integrity (§6.3): a worn division is visibly thinner.
          const tanks = Math.max(1, Math.min(4, Math.ceil(hp * 4 - 1e-6)));
          for (let j = 0; j < tanks; j++) {
            Q.copy(G).addScaledVector(R, TANK_OFFS[j][0] * s).addScaledVector(B, TANK_OFFS[j][1] * s);
            groundTank(Q, s);
            put(im, Q, tR, tU, tB, s, s, s, col, 1, sel, hp, seed);
          }
          break;
        }
        case UnitType.Train: {
          railFrame(u, x, y);
          t.pos.copy(P);
          t.ground.copy(G);
          put(im, P, R, UP, B, s, s, s, col, 1, sel, hp, seed);
          const wag = unitMeshes.wagon;
          for (let j = 1; j <= 3; j++) {
            Q.copy(P).addScaledVector(B, j * 1.02 * s);
            put(wag, Q, R, UP, B, s, s, s, col, 1, sel, hp, seed);
          }
          break;
        }
        default:
          put(im, P, R, UP, B, s, s, s, col, 1, sel, hp, seed);
      }
      pbox.on = false;
      // Measurement (__units.stats()): models in the frustum and above the horizon, with the projected size of what
      // was drawn (the union of the instances' bounding boxes, px).
      const inView = toScreen(P, 0);
      const px = pboxPx();
      if (inView) {
        modelView.n++;
        // Minimum over vehicles (projectiles and sub-munitions are small by design).
        if (measured) modelView.minPx = Math.min(modelView.minPx, px);
        if (modelView.list.length < 200) {
          modelView.list.push({ id: u.id, type: u.type, px: +px.toFixed(1), x: Math.round((pbox.x0 + pbox.x1) / 2), y: Math.round((pbox.y0 + pbox.y1) / 2),
            w: Math.round(pbox.x1 - pbox.x0), h: Math.round(pbox.y1 - pbox.y0) });
        }
      }
      // The owner pip: below 300 km it sits above the drawn model instead of on it (the model is the unit now).
      if (measured && px > 0 && lod.unitIconMode === 2 && env.altitudeKm < 300 && toScreen(P)) {
        offerUnitIcon(u, P, sel === 1, 0, Math.min(0, pbox.y0 - 8 - scrXY.y + 11));
      } else offerUnitIcon(u, P, sel === 1);
    }
    // Vanished units: release their trails, play small terminal effects.
    for (const t of tracks.values()) {
      if (t.seen === gen) continue;
      if (fx && t.hasPos) {
        if (t.type === UnitType.Shell) {
          const w = ctx.world;
          const water = !w || isWaterTerrain(w.terrain[latLonTile(t.lat, t.lon)]);
          T.copy(t.ground);
          if (water) fx.splash(T, fx.visKm(T, 0.8, 6));
          else fx.explosionAt(T, fx.visKm(T, 0.9, 6), 'small');
        } else if (t.type === UnitType.Mirv) {
          // Bus separation: a bright pop where the warheads deploy.
          const k = fx.visKm(t.pos, 6, 14) / EARTH_RADIUS_KM;
          fx.particles.emit(PK.Flash, t.pos.x, t.pos.y, t.pos.z, 0, 0, 0, 0.6, k * 0.6, k * 1.6);
          fx.particles.emit(PK.White, t.pos.x, t.pos.y, t.pos.z, 0, 0, 0, 5, k * 0.4, k * 2.2, 0.5, 0);
        }
      }
      releaseTrack(t, fx);
    }
    for (const key of UNIT_MODELS) commit(unitMeshes[key]);
    if (renv) {
      routes.end(renv);
      // Sunk ships: a red cross for 15 s; division routes: the ETA at their end.
      routes.forEachCross(env.fxTime, (p, a) => {
        if (icons && toScreen(p)) icons.addCross(scrXY.x, scrXY.y, a);
      });
      routes.forEachEta((p, eta, owner) => {
        if (icons && toScreen(p)) icons.addText(scrXY.x, scrXY.y - 12, eta, ctx.sim.view.players[owner]?.color ?? 0xffffff);
      });
    }
  }

  function latLonTile(lat: number, lon: number): number {
    const fx = ((((lon + 180) / 360) * MAP_W) % MAP_W + MAP_W) % MAP_W;
    const fy = clamp(((90 - lat) / 180) * 800, 0, 799.999);
    return Math.floor(fy) * MAP_W + Math.floor(fx);
  }

  // -----------------------------------------------------------------------------------------------
  // Structures
  // -----------------------------------------------------------------------------------------------
  function headingFor(st: StructureView): number {
    let h = structHeading.get(st.id);
    if (h !== undefined) return h;
    h = (hash3(st.id, st.tile, 7) / 4294967296) * Math.PI * 2;
    const w = ctx.world;
    if (w && (st.type === StructureType.Port || st.type === StructureType.NavalYard)) {
      // Face the water: average direction to water tiles nearby.
      let sx = 0, sy = 0;
      const tx = tileX(st.tile), ty = tileY(st.tile);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const yy = ty + dy;
        if (yy < 0 || yy >= 800) continue;
        const t = yy * MAP_W + ((tx + dx + MAP_W) % MAP_W);
        if (isWaterTerrain(w.terrain[t])) {
          const d = Math.hypot(dx, dy);
          sx += dx / d;
          sy += dy / d;
        }
      }
      if (sx * sx + sy * sy > 1e-6) h = Math.atan2(sx, -sy);
    }
    structHeading.set(st.id, h);
    return h;
  }

  function citySpec(st: StructureView, capital: boolean): CitySpec {
    let c = cityCache.get(st.id);
    const level = Math.max(1, Math.min(10, st.level));
    if (c && c.level === level && c.capital === capital) return c;
    const n = Math.min(90, 10 + level * 7 + (capital ? 8 : 0));
    const b = new Float32Array(n * 8);
    let seed = (st.id * 2654435761 + st.tile) >>> 0;
    const rnd = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x632be5ab) >>> 0;
      seed ^= seed >>> 13;
      return (seed >>> 0) / 4294967296;
    };
    const R0 = 0.4;
    let spireN = 0;
    for (let i = 0; i < n; i++) {
      let x = 0, z = 0;
      const w = 0.03 + 0.032 * rnd() + (i === 0 ? 0.025 : 0);
      if (i > 0) {
        for (let tries = 0; tries < 14; tries++) {
          const r = R0 * Math.pow(rnd(), 0.9);
          const a = rnd() * Math.PI * 2;
          x = Math.cos(a) * r;
          z = Math.sin(a) * r;
          let ok = true;
          for (let j = 0; j < i; j++) {
            const dx = b[j * 8] - x, dz = b[j * 8 + 1] - z;
            const minD = (b[j * 8 + 2] + w) * 0.62;
            if (dx * dx + dz * dz < minD * minD) {
              ok = false;
              break;
            }
          }
          if (ok) break;
        }
      }
      const rr = Math.hypot(x, z) / R0;
      const core = Math.pow(Math.max(0, 1 - rr), 1.7);
      const lvl = 0.5 + level * 0.09;
      let h = (0.025 + 0.3 * core * core * (0.3 + 0.7 * rnd()) + 0.035 * rnd()) * lvl;
      if (i === 0) h = (capital ? 0.55 : 0.38) * lvl;
      else if (i < 4 && level >= 5) h = Math.max(h, (0.28 + 0.1 * rnd()) * lvl);
      const d = w * (0.7 + 0.6 * rnd());
      b[i * 8] = x;
      b[i * 8 + 1] = z;
      b[i * 8 + 2] = w;
      b[i * 8 + 3] = d;
      b[i * 8 + 4] = h;
      b[i * 8 + 5] = Math.floor(rnd() * 4) * (Math.PI / 2) + (rnd() - 0.5) * 0.2;
      b[i * 8 + 6] = Math.floor(rnd() * BUILDING_COLORS.length);
      b[i * 8 + 7] = Math.max(3, Math.round(h / 0.022));
      if (h > 0.2 && spireN < 3) spireN++;
    }
    c = { level, capital, b, n, spires: spireN };
    cityCache.set(st.id, c);
    return c;
  }

  const bR = new THREE.Vector3(), bB = new THREE.Vector3();

  // -----------------------------------------------------------------------------------------------
  // Grounding (DESIGN_V2 §10.7, F15/G01): a structure stands on the relief the globe draws. Its up vector is the normal
  // of the plane fitted to the relief over its footprint (clamped to 15° from the radial), its base sits on that plane
  // raised by the highest bump under the footprint (nothing pokes through), and a foundation pad with a skirt reaches
  // down to the lowest point of the footprint + 5 % (nothing floats). Cached per structure, level and relief.
  // -----------------------------------------------------------------------------------------------
  interface Ground {
    key: string;
    anchor: THREE.Vector3;
    up: THREE.Vector3;
    right: THREE.Vector3;
    back: THREE.Vector3;
    /** Pad depth below the model base (world units) and the footprint size S (world units). */
    pad: number;
    S: number;
    /** Plane-fit residuals (world units): the highest bump and the lowest hollow relative to the fitted plane. */
    maxE: number;
    minE: number;
    /** Degrees: model up vs the fitted relief normal (0 unless clamped), and the relief tilt itself. */
    devDeg: number;
    tiltDeg: number;
  }
  const grounds = new Map<number, Ground>();
  const GRID = 5;
  // §10.7 clamps the up vector to 15° from the radial; relief is drawn ×4 exaggerated, so steep valley sides reach 20–25°:
  // 30° keeps every model on its slope (deviation from the relief normal < 3°) without ever lying on its side.
  const MAX_TILT = (30 * Math.PI) / 180;
  const gP = new THREE.Vector3(), gN = new THREE.Vector3(), gC = new THREE.Vector3();
  const gll: LatLon = { lat: 0, lon: 0 };
  /** The NASA water fraction (0 land .. 1 sea) at a point, as the globe draws the coast (cubic B-spline over the grid). */
  const bwx = [0, 0, 0, 0], bwy = [0, 0, 0, 0];
  /** Uniform cubic B-spline weights at fraction f. */
  function bspline(f: number, w: number[]): void {
    const f2 = f * f, f3 = f2 * f;
    w[0] = (1 - 3 * f + 3 * f2 - f3) / 6;
    w[1] = (4 - 6 * f2 + 3 * f3) / 6;
    w[2] = (1 + 3 * f + 3 * f2 - 3 * f3) / 6;
    w[3] = f3 / 6;
  }
  function waterAt(lat: number, lon: number): number {
    const wf = getWorldAux(ctx.world)?.waterFrac;
    if (!wf) return 0;
    // The same cubic B-spline of the water mask the globe shader draws the coastline with up close (earth.ts
    // waterBicubic): the 0.5 isoline of a bilinear sample lies up to ~2 km off the drawn shore, which left quays on land.
    const fx = ((((lon + 180) / 360) * MAP_W - 0.5) % MAP_W + MAP_W) % MAP_W, fy = clamp(((90 - lat) / 180) * MAP_H - 0.5, 0, MAP_H - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    bspline(tx, bwx);
    bspline(ty, bwy);
    let v = 0;
    for (let j = 0; j < 4; j++) {
      const y = clamp(y0 - 1 + j, 0, MAP_H - 1);
      let row = 0;
      for (let i = 0; i < 4; i++) row += bwx[i] * wf[y * MAP_W + ((x0 - 1 + i + MAP_W) % MAP_W)];
      v += bwy[j] * row;
    }
    return v / 255;
  }

  /**
   * Ports and naval yards stand ON the coast: the sim puts them on a coastal tile, whose centre can lie ~10 km
   * inland of the drawn shoreline, which left their quays, piers and moored ships on dry land. The model is slid
   * along its seaward axis F until its quay line meets the shoreline (the 0.5 contour of the water fraction), at most
   * 14 km: model z = -0.13 for a port (its quay at -0.1, piers beyond), z = -0.44 for a naval yard (the dock gates at
   * its sea edge, the basins running on into the water). Returns the shift in km along F (from the tile centre at `c`).
   */
  const cP = new THREE.Vector3();
  function coastShiftKm(c: THREE.Vector3, f: THREE.Vector3, Skm: number, quayZ = 0.13): number {
    const at = (dKm: number): number => {
      cP.copy(c).addScaledVector(f, dKm / EARTH_RADIUS_KM).normalize();
      vec3ToLatLon(cP, gll);
      return waterAt(gll.lat, gll.lon);
    };
    const dir = at(0) >= 0.5 ? -1 : 1;
    let prev = 0, shore = NaN;
    for (let k = 1; k <= 60; k++) {
      const d = dir * k * 0.5;
      if ((at(d) >= 0.5) !== (dir < 0)) {
        shore = (prev + d) / 2;
        break;
      }
      prev = d;
    }
    if (!Number.isFinite(shore)) return 0;
    return clamp(shore - quayZ * Skm, -14, 14);
  }

  function groundOf(st: StructureView, S: number, heading: number, cache = true): Ground {
    const key = `${st.tile}:${st.level}:${S.toExponential(4)}:${heading.toFixed(4)}`;
    let g = grounds.get(st.id);
    if (g && g.key === key) return g;
    tileToLatLon(st.tile, ll);
    tangentFrame(ll.lat, ll.lon, E, N, U);
    F.copy(N).multiplyScalar(Math.cos(heading)).addScaledVector(E, Math.sin(heading));
    if (st.type === StructureType.Port || st.type === StructureType.NavalYard) {
      const shift = coastShiftKm(U, F, (structKm(st.type, st.level) / EARTH_RADIUS_KM) * EARTH_RADIUS_KM, st.type === StructureType.NavalYard ? 0.44 : 0.13);
      if (shift !== 0) {
        gC.copy(U).addScaledVector(F, shift / EARTH_RADIUS_KM).normalize();
        vec3ToLatLon(gC, ll);
        tangentFrame(ll.lat, ll.lon, E, N, U);
        F.addScaledVector(U, -F.dot(U)).normalize();
      }
    }
    R.crossVectors(F, U).normalize();
    B.copy(F).negate();
    // Relief samples over the footprint (a 5 x 5 grid on the model's own axes).
    const xs: number[] = [], zs: number[] = [], hs: number[] = [];
    for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
      const x = (i / (GRID - 1) - 0.5) * S, z = (j / (GRID - 1) - 0.5) * S;
      gP.copy(U).addScaledVector(R, x).addScaledVector(B, z).normalize();
      vec3ToLatLon(gP, gll);
      xs.push(x);
      zs.push(z);
      // The relief as the globe mesh draws it (GPU bilinear over the relief texture): what the model must stand on.
      hs.push(ctx.globe.meshRadiusAt(gll.lat, gll.lon) - 1);
    }
    // Least-squares plane h = a + b x + c z (symmetric grid: independent sums).
    let a = 0, sxx = 0, szz = 0, sxh = 0, szh = 0;
    for (let k = 0; k < hs.length; k++) {
      a += hs[k];
      sxx += xs[k] * xs[k];
      szz += zs[k] * zs[k];
      sxh += xs[k] * hs[k];
      szh += zs[k] * hs[k];
    }
    a /= hs.length;
    const b = sxh / sxx, c = szh / szz;
    let maxE = -Infinity, minE = Infinity;
    for (let k = 0; k < hs.length; k++) {
      const e = hs[k] - (a + b * xs[k] + c * zs[k]);
      if (e > maxE) maxE = e;
      if (e < minE) minE = e;
    }
    // Normal of the fitted plane, clamped to 15° from the radial (a structure never lies on its side).
    gN.copy(U).addScaledVector(R, -b).addScaledVector(B, -c).normalize();
    const tilt = Math.acos(Math.min(1, gN.dot(U)));
    const up = new THREE.Vector3().copy(gN);
    if (tilt > MAX_TILT) {
      gC.copy(gN).addScaledVector(U, -gN.dot(U)).normalize();
      up.copy(U).multiplyScalar(Math.cos(MAX_TILT)).addScaledVector(gC, Math.sin(MAX_TILT)).normalize();
    }
    const right = new THREE.Vector3().copy(R).addScaledVector(up, -R.dot(up)).normalize();
    const back = new THREE.Vector3().crossVectors(right, up).normalize();
    // Base on the plane at the centre, raised by the highest bump; the pad reaches the lowest hollow + 5 % of the range.
    const lift = Math.max(0, maxE);
    // + 0.4 % of the footprint of clearance for relief between the 5 x 5 samples (the pad hides the gap below).
    const anchor = new THREE.Vector3().copy(U).multiplyScalar(1 + a + lift / Math.max(1e-6, up.dot(U))).addScaledVector(up, 0.004 * S);
    const range = Math.max(0, maxE - minE);
    const pad = range * 1.05 + 0.02 * S;
    g = { key, anchor, up, right, back, pad, S, maxE, minE, devDeg: (Math.acos(Math.min(1, up.dot(gN))) * 180) / Math.PI, tiltDeg: (tilt * 180) / Math.PI };
    if (cache) grounds.set(st.id, g);
    return g;
  }

  /** The footprint a structure is drawn at this frame (world units): the grounded size, enlarged by the shader's minimum. */
  function drawnStructSize(st: StructureView, g: Ground): number {
    return Math.max(g.S, STRUCT_PX_K[st.type] * lod.structMinPx * env.pixelK * env.camPos.distanceTo(g.anchor));
  }

  /**
   * The size step each structure is grounded and drawn at (a quarter-octave multiple of its real footprint, >= 1): at
   * mid zoom a structure is drawn larger than life to keep its minimum on-screen size, and it must then stand on
   * the relief under THAT footprint (fitted plane, raised base, pad down to the lowest point), or an enlarged model
   * would sink into hills or hang over valleys. The shader tops the size up continuously within the step.
   */
  const drawStep = new Map<number, number>();
  function refreshDrawSteps(): void {
    if (!structModelsOn) return;
    const px = lod.structMinPx;
    for (const st of ctx.sim.view.structures.values()) {
      const a = structAnchor.get(st.id);
      if (!a) continue;
      const S0 = structKm(st.type, st.level) / EARTH_RADIUS_KM;
      const need = (STRUCT_PX_K[st.type] * px * env.pixelK * env.camPos.distanceTo(a)) / S0;
      const q = need <= 1 ? 1 : Math.min(16, Math.pow(2, Math.floor(Math.log2(need) * SCALE_STEPS_PER_OCTAVE) / SCALE_STEPS_PER_OCTAVE));
      if (drawStep.get(st.id) !== q) {
        drawStep.set(st.id, q);
        structDirty = true;
      }
    }
  }

  function updateStructures(): void {
    const view = ctx.sim.view;
    for (const key of STRUCT_MODELS) structMeshes[key].n = 0;
    buildings!.n = 0;
    spires!.n = 0;
    radarList.length = 0;
    factoryList.length = 0;
    const ruinIds = new Set<number>();
    for (const r of view.ruins) ruinIds.add(-(r.tile + 1));
    for (const id of structAnchor.keys()) {
      if (!view.structures.has(id) && !ruinIds.has(id)) {
        structAnchor.delete(id);
        structHeading.delete(id);
        cityCache.delete(id);
        grounds.delete(id);
        drawStep.delete(id);
      }
    }
    for (const st of view.structures.values()) {
      const h = headingFor(st);
      const S = (structKm(st.type, st.level) / EARTH_RADIUS_KM) * (structModelsOn ? drawStep.get(st.id) ?? 1 : 1);
      const g = groundOf(st, S, h);
      // Anchor size: the shader keeps the model at least STRUCT_PX_K x lod.structMinPx px wide (see material.ts).
      const aS = S / STRUCT_PX_K[st.type];
      let anchor = structAnchor.get(st.id);
      if (!anchor) {
        anchor = new THREE.Vector3();
        structAnchor.set(st.id, anchor);
      }
      anchor.copy(g.anchor);
      if (!structModelsOn) continue;
      const col = ownerColor(st.owner);
      const sel = st.id === selectedStructure ? 1 : 0;
      const info = STRUCT_INFO[st.type];
      const seed = (st.id * 0.618) % 1;
      if (!detailMode) {
        const bs = 2.2 / EARTH_RADIUS_KM;
        put(structMeshes.beacon, anchor, E, U, N, bs, bs, bs, col, 1, sel, st.hp, seed, anchor, bs);
        continue;
      }
      // Foundation pad under the land part of the footprint (ports and yards keep their piers over the water).
      const coastal = st.type === StructureType.Port || st.type === StructureType.NavalYard;
      const round = st.type === StructureType.City || st.type === StructureType.DefensePost || st.type === StructureType.SamSite;
      tmpColor.setHex(0xffffff);
      // The pad's top sits just under the model's ground plate (0.6 % of the footprint), so the two never z-fight.
      P.copy(anchor).addScaledVector(g.up, -0.006 * S);
      if (round) put(structMeshes.padRound, P, g.right, g.up, g.back, S * 1.0, g.pad, S * 1.0, tmpColor, st.built, sel, st.hp, seed, anchor, aS);
      else if (coastal) {
        Q.copy(P).addScaledVector(g.back, 0.2 * S);
        put(structMeshes.pad, Q, g.right, g.up, g.back, S * 1.02, g.pad, S * 0.62, tmpColor, st.built, sel, st.hp, seed, anchor, aS);
      } else put(structMeshes.pad, P, g.right, g.up, g.back, S * 1.03, g.pad, S * 1.03, tmpColor, st.built, sel, st.hp, seed, anchor, aS);
      // Feedback 3 (#27): a damaged structure shows it — partly collapsed (its height drawn at 85 % / 60 %), debris
      // piled around it, smoke (damaged) and fire (heavily damaged, see updateAmbient); a city loses whole blocks.
      const dst = st.built >= 1 ? damageState(st.hp) : 0;
      const stand = st.built >= 1 ? standingShare(st.hp) : 1;
      put(structMeshes[levelKey(info.key, st.level)], anchor, g.right, g.up, g.back, S, S * (st.type === StructureType.City ? 1 : stand), S, col, st.built, sel, st.hp, seed, anchor, aS);
      if (dst >= 1 && st.type !== StructureType.City) {
        const k = dst >= 2 ? 0.95 : 0.7;
        put(structMeshes.rubble, anchor, g.right, g.up, g.back, S * k, S * (dst >= 2 ? 0.9 : 0.55), S * k, col, 1, sel, 1, seed, anchor, aS);
      }
      if (st.type === StructureType.City) {
        const capital = view.players[st.owner]?.capitalTile === st.tile;
        const cs = citySpec(st, capital);
        const down = collapsedBlocks(st.id, st.hp, st.blocks ?? 0);
        let sp = 0;
        for (let i = 0; i < cs.n; i++) {
          const o = i * 8;
          const bx = cs.b[o], bz = cs.b[o + 1], w = cs.b[o + 2] * S, d = cs.b[o + 3] * S, rot = cs.b[o + 5];
          let hh = cs.b[o + 4] * S;
          const fallen = (down & (1 << (i % CITY_BLOCKS))) !== 0;
          const cr = Math.cos(rot), sr = Math.sin(rot);
          bR.copy(g.right).multiplyScalar(cr).addScaledVector(g.back, sr);
          bB.copy(g.back).multiplyScalar(cr).addScaledVector(g.right, -sr);
          Q.copy(anchor).addScaledVector(g.right, bx * S).addScaledVector(g.back, bz * S).addScaledVector(g.up, 0.004 * S);
          tmpColor.setHex(fallen ? 0x4a4540 : BUILDING_COLORS[cs.b[o + 6] | 0]);
          if (fallen) {
            // A collapsed block: a charred stub and its rubble spread around it.
            hh = Math.min(hh, 0.035 * S);
            put(structMeshes.rubble, Q, bR, g.up, bB, Math.max(w, d) * 2.2, Math.max(w, d) * 1.2, Math.max(w, d) * 2.2, col, 1, sel, 1, seed, anchor, aS);
          }
          put(buildings!, Q, bR, g.up, bB, w, hh, d, tmpColor, st.built, sel, fallen ? 0.15 : cs.b[o + 7], 2 + (i % 2), anchor, aS);
          if (!fallen && hh > 0.2 * S && sp < cs.spires) {
            sp++;
            T.copy(Q).addScaledVector(g.up, hh);
            put(spires!, T, bR, g.up, bB, w, w * 1.4, d, col, st.built, sel, st.hp, seed, anchor, aS);
          }
        }
      } else if (st.type === StructureType.Radar) {
        F.copy(g.back).negate();
        radarList.push({ id: st.id, anchor, e: g.right.clone(), n: F.clone(), u: g.up.clone(), S, aS, col: col.clone(), built: st.built, hp: st.hp, sel, level: Math.max(1, Math.min(3, st.level)) });
      } else if (st.type === StructureType.Factory && st.built >= 1) {
        F.copy(g.back).negate();
        factoryList.push({ anchor, e: g.right.clone(), n: F.clone(), u: g.up.clone(), S, k: STRUCT_PX_K[st.type], acc: Math.random(), level: Math.max(1, Math.min(3, st.level)) });
      }
    }
    // Feedback 3 (#27): rubble where a structure was destroyed (TickUpdate.ruins), on its own scorched pad.
    if (structModelsOn && detailMode) {
      for (const r of view.ruins) {
        const fake: StructureView = { id: -(r.tile + 1), type: r.type, owner: 0, tile: r.tile, level: r.level, hp: 0, built: 1, cooldown: 0 };
        const h = headingFor(fake);
        const S = (structKm(r.type, r.level) / EARTH_RADIUS_KM) * (drawStep.get(fake.id) ?? 1);
        const g = groundOf(fake, S, h);
        let anchor = structAnchor.get(fake.id);
        if (!anchor) {
          anchor = new THREE.Vector3();
          structAnchor.set(fake.id, anchor);
        }
        anchor.copy(g.anchor);
        const aS = S / STRUCT_PX_K[r.type];
        tmpColor.setHex(0x3a3632);
        P.copy(anchor).addScaledVector(g.up, -0.006 * S);
        put(structMeshes.padRound, P, g.right, g.up, g.back, S, g.pad, S, tmpColor, 1, 0, 0.3, 0, anchor, aS);
        put(structMeshes.rubble, anchor, g.right, g.up, g.back, S, S, S, tmpColor, 1, 0, 1, (r.tile * 0.618) % 1, anchor, aS);
      }
    }
    for (const key of STRUCT_MODELS) if (key !== 'radarDish') commit(structMeshes[key]);
    commit(buildings!);
    commit(spires!);
  }

  function updateStructureIcons(): void {
    if (!icons || !lod.structIcons) return;
    const view = ctx.sim.view;
    for (const st of view.structures.values()) {
      const a = structAnchor.get(st.id);
      if (!a || !toScreen(a)) continue;
      // Once the 3D model fades in (below 900 km) the icon floats above it instead of covering it: the model is what
      // the player looks at up close (owner feedback), the icon stays as a readable tag.
      const iy = scrXY.y - 22 * lod.structModelFade;
      icons.add(true, st.id, st.type, st.owner, relations.relationTo(st.owner), scrXY.x, iy, st.hp, st.level, st.id === selectedStructure, 0, st.type);
      // v2 (W4, §10.7): an hourglass while building, upgrading or producing units.
      if (st.built < 1 || (st.upgrade ?? 0) > 0 || (st.producing ?? 0) > 0) icons.addHourglass(scrXY.x + 13, iy - 11);
    }
  }

  function updateRadarDishes(): void {
    const dish = structMeshes.radarDish;
    dish.n = 0;
    if (detailMode && structModelsOn) {
      for (const r of radarList) {
        const a = env.time * 1.4 + r.id;
        const ca = Math.cos(a), sa = Math.sin(a);
        bR.copy(r.e).multiplyScalar(ca).addScaledVector(r.n, sa);
        bB.copy(r.n).multiplyScalar(-ca).addScaledVector(r.e, sa);
        // Tower top in model units (0.1, 0.38, -0.05) -> world (model -Z = forward n).
        Q.copy(r.anchor).addScaledVector(r.e, 0.1 * r.S).addScaledVector(r.u, 0.38 * r.S).addScaledVector(r.n, 0.05 * r.S);
        // The antenna grows with the level (§6.5: coverage 20 / 28 / 36 tiles): 1.0 / 1.3 / 1.6 times as wide.
        const k = [1, 1.3, 1.6][r.level - 1];
        put(dish, Q, bR, r.u, bB, r.S * k, r.S * k, r.S * k, r.col, r.built, r.sel, r.hp, 0, r.anchor, r.aS);
      }
    }
    commit(dish);
  }

  function updateAmbient(fx: FxInternal, dt: number): void {
    if (dt <= 0 || env.altitudeKm > 2600 || !detailMode) return;
    const view = ctx.sim.view;
    for (const f of factoryList) {
      f.acc += dt * 2.2;
      if (f.acc < 1) continue;
      f.acc -= 1;
      T.subVectors(env.camPos, f.anchor);
      if (T.dot(f.anchor) < 0) continue;
      const dist = T.length();
      const Se = Math.max(f.S, f.k * lod.structMinPx * env.pixelK * dist);
      // Stacks of models.ts factory(L): 2 per level along the back edge (x = -0.42 + 0.08 i, z = +0.38).
      const i = Math.floor(fx.particles.rand() * 2 * f.level);
      const lx = -0.42 + i * 0.08;
      Q.copy(f.anchor).addScaledVector(f.e, lx * Se).addScaledVector(f.n, -0.38 * Se).addScaledVector(f.u, (0.34 + 0.04 * (i % 2)) * Se);
      const s = Se * 0.08;
      fx.particles.emit(PK.Smoke, Q.x, Q.y, Q.z, f.u.x * s * 0.6 + f.e.x * s * 0.3, f.u.y * s * 0.6 + f.e.y * s * 0.3, f.u.z * s * 0.6 + f.e.z * s * 0.3,
        5 + fx.particles.rand() * 3, s * 0.6, s * 4, 0.3, s * 0.05);
    }
    // Feedback 3 (#27): damaged structures smoke (a grey-black column), heavily damaged ones burn; fresh rubble smoulders
    // for two game days.
    for (const st of view.structures.values()) {
      if (st.built < 1) continue;
      const dst = damageState(st.hp);
      if (dst === 0) continue;
      const anchor = structAnchor.get(st.id);
      if (!anchor) continue;
      const km = structKm(st.type, st.level);
      if (dst >= 2 && fx.particles.rand() < dt * 3) fx.burn(anchor, fx.visKm(anchor, km * 0.18, 6), 1.5);
      if (fx.particles.rand() < dt * (dst >= 2 ? 6 : 3)) smokeAt(fx, anchor, km, dst >= 2 ? 1.3 : 0.9);
    }
    for (const r of view.ruins) {
      if (view.tick - r.tick > 480) continue;
      const anchor = structAnchor.get(-(r.tile + 1));
      if (anchor && fx.particles.rand() < dt * 2) smokeAt(fx, anchor, structKm(r.type, r.level), 0.8);
    }
  }

  const U2 = new THREE.Vector3();
  /** A puff of dark smoke rising from a damaged structure (size from its footprint, a pixel floor from afar). */
  function smokeAt(fx: FxInternal, anchor: THREE.Vector3, km: number, k: number): void {
    T.subVectors(env.camPos, anchor);
    if (T.dot(anchor) < 0) return;
    const s = fx.visKm(anchor, km * 0.18 * k, 5) / EARTH_RADIUS_KM;
    U2.copy(anchor).normalize();
    const jx = (fx.particles.rand() - 0.5) * s * 2, jz = (fx.particles.rand() - 0.5) * s * 2;
    fx.particles.emit(PK.Smoke, anchor.x + jx + U2.x * s * 0.5, anchor.y + U2.y * s * 0.5, anchor.z + jz + U2.z * s * 0.5, U2.x * s * 0.5, U2.y * s * 0.5, U2.z * s * 0.5,
      6 + fx.particles.rand() * 4, s * 0.8, s * 5, 0.25, s * 0.04);
  }

  // -----------------------------------------------------------------------------------------------
  // Rails & overlays
  // -----------------------------------------------------------------------------------------------
  function updateRails(frameTime: number): void {
    if (!rails) return;
    const alt = env.altitudeKm;
    rails.material.uniforms.uOpacity.value = clamp((7000 - alt) / 3000, 0, 1) * 0.9;
    rails.mesh.visible = alt < 7000;
    if (!railDirty || frameTime - railBuiltAt < 1) return;
    railDirty = false;
    railBuiltAt = frameTime;
    const view = ctx.sim.view;
    const links = buildRailLinks(view.structures.values(), ctx.world, (x, y) => {
      const p = view.players[x];
      return !!p && p.allies.includes(y);
    });
    rails.begin();
    for (const [sa, sb] of links) {
      tileToLatLon(sa.tile, ll);
      tileToLatLon(sb.tile, ll2);
      tmpColor.copy(ownerColor(sa.owner)).lerp(white, 0.35);
      rails.addArc(ll, ll2, tmpColor.getHex(), radiusAt, 10);
    }
    rails.end();
  }

  /**
   * The offensive corridor preview: from the human's land nearest to the cursor toward it, as wide as the frontage the
   * committed troops buy (§4.3), coloured by the force ratio (red < 1, amber 1–2, green ≥ 2).
   */
  const cA: LatLon = { lat: 0, lon: 0 }, cB: LatLon = { lat: 0, lon: 0 };
  function drawCorridor(ov: Overlays): void {
    const view = ctx.sim.view;
    const pv = preview.offensive;
    if (pv.originFor !== pv.tile) {
      pv.originFor = pv.tile;
      pv.origin = -1;
      const x0 = pv.tile % MAP_W, y0 = Math.floor(pv.tile / MAP_W);
      let bd = Infinity;
      for (let r = 1; r <= 40 && pv.origin < 0; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const y = y0 + dy;
          if (y < 0 || y >= 800) continue;
          const t = y * MAP_W + (((x0 + dx) % MAP_W) + MAP_W) % MAP_W;
          if (view.owner[t] !== HUMAN_ID) continue;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; pv.origin = t; }
        }
      }
    }
    if (pv.origin < 0) return;
    const ox = tileCx(pv.origin), oy = tileCy(pv.origin), tx = tileCx(pv.tile), ty = tileCy(pv.tile);
    let dx = tx - ox;
    if (dx > MAP_W / 2) dx -= MAP_W;
    if (dx < -MAP_W / 2) dx += MAP_W;
    const cl = Math.max(0.2, Math.cos(((90 - (oy / 800) * 180) * Math.PI) / 180));
    const ex = dx * cl, ey = ty - oy;
    const len = Math.hypot(ex, ey);
    if (len < 0.5) return;
    // Corridor sides: ±frontage/2 tiles perpendicular to the axis (in local metric tiles), 30 % beyond the cursor.
    const px = -ey / len, py = ex / len, half = pv.frontage / 2;
    const c = pv.ratio >= 2 ? 0x3dff8a : pv.ratio >= 1 ? 0xffc24a : 0xff4a3a;
    const ext = 1.3;
    for (const side of [-1, 0, 1]) {
      const sx = (px * half * side) / cl, sy = py * half * side;
      tileXYToLatLon(ox + sx, oy + sy, cA);
      tileXYToLatLon(ox + (dx * ext) + sx, oy + ey * ext + sy, cB);
      ov.path.addArc(cA, cB, c, radiusAt, 12, 0.3);
    }
  }

  function updateOverlays(): void {
    const ov = overlays!;
    const view = ctx.sim.view;
    ov.begin();
    for (const id of selectedUnits) {
      const t = tracks.get(id);
      const u = view.units.get(id);
      if (!t || !u || !t.hasPos) continue;
      tmpColor.copy(ownerColor(u.owner)).lerp(white, 0.4);
      ov.ring({ lat: t.lat, lon: t.lon, radiusKm: t.size * 1.1, minPx: 22, style: 0, color: tmpColor.getHex(), alpha: 1, dashes: 12, spin: 0.25 }, radiusAt);
    }
    // v2 (W4, §6.1, §10.8): CAP circles stay drawn while a fighter patrols (ours and those at war with us); the effect
    // ring or zone of whatever is selected (SAM air and anti-ballistic, defense post, scramble radius, repair, radar,
    // blockade, bombardment reach, a division's aura, an aircraft's reach from its base).
    const rules = viewRules(view);
    const zone = (lat: number, lon: number, km: number, color: number, alpha: number, style: 2 | 3, dashes = 40) =>
      ov.ring({ lat, lon, radiusKm: km, minPx: 10, style, color, alpha, dashes, spin: style === 2 ? 0.02 : 0 }, radiusAt);
    for (const u of view.units.values()) {
      if (u.type !== UnitType.FighterSquadron || u.mode !== UnitMode.Patrol) continue;
      if (u.owner !== HUMAN_ID && relations.relationTo(u.owner) !== 'war' && !selectedUnits.has(u.id)) continue;
      tileXYToLatLon(u.targetX, u.targetY, ll2);
      zone(ll2.lat, ll2.lon, EFFECT_TILES.cap * TILE_KM, ownerColor(u.owner).getHex(), u.owner === HUMAN_ID ? 0.8 : 0.6, 2, 40);
      // Released from command mode (owner feedback #18): the holding orbit over the spot where it was left, solid.
      if (u.owner === HUMAN_ID && u.order >= 0 && UNIT_ORDER_KINDS[u.order] === 'hold') zone(ll2.lat, ll2.lon, HOLD_ORBIT_KM, 0xffd58a, 0.95, 3);
    }
    for (const id of selectedUnits) {
      const u = view.units.get(id);
      if (!u) continue;
      const oc = tmpColor.copy(ownerColor(u.owner)).lerp(white, 0.3).getHex();
      tileXYToLatLon(u.x, u.y, ll);
      switch (u.type) {
        case UnitType.ArmoredDivision: {
          zone(ll.lat, ll.lon, EFFECT_TILES.attach * TILE_KM, oc, 0.55, 3);
          // Feedback 3 (#28): the mission's zone — the defended sector, the spearhead it follows, its artillery reach
          // and the structure it assaults.
          const k = u.order >= 0 ? UNIT_ORDER_KINDS[u.order] : null;
          const m = u.mission ?? 0;
          if (k === 'defend' && m < 0) {
            tileToLatLon(-m - 1, ll2);
            zone(ll2.lat, ll2.lon, DEFEND_TILES * TILE_KM, 0x6ab8ff, 0.85, 3);
            zone(ll2.lat, ll2.lon, DEFEND_TILES * TILE_KM, 0x6ab8ff, 0.7, 2, 44);
          } else if (k === 'join' && m > 0) {
            const a = view.attacks.find((x) => x.id === m);
            if (a) {
              tileXYToLatLon(a.contactX >= 0 ? a.contactX : a.x, a.contactX >= 0 ? a.contactY : a.y, ll2);
              zone(ll2.lat, ll2.lon, 18, 0xffd24a, 0.95, 2, 16);
            }
          } else if ((k === 'assault' || k === 'raze') && m > 0) {
            zone(ll.lat, ll.lon, DIVISION_ARTILLERY_TILES * TILE_KM, 0xff7a3d, 0.6, 2, 36);
          }
          break;
        }
        case UnitType.Warship:
          if (u.mode === UnitMode.Blockade || (u.order >= 0 && UNIT_ORDER_KINDS[u.order] === 'blockade')) {
            tileXYToLatLon(u.targetX, u.targetY, ll2);
            zone(ll2.lat, ll2.lon, EFFECT_TILES.engage * TILE_KM, 0xff4a3a, 0.75, 3);
            zone(ll2.lat, ll2.lon, EFFECT_TILES.engage * TILE_KM, 0xff4a3a, 0.9, 2, 48);
          } else if (u.mode === UnitMode.Bombard) {
            tileXYToLatLon(u.targetX, u.targetY, ll2);
            zone(ll.lat, ll.lon, EFFECT_TILES.bombard * TILE_KM, 0xff9a3d, 0.7, 3);
          } else zone(ll.lat, ll.lon, EFFECT_TILES.engage * TILE_KM, oc, 0.6, 2, 36);
          break;
        case UnitType.FighterSquadron:
        case UnitType.Bomber:
        case UnitType.DroneSwarm: {
          if (u.type === UnitType.DroneSwarm && u.mode === UnitMode.Support) {
            tileXYToLatLon(u.targetX, u.targetY, ll2);
            zone(ll2.lat, ll2.lon, EFFECT_TILES.support * TILE_KM, 0xffb347, 0.75, 3);
          }
          // Reach from its base (thin, faint): where it may be sent.
          const base = view.structures.get(u.home);
          if (base) {
            tileToLatLon(base.tile, ll2);
            zone(ll2.lat, ll2.lon, reachKm(u.type), oc, 0.35, 2, 90);
          }
          break;
        }
      }
    }
    // Feedback 3 (#28): every structure under assault by one of our divisions carries a red target ring (the razed ones
    // double), so the player sees where his missions strike without selecting anything.
    for (const u of view.units.values()) {
      if (u.owner !== HUMAN_ID || u.type !== UnitType.ArmoredDivision || !(u.mission && u.mission > 0) || u.order < 0) continue;
      const k = UNIT_ORDER_KINDS[u.order];
      if (k !== 'assault' && k !== 'raze') continue;
      const st = view.structures.get(u.mission);
      if (!st) continue;
      tileToLatLon(st.tile, ll2);
      ov.ring({ lat: ll2.lat, lon: ll2.lon, radiusKm: structKm(st.type, st.level) * 1.4, minPx: 18, style: 0, color: 0xff3b1f, alpha: 0.95, dashes: 8, spin: 0.3 }, radiusAt);
      if (k === 'raze') ov.ring({ lat: ll2.lat, lon: ll2.lon, radiusKm: structKm(st.type, st.level) * 2, minPx: 24, style: 1, color: 0xff3b1f, alpha: 0.8 }, radiusAt);
    }
    if (selectedStructure >= 0) {
      const st = view.structures.get(selectedStructure);
      if (st) {
        tileToLatLon(st.tile, ll);
        tmpColor.copy(ownerColor(st.owner)).lerp(white, 0.4);
        ov.ring({ lat: ll.lat, lon: ll.lon, radiusKm: structKm(st.type, st.level) * 0.8, minPx: 26, style: 0, color: tmpColor.getHex(), alpha: 1, dashes: 16, spin: 0.12 }, radiusAt);
        const lv = structureLevel(st.type, st.level);
        const radar = radarCovers(rules, st.owner, tileCx(st.tile), tileCy(st.tile));
        switch (st.type) {
          case StructureType.SamSite: {
            const k = radar ? RADAR_SAM_RANGE_MUL : 1;
            zone(ll.lat, ll.lon, (lv.rangeTiles ?? 8) * k * TILE_KM, 0x6fd6ff, 0.85, 2, 56);
            zone(ll.lat, ll.lon, (lv.abmTiles ?? 5) * k * TILE_KM, 0xff6a3d, 0.85, 2, 36);
            break;
          }
          case StructureType.DefensePost:
            zone(ll.lat, ll.lon, (lv.radiusTiles ?? 3) * TILE_KM, 0xffc24a, 0.8, 3);
            zone(ll.lat, ll.lon, (lv.radiusTiles ?? 3) * TILE_KM, 0xffc24a, 0.9, 2, 64);
            break;
          case StructureType.Airbase:
            zone(ll.lat, ll.lon, (lv.scrambleTiles ?? 16) * (radar ? RADAR_SCRAMBLE_MUL : 1) * TILE_KM, 0x9fd6ff, 0.8, 2, 64);
            break;
          case StructureType.ArmyBase:
          case StructureType.NavalYard:
          case StructureType.Port:
            zone(ll.lat, ll.lon, (lv.repairTiles ?? 3) * TILE_KM, 0x45f0a0, 0.7, 3);
            break;
          case StructureType.Radar:
            zone(ll.lat, ll.lon, (lv.coverageTiles ?? 20) * TILE_KM, 0x8ab4ff, 0.45, 3);
            zone(ll.lat, ll.lon, (lv.coverageTiles ?? 20) * TILE_KM, 0x8ab4ff, 0.8, 2, 80);
            break;
        }
      }
    }
    // Weapon targeting.
    if (preview.target.weapon !== null && preview.target.tile >= 0) {
      tileToLatLon(preview.target.tile, ll);
      const ok = preview.target.valid;
      if (preview.target.inner > 0) {
        ov.ring({ lat: ll.lat, lon: ll.lon, radiusKm: preview.target.inner * TILE_KM, minPx: 10, style: 1, color: ok ? 0xff3b1f : 0x888888, alpha: 0.9 }, radiusAt);
      }
      ov.ring({ lat: ll.lat, lon: ll.lon, radiusKm: Math.max(preview.target.outer, 1) * TILE_KM, minPx: 16, style: 2, color: ok ? 0xffa21f : 0x777777, alpha: 0.9, dashes: 48, spin: 0.05 }, radiusAt);
    }
    // Build placement.
    if (preview.build.structure >= 0 && preview.build.tile >= 0) {
      tileToLatLon(preview.build.tile, ll);
      const type = preview.build.structure as StructureType;
      const km = structKm(type, 1);
      ov.ring({ lat: ll.lat, lon: ll.lon, radiusKm: km * 0.7, minPx: 22, style: 3, color: preview.build.valid ? 0x3dff8a : 0xff4030, alpha: 0.9 }, radiusAt);
      ov.ghost(String(type), ll, km, STRUCT_PX_K[type] * lod.structMinPx, preview.build.valid, radiusAt, env.camPos, env.pixelK);
    } else ov.ghost(null, null, 0, 0, false, radiusAt, env.camPos, env.pixelK);
    // Order path (§7.4): one line per selected unit to the order's target, cyan when it can comply, red when not.
    ov.path.begin();
    if (preview.order.tile >= 0 && (preview.order.unitId >= 0 || preview.order.unitIds.length)) {
      const ids = preview.order.unitIds.length ? preview.order.unitIds : [preview.order.unitId];
      tileToLatLon(preview.order.tile, ll2);
      let any = false;
      ids.forEach((id, i) => {
        const t = tracks.get(id);
        if (!t || !t.hasPos) return;
        const ok = preview.order.valids.length ? preview.order.valids[i] : preview.order.valid;
        ll.lat = t.lat;
        ll.lon = t.lon;
        ov.path.addArc(ll, ll2, ok ? 0x46e0ff : 0xff4a3a, radiusAt, 15, 0.3);
        any = any || ok;
      });
      const c = any ? 0x46e0ff : 0xff4a3a;
      ov.ring({ lat: ll2.lat, lon: ll2.lon, radiusKm: 6, minPx: 14, style: 0, color: c, alpha: 1, dashes: 8, spin: -0.4 }, radiusAt);
    }
    // Offensive corridor (§7.7): what a left click launches, from our border toward the cursor, as wide as the troops.
    if (preview.offensive.tile >= 0 && preview.offensive.valid) drawCorridor(ov);
    ov.path.end();
    ov.end();
  }

  // -----------------------------------------------------------------------------------------------
  // Picking
  // -----------------------------------------------------------------------------------------------
  const pickV = new THREE.Vector3();
  const pickCam = new THREE.Vector3();
  function project(w: THREE.Vector3, clientX: number, clientY: number, rect: DOMRect): number {
    pickCam.subVectors(ctx.camera.position, w);
    if (pickCam.dot(w) < 0) return Infinity;
    pickV.copy(w).project(ctx.camera);
    if (pickV.z > 1) return Infinity;
    const x = rect.left + ((pickV.x + 1) / 2) * rect.width, y = rect.top + ((1 - pickV.y) / 2) * rect.height;
    return (x - clientX) ** 2 + (y - clientY) ** 2;
  }

  // -----------------------------------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------------------------------
  function iconHitAt(clientX: number, clientY: number): IconHit | null {
    if (!icons) return null;
    const rect = ctx.canvas.getBoundingClientRect();
    return icons.pick(clientX - rect.left, clientY - rect.top);
  }

  /** Unit models drawn this frame inside the frustum and above the horizon (measurement, not the instance count). */
  const modelView = { n: 0, minPx: Infinity, list: [] as { id: number; type: UnitType; px: number; x: number; y: number; w: number; h: number }[] };

  /** Debug / measurement hook (DESIGN_V2 §16.3): what is drawn right now. */
  function stats(): Record<string, unknown> {
    let unitModels = 0, structureModels = 0;
    for (const key of UNIT_MODELS) unitModels += unitMeshes[key]?.mesh.count ?? 0;
    for (const key of STRUCT_MODELS) structureModels += structMeshes[key]?.mesh.count ?? 0;
    structureModels += (buildings?.mesh.count ?? 0) + (spires?.mesh.count ?? 0);
    const view = ctx.sim.view;
    return {
      altitudeKm: +env.altitudeKm.toFixed(1), lod: { ...lod },
      // unitModels: models in view (frustum + horizon); unitModelInstances: every instance written this frame.
      unitModels: modelView.n, unitModelInstances: unitModels, unitModelMinPx: Number.isFinite(modelView.minPx) ? +modelView.minPx.toFixed(1) : 0,
      unitModelsInView: modelView.list.map((m) => ({ ...m })), structureModels,
      rings: overlays ? overlays.drawn.map((r) => ({ ...r })) : [], hourglasses: icons?.lastHourglasses ?? 0,
      liveUnits: view.units.size, liveStructures: view.structures.size, ...(icons ? icons.stats : {}),
    };
  }

  const debugHook = {
    stats, tracks, unitMeshes, structMeshes, env,
    /** Screen position (client px) of a unit's icon or model this frame, for scripted clicks. */
    screenOf(id: number): { x: number; y: number } | null {
      const t = tracks.get(id);
      const u = ctx.sim.view.units.get(id);
      if (!u) return null;
      const p = new THREE.Vector3();
      if (t && t.hasPos) p.copy(t.pos);
      else {
        tileXYToLatLon(u.x, u.y, ll2);
        latLonToVec3(ll2.lat, ll2.lon, ctx.globe.surfaceRadiusAt(ll2.lat, ll2.lon), p);
      }
      if (!toScreen(p, 0)) return null;
      const rect = ctx.canvas.getBoundingClientRect();
      return { x: scrXY.x + rect.left, y: scrXY.y + rect.top };
    },
    pick: (x: number, y: number) => iconHitAt(x, y),
    /**
     * v2 (W4, §10.7): how every structure stands on the relief. residualPct = the largest distance between the relief
     * and the fitted plane over the footprint (% of the footprint), absorbed by the raised base and the pad;
     * visibleErrorPct = what is left uncovered (a gap under the pad or relief above the base); upDevDeg = the model's up
     * vector against the fitted relief normal; padOk = the pad reaches the lowest point of the footprint.
     */
    grounding: () => {
      const out: { id: number; type: number; level: number; footprintKm: number; residualPct: number; maxVerticalErrorPct: number; visibleErrorPct: number; upDevDeg: number; tiltDeg: number; padKm: number; padOk: boolean }[] = [];
      for (const st of ctx.sim.view.structures.values()) {
        const S = structKm(st.type, st.level) / EARTH_RADIUS_KM;
        const g = groundOf(st, S, headingFor(st), false);
        const lift = Math.max(0, g.maxE);
        const gap = Math.max(0, lift - g.minE - g.pad);
        const poke = Math.max(0, g.maxE - lift);
        const residual = Math.max(Math.abs(g.maxE), Math.abs(g.minE));
        out.push({
          id: st.id, type: st.type, level: st.level, footprintKm: +(S * EARTH_RADIUS_KM).toFixed(2),
          residualPct: +((residual / S) * 100).toFixed(2), maxVerticalErrorPct: +((residual / S) * 100).toFixed(2),
          visibleErrorPct: +((Math.max(gap, poke) / S) * 100).toFixed(3), upDevDeg: +g.devDeg.toFixed(3), tiltDeg: +g.tiltDeg.toFixed(2),
          padKm: +(g.pad * EARTH_RADIUS_KM).toFixed(3), padOk: gap <= 1e-9,
        });
      }
      return out;
    },
    /**
     * On-screen size of what is drawn for a unit (its whole formation) or a structure this frame: the projected box
     * of the model(s) in CSS px (px = the larger side). tools/w4-closeups.mjs reads it at 300 / 100 / 40 / 8 km.
     */
    /** Where a structure is drawn (its grounded anchor: ports and yards sit on the shoreline, not the tile centre). */
    anchorOf(tile: number): { lat: number; lon: number } | null {
      const st = [...ctx.sim.view.structures.values()].find((x) => x.tile === tile);
      const a = st ? structAnchor.get(st.id) : undefined;
      if (!a) return null;
      const p = a.clone().normalize();
      return { lat: (Math.asin(clamp(p.y, -1, 1)) * 180) / Math.PI, lon: (Math.atan2(-p.z, p.x) * 180) / Math.PI };
    },
    sizeOf(kind: 'unit' | 'struct', id: number): { px: number; w: number; h: number; scale: number } | null {
      if (kind === 'unit') {
        const m = modelView.list.find((x) => x.id === id);
        return m ? { px: m.px, w: m.w, h: m.h, scale: 1 } : null;
      }
      const st = [...ctx.sim.view.structures.values()].find((x) => x.tile === id) ?? ctx.sim.view.structures.get(id);
      if (!st) return null;
      const g = grounds.get(st.id);
      if (!g) return null;
      const key = levelKey(STRUCT_INFO[st.type].key, st.level);
      const Se = drawnStructSize(st, g);
      resetPBox();
      projectInstance(boxOf(structMeshes[key]), g.anchor, g.right, g.up, g.back, Se, Se, Se);
      return { px: +pboxPx().toFixed(1), w: Math.round(pbox.x1 - pbox.x0), h: Math.round(pbox.y1 - pbox.y0), scale: +(Se / (structKm(st.type, st.level) / EARTH_RADIUS_KM)).toFixed(2) };
    },
    /** Geometry of every structure model key (vertex count): level variants differ (structures-levels, §6.5). */
    modelStats: () => Object.fromEntries(STRUCT_MODELS.map((k) => [k, structMeshes[k]?.mesh.geometry.getAttribute('position').count ?? 0])),
    /** Pickable icons drawn this frame, in client px (verification: clustering, scripted clicks). */
    icons: () => {
      const rect = ctx.canvas.getBoundingClientRect();
      return (icons?.debugHits() ?? []).map((h) => ({ ...h, x: h.x + rect.left, y: h.y + rect.top }));
    },
  };
  (window as unknown as { __units?: unknown }).__units = debugHook;
  (window as unknown as { __trails?: unknown }).__trails = {
    stats: () => ({ ...routes.stats({ relationTo: (o: number) => relations.relationTo(o) }), humanSuppressed: routes.humanSuppressed() }),
    route: (unitId: number) => routes.info(unitId),
    points: (unitId: number) => routes.points(unitId),
    /**
     * Ship lines over land (FEEDBACK #2/#10: a ship line never crosses land): every drawn ship line sampled every 5 km,
     * leaving out 40 km at each end (the port and a landing beach are coastal land tiles). Per line: km over land.
     */
    overLand: () => {
      const w = ctx.world;
      if (!w) return null;
      const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3();
      const lines = routes.shipLines().map((l) => {
        let total = 0;
        const seg: number[] = [];
        for (let i = 3; i < l.pts.length; i += 3) {
          A.set(l.pts[i - 3], l.pts[i - 2], l.pts[i - 1]);
          Bv.set(l.pts[i], l.pts[i + 1], l.pts[i + 2]);
          const km = A.distanceTo(Bv) * EARTH_RADIUS_KM;
          seg.push(km);
          total += km;
        }
        let at = 0, land = 0, samples = 0;
        const worst: { seg: number; of: number; km: number; from: number[]; to: number[] }[] = [];
        for (let i = 3, s = 0; i < l.pts.length; i += 3, s++) {
          A.set(l.pts[i - 3], l.pts[i - 2], l.pts[i - 1]);
          Bv.set(l.pts[i], l.pts[i + 1], l.pts[i + 2]);
          const km = seg[s], n = Math.max(1, Math.ceil(km / 5));
          for (let j = 0; j < n; j++) {
            const d = at + (km * j) / n;
            if (d < 40 || d > total - 40) continue;
            C.lerpVectors(A, Bv, j / n).normalize();
            const lat = Math.asin(clamp(C.y, -1, 1)) * (180 / Math.PI), lon = Math.atan2(-C.z, C.x) * (180 / Math.PI);
            samples++;
            if (!isWaterTerrain(w.terrain[latLonTile(lat, lon)])) {
              land += km / n;
              if (worst.length < 4 && (worst.length === 0 || worst[worst.length - 1].seg !== s)) {
                const ll = (V: THREE.Vector3): number[] => { const q = V.clone().normalize(); return [+(Math.asin(clamp(q.y, -1, 1)) * 57.2958).toFixed(2), +(Math.atan2(-q.z, q.x) * 57.2958).toFixed(2)]; };
                worst.push({ seg: s, of: seg.length, km: +km.toFixed(1), from: ll(A), to: ll(Bv) });
              }
            }
          }
          at += km;
        }
        return { unitId: l.unitId, kind: l.kind, plan: l.plan, km: +total.toFixed(0), landKm: +land.toFixed(1), samples, worst };
      });
      return { lines: lines.length, maxLandKm: Math.max(0, ...lines.map((l) => l.landKm)), overLand: lines.filter((l) => l.landKm > 10) };
    },
  };
  const api: UnitsApi = {
    async init(progress) {
      await build(progress);
    },
    warmup(on) {
      if (!built) return;
      root.visible = true;
      for (const im of [...Object.values(unitMeshes), ...Object.values(structMeshes), buildings!, spires!]) {
        im.mesh.count = on ? Math.max(1, im.n) : im.n;
      }
      overlays!.warmup(on);
      icons?.warmup(on);
      if (!on) structDirty = true;
    },
    onGameStart() {
      structDirty = true;
      railDirty = true;
      lastStructFirst = undefined;
      lastStructSize = -1;
    },
    onGameEnd() {
      const fx = fxInternal(ctx);
      for (const t of [...tracks.values()]) releaseTrack(t, fx);
      for (const im of [...Object.values(unitMeshes), ...Object.values(structMeshes)]) {
        im.n = 0;
        im.mesh.count = 0;
      }
      if (buildings) buildings.mesh.count = buildings.n = 0;
      if (spires) spires.mesh.count = spires.n = 0;
      icons?.clear();
      routes.clear(fx);
      structAnchor.clear();
      structHeading.clear();
      cityCache.clear();
      selectedUnits.clear();
      selectedStructure = -1;
      preview.build.structure = -1;
      preview.target.weapon = null;
      preview.order.unitId = -1;
      preview.offensive.tile = -1;
      radarList.length = 0;
      factoryList.length = 0;
      if (rails) {
        rails.begin();
        rails.end();
      }
    },
    update(frame: FrameInfo) {
      if (!built) return;
      // Ending route lines: opacity from the clock on every rendered frame, before anything else (§10.8).
      routes.tickEnding();
      const fx = fxInternal(ctx);
      const paused = ctx.sim.running && ctx.sim.view.speed === 0;
      refreshEnv(frame.frame, ctx.camera, ctx.canvas, (o) => ctx.globe.getSunDirection(o), ctx.cameraRig.getState(camState).altitudeKm, presentationTime(frame.time), paused, frame.now);
      if (fx) {
        fx.trails.setTime(env.fxTime);
        fx.particles.setTime(env.fxTime);
      }
      const view = ctx.sim.view;
      const inGame = ctx.sim.running && view.phase !== 'none';
      root.visible = inGame;
      if (!inGame) return;
      // Icon / model LOD (DESIGN_V2 §10.7).
      const alt = env.altitudeKm;
      iconLod(alt, lod);
      unitFade.value = lod.unitModelFade;
      structFade.value = lod.structModelFade;
      env.unitMinPx = lod.unitMinPx;
      minPxScale.value = lod.structMinPx;
      const wantStructModels = lod.structModelFade > 0;
      if (wantStructModels !== structModelsOn) {
        structModelsOn = wantStructModels;
        structDirty = true;
      }
      viewW = Math.max(1, ctx.canvas.clientWidth || ctx.canvas.width);
      viewH = Math.max(1, ctx.canvas.clientHeight || ctx.canvas.height);
      relations.refresh(frame.now / 1000);
      icons?.begin(viewW, viewH);
      // Structure list changed?
      let first: StructureView | undefined;
      for (const s of view.structures.values()) {
        first = s;
        break;
      }
      // v2 (W4): levels, construction, damage and owners change the models too (a per-update signature).
      if (view.tick !== lastSigTick) {
        lastSigTick = view.tick;
        let sig = 0;
        for (const st of view.structures.values()) sig = (sig * 31 + st.id * 7 + st.level * 131 + Math.round(st.built * 40) * 17 + Math.round(st.hp * 20) * 3 + st.owner + (st.blocks ?? 0) * 13) >>> 0;
        // Feedback 3: rubble appears and clears.
        for (const r of view.ruins) sig = (sig * 31 + r.tile * 5 + r.type) >>> 0;
        if (sig !== lastStructSig) {
          lastStructSig = sig;
          structDirty = true;
        }
      }
      if (first !== lastStructFirst || view.structures.size !== lastStructSize) {
        lastStructFirst = first;
        lastStructSize = view.structures.size;
        structDirty = true;
        railDirty = true;
      }
      refreshDrawSteps();
      if (structDirty) {
        structDirty = false;
        updateStructures();
      }
      updateRadarDishes();
      updateStructureIcons();
      updateUnits(frame, fx);
      icons?.end(frame.now / 1000, {
        unitPx: 22, smallPx: 14, structPx: 18 - 4 * lod.structModelFade, pipPx: 6, unitsOn: true, structsOn: lod.structIcons,
        clusterPx: 26 + 18 * clamp((alt - 6000) / 14000, 0, 1), structOneCat: alt > 8000,
      });
      updateRails(frame.time);
      updateOverlays();
      if (fx) updateAmbient(fx, env.fxDt);
    },
    pickUnit(clientX, clientY) {
      // Icons first (DESIGN_V2 §7.2): what the player sees is what the click picks.
      const hit = iconHitAt(clientX, clientY);
      if (hit) return hit.structure ? -1 : hit.id;
      // The world view hides most units: only what is drawn can be picked.
      if (lod.worldView) return -1;
      const rect = ctx.canvas.getBoundingClientRect();
      let best = -1, bestD = 18 * 18;
      for (const t of tracks.values()) {
        if (!t.hasPos || t.type === UnitType.Shell) continue;
        const d = project(t.pos, clientX, clientY, rect);
        if (d < bestD) {
          bestD = d;
          best = t.id;
        }
      }
      return best;
    },
    pickStructure(clientX, clientY) {
      const hit = iconHitAt(clientX, clientY);
      if (hit) return hit.structure ? hit.id : -1;
      if ((lod.structIcons || lod.worldView) && !structModelsOn) return -1;
      const rect = ctx.canvas.getBoundingClientRect();
      let best = -1, bestD = 20 * 20;
      for (const [id, a] of structAnchor) {
        const d = project(a, clientX, clientY, rect);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      return best;
    },
    pickIcon(clientX, clientY) {
      return iconHitAt(clientX, clientY);
    },
    openIconFan(hit) {
      icons?.openFan(hit as IconHit, performance.now() / 1000 + 8);
    },
    closeIconFan() {
      icons?.closeFan();
    },
    setBattleOwned(ids) {
      battleOwned = ids;
    },
    unitsInRect(x0, y0, x1, y1) {
      const rect = ctx.canvas.getBoundingClientRect();
      const ax = Math.min(x0, x1) - rect.left, bx = Math.max(x0, x1) - rect.left;
      const ay = Math.min(y0, y1) - rect.top, by = Math.max(y0, y1) - rect.top;
      const out: number[] = [];
      const p = new THREE.Vector3();
      for (const u of ctx.sim.view.units.values()) {
        const t = tracks.get(u.id);
        if (t && t.hasPos) p.copy(t.pos);
        else {
          tileXYToLatLon(u.x, u.y, ll2);
          latLonToVec3(ll2.lat, ll2.lon, ctx.globe.surfaceRadiusAt(ll2.lat, ll2.lon), p);
        }
        if (!toScreen(p, 0)) continue;
        if (scrXY.x >= ax && scrXY.x <= bx && scrXY.y >= ay && scrXY.y <= by) out.push(u.id);
      }
      return out;
    },
    getUnitWorldPosition(unitId, out) {
      const t = tracks.get(unitId);
      if (!t || !t.hasPos) return false;
      out.copy(t.pos);
      return true;
    },
  };
  return api;
}
