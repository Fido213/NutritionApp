import { describe, it, expect, beforeAll, vi } from 'vitest';
import initSqlJs from 'sql.js';
// @ts-ignore — Vite ?raw import (same pattern as src/data/database.ts)
import v001InitSql from '../migrations/v001__init.sql?raw';
import { FoodRepository } from './food.repo';
import { LogRepository } from './log.repo';
import { WaterRepository } from './water.repo';
import { GoalRepository } from './goal.repo';
import { BarcodeRepository } from './barcode.repo';
import { ObservationRepository } from './observation.repo';
import { AliasRepository } from './alias.repo';
import { DailyRecordRepository } from './daily-record.repo';
import { ImportRepository } from './import.repo';
import { ComboRepository } from './combo.repo';
import { InsertFood } from '../types';
import { ComboTemplate, expandCombo } from '../../domain/logging';
import { calculateNutrition } from '../../domain/nutrition';
import { createBackupArchive, parseBackupArchive, restoreBackupArchive, collectAllTables, BACKUP_TABLES } from '../../services/backup/backup';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJsStatic['Database']>;

let SQL: SqlJsStatic;

const CHICKEN: InsertFood = {
  canonical_name: 'Chicken Breast',
  normalized_name: 'chickenbreast',
  calories_per_100g: 165,
  protein_per_100g: 31,
  carbs_per_100g: 0,
  fat_per_100g: 3.6,
  water_per_100g: 65,
  nutrition_basis: 'per_100g',
  source_type: 'user_entered',
  confidence: 1.0
};

const OATS: InsertFood = {
  canonical_name: 'Rolled Oats',
  normalized_name: 'rolledoats',
  calories_per_100g: 389,
  protein_per_100g: 13,
  carbs_per_100g: 66,
  fat_per_100g: 7,
  water_per_100g: 9,
  nutrition_basis: 'per_100g',
  source_type: 'ai_estimate',
  confidence: 0.8
};

const MILK: InsertFood = {
  canonical_name: 'Whole Milk',
  normalized_name: 'wholemilk',
  calories_per_100g: 61,
  protein_per_100g: 3.2,
  carbs_per_100g: 4.8,
  fat_per_100g: 3.3,
  water_per_100g: 87,
  nutrition_basis: 'per_100g',
  source_type: 'user_entered',
  confidence: 1.0
};

/**
 * A minimal adapter from the Capacitor SQLiteDBConnection shape to a real
 * sql.js in-memory database. This is the same surface repositories consume
 * in production (query/run/execute + transactions).
 */
