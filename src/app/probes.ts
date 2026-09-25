// FRONT ULTRA — browser measurement probes (W1, DESIGN_V2 §3.5). Debug hooks on window.__front; never used by
// gameplay code. They read what is actually drawn (interpolated render positions), so they measure what the player
// sees, and they clean up the units they stage.
//
//   await __front.speedProbe({ seconds: 8 })   T27b: on-screen km per real second per unit class
//   await __front.motionProbe({ seconds: 10 }) T40: per-unit max / mean per-frame screen displacement
//   __front.clock()                            the clock view (mode, rate, tick period)

import * as THREE from 'three';
import type { GameContext } from '../shared/api';
import { HUMAN_ID, MAP_W, UNIT_DEFS } from '../shared/constants';
import { UNIT_STRIDE } from '../shared/protocol';
import { greatCircleKm, latLonToTile, tileXYToLatLon } from '../shared/geo';
import { StructureType, UnitType, type UnitView } from '../shared/types';

/** v1 on-screen km per real second at 1x (AUDIT-1 §2.1): every surface class must stay at or below it (T27b). */
const V1_LIMIT: Partial<Record<UnitType, number>> = {
  [UnitType.ArmoredDivision]: 82,
  [UnitType.Train]: 317,
  [UnitType.TransportShip]: 253,
  [UnitType.TradeShip]: 184,
  [UnitType.Warship]: 203,
};
const AIR = new Set<UnitType>([UnitType.FighterSquadron, UnitType.Bomber, UnitType.DroneSwarm, UnitType.CruiseMissile]);

