/**
 * render/labels.ts — Render layer 12 (labels). No RNG stream: label placement is a pure,
 * deterministic function of the world, the political view and the caller's text metrics.
 *
 * Inputs:  World (settlements, nations, rivers + riverPaths, seas, ranges, mesh cell centers),
 *          PoliticalView (nationLabel_r, nationArea, nationAxis), a MeasureFn that returns the
 *          advance width in logical px of `text` set in the FULL css font string `font`
 *          (e.g. 'italic 9px "IM Fell English", Georgia, serif'), and RenderOptions (fontReady).
 * Outputs: PlacedLabel[] in draw order, every coordinate in logical px; drawLabels paints them.
 *
 * Placement order (priority): nations, capitals, cities, towns, villages, seas, ranges, the three
 * longest rivers. Each label's axis-aligned box is tested against the boxes already placed; a
 * colliding label is dropped except nations and capitals, which always place.
 *
 * PlacedLabel.x/y is the label's CENTER (drawn with textAlign 'center', textBaseline 'middle'),
 * rotated by `angle` radians about that point. `font` is the family stack, optionally prefixed
 * by 'italic '; cssFont(size, font) composes the ctx.font string. `box` is [x0, y0, x1, y1].
 *
 * The pure helpers exported below (Box math, straightestWindow, layoutAlongPath, needsFlip,
 * normalizeAxis) are internal to this module; they are exported only so they can be unit tested.
 */

import type { PoliticalView, RenderOptions, SettlementKind, World } from '../core/types';
import { INK, PARCHMENT } from './painter';

export interface PlacedLabel {
  text: string;
  x: number;
  y: number;
  angle: number;
  font: string;
  size: number;
  tracking: number;
  kind: 'settlement' | 'nation' | 'sea' | 'range' | 'river';
  glyphs?: { ch: string; x: number; y: number; angle: number }[];
  box: [number, number, number, number];
}

export type MeasureFn = (text: string, font: string) => number;

/** Axis-aligned box in logical px: [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1. */
export type Box = [number, number, number, number];

// ---------------------------------------------------------------- fonts

const TEXT_FACE = '"IM Fell English", Georgia, serif';
const SMALLCAPS_FACE = '"IM Fell English SC", Georgia, serif';
const FALLBACK_FACE = 'Georgia, serif';

/** Family stack for a face; with `italic` the stack is prefixed by 'italic ' (see cssFont). */
export function fontStack(family: 'text' | 'smallcaps', italic?: boolean): string {
  const face = family === 'smallcaps' ? SMALLCAPS_FACE : TEXT_FACE;
  return italic ? 'italic ' + face : face;
}

/** Fallback-only stack used while the web font is not ready. */
export function fallbackStack(italic?: boolean): string {
  return italic ? 'italic ' + FALLBACK_FACE : FALLBACK_FACE;
}

/** Composes a css font string from a logical px size and a (possibly italic-prefixed) stack. */
export function cssFont(size: number, font: string): string {
  if (font.startsWith('italic ')) return 'italic ' + size + 'px ' + font.slice(7);
  return size + 'px ' + font;
}

// ---------------------------------------------------------------- box helpers (internal, tested)

/** True when two boxes overlap (touching edges do not count). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** True when `box` collides with any box in `boxes`. */
export function collides(boxes: readonly Box[], box: Box): boolean {
  for (let i = 0; i < boxes.length; i++) {
    if (boxesOverlap(boxes[i], box)) return true;
  }
  return false;
}

/** Pushes `box` if it collides with nothing (or `force` is set). Returns whether it was placed. */
export function placeBox(boxes: Box[], box: Box, force = false): boolean {
  if (!force && collides(boxes, box)) return false;
  boxes.push(box);
  return true;
}

/** True when the box lies fully inside the [0,w] x [0,h] canvas. */
export function boxInside(box: Box, w: number, h: number): boolean {
  return box[0] >= 0 && box[1] >= 0 && box[2] <= w && box[3] <= h;
}

