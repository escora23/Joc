// FRONT ULTRA — command mode: headless balance harness (owner: command). Dev tool, not bundled.
// Runs the local battle (World + AI + Mission) on a synthetic heightfield without rendering and prints how the
// fight evolves.  Usage: npx tsx src/command/test/balance.ts [tank|jet|ship] [easy|normal|hard|insane] [seconds]
import * as THREE from 'three';
import { World } from '../world';
import { Brain } from '../ai';
import { Mission } from '../mission';
import { Effects } from '../fx/effects';
import { Ground } from '../env/ground';
import { createMaterials } from '../models/materials';
import { Rng } from '../../shared/rng';
import type { LocalHeightfield } from '../../data/types';

const argv = (globalThis as unknown as { process: { argv: string[] } }).process.argv;
const kind = (argv[2] ?? 'tank') as 'tank' | 'jet' | 'ship';
const diff = (argv[3] ?? 'normal') as 'easy' | 'normal' | 'hard' | 'insane';
const secs = Number(argv[4] ?? 180);
function flatHF(sizeKm: number, res: number, h: number): LocalHeightfield {
  const n = res * res;
  const heights = new Float32Array(n);
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    const x = j / (res - 1), z = i / (res - 1);
    heights[i * res + j] = h + Math.sin(x * 23) * 6 + Math.cos(z * 17) * 5;
  }
  const splatA = new Uint8Array(n * 4).fill(0), splatB = new Uint8Array(n * 4).fill(0);
  for (let i = 0; i < n; i++) splatA[i * 4 + 1] = 255;
  return { lat: 42, lon: 0, sizeKm, resolution: res, cellMeters: sizeKm * 1000 / (res - 1), heights, centerHeight: h, minHeight: h - 10, maxHeight: h + 10,
    baseCenterElevation: h, water: new Uint8Array(n), biome: new Uint8Array(n), splatA, splatB, tint: new Uint8Array(n * 3).fill(128), ms: 0 };
}
const tex = new THREE.Texture();
const mats = createMaterials(tex);
const ground = new Ground(new THREE.MeshStandardMaterial());
const h = kind === 'ship' ? -40 : 300;
ground.build(flatHF(kind === 'jet' ? 36 : kind === 'ship' ? 20 : 4.2, 129, h), flatHF(kind === 'jet' ? 240 : 150, 65, h));
const fx = new Effects(tex, tex, 8000, 64, mats.wreck);
fx.heightAt = (x, z) => ground.heightAt(x, z);
const world = new World(mats, ground, fx, new Rng(7));
const fakeScatter = { placeBags() {}, houseList: [] } as never;
const mission = new Mission(world, new Rng(9), { kind, difficulty: diff, enemyYaw: 0.3, strategicUnits: [101, 102, 103], enemyTroops: 100000 });
const player = mission.build(fakeScatter);
world.godMode = false;
const brain = new Brain(world, mission.front);
let kills = [0, 0];
const shotsBy = [0, 0];
world.hooks = {
  onPlayerHit() {}, onPlayerDamaged() {}, onPlayerKilled() { console.log(`  player killed at t=${world.time.toFixed(1)}`); },
  onKill(v) { kills[1 - v.team]++; },
};
const origFire = world.fireShell.bind(world);
world.fireShell = (o, team, ...rest) => { shotsBy[team]++; return origFire(o, team, ...rest); };
const dmgBy: Record<string, number> = {};
const origDamage = world.damage.bind(world);
world.damage = (e, amount, from, pl, dir) => {
  const k = `${from ? from.team + ':' + from.kind : 'none'}->${e.team}:${e.kind}`;
  dmgBy[k] = (dmgBy[k] ?? 0) + amount;
  origDamage(e, amount, from, pl, dir);
};
const killLog: Record<string, number> = {};
const prevKill = world.hooks.onKill;
world.hooks.onKill = (v, killer, byPlayer) => {
  const k = `${killer ? killer.team + ':' + killer.kind : 'none'} x ${v.team}:${v.kind}`;
  killLog[k] = (killLog[k] ?? 0) + 1;
  prevKill(v, killer, byPlayer);
};
const dt = 1 / 30;
const log: string[] = [];
for (let i = 0; i < secs * 30; i++) {
  brain.update(dt);
  mission.update(dt);
  // player idles (stationary target); keep it alive to measure incoming damage
  world.update(dt);
  world.syncRigs(dt);
  fx.update(dt);
  fx.discard();
  if (argv[5] === 'jets' && i % (30 * 5) === 0) {
    // DEBUG_JETS: per-jet state dump
    for (const e of world.ents) {
      if (e.kind !== 'jet' || !e.alive) continue;
      const tg = e.target;
      const d = tg ? tg.pos.distanceTo(e.pos) : -1;
      console.log(`  t=${(i / 30).toFixed(0)} jet#${e.id} team${e.team} st${e.state} y=${e.pos.y.toFixed(0)} spd=${e.speed.toFixed(0)} tgt=${tg ? tg.id : '-'} d=${d.toFixed(0)} ms=${e.missiles} cd2=${e.fireCd2.toFixed(1)}`);
    }
  }
  if (i % (30 * 20) === 0) {
    const alive = [0, 0];
    for (const e of world.ents) if (e.alive) alive[e.team]++;
    log.push(`t=${(i / 30).toFixed(0)}s alive F/E=${alive[0]}/${alive[1]} kills F/E=${kills[0]}/${kills[1]} shells F/E=${shotsBy[0]}/${shotsBy[1]} playerHP=${player.hp.toFixed(0)}`);
  }
}
console.log(kind, diff);
console.log(log.join('\n'));
console.log('damage', JSON.stringify(Object.fromEntries(Object.entries(dmgBy).map(([k, v]) => [k, Math.round(v)]))));
console.log('kills', JSON.stringify(killLog));
