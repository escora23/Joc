// FRONT ULTRA — ground war near active fronts (owner: battle).
//
// When the camera descends toward an active front, a local battlefield streams in, anchored on the contact line
// under the view: real-relief terrain with a splatted war-torn ground (./terrain) over a farmland patchwork shared by
// the ground shader and the scatterers (./fields), roads, villages, woods, hedgerows and woodlots with two tree LODs
// (./props), thousands of GPU-animated soldiers fighting by fire-and-maneuver (./infantry), tank platoons,
// APCs, howitzer batteries, SPAAGs, attack helicopters, armored columns and trucks (./vehicles), and the whole
// catalogue of combat effects (./effects, ./particles): muzzle flashes, tracers, shells on ballistic arcs,
// explosions, craters, burning villages and wrecks with smoke columns, drifting battle haze and local lights.
// Density follows the sim's FrontView (troops on each side, intensity) and the quality preset; small-arms fire,
// mortar and artillery impacts concentrate along the stretch of front the camera is looking at.
// Above ~20 km the individual war is invisible, so ./far paints artillery flashes, fires and smoke columns
// along every front in view up to BATTLE_LAYER_ALT_KM.
//
// Seamless with the globe: sun color, sky ambient and aerial perspective come from the same scattering model as
// the globe (./atmo), the patch sits on the globe's own exaggerated relief and its rim melts into the globe's
// albedo, and a monotonic depth pull keeps the battlefield in front of the coarser globe surface (no z-fighting).
// The layer crossfades with altitude (screen-door dissolve) and never pops.

import * as THREE from 'three';
import type { BattleApi, BattleView, CameraState, FrameInfo, GameContext } from '../../shared/api';
import { BATTLE_LAYER_ALT_KM, HUMAN_ID, MAP_H, MAP_W, TICKS_PER_GAME_HOUR, TILE_KM } from '../../shared/constants';
import { latLonToTile, latLonToVec3, tangentFrame, tileXYToLatLon, wrapDX } from '../../shared/geo';
import { smoothstep } from '../../shared/math';
import { territoryFillAmount } from '../globe/glsl';
import type { QualityProfile } from '../../shared/quality';
import { hashString } from '../../shared/rng';
import { UnitMode, UnitType, type FrontView, type LatLon } from '../../shared/types';
import { deriveLocalForcesAt, visibleSplit, type LocalForces, type LocalFront } from '../../shared/localForces';
import { Biome, getWorldAux } from '../../data';
import { updateAir, type AirState } from './atmo';
import { FastRng, M_PER_DEG, R_M, createBattleUniforms, depthVariant, separateTeamColors } from './common';
import { createEffects, type Effects } from './effects';
import { createFarLayer, gcKm, type FarLayer } from './far';
import { createFrontOverlay, type FrontOverlay } from './overlay';
import { FrontGeom } from './front';
import { createInfantry, type Infantry } from './infantry';
import { VehicleKind } from './models';
import { PK } from './particles';
import { buildProps, createPropsShared, type PropsResult, type PropsShared } from './props';
import { buildTerrain, createTerrainShared, type TerrainPatch, type TerrainShared } from './terrain';
import { createShadowPass, shadowStats, type ShadowPass } from './shadow';
import { makeDetailTexture, makePuffTexture } from './textures';
import { createVehicles, type FormationSlot, type Vehicles, type VehicleCounts } from './vehicles';

/** Altitude (km) below which the local battlefield is built / starts fading in / is fully visible. */
const NEAR_BUILD_ALT = 70;
const NEAR_FADE_START = 42;
const NEAR_FADE_FULL = 24;
/** Re-anchor when the view slides this far along the front (km). */
const REANCHOR_KM = 3.2;
/** Re-anchor when the moving front line has left this far from the patch centre (m): the battle follows it. */
const LINE_LEAVE_M = 4500;
/** Radius (km) of the local forces the infantry is composed from (the battle patch), and of the real divisions shown. */
const FORCES_RADIUS_KM = 6;
const DIVISIONS_RADIUS_KM = 50;
/** Time constant (real s) of the displayed line following the sim line (extrapolated at the measured km/h). */
const LINE_FOLLOW_S = 1.2;

interface Anchor {
  lat: number;
  lon: number;
  frontA: number;
  frontB: number;
  seed: number;
  /** Stable key of the front it shows (0 = staged without one). */
  frontKey: number;
  /** Camera target when it was chosen: the battle stays while the camera stays near it (the line may move). */
  camLat: number;
  camLon: number;
}

/** What the ground battle shows (debug / verifiers, and the HUD strip through BattleApi.view). */
export interface BattleShown {
  frontKey: number;
  a: number;
  b: number;
  /** Soldiers deployed per side (team 0 = side a) and what visibleSplit() asked for. */
  infantry: [number, number];
  split: [number, number];
  /** Real divisions drawn: unit id, tanks + IFVs, their real local position (m) and the drawn centroid. */
  divisions: { unitId: number; owner: number; tanks: number; ifvs: number; realX: number; realZ: number; drawnX: number; drawnZ: number; team: number }[];
  /** Displayed line offset (m along the advance normal) and the sim's sub-tile line at the last sample. */
  lineShift: number;
  simShift: number;
  /** Line speed shown (m per real s) and expected advanceKmh × rate / 3.6. */
  lineSpeed: number;
  expectedSpeed: number;
  advanceKmh: number;
  subTile: boolean;
  clockMode: string;
  /** Line samples taken / with the front found. */
  samples: [number, number];
}

export interface BattleDebug {
  /** Force the battle at a place (shots): anchors the near layer there for the given front pair and direction. */
  stageAt(lat: number, lon: number, a: number, b: number, dirX: number, dirY: number, frontKey?: number): void;
  /** Run the battle logic for `seconds` of battle time right now (shells in the air, smoke drifting...). */
  prewarm(seconds: number): void;
  readonly anchor: LatLon | null;
  /** Local front frame (for camera staging): tangent/normal in the anchor's east/south plane. */
  readonly frontDir: { tx: number; tz: number; nx: number; nz: number };
  shadowCoverage(): number;
  /** True once the battlefield is fully streamed in. */
  readonly built: boolean;
  /** W6: what the battle shows (forces, divisions, line) — null when no battle is built. */
  shown(): BattleShown | null;
  /** W6: animation clock (real seconds of battle time) — advances with real time, freezes on pause. */
  readonly clock: number;
  /** W6 verifiers: far-layer stats, the overlay's stats, and hiding the whole battle layer (smoke coverage A/B). */
  farStats(): ReturnType<FarLayer['stats']> | null;
  setLayerVisible(on: boolean): void;
}

let currentDebug: BattleDebug | null = null;

function shadowSize(q: QualityProfile): number {
  return q.shadows <= 0 ? 0 : Math.min(4096, q.shadows);
}
/** Shot/debug access to the live battle renderer (battle-owned shots only). */
export function battleDebug(): BattleDebug | null {
  return currentDebug;
}

