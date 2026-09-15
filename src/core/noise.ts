/**
 * core/noise.ts — Stage 0 helper (no stage of its own): seeded, deterministic noise fields.
 * RNG stream: whatever the caller passes in (elevation forks 'elevation', the renderer forks
 * 'ink/<layer>'). Each make* consumes the stream ONCE, while building its tables; the returned
 * function is pure and never touches the Rng again.
 * Inputs: an Rng. Outputs: Noise3 / Noise2 / Noise1 functions with range -1..1.
 *
 * - makeSimplex3: classic 3D simplex noise (Gustavson) over a 256-entry permutation table
 *   shuffled by rng.shuffle. Elevation samples it on the unit sphere (cellUnitVector) so a
 *   future planet mode shares the same field.
 * - fbm3: fractal Brownian motion over a Noise3 with lacunarity/gain, normalized to -1..1.
 * - makeValueNoise2 / makeValueNoise1: lattice value noise with quintic interpolation; the 2D
 *   variant tiles with the given period (lattice units), used for the parchment grain.
 */

import type { Rng } from './rng';

export type Noise3 = (x: number, y: number, z: number) => number;   // -1..1
export type Noise2 = (x: number, y: number) => number;              // -1..1
export type Noise1 = (t: number) => number;                         // -1..1

// ---------------------------------------------------------------- shared helpers

/** 0..255 shuffled by the rng, then doubled so perm[i + 256] === perm[i] (no masking on reads). */
function shuffledPerm(rng: Rng): Uint8Array {
  const base: number[] = [];
  for (let i = 0; i < 256; i++) base.push(i);
  rng.shuffle(base);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  return perm;
}

/** Quintic fade: zero first and second derivative at 0 and 1 (the improved Perlin curve). */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Positive modulo for lattice wrapping. */
function wrap(i: number, period: number): number {
  const m = i % period;
  return m < 0 ? m + period : m;
}

// ---------------------------------------------------------------- 3D simplex

/** The 12 edge-midpoint gradients of a cube, xyz interleaved. */
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

/**
 * Classic 3D simplex noise (Stefan Gustavson, "Simplex noise demystified"), with the
 * permutation table shuffled by the rng. Output is in -1..1 (empirical extremes are about
 * +-0.87 at the standard 32x scale). Consumes the rng once, while building the table.
 */
export function makeSimplex3(rng: Rng): Noise3 {
  const perm = shuffledPerm(rng);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) permMod12[i] = perm[i] % 12;

  return (xin, yin, zin) => {
    // Skew the input space to find the simplex cell we are in.
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    // Unskewed distances from the cell origin.
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // Which of the six tetrahedra are we in? Offsets of the second and third corners.
    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }        // X Y Z
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }   // X Z Y
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }                 // Z X Y
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }         // Z Y X
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }    // Y Z X
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }                 // Y X Z
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }

    // 32 scales the sum into -1..1.
    return 32 * n;
  };
}

/**
 * Fractal Brownian motion: octaves of n at increasing frequency (x lacunarity) and decreasing
 * amplitude (x gain), normalized by the total amplitude so the result stays in -1..1.
 * Elevation uses 6 octaves, lacunarity 2, gain 0.5.
 */
export function fbm3(
  n: Noise3, x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n(x * f, y * f, z * f);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

// ---------------------------------------------------------------- lattice value noise

/**
 * 2D lattice value noise with quintic interpolation. Lattice values are uniform in -1..1 so
 * the output is in -1..1. When period (a positive integer, in lattice units) is given, the
 * lattice wraps: n(x + period, y) === n(x, y + period) === n(x, y). Without a period the
 * lattice hashes through a 256-entry permutation table (it repeats every 256 units).
 * Consumes the rng once, while building the tables.
 */
export function makeValueNoise2(rng: Rng, period?: number): Noise2 {
  const perm = shuffledPerm(rng);
  const values = new Float32Array(256);
  for (let i = 0; i < 256; i++) values[i] = rng.float(-1, 1);
  const p = period !== undefined && period > 0 ? Math.max(1, Math.round(period)) : 0;

  const lattice = (ix: number, iy: number): number => {
    if (p > 0) {
      ix = wrap(ix, p);
      iy = wrap(iy, p);
    }
    return values[perm[(ix & 255) + perm[iy & 255]]];
  };

  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fade(fx);
    const uy = fade(fy);
    const v00 = lattice(ix, iy);
    const v10 = lattice(ix + 1, iy);
    const v01 = lattice(ix, iy + 1);
    const v11 = lattice(ix + 1, iy + 1);
    const a = v00 + (v10 - v00) * ux;
    const b = v01 + (v11 - v01) * ux;
    return a + (b - a) * uy;
  };
}

/**
 * 1D lattice value noise with quintic interpolation, output in -1..1. The lattice hashes
 * through a 256-entry permutation table (repeats every 256 units, far longer than any
 * polyline in wavelength units). Consumes the rng once, while building the tables.
 */
export function makeValueNoise1(rng: Rng): Noise1 {
  const perm = shuffledPerm(rng);
  const values = new Float32Array(256);
  for (let i = 0; i < 256; i++) values[i] = rng.float(-1, 1);

  return (t) => {
    const it = Math.floor(t);
    const ft = t - it;
    const u = fade(ft);
    const v0 = values[perm[it & 255]];
    const v1 = values[perm[(it + 1) & 255]];
    return v0 + (v1 - v0) * u;
  };
}
