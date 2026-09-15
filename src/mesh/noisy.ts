/**
 * mesh/noisy.ts — Stage 3 (Noisy edges).
 * RNG stream: `edges` (the caller passes fork(seed, 'edges')).
 * Inputs: Mesh. Outputs: NoisyEdges — one mapgen2-style subdivided path per undirected edge.
 *
 * For every canonical side (s_opposite_s[s] === -1, or s < s_opposite_s[s]) the quad
 * (t_in, r_a, t_out, r_b) — t_in = s_inner_t(s), r_a = s_start_r[s], t_out = s_outer_t(s),
 * r_b = s_end_r(s) — is recursively split: the midpoint of the corner-to-corner diagonal is replaced
 * by a random point on the r_a–r_b segment within `amplitude` of the quad center, then each half
 * is split again. `levels` = 2 gives 5 points (t_in, 3 displaced, t_out). RNG consumption: one
 * rng.next() per split, sides in ascending index order, root split first then the t_in half then
 * the t_out half. Changing this order is a params.version bump.
 *
 * Storage: s_pathStart / s_pathLen are written on BOTH half-edges of an edge (the values are those
 * of the canonical side, so lookups are O(1)); the twin reads the path reversed. Hull sides
 * (s_opposite_s === -1) have no outer corner: s_pathStart = -1, s_pathLen = 1, and sidePath returns
 * just [t_in]. Hull sides join two boundary-ring regions (always ocean), so they are never coast,
 * lake shore, river or border sides, and this degenerate path is never drawn.
 *
 * chainSides is the generic side-chaining used by coasts, lake shores and borders. Unsmoothed.
 */

import type { Mesh, NoisyEdges, Polyline } from '../core/types';
import { s_inner_t, s_next_s, s_outer_t } from './dualmesh';
import type { Rng } from '../core/rng';

export function buildNoisyEdges(mesh: Mesh, rng: Rng, amplitude = 0.5, levels = 2): NoisyEdges {
  const numSides = mesh.numSides;
  const pointsPerPath = (1 << levels) + 1;
  const s_pathStart = new Int32Array(numSides).fill(-1);
  const s_pathLen = new Uint8Array(numSides);

  let numCanonical = 0;
  for (let s = 0; s < numSides; s++) {
    const o = mesh.s_opposite_s[s];
    if (o >= 0 && s < o) numCanonical++;
  }
  const pts = new Float32Array(numCanonical * pointsPerPath * 2);
  let cursor = 0;

  const { r_x, r_y, t_x, t_y, s_start_r, s_opposite_s } = mesh;

  // Quad (a, b, c, d): a and c are corners (the path runs a -> c), b and d are region centers.
  // Pushes every point after `a`; the caller pushes `a` itself first.
  const subdivide = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number, level: number,
  ): void => {
    if (level === 0) {
      pts[cursor++] = cx;
      pts[cursor++] = cy;
      return;
    }
    const f = 0.5 + amplitude * (rng.next() - 0.5);
    const ex = bx + (dx - bx) * f;
    const ey = by + (dy - by) * f;
    subdivide(ax, ay, (ax + bx) * 0.5, (ay + by) * 0.5, ex, ey, (ax + dx) * 0.5, (ay + dy) * 0.5, level - 1);
    subdivide(ex, ey, (bx + cx) * 0.5, (by + cy) * 0.5, cx, cy, (cx + dx) * 0.5, (cy + dy) * 0.5, level - 1);
  };

  for (let s = 0; s < numSides; s++) {
    const o = s_opposite_s[s];
    if (o < 0) {
      s_pathStart[s] = -1;
      s_pathLen[s] = 1;
      continue;
    }
    if (s > o) continue;
    const tIn = (s / 3) | 0;
    const tOut = (o / 3) | 0;
    const ra = s_start_r[s];
    const rb = s_start_r[s_next_s(s)];
    const start = cursor;
    pts[cursor++] = t_x[tIn];
    pts[cursor++] = t_y[tIn];
    subdivide(t_x[tIn], t_y[tIn], r_x[ra], r_y[ra], t_x[tOut], t_y[tOut], r_x[rb], r_y[rb], levels);
    s_pathStart[s] = start;
    s_pathLen[s] = pointsPerPath;
    s_pathStart[o] = start;
    s_pathLen[o] = pointsPerPath;
  }

  return { s_pathStart, s_pathLen, pts };
}

