import { describe, it, expect } from 'vitest';
import { makeRaster, edt, sampleBilinear, marchingSquares, rasterizeTriangles } from './raster';
import type { Mesh, Polyline, Raster } from './types';

function polylineLength(p: Polyline): number {
  const { pts, closed } = p;
  const n = pts.length / 2;
  let len = 0;
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[2 * i + 2] - pts[2 * i], dy = pts[2 * i + 3] - pts[2 * i + 1];
    len += Math.hypot(dx, dy);
  }
  if (closed && n > 1) len += Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1]);
  return len;
}

/** Shoelace sum in the raw (y-down) coordinates. */
function shoelace(p: Polyline): number {
  const { pts } = p;
  const n = pts.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return s / 2;
}

function radialField(w: number, h: number, scale: number, cx: number, cy: number, r0: number): Raster {
  // Logical-px distance from (cx, cy) measured at pixel centers; positive inside the disc.
  const f = makeRaster(w, h, scale);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = (i + 0.5) / scale, y = (j + 0.5) / scale;
      f.data[j * w + i] = r0 - Math.hypot(x - cx, y - cy);
    }
  }
  return f;
}

describe('makeRaster', () => {
  it('allocates w*h zeroed floats', () => {
    const r = makeRaster(7, 5, 0.5);
    expect(r.w).toBe(7);
    expect(r.h).toBe(5);
    expect(r.scale).toBe(0.5);
    expect(r.data.length).toBe(35);
    expect(r.data.every((v) => v === 0)).toBe(true);
  });
});

describe('edt', () => {
  it('centered filled square: +half-side at the center, correct negative magnitudes outside', () => {
    const w = 101, h = 101, side = 21;
    const mask = makeRaster(w, h, 1);
    const lo = 40, hi = 60; // inclusive, 21 px
    for (let j = lo; j <= hi; j++) for (let i = lo; i <= hi; i++) mask.data[j * w + i] = 1;
    const d = edt(mask);
    const at = (x: number, y: number): number => d.data[y * w + x];

    expect(at(50, 50)).toBeCloseTo(side / 2, 5);           // 10.5
    expect(at(40, 50)).toBeCloseTo(0.5, 5);                // first inside pixel on the edge
    expect(at(39, 50)).toBeCloseTo(-0.5, 5);               // first outside pixel
    expect(at(50, 70)).toBeCloseTo(-(10 - 0.5), 5);        // 10 px straight out from the edge
    expect(at(70, 70)).toBeCloseTo(-(Math.sqrt(200) - 0.5), 5); // diagonal from the corner (60,60)
    expect(at(0, 0)).toBeCloseTo(-(Math.sqrt(2 * 40 * 40) - 0.5), 5);
    expect(at(45, 45)).toBeCloseTo(5.5, 5);                // 5 px inside from the edge at 40
    // Sign partition matches the mask everywhere.
    for (let p = 0; p < w * h; p++) {
      expect(d.data[p] > 0).toBe(mask.data[p] > 0.5);
    }
  });

  it('all-zero and all-one masks give finite, capped values', () => {
    const w = 32, h = 24;
    const zero = edt(makeRaster(w, h, 0.5));
    const ones = makeRaster(w, h, 0.5);
    ones.data.fill(1);
    const one = edt(ones);
    for (let p = 0; p < w * h; p++) {
      expect(Number.isFinite(zero.data[p])).toBe(true);
      expect(Number.isFinite(one.data[p])).toBe(true);
      expect(zero.data[p]).toBeLessThan(0);
      expect(one.data[p]).toBeGreaterThan(0);
      expect(Math.abs(zero.data[p])).toBeLessThanOrEqual(w + h);
      expect(Math.abs(one.data[p])).toBeLessThanOrEqual(w + h);
    }
  });

  it('is exact Euclidean (matches brute force) on a random-ish blob', () => {
    const w = 40, h = 30;
    const mask = makeRaster(w, h, 1);
    // Deterministic pseudo-blob: two discs.
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const a = Math.hypot(i - 12, j - 14) < 7, b = Math.hypot(i - 27, j - 10) < 5;
      mask.data[j * w + i] = a || b ? 1 : 0;
    }
    const d = edt(mask);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const inside = mask.data[j * w + i] > 0.5;
      let best = Infinity;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if ((mask.data[y * w + x] > 0.5) !== inside) {
          const dd = (x - i) * (x - i) + (y - j) * (y - j);
          if (dd < best) best = dd;
        }
      }
      const expected = (Math.sqrt(best) - 0.5) * (inside ? 1 : -1);
      expect(d.data[j * w + i]).toBeCloseTo(expected, 4);
    }
  });

  it('accepts an out raster and may alias the mask', () => {
    const w = 20, h = 20;
    const mask = makeRaster(w, h, 1);
    for (let j = 5; j < 15; j++) for (let i = 5; i < 15; i++) mask.data[j * w + i] = 1;
    const ref = edt(mask);
    const out = makeRaster(w, h, 1);
    expect(edt(mask, out)).toBe(out);
    expect(out.data).toEqual(ref.data);
    expect(edt(mask, mask)).toBe(mask);
    expect(mask.data).toEqual(ref.data);
  });
});

