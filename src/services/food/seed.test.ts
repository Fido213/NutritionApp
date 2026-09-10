/**
 * Base-seed (44k migration) tests: CSV parsing, record mapping, collision
 * dedupe, orchestration guards. Bulk SQL itself is covered against a real
 * engine in sqlite-real.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseSeedCsv, mapSeedRecord, prepareSeedRows, dedupeSeedRows,
  toInsertFood, seedFoodLibraryIfEmpty, seedCompleteness,
  type SeedCandidate,
} from './seed';

const HEADER = ['source_db', 'source_id', 'food_name_en', 'energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'water_g'];

const ROW_FULL = ['usda', '1', 'Chicken Breast', '165', '31', '0', '3.6', '65'];
const ROW_THIN = ['usda', '2', 'Chicken Breast', '165', '', '', '', ''];

describe('parseSeedCsv', () => {
  it('handles quoted commas and escaped quotes', () => {
    const rows = parseSeedCsv('a,b\n"APPLEBEE\'S, chicken tenders","165"\n"x ""y""",2\n');
    expect(rows).toEqual([['a', 'b'], ["APPLEBEE'S, chicken tenders", '165'], ['x "y"', '2']]);
  });

  it('handles CRLF and BOM', () => {
    const rows = parseSeedCsv('﻿a,b\r\nc,d\r\n');
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('mapSeedRecord', () => {
  it('maps a full row with provenance', () => {
    const c = mapSeedRecord(HEADER, ROW_FULL)!;
    expect(c.name).toBe('Chicken Breast');
    expect(c.normalized).toBe('chicken breast');
    expect(c.calories).toBe(165);
    expect(c.protein).toBe(31);
    expect(c.sourceRef).toBe('usda:1');
  });

  it('maps blanks to null, keeps the row', () => {
    const c = mapSeedRecord(HEADER, ROW_THIN)!;
    expect(c.protein).toBeNull();
    expect(c.calories).toBe(165);
  });

  it('drops short and empty names', () => {
    expect(mapSeedRecord(HEADER, ['usda', '3', 'x', '1', '1', '1', '1', '1'])).toBeNull();
    expect(mapSeedRecord(HEADER, ['usda', '4', '   ', '1', '1', '1', '1', '1'])).toBeNull();
  });

  it('keeps CJK names (no empty-normalized collapse)', () => {
    const c = mapSeedRecord(HEADER, ['usda', '5', '鸡肉', '100', '10', '10', '10', '10'])!;
    expect(c.normalized).toBe('鸡肉');
  });
});

describe('dedupeSeedRows', () => {
  const mk = (over: Partial<SeedCandidate> & { normalized: string }): SeedCandidate => {
    const { normalized, ...rest } = over;
    return {
      name: normalized, normalized, calories: null,
      protein: null, carbs: null, fat: null, water: null, sourceRef: null, ...rest,
    };
  };

  it('keeps the most macro-complete row', () => {
    const thin = mk({ normalized: 'chicken breast', calories: 165 });
    const full = mk({ normalized: 'chicken breast', calories: 165, protein: 31, carbs: 0, fat: 3.6, water: 65 });
    expect(seedCompleteness(full)).toBeGreaterThan(seedCompleteness(thin));
    const out = dedupeSeedRows([thin, full]);
    expect(out).toHaveLength(1);
    expect(out[0].protein).toBe(31);
  });

  it('breaks ties deterministically (first-seen wins)', () => {
    const a = mk({ normalized: 'rice', name: 'Rice A', calories: 100 });
    const b = mk({ normalized: 'rice', name: 'Rice B', calories: 100 });
    expect(dedupeSeedRows([a, b])[0].name).toBe('Rice A');
    expect(dedupeSeedRows([b, a])[0].name).toBe('Rice B');
  });
});

describe('toInsertFood', () => {
  it('marks provenance as imported reference with no claimed confidence', () => {
    const f = toInsertFood(mapSeedRecord(HEADER, ROW_FULL)!);
    expect(f.nutrition_basis).toBe('per_100g');
    expect(f.source_type).toBe('imported');
    expect((f as any).source_reference).toBe('usda:1');
    expect((f as any).confidence).toBeNull();
  });
});

const CSVTEXT =
  'source_db,source_id,food_name_en,energy_kcal,protein_g,carbohydrate_g,fat_g,water_g\n' +
  'usda,1,"Chicken Breast",165,31,0,3.6,65\n' +
  'usda,2,"Chicken Breast",165,,,,\n' +
  'usda,3,"Apple, raw",52,0.3,14,0.2,86\n';

function stubRepo(existing: unknown[] = []) {
  return {
    getAllFoods: vi.fn(async () => existing),
    bulkInsert: vi.fn(async (rows: unknown[]) => (rows as unknown[]).length),
    clearAll: vi.fn(async () => {}),
  };
}

describe('seedFoodLibraryIfEmpty', () => {
  it('skips a non-empty library without fetching', async () => {
    const repo = stubRepo([{ id: 'x' }]);
    const fetchFn = vi.fn(async () => { throw new Error('should not fetch'); });
    const r = await seedFoodLibraryIfEmpty(repo as any, fetchFn as any);
    expect(r.seeded).toBe(false);
    expect(r.reason).toBe('non-empty');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });

  it('skips gracefully when no asset is bundled', async () => {
    const repo = stubRepo();
    const fetchFn = vi.fn(async () => ({ ok: false } as any));
    const r = await seedFoodLibraryIfEmpty(repo as any, fetchFn as any);
    expect(r).toMatchObject({ seeded: false, reason: 'no-asset' });
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });

  it('seeds deduped rows on an empty library', async () => {
    const repo = stubRepo();
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => CSVTEXT } as any));
    const r = await seedFoodLibraryIfEmpty(repo as any, fetchFn as any);
    expect(r.seeded).toBe(true);
    expect(r.total).toBe(3);
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(1);
    const rows = repo.bulkInsert.mock.calls[0][0] as any[];
    expect(rows.map(x => x.canonical_name).sort()).toEqual(['Apple, raw', 'Chicken Breast']);
    expect(rows.find(x => x.canonical_name === 'Chicken Breast').protein_per_100g).toBe(31);
  });

  it('rejects an asset without the expected header', async () => {
    const repo = stubRepo();
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => '<html>nope</html>' } as any));
    const r = await seedFoodLibraryIfEmpty(repo as any, fetchFn as any);
    expect(r).toMatchObject({ seeded: false, reason: 'no-asset' });
  });

  it('reports insert failure without throwing (retries next launch)', async () => {
    const repo = stubRepo();
    repo.bulkInsert = vi.fn(async () => { throw new Error('disk full'); });
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => CSVTEXT } as any));
    const r = await seedFoodLibraryIfEmpty(repo as any, fetchFn as any);
    expect(r).toMatchObject({ seeded: false, reason: 'failed' });
  });

  it('clears partial rows on failure so the next launch retries clean', async () => {
    const repo = stubRepo();
    repo.bulkInsert = vi.fn(async () => { throw new Error('disk full'); });
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => CSVTEXT } as any));
    await seedFoodLibraryIfEmpty(repo as any, fetchFn as any);
    expect(repo.clearAll).toHaveBeenCalledTimes(1);
  });

  it('reports slice progress during the seed', async () => {
    const repo = stubRepo();
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => CSVTEXT } as any));
    const seen: Array<[number, number]> = [];
    const r = await seedFoodLibraryIfEmpty(repo as any, fetchFn as any, (d, t) => seen.push([d, t]));
    expect(r.seeded).toBe(true);
    expect(seen).toEqual([[2, 2]]);
  });
});

describe('prepareSeedRows', () => {
  it('maps records and drops unusable rows', () => {
    const out = prepareSeedRows([HEADER, ROW_FULL, ['usda', '9', 'x', '1', '1', '1', '1', '1']]);
    expect(out.map(c => c.name)).toEqual(['Chicken Breast']);
  });
});
