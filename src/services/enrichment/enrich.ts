/**
 * E2 merge-back: upgrade one estimated row with measured online values.
 *
 * Shape of every merge (no exceptions):
 * - the row must STILL be ai_estimate when re-read (race-safe: user edits,
 *   confirms, or earlier enrichments win over a stale trigger);
 * - values pass plausibility clamps (0–900 kcal, finite non-negative
 *   macros) + Atwater coherence (reported kcal within 50% of 4P+4C+9F —
 *   tolerant: fiber/alcohol legitimately widen the gap);
 * - the SAME row id is updated (logs, pins, clusters, exports follow with
 *   zero relationship surgery): nutrients + source_type='online_match' +
 *   source_reference=OFF code + confidence 0.85 (measured-source band —
 *   the label-OCR convention: below hand-verified 1.0, above estimates).
 * A rejected payload leaves the estimate untouched (badge stays honest).
 */
import type { FoodRepository } from '@data/repositories/food.repo';
import type { Food } from '@data/types';
import type { OnlineSearchHit } from './off-search';

export const ENRICHED_CONFIDENCE = 0.85;
export const MAX_SANE_KCAL = 900;
export const ATWATER_TOLERANCE = 0.5;

export interface EnrichedValues {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Validate + normalize a hit into storable values, or null (keep estimate). */
export function sanitizeOnlineHit(hit: OnlineSearchHit): EnrichedValues | null {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const protein = num(hit.proteinPer100g);
  const carbs = num(hit.carbsPer100g);
  const fat = num(hit.fatPer100g);
  if (protein === null || carbs === null || fat === null) return null;
  let calories = num(hit.caloriesPer100g);
  // Missing/insane kcal derives from macros (documented, Atwater) rather
  // than failing the whole merge — macros are the measured part.
  if (calories === null || calories <= 0 || calories > MAX_SANE_KCAL) {
    calories = 4 * protein + 4 * carbs + 9 * fat;
    if (!(calories > 0) || calories > MAX_SANE_KCAL) return null;
  }
  const atwater = 4 * protein + 4 * carbs + 9 * fat;
  if (Math.abs(atwater - calories) / Math.max(calories, 1) > ATWATER_TOLERANCE) return null;
  return {
    calories: Math.round(calories * 10) / 10,
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
  };
}

export async function enrichFood(
  foodRepo: Pick<FoodRepository, 'findById' | 'update'>,
  foodId: string,
  hit: OnlineSearchHit,
): Promise<Food | null> {
  const current = await foodRepo.findById(foodId);
  if (!current || current.source_type !== 'ai_estimate') return null;
  const values = sanitizeOnlineHit(hit);
  if (!values) return null;
  return (await foodRepo.update(foodId, {
    calories_per_100g: values.calories,
    protein_per_100g: values.protein,
    carbs_per_100g: values.carbs,
    fat_per_100g: values.fat,
    source_type: 'online_match',
    source_reference: hit.code,
    confidence: ENRICHED_CONFIDENCE,
  } as any)) ?? null;
}
