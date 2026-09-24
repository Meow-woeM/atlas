/**
 * gen/elevation.ts — Stage 4 (Elevation) and stage 5 (Distance field).
 *
 * RNG stream: `elevation` (the caller passes fork(seed, 'elevation') to computeElevation; the
 * distance field draws nothing). Consumption order, frozen (changing it is a params.version bump):
 *   1. makeSimplex3(rng)                    — the 256-entry permutation shuffle (255 draws).
 *   2. domain-warp offsets                  — 9 x rng.float(-100, 100): o1.xyz, o2.xyz, o3.xyz.
 * Nothing else is drawn here: the continent shapes come from gen/tectonics.ts, which has its own
 * `tectonics` stream, so stage 4 is otherwise a pure function of the noise and the plates.
 *
 * Inputs:  Mesh, WorldParams (frame, width/height, landFraction, formationStep, rasterScale), Rng,
 *          and the Tectonics of stage 3.5.
 * Outputs: ElevationResult (r_elevation, r_water, r_coastHops, r_slope, r_lat, r_lon, formation)
 *          and, from computeDistanceField, { distField, r_coastDist }.
 * Split (2026-09-23): computeElevation = elevationAtStep(buildFormation(...), params.formationStep).
 *          buildFormation does the RNG draws and the noise once; elevationAtStep is the per-moment
 *          part and draws nothing, so gen/world.ts can re-run a step from a prepared base while
 *          the scroll bar is dragged.
 *
 * THE FORMATION TIMELINE. The three fields raw height is mixed from — basement noise, continental
 * craton and tectonic uplift — do not depend on time; only how much of each is mixed in does, and
 * WHERE the crust is. `Formation` stores the fields once and `rawAtStep` evaluates a moment in one
 * pass over the cells, instead of storing FORMATION_STEPS snapshots. Sea level is ABSOLUTE: it is
 * the quantile that gives params.landFraction at the LAST step, and every earlier step is measured
 * against that same level, so the last step reproduces the world as if there were no timeline.
 *
 * PLATE DRIFT (2026-09-23). The crust rides its plate. A plate of velocity v still has
 * drift x (1 - u) px of travel left at position u on the timeline, so the crust sitting at cell r
 * then is the crust that will END at q = r + v x drift x (1 - u): rawAtStep reads the final noise
 * and craton of the cell nearest q (Formation.lookup). When q lies on another plate that crust does
 * not exist yet — it is the ocean the collision has since closed — and r reads as bare sea floor:
 * its own basement noise, no craton. Uplift stays at the plate boundaries, where the belts are, and
 * ramps up as the plates arrive. So converging continents close an ocean and raise mountains where
 * they meet, diverging ones split along the rift, and the present day (u = 1, displacement 0) is
 * the stored fields bit for bit.
 *
 * Stage 4, exactly as ARCHITECTURE.md section 5 lists it:
 *   1. r_lat / r_lon through cellLatLon; the noise position is cellUnitVector(r) (the unit sphere).
 *   2. 3D simplex + 6-octave fBm (lacunarity 2, gain 0.5). Frequency: the frame spans
 *      |lon1 - lon0| degrees; the unit-sphere chord subtending that angle is 2 sin(span / 2), and
 *      the base wavelength (~1 noise unit) is set to a third of that chord. Domain-warped once:
 *      p' = p + 0.08 (fbm4(p + o1), fbm4(p + o2), fbm4(p + o3)) with 4-octave warps, so a cell
 *      costs 3 x 4 + 6 = 18 simplex evaluations. fbm is min-max normalized over interior cells
 *      to 0..1 before mixing.
 *   3. Craton and uplift from stage 3.5 replace the Gaussian continent blobs of ATLAS_VERSION <= 2.
 *      uplift = (stress > 0 ? stress : RIFT_W * stress) * (0.5 + 0.5 craton): convergence lifts,
 *      rifts drop less than they lift, and both bite harder on continental crust than on ocean
 *      floor, so collisions read as mountain belts and oceanic boundaries as island arcs. An edge
 *      falloff (0 within MARGIN = 40 px of the rectangle, smoothstep up to 1 by MARGIN + ramp)
 *      multiplies the whole raw height — not only one term — which is what makes the >= 40 px
 *      ocean margin a guarantee rather than a tendency:
 *        raw(u) = (W_NOISE fbmN nRamp(u) + W_CRATON craton cRamp(u) + W_UPLIFT uplift uRamp(u)) falloff
 *      with u = step / (FORMATION_STEPS - 1). The ramps are the whole timeline: the basement is
 *      mostly there from the start, the craton thickens, the mountains accumulate from nothing.
 *   4. sea = quantile(raw at the LAST step over interior cells, 1 - landFraction), then
 *      r_water = raw(step) < sea ? 1 : 0; the boundary ring is forced to water.
 *   5. Ocean flood fill (BFS) from the ring across water cells: reached = 1 (ocean); unreached
 *      water = 2 (lake candidate; hydrology confirms or reverts it).
 *   6. r_coastHops: multi-source BFS from ocean cells over every cell (0 on ocean, >= 1 else).
 *   7. Reshape: land cells ranked by raw (index sort, index tie-break), rankNorm in [0, 1];
 *      r_elevation = 0.55 rankNorm^1.5 + 0.45 (hops / maxHops)^0.8. Water cells get
 *      -(sea - raw) / sea clamped to [-1, -1e-4] so water is strictly negative.
 *   8. r_slope = max |r_elevation[r] - r_elevation[nbr]| over the neighbors.
 *
 * Stage 5: rasterizeCells(mask) at params.rasterScale, where the mask is 1 for every cell with
 * r_water !== 1 (land AND inland water: lake candidates now, hydrology's lakes later) and 0 for
 * ocean, so the field measures distance to the OCEAN coastline only. Rationale: hydrology
 * (stage 7) confirms or reverts lake candidates and creates new lakes after this stage; with an
 * ocean-only mask none of those decisions invalidates distField / r_coastDist, and r_coastDist
 * keeps its documented meaning (signed logical px to the coastline: + inland, including on lake
 * cells, - offshore). edt -> signed raster px, scaled IN PLACE to logical px (WATERLINE_ISOS are
 * logical px offshore), then r_coastDist = bilinear sample at the cell position. Cell positions
 * everywhere in this file are the average of the cellPolygon corners (never mesh.r_x / r_y).
 * Boundary-ring cells lie outside the raster and get r_coastDist = -1000.
 */

