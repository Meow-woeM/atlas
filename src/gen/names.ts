/**
 * gen/names.ts — Stage 12 (Names). Fills every `name` field of a World in place and titles it.
 *
 * RNG streams: `names/...`, one independent fork of world.seed per entity, never a shared stage
 * stream. Stable labels (renaming one is a params.version bump):
 *   fork(seed, 'names', 'culture:<i>', 'lang')  -> makeLanguage for culture i
 *   fork(seed, 'names', 'culture:<i>')          -> culture i's name
 *   fork(seed, 'names', '<kind>:<id>')          -> kind in settlement | nation | province | river |
 *                                                  lake | sea | range, id = the entity's index
 *   fork(seed, 'names', 'fallback', 'lang')     -> a spare language, made only when a world has no
 *                                                  cultures at all (nothing else ever draws from it)
 *   fork(seed, 'names', 'world')                -> worldTitle (pure; a fresh fork on every call)
 *
 * Inputs:  World after stage 11: politics.cultures (each carrying the placeholder language from
 *          politics.ts, REPLACED here), politics.nations, politics.p_culture, r_province,
 *          settlements, provinces, features.rivers / lakes / seas / ranges, and the mesh for the
 *          culture vote of geographic features (t_circulate_r, r_circulate_r, s_inner_t,
 *          s_outer_t). Coordinates are never read.
 * Outputs: in place — cultures[i].language and .name, settlements[i].name, nations[i].name,
 *          provinces[i].name, features.rivers[i].name, .lakes[i].name, .seas[i].name,
 *          .ranges[i].name. Nothing else is written; worldTitle writes nothing.
 *
 * Language of an entity (index c into politics.cultures; when the world has no cultures at all
 * the 'fallback' language stands in for every c):
 *   culture     its own freshly made language
 *   settlement  settlement.culture, or 0 when that is out of range
 *   nation      the capital settlement's culture, else nation.culture, else 0
 *   province    p_culture[p], else the seat settlement's culture, else 0
 *   river       the culture with the most votes over the cells of the corners along river.sides
 *               (s_inner_t of every side plus s_outer_t of the last; the 3 cells of each corner via
 *               t_circulate_r; a cell votes p_culture[r_province[r]] when both are >= 0), ties to the
 *               smaller culture index, 0 when nobody votes
 *   lake, sea   the same vote over the land cells adjacent (r_circulate_r) to the entity's cells
 *   range       the same vote over the entity's own cells
 *
 * Name generation, per entity from its fork, in this exact draw order. A world-wide Set of
 * lower-cased names rejects duplicates: the generator below is rolled once and re-rolled up to
 * REROLLS (8) more times from the same fork; after that the last roll gets ' ' + a plain
 * makeWord(lang, rng) appended (up to FALLBACK_WORDS tries), and as a last resort ' ' + a roman
 * numeral II, III, ... until the name is free. Every roll is a fresh full pass of the generator:
 *   culture i   makeWord(lang, rng); rng.next() < DEMONYM_P (0.3) -> rng.pick(DEMONYM_SUFFIXES)
 *               appended (a trailing vowel of the word is dropped first; all suffixes start with one)
 *   settlement  if port or riverMouth: rng.next() < PORT_P (0.4) -> kind 'port' else 'city';
 *               inland settlements always 'city'; then makeWord(lang, rng, kind)
 *   nation      rng.next() < REALM_P (0.6) -> makeWord(lang, rng, 'realm') else makeWord(lang, rng)
 *   province    rng.next() < PROVINCE_MORPHEME_P (0.3) -> rng.pick(PROVINCE_KINDS) then
 *               makeWord(lang, rng, kind); else makeWord(lang, rng)
 *   river       rivers are named parents first (index sort by depth in the parent tree, then index);
 *               when river.parent >= 0 and the parent is already named: rng.next() < TRIBUTARY_P
 *               (0.3) -> rng.pick over 'Little <parent>' | '<parent> Fork' | 'Upper <parent>';
 *               otherwise makeWord(lang, rng, 'river')
 *   lake        makeWord(lang, rng, 'lake');  sea  makeWord(lang, rng, 'sea');  range  'mount'
 * Entity order (the order names enter the duplicate Set): cultures, settlements, nations,
 * provinces, rivers (depth then index), lakes, seas, ranges. Each entity's fork is independent, so
 * the order only decides who wins a collision.
 *
 * worldTitle(world): pure. X = the largest nation's name (most provinces in p_nation, ties to the
 * lower id), or that nation's culture name when the nation is unnamed; Y candidates = the second
 * largest nation's name and the largest sea's name (non-empty ones only). From
 * fork(seed, 'names', 'world'): rng.int(0, variants - 1) over 'The X Lands' | 'The Realms of X' |
 * 'Lands of X' | 'X and the Y Shores' (the fourth only when a Y exists), then rng.pick over the Y
 * candidates when the fourth was drawn. 'The Unnamed Lands' when no X exists.
 */

