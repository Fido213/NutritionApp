import {
  FoodReference,
  NutritionResult,
  DailyTotals,
  GoalTargets,
  MacroProgress,
  DailyDelta,
  DeltaDirection
} from './types';

/**
 * Round to 1 decimal place for display.
 */
export function roundNutrient(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Calculate nutrition for a given food and amount.
 * factor = actual_grams / 100
 * Each nutrient = reference_per_100 * factor
 */
export function calculateNutrition(food: FoodReference, amountG: number): NutritionResult {
  const factor = amountG / 100;
  return {
    calories: food.caloriesPer100g ? food.caloriesPer100g * factor : 0,
    proteinG: food.proteinPer100g ? food.proteinPer100g * factor : 0,
    carbsG: food.carbsPer100g ? food.carbsPer100g * factor : 0,
    fatG: food.fatPer100g ? food.fatPer100g * factor : 0,
    waterMl: food.waterPer100g ? food.waterPer100g * factor : null,
  };
}

/**
 * Aggregate multiple NutritionResults into daily totals.
 */
export function aggregateDailyTotals(date: string, results: NutritionResult[]): DailyTotals {
  const totals: DailyTotals = {
    date,
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    waterMl: 0,
  };

  for (const r of results) {
    totals.calories += r.calories;
    totals.proteinG += r.proteinG;
    totals.carbsG += r.carbsG;
    totals.fatG += r.fatG;
    if (r.waterMl !== null) {
      totals.waterMl += r.waterMl;
    }
  }

  return totals;
}

/**
 * Calculate macro percentages relative to goal targets.
 */
export function calculateProgress(totals: DailyTotals, goals: GoalTargets): MacroProgress {
  return {
    caloriesPercent: goals.caloriesTarget ? (totals.calories / goals.caloriesTarget) * 100 : 0,
    proteinPercent: goals.proteinTarget ? (totals.proteinG / goals.proteinTarget) * 100 : 0,
    carbsPercent: goals.carbsTarget ? (totals.carbsG / goals.carbsTarget) * 100 : 0,
    fatPercent: goals.fatTarget ? (totals.fatG / goals.fatTarget) * 100 : 0,
    waterPercent: goals.waterTarget ? (totals.waterMl / goals.waterTarget) * 100 : 0,
  };
}

/**
 * Determine delta direction for each macro.
 * under: < 85% of target
 * on_target: 85-115% of target  
 * over: > 115% of target
 * For protein: under < 90%, on_target >= 90%
 * For water: under < 80%, on_target >= 80%
 */
export function calculateDelta(totals: DailyTotals, goals: GoalTargets): DailyDelta {
  const progress = calculateProgress(totals, goals);

  const getDelta = (percent: number, underThreshold: number, overThreshold: number | null): DeltaDirection => {
    if (percent < underThreshold) return 'under';
    if (overThreshold !== null && percent > overThreshold) return 'over';
    return 'on_target';
  };

  return {
    calories: getDelta(progress.caloriesPercent, 85, 115),
    protein: getDelta(progress.proteinPercent, 90, null),
    carbs: getDelta(progress.carbsPercent, 85, 115),
    fat: getDelta(progress.fatPercent, 85, 115),
    water: getDelta(progress.waterPercent, 80, null),
  };
}
