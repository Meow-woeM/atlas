/**
 * gen/elevation.ts — Stage 4 (Elevation) and stage 5 (Distance field).
 *
 * RNG stream: `elevation` (the caller passes fork(seed, 'elevation') to computeElevation; the
 * distance field draws nothing). Consumption order, frozen (changing it is a params.version bump):
 *   1. makeSimplex3(rng)                    — the 256-entry permutation shuffle (255 draws).
 *   2. domain-warp offsets                  — 9 x rng.float(-100, 100): o1.xyz, o2.xyz, o3.xyz.
 *   3. continent blobs, i = 0..continents-1 — per blob, in order: rng.float(cx range),
 *                                             rng.float(cy range), rng.float(0.8, 1.2) sigma factor.
 *
 * Inputs:  Mesh, WorldParams (frame, width/height, continents, landFraction, rasterScale).
 * Outputs: ElevationResult (r_elevation, r_water, r_coastHops, r_slope, r_lat, r_lon) and, from
 *          computeDistanceField, { distField, r_coastDist }.
 *
 * Stage 4, exactly as ARCHITECTURE.md section 5 lists it:
 *   1. r_lat / r_lon through cellLatLon; the noise position is cellUnitVector(r) (the unit sphere).
 *   2. 3D simplex + 6-octave fBm (lacunarity 2, gain 0.5). Frequency: the frame spans
 *      |lon1 - lon0| degrees; the unit-sphere chord subtending that angle is 2 sin(span / 2), and
 *      the base wavelength (~1 noise unit) is set to a third of that chord. Domain-warped once:
 *      p' = p + 0.08 (fbm4(p + o1), fbm4(p + o2), fbm4(p + o3)) with 4-octave warps, so a cell
 *      costs 3 x 4 + 6 = 18 simplex evaluations. fbm is min-max normalized over interior cells
 *      to 0..1 before mixing.
 *   3. Continent mask: params.continents Gaussian blobs, max-combined. Blob i's center lies in
 *      the i-th vertical slice of the inner 70% of the canvas (so two continents read as two),
 *      sigma = 0.28 / sqrt(continents) * min(W, H) * U(0.8, 1.2). An edge falloff (0 within
 *      MARGIN = 40 px of the rectangle, smoothstep up to 1 by MARGIN + ramp) multiplies the whole
 *      raw height — not only the mask term — which is what makes the >= 40 px ocean margin a
 *      guarantee rather than a tendency: raw = (0.65 fbmN + 0.35 blobs) * falloff.
 *   4. sea = quantile(raw over interior cells, 1 - landFraction); r_water = raw < sea ? 1 : 0;
 *      the boundary ring is forced to water.
 *   5. Ocean flood fill (BFS) from the ring across water cells: reached = 1 (ocean); unreached
 *      water = 2 (lake candidate; hydrology confirms or reverts it).
 *   6. r_coastHops: multi-source BFS from ocean cells over every cell (0 on ocean, >= 1 else).
 *   7. Reshape: land cells ranked by raw (index sort, index tie-break), rankNorm in [0, 1];
 *      r_elevation = 0.55 rankNorm^1.5 + 0.45 (hops / maxHops)^0.8. Water cells get
 *      -(sea - raw) / sea clamped to [-1, -1e-4] so water is strictly negative.
 *   8. r_slope = max |r_elevation[r] - r_elevation[nbr]| over the neighbors.
 *
 * Stage 5: rasterizeCells(mask) at params.rasterScale, where the mask is 1 for every cell with
 * r_water !== 1 (land AND inland water: lake candidates now, hydrology's lakes later) and 0 for
 * ocean, so the field measures distance to the OCEAN coastline only. Rationale: hydrology
 * (stage 7) confirms or reverts lake candidates and creates new lakes after this stage; with an
 * ocean-only mask none of those decisions invalidates distField / r_coastDist, and r_coastDist
 * keeps its documented meaning (signed logical px to the coastline: + inland, including on lake
 * cells, - offshore). edt -> signed raster px, scaled IN PLACE to logical px (WATERLINE_ISOS are
 * logical px offshore), then r_coastDist = bilinear sample at the cell position. Cell positions
 * everywhere in this file are the average of the cellPolygon corners (never mesh.r_x / r_y).
 * Boundary-ring cells lie outside the raster and get r_coastDist = -1000.
 */

import type { Rng } from '../core/rng';
import type { Mesh, Raster, WorldParams } from '../core/types';
import { makeSimplex3, fbm3 } from '../core/noise';
import { quantile } from '../core/geom';
import { makeRaster, rasterizeCells, edt, sampleBilinear } from '../core/raster';
import { cellLatLon, cellUnitVector, cellPolygon, r_circulate_r } from '../mesh/dualmesh';

