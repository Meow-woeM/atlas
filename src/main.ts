/**
 * main.ts — app shell: DOM wiring, URL hash, generate/render loop, PNG export. Not a generation stage.
 * RNG stream: none. The only nondeterministic call in the app is crypto.getRandomValues, used here to
 * mint an 8-letter seed when the URL hash has none (or when Randomize is pressed).
 * Inputs: location.hash (#seed=<s>&land=<f>&wind=<d>&cells=<r>&step=<n>&nations=<k>) and the controls
 * in index.html.
 * Outputs: the rendered <canvas id="map">, the <pre id="timings"> readout (folded into a <details>,
 * opened on error), location.hash on every generate, and PNG downloads via render/export.
 */
import './style.css';
import type { LayerToggles, PoliticalView, WindDir, World, WorldParams } from './core/types';
import { DEFAULT_PARAMS, FORMATION_STEPS } from './core/types';
import { baseKey, generateFromBase, prepareBase } from './gen/world';
import type { WorldBase } from './gen/world';
import { buildPoliticalView } from './gen/features';
import { renderWorld, renderFrame, DEFAULT_LAYERS } from './render/painter';
import { exportPng, downloadBlob } from './render/export';
import type { Edits } from './gen/edits';
import { applyEdits, emptyEdits } from './gen/edits';
import { assignNames } from './gen/names';
import { initEditor } from './ui/editor';

// ---------------------------------------------------------------- constants

const LAYER_KEYS = [
  'tint', 'relief', 'forests', 'rivers', 'waterlines', 'stipple',
  'borders', 'provinces', 'settlements', 'labels', 'grid', 'furniture',
] as const satisfies readonly (keyof LayerToggles)[];

const FONT_TIMEOUT_MS = 1500;
const FONT_TEXT = '12px "IM Fell English"';
const FONT_TEXT_ITALIC = 'italic ' + FONT_TEXT;
const FONT_SMALLCAPS = '12px "IM Fell English SC"';
const WIND_NAMES = ['W', 'NW', 'N', 'NE', 'E', 'SE', 'S', 'SW'] as const;
const SEED_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** The nation counts the <select> offers; the hash clamps into the same range. */
const NATIONS_MIN = 3;
const NATIONS_MAX = 12;

// ---------------------------------------------------------------- DOM

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('index.html is missing #' + id);
  return el as T;
}

const seedInput = byId<HTMLInputElement>('seed');
const nationsSelect = byId<HTMLSelectElement>('nations');
const randomizeBtn = byId<HTMLButtonElement>('randomize');
const generateBtn = byId<HTMLButtonElement>('generate');
const scaleSelect = byId<HTMLSelectElement>('scale');
const exportBtn = byId<HTMLButtonElement>('export');
const timingsPre = byId<HTMLPreElement>('timings');
const timingsDetails = byId<HTMLDetailsElement>('timings-details');
const controlsForm = byId<HTMLFormElement>('controls');
const stage = byId<HTMLElement>('stage');
const canvas = byId<HTMLCanvasElement>('map');
const overlay = byId<HTMLElement>('overlay');
const formationRange = byId<HTMLInputElement>('formation-step');
const formationNow = byId<HTMLButtonElement>('formation-now');
const layerBoxes = {} as Record<keyof LayerToggles, HTMLInputElement>;
for (const key of LAYER_KEYS) layerBoxes[key] = byId<HTMLInputElement>('layer-' + key);

// ---------------------------------------------------------------- state

let params: WorldParams = { ...DEFAULT_PARAMS, frame: { ...DEFAULT_PARAMS.frame } };
/** The step-independent half of the current seed's world; rebuilt only when the seed or a base
 *  parameter changes, reused across formation steps and nation counts. */
