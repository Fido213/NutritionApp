/**
 * CSV Export Service for EverydayFuel
 * Generates filterable CSV exports matching and extending legacy spec
 */

export interface ExportRow {
  date: string;
  goalName: string;
  caloriesTarget: number;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
  waterTarget: number;
  caloriesActual: number;
  proteinActual: number;
  carbsActual: number;
  fatActual: number;
  explicitWaterMl: number;
  drinkWaterMl: number;
  foodWaterMl: number;
  effectiveWaterMl: number;
  scoreTier: string;
  scoreCode: string;
  scoreResult: string;
  scoreReason: string;
  lowAccuracy: boolean;
  dailyNote: string;
}

export function generateCSV(rows: ExportRow[]): string {
  const headers = [
    'Date',
    'Goal Phase',
    'Target Cal',
    'Target Pro (g)',
    'Target Carb (g)',
    'Target Fat (g)',
    'Target Water (ml)',
    'Actual Cal',
    'Actual Pro (g)',
    'Actual Carb (g)',
    'Actual Fat (g)',
    'Explicit Water (ml)',
    'Drink Water (ml)',
    'Food Water (ml)',
    'Effective Water (ml)',
    'Score Tier',
    'Score Code',
    'Score Result',
    'Score Reason',
    'Low Accuracy Flag',
    'Daily Note'
  ];

  const lines = [headers.join(',')];

  rows.forEach(r => {
    const rowStr = [
      r.date,
      escapeCSV(r.goalName),
      r.caloriesTarget,
      r.proteinTarget,
      r.carbsTarget,
      r.fatTarget,
      r.waterTarget,
      Math.round(r.caloriesActual),
      Math.round(r.proteinActual),
      Math.round(r.carbsActual),
      Math.round(r.fatActual),
      Math.round(r.explicitWaterMl),
      Math.round(r.drinkWaterMl),
      Math.round(r.foodWaterMl),
      Math.round(r.effectiveWaterMl),
      escapeCSV(r.scoreTier),
      escapeCSV(r.scoreCode),
      escapeCSV(r.scoreResult),
      escapeCSV(r.scoreReason),
      r.lowAccuracy ? 'YES' : 'NO',
      escapeCSV(r.dailyNote)
    ].join(',');
    lines.push(rowStr);
  });

  return lines.join('\n');
}

function escapeCSV(val: string): string {
  if (!val) return '""';
  const clean = val.replace(/"/g, '""');
  return `"${clean}"`;
}

import { saveDownloadNative } from '@services/native/file-saver';

/** Save via MediaStore on Android (WebView drops blob downloads); anchor-click in browsers. */
export async function downloadCSV(filename: string, csvContent: string) {
  if (await saveDownloadNative(filename, csvContent, 'text/csv')) return;

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
