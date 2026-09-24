// FRONT ULTRA — AI nations (owner: sim-ai). Runs inside the sim worker, deterministic (game.rng only).
// STUB by the architect: places AI nations at a few real capitals and makes them expand into free land and
// attack their weakest neighbour. sim-ai replaces this with personalities, difficulty scaling, diplomacy,
// economy/build orders, naval invasions, nukes, tribes, etc. Keep the export: createAiDirector(game).

import { HUMAN_ID } from '../../shared/constants';
import { hslToHex } from '../../shared/color';
import { latLonToTile, tileX, tileY } from '../../shared/geo';
import { PERSONALITIES } from '../../shared/types';
import type { SimEvent } from '../../shared/protocol';
import type { AiDirector, SimGame } from '../../shared/simapi';

/** Stub spawn list (the real one comes from the data catalog: capitals + weights). */
const STUB_NATIONS: [string, number, number][] = [
  ['France', 46.6, 2.4], ['Germany', 51.0, 10.4], ['Russia', 56.0, 40.0], ['China', 34.0, 108.0],
  ['India', 22.0, 79.0], ['United States of America', 39.0, -98.0], ['Brazil', -12.0, -50.0],
  ['Egypt', 27.0, 30.0], ['Nigeria', 9.5, 8.0], ['Australia', -25.0, 134.0], ['Japan', 36.5, 138.5],
  ['Mexico', 23.0, -102.0], ['Argentina', -35.0, -64.0], ['Turkey', 39.0, 35.0], ['Iran', 32.0, 54.0],
  ['Canada', 56.0, -106.0], ['South Africa', -29.0, 25.0], ['Indonesia', -2.0, 115.0], ['Kazakhstan', 48.0, 67.0],
  ['Saudi Arabia', 24.0, 45.0], ['Poland', 52.0, 19.0], ['United Kingdom', 53.0, -1.5], ['Italy', 43.0, 12.5],
  ['Ethiopia', 9.0, 39.5], ['Colombia', 4.0, -73.0], ['Algeria', 28.0, 2.6], ['Mongolia', 46.8, 103.0],
  ['Peru', -9.0, -75.0], ['Ukraine', 49.0, 32.0], ['Sweden', 62.0, 16.0],
];

export function createAiDirector(game: SimGame): AiDirector {
  const rng = game.rng.fork('ai');
  const ids: number[] = [];

  function findLand(tile: number): number {
    if (game.isPlayable(tile) && game.ownerOf(tile) === 0) return tile;
    const x0 = tileX(tile), y0 = tileY(tile);
    for (let r = 1; r < 40; r++) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = Math.round(x0 + Math.cos(a) * r), y = Math.round(y0 + Math.sin(a) * r);
        if (y < 0 || y >= game.world.height) continue;
        const t = y * game.world.width + ((x + game.world.width) % game.world.width);
        if (game.isPlayable(t) && game.ownerOf(t) === 0) return t;
      }
    }
    return -1;
  }

  return {
    setup() {
      const count = Math.min(game.config.aiCount, STUB_NATIONS.length);
      const list = rng.shuffle(STUB_NATIONS.slice()).slice(0, count);
      list.forEach(([name, lat, lon], i) => {
        const countryIndex = game.world.countries.findIndex((c) => c.nameEn === name);
        const id = game.addPlayer({
          name,
          kind: 'nation',
          personality: PERSONALITIES[i % PERSONALITIES.length],
          color: hslToHex((i * 137.508) % 360, 0.62, 0.5),
          countryIndex: Math.max(0, countryIndex),
        });
        ids.push(id);
        const tile = findLand(latLonToTile(lat, lon));
        if (tile >= 0) game.issue(id, { type: 'spawn', tile });
      });
    },
    tick() {
      if (game.phase !== 'playing') return;
      if (game.config.humanAutopilot && !ids.includes(HUMAN_ID)) ids.unshift(HUMAN_ID);
      for (let i = 0; i < ids.length; i++) {
        if ((game.tick + i * 7) % 20 !== 0) continue;
        const p = game.player(ids[i]);
        if (!p || !p.alive || p.troops < p.maxTroops * 0.35) continue;
        const neighbors = game.neighborsOf(p.id);
        if (neighbors.includes(0)) {
          game.issue(p.id, { type: 'attack', target: 0, ratio: 0.35, tile: p.capitalTile });
          continue;
        }
        let best = -1, bestTroops = Infinity;
        for (const n of neighbors) {
          const q = game.player(n);
          if (!q || game.isAllied(p.id, n)) continue;
          if (q.troops < bestTroops) {
            best = n;
            bestTroops = q.troops;
          }
        }
        if (best > 0 && bestTroops < p.troops * 0.8) game.issue(p.id, { type: 'attack', target: best, ratio: 0.3, tile: p.capitalTile });
      }
    },
    onEvent(e: SimEvent) {
      if (e.type === 'allianceRequested' && ids.includes(e.to) && e.from === HUMAN_ID) {
        game.issue(e.to, { type: 'allianceReply', from: e.from, accept: rng.chance(0.5) });
      }
    },
  };
}
