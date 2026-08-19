import { describe, it, expect } from 'vitest';
import {
  createBackupArchive,
  parseBackupArchive,
  validateBackupArchive,
  restoreBackupArchive,
  CURRENT_SCHEMA_VERSION
} from './backup';

const TABLE_NAMES = [
  'foods', 'food_aliases', 'food_barcodes', 'food_observations', 'food_logs',
  'water_logs', 'combos', 'combo_items', 'daily_records', 'goals', 'app_settings', 'imports'
];

function createFakeDb() {
  const tables: Record<string, any[]> = {};
  TABLE_NAMES.forEach(t => { tables[t] = []; });
  const statements: string[] = [];
  let snapshot: Record<string, any[]> | null = null;
  let failOnInsertTable: string | null = null;

  const db: any = {
    committed: false,
    rolledBack: false,
    query: async (statement: string, values?: any[]) => {
      statements.push(statement);
      const table = TABLE_NAMES.find(t => statement.includes(`FROM ${t}`));
      const rows = table ? tables[table] : [];
      if (values && values.length > 0 && statement.includes('WHERE id = ?')) {
        return { values: rows.filter(r => r.id === values[0]) };
      }
      return { values: rows };
    },
    run: async (statement: string, values?: any[]) => {
      statements.push(statement);
      const deleteMatch = statement.match(/DELETE FROM (\w+)/);
      if (deleteMatch) {
        tables[deleteMatch[1]] = [];
        return { changes: { changes: 1, lastId: 0 } };
      }
      const insertMatch = statement.match(/INSERT INTO (\w+) \(([^)]+)\) VALUES/);
      if (insertMatch) {
        const table = insertMatch[1];
        if (failOnInsertTable === table) throw new Error(`boom on ${table}`);
        const cols = insertMatch[2].split(',').map(c => c.trim());
        const row: any = {};
        cols.forEach((c, i) => { row[c] = values?.[i]; });
        tables[table].push(row);
        return { changes: { changes: 1, lastId: 0 } };
      }
      return { changes: { changes: 1, lastId: 0 } };
    },
    execute: async () => ({ changes: { changes: 0 } }),
    beginTransaction: async () => {
      snapshot = JSON.parse(JSON.stringify(tables));
    },
    commitTransaction: async () => { db.committed = true; },
    rollbackTransaction: async () => {
      db.rolledBack = true;
      if (snapshot) {
        Object.keys(tables).forEach(t => { tables[t] = []; });
        Object.entries(snapshot).forEach(([t, rows]) => { tables[t] = rows; });
      }
    }
  };

  return { db, tables, statements, setFailOnInsertTable: (t: string | null) => { failOnInsertTable = t; } };
}

function sampleArchive(): any {
  return JSON.parse(createBackupArchive({
    foods: [{
      id: 'f1', canonical_name: 'Chicken Breast', normalized_name: 'chickenbreast',
      calories_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6,
      water_per_100g: 65, nutrition_basis: 'per_100g', source_type: 'user_entered',
      source_reference: null, confidence: 1, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
    }],
    food_logs: [{
      id: 'l1', date: '2026-08-19', food_id: 'f1', observation_id: null,
      amount_g: 250, amount_ml: null, calories: 412.5, protein_g: 77.5, carbs_g: 0, fat_g: 9,
      water_ml: 162.5, note: null, created_at: '2026-08-19T00:00:00.000Z'
    }],
    goals: [{
      id: 'g1', name: 'Cut', start_date: '2026-01-01', end_date: null,
      calories_target: 2200, protein_target: 150, carbs_target: 200, fat_target: 80,
      water_target: 4000, created_at: '2026-08-19T00:00:00.000Z'
    }]
  }));
}

