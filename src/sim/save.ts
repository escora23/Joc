// FRONT ULTRA — save framework (DESIGN_V2 §12.8). Owner: sim-core (W1). Worker-safe, no DOM.
//
// A save is a versioned binary blob: the magic "FUSAVE", the format version, the game version, a hash of the
// WorldInit it was made on, then the sections written by every system's `serialize(w)` in a fixed order and read back
// by `restore(r)` in the same order. Primitive values are little-endian; typed arrays are copied raw (owner arrays are
// run-length encoded); structured records (players, units, AI brains...) are written as JSON strings, which keeps each
// system's (de)serialiser short and readable while staying a few MB for a mid-game world.
//
// A blob from another format version or another world is refused with a clear message, never half-loaded.

export const SAVE_MAGIC = 'FUSAVE';
/** Bump when the layout of any section changes. */
export const SAVE_FORMAT_VERSION = 1;
export const GAME_VERSION = '0.2.0';

export class SaveError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class SaveWriter {
  private buf = new Uint8Array(1 << 20);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }
  str(s: string): void {
    const b = enc.encode(s);
    this.u32(b.length);
    this.bytes(b);
  }
  json(v: unknown): void {
    this.str(JSON.stringify(v));
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  /** A typed array copied raw (length in elements first). */
  typed(a: Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array): void {
    this.u32(a.length);
    this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  /** Run-length encoded Uint16Array (owner arrays: long runs of the same owner). */
  rle16(a: Uint16Array): void {
    this.u32(a.length);
    let runs = 0;
    const start = this.pos;
    this.u32(0);
    let i = 0;
    while (i < a.length) {
      const v = a[i];
      let j = i + 1;
      while (j < a.length && a[j] === v && j - i < 0xffffffff) j++;
      this.u32(j - i);
      this.ensure(2);
      this.view.setUint16(this.pos, v, true);
      this.pos += 2;
      runs++;
      i = j;
    }
    this.view.setUint32(start, runs, true);
  }
  /** Section marker: restore checks it to catch a system reading more or less than it wrote. */
  section(name: string): void {
    this.str(`§${name}`);
  }
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.pos).buffer;
  }
}

export class SaveReader {
  private readonly view: DataView;
  private readonly buf: Uint8Array;
  private pos = 0;

  constructor(blob: ArrayBuffer) {
    this.buf = new Uint8Array(blob);
    this.view = new DataView(blob);
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new SaveError('save file truncated');
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  str(): string {
    const n = this.u32();
    this.need(n);
    const s = dec.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  json<T>(): T {
    return JSON.parse(this.str()) as T;
  }
  private raw(bytes: number): ArrayBuffer {
    this.need(bytes);
    const out = this.buf.slice(this.pos, this.pos + bytes).buffer;
    this.pos += bytes;
    return out;
  }
  u8a(): Uint8Array { const n = this.u32(); return new Uint8Array(this.raw(n)); }
  u16a(): Uint16Array { const n = this.u32(); return new Uint16Array(this.raw(n * 2)); }
  i16a(): Int16Array { const n = this.u32(); return new Int16Array(this.raw(n * 2)); }
  u32a(): Uint32Array { const n = this.u32(); return new Uint32Array(this.raw(n * 4)); }
  i32a(): Int32Array { const n = this.u32(); return new Int32Array(this.raw(n * 4)); }
  f32a(): Float32Array { const n = this.u32(); return new Float32Array(this.raw(n * 4)); }
  f64a(): Float64Array { const n = this.u32(); return new Float64Array(this.raw(n * 8)); }
  /** Reads an RLE Uint16Array into `out` (length must match). */
  rle16(out: Uint16Array): void {
    const n = this.u32();
    if (n !== out.length) throw new SaveError(`owner array size ${n} != ${out.length}`);
    const runs = this.u32();
    let p = 0;
    for (let i = 0; i < runs; i++) {
      const len = this.u32();
      this.need(2);
      const v = this.view.getUint16(this.pos, true);
      this.pos += 2;
      if (p + len > out.length) throw new SaveError('owner array overflow');
      out.fill(v, p, p + len);
      p += len;
    }
    if (p !== out.length) throw new SaveError('owner array underflow');
  }
  section(name: string): void {
    const got = this.str();
    if (got !== `§${name}`) throw new SaveError(`save section mismatch: expected ${name}, found ${got.slice(1, 40)}`);
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

/** FNV-1a over the WorldInit arrays: a save only loads on the world it was made on. */
export function worldHash(world: { terrain: Uint8Array; country: Uint16Array; landTiles: number }): number {
  let h = 0x811c9dc5;
  const t = world.terrain;
  for (let i = 0; i < t.length; i += 7) {
    h ^= t[i];
    h = Math.imul(h, 0x01000193);
  }
  const c = world.country;
  for (let i = 0; i < c.length; i += 11) {
    h ^= c[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= world.landTiles;
  return Math.imul(h, 0x01000193) >>> 0;
}

/** v2 (W3): read a save's header without restoring it (the main thread needs the config to show and resume it). */
export function peekSaveHeader(blob: ArrayBuffer): { format: number; version: string; worldHash: number; config: unknown } | null {
  try {
    const r = new SaveReader(blob);
    if (r.str() !== SAVE_MAGIC) return null;
    const format = r.u32();
    const version = r.str();
    const worldHash = r.u32();
    const config = r.json<unknown>();
    return { format, version, worldHash, config };
  } catch {
    return null;
  }
}
