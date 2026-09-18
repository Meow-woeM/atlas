/**
 * gen/features.test.ts — stages 13 and 14 against real upstream data (points -> mesh -> noisy
 * edges -> elevation -> distance field -> climate -> hydrology -> biomes) at DEFAULT_PARAMS and at
 * a small 400x300 / spacing-16 world, plus a third default-params world (seed lakes-1) whose lakes
 * all drain through river sources, for the lake-outflow path rule. Worlds are built once at module
 * load; per-element invariants are counted in plain loops and asserted once. The political view is exercised on a hand-made
 * Politics (three nations grown by BFS from three seed cells, plus one nation with no territory).
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS, WATERLINE_ISOS } from '../core/types';
import type { Geography, Mesh, Nation, NoisyEdges, Politics, Polyline, World, WorldParams } from '../core/types';
import { pointInPolygon, polylineLength } from '../core/geom';
import { sampleBilinear } from '../core/raster';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, cellPolygon, r_circulate_r, r_is_boundary, s_inner_t, s_outer_t } from '../mesh/dualmesh';
import { buildNoisyEdges } from '../mesh/noisy';
import { computeElevation, computeDistanceField } from './elevation';
import { computeBiomes, computeClimate } from './climate';
import { computeHydrology } from './hydrology';
import type { HydrologyResult } from './hydrology';
import { buildPoliticalView, extractFeatures, poleOfInaccessibility } from './features';
import type { Features } from '../core/types';

const SEED = 'atlas-3';
const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16 };

interface Built {
  label: string;
  seed: string;
  params: WorldParams;
  mesh: Mesh;
  edges: NoisyEdges;
  geo: Geography;
  hydro: HydrologyResult;
  features: Features;
  ms: number;
  // Derived in the test, independently of the module.
  r_px: Float32Array;
  r_py: Float32Array;
  r_area: Float32Array;
}

function build(label: string, params: WorldParams, seed: string): Built {
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
    r_elevation: elev.r_elevation, r_water: hydro.r_water, r_coastHops: elev.r_coastHops, r_coastDist,
    r_lat: elev.r_lat, r_lon: elev.r_lon, r_temperature: climate.r_temperature,
    r_moisture: climate.r_moisture, r_biome, r_slope: elev.r_slope,
    t_elevation: hydro.t_elevation, t_downslope_s: hydro.t_downslope_s, t_flux: hydro.t_flux,
    t_lake: hydro.t_lake, s_river: hydro.s_river, s_riverId: hydro.s_riverId,
    windDir: climate.windDir, distField,
  };
  const t0 = performance.now();
  const features = extractFeatures({ mesh, edges, geo, params }, hydro);
  const ms = performance.now() - t0;

  const n = mesh.numRegions;
  const r_px = new Float32Array(n);
  const r_py = new Float32Array(n);
  const r_area = new Float32Array(n);
  const poly = new Float32Array(64);
  for (let r = 0; r < n; r++) {
    const k = cellPolygon(mesh, r, poly);
    let sx = 0, sy = 0, a = 0;
    for (let i = 0; i < k; i++) {
      const j = i + 1 === k ? 0 : i + 1;
      sx += poly[2 * i];
      sy += poly[2 * i + 1];
      a += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
    }
    r_px[r] = k > 0 ? sx / k : 0;
    r_py[r] = k > 0 ? sy / k : 0;
    r_area[r] = Math.abs(a) * 0.5;
  }
  return { label, seed, params, mesh, edges, geo, hydro, features, ms, r_px, r_py, r_area };
}

/** Shoelace signed area of a closed polyline (positive = counterclockwise in numeric coords). */
function signedArea(pts: Float32Array): number {
  const n = pts.length >> 1;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return a * 0.5;
}

/** Counts degeneracies in a polyline: NaN coordinates and zero-length segments. */
function degeneracies(p: Polyline): { nan: number; zero: number } {
  const pts = p.pts;
  const n = pts.length >> 1;
  let nan = 0, zero = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(pts[2 * i]) || Number.isNaN(pts[2 * i + 1])) nan++;
    const j = i + 1;
    if (j === n && !p.closed) break;
    const jj = j === n ? 0 : j;
    if (pts[2 * i] === pts[2 * jj] && pts[2 * i + 1] === pts[2 * jj + 1]) zero++;
  }
  return { nan, zero };
}

