/**
 * core/rng.ts — Stage 0. Seeded, forkable random streams.
 * seed string -> xmur3 (string hash to four 32-bit words) -> sfc32.
 * Every generation stage receives its own fork; per-entity randomness forks by stable id.
 * No RNG stream is ever shared across stages.
 */

export interface Rng {
  next(): number;                              // [0, 1)
  int(lo: number, hi: number): number;         // inclusive both ends
  float(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  gaussian(mean?: number, sd?: number): number;
  shuffle<T>(arr: T[]): T[];                   // in place, returns arr
  fork(label: string): Rng;                    // independent child stream
}

/** xmur3 string hash; returns a function that yields successive 32-bit words. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Final xmur3 state of a string as uint32. Stable across platforms. */
export function hash32(s: string): number {
  return xmur3(s)();
}

/** sfc32: small fast counter PRNG, 128-bit state, period ~2^128. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed: string): Rng {
  const h = xmur3(seed);
  const raw = sfc32(h(), h(), h(), h());
  // Discard a few outputs so closely related seeds decorrelate.
  for (let i = 0; i < 12; i++) raw();
  let spare: number | null = null;

  const rng: Rng = {
    next: raw,
    int(lo, hi) {
      return lo + Math.floor(raw() * (hi - lo + 1));
    },
    float(lo, hi) {
      return lo + raw() * (hi - lo);
    },
    pick(arr) {
      return arr[Math.floor(raw() * arr.length)];
    },
    gaussian(mean = 0, sd = 1) {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return mean + sd * v;
      }
      let u: number, v: number, s: number;
      do {
        u = raw() * 2 - 1;
        v = raw() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * m;
      return mean + sd * u * m;
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(raw() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
    fork(label) {
      return makeRng(seed + '/' + label);
    },
  };
  return rng;
}

/** fork(seed, 'names', 'river:3') === makeRng('seed/names/river:3'). */
export function fork(seed: string, ...labels: string[]): Rng {
  return makeRng([seed, ...labels].join('/'));
}
