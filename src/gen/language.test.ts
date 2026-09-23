/**
 * gen/language.test.ts — Stage 12 (Names): tests for the O'Leary-style language generator.
 * No mesh is needed: makeLanguage and makeWord depend only on an Rng, so each test seeds its own
 * makeRng('<label>') the way names.ts forks per culture / per entity. The one exception is the ICU
 * guard, which runs generate('atlas', { cellSpacing: 12 }) twice, once with String.prototype.normalize
 * stubbed to the identity, to pin that stage 12 depends on the seed alone.
 * Inputs: src/gen/language.ts (and gen/world.ts for the ICU guard). Outputs: pass/fail plus a printed
 * distinct-word count and timing.
 */
import { describe, it, expect } from 'vitest';
import { makeRng } from '../core/rng';
import type { Language, MorphemeKind, World } from '../core/types';
import { ENDS_WITH_VOWEL, makeLanguage, makeWord } from './language';
import { generate } from './world';

/** The syllable-template table from the task spec (section 5, stage 12); 'VC' appears twice there. */
const STRUCTURES: readonly string[] = [
  'CVC', 'CVV?C', 'CVVC?', 'CVC?', 'CV', 'VC', 'CVF', 'C?VC', 'CVF?', 'CL?VC', 'CL?VF',
  'S?CVC', 'S?CVF', 'S?CVC?', 'C?VF', 'C?VC?', 'C?VF?', 'C?L?VC', 'VC', 'CVL?C?', 'C?VL?C', 'C?VLC?',
];
const KINDS: readonly MorphemeKind[] = ['city', 'river', 'lake', 'sea', 'mount', 'wood', 'realm', 'port'];
/** Capital initial (ASCII or U+00C0..U+024F, i.e. À..ɏ) then letters, apostrophes, hyphens, spaces. */
const NAME_RE = /^[A-ZÀ-ɏ][\p{L}'\-\s]*$/u;

function hasVowel(s: string): boolean {
  return /[aeiou]/i.test(s.normalize('NFD'));
}

/** Inventory identity independent of the per-language shuffle. */
function inventoryKey(lang: Language): string {
  return [...lang.consonants].sort().join('') + '|' + [...lang.vowels].sort().join('') + '|' + lang.structure;
}

/** True if a kinded name carries one of lang.morphemes[kind] as a prefix/suffix part. */
function usesMorpheme(lang: Language, word: string, kind: MorphemeKind): boolean {
  const list = lang.morphemes[kind];
  const lower = word.toLowerCase();
  if (lang.joiner === '') return list.some((m) => lower.startsWith(m) || lower.endsWith(m));
  const parts = lower.split(lang.joiner);
  return parts.some((p) => list.includes(p));
}

/** Every name assignNames writes, in entity order, so two worlds can be compared name for name. */
function allNames(w: World): string[] {
  return [
    ...w.politics.cultures.map((c) => c.name), ...w.settlements.map((s) => s.name),
    ...w.politics.nations.map((n) => n.name), ...w.provinces.map((p) => p.name),
    ...w.features.rivers.map((r) => r.name), ...w.features.lakes.map((l) => l.name),
    ...w.features.seas.map((s) => s.name), ...w.features.ranges.map((r) => r.name),
  ];
}

/** Runs fn with String.prototype.normalize stubbed to the identity, as on a V8 built without ICU. */
function withoutNormalize<T>(fn: () => T): T {
  const orig = String.prototype.normalize;
  String.prototype.normalize = function (this: string): string { return String(this); };
  try {
    return fn();
  } finally {
    String.prototype.normalize = orig;
  }
}

/** Built once and reused: ten languages from ten culture-style forks. */
const LANGS: Language[] = [];
for (let i = 0; i < 10; i++) LANGS.push(makeLanguage(makeRng('lang-' + i)));

describe('makeLanguage', () => {
  it('is a pure function of the rng', () => {
    const a = makeLanguage(makeRng('x'));
    const b = makeLanguage(makeRng('x'));
    expect(a).toEqual(b);
  });

  it('varies across seeds', () => {
    const inventories = new Set<string>();
    const whole = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const lang = makeLanguage(makeRng('seed-' + i));
      inventories.add(inventoryKey(lang));
      whole.add(JSON.stringify(lang));
    }
    expect(inventories.size).toBeGreaterThanOrEqual(15);
    expect(whole.size).toBe(20);
  });

  it('produces valid languages', () => {
    const problems: string[] = [];
    const check = (ok: boolean, what: string): void => {
      if (!ok && problems.length < 20) problems.push(what);
    };
    for (let i = 0; i < 40; i++) {
      const tag = 'valid-' + i;
      const lang = makeLanguage(makeRng(tag));
      check(lang.consonants.length > 0, `${tag}: no consonants`);
      check(lang.vowels.length > 0, `${tag}: no vowels`);
      check(lang.sibilants.length > 0 && lang.liquids.length > 0 && lang.finals.length > 0, `${tag}: empty S/L/F`);
      check(STRUCTURES.includes(lang.structure), `${tag}: structure ${lang.structure} not in table`);
      check(lang.minSyl >= 1 && lang.minSyl <= lang.maxSyl && lang.maxSyl <= 3, `${tag}: syllables ${lang.minSyl}..${lang.maxSyl}`);
      check(lang.joiner === '' || lang.joiner === ' ' || lang.joiner === '-', `${tag}: joiner ${JSON.stringify(lang.joiner)}`);
      const inventory = [...lang.consonants, ...lang.vowels, ...lang.sibilants, ...lang.liquids, ...lang.finals];
      for (const p of inventory) check(typeof lang.ortho[p] === 'string' && lang.ortho[p].length > 0, `${tag}: no spelling for ${p}`);
      for (const v of Object.values(lang.ortho)) check(typeof v === 'string', `${tag}: ortho value ${String(v)}`);
      const seen = new Set<string>();
      for (const kind of KINDS) {
        const list = lang.morphemes[kind];
        check(Array.isArray(list) && list.length >= 3 && list.length <= 6, `${tag}: ${kind} has ${list?.length} morphemes`);
        for (const m of list) {
          check(typeof m === 'string' && /^[\p{L}']+$/u.test(m) && m === m.toLowerCase(), `${tag}: bad morpheme ${JSON.stringify(m)}`);
          check(hasVowel(m) && !m.startsWith("'") && !m.endsWith("'"), `${tag}: morpheme ${m} lacks a vowel or is apostrophe-edged`);
          check(!seen.has(m), `${tag}: morpheme ${m} repeated across kinds`);
          seen.add(m);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('makeWord', () => {
  it('yields well-formed capitalized names over 2000 draws across 10 languages', () => {
    const problems: string[] = [];
    const check = (ok: boolean, what: string): void => {
      if (!ok && problems.length < 20) problems.push(what);
    };
    let draws = 0;
    for (let li = 0; li < LANGS.length; li++) {
      const lang = LANGS[li];
      for (let i = 0; i < 200; i++) {
        const kind = i < 100 ? undefined : KINDS[i % KINDS.length];
        const w = makeWord(lang, makeRng(`w-${li}-${i}`), kind);
        draws++;
        const joined = w.includes(' ') || w.includes('-');
        const maxLen = joined ? 22 : 14;
        check(NAME_RE.test(w), `lang ${li} ${kind ?? 'plain'}: malformed ${JSON.stringify(w)}`);
        check(hasVowel(w), `lang ${li}: no vowel in ${w}`);
        check(w.length >= 3 && w.length <= maxLen, `lang ${li} ${kind ?? 'plain'}: length ${w.length} for ${w}`);
        check(w.trim() === w && !w.includes('  '), `lang ${li}: stray whitespace in ${JSON.stringify(w)}`);
      }
    }
    expect(draws).toBe(2000);
    expect(problems).toEqual([]);
  });

  it('is a pure function of the rng state', () => {
    let mismatches = 0;
    for (let i = 0; i < 100; i++) {
      const lang = LANGS[i % LANGS.length];
      const kind = i % 3 === 0 ? undefined : KINDS[i % KINDS.length];
      const a = makeWord(lang, makeRng('same-' + i), kind);
      const b = makeWord(lang, makeRng('same-' + i), kind);
      if (a !== b) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('draws at least 500 distinct words from every language in 2000 draws', () => {
    const counts: number[] = [];
    for (let li = 0; li < LANGS.length; li++) {
      const lang = LANGS[li];
      const rng = makeRng('distinct-' + li);
      const seen = new Set<string>();
      for (let i = 0; i < 2000; i++) seen.add(makeWord(lang, rng));
      counts.push(seen.size);
    }
    console.log('distinct words per language over 2000 draws:', counts.join(' '));
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(500);
  });

  it('attaches a morpheme of the requested kind in at least 40% of draws', () => {
    const ratios: Record<string, number> = {};
    for (const kind of KINDS) {
      let hits = 0;
      let total = 0;
      for (let li = 0; li < LANGS.length; li++) {
        const lang = LANGS[li];
        for (let i = 0; i < 50; i++) {
          const w = makeWord(lang, makeRng(`k-${kind}-${li}-${i}`), kind);
          total++;
          if (usesMorpheme(lang, w, kind)) hits++;
        }
      }
      ratios[kind] = hits / total;
    }
    for (const kind of KINDS) expect(ratios[kind], kind).toBeGreaterThanOrEqual(0.4);
  });

  it('stays far inside the stage-12 budget', () => {
    const t0 = performance.now();
    const langs: Language[] = [];
    for (let i = 0; i < 8; i++) langs.push(makeLanguage(makeRng('perf-lang-' + i)));
    const t1 = performance.now();
    let sink = 0;
    for (let i = 0; i < 500; i++) {
      const kind = i % 2 === 0 ? undefined : KINDS[i % KINDS.length];
      sink += makeWord(langs[i % langs.length], makeRng('perf-word-' + i), kind).length;
    }
    const t2 = performance.now();
    console.log(`8 makeLanguage: ${(t1 - t0).toFixed(2)} ms; 500 makeWord: ${(t2 - t1).toFixed(2)} ms (${sink} chars)`);
    expect(sink).toBeGreaterThan(0);
    expect(t2 - t0).toBeLessThan(50);
  });
});

describe('vowel table (no ICU dependence)', () => {
  it('ENDS_WITH_VOWEL agrees with NFD decomposition on every letter the orthographies can emit', () => {
    // Every letter 400 languages spell: all 7 vowel orthographies x every long vowel, all 7 consonant
    // orthographies and DEFAULT_ORTHO appear many times over (the rarest, a long O, is 1 in 56 languages).
    const letters = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const v of Object.values(makeLanguage(makeRng('ortho-' + i)).ortho)) for (const ch of v) letters.add(ch);
    }
    for (const ch of 'áéíóúäëïöüâêîôûāēīōūàèìòù') expect(letters.has(ch), `sample never spelled ${ch}`).toBe(true);
    for (const ch of letters) {
      expect(ENDS_WITH_VOWEL.test(ch), `${ch} U+${ch.codePointAt(0)!.toString(16)}`).toBe(/[aeiou]/i.test(ch.normalize('NFD')));
    }
    // ... and nothing in the table that NFD would not call a vowel (ASCII, Latin-1, Latin Extended-A/B).
    for (let cp = 0; cp < 0x250; cp++) {
      const ch = String.fromCodePoint(cp);
      if (ENDS_WITH_VOWEL.test(ch)) expect(/[aeiou]/i.test(ch.normalize('NFD')), ch).toBe(true);
    }
    expect(ENDS_WITH_VOWEL.test('Kalá')).toBe(true);
    expect(ENDS_WITH_VOWEL.test('Kalaš')).toBe(false);
    expect(ENDS_WITH_VOWEL.test('')).toBe(false);
  });

  it('makes identical languages and words when String.prototype.normalize is the identity', () => {
    const run = (): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 30; i++) {
        const lang = makeLanguage(makeRng('icu-' + i));
        out.push(JSON.stringify(lang));
        for (let j = 0; j < 60; j++) {
          out.push(makeWord(lang, makeRng(`icu-${i}-${j}`), j % 4 === 0 ? undefined : KINDS[j % KINDS.length]));
        }
      }
      return out;
    };
    const before = run();
    const after = withoutNormalize(run);
    expect(after).toEqual(before);
  });

  it('names a whole world identically when String.prototype.normalize is the identity', () => {
    const before = allNames(generate('atlas', { cellSpacing: 12 }));
    const after = withoutNormalize(() => allNames(generate('atlas', { cellSpacing: 12 })));
    expect(after).toEqual(before);
  });
});
