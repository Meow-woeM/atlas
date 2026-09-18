/**
 * gen/names.test.ts — stage 12 against real upstream data (points -> mesh -> noisy edges ->
 * elevation -> distance field -> climate -> hydrology -> biomes -> features -> provinces ->
 * settlements -> nations) at DEFAULT_PARAMS and at a small 400x300 / spacing-16 /
 * provinceSpacing-40 world. Worlds are built once at module load; per-element invariants are
 * counted in plain loops and asserted once. Nothing here depends on how many settlements exist or
 * which cells they occupy. The tributary rule is asserted deterministically on a hand-built river
 * pair whose seed is chosen so that the documented first draw of the child's fork falls under
 * (and, for the negative case, over) the 30% threshold.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { Geography, Language, Mesh, NoisyEdges, World, WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh } from '../mesh/dualmesh';
import { buildNoisyEdges } from '../mesh/noisy';
import { computeElevation, computeDistanceField } from './elevation';
import { computeTectonics } from './tectonics';
import { computeBiomes, computeClimate } from './climate';
import { computeHydrology } from './hydrology';
import { extractFeatures } from './features';
import { computeProvinces } from './provinces';
import { placeSettlements } from './settlements';
import { foundNations } from './politics';
import { assignNames, worldTitle } from './names';

const SEED = 'atlas-12';
const SMALL: WorldParams = {
  ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16, provinceSpacing: 40,
};

interface Built {
  label: string;
  world: World;
  ms: number;          // assignNames, first call
  buildMs: number;     // everything before assignNames
}

function buildGeography(params: WorldParams, seed: string): { mesh: Mesh; edges: NoisyEdges; geo: Geography; hydro: ReturnType<typeof computeHydrology> } {
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
    windDir: climate.windDir, distField,
  };
  return { mesh, edges, geo, hydro };
}

/** The whole pipeline through stage 11, names still ''. */
function buildUnnamed(params: WorldParams, seed: string): World {
  const { mesh, edges, geo, hydro } = buildGeography(params, seed);
  const features = extractFeatures({ mesh, edges, geo, params }, hydro);
  const { provinces, r_province, graph } = computeProvinces(mesh, edges, params, geo, fork(seed, 'provinces'));
  const { settlements, r_settlement } = placeSettlements(mesh, params, geo, provinces, r_province, fork(seed, 'settlements'));
  const { politics, events } = foundNations(
    mesh, params, geo, provinces, graph, r_province, settlements, r_settlement, fork(seed, 'politics'),
  );
  return {
    seed, params, mesh, edges, geo, features, provinces, graph, r_province, settlements, politics,
    history: { events }, timings: {},
  };
}

function build(label: string, params: WorldParams, seed: string): Built {
  const t0 = performance.now();
  const world = buildUnnamed(params, seed);
  const buildMs = performance.now() - t0;
  const t1 = performance.now();
  assignNames(world);
  const ms = performance.now() - t1;
  return { label, world, ms, buildMs };
}

/** A copy sharing every typed array but with fresh entity objects, so assignNames on it leaves the original alone. */
function cloneNamed(w: World): World {
  return {
    ...w,
    settlements: w.settlements.map((s) => ({ ...s })),
    provinces: w.provinces.map((p) => ({ ...p })),
    politics: {
      ...w.politics,
      cultures: w.politics.cultures.map((c) => ({ ...c })),
      nations: w.politics.nations.map((n) => ({ ...n })),
    },
    features: {
      ...w.features,
      rivers: w.features.rivers.map((r) => ({ ...r })),
      lakes: w.features.lakes.map((l) => ({ ...l })),
      seas: w.features.seas.map((s) => ({ ...s })),
      ranges: w.features.ranges.map((g) => ({ ...g })),
    },
  };
}

/** Every name of every kind, in a fixed order, for whole-world comparisons. */
function allNames(w: World): string[] {
  const out: string[] = [];
  for (const c of w.politics.cultures) out.push('culture:' + c.name);
  for (const s of w.settlements) out.push('settlement:' + s.name);
  for (const n of w.politics.nations) out.push('nation:' + n.name);
  for (const p of w.provinces) out.push('province:' + p.name);
  for (const r of w.features.rivers) out.push('river:' + r.name);
  for (const l of w.features.lakes) out.push('lake:' + l.name);
  for (const s of w.features.seas) out.push('sea:' + s.name);
  for (const g of w.features.ranges) out.push('range:' + g.name);
  return out;
}

function isDerived(child: string, parent: string): boolean {
  return child === 'Little ' + parent || child === parent + ' Fork' || child === 'Upper ' + parent;
}

/** Largest nation by owned province count, lowest id on ties; -1 without nations. */
function largestNation(w: World): number {
  const { nations, p_nation } = w.politics;
  const counts = new Int32Array(nations.length);
  for (let p = 0; p < p_nation.length; p++) if (p_nation[p] >= 0) counts[p_nation[p]]++;
  let best = -1;
  for (let n = 0; n < nations.length; n++) if (best < 0 || counts[n] > counts[best]) best = n;
  return best;
}

