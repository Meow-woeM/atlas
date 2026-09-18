/**
 * gen/politics.ts — Stage 11 (Cultures and nations).
 *
 * RNG stream: `politics` (the caller passes fork(seed, 'politics')). Day one draws NOTHING from
 * it: every choice below is a deterministic greedy pick or a Dijkstra whose ties break on the
 * smaller index through core/heap.ts. The parameter is kept so the call site and the stream name
 * are frozen for the history sim (src/sim/) that will draw dynastic randomness from it.
 *
 * Inputs:  Mesh, WorldParams (cellSpacing, nationsMax), Geography (r_water, r_elevation, r_biome
 *          and everything scoreCell reads), the stage-9 provinces / ProvinceGraph / r_province and
 *          the stage-10 settlements / r_settlement. Geography, provinces, graph, r_province and
 *          r_settlement are never mutated.
 *          INTENDED IN-PLACE FILL: settlements[i].culture is set to p_culture of the settlement's
 *          province (a founding fact; the only nation/culture index stored outside Politics).
 * Outputs: { politics, events } exactly as ARCHITECTURE.md section 7.1 declares them. Politics =
 *          { year 0, cultures, nations, p_nation, p_culture, r_nation (filled by derivePolitics),
 *          r_settlement (the array passed in, by reference: it is the world's single copy) }.
 *          cultures.length === nations.length always: culture i is nation i's culture, for the K
 *          primary nations and for every free city alike.
 *
 * Steps, as ARCHITECTURE.md section 5 "Stage 11" lists them, with the topology-only reading:
 *   1. Settlement scores = scoreCell(mesh, geo, r); settlement order = score desc, index asc
 *      (typed-array index sort).
 *   2. K = clamp(round(n / 5), 3, nationsMax). Capitals are taken greedily in that order: a
 *      settlement qualifies when its province holds no capital yet and no earlier capital lies
 *      within CAPITAL_SPACING_HOPS - 1 BFS hops over land cells (r_circulate_r), i.e. capitals are
 *      at least CAPITAL_SPACING_HOPS = round(150 / cellSpacing) hops apart (19 at the defaults).
 *      When fewer than K qualify, K shrinks to the number found.
 *   3. One Culture per capital: { id i, name '', color NATION_COLORS[i % 12], language =
 *      emptyLanguage() (a fresh placeholder that names.ts replaces from
 *      fork(seed, 'names', 'culture:<i>', 'lang'); language.ts is NOT imported here), home_p =
 *      the capital's province }.
 *   4. Per province: p_meanElev = mean max(0, r_elevation) over its cells (reverted lake
 *      candidates may still be negative here); p_hostility = HOSTILITY[biome at centroid_r]
 *      (deserts, scorched, snow, tundra, bare 2; taiga, shrubland 1; else 0).
 *   5. p_culture: multi-source Dijkstra over the CSR province graph from the K home provinces
 *      (culture i seeded at cost 0, pushed in culture order); link u -> v costs
 *      1 + p_hostility[v] + 3 (p_meanElev[u] > 0.6 or p_meanElev[v] > 0.6). A province takes the
 *      culture of the first strictly cheaper relaxation; the heap breaks equal costs on the
 *      smaller province index. Provinces unreachable from every home stay -1 (islands).
 *   6. p_nation: multi-source Dijkstra from the K capitals' provinces, link u -> v costs
 *      1 + 3 (p_culture differs) + 2 (shared border < 20 px) + 4 (either p_meanElev > 0.6),
 *      carrying a hop depth: a province popped at hop 12 relaxes nothing, so no province is ever
 *      claimed beyond 12 hops from its capital. Each province copies the nation of its
 *      predecessor, so every nation's territory is connected over the province graph.
 *   7. Free cities: connected components (BFS over the CSR graph, discovered from the lowest
 *      province index upward) of the provinces still unclaimed after step 6 — islands without a
 *      capital and mainland pockets beyond the hop cap alike. A component holding at least one
 *      settlement becomes a new Nation (id = nations.length) whose capital is the component's
 *      best settlement (scoreCell desc, smaller index on ties), owning the whole component, with
 *      a new Culture (same id, next color, placeholder language, home_p = the capital's province)
 *      written over p_culture of the component. A component without settlements stays -1.
 *   8. settlements[i].culture = p_culture[province]; r_nation via derivePolitics.
 *   9. Events, seq = index in the returned array, all at year 0, in this order: culture.emerged
 *      per culture (subjects [culture:i], at = its nation's capital cell, data {}); nation.founded
 *      per nation (subjects [nation:i, settlement:capital], at the capital cell, data { capital });
 *      province.claimed per owned province in province order (subjects [province:p, nation:n],
 *      at centroid_r, cause = seq of nation n's founding event, data {}); settlement.founded per
 *      settlement (subjects [settlement:i, province:p], at r, data { kind, population }).
 */

