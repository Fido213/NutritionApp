import { describe, it, expect } from 'vitest';
import { createFallbackConnection } from './database';
import type { FallbackTableStore } from './database';

function createStore(): FallbackTableStore & { debug: () => any } {
  const tables: Record<string, any[]> = {};
  const state = { saved: 0 };
  return {
    getTable: (name: string) => tables[name] || [],
    setTable: (name: string, rows: any[]) => { tables[name] = rows; },
    save: () => { state.saved++; },
    debug: () => ({ tables, saved: state.saved })
  } as any;
}

const queryValues = async (db: any, statement: string, values?: any[]): Promise<any[]> => {
  const res = await db.query(statement, values);
  return res.values || [];
};

describe('createFallbackConnection', () => {
  it('inserts rows positionally (VALUES (?, ?)) with literals and bound values', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO goals (id, name, start_date, end_date, calories_target, protein_target, carbs_target, fat_target, water_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['g1', 'Default', '2026-01-01', null, 2500, 150, 250, 80, 4000, '2026-01-01T00:00:00Z']
    );
    await db.run(
      `INSERT INTO daily_records (date, low_accuracy, note, created_at, updated_at) VALUES (?, 0, NULL, ?, ?)`,
      ['2026-08-20', 'now', 'now2']
    );

    const goals = store.debug().tables.goals;
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      id: 'g1',
      name: 'Default',
      start_date: '2026-01-01',
      end_date: null,
      calories_target: 2500
    });

    const records = store.debug().tables.daily_records;
    expect(records[0]).toEqual({
      date: '2026-08-20',
      low_accuracy: 0,
      note: null,
      created_at: 'now',
      updated_at: 'now2'
    });
  });

  it('updates a row by id and by date', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO foods (id, canonical_name, normalized_name, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, water_per_100g, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'Chicken Breast', 'chicken breast', 165, 31, 0, 3.6, 65, 'now']
    );
    await db.run(`UPDATE foods SET calories_per_100g = ?, protein_per_100g = ? WHERE id = ?`, [180, 32, 'f1']);
    await db.run(`UPDATE daily_records SET low_accuracy = ?, updated_at = ? WHERE date = ?`, [1, 'later', '2026-08-20']);

    const food = store.debug().tables.foods[0];
    expect(food.calories_per_100g).toBe(180);
    expect(food.protein_per_100g).toBe(32);
    expect(food.canonical_name).toBe('Chicken Breast');
  });

  it('applies ORDER BY with LIMIT and LIMIT without ORDER BY', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    for (let i = 1; i <= 5; i++) {
      await db.run(
        `INSERT INTO foods (id, canonical_name, normalized_name, calories_per_100g, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [`f${i}`, `Food ${i}`, `food ${i}`, 100 + i, 'now']
      );
    }

    const newest = await queryValues(db, `SELECT * FROM foods ORDER BY canonical_name DESC LIMIT 1`);
    expect(newest[0].id).toBe('f5');

    const fuzzy = await queryValues(db,
      `SELECT * FROM foods WHERE normalized_name LIKE ? OR canonical_name LIKE ? LIMIT ?`,
      ['%food%', '%food%', 2]
    );
    expect(fuzzy).toHaveLength(2);

    const byDate = await queryValues(db,
      `SELECT * FROM food_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC`,
      ['2026-08-01', '2026-08-31']
    );
    expect(byDate).toEqual([]);
  });

  it('aggregates water totals by source', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO water_logs (id, date, amount_ml, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['w1', '2026-08-20', 500, 'explicit', 'now']
    );
    await db.run(
      `INSERT INTO water_logs (id, date, amount_ml, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['w2', '2026-08-20', 250, 'drink', 'now']
    );
    await db.run(
      `INSERT INTO water_logs (id, date, amount_ml, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['w3', '2026-08-20', 100, 'food', 'now']
    );

    const rows = await queryValues(db,
      `SELECT source, SUM(amount_ml) as total FROM water_logs WHERE date = ? GROUP BY source`,
      ['2026-08-20']
    );
    const totals = Object.fromEntries(rows.map(r => [r.source, r.total]));
    expect(totals).toEqual({ explicit: 500, drink: 250, food: 100 });
  });

  it('computes daily food totals with SUM(calories)', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, water_ml, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['l1', '2026-08-20', 'f1', 300, 20, 30, 10, 0, 'now']
    );
    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, water_ml, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['l2', '2026-08-20', 'f2', 700, 40, 80, 20, 100, 'now']
    );

    const rows = await queryValues(db,
      `SELECT SUM(calories) as calories, SUM(protein_g) as protein_g, SUM(carbs_g) as carbs_g, SUM(fat_g) as fat_g, SUM(water_ml) as water_ml FROM food_logs WHERE date = ?`,
      ['2026-08-20']
    );
    expect(rows[0]).toEqual({ calories: 1000, protein_g: 60, carbs_g: 110, fat_g: 30, water_ml: 100 });
  });

  it('groups daily food totals per date with SUM + GROUP BY date (batch history path)', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, water_ml, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['l1', '2026-08-19', 'f1', 300, 20, 30, 10, 0, 'now']
    );
    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, water_ml, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['l2', '2026-08-19', 'f2', 700, 40, 80, 20, 100, 'now']
    );
    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, water_ml, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['l3', '2026-08-18', 'f1', 100, 5, 10, 2, 0, 'now']
    );

    const rows = await queryValues(db,
      `SELECT date, SUM(calories) as calories, SUM(protein_g) as protein_g, SUM(carbs_g) as carbs_g, SUM(fat_g) as fat_g, SUM(water_ml) as water_ml FROM food_logs WHERE date >= ? AND date <= ? GROUP BY date`,
      ['2026-08-18', '2026-08-20']
    );
    const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
    expect(byDate['2026-08-19']).toEqual({ date: '2026-08-19', calories: 1000, protein_g: 60, carbs_g: 110, fat_g: 30, water_ml: 100 });
    expect(byDate['2026-08-18']).toEqual({ date: '2026-08-18', calories: 100, protein_g: 5, carbs_g: 10, fat_g: 2, water_ml: 0 });
  });

  it('groups water totals per date and source with GROUP BY date, source (batch history path)', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO water_logs (id, date, amount_ml, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['w1', '2026-08-19', 500, 'explicit', 'now']
    );
    await db.run(
      `INSERT INTO water_logs (id, date, amount_ml, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['w2', '2026-08-19', 250, 'drink', 'now']
    );
    await db.run(
      `INSERT INTO water_logs (id, date, amount_ml, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['w3', '2026-08-18', 999, 'explicit', 'now']
    );

    const rows = await queryValues(db,
      `SELECT date, source, SUM(amount_ml) as total FROM water_logs WHERE date >= ? AND date <= ? GROUP BY date, source`,
      ['2026-08-18', '2026-08-20']
    );
    const byDate: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      byDate[r.date] = byDate[r.date] || {};
      byDate[r.date][r.source] = r.total;
    }
    expect(byDate['2026-08-19']).toEqual({ explicit: 500, drink: 250 });
    expect(byDate['2026-08-18']).toEqual({ explicit: 999 });
  });

  it('counts rows for overlap validation', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO goals (id, name, start_date, calories_target, protein_target, carbs_target, fat_target, water_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['g1', 'Default', '2026-01-01', 2500, 150, 250, 80, 4000, 'now']
    );

    const rows = await queryValues(db,
      `SELECT COUNT(*) as count FROM goals WHERE end_date IS NULL OR end_date >= ?`,
      ['2026-09-01']
    );
    expect(rows[0].count).toBe(1);
  });

  it('resolves current goal with end_date IS NULL + ORDER BY + LIMIT', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO goals (id, name, start_date, end_date, calories_target, protein_target, carbs_target, fat_target, water_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['g1', 'Old', '2026-01-01', '2026-06-30', 2000, 100, 200, 70, 3000, 'now']
    );
    await db.run(
      `INSERT INTO goals (id, name, start_date, end_date, calories_target, protein_target, carbs_target, fat_target, water_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['g2', 'Current', '2026-07-01', null, 2500, 150, 250, 80, 4000, 'now']
    );

    const rows = await queryValues(db,
      `SELECT * FROM goals WHERE end_date IS NULL ORDER BY start_date DESC LIMIT 1`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Current');
  });

  it('resolves the goal active on a date', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO goals (id, name, start_date, end_date, calories_target, protein_target, carbs_target, fat_target, water_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['g1', 'Old', '2026-01-01', '2026-06-30', 2000, 100, 200, 70, 3000, 'now']
    );
    await db.run(
      `INSERT INTO goals (id, name, start_date, end_date, calories_target, protein_target, carbs_target, fat_target, water_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['g2', 'Current', '2026-07-01', null, 2500, 150, 250, 80, 4000, 'now']
    );

    const rows = await queryValues(db,
      `SELECT * FROM goals
       WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY start_date DESC LIMIT 1`,
      ['2026-08-20', '2026-08-20']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Current');
  });

  it('enriches food_logs with the food name via JOIN foods', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO foods (id, canonical_name, normalized_name, created_at) VALUES (?, ?, ?, ?)`,
      ['f1', 'Chicken Breast', 'chicken breast', 'now']
    );
    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['l1', '2026-08-20', 'f1', 300, 20, 30, 10, 'now']
    );

    const rows = await queryValues(db,
      `SELECT fl.*, f.canonical_name AS food_name FROM food_logs fl JOIN foods f ON f.id = fl.food_id WHERE fl.date = ? ORDER BY fl.created_at ASC`,
      ['2026-08-20']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].food_name).toBe('Chicken Breast');
    expect(rows[0].canonical_name).toBe('Chicken Breast');
  });

  it('upserts barcodes via ON CONFLICT with excluded.* resolution', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO foods (id, canonical_name, normalized_name, created_at) VALUES (?, ?, ?, ?)`,
      ['f1', 'Old Food', 'old food', 'now']
    );
    await db.run(
      `INSERT INTO foods (id, canonical_name, normalized_name, created_at) VALUES (?, ?, ?, ?)`,
      ['f2', 'New Food', 'new food', 'now']
    );

    const insert = async (foodId: string) => {
      await db.run(
        `INSERT INTO food_barcodes (id, food_id, barcode, source, verified, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(barcode) DO UPDATE SET food_id = excluded.food_id, source = excluded.source`,
        [foodId === 'f1' ? 'b1' : 'b2', foodId, '5901234123457', 'scan', 'now']
      );
    };

    await insert('f1');
    const barcodes = store.debug().tables.food_barcodes;
    expect(barcodes).toHaveLength(1);
    expect(barcodes[0].food_id).toBe('f1');

    await insert('f2');
    expect(barcodes).toHaveLength(1);
    expect(barcodes[0].food_id).toBe('f2');
  });

  it('deletes by id and by combo_id', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['l1', '2026-08-20', 'f1', 300, 'now']
    );
    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['l2', '2026-08-20', 'f2', 400, 'now']
    );
    await db.run(
      `INSERT INTO combo_items (id, combo_id, food_id, amount_g, amount_ml) VALUES (?, ?, ?, ?, ?)`,
      ['ci1', 'c1', 'f1', 100, null]
    );
    await db.run(
      `INSERT INTO combo_items (id, combo_id, food_id, amount_g, amount_ml) VALUES (?, ?, ?, ?, ?)`,
      ['ci2', 'c1', 'f2', 200, null]
    );

    await db.run(`DELETE FROM food_logs WHERE id = ?`, ['l1']);
    await db.run(`DELETE FROM combo_items WHERE combo_id = ?`, ['c1']);

    expect(store.debug().tables.food_logs.map((r: any) => r.id)).toEqual(['l2']);
    expect(store.debug().tables.combo_items).toEqual([]);
  });

  it('computes first/last dates with MIN(date)/MAX(date)', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['l1', '2026-08-10', 'f1', 300, 'now']
    );
    await db.run(
      `INSERT INTO food_logs (id, date, food_id, calories, created_at) VALUES (?, ?, ?, ?, ?)`,
      ['l2', '2026-08-20', 'f2', 400, 'now']
    );

    const rows = await queryValues(db,
      `SELECT MIN(date) as first_date, MAX(date) as last_date FROM food_logs`
    );
    expect(rows[0]).toEqual({ first_date: '2026-08-10', last_date: '2026-08-20' });

    const empty = await queryValues(db,
      `SELECT MIN(date) as first_date, MAX(date) as last_date FROM water_logs`
    );
    expect(empty[0]).toEqual({ first_date: null, last_date: null });
  });

  it('resolves alias lookups via JOIN food_aliases', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    await db.run(
      `INSERT INTO foods (id, canonical_name, normalized_name, created_at) VALUES (?, ?, ?, ?)`,
      ['f1', 'Chicken Breast', 'chicken breast', 'now']
    );
    await db.run(
      `INSERT INTO food_aliases (id, food_id, normalized_alias, created_at) VALUES (?, ?, ?, ?)`,
      ['a1', 'f1', 'chicken', 'now']
    );

    const rows = await queryValues(db,
      `SELECT f.* FROM foods f JOIN food_aliases fa ON fa.food_id = f.id WHERE fa.normalized_alias = ?`,
      ['chicken']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_name).toBe('Chicken Breast');
  });

  // §5c additions: journal + export queries must survive fallback mode.
  it('aggregates daily AVG/MIN food confidence across a JOIN', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    store.setTable('foods', [
      { id: 'f1', canonical_name: 'Chicken', normalized_name: 'chicken', confidence: 1.0 },
      { id: 'f2', canonical_name: 'Oats', normalized_name: 'oats', confidence: 0.8 }
    ]);
    store.setTable('food_logs', [
      { id: 'l1', date: '2026-08-01', food_id: 'f1', calories: 165 },
      { id: 'l2', date: '2026-08-01', food_id: 'f2', calories: 389 },
      { id: 'l3', date: '2026-08-02', food_id: 'f2', calories: 194 }
    ]);

    const rows = await queryValues(db,
      `SELECT fl.date, AVG(f.confidence) AS avg_confidence, MIN(f.confidence) AS min_confidence
       FROM food_logs fl JOIN foods f ON f.id = fl.food_id
       WHERE fl.date >= ? AND fl.date <= ? GROUP BY fl.date`,
      ['2026-08-01', '2026-08-31']
    );
    expect(rows).toHaveLength(2);
    const day1 = rows.find(r => r.date === '2026-08-01');
    expect(day1.avg_confidence).toBeCloseTo(0.9, 5);
    expect(day1.min_confidence).toBeCloseTo(0.8, 5);
    expect(rows.find(r => r.date === '2026-08-02').avg_confidence).toBeCloseTo(0.8, 5);
  });

  it('lists water logs for a range in date order (journal)', async () => {
    const store = createStore();
    const db = createFallbackConnection(store);

    store.setTable('water_logs', [
      { id: 'w2', date: '2026-08-02', amount_ml: 250, source: 'explicit', created_at: 'a' },
      { id: 'w1', date: '2026-08-01', amount_ml: 500, source: 'explicit', created_at: 'b' },
      { id: 'w3', date: '2026-08-03', amount_ml: 1000, source: 'drink', created_at: 'c' }
    ]);

    const rows = await queryValues(db,
      `SELECT * FROM water_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC`,
      ['2026-07-31', '2026-08-02']
    );
    expect(rows.map(r => r.id)).toEqual(['w1', 'w2']);
  });
});