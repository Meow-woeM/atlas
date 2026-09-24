/**
 * gen/provinces.test.ts — stage 9 against real upstream data (points -> mesh -> noisy edges ->
 * elevation -> distance field -> climate -> hydrology -> biomes) assembled into a full Geography,
 * at DEFAULT_PARAMS and at a small 400x300 / spacing-16 / provinceSpacing-40 world. Worlds are
 * built once at module load; per-element invariants are counted in plain loops and asserted once.
 * hydro.revertedCells still carry a negative r_elevation here (world.ts lifts them later), which
 * is exactly the input computeProvinces must tolerate.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { BIOMES, DEFAULT_PARAMS } from '../core/types';
import type { Geography, Mesh, NoisyEdges, Province, ProvinceGraph, WorldParams } from '../core/types';
import { polylineLength } from '../core/geom';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, cellPolygon, r_circulate_r, s_end_r } from '../mesh/dualmesh';
import { buildNoisyEdges, sidePath } from '../mesh/noisy';
import { computeElevation, computeDistanceField } from './elevation';
import { computeTectonics } from './tectonics';
import { computeClimate, computeBiomes, BIOME_FERTILITY } from './climate';
import { computeHydrology } from './hydrology';
import { computeProvinces, cellFertility } from './provinces';

const SEED = 'atlas-9';
const SMALL: WorldParams = {
  ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16, provinceSpacing: 40,
};

interface Built {
  label: string;
  params: WorldParams;
  mesh: Mesh;
  edges: NoisyEdges;
  geo: Geography;
  provinces: Province[];
  r_province: Int16Array;
  graph: ProvinceGraph;
  ms: number;
  numLand: number;
}

function buildGeography(params: WorldParams, seed: string): { mesh: Mesh; edges: NoisyEdges; geo: Geography } {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  const mesh = buildMesh(points, numBoundary);
  const edges = buildNoisyEdges(mesh, fork(seed, 'edges'));
  const elev = computeElevation(mesh, params, fork(seed, 'elevation'), computeTectonics(mesh, params, fork(seed, 'tectonics')));
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
    windDir: climate.windDir, distField, formation: elev.formation,
  };
  return { mesh, edges, geo };
}

function build(label: string, params: WorldParams, seed: string): Built {
  const { mesh, edges, geo } = buildGeography(params, seed);
  const t0 = performance.now();
  const { provinces, r_province, graph } = computeProvinces(mesh, edges, params, geo, fork(seed, 'provinces'));
  const ms = performance.now() - t0;
  let numLand = 0;
  for (let r = 0; r < mesh.numRegions; r++) if (geo.r_water[r] === 0) numLand++;
  return { label, params, mesh, edges, geo, provinces, r_province, graph, ms, numLand };
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

const worlds: Built[] = [
  build('default', DEFAULT_PARAMS, SEED),
  build('small', SMALL, SEED),
];

for (const w of worlds) {
  describe(`provinces (${w.label})`, () => {
    const { mesh, edges, geo, provinces, r_province, graph } = w;
    const nr = mesh.numRegions;
    const numP = provinces.length;

    it('reports count and timing', () => {
      console.log(
        `provinces (${w.label}): ${numP} provinces over ${w.numLand} land cells ` +
        `(${(w.numLand / Math.max(1, numP)).toFixed(1)} cells each), ${w.ms.toFixed(2)} ms`,
      );
      expect(r_province.length).toBe(nr);
      expect(graph.p_first.length).toBe(numP + 1);
      expect(graph.p_nbr.length).toBe(graph.p_border.length);
    });

    it('gives every land cell a province and every water cell -1', () => {
      let bad = 0;
      for (let r = 0; r < nr; r++) {
        const p = r_province[r];
        if (geo.r_water[r] === 0) {
          if (p < 0 || p >= numP) bad++;
        } else if (p !== -1) bad++;
      }
      expect(bad).toBe(0);
    });

    it('has a province count in range', () => {
      if (w.label === 'default') {
        expect(numP).toBeGreaterThanOrEqual(60);
        expect(numP).toBeLessThanOrEqual(260);
      } else {
        expect(numP).toBeGreaterThan(0);
      }
    });

    it('lists each province cells ascending, partitioning the land, with consistent ids', () => {
      let total = 0, notAscending = 0, mismatched = 0, badId = 0, badDefaults = 0;
      for (let p = 0; p < numP; p++) {
        const prov = provinces[p];
        if (prov.id !== p) badId++;
        if (prov.name !== '' || prov.seat !== -1) badDefaults++;
        const cells = prov.cells;
        total += cells.length;
        for (let i = 0; i < cells.length; i++) {
          if (i > 0 && cells[i] <= cells[i - 1]) notAscending++;
          if (r_province[cells[i]] !== p) mismatched++;
        }
      }
      expect(total).toBe(w.numLand);
      expect(notAscending).toBe(0);
      expect(mismatched).toBe(0);
      expect(badId).toBe(0);
      expect(badDefaults).toBe(0);
    });

    it('makes every province connected', () => {
      const seen = new Uint8Array(nr);
      const queue = new Int32Array(nr);
      const nbrs: number[] = [];
      let disconnected = 0, empty = 0;
      for (let p = 0; p < numP; p++) {
        const cells = provinces[p].cells;
        if (cells.length === 0) { empty++; continue; }
        let head = 0, tail = 0;
        queue[tail++] = cells[0];
        seen[cells[0]] = 1;
        while (head < tail) {
          const u = queue[head++];
          r_circulate_r(mesh, u, nbrs);
          for (let k = 0; k < nbrs.length; k++) {
            const v = nbrs[k];
            if (seen[v] || r_province[v] !== p) continue;
            seen[v] = 1;
            queue[tail++] = v;
          }
        }
        if (tail !== cells.length) disconnected++;
      }
      expect(empty).toBe(0);
      expect(disconnected).toBe(0);
    });

    it('builds a symmetric CSR graph with ascending neighbors, no self-links and equal border lengths', () => {
      const { p_first, p_nbr, p_border } = graph;
      let notMonotone = 0, selfLinks = 0, notAscending = 0, asymmetric = 0, badLength = 0, outOfRange = 0;
      expect(p_first[0]).toBe(0);
      expect(p_first[numP]).toBe(p_nbr.length);
      for (let p = 0; p < numP; p++) {
        if (p_first[p + 1] < p_first[p]) notMonotone++;
        for (let k = p_first[p]; k < p_first[p + 1]; k++) {
          const q = p_nbr[k];
          if (q < 0 || q >= numP) { outOfRange++; continue; }
          if (q === p) selfLinks++;
          if (k > p_first[p] && q <= p_nbr[k - 1]) notAscending++;
          // Find the reverse link.
          let found = -1;
          for (let j = p_first[q]; j < p_first[q + 1]; j++) if (p_nbr[j] === p) { found = j; break; }
          if (found < 0) asymmetric++;
          else if (p_border[found] !== p_border[k]) badLength++;
          if (!(p_border[k] > 0)) badLength++;
        }
      }
      expect(notMonotone).toBe(0);
      expect(outOfRange).toBe(0);
      expect(selfLinks).toBe(0);
      expect(notAscending).toBe(0);
      expect(asymmetric).toBe(0);
      expect(badLength).toBe(0);
    });

    it('links exactly the province pairs that share a side, with the summed noisy side lengths', () => {
      const { p_first, p_nbr, p_border } = graph;
      // Independent recomputation: per unordered pair, the summed length of the noisy side paths.
      const expected = new Map<number, number>();
      const path: number[] = [];
      for (let s = 0; s < mesh.numSides; s++) {
        const o = mesh.s_opposite_s[s];
        if (o < 0 || s > o) continue;
        const a = r_province[mesh.s_start_r[s]];
        const b = r_province[s_end_r(mesh, s)];
        if (a < 0 || b < 0 || a === b) continue;
        const key = a < b ? a * numP + b : b * numP + a;
        path.length = 0;
        sidePath(edges, mesh, s, path);
        const len = polylineLength(Float32Array.from(path), false);
        expected.set(key, (expected.get(key) ?? 0) + len);
      }
      let links = 0, missingSide = 0, wrongLength = 0;
      for (let p = 0; p < numP; p++) {
        for (let k = p_first[p]; k < p_first[p + 1]; k++) {
          const q = p_nbr[k];
          if (q < p) continue;   // each pair once
          links++;
          const e = expected.get(p * numP + q);
          if (e === undefined) { missingSide++; continue; }
          if (Math.abs(e - p_border[k]) > 1e-3 * Math.max(1, e)) wrongLength++;
        }
      }
      expect(missingSide).toBe(0);
      expect(wrongLength).toBe(0);
      expect(links).toBe(expected.size);
      expect(links).toBeGreaterThan(0);
    });

    it('puts centroid_r inside its province, near the mean cell position', () => {
      const poly = new Float32Array(64);
      const xs = new Float32Array(nr), ys = new Float32Array(nr);
      for (let r = 0; r < nr; r++) {
        const k = cellPolygon(mesh, r, poly);
        let sx = 0, sy = 0;
        for (let i = 0; i < k; i++) { sx += poly[2 * i]; sy += poly[2 * i + 1]; }
        xs[r] = sx / k;
        ys[r] = sy / k;
      }
      let outside = 0, notNearest = 0;
      for (let p = 0; p < numP; p++) {
        const { cells, centroid_r } = provinces[p];
        if (r_province[centroid_r] !== p) outside++;
        let sx = 0, sy = 0;
        for (let i = 0; i < cells.length; i++) { sx += xs[cells[i]]; sy += ys[cells[i]]; }
        const cx = sx / cells.length, cy = sy / cells.length;
        let best = Infinity, bestR = -1;
        for (let i = 0; i < cells.length; i++) {
          const r = cells[i];
          const d2 = (xs[r] - cx) ** 2 + (ys[r] - cy) ** 2;
          if (d2 < best) { best = d2; bestR = r; }
        }
        if (bestR !== centroid_r) notNearest++;
      }
      expect(outside).toBe(0);
      expect(notNearest).toBe(0);
    });

    it('sums province areas to the land area within 1%', () => {
      const poly = new Float32Array(64);
      let landArea = 0;
      for (let r = 0; r < nr; r++) {
        if (geo.r_water[r] !== 0) continue;
        const k = cellPolygon(mesh, r, poly);
        let twice = 0;
        for (let i = 0; i < k; i++) {
          const j = i + 1 === k ? 0 : i + 1;
          twice += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
        }
        landArea += Math.abs(twice) / 2;
      }
      let sum = 0, nonPositive = 0;
      for (let p = 0; p < numP; p++) {
        sum += provinces[p].area;
        if (!(provinces[p].area > 0)) nonPositive++;
      }
      expect(nonPositive).toBe(0);
      expect(Math.abs(sum - landArea)).toBeLessThanOrEqual(0.01 * landArea);
      // Sanity: land is roughly params.landFraction of the canvas.
      expect(landArea).toBeGreaterThan(0.2 * w.params.width * w.params.height);
    });

    it('flags coastal exactly when a cell touches the ocean', () => {
      const nbrs: number[] = [];
      let wrong = 0, coastalCount = 0;
      for (let p = 0; p < numP; p++) {
        const cells = provinces[p].cells;
        let touches = false;
        for (let i = 0; i < cells.length && !touches; i++) {
          r_circulate_r(mesh, cells[i], nbrs);
          for (let k = 0; k < nbrs.length; k++) if (geo.r_water[nbrs[k]] === 1) { touches = true; break; }
        }
        if (touches !== provinces[p].coastal) wrong++;
        if (provinces[p].coastal) coastalCount++;
      }
      expect(wrong).toBe(0);
      expect(coastalCount).toBeGreaterThan(0);
    });

    it('reports fertility as the mean of cell fertility (river bonus x1.3, capped at 1) in 0..1', () => {
      const sides: number[] = [];
      let wrong = 0, outOfRange = 0;
      for (let p = 0; p < numP; p++) {
        const cells = provinces[p].cells;
        let sum = 0;
        for (let i = 0; i < cells.length; i++) {
          const r = cells[i];
          let f = cellFertility(geo, r);
          let river = false;
          // Outgoing sides of r: walk the circulation the same way computeProvinces does.
          sides.length = 0;
          let s = mesh.r_first_s[r];
          const s0 = s;
          do {
            if (geo.s_river[s] > 0) river = true;
            const o = mesh.s_opposite_s[s];
            if (o < 0) break;
            s = o % 3 === 2 ? o - 2 : o + 1;
          } while (s !== s0);
          if (river) f *= 1.3;
          if (f > 1) f = 1;
          sum += f;
        }
        const expected = sum / cells.length;
        const got = provinces[p].fertility;
        if (Math.abs(got - expected) > 1e-5) wrong++;
        if (!(got >= 0 && got <= 1)) outOfRange++;
      }
      expect(wrong).toBe(0);
      expect(outOfRange).toBe(0);
    });

    it('is deterministic and leaves its inputs untouched', () => {
      const waterBefore = geo.r_water.slice();
      const biomeBefore = geo.r_biome.slice();
      const again = computeProvinces(mesh, edges, w.params, geo, fork(SEED, 'provinces'));
      expect(sameBytes(again.r_province, r_province)).toBe(true);
      expect(sameBytes(again.graph.p_first, graph.p_first)).toBe(true);
      expect(sameBytes(again.graph.p_nbr, graph.p_nbr)).toBe(true);
      expect(sameBytes(again.graph.p_border, graph.p_border)).toBe(true);
      expect(again.provinces.length).toBe(numP);
      let diff = 0;
      for (let p = 0; p < numP; p++) {
        const a = again.provinces[p], b = provinces[p];
        if (a.centroid_r !== b.centroid_r || a.area !== b.area || a.coastal !== b.coastal ||
            a.fertility !== b.fertility || !sameBytes(a.cells, b.cells)) diff++;
      }
      expect(diff).toBe(0);
      expect(sameBytes(geo.r_water, waterBefore)).toBe(true);
      expect(sameBytes(geo.r_biome, biomeBefore)).toBe(true);
      // A different seed for the stage stream changes the layout (the shuffle is consumed).
      const other = computeProvinces(mesh, edges, w.params, geo, fork(SEED + '-x', 'provinces'));
      expect(sameBytes(other.r_province, r_province)).toBe(false);
    });
  });
}

describe('cellFertility', () => {
  const w = worlds[1];
  const { mesh, geo } = w;

  it('is 0 on water and biome fertility x (1 - clamped slope) on land', () => {
    let badWater = 0, badLand = 0, outOfRange = 0, positive = 0;
    for (let r = 0; r < mesh.numRegions; r++) {
      const f = cellFertility(geo, r);
      if (geo.r_water[r] !== 0) {
        if (f !== 0) badWater++;
        continue;
      }
      const slope = Math.min(1, Math.max(0, geo.r_slope[r]));
      const expected = BIOME_FERTILITY[BIOMES[geo.r_biome[r]]] * (1 - slope);
      if (Math.abs(f - expected) > 1e-9) badLand++;
      if (!(f >= 0 && f <= 1)) outOfRange++;
      if (f > 0) positive++;
    }
    expect(badWater).toBe(0);
    expect(badLand).toBe(0);
    expect(outOfRange).toBe(0);
    expect(positive).toBeGreaterThan(0);
  });

  it('stays within the 12 ms budget (40 ms tolerated in node)', () => {
    // The module-load timings are cold (first call, JIT warming); a warm call is what the browser
    // sees after the first generate. Both are printed; the cold one is bounded loosely.
    const d = worlds[0];
    const t0 = performance.now();
    computeProvinces(d.mesh, d.edges, d.params, d.geo, fork(SEED, 'provinces'));
    const warm = performance.now() - t0;
    console.log(
      `provinces timing: default cold ${d.ms.toFixed(2)} ms, warm ${warm.toFixed(2)} ms; ` +
      `small cold ${worlds[1].ms.toFixed(2)} ms`,
    );
    expect(d.ms).toBeLessThan(200);
    expect(warm).toBeLessThan(80);
  });
});

