/**
 * INDEX screen (§5d): the Journal modal became a dedicated tab.
 *
 * Two sub-views — FOODS (the library) and COMBOS — behind one fuzzy search bar
 * and a sort selector covering date created, kcal, every macro and confidence,
 * each in both directions ("highest and lowest of x, or newest/oldest").
 * Also hosts the combo detail modal (clean image-2 breakdown).
 */
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName } from '@domain/logging';
import { store } from '../state';
import { showToast } from '../components/toast';
import { openModalLayer, closeModalLayer } from '../modal-layers';
import { requestConfirmation, requestGrams } from '../dialogs';
import { ctx, resolveFoodCached } from '../context';
import type { Food } from '@data/types';
import type { ComboRepository } from '@data/repositories/combo.repo';
import { quickLogFood, logFoodAtAmount, logCombo } from './logging-actions';
import { openComboBuilderView } from './combo-builder';

export type FoodSortKey =
  | 'created-desc' | 'created-asc'
  | 'kcal-desc' | 'kcal-asc'
  | 'protein-desc' | 'protein-asc'
  | 'carbs-desc' | 'carbs-asc'
  | 'fat-desc' | 'fat-asc'
  | 'confidence-desc' | 'confidence-asc';

export type ComboSortKey =
  | 'created-desc' | 'created-asc'
  | 'kcal-desc' | 'kcal-asc'
  | 'items-desc' | 'name-asc';

// Foods / Combos sub-views, sort keys, fuzzy query, inline-expanded food row.
let indexTab: 'foods' | 'combos' = 'foods';
let indexSortFoods: FoodSortKey = 'created-desc';
let indexSortCombos: ComboSortKey = 'created-desc';
let indexRenderGen = 0;
let expandedIndexFoodId: string | null = null;
let indexSearchDebounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Pass-22c perf: taps (expand/collapse a row, change sort, flip tab) used to
 * re-query SQLite every time. Fetches are cached per query string and the
 * cache is cleared on every store update (= after every data mutation), so
 * pure UI taps render from memory while real data changes stay fresh.
 */
const indexFetchCache = new Map<string, Food[]>();
let combosCache: Awaited<ReturnType<ComboRepository['getAllCombos']>> | null = null;

/**
 * Pass-22e fix: mutations from OUTSIDE the index screen (combo save/delete in
 * the builder/detail modal, imports, restores, delete-all) must drop these
 * caches or the screen keeps rendering pre-mutation data — this exact staleness
 * made saved combos invisible ("saving doesn't work").
 */
export function invalidateIndexCaches() {
  indexFetchCache.clear();
  combosCache = null;
}

async function fetchFoodsCached(query: string, limit: number): Promise<Food[]> {
  const key = `${query}::${limit}`;
  const hit = indexFetchCache.get(key);
  if (hit) return hit;
  const foods = query
    ? await ctx.foodRepo.fuzzySearch(query, limit)
    : await ctx.foodRepo.getAllFoods(limit);
  if (indexFetchCache.size > 20) indexFetchCache.clear();
  indexFetchCache.set(key, foods);
  return foods;
}

async function fetchCombosCached(): Promise<Awaited<ReturnType<ComboRepository['getAllCombos']>>> {
  if (!combosCache) combosCache = await ctx.comboRepo.getAllCombos();
  return combosCache;
}

/** Library combo whose detail modal is open (§5d clean modal, image-2 layout). */
let openComboDetailId: string | null = null;

const FOOD_SORT_OPTIONS: Array<{ value: FoodSortKey; label: string }> = [
  { value: 'created-desc', label: 'Newest first' },
  { value: 'created-asc', label: 'Oldest first' },
  { value: 'kcal-desc', label: 'Highest kcal' },
  { value: 'kcal-asc', label: 'Lowest kcal' },
  { value: 'protein-desc', label: 'Highest protein' },
  { value: 'protein-asc', label: 'Lowest protein' },
  { value: 'carbs-desc', label: 'Highest carbs' },
  { value: 'carbs-asc', label: 'Lowest carbs' },
  { value: 'fat-desc', label: 'Highest fat' },
  { value: 'fat-asc', label: 'Lowest fat' },
  { value: 'confidence-desc', label: 'Highest confidence' },
  { value: 'confidence-asc', label: 'Lowest confidence' }
];

