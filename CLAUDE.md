# Atlas — rules for anyone (human or agent) touching this repo

Atlas is a browser-native procedural fantasy world generator. **Read `docs/ARCHITECTURE.md` before writing code**; section 4 is the data contract (`src/core/types.ts`, already written), section 7.1 lists every module's exported signatures, section 10 the conventions. This file is the short version plus environment gotchas.

## Environment gotchas (Windows 11, Git Bash)

- `node`, `npm`, `npx` are NOT on PATH in a fresh Git Bash shell. Start every shell command with:
  `export PATH="/c/Program Files/nodejs:/c/Program Files/GitHub CLI:$PATH"`
- Repo root: `C:/Users/noahb/Projects/atlas`. Use forward slashes in bash.
- Commands: `npm run typecheck` (tsc --noEmit), `npm test` (vitest run), `npx vitest run src/core/rng.test.ts` (one file), `npm run build`, `npm run dev`.
- Do not commit or push unless the owner asks. Never run `git add -A` blindly; stage your own files.

## TypeScript constraints (tsconfig has `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `target es2023`, `moduleResolution bundler`)

- No `enum`, no `namespace`, no constructor parameter properties (`constructor(private x)`), no `declare` fields with initializers. Use `as const` tables and string-literal unions.
- `import type { … }` for every type-only import; `export type { … }` to re-export types.
- No unused locals or parameters; prefix intentionally unused params with `_`.
- Vitest: `import { describe, it, expect } from 'vitest'`. Tests are co-located `*.test.ts`. Test environment is node (no DOM, no canvas) — render modules are not unit tested on day one.

## Determinism (non-negotiable)

- `Math.random` is forbidden under `src/` except `src/main.ts` (Randomize button uses `crypto.getRandomValues`). A test greps for it.
- Every generation stage receives a forked `Rng` from `fork(seed, '<stage>')`. Per-entity randomness forks by stable id: `fork(seed, 'names', 'river:3')`, `fork(seed, 'ink', 'relief')`. Never draw from a parent stream after forking children from it.
- Sorts that affect output: typed-array index sorts with explicit numeric tie-break on the index (`(a, b) => key[a] - key[b] || a - b`).
- No `Date`, no `Math.sin` hashes; `performance.now()` only for `timings`.

## Data rules

- World data is typed arrays and POJOs. No classes, methods, or `Map` inside `World`.
- Per-index fields are named `r_*` (cell), `t_*` (corner), `s_*` (side), `p_*` (province). The prefix is the index space; never lie about it.
- Ids are array indices per kind, never compacted; destroyed entities get `died`.
- No per-cell object allocation in generation loops; reuse scratch arrays via `out` params (allocate when `out` is omitted).
- Generation reads coordinates only through `cellLatLon`, `cellUnitVector`, `downwindOrder`, `cellPolygon` (mesh/dualmesh.ts). Everything else is adjacency and per-index arrays.

## Boundaries

- Stages are `(inputs, rng) => outputs`; they mutate inputs only where the signature says "in place" (`assignNames`, `derivePolitics`).
- Political state is written only in `gen/politics.ts` (later `src/sim/`). The renderer reads ownership only through `PoliticalView`.
- The renderer never computes geography; `gen/features.ts` never draws.
- All rendering is in logical px; the only `ctx.scale`/`setTransform` is at the top of `renderWorld`. Line widths, font sizes, glyph sizes are logical px.

## Style

- 2-space indent, LF, single quotes, semicolons, `const` by default, plain `for` loops over typed arrays in hot paths.
- File-level doc comment: module's stage, RNG stream, inputs/outputs.
- Match the exported signatures in ARCHITECTURE.md section 7.1 exactly; other modules are written against them in parallel.
