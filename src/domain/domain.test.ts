import { calculateNutrition } from './nutrition';
import { calculateEffectiveHydration } from './hydration';
import { resolveGoalForDate, GoalRecord } from './goals';
import { calculateScore } from './scoring';
import { normalizeFoodName } from './logging';
import { FoodReference } from './types';

export function runDomainUnitTests() {
  console.log('--- Running Domain Logic Unit Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failed++;
    }
  }

  // 1. Nutrition calculation test
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

  const nutResult = calculateNutrition(sampleFood, 250);
  assert(nutResult.calories === 412.5, '250g Chicken calories == 412.5');
  assert(nutResult.proteinG === 77.5, '250g Chicken protein == 77.5g');
  assert(nutResult.carbsG === 0, '250g Chicken carbs == 0g');

  // 2. Hydration gating test (Explicit < Target)
  const hydrationUnder = calculateEffectiveHydration(1500, 500, 200, 2000);
  assert(hydrationUnder.effectiveTotal === 1500, 'Effective hydration explicit-only when < target');

  // 3. Hydration gating test (Explicit >= Target)
  const hydrationOver = calculateEffectiveHydration(2000, 500, 200, 2000);
  assert(hydrationOver.effectiveTotal === 2700, 'Effective hydration includes drink+food when explicit >= target');

  // 4. Scoring engine test
  const scoreRes = calculateScore(
    { date: '2026-08-18', calories: 2000, proteinG: 150, carbsG: 200, fatG: 60, waterMl: 2500 },
    { caloriesTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 60, waterTarget: 2500 },
    { explicit: 2500, drink: 0, food: 0, effectiveTotal: 2500, target: 2500 }
  );
  assert(scoreRes.score === 5, 'Perfect targets result in score +5');
  assert(scoreRes.scoreTier === 'perfect', 'Score tier is perfect');

  // 5. Goal resolution test
  const goals: GoalRecord[] = [
    { id: 'g1', name: 'Cut', startDate: '2026-01-01', endDate: '2026-06-30', caloriesTarget: 1800, proteinTarget: 160, carbsTarget: 150, fatTarget: 50, waterTarget: 3000 },
    { id: 'g2', name: 'Maintenance', startDate: '2026-07-01', endDate: null, caloriesTarget: 2200, proteinTarget: 150, carbsTarget: 220, fatTarget: 65, waterTarget: 3000 }
  ];

  const historicalGoal = resolveGoalForDate('2026-03-15', goals);
  assert(historicalGoal?.caloriesTarget === 1800, 'Historical goal on 2026-03-15 correctly resolves to Cut goal (1800 kcal)');

  const currentGoal = resolveGoalForDate('2026-08-18', goals);
  assert(currentGoal?.caloriesTarget === 2200, 'Current goal on 2026-08-18 resolves to Maintenance (2200 kcal)');

  // 6. Food name normalization
  assert(normalizeFoodName('  CHICKEN   breast! ') === 'chicken breast', 'Normalizes food name whitespace and casing');

  console.log(`--- Unit Tests Completed: ${passed} passed, ${failed} failed ---`);
  return { passed, failed };
}