/**
 * Per-segment orientation statistics against the signed distance field: the field sampled `step`
 * px to the walker's LEFT (y-down screen coordinates: left normal of direction (dx, dy) is
 * (dy, -dx)) and `step` px to the RIGHT. leftPos / rightPos count positive samples (land),
 * leftGtRight counts segments where the left sample exceeds the right one (the field's gradient
 * points toward land, so this holds whatever the noisy-edge and raster blur do to the absolute value).
 */
function orientationStats(
  loops: Polyline[], geo: Geography, step: number,
): { leftPos: number; rightPos: number; leftGtRight: number; total: number } {
  let leftPos = 0, rightPos = 0, leftGtRight = 0, total = 0;
  for (const loop of loops) {
    const pts = loop.pts;
    const n = pts.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = i + 1;
      if (j === n && !loop.closed) break;
      const jj = j === n ? 0 : j;
      const ax = pts[2 * i], ay = pts[2 * i + 1];
      const bx = pts[2 * jj], by = pts[2 * jj + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const nx = dy / len, ny = -dx / len;
      const left = sampleBilinear(geo.distField, mx + step * nx, my + step * ny);
      const right = sampleBilinear(geo.distField, mx - step * nx, my - step * ny);
      total++;
      if (left > 0) leftPos++;
      if (right > 0) rightPos++;
      if (left > right) leftGtRight++;
    }
  }
  return { leftPos, rightPos, leftGtRight, total };
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Three nations grown by BFS over land from three spread-out seed cells, plus one empty nation. */
function makePolitics(mesh: Mesh, r_water: Uint8Array, numGrown: number, numEmpty: number): Politics {
  const n = mesh.numRegions;
  const land: number[] = [];
  for (let r = mesh.numBoundaryRegions; r < n; r++) if (r_water[r] === 0) land.push(r);
  const r_nation = new Int16Array(n).fill(-1);
  const queue: number[] = [];
  for (let k = 0; k < numGrown; k++) {
    const seed = land[Math.floor(((2 * k + 1) * land.length) / (2 * numGrown))];
    if (r_nation[seed] >= 0) continue;
    r_nation[seed] = k;
    queue.push(seed);
  }
  const nbrs: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const r = queue[head];
    const owner = r_nation[r];
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const q = nbrs[i];
      if (r_water[q] === 0 && !r_is_boundary(mesh, q) && r_nation[q] < 0) {
        r_nation[q] = owner;
        queue.push(q);
      }
    }
  }
  const nations: Nation[] = [];
  for (let k = 0; k < numGrown + numEmpty; k++) {
    nations.push({ id: k, name: '', capital: -1, culture: 0, color: '#000', founded: 0, died: -1 });
  }
  return {
    year: 0, cultures: [], nations,
    p_nation: new Int16Array(0), p_culture: new Int16Array(0),
    r_nation, r_settlement: new Int16Array(n).fill(-1),
  };
}

function makeWorld(w: Built, politics: Politics): World {
  return {
    seed: w.seed, params: w.params, mesh: w.mesh, edges: w.edges, geo: w.geo, features: w.features,
    provinces: [],
    graph: { p_first: new Int32Array(1), p_nbr: new Int32Array(0), p_border: new Float32Array(0) },
    r_province: new Int16Array(w.mesh.numRegions).fill(-1),
    settlements: [], politics, history: { events: [] }, timings: {},
  };
}

const worlds: Built[] = [
  build('default', DEFAULT_PARAMS, SEED),
  build('small', SMALL, SEED),
  // A default-params world whose three lakes all drain through a river source (lake outflows).
  build('lakes', DEFAULT_PARAMS, 'lakes-1'),
];

