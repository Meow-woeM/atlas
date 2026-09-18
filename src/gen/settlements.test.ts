/**
 * gen/settlements.test.ts — stage 10 against real upstream data (points -> mesh -> noisy edges ->
 * elevation -> distance field -> climate -> hydrology -> biomes -> provinces) assembled into a full
 * Geography, at DEFAULT_PARAMS and at a small 400x300 / spacing-16 / provinceSpacing-40 world.
 * Worlds are built once at module load; per-element invariants are counted in plain loops and
 * asserted once. hydro.revertedCells still carry a negative r_elevation here (world.ts lifts them
 * later), which is exactly the input scoreCell must tolerate.
 *
 * The last describe re-measures the 2026-09-17 retune targets over the four seeds the weights were
 * tuned on (atlas, amberfell, test-1, zzzzzzzz at DEFAULT_PARAMS) with loose bounds: 32-40
 * settlements, 25-55% ports on average, >= 30% inland, 35-70% river-side, cities more than 6 land
 * hops apart, and 5-8 nations out of the real foundNations (politics.ts is imported for that one
 * check only).
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { BIOMES, DEFAULT_PARAMS } from '../core/types';
import type { Geography, Mesh, NoisyEdges, Province, ProvinceGraph, Settlement, WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, r_circulate_r, r_circulate_s, s_end_r, s_inner_t, s_outer_t, t_circulate_r } from '../mesh/dualmesh';
import { buildNoisyEdges } from '../mesh/noisy';
import { computeElevation, computeDistanceField } from './elevation';
import { computeClimate, computeBiomes, BIOME_FERTILITY } from './climate';
import { computeHydrology } from './hydrology';
import { computeProvinces } from './provinces';
import { placeSettlements, scoreCell } from './settlements';
import { foundNations } from './politics';

const SEED = 'atlas-10';
const SMALL: WorldParams = {
  ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16, provinceSpacing: 40,
};
const BASE_POPULATION = { city: 20000, town: 4000, village: 600 } as const;
/** Stage-10 constants mirrored here (settlements.ts file comment). */
const CELLS_PER_SETTLEMENT = 90;
const MIN_LANDMASS_CELLS = 20;
const SUPPRESS_STRENGTH = 2.5;
const NOISE = 0.2;
/** The seeds the weights were retuned on. */
const TUNING_SEEDS = ['atlas', 'amberfell', 'test-1', 'zzzzzzzz'];

interface Built {
  label: string;
  params: WorldParams;
  mesh: Mesh;
  edges: NoisyEdges;
  geo: Geography;
  provinces: Province[];
  graph: ProvinceGraph;
  r_province: Int16Array;
  settlements: Settlement[];
  r_settlement: Int16Array;
  ms: number;
  numLand: number;
  landmassSize: Int32Array;   // per cell: size of its land component, 0 on water
  // Snapshots taken before placeSettlements ran, to prove the inputs were left alone.
  elevBefore: Float32Array;
  waterBefore: Uint8Array;
  provinceBefore: Int16Array;
}

function buildGeography(params: WorldParams, seed: string): { mesh: Mesh; edges: NoisyEdges; geo: Geography } {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  const mesh = buildMesh(points, numBoundary);
  const edges = buildNoisyEdges(mesh, fork(seed, 'edges'));
  const elev = computeElevation(mesh, params, fork(seed, 'elevation'));
  const { distField, r_coastDist } = computeDistanceField(mesh, params, elev.r_water);
  const climate = computeClimate(
    mesh, params,
    { r_elevation: elev.r_elevation, r_water: elev.r_water, r_coastDist, r_lat: elev.r_lat },
    fork(seed, 'climate'),
  );
  const hydro = computeHydrology(mesh, params, elev.r_elevation, elev.r_water, climate.r_moisture);
  const r_biome = computeBiomes(mesh, {
    r_water: hydro.r_water, r_elevation: elev.r_elevation, r_temperature: climate.r_temperature,
    r_moisture: climate.r_moisture, r_coastDist, s_river: hydro.s_river, t_lake: hydro.t_lake,
  });
  const geo: Geography = {
    r_elevation: elev.r_elevation, r_water: hydro.r_water, r_coastHops: elev.r_coastHops,
    r_coastDist, r_lat: elev.r_lat, r_lon: elev.r_lon,
    r_temperature: climate.r_temperature, r_moisture: climate.r_moisture, r_biome,
    r_slope: elev.r_slope,
    t_elevation: hydro.t_elevation, t_downslope_s: hydro.t_downslope_s, t_flux: hydro.t_flux,
    t_lake: hydro.t_lake, s_river: hydro.s_river, s_riverId: hydro.s_riverId,
    windDir: climate.windDir, distField,
  };
  return { mesh, edges, geo };
}