import type { Rng } from '../core/rng';
import type { Formation, Mesh, Raster, WorldParams } from '../core/types';
export type { Formation };
import { FORMATION_STEPS } from '../core/types';
import type { Tectonics } from './tectonics';
import { makeSimplex3, fbm3 } from '../core/noise';
import { quantile } from '../core/geom';
import { makeRaster, rasterizeCells, edt, sampleBilinear } from '../core/raster';
import { cellLatLon, cellUnitVector, cellCentroids, r_circulate_r, buildCellLookup, nearestCell } from '../mesh/dualmesh';

export interface ElevationResult {
  r_elevation: Float32Array; r_water: Uint8Array; r_coastHops: Int16Array; r_slope: Float32Array;
  r_lat: Float32Array; r_lon: Float32Array;
  formation: Formation;
}

/**
 * The ocean margin inside the rectangle varies along the frame: a fixed margin cut every coast
 * that reached it into a line parallel to the frame. Per cell the margin is min + (max - min) x a
 * low-frequency noise of the position, so land near the frame ends in bays and headlands, never in
 * a straight run; the falloff ramps from 0 at the margin to 1 over `ramp` px beyond it. All four
 * lengths scale with the short side of the map (the 1024x768 defaults give 16 / 115 / 80 / 24 px)
 * so a 400x300 test world keeps the same proportions instead of drowning in margin. `sea` is how
 * close to the frame water counts as the sea beyond the map (see elevationAtStep step 5), and
 * `min` is the sliver of sea that is always there against the boundary ring.
 */
