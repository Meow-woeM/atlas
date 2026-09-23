/**
 * render/painter.test.ts — layer 10 (borders) of painter.ts: the renderer reads ownership only
 * through PoliticalView (section 10) and the glow clip is the nation's own border loops (6.2).
 * Node has no canvas, so renderWorld runs against a recording stand-in for
 * CanvasRenderingContext2D (a Proxy that logs every call and property set) and a Path2D stub that
 * logs its ops; ./parchment is mocked because it needs document.createElement. Worlds are
 * generated once at module load (two small seeds plus DEFAULT_PARAMS); per-element checks are
 * counted in plain loops and asserted once.
 *
 * The clip-from-loops construction relies on two facts about buildPoliticalView's output, both
 * asserted here on generated worlds: every nation border is a closed loop, and the loops of a
 * nation, under the nonzero rule, cover exactly that nation's cells (holes wind the other way).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./parchment', () => ({ parchmentCanvas: () => ({}), tintCanvas: () => ({}) }));

import { DEFAULT_PARAMS } from '../core/types';
import type { PoliticalView, RenderOptions, World, WorldParams } from '../core/types';
import { cellPolygon } from '../mesh/dualmesh';
import { generate } from '../gen/world';
import { buildPoliticalView } from '../gen/features';
import { DEFAULT_LAYERS, renderWorld } from './painter';

// ---------------------------------------------------------------- canvas stand-ins

type Op = (string | number)[];

/** Path2D stub: records moveTo/lineTo/closePath/rect/addPath as ops. */
class FakePath2D {
  ops: Op[] = [];
  moveTo(x: number, y: number): void { this.ops.push(['M', x, y]); }
  lineTo(x: number, y: number): void { this.ops.push(['L', x, y]); }
  closePath(): void { this.ops.push(['Z']); }
  rect(x: number, y: number, w: number, h: number): void { this.ops.push(['R', x, y, w, h]); }
  addPath(other: FakePath2D): void { for (const op of other.ops) this.ops.push(op); }
}
vi.stubGlobal('Path2D', FakePath2D);

interface Call { name: string; args: unknown[] }

/** A CanvasRenderingContext2D that records every method call ('name') and property set ('set:name'). */
function recordingContext(calls: Call[]): CanvasRenderingContext2D {
  const props: Record<string, unknown> = {};
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in props) return props[prop];
      return (...args: unknown[]) => { calls.push({ name: prop, args }); };
    },
    set(_t, prop, value) {
      if (typeof prop === 'string') {
        props[prop] = value;
        calls.push({ name: 'set:' + prop, args: [value] });
      }
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const BORDERS_ONLY: RenderOptions = {
  scale: 1,
  fontReady: false,
  layers: {
    ...DEFAULT_LAYERS,
    tint: false, relief: false, forests: false, rivers: false, waterlines: false, stipple: false,
    borders: true, provinces: false, settlements: false, labels: false, grid: false, furniture: false,
  },
};

/** The ops addPolyline in painter.ts emits for one polyline. */
function polylineOps(pts: Float32Array, closed: boolean): Op[] {
  const ops: Op[] = [];
  const n = pts.length >> 1;
  if (n < 2) return ops;
  ops.push(['M', pts[0], pts[1]]);
  for (let i = 1; i < n; i++) ops.push(['L', pts[2 * i], pts[2 * i + 1]]);
  if (closed) ops.push(['Z']);
  return ops;
}

/** Nonzero winding number of (x, y) with respect to a closed loop. */
function winding(x: number, y: number, pts: Float32Array): number {
  const n = pts.length >> 1;
  let wn = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = pts[2 * j], yj = pts[2 * j + 1];
    const xi = pts[2 * i], yi = pts[2 * i + 1];
    const left = (xi - xj) * (y - yj) - (x - xj) * (yi - yj);
    if (yj <= y) {
      if (yi > y && left > 0) wn++;
    } else if (yi <= y && left < 0) {
      wn--;
    }
  }
  return wn;
}

// ---------------------------------------------------------------- worlds

interface Built { label: string; world: World; view: PoliticalView }

const SMALL_A: Partial<WorldParams> = { width: 400, height: 300, cellSpacing: 16 };
const SMALL_B: Partial<WorldParams> = { width: 512, height: 384, cellSpacing: 12 };

function build(label: string, seed: string, params: Partial<WorldParams>): Built {
  const world = generate(seed, params);
  return { label, world, view: buildPoliticalView(world) };
}

const worlds: Built[] = [
  build('small-a', 'painter-1', SMALL_A),
  build('small-b', 'painter-2', SMALL_B),
  build('default', 'painter-3', DEFAULT_PARAMS),
];

// ---------------------------------------------------------------- tests

