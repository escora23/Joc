// FRONT ULTRA — strategic weapons: silos & launches, ballistic flight (great-circle arcs), MIRV bus separation,
// SAM interception, cruise missiles, naval shells, air-strike payloads, nuclear detonations, fallout and scars.
// Owner: sim-core. Worker-only. Deterministic (rngCombat).

import { BALANCE, HUMAN_ID, MAP_H, MAP_W, NUKE_DEFS, TILE_COUNT, TILE_KM, UNIT_DEFS, ballisticFlightTicks, kmhToKmPerTick } from '../shared/constants';
import type { NukeWeapon } from '../shared/protocol';
import { StructureType, UnitState, UnitType, type WeaponType } from '../shared/types';
import {
  CIVILIANS_PER_CITY_LEVEL, CRUISE_RANGE, INTERCEPT_WEAPON_MUL, MIRV_SPLIT_T, MIRV_SPREAD, MIRV_WARHEADS,
  NUKE_ALLY_BREAK_TILES, SAM_COOLDOWN_TICKS, SILO_COOLDOWN_TICKS, TERMINAL_PHASE_T, WARSHIP_SHELL_DAMAGE, samRange,
} from './balance';
import type { Game } from './game';
import { Mode, Player, Structure, Unit } from './state';
import { advanceKm, dist2, distKm, surfDist2, wdx, wrapXf } from './spatial';

export interface Scar {
  id: number;
  x: number;
  y: number;
  /** Outer radius in equatorial tile units. */
  radius: number;
  weapon: UnitType;
  tick: number;
  until: number;
}

const BALLISTIC = new Set<number>([UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.Mirv, UnitType.MirvWarhead]);
const CRUISE_KM_PER_TICK = kmhToKmPerTick(UNIT_DEFS[UnitType.CruiseMissile].speedKmh);
const DEG = Math.PI / 180;

export class WeaponSystem {
  private readonly threats: Unit[] = [];
  /** SAM engagements per target this tick (a salvo spreads over at most 2-3 launchers per target). */
  private readonly engagedThisTick = new Map<number, number>();
  private falloutStamp: Uint32Array;
  private falloutGen = 1;

  constructor(private readonly g: Game) {
    this.falloutStamp = new Uint32Array(TILE_COUNT);
  }

  // =================================================================================================
  // Launch
  // =================================================================================================
  launchCommand(p: Player, weapon: WeaponType, targetTile: number, siloId: number): boolean {
    const g = this.g;
    if (g.phase !== 'playing' || !p.spawned) return false;
    if (weapon !== UnitType.AtomBomb && weapon !== UnitType.HydrogenBomb && weapon !== UnitType.Mirv && weapon !== UnitType.CruiseMissile) return false;
    if (!g.config.nukes && weapon !== UnitType.CruiseMissile) {
      g.message(p.id, 'msg.nukesDisabled');
      return false;
    }
    if (targetTile < 0 || targetTile >= TILE_COUNT) return false;
    const to = g.owner[targetTile];
    if (to === p.id) {
      g.message(p.id, 'msg.invalidTarget');
      return false;
    }
    if (to !== 0 && g.isAllied(p.id, to)) {
      g.message(p.id, 'msg.cannotNukeAlly');
      return false;
    }
    const tx = (targetTile % MAP_W) + 0.5, ty = ((targetTile / MAP_W) | 0) + 0.5;
    let silo: Structure | undefined;
    let anySilo = false;
    if (siloId >= 0) {
      const s = g.structureMap.get(siloId);
      if (s && s.owner === p.id && s.type === StructureType.MissileSilo) {
        anySilo = true;
        if (s.operational && s.cooldownTicks <= 0) silo = s;
      }
    } else {
      let bestD = Infinity;
      for (const s of g.structByOwner.get(p.id) ?? []) {
        if (s.type !== StructureType.MissileSilo) continue;
        anySilo = true;
        if (!s.operational || s.cooldownTicks > 0) continue;
        const d = dist2(s.x, s.y, tx, ty);
        if (weapon === UnitType.CruiseMissile && d > CRUISE_RANGE * CRUISE_RANGE) continue;
        if (d < bestD) {
          bestD = d;
          silo = s;
        }
      }
    }
    if (!silo) {
      g.message(p.id, anySilo ? 'msg.siloCooldown' : 'msg.noSilo');
      return false;
    }
    if (weapon === UnitType.CruiseMissile && dist2(silo.x, silo.y, tx, ty) > CRUISE_RANGE * CRUISE_RANGE) {
      g.message(p.id, 'msg.outOfRange');
      return false;
    }
    const cost = g.unitCost(p.id, weapon);
    if (p.gold < cost) {
      g.message(p.id, 'msg.notEnoughGold');
      return false;
    }
    p.gold -= cost;
    p.stats.goldSpent += cost;
    const cd = SILO_COOLDOWN_TICKS / silo.level;
    silo.cooldownTicks = Math.round(weapon === UnitType.HydrogenBomb ? cd * 1.5 : weapon === UnitType.Mirv ? cd * 2.5 : weapon === UnitType.CruiseMissile ? cd * 0.5 : cd);
    g.structuresDirty = true;
    if (weapon === UnitType.Mirv) p.mirvsLaunched++;
    this.launch(p.id, weapon, silo.tile, targetTile, silo.id);
    return true;
  }

