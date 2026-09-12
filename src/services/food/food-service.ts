import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { ObservationRepository } from '@data/repositories/observation.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { AliasRepository } from '@data/repositories/alias.repo';
import { InsertFood } from '@data/types';
import { Food, FoodObservation, FoodLog } from '@data/types';
import { FoodReference, NutritionResult } from '@domain/types';
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName, sliceSpanText } from '@domain/logging';
import { tokenizeBM25, splitConceptPrep } from '@services/interpreter/lexicon';
import { medianFallbackEstimate, type FallbackEstimate } from './fallback-estimate';
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
 * Recover the user's own phrase for an interpreted item from the raw input
 * and the span offsets the interpreter grounds in it (Gemma-fallback items
 * carry no span → null → normal resolution).
 */
export function extractSpanText(rawInput: string, item: InterpretedFoodItem): string | null {
  return sliceSpanText(rawInput, (item as unknown as { span?: unknown })?.span);
}

/**
 * E3: the user's own phrase behind a split group (first member span start
 * → last member span end, e.g. "Roast Beef With Gravy"). Titles the shared
 * combo-marker observation so the journal row reads the user's words.
 * Falls back to the interpreter's group key when spans are missing.
 */
export function groupPhrase(rawInput: string, members: InterpretedFoodItem[]): string {
  const fallback = members[0]?.splitGroup ?? rawInput;
  if (!rawInput) return fallback;
  let start = Infinity;
  let end = -Infinity;
  for (const m of members) {
    const span = (m as unknown as { span?: unknown })?.span;
    if (!Array.isArray(span) || span.length !== 2) continue;
    const [s, e] = span as [unknown, unknown];
    if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
    start = Math.min(start, s as number);
    end = Math.max(end, e as number);
  }
  if (!Number.isFinite(start) || end <= start || end > rawInput.length) return fallback;
  const phrase = rawInput.slice(start, end).trim();
  return phrase.length >= 2 ? phrase : fallback;
}

/**
 * Estimation v1 (P1.5): provenance graduation on hand edit. When the user
 * hand-enters per-100g nutrients for a row whose values are a flat-default
 * guess, the row stops being an estimate — returns 'user_entered' to store.
 * Every other provenance is authoritative already (label, barcode, seeded
 * reference, prior user entry) and returns null (leave untouched).
 * Pure — unit-tested; the Index library-edit save applies the result.
 */
