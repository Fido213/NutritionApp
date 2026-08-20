/**
 * Date-range / all-time / goal-phase CSV export (spec §21 + QoL #9/#10).
 *
 * Rows are derived on demand by replaying the same deterministic pipeline the
 * dashboard uses (goal-for-date → targets, daily totals, water by source,
 * hydration gating, score) plus the daily record metadata (low-accuracy flag,
 * day note). Nothing is stored — the export is a pure derivation over logs.
 *
 * Matching the legacy app (old_app/app.js exportDataToCSV), only days that
 * have data (food and/or water) produce a row; empty days are skipped.
 */
import { GoalRepository } from '@data/repositories/goal.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { DailyRecordRepository } from '@data/repositories/daily-record.repo';
import { ExportRow } from './csv-export';
import { calculateEffectiveHydration } from '@domain/hydration';
import { calculateScore } from '@domain/scoring';
import { DEFAULT_TARGETS, dayHasData, mapGoalToTargets } from '@services/history/history-window';
import { formatDateISO, getTodayDateString } from '@utils/dates';

export interface ExportRepos {
  goal: GoalRepository;
  log: LogRepository;
  water: WaterRepository;
  dailyRecord: DailyRecordRepository;
}

export interface ExportDateRange {
  startDate: string;
  endDate: string;
}

/** Every date between startDate and endDate inclusive (YYYY-MM-DD). */
export function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (d <= end) {
    dates.push(formatDateISO(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Earliest → latest date with any data: min over first food/water log and the
 * oldest goal start; max over the latest food/water log and today. Days with
 * no data are skipped downstream, so the bounds only need to cover data.
 */
export async function resolveExportDateRange(repos: ExportRepos): Promise<ExportDateRange> {
  const logBounds = await repos.log.getFirstAndLastDate();
  const waterBounds = await repos.water.getFirstAndLastDate();
  const goals = await repos.goal.getGoalsHistory();

  const starts = [logBounds.first, waterBounds.first, goals[goals.length - 1]?.start_date ?? null];
  const ends = [logBounds.last, waterBounds.last, getTodayDateString()];

  const first = starts.filter(Boolean).sort()[0] ?? getTodayDateString();
  const last = ends.filter(Boolean).sort()[ends.filter(Boolean).length - 1] ?? getTodayDateString();
  return { startDate: first, endDate: last };
}

/** Date range covered by a single goal phase (end_date NULL → today). */
export function goalPhaseRange(goal: { start_date: string; end_date: string | null }): ExportDateRange {
  return {
    startDate: goal.start_date,
    endDate: goal.end_date ?? getTodayDateString()
  };
}

/**
 * Build the export rows for a set of dates using the deterministic pipeline.
 * Days with no food/water data are skipped (legacy behavior).
 */
export async function buildExportRows(dates: string[], repos: ExportRepos): Promise<ExportRow[]> {
  if (dates.length === 0) return [];

  const start = dates[0];
  const end = dates[dates.length - 1];
  const records = await repos.dailyRecord.getForRange(start, end);
  const recordByDate = new Map(records.map(r => [r.date, r]));

  const rows: ExportRow[] = [];

  for (const date of dates) {
    const goalRecord = await repos.goal.getGoalForDate(date);
    const targets = goalRecord ? mapGoalToTargets(goalRecord) : DEFAULT_TARGETS;

    const totals = await repos.log.getDailyTotals(date);
    const water = await repos.water.getWaterTotalsBySource(date);

    if (!dayHasData(totals, water)) continue;

    const hydration = calculateEffectiveHydration(water.explicit, water.drink, water.food, targets.waterTarget);
    const score = calculateScore(totals, targets, hydration);
    const record = recordByDate.get(date);

    rows.push({
      date,
      goalName: goalRecord?.name ?? '',
      caloriesTarget: targets.caloriesTarget,
      proteinTarget: targets.proteinTarget,
      carbsTarget: targets.carbsTarget,
      fatTarget: targets.fatTarget,
      waterTarget: targets.waterTarget,
      caloriesActual: totals.calories,
      proteinActual: totals.proteinG,
      carbsActual: totals.carbsG,
      fatActual: totals.fatG,
      explicitWaterMl: water.explicit,
      drinkWaterMl: water.drink,
      foodWaterMl: water.food,
      effectiveWaterMl: hydration.effectiveTotal,
      scoreTier: score.scoreTier,
      scoreCode: score.scoreCode,
      scoreResult: score.result,
      scoreReason: score.reason,
      lowAccuracy: record?.low_accuracy === 1,
      dailyNote: record?.note ?? ''
    });
  }

  return rows;
}