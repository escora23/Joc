// FRONT ULTRA — headless save snapshots for late-game shots and tests (DESIGN_V2 §12.8). Tooling only.
//
//   npx tsx tools/snapshot.mjs [--ticks 12000] [--seed 1337] [--difficulty normal] [--ais 24] [--tribes 40]
//                              [--out shots/snapshots/<name>.fusave]
//
// Runs an autopilot game (the AI also plays the human) to the given tick exactly like the worker does and writes the
// save blob (the same format as the in-game autosave) into the gitignored shots/snapshots/ cache. Late-game shots can
// load it instead of fast-forwarding tens of thousands of ticks; regenerate the cache whenever the sim changes (a blob
// from another format version or world is refused on load).

import fs from 'node:fs';
import path from 'node:path';
import { loadWorldInit } from '../src/sim/test/world.mjs';
import { Game } from '../src/sim/game.ts';
import { SaveWriter } from '../src/sim/save.ts';
import { latLonToTile } from '../src/shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? def : argv[i + 1];
};
const TICKS = Number(arg('ticks', 12000));
const SEED = Number(arg('seed', 1337));
const DIFF = String(arg('difficulty', 'normal'));
const out = String(arg('out', `shots/snapshots/seed${SEED}-${DIFF}-t${TICKS}.fusave`));

const world = await loadWorldInit(() => {});
const game = new Game({
  seed: SEED, playerName: 'Snapshot', playerColor: 0x2f6fd6, difficulty: DIFF, aiCount: Number(arg('ais', 24)),
  tribeCount: Number(arg('tribes', 40)), speed: 1, nukes: true, worldEvents: true, startWorldTimeSec: 0, spawnTimeoutTicks: 300,
  autoSpawnTile: latLonToTile(40.4, -3.7), instantStart: true, humanAutopilot: true, duration: String(arg('duration', 'normal')),
}, world);
const t0 = Date.now();
while (game.tick < TICKS && game.phase !== 'ended') {
  game.tick1();
  if (game.tick % 4 === 0) game.buildUpdate(4);
}
const w = new SaveWriter();
game.serialize(w);
const blob = w.finish();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(blob));
console.log(`[snapshot] tick ${game.tick} (${((Date.now() - t0) / 1000).toFixed(0)} s) -> ${out} (${(blob.byteLength / 1e6).toFixed(2)} MB)`);
