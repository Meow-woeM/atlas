/**
 * main.test.ts — boots the app shell against a stub DOM to lock in URL-hash parsing and font readiness.
 * generate/buildPoliticalView/renderWorld are mocked. Observations: the WorldParams handed to generate,
 * the hash written back through history.replaceState, the descriptors requested from document.fonts.load,
 * and the fontReady flag passed to renderWorld. main.ts has no exports, so every test boots the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { World, WorldParams } from './core/types';
import { DEFAULT_PARAMS } from './core/types';

const mocks = vi.hoisted(() => ({
  prepareBase: vi.fn(),
  generateFromBase: vi.fn(),
  renderWorld: vi.fn(),
}));

// baseKey stays real: main.ts uses it to decide when the prepared base can be reused.
vi.mock('./gen/world', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gen/world')>()),
  prepareBase: mocks.prepareBase,
  generateFromBase: mocks.generateFromBase,
}));
vi.mock('./gen/features', () => ({ buildPoliticalView: () => ({}) }));
vi.mock('./ui/editor', () => ({ initEditor: () => {} }));   // the edit layer queries the real DOM; not under test here
vi.mock('./render/painter', () => ({
  DEFAULT_LAYERS: {
    tint: true, relief: true, forests: true, rivers: true, waterlines: true, stipple: false,
    borders: true, provinces: false, settlements: true, labels: true, grid: false, furniture: true,
  },
  renderWorld: mocks.renderWorld,
  renderFrame: () => {},
}));

const FONT_TEXT = '12px "IM Fell English"';
const FONT_TEXT_ITALIC = 'italic 12px "IM Fell English"';
const FONT_SMALLCAPS = '12px "IM Fell English SC"';

type Listener = (ev: unknown) => void;

function stubWorld(seed: string, params: WorldParams): World {
  return {
    seed, params, geo: { windDir: 0 }, mesh: { numRegions: 0, numSides: 0 }, timings: {},
  } as unknown as World;
}

function fakeElement() {
  return {
    value: '', checked: false, disabled: false, hidden: true, textContent: '',
    style: {} as Record<string, string>, width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    classList: { add(): void {}, remove(): void {} },
    addEventListener(_type: string, _fn: Listener): void {},
    getContext(): object { return {}; },
  };
}

interface Dom {
  location: { hash: string };
  replaceState: ReturnType<typeof vi.fn>;
  fontLoad: ReturnType<typeof vi.fn>;
  windowListeners: Map<string, Listener[]>;
}

/** Installs just enough of the browser globals for main.ts to boot; fontLists overrides per-descriptor results. */
function installDom(hash: string, fontLists: Record<string, unknown[]> = {}): Dom {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const location = { hash };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => { location.hash = url; });
  const fontLoad = vi.fn((descriptor: string) => Promise.resolve(fontLists[descriptor] ?? [{}]));
  const windowListeners = new Map<string, Listener[]>();
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    title: '',
    fonts: { load: fontLoad },
    getElementById(id: string) {
      let el = elements.get(id);
      if (!el) { el = fakeElement(); elements.set(id, el); }
      return el;
    },
  };
  g.location = location;
  g.history = { replaceState };
  g.window = {
    devicePixelRatio: 1,
    addEventListener(type: string, fn: Listener): void {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    dispatchEvent(_ev: unknown): boolean { return true; },   // main.ts fires atlas-world-changed for the editor
  };
  g.getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' });
  g.ResizeObserver = class { observe(): void {} };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  return { location, replaceState, fontLoad, windowListeners };
}

/** Imports a fresh main.ts and waits for boot() to reach the first render. */
async function boot(hash: string, fontLists?: Record<string, unknown[]>): Promise<Dom> {
  const dom = installDom(hash, fontLists);
  vi.resetModules();
  await import('./main');
  await vi.waitFor(() => expect(mocks.renderWorld).toHaveBeenCalled());
  return dom;
}

type StubBase = { seed: string; params: WorldParams; timings: Record<string, number> };

function lastParams(): WorldParams {
  const calls = mocks.generateFromBase.mock.calls as [StubBase, WorldParams][];
  return calls[calls.length - 1][1];
}

function lastSeed(): string {
  const calls = mocks.generateFromBase.mock.calls as [StubBase, WorldParams][];
  return calls[calls.length - 1][0].seed;
}

function lastFontReady(): boolean {
  const calls = mocks.renderWorld.mock.calls as [World, unknown, unknown, { fontReady: boolean }][];
  return calls[calls.length - 1][3].fontReady;
}

beforeEach(() => {
  mocks.prepareBase.mockReset();
  mocks.generateFromBase.mockReset();
  mocks.renderWorld.mockReset();
  mocks.prepareBase.mockImplementation((seed: string, params: WorldParams): StubBase => ({ seed, params, timings: {} }));
  mocks.generateFromBase.mockImplementation((b: StubBase, params: WorldParams) => stubWorld(b.seed, params));
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['document', 'location', 'history', 'window', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame']) {
    delete g[key];
  }
});