let base: WorldBase | null = null;
let world: World | null = null;
let view: PoliticalView | null = null;
let fontReady = false;
let generateMs = 0;
let renderMs = 0;
let exportMs = 0;
let exportBusy = false;
let lastCanvasW = 0;
let lastCanvasH = 0;
/** Set while the formation bar is being dragged: the canvas shows the live geography of the
 *  bar's step (generated per frame from `base`), not the settled world. */
let scrubbing = false;
let scrubTimer = 0;
let scrubStep = -1;        // the step the live geography on the canvas was generated at
let scrubQueued = false;   // a frame is already scheduled
let scrubMs = 0;           // last per-step cost (generate + render)
const edits: Edits = emptyEdits();

// ---------------------------------------------------------------- seed and hash

/** 8 lowercase letters from the browser's CSPRNG; the app's only nondeterministic call. */
function randomSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += SEED_ALPHABET[bytes[i] % SEED_ALPHABET.length];
  return s;
}

/**
 * Trims a hash value; an absent, empty or whitespace-only value counts as missing. URLSearchParams
 * yields '' (not null) for `#cells=` and a bare `#cells`, and Number('') is 0, which would otherwise
 * clamp to the range minimum instead of falling back to the default.
 */
function hashValue(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const s = raw.trim();
  return s === '' ? undefined : s;
}

function parseWind(raw: string | null): WindDir | 'random' | undefined {
  const s = hashValue(raw);
  if (s === undefined) return undefined;
  if (s === 'random') return 'random';
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 7) return n as WindDir;
  return undefined;
}

function parseNumber(raw: string | null, lo: number, hi: number): number | undefined {
  const s = hashValue(raw);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
}

/** 'auto', or an integer clamped to the <select>'s range; anything else is missing. */
function parseNations(raw: string | null): number | 'auto' | undefined {
  const s = hashValue(raw);
  if (s === undefined) return undefined;
  if (s === 'auto') return 'auto';
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(NATIONS_MAX, Math.max(NATIONS_MIN, Math.round(n)));
}

/** Reads #seed=<s>&land=<f>&wind=<d>&cells=<r>&step=<n>&nations=<k>. Missing or malformed values fall back to defaults. */
function readHash(): { seed: string | null; params: WorldParams } {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''));
  const next: WorldParams = { ...DEFAULT_PARAMS, frame: { ...DEFAULT_PARAMS.frame } };
  const land = parseNumber(q.get('land'), 0.05, 0.95);
  if (land !== undefined) next.landFraction = land;
  const wind = parseWind(q.get('wind'));
  if (wind !== undefined) next.windDir = wind;
  const cells = parseNumber(q.get('cells'), 4, 32);
  if (cells !== undefined) next.cellSpacing = cells;
  const step = parseNumber(q.get('step'), 0, FORMATION_STEPS - 1);
  if (step !== undefined) next.formationStep = Math.round(step);
  const nations = parseNations(q.get('nations'));
  if (nations !== undefined) next.nations = nations;
  return { seed: hashValue(q.get('seed')) ?? null, params: next };
}

function writeHash(seed: string, p: WorldParams): void {
  const q = new URLSearchParams();
  q.set('seed', seed);
  if (p.landFraction !== DEFAULT_PARAMS.landFraction) q.set('land', String(p.landFraction));
  if (p.windDir !== DEFAULT_PARAMS.windDir) q.set('wind', String(p.windDir));
  if (p.cellSpacing !== DEFAULT_PARAMS.cellSpacing) q.set('cells', String(p.cellSpacing));
  if (p.formationStep !== DEFAULT_PARAMS.formationStep) q.set('step', String(p.formationStep));
  if (p.nations !== DEFAULT_PARAMS.nations) q.set('nations', String(p.nations));
  const next = '#' + q.toString();
  if (location.hash !== next) history.replaceState(null, '', next);
}

// ---------------------------------------------------------------- layers

function readLayers(): LayerToggles {
  const layers = {} as LayerToggles;
  for (const key of LAYER_KEYS) layers[key] = layerBoxes[key].checked;
  return layers;
}

