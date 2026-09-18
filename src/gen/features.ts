/**
 * gen/features.ts — Stage 13 (Features) and stage 14 (Political view).
 *
 * RNG stream: none. Both stages are deterministic functions of the mesh, the precomputed noisy
 * edges and the per-index arrays they are handed; every tie is broken on the smaller index
 * (cell, side or component), so the output depends only on the inputs. No draw ever happens here.
 *
 * Inputs:  extractFeatures — Mesh, NoisyEdges, Geography (r_water with hydrology's confirmed lakes,
 *          r_elevation, r_coastDist, s_river, distField) and the HydrologyResult (riverSides,
 *          riverParent, lakeCells, lakeOutlet_t). buildPoliticalView — World.mesh, World.edges and
 *          World.politics (r_nation, nations.length). Inputs are never mutated; River.sides shares
 *          hydro.riverSides[i] and Lake.cells shares hydro.lakeCells[i] (both immutable after stage 7).
 * Outputs: Features (coast, waterlines, rivers, riverPaths, lakes, seas, ranges) and PoliticalView
 *          (borders, borderNation, nationLabel_r, nationArea, nationAxis). Names are '' until
 *          assignNames (stage 12) fills them.
 *
 * Lake outflows: hydrology's lakeOutlet_t[L] is a t_circulate_t neighbour of a lake corner, one side
 * outside the shore, so a river rising at that outlet would be drawn starting a cell away from the
 * lake. For a river whose source_t is some lake's outlet corner (smallest such L), the spill side —
 * the side s with t_lake[s_inner_t(s)] === L and s_outer_t(mesh, s) === source_t, found by scanning
 * the three sides of every corner of lakeCells[L] (smallest s if several) — is prepended to the
 * PATH ONLY: riverPaths[i] then starts at a corner of the lake, one side upstream of
 * rivers[i].sides[0], while River.sides, source_t, mouth_t and hydrology are untouched. River.length
 * is the length of the drawn path, spill side included. No spill side found -> path unchanged.
 *
 * Every polyline built from sides is assembled from the noisy side paths by chainSides (mesh/noisy.ts)
 * and then Chaikin-smoothed once (core/geom.ts). Cell positions, wherever one is needed (PCA axes,
 * areas), are the average of the cellPolygon corners; mesh.r_x / r_y are never read.
 *
 * Coast orientation (MEASURED by features.test.ts on the default and small worlds, 2026-09-16):
 * walking a side from its inner corner s_inner_t(s) to its outer corner s_outer_t(s) puts the side's
 * START region on the walker's RIGHT and its END region on the walker's LEFT in y-down screen
 * coordinates. The first attempt chained land->ocean sides (start = land) and sampled distField
 * 1.5 px to the left of every coast segment (the left normal of direction (dx, dy) in y-down space
 * is (dy, -dx), checked against a hand-drawn square traversed clockwise on screen): land was on the
 * left for only 11% (default) / 17% (small) of segments, so Delaunator's winding, fed y-down canvas
 * points, is the opposite of the naive expectation and the twin sides are the right ones. Coast
 * sides are therefore the half-edges whose START region is OCEAN (r_water === 1) and whose END
 * region is LAND (r_water === 0); that gives "land on the left" (Features.coast contract, the same
 * rule as raster.ts marchingSquares). With the right sides the left sample is positive on 90% of
 * segments at 1.5 px (default world; the noisy paths sit up to 0.25 * cellSpacing off the straight
 * Voronoi edge and the mask raster is 2 logical px per px, so the absolute sign is blurred that
 * close in) and on 96% at 3.5 px; the blur-proof assertion the test makes is that the field 1.5 px
 * to the left exceeds the field 1.5 px to the right (the distance gradient points inland) on
 * >= 97% of segments. Consequences of the same winding: lake shores, chained (as specified) from sides whose
 * start cell is in the lake and whose end cell is not, have LAND on the left and the lake on the
 * right — a walker along any shore, coast or lake, keeps the water on the right; nation borders
 * are chained from sides whose END cell is owned by n and whose start cell is not, so nation n is
 * on the left, which is what PoliticalView.borderNation promises.
 *
 * Loop bookkeeping: chainSides emits (pathLen - 1) points per side of a closed loop (the joint
 * point is shared, the closing point dropped) and (pathLen - 1) * k + 1 for an open chain of k
 * sides, so a chain's side count is recovered from its point count and the edges' path length;
 * coast loops shorter than MIN_LOOP_SIDES sides are dropped (already tinted, not worth inking).
 * Every coast / shore / border corner has exactly one outgoing chain side (a corner's three cells
 * are mutually adjacent, and no lake cell touches an ocean cell), so every chain is a closed loop;
 * an open chain would be an upstream inconsistency and is passed through unchanged.
 *
 * Seas: connected components (r_circulate_r) of interior ocean cells, ranked by (size desc, first
 * cell asc); the MAX_SEAS largest become NamedAreas with label_r = poleOfInaccessibility (the
 * cell farthest, in hops, from both the coast and the boundary ring, so the label lands inside the
 * frame; the cell with the minimum r_coastDist sits at the frame edge) and the PCA axis of the
 * cell positions. Ranges: components of interior cells with r_elevation > RANGE_ELEVATION, at least
 * RANGE_MIN_CELLS cells, ranked the same way, label_r = poleOfInaccessibility. NamedArea ids are
 * the rank within seas / within ranges; cell lists are ascending.
 *
 * poleOfInaccessibility: multi-source BFS over the set from its rim (cells with a neighbor outside
 * the set, or boundary regions) inward; the result is the smallest cell index in the deepest BFS
 * layer. A set without a rim (never on this mesh) yields its smallest index; an empty set -1.
 */

