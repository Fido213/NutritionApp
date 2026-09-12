import { describe, it, expect } from 'vitest';
import { splitComboSegments, groundSegments, segmentResolves } from './combo-split';
import type { Food } from '@data/types';

function mkFood(canonical: string, normalized: string): Food {
  return {
    id: canonical, canonical_name: canonical, normalized_name: normalized,
    calories_per_100g: 100, protein_per_100g: 10, carbs_per_100g: 20, fat_per_100g: 5,
    water_per_100g: 0, nutrition_basis: 'per_100g', source_type: 'imported',
    source_reference: null, confidence: null, created_at: '', updated_at: '',
  };
}

const LIB = [
  mkFood('Egg, whole, raw, fresh', 'egg whole raw fresh'),
  mkFood('Bacon, pork, cured', 'bacon pork cured'),
  mkFood('Oats, raw', 'oats raw'),
];

describe('splitComboSegments', () => {
  it('splits commas, and/with/&, plus', () => {
    expect(splitComboSegments('eggs, bacon')).toEqual(['eggs', 'bacon']);
    expect(splitComboSegments('eggs and bacon')).toEqual(['eggs', 'bacon']);
    expect(splitComboSegments('oats with honey')).toEqual(['oats', 'honey']);
    expect(splitComboSegments('egg & bacon')).toEqual(['egg', 'bacon']);
    expect(splitComboSegments('rice + peas')).toEqual(['rice', 'peas']);
  });

  it('returns null for single foods (fast out, incl. boundary words inside names)', () => {
    expect(splitComboSegments('chicken')).toBeNull();
    expect(splitComboSegments('')).toBeNull();
    // 'sandwich' contains 'and' but no boundary split fires.
    expect(splitComboSegments('sandwich')).toBeNull();
  });
});

describe('groundSegments', () => {
  it('maps parts to tiling sub-spans', () => {
    const g = groundSegments('eggs, bacon', 0, ['eggs', 'bacon']);
    expect(g).toEqual([
      { text: 'eggs', span: [0, 4], script: undefined },
      { text: 'bacon', span: [6, 11], script: undefined },
    ]);
  });

  it('aborts on unfindable parts', () => {
    expect(groundSegments('eggs, bacon', 0, ['eggs', 'ham'])).toBeNull();
  });
});

describe('segmentResolves', () => {
  it('resolves exact keys and same-concept heads', () => {
    expect(segmentResolves(LIB, 'eggs')).toBe(true); // head: Egg, whole, ...
    expect(segmentResolves(LIB, 'bacon')).toBe(true);
    expect(segmentResolves(LIB, 'oats raw')).toBe(true); // exact key
  });

  it('rejects unknown foods and empty concepts', () => {
    expect(segmentResolves(LIB, 'honey')).toBe(false);
    expect(segmentResolves(LIB, 'quinoa')).toBe(false);
    expect(segmentResolves([], 'eggs')).toBe(false);
  });
});
