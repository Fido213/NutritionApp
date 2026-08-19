import { DailyTotals, GoalTargets, HydrationBreakdown, ScoreResult, ScoreComponents } from './types';

/**
 * Calculate daily consistency score.
 *
 * Numeric algorithm (preserved from legacy, old_app/app.js):
 * - Calories: if 85% <= actual/target <= 115% → +1; if > 115% → -1
 * - Protein: if actual >= 90% of target → +1
 * - Carbs: if 85% <= actual/target <= 115% → +1; if > 115% → -1
 * - Fat: if 85% <= actual/target <= 115% → +1; if > 115% → -1
 * - Hydration: if water >= 80% of target → +1
 *
 * Total score clamped to [-3, +5].
 *
 * The output contract reproduces the legacy app (old_app/app.js
 * exportDataToCSV): `result` is the visual state ('Green'/'Grey'/'Red'),
 * `scoreTier` is the legacy CSS class ('score-pos-5' … 'score-0' …
 * 'score-neg-3'), and `reason` follows the legacy templated sentences.
 * Verified against the supplied legacy export (exportexample.csv) by
 * scoring-regression.test.ts.
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

  const { result, scoreTier, reason } = buildLegacyScoreText(rawScore, components);

  return {
    score: rawScore,
    scoreTier,
    scoreCode,
    result,
    reason,
    components
  };
}

/**
 * Reproduce the legacy score output contract from old_app/app.js
 * (exportDataToCSV): visual state, score tier (legacy CSS class names)
 * and the templated reason sentences, byte-for-byte.
 */
function buildLegacyScoreText(score: number, components: ScoreComponents): { result: string; scoreTier: string; reason: string } {
  const positives: string[] = [];
  const negatives: string[] = [];

  if (components.calories === 1) positives.push('calories on target');
  else if (components.calories === -1) negatives.push('calories higher than goal');
  else negatives.push('calories lower than goal');

  if (components.protein === 1) positives.push('protein goal met');
  else negatives.push('low protein');

  if (components.carbs === 1) positives.push('carbs on target');
  else if (components.carbs === -1) negatives.push('carbs higher than goal');
  else negatives.push('carbs lower than goal');

  if (components.fat === 1) positives.push('fats on target');
  else if (components.fat === -1) negatives.push('fats higher than goal');
  else negatives.push('fats lower than goal');

  if (components.hydration === 1) positives.push('hydration goal met');
  else negatives.push('low hydration');

  const posText = positives.length > 0 ? positives.join(', ') : 'nothing';
  const negText = negatives.length > 0 ? negatives.join(', ') : 'nothing';

  if (score === 5) {
    return { result: 'Green', scoreTier: 'score-pos-5', reason: `Flawless day. Nailed everything: ${posText}.` };
  }
  if (score >= 3 && score <= 4) {
    return { result: 'Green', scoreTier: `score-pos-${score}`, reason: `Great day. Hit ${posText}, but had issues with ${negText}.` };
  }
  if (score >= 1 && score <= 2) {
    return { result: 'Green', scoreTier: `score-pos-${score}`, reason: `Good outweighed the bad. Managed ${posText}, but had issues with ${negText}.` };
  }
  if (score === 0) {
    if (positives.length === 0) {
      return { result: 'Grey', scoreTier: 'score-0', reason: `Off target across the board (${negText}).` };
    }
    return { result: 'Grey', scoreTier: 'score-0', reason: `Even split. Achieved ${posText}, but offset by ${negText}.` };
  }
  if (score === -1) {
    return { result: 'Red', scoreTier: 'score-neg-1', reason: `Slightly off. Struggled with ${negText}, only managing ${posText}.` };
  }

  const baseReason = `Rough day. Issues with ${negText}.`;
  const reason = positives.length > 0 ? `${baseReason} The only hit was ${posText}.` : baseReason;
  return { result: 'Red', scoreTier: `score-neg-${Math.abs(score)}`, reason };
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
