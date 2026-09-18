/**
 * gen/climate.ts — Stage 6 (Climate) and stage 8 (Biomes).
 *
 * RNG stream: `climate` (the caller passes fork(seed, 'climate') to computeClimate). Exactly one
 * draw, and only when params.windDir === 'random': rng.int(0, 7) for the prevailing wind.
 * computeBiomes draws nothing.
 *
 * Inputs:  Mesh, WorldParams, ClimateInput (r_elevation, r_water, r_coastDist, r_lat) for stage 6;
 *          Mesh plus the Geography fields listed in computeBiomes' Pick for stage 8.
 * Outputs: { r_temperature, r_moisture, windDir } and r_biome (Uint8Array of BIOMES indices).
 *
 * Stage 6, as ARCHITECTURE.md section 5 writes it (retuned 2026-09-16, see the fitting notes):
 *   - Temperature: base = 1 - (|lat| / 90)^1.5 (0.83 at 28 N, 0.48 at 58 N);
 *     r_temperature = clamp(base - 0.55 max(0, elevation)^2, 0, 1). The squared lapse term is
 *     what makes only high mountains cold: at elevation 0.5 it costs 0.14, at 0.85 (the snow line)
 *     0.40, so the northern lowlands read boreal and the southern lowlands subtropical instead of
 *     a third of the land clamping to 0 as the old linear 0.55 e did.
 *   - Moisture: interior cells are swept in downwindOrder(mesh, windDir). Boundary-ring cells are
 *     ocean and start done at 1.0. A per-cell CARRIED moisture m is propagated: ocean cells carry
 *     1.0, lake cells (r_water === 2) 0.8, and a land cell takes m[r] = max over its
 *     ALREADY-PROCESSED neighbors (a Uint8 `done` array) of
 *       m[nbr] * 0.985 - 2.5 max(0, elev[r] - elev[nbr] - RISE_ALLOWANCE),
 *     floored at 0.04 (also the value when no upwind neighbor is done yet). The output is
 *     r_moisture = 0.7 m[r] + 0.3 (1 - clamp(r_coastDist / 260, 0, 1)) for land and 1.0 / 0.8 for
 *     ocean / lake. m[nbr] is the neighbor's carried value, not its blended output: that is what
 *     makes 0.985 a per-hop decay (~45 hops to halve) and the subtraction term a rain shadow that
 *     persists downwind of a ridge. Land moisture never exceeds 0.7 * 0.985 + 0.3 < 1.
 *     RISE_ALLOWANCE (0.04 per hop) is the gentle inland climb of the stage-4 reshape (~0.03-0.05
 *     per hop at the default spacing), which the old formula charged in full: 2.5 per unit rise
 *     exhausted the carried budget within ~8 hops of a windward coast and left ~70% of land at the
 *     floor, where r_moisture was pure continentality and ridges added nothing. Charging only the
 *     rise beyond the allowance lets carried moisture reach the interior and keeps real ridges
 *     (a >= 0.15 step in one hop) as shadows.
 *
 * Stage 8: Whittaker lookup with the mapgen2 table (mapgen2 indexes its rows by elevation zone;
 * this indexes them by temperature band) — 4 temperature bands x 6 moisture bands. The band edges
 * are NOT mapgen2's; they are fitted constants (2026-09-16) for the stage-6 distributions above,
 * measured over land cells at DEFAULT_PARAMS with windDir 0 averaged over the seeds 'atlas',
 * 'amberfell', 'test-1' and 'zzzzzzzz', against these targets (each biome assigned to one row:
 * temperateDesert to cool, grassland to warm):
 *   cold row (snow+tundra+bare+scorched) 6-14% of land, cool row (taiga+shrubland+temperateDesert)
 *   20-32%, warm row (temperateRainforest+deciduousForest+grassland) 35-50%, hot row
 *   (tropicalRainforest+tropicalSeasonalForest+subtropicalDesert) 18-32%; deserts
 *   (temperateDesert+subtropicalDesert+scorched) 8-16%; forests (taiga+both rainforests+
 *   deciduousForest+tropicalSeasonalForest) 35-55%; grassland+shrubland 18-32%.
 * TEMP_BANDS and MOIST_BANDS below record the fitted edges; climate.test.ts asserts the targets.
 * Measured with them (same seeds, no hydrology): rows 8.9 / 26.0 / 43.6 / 21.4%, deserts 13.0%,
 * forests 52.7%, grassland+shrubland 28.2%; with hydrology, marsh is ~0.8% of land.
 * Before the lookup, in this order: water cells -> ocean / lake; elevation > 0.85 -> snow;
 * +0.10 moisture (capped at 1) for WET cells — a river side (s_river > 0 on an outgoing side), a
 * lake neighbor (r_water === 2) or a lake corner (t_lake >= 0); coast cells (a neighbor with
 * r_water === 1) that are wet, with elevation < 0.08 and adjusted moisture > 0.7 -> marsh. The
 * wetness requirement is what keeps marsh at a few percent of land: without it the rule fired on
 * 60-80% of coast cells.
 */