import type {
  Features, Lake, Mesh, NamedArea, NoisyEdges, PoliticalView, Polyline, River, World,
} from '../core/types';
import { WATERLINE_ISOS } from '../core/types';
import type { HydrologyResult } from './hydrology';
import { chaikin, polylineLength, principalAxis } from '../core/geom';
import { marchingSquares } from '../core/raster';
import { cellPolygon, r_circulate_r, r_circulate_t, r_is_boundary, s_end_r, s_inner_t, s_outer_t } from '../mesh/dualmesh';
import { chainSides, sidePath } from '../mesh/noisy';

/** Coast loops with fewer sides than this are dropped. */
const MIN_LOOP_SIDES = 4;
/** Cells above this elevation form mountain ranges. */
const RANGE_ELEVATION = 0.62;
/** Smallest component that becomes a named range. */
const RANGE_MIN_CELLS = 12;
/** Number of named seas (largest interior ocean components). */
const MAX_SEAS = 2;

// ---------------------------------------------------------------- cell geometry

interface CellGeometry { r_px: Float32Array; r_py: Float32Array; r_area: Float32Array; }

/** Cell positions (average of the cellPolygon corners) and shoelace areas, one cellPolygon pass. */
function cellGeometry(mesh: Mesh): CellGeometry {
  const n = mesh.numRegions;
  const r_px = new Float32Array(n);
  const r_py = new Float32Array(n);
  const r_area = new Float32Array(n);
  const poly = new Float32Array(64);
  for (let r = 0; r < n; r++) {
    const k = cellPolygon(mesh, r, poly);
    if (k === 0) continue;
    let sx = 0, sy = 0, a = 0;
    for (let i = 0; i < k; i++) {
      const x = poly[2 * i], y = poly[2 * i + 1];
      const j = i + 1 === k ? 0 : i + 1;
      sx += x;
      sy += y;
      a += x * poly[2 * j + 1] - poly[2 * j] * y;
    }
    r_px[r] = sx / k;
    r_py[r] = sy / k;
    r_area[r] = Math.abs(a) * 0.5;
  }
  return { r_px, r_py, r_area };
}

// ---------------------------------------------------------------- polyline helpers

function smooth(p: Polyline): Polyline {
  return { pts: chaikin(p.pts, p.closed, 1), closed: p.closed };
}

/** Points that one side contributes to a chain (its path minus the shared joint). */
function pointsPerSide(edges: NoisyEdges): number {
  let best = 1;
  const len = edges.s_pathLen;
  for (let s = 0; s < len.length; s++) if (len[s] - 1 > best) best = len[s] - 1;
  return best;
}

/** Number of mesh sides in a raw chainSides polyline (see the file comment). */
function chainSideCount(p: Polyline, perSide: number): number {
  const n = p.pts.length >> 1;
  return p.closed ? n / perSide : (n - 1) / perSide;
}

// ---------------------------------------------------------------- connected components

interface Components { r_comp: Int32Array; size: number[]; first: number[]; }

