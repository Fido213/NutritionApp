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
import { getTodayDateString } from '@utils/dates';

export interface ExportRepos {
  goal: GoalRepository;
  log: LogRepository;
  water: WaterRepository;
  dailyRecord: DailyRecordRepository;
}

/**
 * Batched totals with a graceful per-date fallback for connections that
 * cannot run the grouped range query (degraded fallback shim).
 */
async function batchedTotals(dates: string[], repos: ExportRepos): Promise<Record<string, any>> {
  const start = dates[0];
  const end = dates[dates.length - 1];
  try {
    const byDate = await repos.log.getDailyTotalsForRange(start, end);
    // Degraded fallback shims may silently return {} — verify with one probe
    // before trusting the empty result; otherwise fall back per-date.
    if (dates.length > 1 && Object.keys(byDate).length === 0) {
      const probe = await repos.log.getDailyTotals(dates[Math.floor(dates.length / 2)]);
      if (!probe || (!probe.calories && !probe.proteinG && !probe.carbsG && !probe.fatG)) {
        return {}; // genuinely empty range
      }
      return await perDateTotals(dates, repos);
    }
    const out: Record<string, any> = {};
    for (const date of dates) {
      if (byDate[date]) out[date] = byDate[date];
    }
    return out;
  } catch {
    return perDateTotals(dates, repos);
  }
}

async function perDateTotals(dates: string[], repos: ExportRepos): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const date of dates) {
    out[date] = await repos.log.getDailyTotals(date);
  }
  return out;
}

/** Batched water-by-source with the same shim fallback strategy. */
async function batchedWater(dates: string[], repos: ExportRepos): Promise<Record<string, Record<string, number>>> {
  const start = dates[0];
  const end = dates[dates.length - 1];
  try {
    const byDate = await repos.water.getWaterTotalsBySourceForRange(start, end);
    const hasAny = Object.keys(byDate).length > 0;
    if (!hasAny && dates.length > 1) {
      const mid = dates[Math.floor(dates.length / 2)];
      const probe = await repos.water.getWaterTotalsBySource(mid);
      if (!probe.explicit && !probe.drink && !probe.food) {
        return byDate;
      }
      return await perDateWater(dates, repos);
    }
    return byDate;
  } catch {
    return perDateWater(dates, repos);
  }
}

async function perDateWater(dates: string[], repos: ExportRepos): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const date of dates) {
    out[date] = await repos.water.getWaterTotalsBySource(date);
  }
  return out;
}

/**
 * Daily food-confidence aggregates with the same shim fallback strategy:
 * degraded connections simply export empty confidence cells.
 */
async function batchedConfidence(dates: string[], repos: ExportRepos): Promise<Record<string, { avgConfidence: number | null; minConfidence: number | null }>> {
  try {
    return await repos.log.getDailyConfidenceForRange(dates[0], dates[dates.length - 1]);
  } catch {
    return {};
  }
}

export interface ExportDateRange {
  startDate: string;
  endDate: string;
}

/** Every date between startDate and endDate inclusive (YYYY-MM-DD). */
export function datesBetween(startDate: string, endDate: string): string[] {
  // Pure UTC-millisecond arithmetic anchored at UTC midnights: local
  // DST transitions (e.g. Africa/Cairo springs forward AT midnight, carrying
  // +1h into every later Date) made `d <= end` fail one hour early and drop
  // the final day of every range crossing a transition (verified on device
  // and by regression test).
  const pad = (n: number) => String(n).padStart(2, '0');
  const isValidYMD = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00');
    if (isNaN(d.getTime())) return false;
    const [y,m,day] = s.split('-').map(Number);
    return d.getFullYear() === y && d.getMonth()+1 === m && d.getDate() === day;
  };
  if (!isValidYMD(startDate) || !isValidYMD(endDate)) return [];
  const toUTC = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };

  const dates: string[] = [];
  const startT = toUTC(startDate);
  const endT = toUTC(endDate);
  if (Number.isNaN(startT) || Number.isNaN(endT)) return dates;
  for (let t = startT; t <= endT; t += 86400000) {
    dates.push(fmt(t));
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
 *
 * Uses the batched range queries (pass-16 pattern) instead of one native
 * round-trip per date per table — an all-time export previously issued ~400
 * sequential IPC calls, took seconds, and under that load the newest day's
 * rows could come back empty on device (verified on OPPO CPH2363).
 */
export async function buildExportRows(dates: string[], repos: ExportRepos): Promise<ExportRow[]> {
  if (dates.length === 0) return [];

  const start = dates[0];
  const end = dates[dates.length - 1];

  const [records, goalsForRange, totalsByDate, waterByDate, confidenceByDate] = await Promise.all([
    repos.dailyRecord.getForRange(start, end),
    start === end ? repos.goal.getGoalForDate(start).then(g => (g ? [g] : [])) : repos.goal.getGoalsForRange(start, end),
    batchedTotals(dates, repos),
    batchedWater(dates, repos),
    batchedConfidence(dates, repos)
  ]);
  const recordByDate = new Map(records.map(r => [r.date, r]));

  // getGoalsForRange returns most-recent-first; the first goal whose start is
  // <= date and whose end (if any) covers date is the goal active on that date.
  const sortedGoals = [...goalsForRange].sort((a, b) => b.start_date.localeCompare(a.start_date));
  const goalForDate = (date: string) => sortedGoals.find(g => g.start_date <= date && (g.end_date == null || date <= g.end_date)) ?? null;

  const rows: ExportRow[] = [];

  for (const date of dates) {
    const goalRecord = goalForDate(date);
    const targets = goalRecord ? mapGoalToTargets(goalRecord) : DEFAULT_TARGETS;
    const totals = totalsByDate[date] ?? { date, calories: 0, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 };
    const water = waterByDate[date] ?? { explicit: 0, drink: 0, food: 0 };

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
      dailyNote: record?.note ?? '',
      avgConfidence: confidenceByDate[date]?.avgConfidence ?? null,
      minConfidence: confidenceByDate[date]?.minConfidence ?? null
    });
  }

  return rows;
}