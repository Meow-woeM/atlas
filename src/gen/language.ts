/**
 * gen/language.ts — Stage 12 (Names). O'Leary-style naming-language generator and word builder.
 *
 * RNG streams: makeLanguage is called with fork(seed, 'names', 'culture:<i>', 'lang'); makeWord with the
 * entity's own fork(seed, 'names', '<kind>:<id>'). Both draw only rng.pick / rng.int / rng.next on the
 * stream they are handed; neither forks, stores or shares a stream.
 * Inputs: an Rng (makeLanguage); a Language, an Rng and an optional MorphemeKind (makeWord).
 * Outputs: a plain-data Language (core/types.ts section 4) / one capitalized name string.
 *
 * Model (after Martin O'Leary's naming-language generator). A language is: a shuffled consonant
 * inventory from one of the CONSONANT_SETS archetypes; a vowel inventory (capital A E I O U are
 * long/marked vowels spelled by the vowel orthography); sibilant, liquid and final sets; one syllable
 * template from STRUCTURES (C consonant, V vowel, S sibilant, L liquid, F final; '?' makes the PREVIOUS
 * slot 50% optional); 1-3 syllables per word (heavy templates such as CL?VC cap at 2); an orthography
 * (phoneme -> spelling, e.g. ʃ -> sh|š|sch|ch|x|ş, x -> kh|ch, θ -> th, ŋ -> ng, ʔ -> ',
 * long a -> á|ä|â|ā|à|aa|au); a joiner ('' | ' ' | '-'); and 3-6 spelled, mutually distinct morphemes
 * per MorphemeKind. Phoneme picks are front-biased (index = floor(u² · n), O'Leary's exponent 2) so every
 * language has favorite sounds; the shuffle decides which. Syllables matching a RESTRICTED pattern
 * (doubled phoneme, sibilant, liquid, nasal+liquid or glide clusters) are re-rolled, and a syllable whose
 * junction with the previous one would double a digraph or a vowel, stack sibilants or triple a letter is
 * re-rolled too. lang.ortho holds a spelling for every phoneme in the inventory. Vowel checks use the
 * VOWEL_LETTERS table (every vowel spelling the orthographies can emit), never String.prototype.normalize
 * or a \p{..} class, so the draws they gate are identical on runtimes built without ICU.
 *
 * makeWord builds a core word of nsyl syllables, spells it, strips leading/trailing apostrophes, and
 * (with a kind, 60% of calls) prepends or appends (50/50) one morpheme of that kind with lang.joiner.
 * Each visible part (space- or hyphen-separated) is capitalized; a ''-joined name is one part.
 * Accepted names have a core of >= 3 letters containing a vowel, no tripled letter or doubled digraph,
 * and a total length <= 14 (<= 20 when a morpheme is joined with ' ' or '-'). Up to 10 attempts; then
 * the least-bad attempt is returned.
 *
 * RNG consumption order (changing it is a params.version bump):
 * makeLanguage: consonant set rng.pick + Fisher-Yates shuffle (rng.int(0, i) for i = n-1 .. 1); vowel set
 *   pick + shuffle; sibilant set pick + shuffle; liquid set pick + shuffle; final set pick + shuffle;
 *   structure pick; consonant-orthography pick; vowel-orthography pick; minSyl rng.int(1, 2) (forced to
 *   2 for two-slot templates); maxSyl rng.int(min(minSyl+1, cap), cap) with cap = 2 when the expected
 *   spelled syllable length is >= 3.5 letters else 3; joiner rng.next(); then for each MorphemeKind in
 *   MORPHEME_KINDS order: count rng.int(3, 6), and per morpheme up to 20 tries of [rng.int(1, 2)
 *   syllables, each built as below].
 * makeWord: if kind is given: attach rng.next() < 0.6; if attaching: prepend rng.next() < 0.5, then
 *   morpheme rng.pick(lang.morphemes[kind]); nsyl rng.int(minSyl, maxSyl); then up to 10 attempts of nsyl
 *   syllables. A syllable walks the template left to right: an optional slot draws rng.next() (< 0.5 skips
 *   it); every kept slot draws rng.next() for the biased pick; a RESTRICTED syllable is rebuilt (at most
 *   20 times) and a syllable with a bad junction to the previous one is rebuilt (at most 5 times).
 *   Between attempts nsyl steps one toward the length target without drawing.
 */

import type { Language, MorphemeKind } from '../core/types';
import type { Rng } from '../core/rng';

// ------------------------------------------------------------------ tables

