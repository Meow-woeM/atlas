/**
 * gen/world.test.ts — generate() end to end: determinism (two runs of 'test-1' are identical in
 * every typed array and every name), the stage timings (14 keys, printed for DEFAULT_PARAMS and
 * cellSpacing 12; the cellSpacing-12 bound is self-calibrated: best-of-3 x 3 or 500 ms, whichever
 * is larger, so a slow CI box passes and a pathological 10x outlier does not), the stage-15 log
 * (world.created first, seqs 0..n-1, every cause earlier than its event), the save-file round
 * trip, withParams leaving DEFAULT_PARAMS untouched, and the reverted-lake patch (hydrology's
 * revertedCells are the only cells whose elevation differs from stage 4; each is land, above 0,
 * with coast hops 1 + min neighbour hops; r_slope is exact everywhere). Worlds are built once at
 * module load and reused; per-element checks are counted and asserted once.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { ATLAS_VERSION, DEFAULT_PARAMS } from '../core/types';
import type { WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, r_circulate_r } from '../mesh/dualmesh';
import { computeElevation, computeDistanceField } from './elevation';
import { computeClimate } from './climate';
import { computeHydrology } from './hydrology';
import { fromWorldFile, generate, toWorldFile, withParams } from './world';

const SEED = 'test-1';
const STAGE_KEYS = [
  'points', 'mesh', 'edges', 'elevation', 'distance', 'climate', 'hydrology', 'biomes',
  'features', 'provinces', 'settlements', 'politics', 'names', 'history',
] as const;

const defaultsSnapshot = JSON.stringify(DEFAULT_PARAMS);

const worldA = generate(SEED);
const worldB = generate(SEED);

// cellSpacing 12: best of 3 for the self-calibrated bound; the first is kept for its timings.
const smallRuns: number[] = [];
let smallWorld = worldA;
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  const w = generate(SEED, { cellSpacing: 12 });
  smallRuns.push(performance.now() - t0);
  if (i === 0) smallWorld = w;
}

// ---------------------------------------------------------------- deep comparison

interface Diff { count: number; first: string }

function isTyped(v: unknown): v is ArrayLike<number> {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function record(diff: Diff, path: string): void {
  if (diff.count === 0) diff.first = path;
  diff.count++;
}

/** Recursive structural comparison: typed arrays elementwise, arrays and POJOs by key. */
function compare(a: unknown, b: unknown, path: string, diff: Diff): void {
  if (isTyped(a) || isTyped(b)) {
    if (!isTyped(a) || !isTyped(b) || a.constructor !== b.constructor || a.length !== b.length) {
      record(diff, path + ' (typed array shape)');
      return;
    }
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) {
        record(diff, path + '[' + i + ']');
        return;
      }
    }
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      record(diff, path + ' (array length)');
      return;
    }
    for (let i = 0; i < a.length; i++) compare(a[i], b[i], path + '[' + i + ']', diff);
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
    for (const k of keys) compare(oa[k], ob[k], path + '.' + k, diff);
    return;
  }
  if (a !== b && !(typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))) {
    record(diff, path);
  }
}

function fmtTimings(label: string, timings: Record<string, number>): string {
  const lines = [label];
  let sum = 0;
  for (const [k, v] of Object.entries(timings)) {
    lines.push('  ' + k.padEnd(12) + v.toFixed(1).padStart(8) + ' ms');
    sum += v;
  }
  lines.push('  ' + 'total'.padEnd(12) + sum.toFixed(1).padStart(8) + ' ms');
  return lines.join('\n');
}

// ---------------------------------------------------------------- tests

