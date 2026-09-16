import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { Mesh, NoisyEdges, WorldParams } from '../core/types';
import { generatePoints } from './poisson';
import { buildMesh, s_end_r, s_inner_t, s_outer_t } from './dualmesh';
import { buildNoisyEdges, sidePath, chainSides } from './noisy';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 40 };

function make(params: WorldParams, seed: string): { mesh: Mesh; edges: NoisyEdges } {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  const mesh = buildMesh(points, numBoundary);
  const edges = buildNoisyEdges(mesh, fork(seed, 'edges'));
  return { mesh, edges };
}

/**
 * Path/twin consistency for every side, checked with plain counters and one expect at the end (the
 * default mesh has ~60k sides; per-element vitest expects would take ~25 s).
 */
function checkEdges(mesh: Mesh, edges: NoisyEdges, cellSpacing: number): void {
  const problems: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok && problems.length < 20) problems.push(what);
  };
  const a: number[] = [];
  const b: number[] = [];
  for (let s = 0; s < mesh.numSides; s++) {
    const o = mesh.s_opposite_s[s];
    if (o < 0) {
      check(edges.s_pathStart[s] === -1, `hull side ${s} has a path`);
      a.length = 0;
      sidePath(edges, mesh, s, a);
      check(a.length === 2 && a[0] === mesh.t_x[s_inner_t(s)], `hull side ${s} path is not its inner corner`);
      continue;
    }
    check(edges.s_pathStart[s] >= 0, `side ${s} has no path`);
    check(edges.s_pathLen[s] === 5, `side ${s} path has ${edges.s_pathLen[s]} points`);
    check(edges.s_pathStart[s] === edges.s_pathStart[o], `side ${s} and twin ${o} store different paths`);

    a.length = 0; b.length = 0;
    sidePath(edges, mesh, s, a);
    sidePath(edges, mesh, o, b);
    check(a.length === 10 && b.length === 10, `side ${s} path length ${a.length}/${b.length}`);
    // Endpoints are the corners.
    const tIn = s_inner_t(s), tOut = s_outer_t(mesh, s);
    check(a[0] === mesh.t_x[tIn] && a[1] === mesh.t_y[tIn], `side ${s} path does not start at its inner corner`);
    check(a[8] === mesh.t_x[tOut] && a[9] === mesh.t_y[tOut], `side ${s} path does not end at its outer corner`);
    // Twin is the exact reverse.
    let reversed = true;
    for (let i = 0; i < 5; i++) {
      if (b[2 * i] !== a[2 * (4 - i)] || b[2 * i + 1] !== a[2 * (4 - i) + 1]) reversed = false;
    }
    check(reversed, `twin ${o} is not the reverse of side ${s}`);
    // Interior points stay inside the quad's bounding box (the quad is convex-ish; use a loose box).
    const ra = mesh.s_start_r[s], rb = s_end_r(mesh, s);
    const minX = Math.min(mesh.t_x[tIn], mesh.t_x[tOut], mesh.r_x[ra], mesh.r_x[rb]) - 1e-3;
    const maxX = Math.max(mesh.t_x[tIn], mesh.t_x[tOut], mesh.r_x[ra], mesh.r_x[rb]) + 1e-3;
    const minY = Math.min(mesh.t_y[tIn], mesh.t_y[tOut], mesh.r_y[ra], mesh.r_y[rb]) - 1e-3;
    const maxY = Math.max(mesh.t_y[tIn], mesh.t_y[tOut], mesh.r_y[ra], mesh.r_y[rb]) + 1e-3;
    let inBox = true;
    for (let i = 0; i < 5; i++) {
      if (a[2 * i] < minX || a[2 * i] > maxX || a[2 * i + 1] < minY || a[2 * i + 1] > maxY) inBox = false;
    }
    check(inBox, `side ${s} path leaves its quad`);
  }
  void cellSpacing;
  expect(problems).toEqual([]);
}

