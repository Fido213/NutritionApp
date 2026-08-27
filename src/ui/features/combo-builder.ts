/**
 * Combo builder (§5d remake): full-screen editor with per-item amounts.
 *
 * Pass-21 smoothness pass:
 * - amount edits update the row kcal + totals LIVE via `input` — the list is
 *   NOT rebuilt, so focus and the Android keyboard stay put;
 * - search is debounced (~160 ms) and its scroll position survives add/remove
 *   re-renders so mid-list taps don't teleport the user back to the top;
 * - haptic ticks on ingredient add/remove and a success buzz on save;
 * - New-Combo focuses the name field (after the slide-up settles) and Enter
 *   in the name field saves; the save button disables itself while saving
 *   so a double-tap can't create duplicates.
 */
import { calculateNutrition } from '@domain/nutrition';
import { showToast } from '../components/toast';
import { pushLayer, closeLayer, animateViewIn, ViewId } from '../nav';
import { hapticLight, hapticSuccess } from '../haptics';
import { ctx, resolveFoodCached } from '../context';
import type { Food } from '@data/types';
import { renderIndex, invalidateIndexCaches } from './index-screen';

let builderComboId: string | null = null;
let builderItems: Array<{ foodId: string; amountG: number | null; amountMl: number | null }> = [];
let builderSearchGen = 0;
let builderTotalsGen = 0;

const SEARCH_DEBOUNCE_MS = 160;
/** Pass 22b jank fix: rebuilding ~1000 DOM rows on every tap was the chop.
 *  Render at most this many rows; a tail hint tells the user to narrow. */
const LIST_RENDER_CAP = 100;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let builderSaving = false;

/**
 * Pass 22b lag fix: the A–Z library used to be RE-FETCHED (1000 rows over the
 * SQLite bridge) + re-sorted on every add/remove tap. Load it once per builder
 * session and reuse for every empty-query render; searches still hit the DB.
 */
let builderLibrary: Food[] | null = null;

async function getLibraryAZ(): Promise<Food[]> {
  if (!builderLibrary) {
    const foods = await ctx.foodRepo.getAllFoods(1000);
    builderLibrary = [...foods].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
  }
  return builderLibrary;
}

function currentComboQuery(): string {
  return (document.getElementById('combo-item-search') as HTMLInputElement | null)?.value.trim() || '';
}

export function openComboBuilderView(editComboId: string | null) {
  builderComboId = editComboId;
  builderItems = [];
  builderLibrary = null;
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }

  const previousView = ctx.currentViewId;
  pushLayer(() => closeComboBuilderView(previousView));

  document.body.classList.add('builder-open');
  document.querySelectorAll('main section.view').forEach(v => v.classList.remove('active-view'));
  const view = document.getElementById('view-combo-builder');
  const titleEl = document.getElementById('combo-builder-title');
  if (titleEl) titleEl.textContent = editComboId ? 'Edit Combo' : 'New Combo';
  const nameInput = document.getElementById('combo-name-input') as HTMLInputElement | null;
  if (nameInput) nameInput.value = '';

  if (editComboId) {
    ctx.comboRepo.getCombo(editComboId).then(async (combo) => {
      if (!combo) {
        showToast('That combo no longer exists');
        closeLayer();
        return;
      }
      if (nameInput) nameInput.value = combo.name;
      builderItems = combo.items.map(i => ({
        foodId: i.food_id,
        amountG: i.amount_g ?? (i.amount_ml == null ? 100 : null),
        amountMl: i.amount_ml ?? null
      }));
      await Promise.all([
        renderComboBuilderItems(),
        refreshComboBuilderTotals(),
        renderComboSearchResults('')
      ]);
    });
  } else {
    renderComboBuilderItems();
    refreshComboBuilderTotals();
    renderComboSearchResults('');
    // Pass-22e: NO auto-focus on the name field — the popping keyboard fought
    // the slide-up and yanked the user away from the ingredient list.
  }

  if (view) {
    view.classList.add('active-view');
    animateViewIn(view, 'up');
  }
}