function applyLayers(layers: LayerToggles): void {
  for (const key of LAYER_KEYS) layerBoxes[key].checked = layers[key];
}

// ---------------------------------------------------------------- fonts

/**
 * Resolves true once all three Fell faces the renderer draws with (regular, italic, small caps) are
 * usable, false if that takes longer than timeoutMs. The italic is its own @font-face, so loading only
 * the regular descriptor would leave sea and river labels in the fallback italic until a later repaint.
 */
function waitForFonts(timeoutMs: number): Promise<boolean> {
  if (!('fonts' in document)) return Promise.resolve(false);
  const load = Promise.all([
    document.fonts.load(FONT_TEXT), document.fonts.load(FONT_TEXT_ITALIC), document.fonts.load(FONT_SMALLCAPS),
  ]).then((faces) => faces.every((list) => list.length > 0), () => false);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  // If the fonts arrive after the deadline, flip the flag and repaint so labels pick up the real face.
  void load.then((ok) => {
    if (ok && !fontReady) {
      fontReady = true;
      render();
    }
  });
  return Promise.race([load, timeout]);
}

// ---------------------------------------------------------------- readout

function fmtMs(ms: number): string {
  return ms.toFixed(1).padStart(8) + ' ms';
}

function showTimings(): void {
  if (!world) return;
  const p = world.params;
  const wind = WIND_NAMES[world.geo.windDir] ?? '?';
  const lines: string[] = [];
  lines.push('seed   ' + world.seed);
  lines.push('cells  r=' + p.cellSpacing + '  land ' + p.landFraction + '  wind ' + wind);
  lines.push('mesh   ' + world.mesh.numRegions + ' cells, ' + world.mesh.numSides + ' sides');
  lines.push('');
  lines.push('generate');
  let sum = 0;
  for (const [name, ms] of Object.entries(world.timings)) {
    lines.push('  ' + name.padEnd(12) + fmtMs(ms));
    sum += ms;
  }
  lines.push('  ' + 'stages'.padEnd(12) + fmtMs(sum));
  lines.push('  ' + 'wall'.padEnd(12) + fmtMs(generateMs));
  lines.push('');
  lines.push('render');
  lines.push('  ' + 'screen'.padEnd(12) + fmtMs(renderMs) + '  ' + canvas.width + 'x' + canvas.height);
  if (exportMs > 0) lines.push('  ' + 'export'.padEnd(12) + fmtMs(exportMs));
  lines.push('  ' + 'font'.padEnd(12) + (fontReady ? 'IM Fell English' : 'fallback serif'));
  if (scrubMs > 0) lines.push('  ' + 'scrub'.padEnd(12) + fmtMs(scrubMs) + '  per step, geography only');
  timingsPre.classList.remove('error');
  timingsPre.textContent = lines.join('\n');
}

function showError(where: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const seedLine = 'seed   ' + seedInput.value + '\n';
  timingsPre.classList.add('error');
  timingsPre.textContent = seedLine + 'error in ' + where + ': ' + e.message + '\n\n' + (e.stack ?? '');
  timingsDetails.open = true;   // the readout is folded away by default; an error must be seen
  console.error('[atlas] ' + where, err);
}

// ---------------------------------------------------------------- canvas

/** Sizes the canvas to fit #stage at the world's aspect and returns device px per logical px. */
function fitCanvas(): number {
  const cs = getComputedStyle(stage);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const availW = Math.max(64, stage.clientWidth - padX);
  const availH = Math.max(48, stage.clientHeight - padY);
  const aspect = params.width / params.height;
  let cssW = Math.min(availW, availH * aspect);
  cssW = Math.max(64, Math.floor(cssW));
  const cssH = Math.floor(cssW / aspect);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  return pxW / params.width;
}

