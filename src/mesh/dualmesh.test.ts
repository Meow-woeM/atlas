import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { Mesh, WorldParams } from '../core/types';
import { generatePoints } from './poisson';
import {
  buildMesh, s_next_s, s_prev_s, s_end_r, s_inner_t, s_outer_t,
  r_circulate_s, r_circulate_r, r_circulate_t, t_circulate_r, t_circulate_t, t_circulate_s,
  r_is_boundary, cellPolygon, cellLatLon, cellUnitVector, downwindOrder,
} from './dualmesh';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 40 };

function makeMesh(params: WorldParams, seed: string): Mesh {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  return buildMesh(points, numBoundary);
}

function shoelace(buf: Float32Array, n: number): number {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += buf[2 * i] * buf[2 * j + 1] - buf[2 * j] * buf[2 * i + 1];
  }
  return Math.abs(a) / 2;
}

/** Convex hull area of the point set (monotone chain); the cell areas sum to just under it. */
function hullArea(mesh: Mesh): number {
  const idx: number[] = [];
  for (let r = 0; r < mesh.numRegions; r++) idx.push(r);
  idx.sort((a, b) => mesh.r_x[a] - mesh.r_x[b] || mesh.r_y[a] - mesh.r_y[b]);
  const cross = (o: number, a: number, b: number): number =>
    (mesh.r_x[a] - mesh.r_x[o]) * (mesh.r_y[b] - mesh.r_y[o]) - (mesh.r_y[a] - mesh.r_y[o]) * (mesh.r_x[b] - mesh.r_x[o]);
  const lower: number[] = [];
  for (const p of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: number[] = [];
  for (let i = idx.length - 1; i >= 0; i--) {
    const p = idx[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    a += mesh.r_x[p] * mesh.r_y[q] - mesh.r_x[q] * mesh.r_y[p];
  }
  return Math.abs(a) / 2;
}

/**
 * The section 3.1 invariants, checked with plain counters and a single expect at the end: on the
 * default mesh there are ~60k sides, and one vitest `expect` per element would take ~20 s.
 */
function meshInvariants(mesh: Mesh, params: WorldParams): void {
  const problems: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok && problems.length < 20) problems.push(what);
  };
  const out: number[] = [];

  // Twin of twin is self for every non-hull side; hull twins are -1. A side and its twin connect
  // the same two regions in opposite directions.
  for (let s = 0; s < mesh.numSides; s++) {
    const o = mesh.s_opposite_s[s];
    if (o >= 0) {
      check(mesh.s_opposite_s[o] === s, `twin of twin of side ${s} is ${mesh.s_opposite_s[o]}`);
      check(mesh.s_start_r[o] === s_end_r(mesh, s), `twin of side ${s} does not start at its end`);
      check(s_end_r(mesh, o) === mesh.s_start_r[s], `twin of side ${s} does not end at its start`);
    }
  }

  // Every region has a first side that starts at it.
  for (let r = 0; r < mesh.numRegions; r++) {
    check(mesh.r_first_s[r] >= 0, `region ${r} has no first side`);
    check(mesh.s_start_r[mesh.r_first_s[r]] === r, `first side of region ${r} starts elsewhere`);
  }

  // Interior regions: circulation closes with 3..12 sides, all starting at r, none on the hull.
  const degree = new Int32Array(mesh.numRegions);
  for (let s = 0; s < mesh.numSides; s++) degree[mesh.s_start_r[s]]++;
  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    r_circulate_s(mesh, r, out);
    check(out.length >= 3 && out.length <= 12, `interior region ${r} circulates ${out.length} sides`);
    check(out.length === degree[r], `interior region ${r} circulation misses sides`);
    for (const s of out) {
      check(mesh.s_start_r[s] === r, `side ${s} in circulation of ${r} starts elsewhere`);
      check(mesh.s_opposite_s[s] >= 0, `interior region ${r} touches the hull via side ${s}`);
    }
    check(new Set(out).size === out.length, `interior region ${r} circulation repeats a side`);
  }

  // Boundary regions: circulation (which stops at the hull) still visits every outgoing side.
  for (let r = 0; r < mesh.numBoundaryRegions; r++) {
    r_circulate_s(mesh, r, out);
    check(out.length === degree[r], `boundary region ${r} circulates ${out.length} of ${degree[r]} sides`);
    check(new Set(out).size === out.length, `boundary region ${r} circulation repeats a side`);
  }

  // Every triangle has 3 distinct regions and 3 sides leaving it.
  for (let t = 0; t < mesh.numTriangles; t++) {
    t_circulate_r(mesh, t, out);
    check(out.length === 3 && new Set(out).size === 3, `triangle ${t} lacks 3 distinct regions`);
    t_circulate_s(mesh, t, out);
    check(out[0] === 3 * t && out[1] === 3 * t + 1 && out[2] === 3 * t + 2, `triangle ${t} sides`);
    for (let i = 0; i < 3; i++) check(s_inner_t(3 * t + i) === t, `s_inner_t of side ${3 * t + i}`);
    t_circulate_t(mesh, t, out);
    check(out.length <= 3, `triangle ${t} has ${out.length} neighbors`);
  }

  // Every interior side's inner and outer corners differ, and the outer corner is the twin's inner.
  for (let s = 0; s < mesh.numSides; s++) {
    if (mesh.s_opposite_s[s] < 0) continue;
    check(s_outer_t(mesh, s) !== s_inner_t(s), `side ${s} has inner === outer corner`);
    check(s_outer_t(mesh, s) === s_inner_t(mesh.s_opposite_s[s]), `side ${s} outer corner is not the twin's inner`);
  }

  // Corner positions are the triangle centroids.
  for (let t = 0; t < mesh.numTriangles; t++) {
    const a = mesh.triangles[3 * t], b = mesh.triangles[3 * t + 1], c = mesh.triangles[3 * t + 2];
    const cx = (mesh.r_x[a] + mesh.r_x[b] + mesh.r_x[c]) / 3;
    const cy = (mesh.r_y[a] + mesh.r_y[b] + mesh.r_y[c]) / 3;
    check(Math.abs(mesh.t_x[t] - cx) < 1e-3 && Math.abs(mesh.t_y[t] - cy) < 1e-3, `corner ${t} is not the centroid`);
  }

  // r_circulate_r / r_circulate_t agree with r_circulate_s.
  const nb: number[] = [];
  const tc: number[] = [];
  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    r_circulate_s(mesh, r, out);
    r_circulate_r(mesh, r, nb);
    r_circulate_t(mesh, r, tc);
    check(nb.length === out.length && tc.length === out.length, `region ${r} circulations disagree in length`);
    for (let i = 0; i < out.length; i++) {
      check(nb[i] === s_end_r(mesh, out[i]), `region ${r} neighbor ${i} is not the side's end`);
      check(tc[i] === s_inner_t(out[i]), `region ${r} corner ${i} is not the side's inner corner`);
      check(nb[i] !== r, `region ${r} is its own neighbor`);
    }
    check(new Set(nb).size === nb.length, `region ${r} repeats a neighbor`);
    check(new Set(tc).size === tc.length, `region ${r} repeats a corner`);
  }

  // Cell polygons. Interior cells are closed polygons of >= 3 corners whose areas sum to slightly
  // OVER W*H (cells next to the ring extend ~r/2..r beyond the rectangle edge). Boundary cells are
  // truncated fans (the four ring corners have a single incident triangle, so a single corner),
  // and the centroid dual does not tile the convex hull exactly: every hull triangle loses the
  // third of its area that lies between its hull edge and the centroid, so the total is strictly
  // under the hull area but not by much on a fine mesh.
  const buf = new Float32Array(64);
  let total = 0;
  let interior = 0;
  for (let r = 0; r < mesh.numRegions; r++) {
    const n = cellPolygon(mesh, r, buf);
    check(n >= 1, `region ${r} has an empty polygon`);
    const a = shoelace(buf, n);
    total += a;
    if (!r_is_boundary(mesh, r)) {
      check(n >= 3, `interior region ${r} polygon has ${n} corners`);
      interior += a;
    }
  }
  const hull = hullArea(mesh);
  check(total < hull, `cell areas (${total}) exceed the hull (${hull})`);
  check(total > 0.7 * hull, `cell areas (${total}) are far below the hull (${hull})`);
  const wh = params.width * params.height;
  const margin = params.cellSpacing;
  const upper = (params.width + 2 * margin) * (params.height + 2 * margin);
  check(interior > wh * 0.97, `interior area ${interior} is below 0.97 W*H`);
  check(interior < upper, `interior area ${interior} exceeds (W+2r)(H+2r)`);

  expect(problems).toEqual([]);
}

