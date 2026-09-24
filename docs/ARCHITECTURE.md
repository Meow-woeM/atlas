# Atlas — Architecture

## 1. Vision

Atlas is a browser-native fantasy world generator whose single source of truth is a ~10,000-cell Voronoi graph: every terrain, water, political and historical quantity is a typed array indexed by cell, corner or side, and every line on the map is a chain of mesh sides that is a vector polyline the moment it exists. Type a seed and, in about a third of a second, you get a deterministic, hand-inked parchment map — coasts, mountains, rivers that reach the sea, biomes, lakes, named settlements and nations — exportable as a print-crisp 4x PNG for Creative Cloud. The graph is also the substrate the roadmap runs on: tectonics, roads, a 2000-year history, a Legends wiki, printable atlas pages and a globe are all graph algorithms over the same adjacency lists and the same immutable mesh, so nothing built today needs to be torn out tomorrow.

## 2. Fixed decisions

These are settled. Do not reopen them in code review or in a later session's planning.

| Decision | Value |
|---|---|
| Platform | Browser. TypeScript + Vite 8. Vanilla DOM, no UI framework. Canvas 2D for all rendering on day one (WebGL is a roadmap option, never a day-one dependency). |
| Repo | `C:\Users\noahb\Projects\atlas`, Windows 11. Pushed to GitHub, deployed on GitHub Pages under `/atlas/`. |
| Toolchain (verified in the scaffold) | `typescript ~6.0.2`, `vite ^8.3.0`, `vitest ^5.0.0`; `build = tsc && vite build`. `tsconfig.json` has `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `moduleResolution: bundler`, `target: es2023`. **Consequences: no `enum`, no `namespace`, no constructor parameter properties, `import type` for every type-only import, no unused locals/params.** These go into `CLAUDE.md` before any agent writes a line. |
| Spatial model | Planar dual mesh (Poisson-disc points → Delaunay → Voronoi) with structure-of-arrays typed arrays. One runtime dependency: `delaunator`. A **derived** low-res raster scratch layer (512x384) exists for per-pixel effects (distance field, waterlines, stipple, later hillshade); it is never a source of truth. |
| Determinism | `seed string → xmur3 → sfc32`. Every stage and every named entity draws from its own forked stream. `Math.random` is forbidden in `src/`. A seed reproduces the same world on every machine; label pixel positions may differ by font metrics, geometry never does. |
| Coordinates | All geometry is in **logical px** on a `width x height` canvas (1024x768 default). The renderer draws in logical coordinates after `ctx.scale(k, k)`; screen, 2x and 4x export are the same function call. Every line width, font size and texture wavelength is specified in logical px. |
| Geography | The map has a real lat/lon `GeoFrame` from day one (default: 40 degrees of longitude by 30 of latitude, north up). Latitude drives temperature; the frame drives the scale bar and graticule; base noise is sampled on the unit sphere so a future planet mode shares the same noise field. |
| Political state | Lives in a separate mutable `Politics` layer (owner arrays over provinces and cells), never inside geography objects. The renderer draws borders **only** from an owner array through the same side-chaining used for coastlines. Generators also append year-0 founding events to a plain-data `HistoryLog`; replaying that log is roadmap, not day one. |
| Fonts | `IM Fell English` / `IM Fell English SC` via `fonts.googleapis.com` (allowed on Pages), Georgia/serif fallback, `document.fonts.load` awaited before the first render and before every export. No binary font files in the repo on day one. |
| Day-one performance target | Generate ≤ 200 ms, render at 1x ≤ 150 ms, 4x export ≤ 2.5 s including PNG encode, all on the main thread on a 2020 laptop. No Web Worker on day one. |
| Repo hygiene | `.gitattributes` (`* text=auto eol=lf`), `.editorconfig`, `vite.config.ts` with `base: '/atlas/'`, `.github/workflows/pages.yml` in day-one scope. |

## 3. Spatial model

### 3.1 The mesh

A planar **dual mesh** over the logical canvas, in the Red Blob "dual-mesh" / mapgen4 lineage. Three index spaces, all `Int32`:

| Space | Symbol | Count (r = 8) | Meaning |
|---|---|---|---|
| Regions | `r` | ~9,800 (incl. ~600 boundary) | Voronoi cells = Poisson-disc points = cell centers. All scalar fields live here. |
| Triangles | `t` | ~19,600 (≈ 2N) | Voronoi corners (positions = Delaunay triangle **centroids**, not circumcenters, so skinny hull triangles never throw corners to infinity). Rivers and drainage live here. |
| Sides | `s` | ~58,800 (= 3T) | Half-edges. Each side is one Voronoi edge as seen from one cell; `s_opposite_s[s]` is its twin (`-1` on the hull). Coasts, lake shores, borders and rivers are sets/chains of sides. |

**Points.** Bridson Poisson-disc sampling with radius `r = params.cellSpacing = 8` logical px, `k = 30` candidates, background grid cell `r/√2`. Bridson reaches ~65% of hexagonal packing density, so interior count ≈ `0.75 · W·H / r²` ≈ 9,200 at 1024x768. Plus a **boundary ring** of points at spacing `r` placed `2r` outside the rectangle (~600 points); the first `numBoundaryRegions` regions are this ring, they are always ocean, and their presence guarantees every visible cell is a closed polygon and no hull triangle touches the map.

**Triangulation.** `delaunator` on the point set (~6 ms for 10k points). From `triangles` / `halfedges` we derive: `s_start_r[s] = triangles[s]`, `s_opposite_s[s] = halfedges[s]`, `r_first_s[r]` = one outgoing side per region, `t_x/t_y` = centroid of triangle `⌊s/3⌋`. Accessors are pure index arithmetic:

```
s_next_s(s)   = s % 3 === 2 ? s - 2 : s + 1
s_prev_s(s)   = s % 3 === 0 ? s + 2 : s - 1
s_end_r(s)    = s_start_r[s_next_s(s)]
s_inner_t(s)  = ⌊s / 3⌋
s_outer_t(s)  = ⌊s_opposite_s[s] / 3⌋      (-1 on the hull)
r_circulate_s(r) : walk r_first_s[r] → s_next_s(s_opposite_s(s)) … until back (avg 6)
t_circulate_r(t) : the 3 cells s_start_r[3t], s_start_r[3t+1], s_start_r[3t+2]
```

Because judges flagged this as the riskiest 200 lines in the project, the mesh module ships with vitest invariants (`s_opposite_s[s_opposite_s[s]] === s`, every interior region's circulation closes with 3..12 sides, every `t` has 3 distinct regions, every interior side's inner/outer `t` differ, `cellPolygon` areas sum to ≈ W·H). The mesh is **immutable** for the life of a world.

**Noisy edges (day one, not a fallback).** At r = 8 a Chaikin-smoothed Voronoi edge is a blob with a vertex every ~32 px at 4x. So, as in mapgen2, every side gets a precomputed **subdivided path** inside the quadrilateral formed by its two cell centers and two corners: recursive midpoint displacement, 2 levels (5 points per side), amplitude 0.5 of the quad's half-width, from `fork(seed, 'edges')`. Stored once per undirected edge; `sidePath(edges, mesh, s)` reads it reversed for the twin. **Every polyline built from sides — coast, lake shore, border, river — is assembled from noisy paths, then Chaikin x1**, so the 4x coast is inked-fractal rather than smooth.

### 3.2 The raster scratch layer

Some effects are honestly per-pixel: thin parallel waterlines that stay correct in bays and straits, coastal stipple density, sea-label anchors, and (roadmap) hillshade and a 16-bit heightmap for Photoshop displacement. Instead of faking them with clipped strokes, we **derive** a raster from the mesh:

- `rasterizeCells(mesh, r_field, w, h)` scan-fills each cell polygon into a `Float32Array` at `rasterScale = 0.5` (512x384 = 196,608 px, ~5 ms, deterministic, no canvas).
- `edt(mask)` — Meijster/Felzenszwalb exact signed Euclidean distance transform (two separable passes, ~8 ms).
- `marchingSquares(field, iso)` with linear interpolation and endpoint-hash ring stitching (~3 ms per iso).

Day one uses it for the land mask only. `Geography.distField` keeps the EDT; `r_coastDist` is that field sampled at cell centers (signed px: + land and inland water, − ocean; the field is ocean-only) and is the continentality/harbor term for climate and settlements. The raster is regenerated from the mesh whenever needed and never serialized.

### 3.3 Where things live

| Quantity | Space | Type |
|---|---|---|
| elevation, water kind, coast hops/dist, lat/lon, temperature, moisture, biome, slope, province, settlement | `r` | `Float32Array` / `Int16Array` / `Uint8Array` |
| filled elevation, downslope side, flux, lake id | `t` | `Float32Array` / `Int32Array` / `Int16Array` |
| river flux, river id | `s` | `Float32Array` / `Int16Array` (set on both half-edges) |
| nation / culture ownership | `p` (province) mirrored to `r` | `Int16Array` |
| coast loops, lake shores, river polylines, borders, waterlines | features | `Polyline { pts: Float32Array, closed }` |

**Memory** at r = 8: cells ~10k x 14 fields x 4 B ≈ 560 KB; corners 20k x 5 x 4 ≈ 400 KB; sides 60k x 5 x 4 ≈ 1.2 MB; noisy edges ~30k edges x 5 pts x 8 B ≈ 1.2 MB; Delaunator arrays ~500 KB; raster 0.8 MB. **Whole world ≈ 4.5 MB.** A 4x export canvas (4096x3072 RGBA, 50 MB) is transient.

**Resolution knob.** `cellSpacing` is the only knob: 6 → ~17k cells ("detailed"), 12 → ~4k ("instant"). Nothing downstream is written against a grid or a cell count.

**Topology-only rule.** Generation code may touch the world only through the mesh accessors and per-index typed arrays. Raw `x/y` may be read in exactly four named helpers: `cellLatLon(r)`, `cellUnitVector(r)` (sphere position for noise), `downwindOrder(mesh, windDir)` (sorted cell list for the moisture sweep), and `cellPolygon` (geometry for rasterization/rendering). Anything else that wants coordinates is a bug. This is what makes the globe a mesh swap.

## 4. Core data model

This block becomes `src/core/types.ts` nearly verbatim. Plain data only: typed arrays and POJOs, structured-cloneable, JSON-able with base64 for typed arrays. No classes, no enums, no methods on data.

```ts
// src/core/types.ts
// The contract every module codes against. Plain data only (typed arrays + POJOs):
// structured-cloneable, no classes, no enums, no methods on world data.