function createRealDb(): { db: SqlDatabase; conn: any } {
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(v001InitSql);

  const conn: any = {
    async query(statement: string, values?: any[]) {
      const stmt = db.prepare(statement);
      try {
        if (values && values.length > 0) stmt.bind(values);
        const rows: any[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return { values: rows };
      } finally {
        stmt.free();
      }
    },
    async run(statement: string, values?: any[]) {
      if (values && values.length > 0) db.run(statement, values);
      else db.run(statement);
      return { changes: { changes: db.getRowsModified(), lastId: 0 } };
    },
    async execute(statement: string) {
      db.exec(statement);
      return { changes: { changes: db.getRowsModified() } };
    },
    async beginTransaction() {
      db.run('BEGIN TRANSACTION');
    },
    async commitTransaction() {
      db.run('COMMIT');
    },
    async rollbackTransaction() {
      db.run('ROLLBACK');
    },
    async isOpened() {
      return { result: true };
    },
    async close() {
      db.close();
    }
  };

  return { db, conn };
}

async function seedChicken(conn: any): Promise<string> {
  const food = await new FoodRepository(conn).insert(CHICKEN);
  return food.id;
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('FoodRepository on a real SQLite database', () => {
  it('inserts a food and retrieves it by id and by normalized name', async () => {
    const { conn } = createRealDb();
    const repo = new FoodRepository(conn);

    const food = await repo.insert(CHICKEN);
    expect(food.normalized_name).toBe('chickenbreast');
    expect(food.source_type).toBe('user_entered');
    expect(food.confidence).toBe(1);

    const byId = await repo.findById(food.id);
    expect(byId?.canonical_name).toBe('Chicken Breast');
    expect(byId?.calories_per_100g).toBe(165);

    const byName = await repo.findByNormalizedName('chickenbreast');
    expect(byName?.id).toBe(food.id);
  });

  it('updates a food and refreshes updated_at', async () => {
    const { conn } = createRealDb();
    const repo = new FoodRepository(conn);
    const food = await repo.insert(CHICKEN);

    const updated = await repo.update(food.id, { canonical_name: 'Chicken Breast (Raw)', confidence: 0.9 });
    expect(updated?.canonical_name).toBe('Chicken Breast (Raw)');
    expect(updated?.confidence).toBe(0.9);
    expect(updated?.updated_at).toBeTruthy();
  });

  it('upsertFromAI inserts an unknown food and reuses a known one', async () => {
    const { conn } = createRealDb();
    const repo = new FoodRepository(conn);

    const created = await repo.upsertFromAI('Quinoa', { calories_per_100g: 120, protein_per_100g: 4 }, 0.7);
    expect(created.normalized_name).toBe('quinoa');
    expect(created.source_type).toBe('ai_estimate');
    expect(created.confidence).toBe(0.7);

    const reused = await repo.upsertFromAI('Quinoa', { calories_per_100g: 130 }, 0.9);
    expect(reused.id).toBe(created.id);
    const all = await conn.query('SELECT * FROM foods');
    expect(all.values).toHaveLength(1);
    expect(reused.calories_per_100g).toBe(130);
  });

  it('finds a food through an exact alias join', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    const aliasRepo = new AliasRepository(conn);
    await aliasRepo.create({
      food_id: foodId,
      alias: 'chicken tits',
      normalized_alias: 'chickentits',
      source: 'user',
      confidence: 0.8
    });

    const foodRepo = new FoodRepository(conn);
    const found = await foodRepo.findByAlias('chickentits');
    expect(found?.id).toBe(foodId);
    expect(found?.canonical_name).toBe('Chicken Breast');

    expect(await foodRepo.findByAlias('chickencurry')).toBeNull();
  });

  it('fuzzy searches with LIKE and respects the bound LIMIT', async () => {
    const { conn } = createRealDb();
    const repo = new FoodRepository(conn);
    await repo.insert(CHICKEN);
    await repo.insert(OATS);
    await repo.insert({ ...MILK, normalized_name: 'bananamilk', canonical_name: 'Banana Milk' });

    const one = await repo.fuzzySearch('ban', 1);
    expect(one).toHaveLength(1);

    const all = await repo.fuzzySearch('ban', 10);
    expect(all.length).toBeGreaterThanOrEqual(1);

    const chicken = await repo.fuzzySearch('chick', 10);
    expect(chicken).toHaveLength(1);
    expect(chicken[0].canonical_name).toBe('Chicken Breast');
  });
});

describe('AliasRepository / BarcodeRepository on a real SQLite database', () => {
  it('creates aliases, finds by normalized form, and lists per food', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    const repo = new AliasRepository(conn);

    const a1 = await repo.create({
      food_id: foodId,
      alias: 'Chicken Breast',
      normalized_alias: 'chickenbreast',
      source: 'user',
      confidence: 1
    });
    await repo.create({
      food_id: foodId,
      alias: 'Poulet',
      normalized_alias: 'poulet',
      source: 'user',
      confidence: 0.9
    });

    expect(await repo.findByNormalized('poulet')).toMatchObject({ id: expect.any(String), food_id: foodId });
    expect(await repo.findByNormalized('nonexistent')).toBeNull();
    expect(await repo.getAliasesForFood(foodId)).toHaveLength(2);
    expect(a1.normalized_alias).toBe('chickenbreast');
  });

  it('saves a barcode, looks it up through the join, and marks it verified', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    const repo = new BarcodeRepository(conn);

    const saved = await repo.saveBarcode(foodId, '5051234567890', 'user');
    expect(saved.barcode).toBe('5051234567890');
    expect(saved.verified).toBe(0);

    const food = await repo.lookupBarcode('5051234567890');
    expect(food?.id).toBe(foodId);

    await repo.markVerified(saved.id);
    const rows = await conn.query('SELECT * FROM food_barcodes WHERE id = ?', [saved.id]);
    expect(rows.values[0].verified).toBe(1);

    expect(await repo.lookupBarcode('0000000000000')).toBeNull();
  });

  it('re-maps a barcode to a new food via ON CONFLICT update', async () => {
    const { conn } = createRealDb();
    const repo = new BarcodeRepository(conn);
    const foodRepo = new FoodRepository(conn);
    const f1 = await foodRepo.insert(CHICKEN);
    const f2 = await foodRepo.insert(OATS);

    await repo.saveBarcode(f1.id, '1234567890', 'user');
    await repo.saveBarcode(f2.id, '1234567890', 'user');

    const rows = await conn.query('SELECT * FROM food_barcodes');
    expect(rows.values).toHaveLength(1);

    const food = await repo.lookupBarcode('1234567890');
    expect(food?.id).toBe(f2.id);
  });
});

