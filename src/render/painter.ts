/**
 * render/painter.ts — Render (section 6): renderWorld and every layer of 6.2 except label
 * placement, which lives in ./labels and is called here for layer 12.
 *
 * RNG streams (all forked from world.seed so the screen and every export are the same picture):
 *   fork(seed, 'ink', 'stipple')  layer 3b  cells in ascending index (interior only); per ocean cell
 *                                          with -30 < r_coastDist < 0: per dot, pairs of next()
 *                                          (x then y, uniform in the polygon's bounding box) until
 *                                          the point is inside the cell polygon or 8 pairs are spent.
 *   fork(seed, 'ink', 'forests')  layer 6   odd land cells in ascending index: forest biome ->
 *                                          int(1,3) tree count, then per tree float(-2.5,2.5) x,
 *                                          float(-2.5,2.5) y, int(0,6) size step, int(0,3) variant;
 *                                          shrubland -> next() (< 0.5 keeps one tree), then the same
 *                                          4 draws for that tree; marsh -> float x, float y jitter.
 *   fork(seed, 'ink', 'relief')   layer 7   land cells in ascending index with elevation > 0.42:
 *                                          int(0,3) variant, float(-2,2) x, float(-2,2) y.
 *   fork(seed, 'ink', 'compass')  layer 14  handed to compassRose.
 * Layers 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13 consume no randomness here (the parchment and tint
 * canvases fork their own streams inside ./parchment).
 *
 * Inputs:  World, PoliticalView, a CanvasRenderingContext2D and RenderOptions.
 * Outputs: pixels on ctx. Nothing in World or PoliticalView is mutated.
 *
 * Transform contract (6.1): ctx.setTransform(scale, 0, 0, scale, 0, 0) is set once at the top and
 * every width, size and font below is in logical px. The parchment blit uses a temporary identity
 * transform inside save/restore. Glyphs are placed with translate(x, y) ... translate(-x, -y)
 * pairs; under a pure scale transform those are exact inverses, so no drift accumulates.
 *
 * Layer order drawn (back to front): 1 parchment, 2 ocean wash + land fill, 3 waterlines,
 * 3b stipple, 4 tint, 5 lakes, 6 forests/marsh, 7 relief, 8 rivers, 9 coastline, 10 borders
 * (+ provinces), 11 settlements, 13 graticule, 12 labels, 14 furniture. 13 is drawn before 12 on
 * purpose ("drawn under 12" in 6.2); 14 needs the placed label boxes to pick the compass corner.
 *
 * Offsets that the spec describes as "inner lines" (lake water lining, the double coast) are drawn
 * as concentric strokes under a clip: the inward half of a stroke of width 2d is an exact parallel
 * curve at distance d, so a wide ink stroke over-painted by a narrower parchment/lake stroke leaves
 * a thin ring at a fixed inset. The gap ring over-paints whatever lay underneath it (tint, a river
 * tip); at 1x that band is sub-pixel.
 */

import type {
  LayerToggles, Mesh, Polyline, PoliticalView, RenderOptions, World,
} from '../core/types';
import { BIOMES } from '../core/types';
import { fork } from '../core/rng';
import { pointInPolygon } from '../core/geom';
import { cellPolygon, s_end_r } from '../mesh/dualmesh';
import { chainSides } from '../mesh/noisy';
import { parchmentCanvas, tintCanvas } from './parchment';
import {
  anchorPath, cartouche, compassRose, frame, hillPath, marshPath, mountainPath,
  settlementPath, treePath,
} from './glyphs';
import { cssFont, drawLabels, fallbackStack, fontStack, placeLabels } from './labels';
import type { MeasureFn, PlacedLabel } from './labels';
import { worldTitle } from '../gen/names';

// ---------------------------------------------------------------- exports (section 7.1)

export const INK = '#2b2318';
export const SEA_INK = '#3b4a5a';
export const PARCHMENT = '#e9dcb8';

export const DEFAULT_LAYERS: LayerToggles = {
  tint: true, relief: true, forests: true, rivers: true, waterlines: true,
  stipple: false, borders: true, provinces: false, settlements: true, labels: true,
  grid: false, furniture: true,
};

// ---------------------------------------------------------------- constants

const OCEAN_WASH = '#d9cfae';
const LAKE_FILL = '#cfd6c4';
const RIVER_HIGHLIGHT = 'rgba(255,255,255,0.35)';

const WATERLINE_WIDTHS = [0.9, 0.7, 0.5, 0.4] as const;
const WATERLINE_ALPHAS = [0.55, 0.35, 0.2, 0.1] as const;

