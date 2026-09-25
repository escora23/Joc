// FRONT ULTRA — planet texture loading & derived maps (owner: globe).
// Loads the NASA maps, downsamples them for the Low preset, and derives the relief map from the topology:
//   RG = east/north slope (sqrt-encoded for precision on plains), B = local ruggedness, A = raw elevation gray.
// The A channel reproduces data's `sampleElevation` (bilinear on the same 2048x1024 grid) so the displaced
// mesh matches every other subsystem's surface.

import * as THREE from 'three';
import { TEXTURES, assetUrl, loadPixels } from '../../shared/assets';
import { EARTH_RADIUS_KM, TOPO_MAX_METERS } from '../../shared/constants';

export interface PlanetTextures {
  day: THREE.Texture;
  night: THREE.Texture;
  clouds: THREE.Texture;
  water: THREE.Texture;
  stars: THREE.Texture;
  relief: THREE.DataTexture;
  /** Raw elevation gray (0..255), row 0 = north; handy for CPU queries. */
  reliefGray: Uint8Array;
  reliefW: number;
  reliefH: number;
}

/** Shading exaggeration baked into the slope map (independent of the geometric RELIEF_EXAGGERATION). */
export const SHADE_EXAGGERATION = 12;
/** Slope encoding range (dimensionless slope at SHADE_EXAGGERATION). Must match the shader decode. */
export const SLOPE_RANGE = 4.0;

type Img = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

const originals = new WeakMap<THREE.Texture, Img>();

function downscale(img: Img, maxW: number): Img {
  if (img.width <= maxW) return img;
  const c = document.createElement('canvas');
  c.width = maxW;
  c.height = Math.round((img.height * maxW) / img.width);
  const g = c.getContext('2d');
  if (!g) return img;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img as CanvasImageSource, 0, 0, c.width, c.height);
  return c;
}

/** Re-apply the texture size cap (quality change). */
export function applyTextureSize(tex: THREE.Texture, maxW: number): void {
  const orig = originals.get(tex);
  if (!orig) return;
  const next = downscale(orig, maxW);
  if (next !== tex.image) {
    (tex as THREE.Texture<Img>).image = next;
    tex.needsUpdate = true;
  }
}

export async function loadPlanetTextures(
  renderer: THREE.WebGLRenderer,
  maxSize: number,
  progress: (f: number) => void,
): Promise<PlanetTextures> {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let done = 0;
  const total = 6;
  const step = () => progress(++done / total);

  const load = async (url: string, srgb: boolean, cap: boolean): Promise<THREE.Texture> => {
    const t = await loader.loadAsync(assetUrl(url));
    originals.set(t, t.image as Img);
    if (cap) (t as THREE.Texture<Img>).image = downscale(t.image as Img, maxSize);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = aniso;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    step();
    return t;
  };

  const [day, night, clouds, water, stars, relief] = await Promise.all([
    load(TEXTURES.day, true, true),
    load(TEXTURES.night, true, true),
    load(TEXTURES.clouds, false, true),
    load(TEXTURES.water, false, false),
    load(TEXTURES.stars, true, true),
    loadPixels(TEXTURES.topology).then((px) => {
      step();
      return buildReliefMap(px.width, px.height, px.data);
    }),
  ]);
  water.anisotropy = 1;
  stars.anisotropy = 1;
  return { day, night, clouds, water, stars, relief: relief.tex, reliefGray: relief.gray, reliefW: relief.w, reliefH: relief.h };
}

function buildReliefMap(w: number, h: number, rgba: Uint8ClampedArray): { tex: THREE.DataTexture; gray: Uint8Array; w: number; h: number } {
  const n = w * h;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) gray[i] = rgba[i * 4];
  const meters = (g: number) => (g / 255) * TOPO_MAX_METERS;
  const out = new Uint8Array(n * 4);
  const dyM = (Math.PI * EARTH_RADIUS_KM * 1000) / h;
  const dxEq = (2 * Math.PI * EARTH_RADIUS_KM * 1000) / w;
  const enc = (s: number) => {
    const e = Math.sign(s) * Math.sqrt(Math.min(Math.abs(s) / SLOPE_RANGE, 1));
    return Math.round((e * 0.5 + 0.5) * 255);
  };

  // Local ruggedness: elevation range over a 5x5 window (separable min/max).
  const rmin = new Float32Array(n), rmax = new Float32Array(n);
  const R = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let lo = 255, hi = 0;
      for (let k = -R; k <= R; k++) {
        const v = gray[y * w + ((x + k + w) % w)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      rmin[y * w + x] = lo;
      rmax[y * w + x] = hi;
    }
  }
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    const dxM = dxEq * Math.max(0.08, Math.cos((lat * Math.PI) / 180));
    const yn = Math.max(0, y - 1), ys = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xw = (x - 1 + w) % w, xe = (x + 1) % w;
      const i = y * w + x;
      const gx = (meters(gray[y * w + xe]) - meters(gray[y * w + xw])) / (2 * dxM);
      const gy = (meters(gray[yn * w + x]) - meters(gray[ys * w + x])) / ((ys - yn) * dyM || dyM);
      let lo = 255, hi = 0;
      for (let k = -R; k <= R; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        if (rmin[yy * w + x] < lo) lo = rmin[yy * w + x];
        if (rmax[yy * w + x] > hi) hi = rmax[yy * w + x];
      }
      out[i * 4] = enc(gx * SHADE_EXAGGERATION);
      out[i * 4 + 1] = enc(gy * SHADE_EXAGGERATION);
      out[i * 4 + 2] = Math.round(Math.min(1, meters(hi - lo) / 2500) * 255);
      out[i * 4 + 3] = gray[i];
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return { tex, gray, w, h };
}
