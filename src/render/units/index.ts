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
// are real-size below 60 km. W4 owns the models, rings and grounding; the hand-off thresholds live in iconLod().

import * as THREE from 'three';
import type { FrameInfo, GameContext, UnitsApi } from '../../shared/api';
import { presentationTime } from '../../shared/shots';
import { EARTH_RADIUS_KM, MAP_W, TILE_KM } from '../../shared/constants';
import { latLonToVec3, tangentFrame, tileToLatLon, tileX, tileXYToLatLon, tileY, wrapDX } from '../../shared/geo';
import { angleDelta, clamp, lerp, lerpAngle } from '../../shared/math';
import { hash3 } from '../../shared/rng';
import { isWaterTerrain } from '../../shared/terrain';
import { StructureType, UnitState, UnitType, type LatLon, type StructureView, type UnitView } from '../../shared/types';
import { fxInternal, type FxInternal } from '../fx';
import { PK } from '../fx/particles';
import type { Trail, TrailStyleKey } from '../fx/trails';
import { airHeightKm, ballisticApexKm, env, refreshEnv, unitSizeKm } from './common';
import { ModelBuilder } from './geom';
import { createModelMaterial, minPxScale, structFade, unitFade } from './material';
import { IconLayer, unitCategory, type IconHit } from './icons';
import { RouteManager, type RouteEnv } from './routes';
import { relationsFor } from '../relations';
import {
  buildBuilding, buildSpire, buildStructModel, buildUnitModel, STRUCT_MODELS, UNIT_MODELS, type StructModelKey, type UnitModelKey,
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
const STRUCT_CAP: Record<StructModelKey, number> = {
  cityBase: 1536, port: 1024, factory: 1024, defensePost: 1536, samSite: 768, silo: 768, airbase: 768, armyBase: 768,
  navalYard: 768, radar: 768, radarDish: 768, beacon: 6144,
};
const MAX_BUILDINGS = 26000;
const MAX_SPIRES = 1536;

/** Structure footprint (km) and model key. */
const STRUCT_INFO: Record<StructureType, { key: StructModelKey; km: number }> = {
  [StructureType.City]: { key: 'cityBase', km: 10 },
  [StructureType.Port]: { key: 'port', km: 9 },
  [StructureType.Factory]: { key: 'factory', km: 8 },
  [StructureType.DefensePost]: { key: 'defensePost', km: 5 },
  [StructureType.SamSite]: { key: 'samSite', km: 6.5 },
  [StructureType.MissileSilo]: { key: 'silo', km: 6 },
  [StructureType.Airbase]: { key: 'airbase', km: 13 },
  [StructureType.ArmyBase]: { key: 'armyBase', km: 8 },
  [StructureType.NavalYard]: { key: 'navalYard', km: 10 },
  [StructureType.Radar]: { key: 'radar', km: 5.5 },
};

function structKm(type: StructureType, level: number): number {
  const base = STRUCT_INFO[type].km;
  if (type === StructureType.City) return base + 1.3 * Math.min(10, level);
  return base * (1 + 0.1 * (Math.max(1, level) - 1));
}

const STRUCT_MIN_PX: Record<StructModelKey, number> = {
  cityBase: 30, port: 26, factory: 24, defensePost: 18, samSite: 22, silo: 22, airbase: 30, armyBase: 24,
  navalYard: 26, radar: 20, radarDish: 20, beacon: 9,
};

const BUILDING_COLORS = [0xc9c3b6, 0xa9b4bf, 0x8d9aa6, 0xd8d6d0, 0x6f7f8e, 0xb8a58f, 0x9fa9a3, 0x7d8ea1];

/**
 * Icon / model hand-off by camera altitude (DESIGN_V2 §10.7):
 *   > 1,500 km       icons only (units 22 px, structures 18 px)
 *   900-1,500 km     unit models fade in from 1,200 km (min 12 px); structures icons only
 *   600-900 km       unit icons shrink to 14 px and float above the models; structure models fade in from 900 km
 *   250-600 km       unit models with a 6 px owner pip above each; structures icons + models
 *   < 250 km         models only (real size below 60 km); structure level shown on hover/selection by the card
 */
export interface IconLod {
  unitModelFade: number;
  structModelFade: number;
  /** 0 full icons, 1 small floating icons, 2 pips. */
  unitIconMode: 0 | 1 | 2;
  structIcons: boolean;
  unitMinPx: number;
  structMinPxScale: number;
}

export function iconLod(altKm: number, out: IconLod): IconLod {
  out.unitModelFade = clamp((1200 - altKm) / 300, 0, 1);
  out.structModelFade = clamp((900 - altKm) / 250, 0, 1);
  out.unitIconMode = altKm > 900 ? 0 : altKm > 600 ? 1 : 2;
  out.structIcons = altKm > 250;
  out.unitMinPx = altKm > 60 ? 12 : 0;
  out.structMinPxScale = altKm > 250 ? 0.5 : clamp((altKm - 120) / 130, 0, 1) * 0.5;
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

interface RadarInfo { id: number; anchor: THREE.Vector3; e: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3; S: number; col: THREE.Color; built: number; hp: number; sel: number }
interface FactoryInfo { anchor: THREE.Vector3; e: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3; S: number; acc: number }

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
  let built = false;
  const lod: IconLod = { unitModelFade: 0, structModelFade: 0, unitIconMode: 0, structIcons: true, unitMinPx: 12, structMinPxScale: 0.5 };
  const relations = relationsFor(ctx);
  let structModelsOn = false;
  const routes = new RouteManager();
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
  const detailMode = true;
  let seenGen = 0;
  const radarList: RadarInfo[] = [];
  const factoryList: FactoryInfo[] = [];

  // Previews from the UI.
  const preview = {
    build: { structure: -1 as number, tile: -1, valid: false },
    target: { weapon: null as number | null, tile: -1, inner: 0, outer: 0, valid: false },
    order: { unitId: -1, tile: -1, valid: false },
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
    const structMats = new Map<number, THREE.ShaderMaterial>();
    const structMat = (px: number) => {
      let m = structMats.get(px);
      if (!m) {
        m = createModelMaterial({ anchored: true, minPx: px });
        structMats.set(px, m);
      }
      return m;
    };
    let k = 0;
    const total = UNIT_MODELS.length + STRUCT_MODELS.length + 2;
    for (const key of UNIT_MODELS) {
      unitMeshes[key] = makeInst(buildUnitModel(key), unitMat, UNIT_CAP[key], false, `unit-${key}`);
      progress(++k / total);
      if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const beaconMat = createModelMaterial({ anchored: true, beacon: true, minPx: STRUCT_MIN_PX.beacon });
    for (const key of STRUCT_MODELS) {
      const mat = key === 'beacon' ? beaconMat : structMat(STRUCT_MIN_PX[key]);
      structMeshes[key] = makeInst(buildStructModel(key), mat, STRUCT_CAP[key], true, `struct-${key}`);
      progress(++k / total);
      if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const cityMat = createModelMaterial({ anchored: true, city: true, minPx: STRUCT_MIN_PX.cityBase });
    buildings = makeInst(buildBuilding(), cityMat, MAX_BUILDINGS, true, 'city-buildings');
    spires = makeInst(buildSpire(), structMat(STRUCT_MIN_PX.cityBase), MAX_SPIRES, true, 'city-spires');
    progress(++k / total);
    rails = new SurfaceRibbon(60000, { widthKm: 0.3, minPx: 0.65, opacity: 0.85, lift: 1.2, name: 'units-rails', renderOrder: 6 });
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
    const gr = t.ship ? 1 : ctx.globe.surfaceRadiusAt(ll2.lat, ll2.lon);
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
    const gr = t.ship ? 1 : ctx.globe.surfaceRadiusAt(ll.lat, ll.lon);
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

  function offerUnitIcon(u: UnitView, pos: THREE.Vector3, sel: boolean, dxPx = 0, dyPx = 0): void {
    if (!icons || !toScreen(pos)) return;
    const size = iconSize(u.type);
    // Small icons float above the model; pips sit just above it.
    const lift = size === 1 ? 16 : size === 2 && lod.unitIconMode === 2 && u.type !== UnitType.Shell && u.type !== UnitType.SamInterceptor ? 11 : 0;
    icons.add(false, u.id, u.type, u.owner, relations.relationTo(u.owner), scrXY.x + dxPx, scrXY.y + dyPx - lift, u.hp, 0, sel, size, unitCategory(u.type));
  }

  function makeRouteEnv(fx: FxInternal): RouteEnv {
    if (!routeEnv) {
      routeEnv = {
        fx, now: 0, altitudeKm: 0,
        relationTo: (o) => relations.relationTo(o),
        radiusAt,
        ownerColor: (o) => ownerColor(o),
        ownerOfXY: (x, y) => ctx.sim.view.owner[Math.min(799, Math.max(0, Math.floor(y))) * MAP_W + ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W] ?? 0,
      };
    }
    routeEnv.fx = fx;
    routeEnv.now = env.fxTime;
    routeEnv.altitudeKm = env.altitudeKm;
    return routeEnv;
  }

  function updateUnits(frame: FrameInfo, fx: FxInternal | undefined): void {
    const view = ctx.sim.view;
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
        t.hasPos = false;
        if (fx) for (let s = 0; s < t.trails.length; s++) stopTrail(fx, t, s);
        // Docked aircraft: an icon beside their base (they cluster into one badge per owner).
        tileXYToLatLon(u.x, u.y, ll2);
        latLonToVec3(ll2.lat, ll2.lon, ctx.globe.surfaceRadiusAt(ll2.lat, ll2.lon), T);
        if (lod.unitIconMode !== 2) offerUnitIcon(u, T, selectedUnits.has(u.id), 15, -12);
        continue;
      }
      const x = lerp(u.prevX, u.x, a), y = lerp(u.prevY, u.y, a);
      const alt = lerp(u.prevAlt, u.alt, a);
      const heading = lerpAngle(u.prevHeading, u.heading, a);
      const s = pose(u, t, x, y, alt, heading, unitK, true);
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
      offerUnitIcon(u, P, sel === 1);
      // Above 1,200 km units are icons only: no model instances at all.
      if (!key || lod.unitModelFade <= 0) continue;
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
          for (let j = 0; j < 7; j++) {
            const ang = j * 2.39996 + env.time * 0.4 * (j % 2 === 0 ? 1 : -1);
            const rr = j === 0 ? 0 : 0.7 + 0.35 * (j % 3);
            const bob = Math.sin(env.time * 2 + j * 1.7) * 0.15;
            Q.copy(P).addScaledVector(R, Math.cos(ang) * rr * s).addScaledVector(B, Math.sin(ang) * rr * s + 0.3 * s).addScaledVector(UP, bob * s);
            put(im, Q, R, UP, B, s, s, s, col, 1, sel, hp, seed + j * 0.1);
          }
          break;
        }
        case UnitType.ArmoredDivision: {
          for (let j = 0; j < 4; j++) {
            Q.copy(G).addScaledVector(R, TANK_OFFS[j][0] * s).addScaledVector(B, TANK_OFFS[j][1] * s);
            Q.normalize();
            const rr = ctx.globe.surfaceRadiusAt(Math.asin(clamp(Q.y, -1, 1)) * (180 / Math.PI), Math.atan2(-Q.z, Q.x) * (180 / Math.PI));
            put(im, Q.multiplyScalar(rr), R, UP, B, s, s, s, col, 1, sel, hp, seed);
          }
          break;
        }
        case UnitType.Train: {
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

  function updateStructures(): void {
    const view = ctx.sim.view;
    for (const key of STRUCT_MODELS) structMeshes[key].n = 0;
    buildings!.n = 0;
    spires!.n = 0;
    radarList.length = 0;
    factoryList.length = 0;
    for (const id of structAnchor.keys()) {
      if (!view.structures.has(id)) {
        structAnchor.delete(id);
        structHeading.delete(id);
        cityCache.delete(id);
      }
    }
    for (const st of view.structures.values()) {
      tileToLatLon(st.tile, ll);
      tangentFrame(ll.lat, ll.lon, E, N, U);
      let anchor = structAnchor.get(st.id);
      if (!anchor) {
        anchor = new THREE.Vector3();
        structAnchor.set(st.id, anchor);
      }
      latLonToVec3(ll.lat, ll.lon, ctx.globe.surfaceRadiusAt(ll.lat, ll.lon), anchor);
      if (!structModelsOn) continue;
      const col = ownerColor(st.owner);
      const sel = st.id === selectedStructure ? 1 : 0;
      const info = STRUCT_INFO[st.type];
      const S = structKm(st.type, st.level) / EARTH_RADIUS_KM;
      const seed = (st.id * 0.618) % 1;
      if (!detailMode) {
        const bs = 2.2 / EARTH_RADIUS_KM;
        put(structMeshes.beacon, anchor, E, U, N, bs, bs, bs, col, 1, sel, st.hp, seed, anchor, bs);
        continue;
      }
      const h = headingFor(st);
      F.copy(N).multiplyScalar(Math.cos(h)).addScaledVector(E, Math.sin(h));
      R.crossVectors(F, U).normalize();
      B.copy(F).negate();
      put(structMeshes[info.key], anchor, R, U, B, S, S, S, col, st.built, sel, st.hp, seed, anchor, S);
      if (st.type === StructureType.City) {
        const capital = view.players[st.owner]?.capitalTile === st.tile;
        const cs = citySpec(st, capital);
        let sp = 0;
        for (let i = 0; i < cs.n; i++) {
          const o = i * 8;
          const bx = cs.b[o], bz = cs.b[o + 1], w = cs.b[o + 2] * S, d = cs.b[o + 3] * S, hh = cs.b[o + 4] * S, rot = cs.b[o + 5];
          const cr = Math.cos(rot), sr = Math.sin(rot);
          bR.copy(R).multiplyScalar(cr).addScaledVector(B, sr);
          bB.copy(B).multiplyScalar(cr).addScaledVector(R, -sr);
          Q.copy(anchor).addScaledVector(R, bx * S).addScaledVector(B, bz * S).addScaledVector(U, 0.004 * S);
          tmpColor.setHex(BUILDING_COLORS[cs.b[o + 6] | 0]);
          put(buildings!, Q, bR, U, bB, w, hh, d, tmpColor, st.built, sel, cs.b[o + 7], 2 + (i % 2), anchor, S);
          if (hh > 0.2 * S && sp < cs.spires) {
            sp++;
            T.copy(Q).addScaledVector(U, hh);
            put(spires!, T, bR, U, bB, w, w * 1.4, d, col, st.built, sel, st.hp, seed, anchor, S);
          }
        }
      } else if (st.type === StructureType.Radar) {
        radarList.push({ id: st.id, anchor, e: R.clone(), n: F.clone(), u: U.clone(), S, col: col.clone(), built: st.built, hp: st.hp, sel });
      } else if (st.type === StructureType.Factory && st.built >= 1) {
        factoryList.push({ anchor, e: R.clone(), n: F.clone(), u: U.clone(), S, acc: Math.random() });
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
      icons.add(true, st.id, st.type, st.owner, relations.relationTo(st.owner), scrXY.x, scrXY.y, st.hp, st.level, st.id === selectedStructure, 0, st.type);
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
        put(dish, Q, bR, r.u, bB, r.S, r.S, r.S, r.col, r.built, r.sel, r.hp, 0, r.anchor, r.S);
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
      const Se = Math.max(f.S, STRUCT_MIN_PX.factory * minPxScale.value * env.pixelK * dist);
      const i = Math.floor(fx.particles.rand() * 3);
      const lx = i === 0 ? -0.34 : i === 1 ? -0.2 : -0.06;
      Q.copy(f.anchor).addScaledVector(f.e, lx * Se).addScaledVector(f.n, 0.3 * Se).addScaledVector(f.u, 0.4 * Se);
      const s = Se * 0.08;
      fx.particles.emit(PK.Smoke, Q.x, Q.y, Q.z, f.u.x * s * 0.6 + f.e.x * s * 0.3, f.u.y * s * 0.6 + f.e.y * s * 0.3, f.u.z * s * 0.6 + f.e.z * s * 0.3,
        5 + fx.particles.rand() * 3, s * 0.6, s * 4, 0.3, s * 0.05);
    }
    // Damaged structures smoulder.
    for (const st of view.structures.values()) {
      if (st.hp > 0.55) continue;
      if (fx.particles.rand() > dt * 3) continue;
      const anchor = structAnchor.get(st.id);
      if (!anchor) continue;
      fx.burn(anchor, fx.visKm(anchor, structKm(st.type, st.level) * 0.3, 8), 1.5);
    }
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
    // CAP circles while a fighter patrols (v2-stub(W2→W4): "patrolling" = airborne within 8 tiles of its target until
    // W4 publishes the unit mode), warship patrol / blockade zones when selected.
    for (const u of view.units.values()) {
      if (u.type === UnitType.FighterSquadron && u.state !== UnitState.Docked && u.alt > 0.2) {
        const dx = wrapDX(u.x, u.targetX), dy = u.targetY - u.y;
        if (dx * dx + dy * dy < 64) {
          tileXYToLatLon(u.targetX, u.targetY, ll2);
          ov.ring({ lat: ll2.lat, lon: ll2.lon, radiusKm: 150, minPx: 10, style: 2, color: ownerColor(u.owner).getHex(), alpha: 0.7, dashes: 40, spin: 0.02 }, radiusAt);
        }
      } else if (u.type === UnitType.Warship && selectedUnits.has(u.id)) {
        tileXYToLatLon(u.targetX, u.targetY, ll2);
        ov.ring({ lat: ll2.lat, lon: ll2.lon, radiusKm: 150, minPx: 10, style: 2, color: ownerColor(u.owner).getHex(), alpha: 0.8, dashes: 36, spin: 0.03 }, radiusAt);
      }
    }
    if (selectedStructure >= 0) {
      const st = view.structures.get(selectedStructure);
      if (st) {
        tileToLatLon(st.tile, ll);
        tmpColor.copy(ownerColor(st.owner)).lerp(white, 0.4);
        ov.ring({ lat: ll.lat, lon: ll.lon, radiusKm: structKm(st.type, st.level) * 0.8, minPx: 26, style: 0, color: tmpColor.getHex(), alpha: 1, dashes: 16, spin: 0.12 }, radiusAt);
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
      ov.ghost(String(type), ll, km, STRUCT_MIN_PX[STRUCT_INFO[type].key] * minPxScale.value, preview.build.valid, radiusAt, env.camPos, env.pixelK);
    } else ov.ghost(null, null, 0, 0, false, radiusAt, env.camPos, env.pixelK);
    // Order path.
    ov.path.begin();
    if (preview.order.unitId >= 0 && preview.order.tile >= 0) {
      const t = tracks.get(preview.order.unitId);
      if (t && t.hasPos) {
        ll.lat = t.lat;
        ll.lon = t.lon;
        tileToLatLon(preview.order.tile, ll2);
        const c = preview.order.valid ? 0x46e0ff : 0xff4a3a;
        ov.path.addArc(ll, ll2, c, radiusAt, 15, 0.3);
        ov.ring({ lat: ll2.lat, lon: ll2.lon, radiusKm: 6, minPx: 14, style: 0, color: c, alpha: 1, dashes: 8, spin: -0.4 }, radiusAt);
      }
    }
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

  /** Debug / measurement hook (DESIGN_V2 §16.3): what is drawn right now. */
  function stats(): Record<string, unknown> {
    let unitModels = 0, structureModels = 0;
    for (const key of UNIT_MODELS) unitModels += unitMeshes[key]?.mesh.count ?? 0;
    for (const key of STRUCT_MODELS) structureModels += structMeshes[key]?.mesh.count ?? 0;
    structureModels += (buildings?.mesh.count ?? 0) + (spires?.mesh.count ?? 0);
    const view = ctx.sim.view;
    return {
      altitudeKm: +env.altitudeKm.toFixed(1), lod: { ...lod }, unitModels, structureModels,
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
    /** Pickable icons drawn this frame, in client px (verification: clustering, scripted clicks). */
    icons: () => {
      const rect = ctx.canvas.getBoundingClientRect();
      return (icons?.debugHits() ?? []).map((h) => ({ ...h, x: h.x + rect.left, y: h.y + rect.top }));
    },
  };
  (window as unknown as { __units?: unknown }).__units = debugHook;
  (window as unknown as { __trails?: unknown }).__trails = {
    stats: () => ({ ...routes.stats({ relationTo: (o: number) => relations.relationTo(o) }), humanSuppressed: routes.humanSuppressed() }),
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
      radarList.length = 0;
      factoryList.length = 0;
      if (rails) {
        rails.begin();
        rails.end();
      }
    },
    update(frame: FrameInfo) {
      if (!built) return;
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
      minPxScale.value = lod.structMinPxScale;
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
      if (first !== lastStructFirst || view.structures.size !== lastStructSize) {
        lastStructFirst = first;
        lastStructSize = view.structures.size;
        structDirty = true;
        railDirty = true;
      }
      if (structDirty) {
        structDirty = false;
        updateStructures();
      }
      updateRadarDishes();
      updateStructureIcons();
      updateUnits(frame, fx);
      icons?.end(frame.now / 1000, { unitPx: 22, smallPx: 14, structPx: 18, pipPx: 6, unitsOn: true, structsOn: lod.structIcons });
      updateRails(frame.time);
      updateOverlays();
      if (fx) updateAmbient(fx, env.fxDt);
    },
    pickUnit(clientX, clientY) {
      // Icons first (DESIGN_V2 §7.2): what the player sees is what the click picks.
      const hit = iconHitAt(clientX, clientY);
      if (hit) return hit.structure ? -1 : hit.id;
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
      if (lod.structIcons && !structModelsOn) return -1;
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
    getUnitWorldPosition(unitId, out) {
      const t = tracks.get(unitId);
      if (!t || !t.hasPos) return false;
      out.copy(t.pos);
      return true;
    },
  };
  return api;
}