export function graduateProvenanceOnUserEdit(sourceType: string | null | undefined): 'user_entered' | null {
  return sourceType === 'ai_estimate' ? 'user_entered' : null;
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
    private waterRepo: WaterRepository,
    private aliasRepo: AliasRepository
  ) {}

  /**
   * Pin a library food as the user's default for a phrase ("chicken" → the
   * chicken they actually mean). Moves any previous mapping for the phrase
   * so resolution stays deterministic (first-match readers).
   */
  async setUserDefault(spanText: string, foodId: string): Promise<void> {
    const phrase = spanText.trim();
    if (!phrase) throw new Error('Cannot set a default for an empty phrase');
    const normalized = normalizeFoodName(phrase);
    if (!normalized) throw new Error('Phrase has no searchable text');
    const food = await this.foodRepo.findById(foodId);
    if (!food) throw new Error('Food not found in library');
    await this.aliasRepo.deleteByNormalized(normalized);
    await this.aliasRepo.create({
      food_id: foodId,
      alias: phrase,
      normalized_alias: normalized,
      source: 'user',
      confidence: 1,
    });
  }

  /**
   * P2 head-median fallback for an unknown food name: per-nutrient medians
   * over same-concept-head library rows (>= 5 supporters), else null (the
   * caller keeps the flat default floor). Gated, workbench-only report:
   * `ai models/results/eval_fallback_report.json`.
   */
  async nutrientFallback(canonicalName: string): Promise<FallbackEstimate | null> {
    const { concept } = splitConceptPrep(tokenizeBM25(canonicalName));
    if (concept.length === 0) return null;
    const candidates = await this.foodRepo.getFoodsByToken(concept[0], 2000);
    return medianFallbackEstimate(candidates, canonicalName, normalizeFoodName(canonicalName));
  }

  /**
   * Resolve an interpreted food item to a FoodReference.
   * Resolution order: user default for the raw span phrase -> exact canonical
   * name -> legacy stripped form -> exact alias -> upsert new library entry.
   */
  async resolveFood(item: InterpretedFoodItem, nutrients: Partial<InsertFood> = DEFAULT_NUTRIENT_ESTIMATE, spanText: string | null = null): Promise<FoodReference> {
    if (spanText) {
      const spanNorm = normalizeFoodName(spanText);
      if (spanNorm) {
        const pinned = await this.foodRepo.findByAlias(spanNorm);
        if (pinned) return this.foodRepo.toFoodReference(pinned);
      }
    }
    const name = item.canonicalName?.trim();
    if (!name) throw new Error('Interpreted food item is missing a name');

    const normalized = normalizeFoodName(name);
    const stripped = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const found = await this.foodRepo.findByNormalizedName(normalized)
      ?? await this.foodRepo.findByNormalizedName(stripped)
      ?? await this.foodRepo.findByAlias(normalized);

    if (found) return this.foodRepo.toFoodReference(found);

    // Unknown food, no caller-supplied reference: head-median fallback when
    // the library holds >= 5 same-head supporters, else the flat default
    // floor (unchanged values). Support-capped confidence can only lower the
    // stored confidence, never raise it. Explicit caller nutrients bypass.
    let effectiveNutrients = nutrients;
    let confidence = item.confidence;
    if (nutrients === DEFAULT_NUTRIENT_ESTIMATE) {
      try {
        const fb = await this.nutrientFallback(name);
        if (fb) {
          effectiveNutrients = {
            calories_per_100g: fb.nutrients.kcal,
            protein_per_100g: fb.nutrients.protein,
            carbs_per_100g: fb.nutrients.carbs,
            fat_per_100g: fb.nutrients.fat,
            water_per_100g: 0,
          };
          confidence = Math.min(confidence, fb.confidence);
        }
      } catch { /* fallback is best-effort; the flat floor below still logs */ }
    }

    const created = await this.foodRepo.upsertFromAI(name, effectiveNutrients, confidence);
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
   *
   * E3: pass a combo-marker observation id to log under a shared marker
   * (split group members render as ONE collapsible journal row); otherwise
   * a per-item observation is recorded exactly as before. A missing marker
   * id falls back to a per-item observation (never breaks the log).
   */
  async logTextEntry(date: string, rawInput: string, item: InterpretedFoodItem, markerId: string | null = null): Promise<LoggedTextEntry> {
    const food = await this.resolveFood(item, DEFAULT_NUTRIENT_ESTIMATE, extractSpanText(rawInput, item));
    let observation = markerId ? await this.observationRepo.findById(markerId) : null;
    if (!observation) {
      observation = await this.observationRepo.insert({
        food_id: food.id,
        source_type: 'text',
        estimated_amount: item.amountG ?? item.amountMl ?? 100,
        final_amount: item.amountG ?? item.amountMl ?? 100,
        amount_unit: item.amountMl !== null ? 'ml' : 'g',
        confidence: item.confidence,
        raw_input: rawInput,
        interpretation_json: JSON.stringify(item),
        user_corrected: 0
      });
    }
    return this.insertEntryLogs(date, food, item, observation);
  }

  /**
   * Shared tail of every text-log insert: deterministic nutrition,
   * food log row, and food-derived water split. Pure orchestration over
   * an already-resolved food + observation (used by single logs and by
   * split-group members alike).
   */
  private async insertEntryLogs(date: string, food: FoodReference, item: InterpretedFoodItem, observation: FoodObservation): Promise<LoggedTextEntry> {
    const amountG = item.amountG ?? null;
    const amountMl = item.amountMl ?? null;
    const effectiveAmount = item.amountG ?? item.amountMl ?? 100;

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

  /**
   * E3 split-group logging: members of one interpreter split ("Roast Beef
   * With Gravy" -> beef + gravy) share ONE combo-marker observation so the
   * journal renders a single collapsible row titled with the user's own
   * phrase — split for math, clustered for display. The marker carries
   * per-member flags (assumed-amount state + span phrase) so badges and
   * "Default for '…'" pins keep working per ingredient. Resolution runs
   * once per member up front (logTextEntry-equivalent, no double upsert).
   */
  async logSplitGroup(date: string, rawInput: string, members: InterpretedFoodItem[]): Promise<LoggedTextEntry[]> {
    const phrase = groupPhrase(rawInput, members);
    const resolved: Array<{ item: InterpretedFoodItem; food: FoodReference }> = [];
    for (const item of members) {
      resolved.push({
        item,
        food: await this.resolveFood(item, DEFAULT_NUTRIENT_ESTIMATE, extractSpanText(rawInput, item)),
      });
    }
    const marker = await this.observationRepo.insert({
      food_id: null,
      source_type: 'combo',
      estimated_amount: null,
      final_amount: null,
      amount_unit: 'g',
      confidence: null,
      raw_input: phrase,
      interpretation_json: JSON.stringify({
        kind: 'combo',
        comboId: null,
        comboName: phrase,
        splitFlags: resolved.map(({ item, food }) => ({
          food_id: food.id,
          wasDefault: !!item.wasDefault,
          rawUnit: (item as unknown as { rawUnit?: unknown })?.rawUnit ?? null,
          spanText: extractSpanText(rawInput, item),
        })),
      }),
      user_corrected: 0
    });
    const out: LoggedTextEntry[] = [];
    for (const { item, food } of resolved) {
      out.push(await this.insertEntryLogs(date, food, item, marker));
    }
    return out;
  }

  async logTextInput(date: string, rawInput: string, items: InterpretedFoodItem[]): Promise<LoggedTextEntry[]> {
    const results: LoggedTextEntry[] = [];
    let i = 0;
    while (i < items.length) {
      // E3: consecutive members of one interpreter split log under a shared
      // marker (one journal row). Lone items and unmarked items log alone.
      const group = items[i]?.splitGroup ?? null;
      if (group) {
        const members: InterpretedFoodItem[] = [];
        while (i < items.length && items[i]?.splitGroup === group) members.push(items[i++]);
        if (members.length >= 2) {
          results.push(...await this.logSplitGroup(date, rawInput, members));
          continue;
        }
        results.push(await this.logTextEntry(date, rawInput, members[0]));
        continue;
      }
      results.push(await this.logTextEntry(date, rawInput, items[i]));
      i++;
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
      // Update stale library entry with fresh OCR values (fixes "label OCR not saving")
      const needsUpdate =
        (ocr.caloriesPer100g != null && ocr.caloriesPer100g !== found.calories_per_100g) ||
        (ocr.proteinPer100g != null && ocr.proteinPer100g !== found.protein_per_100g) ||
        (ocr.carbsPer100g != null && ocr.carbsPer100g !== found.carbs_per_100g) ||
        (ocr.fatPer100g != null && ocr.fatPer100g !== found.fat_per_100g) ||
        (ocr.waterPer100g != null && ocr.waterPer100g !== found.water_per_100g);
      if (needsUpdate) {
        const updated = await this.foodRepo.update(found.id, {
          calories_per_100g: ocr.caloriesPer100g ?? found.calories_per_100g,
          protein_per_100g: ocr.proteinPer100g ?? found.protein_per_100g,
          carbs_per_100g: ocr.carbsPer100g ?? found.carbs_per_100g,
          fat_per_100g: ocr.fatPer100g ?? found.fat_per_100g,
          water_per_100g: ocr.waterPer100g ?? found.water_per_100g,
          confidence: ocr.confidence ?? found.confidence
        } as any);
        food = updated ?? found;
      } else {
        food = found;
      }
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
      const needsUpdate =
        product.caloriesPer100g !== found.calories_per_100g ||
        product.proteinPer100g !== found.protein_per_100g ||
        product.carbsPer100g !== found.carbs_per_100g ||
        product.fatPer100g !== found.fat_per_100g;
      if (needsUpdate) {
        const updated = await this.foodRepo.update(found.id, {
          calories_per_100g: product.caloriesPer100g,
          protein_per_100g: product.proteinPer100g,
          carbs_per_100g: product.carbsPer100g,
          fat_per_100g: product.fatPer100g,
          source_reference: barcode
        } as any);
        food = updated ?? found;
      } else {
        food = found;
      }
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
