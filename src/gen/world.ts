/**
 * gen/world.ts — Stage orchestration (section 5) and stage 15 (History log), plus the save-file
 * codec (toWorldFile / fromWorldFile) and the parameter merge (withParams).
 *
 * RNG streams: this file draws NOTHING itself. It hands each stage its own fork of the seed, in
 * this order (the labels are frozen; renaming one is a params.version bump):
 *   fork(seed, 'points')       -> generatePoints        (stage 1)
 *   fork(seed, 'edges')        -> buildNoisyEdges       (stage 3)
 *   fork(seed, 'elevation')    -> computeElevation      (stage 4)
 *   fork(seed, 'climate')      -> computeClimate        (stage 6)
 *   fork(seed, 'provinces')    -> computeProvinces      (stage 9)
 *   fork(seed, 'settlements')  -> placeSettlements      (stage 10)
 *   fork(seed, 'politics')     -> foundNations          (stage 11; draws nothing on day one)
 *   names (stage 12) forks fork(seed, 'names', ...) per entity inside assignNames / worldTitle.
 * Stages 2, 5, 7, 8, 13 and 15 draw nothing. Every fork is independent, so the execution order
 * below is free to differ from the stage numbering without changing any stage's output.
 *
 * Execution order and the timings keys generate records (performance.now(), ms, a plain object
 * in insertion order): points, mesh, edges, elevation, distance, climate, hydrology (includes the
 * geography assembly below), biomes, features, provinces, settlements, politics, names, history.
 * Stage 13 (features) runs BEFORE stage 12 (names) because names needs the rivers, lakes, seas and
 * ranges to exist; features needs only mesh, edges, geography and the hydrology result.
 * buildPoliticalView (stage 14) is NOT part of World; main.ts calls it after generate.
 *
 * Geography assembly (between hydrology and biomes):
 *   r_elevation is a COPY of the stage-4 array patched for hydro.revertedCells — lake candidates
 *   (r_water 2, negative elevation) that hydrology returned to land. Each reverted cell gets
 *   max(REVERT_FLOOR, mean stage-4 elevation of its neighbours that are land in hydro.r_water and
 *   above 0), or REVERT_FLOOR (0.005) when it has no such neighbour (the inside of a large
 *   reverted basin is a flat 0.005 floor). Neighbour heights are read from the UNPATCHED array,
 *   so the result does not depend on the order of the reverted list. Then r_slope is recomputed
 *   for the reverted cells and their neighbours (max |delta elevation| over neighbours, from the
 *   patched array), and r_coastHops of each reverted cell is set to 1 + the minimum stage-4 hops
 *   of its neighbours (the stage-4 BFS ran over every cell, so this is what it already holds; it
 *   is restated here so the invariant is guaranteed by construction). r_water is hydro.r_water;
 *   distField / r_coastDist come from the ocean-only mask of stage 5 and need no patch; the t_*
 *   and s_* arrays are hydrology's; r_biome is computed AFTER hydrology from the assembled
 *   geography (hydro.r_water, s_river, t_lake), so lake cells and river sides read as such.
 *
 * Stage 15 — history: events[0] = world.created (year 0, no subjects, data { title, seed }),
 * followed by the stage-11 founding events in their generation order with seq = position in the
 * final array (their own index + 1) and every cause shifted by +1 to match. All at year 0.
 *
 * Save file: toWorldFile stores (seed, params, year, events) plus p_nation / p_culture as base64
 * of the Int16 values in LITTLE-ENDIAN byte order (explicit, so the file is the same on every
 * platform). The base64 codec uses globalThis.Buffer when it exists (node) and btoa / atob
 * otherwise (browsers); no node-only import. fromWorldFile regenerates from (seed, params),
 * restores p_nation / p_culture (lengths must equal the regenerated province count), reruns
 * derivePolitics, and sets year and events. A file whose v differs from ATLAS_VERSION is refused:
 * the stages' RNG consumption changed, so the geometry would not match the saved politics (a
 * migrations table is roadmap, section 9).
 *
 * Inputs:  seed string and Partial<WorldParams> (generate); World (toWorldFile); WorldFile
 *          (fromWorldFile).
 * Outputs: a World (section 4) with every field filled and named; a WorldFile; a WorldParams.
 */

import type {
  Geography, HistoryLog, World, WorldEvent, WorldFile, WorldParams,
} from '../core/types';
import { ATLAS_VERSION, DEFAULT_PARAMS } from '../core/types';
import type { Mesh } from '../core/types';
import { fork } from '../core/rng';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, r_circulate_r } from '../mesh/dualmesh';
import { buildNoisyEdges } from '../mesh/noisy';
import { computeTectonics } from './tectonics';
import { computeElevation, computeDistanceField } from './elevation';
import type { ElevationResult } from './elevation';
import { computeClimate, computeBiomes } from './climate';
import { computeHydrology } from './hydrology';
import type { HydrologyResult } from './hydrology';
import { extractFeatures } from './features';
import { computeProvinces } from './provinces';
import { placeSettlements } from './settlements';
import { foundNations, derivePolitics } from './politics';
import { assignNames, worldTitle } from './names';

