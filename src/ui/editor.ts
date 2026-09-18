/**
 * ui/editor.ts — Interactive post-generation name and border editor.
 * RNG stream: none. Inputs: EditorHooks, pointer events, and localStorage. Outputs: one sidebar
 * container, mutations to the host-owned Edits POJO, and onEditsChanged notifications.
 */

import { ATLAS_VERSION } from '../core/types';
import type { World } from '../core/types';
import type { Edits } from '../gen/edits';
import { emptyEdits, parseEdits, serializeEdits } from '../gen/edits';
import { cellPolygon } from '../mesh/dualmesh';

export interface EditorHooks {
  getWorld(): World | null;
  getEdits(): Edits;
  onEditsChanged(): void;
  canvasToLogical(ev: PointerEvent): { x: number; y: number };
}

interface SpatialIndex {
  size: number;
  cols: number;
  rows: number;
  buckets: number[][];
  x: Float32Array;
  y: Float32Array;
}

function storageKey(world: World): string {
  const extended = world.params as typeof world.params & { formationStep?: number };
  return `atlas/edits/v${ATLAS_VERSION}/${world.seed}/${extended.formationStep ?? 0}`;
}

function load(world: World): Edits {
  try {
    const text = localStorage.getItem(storageKey(world));
    return text === null ? emptyEdits() : parseEdits(text);
  } catch {
    return emptyEdits();
  }
}

function save(world: World, edits: Edits): void {
  try {
    localStorage.setItem(storageKey(world), serializeEdits(edits));
  } catch {
    // Storage may be unavailable or full; editing must continue in memory.
  }
}

function replaceEdits(target: Edits, source: Edits): void {
  target.names = source.names;
  target.p_nation = source.p_nation;
  target.r_nation = source.r_nation;
}

function centroids(world: World): { x: Float32Array; y: Float32Array } {
  const { mesh } = world;
  const x = new Float32Array(mesh.numRegions);
  const y = new Float32Array(mesh.numRegions);
  const polygon = new Float32Array(32);
  for (let r = 0; r < mesh.numRegions; r++) {
    const count = cellPolygon(mesh, r, polygon);
    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const cross = polygon[2 * i] * polygon[2 * j + 1] - polygon[2 * j] * polygon[2 * i + 1];
      twiceArea += cross;
      cx += (polygon[2 * i] + polygon[2 * j]) * cross;
      cy += (polygon[2 * i + 1] + polygon[2 * j + 1]) * cross;
    }
    if (twiceArea !== 0) {
      x[r] = cx / (3 * twiceArea);
      y[r] = cy / (3 * twiceArea);
    }
  }
  return { x, y };
}

function buildIndex(world: World): SpatialIndex {
  const size = Math.max(8, world.params.cellSpacing * 2);
  const cols = Math.max(1, Math.ceil(world.params.width / size));
  const rows = Math.max(1, Math.ceil(world.params.height / size));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  const { x, y } = centroids(world);
  for (let r = 0; r < x.length; r++) {
    const gx = Math.max(0, Math.min(cols - 1, Math.floor(x[r] / size)));
    const gy = Math.max(0, Math.min(rows - 1, Math.floor(y[r] / size)));
    buckets[gy * cols + gx].push(r);
  }
  return { size, cols, rows, buckets, x, y };
}

function nearestCell(index: SpatialIndex, px: number, py: number): number {
  const gx = Math.max(0, Math.min(index.cols - 1, Math.floor(px / index.size)));
  const gy = Math.max(0, Math.min(index.rows - 1, Math.floor(py / index.size)));
  let best = -1;
  let bestD = Infinity;
  for (let radius = 0; radius <= 2; radius++) {
    for (let y = Math.max(0, gy - radius); y <= Math.min(index.rows - 1, gy + radius); y++) {
      for (let x = Math.max(0, gx - radius); x <= Math.min(index.cols - 1, gx + radius); x++) {
        const bucket = index.buckets[y * index.cols + x];
        for (let i = 0; i < bucket.length; i++) {
          const r = bucket[i];
          const dx = index.x[r] - px;
          const dy = index.y[r] - py;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            best = r;
            bestD = d;
          }
        }
      }
    }
  }
  return best;
}

