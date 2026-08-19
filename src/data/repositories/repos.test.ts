import { describe, it, expect, beforeAll } from 'vitest';
import { FoodRepository } from './food.repo';
import { AliasRepository } from './alias.repo';
import { BarcodeRepository } from './barcode.repo';

function createFakeDb() {
  const tables: Record<string, any[]> = {
    foods: [], food_aliases: [], food_barcodes: [], food_observations: [],
    food_logs: [], water_logs: [], combos: [], combo_items: [], daily_records: [], goals: [], app_settings: [], imports: []
  };

  const insert = (table: string, cols: string[], values: any[]) => {
    const row: any = {};
    cols.forEach((c, i) => { row[c] = values[i]; });
    tables[table].push(row);
    return row;
  };

  const db: any = {
    query: async (statement: string, values?: any[]) => {
      const s = statement.trim();

      if (s.includes('JOIN food_barcodes')) {
        const barcode = values?.[0];
        const match = tables.food_barcodes.find(b => b.barcode === barcode);
        if (!match) return { values: [] };
        const food = tables.foods.find(f => f.id === match.food_id);
        return { values: food ? [food] : [] };
      }

      if (s.includes('FROM foods')) {
        if (s.includes('WHERE normalized_name = ?')) {
          return { values: tables.foods.filter(r => r.normalized_name === values?.[0]) };
        }
        if (s.includes('WHERE id = ?')) {
          return { values: tables.foods.filter(r => r.id === values?.[0]) };
        }
        if (s.includes('JOIN food_aliases')) {
          const alias = values?.[0];
          const match = tables.food_aliases.find(a => a.normalized_alias === alias);
          if (!match) return { values: [] };
          const food = tables.foods.find(f => f.id === match.food_id);
          return { values: food ? [food] : [] };
        }
        if (s.includes('LIKE ?')) {
          const term = values?.[0]?.replace(/%/g, '') || '';
          const filtered = tables.foods.filter(f =>
            f.canonical_name?.toLowerCase().includes(term.toLowerCase()) ||
            f.normalized_name?.toLowerCase().includes(term.toLowerCase())
          );
          return { values: filtered.slice(0, values?.[2] ?? 20) };
        }
        return { values: tables.foods.filter(r => r.id === values?.[0]) };
      }

      if (s.includes('FROM food_aliases')) {
        if (s.includes('WHERE normalized_alias = ?')) {
          return { values: tables.food_aliases.filter(r => r.normalized_alias === values?.[0]) };
        }
        if (s.includes('WHERE id = ?')) {
          return { values: tables.food_aliases.filter(r => r.id === values?.[0]) };
        }
        return { values: tables.food_aliases.filter(r => r.food_id === values?.[0]) };
      }

      if (s.includes('FROM food_barcodes')) {
        return { values: tables.food_barcodes.filter(r => r.barcode === values?.[0]) };
      }

      return { values: [] };
    },
    run: async (statement: string, values?: any[]) => {
      const s = statement.trim();
      if (s.startsWith('INSERT INTO foods')) {
        insert('foods', ['id','canonical_name','normalized_name','calories_per_100g','protein_per_100g','carbs_per_100g','fat_per_100g','water_per_100g','nutrition_basis','source_type','source_reference','confidence','created_at','updated_at'], values || []);
      } else if (s.startsWith('INSERT INTO food_aliases')) {
        insert('food_aliases', ['id','food_id','alias','normalized_alias','source','confidence','created_at'], values || []);
      } else if (s.startsWith('INSERT INTO food_barcodes')) {
        const cols = ['id','food_id','barcode','source','verified','created_at'];
        const valuesClause = s.match(/VALUES \(([^)]*)\)/)?.[1] || '';
        const rawParts = valuesClause.split(',').map(p => p.trim());
        let vi = 0;
        const row: any = {};
        cols.forEach((c, i) => {
          const part = rawParts[i];
          if (part === '?') row[c] = values?.[vi++];
          else if (part === 'NULL') row[c] = null;
          else if (!isNaN(parseFloat(part))) row[c] = parseFloat(part);
          else row[c] = part.replace(/^"|"$/g, '');
        });
        tables.food_barcodes.push(row);
      } else if (s.startsWith('UPDATE foods')) {
        const row = tables.foods.find(r => r.id === values?.[values!.length - 1]);
        if (row) {
          const setPart = s.match(/SET (.+?) WHERE/)?.[1] || '';
          setPart.split(',').forEach((pair, i) => {
            const key = pair.trim().split('=')[0].trim();
            if (key !== 'updated_at') row[key] = values?.[i];
          });
        }
      } else if (s.startsWith('UPDATE food_barcodes')) {
        const row = tables.food_barcodes.find(r => r.id === values?.[0]);
        if (row) row.verified = 1;
      }
      return { changes: { changes: 1, lastId: 1 } };
    },
    execute: async () => ({ changes: { changes: 0 } })
  };

  return { db, tables };
}