/** Elevation given to a reverted lake candidate with no positive land neighbour; also the floor. */
const REVERT_FLOOR = 0.005;

/** The 15 timing keys generate records, in execution order. */
const STAGE_NAMES = [
  'points', 'mesh', 'edges', 'tectonics', 'elevation', 'distance', 'climate', 'hydrology', 'biomes',
  'features', 'provinces', 'settlements', 'politics', 'names', 'history',
] as const;

// ---------------------------------------------------------------- params

export function withParams(overrides: Partial<WorldParams>): WorldParams {
  // Explicit undefined values in a Partial must not overwrite a default.
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const p: WorldParams = Object.assign({}, DEFAULT_PARAMS, defined);
  p.frame = { ...p.frame };
  p.version = ATLAS_VERSION;
  return p;
}

// ---------------------------------------------------------------- generate

export function generate(seed: string, params?: Partial<WorldParams>): World {
  const p = withParams(params ?? {});
  const timings: Record<string, number> = {};
  let mark = performance.now();
  const lap = (name: (typeof STAGE_NAMES)[number]): void => {
    const now = performance.now();
    timings[name] = now - mark;
    mark = now;
  };

  // 1-3: points, mesh, noisy edges
  const { points, numBoundary } = generatePoints(p, fork(seed, 'points'));
  lap('points');
  const mesh = buildMesh(points, numBoundary);
  lap('mesh');
  const edges = buildNoisyEdges(mesh, fork(seed, 'edges'));
  lap('edges');

  // 3.5-6: plates, elevation, distance field, climate
  const tectonics = computeTectonics(mesh, p, fork(seed, 'tectonics'));
  lap('tectonics');
  const elev = computeElevation(mesh, p, fork(seed, 'elevation'), tectonics);
  lap('elevation');
  const { distField, r_coastDist } = computeDistanceField(mesh, p, elev.r_water);
  lap('distance');
  const climate = computeClimate(
    mesh, p,
    { r_elevation: elev.r_elevation, r_water: elev.r_water, r_coastDist, r_lat: elev.r_lat },
    fork(seed, 'climate'),
  );
  lap('climate');

  // 7: hydrology, then the geography assembly (reverted lake candidates lifted back onto land)
  const hydro = computeHydrology(mesh, p, elev.r_elevation, elev.r_water, climate.r_moisture);
  const base = assembleGeography(mesh, elev, hydro, climate, distField, r_coastDist);
  lap('hydrology');

  // 8: biomes, after hydrology so lakes and river sides are final
  const r_biome = computeBiomes(mesh, base);
  const geo: Geography = { ...base, r_biome };
  lap('biomes');

  // 13: features (needs mesh, edges, geography and the hydrology result only)
  const features = extractFeatures({ mesh, edges, geo, params: p }, hydro);
  lap('features');

  // 9-11: provinces, settlements (fills Province.seat), nations (fills Settlement.culture)
  const { provinces, r_province, graph } = computeProvinces(mesh, edges, p, geo, fork(seed, 'provinces'));
  lap('provinces');
  const { settlements, r_settlement } = placeSettlements(
    mesh, p, geo, provinces, r_province, fork(seed, 'settlements'),
  );
  lap('settlements');
  const { politics, events: founding } = foundNations(
    mesh, p, geo, provinces, graph, r_province, settlements, r_settlement, fork(seed, 'politics'),
  );
  lap('politics');

  // 12: names (needs features AND politics), then 15: history
  const history: HistoryLog = { events: [] };
  const world: World = {
    seed, params: p, mesh, edges, geo, features, provinces, graph, r_province, settlements,
    politics, history, timings,
  };
  assignNames(world);
  lap('names');
  history.events = buildHistory(world, founding);
  lap('history');

  return world;
}

// ---------------------------------------------------------------- geography assembly

type GeographyBase = Omit<Geography, 'r_biome'>;

