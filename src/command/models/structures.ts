// FRONT ULTRA — command mode: structures at their real size, readable up close (owner feedback #3, item 27; fix pass 3).
//
// The strategic map's structure models are icons in 3D: a few boxes scaled to the footprint the sim gives a structure
// (1.1 km for a factory). Stretched to that footprint and squashed to a 26 m height they read, from a tank, as one flat
// grey slab with white discs. Here each type is a compound built in metres: a factory is rows of sawtooth-roofed halls,
// chimneys, tanks, an office and a yard inside a fence; a port has quays, warehouses, container stacks and gantry
// cranes; an airbase a runway with markings, hangars and a tower; and so on. The level adds buildings (a level lost
// takes them away), and the damage state ruins the compound part by part (shared/damage.ts states):
//   damaged      a few buildings scorched and holed, a chimney stump
//   heavy        about half the buildings collapsed into low, tilted, blackened heaps, chimneys broken
// Rubble (destroyed) is drawn by civil.ts from the sim's ruins. One merged geometry per (type, level, state, owner
// colour, seed), one draw call per structure.

import * as THREE from 'three';
import { StructureType } from '../../shared/types';
import { GeoBuilder, shade } from './builder';

const CONCRETE = 0x9b978d;
const APRON = 0x948c78;
const ASPHALT = 0x3b3c3e;
const ROOF = 0x7b8086;
const ROOF_DARK = 0x5d6267;
const WALL = 0xaaa293;
const BRICK = 0x8c5b45;
const WHITE = 0xdcdad3;
const RED = 0xb23b2f;
const STEEL = 0x8d939a;
const OLIVE = 0x56603f;
const SAND = 0xa69470;
const EARTH = 0x75674b;
const GLASS = 0x4f6c80;
const YELLOW = 0xd9b13a;
const CHAR = 0x2b2826;

/** Small deterministic generator (the same compound every time for one structure). */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A builder that knows the damage state: every building goes through `bld`, which (by the state and the dice) stands
 * it, scorches it, or brings it down into a heap.
 */