describe('generate: determinism', () => {
  it('two runs of the same seed are identical in every typed array and every POJO', () => {
    const diff: Diff = { count: 0, first: '' };
    compare(worldA.mesh, worldB.mesh, 'mesh', diff);
    compare(worldA.edges, worldB.edges, 'edges', diff);
    compare(worldA.geo, worldB.geo, 'geo', diff);
    compare(worldA.r_province, worldB.r_province, 'r_province', diff);
    compare(worldA.politics, worldB.politics, 'politics', diff);
    compare(worldA.provinces, worldB.provinces, 'provinces', diff);
    compare(worldA.graph, worldB.graph, 'graph', diff);
    compare(worldA.settlements, worldB.settlements, 'settlements', diff);
    compare(worldA.features, worldB.features, 'features', diff);
    compare(worldA.history, worldB.history, 'history', diff);
    expect(diff.count, 'first difference at ' + diff.first).toBe(0);
    expect(worldA.mesh.numRegions).toBeGreaterThan(5000);
  });

  it('names and the title agree between the two runs', () => {
    const names = (w: typeof worldA): string => JSON.stringify({
      settlements: w.settlements.map((s) => s.name),
      provinces: w.provinces.map((p) => p.name),
      nations: w.politics.nations.map((n) => n.name),
      cultures: w.politics.cultures.map((c) => c.name),
      rivers: w.features.rivers.map((r) => r.name),
      lakes: w.features.lakes.map((l) => l.name),
      seas: w.features.seas.map((s) => s.name),
      ranges: w.features.ranges.map((r) => r.name),
      title: w.history.events[0].data.title,
    });
    expect(names(worldA)).toBe(names(worldB));
    expect(worldA.seed).toBe(SEED);
    expect(worldA.params.version).toBe(ATLAS_VERSION);
  });

  it('every name is non-empty and there is a real world', () => {
    let empty = 0;
    for (const s of worldA.settlements) if (s.name === '') empty++;
    for (const p of worldA.provinces) if (p.name === '') empty++;
    for (const n of worldA.politics.nations) if (n.name === '') empty++;
    for (const c of worldA.politics.cultures) if (c.name === '') empty++;
    for (const r of worldA.features.rivers) if (r.name === '') empty++;
    for (const l of worldA.features.lakes) if (l.name === '') empty++;
    expect(empty).toBe(0);
    expect(worldA.settlements.length).toBeGreaterThanOrEqual(15);
    expect(worldA.politics.nations.length).toBeGreaterThanOrEqual(3);
    expect(worldA.features.rivers.length).toBeGreaterThan(0);
    expect(worldA.provinces.length).toBeGreaterThan(20);
  });
});

