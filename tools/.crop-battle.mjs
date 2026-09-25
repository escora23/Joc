// temp (battle agent): crop + nearest-upscale a PNG region. node tools/.crop-battle.mjs in.png out.png x y w h scale
import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, inp, outp, x, y, w, h, sc] = process.argv;
const src = PNG.sync.read(fs.readFileSync(inp));
const X = +x, Y = +y, W = +w, H = +h, S = +(sc || 2);
const out = new PNG({ width: W * S, height: H * S });
for (let j = 0; j < H * S; j++) for (let i = 0; i < W * S; i++) {
  const si = ((Y + Math.floor(j / S)) * src.width + (X + Math.floor(i / S))) * 4, di = (j * W * S + i) * 4;
  for (let k = 0; k < 4; k++) out.data[di + k] = src.data[si + k];
}
fs.writeFileSync(outp, PNG.sync.write(out));