const COMBO_SORT_OPTIONS: Array<{ value: ComboSortKey; label: string }> = [
  { value: 'created-desc', label: 'Newest first' },
  { value: 'created-asc', label: 'Oldest first' },
  { value: 'kcal-desc', label: 'Highest kcal' },
  { value: 'kcal-asc', label: 'Lowest kcal' },
  { value: 'items-desc', label: 'Most ingredients' },
  { value: 'name-asc', label: 'Name (A–Z)' }
];

function populateIndexSort() {
  const btn = document.getElementById('index-sort') as HTMLButtonElement | null;
  const list = document.getElementById('index-sort-options') as HTMLElement | null;
  const labelEl = document.getElementById('index-sort-label') as HTMLElement | null;
  if (!btn || !list) return;
  const options = indexTab === 'foods' ? FOOD_SORT_OPTIONS : COMBO_SORT_OPTIONS;
  const current = indexTab === 'foods' ? indexSortFoods : indexSortCombos;
  const currentLabel = (options.find(o => o.value === current)?.label) || options[0].label;
  if (labelEl) labelEl.textContent = currentLabel;
  list.innerHTML = '';
  for (const opt of options) {
    const b = document.createElement('button');
    b.className = 'sort-option' + (opt.value === current ? ' active' : '');
    b.textContent = opt.label;
    b.addEventListener('click', () => {
      if (indexTab === 'foods') indexSortFoods = opt.value as FoodSortKey;
      else indexSortCombos = opt.value as ComboSortKey;
      btn.classList.remove('open');
      list.classList.remove('open');
      populateIndexSort();
      renderIndex();
    });
    list.appendChild(b);
  }
}

function setIndexTab(tab: 'foods' | 'combos') {
  indexTab = tab;
  document.getElementById('btn-index-foods')?.classList.toggle('active', tab === 'foods');
  document.getElementById('btn-index-combos')?.classList.toggle('active', tab === 'combos');
  expandedIndexFoodId = null;
  populateIndexSort();
  renderIndex();
}

/** Open the food edit modal pre-filled for this library entry. */
function openFoodEdit(food: Food) {
  (document.getElementById('food-edit-id') as HTMLInputElement | null)!.value = food.id;
  (document.getElementById('food-edit-name') as HTMLInputElement | null)!.value = food.canonical_name;
  (document.getElementById('food-edit-cal') as HTMLInputElement | null)!.value = food.calories_per_100g != null ? String(food.calories_per_100g) : '';
  (document.getElementById('food-edit-pro') as HTMLInputElement | null)!.value = food.protein_per_100g != null ? String(food.protein_per_100g) : '';
  (document.getElementById('food-edit-carb') as HTMLInputElement | null)!.value = food.carbs_per_100g != null ? String(food.carbs_per_100g) : '';
  (document.getElementById('food-edit-fat') as HTMLInputElement | null)!.value = food.fat_per_100g != null ? String(food.fat_per_100g) : '';
  (document.getElementById('food-edit-water') as HTMLInputElement | null)!.value = food.water_per_100g != null ? String(food.water_per_100g) : '';
  openModalLayer('food-edit-modal');
}