class Compound {
  readonly g = new GeoBuilder();
  readonly r: () => number;
  /** Highest point (m), for hit tests and labels. */
  top = 0;
  constructor(seed: number, readonly state: number, readonly accent: number) {
    this.r = rng(seed);
  }
  /** Everything a building adds stands on the ground under (x, z) (see GeoBuilder.anchor). */
  private at(x: number, z: number, f: () => this): this {
    const prev = this.g.anchor;
    if (!prev) this.g.anchor = [x, z];
    try {
      return f();
    } finally {
      this.g.anchor = prev;
    }
  }
  private fate(): 0 | 1 | 2 {
    const d = this.r();
    if (this.state >= 3) return 2;
    if (this.state >= 2) return d < 0.5 ? 2 : d < 0.8 ? 1 : 0;
    if (this.state === 1) return d < 0.12 ? 2 : d < 0.4 ? 1 : 0;
    return 0;
  }
  /** A flat-roofed building (w × h × d, centre x/z, turned ry) with a roof of `roof` colour. */
  bld(w: number, h: number, d: number, wall: number, roof: number, x: number, z: number, ry = 0): this {
    return this.at(x, z, () => {
      const f = this.fate();
      if (f === 2) return this.heap(w, h, d, wall, x, z, ry);
      const c = f === 1 ? shade(wall, 0.55) : wall;
      this.g.box(w, h, d, c, x, h / 2, z, 0, ry, 0);
      this.g.box(w + 0.6, 0.8, d + 0.6, f === 1 ? CHAR : roof, x, h + 0.4, z, 0, ry, 0);
      // A band of windows on the long sides (dark glass), so the size reads at a glance.
      if (h > 7) {
        const along = w >= d;
        const ww = along ? w * 0.86 : 0.3, dd = along ? 0.3 : d * 0.86;
        const off = along ? d / 2 + 0.05 : w / 2 + 0.05;
        for (let k = 1; k * 4.5 < h - 2; k++) {
          const y = k * 4.5;
          const cs = Math.cos(ry), sn = Math.sin(ry);
          const ox = along ? 0 : off, oz = along ? off : 0;
          this.g.box(ww, 1.4, dd, f === 1 ? CHAR : GLASS, x + ox * cs + oz * sn, y, z - ox * sn + oz * cs, 0, ry, 0);
          this.g.box(ww, 1.4, dd, f === 1 ? CHAR : GLASS, x - ox * cs - oz * sn, y, z + ox * sn - oz * cs, 0, ry, 0);
        }
      }
      this.top = Math.max(this.top, h + 0.8);
      return this;
    });
  }
  /** A collapsed building: a low, tilted, blackened heap with a broken wall stub. */
  heap(w: number, h: number, d: number, wall: number, x: number, z: number, ry = 0): this {
    return this.at(x, z, () => {
      const r = this.r;
      const hh = Math.max(1.5, h * (0.18 + r() * 0.12));
      this.g.box(w * 0.95, hh, d * 0.95, shade(wall, 0.35), x, hh / 2 - 0.3, z, (r() - 0.5) * 0.12, ry, (r() - 0.5) * 0.12);
      this.g.box(w * 0.35, h * 0.55, 0.8, shade(wall, 0.45), x + (r() - 0.5) * w * 0.5, h * 0.27, z + (r() - 0.5) * d * 0.4, 0, ry + (r() - 0.5) * 0.3, (r() - 0.5) * 0.25);
      for (let i = 0; i < 4; i++) {
        const s = 2 + r() * 5;
        this.g.box(s, s * 0.5, s * 0.8, i % 2 ? CHAR : shade(wall, 0.4), x + (r() - 0.5) * w, s * 0.2, z + (r() - 0.5) * d, r(), r() * 3, r());
      }
      return this;
    });
  }
  /** A sawtooth-roofed production hall, the factory's signature. */
  hall(w: number, h: number, d: number, x: number, z: number): this {
    return this.at(x, z, () => {
      const f = this.fate();
      if (f === 2) return this.heap(w, h, d, WALL, x, z);
      const wall = f === 1 ? shade(WALL, 0.55) : WALL;
      this.g.box(w, h, d, wall, x, h / 2, z);
      // Steel frame on the facades (pilasters every 15 m) and a dark plinth: the scale reads at a glance.
      const pil = shade(wall, 0.78);
      for (let px = -w / 2 + 7; px < w / 2; px += 15) {
        this.g.box(1.2, h, 0.8, pil, x + px, h / 2, z - d / 2 - 0.3).box(1.2, h, 0.8, pil, x + px, h / 2, z + d / 2 + 0.3);
      }
      this.g.box(w + 0.4, 1.4, d + 0.4, shade(wall, 0.55), x, 0.7, z);
      // Teeth across the hall's width: glazed north faces (dark), sloped roof sheets.
      const n = Math.max(3, Math.round(d / 14));
      const step = d / n, th = Math.min(7, step * 0.55);
      for (let i = 0; i < n; i++) {
        if (f === 1 && i % 3 === 1) continue; // a hole in the roof
        const z0 = z - d / 2 + i * step;
        // Profile (forward, up), forward = −z: a slope from z0 up to the glazed vertical face at z0 + step.
        this.g.profileX([[0, 0], [-step, 0], [-step, th], [-step + 0.6, th]], w, f === 1 ? CHAR : ROOF, x, h, z0);
        this.g.box(w, th * 0.9, 0.4, f === 1 ? CHAR : GLASS, x, h + th * 0.45, z0 + step - 0.3);
      }
      // Loading doors in the owner's colour on the front.
      for (let k = -1; k <= 1; k += 2) this.g.box(8, 7, 0.4, f === 1 ? CHAR : this.accent, x + k * w * 0.25, 3.5, z + d / 2 + 0.2);
      this.top = Math.max(this.top, h + th);
      return this;
    });
  }
  /** A chimney with the red and white bands near its top; broken off in a heavily damaged compound. */
  chimney(r0: number, h: number, x: number, z: number): this {
    return this.at(x, z, () => {
      const broken = this.state >= 3 ? true : this.state >= 2 ? this.r() < 0.7 : this.state === 1 ? this.r() < 0.3 : false;
      const hh = broken ? h * (0.25 + this.r() * 0.25) : h;
      this.g.cyl(r0 * 0.7, r0, hh, 14, broken ? shade(BRICK, 0.5) : BRICK, x, hh / 2, z);
      if (!broken) {
        this.g.cyl(r0 * 0.72, r0 * 0.74, h * 0.05, 14, RED, x, h * 0.9, z);
        this.g.cyl(r0 * 0.71, r0 * 0.72, h * 0.04, 14, WHITE, x, h * 0.85, z);
        this.g.cyl(r0 * 0.74, r0 * 0.75, h * 0.05, 14, RED, x, h * 0.8, z);
        this.g.cyl(r0 * 0.74, r0 * 0.74, 1, 14, CHAR, x, h + 0.2, z);
      }
      this.top = Math.max(this.top, hh);
      return this;
    });
  }
  /** A storage tank (domed); a heavily damaged compound has some burst and black. */
  tank(r0: number, h: number, x: number, z: number, color = WHITE): this {
    return this.at(x, z, () => {
      const f = this.fate();
      const hh = f === 2 ? h * 0.35 : h;
      const c = f >= 1 ? CHAR : color;
      this.g.cyl(r0, r0, hh, 18, c, x, hh / 2, z);
      if (f !== 2) this.g.sphere(r0, 16, 6, c, x, hh, z, 1, 0.25, 1);
      this.g.cyl(r0 + 0.4, r0 + 0.4, 0.6, 18, STEEL, x, hh * 0.5, z);
      this.top = Math.max(this.top, hh + r0 * 0.25);
      return this;
    });
  }
  /**
   * A fence line (posts and a mesh band) from (x0, z0) to (x1, z1). The band is built from short segments that drape
   * over the relief: one box a kilometre long, anchored at its middle, stood at the height of that one point and (with
   * the footing reaching down to the ground at its ends) turned into a wall hundreds of metres tall across a valley.
   */
  fence(x0: number, z0: number, x1: number, z1: number): this {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ry = Math.atan2(-(z1 - z0), x1 - x0);
    const segs = Math.max(1, Math.ceil(len / 20));
    const prev = this.g.drape;
    this.g.drape = true;
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      this.g.box(len / segs + 0.1, 2.2, 0.15, 0x6e7276, x0 + (x1 - x0) * t, 1.3, z0 + (z1 - z0) * t, 0, ry, 0);
    }
    this.g.drape = prev;
    const n = Math.min(40, Math.floor(len / 25));
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      this.g.box(0.3, 2.8, 0.3, 0x55595d, x0 + (x1 - x0) * t, 1.4, z0 + (z1 - z0) * t);
    }
    return this;
  }
  /** Fence around a square of half side `h`, with a gate gap on the +z side. */
  perimeter(h: number): this {
    this.fence(-h, -h, h, -h).fence(h, -h, h, h).fence(-h, -h, -h, h);
    this.fence(-h, h, -12, h).fence(12, h, h, h);
    this.g.box(3, 4, 3, WHITE, -14, 2, h).box(3, 4, 3, WHITE, 14, 2, h);
    this.g.box(26, 0.6, 0.6, RED, 0, 3, h + 1);
    return this;
  }
  /** A flat paved area (concrete, asphalt), a little above the ground. */
  pave(w: number, d: number, color: number, x = 0, z = 0, y = 0.25): this {
    // A grid that drapes over the ground vertex by vertex (civil.ts conforms it), so a 1 km apron never floats.
    const nx = Math.max(1, Math.min(24, Math.round(w / 40))), nz = Math.max(1, Math.min(24, Math.round(d / 40)));
    const plane = new THREE.PlaneGeometry(w, d, nx, nz).rotateX(-Math.PI / 2);
    this.g.drape = true;
    this.g.add(plane, color, x, y + 0.25, z);
    this.g.drape = false;
    return this;
  }
  /** A flag mast with the owner's colour. */
  flag(x: number, z: number, h = 18): this {
    return this.at(x, z, () => {
      this.g.cyl(0.25, 0.3, h, 6, STEEL, x, h / 2, z);
      this.g.box(6, 4, 0.2, this.accent, x + 3.2, h - 2.2, z);
      this.top = Math.max(this.top, h);
      return this;
    });
  }
  /** A lattice tower (four legs and braces) of side `s`, height `h`. */
  lattice(s: number, h: number, x: number, z: number, color = STEEL): this {
    return this.at(x, z, () => {
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.g.box(0.7, h, 0.7, color, x + a * s / 2, h / 2, z + b * s / 2, -b * 0.03, 0, a * 0.03);
      for (let y = 6; y < h; y += 8) {
        this.g.box(s, 0.4, 0.4, color, x, y, z - s / 2).box(s, 0.4, 0.4, color, x, y, z + s / 2);
        this.g.box(0.4, 0.4, s, color, x - s / 2, y, z).box(0.4, 0.4, s, color, x + s / 2, y, z);
      }
      this.top = Math.max(this.top, h);
      return this;
    });
  }
  /** A gantry crane: two legs, a boom across, a cab. */
  crane(span: number, h: number, x: number, z: number, ry = 0, color = YELLOW): this {
    return this.at(x, z, () => {
      const f = this.fate();
      const cs = Math.cos(ry), sn = Math.sin(ry);
      const at = (u: number, v: number): [number, number] => [x + u * cs + v * sn, z - u * sn + v * cs];
      if (f === 2) {
        const [ax, az] = at(0, 0);
        this.g.box(span * 1.4, 3, 3, shade(color, 0.4), ax, 2, az, 0.05, ry + 0.4, 0.2);
        return this;
      }
      for (const u of [-span / 2, span / 2]) for (const v of [-6, 6]) {
        const [px, pz] = at(u, v);
        this.g.box(1.6, h, 1.6, color, px, h / 2, pz, 0, ry, 0);
      }
      const [bx, bz] = at(0, 0);
      this.g.box(span + 4, 2.6, 14, color, bx, h, bz, 0, ry, 0);
      const [ox, oz] = at(0, -span * 0.9);
      this.g.box(span * 0.4, 2, 3, color, (bx + ox) / 2, h + 1, (bz + oz) / 2, 0, ry + Math.PI / 2, 0);
      this.g.box(5, 4, 5, WHITE, bx, h - 3, bz, 0, ry, 0);
      this.top = Math.max(this.top, h + 2);
      return this;
    });
  }
  build(): THREE.BufferGeometry {
    return this.g.build();
  }
}