export const ATLAS_VERSION = 1;

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
  nations: number | 'auto';   // 'auto' (stage 11 picks K); a number asks for exactly that many
}

export const DEFAULT_PARAMS: WorldParams = {
  version: ATLAS_VERSION, width: 1024, height: 768, cellSpacing: 8, rasterScale: 0.5,
  frame: { lon0: -20, lon1: 20, lat0: 58, lat1: 28 },
  landFraction: 0.42, continents: 2, windDir: 'random', lakesMax: 8, riverPercentile: 0.94,
  provinceSpacing: 48, settlementsMax: 40, nationsMax: 8, nations: 'auto',
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
```

## 5. Generation pipeline

`generate(seed, params)` in `src/gen/world.ts` runs the stages below in this order, records `timings[name]`, and returns a `World`. Every stage is a pure function of explicit inputs plus one forked RNG; stages never read `location`, `Date`, or `Math.random`. RNG stream names are literal and frozen: renaming a label or changing the order in which a stage consumes randomness is a `params.version` bump.

| # | Stage | Module | RNG stream | Reads | Writes | Budget |
|---|---|---|---|---|---|---|
| 0 | Seed and streams | `core/rng.ts` | — | seed | forks | 0 ms |
| 1 | Points | `mesh/poisson.ts` | `points` | params | `Float64Array` xy, numBoundary | 8 ms |
| 2 | Mesh | `mesh/dualmesh.ts` | — | points | `Mesh` | 12 ms |
| 3 | Noisy edges | `mesh/noisy.ts` | `edges` | mesh | `NoisyEdges` | 8 ms |
| 3.5 | Plates | `gen/tectonics.ts` | `tectonics` | mesh, params | `Tectonics` (r_plate, velocities, r_craton, r_stress) | 15 ms |
| 4 | Elevation | `gen/elevation.ts` | `elevation` | mesh, params, tectonics | `r_elevation r_water r_coastHops r_slope r_lat r_lon formation` | 25 ms |
| 5 | Distance field | `core/raster.ts` via `gen/elevation.ts` | — | mesh, r_water | `distField r_coastDist` | 15 ms |
| 6 | Climate | `gen/climate.ts` | `climate` | geo | `r_temperature r_moisture windDir` | 5 ms |
| 7 | Hydrology | `gen/hydrology.ts` | — | mesh, geo | `t_elevation t_downslope_s t_flux t_lake s_river s_riverId r_water(lakes)`, river/lake cell sets | 15 ms |
| 8 | Biomes | `gen/climate.ts` | — | geo | `r_biome` | 2 ms |
| 9 | Provinces | `gen/provinces.ts` | `provinces` | mesh, geo | `provinces r_province graph` | 12 ms |
| 10 | Settlements | `gen/settlements.ts` | `settlements` | mesh, geo, provinces | `settlements r_settlement` | 6 ms |
| 11 | Cultures and nations | `gen/politics.ts` | `politics` | graph, provinces, settlements | `politics` (cultures, nations, p_nation, p_culture, r_nation), events | 8 ms |
| 12 | Names | `gen/names.ts` | `names/…` per entity | everything | `name` fields | 3 ms |
| 13 | Features | `gen/features.ts` | — | mesh, edges, geo | `features` | 15 ms |
| 14 | Political view | `gen/features.ts` | — | mesh, edges, politics | `PoliticalView` (held by main, not in World) | 5 ms |
| 15 | History log | `gen/world.ts` | — | all | `history.events` (~200 year-0 events) | 1 ms |

Total ≈ 140 ms generation on a 2020 laptop; the 2 s budget is a 10x margin. Stages 12 and 13 execute in the order **features, names**: `assignNames` needs the rivers, lakes, seas and ranges to exist, while `extractFeatures` needs only the mesh, the noisy edges, the geography and the hydrology result; every stage draws from its own fork, so the numbering above is the naming order and `generate` records `timings` under the keys `points, mesh, edges, tectonics, elevation, distance, climate, hydrology, biomes, features, provinces, settlements, politics, names, history` in execution order.

### Stage 0 — Seed and streams

`makeRng(seed)` hashes the seed string with xmur3 and seeds sfc32 (four 32-bit words). `fork(seed, ...labels)` = `makeRng(seed + '/' + labels.join('/'))`. Each stage receives `fork(seed, '<stage>')`; per-entity randomness uses `fork(seed, 'names', 'settlement:12')`, so adding or reordering a later stage — or renaming one entity — never reshuffles anything else. The default seed when the URL hash is empty is a random 8-character word from the browser's `crypto.getRandomValues` (the only non-deterministic call in the app, and it is in `main.ts`, not `src/gen`).

### Stage 1 — Points

Bridson Poisson-disc in `[0,W]x[0,H]`, `r = cellSpacing`, background grid `r/√2`, active list consumed with `rng.int`. Then the boundary ring at spacing `r`, `2r` outside the rectangle, prepended so ring regions are `[0, numBoundaryRegions)`. Output: `{ points: Float64Array, numBoundary }`.

**Retuned (2026-09-18, `ATLAS_VERSION` 2).** The candidate loop is Roberts' few-candidate variant rather than Bridson's `k = 30` uniform one: `k = 6` candidates per active point, their angles stratified one per `2π/k` sector from a random base angle, and the radius drawn from the narrow annulus `[r, 1.3r)` instead of `[r, 2r)`. Stratified angles plus near-`r` radii pack as densely in 6 candidates as uniform sampling does in 30. The neighbour scan is the 5×5 grid block minus its four corner cells — a point in cell `(gx±2, gy±2)` is always more than `(r/√2)·√2 = r` away — walked centre outwards so a candidate blocked by a near neighbour returns on the first cells. Measured at the default parameters over five seeds: **46.4 ms → 10.6 ms** (−77%), interior points 7,742 → 8,254, min pairwise distance still `≥ r`, worst uncovered gap 9.2 px → 10.4 px, nearest-neighbour CV 0.077 → 0.055 (slightly *more* even than Bridson). Still ~1.3× the 8 ms budget.

### Stage 2 — Mesh

`new Delaunator(points)`; build `s_start_r`, `s_opposite_s`, `r_first_s`, `t_x/t_y` (centroids). Regions `< numBoundaryRegions` are boundary. Delaunator is deterministic floating point; no RNG.

### Stage 3 — Noisy edges

For each canonical side (`s < s_opposite_s[s]` or hull), take the quad `(r_a, t_in, r_b, t_out)` and recursively displace the midpoint of `t_in→t_out` toward a random point on the `r_a→r_b` segment (amplitude 0.5 of the quad, 2 levels). Output `NoisyEdges`. `fork(seed,'edges')`.

### Stage 3.5 — Plates (added 2026-09-18)

The roadmap's Tectonics item, landed. `plates` seed cells are grown by one multi-source BFS over the cell graph (seeds pushed in plate order, so an equidistant cell joins the lower index and every region ends on exactly one connected plate). Each plate gets a drift heading and speed — rigid-body, no rotation. Per cell, stress is the neighbour across a plate boundary with the largest |convergence|, where convergence is `dot(v[mine] − v[theirs], unit vector from me to them)`: positive closes (uplift, a mountain belt), negative opens (a rift). Interior cells start at 0 and gain stress only by diffusion, which is what gives a belt a width instead of a one-cell seam. Cratons come from a per-plate continental/oceanic flag, also diffused so a continent's edge is a gradient rather than a plate-shaped cliff.

Two things about the continental cores are load-bearing, both learned by measuring:

- **They must be spread, not drawn at random.** Adjacent cratons merge into a supercontinent whose interior sits ~230 px from any coast, which stage 6 turns into a continent-sized desert. Cores are chosen by farthest-point sampling over the plate seeds: the first is drawn, the rest draw nothing.
- **Their count must track `landFraction`, not `continents`.** With 2 cores covering 22% of the map against a 42% land target, the sea-level quantile has to promote that much noise-driven land, and it arrives as stringy fragments rather than as coastline — settlements on a coast ran 62-79%. At `round(plates × landFraction)` = 4 cores that falls to 37-67% and inland settlements clear 30% on every seed. `params.continents` is now a **floor** on the core count, not the count.

`r_circulate_r` breaks its walk at the hull, so on the boundary ring it reports `r → q` without `q → r` — exactly 464 one-way pairs on the default mesh. Any graph algorithm over the cell graph that assumes symmetry has this trap; the plate-connectivity test symmetrises first.

### Stage 4 — Elevation

1. `r_lat`, `r_lon` from the frame (`cellLatLon`), `cellUnitVector(r)` from lat/lon.
2. **Noise on the sphere** (grafted from the raster pitch): 3D simplex with a permutation table shuffled by the stage RNG, 6-octave fBm (lacunarity 2, gain 0.5), frequency chosen so the base wavelength is ~1/3 of the frame's width, domain-warped once: `p' = p + 0.08 · (fbm(p+o₁), fbm(p+o₂), fbm(p+o₃))`. ~18 evaluations x 10k cells ≈ 7 ms. A planet mode later samples the same field at the same frequency.
3. **Continent mask**: `params.continents` Gaussian blobs (centers/radii from the RNG, restricted to the inner 70% of the canvas) max-combined, times an edge falloff so ≥ 40 px of ocean margin always exists. `raw = 0.65·fbm + 0.35·mask`.
4. **Sea level by quantile** over interior cells: `sea = quantile(raw, 1 − landFraction)`. `r_water = raw < sea ? 1 : 0`; boundary ring forced to water.
5. **Ocean flood fill** from the ring across water cells: reached = ocean (1); unreached water = lake candidate (temporarily 2; hydrology decides).
6. **Coast hops**: multi-source BFS from ocean cells → `r_coastHops`.
7. **Reshape** (mapgen2's coast-distance trick): rank land cells by `raw`, `rankNorm ∈ [0,1]`; `r_elevation = 0.55·rankNorm^1.5 + 0.45·(hops/maxHops)^0.8`; water cells get `−(sea − raw)/sea` clamped to `[-1, 0)`.
8. `r_slope[r] = max |r_elevation[r] − r_elevation[nbr]|`.

**The formation timeline (added 2026-09-18).** The three fields raw height mixes — basement noise, craton and uplift — do not depend on time; only how much of each is mixed in does. So `Formation` stores the three fields once and `rawAtStep` evaluates a moment in one pass over the cells, instead of storing a snapshot per step. Sea level is **absolute**: the `landFraction` quantile of raw at the LAST step, which every earlier step is measured against, and it is why the last step reproduces the world as if there were no timeline at all. Land fraction is monotonic in the step up to a hair (with plate drift a step may lose at most 0.3% of the map, and the present is above every earlier step) and lands on `params.landFraction` at the end; `elevation.test.ts` asserts both. `FORMATION_STEPS` is 96 (24 until the live scrub; finer steps make the drift smoother at the same frame rate) and `params.formationStep` selects the moment. `landMaskAtStep` is the cheap land/sea read (kept for tests and tools); the UI no longer previews with it — see the live scrub below.

**Plate drift (added 2026-09-23).** The first timeline only ramped the three fields up, so every world's story was islands rising out of an empty sea. Now the crust rides its plate. A plate of velocity `v` still has `drift × (1 − u)` px of travel ahead of it at position `u` on the timeline (`drift` = 160 logical px per unit speed; speeds are 0.4–1), so the crust sitting at cell `r` then is the crust that will END at `q = r + v · drift · (1 − u)`: `rawAtStep` reads the final noise and craton of the cell nearest `q` through `Formation.lookup` (a uniform grid over the centroids, `buildCellLookup` / `nearestCell` in `mesh/dualmesh.ts`, bucket 2 × `cellSpacing`). When `q` lies on another plate that crust does not exist yet — it is the ocean the collision has since closed — and `r` reads as bare sea floor: its own basement noise and no craton. Uplift stays where the belts are (the plate boundaries) and ramps up as the plates arrive. So converging continents close an ocean and raise mountains where they meet, diverging ones split along their rift, and the present day (`u = 1`, displacement 0) is the stored fields bit for bit — the lookup never touches the final world, so no `ATLAS_VERSION` bump. The ramp floors moved with it (basement 0.55 → 0.75, craton 0.30 → 0.70): the continents are there from the first step and move, rather than rise from nothing. Measured at the defaults over the four tuning seeds: land 0.16–0.22 at step 0, 0.42 at the last, no step loses land overall, and 3–7% of cells are land at some earlier step and sea by the present (the crust that moved). A step evaluates in ~1.2 ms.

**Live scrub (2026-09-23, later the same day).** The scroll bar no longer shows a silhouette while dragged; it shows the real world of each step changing under the pointer. Stage 4 is split into `buildFormation` (the RNG draws, the noise, the fields, the lookup, the absolute sea — once per seed) and `elevationAtStep` (water mask, flood fill, hops, reshape, slope — per moment, no RNG), and `gen/world.ts` is split the same way: `prepareBase` runs points, mesh, edges, tectonics and `buildFormation`; `generateFromBase(base, params, geographyOnly?)` runs `elevationAtStep` through history, or with `geographyOnly` stops after features and leaves provinces, settlements, politics, names and history empty. `generate` is `generateFromBase(prepareBase(...))`, so a base world at step `s` is identical to `generate(seed, { formationStep: s })` (`world.test.ts` asserts it). Each animation frame of a drag calls `generateFromBase(..., true)` at the bar's step and renders the geography layers through `renderWorld` with the political, label and furniture layers off, plus `renderFrame`; when the drag ends the full pipeline runs at that step and only borders, towns, labels and the cartouche are added on top of what is already drawn. Frames coalesce (one scheduled at a time, the latest value wins), so a slow step never builds a backlog.

### Stage 5 — Distance field

`rasterizeCells(mesh, r_water === 1 ? 0 : 1, 512, 384)` → mask of everything that is not ocean (land and inland water), so the field measures distance to the ocean coastline only and hydrology's lake decisions never invalidate it; `edt(mask)` → signed distance in raster px, multiplied by `1/rasterScale` into logical px → `distField`. `r_coastDist[r] = bilinear(distField, r_x, r_y)`. No RNG.

### Stage 6 — Climate

- `windDir` = params or `rng.int(0,7)`.
- Temperature: `base = 1 − (|lat| / 90)^1.5` (0.83 at 28 N, 0.48 at 58 N), `r_temperature = clamp(base − 0.55·max(0, elevation)^2, 0, 1)` (lapse-rate analogue; squared so only high mountains go cold, the northern lowlands read boreal and the southern lowlands subtropical).
- Moisture: sort cells by `dot(pos, windVector)` (`downwindOrder`, one of the four coordinate helpers), sweep downwind. Ocean cells carry 1.0, lakes 0.8. Land cell: `carried = max over upwind neighbors (m[nbr]·0.985 − 2.5·max(0, elev[r] − elev[nbr] − 0.04))`, floored at 0.04; then `r_moisture = 0.7·carried + 0.3·(1 − clamp(r_coastDist / 260, 0, 1))`. Rain shadows behind ridges come out of the subtraction term; the 0.04 per-hop allowance ignores the gentle inland climb of the stage-4 reshape (which would otherwise exhaust the carried moisture within ~8 hops of a windward coast) and charges only real ridges. The roadmap climate sim replaces this file behind the same signature.

### Stage 7 — Hydrology (corner graph)

1. `t_raw[t] = mean r_elevation` of its 3 cells. Ocean corners = corners touching an ocean cell.
2. **Priority-Flood + ε** (Barnes, Lehman, Mulla 2014) seeded from ocean corners at their raw height; binary heap keyed on `(height, t)` — the index tie-break makes it deterministic. Every land corner ends with a strictly lower neighbor. → `t_elevation`.
3. **Lakes**: corners with `t_elevation − t_raw > 0.005` are lake corners. A land cell whose 3+ corners are all lake corners is a lake cell; connected components of lake cells with ≥ 4 cells become lakes (largest `lakesMax`, others revert to land and simply carry a river); `r_water = 2`, `t_lake` set on all corners of lake cells; outlet = the lowest corner on the component's boundary. This cell-based definition means the lake shore (sides between lake and non-lake cells) and the river endings (first corner with `t_lake ≥ 0`) always coincide.
4. `t_downslope_s[t]` = side toward the lowest neighbor corner (`−1` at ocean and lake corners).
5. **Flow accumulation**: corners sorted by `t_elevation` descending (index tie-break); `t_flux[t] += mean r_moisture of its cells`, then `t_flux[down] += t_flux[t]`. Lake corners pass their flux to the lake outlet.
6. **Rivers**: threshold = `riverPercentile` quantile of land-corner flux. Sources = corners above threshold with no upstream corner above threshold. Walk each source downhill via `t_downslope_s` until an ocean/lake corner or an already-claimed side (→ `parent`); write `s_river`/`s_riverId` on both half-edges; drop rivers shorter than 6 sides. Output river side lists (ordered source → mouth) for `features`.

### Stage 8 — Biomes

Whittaker lookup: 4 temperature bands x 6 moisture bands (mapgen2 table) into `BIOMES`; the band edges are fitted constants in `gen/climate.ts` (temperature 0.35 / 0.50 / 0.65, moisture 0.45 / 0.50 / 0.63 / 0.70 / 0.86, fitted 2026-09-16 to the stage-6 distributions at the default params). Adjustments before lookup: +0.10 moisture for wet cells — a river side, lake neighbor or lake corner (floodplains read fertile); wet coast cells with `elevation < 0.08` and adjusted `moisture > 0.7` → `marsh` (a river mouth or lakeshore on the coast, ~1% of land; a wet climate alone never makes one); `elevation > 0.85` → `snow` regardless. Water cells get `ocean`/`lake`.

### Stage 9 — Provinces (grafted from the sim pitch)

Sites: Bridson Poisson-disc restricted to land cells with radius `provinceSpacing / sqrt(fertility + 0.25)` (dense in fertile lowlands, sparse in deserts and mountains), ~100 sites (measured 92-108 at defaults). Growth: multi-source Dijkstra over the land-cell graph with cost `1 + 4·|Δelev| + 5·(side carries a river) + 0.5·(biome changes) + 2·(elev > 0.6)`, so province borders hug rivers and ridgelines. Then a single pass over sides builds the CSR `ProvinceGraph` with shared border lengths (`polylineLength` of the noisy side path), centroids, areas, coastal flags and mean fertility. Islands with no site get one site at their most fertile cell. Provinces are independent of settlements on purpose: history will found and raze cities without touching the political unit.

### Stage 10 — Settlements

Score every land cell: `2.0·fertility[biome] + 0.05·coast + 0.5·riverSide + 0.3·riverMouth + 0.05·harbor − 1.0·elevation − 1.5·slope + 0.2·rng.next()` (weights retuned 2026-09-17: the original `0.6 / 0.8 / 1.2 / 0.5` on fertility x1 made every settlement a river-mouth port; the coast is already favoured by its fertile biomes and low elevation, and nearly every coastal cell passes the harbor test, so coast + harbor act as one 0.1 weight), where `harbor` = 1 if the cell has 1–3 ocean neighbors and `r_coastDist` of those neighbors' offshore side suggests shelter (mean `distField` within 24 px offshore > −12). Landmasses (land components) under 20 cells take no settlement: an islet lies outside every mainland suppression BFS and would otherwise always collect one, which politics then turns into a free-city nation. Greedy placement with suppression: pick the best, then subtract `2.5·(1 − depth/10)` from every cell within BFS depth 9 over land; repeat until `n = clamp(landCells / 90, 15, settlementsMax)` (measured at defaults over four seeds: 36 settlements, 39–56% ports, 42–50% river-side, 7 nations). Kind by rank: top 20% cities, next 35% towns, rest villages; population = kind base x (0.7 + 0.6·rng). `port`, `riverMouth`, `river`, `province` set from the cell. Each province's `seat` = its highest-scoring settlement.

### Stage 11 — Cultures and nations

- `K = clamp(round(n / 5), 3, nationsMax)` capitals = highest-scoring settlements re-chosen with a 150 px spacing, one per province at most. **Requested count (2026-09-23):** when `params.nations` is a number, `K` is that number; if the spacing seats fewer, it is relaxed (× 0.7 per retry, floored at 1 hop) until `K` are seated or the spacing is 1 hop.
- One culture per capital; `home_p` = capital's province; `p_culture` by Dijkstra over the province graph with cost `1 + hostility(biome) + 3·(mountain link)`, so culture edges follow mountains and deserts.
- Nations: Dijkstra over the **province graph** from the K capitals, link cost `1 + 3·cultureMismatch + 2·(shared border < 20 px) + 4·(either province mean elev > 0.6)`, ocean impassable, capped at 12 hops; every province joins the nearest capital → `p_nation`. Provinces on islands unreachable from any capital become free cities (`p_nation` = a new nation whose capital is the island's best settlement) if they have a settlement, else unclaimed (`-1`).
- `derivePolitics` fills `r_nation` from `p_nation` through `r_province`.
- Emit events: `culture.emerged`, `nation.founded`, one `province.claimed` per province (`cause` = the nation's founding seq), `settlement.founded` for every settlement.

**Corrected 2026-09-18 (review).** The doc used to say `cultures.length === K`. It is `cultures.length === nations.length`: every free city gets its own culture too, because names.ts needs a language per nation. For the same reason `nationsMax` caps only the **primary**, capital-seeded nations (`K = clamp(round(n / 5), 3, nationsMax)`, the `nationsMax` clamp applied last so it wins over the minimum of 3) — free cities are appended after it, so `nations.length` may exceed `nationsMax`. Measured at seed `probe`: `continents: 1` gives 9 nations and `continents: 3` gives 10 against the default `nationsMax` of 8. That is the intended behaviour (an island with a town is a polity), not a bug; it is the doc and the `nationsMax` comment that were wrong.

**Requested count and free cities (2026-09-23).** With `params.nations` a number, step 7 founds free cities only while `nations.length` is below it; every later settled component is **annexed** by the nation whose capital cell is nearest (Euclidean over `cellCentroids`, lower index on ties) to the component's best settlement, and provinces of the component that had no culture take the annexing nation's. The world therefore ends with exactly the requested number whenever that many capitals could be seated (the UI offers 3–12; `generate('atlas', { nations: 12 })` gives 12). `'auto'` is the day-one behaviour above, unchanged.

Nothing in this stage writes to any geography object, and nothing outside `Politics` stores a nation index except `Settlement.culture` (a founding fact).

### Stage 12 — Names (O'Leary languages, grafted from the sim pitch)

`makeLanguage(fork(seed,'names','culture:<i>','lang'))` samples a consonant inventory (from ~8 archetype sets), vowels, sibilants/liquids/finals, a syllable structure (`CV`, `CVC`, `CVC?`, `CCVC?`…), 1–3 syllables, an orthography map (e.g. `sh→sh|š|ch`, doubled consonants, apostrophes) and morphemes for each `MorphemeKind`. Every entity is named from its own fork `fork(seed,'names','<kind>:<id>')` with the language of its culture (rivers/lakes/ranges/seas: the culture with the most adjacent cells; the world: the largest nation). Port and river-mouth settlements append a `port` morpheme 40% of the time; rivers take `river` morphemes; tributaries are "Little X"-style derivations 30% of the time. A world-wide `Set` rejects duplicates with a local re-roll. World title = `'The ' + languageName + ' Lands'` variants.

### Stage 13 — Features

- **Coast**: sides where `r_water[start] === 0 && r_water[end] !== 0` (land on the left), chained into loops via a corner→next-side map (each coast corner has exactly one outgoing coast side), assembled from noisy paths, Chaikin x1. Drop loops shorter than 4 sides (rendered as nothing; they are already tinted).
- **Lake shores**: same with lake/non-lake sides.
- **River paths**: noisy side paths in order source→mouth, Chaikin x1, clipped at the first lake/ocean corner. `length` = polyline length.
- **Waterlines**: `marchingSquares(distField, iso)` for each of `WATERLINE_ISOS`, scaled to logical px, Chaikin x1. Correct in bays and straits because the field is exact.
- **Seas**: connected components of ocean cells (interior only), the 2 largest → `NamedArea` with `label_r = argmax distField` inside the component and PCA axis of the cell centers.
- **Ranges**: connected components of cells with `elevation > 0.62`, ≥ 12 cells → `NamedArea` with pole = cell maximizing BFS distance to the component boundary.
- **Political view**: `buildPoliticalView(world)` chains sides where `r_nation` differs (nation on the left is `borderNation`), noisy + Chaikin; per nation, area, PCA axis, and the pole-of-inaccessibility cell (BFS from border cells inward, take the last visited). Rebuilt whenever `p_nation` changes; that is the entire coupling between the sim and the renderer.

### Stage 15 — History log

`history.events[0]` is `world.created` (`seq 0`, `year 0`, no subjects, data `{ title: worldTitle(world), seed }`), followed by the stage-11 events in their generation order, re-numbered so that `seq` is the position in the final array (each stage-11 seq + 1) and every `cause` shifted by +1 to keep pointing at the same event. All at `year 0`; ~200 plain objects. `gen/world.ts` also assembles `Geography` between stages 7 and 8: `r_elevation` is a copy of the stage-4 array in which hydrology's reverted lake candidates (`HydrologyResult.revertedCells`, cells that arrived as `r_water 2` and leave as land) are lifted to `max(0.005, mean stage-4 elevation of their land neighbours above 0)` (0.005 when there is none), `r_slope` is recomputed for those cells and their neighbours and `r_coastHops` restated as 1 + the minimum neighbour hops; `r_water` is hydrology's copy; `r_biome` is computed after hydrology from that geography. `toWorldFile` stores `p_nation` / `p_culture` as base64 of their little-endian Int16 bytes (node `Buffer` or `btoa` / `atob`, feature-detected); `fromWorldFile` refuses a file whose `v` is not `ATLAS_VERSION`, regenerates, restores the two arrays (their length must equal the regenerated province count), reruns `derivePolitics` and sets `year` and `events`.

## 6. Rendering

### 6.1 Contract

```ts
renderWorld(world: World, view: PoliticalView, ctx: CanvasRenderingContext2D, opts: RenderOptions): void
```

sets `ctx.setTransform(opts.scale, 0, 0, opts.scale, 0, 0)` once and draws every layer in logical px. All hand-drawn wobble, glyph jitter and parchment grain come from `fork(world.seed, 'ink', <layer>)`, so the 4x export is the same picture as the screen, only crisper. Raster-sampled layers (parchment grain, tint, later hillshade) are built at the **output** pixel size so grain and shading are constant in millimeters across scales. The renderer consumes only `World`, `PoliticalView` and the mesh accessors; it never runs generation logic.

### 6.2 Layer order (back to front)

| # | Layer | Toggle | Technique |
|---|---|---|---|
| 1 | Parchment | — | Flat `#e9dcb8`; a cached offscreen value-noise canvas at 1/4 output resolution drawn with `multiply` at α 0.35; radial vignette to `rgba(80,50,20,0.25)`; ~400 dark specks and ~150 faint fiber strokes at α 0.04. Cached per (output size, seed) for sheets up to 32 MiB; the 4x sheet is transient. |
| 2 | Ocean wash | — | Fill the frame with `#d9cfae`, then fill the **land path** (all `features.coast` loops in one `Path2D`, `evenodd`) with `#e9dcb8`. No per-cell union. |
| 3 | Waterlines | `waterlines` | Stroke `features.waterlines[i]` at widths 0.9/0.7/0.5/0.4 px and α 0.55/0.35/0.2/0.1 in sea-ink `#3b4a5a`. True thin parallel lines from the distance field. |
| 3b | Stipple | `stipple` | Dots on ocean cells with `−30 < r_coastDist < 0`, count per cell `∝ 1/(1+|dist|/6)`, positions from the ink RNG. Engraved alternative to waterlines; both may be on. |
| 4 | Biome tint | `tint` | Per-cell fills of the muted 16-entry palette into an offscreen canvas at 1/4 output resolution, `ctx.filter = 'blur(2px)'` (in that canvas's px), then `drawImage` scaled up with smoothing, clipped to the land path, α 0.55, `multiply`. The blur turns hard 8 px polygon edges into soft gradients; there is no stained glass because no tint edge is ever sharp. Cell outlines are never stroked anywhere. |
| 5 | Lakes | — | Fill `#cfd6c4`, ink outline 0.9 px, one inner waterline offset by a 3 px parchment stroke under a 0.5 px ink stroke. |
| 6 | Forests and marsh | `forests` | Forest biomes: 1–3 tree glyphs per cell on every other cell (deciduous: circle-over-stroke scribble; taiga: conifer chevrons); marsh: paired horizontal ticks. Painter's order by y. |
| 7 | Relief | `relief` | Cells with `elevation > 0.62`: mountain glyph at center + jitter, size `8 + 16·(elev−0.62)/0.38`, asymmetric peak filled with parchment, ridge stroke 1.1 px, 2–3 hatch strokes on the shadow (east) face, 4 path variants; `0.42–0.62`: hill arcs; sorted by y so nearer peaks overlap farther ones. ~3–5k paths. |
| 8 | Rivers | `rivers` | `riverPaths[i]` stroked per segment with width `0.6 + 1.6·sqrt(flux_along / maxFlux)` (taper from source), round joins, ink; a 0.4 px lighter parallel stroke gives the pen highlight. Drawn before the coast so mouths meet the coast ink cleanly. |
| 9 | Coastline | — | Stroke coast loops 1.5 px ink α 0.9, then a second 0.5 px stroke offset 1 px inland (double-line coast). |
| 10 | Borders | `borders` / `provinces` | Nation borders: 9 px stroke in the nation's color at α 0.18 clipped to the nation's side of the line (clip = that nation's own `PoliticalView` border loops in one `Path2D` per nation under the nonzero rule — the nation is on every loop's left, so an enclave's loop winds the other way and is excluded — built once per view and memoized on the view object; the renderer never reads `r_nation`), then a 1 px dashed ink `[6,4]`. Province borders: 0.5 px dotted, faint. |
| 11 | Settlements | `settlements` | City: castle glyph (rect + two towers) with dot; town: double circle; village: dot; capital: castle with a flag; port: anchor tick. |
| 12 | Labels | `labels` | See 6.3. |
| 13 | Graticule | `grid` | Lines every 5 degrees from the frame, 0.4 px α 0.35, degree labels in the margin. Drawn under 12. |
| 14 | Furniture | `furniture` | Double-line frame with corner ornaments; 8-point compass rose (alternating filled/outlined points) at the corner with the fewest label boxes; scale bar in km from the frame (`kmPerPx` at the frame's mid-latitude); title cartouche with world title and seed in small type. |

### 6.3 Labels

`placeLabels(world, view, measure, opts)` is pure and returns `PlacedLabel[]`; `drawLabels` paints them. Fonts: `IM Fell English` (settlements, rivers italic), `IM Fell English SC` (nations, seas, ranges), Georgia/serif fallback. All text is drawn as a 3 px parchment `strokeText` halo then an ink `fillText` (grafted from the raster pitch), so labels stay legible over hatching.

- Settlements: 8/10/13 px by kind (+2 for capitals), 4 offsets (NE, SE, NW, SW) tried against an axis-aligned box list in priority order (capitals, cities, towns, villages); first non-colliding wins, villages drop. The box list starts with every living settlement's icon square and, for ports, the anchor tick's box, both anchored at the cell center `r_x/r_y` where layer 11 draws the glyphs.
- Nations: letter-spaced small caps at `nationLabel_r`, size `14 + 10·sqrt(area / maxArea)`, rotated to the nation's principal axis clamped to ±12 degrees.
- Rivers: the 3 longest get text-along-path on the straightest window ≥ 1.2x text width, one glyph per `fillText` rotated to the local tangent, flipped to stay upright.
- Seas and ranges: italic (seas) / small caps (ranges), tracked, straight along the PCA axis at the pole cell.

### 6.4 Export

`exportPng(world, view, k, opts)` creates a detached `<canvas>` of `(W·k) x (H·k)`, `k ∈ {1, 2, 4}`, calls `renderWorld` with `scale = k` and the same toggles, `canvas.toBlob('image/png')` → object URL → `<a download="atlas-<seed>-<k>x.png">`. 4x = 4096x3072, under every browser's canvas limits; expect ~1.2 s to draw and ~1 s to encode, behind a "Rendering…" overlay. Because parchment grain and tint are regenerated at output resolution and every line is a vector, the 4x output is print-crisp (13.6 x 10.2 in at 300 dpi). Roadmap exports (16-bit heightmap, SVG) hang off the same module.

## 7. Module layout

```
atlas/
  .editorconfig                     utf-8, lf, 2 spaces
  .gitattributes                    * text=auto eol=lf
  .gitignore                        (scaffold) + dist/
  CLAUDE.md                         tsconfig constraints, RNG rules, module ownership, how to test
  ARCHITECTURE.md                   this document
  README.md                         what it is, how to run, seed URL format
  index.html                        canvas + 240 px sidebar; Google Fonts <link>; no framework
  vite.config.ts                    base: '/atlas/', test: { environment: 'node' }
  tsconfig.json                     (scaffold, unchanged)
  package.json                      + dependencies: delaunator; devDependencies: @types/delaunator
  .github/workflows/pages.yml       npm ci, npm run build, upload dist/, deploy-pages
  public/favicon.svg
  src/
    main.ts                         DOM wiring, URL hash, generate/render loop, export buttons
    style.css                       sidebar layout, parchment page background
    core/
      types.ts                      section 4, verbatim
      rng.ts                        xmur3, sfc32, fork, helpers
      noise.ts                      seeded 3D simplex, fbm3, 1D/2D value noise
      geom.ts                       Chaikin, length, resample, PCA axis, wobble, point-in-polygon
      heap.ts                       binary min-heap on (key, index)
      raster.ts                     cell rasterizer, Meijster EDT, marching squares, bilinear sample
      ids.ts                        mkId / parseId
    mesh/
      poisson.ts                    Bridson sampling + boundary ring
      dualmesh.ts                   Delaunator -> Mesh, accessors, cellPolygon, latlon helpers
      noisy.ts                      NoisyEdges builder, sidePath
    gen/
      world.ts                      generate(): stage order, timings, event emission
      elevation.ts                  stages 4-5
      climate.ts                    stages 6, 8 (biome table)
      hydrology.ts                  stage 7
      provinces.ts                  stage 9
      settlements.ts                stage 10
      politics.ts                   stage 11, derivePolitics
      language.ts                   O'Leary language generator and word builder
      names.ts                      stage 12
      features.ts                   stages 13-14
    render/
      painter.ts                    renderWorld and layers 1-11, 13, 14
      parchment.ts                  cached parchment and tint offscreen canvases
      glyphs.ts                     Path2D builders: mountains, hills, trees, marsh, settlements, compass, frame
      labels.ts                     placeLabels, drawLabels, text-along-path
      export.ts                     exportPng, downloadBlob
    **/*.test.ts                    vitest, co-located
```

Ownership for the day-one session (four engineers, no cross-talk needed because `types.ts` is the contract):

- **A — core + mesh**: `core/*`, `mesh/*`. Deliver first; others stub against `types.ts` meanwhile.
- **B — physical generation**: `gen/elevation.ts`, `gen/climate.ts`, `gen/hydrology.ts`, `gen/features.ts`.
- **C — human generation**: `gen/provinces.ts`, `gen/settlements.ts`, `gen/politics.ts`, `gen/language.ts`, `gen/names.ts`, `gen/world.ts`.
- **D — render + shell + infra**: `render/*`, `main.ts`, `index.html`, `style.css`, `vite.config.ts`, `pages.yml`, `.gitattributes`, `.editorconfig`, `CLAUDE.md`.

### 7.1 Exported signatures

All imports of types use `import type`. Functions that fill typed arrays take an optional `out` to avoid allocation in loops but must allocate when `out` is omitted.

```ts
// core/rng.ts
export interface Rng {
  next(): number;                              // [0, 1)
  int(lo: number, hi: number): number;         // inclusive both ends
  float(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  gaussian(mean?: number, sd?: number): number;
  shuffle<T>(arr: T[]): T[];                   // in place, returns arr
  fork(label: string): Rng;                    // independent child stream
}
export function hash32(s: string): number;                    // xmur3 final state, uint32
export function makeRng(seed: string): Rng;                   // xmur3 -> sfc32
export function fork(seed: string, ...labels: string[]): Rng; // makeRng([seed, ...labels].join('/'))

// core/noise.ts
export type Noise3 = (x: number, y: number, z: number) => number;   // -1..1
export type Noise2 = (x: number, y: number) => number;              // -1..1
export type Noise1 = (t: number) => number;                         // -1..1
export function makeSimplex3(rng: Rng): Noise3;
export function fbm3(n: Noise3, x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number;
export function makeValueNoise2(rng: Rng, period?: number): Noise2; // tileable when period given
export function makeValueNoise1(rng: Rng): Noise1;

// core/geom.ts
export function chaikin(pts: Float32Array, closed: boolean, iterations: number): Float32Array;
export function polylineLength(pts: Float32Array, closed: boolean): number;
export function wobble(pts: Float32Array, closed: boolean, noise: Noise1, amplitude: number, wavelength: number): Float32Array; // displace along normals
export function principalAxis(xs: ArrayLike<number>, ys: ArrayLike<number>, idx: Int32Array): { angle: number; extent: number; cx: number; cy: number };
export function pointInPolygon(x: number, y: number, pts: Float32Array): boolean;
export function quantile(values: Float32Array, q: number): number;   // sorts a copy

// core/heap.ts
export class MinHeap {                          // fields declared explicitly (no parameter properties)
  constructor(capacity: number);
  push(key: number, id: number): void;
  pop(): number;                                // id with smallest (key, id); -1 when empty
  readonly size: number;
}

// core/raster.ts
export function makeRaster(w: number, h: number, scale: number): Raster;
export function rasterizeCells(mesh: Mesh, r_value: ArrayLike<number>, raster: Raster): Raster;           // flat fill per cell polygon
export function rasterizeTriangles(mesh: Mesh, t_value: ArrayLike<number>, raster: Raster): Raster;       // Gouraud, for hillshade later
export function edt(mask: Raster, out?: Raster): Raster;             // signed Euclidean distance in raster px (+ inside mask)
export function sampleBilinear(raster: Raster, x: number, y: number): number;   // x,y in logical px
export function marchingSquares(field: Raster, iso: number): Polyline[];        // in logical px, stitched, closed where possible

// core/ids.ts
export function mkId(kind: EntityKind, index: number): Id;
export function parseId(id: Id): { kind: EntityKind; index: number };

// mesh/poisson.ts
export function poissonDisc(width: number, height: number, r: number, rng: Rng, k?: number): Float64Array;  // xy interleaved
export function boundaryRing(width: number, height: number, r: number): Float64Array;
export function generatePoints(params: WorldParams, rng: Rng): { points: Float64Array; numBoundary: number }; // ring first

// mesh/dualmesh.ts
export function buildMesh(points: Float64Array, numBoundary: number): Mesh;
export function s_next_s(s: number): number;
export function s_prev_s(s: number): number;
export function s_end_r(mesh: Mesh, s: number): number;
export function s_inner_t(s: number): number;
export function s_outer_t(mesh: Mesh, s: number): number;            // -1 on hull
export function r_circulate_s(mesh: Mesh, r: number, out: number[]): number[];   // outgoing sides, CCW
export function r_circulate_r(mesh: Mesh, r: number, out: number[]): number[];   // neighbor cells
export function r_circulate_t(mesh: Mesh, r: number, out: number[]): number[];   // corners of the cell polygon
export function t_circulate_r(mesh: Mesh, t: number, out: number[]): number[];   // 3 cells
export function t_circulate_t(mesh: Mesh, t: number, out: number[]): number[];   // <= 3 neighbor corners
export function t_circulate_s(mesh: Mesh, t: number, out: number[]): number[];   // 3 sides leaving t
export function r_is_boundary(mesh: Mesh, r: number): boolean;
export function cellPolygon(mesh: Mesh, r: number, out: Float32Array): number;   // writes xy pairs, returns point count
export function cellCentroids(mesh: Mesh, out?: { r_px: Float32Array; r_py: Float32Array }): { r_px: Float32Array; r_py: Float32Array };  // the sanctioned cell position
export function buildCellLookup(mesh: Mesh, cellSize: number, centroids?: { r_px: Float32Array; r_py: Float32Array }): CellLookup;  // uniform grid over the centroids
export function nearestCell(lookup: CellLookup, x: number, y: number): number;  // lower index on ties; clamps outside the grid; the formation timeline's drift read
export function cellLatLon(mesh: Mesh, params: WorldParams, r: number): [lat: number, lon: number];
export function cellUnitVector(mesh: Mesh, params: WorldParams, r: number, out: Float64Array): Float64Array;
export function downwindOrder(mesh: Mesh, dir: WindDir): Int32Array;   // interior cells sorted upwind -> downwind

// mesh/noisy.ts
export function buildNoisyEdges(mesh: Mesh, rng: Rng, amplitude?: number, levels?: number): NoisyEdges;
export function sidePath(edges: NoisyEdges, mesh: Mesh, s: number, out: number[]): number[];  // pushes xy from s_inner_t to s_outer_t
export function chainSides(mesh: Mesh, edges: NoisyEdges, isChainSide: (s: number) => boolean): Polyline[]; // generic loop/chain builder (raw, unsmoothed)

// gen/tectonics.ts
export interface Tectonics {
  numPlates: number;
  r_plate: Int16Array;         // plate index per cell; every region is on exactly one plate
  plateVx: Float32Array; plateVy: Float32Array;   // per plate drift
  plateOceanic: Uint8Array;    // per plate, 1 oceanic, 0 continental
  r_craton: Float32Array;      // 0..1 continental basement, diffused
  r_stress: Float32Array;      // convergence (+) / rift (-), diffused
}
export function computeTectonics(mesh: Mesh, params: WorldParams, rng: Rng): Tectonics;

// gen/elevation.ts
// Formation carries r_plate / plateVx / plateVy / drift / lookup (a CellLookup) for plate drift;
// rawAtStep reads the present day (the last step) from the stored fields without the lookup.
export function rawAtStep(f: Formation, step: number, out?: Float32Array): Float32Array;
export function landMaskAtStep(mesh: Mesh, f: Formation, step: number, out?: Uint8Array): Uint8Array;  // 1 land, 0 water
export interface ElevationResult {
  r_elevation: Float32Array; r_water: Uint8Array; r_coastHops: Int16Array; r_slope: Float32Array;
  r_lat: Float32Array; r_lon: Float32Array;
}
export function buildFormation(mesh: Mesh, params: WorldParams, rng: Rng, tec: Tectonics): Formation;   // the RNG draws and the noise, once
export function elevationAtStep(mesh: Mesh, params: WorldParams, formation: Formation, step: number): ElevationResult;   // per moment, no RNG
export function computeElevation(mesh: Mesh, params: WorldParams, rng: Rng, tec: Tectonics): ElevationResult;   // = elevationAtStep(buildFormation(...), params.formationStep)
export function computeDistanceField(mesh: Mesh, params: WorldParams, r_water: Uint8Array): { distField: Raster; r_coastDist: Float32Array };

// gen/climate.ts
export interface ClimateInput { r_elevation: Float32Array; r_water: Uint8Array; r_coastDist: Float32Array; r_lat: Float32Array; }
export function computeClimate(mesh: Mesh, params: WorldParams, geo: ClimateInput, rng: Rng): { r_temperature: Float32Array; r_moisture: Float32Array; windDir: WindDir };
export function computeBiomes(mesh: Mesh, geo: Pick<Geography, 'r_water' | 'r_elevation' | 'r_temperature' | 'r_moisture' | 'r_coastDist' | 's_river' | 't_lake'>): Uint8Array;
export const BIOME_COLORS: Record<Biome, string>;
export const BIOME_FERTILITY: Record<Biome, number>;

// gen/hydrology.ts
export interface HydrologyResult {
  t_elevation: Float32Array; t_downslope_s: Int32Array; t_flux: Float32Array; t_lake: Int16Array;
  s_river: Float32Array; s_riverId: Int16Array;
  r_water: Uint8Array;                                 // copy with lake cells set to 2
  riverSides: Int32Array[]; riverParent: Int32Array;   // per river, ordered source -> mouth
  lakeCells: Int32Array[]; lakeOutlet_t: Int32Array;
}
export function computeHydrology(mesh: Mesh, params: WorldParams, r_elevation: Float32Array, r_water: Uint8Array, r_moisture: Float32Array): HydrologyResult;

// gen/provinces.ts
export function computeProvinces(mesh: Mesh, edges: NoisyEdges, params: WorldParams, geo: Geography, rng: Rng): { provinces: Province[]; r_province: Int16Array; graph: ProvinceGraph };
export function cellFertility(geo: Geography, r: number): number;    // biome table x (1 - slope) x river bonus

// gen/settlements.ts
export function placeSettlements(mesh: Mesh, params: WorldParams, geo: Geography, provinces: Province[], r_province: Int16Array, rng: Rng): { settlements: Settlement[]; r_settlement: Int16Array };
export function scoreCell(mesh: Mesh, geo: Geography, r: number): number;   // reused by the history sim for city founding

// gen/politics.ts
export function foundNations(mesh: Mesh, params: WorldParams, geo: Geography, provinces: Province[], graph: ProvinceGraph, r_province: Int16Array, settlements: Settlement[], r_settlement: Int16Array, rng: Rng): { politics: Politics; events: WorldEvent[] };
export function derivePolitics(politics: Politics, r_province: Int16Array): void;   // p_nation -> r_nation, in place
export const NATION_COLORS: readonly string[];

// gen/language.ts
export function makeLanguage(rng: Rng): Language;
export function makeWord(lang: Language, rng: Rng, kind?: MorphemeKind): string;   // capitalized, with optional morpheme
export const ENDS_WITH_VOWEL: RegExp;   // /[vowel letter, accented or not]$/i from a literal table (no normalize / \p{..}, so no ICU dependence); for names.ts demonyms

// gen/names.ts
export function assignNames(world: World): void;        // fills every name field in place; per-entity forks of world.seed
export function worldTitle(world: World): string;   // a word of its own in the dominant nation's tongue, never a nation's, culture's or town's name (2026-09-23)

// gen/features.ts
export function extractFeatures(world: Pick<World, 'mesh' | 'edges' | 'geo' | 'params'>, hydro: HydrologyResult): Features;   // rivers/lakes unnamed until assignNames
export function buildPoliticalView(world: World): PoliticalView;
export function poleOfInaccessibility(mesh: Mesh, cells: Int32Array): number;   // cell id

// gen/world.ts
export function generate(seed: string, params?: Partial<WorldParams>): World;
export interface WorldBase { seed: string; params: WorldParams; mesh: Mesh; edges: NoisyEdges; tectonics: Tectonics; formation: Formation; timings: Record<string, number> }
export function prepareBase(seed: string, params?: Partial<WorldParams>): WorldBase;   // points, mesh, edges, tectonics, buildFormation
export function generateFromBase(base: WorldBase, params: WorldParams, geographyOnly?: boolean): World;   // params may differ from base.params only in formationStep / nations
export function baseKey(p: WorldParams): string;   // the params a base depends on, as a stable string
export function withParams(overrides: Partial<WorldParams>): WorldParams;
export function toWorldFile(world: World): WorldFile;
export function fromWorldFile(file: WorldFile): World;    // regenerate + restore politics if present

// render/parchment.ts
export function parchmentCanvas(seed: string, wPx: number, hPx: number): HTMLCanvasElement;   // cached by (seed, wPx, hPx) for sheets up to 32 MiB; the 4x sheet is transient
export function tintCanvas(world: World, wPx: number, hPx: number): HTMLCanvasElement;         // blurred biome tint, cached per World object (a WeakMap) and (wPx, hPx)

// render/glyphs.ts
export function mountainPath(variant: number, size: number): Path2D;   // origin at base center
export function hillPath(variant: number, size: number): Path2D;
export function treePath(kind: 'broadleaf' | 'conifer', variant: number, size: number): Path2D;
export function marshPath(size: number): Path2D;
export function settlementPath(kind: SettlementKind, capital: boolean): Path2D;
export function anchorPath(): Path2D;
export function compassRose(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rng: Rng): void;
export function frame(ctx: CanvasRenderingContext2D, w: number, h: number): void;
export function cartouche(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, subtitle: string): void;

// render/labels.ts
export interface PlacedLabel { text: string; x: number; y: number; angle: number; font: string; size: number; tracking: number; kind: 'settlement' | 'nation' | 'sea' | 'range' | 'river'; glyphs?: { ch: string; x: number; y: number; angle: number }[]; box: [number, number, number, number]; }
export type MeasureFn = (text: string, font: string) => number;
export function placeLabels(world: World, view: PoliticalView, measure: MeasureFn, opts: RenderOptions): PlacedLabel[];
export function drawLabels(ctx: CanvasRenderingContext2D, labels: PlacedLabel[]): void;
export function fontStack(family: 'text' | 'smallcaps', italic?: boolean): string;

// render/painter.ts
export function renderWorld(world: World, view: PoliticalView, ctx: CanvasRenderingContext2D, opts: RenderOptions): void;
export const DEFAULT_LAYERS: LayerToggles;
export const INK: string; export const SEA_INK: string; export const PARCHMENT: string;

// render/export.ts
export function exportPng(world: World, view: PoliticalView, k: 1 | 2 | 4, opts: Omit<RenderOptions, 'scale'>): Promise<Blob>;
export function downloadBlob(blob: Blob, filename: string): void;

// main.ts (no exports; behavior)
// - reads #seed=<s>&land=<f>&wind=<d>&cells=<r> on load, writes it on every generate
// - Randomize: 8-char seed from crypto.getRandomValues; Generate; scale select 1x/2x/4x; Export
// - layer checkboxes -> re-render only (no regenerate); timing readout from world.timings + render ms
// - awaits document.fonts.load for all three faces the renderer uses ('12px "IM Fell English"', 'italic 12px "IM Fell English"', '12px "IM Fell English SC"') with a 1500 ms timeout before the first render; empty hash values (`#cells=`) count as missing
// - canvas sized to fit the container, drawn at devicePixelRatio
```

```ts
// gen/edits.ts — the post-generation edit overlay (added 2026-09-18)
export interface Edits {
  names: Record<string, string>;      // Id -> replacement, e.g. 'settlement:12'
  p_nation: Record<string, number>;   // province index -> nation index, -1 unclaimed
  r_nation: Record<string, number>;   // cell index -> nation index, -1 unclaimed (fine brush)
}
export function emptyEdits(): Edits;
export function editsAreEmpty(e: Edits): boolean;
export function applyEdits(world: World, edits: Edits): void;
export function serializeEdits(e: Edits): string;
export function parseEdits(text: string): Edits;          // tolerant; drops unknown/out-of-range keys

// gen/names.ts
export function applyNameEdits(world: World, edits: Edits): void;
// gen/politics.ts — still the ONLY writer of political state
export function applyPoliticalEdits(world: World, edits: Edits): void;
// p_nation overrides, then derivePolitics, then r_nation overrides: the fine brush wins over the
// province it sits in.

// render/painter.ts
export function renderFrame(ctx: CanvasRenderingContext2D, opts: { scale: number; width: number; height: number }): void;
// The frame alone, drawn over the live-scrub geography (renderWorld with the political, label and
// furniture layers off) so the border never blinks while the formation bar is dragged.

// ui/editor.ts — builds its own DOM into #sidebar; not unit tested (node environment, no DOM)
export function initEditor(hooks: EditorHooks): void;
```

See `docs/EDITING.md` for the edit layer's own notes.

## 8. Day-one cut

**IN**

- Seed textbox, Randomize, Generate, seed and params in `location.hash` (shareable link).
- Poisson mesh at r = 8 (~10k cells), noisy edges, vitest mesh invariants.
- Sphere-sampled fBm + continent mask elevation with quantile sea level; ocean flood fill; coast hops; reshape; raster EDT distance field.
- Latitude/altitude temperature; wind-sweep moisture with rain shadow; Whittaker biomes with floodplain and marsh rules.
- Priority-flood rivers on Voronoi sides that always reach the sea or a lake; up to 8 cell-defined lakes with outlets; tributary parents.
- ~140 provinces with a CSR province graph; 15–40 settlements (city/town/village, port, river mouth); 3–8 cultures each with a generated language; 3–8 nations owning provinces via graph Dijkstra; free cities on islands.
- Names for settlements, nations, cultures, provinces, rivers, lakes, seas, ranges, and a world title.
- Year-0 event log (5 kinds), plain data, no reducer.
- Renderer: parchment, ocean wash, EDT waterlines, optional stipple, blurred biome tint, lakes, forest/marsh glyphs, mountain/hill glyphs, tapered rivers, double-line coast, colored-glow nation borders, settlement icons, halo labels (settlements, nations, 3 rivers, seas, ranges), graticule toggle, compass, scale bar, cartouche, frame.
- PNG export at 1x/2x/4x; timing readout.
- Repo infra: `CLAUDE.md`, `.gitattributes`, `.editorconfig`, Pages workflow, `base: '/atlas/'`.

**OUT** (deferred; the seam that holds each is named in section 9)

Tectonic plates; real wind/temperature simulation; roads and trade routes; the yearly sim loop, event replay, timeline; Legends wiki; hillshade; 16-bit heightmap and SVG export; multi-page print/PDF; globe; WebGL; Web Worker; pan/zoom; interactive editing; province labels; JSON file save/load UI (`toWorldFile`/`fromWorldFile` exist as functions); curved sea labels; more than one culture per nation.

**Order of sacrifice if the session runs short** (cut from the top): province border layer → range labels → sea labels → river labels → stipple → cartouche → graticule → language morphemes (plain syllables only) → free cities → tributary parents. **Never cut**: the mesh accessors and their tests, noisy edges, the RNG forking scheme, the `Politics`/`PoliticalView` split, the EDT waterlines, the blurred tint, or the scale-invariant render contract — the roadmap leans on every one of them.

## 9. Roadmap and how each item plugs in

| Item | Where it plugs in | What stays untouched |
|---|---|---|
| **Tectonics — LANDED 2026-09-18, see stage 3.5** | Replaces the continent-mask step inside `computeElevation`: K plate seeds + BFS growth over the cell graph (a Voronoi-of-cells), plate velocity vectors, uplift/rift on sides where plates differ (dot of relative velocity with the side normal), diffused over the cell graph, added to `raw` before the quantile. Plates become `NamedArea`-like entities for the wiki. | Everything after stage 4. |
| **Climate sim** | Replaces `computeClimate` behind the same signature: latitude wind belts (trades/westerlies/polar) as per-band `downwindOrder` sweeps; temperature with ocean-proximity term; seasonal pass optional. | Hydrology, biomes, all human stages. |
| **Hillshade** | `rasterizeTriangles(mesh, t_elevation, raster)` at 1/2 output resolution → Horn gradient → Lambertian → `multiply` at α 0.25 as layer 4b, toggle `relief`. Default faint; glyphs remain the primary relief vocabulary. | Everything; one layer function. |
| **Roads and trade** | New `gen/roads.ts`: A*/Dijkstra over the cell graph with cost from slope, biome, river crossings (a bridge is a side with `s_river > 0`); sea lanes over ocean cells between ports; MST over settlements + k-NN extras; `Road { id, cells: Int32Array, kind }` in `World.roads`; one render layer between borders and settlements; `road.built` events. | All existing stages. |
| **History sim** | New `src/sim/`: `stepYear(world, rng)` mutates only `world.politics` (`p_nation`, `p_culture`, nations' `died`), `world.settlements` (`died`, `population`, new entries appended with `founded`), and appends to `world.history.events`; new entities (`rulers`, `wars`, `religions`) live in a `world.sim` object added then. Every year and entity uses `fork(seed, 'history', 'y<year>', '<id>')` so adding a subsystem never changes existing wars. Expansion = weighted flood over the province graph; armies move along roads; city founding reuses `scoreCell`; sieges flip `died`. 2000 years x ~140 provinces is trivial; snapshots of `p_nation` every 25 years (80 x 280 B) drive a timeline slider; `buildPoliticalView` turns any year's `p_nation` into borders. **Replay** arrives here: `applyEvent(politics, settlements, e)` + `replay(world, year)` make the log authoritative; day-one events were written so that replaying them from year 0 reproduces day-one `p_nation` exactly (a vitest asserts this the day the reducer lands). | Geography, features, the renderer. |
| **Legends wiki** | Pure `(world) => Map<Id, HTMLString>` over entities and `history.events` (filter by `subjects`, follow `cause`); vanilla hash router `#/wiki/settlement:12`; each page gets a map inset by rendering with a `Viewport { x, y, w, h }` clipped around the entity's cells (added to `RenderOptions`, identity on day one); static export writes the same strings to `dist/legends/`. | Everything; ids were stable from day one. |
| **Printable atlas** | `renderWorld` with `Viewport` over a page grid at `scale = 300/96`; labels placed per page; PNG series through `export.ts`, multi-page PDF via `jsPDF` from cdnjs later. | Generation. |
| **16-bit heightmap / SVG** | `rasterizeTriangles` of `t_elevation` at export resolution → 16-bit PNG for Photoshop displacement; SVG export walks the same `Features`/`PoliticalView` polylines and glyph paths. | Everything. |
| **Globe** | Points from a Fibonacci lattice on the sphere (~40k for a planet at today's cell size), triangulated with Delaunator on a stereographic projection plus a south-pole patch (mapgen4 technique) → the same `Mesh`. Only the four coordinate helpers change (`cellLatLon`, `cellUnitVector` become real sphere coords; `downwindOrder` becomes a great-circle projection; `cellPolygon` projects). Noise already samples the sphere. Rendering gets `Projection { toScreen(x, y), visible(r) }`: identity on day one, orthographic for a Canvas 2D globe, WebGL later using the mesh's triangle buffers. | Every `gen/` stage, by the topology-only rule. |
| **Save/load** | `WorldFile` exists; add file buttons and `CompressionStream` gzip. Geography regenerates from `(seed, params)` while `params.version` matches; history and politics are the only expensive state and are embedded as base64. A `migrations[]` table in `world.ts` handles old versions. | — |
| **Worker** | `generate` is pure and `World` is structured-cloneable; wrap in a Worker with transferables when planet mode or the sim pushes past ~500 ms. Export can move to an `OffscreenCanvas` the same way. | — |
| **WebGL** | Replaces the raster-sampled layers (tint, hillshade, parchment) with shaders over the mesh's triangle buffers; ink layers stay Canvas 2D or move to SVG. | Generation, features. |

## 10. Coding conventions

**TypeScript under this tsconfig**

- No `enum`, no `namespace`, no constructor parameter properties, no `declare` fields with initializers that `erasableSyntaxOnly` rejects. Use `as const` tables and string-literal unions.
- `import type { … }` for every type-only import (`verbatimModuleSyntax`). Re-export types with `export type { … }`.
- No unused locals or parameters; prefix intentionally unused parameters with `_`.
- `tsc` must pass with zero errors before `vite build`; run `npm run build` before declaring a module done.

**Determinism**

- `Math.random` is forbidden anywhere under `src/`. A vitest greps for it and fails the build. The one nondeterministic call (`crypto.getRandomValues` for the Randomize button) lives in `main.ts`.
- Every stage receives a forked `Rng`; never share one stream across stages, never draw from a parent stream after forking children from it.
- Per-entity randomness (names, glyph jitter for a given cell) forks by stable id: `fork(seed, 'names', 'river:3')`, `fork(seed, 'ink', 'relief')`.
- Sorts that affect output use typed-array index sorts with explicit numeric tie-breaks on the index (`(a, b) => key[a] - key[b] || a - b`); never rely on `Array.prototype.sort` stability for objects.
- No `Math.sin`-based hashes; no `Date`, `performance.now()` only for `timings`. All three rules are enforced by `src/no-math-random.test.ts`, which greps every non-test file under `src/`.
- Changing what a stage draws from its stream, or the stage order, bumps `ATLAS_VERSION` and `params.version`.
- **Caveat on "every machine" (found in the 2026-09-18 review).** `Math.sqrt` is correctly rounded by IEEE 754, but `Math.sin`, `Math.cos`, `Math.pow`, `Math.exp`, `Math.log`, `Math.atan2` and `Math.acos` are only *implementation-approximated* in ECMAScript, so a different engine may return a different last bit. Generation uses them in `mesh/poisson.ts` (candidate offsets), `mesh/dualmesh.ts` (lat/lon), `gen/elevation.ts`, `gen/climate.ts`, `core/geom.ts` and `core/rng.ts` (`gaussian`). In practice V8, SpiderMonkey and JavaScriptCore all ship fdlibm-derived versions and agree, which is why the same seed does reproduce across browsers today — but it is an engine convention, not a spec guarantee. Making it a guarantee means shipping our own `sin`/`cos`/`exp`/`log`, which is a `params.version` bump and is not worth it until someone reports a mismatch; the tests would catch it as a cross-machine digest difference, not as a local failure.

**Data and memory**

- World data is typed arrays and POJOs; no classes on data, no methods on data, no `Map` inside `World` (structured clone and JSON both must work).
- Per-index fields are named `r_*`, `t_*`, `s_*`, `p_*` for cell/corner/side/province; the prefix is the index space and is never lied about.
- Ids are array indices per kind and are never compacted; destroyed entities get `died`, never removal. Cross-kind references in logs/URLs use `Id` strings; hot loops use integers.
- No per-cell object allocation inside generation loops; reuse scratch arrays (`out` parameters).
- Generation reads coordinates only through the four named helpers (`cellLatLon`, `cellUnitVector`, `downwindOrder`, `cellPolygon`). Everything else is adjacency and per-index arrays.

**Purity and boundaries**

- Stages are `(inputs, rng) => outputs`; they do not mutate inputs except where the signature says "in place" (`assignNames`, `derivePolitics`).
- Political state is written only in `gen/politics.ts` (day one) and `src/sim/` (later). The renderer reads ownership only through `PoliticalView`.
- The renderer never computes geography; `features.ts` never draws.
- Line widths, font sizes, glyph sizes and grain wavelengths are always in logical px; the only `ctx.scale` call is at the top of `renderWorld`.

**Testing (vitest, `npm test`)**

- `rng.test.ts`: same seed → same sequence; forks are independent; 1e5 draws are uniform-ish.
- `dualmesh.test.ts`: the invariants from section 3.1 on a 300-point mesh and on the default mesh.
- `elevation.test.ts`: land fraction within 1% of `params.landFraction`; every boundary region is ocean; ≥ 40 px ocean margin.
- `hydrology.test.ts`: every land corner has a strictly lower neighbor after filling; walking `t_downslope_s` from every land corner terminates at ocean or lake within `numTriangles` steps; every river's mouth corner is ocean or lake; `s_river` is mirrored on twins.
- `politics.test.ts`: every province with a settlement has a nation; `r_nation` equals `p_nation[r_province[r]]`; every `province.claimed` event's subject is owned by that nation.
- `world.test.ts`: `generate('test-1')` twice produces byte-identical typed arrays and names; `generate` at `cellSpacing 12` (measured 80–95 ms in node, 2026-09-17) stays under a self-calibrated bound of max(3 x best-of-3, 500 ms); 14 timing keys; the stage-15 log invariants; the save-file round trip; the reverted-lake patch.
- `features.test.ts`: every coast loop is closed and non-degenerate; the sum of coast loop areas equals the land cell area within 5%.
- `no-math-random.test.ts`: `grep -r "Math.random" src/` returns only `main.ts`.
- Rendering has no unit tests on day one; it is verified by eye and by the timing readout. A later session adds a headless pixel snapshot via `@napi-rs/canvas`.

**Style**

- 2-space indent, LF, single quotes, semicolons, `const` by default, `for` loops over typed arrays in hot paths (no `forEach`/`map` there).
- File-level doc comment stating the module's stage, its RNG stream, and its inputs/outputs.
- Commit messages: imperative, one module per commit where possible; commit or push only when the owner asks.