/** Pushes the xy pairs of side s's noisy path, from corner s_inner_t(s) to corner s_outer_t(s).
 *  Appends to `out` (does not clear it). Hull sides push only their inner corner. */
export function sidePath(edges: NoisyEdges, mesh: Mesh, s: number, out: number[]): number[] {
  const start = edges.s_pathStart[s];
  if (start < 0) {
    const t = (s / 3) | 0;
    out.push(mesh.t_x[t], mesh.t_y[t]);
    return out;
  }
  const len = edges.s_pathLen[s];
  const pts = edges.pts;
  const o = mesh.s_opposite_s[s];
  if (o < s) {
    // Twin of the canonical side: read reversed.
    for (let i = len - 1; i >= 0; i--) out.push(pts[start + 2 * i], pts[start + 2 * i + 1]);
  } else {
    for (let i = 0; i < len; i++) out.push(pts[start + 2 * i], pts[start + 2 * i + 1]);
  }
  return out;
}

/**
 * Chains sides satisfying `isChainSide` into ordered polylines. Each side runs from its inner corner
 * to its outer corner; the successor of a side is the lowest-index chain side leaving its outer
 * corner. Chains are started at every chain side with no predecessor (open chains), then at any
 * remaining unvisited chain side (closed loops). A chain closes when it returns to its start side;
 * closed polylines do not repeat the first point. Shared joint points are emitted once.
 * Deterministic: everything is driven by ascending side index.
 */
export function chainSides(mesh: Mesh, edges: NoisyEdges, isChainSide: (s: number) => boolean): Polyline[] {
  const numSides = mesh.numSides;
  const isChain = new Uint8Array(numSides);
  const nextOf = new Int32Array(mesh.numTriangles).fill(-1);
  for (let s = 0; s < numSides; s++) {
    if (!isChainSide(s)) continue;
    isChain[s] = 1;
    const t = s_inner_t(s);
    if (nextOf[t] < 0) nextOf[t] = s;
  }
  const hasPred = new Uint8Array(numSides);
  for (let s = 0; s < numSides; s++) {
    if (!isChain[s]) continue;
    const t = s_outer_t(mesh, s);
    if (t < 0) continue;
    const n = nextOf[t];
    if (n >= 0) hasPred[n] = 1;
  }

  const visited = new Uint8Array(numSides);
  const result: Polyline[] = [];
  const scratch: number[] = [];

  const walk = (start: number): void => {
    const acc: number[] = [];
    let closed = false;
    let s = start;
    for (;;) {
      visited[s] = 1;
      scratch.length = 0;
      sidePath(edges, mesh, s, scratch);
      // Drop the joint point (the previous side's outer corner === this side's inner corner).
      const from = s === start ? 0 : 2;
      for (let i = from; i < scratch.length; i++) acc.push(scratch[i]);
      const t = s_outer_t(mesh, s);
      if (t < 0) break;
      const n = nextOf[t];
      if (n < 0) break;
      if (n === start) { closed = true; break; }
      if (visited[n]) break;
      s = n;
    }
    if (closed && acc.length >= 4) acc.length -= 2;
    result.push({ pts: Float32Array.from(acc), closed });
  };

  for (let s = 0; s < numSides; s++) {
    if (isChain[s] && !visited[s] && !hasPred[s]) walk(s);
  }
  for (let s = 0; s < numSides; s++) {
    if (isChain[s] && !visited[s]) walk(s);
  }
  return result;
}
