/**
 * Phase 1 merge harness — qty × spans × negation × vague-marker semantics.
 *
 * Separation contract: grams wrong = qty bug, food wrong = retrieval bug.
 * These tests run `interpretTextSync` with `foods = null` (no retrieval),
 * so every assertion here pins the pre-retrieval half only:
 *  - nearest-qty attachment incl. the ≤30-char rule (`./index:nearestQty`)
 *  - negation pre-retrieval drop (truncation + leading-strip + window)
 *  - vague-marker estimates vs flagged defaults (`wasDefault`)
 */
import { describe, it, expect } from 'vitest';
import { interpretTextSync, nearestQty } from './index';
import { parseQuantities } from './unit-parser';
import { resolveVagueMarker, governedByNegation } from './lexicon';
import type { Food } from '@data/types';

function fakeFood(id: string, name: string): Food {
  return {
    id,
    canonical_name: name,
    normalized_name: name,
    calories_per_100g: 100,
    protein_per_100g: 10,
    carbs_per_100g: 10,
    fat_per_100g: 5,
    water_per_100g: 60,
    nutrition_basis: 'per_100g',
    source_type: 'user_entered',
    source_reference: null,
    confidence: 1.0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('merge: nearest-qty attachment', () => {
  it('attaches adjacent qty, ignores qty >30 chars away', () => {
    const qty = parseQuantities('200g chicken')[0];
    expect(qty).toBeDefined();
    expect(nearestQty([5, 12], [qty])).toBe(qty);
    expect(nearestQty([50, 60], [qty])).toBeNull();
  });

  it('250g chicken / 100g rice stay paired', () => {
    const out = interpretTextSync('250g chicken breast, 100g rice', null);
    expect(out.length).toBe(2);
    expect(out[0].amountG).toBe(250);
    expect(out[0].wasDefault).toBe(false);
    expect(out[1].amountG).toBe(100);
    expect(out[1].wasDefault).toBe(false);
  });
});

describe('merge: negation pre-retrieval drop', () => {
  it('100g rice without sauce → rice only, sauce never a span', () => {
    const out = interpretTextSync('100g rice without sauce', null);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName.toLowerCase()).toContain('rice');
    expect(out[0].canonicalName.toLowerCase()).not.toContain('sauce');
    expect(out[0].amountG).toBe(100);
  });

  it('chicken salad without dressing → chicken only, flagged default', () => {
    const out = interpretTextSync('chicken salad without dressing', null);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName.toLowerCase()).not.toContain('dressing');
    expect(out[0].wasDefault).toBe(true);
  });

  it('sans (FR) truncates', () => {
    const out = interpretTextSync('riz sans sauce', null);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName.toLowerCase()).not.toContain('sauce');
  });

  it('noodles are not a negation ("no" boundary check)', () => {
    expect(governedByNegation('I want noodles', 7)).toBe(false);
    const out = interpretTextSync('noodles', null);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName.toLowerCase()).toContain('noodles');
  });

  it('hold the (multi-word) drops the governed span', () => {
    expect(governedByNegation('burger hold the fries', 17)).toBe(true);
  });
});

describe('merge: vague markers vs flagged defaults', () => {
  it('a side of rice → 125g estimate, not a default', () => {
    const out = interpretTextSync('chicken breast with a side of white rice', null);
    expect(out.length).toBe(1);
    expect(out[0].amountG).toBe(125);
    expect(out[0].rawUnit).toBe('~side');
    expect(out[0].wasDefault).toBe(false);
    expect(out[0].confidence).toBeLessThanOrEqual(0.7);
  });

  it('a pinch of salt → 0.5g', () => {
    const out = interpretTextSync('a pinch of salt', null);
    expect(out.length).toBe(1);
    expect(out[0].amountG).toBeCloseTo(0.5);
    expect(out[0].wasDefault).toBe(false);
  });

  it('some rice → acknowledged vague, flagged default (no safe estimate)', () => {
    expect(resolveVagueMarker('some rice')).toBeNull();
    const out = interpretTextSync('some rice', null);
    expect(out[0].wasDefault).toBe(true);
  });

  it('bare banana → flagged default, confidence capped at 0.65', () => {
    const out = interpretTextSync('banana', null);
    expect(out.length).toBe(1);
    expect(out[0].amountG).toBe(100);
    expect(out[0].wasDefault).toBe(true);
    expect(out[0].confidence).toBeLessThanOrEqual(0.65);
  });

  it('explicit qty is never flagged', () => {
    const out = interpretTextSync('250g chicken', null);
    expect(out[0].wasDefault).toBe(false);
  });
});

describe('merge: CJK survival (tokenizer range fix)', () => {
  it('bare CJK input yields a span instead of vanishing', () => {
    const out = interpretTextSync('鸡肉', null);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName).toBe('鸡肉');
    expect(out[0].wasDefault).toBe(true);
  });

  it('CJK span pairs with adjacent qty', () => {
    const out = interpretTextSync('250g 鸡肉', null);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName).toBe('鸡肉');
    expect(out[0].amountG).toBe(250);
    expect(out[0].wasDefault).toBe(false);
  });

  it('CJK query retrieves a CJK library row (aliases seedable)', () => {
    const foods = [fakeFood('f-zh', '鸡肉'), fakeFood('f-en', 'Chicken breast, grilled')];
    const out = interpretTextSync('鸡肉', foods);
    expect(out.length).toBe(1);
    expect(out[0].canonicalName).toBe('鸡肉');
  });
});

describe('merge: script routing (recorded hint, never a gate)', () => {
  it('tags single-script spans', () => {
    expect(interpretTextSync('دجاج مشوي', null)[0].script).toBe('arabic');
    expect(interpretTextSync('grilled chicken', null)[0].script).toBe('latin');
  });

  it('mixed-script input keeps full cross-lexicon matching', () => {
    // Router must not narrow matching: qty still pairs, span survives,
    // and the tag simply records the mix for future dispatch.
    const out = interpretTextSync('250g دجاج grille', null);
    expect(out.length).toBe(1);
    expect(out[0].amountG).toBe(250);
    expect(out[0].wasDefault).toBe(false);
    expect(out[0].script).toBeDefined();
  });
});
