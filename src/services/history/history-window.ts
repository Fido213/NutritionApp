/**
 * History window computation (spec §20: history is derived from logs + daily
 * records on demand — never stored as a second dataset).
 *
 * For a set of dates, computes the daily consistency score, food totals and
 * hydration breakdown by replaying the same deterministic pipeline the
 * dashboard uses. Days with no food/water data are marked `hasData: false`
 * (the legacy app rendered those as empty blocks — old_app/app.js), so the
 * heatmap and trend chart can skip them instead of showing a neutral 0.
 */
import { GoalRepository } from '@data/repositories/goal.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { DailyTotals, GoalTargets } from '@domain/types';
import { calculateEffectiveHydration } from '@domain/hydration';
import { calculateScore } from '@domain/scoring';
import { getDateRange, formatDateISO, getDaysInMonth } from '@utils/dates';

export const DEFAULT_TARGETS: GoalTargets = {
  caloriesTarget: 2500,
  proteinTarget: 150,
  carbsTarget: 250,
  fatTarget: 80,
  waterTarget: 4000
};

export interface HistoryRepos {
  goal: GoalRepository & { getGoalsForRange(startDate: string, endDate: string): Promise<any[]> };
  log: LogRepository & { getDailyTotalsForRange(startDate: string, endDate: string): Promise<Record<string, any>> };
  water: WaterRepository & { getWaterTotalsBySourceForRange(startDate: string, endDate: string): Promise<Record<string, Record<string, number>>> };
}

export interface HistoryDay {
  score: number;
  totals: DailyTotals;
  hydration: { explicit: number; drink: number; food: number; effectiveTotal: number };
  targets: GoalTargets;
  hasData: boolean;
}

export function mapGoalToTargets(g: any): GoalTargets {
  const goal = g ?? {};
  return {
    caloriesTarget: goal.calories_target ?? goal.caloriesTarget ?? 2500,
    proteinTarget: goal.protein_target ?? goal.proteinTarget ?? 150,
    carbsTarget: goal.carbs_target ?? goal.carbsTarget ?? 250,
    fatTarget: goal.fat_target ?? goal.fatTarget ?? 80,
    waterTarget: goal.water_target ?? goal.waterTarget ?? 4000
  };
}

export function dayHasData(totals: DailyTotals, water: Record<string, number>): boolean {
  return totals.calories > 0 || totals.proteinG > 0 || totals.carbsG > 0 || totals.fatG > 0
    || (water.explicit || 0) > 0 || (water.drink || 0) > 0 || (water.food || 0) > 0;
}

export async function computeHistoryWindow(dates: string[], repos: HistoryRepos): Promise<Map<string, HistoryDay>> {
  const days = new Map<string, HistoryDay>();
  if (dates.length === 0) return days;

  const from = dates[0];
  const to = dates[dates.length - 1];

  // Batch path: three range queries total (goals / food totals / water by
  // source) instead of one native round-trip per date per table. A year view
  // previously issued 1,095 sequential queries (multi-second freeze on device).
  const [goals, totalsByDate, waterByDate] = await Promise.all([
    repos.goal.getGoalsForRange(from, to),
    repos.log.getDailyTotalsForRange(from, to),
    repos.water.getWaterTotalsBySourceForRange(from, to)
  ]);

  // getGoalsForRange returns most-recent-first; the first goal whose start is
  // <= date is the goal active on that date.
  const goalForDate = (date: string) => goals.find(g => g.start_date <= date) ?? null;

  for (const date of dates) {
    const goalRecord = goalForDate(date);
    const targets = goalRecord ? mapGoalToTargets(goalRecord) : DEFAULT_TARGETS;
    const totals = totalsByDate[date] ?? { date, calories: 0, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 };
    const water = waterByDate[date] ?? { explicit: 0, drink: 0, food: 0 };
    const hydration = calculateEffectiveHydration(water.explicit, water.drink, water.food, targets.waterTarget);
    days.set(date, {
      score: calculateScore(totals, targets, hydration).score,
      totals,
      hydration: {
        explicit: water.explicit,
        drink: water.drink,
        food: water.food,
        effectiveTotal: hydration.effectiveTotal
      },
      targets,
      hasData: dayHasData(totals, water)
    });
  }

  return days;
}

/** Last `days` dates ending at endDate (inclusive). */
export function datesForRange(endDate: string, days: number): string[] {
  return getDateRange(endDate, days);
}

/** Every date of the calendar month containing anchor (YYYY-MM-DD). */
export function datesForMonth(anchor: string): string[] {
  const d = new Date(anchor + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth();
  const count = getDaysInMonth(year, month);
  const dates: string[] = [];
  for (let day = 1; day <= count; day++) {
    dates.push(formatDateISO(new Date(year, month, day)));
  }
  return dates;
}

/** Every date of the calendar year containing anchor (YYYY-MM-DD). */
export function datesForYear(anchor: string): string[] {
  const d = new Date(anchor + 'T00:00:00');
  const year = d.getFullYear();
  const dates: string[] = [];
  for (let month = 0; month < 12; month++) {
    const count = getDaysInMonth(year, month);
    for (let day = 1; day <= count; day++) {
      dates.push(formatDateISO(new Date(year, month, day)));
    }
  }
  return dates;
}