async function saveFoodEdit() {
  const id = (document.getElementById('food-edit-id') as HTMLInputElement | null)?.value;
  const nameRaw = (document.getElementById('food-edit-name') as HTMLInputElement | null)?.value.trim() || '';
  if (!id || !nameRaw) {
    showToast('Food name is required');
    return;
  }
  const cal = parseFloat((document.getElementById('food-edit-cal') as HTMLInputElement | null)?.value || '');
  const pro = parseFloat((document.getElementById('food-edit-pro') as HTMLInputElement | null)?.value || '');
  const carb = parseFloat((document.getElementById('food-edit-carb') as HTMLInputElement | null)?.value || '');
  const fat = parseFloat((document.getElementById('food-edit-fat') as HTMLInputElement | null)?.value || '');
  const water = parseFloat((document.getElementById('food-edit-water') as HTMLInputElement | null)?.value || '');

  const updates: Record<string, unknown> = {
    canonical_name: nameRaw,
    normalized_name: normalizeFoodName(nameRaw)
  };
  // null = no data; keep existing if field left empty? Use null for empty so repo stores NULL.
  (updates as any).calories_per_100g = Number.isFinite(cal) ? cal : null;
  (updates as any).protein_per_100g = Number.isFinite(pro) ? pro : null;
  (updates as any).carbs_per_100g = Number.isFinite(carb) ? carb : null;
  (updates as any).fat_per_100g = Number.isFinite(fat) ? fat : null;
  (updates as any).water_per_100g = Number.isFinite(water) ? water : null;

  try {
    const updated = await ctx.foodRepo.update(id, updates as any);
    if (!updated) {
      showToast('Food not found');
      return;
    }
    // Bust every cache that may hold the old per-100 values.
    ctx.foodCache.delete(id);
    ctx.foodCache.set(id, updated);
    invalidateIndexCaches();
    await ctx.dbManager.saveWebStore();
    closeModalLayer('food-edit-modal');
    await renderIndex();
    showToast(`Updated "${nameRaw}"`);
  } catch (err: any) {
    const msg = err?.message?.includes('UNIQUE') || err?.message?.includes('unique')
      ? 'A food with that name already exists'
      : 'Could not update food — try again';
    showToast(msg);
  }
}

export function setupIndexHandlers() {
  document.getElementById('btn-index-foods')?.addEventListener('click', () => setIndexTab('foods'));
  document.getElementById('btn-index-combos')?.addEventListener('click', () => setIndexTab('combos'));
  populateIndexSort();

  // Invalidate fetch caches whenever app data changes (any store update
  // follows a mutation); pure UI taps never touch this path.
  store.subscribe(() => invalidateIndexCaches());

  // Fuzzy search retained (§5d) — debounced so keystrokes don't thrash the list.
  const search = document.getElementById('index-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => {
    if (indexSearchDebounce) clearTimeout(indexSearchDebounce);
    indexSearchDebounce = setTimeout(() => {
      indexSearchDebounce = null;
      renderIndex();
    }, 180);
  });
  search?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (indexSearchDebounce) clearTimeout(indexSearchDebounce);
    indexSearchDebounce = null;
    renderIndex();
  });

  const sortBtn = document.getElementById('index-sort') as HTMLButtonElement | null;
  const sortList = document.getElementById('index-sort-options') as HTMLElement | null;
  sortBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = sortList?.classList.contains('open');
    if (isOpen) {
      sortBtn.classList.remove('open');
      sortList?.classList.remove('open');
    } else {
      sortBtn.classList.add('open');
      sortList?.classList.add('open');
    }
  });
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.index-sort-wrap')) {
      sortBtn?.classList.remove('open');
      sortList?.classList.remove('open');
    }
  });

  // Inline opening of individual foods (same interaction as the day logs).
  document.getElementById('index-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    const row = target.closest('[data-index-food-id]') as HTMLElement | null;
    if (!row?.dataset.indexFoodId) return;
    expandedIndexFoodId = expandedIndexFoodId === row.dataset.indexFoodId ? null : row.dataset.indexFoodId;
    renderIndex();
  });

  document.getElementById('btn-food-edit-ok')?.addEventListener('click', () => { void saveFoodEdit(); });
  document.getElementById('btn-food-edit-cancel')?.addEventListener('click', () => closeModalLayer('food-edit-modal'));
  document.getElementById('food-edit-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('food-edit-modal')) closeModalLayer('food-edit-modal');
  });
}