import type { Rng } from '../core/rng';
import type {
  Biome, Culture, Geography, Language, Mesh, MorphemeKind, Nation, Politics, Province, ProvinceGraph,
  Settlement, WorldEvent, WorldParams,
} from '../core/types';
import { BIOMES } from '../core/types';
import { MinHeap } from '../core/heap';
import { mkId } from '../core/ids';
import { r_circulate_r } from '../mesh/dualmesh';
import { scoreCell } from './settlements';

/** Twelve muted, parchment-friendly, mutually distinguishable nation tints. */
export const NATION_COLORS: readonly string[] = [
  '#8b3a3a',   // deep red
  '#3b5b8c',   // slate blue
  '#4f7a4a',   // moss green
  '#b8862b',   // ochre
  '#6b4c8a',   // dusk purple
  '#2f7d7a',   // teal
  '#a85a2a',   // burnt sienna
  '#7a6a3a',   // olive
  '#8a3a6a',   // plum
  '#3a6a8a',   // steel blue
  '#5a7a2a',   // fern
  '#9a5a4a',   // brick rose
];

/** Minimum capital spacing in logical px, mapped to BFS hops by cellSpacing. */
const CAPITAL_SPACING_PX = 150;
/** Settlements per nation before clamping to [MIN_NATIONS, nationsMax]. */
const SETTLEMENTS_PER_NATION = 5;
const MIN_NATIONS = 3;
/** Culture-spread cost terms. */
const HOSTILITY: Record<Biome, number> = {
  ocean: 0, lake: 0, snow: 2, tundra: 2, bare: 2, scorched: 2, taiga: 1, shrubland: 1,
  temperateDesert: 2, temperateRainforest: 0, deciduousForest: 0, grassland: 0,
  tropicalRainforest: 0, tropicalSeasonalForest: 0, subtropicalDesert: 2, marsh: 0,
};
const HIGHLAND_ELEVATION = 0.6;
const CULTURE_MOUNTAIN_COST = 3;
/** Nation-spread cost terms and the hop cap. */
const NATION_CULTURE_COST = 3;
const NATION_NARROW_BORDER_COST = 2;
const NARROW_BORDER_PX = 20;
const NATION_MOUNTAIN_COST = 4;
const NATION_MAX_HOPS = 12;

const MORPHEME_KINDS: readonly MorphemeKind[] = ['city', 'river', 'lake', 'sea', 'mount', 'wood', 'realm', 'port'];

/** Placeholder language for a culture; names.ts replaces it from its own frozen fork. */
function emptyLanguage(): Language {
  const morphemes = {} as Record<MorphemeKind, string[]>;
  for (let i = 0; i < MORPHEME_KINDS.length; i++) morphemes[MORPHEME_KINDS[i]] = [];
  return {
    consonants: [], vowels: [], sibilants: [], liquids: [], finals: [],
    structure: 'CV', minSyl: 1, maxSyl: 2, ortho: {}, morphemes, joiner: '',
  };
}

function makeCulture(id: number, home_p: number): Culture {
  return { id, name: '', color: NATION_COLORS[id % NATION_COLORS.length], language: emptyLanguage(), home_p };
}

function makeNation(id: number, capital: number): Nation {
  return { id, name: '', capital, culture: id, color: NATION_COLORS[id % NATION_COLORS.length], founded: 0, died: -1 };
}

