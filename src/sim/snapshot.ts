// FRONT ULTRA — object-graph snapshots for the save framework (DESIGN_V2 §12.8). Owner: sim-core (W1). Worker-only.
//
// The simulation state is a graph of class instances (players, units, structures, offensives, the systems, the AI
// brains and the world events) with shared references (a unit sits in unitMap, unitsByOwner, the unit grid and a
// front's armor list; a path array is shared with the navigation cache). Writing each system's fields by hand would
// be long and fragile, so the graph is encoded generically:
//
//   * every object is written once and referenced by id (shared references and cycles survive the round trip);
//   * arrays, Maps, Sets and typed arrays (raw or run-length encoded) are first-class;
//   * class instances carry the index of their class in a fixed REGISTRY and get their prototype back on load;
//   * functions are never written; the objects that hold them (the systems) are MERGED on load into the instances
//     of a freshly constructed game, which also keeps the large arrays derived from the map (SKIP lists).
//
// Anything reachable that is not registered is a bug and throws (SaveError), so a new class cannot be silently lost.

import { SaveError, type SaveReader, type SaveWriter } from './save';

type Ctor = abstract new (...args: never[]) => unknown;

interface Entry {
  k: 'A' | 'M' | 'S' | 'T' | 'O';
  v?: unknown[];
  /** Typed array: constructor name, binary chunk index, run-length encoded. */
  t?: string;
  b?: number;
  rle?: boolean;
  n?: number;
  /** Object: class index (-1 = plain object) and fields. */
  c?: number;
  f?: Record<string, unknown>;
}

const TYPED: Record<string, new (n: number) => ArrayLike<number> & { [i: number]: number; buffer: ArrayBufferLike; byteOffset: number; byteLength: number; length: number }> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
};

type AnyTyped = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

export interface GraphSpec {
  /** Every class whose instances may be reached (order is part of the format: append only). */
  classes: readonly Ctor[];
  /** Fields not written (derived, scratch or huge map-derived arrays), by class. */
  skip: ReadonlyMap<Ctor, ReadonlySet<string>>;
}

function isSkipped(spec: GraphSpec, o: object, key: string): boolean {
  const s = spec.skip.get((o as { constructor: Ctor }).constructor);
  return !!s && s.has(key);
}

/** Encode the graph reachable from `roots` into the writer. */
export function writeGraph(w: SaveWriter, spec: GraphSpec, roots: unknown[]): void {
  const ids = new Map<object, number>();
  const entries: (Entry | null)[] = [];
  const bins: Uint8Array[] = [];
  const stack: object[] = [];

  const ref = (o: object): number => {
    let id = ids.get(o);
    if (id !== undefined) return id;
    id = entries.length;
    ids.set(o, id);
    entries.push(null);
    stack.push(o);
    return id;
  };
  const val = (v: unknown): unknown => {
    switch (typeof v) {
      case 'number': return Number.isFinite(v) ? v : { n: String(v) };
      case 'string':
      case 'boolean': return v;
      case 'undefined': return { u: 1 };
      case 'object': return v === null ? null : { r: ref(v) };
      default: throw new SaveError(`cannot save a ${typeof v}`);
    }
  };
  const encode = (o: object): Entry => {
    if (Array.isArray(o)) return { k: 'A', v: o.map(val) };
    if (o instanceof Map) return { k: 'M', v: [...o].map(([a, b]) => [val(a), val(b)]) };
    if (o instanceof Set) return { k: 'S', v: [...o].map(val) };
    if (ArrayBuffer.isView(o)) {
      const a = o as AnyTyped;
      const name = a.constructor.name;
      if (!TYPED[name]) throw new SaveError(`cannot save a ${name}`);
      // Run-length encode when it pays (owner, fallout, capture and siege arrays are mostly long runs).
      let runs = 0;
      for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1]) runs++;
      if (a.length > 64 && runs * 3 < a.length) {
        const values = new (TYPED[name])(runs) as AnyTyped;
        const counts = new Uint32Array(runs);
        let r = -1;
        for (let i = 0; i < a.length; i++) {
          if (i === 0 || a[i] !== a[i - 1]) values[++r] = a[i];
          counts[r]++;
        }
        bins.push(new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice());
        bins.push(new Uint8Array(counts.buffer).slice());
        return { k: 'T', t: name, b: bins.length - 2, rle: true, n: a.length };
      }
      bins.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice());
      return { k: 'T', t: name, b: bins.length - 1, n: a.length };
    }
    const proto = Object.getPrototypeOf(o);
    let c = -1;
    if (proto !== Object.prototype && proto !== null) {
      c = spec.classes.indexOf(proto.constructor as Ctor);
      if (c < 0) throw new SaveError(`cannot save an instance of ${proto.constructor?.name ?? 'an unknown class'}`);
    }
    const f: Record<string, unknown> = {};
    for (const key of Object.keys(o)) {
      if (c >= 0 && isSkipped(spec, o, key)) continue;
      const v = (o as Record<string, unknown>)[key];
      if (typeof v === 'function') continue;
      f[key] = val(v);
    }
    return { k: 'O', c, f };
  };

  const rootVals = roots.map(val);
  while (stack.length) {
    const o = stack.pop()!;
    entries[ids.get(o)!] = encode(o);
  }
  w.json({ roots: rootVals, entries });
  w.u32(bins.length);
  for (const b of bins) {
    w.u32(b.length);
    w.bytes(b);
  }
}

