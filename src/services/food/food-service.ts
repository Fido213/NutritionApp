import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { ObservationRepository } from '@data/repositories/observation.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { InsertFood } from '@data/types';
import { FoodObservation, FoodLog } from '@data/types';
import { FoodReference, NutritionResult } from '@domain/types';
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName } from '@domain/logging';
import { classifyWaterSource } from '@domain/hydration';
import { InterpretedFoodItem } from '@services/ai/prompts';

/**
 * Deterministic per-100g estimate used when an unknown food is resolved
 * and no nutritional reference data is available. Matches the default
 * estimate used by the legacy Supabase migration service.
 */
export const DEFAULT_NUTRIENT_ESTIMATE: Partial<InsertFood> = {
  calories_per_100g: 200,
  protein_per_100g: 10,
  carbs_per_100g: 25,
  fat_per_100g: 5,
  water_per_100g: 0
};

export interface ResolvedFoodEntry {
  item: InterpretedFoodItem;
  food: FoodReference;
}

export interface LoggedTextEntry {
  item: InterpretedFoodItem;
  food: FoodReference;
  observation: FoodObservation;
  log: FoodLog;
  nutrition: NutritionResult;
}

/**
 * Orchestrates the food-resolution and logging pipeline:
 * interpreted item -> food reference (library lookup or new AI-source entry) -> observation -> food log.
 */
export class FoodService {
  constructor(
    private foodRepo: FoodRepository,
    private logRepo: LogRepository,
    private observationRepo: ObservationRepository,
    private waterRepo: WaterRepository
  ) {}

  /**
   * Resolve an interpreted food item to a FoodReference.
   * Resolution order: exact canonical name -> legacy stripped form -> exact alias -> upsert new library entry.
   */
  async resolveFood(item: InterpretedFoodItem, nutrients: Partial<InsertFood> = DEFAULT_NUTRIENT_ESTIMATE): Promise<FoodReference> {
    const name = item.canonicalName?.trim();
    if (!name) throw new Error('Interpreted food item is missing a name');

    const normalized = normalizeFoodName(name);
    const stripped = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const found = await this.foodRepo.findByNormalizedName(normalized)
      ?? await this.foodRepo.findByNormalizedName(stripped)
      ?? await this.foodRepo.findByAlias(normalized);

    if (found) return this.foodRepo.toFoodReference(found);

    const created = await this.foodRepo.upsertFromAI(name, nutrients, item.confidence);
    return this.foodRepo.toFoodReference(created);
  }

  async resolveInterpretedFoods(items: InterpretedFoodItem[]): Promise<ResolvedFoodEntry[]> {
    const entries: ResolvedFoodEntry[] = [];
    for (const item of items) {
      const food = await this.resolveFood(item);
      entries.push({ item, food });
    }
    return entries;
  }

  /**
   * Log a single interpreted food item for a date:
   * resolve the food, record the observation, calculate nutrition deterministically,
   * insert the food log, and store any food-derived water separately.
   */
  async logTextEntry(date: string, rawInput: string, item: InterpretedFoodItem): Promise<LoggedTextEntry> {
    const food = await this.resolveFood(item);
    const amountG = item.amountG ?? null;
    const amountMl = item.amountMl ?? null;
    const effectiveAmount = item.amountG ?? item.amountMl ?? 100;
    const amountUnit = amountMl !== null ? 'ml' : 'g';

    const observation = await this.observationRepo.insert({
      food_id: food.id,
      source_type: 'text',
      estimated_amount: effectiveAmount,
      final_amount: effectiveAmount,
      amount_unit: amountUnit,
      confidence: item.confidence,
      raw_input: rawInput,
      interpretation_json: JSON.stringify(item),
      user_corrected: 0
    });

    const nutrition = calculateNutrition(food, effectiveAmount);

    const log = await this.logRepo.insertFoodLog({
      date,
      food_id: food.id,
      observation_id: observation.id,
      amount_g: amountG,
      amount_ml: amountMl,
      calories: nutrition.calories,
      protein_g: nutrition.proteinG,
      carbs_g: nutrition.carbsG,
      fat_g: nutrition.fatG,
      water_ml: nutrition.waterMl
    });

    if (nutrition.waterMl !== null && nutrition.waterMl > 0) {
      await this.waterRepo.insertWaterLog({
        date,
        amount_ml: nutrition.waterMl,
        source: classifyWaterSource(food),
        food_log_id: log.id
      });
    }

    return { item, food, observation, log, nutrition };
  }

  async logTextInput(date: string, rawInput: string, items: InterpretedFoodItem[]): Promise<LoggedTextEntry[]> {
    const results: LoggedTextEntry[] = [];
    for (const item of items) {
      results.push(await this.logTextEntry(date, rawInput, item));
    }
    return results;
  }
}