export function initEditor(hooks: EditorHooks): void {
  const sidebar = document.querySelector<HTMLElement>('#sidebar');
  const canvas = document.querySelector<HTMLCanvasElement>('#map');
  if (!sidebar || !canvas) return;

  const container = document.createElement('section');
  container.className = 'editor';
  const heading = document.createElement('h2');
  heading.textContent = 'Edit map';
  const borderHeading = document.createElement('h3');
  borderHeading.textContent = 'Borders';
  const swatches = document.createElement('div');
  swatches.className = 'editor-swatches';
  const fineLabel = document.createElement('label');
  const fine = document.createElement('input');
  fine.type = 'checkbox';
  fineLabel.append(fine, ' Fine brush');
  const hint = document.createElement('p');
  hint.textContent = 'Drag on the map to paint. Alt-drag makes land unclaimed.';
  const namesHeading = document.createElement('h3');
  namesHeading.textContent = 'Names';
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.placeholder = 'Filter names…';
  const names = document.createElement('div');
  names.className = 'editor-names';
  const style = document.createElement('style');
  style.textContent = '.editor{border-top:1px solid #8b7658;margin-top:1rem;padding-top:.6rem}.editor h2,.editor h3{margin:.5rem 0}.editor p{font-size:.78rem}.editor-swatches{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:.5rem}.editor-swatches button{width:25px;height:25px;border:2px solid transparent;border-radius:50%;padding:0}.editor-swatches button.active{border-color:#17130e}.editor>input{box-sizing:border-box;width:100%}.editor details{margin:.4rem 0}.editor-name{display:grid;grid-template-columns:5rem 1fr;gap:.35rem;align-items:center;margin:.2rem 0}.editor-name span{font-size:.72rem;overflow:hidden;text-overflow:ellipsis}.editor-name input{min-width:0}';
  container.append(heading, borderHeading, swatches, fineLabel, hint, namesHeading, filter, names, style);
  sidebar.append(container);

  let activeNation = 0;
  let indexedWorld: World | null = null;
  let index: SpatialIndex | null = null;
  let lastPaint = -1;

  const changed = (): void => {
    const world = hooks.getWorld();
    if (world) save(world, hooks.getEdits());
    hooks.onEditsChanged();
  };

  const rebuild = (): void => {
    const world = hooks.getWorld();
    swatches.replaceChildren();
    names.replaceChildren();
    if (!world) return;
    if (activeNation >= world.politics.nations.length) activeNation = 0;
    for (let n = 0; n < world.politics.nations.length; n++) {
      const nation = world.politics.nations[n];
      const button = document.createElement('button');
      button.type = 'button';
      button.title = nation.name;
      button.style.backgroundColor = nation.color;
      button.classList.toggle('active', n === activeNation);
      button.addEventListener('click', () => {
        activeNation = n;
        for (const child of swatches.children) child.classList.remove('active');
        button.classList.add('active');
      });
      swatches.append(button);
    }
    const groups = [
      ['Settlements', 'settlement', world.settlements], ['Provinces', 'province', world.provinces],
      ['Nations', 'nation', world.politics.nations], ['Cultures', 'culture', world.politics.cultures],
      ['Rivers', 'river', world.features.rivers], ['Lakes', 'lake', world.features.lakes],
      ['Seas', 'sea', world.features.seas], ['Ranges', 'range', world.features.ranges],
    ] as const;
    for (const [title, kind, list] of groups) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${title} (${list.length})`;
      details.append(summary);
      for (let i = 0; i < list.length; i++) {
        const id = `${kind}:${i}`;
        const row = document.createElement('label');
        row.className = 'editor-name';
        row.dataset.search = `${title} ${list[i].name} ${id}`.toLowerCase();
        const caption = document.createElement('span');
        caption.textContent = list[i].name;
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = list[i].name;
        input.value = hooks.getEdits().names[id] ?? '';
        input.addEventListener('change', () => {
          const value = input.value.trim();
          if (value === '') delete hooks.getEdits().names[id];
          else hooks.getEdits().names[id] = value;
          changed();
        });
        row.append(caption, input);
        details.append(row);
      }
      names.append(details);
    }
    indexedWorld = world;
    index = buildIndex(world);
  };

  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const row of names.querySelectorAll<HTMLElement>('.editor-name')) {
      row.hidden = query !== '' && !(row.dataset.search ?? '').includes(query);
    }
  });

  const paint = (ev: PointerEvent): void => {
    const world = hooks.getWorld();
    if (!world) return;
    if (indexedWorld !== world || index === null) rebuild();
    if (index === null) return;
    const point = hooks.canvasToLogical(ev);
    const r = nearestCell(index, point.x, point.y);
    if (r < 0 || r === lastPaint) return;
    const owner = ev.altKey ? -1 : activeNation;
    if (fine.checked) hooks.getEdits().r_nation[String(r)] = owner;
    else {
      const p = world.r_province[r];
      if (p < 0) return;
      hooks.getEdits().p_nation[String(p)] = owner;
    }
    lastPaint = r;
    changed();
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    lastPaint = -1;
    canvas.setPointerCapture(ev.pointerId);
    paint(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if ((ev.buttons & 1) !== 0) paint(ev);
  });
  canvas.addEventListener('pointerup', (ev) => {
    lastPaint = -1;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  });
  window.addEventListener('atlas-world-changed', () => {
    const world = hooks.getWorld();
    if (!world) return;
    replaceEdits(hooks.getEdits(), load(world));
    rebuild();
    hooks.onEditsChanged();
  });
  rebuild();
}
