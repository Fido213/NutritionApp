import { describe, it, expect } from 'vitest';
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
});