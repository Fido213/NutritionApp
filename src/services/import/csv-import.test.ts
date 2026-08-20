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

    it('reads ACTUAL totals, not Target columns', () => {
      const csv = [
        legacyHeader,
        '2026-04-05,Grey,score-0,"Off target.",2500,150,295,80,4000,"Air-fried Steakhouse Fries | Chips | Choco Pops",1282,65,181,30,0,No,None',
        '2026-04-06,Red,score-neg-2,"Rough day.",2500,150,295,80,4000,"Snack | Banana",1855,72,248,66,2000,Yes,"Treadmill (Speed 3, Incline 2) (-850kcal)"'
      ].join('\n');

      const { rows, errors } = parseCSV(csv);
      expect(errors).toEqual([]);
      expect(rows).toHaveLength(2);
      // BUG CHECK: before the fix these picked up Target Kcal/Pro/Carb/Fat (2500/150/295/80).
      expect(rows[0]).toMatchObject({
        date: '2026-04-05',
        calories: 1282,
        proteinG: 65,
        carbsG: 181,
        fatG: 30,
        waterMl: 0,
        amountG: 100
      });
      expect(rows[1]).toMatchObject({ calories: 1855, proteinG: 72, carbsG: 248, fatG: 66, waterMl: 2000 });
    });

    it('names the item from the first food in the Logs column', () => {
      const csv = [
        legacyHeader,
        '2026-04-05,Grey,score-0,"x.",2500,150,295,80,4000,"Air-fried Steakhouse Fries | Chips | Choco Pops",1282,65,181,30,0,No,None'
      ].join('\n');

      const { rows } = parseCSV(csv);
      expect(rows[0].foodName).toBe('Air-fried Steakhouse Fries');
    });
  });

  describe('real old-app export file (exportexample.csv)', () => {
    const csv = readFileSync(new URL('../../../exportexample.csv', import.meta.url), 'utf8');

    it('parses every day without errors', () => {
      const { rows, errors } = parseCSV(csv);
      expect(errors).toEqual([]);
      expect(rows.length).toBeGreaterThan(80);
      rows.forEach(r => {
        expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isFinite(r.calories)).toBe(true);
        expect(r.foodName).not.toBe('Imported Item');
      });
    });

    it('imports the day TOTALS, not the targets (bug check: 2026-04-05)', () => {
      const { rows } = parseCSV(csv);
      const row = rows.find(r => r.date === '2026-04-05');
      expect(row).toBeDefined();
      // Before the fix this read "Target Kcal/Pro/Carb/Fat" = 2500/150/295/80.
      expect(row!.calories).toBe(1282);
      expect(row!.proteinG).toBe(65);
      expect(row!.carbsG).toBe(181);
      expect(row!.fatG).toBe(30);
      expect(row!.waterMl).toBe(0);
    });

    it('picks up a day with exercise and water', () => {
      const { rows } = parseCSV(csv);
      const row = rows.find(r => r.date === '2026-04-06');
      expect(row).toBeDefined();
      expect(row!.calories).toBe(1855);
      expect(row!.waterMl).toBe(2000);
      expect(row!.foodName).toBe('Snack');
    });
  });
});