export interface ElevationResult {
  r_elevation: Float32Array; r_water: Uint8Array; r_coastHops: Int16Array; r_slope: Float32Array;
  r_lat: Float32Array; r_lon: Float32Array;
}

/** Ocean margin guaranteed inside the rectangle, logical px. */
const MARGIN = 40;
/** Domain-warp amplitude in noise units (ARCHITECTURE.md stage 4 step 2). */
const WARP = 0.08;
/** Water elevation ceiling: strictly below sea level. */
const WATER_EPS = -1e-4;
/** r_coastDist for boundary-ring cells (outside the raster). */
const RING_COAST_DIST = -1000;

/** Cell positions as the average of the cellPolygon corners (the sanctioned way to get one). */
function cellPositions(mesh: Mesh): { r_px: Float32Array; r_py: Float32Array } {
  const n = mesh.numRegions;
  const r_px = new Float32Array(n);
  const r_py = new Float32Array(n);
  const poly = new Float32Array(64);
  for (let r = 0; r < n; r++) {
    const k = cellPolygon(mesh, r, poly);
    if (k === 0) continue;
    let sx = 0, sy = 0;
    for (let i = 0; i < k; i++) {
      sx += poly[2 * i];
      sy += poly[2 * i + 1];
    }
    r_px[r] = sx / k;
    r_py[r] = sy / k;
  }
  return { r_px, r_py };
}

function smoothstep(t: number): number {
  const s = t < 0 ? 0 : t > 1 ? 1 : t;
  return s * s * (3 - 2 * s);
}