function render(): void {
  if (!world || !view) return;
  // Mid-drag the canvas shows the live geography of the bar's step; a resize must not repaint the
  // settled world over it, or the map would flicker back and forth while the bar is moving.
  if (scrubbing) {
    scrubStep = -1;
    scrubTick();
    return;
  }
  try {
    const scale = fitCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    const t0 = performance.now();
    renderWorld(world, view, ctx, { scale, layers: readLayers(), fontReady });
    renderMs = performance.now() - t0;
    lastCanvasW = canvas.width;
    lastCanvasH = canvas.height;
    showTimings();
  } catch (err) {
    showError('render', err);
  }
}

// ---------------------------------------------------------------- formation scroll bar

/**
 * The bar has no dates on it: it is a position in the land's formation, from the earliest step to
 * the present day. Dragging it shows the real world of each step changing under the pointer —
 * coasts moving, mountains rising, rivers growing and shrinking, forests and deserts shifting —
 * not a silhouette. Each animation frame regenerates the bar's current step from `base` (the
 * step-independent half of the world: mesh, edges, plates, the formation fields) with
 * generateFromBase(..., geographyOnly): elevation through features, no provinces, towns, nations
 * or names, which are the settled world's business. Frames coalesce: input events only mark the
 * bar dirty, one frame is scheduled at a time, and a frame that finds the bar where it left it
 * draws nothing, so a slow step never queues a backlog.
 *
 * The geography layers are rendered exactly as renderWorld renders them for the settled world,
 * with the political, label and furniture layers off, so when the drag ends and the full pipeline
 * runs at that step the coast, relief, rivers and tints are already on the canvas and only the
 * borders, towns, labels and cartouche are added.
 */
const SCRUB_SAFETY_MS = 1000;

function renderLive(w: World, v: PoliticalView): void {
  const scale = fitCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  const layers = { ...readLayers(), borders: false, provinces: false, settlements: false, labels: false, furniture: false };
  renderWorld(w, v, ctx, { scale, layers, fontReady });
  renderFrame(ctx, { scale, width: params.width, height: params.height });
  lastCanvasW = canvas.width;
  lastCanvasH = canvas.height;
}

function scrubTick(): void {
  scrubQueued = false;
  if (!scrubbing || !base) return;
  const step = Math.round(Number(formationRange.value));
  if (step === scrubStep) return;
  try {
    const t0 = performance.now();
    const w = generateFromBase(base, { ...params, formationStep: step }, true);
    renderLive(w, buildPoliticalView(w));
    scrubStep = step;
    scrubMs = performance.now() - t0;
  } catch (err) {
    showError('scrub', err);
  }
}

function commitFormation(step: number): void {
  scrubbing = false;
  scrubStep = -1;
  if (params.formationStep === step && world) {
    render();
    return;
  }
  params.formationStep = step;
  doGenerate();
}

function onFormationInput(): void {
  scrubbing = true;
  if (!scrubQueued) {
    scrubQueued = true;
    requestAnimationFrame(scrubTick);
  }
  // 'change' commits when the drag ends; this is a safety net for the rare case it never fires.
  if (scrubTimer !== 0) clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => {
    scrubTimer = 0;
    commitFormation(Math.round(Number(formationRange.value)));
  }, SCRUB_SAFETY_MS) as unknown as number;
}

function syncFormationControl(): void {
  formationRange.max = String(FORMATION_STEPS - 1);
  formationRange.value = String(params.formationStep);
  formationNow.disabled = params.formationStep === FORMATION_STEPS - 1;
}

function syncNationsControl(): void {
  nationsSelect.value = params.nations === 'auto' ? 'auto' : String(params.nations);
}

// ---------------------------------------------------------------- generate

