import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
// @ts-ignore — Vite ?raw import (same pattern as src/data/database.ts)
import v001InitSql from '../../data/migrations/v001__init.sql?raw';
import { FoodRepository } from '../../data/repositories/food.repo';
import { LogRepository } from '../../data/repositories/log.repo';
import { WaterRepository } from '../../data/repositories/water.repo';
import { GoalRepository } from '../../data/repositories/goal.repo';
import { DailyRecordRepository } from '../../data/repositories/daily-record.repo';
import { InsertFood } from '../../data/types';
import { buildExportRows, datesBetween, goalPhaseRange, resolveExportDateRange, ExportRepos } from './export-service';
import { generateCSV } from './csv-export';
import { getTodayDateString } from '../../utils/dates';

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

/** Same sql.js adapter shape used by sqlite-real.test.ts. */
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
    async beginTransaction() { db.run('BEGIN TRANSACTION'); },
    async commitTransaction() { db.run('COMMIT'); },
    async rollbackTransaction() { db.run('ROLLBACK'); },
    async isOpened() { return { result: true }; },
    async close() { db.close(); }
  };

  return { db, conn };
}

async function buildRepos(conn: any): Promise<ExportRepos> {
  return {
    goal: new GoalRepository(conn),
    log: new LogRepository(conn),
    water: new WaterRepository(conn),
    dailyRecord: new DailyRecordRepository(conn)
  };
}

