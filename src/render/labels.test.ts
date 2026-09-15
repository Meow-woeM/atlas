/**
 * render/labels.test.ts — unit tests for the pure label helpers (no canvas, no DOM).
 * painter.ts is mocked so the ink constants resolve without a DOM.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./painter', () => ({ INK: '#2b2318', PARCHMENT: '#e9dcb8', SEA_INK: '#3b4a5a' }));

import {
  boxesOverlap, collides, placeBox, boxInside, rotatedBox, normalizeAxis,
  straightestWindow, needsFlip, layoutAlongPath, glyphBox,
  fontStack, fallbackStack, cssFont, placeLabels,
} from './labels';
import type { Box } from './labels';
import type { PoliticalView, RenderOptions, World } from '../core/types';
import { DEFAULT_PARAMS } from '../core/types';

describe('fonts', () => {
  it('fontStack returns the named faces with a Georgia fallback', () => {
    expect(fontStack('text')).toBe('"IM Fell English", Georgia, serif');
    expect(fontStack('smallcaps')).toBe('"IM Fell English SC", Georgia, serif');
    expect(fontStack('text', true)).toBe('italic "IM Fell English", Georgia, serif');
    expect(fallbackStack()).toBe('Georgia, serif');
  });
  it('cssFont puts the style before the size', () => {
    expect(cssFont(13, fontStack('text'))).toBe('13px "IM Fell English", Georgia, serif');
    expect(cssFont(9, fontStack('text', true))).toBe('italic 9px "IM Fell English", Georgia, serif');
  });
});

describe('collision boxes', () => {
  it('detects overlap and ignores touching edges', () => {
    expect(boxesOverlap([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
    expect(boxesOverlap([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false);
    expect(boxesOverlap([0, 0, 10, 10], [20, 20, 30, 30])).toBe(false);
    expect(boxesOverlap([0, 0, 10, 10], [2, 2, 3, 3])).toBe(true);
  });
  it('placeBox only pushes non-colliding boxes unless forced', () => {
    const boxes: Box[] = [];
    expect(placeBox(boxes, [0, 0, 10, 10])).toBe(true);
    expect(placeBox(boxes, [5, 5, 15, 15])).toBe(false);
    expect(boxes.length).toBe(1);
    expect(placeBox(boxes, [5, 5, 15, 15], true)).toBe(true);
    expect(boxes.length).toBe(2);
    expect(collides(boxes, [12, 12, 13, 13])).toBe(true);
    expect(collides(boxes, [100, 100, 101, 101])).toBe(false);
  });
  it('boxInside respects the canvas bounds', () => {
    expect(boxInside([0, 0, 10, 10], 100, 100)).toBe(true);
    expect(boxInside([-1, 0, 10, 10], 100, 100)).toBe(false);
    expect(boxInside([0, 0, 101, 10], 100, 100)).toBe(false);
  });
  it('rotatedBox bounds a rotated rectangle', () => {
    const b0 = rotatedBox(50, 50, 20, 10, 0);
    expect(b0).toEqual([40, 45, 60, 55]);
    const b90 = rotatedBox(50, 50, 20, 10, Math.PI / 2);
    expect(b90[0]).toBeCloseTo(45);
    expect(b90[1]).toBeCloseTo(40);
    expect(b90[2]).toBeCloseTo(55);
    expect(b90[3]).toBeCloseTo(60);
    const b45 = rotatedBox(0, 0, 20, 10, Math.PI / 4);
    expect(b45[2]).toBeGreaterThan(10);
    expect(b45[2]).toBeLessThan(15);
  });
  it('normalizeAxis maps any angle into (-90, 90] degrees', () => {
    expect(normalizeAxis(0)).toBe(0);
    expect(normalizeAxis(Math.PI)).toBeCloseTo(0);
    expect(normalizeAxis(-Math.PI)).toBeCloseTo(0);
    expect(normalizeAxis((3 * Math.PI) / 4)).toBeCloseTo(-Math.PI / 4);
    expect(normalizeAxis(-Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(normalizeAxis(NaN)).toBe(0);
  });
});

/** Polyline: a zigzag for x in [0, 100], then a straight run to x = 300, then another zigzag. */
function zigzagThenStraight(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 100; x += 10) pts.push(x, (x / 10) % 2 === 0 ? 0 : 15);
  for (let x = 110; x <= 300; x += 10) pts.push(x, 0);
  for (let x = 310; x <= 400; x += 10) pts.push(x, (x / 10) % 2 === 0 ? 0 : 15);
  return new Float32Array(pts);
}