describe('sampleBilinear', () => {
  it('returns the stored value at grid points (pixel centers) and interpolates between them', () => {
    const w = 8, h = 6, scale = 0.5;
    const r = makeRaster(w, h, scale);
    for (let p = 0; p < w * h; p++) r.data[p] = (p * 37) % 11;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const x = (i + 0.5) / scale, y = (j + 0.5) / scale;
      expect(sampleBilinear(r, x, y)).toBeCloseTo(r.data[j * w + i], 6);
    }
    // Midpoint between two horizontal neighbors is their mean.
    const mid = sampleBilinear(r, (2 + 1) / scale, (3 + 0.5) / scale);
    expect(mid).toBeCloseTo((r.data[3 * w + 2] + r.data[3 * w + 3]) / 2, 6);
  });

  it('clamps outside the raster', () => {
    const r = makeRaster(4, 4, 1);
    r.data.fill(3);
    r.data[0] = 9;
    r.data[15] = 1;
    expect(sampleBilinear(r, -100, -100)).toBe(9);
    expect(sampleBilinear(r, 100, 100)).toBe(1);
    expect(Number.isFinite(sampleBilinear(r, NaN, 0))).toBe(true);
  });
});

describe('marchingSquares', () => {
  it('radial field at iso r yields one closed loop with length within 3% of 2*pi*r', () => {
    const w = 128, h = 96, scale = 0.5;
    const cx = 128, cy = 96, r0 = 60;
    // Field = r0 - dist; iso 0 is the circle of radius r0. Also test a non-zero iso.
    const f = radialField(w, h, scale, cx, cy, r0);
    for (const iso of [0, 10, -15]) {
      const radius = r0 - iso;
      const lines = marchingSquares(f, iso);
      expect(lines.length).toBe(1);
      expect(lines[0].closed).toBe(true);
      const len = polylineLength(lines[0]);
      expect(Math.abs(len - 2 * Math.PI * radius) / (2 * Math.PI * radius)).toBeLessThan(0.03);
      // Every vertex lies on the circle and the field is ~iso there (logical px consistency).
      const pts = lines[0].pts;
      for (let k = 0; k < pts.length; k += 2) {
        expect(Math.abs(Math.hypot(pts[k] - cx, pts[k + 1] - cy) - radius)).toBeLessThan(1.5);
        expect(Math.abs(sampleBilinear(f, pts[k], pts[k + 1]) - iso)).toBeLessThan(0.5);
      }
    }
  });

  it('keeps the > iso region on the left (y-down), like Features.coast', () => {
    const f = radialField(64, 64, 1, 32, 32, 20);
    const [loop] = marchingSquares(f, 0);
    // Interior (> iso) on the left in y-down coordinates means the raw shoelace sum is negative.
    expect(shoelace(loop)).toBeLessThan(0);
    // Inverting the field flips the orientation.
    const g = makeRaster(64, 64, 1);
    for (let p = 0; p < 64 * 64; p++) g.data[p] = -f.data[p];
    const [loop2] = marchingSquares(g, 0);
    expect(shoelace(loop2)).toBeGreaterThan(0);
  });

  it('produces open chains when the contour hits the raster border', () => {
    const w = 40, h = 30;
    const f = makeRaster(w, h, 1);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) f.data[j * w + i] = i - 19.5; // vertical line at x=20
    const lines = marchingSquares(f, 0);
    expect(lines.length).toBe(1);
    expect(lines[0].closed).toBe(false);
    expect(lines[0].pts.length / 2).toBe(h);
    for (let k = 0; k < lines[0].pts.length; k += 2) expect(lines[0].pts[k]).toBeCloseTo(20, 5);
  });

  it('resolves saddles by the center average', () => {
    // One 2x2 cell with TL and BR high, TR and BL low (case 5). Edges: top y=0.5, right x=1.5,
    // bottom y=1.5, left x=0.5 (scale 1).
    const mk = (hi: number, lo: number): Raster => {
      const f = makeRaster(2, 2, 1);
      f.data.set([hi, lo, lo, hi]);
      return f;
    };
    const edgeOf = (x: number, y: number): string =>
      Math.abs(y - 0.5) < 1e-6 ? 'top' : Math.abs(y - 1.5) < 1e-6 ? 'bottom'
        : Math.abs(x - 0.5) < 1e-6 ? 'left' : 'right';
    const chains = (lines: Polyline[]): string[] => lines.map((p) => {
      expect(p.closed).toBe(false);
      expect(p.pts.length).toBe(4);
      return [edgeOf(p.pts[0], p.pts[1]), edgeOf(p.pts[2], p.pts[3])].sort().join('-');
    }).sort();
    // Center average 0.6 > iso 0.5 -> the high corners join: chains right-top and left-bottom.
    expect(chains(marchingSquares(mk(1, 0.2), 0.5))).toEqual(['bottom-left', 'right-top']);
    // Center average 0.5 < iso 0.6 -> the high corners are isolated: chains left-top and right-bottom.
    expect(chains(marchingSquares(mk(1, 0), 0.6))).toEqual(['bottom-right', 'left-top']);
  });

  it('returns nothing on constant fields and degenerate sizes', () => {
    const f = makeRaster(16, 16, 1);
    f.data.fill(2);
    expect(marchingSquares(f, 0)).toEqual([]);
    expect(marchingSquares(f, 5)).toEqual([]);
    expect(marchingSquares(makeRaster(1, 16, 1), 0)).toEqual([]);
  });

  it('is deterministic and fast on a 512x384 field', () => {
    const w = 512, h = 384, scale = 0.5;
    const f = makeRaster(w, h, scale);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const x = i / scale, y = j / scale;
      f.data[j * w + i] = Math.sin(x * 0.02) * Math.cos(y * 0.017) + 0.3 * Math.sin((x + y) * 0.05);
    }
    marchingSquares(f, 0.1); // warm up
    const t0 = performance.now();
    const a = marchingSquares(f, 0.1);
    const ms = performance.now() - t0;
    const b = marchingSquares(f, 0.1);
    expect(a.length).toBe(b.length);
    for (let k = 0; k < a.length; k++) {
      expect(a[k].closed).toBe(b[k].closed);
      expect(a[k].pts).toEqual(b[k].pts);
    }
    expect(a.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(250);
  });
});

