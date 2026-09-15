# Atlas

Atlas is a browser-native procedural fantasy world generator. Type a seed and, in a fraction of a second, you get a deterministic, hand-inked parchment map: coasts, mountains, rivers that always reach the sea, biomes, lakes, named settlements and nations, framed with a compass rose, scale bar and title cartouche. The same seed reproduces the same world on every machine, and the map exports as a print-crisp 1x, 2x or 4x PNG.

Under the hood the single source of truth is a ~10,000-cell Voronoi graph. Every terrain, water, political and historical quantity is a typed array indexed by cell, corner or side, and every line on the map is a chain of mesh sides, so it is a vector polyline the moment it exists. Rendering is Canvas 2D in logical pixels; screen, 2x and 4x export are the same function call at a different scale. There is no UI framework and one runtime dependency (`delaunator`).

## Running

```
npm install
npm run dev        # Vite dev server
npm test           # vitest (mesh invariants, determinism, hydrology, politics, no-Math.random grep)
npm run build      # tsc + vite build into dist/
npm run typecheck  # tsc --noEmit
```

## Seed URLs

The seed and the generation parameters live in the URL hash, so a world is shareable as a link:

```
#seed=<string>&land=<fraction>&wind=<0-7|random>&cells=<spacing>
```

- `seed` is any string; the Randomize button makes an 8-letter one. Omit it and the app picks one at random.
- `land` is the land fraction (default `0.42`).
- `wind` is the compass point the prevailing wind blows from: `0` W, `1` NW, `2` N, `3` NE, `4` E, `5` SE, `6` S, `7` SW, or `random` (default).
- `cells` is the Poisson-disc spacing in logical px (default `8`; `6` is detailed, `12` is instant).

Example: `https://<host>/atlas/#seed=amberfell&land=0.45&wind=2&cells=8`

## Status: work in progress (paused 2026-09-14)

Day one was being built by parallel agents against the contracts in `docs/ARCHITECTURE.md` when the session was stopped. The tree is a snapshot mid-build: it does not yet run in the browser. Here is exactly what exists and what is left, in the order to do it.

### Done

- Scaffold: Vite 8, TypeScript 6, vitest, `delaunator`; `vite.config.ts` with `base: '/atlas/'`; `.editorconfig`, `.gitattributes`; GitHub Pages workflow, parked at `docs/pages.yml` (see step 7).
- `docs/ARCHITECTURE.md`: the full design (data model, pipeline, render layers, module signatures, conventions). Read it first.
- `src/core/types.ts`: the data contract, taken verbatim from the architecture doc section 4.
- `src/core/rng.ts` (xmur3 + sfc32, forkable streams) with passing tests.
- `src/core/noise.ts`, `geom.ts`, `heap.ts`, `ids.ts`, `raster.ts` with tests (one geom test still fails, see below).
- `src/mesh/poisson.ts`, `dualmesh.ts`, `noisy.ts` with tests (three tests still fail, see below).
- `src/render/labels.ts`, `src/render/export.ts` (typecheck against `render/painter.ts`, which does not exist yet).
- `src/main.ts`, `index.html`, `src/style.css`, `public/favicon.svg`: the app shell, wired to modules that do not exist yet.
- `src/no-math-random.test.ts`: guards determinism.

### Failing right now

Run `npm test` and `npm run typecheck` to see the current state.

- `src/core/geom.test.ts`: "chaikin doubles the point count and shrinks the closed square inward" fails. Check Chaikin's closed-polyline handling in `geom.ts` (or the test's expectation about point count for closed loops).
- `src/mesh/dualmesh.test.ts`: the section 3.1 invariants fail on both the 300-point and the default mesh. Start here; everything downstream depends on the mesh. Likely suspects: `r_first_s` choice for hull regions, circulation termination, or the cell-area sum tolerance.
- `src/mesh/noisy.test.ts`: "paths and twins are consistent" fails. Probably follows from the dualmesh bug, or `sidePath` is not reversing the canonical path for the twin.
- Typecheck: 5 errors, all missing modules (`gen/world`, `gen/features`, `render/painter`). They go away as those files are written.

### To do, in order (module ownership and signatures are in ARCHITECTURE.md section 7)

1. **Fix the mesh tests** (`src/mesh/dualmesh.ts`, `noisy.ts`) and the chaikin test. Do not proceed until `npm test` is green for core and mesh.
2. **`src/render/painter.ts`, `parchment.ts`, `glyphs.ts`** (section 6, layers 1 to 14). Exports `renderWorld`, `DEFAULT_LAYERS`, `INK`, `SEA_INK`, `PARCHMENT`. This unblocks the two typecheck errors in `labels.ts` and `export.ts`.
3. **Physical generation**: `src/gen/elevation.ts` (stages 4 and 5), `climate.ts` (stages 6 and 8, plus `BIOME_COLORS` and `BIOME_FERTILITY`), `hydrology.ts` (stage 7, priority-flood rivers and lakes), `features.ts` (stages 13 and 14: coast loops, waterlines, river paths, `buildPoliticalView`). Tests listed in section 10.
4. **Human generation**: `src/gen/provinces.ts` (stage 9), `settlements.ts` (10), `politics.ts` (11), `language.ts` and `names.ts` (12).
5. **`src/gen/world.ts`**: `generate(seed, params)` running the stages in section 5 order with timings, plus `toWorldFile` and `fromWorldFile`. Add `world.test.ts` (determinism: two runs are byte-identical).
6. **Run it**: `npm run dev`, open the page, generate a few seeds, check the timing readout against the section 2 budget (generate under 200 ms, render under 150 ms), and export a 4x PNG.
7. **Ship**: the Pages workflow is parked at `docs/pages.yml` because the `gh` token used from the first machine lacked the `workflow` scope. Run `gh auth refresh -s workflow`, then `git mv docs/pages.yml .github/workflows/pages.yml`, make the repo public if you want Pages on a free account, and push to `main`; the workflow deploys `dist/`.

The order of sacrifice if time is short, and the things never to cut, are in ARCHITECTURE.md section 8.

## Architecture

The design document is `docs/ARCHITECTURE.md`: the data contract (`src/core/types.ts`), the generation pipeline stage by stage, the render layer order, every module's exported signatures and the coding conventions. `CLAUDE.md` is the short version plus environment notes for anyone touching the repo.

## Roadmap

Each item plugs into a seam that already exists; see section 9 of the architecture doc for where.

- Tectonics: plate seeds, uplift and rifts replacing the continent mask inside elevation.
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