export async function renderIndex() {
  if (ctx.currentViewId !== 'index') return;
  if (indexTab === 'foods') await renderIndexFoods();
  else await renderIndexCombos();
}

/* ----- Foods sub-view ----- */

function numericCmp(get: (f: Food) => number | null, dir: 'desc' | 'asc'): (a: Food, b: Food) => number {
  return (a: Food, b: Food): number => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // entries without data always sink to the bottom
    if (bv == null) return -1;
    return dir === 'desc' ? bv - av : av - bv;
  };
}

const FOOD_CMP: Record<FoodSortKey, (a: Food, b: Food) => number> = {
  'created-desc': (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
  'created-asc': (a, b) => (a.created_at || '').localeCompare(b.created_at || ''),
  'kcal-desc': numericCmp(f => f.calories_per_100g, 'desc'),
  'kcal-asc': numericCmp(f => f.calories_per_100g, 'asc'),
  'protein-desc': numericCmp(f => f.protein_per_100g, 'desc'),
  'protein-asc': numericCmp(f => f.protein_per_100g, 'asc'),
  'carbs-desc': numericCmp(f => f.carbs_per_100g, 'desc'),
  'carbs-asc': numericCmp(f => f.carbs_per_100g, 'asc'),
  'fat-desc': numericCmp(f => f.fat_per_100g, 'desc'),
  'fat-asc': numericCmp(f => f.fat_per_100g, 'asc'),
  'confidence-desc': numericCmp(f => f.confidence ?? null, 'desc'),
  'confidence-asc': numericCmp(f => f.confidence ?? null, 'asc')
};

function confidenceLabel(confidence: number | null | undefined, sourceType?: string): string {
  // Pass-22e: imported split estimates read "estimated", not a fake-precise
  // "50% sure" — the 0.5 confidence is a marker, not a measurement.
  if (sourceType === 'imported') return 'estimated';
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'no estimate';
  return `${Math.round(confidence * 100)}% sure`;
}

function fmt1(n: number | null | undefined): string {
  return (Math.round((n || 0) * 10) / 10).toString();
}

async function renderIndexFoods() {
  const listEl = document.getElementById('index-list');
  if (!listEl) return;

  const gen = ++indexRenderGen;
  const query = (document.getElementById('index-search') as HTMLInputElement | null)?.value.trim() || '';
  const all = await fetchFoodsCached(query, query ? 300 : 500);
  if (gen !== indexRenderGen) return;
  // Pass-22e perf: rebuilding hundreds of rows on every expand/collapse tap
  // was the remaining index jank. Render a capped A–Z window; the tail hint
  // tells the user to narrow via search.
  const INDEX_RENDER_CAP = 120;
  const truncated = all.length > INDEX_RENDER_CAP;
  const foods = truncated ? [...all].sort(FOOD_CMP[indexSortFoods]).slice(0, INDEX_RENDER_CAP) : [...all].sort(FOOD_CMP[indexSortFoods]);

  listEl.innerHTML = '';
  if (foods.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'index-empty';
    empty.textContent = 'No foods found. Log your first meal from the dashboard text bar.';
    listEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const food of foods) frag.appendChild(buildIndexFoodRow(food));
  if (truncated) {
    const tail = document.createElement('div');
    tail.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 4px;text-align:center;';
    tail.textContent = `+ ${all.length - INDEX_RENDER_CAP} more — search to narrow down`;
    frag.appendChild(tail);
  }
  listEl.appendChild(frag);
}

function buildIndexFoodRow(food: Food): HTMLElement {
  const expanded = expandedIndexFoodId === food.id;
  const row = document.createElement('div');
  row.className = 'log-item' + (expanded ? ' expanded' : '');
  row.dataset.indexFoodId = food.id;

  const main = document.createElement('div');
  main.className = 'log-main';
  const name = document.createElement('span');
  name.className = 'log-name';
  name.textContent = food.canonical_name;
  const cal = document.createElement('span');
  cal.className = 'log-cal';
  cal.textContent = food.calories_per_100g != null ? `${Math.round(food.calories_per_100g)} kcal` : 'no data';
  main.append(name, cal);
  row.appendChild(main);

  const macros = document.createElement('div');
  macros.className = 'log-macros';
  macros.innerHTML = `
    <span style="color: var(--pro);">P: ${Math.round(food.protein_per_100g || 0)}g</span>
    <span style="color: var(--carb);">C: ${Math.round(food.carbs_per_100g || 0)}g</span>
    <span style="color: var(--fat);">F: ${Math.round(food.fat_per_100g || 0)}g</span>
    <span class="conf-chip">${confidenceLabel(food.confidence, food.source_type)}</span>
  `;
  row.appendChild(macros);

  if (expanded) {
    const details = document.createElement('div');
    details.className = 'index-food-details';

    const per100 = document.createElement('div');
    per100.style.cssText = 'font-size:11px;color:var(--text-dim);padding-left:2px;line-height:1.6;';
    per100.textContent =
      `Per 100 g · P ${fmt1(food.protein_per_100g)} · C ${fmt1(food.carbs_per_100g)} · F ${fmt1(food.fat_per_100g)}` +
      (food.water_per_100g ? ` · water ${fmt1(food.water_per_100g)} ml` : '') +
      ` · source: ${food.source_type}`;
    details.appendChild(per100);

    const actions = document.createElement('div');
    actions.className = 'log-actions';
    const quick = document.createElement('button');
    quick.className = 'log-action-btn blue';
    quick.textContent = 'Log 100 g';
    quick.addEventListener('click', async (e) => {
      e.stopPropagation();
      await quickLogFood(food.id);
      expandedIndexFoodId = null;
      renderIndex();
    });
    const custom = document.createElement('button');
    custom.className = 'log-action-btn';
    custom.textContent = 'Other amount…';
    custom.addEventListener('click', async (e) => {
      e.stopPropagation();
      const grams = await requestGrams(
        `How many grams of ${food.canonical_name}?`,
        `${Math.round(food.calories_per_100g || 0)} kcal per 100 g`,
        100
      );
      if (grams === null || !(grams > 0)) return;
      await logFoodAtAmount(food, grams);
      expandedIndexFoodId = null;
      renderIndex();
    });
    const editBtn = document.createElement('button');
    editBtn.className = 'log-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFoodEdit(food);
    });
    actions.append(quick, custom, editBtn);
    details.appendChild(actions);
    row.appendChild(details);
  }

  return row;
}