describe('LogRepository on a real SQLite database', () => {
  it('inserts a log, reads it back, and joins the food name', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    const logRepo = new LogRepository(conn);

    const log = await logRepo.insertFoodLog({
      date: '2026-08-19',
      food_id: foodId,
      amount_g: 250,
      calories: 412.5,
      protein_g: 77.5,
      carbs_g: 0,
      fat_g: 9,
      water_ml: 162.5,
      note: 'lunch'
    });
    expect(log.amount_g).toBe(250);
    expect(log.calories).toBe(412.5);

    const byId = await logRepo.findById(log.id);
    expect(byId?.note).toBe('lunch');

    const logs = await logRepo.getLogsForDate('2026-08-19');
    expect(logs).toHaveLength(1);
    expect((logs[0] as any).food_name).toBe('Chicken Breast');
  });

  it('sums daily totals across multiple logs', async () => {
    const { conn } = createRealDb();
    const foodRepo = new FoodRepository(conn);
    const logRepo = new LogRepository(conn);
    const f1 = await foodRepo.insert(CHICKEN);
    const f2 = await foodRepo.insert(OATS);

    await logRepo.insertFoodLog({
      date: '2026-08-19', food_id: f1.id, amount_g: 100,
      calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, water_ml: 65
    });
    await logRepo.insertFoodLog({
      date: '2026-08-19', food_id: f2.id, amount_g: 50,
      calories: 194.5, protein_g: 6.5, carbs_g: 33, fat_g: 3.5, water_ml: 4.5
    });
    await logRepo.insertFoodLog({
      date: '2026-08-18', food_id: f1.id, amount_g: 100,
      calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, water_ml: 65
    });

    const totals = await logRepo.getDailyTotals('2026-08-19');
    expect(totals.calories).toBe(359.5);
    expect(totals.proteinG).toBe(37.5);
    expect(totals.carbsG).toBe(33);
    expect(totals.fatG).toBe(7.1);
    expect(totals.waterMl).toBe(69.5);

    const emptyDay = await logRepo.getDailyTotals('2026-01-01');
    expect(emptyDay.calories).toBe(0);
    expect(emptyDay.proteinG).toBe(0);
  });

  it('duplicates a log to another date and updates/deletes logs', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    const logRepo = new LogRepository(conn);

    const log = await logRepo.insertFoodLog({
      date: '2026-08-19', food_id: foodId, amount_g: 200,
      calories: 330, protein_g: 62, carbs_g: 0, fat_g: 7.2
    });

    const dup = await logRepo.duplicateLog(log.id, '2026-08-20');
    expect(dup.date).toBe('2026-08-20');
    expect(dup.food_id).toBe(foodId);
    expect(dup.calories).toBe(330);
    expect(dup.id).not.toBe(log.id);

    const updated = await logRepo.updateLog(log.id, { calories: 300, note: 'corrected' });
    expect(updated.calories).toBe(300);
    expect(updated.note).toBe('corrected');

    await logRepo.deleteLog(log.id);
    expect(await logRepo.findById(log.id)).toBeNull();
    expect(await logRepo.findById(dup.id)).not.toBeNull();
  });
});

describe('WaterRepository on a real SQLite database', () => {
  it('groups water totals by source (explicit / drink / food)', async () => {
    const { conn } = createRealDb();
    const repo = new WaterRepository(conn);

    await repo.insertWaterLog({ date: '2026-08-19', amount_ml: 500, source: 'explicit' });
    await repo.insertWaterLog({ date: '2026-08-19', amount_ml: 250, source: 'explicit' });
    await repo.insertWaterLog({ date: '2026-08-19', amount_ml: 200, source: 'drink' });
    await repo.insertWaterLog({ date: '2026-08-19', amount_ml: 100, source: 'food' });
    await repo.insertWaterLog({ date: '2026-08-18', amount_ml: 999, source: 'explicit' });

    const totals = await repo.getWaterTotalsBySource('2026-08-19');
    expect(totals.explicit).toBe(750);
    expect(totals.drink).toBe(200);
    expect(totals.food).toBe(100);

    const dayLogs = await repo.getWaterForDate('2026-08-19');
    expect(dayLogs).toHaveLength(4);

    await repo.deleteWaterLog(dayLogs[0].id);
    const after = await repo.getWaterTotalsBySource('2026-08-19');
    expect(after.explicit).toBe(250);
  });
});

