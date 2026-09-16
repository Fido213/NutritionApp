/**
 * Lex-authority guard tests (device-verified 2026-09-13, generalized
 * 2026-09-13): deferral to the dominant family for thin-only singleton
 * matches, decisive promotion otherwise. Dominance thresholds need
 * realistic document frequencies, so the fixture carries 110 generated
 * chicken rows (df ≈ 110 ≥ DOMINANT_FAMILY_MIN) around the rare rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { hybridRetrieveSync, invalidateBm25Cache } from './hybrid-retriever';

const TAKEAWAY = { id: 't', canonical_name: 'Shawarma kebab meat, takeaway', normalized_name: 'shawarma kebab meat takeaway' } as any;
const CHICKEN = { id: 'c', canonical_name: 'CHICKEN', normalized_name: 'chicken' } as any;
const ZAAR = { id: 'z', canonical_name: 'Zaar chicken special', normalized_name: 'zaar chicken special' } as any;

function chickenFlock(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    canonical_name: `Chicken, cut ${i}`,
    normalized_name: `chicken cut ${i}`,
  })) as any[];
}

const LIB = [TAKEAWAY, CHICKEN, ZAAR, ...chickenFlock(110)];

beforeEach(() => { invalidateBm25Cache(); });

describe('lex authority: deferral to the dominant family', () => {
  it('defers a thin-only singleton match to the dominant family, either word order', () => {
    const a = hybridRetrieveSync('chicken shawarma', LIB, 3);
    expect(a[0].food.id).not.toBe('t');
    expect(a[0].food.canonical_name.toLowerCase()).toContain('chicken');
    const b = hybridRetrieveSync('Shawarma chicken', LIB, 3);
    expect(b[0].food.id).not.toBe('t');
    expect(b[0].food.canonical_name.toLowerCase()).toContain('chicken');
  });

  it('keeps the lone row when no competing family exists', () => {
    expect(hybridRetrieveSync('shawarma', LIB, 3)[0].food.id).toBe('t');
  });

  it('leaves exact matches untouched', () => {
    const hits = hybridRetrieveSync('chicken', LIB, 3);
    expect(hits[0].food.id).toBe('c');
    expect(hits[0].method).toBe('exact');
  });
});

describe('lex authority: decisive promotion', () => {
  it('promotes a decisive lex-top row that also matches the big family', () => {
    // 'zaar' is thin but the row carries 'chicken' too: no deferral (the
    // row IS family), decisive margin promotes it over hash generics.
    const hits = hybridRetrieveSync('chicken zaar', LIB, 3);
    expect(hits[0].food.id).toBe('z');
  });
});
