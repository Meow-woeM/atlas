/**
 * mesh/dualmesh.ts — Stage 2 (Mesh).
 * RNG stream: none (Delaunator is deterministic floating point).
 * Inputs: xy-interleaved points (boundary ring first) and numBoundary.
 * Outputs: the immutable Mesh (section 3.1) plus the pure index-arithmetic accessors, cellPolygon,
 * and the four coordinate helpers (cellLatLon, cellUnitVector, downwindOrder, cellPolygon) that are
 * the ONLY places generation code may read raw x/y.
 *
 * Index spaces: r (regions = points = Voronoi cells), t (triangles = Voronoi corners, positioned at
 * the triangle centroid), s (half-edges; s_opposite_s[s] = -1 on the convex hull).
 *   s_start_r[s]    = triangles[s]               region the side leaves from
 *   s_end_r(s)      = s_start_r[s_next_s(s)]
 *   s_inner_t(s)    = floor(s / 3)               corner on the side's own triangle
 *   s_outer_t(s)    = floor(s_opposite_s[s] / 3) corner on the twin triangle (-1 on the hull)
 *   r_circulate_s   = walk s -> s_next_s(s_opposite_s(s)) from r_first_s[r]; for hull regions
 *                     r_first_s is chosen as the start of the fan so the walk covers every side
 *                     before hitting the hull (-1), where it stops.
 */

import Delaunator from 'delaunator';
import type { Mesh, WindDir, WorldParams } from '../core/types';

export function buildMesh(points: Float64Array, numBoundary: number): Mesh {
  const numRegions = points.length >> 1;
  const del = new Delaunator(points);
  const triangles = Int32Array.from(del.triangles);
  const halfedges = Int32Array.from(del.halfedges);
  const numSides = triangles.length;
  const numTriangles = numSides / 3;

  const r_x = new Float32Array(numRegions);
  const r_y = new Float32Array(numRegions);
  for (let r = 0; r < numRegions; r++) {
    r_x[r] = points[2 * r];
    r_y[r] = points[2 * r + 1];
  }

  const t_x = new Float32Array(numTriangles);
  const t_y = new Float32Array(numTriangles);
  for (let t = 0; t < numTriangles; t++) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    t_x[t] = (points[2 * a] + points[2 * b] + points[2 * c]) / 3;
    t_y[t] = (points[2 * a + 1] + points[2 * b + 1] + points[2 * c + 1]) / 3;
  }

  const s_start_r = triangles;
  const s_opposite_s = halfedges;

  // One outgoing side per region. Interior regions: any side works (the circulation is a cycle).
  // Hull regions: pick the side with no predecessor in the circulation order, i.e. the side whose
  // s_prev_s has no twin; walking s_next_s(s_opposite_s(s)) from it visits every side and then
  // stops at the hull. Each hull region has exactly one such side.
  const r_first_s = new Int32Array(numRegions).fill(-1);
  for (let s = 0; s < numSides; s++) {
    const r = triangles[s];
    if (r_first_s[r] < 0) r_first_s[r] = s;
  }
  for (let s = 0; s < numSides; s++) {
    if (halfedges[s_prev_s(s)] === -1) r_first_s[triangles[s]] = s;
  }

  return {
    numRegions,
    numBoundaryRegions: numBoundary,
    numTriangles,
    numSides,
    r_x, r_y, t_x, t_y,
    s_start_r, s_opposite_s, r_first_s,
    triangles, halfedges,
  };
}

// ---------------------------------------------------------------- pure index arithmetic

export function s_next_s(s: number): number {
  return s % 3 === 2 ? s - 2 : s + 1;
}

export function s_prev_s(s: number): number {
  return s % 3 === 0 ? s + 2 : s - 1;
}

export function s_end_r(mesh: Mesh, s: number): number {
  return mesh.s_start_r[s_next_s(s)];
}

export function s_inner_t(s: number): number {
  return (s / 3) | 0;
}

/** -1 on the hull. */
export function s_outer_t(mesh: Mesh, s: number): number {
  const o = mesh.s_opposite_s[s];
  return o < 0 ? -1 : (o / 3) | 0;
}

/** Outgoing sides of r in circulation order. Terminates at the hull for boundary regions. */
export function r_circulate_s(mesh: Mesh, r: number, out: number[]): number[] {
  out.length = 0;
  const s0 = mesh.r_first_s[r];
  if (s0 < 0) return out;
  let s = s0;
  do {
    out.push(s);
    const o = mesh.s_opposite_s[s];
    if (o < 0) break;
    s = s_next_s(o);
  } while (s !== s0);
  return out;
}

/** Neighbor regions of r, in circulation order. */
export function r_circulate_r(mesh: Mesh, r: number, out: number[]): number[] {
  out.length = 0;
  const s0 = mesh.r_first_s[r];
  if (s0 < 0) return out;
  let s = s0;
  do {
    out.push(mesh.s_start_r[s_next_s(s)]);
    const o = mesh.s_opposite_s[s];
    if (o < 0) break;
    s = s_next_s(o);
  } while (s !== s0);
  return out;
}

/** Corners of the cell polygon of r, in circulation order. */
export function r_circulate_t(mesh: Mesh, r: number, out: number[]): number[] {
  out.length = 0;
  const s0 = mesh.r_first_s[r];
  if (s0 < 0) return out;
  let s = s0;
  do {
    out.push((s / 3) | 0);
    const o = mesh.s_opposite_s[s];
    if (o < 0) break;
    s = s_next_s(o);
  } while (s !== s0);
  return out;
}