/** AABB of a w x h rectangle centered at (cx, cy) and rotated by `angle` radians. */
export function rotatedBox(cx: number, cy: number, w: number, h: number, angle: number): Box {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const ex = (w * c + h * s) * 0.5;
  const ey = (w * s + h * c) * 0.5;
  return [cx - ex, cy - ey, cx + ex, cy + ey];
}

/** Maps a line direction (radians) into (-PI/2, PI/2] so text along it reads left to right. */
export function normalizeAxis(angle: number): number {
  let a = angle;
  if (!Number.isFinite(a)) return 0;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- text along path (internal, tested)

export interface PathWindow { start: number; end: number; length: number; turning: number; }

/**
 * Finds the window [start, end] (point indices, inclusive) of an open polyline with arc length
 * >= minLength that minimizes total turning (sum of absolute heading changes at interior
 * vertices). For each start the shortest qualifying window is considered; ties keep the earliest.
 * Returns null when the whole polyline is shorter than minLength.
 */
export function straightestWindow(pts: Float32Array, minLength: number): PathWindow | null {
  const n = pts.length >> 1;
  if (n < 2) return null;
  const cum = new Float64Array(n);
  const turn = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    const dx = pts[2 * k] - pts[2 * k - 2];
    const dy = pts[2 * k + 1] - pts[2 * k - 1];
    cum[k] = cum[k - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  for (let k = 1; k < n - 1; k++) {
    const ax = pts[2 * k] - pts[2 * k - 2];
    const ay = pts[2 * k + 1] - pts[2 * k - 1];
    const bx = pts[2 * k + 2] - pts[2 * k];
    const by = pts[2 * k + 3] - pts[2 * k + 1];
    const la = Math.sqrt(ax * ax + ay * ay);
    const lb = Math.sqrt(bx * bx + by * by);
    let t = 0;
    if (la > 0 && lb > 0) {
      t = Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1));
    }
    turn[k] = turn[k - 1] + t;
  }
  if (n >= 2) turn[n - 1] = turn[n - 2];
  if (cum[n - 1] < minLength) return null;

  let best: PathWindow | null = null;
  let j = 1;
  for (let i = 0; i < n - 1; i++) {
    if (j <= i) j = i + 1;
    while (j < n && cum[j] - cum[i] < minLength) j++;
    if (j >= n) break;
    const turning = j - 1 > i ? turn[j - 1] - turn[i] : 0;
    if (best === null || turning < best.turning - 1e-9) {
      best = { start: i, end: j, length: cum[j] - cum[i], turning };
    }
  }
  return best;
}

/** Upright rule: text laid from (x0,y0) toward (x1,y1) would read upside down when it heads left. */
export function needsFlip(x0: number, _y0: number, x1: number, _y1: number): boolean {
  return x1 < x0;
}

export interface Glyph { ch: string; x: number; y: number; angle: number; }

/**
 * Lays one glyph per character along the window [start, end] of `pts`, centered on the window's
 * arc. Each glyph gets the position and tangent angle at its own advance midpoint. If the window
 * heads left the traversal direction is reversed (a 180 degree flip) so the text stays upright.
 * `widths[i]` is the advance of `chars[i]`; `tracking` is extra px between consecutive glyphs.
 */