const B_TAIGA = BIOMES.indexOf('taiga');
const B_SHRUBLAND = BIOMES.indexOf('shrubland');
const B_TEMPERATE_RAINFOREST = BIOMES.indexOf('temperateRainforest');
const B_DECIDUOUS = BIOMES.indexOf('deciduousForest');
const B_TROPICAL_RAINFOREST = BIOMES.indexOf('tropicalRainforest');
const B_TROPICAL_SEASONAL = BIOMES.indexOf('tropicalSeasonalForest');
const B_MARSH = BIOMES.indexOf('marsh');

/** Glyph kinds recorded by the forest layer before the y-sort. */
const G_BROADLEAF = 0;
const G_CONIFER = 1;
const G_MARSH = 2;

const TREE_VARIANTS = 4;
const TREE_SIZE_STEPS = 7;          // 3.5 + 0.25 * step, step in 0..6 -> 3.5..5 px
const TREE_SIZE_MIN = 3.5;
const TREE_SIZE_STEP = 0.25;

const RELIEF_MOUNTAIN = 0.62;
const RELIEF_HILL = 0.42;

const RIVER_BINS = 16;
const RIVER_W0 = 0.6;
const RIVER_W1 = 1.6;

const POLY_CAP = 32;                // corners per cell the scratch polygon can hold
const CORNER_SQUARE = 160;
const COMPASS_RADIUS = 34;
const COMPASS_INSET = 60;
const SCALE_BAR_MAX_PX = 200;
const NICE_KM = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000] as const;

// ---------------------------------------------------------------- the paint bundle

interface Paint {
  ctx: CanvasRenderingContext2D;
  world: World;
  view: PoliticalView;
  opts: RenderOptions;
  W: number;
  H: number;
  /** All coast loops in one path (land is inside under 'evenodd'); built by the ocean layer. */
  landPath: Path2D | null;
  /** Frame rectangle plus the coast loops: ocean is inside under 'evenodd'. */
  oceanPath: Path2D | null;
  /** Reusable cellPolygon scratch and views of its prefix by corner count (no per-cell views). */
  poly: Float32Array;
  polyViews: Float32Array[];
  /** Output of cellCenter. */
  cx: number;
  cy: number;
  /** Labels placed by layer 12 (empty when the layer is off); layer 14 reads their boxes. */
  labels: PlacedLabel[];
}

function makePaint(world: World, view: PoliticalView, ctx: CanvasRenderingContext2D, opts: RenderOptions): Paint {
  const poly = new Float32Array(POLY_CAP * 2);
  const polyViews: Float32Array[] = [];
  for (let n = 0; n <= POLY_CAP; n++) polyViews.push(poly.subarray(0, 2 * n));
  return {
    ctx, world, view, opts,
    W: world.params.width, H: world.params.height,
    landPath: null, oceanPath: null,
    poly, polyViews, cx: 0, cy: 0,
    labels: [],
  };
}

/** Runs one layer inside save/restore so alpha, composite, clip, dash and font never leak, and
 *  rethrows anything it throws with the layer name in the message. */
function runLayer(p: Paint, name: string, draw: (p: Paint) => void): void {
  const ctx = p.ctx;
  ctx.save();
  try {
    draw(p);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error('renderWorld: layer "' + name + '": ' + msg, { cause: err });
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------- geometry helpers

function addPolyline(path: Path2D, pl: Polyline): void {
  const pts = pl.pts;
  const n = pts.length >> 1;
  if (n < 2) return;
  path.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) path.lineTo(pts[2 * i], pts[2 * i + 1]);
  if (pl.closed) path.closePath();
}

function polylinePath(pl: Polyline): Path2D {
  const path = new Path2D();
  addPolyline(path, pl);
  return path;
}

/** Appends the closed polygon of cell r to path. Returns false for degenerate cells. */
function addCell(path: Path2D, mesh: Mesh, r: number, poly: Float32Array): boolean {
  const n = cellPolygon(mesh, r, poly);
  if (n < 3) return false;
  path.moveTo(poly[0], poly[1]);
  for (let i = 1; i < n; i++) path.lineTo(poly[2 * i], poly[2 * i + 1]);
  path.closePath();
  return true;
}

/** Cell position = mean of the cellPolygon corners, into p.cx/p.cy; p.poly holds the corners.
 *  Returns the corner count (0 for a degenerate cell). */
function cellCenter(p: Paint, r: number): number {
  const n = cellPolygon(p.world.mesh, r, p.poly);
  if (n < 3) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sx += p.poly[2 * i];
    sy += p.poly[2 * i + 1];
  }
  p.cx = sx / n;
  p.cy = sy / n;
  return n;
}

