/**
 * core/raster.ts — Stage 5 (distance field, via gen/elevation.ts) and stage 13 (waterlines, via
 * gen/features.ts). The derived raster scratch layer described in ARCHITECTURE.md 3.2.
 *
 * RNG stream: none. Every function here is a pure, deterministic function of its inputs; no
 * canvas, no Math.random, no Date.
 *
 * Inputs:  a Mesh plus per-region (r_*) or per-corner (t_*) typed arrays, or a Raster.
 * Outputs: Raster (Float32Array w*h at `scale` raster px per logical px) and Polyline[] in
 *          logical px.
 *
 * Conventions shared by every function in this file:
 *   - raster px = logical px * raster.scale.
 *   - Pixel (i, j) covers the raster-px square [i, i+1) x [j, j+1); its VALUE is located at the
 *     pixel center (i + 0.5, j + 0.5). rasterizeCells/rasterizeTriangles sample at centers,
 *     sampleBilinear interpolates between centers, marchingSquares interpolates between centers,
 *     so a contour point at logical P satisfies sampleBilinear(field, P) ~= iso.
 *   - edt returns a SIGNED distance in raster px, positive inside the mask (mask > 0.5), negative
 *     outside, shifted by 0.5 px so the mask boundary (half-way between an inside and an outside
 *     pixel center) is exactly the zero level set: the first inside pixel reads +0.5, the first
 *     outside pixel -0.5. marchingSquares(edt(mask), 0) therefore traces the mask edge.
 *   - marchingSquares orientation: the region with field > iso lies on the LEFT when walking a
 *     polyline in order (y-down screen coordinates), the same rule as Features.coast.
 */

import type { Mesh, Polyline, Raster } from './types';
import { cellPolygon } from '../mesh/dualmesh';

// ---------------------------------------------------------------- construction

export function makeRaster(w: number, h: number, scale: number): Raster {
  return { w, h, scale, data: new Float32Array(w * h) };
}

// ---------------------------------------------------------------- polygon scan fill

/** Insertion sort of xs[0..n). n is tiny (crossings per scanline of one cell). */
function sortSmall(xs: Float64Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = xs[i];
    let j = i - 1;
    while (j >= 0 && xs[j] > v) {
      xs[j + 1] = xs[j];
      j--;
    }
    xs[j + 1] = v;
  }
}

/**
 * Scan-line fill of one polygon (raster px, xy interleaved in `poly`, `n` points) with `value`.
 * A pixel is covered when its center is inside the polygon (even-odd rule with the half-open
 * crossing test, so pixels on a shared edge are claimed by exactly one of two adjacent cells).
 */
