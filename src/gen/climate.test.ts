/**
 * gen/climate.test.ts — stages 6 and 8 against real upstream data (points -> mesh -> elevation ->
 * distance field) at DEFAULT_PARAMS (random wind) and at a small 400x300 / spacing-16 world with a
 * fixed wind, plus the four fitting seeds at DEFAULT_PARAMS with windDir 0 that the band edges in
 * climate.ts were fitted against (2026-09-16). Hydrology may not exist yet, so computeBiomes is
 * fed zeroed s_river / t_lake (-1). Per-element invariants are counted in plain loops and asserted
 * once. Every world is built once at module load and reused.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { BIOMES, DEFAULT_PARAMS } from '../core/types';
import type { Biome, Mesh, WindDir, WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, cellPolygon, downwindOrder, r_circulate_r, r_circulate_s } from '../mesh/dualmesh';
import { computeElevation, computeDistanceField } from './elevation';
import type { ElevationResult } from './elevation';
import { computeClimate, computeBiomes, BIOME_COLORS, BIOME_FERTILITY } from './climate';
import type { ClimateInput } from './climate';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16, windDir: 3 };
/** The band edges were fitted over these seeds at DEFAULT_PARAMS with the wind from the west. */
const FIT_SEEDS = ['atlas', 'amberfell', 'test-1', 'zzzzzzzz'] as const;
const FIT_PARAMS: WorldParams = { ...DEFAULT_PARAMS, windDir: 0 };

interface Built {
  label: string;
  params: WorldParams;
  mesh: Mesh;
  elev: ElevationResult;
  r_coastDist: Float32Array;
  climate: { r_temperature: Float32Array; r_moisture: Float32Array; windDir: WindDir };
  s_river: Float32Array;
  t_lake: Int16Array;
  r_biome: Uint8Array;
  msClimate: number;
  msBiomes: number;
}

function makeMesh(params: WorldParams, seed: string): Mesh {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  return buildMesh(points, numBoundary);
}

function climateInput(elev: ElevationResult, r_coastDist: Float32Array): ClimateInput {
  return { r_elevation: elev.r_elevation, r_water: elev.r_water, r_coastDist, r_lat: elev.r_lat };
}

function build(label: string, params: WorldParams, seed: string): Built {
  const mesh = makeMesh(params, seed);
  const elev = computeElevation(mesh, params, fork(seed, 'elevation'));
  const { r_coastDist } = computeDistanceField(mesh, params, elev.r_water);
  const t0 = performance.now();
  const climate = computeClimate(mesh, params, climateInput(elev, r_coastDist), fork(seed, 'climate'));
  const t1 = performance.now();
  const s_river = new Float32Array(mesh.numSides);
  const t_lake = new Int16Array(mesh.numTriangles).fill(-1);
  const r_biome = computeBiomes(mesh, {
    r_water: elev.r_water, r_elevation: elev.r_elevation, r_temperature: climate.r_temperature,
    r_moisture: climate.r_moisture, r_coastDist, s_river, t_lake,
  });
  const t2 = performance.now();
  return { label, params, mesh, elev, r_coastDist, climate, s_river, t_lake, r_biome, msClimate: t1 - t0, msBiomes: t2 - t1 };
}

function cellPos(mesh: Mesh, r: number, poly: Float32Array): [number, number] {
  const k = cellPolygon(mesh, r, poly);
  let sx = 0, sy = 0;
  for (let i = 0; i < k; i++) { sx += poly[2 * i]; sy += poly[2 * i + 1]; }
  return [sx / k, sy / k];
}

const biome = (name: Biome): number => BIOMES.indexOf(name);

/** Byte-for-byte equality of two typed arrays (no Buffer: @types/node is not installed). */
function sameBytes(a: ArrayBufferLike, b: ArrayBufferLike): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Biome histogram over interior land cells as % of land, plus the land count. */
function landHistogram(w: Built): { pct: Float64Array; land: number } {
  const hist = new Int32Array(BIOMES.length);
  let land = 0;
  for (let r = w.mesh.numBoundaryRegions; r < w.mesh.numRegions; r++) {
    if (w.elev.r_water[r] !== 0) continue;
    land++;
    hist[w.r_biome[r]]++;
  }
  const pct = new Float64Array(BIOMES.length);
  for (let i = 0; i < BIOMES.length; i++) pct[i] = (100 * hist[i]) / land;
  return { pct, land };
}