describe('straightestWindow', () => {
  it('returns null when the polyline is too short', () => {
    expect(straightestWindow(new Float32Array([0, 0, 10, 0]), 20)).toBeNull();
    expect(straightestWindow(new Float32Array([0, 0]), 1)).toBeNull();
  });
  it('picks the straight run of a mixed polyline', () => {
    const pts = zigzagThenStraight();
    const win = straightestWindow(pts, 60);
    expect(win).not.toBeNull();
    if (win === null) return;
    expect(win.turning).toBeCloseTo(0, 6);
    expect(win.length).toBeGreaterThanOrEqual(60);
    for (let k = win.start; k <= win.end; k++) expect(pts[2 * k + 1]).toBe(0);
    expect(pts[2 * win.start]).toBeGreaterThanOrEqual(100);
    expect(pts[2 * win.end]).toBeLessThanOrEqual(300);
  });
  it('is deterministic and prefers the earliest window on ties', () => {
    const line = new Float32Array([0, 0, 10, 0, 20, 0, 30, 0, 40, 0]);
    const a = straightestWindow(line, 15);
    const b = straightestWindow(line, 15);
    expect(a).toEqual(b);
    expect(a?.start).toBe(0);
    expect(a?.end).toBe(2);
  });
  it('covers the whole polyline when only the whole thing is long enough', () => {
    const line = new Float32Array([0, 0, 10, 5, 20, 0, 30, 5]);
    const win = straightestWindow(line, 33);
    expect(win?.start).toBe(0);
    expect(win?.end).toBe(3);
  });
});

describe('text along path', () => {
  const chars = ['R', 'i', 'v', 'e', 'r'];
  const widths = [6, 3, 5, 5, 4];

  it('needsFlip is true only when the window heads left', () => {
    expect(needsFlip(0, 0, 10, 0)).toBe(false);
    expect(needsFlip(10, 0, 0, 0)).toBe(true);
    expect(needsFlip(0, 0, 0, 10)).toBe(false);
  });
  it('lays glyphs left to right along a rightward line with angle 0', () => {
    const line = new Float32Array([0, 20, 50, 20, 100, 20]);
    const g = layoutAlongPath(line, 0, 2, chars, widths, 1);
    expect(g.length).toBe(5);
    for (let i = 0; i < g.length; i++) {
      expect(g[i].ch).toBe(chars[i]);
      expect(g[i].angle).toBeCloseTo(0);
      expect(g[i].y).toBeCloseTo(20);
      if (i > 0) expect(g[i].x).toBeGreaterThan(g[i - 1].x);
    }
    // Centered: text width 23 + 4 tracking = 27 on a 100 px window -> first glyph mid at 36.5 + 3.
    expect(g[0].x).toBeCloseTo(36.5 + 3);
  });
  it('flips a leftward line so the text stays upright and reads left to right', () => {
    const line = new Float32Array([100, 20, 50, 20, 0, 20]);
    const g = layoutAlongPath(line, 0, 2, chars, widths, 1);
    expect(g.length).toBe(5);
    for (let i = 0; i < g.length; i++) {
      expect(Math.abs(g[i].angle)).toBeLessThan(1e-6);
      if (i > 0) expect(g[i].x).toBeGreaterThan(g[i - 1].x);
    }
    expect(g[0].ch).toBe('R');
  });
  it('follows the local tangent on a bent path', () => {
    const line = new Float32Array([0, 0, 50, 0, 50, 50]);
    const g = layoutAlongPath(line, 0, 2, ['a', 'b'], [40, 40], 0);
    expect(g[0].angle).toBeCloseTo(0);
    expect(g[1].angle).toBeCloseTo(Math.PI / 2);
  });
  it('glyphBox bounds the glyph centers padded by half the size', () => {
    const box = glyphBox([{ ch: 'a', x: 10, y: 10, angle: 0 }, { ch: 'b', x: 30, y: 14, angle: 0 }], 8);
    expect(box).toEqual([6, 6, 34, 18]);
  });
});

// ---------------------------------------------------------------- placeLabels smoke test on a fake world