function assembleGeography(
  mesh: Mesh, elev: ElevationResult, hydro: HydrologyResult,
  climate: { r_temperature: Float32Array; r_moisture: Float32Array; windDir: Geography['windDir'] },
  distField: Geography['distField'], r_coastDist: Float32Array,
): GeographyBase {
  const original = elev.r_elevation;
  const r_elevation = new Float32Array(original);
  const { r_slope, r_coastHops } = elev;
  const { r_water, revertedCells } = hydro;

  if (revertedCells.length > 0) {
    const nbrs: number[] = [];
    const touched = new Uint8Array(mesh.numRegions);

    // Lift every reverted cell from the unpatched neighbour heights (order-independent).
    for (let k = 0; k < revertedCells.length; k++) {
      const r = revertedCells[k];
      r_circulate_r(mesh, r, nbrs);
      let sum = 0;
      let count = 0;
      let minHops = 0x7fff;
      touched[r] = 1;
      for (let i = 0; i < nbrs.length; i++) {
        const q = nbrs[i];
        touched[q] = 1;
        const e = original[q];
        if (r_water[q] === 0 && e > 0) {
          sum += e;
          count++;
        }
        if (r_coastHops[q] < minHops) minHops = r_coastHops[q];
      }
      const lifted = count > 0 ? sum / count : REVERT_FLOOR;
      r_elevation[r] = lifted > REVERT_FLOOR ? lifted : REVERT_FLOOR;
      r_coastHops[r] = minHops === 0x7fff ? 1 : minHops + 1;
    }

    // Slope of the reverted cells and their neighbours from the patched heights.
    for (let r = 0; r < mesh.numRegions; r++) {
      if (touched[r] === 0) continue;
      const e = r_elevation[r];
      let m = 0;
      r_circulate_r(mesh, r, nbrs);
      for (let i = 0; i < nbrs.length; i++) {
        const d = Math.abs(e - r_elevation[nbrs[i]]);
        if (d > m) m = d;
      }
      r_slope[r] = m;
    }
  }

  return {
    r_elevation, r_water, r_coastHops, r_coastDist, r_lat: elev.r_lat, r_lon: elev.r_lon,
    r_temperature: climate.r_temperature, r_moisture: climate.r_moisture, r_slope,
    t_elevation: hydro.t_elevation, t_downslope_s: hydro.t_downslope_s, t_flux: hydro.t_flux,
    t_lake: hydro.t_lake, s_river: hydro.s_river, s_riverId: hydro.s_riverId,
    windDir: climate.windDir, distField,
  };
}

// ---------------------------------------------------------------- stage 15: history

function buildHistory(world: World, founding: WorldEvent[]): WorldEvent[] {
  const events: WorldEvent[] = new Array<WorldEvent>(founding.length + 1);
  events[0] = {
    seq: 0, year: 0, kind: 'world.created', subjects: [],
    data: { title: worldTitle(world), seed: world.seed },
  };
  for (let i = 0; i < founding.length; i++) {
    const e = founding[i];
    const copy: WorldEvent = { ...e, seq: i + 1 };
    if (e.cause !== undefined) copy.cause = e.cause + 1;
    events[i + 1] = copy;
  }
  return events;
}

// ---------------------------------------------------------------- save file

function copyEvents(events: WorldEvent[]): WorldEvent[] {
  const out: WorldEvent[] = new Array<WorldEvent>(events.length);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    out[i] = { ...e, subjects: e.subjects.slice(), data: { ...e.data } };
  }
  return out;
}

export function toWorldFile(world: World): WorldFile {
  return {
    v: ATLAS_VERSION,
    seed: world.seed,
    params: { ...world.params, frame: { ...world.params.frame } },
    year: world.politics.year,
    events: copyEvents(world.history.events),
    politics: {
      p_nation: int16ToBase64(world.politics.p_nation),
      p_culture: int16ToBase64(world.politics.p_culture),
    },
  };
}

export function fromWorldFile(file: WorldFile): World {
  if (file.v !== ATLAS_VERSION) {
    throw new Error('fromWorldFile: file version ' + file.v + ' is not ATLAS_VERSION ' + ATLAS_VERSION);
  }
  const world = generate(file.seed, file.params);
  if (file.politics !== undefined) {
    const p_nation = base64ToInt16(file.politics.p_nation);
    const p_culture = base64ToInt16(file.politics.p_culture);
    const numP = world.provinces.length;
    if (p_nation.length !== numP || p_culture.length !== numP) {
      throw new Error(
        'fromWorldFile: politics arrays have ' + p_nation.length + ' / ' + p_culture.length +
        ' entries but the regenerated world has ' + numP + ' provinces',
      );
    }
    world.politics.p_nation = p_nation;
    world.politics.p_culture = p_culture;
    derivePolitics(world.politics, world.r_province);
  }
  world.politics.year = file.year;
  world.history.events = copyEvents(file.events);
  return world;
}

// ---------------------------------------------------------------- base64 (node and browser)

interface BufferCtorLike {
  from(bytes: Uint8Array): { toString(encoding: 'base64'): string };
  from(text: string, encoding: 'base64'): Uint8Array;
}

function bufferCtor(): BufferCtorLike | undefined {
  return (globalThis as unknown as { Buffer?: BufferCtorLike }).Buffer;
}

/** Int16 values as little-endian bytes, base64-encoded. */
function int16ToBase64(values: Int16Array): string {
  const bytes = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    bytes[2 * i] = v & 0xff;
    bytes[2 * i + 1] = (v >> 8) & 0xff;
  }
  const B = bufferCtor();
  if (B !== undefined) return B.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Inverse of int16ToBase64. */
function base64ToInt16(text: string): Int16Array {
  const B = bufferCtor();
  let bytes: Uint8Array;
  if (B !== undefined) {
    bytes = B.from(text, 'base64');
  } else {
    const bin = atob(text);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);   // Int16 wraps to signed
  return out;
}
