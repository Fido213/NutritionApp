/**
 * Phase 1 flagged-default badge — pure label resolution tests (no DOM).
 * Rendering itself (chip element) is covered by inspection; the decision
 * logic that must never regress lives here.
 */
import { describe, it, expect } from 'vitest';
import { assumedAmountLabel, formatLoggedAmount, confidenceLabel, spanTextFromObservation, displayFoodName } from './day-detail';

describe('assumedAmountLabel', () => {
  it('flags silent defaults', () => {
    expect(
      assumedAmountLabel(JSON.stringify({ canonicalName: 'banana', amountG: 100, wasDefault: true }), 0),
    ).toBe('amount assumed');
  });

  it('flags vague-marker estimates with the marker name', () => {
    expect(
      assumedAmountLabel(JSON.stringify({ canonicalName: 'rice', amountG: 125, rawUnit: '~side' }), 0),
    ).toBe('side assumed');
  });

  it('stays silent for confident parses', () => {
    expect(
      assumedAmountLabel(JSON.stringify({ canonicalName: 'chicken', amountG: 250, rawUnit: 'g' }), 0),
    ).toBeNull();
  });

  it('stays silent once the user corrected the row', () => {
    expect(
      assumedAmountLabel(JSON.stringify({ canonicalName: 'banana', amountG: 100, wasDefault: true }), 1),
    ).toBeNull();
  });

  it('stays silent on missing or unparseable payloads', () => {
    expect(assumedAmountLabel(null, 0)).toBeNull();
    expect(assumedAmountLabel(undefined, 0)).toBeNull();
    expect(assumedAmountLabel('{not json', 0)).toBeNull();
    expect(assumedAmountLabel('{}', 0)).toBeNull();
  });
});

describe('formatLoggedAmount', () => {
  it('labels gram amounts', () => {
    expect(formatLoggedAmount(250, null)).toBe('250g logged');
  });

  it('labels ml amounts', () => {
    expect(formatLoggedAmount(null, 240)).toBe('240ml logged');
  });

  it('prefers ml when both are present', () => {
    expect(formatLoggedAmount(250, 240)).toBe('240ml logged');
  });

  it('rounds fractional amounts', () => {
    expect(formatLoggedAmount(125.6, null)).toBe('126g logged');
  });

  it('stays silent when neither amount is stored', () => {
    expect(formatLoggedAmount(null, null)).toBeNull();
    expect(formatLoggedAmount(undefined, undefined)).toBeNull();
  });
});

describe('confidenceLabel', () => {
  it('marks legacy split-import rows estimated', () => {
    expect(confidenceLabel(0.5, 'imported')).toBe('estimated');
  });

  it('marks seeded reference rows reference, not estimated', () => {
    expect(confidenceLabel(null, 'imported')).toBe('reference');
    expect(confidenceLabel(undefined, 'imported')).toBe('reference');
  });

  it('labels exact imports by percentage', () => {
    expect(confidenceLabel(1.0, 'imported')).toBe('100% sure');
    expect(confidenceLabel(0.9, 'ai_estimate')).toBe('90% sure');
  });

  it('stays honest when confidence is missing', () => {
    expect(confidenceLabel(null, 'user_entered')).toBe('no estimate');
  });
});

describe('spanTextFromObservation', () => {
  it('recovers the user phrase from grounded span offsets', () => {
    expect(
      spanTextFromObservation('250g chicken, 100g rice', JSON.stringify({ canonicalName: 'Almond Chicken', span: [5, 12] }))
    ).toBe('chicken');
  });

  it('returns null for combo markers, fallback items, and garbage', () => {
    expect(spanTextFromObservation('oats', JSON.stringify({ kind: 'combo' }))).toBeNull();
    expect(spanTextFromObservation('apple', JSON.stringify({ canonicalName: 'apple' }))).toBeNull();
    expect(spanTextFromObservation('apple', '{not json')).toBeNull();
    expect(spanTextFromObservation(null, '{}')).toBeNull();
  });
});

describe('displayFoodName', () => {
  it('sentence-cases shouting reference names', () => {
    expect(displayFoodName('CHICKEN')).toBe('Chicken');
    expect(displayFoodName('RICE, WHITE')).toBe('Rice, white');
  });

  it('capitalizes all-lower names', () => {
    expect(displayFoodName('banana')).toBe('Banana');
  });

  it('leaves mixed case exactly alone (brands, title case)', () => {
    expect(displayFoodName("McDonald's fries")).toBe("McDonald's fries");
    expect(displayFoodName('Chicken, breast, lean flesh, grilled')).toBe('Chicken, breast, lean flesh, grilled');
  });

  it('handles empty input', () => {
    expect(displayFoodName(null)).toBe('');
    expect(displayFoodName('')).toBe('');
  });
});
