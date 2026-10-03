import { describe, it, expect } from 'vitest';
import { looksNonFood, looksNonFoodWhenUnexplained } from './non-food';

/**
 * Receipts for every pattern are in ai models/results/prose_span_report*.json
 * (production seed + production interpreter over 437 real typed messages).
 * The negatives matter as much as the positives: OOV foods the library lacks
 * must NOT be dropped — alias/estimate work owns those — and telemetry words
 * must not sink real products that carry them ("Minute Maid").
 */
describe('looksNonFood (pre-retrieval, high precision)', () => {
  it('flags the non-food text the real log produced', () => {
    expect(looksNonFood("I'm 68 kg")).toBe(true);
    expect(looksNonFood('173 cm')).toBe(true);
    expect(looksNonFood('68 kg 173 cm height')).toBe(true);
    expect(looksNonFood('Try to approximate the calories to a degree, no floats')).toBe(true);
    expect(looksNonFood('Test')).toBe(true);
    expect(looksNonFood('speed')).toBe(true);
    expect(looksNonFood('incline')).toBe(true);
    expect(looksNonFood('')).toBe(true);
  });

  it('never flags real food, including the OOV foods the corpus lacks', () => {
    expect(looksNonFood('war2a 3enab')).toBe(false);
    expect(looksNonFood('cooked air fried steakhouse')).toBe(false);
    expect(looksNonFood('sheesh tawook')).toBe(false);
    expect(looksNonFood('1 kg chicken')).toBe(false);        // kg WITH a food
    expect(looksNonFood('2 lb beef')).toBe(false);
    expect(looksNonFood('Grilled chicken breast')).toBe(false);
    expect(looksNonFood('Brown Toast 35g')).toBe(false);
    expect(looksNonFood('Pomme Frites')).toBe(false);
    expect(looksNonFood('Molokheya')).toBe(false);
    // Telemetry words are deliberately NOT in the pre-retrieval set.
    expect(looksNonFood('Minute Maid orange juice')).toBe(false);
    expect(looksNonFood('Speed 3, incline 2, time 30 minutes, treadmill')).toBe(false);
  });
});

describe('looksNonFoodWhenUnexplained (adds telemetry, no row to protect)', () => {
  it('catches the treadmill line and keeps everything the strict check keeps', () => {
    expect(looksNonFoodWhenUnexplained('Speed 3, incline 2, time 30 minutes, treadmill')).toBe(true);
    expect(looksNonFoodWhenUnexplained('3 speed 5 incline 20 minutes treadmill')).toBe(true);
    expect(looksNonFoodWhenUnexplained("I'm 68 kg")).toBe(true);
    expect(looksNonFoodWhenUnexplained('war2a 3enab')).toBe(false);
    expect(looksNonFoodWhenUnexplained('sheesh tawook')).toBe(false);
  });
});
