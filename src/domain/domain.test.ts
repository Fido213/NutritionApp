import { describe, it, expect } from 'vitest';
import { calculateNutrition, calculateDelta } from './nutrition';
import { calculateEffectiveHydration, classifyWaterSource } from './hydration';
import { resolveGoalForDate, GoalRecord } from './goals';
import { calculateScore } from './scoring';
import { expandCombo, applyCorrection, normalizeFoodName } from './logging';
import { safeJsonParse } from '../utils/sanitize';
import { FoodReference } from './types';

const sampleFood: FoodReference = {
  id: 'food_1',
  canonicalName: 'Chicken Breast',
  caloriesPer100g: 165,
  proteinPer100g: 31,
  carbsPer100g: 0,
  fatPer100g: 3.6,
  waterPer100g: 65,
  nutritionBasis: 'per_100g',
  confidence: 1.0,
  sourceType: 'user_entered'
};

describe('calculateNutrition', () => {
  it('scales per-100g reference by the actual amount', () => {
    const result = calculateNutrition(sampleFood, 250);
    expect(result.calories).toBe(412.5);
    expect(result.proteinG).toBe(77.5);
    expect(result.carbsG).toBe(0);
    expect(result.fatG).toBe(9);
    expect(result.waterMl).toBe(162.5);
  });

  it('returns zeros for null reference values', () => {
    const result = calculateNutrition(
      { ...sampleFood, caloriesPer100g: null, proteinPer100g: null },
      100
    );
    expect(result.calories).toBe(0);
    expect(result.proteinG).toBe(0);
  });
});

describe('calculateEffectiveHydration', () => {
  it('counts only explicit water when explicit is below target', () => {
    const result = calculateEffectiveHydration(1500, 500, 200, 2000);
    expect(result.effectiveTotal).toBe(1500);
  });

  it('adds drink and food water once explicit reaches the target', () => {
    const result = calculateEffectiveHydration(2000, 500, 200, 2000);
    expect(result.effectiveTotal).toBe(2700);
  });

  it('keeps the source breakdown separate', () => {
    const result = calculateEffectiveHydration(1000, 300, 100, 2500);
    expect(result.explicit).toBe(1000);
    expect(result.drink).toBe(300);
    expect(result.food).toBe(100);
    expect(result.target).toBe(2500);
  });
});

describe('classifyWaterSource', () => {
  it('classifies plain water as explicit', () => {
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'water' })).toBe('explicit');
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'Tap Water' })).toBe('explicit');
  });

  it('classifies beverages as drink', () => {
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'black coffee' })).toBe('drink');
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'Orange Juice' })).toBe('drink');
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'Milk' })).toBe('drink');
  });

  it('classifies solid foods as food', () => {
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'chicken breast' })).toBe('food');
    expect(classifyWaterSource({ ...sampleFood, canonicalName: 'watermelon' })).toBe('food');
  });

  it('classifies entries without a food reference as explicit', () => {
    expect(classifyWaterSource(null)).toBe('explicit');
  });
});

describe('resolveGoalForDate', () => {
  const goals: GoalRecord[] = [
    { id: 'g1', name: 'Cut', startDate: '2026-01-01', endDate: '2026-06-30', caloriesTarget: 1800, proteinTarget: 160, carbsTarget: 150, fatTarget: 50, waterTarget: 3000 },
    { id: 'g2', name: 'Maintenance', startDate: '2026-07-01', endDate: null, caloriesTarget: 2200, proteinTarget: 150, carbsTarget: 220, fatTarget: 65, waterTarget: 3000 }
  ];

  it('resolves a historical date to the goal active on that date', () => {
    expect(resolveGoalForDate('2026-03-15', goals)?.caloriesTarget).toBe(1800);
  });

  it('resolves the current date to the open-ended goal', () => {
    expect(resolveGoalForDate('2026-08-18', goals)?.caloriesTarget).toBe(2200);
  });

  it('includes both start_date and end_date boundaries', () => {
    expect(resolveGoalForDate('2026-01-01', goals)?.caloriesTarget).toBe(1800);
    expect(resolveGoalForDate('2026-06-30', goals)?.caloriesTarget).toBe(1800);
    expect(resolveGoalForDate('2026-07-01', goals)?.caloriesTarget).toBe(2200);
  });

  it('returns null when no goal covers the date', () => {
    expect(resolveGoalForDate('2025-12-31', goals)).toBeNull();
  });

  it('returns null for empty goal history', () => {
    expect(resolveGoalForDate('2026-08-18', [])).toBeNull();
  });

  it('does not retroactively relabel a historical day with a later goal', () => {
    const result = resolveGoalForDate('2026-06-30', goals);
    expect(result?.caloriesTarget).toBe(1800);
  });
});