export function edgeMargins(params: WorldParams): { min: number; max: number; ramp: number; sea: number } {
  const m = Math.min(params.width, params.height);
  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
  return {
    min: clamp(0.021 * m, 8, 16),
    max: clamp(0.15 * m, 30, 115),
    ramp: clamp(0.105 * m, 30, 80),
    sea: clamp(0.031 * m, 10, 24),
  };
}
/** The margin noise samples the same simplex at this multiple of the terrain frequency. */
const MARGIN_FREQ = 0.9;
/** Offset added to the warp offsets for the margin noise (no extra RNG draw). */
const MARGIN_SHIFT = 41.7;
/**
 * Lake basins (2026-09-23): the reshape below makes height climb with the coast distance, which
 * erases almost every natural pit, so the priority flood of stage 7 found lakes only where the
 * basement noise happened to dip below sea level inland — a handful per world at best. This pass
 * carves basins at the most prominent local minima of the basement noise on inland land: one
 * basin per BASIN_LAND_CELLS land cells, the seed cell and its neighbours lowered to
 * BASIN_DEPTH below the lowest of them, at least BASIN_MIN_HOPS from the ocean, ranked by the
 * noise dip (mean neighbour noise - own) weighted toward high ground. Stage 7 floods each pit and
 * makes it a lake if the flooded cells number at least its minimum. Deterministic, no RNG.
 */
const BASIN_LAND_CELLS = 110;
const BASIN_DEPTH = 0.035;
const BASIN_MIN_HOPS = 3;
/** Mixing weights for raw height. Absolute scale is irrelevant (sea level is a quantile); what
 *  matters is their ratio, and that the ramps below make the total grow with time. */
const W_NOISE = 0.42;
const W_CRATON = 0.34;
const W_UPLIFT = 0.30;
/** A rift drops less than a collision lifts. */
const RIFT_W = 0.55;
/** Ramp floors at step 0: how much of each field the world starts with. The craton is mostly there
 *  from the start — the story is continents moving and colliding, not rising out of the sea — and
 *  the basement is nearly complete; what accumulates from nothing is the uplift. */
const NOISE_FLOOR = 0.75;
const CRATON_FLOOR = 0.70;
/** Plate drift over the whole timeline, logical px per unit plate speed (speeds are 0.4..1). */
const DRIFT_PX = 160;
/** Nearest-cell grid bucket, in multiples of the Poisson spacing. */
const LOOKUP_BUCKET = 2;
/** Domain-warp amplitude in noise units (ARCHITECTURE.md stage 4 step 2). */
const WARP = 0.08;
/** Water elevation ceiling: strictly below sea level. */
const WATER_EPS = -1e-4;
/** r_coastDist for boundary-ring cells (outside the raster). */
const RING_COAST_DIST = -1000;

function smoothstep(t: number): number {
  const s = t < 0 ? 0 : t > 1 ? 1 : t;
  return s * s * (3 - 2 * s);
}

/** Position on the timeline, 0 at the earliest step and 1 at the present day. */
function stepFraction(step: number, steps: number): number {
  if (steps <= 1) return 1;
  const k = step < 0 ? 0 : step > steps - 1 ? steps - 1 : step;
  return k / (steps - 1);
}

/**
 * Raw height at one moment: one pass over the cells mixing the three time-independent fields under
 * the ramps, with the noise and craton read from where the plate has carried them (see the file
 * comment). The basement is mostly there from the start (NOISE_FLOOR), the craton thickens along a
 * smoothstep from CRATON_FLOOR, and uplift accumulates from nothing, slightly faster than linearly
 * at the end so the young mountains arrive late. At the last step the displacement is zero and the
 * fields are read as stored, so the present day never depends on the lookup. Fills `out` when
 * given, allocates otherwise.
 */
