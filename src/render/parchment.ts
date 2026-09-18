/**
 * render/parchment.ts — Render layers 1 (parchment) and 4 (biome tint): the two raster-sampled
 * offscreen canvases the painter composites. Both are built at OUTPUT (device) pixel size so grain
 * and tint softness are constant in millimetres across export scales, and both are cached in an LRU
 * of 4 entries keyed seed + 'x' + wPx + 'x' + hPx.
 *
 * RNG stream: fork(seed, 'ink', 'parchment'), consumed in this order:
 *   1. makeValueNoise2 builds its tables (one 256-entry shuffle + 256 floats);
 *   2. per speck: x, y, radius (3 floats), specks first;
 *   3. per fiber: x, y, angle, length, bend (5 floats).
 * Counts scale with wPx * hPx / (1024 * 768) and positions scale with the canvas, so the first N
 * specks and fibers sit at the same relative places at every export scale. tintCanvas draws no
 * randomness.
 *
 * Inputs:  parchmentCanvas: seed and the device-pixel size (the painter passes W * scale, H * scale).
 *          tintCanvas: the World (mesh, geo.r_water, geo.r_biome, params.width/height) and the same
 *          device-pixel size.
 * Outputs: parchmentCanvas: a wPx x hPx canvas — flat '#e9dcb8', a 3-octave value-noise grain at
 *          1/4 resolution multiplied in at alpha 0.35 (wavelength 48 device px at 1x, scaled by
 *          wPx / 1024), a radial vignette to rgba(80,50,20,0.25), ~400 dark specks (alpha 0.25) and
 *          ~150 faint fiber strokes (alpha 0.04). The painter drawImages it with the identity
 *          transform (setTransform(1,0,0,1,0,0)) at (0, 0).
 *          tintCanvas: a (wPx/4) x (hPx/4) canvas holding every land cell polygon filled with its
 *          BIOME_COLORS entry (one Path2D per biome, no outlines ever stroked), blurred by 2 px in
 *          that canvas's own px; transparent over water. The painter drawImages it scaled up to the
 *          full logical frame, clipped to the land path, at alpha 0.55 with 'multiply'.
 *
 * Coordinates are read only through cellPolygon (mesh/dualmesh.ts) into a shared Float32Array(64)
 * scratch; there is no per-cell allocation.
 */

import type { World } from '../core/types';
import { BIOMES } from '../core/types';
import { fork } from '../core/rng';
import { makeValueNoise2 } from '../core/noise';
import { cellPolygon } from '../mesh/dualmesh';
import { BIOME_COLORS } from '../gen/climate';

const PARCHMENT = '#e9dcb8';
const INK = '#2b2318';
const TWO_PI = Math.PI * 2;

const LRU_CAP = 4;
/** Reference output size: densities and the grain wavelength are specified at 1x of this. */
const REF_W = 1024;
const REF_H = 768;
/** Grain and tint are rasterised at 1 / this of the output size. */
const GRAIN_DIV = 4;
const TINT_DIV = 4;
const GRAIN_WAVELENGTH = 48;   // device px at 1x
const SPECKS_AT_1X = 400;
const FIBERS_AT_1X = 150;

// ---------------------------------------------------------------- caches

interface TintEntry { world: World; canvas: HTMLCanvasElement; }

const parchmentCache = new Map<string, HTMLCanvasElement>();
const tintCache = new Map<string, TintEntry>();
/** Shared cellPolygon scratch: 32 corners is always enough for an interior cell. */
const POLY = new Float32Array(64);

function cacheKey(seed: string, wPx: number, hPx: number): string {
  return seed + 'x' + wPx + 'x' + hPx;
}

/** Map-backed LRU: a hit is re-inserted so insertion order is recency order. */
function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > LRU_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('parchment: could not create a 2d context');
  return { canvas, ctx };
}

// ---------------------------------------------------------------- layer 1: parchment

