/**
 * render/glyphs.ts — Render layers 6, 7, 11 and 14 (forests/marsh, relief, settlements, furniture).
 * Path2D builders for the map's hand-drawn symbols, plus the three furniture painters (compass
 * rose, frame, cartouche) that draw straight onto the ctx.
 *
 * RNG stream: none of its own. compassRose draws its tip jitter from the Rng the painter hands it
 * (fork(seed, 'ink', 'furniture') or similar) and consumes exactly 16 floats: 2 per point
 * (dx then dy), 8 points in the order NE, SE, SW, NW (ordinals, drawn first so the cardinals
 * overlap them), then N, E, S, W. Nothing else here touches randomness.
 *
 * Inputs: variant / size / kind, all in LOGICAL px; a ctx whose transform, lineWidth and font the
 * painter has already set (the painter calls ctx.setTransform(scale, ...) once; this module never
 * calls ctx.scale). Outputs: Path2D objects with the origin at the symbol's anchor point, or direct
 * drawing on the ctx for compassRose / frame / cartouche (each wrapped in ctx.save/restore).
 *
 * Fill safety. The painter fills a glyph with parchment and then strokes it with ink, so every
 * Path2D is built to be safe under fill() with the default 'nonzero' rule:
 *   - the silhouette (mountain outline, hill arc, tree canopy / chevrons, castle body) is the FIRST
 *     subpath, and every closed or implicitly closed subpath is traversed in the same direction
 *     (screen-clockwise with y down), so overlapping subpaths add winding instead of cancelling and
 *     can never punch a hole;
 *   - every decorative line (ridge, hatches, trunks, marsh ticks, flag pole, anchor stem) is its
 *     own 2-point subpath, which has exactly zero area under any fill rule.
 * The mountain outline is deliberately left open along its base: fill() closes it implicitly, and
 * stroke() then inks the two faces only (no base line), which is the traditional relief look.
 * Hill arcs are open for the same reason. Solid ink dots (village, the city's location dot) are a
 * circle plus a concentric smaller circle, so they read as a solid dot whether the painter fills
 * them with ink or only strokes them at ~1 px.
 */

import type { Rng } from '../core/rng';
import type { SettlementKind } from '../core/types';

const INK = '#2b2318';
const PARCHMENT = '#e9dcb8';
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------- path helpers

/** Appends unit-space xy pairs (scaled by size) as one open polyline subpath. */
function polyline(p: Path2D, pts: readonly number[], size: number): void {
  p.moveTo(pts[0] * size, pts[1] * size);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i] * size, pts[i + 1] * size);
}

/** Appends a polyline as a chain of independent 2-point segments (zero fill area each). */
function chain(p: Path2D, pts: readonly number[], size: number): void {
  for (let i = 2; i < pts.length; i += 2) {
    p.moveTo(pts[i - 2] * size, pts[i - 1] * size);
    p.lineTo(pts[i] * size, pts[i + 1] * size);
  }
}

/** Appends (x0 y0 x1 y1)* as separate 2-point segments. */
function segments(p: Path2D, segs: readonly number[], size: number): void {
  for (let i = 0; i + 3 < segs.length; i += 4) {
    p.moveTo(segs[i] * size, segs[i + 1] * size);
    p.lineTo(segs[i + 2] * size, segs[i + 3] * size);
  }
}

/** Full circle as its own subpath, traversed with increasing angle (screen-clockwise). */
function circle(p: Path2D, cx: number, cy: number, r: number): void {
  p.moveTo(cx + r, cy);
  p.arc(cx, cy, r, 0, TWO_PI);
}

// ---------------------------------------------------------------- relief

/** Unit-space mountain: base from (-0.5, 0) to (0.5, 0), y negative upward, apex height 0.9. The
 *  ridge and hatches all lie strictly inside the outline (checked numerically when authored). */
interface ReliefSpec {
  outline: readonly number[];   // open polyline, base-left -> apex -> base-right
  ridge: readonly number[];     // polyline from the apex down the shadow (east) face
  hatches: readonly number[];   // (x0 y0 x1 y1)* short strokes on the shadow face
}