/** Consonant archetypes. Phonemes are single BMP code units; the orthography spells the IPA ones. */
const CONSONANT_SETS = [
  'ptkmnls',              // minimal
  'ptkbdgmnlrsʃzʒʧ',      // English-ish
  'ptkmnh',               // Pirahã-like
  'hklmnpwʔ',             // Hawaiian-like
  'ptkmnlrsfθðxvɣ',       // Greek-ish
  'tksʃdbqɣxmnlrwj',      // Arabic-ish
  'tkdgmnsʃ',             // Arabic-lite
  'ptkbdgvmnlrszʃʒʧʦj',   // Slavic-ish
  'ptkbdgfvsʃhmnlrjwx',   // Germanic-ish
  'ptkqvsgrmnŋlj',        // Greenlandic-ish
  'ptkbdgmnszʃʧhjw',      // English-lite
] as const;

/** Vowel inventories; A E I O U are long/marked vowels spelled by VOWEL_ORTHO. */
const VOWEL_SETS = [
  'aeiou',      // standard 5-vowel
  'aiu',        // 3-vowel a i u
  'aeiouAEI',   // extra long A E I
  'aeiouU',     // extra long U
  'aiuAI',      // 5-vowel a i u A I
  'eou',        // 3-vowel e o u
  'aeiouAOU',   // extra long A O U
  'eiaEI',      // front-heavy
] as const;

const SIBILANT_SETS = ['s', 'sʃ', 'sʃf'] as const;
const LIQUID_SETS = ['rl', 'r', 'l', 'wj', 'rlwj', 'lw', 'rj'] as const;
const FINAL_SETS = ['mn', 'sk', 'mnŋ', 'sʃzʒ', 'nrl', 'ktp', 'ndl', 'rn', 'sn', 'mnl'] as const;

/** Syllable templates ('?' = the previous slot is optional). 'VC' is listed twice on purpose (O'Leary). */
const STRUCTURES = [
  'CVC', 'CVV?C', 'CVVC?', 'CVC?', 'CV', 'VC', 'CVF', 'C?VC', 'CVF?', 'CL?VC', 'CL?VF',
  'S?CVC', 'S?CVF', 'S?CVC?', 'C?VF', 'C?VC?', 'C?VF?', 'C?L?VC', 'VC', 'CVL?C?', 'C?VL?C', 'C?VLC?',
] as const;

/** Forbidden syllable shapes, tested on the phoneme string before spelling. */
const RESTRICTED: readonly RegExp[] = [
  /[sʃf][sʃ]/, /(.)\1/, /[rl][rl]/, /[wj][wjrl]/, /[mnŋ][rl]/, /[AEIOU][AEIOU]/,
];

const VOWEL_PHONEME = /[aeiouAEIOU]/;
const SIBILANT_PHONEME = /[sʃzʒ]/;
/** Phonemes (and letters) that may appear doubled across a boundary: 'kallo', 'hokka'; never 'hh', 'ww'. */
const DOUBLABLE = /[ptkbdgmnlrsfvz]/;

/** Fallback spelling of every non-Latin phoneme; identity for plain letters. */
const DEFAULT_ORTHO: Readonly<Record<string, string>> = {
  'ʃ': 'sh', 'ʒ': 'zh', 'ʧ': 'ch', 'ʤ': 'j', 'ŋ': 'ng', 'j': 'y', 'x': 'kh', 'ɣ': 'gh', 'ʔ': "'",
  'θ': 'th', 'ð': 'dh', 'ʦ': 'ts',
  'A': 'á', 'E': 'é', 'I': 'í', 'O': 'ó', 'U': 'ú',
};

/** Consonant orthography flavors layered over DEFAULT_ORTHO. */
const CONSONANT_ORTHO: readonly Readonly<Record<string, string>>[] = [
  {},                                                                          // default
  { 'ʃ': 'š', 'ʒ': 'ž', 'ʧ': 'č', 'ʤ': 'ǧ', 'j': 'j', 'ʦ': 'c', 'x': 'ch' },       // Slavic
  { 'ʃ': 'sch', 'ʒ': 'zh', 'ʧ': 'tsch', 'ʤ': 'dz', 'j': 'j', 'x': 'ch', 'ʦ': 'z' }, // German
  { 'ʃ': 'ch', 'ʒ': 'j', 'ʧ': 'tch', 'ʤ': 'dj', 'x': 'kh' },                       // French
  { 'ʃ': 'x', 'ʧ': 'q', 'ʤ': 'j', 'ʦ': 'c' },                                     // pinyin-ish
  { 'ʃ': 'ş', 'ʧ': 'ç', 'ʒ': 'j', 'ʤ': 'c', 'j': 'y', 'ɣ': 'ğ' },                  // Turkish-ish
  { 'x': 'ch', 'ð': 'dd', 'θ': 'th', 'v': 'f' },                                   // Welsh-ish
];

