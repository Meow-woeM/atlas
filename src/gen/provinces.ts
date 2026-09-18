/**
 * gen/provinces.ts — Stage 9 (Provinces).
 *
 * RNG stream: `provinces` (the caller passes fork(seed, 'provinces')). Consumption order, frozen
 * (changing it is a params.version bump): exactly ONE rng.shuffle over the plain number[] of land
 * cell indices (ascending before the shuffle), i.e. numLandCells - 1 draws of rng.next(); nothing
 * else in this stage draws. The shuffled order is the candidate order of the site sampler below.
 *
 * Inputs:  Mesh, NoisyEdges (border lengths), WorldParams (provinceSpacing, cellSpacing) and the
 *          finished Geography: r_water (0 land / 1 ocean / 2 lake), r_elevation, r_slope,
 *          r_biome, s_river. Inputs are never mutated.
 * Outputs: { provinces, r_province, graph } exactly as ARCHITECTURE.md section 7.1 declares them:
 *          r_province = -1 on every water cell, a province index on every land cell; provinces[p]
 *          is a Province POJO (cells ascending, centroid_r, area, coastal, fertility, seat -1,
 *          name ''); graph is the CSR ProvinceGraph with p_nbr ascending per province and
 *          p_border the shared border length in logical px (mirrored on both directions).
 *
 * Steps, as ARCHITECTURE.md section 5 "Stage 9" lists them, with the topology-only reading of it:
 *   0. Cell positions (xs / ys) = the average of the cellPolygon corners, and cell areas by the
 *      shoelace formula over the same polygon, precomputed once for every cell. This file never
 *      reads mesh.r_x / r_y.
 *   1. Per-cell fertility r_fert = cellFertility(geo, r) x RIVER_BONUS (1.3) when an outgoing
 *      side of r carries s_river > 0, clamped to 1 so province fertility stays in 0..1. The
 *      exported cellFertility cannot see the mesh, so the river bonus lives here (deviation
 *      recorded in the task result). Land elevation is floored at 0 for the cost function:
 *      hydrology's reverted lake candidates still carry a negative r_elevation at this point.
 *   2. Sites: Poisson-disc over the LAND-CELL GRAPH measured in BFS hops (no coordinates). Land
 *      cells are visited in the shuffled order; a cell is accepted as a site when no earlier site
 *      has claimed it. Each accepted site runs a bounded BFS over land cells and claims every cell
 *      within claimHops of ITSELF, so a fertile site blocks a small neighbourhood and a desert or
 *      mountain site a large one. The spec's px radius R = provinceSpacing / sqrt(r_fert + 0.25)
 *      is mapped to hops with HOP_PX: on a Bridson Poisson-disc mesh one BFS hop spans a stable
 *      ~1.3 x cellSpacing px (measured 1.29-1.39 at depths 1-8 over four seeds), and claiming
 *      depth d excludes later sites through hop d, i.e. enforces a minimum separation of d + 1
 *      hops. claimHops = max(1, round(R / (HOP_PX x cellSpacing)) - 1) therefore reproduces
 *      Bridson's "no two sites closer than R px" in topology: ~3 hops for fertile lowland at the
 *      defaults, ~7-8 for desert and high mountain. Measured at DEFAULT_PARAMS: 92-108 provinces
 *      of ~32 cells over four seeds (the literal R / cellSpacing reading gives 46-55).
 *   3. Islands: connected components of land cells over r_circulate_r (discovered from the lowest
 *      unvisited land cell upward) that received no site get one at their most fertile cell
 *      (r_fert, ties to the smaller index). Site order = province id: sampled sites first, in
 *      acceptance order, then island sites in component order.
 *   4. Growth: multi-source Dijkstra on core/heap.ts's MinHeap (key = cost, id = cell; the heap
 *      tie-breaks on the smaller id) from every site over land cells. The link u -> v along side s
 *      costs 1 + 4 |elev[u] - elev[v]| + 5 (s_river[s] > 0) + 0.5 (r_biome[u] !== r_biome[v])
 *      + 2 (elev[v] > 0.6). A cell takes the province of the first strictly shorter relaxation;
 *      neighbours are relaxed in r_circulate_s order, so equal costs resolve deterministically.
 *      Every land component holds a site (step 3), so every land cell gets a province.
 *   5. Graph: one pass over the canonical sides (s < s_opposite_s[s]; hull sides join two ring
 *      cells and are never borders) collects (min province, max province, polylineLength of the
 *      noisy sidePath) for every side between two different provinces; the triples are index-
 *      sorted by pair key (index tie-break) and merged into one length per unordered pair, then
 *      scattered into CSR arrays. Filling in (min, max) order yields ascending p_nbr per province
 *      without a second sort: for province p the pairs where p is the max (smaller neighbours,
 *      ascending) all precede the pairs where p is the min (larger neighbours, ascending).
 *   6. Provinces: cells ascending; centroid_r = the province cell nearest the mean of its cell
 *      positions (strict < on squared distance over ascending cells, so ties go to the smaller
 *      index); area = sum of cell shoelace areas; coastal = some cell has an ocean neighbour;
 *      fertility = mean r_fert; name '' and seat -1 (settlements and names fill them later).
 */