function checkChains(mesh: Mesh, edges: NoisyEdges, cellSpacing: number): void {
  const parity = (r: number): number => r & 1;
  const isChain = (s: number): boolean => parity(mesh.s_start_r[s]) !== parity(s_end_r(mesh, s));
  const chains = chainSides(mesh, edges, isChain);
  expect(chains.length).toBeGreaterThan(0);
  let totalPts = 0;
  let closedCount = 0;
  const limit = 2 * cellSpacing;
  for (const c of chains) {
    expect(c.pts.length % 2).toBe(0);
    const n = c.pts.length >> 1;
    expect(n).toBeGreaterThanOrEqual(1);
    totalPts += n;
    if (c.closed) closedCount++;
    const segs = c.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const d = Math.hypot(c.pts[2 * i] - c.pts[2 * j], c.pts[2 * i + 1] - c.pts[2 * j + 1]);
      expect(d).toBeLessThanOrEqual(limit);
      // Consecutive points are distinct (joints were deduplicated).
      expect(d).toBeGreaterThan(0);
    }
  }
  // Every chain side appears in exactly one chain: count sides vs. points (4 new points per
  // interior side after the shared joint, 1 for the start side, hull sides 1).
  let chainSideCount = 0;
  for (let s = 0; s < mesh.numSides; s++) if (isChain(s)) chainSideCount++;
  expect(chainSideCount).toBeGreaterThan(0);
  expect(totalPts).toBeLessThanOrEqual(chainSideCount * 5);
  expect(totalPts).toBeGreaterThan(chainSideCount);
  void closedCount;
}

describe('noisy edges (300-point mesh)', () => {
  const { mesh, edges } = make(SMALL, 'small');

  it('stores one 5-point path per undirected interior edge', () => {
    let canonical = 0;
    for (let s = 0; s < mesh.numSides; s++) {
      const o = mesh.s_opposite_s[s];
      if (o >= 0 && s < o) canonical++;
    }
    expect(edges.pts.length).toBe(canonical * 10);
    checkEdges(mesh, edges, SMALL.cellSpacing);
  });

  it('is deterministic and depends on the seed', () => {
    const again = buildNoisyEdges(mesh, fork('small', 'edges'));
    expect(again.pts).toEqual(edges.pts);
    const other = buildNoisyEdges(mesh, fork('other', 'edges'));
    expect(other.pts).not.toEqual(edges.pts);
  });

  it('actually displaces the midpoints', () => {
    let displaced = 0, total = 0;
    for (let s = 0; s < mesh.numSides; s++) {
      const o = mesh.s_opposite_s[s];
      if (o < 0 || s > o) continue;
      const p = edges.s_pathStart[s];
      const x0 = edges.pts[p], y0 = edges.pts[p + 1];
      const x4 = edges.pts[p + 8], y4 = edges.pts[p + 9];
      const mx = (x0 + x4) / 2, my = (y0 + y4) / 2;
      const d = Math.hypot(edges.pts[p + 4] - mx, edges.pts[p + 5] - my);
      total++;
      if (d > 0.05) displaced++;
    }
    expect(displaced / total).toBeGreaterThan(0.8);
  });

  it('chains parity sides into polylines with short steps', () => {
    checkChains(mesh, edges, SMALL.cellSpacing);
  });

  it('chains a single closed cell outline', () => {
    // The sides leaving one interior cell form a closed loop when chained "into" the cell:
    // choose sides whose END region is r (so successive sides share corners around r).
    const r = mesh.numBoundaryRegions + 3;
    const chains = chainSides(mesh, edges, (s) => s_end_r(mesh, s) === r);
    expect(chains.length).toBe(1);
    expect(chains[0].closed).toBe(true);
    const n = chains[0].pts.length >> 1;
    expect(n).toBeGreaterThanOrEqual(3 * 4);
  });

  it('produces an open chain for a single side', () => {
    let s = 0;
    while (mesh.s_opposite_s[s] < 0) s++;
    const chains = chainSides(mesh, edges, (x) => x === s);
    expect(chains.length).toBe(1);
    expect(chains[0].closed).toBe(false);
    expect(chains[0].pts.length).toBe(10);
  });
});

describe('noisy edges (default mesh)', () => {
  const { mesh, edges } = make(DEFAULT_PARAMS, 'atlas');

  it('paths and twins are consistent', () => {
    checkEdges(mesh, edges, DEFAULT_PARAMS.cellSpacing);
  });

  it('chains parity sides into polylines with short steps', () => {
    checkChains(mesh, edges, DEFAULT_PARAMS.cellSpacing);
  });
});