export function createBattleRenderer(ctx: GameContext): BattleApi {
  const root = new THREE.Group();
  root.name = 'battle';
  ctx.scene.add(root);
  const near = new THREE.Group();
  near.name = 'battle-near';
  near.visible = false;
  root.add(near);
  const warmGroup = new THREE.Group();
  warmGroup.visible = false;

  let quality: QualityProfile = ctx.quality;
  const uniforms = createBattleUniforms();
  let ready = false;
  let terrainShared: TerrainShared | null = null;
  let propsShared: PropsShared | null = null;
  let infantry: Infantry | null = null;
  let vehicles: Vehicles | null = null;
  let effects: Effects | null = null;
  let far: FarLayer | null = null;
  let shadow: ShadowPass | null = null;
  let patch: TerrainPatch | null = null;
  let props: PropsResult | null = null;
  const front = new FrontGeom();
  let anchor: Anchor | null = null;
  let pendingAnchor: Anchor | null = null;
  const pendingDir = { x: 0, z: 1 };
  let forced: { lat: number; lon: number; a: number; b: number; dirX: number; dirY: number; key: number } | null = null;
  // ---- the line from the sim (§11.5): displayed offset along the advance normal, following the sub-tile line ----
  /** Sim line offset (m along N from the anchor) at the last sample, the game hour of that sample, the extrapolation. */
  let simShift = 0, simHours = 0, simSpeedMs = 0, simDir = 0, simKmh = 0, simSub = false;
  /**
   * The displayed line glides from where it was to the sim's newest sub-tile line over one tick period (6 real s in
   * observation time): continuous motion at the real local speed of the front, one tick behind the sim, never ahead.
   */
  let lineFrom = 0, lineTo = 0, lineTick = -1, lineElapsedMs = 0;
  let sampleAcc = 0, divAcc = 0, lastWallMs = 0, samplesTaken = 0, samplesFound = 0;
  let lineSpeed = 0;
  let splitWanted: [number, number] = [0, 0];
  const shownDivs: BattleShown['divisions'] = [];
  const formationSlots: FormationSlot[] = [];
  const battleOwned = new Set<number>();
  let lastLF: LocalForces | null = null;
  let nearFade = 0;
  let clock = 1000;
  let active = false;
  let intensity = 0;
  let farIntensity = 0;
  let frontIntensity = 0.5;
  let activity = 0.5;
  const air: AirState = { muS: 1, sun: new THREE.Vector3() };
  // The orbit overlay (§11.2): front bands, operational / naval / mobilization arrows.
  const overlay: FrontOverlay = createFrontOverlay(ctx);
  ctx.scene.add(overlay.group);
  try {
    (window as unknown as { __frontOverlay?: FrontOverlay }).__frontOverlay = overlay;
  } catch {
    /* no window */
  }

  const aUp = new THREE.Vector3(), aEast = new THREE.Vector3(), aNorth = new THREE.Vector3();
  const sunW = new THREE.Vector3();
  const camState: CameraState = { lat: 0, lon: 0, altitudeKm: 1000, tilt: 0, heading: 0 };
  const invNear = new THREE.Matrix4();
  const farInv = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const nrmT = new THREE.Vector3();
  const ll: LatLon = { lat: 0, lon: 0 };
  const avoidLL: LatLon = { lat: 0, lon: 0 };
  const rng = new FastRng(12345);
  const splat = new Float32Array(8);
  let shotAcc = 0, mortarAcc = 0, heavyAcc = 0, hazeAcc = 0;
  /** Along-front coordinate of the camera's target point: effects concentrate where the player looks. */
  let focusU = 0;
  const focusUV = new THREE.Vector2();
  const surfaceAt = (la: number, lo: number) => ctx.globe.surfaceRadiusAt(la, lo);

  // ---------------------------------------------------------------------------------------------------------
  // Helpers shared with the modules
  // ---------------------------------------------------------------------------------------------------------
  const heightAt = (x: number, z: number) => (patch ? patch.heightAt(x, z) : 0);
  const normalAt = (x: number, z: number, out: THREE.Vector3) => (patch ? patch.normalAt(x, z, out) : out.set(0, 1, 0));
  const isWater = (x: number, z: number) => {
    if (!patch) return false;
    return patch.splatAt(x, z, splat) > 0.4 && patch.heightAt(x, z) < 1.5;
  };
  const blocked = (x: number, z: number) => {
    if (!patch) return true;
    if (Math.hypot(x, z) > 7600) return true;
    if (isWater(x, z)) return true;
    normalAt(x, z, nrmT);
    return nrmT.y < 0.8;
  };
  const camL = uniforms.uCamL.value;
  const lod = (x: number, y: number, z: number) => {
    const d = Math.hypot(x - camL.x, y - camL.y, z - camL.z);
    return Math.max(0, Math.min(1, 1.6 - d / 2500));
  };

  function makeModules(): void {
    const detail = makeDetailTexture(256);
    const puff = makePuffTexture(256);
    const ts = createTerrainShared(uniforms, detail);
    const ps = createPropsShared(uniforms, detail);
    terrainShared = ts;
    propsShared = ps;
    const inf = createInfantry(uniforms, quality.battleInfantry);
    infantry = inf;
    const fx = createEffects(uniforms, puff, {
      heightAt, normalAt, isWater, lod,
      onBlast(x, z, radius, now) {
        inf.blast(x, z, radius, now);
        if (radius > 12) vehicles?.blast(x, z, radius * 0.5, now, fx);
      },
    }, quality.particles, quality.decals);
    effects = fx;
    const veh = createVehicles(uniforms, {
      heightAt, normalAt, blocked, lod,
      enemyTarget(team, r, out) {
        const other = 1 - team;
        if (r.chance(0.35)) {
          const list = veh.list;
          for (let k = 0; k < 4 && list.length > 0; k++) {
            const v = list[r.int(list.length)];
            if (v.team === other && v.kind !== VehicleKind.Heli) {
              out.set(v.x, v.y, v.z);
              return true;
            }
          }
        }
        return inf.pickTarget(other, r, out);
      },
    }, Math.ceil(quality.battleVehicles * 0.45));
    vehicles = veh;
    far = createFarLayer(puff, Math.floor(quality.particles * 0.35));
    near.add(inf.mesh, veh.group, fx.decals, fx.alpha.mesh, fx.add.mesh);
    root.add(far.group);
    // Shadow casters get depth-only twins of their materials.
    const vehMat = (veh.group.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    // (The terrain itself does not cast: at grazing dawn/dusk sun angles terrain self-shadowing through a single
    // map is acne-prone; the relief is shaded by the sun angle and the objects cast onto it.)
    const depthMats = [ps.houseMat, ps.coniferMat, ps.broadMat, vehMat].map(depthVariant);
    shadow = createShadowPass(uniforms, shadowSize(quality));

    // Warm-up meshes: one tiny mesh per material so every program compiles during loading.
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
    tri.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    tri.setAttribute('aRim', new THREE.Float32BufferAttribute([0, 0, 0], 1));
    tri.setAttribute('aTerr', new THREE.Float32BufferAttribute(new Float32Array(12), 4));
    tri.setAttribute('aDepth', new THREE.Float32BufferAttribute([1, 1, 1], 1));
    tri.setAttribute('aRoad', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    for (const m of [ts.fineMat, ts.coarseMat, ts.outerMat, ts.waterMat, ps.roadMat]) {
      const mesh = new THREE.Mesh(tri, m);
      mesh.frustumCulled = false;
      warmGroup.add(mesh);
    }
    const inst = (geo: THREE.BufferGeometry, m: THREE.Material, attrs: string[]) => {
      const g = new THREE.InstancedBufferGeometry();
      for (const k of ['position', 'normal', 'aPart']) g.setAttribute(k, geo.getAttribute(k));
      for (const a of attrs) g.setAttribute(a, new THREE.InstancedBufferAttribute(new Float32Array(4), 4));
      g.instanceCount = 1;
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      warmGroup.add(mesh);
    };
    inst(ps.houseGeo, ps.houseMat, ['iP', 'iS', 'iK']);
    inst(ps.coniferGeo, ps.coniferMat, ['iT', 'iU']);
    inst(ps.broadGeo, ps.broadMat, ['iT', 'iU']);
    inst(ps.houseGeo, depthMats[0], ['iP', 'iS', 'iK']);
    inst(ps.coniferGeo, depthMats[1], ['iT', 'iU']);
    inst(ps.broadGeo, depthMats[2], ['iT', 'iU']);
    {
      const vg = (veh.group.children[0] as THREE.Mesh).geometry;
      const mesh = new THREE.Mesh(vg, depthMats[3]);
      mesh.frustumCulled = false;
      warmGroup.add(mesh);
    }
    near.add(warmGroup);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Front search: nearest contact line to the view target (km), and the projected point.
  // ---------------------------------------------------------------------------------------------------------
  interface Hit { f: FrontView | null; dist: number; px: number; py: number }
  const hit: Hit = { f: null, dist: 1e9, px: 0, py: 0 };
  function nearestFront(lat: number, lon: number, fronts: readonly FrontView[]): Hit | null {
    const tx = ((lon + 180) / 360) * MAP_W;
    const ty = ((90 - lat) / 180) * MAP_H;
    const kx = Math.cos((lat * Math.PI) / 180) * TILE_KM, ky = TILE_KM;
    hit.dist = 1e9;
    hit.f = null;
    for (const f of fronts) {
      if (f.b === 0) continue;
      const s = f.samples;
      const n = s.length / 2;
      const ox = f.dirX * 0.5, oy = f.dirY * 0.5;
      for (let i = 0; i < n; i++) {
        const i1 = Math.min(n - 1, i + 1);
        const ax = s[i * 2], ay = s[i * 2 + 1];
        const bx = ax + wrapDX(ax, s[i1 * 2]), by = s[i1 * 2 + 1];
        // Contact line: half a tile ahead of the attacker's border tiles.
        const pax = wrapDX(tx, ax + ox) * kx, pay = (ay + oy - ty) * ky;
        const pbx = wrapDX(tx, bx + ox) * kx, pby = (by + oy - ty) * ky;
        const ex = pbx - pax, ey = pby - pay;
        const el = ex * ex + ey * ey;
        let t = el > 1e-9 ? -(pax * ex + pay * ey) / el : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = pax + ex * t, qy = pay + ey * t;
        const d = Math.hypot(qx, qy);
        if (d < hit.dist) {
          hit.dist = d;
          hit.f = f;
          hit.px = tx + qx / kx;
          hit.py = ty + qy / ky;
        }
      }
    }
    return hit.f ? hit : null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Build / tear down the local battlefield
  // ---------------------------------------------------------------------------------------------------------
  function teardown(): void {
    if (props) {
      near.remove(props.group);
      props.dispose();
      props = null;
    }
    if (patch) {
      near.remove(patch.group);
      patch.dispose();
      patch = null;
    }
    infantry?.clear();
    vehicles?.clear();
    effects?.clear();
    anchor = null;
    front.drift = 0;
    shownDivs.length = 0;
    lastLF = null;
    if (battleOwned.size) {
      battleOwned.clear();
      ctx.units.setBattleOwned?.(null);
    }
  }

  function setAnchorFrame(lat: number, lon: number): void {
    tangentFrame(lat, lon, aEast, aNorth, aUp);
    const m = new THREE.Matrix4().makeBasis(aEast, aUp, aNorth.clone().negate());
    near.quaternion.setFromRotationMatrix(m);
    near.position.copy(aUp); // sea level; local y = displayed height in meters
    near.scale.setScalar(1 / R_M);
    near.updateMatrixWorld(true);
    invNear.copy(near.matrixWorld).invert();
  }

  function frontStats(a: number, b: number): { tA: number; tB: number; intensity: number; armorA: boolean; armorB: boolean } {
    const view = ctx.sim.view;
    let best: FrontView | null = null;
    for (const f of view.fronts) if (f.a === a && f.b === b && (!best || f.intensity > best.intensity)) best = f;
    const pa = view.players[a], pb = view.players[b];
    const tA = best ? best.troopsA : pa?.troops ?? 1000;
    const tB = best ? best.troopsB : pb?.troops ?? 1000;
    let armorA = false, armorB = false;
    if (anchor) {
      for (const u of view.units.values()) {
        if (u.type !== UnitType.ArmoredDivision) continue;
        tileXYToLatLon(u.x, u.y, ll);
        if (gcKm(ll.lat, ll.lon, anchor.lat, anchor.lon) > 350) continue;
        if (u.owner === a) armorA = true;
        if (u.owner === b) armorB = true;
      }
    }
    return { tA, tB, intensity: best ? best.intensity : 0.5, armorA, armorB };
  }

  // ---------------------------------------------------------------------------------------------------------
  // The battle from the real simulation (§11.5): local forces, the sub-tile line, the real divisions
  // ---------------------------------------------------------------------------------------------------------
  /** The anchor's front in the local forces (by stable key; else the pair; else the nearest). */
  function pickLocalFront(lf: LocalForces, an: Anchor): LocalFront | null {
    let f = an.frontKey ? lf.fronts.find((q) => q.key === an.frontKey) : undefined;
    if (!f) f = lf.fronts.find((q) => (q.a === an.frontA && q.b === an.frontB) || (q.a === an.frontB && q.b === an.frontA));
    return f ?? null;
  }
  /**
   * Signed offset (m) of the local front's sub-tile line from the anchor along the battle's advance normal: where the
   * line crosses the advance axis through the anchor (so an advance of d metres moves it by d, whatever the line's
   * local slant); the nearest point's projection when the axis misses the local polyline.
   */
  function lineOffsetM(f: LocalFront): number {
    // Local km: east, north. The advance normal in (east, north): (nx, -nz).
    const ne = front.nx, nn = -front.nz;
    const L = f.lineKm;
    let best = Infinity;
    for (let i = 0; i + 3 < L.length; i += 2) {
      const e0 = L[i], n0 = L[i + 1], de = L[i + 2] - e0, dn = L[i + 3] - n0;
      // Solve t·N = p0 + u·d  →  2x2 system.
      const det = ne * -dn - nn * -de;
      if (Math.abs(det) < 1e-9) continue;
      const t = (e0 * -dn - n0 * -de) / det;
      const u = (ne * n0 - nn * e0) / det;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      if (Math.abs(t) < Math.abs(best)) best = t;
    }
    if (Number.isFinite(best)) return best * 1000;
    const px = f.nearest.eastKm * 1000, pz = -f.nearest.northKm * 1000;
    return px * front.nx + pz * front.nz;
  }
  /** Soldiers per team (0 = side a) from visibleSplit() of the two sides' pools. */
  function splitFor(lf: LocalForces, a: number, b: number): [number, number] {
    const sa = lf.sides.find((q) => q.owner === a), sb = lf.sides.find((q) => q.owner === b);
    const two = { ...lf, sides: [sa, sb].filter((q): q is NonNullable<typeof q> => !!q) };
    const split = visibleSplit(two, quality.battleInfantry);
    let ia = 0, ib = 0, k = 0;
    if (sa) ia = split[k++];
    if (sb) ib = split[k++];
    return [ia, ib];
  }
  /** Who is pushing, from the front's momentum (+ = side a gaining). */
  function setPush(m: number): void {
    if (m > 0.1) {
      front.pushA = 1;
      front.pushB = -0.2;
    } else if (m < -0.1) {
      front.pushA = -0.2;
      front.pushB = 1;
    } else {
      front.pushA = 0.3;
      front.pushB = 0.3;
    }
  }
  /** Re-read the sim line (every 0.25 real s): its sub-tile offset, the measured speed and which way it moves. */
  function sampleLine(): void {
    if (!anchor) return;
    const view = ctx.sim.view;
    const lf = deriveLocalForcesAt(view, anchor.lat, anchor.lon, FORCES_RADIUS_KM, HUMAN_ID);
    lastLF = lf;
    const f = pickLocalFront(lf, anchor);
    samplesTaken++;
    if (f) samplesFound++;
    if (!f) {
      simSpeedMs = 0;
      simDir = 0;
      return;
    }
    simShift = lineOffsetM(f);
    simHours = view.tick / TICKS_PER_GAME_HOUR;
    if (view.tick !== lineTick) {
      // A new tick: glide from where the line is drawn now to the new position over the next tick period.
      lineFrom = front.drift;
      lineTick = view.tick;
      lineElapsedMs = 0;
    }
    lineTo = simShift;
    simKmh = f.advanceKmh;
    simSub = f.subTile;
    simDir = f.momentum > 0.1 ? 1 : f.momentum < -0.1 ? -1 : 0;
    // The line moves continuously only when the sim publishes the sub-tile progress (observation time near the focus):
    // then it is extrapolated between ticks at the measured advance. Otherwise it waits for the next tile.
    simSpeedMs = simSub && simDir !== 0 ? (f.advanceKmh * 1000) / 3600 : 0;
    frontIntensity += (f.intensity - frontIntensity) * 0.3;
    activity = Math.min(1, 0.45 + frontIntensity * 0.7);
    setPush(f.momentum);
  }
  /** Move the displayed line toward the sim line (extrapolated), and the armies with it. */
  function followLine(realDt: number): void {
    const view = ctx.sim.view;
    let target: number;
    if (simSub) {
      lineElapsedMs += realDt * 1000;
      const frac = Math.min(1, lineElapsedMs / Math.max(100, view.clock.tickPeriodMs || 6000));
      target = lineFrom + (lineTo - lineFrom) * frac;
    } else {
      // No sub-tile progress (observation time off or far from the focus): the line waits for the next tile.
      target = lineTo;
    }
    const prev = front.drift;
    const k = simSub ? 1 : realDt > 0 ? 1 - Math.exp(-realDt / LINE_FOLLOW_S) : 0;
    const next = prev + (target - prev) * k;
    const d = next - prev;
    lineSpeed = realDt > 0 ? lineSpeed * 0.8 + 0.2 * (d / realDt) : lineSpeed;
    if (Math.abs(d) < 1e-4) return;
    front.drift = next;
    front.rebuild();
    front.apply(uniforms);
    infantry?.translate(front.nx * d, front.nz * d);
  }
  /**
   * The real divisions within 50 km (§11.5): 1 tank per 25 % integrity + 2 IFVs at the division's real position and
   * heading relative to the anchor, driving with it. Divisions of third parties fight on the side they are allied
   * with or at war against.
   */
  function updateDivisions(alpha: number): void {
    if (!anchor || !vehicles) return;
    const view = ctx.sim.view;
    const lf = deriveLocalForcesAt(view, anchor.lat, anchor.lon, DIVISIONS_RADIUS_KM, HUMAN_ID, { alpha });
    formationSlots.length = 0;
    shownDivs.length = 0;
    battleOwned.clear();
    const a = anchor.frontA, b = anchor.frontB;
    for (const u of lf.units) {
      if (u.type !== UnitType.ArmoredDivision) continue;
      let team = u.owner === a ? 0 : u.owner === b ? 1 : -1;
      if (team < 0) {
        if (view.hasTreaty(u.owner, a, 'alliance') || view.pairState(u.owner, b) === 'war') team = 0;
        else if (view.hasTreaty(u.owner, b, 'alliance') || view.pairState(u.owner, a) === 'war') team = 1;
        else continue;
      }
      const cx = u.eastKm * 1000, cz = -u.northKm * 1000;
      const fx = Math.sin(u.heading), fz = -Math.cos(u.heading);
      const rx = -fz, rz = fx;
      const yaw = Math.atan2(fx, fz);
      let sx = 0, sz = 0;
      const n = u.tanks;
      for (let j = 0; j < n + u.ifvs; j++) {
        const tank = j < n;
        const lat = tank ? (j - (n - 1) / 2) * 70 : (j - n - 0.5) * 80;
        const back = tank ? -Math.abs(j - (n - 1) / 2) * 25 : -120;
        const x = cx + rx * lat + fx * back, z = cz + rz * lat + fz * back;
        formationSlots.push({ key: u.unitId * 8 + j, unitId: u.unitId, team, kind: tank ? VehicleKind.Tank : VehicleKind.Apc, x, z, yaw });
        sx += x;
        sz += z;
      }
      shownDivs.push({ unitId: u.unitId, owner: u.owner, tanks: n, ifvs: u.ifvs, realX: cx, realZ: cz, drawnX: sx / (n + u.ifvs), drawnZ: sz / (n + u.ifvs), team });
      battleOwned.add(u.unitId);
    }
    vehicles.setFormation(formationSlots, clock);
    ctx.units.setBattleOwned?.(nearFade > 0.05 ? battleOwned : null);
  }
  /** Real aircraft and warships over the front act on it: strafing and bombs, naval gunfire (visual; the sim counts). */
  let airAcc = 0, navalAcc = 0;
  function supportFire(dt: number): void {
    if (!effects || !lastLF || !anchor) return;
    const lf = lastLF;
    let air = 0, naval = 0;
    for (const u of lf.units) {
      const team = u.owner === anchor.frontA ? 0 : u.owner === anchor.frontB ? 1 : -1;
      if (team < 0) continue;
      if (u.airborne && (u.type === UnitType.FighterSquadron || u.type === UnitType.Bomber || u.type === UnitType.DroneSwarm)
        && (u.mode === UnitMode.Strike || u.mode === UnitMode.Support || u.mode === UnitMode.Patrol || u.mode === UnitMode.Engaged)) air++;
      if (u.type === UnitType.Warship && u.mode === UnitMode.Bombard) naval++;
    }
    airAcc += dt * air * 0.35;
    navalAcc += dt * naval * 0.6;
    while (airAcc >= 1) {
      airAcc -= 1;
      const team = rng.int(2);
      const uu = focusU + rng.gauss() * 900;
      for (let k = 0; k < 3; k++) {
        front.toXZ(uu + k * rng.range(25, 45), (team === 0 ? 1 : -1) * rng.range(120, 700), tmp);
        effects.schedule(clock + k * 0.22, tmp.x, tmp.z, 2);
      }
    }
    while (navalAcc >= 1) {
      navalAcc -= 1;
      const team = rng.int(2);
      front.toXZ(focusU + rng.gauss() * 1200, (team === 0 ? 1 : -1) * rng.range(200, 1400), tmp);
      effects.schedule(clock + rng.range(0.2, 1.2), tmp.x, tmp.z, 3);
    }
  }

  /**
   * Stream a battlefield in over several frames (terrain, props, armies, scars, a few seconds of battle), so the
   * descent never stalls on one long frame. The near layer stays hidden until the job is done.
   */
  function* buildSteps(an: Anchor, dirLocalX: number, dirLocalZ: number): Generator<void, void, void> {
    const world = ctx.world;
    if (!world || !terrainShared || !propsShared || !infantry || !vehicles || !effects) return;
    teardown();
    // Centre the battlefield on the REAL contact line: the sub-tile line (moved into the tile being taken by its
    // pressure progress) can lie up to a tile ahead of the tile edge the front search found.
    if (!forced) {
      const lf0 = deriveLocalForcesAt(ctx.sim.view, an.lat, an.lon, FORCES_RADIUS_KM + 30, HUMAN_ID);
      const f0 = pickLocalFront(lf0, an);
      if (f0) {
        an.lat = f0.nearest.lat;
        an.lon = f0.nearest.lon;
      }
    }
    anchor = an;
    setAnchorFrame(an.lat, an.lon);
    const aux = getWorldAux(world);
    const ty = Math.min(MAP_H - 1, Math.max(0, Math.floor(((90 - an.lat) / 180) * MAP_H)));
    const tx = ((Math.floor(((an.lon + 180) / 360) * MAP_W) % MAP_W) + MAP_W) % MAP_W;
    const tileBiome = aux ? aux.biome[ty * MAP_W + tx] : Biome.Grassland;
    const farmland = tileBiome === Biome.Grassland ? 1 : tileBiome === Biome.Steppe || tileBiome === Biome.Savanna ? 0.55 : tileBiome === Biome.Forest ? 0.7 : 0.2;
    const view0 = ctx.sim.view;
    patch = buildTerrain(world, an.lat, an.lon, terrainShared, farmland, (la, lo) => {
      const o = view0.owner[latLonToTile(la, lo)];
      const p = o ? view0.players[o] : undefined;
      if (!p) return null;
      // Same fill strength as the globe's territory overlay at close range (§10.1), so the rim matches it.
      return { color: p.color, fill: (territoryFillAmount(40) + (o === HUMAN_ID ? 0.05 : 0)) * (p.alive ? 1 : 0.5) };
    });
    near.add(patch.group);
    yield;

    // Front line through the anchor, oriented by the sim's advance direction (a → b). The real contact line at
    // sub-tile precision comes from the shared local forces (§14.11): the same derivation command mode uses.
    const view = ctx.sim.view;
    const lf = deriveLocalForcesAt(view, an.lat, an.lon, FORCES_RADIUS_KM, HUMAN_ID);
    lastLF = lf;
    const lfFront = pickLocalFront(lf, an);
    let nX = dirLocalX, nZ = dirLocalZ;
    if (lfFront) {
      nX = Math.sin(lfFront.advanceBearing);
      nZ = -Math.cos(lfFront.advanceBearing);
    }
    front.setup(nX, nZ, an.seed % 1000, 6000);
    simShift = lfFront ? lineOffsetM(lfFront) : 0;
    simHours = view.tick / TICKS_PER_GAME_HOUR;
    lineFrom = lineTo = simShift;
    lineTick = view.tick;
    lineElapsedMs = 0;
    front.drift = simShift;
    front.rebuild();
    front.apply(uniforms);
    const pa = view.players[an.frontA], pb = view.players[an.frontB];
    const colA = pa?.color ?? 0x3d7eff, colB = separateTeamColors(colA, pb?.color ?? 0xe04040);
    infantry.setColors(colA, colB);
    vehicles.setColors(colA, colB);
    const st = frontStats(an.frontA, an.frontB);
    frontIntensity = lfFront ? lfFront.intensity : st.intensity;
    activity = Math.min(1, 0.45 + frontIntensity * 0.7);
    setPush(lfFront ? lfFront.momentum : 0);
    uniforms.uBelt.value = 45 + 45 * frontIntensity;
    patch.setWarScar(1);
    const conifer = tileBiome === Biome.Taiga || tileBiome === Biome.Tundra || tileBiome === Biome.Snow ? 0.9 : tileBiome === Biome.Rainforest || tileBiome === Biome.Savanna ? 0 : 0.35;
    // Farmland grid: roughly aligned with the front (fields run toward it), a little off-axis.
    const fieldAngle = Math.atan2(front.nz, front.nx) + ((an.seed % 1000) / 1000 - 0.5) * 0.6;
    uniforms.uFieldRot.value.set(Math.cos(fieldAngle), Math.sin(fieldAngle));
    props = buildProps(patch, front, propsShared, {
      treeBudget: Math.round(quality.battleInfantry * 1.1), buildingBudget: Math.round(300 + quality.battleVehicles * 1.2),
      conifer, seed: an.seed, fieldAngle,
    });
    near.add(props.group);
    yield;
    const wind = new FastRng(an.seed + 5);
    const wa = wind.range(0, Math.PI * 2), ws = wind.range(1.5, 4);
    uniforms.uWind.value.set(Math.cos(wa) * ws, Math.sin(wa) * ws);

    // Armies from the real pools (§11.5): soldiers per side = visibleSplit() of the two sides' infantry (front
    // garrison + offensive + rear + posts, 1 soldier = 25 troops) under the quality budget, clamped 0.2–0.8.
    const counts = splitFor(lf, an.frontA, an.frontB);
    splitWanted = counts;
    infantry.deploy(front, counts, an.seed + 11, clock, heightAt, blocked);
    // No generic vehicles: the only armour on the field is the real divisions (placed by updateDivisions()).
    const none: VehicleCounts = {
      tanks: [0, 0], apcs: [0, 0], artillery: [0, 0], aa: [0, 0], helis: [0, 0], trucks: [0, 0], columns: [0, 0], wrecks: 0,
    };
    vehicles.deploy(front, none, props.paths, an.seed + 23, clock);
    divAcc = 1e9;
    updateDivisions(1);
    yield;

    // The scars of the fighting so far: craters, burning villages and wrecks.
    const r = new FastRng(an.seed + 31);
    const nCr = Math.floor(quality.decals * 0.35);
    for (let k = 0; k < nCr; k++) {
      const u = r.gauss() * 0.4 * front.halfLen;
      const v = r.gauss() * uniforms.uBelt.value * 0.8 + (r.chance(0.2) ? r.range(-400, 400) : 0);
      front.toXZ(u, v, tmp);
      if (blocked(tmp.x, tmp.z)) continue;
      effects.seedCrater(tmp.x, tmp.z, r.range(2.5, 7), clock - r.range(30, 600), r.next());
    }
    for (const b of props.buildings) {
      if (b.burning) effects.addFire(b.x, b.y + b.h * 0.6, b.z, Math.max(2.5, Math.min(b.w, b.d) * 0.35), 1.1, 1e12, 1.5, true);
    }
    // Let the battle develop a little before anyone sees it (shells in the air, smoke drifting).
    for (let k = 0; k < 4; k++) {
      yield;
      prewarm(3);
    }
  }

  let job: Generator<void, void, void> | null = null;
  function runJob(): boolean {
    if (!job) return true;
    if (job.next().done) {
      job = null;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Battle logic (per battle-clock step)
  // ---------------------------------------------------------------------------------------------------------
  const cas: [number, number] = [0, 0];
  function battleStep(dt: number): void {
    if (!infantry || !vehicles || !effects || !patch) return;
    const now = clock;
    const act = activity;
    cas[0] = dt * (0.5 + 3.5 * act) * (front.pushA > 0.5 ? 1.1 : 0.8);
    cas[1] = dt * (0.5 + 3.5 * act) * (front.pushB > 0.5 ? 1.1 : 0.9);
    infantry.update(now, front, act, cas);
    vehicles.update(now, dt, front, act, effects);

    // Small-arms fire: muzzle flashes and tracers.
    shotAcc += dt * (18 + 90 * act) * Math.min(1, infantry.count / 2000 + 0.25);
    let guard = 0;
    while (shotAcc >= 1 && guard++ < 60) {
      shotAcc -= 1;
      const team = rng.chance(0.5) ? 0 : 1;
      if (!infantry.pickShooter(team, rng, now, tmp, focusU)) continue;
      const fx = team === 0 ? front.nx : -front.nx, fz = team === 0 ? front.nz : -front.nz;
      const gy = heightAt(tmp.x, tmp.z);
      const d = Math.hypot(tmp.x - camL.x, gy - camL.y, tmp.z - camL.z);
      const us = uniforms.uUnitScale.value;
      const ex = Math.max(1, Math.min(us.y, d / us.x));
      const mx = tmp.x + fx * 0.9 * ex, mz = tmp.z + fz * 0.9 * ex, my = gy + tmp.y * ex;
      const t0 = now + rng.range(0, dt);
      if (team === 0) effects.muzzle(mx, my, mz, fx, fz, 0.7 * ex, 1, 0.62, 0.3, t0);
      else effects.muzzle(mx, my, mz, fx, fz, 0.7 * ex, 1, 0.8, 0.45, t0);
      if (rng.chance(0.22) && infantry.pickTarget(1 - team, rng, tmp2, focusU)) {
        const ty = heightAt(tmp2.x, tmp2.z) + rng.range(0.3, 2.5);
        if (team === 0) effects.tracer(mx, my, mz, tmp2.x + rng.range(-6, 6), ty, tmp2.z + rng.range(-6, 6), 880, 1, 0.35, 0.12, 0.09, t0);
        else effects.tracer(mx, my, mz, tmp2.x + rng.range(-6, 6), ty, tmp2.z + rng.range(-6, 6), 880, 0.45, 1, 0.3, 0.09, t0);
      }
    }
    // Mortars / grenades on the firing lines.
    mortarAcc += dt * (0.35 + 2.2 * act);
    while (mortarAcc >= 1) {
      mortarAcc -= 1;
      const team = rng.int(2);
      if (!infantry.pickTarget(team, rng, tmp, focusU)) continue;
      effects.explosion(tmp.x + rng.range(-25, 25), tmp.z + rng.range(-25, 25), rng.chance(0.75) ? 0 : 1, now + rng.range(0, dt));
    }
    // Heavy off-map artillery: shells come in on steep arcs from far behind each line.
    heavyAcc += dt * (0.12 + 0.55 * act);
    while (heavyAcc >= 1) {
      heavyAcc -= 1;
      const team = rng.int(2); // side being shelled
      const u = rng.chance(0.6) ? focusU + rng.gauss() * 450 : rng.gauss() * 0.35 * front.halfLen;
      const v = rng.range(-20, 350) * (team === 0 ? -1 : 1);
      front.toXZ(u, v, tmp);
      if (isWater(tmp.x, tmp.z) && rng.chance(0.7)) continue;
      // Only the last stretch of the arc is drawn: a faint glowing shell dropping in from far behind the enemy.
      const ty = heightAt(tmp.x, tmp.z);
      const flight = rng.range(1.2, 1.8);
      const g = -9.81 * 6;
      const back = rng.range(1400, 2200);
      const lat = rng.range(-300, 300);
      front.toXZ(u + lat, (team === 0 ? 1 : -1) * back + v, tmp2);
      const sy = ty + rng.range(350, 500);
      const vx = (tmp.x - tmp2.x) / flight, vz = (tmp.z - tmp2.z) / flight;
      const vy = (ty - sy - 0.5 * g * flight * flight) / flight;
      effects.add.emit(tmp2.x, sy, tmp2.z, vx, vy, vz, flight, 0.1, 0.025, 0, g, 1, 0.55, 0.25, 0.6, PK.Streak, 0, 0, now);
      effects.schedule(now + flight, tmp.x, tmp.z, rng.chance(0.15) ? 3 : 2);
    }
    // Drifting battle haze along no-man's-land.
    hazeAcc += dt * (1.2 + 2.4 * act);
    while (hazeAcc >= 1) {
      hazeAcc -= 1;
      front.toXZ(rng.chance(0.5) ? focusU + rng.gauss() * 700 : rng.gauss() * 0.4 * front.halfLen, rng.gauss() * 220, tmp);
      if (Math.hypot(tmp.x, tmp.z) > 7000) continue;
      effects.haze(tmp.x, tmp.z, rng.range(60, 140), now);
    }
    effects.update(now, dt, uniforms, camL.x, camL.y, camL.z);
  }

  function prewarm(seconds: number): void {
    if (!effects) return;
    const step = 1 / 15;
    const n = Math.ceil(seconds / step);
    const nearOn = !!patch;
    for (let i = 0; i < n; i++) {
      clock += step;
      if (nearOn) battleStep(step);
      updateFar(step);
    }
    uniforms.uTime.value = clock;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------------------------------------
  function updateLighting(altKm: number): void {
    ctx.globe.getSunDirection(sunW);
    updateAir(uniforms, aUp, aEast, aNorth, sunW, ctx.camera.position, altKm, air);
    if (propsShared) propsShared.houseMat.uniforms.uNight.value = smoothstep(0.12, -0.06, air.muS);
    if (effects) effects.sunView.copy(sunW).transformDirection(ctx.camera.matrixWorldInverse);
    // Battle smoke thickens the air a little around the fighting.
    uniforms.uSmoke.value.set(front.cx, front.cz, 5500, 0.00002 + 0.00005 * activity);
    // Units grow on screen from altitude so the armies stay readable.
    uniforms.uUnitScale.value.set(170, 3 + 3 * smoothstep(2, 14, altKm), 900, 3200);
  }

  const focusW = new THREE.Vector3();
  const focusL = new THREE.Vector3();
  const sunL = new THREE.Vector3();
  function renderShadows(): void {
    if (!shadow || quality.shadows <= 0 || !patch) {
      uniforms.uShadowInfo.value.x = 0;
      return;
    }
    // Focus: the view target on the ground (local), extent grows with the viewing distance.
    const r = ctx.globe.surfaceRadiusAt(camState.lat, camState.lon);
    latLonToVec3(camState.lat, camState.lon, r, focusW);
    focusL.copy(focusW).applyMatrix4(invNear);
    focusL.y = heightAt(focusL.x, focusL.z);
    const d = focusL.distanceTo(camL);
    const extent = Math.min(4200, Math.max(700, d * 2.6));
    sunL.copy(uniforms.uSunDir.value);
    shadow.render(ctx.renderer, ctx.scene, near, focusL, sunL, extent);
  }

  function updateFar(dt: number): void {
    if (!far) return;
    const alt = camState.altitudeKm;
    // §11.1: the far layer covers 150-600 km fully (fading out by 900 km, where the orbit overlay alone reads).
    const fade = (1 - smoothstep(Math.max(650, BATTLE_LAYER_ALT_KM), 900, alt)) * smoothstep(6, 16, alt);
    far.uniforms.uTime.value = clock;
    ll.lat = camState.lat;
    ll.lon = camState.lon;
    let avoid: LatLon | null = null;
    if (anchor && nearFade > 0.05) {
      avoidLL.lat = anchor.lat;
      avoidLL.lon = anchor.lon;
      avoid = avoidLL;
    }
    far.update(clock, dt, ctx.sim.view.fronts, ll, alt, fade, avoid, surfaceAt);
    farIntensity = far.activity * fade * 0.6;
    if (fade > 0.001) {
      ctx.globe.getSunDirection(sunW);
      updateAir(far.uniforms, far.up, far.east, far.north, sunW, ctx.camera.position, alt, air);
      far.sunView.copy(sunW).transformDirection(ctx.camera.matrixWorldInverse);
      far.group.updateMatrixWorld();
      farInv.copy(far.group.matrixWorld).invert();
      far.uniforms.uCamL.value.copy(ctx.camera.position).applyMatrix4(farInv);
      far.uniforms.uSmoke.value.set(0, 0, 1, 0);
    }
  }

  function deactivate(): void {
    if (battleOwned.size) {
      battleOwned.clear();
      ctx.units.setBattleOwned?.(null);
    }
    active = false;
    nearFade = 0;
    near.visible = false;
    intensity = 0;
  }

  function shownState(): BattleShown | null {
    if (!anchor || job) return null;
    const view = ctx.sim.view;
    return {
      frontKey: anchor.frontKey, a: anchor.frontA, b: anchor.frontB,
      infantry: [infantry?.deployed(0) ?? 0, infantry?.deployed(1) ?? 0], split: [splitWanted[0], splitWanted[1]],
      divisions: shownDivs.map((d) => ({ ...d })),
      lineShift: front.drift, simShift, lineSpeed, expectedSpeed: simSub ? (simDir * simKmh * view.clock.rate) / 3.6 : 0,
      advanceKmh: simKmh, subTile: simSub, clockMode: view.clock.mode, samples: [samplesTaken, samplesFound],
    };
  }

  const debug: BattleDebug = {
    stageAt(lat, lon, a, b, dirX, dirY, frontKey = 0) {
      forced = { lat, lon, a, b, dirX, dirY, key: frontKey };
    },
    shown() {
      return shownState();
    },
    farStats() {
      return far ? far.stats() : null;
    },
    setLayerVisible(on) {
      root.visible = on;
    },
    get clock() {
      return clock;
    },
    prewarm(seconds) {
      prewarm(seconds);
    },
    get anchor() {
      return anchor ? { lat: anchor.lat, lon: anchor.lon } : null;
    },
    get built() {
      return !!anchor && !job;
    },
    shadowCoverage() {
      return shadow ? shadow.coverage(ctx.renderer) : -1;
    },
    get frontDir() {
      return { tx: front.tx, tz: front.tz, nx: front.nx, nz: front.nz };
    },
  };
  currentDebug = debug;
  try {
    (window as unknown as { __battleDebug?: BattleDebug }).__battleDebug = debug;
  } catch {
    /* no window */
  }

  const bannerL = new THREE.Vector3();
  const battleView: BattleView = { frontKey: 0, a: 0, b: 0, fade: 0, banners: [{ owner: 0, x: 0, y: 0, z: 0 }, { owner: 0, x: 0, y: 0, z: 0 }], lineLive: false };
  const api: BattleApi = {
    get active() {
      return active;
    },
    handoff() {
      if (!anchor || job || !active) return null;
      return {
        lat: anchor.lat, lon: anchor.lon,
        infantry: [{ owner: anchor.frontA, count: infantry?.deployed(0) ?? 0 }, { owner: anchor.frontB, count: infantry?.deployed(1) ?? 0 }],
        divisions: shownDivs.map((d) => ({ unitId: d.unitId, tanks: d.tanks, ifvs: d.ifvs })),
      };
    },
    view() {
      if (!anchor || job || !active) return null;
      battleView.frontKey = anchor.frontKey;
      battleView.a = anchor.frontA;
      battleView.b = anchor.frontB;
      battleView.fade = nearFade;
      battleView.lineLive = simSub && simDir !== 0;
      // Each side's banner stands 1.1 km behind its own line where the camera looks, 180 m above the ground.
      for (let t = 0; t < 2; t++) {
        front.toXZ(focusU, t === 0 ? -1100 : 1100, bannerL);
        bannerL.y = heightAt(bannerL.x, bannerL.z) + 180;
        bannerL.applyMatrix4(near.matrixWorld);
        const bn = battleView.banners[t];
        bn.owner = t === 0 ? anchor.frontA : anchor.frontB;
        bn.x = bannerL.x;
        bn.y = bannerL.y;
        bn.z = bannerL.z;
      }
      return battleView;
    },
    get intensity() {
      return intensity;
    },
    async init(progress) {
      makeModules();
      progress(1);
      ready = true;
    },
    warmup(on) {
      if (!ready) return;
      warmGroup.visible = on;
      near.visible = on || nearFade > 0.002;
      const ig = infantry?.mesh.geometry as THREE.InstancedBufferGeometry | undefined;
      if (ig && infantry) ig.instanceCount = on ? Math.max(1, infantry.count) : infantry.count;
      vehicles?.warmup(on);
      if (far) far.group.visible = on;
    },
    onGameStart() {
      overlay.clear();
      job = null;
      teardown();
      far?.clear();
      deactivate();
    },
    onGameEnd() {
      overlay.clear();
      job = null;
      teardown();
      far?.clear();
      deactivate();
      forced = null;
    },
    setQuality(q) {
      const prev = quality;
      quality = q;
      if (!ready) return;
      if (q.battleInfantry !== prev.battleInfantry) infantry?.setCapacity(q.battleInfantry);
      if (q.battleVehicles !== prev.battleVehicles) vehicles?.setCapacity(Math.ceil(q.battleVehicles * 0.45));
      if (q.shadows !== prev.shadows) shadow?.setSize(shadowSize(q));
      if (q.particles !== prev.particles || q.decals !== prev.decals) {
        effects?.setBudgets(q.particles, q.decals);
        far?.setBudget(Math.floor(q.particles * 0.35));
      }
      // Rebuild with the new budgets.
      if (anchor) {
        const a = anchor;
        teardown();
        pendingAnchor = a;
      }
    },
    update(frame: FrameInfo) {
      if (!ready) return;
      const view = ctx.sim.view;
      ctx.cameraRig.getState(camState);
      overlay.update(frame.visualDt, camState.altitudeKm, ctx.app.state !== 'command' && view.phase !== 'none');
      if (view.phase === 'none' || !ctx.world) {
        if (active || anchor) {
          teardown();
          deactivate();
        }
        if (far) far.group.visible = false;
        return;
      }
      // Battle animation runs on real time (§11.6): the same at every speed, frozen on pause. The line and the real
      // units move with the sim clock instead (followLine, updateDivisions).
      // Wall time (frame.dt is clamped to 0.1 s): at any frame rate the battle runs at real speed; paused, it freezes.
      const wall = lastWallMs > 0 ? Math.min(10, Math.max(0, (frame.now - lastWallMs) / 1000)) : 0;
      lastWallMs = frame.now;
      const wallLive = frame.visualDt > 0 ? wall : 0;
      const bdt = Math.min(wallLive, 0.25);
      clock += wallLive;
      uniforms.uTime.value = clock;
      ctx.cameraRig.getState(camState);
      const alt = camState.altitudeKm;
      updateFar(bdt);

      // ---- choose / stream the local battlefield (anchored by the front's stable key) ----
      let want: Anchor | null = null;
      let dirX = 0, dirZ = 1;
      let same = false;
      if (job && anchor && !forced) {
        // A battlefield is streaming in: let it finish before judging whether it is still the right one.
        want = anchor;
        same = true;
      } else if (forced) {
        want = {
          lat: forced.lat, lon: forced.lon, frontA: forced.a, frontB: forced.b, seed: hashString(`${forced.lat.toFixed(3)},${forced.lon.toFixed(3)}`),
          frontKey: forced.key, camLat: forced.lat, camLon: forced.lon,
        };
        const cl = Math.cos((forced.lat * Math.PI) / 180);
        dirX = forced.dirX * cl;
        dirZ = forced.dirY;
        same = !!anchor && anchor.frontA === want.frontA && anchor.frontB === want.frontB &&
          Math.hypot((want.lat - anchor.lat) * M_PER_DEG, (want.lon - anchor.lon) * M_PER_DEG * Math.cos((want.lat * Math.PI) / 180)) < REANCHOR_KM * 1000;
      } else if (alt < NEAR_BUILD_ALT) {
        // Keep the battle while the camera stays over it and its front still exists: the line may move under it
        // (observation time) without the battle re-anchoring, until it has left the patch.
        if (anchor && anchor.frontKey && view.frontByKey.has(anchor.frontKey)
          && gcKm(camState.lat, camState.lon, anchor.camLat, anchor.camLon) < REANCHOR_KM && Math.abs(front.drift) < LINE_LEAVE_M) {
          want = anchor;
          same = true;
        } else {
          const h = nearestFront(camState.lat, camState.lon, view.fronts);
          if (h && h.f && h.dist < 30 + alt * 1.2) {
            tileXYToLatLon(h.px, h.py, ll);
            const cl = Math.cos((ll.lat * Math.PI) / 180);
            dirX = h.f.dirX * cl;
            dirZ = h.f.dirY;
            want = {
              lat: ll.lat, lon: ll.lon, frontA: h.f.a, frontB: h.f.b, seed: hashString(`${(ll.lat * 20) | 0},${(ll.lon * 20) | 0},${h.f.a},${h.f.b}`),
              frontKey: h.f.key, camLat: camState.lat, camLon: camState.lon,
            };
            same = !!anchor && anchor.frontKey === want.frontKey
              && gcKm(camState.lat, camState.lon, anchor.camLat, anchor.camLon) < REANCHOR_KM && Math.abs(front.drift) < LINE_LEAVE_M;
            if (same) want = anchor;
          }
        }
      }
      if (want) {
        if (!same) {
          pendingAnchor = want;
          pendingDir.x = dirX;
          pendingDir.z = dirZ;
        } else {
          pendingAnchor = null;
        }
      }
      const visTarget = want ? 1 - smoothstep(NEAR_FADE_FULL, NEAR_FADE_START, alt) : 0;
      if (pendingAnchor) {
        // Fade out the old battle (if any) before streaming the new one in.
        nearFade = Math.max(0, nearFade - frame.dt * 3);
        if (nearFade <= 0.001 || !anchor) {
          job = buildSteps(pendingAnchor, pendingDir.x, pendingDir.z);
          pendingAnchor = null;
          nearFade = 0;
        }
      }
      if (job) {
        near.visible = false;
        active = false;
        if (!runJob()) return;
      } else if (anchor) {
        const rate = frame.dt * (visTarget > nearFade ? 1.6 : 3);
        nearFade += Math.max(-rate, Math.min(rate, visTarget - nearFade));
      }
      if (ctx.app.isShot && anchor && visTarget >= 0.999 && !pendingAnchor) nearFade = 1;
      if (!anchor) {
        deactivate();
        intensity = farIntensity;
        return;
      }
      near.visible = nearFade > 0.002;
      active = near.visible;
      uniforms.uFade.value = smoothstep(0, 1, nearFade);
      if (!near.visible) {
        intensity = 0;
        return;
      }
      near.updateMatrixWorld();
      invNear.copy(near.matrixWorld).invert();
      camL.copy(ctx.camera.position).applyMatrix4(invNear);
      // A camera this low sees its horizon well inside the patch: the rim (past the horizon) stays solid.
      // (The coarsest globe mesh sags well below the true sphere between its vertices: there the rim stays solid so no
      // sky shows through its dissolve at grazing angles.)
      uniforms.uRimK.value = quality.globeDetail <= 0 ? 0 : smoothstep(250, 900, camL.y - heightAt(camL.x, camL.z));
      latLonToVec3(camState.lat, camState.lon, 1, focusW);
      focusL.copy(focusW).applyMatrix4(invNear);
      front.coords(focusL.x, focusL.z, focusUV);
      focusU = Math.max(-front.halfLen * 0.8, Math.min(front.halfLen * 0.8, focusUV.x));
      updateLighting(alt);
      props?.updateLod(camL.x, camL.z);
      renderShadows();
      // The fight follows the sim: the sub-tile line, who is winning, the real divisions (§11.5). These run on wall
      // time (not the per-frame dt, which is clamped to 0.1 s): the line keeps its real speed however low the frame
      // rate is, and stops on pause.
      sampleAcc += wall;
      if (sampleAcc >= 0.25) {
        sampleAcc = 0;
        sampleLine();
      }
      divAcc += wall;
      if (divAcc >= 0.5) {
        divAcc = 0;
        updateDivisions(frame.simAlpha);
      }
      followLine(wallLive);
      if (bdt > 0) {
        supportFire(bdt);
        battleStep(bdt);
      } else if (effects) {
        effects.update(clock, 0, uniforms, camL.x, camL.y, camL.z);
      }
      intensity = Math.min(1, uniforms.uFade.value * (0.35 + 0.65 * (effects?.violence ?? 0)) * (0.6 + 0.4 * activity));
      intensity = Math.max(intensity, farIntensity);
    },
  };
  return api;
}