import type { Rng } from '../core/rng';
import type { Geography, Mesh, NoisyEdges, Province, ProvinceGraph, WorldParams } from '../core/types';
import { BIOMES } from '../core/types';
import { MinHeap } from '../core/heap';
import { polylineLength } from '../core/geom';
import { cellPolygon, r_circulate_r, r_circulate_s, s_end_r } from '../mesh/dualmesh';
import { sidePath } from '../mesh/noisy';
import { BIOME_FERTILITY } from './climate';

/** Fertility multiplier for a cell with a river on one of its sides. */
const RIVER_BONUS = 1.3;
/** Softening constant under the square root of the site-radius formula. */
const RADIUS_SOFTENING = 0.25;
/** Mean Euclidean span of one BFS hop over the cell graph, in units of params.cellSpacing
 *  (measured on Bridson Poisson-disc meshes; see the doc comment, step 2). */
const HOP_PX = 1.3;
/** Growth cost terms (ARCHITECTURE.md stage 9). */
const COST_BASE = 1;
const COST_ELEVATION = 4;
const COST_RIVER = 5;
const COST_BIOME = 0.5;
const COST_HIGHLAND = 2;
const HIGHLAND_ELEVATION = 0.6;

/** Biome fertility x (1 - clamp(slope, 0, 1)); 0 for water cells. The river bonus is applied by
 *  computeProvinces (it needs the mesh). */
export function cellFertility(geo: Geography, r: number): number {
  if (geo.r_water[r] !== 0) return 0;
  const base = BIOME_FERTILITY[BIOMES[geo.r_biome[r]]];
  let slope = geo.r_slope[r];
  if (slope < 0) slope = 0;
  else if (slope > 1) slope = 1;
  return base * (1 - slope);
}

