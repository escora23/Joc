// FRONT ULTRA — ground war near active fronts (owner: battle).
//
// When the camera descends toward an active front, a local battlefield streams in, anchored on the contact line
// under the view: real-relief terrain with a splatted war-torn ground (./terrain), roads, villages, forests
// (./props), thousands of GPU-animated soldiers fighting by fire-and-maneuver (./infantry), tank platoons,
// APCs, howitzer batteries, SPAAGs, attack helicopters, armored columns and trucks (./vehicles), and the whole
// catalogue of combat effects (./effects, ./particles): muzzle flashes, tracers, shells on ballistic arcs,
// explosions, craters, burning villages and wrecks with smoke columns, drifting battle haze and local lights.
// Density follows the sim's FrontView (troops on each side, intensity) and the quality preset.
// Above ~20 km the individual war is invisible, so ./far paints artillery flashes, fires and smoke columns
// along every front in view up to BATTLE_LAYER_ALT_KM.
//
// Seamless with the globe: sun color, sky ambient and aerial perspective come from the same scattering model as
// the globe (./atmo), the patch sits on the globe's own exaggerated relief and its rim melts into the globe's
// albedo, and a monotonic depth pull keeps the battlefield in front of the coarser globe surface (no z-fighting).
// The layer crossfades with altitude (screen-door dissolve) and never pops.

import * as THREE from 'three';
import type { BattleApi, CameraState, FrameInfo, GameContext } from '../../shared/api';
import { BATTLE_LAYER_ALT_KM, HUMAN_ID, MAP_H, MAP_W, TILE_KM } from '../../shared/constants';
import { latLonToTile, latLonToVec3, tangentFrame, tileXYToLatLon, wrapDX } from '../../shared/geo';
import { smoothstep } from '../../shared/math';
import type { QualityProfile } from '../../shared/quality';
import { hashString } from '../../shared/rng';
import { UnitType, type FrontView, type LatLon } from '../../shared/types';
import { Biome, getWorldAux } from '../../data';
import { updateAir, type AirState } from './atmo';
import { FastRng, M_PER_DEG, R_M, createBattleUniforms, depthVariant } from './common';
import { createEffects, type Effects } from './effects';
import { createFarLayer, gcKm, type FarLayer } from './far';
import { FrontGeom } from './front';
import { createInfantry, type Infantry } from './infantry';
import { VehicleKind } from './models';
import { PK } from './particles';
import { buildProps, createPropsShared, type PropsResult, type PropsShared } from './props';
import { buildTerrain, createTerrainShared, type TerrainPatch, type TerrainShared } from './terrain';
import { createShadowPass, shadowStats, type ShadowPass } from './shadow';
import { makeDetailTexture, makePuffTexture } from './textures';
import { createVehicles, type Vehicles, type VehicleCounts } from './vehicles';

/** Altitude (km) below which the local battlefield is built / starts fading in / is fully visible. */
const NEAR_BUILD_ALT = 70;
const NEAR_FADE_START = 42;
const NEAR_FADE_FULL = 24;
/** Re-anchor when the view slides this far along the front (km). */
const REANCHOR_KM = 3.2;

interface Anchor {
  lat: number;
  lon: number;
  frontA: number;
  frontB: number;
  seed: number;
}

export interface BattleDebug {
  /** Force the battle at a place (shots): anchors the near layer there for the given front pair and direction. */
  stageAt(lat: number, lon: number, a: number, b: number, dirX: number, dirY: number): void;
  /** Run the battle logic for `seconds` of battle time right now (shells in the air, smoke drifting...). */
  prewarm(seconds: number): void;
  readonly anchor: LatLon | null;
  /** Local front frame (for camera staging): tangent/normal in the anchor's east/south plane. */
  readonly frontDir: { tx: number; tz: number; nx: number; nz: number };
  shadowCoverage(): number;
  /** True once the battlefield is fully streamed in. */
  readonly built: boolean;
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
  let forced: { lat: number; lon: number; a: number; b: number; dirX: number; dirY: number } | null = null;
  let nearFade = 0;
  let clock = 1000;
  let active = false;
  let intensity = 0;
  let farIntensity = 0;
  let frontIntensity = 0.5;
  let activity = 0.5;
  const air: AirState = { muS: 1, sun: new THREE.Vector3() };

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

