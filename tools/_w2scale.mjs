import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto('http://127.0.0.1:5312/?shot=unit-closeup&unit=Warship&alt=300', { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
console.log(await p.evaluate(() => { const sc = window.__front.ctx.scene; const r = [];
  for (const n of ['globe', 'earth', 'earth-near-patch']) { const o = sc.getObjectByName(n); o.updateWorldMatrix(true, false); r.push(n + ' ' + JSON.stringify(o.matrixWorld.elements.map((v) => +v.toFixed(7)))); }
  const e = sc.getObjectByName('earth'); const u = e.material.uniforms; r.push('reliefScale ' + u.uReliefScale.value + ' tex ' + u.uRelief.value.image.width + 'x' + u.uRelief.value.image.height);
  const g = window.__front.ctx.globe; for (const [la, lo] of [[39.22, 1.26], [40.5, 4.5], [38.5, 2.2], [39.0, 1.4]]) r.push(la + ',' + lo + ' meshR ' + ((g.meshRadiusAt(la, lo) - 1) * 6371000).toFixed(1));
  for (let la = 39.4; la >= 39.0; la -= 0.05) { let row = la.toFixed(2) + ': '; for (let lo = 1.0; lo <= 1.61; lo += 0.1) row += ((g.meshRadiusAt(la, lo) - 1) * 6371000).toFixed(0).padStart(5); r.push(row); }
  const img = u.uRelief.value.image; let W = img.width, H = img.height; let a = new Float32Array(W * H); for (let i = 0; i < W * H; i++) a[i] = img.data[i * 4 + 3];
  const samp = (a, W, H, la, lo) => { const fx = ((((lo + 180) / 360) * W - 0.5) % W + W) % W, fy = Math.min(H - 1, Math.max(0, ((90 - la) / 180) * H - 0.5)); const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = (x0 + 1) % W, y1 = Math.min(H - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return ((a[y0*W+x0]*(1-tx)+a[y0*W+x1]*tx)*(1-ty)+(a[y1*W+x0]*(1-tx)+a[y1*W+x1]*tx)*ty)/255*8848*4; };
  for (let lv = 0; lv < 7; lv++) { r.push('mip' + lv + ' ' + samp(a, W, H, 39.22, 1.26).toFixed(1) + 'm');
    const W2 = W >> 1, H2 = H >> 1, b = new Float32Array(W2 * H2); for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) b[y*W2+x] = (a[(2*y)*W+2*x] + a[(2*y)*W+2*x+1] + a[(2*y+1)*W+2*x] + a[(2*y+1)*W+2*x+1]) / 4; a = b; W = W2; H = H2; }
  return r.join('\n'); }));
await b.close();