describe('createBackupArchive / parseBackupArchive round trip', () => {
  it('round-trips all 12 tables through JSON', () => {
    const archive = sampleArchive();
    const parsed = parseBackupArchive(JSON.stringify(archive));
    expect(parsed).not.toBeNull();
    expect(parsed!.app).toBe('EverydayFuel');
    expect(parsed!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(Object.keys(parsed!.data).sort()).toEqual([...TABLE_NAMES].sort());
    expect(parsed!.data.foods).toHaveLength(1);
    expect(parsed!.data.food_logs[0].calories).toBe(412.5);
  });

  it('includes all 12 tables even when inputs are empty', () => {
    const archive = createBackupArchive({});
    TABLE_NAMES.forEach(t => expect(JSON.parse(archive).data[t]).toEqual([]));
  });

  it('rejects invalid JSON', () => {
    expect(parseBackupArchive('not json {{{')).toBeNull();
  });

  it('rejects archives from another app', () => {
    expect(parseBackupArchive('{"app":"OtherApp","data":{}}')).toBeNull();
  });

  it('rejects archives without a data section', () => {
    expect(parseBackupArchive('{"app":"EverydayFuel"}')).toBeNull();
  });
});

describe('validateBackupArchive', () => {
  it('accepts a valid archive', () => {
    expect(validateBackupArchive(sampleArchive())).toEqual([]);
  });

  it('rejects a future schema version', () => {
    const archive = sampleArchive();
    archive.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    const errors = validateBackupArchive(archive);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('newer');
  });

  it('rejects a missing schema version', () => {
    const archive = sampleArchive();
    delete archive.schemaVersion;
    expect(validateBackupArchive(archive).length).toBeGreaterThan(0);
  });

  it('rejects a non-object payload', () => {
    expect(validateBackupArchive(null).length).toBeGreaterThan(0);
    expect(validateBackupArchive('hello').length).toBeGreaterThan(0);
  });
});

describe('restoreBackupArchive', () => {
  it('clears existing data and restores archive rows in FK-safe order', async () => {
    const { db, tables, statements } = createFakeDb();
    tables.foods.push({ id: 'old-food', canonical_name: 'Old Food' });
    tables.food_logs.push({ id: 'old-log', date: '2026-01-01', food_id: 'old-food' });
    tables.goals.push({ id: 'old-goal', name: 'Old' });

    const result = await restoreBackupArchive(db, sampleArchive());

    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(3);
    expect(result.tables).toHaveLength(12);
    expect(tables.foods).toHaveLength(1);
    expect(tables.foods[0].id).toBe('f1');
    expect(tables.food_logs).toHaveLength(1);
    expect(tables.food_logs[0].food_id).toBe('f1');
    expect(tables.goals).toHaveLength(1);
    expect(tables.water_logs).toEqual([]);
    expect(tables.food_aliases).toEqual([]);
    expect(tables.combo_items).toEqual([]);

    const deleteStatements = statements.filter(s => s.startsWith('DELETE FROM'));
    expect(deleteStatements).toHaveLength(12);

    const clearIndexes = deleteStatements.map(s => s.replace('DELETE FROM ', ''));
    expect(clearIndexes.indexOf('food_logs')).toBeLessThan(clearIndexes.indexOf('foods'));
    expect(clearIndexes.indexOf('water_logs')).toBeLessThan(clearIndexes.indexOf('food_logs'));
    expect(clearIndexes.indexOf('combo_items')).toBeLessThan(clearIndexes.indexOf('combos'));

    const insertIndexes = statements
      .map(s => s.match(/INSERT INTO (\w+)/)?.[1])
      .filter((t): t is string => !!t);
    expect(insertIndexes.indexOf('foods')).toBeLessThan(insertIndexes.indexOf('food_logs'));
    expect(insertIndexes.indexOf('water_logs')).toBe(-1); // archive has no water rows
    expect(insertIndexes.indexOf('goals')).toBeGreaterThanOrEqual(0);
  });

  it('wraps the restore in a transaction and commits on success', async () => {
    const { db } = createFakeDb();
    const result = await restoreBackupArchive(db, sampleArchive());
    expect(result.ok).toBe(true);
    expect(db.committed).toBe(true);
  });

  it('rolls back when an insert fails, leaving the database untouched', async () => {
    const { db, tables, setFailOnInsertTable } = createFakeDb();
    tables.foods.push({ id: 'keep-me', canonical_name: 'Existing' });
    setFailOnInsertTable('foods');

    const result = await restoreBackupArchive(db, sampleArchive());

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('boom on foods');
    expect(db.rolledBack).toBe(true);
    expect(tables.foods).toHaveLength(1);
    expect(tables.foods[0].id).toBe('keep-me');
  });

  it('clears all tables even when the archive section is empty', async () => {
    const { db, tables } = createFakeDb();
    tables.foods.push({ id: 'x' });
    tables.water_logs.push({ id: 'y' });

    const result = await restoreBackupArchive(db, JSON.parse(createBackupArchive({})));

    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(0);
    expect(tables.foods).toEqual([]);
    expect(tables.water_logs).toEqual([]);
  });

  it('restores rows that are missing optional columns', async () => {
    const { db, tables } = createFakeDb();
    const archive = JSON.parse(createBackupArchive({
      foods: [{
        id: 'f1', canonical_name: 'Minimal', normalized_name: 'minimal',
        nutrition_basis: 'per_100g', source_type: 'user_entered',
        created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
      }]
    }));

    const result = await restoreBackupArchive(db, archive);

    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(tables.foods[0].canonical_name).toBe('Minimal');
    expect(tables.foods[0].calories_per_100g).toBeUndefined();
    expect(tables.foods[0].confidence).toBeUndefined();
  });

  it('rejects an invalid archive before touching the database', async () => {
    const { db, tables, statements } = createFakeDb();
    tables.foods.push({ id: 'keep-me' });
    const bad = sampleArchive();
    bad.app = 'NotEverydayFuel';

    const result = await restoreBackupArchive(db, bad);

    expect(result.ok).toBe(false);
    expect(tables.foods).toHaveLength(1);
    expect(statements).toHaveLength(0);
  });

  it('rejects non-array table sections', async () => {
    const { db } = createFakeDb();
    const archive = sampleArchive();
    archive.data.foods = 'nope';

    const result = await restoreBackupArchive(db, archive);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('foods');
  });
});