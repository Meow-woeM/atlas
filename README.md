# Atlas

Atlas is a browser-native procedural fantasy world generator. Type a seed and, in a fraction of a second, you get a deterministic, hand-inked parchment map: coasts, mountains, rivers that always reach the sea, biomes, lakes, named settlements and nations, framed with a compass rose, scale bar and title cartouche. The same seed reproduces the same world on every machine, and the map exports as a print-crisp 1x, 2x or 4x PNG.

The land is built by plate tectonics, so you can drag the scroll bar under the map and watch continents rise out of the ocean and mountain belts grow along the plate boundaries — then stop anywhere along that formation and keep the world you find. Names and national borders are editable in place.

Under the hood the single source of truth is a ~10,000-cell Voronoi graph. Every terrain, water, political and historical quantity is a typed array indexed by cell, corner or side, and every line on the map is a chain of mesh sides, so it is a vector polyline the moment it exists. Rendering is Canvas 2D in logical pixels; screen, 2x and 4x export are the same function call at a different scale. There is no UI framework and one runtime dependency (`delaunator`).

## Running

```
npm install
npm run dev        # Vite dev server
npm test           # vitest: 379 tests in 21 files (core, mesh invariants, every generation stage, determinism, repo determinism guard)
npm run build      # tsc + vite build into dist/
npm run typecheck  # tsc --noEmit
```

## Seed URLs

The seed and the generation parameters live in the URL hash, so a world is shareable as a link:

```
#seed=<string>&land=<fraction>&wind=<0-7|random>&cells=<spacing>&step=<0-95>&nations=<3-12|auto>
```

- `seed` is any string; the Randomize button makes an 8-letter one. Omit it and the app picks one at random.
- `land` is the land fraction (default `0.42`).
- `wind` is the compass point the prevailing wind blows from: `0` W, `1` NW, `2` N, `3` NE, `4` E, `5` SE, `6` S, `7` SW, or `random` (default).
- `cells` is the Poisson-disc spacing in logical px (default `8`; `6` is detailed, `12` is instant).
- `step` is the moment on the land-formation timeline, `0` (earliest) to `23` (the present day, the default). Omitted from the hash at the present day.
- `nations` asks for exactly that many nations (the sidebar select offers 3 to 12); omit it, or `auto`, for the day-one rule of one nation per ~5 settlements plus a free city per settled island.

Example: `https://<host>/atlas/#seed=amberfell&land=0.45&wind=2&cells=8`

## Status: day one complete (2026-09-17); sampler retuned, tectonics, formation timeline and the edit layer (2026-09-18); plate drift, nation count, world names and UI polish (2026-09-23)

**2026-09-23.** Six changes from a review of the live site:

- **The plates play into the formation.** The timeline used to ramp three static fields up, so every world's story was islands rising from an empty sea. Now the crust rides its plate: an earlier step reads the final crust displaced back along the plate's drift, and crust that will have been subducted by the present reads as sea floor. Converging continents close an ocean and raise their mountain belt where they meet; diverging ones split. The present day is untouched (no `ATLAS_VERSION` bump). Details under stage 4 in the architecture doc.
- **The bar scrubs the real world.** Dragging it regenerates the geography of each step every frame from the seed's prepared base (mesh, edges, plates, formation fields), so coasts move, mountains rise, rivers grow and shrink and forests shift under the pointer; borders, towns, labels and the cartouche belong to the settled world and are added when the drag ends. No silhouette, no flash.
- **A nation count.** The `Nations` select (auto, or 3 to 12) and `&nations=` in the hash ask politics for exactly that many; capital spacing relaxes as needed and settled islands past the count are annexed by the nearest nation instead of becoming free cities.
- **The world is named in its own right.** The cartouche title is a fresh word in the dominant nation's tongue, never a nation's, culture's or town's name.
- **The seed is a URL, not map furniture.** The cartouche no longer prints it.
- **Export sits at the bottom of the sidebar**, pinned there while the rest scrolls, and the stage-timings readout is folded into a closed `Timings` disclosure that opens itself only to show an error.
- **Lakes.** Stage 4 carves basins at the most prominent inland dips of the basement noise (one per ~110 land cells, two rings deep so the priority flood fills them), and `lakesMax` went from 8 to 32: 9–16 lakes per world instead of 0–6. Rivers end at lakes and restart below them.
- **No more coasts squared off along the frame.** The ocean margin wanders along the border with a low-frequency noise (16–115 px at the default size), so land near the edge ends in bays and headlands; water within 24 px of the frame is the sea beyond the map and always drains to it.


Every module in `docs/ARCHITECTURE.md` section 7 exists, the three gates are green (`npm test`: 438 tests in 27 files; `npm run typecheck`: zero errors; `npm run build`: tsc + vite, ~94 kB of JS) and the app runs in headless Chromium. Re-checked after the sampler retune on 2026-09-18: seeds `atlas`, `amberfell`, `test-1` and `zzzzzzzz` each generate and render a complete map (coast, relief, rivers, lakes, borders, settlements, labels, cartouche, compass, scale bar) with no console errors from the app, and the 2x PNG export works. Those numbers -- generate 184-333 ms wall, 1x screen render 78-122 ms, 2x export 527 ms -- came from a sandboxed Linux container, so they are slower than the 2026-09-17 laptop run (170-195 ms / 65-105 ms / ~440 ms) and are not comparable to it; the node measurements below are the ones to track. That sandbox cannot reach the webfont CDN, so the run also exercised the fallback-serif path rather than IM Fell English. The deployed site is https://meow-woem.github.io/atlas/ (GitHub Pages, built by `.github/workflows/pages.yml` on every push to `main`).

