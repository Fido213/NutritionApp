import { describe, it, expect } from 'vitest';
import {
  computeHistoryWindow,
  datesForRange,
  datesForMonth,
  datesForYear,
  dayHasData,
  mapGoalToTargets,
  DEFAULT_TARGETS,
  HistoryRepos
} from './history-window';

function fakeRepos(overrides: Partial<HistoryRepos> = {}): HistoryRepos {
  const noGoals = async () => [];
  const emptyTotals = async () => ({});
  const emptyWater = async () => ({});
  return {
    goal: { getGoalsForRange: noGoals } as any,
    log: { getDailyTotalsForRange: emptyTotals } as any,
    water: { getWaterTotalsBySourceForRange: emptyWater } as any,
    ...overrides
  };
}

describe('history window date helpers', () => {
  it('builds a trailing range of N dates ending at the anchor', () => {
    const dates = datesForRange('2026-08-20', 7);
    expect(dates).toEqual([
      '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17',
      '2026-08-18', '2026-08-19', '2026-08-20'
    ]);
  });

  it('builds every date of the month containing the anchor', () => {
    const dates = datesForMonth('2026-02-10');
    expect(dates).toHaveLength(28);
    expect(dates[0]).toBe('2026-02-01');
    expect(dates[27]).toBe('2026-02-28');
  });

  it('builds every date of the year containing the anchor', () => {
    const dates = datesForYear('2026-06-15');
    expect(dates).toHaveLength(365);
    expect(dates[0]).toBe('2026-01-01');
    expect(dates[364]).toBe('2026-12-31');
  });

  it('handles leap years', () => {
    expect(datesForMonth('2028-02-01')).toHaveLength(29);
    expect(datesForYear('2028-01-01')).toHaveLength(366);
  });
});

describe('dayHasData', () => {
  const zero = { date: '2026-08-20', calories: 0, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 };

  it('is false when nothing was logged', () => {
    expect(dayHasData(zero, { explicit: 0, drink: 0, food: 0 })).toBe(false);
  });

  it('is true when any food macro was logged', () => {
    expect(dayHasData({ ...zero, calories: 500 }, { explicit: 0, drink: 0, food: 0 })).toBe(true);
    expect(dayHasData({ ...zero, proteinG: 30 }, { explicit: 0, drink: 0, food: 0 })).toBe(true);
  });

  it('is true when any water was logged', () => {
    expect(dayHasData(zero, { explicit: 250, drink: 0, food: 0 })).toBe(true);
    expect(dayHasData(zero, { explicit: 0, drink: 300, food: 0 })).toBe(true);
    expect(dayHasData(zero, { explicit: 0, drink: 0, food: 120 })).toBe(true);
  });
});

describe('mapGoalToTargets', () => {
  it('maps snake_case DB columns with defaults', () => {
    expect(mapGoalToTargets({ calories_target: 2200, protein_target: 120 })).toEqual({
      caloriesTarget: 2200,
      proteinTarget: 120,
      carbsTarget: 250,
      fatTarget: 80,
      waterTarget: 4000
    });
  });

  it('falls back to defaults for a null goal', () => {
    expect(mapGoalToTargets(null)).toEqual(DEFAULT_TARGETS);
  });
});

describe('computeHistoryWindow', () => {
  it('computes score, totals and hydration per day', async () => {
    const repos = fakeRepos({
      goal: {
        getGoalsForRange: async () => [
          { start_date: '2026-08-20', calories_target: 2500, protein_target: 150, carbs_target: 250, fat_target: 80, water_target: 4000 }
        ]
      } as any,
      log: {
        getDailyTotalsForRange: async () => ({
          '2026-08-20': { calories: 1000, proteinG: 80, carbsG: 100, fatG: 20, waterMl: 0 }
        })
      } as any,
      water: {
        getWaterTotalsBySourceForRange: async () => ({
          '2026-08-20': { explicit: 2000, drink: 500, food: 300 }
        })
      } as any
    });

    const days = await computeHistoryWindow(['2026-08-19', '2026-08-20'], repos);

    const empty = days.get('2026-08-19')!;
    expect(empty.hasData).toBe(false);
    expect(empty.score).toBe(0);

    const logged = days.get('2026-08-20')!;
    expect(logged.hasData).toBe(true);
    expect(logged.totals.calories).toBe(1000);
    expect(logged.hydration.explicit).toBe(2000);
    expect(logged.hydration.drink).toBe(500);
    expect(logged.hydration.food).toBe(300);
    expect(logged.hydration.effectiveTotal).toBe(2000); // explicit < 4000 target -> gated
    expect(logged.targets.caloriesTarget).toBe(2500);
    expect(typeof logged.score).toBe('number');
  });

  it('counts food+drink hydration once the explicit target is met', async () => {
    const repos = fakeRepos({
      water: {
        getWaterTotalsBySourceForRange: async () => ({ '2026-08-20': { explicit: 4500, drink: 500, food: 300 } })
      } as any
    });

    const days = await computeHistoryWindow(['2026-08-20'], repos);
    expect(days.get('2026-08-20')!.hydration.effectiveTotal).toBe(5300);
  });

  it('marks a day with only water logs as having data', async () => {
    const repos = fakeRepos({
      water: {
        getWaterTotalsBySourceForRange: async () => ({ '2026-08-20': { explicit: 250, drink: 0, food: 0 } })
      } as any
    });

    const days = await computeHistoryWindow(['2026-08-20'], repos);
    expect(days.get('2026-08-20')!.hasData).toBe(true);
  });

  it('uses the batch range queries (one per table), not per-date queries', async () => {
    const calls: string[] = [];
    const repos = fakeRepos({
      goal: {
        getGoalsForRange: async () => { calls.push('getGoalsForRange'); return []; }
      } as any,
      log: {
        getDailyTotalsForRange: async () => { calls.push('getDailyTotalsForRange'); return {}; }
      } as any,
      water: {
        getWaterTotalsBySourceForRange: async () => { calls.push('getWaterTotalsBySourceForRange'); return {}; }
      } as any
    });

    await computeHistoryWindow(['2026-01-01', '2026-01-02', '2026-01-03'], repos);
    expect(calls).toEqual(['getGoalsForRange', 'getDailyTotalsForRange', 'getWaterTotalsBySourceForRange']);
  });
});