/**
 * gen/hydrology.test.ts — stage 7 against real upstream data (points -> mesh -> elevation ->
 * distance field -> climate) at DEFAULT_PARAMS and at a small 400x300 / spacing-16 world. Worlds
 * are built once at describe time; per-element invariants are counted in plain loops and asserted
 * once. Nothing here depends on exact moisture values (climate constants are still being tuned):
 * flux is only checked for sign, monotonicity, conservation and ordering.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { Mesh, WorldParams } from '../core/types';
import { quantile } from '../core/geom';
import { generatePoints } from '../mesh/poisson';
import {
  buildMesh, r_circulate_r, r_circulate_t, t_circulate_r, t_circulate_t, s_inner_t, s_outer_t,
} from '../mesh/dualmesh';
import { computeElevation, computeDistanceField } from './elevation';
import { computeClimate } from './climate';
import { computeHydrology } from './hydrology';
import type { HydrologyResult } from './hydrology';

const SEED = 'atlas-3';
const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16 };

interface Built {
  label: string;
  params: WorldParams;
  mesh: Mesh;
  r_elevation: Float32Array;
  r_water: Uint8Array;
  r_moisture: Float32Array;
  hydro: HydrologyResult;
  ms: number;
  // Derived in the test, independently of the module.
  t_ocean: Uint8Array;
  t_raw: Float64Array;
  t_rain: Float64Array;
}

function build(label: string, params: WorldParams, seed: string): Built {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  const mesh = buildMesh(points, numBoundary);
  const elev = computeElevation(mesh, params, fork(seed, 'elevation'));
  const { r_coastDist } = computeDistanceField(mesh, params, elev.r_water);
  const climate = computeClimate(
    mesh, params,
    { r_elevation: elev.r_elevation, r_water: elev.r_water, r_coastDist, r_lat: elev.r_lat },
    fork(seed, 'climate'),
  );
  const t0 = performance.now();
  const hydro = computeHydrology(mesh, params, elev.r_elevation, elev.r_water, climate.r_moisture);
  const ms = performance.now() - t0;

  const nt = mesh.numTriangles;
  const t_ocean = new Uint8Array(nt);
  const t_raw = new Float64Array(nt);
  const t_rain = new Float64Array(nt);
  const cells: number[] = [];
  for (let t = 0; t < nt; t++) {
    t_circulate_r(mesh, t, cells);
    let sum = 0, rain = 0;
    for (let i = 0; i < cells.length; i++) {
      sum += elev.r_elevation[cells[i]];
      rain += climate.r_moisture[cells[i]];
      if (elev.r_water[cells[i]] === 1) t_ocean[t] = 1;
    }
    t_raw[t] = sum / cells.length;
    t_rain[t] = rain / cells.length;
  }
  return {
    label, params, mesh, r_elevation: elev.r_elevation, r_water: elev.r_water,
    r_moisture: climate.r_moisture, hydro, ms, t_ocean, t_raw, t_rain,
  };
}

function isLandCorner(w: Built, t: number): boolean {
  return w.t_ocean[t] === 0 && w.hydro.t_lake[t] < 0;
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
  describe(`hydrology (${w.label})`, () => {
    const { mesh, hydro } = w;
    const nt = mesh.numTriangles;
    const ns = mesh.numSides;
    const nr = mesh.numRegions;

    it('has the right shapes and leaves its inputs untouched', () => {
      expect(hydro.t_elevation.length).toBe(nt);
      expect(hydro.t_downslope_s.length).toBe(nt);
      expect(hydro.t_flux.length).toBe(nt);
      expect(hydro.t_lake.length).toBe(nt);
      expect(hydro.s_river.length).toBe(ns);
      expect(hydro.s_riverId.length).toBe(ns);
      expect(hydro.r_water.length).toBe(nr);
      expect(hydro.riverParent.length).toBe(hydro.riverSides.length);
      expect(hydro.lakeOutlet_t.length).toBe(hydro.lakeCells.length);
      expect(hydro.r_water).not.toBe(w.r_water);
      // Re-running upstream stages reproduces the inputs bit for bit, so any mutation would show.
      const again = build(w.label, w.params, SEED);
      expect(sameBytes(again.r_elevation, w.r_elevation)).toBe(true);
      expect(sameBytes(again.r_water, w.r_water)).toBe(true);
      expect(sameBytes(again.r_moisture, w.r_moisture)).toBe(true);
    });

    it('fills: ocean corners keep their raw height, every other corner is at or above raw', () => {
      let badOcean = 0, belowRaw = 0, oceanDown = 0, oceanLake = 0;
      for (let t = 0; t < nt; t++) {
        const raw32 = Math.fround(w.t_raw[t]);
        if (w.t_ocean[t] === 1) {
          if (hydro.t_elevation[t] !== raw32) badOcean++;
          if (hydro.t_downslope_s[t] !== -1) oceanDown++;
          if (hydro.t_lake[t] !== -1) oceanLake++;
        } else if (hydro.t_elevation[t] < raw32) belowRaw++;
      }
      expect(badOcean).toBe(0);
      expect(belowRaw).toBe(0);
      expect(oceanDown).toBe(0);
      expect(oceanLake).toBe(0);
    });

    it('every non-ocean corner has a strictly lower neighbor after filling', () => {
      const nbrs: number[] = [];
      let stuck = 0;
      for (let t = 0; t < nt; t++) {
        if (w.t_ocean[t] === 1) continue;
        t_circulate_t(mesh, t, nbrs);
        let lower = false;
        for (let i = 0; i < nbrs.length; i++) {
          if (hydro.t_elevation[nbrs[i]] < hydro.t_elevation[t]) { lower = true; break; }
        }
        if (!lower) stuck++;
      }
      expect(stuck).toBe(0);
    });

    it('t_downslope_s is -1 exactly at ocean/lake corners and leads to the lowest neighbor elsewhere', () => {
      let badSink = 0, badSide = 0, notLowest = 0, notStrict = 0;
      for (let t = 0; t < nt; t++) {
        const s = hydro.t_downslope_s[t];
        if (!isLandCorner(w, t)) { if (s !== -1) badSink++; continue; }
        if (s < 3 * t || s > 3 * t + 2 || s_inner_t(s) !== t) { badSide++; continue; }
        const u = s_outer_t(mesh, s);
        let min = Infinity;
        for (let i = 0; i < 3; i++) {
          const v = s_outer_t(mesh, 3 * t + i);
          if (v >= 0 && hydro.t_elevation[v] < min) min = hydro.t_elevation[v];
        }
        if (u < 0 || hydro.t_elevation[u] !== min) notLowest++;
        if (u < 0 || hydro.t_elevation[u] >= hydro.t_elevation[t]) notStrict++;
      }
      expect(badSink).toBe(0);
      expect(badSide).toBe(0);
      expect(notLowest).toBe(0);
      expect(notStrict).toBe(0);
    });

    it('walking t_downslope_s from every land corner ends at an ocean or lake corner within numTriangles steps', () => {
      let lost = 0;
      for (let t0 = 0; t0 < nt; t0++) {
        if (!isLandCorner(w, t0)) continue;
        let t = t0, steps = 0;
        while (isLandCorner(w, t) && steps < nt) {
          const s = hydro.t_downslope_s[t];
          if (s < 0) break;
          t = s_outer_t(mesh, s);
          steps++;
        }
        if (isLandCorner(w, t) || t < 0) lost++;
      }
      expect(lost).toBe(0);
    });

    it('flux is non-negative, at least the local rain, non-decreasing downslope, and all rain reaches the ocean', () => {
      let negative = 0, belowRain = 0, decreasing = 0, lakeDecreasing = 0;
      let rainTotal = 0, oceanTotal = 0;
      for (let t = 0; t < nt; t++) {
        const f = hydro.t_flux[t];
        rainTotal += w.t_rain[t];
        if (f < 0) negative++;
        if (f < Math.fround(w.t_rain[t]) * (1 - 1e-6)) belowRain++;
        if (w.t_ocean[t] === 1) { oceanTotal += f; continue; }
        if (hydro.t_lake[t] >= 0) {
          const o = hydro.lakeOutlet_t[hydro.t_lake[t]];
          if (hydro.t_flux[o] < f) lakeDecreasing++;
          continue;
        }
        const u = s_outer_t(mesh, hydro.t_downslope_s[t]);
        if (hydro.t_flux[u] < f) decreasing++;
      }
      expect(negative).toBe(0);
      expect(belowRain).toBe(0);
      expect(decreasing).toBe(0);
      expect(lakeDecreasing).toBe(0);
      expect(rainTotal).toBeGreaterThan(0);
      expect(Math.abs(oceanTotal - rainTotal) / rainTotal).toBeLessThan(1e-5);
    });

    it('lakes: <= lakesMax, >= 4 connected cells each, r_water/t_lake consistent, outlet outside and below', () => {
      const { lakeCells, lakeOutlet_t, t_lake, r_water } = hydro;
      expect(lakeCells.length).toBeLessThanOrEqual(w.params.lakesMax);
      const r_lake = new Int32Array(nr).fill(-1);
      let small = 0, unsorted = 0, duplicate = 0, touchesOcean = 0, disconnected = 0;
      let outletInside = 0, outletHigh = 0, outletNotAdjacent = 0, outletNotLowest = 0;
      const nbrs: number[] = [];
      const corners: number[] = [];
      const seen = new Uint8Array(nr);
      const queue: number[] = [];
      for (let L = 0; L < lakeCells.length; L++) {
        const cells = lakeCells[L];
        if (cells.length < 4) small++;
        for (let i = 0; i < cells.length; i++) {
          const r = cells[i];
          if (i > 0 && cells[i - 1] >= r) unsorted++;
          if (r_lake[r] >= 0) duplicate++;
          r_lake[r] = L;
          r_circulate_r(mesh, r, nbrs);
          for (let j = 0; j < nbrs.length; j++) if (w.r_water[nbrs[j]] === 1) touchesOcean++;
        }
        // Connectivity: BFS from the first cell over lake cells of L must reach every cell of L.
        queue.length = 0;
        queue.push(cells[0]);
        seen[cells[0]] = 1;
        let reached = 0;
        while (queue.length > 0) {
          const r = queue.pop() as number;
          reached++;
          r_circulate_r(mesh, r, nbrs);
          for (let j = 0; j < nbrs.length; j++) {
            const q = nbrs[j];
            if (r_lake[q] === L && seen[q] === 0) { seen[q] = 1; queue.push(q); }
          }
        }
        if (reached !== cells.length) disconnected++;
        // Outlet: not a corner of L, strictly below every corner of L, adjacent to a corner of L,
        // and the lowest such corner.
        const o = lakeOutlet_t[L];
        if (t_lake[o] === L) outletInside++;
        let adjacent = false, lowest = Infinity, maxInside = -Infinity, minInside = Infinity;
        for (let i = 0; i < cells.length; i++) {
          r_circulate_t(mesh, cells[i], corners);
          for (let j = 0; j < corners.length; j++) {
            const t = corners[j];
            const h = hydro.t_elevation[t];
            if (h > maxInside) maxInside = h;
            if (h < minInside) minInside = h;
            t_circulate_t(mesh, t, nbrs);
            for (let k = 0; k < nbrs.length; k++) {
              const c = nbrs[k];
              if (t_lake[c] === L) continue;
              if (c === o) adjacent = true;
              if (hydro.t_elevation[c] < lowest) lowest = hydro.t_elevation[c];
            }
          }
        }
        if (!adjacent) outletNotAdjacent++;
        if (hydro.t_elevation[o] >= minInside) outletHigh++;
        if (hydro.t_elevation[o] !== lowest) outletNotLowest++;
      }
      expect(small).toBe(0);
      expect(unsorted).toBe(0);
      expect(duplicate).toBe(0);
      expect(touchesOcean).toBe(0);
      expect(disconnected).toBe(0);
      expect(outletInside).toBe(0);
      expect(outletHigh).toBe(0);
      expect(outletNotAdjacent).toBe(0);
      expect(outletNotLowest).toBe(0);
      // r_water === 2 exactly on lake cells; ocean untouched; everything else land.
      let waterMismatch = 0;
      for (let r = 0; r < nr; r++) {
        const expected = w.r_water[r] === 1 ? 1 : r_lake[r] >= 0 ? 2 : 0;
        if (r_water[r] !== expected) waterMismatch++;
      }
      expect(waterMismatch).toBe(0);
      // t_lake[t] >= 0 exactly on corners of lake cells, with the right id.
      const t_expect = new Int16Array(nt).fill(-1);
      for (let r = 0; r < nr; r++) {
        if (r_lake[r] < 0) continue;
        r_circulate_t(mesh, r, corners);
        for (let j = 0; j < corners.length; j++) t_expect[corners[j]] = r_lake[r];
      }
      let lakeMismatch = 0;
      for (let t = 0; t < nt; t++) if (t_lake[t] !== t_expect[t]) lakeMismatch++;
      expect(lakeMismatch).toBe(0);
    });

    it('revertedCells lists exactly the input r_water 2 cells that came back as land, ascending', () => {
      const expected: number[] = [];
      for (let r = 0; r < nr; r++) if (w.r_water[r] === 2 && hydro.r_water[r] === 0) expected.push(r);
      expect(Array.from(hydro.revertedCells)).toEqual(expected);
      let negativeLand = 0;
      for (let i = 0; i < hydro.revertedCells.length; i++) {
        if (!(w.r_elevation[hydro.revertedCells[i]] < 0)) negativeLand++;
      }
      expect(negativeLand).toBe(0);
    });

    it('rivers: >= 6 consecutive sides from a source unless fed, mirrored twins, ids consistent, flux monotone', () => {
      const { riverSides, riverParent, s_river, s_riverId, t_flux, t_downslope_s } = hydro;
      const n = riverSides.length;
      // Threshold and sources recomputed as the spec states them.
      let numLand = 0;
      for (let t = 0; t < nt; t++) if (isLandCorner(w, t)) numLand++;
      const landFlux = new Float32Array(numLand);
      for (let t = 0, k = 0; t < nt; t++) if (isLandCorner(w, t)) landFlux[k++] = t_flux[t];
      const threshold = numLand > 0 ? quantile(landFlux, w.params.riverPercentile) : Infinity;
      const hasUp = new Uint8Array(nt);
      for (let t = 0; t < nt; t++) {
        if (isLandCorner(w, t) && t_flux[t] >= threshold) hasUp[s_outer_t(mesh, t_downslope_s[t])] = 1;
      }
      const t_owner = new Int32Array(nt).fill(-1);
      // A river under RIVER_MIN_SIDES survives only when another river names it as parent
      // (the fixpoint in hydrology.ts step 6), so only childless short rivers are a defect.
      const childCount = new Int32Array(n);
      for (let i = 0; i < n; i++) if (riverParent[i] >= 0) childCount[riverParent[i]]++;
      let short = 0, broken = 0, notDownslope = 0, badId = 0, badTwin = 0, badFlux = 0, fluxDrop = 0;
      let notSource = 0, badMouth = 0, badParent = 0, cyclic = 0, ownerClash = 0;
      let listed = 0;
      for (let i = 0; i < n; i++) {
        const sides = riverSides[i];
        if (sides.length < 6 && childCount[i] === 0) short++;
        listed += sides.length;
        for (let j = 0; j < sides.length; j++) {
          const s = sides[j];
          const tin = s_inner_t(s);
          if (t_downslope_s[tin] !== s) notDownslope++;
          if (j > 0 && s_outer_t(mesh, sides[j - 1]) !== tin) broken++;
          if (s_riverId[s] !== i) badId++;
          const o = mesh.s_opposite_s[s];
          if (o < 0 || s_riverId[o] !== i || s_river[o] !== s_river[s]) badTwin++;
          if (s_river[s] !== t_flux[tin] || !(s_river[s] > 0)) badFlux++;
          if (j > 0 && t_flux[tin] < t_flux[s_inner_t(sides[j - 1])]) fluxDrop++;
          if (t_owner[tin] >= 0) ownerClash++;
          t_owner[tin] = i;
        }
        const t0 = s_inner_t(sides[0]);
        if (!isLandCorner(w, t0) || t_flux[t0] < threshold || hasUp[t0] === 1) notSource++;
        const p = riverParent[i];
        if (p < -1 || p >= n || p === i) badParent++;
        let q = p, hops = 0;
        while (q >= 0 && hops <= n) { q = riverParent[q]; hops++; }
        if (hops > n) cyclic++;
      }
      // Mouths: ocean or lake when parent is -1; otherwise the inner corner of a parent side.
      for (let i = 0; i < n; i++) {
        const sides = riverSides[i];
        const mouth = s_outer_t(mesh, sides[sides.length - 1]);
        const p = riverParent[i];
        if (p < 0) { if (isLandCorner(w, mouth)) badMouth++; }
        else if (t_owner[mouth] !== p) badMouth++;
      }
      let sidesWithId = 0, riverWithoutId = 0, idOutOfRange = 0;
      for (let s = 0; s < ns; s++) {
        if (s_riverId[s] >= 0) { sidesWithId++; if (s_riverId[s] >= n) idOutOfRange++; }
        else if (s_river[s] !== 0) riverWithoutId++;
      }
      expect(short).toBe(0);
      expect(broken).toBe(0);
      expect(notDownslope).toBe(0);
      expect(badId).toBe(0);
      expect(badTwin).toBe(0);
      expect(badFlux).toBe(0);
      expect(fluxDrop).toBe(0);
      expect(ownerClash).toBe(0);
      expect(notSource).toBe(0);
      expect(badMouth).toBe(0);
      expect(badParent).toBe(0);
      expect(cyclic).toBe(0);
      expect(idOutOfRange).toBe(0);
      expect(riverWithoutId).toBe(0);
      expect(sidesWithId).toBe(2 * listed);
    });

    it('is deterministic: a second run is byte-identical', () => {
      const again = computeHydrology(mesh, w.params, w.r_elevation, w.r_water, w.r_moisture);
      expect(sameBytes(again.t_elevation, hydro.t_elevation)).toBe(true);
      expect(sameBytes(again.t_downslope_s, hydro.t_downslope_s)).toBe(true);
      expect(sameBytes(again.t_flux, hydro.t_flux)).toBe(true);
      expect(sameBytes(again.t_lake, hydro.t_lake)).toBe(true);
      expect(sameBytes(again.s_river, hydro.s_river)).toBe(true);
      expect(sameBytes(again.s_riverId, hydro.s_riverId)).toBe(true);
      expect(sameBytes(again.r_water, hydro.r_water)).toBe(true);
      expect(sameBytes(again.riverParent, hydro.riverParent)).toBe(true);
      expect(sameBytes(again.lakeOutlet_t, hydro.lakeOutlet_t)).toBe(true);
      expect(sameBytes(again.revertedCells, hydro.revertedCells)).toBe(true);
      expect(again.riverSides.length).toBe(hydro.riverSides.length);
      expect(again.lakeCells.length).toBe(hydro.lakeCells.length);
      let diff = 0;
      for (let i = 0; i < hydro.riverSides.length; i++) if (!sameBytes(again.riverSides[i], hydro.riverSides[i])) diff++;
      for (let i = 0; i < hydro.lakeCells.length; i++) if (!sameBytes(again.lakeCells[i], hydro.lakeCells[i])) diff++;
      expect(diff).toBe(0);
    });
  });
}

describe('hydrology (default world, counts and budget)', () => {
  const w = worlds[0];
  const { hydro } = w;

  it('produces a few dozen rivers, one of them longer than 30 sides, and at least one lake', () => {
    let longest = 0;
    for (const sides of hydro.riverSides) if (sides.length > longest) longest = sides.length;
    let lakeCellCount = 0;
    for (const cells of hydro.lakeCells) lakeCellCount += cells.length;
    console.log(
      `[hydrology] default: ${w.mesh.numTriangles} corners, ${hydro.riverSides.length} rivers ` +
      `(longest ${longest} sides), ${hydro.lakeCells.length} lakes (${lakeCellCount} cells), ` +
      `${hydro.revertedCells.length} reverted cells, ${w.ms.toFixed(1)} ms first call`,
    );
    expect(hydro.riverSides.length).toBeGreaterThanOrEqual(10);
    expect(hydro.riverSides.length).toBeLessThanOrEqual(150);
    expect(longest).toBeGreaterThan(30);
    expect(hydro.lakeCells.length).toBeGreaterThanOrEqual(1);
    expect(hydro.revertedCells.length).toBeGreaterThanOrEqual(1);
  });

  it('stays within a loose multiple of the 15 ms budget in node', () => {
    let best = w.ms;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      computeHydrology(w.mesh, w.params, w.r_elevation, w.r_water, w.r_moisture);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    console.log(`[hydrology] default: best of 4 runs ${best.toFixed(1)} ms (budget 15 ms)`);
    expect(best).toBeLessThan(200);
  });

  it('honors lakesMax: the largest components survive, the rest revert and still drain to the ocean', () => {
    const one = computeHydrology(w.mesh, { ...w.params, lakesMax: 1 }, w.r_elevation, w.r_water, w.r_moisture);
    expect(one.lakeCells.length).toBe(1);
    expect(Array.from(one.lakeCells[0])).toEqual(Array.from(hydro.lakeCells[0]));
    expect(one.revertedCells.length).toBeGreaterThanOrEqual(hydro.revertedCells.length);
    for (let L = 1; L < hydro.lakeCells.length; L++) {
      let stillLake = 0;
      for (const r of hydro.lakeCells[L]) if (one.r_water[r] !== 0) stillLake++;
      expect(stillLake).toBe(0);
    }
    const none = computeHydrology(w.mesh, { ...w.params, lakesMax: 0 }, w.r_elevation, w.r_water, w.r_moisture);
    expect(none.lakeCells.length).toBe(0);
    let stillTwo = 0, reverted = 0, lost = 0;
    for (let r = 0; r < w.mesh.numRegions; r++) {
      if (none.r_water[r] === 2) stillTwo++;
      if (w.r_water[r] === 2) reverted++;
    }
    expect(stillTwo).toBe(0);
    expect(none.revertedCells.length).toBe(reverted);
    // Without lakes every non-ocean corner drains all the way to the ocean.
    const nt = w.mesh.numTriangles;
    for (let t0 = 0; t0 < nt; t0++) {
      if (w.t_ocean[t0] === 1) continue;
      let t = t0, steps = 0;
      while (w.t_ocean[t] === 0 && steps < nt) {
        const s = none.t_downslope_s[t];
        if (s < 0) break;
        t = s_outer_t(w.mesh, s);
        steps++;
      }
      if (w.t_ocean[t] === 0) lost++;
    }
    expect(lost).toBe(0);
  });
});
