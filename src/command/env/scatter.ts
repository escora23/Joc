// FRONT ULTRA — command mode: scenery scattering (owner: command). Conifers / broadleaf trees where the data
// layer says forest, houses where it says urban, boulders on rock and scree. Instanced (one draw call per kind),
// deterministic per battlefield seed, density scaled by quality.commandDetail.

import * as THREE from 'three';
import type { LocalHeightfield } from '../../data/types';
import type { Rng } from '../../shared/rng';
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

  /**
   * Scatter props over the near patch. `radius` limits the area (m), `clear` lists keep-out discs (x, z, r),
   * `density` 0..1 (quality). `treeScale` > 1 makes forests readable from the air.
   */
  build(ground: Ground, hf: LocalHeightfield, rng: Rng, radius: number, density: number, clear: number[], treeScale = 1): void {
    this.clear();
    const size = hf.sizeKm * 1000;
    const res = hf.resolution;
    const area = Math.PI * radius * radius;
    const tries = Math.min(90000, Math.floor((area / 900) * density * 1.8));
    const conifer = this.conifers, broad = this.broadleaf, houses = this.houses, rocks = this.rocks;
    let nc = 0, nb = 0, nh = 0, nr = 0;
    const lat = Math.abs(hf.lat);
    const coniferBias = Math.min(1, Math.max(0, (lat - 35) / 25)) + (hf.maxHeight > 1500 ? 0.35 : 0);
    const blocked = (x: number, z: number, pad: number) => {
      for (let i = 0; i < clear.length; i += 3) {
        const dx = x - clear[i], dz = z - clear[i + 1], r = clear[i + 2] + pad;
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    };
    for (let t = 0; t < tries; t++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * radius;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) > size / 2 - 5 || Math.abs(z) > size / 2 - 5) continue;
      const j = Math.round((x / size + 0.5) * (res - 1)), i = Math.round((z / size + 0.5) * (res - 1));
      const k = i * res + j;
      const sa = hf.splatA, sb = hf.splatB;
      const forest = sa[k * 4 + 2] / 255, rock = sa[k * 4 + 3] / 255, grass = sa[k * 4 + 1] / 255;
      const urban = sb[k * 4 + 1] / 255, snow = sb[k * 4] / 255;
      const h = ground.heightAt(x, z);
      if (h < 0.8) continue;
      ground.normalAt(x, z, this.n, 3);
      const slope = 1 - this.n.y;
      const roll = rng.next();
      if (urban > 0.25 && roll < urban * 0.5 && slope < 0.12 && nh < MAX_HOUSES && !blocked(x, z, 14)) {
        const w = 7 + rng.next() * 9, d = 7 + rng.next() * 7, hh = 5 + rng.next() * (urban > 0.6 ? 14 : 5);
        this.q.setFromAxisAngle(this.up, Math.round(rng.next() * 4) * (Math.PI / 2) + (rng.next() - 0.5) * 0.3);
        this.s.set(w, hh, d);
        this.p.set(x, h - 0.5, z);
        this.m.compose(this.p, this.q, this.s);
        houses.setMatrixAt(nh, this.m);
        const v = 0.8 + rng.next() * 0.35;
        this.c.setRGB(v, v * (0.95 + rng.next() * 0.06), v * (0.88 + rng.next() * 0.1));
        houses.setColorAt(nh, this.c);
        this.houseList.push({ x, z, r: Math.max(w, d) * 0.6, y: h, h: hh });
        nh++;
      } else if (forest > 0.2 && roll < 0.1 + forest * 0.85 && slope < 0.5 && !blocked(x, z, 4)) {
        const isCon = rng.next() < 0.25 + coniferBias * 0.6 + snow;
        const sc = (0.75 + rng.next() * 0.6) * treeScale;
        this.q.setFromAxisAngle(this.up, rng.next() * Math.PI * 2);
        this.s.set(sc, sc * (0.9 + rng.next() * 0.3), sc);
        this.p.set(x, h - 0.3, z);
        this.m.compose(this.p, this.q, this.s);
        const v = 0.75 + rng.next() * 0.45;
        this.c.setRGB(v * (0.9 + rng.next() * 0.2), v, v * (0.85 + rng.next() * 0.2));
        if (isCon && nc < MAX_TREES) {
          conifer.setMatrixAt(nc, this.m);
          conifer.setColorAt(nc++, this.c);
        } else if (!isCon && nb < MAX_TREES) {
          broad.setMatrixAt(nb, this.m);
          broad.setColorAt(nb++, this.c);
        }
      } else if (grass > 0.3 && roll > 0.93 && slope < 0.35 && !blocked(x, z, 4)) {
        // Lone trees, bushes and hedgerows in farmland.
        const bush = roll < 0.975;
        const sc = (bush ? 0.28 + rng.next() * 0.25 : 0.8 + rng.next() * 0.5) * treeScale;
        this.q.setFromAxisAngle(this.up, rng.next() * Math.PI * 2);
        this.s.set(sc, sc * (bush ? 0.7 : 1), sc);
        this.p.set(x, h - (bush ? 0.9 * sc : 0.3), z);
        this.m.compose(this.p, this.q, this.s);
        const v = 0.75 + rng.next() * 0.35;
        this.c.setRGB(v * 0.95, v, v * 0.85);
        if (nb < MAX_TREES) {
          broad.setMatrixAt(nb, this.m);
          broad.setColorAt(nb++, this.c);
        }
      } else if ((rock > 0.2 || slope > 0.35) && roll < 0.08 + rock * 0.25 && nr < MAX_ROCKS && !blocked(x, z, 3)) {
        const sc = 0.6 + Math.pow(rng.next(), 3) * 4.5;
        this.q.setFromUnitVectors(this.up, this.n);
        this.s.set(sc * (0.8 + rng.next() * 0.5), sc * (0.6 + rng.next() * 0.6), sc);
        this.p.set(x, h - sc * 0.15, z);
        this.m.compose(this.p, this.q, this.s);
        rocks.setMatrixAt(nr, this.m);
        const v = 0.7 + rng.next() * 0.4;
        this.c.setRGB(v, v * 0.97, v * 0.93);
        rocks.setColorAt(nr++, this.c);
      }
    }
    conifer.count = nc;
    broad.count = nb;
    houses.count = nh;
    rocks.count = nr;
    for (const im of [conifer, broad, houses, rocks]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
    }
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
