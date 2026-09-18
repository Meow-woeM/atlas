/**
 * gen/tectonics.ts — Stage 3.5 (Plates), the substrate stage 4 builds its land on.
 *
 * RNG stream: `tectonics` (the caller passes fork(seed, 'tectonics')). Consumption order, frozen
 * (changing it is a params.version bump):
 *   1. plate seeds, i = 0..plates-1 — rng.int(nb, n - 1) per try, retried while the candidate is
 *      within minSeedDist of an earlier seed, at most SEED_TRIES times, then taken anyway.
 *   2. per plate, in plate order — rng.float(0, 2*PI) heading, then rng.float(SPEED_LO, SPEED_HI).
 *   3. continental cores — one rng.int(0, plates - 1) for the first core; every later core is
 *      chosen by farthest-point sampling over the plate seeds and draws nothing. The count is
 *      max(params.continents, round(plates * landFraction)), so params.continents is a floor and
 *      the craton's area tracks the land target (see the comment at the call site).
 *
 * Inputs:  Mesh, WorldParams (plates, continents), Rng.
 * Outputs: Tectonics. Nothing is mutated; the mesh is read through adjacency and cellCentroids.
 *
 * The model, in the order the fields are built:
 *   1. Plates: `plates` seed cells, grown by one multi-source BFS over the cell graph, seeds pushed
 *      in plate order so an equidistant cell always joins the lower plate index. Every region
 *      (boundary ring included) ends on exactly one plate.
 *   2. Velocity: a heading and a speed per plate — a rigid-body drift, no rotation. Plates are
 *      fixed in place; what moves is the stress their relative motion implies.
 *   3. Craton: 1 on continental plates, 0 on oceanic, then diffused CRATON_SMOOTH times over the
 *      cell graph so a continent's edge is a gradient rather than a plate-shaped cliff.
 *   4. Stress: for a cell on a plate boundary, the neighbour across the boundary with the largest
 *      |convergence|, where convergence = dot(v[mine] - v[theirs], unit vector from me to them).
 *      Positive is convergent (the plates close: uplift, a mountain belt); negative is divergent
 *      (they open: a rift). Interior cells start at 0 and pick up stress only by diffusion, which
 *      runs STRESS_SMOOTH times and is what gives a belt width instead of a one-cell seam.
 *
 * Stage 4 turns craton and stress into height; this module has no notion of sea level, elevation
 * or time. The formation timeline is stage 4's doing: these fields are time-independent, and the
 * timeline only changes how much of each is mixed in.
 */

import type { Rng } from '../core/rng';
import type { Mesh, WorldParams } from '../core/types';
import { cellCentroids, r_circulate_r } from '../mesh/dualmesh';

export interface Tectonics {
  numPlates: number;
  r_plate: Int16Array;         // plate index per cell; every region is on exactly one plate
  plateVx: Float32Array;       // per plate, drift velocity (logical px per unit time, unnormalised)
  plateVy: Float32Array;
  plateOceanic: Uint8Array;    // per plate, 1 oceanic, 0 continental
  r_craton: Float32Array;      // 0..1 continental basement, diffused
  r_stress: Float32Array;      // convergence (+) / rift (-), diffused; roughly -1..1
}

/** Tries to place a seed away from the earlier ones before giving up and taking the candidate. */
const SEED_TRIES = 24;
const SPEED_LO = 0.4;
const SPEED_HI = 1;
/** Diffusion passes over the cell graph. */
const CRATON_SMOOTH = 6;
const STRESS_SMOOTH = 8;

/** Neighbour lists flattened into CSR, built once: the diffusion passes below walk the whole cell
 *  graph a dozen times, and re-circulating each cell every pass costs more than the arithmetic. */
interface Adjacency { start: Int32Array; nbr: Int32Array }

function buildAdjacency(mesh: Mesh): Adjacency {
  const n = mesh.numRegions;
  const start = new Int32Array(n + 1);
  const scratch: number[] = [];
  for (let r = 0; r < n; r++) {
    r_circulate_r(mesh, r, scratch);
    start[r + 1] = start[r] + scratch.length;
  }
  const nbr = new Int32Array(start[n]);
  for (let r = 0; r < n; r++) {
    r_circulate_r(mesh, r, scratch);
    const base = start[r];
    for (let i = 0; i < scratch.length; i++) nbr[base + i] = scratch[i];
  }
  return { start, nbr };
}

/** Jacobi graph diffusion: each cell moves `rate` of the way to its neighbour mean, `passes` times. */
function diffuse(adj: Adjacency, n: number, field: Float32Array, passes: number, rate: number): void {
  const { start, nbr } = adj;
  const scratch = new Float32Array(n);
  for (let pass = 0; pass < passes; pass++) {
    for (let r = 0; r < n; r++) {
      const a = start[r], b = start[r + 1];
      const k = b - a;
      if (k === 0) { scratch[r] = field[r]; continue; }
      let sum = 0;
      for (let i = a; i < b; i++) sum += field[nbr[i]];
      scratch[r] = field[r] + rate * (sum / k - field[r]);
    }
    field.set(scratch);
  }
}

