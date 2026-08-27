/**
 * Edit screen (§5b item 2 dedicated view; §5c-A genuinely full-screen):
 * amount-multiplier macro editing, rename → library reuse, note, date move.
 */
import { showToast } from '../components/toast';
import { pushLayer, closeLayer, animateViewIn, ViewId } from '../nav';
import { normalizeFoodName } from '@domain/logging';
import { refreshStateForDate, invalidateHistoryWindow } from '../app-refresh';
import { store } from '../state';
import { ctx } from '../context';
import type { JournalFoodLog } from '@ui/views/day-detail';
import { invalidateIndexCaches } from './index-screen';

export async function openEditView(log: JournalFoodLog) {
  const food = log.food_id ? await ctx.foodRepo.findById(log.food_id) : null;
  const baseAmount = log.amount_g ?? log.amount_ml ?? 100;

  const setValue = (id: string, value: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
  };

  setValue('edit-log-id', log.id);
  setValue('edit-name', food?.canonical_name || log.food_name || 'Logged Item');
  setValue('edit-date', log.date);
  setValue('base-cal', String(log.calories || 0));
  setValue('base-pro', String(log.protein_g || 0));
  setValue('base-carb', String(log.carbs_g || 0));
  setValue('base-fat', String(log.fat_g || 0));
  setValue('base-amount', String(baseAmount));
  setValue('eaten-amount', String(baseAmount));
  setValue('edit-cal', String(Math.round(log.calories || 0)));
  setValue('edit-pro', String(Math.round(log.protein_g || 0)));
  setValue('edit-carb', String(Math.round(log.carbs_g || 0)));
  setValue('edit-fat', String(Math.round(log.fat_g || 0)));
  setValue('edit-note', log.note || '');

  const editView = document.getElementById('view-edit');
  const previousView = ctx.currentViewId;
  if (!editView) return;

  pushLayer(() => switchToBaseView(previousView));
  document.querySelectorAll('main section.view').forEach(v => {
    if (v.id !== 'view-edit') v.classList.remove('active-view');
  });
  document.querySelectorAll('.nav-btn').forEach(b => b?.classList.remove('active'));
  // §5c-A: genuinely full-screen — dock + settings gear hidden, slide-up entrance.
  document.body.classList.add('edit-open');
  editView.classList.add('active-view');
  animateViewIn(editView, 'up');
}

function switchToBaseView(viewId: ViewId) {
  document.body.classList.remove('edit-open');
  document.getElementById('view-edit')?.classList.remove('active-view');
  ctx.tabController?.switchTabDirect(viewId);
}

export function setupEditHandlers() {
  document.getElementById('btn-edit-back')?.addEventListener('click', () => closeLayer());

  // Auto-scale the visible macro fields when the amount changes — so the
  // edit-cal/pro/carb/fat inputs stay in sync with the amount multiplier.
  // Direct macro edits are preserved (user can override after).
  const syncMacrosFromAmount = () => {
    const read = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value || '';
    const baseAmount = parseFloat(read('base-amount')) || 100;
    const eatenAmount = parseFloat(read('eaten-amount')) || 0;
    if (!(baseAmount > 0 && eatenAmount > 0)) return;
    const multiplier = eatenAmount / baseAmount;
    const set = (id: string, v: number) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = String(Math.round(v * multiplier));
    };
    const baseCal = parseFloat(read('base-cal')) || 0;
    const basePro = parseFloat(read('base-pro')) || 0;
    const baseCarb = parseFloat(read('base-carb')) || 0;
    const baseFat = parseFloat(read('base-fat')) || 0;
    set('edit-cal', baseCal);
    set('edit-pro', basePro);
    set('edit-carb', baseCarb);
    set('edit-fat', baseFat);
  };
  document.getElementById('base-amount')?.addEventListener('input', syncMacrosFromAmount);
  document.getElementById('eaten-amount')?.addEventListener('input', syncMacrosFromAmount);

  document.getElementById('btn-save-edit')?.addEventListener('click', async () => {
    const idEl = document.getElementById('edit-log-id') as HTMLInputElement | null;
    const logId = idEl?.value;
    if (!logId) return;

    const read = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value || '';
    const name = read('edit-name').trim() || 'Logged Item';
    const date = read('edit-date') || store.getState().selectedDate;
    const note = read('edit-note').trim() || null;

    const eatenAmount = parseFloat(read('eaten-amount')) || 0;

    // FIX: respect the visible macro fields the user actually edited.
    // Previously these were ignored and recomputed from base*multiplier,
    // so "Saving macros doesnt work" — direct edits to calories/protein etc
    // never persisted. Now the edit-cal/pro/carb/fat inputs are the source
    // of truth (they are auto-scaled when amount changes, but user overrides
    // win).
    const calories = Math.round(parseFloat(read('edit-cal')) || 0);
    const proteinG = Math.round(parseFloat(read('edit-pro')) || 0);
    const carbsG = Math.round(parseFloat(read('edit-carb')) || 0);
    const fatG = Math.round(parseFloat(read('edit-fat')) || 0);

    const current = await ctx.logRepo.findById(logId);
    if (!current) {
      showToast('Log not found');
      return;
    }

    let foodId = current.food_id;
    const currentFood = current.food_id ? await ctx.foodRepo.findById(current.food_id) : null;
    if (currentFood && name !== currentFood.canonical_name) {
      let renamed = await ctx.foodRepo.findByNormalizedName(normalizeFoodName(name));
      if (!renamed) {
        // Use the EDITED macros for the new library entry, not the pre-edit values
        const refAmount = eatenAmount > 0 ? eatenAmount : (current.amount_g || current.amount_ml || 100);
        renamed = await ctx.foodRepo.insert({
          canonical_name: name,
          normalized_name: normalizeFoodName(name),
          calories_per_100g: refAmount > 0 ? (calories / refAmount) * 100 : null,
          protein_per_100g: refAmount > 0 ? (proteinG / refAmount) * 100 : null,
          carbs_per_100g: refAmount > 0 ? (carbsG / refAmount) * 100 : null,
          fat_per_100g: refAmount > 0 ? (fatG / refAmount) * 100 : null,
          water_per_100g: 0,
          nutrition_basis: 'per_100g',
          source_type: 'user_entered',
          confidence: 1.0
        });
        ctx.foodCache.set(renamed.id, renamed);
        invalidateIndexCaches();
      }
      foodId = renamed.id;
    }

    const updates: any = {
      date,
      food_id: foodId,
      calories,
      protein_g: proteinG,
      carbs_g: carbsG,
      fat_g: fatG,
      note
    };
    if (eatenAmount > 0) {
      if (current.amount_ml != null) updates.amount_ml = eatenAmount;
      else updates.amount_g = eatenAmount;
    }

    await ctx.logRepo.updateLog(logId, updates);
    await ctx.dbManager.saveWebStore();

    const previousDate = current.date;
    invalidateHistoryWindow();
    closeLayer();
    await refreshStateForDate(date);
    if (date !== previousDate) {
      await refreshStateForDate(previousDate);
    }
    showToast('Log updated');
  });
}
