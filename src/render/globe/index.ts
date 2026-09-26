// FRONT ULTRA — the living planet (owner: globe).
// Orchestrates the photoreal Earth (relief-displaced sphere + camera-following near patch), atmosphere,
// clouds, space backdrop with sun, the territory overlay data and the nation labels. Exposes picking with
// relief, the rendered ground radius, the sun direction and hover highlight (GlobeApi).

import * as THREE from 'three';
import type { CameraState, FrameInfo, GameContext, GlobeApi } from '../../shared/api';
import { EARTH_RADIUS_KM, RELIEF_EXAGGERATION, TOPO_MAX_METERS } from '../../shared/constants';
import { latLonToTile, sunDirection, surfaceRadius, vec3ToLatLon } from '../../shared/geo';
import type { QualityProfile } from '../../shared/quality';
import type { LatLon } from '../../shared/types';
import { clamp, damp, lerp, smoothstep } from '../../shared/math';
import { presentationTime, shotView } from '../../shared/shots';
import type { CloudMode } from '../../shared/settings';
import { sampleElevation } from '../../data';
import { createEarth, createPlanetUniforms, earthDefines, PATCH_RES, PATCH_WARP, type Earth } from './earth';
import { buildSdfFont, type SdfFont } from './font';
import { createIslandMarkers, type IslandMarkers } from './islands';
import { createNationLabels, type NationLabels } from './labels';
import { createAtmosphereLayers, type AtmosphereLayers } from './layers';
import { territoryFillAmount } from './glsl';
import { createSpaceBackdrop } from './sky';
import { createTerritoryLayer } from './territory';
import { createTileMarks, type TileMarks } from './marks';
import { applyTextureSize, loadPlanetTextures, type PlanetTextures } from './textures';

/** Cloud drift: one revolution per this many world seconds. */
const CLOUD_PERIOD_SEC = 5400;
/** Shots only: freeze the sun at a world time regardless of the app clock (null = follow frame.worldTime). */
let worldTimeOverride: number | null = null;
export function setGlobeWorldTimeOverride(t: number | null): void {
  worldTimeOverride = t;
}

const RELIEF_TOP = 1 + (TOPO_MAX_METERS * RELIEF_EXAGGERATION) / (EARTH_RADIUS_KM * 1000);
/** Camera layer holding only the ground (the &mask=owner measurement renders just that). */
export const MASK_LAYER = 30;
/** Camera layer of the cloud deck in the &mask=cloud measurement. */
export const CLOUD_MASK_LAYER = 29;
/** Cloud drift offset while frozen (&freeze=1): a cloudy day over western Europe, so cloud shots test something. */
const FROZEN_CLOUD_U = 0.52;

/**
 * Cloud thinning factors for a mode and camera altitude (DESIGN_V2 §10.5, FEEDBACK #5): x = the human's land,
 * y = other land, z = ocean, w = fronts. Strategic mode keeps the human's land and the fronts clear of cloud at every
 * zoom the game is played at, down to the close-zoom threshold (300 km); other land stays thin (0.2 from orbit, 0.3
 * at mid zoom) and the ocean keeps its weather. Below 300 km the clouds come back toward the realistic look
 * (0.6 / 0.6 / 1 / 0.3 at 150 km), where the camera is among them and the ground detail carries the map.
 */
export function cloudFactors(mode: CloudMode, altKm: number, out: THREE.Vector4): THREE.Vector4 {
  if (mode !== 'strategic') return out.set(1, 1, 1, 1);
  const far = smoothstep(800, 2500, altKm);
  const close = 1 - smoothstep(150, 300, altKm);
  return out.set(lerp(0, 0.6, close), lerp(lerp(0.3, 0.2, far), 0.6, close), lerp(1, 0.85, far), lerp(0, 0.3, close));
}

