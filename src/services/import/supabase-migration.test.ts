import { describe, it, expect } from 'vitest';
import { createFallbackConnection } from '../../data/database';
import type { FallbackTableStore } from '../../data/database';
import { FoodRepository } from '../../data/repositories/food.repo';
import { LogRepository } from '../../data/repositories/log.repo';
import { GoalRepository } from '../../data/repositories/goal.repo';
import { WaterRepository } from '../../data/repositories/water.repo';
import { migrateSupabaseData } from './supabase-migration';

function createStore(): FallbackTableStore {
  const tables: Record<string, any[]> = {};
  return {
    getTable: (name: string) => tables[name] || [],
    setTable: (name: string, rows: any[]) => { tables[name] = rows; },
    save: () => {},
  } as any;
}

describe('migrateSupabaseData (P1.3 provenance honesty)', () => {
  it('imports personal-table foods below full confidence, marked imported', async () => {
    const store = createStore();
    const conn: any = createFallbackConnection(store);

    const result = await migrateSupabaseData(
      { foodinfo_personal: [{ name: 'Bredawy Bread', cal: 270, protein: 9, carb: 55, fat: 2 }] },
      new FoodRepository(conn),
      new LogRepository(conn),
      new GoalRepository(conn),
      new WaterRepository(conn)
    );

    expect(result.foodCount).toBe(1);
    const foods = store.getTable('foods');
    expect(foods).toHaveLength(1);
    expect(foods[0]).toMatchObject({ canonical_name: 'Bredawy Bread', source_type: 'imported' });
    expect(foods[0].confidence).toBeLessThan(1.0);
    expect(foods[0].confidence).toBe(0.8);
  });
});