export function rawAtStep(f: Formation, step: number, out?: Float32Array): Float32Array {
  const n = f.r_noise.length;
  const raw = out ?? new Float32Array(n);
  const u = stepFraction(step, f.steps);
  const nRamp = NOISE_FLOOR + (1 - NOISE_FLOOR) * u;
  const cRamp = CRATON_FLOOR + (1 - CRATON_FLOOR) * smoothstep(u);
  const uRamp = Math.pow(u, 1.15);
  const back = (1 - u) * f.drift;   // travel the plates still have ahead of them, per unit speed
  if (!(back > 0)) {
    for (let r = 0; r < n; r++) {
      raw[r] = (W_NOISE * f.r_noise[r] * nRamp
        + W_CRATON * f.r_craton[r] * cRamp
        + W_UPLIFT * f.r_uplift[r] * uRamp) * f.r_falloff[r];
    }
    return raw;
  }
  const { r_plate, plateVx, plateVy, lookup } = f;
  const { r_px, r_py } = lookup;
  for (let r = 0; r < n; r++) {
    const pl = r_plate[r];
    // The crust here now is the crust that will end at q, carried the rest of the way by its plate.
    const c = nearestCell(lookup, r_px[r] + plateVx[pl] * back, r_py[r] + plateVy[pl] * back);
    let noise = f.r_noise[r];
    let craton = 0;
    if (c >= 0 && r_plate[c] === pl) {
      noise = f.r_noise[c];
      craton = f.r_craton[c];
    }
    raw[r] = (W_NOISE * noise * nRamp
      + W_CRATON * craton * cRamp
      + W_UPLIFT * f.r_uplift[r] * uRamp) * f.r_falloff[r];
  }
  return raw;
}

/**
 * Land mask at one moment: 1 land, 0 water, with the boundary ring always water. This is the cheap
 * read the formation scroll bar previews with while it is being dragged — no flood fill, so it does
 * not separate ocean from inland water, and no downstream stage is run. Geography is computed here,
 * in gen, and never in the renderer.
 */
export function landMaskAtStep(
  mesh: Mesh, f: Formation, step: number, out?: Uint8Array,
): Uint8Array {
  const n = f.r_noise.length;
  const mask = out ?? new Uint8Array(n);
  const raw = rawAtStep(f, step);
  const nb = mesh.numBoundaryRegions;
  for (let r = 0; r < n; r++) mask[r] = r >= nb && raw[r] >= f.seaLevel ? 1 : 0;
  return mask;
}

/**
 * Steps 1-3 of stage 4: the time-independent fields. Draws the stage's RNG (permutation shuffle,
 * warp offsets), evaluates the warped fBm once per cell, shapes craton and uplift from the plates,
 * builds the nearest-cell grid and fixes the absolute sea level. Everything a moment on the
 * timeline needs, so elevationAtStep can be re-run per step without touching the RNG or the noise.
 */