export function computeElevation(mesh: Mesh, params: WorldParams, rng: Rng): ElevationResult {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const W = params.width, H = params.height;
  const nbrs: number[] = [];

  // ---- 1. lat / lon
  const r_lat = new Float32Array(n);
  const r_lon = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const ll = cellLatLon(mesh, params, r);
    r_lat[r] = ll[0];
    r_lon[r] = ll[1];
  }

  // ---- 2. noise on the sphere (RNG draws 1 and 2)
  const simplex = makeSimplex3(rng);
  const off = new Float64Array(9);
  for (let i = 0; i < 9; i++) off[i] = rng.float(-100, 100);

  const span = Math.abs(params.frame.lon1 - params.frame.lon0) * (Math.PI / 180);
  const chord = 2 * Math.sin(Math.min(span, Math.PI) / 2);
  const freq = 3 / (chord > 1e-6 ? chord : 1e-6);

  const raw = new Float32Array(n);
  const v = new Float64Array(3);
  let fMin = Infinity, fMax = -Infinity;
  for (let r = 0; r < n; r++) {
    cellUnitVector(mesh, params, r, v);
    const px = v[0] * freq, py = v[1] * freq, pz = v[2] * freq;
    const wx = fbm3(simplex, px + off[0], py + off[1], pz + off[2], 4, 2, 0.5);
    const wy = fbm3(simplex, px + off[3], py + off[4], pz + off[5], 4, 2, 0.5);
    const wz = fbm3(simplex, px + off[6], py + off[7], pz + off[8], 4, 2, 0.5);
    const f = fbm3(simplex, px + WARP * wx, py + WARP * wy, pz + WARP * wz, 6, 2, 0.5);
    raw[r] = f;
    if (r >= nb) {
      if (f < fMin) fMin = f;
      if (f > fMax) fMax = f;
    }
  }
  const fScale = fMax > fMin ? 1 / (fMax - fMin) : 0;

  // ---- 3. continent mask (RNG draw 3) and edge falloff
  const { r_px, r_py } = cellPositions(mesh);
  const numBlobs = params.continents;
  const blobX = new Float64Array(numBlobs);
  const blobY = new Float64Array(numBlobs);
  const blobInv2s2 = new Float64Array(numBlobs);
  const innerX0 = 0.15 * W, innerX1 = 0.85 * W;
  const slice = (innerX1 - innerX0) / numBlobs;
  const sigmaBase = (0.28 / Math.sqrt(numBlobs)) * Math.min(W, H);
  for (let i = 0; i < numBlobs; i++) {
    blobX[i] = rng.float(innerX0 + i * slice, innerX0 + (i + 1) * slice);
    blobY[i] = rng.float(0.15 * H, 0.85 * H);
    const sigma = sigmaBase * rng.float(0.8, 1.2);
    blobInv2s2[i] = 1 / (2 * sigma * sigma);
  }
  const ramp = Math.max(40, Math.min(100, 0.12 * Math.min(W, H)));
  const invRamp = 1 / ramp;

  for (let r = 0; r < n; r++) {
    const x = r_px[r], y = r_py[r];
    let blob = 0;
    for (let i = 0; i < numBlobs; i++) {
      const dx = x - blobX[i], dy = y - blobY[i];
      const g = Math.exp(-(dx * dx + dy * dy) * blobInv2s2[i]);
      if (g > blob) blob = g;
    }
    const de = Math.min(x, W - x, y, H - y);
    const falloff = smoothstep((de - MARGIN) * invRamp);
    const fbmN = (raw[r] - fMin) * fScale;
    raw[r] = (0.65 * fbmN + 0.35 * blob) * falloff;
  }

  // ---- 4. sea level by quantile over interior cells
  const sea = quantile(raw.subarray(nb), 1 - params.landFraction);
  const r_water = new Uint8Array(n);
  for (let r = 0; r < n; r++) r_water[r] = r < nb || raw[r] < sea ? 1 : 0;

  // ---- 5. ocean flood fill from the ring across water cells
  const queue = new Int32Array(n);
  const seen = new Uint8Array(n);
  let head = 0, tail = 0;
  for (let r = 0; r < nb; r++) {
    seen[r] = 1;
    queue[tail++] = r;
  }
  while (head < tail) {
    const r = queue[head++];
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const q = nbrs[i];
      if (seen[q] === 0 && r_water[q] !== 0) {
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
  }
  for (let r = nb; r < n; r++) if (r_water[r] !== 0 && seen[r] === 0) r_water[r] = 2;

  // ---- 6. coast hops: multi-source BFS from ocean cells over every cell
  const r_coastHops = new Int16Array(n).fill(-1);
  head = 0; tail = 0;
  for (let r = 0; r < n; r++) {
    if (r_water[r] === 1) {
      r_coastHops[r] = 0;
      queue[tail++] = r;
    }
  }
  while (head < tail) {
    const r = queue[head++];
    const h = r_coastHops[r] + 1;
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const q = nbrs[i];
      if (r_coastHops[q] < 0) {
        r_coastHops[q] = h;
        queue[tail++] = q;
      }
    }
  }
  for (let r = 0; r < n; r++) if (r_coastHops[r] < 0) r_coastHops[r] = 1;   // unreachable: never on a connected mesh

  // ---- 7. reshape
  let numLand = 0;
  for (let r = 0; r < n; r++) if (r_water[r] === 0) numLand++;
  const land = new Int32Array(numLand);
  let maxHops = 1;
  for (let r = 0, k = 0; r < n; r++) {
    if (r_water[r] === 0) {
      land[k++] = r;
      if (r_coastHops[r] > maxHops) maxHops = r_coastHops[r];
    }
  }
  land.sort((a, b) => raw[a] - raw[b] || a - b);
  const r_elevation = new Float32Array(n);
  const rankDen = numLand > 1 ? 1 / (numLand - 1) : 1;
  const invMaxHops = 1 / maxHops;
  for (let k = 0; k < numLand; k++) {
    const r = land[k];
    const rankNorm = k * rankDen;
    r_elevation[r] = 0.55 * Math.pow(rankNorm, 1.5) + 0.45 * Math.pow(r_coastHops[r] * invMaxHops, 0.8);
  }
  const invSea = sea > 0 ? 1 / sea : 0;
  for (let r = 0; r < n; r++) {
    if (r_water[r] === 0) continue;
    let e = sea > 0 ? -(sea - raw[r]) * invSea : -1;
    if (e < -1) e = -1;
    if (e > WATER_EPS) e = WATER_EPS;
    r_elevation[r] = e;
  }

  // ---- 8. slope
  const r_slope = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const e = r_elevation[r];
    let m = 0;
    r_circulate_r(mesh, r, nbrs);
    for (let i = 0; i < nbrs.length; i++) {
      const d = Math.abs(e - r_elevation[nbrs[i]]);
      if (d > m) m = d;
    }
    r_slope[r] = m;
  }

  return { r_elevation, r_water, r_coastHops, r_slope, r_lat, r_lon };
}

export function computeDistanceField(
  mesh: Mesh, params: WorldParams, r_water: Uint8Array,
): { distField: Raster; r_coastDist: Float32Array } {
  const n = mesh.numRegions;
  const nb = mesh.numBoundaryRegions;
  const rs = params.rasterScale;
  const w = Math.round(params.width * rs);
  const h = Math.round(params.height * rs);

  const mask = makeRaster(w, h, rs);
  // 1 on land and inland water (everything that is not ocean), 0 on ocean: see the file comment.
  const r_land = new Float32Array(n);
  for (let r = 0; r < n; r++) r_land[r] = r_water[r] === 1 ? 0 : 1;
  rasterizeCells(mesh, r_land, mask);

  const distField = edt(mask, mask);
  const inv = 1 / rs;
  const data = distField.data;
  for (let p = 0; p < data.length; p++) data[p] *= inv;

  const { r_px, r_py } = cellPositions(mesh);
  const r_coastDist = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    r_coastDist[r] = r < nb ? RING_COAST_DIST : sampleBilinear(distField, r_px[r], r_py[r]);
  }
  return { distField, r_coastDist };
}
