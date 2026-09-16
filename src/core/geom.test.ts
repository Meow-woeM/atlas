import { describe, it, expect } from 'vitest';
import { chaikin, polylineLength, wobble, principalAxis, pointInPolygon, quantile } from './geom';
import { makeValueNoise1 } from './noise';
import { makeRng } from './rng';

const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);   // closed, CCW in y-down
const line = new Float32Array([0, 0, 10, 0]);

describe('chaikin', () => {
  it('closed square: one iteration cuts every corner into 8 points at 1/4 and 3/4', () => {
    const out = chaikin(square, true, 1);
    expect(out.length).toBe(16);
    expect(Array.from(out)).toEqual([
      2.5, 0, 7.5, 0,        // edge (0,0)->(10,0)
      10, 2.5, 10, 7.5,      // edge (10,0)->(10,10)
      7.5, 10, 2.5, 10,      // edge (10,10)->(0,10)
      0, 7.5, 0, 2.5,        // edge (0,10)->(0,0)
    ]);
  });

  it('open polyline keeps both endpoints exactly', () => {
    const pts = new Float32Array([0, 0, 10, 0, 10, 10]);
    const out = chaikin(pts, false, 1);
    expect(out.length).toBe(12);
    expect(Array.from(out)).toEqual([0, 0, 2.5, 0, 7.5, 0, 10, 2.5, 10, 7.5, 10, 10]);
    const out3 = chaikin(pts, false, 3);
    expect(out3[0]).toBe(0);
    expect(out3[1]).toBe(0);
    expect(out3[out3.length - 2]).toBe(10);
    expect(out3[out3.length - 1]).toBe(10);
  });

  it('open two-point line is a copy plus two interior points', () => {
    expect(Array.from(chaikin(line, false, 1))).toEqual([0, 0, 2.5, 0, 7.5, 0, 10, 0]);
  });

  it('zero iterations and degenerate inputs return a copy, never the input', () => {
    const out = chaikin(square, true, 0);
    expect(out).not.toBe(square);
    expect(Array.from(out)).toEqual(Array.from(square));
    const two = new Float32Array([0, 0, 1, 1]);
    const outTwo = chaikin(two, true, 2);
    expect(outTwo).not.toBe(two);
    expect(Array.from(outTwo)).toEqual([0, 0, 1, 1]);
    const one = chaikin(new Float32Array([3, 4]), false, 2);
    expect(Array.from(one)).toEqual([3, 4]);
  });

  it('doubles the point count each iteration and shrinks the closed square inward', () => {
    const out = chaikin(square, true, 3);
    expect(out.length).toBe(4 * 8 * 2);   // 4 points x 2^3, xy interleaved
    for (let i = 0; i < out.length; i += 2) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(10);
      expect(out[i + 1]).toBeGreaterThanOrEqual(0);
      expect(out[i + 1]).toBeLessThanOrEqual(10);
    }
    expect(polylineLength(out, true)).toBeLessThan(40);
    // Chaikin converges to the uniform quadratic B-spline of the square, whose perimeter is 32.46.
    expect(polylineLength(out, true)).toBeGreaterThan(32);
  });
});

describe('polylineLength', () => {
  it('square perimeter is 40 closed, 30 open', () => {
    expect(polylineLength(square, true)).toBe(40);
    expect(polylineLength(square, false)).toBe(30);
  });

  it('line of length 10; single point or empty is 0', () => {
    expect(polylineLength(line, false)).toBe(10);
    expect(polylineLength(line, true)).toBe(20);
    expect(polylineLength(new Float32Array([1, 1]), false)).toBe(0);
    expect(polylineLength(new Float32Array(0), true)).toBe(0);
  });

  it('3-4-5 triangle', () => {
    expect(polylineLength(new Float32Array([0, 0, 3, 0, 3, 4]), true)).toBe(12);
  });
});