function histogramLine(w: Built): string {
  const { pct } = landHistogram(w);
  const parts: string[] = [];
  for (let i = 0; i < BIOMES.length; i++) if (pct[i] > 0) parts.push(`${BIOMES[i]} ${pct[i].toFixed(1)}%`);
  return `[biomes] ${w.label} wind=${w.climate.windDir} (% of land): ${parts.join(', ')}`;
}

const SEED = 'atlas-climate-test';
const worlds: Built[] = [build('default', DEFAULT_PARAMS, SEED), build('small', SMALL, SEED)];
const fitWorlds: Built[] = FIT_SEEDS.map((seed) => build(seed, FIT_PARAMS, seed));

for (const w of worlds) {
  describe(`computeClimate (${w.label} ${w.params.width}x${w.params.height} r=${w.params.cellSpacing})`, () => {
    const { mesh, params, elev, climate } = w;
    const n = mesh.numRegions;
    const nb = mesh.numBoundaryRegions;
    const { r_temperature, r_moisture } = climate;

    it('windDir is the param when fixed and an integer in 0..7 when random', () => {
      if (params.windDir === 'random') {
        expect(Number.isInteger(climate.windDir)).toBe(true);
        expect(climate.windDir).toBeGreaterThanOrEqual(0);
        expect(climate.windDir).toBeLessThanOrEqual(7);
      } else {
        expect(climate.windDir).toBe(params.windDir);
      }
    });

    it('temperature is in [0, 1] and follows base = 1 - (|lat| / 90)^1.5 minus the squared lapse term', () => {
      let bad = 0;
      for (let r = 0; r < n; r++) {
        const t = r_temperature[r];
        if (!(t >= 0 && t <= 1)) bad++;
        const base = 1 - Math.pow(Math.abs(elev.r_lat[r]) / 90, 1.5);
        const e = Math.max(0, elev.r_elevation[r]);
        const want = Math.min(1, Math.max(0, base - 0.55 * e * e));
        if (Math.abs(want - t) > 1e-5) bad++;
      }
      expect(bad).toBe(0);
    });

    it('temperature decreases with |lat| on the flattest land (pairs far enough apart in latitude are ordered)', () => {
      // "Flat" = the lowest quarter of land by elevation (at spacing 16 the hop term alone puts every
      // land cell above 0.12, so an absolute cutoff would be empty). Within that set the lapse term
      // moves temperature by at most 0.55 * emax^2, while d degrees of latitude move the base by at
      // least 1.5 * sqrt(latMin / 90) / 90 * d (the slope grows with |lat|, so the smallest |lat|
      // in the set bounds it); pairs beyond that gap must be ordered.
      const landElev: number[] = [];
      for (let r = nb; r < n; r++) if (elev.r_water[r] === 0) landElev.push(elev.r_elevation[r]);
      const sorted = Float32Array.from(landElev).sort();
      const cutoff = sorted[Math.floor(sorted.length * 0.25)];
      const flat: number[] = [];
      let emax = 0, latMin = Infinity;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 0 || elev.r_elevation[r] > cutoff) continue;
        flat.push(r);
        if (elev.r_elevation[r] > emax) emax = elev.r_elevation[r];
        if (Math.abs(elev.r_lat[r]) < latMin) latMin = Math.abs(elev.r_lat[r]);
      }
      const minSlope = (1.5 * Math.sqrt(latMin / 90)) / 90;
      expect(minSlope).toBeGreaterThan(0);
      const gap = (0.55 * emax * emax) / minSlope + 0.5;
      let pairs = 0, violations = 0;
      for (let i = 0; i < flat.length; i++) {
        for (let j = i + 1; j < flat.length; j++) {
          const a = flat[i], b = flat[j];
          const da = Math.abs(elev.r_lat[a]), db = Math.abs(elev.r_lat[b]);
          if (Math.abs(da - db) <= gap) continue;
          pairs++;
          const lower = da < db ? a : b, higher = da < db ? b : a;
          if (!(r_temperature[lower] > r_temperature[higher])) violations++;
        }
      }
      expect(pairs).toBeGreaterThan(0);
      expect(violations).toBe(0);
    });

    it('moisture is in [0, 1]: exactly 1.0 on ocean (ring included), 0.8 on lake candidates, < 1 on land', () => {
      let bad = 0, landMin = Infinity, landMax = -Infinity;
      for (let r = 0; r < n; r++) {
        const m = r_moisture[r];
        if (!(m >= 0 && m <= 1)) bad++;
        const wk = elev.r_water[r];
        if (wk === 1 && m !== 1) bad++;
        if (wk === 2 && Math.abs(m - 0.8) > 1e-6) bad++;
        if (wk === 0) {
          if (!(m < 1)) bad++;
          if (m < landMin) landMin = m;
          if (m > landMax) landMax = m;
        }
      }
      expect(bad).toBe(0);
      expect(landMin).toBeGreaterThanOrEqual(0.04 * 0.7);
      expect(landMax - landMin).toBeGreaterThan(0.2);   // the field has structure, not a constant
    });

    it('land moisture falls with distance from the coast (mean by coast-hop band, first 6 bands)', () => {
      const sum = new Float64Array(64), cnt = new Int32Array(64);
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 0) continue;
        const h = Math.min(63, elev.r_coastHops[r]);
        sum[h] += r_moisture[r];
        cnt[h]++;
      }
      let prev = Infinity, violations = 0, bands = 0;
      for (let h = 1; h <= 6; h++) {
        if (cnt[h] < 10) continue;
        const mean = sum[h] / cnt[h];
        if (mean > prev) violations++;
        prev = mean;
        bands++;
      }
      expect(bands).toBeGreaterThanOrEqual(3);
      expect(violations).toBe(0);
    });

    it('is deterministic for the same inputs', () => {
      const again = computeClimate(mesh, params, climateInput(elev, w.r_coastDist), fork(SEED, 'climate'));
      expect(again.windDir).toBe(climate.windDir);
      expect(sameBytes(again.r_temperature.buffer, r_temperature.buffer)).toBe(true);
      expect(sameBytes(again.r_moisture.buffer, r_moisture.buffer)).toBe(true);
    });
  });

  describe(`computeBiomes (${w.label})`, () => {
    const { mesh, elev, climate, r_biome } = w;
    const n = mesh.numRegions;
    const nb = mesh.numBoundaryRegions;
    const nbrs: number[] = [];

    it('returns a Uint8Array of valid BIOMES indices, one per region', () => {
      expect(r_biome).toBeInstanceOf(Uint8Array);
      expect(r_biome.length).toBe(n);
      let bad = 0;
      for (let r = 0; r < n; r++) if (r_biome[r] >= BIOMES.length) bad++;
      expect(bad).toBe(0);
    });

    it('water cells are ocean / lake and land cells are neither', () => {
      let bad = 0;
      for (let r = 0; r < n; r++) {
        const wk = elev.r_water[r];
        const b = r_biome[r];
        if (wk === 1 && b !== biome('ocean')) bad++;
        if (wk === 2 && b !== biome('lake')) bad++;
        if (wk === 0 && (b === biome('ocean') || b === biome('lake'))) bad++;
      }
      expect(bad).toBe(0);
    });

    it('land above 0.85 is snow', () => {
      let bad = 0, high = 0;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 0 || elev.r_elevation[r] <= 0.85) continue;
        high++;
        if (r_biome[r] !== biome('snow')) bad++;
      }
      expect(high).toBeGreaterThan(0);
      expect(bad).toBe(0);
    });

    it('marsh needs coast, elevation < 0.08, adjusted moisture > 0.7 AND a river side / lake corner / lake neighbor', () => {
      // With zeroed s_river / t_lake the only source of wetness is a stage-4 lake candidate next
      // door, so any marsh here must have one; the rule itself is exercised on a hand-built cell.
      let marsh = 0, bad = 0, coastCells = 0, firstCoast = -1;
      for (let r = nb; r < n; r++) {
        if (elev.r_water[r] !== 0) continue;
        r_circulate_r(mesh, r, nbrs);
        let coast = false, lakeNbr = false;
        for (const q of nbrs) {
          if (elev.r_water[q] === 1) coast = true;
          else if (elev.r_water[q] === 2) lakeNbr = true;
        }
        if (coast) {
          coastCells++;
          if (firstCoast < 0 && !lakeNbr && elev.r_elevation[r] < 0.8) firstCoast = r;
        }
        if (r_biome[r] !== biome('marsh')) continue;
        marsh++;
        if (!coast || !lakeNbr || elev.r_elevation[r] >= 0.08 || climate.r_moisture[r] + 0.1 <= 0.7) bad++;
      }
      expect(bad).toBe(0);
      expect(marsh).toBeLessThan(coastCells * 0.05);
      console.log(`[marsh] ${w.label}: ${marsh} of ${coastCells} coast cells without hydrology`);

      expect(firstCoast).toBeGreaterThanOrEqual(0);
      const r_elevation = elev.r_elevation.slice();
      const r_moisture = climate.r_moisture.slice();
      const s_river = new Float32Array(mesh.numSides);
      const t_lake = new Int16Array(mesh.numTriangles).fill(-1);
      const run = (): Uint8Array => computeBiomes(mesh, {
        r_water: elev.r_water, r_elevation, r_temperature: climate.r_temperature, r_moisture,
        r_coastDist: w.r_coastDist, s_river, t_lake,
      });
      const sides: number[] = [];
      r_circulate_s(mesh, firstCoast, sides);
      r_elevation[firstCoast] = 0.05; r_moisture[firstCoast] = 0.9;
      expect(run()[firstCoast]).not.toBe(biome('marsh'));   // low, wet climate, coast: still no water
      s_river[sides[0]] = 1;                                 // a river on one outgoing side
      expect(run()[firstCoast]).toBe(biome('marsh'));
      r_moisture[firstCoast] = 0.5;                          // too dry (0.6 after the bonus)
      expect(run()[firstCoast]).not.toBe(biome('marsh'));
      r_moisture[firstCoast] = 0.9; r_elevation[firstCoast] = 0.2;   // too high
      expect(run()[firstCoast]).not.toBe(biome('marsh'));
      r_elevation[firstCoast] = 0.05; s_river[sides[0]] = 0;
      t_lake[Math.floor(sides[0] / 3)] = 0;                  // a lake corner works the same way
      expect(run()[firstCoast]).toBe(biome('marsh'));
    });

    it('a river side or lake corner adds moisture: nothing gets drier and something changes', () => {
      const s_river = new Float32Array(mesh.numSides).fill(1);
      const wetter = computeBiomes(mesh, {
        r_water: elev.r_water, r_elevation: elev.r_elevation, r_temperature: climate.r_temperature,
        r_moisture: climate.r_moisture, r_coastDist: w.r_coastDist, s_river, t_lake: w.t_lake,
      });
      const dry = new Set([biome('subtropicalDesert'), biome('temperateDesert'), biome('scorched')]);
      let dryBefore = 0, dryAfter = 0, changed = 0;
      for (let r = nb; r < n; r++) {
        if (dry.has(r_biome[r])) dryBefore++;
        if (dry.has(wetter[r])) dryAfter++;
        if (wetter[r] !== r_biome[r]) changed++;
      }
      expect(dryAfter).toBeLessThanOrEqual(dryBefore);
      expect(changed).toBeGreaterThan(0);

      // Same through t_lake: mark the corners of one inland land cell as lake corners.
      let target = -1;
      for (let r = nb; r < n && target < 0; r++) {
        if (elev.r_water[r] === 0 && elev.r_coastHops[r] >= 3 && elev.r_elevation[r] < 0.8) target = r;
      }
      expect(target).toBeGreaterThanOrEqual(0);
      const t_lake = new Int16Array(mesh.numTriangles).fill(-1);
      const sides: number[] = [];
      r_circulate_s(mesh, target, sides);
      for (const s of sides) t_lake[Math.floor(s / 3)] = 0;
      const viaLake = computeBiomes(mesh, {
        r_water: elev.r_water, r_elevation: elev.r_elevation, r_temperature: climate.r_temperature,
        r_moisture: climate.r_moisture, r_coastDist: w.r_coastDist, s_river: w.s_river, t_lake,
      });
      expect(viaLake[target]).toBe(wetter[target]);
    });

    it('is deterministic and prints the biome histogram', () => {
      const again = computeBiomes(mesh, {
        r_water: elev.r_water, r_elevation: elev.r_elevation, r_temperature: climate.r_temperature,
        r_moisture: climate.r_moisture, r_coastDist: w.r_coastDist, s_river: w.s_river, t_lake: w.t_lake,
      });
      expect(sameBytes(again.buffer, r_biome.buffer)).toBe(true);
      console.log(histogramLine(w));
    });
  });
}

