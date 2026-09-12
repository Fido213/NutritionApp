import { describe, it, expect, beforeAll } from 'vitest';
import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { ObservationRepository } from '@data/repositories/observation.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { AliasRepository } from '@data/repositories/alias.repo';
import { FoodService, graduateProvenanceOnUserEdit } from './food-service';

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

      const fromFoodLogs = s.includes('FROM food_logs');
      const fromFoods = s.includes('FROM foods');
      const fromObservations = s.includes('FROM food_observations');
      const fromWater = s.includes('FROM water_logs');
      const fromAliases = s.includes('FROM food_aliases');

      if (s.includes('SUM(calories)')) {
        const rows = tables.food_logs.filter(r => r.date === values?.[0]);
        return { values: [{
          calories: rows.reduce((a, r) => a + (r.calories || 0), 0),
          protein_g: rows.reduce((a, r) => a + (r.protein_g || 0), 0),
          carbs_g: rows.reduce((a, r) => a + (r.carbs_g || 0), 0),
          fat_g: rows.reduce((a, r) => a + (r.fat_g || 0), 0),
          water_ml: rows.reduce((a, r) => a + (r.water_ml || 0), 0)
        }] };
      }

      if (s.includes('GROUP BY source')) {
        const rows = tables.water_logs.filter(r => r.date === values?.[0]);
        const totals: Record<string, number> = { explicit: 0, drink: 0, food: 0 };
        rows.forEach(r => { totals[r.source] = (totals[r.source] || 0) + r.amount_ml; });
        return { values: Object.entries(totals).map(([source, total]) => ({ source, total })) };
      }

      if (s.includes('JOIN food_aliases')) {
        const alias = values?.[0];
        const match = tables.food_aliases.find(a => a.normalized_alias === alias);
        if (!match) return { values: [] };
        const food = tables.foods.find(f => f.id === match.food_id);
        return { values: food ? [food] : [] };
      }

      if (fromFoodLogs && s.includes('JOIN foods')) {
        const rows = tables.food_logs.filter(r => r.date === values?.[0]);
        return { values: rows.map(r => ({ ...r, food_name: tables.foods.find(f => f.id === r.food_id)?.canonical_name })) };
      }

      if (fromFoodLogs) {
        const rows = s.includes('WHERE id = ?')
          ? tables.food_logs.filter(r => r.id === values?.[0])
          : tables.food_logs.filter(r => r.date === values?.[0]);
        return { values: rows };
      }

      if (fromFoods) {
        if (s.includes('WHERE normalized_name = ?')) {
          return { values: tables.foods.filter(r => r.normalized_name === values?.[0]) };
        }
        return { values: tables.foods.filter(r => r.id === values?.[0]) };
      }

      if (fromObservations) {
        return { values: tables.food_observations.filter(r => r.id === values?.[0]) };
      }

      if (fromWater) {
        return { values: tables.water_logs.filter(r => r.id === values?.[0]) };
      }

      if (fromAliases) {
        return { values: tables.food_aliases.filter(r => r.normalized_alias === values?.[0]) };
      }

      return { values: [] };
    },
    run: async (statement: string, values?: any[]) => {
      const s = statement.trim();
      if (s.startsWith('INSERT INTO foods')) {
        insert('foods', ['id','canonical_name','normalized_name','calories_per_100g','protein_per_100g','carbs_per_100g','fat_per_100g','water_per_100g','nutrition_basis','source_type','source_reference','confidence','created_at','updated_at'], values || []);
      } else if (s.startsWith('INSERT INTO food_observations')) {
        insert('food_observations', ['id','food_id','source_type','estimated_amount','final_amount','amount_unit','confidence','raw_input','interpretation_json','user_corrected','created_at'], values || []);
      } else if (s.startsWith('INSERT INTO food_logs')) {
        insert('food_logs', ['id','date','food_id','observation_id','amount_g','amount_ml','calories','protein_g','carbs_g','fat_g','water_ml','note','created_at'], values || []);
      } else if (s.startsWith('INSERT INTO water_logs')) {
        insert('water_logs', ['id','date','amount_ml','source','food_log_id','note','created_at'], values || []);
      } else if (s.startsWith('INSERT INTO food_aliases')) {
        insert('food_aliases', ['id','food_id','alias','normalized_alias','source','confidence','created_at'], values || []);
      } else if (s.startsWith('DELETE FROM food_aliases')) {
        for (let i = tables.food_aliases.length - 1; i >= 0; i--) {
          if (tables.food_aliases[i].normalized_alias === values?.[0]) tables.food_aliases.splice(i, 1);
        }
      } else if (s.startsWith('UPDATE food_logs')) {
        const row = tables.food_logs.find(r => r.id === values?.[values!.length - 1]);
        if (row) {
          const setPart = s.match(/SET (.+?) WHERE/)?.[1] || '';
          setPart.split(',').forEach((pair, i) => {
            const key = pair.trim().split('=')[0].trim();
            row[key] = values?.[i];
          });
        }
      } else if (s.startsWith('DELETE FROM food_logs')) {
        const idx = tables.food_logs.findIndex(r => r.id === values?.[0]);
        if (idx !== -1) tables.food_logs.splice(idx, 1);
      }
      return { changes: { changes: 1, lastId: 1 } };
    },
    execute: async () => ({ changes: { changes: 0 } })
  };

  return { db, tables };
}