export function buildFormation(mesh: Mesh, params: WorldParams, rng: Rng, tec: Tectonics): Formation {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const W = params.width, H = params.height;

  // ---- 2. noise on the sphere (RNG draws 1 and 2)
  const simplex = makeSimplex3(rng);
  const off = new Float64Array(9);
  for (let i = 0; i < 9; i++) off[i] = rng.float(-100, 100);

  const span = Math.abs(params.frame.lon1 - params.frame.lon0) * (Math.PI / 180);
  const chord = 2 * Math.sin(Math.min(span, Math.PI) / 2);
  const freq = 3 / (chord > 1e-6 ? chord : 1e-6);

  const raw = new Float32Array(n);
  const v = new Float64Array(3);
  let fMin = Infinity, fMax = -Infinity;
  for (let r = 0; r < n; r++) {
    cellUnitVector(mesh, params, r, v);
    const px = v[0] * freq, py = v[1] * freq, pz = v[2] * freq;
    const wx = fbm3(simplex, px + off[0], py + off[1], pz + off[2], 4, 2, 0.5);
    const wy = fbm3(simplex, px + off[3], py + off[4], pz + off[5], 4, 2, 0.5);
    const wz = fbm3(simplex, px + off[6], py + off[7], pz + off[8], 4, 2, 0.5);
    const f = fbm3(simplex, px + WARP * wx, py + WARP * wy, pz + WARP * wz, 6, 2, 0.5);
    raw[r] = f;
    if (r >= nb) {
      if (f < fMin) fMin = f;
      if (f > fMax) fMax = f;
    }
  }
  const fScale = fMax > fMin ? 1 / (fMax - fMin) : 0;

  // ---- 3. the formation fields: craton and uplift from the plates, plus the edge falloff. The
  // margin the falloff starts at wanders along the frame with a second, lower-frequency read of
  // the same noise (no RNG draw), min-max normalised like the basement.
  const { r_px, r_py } = cellCentroids(mesh);
  const edge = edgeMargins(params);
  const invRamp = 1 / edge.ramp;
  const wob = new Float32Array(n);
  let wMin = Infinity, wMax = -Infinity;
  const mf = freq * MARGIN_FREQ;
  for (let r = 0; r < n; r++) {
    cellUnitVector(mesh, params, r, v);
    const w = fbm3(simplex, v[0] * mf + off[0] + MARGIN_SHIFT, v[1] * mf + off[1] + MARGIN_SHIFT, v[2] * mf + off[2] + MARGIN_SHIFT, 3, 2, 0.5);
    wob[r] = w;
    if (r >= nb) {
      if (w < wMin) wMin = w;
      if (w > wMax) wMax = w;
    }
  }
  const wScale = wMax > wMin ? 1 / (wMax - wMin) : 0;

  const r_noise = new Float32Array(n);
  const r_falloff = new Float32Array(n);
  const r_uplift = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    r_noise[r] = (raw[r] - fMin) * fScale;
    const de = Math.min(r_px[r], W - r_px[r], r_py[r], H - r_py[r]);
    const margin = edge.min + (edge.max - edge.min) * ((wob[r] - wMin) * wScale);
    r_falloff[r] = smoothstep((de - margin) * invRamp);
    const stress = tec.r_stress[r];
    const signed = stress > 0 ? stress : RIFT_W * stress;
    r_uplift[r] = signed * (0.5 + 0.5 * tec.r_craton[r]);
  }

  const formation: Formation = {
    steps: FORMATION_STEPS,
    r_noise,
    r_craton: tec.r_craton,
    r_uplift,
    r_falloff,
    seaLevel: 0,
    r_plate: tec.r_plate,
    plateVx: tec.plateVx,
    plateVy: tec.plateVy,
    drift: DRIFT_PX,
    lookup: buildCellLookup(mesh, LOOKUP_BUCKET * params.cellSpacing, { r_px, r_py }),
  };

  // ---- 4a. sea level, ABSOLUTE: the landFraction quantile at the LAST step, so every earlier step
  // shows less land against the same sea rather than a sea that rises and falls with the land.
  const rawFinal = rawAtStep(formation, FORMATION_STEPS - 1);
  formation.seaLevel = quantile(rawFinal.subarray(nb), 1 - params.landFraction);
  return formation;
}

/**
 * Steps 4-8 of stage 4 at one moment of the timeline: water mask, ocean flood fill, coast hops,
 * reshape, slope — plus lat / lon (step 1), which are cheap and belong to the result. Draws no
 * RNG, so the formation scroll bar can call it per tick from one Formation.
 */