  /** Create the missile and put it in flight (no cost / silo checks: shots & debug use this directly). */
  launch(owner: number, weapon: NukeWeapon, fromTile: number, targetTile: number, siloId: number): Unit | null {
    const g = this.g;
    if (fromTile < 0 || fromTile >= TILE_COUNT || targetTile < 0 || targetTile >= TILE_COUNT) return null;
    const p = g.playerById[owner];
    const fx = (fromTile % MAP_W) + 0.5, fy = ((fromTile / MAP_W) | 0) + 0.5;
    const tx = (targetTile % MAP_W) + 0.5, ty = ((targetTile / MAP_W) | 0) + 0.5;
    const u = g.unitSys.spawn(weapon, owner, fx, fy);
    u.home = siloId;
    u.targetTile = targetTile;
    u.targetPlayer = g.owner[targetTile];
    u.fromX = fx;
    u.fromY = fy;
    u.toX = tx;
    u.toY = ty;
    u.state = UnitState.Launching;
    if (weapon === UnitType.CruiseMissile) {
      // Terrain-following waypoint route at the 600 km/h mission average (§2.3).
      u.mode = Mode.Cruise;
      u.alt = 0.05;
      u.flightTicks = Math.max(1, Math.ceil(distKm(fx, fy, tx, ty) / CRUISE_KM_PER_TICK));
    } else {
      // Minimum-energy ballistic trajectory: 8..35 game minutes, flown in crisis time (§2.2, §2.3).
      u.mode = Mode.Ballistic;
      u.flightTicks = ballisticFlightTicks(greatCircleTiles(fx, fy, tx, ty) * TILE_KM);
    }
    u.t = 0;
    if (p) p.stats.nukesLaunched += weapon === UnitType.CruiseMissile ? 0 : 1;
    if (u.targetPlayer > 0) g.attacks.onHostileAct(owner, u.targetPlayer);
    g.emit({
      type: 'nukeLaunched', tick: g.tick, unitId: u.id, weapon, owner, fromTile, targetTile, targetOwner: u.targetPlayer,
      flightTicks: u.flightTicks,
    });
    if (u.targetPlayer === HUMAN_ID && weapon !== UnitType.CruiseMissile) g.message(HUMAN_ID, 'msg.nukeInbound', 'danger', { weapon });
    return u;
  }

  /** Generic straight projectile (shells, staged interceptors). */
  initProjectile(u: Unit, tx: number, ty: number, speed: number): void {
    u.fromX = u.x;
    u.fromY = u.y;
    u.toX = tx;
    u.toY = ty;
    u.t = 0;
    u.flightTicks = Math.max(2, Math.ceil(Math.sqrt(dist2(u.x, u.y, tx, ty)) / speed));
    u.state = UnitState.InFlight;
    u.alt = 0.2;
  }