/** Fills and/or strokes a glyph path with its origin moved to (x, y). */
function drawGlyphAt(ctx: CanvasRenderingContext2D, path: Path2D, x: number, y: number, fill: boolean, stroke: boolean): void {
  ctx.translate(x, y);
  if (fill) ctx.fill(path);
  if (stroke) ctx.stroke(path);
  ctx.translate(-x, -y);
}

function gridFont(opts: RenderOptions): string {
  return cssFont(8, opts.fontReady ? fontStack('text') : fallbackStack());
}

// ---------------------------------------------------------------- 1 parchment

function drawParchment(p: Paint): void {
  const { ctx, W, H, opts } = p;
  ctx.fillStyle = PARCHMENT;
  ctx.fillRect(0, 0, W, H);
  const pc = parchmentCanvas(p.world.seed, Math.round(W * opts.scale), Math.round(H * opts.scale));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(pc, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------- 2 ocean wash and land fill

function drawOcean(p: Paint): void {
  const { ctx, W, H } = p;
  ctx.fillStyle = OCEAN_WASH;
  ctx.fillRect(0, 0, W, H);
  const land = new Path2D();
  const coast = p.world.features.coast;
  for (let i = 0; i < coast.length; i++) addPolyline(land, coast[i]);
  p.landPath = land;
  const ocean = new Path2D();
  ocean.rect(0, 0, W, H);
  ocean.addPath(land);
  p.oceanPath = ocean;
  ctx.fillStyle = PARCHMENT;
  ctx.fill(land, 'evenodd');
}

// ---------------------------------------------------------------- 3 waterlines

function drawWaterlines(p: Paint): void {
  const { ctx } = p;
  const isos = p.world.features.waterlines;
  if (p.oceanPath !== null) ctx.clip(p.oceanPath, 'evenodd');
  ctx.strokeStyle = SEA_INK;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < isos.length && i < WATERLINE_WIDTHS.length; i++) {
    const lines = isos[i];
    if (lines.length === 0) continue;
    const path = new Path2D();
    for (let j = 0; j < lines.length; j++) addPolyline(path, lines[j]);
    ctx.lineWidth = WATERLINE_WIDTHS[i];
    ctx.globalAlpha = WATERLINE_ALPHAS[i];
    ctx.stroke(path);
  }
}

// ---------------------------------------------------------------- 3b stipple

function drawStipple(p: Paint): void {
  const { ctx, world } = p;
  const mesh = world.mesh;
  const r_water = world.geo.r_water;
  const r_coastDist = world.geo.r_coastDist;
  const rng = fork(world.seed, 'ink', 'stipple');
  if (p.oceanPath !== null) ctx.clip(p.oceanPath, 'evenodd');
  ctx.fillStyle = SEA_INK;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  const poly = p.poly;
  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    if (r_water[r] !== 1) continue;
    const d = r_coastDist[r];
    if (!(d > -30 && d < 0)) continue;
    const n = cellCenter(p, r);
    if (n === 0) continue;
    const count = Math.round(6 / (1 + (-d) / 6));
    if (count <= 0) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = poly[2 * i], y = poly[2 * i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const view = p.polyViews[n];
    for (let k = 0; k < count; k++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = x0 + rng.next() * (x1 - x0);
        const y = y0 + rng.next() * (y1 - y0);
        if (pointInPolygon(x, y, view)) {
          ctx.moveTo(x + 0.35, y);
          ctx.arc(x, y, 0.35, 0, Math.PI * 2);
          break;
        }
      }
    }
  }
  ctx.fill();
}

// ---------------------------------------------------------------- 4 biome tint

function drawTint(p: Paint): void {
  const { ctx, W, H, opts } = p;
  if (p.landPath === null) return;
  const tc = tintCanvas(p.world, Math.round(W * opts.scale), Math.round(H * opts.scale));
  ctx.clip(p.landPath, 'evenodd');
  ctx.globalAlpha = 0.55;
  ctx.globalCompositeOperation = 'multiply';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // tintCanvas is built for this output size (at 1/4 of it); drawing it into the W x H logical
  // frame under the scale transform stretches it to the full device-pixel frame.
  ctx.drawImage(tc, 0, 0, W, H);
}