import type { Rng } from '../core/rng';
import type { Biome, Geography, Mesh, WindDir, WorldParams } from '../core/types';
import { BIOMES } from '../core/types';
import { downwindOrder, r_circulate_r, r_circulate_s, s_end_r, s_inner_t } from '../mesh/dualmesh';

export interface ClimateInput {
  r_elevation: Float32Array; r_water: Uint8Array; r_coastDist: Float32Array; r_lat: Float32Array;
}

const OCEAN_MOISTURE = 1.0;
const LAKE_MOISTURE = 0.8;
const MOISTURE_FLOOR = 0.04;
const CARRY = 0.985;
const RAIN_SHADOW = 2.5;
/** Per-hop rise that costs no carried moisture (the reshape's inland climb); see the file comment. */
const RISE_ALLOWANCE = 0.04;
const CONTINENTALITY_PX = 260;
/** Lapse term: r_temperature = base - LAPSE * max(0, elevation)^2. */
const LAPSE = 0.55;

export function computeClimate(
  mesh: Mesh, params: WorldParams, geo: ClimateInput, rng: Rng,
): { r_temperature: Float32Array; r_moisture: Float32Array; windDir: WindDir } {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const { r_elevation, r_water, r_coastDist, r_lat } = geo;

  const windDir: WindDir = params.windDir === 'random' ? (rng.int(0, 7) as WindDir) : params.windDir;

  // ---- temperature
  const r_temperature = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const base = 1 - Math.pow(Math.abs(r_lat[r]) / 90, 1.5);
    const e = r_elevation[r];
    const ep = e > 0 ? e : 0;
    let t = base - LAPSE * ep * ep;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    r_temperature[r] = t;
  }

  // ---- moisture: downwind sweep of the carried moisture m, then the blended output
  const r_moisture = new Float32Array(n);
  const m = new Float32Array(n);
  const done = new Uint8Array(n);
  for (let r = 0; r < nb; r++) {
    m[r] = OCEAN_MOISTURE;
    r_moisture[r] = OCEAN_MOISTURE;
    done[r] = 1;
  }
  const order = downwindOrder(mesh, windDir);
  const nbrs: number[] = [];
  const invCont = 1 / CONTINENTALITY_PX;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    const w = r_water[r];
    if (w === 1) {
      m[r] = OCEAN_MOISTURE;
      r_moisture[r] = OCEAN_MOISTURE;
    } else if (w === 2) {
      m[r] = LAKE_MOISTURE;
      r_moisture[r] = LAKE_MOISTURE;
    } else {
      const e = r_elevation[r];
      let carried = MOISTURE_FLOOR;
      r_circulate_r(mesh, r, nbrs);
      for (let k = 0; k < nbrs.length; k++) {
        const q = nbrs[k];
        if (done[q] === 0) continue;
        const rise = e - r_elevation[q] - RISE_ALLOWANCE;
        const c = m[q] * CARRY - RAIN_SHADOW * (rise > 0 ? rise : 0);
        if (c > carried) carried = c;
      }
      m[r] = carried;
      let d = r_coastDist[r] * invCont;
      if (d < 0) d = 0; else if (d > 1) d = 1;
      r_moisture[r] = 0.7 * carried + 0.3 * (1 - d);
    }
    done[r] = 1;
  }

  return { r_temperature, r_moisture, windDir };
}

// ---------------------------------------------------------------- stage 8: biomes

function biomeIndex(b: Biome): number {
  return BIOMES.indexOf(b);
}

const B_OCEAN = biomeIndex('ocean');
const B_LAKE = biomeIndex('lake');
const B_SNOW = biomeIndex('snow');
const B_MARSH = biomeIndex('marsh');

/**
 * Temperature band edges, fitted 2026-09-16 (see the file comment):
 * cold < edge[0] <= cool < edge[1] <= mid < edge[2] <= hot.
 */
const TEMP_BANDS = [0.35, 0.50, 0.65] as const;
/** Moisture band edges, fitted 2026-09-16: zone k when moisture > edge[k - 1]. */
const MOIST_BANDS = [0.45, 0.50, 0.63, 0.70, 0.86] as const;