  /**
   * Stream a battlefield in over several frames (terrain, props, armies, scars, a few seconds of battle), so the
   * descent never stalls on one long frame. The near layer stays hidden until the job is done.
   */
  function* buildSteps(an: Anchor, dirLocalX: number, dirLocalZ: number): Generator<void, void, void> {
    const world = ctx.world;
    if (!world || !terrainShared || !propsShared || !infantry || !vehicles || !effects) return;
    teardown();
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
      // Same fill strength as the globe's territory overlay (so the rim matches it).
      return { color: p.color, fill: (0.26 + (o === HUMAN_ID ? 0.05 : 0)) * (p.alive ? 1 : 0.5) };
    });
    near.add(patch.group);
    yield;

    // Front line through the anchor, oriented by the sim's advance direction.
    front.setup(dirLocalX, dirLocalZ, an.seed % 1000, 6000);
    front.apply(uniforms);
    const view = ctx.sim.view;
    const pa = view.players[an.frontA], pb = view.players[an.frontB];
    const colA = pa?.color ?? 0x3d7eff, colB = pb?.color ?? 0xe04040;
    infantry.setColors(colA, colB);
    vehicles.setColors(colA, colB);
    const st = frontStats(an.frontA, an.frontB);
    frontIntensity = st.intensity;
    activity = Math.min(1, 0.45 + st.intensity * 0.7);
    // Who pushes, and how big each side's presence is (troops on the front).
    const share = Math.min(0.7, Math.max(0.3, st.tA / Math.max(1, st.tA + st.tB)));
    front.pushA = share >= 0.45 ? 1 : 0.3;
    front.pushB = share < 0.45 ? 0.8 : -0.1;
    uniforms.uBelt.value = 45 + 45 * st.intensity;
    patch.setWarScar(1);
    const conifer = tileBiome === Biome.Taiga || tileBiome === Biome.Tundra || tileBiome === Biome.Snow ? 0.9 : tileBiome === Biome.Rainforest || tileBiome === Biome.Savanna ? 0 : 0.35;
    props = buildProps(patch, front, propsShared, {
      treeBudget: Math.round(quality.battleInfantry * 0.55), buildingBudget: Math.round(300 + quality.battleVehicles * 1.2),
      conifer, seed: an.seed,
    });
    near.add(props.group);
    yield;
    const wind = new FastRng(an.seed + 5);
    const wa = wind.range(0, Math.PI * 2), ws = wind.range(1.5, 4);
    uniforms.uWind.value.set(Math.cos(wa) * ws, Math.sin(wa) * ws);

    // Armies.
    const nInf = Math.round(quality.battleInfantry * (0.55 + 0.45 * activity));
    const iA = Math.round(nInf * share), iB = nInf - iA;
    infantry.deploy(front, [iA, iB], an.seed + 11, clock, heightAt, blocked);
    const V = quality.battleVehicles * (0.6 + 0.4 * activity);
    const side = (k: number, t: number) => Math.max(1, Math.round(V * k * (t === 0 ? share : 1 - share)));
    const counts: VehicleCounts = {
      tanks: [side(0.09, 0), side(0.09, 1)],
      apcs: [side(0.05, 0), side(0.05, 1)],
      artillery: [Math.max(4, side(0.03, 0)), Math.max(4, side(0.03, 1))],
      aa: [side(0.012, 0), side(0.012, 1)],
      helis: [side(0.012, 0), side(0.012, 1)],
      trucks: [side(0.02, 0), side(0.02, 1)],
      columns: [(st.armorA ? 2 : 0) + (share > 0.5 ? 1 : 0), (st.armorB ? 2 : 0) + (share <= 0.5 ? 1 : 0)],
      wrecks: Math.round(V * 0.05),
    };
    vehicles.deploy(front, counts, props.paths, an.seed + 23, clock);
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
    for (const v of vehicles.list) {
      if (v.burnt && r.chance(0.7)) effects.addFire(v.x, v.y + 1.4, v.z, 2, 1, 1e12, 1.6, true);
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
      if (!infantry.pickShooter(team, rng, now, tmp)) continue;
      const fx = team === 0 ? front.nx : -front.nx, fz = team === 0 ? front.nz : -front.nz;
      const gy = heightAt(tmp.x, tmp.z);
      const d = Math.hypot(tmp.x - camL.x, gy - camL.y, tmp.z - camL.z);
      const us = uniforms.uUnitScale.value;
      const ex = Math.max(1, Math.min(us.y, d / us.x));
      const mx = tmp.x + fx * 0.9 * ex, mz = tmp.z + fz * 0.9 * ex, my = gy + tmp.y * ex;
      const t0 = now + rng.range(0, dt);
      if (team === 0) effects.muzzle(mx, my, mz, fx, fz, 0.7 * ex, 1, 0.62, 0.3, t0);
      else effects.muzzle(mx, my, mz, fx, fz, 0.7 * ex, 1, 0.8, 0.45, t0);
      if (rng.chance(0.22) && infantry.pickTarget(1 - team, rng, tmp2)) {
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
      if (!infantry.pickTarget(team, rng, tmp)) continue;
      effects.explosion(tmp.x + rng.range(-25, 25), tmp.z + rng.range(-25, 25), rng.chance(0.75) ? 0 : 1, now + rng.range(0, dt));
    }
    // Heavy off-map artillery: shells come in on steep arcs from far behind each line.
    heavyAcc += dt * (0.12 + 0.55 * act);
    while (heavyAcc >= 1) {
      heavyAcc -= 1;
      const team = rng.int(2); // side being shelled
      const u = rng.gauss() * 0.35 * front.halfLen;
      const v = rng.range(-20, 350) * (team === 0 ? -1 : 1);
      front.toXZ(u, v, tmp);
      if (isWater(tmp.x, tmp.z) && rng.chance(0.7)) continue;
      front.toXZ(u + rng.range(-800, 800), (team === 0 ? 1 : -1) * 7000, tmp2);
      const ty = heightAt(tmp.x, tmp.z);
      const flight = rng.range(2.5, 3.5);
      const g = -9.81 * 6;
      const sy = ty + 600;
      const vx = (tmp.x - tmp2.x) / flight, vz = (tmp.z - tmp2.z) / flight;
      const vy = (ty - sy - 0.5 * g * flight * flight) / flight;
      effects.add.emit(tmp2.x, sy, tmp2.z, vx, vy, vz, flight, 0.12, 0.03, 0, g, 1, 0.6, 0.3, 1.2, PK.Streak, 0, 0, now);
      effects.schedule(now + flight, tmp.x, tmp.z, rng.chance(0.15) ? 3 : 2);
    }
    // Drifting battle haze along no-man's-land.
    hazeAcc += dt * (1.2 + 2.4 * act);
    while (hazeAcc >= 1) {
      hazeAcc -= 1;
      front.toXZ(rng.gauss() * 0.4 * front.halfLen, rng.gauss() * 220, tmp);
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
    uniforms.uUnitScale.value.set(170, 3 + 3 * smoothstep(2, 14, altKm), 700, 3000);
  }

  let shadowLog = 0;
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
    if (ctx.app.isShot && (shadowLog++ % 60) === 0) {
      const si = uniforms.uShadowInfo.value;
      const pc = focusL.clone().applyMatrix4(uniforms.uShadowMat.value);
      const cam = shadow.camera;
      console.info(`[battle] shadow focus clip=${pc.x.toFixed(3)},${pc.y.toFixed(3)},${pc.z.toFixed(3)} camPos=${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)} parent=${cam.parent?.name} proj00=${cam.projectionMatrix.elements[0].toExponential(2)} proj10=${cam.projectionMatrix.elements[10].toExponential(2)} proj14=${cam.projectionMatrix.elements[14].toExponential(2)}`);
      console.info(`[battle] shadow on=${si.x} texel=${si.y.toFixed(5)} bias=${si.z.toExponential(2)} extent=${extent.toFixed(0)} sun=${sunL.x.toFixed(2)},${sunL.y.toFixed(2)},${sunL.z.toFixed(2)} focus=${focusL.x.toFixed(0)},${focusL.y.toFixed(0)},${focusL.z.toFixed(0)} ${shadowStats()}`);
    }
  }

  function updateFar(dt: number): void {
    if (!far) return;
    const alt = camState.altitudeKm;
    const fade = (1 - smoothstep(BATTLE_LAYER_ALT_KM * 0.65, BATTLE_LAYER_ALT_KM, alt)) * smoothstep(6, 16, alt);
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
    active = false;
    nearFade = 0;
    near.visible = false;
    intensity = 0;
  }

  const debug: BattleDebug = {
    stageAt(lat, lon, a, b, dirX, dirY) {
      forced = { lat, lon, a, b, dirX, dirY };
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

  const api: BattleApi = {
    get active() {
      return active;
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
      job = null;
      teardown();
      far?.clear();
      deactivate();
    },
    onGameEnd() {
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
      if (view.phase === 'none' || !ctx.world) {
        if (active || anchor) {
          teardown();
          deactivate();
        }
        if (far) far.group.visible = false;
        return;
      }
      const bdt = Math.min(frame.simDt, 0.1);
      clock += bdt;
      uniforms.uTime.value = clock;
      ctx.cameraRig.getState(camState);
      const alt = camState.altitudeKm;
      updateFar(bdt);

      // ---- choose / stream the local battlefield ----
      let want: Anchor | null = null;
      let dirX = 0, dirZ = 1;
      if (forced) {
        want = { lat: forced.lat, lon: forced.lon, frontA: forced.a, frontB: forced.b, seed: hashString(`${forced.lat.toFixed(3)},${forced.lon.toFixed(3)}`) };
        const cl = Math.cos((forced.lat * Math.PI) / 180);
        dirX = forced.dirX * cl;
        dirZ = forced.dirY;
      } else if (alt < NEAR_BUILD_ALT) {
        const h = nearestFront(camState.lat, camState.lon, view.fronts);
        if (h && h.f && h.dist < 30 + alt * 1.2) {
          tileXYToLatLon(h.px, h.py, ll);
          const cl = Math.cos((ll.lat * Math.PI) / 180);
          dirX = h.f.dirX * cl;
          dirZ = h.f.dirY;
          want = { lat: ll.lat, lon: ll.lon, frontA: h.f.a, frontB: h.f.b, seed: hashString(`${(ll.lat * 20) | 0},${(ll.lon * 20) | 0},${h.f.a},${h.f.b}`) };
        }
      }
      if (want) {
        const same = !!anchor && anchor.frontA === want.frontA && anchor.frontB === want.frontB &&
          Math.hypot((want.lat - anchor.lat) * M_PER_DEG, (want.lon - anchor.lon) * M_PER_DEG * Math.cos((want.lat * Math.PI) / 180)) < REANCHOR_KM * 1000;
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
      if (ctx.app.isShot && anchor && visTarget >= 0.999) nearFade = 1;
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
      updateLighting(alt);
      renderShadows();
      // The fight follows the sim: intensity and who is winning.
      if (frame.frame % 30 === 0) {
        const st = frontStats(anchor.frontA, anchor.frontB);
        frontIntensity += (st.intensity - frontIntensity) * 0.3;
        activity = Math.min(1, 0.45 + frontIntensity * 0.7);
        const share = st.tA / Math.max(1, st.tA + st.tB);
        front.pushA = share >= 0.45 ? 1 : 0.3;
        front.pushB = share < 0.45 ? 0.8 : -0.1;
      }
      if (bdt > 0) {
        // The line creeps toward whoever is losing.
        const creep = (front.pushA - Math.max(0, front.pushB)) * 0.25 * activity * bdt;
        if (Math.abs(front.drift + creep) < 400) {
          front.drift += creep;
          front.rebuild();
          front.apply(uniforms);
        }
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