function fillPolygon(
  poly: Float32Array, n: number, value: number, raster: Raster, xs: Float64Array,
): void {
  const { w, h, data } = raster;
  let minY = Infinity, maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    const y = poly[2 * k + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const j0 = Math.max(0, Math.ceil(minY - 0.5));
  const j1 = Math.min(h - 1, Math.floor(maxY - 0.5));
  for (let j = j0; j <= j1; j++) {
    const sy = j + 0.5;
    let m = 0;
    let xa = poly[2 * (n - 1)], ya = poly[2 * (n - 1) + 1];
    for (let k = 0; k < n; k++) {
      const xb = poly[2 * k], yb = poly[2 * k + 1];
      if ((ya <= sy) !== (yb <= sy)) {
        if (m < xs.length) xs[m++] = xa + (sy - ya) * (xb - xa) / (yb - ya);
      }
      xa = xb; ya = yb;
    }
    if (m < 2) continue;
    sortSmall(xs, m);
    const row = j * w;
    for (let k = 0; k + 1 < m; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const i1 = Math.min(w - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let i = i0; i <= i1; i++) data[row + i] = value;
    }
  }
}

/**
 * Flat-fills every cell polygon with r_value[r]. Boundary-ring cells lie outside the raster and
 * are clipped away; pixels not covered by any polygon keep their previous value. Deterministic,
 * no canvas. ~5 ms at 512x384 with 10k cells.
 */
export function rasterizeCells(mesh: Mesh, r_value: ArrayLike<number>, raster: Raster): Raster {
  const scale = raster.scale;
  const scratch = new Float32Array(64);
  const xs = new Float64Array(32);
  const wPx = raster.w, hPx = raster.h;
  for (let r = 0; r < mesh.numRegions; r++) {
    const n = cellPolygon(mesh, r, scratch);
    if (n < 3) continue;
    // Scale to raster px and reject polygons entirely outside the raster early.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < 2 * n; k += 2) {
      const x = scratch[k] * scale, y = scratch[k + 1] * scale;
      scratch[k] = x; scratch[k + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0 || maxY < 0 || minX > wPx || minY > hPx) continue;
    fillPolygon(scratch, n, r_value[r], raster, xs);
  }
  return raster;
}

// ---------------------------------------------------------------- Gouraud triangle fill

/**
 * Gouraud fill over the Delaunay triangulation, for a future hillshade.
 *
 * Choice (documented per the assignment): the natural Gouraud vertices are the cell centers,
 * whose value is the mean of t_value over the cell's corners (the corner set of region r is
 * exactly the set of Delaunay triangles that have r as a vertex, so the mean is one pass over
 * mesh.triangles with no circulation). Each Delaunay triangle t = (a, b, c) is then filled by
 * barycentric interpolation of those per-region means. The result is continuous and piecewise
 * linear over the whole raster. Pixels outside every triangle keep their previous value.
 */
export function rasterizeTriangles(mesh: Mesh, t_value: ArrayLike<number>, raster: Raster): Raster {
  const { numRegions, numTriangles, triangles, r_x, r_y } = mesh;
  const { w, h, scale, data } = raster;

  // Per-region mean of the corner values.
  const sum = new Float64Array(numRegions);
  const cnt = new Int32Array(numRegions);
  for (let t = 0; t < numTriangles; t++) {
    const v = t_value[t];
    for (let k = 0; k < 3; k++) {
      const r = triangles[3 * t + k];
      sum[r] += v;
      cnt[r]++;
    }
  }
  const rv = new Float32Array(numRegions);
  for (let r = 0; r < numRegions; r++) rv[r] = cnt[r] > 0 ? sum[r] / cnt[r] : 0;

  for (let t = 0; t < numTriangles; t++) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    const x0 = r_x[a] * scale, y0 = r_y[a] * scale;
    const x1 = r_x[b] * scale, y1 = r_y[b] * scale;
    const x2 = r_x[c] * scale, y2 = r_y[c] * scale;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) continue;
    const inv = 1 / area;
    const v0 = rv[a], v1 = rv[b], v2 = rv[c];
    const i0 = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
    const i1 = Math.min(w - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const j0 = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
    const j1 = Math.min(h - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5;
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        const px = i + 0.5;
        // Barycentric weights (normalized by the signed area so either winding works).
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        if (w0 < 0) continue;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        data[row + i] = v0 * w0 + v1 * w1 + v2 * w2;
      }
    }
  }
  return raster;
}

// ---------------------------------------------------------------- Euclidean distance transform

/** A large finite "infinity" for the squared-distance grid; finite so INF - INF is 0, not NaN. */
const DT_INF = 1e20;

