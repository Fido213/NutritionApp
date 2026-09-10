import { FoodReference, NutritionResult } from './types';
import { calculateNutrition } from './nutrition';

export interface ComboTemplate {
  id: string;
  name: string;
  items: Array<{
    foodId: string;
    food: FoodReference;
    amountG: number | null;
    amountMl: number | null;
  }>;
}

export interface FoodLogEntry {
  foodId: string;
  food: FoodReference;
  amountG: number | null;
  amountMl: number | null;
  note?: string;
}

/**
 * Expand a combo template into independent food log entries.
 */
export function expandCombo(combo: ComboTemplate, date: string): FoodLogEntry[] {
  console.log(`Expanding combo "${combo.name}" for date ${date}`);
  return combo.items.map(item => ({
    foodId: item.foodId,
    food: item.food,
    amountG: item.amountG,
    amountMl: item.amountMl
  }));
}

/**
 * Apply a user correction to an observation.
 */
export function applyCorrection(
  food: FoodReference,
  _originalEstimate: number,
  userCorrectedAmount: number
): { finalAmount: number; nutrition: NutritionResult } {
  const nutrition = calculateNutrition(food, userCorrectedAmount);
  return {
    finalAmount: userCorrectedAmount,
    nutrition
  };
}

/**
 * Recover a span's source text from the raw input and its char offsets.
 * The interpreter grounds every span in the original text; slicing it back
 * out gives the user's own phrase ("chicken") rather than the retrieved
 * canonical name ("Almond Chicken") — the key user defaults are pinned to.
 * Returns null for missing/out-of-range/degenerate spans.
 */
export function sliceSpanText(
  rawInput: string | null | undefined,
  span: unknown,
): string | null {
  if (!rawInput || !Array.isArray(span) || span.length !== 2) return null;
  const [s, e] = span as [unknown, unknown];
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  const start = s as number;
  const end = e as number;
  if (start < 0 || end <= start || end > rawInput.length) return null;
  const text = rawInput.slice(start, end).trim();
  return text.length >= 2 && text.length <= 60 ? text : null;
}

/**
 * Normalize a food name for consistent lookup.
 *
 * Keep-set covers Latin + Cyrillic + Arabic + CJK so non-Latin library names
 * survive (the 44k seed would otherwise collapse them all to '' against the
 * UNIQUE constraint). Pure-Latin behavior is byte-identical to before.
 */
export function normalizeFoodName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0400-\u04FF\u0600-\u06FF\u4e00-\u9fff\s]/g, '')
    .replace(/\s+/g, ' ');
}