describe('biome shares over the fitting seeds (DEFAULT_PARAMS, wind from the west)', () => {
  // The targets the 2026-09-16 band edges were fitted to (climate.ts file comment). Each biome is
  // assigned to one Whittaker row: temperateDesert to cool, grassland to warm.
  const ROWS: readonly (readonly Biome[])[] = [
    ['snow', 'tundra', 'bare', 'scorched'],
    ['taiga', 'shrubland', 'temperateDesert'],
    ['temperateRainforest', 'deciduousForest', 'grassland'],
    ['tropicalRainforest', 'tropicalSeasonalForest', 'subtropicalDesert'],
  ];
  const DESERTS: readonly Biome[] = ['temperateDesert', 'subtropicalDesert', 'scorched'];
  const FORESTS: readonly Biome[] = ['taiga', 'temperateRainforest', 'tropicalRainforest', 'deciduousForest', 'tropicalSeasonalForest'];
  const GRASS: readonly Biome[] = ['grassland', 'shrubland'];
  const share = (pct: Float64Array, names: readonly Biome[]): number => {
    let s = 0;
    for (const b of names) s += pct[biome(b)];
    return s;
  };
  const avg = new Float64Array(BIOMES.length);
  for (const w of fitWorlds) {
    const { pct } = landHistogram(w);
    for (let i = 0; i < BIOMES.length; i++) avg[i] += pct[i] / fitWorlds.length;
  }

  it('prints the per-seed histograms and the average', () => {
    for (const w of fitWorlds) console.log(histogramLine(w));
    const parts: string[] = [];
    for (let i = 0; i < BIOMES.length; i++) if (avg[i] > 0) parts.push(`${BIOMES[i]} ${avg[i].toFixed(1)}%`);
    console.log(`[biomes] average over ${fitWorlds.length} seeds: ${parts.join(', ')}`);
    console.log(
      `[biomes] rows cold/cool/warm/hot ${ROWS.map((row) => share(avg, row).toFixed(1)).join('/')}%, ` +
      `deserts ${share(avg, DESERTS).toFixed(1)}%, forests ${share(avg, FORESTS).toFixed(1)}%, grass+shrub ${share(avg, GRASS).toFixed(1)}%`,
    );
    expect(fitWorlds.length).toBe(4);
  });

  it('temperature rows: cold 6-14%, cool 20-32%, warm 35-50%, hot 18-32% of land', () => {
    expect(share(avg, ROWS[0])).toBeGreaterThanOrEqual(6);
    expect(share(avg, ROWS[0])).toBeLessThanOrEqual(14);
    expect(share(avg, ROWS[1])).toBeGreaterThanOrEqual(20);
    expect(share(avg, ROWS[1])).toBeLessThanOrEqual(32);
    expect(share(avg, ROWS[2])).toBeGreaterThanOrEqual(35);
    expect(share(avg, ROWS[2])).toBeLessThanOrEqual(50);
    expect(share(avg, ROWS[3])).toBeGreaterThanOrEqual(18);
    expect(share(avg, ROWS[3])).toBeLessThanOrEqual(32);
  });

  it('deserts 8-16%, forests 35-55%, grassland+shrubland 18-32% of land', () => {
    expect(share(avg, DESERTS)).toBeGreaterThanOrEqual(8);
    expect(share(avg, DESERTS)).toBeLessThanOrEqual(16);
    expect(share(avg, FORESTS)).toBeGreaterThanOrEqual(35);
    expect(share(avg, FORESTS)).toBeLessThanOrEqual(55);
    expect(share(avg, GRASS)).toBeGreaterThanOrEqual(18);
    expect(share(avg, GRASS)).toBeLessThanOrEqual(32);
  });

  it('every seed uses at least 8 land biomes (no seed collapses to a few bands)', () => {
    for (const w of fitWorlds) {
      const { pct } = landHistogram(w);
      let used = 0;
      for (let i = 0; i < BIOMES.length; i++) if (pct[i] >= 0.5) used++;
      expect(used).toBeGreaterThanOrEqual(8);
    }
  });

  it('the old failure modes stay fixed: < 2% of land at temperature 0, < 10% at the moisture floor', () => {
    for (const w of fitWorlds) {
      const { mesh, elev, climate } = w;
      let land = 0, zero = 0, floor = 0;
      for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
        if (elev.r_water[r] !== 0) continue;
        land++;
        if (climate.r_temperature[r] === 0) zero++;
        // At the floor the carried term is 0.04 and the output is 0.028 + 0.3 * continentality <= 0.328.
        if (climate.r_moisture[r] <= 0.7 * 0.04 + 0.3 + 1e-6) floor++;
      }
      expect(zero / land).toBeLessThan(0.02);
      expect(floor / land).toBeLessThan(0.10);
    }
  });

  it('rain shadows are visible: in the lee of a >= 0.15 rise, > 15% of cells are > 0.1 drier than upwind', () => {
    let lee = 0, big = 0, sumDiff = 0;
    const nbrs: number[] = [];
    for (const w of fitWorlds) {
      const { mesh, elev, climate } = w;
      const order = downwindOrder(mesh, 0);
      const rank = new Int32Array(mesh.numRegions).fill(-1);
      for (let i = 0; i < order.length; i++) rank[order[i]] = i;
      for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
        if (elev.r_water[r] !== 0) continue;
        r_circulate_r(mesh, r, nbrs);
        let maxRise = -Infinity, upMoist = -Infinity;
        for (const q of nbrs) {
          if (elev.r_water[q] !== 0 || rank[q] < 0 || rank[q] > rank[r]) continue;   // land, upwind only
          const rise = elev.r_elevation[r] - elev.r_elevation[q];
          if (rise > maxRise) maxRise = rise;
          if (climate.r_moisture[q] > upMoist) upMoist = climate.r_moisture[q];
        }
        if (maxRise < 0.15) continue;
        lee++;
        const diff = upMoist - climate.r_moisture[r];
        sumDiff += diff;
        if (diff > 0.1) big++;
      }
    }
    console.log(`[shadow] ${lee} lee cells over ${fitWorlds.length} seeds: mean windward - lee moisture ${(sumDiff / lee).toFixed(3)}, ${(100 * big / lee).toFixed(1)}% differ by > 0.1`);
    expect(lee).toBeGreaterThan(100);
    expect(big / lee).toBeGreaterThan(0.15);
  });
});