describe('FoodService pipeline (smoke)', () => {
  let service: FoodService;
  let foodRepo: FoodRepository;
  let tables: any;

  beforeAll(() => {
    const { db, tables: t } = createFakeDb();
    tables = t;
    foodRepo = new FoodRepository(db as any);
    const logRepo = new LogRepository(db as any);
    const obsRepo = new ObservationRepository(db as any);
    const waterRepo = new WaterRepository(db as any);
    const aliasRepo = new AliasRepository(db as any);
    service = new FoodService(foodRepo, logRepo, obsRepo, waterRepo, aliasRepo);
  });

  it('resolves and logs an unknown food, creating library entry + observation + log + water', async () => {
    const results = await service.logTextInput('2026-08-19', '250g chicken breast', [
      { canonicalName: 'Chicken Breast', amountG: 250, amountMl: null, confidence: 0.9, isComposite: false }
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].nutrition.calories).toBe(500); // default estimate 200 kcal/100g x 2.5
    expect(tables.foods).toHaveLength(1);
    expect(tables.food_observations).toHaveLength(1);
    expect(tables.food_logs).toHaveLength(1);
    expect(tables.water_logs).toHaveLength(0); // default estimate has 0 water

    expect(tables.food_observations[0].raw_input).toBe('250g chicken breast');
    expect(tables.food_logs[0].observation_id).toBe(tables.food_observations[0].id);
    expect(tables.food_logs[0].amount_g).toBe(250);
  });

  it('reuses the existing library entry on the second occurrence', async () => {
    const results = await service.logTextInput('2026-08-19', '150g chicken breast', [
      { canonicalName: 'Chicken Breast', amountG: 150, amountMl: null, confidence: 0.95, isComposite: false }
    ]);

    expect(results[0].nutrition.calories).toBe(300);
    expect(tables.foods).toHaveLength(1);
    expect(tables.food_logs).toHaveLength(2);
  });

  it('logs ml-based liquids with ml amounts and food-derived water', async () => {
    await foodRepo.insert({
      canonical_name: 'Orange Juice',
      normalized_name: 'orange juice',
      calories_per_100g: 45,
      protein_per_100g: 0.7,
      carbs_per_100g: 10.4,
      fat_per_100g: 0.2,
      water_per_100g: 88,
      nutrition_basis: 'per_100ml',
      source_type: 'user_entered',
      confidence: 1.0
    });

    const results = await service.logTextInput('2026-08-19', '200ml orange juice', [
      { canonicalName: 'Orange Juice', amountG: null, amountMl: 200, confidence: 0.9, isComposite: false }
    ]);

    expect(results[0].log.amount_ml).toBe(200);
    expect(results[0].nutrition.waterMl).toBe(176);
    expect(tables.foods).toHaveLength(2);
    expect(tables.water_logs).toHaveLength(1);
    expect(tables.water_logs[0].source).toBe('drink');
expect(tables.water_logs[0].food_log_id).toBe(results[0].log.id);
  });

  it('throws for an item without a name', async () => {
    await expect(service.resolveFood({ canonicalName: '  ', amountG: 100, amountMl: null, confidence: 0.5, isComposite: false }))
      .rejects.toThrow('missing a name');
  });
});