function languageIsReal(lang: Language): boolean {
  if (lang.consonants.length === 0 || lang.vowels.length === 0) return false;
  const inventories = [lang.consonants, lang.vowels, lang.sibilants, lang.liquids, lang.finals];
  for (const list of inventories) for (const p of list) if (lang.ortho[p] === undefined) return false;
  return true;
}

const worlds: Built[] = [
  build('default', DEFAULT_PARAMS, SEED),
  build('small', SMALL, SEED),
];

for (const w of worlds) {
  describe(`names (${w.label})`, () => {
    const { world } = w;
    const { cultures, nations } = world.politics;

    it('gives every entity of every kind a non-empty name', () => {
      let empty = 0, total = 0;
      const check = (name: string): void => {
        total++;
        if (name === '' || name.trim() !== name) empty++;
      };
      for (const c of cultures) check(c.name);
      for (const s of world.settlements) check(s.name);
      for (const n of nations) check(n.name);
      for (const p of world.provinces) check(p.name);
      for (const r of world.features.rivers) check(r.name);
      for (const l of world.features.lakes) check(l.name);
      for (const s of world.features.seas) check(s.name);
      for (const g of world.features.ranges) check(g.name);
      expect(total).toBeGreaterThan(0);
      expect(empty).toBe(0);
    });

    it('replaces every culture\'s placeholder language with a real one', () => {
      expect(cultures.length).toBeGreaterThan(0);
      let fake = 0;
      for (const c of cultures) if (!languageIsReal(c.language)) fake++;
      expect(fake).toBe(0);
    });

    it('has no duplicate settlement, nation, province or river names (case-insensitive)', () => {
      const seen = new Set<string>();
      let dup = 0;
      const check = (name: string): void => {
        const key = name.toLowerCase();
        if (seen.has(key)) dup++;
        seen.add(key);
      };
      for (const s of world.settlements) check(s.name);
      for (const n of nations) check(n.name);
      for (const p of world.provinces) check(p.name);
      for (const r of world.features.rivers) check(r.name);
      expect(dup).toBe(0);
    });

    it('is deterministic: a second assignNames on a fresh copy reproduces every name', () => {
      const again = cloneNamed(world);
      // The copies still carry the finished names; blank them so the run starts from stage-11 state.
      for (const c of again.politics.cultures) c.name = '';
      for (const s of again.settlements) s.name = '';
      for (const n of again.politics.nations) n.name = '';
      for (const p of again.provinces) p.name = '';
      for (const r of again.features.rivers) r.name = '';
      for (const l of again.features.lakes) l.name = '';
      for (const s of again.features.seas) s.name = '';
      for (const g of again.features.ranges) g.name = '';
      assignNames(again);
      expect(allNames(again)).toEqual(allNames(world));
      let langDiff = 0;
      for (let i = 0; i < cultures.length; i++) {
        if (JSON.stringify(again.politics.cultures[i].language) !== JSON.stringify(cultures[i].language)) langDiff++;
      }
      expect(langDiff).toBe(0);
    });

    it('titles the world: non-empty, stable, pure, and carrying the largest nation\'s name', () => {
      const before = allNames(world);
      const title = worldTitle(world);
      expect(title.length).toBeGreaterThan(0);
      expect(worldTitle(world)).toBe(title);
      expect(allNames(world)).toEqual(before);
      const big = largestNation(world);
      expect(big).toBeGreaterThanOrEqual(0);
      expect(title).toContain(nations[big].name);
    });
  });
}

describe('names (small world, cross-seed and rebuild)', () => {
  const w = worlds[1];

  it('two independently generated worlds from the same seed get identical names and title', () => {
    const rebuilt = buildUnnamed(SMALL, SEED);
    assignNames(rebuilt);
    expect(allNames(rebuilt)).toEqual(allNames(w.world));
    expect(worldTitle(rebuilt)).toBe(worldTitle(w.world));
  });

  it('a different seed gives different names', () => {
    const other = buildUnnamed(SMALL, SEED + '-other');
    assignNames(other);
    const a = allNames(w.world);
    const b = allNames(other);
    let same = 0;
    const setB = new Set(b);
    for (const name of a) if (setB.has(name)) same++;
    expect(same).toBeLessThan(a.length / 2);
  });
});

