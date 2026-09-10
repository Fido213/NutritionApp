/**
 * Food-word lexicon tests: display casing, UI-alias derivation, prep split.
 * Retrieval ranking that consumes these lives in interpreter.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { displayFoodName, friendlyFoodName, splitConceptPrep, PREP_WORDS } from './lexicon';

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
    // Mid-phrase title case ('Chicken') is preserved by design: only
    // ALL-CAPS tokens are lowered, so brands can never be mangled.
    expect(friendlyFoodName('Chicken, breast, boiled, sliced')).toBe('Boiled sliced Chicken breast');
  });

  it('keeps attribute order otherwise and drops the commas', () => {
    expect(friendlyFoodName('Apple, average, with skin')).toBe('Apple average with skin');
    expect(friendlyFoodName('RICE, WHITE')).toBe('Rice white');
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
