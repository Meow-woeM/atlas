/**
 * render/parchment.test.ts — parchmentCanvas / tintCanvas under a recording canvas stub (the test
 * environment is node: `document` and `Path2D` are stubbed at module scope, and vitest isolates
 * globals per test file). Locks in: ~400 specks and ~150 fibers per LOGICAL frame at every output
 * size (not per device area); the specks and fibers sit at the same relative places, at the same
 * logical size, at 1x / 2x / 4x and on a fitted screen canvas (each consumer owns its RNG stream);
 * sheets up to the cache byte cap are cache hits while a 4x sheet is transient and never evicts
 * the screen sheet; and the tint cache is keyed by the World object, so the same World hits and a
 * different World with the same seed and size neither shares nor evicts its entry.
 */
import { describe, it, expect } from 'vitest';
import type { World } from '../core/types';

// ---------------------------------------------------------------- canvas stub

type Call = [string, ...number[]];

interface StubCanvas {
  width: number;
  height: number;
  calls: Call[];
  getContext(kind: string): unknown;
}

function makeStubCanvas(): StubCanvas {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: number[]): void => { calls.push([name, ...args]); };
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    lineWidth: 1,
    lineCap: 'butt',
    filter: 'none',
    fillRect: rec('fillRect'),
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    arc: rec('arc'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    scale: rec('scale'),
    fill: (): void => { calls.push(['fill']); },
    stroke: (): void => { calls.push(['stroke']); },
    drawImage: (): void => { calls.push(['drawImage']); },
    putImageData: (): void => { calls.push(['putImageData']); },
    createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    createRadialGradient(): { addColorStop(): void } {
      return { addColorStop() {} };
    },
  };
  return { width: 0, height: 0, calls, getContext: () => ctx };
}

class StubPath2D {
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (): StubCanvas => makeStubCanvas(),
};
(globalThis as unknown as { Path2D: unknown }).Path2D = StubPath2D;

// the module reads `document` only inside its functions, so the hoisted import is safe
import { parchmentCanvas, tintCanvas } from './parchment';

/** [x, y, r] per speck, from the arc calls. */
function specks(c: StubCanvas): number[][] {
  const out: number[][] = [];
  for (const call of c.calls) if (call[0] === 'arc') out.push([call[1], call[2], call[3]]);
  return out;
}

/** [x0, y0, cpx, cpy, x1, y1] per fiber: each quadraticCurveTo with the moveTo before it. */
function fibers(c: StubCanvas): number[][] {
  const out: number[][] = [];
  const calls = c.calls;
  for (let i = 1; i < calls.length; i++) {
    if (calls[i][0] !== 'quadraticCurveTo') continue;
    const m = calls[i - 1];
    expect(m[0]).toBe('moveTo');
    out.push([m[1], m[2], calls[i][1], calls[i][2], calls[i][3], calls[i][4]]);
  }
  return out;
}

function sheet(seed: string, w: number, h: number): StubCanvas {
  return parchmentCanvas(seed, w, h) as unknown as StubCanvas;
}

/** Speck (x, y, r) in logical units: x / w, y / h, r / k with k = w / 1024. */
function speckLogical(s: number[], w: number, h: number): number[] {
  return [s[0] / w, s[1] / h, s[2] / (w / 1024)];
}

/** Fiber end points and control point as fractions of the frame. */
function fiberLogical(f: number[], w: number, h: number): number[] {
  return [f[0] / w, f[1] / h, f[2] / w, f[3] / h, f[4] / w, f[5] / h];
}

function expectClose(a: number[], b: number[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 5);
}

// ---------------------------------------------------------------- parchment

describe('parchmentCanvas counts', () => {
  it('draws ~400 specks and ~150 fibers per logical frame at every output size', () => {
    const sizes: [number, number][] = [[1024, 768], [2048, 1536], [4096, 3072], [700, 525], [1170, 878]];
    for (const [w, h] of sizes) {
      const c = sheet('count', w, h);
      expect(c.width).toBe(w);
      expect(c.height).toBe(h);
      expect(specks(c).length).toBe(400);
      expect(fibers(c).length).toBe(150);
    }
  });

  it('sizes specks and fibers in logical px (multiplied by k = w / 1024)', () => {
    const a = specks(sheet('size', 1024, 768));
    const b = specks(sheet('size', 4096, 3072));
    for (let i = 0; i < a.length; i++) {
      expect(a[i][2]).toBeGreaterThanOrEqual(0.5);
      expect(a[i][2]).toBeLessThanOrEqual(1.5);
      expect(b[i][2]).toBeCloseTo(4 * a[i][2], 9);
    }
  });
});

