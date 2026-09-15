/**
 * core/heap.ts — Stage 0 helper (no stage of its own): binary min-heap keyed on (key, id).
 * RNG stream: none. Inputs: push(key, id) pairs. Outputs: pop() returns ids in ascending
 * (key, id) order, ties broken by the smaller id so results are deterministic regardless of
 * insertion order. Used by priority-flood (hydrology) and Dijkstra-style sweeps.
 *
 * Backed by a Float64Array of keys and an Int32Array of ids that double in size when the
 * capacity is exceeded. No per-push allocation in the steady state.
 */

export class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  private n: number;

  constructor(capacity: number) {
    const cap = capacity > 0 ? Math.floor(capacity) : 16;
    this.keys = new Float64Array(cap);
    this.ids = new Int32Array(cap);
    this.n = 0;
  }

  /** Number of entries currently in the heap. */
  get size(): number {
    return this.n;
  }

  /** Insert (key, id). Grows the backing arrays if full. */
  push(key: number, id: number): void {
    if (this.n === this.keys.length) this.grow();
    const keys = this.keys;
    const ids = this.ids;
    let i = this.n++;
    // Sift up.
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pk = keys[parent];
      if (pk < key || (pk === key && ids[parent] <= id)) break;
      keys[i] = pk;
      ids[i] = ids[parent];
      i = parent;
    }
    keys[i] = key;
    ids[i] = id;
  }

  /** Remove and return the id with the smallest (key, id); -1 when empty. */
  pop(): number {
    if (this.n === 0) return -1;
    const keys = this.keys;
    const ids = this.ids;
    const top = ids[0];
    const n = --this.n;
    if (n > 0) {
      const key = keys[n];
      const id = ids[n];
      let i = 0;
      // Sift down.
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        const right = child + 1;
        if (right < n) {
          const ck = keys[child], rk = keys[right];
          if (rk < ck || (rk === ck && ids[right] < ids[child])) child = right;
        }
        const ck = keys[child];
        if (key < ck || (key === ck && id <= ids[child])) break;
        keys[i] = ck;
        ids[i] = ids[child];
        i = child;
      }
      keys[i] = key;
      ids[i] = id;
    }
    return top;
  }

  /** Smallest key without removing it; NaN when empty. */
  peekKey(): number {
    return this.n === 0 ? NaN : this.keys[0];
  }

  /** Remove every entry (keeps the backing arrays). */
  clear(): void {
    this.n = 0;
  }

  private grow(): void {
    const cap = this.keys.length * 2;
    const keys = new Float64Array(cap);
    const ids = new Int32Array(cap);
    keys.set(this.keys);
    ids.set(this.ids);
    this.keys = keys;
    this.ids = ids;
  }
}
