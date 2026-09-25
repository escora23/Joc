// FRONT ULTRA — world event: hurricane (owner: sim-ai). Worker-only, deterministic.
//
// A tropical cyclone forms in a real basin, strengthens over warm water and tracks across the ocean along a
// realistic path (westward in the trades, recurving poleward and then eastward as it leaves the tropics). Ships
// caught near the eye are battered: transports and freighters sink, warships take heavy damage. At landfall it
// wrecks ports and naval yards on the coast, hurts the garrison, and weakens quickly over land until it
// dissipates. The renderable state carries position, heading, radius and category (1-5) every few ticks.

import { MAP_H, kmhToTilesPerTick } from '../../shared/constants';
import { StructureType, UnitType } from '../../shared/types';
import { dist, emitStage, nearestLand, wrapTile, type ActiveEvent, type EventEnv } from './common';

const SHIP_TYPES: ReadonlySet<number> = new Set([UnitType.TransportShip, UnitType.TradeShip, UnitType.Warship]);

export class Hurricane implements ActiveEvent {
  readonly kind = 'hurricane' as const;
  private t = 0;
  /** 1..5 (Saffir-Simpson), fractional while strengthening / weakening. */
  private category = 1;
  private peak: number;
  private landfall = false;
  /** The `start` news goes out once per storm (mid-life shipping news or landfall, whichever comes first). */
  private startEmitted = false;
  private landTicks = 0;
  private announced = false;
  private announcedTick = -1_000_000;
  private readonly affected = new Set<number>();
  private readonly lifetime: number;
  private readonly speed: number;
  private readonly radius: number;
  private sunk = 0;

  constructor(readonly id: number, private x: number, private y: number, private heading: number, env: EventEnv) {
    const rng = env.rng;
    this.peak = 2.5 + rng.next() * 2.5;
    this.lifetime = 1300 + rng.int(700);
    // Tropical cyclones track at 15-27 km/h (and speed up to ~1.5x once they recurve into the westerlies).
    this.speed = kmhToTilesPerTick(15 + rng.next() * 12);
    this.radius = 11 + rng.next() * 6;
  }

  step(env: EventEnv): boolean {
    const g = env.g;
    const rng = env.rng;
    const t = this.t++;
    if (t === 0) {
      // Warn where people live: the nearest coast to the formation point, else the open ocean.
      const land = nearestLand(g, this.x, this.y, 90);
      const wx = land >= 0 ? (land % 1600) + 0.5 : this.x, wy = land >= 0 ? ((land / 1600) | 0) + 0.5 : this.y;
      emitStage(env, this.id, this.kind, 'warning', wx, wy, this.radius, 1, []);
    }

    // --- track ---------------------------------------------------------------------------------------
    const lat = 90 - (this.y / MAP_H) * 180;
    const north = lat >= 0;
    // Recurvature: beyond ~20 degrees the steering flow turns the storm poleward, then eastward.
    const poleHeading = north ? 0 : Math.PI;
    const absLat = Math.abs(lat);
    let target = this.heading;
    if (absLat > 30) target = north ? 0.9 : Math.PI - 0.9; // north-east / south-east
    else if (absLat > 20) target = poleHeading + (north ? -0.25 : 0.25);
    this.heading += angleDiff(this.heading, target) * (absLat > 20 ? 0.004 : 0.0008);
    this.heading += (rng.next() - 0.5) * 0.01;
    const sp = this.speed * (absLat > 30 ? 1.5 : 1);
    this.x += (Math.sin(this.heading) * sp) / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    this.y -= Math.cos(this.heading) * sp;
    if (this.x < 0) this.x += 1600;
    if (this.x >= 1600) this.x -= 1600;
    this.y = Math.max(5, Math.min(MAP_H - 6, this.y));

    // --- intensity ------------------------------------------------------------------------------------
    const here = wrapTile(this.x, this.y);
    const overLand = here >= 0 && g.isLand(here);
    if (overLand) {
      this.landTicks++;
      this.category = Math.max(0.3, this.category - 0.006);
    } else if (absLat < 28) this.category = Math.min(this.peak, this.category + 0.004);
    else this.category = Math.max(0, this.category - (absLat > 40 ? 0.006 : 0.002)); // cold water kills it

    if (overLand && !this.landfall && this.category >= 1) {
      this.landfall = true;
      this.announced = true;
      this.hitCoast(env, 1);
      if (!this.startEmitted) {
        this.startEmitted = true;
        emitStage(env, this.id, this.kind, 'start', this.x, this.y, this.radius, Math.round(this.category), [...this.affected]);
      }
    }
    // No landfall by mid-life: it is still news when it batters shipping lanes near a coast.
    if (!this.announced && t === Math.round(this.lifetime * 0.45)) {
      const land = nearestLand(g, this.x, this.y, 45);
      if (land >= 0) {
        this.announced = true;
        this.announcedTick = t;
        this.startEmitted = true;
        emitStage(env, this.id, this.kind, 'start', (land % 1600) + 0.5, ((land / 1600) | 0) + 0.5, this.radius, Math.round(this.category), [...this.affected]);
      }
    }

    // --- damage ----------------------------------------------------------------------------------------
    if (t % 8 === 0 && this.category >= 0.8) {
      for (const u of g.unitsNear(this.x, this.y, this.radius)) {
        if (!SHIP_TYPES.has(u.type)) continue;
        const d = dist(this.x, this.y, u.x, u.y) / this.radius;
        const force = (1 - d * 0.7) * this.category / 5;
        if (u.type === UnitType.Warship) {
          g.damageUnit(u.id, 40 + force * 110, 0);
          this.affected.add(u.owner);
        } else if (rng.next() < 0.18 + force * 0.5) {
          g.damageUnit(u.id, 1e6, 0);
          this.affected.add(u.owner);
          this.sunk++;
        }
      }
    }
    if (overLand && this.landTicks % 40 === 0 && this.category >= 1) this.hitCoast(env, 0.4);

    if (t % 4 === 0) {
      g.setWorldEventState(this.id, {
        kind: this.kind, x: this.x, y: this.y, radius: this.radius * (0.7 + 0.3 * Math.min(1, this.category / 3)),
        progress: Math.min(1, t / this.lifetime), magnitude: this.category, players: [...this.affected], heading: this.heading,
      });
    }
    if (t >= this.lifetime || (this.landTicks > 260 && this.category < 0.6) || (t > 200 && this.category < 0.25)) {
      g.setWorldEventState(this.id, null);
      emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, this.sunk, [...this.affected]);
      return false;
    }
    return true;
  }

  /** Storm surge and wind on the coast: ports and naval yards wrecked, casualties. */
  private hitCoast(env: EventEnv, strength: number): void {
    const g = env.g;
    const r = this.radius * 0.85;
    for (const s of g.structuresNear(this.x, this.y, r)) {
      const coastal = s.type === StructureType.Port || s.type === StructureType.NavalYard;
      const p = (coastal ? 0.55 : 0.12) * strength * (this.category / 4);
      if (env.rng.next() < p) {
        g.destroyStructure(s.id, 0);
        this.affected.add(s.owner);
      }
    }
    const seen = new Set<number>();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const t = wrapTile(this.x + Math.cos(a) * r * 0.6, this.y + Math.sin(a) * r * 0.6);
      if (t < 0 || !g.isPlayable(t)) continue;
      const o = g.ownerOf(t);
      if (o <= 0 || seen.has(o)) continue;
      seen.add(o);
      const p = g.player(o);
      if (p) g.addTroops(o, -Math.min(p.troops * 0.04 * strength, 60_000 * strength * this.category));
      this.affected.add(o);
    }
  }
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
