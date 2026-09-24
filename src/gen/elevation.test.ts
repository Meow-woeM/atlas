/**
 * gen/elevation.test.ts — stages 4 and 5 against real upstream data: a Poisson-disc point set and
 * Delaunator mesh at DEFAULT_PARAMS (~10k cells) and at a small 400x300 / spacing-16 world.
 * Per-element invariants are counted with plain loops and asserted once (a vitest expect per cell
 * over 10k cells is slow). Timings are printed, not asserted, since the CI box is unknown.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS, FORMATION_STEPS } from '../core/types';
import type { Mesh, Raster, WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, cellPolygon, r_circulate_r } from '../mesh/dualmesh';
import { computeElevation, computeDistanceField, rawAtStep, landMaskAtStep } from './elevation';
import { computeTectonics } from './tectonics';
import type { ElevationResult } from './elevation';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16 };

interface Built {
  label: string;
  params: WorldParams;
  mesh: Mesh;
  elev: ElevationResult;
  distField: Raster;
  r_coastDist: Float32Array;
  msElevation: number;
  msDistance: number;
}

function makeMesh(params: WorldParams, seed: string): Mesh {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  return buildMesh(points, numBoundary);
}

function build(label: string, params: WorldParams, seed: string): Built {
  const mesh = makeMesh(params, seed);
  const t0 = performance.now();
  const elev = computeElevation(mesh, params, fork(seed, 'elevation'), computeTectonics(mesh, params, fork(seed, 'tectonics')));
  const t1 = performance.now();
  const { distField, r_coastDist } = computeDistanceField(mesh, params, elev.r_water);
  const t2 = performance.now();
  return { label, params, mesh, elev, distField, r_coastDist, msElevation: t1 - t0, msDistance: t2 - t1 };
}

/** Byte-for-byte equality of two typed arrays (no Buffer: @types/node is not installed). */
function sameBytes(a: ArrayBufferLike, b: ArrayBufferLike): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Cell position the way gen code gets it: the average of the cellPolygon corners. */
function cellPos(mesh: Mesh, r: number, poly: Float32Array): [number, number] {
  const k = cellPolygon(mesh, r, poly);
  let sx = 0, sy = 0;
  for (let i = 0; i < k; i++) { sx += poly[2 * i]; sy += poly[2 * i + 1]; }
  return [sx / k, sy / k];
}

const SEED = 'atlas-elevation-test';
const worlds: Built[] = [build('default', DEFAULT_PARAMS, SEED), build('small', SMALL, SEED)];