export function elevationAtStep(mesh: Mesh, params: WorldParams, formation: Formation, step: number): ElevationResult {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const nbrs: number[] = [];

  // ---- 1. lat / lon
  const r_lat = new Float32Array(n);
  const r_lon = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const ll = cellLatLon(mesh, params, r);
    r_lat[r] = ll[0];
    r_lon[r] = ll[1];
  }

  // ---- 4b. raw height at this step against the absolute sea
  const sea = formation.seaLevel;
  const raw = rawAtStep(formation, step);
  const r_water = new Uint8Array(n);
  for (let r = 0; r < n; r++) r_water[r] = r < nb || raw[r] < sea ? 1 : 0;
  // ---- 5. ocean flood fill from the ring, and from the water along the frame, across water cells
  const queue = new Int32Array(n);
  const seen = new Uint8Array(n);
  let head = 0, tail = 0;
  for (let r = 0; r < nb; r++) {
    seen[r] = 1;
    queue[tail++] = r;
  }
  {
    const { r_px, r_py } = formation.lookup;
    const W = params.width, H = params.height;
    const seaPx = edgeMargins(params).sea;
    for (let r = nb; r < n; r++) {
      if (r_water[r] === 0) continue;
      const de = Math.min(r_px[r], W - r_px[r], r_py[r], H - r_py[r]);
      if (de < seaPx) {
        seen[r] = 1;
        queue[tail++] = r;
      }
    }
  }
  while (head < tail) {
    const r = queue[head++];
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const q = nbrs[i];
      if (seen[q] === 0 && r_water[q] !== 0) {
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
  }
  for (let r = nb; r < n; r++) if (r_water[r] !== 0 && seen[r] === 0) r_water[r] = 2;

  // ---- 6. coast hops: multi-source BFS from ocean cells over every cell
  const r_coastHops = new Int16Array(n).fill(-1);
  head = 0; tail = 0;
  for (let r = 0; r < n; r++) {
    if (r_water[r] === 1) {
      r_coastHops[r] = 0;
      queue[tail++] = r;
    }
  }
  while (head < tail) {
    const r = queue[head++];
    const h = r_coastHops[r] + 1;
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const q = nbrs[i];
      if (r_coastHops[q] < 0) {
        r_coastHops[q] = h;
        queue[tail++] = q;
      }
    }
  }
  for (let r = 0; r < n; r++) if (r_coastHops[r] < 0) r_coastHops[r] = 1;   // unreachable: never on a connected mesh

  // ---- 7. reshape
  let numLand = 0;
  for (let r = 0; r < n; r++) if (r_water[r] === 0) numLand++;
  const land = new Int32Array(numLand);
  let maxHops = 1;
  for (let r = 0, k = 0; r < n; r++) {
    if (r_water[r] === 0) {
      land[k++] = r;
      if (r_coastHops[r] > maxHops) maxHops = r_coastHops[r];
    }
  }
  land.sort((a, b) => raw[a] - raw[b] || a - b);
  const r_elevation = new Float32Array(n);
  const rankDen = numLand > 1 ? 1 / (numLand - 1) : 1;
  const invMaxHops = 1 / maxHops;
  for (let k = 0; k < numLand; k++) {
    const r = land[k];
    const rankNorm = k * rankDen;
    r_elevation[r] = 0.55 * Math.pow(rankNorm, 1.5) + 0.45 * Math.pow(r_coastHops[r] * invMaxHops, 0.8);
  }
  const invSea = sea > 0 ? 1 / sea : 0;
  for (let r = 0; r < n; r++) {
    if (r_water[r] === 0) continue;
    let e = sea > 0 ? -(sea - raw[r]) * invSea : -1;
    if (e < -1) e = -1;
    if (e > WATER_EPS) e = WATER_EPS;
    r_elevation[r] = e;
  }

  // ---- 7b. lake basins at the most prominent inland dips of the basement noise
  {
    const { r_noise } = formation;
    const prominence = new Float32Array(n);
    let numCand = 0;
    for (let r = nb; r < n; r++) {
      if (r_water[r] !== 0 || r_coastHops[r] < BASIN_MIN_HOPS) continue;
      r_circulate_r(mesh, r, nbrs);
      let sum = 0, count = 0, minimum = true;
      for (let i = 0; i < nbrs.length; i++) {
        const q = nbrs[i];
        if (r_water[q] !== 0 || r_coastHops[q] < BASIN_MIN_HOPS) { minimum = false; break; }
        if (r_noise[q] <= r_noise[r]) { minimum = false; break; }
        sum += r_noise[q];
        count++;
      }
      if (!minimum || count === 0) continue;
      prominence[r] = (sum / count - r_noise[r]) * (0.5 + r_elevation[r]);
      numCand++;
    }
    const cand = new Int32Array(numCand);
    for (let r = nb, k = 0; r < n; r++) if (prominence[r] > 0) cand[k++] = r;
    cand.sort((a, b) => prominence[b] - prominence[a] || a - b);
    const basins = Math.min(numCand, Math.floor(numLand / BASIN_LAND_CELLS));
    const carved = new Uint8Array(n);
    const inner: number[] = [];
    const shell: number[] = [];
    const ring: number[] = [];
    for (let k = 0; k < basins; k++) {
      const seed = cand[k];
      if (carved[seed] === 1) continue;
      // The basin is the seed, its neighbours, and for every third basin the ring beyond; the
      // shell is the ring around that. The shell is carved half as deep, so the spill point lies
      // on the shell's outer corners and every corner of the inner cells is under water: stage 7
      // then floods the whole inner set, which is what makes it a lake and not a one-cell pond.
      inner.length = 0;
      shell.length = 0;
      inner.push(seed);
      const rings = k % 3 === 0 ? 2 : 1;
      let frontier: number[] = [seed];
      for (let ringNo = 0; ringNo <= rings; ringNo++) {
        ring.length = 0;
        for (let f = 0; f < frontier.length; f++) {
          r_circulate_r(mesh, frontier[f], nbrs);
          for (let i = 0; i < nbrs.length; i++) {
            const q = nbrs[i];
            if (q < nb || r_water[q] !== 0 || carved[q] === 1 || inner.includes(q) || shell.includes(q) || ring.includes(q)) continue;
            ring.push(q);
          }
        }
        if (ringNo < rings) inner.push(...ring); else shell.push(...ring);
        frontier = ring.slice();
      }
      let floor = r_elevation[seed];
      for (let i = 0; i < inner.length; i++) if (r_elevation[inner[i]] < floor) floor = r_elevation[inner[i]];
      for (let i = 0; i < shell.length; i++) if (r_elevation[shell[i]] < floor) floor = r_elevation[shell[i]];
      const deep = Math.max(0.001, floor - BASIN_DEPTH);           // stays land: stage 7 decides the lake
      const half = Math.max(0.001, floor - BASIN_DEPTH * 0.5);
      for (let i = 0; i < inner.length; i++) { r_elevation[inner[i]] = deep; carved[inner[i]] = 1; }
      for (let i = 0; i < shell.length; i++) { r_elevation[shell[i]] = half; carved[shell[i]] = 1; }
    }
  }

  // ---- 8. slope
  const r_slope = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const e = r_elevation[r];
    let m = 0;
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const d = Math.abs(e - r_elevation[nbrs[i]]);
      if (d > m) m = d;
    }
    r_slope[r] = m;
  }

  return { r_elevation, r_water, r_coastHops, r_slope, r_lat, r_lon, formation };
}