/* ----- Combos sub-view ----- */

interface IndexComboView {
  combo: Awaited<ReturnType<ComboRepository['getAllCombos']>>[number];
  totalKcal: number;
  totalProtein: number;
  totalCarbs: number;
  totalFat: number;
}

async function loadComboViews(): Promise<IndexComboView[]> {
  const combos = [...(await fetchCombosCached())];
  const views: IndexComboView[] = [];
  for (const combo of combos) {
    let kcal = 0, pro = 0, carb = 0, fat = 0;
    for (const ci of combo.items) {
      const food = await resolveFoodCached(ci.food_id);
      if (!food) continue;
      const n = calculateNutrition(ctx.foodRepo.toFoodReference(food), ci.amount_g ?? ci.amount_ml ?? 100);
      kcal += n.calories;
      pro += n.proteinG;
      carb += n.carbsG;
      fat += n.fatG;
    }
    views.push({ combo, totalKcal: kcal, totalProtein: pro, totalCarbs: carb, totalFat: fat });
  }

  switch (indexSortCombos) {
    case 'created-desc': return views.sort((a, b) => (b.combo.created_at || '').localeCompare(a.combo.created_at || ''));
    case 'created-asc': return views.sort((a, b) => (a.combo.created_at || '').localeCompare(b.combo.created_at || ''));
    case 'kcal-desc': return views.sort((a, b) => b.totalKcal - a.totalKcal);
    case 'kcal-asc': return views.sort((a, b) => a.totalKcal - b.totalKcal);
    case 'items-desc': return views.sort((a, b) => b.combo.items.length - a.combo.items.length);
    case 'name-asc': return views.sort((a, b) => a.combo.name.localeCompare(b.combo.name));
  }
}