for (const w of worlds) {
  describe(`computeElevation (${w.label} ${w.params.width}x${w.params.height} r=${w.params.cellSpacing})`, () => {
    const { mesh, params, elev } = w;
    const n = mesh.numRegions;
    const nb = mesh.numBoundaryRegions;
    const nbrs: number[] = [];

    it('returns per-region arrays of the right length and type', () => {
      expect(elev.r_elevation.length).toBe(n);
      expect(elev.r_water.length).toBe(n);
      expect(elev.r_coastHops.length).toBe(n);
      expect(elev.r_slope.length).toBe(n);
      expect(elev.r_lat.length).toBe(n);
      expect(elev.r_lon.length).toBe(n);
      expect(elev.r_coastHops).toBeInstanceOf(Int16Array);
      expect(elev.r_water).toBeInstanceOf(Uint8Array);
    });

    it('lat/lon lie in the frame for interior cells, lat decreasing downward', () => {
      const f = params.frame;
      let bad = 0;
      for (let r = nb; r < n; r++) {
        const lat = elev.r_lat[r], lon = elev.r_lon[r];
        if (lat > Math.max(f.lat0, f.lat1) + 1e-3 || lat < Math.min(f.lat0, f.lat1) - 1e-3) bad++;
        if (lon > Math.max(f.lon0, f.lon1) + 1e-3 || lon < Math.min(f.lon0, f.lon1) - 1e-3) bad++;
      }
      expect(bad).toBe(0);
    });

    it('land fraction of interior cells is within 1% of params.landFraction', () => {
      let land = 0;
      for (let r = nb; r < n; r++) if (elev.r_water[r] === 0) land++;
      const frac = land / (n - nb);
      expect(Math.abs(frac - params.landFraction)).toBeLessThan(0.01);
    });

    it('every boundary region is ocean (1) and r_water only holds 0/1/2', () => {
      let ringNotOcean = 0, badKind = 0;
      for (let r = 0; r < nb; r++) if (elev.r_water[r] !== 1) ringNotOcean++;
      for (let r = 0; r < n; r++) if (elev.r_water[r] > 2) badKind++;
      expect(ringNotOcean).toBe(0);
      expect(badKind).toBe(0);
    });

    it('no land cell within 40 px of the rectangle edge', () => {
      const poly = new Float32Array(64);
      let violations = 0;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 0) continue;
        const [x, y] = cellPos(mesh, r, poly);
        const de = Math.min(x, params.width - x, y, params.height - y);
        if (de < 40) violations++;
      }
      expect(violations).toBe(0);
    });

    it('every ocean cell is connected to the ring through ocean cells (flood-fill property)', () => {
      const seen = new Uint8Array(n);
      const queue = new Int32Array(n);
      let head = 0, tail = 0;
      for (let r = 0; r < nb; r++) { seen[r] = 1; queue[tail++] = r; }
      while (head < tail) {
        const r = queue[head++];
        r_circulate_r(mesh, r, nbrs);
        for (const q of nbrs) {
          if (seen[q] === 0 && elev.r_water[q] === 1) { seen[q] = 1; queue[tail++] = q; }
        }
      }
      let unreachedOcean = 0, reachedNonOcean = 0;
      for (let r = 0; r < n; r++) {
        if (elev.r_water[r] === 1 && seen[r] === 0) unreachedOcean++;
        if (elev.r_water[r] !== 1 && seen[r] === 1) reachedNonOcean++;
      }
      expect(unreachedOcean).toBe(0);
      expect(reachedNonOcean).toBe(0);
    });

    it('lake candidates (2) are water cells with no path to the ring across water', () => {
      // Every lake candidate has no ocean neighbor (otherwise the flood fill would have reached it).
      let bad = 0, candidates = 0;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 2) continue;
        candidates++;
        r_circulate_r(mesh, r, nbrs);
        for (const q of nbrs) if (elev.r_water[q] === 1) bad++;
      }
      expect(bad).toBe(0);
      expect(candidates).toBeLessThan((n - nb) * 0.1);
    });

    it('coast hops are 0 exactly on ocean cells and >= 1 elsewhere, and differ by <= 1 across a side', () => {
      let bad = 0;
      for (let r = 0; r < n; r++) {
        const h = elev.r_coastHops[r];
        if (elev.r_water[r] === 1 ? h !== 0 : h < 1) bad++;
        r_circulate_r(mesh, r, nbrs);
        for (const q of nbrs) if (Math.abs(elev.r_coastHops[q] - h) > 1) bad++;
      }
      expect(bad).toBe(0);
    });

    it('r_elevation is in [-1, 1] with water < 0 <= land, and the land range is used', () => {
      let bad = 0, maxLand = -Infinity, minWater = Infinity;
      for (let r = 0; r < n; r++) {
        const e = elev.r_elevation[r];
        if (!(e >= -1 && e <= 1)) bad++;
        if (elev.r_water[r] === 0) {
          if (!(e >= 0)) bad++;
          if (e > maxLand) maxLand = e;
        } else {
          if (!(e < 0)) bad++;
          if (e < minWater) minWater = e;
        }
      }
      expect(bad).toBe(0);
      // 0.55 rankNorm^1.5 + 0.45 (hops / maxHops)^0.8 reaches 1 only when the highest-raw cell is
      // also the farthest from the coast; ~0.9 is typical.
      expect(maxLand).toBeGreaterThan(0.8);
      expect(minWater).toBeLessThanOrEqual(-0.9);
    });

    it('r_slope is the max |elevation difference| over neighbors and is in [0, 2]', () => {
      let bad = 0;
      for (let r = 0; r < n; r++) {
        r_circulate_r(mesh, r, nbrs);
        let m = 0;
        for (const q of nbrs) m = Math.max(m, Math.abs(elev.r_elevation[r] - elev.r_elevation[q]));
        if (Math.abs(m - elev.r_slope[r]) > 1e-6) bad++;
        if (!(elev.r_slope[r] >= 0 && elev.r_slope[r] <= 2)) bad++;
      }
      expect(bad).toBe(0);
    });
  });

  describe(`computeDistanceField (${w.label})`, () => {
    const { mesh, params, elev, distField, r_coastDist } = w;
    const n = mesh.numRegions;
    const nb = mesh.numBoundaryRegions;
    const nbrs: number[] = [];

    it('raster has the rasterScale size and holds logical-px signed distances', () => {
      expect(distField.w).toBe(Math.round(params.width * params.rasterScale));
      expect(distField.h).toBe(Math.round(params.height * params.rasterScale));
      expect(distField.scale).toBe(params.rasterScale);
      // Logical px: the first pixel inside the land mask reads +0.5 raster px = +1 logical px at 0.5.
      let minAbs = Infinity, maxPos = -Infinity, minNeg = Infinity;
      for (let p = 0; p < distField.data.length; p++) {
        const v = distField.data[p];
        if (Math.abs(v) < minAbs) minAbs = Math.abs(v);
        if (v > maxPos) maxPos = v;
        if (v < minNeg) minNeg = v;
      }
      expect(minAbs).toBeCloseTo(0.5 / params.rasterScale, 5);
      expect(maxPos).toBeGreaterThan(40);
      expect(minNeg).toBeLessThan(-40);
    });

    it('r_coastDist is positive on land with coastHops >= 3 and on every lake candidate, negative on ocean with 3+ ocean neighbors, -1000 on the ring', () => {
      // The mask is ocean-only (r_water !== 1 is inside), so lake candidates — which never touch
      // ocean — sit strictly inside the mask and read positive like the land around them.
      let badLand = 0, badLake = 0, badOcean = 0, badRing = 0, landChecked = 0, lakeChecked = 0, oceanChecked = 0;
      for (let r = 0; r < nb; r++) if (r_coastDist[r] !== -1000) badRing++;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] === 0 && elev.r_coastHops[r] >= 3) {
          landChecked++;
          if (!(r_coastDist[r] > 0)) badLand++;
        } else if (elev.r_water[r] === 2) {
          lakeChecked++;
          if (!(r_coastDist[r] > 0)) badLake++;
        } else if (elev.r_water[r] === 1) {
          r_circulate_r(mesh, r, nbrs);
          let oceanNbrs = 0;
          for (const q of nbrs) if (elev.r_water[q] === 1) oceanNbrs++;
          if (oceanNbrs >= 3) {
            oceanChecked++;
            if (!(r_coastDist[r] < 0)) badOcean++;
          }
        }
      }
      expect(landChecked).toBeGreaterThan(0);
      expect(oceanChecked).toBeGreaterThan(0);
      if (w.label === 'default') expect(lakeChecked).toBeGreaterThan(0);
      expect(badRing).toBe(0);
      expect(badLand).toBe(0);
      expect(badLake).toBe(0);
      expect(badOcean).toBe(0);
    });

    it('r_coastDist grows with coast hops on land (monotone over the first 8 bands, strongly correlated overall)', () => {
      // Hops count graph distance to OCEAN and so does the distance field (lake candidates are
      // inside its mask), but hops are graph steps and px are Euclidean, so the deepest (sparse)
      // bands can dip. Check the populated bands and the Pearson correlation over all land cells.
      const sum = new Float64Array(64), cnt = new Int32Array(64);
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 0) continue;
        const h = elev.r_coastHops[r], d = r_coastDist[r];
        sum[Math.min(63, h)] += d;
        cnt[Math.min(63, h)]++;
        sx += h; sy += d; sxx += h * h; syy += d * d; sxy += h * d; m++;
      }
      const corr = (m * sxy - sx * sy) / Math.sqrt((m * sxx - sx * sx) * (m * syy - sy * sy));
      expect(corr).toBeGreaterThan(0.8);
      let prev = -Infinity, violations = 0, bands = 0;
      for (let h = 1; h <= 8; h++) {
        if (cnt[h] < 20) continue;
        const mean = sum[h] / cnt[h];
        if (mean < prev) violations++;
        prev = mean;
        bands++;
      }
      expect(bands).toBeGreaterThan(2);
      expect(violations).toBe(0);
    });
  });
}

