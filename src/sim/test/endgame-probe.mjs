// FRONT ULTRA — endgame diagnostic (test tooling, not an acceptance check; §4.18): run a Normal autopilot game (or resume
// a saved snapshot) and print the great powers, their wars, offensives, capitulations and rebellions every N ticks. Usage: npx tsx src/sim/test/endgame-probe.mjs --seed 11 --every 4000 [--save dir --at 40000,60000] [--load file --ticks 20000]
import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { SaveReader, SaveWriter } from '../save.ts';
import { latLonToTile } from '../../shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const world = await loadWorldInit(() => {});
const seed = Number(arg('seed', 11));
const every = Number(arg('every', 4000));
const saveDir = arg('save', '');
const saveAt = String(arg('at', '')).split(',').filter(Boolean).map(Number);
const load = arg('load', '');
let g;
if (load) {
  g = Game.restore(new SaveReader(new Uint8Array(fs.readFileSync(load)).buffer), world);
} else {
  g = new Game({
    seed, playerName: 'Audit', playerColor: 0x3fa9f5, difficulty: arg('difficulty', 'normal'), aiCount: 24, tribeCount: 40, speed: 1, nukes: true,
    worldEvents: true, startWorldTimeSec: 0, spawnTimeoutTicks: 900, autoSpawnTile: latLonToTile(40.4, -3.7),
    instantStart: true, humanAutopilot: true, duration: 'normal',
  }, world);
}
const events = [];
const emit = g.emit.bind(g);
g.emit = (e) => { if (['warDeclared', 'warEnded', 'capitulation', 'hegemony', 'gameOver'].includes(e.type) || (e.type === 'unrest' && e.stage === 'rebellion')) events.push(e); emit(e); };
const until = load ? g.tick + Number(arg('ticks', 20000)) : Number(arg('ticks', 96000));
const nm = (id) => g.playerById[id]?.name ?? id;
function dump() {
  const ps = g.playerArr.filter((p) => p.alive && (p.kind === 'nation' || p.kind === 'human')).sort((a, b) => b.tiles - a.tiles);
  console.log(`--- tick ${g.tick}: ${ps.length} powers`);
  for (const p of ps.slice(0, 8)) {
    const wars = g.war.warsOf(p.id).map((w) => `${w.a === p.id ? '->' : '<-'}${nm(w.a === p.id ? w.b : w.a)}(${w.goal},net${w.a === p.id ? w.net : -w.net})`).join(' ');
    const atk = g.outgoingAttacks(p.id).map((a) => `[${nm(a.defender)} ${a.state} R${a.ratio.toFixed(2)} ${(a.troops / 1e3).toFixed(0)}k${a.naval ? ' naval' : ''}]`).join('');
    const cap = p.capitalTile >= 0 && g.owner[p.capitalTile] === p.id ? '' : ' NOCAP';
    console.log(`  ${p.name.padEnd(14)}${cap} ex${g.war.exhaustion(p.id).toFixed(0)} ${atk}`);
    console.log(`  ${p.name.padEnd(14)} ${(100 * p.tiles / g.landTiles).toFixed(1).padStart(5)}% tr ${(p.troops / 1e3).toFixed(0)}k/${(p.maxTroops / 1e3).toFixed(0)}k ${p.personality ?? ''} allies[${[...p.allies].map(nm).join(',')}] ${wars}`);
  }
}
while (g.phase !== 'ended' && g.tick < until) {
  g.tick1();
  g.buildUpdate(1);
  if (g.tick % every === 0) {
    dump();
    const recent = events.splice(0);
    for (const e of recent) {
      if (e.type === 'warDeclared') console.log(`   decl ${e.tick} ${nm(e.aggressor ?? e.a)} -> ${nm(e.target ?? e.b)} ${e.goal ?? ''} ${e.reasonKey ?? ''}`);
      else if (e.type === 'warEnded') console.log(`   end ${e.tick} ${nm(e.a)} x ${nm(e.b)} ${e.terms?.kind} winner ${nm(e.winner)}`);
      else if (e.type === 'capitulation') console.log(`   CAPIT ${e.tick} ${nm(e.loser)} -> ${nm(e.winner)} ${e.tiles}`);
      else if (e.type === 'unrest') console.log(`   REBELLION ${e.tick} in ${nm(e.owner)} ${e.cause}`);
      else console.log(`   ${e.type} ${e.tick} ${JSON.stringify(e).slice(0, 120)}`);
    }
  }
  if (saveDir && saveAt.includes(g.tick)) {
    const w = new SaveWriter();
    g.serialize(w);
    fs.writeFileSync(`${saveDir}/s${seed}_${g.tick}.bin`, Buffer.from(w.finish()));
    console.log(`saved ${g.tick}`);
  }
}
dump();
const end = events.find((e) => e.type === 'gameOver');
console.log('END', g.tick, end ? `${end.reason} ${nm(end.winner)}` : 'none');