async function renderIndexCombos() {
  const listEl = document.getElementById('index-list');
  if (!listEl) return;

  const gen = ++indexRenderGen;
  const views = await loadComboViews();
  if (gen !== indexRenderGen) return;

  listEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'index-list-head';
  const count = document.createElement('span');
  count.style.cssText = 'font-size:12px;color:var(--text-dim);font-weight:700;';
  count.textContent = `${views.length} combo${views.length === 1 ? '' : 's'} · tap for breakdown`;
  head.appendChild(count);
  const newBtn = document.createElement('button');
  newBtn.className = 'log-action-btn blue';
  newBtn.style.cssText = 'flex:none;width:auto;padding:6px 12px;';
  newBtn.textContent = '+ New Combo';
  newBtn.addEventListener('click', () => openComboBuilderView(null));
  head.appendChild(newBtn);
  listEl.appendChild(head);

  if (views.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'index-empty';
    empty.textContent = 'No combos yet — tap "+ New Combo" to build your first one.';
    listEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const view of views) {
    const row = document.createElement('div');
    row.className = 'combo-row';
    const main = document.createElement('div');
    main.className = 'log-main';
    const name = document.createElement('span');
    name.className = 'log-name';
    name.textContent = `🍱 ${view.combo.name}`;
    const cal = document.createElement('span');
    cal.className = 'log-cal';
    cal.style.fontSize = '13px';
    cal.textContent = `${Math.round(view.totalKcal)} kcal`;
    main.append(name, cal);
    row.appendChild(main);

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:var(--text-dim);padding-left:2px;';
    sub.textContent = `${view.combo.items.length} ingredient(s) · P ${Math.round(view.totalProtein)}g · C ${Math.round(view.totalCarbs)}g · F ${Math.round(view.totalFat)}g`;
    row.appendChild(sub);

    row.addEventListener('click', () => openComboDetail(view.combo));
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

/* ----- Combo detail modal (§5d clean modal — image-2 layout) ----- */

const comboDetailExpanded = new Set<string>();

interface DetailIngredient {
  food: Food;
  amount: number;
  unit: 'g' | 'ml';
  nutrition: { calories: number; proteinG: number; carbsG: number; fatG: number };
}

async function openComboDetail(combo: Awaited<ReturnType<ComboRepository['getAllCombos']>>[number]) {
  const ingredients: DetailIngredient[] = [];
  for (const ci of combo.items) {
    const food = await resolveFoodCached(ci.food_id);
    if (!food) continue;
    const isMl = ci.amount_ml != null;
    const amount = ci.amount_g ?? ci.amount_ml ?? 100;
    const n = calculateNutrition(ctx.foodRepo.toFoodReference(food), amount);
    ingredients.push({ food, amount, unit: isMl ? 'ml' : 'g', nutrition: n });
  }

  const totals = ingredients.reduce(
    (acc, ing) => ({
      kcal: acc.kcal + ing.nutrition.calories,
      protein: acc.protein + ing.nutrition.proteinG,
      carbs: acc.carbs + ing.nutrition.carbsG,
      fat: acc.fat + ing.nutrition.fatG
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );

  const box = document.getElementById('combo-detail-box');
  if (!box) return;
  box.innerHTML = '';
  comboDetailExpanded.clear();

  // Header: name + added-date left, big kcal right (image 2).
  const head = document.createElement('div');
  head.className = 'cd-head';
  const titleWrap = document.createElement('div');
  titleWrap.style.minWidth = '0';
  const title = document.createElement('h3');
  title.className = 'cd-name';
  title.textContent = combo.name;
  titleWrap.appendChild(title);
  const time = document.createElement('div');
  time.className = 'cd-time';
  time.textContent = `Created ${formatCreatedLabel(combo.created_at)}`;
  titleWrap.appendChild(time);
  const kcalWrap = document.createElement('div');
  kcalWrap.style.cssText = 'text-align:right;flex:none;';
  const kcal = document.createElement('div');
  kcal.className = 'cd-kcal';
  kcal.textContent = String(Math.round(totals.kcal));
  const kcalUnit = document.createElement('div');
  kcalUnit.className = 'cd-unit';
  kcalUnit.textContent = 'KCAL';
  kcalWrap.append(kcal, kcalUnit);
  head.append(titleWrap, kcalWrap);
  box.appendChild(head);

  const macros = document.createElement('div');
  macros.className = 'cd-macros';
  macros.innerHTML = `
    <span style="color: var(--pro);">P: ${Math.round(totals.protein)}g</span>
    <span style="color: var(--text-dim);">·</span>
    <span style="color: var(--carb);">C: ${Math.round(totals.carbs)}g</span>
    <span style="color: var(--text-dim);">·</span>
    <span style="color: var(--fat);">F: ${Math.round(totals.fat)}g</span>
  `;
  box.appendChild(macros);

  const divider = document.createElement('div');
  divider.className = 'cd-divider';
  box.appendChild(divider);

  const bdTitle = document.createElement('div');
  bdTitle.className = 'combo-breakdown-title';
  bdTitle.style.marginBottom = '8px';
  bdTitle.textContent = 'Nourishment Breakdown';
  box.appendChild(bdTitle);

  const rebuild = () => renderComboDetailIngredients(box, ingredients, rebuild);

  renderComboDetailIngredients(box, ingredients, rebuild);

  // Totals — kcal + every macro (image 2 bottom).
  const totalsRow = document.createElement('div');
  totalsRow.className = 'cd-totals';
  const totalsLabel = document.createElement('span');
  totalsLabel.textContent = 'Total';
  const totalsKcal = document.createElement('span');
  totalsKcal.className = 'cd-total-kcal';
  totalsKcal.textContent = `${Math.round(totals.kcal)} kcal`;
  totalsRow.append(totalsLabel, totalsKcal);
  box.appendChild(totalsRow);

  const totalsMacros = document.createElement('div');
  totalsMacros.className = 'cd-macros';
  totalsMacros.style.justifyContent = 'flex-end';
  totalsMacros.innerHTML = `
    <span style="color: var(--pro);">P: ${Math.round(totals.protein)}g</span>
    <span style="color: var(--text-dim);">·</span>
    <span style="color: var(--carb);">C: ${Math.round(totals.carbs)}g</span>
    <span style="color: var(--text-dim);">·</span>
    <span style="color: var(--fat);">F: ${Math.round(totals.fat)}g</span>
  `;
  box.appendChild(totalsMacros);

  // Actions: primary Log All, then Close / Edit / Delete (all prior functionality kept).
  const logAll = document.createElement('button');
  logAll.className = 'btn-primary';
  logAll.style.marginTop = '14px';
  logAll.textContent = `Log All (${Math.round(totals.kcal)} kcal)`;
  logAll.addEventListener('click', () => logCombo(combo));
  box.appendChild(logAll);

  const actions = document.createElement('div');
  actions.className = 'cd-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'log-action-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => closeModalLayer('combo-detail-modal'));
  const editBtn = document.createElement('button');
  editBtn.className = 'log-action-btn blue';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    closeModalLayer('combo-detail-modal');
    openComboBuilderView(combo.id);
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'log-action-btn danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    const ok = await requestConfirmation(
      'Delete Combo',
      `Delete "${combo.name}" from the library? Logged meals are not affected.`
    );
    if (!ok) return;
    await ctx.comboRepo.deleteCombo(combo.id);
    openComboDetailId = null;
    invalidateIndexCaches();
    closeModalLayer('combo-detail-modal');
    await renderIndex();
    showToast(`Deleted combo "${combo.name}"`);
  });
  actions.append(closeBtn, editBtn, delBtn);
  box.appendChild(actions);

  openModalLayer('combo-detail-modal', () => {
    if (openComboDetailId === combo.id) openComboDetailId = null;
  });
}