  // =================================================================================================
  // Flight
  // =================================================================================================
  stepProjectile(u: Unit): void {
    switch (u.type) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.Mirv:
      case UnitType.MirvWarhead:
        this.stepBallistic(u);
        return;
      case UnitType.CruiseMissile:
        this.stepCruise(u);
        return;
      case UnitType.SamInterceptor:
        this.stepInterceptor(u);
        return;
      case UnitType.Shell:
        this.stepShell(u);
        return;
    }
  }

  private stepBallistic(u: Unit): void {
    u.t = Math.min(1, u.t + 1 / u.flightTicks);
    const px = u.x, py = u.y;
    slerpTiles(u.fromX, u.fromY, u.toX, u.toY, u.t, u);
    const dx = wdx(px, u.x), dy = u.y - py;
    if (dx * dx + dy * dy > 1e-8) u.heading = Math.atan2(dx, -dy);
    if (u.type === UnitType.MirvWarhead) {
      // Re-entry vehicles only descend.
      u.alt = u.aux2From * Math.cos((u.t * Math.PI) / 2) + 0.0001;
    } else {
      u.alt = Math.sin(Math.PI * u.t);
    }
    u.state = u.t < 0.06 ? UnitState.Launching : UnitState.InFlight;
    if (u.type === UnitType.Mirv && u.t >= MIRV_SPLIT_T) {
      this.splitMirv(u);
      return;
    }
    if (u.t >= 1) this.detonate(u);
  }

  private stepCruise(u: Unit): void {
    u.t = Math.min(1, u.t + 1 / u.flightTicks);
    u.state = UnitState.InFlight;
    const d = distKm(u.x, u.y, u.toX, u.toY) / TILE_KM;
    // Sea-skimming: climb out, cruise low, pop up before the dive.
    u.alt = d < 3 ? 0.25 * (d / 3) + 0.02 : Math.min(0.12, u.alt + 0.02);
    if (advanceKm(u, u.toX, u.toY, CRUISE_KM_PER_TICK)) this.detonate(u);
  }

  private splitMirv(bus: Unit): void {
    const g = this.g;
    const rng = g.rngCombat;
    const victim = bus.targetPlayer;
    const cx = bus.toX, cy = bus.toY;
    const picks: number[] = [];
    const minSep2 = 8 * 8;
    const far = (t: number) => {
      const x = (t % MAP_W) + 0.5, y = ((t / MAP_W) | 0) + 0.5;
      for (const q of picks) if (dist2(x, y, (q % MAP_W) + 0.5, ((q / MAP_W) | 0) + 0.5) < minSep2) return false;
      return true;
    };
    // Strategic targets first: the victim's structures near the aim point.
    if (victim > 0) {
      const structs = (g.structByOwner.get(victim) ?? []).filter((s) => dist2(s.x, s.y, cx, cy) <= MIRV_SPREAD * MIRV_SPREAD);
      structs.sort((a, b) => b.level - a.level || a.id - b.id);
      for (const s of structs) {
        if (picks.length >= Math.ceil(MIRV_WARHEADS / 2)) break;
        if (far(s.tile)) picks.push(s.tile);
      }
    }
    // Then a spread over the victim's land around the aim point.
    let guard = 0;
    while (picks.length < MIRV_WARHEADS && guard++ < 1500) {
      const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * MIRV_SPREAD;
      const y = Math.floor(cy + Math.sin(a) * r);
      if (y < 0 || y >= MAP_H) continue;
      const t = y * MAP_W + ((Math.floor(cx + Math.cos(a) * r / Math.max(0.3, Math.cos((90 - (y / MAP_H) * 180) * DEG))) % MAP_W) + MAP_W) % MAP_W;
      if (!g.playable[t]) continue;
      const o = g.owner[t];
      // Never on the launcher or its allies; the victim's land first, then anyone else's nearby.
      if (o === bus.owner || (o !== 0 && g.isAllied(bus.owner, o))) continue;
      if (victim > 0 && o !== victim && guard < 1000) continue;
      if (far(t)) picks.push(t);
    }
    if (picks.length === 0) picks.push(bus.targetTile);
    for (const t of picks) {
      const w = g.unitSys.spawn(UnitType.MirvWarhead, bus.owner, bus.x, bus.y, false);
      w.mode = Mode.Ballistic;
      w.targetTile = t;
      w.targetPlayer = g.owner[t];
      w.fromX = bus.x;
      w.fromY = bus.y;
      w.toX = (t % MAP_W) + 0.5;
      w.toY = ((t / MAP_W) | 0) + 0.5;
      w.originX = bus.originX;
      w.originY = bus.originY;
      w.aux2From = Math.max(0.3, bus.alt);
      w.alt = w.aux2From;
      w.t = 0;
      // Re-entry vehicles arrive with the rest of the bus's flight (plus a little dispersion in time).
      w.flightTicks = Math.max(1, Math.ceil((1 - bus.t) * bus.flightTicks) + (rng.next() < 0.3 ? 1 : 0));
      w.state = UnitState.InFlight;
      g.emit({ type: 'unitSpawned', tick: g.tick, unitId: w.id, unit: w.type, owner: w.owner, x: w.x, y: w.y });
    }
    g.unitSys.remove(bus, false);
  }

  // =================================================================================================
  // SAM sites
  // =================================================================================================
  step(): void {
    const g = this.g;
    // Collect airborne threats once per tick.
    const threats = this.threats;
    threats.length = 0;
    this.engagedThisTick.clear();
    for (const u of g.unitMap.values()) {
      if (u.dead) continue;
      switch (u.type) {
        case UnitType.AtomBomb:
        case UnitType.HydrogenBomb:
        case UnitType.Mirv:
        case UnitType.MirvWarhead:
          if (u.t >= TERMINAL_PHASE_T) threats.push(u);
          break;
        case UnitType.CruiseMissile:
          threats.push(u);
          break;
        case UnitType.Bomber:
        case UnitType.DroneSwarm:
        case UnitType.FighterSquadron:
          if (u.mode === Mode.Strike || u.mode === Mode.Intercept || u.mode === Mode.Cap) threats.push(u);
          break;
      }
    }
    // Silo & SAM cooldowns.
    for (const s of g.structureMap.values()) {
      if (s.cooldownTicks > 0) {
        s.cooldownTicks--;
        if (s.cooldownTicks % 10 === 0) g.structuresDirty = true;
        if (s.cooldownTicks === 0 && s.type === StructureType.SamSite) s.timer = 0;
      }
    }
    if (threats.length === 0) return;
    for (const s of g.structureMap.values()) {
      if (s.type !== StructureType.SamSite || !s.operational || s.cooldownTicks > 0) continue;
      this.samEngage(s, threats);
    }
  }

  private samEngage(s: Structure, threats: Unit[]): void {
    const g = this.g;
    const radar = g.economy.radarCovers(s.owner, s.x, s.y);
    const range = samRange(s.level, radar);
    const r2 = range * range;
    let best: Unit | null = null, bestScore = Infinity;
    for (const u of threats) {
      if (u.dead || u.owner === s.owner || g.isAllied(s.owner, u.owner)) continue;
      const maxEngaged = u.type === UnitType.HydrogenBomb || u.type === UnitType.Mirv ? 3 : 2;
      if ((this.engagedThisTick.get(u.id) ?? 0) >= maxEngaged) continue;
      const aimD2 = dist2(s.x, s.y, u.toX, u.toY);
      const posD2 = dist2(s.x, s.y, u.x, u.y);
      let score: number;
      if (BALLISTIC.has(u.type)) {
        // Defend the area: warheads falling inside our umbrella.
        if (aimD2 > r2) continue;
        score = (1 - u.t) * 100 + (u.type === UnitType.HydrogenBomb ? -50 : 0);
      } else {
        if (posD2 > r2) continue;
        const tgt = g.owner[u.targetTile] ?? 0;
        if (!(g.isHostile(s.owner, u.owner) || tgt === s.owner || g.isAllied(s.owner, tgt))) continue;
        score = 200 + posD2 * 0.01 + (u.type === UnitType.FighterSquadron ? 100 : 0);
      }
      if (score < bestScore) {
        bestScore = score;
        best = u;
      }
    }
    if (!best) return;
    this.fireInterceptor(s, best, radar);
    s.timer++;
    if (s.timer >= s.level) {
      s.cooldownTicks = SAM_COOLDOWN_TICKS;
      g.structuresDirty = true;
    }
  }

  /**
   * v2 (§2.3): a Mach 4 interceptor covers the SAM's range within the tick, so the engagement resolves on the tick:
   * the hit is rolled now and the kill applied now. The 'combat' event carries the streak the renderer draws for at
   * least MIN_VISUAL_SAM_SEC real seconds (it carries no sim state).
   */
  private fireInterceptor(s: Structure, target: Unit, radar: boolean): void {
    const g = this.g;
    const mul = INTERCEPT_WEAPON_MUL[target.type] ?? 0.7;
    const chance = Math.min(0.95, BALANCE.samInterceptChance * mul + (radar ? 0.1 : 0) + 0.04 * (s.level - 1));
    const hit = g.rngCombat.next() < chance;
    this.engagedThisTick.set(target.id, (this.engagedThisTick.get(target.id) ?? 0) + 1);
    g.emit({ type: 'combat', tick: g.tick, kind: 'sam', owner: s.owner, fromX: s.x, fromY: s.y, toX: target.x, toY: target.y, hit });
    if (hit) this.intercept(target, s.owner, true);
  }

  private stepInterceptor(u: Unit): void {
    const g = this.g;
    const target = g.unitMap.get(u.targetUnit);
    u.t += 1 / u.flightTicks;
    u.state = UnitState.InFlight;
    const speed = UNIT_DEFS[UnitType.SamInterceptor].speed;
    // Guided: home on the live target, climbing to its altitude.
    if (target && !target.dead && !BALLISTIC.has(target.type)) {
      u.toX = target.x;
      u.toY = target.y;
    }
    const tAlt = target && !target.dead ? target.alt : u.alt;
    u.alt += (tAlt - u.alt) * 0.35;
    const dx = wdx(u.x, u.toX), dy = u.toY - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-6) u.heading = Math.atan2(dx, -dy);
    if (d <= speed || u.t >= 1.3) {
      u.x = wrapXf(u.toX);
      u.y = u.toY;
      if (target && !target.dead) {
        target.engagedBy = Math.max(0, target.engagedBy - 1);
        const close = dist2(u.x, u.y, target.x, target.y) < 9;
        if (u.aux === 1 && close) this.intercept(target, u.owner, true);
      }
      g.unitSys.remove(u, true, 0);
      return;
    }
    u.x = wrapXf(u.x + (dx / d) * speed);
    u.y += (dy / d) * speed;
  }

  /** A missile / aircraft is shot down. */
  intercept(target: Unit, by: number, bySam: boolean): void {
    const g = this.g;
    if (target.dead) return;
    const k = g.playerById[by];
    if (target.type === UnitType.AtomBomb || target.type === UnitType.HydrogenBomb || target.type === UnitType.Mirv
      || target.type === UnitType.MirvWarhead || target.type === UnitType.CruiseMissile) {
      if (k && target.type !== UnitType.CruiseMissile) k.stats.nukesIntercepted++;
      g.emit({ type: 'nukeIntercepted', tick: g.tick, unitId: target.id, weapon: target.type as NukeWeapon, owner: target.owner, by, x: target.x, y: target.y });
      g.unitSys.remove(target, true, by);
      if (by === HUMAN_ID && bySam) g.message(HUMAN_ID, 'msg.nukeIntercepted', 'info');
    } else {
      g.unitSys.kill(target, by);
    }
  }

  // =================================================================================================
  // Shells & air strikes
  // =================================================================================================
  /**
   * Naval gun salvo at a unit. v2: the shell's flight (well under a tick) resolves on the tick; the 'combat' event is
   * the tracer the renderer draws for at least MIN_VISUAL_PROJECTILE_SEC.
   */
  fireShell(owner: number, x: number, y: number, target: Unit, damage: number): void {
    const g = this.g;
    const dmg = damage > 0 ? damage : WARSHIP_SHELL_DAMAGE * (0.8 + g.rngCombat.next() * 0.4);
    const hitChance = target.type === UnitType.TransportShip ? 0.8 : 0.7;
    const hit = g.rngCombat.next() < hitChance;
    g.markHostile(owner, target.owner);
    g.emit({ type: 'combat', tick: g.tick, kind: 'shell', owner, fromX: x, fromY: y, toX: target.x, toY: target.y, hit });
    if (hit) g.unitSys.damage(target, dmg, owner);
  }

  /** Shore bombardment of a land point (troops and structures of `victim`), resolved on the tick. */
  fireShellAt(owner: number, x: number, y: number, tx: number, ty: number, victim: number): void {
    const g = this.g;
    g.markHostile(owner, victim);
    g.emit({ type: 'combat', tick: g.tick, kind: 'artillery', owner, fromX: x, fromY: y, toX: tx, toY: ty, hit: true });
    const v = g.playerById[victim];
    if (v && v.alive) {
      const killed = Math.min(v.troops, 250 + v.troops * 0.0025);
      v.troops -= killed;
      v.stats.troopsLost += killed;
      const k = g.playerById[owner];
      if (k) k.stats.troopsKilled += killed;
    }
    g.structGrid.query(tx, ty, 1.6, (st) => {
      if (st.owner === victim) this.damageStructure(st, 0.12, owner);
    });
  }

  private stepShell(u: Unit): void {
    const g = this.g;
    u.t += 1 / u.flightTicks;
    const px = u.x, py = u.y;
    u.x = wrapXf(u.fromX + wdx(u.fromX, u.toX) * Math.min(1, u.t));
    u.y = u.fromY + (u.toY - u.fromY) * Math.min(1, u.t);
    u.alt = 0.25 * Math.sin(Math.PI * Math.min(1, u.t));
    u.heading = Math.atan2(wdx(px, u.x), -(u.y - py));
    u.state = UnitState.InFlight;
    if (u.t < 1) return;
    if (u.targetUnit) {
      const t = g.unitMap.get(u.targetUnit);
      if (t && !t.dead && u.aux === 1 && dist2(t.x, t.y, u.toX, u.toY) < 16) g.unitSys.damage(t, u.cargo, u.owner);
    } else if (u.targetPlayer > 0) {
      // Land impact: kill troops, damage structures nearby.
      const victim = g.playerById[u.targetPlayer];
      if (victim && victim.alive) {
        const killed = Math.min(victim.troops, 250 + victim.troops * 0.0025);
        victim.troops -= killed;
        victim.stats.troopsLost += killed;
        const k = g.playerById[u.owner];
        if (k) k.stats.troopsKilled += killed;
      }
      g.structGrid.query(u.toX, u.toY, 1.6, (s) => {
        if (s.owner === u.targetPlayer) this.damageStructure(s, 0.12, u.owner);
      });
    }
    g.unitSys.remove(u, false);
  }

  /** Payload delivered by a bomber ('bomb'), a drone swarm ('drone') or a fighter strafing run ('strafe'). */
  airStrikeImpact(u: Unit, kind: 'bomb' | 'drone' | 'strafe'): void {
    const g = this.g;
    const radius = kind === 'bomb' ? 2.6 : kind === 'drone' ? 1.6 : 2.0;
    const structDmg = kind === 'bomb' ? 0.55 : kind === 'drone' ? 0.38 : 0;
    const unitDmg = kind === 'bomb' ? 340 : kind === 'drone' ? 230 : 140;
    const tile = Math.floor(u.toY) * MAP_W + Math.floor(u.toX);
    const victimId = tile >= 0 && tile < TILE_COUNT ? g.owner[tile] : 0;
    // Visual salvo.
    const shots = kind === 'bomb' ? 4 : kind === 'drone' ? 3 : 2;
    for (let i = 0; i < shots; i++) {
      const ox = (g.rngCombat.next() - 0.5) * radius * 1.4, oy = (g.rngCombat.next() - 0.5) * radius * 1.4;
      g.emit({ type: 'combat', tick: g.tick, kind: kind === 'strafe' ? 'strafe' : 'bomb', owner: u.owner, fromX: u.x, fromY: u.y, toX: wrapXf(u.toX + ox), toY: u.toY + oy, hit: true });
    }
    if (structDmg > 0) {
      // The structure nearest to the aim point takes a direct hit (a bomber sortie levels it), the rest splash damage.
      let direct: Structure | null = null, bestD = 2.25;
      g.structGrid.query(u.toX, u.toY, 1.5, (s, d2) => {
        if (s.owner !== u.owner && !g.isAllied(u.owner, s.owner) && d2 < bestD) {
          bestD = d2;
          direct = s;
        }
      });
      const directDmg = kind === 'bomb' ? 1.1 : 0.6;
      g.structGrid.query(u.toX, u.toY, radius, (s) => {
        if (s.owner !== u.owner && !g.isAllied(u.owner, s.owner)) this.damageStructure(s, s === direct ? directDmg : structDmg, u.owner);
      });
    }
    g.unitGrid.query(u.toX, u.toY, radius, (o) => {
      if (o.dead || o.owner === u.owner || g.isAllied(u.owner, o.owner)) return;
      if (o.type === UnitType.ArmoredDivision || o.type === UnitType.Warship || o.type === UnitType.TransportShip
        || o.type === UnitType.TradeShip || o.type === UnitType.Train || (UNIT_DEFS[o.type].airborne && o.mode === Mode.Docked)) {
        g.unitSys.damage(o, unitDmg, u.owner);
      }
    });
    const victim = g.playerById[victimId];
    if (victim && victim.alive && !g.isAllied(u.owner, victimId) && victimId !== u.owner) {
      const density = victim.tiles > 0 ? victim.troops / victim.tiles : 0;
      const frac = kind === 'bomb' ? 0.03 : kind === 'drone' ? 0.012 : 0.01;
      const cap = kind === 'bomb' ? 40_000 : kind === 'drone' ? 14_000 : 9_000;
      const killed = Math.min(victim.troops, Math.min(cap, victim.troops * frac + density * 6));
      victim.troops -= killed;
      victim.stats.troopsLost += killed;
      const k = g.playerById[u.owner];
      if (k) k.stats.troopsKilled += killed;
      victim.civilians = Math.max(0, victim.civilians - killed * 2);
      g.markHostile(u.owner, victimId);
    }
  }

  damageStructure(s: Structure, amount: number, by: number): void {
    const g = this.g;
    if (!g.structureMap.has(s.id)) return;
    s.hp -= amount;
    s.lastDamageTick = g.tick;
    g.structuresDirty = true;
    if (by > 0 && by !== s.owner) g.markHostile(by, s.owner);
    if (s.hp <= 0) g.economy.destroyStructure(s, by);
  }

  // =================================================================================================
  // Detonation
  // =================================================================================================
  private detonate(u: Unit): void {
    const g = this.g;
    const weapon = u.type as NukeWeapon;
    const def = NUKE_DEFS[weapon];
    const cx = u.toX, cy = u.toY;
    const tile = Math.floor(cy) * MAP_W + Math.floor(cx);
    const inner = def.innerRadius, outer = def.outerRadius;
    const isNuke = weapon !== UnitType.CruiseMissile;
    const rng = g.rngCombat;
    const hits = new Map<number, number>();
    const before = new Map<number, number>();
    const civBefore = new Map<number, number>();
    const tick = g.tick;
    const falloutEnd = tick + def.falloutTicks;
    // Tiles (surface-true circle: x shrinks with latitude).
    const cosLat = Math.max(0.12, Math.cos((90 - (cy / MAP_H) * 180) * DEG));
    const rx = Math.ceil(outer / cosLat), ry = Math.ceil(outer);
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const inner2 = inner * inner, outer2 = outer * outer;
    const ph1 = rng.next() * 6.283, ph2 = rng.next() * 6.283, ph3 = rng.next() * 6.283;
    for (let dy = -ry; dy <= ry; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= MAP_H) continue;
      for (let dx = -rx; dx <= rx; dx++) {
        const t = y * MAP_W + ((x0 + dx + MAP_W) % MAP_W);
        const d2 = surfDist2(cx, cy, (t % MAP_W) + 0.5, y + 0.5);
        if (d2 > outer2 || !g.playable[t]) continue;
        const o = g.owner[t];
        const innerHit = d2 <= inner2;
        const w = innerHit ? 1 : 0.5;
        if (o > 0) {
          if (!before.has(o)) {
            const p = g.playerById[o]!;
            before.set(o, p.tiles);
            civBefore.set(o, p.civilians);
          }
          hits.set(o, (hits.get(o) ?? 0) + w);
        }
        if (!isNuke) continue;
        // The crater edge is ragged but contiguous: a low-frequency noisy radius between inner and outer.
        let destroy = innerHit;
        if (!destroy) {
          const ang = Math.atan2(y + 0.5 - cy, wdx(cx, (t % MAP_W) + 0.5));
          const n = 0.5 + 0.22 * Math.sin(ang * 3 + ph1) + 0.16 * Math.sin(ang * 5 + ph2) + 0.12 * Math.sin(ang * 9 + ph3);
          destroy = Math.sqrt(d2) < inner + (outer - inner) * 0.55 * n;
        }
        const until = innerHit ? falloutEnd : tick + Math.round(def.falloutTicks * 0.55);
        if (destroy && o !== 0) g.setOwner(t, 0);
        if (g.falloutUntil[t] < until) {
          const wasClean = g.falloutUntil[t] <= tick;
          g.falloutUntil[t] = until;
          const no = g.owner[t];
          if (wasClean && no > 0) g.playerById[no]!.falloutTiles++;
        }
      }
    }
    // Casualties per affected nation.
    let casualties = 0;
    const attacker = g.playerById[u.owner];
    for (const [o, h] of hits) {
      const p = g.playerById[o];
      if (!p || !p.alive) continue;
      const tilesBefore = Math.max(1, before.get(o) ?? p.tiles);
      const frac = def.troopLoss * (1 - Math.exp((-5 * h) / tilesBefore)) + (isNuke ? 0.02 : 0);
      const killed = p.troops * Math.min(0.95, frac);
      p.troops -= killed;
      p.stats.troopsLost += killed;
      if (attacker && o !== u.owner) attacker.stats.troopsKilled += killed;
      for (const a of g.attackList) {
        if (a.attacker === o && !a.ended) {
          const k = a.troops * Math.min(0.9, frac * 0.8);
          a.troops -= k;
          p.stats.troopsLost += k;
        }
      }
      const civ = civBefore.get(o) ?? p.civilians;
      const civKilled = isNuke ? Math.min(civ * 0.9, civ * Math.min(1, (h / tilesBefore) * 2.2)) : 0;
      p.civilians = Math.max(0, p.civilians - civKilled);
      casualties += killed + civKilled;
      if (o !== u.owner) {
        g.markHostile(u.owner, o);
        if (g.isAllied(u.owner, o) && h > NUKE_ALLY_BREAK_TILES) g.diplomacy.breakAlliance(g.playerById[u.owner]!, o);
      }
    }
    // Structures.
    g.structGrid.query(cx, cy, outer / cosLat, (s) => {
      const d2 = surfDist2(cx, cy, s.x, s.y);
      if (d2 > outer2) return;
      if (!isNuke) {
        // Cruise missile: precision kill of the structure at the aim point, damage around it.
        if (d2 <= 2.25) this.damageStructure(s, 1.2, u.owner);
        else if (d2 <= inner2) this.damageStructure(s, 0.4, u.owner);
        return;
      }
      if (s.type === StructureType.City && s.owner > 0) {
        const p = g.playerById[s.owner];
        if (p) {
          const civ = Math.min(p.civilians, CIVILIANS_PER_CITY_LEVEL * s.level * (d2 <= inner2 ? 0.8 : 0.3));
          p.civilians -= civ;
          casualties += civ;
        }
      }
      if (d2 <= inner2) g.economy.destroyStructure(s, u.owner);
      else this.damageStructure(s, 1.3 * (1 - (Math.sqrt(d2) - inner) / Math.max(1, outer - inner)) + 0.2, u.owner);
    });
    // Units caught in the blast (not missiles in flight).
    const victims: Unit[] = [];
    g.unitGrid.query(cx, cy, outer / cosLat, (o) => {
      if (o.dead || o === u) return;
      if (o.type === UnitType.AtomBomb || o.type === UnitType.HydrogenBomb || o.type === UnitType.Mirv
        || o.type === UnitType.MirvWarhead || o.type === UnitType.CruiseMissile || o.type === UnitType.SamInterceptor) return;
      const d2 = surfDist2(cx, cy, o.x, o.y);
      if (d2 > (isNuke ? outer2 : inner2)) return;
      if (UNIT_DEFS[o.type].airborne && o.alt > 0.5 && d2 > inner2) return;
      victims.push(o);
    });
    for (const o of victims) {
      if (isNuke) g.unitSys.kill(o, u.owner);
      else g.unitSys.damage(o, 400, u.owner);
    }
    if (isNuke && def.falloutTicks > 0) {
      g.scars.push({ id: u.id, x: cx, y: cy, radius: outer, weapon, tick, until: falloutEnd });
      g.scarsDirty = true;
    }
    g.emit({
      type: 'nukeDetonated', tick, unitId: u.id, weapon, owner: u.owner, tile, x: cx, y: cy, innerRadius: inner,
      outerRadius: outer, targetOwner: tile >= 0 && tile < TILE_COUNT ? (u.targetPlayer > 0 ? u.targetPlayer : g.owner[tile]) : 0,
      casualties: Math.round(casualties),
    });
    if (isNuke && hits.has(HUMAN_ID) && u.owner !== HUMAN_ID) g.message(HUMAN_ID, 'msg.nukeHit', 'danger', { weapon });
    g.unitSys.remove(u, false);
  }

  /** Recount fallout tiles per player and retire expired scars (every ~50 ticks). */
  maintainFallout(): void {
    const g = this.g;
    if (g.scars.length === 0) return;
    const tick = g.tick;
    for (let i = g.scars.length - 1; i >= 0; i--) {
      if (g.scars[i].until <= tick) {
        g.scars.splice(i, 1);
        g.scarsDirty = true;
      }
    }
    for (const p of g.playerArr) p.falloutTiles = 0;
    const gen = ++this.falloutGen;
    const stamp = this.falloutStamp;
    for (const s of g.scars) {
      const cosLat = Math.max(0.12, Math.cos((90 - (s.y / MAP_H) * 180) * DEG));
      const rx = Math.ceil(s.radius / cosLat), ry = Math.ceil(s.radius);
      const x0 = Math.floor(s.x), y0 = Math.floor(s.y);
      for (let dy = -ry; dy <= ry; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= MAP_H) continue;
        for (let dx = -rx; dx <= rx; dx++) {
          const t = y * MAP_W + ((x0 + dx + MAP_W) % MAP_W);
          if (stamp[t] === gen) continue;
          stamp[t] = gen;
          if (g.falloutUntil[t] <= tick) continue;
          const o = g.owner[t];
          if (o > 0) g.playerById[o]!.falloutTiles++;
        }
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Great-circle helpers in tile space
// -------------------------------------------------------------------------------------------------

function toVec(x: number, y: number, out: number[]): void {
  const lon = (x / MAP_W) * 2 * Math.PI - Math.PI;
  const lat = (Math.PI / 2) - (y / MAP_H) * Math.PI;
  const c = Math.cos(lat);
  out[0] = c * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = -c * Math.sin(lon);
}

const va = [0, 0, 0], vb = [0, 0, 0];

/** Great-circle angular distance expressed in equatorial tiles. */
export function greatCircleTiles(ax: number, ay: number, bx: number, by: number): number {
  toVec(ax, ay, va);
  toVec(bx, by, vb);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  return (Math.acos(dot) / (2 * Math.PI)) * MAP_W;
}

/** Point at fraction t along the great circle between two tile-space points (written into out.x/out.y). */
export function slerpTiles(ax: number, ay: number, bx: number, by: number, t: number, out: { x: number; y: number }): void {
  toVec(ax, ay, va);
  toVec(bx, by, vb);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const om = Math.acos(dot);
  let x: number, y: number, z: number;
  if (om < 1e-6) {
    x = va[0]; y = va[1]; z = va[2];
  } else {
    const s = Math.sin(om);
    const ka = Math.sin((1 - t) * om) / s, kb = Math.sin(t * om) / s;
    x = va[0] * ka + vb[0] * kb;
    y = va[1] * ka + vb[1] * kb;
    z = va[2] * ka + vb[2] * kb;
  }
  const lat = Math.asin(Math.max(-1, Math.min(1, y)));
  const lon = Math.atan2(-z, x);
  out.x = wrapXf(((lon + Math.PI) / (2 * Math.PI)) * MAP_W);
  out.y = Math.min(MAP_H - 0.001, Math.max(0, ((Math.PI / 2 - lat) / Math.PI) * MAP_H));
}
