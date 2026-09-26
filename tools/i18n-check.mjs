// FRONT ULTRA — i18n completeness check (W3, DESIGN_V2 §12.7). Test tooling, never bundled.
//   npx tsx tools/i18n-check.mjs [keys.txt]
// Lists keys used by the code (static t('…') / tx('…') literals in src/, plus the sim's reason keys) that are missing
// in Spanish or English, and dictionary strings with a raw «(a)» gendered placeholder.
import fs from 'node:fs';
import path from 'node:path';
import { es } from '../src/ui/i18n/es.ts';
import { en } from '../src/ui/i18n/en.ts';
import { esW1, enW1 } from '../src/ui/i18n/w1.ts';
import { esW2, enW2 } from '../src/ui/i18n/w2.ts';
import { esW3, enW3 } from '../src/ui/i18n/w3.ts';
import { SIM_STRINGS, FALLBACK_NAMES_ES, FALLBACK_NAMES_EN } from '../src/sim/strings.ts';

const ES = { ...FALLBACK_NAMES_ES, ...SIM_STRINGS.es, ...es, ...esW1, ...esW2, ...esW3 };
const EN = { ...FALLBACK_NAMES_EN, ...SIM_STRINGS.en, ...en, ...enW1, ...enW2, ...enW3 };
const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { if (!p.includes('i18n') && !p.includes('/test')) walk(p); }
    else if (p.endsWith('.ts') && !p.endsWith('strings.ts')) files.push(p);
  }
};
walk('src/ui'); walk('src/sim'); walk('src/audio');
const keys = new Set();
const re = /\b(?:t|tx|tn)\(\s*'([a-zA-Z][a-zA-Z0-9_.]+)'/g;
const re2 = /key: '((?:answer|diplo\.reason|treaty\.reason|tension|war\.reason|peace\.reason|escalation\.reason|msg)\.[a-zA-Z0-9_.]+)'/g;
const re3 = /'((?:answer|tension|treaty\.reason|war\.reason|peace\.reason|escalation\.reason|msg)\.[a-zA-Z0-9_.]+)'/g;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(re)) keys.add(m[1]);
  for (const m of s.matchAll(re2)) keys.add(m[1]);
  if (f.includes('/sim/')) for (const m of s.matchAll(re3)) keys.add(m[1]);
}
// Remembered / standing reason keys of the diplomacy system.
const dip = fs.readFileSync('src/sim/diplomacy.ts', 'utf8');
for (const m of dip.matchAll(/push\('([a-zA-Z]+)'/g)) keys.add(`diplo.reason.${m[1]}`);
for (const m of dip.matchAll(/^  ([a-zA-Z]+): \{ value:/gm)) keys.add(`diplo.reason.${m[1]}`);
const ignore = (k) => k.startsWith('ai.') || k.endsWith('.') || /\.(m|f)$/.test(k) && (k.slice(0, -2) in ES);
const missEs = [...keys].filter((k) => !ignore(k) && !(k in ES)).sort();
const missEn = [...keys].filter((k) => !ignore(k) && !(k in EN)).sort();
const bad = Object.entries(ES).concat(Object.entries(EN)).filter(([, v]) => /\(a\)/.test(v)).map(([k]) => k);
console.log(`keys used ${keys.size}; missing es ${missEs.length}, en ${missEn.length}; «(a)» ${bad.length}`);
if (missEs.length) console.log('ES:', missEs.join(' '));
if (missEn.length) console.log('EN:', missEn.join(' '));
if (bad.length) console.log('(a):', bad.join(' '));
process.exit(missEs.length + missEn.length + bad.length ? 1 : 0);
