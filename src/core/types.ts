// src/core/types.ts
// The contract every module codes against. Plain data only (typed arrays + POJOs):
// structured-cloneable, no classes, no enums, no methods on world data.

export const ATLAS_VERSION = 2;

// ---------------------------------------------------------------- parameters

/** Real-world window in degrees. lat0 is the TOP (north) edge, lat1 the bottom. */
export interface GeoFrame { lon0: number; lon1: number; lat0: number; lat1: number; }

/** Wind blows FROM this compass point; 0 = W (blowing east), then clockwise: 1 NW, 2 N, 3 NE, 4 E, 5 SE, 6 S, 7 SW. */
export type WindDir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorldParams {
  version: number;            // bump ONLY when a stage's RNG consumption order changes
  width: number;              // logical px (1024)
  height: number;             // logical px (768)
  cellSpacing: number;        // Poisson-disc radius r in logical px (8)
  rasterScale: number;        // raster scratch resolution relative to logical px (0.5)
  frame: GeoFrame;            // default { lon0: -20, lon1: 20, lat0: 58, lat1: 28 }
  landFraction: number;       // 0.42; sea level = matching quantile of raw height
  continents: 1 | 2 | 3;
  windDir: WindDir | 'random';
  lakesMax: number;           // 8
  riverPercentile: number;    // 0.94
  provinceSpacing: number;    // Poisson radius for province sites in logical px (48 -> ~140 provinces)
  settlementsMax: number;     // 40
  nationsMax: number;         // 8
}

export const DEFAULT_PARAMS: WorldParams = {
  version: ATLAS_VERSION, width: 1024, height: 768, cellSpacing: 8, rasterScale: 0.5,
  frame: { lon0: -20, lon1: 20, lat0: 58, lat1: 28 },
  landFraction: 0.42, continents: 2, windDir: 'random', lakesMax: 8, riverPercentile: 0.94,
  provinceSpacing: 48, settlementsMax: 40, nationsMax: 8,
};

// ---------------------------------------------------------------- mesh

export interface Mesh {
  numRegions: number;          // Voronoi cells (points), boundary ring included
  numBoundaryRegions: number;  // regions [0, numBoundaryRegions) are the outer ring: always ocean
  numTriangles: number;        // Voronoi corners
  numSides: number;            // half-edges = 3 * numTriangles
  r_x: Float32Array; r_y: Float32Array;   // cell centers (logical px)
  t_x: Float32Array; t_y: Float32Array;   // corner positions = triangle centroids
  s_start_r: Int32Array;       // region a side leaves from
  s_opposite_s: Int32Array;    // twin half-edge, -1 on the hull
  r_first_s: Int32Array;       // one outgoing side per region
  triangles: Int32Array; halfedges: Int32Array;  // raw Delaunator output (debugging, rasterization)
}

/** Precomputed mapgen2-style subdivided side paths. One path per undirected edge, keyed by the
 *  canonical side min(s, s_opposite_s[s]); the twin reads it reversed. pts are xy interleaved. */
export interface NoisyEdges {
  s_pathStart: Int32Array;     // index into pts (in floats) of the canonical side's path, -1 on hull
  s_pathLen: Uint8Array;       // number of points in the path (>= 2; endpoints are the two corners)
  pts: Float32Array;
}

// ---------------------------------------------------------------- geography (immutable after generate)

export type WaterKind = 0 | 1 | 2;  // 0 land, 1 ocean, 2 lake

export const BIOMES = [
  'ocean', 'lake', 'snow', 'tundra', 'bare', 'scorched', 'taiga', 'shrubland',
  'temperateDesert', 'temperateRainforest', 'deciduousForest', 'grassland',
  'tropicalRainforest', 'tropicalSeasonalForest', 'subtropicalDesert', 'marsh',
] as const;
export type Biome = typeof BIOMES[number];
/** Index into BIOMES; what r_biome stores. */
export type BiomeIndex = number;

export interface Raster { w: number; h: number; scale: number; data: Float32Array; }

