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

## Status: day one complete (2026-09-17)

Every module in `docs/ARCHITECTURE.md` section 7 exists, the three gates are green (`npm test`: 375 tests in 21 files; `npm run typecheck`: zero errors; `npm run build`: tsc + vite, ~94 kB of JS) and the app has been run in headless Chromium: four seeds generate and render with zero console errors, the timing readout shows generate at 170-195 ms and a 1x screen render at 65-105 ms, and the 2x PNG export works (about 440 ms). The deployed site is https://meow-woem.github.io/atlas/ (GitHub Pages, built by `.github/workflows/pages.yml` on every push to `main`).

### What exists and passes

- `src/core/*`: types (the section 4 contract), rng (xmur3 + sfc32, forkable streams), noise, geom, heap, ids, raster (cell rasterizer, exact EDT, marching squares). Tested.
- `src/mesh/*`: Poisson-disc points with the boundary ring, the Delaunator dual mesh with its accessors and the four coordinate helpers, noisy edges and the generic side chainer. The section 3.1 invariants pass on a 300-point mesh and on the default mesh.
- `src/gen/*`: every stage of section 5. `elevation` (4-5), `climate` (6, 8), `hydrology` (7), `provinces` (9), `settlements` (10), `politics` (11), `language` + `names` (12), `features` (13-14) and `world` (the orchestrator, timings, the year-0 history log, `toWorldFile` / `fromWorldFile`). Each stage has a test file that builds real worlds through the stages before it; `world.test.ts` asserts that `generate('test-1')` twice is identical in every typed array and every name.
- `src/render/*` (`painter`, `parchment`, `glyphs`, `labels`, `export`), `src/main.ts`, `index.html`, `src/style.css`: the full layer stack of section 6, the label placer, PNG export and the app shell. Viewed and adjusted by eye on 2026-09-17 (relief glyphs on every other cell, stronger border glow, sea labels anchored at the pole of inaccessibility so they stay inside the frame). `labels.ts` has unit tests for the pure placement logic; nothing else in `render/` is unit-tested (the vitest environment is node, no canvas).
- `src/no-math-random.test.ts`: fails if any non-test file under `src/` uses `Math.random`.

### Measured in node at the default parameters (seeds atlas, amberfell, test-1, a, zzzzzzzz)

~8,200 cells, land fraction 0.416-0.420, 20-27 rivers, 0-5 lakes, 102-109 provinces, 36 settlements (12-20 of them ports), 7 nations and 7 cultures on every seed, 149-158 year-0 events, every name filled, titles such as "The Niknignak Lands" and "The Realms of Epidh". `generate` takes 115-230 ms warm in node (about 90 ms at `cells=12`). The only stage consistently over three times its section 5 budget is `points` (35-70 ms against 8 ms); everything else is within budget or within 2x of it.

### Known deviations from the architecture doc

Constants that were retuned after measuring real worlds are marked in the doc: the temperature and rain-shadow formulas (stage 6), the fitted Whittaker band edges and the marsh rule (stage 8), the ~100 province count (stage 9) and the settlement weights (stage 10). The distance field is measured to the ocean coast only (stage 5). Coast and border sides are chained from the twin half-edges the doc names, because Delaunator's winding puts the start region on the walker's right (see `gen/features.ts`).

### Next

1. **Tune the sampler.** `src/mesh/poisson.ts` is the one stage well over budget; Roberts' few-candidate variant would cut it by ~80% (a `params.version` bump).
2. **Review pass.** The generation code was written by parallel agents against the contract and verified by its own tests and by eye; an adversarial read for determinism hazards and spec drift is the natural next session.
3. The roadmap below.

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
