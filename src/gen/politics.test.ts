/**
 * gen/politics.test.ts — stage 11 against real upstream data (points -> mesh -> noisy edges ->
 * elevation -> distance field -> climate -> hydrology -> biomes -> provinces -> settlements) at
 * DEFAULT_PARAMS and at a small 400x300 / spacing-16 / provinceSpacing-40 world. Worlds are built
 * once at module load; per-element invariants are counted in plain loops and asserted once. The
 * section-10 invariants (every province with a settlement has a nation, r_nation mirrors p_nation
 * through r_province, every province.claimed subject is owned by its nation) are here, plus the
 * capital-selection rule re-derived independently and the connectivity of every nation.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type {
  Geography, Mesh, NoisyEdges, Politics, Province, ProvinceGraph, Settlement, WorldEvent, WorldParams,
} from '../core/types';
import { parseId } from '../core/ids';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, r_circulate_r } from '../mesh/dualmesh';
import { buildNoisyEdges } from '../mesh/noisy';
import { computeElevation, computeDistanceField } from './elevation';
import { computeTectonics } from './tectonics';
import { computeClimate, computeBiomes } from './climate';
import { computeHydrology } from './hydrology';
import { computeProvinces } from './provinces';
import { placeSettlements, scoreCell } from './settlements';
import { derivePolitics, foundNations, NATION_COLORS } from './politics';

const SEED = 'atlas-11';
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
  settlements: Settlement[];
  r_settlement: Int16Array;
  politics: Politics;
  events: WorldEvent[];
  ms: number;
  // Snapshots taken before foundNations ran.
  provinceBefore: Int16Array;
  settlementBefore: Int16Array;
  settlementsJsonBefore: string[];   // per settlement, with culture blanked
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

function withoutCulture(s: Settlement): string {
  return JSON.stringify({ ...s, culture: 0 });
}

function build(label: string, params: WorldParams, seed: string): Built {
  const { mesh, edges, geo } = buildGeography(params, seed);
  const { provinces, r_province, graph } = computeProvinces(mesh, edges, params, geo, fork(seed, 'provinces'));
  const { settlements, r_settlement } = placeSettlements(mesh, params, geo, provinces, r_province, fork(seed, 'settlements'));
  const provinceBefore = r_province.slice();
  const settlementBefore = r_settlement.slice();
  const settlementsJsonBefore = settlements.map(withoutCulture);
  const t0 = performance.now();
  const { politics, events } = foundNations(
    mesh, params, geo, provinces, graph, r_province, settlements, r_settlement, fork(seed, 'politics'),
  );
  const ms = performance.now() - t0;
  return {
    label, params, mesh, edges, geo, provinces, r_province, graph, settlements, r_settlement, politics, events, ms,
    provinceBefore, settlementBefore, settlementsJsonBefore,
  };
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** BFS hop depth over land cells from `start`; -1 where unreached. */
function landDepths(mesh: Mesh, geo: Geography, start: number): Int32Array {
  const nr = mesh.numRegions;
  const depth = new Int32Array(nr).fill(-1);
  const queue: number[] = [start];
  const nbrs: number[] = [];
  depth[start] = 0;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    r_circulate_r(mesh, u, nbrs);
    for (const v of nbrs) {
      if (geo.r_water[v] !== 0 || depth[v] >= 0) continue;
      depth[v] = depth[u] + 1;
      queue.push(v);
    }
  }
  return depth;
}

/** The stage-11 capital rule re-derived: best scores first, one per province, >= H hops apart. */
function expectedCapitals(w: Built): number[] {
  const { mesh, geo, settlements, params } = w;
  const n = settlements.length;
  const K = Math.min(Math.max(Math.round(n / 5), 3), params.nationsMax);
  const H = Math.round(150 / params.cellSpacing);
  const sc = settlements.map((s) => scoreCell(mesh, geo, s.r));
  const order = settlements.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b);
  const chosen: number[] = [];
  const depths: Int32Array[] = [];
  const provinceTaken = new Set<number>();
  for (const i of order) {
    if (chosen.length >= K) break;
    const s = settlements[i];
    if (provinceTaken.has(s.province)) continue;
    let close = false;
    for (const d of depths) if (d[s.r] >= 0 && d[s.r] < H) close = true;
    if (close) continue;
    chosen.push(i);
    provinceTaken.add(s.province);
    depths.push(landDepths(mesh, geo, s.r));
  }
  return chosen;
}

