/**
 * core/geom.ts — Stage 0 helper (no stage of its own): pure 2D geometry over xy-interleaved
 * Float32Array polylines in logical px. RNG stream: none (wobble takes a Noise1 built by the
 * caller from its own fork). Inputs: polylines / point sets / scalar fields. Outputs: new
 * arrays or scalars; inputs are never mutated.
 *
 * Polyline convention (types.ts): pts is xy interleaved, closed polylines do not repeat the
 * first point.
 */

import type { Noise1 } from './noise';

/**
 * Chaikin corner cutting. Each iteration replaces every edge (P, Q) with the two points
 * 0.75P + 0.25Q and 0.25P + 0.75Q. Closed polylines cut every edge including the wrap-around
 * (n -> 2n points). Open polylines keep both endpoints exactly (n -> 2n points: P0, the cut
 * pairs of the n-1 edges, P(n-1)). Polylines with fewer than 3 (closed) or 2 (open) points
 * are returned as copies.
 */
export function chaikin(pts: Float32Array, closed: boolean, iterations: number): Float32Array {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length >> 1;
    if (closed ? n < 3 : n < 2) break;
    const next = new Float32Array(n * 4);
    if (closed) {
      let o = 0;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const ax = cur[2 * i], ay = cur[2 * i + 1];
        const bx = cur[2 * j], by = cur[2 * j + 1];
        next[o++] = 0.75 * ax + 0.25 * bx;
        next[o++] = 0.75 * ay + 0.25 * by;
        next[o++] = 0.25 * ax + 0.75 * bx;
        next[o++] = 0.25 * ay + 0.75 * by;
      }
    } else {
      let o = 0;
      next[o++] = cur[0];
      next[o++] = cur[1];
      for (let i = 0; i < n - 1; i++) {
        const ax = cur[2 * i], ay = cur[2 * i + 1];
        const bx = cur[2 * i + 2], by = cur[2 * i + 3];
        next[o++] = 0.75 * ax + 0.25 * bx;
        next[o++] = 0.75 * ay + 0.25 * by;
        next[o++] = 0.25 * ax + 0.75 * bx;
        next[o++] = 0.25 * ay + 0.75 * by;
      }
      next[o++] = cur[2 * n - 2];
      next[o++] = cur[2 * n - 1];
    }
    cur = next;
  }
  return cur === pts ? pts.slice() : cur;
}

/** Sum of segment lengths; the closing segment is included when closed. */
export function polylineLength(pts: Float32Array, closed: boolean): number {
  const n = pts.length >> 1;
  if (n < 2) return 0;
  let len = 0;
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[2 * i + 2] - pts[2 * i];
    const dy = pts[2 * i + 3] - pts[2 * i + 1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  if (closed) {
    const dx = pts[0] - pts[2 * n - 2];
    const dy = pts[1] - pts[2 * n - 1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/**
 * Hand-drawn wobble: displaces every point along its unit normal (left of the direction of
 * travel) by amplitude * noise(arcLength / wavelength), where arcLength is the cumulative
 * distance from point 0. The normal at a point is perpendicular to the chord between its
 * neighbours (wrapping when closed). Endpoints of OPEN polylines are pinned (not displaced) so
 * river mouths stay on the coast and frame corners meet. Returns a new array.
 */
export function wobble(
  pts: Float32Array, closed: boolean, noise: Noise1, amplitude: number, wavelength: number,
): Float32Array {
  const n = pts.length >> 1;
  const out = pts.slice();
  if (n < 2 || amplitude === 0 || wavelength <= 0) return out;
  let arc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = pts[2 * i] - pts[2 * i - 2];
      const dy = pts[2 * i + 1] - pts[2 * i - 1];
      arc += Math.sqrt(dx * dx + dy * dy);
    }
    let prev: number, next: number;
    if (closed) {
      prev = i === 0 ? n - 1 : i - 1;
      next = i === n - 1 ? 0 : i + 1;
    } else {
      if (i === 0 || i === n - 1) continue;   // pinned endpoints
      prev = i - 1;
      next = i + 1;
    }
    const tx = pts[2 * next] - pts[2 * prev];
    const ty = pts[2 * next + 1] - pts[2 * prev + 1];
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl === 0) continue;
    const d = amplitude * noise(arc / wavelength);
    out[2 * i] = pts[2 * i] + d * (-ty / tl);
    out[2 * i + 1] = pts[2 * i + 1] + d * (tx / tl);
  }
  return out;
}

/**
 * Principal axis of a point set by PCA of the 2x2 covariance matrix.
 * angle: direction of the largest-variance axis in radians, in (-pi/2, pi/2] (0 = along +x).
 * extent: 4 * sqrt(largest eigenvalue), i.e. +-2 standard deviations along that axis, in the
 * units of xs/ys. cx, cy: the centroid. Empty idx -> all zeros; a single point -> extent 0.
 */
export function principalAxis(
  xs: ArrayLike<number>, ys: ArrayLike<number>, idx: Int32Array,
): { angle: number; extent: number; cx: number; cy: number } {
  const n = idx.length;
  if (n === 0) return { angle: 0, extent: 0, cx: 0, cy: 0 };
  let sx = 0, sy = 0;
  for (let k = 0; k < n; k++) {
    sx += xs[idx[k]];
    sy += ys[idx[k]];
  }
  const cx = sx / n;
  const cy = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[idx[k]] - cx;
    const dy = ys[idx[k]] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= n; sxy /= n; syy /= n;
  const half = (sxx + syy) / 2;
  const diff = (sxx - syy) / 2;
  const lambda = half + Math.sqrt(diff * diff + sxy * sxy);
  const angle = sxy === 0 && diff === 0 ? 0 : 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { angle, extent: 4 * Math.sqrt(Math.max(0, lambda)), cx, cy };
}

/** Ray casting (even-odd rule) against a closed polygon; points on an edge are unspecified. */
export function pointInPolygon(x: number, y: number, pts: Float32Array): boolean {
  const n = pts.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1];
    const xj = pts[2 * j], yj = pts[2 * j + 1];
    if ((yi > y) !== (yj > y)) {
      const xCross = xi + ((y - yi) * (xj - xi)) / (yj - yi);
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * q-quantile (q in 0..1, clamped) of values, sorting a COPY. Linear interpolation between
 * ranks: quantile(v, 0) is the min, quantile(v, 1) the max, quantile(v, 0.5) the median.
 * Returns NaN for an empty array.
 */
export function quantile(values: Float32Array, q: number): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = values.slice().sort();   // typed-array sort is numeric
  const qq = q < 0 ? 0 : q > 1 ? 1 : q;
  const pos = qq * (n - 1);
  const lo = Math.floor(pos);
  const hi = lo + 1 < n ? lo + 1 : lo;
  const frac = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
