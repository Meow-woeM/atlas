import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { WorldParams } from '../core/types';
import { poissonDisc, boundaryRing, generatePoints } from './poisson';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 40 };

/** Grid-based min pairwise distance check: every pair closer than `r` is reported. O(n). */
function minPairwiseOk(pts: Float64Array, from: number, r: number): { ok: boolean; min: number } {
  const cell = r;
  const map = new Map<number, number[]>();
  const n = pts.length >> 1;
  let min = Infinity;
  for (let i = from; i < n; i++) {
    const gx = Math.floor(pts[2 * i] / cell);
    const gy = Math.floor(pts[2 * i + 1] / cell);
    for (let yy = gy - 1; yy <= gy + 1; yy++) {
      for (let xx = gx - 1; xx <= gx + 1; xx++) {
        const bucket = map.get(yy * 100003 + xx);
        if (!bucket) continue;
        for (const j of bucket) {
          const dx = pts[2 * i] - pts[2 * j];
          const dy = pts[2 * i + 1] - pts[2 * j + 1];
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < min) min = d;
        }
      }
    }
    const key = gy * 100003 + gx;
    const b = map.get(key);
    if (b) b.push(i); else map.set(key, [i]);
  }
  return { ok: min >= r * 0.999, min };
}

describe('poisson', () => {
  it('generatePoints is deterministic', () => {
    const a = generatePoints(SMALL, fork('seed-a', 'points'));
    const b = generatePoints(SMALL, fork('seed-a', 'points'));
    expect(a.numBoundary).toBe(b.numBoundary);
    expect(a.points.length).toBe(b.points.length);
    expect(a.points).toEqual(b.points);
    const c = generatePoints(SMALL, fork('seed-b', 'points'));
    expect(c.points).not.toEqual(a.points);
  });

  it('interior points stay inside the rectangle and respect the radius (small)', () => {
    const { points, numBoundary } = generatePoints(SMALL, fork('t', 'points'));
    const n = points.length >> 1;
    for (let i = numBoundary; i < n; i++) {
      expect(points[2 * i]).toBeGreaterThanOrEqual(0);
      expect(points[2 * i]).toBeLessThan(SMALL.width);
      expect(points[2 * i + 1]).toBeGreaterThanOrEqual(0);
      expect(points[2 * i + 1]).toBeLessThan(SMALL.height);
    }
    const { ok, min } = minPairwiseOk(points, numBoundary, SMALL.cellSpacing);
    expect(min).toBeGreaterThanOrEqual(SMALL.cellSpacing * 0.999);
    expect(ok).toBe(true);
  });

  it('default mesh: min pairwise interior distance >= r*0.999 and count is in range', () => {
    const { points, numBoundary } = generatePoints(DEFAULT_PARAMS, fork('atlas', 'points'));
    const n = points.length >> 1;
    expect(n).toBeGreaterThan(8000);
    expect(n).toBeLessThan(12000);
    const { ok, min } = minPairwiseOk(points, numBoundary, DEFAULT_PARAMS.cellSpacing);
    expect(min).toBeGreaterThanOrEqual(DEFAULT_PARAMS.cellSpacing * 0.999);
    expect(ok).toBe(true);
  });

  it('poissonDisc reaches a dense packing', () => {
    const pts = poissonDisc(400, 300, 10, fork('dense', 'points'));
    const n = pts.length >> 1;
    // Bridson ~ 0.65-0.75 of hexagonal packing (~ 0.6-0.8 * W*H / r^2).
    expect(n).toBeGreaterThan(0.55 * 400 * 300 / 100);
    expect(n).toBeLessThan(0.95 * 400 * 300 / 100);
  });

  it('boundaryRing sits 2r outside the rectangle at spacing ~r, corners once', () => {
    const r = 40;
    const ring = boundaryRing(400, 300, r);
    const n = ring.length >> 1;
    expect(n).toBe(2 * Math.round(560 / r) + 2 * Math.round(460 / r));
    for (let i = 0; i < n; i++) {
      const x = ring[2 * i], y = ring[2 * i + 1];
      const onX = Math.abs(x + 2 * r) < 1e-9 || Math.abs(x - 400 - 2 * r) < 1e-9;
      const onY = Math.abs(y + 2 * r) < 1e-9 || Math.abs(y - 300 - 2 * r) < 1e-9;
      expect(onX || onY).toBe(true);
    }
    // No duplicates.
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) seen.add(`${ring[2 * i]},${ring[2 * i + 1]}`);
    expect(seen.size).toBe(n);
    // Consecutive spacing ~r.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const d = Math.hypot(ring[2 * i] - ring[2 * j], ring[2 * i + 1] - ring[2 * j + 1]);
      expect(d).toBeGreaterThan(r * 0.9);
      expect(d).toBeLessThan(r * 1.1);
    }
  });

  it('ring points come first', () => {
    const ring = boundaryRing(SMALL.width, SMALL.height, SMALL.cellSpacing);
    const { points, numBoundary } = generatePoints(SMALL, fork('x', 'points'));
    expect(numBoundary).toBe(ring.length / 2);
    expect(points.subarray(0, ring.length)).toEqual(ring);
  });
});