/** Size of every cell's land component (BFS over r_circulate_r on land cells), 0 on water. */
function landmassSizes(mesh: Mesh, geo: Geography): Int32Array {
  const nr = mesh.numRegions;
  const size = new Int32Array(nr);
  const seen = new Uint8Array(nr);
  const nbrs: number[] = [];
  for (let r0 = 0; r0 < nr; r0++) {
    if (geo.r_water[r0] !== 0 || seen[r0]) continue;
    const queue: number[] = [r0];
    seen[r0] = 1;
    for (let head = 0; head < queue.length; head++) {
      r_circulate_r(mesh, queue[head], nbrs);
      for (const v of nbrs) {
        if (geo.r_water[v] !== 0 || seen[v]) continue;
        seen[v] = 1;
        queue.push(v);
      }
    }
    for (const r of queue) size[r] = queue.length;
  }
  return size;
}

function build(label: string, params: WorldParams, seed: string): Built {
  const { mesh, edges, geo } = buildGeography(params, seed);
  const { provinces, r_province, graph } = computeProvinces(mesh, edges, params, geo, fork(seed, 'provinces'));
  const elevBefore = geo.r_elevation.slice();
  const waterBefore = geo.r_water.slice();
  const provinceBefore = r_province.slice();
  const t0 = performance.now();
  const { settlements, r_settlement } = placeSettlements(mesh, params, geo, provinces, r_province, fork(seed, 'settlements'));
  const ms = performance.now() - t0;
  let numLand = 0;
  for (let r = 0; r < mesh.numRegions; r++) if (geo.r_water[r] === 0) numLand++;
  return {
    label, params, mesh, edges, geo, provinces, graph, r_province, settlements, r_settlement, ms, numLand,
    landmassSize: landmassSizes(mesh, geo),
    elevBefore, waterBefore, provinceBefore,
  };
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Independent re-derivation of the stage-10 score formula (2026-09-17 weights) from the mesh and geography. */
function referenceScore(mesh: Mesh, geo: Geography, r: number): number {
  if (geo.r_water[r] !== 0) return -Infinity;
  const nbrs: number[] = [];
  const sides: number[] = [];
  const tri: number[] = [];
  r_circulate_r(mesh, r, nbrs);
  let ocean = 0, oceanDist = 0;
  for (const v of nbrs) if (geo.r_water[v] === 1) { ocean++; oceanDist += geo.r_coastDist[v]; }
  r_circulate_s(mesh, r, sides);
  let riverSide = 0, riverMouth = 0;
  const oceanCorner = (t: number): boolean => {
    if (t < 0) return false;
    t_circulate_r(mesh, t, tri);
    return tri.some((c) => geo.r_water[c] === 1);
  };
  for (const s of sides) {
    if (geo.s_river[s] > 0) {
      riverSide = 1;
      if (oceanCorner(s_outer_t(mesh, s)) || oceanCorner(s_inner_t(s))) riverMouth = 1;
    }
  }
  const coast = ocean > 0 ? 1 : 0;
  const harbor = ocean >= 1 && ocean <= 3 && oceanDist / ocean > -12 ? 1 : 0;
  const elevation = Math.max(0, geo.r_elevation[r]);
  return 2.0 * BIOME_FERTILITY[BIOMES[geo.r_biome[r]]] + 0.05 * coast + 0.5 * riverSide + 0.3 * riverMouth +
    0.05 * harbor - elevation - 1.5 * geo.r_slope[r];
}

/** BFS hop depth over land cells from `start`, capped at maxDepth; -1 where unreached. */
function landDepths(mesh: Mesh, geo: Geography, start: number, maxDepth: number): Int32Array {
  const depth = new Int32Array(mesh.numRegions).fill(-1);
  const queue: number[] = [start];
  const nbrs: number[] = [];
  depth[start] = 0;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    if (depth[u] >= maxDepth) continue;
    r_circulate_r(mesh, u, nbrs);
    for (const v of nbrs) {
      if (geo.r_water[v] !== 0 || depth[v] >= 0) continue;
      depth[v] = depth[u] + 1;
      queue.push(v);
    }
  }
  return depth;
}

/** Smallest land-hop distance between any two cities (Infinity when no pair is connected). */
function minCityHops(w: Built): number {
  const cities = w.settlements.filter((s) => s.kind === 'city');
  let best = Infinity;
  for (let i = 0; i < cities.length; i++) {
    const d = landDepths(w.mesh, w.geo, cities[i].r, 40);
    for (let j = i + 1; j < cities.length; j++) {
      const h = d[cities[j].r];
      if (h >= 0 && h < best) best = h;
    }
  }
  return best;
}