describe('main hash parsing', () => {
  it('empty values fall back to defaults and are not persisted (#cells=, #cells, #land=, #wind=)', async () => {
    for (const hash of ['#seed=abc&cells=', '#seed=abc&cells', '#seed=abc&land=', '#seed=abc&wind=', '#seed=abc&cells=%20%20&land=%20']) {
      const dom = await boot(hash);
      const p = lastParams();
      expect(p.cellSpacing, hash).toBe(DEFAULT_PARAMS.cellSpacing);
      expect(p.landFraction, hash).toBe(DEFAULT_PARAMS.landFraction);
      expect(p.windDir, hash).toBe(DEFAULT_PARAMS.windDir);
      expect(dom.replaceState, hash).toHaveBeenCalledTimes(1);
      expect(dom.replaceState.mock.calls[0][2], hash).toBe('#seed=abc');
      expect(dom.location.hash, hash).toBe('#seed=abc');
    }
  });

  it('defaults are 8 / 0.42 / random, so the fallback is not the range minimum', () => {
    expect(DEFAULT_PARAMS.cellSpacing).toBe(8);
    expect(DEFAULT_PARAMS.landFraction).toBe(0.42);
    expect(DEFAULT_PARAMS.windDir).toBe('random');
  });

  it('valid values parse, survive surrounding whitespace, and are written back normalized', async () => {
    const dom = await boot('#seed=abc&cells=16&land=0.3&wind=%203%20');
    const p = lastParams();
    expect(p.cellSpacing).toBe(16);
    expect(p.landFraction).toBe(0.3);
    expect(p.windDir).toBe(3);
    expect(lastSeed()).toBe('abc');
    expect(dom.replaceState).toHaveBeenCalledTimes(1);
    expect(dom.replaceState.mock.calls[0][2]).toBe('#seed=abc&land=0.3&wind=3&cells=16');
  });

  it('malformed values fall back, out-of-range values clamp, and the seed is trimmed', async () => {
    const dom = await boot('#seed=%20abc%20&cells=100&land=abc&wind=9');
    const p = lastParams();
    expect(p.cellSpacing).toBe(32);
    expect(p.landFraction).toBe(DEFAULT_PARAMS.landFraction);
    expect(p.windDir).toBe(DEFAULT_PARAMS.windDir);
    expect(lastSeed()).toBe('abc');
    expect(dom.replaceState.mock.calls[0][2]).toBe('#seed=abc&cells=32');
  });

  it('nations: absent or "auto" is auto, integers clamp to the select\'s 3..12 and round, junk falls back', async () => {
    expect((await boot('#seed=abc'), lastParams().nations)).toBe('auto');
    expect((await boot('#seed=abc&nations=auto'), lastParams().nations)).toBe('auto');
    expect((await boot('#seed=abc&nations=5'), lastParams().nations)).toBe(5);
    expect((await boot('#seed=abc&nations=7.4'), lastParams().nations)).toBe(7);
    expect((await boot('#seed=abc&nations=1'), lastParams().nations)).toBe(3);
    expect((await boot('#seed=abc&nations=99'), lastParams().nations)).toBe(12);
    expect((await boot('#seed=abc&nations=many'), lastParams().nations)).toBe('auto');
    const dom = await boot('#seed=abc&nations=6');
    expect(dom.location.hash).toBe('#seed=abc&nations=6');
    const auto = await boot('#seed=abc&nations=auto');
    expect(auto.location.hash).toBe('#seed=abc');
  });

  it('reuses the prepared base across nation counts and formation steps, rebuilds it for a new seed', async () => {
    const dom = await boot('#seed=abc');
    expect(mocks.prepareBase).toHaveBeenCalledTimes(1);
    const fire = (hash: string): void => {
      dom.location.hash = hash;
      for (const fn of dom.windowListeners.get('hashchange') ?? []) fn({});
    };
    fire('#seed=abc&nations=5');
    await vi.waitFor(() => expect(mocks.generateFromBase).toHaveBeenCalledTimes(2));
    fire('#seed=abc&nations=5&step=3');
    await vi.waitFor(() => expect(mocks.generateFromBase).toHaveBeenCalledTimes(3));
    expect(mocks.prepareBase).toHaveBeenCalledTimes(1);
    fire('#seed=xyz');
    await vi.waitFor(() => expect(mocks.generateFromBase).toHaveBeenCalledTimes(4));
    expect(mocks.prepareBase).toHaveBeenCalledTimes(2);
    fire('#seed=xyz&cells=12');
    await vi.waitFor(() => expect(mocks.generateFromBase).toHaveBeenCalledTimes(5));
    expect(mocks.prepareBase).toHaveBeenCalledTimes(3);
  });

  it('a hashchange to an empty value also falls back to defaults', async () => {
    const dom = await boot('#seed=abc&cells=16');
    expect(lastParams().cellSpacing).toBe(16);
    dom.location.hash = '#seed=abc&cells=';
    for (const fn of dom.windowListeners.get('hashchange') ?? []) fn({});
    await vi.waitFor(() => expect(mocks.generateFromBase).toHaveBeenCalledTimes(2));
    expect(lastParams().cellSpacing).toBe(DEFAULT_PARAMS.cellSpacing);
    expect(dom.location.hash).toBe('#seed=abc');
  });
});

describe('main font readiness', () => {
  it('waits for the regular, italic and small-caps Fell faces before the first render', async () => {
    const dom = await boot('#seed=abc');
    const requested = new Set(dom.fontLoad.mock.calls.map((c) => c[0] as string));
    expect(requested).toEqual(new Set([FONT_TEXT, FONT_TEXT_ITALIC, FONT_SMALLCAPS]));
    expect(lastFontReady()).toBe(true);
  });

  it('renders with the fallback face when only the italic face is unavailable', async () => {
    await boot('#seed=abc', { [FONT_TEXT_ITALIC]: [] });
    expect(lastFontReady()).toBe(false);
  });

  it('renders with the fallback face when document.fonts is absent', async () => {
    const dom = await boot('#seed=abc');
    expect(dom.fontLoad).toHaveBeenCalled();
    const g = globalThis as unknown as { document: Record<string, unknown> };
    delete g.document.fonts;
    mocks.renderWorld.mockReset();
    vi.resetModules();
    await import('./main');
    await vi.waitFor(() => expect(mocks.renderWorld).toHaveBeenCalled());
    expect(lastFontReady()).toBe(false);
  });
});
