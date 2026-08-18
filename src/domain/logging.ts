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
 * Normalize a food name for consistent lookup.
 */
export function normalizeFoodName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}