/**
 * Felzenszwalb-Huttenlocher 1D squared distance transform (lower envelope of parabolas).
 * f: input (0 at sources, DT_INF elsewhere), d: output, v/z: scratch of length n and n + 1.
 */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let vk = v[k];
    let s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
    while (s <= z[k]) {
      k--;
      vk = v[k];
      s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * 2D squared EDT of `g` in place (w x h, sources hold 0, everything else DT_INF).
 * Two separable passes: columns, then rows.
 */
function dt2d(g: Float64Array, w: number, h: number, f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array): void {
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[x + y * w];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[x + y * w] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = g[row + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[row + x] = d[x];
  }
}

/**
 * Exact signed Euclidean distance transform of a mask (inside = mask.data > 0.5).
 * Inside pixels get +distance to the nearest outside pixel, outside pixels get -distance to the
 * nearest inside pixel, both shifted by 0.5 so the zero level set is the mask boundary.
 * Distances are in raster px and capped at w + h (all-inside / all-outside masks stay finite).
 * `out` may alias `mask`.
 */
export function edt(mask: Raster, out?: Raster): Raster {
  const { w, h } = mask;
  const n = w * h;
  const result = out ?? makeRaster(w, h, mask.scale);
  if (result.w !== w || result.h !== h) throw new Error('edt: out raster size mismatch');
  const inside = new Uint8Array(n);
  const src = mask.data;
  for (let p = 0; p < n; p++) inside[p] = src[p] > 0.5 ? 1 : 0;

  const g = new Float64Array(n);
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const cap = w + h;
  const capSq = cap * cap;
  const dst = result.data;

  // Pass A: sources = inside pixels -> distance for OUTSIDE pixels (negative).
  for (let p = 0; p < n; p++) g[p] = inside[p] ? 0 : DT_INF;
  dt2d(g, w, h, f, d, v, z);
  for (let p = 0; p < n; p++) {
    if (!inside[p]) dst[p] = -(Math.sqrt(Math.min(g[p], capSq)) - 0.5);
  }
  // Pass B: sources = outside pixels -> distance for INSIDE pixels (positive).
  for (let p = 0; p < n; p++) g[p] = inside[p] ? DT_INF : 0;
  dt2d(g, w, h, f, d, v, z);
  for (let p = 0; p < n; p++) {
    if (inside[p]) dst[p] = Math.sqrt(Math.min(g[p], capSq)) - 0.5;
  }
  return result;
}

// ---------------------------------------------------------------- sampling

/** Bilinear sample at logical px (x, y); values live at pixel centers; clamps to the edges. */
export function sampleBilinear(raster: Raster, x: number, y: number): number {
  const { w, h, scale, data } = raster;
  let rx = x * scale - 0.5;
  let ry = y * scale - 0.5;
  if (!(rx > 0)) rx = 0; else if (rx > w - 1) rx = w - 1;
  if (!(ry > 0)) ry = 0; else if (ry > h - 1) ry = h - 1;
  const x0 = Math.floor(rx);
  const y0 = Math.floor(ry);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = rx - x0;
  const fy = ry - y0;
  const r0 = y0 * w, r1 = y1 * w;
  const top = data[r0 + x0] * (1 - fx) + data[r0 + x1] * fx;
  const bot = data[r1 + x0] * (1 - fx) + data[r1 + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

// ---------------------------------------------------------------- marching squares

/**
 * Segment table. Corner bits: 0 = top-left (i, j), 1 = top-right (i+1, j), 2 = bottom-right
 * (i+1, j+1), 3 = bottom-left (i, j+1); a bit is set when the corner value > iso.
 * Cell edges: 0 top, 1 right, 2 bottom, 3 left. Each case lists up to two segments as
 * (fromEdge, toEdge) pairs, -1 = none. Walking the perimeter clockwise (TL, TR, BR, BL), a segment
 * runs from the edge where the walk goes outside->inside to the edge where it goes inside->outside,
 * which puts the inside (> iso) region on the left in y-down coordinates.
 * The saddle cases 5 and 10 hold the "center is inside" variant; MS_SADDLE_OUT holds the other.
 */
const MS_TABLE = new Int8Array([
  -1, -1, -1, -1, // 0
   3,  0, -1, -1, // 1
   0,  1, -1, -1, // 2
   3,  1, -1, -1, // 3
   1,  2, -1, -1, // 4
   1,  0,  3,  2, // 5  (saddle, center inside)
   0,  2, -1, -1, // 6
   3,  2, -1, -1, // 7
   2,  3, -1, -1, // 8
   2,  0, -1, -1, // 9
   0,  3,  2,  1, // 10 (saddle, center inside)
   2,  1, -1, -1, // 11
   1,  3, -1, -1, // 12
   1,  0, -1, -1, // 13
   0,  3, -1, -1, // 14
  -1, -1, -1, -1, // 15
]);
const MS_SADDLE_OUT_5 = [3, 0, 1, 2] as const;
const MS_SADDLE_OUT_10 = [0, 1, 2, 3] as const;

/**
 * Standard 16-case marching squares with linear interpolation on the cell edges. Saddles are
 * resolved with the cell-center average. Segments are stitched into polylines by their integer
 * edge ids (a crossing point is a pure function of its edge, so no coordinate quantization is
 * needed). Output is in logical px; `closed: true` for loops, otherwise open chains that end on
 * the raster border. ~3 ms at 512x384.
 */
export function marchingSquares(field: Raster, iso: number): Polyline[] {
  const { w, h, scale, data } = field;
  const out: Polyline[] = [];
  if (w < 2 || h < 2) return out;
  const inv = 1 / scale;

  // Edge id: horizontal edge from (i, j) to (i+1, j) -> 2*(j*w+i); vertical from (i, j) to
  // (i, j+1) -> 2*(j*w+i)+1. Crossing points are stored once per edge.
  const ptIndex = new Map<number, number>();   // edge id -> index into xs/ys
  const xs: number[] = [];
  const ys: number[] = [];
  const next = new Map<number, number>();      // edge id -> edge id (segment start -> end)
  const hasPrev = new Set<number>();

  const edgePoint = (id: number, i: number, j: number, vertical: boolean): number => {
    const found = ptIndex.get(id);
    if (found !== undefined) return found;
    const p = j * w + i;
    const fa = data[p];
    const fb = vertical ? data[p + w] : data[p + 1];
    const t = (iso - fa) / (fb - fa);
    const k = xs.length;
    if (vertical) {
      xs.push((i + 0.5) * inv);
      ys.push((j + 0.5 + t) * inv);
    } else {
      xs.push((i + 0.5 + t) * inv);
      ys.push((j + 0.5) * inv);
    }
    ptIndex.set(id, k);
    return k;
  };

  // Cell edge k -> (edge id, i, j, vertical) for cell (i, j).
  const cellEdgeId = (k: number, i: number, j: number): number => {
    switch (k) {
      case 0: return 2 * (j * w + i);            // top: H(i, j)
      case 1: return 2 * (j * w + i + 1) + 1;    // right: V(i+1, j)
      case 2: return 2 * ((j + 1) * w + i);      // bottom: H(i, j+1)
      default: return 2 * (j * w + i) + 1;       // left: V(i, j)
    }
  };
  const ensurePoint = (k: number, i: number, j: number): void => {
    switch (k) {
      case 0: edgePoint(cellEdgeId(0, i, j), i, j, false); break;
      case 1: edgePoint(cellEdgeId(1, i, j), i + 1, j, true); break;
      case 2: edgePoint(cellEdgeId(2, i, j), i, j + 1, false); break;
      default: edgePoint(cellEdgeId(3, i, j), i, j, true); break;
    }
  };
  const addSegment = (from: number, to: number, i: number, j: number): void => {
    ensurePoint(from, i, j);
    ensurePoint(to, i, j);
    const a = cellEdgeId(from, i, j);
    const b = cellEdgeId(to, i, j);
    next.set(a, b);
    hasPrev.add(b);
  };

  for (let j = 0; j < h - 1; j++) {
    const row = j * w;
    for (let i = 0; i < w - 1; i++) {
      const p = row + i;
      const v00 = data[p], v10 = data[p + 1], v01 = data[p + w], v11 = data[p + w + 1];
      const c = (v00 > iso ? 1 : 0) | (v10 > iso ? 2 : 0) | (v11 > iso ? 4 : 0) | (v01 > iso ? 8 : 0);
      if (c === 0 || c === 15) continue;
      if (c === 5 || c === 10) {
        const centerInside = (v00 + v10 + v01 + v11) * 0.25 > iso;
        if (centerInside) {
          const b = c * 4;
          addSegment(MS_TABLE[b], MS_TABLE[b + 1], i, j);
          addSegment(MS_TABLE[b + 2], MS_TABLE[b + 3], i, j);
        } else {
          const alt = c === 5 ? MS_SADDLE_OUT_5 : MS_SADDLE_OUT_10;
          addSegment(alt[0], alt[1], i, j);
          addSegment(alt[2], alt[3], i, j);
        }
        continue;
      }
      const b = c * 4;
      addSegment(MS_TABLE[b], MS_TABLE[b + 1], i, j);
    }
  }

  // Stitch. Open chains first (starts with no incoming segment), then whatever remains is loops.
  const visited = new Set<number>();
  const chain: number[] = [];
  const emit = (closed: boolean): void => {
    const pts = new Float32Array(chain.length * 2);
    for (let k = 0; k < chain.length; k++) {
      const q = ptIndex.get(chain[k]) as number;
      pts[2 * k] = xs[q];
      pts[2 * k + 1] = ys[q];
    }
    out.push({ pts, closed });
    chain.length = 0;
  };

  for (const start of next.keys()) {
    if (hasPrev.has(start) || visited.has(start)) continue;
    // Follow `next` until the terminal edge (which has a point but no outgoing segment).
    let e: number | undefined = start;
    while (e !== undefined && !visited.has(e)) {
      visited.add(e);
      chain.push(e);
      e = next.get(e);
    }
    if (chain.length >= 2) emit(false); else chain.length = 0;
  }
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    let e = start;
    do {
      visited.add(e);
      chain.push(e);
      e = next.get(e) as number;
    } while (e !== undefined && e !== start && !visited.has(e));
    if (chain.length >= 3) emit(true); else chain.length = 0;
  }
  return out;
}
