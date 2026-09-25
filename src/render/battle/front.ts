// FRONT ULTRA — ground battle: local contact-line geometry (owner: battle).
// The sim's FrontView polyline (25 km tiles) is straight at the scale of the battlefield, so locally the front is
// a line through the anchor (tangent T, normal N pointing from the attacker A toward the defender B) plus a
// deterministic meander o(u) of a few hundred meters, sampled FRONT_SAMPLES times over [-halfLen, halfLen] and
// shared with the shaders (no-man's-land belt, trenches). Side A lives at v < 0, side B at v > 0.

import * as THREE from 'three';
import { FRONT_SAMPLES, noise1, type BattleUniforms } from './common';

export class FrontGeom {
  cx = 0;
  cz = 0;
  tx = 1;
  tz = 0;
  nx = 0;
  nz = 1;
  halfLen = 6000;
  readonly o = new Float32Array(FRONT_SAMPLES);
  /** +1: A is pushing forward, -1: A is being pushed back (same for B from its side). */
  pushA = 1;
  pushB = -0.2;
  /** Accumulated visual drift of the line toward B (m). */
  drift = 0;
  private seed = 1;

  /** Set up from a local advance direction (A -> B) in local xz and a seed. */
  setup(dirX: number, dirZ: number, seed: number, halfLen: number): void {
    const l = Math.hypot(dirX, dirZ) || 1;
    this.nx = dirX / l;
    this.nz = dirZ / l;
    // Tangent: N rotated -90 degrees (so (T, N) is a right-handed pair on the ground).
    this.tx = this.nz;
    this.tz = -this.nx;
    this.cx = 0;
    this.cz = 0;
    this.halfLen = halfLen;
    this.seed = seed;
    this.drift = 0;
    this.rebuild();
  }

  rebuild(): void {
    for (let k = 0; k < FRONT_SAMPLES; k++) {
      const u = -this.halfLen + (2 * this.halfLen * k) / (FRONT_SAMPLES - 1);
      this.o[k] = this.meander(u);
    }
  }

  meander(u: number): number {
    return noise1(u / 900, this.seed) * 130 + noise1(u / 260, this.seed + 3) * 35 + this.drift;
  }

  offsetAt(u: number): number {
    const f = Math.min(1, Math.max(0, (u + this.halfLen) / (2 * this.halfLen))) * (FRONT_SAMPLES - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(FRONT_SAMPLES - 1, i0 + 1);
    const t = f - i0;
    return this.o[i0] * (1 - t) + this.o[i1] * t;
  }

  /** Local xz from along-line u and signed distance v from the contact line (v > 0 toward B). */
  toXZ(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
    const off = this.offsetAt(u) + v;
    out.x = this.cx + this.tx * u + this.nx * off;
    out.z = this.cz + this.tz * u + this.nz * off;
    out.y = 0;
    return out;
  }

  /** (u, signed v) of a local point. */
  coords(x: number, z: number, out: THREE.Vector2): THREE.Vector2 {
    const rx = x - this.cx, rz = z - this.cz;
    const u = rx * this.tx + rz * this.tz;
    const v = rx * this.nx + rz * this.nz - this.offsetAt(u);
    return out.set(u, v);
  }

  apply(u: BattleUniforms): void {
    u.uFrontC.value.set(this.cx, this.cz);
    u.uFrontT.value.set(this.tx, this.tz);
    u.uFrontN.value.set(this.nx, this.nz);
    u.uFrontL.value = this.halfLen;
    const arr = u.uFrontO.value;
    for (let k = 0; k < FRONT_SAMPLES; k++) arr[k] = this.o[k];
  }
}