export function createGlobe(ctx: GameContext): GlobeApi {
  const root = new THREE.Group();
  root.name = 'globe';
  ctx.scene.add(root);

  let quality: QualityProfile = ctx.quality;
  const planet = createPlanetUniforms();
  const territory = createTerritoryLayer(ctx);
  const space = createSpaceBackdrop();
  root.add(space.group);

  let tex: PlanetTextures | null = null;
  let earth: Earth | null = null;
  let layers: AtmosphereLayers | null = null;
  let labels: NationLabels | null = null;
  let islands: IslandMarkers | null = null;
  let marks: TileMarks | null = null;
  let font: SdfFont | null = null;
  let territoryOpacity = 0;
  let territoryTarget = 0;
  let hoverTile = -1;
  let historical = 0;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const pickSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const tmpLL: LatLon = { lat: 0, lon: 0 };
  const camLL: LatLon = { lat: 0, lon: 0 };
  const camState: CameraState = { lat: 0, lon: 0, altitudeKm: 0, tilt: 0, heading: 0 };
  const camUp = new THREE.Vector3();
  const sunDir = new THREE.Vector3(1, 0, 0);

  function reliefRadius(lat: number, lon: number): number {
    const w = ctx.world;
    if (w) return surfaceRadius(sampleElevation(w, lat, lon));
    return meshRadius(lat, lon);
  }

  /** The earth vertex shader's displacement (textureLod(uRelief).a, bilinear, texel centres at +0.5). */
  function meshRadius(lat: number, lon: number): number {
    if (!tex) return 1;
    // Same bilinear lookup as data.sampleElevation, on our copy of the topology.
    const W = tex.reliefW, H = tex.reliefH, d = tex.reliefGray;
    const fx = (((((lon + 180) / 360) * W - 0.5) % W) + W) % W;
    const fy = Math.min(H - 1, Math.max(0, ((90 - lat) / 180) * H - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = (x0 + 1) % W, y1 = Math.min(H - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = d[y0 * W + x0] * (1 - tx) + d[y0 * W + x1] * tx;
    const b = d[y1 * W + x0] * (1 - tx) + d[y1 * W + x1] * tx;
    return surfaceRadius(((a * (1 - ty) + b * ty) / 255) * TOPO_MAX_METERS);
  }

  function placePatch(): void {
    if (!earth) return;
    const cam = ctx.camera;
    const dist = cam.position.length();
    const alt = dist - 1;
    const altKm = alt * EARTH_RADIUS_KM;
    const active = altKm < 2600;
    earth.patch.visible = active;
    earth.uniforms.uPatchActive.value = active ? 1 : 0;
    if (!active) return;
    const s = ctx.cameraRig.getState(camState);
    // Centre between the point under the camera and the look-at target (tilted views look ahead).
    vec3ToLatLon(cam.position, camLL);
    let lat = (camLL.lat + s.lat) / 2;
    let dLon = s.lon - camLL.lon;
    dLon -= 360 * Math.floor((dLon + 180) / 360);
    let lon = camLL.lon + dLon / 2;
    lat = clamp(lat, -78, 78);
    const horizon = Math.sqrt(2 * Math.max(alt, 1e-5) + alt * alt);
    const ext = clamp(Math.max(alt * 4.5, horizon * (0.55 + 0.6 * Math.sin(s.tilt))), 0.012, 0.42);
    const coslat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const extLon = Math.min(ext / coslat, 1.2);
    // Snap the centre to the central vertex spacing so the grid does not swim over the relief.
    const n = PATCH_RES[quality.globeDetail];
    const step = ((2 * ext) / n) * PATCH_WARP * (180 / Math.PI);
    lat = Math.round(lat / step) * step;
    const stepLon = step / coslat;
    lon = Math.round(lon / stepLon) * stepLon;
    const D = Math.PI / 180;
    (earth.uniforms.uPatch.value as THREE.Vector4).set(lat * D, lon * D, ext, extLon);
    (earth.uniforms.uPatchCut.value as THREE.Vector4).set(lat * D, lon * D, ext * 0.93, extLon * 0.93);
  }

  const api: GlobeApi = {
    root,
    async init(progress) {
      const texP = loadPlanetTextures(ctx.renderer, quality.textureSize, (f) => progress(f * 0.85));
      const fontP = buildSdfFont().catch((err: unknown) => {
        console.warn('[globe] label font atlas failed', err);
        return null;
      });
      const [t, f] = await Promise.all([texP, fontP]);
      tex = t;
      font = f;
      space.setTextures(t.stars);
      space.bake(ctx.renderer);

      earth = createEarth(t, planet, territory, earthDefines(quality), quality.globeDetail);
      earth.sphere.layers.enable(MASK_LAYER);
      earth.patch.layers.enable(MASK_LAYER);
      root.add(earth.sphere, earth.patch);
      layers = createAtmosphereLayers(planet, t.clouds, quality.atmosphere, quality.globeDetail, territory.uniforms.uCloudMask);
      layers.clouds.layers.enable(CLOUD_MASK_LAYER);
      layers.cloudsInner.layers.enable(CLOUD_MASK_LAYER);
      root.add(layers.clouds, layers.cloudsInner, layers.atmosphere);
      labels = createNationLabels(ctx, font);
      root.add(labels.mesh);
      islands = createIslandMarkers(ctx);
      root.add(islands.mesh);
      marks = createTileMarks((lat, lon) => meshRadius(lat, lon));
      root.add(marks.group);
      const isl = islands;
      (window as unknown as { __islands?: unknown }).__islands = { visible: () => isl.visible(), details: () => isl.details() };
      // Verification (tools/w2-verify.mjs): the historical-borders overlay strength actually sent to the shader.
      (window as unknown as { __globeDebug?: unknown }).__globeDebug = { historical: () => territory.uniforms.uHistorical.value };
      progress(1);
    },
    warmup(on) {
      if (!earth || !layers || !labels) return;
      if (on) {
        earth.patch.visible = true;
        layers.cloudsInner.visible = true;
        layers.clouds.visible = true;
        labels.mesh.visible = true;
        islands?.warmup(true);
        territory.warmup();
      } else {
        earth.patch.visible = false;
        layers.cloudsInner.visible = false;
        islands?.warmup(false);
      }
    },
    onGameStart() {
      territory.resetAll();
      labels?.clear();
      labels?.markTextDirty();
    },
    onGameEnd() {
      territory.clear();
      labels?.clear();
      islands?.clear();
      marks?.clear();
      hoverTile = -1;
      territory.setHoverOwner(0);
    },
    update(frame: FrameInfo) {
      const dt = frame.dt;
      const worldTime = worldTimeOverride ?? frame.worldTime;
      sunDirection(worldTime, sunDir);
      planet.uSunDir.value.copy(sunDir);
      planet.uTime.value = presentationTime(frame.time);
      const cloudU = shotView.freeze ? FROZEN_CLOUD_U : (worldTime / CLOUD_PERIOD_SEC) % 1;
      planet.uCloudOffset.value.set(quality.clouds >= 1 || shotView.freeze ? cloudU : 0, 0);

      const cam = ctx.camera;
      const camDist = cam.position.length();
      const altKm = (camDist - 1) * EARTH_RADIUS_KM;
      // Zoom level for the readability tables: the rig's distance to its target (what the player dials in).
      const zoomKm = ctx.cameraRig.getState(camState).altitudeKm;
      planet.uNormalBoost.value = 0.65 + 0.45 * smoothstep(150, 7000, altKm);
      planet.uHaze.value = 0.3 + 0.7 * smoothstep(80, 3000, altKm);
      planet.uFill.value = territoryFillAmount(zoomKm);
      planet.uNeutralK.value = smoothstep(600, 1000, zoomKm);
      planet.uNightFloor.value = lerp(0.1, 0.22, smoothstep(600, 1000, zoomKm));
      // Border noise (tiles): ~2-6 km wander, faded in below 1,500 km (sub-pixel from higher up).
      planet.uBorderNoise.value = 0.16 * (1 - smoothstep(600, 1500, zoomKm));
      planet.uShoreK.value = smoothstep(1200, 1500, zoomKm);
      planet.uCloseK.value = 1 - smoothstep(150, 300, zoomKm);
      planet.uMaskMode.value = shotView.mask === 'owner' ? 1 : shotView.mask === 'cloud' ? 2 : 0;
      planet.uSpawn.value = damp(planet.uSpawn.value, ctx.sim.view.phase === 'spawn' ? 1 : 0, 3, dt);
      cam.layers.set(shotView.mask ? MASK_LAYER : 0);
      if (shotView.mask === 'cloud') cam.layers.enable(CLOUD_MASK_LAYER);

      territoryOpacity = damp(territoryOpacity, territoryTarget, 5, dt);
      if (Math.abs(territoryOpacity - territoryTarget) < 0.002) territoryOpacity = territoryTarget;
      territory.uniforms.uTerritoryOpacity.value = shotView.territory ? territoryOpacity : 0;
      const wantHist = ctx.settings.get().historicalBorders && ctx.sim.view.phase !== 'none' ? 1 - smoothstep(800, 1000, zoomKm) : 0;
      historical = shotView.freeze ? wantHist : damp(historical, wantHist, 6, dt);
      territory.uniforms.uHistorical.value = historical < 0.002 ? 0 : historical;
      territory.update(dt, frame.now / 1000);
      if (hoverTile >= 0 && ctx.sim.view.phase !== 'none') territory.setHoverOwner(ctx.sim.view.owner[hoverTile] ?? 0);

      placePatch();
      const cloudMode: CloudMode = shotView.clouds ?? ctx.settings.get().clouds ?? 'strategic';
      cloudFactors(ctx.sim.view.phase === 'none' ? 'realistic' : cloudMode, zoomKm, planet.uCloudK.value);
      const cloudFade = cloudMode === 'hidden' ? 0 : smoothstep(45, 320, altKm);
      layers?.update(camDist);
      layers?.setCloudFade(cloudFade);
      planet.uCloudShadow.value = cloudFade;

      // Stars fade in a daylit sky (camera inside the atmosphere with the sun up).
      camUp.copy(cam.position).normalize();
      const sunUp = camUp.dot(sunDir);
      const inAir = 1 - smoothstep(40, 400, altKm);
      const starFade = 1 - smoothstep(-0.12, 0.12, sunUp) * inAir * 0.97;
      const sunVis = 1 - inAir * 0.5;
      space.update(cam, sunDir, frame.time, ctx.renderer.getPixelRatio(), starFade, sunVis);

      labels?.update(dt, territoryOpacity);
      islands?.update();
      marks?.update(frame.time, ctx.renderer.domElement.clientHeight || window.innerHeight, ctx.camera.fov);
    },
    pickLatLon(clientX, clientY, out) {
      const r = ctx.canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, ctx.camera);
      const ray = raycaster.ray;
      pickSphere.radius = RELIEF_TOP;
      if (!ray.intersectSphere(pickSphere, hit)) return null;
      pickSphere.radius = 1;
      if (!ray.intersectSphere(pickSphere, hit)) {
        // Grazing the horizon over high ground: keep the outer hit.
        pickSphere.radius = RELIEF_TOP;
        ray.intersectSphere(pickSphere, hit);
      }
      const ll = out ?? { lat: 0, lon: 0 };
      // Iterate on the relief: intersect the sphere at the ground radius of the previous estimate.
      for (let i = 0; i < 4; i++) {
        vec3ToLatLon(hit, ll);
        pickSphere.radius = reliefRadius(ll.lat, ll.lon);
        if (!ray.intersectSphere(pickSphere, hit)) break;
      }
      return vec3ToLatLon(hit, ll);
    },
    pickTile(clientX, clientY) {
      const ll = api.pickLatLon(clientX, clientY, tmpLL);
      return ll ? latLonToTile(ll.lat, ll.lon) : -1;
    },
    surfaceRadiusAt(lat, lon) {
      return reliefRadius(lat, lon);
    },
    meshRadiusAt(lat, lon) {
      return meshRadius(lat, lon);
    },
    getSunDirection(out) {
      return sunDirection(worldTimeOverride ?? ctx.frame.worldTime, out);
    },
    setHoverTile(tile) {
      hoverTile = tile;
      if (tile < 0) territory.setHoverOwner(0);
    },
    setTileMarks(key, tiles, color, pulse) {
      marks?.set(key, tiles, color, pulse);
    },
    pickIsland(clientX, clientY) {
      return islands && islands.mesh.visible ? islands.pick(clientX, clientY) : null;
    },
    setTerritoryOpacity(v) {
      territoryTarget = clamp(v, 0, 1);
      if (ctx.app?.isShot) territoryOpacity = territoryTarget;
    },
    setQuality(q) {
      const prev = quality;
      quality = q;
      if (!earth || !layers || !tex) return;
      earth.setDefines(earthDefines(q));
      if (q.globeDetail !== prev.globeDetail) earth.setDetail(q.globeDetail);
      layers.setQuality(q.atmosphere, q.clouds, q.globeDetail);
      if (q.textureSize !== prev.textureSize) {
        for (const t of [tex.day, tex.night, tex.clouds, tex.stars]) applyTextureSize(t, q.textureSize);
      }
    },
  };
  return api;
}
