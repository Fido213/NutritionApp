import { describe, it, expect } from 'vitest';
import { parseQuantities } from './unit-parser';
import { extractFoodSpansSync } from './ner-client';
import { interpretTextSync } from './index';
import { normalizeAmount } from '@domain/units';

describe('unit-parser', () => {
  it('parses kg, g, ml, fractions, commas', () => {
    const q = parseQuantities('250g chicken, 1.5kg rice, ½ cup oats, 12,5g chia');
    expect(q.length).toBe(4);
    expect(q[0].amountG).toBeCloseTo(250);
    expect(q[1].amountG).toBeCloseTo(1500);
    // 0.5 cup -> 120ml
    expect(q[2].amountMl).toBeCloseTo(120);
    expect(q[3].amountG).toBeCloseTo(12.5);
  });

  it('parses multiplier 2x150g and range 100-150g', () => {
    const q1 = parseQuantities('2x150g chicken');
    expect(q1[0].amountG).toBe(300);
    expect(q1[0].wasMultiplier).toBe(true);
    const q2 = parseQuantities('100-150g chicken');
    expect(q2[0].amountG).toBeCloseTo(125);
    expect(q2[0].wasRange).toBe(true);
  });

  it('parses oz/lb/cup/tbsp and Arabic', () => {
    const q = parseQuantities('1 oz Almonds, 1 lb Beef, 1 cup rice, 2 tbsp oil, 1 كوب أرز');
    expect(q[0].amountG).toBeCloseTo(28.35, 1);
    expect(q[1].amountG).toBeCloseTo(453.59, 0);
    expect(q[2].amountMl).toBe(240);
    expect(q[3].amountMl).toBe(30);
    expect(q[4].amountMl).toBe(240);
  });

  it('handles bare count 2 apples', () => {
    const q = parseQuantities('2 apples, 1 egg');
    // bare counts captured with null grams, resolved via food hint
    const bare = q.find(x => x.originalValue === 2);
    expect(bare).toBeDefined();
    const resolved = normalizeAmount(bare!.originalValue, 'apple', 'apple');
    expect(resolved.amountG).toBe(364); // 2*182
  });

  it('clamps 0-5000', () => {
    const q = parseQuantities('6000g chicken');
    expect(q.length).toBe(0); // clamped out
  });
});

describe('ner-client heuristic', () => {
  it('extracts food between quantities', () => {
    const text = '250g chicken breast, 100g rice';
    const q = parseQuantities(text);
    const spans = extractFoodSpansSync(text, q);
    expect(spans.map(s => s.text.toLowerCase())).toEqual(expect.arrayContaining(['chicken breast', 'rice']));
    expect(spans[0].span[0]).toBeGreaterThanOrEqual(0);
  });

  it('handles no quantities -> whole text food', () => {
    const spans = extractFoodSpansSync('apple', []);
    expect(spans[0].text).toBe('apple');
  });

  it('composite hint with containing', () => {
    const text = 'midnight oats containing 50g oats, 20g chia seeds, 120ml milk';
    const q = parseQuantities(text);
    const spans = extractFoodSpansSync(text, q);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    expect(spans.some(s => s.isCompositeHint)).toBe(true);
  });

  it('multilingual French', () => {
    const text = '250g poulet, 100g riz';
    const q = parseQuantities(text);
    const spans = extractFoodSpansSync(text, q);
    expect(spans.map(s => s.text.toLowerCase())).toEqual(expect.arrayContaining(['poulet', 'riz']));
  });

  it('Arabic', () => {
    const text = '250g دجاج, 100g أرز';
    const q = parseQuantities(text);
    const spans = extractFoodSpansSync(text, q);
    expect(spans.length).toBe(2);
  });
});

describe('interpretTextSync pipeline', () => {
  it('aligns quantities to spans and defaults 100g', () => {
    const out = interpretTextSync('250g chicken breast, 100g rice', null);
    expect(out.length).toBe(2);
    expect(out[0].amountG).toBe(250);
    expect(out[1].amountG).toBe(100);
    expect(out[0].canonicalName.toLowerCase()).toContain('chicken');
  });

  it('defaults bare food to 100g', () => {
    const out = interpretTextSync('banana', null);
    expect(out[0].amountG).toBe(100);
  });

  it('handles 2x150g multiplier + NER', () => {
    const out = interpretTextSync('2x150g poulet et 100-150g riz', null);
    expect(out[0].amountG).toBe(300);
    expect(out[1].amountG).toBeCloseTo(125);
  });

  it('grounds spans — no hallucination', () => {
    const text = '250g chicken breast';
    const out = interpretTextSync(text, null);
    for (const s of out) {
      expect(text.slice(s.span[0], s.span[1]).toLowerCase()).toContain(s.canonicalName.toLowerCase().split(' ')[0]);
    }
  });
});