export function foundNations(
  mesh: Mesh, params: WorldParams, geo: Geography, provinces: Province[], graph: ProvinceGraph,
  r_province: Int16Array, settlements: Settlement[], r_settlement: Int16Array, _rng: Rng,
): { politics: Politics; events: WorldEvent[] } {
  const nr = mesh.numRegions;
  const numP = provinces.length;
  const n = settlements.length;
  const { p_first, p_nbr, p_border } = graph;
  const { r_water, r_elevation, r_biome } = geo;
  const scratch: number[] = [];

  // ---- 1. settlement scores and order
  const sc = new Float64Array(n);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    sc[i] = scoreCell(mesh, geo, settlements[i].r);
    order[i] = i;
  }
  order.sort((a, b) => sc[b] - sc[a] || a - b);

  // ---- 2. capitals
  let K = Math.round(n / SETTLEMENTS_PER_NATION);
  if (K < MIN_NATIONS) K = MIN_NATIONS;
  if (K > params.nationsMax) K = params.nationsMax;
  let spacingHops = Math.round(CAPITAL_SPACING_PX / params.cellSpacing);
  if (spacingHops < 1) spacingHops = 1;
  const tooClose = new Uint8Array(nr);
  const provinceTaken = new Uint8Array(numP);
  const queue = new Int32Array(nr);
  const depth = new Int32Array(nr);
  const stamp = new Int32Array(nr);          // 0 = unvisited, else 1 + capital index
  const capitals: number[] = [];
  for (let k = 0; k < n && capitals.length < K; k++) {
    const i = order[k];
    const s = settlements[i];
    const p = s.province;
    if (p < 0 || p >= numP || provinceTaken[p] === 1 || tooClose[s.r] === 1) continue;
    capitals.push(i);
    provinceTaken[p] = 1;
    const mark = capitals.length;
    let head = 0, tail = 0;
    queue[tail++] = s.r;
    stamp[s.r] = mark;
    depth[s.r] = 0;
    while (head < tail) {
      const u = queue[head++];
      tooClose[u] = 1;
      const d = depth[u];
      if (d >= spacingHops - 1) continue;
      r_circulate_r(mesh, u, scratch);
      for (let j = 0; j < scratch.length; j++) {
        const v = scratch[j];
        if (r_water[v] !== 0 || stamp[v] === mark) continue;
        stamp[v] = mark;
        depth[v] = d + 1;
        queue[tail++] = v;
      }
    }
  }
  K = capitals.length;

  // ---- 3. cultures
  const cultures: Culture[] = [];
  for (let i = 0; i < K; i++) cultures.push(makeCulture(i, settlements[capitals[i]].province));

  // ---- 4. province stats
  const p_meanElev = new Float32Array(numP);
  const p_hostility = new Uint8Array(numP);
  for (let p = 0; p < numP; p++) {
    const cells = provinces[p].cells;
    let sum = 0;
    for (let i = 0; i < cells.length; i++) {
      const e = r_elevation[cells[i]];
      if (e > 0) sum += e;
    }
    p_meanElev[p] = cells.length > 0 ? sum / cells.length : 0;
    p_hostility[p] = HOSTILITY[BIOMES[r_biome[provinces[p].centroid_r]]];
  }

  // ---- 5. p_culture: Dijkstra from the home provinces
  const p_culture = new Int16Array(numP).fill(-1);
  const dist = new Float64Array(numP).fill(Infinity);
  const done = new Uint8Array(numP);
  const heap = new MinHeap(p_nbr.length + numP + 16);
  for (let i = 0; i < K; i++) {
    const p = cultures[i].home_p;
    dist[p] = 0;
    p_culture[p] = i;
    heap.push(0, p);
  }
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u] === 1) continue;
    done[u] = 1;
    const du = dist[u];
    const highU = p_meanElev[u] > HIGHLAND_ELEVATION;
    const cu = p_culture[u];
    for (let k = p_first[u]; k < p_first[u + 1]; k++) {
      const v = p_nbr[k];
      if (done[v] === 1) continue;
      let c = 1 + p_hostility[v];
      if (highU || p_meanElev[v] > HIGHLAND_ELEVATION) c += CULTURE_MOUNTAIN_COST;
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        p_culture[v] = cu;
        heap.push(nd, v);
      }
    }
  }

  // ---- 6. p_nation: hop-capped Dijkstra from the capitals' provinces
  const p_nation = new Int16Array(numP).fill(-1);
  const hop = new Int32Array(numP);
  dist.fill(Infinity);
  done.fill(0);
  heap.clear();
  for (let i = 0; i < K; i++) {
    const p = settlements[capitals[i]].province;
    dist[p] = 0;
    hop[p] = 0;
    p_nation[p] = i;
    heap.push(0, p);
  }
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u] === 1) continue;
    done[u] = 1;
    if (hop[u] >= NATION_MAX_HOPS) continue;
    const du = dist[u];
    const hu = hop[u] + 1;
    const nu = p_nation[u];
    const cu = p_culture[u];
    const highU = p_meanElev[u] > HIGHLAND_ELEVATION;
    for (let k = p_first[u]; k < p_first[u + 1]; k++) {
      const v = p_nbr[k];
      if (done[v] === 1) continue;
      let c = 1;
      if (p_culture[v] !== cu) c += NATION_CULTURE_COST;
      if (p_border[k] < NARROW_BORDER_PX) c += NATION_NARROW_BORDER_COST;
      if (highU || p_meanElev[v] > HIGHLAND_ELEVATION) c += NATION_MOUNTAIN_COST;
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        hop[v] = hu;
        p_nation[v] = nu;
        heap.push(nd, v);
      }
    }
  }
  const nations: Nation[] = [];
  for (let i = 0; i < K; i++) nations.push(makeNation(i, capitals[i]));

  // ---- 7. free cities over the still-unclaimed components
  const ps_first = new Int32Array(numP + 1);
  for (let i = 0; i < n; i++) {
    const p = settlements[i].province;
    if (p >= 0 && p < numP) ps_first[p + 1]++;
  }
  for (let p = 0; p < numP; p++) ps_first[p + 1] += ps_first[p];
  const ps_list = new Int32Array(ps_first[numP]);
  {
    const cursor = ps_first.slice(0, numP);
    for (let i = 0; i < n; i++) {
      const p = settlements[i].province;
      if (p >= 0 && p < numP) ps_list[cursor[p]++] = i;
    }
  }
  const seen = new Uint8Array(numP);
  const pqueue = new Int32Array(numP);
  for (let p0 = 0; p0 < numP; p0++) {
    if (p_nation[p0] >= 0 || seen[p0] === 1) continue;
    let head = 0, tail = 0;
    pqueue[tail++] = p0;
    seen[p0] = 1;
    let best = -1;
    let bestScore = -Infinity;
    while (head < tail) {
      const u = pqueue[head++];
      for (let k = ps_first[u]; k < ps_first[u + 1]; k++) {
        const i = ps_list[k];
        if (sc[i] > bestScore || (sc[i] === bestScore && i < best)) {
          bestScore = sc[i];
          best = i;
        }
      }
      for (let k = p_first[u]; k < p_first[u + 1]; k++) {
        const v = p_nbr[k];
        if (p_nation[v] >= 0 || seen[v] === 1) continue;
        seen[v] = 1;
        pqueue[tail++] = v;
      }
    }
    if (best < 0) continue;
    const id = nations.length;
    cultures.push(makeCulture(id, settlements[best].province));
    nations.push(makeNation(id, best));
    for (let k = 0; k < tail; k++) {
      const q = pqueue[k];
      p_nation[q] = id;
      p_culture[q] = id;
    }
  }

  // ---- 8. settlement cultures, r_nation
  for (let i = 0; i < n; i++) {
    const p = settlements[i].province;
    settlements[i].culture = p >= 0 && p < numP ? p_culture[p] : -1;
  }
  const politics: Politics = {
    year: 0, cultures, nations, p_nation, p_culture, r_nation: new Int16Array(nr), r_settlement,
  };
  derivePolitics(politics, r_province);

  // ---- 9. events
  const events: WorldEvent[] = [];
  for (let i = 0; i < cultures.length; i++) {
    events.push({
      seq: events.length, year: 0, kind: 'culture.emerged',
      subjects: [mkId('culture', i)], at: settlements[nations[i].capital].r, data: {},
    });
  }
  const nationSeq = new Int32Array(nations.length);
  for (let i = 0; i < nations.length; i++) {
    const capital = nations[i].capital;
    nationSeq[i] = events.length;
    events.push({
      seq: events.length, year: 0, kind: 'nation.founded',
      subjects: [mkId('nation', i), mkId('settlement', capital)], at: settlements[capital].r, data: { capital },
    });
  }
  for (let p = 0; p < numP; p++) {
    const nation = p_nation[p];
    if (nation < 0) continue;
    events.push({
      seq: events.length, year: 0, kind: 'province.claimed',
      subjects: [mkId('province', p), mkId('nation', nation)], at: provinces[p].centroid_r,
      cause: nationSeq[nation], data: {},
    });
  }
  for (let i = 0; i < n; i++) {
    const s = settlements[i];
    const subjects = [mkId('settlement', i)];
    if (s.province >= 0) subjects.push(mkId('province', s.province));
    events.push({
      seq: events.length, year: 0, kind: 'settlement.founded',
      subjects, at: s.r, data: { kind: s.kind, population: s.population },
    });
  }

  return { politics, events };
}

/** r_nation[r] = p_nation[r_province[r]] (-1 on water and unclaimed land), in place. r_nation is
 *  reallocated only if its length does not match r_province. */
export function derivePolitics(politics: Politics, r_province: Int16Array): void {
  const nr = r_province.length;
  if (politics.r_nation.length !== nr) politics.r_nation = new Int16Array(nr);
  const { p_nation, r_nation } = politics;
  const numP = p_nation.length;
  for (let r = 0; r < nr; r++) {
    const p = r_province[r];
    r_nation[r] = p < 0 || p >= numP ? -1 : p_nation[p];
  }
}
