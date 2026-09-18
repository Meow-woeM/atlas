/**
 * gen/hydrology.ts — Stage 7 (Hydrology on the corner graph).
 *
 * RNG stream: none. The stage is a deterministic graph algorithm; every tie is broken on the
 * smaller index (corner, side or cell), so the result depends only on the inputs.
 *
 * Inputs:  Mesh, WorldParams (lakesMax, riverPercentile), r_elevation (-1..1), r_water (0 land,
 *          1 ocean, 2 inland water below sea level = lake candidate from stage 4), r_moisture.
 *          Inputs are never mutated; r_water is returned as a COPY with the lake decision applied.
 * Outputs: HydrologyResult (ARCHITECTURE.md section 7.1) plus revertedCells: the cells that
 *          arrived with r_water === 2 (negative r_elevation) and leave as land (0) because their
 *          component was too small or beyond lakesMax, ascending; world.ts lifts their elevation.
 *
 * Steps, as ARCHITECTURE.md section 5 "Stage 7" lists them:
 *   1. t_raw[t] = mean r_elevation of the corner's 3 cells (t_circulate_r). Ocean corners touch a
 *      cell with r_water === 1. Heights stay Float64 until the end.
 *   2. Priority-Flood + epsilon (Barnes, Lehman, Mulla 2014) on core/heap.ts's MinHeap, keyed on
 *      height (the heap tie-breaks on the corner index): every ocean corner is seeded at its raw
 *      height; popping a corner assigns each unvisited neighbor (t_circulate_t) fill = max(raw,
 *      popped + EPS), EPS = 1e-5, and pushes it. Popped keys never decrease (every push is above
 *      the popped key), so a corner is first discovered from its lowest neighbor and the single
 *      heap is equivalent to the paper's heap + pit queue. Every non-ocean corner therefore sits
 *      at least EPS above the neighbor it was flooded from (its "flood parent"), which is what
 *      makes t_downslope_s total on land and the flow graph acyclic. fill is copied to Float32
 *      t_elevation at the end; EPS is ~80 Float32 ulps at 1.0, so the strict order survives.
 *   3. Lakes. A corner is "flooded" when fill - raw > LAKE_DEPTH (0.005). Lake CELL candidates are
 *      the cells with r_water === 2 (by definition) plus the land cells whose >= 3 corners
 *      (r_circulate_t) are all flooded. Connected components of candidates over r_circulate_r with
 *      >= LAKE_MIN_CELLS (4) cells are ranked by (size desc, smallest cell index asc) and the first
 *      params.lakesMax become lakes, numbered in that order; every other candidate reverts to land
 *      (r_water 0) and simply carries the river that crosses it. t_lake[t] = the lake of any lake
 *      cell t is a corner of (the 3 cells of a triangle are mutually adjacent, so two lakes never
 *      share a corner). lakeCells[L] lists the cells ascending. No lake cell touches an ocean
 *      cell: an r_water 2 cell was not reached by the stage-4 ocean flood, and a land candidate
 *      adjacent to ocean would own an ocean corner, which is never flooded.
 *      Outlet (exact choice): lakeOutlet_t[L] is the lowest corner (fill, then smaller index) that
 *      is adjacent via t_circulate_t to some corner of L and is not itself a corner of L. Ocean
 *      corners and corners of OTHER lakes are allowed. With that candidate set the outlet is
 *      strictly lower than every corner of L: L's lowest corner m is not ocean, so it was flooded
 *      from a neighbor n with fill[n] <= fill[m] - EPS; n is lower than L's minimum so it is not a
 *      corner of L, hence a candidate, and the outlet is at most fill[n]. A lake whose outlet is
 *      another lake's corner drains through that lake (whose outlet is lower still), never in a
 *      cycle. The outlet is one side outside the shore: the side from that lake corner m to the
 *      outlet is the one features.ts would prepend to draw the outflow touching the lake.
 *      From here on "lake corner" means t_lake[t] >= 0 (the cell-based set), NOT the flooded set:
 *      flooded corners of reverted candidates are ordinary land corners.
 *   4. t_downslope_s[t] for corners that are neither ocean nor lake corners: the side 3t + i whose
 *      outer corner (s_outer_t) has the lowest fill, ties to the smaller outer corner index; -1 at
 *      ocean and lake corners. Step 2 guarantees the chosen corner is strictly lower.
 *   5. Flow accumulation. Every corner receives rain = mean r_moisture of its 3 cells (ocean
 *      corners included; they only collect). Corners are visited in fill-descending order
 *      (typed-array index sort, ascending index tie-break) and forward their total to t_next[t]:
 *      the downslope outer corner for land corners, the lake's outlet for lake corners, nothing
 *      for ocean corners. Every forward goes to a strictly lower corner (steps 2 and 3), so the
 *      visit order is a topological order and the equal-height case cannot arise between a corner
 *      and its target; the delivery loop still checks a `done` flag and, were a target already
 *      visited, keeps forwarding along t_next until it reaches an unvisited corner or a sink, so
 *      no flux can be stranded. Accumulated in Float64, copied to Float32.
 *   6. Rivers. threshold = quantile(t_flux over land non-lake corners, params.riverPercentile).
 *      Sources = land corners with flux >= threshold none of whose upstream corners (land corners
 *      whose downslope side points at them) reaches the threshold, processed in flux-descending
 *      order (index tie-break). Each source walks t_downslope_s: a step takes side
 *      s = t_downslope_s[t] from corner t = s_inner_t(s) to s_outer_t(s), writing s_river =
 *      t_flux[t] and s_riverId on s and its twin; the walk stops at an ocean or lake corner
 *      (mouth, parent -1) or when the next side already belongs to a river (parent = that river,
 *      mouth = the shared corner, which is the inner corner of one of the parent's sides); a step
 *      counter capped at numTriangles guards against cycles. Rivers with fewer than
 *      RIVER_MIN_SIDES (6) sides that no surviving river names as parent are removed repeatedly
 *      until nothing changes (removals only enable further removals, so the fixpoint is
 *      order-independent), their sides cleared; survivors are compacted to dense ids 0..n-1 in
 *      their original (flux-descending) order and s_riverId / riverParent are remapped, so no
 *      dangling parent exists. riverSides[i] is ordered source -> mouth.
 */

