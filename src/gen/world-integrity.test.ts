/**
 * gen/world-integrity.test.ts — structural guarantees of a generated World that the other suites
 * do not cover: it is structured-cloneable with no undefined / NaN / Infinity / function / class
 * values (the save-file and Worker seams depend on that), the WorldFile round trip is byte-identical
 * JSON, and generating other seeds in between never changes a seed's output (no module state).
 */
import { describe, it, expect } from 'vitest';
import { generate, toWorldFile, fromWorldFile } from './world';
import { buildPoliticalView } from './features';

function walk(v: unknown, path: string, out: string[], seen: Set<object>): void {
  if (v === undefined) { out.push(path + ' = undefined'); return; }
  if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(path + ' = ' + v); return; }
  if (typeof v === 'function') { out.push(path + ' = function'); return; }
  if (v === null || typeof v !== 'object') return;
  if (seen.has(v)) return; seen.add(v);
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { out.push(path + '[' + i + '] = ' + a[i]); break; }
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']', out, seen)); return; }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) out.push(path + ' has prototype ' + (proto.constructor?.name ?? '?'));
  for (const k of Object.keys(v as object)) walk((v as Record<string, unknown>)[k], path + '.' + k, out, seen);
}

function nameDump(w: ReturnType<typeof generate>): string {
  return JSON.stringify({
    s: w.settlements.map((s) => s.name), p: w.provinces.map((p) => p.name),
    n: w.politics.nations.map((n) => n.name), c: w.politics.cultures.map((c) => c.name),
    r: w.features.rivers.map((r) => r.name), l: w.features.lakes.map((l) => l.name),
    sea: w.features.seas.map((s) => s.name), rg: w.features.ranges.map((r) => r.name),
    title: w.history.events[0].data.title,
    langs: w.politics.cultures.map((c) => c.language),
  });
}

describe('world integrity: cloneability and file round trip', () => {
  const w = generate('atlas');
  it('World is structured-cloneable and has no undefined/NaN/Infinity/function/class values (timings excluded)', () => {
    const clone = structuredClone(w);
    expect(clone.mesh.numRegions).toBe(w.mesh.numRegions);
    const bad: string[] = [];
    const { timings: _t, ...rest } = w;
    walk(rest, 'world', bad, new Set());
    expect(bad).toEqual([]);
    // PoliticalView too
    const bad2: string[] = [];
    walk(buildPoliticalView(w), 'view', bad2, new Set());
    expect(bad2).toEqual([]);
  });
  it('toWorldFile(fromWorldFile(JSON(toWorldFile(w)))) is byte-identical JSON', () => {
    const f1 = JSON.stringify(toWorldFile(w));
    const w2 = fromWorldFile(JSON.parse(f1));
    const f2 = JSON.stringify(toWorldFile(w2));
    expect(f2).toBe(f1);
    expect(nameDump(w2)).toBe(nameDump(w));
  });
});

describe('world integrity: no module state leaks between generates', () => {
  it('generate A, B, A gives the same A (names, languages, geo)', () => {
    const a1 = generate('leak-a', { cellSpacing: 12 });
    generate('leak-b', { cellSpacing: 12 });
    generate('leak-c', { cellSpacing: 10 });
    const a2 = generate('leak-a', { cellSpacing: 12 });
    expect(nameDump(a2)).toBe(nameDump(a1));
    expect(Array.from(a2.geo.r_elevation)).toEqual(Array.from(a1.geo.r_elevation));
    expect(Array.from(a2.politics.p_nation)).toEqual(Array.from(a1.politics.p_nation));
  });
});