/**
 * Decode a graph written by writeGraph. `merge` maps root indices to live objects the decoded fields are assigned
 * onto (their class's SKIP fields and functions stay as they are); nested fields that hold an object of a merged
 * class on the live side are merged too (the systems hanging off the Game).
 */
export function readGraph(r: SaveReader, spec: GraphSpec, merge: (object | null)[], mergeClasses: ReadonlySet<Ctor>): unknown[] {
  const { roots, entries } = r.json<{ roots: unknown[]; entries: Entry[] }>();
  const nb = r.u32();
  const bins: Uint8Array[] = [];
  for (let i = 0; i < nb; i++) bins.push(r.u8a());
  const out: unknown[] = new Array(entries.length);
  const preset = new Map<number, object>();

  // Seed the merge targets: the roots, then (recursively) their fields that hold merged classes on the live side.
  const seed = (id: number, live: object): void => {
    if (preset.has(id)) return;
    preset.set(id, live);
    const e = entries[id];
    if (!e || e.k !== 'O' || !e.f) return;
    for (const [key, v] of Object.entries(e.f)) {
      const lv = (live as Record<string, unknown>)[key];
      if (!lv || typeof lv !== 'object' || !v || typeof v !== 'object' || !('r' in (v as object))) continue;
      if (mergeClasses.has((lv as { constructor: Ctor }).constructor)) seed((v as { r: number }).r, lv);
    }
  };
  roots.forEach((rv, i) => {
    const live = merge[i];
    if (live && rv && typeof rv === 'object' && 'r' in (rv as object)) seed((rv as { r: number }).r, live);
  });

  const val = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const o = v as { r?: number; n?: string; u?: number };
    if (o.u) return undefined;
    if (o.n !== undefined) return Number(o.n);
    return get(o.r!);
  };
  const get = (id: number): unknown => {
    if (out[id] !== undefined) return out[id];
    const e = entries[id];
    switch (e.k) {
      case 'A': {
        const a: unknown[] = [];
        out[id] = a;
        for (const x of e.v!) a.push(val(x));
        return a;
      }
      case 'M': {
        const m = new Map<unknown, unknown>();
        out[id] = m;
        for (const [a, b] of e.v as [unknown, unknown][]) m.set(val(a), val(b));
        return m;
      }
      case 'S': {
        const s = new Set<unknown>();
        out[id] = s;
        for (const x of e.v!) s.add(val(x));
        return s;
      }
      case 'T': {
        const C = TYPED[e.t!];
        if (!C) throw new SaveError(`unknown array type ${e.t}`);
        const elem = (C as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
        let a: AnyTyped;
        if (e.rle) {
          const vb = bins[e.b!], cb = bins[e.b! + 1];
          const values = new (C)(vb.byteLength / elem) as AnyTyped;
          new Uint8Array(values.buffer).set(vb);
          const counts = new Uint32Array(cb.buffer.slice(cb.byteOffset, cb.byteOffset + cb.byteLength));
          a = new (C)(e.n!) as AnyTyped;
          let p = 0;
          for (let i = 0; i < values.length; i++) {
            a.fill(values[i], p, p + counts[i]);
            p += counts[i];
          }
          if (p !== e.n) throw new SaveError('corrupt array in save');
        } else {
          const b = bins[e.b!];
          a = new (C)(b.byteLength / elem) as AnyTyped;
          new Uint8Array(a.buffer).set(b);
        }
        out[id] = a;
        return a;
      }
      case 'O': {
        const live = preset.get(id);
        let o: Record<string, unknown>;
        if (live) o = live as Record<string, unknown>;
        else if (e.c! < 0) o = {};
        else {
          const C = spec.classes[e.c!];
          if (!C) throw new SaveError('save refers to an unknown class');
          o = Object.create(C.prototype) as Record<string, unknown>;
        }
        out[id] = o;
        for (const [key, v] of Object.entries(e.f!)) {
          if (live && isSkipped(spec, live, key)) continue;
          if (live && typeof o[key] === 'function') continue;
          o[key] = val(v);
        }
        return o;
      }
    }
    throw new SaveError('corrupt save entry');
  };
  return roots.map(val);
}
