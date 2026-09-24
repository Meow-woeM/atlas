/**
 * gen/tectonics.test.ts — stage 3.5 against real meshes at DEFAULT_PARAMS and at a small
 * 400x300 / spacing-16 world. Worlds are built once at describe time; per-element invariants are
 * counted in plain loops and asserted once. Nothing here pins a plate to a position: the tests are
 * about the partition being total and well-formed, the continental cores being spread rather than
 * adjacent, and the whole stage being a pure function of its seed.
 */
import { describe, it, expect } from 'vitest';
import { fork } from '../core/rng';
import { DEFAULT_PARAMS } from '../core/types';
import type { Mesh, WorldParams } from '../core/types';
import { generatePoints } from '../mesh/poisson';
import { buildMesh, cellCentroids, r_circulate_r } from '../mesh/dualmesh';
import { computeTectonics } from './tectonics';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, width: 400, height: 300, cellSpacing: 16 };

function makeMesh(params: WorldParams, seed: string): Mesh {
  const { points, numBoundary } = generatePoints(params, fork(seed, 'points'));
  return buildMesh(points, numBoundary);
}

describe('tectonics', () => {
  for (const [label, params, seed] of [
    ['default', DEFAULT_PARAMS, 'atlas'],
    ['small', SMALL, 'atlas'],
  ] as const) {
    describe(`${label} (${params.width}x${params.height} r=${params.cellSpacing})`, () => {
      const mesh = makeMesh(params, seed);
      const tec = computeTectonics(mesh, params, fork(seed, 'tectonics'));

      it('partitions every region onto exactly one plate in range', () => {
        let bad = 0;
        const used = new Set<number>();
        for (let r = 0; r < mesh.numRegions; r++) {
          const p = tec.r_plate[r];
          if (p < 0 || p >= tec.numPlates) bad++;
          else used.add(p);
        }
        expect(bad).toBe(0);
        // Every plate that was seeded actually grew: a BFS from distinct seeds cannot leave one empty.
        expect(used.size).toBe(tec.numPlates);
      });

      it('grows plates as connected regions of the cell graph', () => {
        // Flood one plate from its lowest-index cell and check the flood reaches all of it: a
        // multi-source BFS cannot hand a plate a detached island.
        //
        // The adjacency has to be symmetrised first. r_circulate_r breaks its walk at the hull
        // (`s_opposite_s < 0`), so on the boundary ring it reports r -> q without q -> r: on the
        // default mesh there are exactly 464 such one-way pairs, one per ring cell. Flooding with
        // the raw relation walks into a ring cell and cannot get back out, which looks exactly
        // like a disconnected plate. Any graph algorithm over the cell graph that assumes
        // symmetry has the same trap.
        const nbrs: number[] = [];
        const adj: Set<number>[] = [];
        for (let r = 0; r < mesh.numRegions; r++) adj.push(new Set<number>());
        for (let r = 0; r < mesh.numRegions; r++) {
          r_circulate_r(mesh, r, nbrs);
          for (let i = 0; i < nbrs.length; i++) { adj[r].add(nbrs[i]); adj[nbrs[i]].add(r); }
        }
        let disconnected = 0;
        for (let p = 0; p < tec.numPlates; p++) {
          let first = -1, total = 0;
          for (let r = 0; r < mesh.numRegions; r++) {
            if (tec.r_plate[r] !== p) continue;
            if (first < 0) first = r;
            total++;
          }
          if (first < 0) continue;
          const seen = new Uint8Array(mesh.numRegions);
          const stack = [first];
          seen[first] = 1;
          let reached = 0;
          while (stack.length > 0) {
            const r = stack.pop() as number;
            reached++;
            for (const q of adj[r]) {
              if (seen[q] === 0 && tec.r_plate[q] === p) { seen[q] = 1; stack.push(q); }
            }
          }
          if (reached !== total) disconnected++;
        }
        expect(disconnected).toBe(0);
      });

      it('has finite velocities, craton in 0..1 and finite stress', () => {
        let badV = 0, badC = 0, badS = 0;
        for (let i = 0; i < tec.numPlates; i++) {
          if (!Number.isFinite(tec.plateVx[i]) || !Number.isFinite(tec.plateVy[i])) badV++;
        }
        for (let r = 0; r < mesh.numRegions; r++) {
          if (!(tec.r_craton[r] >= 0 && tec.r_craton[r] <= 1)) badC++;
          if (!Number.isFinite(tec.r_stress[r])) badS++;
        }
        expect(badV).toBe(0);
        expect(badC).toBe(0);
        expect(badS).toBe(0);
      });

      it('carries both convergent and divergent boundaries', () => {
        let up = 0, down = 0;
        for (let r = 0; r < mesh.numRegions; r++) {
          if (tec.r_stress[r] > 0.05) up++;
          else if (tec.r_stress[r] < -0.05) down++;
        }
        expect(up).toBeGreaterThan(0);
        expect(down).toBeGreaterThan(0);
      });

      it('is deterministic for the same seed and differs for another', () => {
        const again = computeTectonics(mesh, params, fork(seed, 'tectonics'));
        expect(again.r_plate).toEqual(tec.r_plate);
        expect(again.r_craton).toEqual(tec.r_craton);
        expect(again.r_stress).toEqual(tec.r_stress);
        const other = computeTectonics(mesh, params, fork(seed + '-other', 'tectonics'));
        expect(other.r_plate).not.toEqual(tec.r_plate);
      });
    });
  }

  it('makes the continental core count track landFraction, with continents as the floor', () => {
    const mesh = makeMesh(DEFAULT_PARAMS, 'cores');
    for (const [continents, landFraction, want] of [
      [2, 0.42, 4],    // round(9 * 0.42) = 4 wins over the floor of 2
      [3, 0.42, 4],
      [1, 0.1, 1],     // round(9 * 0.1) = 1
      [3, 0.1, 3],     // the floor wins
    ] as const) {
      const p: WorldParams = { ...DEFAULT_PARAMS, continents, landFraction };
      const tec = computeTectonics(mesh, p, fork('cores', 'tectonics'));
      let cont = 0;
      for (let i = 0; i < tec.numPlates; i++) if (tec.plateOceanic[i] === 0) cont++;
      expect(cont, `continents=${continents} landFraction=${landFraction}`).toBe(want);
    }
  });

  it('spreads the continental cores rather than clustering them', () => {
    // Adjacent cratons merge into a supercontinent whose interior the climate stage turns into a
    // continent-sized desert, so farthest-point selection is load-bearing, not cosmetic. Over
    // several seeds the mean gap between continental plate centroids must beat the mean gap
    // between all plate centroids.
    const mesh = makeMesh(DEFAULT_PARAMS, 'spread');
    const { r_px, r_py } = cellCentroids(mesh);
    let better = 0, total = 0;
    for (const seed of ['spread', 'atlas', 'amberfell', 'test-1', 'zzzzzzzz']) {
      const tec = computeTectonics(mesh, DEFAULT_PARAMS, fork(seed, 'tectonics'));
      const cx = new Float64Array(tec.numPlates);
      const cy = new Float64Array(tec.numPlates);
      const cnt = new Float64Array(tec.numPlates);
      for (let r = 0; r < mesh.numRegions; r++) {
        const p = tec.r_plate[r];
        cx[p] += r_px[r]; cy[p] += r_py[r]; cnt[p]++;
      }
      for (let i = 0; i < tec.numPlates; i++) { cx[i] /= cnt[i]; cy[i] /= cnt[i]; }
      const meanGap = (idx: number[]): number => {
        let sum = 0, pairs = 0;
        for (let a = 0; a < idx.length; a++) {
          for (let b = a + 1; b < idx.length; b++) {
            sum += Math.hypot(cx[idx[a]] - cx[idx[b]], cy[idx[a]] - cy[idx[b]]);
            pairs++;
          }
        }
        return pairs > 0 ? sum / pairs : 0;
      };
      const all: number[] = [], cont: number[] = [];
      for (let i = 0; i < tec.numPlates; i++) { all.push(i); if (tec.plateOceanic[i] === 0) cont.push(i); }
      if (cont.length < 2) continue;
      total++;
      if (meanGap(cont) > meanGap(all)) better++;
    }
    expect(total).toBeGreaterThan(0);
    expect(better).toBe(total);
  });
});