/** Long-vowel spellings. */
const VOWEL_ORTHO: readonly Readonly<Record<string, string>>[] = [
  { 'A': 'á', 'E': 'é', 'I': 'í', 'O': 'ó', 'U': 'ú' },        // acutes
  { 'A': 'ä', 'E': 'ë', 'I': 'ï', 'O': 'ö', 'U': 'ü' },        // umlauts
  { 'A': 'â', 'E': 'ê', 'I': 'î', 'O': 'ô', 'U': 'û' },        // circumflexes
  { 'A': 'ā', 'E': 'ē', 'I': 'ī', 'O': 'ō', 'U': 'ū' },        // macrons
  { 'A': 'à', 'E': 'è', 'I': 'ì', 'O': 'ò', 'U': 'ù' },        // graves
  { 'A': 'aa', 'E': 'ee', 'I': 'ii', 'O': 'oo', 'U': 'uu' },   // doubles
  { 'A': 'au', 'E': 'ei', 'I': 'ie', 'O': 'ou', 'U': 'oo' },   // diphthongs
];

/**
 * Every vowel letter the VOWEL_ORTHO / DEFAULT_ORTHO tables can emit; keep in sync with them.
 * Deliberately a literal table rather than normalize('NFD') + /\p{M}/u: on a no-ICU runtime normalize is
 * the identity and \p{..} is a SyntaxError, and hasVowel decides how many draws makeWord and makeLanguage
 * consume, so it must depend on the seed alone (language.test.ts pins both properties).
 */
const VOWEL_LETTERS = 'aeiouáéíóúäëïöüâêîôûāēīōūàèìòù';
const HAS_VOWEL = new RegExp('[' + VOWEL_LETTERS + ']', 'i');
/** True if a spelled word ends in a vowel letter, accented or not; names.ts uses it to drop one before a demonym suffix. */
export const ENDS_WITH_VOWEL = new RegExp('[' + VOWEL_LETTERS + ']$', 'i');

const MORPHEME_KINDS = ['city', 'river', 'lake', 'sea', 'mount', 'wood', 'realm', 'port'] as const satisfies readonly MorphemeKind[];

const MIN_CORE_LEN = 3;      // letters in the core word
const MAX_LEN = 14;          // total length of a name that is one run of letters
const MAX_LEN_JOINED = 20;   // total length when a morpheme is joined with ' ' or '-'
const WORD_ATTEMPTS = 10;
const SYLLABLE_TRIES = 20;
const JUNCTION_TRIES = 5;
const MORPHEME_TRIES = 20;
const ATTACH_P = 0.6;
const HEAVY_WEIGHT = 3.5;    // expected spelled letters per syllable at which words cap at 2 syllables

// ------------------------------------------------------------------ helpers

