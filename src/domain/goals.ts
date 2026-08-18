import { GoalTargets } from './types';

export interface GoalRecord {
  id: string;
  name: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string | null;  // null = current active goal
  caloriesTarget: number;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
  waterTarget: number;
}

/**
 * Find the goal that was active on a specific date.
 * Rules:
 * - Goal is active from startDate to endDate (inclusive)
 * - Current goal has endDate = null (active from startDate onward)
 * - Historical days use the goal that was active ON THAT DATE
 * - Never retroactively relabel historical days with today's goal
 */
export function resolveGoalForDate(date: string, goals: GoalRecord[]): GoalTargets | null {
  for (const goal of goals) {
    if (date >= goal.startDate && (goal.endDate === null || date <= goal.endDate)) {
      return {
        caloriesTarget: goal.caloriesTarget,
        proteinTarget: goal.proteinTarget,
        carbsTarget: goal.carbsTarget,
        fatTarget: goal.fatTarget,
        waterTarget: goal.waterTarget,
      };
    }
  }
  return null;
}

/**
 * Get default goal targets when no goals exist.
 */
export function getDefaultGoalTargets(): GoalTargets {
  return {
    caloriesTarget: 2000,
    proteinTarget: 150,
    carbsTarget: 250,
    fatTarget: 65,
    waterTarget: 2500,
  };
}

/**
 * Validate that a new goal doesn't overlap with existing goals.
 */
export function validateGoalNoOverlap(
  newStartDate: string,
  newEndDate: string | null,
  existingGoals: GoalRecord[]
): { valid: boolean; error?: string } {
  for (const goal of existingGoals) {
    const overlapStart = newStartDate <= (goal.endDate || '9999-12-31');
    const overlapEnd = (newEndDate || '9999-12-31') >= goal.startDate;

    if (overlapStart && overlapEnd) {
      return { valid: false, error: 'Goal dates overlap with an existing goal.' };
    }
  }
  return { valid: true };
}

/**
 * Calculate the end_date to set on the previous current goal
 * when creating a new goal. Returns the day before newStartDate.
 */
export function calculatePreviousGoalEndDate(newStartDate: string): string {
  const date = new Date(`${newStartDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().split('T')[0];
}
