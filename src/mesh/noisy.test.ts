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

function checkEdges(mesh: Mesh, edges: NoisyEdges, cellSpacing: number): void {
  const a: number[] = [];
  const b: number[] = [];
  for (let s = 0; s < mesh.numSides; s++) {
    const o = mesh.s_opposite_s[s];
    if (o < 0) {
      expect(edges.s_pathStart[s]).toBe(-1);
      a.length = 0;
      sidePath(edges, mesh, s, a);
      expect(a.length).toBe(2);
      expect(a[0]).toBe(mesh.t_x[s_inner_t(s)]);
      continue;
    }
    expect(edges.s_pathStart[s]).toBeGreaterThanOrEqual(0);
    expect(edges.s_pathLen[s]).toBe(5);
    expect(edges.s_pathStart[s]).toBe(edges.s_pathStart[o]);

    a.length = 0; b.length = 0;
    sidePath(edges, mesh, s, a);
    sidePath(edges, mesh, o, b);
    expect(a.length).toBe(10);
    expect(b.length).toBe(10);
    // Endpoints are the corners.
    const tIn = s_inner_t(s), tOut = s_outer_t(mesh, s);
    expect(a[0]).toBe(mesh.t_x[tIn]);
    expect(a[1]).toBe(mesh.t_y[tIn]);
    expect(a[8]).toBe(mesh.t_x[tOut]);
    expect(a[9]).toBe(mesh.t_y[tOut]);
    // Twin is the exact reverse.
    for (let i = 0; i < 5; i++) {
      expect(b[2 * i]).toBe(a[2 * (4 - i)]);
      expect(b[2 * i + 1]).toBe(a[2 * (4 - i) + 1]);
    }
    // Interior points stay inside the quad's bounding box (the quad is convex-ish; use a loose box).
    const ra = mesh.s_start_r[s], rb = s_end_r(mesh, s);
    const xs = [mesh.t_x[tIn], mesh.t_x[tOut], mesh.r_x[ra], mesh.r_x[rb]];
    const ys = [mesh.t_y[tIn], mesh.t_y[tOut], mesh.r_y[ra], mesh.r_y[rb]];
    const minX = Math.min(...xs) - 1e-3, maxX = Math.max(...xs) + 1e-3;
    const minY = Math.min(...ys) - 1e-3, maxY = Math.max(...ys) + 1e-3;
    for (let i = 0; i < 5; i++) {
      expect(a[2 * i]).toBeGreaterThanOrEqual(minX);
      expect(a[2 * i]).toBeLessThanOrEqual(maxX);
      expect(a[2 * i + 1]).toBeGreaterThanOrEqual(minY);
      expect(a[2 * i + 1]).toBeLessThanOrEqual(maxY);
    }
    // The path is not the straight segment (displacement happened) for at least most sides;
    // checked in aggregate below.
    void cellSpacing;
  }
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