// ---------------------------------------------------------------- 5 lakes

function drawLakes(p: Paint): void {
  const { ctx } = p;
  const lakes = p.world.features.lakes;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < lakes.length; i++) {
    const shore = lakes[i].shore;
    if (shore.pts.length < 6) continue;
    const path = polylinePath(shore);
    ctx.fillStyle = LAKE_FILL;
    ctx.fill(path);
    // Inner water line: concentric strokes under the lake clip. Measured inward from the shore:
    // 0..1 lake, 1..2.25 parchment halo, 2.25..2.75 ink (the 0.5 px line at ~2.5 px inset),
    // 2.75..4 parchment halo, then lake fill again.
    ctx.save();
    ctx.clip(path);
    ctx.strokeStyle = PARCHMENT;
    ctx.lineWidth = 8;
    ctx.stroke(path);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5.5;
    ctx.stroke(path);
    ctx.strokeStyle = PARCHMENT;
    ctx.lineWidth = 4.5;
    ctx.stroke(path);
    ctx.strokeStyle = LAKE_FILL;
    ctx.lineWidth = 2;
    ctx.stroke(path);
    ctx.restore();
    // Shore outline.
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.9;
    ctx.stroke(path);
  }
}

// ---------------------------------------------------------------- 6 forests and marsh

function drawForests(p: Paint): void {
  const { ctx, world } = p;
  const mesh = world.mesh;
  const r_water = world.geo.r_water;
  const r_biome = world.geo.r_biome;
  const r_elevation = world.geo.r_elevation;
  const rng = fork(world.seed, 'ink', 'forests');

  // Record every glyph first (rng in cell index order), then sort by y for painter's order.
  const gx: number[] = [];
  const gy: number[] = [];
  const gkind: number[] = [];
  const gvariant: number[] = [];
  const gstep: number[] = [];

  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    if ((r & 1) === 0) continue;
    if (r_water[r] !== 0) continue;
    const b = r_biome[r];
    let trees = 0;
    let kind = G_BROADLEAF;
    let small = false;
    if (b === B_TAIGA) {
      trees = rng.int(1, 3);
      kind = G_CONIFER;
    } else if (b === B_TEMPERATE_RAINFOREST) {
      trees = rng.int(1, 3);
      kind = r_elevation[r] > 0.5 ? G_CONIFER : G_BROADLEAF;
    } else if (b === B_DECIDUOUS || b === B_TROPICAL_RAINFOREST || b === B_TROPICAL_SEASONAL) {
      trees = rng.int(1, 3);
    } else if (b === B_SHRUBLAND) {
      if (rng.next() < 0.5) {
        trees = 1;
        small = true;
      }
    } else if (b === B_MARSH) {
      if (cellCenter(p, r) === 0) continue;
      gx.push(p.cx + rng.float(-2.5, 2.5));
      gy.push(p.cy + rng.float(-2.5, 2.5));
      gkind.push(G_MARSH);
      gvariant.push(0);
      gstep.push(0);
      continue;
    }
    if (trees === 0) continue;
    if (cellCenter(p, r) === 0) continue;
    for (let k = 0; k < trees; k++) {
      const jx = rng.float(-2.5, 2.5);
      const jy = rng.float(-2.5, 2.5);
      const step = rng.int(0, TREE_SIZE_STEPS - 1);
      const variant = rng.int(0, TREE_VARIANTS - 1);
      gx.push(p.cx + jx);
      gy.push(p.cy + jy);
      gkind.push(kind);
      gvariant.push(variant);
      gstep.push(small ? 0 : step);
    }
  }

  const count = gx.length;
  if (count === 0) return;
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => gy[a] - gy[b] || a - b);

  // Glyph paths are cached per (kind, variant, size step); sizes are quantized to 0.25 px so the
  // cache stays at 2 * 4 * 7 entries plus one marsh path.
  const cache: (Path2D | null)[] = new Array(2 * TREE_VARIANTS * TREE_SIZE_STEPS).fill(null);
  let marsh: Path2D | null = null;

  ctx.fillStyle = PARCHMENT;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.7;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const g = order[i];
    const kind = gkind[g];
    if (kind === G_MARSH) {
      if (marsh === null) marsh = marshPath(5);
      drawGlyphAt(ctx, marsh, gx[g], gy[g], false, true);
      continue;
    }
    const step = gstep[g];
    const key = (kind * TREE_VARIANTS + gvariant[g]) * TREE_SIZE_STEPS + step;
    let path = cache[key];
    if (path === null) {
      const size = TREE_SIZE_MIN + TREE_SIZE_STEP * step;
      path = treePath(kind === G_CONIFER ? 'conifer' : 'broadleaf', gvariant[g], size);
      cache[key] = path;
    }
    drawGlyphAt(ctx, path, gx[g], gy[g], true, true);
  }
}