const worlds: Built[] = [
  build('default', DEFAULT_PARAMS, SEED),
  build('small', SMALL, SEED),
];

describe('NATION_COLORS', () => {
  it('has at least 12 distinct css colors', () => {
    expect(NATION_COLORS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(NATION_COLORS).size).toBe(NATION_COLORS.length);
    for (const c of NATION_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

for (const w of worlds) {
  describe(`politics (${w.label})`, () => {
    const { mesh, geo, provinces, r_province, graph, settlements, politics, events } = w;
    const { nations, cultures, p_nation, p_culture, r_nation } = politics;
    const nr = mesh.numRegions;
    const numP = provinces.length;
    const primary = expectedCapitals(w);

    it('reports counts and timing', () => {
      const K = Math.min(Math.max(Math.round(settlements.length / 5), 3), w.params.nationsMax);
      let owned = 0, unclaimed = 0;
      for (let p = 0; p < numP; p++) if (p_nation[p] >= 0) owned++; else unclaimed++;
      console.log(
        `politics (${w.label}): ${nations.length} nations (${primary.length} primary of target ${K}, ` +
        `${nations.length - primary.length} free cities), ${cultures.length} cultures, ` +
        `${owned} owned / ${unclaimed} unclaimed of ${numP} provinces, ${settlements.length} settlements, ` +
        `${events.length} events, ${w.ms.toFixed(2)} ms`,
      );
      expect(politics.year).toBe(0);
      expect(p_nation.length).toBe(numP);
      expect(p_culture.length).toBe(numP);
      expect(r_nation.length).toBe(nr);
      expect(politics.r_settlement).toBe(w.r_settlement);
    });

    it('founds between 3 and nationsMax primary nations at the defaults, plus free cities', () => {
      if (w.label === 'default') expect(primary.length).toBeGreaterThanOrEqual(3);
      expect(primary.length).toBeLessThanOrEqual(w.params.nationsMax);
      expect(nations.length).toBeGreaterThanOrEqual(primary.length);
      expect(nations.length).toBeLessThanOrEqual(w.params.nationsMax + (nations.length - primary.length));
    });

    it('chooses the primary capitals by score with spacing and one per province', () => {
      const actual = nations.slice(0, primary.length).map((nation) => nation.capital);
      expect(actual).toEqual(primary);
      const provincesOfCapitals = new Set(nations.map((nation) => settlements[nation.capital].province));
      expect(provincesOfCapitals.size).toBe(nations.length);
    });

    it('gives every province with a settlement a nation', () => {
      let bad = 0;
      for (let i = 0; i < settlements.length; i++) {
        if (p_nation[settlements[i].province] < 0) bad++;
      }
      expect(bad).toBe(0);
    });

    it('derives r_nation from p_nation through r_province, -1 on water', () => {
      let bad = 0;
      for (let r = 0; r < nr; r++) {
        const p = r_province[r];
        const expected = p < 0 ? -1 : p_nation[p];
        if (r_nation[r] !== expected) bad++;
        if (geo.r_water[r] !== 0 && r_nation[r] !== -1) bad++;
      }
      expect(bad).toBe(0);
    });

    it('has well-formed nations whose capitals are settlements inside their territory', () => {
      let bad = 0;
      for (let i = 0; i < nations.length; i++) {
        const nation = nations[i];
        if (nation.id !== i || nation.name !== '' || nation.founded !== 0 || nation.died !== -1) bad++;
        if (nation.color !== NATION_COLORS[i % NATION_COLORS.length]) bad++;
        if (nation.capital < 0 || nation.capital >= settlements.length) { bad++; continue; }
        if (p_nation[settlements[nation.capital].province] !== i) bad++;
        if (nation.culture !== i) bad++;
      }
      expect(bad).toBe(0);
    });

    it('has one culture per nation, homed at the capital province, with a placeholder language', () => {
      expect(cultures.length).toBe(nations.length);
      let bad = 0;
      const kinds = ['city', 'river', 'lake', 'sea', 'mount', 'wood', 'realm', 'port'] as const;
      for (let i = 0; i < cultures.length; i++) {
        const c = cultures[i];
        if (c.id !== i || c.name !== '' || c.color !== NATION_COLORS[i % NATION_COLORS.length]) bad++;
        if (c.home_p !== settlements[nations[i].capital].province) bad++;
        if (p_culture[c.home_p] !== i) bad++;
        const lang = c.language;
        if (lang.consonants.length !== 0 || lang.vowels.length !== 0 || lang.structure !== 'CV') bad++;
        if (lang.minSyl !== 1 || lang.maxSyl !== 2 || lang.joiner !== '' || Object.keys(lang.ortho).length !== 0) bad++;
        for (const k of kinds) if (!Array.isArray(lang.morphemes[k]) || lang.morphemes[k].length !== 0) bad++;
        for (let j = 0; j < i; j++) if (cultures[j].language === lang) bad++;   // fresh object each
      }
      expect(bad).toBe(0);
    });

    it('gives every owned province a culture and every settlement the culture of its province', () => {
      let bad = 0;
      for (let p = 0; p < numP; p++) {
        if (p_nation[p] >= 0 && p_culture[p] < 0) bad++;
        if (p_nation[p] >= numP || p_nation[p] >= nations.length) bad++;
        if (p_culture[p] >= cultures.length) bad++;
      }
      for (let i = 0; i < settlements.length; i++) {
        if (settlements[i].culture !== p_culture[settlements[i].province]) bad++;
      }
      expect(bad).toBe(0);
    });

    it('keeps every nation connected over the province graph', () => {
      const seen = new Uint8Array(numP);
      let disconnected = 0;
      for (let i = 0; i < nations.length; i++) {
        const start = settlements[nations[i].capital].province;
        const queue: number[] = [start];
        seen[start] = 1;
        for (let head = 0; head < queue.length; head++) {
          const u = queue[head];
          for (let k = graph.p_first[u]; k < graph.p_first[u + 1]; k++) {
            const v = graph.p_nbr[k];
            if (p_nation[v] !== i || seen[v]) continue;
            seen[v] = 1;
            queue.push(v);
          }
        }
      }
      for (let p = 0; p < numP; p++) if (p_nation[p] >= 0 && !seen[p]) disconnected++;
      expect(disconnected).toBe(0);
    });

    it('leaves unclaimed provinces only in components without settlements', () => {
      // Any unclaimed province's connected component (over unclaimed provinces) holds no settlement.
      const hasSettlement = new Uint8Array(numP);
      for (const s of settlements) hasSettlement[s.province] = 1;
      const seen = new Uint8Array(numP);
      let bad = 0;
      for (let p0 = 0; p0 < numP; p0++) {
        if (p_nation[p0] >= 0 || seen[p0]) continue;
        const queue: number[] = [p0];
        seen[p0] = 1;
        for (let head = 0; head < queue.length; head++) {
          const u = queue[head];
          if (hasSettlement[u]) bad++;
          for (let k = graph.p_first[u]; k < graph.p_first[u + 1]; k++) {
            const v = graph.p_nbr[k];
            if (p_nation[v] >= 0 || seen[v]) continue;
            seen[v] = 1;
            queue.push(v);
          }
        }
      }
      expect(bad).toBe(0);
    });

    it('emits well-formed year-0 events in order with provenance', () => {
      let badSeq = 0, badYear = 0;
      const counts: Record<string, number> = {};
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.seq !== i) badSeq++;
        if (e.year !== 0) badYear++;
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      }
      expect(badSeq).toBe(0);
      expect(badYear).toBe(0);
      let owned = 0;
      for (let p = 0; p < numP; p++) if (p_nation[p] >= 0) owned++;
      expect(counts['culture.emerged'] ?? 0).toBe(cultures.length);
      expect(counts['nation.founded'] ?? 0).toBe(nations.length);
      expect(counts['province.claimed'] ?? 0).toBe(owned);
      expect(counts['settlement.founded'] ?? 0).toBe(settlements.length);
      expect(Object.keys(counts).length).toBe(4);

      let bad = 0;
      for (const e of events) {
        if (e.kind === 'culture.emerged') {
          const c = parseId(e.subjects[0]);
          if (c.kind !== 'culture' || e.at !== settlements[nations[c.index].capital].r) bad++;
        } else if (e.kind === 'nation.founded') {
          const nat = parseId(e.subjects[0]);
          const cap = parseId(e.subjects[1]);
          if (nat.kind !== 'nation' || cap.kind !== 'settlement') { bad++; continue; }
          if (nations[nat.index].capital !== cap.index || e.at !== settlements[cap.index].r) bad++;
          if (e.data.capital !== cap.index) bad++;
        } else if (e.kind === 'province.claimed') {
          const prov = parseId(e.subjects[0]);
          const nat = parseId(e.subjects[1]);
          if (prov.kind !== 'province' || nat.kind !== 'nation') { bad++; continue; }
          if (p_nation[prov.index] !== nat.index) bad++;
          const cause = e.cause === undefined ? null : events[e.cause];
          if (cause === null || cause.kind !== 'nation.founded' || cause.subjects[0] !== `nation:${nat.index}`) bad++;
        } else if (e.kind === 'settlement.founded') {
          const s = parseId(e.subjects[0]);
          const prov = parseId(e.subjects[1]);
          if (s.kind !== 'settlement' || prov.kind !== 'province') { bad++; continue; }
          const st = settlements[s.index];
          if (st.province !== prov.index || e.at !== st.r) bad++;
          if (e.data.kind !== st.kind || e.data.population !== st.population) bad++;
        }
      }
      expect(bad).toBe(0);
    });

    it('leaves r_province, r_settlement and every settlement field but culture untouched', () => {
      expect(sameBytes(r_province, w.provinceBefore)).toBe(true);
      expect(sameBytes(w.r_settlement, w.settlementBefore)).toBe(true);
      expect(settlements.map(withoutCulture)).toEqual(w.settlementsJsonBefore);
    });

    it('derivePolitics refreshes r_nation in place after p_nation changes', () => {
      const copy: Politics = {
        ...politics, p_nation: p_nation.slice(), r_nation: r_nation.slice(),
      };
      // Hand the largest-index owned province to a different (or new) nation index.
      let p = numP - 1;
      while (p >= 0 && copy.p_nation[p] < 0) p--;
      expect(p).toBeGreaterThanOrEqual(0);
      const newNation = copy.p_nation[p] + 1;
      copy.p_nation[p] = newNation;
      derivePolitics(copy, r_province);
      let bad = 0, changed = 0;
      for (let r = 0; r < nr; r++) {
        const q = r_province[r];
        const expected = q < 0 ? -1 : copy.p_nation[q];
        if (copy.r_nation[r] !== expected) bad++;
        if (q === p) { changed++; if (copy.r_nation[r] !== newNation) bad++; }
      }
      expect(bad).toBe(0);
      expect(changed).toBe(provinces[p].cells.length);
      expect(copy.r_nation).not.toBe(r_nation);
      // Original untouched.
      expect(r_nation[provinces[p].cells[0]]).toBe(p_nation[p]);
      // A too-short r_nation is reallocated rather than written out of bounds.
      const short: Politics = { ...politics, r_nation: new Int16Array(0) };
      derivePolitics(short, r_province);
      expect(short.r_nation.length).toBe(nr);
      expect(sameBytes(short.r_nation, r_nation)).toBe(true);
    });

    it('is deterministic for the same inputs', () => {
      const again = foundNations(
        mesh, w.params, geo, provinces, graph, r_province, settlements, w.r_settlement, fork(SEED, 'politics'),
      );
      expect(JSON.stringify(again.politics.nations)).toBe(JSON.stringify(nations));
      expect(JSON.stringify(again.politics.cultures)).toBe(JSON.stringify(cultures));
      expect(JSON.stringify(again.events)).toBe(JSON.stringify(events));
      expect(sameBytes(again.politics.p_nation, p_nation)).toBe(true);
      expect(sameBytes(again.politics.p_culture, p_culture)).toBe(true);
      expect(sameBytes(again.politics.r_nation, r_nation)).toBe(true);
    });
  });
}