import type { Language, MorphemeKind, World } from '../core/types';
import type { Rng } from '../core/rng';
import { fork } from '../core/rng';
import { r_circulate_r, s_inner_t, s_outer_t, t_circulate_r } from '../mesh/dualmesh';
import { ENDS_WITH_VOWEL, makeLanguage, makeWord } from './language';
import type { Edits } from './edits';
import { parseId } from '../core/ids';

const DEMONYM_SUFFIXES: readonly string[] = ['ish', 'ian', 'i', 'ese', 'ar'];
const DEMONYM_P = 0.3;
const PORT_P = 0.4;
const REALM_P = 0.6;
const PROVINCE_MORPHEME_P = 0.3;
const PROVINCE_KINDS: readonly MorphemeKind[] = ['city', 'wood', 'mount'];
const TRIBUTARY_P = 0.3;
const TRIBUTARY_PATTERNS: readonly ((parent: string) => string)[] = [
  (parent) => 'Little ' + parent,
  (parent) => parent + ' Fork',
  (parent) => 'Upper ' + parent,
];
const REROLLS = 8;
const FALLBACK_WORDS = 4;
const UNNAMED_TITLE = 'The Unnamed Lands';

// ------------------------------------------------------------------ helpers

/** Lower-cased key; '' never counts as a name. Returns true and records the name when it is free. */
function claim(used: Set<string>, name: string): boolean {
  if (name === '') return false;
  const key = name.toLowerCase();
  if (used.has(key)) return false;
  used.add(key);
  return true;
}