async function seedTwoDayScenario(conn: any) {
  const foodRepo = new FoodRepository(conn);
  const logRepo = new LogRepository(conn);
  const waterRepo = new WaterRepository(conn);
  const goalRepo = new GoalRepository(conn);
  const dailyRepo = new DailyRecordRepository(conn);

  const chicken = await foodRepo.insert(CHICKEN);
  const oats = await foodRepo.insert(OATS);

  // Goal phase A: cut until 2026-07-31
  const cut = await goalRepo.createGoal({
    name: 'Cut',
    start_date: '2026-07-01',
    end_date: null,
    calories_target: 2000,
    protein_target: 140,
    carbs_target: 180,
    fat_target: 70,
    water_target: 3000
  });

  // Day 1 (cut): 200g chicken = 330 kcal
  await logRepo.insertFoodLog({
    date: '2026-07-10', food_id: chicken.id, amount_g: 200,
    calories: 330, protein_g: 62, carbs_g: 0, fat_g: 7.2, water_ml: 130
  });
  await waterRepo.insertWaterLog({ date: '2026-07-10', amount_ml: 1500, source: 'explicit' });
  await waterRepo.insertWaterLog({ date: '2026-07-10', amount_ml: 130, source: 'food', food_log_id: null });

  // Daily record for day 1: low accuracy + note
  await dailyRepo.setLowAccuracy('2026-07-10', true);
  await dailyRepo.setNote('2026-07-10', 'Forgot the salad');

  // Day 2 (also cut): 100g oats = 389 kcal + explicit water above target
  await logRepo.insertFoodLog({
    date: '2026-07-11', food_id: oats.id, amount_g: 100,
    calories: 389, protein_g: 13, carbs_g: 66, fat_g: 7, water_ml: 9
  });
  await waterRepo.insertWaterLog({ date: '2026-07-11', amount_ml: 3000, source: 'explicit' });
  await waterRepo.insertWaterLog({ date: '2026-07-11', amount_ml: 9, source: 'food' });

  // Day 3: empty day — no food, no water

  // Close Cut and open Bulk on 2026-08-01
  await goalRepo.createGoal({
    name: 'Bulk',
    start_date: '2026-08-01',
    end_date: null,
    calories_target: 2800,
    protein_target: 170,
    carbs_target: 320,
    fat_target: 90,
    water_target: 3500
  });

  // Day 4 (bulk): 150g oats
  await logRepo.insertFoodLog({
    date: '2026-08-02', food_id: oats.id, amount_g: 150,
    calories: 583.5, protein_g: 19.5, carbs_g: 99, fat_g: 10.5, water_ml: 13.5
  });
  await waterRepo.insertWaterLog({ date: '2026-08-02', amount_ml: 2000, source: 'explicit' });

  return { cut, chicken, oats };
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('datesBetween', () => {
  it('returns every date between two bounds inclusive', () => {
    expect(datesBetween('2026-07-10', '2026-07-12')).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
    expect(datesBetween('2026-08-01', '2026-08-01')).toEqual(['2026-08-01']);
  });

  it('crosses month boundaries correctly', () => {
    expect(datesBetween('2026-01-30', '2026-02-02')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });
});

describe('goalPhaseRange', () => {
  it('uses end_date when set, otherwise today', () => {
    expect(goalPhaseRange({ start_date: '2026-07-01', end_date: '2026-07-31' })).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-31'
    });
    const open = goalPhaseRange({ start_date: '2026-07-01', end_date: null });
    expect(open.startDate).toBe('2026-07-01');
    expect(open.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('resolveExportDateRange (all-time bounds)', () => {
  it('spans from the first data date to the last (logs + water + goals)', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const range = await resolveExportDateRange(repos);
    expect(range.startDate).toBe('2026-07-01'); // oldest goal start
    expect(range.endDate).toBe(getTodayDateString()); // capped at today (later than the seeded data)
  });

  it('falls back to today when there is no data at all', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    const range = await resolveExportDateRange(repos);
    expect(range.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.endDate).toBe(range.startDate);
  });
});

describe('buildExportRows', () => {
  it('exports one row per data day with the correct goal phase and targets', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const dates = datesBetween('2026-07-01', '2026-08-31');
    const rows = await buildExportRows(dates, repos);

    expect(rows.map(r => r.date)).toEqual(['2026-07-10', '2026-07-11', '2026-08-02']);
    expect(rows[0].goalName).toBe('Cut');
    expect(rows[0].caloriesTarget).toBe(2000);
    expect(rows[0].proteinTarget).toBe(140);
    expect(rows[2].goalName).toBe('Bulk');
    expect(rows[2].caloriesTarget).toBe(2800);
  });

  it('carries actuals, water breakdown and effective hydration gating', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const rows = await buildExportRows(['2026-07-10', '2026-07-11'], repos);

    // Day 1: explicit 1500 < target 3000 -> effective = explicit only (gating)
    expect(rows[0].caloriesActual).toBe(330);
    expect(rows[0].proteinActual).toBe(62);
    expect(rows[0].explicitWaterMl).toBe(1500);
    expect(rows[0].foodWaterMl).toBe(130);
    expect(rows[0].effectiveWaterMl).toBe(1500);

    // Day 2: explicit 3000 >= target 3000 -> food/drink eligible
    expect(rows[1].effectiveWaterMl).toBe(3009);
  });

  it('emits the legacy score contract (tier/code/result/reason)', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const rows = await buildExportRows(['2026-07-10'], repos);
    // Day 1: 330 kcal vs 2000 (lower), protein 62/140 (low), water 1500/3000 (low)
    expect(rows[0].scoreResult).toBe('Grey');
    expect(rows[0].scoreCode).toBe('0');
    expect(rows[0].scoreTier).toBe('score-0');
    expect(rows[0].scoreReason).toContain('Off target across the board');
  });

  it('includes the daily record low-accuracy flag and day note', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const rows = await buildExportRows(['2026-07-10', '2026-07-11', '2026-08-02'], repos);
    expect(rows[0].lowAccuracy).toBe(true);
    expect(rows[0].dailyNote).toBe('Forgot the salad');
    expect(rows[1].lowAccuracy).toBe(false);
    expect(rows[1].dailyNote).toBe('');
  });

  it('skips days with no data and returns an empty list for an empty range', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const rows = await buildExportRows(['2026-07-13', '2026-07-14'], repos);
    expect(rows).toEqual([]);

    expect(await buildExportRows([], repos)).toEqual([]);
  });

  it('export rows round-trip through generateCSV (locked 21-column format)', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const rows = await buildExportRows(datesBetween('2026-07-01', '2026-08-31'), repos);
    const csv = generateCSV(rows);
    const lines = csv.split('\n');
    expect(lines[0].split(',')).toHaveLength(21);
    expect(lines).toHaveLength(4); // header + 3 data days
    expect(csv).toContain('Cut');
    expect(csv).toContain('Bulk');
  });

  it('resolves the goal-for-date per phase across the range (no relabeling of history)', async () => {
    const { conn } = createRealDb();
    const repos = await buildRepos(conn);
    await seedTwoDayScenario(conn);

    const rows = await buildExportRows(['2026-07-10', '2026-08-02'], repos);
    expect(rows[0].goalName).toBe('Cut');
    expect(rows[0].caloriesTarget).toBe(2000);
    expect(rows[1].goalName).toBe('Bulk');
    expect(rows[1].caloriesTarget).toBe(2800);
  });
});