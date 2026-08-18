/**
 * Formatting utilities for numbers, display values, and macro units
 */

export function formatMacro(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return '0';
  return val % 1 === 0 ? val.toString() : val.toFixed(1);
}

export function formatCal(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return '0';
  return Math.round(val).toLocaleString();
}

export function formatPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return '0%';
  return `${Math.round(val)}%`;
}

export function formatWater(ml: number | null | undefined): string {
  if (ml === null || ml === undefined || isNaN(ml)) return '0 ml';
  if (ml >= 1000) {
    const l = ml / 1000;
    return l % 1 === 0 ? `${l} L` : `${l.toFixed(1)} L`;
  }
  return `${Math.round(ml)} ml`;
}