describe('PoliticalView borders as seen by the border layer', () => {
  it('every nation border is a closed loop with at least three points', () => {
    for (const { label, view } of worlds) {
      let open = 0, short = 0;
      for (let b = 0; b < view.borders.length; b++) {
        if (!view.borders[b].closed) open++;
        if (view.borders[b].pts.length < 6) short++;
      }
      expect(view.borders.length, label).toBeGreaterThan(0);
      expect(open, label + ': open border chains').toBe(0);
      expect(short, label + ': borders with < 3 points').toBe(0);
    }
  });

  it('under the nonzero rule a nation\'s loops cover its own cells and nobody else\'s', () => {
    for (const { label, world, view } of worlds) {
      const mesh = world.mesh;
      const r_nation = world.politics.r_nation;
      const numNations = world.politics.nations.length;
      const poly = new Float32Array(64);
      let total = 0, agree = 0, ambiguous = 0;
      const claimed = new Int32Array(numNations);
      for (let r = mesh.numBoundaryRegions; r < mesh.numRegions; r++) {
        const n = cellPolygon(mesh, r, poly);
        if (n < 3) continue;
        let cx = 0, cy = 0;
        for (let i = 0; i < n; i++) { cx += poly[2 * i]; cy += poly[2 * i + 1]; }
        cx /= n;
        cy /= n;
        let owner = -1, owners = 0;
        for (let k = 0; k < numNations; k++) {
          let w = 0;
          for (let b = 0; b < view.borders.length; b++) {
            if (view.borderNation[b] === k) w += winding(cx, cy, view.borders[b].pts);
          }
          if (w !== 0) { owner = k; owners++; }
        }
        if (owners > 1) ambiguous++;
        if (owner >= 0) claimed[owner]++;
        total++;
        if (owner === r_nation[r]) agree++;
      }
      expect(total, label).toBeGreaterThan(100);
      expect(ambiguous, label + ': cells inside two nations\' loops').toBe(0);
      // Measured exact (303/303, 874/874, 7725/7725) on these seeds, 2026-09-22; the margin is for a
      // future noisy-edge amplitude tweak putting a thin cell's center just across the wobble.
      expect(agree / total, label + ': winding-number owner vs r_nation').toBeGreaterThanOrEqual(0.99);
      for (let k = 0; k < numNations; k++) {
        expect(claimed[k] > 0, label + ': nation ' + k + ' claims cells').toBe(view.nationLabel_r[k] >= 0);
      }
    }
  });
});

describe('drawBorders', () => {
  it('builds each glow from the view\'s loops and never reads politics.r_nation', () => {
    for (const { label, world, view } of worlds) {
      // A politics whose r_nation throws when read: the view is the only allowed ownership source.
      const politics = { ...world.politics };
      Object.defineProperty(politics, 'r_nation', {
        get(): Int16Array { throw new Error('renderer read politics.r_nation'); },
      });
      const sealed: World = { ...world, politics };
      const calls: Call[] = [];
      const ctx = recordingContext(calls);
      expect(() => renderWorld(sealed, view, ctx, BORDERS_ONLY), label).not.toThrow();

      // Expected glow per nation: that nation's loops, in border order, as addPolyline emits them.
      const nations = world.politics.nations;
      const expected: (Op[] | null)[] = new Array(nations.length).fill(null);
      for (let b = 0; b < view.borders.length; b++) {
        const n = view.borderNation[b];
        const ops = expected[n] ?? [];
        for (const op of polylineOps(view.borders[b].pts, view.borders[b].closed)) ops.push(op);
        expected[n] = ops;
      }

      // The border layer's clips are the only ones under 'nonzero' (lakes pass no rule, the coast
      // passes 'evenodd'); each is followed by the nation color, alpha 0.32, 10 px and a stroke of
      // the same path.
      let next = 0;
      let glows = 0;
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (c.name !== 'clip' || c.args[1] !== 'nonzero') continue;
        while (next < nations.length && expected[next] === null) next++;
        expect(next < nations.length, label + ': more glows than nations with borders').toBe(true);
        const path = c.args[0] as FakePath2D;
        expect(path.ops, label + ': glow ' + next + ' clip ops').toEqual(expected[next]);
        expect(calls[i + 1], label).toEqual({ name: 'set:strokeStyle', args: [nations[next].color] });
        expect(calls[i + 2], label).toEqual({ name: 'set:globalAlpha', args: [0.32] });
        expect(calls[i + 3], label).toEqual({ name: 'set:lineWidth', args: [10] });
        expect(calls[i + 4].name, label).toBe('stroke');
        expect(calls[i + 4].args[0], label + ': glow stroked under its own clip').toBe(path);
        next++;
        glows++;
      }
      const withBorders = expected.filter((e) => e !== null).length;
      expect(glows, label + ': one glow per nation with borders').toBe(withBorders);
      expect(withBorders, label).toBeGreaterThan(0);
    }
  });

  it('reuses the glow paths for the same view and rebuilds them for a new one', () => {
    const { world, view } = worlds[0];
    const first: Call[] = [];
    renderWorld(world, view, recordingContext(first), BORDERS_ONLY);
    const second: Call[] = [];
    renderWorld(world, view, recordingContext(second), BORDERS_ONLY);
    const clipsOf = (calls: Call[]): unknown[] =>
      calls.filter((c) => c.name === 'clip' && c.args[1] === 'nonzero').map((c) => c.args[0]);
    const a = clipsOf(first), b = clipsOf(second);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
    // Same borders, new view object: freshly built paths with identical geometry.
    const rebuilt: PoliticalView = { ...view };
    const third: Call[] = [];
    renderWorld(world, rebuilt, recordingContext(third), BORDERS_ONLY);
    const c = clipsOf(third);
    expect(c.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(c[i]).not.toBe(a[i]);
      expect((c[i] as FakePath2D).ops).toEqual((a[i] as FakePath2D).ops);
    }
  });
});