describe('parchmentCanvas placement across scales', () => {
  it('puts every speck and fiber at the same relative place at 1x, 2x, 4x and a fitted screen size', () => {
    const ref = sheet('scale', 1024, 768);
    const refSpecks = specks(ref);
    const refFibers = fibers(ref);
    const others: [number, number][] = [[2048, 1536], [4096, 3072], [700, 525]];
    for (const [w, h] of others) {
      const c = sheet('scale', w, h);
      const s = specks(c);
      const f = fibers(c);
      expect(s.length).toBe(refSpecks.length);
      expect(f.length).toBe(refFibers.length);
      for (let i = 0; i < s.length; i++) {
        expectClose(speckLogical(s[i], w, h), speckLogical(refSpecks[i], 1024, 768));
      }
      for (let i = 0; i < f.length; i++) {
        expectClose(fiberLogical(f[i], w, h), fiberLogical(refFibers[i], 1024, 768));
      }
    }
  });

  it('fibers do not move when the speck count or the noise tables change (own stream)', () => {
    // the fiber stream is fork(seed, 'ink', 'parchment', 'fibers'): its first draw is the first
    // fiber regardless of anything the grain or the specks consumed
    const a = fibers(sheet('stream', 1024, 768));
    const b = fibers(sheet('stream', 4096, 3072));
    expect(a[0][0] * 4).toBeCloseTo(b[0][0], 6);
    expect(a[0][1] * 4).toBeCloseTo(b[0][1], 6);
    expect(a.length).toBe(b.length);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = specks(sheet('det-a', 1024, 768));
    const b = specks(sheet('det-b', 1024, 768));
    expect(a[0]).not.toEqual(b[0]);
    expect(a).toEqual(specks(sheet('det-a', 1024, 768)));
  });
});

describe('parchmentCanvas cache', () => {
  it('caches screen and 1x / 2x export sheets and never the 4x sheet', () => {
    const screen = sheet('cache', 1024, 768);
    expect(sheet('cache', 1024, 768)).toBe(screen);
    const retina = sheet('cache', 2800, 2100);   // dpr-2 laptop with a wide window, 23.5 MiB
    expect(sheet('cache', 2800, 2100)).toBe(retina);
    const twoX = sheet('cache', 2048, 1536);
    expect(sheet('cache', 2048, 1536)).toBe(twoX);
    const fourX = sheet('cache', 4096, 3072);
    expect(sheet('cache', 4096, 3072)).not.toBe(fourX);
  });

  it('a 4x export does not evict the screen sheet layer toggles reuse', () => {
    const screen = sheet('evict', 1024, 768);
    for (let i = 0; i < 5; i++) sheet('evict', 4096, 3072);
    expect(sheet('evict', 1024, 768)).toBe(screen);
  });
});

// ---------------------------------------------------------------- tint

function fakeWorld(seed: string): World {
  // enough of a World for tintCanvas: no cells, so no cellPolygon call and no fill
  return {
    seed,
    params: { width: 1024, height: 768 },
    mesh: { numBoundaryRegions: 0, numRegions: 0 },
    geo: { r_water: new Uint8Array(0), r_biome: new Uint8Array(0) },
  } as unknown as World;
}

describe('tintCanvas cache', () => {
  it('is keyed by the World object and the size', () => {
    const a = fakeWorld('tint');
    const ta = tintCanvas(a, 1024, 768) as unknown as StubCanvas;
    expect(ta.width).toBe(256);
    expect(ta.height).toBe(192);
    expect(tintCanvas(a, 1024, 768)).toBe(ta);
    expect(tintCanvas(a, 4096, 3072)).not.toBe(ta);
    expect(tintCanvas(a, 1024, 768)).toBe(ta);
  });

  it('a different World with the same seed neither shares nor evicts an entry', () => {
    const a = fakeWorld('same-seed');
    const b = fakeWorld('same-seed');
    const ta = tintCanvas(a, 1024, 768);
    const tb = tintCanvas(b, 1024, 768);
    expect(tb).not.toBe(ta);
    expect(tintCanvas(a, 1024, 768)).toBe(ta);
    expect(tintCanvas(b, 1024, 768)).toBe(tb);
  });
});
