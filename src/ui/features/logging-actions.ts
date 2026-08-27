/**
 * Shared logging actions: text logging (Gemma interpretation), library
 * quick-log, exact-amount log, and combo expansion logging. Used by the
 * dashboard text bar, the INDEX screen rows, and the combo detail modal.
 */
import { store } from '../state';
import { showToast } from '../components/toast';
import { closeModalLayer } from '../modal-layers';
import { calculateNutrition } from '@domain/nutrition';
import { classifyWaterSource } from '@domain/hydration';
import { expandCombo } from '@domain/logging';
import { refreshStateForDate } from '../app-refresh';
import type { Food } from '@data/types';
import { ctx } from '../context';
import type { ComboRepository } from '@data/repositories/combo.repo';
import { invalidateIndexCaches } from './index-screen';

/** Log a meal description through Gemma + the FoodService pipeline. */
export async function logTextInput(rawText: string) {
  const date = store.getState().selectedDate;
  const items = await ctx.gemmaClient.interpretTextLog(rawText);

  if (!items || items.length === 0) {
    showToast('Could not interpret that text');
    return;
  }

  const results = await ctx.foodService.logTextInput(date, rawText, items);
  const totalCal = results.reduce((sum, r) => sum + r.nutrition.calories, 0);

  const textInput = document.getElementById('dash-text-input') as HTMLInputElement | null;
  if (textInput) {
    textInput.value = '';
    textInput.closest('.text-bar')?.classList.remove('has-text');
  }

  // New foods may have been created via upsert — bust library caches
  for (const r of results) {
    if (r.food?.id) ctx.foodCache.delete(r.food.id);
  }
  invalidateIndexCaches();
  await ctx.dbManager.saveWebStore();
  await refreshStateForDate(date);
  showToast(`Logged ${results.length} item(s) · ${Math.round(totalCal)} kcal`);
}

/** Log a library food at an exact gram amount on the selected date. */
export async function logFoodAtAmount(food: Food, grams: number) {
  const ref = ctx.foodRepo.toFoodReference(food);
  const nutrition = calculateNutrition(ref, grams);
  const date = store.getState().selectedDate;

  const log = await ctx.logRepo.insertFoodLog({
    date,
    food_id: food.id,
    amount_g: grams,
    calories: nutrition.calories,
    protein_g: nutrition.proteinG,
    carbs_g: nutrition.carbsG,
    fat_g: nutrition.fatG,
    water_ml: nutrition.waterMl
  });

  if (nutrition.waterMl !== null && nutrition.waterMl > 0) {
    await ctx.waterRepo.insertWaterLog({
      date,
      amount_ml: nutrition.waterMl,
      source: classifyWaterSource(ref),
      food_log_id: log.id
    });
  }

  await ctx.dbManager.saveWebStore();
  await refreshStateForDate(date);
  showToast(`Logged ${food.canonical_name} · ${Math.round(nutrition.calories)} kcal`);
}

/** One-tap log at 100 g (the classic library quick-log, kept intact). */
export async function quickLogFood(foodId: string) {
  const food = await ctx.foodRepo.findById(foodId);
  if (!food) {
    showToast('Food not found in library');
    return;
  }
  await logFoodAtAmount(food, 100);
}

/** Expand a combo through the deterministic domain path and log every ingredient.
 *  All ingredient logs share ONE combo observation so the journal can collapse
 *  them into a single expandable breakdown card. */
export async function logCombo(combo: Awaited<ReturnType<ComboRepository['getAllCombos']>>[number]) {
  const date = store.getState().selectedDate;
  const items: Array<{ foodId: string; food: any; amountG: number | null; amountMl: number | null }> = [];
  for (const ci of combo.items) {
    const food = await ctx.foodRepo.findById(ci.food_id);
    if (!food) continue;
    items.push({ foodId: food.id, food: ctx.foodRepo.toFoodReference(food), amountG: ci.amount_g ?? 100, amountMl: ci.amount_ml });
  }
  if (items.length === 0) {
    showToast('Combo ingredients missing from library');
    return;
  }

  const markerObservation = await ctx.observationRepo.insert({
    food_id: null,
    source_type: 'combo',
    estimated_amount: null,
    final_amount: null,
    amount_unit: 'g',
    confidence: null,
    raw_input: combo.name,
    interpretation_json: JSON.stringify({ kind: 'combo', comboId: combo.id, comboName: combo.name }),
    user_corrected: 0
  });

  const template = { id: combo.id, name: combo.name, items };
  const entries = expandCombo(template, date);
  let totalCal = 0;
  for (const entry of entries) {
    const nutrition = calculateNutrition(entry.food, entry.amountG ?? entry.amountMl ?? 100);
    totalCal += nutrition.calories;
    const log = await ctx.logRepo.insertFoodLog({
      date,
      food_id: entry.foodId,
      observation_id: markerObservation.id,
      amount_g: entry.amountG,
      amount_ml: entry.amountMl,
      calories: nutrition.calories,
      protein_g: nutrition.proteinG,
      carbs_g: nutrition.carbsG,
      fat_g: nutrition.fatG,
      water_ml: nutrition.waterMl
    });
    if (nutrition.waterMl !== null && nutrition.waterMl > 0) {
      await ctx.waterRepo.insertWaterLog({
        date,
        amount_ml: nutrition.waterMl,
        source: classifyWaterSource(entry.food),
        food_log_id: log.id
      });
    }
  }

  closeModalLayer('combo-detail-modal');
  await ctx.dbManager.saveWebStore();
  await refreshStateForDate(date);
  showToast(`Logged combo "${combo.name}" · ${Math.round(totalCal)} kcal`);
}