describe('left normal convention (y-down screen coordinates)', () => {
  it('a square traversed clockwise on screen has its interior on the RIGHT, counterclockwise on the LEFT', () => {
    const cw = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);      // top-left -> top-right -> bottom-right -> bottom-left
    const ccw = new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]);
    let cwLeftInside = 0, ccwLeftInside = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      for (const [pts, which] of [[cw, 0], [ccw, 1]] as const) {
        const dx = pts[2 * j] - pts[2 * i], dy = pts[2 * j + 1] - pts[2 * i + 1];
        const mx = (pts[2 * i] + pts[2 * j]) * 0.5 + 0.25 * dy;
        const my = (pts[2 * i + 1] + pts[2 * j + 1]) * 0.5 - 0.25 * dx;
        if (pointInPolygon(mx, my, pts)) { if (which === 0) cwLeftInside++; else ccwLeftInside++; }
      }
    }
    expect(cwLeftInside).toBe(0);
    expect(ccwLeftInside).toBe(4);
  });
});

for (const w of worlds) {
  describe(`features (${w.label})`, () => {
    const { mesh, geo, hydro, features } = w;
    const nr = mesh.numRegions;
    /** The smallest lake whose outlet corner is t, or -1. */
    const outletLakeOf = (t: number): number => {
      for (let L = 0; L < hydro.lakeCells.length; L++) if (hydro.lakeOutlet_t[L] === t) return L;
      return -1;
    };

    it('coast loops are closed and non-degenerate', () => {
      expect(features.coast.length).toBeGreaterThan(0);
      let open = 0, short = 0, nan = 0, zero = 0;
      for (const loop of features.coast) {
        if (!loop.closed) open++;
        if ((loop.pts.length >> 1) < 8) short++;
        const d = degeneracies(loop);
        nan += d.nan;
        zero += d.zero;
      }
      expect(open).toBe(0);
      expect(short).toBe(0);
      expect(nan).toBe(0);
      expect(zero).toBe(0);
    });

    it('coast loops enclose the non-ocean interior cell area within 5%', () => {
      let loopArea = 0;
      for (const loop of features.coast) loopArea += Math.abs(signedArea(loop.pts));
      let cellArea = 0;
      for (let r = mesh.numBoundaryRegions; r < nr; r++) if (geo.r_water[r] !== 1) cellArea += w.r_area[r];
      expect(cellArea).toBeGreaterThan(0);
      expect(Math.abs(loopArea - cellArea) / cellArea).toBeLessThan(0.05);
    });

    it('coast orientation: land is on the left when walking the points in order', () => {
      // The noisy side paths sit up to 0.25 * cellSpacing off the straight Voronoi edge and the
      // mask is rasterized at 2 logical px per raster px, so the absolute sign 1.5 px inland is
      // blurred; the blur-proof statement is that the field rises toward the left (land) side.
      const near = orientationStats(features.coast, geo, 1.5);
      const clear = 0.25 * w.params.cellSpacing + 1.5;
      const far = orientationStats(features.coast, geo, clear);
      console.log(
        `[features] ${w.label}: coast segments ${near.total}; at 1.5 px: left>right ${(near.leftGtRight / near.total).toFixed(3)}, ` +
        `left land ${(near.leftPos / near.total).toFixed(3)}, right land ${(near.rightPos / near.total).toFixed(3)}; ` +
        `at ${clear.toFixed(1)} px: left land ${(far.leftPos / far.total).toFixed(3)}, right land ${(far.rightPos / far.total).toFixed(3)}`,
      );
      expect(near.total).toBeGreaterThan(100);
      expect(near.leftGtRight / near.total).toBeGreaterThanOrEqual(0.97);
      expect(near.leftPos / near.total).toBeGreaterThan(0.7);
      expect(near.rightPos / near.total).toBeLessThan(0.3);
      expect(far.leftPos / far.total).toBeGreaterThanOrEqual(0.9);
      expect(far.rightPos / far.total).toBeLessThan(0.1);
    });

    it('lake shores: one closed loop per lake enclosing that lake\'s cells, land on the left', () => {
      expect(features.lakes.length).toBe(hydro.lakeCells.length);
      let open = 0, short = 0, nan = 0, zero = 0, badId = 0, badCells = 0, badOutlet = 0;
      let poorlyEnclosed = 0, badOrientation = 0;
      for (let L = 0; L < features.lakes.length; L++) {
        const lake = features.lakes[L];
        if (lake.id !== L) badId++;
        if (lake.cells !== hydro.lakeCells[L]) badCells++;
        if (lake.outlet_t !== hydro.lakeOutlet_t[L]) badOutlet++;
        const shore = lake.shore;
        if (!shore.closed) open++;
        if ((shore.pts.length >> 1) < 8) short++;
        const d = degeneracies(shore);
        nan += d.nan;
        zero += d.zero;
        let inside = 0;
        for (let i = 0; i < lake.cells.length; i++) {
          if (pointInPolygon(w.r_px[lake.cells[i]], w.r_py[lake.cells[i]], shore.pts)) inside++;
        }
        if (inside < 0.9 * lake.cells.length) poorlyEnclosed++;
        // Orientation: the lake is on the walker's RIGHT (land on the left, as on the coast), so
        // the point 1.5 px to the left of a segment lies outside the shore polygon.
        const pts = shore.pts;
        const n = pts.length >> 1;
        let leftOutside = 0, segs = 0;
        for (let i = 0; i < n; i++) {
          const j = i + 1 === n ? 0 : i + 1;
          const ax = pts[2 * i], ay = pts[2 * i + 1];
          const bx = pts[2 * j], by = pts[2 * j + 1];
          const dx = bx - ax, dy = by - ay;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len === 0) continue;
          segs++;
          if (!pointInPolygon((ax + bx) * 0.5 + 1.5 * dy / len, (ay + by) * 0.5 - 1.5 * dx / len, pts)) leftOutside++;
        }
        if (leftOutside < 0.9 * segs) badOrientation++;
      }
      expect(badId).toBe(0);
      expect(badCells).toBe(0);
      expect(badOutlet).toBe(0);
      expect(open).toBe(0);
      expect(short).toBe(0);
      expect(nan).toBe(0);
      expect(zero).toBe(0);
      expect(poorlyEnclosed).toBe(0);
      expect(badOrientation).toBe(0);
    });

    it('rivers: one path per river from the source corner to the mouth corner, fields consistent', () => {
      const { rivers, riverPaths } = features;
      expect(rivers.length).toBe(hydro.riverSides.length);
      expect(riverPaths.length).toBe(rivers.length);
      let badId = 0, badSides = 0, badSource = 0, badMouth = 0, badFlux = 0, badParent = 0, badName = 0;
      let farStart = 0, farEnd = 0, noLength = 0, closed = 0, nan = 0, zero = 0, badLength = 0;
      for (let i = 0; i < rivers.length; i++) {
        const rv = rivers[i];
        const path = riverPaths[i];
        const sides = hydro.riverSides[i];
        if (rv.id !== i) badId++;
        if (rv.sides !== sides) badSides++;
        if (rv.name !== '') badName++;
        const last = sides[sides.length - 1];
        if (rv.source_t !== s_inner_t(sides[0])) badSource++;
        if (rv.mouth_t !== s_outer_t(mesh, last)) badMouth++;
        if (rv.flux !== geo.s_river[last] || !(rv.flux > 0)) badFlux++;
        if (rv.parent !== hydro.riverParent[i]) badParent++;
        if (path.closed) closed++;
        const d = degeneracies(path);
        nan += d.nan;
        zero += d.zero;
        const pts = path.pts;
        const n = pts.length >> 1;
        const sx = mesh.t_x[rv.source_t], sy = mesh.t_y[rv.source_t];
        const mx = mesh.t_x[rv.mouth_t], my = mesh.t_y[rv.mouth_t];
        // A river rising at a lake outlet starts one side upstream, at a corner of that lake
        // (checked in the lake-outflow test below); every other river starts at source_t.
        if (outletLakeOf(rv.source_t) < 0 && Math.hypot(pts[0] - sx, pts[1] - sy) > 3) farStart++;
        if (Math.hypot(pts[2 * n - 2] - mx, pts[2 * n - 1] - my) > 3) farEnd++;
        if (!(rv.length > 0)) noLength++;
        if (Math.abs(rv.length - polylineLength(pts, false)) > 1e-3) badLength++;
      }
      expect(badId).toBe(0);
      expect(badSides).toBe(0);
      expect(badName).toBe(0);
      expect(badSource).toBe(0);
      expect(badMouth).toBe(0);
      expect(badFlux).toBe(0);
      expect(badParent).toBe(0);
      expect(closed).toBe(0);
      expect(nan).toBe(0);
      expect(zero).toBe(0);
      expect(farStart).toBe(0);
      expect(farEnd).toBe(0);
      expect(noLength).toBe(0);
      expect(badLength).toBe(0);
    });

    it('lake outflows: a river rising at a lake outlet is drawn from a corner of that lake', () => {
      // hydrology's outlet corner is one side outside the shore; features prepends the spill side
      // to the PATH only, so the first path point (Chaikin keeps open endpoints exact) is a corner
      // of the lake while River.source_t stays the outlet corner.
      const { rivers, riverPaths, lakes } = features;
      let outflows = 0, farFromLake = 0, sourceMoved = 0, lengthOff = 0, notMoved = 0;
      for (let i = 0; i < rivers.length; i++) {
        const rv = rivers[i];
        const L = outletLakeOf(rv.source_t);
        if (L < 0) continue;
        outflows++;
        if (rv.source_t !== s_inner_t(rv.sides[0])) sourceMoved++;
        const pts = riverPaths[i].pts;
        let near = false;
        for (let t = 0; t < mesh.numTriangles && !near; t++) {
          if (hydro.t_lake[t] !== L) continue;
          if (Math.hypot(pts[0] - mesh.t_x[t], pts[1] - mesh.t_y[t]) <= 3) near = true;
        }
        if (!near) farFromLake++;
        if (Math.hypot(pts[0] - mesh.t_x[rv.source_t], pts[1] - mesh.t_y[rv.source_t]) <= 1) notMoved++;
        if (Math.abs(rv.length - polylineLength(pts, false)) > 1e-3) lengthOff++;
        // The path visibly reaches the lake: its first point sits inside or on the smoothed shore
        // neighbourhood, i.e. within one cell spacing of the shore polyline.
        const shore = lakes[L].shore.pts;
        let d = Infinity;
        for (let k = 0; k < shore.length; k += 2) {
          const dd = Math.hypot(pts[0] - shore[k], pts[1] - shore[k + 1]);
          if (dd < d) d = dd;
        }
        if (d > w.params.cellSpacing) farFromLake++;
      }
      console.log(`[features] ${w.label}: ${outflows} of ${rivers.length} rivers rise at a lake outlet (${lakes.length} lakes)`);
      expect(sourceMoved).toBe(0);
      expect(notMoved).toBe(0);
      expect(farFromLake).toBe(0);
      expect(lengthOff).toBe(0);
      if (w.label === 'lakes') expect(outflows).toBeGreaterThanOrEqual(2);
    });

    it('waterlines: one array per iso, points on the contour within 1.5 px', () => {
      expect(features.waterlines.length).toBe(WATERLINE_ISOS.length);
      let total = 0, ok = 0, nan = 0, empty = 0;
      for (let i = 0; i < WATERLINE_ISOS.length; i++) {
        const iso = WATERLINE_ISOS[i];
        const lines = features.waterlines[i];
        if (lines.length === 0) empty++;
        for (const line of lines) {
          const pts = line.pts;
          const n = pts.length >> 1;
          for (let k = 0; k < n; k++) {
            const x = pts[2 * k], y = pts[2 * k + 1];
            if (Number.isNaN(x) || Number.isNaN(y)) { nan++; continue; }
            total++;
            if (Math.abs(sampleBilinear(geo.distField, x, y) - iso) <= 1.5) ok++;
          }
        }
      }
      expect(empty).toBe(0);
      expect(nan).toBe(0);
      expect(total).toBeGreaterThan(100);
      expect(ok / total).toBeGreaterThanOrEqual(0.95);
    });

    it('seas: at most 2, interior ocean cells ascending, label_r the cell farthest offshore', () => {
      const { seas } = features;
      expect(seas.length).toBeGreaterThanOrEqual(1);
      expect(seas.length).toBeLessThanOrEqual(2);
      let badKind = 0, badId = 0, notOcean = 0, unsorted = 0, labelOutside = 0, labelNotFarthest = 0, badAxis = 0;
      for (let i = 0; i < seas.length; i++) {
        const sea = seas[i];
        if (sea.kind !== 'sea') badKind++;
        if (sea.id !== i) badId++;
        if (!Number.isFinite(sea.axisAngle) || !(sea.extent >= 0)) badAxis++;
        let inside = false, minDist = Infinity;
        for (let k = 0; k < sea.cells.length; k++) {
          const r = sea.cells[k];
          if (geo.r_water[r] !== 1 || r_is_boundary(mesh, r)) notOcean++;
          if (k > 0 && sea.cells[k - 1] >= r) unsorted++;
          if (r === sea.label_r) inside = true;
          if (geo.r_coastDist[r] < minDist) minDist = geo.r_coastDist[r];
        }
        if (!inside) labelOutside++;
        if (geo.r_coastDist[sea.label_r] !== minDist) labelNotFarthest++;
      }
      if (seas.length === 2) expect(seas[0].cells.length).toBeGreaterThanOrEqual(seas[1].cells.length);
      expect(badKind).toBe(0);
      expect(badId).toBe(0);
      expect(notOcean).toBe(0);
      expect(unsorted).toBe(0);
      expect(labelOutside).toBe(0);
      expect(labelNotFarthest).toBe(0);
      expect(badAxis).toBe(0);
    });

    it('ranges: >= 12 cells above 0.62 each, label_r inside, connected', () => {
      const { ranges } = features;
      let small = 0, low = 0, labelOutside = 0, badKind = 0, badId = 0, disconnected = 0, unsorted = 0;
      const member = new Int32Array(nr).fill(-1);
      const nbrs: number[] = [];
      for (let i = 0; i < ranges.length; i++) {
        const rg = ranges[i];
        if (rg.kind !== 'range') badKind++;
        if (rg.id !== i) badId++;
        if (rg.cells.length < 12) small++;
        let inside = false;
        for (let k = 0; k < rg.cells.length; k++) {
          const r = rg.cells[k];
          if (!(geo.r_elevation[r] > 0.62)) low++;
          if (k > 0 && rg.cells[k - 1] >= r) unsorted++;
          if (r === rg.label_r) inside = true;
          member[r] = i;
        }
        if (!inside) labelOutside++;
        // Connectivity via BFS over the component's own cells.
        const seen = new Set<number>([rg.cells[0]]);
        const stack = [rg.cells[0]];
        while (stack.length > 0) {
          const r = stack.pop() as number;
          r_circulate_r(mesh, r, nbrs);
          for (const q of nbrs) if (member[q] === i && !seen.has(q)) { seen.add(q); stack.push(q); }
        }
        if (seen.size !== rg.cells.length) disconnected++;
      }
      // Every high interior cell in a component of >= 12 cells belongs to some range: count the
      // high cells not in any range and check none of them sits in a big component.
      let missed = 0;
      const comp = new Int32Array(nr).fill(-1);
      for (let r0 = mesh.numBoundaryRegions; r0 < nr; r0++) {
        if (!(geo.r_elevation[r0] > 0.62) || comp[r0] >= 0 || member[r0] >= 0) continue;
        const stack = [r0];
        comp[r0] = r0;
        let size = 0;
        while (stack.length > 0) {
          const r = stack.pop() as number;
          size++;
          r_circulate_r(mesh, r, nbrs);
          for (const q of nbrs) {
            if (geo.r_elevation[q] > 0.62 && !r_is_boundary(mesh, q) && comp[q] < 0) { comp[q] = r0; stack.push(q); }
          }
        }
        if (size >= 12) missed++;
      }
      expect(badKind).toBe(0);
      expect(badId).toBe(0);
      expect(small).toBe(0);
      expect(low).toBe(0);
      expect(unsorted).toBe(0);
      expect(labelOutside).toBe(0);
      expect(disconnected).toBe(0);
      expect(missed).toBe(0);
    });

    it('is deterministic: a second extraction is byte-identical', () => {
      const again = extractFeatures({ mesh, edges: w.edges, geo, params: w.params }, hydro);
      expect(again.coast.length).toBe(features.coast.length);
      let diff = 0;
      for (let i = 0; i < features.coast.length; i++) if (!sameBytes(again.coast[i].pts, features.coast[i].pts)) diff++;
      for (let i = 0; i < features.riverPaths.length; i++) if (!sameBytes(again.riverPaths[i].pts, features.riverPaths[i].pts)) diff++;
      for (let i = 0; i < features.lakes.length; i++) if (!sameBytes(again.lakes[i].shore.pts, features.lakes[i].shore.pts)) diff++;
      for (let i = 0; i < WATERLINE_ISOS.length; i++) {
        expect(again.waterlines[i].length).toBe(features.waterlines[i].length);
        for (let j = 0; j < features.waterlines[i].length; j++) {
          if (!sameBytes(again.waterlines[i][j].pts, features.waterlines[i][j].pts)) diff++;
        }
      }
      for (let i = 0; i < features.seas.length; i++) if (again.seas[i].label_r !== features.seas[i].label_r) diff++;
      for (let i = 0; i < features.ranges.length; i++) if (again.ranges[i].label_r !== features.ranges[i].label_r) diff++;
      expect(diff).toBe(0);
    });
  });
}

