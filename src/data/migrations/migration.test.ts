import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
// @ts-ignore — Vite ?raw import (same pattern as src/data/database.ts)
import v001InitSql from './v001__init.sql?raw';

const MIGRATION_TABLES = [
  'foods', 'food_aliases', 'food_barcodes', 'food_observations', 'food_logs',
  'combos', 'combo_items', 'water_logs', 'daily_records', 'goals', 'app_settings', 'imports'
];

const MIGRATION_INDEXES = [
  'idx_food_logs_date', 'idx_water_logs_date', 'idx_foods_normalized',
  'idx_food_aliases_normalized', 'idx_goals_dates'
];

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJsStatic['Database']>;

let SQL: SqlJsStatic;

function createMigratedDb(): SqlDatabase {
  const db = new SQL.Database();
  db.exec(v001InitSql);
  return db;
}

function listNames(db: SqlDatabase, type: 'table' | 'index'): string[] {
  const res = db.exec(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`);
  return res.length > 0 ? res[0].values.map(v => String(v[0])) : [];
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('v001 migration on a real SQLite engine (sql.js)', () => {
  it('creates all 12 schema tables', () => {
    const db = createMigratedDb();
    const tables = listNames(db, 'table');
    for (const t of MIGRATION_TABLES) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('creates the expected performance indexes', () => {
    const db = createMigratedDb();
    const indexes = listNames(db, 'index');
    for (const idx of MIGRATION_INDEXES) {
      expect(indexes).toContain(idx);
    }
    db.close();
  });

  it('is idempotent — re-running the migration does not fail or duplicate tables', () => {
    const db = createMigratedDb();
    db.exec(v001InitSql);
    const tables = listNames(db, 'table');
    expect(tables.filter(t => t === 'foods')).toHaveLength(1);
    expect(tables.filter(t => t === 'food_logs')).toHaveLength(1);
    db.close();
  });

  it('enforces foreign keys — an orphan food_logs row is rejected', () => {
    const db = createMigratedDb();
    expect(() => {
      db.run(
        `INSERT INTO food_logs (id, date, food_id, calories, protein_g, carbs_g, fat_g, created_at)
         VALUES ('l1', '2026-08-19', 'missing-food', 100, 10, 10, 5, '2026-08-19T00:00:00.000Z')`
      );
    }).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('enforces NOT NULL and CHECK constraints from the schema', () => {
    const db = createMigratedDb();
    expect(() => {
      db.run(
        `INSERT INTO foods (id, canonical_name, normalized_name, created_at, updated_at)
         VALUES ('f1', 'X', 'x', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
      );
    }).not.toThrow();

    expect(() => {
      db.run(
        `INSERT INTO foods (id, canonical_name, normalized_name, confidence, created_at, updated_at)
         VALUES ('f2', 'Bad', 'bad', 1.5, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
      );
    }).toThrow(/CHECK/i);

    expect(() => {
      db.run(
        `INSERT INTO water_logs (id, date, amount_ml, source, created_at)
         VALUES ('w1', '2026-08-19', 250, 'cloud', '2026-08-19T00:00:00.000Z')`
      );
    }).toThrow(/CHECK/i);
    db.close();
  });

  it('round-trips the schema_version setting used by runMigrations', () => {
    const db = createMigratedDb();
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '1');");
    const res = db.exec("SELECT value FROM app_settings WHERE key = 'schema_version'");
    expect(res[0].values[0][0]).toBe('1');

    db.run("UPDATE app_settings SET value = '2' WHERE key = 'schema_version';");
    const updated = db.exec("SELECT value FROM app_settings WHERE key = 'schema_version'");
    expect(updated[0].values[0][0]).toBe('2');
    db.close();
  });

  it('persists and reloads data through the real engine (export/import round trip)', () => {
    const db = createMigratedDb();
    db.run(
      `INSERT INTO foods (id, canonical_name, normalized_name, calories_per_100g, nutrition_basis, source_type, confidence, created_at, updated_at)
       VALUES ('f1', 'Chicken Breast', 'chickenbreast', 165, 'per_100g', 'user_entered', 1.0, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
    );

    const bytes = db.export();
    const reloaded = new SQL.Database(bytes);
    const res = reloaded.exec('SELECT canonical_name, calories_per_100g FROM foods WHERE id = \'f1\'');
    expect(res[0].values[0]).toEqual(['Chicken Breast', 165]);
    reloaded.close();
    db.close();
  });
});