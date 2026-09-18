# Atlas

Atlas is a browser-native procedural fantasy world generator. Type a seed and, in a fraction of a second, you get a deterministic, hand-inked parchment map: coasts, mountains, rivers that always reach the sea, biomes, lakes, named settlements and nations, framed with a compass rose, scale bar and title cartouche. The same seed reproduces the same world on every machine, and the map exports as a print-crisp 1x, 2x or 4x PNG.

Under the hood the single source of truth is a ~10,000-cell Voronoi graph. Every terrain, water, political and historical quantity is a typed array indexed by cell, corner or side, and every line on the map is a chain of mesh sides, so it is a vector polyline the moment it exists. Rendering is Canvas 2D in logical pixels; screen, 2x and 4x export are the same function call at a different scale. There is no UI framework and one runtime dependency (`delaunator`).

## Running

```
npm install
npm run dev        # Vite dev server
npm test           # vitest: 375 tests in 21 files (core, mesh invariants, every generation stage, determinism, no-Math.random grep)
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

## Status: generation complete, renderer not yet viewed (2026-09-17)

Every module in `docs/ARCHITECTURE.md` section 7 exists and the three gates are green: `npm test` (375 tests in 21 files, all passing), `npm run typecheck` (zero errors) and `npm run build` (tsc + vite, `dist/` at ~94 kB of JS). The generator has been exercised end to end in node; the renderer has not yet been looked at.

### What exists and passes

- `src/core/*`: types (the section 4 contract), rng (xmur3 + sfc32, forkable streams), noise, geom, heap, ids, raster (cell rasterizer, exact EDT, marching squares). Tested.
- `src/mesh/*`: Poisson-disc points with the boundary ring, the Delaunator dual mesh with its accessors and the four coordinate helpers, noisy edges and the generic side chainer. The section 3.1 invariants pass on a 300-point mesh and on the default mesh.
- `src/gen/*`: every stage of section 5. `elevation` (4-5), `climate` (6, 8), `hydrology` (7), `provinces` (9), `settlements` (10), `politics` (11), `language` + `names` (12), `features` (13-14) and `world` (the orchestrator, timings, the year-0 history log, `toWorldFile` / `fromWorldFile`). Each stage has a test file that builds real worlds through the stages before it; `world.test.ts` asserts that `generate('test-1')` twice is identical in every typed array and every name.
- `src/render/*` (`painter`, `parchment`, `glyphs`, `labels`, `export`), `src/main.ts`, `index.html`, `src/style.css`: the full layer stack of section 6, the label placer, PNG export and the app shell. These typecheck and bundle; `labels.ts` has unit tests for the pure placement logic. Nothing else in `render/` is unit-tested (the vitest environment is node, no canvas).
- `src/no-math-random.test.ts`: fails if any non-test file under `src/` uses `Math.random`.
- `.github/workflows/pages.yml`: the GitHub Pages workflow (moved from `docs/pages.yml`, staged but not yet pushed).

### Measured in node at the default parameters (seeds atlas, amberfell, test-1, a, zzzzzzzz)

~8,200 cells, land fraction 0.416-0.420, 20-27 rivers, 0-5 lakes, 102-109 provinces, 36 settlements (12-20 of them ports), 7 nations and 7 cultures on every seed, 149-158 year-0 events, every name filled, titles such as "The Niknignak Lands" and "The Realms of Epidh". `generate` takes 115-230 ms warm in node (about 90 ms at `cells=12`). The only stage consistently over three times its section 5 budget is `points` (35-40 ms against 8 ms); everything else is within budget or within 2x of it.

### Not yet done: the maintainer does this next

1. **Look at it.** `npm run dev`, open the page, generate a few seeds. The renderer is typechecked and built but has never been viewed in a browser, so expect visual bugs (layer order, colours, glyph sizes, label collisions) rather than crashes. Check the timing readout against the section 2 budget (generate under 200 ms, render under 150 ms at 1x) and export a 4x PNG.
2. **Ship.** If the `gh` token lacks the `workflow` scope, run `gh auth refresh -s workflow`; make the repo public if Pages is to run on a free account; commit and push to `main`. The workflow builds and deploys `dist/`.
3. **Tune.** The Poisson-disc sampler (`src/mesh/poisson.ts`) is the one stage well over budget; the roadmap below starts after that.

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