/** The 3 regions of triangle t. */
export function t_circulate_r(mesh: Mesh, t: number, out: number[]): number[] {
  out.length = 0;
  out.push(mesh.s_start_r[3 * t], mesh.s_start_r[3 * t + 1], mesh.s_start_r[3 * t + 2]);
  return out;
}

/** The <= 3 neighboring corners of t (fewer on the hull). */
export function t_circulate_t(mesh: Mesh, t: number, out: number[]): number[] {
  out.length = 0;
  for (let i = 0; i < 3; i++) {
    const o = mesh.s_opposite_s[3 * t + i];
    if (o >= 0) out.push((o / 3) | 0);
  }
  return out;
}

/** The 3 sides of triangle t (each leaves corner t toward its outer corner). */
export function t_circulate_s(_mesh: Mesh, t: number, out: number[]): number[] {
  out.length = 0;
  out.push(3 * t, 3 * t + 1, 3 * t + 2);
  return out;
}

export function r_is_boundary(mesh: Mesh, r: number): boolean {
  return r < mesh.numBoundaryRegions;
}

// ---------------------------------------------------------------- the four coordinate helpers

/** Writes the corner coordinates of cell r (xy pairs, circulation order) into out and returns the
 *  point count. `out` must hold 2 floats per corner (32 floats is always enough for interior cells);
 *  corners that do not fit are dropped and not counted. */
export function cellPolygon(mesh: Mesh, r: number, out: Float32Array): number {
  const s0 = mesh.r_first_s[r];
  if (s0 < 0) return 0;
  const cap = out.length >> 1;
  let n = 0;
  let s = s0;
  do {
    if (n >= cap) break;
    const t = (s / 3) | 0;
    out[2 * n] = mesh.t_x[t];
    out[2 * n + 1] = mesh.t_y[t];
    n++;
    const o = mesh.s_opposite_s[s];
    if (o < 0) break;
    s = s_next_s(o);
  } while (s !== s0);
  return n;
}

/**
 * Cell positions as the average of each cellPolygon's corners. This is the sanctioned way to get a
 * cell's position for generation (mesh.r_x / r_y are the Delaunay input points, which sit off-centre
 * in a cell whose polygon is one-sided). Fills `out` when given, allocates otherwise.
 */
export function cellCentroids(
  mesh: Mesh, out?: { r_px: Float32Array; r_py: Float32Array },
): { r_px: Float32Array; r_py: Float32Array } {
  const n = mesh.numRegions;
  const r_px = out ? out.r_px : new Float32Array(n);
  const r_py = out ? out.r_py : new Float32Array(n);
  const poly = new Float32Array(64);
  for (let r = 0; r < n; r++) {
    const k = cellPolygon(mesh, r, poly);
    if (k === 0) { r_px[r] = 0; r_py[r] = 0; continue; }
    let sx = 0, sy = 0;
    for (let i = 0; i < k; i++) {
      sx += poly[2 * i];
      sy += poly[2 * i + 1];
    }
    r_px[r] = sx / k;
    r_py[r] = sy / k;
  }
  return { r_px, r_py };
}

/** Linear map of the cell center into params.frame; lat0 is at y = 0 (top), lon0 at x = 0. */
export function cellLatLon(mesh: Mesh, params: WorldParams, r: number): [lat: number, lon: number] {
  const f = params.frame;
  const lat = f.lat0 + (f.lat1 - f.lat0) * (mesh.r_y[r] / params.height);
  const lon = f.lon0 + (f.lon1 - f.lon0) * (mesh.r_x[r] / params.width);
  return [lat, lon];
}

/** Unit 3-vector of the cell's lat/lon on the sphere (x toward lon 0, z toward the north pole). */
export function cellUnitVector(mesh: Mesh, params: WorldParams, r: number, out?: Float64Array): Float64Array {
  const v = out ?? new Float64Array(3);
  const [lat, lon] = cellLatLon(mesh, params, r);
  const la = lat * (Math.PI / 180);
  const lo = lon * (Math.PI / 180);
  const cl = Math.cos(la);
  v[0] = cl * Math.cos(lo);
  v[1] = cl * Math.sin(lo);
  v[2] = Math.sin(la);
  return v;
}

/** Direction the wind blows TOWARD, per WindDir (0 = from W -> east = (1, 0); canvas y is down,
 *  so 2 = from N -> south = (0, 1)). Unit vectors. */
const WIND_VECTORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
] as const;

/** Interior (non-boundary) regions sorted by dot(position, windVector) ascending, upwind first;
 *  ties broken on the index. */
export function downwindOrder(mesh: Mesh, dir: WindDir): Int32Array {
  const [wx, wy] = WIND_VECTORS[dir];
  const n = mesh.numRegions - mesh.numBoundaryRegions;
  const key = new Float64Array(mesh.numRegions);
  const order = new Int32Array(n);
  for (let r = mesh.numBoundaryRegions, i = 0; r < mesh.numRegions; r++, i++) {
    key[r] = mesh.r_x[r] * wx + mesh.r_y[r] * wy;
    order[i] = r;
  }
  order.sort((a, b) => key[a] - key[b] || a - b);
  return order;
}
