import { DailyTotals, GoalTargets, HydrationBreakdown, ScoreResult, ScoreComponents } from './types';

/**
 * Calculate daily consistency score.
 * 
 * Algorithm (preserved from legacy):
 * - Calories: if 85% <= actual/target <= 115% → +1; if > 115% → -1
 * - Protein: if actual >= 90% of target → +1
 * - Carbs: if 85% <= actual/target <= 115% → +1; if > 115% → -1
 * - Fat: if 85% <= actual/target <= 115% → +1; if > 115% → -1
 * - Hydration: if water >= 80% of target → +1
 * 
 * Total score clamped to [-3, +5]
 * 
 * Score tiers:
 *   +5: 'perfect' (all targets met precisely)
 *   +4: 'excellent'
 *   +3: 'great'
 *   +2: 'good'
 *   +1: 'fair'
 *    0: 'neutral'
 *   -1: 'below'
 *   -2: 'poor'
 *   -3: 'critical'
 */
export function calculateScore(totals: DailyTotals, goals: GoalTargets, hydration: HydrationBreakdown): ScoreResult {
  const components: ScoreComponents = {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    hydration: 0
  };

  const calPct = goals.caloriesTarget ? totals.calories / goals.caloriesTarget : 0;
  if (calPct >= 0.85 && calPct <= 1.15) components.calories = 1;
  else if (calPct > 1.15) components.calories = -1;

  const proPct = goals.proteinTarget ? totals.proteinG / goals.proteinTarget : 0;
  if (proPct >= 0.90) components.protein = 1;

  const carbPct = goals.carbsTarget ? totals.carbsG / goals.carbsTarget : 0;
  if (carbPct >= 0.85 && carbPct <= 1.15) components.carbs = 1;
  else if (carbPct > 1.15) components.carbs = -1;

  const fatPct = goals.fatTarget ? totals.fatG / goals.fatTarget : 0;
  if (fatPct >= 0.85 && fatPct <= 1.15) components.fat = 1;
  else if (fatPct > 1.15) components.fat = -1;

  const waterPct = hydration.target ? hydration.effectiveTotal / hydration.target : 0;
  if (waterPct >= 0.80) components.hydration = 1;

  let rawScore = components.calories + components.protein + components.carbs + components.fat + components.hydration;
  
  if (rawScore > 5) rawScore = 5;
  if (rawScore < -3) rawScore = -3;

  const scoreSign = rawScore > 0 ? '+' : '';
  const scoreCode = `${scoreSign}${rawScore}`;

  return {
    score: rawScore,
    scoreTier: getScoreTier(rawScore),
    scoreCode,
    result: `Scored ${scoreCode}`,
    reason: `Calculated from macro and hydration targets.`,
    components
  };
}

/**
 * Get the score tier label.
 */
export function getScoreTier(score: number): string {
  switch (score) {
    case 5: return 'perfect';
    case 4: return 'excellent';
    case 3: return 'great';
    case 2: return 'good';
    case 1: return 'fair';
    case 0: return 'neutral';
    case -1: return 'below';
    case -2: return 'poor';
    case -3: return 'critical';
    default: return 'neutral';
  }
}

/**
 * Get the CSS color class name for a score value.
 * Maps score to --score-pos-5 through --score-neg-3
 */
export function getScoreColorClass(score: number): string {
  if (score > 0) return `--score-pos-${score}`;
  if (score < 0) return `--score-neg-${Math.abs(score)}`;
  return '--score-0';
}