describe('poleOfInaccessibility', () => {
  const w = worlds[0];
  const { mesh } = w;

  it('is -1 for an empty set and the cell itself for a single cell', () => {
    expect(poleOfInaccessibility(mesh, new Int32Array(0))).toBe(-1);
    const r = mesh.numBoundaryRegions + 100;
    expect(poleOfInaccessibility(mesh, Int32Array.of(r))).toBe(r);
  });

  it('is the center of a cell-plus-ring blob, whatever the input order', () => {
    const nbrs: number[] = [];
    let center = -1;
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
      r_circulate_r(mesh, r, nbrs);
      let ok = nbrs.length >= 5;
      for (const q of nbrs) if (r_is_boundary(mesh, q)) ok = false;
      if (ok) { center = r; break; }
    }
    expect(center).toBeGreaterThanOrEqual(0);
    r_circulate_r(mesh, center, nbrs);
    const blob = Int32Array.from([...nbrs, center]);
    expect(poleOfInaccessibility(mesh, blob)).toBe(center);
    const reversed = Int32Array.from([center, ...nbrs].reverse());
    expect(poleOfInaccessibility(mesh, reversed)).toBe(center);
  });

  it('for a whole land mass lies inland (positive coast hops) and inside the set', () => {
    const { geo } = w;
    const land: number[] = [];
    for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) if (geo.r_water[r] === 0) land.push(r);
    const pole = poleOfInaccessibility(mesh, Int32Array.from(land));
    expect(geo.r_water[pole]).toBe(0);
    let maxHops = 0;
    for (const r of land) if (geo.r_coastHops[r] > maxHops) maxHops = geo.r_coastHops[r];
    expect(geo.r_coastHops[pole]).toBeGreaterThanOrEqual(Math.max(2, Math.floor(maxHops / 2)));
  });
});