describe('dualmesh accessors', () => {
  it('s_next_s / s_prev_s are inverse and cycle within the triangle', () => {
    for (let s = 0; s < 30; s++) {
      expect(s_prev_s(s_next_s(s))).toBe(s);
      expect(s_next_s(s_prev_s(s))).toBe(s);
      expect(s_next_s(s_next_s(s_next_s(s)))).toBe(s);
      expect(s_inner_t(s_next_s(s))).toBe(s_inner_t(s));
    }
    expect(s_next_s(2)).toBe(0);
    expect(s_prev_s(0)).toBe(2);
    expect(s_next_s(4)).toBe(5);
  });
});

describe('dualmesh 300-point mesh', () => {
  const mesh = makeMesh(SMALL, 'small');

  it('has a plausible size', () => {
    expect(mesh.numRegions).toBeGreaterThan(80);
    expect(mesh.numRegions).toBeLessThan(400);
    expect(mesh.numSides).toBe(3 * mesh.numTriangles);
    expect(mesh.r_x.length).toBe(mesh.numRegions);
    expect(mesh.numBoundaryRegions).toBeGreaterThan(0);
  });

  it('satisfies the section 3.1 invariants', () => {
    meshInvariants(mesh, SMALL);
  });

  it('is deterministic', () => {
    const again = makeMesh(SMALL, 'small');
    expect(again.triangles).toEqual(mesh.triangles);
    expect(again.halfedges).toEqual(mesh.halfedges);
    expect(again.r_first_s).toEqual(mesh.r_first_s);
    expect(again.t_x).toEqual(mesh.t_x);
  });

  it('cellPolygon honors a too-small buffer without throwing', () => {
    const tiny = new Float32Array(4);
    const r = mesh.numBoundaryRegions;
    expect(cellPolygon(mesh, r, tiny)).toBe(2);
  });

  it('cellLatLon maps the frame linearly with lat0 at the top', () => {
    const params = SMALL;
    for (let r = 0; r < mesh.numRegions; r += 7) {
      const [lat, lon] = cellLatLon(mesh, params, r);
      const fy = mesh.r_y[r] / params.height;
      const fx = mesh.r_x[r] / params.width;
      expect(lat).toBeCloseTo(params.frame.lat0 + (params.frame.lat1 - params.frame.lat0) * fy, 5);
      expect(lon).toBeCloseTo(params.frame.lon0 + (params.frame.lon1 - params.frame.lon0) * fx, 5);
    }
    // Interior cells lie within the frame.
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
      const [lat, lon] = cellLatLon(mesh, params, r);
      expect(lat).toBeLessThanOrEqual(params.frame.lat0);
      expect(lat).toBeGreaterThanOrEqual(params.frame.lat1);
      expect(lon).toBeGreaterThanOrEqual(params.frame.lon0);
      expect(lon).toBeLessThanOrEqual(params.frame.lon1);
    }
  });

  it('cellUnitVector is unit length and northern cells have larger z', () => {
    const v = new Float64Array(3);
    let topZ = -Infinity, bottomZ = Infinity;
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
      const got = cellUnitVector(mesh, SMALL, r, v);
      expect(got).toBe(v);
      const len = Math.hypot(v[0], v[1], v[2]);
      expect(len).toBeCloseTo(1, 9);
      if (mesh.r_y[r] < SMALL.height * 0.2) topZ = Math.max(topZ, v[2]);
      if (mesh.r_y[r] > SMALL.height * 0.8) bottomZ = Math.min(bottomZ, v[2]);
    }
    expect(topZ).toBeGreaterThan(bottomZ);
    const alloc = cellUnitVector(mesh, SMALL, mesh.numBoundaryRegions);
    expect(alloc.length).toBe(3);
  });

  it('downwindOrder sorts interior cells along the wind vector', () => {
    const vectors: [number, number][] = [
      [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
      [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
    ];
    for (let d = 0; d < 8; d++) {
      const order = downwindOrder(mesh, d as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7);
      expect(order.length).toBe(mesh.numRegions - mesh.numBoundaryRegions);
      const [wx, wy] = vectors[d];
      for (let i = 1; i < order.length; i++) {
        const a = order[i - 1], b = order[i];
        expect(r_is_boundary(mesh, a)).toBe(false);
        const ka = mesh.r_x[a] * wx + mesh.r_y[a] * wy;
        const kb = mesh.r_x[b] * wx + mesh.r_y[b] * wy;
        expect(ka <= kb || (ka === kb && a < b)).toBe(true);
      }
      expect(new Set(order).size).toBe(order.length);
    }
    // Wind from the west: the first cell is near the left edge, the last near the right edge.
    const west = downwindOrder(mesh, 0);
    expect(mesh.r_x[west[0]]).toBeLessThan(SMALL.width * 0.25);
    expect(mesh.r_x[west[west.length - 1]]).toBeGreaterThan(SMALL.width * 0.75);
    // Wind from the north blows south: the first cell is near the top (y small).
    const north = downwindOrder(mesh, 2);
    expect(mesh.r_y[north[0]]).toBeLessThan(SMALL.height * 0.25);
  });
});

