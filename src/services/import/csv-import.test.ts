import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCSV } from './csv-import';

describe('parseCSV', () => {
  it('parses a standard tracker export with all core columns', () => {
    const csv = [
      'Date,Food,Calories,Protein,Carbs,Fat,Amount',
      '2026-04-05,Chicken Breast,165,31,0,3.6,100',
      '2026-04-05,Rice,130,2.7,28,0.3,150'
    ].join('\n');

    const { rows, errors } = parseCSV(csv);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2026-04-05', foodName: 'Chicken Breast', calories: 165, proteinG: 31, carbsG: 0, fatG: 3.6, amountG: 100 });
    expect(rows[1].amountG).toBe(150);
  });

  it('returns an error for an empty file', () => {
    const { rows, errors } = parseCSV('');
    expect(rows).toEqual([]);
    expect(errors[0]).toContain('empty');
  });

  it('returns an error when Date and Calories columns are missing', () => {
    const { rows, errors } = parseCSV('Name,Notes\nChicken,hi');
    expect(rows).toEqual([]);
    expect(errors[0]).toContain('Date');
  });

  it('skips rows with invalid dates and reports them', () => {
    const csv = [
      'Date,Food,Calories',
      'not-a-date,Chicken,165',
      '2026-04-05,Rice,130'
    ].join('\n');

    const { rows, errors } = parseCSV(csv);

    expect(rows).toHaveLength(1);
    expect(rows[0].foodName).toBe('Rice');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not-a-date');
  });

  it('treats missing macro columns as zero', () => {
    const { rows } = parseCSV('Date,Food,Calories\n2026-04-05,Apple,95');
    expect(rows[0]).toMatchObject({ calories: 95, proteinG: 0, carbsG: 0, fatG: 0, amountG: 100 });
  });

  it('defaults missing amount to 100g', () => {
    const { rows } = parseCSV('Date,Food,Calories\n2026-04-05,Apple,95');
    expect(rows[0].amountG).toBe(100);
  });

  it('handles quoted values and header case-insensitivity', () => {
    const csv = [
      'date, "food", "calories", protein',
      '2026-04-05,"Chicken, Grilled",165,31'
    ].join('\n');

    const { rows, errors } = parseCSV(csv);
    expect(errors).toEqual([]);
    expect(rows[0].foodName).toBe('Chicken, Grilled');
    expect(rows[0].calories).toBe(165);
    expect(rows[0].proteinG).toBe(31);
  });

  describe('legacy daily-aggregate export (old app format, exportexample.csv shape)', () => {
    const legacyHeader = [
      'Date', 'Result', 'Score Tier', 'Reason', 'Target Kcal', 'Target Pro(g)',
      'Target Carb(g)', 'Target Fat(g)', 'Target Water(ml)', 'Logs',
      'Total Calories', 'Total Protein', 'Total Carbs', 'Total Fats',
      'Pure Water (ml)', 'Exercise Logged', 'Exercise Details'
    ].join(',');

    it('expands each legacy day into ONE ROW PER FOOD (no aggregate mega-item)', () => {
      const csv = [
        legacyHeader,
        '2026-04-05,Grey,score-0,"Off target.",2500,150,295,80,4000,"Air-fried Steakhouse Fries | Chips | Choco Pops",1282,65,181,30,0,No,None',
        '2026-04-06,Red,score-neg-2,"Rough day.",2500,150,295,80,4000,"Snack | Banana",1855,72,248,66,2000,Yes,"Treadmill (Speed 3, Incline 2) (-850kcal)"'
      ].join('\n');

      const { rows, errors } = parseCSV(csv);
      expect(errors).toEqual([]);
      expect(rows).toHaveLength(5); // 3 + 2 items

      // §5c-4 BUG CHECK: before the fix a whole day collapsed into ONE
      // mega-item carrying all of the day's macros.
      const day1 = rows.filter(r => r.date === '2026-04-05');
      expect(day1.map(r => r.foodName)).toEqual(['Air-fried Steakhouse Fries', 'Chips', 'Choco Pops']);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      expect(sum(day1.map(r => r.calories))).toBeCloseTo(1282, 5);
      expect(sum(day1.map(r => r.proteinG))).toBeCloseTo(65, 5);
      expect(sum(day1.map(r => r.carbsG))).toBeCloseTo(181, 5);
      expect(sum(day1.map(r => r.fatG))).toBeCloseTo(30, 5);
      day1.forEach(r => expect(r.amountG).toBe(100));

      // Reads ACTUALS, never Target columns (regression from pass 12).
      expect(sum(rows.filter(r => r.date === '2026-04-06').map(r => r.calories))).toBeCloseTo(1855, 5);

      // Split days are marked as estimates.
      day1.forEach(r => expect(r.estimatedSplit).toBe(true));
    });

    it('attaches Pure Water to exactly one row per legacy day', () => {
      const csv = [
        legacyHeader,
        '2026-04-05,Grey,score-0,"Off target.",2500,150,295,80,4000,"Air-fried Steakhouse Fries | Chips | Choco Pops",1282,65,181,30,0,No,None',
        '2026-04-06,Red,score-neg-2,"Rough day.",2500,150,295,80,4000,"Snack | Banana",1855,72,248,66,2000,Yes,None'
      ].join('\n');

      const { rows } = parseCSV(csv);
      const withWater = rows.filter(r => r.waterMl !== undefined && r.waterMl > 0);
      expect(withWater).toHaveLength(1);
      expect(withWater[0].date).toBe('2026-04-06');
      expect(withWater[0].waterMl).toBe(2000);
    });

    it('names every item from its segment of the Logs column', () => {
      const csv = [
        legacyHeader,
        '2026-04-05,Grey,score-0,"x.",2500,150,295,80,4000,"Air-fried Steakhouse Fries | Chips | Choco Pops",1282,65,181,30,0,No,None'
      ].join('\n');

      const { rows } = parseCSV(csv);
      expect(rows.map(r => r.foodName)).toEqual(['Air-fried Steakhouse Fries', 'Chips', 'Choco Pops']);
    });
  });

  describe('real old-app export file (exportexample.csv)', () => {
    const csv = readFileSync(new URL('../../../exportexample.csv', import.meta.url), 'utf8');

    it('parses every day without errors and never fabricates an "Imported Item"', () => {
      const { rows, errors } = parseCSV(csv);
      expect(errors).toEqual([]);
      expect(rows.length).toBeGreaterThan(80);
      rows.forEach(r => {
        expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isFinite(r.calories)).toBe(true);
        expect(r.foodName).not.toBe('Imported Item');
      });
    });

    it('imports the day TOTALS across per-item rows, not the targets (bug check: 2026-04-05)', () => {
      const { rows } = parseCSV(csv);
      // §5c-4 BUG CHECK (mega-item): the day expands into one row per named
      // food whose SUM equals the real day totals (1282/65/181/30) — before
      // this pass it was one aggregate item, and before pass 12 it read targets.
      const day = rows.filter(r => r.date === '2026-04-05');
      expect(day.length).toBeGreaterThan(1);
      expect(day[0].foodName).toBe('Air-fried Steakhouse Fries');
      expect(new Set(day.map(r => r.foodName)).size).toBe(day.length);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      expect(sum(day.map(r => r.calories))).toBeCloseTo(1282, 5);
      expect(sum(day.map(r => r.proteinG))).toBeCloseTo(65, 5);
      expect(sum(day.map(r => r.carbsG))).toBeCloseTo(181, 5);
      expect(sum(day.map(r => r.fatG))).toBeCloseTo(30, 5);
      day.forEach(r => { expect(r.waterMl ?? 0).toBe(0); });
    });

    it('picks up a day with exercise and water (single water row)', () => {
      const { rows } = parseCSV(csv);
      const dayRows = rows.filter(r => r.date === '2026-04-06');
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      expect(sum(dayRows.map(r => r.calories))).toBeCloseTo(1855, 5);
      const waterRows = dayRows.filter(r => (r.waterMl ?? 0) > 0);
      expect(waterRows).toHaveLength(1);
      expect(waterRows[0].waterMl).toBe(2000);
      expect(waterRows[0].foodName).toBe('Snack');
    });
  });
});