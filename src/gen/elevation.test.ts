/**
 * gen/elevation.test.ts — stages 4 and 5 against real upstream data: a Poisson-disc point set and
 * Delaunator mesh at DEFAULT_PARAMS (~10k cells) and at a small 400x300 / spacing-16 world.
 * Per-element invariants are counted with plain loops and asserted once (a vitest expect per cell
 * over 10k cells is slow). Timings are printed, not asserted, since the CI box is unknown.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { Mesh, Raster, WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, cellPolygon, r_circulate_r } from '../mesh/dualmesh';
import { computeElevation, computeDistanceField } from './elevation';
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
  const elev = computeElevation(mesh, params, fork(seed, 'elevation'));
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
    const a = computeElevation(mesh, params, fork('det-seed', 'elevation'));
    const b = computeElevation(mesh, params, fork('other-seed', 'elevation'));
    let diff = 0;
    for (let r = 0; r < mesh.numRegions; r++) if (a.r_elevation[r] !== b.r_elevation[r]) diff++;
    expect(diff).toBeGreaterThan(mesh.numRegions * 0.2);
  });

  it('continents = 1 and 3 both satisfy the land fraction and margin', () => {
    const poly = new Float32Array(64);
    for (const continents of [1, 3] as const) {
      const p: WorldParams = { ...params, continents };
      const mesh = makeMesh(p, 'cont-seed');
      const e = computeElevation(mesh, p, fork('cont-seed', 'elevation'));
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
