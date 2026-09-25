// FRONT ULTRA — autosave to IndexedDB (DESIGN_V2 §12.8; owner: W1 framework, W3 builds the load/save UI on it).
//
// Every game day (240 ticks), at most once per 60 real seconds, the running game is serialised by the worker and
// stored in the `front-ultra` database, `saves` store, under the rotating key `autosave` (with the nation, the day
// and the wall date for W3's «Continuar»). Never during command mode: the last autosave stands.

import { HUMAN_ID, TICKS_PER_GAME_DAY } from '../shared/constants';
import type { GameContext } from '../shared/api';

const DB = 'front-ultra';
const STORE = 'saves';
const MIN_REAL_MS = 60_000;

export interface SaveRecord {
  key: string;
  blob: ArrayBuffer;
  tick: number;
  day: number;
  nation: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putSave(rec: SaveRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getSave(key: string): Promise<SaveRecord | null> {
  const db = await openDb();
  const rec = await new Promise<SaveRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as SaveRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rec;
}

/** Start the autosave loop for this page (idempotent per context). */
export function installAutosave(ctx: GameContext): void {
  let lastTick = -1;
  let lastMs = -1e12;
  let busy = false;
  setInterval(() => {
    const view = ctx.sim.view;
    if (busy || ctx.app.state !== 'playing' || view.phase !== 'playing' || view.speed === 0) return;
    if (lastTick >= 0 && view.tick < lastTick) lastTick = -1; // a new game
    if (lastTick >= 0 && view.tick - lastTick < TICKS_PER_GAME_DAY) return;
    if (lastTick < 0 && view.tick < TICKS_PER_GAME_DAY) return;
    const now = performance.now();
    if (now - lastMs < MIN_REAL_MS) return;
    busy = true;
    lastMs = now;
    ctx.sim.save()
      .then(({ blob, tick }) => {
        lastTick = tick;
        const me = view.players[HUMAN_ID];
        return putSave({ key: 'autosave', blob, tick, day: Math.floor(tick / TICKS_PER_GAME_DAY) + 1, nation: me?.name ?? '', savedAt: Date.now() });
      })
      .catch((err) => console.warn('[autosave] failed', err))
      .finally(() => (busy = false));
  }, 2000);
}
