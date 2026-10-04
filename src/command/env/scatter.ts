// FRONT ULTRA — command mode: scenery scattering (owner: command). Conifers / broadleaf trees where the data
// layer says forest, houses where it says urban (the Black Marble night lights: villages and suburbs), boulders on
// rock and scree. Instanced (one draw call per kind), anchored to the world (see stream()), density scaled by
// quality.commandDetail.

import * as THREE from 'three';
import { broadleafGeometry, coniferGeometry, houseGeometry, rockGeometry, sandbagGeometry } from '../models/props';
import type { Ground } from './ground';

const MAX_TREES = 6000;
const MAX_HOUSES = 700;
const MAX_ROCKS = 1400;
const MAX_BAGS = 120;

export class Scatter {
  readonly group = new THREE.Group();
  readonly conifers: THREE.InstancedMesh;
  readonly broadleaf: THREE.InstancedMesh;
  readonly houses: THREE.InstancedMesh;
  readonly rocks: THREE.InstancedMesh;
  readonly bags: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly n = new THREE.Vector3();
  /** Houses (x, z, radius) for simple collision / blocking queries. */
  readonly houseList: { x: number; z: number; r: number; y: number; h: number }[] = [];

  constructor(material: THREE.Material) {
    const mk = (g: THREE.BufferGeometry, n: number, name: string) => {
      const im = new THREE.InstancedMesh(g, material, n);
      im.name = name;
      im.castShadow = true;
      im.receiveShadow = true;
      im.count = 0;
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(im);
      return im;
    };
    this.conifers = mk(coniferGeometry(), MAX_TREES, 'conifers');
    this.broadleaf = mk(broadleafGeometry(), MAX_TREES, 'broadleaf');
    this.houses = mk(houseGeometry(), MAX_HOUSES, 'houses');
    this.rocks = mk(rockGeometry(), MAX_ROCKS, 'rocks');
    this.bags = mk(sandbagGeometry(), MAX_BAGS, 'sandbags');
  }

  warmup(on: boolean): void {
    for (const im of [this.conifers, this.broadleaf, this.houses, this.rocks, this.bags]) {
      if (on) {
        if (im.count === 0) {
          im.count = 1;
          im.setMatrixAt(0, this.m.identity());
          im.userData.warm = true;
        }
      } else if (im.userData.warm) {
        im.count = 0;
        im.userData.warm = false;
      }
    }
  }