const MOUNTAINS: readonly ReliefSpec[] = [
  { // apex -0.15, plain faces, 3 hatches
    outline: [-0.5, 0, -0.36, -0.32, -0.15, -0.9, 0.05, -0.55, 0.18, -0.42, 0.5, 0],
    ridge: [-0.15, -0.9, -0.09, -0.62, -0.02, -0.36, 0.08, -0.1],
    hatches: [-0.05, -0.55, 0.06, -0.47, 0.02, -0.4, 0.2, -0.28, 0.08, -0.24, 0.3, -0.1],
  },
  { // apex -0.12, shoulder bump on the west face, 2 hatches
    outline: [-0.5, 0, -0.4, -0.22, -0.3, -0.4, -0.24, -0.36, -0.12, -0.9, 0.08, -0.5, 0.5, 0],
    ridge: [-0.12, -0.9, -0.05, -0.6, 0.02, -0.33, 0.12, -0.08],
    hatches: [0, -0.5, 0.12, -0.42, 0.06, -0.3, 0.26, -0.16],
  },
  { // apex -0.18, shoulder bump on the east face, 3 hatches
    outline: [-0.5, 0, -0.34, -0.38, -0.18, -0.9, 0, -0.56, 0.12, -0.62, 0.22, -0.5, 0.5, 0],
    ridge: [-0.18, -0.9, -0.1, -0.64, -0.02, -0.36, 0.1, -0.1],
    hatches: [-0.06, -0.56, 0.03, -0.48, 0.02, -0.4, 0.2, -0.28, 0.1, -0.24, 0.32, -0.1],
  },
  { // apex -0.10, small bumps on both faces, 2 hatches
    outline: [-0.5, 0, -0.38, -0.3, -0.3, -0.42, -0.26, -0.38, -0.1, -0.9, 0.06, -0.6, 0.16, -0.64, 0.26, -0.44, 0.5, 0],
    ridge: [-0.1, -0.9, -0.03, -0.62, 0.06, -0.34, 0.16, -0.1],
    hatches: [0.04, -0.46, 0.18, -0.36, 0.12, -0.26, 0.32, -0.12],
  },
];

/** Asymmetric peak, origin at the base center, base width = size, height ~0.9 * size. Subpath 0 is
 *  the (open) outline; then the ridge and hatches as zero-area segments. See the file comment. */
export function mountainPath(variant: number, size: number): Path2D {
  const spec = MOUNTAINS[variant & 3];
  const p = new Path2D();
  polyline(p, spec.outline, size);
  chain(p, spec.ridge, size);
  segments(p, spec.hatches, size);
  return p;
}

/** Unit-space hill: cubic from (-0.5, 0) to (0.5, 0) with control points (c1, c2), peak ~0.32,
 *  plus one short hatch on the east flank, below the arc. */
const HILLS: readonly (readonly number[])[] = [
  [-0.3, -0.42, 0.12, -0.42, 0.12, -0.16, 0.28, -0.07],
  [-0.36, -0.4, 0.05, -0.46, 0.08, -0.18, 0.24, -0.08],
  [-0.25, -0.46, 0.18, -0.38, 0.16, -0.14, 0.32, -0.06],
  [-0.32, -0.38, 0.1, -0.5, 0.1, -0.18, 0.26, -0.08],
];

/** Low arc, origin at the base center, base width = size. Open along its base like the mountain. */
export function hillPath(variant: number, size: number): Path2D {
  const h = HILLS[variant & 3];
  const p = new Path2D();
  p.moveTo(-0.5 * size, 0);
  p.bezierCurveTo(h[0] * size, h[1] * size, h[2] * size, h[3] * size, 0.5 * size, 0);
  p.moveTo(h[4] * size, h[5] * size);
  p.lineTo(h[6] * size, h[7] * size);
  return p;
}

// ---------------------------------------------------------------- vegetation

/** Radial bumps (fraction of the canopy radius) at 10 equally spaced angles, per variant. */
const CANOPY_BUMPS: readonly (readonly number[])[] = [
  [0.08, -0.06, 0.1, 0.02, -0.08, 0.06, -0.04, 0.1, -0.06, 0.04],
  [-0.06, 0.08, 0.04, -0.1, 0.06, 0.1, -0.02, -0.08, 0.08, -0.04],
  [0.1, 0.02, -0.08, 0.06, 0.08, -0.06, -0.1, 0.04, 0.02, -0.08],
  [-0.04, 0.1, -0.06, 0.08, -0.1, 0.02, 0.06, -0.08, 0.1, -0.02],
];

