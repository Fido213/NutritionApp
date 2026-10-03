import { describe, it, expect } from 'vitest';
import { sanitizeOnlineHit, enrichFood, ENRICHED_CONFIDENCE } from './enrich';
import type { OnlineSearchHit } from './off-search';

const hit = (over: Partial<OnlineSearchHit> = {}): OnlineSearchHit => ({
  code: '5001',
  productName: 'Chicken Shawarma',
  caloriesPer100g: 165,
  proteinPer100g: 20,
  carbsPer100g: 5,
  fatPer100g: 7,
  ...over,
});

describe('sanitizeOnlineHit', () => {
  it('accepts sane measured values', () => {
    expect(sanitizeOnlineHit(hit())).toMatchObject({ calories: 165, protein: 20, carbs: 5, fat: 7 });
  });

  it('derives insane/missing kcal from macros instead of failing', () => {
    // 4*20+4*5+9*7 = 163.
    expect(sanitizeOnlineHit(hit({ caloriesPer100g: 0 }))?.calories).toBe(163);
    expect(sanitizeOnlineHit(hit({ caloriesPer100g: 4620 }))?.calories).toBe(163);
  });

  it('rejects negative macros and Atwater-incoherent rows', () => {
    expect(sanitizeOnlineHit(hit({ proteinPer100g: -1 }))).toBeNull();
    expect(sanitizeOnlineHit(hit({ proteinPer100g: NaN }))).toBeNull();
    // 4*1+4*1+9*1 = 17 vs reported 500: incoherent.
    expect(sanitizeOnlineHit(hit({ caloriesPer100g: 500, proteinPer100g: 1, carbsPer100g: 1, fatPer100g: 1 }))).toBeNull();
  });
});

describe('enrichFood', () => {
  function repo(row: any) {
    const store = new Map<string, any>([[row.id, { ...row }]]);
    return {
      store,
      async findById(id: string) { return store.get(id) ?? null; },
      async update(id: string, updates: any) {
        const cur = store.get(id);
        if (!cur) return null;
        const next = { ...cur, ...updates };
        store.set(id, next);
        return next;
      },
    };
  }

  const estRow = (over: any = {}) => ({
    id: 'e1', canonical_name: 'Chicken Shawarma', normalized_name: 'chicken shawarma',
    calories_per_100g: 200, protein_per_100g: 10, carbs_per_100g: 25, fat_per_100g: 5,
    source_type: 'ai_estimate', confidence: 0.5, ...over,
  });

  it('upgrades an estimate in place, same id, online tier', async () => {
    const r = repo(estRow());
    const out = await enrichFood(r as any, 'e1', hit());
    expect(out?.source_type).toBe('online_match');
    expect(out?.calories_per_100g).toBe(165);
    expect(out?.source_reference).toBe('5001');
    expect(out?.confidence).toBe(ENRICHED_CONFIDENCE);
    expect(out?.id).toBe('e1');
  });

  it('never touches non-estimates (user edits and prior enrichments win)', async () => {
    for (const source of ['user_entered', 'online_match', 'imported', 'barcode']) {
      const r = repo(estRow({ source_type: source }));
      expect(await enrichFood(r as any, 'e1', hit())).toBeNull();
      expect(r.store.get('e1').calories_per_100g).toBe(200);
    }
    const r = repo(estRow());
    expect(await enrichFood(r as any, 'missing', hit())).toBeNull();
  });

  it('keeps the estimate when the payload is insane', async () => {
    const r = repo(estRow());
    // Absurd kcal derives absurd macros (4*260+4*700+9*200=5640 > cap) → reject.
    expect(await enrichFood(r as any, 'e1', hit({ caloriesPer100g: 4620, proteinPer100g: 260, carbsPer100g: 700, fatPer100g: 200 }))).toBeNull();
    expect(r.store.get('e1').source_type).toBe('ai_estimate');
    expect(r.store.get('e1').calories_per_100g).toBe(200);
  });
});
