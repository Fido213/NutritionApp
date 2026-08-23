import { describe, it, expect } from 'vitest';
import { generateCSV, ExportRow } from './csv-export';

const sampleRow: ExportRow = {
  date: '2026-04-05',
  goalName: 'Cut',
  caloriesTarget: 2200,
  proteinTarget: 150,
  carbsTarget: 200,
  fatTarget: 80,
  waterTarget: 4000,
  caloriesActual: 1282.4,
  proteinActual: 65.2,
  carbsActual: 181.1,
  fatActual: 30.4,
  explicitWaterMl: 1000,
  drinkWaterMl: 500,
  foodWaterMl: 250,
  effectiveWaterMl: 1750,
  scoreTier: 'grey',
  scoreCode: 'score-0',
  scoreResult: 'Grey',
  scoreReason: 'Off target across the board (calories lower than goal, low protein, low hydration).',
  lowAccuracy: false,
  dailyNote: '',
  avgConfidence: 0.85,
  minConfidence: 0.7
};

describe('generateCSV', () => {
  it('emits the spec column set without legacy exercise columns', () => {
    const csv = generateCSV([sampleRow]);
    const header = csv.split('\n')[0];

    expect(header).toContain('Date');
    expect(header).toContain('Goal Phase');
    expect(header).toContain('Target Cal');
    expect(header).toContain('Score Tier');
    expect(header).toContain('Score Code');
    expect(header).toContain('Score Result');
    expect(header).toContain('Score Reason');
    expect(header).toContain('Explicit Water (ml)');
    expect(header).toContain('Drink Water (ml)');
    expect(header).toContain('Food Water (ml)');
    expect(header).toContain('Effective Water (ml)');
    expect(header).toContain('Low Accuracy Flag');
    expect(header).toContain('Daily Note');
    expect(header).toContain('Avg Confidence');
    expect(header).toContain('Min Confidence');
    expect(header).not.toContain('Exercise');
    // §5c-4: confidence columns extend the locked format 21 -> 23.
    expect(header.split(',')).toHaveLength(23);
  });

  it('renders confidence values at 2 decimals and empty when unknown', () => {
    const line = generateCSV([sampleRow]).split('\n')[1];
    expect(line.endsWith(',0.85,0.7')).toBe(true);

    const unknown = generateCSV([{ ...sampleRow, avgConfidence: null, minConfidence: null }]).split('\n')[1];
    // Empty confidence cells render as bare empty fields.
    expect(unknown.endsWith(',"",,')).toBe(true);

    const highPrecision = generateCSV([{ ...sampleRow, avgConfidence: 0.8333333, minConfidence: null }]).split('\n')[1];
    expect(highPrecision).toContain(',0.83,');
  });

  it('rounds nutrition values to whole numbers', () => {
    const csv = generateCSV([sampleRow]);
    const line = csv.split('\n')[1];
    expect(line).toContain('1282'); // 1282.4 kcal -> 1282
    expect(line).not.toContain('1282.4');
    expect(line).toContain('1750');
  });

  it('escapes commas and quotes in text fields', () => {
    const row = { ...sampleRow, goalName: 'Cut, "strict"', scoreReason: 'Said: "hello", then left', dailyNote: 'Ate "a lot"' };
    const csv = generateCSV([row]);
    const line = csv.split('\n')[1];
    expect(line).toContain('"Cut, ""strict"""');
    expect(line).toContain('"Said: ""hello"", then left"');
    expect(line).toContain('"Ate ""a lot"""');
  });

  it('maps the low-accuracy flag to YES/NO', () => {
    const normal = generateCSV([sampleRow]).split('\n')[1];
    expect(normal).toContain(',NO');

    const flagged = generateCSV([{ ...sampleRow, lowAccuracy: true }]).split('\n')[1];
    expect(flagged).toContain(',YES');
  });

  it('renders one line per row plus the header', () => {
    const csv = generateCSV([sampleRow, sampleRow, sampleRow]);
    expect(csv.split('\n')).toHaveLength(4);
  });
});