/** BFS components of the cells with r_in[r] === 1, discovered in ascending cell order. */
function connectedComponents(mesh: Mesh, r_in: Uint8Array): Components {
  const n = mesh.numRegions;
  const r_comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const size: number[] = [];
  const first: number[] = [];
  const nbrs: number[] = [];
  for (let r0 = 0; r0 < n; r0++) {
    if (r_in[r0] === 0 || r_comp[r0] >= 0) continue;
    const c = size.length;
    let head = 0, tail = 0;
    r_comp[r0] = c;
    queue[tail++] = r0;
    while (head < tail) {
      const r = queue[head++];
      r_circulate_r(mesh, r, nbrs);
      for (let i = 0; i < nbrs.length; i++) {
        const q = nbrs[i];
        if (r_in[q] === 1 && r_comp[q] < 0) {
          r_comp[q] = c;
          queue[tail++] = q;
        }
      }
    }
    size.push(tail);
    first.push(r0);
  }
  return { r_comp, size, first };
}

/**
 * Components with at least minCells cells, ranked by (size desc, first cell asc), the first
 * maxCount of them; returns their cell lists (ascending) in rank order.
 */
function rankedComponentCells(comps: Components, minCells: number, maxCount: number): Int32Array[] {
  const { r_comp, size, first } = comps;
  const numComp = size.length;
  let numBig = 0;
  for (let c = 0; c < numComp; c++) if (size[c] >= minCells) numBig++;
  const order = new Int32Array(numBig);
  for (let c = 0, k = 0; c < numComp; c++) if (size[c] >= minCells) order[k++] = c;
  order.sort((a, b) => size[b] - size[a] || first[a] - first[b]);
  const count = numBig < maxCount ? numBig : maxCount;
  const rank = new Int32Array(numComp).fill(-1);
  const cells: Int32Array[] = [];
  const fill = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    rank[order[i]] = i;
    cells.push(new Int32Array(size[order[i]]));
  }
  for (let r = 0; r < r_comp.length; r++) {
    const c = r_comp[r];
    if (c < 0) continue;
    const i = rank[c];
    if (i < 0) continue;
    cells[i][fill[i]++] = r;
  }
  return cells;
}

// ---------------------------------------------------------------- pole of inaccessibility

/**
 * Cell of the set farthest (in BFS hops) from the set's rim: multi-source BFS from every set cell
 * that has a neighbor outside the set or is a boundary region; returns the smallest index in the
 * deepest layer. No rim -> smallest cell index; empty set -> -1.
 */