describe('GoalRepository on a real SQLite database', () => {
  it('creates goals and closes the previous goal on the day before the new one starts', async () => {
    const { conn } = createRealDb();
    const repo = new GoalRepository(conn);

    const cut = await repo.createGoal({
      name: 'Cut', start_date: '2026-01-01', end_date: null,
      calories_target: 2200, protein_target: 150, carbs_target: 200, fat_target: 80, water_target: 4000
    });
    expect(cut.end_date).toBeNull();

    const bulk = await repo.createGoal({
      name: 'Bulk', start_date: '2026-03-15', end_date: null,
      calories_target: 2800, protein_target: 180, carbs_target: 300, fat_target: 100, water_target: 4500
    });

    expect(await repo.getCurrentGoal()).toMatchObject({ id: bulk.id, name: 'Bulk' });

    const reloadedCut = await repo.getGoalsHistory();
    const cutRow = reloadedCut.find(g => g.id === cut.id);
    expect(cutRow?.end_date).toBe('2026-03-14');

    expect((await repo.getGoalForDate('2026-02-10'))?.id).toBe(cut.id);
    expect((await repo.getGoalForDate('2026-03-14'))?.id).toBe(cut.id);
    expect((await repo.getGoalForDate('2026-03-15'))?.id).toBe(bulk.id);
    expect(await repo.getGoalForDate('2025-01-01')).toBeNull();
  });

  it('validates overlap against existing goals', async () => {
    const { conn } = createRealDb();
    const repo = new GoalRepository(conn);
    await repo.createGoal({
      name: 'Bulk', start_date: '2026-03-15', end_date: null,
      calories_target: 2800, protein_target: 180, carbs_target: 300, fat_target: 100, water_target: 4500
    });

    expect(await repo.validateNoOverlap('2026-04-01', null)).toBe(false);
    expect(await repo.validateNoOverlap('2026-01-01', '2026-02-01')).toBe(true);
    expect(await repo.validateNoOverlap('2026-03-01', '2026-03-20')).toBe(false);
  });
});

describe('DailyRecord / Observation / Import repositories on a real SQLite database', () => {
  it('creates a daily record once and updates low_accuracy and note', async () => {
    const { conn } = createRealDb();
    const repo = new DailyRecordRepository(conn);

    const first = await repo.getOrCreate('2026-08-19');
    const second = await repo.getOrCreate('2026-08-19');
    expect(second.date).toBe('2026-08-19');
    const rows = await conn.query('SELECT * FROM daily_records');
    expect(rows.values).toHaveLength(1);
    expect(first.low_accuracy).toBe(0);

    await repo.setLowAccuracy('2026-08-19', true);
    await repo.setNote('2026-08-19', 'rough day');
    const record = await repo.getOrCreate('2026-08-19');
    expect(record.low_accuracy).toBe(1);
    expect(record.note).toBe('rough day');

    const range = await repo.getForRange('2026-08-01', '2026-08-31');
    expect(range).toHaveLength(1);
  });

  it('inserts and finds observations', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    const repo = new ObservationRepository(conn);

    const obs = await repo.insert({
      food_id: foodId,
      source_type: 'text',
      estimated_amount: 250,
      final_amount: 210,
      amount_unit: 'g',
      confidence: 0.9,
      raw_input: '250g chicken',
      interpretation_json: '{"canonicalName":"chicken"}',
      user_corrected: 1
    });

    expect(obs.final_amount).toBe(210);
    expect(obs.user_corrected).toBe(1);

    const found = await repo.findById(obs.id);
    expect(found?.raw_input).toBe('250g chicken');
    expect(await repo.findById('missing')).toBeNull();
  });

  it('records and lists import history', async () => {
    const { conn } = createRealDb();
    const repo = new ImportRepository(conn);

    // Deterministic imported_at values: two inserts in the same millisecond
    // make ORDER BY imported_at DESC ambiguous in real SQLite.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'));
      await repo.recordImport({ source_type: 'csv', filename: 'old-app.csv', status: 'completed', row_count: 42, error_count: 0 });
      vi.setSystemTime(new Date('2026-08-19T11:00:00.000Z'));
      await repo.recordImport({ source_type: 'supabase', filename: null, status: 'completed', row_count: 100, error_count: 3 });
    } finally {
      vi.useRealTimers();
    }

    const history = await repo.getImportHistory();
    expect(history).toHaveLength(2);
    expect(history[0].source_type).toBe('supabase');
    expect(history[1].source_type).toBe('csv');
  });
});

