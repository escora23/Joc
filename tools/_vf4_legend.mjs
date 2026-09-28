import { chromium } from 'playwright';
const O = '/home/user/joc/shots/W2-map-readability-verify/it4';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000&freeze=1', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.evaluate(() => window.__front.ctx.app.goto?.('playing'));
await page.waitForTimeout(2000);
// Help button in the HUD tool row (the "?" one)
const btns = await page.$$eval('button', (bs) => bs.map((b, i) => ({ i, t: (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 40), cls: b.className })).filter(b => /ayuda|help|\?/i.test(b.t + b.cls)));
console.log(JSON.stringify(btns));
await page.keyboard.press('F1').catch(()=>{});
await page.waitForTimeout(1000);
let has = await page.$('.fu-help-nav');
if (!has && btns.length) { await (await page.$$('button'))[btns[0].i].click(); await page.waitForTimeout(1500); has = await page.$('.fu-help-nav'); }
console.log('help open', !!has);
const nav = await page.$$eval('.fu-help-nav button', (bs) => bs.map(b => ({ sec: b.dataset.sec, t: b.textContent.trim() })));
console.log(JSON.stringify(nav));
await page.click('.fu-help-nav button[data-sec="legend"]');
await page.waitForTimeout(1500);
const txt = await page.$eval('.fu-help-content', (e) => e.innerText);
console.log(txt.slice(0, 3000));
await page.screenshot({ path: `${O}/legend.png` });
await browser.close();