function doGenerate(): void {
  let seed = seedInput.value.trim();
  if (seed === '') {
    seed = randomSeed();
    seedInput.value = seed;
  }
  writeHash(seed, params);
  generateBtn.disabled = true;
  try {
    const t0 = performance.now();
    if (base === null || base.seed !== seed || baseKey(base.params) !== baseKey(params)) {
      base = prepareBase(seed, params);
    }
    world = generateFromBase(base, params);
    view = buildPoliticalView(world);
    generateMs = performance.now() - t0;
    exportMs = 0;
    document.title = 'Atlas — ' + seed;
    syncFormationControl();
    syncNationsControl();
    window.dispatchEvent(new Event('atlas-world-changed'));
  } catch (err) {
    base = null;
    world = null;
    view = null;
    showError('generate', err);
    return;
  } finally {
    generateBtn.disabled = false;
  }
  render();
}

// ---------------------------------------------------------------- export

/** Lets the overlay paint before the synchronous export render blocks the main thread. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function doExport(): Promise<void> {
  if (!world || !view || exportBusy) return;
  const kRaw = Number(scaleSelect.value);
  const k: 1 | 2 | 4 = kRaw === 1 || kRaw === 2 || kRaw === 4 ? kRaw : 2;
  exportBusy = true;
  exportBtn.disabled = true;
  overlay.hidden = false;
  try {
    await nextFrame();
    if (!fontReady && (await waitForFonts(FONT_TIMEOUT_MS))) fontReady = true;
    const t0 = performance.now();
    const blob = await exportPng(world, view, k, { layers: readLayers(), fontReady });
    exportMs = performance.now() - t0;
    downloadBlob(blob, 'atlas-' + world.seed + '-' + k + 'x.png');
    showTimings();
  } catch (err) {
    showError('export', err);
  } finally {
    overlay.hidden = true;
    exportBtn.disabled = false;
    exportBusy = false;
  }
}

// ---------------------------------------------------------------- wiring

controlsForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  doGenerate();
});

formationRange.addEventListener('input', onFormationInput);
// The drag ends (or an arrow key lands): run the full pipeline at this step.
formationRange.addEventListener('change', () => {
  if (scrubTimer !== 0) { clearTimeout(scrubTimer); scrubTimer = 0; }
  commitFormation(Math.round(Number(formationRange.value)));
});

formationNow.addEventListener('click', () => {
  formationRange.value = String(FORMATION_STEPS - 1);
  if (scrubTimer !== 0) { clearTimeout(scrubTimer); scrubTimer = 0; }
  commitFormation(FORMATION_STEPS - 1);
});

randomizeBtn.addEventListener('click', () => {
  seedInput.value = randomSeed();
  doGenerate();
});

// A world parameter, not a layer: changing it regenerates (politics is the only stage that reads it).
nationsSelect.addEventListener('change', () => {
  params.nations = parseNations(nationsSelect.value) ?? 'auto';
  doGenerate();
});

exportBtn.addEventListener('click', () => {
  void doExport();
});

for (const key of LAYER_KEYS) {
  layerBoxes[key].addEventListener('change', () => render());
}

// A pasted or edited hash regenerates without a reload.
window.addEventListener('hashchange', () => {
  const h = readHash();
  params = h.params;
  if (h.seed !== null) seedInput.value = h.seed;
  doGenerate();
});

// Re-fit on layout changes; only repaint when the backing store actually changes size.
let resizeQueued = false;
const ro = new ResizeObserver(() => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    if (!world) return;
    fitCanvas();
    if (canvas.width !== lastCanvasW || canvas.height !== lastCanvasH) render();
  });
});
ro.observe(stage);

initEditor({
  getWorld: () => world,
  getEdits: () => edits,
  onEditsChanged: () => {
    if (!world) return;
    assignNames(world);
    applyEdits(world, edits);
    view = buildPoliticalView(world);
    render();
  },
  canvasToLogical: (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * params.width / rect.width,
      y: (ev.clientY - rect.top) * params.height / rect.height,
    };
  },
});

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  applyLayers(DEFAULT_LAYERS);
  const h = readHash();
  params = h.params;
  seedInput.value = h.seed ?? randomSeed();
  timingsPre.textContent = 'loading fonts...';
  fontReady = await waitForFonts(FONT_TIMEOUT_MS);
  doGenerate();
}

void boot();
