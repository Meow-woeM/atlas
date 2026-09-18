/**
 * gen/settlements.ts — Stage 10 (Settlements).
 *
 * RNG stream: `settlements` (the caller passes fork(seed, 'settlements')). Consumption order, frozen
 * (changing it is a params.version bump):
 *   1. one rng.next() per LAND cell (r_water === 0) in ascending cell index — the 0.2 * u placement
 *      noise, drawn once into a Float32Array before any placement happens;
 *   2. one rng.next() per placed settlement in placement order — the population factor
 *      0.7 + 0.6 * u.
 * Nothing else in this stage draws. scoreCell never draws.
 *
 * Inputs:  Mesh, WorldParams (settlementsMax), the finished Geography (r_water 0 land / 1 ocean /
 *          2 lake, r_elevation, r_slope, r_biome, r_coastDist, s_river, s_riverId), the provinces
 *          and r_province from stage 9. hydrology's reverted lake candidates may still carry a
 *          negative r_elevation here (world.ts lifts them later); every elevation term below is
 *          clamped at 0. Geography and r_province are never mutated.
 * Outputs: { settlements, r_settlement } exactly as ARCHITECTURE.md section 7.1 declares them:
 *          settlements[i].id === i in placement order (best score first), r_settlement = -1 on
 *          every cell except settlement cells, where it is the settlement index.
 *          INTENDED IN-PLACE FILL: provinces[p].seat is set to the province's best settlement
 *          (scoreCell desc, smaller settlement index on ties) and left -1 for provinces without
 *          one; every seat is reset to -1 first so a second call reproduces the same result.
 *
 * Steps, as ARCHITECTURE.md section 5 "Stage 10" lists them, with the topology-only reading:
 *   1. scoreCell(mesh, geo, r) is the deterministic part, reused by politics (capitals) and by the
 *      history sim (city founding). -Infinity for water cells; for a land cell
 *        2.0 BIOME_FERTILITY[biome] + 0.05 coast + 0.5 riverSide + 0.3 riverMouth + 0.05 harbor
 *        - 1.0 max(0, elevation) - 1.5 slope
 *      where coast = an outgoing side ends in an ocean cell (r_water === 1); riverSide = an
 *      outgoing side carries s_river > 0; riverMouth = a river side of the cell has an OCEAN
 *      CORNER at either end (a corner whose t_circulate_r contains an ocean cell): rivers only
 *      stop at ocean corners and never leave one, so such a side is the river's last side and the
 *      river ends on this cell. The spec names s_outer_t; the twin half-edge sees the same corner
 *      as its s_inner_t, and both cells flanking the mouth side are river mouths, so both corners
 *      are tested. harbor = the cell has 1..3 ocean neighbours and the mean r_coastDist of those
 *      ocean neighbours is > -12 px (a sheltered, shallow bay: the spec's "distField within 24 px
 *      offshore" probe read through the cell graph instead of the raster).
 *      Weights retuned 2026-09-17: the original 0.6 coast / 0.8 riverSide / 1.2 riverMouth /
 *      0.5 harbor with fertility x1 made every settlement a river-mouth port. The coast needs
 *      almost no bonus of its own: at the defaults coastal land averages fertility 0.74 and
 *      elevation 0.08 against 0.55 and 0.44 inland, so the elevation term alone favours the shore
 *      by ~0.36, and nearly every coastal cell passes the harbor test, so coast + harbor act as one
 *      weight (0.1). Measured over the seeds atlas / amberfell / test-1 / zzzzzzzz at
 *      DEFAULT_PARAMS: 36 settlements each, 39-56% ports, 42-50% river-side, 7 nations from
 *      foundNations on every seed, cities >= 10 land hops apart (settlements.test.ts asserts
 *      loose bounds around these).
 *   2. Working score = scoreCell + 0.2 rng.next() per land cell (Float32); water = -Infinity.
 *      Cells on a landmass (connected component of land cells over r_circulate_r) of fewer than
 *      MIN_LANDMASS_CELLS (20) cells are then set to -Infinity: an islet outside every mainland
 *      suppression BFS would otherwise always collect a settlement of its own, and politics turns
 *      each settled islet into a free-city nation (measured: 1-, 2- and 5-cell rocks pushed the
 *      nation count to 10-11). The RNG draw still happens for every land cell, islets included.
 *      n = min(max(round(landCells / 90), 15), params.settlementsMax) — settlementsMax is the
 *      hard cap even below 15; landCells counts every land cell, islets included.
 *   3. Greedy placement with suppression: pick the untaken land cell with the highest working
 *      score (strict >, so the smaller index wins ties) provided it is > 0; a BFS over land cells
 *      (r_circulate_r) from it to depth 9 subtracts 2.5 (1 - depth / 10) from every reached cell
 *      (2.5 at the cell itself, 0.25 at depth 9); repeat until n are placed or no untaken cell
 *      has a positive score (the stage then returns fewer than n). Suppression only lowers
 *      scores, so placement order is score-descending and is the settlement rank.
 *   4. Kind by rank over the m placed: the first max(1, round(0.2 m)) are cities, the next
 *      round(0.35 m) towns (clipped so cities + towns <= m), the rest villages.
 *      population = round(base * (0.7 + 0.6 rng.next())) with base city 20000 / town 4000 /
 *      village 600, one draw per settlement in placement order.
 *   5. Flags from the cell: port = an ocean neighbour; riverMouth as in step 1; river = s_riverId
 *      of the outgoing side with the largest s_river > 0 (smaller side index on ties) else -1;
 *      province = r_province[r]; culture -1 (politics fills it); founded 0; died -1; name ''.
 *   6. r_settlement and the province seats (see Outputs).
 */