/** mapgen2's table, rows cold..hot, columns driest..wettest. */
const WHITTAKER_NAMES: readonly (readonly Biome[])[] = [
  ['scorched', 'scorched', 'bare', 'tundra', 'snow', 'snow'],
  ['temperateDesert', 'temperateDesert', 'shrubland', 'shrubland', 'taiga', 'taiga'],
  ['temperateDesert', 'grassland', 'grassland', 'deciduousForest', 'deciduousForest', 'temperateRainforest'],
  ['subtropicalDesert', 'grassland', 'tropicalSeasonalForest', 'tropicalSeasonalForest', 'tropicalRainforest', 'tropicalRainforest'],
];
const WHITTAKER = new Uint8Array(24);
for (let i = 0; i < 4; i++) for (let j = 0; j < 6; j++) WHITTAKER[i * 6 + j] = biomeIndex(WHITTAKER_NAMES[i][j]);

function whittaker(temperature: number, moisture: number): number {
  let ti = 0;
  while (ti < TEMP_BANDS.length && temperature >= TEMP_BANDS[ti]) ti++;
  let mi = 0;
  while (mi < MOIST_BANDS.length && moisture > MOIST_BANDS[mi]) mi++;
  return WHITTAKER[ti * 6 + mi];
}

const SNOW_ELEVATION = 0.85;
const MARSH_ELEVATION = 0.08;
const MARSH_MOISTURE = 0.7;
const FLOODPLAIN_BONUS = 0.1;

export function computeBiomes(
  mesh: Mesh,
  geo: Pick<Geography, 'r_water' | 'r_elevation' | 'r_temperature' | 'r_moisture' | 'r_coastDist' | 's_river' | 't_lake'>,
): Uint8Array {
  const n = mesh.numRegions;
  const { r_water, r_elevation, r_temperature, r_moisture, s_river, t_lake } = geo;
  const r_biome = new Uint8Array(n);
  const sides: number[] = [];
  for (let r = 0; r < n; r++) {
    const w = r_water[r];
    if (w === 1) { r_biome[r] = B_OCEAN; continue; }
    if (w === 2) { r_biome[r] = B_LAKE; continue; }
    const e = r_elevation[r];
    if (e > SNOW_ELEVATION) { r_biome[r] = B_SNOW; continue; }

    let wet = false;
    let coast = false;
    r_circulate_s(mesh, r, sides);
    for (let k = 0; k < sides.length; k++) {
      const s = sides[k];
      if (s_river[s] > 0 || t_lake[s_inner_t(s)] >= 0) wet = true;
      const q = s_end_r(mesh, s);
      const wq = r_water[q];
      if (wq === 1) coast = true;
      else if (wq === 2) wet = true;
    }
    let m = r_moisture[r];
    if (wet) {
      m += FLOODPLAIN_BONUS;
      if (m > 1) m = 1;
    }
    // Marsh needs standing or flowing water (wet), not only a wet climate.
    if (wet && coast && e < MARSH_ELEVATION && m > MARSH_MOISTURE) { r_biome[r] = B_MARSH; continue; }
    r_biome[r] = whittaker(r_temperature[r], m);
  }
  return r_biome;
}

/** Muted, parchment-friendly tints. ocean / lake exist for completeness and are never painted. */
export const BIOME_COLORS: Record<Biome, string> = {
  ocean: '#b9c6c3',
  lake: '#bccbc7',
  snow: '#e9e6dd',
  tundra: '#cdc9b4',
  bare: '#b9b19f',
  scorched: '#a89e8d',
  taiga: '#98a487',
  shrubland: '#b5b28d',
  temperateDesert: '#d5caa2',
  temperateRainforest: '#899d7c',
  deciduousForest: '#9dab82',
  grassland: '#bdc08e',
  tropicalRainforest: '#809677',
  tropicalSeasonalForest: '#98a780',
  subtropicalDesert: '#d8c59a',
  marsh: '#a5b293',
};

/** Habitability per biome, 0..1; consumed by provinces and settlements. */
export const BIOME_FERTILITY: Record<Biome, number> = {
  ocean: 0,
  lake: 0,
  snow: 0.02,
  tundra: 0.15,
  bare: 0.08,
  scorched: 0.02,
  taiga: 0.35,
  shrubland: 0.35,
  temperateDesert: 0.12,
  temperateRainforest: 0.75,
  deciduousForest: 0.9,
  grassland: 0.85,
  tropicalRainforest: 0.7,
  tropicalSeasonalForest: 0.75,
  subtropicalDesert: 0.08,
  marsh: 0.45,
};