describe('FoodService label OCR pipeline', () => {
  let service: FoodService;
  let tables: any;

  beforeAll(() => {
    const { db, tables: t } = createFakeDb();
    tables = t;
    const foodRepo = new FoodRepository(db as any);
    const logRepo = new LogRepository(db as any);
    const obsRepo = new ObservationRepository(db as any);
    const waterRepo = new WaterRepository(db as any);
    const aliasRepo = new AliasRepository(db as any);
    service = new FoodService(foodRepo, logRepo, obsRepo, waterRepo, aliasRepo);
  });

  const LABEL: any = {
    rawText: 'Energy 165 kcal, Protein 31g, Carbs 0g, Fat 3.6g per 100g',
    foodName: 'Chicken Breast Slices',
    caloriesPer100g: 165,
    proteinPer100g: 31,
    carbsPer100g: 0,
    fatPer100g: 3.6,
    waterPer100g: 0,
    confidence: 0.9
  };

  it('creates a nutrition_label food + observation + log with scaled macros', async () => {
    const result = await service.logLabelOcr('2026-08-19', LABEL, 250);

    expect(result.nutrition.calories).toBe(412.5); // 165 kcal/100g x 2.5
    expect(result.nutrition.proteinG).toBe(77.5);

    expect(tables.foods).toHaveLength(1);
    expect(tables.foods[0].source_type).toBe('nutrition_label');
    expect(tables.foods[0].calories_per_100g).toBe(165);
    expect(tables.foods[0].confidence).toBe(0.9);

    expect(tables.food_observations).toHaveLength(1);
    expect(tables.food_observations[0].source_type).toBe('label_ocr');
    expect(tables.food_observations[0].raw_input).toBe(LABEL.rawText);
    expect(tables.food_observations[0].amount_unit).toBe('g');

    expect(tables.food_logs).toHaveLength(1);
    expect(tables.food_logs[0].amount_g).toBe(250);
    expect(tables.food_logs[0].observation_id).toBe(tables.food_observations[0].id);

    expect(tables.water_logs).toHaveLength(0); // label has no water content
  });

  it('logs food-derived water separately and reuses the library entry on re-scan', async () => {
    const yogurtLabel = {
      rawText: 'Per 100g: Energy 59 kcal, Protein 10g, Fat 0.4g',
      foodName: 'Greek Yogurt',
      caloriesPer100g: 59,
      proteinPer100g: 10,
      carbsPer100g: 3.6,
      fatPer100g: 0.4,
      waterPer100g: 65,
      confidence: 0.85
    };

    const first = await service.logLabelOcr('2026-08-19', yogurtLabel, 200);
    expect(first.nutrition.waterMl).toBe(130);
    expect(tables.foods).toHaveLength(2);
    expect(tables.water_logs).toHaveLength(1);
    expect(tables.water_logs[0].source).toBe('food');
    expect(tables.water_logs[0].food_log_id).toBe(first.log.id);

    const second = await service.logLabelOcr('2026-08-19', yogurtLabel, 150);
    expect(tables.foods).toHaveLength(2); // reused, no duplicate food
    expect(tables.food_logs).toHaveLength(3); // 1 from the previous test + 2 yogurt logs
    expect(tables.food_observations).toHaveLength(3);
    expect(second.nutrition.calories).toBe(88.5); // 59 kcal/100g x 1.5
  });

  it('rejects a label without a food name and a non-positive amount', async () => {
    await expect(service.logLabelOcr('2026-08-19', { ...LABEL, foodName: '  ' }, 100))
      .rejects.toThrow('missing a food name');
    await expect(service.logLabelOcr('2026-08-19', LABEL, 0))
      .rejects.toThrow('positive');
  });
});