export function computeTectonics(mesh: Mesh, params: WorldParams, rng: Rng): Tectonics {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const interior = n - nb;
  const numPlates = Math.max(2, Math.min(params.plates, interior > 0 ? interior : 2));
  const { r_px, r_py } = cellCentroids(mesh);
  const adj = buildAdjacency(mesh);
  const { start: adjStart, nbr: adjNbr } = adj;

  // ---- 1. seeds (RNG draw 1), spread by rejection
  const seeds = new Int32Array(numPlates);
  const minSeedDist = 0.55 * Math.min(params.width, params.height) / Math.sqrt(numPlates);
  const minSeedDist2 = minSeedDist * minSeedDist;
  for (let i = 0; i < numPlates; i++) {
    let pick = nb;
    for (let t = 0; t < SEED_TRIES; t++) {
      pick = rng.int(nb, n - 1);
      let ok = true;
      for (let j = 0; j < i; j++) {
        const dx = r_px[pick] - r_px[seeds[j]];
        const dy = r_py[pick] - r_py[seeds[j]];
        if (dx * dx + dy * dy < minSeedDist2) { ok = false; break; }
      }
      if (ok) break;
    }
    seeds[i] = pick;
  }

  // ---- 2. plate growth: one multi-source BFS, seeds pushed in plate order
  const r_plate = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < numPlates; i++) {
    if (r_plate[seeds[i]] >= 0) continue;          // two plates landed on the same cell
    r_plate[seeds[i]] = i;
    queue[tail++] = seeds[i];
  }
  while (head < tail) {
    const r = queue[head++];
    const p = r_plate[r];
    for (let i = adjStart[r]; i < adjStart[r + 1]; i++) {
      const q = adjNbr[i];
      if (r_plate[q] < 0) {
        r_plate[q] = p;
        queue[tail++] = q;
      }
    }
  }
  // Any region the walk could not reach (an isolated cell) joins plate 0.
  for (let r = 0; r < n; r++) if (r_plate[r] < 0) r_plate[r] = 0;

  // ---- 3. velocities (RNG draw 2)
  const plateVx = new Float32Array(numPlates);
  const plateVy = new Float32Array(numPlates);
  for (let i = 0; i < numPlates; i++) {
    const heading = rng.float(0, Math.PI * 2);
    const speed = rng.float(SPEED_LO, SPEED_HI);
    plateVx[i] = Math.cos(heading) * speed;
    plateVy[i] = Math.sin(heading) * speed;
  }

  // ---- 4. continental plates (RNG draw 3). A fixed count, so a seed can never roll an all-ocean
  // world. The first core is drawn; every later one is the plate whose seed is FARTHEST from the
  // cores already chosen (farthest-point sampling, no further draws). Picking them at random
  // instead lets two continental plates come up adjacent, and adjacent cratons merge into one
  // supercontinent whose interior sits ~230 px from any coast — which the climate stage turns into
  // a continent-sized desert. Spreading the cores is what makes `continents` read as a count of
  // landmasses rather than a count of plates.
  const plateOceanic = new Uint8Array(numPlates).fill(1);
  // How many plates carry continental crust. Their combined area should come out near
  // params.landFraction: when the craton covers much less than the target, the sea-level quantile
  // has to promote that much more noise-driven land, and it arrives as stringy fragments scattered
  // over the ocean rather than as coastline on a continent. Measured over the four tuning seeds,
  // going from 2 cores (22% of the map, against a 42% target) to 4 (44%) moved settlements on a
  // coast from 62-79% down to 37-67% and lifted inland settlements above 30% on every seed.
  // params.continents is the floor, so asking for 3 continents still gets at least 3 cores.
  const areaCores = Math.round(numPlates * params.landFraction);
  const numContinental = Math.max(1, Math.min(Math.max(params.continents, areaCores), numPlates - 1));
  const first = rng.int(0, numPlates - 1);
  plateOceanic[first] = 0;
  for (let c = 1; c < numContinental; c++) {
    let best = -1, bestDist = -1;
    for (let i = 0; i < numPlates; i++) {
      if (plateOceanic[i] === 0) continue;
      let nearest = Infinity;
      for (let j = 0; j < numPlates; j++) {
        if (plateOceanic[j] !== 0) continue;
        const dx = r_px[seeds[i]] - r_px[seeds[j]];
        const dy = r_py[seeds[i]] - r_py[seeds[j]];
        const d = dx * dx + dy * dy;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist || (nearest === bestDist && best < 0)) { bestDist = nearest; best = i; }
    }
    if (best < 0) break;
    plateOceanic[best] = 0;
  }

  // ---- 5. craton: continental basement, softened
  const r_craton = new Float32Array(n);
  for (let r = 0; r < n; r++) r_craton[r] = plateOceanic[r_plate[r]] === 0 ? 1 : 0;
  diffuse(adj, n, r_craton, CRATON_SMOOTH, 0.5);

  // ---- 6. stress at plate boundaries, then spread into belts
  const r_stress = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const mine = r_plate[r];
    let best = 0;
    for (let i = adjStart[r]; i < adjStart[r + 1]; i++) {
      const q = adjNbr[i];
      const theirs = r_plate[q];
      if (theirs === mine) continue;
      let dx = r_px[q] - r_px[r], dy = r_py[q] - r_py[r];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) continue;
      dx /= len; dy /= len;
      // Closing speed along the line between the two cells: + convergent, - divergent.
      const conv = (plateVx[mine] - plateVx[theirs]) * dx + (plateVy[mine] - plateVy[theirs]) * dy;
      if (Math.abs(conv) > Math.abs(best)) best = conv;
    }
    r_stress[r] = best;
  }
  diffuse(adj, n, r_stress, STRESS_SMOOTH, 0.5);

  return { numPlates, r_plate, plateVx, plateVy, plateOceanic, r_craton, r_stress };
}
