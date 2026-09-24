// FRONT ULTRA — the planet (owner: globe).
// STUB by the architect: day/night textured sphere lit by the moving sun, star sphere, and a territory overlay
// (CPU-colored RGBA DataTexture patched from 'tilesChanged'). pickTile via analytic ray/sphere.
// The globe owner replaces it with the photoreal Earth (relief, ocean glint, clouds, scattering, glowing
// borders, hot fronts, labels...). Keep the export: createGlobe(ctx): GlobeApi.

import * as THREE from 'three';
import type { FrameInfo, GameContext, GlobeApi } from '../../shared/api';
import { TEXTURES, assetUrl } from '../../shared/assets';
import { MAP_H, MAP_W, TILE_COUNT } from '../../shared/constants';
import { latLonToTile, sunDirection, surfaceRadius, vec3ToLatLon } from '../../shared/geo';
import { unpackOwner, unpackTile } from '../../shared/protocol';
import type { LatLon } from '../../shared/types';
import { sampleElevation } from '../../data';

const vert = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
void main() {
  vUv = uv;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uTerritory;
uniform vec3 uSunDir;
uniform float uTerritoryOpacity;
varying vec2 vUv;
varying vec3 vNormalW;
void main() {
  vec3 n = normalize(vNormalW);
  float ndl = dot(n, uSunDir);
  float day = smoothstep(-0.12, 0.18, ndl);
  vec3 dayCol = texture2D(uDay, vUv).rgb * (0.25 + 1.1 * max(ndl, 0.0));
  vec3 nightCol = texture2D(uNight, vUv).rgb * 1.4;
  vec3 col = mix(nightCol, dayCol, day);
  vec4 terr = texture2D(uTerritory, vec2(vUv.x, 1.0 - vUv.y));
  col = mix(col, terr.rgb * mix(0.35, 1.0, day), terr.a * uTerritoryOpacity);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createGlobe(ctx: GameContext): GlobeApi {
  const root = new THREE.Group();
  root.name = 'globe';
  const territoryData = new Uint8Array(TILE_COUNT * 4);
  const territory = new THREE.DataTexture(territoryData, MAP_W, MAP_H, THREE.RGBAFormat);
  // Grid-ordered data (row 0 = north) is uploaded as-is (flipY=false): sample it with v = 1 - uv.y.
  territory.magFilter = THREE.NearestFilter;
  territory.minFilter = THREE.LinearFilter;
  territory.colorSpace = THREE.SRGBColorSpace;
  territory.needsUpdate = true;
  let territoryDirty = false;

  const uniforms = {
    uDay: { value: null as THREE.Texture | null },
    uNight: { value: null as THREE.Texture | null },
    uTerritory: { value: territory },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uTerritoryOpacity: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), material);
  earth.name = 'earth';
  root.add(earth);

  const starsMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, color: 0x8a8a8a });
  const stars = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), starsMat);
  stars.renderOrder = -100;
  root.add(stars);
  ctx.scene.add(root);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const hit = new THREE.Vector3();
  const tmpLL: LatLon = { lat: 0, lon: 0 };

  function paint(tile: number, owner: number): void {
    const o = tile * 4;
    const p = owner ? ctx.sim.view.players[owner] : undefined;
    if (!p) {
      territoryData[o + 3] = 0;
      return;
    }
    territoryData[o] = (p.color >> 16) & 255;
    territoryData[o + 1] = (p.color >> 8) & 255;
    territoryData[o + 2] = p.color & 255;
    territoryData[o + 3] = owner === 1 ? 170 : 140;
  }

  function repaintAll(): void {
    const owner = ctx.sim.view.owner;
    for (let t = 0; t < TILE_COUNT; t++) paint(t, owner[t]);
    territoryDirty = true;
  }

  ctx.bus.on('tilesChanged', (e) => {
    if (e.full) return repaintAll();
    for (let i = 0; i < e.count; i++) paint(unpackTile(e.packed[i]), unpackOwner(e.packed[i]));
    territoryDirty = true;
  });
  // Player colors arrive with the first update after the tiles: repaint when new players appear.
  let knownPlayers = 0;

  const api: GlobeApi = {
    root,
    async init(progress) {
      const loader = new THREE.TextureLoader();
      const load = (url: string, srgb: boolean) =>
        loader.loadAsync(assetUrl(url)).then((t) => {
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
          return t;
        });
      let done = 0;
      const step = () => progress(++done / 3);
      const [day, night, sky] = await Promise.all([
        load(TEXTURES.day, true).finally(step),
        load(TEXTURES.night, true).finally(step),
        load(TEXTURES.stars, true).finally(step),
      ]);
      uniforms.uDay.value = day;
      uniforms.uNight.value = night;
      starsMat.map = sky;
      starsMat.needsUpdate = true;
    },
    onGameStart() {
      knownPlayers = 0;
      repaintAll();
    },
    onGameEnd() {
      territoryData.fill(0);
      territoryDirty = true;
    },
    update(frame: FrameInfo) {
      sunDirection(frame.worldTime, uniforms.uSunDir.value);
      stars.position.copy(ctx.camera.position);
      const n = ctx.sim.view.playerList.length;
      if (n !== knownPlayers) {
        knownPlayers = n;
        repaintAll();
      }
      if (territoryDirty) {
        territory.needsUpdate = true;
        territoryDirty = false;
      }
    },
    pickLatLon(clientX, clientY, out) {
      const r = ctx.canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, ctx.camera);
      if (!raycaster.ray.intersectSphere(sphere, hit)) return null;
      return vec3ToLatLon(hit, out ?? { lat: 0, lon: 0 });
    },
    pickTile(clientX, clientY) {
      const ll = api.pickLatLon(clientX, clientY, tmpLL);
      return ll ? latLonToTile(ll.lat, ll.lon) : -1;
    },
    surfaceRadiusAt(lat, lon) {
      const w = ctx.world;
      return w ? surfaceRadius(sampleElevation(w, lat, lon)) : 1;
    },
    getSunDirection(out) {
      return sunDirection(ctx.frame.worldTime, out);
    },
    setHoverTile() {},
    setTerritoryOpacity(v) {
      uniforms.uTerritoryOpacity.value = v;
    },
  };
  return api;
}
