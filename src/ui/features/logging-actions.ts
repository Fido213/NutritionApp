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
import { expandCombo, isPlainWaterPhrase } from '@domain/logging';
import { extractSpanText } from '@services/food/food-service';
import { refreshStateForDate } from '../app-refresh';
import type { Food } from '@data/types';
import { ctx } from '../context';
import type { ComboRepository } from '@data/repositories/combo.repo';
import { invalidateIndexCaches } from './index-screen';

/** Log a meal description through L12 interpreter + hybrid retriever + FoodService pipeline.
 *  Primary path: deterministic qty parser + L12 FOOD NER spans -> hybrid BM25/mE5 -> FoodService.
 *  Fallback: GemmaClient when interpreter yields 0 spans (e.g., no foods cached yet).
 */
let logTextInFlight = false;

/**
 * Session interpreter cache: the FULL library (39k rows — the old
 * newest-1000 window hid 97% of the seed from retrieval) plus the repo
 * generation it was indexed at. Steady-state submits skip the fetch and
 * the BM25/embedding rebuild entirely; any library mutation bumps the
 * repo version and the next submit re-indexes once.
 */
const FULL_LIBRARY_FETCH = 100_000;
let interpreterFoods: any[] | null = null;
let interpreterVersion = -1;

export async function logTextInput(rawText: string) {
  // Overlapping submits (double-tap, Enter+click, slow first submit) would
  // log the same text twice or interleave stale input — serialize instead.
  if (logTextInFlight) {
    showToast('Still logging — one moment');
    return;
  }
  logTextInFlight = true;

  // Clear-first: the text is captured in rawText, so the input must not hold
  // it during the (slow) pipeline — otherwise any repeated submit re-logs
  // stale text, and a failed submit leaves a retry trap behind.
  const textInput = document.getElementById('dash-text-input') as HTMLInputElement | null;
  if (textInput && textInput.value.trim() === rawText.trim()) {
    textInput.value = '';
    textInput.closest('.text-bar')?.classList.remove('has-text');
  }

  try {
    await logTextInputInner(rawText);
  } finally {
    logTextInFlight = false;
  }
}

async function logTextInputInner(rawText: string) {
  const date = store.getState().selectedDate;
  // Submit-path diagnosis (user-reported seconds): stage timings, debug-only,
  // zero behavior change. Read via WebView CDP after one slow submit.
  const t0 = performance.now();
  const marks: Record<string, number> = {};
  const mark = (k: string) => { marks[k] = Math.round(performance.now() - t0); };

  // Try new interpreter first (offline, L12 + FP16). Needs food list for hybrid retrieval.
  let items: any[] | null = null;
  try {
    const { interpretText, setFoodsForInterpreter } = await import('@services/interpreter');
    // Version-gated: refetch + rebuild only when the library changed.
    // A failed refetch keeps the previous cache (possibly null → the
    // interpreter degrades to span-text logging, as before).
    const version = ctx.foodRepo.getVersion();
    if (!interpreterFoods || version !== interpreterVersion) {
      try {
        interpreterFoods = await ctx.foodRepo.getAllFoods(FULL_LIBRARY_FETCH);
        setFoodsForInterpreter(interpreterFoods, version);
        interpreterVersion = version;
      } catch { /* keep previous cache */ }
    }
    const foods = interpreterFoods ?? [];
    mark('foods-fetch');
    const spans = await interpretText(rawText, foods.length ? foods : null);
    mark('interpret');
    if (spans && spans.length > 0) {
      items = spans.map(s => ({
        canonicalName: s.canonicalName,
        amountG: s.amountG,
        amountMl: s.amountMl,
        confidence: s.confidence,
        isComposite: s.isComposite,
        wasDefault: s.wasDefault,
        script: s.script,
        rawUnit: s.rawUnit,
        retrievalScore: s.retrievalScore,
        span: s.span,
      }));
    }
  } catch (e) {
    console.debug('[logTextInput] interpreter failed, fallback to Gemma', e);
  }

  // Fallback to Gemma (legacy path) if interpreter found nothing
  if (!items || items.length === 0) {
    items = await ctx.gemmaClient.interpretTextLog(rawText);
    mark('gemma-fallback');
  }

  // Plain water ("500ml water", "water") logs as explicit water — never as
  // a food entry. Single-phrase only; mixed input keeps the food pipeline.
  if (items.length === 1) {
    const only = items[0] as any;
    const phrase = extractSpanText(rawText, only) ?? (only.canonicalName as string | undefined);
    if (isPlainWaterPhrase(phrase)) {
      const ml = Math.round(only.amountMl ?? only.amountG ?? 250);
      await ctx.waterRepo.insertWaterLog({ date, amount_ml: ml, source: 'explicit' });
      mark('water-log');
      await ctx.dbManager.saveWebStore();
      await refreshStateForDate(date);
      console.debug('[logTextInput:timings] ms since submit:', marks);
      showToast(`Logged ${ml} ml water`);
      return;
    }
  }

  if (!items || items.length === 0) {
    // Parse failed: give the text back so it can be fixed and retried.
    const textInput = document.getElementById('dash-text-input') as HTMLInputElement | null;
    if (textInput && !textInput.value.trim()) {
      textInput.value = rawText;
      textInput.closest('.text-bar')?.classList.add('has-text');
    }
    showToast('Could not interpret that text');
    return;
  }

  const results = await ctx.foodService.logTextInput(date, rawText, items as any);
  mark('foodservice-log');
  const totalCal = results.reduce((sum, r) => sum + r.nutrition.calories, 0);
  // Phase 1 flagged-default: immediate feedback at log time, not just the
  // journal badge — assumed amounts must never look confident, even briefly.
  const assumed = (items as any[]).filter(i => i?.wasDefault).length;

  // New foods may have been created via upsert — bust library caches
  for (const r of results) {
    if (r.food?.id) ctx.foodCache.delete(r.food.id);
  }
  invalidateIndexCaches();
  // No explicit BM25 invalidate: library mutations bump the repo version,
  // so the next submit re-indexes once via the version gate above.
  await ctx.dbManager.saveWebStore();
  await refreshStateForDate(date);
  mark('refresh-done');
  // Hot-path incremental index: this submit created/updated at most a few
  // rows — fold them in place instead of refetching 39k. Anything else that
  // mutated the library (scans, imports, edits) bumps the version without a
  // patch, so the next submit still full-refetches exactly once. Never
  // breaks the toast below: failures fall through silently.
  try {
    const v2 = ctx.foodRepo.getVersion();
    if (v2 !== interpreterVersion && interpreterFoods) {
      const { patchInterpreterFoods } = await import('@services/interpreter');
      const changed: any[] = [];
      for (const it of items as any[]) {
        try {
          const ref = await ctx.foodService.resolveFood(it);
          const full = await ctx.foodRepo.findById(ref.id);
          if (full) changed.push(full);
        } catch { /* one bad row must not poison the patch */ }
      }
      if (changed.length > 0 && !patchInterpreterFoods(changed, v2)) {
        interpreterFoods = null; // cold race: force a full refetch next submit
      } else if (changed.length > 0) {
        interpreterVersion = v2;
      } else {
        interpreterFoods = null; // version moved with no resolvable rows: reconverge once, fully
      }
    }
  } catch { /* next submit re-evaluates the version gate */ }
  console.debug('[logTextInput:timings] ms since submit:', marks);
  showToast(`Logged ${results.length} item(s) · ${Math.round(totalCal)} kcal${assumed > 0 ? ` · ${assumed} amount(s) assumed — tap to correct` : ''}`);
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
