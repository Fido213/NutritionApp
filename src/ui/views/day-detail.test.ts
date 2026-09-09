/**
 * Phase 1 flagged-default badge — pure label resolution tests (no DOM).
 * Rendering itself (chip element) is covered by inspection; the decision
 * logic that must never regress lives here.
 */
import { describe, it, expect } from 'vitest';
import { assumedAmountLabel, formatLoggedAmount } from './day-detail';

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
