/**
 * no-math-random.test.ts — repo guard (no generation stage, no RNG).
 * Inputs: every src/**\/*.ts file except *.test.ts, read with node fs.
 * Outputs: a failing test if any of them breaks one of CLAUDE.md's three determinism rules, all
 * checked on the source with comments stripped first: no Math.random anywhere, no Date anywhere,
 * and performance.now() only in the two files that measure timings.
 *
 * Policy (CLAUDE.md): Math.random is forbidden under src/. The one nondeterministic call in the app is
 * crypto.getRandomValues in src/main.ts (the Randomize button), which is the ONLY file that would ever be
 * allowed an exception. On day one main.ts does not contain it either, so this test asserts zero
 * occurrences everywhere. If a future session deliberately relaxes main.ts, change the assertion for
 * that one path and nothing else.
 *
 * The tsconfig `types` list is limited to vite/client and @types/node is not installed, so the node
 * built-ins are loaded through a non-literal dynamic import (typed as any by tsc) and narrowed to the
 * small interfaces below. Swap these for static imports if @types/node is ever added.
 */
import { describe, it, expect } from 'vitest';

interface Dirent { name: string; isDirectory(): boolean; isFile(): boolean }
interface FsLike {
  readdirSync(path: string, opts: { withFileTypes: true }): Dirent[];
  readFileSync(path: string, encoding: 'utf8'): string;
}
interface PathLike { join(...parts: string[]): string }
interface UrlLike { fileURLToPath(url: URL | string): string }

async function nodeModule<T>(name: string): Promise<T> {
  const specifier = 'node:' + name;
  return (await import(/* @vite-ignore */ specifier)) as T;
}

/** Recursively collects every *.ts file under root, skipping *.test.ts. Paths are relative to root. */
function collectSources(fs: FsLike, path: PathLike, root: string, rel: string, out: string[]): string[] {
  const entries = fs.readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const relPath = rel === '' ? e.name : rel + '/' + e.name;
    if (e.isDirectory()) {
      collectSources(fs, path, root, relPath, out);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(relPath);
    }
  }
  return out;
}

/** Drops block and line comments so a doc comment saying "no Math.random" is not an offender. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Every non-test source under src/, as [path relative to src/, code with comments stripped]. */
async function loadSources(): Promise<Array<[string, string]>> {
  const fs = await nodeModule<FsLike>('fs');
  const path = await nodeModule<PathLike>('path');
  const url = await nodeModule<UrlLike>('url');
  const srcDir = url.fileURLToPath(new URL('.', import.meta.url));

  const files = collectSources(fs, path, srcDir, '', []);
  // Sanity: the walk must actually see the tree, or a broken path would pass vacuously.
  expect(files).toContain('core/rng.ts');
  expect(files).toContain('core/types.ts');
  expect(files).toContain('main.ts');
  expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);

  return files.map((rel) => [rel, stripComments(fs.readFileSync(path.join(srcDir, rel), 'utf8'))]);
}

describe('determinism guard', () => {
  it('no non-test file under src/ mentions Math.random', async () => {
    // Split so this file's own text never matches itself if it is ever scanned by mistake.
    const needle = 'Math.' + 'random';
    const offenders: string[] = [];
    for (const [rel, text] of await loadSources()) {
      const n = countOccurrences(text, needle);
      if (n > 0) offenders.push('src/' + rel + ' (' + n + ')');
    }
    expect(offenders, 'files using Math.random under src/').toEqual([]);
  });

  it('no non-test file under src/ uses Date', async () => {
    // CLAUDE.md: "No Date". A wall clock in a generation stage would make the same seed produce
    // different worlds on different days, which no other test would catch.
    const offenders: string[] = [];
    for (const [rel, text] of await loadSources()) {
      const hits = text.match(/\bDate\b/g);
      if (hits !== null) offenders.push('src/' + rel + ' (' + hits.length + ')');
    }
    expect(offenders, 'files using Date under src/').toEqual([]);
  });

  it('performance.now() appears only in the two files that measure timings', async () => {
    // CLAUDE.md: "performance.now() only for timings" — world.ts fills World.timings and main.ts
    // drives the app's readout. Anywhere else it would be a clock feeding generation output.
    const allowed = ['gen/world.ts', 'main.ts'];
    const needle = 'performance.' + 'now';
    const offenders: string[] = [];
    for (const [rel, text] of await loadSources()) {
      if (allowed.includes(rel)) continue;
      const n = countOccurrences(text, needle);
      if (n > 0) offenders.push('src/' + rel + ' (' + n + ')');
    }
    expect(offenders, 'files outside ' + allowed.join(', ') + ' using performance.now()').toEqual([]);
  });
});