  clear(): void {
    for (const im of [this.conifers, this.broadleaf, this.houses, this.rocks, this.bags]) im.count = 0;
    this.houseList.length = 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Streamed layout (command v2): props on a world-anchored jittered grid of cells around the vehicle, decided by a
  // hash of the absolute cell (the same place always gets the same trees, whatever path led there), from the splat of
  // the streamed near chunks. Built in slices under a per-frame budget into staging arrays, then swapped in at once.
  // ---------------------------------------------------------------------------------------------
  private job: {
    cx: number; cz: number; offX: number; offZ: number; row: number; rows: number; x0: number; z0: number;
    cell: number; radius: number; density: number; treeScale: number;
    mats: [Float32Array, Float32Array, Float32Array, Float32Array]; cols: [Float32Array, Float32Array, Float32Array, Float32Array];
    counts: [number, number, number, number]; houses: { x: number; z: number; r: number; y: number; h: number }[];
  } | null = null;
  private lastCx = 1e12;
  private lastCz = 1e12;
  private readonly sampleOut = { splat: new Float32Array(8), tint: [0, 0, 0] as [number, number, number] };
  private readonly caps = [MAX_TREES, MAX_TREES, MAX_HOUSES, MAX_ROCKS];

  /** Forget the layout (new session). */
  resetStream(): void {
    this.job = null;
    this.lastCx = this.lastCz = 1e12;
    this.clear();
    this.group.position.set(0, 0, 0);
  }

  /** Floating origin moved by (dx, dz): the committed instances follow; a running job restarts. */
  rebase(dx: number, dz: number): void {
    this.group.position.x -= dx;
    this.group.position.z -= dz;
    for (const h of this.houseList) {
      h.x -= dx;
      h.z -= dz;
    }
    this.lastCx -= dx;
    this.lastCz -= dz;
    this.job = null;
  }

  /**
   * Keep the props laid out around (x, z) (scene). `offX/offZ` = the frame's scene offset (absolute anchor);
   * `radius` (m), `cell` (m), `density` 0..1; `budgetMs` of work this frame. Returns the ms spent.
   */
  stream(ground: Ground, x: number, z: number, offX: number, offZ: number, radius: number, cell: number, density: number, treeScale: number, budgetMs: number): number {
    const t0 = performance.now();
    if (this.shelled && this.shelled.version() !== this.shelledV) {
      this.shelledV = this.shelled.version();
      this.pruneShelled();
    }
    if (!this.job) {
      if (Math.hypot(x - this.lastCx, z - this.lastCz) < radius * 0.22) return 0;
      if (!ground.nearReady(x, z)) return 0;
      const rows = Math.ceil((radius * 2) / cell);
      this.job = {
        cx: x, cz: z, offX, offZ, row: 0, rows, x0: Math.floor((x + offX - radius) / cell), z0: Math.floor((z + offZ - radius) / cell),
        cell, radius, density, treeScale,
        mats: [new Float32Array(MAX_TREES * 16), new Float32Array(MAX_TREES * 16), new Float32Array(MAX_HOUSES * 16), new Float32Array(MAX_ROCKS * 16)],
        cols: [new Float32Array(MAX_TREES * 3), new Float32Array(MAX_TREES * 3), new Float32Array(MAX_HOUSES * 3), new Float32Array(MAX_ROCKS * 3)],
        counts: [0, 0, 0, 0], houses: [],
      };
    }
    const j = this.job;
    if (j.offX !== offX || j.offZ !== offZ) {
      this.job = null;
      return performance.now() - t0;
    }
    const S = this.sampleOut;
    const R2 = j.radius * j.radius;
    while (j.row < j.rows && performance.now() - t0 < budgetMs) {
      const iz = j.z0 + j.row;
      for (let c = 0; c < j.rows; c++) {
        const ix = j.x0 + c;
        const h1 = hash2(ix, iz), h2 = hash2(iz * 7 + 3, ix * 13 + 1), h3 = hash2(ix + 91, iz - 17), h4 = hash2(ix - 55, iz * 3 + 7);
        if (h4 > 0.25 + 0.75 * j.density) continue;
        const sx = (ix + h1) * j.cell - offX, sz = (iz + h2) * j.cell - offZ;
        const dx = sx - j.cx, dz = sz - j.cz;
        if (dx * dx + dz * dz > R2) continue;
        if (!ground.sample(sx, sz, S)) continue;
        const sp = S.splat;
        const forest = sp[2], rock = sp[3], grass = sp[1], urban = sp[5], snow = sp[4];
        const h = ground.heightAt(sx, sz);
        if (h < 0.8) continue;
        ground.normalAt(sx, sz, this.n, 3);
        const slope = 1 - this.n.y;
        const roll = h3;
        let type = -1;
        if (urban > 0.25 && roll < urban * 0.42 && slope < 0.12) {
          const w = 7 + h1 * 9, d = 7 + h2 * 7, hh = 5 + h4 * (urban > 0.6 ? 14 : 5);
          this.q.setFromAxisAngle(this.up, Math.round(h2 * 4) * (Math.PI / 2) + (h3 - 0.5) * 0.3);
          this.s.set(w, hh, d);
          this.p.set(sx, h - 0.5, sz);
          type = 2;
          const v = 0.8 + h4 * 0.35;
          this.c.setRGB(v, v * (0.95 + h1 * 0.06), v * (0.88 + h2 * 0.1));
          if (j.counts[2] < MAX_HOUSES) j.houses.push({ x: sx, z: sz, r: Math.max(w, d) * 0.6, y: h, h: hh });
        } else if (forest > 0.2 && roll < 0.1 + forest * 0.85 && slope < 0.5) {
          const con = hash2(ix * 5 + 11, iz * 9 - 3) < 0.25 + Math.min(1, Math.max(0, (Math.abs(this.latHint) - 35) / 25)) * 0.6 + snow;
          const sc = (0.75 + h1 * 0.6) * j.treeScale;
          this.q.setFromAxisAngle(this.up, h2 * Math.PI * 2);
          this.s.set(sc, sc * (0.9 + h4 * 0.3), sc);
          this.p.set(sx, h - 0.3, sz);
          type = con ? 0 : 1;
          const v = 0.75 + h3 * 0.45;
          this.c.setRGB(v * (0.9 + h1 * 0.2), v, v * (0.85 + h2 * 0.2));
        } else if (grass > 0.3 && roll > 0.93 && slope < 0.35) {
          const bush = roll < 0.975;
          const sc = (bush ? 0.28 + h1 * 0.25 : 0.8 + h1 * 0.5) * j.treeScale;
          this.q.setFromAxisAngle(this.up, h2 * Math.PI * 2);
          this.s.set(sc, sc * (bush ? 0.7 : 1), sc);
          this.p.set(sx, h - (bush ? 0.9 * sc : 0.3), sz);
          type = 1;
          const v = 0.75 + h4 * 0.35;
          this.c.setRGB(v * 0.95, v, v * 0.85);
        } else if ((rock > 0.2 || slope > 0.35) && roll < 0.08 + rock * 0.25) {
          const sc = 0.6 + Math.pow(h1, 3) * 4.5;
          this.q.setFromUnitVectors(this.up, this.n);
          this.s.set(sc * (0.8 + h2 * 0.5), sc * (0.6 + h4 * 0.6), sc);
          this.p.set(sx, h - sc * 0.15, sz);
          type = 3;
          const v = 0.7 + h3 * 0.4;
          this.c.setRGB(v, v * 0.97, v * 0.93);
        }
        if (type < 0 || j.counts[type] >= this.caps[type]) continue;
        if (this.keepOut && this.keepOut(sx, sz)) continue;
        // (No boulder where the tank stands at the battle's vantage: the chase camera 14 m behind it ended up inside one.)
        if (type === 3 && this.shelled?.clear?.(sx, sz)) continue;
        if ((type === 0 || type === 1) && this.shelled) {
          const v = this.shelled.at(sx, sz);
          if (v === 2) continue;
          if (v === 1) {
            this.fell(sx, sz);
            this.p.y += 0.3;
          }
        }
        this.m.compose(this.p, this.q, this.s);
        const k = j.counts[type]++;
        this.m.toArray(j.mats[type], k * 16);
        j.cols[type][k * 3] = this.c.r;
        j.cols[type][k * 3 + 1] = this.c.g;
        j.cols[type][k * 3 + 2] = this.c.b;
      }
      j.row++;
    }
    if (j.row >= j.rows) this.commit(j);
    return performance.now() - t0;
  }

  /**
   * Owner item 32 (gauntlet round 1): the battle's shelled ground, for trees — 0 a tree stands, 1 it lies shattered on
   * the ground, 2 it is gone. Consulted as trees are laid out, and re-applied to the standing ones whenever its version
   * changes (the battle moved): a fight is not fought in a forest the tank cannot see out of.
   */
  shelled: { at(x: number, z: number): number; version(): number; clear?(x: number, z: number): boolean } | null = null;
  private shelledV = -1;
  private readonly tilt = new THREE.Quaternion();

  /** Trees on shelled ground go down or go (see `shelled`), keeping the instance arrays packed. */
  private pruneShelled(): void {
    const f = this.shelled;
    if (!f) return;
    const gx = this.group.position.x, gz = this.group.position.z;
    for (const im of [this.conifers, this.broadleaf]) {
      const a = im.instanceMatrix.array as Float32Array;
      const col = im.instanceColor ? (im.instanceColor.array as Float32Array) : null;
      let n = im.count;
      let changed = false;
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        const x = a[o + 12] + gx, z = a[o + 14] + gz;
        const v = f.at(x, z);
        if (v === 0) continue;
        if (v === 1) {
          const upY = a[o + 5] / Math.max(1e-6, Math.hypot(a[o + 4], a[o + 5], a[o + 6]));
          if (upY < 0.5) continue;
          this.m.fromArray(a, o);
          this.m.decompose(this.p, this.q, this.s);
          this.fell(x, z);
          this.p.y += 0.3;
          this.m.compose(this.p, this.q, this.s).toArray(a, o);
          changed = true;
          continue;
        }
        // Gone: the last instance takes its slot.
        n--;
        a.copyWithin(o, n * 16, n * 16 + 16);
        if (col) col.copyWithin(i * 3, n * 3, n * 3 + 3);
        i--;
        changed = true;
      }
      if (changed) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Lay the tree in this.q down (about its base, toward a direction of its own). */
  private fell(x: number, z: number): void {
    const a = hash2(Math.floor(x * 3.1), Math.floor(z * 2.7)) * Math.PI * 2;
    this.tilt.setFromAxisAngle(this.n.set(Math.cos(a), 0, Math.sin(a)), 1.45);
    this.q.premultiply(this.tilt);
  }

  /** Latitude of the session (conifer bias). */
  latHint = 45;
  /** Optional keep-out test (roads, town squares, bases): no prop there. */
  keepOut: ((x: number, z: number) => boolean) | null = null;

  private commit(j: NonNullable<Scatter['job']>): void {
    const ims = [this.conifers, this.broadleaf, this.houses, this.rocks];
    for (let t = 0; t < 4; t++) {
      const im = ims[t];
      const n = j.counts[t];
      (im.instanceMatrix.array as Float32Array).set(j.mats[t].subarray(0, n * 16));
      if (im.instanceColor) (im.instanceColor.array as Float32Array).set(j.cols[t].subarray(0, n * 3));
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
    }
    this.group.position.set(0, 0, 0);
    this.houseList.length = 0;
    this.houseList.push(...j.houses);
    this.lastCx = j.cx;
    this.lastCz = j.cz;
    this.job = null;
    // (The battle may have moved while this layout was being built: its shelled ground is applied again.)
    this.shelledV = -1;
  }

  /** Does any tree trunk / crown stand within `r` m of the XZ segment a-b? (staging and line-of-sight polish) */
  treeBlocks(ax: number, az: number, bx: number, bz: number, r: number): boolean {
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1;
    for (const im of [this.conifers, this.broadleaf]) {
      const a = im.instanceMatrix.array as Float32Array;
      for (let i = 0; i < im.count; i++) {
        const x = a[i * 16 + 12], z = a[i * 16 + 14];
        let t = ((x - ax) * dx + (z - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        const sc = a[i * 16 + 0] ** 2 + a[i * 16 + 1] ** 2 + a[i * 16 + 2] ** 2;
        const rr = r + 3 * Math.sqrt(sc);
        if (ex * ex + ez * ez < rr * rr) return true;
      }
    }
    return false;
  }

  /**
   * Owner item 32: a vehicle drives through the trees within r of (x, z), moving along (dx, dz): they go down in the
   * direction of travel (the instance tips over about its base). Returns the positions knocked down now.
   */
  knockTrees(x: number, z: number, r: number, dx: number, dz: number): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    const dl = Math.hypot(dx, dz) || 1;
    const ax = dz / dl, az = -dx / dl;
    for (const im of [this.conifers, this.broadleaf]) {
      const a = im.instanceMatrix.array as Float32Array;
      let any = false;
      for (let i = 0; i < im.count; i++) {
        const o = i * 16;
        const tx = a[o + 12], tz = a[o + 14];
        const ex = tx - x, ez = tz - z;
        if (ex * ex + ez * ez > r * r) continue;
        // Already down: its up axis lies near the ground.
        const upY = a[o + 5] / Math.max(1e-6, Math.hypot(a[o + 4], a[o + 5], a[o + 6]));
        if (upY < 0.5) continue;
        this.m.fromArray(a, o);
        this.q.setFromAxisAngle(this.n.set(ax, 0, az), 1.35);
        this.m.premultiply(new THREE.Matrix4().makeTranslation(-tx, -a[o + 13], -tz)).premultiply(new THREE.Matrix4().makeRotationFromQuaternion(this.q)).premultiply(new THREE.Matrix4().makeTranslation(tx, a[o + 13] + 0.3, tz));
        this.m.toArray(a, o);
        any = true;
        out.push({ x: tx, z: tz });
      }
      if (any) im.instanceMatrix.needsUpdate = true;
    }
    return out;
  }

  /** Sandbag positions (field fortifications) along a front line. */
  placeBags(ground: Ground, list: { x: number; z: number; yaw: number }[]): void {
    let n = 0;
    for (const b of list) {
      if (n >= MAX_BAGS) break;
      const h = ground.heightAt(b.x, b.z);
      if (h < 0.5) continue;
      this.q.setFromAxisAngle(this.up, b.yaw);
      this.s.set(1, 1, 1);
      this.p.set(b.x, h - 0.1, b.z);
      this.m.compose(this.p, this.q, this.s);
      this.bags.setMatrixAt(n, this.m);
      this.bags.setColorAt(n++, this.c.setRGB(1, 1, 1));
    }
    this.bags.count = n;
    this.bags.instanceMatrix.needsUpdate = true;
    if (this.bags.instanceColor) this.bags.instanceColor.needsUpdate = true;
    this.bags.computeBoundingSphere();
  }
}

function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 10007) / 10007;
}
