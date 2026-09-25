// FRONT ULTRA — command mode: battlefield composition (owner: command).
// Lays out both sides for each vehicle kind on the real local terrain (land / sea / coast searches), links local
// enemy groups to real strategic enemy units nearby (destroying the whole group destroys that unit in the sim),
// and runs the battle director: reinforcement waves, friendly air strikes, enemy artillery, anti-ship raids.

import * as THREE from 'three';
import type { CommandKind, Difficulty } from '../shared/types';
import type { Rng } from '../shared/rng';
import type { Front } from './ai';
import type { Scatter } from './env/scatter';
import { ENT_DEFS, forwardOf, type Ent, type EntKind, type World } from './world';

const DIFF: Record<Difficulty, { skill: number; count: number; dmg: number; troops: number; obj: number }> = {
  easy: { skill: 0.6, count: 0.8, dmg: 0.45, troops: 0.85, obj: 0.8 },
  normal: { skill: 1, count: 1, dmg: 0.7, troops: 1, obj: 1 },
  hard: { skill: 1.3, count: 1.2, dmg: 0.95, troops: 1.15, obj: 1.2 },
  insane: { skill: 1.6, count: 1.4, dmg: 1.2, troops: 1.3, obj: 1.4 },
};

export interface MissionSetup {
  kind: CommandKind;
  difficulty: Difficulty;
  /** Yaw (rotation.y convention) pointing from the player toward the enemy. */
  enemyYaw: number;
  /** Strategic enemy unit ids near the battle (matching the kind), to link to local groups. */
  strategicUnits: number[];
  enemyTroops: number;
}

const T = new THREE.Vector3();

export class Mission {
  readonly front: Front;
  objective = 10;
  troopMul = 1;
  private waveT = 30;
  private waves = 0;
  private strikeT = 22;
  private artyT = 6;
  private raidT = 25;
  private nextGroup = 1;
  readonly enemyDir = new THREE.Vector3();
  readonly rightDir = new THREE.Vector3();
  /** Distant burning points on the horizon (smoke columns). */
  readonly columns: THREE.Vector3[] = [];
  /** Callbacks for news-style HUD toasts. */
  onNotice: (key: string) => void = () => undefined;

  constructor(
    private readonly w: World,
    private readonly rng: Rng,
    readonly setup: MissionSetup,
  ) {
    forwardOf(setup.enemyYaw, this.enemyDir);
    this.rightDir.set(-this.enemyDir.z, 0, this.enemyDir.x);
    const R = setup.kind === 'jet' ? 16000 : setup.kind === 'ship' ? 9500 : 1900;
    this.front = {
      friendlyBase: new THREE.Vector3().copy(this.enemyDir).multiplyScalar(setup.kind === 'tank' ? -250 : -2000),
      enemyBase: new THREE.Vector3().copy(this.enemyDir).multiplyScalar(setup.kind === 'tank' ? 1000 : 6000),
      radius: R,
    };
    const d = DIFF[setup.difficulty] ?? DIFF.normal;
    w.enemySkill = d.skill;
    w.playerDamageMul = d.dmg;
    this.troopMul = d.troops;
    const base = setup.kind === 'tank' ? 14 : setup.kind === 'jet' ? 8 : 5;
    this.objective = Math.max(3, Math.round(base * d.obj));
  }

  private get countMul(): number {
    return (DIFF[this.setup.difficulty] ?? DIFF.normal).count;
  }

