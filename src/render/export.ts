/**
 * render/export.ts — PNG export (section 6.4). No RNG stream of its own: it calls renderWorld,
 * whose ink streams are forked from world.seed, so the export is the screen picture at scale k.
 *
 * Inputs:  World, PoliticalView, k in {1, 2, 4} (device px per logical px) and the render
 *          toggles without `scale`.
 * Outputs: exportPng resolves to a PNG Blob of (width*k) x (height*k) device px drawn on a
 *          detached canvas; downloadBlob hands a Blob to the browser as a file download.
 */

import type { PoliticalView, RenderOptions, World } from '../core/types';
import { renderWorld } from './painter';

export function exportPng(world: World, view: PoliticalView, k: 1 | 2 | 4, opts: Omit<RenderOptions, 'scale'>): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(world.params.width * k);
  canvas.height = Math.round(world.params.height * k);
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return Promise.reject(new Error('exportPng: could not create a 2d context'));
  }
  const renderOpts: RenderOptions = { ...opts, scale: k };
  renderWorld(world, view, ctx, renderOpts);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('exportPng: canvas.toBlob returned null'));
      else resolve(blob);
    }, 'image/png');
  });
}

/** Triggers a browser download of `blob` as `filename` via a temporary object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been dispatched; a short delay keeps older browsers happy.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