describe('buildPoliticalView (hand-made politics on the default world)', () => {
  const w = worlds[0];
  const { mesh, geo } = w;
  const politics = makePolitics(mesh, geo.r_water, 3, 1);
  const world = makeWorld(w, politics);
  const t0 = performance.now();
  const view = buildPoliticalView(world);
  const ms = performance.now() - t0;
  const numNations = politics.nations.length;

  it('has one entry per nation and one borderNation per border', () => {
    expect(view.nationLabel_r.length).toBe(numNations);
    expect(view.nationArea.length).toBe(numNations);
    expect(view.nationAxis.length).toBe(numNations);
    expect(view.borderNation.length).toBe(view.borders.length);
    expect(view.borders.length).toBeGreaterThanOrEqual(3);
  });

  it('borders are closed, non-degenerate, owned by a real nation, and every owning nation has some', () => {
    let open = 0, short = 0, nan = 0, zero = 0, badOwner = 0;
    const perNation = new Float64Array(numNations);
    for (let b = 0; b < view.borders.length; b++) {
      const p = view.borders[b];
      const n = view.borderNation[b];
      if (n < 0 || n >= numNations) { badOwner++; continue; }
      if (!p.closed) open++;
      if ((p.pts.length >> 1) < 8) short++;
      const d = degeneracies(p);
      nan += d.nan;
      zero += d.zero;
      perNation[n] += polylineLength(p.pts, p.closed);
    }
    expect(badOwner).toBe(0);
    expect(open).toBe(0);
    expect(short).toBe(0);
    expect(nan).toBe(0);
    expect(zero).toBe(0);
    for (let n = 0; n < 3; n++) expect(perNation[n]).toBeGreaterThan(0);
    expect(perNation[3]).toBe(0);
  });

  it('borders keep their nation on the left (the owning cell is left of every segment)', () => {
    // The nation on the left: sample 1.5 px to the left of every segment and look up the owner of
    // the nearest cell position among the border nation's cells and its neighbors is expensive, so
    // instead check the sign of the enclosed area against the cells: a nation's outer loop, with
    // the nation on the left in y-down coordinates, encloses that nation's cell positions.
    let enclosed = 0, total = 0;
    for (let n = 0; n < 3; n++) {
      let best: Polyline | null = null;
      for (let b = 0; b < view.borders.length; b++) {
        if (view.borderNation[b] !== n) continue;
        if (best === null || view.borders[b].pts.length > best.pts.length) best = view.borders[b];
      }
      if (best === null) continue;
      let count = 0;
      for (let r = 0; r < mesh.numRegions; r++) {
        if (politics.r_nation[r] !== n) continue;
        if (count++ % 7 !== 0) continue;   // sample every 7th cell
        total++;
        if (pointInPolygon(w.r_px[r], w.r_py[r], best.pts)) enclosed++;
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(enclosed / total).toBeGreaterThan(0.8);
  });

  it('nationArea is the sum of the owned cell areas, nationLabel_r lies inside its nation, empty nations get -1', () => {
    for (let n = 0; n < numNations; n++) {
      let area = 0, count = 0;
      for (let r = 0; r < mesh.numRegions; r++) {
        if (politics.r_nation[r] === n) { area += w.r_area[r]; count++; }
      }
      if (count === 0) {
        expect(view.nationLabel_r[n]).toBe(-1);
        expect(view.nationArea[n]).toBe(0);
        continue;
      }
      expect(view.nationArea[n]).toBeGreaterThan(0);
      expect(Math.abs(view.nationArea[n] - area) / area).toBeLessThan(1e-4);
      expect(politics.r_nation[view.nationLabel_r[n]]).toBe(n);
      expect(Number.isFinite(view.nationAxis[n])).toBe(true);
    }
    expect(view.nationLabel_r[3]).toBe(-1);
  });

  it('stays within a loose multiple of the 5 ms budget and reports its timing', () => {
    let best = ms;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      buildPoliticalView(world);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    console.log(`[features] buildPoliticalView default: ${view.borders.length} borders, first call ${ms.toFixed(1)} ms, best of 4 ${best.toFixed(1)} ms (budget 5 ms)`);
    expect(best).toBeLessThan(200);
  });
});

describe('features (default world, counts and budget)', () => {
  const w = worlds[0];
  const { features } = w;

  it('produces a plausible feature set and stays within a loose multiple of the 15 ms budget', () => {
    let best = w.ms;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      extractFeatures({ mesh: w.mesh, edges: w.edges, geo: w.geo, params: w.params }, w.hydro);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    let waterlineCount = 0;
    for (const lines of features.waterlines) waterlineCount += lines.length;
    console.log(
      `[features] default: ${features.coast.length} coast loops, ${features.lakes.length} lakes, ` +
      `${features.rivers.length} rivers, ${waterlineCount} waterline polylines, ${features.seas.length} seas, ` +
      `${features.ranges.length} ranges; first call ${w.ms.toFixed(1)} ms, best of 4 ${best.toFixed(1)} ms (budget 15 ms)`,
    );
    expect(features.coast.length).toBeGreaterThanOrEqual(1);
    expect(features.rivers.length).toBeGreaterThanOrEqual(10);
    expect(best).toBeLessThan(200);
  });
});