/** Model of a structure type at its real size (metres, centred, y = 0 at the base) and its highest point. */
export interface CmdStructModel {
  geo: THREE.BufferGeometry;
  top: number;
}

/**
 * Build the command-mode model of a structure. `size`: the footprint side (m) the sim gives it at this level; `state`:
 * shared/damage damageState (0 intact, 1 damaged, 2 heavily damaged, 3 rubble: every building down, the chimneys
 * broken); `accent`: the owner's colour.
 */
export function buildCmdStructure(type: StructureType, level: number, state: number, size: number, accent: number, seed: number): CmdStructModel | null {
  const L = Math.max(1, Math.min(3, level | 0));
  const c = new Compound(seed * 31 + L * 7 + state, Math.min(3, state), accent);
  const r = c.r;
  const h = size / 2;
  switch (type) {
    case StructureType.Factory: {
      c.pave(size * 0.92, size * 0.92, APRON);
      c.perimeter(h * 0.92);
      // Halls in two rows; each level adds a pair.
      const halls = L * 2;
      for (let i = 0; i < halls; i++) {
        const row = i % 2, col = Math.floor(i / 2);
        c.hall(size * 0.22, 16 + r() * 4, size * 0.16, -h * 0.55 + col * size * 0.27, -h * 0.45 + row * size * 0.24);
      }
      c.bld(60, 14, 22, BRICK, ROOF_DARK, h * 0.55, h * 0.62).flag(h * 0.55 + 36, h * 0.62);
      for (let i = 0; i < L + 1; i++) c.chimney(4 + r(), 62 + L * 8 + r() * 10, h * 0.45 + i * 18, -h * 0.55 + r() * 20);
      for (let i = 0; i < 2 + L; i++) c.tank(10 + r() * 3, 12 + r() * 4, h * 0.25 + (i % 3) * 28, h * 0.05 + Math.floor(i / 3) * 28);
      c.pave(size * 0.5, 30, ASPHALT, -h * 0.2, h * 0.3);
      // Rail spur along one side.
      c.pave(size * 0.85, 5, 0x51483e, 0, -h * 0.85, 0.4);
      break;
    }
    case StructureType.Port: {
      c.pave(size * 0.95, size * 0.95, APRON);
      // Quay edge (the water side is -z on the drawn shore: the yard is slid so its quay meets it).
      c.g.box(size * 0.95, 4, 18, CONCRETE, 0, 2, -h * 0.9);
      for (let i = -5; i <= 5; i++) c.g.cyl(0.8, 1, 1.4, 8, CHAR, i * size * 0.08, 4.6, -h * 0.84);
      for (let i = 0; i < L + 1; i++) c.crane(30, 46 + r() * 6, -h * 0.6 + i * size * 0.28, -h * 0.72);
      for (let i = 0; i < L + 1; i++) c.bld(size * 0.18, 14, 40, WALL, ROOF, -h * 0.55 + i * size * 0.3, h * 0.45);
      // Container stacks in colours.
      const cols = [0xa3392f, 0x2f6aa3, 0x3f8a4a, 0xc9822e, 0x7d7d7d, accent];
      for (let row = 0; row < 3 + L; row++) for (let k = 0; k < 8; k++) {
        const n = 1 + Math.floor(r() * 4);
        for (let s = 0; s < n; s++) c.g.box(12, 2.5, 2.5, cols[Math.floor(r() * cols.length)], -h * 0.5 + k * 15, 1.5 + s * 2.6, -h * 0.35 + row * 4.2);
      }
      for (let i = 0; i < L; i++) c.tank(12, 14, h * 0.5 + i * 30, -h * 0.2);
      c.flag(h * 0.8, h * 0.8);
      break;
    }
    case StructureType.NavalYard: {
      c.pave(size * 0.95, size * 0.95, APRON);
      // Dry docks: long walled basins open to the water side, a hull in one.
      for (let i = 0; i < L; i++) {
        const x = -h * 0.55 + i * size * 0.3;
        c.g.box(60, 3, size * 0.55, 0x4c5a63, x, 0.2, -h * 0.3);
        c.g.box(4, 9, size * 0.55, CONCRETE, x - 31, 4.5, -h * 0.3).box(4, 9, size * 0.55, CONCRETE, x + 31, 4.5, -h * 0.3);
        if (i === 0) {
          c.g.box(24, 14, size * 0.4, 0x5e6870, x, 8, -h * 0.3);
          c.g.box(14, 10, 40, 0x6f7a82, x, 20, -h * 0.25);
        }
        c.crane(70, 60, x, -h * 0.3, Math.PI / 2, RED);
      }
      for (let i = 0; i < 2 + L; i++) c.bld(90, 26, 50, WALL, ROOF, h * 0.5, -h * 0.6 + i * 70);
      c.flag(-h * 0.8, h * 0.8);
      break;
    }
    case StructureType.Airbase: {
      c.pave(size * 0.92, size * 0.25, 0x6c6f69, 0, -h * 0.05);
      // Runway with threshold bars, centre line, numbers' stand-in.
      const rl = size * 0.86;
      c.pave(rl, 45, ASPHALT, 0, -h * 0.05, 0.55);
      c.g.drape = true;
      for (let k = -rl / 2 + 60; k < rl / 2 - 60; k += 50) c.g.box(30, 0.1, 1, WHITE, k, 0.85, -h * 0.05);
      for (const s of [-1, 1]) for (let j = -3; j <= 3; j++) c.g.box(30, 0.1, 1.8, WHITE, s * (rl / 2 - 22), 0.85, -h * 0.05 + j * 5.5);
      c.g.drape = false;
      c.pave(rl * 0.8, 20, ASPHALT, 0, h * 0.06, 0.5);
      c.pave(size * 0.3, size * 0.1, 0x6a6c68, -h * 0.35, h * 0.2, 0.45);
      // Hangars: half cylinders.
      for (let i = 0; i < 2 + L; i++) {
        const x = -h * 0.6 + i * 90, z = h * 0.28;
        const f = (state >= 3 || (state >= 2 && r() < 0.5));
        if (f) c.heap(60, 18, 50, STEEL, x, z);
        else {
          c.g.add(new THREE.CylinderGeometry(22, 22, 50, 18, 1, false, 0, Math.PI), state ? shade(STEEL, 0.7) : STEEL, x, 0, z, Math.PI / 2, 0, Math.PI / 2);
          c.g.box(40, 16, 0.5, CHAR, x, 8, z + 25);
          c.top = Math.max(c.top, 22);
        }
      }
      // Hardened shelters, the tower, fuel tanks.
      for (let i = 0; i < L * 2; i++) c.bld(26, 9, 30, 0x8a8a7e, 0x77776b, h * 0.15 + i * 40, h * 0.3);
      c.bld(14, 24, 14, WHITE, ROOF_DARK, h * 0.62, h * 0.18);
      c.g.box(18, 5, 18, GLASS, h * 0.62, 27, h * 0.18);
      c.top = Math.max(c.top, 30);
      for (let i = 0; i < L; i++) c.tank(9, 10, h * 0.75 + i * 22, h * 0.32);
      c.flag(h * 0.5, h * 0.2);
      break;
    }
    case StructureType.ArmyBase: {
      c.pave(size * 0.9, size * 0.9, 0x86826f);
      c.perimeter(h * 0.9);
      for (let i = 0; i < 2 + L * 2; i++) c.bld(70, 9, 16, 0xa39c84, ROOF_DARK, -h * 0.5 + (i % 3) * 90, -h * 0.55 + Math.floor(i / 3) * 40);
      c.bld(40, 14, 26, BRICK, ROOF_DARK, h * 0.45, -h * 0.5).flag(h * 0.45, -h * 0.2, 22);
      c.pave(120, 80, ASPHALT, h * 0.15, h * 0.3, 0.4);
      // Vehicle park: rows of olive vehicles under the sheds.
      for (let row = 0; row < 2 + L; row++) for (let k = 0; k < 8; k++) c.g.box(3.5, 2.6, 8, OLIVE, h * 0.15 - 50 + k * 12, 1.6, h * 0.3 - 30 + row * 14);
      for (let i = 0; i < L; i++) c.bld(80, 7, 22, 0x7a7466, 0x666158, -h * 0.4, h * 0.25 + i * 34);
      break;
    }
    case StructureType.DefensePost: {
      c.pave(size * 0.7, size * 0.7, EARTH);
      // Earth berm ring, sandbag walls, bunkers with slit fronts, a watchtower.
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        if (a === 4) continue; // the way in
        c.g.box(size * 0.22, 3, 6, EARTH, Math.cos(ang) * h * 0.72, 1.2, Math.sin(ang) * h * 0.72, 0, -ang + Math.PI / 2, 0);
      }
      for (let i = 0; i < L + 1; i++) {
        const ang = (i / (L + 1)) * Math.PI * 2 + 0.4, x = Math.cos(ang) * h * 0.4, z = Math.sin(ang) * h * 0.4;
        const f = (state >= 3 || (state >= 2 && r() < 0.6));
        if (f) c.heap(14, 4, 12, CONCRETE, x, z);
        else {
          c.g.prism([[-6, -7], [-6, 7], [6, 7], [6, -7]], [[-4, -5], [-4, 5], [4, 5], [4, -5]], 0, 4.5, state ? shade(CONCRETE, 0.6) : CONCRETE, x, 0, z);
          c.g.box(9, 0.8, 0.4, CHAR, x, 3, z - 6.1);
          c.top = Math.max(c.top, 4.5);
        }
        for (let k = 0; k < 5; k++) c.g.box(3, 1.2, 1.4, SAND, x - 6 + k * 3, 0.6, z + 9);
      }
      c.lattice(4, 12, -h * 0.2, h * 0.25, 0x6b5a44);
      c.g.box(6, 3, 6, 0x6b5a44, -h * 0.2, 13.5, h * 0.25);
      c.flag(h * 0.25, -h * 0.25, 12);
      break;
    }
    case StructureType.SamSite: {
      c.pave(size * 0.8, size * 0.8, 0x7e7a68);
      c.perimeter(h * 0.82);
      // Launchers in earth revetments around a radar and a command cabin.
      const n = 2 + L * 2;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2, x = Math.cos(ang) * h * 0.55, z = Math.sin(ang) * h * 0.55;
        for (let a = 0; a < 3; a++) c.g.box(18, 3, 4, EARTH, x + Math.cos(ang + 1.6 + a) * 12, 1.3, z + Math.sin(ang + 1.6 + a) * 12, 0, -(ang + 1.6 + a) + Math.PI / 2, 0);
        if ((state >= 3 || (state >= 2 && r() < 0.5))) {
          c.heap(10, 3, 4, OLIVE, x, z);
          continue;
        }
        c.g.box(3.4, 2.4, 10, state ? CHAR : OLIVE, x, 1.4, z, 0, -ang, 0);
        for (let k = -1; k <= 1; k += 2) c.g.box(1.1, 1.1, 7, state ? CHAR : 0x6d7650, x + k * 0.7, 4.4, z, 0.7, -ang, 0);
      }
      c.lattice(3, 10, 0, 0);
      c.g.box(9, 1, 2, STEEL, 0, 11, 0).box(7, 5, 0.5, 0xc8c8c0, 0, 13.5, 0, 0.3, 0, 0);
      c.bld(14, 4, 8, OLIVE, 0x4b5436, h * 0.2, -h * 0.25);
      c.top = Math.max(c.top, 16);
      break;
    }
    case StructureType.MissileSilo: {
      c.pave(size * 0.85, size * 0.85, 0xa29d8e);
      c.perimeter(h * 0.86);
      for (let i = 0; i < 3; i++) {
        const x = -h * 0.45 + i * h * 0.45, z = -h * 0.1;
        c.g.cyl(14, 14, 0.8, 24, YELLOW, x, 0.7, z);
        for (let k = 0; k < 12; k++) c.g.box(2.8, 0.2, 1.2, CHAR, x + Math.cos(k / 12 * Math.PI * 2) * 13, 1.15, z + Math.sin(k / 12 * Math.PI * 2) * 13, 0, -(k / 12) * Math.PI * 2, 0);
        const open = state >= 2;
        c.g.box(18, 1.4, 18, open ? CHAR : 0x7c7d78, x + (open ? 12 : 0), 1.6, z, 0, 0, open ? 0.25 : 0);
      }
      c.lattice(10, 26 + L * 4, h * 0.45, h * 0.3, RED);
      for (let i = 0; i < L; i++) c.bld(30, 6, 14, 0xa39c84, ROOF_DARK, -h * 0.4 + i * 40, h * 0.5);
      break;
    }
    case StructureType.Radar: {
      c.pave(size * 0.8, size * 0.8, 0x8f8b80);
      c.perimeter(h * 0.84);
      const th = 20 + L * 4;
      c.lattice(8, th, 0, 0);
      c.g.box(10, 2, 10, STEEL, 0, th, 0);
      const f = state >= 2;
      if (!f) c.g.sphere(9 + L, 20, 14, state ? 0x8b8780 : WHITE, 0, th + 9 + L, 0);
      else c.heap(14, 6, 14, WHITE, 6, 8);
      c.top = Math.max(c.top, th + 18 + L * 2);
      for (let i = 0; i < L; i++) c.bld(16, 5, 9, 0xa39c84, ROOF_DARK, -h * 0.45 + i * 22, h * 0.4);
      c.lattice(2, 14, h * 0.45, -h * 0.3).g.box(0.4, 7, 7, 0xd0d0c8, h * 0.45, 15, -h * 0.3, 0, 0.6, 0);
      break;
    }
    default:
      return null;
  }
  return { geo: c.build(), top: c.top };
}