export function computeProvinces(
  mesh: Mesh, edges: NoisyEdges, params: WorldParams, geo: Geography, rng: Rng,
): { provinces: Province[]; r_province: Int16Array; graph: ProvinceGraph } {
  const nr = mesh.numRegions;
  const ns = mesh.numSides;
  const { r_water, r_elevation, r_biome, s_river } = geo;
  const s_opposite_s = mesh.s_opposite_s;
  const scratch: number[] = [];

  // ---- 0. cell positions and areas from cellPolygon (the sanctioned coordinate helper)
  const xs = new Float32Array(nr);
  const ys = new Float32Array(nr);
  const r_area = new Float64Array(nr);
  const poly = new Float32Array(64);
  for (let r = 0; r < nr; r++) {
    const k = cellPolygon(mesh, r, poly);
    if (k === 0) continue;
    let sx = 0, sy = 0, twice = 0;
    for (let i = 0; i < k; i++) {
      const j = i + 1 === k ? 0 : i + 1;
      const x = poly[2 * i], y = poly[2 * i + 1];
      sx += x;
      sy += y;
      twice += x * poly[2 * j + 1] - poly[2 * j] * y;
    }
    xs[r] = sx / k;
    ys[r] = sy / k;
    r_area[r] = twice < 0 ? -0.5 * twice : 0.5 * twice;
  }

  // ---- 1. land cells, fertility with the river bonus, floored elevation, coastal flag
  const land: number[] = [];
  const r_fert = new Float32Array(nr);
  const elev = new Float32Array(nr);
  const r_coastal = new Uint8Array(nr);
  for (let r = 0; r < nr; r++) {
    if (r_water[r] !== 0) continue;
    land.push(r);
    let f = cellFertility(geo, r);
    let river = false;
    r_circulate_s(mesh, r, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = scratch[i];
      if (s_river[s] > 0) river = true;
      if (r_water[s_end_r(mesh, s)] === 1) r_coastal[r] = 1;
    }
    if (river) f *= RIVER_BONUS;
    if (f > 1) f = 1;
    r_fert[r] = f;
    const e = r_elevation[r];
    elev[r] = e < 0 ? 0 : e;
  }

  // The single RNG use of this stage.
  rng.shuffle(land);

  // ---- 2. sites: hop-based Poisson-disc over the land graph
  const claimed = new Uint8Array(nr);
  const queue = new Int32Array(nr);
  const depth = new Int32Array(nr);
  const stamp = new Int32Array(nr);          // 0 = unvisited, else 1 + index of the visiting BFS
  const sites: number[] = [];
  const spacing = params.provinceSpacing;
  const cellSpacing = params.cellSpacing;
  for (let i = 0; i < land.length; i++) {
    const site = land[i];
    if (claimed[site]) continue;
    const mark = sites.length + 1;
    sites.push(site);
    const radiusPx = spacing / Math.sqrt(r_fert[site] + RADIUS_SOFTENING);
    let radius = Math.round(radiusPx / (HOP_PX * cellSpacing)) - 1;
    if (radius < 1) radius = 1;
    let head = 0, tail = 0;
    queue[tail++] = site;
    stamp[site] = mark;
    depth[site] = 0;
    claimed[site] = 1;
    while (head < tail) {
      const u = queue[head++];
      const d = depth[u];
      if (d >= radius) continue;
      r_circulate_r(mesh, u, scratch);
      for (let k = 0; k < scratch.length; k++) {
        const v = scratch[k];
        if (r_water[v] !== 0 || stamp[v] === mark) continue;
        stamp[v] = mark;
        depth[v] = d + 1;
        claimed[v] = 1;
        queue[tail++] = v;
      }
    }
  }

  // ---- 3. islands without a site get one at their most fertile cell
  const isSite = new Uint8Array(nr);
  for (let i = 0; i < sites.length; i++) isSite[sites[i]] = 1;
  const comp = new Int32Array(nr).fill(-1);
  let numComponents = 0;
  for (let r = 0; r < nr; r++) {
    if (r_water[r] !== 0 || comp[r] >= 0) continue;
    const c = numComponents++;
    let head = 0, tail = 0;
    queue[tail++] = r;
    comp[r] = c;
    let hasSite = false;
    let bestR = r;
    let bestF = r_fert[r];
    while (head < tail) {
      const u = queue[head++];
      if (isSite[u]) hasSite = true;
      const f = r_fert[u];
      if (f > bestF || (f === bestF && u < bestR)) { bestF = f; bestR = u; }
      r_circulate_r(mesh, u, scratch);
      for (let k = 0; k < scratch.length; k++) {
        const v = scratch[k];
        if (r_water[v] !== 0 || comp[v] >= 0) continue;
        comp[v] = c;
        queue[tail++] = v;
      }
    }
    if (!hasSite) {
      sites.push(bestR);
      isSite[bestR] = 1;
    }
  }

  // ---- 4. growth: multi-source Dijkstra over the land graph
  const numP = sites.length;
  const r_province = new Int16Array(nr).fill(-1);
  const dist = new Float64Array(nr).fill(Infinity);
  const done = new Uint8Array(nr);
  const heap = new MinHeap(land.length * 2 + 16);
  for (let p = 0; p < numP; p++) {
    const s = sites[p];
    dist[s] = 0;
    r_province[s] = p;
    heap.push(0, s);
  }
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const pu = r_province[u];
    const eu = elev[u];
    const bu = r_biome[u];
    const du = dist[u];
    r_circulate_s(mesh, u, scratch);
    for (let k = 0; k < scratch.length; k++) {
      const s = scratch[k];
      const v = s_end_r(mesh, s);
      if (r_water[v] !== 0 || done[v]) continue;
      const ev = elev[v];
      const de = ev > eu ? ev - eu : eu - ev;
      let c = COST_BASE + COST_ELEVATION * de;
      if (s_river[s] > 0) c += COST_RIVER;
      if (r_biome[v] !== bu) c += COST_BIOME;
      if (ev > HIGHLAND_ELEVATION) c += COST_HIGHLAND;
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        r_province[v] = pu;
        heap.push(nd, v);
      }
    }
  }

  // ---- 5. graph: border sides -> merged pair lengths -> CSR
  let numBorderSides = 0;
  for (let s = 0; s < ns; s++) {
    const o = s_opposite_s[s];
    if (o < 0 || s > o) continue;
    const a = r_province[mesh.s_start_r[s]];
    const b = r_province[s_end_r(mesh, s)];
    if (a >= 0 && b >= 0 && a !== b) numBorderSides++;
  }
  const sideKey = new Int32Array(numBorderSides);
  const sideLen = new Float64Array(numBorderSides);
  let pathBuf = new Float32Array(0);
  {
    let n = 0;
    for (let s = 0; s < ns; s++) {
      const o = s_opposite_s[s];
      if (o < 0 || s > o) continue;
      const a = r_province[mesh.s_start_r[s]];
      const b = r_province[s_end_r(mesh, s)];
      if (a < 0 || b < 0 || a === b) continue;
      scratch.length = 0;
      sidePath(edges, mesh, s, scratch);
      if (pathBuf.length !== scratch.length) pathBuf = new Float32Array(scratch.length);
      for (let i = 0; i < scratch.length; i++) pathBuf[i] = scratch[i];
      sideKey[n] = a < b ? a * numP + b : b * numP + a;
      sideLen[n] = polylineLength(pathBuf, false);
      n++;
    }
  }
  const order = new Int32Array(numBorderSides);
  for (let i = 0; i < numBorderSides; i++) order[i] = i;
  order.sort((i, j) => sideKey[i] - sideKey[j] || i - j);

  let numPairs = 0;
  for (let i = 0; i < numBorderSides; i++) {
    if (i === 0 || sideKey[order[i]] !== sideKey[order[i - 1]]) numPairs++;
  }
  const pairA = new Int32Array(numPairs);
  const pairB = new Int32Array(numPairs);
  const pairLen = new Float64Array(numPairs);
  const degree = new Int32Array(numP);
  {
    let k = -1;
    for (let i = 0; i < numBorderSides; i++) {
      const idx = order[i];
      const key = sideKey[idx];
      if (i === 0 || key !== sideKey[order[i - 1]]) {
        k++;
        pairA[k] = (key / numP) | 0;
        pairB[k] = key - pairA[k] * numP;
        degree[pairA[k]]++;
        degree[pairB[k]]++;
      }
      pairLen[k] += sideLen[idx];
    }
  }
  const p_first = new Int32Array(numP + 1);
  for (let p = 0; p < numP; p++) p_first[p + 1] = p_first[p] + degree[p];
  const p_nbr = new Int32Array(p_first[numP]);
  const p_border = new Float32Array(p_first[numP]);
  const cursor = p_first.slice(0, numP);
  for (let k = 0; k < numPairs; k++) {
    const a = pairA[k], b = pairB[k];
    const len = pairLen[k];
    p_nbr[cursor[a]] = b;
    p_border[cursor[a]++] = len;
    p_nbr[cursor[b]] = a;
    p_border[cursor[b]++] = len;
  }
  const graph: ProvinceGraph = { p_first, p_nbr, p_border };

  // ---- 6. province records
  const count = new Int32Array(numP);
  for (let i = 0; i < land.length; i++) count[r_province[land[i]]]++;
  const cellsOf: Int32Array[] = new Array(numP);
  const fill = new Int32Array(numP);
  for (let p = 0; p < numP; p++) cellsOf[p] = new Int32Array(count[p]);
  for (let r = 0; r < nr; r++) {
    const p = r_province[r];
    if (p < 0) continue;
    cellsOf[p][fill[p]++] = r;
  }
  const provinces: Province[] = new Array(numP);
  for (let p = 0; p < numP; p++) {
    const cells = cellsOf[p];
    const n = cells.length;
    let sx = 0, sy = 0, area = 0, fert = 0;
    let coastal = false;
    for (let i = 0; i < n; i++) {
      const r = cells[i];
      sx += xs[r];
      sy += ys[r];
      area += r_area[r];
      fert += r_fert[r];
      if (r_coastal[r]) coastal = true;
    }
    const cx = sx / n, cy = sy / n;
    let centroid_r = cells[0];
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const r = cells[i];
      const dx = xs[r] - cx, dy = ys[r] - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; centroid_r = r; }
    }
    provinces[p] = {
      id: p, name: '', cells, centroid_r, area, coastal, fertility: n > 0 ? fert / n : 0, seat: -1,
    };
  }

  return { provinces, r_province, graph };
}
