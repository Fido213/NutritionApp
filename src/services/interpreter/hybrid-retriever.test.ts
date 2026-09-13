/**
 * Decisive-lexical guard tests (device-verified 2026-09-13): a lexical hit
 * more than doubling its runner-up keeps rank 1 over the hash channel's
 * short-generic preference. Fixture mirrors the real corpus shape (one
 * discriminating row among generics).
 */
import { describe, it, expect } from 'vitest';
import { hybridRetrieveSync, invalidateBm25Cache } from './hybrid-retriever';

const TAKEAWAY = { id: 't', canonical_name: 'Shawarma kebab meat, takeaway', normalized_name: 'shawarma kebab meat takeaway' } as any;
const CHICKEN = { id: 'c', canonical_name: 'CHICKEN', normalized_name: 'chicken' } as any;
const STEW = { id: 's', canonical_name: 'CHICKEN STEW, CHICKEN BURGUNDY', normalized_name: 'chicken stew chicken burgundy' } as any;
const ALMOND = { id: 'a', canonical_name: 'Almond chicken', normalized_name: 'almond chicken' } as any;
const LIB = [TAKEAWAY, CHICKEN, STEW, ALMOND];

describe('decisive lexical hits', () => {
  it('keeps the lone discriminating row first regardless of word order', () => {
    invalidateBm25Cache();
    expect(hybridRetrieveSync('chicken shawarma', LIB, 3)[0].food.id).toBe('t');
    invalidateBm25Cache();
    expect(hybridRetrieveSync('Shawarma chicken', LIB, 3)[0].food.id).toBe('t');
  });

  it('leaves genuinely ambiguous queries to the fused order', () => {
    invalidateBm25Cache();
    const hits = hybridRetrieveSync('chicken', LIB, 3);
    // Exact match on the generic keeps its crown; the guard is a no-op here
    // (takeaway shares no token with the query and is correctly absent).
    expect(hits[0].food.id).toBe('c');
    expect(hits[0].method).toBe('exact');
  });
});