describe('ComboRepository on a real SQLite database', () => {
  it('creates a combo with items, reads it back, and lists all combos', async () => {
    const { conn } = createRealDb();
    const foodRepo = new FoodRepository(conn);
    const comboRepo = new ComboRepository(conn);

    const oats = await foodRepo.insert(OATS);
    const milk = await foodRepo.insert(MILK);

    const combo = await comboRepo.createCombo('Midnight Oats', [
      { food_id: oats.id, amount_g: 50, amount_ml: null },
      { food_id: milk.id, amount_g: null, amount_ml: 120 }
    ]);
    expect(combo.name).toBe('Midnight Oats');
    expect(combo.items).toHaveLength(2);

    const loaded = await comboRepo.getCombo(combo.id);
    expect(loaded?.items).toHaveLength(2);
    expect(loaded?.items.find(i => i.food_id === oats.id)?.amount_g).toBe(50);

    const all = await comboRepo.getAllCombos();
    expect(all).toHaveLength(1);
    expect(all[0].items).toHaveLength(2);
  });

  it('replaces items on update and cascades deletes to combo_items', async () => {
    const { conn } = createRealDb();
    const foodRepo = new FoodRepository(conn);
    const comboRepo = new ComboRepository(conn);

    const oats = await foodRepo.insert(OATS);
    const milk = await foodRepo.insert(MILK);
    const combo = await comboRepo.createCombo('Oats Bowl', [
      { food_id: oats.id, amount_g: 50, amount_ml: null }
    ]);

    const updated = await comboRepo.updateCombo(combo.id, 'Oats Bowl v2', [
      { food_id: oats.id, amount_g: 80, amount_ml: null },
      { food_id: milk.id, amount_g: null, amount_ml: 150 }
    ]);
    expect(updated.name).toBe('Oats Bowl v2');
    expect(updated.items).toHaveLength(2);

    await comboRepo.deleteCombo(combo.id);
    const rows = await conn.query('SELECT * FROM combo_items WHERE combo_id = ?', [combo.id]);
    expect(rows.values).toHaveLength(0);
    expect(await comboRepo.getCombo(combo.id)).toBeNull();
  });

  it('rejects a combo referencing a nonexistent food (FK enforcement)', async () => {
    const { conn } = createRealDb();
    const comboRepo = new ComboRepository(conn);
    await expect(
      comboRepo.createCombo('Broken', [{ food_id: 'nope', amount_g: 100, amount_ml: null }])
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe('Schema integrity on a real SQLite database', () => {
  it('cascades deletes from foods to aliases and barcodes', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    await new AliasRepository(conn).create({
      food_id: foodId, alias: 'CB', normalized_alias: 'cb', source: 'user', confidence: 1
    });
    await new BarcodeRepository(conn).saveBarcode(foodId, '111', 'user');

    await conn.run('DELETE FROM foods WHERE id = ?', [foodId]);
    const aliases = await conn.query('SELECT * FROM food_aliases');
    const barcodes = await conn.query('SELECT * FROM food_barcodes');
    expect(aliases.values).toHaveLength(0);
    expect(barcodes.values).toHaveLength(0);
  });

  it('blocks deleting a food that still has food_logs (no silent history loss)', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    await new LogRepository(conn).insertFoodLog({
      date: '2026-08-19', food_id: foodId, amount_g: 100,
      calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6
    });

    await expect(conn.run('DELETE FROM foods WHERE id = ?', [foodId])).rejects.toThrow(/FOREIGN KEY/i);
    const logs = await conn.query('SELECT * FROM food_logs');
    expect(logs.values).toHaveLength(1);
  });
});

describe('Combo expansion round-trip through repositories', () => {
  it('logs every expanded combo ingredient and reproduces the daily totals', async () => {
    const { conn } = createRealDb();
    const date = '2026-08-19';
    const foodRepo = new FoodRepository(conn);
    const comboRepo = new ComboRepository(conn);
    const logRepo = new LogRepository(conn);

    const oats = await foodRepo.insert(OATS);
    const milk = await foodRepo.insert(MILK);

    const combo = await comboRepo.createCombo('Midnight Oats', [
      { food_id: oats.id, amount_g: 50, amount_ml: null },
      { food_id: milk.id, amount_g: null, amount_ml: 120 }
    ]);

    const templateItems: ComboTemplate['items'] = [];
    for (const item of combo.items) {
      const food = (await foodRepo.findById(item.food_id))!;
      templateItems.push({
        foodId: item.food_id,
        food: foodRepo.toFoodReference(food),
        amountG: item.amount_g,
        amountMl: item.amount_ml
      });
    }
    const template: ComboTemplate = {
      id: combo.id,
      name: combo.name,
      items: templateItems
    };

    const entries = expandCombo(template, date);
    expect(entries).toHaveLength(2);

    const manual: Record<string, number> = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 };
    for (const entry of entries) {
      const amount = entry.amountG ?? entry.amountMl ?? 100;
      const nutrition = calculateNutrition(entry.food, amount);
      manual.calories += nutrition.calories;
      manual.proteinG += nutrition.proteinG;
      manual.carbsG += nutrition.carbsG;
      manual.fatG += nutrition.fatG;
      if (nutrition.waterMl !== null) manual.waterMl += nutrition.waterMl;

      await logRepo.insertFoodLog({
        date,
        food_id: entry.foodId,
        amount_g: entry.amountG,
        amount_ml: entry.amountMl,
        calories: nutrition.calories,
        protein_g: nutrition.proteinG,
        carbs_g: nutrition.carbsG,
        fat_g: nutrition.fatG,
        water_ml: nutrition.waterMl
      });
    }

    const totals = await logRepo.getDailyTotals(date);
    expect(totals.calories).toBeCloseTo(manual.calories, 5);
    expect(totals.proteinG).toBeCloseTo(manual.proteinG, 5);
    expect(totals.carbsG).toBeCloseTo(manual.carbsG, 5);
    expect(totals.fatG).toBeCloseTo(manual.fatG, 5);
    expect(totals.waterMl).toBeCloseTo(manual.waterMl, 5);

    expect(totals.calories).toBeCloseTo(389 * 0.5 + 61 * 1.2, 5);

    const logs = await logRepo.getLogsForDate(date);
    expect(logs.map((l: any) => l.food_name).sort()).toEqual(['Rolled Oats', 'Whole Milk']);
  });
});

describe('Backup/restore round trip on a real SQLite database', () => {
  const ALL_TABLES = [
    'foods', 'food_aliases', 'food_barcodes', 'food_observations', 'food_logs',
    'water_logs', 'combos', 'combo_items', 'daily_records', 'goals', 'app_settings', 'imports'
  ];

  function rowKey(table: string, row: any): string {
    if (table === 'daily_records') return row.date;
    if (table === 'app_settings') return row.key;
    return row.id;
  }

  async function dump(conn: any): Promise<Record<string, any[]>> {
    const data: Record<string, any[]> = {};
    for (const table of ALL_TABLES) {
      const res = await conn.query(`SELECT * FROM ${table}`);
      data[table] = (res.values || []).map((r: any) => ({ ...r }));
    }
    return data;
  }

  async function seedState(conn: any) {
    const foodRepo = new FoodRepository(conn);
    const logRepo = new LogRepository(conn);
    const waterRepo = new WaterRepository(conn);
    const goalRepo = new GoalRepository(conn);
    const comboRepo = new ComboRepository(conn);

    const chicken = await foodRepo.insert(CHICKEN);
    const oats = await foodRepo.insert(OATS);
    await new AliasRepository(conn).create({
      food_id: chicken.id, alias: 'CB', normalized_alias: 'cb', source: 'user', confidence: 1
    });
    await new BarcodeRepository(conn).saveBarcode(chicken.id, '5051234567890', 'user');
    await new ObservationRepository(conn).insert({
      food_id: chicken.id, source_type: 'text', estimated_amount: 250, final_amount: 250,
      amount_unit: 'g', confidence: 0.9, raw_input: '250g chicken', interpretation_json: '{}', user_corrected: 0
    });
    const log = await logRepo.insertFoodLog({
      date: '2026-08-19', food_id: chicken.id, amount_g: 250,
      calories: 412.5, protein_g: 77.5, carbs_g: 0, fat_g: 9, water_ml: 162.5
    });
    await waterRepo.insertWaterLog({ date: '2026-08-19', amount_ml: 162.5, source: 'food', food_log_id: log.id });
    await waterRepo.insertWaterLog({ date: '2026-08-19', amount_ml: 500, source: 'explicit' });
    await comboRepo.createCombo('Midnight Oats', [
      { food_id: oats.id, amount_g: 50, amount_ml: null }
    ]);
    await new DailyRecordRepository(conn).setLowAccuracy('2026-08-19', true);
    await goalRepo.createGoal({
      name: 'Cut', start_date: '2026-01-01', end_date: null,
      calories_target: 2200, protein_target: 150, carbs_target: 200, fat_target: 80, water_target: 4000
    });
    await conn.run("INSERT INTO app_settings (key, value) VALUES ('schema_version', '1')");
    await new ImportRepository(conn).recordImport({ source_type: 'csv', filename: 'x.csv', status: 'completed', row_count: 1, error_count: 0 });
  }

  it('exports every table and restores it into a fresh database', async () => {
    const { db, conn } = createRealDb();
    await seedState(conn);
    const before = await dump(conn);

    const archive = parseBackupArchive(createBackupArchive(before));
    expect(archive).not.toBeNull();

    const fresh = createRealDb();
    const result = await restoreBackupArchive(fresh.conn, archive!);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBeGreaterThan(0);

    const after = await dump(fresh.conn);
    for (const table of ALL_TABLES) {
      const expected = [...before[table]].sort((a, b) => String(rowKey(table, a)).localeCompare(String(rowKey(table, b))));
      const actual = [...after[table]].sort((a, b) => String(rowKey(table, a)).localeCompare(String(rowKey(table, b))));
      expect(actual).toEqual(expected);
    }
    fresh.db.close();
    db.close();
  });

  it('replaces existing data completely when restoring', async () => {
    const { conn } = createRealDb();
    await seedState(conn);

    const onlyFood = parseBackupArchive(createBackupArchive({
      foods: [{
        id: 'f-only', canonical_name: 'Only Food', normalized_name: 'onlyfood',
        nutrition_basis: 'per_100g', source_type: 'user_entered', confidence: 1,
        created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
      }]
    }))!;

    const result = await restoreBackupArchive(conn, onlyFood);
    expect(result.ok).toBe(true);

    const after = await dump(conn);
    expect(after.foods).toHaveLength(1);
    expect(after.foods[0].id).toBe('f-only');
    expect(after.food_logs).toHaveLength(0);
    expect(after.goals).toHaveLength(0);
    expect(after.water_logs).toHaveLength(0);
  });

  it('rolls back the whole restore when a row violates a constraint', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    await conn.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, created_at)
       VALUES ('keep-log', '2026-08-19', ?, 100, 10, 5, 5, '2026-08-19T00:00:00.000Z')`,
      [foodId]
    );

    const bad = parseBackupArchive(createBackupArchive({
      foods: [{ id: 'bad-food' }]
    }))!;

    const result = await restoreBackupArchive(conn, bad);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('NOT NULL');

    const after = await dump(conn);
    expect(after.foods).toHaveLength(1);
    expect(after.foods[0].id).toBe(foodId);
    expect(after.food_logs).toHaveLength(1);
    expect(after.food_logs[0].id).toBe('keep-log');
  });

  it('restores an empty archive into an empty database cleanly', async () => {
    const { conn } = createRealDb();
    const empty = parseBackupArchive(createBackupArchive({}))!;
    const result = await restoreBackupArchive(conn, empty);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(0);
  });

  it('collectAllTables gathers every backup table from a real database', async () => {
    const { conn } = createRealDb();
    const foodId = await seedChicken(conn);
    await new LogRepository(conn).insertFoodLog({
      date: '2026-08-19', food_id: foodId, amount_g: 100,
      calories: 165, protein_g: 31, carbs_g: 0, fat_g: 9
    });

    const data = await collectAllTables(conn);
    expect(Object.keys(data).sort()).toEqual([...BACKUP_TABLES].sort());
    expect(data.foods).toHaveLength(1);
    expect(data.foods[0].id).toBe(foodId);
    expect(data.food_logs).toHaveLength(1);
    expect(data.food_logs[0].calories).toBe(165);
    expect(data.water_logs).toEqual([]);
    expect(data.combo_items).toEqual([]);
  });
});
