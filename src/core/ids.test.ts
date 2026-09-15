import { describe, it, expect } from 'vitest';
import { mkId, parseId } from './ids';
import type { EntityKind, Id } from './types';

const KINDS: EntityKind[] = [
  'settlement', 'province', 'nation', 'culture', 'river', 'lake', 'sea', 'range',
  'road', 'ruler', 'war', 'religion', 'battle',
];

describe('ids', () => {
  it('mkId formats kind:index', () => {
    expect(mkId('river', 3)).toBe('river:3');
    expect(mkId('settlement', 0)).toBe('settlement:0');
    const id: Id = mkId('nation', 12);
    expect(id).toBe('nation:12');
  });

  it('parseId inverts mkId for every kind and a range of indices', () => {
    for (const kind of KINDS) {
      for (const index of [0, 1, 7, 140, 65535, 123456789]) {
        expect(parseId(mkId(kind, index))).toEqual({ kind, index });
      }
    }
  });

  it('mkId inverts parseId', () => {
    for (const id of ['sea:2', 'range:0', 'battle:999'] as Id[]) {
      const { kind, index } = parseId(id);
      expect(mkId(kind, index)).toBe(id);
    }
  });

  it('rejects malformed ids and bad indices', () => {
    expect(() => parseId('river' as Id)).toThrow();
    expect(() => parseId('river:' as Id)).toThrow();
    expect(() => parseId('river:x' as Id)).toThrow();
    expect(() => parseId('river:1.5' as Id)).toThrow();
    expect(() => parseId('river:-1' as Id)).toThrow();
    expect(() => parseId(':3' as Id)).toThrow();
    expect(() => mkId('river', 1.5)).toThrow();
    expect(() => mkId('river', -1)).toThrow();
    expect(() => mkId('river', NaN)).toThrow();
  });
});