function closeComboBuilderView(previousView: ViewId) {
  document.body.classList.remove('builder-open');
  document.getElementById('view-combo-builder')?.classList.remove('active-view');
  ctx.tabController?.switchTabDirect(previousView);
  builderComboId = null;
  builderItems = [];
  builderLibrary = null;
}

export function setupComboBuilderHandlers() {
  document.getElementById('btn-combo-back')?.addEventListener('click', () => closeLayer());

  const search = document.getElementById('combo-item-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => {
    // Debounced: one query per pause, not one per keystroke.
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      renderComboSearchResults(search.value.trim());
    }, SEARCH_DEBOUNCE_MS);
  });
  search?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
    renderComboSearchResults(search.value.trim());
  });

  const nameInput = document.getElementById('combo-name-input') as HTMLInputElement | null;
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveComboFromBuilder();
    }
  });

  document.getElementById('btn-save-combo')?.addEventListener('click', () => { void saveComboFromBuilder(); });
}

async function renderComboSearchResults(query: string, preserveScroll = false) {
  const container = document.getElementById('combo-search-results');
  if (!container) return;

  const prevScrollTop = preserveScroll ? container.scrollTop : 0;

  const gen = ++builderSearchGen;
  // Pass-22 fix: "can't see all my foods" — the list was hard-capped at 60
  // (40 while searching). The full A–Z library comes from the per-session
  // cache (no DB round-trip per tap); searches hit the fuzzy index.
  const source = query
    ? await ctx.foodRepo.fuzzySearch(query, 300)
    : await getLibraryAZ();
  if (gen !== builderSearchGen) return;
  let results = source;
  const total = results.length;
  const truncated = total > LIST_RENDER_CAP;
  if (truncated) results = results.slice(0, LIST_RENDER_CAP);

  container.innerHTML = '';
  if (results.length === 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);padding:4px;text-align:center;';
    hint.textContent = 'No matching foods — log them first, then build combos.';
    container.appendChild(hint);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const food of results) {
    const added = builderItems.some(i => i.foodId === food.id);
    const row = document.createElement('div');
    row.className = 'log-item combo-add-row' + (added ? ' added' : '');
    const main = document.createElement('div');
    main.className = 'log-main';
    const name = document.createElement('span');
    name.className = 'log-name';
    name.textContent = food.canonical_name;
    const cal = document.createElement('span');
    cal.className = 'log-cal';
    cal.style.fontSize = '12px';
    cal.textContent = food.calories_per_100g != null ? `${Math.round(food.calories_per_100g)} kcal/100g` : 'no data';
    main.append(name, cal);
    row.appendChild(main);

    if (added) {
      const badge = document.createElement('div');
      badge.className = 'combo-chip';
      badge.style.cssText = 'margin-top:2px;width:fit-content;';
      badge.textContent = '✓ In Combo';
      row.appendChild(badge);
    }

    row.addEventListener('click', () => { void toggleComboBuilderItem(food.id); });
    frag.appendChild(row);
  }

  if (truncated) {
    const tail = document.createElement('div');
    tail.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 4px;text-align:center;';
    tail.textContent = `+ ${total - LIST_RENDER_CAP} more — type to narrow down`;
    frag.appendChild(tail);
  }
  container.appendChild(frag);

  if (preserveScroll) container.scrollTop = prevScrollTop;
}

/** Pass 22: tapping a food in ADD INGREDIENTS toggles it — a second tap on a
 *  food that is already in the combo REMOVES it (same as its × button). */
async function toggleComboBuilderItem(foodId: string) {
  const existing = builderItems.findIndex(i => i.foodId === foodId);
  hapticLight();
  if (existing >= 0) {
    await removeComboBuilderItem(existing);
    return;
  }
  builderItems.push({ foodId, amountG: 100, amountMl: null });
  await Promise.all([
    renderComboBuilderItems(),
    refreshComboBuilderTotals(),
    renderComboSearchResults(currentComboQuery(), true)
  ]);
}

async function removeComboBuilderItem(idx: number) {
  builderItems.splice(idx, 1);
  await Promise.all([
    renderComboBuilderItems(),
    refreshComboBuilderTotals(),
    renderComboSearchResults(currentComboQuery(), true)
  ]);
}