interface ProbeRow {
  unit: string;
  kmPerRealSec: number;
  ticksPerSec: number;
  kmPerTick: number;
  /** Scaled to the nominal 10 ticks per real second at 1x (the container's worker may run slow). */
  kmPerSecAt1x: number;
  target: string;
  pass: boolean;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

function renderLatLon(u: UnitView, alpha: number): { lat: number; lon: number } {
  let x = u.prevX + (u.x - u.prevX) * alpha;
  if (x < 0) x += MAP_W;
  else if (x >= MAP_W) x -= MAP_W;
  const y = u.prevY + (u.y - u.prevY) * alpha;
  return tileXYToLatLon(x, y);
}

export function installProbes(ctx: GameContext, target: Record<string, unknown>): void {
  target.clock = () => ({ ...ctx.sim.view.clock, tick: ctx.sim.view.tick, gameHours: ctx.sim.view.gameHours });

  // Arrival log: what the worker sent and when it arrived (independent of the frame rate).
  const arrivals: { at: number; tick: number; ticks: number; mode: string; rate: number; events: { type: string; unitId?: number }[] }[] = [];
  ctx.sim.onArrival = (u, at) => {
    arrivals.push({
      at, tick: u.tick, ticks: u.ticks, mode: u.clock?.mode ?? '', rate: u.clock?.rate ?? 0,
      events: u.events.filter((e) => e.type === 'nukeLaunched' || e.type === 'nukeDetonated' || e.type === 'nukeIntercepted' || e.type === 'clockChanged')
        .map((e) => ({ type: e.type, unitId: 'unitId' in e ? (e as { unitId: number }).unitId : undefined })),
    });
    if (arrivals.length > 4000) arrivals.splice(0, 1000);
  };
  target.arrivals = arrivals;

  /**
   * T28: launch a debug atom bomb (default Madrid -> Paris, by an AI nation) and time the clock from the worker's
   * updates as they arrive: crisis during the flight, flight duration, strategic again after the impact.
   */
  target.crisisProbe = async (opts: { from?: [number, number]; to?: [number, number]; owner?: number; weapon?: number; timeoutSec?: number } = {}) => {
    const from = opts.from ?? [40.42, -3.7], to = opts.to ?? [48.85, 2.35];
    const start = arrivals.length;
    const t0 = performance.now();
    ctx.sim.debug({ type: 'launchNuke', weapon: (opts.weapon ?? UnitType.AtomBomb) as 8, owner: opts.owner ?? 2, fromTile: latLonToTile(...from), targetTile: latLonToTile(...to) });
    let launch = -1, unitId = -1, det = -1, strategic = -1;
    const modesInFlight = new Set<string>();
    while (performance.now() - t0 < (opts.timeoutSec ?? 60) * 1000) {
      await wait(50);
      for (let i = start; i < arrivals.length; i++) {
        const a = arrivals[i];
        for (const e of a.events) {
          if (e.type === 'nukeLaunched' && launch < 0) {
            launch = a.at;
            unitId = e.unitId ?? -1;
          }
          if ((e.type === 'nukeDetonated' || e.type === 'nukeIntercepted') && e.unitId === unitId && det < 0) det = a.at;
        }
        if (launch >= 0 && det < 0 && a.at >= launch) modesInFlight.add(a.mode);
        if (det >= 0 && strategic < 0 && a.at >= det && a.mode === 'strategic') strategic = a.at;
      }
      if (strategic >= 0) break;
    }
    return {
      flightSec: det >= 0 && launch >= 0 ? (det - launch) / 1000 : -1,
      backSec: strategic >= 0 ? (strategic - det) / 1000 : -1,
      modesInFlight: [...modesInFlight],
    };
  };

  /**
   * Stage one unit of each class for the human (a land strip Madrid→Barcelona, an airbase, ships west of Lisbon),
   * then sample the rendered positions every frame for `seconds` real seconds.
   */
  target.speedProbe = async (opts: { seconds?: number; stage?: boolean } = {}) => {
    const view = ctx.sim.view;
    if (view.phase !== 'playing') throw new Error('speedProbe needs a running game');
    const seconds = opts.seconds ?? 8;
    const t = (lat: number, lon: number) => latLonToTile(lat, lon);
    const staged: { type: UnitType; from: [number, number]; to: [number, number] }[] = [
      { type: UnitType.ArmoredDivision, from: [40.42, -3.7], to: [41.39, 2.17] },
      { type: UnitType.Train, from: [40.42, -3.7], to: [41.39, 2.17] },
      { type: UnitType.TransportShip, from: [38.5, -12.0], to: [40.0, -65.0] },
      { type: UnitType.TradeShip, from: [38.0, -13.0], to: [40.0, -65.0] },
      { type: UnitType.Warship, from: [39.0, -13.5], to: [40.0, -65.0] },
      { type: UnitType.FighterSquadron, from: [40.42, -3.7], to: [55.75, 37.6] },
      { type: UnitType.Bomber, from: [40.42, -3.7], to: [55.75, 37.6] },
      { type: UnitType.DroneSwarm, from: [40.42, -3.7], to: [48.85, 2.35] },
      { type: UnitType.CruiseMissile, from: [40.42, -3.7], to: [45.0, 25.0] },
    ];
    const before = new Set(view.units.keys());
    if (opts.stage !== false) {
      ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: t(40.9, -1.2), radius: 22 });
      ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: HUMAN_ID, tile: t(40.42, -3.7), level: 3 });
      for (const s of staged) ctx.sim.debug({ type: 'spawnUnit', unit: s.type, owner: HUMAN_ID, tile: t(...s.from), targetTile: t(...s.to) });
      // Let the spawns reach the client and paths get planned.
      await wait(1200);
    }
    // Sim positions as the updates ARRIVE (the render interpolates between exactly these samples, so the on-screen
    // speed is km per tick × ticks per real second; sampling arrivals keeps a slow renderer from skewing it).
    const probe = new Map<number, { type: UnitType; km: number; ticks: number; last: { lat: number; lon: number } | null }>();
    for (const u of view.units.values()) {
      if (opts.stage !== false && before.has(u.id)) continue;
      if (u.owner !== HUMAN_ID && opts.stage !== false) continue;
      if (!staged.some((s) => s.type === u.type) && !V1_LIMIT[u.type]) continue;
      probe.set(u.id, { type: u.type, km: 0, ticks: 0, last: null });
    }
    const t0 = performance.now();
    let ticks = 0;
    const prevHook = ctx.sim.onArrival;
    const UFX = 3, UFY = 4, STRIDE = UNIT_STRIDE;
    ctx.sim.onArrival = (u, at) => {
      prevHook?.(u, at);
      if (u.ticks <= 0 || u.fullOwners) return;
      ticks += u.ticks;
      const a = u.units;
      for (let o = 0; o < a.length; o += STRIDE) {
        const p = probe.get(a[o]);
        if (!p) continue;
        const ll = tileXYToLatLon(a[o + UFX], a[o + UFY]);
        if (p.last) {
          const d = greatCircleKm(p.last.lat, p.last.lon, ll.lat, ll.lon);
          if (d > 1e-6) {
            p.km += d;
            p.ticks += u.ticks;
          }
        }
        p.last = ll;
      }
    };
    await wait(seconds * 1000);
    ctx.sim.onArrival = prevHook;
    const realSec = (performance.now() - t0) / 1000;
    const ticksPerSec = ticks / realSec;
    // Front depth: the fastest measured offensive (km per game hour = km per real s at 1x).
    let front = 0;
    for (const a of view.attacks) front = Math.max(front, a.advanceKmh ?? 0);
    const rows: ProbeRow[] = [];
    const byType = new Map<UnitType, { km: number; n: number }>();
    for (const p of probe.values()) {
      if (p.ticks === 0) continue;
      const r = byType.get(p.type) ?? { km: 0, n: 0 };
      r.km += p.km;
      r.n += p.ticks;
      byType.set(p.type, r);
    }
    for (const [type, r] of byType) {
      // km per tick while moving; on screen at 1x that is × 10 ticks per real second.
      const kmPerTick = r.n > 0 ? r.km / r.n : 0;
      const kmPerRealSec = kmPerTick * ticksPerSec;
      const at1x = kmPerTick * 10;
      const def = UNIT_DEFS[type];
      const limit = V1_LIMIT[type];
      let target: string, pass: boolean;
      if (AIR.has(type)) {
        target = `${def.speedKmh} ±10 % and <= 600`;
        pass = Math.abs(at1x - def.speedKmh) <= def.speedKmh * 0.1 && at1x <= 600;
      } else {
        target = `<= ${limit ?? '-'} (v1)`;
        pass = limit === undefined || at1x <= limit;
      }
      rows.push({ unit: def.id, kmPerRealSec: +kmPerRealSec.toFixed(1), ticksPerSec: +ticksPerSec.toFixed(2), kmPerTick: +kmPerTick.toFixed(2), kmPerSecAt1x: +at1x.toFixed(1), target, pass });
    }
    rows.push({ unit: 'frontDepth', kmPerRealSec: +(front * ticksPerSec / 10).toFixed(2), ticksPerSec: +ticksPerSec.toFixed(2), kmPerTick: +(front / 10).toFixed(2), kmPerSecAt1x: +front.toFixed(2), target: '<= 8.8', pass: front <= 8.8 });
    if (opts.stage !== false) for (const id of probe.keys()) ctx.sim.debug({ type: 'removeUnit', unitId: id });
    console.table(rows);
    return rows;
  };

  /**
   * T40: for every unit moving on screen, the largest per-frame screen displacement must stay <= 2x its mean over the
   * window. Positions are what the units renderer drew this frame, projected with the strategic camera.
   */
  target.motionProbe = async (opts: { seconds?: number; minMeanPx?: number } = {}) => {
    const seconds = opts.seconds ?? 10;
    const cam = ctx.camera;
    const tmp = new THREE.Vector3();
    const tracks = new Map<number, { last: { x: number; y: number } | null; d: number[]; v: number[]; type: UnitType }>();
    const w = ctx.canvas.clientWidth, h = ctx.canvas.clientHeight;
    const t0 = performance.now();
    let now = t0, frames = 0, prevNow = t0;
    const frameMs: number[] = [];
    while (now - t0 < seconds * 1000) {
      now = await nextFrame();
      const dtMs = Math.max(1, now - prevNow);
      if (frames > 0) frameMs.push(dtMs);
      prevNow = now;
      frames++;
      for (const u of ctx.sim.view.units.values()) {
        if (!ctx.units.getUnitWorldPosition(u.id, tmp)) continue;
        tmp.project(cam);
        if (tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) continue;
        const sx = (tmp.x * 0.5 + 0.5) * w, sy = (0.5 - tmp.y * 0.5) * h;
        let tr = tracks.get(u.id);
        if (!tr) tracks.set(u.id, (tr = { last: null, d: [], v: [], type: u.type }));
        if (tr.last) {
          const d = Math.hypot(sx - tr.last.x, sy - tr.last.y);
          tr.d.push(d);
          tr.v.push((d * 1000) / dtMs);
        }
        tr.last = { x: sx, y: sy };
      }
    }
    // ratio: per-frame displacement (the T40 definition; includes the renderer's frame-time jitter).
    // speedRatio: the same on screen velocity (px per real second): the interpolation's own smoothness.
    const out: { id: number; unit: string; frames: number; meanPx: number; maxPx: number; ratio: number; speedRatio: number; pass: boolean }[] = [];
    const minMean = opts.minMeanPx ?? 0.05;
    for (const [id, tr] of tracks) {
      if (tr.d.length < frames * 0.5) continue;
      const mean = tr.d.reduce((a, b) => a + b, 0) / tr.d.length;
      if (mean < minMean) continue;
      const max = Math.max(...tr.d);
      const vMean = tr.v.reduce((a, b) => a + b, 0) / tr.v.length;
      const vMax = Math.max(...tr.v);
      out.push({ id, unit: UNIT_DEFS[tr.type].id, frames: tr.d.length, meanPx: +mean.toFixed(2), maxPx: +max.toFixed(2), ratio: +(max / mean).toFixed(2), speedRatio: +(vMax / Math.max(1e-9, vMean)).toFixed(2), pass: max <= 2 * mean });
    }
    console.table(out);
    frameMs.sort((a, b) => a - b);
    const frameStats = { p50: frameMs[frameMs.length >> 1] ?? 0, p90: frameMs[Math.floor(frameMs.length * 0.9)] ?? 0, max: frameMs[frameMs.length - 1] ?? 0 };
    return { frames, frameMs: frameStats, seconds: (performance.now() - t0) / 1000, clock: { ...ctx.sim.view.clock }, units: out, pass: out.every((r) => r.pass) };
  };
}