describe('FoodService online barcode pipeline', () => {
  let service: FoodService;
  let tables: any;

  beforeAll(() => {
    const { db, tables: t } = createFakeDb();
    tables = t;
    const foodRepo = new FoodRepository(db as any);
    const logRepo = new LogRepository(db as any);
    const obsRepo = new ObservationRepository(db as any);
    const waterRepo = new WaterRepository(db as any);
    const aliasRepo = new AliasRepository(db as any);
    service = new FoodService(foodRepo, logRepo, obsRepo, waterRepo, aliasRepo);
  });

  const PRODUCT: any = {
    productName: 'Nutella',
    caloriesPer100g: 539,
    proteinPer100g: 6.3,
    carbsPer100g: 57.5,
    fatPer100g: 30.9
  };

  it('creates a barcode-source food + observation + log at 100 g', async () => {
    const result = await service.logBarcodeLookup('2026-08-20', PRODUCT, '3017620422003');

    expect(result.nutrition.calories).toBe(539);
    expect(result.nutrition.proteinG).toBe(6.3);

    expect(tables.foods).toHaveLength(1);
    expect(tables.foods[0].source_type).toBe('barcode');
    expect(tables.foods[0].source_reference).toBe('3017620422003');
    expect(tables.foods[0].calories_per_100g).toBe(539);
    expect(tables.foods[0].confidence).toBe(0.8);

    expect(tables.food_observations).toHaveLength(1);
    expect(tables.food_observations[0].source_type).toBe('barcode');
    expect(tables.food_observations[0].raw_input).toBe('3017620422003');

    expect(tables.food_logs).toHaveLength(1);
    expect(tables.food_logs[0].amount_g).toBe(100);
    expect(tables.food_logs[0].observation_id).toBe(tables.food_observations[0].id);
    expect(tables.water_logs).toHaveLength(0);
  });

  it('logs at a custom amount and reuses the library entry on re-scan', async () => {
    const result = await service.logBarcodeLookup('2026-08-20', PRODUCT, '3017620422003', 40);

    expect(result.nutrition.calories).toBeCloseTo(215.6, 10); // 539 kcal/100g x 0.4
    expect(tables.foods).toHaveLength(1); // reused, no duplicate food
    expect(tables.food_logs).toHaveLength(2);
    expect(tables.food_observations).toHaveLength(2);
  });

  it('rejects a product without a name and a non-positive amount', async () => {
    await expect(service.logBarcodeLookup('2026-08-20', { ...PRODUCT, productName: '  ' }, '3017620422003'))
      .rejects.toThrow('missing a name');
    await expect(service.logBarcodeLookup('2026-08-20', PRODUCT, '3017620422003', 0))
      .rejects.toThrow('positive');
  });
});