/** Conifer variants: [trunkTop, apexOffset, chevron count, then per chevron (halfWidth, baseY, tipY)]. */
const CONIFERS: readonly (readonly number[])[] = [
  [-0.22, 0.02, 3, 0.34, -0.22, -0.5, 0.25, -0.46, -0.72, 0.15, -0.68, -0.92],
  [-0.24, -0.03, 2, 0.36, -0.24, -0.58, 0.22, -0.52, -0.9],
  [-0.2, 0.03, 3, 0.32, -0.2, -0.46, 0.26, -0.42, -0.7, 0.16, -0.64, -0.9],
  [-0.22, -0.02, 2, 0.34, -0.22, -0.56, 0.2, -0.5, -0.88],
];

/** Tree with the origin at the trunk base. Broadleaf: a scribbled blob over a short trunk;
 *  conifer: 2-3 stacked chevrons over a trunk. Height ~0.9 * size. */
export function treePath(kind: 'broadleaf' | 'conifer', variant: number, size: number): Path2D {
  const p = new Path2D();
  const v = variant & 3;
  if (kind === 'broadleaf') {
    const bumps = CANOPY_BUMPS[v];
    const cx = 0;
    const cy = -0.62 * size;
    const base = 0.3 * size;
    const rot = v * 0.35;
    // Loop of 10 bumpy vertices that overshoots its start by one vertex (a scribbled circle);
    // the overshoot doubles back on itself so it adds no fill area.
    for (let i = 0; i <= 11; i++) {
      const k = i % 10;
      const a = rot + (k / 10) * TWO_PI;
      const r = base * (1 + bumps[k]);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    // trunk
    p.moveTo(0, 0);
    p.lineTo(0.02 * size, -0.36 * size);
  } else {
    const c = CONIFERS[v];
    const ax = c[1] * size;
    const n = c[2];
    for (let i = 0; i < n; i++) {
      const hw = c[3 + 3 * i] * size;
      const by = c[4 + 3 * i] * size;
      const ty = c[5 + 3 * i] * size;
      p.moveTo(-hw, by);
      p.lineTo(ax, ty);
      p.lineTo(hw, by);
    }
    // trunk
    p.moveTo(0, 0);
    p.lineTo(0, c[0] * size);
  }
  return p;
}

/** Marsh symbol: three rows of paired horizontal ticks with a tiny vertical, origin at center. */
export function marshPath(size: number): Path2D {
  const p = new Path2D();
  segments(p, [
    -0.5, 0, -0.12, 0, 0.12, 0, 0.5, 0,
    -0.32, -0.22, -0.08, -0.22, 0.08, -0.22, 0.32, -0.22,
    -0.36, 0.22, -0.1, 0.22, 0.1, 0.22, 0.36, 0.22,
    0, -0.04, 0, -0.34,
  ], size);
  return p;
}

// ---------------------------------------------------------------- settlements

/** Small pennant on a pole rising from (x, yBase); the pennant points east. */
function flag(p: Path2D, x: number, yBase: number, height: number): void {
  p.moveTo(x, yBase);
  p.lineTo(x, yBase - height);
  p.moveTo(x, yBase - height);
  p.lineTo(x + 2.6, yBase - height + 1);
  p.lineTo(x, yBase - height + 2);
  p.closePath();
}

/** Settlement symbol with the origin at the map point (the settlement's cell center).
 *  city: castle (7 x 5 body, two crenellated towers, a door) standing above a solid dot at the
 *  origin; town: double circle r 2.4 / 1.3; village: solid dot r 1.4. A capital adds a flag on the
 *  castle's right tower (or beside the symbol for a non-city capital). Sizes are logical px. */
export function settlementPath(kind: SettlementKind, capital: boolean): Path2D {
  const p = new Path2D();
  if (kind === 'city') {
    // one clockwise silhouette: base-left, up the left tower, across the body top, up the right
    // tower, down to base-right, closed along the base.
    p.moveTo(-3.5, -3.5);
    p.lineTo(-3.5, -11);
    p.lineTo(-3.0, -11);
    p.lineTo(-3.0, -10.2);
    p.lineTo(-2.0, -10.2);
    p.lineTo(-2.0, -11);
    p.lineTo(-1.5, -11);
    p.lineTo(-1.5, -8.5);
    p.lineTo(1.5, -8.5);
    p.lineTo(1.5, -11);
    p.lineTo(2.0, -11);
    p.lineTo(2.0, -10.2);
    p.lineTo(3.0, -10.2);
    p.lineTo(3.0, -11);
    p.lineTo(3.5, -11);
    p.lineTo(3.5, -3.5);
    p.closePath();
    // door: an open arch inside the body, same winding as the silhouette
    p.moveTo(-0.9, -3.5);
    p.lineTo(-0.9, -5.4);
    p.arc(0, -5.4, 0.9, Math.PI, TWO_PI);
    p.lineTo(0.9, -3.5);
    // location dot at the origin (solid under either an ink fill or a ~1 px stroke)
    circle(p, 0, 0, 1.2);
    circle(p, 0, 0, 0.45);
    if (capital) flag(p, 2.5, -11, 3.5);
  } else if (kind === 'town') {
    circle(p, 0, 0, 2.4);
    circle(p, 0, 0, 1.3);
    if (capital) flag(p, 3.4, -1, 4);
  } else {
    circle(p, 0, 0, 1.4);
    circle(p, 0, 0, 0.5);
    if (capital) flag(p, 2.4, -0.5, 3.5);
  }
  return p;
}

/** ~5 px anchor tick for ports, origin at its center: ring, stem, crossbar and a curved fluke. */
export function anchorPath(): Path2D {
  const p = new Path2D();
  circle(p, 0, -2.2, 0.55);
  p.moveTo(0, -1.65);
  p.lineTo(0, 2.4);
  p.moveTo(-1.5, -0.5);
  p.lineTo(1.5, -0.5);
  // fluke: arc centred at (0, 0.1), radius 2.3, from 35 to 145 degrees (y down), bottoming at
  // (0, 2.4) where it meets the stem
  const a0 = (35 * Math.PI) / 180;
  const a1 = (145 * Math.PI) / 180;
  p.moveTo(Math.cos(a0) * 2.3, 0.1 + Math.sin(a0) * 2.3);
  p.arc(0, 0.1, 2.3, a0, a1);
  return p;
}

// ---------------------------------------------------------------- furniture

/** Point angles (y down): ordinals NE, SE, SW, NW first, then cardinals N, E, S, W. */
const ROSE_ANGLES: readonly number[] = [
  -Math.PI / 4, Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4,
  -Math.PI / 2, 0, Math.PI / 2, Math.PI,
];

/** 8-point compass rose centred at (cx, cy). Cardinal points reach `radius`, ordinals 0.62 of it;
 *  each point is split along its axis into an ink-filled half (the clockwise side) and a
 *  parchment-filled, ink-stroked half. Tip positions get a tiny jitter from the rng (see the file
 *  comment for the consumption order). Uses the ctx's current lineWidth and font. */
export function compassRose(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rng: Rng): void {
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineJoin = 'miter';
  const jit = radius * 0.02;
  for (let i = 0; i < 8; i++) {
    const cardinal = i >= 4;
    const theta = ROSE_ANGLES[i];
    const len = cardinal ? radius : radius * 0.62;
    const back = cardinal ? radius * 0.22 : radius * 0.16;
    const half = cardinal ? radius * 0.14 : radius * 0.09;
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const tx = cx + dx * len + rng.float(-jit, jit);
    const ty = cy + dy * len + rng.float(-jit, jit);
    const bx = cx + dx * back;
    const by = cy + dy * back;
    // perpendicular on the clockwise side of the axis (y down)
    const px = -dy;
    const py = dx;
    // dark half
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.lineTo(bx + px * half, by + py * half);
    ctx.closePath();
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.stroke();
    // light half
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.lineTo(bx - px * half, by - py * half);
    ctx.closePath();
    ctx.fillStyle = PARCHMENT;
    ctx.fill();
    ctx.stroke();
  }
  // hub: small inner circle over the point roots, with a centre dot
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.16, 0, TWO_PI);
  ctx.fillStyle = PARCHMENT;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.05, 0, TWO_PI);
  ctx.fillStyle = INK;
  ctx.fill();
  // north marker: the letter N in the painter's font, sitting above the north tip
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', cx, cy - radius - 3);
  ctx.restore();
}