export function poleOfInaccessibility(mesh: Mesh, cells: Int32Array): number {
  const n = cells.length;
  if (n === 0) return -1;
  const sorted = cells.slice().sort();   // typed-array sort is numeric
  const inSet = new Uint8Array(mesh.numRegions);
  for (let i = 0; i < n; i++) inSet[sorted[i]] = 1;
  const dist = new Int32Array(mesh.numRegions).fill(-1);
  const queue = new Int32Array(n);
  const nbrs: number[] = [];
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    const r = sorted[i];
    if (i > 0 && r === sorted[i - 1]) continue;
    let rim = r_is_boundary(mesh, r);
    if (!rim) {
      r_circulate_r(mesh, r, nbrs);
      for (let k = 0; k < nbrs.length; k++) {
        if (inSet[nbrs[k]] === 0) { rim = true; break; }
      }
    }
    if (rim) {
      dist[r] = 0;
      queue[tail++] = r;
    }
  }
  if (tail === 0) return sorted[0];
  let best = -1, bestD = -1;
  while (head < tail) {
    const r = queue[head++];
    const d = dist[r];
    if (d > bestD || (d === bestD && r < best)) {
      bestD = d;
      best = r;
    }
    r_circulate_r(mesh, r, nbrs);
    for (let k = 0; k < nbrs.length; k++) {
      const q = nbrs[k];
      if (inSet[q] === 1 && dist[q] < 0) {
        dist[q] = d + 1;
        queue[tail++] = q;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- lake spill side

/**
 * The side leaving a corner of lake L (t_lake[s_inner_t(s)] === L) whose outer corner is
 * outlet_t, scanning the three sides of every corner of the lake's cells; the smallest such side,
 * or -1 when the outlet is not adjacent to any corner of L (never, per hydrology's outlet rule).
 */
function lakeSpillSide(mesh: Mesh, t_lake: Int16Array, cells: Int32Array, L: number, outlet_t: number): number {
  const corners: number[] = [];
  let best = -1;
  for (let i = 0; i < cells.length; i++) {
    r_circulate_t(mesh, cells[i], corners);
    for (let k = 0; k < corners.length; k++) {
      const t = corners[k];
      if (t_lake[t] !== L) continue;
      for (let j = 0; j < 3; j++) {
        const s = 3 * t + j;
        if (s_outer_t(mesh, s) === outlet_t && (best < 0 || s < best)) best = s;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- stage 13

export function extractFeatures(
  world: Pick<World, 'mesh' | 'edges' | 'geo' | 'params'>, hydro: HydrologyResult,
): Features {
  const { mesh, edges, geo } = world;
  const { r_water, r_elevation, s_river, distField } = geo;
  const { s_start_r, numRegions, numSides, numBoundaryRegions: nb } = mesh;
  const { r_px, r_py } = cellGeometry(mesh);
  const perSide = pointsPerSide(edges);

  // ---- coast: ocean -> land sides, so the END (land) region is on the left (see the file comment)
  const rawCoast = chainSides(
    mesh, edges, (s) => r_water[s_start_r[s]] === 1 && r_water[s_end_r(mesh, s)] === 0,
  );
  const coast: Polyline[] = [];
  for (let i = 0; i < rawCoast.length; i++) {
    const loop = rawCoast[i];
    if (chainSideCount(loop, perSide) < MIN_LOOP_SIDES) continue;
    coast.push(smooth(loop));
  }

  // ---- lake shores: per lake, sides with the start cell in the lake and the end cell outside it
  const numLakes = hydro.lakeCells.length;
  const r_lakeId = new Int32Array(numRegions).fill(-1);
  for (let L = 0; L < numLakes; L++) {
    const cells = hydro.lakeCells[L];
    for (let i = 0; i < cells.length; i++) r_lakeId[cells[i]] = L;
  }
  const s_shoreLake = new Int32Array(numSides).fill(-1);
  for (let s = 0; s < numSides; s++) {
    const a = r_lakeId[s_start_r[s]];
    if (a >= 0 && r_lakeId[s_end_r(mesh, s)] !== a) s_shoreLake[s] = a;
  }
  const lakes: Lake[] = [];
  for (let L = 0; L < numLakes; L++) {
    const loops = chainSides(mesh, edges, (s) => s_shoreLake[s] === L);
    // One shore per lake: the loop with the most points (an island inside a lake would add a
    // second, shorter loop; first index wins ties).
    let pick = -1, pickLen = -1;
    for (let i = 0; i < loops.length; i++) {
      if (loops[i].pts.length > pickLen) { pickLen = loops[i].pts.length; pick = i; }
    }
    const shore: Polyline = pick >= 0 ? smooth(loops[pick]) : { pts: new Float32Array(0), closed: true };
    lakes.push({ id: L, name: '', cells: hydro.lakeCells[L], shore, outlet_t: hydro.lakeOutlet_t[L] });
  }

  // ---- rivers: noisy side paths source -> mouth, joints emitted once, Chaikin x1; a river rising
  // at a lake outlet gets the lake's spill side prepended to its path (see the file comment)
  const t_outletLake = new Int32Array(mesh.numTriangles).fill(-1);
  for (let L = numLakes - 1; L >= 0; L--) {          // smallest L wins a shared outlet corner
    const t = hydro.lakeOutlet_t[L];
    if (t >= 0) t_outletLake[t] = L;
  }
  const rivers: River[] = [];
  const riverPaths: Polyline[] = [];
  const acc: number[] = [];
  const scratch: number[] = [];
  for (let i = 0; i < hydro.riverSides.length; i++) {
    const sides = hydro.riverSides[i];
    const source_t = sides.length > 0 ? s_inner_t(sides[0]) : -1;
    const L = source_t >= 0 ? t_outletLake[source_t] : -1;
    const spill = L >= 0 ? lakeSpillSide(mesh, hydro.t_lake, hydro.lakeCells[L], L, source_t) : -1;
    acc.length = 0;
    if (spill >= 0) {
      scratch.length = 0;
      sidePath(edges, mesh, spill, scratch);
      for (let k = 0; k < scratch.length; k++) acc.push(scratch[k]);
    }
    for (let j = 0; j < sides.length; j++) {
      scratch.length = 0;
      sidePath(edges, mesh, sides[j], scratch);
      for (let k = j === 0 && spill < 0 ? 0 : 2; k < scratch.length; k++) acc.push(scratch[k]);
    }
    const pts = chaikin(Float32Array.from(acc), false, 1);
    const last = sides.length > 0 ? sides[sides.length - 1] : -1;
    rivers.push({
      id: i,
      name: '',
      sides,
      source_t,
      mouth_t: last >= 0 ? s_outer_t(mesh, last) : -1,
      flux: last >= 0 ? s_river[last] : 0,
      length: polylineLength(pts, false),
      parent: hydro.riverParent[i],
    });
    riverPaths.push({ pts, closed: false });
  }

  // ---- waterlines: distField contours (already logical px), one array per iso
  const waterlines: Polyline[][] = [];
  for (let i = 0; i < WATERLINE_ISOS.length; i++) {
    const raw = marchingSquares(distField, WATERLINE_ISOS[i]);
    const out: Polyline[] = [];
    for (let j = 0; j < raw.length; j++) out.push(smooth(raw[j]));
    waterlines.push(out);
  }

  // ---- seas: the largest interior ocean components
  const r_ocean = new Uint8Array(numRegions);
  for (let r = nb; r < numRegions; r++) if (r_water[r] === 1) r_ocean[r] = 1;
  const seaCells = rankedComponentCells(connectedComponents(mesh, r_ocean), 1, MAX_SEAS);
  const seas: NamedArea[] = [];
  for (let i = 0; i < seaCells.length; i++) {
    const cells = seaCells[i];
    const axis = principalAxis(r_px, r_py, cells);
    seas.push({
      id: i, kind: 'sea', name: '', cells,
      label_r: poleOfInaccessibility(mesh, cells), axisAngle: axis.angle, extent: axis.extent,
    });
  }

  // ---- ranges: high-elevation components of at least RANGE_MIN_CELLS cells
  const r_high = new Uint8Array(numRegions);
  for (let r = nb; r < numRegions; r++) if (r_elevation[r] > RANGE_ELEVATION) r_high[r] = 1;
  const rangeCells = rankedComponentCells(connectedComponents(mesh, r_high), RANGE_MIN_CELLS, Infinity);
  const ranges: NamedArea[] = [];
  for (let i = 0; i < rangeCells.length; i++) {
    const cells = rangeCells[i];
    const axis = principalAxis(r_px, r_py, cells);
    ranges.push({
      id: i, kind: 'range', name: '', cells,
      label_r: poleOfInaccessibility(mesh, cells), axisAngle: axis.angle, extent: axis.extent,
    });
  }

  return { coast, waterlines, rivers, riverPaths, lakes, seas, ranges };
}

// ---------------------------------------------------------------- stage 14

export function buildPoliticalView(world: World): PoliticalView {
  const { mesh, edges, politics } = world;
  const { r_nation } = politics;
  const numNations = politics.nations.length;
  const { s_start_r, numRegions, numSides } = mesh;
  const { r_px, r_py, r_area } = cellGeometry(mesh);

  // A side is a border of nation n when its END cell is owned by n and its start cell is not
  // (another nation, unclaimed land or water): the end region is on the walker's left (see the
  // file comment), which is what borderNation promises.
  const s_border = new Int32Array(numSides).fill(-1);
  const hasBorder = new Uint8Array(numNations);
  for (let s = 0; s < numSides; s++) {
    const b = r_nation[s_end_r(mesh, s)];
    if (b < 0 || b >= numNations) continue;
    if (r_nation[s_start_r[s]] !== b) {
      s_border[s] = b;
      hasBorder[b] = 1;
    }
  }
  const borders: Polyline[] = [];
  const borderNationList: number[] = [];
  for (let n = 0; n < numNations; n++) {
    if (hasBorder[n] === 0) continue;
    const loops = chainSides(mesh, edges, (s) => s_border[s] === n);
    for (let i = 0; i < loops.length; i++) {
      borders.push(smooth(loops[i]));
      borderNationList.push(n);
    }
  }

  // Per-nation cell lists (ascending).
  const count = new Int32Array(numNations);
  for (let r = 0; r < numRegions; r++) {
    const n = r_nation[r];
    if (n >= 0 && n < numNations) count[n]++;
  }
  const cellsOf: Int32Array[] = [];
  for (let n = 0; n < numNations; n++) cellsOf.push(new Int32Array(count[n]));
  const fill = new Int32Array(numNations);
  for (let r = 0; r < numRegions; r++) {
    const n = r_nation[r];
    if (n >= 0 && n < numNations) cellsOf[n][fill[n]++] = r;
  }

  const nationLabel_r = new Int32Array(numNations).fill(-1);
  const nationArea = new Float32Array(numNations);
  const nationAxis = new Float32Array(numNations);
  for (let n = 0; n < numNations; n++) {
    const cells = cellsOf[n];
    if (cells.length === 0) continue;
    nationLabel_r[n] = poleOfInaccessibility(mesh, cells);
    let area = 0;
    for (let k = 0; k < cells.length; k++) area += r_area[cells[k]];
    nationArea[n] = area;
    nationAxis[n] = principalAxis(r_px, r_py, cells).angle;
  }

  return {
    borders,
    borderNation: Int16Array.from(borderNationList),
    nationLabel_r,
    nationArea,
    nationAxis,
  };
}
