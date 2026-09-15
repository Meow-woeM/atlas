/**
 * core/ids.ts — Stage 0 helper (no stage of its own): stable cross-kind entity references.
 * RNG stream: none. Inputs: (kind, index) or an Id string. Outputs: the `${kind}:${index}` Id
 * used by the history log, the wiki and URLs; hot loops keep using the integer index.
 */

import type { EntityKind, Id } from './types';

/** `${kind}:${index}`; index must be a non-negative integer (array index per kind). */
export function mkId(kind: EntityKind, index: number): Id {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`mkId: index must be a non-negative integer, got ${index}`);
  }
  return `${kind}:${index}`;
}

/** Inverse of mkId. Throws on a malformed id (no ':' or a non-integer index). */
export function parseId(id: Id): { kind: EntityKind; index: number } {
  const colon = id.lastIndexOf(':');
  if (colon <= 0) throw new SyntaxError(`parseId: malformed id '${id}'`);
  const kind = id.slice(0, colon) as EntityKind;
  const tail = id.slice(colon + 1);
  const index = Number(tail);
  if (tail === '' || !Number.isInteger(index) || index < 0) {
    throw new SyntaxError(`parseId: malformed id '${id}'`);
  }
  return { kind, index };
}