  /** Point `along` meters toward the enemy and `side` meters to the right, from the origin. */
  at(along: number, side: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.enemyDir.x * along + this.rightDir.x * side, 0, this.enemyDir.z * along + this.rightDir.z * side);
  }

  /** Find a spot near p on land (flat enough) or at sea (deep enough). */
  findSpot(p: THREE.Vector3, water: boolean, spread: number, out: THREE.Vector3): boolean {
    const g = this.w.ground;
    const n = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      const r = i === 0 ? 0 : spread * (0.3 + (i / 40) * 1.2);
      const a = this.rng.next() * Math.PI * 2;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      const h = g.heightAt(x, z);
      if (water) {
        if (h < -5 && g.heightAt(x + 70, z) < -3 && g.heightAt(x - 70, z) < -3 && g.heightAt(x, z + 70) < -3 && g.heightAt(x, z - 70) < -3) {
          out.set(x, 0, z);
          return true;
        }
      } else {
        g.normalAt(x, z, n, 4);
        if (h > 1.2 && n.y > 0.86) {
          out.set(x, h, z);
          return true;
        }
      }
    }
    return false;
  }

  place(kind: EntKind, team: 0 | 1, along: number, side: number, spread: number, yaw: number): Ent | null {
    const naval = ENT_DEFS[kind].naval;
    this.at(along, side, T);
    if (ENT_DEFS[kind].air) return this.w.spawn(kind, team, T.x, T.z, yaw, this.w.ground.surfaceAt(T.x, T.z) + 1200 + this.rng.next() * 1200);
    const p = new THREE.Vector3();
    if (!this.findSpot(T, naval, spread, p)) return null;
    const e = this.w.spawn(kind, team, p.x, p.z, yaw);
    e.moveT.copy(p);
    return e;
  }

  squad(team: 0 | 1, along: number, side: number, n: number, withAt: boolean, yaw: number): Ent[] {
    this.at(along, side, T);
    const c = new THREE.Vector3();
    const out: Ent[] = [];
    if (!this.findSpot(T, false, 60, c)) return out;
    for (let i = 0; i < n; i++) {
      const x = c.x + (this.rng.next() - 0.5) * 18, z = c.z + (this.rng.next() - 0.5) * 18;
      if (this.w.ground.heightAt(x, z) < 0.8) continue;
      const e = this.w.spawn(withAt && i === 0 ? 'at' : 'soldier', team, x, z, yaw + (this.rng.next() - 0.5) * 0.6);
      e.moveT.set(x, 0, z);
      out.push(e);
    }
    return out;
  }

  private link(ents: (Ent | null)[]): void {
    const sid = this.setup.strategicUnits.shift();
    if (sid === undefined) return;
    const g = this.nextGroup++;
    for (const e of ents) if (e) e.group = g;
    this.w.strategicGroups.set(g, sid);
  }

  // ---------------------------------------------------------------------------------------------
  // Layouts
  // ---------------------------------------------------------------------------------------------
  build(scatter: Scatter): Ent {
    const k = this.setup.kind;
    if (k === 'tank') return this.buildTank(scatter);
    if (k === 'jet') return this.buildJet();
    return this.buildShip();
  }

  yawTo(enemy: boolean): number {
    return this.setup.enemyYaw + (enemy ? Math.PI : 0);
  }

  private buildTank(scatter: Scatter): Ent {
    const w = this.w;
    const m = this.countMul;
    const yF = this.yawTo(false), yE = this.yawTo(true);
    const p = w.spawn('tank', 0, 0, 0, yF);
    p.player = true;
    w.player = p;
    // Friendlies: a line abreast with the player, infantry moving up alongside.
    for (const [al, side] of [[8, -46], [-6, 52], [-30, -115]]) this.place('tank', 0, al + this.rng.next() * 10, side, 20, yF);
    this.place('ifv', 0, -45, 24, 25, yF);
    for (const [al, side] of [[22, -24], [30, 30], [-10, 95]]) this.squad(0, al, side, 6, side === 30, yF);
    // Enemy defensive line ~380 m out: sandbags, AT teams, infantry; armor behind it, advancing.
    const bags: { x: number; z: number; yaw: number }[] = [];
    for (let i = -7; i <= 7; i++) {
      this.at(370 + this.rng.next() * 30, i * 26 + this.rng.next() * 8, T);
      bags.push({ x: T.x, z: T.z, yaw: yE + Math.PI / 2 + (this.rng.next() - 0.5) * 0.3 });
    }
    scatter.placeBags(w.ground, bags);
    const tanks: (Ent | null)[] = [];
    const nT = Math.round(5 * m);
    for (let i = 0; i < nT; i++) tanks.push(this.place('tank', 1, 430 + this.rng.next() * 240, (i - (nT - 1) / 2) * 105 + (this.rng.next() - 0.5) * 50, 40, yE));
    this.link(tanks.slice(0, 3));
    this.link(tanks.slice(3, 6));
    for (let i = 0; i < Math.round(2 * m); i++) this.place('ifv', 1, 460 + this.rng.next() * 140, (this.rng.next() - 0.5) * 460, 40, yE);
    this.place('aa', 1, 760, (this.rng.next() - 0.5) * 300, 60, yE);
    for (let i = 0; i < 2; i++) this.place('truck', 1, 860 + this.rng.next() * 150, (this.rng.next() - 0.5) * 500, 60, yE);
    for (let i = 0; i < Math.round(4 * m); i++) this.squad(1, 340 + this.rng.next() * 50, (i - 1.5) * 85, 5, true, yE);
    for (let i = 0; i < 2; i++) this.squad(1, 280, (i ? 1 : -1) * 150, 2, true, yE);
    // Aftermath of earlier fighting: burning wrecks and craters between the lines.
    for (let i = 0; i < 4; i++) {
      const e = this.place(i === 1 ? 'ifv' : 'tank', i >= 2 ? 0 : 1, 110 + i * 70, (this.rng.next() - 0.5) * 360, 50, this.rng.next() * 6);
      if (e) this.preWreck(e);
    }
    for (let i = 0; i < 6; i++) {
      this.at(700 + this.rng.next() * 1500, (this.rng.next() - 0.5) * 2600, T);
      const h = w.ground.heightAt(T.x, T.z);
      if (h > 1) this.columns.push(new THREE.Vector3(T.x, h, T.z));
    }
    for (let i = 0; i < 46; i++) {
      this.at(40 + this.rng.next() * 480, (this.rng.next() - 0.5) * 700, T);
      w.fx.decal(T.x, T.z, 3 + this.rng.next() * 5, this.rng.next() < 0.6 ? 1 : 0, 0.85);
    }
    return p;
  }

  private buildJet(): Ent {
    const w = this.w;
    const m = this.countMul;
    const yF = this.yawTo(false), yE = this.yawTo(true);
    this.at(-3000, 0, T);
    const p = w.spawn('jet', 0, T.x, T.z, yF, w.ground.surfaceAt(T.x, T.z) + 1600);
    p.player = true;
    w.player = p;
    for (const side of [-120, 140]) {
      this.at(-3150, side, T);
      const e = w.spawn('jet', 0, T.x, T.z, yF, p.pos.y + (this.rng.next() - 0.5) * 80);
      e.speed = 240;
    }
    const fighters: (Ent | null)[] = [];
    const nF = Math.round(5 * m);
    for (let i = 0; i < nF; i++) {
      this.at(5000 + this.rng.next() * 3500, (i - (nF - 1) / 2) * 900, T);
      const e = w.spawn('jet', 1, T.x, T.z, yE, w.ground.surfaceAt(T.x, T.z) + 1300 + this.rng.next() * 1600);
      fighters.push(e);
    }
    this.link(fighters.slice(0, 2));
    this.link(fighters.slice(2, 4));
    // Ground: SAM belt, AA, an armored column.
    for (let i = 0; i < 2; i++) this.place('sam', 1, 5000 + i * 1800, (i ? 1 : -1) * 1500, 800, yE);
    for (let i = 0; i < 2; i++) this.place('aa', 1, 3500 + i * 1500, (i ? -1 : 1) * 700, 500, yE);
    for (let i = 0; i < 5; i++) {
      const e = this.place(i % 2 ? 'truck' : 'tank', 1, 2600 + i * 45, 300 + i * 12, 300, yE);
      if (e) e.moveT.copy(this.at(-600, 400, new THREE.Vector3()));
    }
    for (let i = 0; i < 3; i++) this.place('tank', 0, 800 + i * 60, -200 + i * 40, 300, yF);
    for (let i = 0; i < 5; i++) {
      this.at(1500 + this.rng.next() * 7000, (this.rng.next() - 0.5) * 9000, T);
      const h = w.ground.heightAt(T.x, T.z);
      if (h > 1) this.columns.push(new THREE.Vector3(T.x, h, T.z));
    }
    return p;
  }

  private buildShip(): Ent {
    const w = this.w;
    const m = this.countMul;
    const yF = this.yawTo(false), yE = this.yawTo(true);
    const p = w.spawn('ship', 0, 0, 0, yF);
    p.player = true;
    w.player = p;
    const esc = this.place('ship', 0, -500, 700, 400, yF);
    if (esc) esc.seed = 0.9;
    const ships: (Ent | null)[] = [];
    const nS = Math.max(2, Math.round(2.4 * m));
    for (let i = 0; i < nS; i++) ships.push(this.place('ship', 1, 5200 + this.rng.next() * 2500, (i - (nS - 1) / 2) * 2600, 1500, yE + (this.rng.next() - 0.5)));
    for (const s of ships) this.link([s]);
    for (let i = 0; i < Math.round(3 * m); i++) this.place('boat', 1, 3500 + this.rng.next() * 1500, (this.rng.next() - 0.5) * 4000, 1000, yE);
    // Coastal batteries on the nearest shore within range.
    let placed = 0;
    const g = w.ground;
    for (let i = 0; i < 400 && placed < 2; i++) {
      const a = this.rng.next() * Math.PI * 2, r = 2500 + this.rng.next() * 6500;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = g.heightAt(x, z);
      if (h < 6 || h > 220) continue;
      // Needs open water within ~700 m toward the origin.
      const k = 700 / r;
      if (g.heightAt(x * (1 - k), z * (1 - k)) > -3) continue;
      const e = w.spawn('battery', 1, x, z, Math.atan2(x, z));
      e.pos.y = h;
      placed++;
    }
    return p;
  }

  /** Burnt-out wreck placed at build time (no kill credit, long fire). */
  preWreck(e: Ent): void {
    e.alive = false;
    e.hp = 0;
    e.burnT = 60 + this.rng.next() * 200;
    e.deadT = 30;
    if (e.rig) {
      this.w.wreckRig(e.rig);
      e.rig.root.position.copy(e.pos);
      e.rig.root.position.y = this.w.ground.heightAt(e.pos.x, e.pos.z);
      e.rig.root.rotation.y = e.yaw;
      if (e.rig.turret && this.rng.next() < 0.5) {
        e.rig.turret.rotation.y = this.rng.next() * 3;
        e.rig.turret.rotation.z = 0.2;
        e.rig.turret.position.x += 1.5;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Director
  // ---------------------------------------------------------------------------------------------
  update(dt: number): void {
    const k = this.setup.kind;
    const w = this.w;
    this.waveT -= dt;
    for (const c of this.columns) w.fx.column(c, k === 'jet' ? 2.5 : 1, dt);
    if (k === 'tank') {
      this.strikeT -= dt;
      this.artyT -= dt;
      if (this.waveT <= 0) {
        this.waveT = 35 + this.rng.next() * 20;
        let vehicles = 0;
        for (const e of w.ents) if (e.alive && e.team === 1 && e.rig) vehicles++;
        if (vehicles < 7 && this.waves < 6) {
          this.waves++;
          const side = (this.rng.next() - 0.5) * 600;
          this.place('tank', 1, 950, side, 120, this.yawTo(true));
          this.place('tank', 1, 1000, side + 90, 120, this.yawTo(true));
          this.place('ifv', 1, 1050, side - 80, 120, this.yawTo(true));
          this.squad(1, 900, side + 40, 5, true, this.yawTo(true));
          this.onNotice('command.wave');
        }
        // Friendly reinforcements keep the line alive too.
        let friends = 0;
        for (const e of w.ents) if (e.alive && e.team === 0 && e.rig && !e.player) friends++;
        if (friends < 3) {
          this.place('tank', 0, -400, (this.rng.next() - 0.5) * 300, 80, this.yawTo(false));
          this.squad(0, -380, (this.rng.next() - 0.5) * 300, 6, true, this.yawTo(false));
        }
      }
      if (this.strikeT <= 0) {
        this.strikeT = 40 + this.rng.next() * 20;
        this.airStrike();
      }
      if (this.artyT <= 0) {
        this.artyT = 4 + this.rng.next() * 6;
        this.artillery();
      }
    } else if (k === 'jet') {
      if (this.waveT <= 0) {
        this.waveT = 30 + this.rng.next() * 15;
        let air = 0;
        for (const e of w.ents) if (e.alive && e.team === 1 && e.kind === 'jet') air++;
        if (air < 3 && this.waves < 6) {
          this.waves++;
          for (let i = 0; i < 2; i++) {
            this.at(9000, (this.rng.next() - 0.5) * 6000, T);
            w.spawn('jet', 1, T.x, T.z, this.yawTo(true), w.ground.surfaceAt(T.x, T.z) + 1500 + this.rng.next() * 1500);
          }
          this.onNotice('command.wave');
        }
      }
    } else {
      this.raidT -= dt;
      if (this.raidT <= 0) {
        this.raidT = 45 + this.rng.next() * 25;
        for (let i = 0; i < 2; i++) {
          this.at(12000, (i - 0.5) * 1500, T);
          const e = w.spawn('jet', 1, T.x, T.z, this.yawTo(true), 300);
          e.state = 20;
          e.stateT = 30;
          e.missiles = 2;
          e.fireCd2 = 2 + i * 3;
        }
      }
      if (this.waveT <= 0) {
        this.waveT = 50 + this.rng.next() * 20;
        let ships = 0;
        for (const e of w.ents) if (e.alive && e.team === 1 && (e.kind === 'ship' || e.kind === 'boat')) ships++;
        if (ships < 3 && this.waves < 5) {
          this.waves++;
          this.place('ship', 1, 8500, (this.rng.next() - 0.5) * 5000, 2000, this.yawTo(true));
          this.place('boat', 1, 7000, (this.rng.next() - 0.5) * 4000, 1500, this.yawTo(true));
          this.onNotice('command.wave');
        }
      }
    }
  }

  /** Two friendly jets make a bombing run over the densest enemy cluster. */
  airStrike(): void {
    const w = this.w;
    let best: Ent | null = null, bestN = 0;
    for (const e of w.ents) {
      if (!e.alive || e.team !== 1 || ENT_DEFS[e.kind].air) continue;
      let n = 0;
      for (const o of w.ents) if (o.alive && o.team === 1 && o.pos.distanceToSquared(e.pos) < 150 * 150) n += o.rig ? 2 : 1;
      if (n > bestN) {
        bestN = n;
        best = e;
      }
    }
    if (!best) return;
    const yaw = this.yawTo(false) + (this.rng.next() - 0.5) * 0.5;
    const dir = forwardOf(yaw, new THREE.Vector3());
    for (let i = 0; i < 2; i++) {
      const sx = best.pos.x - dir.x * 7000 + dir.z * (i ? 60 : -60);
      const sz = best.pos.z - dir.z * 7000 - dir.x * (i ? 60 : -60);
      const j = w.spawn('jet', 0, sx, sz, yaw, w.ground.surfaceAt(sx, sz) + 260 + i * 30);
      j.state = 10;
      j.burst = 6;
      j.speed = 240;
      j.moveT.copy(best.pos).addScaledVector(dir, i * 40 - 20);
      j.moveT.x += (this.rng.next() - 0.5) * 40;
    }
    this.onNotice('command.airstrike');
  }

  /** Enemy artillery lands around the friendly side (never right on top of the player). */
  private artillery(): void {
    const w = this.w;
    const p = w.player;
    const cx = p ? p.pos.x : 0, cz = p ? p.pos.z : 0;
    const n = 1 + Math.floor(this.rng.next() * 3);
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * Math.PI * 2, r = 70 + this.rng.next() * 380;
      this.shellAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
  }

  /** Drop an artillery shell onto x, z (lands with the regular impact code). */
  shellAt(x: number, z: number): void {
    const w = this.w;
    const from = new THREE.Vector3(x - this.enemyDir.x * 60, w.ground.surfaceAt(x, z) + 160, z - this.enemyDir.z * 60);
    const dir = new THREE.Vector3(x, w.ground.surfaceAt(x, z), z).sub(from).normalize();
    w.fireShell(null, 1, from, dir, 320, 25, 12, false, false, 1.4);
  }
}
