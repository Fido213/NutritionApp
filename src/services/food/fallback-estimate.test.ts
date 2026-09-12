import { describe, it, expect } from 'vitest';
import type { Food } from '@data/types';
import {
  medianFallbackEstimate,
  fallbackConfidence,
  MIN_FALLBACK_SUPPORT,
} from './fallback-estimate';

function mkFood(canonical: string, kcal: number, protein = 10, carbs = 20, fat = 5): Food {
  return {
    id: canonical,
    canonical_name: canonical,
    normalized_name: canonical.toLowerCase().replace(/[^a-z0-9]/g, ''),
    calories_per_100g: kcal,
    protein_per_100g: protein,
    carbs_per_100g: carbs,
    fat_per_100g: fat,
    water_per_100g: 0,
    nutrition_basis: 'per_100g',
    source_type: 'imported',
    source_reference: null,
    confidence: null,
    created_at: '',
    updated_at: '',
  };
}

const CHICKENS = [150, 160, 165, 170, 180, 200].map(k => mkFood(`Chicken, breast, cut ${k}`, k));

describe('medianFallbackEstimate (P2)', () => {
  it('returns the head median once support reaches the floor', () => {
    const est = medianFallbackEstimate(CHICKENS, 'chicken');
    expect(est).not.toBeNull();
    expect(est!.level).toBe('L1');
    expect(est!.support).toBe(CHICKENS.length);
    // Median of [150,160,165,170,180,200] = (165+170)/2.
    expect(est!.nutrients.kcal).toBeCloseTo(167.5, 5);
    expect(est!.confidence).toBeLessThanOrEqual(0.6);
  });

  it('returns null below the support floor (caller keeps the flat default)', () => {
    expect(medianFallbackEstimate(CHICKENS.slice(0, MIN_FALLBACK_SUPPORT - 1), 'chicken')).toBeNull();
    expect(medianFallbackEstimate(CHICKENS, 'quinoa')).toBeNull();
    expect(medianFallbackEstimate([], 'chicken')).toBeNull();
  });

  it('never matches across concept heads (no Almond Chicken for chicken)', () => {
    const mixed = [...CHICKENS, mkFood('Almond Chicken', 500), mkFood('Chicken egg boiled', 400)];
    const est = medianFallbackEstimate(mixed, 'chicken');
    expect(est!.support).toBe(CHICKENS.length);
    expect(est!.nutrients.kcal).toBeCloseTo(167.5, 5);
  });

  it('prefers the prep-filtered pool when the query names a preparation', () => {
    const rows = [
      ...[150, 155, 160, 165, 170].map(k => mkFood(`Chicken, breast, boiled, batch ${k}`, k, 30, 0, 3)),
      ...[300, 320, 340, 360, 380].map(k => mkFood(`Chicken, breast, fried, batch ${k}`, k, 20, 10, 20)),
    ];
    const est = medianFallbackEstimate(rows, 'boiled chicken');
    expect(est!.level).toBe('L1p');
    expect(est!.nutrients.kcal).toBe(160);
  });

  it('excludes the self row so a re-log can never vote for itself', () => {
    const rows = [150, 160, 165, 170, 180, 200].map(k => mkFood(`Chicken breast, batch ${k}`, k));
    const self = mkFood('Chicken breast, grilled', 165);
    const est = medianFallbackEstimate([...rows, self], 'chicken breast', self.normalized_name);
    expect(est).not.toBeNull();
    expect(est!.support).toBe(rows.length);
  });

  it('returns null when supporters carry no usable numbers', () => {
    const empty = CHICKENS.map(f => ({ ...f, calories_per_100g: null }));
    expect(medianFallbackEstimate(empty, 'chicken')).toBeNull();
  });

  it('caps confidence at 0.6 no matter the support', () => {
    expect(fallbackConfidence(5)).toBeCloseTo(0.5, 5);
    expect(fallbackConfidence(1000)).toBe(0.6);
  });
});