/** Cached wPx x hPx device-pixel parchment sheet for this seed. */
export function parchmentCanvas(seed: string, wPx: number, hPx: number): HTMLCanvasElement {
  const w = Math.max(1, Math.round(wPx));
  const h = Math.max(1, Math.round(hPx));
  const key = cacheKey(seed, w, h);
  const hit = lruGet(parchmentCache, key);
  if (hit !== undefined) return hit;

  const rng = fork(seed, 'ink', 'parchment');
  // device px per 1x px: keeps the grain wavelength, speck size and fiber length constant in mm
  const k = w / REF_W;
  const { canvas, ctx } = makeCanvas(w, h);

  // 1. flat sheet
  ctx.fillStyle = PARCHMENT;
  ctx.fillRect(0, 0, w, h);

  // 2. value-noise grain at 1/4 resolution, multiplied in. The lattice spacing is the wavelength;
  //    three octaves at 1x / 2x / 4x frequency with offsets so their lattices do not line up.
  const noise = makeValueNoise2(rng);
  const gw = Math.max(1, Math.ceil(w / GRAIN_DIV));
  const gh = Math.max(1, Math.ceil(h / GRAIN_DIV));
  const grain = makeCanvas(gw, gh);
  const img = grain.ctx.createImageData(gw, gh);
  const px = img.data;
  const inv = GRAIN_DIV / (GRAIN_WAVELENGTH * k);   // lattice units per grain px
  let i = 0;
  for (let gy = 0; gy < gh; gy++) {
    const fy = gy * inv;
    for (let gx = 0; gx < gw; gx++) {
      const fx = gx * inv;
      const v = (noise(fx, fy)
        + 0.5 * noise(fx * 2 + 17.3, fy * 2 + 9.1)
        + 0.25 * noise(fx * 4 + 41.7, fy * 4 + 23.9)) / 1.75;
      const g = 218 + 48 * v;   // Uint8ClampedArray rounds and clamps
      px[i] = g;
      px[i + 1] = g;
      px[i + 2] = g;
      px[i + 3] = 255;
      i += 4;
    }
  }
  grain.ctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.35;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(grain.canvas, 0, 0, gw, gh, 0, 0, w, h);
  ctx.restore();

  // 3. radial vignette: clear at 35% of the corner distance, rgba(80,50,20,0.25) at the corners
  const cx = w / 2;
  const cy = h / 2;
  const rCorner = Math.sqrt(cx * cx + cy * cy);
  const vignette = ctx.createRadialGradient(cx, cy, rCorner * 0.35, cx, cy, rCorner);
  vignette.addColorStop(0, 'rgba(80,50,20,0)');
  vignette.addColorStop(1, 'rgba(80,50,20,0.25)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  // 4. specks: one path of tiny discs, filled once
  const density = (w * h) / (REF_W * REF_H);
  const nSpecks = Math.round(SPECKS_AT_1X * density);
  ctx.save();
  ctx.fillStyle = INK;
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  for (let s = 0; s < nSpecks; s++) {
    const x = rng.float(0, w);
    const y = rng.float(0, h);
    const r = rng.float(0.5, 1.5) * k;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TWO_PI);
  }
  ctx.fill();

  // 5. fibers: short, slightly curved strokes, stroked once
  const nFibers = Math.round(FIBERS_AT_1X * density);
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.04;
  ctx.lineWidth = Math.max(0.6, 0.8 * k);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let f = 0; f < nFibers; f++) {
    const x0 = rng.float(0, w);
    const y0 = rng.float(0, h);
    const a = rng.float(0, TWO_PI);
    const len = rng.float(20, 60) * k;
    const bend = rng.float(-0.12, 0.12) * len;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const x1 = x0 + dx * len;
    const y1 = y0 + dy * len;
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2 - dy * bend, (y0 + y1) / 2 + dx * bend, x1, y1);
  }
  ctx.stroke();
  ctx.restore();

  lruSet(parchmentCache, key, canvas);
  return canvas;
}

// ---------------------------------------------------------------- layer 4: biome tint

/** Cached (wPx/4) x (hPx/4) blurred biome tint for this world. The cache key is the seed and size;
 *  the entry also remembers the World object and is rebuilt if a different World (same seed,
 *  different params) comes in. */
export function tintCanvas(world: World, wPx: number, hPx: number): HTMLCanvasElement {
  const w = Math.max(1, Math.round(wPx));
  const h = Math.max(1, Math.round(hPx));
  const key = cacheKey(world.seed, w, h);
  const hit = lruGet(tintCache, key);
  if (hit !== undefined && hit.world === world) return hit.canvas;

  const qw = Math.max(1, Math.round(w / TINT_DIV));
  const qh = Math.max(1, Math.round(h / TINT_DIV));
  const { mesh, geo, params } = world;
  const r_water = geo.r_water;
  const r_biome = geo.r_biome;

  // flat per-cell fill in logical px; one Path2D per biome so each colour is filled exactly once
  // and same-biome neighbours share one fill (no antialiasing seams between them)
  const flat = makeCanvas(qw, qh);
  const fctx = flat.ctx;
  fctx.scale(qw / params.width, qh / params.height);
  const paths: (Path2D | null)[] = [];
  for (let b = 0; b < BIOMES.length; b++) paths.push(null);
  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    if (r_water[r] !== 0) continue;
    const b = r_biome[r];
    if (b >= BIOMES.length) continue;
    const n = cellPolygon(mesh, r, POLY);
    if (n < 3) continue;
    let p = paths[b];
    if (p === null) {
      p = new Path2D();
      paths[b] = p;
    }
    p.moveTo(POLY[0], POLY[1]);
    for (let i = 1; i < n; i++) p.lineTo(POLY[2 * i], POLY[2 * i + 1]);
    p.closePath();
  }
  for (let b = 0; b < BIOMES.length; b++) {
    const p = paths[b];
    if (p === null) continue;
    fctx.fillStyle = BIOME_COLORS[BIOMES[b]];
    fctx.fill(p);
  }

  // blur: ctx.filter applies to drawImage, so draw the flat canvas onto a second one
  const blurred = makeCanvas(qw, qh);
  const bctx = blurred.ctx;
  if ('filter' in bctx) bctx.filter = 'blur(2px)';
  bctx.drawImage(flat.canvas, 0, 0);

  lruSet(tintCache, key, { world, canvas: blurred.canvas });
  return blurred.canvas;
}
