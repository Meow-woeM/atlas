import { describe, it, expect } from 'vitest';
import { makeRng } from './rng';
import { makeSimplex3, fbm3, makeValueNoise2, makeValueNoise1 } from './noise';

/** Deterministic sample stream for the range tests (does not touch the noise rng). */
function sampler(seed: string): () => number {
  const r = makeRng(seed);
  return () => r.float(-50, 50);
}

describe('makeSimplex3', () => {
  it('is deterministic for the same rng seed', () => {
    const a = makeSimplex3(makeRng('noise'));
    const b = makeSimplex3(makeRng('noise'));
    const s = sampler('samples');
    for (let i = 0; i < 1000; i++) {
      const x = s(), y = s(), z = s();
      expect(a(x, y, z)).toBe(b(x, y, z));
    }
  });

  it('differs for different seeds', () => {
    const a = makeSimplex3(makeRng('noise-1'));
    const b = makeSimplex3(makeRng('noise-2'));
    let same = 0;
    const s = sampler('samples');
    for (let i = 0; i < 200; i++) {
      const x = s(), y = s(), z = s();
      if (a(x, y, z) === b(x, y, z)) same++;
    }
    expect(same).toBeLessThan(10);
  });

  it('stays within -1..1 over 10k samples and actually varies', () => {
    const n = makeSimplex3(makeRng('noise'));
    const s = sampler('samples');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 10000; i++) {
      const v = n(s(), s(), s());
      expect(Number.isFinite(v)).toBe(true);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(-0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it('is continuous (small step, small change) and zero at lattice origin', () => {
    const n = makeSimplex3(makeRng('noise'));
    expect(n(0, 0, 0)).toBe(0);
    const s = sampler('samples');
    for (let i = 0; i < 1000; i++) {
      const x = s(), y = s(), z = s();
      expect(Math.abs(n(x + 1e-4, y, z) - n(x, y, z))).toBeLessThan(0.01);
    }
  });

  it('samples on the unit sphere are in range', () => {
    const n = makeSimplex3(makeRng('noise'));
    const r = makeRng('sphere');
    for (let i = 0; i < 2000; i++) {
      const lat = r.float(-Math.PI / 2, Math.PI / 2);
      const lon = r.float(-Math.PI, Math.PI);
      const c = Math.cos(lat);
      const v = n(3 * c * Math.cos(lon), 3 * Math.sin(lat), 3 * c * Math.sin(lon));
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('fbm3', () => {
  it('is deterministic and within -1..1 with 6 octaves, lacunarity 2, gain 0.5', () => {
    const n = makeSimplex3(makeRng('noise'));
    const s = sampler('samples');
    for (let i = 0; i < 10000; i++) {
      const x = s(), y = s(), z = s();
      const v = fbm3(n, x, y, z, 6, 2, 0.5);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(fbm3(n, x, y, z, 6, 2, 0.5)).toBe(v);
    }
  });

  it('with one octave equals the base noise; with zero octaves returns 0', () => {
    const n = makeSimplex3(makeRng('noise'));
    expect(fbm3(n, 0.3, 0.7, 1.1, 1, 2, 0.5)).toBeCloseTo(n(0.3, 0.7, 1.1), 12);
    expect(fbm3(n, 0.3, 0.7, 1.1, 0, 2, 0.5)).toBe(0);
  });

  it('is the amplitude-normalized octave sum', () => {
    const n = makeSimplex3(makeRng('noise'));
    const x = 0.31, y = -0.42, z = 2.7;
    const expected = (n(x, y, z) + 0.5 * n(2 * x, 2 * y, 2 * z) + 0.25 * n(4 * x, 4 * y, 4 * z)) / 1.75;
    expect(fbm3(n, x, y, z, 3, 2, 0.5)).toBeCloseTo(expected, 12);
  });
});

describe('makeValueNoise2', () => {
  it('is deterministic for the same seed', () => {
    const a = makeValueNoise2(makeRng('grain'));
    const b = makeValueNoise2(makeRng('grain'));
    const s = sampler('samples');
    for (let i = 0; i < 1000; i++) {
      const x = s(), y = s();
      expect(a(x, y)).toBe(b(x, y));
    }
  });

  it('stays within -1..1 over 10k samples', () => {
    const n = makeValueNoise2(makeRng('grain'));
    const s = sampler('samples');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 10000; i++) {
      const v = n(s(), s());
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(1);
  });

  it('returns the lattice value exactly at integer coordinates', () => {
    const n = makeValueNoise2(makeRng('grain'));
    // Quintic fade is exactly 0 at 0, so integer inputs hit the lattice; halfway between two
    // lattice points along x the value is the mean of the two lattice values.
    const v0 = n(3, 5), v1 = n(4, 5);
    expect(n(3.5, 5)).toBeCloseTo((v0 + v1) / 2, 6);
  });

  it('tiles with the given period in both axes', () => {
    const period = 8;
    const n = makeValueNoise2(makeRng('grain'), period);
    const s = sampler('samples');
    for (let i = 0; i < 2000; i++) {
      const x = s(), y = s();
      const v = n(x, y);
      expect(n(x + period, y)).toBeCloseTo(v, 6);
      expect(n(x, y + period)).toBeCloseTo(v, 6);
      expect(n(x - 3 * period, y + 2 * period)).toBeCloseTo(v, 6);
    }
    // Sanity: the field is not constant inside a tile.
    expect(n(0.5, 0.5)).not.toBe(n(2.5, 4.5));
  });

  it('does not tile at a non-period offset', () => {
    const n = makeValueNoise2(makeRng('grain'), 8);
    let diff = 0;
    for (let i = 0; i < 100; i++) if (Math.abs(n(i * 0.37, 1.3) - n(i * 0.37 + 3, 1.3)) > 1e-6) diff++;
    expect(diff).toBeGreaterThan(50);
  });
});

describe('makeValueNoise1', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    const a = makeValueNoise1(makeRng('wobble'));
    const b = makeValueNoise1(makeRng('wobble'));
    const c = makeValueNoise1(makeRng('other'));
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const t = i * 0.173;
      expect(a(t)).toBe(b(t));
      if (a(t) === c(t)) same++;
    }
    expect(same).toBeLessThan(10);
  });

  it('stays within -1..1 over 10k samples and is continuous', () => {
    const n = makeValueNoise1(makeRng('wobble'));
    const s = sampler('samples');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 10000; i++) {
      const t = s();
      const v = n(t);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      expect(Math.abs(n(t + 1e-4) - v)).toBeLessThan(0.01);
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(1);
  });

  it('interpolates: midpoint between lattice points is their mean', () => {
    const n = makeValueNoise1(makeRng('wobble'));
    expect(n(7.5)).toBeCloseTo((n(7) + n(8)) / 2, 6);
    expect(n(-2.5)).toBeCloseTo((n(-3) + n(-2)) / 2, 6);
  });
});