const ROMAN: readonly [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function roman(n: number): string {
  let out = '';
  let rest = n;
  for (let i = 0; i < ROMAN.length; i++) {
    const [value, glyph] = ROMAN[i];
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/** Rolls gen until the name is unused world-wide (see the file comment for the fallbacks). */
function uniqueName(used: Set<string>, rng: Rng, lang: Language, gen: (rng: Rng) => string): string {
  let name = '';
  for (let attempt = 0; attempt <= REROLLS; attempt++) {
    name = gen(rng);
    if (claim(used, name)) return name;
  }
  if (name === '') name = makeWord(lang, rng);
  for (let k = 0; k < FALLBACK_WORDS; k++) {
    const longer = name + ' ' + makeWord(lang, rng);
    if (claim(used, longer)) return longer;
  }
  for (let n = 2; ; n++) {
    const numbered = name + ' ' + roman(n);
    if (claim(used, numbered)) return numbered;
  }
}

/** True if the last letter of a spelled word is a vowel, accented or not. Uses language.ts's
 *  literal vowel table rather than normalize()/\p{M} so names never depend on the runtime's ICU. */
function endsWithVowel(word: string): boolean {
  return ENDS_WITH_VOWEL.test(word);
}

/** Argmax with the smaller index on ties; 0 when every count is 0 (or the tally is empty). */
function argmax(tally: Int32Array): number {
  let best = 0;
  let bestCount = 0;
  for (let c = 0; c < tally.length; c++) {
    if (tally[c] > bestCount) {
      best = c;
      bestCount = tally[c];
    }
  }
  return best;
}

// ------------------------------------------------------------------ stage 12

export function assignNames(world: World): void {
  const { seed, mesh, settlements, provinces, features, r_province } = world;
  const { cultures, nations, p_culture } = world.politics;
  const numCultures = cultures.length;
  const numP = p_culture.length;
  const used = new Set<string>();
  const scratch: number[] = [];

  // ---- languages: one per culture, plus a spare for worlds without cultures
  let fallback: Language | null = null;
  const languageOf = (c: number): Language => {
    if (c >= 0 && c < numCultures) return cultures[c].language;
    if (fallback === null) fallback = makeLanguage(fork(seed, 'names', 'fallback', 'lang'));
    return fallback;
  };
  const cultureOfCell = (r: number): number => {
    const p = r_province[r];
    if (p < 0 || p >= numP) return -1;
    const c = p_culture[p];
    return c >= 0 && c < numCultures ? c : -1;
  };
  const tally = new Int32Array(numCultures);
  const vote = (r: number): void => {
    const c = cultureOfCell(r);
    if (c >= 0) tally[c]++;
  };

  // ---- cultures
  for (let i = 0; i < numCultures; i++) {
    const culture = cultures[i];
    const lang = makeLanguage(fork(seed, 'names', 'culture:' + i, 'lang'));
    culture.language = lang;
    culture.name = uniqueName(used, fork(seed, 'names', 'culture:' + i), lang, (rng) => {
      let word = makeWord(lang, rng);
      if (rng.next() < DEMONYM_P) {
        const suffix = rng.pick(DEMONYM_SUFFIXES);
        if (endsWithVowel(word)) word = word.slice(0, -1);
        word += suffix;
      }
      return word;
    });
  }

  // ---- settlements
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    const lang = languageOf(s.culture >= 0 && s.culture < numCultures ? s.culture : 0);
    const coastal = s.port || s.riverMouth;
    s.name = uniqueName(used, fork(seed, 'names', 'settlement:' + i), lang, (rng) => {
      const kind: MorphemeKind = coastal && rng.next() < PORT_P ? 'port' : 'city';
      return makeWord(lang, rng, kind);
    });
  }

  // ---- nations
  for (let i = 0; i < nations.length; i++) {
    const nation = nations[i];
    const capital = nation.capital >= 0 && nation.capital < settlements.length ? settlements[nation.capital] : null;
    let c = capital !== null ? capital.culture : -1;
    if (c < 0 || c >= numCultures) c = nation.culture;
    if (c < 0 || c >= numCultures) c = 0;
    const lang = languageOf(c);
    nation.name = uniqueName(used, fork(seed, 'names', 'nation:' + i), lang, (rng) => (
      rng.next() < REALM_P ? makeWord(lang, rng, 'realm') : makeWord(lang, rng)
    ));
  }

  // ---- provinces
  for (let p = 0; p < provinces.length; p++) {
    const province = provinces[p];
    let c = p < numP ? p_culture[p] : -1;
    if ((c < 0 || c >= numCultures) && province.seat >= 0 && province.seat < settlements.length) {
      c = settlements[province.seat].culture;
    }
    if (c < 0 || c >= numCultures) c = 0;
    const lang = languageOf(c);
    province.name = uniqueName(used, fork(seed, 'names', 'province:' + p), lang, (rng) => (
      rng.next() < PROVINCE_MORPHEME_P ? makeWord(lang, rng, rng.pick(PROVINCE_KINDS)) : makeWord(lang, rng)
    ));
  }

  // ---- rivers: parents before children
  const rivers = features.rivers;
  const numRivers = rivers.length;
  const depth = new Int32Array(numRivers);
  for (let i = 0; i < numRivers; i++) {
    let d = 0;
    let j = rivers[i].parent;
    while (j >= 0 && j < numRivers && d < numRivers) {
      d++;
      j = rivers[j].parent;
    }
    depth[i] = d;
  }
  const riverOrder = new Int32Array(numRivers);
  for (let i = 0; i < numRivers; i++) riverOrder[i] = i;
  riverOrder.sort((a, b) => depth[a] - depth[b] || a - b);
  for (let k = 0; k < numRivers; k++) {
    const i = riverOrder[k];
    const river = rivers[i];
    const sides = river.sides;
    tally.fill(0);
    for (let j = 0; j < sides.length; j++) {
      t_circulate_r(mesh, s_inner_t(sides[j]), scratch);
      for (let m = 0; m < scratch.length; m++) vote(scratch[m]);
    }
    if (sides.length > 0) {
      const t = s_outer_t(mesh, sides[sides.length - 1]);
      if (t >= 0) {
        t_circulate_r(mesh, t, scratch);
        for (let m = 0; m < scratch.length; m++) vote(scratch[m]);
      }
    }
    const lang = languageOf(argmax(tally));
    const parentName = river.parent >= 0 && river.parent < numRivers ? rivers[river.parent].name : '';
    river.name = uniqueName(used, fork(seed, 'names', 'river:' + i), lang, (rng) => {
      if (parentName !== '' && rng.next() < TRIBUTARY_P) return rng.pick(TRIBUTARY_PATTERNS)(parentName);
      return makeWord(lang, rng, 'river');
    });
  }

  // ---- lakes, seas, ranges
  const areaCulture = (cells: Int32Array, viaNeighbors: boolean): number => {
    tally.fill(0);
    for (let j = 0; j < cells.length; j++) {
      const r = cells[j];
      if (!viaNeighbors) {
        vote(r);
        continue;
      }
      r_circulate_r(mesh, r, scratch);
      for (let m = 0; m < scratch.length; m++) vote(scratch[m]);
    }
    return argmax(tally);
  };
  const lakes = features.lakes;
  for (let i = 0; i < lakes.length; i++) {
    const lang = languageOf(areaCulture(lakes[i].cells, true));
    lakes[i].name = uniqueName(used, fork(seed, 'names', 'lake:' + i), lang, (rng) => makeWord(lang, rng, 'lake'));
  }
  const seas = features.seas;
  for (let i = 0; i < seas.length; i++) {
    const lang = languageOf(areaCulture(seas[i].cells, true));
    seas[i].name = uniqueName(used, fork(seed, 'names', 'sea:' + i), lang, (rng) => makeWord(lang, rng, 'sea'));
  }
  const ranges = features.ranges;
  for (let i = 0; i < ranges.length; i++) {
    const lang = languageOf(areaCulture(ranges[i].cells, false));
    ranges[i].name = uniqueName(used, fork(seed, 'names', 'range:' + i), lang, (rng) => makeWord(lang, rng, 'mount'));
  }
}

// ------------------------------------------------------------------ title

export function worldTitle(world: World): string {
  const { nations, cultures, p_nation } = world.politics;
  const numNations = nations.length;
  if (numNations === 0) return UNNAMED_TITLE;

  // Nations by owned province count, descending, lower id first on ties: the world speaks the
  // dominant nation's tongue, but it is not called after any nation.
  const counts = new Int32Array(numNations);
  for (let p = 0; p < p_nation.length; p++) {
    const n = p_nation[p];
    if (n >= 0 && n < numNations) counts[n]++;
  }
  const order = new Int32Array(numNations);
  for (let n = 0; n < numNations; n++) order[n] = n;
  order.sort((a, b) => counts[b] - counts[a] || a - b);

  const largest = nations[order[0]];
  if (largest.name === '') return UNNAMED_TITLE;          // assignNames has not run
  const c = largest.culture >= 0 && largest.culture < cultures.length ? largest.culture : -1;
  const lang = c >= 0 ? cultures[c].language : null;
  if (lang === null || lang.consonants.length === 0 || lang.vowels.length === 0) return UNNAMED_TITLE;

  // Every name in the world is taken, so the title's word can never be a nation's (or a town's).
  const used = new Set<string>();
  for (const n of nations) claim(used, n.name);
  for (const cu of cultures) claim(used, cu.name);
  for (const s of world.settlements) claim(used, s.name);
  for (const pr of world.provinces) claim(used, pr.name);
  const { rivers, lakes, seas, ranges } = world.features;
  for (const r of rivers) claim(used, r.name);
  for (const l of lakes) claim(used, l.name);
  for (const se of seas) claim(used, se.name);
  for (const g of ranges) claim(used, g.name);

  const rng = fork(world.seed, 'names', 'world');
  const x = uniqueName(used, rng, lang, (r) => makeWord(lang, r, 'realm'));

  const ys: string[] = [];
  let bigSea = -1;
  for (let i = 0; i < seas.length; i++) {
    if (bigSea < 0 || seas[i].cells.length > seas[bigSea].cells.length) bigSea = i;
  }
  if (bigSea >= 0 && seas[bigSea].name !== '') ys.push(seas[bigSea].name);

  const variant = rng.int(0, ys.length > 0 ? 4 : 3);
  switch (variant) {
    case 0: return 'The ' + x + ' Lands';
    case 1: return 'The Realms of ' + x;
    case 2: return 'Lands of ' + x;
    case 3: return 'The ' + x + ' Reach';
    default: return x + ' and the ' + rng.pick(ys) + ' Shores';
  }
}

/** Applies valid stable-id name replacements; generated names remain untouched otherwise. */
export function applyNameEdits(world: World, edits: Edits): void {
  const entities = {
    settlement: world.settlements,
    province: world.provinces,
    nation: world.politics.nations,
    culture: world.politics.cultures,
    river: world.features.rivers,
    lake: world.features.lakes,
    sea: world.features.seas,
    range: world.features.ranges,
  } as const;
  for (const [rawId, replacement] of Object.entries(edits.names)) {
    try {
      const { kind, index } = parseId(rawId as `${keyof typeof entities}:${number}`);
      if (!(kind in entities)) continue;
      const list = entities[kind as keyof typeof entities];
      if (index < 0 || index >= list.length) continue;
      list[index].name = replacement;
    } catch {
      // Persistence is user-controlled; malformed ids are deliberately ignored.
    }
  }
}