describe('determinism', () => {
  const params = SMALL;
  it('two runs from the same seed are byte-identical', () => {
    const a = build('a', params, 'det-seed');
    const b = build('b', params, 'det-seed');
    expect(sameBytes(a.elev.r_elevation.buffer, b.elev.r_elevation.buffer)).toBe(true);
    expect(sameBytes(a.elev.r_water.buffer, b.elev.r_water.buffer)).toBe(true);
    expect(sameBytes(a.elev.r_coastHops.buffer, b.elev.r_coastHops.buffer)).toBe(true);
    expect(sameBytes(a.elev.r_slope.buffer, b.elev.r_slope.buffer)).toBe(true);
    expect(sameBytes(a.r_coastDist.buffer, b.r_coastDist.buffer)).toBe(true);
    expect(sameBytes(a.distField.data.buffer, b.distField.data.buffer)).toBe(true);
  });

  it('a different elevation seed on the same mesh changes the result', () => {
    const mesh = makeMesh(params, 'det-seed');
    const a = computeElevation(mesh, params, fork('det-seed', 'elevation'), computeTectonics(mesh, params, fork('det-seed', 'tectonics')));
    const b = computeElevation(mesh, params, fork('other-seed', 'elevation'), computeTectonics(mesh, params, fork('other-seed', 'tectonics')));
    let diff = 0;
    for (let r = 0; r < mesh.numRegions; r++) if (a.r_elevation[r] !== b.r_elevation[r]) diff++;
    expect(diff).toBeGreaterThan(mesh.numRegions * 0.2);
  });

  it('continents = 1 and 3 both satisfy the land fraction and margin', () => {
    const poly = new Float32Array(64);
    for (const continents of [1, 3] as const) {
      const p: WorldParams = { ...params, continents };
      const mesh = makeMesh(p, 'cont-seed');
      const e = computeElevation(mesh, p, fork('cont-seed', 'elevation'), computeTectonics(mesh, p, fork('cont-seed', 'tectonics')));
      let land = 0, margin = 0;
      for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
        if (e.r_water[r] !== 0) continue;
        land++;
        const [x, y] = cellPos(mesh, r, poly);
        if (Math.min(x, p.width - x, y, p.height - y) < 40) margin++;
      }
      expect(Math.abs(land / (mesh.numRegions - mesh.numBoundaryRegions) - p.landFraction)).toBeLessThan(0.01);
      expect(margin).toBe(0);
    }
  });
});

