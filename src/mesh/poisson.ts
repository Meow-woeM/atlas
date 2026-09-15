/**
 * mesh/poisson.ts — Stage 1 (Points).
 * RNG stream: `points` (the caller passes fork(seed, 'points')).
 * Inputs: WorldParams (width, height, cellSpacing) and an Rng.
 * Outputs: xy-interleaved Float64Array of cell centers, boundary ring FIRST, plus numBoundary.
 *
 * Bridson Poisson-disc sampling: radius r, k = 30 candidates per active point, background grid
 * of cell size r / sqrt(2) so each grid cell holds at most one sample. RNG consumption order
 * (frozen; changing it is a params.version bump):
 *   1. first sample: rng.float(0, W), rng.float(0, H)
 *   2. per iteration: rng.int(0, active.length - 1) picks the active point, then for each of the
 *      k candidates: rng.float(0, 2*PI) angle, rng.float(r, 2r) radius. The candidate loop stops
 *      early at the first accepted candidate.
 * The boundary ring consumes no randomness.
 */

import type { Rng } from '../core/rng';
import type { WorldParams } from '../core/types';

const TWO_PI = Math.PI * 2;

/** Bridson Poisson-disc sampling in [0, width) x [0, height). Returns xy interleaved. */
export function poissonDisc(width: number, height: number, r: number, rng: Rng, k = 30): Float64Array {
  const cellSize = r / Math.SQRT2;
  const gw = Math.ceil(width / cellSize) + 1;
  const gh = Math.ceil(height / cellSize) + 1;
  const grid = new Int32Array(gw * gh).fill(-1);
  const r2 = r * r;

  // Upper bound on samples: one per grid cell.
  let xs = new Float64Array(gw * gh * 2);
  let n = 0;
  const active: number[] = [];

  const gridIndex = (x: number, y: number): number =>
    Math.floor(y / cellSize) * gw + Math.floor(x / cellSize);

  const fits = (x: number, y: number): boolean => {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    const x0 = Math.max(gx - 2, 0), x1 = Math.min(gx + 2, gw - 1);
    const y0 = Math.max(gy - 2, 0), y1 = Math.min(gy + 2, gh - 1);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const j = grid[yy * gw + xx];
        if (j >= 0) {
          const dx = xs[2 * j] - x;
          const dy = xs[2 * j + 1] - y;
          if (dx * dx + dy * dy < r2) return false;
        }
      }
    }
    return true;
  };

  const add = (x: number, y: number): void => {
    if (2 * n + 1 >= xs.length) {
      const bigger = new Float64Array(xs.length * 2);
      bigger.set(xs);
      xs = bigger;
    }
    xs[2 * n] = x;
    xs[2 * n + 1] = y;
    grid[gridIndex(x, y)] = n;
    active.push(n);
    n++;
  };

  add(rng.float(0, width), rng.float(0, height));

  while (active.length > 0) {
    const ai = rng.int(0, active.length - 1);
    const p = active[ai];
    const px = xs[2 * p], py = xs[2 * p + 1];
    let found = false;
    for (let c = 0; c < k; c++) {
      const angle = rng.float(0, TWO_PI);
      const radius = rng.float(r, 2 * r);
      const x = px + radius * Math.cos(angle);
      const y = py + radius * Math.sin(angle);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (fits(x, y)) {
        add(x, y);
        found = true;
        break;
      }
    }
    if (!found) {
      // Swap-remove keeps this O(1); order of the active list is part of the RNG contract.
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }

  return xs.slice(0, 2 * n);
}

/** Points at spacing ~r along the rectangle 2r outside [0,width]x[0,height], corners included once.
 *  Order: top edge left->right, right edge top->bottom, bottom edge right->left, left edge bottom->top. */
export function boundaryRing(width: number, height: number, r: number): Float64Array {
  const x0 = -2 * r, y0 = -2 * r;
  const x1 = width + 2 * r, y1 = height + 2 * r;
  const nx = Math.max(1, Math.round((x1 - x0) / r));
  const ny = Math.max(1, Math.round((y1 - y0) / r));
  const dx = (x1 - x0) / nx;
  const dy = (y1 - y0) / ny;
  const count = 2 * nx + 2 * ny;
  const out = new Float64Array(count * 2);
  let i = 0;
  for (let j = 0; j < nx; j++) { out[i++] = x0 + j * dx; out[i++] = y0; }
  for (let j = 0; j < ny; j++) { out[i++] = x1; out[i++] = y0 + j * dy; }
  for (let j = 0; j < nx; j++) { out[i++] = x1 - j * dx; out[i++] = y1; }
  for (let j = 0; j < ny; j++) { out[i++] = x0; out[i++] = y1 - j * dy; }
  return out;
}

/** Ring points first (regions [0, numBoundary)), then Poisson-disc interior points. */
export function generatePoints(params: WorldParams, rng: Rng): { points: Float64Array; numBoundary: number } {
  const ring = boundaryRing(params.width, params.height, params.cellSpacing);
  const interior = poissonDisc(params.width, params.height, params.cellSpacing, rng, 30);
  const points = new Float64Array(ring.length + interior.length);
  points.set(ring, 0);
  points.set(interior, ring.length);
  return { points, numBoundary: ring.length / 2 };
}