import type { Rng } from '../core/rng';
import type { Geography, Mesh, Province, Settlement, SettlementKind, WorldParams } from '../core/types';
import { BIOMES } from '../core/types';
import { r_circulate_r, r_circulate_s, s_end_r, s_inner_t, s_outer_t, t_circulate_r } from '../mesh/dualmesh';
import { BIOME_FERTILITY } from './climate';

/** Score weights (ARCHITECTURE.md stage 10, retuned 2026-09-17; see the file comment, step 1). */
const FERTILITY_WEIGHT = 2.0;
const W_COAST = 0.05;
const W_RIVER_SIDE = 0.5;
const W_RIVER_MOUTH = 0.3;
const W_HARBOR = 0.05;
const W_ELEVATION = 1.0;
const W_SLOPE = 1.5;
/** A harbor cell has 1..HARBOR_MAX_OCEAN_NEIGHBORS ocean neighbours whose mean r_coastDist is
 *  above HARBOR_MIN_MEAN_DIST (signed px, negative offshore). */
const HARBOR_MAX_OCEAN_NEIGHBORS = 3;
const HARBOR_MIN_MEAN_DIST = -12;
/** Placement noise amplitude added to scoreCell. */
const NOISE = 0.2;
/** Settlement count: land cells per settlement, then clamped to [MIN_SETTLEMENTS, settlementsMax]. */
const CELLS_PER_SETTLEMENT = 90;
const MIN_SETTLEMENTS = 15;
/** Landmasses (land components) with fewer cells than this take no settlement (file comment, step 2). */
const MIN_LANDMASS_CELLS = 20;
/** Suppression: BFS depth over land and the falloff strength at depth 0. */
const SUPPRESS_DEPTH = 9;
const SUPPRESS_STRENGTH = 2.5;
/** Rank shares. */
const CITY_SHARE = 0.2;
const TOWN_SHARE = 0.35;
/** Population bases and the multiplicative jitter range 0.7..1.3. */
const BASE_POPULATION: Record<SettlementKind, number> = { city: 20000, town: 4000, village: 600 };
const POP_JITTER_MIN = 0.7;
const POP_JITTER_RANGE = 0.6;

// Module-level scratch for scoreCell (not re-entrant; scoreCell never calls itself).
const sideScratch: number[] = [];
const cornerScratch: number[] = [];