function fakeWorld(): { world: World; view: PoliticalView } {
  const r_x = new Float32Array([100, 300, 500, 700]);
  const r_y = new Float32Array([100, 300, 500, 300]);
  const riverPts = new Float32Array([200, 600, 300, 600, 400, 600, 500, 600, 600, 600, 700, 600]);
  const partial = {
    seed: 'test',
    params: { ...DEFAULT_PARAMS },
    mesh: { r_x, r_y, numRegions: 4 },
    features: {
      coast: [], waterlines: [], lakes: [],
      rivers: [
        { id: 0, name: 'Long', sides: new Int32Array(0), source_t: 0, mouth_t: 0, flux: 1, length: 500, parent: -1 },
        { id: 1, name: 'Short', sides: new Int32Array(0), source_t: 0, mouth_t: 0, flux: 1, length: 5, parent: -1 },
      ],
      riverPaths: [{ pts: riverPts, closed: false }, { pts: new Float32Array([0, 0, 5, 0]), closed: false }],
      seas: [{ id: 0, kind: 'sea', name: 'Wide Sea', cells: new Int32Array([3]), label_r: 3, axisAngle: 2.5, extent: 100 }],
      ranges: [],
    },
    settlements: [
      { id: 0, name: 'Capital', r: 0, kind: 'city', population: 1000, port: false, riverMouth: false, river: -1, province: 0, culture: 0, founded: 0, died: -1 },
      { id: 1, name: 'Village', r: 1, kind: 'village', population: 10, port: false, riverMouth: false, river: -1, province: 0, culture: 0, founded: 0, died: -1 },
      { id: 2, name: 'Dead', r: 2, kind: 'town', population: 0, port: false, riverMouth: false, river: -1, province: 0, culture: 0, founded: 0, died: 5 },
    ],
    politics: {
      year: 0, cultures: [],
      nations: [{ id: 0, name: 'Realm', capital: 0, culture: 0, color: '#f00', founded: 0, died: -1 }],
      p_nation: new Int16Array(0), p_culture: new Int16Array(0), r_nation: new Int16Array(4), r_settlement: new Int16Array(4),
    },
  };
  const world = partial as unknown as World;
  const view: PoliticalView = {
    borders: [], borderNation: new Int16Array(0),
    nationLabel_r: new Int32Array([2]), nationArea: new Float32Array([1000]), nationAxis: new Float32Array([1.0]),
  };
  return { world, view };
}

const measure = (text: string): number => Array.from(text).length * 6;
const opts: RenderOptions = {
  scale: 1, fontReady: true,
  layers: { tint: true, relief: true, forests: true, rivers: true, waterlines: true, stipple: false, borders: true, provinces: false, settlements: true, labels: true, grid: false, furniture: true },
};

describe('placeLabels', () => {
  it('places nations, capitals, villages, seas and rivers deterministically', () => {
    const { world, view } = fakeWorld();
    const a = placeLabels(world, view, measure, opts);
    const b = placeLabels(world, view, measure, opts);
    expect(a).toEqual(b);
    const kinds = a.map((l) => l.kind);
    expect(kinds).toEqual(['nation', 'settlement', 'settlement', 'sea', 'river']);
    const nation = a[0];
    expect(nation.text).toBe('Realm');
    expect(nation.size).toBeCloseTo(24);
    expect(Math.abs(nation.angle)).toBeLessThanOrEqual((12 * Math.PI) / 180 + 1e-9);
    expect(nation.font).toBe(fontStack('smallcaps'));
    const cap = a[1];
    expect(cap.text).toBe('Capital');
    expect(cap.size).toBe(15);
    expect(cap.box[0]).toBeGreaterThan(100);
    const vil = a[2];
    expect(vil.size).toBe(8);
    expect(a.some((l) => l.text === 'Dead')).toBe(false);
    const sea = a[3];
    expect(sea.font).toBe(fontStack('text', true));
    expect(sea.angle).toBeGreaterThan(-Math.PI / 2);
    expect(sea.angle).toBeLessThanOrEqual(Math.PI / 2);
    const river = a[4];
    expect(river.text).toBe('Long');
    expect(river.glyphs?.length).toBe(4);
    for (const g of river.glyphs ?? []) expect(g.angle).toBeCloseTo(0);
    for (const l of a) {
      expect(l.box[0]).toBeLessThanOrEqual(l.box[2]);
      expect(l.box[1]).toBeLessThanOrEqual(l.box[3]);
    }
  });
  it('uses the fallback face when fonts are not ready', () => {
    const { world, view } = fakeWorld();
    const labels = placeLabels(world, view, measure, { ...opts, fontReady: false });
    for (const l of labels) expect(l.font.includes('IM Fell')).toBe(false);
  });
  it('drops a colliding village but keeps the capital', () => {
    const { world, view } = fakeWorld();
    world.settlements[1].r = 0; // same cell as the capital
    const labels = placeLabels(world, view, measure, opts);
    expect(labels.some((l) => l.text === 'Capital')).toBe(true);
    // The village may find a free offset (SE/NW/SW); if it does its box must not overlap the capital's.
    const cap = labels.find((l) => l.text === 'Capital');
    const vil = labels.find((l) => l.text === 'Village');
    if (cap !== undefined && vil !== undefined) expect(boxesOverlap(cap.box, vil.box)).toBe(false);
  });
});
