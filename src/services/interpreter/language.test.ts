/**
 * Script router tests — deterministic dispatch slice (no model, no deps).
 * Contract: disjoint scripts resolve instantly; digits/units never outvote
 * words; genuinely mixed input reports mixed (matching stays cross-lexicon).
 */
import { describe, it, expect } from 'vitest';
import { detectScript } from './language';

describe('detectScript', () => {
  it('resolves disjoint scripts', () => {
    expect(detectScript('grilled chicken breast')).toBe('latin');
    expect(detectScript('دجاج مشوي')).toBe('arabic');
    expect(detectScript('鸡肉')).toBe('cjk');
    expect(detectScript('курица')).toBe('cyrillic');
  });

  it('ignores digits and units', () => {
    expect(detectScript('250g دجاج')).toBe('arabic');
    expect(detectScript('250g chicken')).toBe('latin');
    expect(detectScript('250')).toBe('neutral');
    expect(detectScript('')).toBe('neutral');
    expect(detectScript(' ,.! ')).toBe('neutral');
  });

  it('reports mixed instead of guessing', () => {
    // Latin 7 (g + grille) vs Arabic 4 → 0.64 < 0.7 threshold.
    expect(detectScript('250g دجاج grille')).toBe('mixed');
  });

  it('handles latin-extended letters (TR/DE/FR)', () => {
    expect(detectScript('ızgara tavuk göğsü')).toBe('latin');
    expect(detectScript('Hähnchenbrust')).toBe('latin');
  });
});
