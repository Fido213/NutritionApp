import { describe, it, expect } from 'vitest';
import { searchFoodsOnline, searchFoodsOnlineOutcome, matchOnlineHit, type OnlineSearchHit } from './off-search';

const hit = (over: Partial<OnlineSearchHit> & { productName: string }): OnlineSearchHit => ({
  code: '123',
  caloriesPer100g: 200,
  proteinPer100g: 10,
  carbsPer100g: 20,
  fatPer100g: 5,
  ...over,
});

const stubFetch = (payload: unknown, ok = true) => async () => ({
  ok,
  json: async () => payload,
}) as any;

describe('searchFoodsOnline', () => {
  it('returns trimmed hits with usable nutrition only', async () => {
    const out = await searchFoodsOnline('shawarma', {
      fetchImpl: stubFetch({
        products: [
          { code: '1', product_name: 'Chicken Shawarma', nutriments: { 'energy-kcal_100g': 165, proteins_100g: 20, carbohydrates_100g: 5, fat_100g: 7 } },
          { code: '', product_name: 'Nameless', nutriments: { 'energy-kcal_100g': 1 } },
          { code: '3', product_name: '', nutriments: { 'energy-kcal_100g': 1 } },
          { code: '4', product_name: 'No Data', nutriments: {} },
          null,
        ],
      }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: '1', productName: 'Chicken Shawarma', caloriesPer100g: 165 });
  });

  it('converts kJ-first labels and degrades to empty on any failure', async () => {
    const out = await searchFoodsOnline('kebab', {
      fetchImpl: stubFetch({ products: [{ code: '9', product_name: 'K', nutriments: { energy_100g: 418.4 } }] }),
    });
    expect(out[0].caloriesPer100g).toBeCloseTo(100, 5);
    expect(await searchFoodsOnline('x', { fetchImpl: stubFetch({}, false) })).toEqual([]);
    expect(await searchFoodsOnline('x', { fetchImpl: async () => { throw new Error('offline'); } })).toEqual([]);
    expect(await searchFoodsOnline('a')).toEqual([]);
  });
});

describe('searchFoodsOnlineOutcome', () => {
  it('separates "completed, nothing usable" from "the request failed"', async () => {
    // Completed search, no usable product: a genuine miss the caller may
    // remember for the session.
    expect(await searchFoodsOnlineOutcome('zzz', { fetchImpl: stubFetch({ products: [] }) }))
      .toEqual({ hits: [], transportFailed: false });
    // HTTP error / thrown fetch / timeout: the attempt never happened, so the
    // caller must NOT burn its per-session ledger on it.
    expect((await searchFoodsOnlineOutcome('zzz', { fetchImpl: stubFetch({}, false) })).transportFailed).toBe(true);
    expect((await searchFoodsOnlineOutcome('zzz', {
      fetchImpl: async () => { throw new Error('offline'); },
    })).transportFailed).toBe(true);
    // Too short to be worth a request: never leaves the device, not a failure.
    let called = false;
    const short = await searchFoodsOnlineOutcome('a', { fetchImpl: (async () => { called = true; }) as any });
    expect(short).toEqual({ hits: [], transportFailed: false });
    expect(called).toBe(false);
  });
});

describe('matchOnlineHit', () => {
  const hits = [
    hit({ code: 'k', productName: 'Chicken Kebab' }),
    hit({ code: 's', productName: 'Shawarma, Chicken, Spicy' }),
  ];

  it('accepts exact names and full concept coverage, in order', () => {
    expect(matchOnlineHit('Chicken Kebab', hits)?.code).toBe('k');
    expect(matchOnlineHit('chicken shawarma', hits)?.code).toBe('s');
  });

  it('rejects partial coverage (ambiguity abstains)', () => {
    expect(matchOnlineHit('chicken shawarma wrap', hits)).toBeNull();
    expect(matchOnlineHit('beef shawarma', hits)).toBeNull();
    expect(matchOnlineHit('!!!', hits)).toBeNull();
    expect(matchOnlineHit('rice', [])).toBeNull();
  });
});