/** Double-line frame: 2 px ink rect inset 6, 0.6 px rect inset 11, and at each corner a 3 px
 *  square dot with a diagonal tick and two short ticks parallel to the frame. w, h in logical px. */
export function frame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.lineWidth = 2;
  ctx.strokeRect(6, 6, w - 12, h - 12);
  ctx.lineWidth = 0.6;
  ctx.strokeRect(11, 11, w - 22, h - 22);
  ctx.lineWidth = 0.8;
  for (let c = 0; c < 4; c++) {
    const sx = c & 1 ? -1 : 1;
    const sy = c & 2 ? -1 : 1;
    const ox = sx > 0 ? 0 : w;
    const oy = sy > 0 ? 0 : h;
    // square dot spanning inset 14..17
    const dx0 = Math.min(ox + sx * 14, ox + sx * 17);
    const dy0 = Math.min(oy + sy * 14, oy + sy * 17);
    ctx.fillRect(dx0, dy0, 3, 3);
    ctx.beginPath();
    ctx.moveTo(ox + sx * 19, oy + sy * 19);
    ctx.lineTo(ox + sx * 24, oy + sy * 24);
    ctx.moveTo(ox + sx * 19.5, oy + sy * 15.5);
    ctx.lineTo(ox + sx * 25, oy + sy * 15.5);
    ctx.moveTo(ox + sx * 15.5, oy + sy * 19.5);
    ctx.lineTo(ox + sx * 15.5, oy + sy * 25);
    ctx.stroke();
  }
  ctx.restore();
}