function formatCreatedLabel(iso?: string): string {
  if (!iso) return 'earlier';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'earlier';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

/** Ingredient rows with inline expansion (tap → per-100g profile + provenance). */
function renderComboDetailIngredients(
  box: HTMLElement,
  ingredients: DetailIngredient[],
  rebuild: () => void
) {
  box.querySelectorAll('.cd-ing-list').forEach(el => el.remove());

  const anchor = box.querySelector('.combo-breakdown-title');
  const list = document.createElement('div');
  list.className = 'cd-ing-list';

  if (ingredients.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cd-empty-ing';
    empty.style.cssText = 'font-size:12px;color:var(--text-dim);padding:4px 2px;';
    empty.textContent = 'No valid ingredients left in this combo.';
    list.appendChild(empty);
  }

  for (const ing of ingredients) {
    const expanded = comboDetailExpanded.has(ing.food.id);
    const row = document.createElement('div');
    row.className = 'cd-ing' + (expanded ? ' expanded' : '');

    const line = document.createElement('div');
    line.className = 'cd-ing-line';
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;flex-direction:column;min-width:0;gap:2px;';
    const nm = document.createElement('span');
    nm.className = 'cd-ing-name';
    nm.textContent = ing.food.canonical_name;
    const mac = document.createElement('span');
    mac.className = 'cd-ing-sub';
    mac.innerHTML = `
      ${fmt1(ing.amount)}${ing.unit} ·
      <span style="color: var(--pro);">P: ${Math.round(ing.nutrition.proteinG)}g</span>
      · <span style="color: var(--carb);">C: ${Math.round(ing.nutrition.carbsG)}g</span>
      · <span style="color: var(--fat);">F: ${Math.round(ing.nutrition.fatG)}g</span>
    `;
    left.append(nm, mac);
    const kcalEl = document.createElement('span');
    kcalEl.className = 'cd-ing-kcal';
    kcalEl.textContent = `${Math.round(ing.nutrition.calories)} kcal`;
    line.append(left, kcalEl);
    row.appendChild(line);

    if (expanded) {
      const extra = document.createElement('div');
      extra.className = 'cd-ing-extra';
      extra.textContent =
        `Per 100 ${ing.unit}: ${Math.round(ing.food.calories_per_100g || 0)} kcal · ` +
        `P ${fmt1(ing.food.protein_per_100g)} · C ${fmt1(ing.food.carbs_per_100g)} · F ${fmt1(ing.food.fat_per_100g)}` +
        (ing.food.water_per_100g ? ` · water ${fmt1(ing.food.water_per_100g)} ml` : '') +
        ` · ${confidenceLabel(ing.food.confidence, ing.food.source_type)} (${ing.food.source_type})`;
      row.appendChild(extra);
    }

    row.addEventListener('click', () => {
      if (comboDetailExpanded.has(ing.food.id)) comboDetailExpanded.delete(ing.food.id);
      else comboDetailExpanded.add(ing.food.id);
      rebuild();
    });

    list.appendChild(row);
  }

  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(list, anchor.nextSibling);
  else box.insertBefore(list, box.firstChild);
}