describe('names (tributaries)', () => {
  const w = worlds[0];

  it('derives at least some tributary names from their parents at DEFAULT_PARAMS', () => {
    const rivers = w.world.features.rivers;
    let tributaries = 0, derived = 0, badParentOrder = 0;
    for (const r of rivers) {
      if (r.parent < 0) continue;
      tributaries++;
      const parent = rivers[r.parent];
      if (isDerived(r.name, parent.name)) derived++;
      // A parent that is itself derived from its own parent is fine; a child derived from an
      // unnamed parent is not (parents are named first).
      if (parent.name === '') badParentOrder++;
    }
    console.log(`[names] default: ${rivers.length} rivers, ${tributaries} tributaries, ${derived} derived names`);
    expect(badParentOrder).toBe(0);
    if (tributaries >= 8) expect(derived).toBeGreaterThanOrEqual(1);
  });

  it('a hand-built river pair follows the 30% rule exactly, both ways', () => {
    const rivers = w.world.features.rivers;
    expect(rivers.length).toBeGreaterThanOrEqual(2);
    // Seeds whose river:1 fork opens below / above the threshold decide the two cases.
    let seedYes = '', seedNo = '';
    for (let k = 0; k < 64 && (seedYes === '' || seedNo === ''); k++) {
      const seed = 'trib-' + k;
      const u = fork(seed, 'names', 'river:1').next();
      if (u < 0.3 && seedYes === '') seedYes = seed;
      if (u >= 0.3 && seedNo === '') seedNo = seed;
    }
    expect(seedYes).not.toBe('');
    expect(seedNo).not.toBe('');
    for (const [seed, expectDerived] of [[seedYes, true], [seedNo, false]] as const) {
      const pair = cloneNamed(w.world);
      pair.seed = seed;
      pair.features.rivers = [
        { ...rivers[0], id: 0, name: '', parent: -1 },
        { ...rivers[1], id: 1, name: '', parent: 0 },
      ];
      pair.features.riverPaths = [w.world.features.riverPaths[0], w.world.features.riverPaths[1]];
      assignNames(pair);
      const [parent, child] = pair.features.rivers;
      expect(parent.name).not.toBe('');
      expect(isDerived(child.name, parent.name)).toBe(expectDerived);
    }
  });
});

describe('names (degenerate worlds)', () => {
  const w = worlds[1];

  it('names everything and titles "The Unnamed Lands" when there are no cultures or nations', () => {
    const bare = cloneNamed(w.world);
    bare.settlements = [];
    bare.politics = {
      ...bare.politics, cultures: [], nations: [],
      p_nation: new Int16Array(bare.provinces.length).fill(-1),
      p_culture: new Int16Array(bare.provinces.length).fill(-1),
    };
    for (const p of bare.provinces) { p.name = ''; p.seat = -1; }
    for (const r of bare.features.rivers) r.name = '';
    for (const l of bare.features.lakes) l.name = '';
    for (const s of bare.features.seas) s.name = '';
    for (const g of bare.features.ranges) g.name = '';
    assignNames(bare);
    let empty = 0;
    for (const p of bare.provinces) if (p.name === '') empty++;
    for (const r of bare.features.rivers) if (r.name === '') empty++;
    for (const l of bare.features.lakes) if (l.name === '') empty++;
    for (const s of bare.features.seas) if (s.name === '') empty++;
    for (const g of bare.features.ranges) if (g.name === '') empty++;
    expect(empty).toBe(0);
    expect(worldTitle(bare)).toBe('The Unnamed Lands');
  });

  it('titles an unnamed world non-empty before assignNames has run', () => {
    const blank = buildUnnamed(SMALL, SEED);
    expect(worldTitle(blank)).toBe('The Unnamed Lands');
  });
});

describe('names (default world, counts and budget)', () => {
  const w = worlds[0];

  it('stays within a loose multiple of the 3 ms budget and reports its timing', () => {
    let best = w.ms;
    for (let i = 0; i < 3; i++) {
      const again = cloneNamed(w.world);
      const t0 = performance.now();
      assignNames(again);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    const { world } = w;
    console.log(
      `[names] default: ${world.politics.cultures.length} cultures, ${world.settlements.length} settlements, ` +
      `${world.politics.nations.length} nations, ${world.provinces.length} provinces, ${world.features.rivers.length} rivers, ` +
      `${world.features.lakes.length} lakes, ${world.features.seas.length} seas, ${world.features.ranges.length} ranges; ` +
      `pipeline ${w.buildMs.toFixed(0)} ms, assignNames first call ${w.ms.toFixed(1)} ms, best of 4 ${best.toFixed(1)} ms (budget 3 ms); ` +
      `title "${worldTitle(world)}"`,
    );
    const sample = (label: string, names: string[]): string => `${label} ${names.slice(0, 5).join(', ')}`;
    console.log(
      '[names] sample: ' + [
        sample('cultures:', world.politics.cultures.map((c) => c.name)),
        sample('nations:', world.politics.nations.map((n) => n.name)),
        sample('settlements:', world.settlements.map((s) => s.name)),
        sample('provinces:', world.provinces.map((p) => p.name)),
        sample('rivers:', world.features.rivers.map((r) => r.name)),
        sample('lakes:', world.features.lakes.map((l) => l.name)),
        sample('seas:', world.features.seas.map((s) => s.name)),
        sample('ranges:', world.features.ranges.map((g) => g.name)),
      ].join(' | '),
    );
    expect(best).toBeLessThan(200);
  });
});