### What exists and passes

- `src/core/*`: types (the section 4 contract), rng (xmur3 + sfc32, forkable streams), noise, geom, heap, ids, raster (cell rasterizer, exact EDT, marching squares). Tested.
- `src/mesh/*`: Poisson-disc points with the boundary ring, the Delaunator dual mesh with its accessors and the four coordinate helpers, noisy edges and the generic side chainer. The section 3.1 invariants pass on a 300-point mesh and on the default mesh.
- `src/gen/*`: every stage of section 5. `elevation` (4-5), `climate` (6, 8), `hydrology` (7), `provinces` (9), `settlements` (10), `politics` (11), `language` + `names` (12), `features` (13-14) and `world` (the orchestrator, timings, the year-0 history log, `toWorldFile` / `fromWorldFile`). Each stage has a test file that builds real worlds through the stages before it; `world.test.ts` asserts that `generate('test-1')` twice is identical in every typed array and every name.
- `src/render/*` (`painter`, `parchment`, `glyphs`, `labels`, `export`), `src/main.ts`, `index.html`, `src/style.css`: the full layer stack of section 6, the label placer, PNG export and the app shell. Viewed and adjusted by eye on 2026-09-17 (relief glyphs on every other cell, stronger border glow, sea labels anchored at the pole of inaccessibility so they stay inside the frame). `labels.ts` has unit tests for the pure placement logic; nothing else in `render/` is unit-tested (the vitest environment is node, no canvas).
- `src/gen/tectonics.ts` (stage 3.5): plate seeds grown over the cell graph, drift velocities, convergent/rift stress diffused into belts, continental cratons. Replaces the Gaussian continent mask that shaped the land through `ATLAS_VERSION` 2.
- The **formation timeline**: `Formation` holds the three time-independent height fields and an absolute sea level, so `rawAtStep` evaluates any moment in one pass rather than storing 24 snapshots. Land fraction is monotonic in the step and lands on `landFraction` at the end. The scroll bar under the map has no dates on it — it is a position in the land's story, not a geological clock — and previews a land/sea silhouette while dragged, regenerating fully when it settles.
- The **edit layer** (`src/gen/edits.ts`, `src/ui/editor.ts`): rename any settlement, province, nation, culture, river, lake, sea or range, and repaint national borders by province with a finer cell brush for detail. Political state is still written only in `gen/politics.ts`; edits persist to `localStorage` keyed by seed **and formation step**, because province and nation indices are rebuilt at every step. See `docs/EDITING.md`.
- `src/no-math-random.test.ts`: fails if any non-test file under `src/` uses `Math.random`, `Date`, or `performance.now()` outside the two files that measure timings.

### Measured in node at the default parameters (seeds atlas, amberfell, test-1, a, zzzzzzzz)

~8,700 cells, land fraction 0.417-0.420, 20-30 rivers, 9-16 lakes, 98-123 provinces, 38-39 settlements (12-24 of them ports), 7-8 nations and 7-8 cultures, 152-175 year-0 events, every name filled, titles such as "The Puserb Lands" and "The Realms of Muqyut". `generate` takes 125-245 ms warm in node (69-97 ms at `cells=12`). No stage is more than ~1.5x its section 5 budget any more: the worst are `elevation` (26 ms against 25), `features` (23 ms against 15) and `distance` (22 ms against 15).

### Known deviations from the architecture doc

The Poisson sampler is Roberts' few-candidate variant, not Bridson's `k = 30` (stage 1, marked in the doc): 46.4 ms -> 10.6 ms at the default parameters, at the cost of ~6% more cells. Other constants that were retuned after measuring real worlds are also marked in the doc: the temperature and rain-shadow formulas (stage 6), the fitted Whittaker band edges and the marsh rule (stage 8), the ~100 province count (stage 9) and the settlement weights (stage 10). The distance field is measured to the ocean coast only (stage 5). Coast and border sides are chained from the twin half-edges the doc names, because Delaunator's winding puts the start region on the walker's right (see `gen/features.ts`).

### Next

1. **Review pass.** The generation code was written by parallel agents against the contract and verified by its own tests and by eye; an adversarial read for determinism hazards and spec drift is the natural next session.
2. The roadmap below.

The order of sacrifice if time is short, and the things never to cut, are in ARCHITECTURE.md section 8.

## Architecture

The design document is `docs/ARCHITECTURE.md`: the data contract (`src/core/types.ts`), the generation pipeline stage by stage, the render layer order, every module's exported signatures and the coding conventions. `CLAUDE.md` is the short version plus environment notes for anyone touching the repo.

## Roadmap

Each item plugs into a seam that already exists; see section 9 of the architecture doc for where.

- Climate sim: latitude wind belts and ocean-proximity temperature behind the same `computeClimate` signature.
- Hillshade: Gouraud-rasterized corner elevation, Horn gradient, multiplied under the relief glyphs.
- Roads and trade: cost-path roads, bridges at river sides, sea lanes between ports.
- History sim: a yearly step over the province graph with rulers, wars, plagues and a timeline slider; event replay makes the log authoritative.
- Legends wiki: a page per entity with a map inset, driven by stable ids and the event log.
- Printable atlas: page-gridded rendering at 300 dpi and multi-page PDF.
- 16-bit heightmap and SVG export.
- Globe: a Fibonacci-lattice sphere mesh behind the same four coordinate helpers, orthographic then WebGL.
- Save and load of `WorldFile` with gzip.
- Web Worker generation and OffscreenCanvas export.
- WebGL for the raster-sampled layers.