describe('rain shadow (synthetic ridge on the real small mesh)', () => {
  // All-land world with a north-south ridge at x = W/2 and high walls along the top and bottom
  // edges (so moisture cannot leak around the ridge from the north/south ring); coastDist is huge
  // so only the carried term matters. With wind from the west the lee (east) band must be much
  // drier than the windward band, and the asymmetry must flip with wind from the east.
  const params = SMALL;
  const mesh = makeMesh(params, 'ridge-seed');
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const poly = new Float32Array(64);
  const r_x = new Float32Array(n);
  const r_y = new Float32Array(n);
  for (let r = 0; r < n; r++) { const p = cellPos(mesh, r, poly); r_x[r] = p[0]; r_y[r] = p[1]; }
  const r_water = new Uint8Array(n);
  for (let r = 0; r < nb; r++) r_water[r] = 1;
  // Ring cells sit at 0.1 too so the coast itself costs no rise.
  const r_elevation = new Float32Array(n).fill(0.1);
  const r_lat = new Float32Array(n).fill(40);
  const r_coastDist = new Float32Array(n).fill(1e4);
  const half = params.width / 2;
  const isHigh = new Uint8Array(n);
  for (let r = nb; r < n; r++) {
    const ridge = Math.abs(r_x[r] - half) < 24;
    const wall = r_y[r] < 24 || r_y[r] > params.height - 24;
    if (ridge || wall) { r_elevation[r] = 0.8; isHigh[r] = 1; }
  }

  /** Mean moisture of the low cells in an x band. */
  function bandMean(m: Float32Array, lo: number, hi: number): number {
    let s = 0, c = 0;
    for (let r = nb; r < n; r++) if (isHigh[r] === 0 && r_x[r] > lo && r_x[r] < hi) { s += m[r]; c++; }
    expect(c).toBeGreaterThan(5);
    return s / c;
  }

  it('the lee side of the ridge is drier, and flips with the wind', () => {
    const west = computeClimate(mesh, { ...params, windDir: 0 }, { r_elevation, r_water, r_coastDist, r_lat }, fork('x', 'climate'));
    const east = computeClimate(mesh, { ...params, windDir: 4 }, { r_elevation, r_water, r_coastDist, r_lat }, fork('x', 'climate'));
    const windwardW = bandMean(west.r_moisture, half - 90, half - 30);
    const leeW = bandMean(west.r_moisture, half + 30, half + 90);
    const windwardE = bandMean(east.r_moisture, half + 30, half + 90);
    const leeE = bandMean(east.r_moisture, half - 90, half - 30);
    // Windward: carried decays only by 0.985 per hop from the west ring, so the band is wet;
    // lee: climbing 0.7 (0.66 after the 0.04 allowance) costs 1.65, far more than the whole
    // carried budget, so it sits at the floor.
    expect(windwardW).toBeGreaterThan(0.4);
    expect(windwardE).toBeGreaterThan(0.4);
    expect(leeW).toBeLessThan(windwardW * 0.25);
    expect(leeE).toBeLessThan(windwardE * 0.25);
    let ridgeMax = 0;
    for (let r = nb; r < n; r++) {
      if (Math.abs(r_x[r] - half) < 24 && r_elevation[r] === 0.8 && west.r_moisture[r] > ridgeMax) ridgeMax = west.r_moisture[r];
    }
    expect(ridgeMax).toBeLessThan(windwardW);
  });

  it('a rise within the allowance costs nothing, a rise beyond it costs 2.5 per unit', () => {
    // Flat interior at 0.1 with a single one-hop step: cells east of x = W/2 sit at 0.1 + step.
    // The carried value across the step is m * 0.985 - 2.5 * max(0, step - 0.04); measured on the
    // band means, a 0.03 step must be invisible and a 0.14 step must cost ~0.25 of carried.
    const e = new Float32Array(n).fill(0.1);
    for (let r = nb; r < n; r++) if (r_y[r] < 24 || r_y[r] > params.height - 24) e[r] = 0.8;
    const run = (step: number): Float32Array => {
      const el = e.slice();
      for (let r = nb; r < n; r++) if (el[r] < 0.5 && r_x[r] > half) el[r] = 0.1 + step;
      return computeClimate(mesh, { ...params, windDir: 0 }, { r_elevation: el, r_water, r_coastDist, r_lat }, fork('x', 'climate')).r_moisture;
    };
    const flat = run(0), gentle = run(0.03), steep = run(0.14);
    const lo = half + 8, hi = half + 60;
    const flatMean = bandMean(flat, lo, hi), gentleMean = bandMean(gentle, lo, hi), steepMean = bandMean(steep, lo, hi);
    expect(Math.abs(gentleMean - flatMean)).toBeLessThan(1e-6);
    // 0.7 * 2.5 * (0.14 - 0.04) = 0.175 less output moisture, spread over the band (the cells
    // right behind the step carry the full deficit; it never recovers since carried only decays).
    expect(flatMean - steepMean).toBeGreaterThan(0.12);
    expect(flatMean - steepMean).toBeLessThan(0.20);
  });
});