/** Pixel size of a css font string, 14 when it has no px size. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? parseFloat(m[1]) : 14;
}

/** The same css font string at a different px size. */
function withFontSize(font: string, size: number): string {
  if (/(\d+(?:\.\d+)?)px/.test(font)) return font.replace(/(\d+(?:\.\d+)?)px/, size + 'px');
  return size + 'px ' + font;
}

/** Rounded rectangle as the current path (arcTo, so it works without CanvasPath.roundRect). */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Title cartouche with its top-left corner at (x, y): a parchment-filled rounded box with a double
 *  ink border, the title in the ctx's current font and the subtitle at 0.6 of its size below. The
 *  box is sized from measureText with 12 px padding. Draws nothing for an empty title. */
export function cartouche(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, subtitle: string): void {
  if (title === '' && subtitle === '') return;
  ctx.save();
  const titleFont = ctx.font;
  const titleSize = fontPx(titleFont);
  const subSize = Math.max(7, Math.round(titleSize * 0.6));
  const subFont = withFontSize(titleFont, subSize);
  const pad = 12;
  const gap = 4;
  const tw = title === '' ? 0 : ctx.measureText(title).width;
  ctx.font = subFont;
  const sw = subtitle === '' ? 0 : ctx.measureText(subtitle).width;
  const titleH = title === '' ? 0 : titleSize * 1.15;
  const subH = subtitle === '' ? 0 : subSize * 1.15;
  const w = Math.max(tw, sw) + 2 * pad;
  const h = pad + titleH + (titleH > 0 && subH > 0 ? gap : 0) + subH + pad;

  roundedRect(ctx, x, y, w, h, 5);
  ctx.fillStyle = PARCHMENT;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  roundedRect(ctx, x + 3, y + 3, w - 6, h - 6, 3);
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const cx = x + w / 2;
  let top = y + pad;
  if (titleH > 0) {
    ctx.font = titleFont;
    ctx.fillText(title, cx, top + titleSize * 0.9);
    top += titleH + gap;
  }
  if (subH > 0) {
    ctx.font = subFont;
    ctx.fillText(subtitle, cx, top + subSize * 0.9);
  }
  ctx.restore();
}
