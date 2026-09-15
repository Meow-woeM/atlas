import { describe, it, expect } from 'vitest';
import { makeRng, fork, hash32 } from './rng';

describe('rng', () => {
  it('same seed gives the same sequence', () => {
    const a = makeRng('atlas');
    const b = makeRng('atlas');
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds differ', () => {
    const a = makeRng('atlas-1');
    const b = makeRng('atlas-2');
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    expect(same).toBeLessThan(3);
  });

  it('forks are independent of parent consumption and equal to fork()', () => {
    const p1 = makeRng('s');
    const p2 = makeRng('s');
    p2.next(); p2.next();
    const c1 = p1.fork('x');
    const c2 = p2.fork('x');
    const c3 = fork('s', 'x');
    for (let i = 0; i < 50; i++) {
      const v = c1.next();
      expect(c2.next()).toBe(v);
      expect(c3.next()).toBe(v);
    }
  });

  it('is roughly uniform over 1e5 draws', () => {
    const r = makeRng('uniform');
    const bins = new Int32Array(10);
    for (let i = 0; i < 100000; i++) bins[Math.floor(r.next() * 10)]++;
    for (let i = 0; i < 10; i++) expect(Math.abs(bins[i] - 10000)).toBeLessThan(500);
  });

  it('int is inclusive on both ends', () => {
    const r = makeRng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect(seen.size).toBe(3);
  });

  it('gaussian has the requested moments', () => {
    const r = makeRng('gauss');
    let sum = 0, sq = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) { const v = r.gaussian(2, 3); sum += v; sq += v * v; }
    const mean = sum / n;
    const sd = Math.sqrt(sq / n - mean * mean);
    expect(Math.abs(mean - 2)).toBeLessThan(0.05);
    expect(Math.abs(sd - 3)).toBeLessThan(0.05);
  });

  it('hash32 is stable', () => {
    expect(hash32('atlas')).toBe(hash32('atlas'));
    expect(hash32('atlas')).not.toBe(hash32('atlas ')); 
  });
});