export function layoutAlongPath(
  pts: Float32Array, start: number, end: number,
  chars: readonly string[], widths: readonly number[], tracking: number,
): Glyph[] {
  const count = end - start + 1;
  if (count < 2 || chars.length === 0) return [];
  const flip = needsFlip(pts[2 * start], pts[2 * start + 1], pts[2 * end], pts[2 * end + 1]);
  // Ordered sub-path (flipped reads end -> start).
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const src = flip ? end - k : start + k;
    sx[k] = pts[2 * src];
    sy[k] = pts[2 * src + 1];
  }
  const cum = new Float64Array(count);
  for (let k = 1; k < count; k++) {
    const dx = sx[k] - sx[k - 1];
    const dy = sy[k] - sy[k - 1];
    cum[k] = cum[k - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = cum[count - 1];
  let textWidth = 0;
  for (let i = 0; i < widths.length; i++) textWidth += widths[i];
  textWidth += tracking * Math.max(0, chars.length - 1);
  let s = (total - textWidth) * 0.5;
  const glyphs: Glyph[] = [];
  let seg = 1;
  for (let i = 0; i < chars.length; i++) {
    const mid = clamp(s + widths[i] * 0.5, 0, total);
    while (seg < count - 1 && cum[seg] < mid) seg++;
    const a = seg - 1;
    const segLen = cum[seg] - cum[a];
    const t = segLen > 0 ? (mid - cum[a]) / segLen : 0;
    const dx = sx[seg] - sx[a];
    const dy = sy[seg] - sy[a];
    glyphs.push({
      ch: chars[i],
      x: sx[a] + dx * t,
      y: sy[a] + dy * t,
      angle: segLen > 0 ? Math.atan2(dy, dx) : 0,
    });
    s += widths[i] + tracking;
  }
  return glyphs;
}

/** Bounding box of glyph centers padded by half the glyph size. */
export function glyphBox(glyphs: readonly Glyph[], size: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (g.x < x0) x0 = g.x;
    if (g.y < y0) y0 = g.y;
    if (g.x > x1) x1 = g.x;
    if (g.y > y1) y1 = g.y;
  }
  const pad = size * 0.5;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// ---------------------------------------------------------------- placement

const SETTLEMENT_SIZE: Record<SettlementKind, number> = { city: 13, town: 10, village: 8 };
const SETTLEMENT_RANK: Record<SettlementKind, number> = { city: 1, town: 2, village: 3 };
const ICON_HALF: Record<SettlementKind, number> = { city: 5, town: 3.5, village: 2 };
const ICON_GAP = 4;
/**
 * Port anchor tick as a box offset from the settlement's cell center: the painter strokes
 * anchorPath (ink spans x -2.25..2.25, y -3.1..2.75 with its 0.7 px line) at center + (6, 6),
 * so the tick occupies [3.75, 2.9, 8.25, 8.75]; padded to the quarter px.
 */
const ANCHOR_BOX: Box = [3.5, 2.75, 8.5, 8.75];
const NATION_TRACKING = 0.15;
const SEA_SIZE = 16;
const SEA_TRACKING = 0.25;
const RANGE_SIZE = 11;
const RANGE_TRACKING = 0.12;
const RIVER_SIZE = 9;
const RIVER_TRACKING = 0.04;
const RIVER_LABELS = 3;
const NATION_MAX_TILT = (12 * Math.PI) / 180;

function textWidth(measure: MeasureFn, text: string, font: string, size: number, tracking: number): number {
  const chars = Array.from(text);
  return measure(text, cssFont(size, font)) + tracking * size * Math.max(0, chars.length - 1);
}

export function placeLabels(world: World, view: PoliticalView, measure: MeasureFn, opts: RenderOptions): PlacedLabel[] {
  const labels: PlacedLabel[] = [];
  const boxes: Box[] = [];
  const W = world.params.width;
  const H = world.params.height;
  const rx = world.mesh.r_x;
  const ry = world.mesh.r_y;
  const ready = opts.fontReady;
  const textFace = ready ? fontStack('text') : fallbackStack();
  const italicFace = ready ? fontStack('text', true) : fallbackStack(true);
  const capsFace = ready ? fontStack('smallcaps') : fallbackStack();

  const settlements = world.settlements;
  const nations = world.politics.nations;

  // Settlement icons block text so no label covers a marker, and a port's anchor tick blocks too
  // (a town or village's SE offset would otherwise sit on it). Every box is anchored at the cell
  // center r_x/r_y, the point painter.ts drawSettlements must draw the glyphs at.
  const isCapital = new Uint8Array(settlements.length);
  for (let i = 0; i < nations.length; i++) {
    const n = nations[i];
    if (n.died === -1 && n.capital >= 0 && n.capital < settlements.length) isCapital[n.capital] = 1;
  }
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    if (s.died !== -1) continue;
    const half = ICON_HALF[s.kind] + (isCapital[i] ? 1 : 0);
    boxes.push([rx[s.r] - half, ry[s.r] - half, rx[s.r] + half, ry[s.r] + half]);
    if (s.port) {
      boxes.push([rx[s.r] + ANCHOR_BOX[0], ry[s.r] + ANCHOR_BOX[1], rx[s.r] + ANCHOR_BOX[2], ry[s.r] + ANCHOR_BOX[3]]);
    }
  }

  // 1. Nations: always placed.
  let maxArea = 0;
  for (let i = 0; i < nations.length && i < view.nationLabel_r.length; i++) {
    if (nations[i].died === -1 && view.nationLabel_r[i] >= 0 && view.nationArea[i] > maxArea) maxArea = view.nationArea[i];
  }
  for (let i = 0; i < nations.length && i < view.nationLabel_r.length; i++) {
    const n = nations[i];
    const r = view.nationLabel_r[i];
    if (n.died !== -1 || r < 0 || n.name.length === 0) continue;
    const size = 14 + 10 * Math.sqrt(maxArea > 0 ? view.nationArea[i] / maxArea : 0);
    const angle = clamp(normalizeAxis(view.nationAxis[i]), -NATION_MAX_TILT, NATION_MAX_TILT);
    const w = textWidth(measure, n.name, capsFace, size, NATION_TRACKING);
    const box = rotatedBox(rx[r], ry[r], w, size, angle);
    placeBox(boxes, box, true);
    labels.push({ text: n.name, x: rx[r], y: ry[r], angle, font: capsFace, size, tracking: NATION_TRACKING, kind: 'nation', box });
  }

  // 2. Settlements in priority order: capitals, cities, towns, villages; index order within.
  const order: number[] = [];
  for (let i = 0; i < settlements.length; i++) {
    if (settlements[i].died === -1 && settlements[i].name.length > 0) order.push(i);
  }
  const rank = (i: number): number => (isCapital[i] ? 0 : SETTLEMENT_RANK[settlements[i].kind]);
  order.sort((a, b) => rank(a) - rank(b) || a - b);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const s = settlements[i];
    const capital = isCapital[i] === 1;
    const size = SETTLEMENT_SIZE[s.kind] + (capital ? 2 : 0);
    const w = textWidth(measure, s.name, textFace, size, 0);
    const h = size;
    const cx = rx[s.r];
    const cy = ry[s.r];
    const d = ICON_HALF[s.kind] + (capital ? 1 : 0) + ICON_GAP;
    // Offsets NE, SE, NW, SW: [x0, centerY].
    const candidates: [number, number][] = [
      [cx + d, cy - h * 0.5],
      [cx + d, cy + h * 0.5],
      [cx - d - w, cy - h * 0.5],
      [cx - d - w, cy + h * 0.5],
    ];
    let chosen: Box | null = null;
    for (let c = 0; c < candidates.length; c++) {
      const [x0, yc] = candidates[c];
      const box: Box = [x0, yc - h * 0.5, x0 + w, yc + h * 0.5];
      if (boxInside(box, W, H) && !collides(boxes, box)) { chosen = box; break; }
    }
    if (chosen === null) {
      if (!capital) continue;
      const [x0, yc] = candidates[0];
      chosen = [x0, yc - h * 0.5, x0 + w, yc + h * 0.5];
    }
    boxes.push(chosen);
    labels.push({
      text: s.name, x: (chosen[0] + chosen[2]) * 0.5, y: (chosen[1] + chosen[3]) * 0.5, angle: 0,
      font: textFace, size, tracking: 0, kind: 'settlement', box: chosen,
    });
  }

  // 3. Seas (italic) and 4. ranges (small caps), straight along the PCA axis at the pole cell.
  const areas = [
    { list: world.features.seas, font: italicFace, size: SEA_SIZE, tracking: SEA_TRACKING, kind: 'sea' as const },
    { list: world.features.ranges, font: capsFace, size: RANGE_SIZE, tracking: RANGE_TRACKING, kind: 'range' as const },
  ];
  for (let g = 0; g < areas.length; g++) {
    const { list, font, size, tracking, kind } = areas[g];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.label_r < 0 || a.name.length === 0) continue;
      const angle = normalizeAxis(a.axisAngle);
      const w = textWidth(measure, a.name, font, size, tracking);
      const box = rotatedBox(rx[a.label_r], ry[a.label_r], w, size, angle);
      if (!boxInside(box, W, H) || !placeBox(boxes, box)) continue;
      labels.push({ text: a.name, x: rx[a.label_r], y: ry[a.label_r], angle, font, size, tracking, kind, box });
    }
  }

  // 5. The three longest rivers as text along the straightest window of their path.
  const rivers = world.features.rivers;
  const paths = world.features.riverPaths;
  const riverOrder: number[] = [];
  for (let i = 0; i < rivers.length && i < paths.length; i++) {
    if (rivers[i].name.length > 0 && paths[i].pts.length >= 4) riverOrder.push(i);
  }
  riverOrder.sort((a, b) => rivers[b].length - rivers[a].length || a - b);
  let placedRivers = 0;
  const riverFont = cssFont(RIVER_SIZE, italicFace);
  const trackPx = RIVER_TRACKING * RIVER_SIZE;
  for (let k = 0; k < riverOrder.length && placedRivers < RIVER_LABELS; k++) {
    const i = riverOrder[k];
    const name = rivers[i].name;
    const chars = Array.from(name);
    const widths: number[] = [];
    let total = 0;
    for (let c = 0; c < chars.length; c++) {
      const cw = measure(chars[c], riverFont);
      widths.push(cw);
      total += cw;
    }
    total += trackPx * Math.max(0, chars.length - 1);
    const win = straightestWindow(paths[i].pts, 1.2 * total);
    if (win === null) continue;
    const glyphs = layoutAlongPath(paths[i].pts, win.start, win.end, chars, widths, trackPx);
    if (glyphs.length === 0) continue;
    const box = glyphBox(glyphs, RIVER_SIZE);
    if (!boxInside(box, W, H) || !placeBox(boxes, box)) continue;
    labels.push({
      text: name, x: (box[0] + box[2]) * 0.5, y: (box[1] + box[3]) * 0.5, angle: 0,
      font: italicFace, size: RIVER_SIZE, tracking: RIVER_TRACKING, kind: 'river', glyphs, box,
    });
    placedRivers++;
  }

  return labels;
}