describe('rasterizeTriangles', () => {
  it('Gouraud-fills a single Delaunay triangle with the per-region means', () => {
    // A minimal fake mesh: 3 regions, 1 triangle. Only the fields rasterizeTriangles reads matter.
    const mesh: Mesh = {
      numRegions: 3, numBoundaryRegions: 0, numTriangles: 1, numSides: 3,
      r_x: new Float32Array([0, 40, 0]), r_y: new Float32Array([0, 0, 40]),
      t_x: new Float32Array([40 / 3]), t_y: new Float32Array([40 / 3]),
      s_start_r: new Int32Array([0, 1, 2]), s_opposite_s: new Int32Array([-1, -1, -1]),
      r_first_s: new Int32Array([0, 1, 2]),
      triangles: new Int32Array([0, 1, 2]), halfedges: new Int32Array([-1, -1, -1]),
    };
    const raster = makeRaster(20, 20, 0.5);
    raster.data.fill(-1);
    rasterizeTriangles(mesh, new Float32Array([7]), raster);
    // Every region's mean is 7, so covered pixels read 7 and uncovered pixels keep -1.
    let covered = 0;
    for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
      const v = raster.data[j * 20 + i];
      const px = i + 0.5, py = j + 0.5; // raster px; triangle is (0,0)-(20,0)-(0,20) in raster px
      const inside = px + py <= 20;
      if (inside) { expect(v).toBeCloseTo(7, 5); covered++; } else expect(v).toBe(-1);
    }
    expect(covered).toBeGreaterThan(150);
  });
});

describe('rasterizeCells', () => {
  it.todo('rasterizeCells: every raster pixel is covered exactly once by the default mesh (needs mesh/dualmesh)');
});