export interface Geography {
  // per cell r, length mesh.numRegions
  r_elevation: Float32Array;   // -1..1, 0 = sea level, water < 0
  r_water: Uint8Array;         // WaterKind
  r_coastHops: Int16Array;     // BFS hops to nearest ocean cell (0 on ocean)
  r_coastDist: Float32Array;   // signed Euclidean px to the ocean coastline (+ land and inland water, - ocean), from distField
  r_lat: Float32Array;         // degrees, from frame
  r_lon: Float32Array;         // degrees, from frame
  r_temperature: Float32Array; // 0..1
  r_moisture: Float32Array;    // 0..1
  r_biome: Uint8Array;         // BiomeIndex
  r_slope: Float32Array;       // max |d elevation| over neighbors
  // per corner t, length mesh.numTriangles
  t_elevation: Float32Array;   // priority-flood filled (depression-free) elevation
  t_downslope_s: Int32Array;   // side from t to its lowest neighbor corner, -1 at ocean corners
  t_flux: Float32Array;        // accumulated rainfall
  t_lake: Int16Array;          // lake index or -1
  // per side s, length mesh.numSides (mirrored onto both half-edges)
  s_river: Float32Array;       // flux carried along this side, 0 = no river
  s_riverId: Int16Array;       // river index or -1
  windDir: WindDir;            // the resolved prevailing wind
  distField: Raster;           // signed EDT of the land mask at params.rasterScale
}

// ---------------------------------------------------------------- features (derived vector geometry)

/** xy interleaved logical px. Closed polylines do not repeat the first point. */
export interface Polyline { pts: Float32Array; closed: boolean; }

export interface River {
  id: number; name: string;
  sides: Int32Array;           // ordered source -> mouth, each side goes corner s_inner_t -> s_outer_t
  source_t: number; mouth_t: number;
  flux: number;                // flux at the mouth
  length: number;              // logical px
  parent: number;              // river this one joins, -1 if it reaches ocean/lake itself
}
export interface Lake {
  id: number; name: string;
  cells: Int32Array;           // cells with r_water === 2 belonging to this lake
  shore: Polyline;             // closed, from lake/non-lake sides
  outlet_t: number;            // spill corner (-1 if endorheic; never on day one)
}
export interface NamedArea {
  id: number; kind: 'sea' | 'range'; name: string;
  cells: Int32Array;
  label_r: number;             // pole of inaccessibility cell
  axisAngle: number;           // radians, principal axis of the cell set
  extent: number;              // px along the axis
}
export interface Features {
  coast: Polyline[];           // closed loops; land is on the left when walking pts in order
  waterlines: Polyline[][];    // distField contours, one array per WATERLINE_ISOS entry
  rivers: River[];
  riverPaths: Polyline[];      // riverPaths[i] is the noisy, smoothed path of rivers[i]
  lakes: Lake[];
  seas: NamedArea[];
  ranges: NamedArea[];
}
export const WATERLINE_ISOS = [-3, -7, -12, -18] as const;  // logical px offshore

// ---------------------------------------------------------------- human geography

export type SettlementKind = 'city' | 'town' | 'village';

export interface Settlement {
  id: number;                  // index into world.settlements, stable forever
  name: string;
  r: number;                   // cell
  kind: SettlementKind;
  population: number;
  port: boolean;               // adjacent to an ocean cell
  riverMouth: boolean;         // a river side on this cell ends in ocean
  river: number;               // river index adjacent, or -1
  province: number;            // province index (fixed at founding)
  culture: number;             // culture index at founding
  founded: number;             // year (0 on day one)
  died: number;                // year razed/abandoned, -1 if alive
}

/** Provinces are the political unit: ~140 habitability-weighted regions of ~30 cells. Immutable. */
export interface Province {
  id: number; name: string;
  cells: Int32Array;
  centroid_r: number;          // cell nearest the centroid
  area: number;                // px^2
  coastal: boolean;
  fertility: number;           // mean cell fertility 0..1
  seat: number;                // best settlement index inside, or -1
}
/** CSR adjacency over provinces with shared-border length (px) per link. */
export interface ProvinceGraph {
  p_first: Int32Array;         // length numProvinces + 1
  p_nbr: Int32Array;           // neighbor province indices
  p_border: Float32Array;      // shared border length for each p_nbr entry
}