/** Recompute ONE row's kcal label from the cached food (no DOM rebuild). */
function refreshRowKcal(item: { foodId: string; amountG: number | null; amountMl: number | null }, kcalEl: HTMLElement) {
  const cached = ctx.foodCache.get(item.foodId);
  if (!cached) return;
  const amt = item.amountG ?? item.amountMl ?? 100;
  const n = calculateNutrition(ctx.foodRepo.toFoodReference(cached), amt);
  kcalEl.textContent = `${Math.round(n.calories)} kcal`;
}

function renderComboBuilderItems() {
  const container = document.getElementById('combo-builder-items');
  const label = document.getElementById('combo-items-label');
  if (!container) return;

  if (label) label.textContent = `INGREDIENTS (${builderItems.length})`;
  container.innerHTML = '';

  if (builderItems.length === 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);padding:4px 2px;';
    hint.textContent = 'Nothing yet — search above and tap foods to add them (100 g each to start).';
    container.appendChild(hint);
    return;
  }

  const frag = document.createDocumentFragment();
  builderItems.forEach((item, idx) => {
    const food = ctx.foodCache.get(item.foodId);
    const ref = food ? ctx.foodRepo.toFoodReference(food) : null;
    const amt = item.amountG ?? item.amountMl ?? 100;
    const nutrition = ref ? calculateNutrition(ref, amt) : null;
    const isMl = item.amountMl != null;

    const row = document.createElement('div');
    row.className = 'log-item combo-build-row';

    const main = document.createElement('div');
    main.className = 'log-main';
    const name = document.createElement('span');
    name.className = 'log-name';
    name.textContent = food?.canonical_name || 'Loading…';
    const remove = document.createElement('button');
    remove.className = 'combo-remove-btn';
    remove.title = 'Remove from combo';
    remove.setAttribute('aria-label', 'Remove from combo');
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      void removeComboBuilderItem(idx);
    });
    main.append(name, remove);
    row.appendChild(main);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:8px;padding-left:2px;';

    // Pass-22b steppers: ±10 g without opening the keyboard.
    const getAmt = () => item.amountG ?? item.amountMl ?? 100;
    const setAmt = (v: number) => {
      if (isMl) item.amountMl = Math.max(1, Math.round(v * 100) / 100);
      else item.amountG = Math.max(1, Math.round(v * 100) / 100);
    };
    const applyAmount = (v: number) => {
      setAmt(v);
      amount.value = String(getAmt());
      refreshRowKcal(item, kcal);
      void refreshComboBuilderTotals();
    };
    const minus = document.createElement('button');
    minus.className = 'combo-step-btn';
    minus.textContent = '−';
    minus.setAttribute('aria-label', '10 grams less');
    minus.addEventListener('click', (e) => { e.stopPropagation(); hapticLight(); applyAmount(getAmt() - 10); });

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.step = 'any';
    amount.inputMode = 'decimal';
    amount.value = String(getAmt());
    amount.className = 'combo-amount-input';

    const plus = document.createElement('button');
    plus.className = 'combo-step-btn';
    plus.textContent = '+';
    plus.setAttribute('aria-label', '10 grams more');
    plus.addEventListener('click', (e) => { e.stopPropagation(); hapticLight(); applyAmount(getAmt() + 10); });

    // Live update while typing: scale this row's kcal + the totals WITHOUT
    // rebuilding the list — rebuilding here used to drop focus and slam the
    // Android keyboard shut after every digit.
    amount.addEventListener('input', () => {
      const v = parseFloat(amount.value);
      if (!(v > 0)) return;
      setAmt(v);
      refreshRowKcal(item, kcal);
      void refreshComboBuilderTotals();
    });
    // Normalization only on commit: invalid/empty snaps back to 100.
    amount.addEventListener('change', () => {
      const v = parseFloat(amount.value);
      if (!(v > 0)) {
        setAmt(100);
        amount.value = '100';
        refreshRowKcal(item, kcal);
        void refreshComboBuilderTotals();
        return;
      }
      setAmt(v);
    });

    const unit = document.createElement('span');
    unit.style.cssText = 'font-size:11px;color:var(--text-dim);font-weight:700;';
    unit.textContent = isMl ? 'ml' : 'g';
    const kcal = document.createElement('span');
    kcal.className = 'combo-row-kcal';
    kcal.textContent = nutrition ? `${Math.round(nutrition.calories)} kcal` : '—';

    controls.append(minus, amount, unit, plus, kcal);
    row.appendChild(controls);

    frag.appendChild(row);

    // Warm the cache for rows still loading their name.
    if (!food) resolveFoodCached(item.foodId).then(f => {
      if (f) renderComboBuilderItems();
    });
  });
  container.appendChild(frag);
}