// ---------------------------------------------------------------- 7 relief

function drawRelief(p: Paint): void {
  const { ctx, world } = p;
  const mesh = world.mesh;
  const r_water = world.geo.r_water;
  const r_elevation = world.geo.r_elevation;
  const rng = fork(world.seed, 'ink', 'relief');

  const gx: number[] = [];
  const gy: number[] = [];
  const gsize: number[] = [];
  const gvariant: number[] = [];
  const gmountain: number[] = [];

  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    if (r_water[r] !== 0) continue;
    const e = r_elevation[r];
    if (!(e > RELIEF_HILL)) continue;
    const variant = rng.int(0, 3);
    const jx = rng.float(-2, 2);
    const jy = rng.float(-2, 2);
    if (cellCenter(p, r) === 0) continue;
    gx.push(p.cx + jx);
    gy.push(p.cy + jy);
    gvariant.push(variant);
    if (e > RELIEF_MOUNTAIN) {
      gsize.push(8 + 16 * (Math.min(e, 1) - RELIEF_MOUNTAIN) / (1 - RELIEF_MOUNTAIN));
      gmountain.push(1);
    } else {
      gsize.push(5 + 6 * (e - RELIEF_HILL) / (RELIEF_MOUNTAIN - RELIEF_HILL));
      gmountain.push(0);
    }
  }

  const count = gx.length;
  if (count === 0) return;
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => gy[a] - gy[b] || a - b);

  ctx.fillStyle = PARCHMENT;
  ctx.strokeStyle = INK;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const g = order[i];
    if (gmountain[g] === 1) {
      ctx.lineWidth = 1.1;
      drawGlyphAt(ctx, mountainPath(gvariant[g], gsize[g]), gx[g], gy[g], true, true);
    } else {
      ctx.lineWidth = 0.8;
      drawGlyphAt(ctx, hillPath(gvariant[g], gsize[g]), gx[g], gy[g], false, true);
    }
  }
}

// ---------------------------------------------------------------- 8 rivers

/**
 * Width along a river is 0.6 + 1.6 * sqrt(fluxAlong / maxFlux) where fluxAlong is linear in arc
 * length from the flux carried by the river's first side (geo.s_river[sides[0]]) to the flux at
 * its mouth (rivers[i].flux). Widths are quantized into RIVER_BINS bins (0.1 px steps) and each bin
 * is one Path2D of the consecutive segments that fall in it, so the layer is 16 strokes instead of
 * one per segment; round caps hide the joints between bins.
 */
function drawRivers(p: Paint): void {
  const { ctx, world } = p;
  const rivers = world.features.rivers;
  const paths = world.features.riverPaths;
  const s_river = world.geo.s_river;

  let maxFlux = 0;
  for (let i = 0; i < rivers.length; i++) if (rivers[i].flux > maxFlux) maxFlux = rivers[i].flux;
  if (!(maxFlux > 0)) maxFlux = 1;

  const bins: (Path2D | null)[] = new Array(RIVER_BINS).fill(null);
  const all = new Path2D();
  let any = false;

  for (let i = 0; i < rivers.length && i < paths.length; i++) {
    const pl = paths[i];
    const pts = pl.pts;
    const n = pts.length >> 1;
    if (n < 2) continue;
    const rv = rivers[i];
    const f1 = rv.flux > 0 ? rv.flux : 0;
    let f0 = rv.sides.length > 0 ? s_river[rv.sides[0]] : f1 * 0.25;
    if (!(f0 >= 0)) f0 = 0;
    let total = 0;
    for (let j = 1; j < n; j++) {
      const dx = pts[2 * j] - pts[2 * j - 2];
      const dy = pts[2 * j + 1] - pts[2 * j - 1];
      total += Math.sqrt(dx * dx + dy * dy);
    }
    if (!(total > 0)) continue;
    addPolyline(all, pl);
    any = true;
    let arc = 0;
    let prevBin = -1;
    for (let j = 1; j < n; j++) {
      const ax = pts[2 * j - 2], ay = pts[2 * j - 1];
      const bx = pts[2 * j], by = pts[2 * j + 1];
      const d = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      const u = (arc + d * 0.5) / total;
      const f = f0 + (f1 - f0) * u;
      const w = RIVER_W0 + RIVER_W1 * Math.sqrt(f / maxFlux);
      let bin = Math.floor(((w - RIVER_W0) / RIVER_W1) * RIVER_BINS);
      if (bin < 0) bin = 0;
      if (bin >= RIVER_BINS) bin = RIVER_BINS - 1;
      let path = bins[bin];
      if (path === null) {
        path = new Path2D();
        bins[bin] = path;
      }
      if (bin !== prevBin) path.moveTo(ax, ay);
      path.lineTo(bx, by);
      prevBin = bin;
      arc += d;
    }
  }
  if (!any) return;

  ctx.strokeStyle = INK;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let b = 0; b < RIVER_BINS; b++) {
    const path = bins[b];
    if (path === null) continue;
    ctx.lineWidth = RIVER_W0 + RIVER_W1 * ((b + 0.5) / RIVER_BINS);
    ctx.stroke(path);
  }
  // Pen highlight: a faint light stroke offset 0.4 px up-left.
  ctx.save();
  ctx.translate(-0.4, -0.4);
  ctx.strokeStyle = RIVER_HIGHLIGHT;
  ctx.lineWidth = 0.4;
  ctx.stroke(all);
  ctx.restore();
}

