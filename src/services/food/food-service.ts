import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { ObservationRepository } from '@data/repositories/observation.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { InsertFood } from '@data/types';
import { Food, FoodObservation, FoodLog } from '@data/types';
import { FoodReference, NutritionResult } from '@domain/types';
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName } from '@domain/logging';
import { classifyWaterSource } from '@domain/hydration';
import { InterpretedFoodItem, InterpretedLabelOCR } from '@services/ai/prompts';
import { OnlineBarcodeProduct } from '@services/barcode/online-lookup';

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

export interface LoggedLabelEntry {
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

  /**
   * Log a scanned/pasted nutrition label for a date:
   * resolve the food (library lookup or new nutrition_label entry), record the observation,
   * calculate nutrition deterministically from the per-100g label values, insert the food log,
   * and store any food-derived water separately.
   */
  async logLabelOcr(date: string, ocr: InterpretedLabelOCR, amountG: number = 100): Promise<LoggedLabelEntry> {
    const name = ocr.foodName?.trim();
    if (!name) throw new Error('Label OCR result is missing a food name');
    if (!(amountG > 0)) throw new Error('Label log amount must be positive');

    const normalized = normalizeFoodName(name);
    const stripped = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const found = await this.foodRepo.findByNormalizedName(normalized)
      ?? await this.foodRepo.findByNormalizedName(stripped)
      ?? await this.foodRepo.findByAlias(normalized);

    let food: Food;
    if (found) {
      food = found;
    } else {
      food = await this.foodRepo.insert({
        canonical_name: name,
        normalized_name: normalized,
        calories_per_100g: ocr.caloriesPer100g ?? null,
        protein_per_100g: ocr.proteinPer100g ?? null,
        carbs_per_100g: ocr.carbsPer100g ?? null,
        fat_per_100g: ocr.fatPer100g ?? null,
        water_per_100g: ocr.waterPer100g ?? null,
        nutrition_basis: 'per_100g',
        source_type: 'nutrition_label',
        confidence: ocr.confidence ?? 0.85
      });
    }

    const ref = this.foodRepo.toFoodReference(food);

    const observation = await this.observationRepo.insert({
      food_id: food.id,
      source_type: 'label_ocr',
      estimated_amount: amountG,
      final_amount: amountG,
      amount_unit: 'g',
      confidence: ocr.confidence ?? null,
      raw_input: ocr.rawText,
      interpretation_json: JSON.stringify(ocr),
      user_corrected: 0
    });

    const nutrition = calculateNutrition(ref, amountG);

    const log = await this.logRepo.insertFoodLog({
      date,
      food_id: food.id,
      observation_id: observation.id,
      amount_g: amountG,
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
        source: classifyWaterSource(ref),
        food_log_id: log.id
      });
    }

    return { food: ref, observation, log, nutrition };
  }

  /**
   * Log an online barcode lookup result for a date (spec §7.4):
   * resolve the food (library reuse or new barcode-source entry), record the
   * observation, calculate nutrition at the given amount, insert the food log,
   * and store any food-derived water separately. The barcode-to-food mapping
   * itself is saved by the caller via BarcodeRepository.saveBarcode.
   */
  async logBarcodeLookup(
    date: string,
    product: OnlineBarcodeProduct,
    barcode: string,
    amountG: number = 100
  ): Promise<LoggedLabelEntry> {
    const name = product.productName?.trim();
    if (!name) throw new Error('Online product is missing a name');
    if (!(amountG > 0)) throw new Error('Barcode log amount must be positive');

    const normalized = normalizeFoodName(name);
    const stripped = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const found = await this.foodRepo.findByNormalizedName(normalized)
      ?? await this.foodRepo.findByNormalizedName(stripped)
      ?? await this.foodRepo.findByAlias(normalized);

    let food: Food;
    if (found) {
      food = found;
    } else {
      food = await this.foodRepo.insert({
        canonical_name: name,
        normalized_name: normalized,
        calories_per_100g: product.caloriesPer100g,
        protein_per_100g: product.proteinPer100g,
        carbs_per_100g: product.carbsPer100g,
        fat_per_100g: product.fatPer100g,
        water_per_100g: 0,
        nutrition_basis: 'per_100g',
        source_type: 'barcode',
        source_reference: barcode,
        confidence: 0.8
      });
    }

    const ref = this.foodRepo.toFoodReference(food);

    const observation = await this.observationRepo.insert({
      food_id: food.id,
      source_type: 'barcode',
      estimated_amount: amountG,
      final_amount: amountG,
      amount_unit: 'g',
      confidence: 0.8,
      raw_input: barcode,
      interpretation_json: JSON.stringify(product),
      user_corrected: 0
    });

    const nutrition = calculateNutrition(ref, amountG);

    const log = await this.logRepo.insertFoodLog({
      date,
      food_id: food.id,
      observation_id: observation.id,
      amount_g: amountG,
      amount_ml: null,
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
        source: classifyWaterSource(ref),
        food_log_id: log.id
      });
    }

    return { food: ref, observation, log, nutrition };
  }
}