/** Splits an inventory string into phonemes and Fisher-Yates shuffles it with rng.int. */
function shuffled(chars: string, rng: Rng): string[] {
  const arr = Array.from(chars);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** O'Leary's choose(list, 2): front-biased pick so the first entries of a shuffled list dominate. */
function pickBiased(list: readonly string[], rng: Rng): string {
  const u = rng.next();
  return list[Math.floor(u * u * list.length)];
}

function slotList(lang: Language, slot: string): readonly string[] {
  switch (slot) {
    case 'V': return lang.vowels;
    case 'S': return lang.sibilants;
    case 'L': return lang.liquids;
    case 'F': return lang.finals;
    default: return lang.consonants;
  }
}

function isRestricted(syl: string): boolean {
  for (let i = 0; i < RESTRICTED.length; i++) {
    if (RESTRICTED[i].test(syl)) return true;
  }
  return false;
}

/**
 * True if phoneme `next` may not follow phoneme `prev` across a syllable boundary: the same phoneme
 * twice unless it is a doublable single letter ('zhzh', 'aa', 'hh'), two sibilants ('zsh'), a long vowel
 * in hiatus ('ie'+'au'), or spellings that would triple a letter ('aa'+'a', 'sh'+'h').
 */
function junctionBad(lang: Language, prev: string, next: string): boolean {
  const a = lang.ortho[prev] ?? prev;
  const b = lang.ortho[next] ?? next;
  if (prev === next) return a.length > 1 || !DOUBLABLE.test(prev);
  if (SIBILANT_PHONEME.test(prev) && SIBILANT_PHONEME.test(next)) return true;
  if (VOWEL_PHONEME.test(prev) && VOWEL_PHONEME.test(next) && (a.length > 1 || b.length > 1)) return true;
  return a[a.length - 1] === b[0] && (a.length > 1 || b.length > 1);
}

function meanSpelledLength(list: readonly string[], ortho: Readonly<Record<string, string>>): number {
  if (list.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < list.length; i++) sum += (ortho[list[i]] ?? list[i]).length;
  return sum / list.length;
}

/** Expected spelled letters per syllable: optional slots count half, inventories by their mean spelling. */
function syllableWeight(lang: Language): number {
  const structure = lang.structure;
  let w = 0;
  for (let i = 0; i < structure.length; i++) {
    const optional = structure[i + 1] === '?';
    w += (optional ? 0.5 : 1) * meanSpelledLength(slotList(lang, structure[i]), lang.ortho);
    if (optional) i++;
  }
  return w;
}

/** One syllable of phonemes (unspelled) following lang.structure; rebuilt while RESTRICTED matches. */
function makeSyllable(lang: Language, rng: Rng): string {
  const structure = lang.structure;
  let syl = '';
  for (let tries = 0; tries < SYLLABLE_TRIES; tries++) {
    syl = '';
    for (let i = 0; i < structure.length; i++) {
      const slot = structure[i];
      if (structure[i + 1] === '?') {
        i++;
        if (rng.next() < 0.5) continue;
      }
      const list = slotList(lang, slot);
      if (list.length === 0) continue;
      syl += pickBiased(list, rng);
    }
    if (!isRestricted(syl)) break;
  }
  return syl;
}

/** n syllables of phonemes; a syllable that joins badly onto the previous one is re-rolled a few times. */
function makeSyllables(lang: Language, rng: Rng, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    let syl = makeSyllable(lang, rng);
    if (s !== '' && syl !== '') {
      for (let tries = 0; tries < JUNCTION_TRIES && junctionBad(lang, s[s.length - 1], syl[0]); tries++) {
        syl = makeSyllable(lang, rng);
      }
    }
    s += syl;
  }
  return s;
}

/** Applies lang.ortho phoneme by phoneme; unknown phonemes spell as themselves. */
function spell(lang: Language, phonemes: string): string {
  let out = '';
  for (const p of phonemes) out += lang.ortho[p] ?? p;
  return out;
}

