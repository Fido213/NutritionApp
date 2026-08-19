export interface FoodReference {
  id: string;
  canonicalName: string;
  caloriesPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  waterPer100g: number | null;
  nutritionBasis: 'per_100g' | 'per_100ml' | 'per_serving';
  confidence: number | null;
  sourceType: 'ai_estimate' | 'barcode' | 'nutrition_label' | 'user_entered' | 'imported';
}

export interface NutritionResult {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  waterMl: number | null;
}

export interface DailyTotals {
  date: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  waterMl: number;
}

export interface GoalTargets {
  caloriesTarget: number;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
  waterTarget: number;
}

export interface HydrationBreakdown {
  explicit: number;  // ml from direct water entry
  drink: number;     // ml from beverages
  food: number;      // ml from food water content
  effectiveTotal: number;  // after gating rules
  target: number;
}

export interface ScoreResult {
  score: number;       // -3 to +5
  scoreTier: string;   // legacy CSS class: 'score-pos-5' … 'score-0' … 'score-neg-3'
  scoreCode: string;   // e.g. '+5', '+3', '0', '-2'
  result: string;      // Human-readable result
  reason: string;      // Detailed breakdown
  components: ScoreComponents;
}

export interface ScoreComponents {
  calories: number;    // -1, 0, or +1
  protein: number;
  carbs: number;
  fat: number;
  hydration: number;
}

export interface MacroProgress {
  caloriesPercent: number;
  proteinPercent: number;
  carbsPercent: number;
  fatPercent: number;
  waterPercent: number;
}

export type DeltaDirection = 'under' | 'on_target' | 'over';

export interface DailyDelta {
  calories: DeltaDirection;
  protein: DeltaDirection;
  carbs: DeltaDirection;
  fat: DeltaDirection;
  water: DeltaDirection;
}