// ---------------------------------------------------------------- 9 coastline

/**
 * Double-line coast: the main 1.5 px stroke at the edge plus a 0.5 px line ~1.25..1.75 px inland,
 * made by stroking the land path under the land clip at 3.5 px (ink) then 2.5 px (parchment):
 * only the inland halves show, leaving an ink ring at 1.25..1.75 and a parchment gap at 0.75..1.25.
 */
function drawCoast(p: Paint): void {
  const { ctx } = p;
  const land = p.landPath;
  if (land === null) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.save();
  ctx.clip(land, 'evenodd');
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 3.5;
  ctx.stroke(land);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PARCHMENT;
  ctx.lineWidth = 2.5;
  ctx.stroke(land);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5;
  ctx.stroke(land);
}

// ---------------------------------------------------------------- 10 borders and provinces

function drawBorders(p: Paint): void {
  const { ctx, world, view } = p;
  const mesh = world.mesh;
  const nations = world.politics.nations;
  const r_nation = world.politics.r_nation;
  const borders = view.borders;
  const borderNation = view.borderNation;
  if (borders.length === 0) return;

  // One Path2D per nation from its cells (single pass over the cells; nothing is cached).
  const nationPaths: (Path2D | null)[] = new Array(nations.length).fill(null);
  for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
    const n = r_nation[r];
    if (n < 0 || n >= nations.length) continue;
    let path = nationPaths[n];
    if (path === null) {
      path = new Path2D();
      nationPaths[n] = path;
    }
    addCell(path, mesh, r, p.poly);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let n = 0; n < nations.length; n++) {
    const clipPath = nationPaths[n];
    if (clipPath === null) continue;
    let glow: Path2D | null = null;
    for (let b = 0; b < borders.length && b < borderNation.length; b++) {
      if (borderNation[b] !== n) continue;
      if (glow === null) glow = new Path2D();
      addPolyline(glow, borders[b]);
    }
    if (glow === null) continue;
    ctx.save();
    ctx.clip(clipPath);
    ctx.strokeStyle = nations[n].color;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 9;
    ctx.stroke(glow);
    ctx.restore();
  }

  const all = new Path2D();
  for (let b = 0; b < borders.length; b++) addPolyline(all, borders[b]);
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.stroke(all);
}

function drawProvinces(p: Paint): void {
  const { ctx, world } = p;
  const mesh = world.mesh;
  const r_water = world.geo.r_water;
  const r_province = world.r_province;
  // Each undirected boundary once: the half-edge whose start province has the lower index.
  const lines = chainSides(mesh, world.edges, (s) => {
    if (mesh.s_opposite_s[s] < 0) return false;
    const a = mesh.s_start_r[s];
    const b = s_end_r(mesh, s);
    if (r_water[a] !== 0 || r_water[b] !== 0) return false;
    const pa = r_province[a], pb = r_province[b];
    return pa >= 0 && pb >= 0 && pa < pb;
  });
  if (lines.length === 0) return;
  const path = new Path2D();
  for (let i = 0; i < lines.length; i++) addPolyline(path, lines[i]);
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 0.5;
  ctx.lineCap = 'round';
  ctx.setLineDash([1, 2.5]);
  ctx.stroke(path);
}

