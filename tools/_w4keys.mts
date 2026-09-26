import fs from 'node:fs';
import { es } from '/home/user/joc/src/ui/i18n/es.ts';
import { en } from '/home/user/joc/src/ui/i18n/en.ts';
import { esW1, enW1 } from '/home/user/joc/src/ui/i18n/w1.ts';
import { esW2, enW2 } from '/home/user/joc/src/ui/i18n/w2.ts';
import { esW3, enW3 } from '/home/user/joc/src/ui/i18n/w3.ts';
import { SIM_STRINGS } from '/home/user/joc/src/sim/strings.ts';
let esW4: Record<string,string> = {}, enW4: Record<string,string> = {};
try { const m = await import('/home/user/joc/src/ui/i18n/w4.ts'); esW4 = m.esW4; enW4 = m.enW4; } catch {}
const ES = { ...SIM_STRINGS.es, ...es, ...esW1, ...esW2, ...esW3, ...esW4 };
const EN = { ...SIM_STRINGS.en, ...en, ...enW1, ...enW2, ...enW3, ...enW4 };
const files = process.argv.slice(2);
const keys = new Set<string>();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\b(?:t|tx)\(\s*[`']([a-zA-Z][a-zA-Z0-9_.${}]+)[`']/g)) keys.add(m[1]);
  for (const m of s.matchAll(/'((?:order\.err|msg)\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
}
const miss = [...keys].filter((k) => !k.includes('${') && (!(k in ES) || !(k in EN)));
console.log(miss.sort().join('\n'));
console.log('templated:', [...keys].filter((k) => k.includes('${')).join(' '));
