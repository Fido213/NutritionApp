import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateScore } from './scoring';
import { DailyTotals, GoalTargets, HydrationBreakdown } from './types';

/**
 * Spec §29 regression comparison: the new calculateScore must reproduce the
 * old app's scoring output. The supplied legacy export (exportexample.csv,
 * produced by old_app/app.js exportDataToCSV) is the authoritative reference:
 * every row carries the old score tier, visual state, and reason sentence
 * alongside the totals and targets that produced them.
 */

interface LegacyExportRow {
  date: string;
  result: string;      // Green / Grey / Red
  scoreTier: string;   // score-pos-5 … score-0 … score-neg-3
  reason: string;
  targets: GoalTargets;
  totals: DailyTotals;
  pureWaterMl: number;
}

const CSV_PATH = fileURLToPath(new URL('../../exportexample.csv', import.meta.url));

describe('calculateScore vs legacy export (spec §29 regression)', () => {
  const rows = parseLegacyExportCsv(readFileSync(CSV_PATH, 'utf8'));

  it('loads the full legacy reference export with the expected header', () => {
    expect(rows).toHaveLength(96);
    expect(rows[0].date).toBe('2026-04-05');
    expect(rows[rows.length - 1].date).toBe('2026-07-29');
  });

  it('replays every unambiguous legacy row through calculateScore', () => {
    const skipped: string[] = [];

    for (const row of rows) {
      const expectedScore = scoreFromTier(row.scoreTier);
      const legacyHydrationMet = row.reason.includes('hydration goal met');
      const pureWaterPct = row.pureWaterMl / row.targets.waterTarget;

      // The legacy export only records "Pure Water (ml)", but the old app
      // scored hydration against pure water PLUS drink/food water carried on
      // food logs. When the old row says "hydration goal met" while the CSV's
      // pure water alone is below 80% of target, the bridging water is not in
      // the export and the row cannot be replayed from the CSV alone.
      if (legacyHydrationMet && pureWaterPct < 0.8) {
        skipped.push(row.date);
        continue;
      }

      const hydration: HydrationBreakdown = {
        explicit: row.pureWaterMl,
        drink: 0,
        food: 0,
        effectiveTotal: row.pureWaterMl,
        target: row.targets.waterTarget
      };

      const result = calculateScore(row.totals, row.targets, hydration);

      expect(result.score, `${row.date}: score`).toBe(expectedScore);
      expect(result.scoreCode, `${row.date}: scoreCode`).toBe(scoreCodeFor(expectedScore));
      expect(result.scoreTier, `${row.date}: scoreTier`).toBe(row.scoreTier);
      expect(result.result, `${row.date}: result`).toBe(row.result);
      expect(result.reason, `${row.date}: reason`).toBe(row.reason);
    }

    expect(skipped).toEqual(['2026-05-03']);
  });

  it('documents why the non-replayable row is skipped', () => {
    const row = rows.find(r => r.date === '2026-05-03');
    expect(row).toBeDefined();
    expect(row!.result).toBe('Green');
    expect(row!.scoreTier).toBe('score-pos-2');
    expect(row!.reason).toContain('hydration goal met');
    // Pure water alone is 1850/3000 ml (61.7% < 80%): the old app reached the
    // 80% hydration threshold only because beverage entries carried water_ml
    // that the legacy CSV does not export.
    expect(row!.pureWaterMl).toBe(1850);
    expect(row!.targets.waterTarget).toBe(3000);
  });
});

function parseLegacyExportCsv(text: string): LegacyExportRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Legacy export CSV is empty');

  const header = splitCsvLine(lines[0]).map(h => h.trim().replace(/^\uFEFF/, ''));
  const expectedHeader = [
    'Date', 'Result', 'Score Tier', 'Reason', 'Target Kcal', 'Target Pro(g)',
    'Target Carb(g)', 'Target Fat(g)', 'Target Water(ml)', 'Logs',
    'Total Calories', 'Total Protein', 'Total Carbs', 'Total Fats',
    'Pure Water (ml)', 'Exercise Logged', 'Exercise Details'
  ];
  if (header.join('|') !== expectedHeader.join('|')) {
    throw new Error(`Unexpected legacy export header: ${header.join(',')}`);
  }

  const rows: LegacyExportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]).map(f => f.trim());
    if (c.length < 15) continue;

    rows.push({
      date: c[0],
      result: c[1],
      scoreTier: c[2],
      reason: c[3],
      targets: {
        caloriesTarget: parseFloat(c[4]) || 0,
        proteinTarget: parseFloat(c[5]) || 0,
        carbsTarget: parseFloat(c[6]) || 0,
        fatTarget: parseFloat(c[7]) || 0,
        waterTarget: parseFloat(c[8]) || 0
      },
      totals: {
        date: c[0],
        calories: parseFloat(c[10]) || 0,
        proteinG: parseFloat(c[11]) || 0,
        carbsG: parseFloat(c[12]) || 0,
        fatG: parseFloat(c[13]) || 0,
        waterMl: parseFloat(c[14]) || 0
      },
      pureWaterMl: parseFloat(c[14]) || 0
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  cols.push(current);
  return cols;
}

function scoreFromTier(tier: string): number {
  const m = tier.match(/^score-(pos|neg)-(\d)$/);
  if (!m) return 0;
  return m[1] === 'pos' ? Number(m[2]) : -Number(m[2]);
}

function scoreCodeFor(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}