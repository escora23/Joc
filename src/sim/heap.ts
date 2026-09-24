// FRONT ULTRA — typed-array binary min-heap of (priority, tile) pairs. Owner: sim-core. Worker-safe.
// Used by the frontier conquest queues (one per attack) and by the water A* open list. No per-push allocation
// once grown; ties are broken by insertion position (deterministic).

export class TileHeap {
  private pri: Float64Array;
  private val: Int32Array;
  private n = 0;

  constructor(capacity = 256) {
    this.pri = new Float64Array(capacity);
    this.val = new Int32Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(value: number, priority: number): void {
    if (this.n === this.val.length) this.grow();
    let i = this.n++;
    const pri = this.pri, val = this.val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pri[p] <= priority) break;
      pri[i] = pri[p];
      val[i] = val[p];
      i = p;
    }
    pri[i] = priority;
    val[i] = value;
  }

  /** Smallest priority value (undefined behaviour when empty). */
  peekPriority(): number {
    return this.pri[0];
  }

  peek(): number {
    return this.val[0];
  }

  /** Removes and returns the value with the smallest priority (-1 when empty). */
  pop(): number {
    if (this.n === 0) return -1;
    const pri = this.pri, val = this.val;
    const top = val[0];
    const n = --this.n;
    if (n > 0) {
      const lp = pri[n], lv = val[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= lp) break;
        pri[i] = pri[c];
        val[i] = val[c];
        i = c;
      }
      pri[i] = lp;
      val[i] = lv;
    }
    return top;
  }

  private grow(): void {
    const cap = this.val.length * 2;
    const p = new Float64Array(cap);
    p.set(this.pri);
    const v = new Int32Array(cap);
    v.set(this.val);
    this.pri = p;
    this.val = v;
  }
}
