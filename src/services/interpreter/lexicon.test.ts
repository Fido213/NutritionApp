/**
 * Food-word lexicon tests: display casing, UI-alias derivation, prep split.
 * Retrieval ranking that consumes these lives in interpreter.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { displayFoodName, friendlyFoodName, splitConceptPrep, PREP_WORDS, stripReceiptTail } from './lexicon';

describe('displayFoodName', () => {
  it('sentence-cases shouting reference names', () => {
    expect(displayFoodName('CHICKEN')).toBe('Chicken');
    expect(displayFoodName('RICE, WHITE')).toBe('Rice, white');
  });

  it('capitalizes all-lower names', () => {
    expect(displayFoodName('banana')).toBe('Banana');
  });

  it('leaves mixed case exactly alone', () => {
    expect(displayFoodName("McDonald's fries")).toBe("McDonald's fries");
    expect(displayFoodName('Chicken, breast, lean flesh, grilled')).toBe('Chicken, breast, lean flesh, grilled');
  });

  it('handles empty input', () => {
    expect(displayFoodName(null)).toBe('');
    expect(displayFoodName('')).toBe('');
  });
});

describe('friendlyFoodName', () => {
  it('fronts preparation words before the head phrase', () => {
    // Title-cased composition; brands stay safe (only ALL-CAPS is lowered).
    expect(friendlyFoodName('Chicken, breast, boiled, sliced')).toBe('Boiled Sliced Chicken Breast');
  });

  it('fronts a lone variety adjective ("White Rice", not "Rice White")', () => {
    expect(friendlyFoodName('RICE, WHITE')).toBe('White Rice');
    expect(friendlyFoodName('Rice, brown')).toBe('Brown Rice');
  });

  it('keeps cuts and long rows head-first ("Chicken Breast")', () => {
    expect(friendlyFoodName('Chicken, breast')).toBe('Chicken Breast');
    expect(friendlyFoodName('Grains, rice, white, glutinous, cooked')).toBe('Cooked White Grains Rice Glutinous');
  });

  it('drops USDA bookkeeping tokens', () => {
    expect(friendlyFoodName('Rice, cooked, NFS')).toBe('Cooked Rice');
  });

  it('leaves single-segment names to casing alone', () => {
    expect(friendlyFoodName('Banana')).toBe('Banana');
    expect(friendlyFoodName('Chicken egg boiled')).toBe('Chicken egg boiled');
  });

  it('never returns empty for non-empty input', () => {
    expect(friendlyFoodName('  x  ')!.length).toBeGreaterThan(0);
    expect(friendlyFoodName('')).toBe('');
    expect(friendlyFoodName(null)).toBe('');
  });
});

describe('splitConceptPrep', () => {
  it('splits dish identity from preparation words', () => {
    expect(splitConceptPrep(['boiled', 'chicken'])).toEqual({ concept: ['chicken'], prep: ['boiled'] });
    expect(splitConceptPrep(['rice'])).toEqual({ concept: ['rice'], prep: [] });
  });

  it('knows the core preparations', () => {
    for (const w of ['grilled', 'boiled', 'fried', 'raw', 'dried']) expect(PREP_WORDS.has(w)).toBe(true);
  });
});

describe('stripReceiptTail', () => {
  it('cuts macro tails so pasted re-logs parse the food phrase', () => {
    expect(stripReceiptTail('- Halawa 50g: 265k (6P/22C/18F)')).toBe('- Halawa 50g: 265k ');
    expect(stripReceiptTail('Logged: Nescafe 110 kcal | 240ml Hydration 2g P')).toBe('Logged: Nescafe ');
    expect(stripReceiptTail('Brioche Roll Acc: 95%')).toBe('Brioche Roll ');
  });

  it('leaves ordinary prose untouched', () => {
    expect(stripReceiptTail('250g chicken, 100g rice')).toBe('250g chicken, 100g rice');
    expect(stripReceiptTail('track my hydration today')).toBe('track my hydration today');
    expect(stripReceiptTail('')).toBe('');
  });
});
