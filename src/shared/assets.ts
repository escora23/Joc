// FRONT ULTRA — static asset URLs. Everything is served from the static build (no network at runtime).
// Always build URLs with assetUrl() so the game works from any base path (vite base: './').

export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL ?? './';
  return base + path.replace(/^\/+/, '');
}

/** The only image files in the project (NASA, public domain). */
export const TEXTURES = {
  /** 4096x2048 Blue Marble day color (sRGB). */
  day: 'textures/earth-blue-marble.jpg',
  /** 4096x2048 Black Marble city lights (sRGB). */
  night: 'textures/earth-night.jpg',
  /** 2048x1024 grayscale elevation, linear: gray/255 * TOPO_MAX_METERS (data, NoColorSpace). */
  topology: 'textures/earth-topology.png',
  /** 1600x800 water mask: white = water, black = land (includes rivers & lakes). Exactly the tile grid. */
  water: 'textures/earth-water.png',
  /** 4096x2048 cloud cover (alpha-ish in luminance). */
  clouds: 'textures/clouds.png',
  /** 4096x2048 star field / Milky Way (sRGB). */
  stars: 'textures/night-sky.png',
} as const;

export type TextureKey = keyof typeof TEXTURES;

/** Fetch + decode an image to ImageBitmap (works on the main thread and in workers). */
export async function loadBitmap(path: string, opts?: ImageBitmapOptions): Promise<ImageBitmap> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, opts);
}

/** Decode an image into RGBA pixels at its native size (or scaled to w x h). */
export async function loadPixels(path: string, w?: number, h?: number): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bmp = await loadBitmap(path, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const width = w ?? bmp.width;
  const height = h ?? bmp.height;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return { width, height, data: g.getImageData(0, 0, width, height).data };
}