/** True when corner t (>= 0) has an ocean cell among its three cells. */
function cornerTouchesOcean(mesh: Mesh, r_water: Uint8Array, t: number): boolean {
  if (t < 0) return false;
  t_circulate_r(mesh, t, cornerScratch);
  for (let i = 0; i < cornerScratch.length; i++) {
    if (r_water[cornerScratch[i]] === 1) return true;
  }
  return false;
}

/** Deterministic habitability of cell r (see the file comment, step 1); -Infinity on water. */
export function scoreCell(mesh: Mesh, geo: Geography, r: number): number {
  const { r_water, r_elevation, r_slope, r_biome, r_coastDist, s_river } = geo;
  if (r_water[r] !== 0) return -Infinity;
  let oceanNeighbors = 0;
  let oceanDist = 0;
  let riverSide = 0;
  let riverMouth = 0;
  r_circulate_s(mesh, r, sideScratch);
  for (let i = 0; i < sideScratch.length; i++) {
    const s = sideScratch[i];
    const v = s_end_r(mesh, s);
    if (r_water[v] === 1) {
      oceanNeighbors++;
      oceanDist += r_coastDist[v];
    }
    if (s_river[s] > 0) {
      riverSide = 1;
      if (
        riverMouth === 0 &&
        (cornerTouchesOcean(mesh, r_water, s_outer_t(mesh, s)) || cornerTouchesOcean(mesh, r_water, s_inner_t(s)))
      ) {
        riverMouth = 1;
      }
    }
  }
  const coast = oceanNeighbors > 0 ? 1 : 0;
  const harbor =
    oceanNeighbors >= 1 && oceanNeighbors <= HARBOR_MAX_OCEAN_NEIGHBORS &&
    oceanDist / oceanNeighbors > HARBOR_MIN_MEAN_DIST ? 1 : 0;
  const e = r_elevation[r];
  const elevation = e > 0 ? e : 0;
  return (
    FERTILITY_WEIGHT * BIOME_FERTILITY[BIOMES[r_biome[r]]] +
    W_COAST * coast + W_RIVER_SIDE * riverSide + W_RIVER_MOUTH * riverMouth + W_HARBOR * harbor -
    W_ELEVATION * elevation - W_SLOPE * r_slope[r]
  );
}