import type { Mesh, WorldParams } from '../core/types';
import { MinHeap } from '../core/heap';
import { quantile } from '../core/geom';
import { r_circulate_r, r_circulate_t, t_circulate_r, t_circulate_t, s_outer_t } from '../mesh/dualmesh';

export interface HydrologyResult {
  t_elevation: Float32Array; t_downslope_s: Int32Array; t_flux: Float32Array; t_lake: Int16Array;
  s_river: Float32Array; s_riverId: Int16Array;
  r_water: Uint8Array;                                 // copy with lake cells set to 2
  riverSides: Int32Array[]; riverParent: Int32Array;   // per river, ordered source -> mouth
  lakeCells: Int32Array[]; lakeOutlet_t: Int32Array;
  revertedCells: Int32Array;                           // input r_water 2 -> output 0, ascending
}

/** Priority-flood lift per step: each flooded corner sits at least this far above its parent. */
const EPS = 1e-5;
/** A corner lifted by more than this is a flooded corner (lake-cell test). */
const LAKE_DEPTH = 0.005;
/** Smallest connected component of lake cells that becomes a lake. */
const LAKE_MIN_CELLS = 4;
/** Rivers shorter than this (in sides) are dropped unless another river drains into them. */
const RIVER_MIN_SIDES = 6;
/** s_riverId is Int16: raw river ids beyond this cannot be stored (never reached in practice). */
const MAX_RIVER_ID = 0x7fff;

