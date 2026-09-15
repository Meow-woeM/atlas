import { describe, it, expect } from 'vitest';
import { MinHeap } from './heap';
import { makeRng } from './rng';

describe('MinHeap', () => {
  it('pops in ascending key order', () => {
    const h = new MinHeap(4);
    const keys = [5, 3, 9, 1, 7, 2, 8, 6, 4, 0];
    keys.forEach((k, i) => h.push(k, 100 + i));
    expect(h.size).toBe(10);
    const out: number[] = [];
    while (h.size > 0) out.push(h.pop());
    expect(out.map((id) => keys[id - 100])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('breaks key ties by the smaller id regardless of insertion order', () => {
    const h = new MinHeap(16);
    h.push(1, 9); h.push(1, 3); h.push(0, 7); h.push(1, 5); h.push(1, 1); h.push(0, 2);
    expect(h.pop()).toBe(2);
    expect(h.pop()).toBe(7);
    expect(h.pop()).toBe(1);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(5);
    expect(h.pop()).toBe(9);
    expect(h.pop()).toBe(-1);
    expect(h.size).toBe(0);
  });

  it('returns -1 when empty and recovers after emptying', () => {
    const h = new MinHeap(2);
    expect(h.pop()).toBe(-1);
    h.push(3, 0);
    expect(h.pop()).toBe(0);
    expect(h.pop()).toBe(-1);
    h.push(2, 1);
    h.push(1, 2);
    expect(h.pop()).toBe(2);
    expect(h.pop()).toBe(1);
  });

  it('grows past its initial capacity', () => {
    const h = new MinHeap(1);
    for (let i = 99; i >= 0; i--) h.push(i, i);
    expect(h.size).toBe(100);
    for (let i = 0; i < 100; i++) expect(h.pop()).toBe(i);
  });

  it('1e5 random pushes and pops match a sorted array (with duplicate keys)', () => {
    const rng = makeRng('heap');
    const N = 100000;
    const key = new Float64Array(N);
    for (let i = 0; i < N; i++) key[i] = Math.floor(rng.next() * 1000);   // many ties
    const h = new MinHeap(64);
    const order: number[] = [];
    for (let i = 0; i < N; i++) order.push(i);
    rng.shuffle(order);
    for (let i = 0; i < N; i++) h.push(key[order[i]], order[i]);
    expect(h.size).toBe(N);

    const expected = new Int32Array(N);
    for (let i = 0; i < N; i++) expected[i] = i;
    expected.sort((a, b) => key[a] - key[b] || a - b);

    for (let i = 0; i < N; i++) expect(h.pop()).toBe(expected[i]);
    expect(h.pop()).toBe(-1);
  });

  it('interleaved pushes and pops behave like a priority queue', () => {
    const rng = makeRng('heap-interleaved');
    const h = new MinHeap(8);
    const ref: { key: number; id: number }[] = [];
    let nextId = 0;
    for (let step = 0; step < 20000; step++) {
      if (ref.length === 0 || rng.next() < 0.6) {
        const key = rng.int(0, 50);
        h.push(key, nextId);
        ref.push({ key, id: nextId });
        nextId++;
      } else {
        let best = 0;
        for (let i = 1; i < ref.length; i++) {
          const a = ref[i], b = ref[best];
          if (a.key < b.key || (a.key === b.key && a.id < b.id)) best = i;
        }
        const want = ref[best].id;
        ref.splice(best, 1);
        expect(h.pop()).toBe(want);
      }
      expect(h.size).toBe(ref.length);
    }
  });

  it('peekKey reports the top key and clear empties the heap', () => {
    const h = new MinHeap(4);
    expect(Number.isNaN(h.peekKey())).toBe(true);
    h.push(4, 1); h.push(2, 2); h.push(3, 3);
    expect(h.peekKey()).toBe(2);
    h.clear();
    expect(h.size).toBe(0);
    expect(h.pop()).toBe(-1);
  });
});
