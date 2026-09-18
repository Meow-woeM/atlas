/**
 * gen/edits.test.ts — Post-generation edit contract tests.
 * RNG stream: generated fixtures use the normal named streams. Inputs: small deterministic Worlds
 * and JSON strings. Outputs: assertions for application, tolerance, and round trips.
 */

import { describe, expect, it } from 'vitest';
import { generate } from './world';
import { applyEdits, editsAreEmpty, emptyEdits, parseEdits, serializeEdits } from './edits';

function smallWorld() {
  return generate('edit-tests', {
    width: 480, height: 360, cellSpacing: 16, provinceSpacing: 40, settlementsMax: 20, nationsMax: 4,
  });
}

describe('edits', () => {
  it('creates an empty plain edit layer and leaves a world byte-identical', () => {
    const actual = smallWorld();
    const expected = smallWorld();
    actual.timings = {};
    expected.timings = {};
    const edits = emptyEdits();
    expect(editsAreEmpty(edits)).toBe(true);
    applyEdits(actual, edits);
    expect(actual).toEqual(expected);
    expect(JSON.parse(JSON.stringify(edits))).toEqual(edits);
  });

  it('applies valid names and ownership while ignoring out-of-range keys', () => {
    const world = smallWorld();
    expect(world.politics.nations.length).toBeGreaterThan(0);
    applyEdits(world, {
      names: { 'settlement:0': 'New Name', 'settlement:999999': 'Nope', 'road:0': 'Nope' },
      p_nation: { '0': 0, '999999': 0 },
      r_nation: { '0': -1, '999999': 0 },
    });
    expect(world.settlements[0].name).toBe('New Name');
    expect(world.politics.p_nation[0]).toBe(0);
    expect(world.politics.r_nation[0]).toBe(-1);
  });

  it('serializes and tolerantly parses edit records', () => {
    const edits = {
      names: { 'nation:1': 'The Amber Realm' },
      p_nation: { '2': -1 },
      r_nation: { '14': 3 },
    };
    expect(parseEdits(serializeEdits(edits))).toEqual(edits);
    expect(parseEdits('{bad json')).toEqual(emptyEdits());
    expect(parseEdits(JSON.stringify({
      names: { 'nation:1': 'Valid', 'unknown:2': 'Drop', 'nation:-1': 'Drop' },
      p_nation: { '2': 1, '-1': 0, nope: 2 },
      r_nation: { '3': -1, '4': -2 },
      surprise: true,
    }))).toEqual({ names: { 'nation:1': 'Valid' }, p_nation: { '2': 1 }, r_nation: { '3': -1 } });
  });
});
