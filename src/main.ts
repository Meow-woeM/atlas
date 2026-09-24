/**
 * main.ts — app shell: DOM wiring, URL hash, generate/render loop, PNG export. Not a generation stage.
 * RNG stream: none. The only nondeterministic call in the app is crypto.getRandomValues, used here to
 * mint an 8-letter seed when the URL hash has none (or when Randomize is pressed).
 * Inputs: location.hash (#seed=<s>&land=<f>&wind=<d>&cells=<r>) and the controls in index.html.
 * Outputs: the rendered <canvas id="map">, the <pre id="timings"> readout, location.hash on every
 * generate, and PNG downloads via render/export.
 */
import './style.css';
import type { LayerToggles, PoliticalView, WindDir, World, WorldParams } from './core/types';
import { DEFAULT_PARAMS, FORMATION_STEPS } from './core/types';
import { generate } from './gen/world';
import { landMaskAtStep } from './gen/elevation';
import { buildPoliticalView } from './gen/features';
import { renderWorld, renderFormationPreview, DEFAULT_LAYERS } from './render/painter';
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

// ---------------------------------------------------------------- DOM

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('index.html is missing #' + id);
  return el as T;
}

const seedInput = byId<HTMLInputElement>('seed');
const randomizeBtn = byId<HTMLButtonElement>('randomize');
const generateBtn = byId<HTMLButtonElement>('generate');
const scaleSelect = byId<HTMLSelectElement>('scale');
const exportBtn = byId<HTMLButtonElement>('export');
const timingsPre = byId<HTMLPreElement>('timings');
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
let world: World | null = null;
let view: PoliticalView | null = null;
let fontReady = false;
let generateMs = 0;
let renderMs = 0;
let exportMs = 0;
let exportBusy = false;
let lastCanvasW = 0;
let lastCanvasH = 0;
/** Set while the formation bar is being dragged: the canvas is showing a silhouette, not a world. */
let scrubbing = false;
let scrubTimer = 0;
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

/** Reads #seed=<s>&land=<f>&wind=<d>&cells=<r>&step=<n>. Missing or malformed values fall back to defaults. */
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
  return { seed: hashValue(q.get('seed')) ?? null, params: next };
}

function writeHash(seed: string, p: WorldParams): void {
  const q = new URLSearchParams();
  q.set('seed', seed);
  if (p.landFraction !== DEFAULT_PARAMS.landFraction) q.set('land', String(p.landFraction));
  if (p.windDir !== DEFAULT_PARAMS.windDir) q.set('wind', String(p.windDir));
  if (p.cellSpacing !== DEFAULT_PARAMS.cellSpacing) q.set('cells', String(p.cellSpacing));
  if (p.formationStep !== DEFAULT_PARAMS.formationStep) q.set('step', String(p.formationStep));
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
  timingsPre.classList.remove('error');
  timingsPre.textContent = lines.join('\n');
}

function showError(where: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const seedLine = 'seed   ' + seedInput.value + '\n';
  timingsPre.classList.add('error');
  timingsPre.textContent = seedLine + 'error in ' + where + ': ' + e.message + '\n\n' + (e.stack ?? '');
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
  // Mid-drag the canvas is showing a formation silhouette; a resize must not repaint the present
  // day over it, or the map would flicker back and forth while the bar is moving.
  if (scrubbing) {
    previewFormation(Math.round(Number(formationRange.value)));
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
 * the present day. Dragging it would be unusable if every tick regenerated the world (~200 ms a
 * frame), so a drag paints only the land/sea silhouette at that step, which costs one pass over
 * the cells, and the full pipeline runs once the drag settles.
 *
 * The silhouette comes from landMaskAtStep in gen/elevation.ts. Reusing the CURRENT world's
 * formation is exactly right: the plates and the three height fields do not depend on the step, so
 * scrubbing never needs the earlier stages re-run — only the ramps change.
 */
const SCRUB_SETTLE_MS = 180;

function previewFormation(step: number): void {
  if (!world) return;
  try {
    const scale = fitCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const mask = landMaskAtStep(world.mesh, world.geo.formation, step);
    renderFormationPreview(world.mesh, mask, ctx, {
      scale, width: params.width, height: params.height,
    });
    lastCanvasW = canvas.width;
    lastCanvasH = canvas.height;
  } catch (err) {
    showError('formation preview', err);
  }
}

function commitFormation(step: number): void {
  scrubbing = false;
  if (params.formationStep === step && world) {
    render();
    return;
  }
  params.formationStep = step;
  doGenerate();
}

function onFormationInput(): void {
  const step = Math.round(Number(formationRange.value));
  scrubbing = true;
  previewFormation(step);
  if (scrubTimer !== 0) clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => {
    scrubTimer = 0;
    commitFormation(Math.round(Number(formationRange.value)));
  }, SCRUB_SETTLE_MS) as unknown as number;
}

function syncFormationControl(): void {
  formationRange.max = String(FORMATION_STEPS - 1);
  formationRange.value = String(params.formationStep);
  formationNow.disabled = params.formationStep === FORMATION_STEPS - 1;
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
    world = generate(seed, params);
    view = buildPoliticalView(world);
    generateMs = performance.now() - t0;
    exportMs = 0;
    document.title = 'Atlas — ' + seed;
    syncFormationControl();
    window.dispatchEvent(new Event('atlas-world-changed'));
  } catch (err) {
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
// A keyboard user gets 'change' on arrow keys too, but 'input' already fired and armed the timer;
// committing here just skips the settle delay when the drag ends.
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
