/**
 * Stage-2 rerank tests: feature semantics + ordering on fixtures.
 * Real-corpus validation (targeted + gate) runs in the workbench, not here.
 */
import { describe, it, expect } from 'vitest';
import {
  rerankFeatures, rerankScore, rerankTop, RERANK_WEIGHTS,
  type RerankCandidate,
} from './rerank';

const q = (s: string) => s.toLowerCase().split(/\s+/);
const cand = (over: Partial<RerankCandidate> & { id: string }): RerankCandidate => ({
  toks: [], head: [], lexRank: null, semRank: null, ...over,
});

describe('rerankFeatures', () => {
  it('flags head equality, prep recall, coverage, order and penalty', () => {
    const f = rerankFeatures(
      q('boiled chicken'), ['chicken'], ['boiled'],
      cand({ id: 'x', toks: q('chicken breast boiled'), head: ['chicken'], lexRank: 2, semRank: 5 }),
    );
    // [headExact, prepRecall, coverage, orderKept, lexRR, semRR, extraPrep, priorCount]
    expect(f[0]).toBe(1);
    expect(f[1]).toBe(1);
    expect(f[2]).toBe(1);
    // Query order (boiled, chicken) is NOT doc order (chicken, …, boiled).
    expect(f[3]).toBe(0.5);
    expect(f[4]).toBeCloseTo(1 / 62, 6);
    expect(f[5]).toBeCloseTo(1 / 65, 6);
    expect(f[6]).toBe(0);
    expect(f[7]).toBe(0);
  });

  it('saturates the personal prior and defaults the unknown to zero', () => {
    const known = rerankFeatures(
      q('chicken'), ['chicken'], [],
      cand({ id: 'x', toks: ['chicken'], lexRank: 3, semRank: 3, logCount: 28 }),
    );
    expect(known[7]).toBeCloseTo(28 / 33, 9);
    const fresh = rerankFeatures(
      q('chicken'), ['chicken'], [],
      cand({ id: 'y', toks: ['chicken'], lexRank: 3, semRank: 3 }),
    );
    expect(fresh[7]).toBe(0);
  });

  it('marks unrequested preservation words for the penalty', () => {
    const f = rerankFeatures(
      q('apple'), ['apple'], [],
      cand({ id: 'x', toks: q('apple dried'), head: ['apple', 'dried'], lexRank: 1, semRank: 1 }),
    );
    expect(f[0]).toBe(0);
    expect(f[6]).toBe(1);
  });

  it('handles missing ranks as zero signal', () => {
    const f = rerankFeatures(q('rice'), ['rice'], [], cand({ id: 'x', toks: ['rice'] }));
    expect(f[4]).toBe(0);
    expect(f[5]).toBe(0);
    expect(f[3]).toBe(1);
  });
});

describe('rerankScore', () => {
  it('is the dot product with the weights', () => {
    expect(rerankScore([1, 1, 1, 1, 0, 0, 0, 0.5],
      { headExact: 2, prepRecall: 1.5, coverage: 1, orderKept: 0.5, lexRR: 0, semRR: 0, extraPrep: -1, priorCount: 2 })).toBeCloseTo(6, 9);
  });
});

describe('rerankTop', () => {
  it('prefers the head-matching candidate under starter weights', () => {
    const order = rerankTop('boiled chicken', [
      { id: 'egg', text: 'Chicken egg boiled', head: ['chicken', 'egg', 'boiled'], lexRank: 1, semRank: 2 },
      { id: 'breast', text: 'Chicken, breast, boiled', head: ['chicken'], lexRank: 2, semRank: 5 },
    ], { ...RERANK_WEIGHTS, headExact: 2, prepRecall: 1.5, coverage: 1, orderKept: 0.5, lexRR: 1, semRR: 0.6, extraPrep: -0.5 });
    expect(order[0]).toBe('breast');
  });

  it('is stable for ties (input order preserved)', () => {
    const order = rerankTop('rice', [
      { id: 'a', text: 'Rice white', head: ['rice'], lexRank: 1, semRank: 1 },
      { id: 'b', text: 'Rice brown', head: ['rice'], lexRank: 1, semRank: 1 },
    ]);
    expect(order).toEqual(['a', 'b']);
  });

  it('lets logged counts break ties (personal prior)', () => {
    const items = [
      { id: 'a', text: 'Apple', head: ['apple'], lexRank: 1, semRank: 1, logCount: 0 },
      { id: 'b', text: 'Apple', head: ['apple'], lexRank: 1, semRank: 1, logCount: 10 },
    ];
    expect(rerankTop('apple', items)).toEqual(['b', 'a']);
  });
});