async function refreshComboBuilderTotals() {
  const gen = ++builderTotalsGen;
  let kcal = 0, pro = 0, carb = 0, fat = 0;
  for (const item of builderItems) {
    const food = await resolveFoodCached(item.foodId);
    if (!food) continue;
    const amt = item.amountG ?? item.amountMl ?? 100;
    const n = calculateNutrition(ctx.foodRepo.toFoodReference(food), amt);
    kcal += n.calories;
    pro += n.proteinG;
    carb += n.carbsG;
    fat += n.fatG;
  }
  if (gen !== builderTotalsGen) return;

  const kcalEl = document.getElementById('combo-total-kcal');
  const macrosEl = document.getElementById('combo-total-macros');
  if (kcalEl) kcalEl.textContent = String(Math.round(kcal));
  if (macrosEl) {
    macrosEl.innerHTML = `
      <span style="color: var(--pro);">P: ${Math.round(pro)}g</span> ·
      <span style="color: var(--carb);">C: ${Math.round(carb)}g</span> ·
      <span style="color: var(--fat);">F: ${Math.round(fat)}g</span>
    `;
  }
}

async function saveComboFromBuilder() {
  if (builderSaving) return; // double-tap guard — never save twice

  const nameInput = document.getElementById('combo-name-input') as HTMLInputElement | null;
  const name = nameInput?.value.trim() || '';
  if (!name || builderItems.length === 0) {
    showToast('Give the combo a name and at least one ingredient');
    return;
  }
  const items = builderItems.map(i => ({ food_id: i.foodId, amount_g: i.amountG, amount_ml: i.amountMl }));

  const saveBtn = document.getElementById('btn-save-combo') as HTMLButtonElement | null;
  const originalLabel = saveBtn?.textContent ?? 'Save Combo';
  builderSaving = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }

  let errored: unknown = null;
  try {
    try {
      if (builderComboId) await ctx.comboRepo.updateCombo(builderComboId, name, items);
      else await ctx.comboRepo.createCombo(name, items);
    } catch (err) {
      errored = err;
      console.error('Combo save reported an error:', err);
    }

    // Belt & suspenders: some connections throw AFTER the writes already landed
    // (spurious COMMIT state) — verify against the DB before declaring failure,
    // so the user never sees an error for a combo that actually saved.
    if (errored) {
      let persisted = false;
      try {
        if (builderComboId) {
          const check = await ctx.comboRepo.getCombo(builderComboId);
          persisted = !!check && check.name === name && check.items.length === items.length;
        } else {
          const all = await ctx.comboRepo.getAllCombos();
          persisted = all.some(c => c.name === name && c.items.length === items.length);
        }
      } catch { /* verification itself failed → treat as a real failure */ }
      if (!persisted) {
        showToast('Could not save the combo — try again');
        return;
      }
    }

    hapticSuccess();
    showToast(`${builderComboId ? 'Updated' : 'Saved'} combo "${name}"`);
    // Pass-22e ROOT-CAUSE FIX for "saving doesn't work": the combo WAS created
    // but the index screen's combos cache kept serving the pre-save list, so
    // the new combo never appeared. Drop the caches before re-rendering.
    invalidateIndexCaches();
    closeLayer();
    await renderIndex();
  } finally {
    builderSaving = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  }
}