export function computeHydrology(
  mesh: Mesh, params: WorldParams, r_elevation: Float32Array, r_water: Uint8Array, r_moisture: Float32Array,
): HydrologyResult {
  const nr = mesh.numRegions;
  const nt = mesh.numTriangles;
  const ns = mesh.numSides;
  const s_opposite_s = mesh.s_opposite_s;
  const scratch: number[] = [];

  // ---- 1. raw corner heights, ocean corners, rain
  const t_raw = new Float64Array(nt);
  const t_rain = new Float64Array(nt);
  const t_ocean = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    t_circulate_r(mesh, t, scratch);
    let sum = 0, rain = 0, ocean = 0;
    for (let i = 0; i < scratch.length; i++) {
      const r = scratch[i];
      sum += r_elevation[r];
      rain += r_moisture[r];
      if (r_water[r] === 1) ocean = 1;
    }
    t_raw[t] = sum / scratch.length;
    t_rain[t] = rain / scratch.length;
    t_ocean[t] = ocean;
  }

  // ---- 2. priority-flood + epsilon
  const fill = new Float64Array(nt);
  const visited = new Uint8Array(nt);
  const heap = new MinHeap(nt);
  for (let t = 0; t < nt; t++) {
    fill[t] = t_raw[t];   // unreachable corners (none on a connected mesh) keep their raw height
    if (t_ocean[t] === 1) {
      visited[t] = 1;
      heap.push(t_raw[t], t);
    }
  }
  while (heap.size > 0) {
    const t = heap.pop();
    const lifted = fill[t] + EPS;
    t_circulate_t(mesh, t, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const u = scratch[i];
      if (visited[u] === 1) continue;
      visited[u] = 1;
      const h = t_raw[u] > lifted ? t_raw[u] : lifted;
      fill[u] = h;
      heap.push(h, u);
    }
  }

  // ---- 3. lakes: candidate cells
  const r_cand = new Uint8Array(nr);
  for (let r = 0; r < nr; r++) {
    const w = r_water[r];
    if (w === 1) continue;
    if (w === 2) { r_cand[r] = 1; continue; }
    r_circulate_t(mesh, r, scratch);
    if (scratch.length < 3) continue;
    let all = 1;
    for (let i = 0; i < scratch.length; i++) {
      const t = scratch[i];
      if (t_ocean[t] === 1 || fill[t] - t_raw[t] <= LAKE_DEPTH) { all = 0; break; }
    }
    r_cand[r] = all;
  }

  // Connected components of candidates (BFS in cell-index order; compMin is the first cell found).
  const r_comp = new Int32Array(nr).fill(-1);
  const queue = new Int32Array(nr);
  const compSize: number[] = [];
  const compMin: number[] = [];
  for (let r0 = 0; r0 < nr; r0++) {
    if (r_cand[r0] === 0 || r_comp[r0] >= 0) continue;
    const c = compSize.length;
    let head = 0, tail = 0;
    r_comp[r0] = c;
    queue[tail++] = r0;
    while (head < tail) {
      const r = queue[head++];
      r_circulate_r(mesh, r, scratch);
      for (let i = 0; i < scratch.length; i++) {
        const q = scratch[i];
        if (r_cand[q] === 1 && r_comp[q] < 0) {
          r_comp[q] = c;
          queue[tail++] = q;
        }
      }
    }
    compSize.push(tail);
    compMin.push(r0);
  }
  const numComp = compSize.length;
  let numBig = 0;
  for (let c = 0; c < numComp; c++) if (compSize[c] >= LAKE_MIN_CELLS) numBig++;
  const compOrder = new Int32Array(numBig);
  for (let c = 0, k = 0; c < numComp; c++) if (compSize[c] >= LAKE_MIN_CELLS) compOrder[k++] = c;
  compOrder.sort((a, b) => compSize[b] - compSize[a] || compMin[a] - compMin[b]);
  const maxLakes = params.lakesMax > 0 ? Math.floor(params.lakesMax) : 0;
  const numLakes = numBig < maxLakes ? numBig : maxLakes;
  const compLake = new Int32Array(numComp).fill(-1);
  for (let L = 0; L < numLakes; L++) compLake[compOrder[L]] = L;

  // r_water copy, lake cell lists, t_lake, reverted candidates.
  const r_waterOut = new Uint8Array(nr);
  const lakeCells: Int32Array[] = [];
  const lakeCount = new Int32Array(numLakes);
  for (let L = 0; L < numLakes; L++) lakeCells.push(new Int32Array(compSize[compOrder[L]]));
  const t_lake = new Int16Array(nt).fill(-1);
  const reverted: number[] = [];
  for (let r = 0; r < nr; r++) {
    if (r_water[r] === 1) { r_waterOut[r] = 1; continue; }
    const c = r_comp[r];
    const L = c < 0 ? -1 : compLake[c];
    if (L < 0) {
      r_waterOut[r] = 0;
      if (r_water[r] === 2) reverted.push(r);
      continue;
    }
    r_waterOut[r] = 2;
    lakeCells[L][lakeCount[L]++] = r;
    r_circulate_t(mesh, r, scratch);
    for (let i = 0; i < scratch.length; i++) t_lake[scratch[i]] = L;
  }
  const revertedCells = Int32Array.from(reverted);

  // Outlets: lowest (fill, index) corner adjacent to a corner of L that is not a corner of L.
  const lakeOutlet_t = new Int32Array(numLakes).fill(-1);
  const outletH = new Float64Array(numLakes).fill(Infinity);
  for (let t = 0; t < nt; t++) {
    const L = t_lake[t];
    if (L < 0) continue;
    t_circulate_t(mesh, t, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const c = scratch[i];
      if (t_lake[c] === L) continue;
      const h = fill[c];
      if (h < outletH[L] || (h === outletH[L] && c < lakeOutlet_t[L])) {
        outletH[L] = h;
        lakeOutlet_t[L] = c;
      }
    }
  }

  // ---- 4. downslope side
  const t_downslope_s = new Int32Array(nt).fill(-1);
  for (let t = 0; t < nt; t++) {
    if (t_ocean[t] === 1 || t_lake[t] >= 0) continue;
    let best = -1, bestT = -1, bestH = Infinity;
    for (let i = 0; i < 3; i++) {
      const s = 3 * t + i;
      const u = s_outer_t(mesh, s);
      if (u < 0) continue;
      const h = fill[u];
      if (h < bestH || (h === bestH && u < bestT)) {
        bestH = h;
        bestT = u;
        best = s;
      }
    }
    t_downslope_s[t] = best;
  }

  // ---- 5. flow accumulation
  const t_next = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    if (t_ocean[t] === 1) t_next[t] = -1;
    else if (t_lake[t] >= 0) t_next[t] = lakeOutlet_t[t_lake[t]];
    else t_next[t] = t_downslope_s[t] >= 0 ? s_outer_t(mesh, t_downslope_s[t]) : -1;
  }
  const order = new Int32Array(nt);
  for (let t = 0; t < nt; t++) order[t] = t;
  order.sort((a, b) => fill[b] - fill[a] || a - b);
  const flux = new Float64Array(nt);
  const done = new Uint8Array(nt);
  for (let k = 0; k < nt; k++) {
    const t = order[k];
    flux[t] += t_rain[t];
    done[t] = 1;
    const f = flux[t];
    let u = t_next[t];
    for (let guard = 0; u >= 0 && guard < nt; guard++) {
      flux[u] += f;
      if (done[u] === 0) break;   // the normal case: the target is lower and still unvisited
      u = t_next[u];              // defensive: forward past an already-visited target
    }
  }
  const t_flux = new Float32Array(flux);

  // ---- 6. rivers: threshold over land corners, sources
  let numLand = 0;
  for (let t = 0; t < nt; t++) if (t_ocean[t] === 0 && t_lake[t] < 0) numLand++;
  const landFlux = new Float32Array(numLand);
  for (let t = 0, k = 0; t < nt; t++) if (t_ocean[t] === 0 && t_lake[t] < 0) landFlux[k++] = t_flux[t];
  const threshold = numLand > 0 ? quantile(landFlux, params.riverPercentile) : Infinity;
  const above = new Uint8Array(nt);
  const hasUp = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    if (t_ocean[t] === 0 && t_lake[t] < 0 && t_flux[t] >= threshold) above[t] = 1;
  }
  let numSources = 0;
  for (let t = 0; t < nt; t++) if (above[t] === 1 && t_next[t] >= 0) hasUp[t_next[t]] = 1;
  for (let t = 0; t < nt; t++) if (above[t] === 1 && hasUp[t] === 0) numSources++;
  const sources = new Int32Array(numSources);
  for (let t = 0, k = 0; t < nt; t++) if (above[t] === 1 && hasUp[t] === 0) sources[k++] = t;
  sources.sort((a, b) => t_flux[b] - t_flux[a] || a - b);

  // Walks.
  const s_river = new Float32Array(ns);
  const s_riverId = new Int16Array(ns).fill(-1);
  const rawSides: Int32Array[] = [];
  const rawParent: number[] = [];
  const path: number[] = [];
  for (let k = 0; k < numSources; k++) {
    const id = rawSides.length;
    if (id > MAX_RIVER_ID) break;
    let t = sources[k];
    let parent = -1;
    path.length = 0;
    for (let steps = 0; steps <= nt; steps++) {
      if (t_ocean[t] === 1 || t_lake[t] >= 0) break;   // mouth at ocean / lake
      const s = t_downslope_s[t];
      if (s < 0) break;
      const owner = s_riverId[s];
      if (owner >= 0) { parent = owner; break; }        // joins an existing river at corner t
      const f = t_flux[t];
      s_river[s] = f;
      s_riverId[s] = id;
      const o = s_opposite_s[s];
      if (o >= 0) {
        s_river[o] = f;
        s_riverId[o] = id;
      }
      path.push(s);
      t = s_outer_t(mesh, s);
    }
    rawSides.push(Int32Array.from(path));
    rawParent.push(parent);
  }

  // Drop short rivers that nothing drains into, to a fixpoint.
  const numRaw = rawSides.length;
  const alive = new Uint8Array(numRaw).fill(1);
  const children = new Int32Array(numRaw);
  for (let i = 0; i < numRaw; i++) if (rawParent[i] >= 0) children[rawParent[i]]++;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < numRaw; i++) {
      if (alive[i] === 0 || rawSides[i].length >= RIVER_MIN_SIDES || children[i] !== 0) continue;
      alive[i] = 0;
      changed = true;
      const p = rawParent[i];
      if (p >= 0) children[p]--;
      const sides = rawSides[i];
      for (let j = 0; j < sides.length; j++) {
        const s = sides[j];
        s_river[s] = 0;
        s_riverId[s] = -1;
        const o = s_opposite_s[s];
        if (o >= 0) {
          s_river[o] = 0;
          s_riverId[o] = -1;
        }
      }
    }
  }

  // Compact ids.
  const newId = new Int32Array(numRaw).fill(-1);
  let numRivers = 0;
  for (let i = 0; i < numRaw; i++) if (alive[i] === 1) newId[i] = numRivers++;
  const riverSides: Int32Array[] = [];
  const riverParent = new Int32Array(numRivers);
  for (let i = 0; i < numRaw; i++) {
    if (alive[i] === 0) continue;
    riverSides.push(rawSides[i]);
    const p = rawParent[i];
    riverParent[newId[i]] = p >= 0 ? newId[p] : -1;
  }
  for (let s = 0; s < ns; s++) if (s_riverId[s] >= 0) s_riverId[s] = newId[s_riverId[s]];

  return {
    t_elevation: new Float32Array(fill),
    t_downslope_s,
    t_flux,
    t_lake,
    s_river,
    s_riverId,
    r_water: r_waterOut,
    riverSides,
    riverParent,
    lakeCells,
    lakeOutlet_t,
    revertedCells,
  };
}