/** O'Leary-style generated naming language; one per culture. */
export type MorphemeKind = 'city' | 'river' | 'lake' | 'sea' | 'mount' | 'wood' | 'realm' | 'port';
export interface Language {
  consonants: string[]; vowels: string[]; sibilants: string[]; liquids: string[]; finals: string[];
  structure: string;           // syllable template, e.g. 'CVC?' ('?' = optional previous slot)
  minSyl: number; maxSyl: number;
  ortho: Record<string, string>;         // phoneme -> spelling
  morphemes: Record<MorphemeKind, string[]>;
  joiner: string;              // '' | ' ' | '-'
}
export interface Culture {
  id: number; name: string; color: string;  // css color, hue distinct per culture
  language: Language;
  home_p: number;              // province of origin
}

// ---------------------------------------------------------------- politics (the ONLY mutable layer)

export interface Nation {
  id: number; name: string;
  capital: number;             // settlement index
  culture: number;
  color: string;
  founded: number; died: number;  // year, -1 if alive
}
export interface Politics {
  year: number;
  cultures: Culture[];
  nations: Nation[];
  p_nation: Int16Array;        // province -> nation index, -1 unclaimed. Authoritative.
  p_culture: Int16Array;       // province -> culture index
  r_nation: Int16Array;        // cell -> nation, derived from p_nation (recomputed by derivePolitics)
  r_settlement: Int16Array;    // cell -> settlement index or -1
}
/** Everything the renderer needs that depends on ownership. Rebuilt whenever p_nation changes. */
export interface PoliticalView {
  borders: Polyline[];         // chained sides where r_nation differs (nation A vs B or vs unclaimed)
  borderNation: Int16Array;    // for each border polyline, the nation on its left
  nationLabel_r: Int32Array;   // per nation: pole-of-inaccessibility cell, -1 if no territory
  nationArea: Float32Array;    // per nation: px^2
  nationAxis: Float32Array;    // per nation: principal axis angle (radians)
}

// ---------------------------------------------------------------- history (append-only, plain data)

export type EntityKind =
  | 'settlement' | 'province' | 'nation' | 'culture' | 'river' | 'lake' | 'sea' | 'range'
  | 'road' | 'ruler' | 'war' | 'religion' | 'battle';
/** Stable cross-kind reference: `${kind}:${index}`. Used ONLY by the log, the wiki and URLs;
 *  hot loops use the integer index. */
export type Id = `${EntityKind}:${number}`;

export type EventKind =
  // day one (year 0)
  | 'world.created' | 'culture.emerged' | 'settlement.founded' | 'nation.founded' | 'province.claimed'
  // roadmap; adding a kind never changes existing data
  | 'ruler.crowned' | 'ruler.died' | 'war.declared' | 'battle.fought' | 'province.conquered'
  | 'settlement.razed' | 'settlement.grew' | 'migration' | 'religion.founded' | 'road.built'
  | 'plague' | 'famine';

export interface WorldEvent {
  seq: number;                 // append index
  year: number;
  kind: EventKind;
  subjects: Id[];
  at?: number;                 // cell r, when the event has a place
  cause?: number;              // seq of the causing event (provenance)
  data: Record<string, string | number | boolean>;
}
export interface HistoryLog { events: WorldEvent[]; }

// ---------------------------------------------------------------- the world

export interface World {
  seed: string;
  params: WorldParams;
  mesh: Mesh;
  edges: NoisyEdges;
  geo: Geography;
  features: Features;
  provinces: Province[];
  graph: ProvinceGraph;
  r_province: Int16Array;      // cell -> province index, -1 for water
  settlements: Settlement[];
  politics: Politics;
  history: HistoryLog;
  timings: Record<string, number>;  // stage name -> ms
}

/** Save file. Geography regenerates bit-for-bit from (seed, params) while params.version matches. */
export interface WorldFile {
  v: number;                   // ATLAS_VERSION at save time
  seed: string;
  params: WorldParams;
  year: number;
  events: WorldEvent[];
  politics?: { p_nation: string; p_culture: string };  // base64 Int16, present once history exists
}

// ---------------------------------------------------------------- rendering contract

export interface LayerToggles {
  tint: boolean; relief: boolean; forests: boolean; rivers: boolean; waterlines: boolean;
  stipple: boolean; borders: boolean; provinces: boolean; settlements: boolean; labels: boolean;
  grid: boolean; furniture: boolean;
}
export interface RenderOptions {
  scale: number;               // device px per logical px (dpr on screen, 2 or 4 for export)
  layers: LayerToggles;
  fontReady: boolean;          // false -> draw labels in the fallback face (never wait inside render)
}