describe('wobble', () => {
  it('returns a new array of the same length and never mutates the input', () => {
    const noise = makeValueNoise1(makeRng('ink'));
    const before = Array.from(square);
    const out = wobble(square, true, noise, 2, 5);
    expect(out).not.toBe(square);
    expect(out.length).toBe(square.length);
    expect(Array.from(square)).toEqual(before);
  });

  it('displaces a horizontal open line only in y, within amplitude, and pins the endpoints', () => {
    const noise = makeValueNoise1(makeRng('ink'));
    const n = 41;
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { pts[2 * i] = i; pts[2 * i + 1] = 5; }
    const out = wobble(pts, false, noise, 1.5, 4);
    expect(out[0]).toBe(0); expect(out[1]).toBe(5);
    expect(out[2 * n - 2]).toBe(n - 1); expect(out[2 * n - 1]).toBe(5);
    let moved = 0;
    for (let i = 0; i < n; i++) {
      expect(out[2 * i]).toBe(pts[2 * i]);              // normal of a horizontal line is vertical
      expect(Math.abs(out[2 * i + 1] - 5)).toBeLessThanOrEqual(1.5);
      if (out[2 * i + 1] !== 5) moved++;
    }
    expect(moved).toBeGreaterThan(n / 2);
  });

  it('uses arc length / wavelength as the noise argument', () => {
    // A constant noise function displaces every interior point by exactly amplitude along
    // the left normal; for a line travelling +x in y-down coordinates the left normal is +y.
    const out = wobble(new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]), false, () => 1, 2, 1);
    expect(Array.from(out)).toEqual([0, 0, 1, 2, 2, 2, 3, 0]);
    // A noise that records its arguments sees the cumulative arc length divided by wavelength.
    const seen: number[] = [];
    wobble(new Float32Array([0, 0, 3, 4, 6, 8]), true, (t) => { seen.push(t); return 0; }, 1, 5);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('a closed polyline displaces every point (no pinning)', () => {
    const out = wobble(square, true, () => 1, 1, 1);
    // Square runs (0,0)->(10,0)->(10,10)->(0,10). Left normal at each corner points along
    // the bisector direction (-ty, tx) of the chord between neighbours.
    // For this winding the chord-bisector normal points into the square at every corner.
    const s = Math.SQRT1_2;
    expect(out[0]).toBeCloseTo(0 + s, 5); expect(out[1]).toBeCloseTo(0 + s, 5);
    expect(out[2]).toBeCloseTo(10 - s, 5); expect(out[3]).toBeCloseTo(0 + s, 5);
    expect(out[4]).toBeCloseTo(10 - s, 5); expect(out[5]).toBeCloseTo(10 - s, 5);
    expect(out[6]).toBeCloseTo(0 + s, 5); expect(out[7]).toBeCloseTo(10 - s, 5);
  });

  it('zero amplitude is an exact copy', () => {
    const out = wobble(square, true, () => 1, 0, 3);
    expect(Array.from(out)).toEqual(Array.from(square));
  });
});