describe('generate: timings', () => {
  it('records all 14 stage keys as finite non-negative numbers, in execution order', () => {
    const keys = Object.keys(worldA.timings);
    expect(keys).toEqual([...STAGE_KEYS]);
    let bad = 0;
    for (const k of STAGE_KEYS) {
      const v = worldA.timings[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad++;
    }
    expect(bad).toBe(0);
    expect(Object.getPrototypeOf(worldA.timings)).toBe(Object.prototype);
  });

  it('cellSpacing 12 generates within the self-calibrated bound (prints stage timings)', () => {
    console.log(fmtTimings('generate(' + SEED + ') at DEFAULT_PARAMS (' + worldA.mesh.numRegions + ' cells)', worldA.timings));
    console.log(fmtTimings('generate(' + SEED + ') at cellSpacing 12 (' + smallWorld.mesh.numRegions + ' cells)', smallWorld.timings));
    const best = Math.min(...smallRuns);
    const worst = Math.max(...smallRuns);
    const bound = Math.max(3 * best, 500);
    console.log('cellSpacing 12 runs: ' + smallRuns.map((ms) => ms.toFixed(1)).join(' / ') +
      ' ms; bound ' + bound.toFixed(0) + ' ms');
    expect(worst, 'best ' + best.toFixed(1) + ' ms, worst ' + worst.toFixed(1) + ' ms').toBeLessThan(bound);
    expect(smallWorld.mesh.numRegions).toBeLessThan(worldA.mesh.numRegions);
    expect(smallWorld.settlements.length).toBeGreaterThan(0);
  });
});

describe('generate: history log', () => {
  it('starts with world.created, numbers seqs 0..n-1 and keeps every cause earlier than its event', () => {
    const events = worldA.history.events;
    expect(events.length).toBeGreaterThan(1);
    expect(events[0].kind).toBe('world.created');
    expect(events[0].seq).toBe(0);
    expect(events[0].year).toBe(0);
    expect(events[0].subjects).toEqual([]);
    expect(events[0].data.seed).toBe(SEED);
    expect(typeof events[0].data.title).toBe('string');
    expect(events[0].data.title).not.toBe('');
    let badSeq = 0;
    let badCause = 0;
    let badYear = 0;
    let causes = 0;
    const kinds = new Set<string>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      kinds.add(e.kind);
      if (e.seq !== i) badSeq++;
      if (e.year !== 0) badYear++;
      if (e.cause !== undefined) {
        causes++;
        if (!(e.cause < e.seq) || e.cause < 0) badCause++;
      }
    }
    expect(badSeq).toBe(0);
    expect(badYear).toBe(0);
    expect(badCause).toBe(0);
    expect(causes).toBeGreaterThan(0);
    for (const k of ['culture.emerged', 'nation.founded', 'province.claimed', 'settlement.founded']) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it('province.claimed causes point at the founding of the owning nation', () => {
    const events = worldA.history.events;
    let bad = 0;
    let checked = 0;
    for (const e of events) {
      if (e.kind !== 'province.claimed' || e.cause === undefined) continue;
      checked++;
      const cause = events[e.cause];
      if (cause.kind !== 'nation.founded' || cause.subjects[0] !== e.subjects[1]) bad++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(bad).toBe(0);
  });
});

describe('save file', () => {
  it('toWorldFile -> fromWorldFile round-trips p_nation, p_culture, year and events', () => {
    const file = toWorldFile(worldA);
    expect(file.v).toBe(ATLAS_VERSION);
    expect(file.seed).toBe(SEED);
    expect(file.politics).toBeDefined();
    expect(typeof file.politics?.p_nation).toBe('string');
    // The file must survive JSON.
    const parsed = JSON.parse(JSON.stringify(file)) as typeof file;
    // Perturb the politics so the restore is observable, not just a regeneration.
    const mutated = generate(SEED);
    mutated.politics.year = 137;
    mutated.politics.p_nation[0] = -1;
    mutated.politics.p_culture[mutated.politics.p_culture.length - 1] = 0;
    mutated.history.events.push({
      seq: mutated.history.events.length, year: 137, kind: 'plague', subjects: ['province:0'], data: { dead: 3 },
    });
    const mutatedFile = JSON.parse(JSON.stringify(toWorldFile(mutated))) as typeof file;
    const restored = fromWorldFile(mutatedFile);

    const diff: Diff = { count: 0, first: '' };
    compare(restored.politics.p_nation, mutated.politics.p_nation, 'p_nation', diff);
    compare(restored.politics.p_culture, mutated.politics.p_culture, 'p_culture', diff);
    compare(restored.history.events, mutated.history.events, 'events', diff);
    expect(diff.count, 'first difference at ' + diff.first).toBe(0);
    expect(restored.politics.year).toBe(137);
    expect(restored.history.events.length).toBe(worldA.history.events.length + 1);
    // r_nation follows the restored p_nation through r_province.
    let bad = 0;
    for (let r = 0; r < restored.mesh.numRegions; r++) {
      const p = restored.r_province[r];
      const expected = p < 0 ? -1 : restored.politics.p_nation[p];
      if (restored.politics.r_nation[r] !== expected) bad++;
    }
    expect(bad).toBe(0);
    // A clean file reproduces the original politics exactly.
    const clean = fromWorldFile(parsed);
    const diff2: Diff = { count: 0, first: '' };
    compare(clean.politics, worldA.politics, 'politics', diff2);
    compare(clean.history, worldA.history, 'history', diff2);
    expect(diff2.count, 'first difference at ' + diff2.first).toBe(0);
  });

  it('refuses a file from another version', () => {
    const file = toWorldFile(smallWorld);
    file.v = ATLAS_VERSION + 1;
    expect(() => fromWorldFile(file)).toThrow();
  });
});

describe('withParams', () => {
  it('merges overrides, deep-copies the frame, forces the version and leaves DEFAULT_PARAMS untouched', () => {
    const p = withParams({ cellSpacing: 12, version: 999, frame: { lon0: 0, lon1: 10, lat0: 50, lat1: 40 } });
    expect(p.cellSpacing).toBe(12);
    expect(p.version).toBe(ATLAS_VERSION);
    expect(p.frame).toEqual({ lon0: 0, lon1: 10, lat0: 50, lat1: 40 });
    expect(p.landFraction).toBe(DEFAULT_PARAMS.landFraction);
    p.frame.lon0 = -99;
    p.landFraction = 0.9;
    const q = withParams({});
    expect(q).toEqual(DEFAULT_PARAMS);
    expect(q.frame).not.toBe(DEFAULT_PARAMS.frame);
    q.frame.lat0 = 1;
    const partial: Partial<WorldParams> = { cellSpacing: undefined, windDir: 3 };
    const r = withParams(partial);
    expect(r.cellSpacing).toBe(DEFAULT_PARAMS.cellSpacing);
    expect(r.windDir).toBe(3);
    expect(JSON.stringify(DEFAULT_PARAMS)).toBe(defaultsSnapshot);
    expect(worldA.params).not.toBe(DEFAULT_PARAMS);
    expect(worldA.params.frame).not.toBe(DEFAULT_PARAMS.frame);
  });
});

describe('geography assembly', () => {
  // Rebuild stages 4-7 with the same forks to learn which cells hydrology reverted.
  const params = withParams({});
  const { points, numBoundary } = generatePoints(params, fork(SEED, 'points'));
  const mesh = buildMesh(points, numBoundary);
  const elev = computeElevation(mesh, params, fork(SEED, 'elevation'));
  const { r_coastDist } = computeDistanceField(mesh, params, elev.r_water);
  const climate = computeClimate(
    mesh, params,
    { r_elevation: elev.r_elevation, r_water: elev.r_water, r_coastDist, r_lat: elev.r_lat },
    fork(SEED, 'climate'),
  );
  const hydro = computeHydrology(mesh, params, elev.r_elevation, elev.r_water, climate.r_moisture);
  const reverted = hydro.revertedCells;
  const geo = worldA.geo;

  it('lifts exactly the reverted lake candidates onto land, above sea level', () => {
    expect(mesh.numRegions).toBe(worldA.mesh.numRegions);
    const isReverted = new Uint8Array(mesh.numRegions);
    for (let k = 0; k < reverted.length; k++) isReverted[reverted[k]] = 1;
    let changed = 0;
    let badReverted = 0;
    let landBelowZero = 0;
    let oceanAboveZero = 0;
    let lakeAboveZero = 0;
    for (let r = 0; r < mesh.numRegions; r++) {
      if (geo.r_elevation[r] !== elev.r_elevation[r]) changed++;
      if (geo.r_water[r] !== hydro.r_water[r]) badReverted++;
      if (geo.r_water[r] === 0 && !(geo.r_elevation[r] > 0)) landBelowZero++;
      if (geo.r_water[r] === 1 && !(geo.r_elevation[r] < 0)) oceanAboveZero++;
      if (geo.r_water[r] === 2 && !(geo.r_elevation[r] < 0)) lakeAboveZero++;
    }
    for (let k = 0; k < reverted.length; k++) {
      const r = reverted[k];
      if (geo.r_water[r] !== 0 || !(geo.r_elevation[r] > 0) || geo.r_elevation[r] < 0.005) badReverted++;
      if (!(elev.r_elevation[r] < 0)) badReverted++;
    }
    console.log('reverted lake candidates in ' + SEED + ': ' + reverted.length +
      '; lake cells that were land in stage 4 (positive elevation, expected): ' + lakeAboveZero);
    expect(changed).toBe(reverted.length);
    expect(badReverted).toBe(0);
    expect(landBelowZero).toBe(0);
    expect(oceanAboveZero).toBe(0);
  });

  it('keeps r_slope exact everywhere and r_coastHops = 1 + min neighbour hops on land', () => {
    const nbrs: number[] = [];
    let badSlope = 0;
    let badHops = 0;
    for (let r = 0; r < mesh.numRegions; r++) {
      r_circulate_r(mesh, r, nbrs);
      let m = 0;
      let minHops = 0x7fff;
      for (let i = 0; i < nbrs.length; i++) {
        const d = Math.abs(geo.r_elevation[r] - geo.r_elevation[nbrs[i]]);
        if (d > m) m = d;
        if (geo.r_coastHops[nbrs[i]] < minHops) minHops = geo.r_coastHops[nbrs[i]];
      }
      if (Math.abs(geo.r_slope[r] - m) > 1e-6) badSlope++;
      if (geo.r_water[r] === 1) {
        if (geo.r_coastHops[r] !== 0) badHops++;
      } else if (geo.r_coastHops[r] !== minHops + 1) {
        badHops++;
      }
    }
    expect(badSlope).toBe(0);
    expect(badHops).toBe(0);
  });

  it('biomes see hydrology: lake cells are lake, ocean cells are ocean, land is neither', () => {
    let bad = 0;
    for (let r = 0; r < mesh.numRegions; r++) {
      const w = geo.r_water[r];
      const b = geo.r_biome[r];
      if (w === 1 && b !== 0) bad++;
      if (w === 2 && b !== 1) bad++;
      if (w === 0 && (b === 0 || b === 1)) bad++;
    }
    expect(bad).toBe(0);
  });
});