// ---------------------------------------------------------------- drawing

type SpacingCtx = CanvasRenderingContext2D & { letterSpacing?: string };

function setSpacing(ctx: SpacingCtx, px: number): void {
  if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px';
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Paints placed labels: 3 px parchment halo (round joins) under ink text; glyph labels per glyph. */
export function drawLabels(ctx: CanvasRenderingContext2D, labels: PlacedLabel[]): void {
  const sctx = ctx as SpacingCtx;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = PARCHMENT;
  ctx.fillStyle = INK;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    ctx.font = cssFont(l.size, l.font);
    if (l.glyphs !== undefined) {
      setSpacing(sctx, 0);
      for (let g = 0; g < l.glyphs.length; g++) {
        const gl = l.glyphs[g];
        ctx.save();
        ctx.translate(gl.x, gl.y);
        ctx.rotate(gl.angle);
        haloText(ctx, gl.ch, 0, 0);
        ctx.restore();
      }
      continue;
    }
    setSpacing(sctx, l.tracking * l.size);
    ctx.save();
    ctx.translate(l.x, l.y);
    if (l.angle !== 0) ctx.rotate(l.angle);
    haloText(ctx, l.text, 0, 0);
    ctx.restore();
  }
  setSpacing(sctx, 0);
  ctx.restore();
}