// ---------------------------------------------------------------- 11 settlements

function drawSettlements(p: Paint): void {
  const { ctx, world } = p;
  const settlements = world.settlements;
  const nations = world.politics.nations;
  const isCapital = new Uint8Array(settlements.length);
  for (let i = 0; i < nations.length; i++) {
    const n = nations[i];
    if (n.died === -1 && n.capital >= 0 && n.capital < settlements.length) isCapital[n.capital] = 1;
  }
  ctx.fillStyle = PARCHMENT;
  ctx.strokeStyle = INK;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let anchor: Path2D | null = null;
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    if (s.died !== -1) continue;
    if (cellCenter(p, s.r) === 0) continue;
    const x = p.cx, y = p.cy;
    ctx.lineWidth = 0.9;
    drawGlyphAt(ctx, settlementPath(s.kind, isCapital[i] === 1), x, y, true, true);
    if (s.port) {
      if (anchor === null) anchor = anchorPath();
      ctx.lineWidth = 0.7;
      drawGlyphAt(ctx, anchor, x + 6, y + 6, false, true);
    }
  }
}

// ---------------------------------------------------------------- 12 labels

function drawLabelsLayer(p: Paint): void {
  const { ctx, world, view, opts } = p;
  const measure: MeasureFn = (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  const labels = placeLabels(world, view, measure, opts);
  p.labels = labels;
  drawLabels(ctx, labels);
}

// ---------------------------------------------------------------- 13 graticule

function degLabel(v: number, pos: string, neg: string): string {
  const a = Math.abs(v);
  if (a === 0) return '0°';
  return a + '°' + (v > 0 ? pos : neg);
}

function drawGraticule(p: Paint): void {
  const { ctx, W, H, opts } = p;
  const f = p.world.params.frame;
  const dLon = f.lon1 - f.lon0;
  const dLat = f.lat1 - f.lat0;
  if (dLon === 0 || dLat === 0) return;

  const lines = new Path2D();
  const labelX: number[] = [];
  const labelLon: number[] = [];
  const labelY: number[] = [];
  const labelLat: number[] = [];

  const lonMin = Math.min(f.lon0, f.lon1), lonMax = Math.max(f.lon0, f.lon1);
  for (let lon = Math.ceil(lonMin / 5) * 5; lon <= lonMax; lon += 5) {
    const x = ((lon - f.lon0) / dLon) * W;
    if (x < 1 || x > W - 1) continue;
    lines.moveTo(x, 0);
    lines.lineTo(x, H);
    labelX.push(x);
    labelLon.push(lon);
  }
  const latMin = Math.min(f.lat0, f.lat1), latMax = Math.max(f.lat0, f.lat1);
  for (let lat = Math.ceil(latMin / 5) * 5; lat <= latMax; lat += 5) {
    const y = ((lat - f.lat0) / dLat) * H;
    if (y < 1 || y > H - 1) continue;
    lines.moveTo(0, y);
    lines.lineTo(W, y);
    labelY.push(y);
    labelLat.push(lat);
  }

  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 0.4;
  ctx.lineCap = 'butt';
  ctx.stroke(lines);

  // Degree labels in the margin just inside the frame's inner line (inset 11; corner ornaments
  // reach 25): longitudes along the top edge above the cartouche (which starts at y = 20),
  // latitudes right-aligned along the right edge. Labels within 30 px of a corner are skipped.
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = INK;
  ctx.font = gridFont(opts);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = 0; i < labelX.length; i++) {
    const x = labelX[i];
    if (x < 30 || x > W - 30) continue;
    ctx.fillText(degLabel(labelLon[i], 'E', 'W'), x, 16);
  }
  ctx.textAlign = 'right';
  for (let i = 0; i < labelY.length; i++) {
    const y = labelY[i];
    if (y < 30 || y > H - 30) continue;
    ctx.fillText(degLabel(labelLat[i], 'N', 'S'), W - 15, y);
  }
}

// ---------------------------------------------------------------- 14 furniture

function boxesInCorner(labels: readonly PlacedLabel[], x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let i = 0; i < labels.length; i++) {
    const b = labels[i].box;
    if (b[0] < x1 && x0 < b[2] && b[1] < y1 && y0 < b[3]) n++;
  }
  return n;
}