describe('calculateScore', () => {
  const totals = { date: '2026-08-18', calories: 2000, proteinG: 150, carbsG: 200, fatG: 60, waterMl: 2500 };
  const goals = { caloriesTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 60, waterTarget: 2500 };
  const hydration = { explicit: 2500, drink: 0, food: 0, effectiveTotal: 2500, target: 2500 };

  it('scores +5 perfect when every target is met', () => {
    const result = calculateScore(totals, goals, hydration);
    expect(result.score).toBe(5);
    expect(result.scoreTier).toBe('score-pos-5');
    expect(result.scoreCode).toBe('+5');
    expect(result.result).toBe('Green');
    expect(result.reason).toBe(
      'Flawless day. Nailed everything: calories on target, protein goal met, carbs on target, fats on target, hydration goal met.'
    );
  });

  it('scores -1 for calories above 115% of target', () => {
    const result = calculateScore(
      { ...totals, calories: 3000 },
      goals,
      { ...hydration, effectiveTotal: 0 }
    );
    expect(result.components.calories).toBe(-1);
  });

  it('scores 0 for calories within range but below other thresholds', () => {
    const result = calculateScore(
      { ...totals, calories: 2000, proteinG: 0, carbsG: 0, fatG: 0 },
      goals,
      { ...hydration, effectiveTotal: 0 }
    );
    expect(result.components.calories).toBe(1);
    expect(result.components.protein).toBe(0);
    expect(result.score).toBe(1);
    expect(result.scoreTier).toBe('score-pos-1');
    expect(result.result).toBe('Green');
    expect(result.reason).toBe(
      'Good outweighed the bad. Managed calories on target, but had issues with low protein, carbs lower than goal, fats lower than goal, low hydration.'
    );
  });

  it('gives hydration +1 only at 80% of target or above', () => {
    const below = calculateScore(totals, goals, { ...hydration, effectiveTotal: 1999 });
    expect(below.components.hydration).toBe(0);
    const at = calculateScore(totals, goals, { ...hydration, effectiveTotal: 2000 });
    expect(at.components.hydration).toBe(1);
  });
});

describe('expandCombo', () => {
  it('expands combo items into independent food log entries', () => {
    const combo = {
      id: 'combo_1',
      name: 'Midnight Oats',
      items: [
        { foodId: 'f1', food: sampleFood, amountG: 50, amountMl: null },
        { foodId: 'f2', food: { ...sampleFood, id: 'f2', canonicalName: 'Chia Seeds' }, amountG: 20, amountMl: null }
      ]
    };

    const entries = expandCombo(combo, '2026-08-19');
    expect(entries).toHaveLength(2);
    expect(entries[0].foodId).toBe('f1');
    expect(entries[0].amountG).toBe(50);
    expect(entries[1].foodId).toBe('f2');
  });
});

describe('applyCorrection', () => {
  it('recalculates nutrition from the user-corrected amount', () => {
    const result = applyCorrection(sampleFood, 185, 210);
    expect(result.finalAmount).toBe(210);
    expect(result.nutrition.calories).toBe(346.5);
  });
});

describe('calculateDelta', () => {
  const goals = { caloriesTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 60, waterTarget: 2500 };

  it('marks calories under at <85%, on target at 85-115%, over above 115%', () => {
    const under = calculateDelta({ date: '', calories: 1500, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 }, goals);
    expect(under.calories).toBe('under');

    const onTarget = calculateDelta({ date: '', calories: 2000, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 }, goals);
    expect(onTarget.calories).toBe('on_target');

    const over = calculateDelta({ date: '', calories: 2500, proteinG: 0, carbsG: 0, fatG: 0, waterMl: 0 }, goals);
    expect(over.calories).toBe('over');
  });

  it('never marks protein or water as over', () => {
    const result = calculateDelta({ date: '', calories: 0, proteinG: 200, carbsG: 0, fatG: 0, waterMl: 4000 }, goals);
    expect(result.protein).toBe('on_target');
    expect(result.water).toBe('on_target');
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a": 1}', {})).toEqual({ a: 1 });
  });

  it('returns the fallback for malformed JSON', () => {
    expect(safeJsonParse('{not json', [])).toEqual([]);
  });

  it('strips markdown code fences before parsing', () => {
    expect(safeJsonParse('```json\n{"a": 2}\n```', {})).toEqual({ a: 2 });
  });

  it('returns the fallback for empty input', () => {
    expect(safeJsonParse('', 'fallback')).toBe('fallback');
  });
});

describe('normalizeFoodName', () => {
  it('normalizes casing, whitespace and punctuation', () => {
    expect(normalizeFoodName('  CHICKEN   breast! ')).toBe('chicken breast');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeFoodName('rice     and     beans')).toBe('rice and beans');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeFoodName('')).toBe('');
    expect(normalizeFoodName('   ')).toBe('');
  });
});