describe('timings', () => {
  it('prints stage 4 and 5 timings (budgets: 25 ms and 15 ms at defaults)', () => {
    for (const w of worlds) {
      console.log(
        `[elevation] ${w.label}: ${w.mesh.numRegions} cells, stage 4 ${w.msElevation.toFixed(1)} ms, ` +
        `stage 5 ${w.msDistance.toFixed(1)} ms`,
      );
    }
    expect(worlds[0].msElevation).toBeLessThan(500);
  });
});

describe('formation timeline', () => {
  const SEEDS = ['atlas', 'amberfell', 'test-1', 'zzzzzzzz'];
  const built = SEEDS.map((seed) => {
    const p = DEFAULT_PARAMS;
    const { points, numBoundary } = generatePoints(p, fork(seed, 'points'));
    const mesh = buildMesh(points, numBoundary);
    const tec = computeTectonics(mesh, p, fork(seed, 'tectonics'));
    return { seed, mesh, elev: computeElevation(mesh, p, fork(seed, 'elevation'), tec) };
  });

  function landFractionAt(mesh: Mesh, f: ReturnType<typeof computeElevation>['formation'], step: number): number {
    const mask = landMaskAtStep(mesh, f, step);
    let land = 0;
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) if (mask[r] === 1) land++;
    return land / (mesh.numRegions - mesh.numBoundaryRegions);
  }

  it('never loses land as time runs forward', () => {
    // The promise the scroll bar makes: the world grows toward the present against a fixed sea.
    // Sea level is absolute (the landFraction quantile at the last step) and every ramp in
    // rawAtStep is non-decreasing in u. Individual cells DO come and go now that the crust rides
    // its plate (see the churn test below), but the total never drops on the tuning seeds.
    let drops = 0;
    for (const { mesh, elev } of built) {
      let prev = -1;
      for (let step = 0; step < FORMATION_STEPS; step++) {
        const frac = landFractionAt(mesh, elev.formation, step);
        if (frac < prev - 1e-9) drops++;
        prev = frac;
      }
    }
    expect(drops).toBe(0);
  });

  it('starts with proto-continents already there, well short of the present, and ends at params.landFraction', () => {
    for (const { seed, mesh, elev } of built) {
      const first = landFractionAt(mesh, elev.formation, 0);
      const last = landFractionAt(mesh, elev.formation, FORMATION_STEPS - 1);
      // Not an empty sea: the story is continents moving and colliding, not rising from nothing.
      expect(first, seed).toBeGreaterThan(0.1);
      expect(first, seed).toBeLessThan(0.3);
      expect(last, seed).toBeGreaterThan(first + 0.1);
      // The last step is the world as if there were no timeline at all.
      expect(Math.abs(last - DEFAULT_PARAMS.landFraction), seed).toBeLessThan(0.02);
    }
  });

  it('keeps the boundary ring under water at every step', () => {
    let wet = 0;
    for (const { mesh, elev } of built) {
      for (let step = 0; step < FORMATION_STEPS; step += 4) {
        const mask = landMaskAtStep(mesh, elev.formation, step);
        for (let r = 0; r < mesh.numBoundaryRegions; r++) if (mask[r] !== 0) wet++;
      }
    }
    expect(wet).toBe(0);
  });

  it('rawAtStep is deterministic, fills an out array, and clamps out-of-range steps', () => {
    const { mesh, elev } = built[0];
    const a = rawAtStep(elev.formation, 5);
    const out = new Float32Array(mesh.numRegions);
    const b = rawAtStep(elev.formation, 5, out);
    expect(b).toBe(out);
    expect(b).toEqual(a);
    expect(rawAtStep(elev.formation, -10)).toEqual(rawAtStep(elev.formation, 0));
    expect(rawAtStep(elev.formation, 999)).toEqual(rawAtStep(elev.formation, FORMATION_STEPS - 1));
  });

  it('generating at an earlier step really changes the world', () => {
    const p = DEFAULT_PARAMS;
    const early: WorldParams = { ...p, formationStep: 4 };
    const { points, numBoundary } = generatePoints(p, fork('step', 'points'));
    const mesh = buildMesh(points, numBoundary);
    const tec = computeTectonics(mesh, p, fork('step', 'tectonics'));
    const now = computeElevation(mesh, p, fork('step', 'elevation'), tec);
    const then = computeElevation(mesh, early, fork('step', 'elevation'), tec);
    let nowLand = 0, thenLand = 0;
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
      if (now.r_water[r] === 0) nowLand++;
      if (then.r_water[r] === 0) thenLand++;
    }
    expect(thenLand).toBeLessThan(nowLand);
    // The same time-independent fields and the same absolute sea back both moments.
    expect(then.formation.seaLevel).toBe(now.formation.seaLevel);
    expect(then.formation.r_craton).toEqual(now.formation.r_craton);
  });

  it('moves the crust: some cells are land at an earlier step and sea by the present day', () => {
    // Under the old ramps-only model land could only ever be gained cell by cell, so this count
    // was zero. With plate drift, crust that sits over a closing ocean early on is gone by the end.
    for (const { seed, mesh, elev } of built) {
      const last = landMaskAtStep(mesh, elev.formation, FORMATION_STEPS - 1);
      let churn = 0;
      for (let step = 0; step < FORMATION_STEPS - 1; step += 3) {
        const mask = landMaskAtStep(mesh, elev.formation, step);
        for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) if (mask[r] === 1 && last[r] === 0) churn++;
      }
      expect(churn, seed).toBeGreaterThan(0);
    }
  });

  it('reads the present day straight from the stored fields, so the lookup never touches the final world', () => {
    const { elev } = built[0];
    const f = elev.formation;
    const raw = rawAtStep(f, FORMATION_STEPS - 1);
    let off = 0;
    for (let r = 0; r < raw.length; r++) {
      const direct = (0.42 * f.r_noise[r] + 0.34 * f.r_craton[r] + 0.30 * f.r_uplift[r]) * f.r_falloff[r];
      if (Math.abs(raw[r] - direct) > 1e-6) off++;
    }
    expect(off).toBe(0);
  });
});
