import { describe, it, expect, beforeAll } from 'vitest';
import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { ObservationRepository } from '@data/repositories/observation.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { FoodService } from './food-service';

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
    service = new FoodService(foodRepo, logRepo, obsRepo, waterRepo);
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
