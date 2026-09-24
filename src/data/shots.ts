// FRONT ULTRA — data debug shot (owner: data). Stub by the architect: 2D map of terrain classes
// (and countries once rasterised) drawn over everything.
import { MAP_H, MAP_W } from '../shared/constants';
import { registerShot } from '../shared/shots';
import { hash3 } from '../shared/rng';

const TERRAIN_RGB: [number, number, number][] = [
  [18, 40, 80], [40, 90, 140], [90, 140, 70], [150, 130, 80], [200, 200, 200], [235, 245, 255],
];

registerShot('data-debug', 'data', 'Tile grid debug: terrain classes, shores, country raster', async ({ ctx, waitFrames }) => {
  const w = ctx.world;
  if (!w) throw new Error('no world');
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W;
  canvas.height = MAP_H;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:200;image-rendering:pixelated;background:#000';
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(MAP_W, MAP_H);
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    const t = w.terrain[i];
    let [r, gg, b] = TERRAIN_RGB[t & 0x0f] ?? [255, 0, 255];
    const c = w.country[i];
    if (c) {
      const hsh = hash3(c, 7);
      r = (r + (hsh & 255)) >> 1; gg = (gg + ((hsh >> 8) & 255)) >> 1; b = (b + ((hsh >> 16) & 255)) >> 1;
    }
    if (t & 0x10) { r = Math.min(255, r + 60); gg = Math.min(255, gg + 60); b = Math.min(255, b + 60); }
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  ctx.uiRoot.appendChild(canvas);
  await waitFrames(5);
});