describe('BIOME_COLORS and BIOME_FERTILITY', () => {
  it('cover every biome with a css hex color and a fertility in 0..1', () => {
    for (const b of BIOMES) {
      expect(BIOME_COLORS[b]).toMatch(/^#[0-9a-f]{6}$/);
      expect(BIOME_FERTILITY[b]).toBeGreaterThanOrEqual(0);
      expect(BIOME_FERTILITY[b]).toBeLessThanOrEqual(1);
    }
    expect(BIOME_FERTILITY.ocean).toBe(0);
    expect(BIOME_FERTILITY.deciduousForest).toBeGreaterThan(0.7);
    expect(BIOME_FERTILITY.grassland).toBeGreaterThan(0.7);
    expect(BIOME_FERTILITY.subtropicalDesert).toBeLessThan(0.15);
    expect(BIOME_FERTILITY.snow).toBeLessThan(0.1);
    expect(BIOME_FERTILITY.marsh).toBeGreaterThan(0.3);
    expect(BIOME_FERTILITY.marsh).toBeLessThan(0.7);
  });
});

describe('timings', () => {
  it('prints stage 6 and 8 timings (budgets: 5 ms and 2 ms at defaults)', () => {
    for (const w of [...worlds, ...fitWorlds]) {
      console.log(`[climate] ${w.label}: ${w.mesh.numRegions} cells, stage 6 ${w.msClimate.toFixed(1)} ms, stage 8 ${w.msBiomes.toFixed(1)} ms`);
    }
    expect(worlds[0].msClimate).toBeLessThan(200);
  });
});