describe('FoodService user-pinned defaults', () => {
  let service: FoodService;
  let tables: any;

  beforeAll(() => {
    const { db, tables: t } = createFakeDb();
    tables = t;
    const foodRepo = new FoodRepository(db as any);
    service = new FoodService(
      foodRepo,
      new LogRepository(db as any),
      new ObservationRepository(db as any),
      new WaterRepository(db as any),
      new AliasRepository(db as any)
    );
    tables.foods.push(
      { id: 'almond', canonical_name: 'Almond Chicken', normalized_name: 'almond chicken', calories_per_100g: 200, protein_per_100g: 10, carbs_per_100g: 10, fat_per_100g: 10, water_per_100g: 10, nutrition_basis: 'per_100g', source_type: 'imported', source_reference: null, confidence: null, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z' },
      { id: 'breast', canonical_name: 'Chicken, breast, lean flesh, grilled', normalized_name: 'chicken breast lean flesh grilled', calories_per_100g: 150, protein_per_100g: 30, carbs_per_100g: 0, fat_per_100g: 3, water_per_100g: 65, nutrition_basis: 'per_100g', source_type: 'imported', source_reference: null, confidence: null, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z' }
    );
  });

  it('prefers the pinned default over the interpreted canonical name', async () => {
    await service.setUserDefault('chicken', 'breast');
    const ref = await service.resolveFood(
      { canonicalName: 'Almond Chicken', amountG: 100, amountMl: null, confidence: 0.7, isComposite: false },
      undefined,
      'chicken'
    );
    expect(ref.id).toBe('breast');
  });

  it('falls back to normal resolution without a pinned phrase', async () => {
    const ref = await service.resolveFood(
      { canonicalName: 'Almond Chicken', amountG: 100, amountMl: null, confidence: 0.7, isComposite: false },
      undefined,
      'turkey'
    );
    expect(ref.id).toBe('almond');
  });

  it('extracts the span phrase from the raw input for the next log', async () => {
    const results = await service.logTextInput('2026-08-19', 'chicken', [
      { canonicalName: 'Almond Chicken', amountG: 100, amountMl: null, confidence: 0.7, isComposite: false, span: [0, 7] } as any
    ]);
    expect(results[0].food.id).toBe('breast');
    expect(results[0].observation.food_id).toBe('breast');
  });

  it('moves the mapping when re-pinned, never duplicates', async () => {
    await service.setUserDefault('chicken', 'almond');
    expect(tables.food_aliases.filter((a: any) => a.normalized_alias === 'chicken')).toHaveLength(1);
    expect(tables.food_aliases.find((a: any) => a.normalized_alias === 'chicken').food_id).toBe('almond');
    const ref = await service.resolveFood(
      { canonicalName: 'Almond Chicken', amountG: 100, amountMl: null, confidence: 0.7, isComposite: false },
      undefined,
      'chicken'
    );
    expect(ref.id).toBe('almond');
  });

  it('rejects empty phrases and unknown foods', async () => {
    await expect(service.setUserDefault('   ', 'breast')).rejects.toThrow('empty phrase');
    await expect(service.setUserDefault('!!!', 'breast')).rejects.toThrow('searchable');
    await expect(service.setUserDefault('chicken', 'missing')).rejects.toThrow('not found');
  });
});

describe('resolveFood P2 head-median fallback', () => {
  const CHICKEN_ROWS = [150, 160, 165, 170, 180, 200].map((kcal, i) => ({
    id: `c${i}`,
    canonical_name: `Chicken Kebab, cut ${kcal}`,
    normalized_name: `chicken kebab cut ${kcal}`,
    calories_per_100g: kcal,
    protein_per_100g: 30,
    carbs_per_100g: 0,
    fat_per_100g: 3,
    water_per_100g: 65,
    source_type: 'imported',
  }));

  function stubService(pool: any[]) {
    let upserted: any = null;
    const foodRepo: any = {
      findByAlias: async () => null,
      findByNormalizedName: async () => null,
      getFoodsByToken: async () => pool,
      upsertFromAI: async (_name: string, nutrients: any, confidence: number) => {
        upserted = { nutrients, confidence };
        return { id: 'new', ...nutrients, confidence };
      },
      toFoodReference: (f: any) => ({ id: f.id, confidence: f.confidence }),
    };
    const service = new FoodService(foodRepo, {} as any, {} as any, {} as any, {} as any);
    return { service, upserted: () => upserted };
  }

  const item = (confidence = 0.7) => ({
    canonicalName: 'Chicken Kebab', amountG: 100, amountMl: null, confidence, isComposite: false,
  });

  it('upserts head medians (not flat) when supporters exist, capping confidence', async () => {
    const { service, upserted } = stubService(CHICKEN_ROWS);
    await service.resolveFood(item(0.7));
    // Median of [150,160,165,170,180,200] = 167.5; support conf 0.52 < 0.7.
    expect(upserted().nutrients.calories_per_100g).toBeCloseTo(167.5, 5);
    expect(upserted().nutrients.protein_per_100g).toBe(30);
    expect(upserted().confidence).toBeCloseTo(0.52, 5);
  });

  it('keeps the flat floor when head support is thin', async () => {
    const { service, upserted } = stubService(CHICKEN_ROWS.slice(0, 2));
    await service.resolveFood(item(0.7));
    expect(upserted().nutrients.calories_per_100g).toBe(200);
    expect(upserted().nutrients.protein_per_100g).toBe(10);
    expect(upserted().confidence).toBe(0.7);
  });

  it('never overrides caller-supplied nutrients', async () => {
    const { service, upserted } = stubService(CHICKEN_ROWS);
    await service.resolveFood(item(0.7), { calories_per_100g: 999 } as any);
    expect(upserted().nutrients.calories_per_100g).toBe(999);
  });
});

describe('graduateProvenanceOnUserEdit (P1.5)', () => {
  it('graduates ai_estimate rows to user_entered on hand edit', () => {
    expect(graduateProvenanceOnUserEdit('ai_estimate')).toBe('user_entered');
  });

  it('leaves every other provenance untouched', () => {
    for (const source of ['barcode', 'nutrition_label', 'user_entered', 'imported', null, undefined]) {
      expect(graduateProvenanceOnUserEdit(source as any)).toBeNull();
    }
  });
});