function drawScaleBar(p: Paint): void {
  const { ctx, W, H, opts } = p;
  const f = p.world.params.frame;
  const midLat = (f.lat0 + f.lat1) * 0.5;
  const kmPerPx = (111.32 * Math.cos((midLat * Math.PI) / 180) * Math.abs(f.lon1 - f.lon0)) / W;
  if (!(kmPerPx > 0)) return;
  let km: number = NICE_KM[0];
  for (let i = 0; i < NICE_KM.length; i++) {
    if (NICE_KM[i] / kmPerPx <= SCALE_BAR_MAX_PX) km = NICE_KM[i];
  }
  const px = km / kmPerPx;
  const x0 = 20;
  const y1 = H - 20;
  const y0 = y1 - 5;
  const seg = px / 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i % 2 === 0 ? INK : PARCHMENT;
    ctx.fillRect(x0 + i * seg, y0, seg, 5);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.7;
  ctx.lineCap = 'butt';
  ctx.strokeRect(x0, y0, px, 5);
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(x0 + i * seg, y0);
    ctx.lineTo(x0 + i * seg, y1);
  }
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = gridFont(opts);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillText('0', x0, y1 + 2);
  if (km % 3 === 0) {
    ctx.fillText(String(km / 3), x0 + seg, y1 + 2);
    ctx.fillText(String((2 * km) / 3), x0 + 2 * seg, y1 + 2);
  }
  ctx.fillText(km + ' km', x0 + px, y1 + 2);
}

function drawFurniture(p: Paint): void {
  const { ctx, W, H, world, opts, labels } = p;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  frame(ctx, W, H);

  // Compass: the corner square with the fewest placed label boxes; ties resolve toward the
  // bottom-right (evaluation order BR, BL, TR, TL, replace only on strictly fewer). The top-left
  // corner is always taken by the cartouche, so it is counted as full.
  const c = CORNER_SQUARE;
  const counts = [
    boxesInCorner(labels, 0, 0, c, c) + 1e6,
    boxesInCorner(labels, W - c, 0, W, c),
    boxesInCorner(labels, 0, H - c, c, H),
    boxesInCorner(labels, W - c, H - c, W, H),
  ];
  const evalOrder = [3, 2, 1, 0];
  let best = 3;
  for (let i = 1; i < evalOrder.length; i++) {
    if (counts[evalOrder[i]] < counts[best]) best = evalOrder[i];
  }
  const cx = best === 0 || best === 2 ? COMPASS_INSET : W - COMPASS_INSET;
  const cy = best === 0 || best === 1 ? COMPASS_INSET : H - COMPASS_INSET;
  ctx.save();
  // compassRose uses the ctx's current lineWidth and font.
  ctx.lineWidth = 0.8;
  ctx.font = cssFont(10, opts.fontReady ? fontStack('smallcaps') : fallbackStack());
  compassRose(ctx, cx, cy, COMPASS_RADIUS, fork(world.seed, 'ink', 'compass'));
  ctx.restore();

  ctx.save();
  drawScaleBar(p);
  ctx.restore();

  ctx.save();
  ctx.font = cssFont(16, opts.fontReady ? fontStack('smallcaps') : fallbackStack());
  cartouche(ctx, 24, 20, worldTitle(world), 'seed: ' + world.seed);
  ctx.restore();
}

// ---------------------------------------------------------------- renderWorld

export function renderWorld(world: World, view: PoliticalView, ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const k = opts.scale;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 10;
  ctx.imageSmoothingEnabled = true;

  const p = makePaint(world, view, ctx, opts);
  const layers = opts.layers;

  runLayer(p, 'parchment', drawParchment);
  runLayer(p, 'ocean', drawOcean);
  if (layers.waterlines) runLayer(p, 'waterlines', drawWaterlines);
  if (layers.stipple) runLayer(p, 'stipple', drawStipple);
  if (layers.tint) runLayer(p, 'tint', drawTint);
  runLayer(p, 'lakes', drawLakes);
  if (layers.forests) runLayer(p, 'forests', drawForests);
  if (layers.relief) runLayer(p, 'relief', drawRelief);
  if (layers.rivers) runLayer(p, 'rivers', drawRivers);
  runLayer(p, 'coast', drawCoast);
  if (layers.borders) runLayer(p, 'borders', drawBorders);
  if (layers.provinces) runLayer(p, 'provinces', drawProvinces);
  if (layers.settlements) runLayer(p, 'settlements', drawSettlements);
  if (layers.grid) runLayer(p, 'graticule', drawGraticule);
  if (layers.labels) runLayer(p, 'labels', drawLabelsLayer);
  if (layers.furniture) runLayer(p, 'furniture', drawFurniture);
}