describe('dualmesh default mesh', () => {
  const { points, numBoundary } = generatePoints(DEFAULT_PARAMS, fork('atlas', 'points'));
  const t0 = performance.now();
  const mesh = buildMesh(points, numBoundary);
  const buildMs = performance.now() - t0;

  it('has 8000..12000 regions', () => {
    expect(mesh.numRegions).toBeGreaterThan(8000);
    expect(mesh.numRegions).toBeLessThan(12000);
    expect(mesh.numBoundaryRegions).toBe(numBoundary);
  });

  it('satisfies the section 3.1 invariants', () => {
    meshInvariants(mesh, DEFAULT_PARAMS);
  });

  it('interior cell areas sum to W*H within ~3 %', () => {
    const buf = new Float32Array(64);
    let interior = 0;
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
      interior += shoelace(buf, cellPolygon(mesh, r, buf));
    }
    const wh = DEFAULT_PARAMS.width * DEFAULT_PARAMS.height;
    const ratio = interior / wh;
    // Measured ~1.02-1.03: cells next to the ring extend past the rectangle edge.
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.035);
  });

  it('builds in under 50 ms', () => {
    // Re-run a couple of times so the JIT is warm; report the best.
    let best = buildMs;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      buildMesh(points, numBoundary);
      best = Math.min(best, performance.now() - t);
    }
    console.log(`buildMesh default: first ${buildMs.toFixed(1)} ms, best ${best.toFixed(1)} ms`);
    expect(best).toBeLessThan(50);
  });
});