const worlds: Built[] = [
  build('default', DEFAULT_PARAMS, SEED),
  build('small', SMALL, SEED),
];

for (const w of worlds) {
  describe(`settlements (${w.label})`, () => {
    const { mesh, geo, provinces, r_province, settlements, r_settlement, landmassSize } = w;
    const nr = mesh.numRegions;
    const m = settlements.length;
    const target = Math.min(Math.max(Math.round(w.numLand / CELLS_PER_SETTLEMENT), 15), w.params.settlementsMax);

    it('reports count and timing', () => {
      const cities = settlements.filter((s) => s.kind === 'city').length;
      const towns = settlements.filter((s) => s.kind === 'town').length;
      const ports = settlements.filter((s) => s.port).length;
      const mouths = settlements.filter((s) => s.riverMouth).length;
      const rivers = settlements.filter((s) => s.river >= 0).length;
      console.log(
        `settlements (${w.label}): ${m} placed of target ${target} over ${w.numLand} land cells ` +
        `(${cities} cities, ${towns} towns, ${m - cities - towns} villages; ${ports} ports, ` +
        `${mouths} river mouths, ${rivers} on rivers), ${w.ms.toFixed(2)} ms`,
      );
      expect(r_settlement.length).toBe(nr);
    });

    it('places every settlement on a distinct land cell with ids in array order', () => {
      let water = 0, badId = 0, dup = 0;
      const seen = new Uint8Array(nr);
      for (let i = 0; i < m; i++) {
        const s = settlements[i];
        if (s.id !== i) badId++;
        if (geo.r_water[s.r] !== 0) water++;
        if (seen[s.r]) dup++;
        seen[s.r] = 1;
      }
      expect(water).toBe(0);
      expect(badId).toBe(0);
      expect(dup).toBe(0);
    });

    it('places a count within [15, settlementsMax] at the defaults and never above the cap', () => {
      expect(m).toBeLessThanOrEqual(w.params.settlementsMax);
      expect(m).toBeLessThanOrEqual(target);
      if (w.label === 'default') {
        expect(m).toBeGreaterThanOrEqual(15);
        expect(m).toBe(target);
      } else {
        expect(m).toBeGreaterThanOrEqual(1);
      }
    });

    it('never settles a landmass smaller than 20 cells', () => {
      let islet = 0;
      for (let i = 0; i < m; i++) if (landmassSize[settlements[i].r] < MIN_LANDMASS_CELLS) islet++;
      expect(islet).toBe(0);
    });

    it('assigns kinds by rank with at least one city', () => {
      const expectedCities = Math.max(1, Math.round(0.2 * m));
      const expectedTowns = Math.min(Math.round(0.35 * m), m - expectedCities);
      let cities = 0, towns = 0, villages = 0, outOfOrder = 0;
      const rank = { city: 0, town: 1, village: 2 } as const;
      for (let i = 0; i < m; i++) {
        const k = settlements[i].kind;
        if (k === 'city') cities++;
        else if (k === 'town') towns++;
        else villages++;
        if (i > 0 && rank[k] < rank[settlements[i - 1].kind]) outOfOrder++;
      }
      expect(cities).toBe(expectedCities);
      expect(towns).toBe(expectedTowns);
      expect(villages).toBe(m - expectedCities - expectedTowns);
      expect(cities).toBeGreaterThanOrEqual(1);
      expect(outOfOrder).toBe(0);
    });

    it('picks first a cell within the noise amplitude of the best deterministic eligible score', () => {
      // No suppression has happened before the first pick, so it maximizes scoreCell + 0.2 u over
      // the eligible cells (land on a landmass of >= 20 cells): its deterministic score is at most
      // 0.2 below the eligible maximum.
      let best = -Infinity;
      for (let r = 0; r < nr; r++) {
        if (landmassSize[r] < MIN_LANDMASS_CELLS) continue;
        const sc = scoreCell(mesh, geo, r);
        if (sc > best) best = sc;
      }
      const first = scoreCell(mesh, geo, settlements[0].r);
      expect(first).toBeGreaterThan(0);
      expect(best - first).toBeLessThanOrEqual(NOISE + 1e-6);
      // Every placed cell had a positive working score when picked, and its deterministic
      // score sits above the total suppression it could have absorbed from earlier picks.
      let nonPositive = 0;
      for (let i = 0; i < m; i++) {
        if (!(scoreCell(mesh, geo, settlements[i].r) + NOISE + SUPPRESS_STRENGTH * i > 0)) nonPositive++;
      }
      expect(nonPositive).toBe(0);
    });

    it('sets population from the kind base with the 0.7..1.3 jitter', () => {
      let bad = 0;
      for (let i = 0; i < m; i++) {
        const s = settlements[i];
        const base = BASE_POPULATION[s.kind];
        if (!Number.isInteger(s.population) || s.population < Math.round(0.7 * base) || s.population > Math.round(1.3 * base)) bad++;
      }
      expect(bad).toBe(0);
    });

    it('sets port, riverMouth and river consistently with the mesh', () => {
      const sides: number[] = [];
      const tri: number[] = [];
      let badPort = 0, badMouth = 0, badRiver = 0;
      const oceanCorner = (t: number): boolean => {
        if (t < 0) return false;
        t_circulate_r(mesh, t, tri);
        return tri.some((c) => geo.r_water[c] === 1);
      };
      for (let i = 0; i < m; i++) {
        const s = settlements[i];
        r_circulate_s(mesh, s.r, sides);
        let port = false, mouth = false;
        let bestFlux = 0, bestSide = -1, river = -1;
        for (const side of sides) {
          if (geo.r_water[s_end_r(mesh, side)] === 1) port = true;
          const f = geo.s_river[side];
          if (f > 0) {
            if (f > bestFlux || (f === bestFlux && side < bestSide)) { bestFlux = f; bestSide = side; river = geo.s_riverId[side]; }
            if (oceanCorner(s_outer_t(mesh, side)) || oceanCorner(s_inner_t(side))) mouth = true;
          }
        }
        if (s.port !== port) badPort++;
        if (s.riverMouth !== mouth) badMouth++;
        if (s.river !== river) badRiver++;
        if (s.riverMouth && !s.port) badMouth++;      // a river mouth cell touches the ocean cell at the mouth corner
      }
      expect(badPort).toBe(0);
      expect(badMouth).toBe(0);
      expect(badRiver).toBe(0);
    });

    it('fills province, culture -1, founded 0, died -1 and an empty name', () => {
      let bad = 0;
      for (let i = 0; i < m; i++) {
        const s = settlements[i];
        if (s.province !== r_province[s.r] || s.province < 0) bad++;
        if (s.culture !== -1 || s.founded !== 0 || s.died !== -1 || s.name !== '') bad++;
      }
      expect(bad).toBe(0);
    });

    it('makes every province seat its best settlement and leaves empty provinces at -1', () => {
      const best = new Int32Array(provinces.length).fill(-1);
      for (let i = 0; i < m; i++) {
        const p = settlements[i].province;
        if (best[p] < 0 || scoreCell(mesh, geo, settlements[i].r) > scoreCell(mesh, geo, settlements[best[p]].r)) best[p] = i;
      }
      let bad = 0, seated = 0;
      for (let p = 0; p < provinces.length; p++) {
        const seat = provinces[p].seat;
        if (seat !== best[p]) bad++;
        if (seat >= 0) {
          seated++;
          if (settlements[seat].province !== p) bad++;
        }
      }
      expect(bad).toBe(0);
      expect(seated).toBeGreaterThan(0);
      expect(seated).toBeLessThanOrEqual(m);
    });

    it('mirrors settlements in r_settlement and nowhere else', () => {
      let bad = 0, count = 0;
      for (let r = 0; r < nr; r++) {
        const i = r_settlement[r];
        if (i < 0) continue;
        count++;
        if (i >= m || settlements[i].r !== r) bad++;
      }
      expect(bad).toBe(0);
      expect(count).toBe(m);
    });

    it('scoreCell matches the stage-10 formula on every cell and is -Infinity on water', () => {
      let mismatch = 0, waterFinite = 0, landInfinite = 0, positive = 0;
      for (let r = 0; r < nr; r++) {
        const sc = scoreCell(mesh, geo, r);
        if (geo.r_water[r] !== 0) {
          if (sc !== -Infinity) waterFinite++;
          continue;
        }
        if (!Number.isFinite(sc)) landInfinite++;
        if (sc > 0) positive++;
        if (Math.abs(sc - referenceScore(mesh, geo, r)) > 1e-6) mismatch++;
      }
      expect(mismatch).toBe(0);
      expect(waterFinite).toBe(0);
      expect(landInfinite).toBe(0);
      expect(positive).toBeGreaterThan(m);
    });

    it('leaves geography and r_province untouched', () => {
      expect(sameBytes(geo.r_elevation, w.elevBefore)).toBe(true);
      expect(sameBytes(geo.r_water, w.waterBefore)).toBe(true);
      expect(sameBytes(r_province, w.provinceBefore)).toBe(true);
    });

    it('is deterministic for the same seed and inputs', () => {
      const seatsBefore = provinces.map((p) => p.seat);
      const again = placeSettlements(mesh, w.params, geo, provinces, r_province, fork(SEED, 'settlements'));
      expect(JSON.stringify(again.settlements)).toBe(JSON.stringify(settlements));
      expect(sameBytes(again.r_settlement, r_settlement)).toBe(true);
      expect(provinces.map((p) => p.seat)).toEqual(seatsBefore);
    });
  });
}