describe('principalAxis', () => {
  it('horizontal two-point line: angle 0, extent 4 sigma = 20, centroid (5, 0)', () => {
    const xs = [0, 10], ys = [0, 0];
    const r = principalAxis(xs, ys, new Int32Array([0, 1]));
    expect(r.angle).toBeCloseTo(0, 12);
    expect(r.extent).toBeCloseTo(20, 10);
    expect(r.cx).toBe(5);
    expect(r.cy).toBe(0);
  });

  it('vertical line: angle pi/2', () => {
    const r = principalAxis([3, 3, 3], [0, 5, 10], new Int32Array([0, 1, 2]));
    expect(Math.abs(r.angle)).toBeCloseTo(Math.PI / 2, 12);
    expect(r.cx).toBe(3);
    expect(r.cy).toBe(5);
  });

  it('diagonal y = x: angle pi/4; y = -x: angle -pi/4', () => {
    const a = principalAxis([0, 1, 2, 3], [0, 1, 2, 3], new Int32Array([0, 1, 2, 3]));
    expect(a.angle).toBeCloseTo(Math.PI / 4, 12);
    const b = principalAxis([0, 1, 2, 3], [0, -1, -2, -3], new Int32Array([0, 1, 2, 3]));
    expect(b.angle).toBeCloseTo(-Math.PI / 4, 12);
  });

  it('respects idx (ignores points outside the subset) and typed-array inputs', () => {
    const xs = new Float32Array([0, 10, 100, 200]);
    const ys = new Float32Array([0, 0, 50, 50]);
    const r = principalAxis(xs, ys, new Int32Array([0, 1]));
    expect(r.cx).toBe(5);
    expect(r.cy).toBe(0);
    expect(r.extent).toBeCloseTo(20, 10);
  });

  it('a symmetric square is isotropic (extent 4 * sqrt(25) = 20) and a point has extent 0', () => {
    const r = principalAxis([0, 10, 10, 0], [0, 0, 10, 10], new Int32Array([0, 1, 2, 3]));
    expect(r.cx).toBe(5);
    expect(r.cy).toBe(5);
    expect(r.extent).toBeCloseTo(20, 10);
    const p = principalAxis([7], [9], new Int32Array([0]));
    expect(p).toEqual({ angle: 0, extent: 0, cx: 7, cy: 9 });
    expect(principalAxis([1], [1], new Int32Array(0))).toEqual({ angle: 0, extent: 0, cx: 0, cy: 0 });
  });
});

describe('pointInPolygon', () => {
  it('square: inside, outside, and both windings', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(0.01, 9.99, square)).toBe(true);
    expect(pointInPolygon(-1, 5, square)).toBe(false);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(5, -1, square)).toBe(false);
    expect(pointInPolygon(5, 11, square)).toBe(false);
    const cw = new Float32Array([0, 0, 0, 10, 10, 10, 10, 0]);
    expect(pointInPolygon(5, 5, cw)).toBe(true);
    expect(pointInPolygon(15, 5, cw)).toBe(false);
  });

  it('concave L-shape: the notch is outside', () => {
    const L = new Float32Array([0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]);
    expect(pointInPolygon(2, 8, L)).toBe(true);
    expect(pointInPolygon(8, 2, L)).toBe(true);
    expect(pointInPolygon(8, 8, L)).toBe(false);
  });

  it('degenerate polygons contain nothing', () => {
    expect(pointInPolygon(0, 0, new Float32Array(0))).toBe(false);
    expect(pointInPolygon(5, 0, line)).toBe(false);
  });
});

describe('quantile', () => {
  it('min, max, median, and linear interpolation between ranks', () => {
    const v = new Float32Array([5, 1, 4, 2, 3]);
    expect(quantile(v, 0)).toBe(1);
    expect(quantile(v, 1)).toBe(5);
    expect(quantile(v, 0.5)).toBe(3);
    expect(quantile(v, 0.25)).toBe(2);
    expect(quantile(v, 0.125)).toBe(1.5);
    expect(quantile(v, 0.9)).toBeCloseTo(4.6, 6);
  });

  it('sorts a copy and leaves the input untouched; clamps q', () => {
    const v = new Float32Array([3, -1, 2]);
    expect(quantile(v, 0.5)).toBe(2);
    expect(Array.from(v)).toEqual([3, -1, 2]);
    expect(quantile(v, -5)).toBe(-1);
    expect(quantile(v, 7)).toBe(3);
  });

  it('single element, and NaN for empty', () => {
    expect(quantile(new Float32Array([42]), 0.3)).toBe(42);
    expect(Number.isNaN(quantile(new Float32Array(0), 0.5))).toBe(true);
  });

  it('the 1 - landFraction quantile of a uniform ramp lands at that fraction', () => {
    const n = 1000;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (n - 1 - i) / (n - 1);   // descending ramp 1..0
    expect(quantile(v, 1 - 0.42)).toBeCloseTo(0.58, 6);
  });
});