export function placeSettlements(
  mesh: Mesh, params: WorldParams, geo: Geography, provinces: Province[], r_province: Int16Array, rng: Rng,
): { settlements: Settlement[]; r_settlement: Int16Array } {
  const nr = mesh.numRegions;
  const { r_water, s_river, s_riverId } = geo;
  const scratch: number[] = [];

  // ---- 1 + 2. deterministic score, then the working score with noise (RNG use 1)
  const base = new Float32Array(nr);
  const score = new Float32Array(nr);
  let landCells = 0;
  for (let r = 0; r < nr; r++) {
    if (r_water[r] !== 0) {
      base[r] = -Infinity;
      score[r] = -Infinity;
      continue;
    }
    landCells++;
    const sc = scoreCell(mesh, geo, r);
    base[r] = sc;
    score[r] = sc + NOISE * rng.next();
  }
  // ---- 2. islets: land components below MIN_LANDMASS_CELLS take no settlement (draws already made)
  const queue = new Int32Array(nr);
  const r_landmass = new Int32Array(nr).fill(-1);
  for (let r0 = 0; r0 < nr; r0++) {
    if (r_water[r0] !== 0 || r_landmass[r0] >= 0) continue;
    let head = 0, tail = 0;
    queue[tail++] = r0;
    r_landmass[r0] = r0;
    while (head < tail) {
      r_circulate_r(mesh, queue[head++], scratch);
      for (let k = 0; k < scratch.length; k++) {
        const v = scratch[k];
        if (r_water[v] !== 0 || r_landmass[v] >= 0) continue;
        r_landmass[v] = r0;
        queue[tail++] = v;
      }
    }
    if (tail < MIN_LANDMASS_CELLS) {
      for (let i = 0; i < tail; i++) score[queue[i]] = -Infinity;
    }
  }
  let n = Math.round(landCells / CELLS_PER_SETTLEMENT);
  if (n < MIN_SETTLEMENTS) n = MIN_SETTLEMENTS;
  if (n > params.settlementsMax) n = params.settlementsMax;
  if (n < 0) n = 0;

  // ---- 3. greedy placement with BFS suppression over land
  const taken = new Uint8Array(nr);
  const depth = new Int32Array(nr);
  const stamp = new Int32Array(nr);          // 0 = unvisited, else 1 + placement index
  const placed: number[] = [];
  while (placed.length < n) {
    let best = -1;
    let bestScore = 0;
    for (let r = 0; r < nr; r++) {
      if (taken[r] === 0 && score[r] > bestScore) {
        bestScore = score[r];
        best = r;
      }
    }
    if (best < 0) break;
    taken[best] = 1;
    placed.push(best);
    const mark = placed.length;
    let head = 0, tail = 0;
    queue[tail++] = best;
    stamp[best] = mark;
    depth[best] = 0;
    while (head < tail) {
      const u = queue[head++];
      const d = depth[u];
      score[u] -= SUPPRESS_STRENGTH * (1 - d / (SUPPRESS_DEPTH + 1));
      if (d >= SUPPRESS_DEPTH) continue;
      r_circulate_r(mesh, u, scratch);
      for (let k = 0; k < scratch.length; k++) {
        const v = scratch[k];
        if (r_water[v] !== 0 || stamp[v] === mark) continue;
        stamp[v] = mark;
        depth[v] = d + 1;
        queue[tail++] = v;
      }
    }
  }

  // ---- 4. kinds by rank
  const m = placed.length;
  let numCities = Math.round(CITY_SHARE * m);
  if (numCities < 1) numCities = 1;
  if (numCities > m) numCities = m;
  let numTowns = Math.round(TOWN_SHARE * m);
  if (numCities + numTowns > m) numTowns = m - numCities;

  // ---- 4 + 5. settlement records (RNG use 2: one draw each, in placement order)
  const settlements: Settlement[] = new Array(m);
  const r_settlement = new Int16Array(nr).fill(-1);
  for (let i = 0; i < m; i++) {
    const r = placed[i];
    const kind: SettlementKind = i < numCities ? 'city' : i < numCities + numTowns ? 'town' : 'village';
    const population = Math.round(BASE_POPULATION[kind] * (POP_JITTER_MIN + POP_JITTER_RANGE * rng.next()));
    let port = false;
    let riverMouth = false;
    let river = -1;
    let bestFlux = 0;
    let bestSide = -1;
    r_circulate_s(mesh, r, scratch);
    for (let k = 0; k < scratch.length; k++) {
      const s = scratch[k];
      if (r_water[s_end_r(mesh, s)] === 1) port = true;
      const f = s_river[s];
      if (f > 0) {
        if (f > bestFlux || (f === bestFlux && s < bestSide)) {
          bestFlux = f;
          bestSide = s;
          river = s_riverId[s];
        }
        if (
          !riverMouth &&
          (cornerTouchesOcean(mesh, r_water, s_outer_t(mesh, s)) || cornerTouchesOcean(mesh, r_water, s_inner_t(s)))
        ) {
          riverMouth = true;
        }
      }
    }
    settlements[i] = {
      id: i, name: '', r, kind, population, port, riverMouth, river,
      province: r_province[r], culture: -1, founded: 0, died: -1,
    };
    r_settlement[r] = i;
  }

  // ---- 6. province seats (intended in-place fill; reset first so repeated calls agree)
  for (let p = 0; p < provinces.length; p++) provinces[p].seat = -1;
  for (let i = 0; i < m; i++) {
    const p = settlements[i].province;
    if (p < 0 || p >= provinces.length) continue;
    const prov = provinces[p];
    if (prov.seat < 0 || base[settlements[i].r] > base[settlements[prov.seat].r]) prov.seat = i;
  }

  return { settlements, r_settlement };
}