describe('settlements (seeds)', () => {
  it('changes placement with the seed but keeps the cap', () => {
    const w = worlds[1];
    const other = placeSettlements(w.mesh, w.params, w.geo, w.provinces, w.r_province, fork('another-seed', 'settlements'));
    expect(other.settlements.length).toBeLessThanOrEqual(w.params.settlementsMax);
    let same = 0;
    for (let i = 0; i < Math.min(other.settlements.length, w.settlements.length); i++) {
      if (other.settlements[i].population === w.settlements[i].population) same++;
    }
    expect(same).toBeLessThan(Math.min(other.settlements.length, w.settlements.length));
    // Restore the seats the module-level world expects (placeSettlements refills them).
    placeSettlements(w.mesh, w.params, w.geo, w.provinces, w.r_province, fork(SEED, 'settlements'));
  });
});

describe('settlements (2026-09-17 retune targets over four seeds at DEFAULT_PARAMS)', () => {
  const tuned = TUNING_SEEDS.map((seed) => build(seed, DEFAULT_PARAMS, seed));
  const nationsOf = tuned.map((w) => {
    const { politics } = foundNations(
      w.mesh, w.params, w.geo, w.provinces, w.graph, w.r_province, w.settlements, w.r_settlement, fork(w.label, 'politics'),
    );
    return politics.nations.length;
  });
  const shares = tuned.map((w) => {
    const m = w.settlements.length;
    let ports = 0, river = 0;
    for (const s of w.settlements) { if (s.port) ports++; if (s.river >= 0) river++; }
    return { m, ports: ports / m, inland: (m - ports) / m, river: river / m, cityHops: minCityHops(w) };
  });

  it('reports the measured numbers per seed', () => {
    for (let i = 0; i < tuned.length; i++) {
      const x = shares[i];
      console.log(
        `settlements (${tuned[i].label}): ${x.m} settlements, ${(100 * x.ports).toFixed(0)}% ports, ` +
        `${(100 * x.inland).toFixed(0)}% inland, ${(100 * x.river).toFixed(0)}% river-side, ` +
        `cities >= ${x.cityHops} hops apart, ${nationsOf[i]} nations`,
      );
    }
    expect(tuned.length).toBe(4);
  });

  it('places 32-40 settlements on every seed', () => {
    let outside = 0;
    for (const x of shares) if (x.m < 32 || x.m > 40) outside++;
    expect(outside).toBe(0);
  });

  it('makes 25-55% of them ports on average (20-65% on any seed)', () => {
    let sum = 0, outside = 0;
    for (const x of shares) { sum += x.ports; if (x.ports < 0.2 || x.ports > 0.65) outside++; }
    expect(outside).toBe(0);
    expect(sum / shares.length).toBeGreaterThanOrEqual(0.25);
    expect(sum / shares.length).toBeLessThanOrEqual(0.55);
  });

  it('keeps at least 30% inland (no ocean neighbour) on every seed', () => {
    let low = 0;
    for (const x of shares) if (x.inland < 0.3) low++;
    expect(low).toBe(0);
  });

  it('puts 35-70% on a river on average (30-75% on any seed)', () => {
    let sum = 0, outside = 0;
    for (const x of shares) { sum += x.river; if (x.river < 0.3 || x.river > 0.75) outside++; }
    expect(outside).toBe(0);
    expect(sum / shares.length).toBeGreaterThanOrEqual(0.35);
    expect(sum / shares.length).toBeLessThanOrEqual(0.7);
  });

  it('spreads the cities: no two within 6 land hops', () => {
    let close = 0;
    for (const x of shares) if (x.cityHops <= 6) close++;
    expect(close).toBe(0);
  });

  it('yields 5-8 nations from foundNations on every seed', () => {
    let outside = 0;
    for (const n of nationsOf) if (n < 5 || n > 8) outside++;
    expect(outside).toBe(0);
  });
});