describe('BarcodeRepository', () => {
  it('returns the food for a known barcode', async () => {
    const { db, tables } = createFakeDb();
    tables.foods.push({ id: 'f1', canonical_name: 'Choco Pops', normalized_name: 'chocopops' });
    tables.food_barcodes.push({ id: 'b1', food_id: 'f1', barcode: '5051234567890', source: 'user', verified: 1 });

    const repo = new BarcodeRepository(db as any);
    const food = await repo.lookupBarcode('5051234567890');
    expect(food?.canonical_name).toBe('Choco Pops');
  });

  it('returns null for an unknown barcode (barcode failure fallback)', async () => {
    const { db } = createFakeDb();
    const repo = new BarcodeRepository(db as any);
    expect(await repo.lookupBarcode('0000000000000')).toBeNull();
  });

  it('saves a barcode and marks it verified', async () => {
    const { db, tables } = createFakeDb();
    const repo = new BarcodeRepository(db as any);

    const saved = await repo.saveBarcode('f1', '9990001112223', 'user');
    expect(saved.barcode).toBe('9990001112223');
    expect(tables.food_barcodes).toHaveLength(1);
    expect(tables.food_barcodes[0].verified).toBe(0);

    await repo.markVerified(saved.id);
    expect(tables.food_barcodes[0].verified).toBe(1);
  });
});

describe('AliasRepository', () => {
  it('creates and finds an alias by normalized form', async () => {
    const { db, tables } = createFakeDb();
    const repo = new AliasRepository(db as any);

    const created = await repo.create({
      food_id: 'f1',
      alias: 'Choco Pops',
      normalized_alias: 'chocopops',
      source: 'user',
      confidence: 0.9
    });

    expect(tables.food_aliases).toHaveLength(1);
    expect(tables.food_aliases[0].food_id).toBe('f1');

    const found = await repo.findByNormalized('chocopops');
    expect(found?.id).toBe(created.id);

    expect(await repo.findByNormalized('nonexistent')).toBeNull();
  });

  it('lists aliases for a food', async () => {
    const { db, tables } = createFakeDb();
    tables.food_aliases.push(
      { id: 'a1', food_id: 'f1', alias: 'one', normalized_alias: 'one', source: 'user', confidence: 1, created_at: '2026-08-19T00:00:00.000Z' },
      { id: 'a2', food_id: 'f1', alias: 'two', normalized_alias: 'two', source: 'user', confidence: 1, created_at: '2026-08-19T00:00:00.000Z' }
    );

    const repo = new AliasRepository(db as any);
    const aliases = await repo.getAliasesForFood('f1');
    expect(aliases).toHaveLength(2);
    expect(await repo.getAliasesForFood('other')).toEqual([]);
  });
});

describe('FoodRepository alias resolution + upsert', () => {
  let tables: any;
  let foodRepo: FoodRepository;

  beforeAll(() => {
    const { db, tables: t } = createFakeDb();
    tables = t;
    foodRepo = new FoodRepository(db as any);
  });

  it('resolves a food through an exact alias match (no fuzzy aliasing)', async () => {
    tables.foods.push({
      id: 'f1', canonical_name: 'Chicken Breast', normalized_name: 'chickenbreast',
      calories_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6,
      water_per_100g: 65, nutrition_basis: 'per_100g', source_type: 'user_entered',
      source_reference: null, confidence: 1, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
    });
    tables.food_aliases.push({
      id: 'a1', food_id: 'f1', alias: 'chicken tits', normalized_alias: 'chickentits',
      source: 'user', confidence: 0.8, created_at: '2026-08-19T00:00:00.000Z'
    });

    const found = await foodRepo.findByAlias('chickentits');
    expect(found?.id).toBe('f1');

    const notFound = await foodRepo.findByAlias('chickencurry');
    expect(notFound).toBeNull();
  });

  it('upsertFromAI reuses an existing entry instead of duplicating', async () => {
    const before = tables.foods.length;
    const food = await foodRepo.upsertFromAI('Chicken Breast', { calories_per_100g: 200 }, 0.9);
    expect(tables.foods).toHaveLength(before);
    expect(food.id).toBe('f1');
  });

  it('upsertFromAI inserts a new entry for unknown foods', async () => {
    const food = await foodRepo.upsertFromAI('Quinoa', { calories_per_100g: 120, protein_per_100g: 4 }, 0.7);
    expect(food.normalized_name).toBe('quinoa');
    expect(food.source_type).toBe('ai_estimate');
    expect(food.confidence).toBe(0.7);
  });

  it('fuzzySearch finds foods by partial name and respects the limit', async () => {
    tables.foods.push({ id: 'f2', canonical_name: 'Banana', normalized_name: 'banana' });
    tables.foods.push({ id: 'f3', canonical_name: 'Banana Bread', normalized_name: 'bananabread' });
    tables.foods.push({ id: 'f4', canonical_name: 'Apple', normalized_name: 'apple' });

    const results = await foodRepo.fuzzySearch('ban', 1);
    expect(results).toHaveLength(1);

    const all = await foodRepo.fuzzySearch('ban', 10);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});