/** Collapses runs of apostrophes and strips them from both ends so parts always start with a letter. */
function tidy(s: string): string {
  return s.replace(/''+/g, "'").replace(/^'+|'+$/g, '');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** True if the string contains a vowel letter from VOWEL_LETTERS, with or without a diacritic. */
function hasVowel(s: string): boolean {
  return HAS_VOWEL.test(s);
}

/** Per-language cache of digraphsOf; keyed weakly so a Language stays plain data and cloneable. */
const DIGRAPH_CACHE = new WeakMap<Language, string[]>();

/** Multi-letter spellings of the language (digraphs, long vowels), used to reject doubled digraphs. */
function digraphsOf(lang: Language): string[] {
  const cached = DIGRAPH_CACHE.get(lang);
  if (cached !== undefined) return cached;
  const out: string[] = [];
  for (const v of Object.values(lang.ortho)) {
    if (v.length > 1 && !out.includes(v)) out.push(v);
  }
  DIGRAPH_CACHE.set(lang, out);
  return out;
}

/** A spelled string reads badly if a letter is tripled or a digraph is doubled ('shsh', 'aaaa'). */
function spellingBad(s: string, digraphs: readonly string[]): boolean {
  if (/(.)\1\1/.test(s)) return true;
  for (let i = 0; i < digraphs.length; i++) {
    if (s.includes(digraphs[i] + digraphs[i])) return true;
  }
  return false;
}

/** The join of two spelled parts with no separator reads badly if it doubles a vowel or an 'h'-like letter. */
function joinBad(a: string, b: string): boolean {
  const x = a[a.length - 1];
  return x === b[0] && !DOUBLABLE.test(x);
}

function assemble(core: string, morpheme: string, prepend: boolean, joiner: string): string {
  if (morpheme === '') return capitalize(core);
  if (joiner === '') return capitalize(prepend ? morpheme + core : core + morpheme);
  return prepend
    ? capitalize(morpheme) + joiner + capitalize(core)
    : capitalize(core) + joiner + capitalize(morpheme);
}

// ------------------------------------------------------------------ exports

export function makeLanguage(rng: Rng): Language {
  const consonants = shuffled(rng.pick(CONSONANT_SETS), rng);
  const vowels = shuffled(rng.pick(VOWEL_SETS), rng);
  const sibilants = shuffled(rng.pick(SIBILANT_SETS), rng);
  const liquids = shuffled(rng.pick(LIQUID_SETS), rng);
  const finals = shuffled(rng.pick(FINAL_SETS), rng);
  const structure: string = rng.pick(STRUCTURES);
  const cOrtho = rng.pick(CONSONANT_ORTHO);
  const vOrtho = rng.pick(VOWEL_ORTHO);

  const ortho: Record<string, string> = {};
  const inventories = [consonants, vowels, sibilants, liquids, finals];
  for (let k = 0; k < inventories.length; k++) {
    const list = inventories[k];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (ortho[p] === undefined) ortho[p] = vOrtho[p] ?? cOrtho[p] ?? DEFAULT_ORTHO[p] ?? p;
    }
  }

  const morphemes: Record<MorphemeKind, string[]> = {
    city: [], river: [], lake: [], sea: [], mount: [], wood: [], realm: [], port: [],
  };
  const lang: Language = {
    consonants, vowels, sibilants, liquids, finals, structure, minSyl: 1, maxSyl: 1, ortho, morphemes, joiner: '',
  };

  // Syllable counts: two-slot templates start at 2; templates that spell long cap at 2 instead of 3.
  const slots = structure.replace(/\?/g, '').length;
  const cap = syllableWeight(lang) >= HEAVY_WEIGHT ? 2 : 3;
  let minSyl = rng.int(1, 2);
  if (slots <= 2) minSyl = 2;
  lang.minSyl = minSyl;
  lang.maxSyl = rng.int(Math.min(minSyl + 1, cap), cap);
  const uJoin = rng.next();
  const joiner = uJoin < 0.4 ? '' : uJoin < 0.8 ? ' ' : '-';
  lang.joiner = joiner;

  // Morphemes: 1-2 syllables, spelled, short enough to leave room for the core word, distinct across kinds.
  const maxMorpheme = joiner === '' ? 5 : 7;
  const digraphs = digraphsOf(lang);
  const used = new Set<string>();
  for (let k = 0; k < MORPHEME_KINDS.length; k++) {
    const list = morphemes[MORPHEME_KINDS[k]];
    const count = rng.int(3, 6);
    for (let i = 0; i < count; i++) {
      let m = '';
      for (let tries = 0; tries < MORPHEME_TRIES; tries++) {
        m = tidy(spell(lang, makeSyllables(lang, rng, rng.int(1, 2))));
        if (m.length >= 2 && m.length <= maxMorpheme && hasVowel(m) && !spellingBad(m, digraphs) && !used.has(m)) break;
      }
      used.add(m);
      list.push(m);
    }
  }
  return lang;
}

export function makeWord(lang: Language, rng: Rng, kind?: MorphemeKind): string {
  let morpheme = '';
  let prepend = false;
  if (kind !== undefined) {
    const list = lang.morphemes[kind];
    if (list !== undefined && list.length > 0 && rng.next() < ATTACH_P) {
      prepend = rng.next() < 0.5;
      morpheme = rng.pick(list);
    }
  }
  const glued = morpheme !== '' && lang.joiner === '';
  const maxLen = morpheme !== '' && !glued ? MAX_LEN_JOINED : MAX_LEN;
  const digraphs = digraphsOf(lang);
  let nsyl = rng.int(lang.minSyl, lang.maxSyl);
  let best = '';
  let bestScore = Infinity;
  for (let attempt = 0; attempt < WORD_ATTEMPTS; attempt++) {
    const core = tidy(spell(lang, makeSyllables(lang, rng, nsyl)));
    const name = assemble(core, morpheme, prepend, lang.joiner);
    let score = 0;
    if (core.length < MIN_CORE_LEN) score += MIN_CORE_LEN - core.length;
    if (name.length > maxLen) score += name.length - maxLen;
    if (!hasVowel(core)) score += 10;
    if (core === morpheme) score += 10;
    if (spellingBad(core, digraphs)) score += 2;
    if (glued && (joinBad(prepend ? morpheme : core, prepend ? core : morpheme) || spellingBad(name, digraphs))) score += 2;
    if (score === 0) return name;
    if (score < bestScore) {
      best = name;
      bestScore = score;
    }
    if (core.length < MIN_CORE_LEN) nsyl = Math.min(lang.maxSyl, nsyl + 1);
    else if (name.length > maxLen) nsyl = Math.max(lang.minSyl, nsyl - 1);
  }
  return best;
}
