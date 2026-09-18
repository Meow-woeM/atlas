/**
 * gen/edits.ts — Post-generation edit orchestration and persistence format.
 * RNG stream: none. Inputs: a generated World and plain edit records. Outputs: deterministic,
 * in-place delegation to the names and politics writers, plus tolerant JSON serialization.
 */

import type { World } from '../core/types';
import { applyNameEdits } from './names';
import { applyPoliticalEdits } from './politics';

export interface Edits {
  names: Record<string, string>;
  p_nation: Record<string, number>;
  r_nation: Record<string, number>;
}

const EDITABLE_KINDS = new Set([
  'settlement', 'province', 'nation', 'culture', 'river', 'lake', 'sea', 'range',
]);

export function emptyEdits(): Edits {
  return { names: {}, p_nation: {}, r_nation: {} };
}

export function editsAreEmpty(e: Edits): boolean {
  return Object.keys(e.names).length === 0 &&
    Object.keys(e.p_nation).length === 0 && Object.keys(e.r_nation).length === 0;
}

export function applyEdits(world: World, edits: Edits): void {
  applyNameEdits(world, edits);
  applyPoliticalEdits(world, edits);
}

export function serializeEdits(e: Edits): string {
  return JSON.stringify(e);
}

function parseIndex(key: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(key)) return null;
  const value = Number(key);
  return Number.isSafeInteger(value) && value <= 0x7fffffff ? value : null;
}

function readOwners(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, owner] of Object.entries(value)) {
    if (parseIndex(key) === null || !Number.isInteger(owner) || (owner as number) < -1 || (owner as number) > 0x7fff) continue;
    out[key] = owner as number;
  }
  return out;
}

export function parseEdits(text: string): Edits {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return emptyEdits();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyEdits();
  const record = value as Record<string, unknown>;
  const names: Record<string, string> = {};
  const rawNames = record.names;
  if (typeof rawNames === 'object' && rawNames !== null && !Array.isArray(rawNames)) {
    for (const [id, name] of Object.entries(rawNames)) {
      const colon = id.lastIndexOf(':');
      if (colon < 1 || typeof name !== 'string' || name === '') continue;
      if (!EDITABLE_KINDS.has(id.slice(0, colon)) || parseIndex(id.slice(colon + 1)) === null) continue;
      names[id] = name;
    }
  }
  return { names, p_nation: readOwners(record.p_nation), r_nation: readOwners(record.r_nation) };
}