export function computeElevation(
  mesh: Mesh, params: WorldParams, rng: Rng, tec: Tectonics,
): ElevationResult {
  return elevationAtStep(mesh, params, buildFormation(mesh, params, rng, tec), params.formationStep);
}

export function computeDistanceField(
  mesh: Mesh, params: WorldParams, r_water: Uint8Array,
): { distField: Raster; r_coastDist: Float32Array } {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const rs = params.rasterScale;
  const w = Math.round(params.width * rs);
  const h = Math.round(params.height * rs);

  const mask = makeRaster(w, h, rs);
  // 1 on land and inland water (everything that is not ocean), 0 on ocean: see the file comment.
  const r_land = new Float32Array(n);
  for (let r = 0; r < n; r++) r_land[r] = r_water[r] === 1 ? 0 : 1;
  rasterizeCells(mesh, r_land, mask);

  const distField = edt(mask, mask);
  const inv = 1 / rs;
  const data = distField.data;
  for (let p = 0; p < data.length; p++) data[p] *= inv;

  const { r_px, r_py } = cellCentroids(mesh);
  const r_coastDist = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    r_coastDist[r] = r < nb ? RING_COAST_DIST : sampleBilinear(distField, r_px[r], r_py[r]);
  }
  return { distField, r_coastDist };
}
