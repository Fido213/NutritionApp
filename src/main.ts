import { DatabaseManager } from '@data/database';
import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { GoalRepository } from '@data/repositories/goal.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { DailyRecordRepository } from '@data/repositories/daily-record.repo';
import { ComboRepository } from '@data/repositories/combo.repo';
import { BarcodeRepository } from '@data/repositories/barcode.repo';
import { ObservationRepository } from '@data/repositories/observation.repo';
import { ImportRepository } from '@data/repositories/import.repo';
import { Food } from '@data/types';

import { store } from './ui/state';
import { renderDashboard } from './ui/views/dashboard';
import { renderHistory } from './ui/views/history';
import { renderGoals, readGoalsForm } from './ui/views/goals';
import { showToast } from './ui/components/toast';
import { calculateEffectiveHydration, classifyWaterSource } from '@domain/hydration';
import { calculateScore } from '@domain/scoring';
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName } from '@domain/logging';
import { getTodayDateString, getDateRange, formatDateISO } from '@utils/dates';
import { generateCSV, downloadCSV } from '@services/export/csv-export';
import { parseCSV } from '@services/import/csv-import';
import { createBackupArchive, downloadBackup, parseBackupArchive, restoreBackupArchive, validateBackupArchive } from '@services/backup/backup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '@services/backup/encryption';
import { GemmaClient } from '@services/ai/gemma-client';
import { FoodService } from '@services/food/food-service';
import { GoalTargets } from '@domain/types';

let dbManager: DatabaseManager;
let foodRepo: FoodRepository;
let logRepo: LogRepository;
let goalRepo: GoalRepository;
let waterRepo: WaterRepository;
let dailyRecordRepo: DailyRecordRepository;
let comboRepo: ComboRepository;
let barcodeRepo: BarcodeRepository;
let observationRepo: ObservationRepository;
let importRepo: ImportRepository;
let gemmaClient: GemmaClient;
let foodService: FoodService;

let scoresByDate = new Map<string, number>();
let lastComputedScoreDate = '';
let numpadBuffer = '';

async function initApp() {
  console.log('Initializing EverydayFuel...');

  try {
    // 1. Initialize SQLite Database
    dbManager = DatabaseManager.getInstance();
    await dbManager.initialize();
    const db = await dbManager.getConnection();

    foodRepo = new FoodRepository(db);
    logRepo = new LogRepository(db);
    goalRepo = new GoalRepository(db);
    waterRepo = new WaterRepository(db);
    dailyRecordRepo = new DailyRecordRepository(db);
    comboRepo = new ComboRepository(db);
    barcodeRepo = new BarcodeRepository(db);
    observationRepo = new ObservationRepository(db);
    importRepo = new ImportRepository(db);
    gemmaClient = new GemmaClient();
    foodService = new FoodService(foodRepo, logRepo, observationRepo, waterRepo);

    console.log('SQLite database ready', { dailyRecordRepo, comboRepo, barcodeRepo });

    // 2. Load active goal
    let currentGoal = await goalRepo.getCurrentGoal();
    if (!currentGoal) {
      currentGoal = await goalRepo.createGoal({
        name: 'Initial Goal',
        start_date: getTodayDateString(),
        end_date: null,
        calories_target: 2500,
        protein_target: 150,
        carbs_target: 250,
        fat_target: 80,
        water_target: 4000
      });
    }

    // 3. Subscribe store listeners to re-render views
    store.subscribe(() => {
      renderDashboard();
      renderGoals();
    });

    // 4. Load initial state for selected date
    await refreshStateForDate(getTodayDateString());

    // 5. Setup UI Event Listeners & Navigation
    setupNavigation();
    setupModals();
    setupDialogModals();
    setupActionHandlers();
    setupJournalHandlers();
    setupNumpadHandlers();
    setupScannerHandlers();
    setupActionHubHandlers();
    setupEditModalHandlers();
    setupImportHandlers();
    setupBackupHandler();
    setupRestoreHandler();

    showToast('EverydayFuel loaded (Local SQLite)', 2500);

  } catch (err) {
    console.error('App init failed:', err);
    showToast('Offline Mode: Web storage fallback');
  }
}

function mapGoalToTargets(g: any): GoalTargets {
  return {
    caloriesTarget: g.calories_target ?? g.caloriesTarget ?? 2500,
    proteinTarget: g.protein_target ?? g.proteinTarget ?? 150,
    carbsTarget: g.carbs_target ?? g.carbsTarget ?? 250,
    fatTarget: g.fat_target ?? g.fatTarget ?? 80,
    waterTarget: g.water_target ?? g.waterTarget ?? 4000
  };
}

async function refreshStateForDate(dateStr: string) {
  const goalRecord = await goalRepo.getGoalForDate(dateStr);
  const goal: GoalTargets = goalRecord 
    ? mapGoalToTargets(goalRecord)
    : { caloriesTarget: 2500, proteinTarget: 150, carbsTarget: 250, fatTarget: 80, waterTarget: 4000 };

  const totals = await logRepo.getDailyTotals(dateStr);
  const waterTotals = await waterRepo.getWaterTotalsBySource(dateStr);

  const hydration = calculateEffectiveHydration(
    waterTotals.explicit,
    waterTotals.drink,
    waterTotals.food,
    goal.waterTarget
  );

  const score = calculateScore(totals, goal, hydration);

  const logs = await logRepo.getLogsForDate(dateStr);
  const recents = await foodRepo.fuzzySearch('', 5);

  store.setState({
    selectedDate: dateStr,
    todayTotals: totals,
    todayGoals: goal,
    todayHydration: hydration,
    todayLogs: logs,
    recents,
    currentScore: score
  });

  await ensureScoresForDate(dateStr);
  renderHistory(logs, scoresByDate);
}

/**
 * Compute the daily consistency score for every date in the range ending at endDate.
 * Scores are derived on demand from logs + goals and are never stored as a second dataset.
 */
async function computeScoresForRange(endDate: string, days: number = 28): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const defaults: GoalTargets = { caloriesTarget: 2500, proteinTarget: 150, carbsTarget: 250, fatTarget: 80, waterTarget: 4000 };

  for (const date of getDateRange(endDate, days)) {
    const goalRecord = await goalRepo.getGoalForDate(date);
    const targets = goalRecord ? mapGoalToTargets(goalRecord) : defaults;
    const totals = await logRepo.getDailyTotals(date);
    const water = await waterRepo.getWaterTotalsBySource(date);
    const hydration = calculateEffectiveHydration(water.explicit, water.drink, water.food, targets.waterTarget);
    scores.set(date, calculateScore(totals, targets, hydration).score);
  }

  return scores;
}

async function ensureScoresForDate(dateStr: string) {
  if (lastComputedScoreDate !== dateStr) {
    scoresByDate = await computeScoresForRange(dateStr, 28);
    lastComputedScoreDate = dateStr;
  }
}

function setupNavigation() {
  const dashBtn = document.getElementById('nav-btn-dash');
  const logsBtn = document.getElementById('nav-btn-logs');
  const sysBtn = document.getElementById('sys-btn-top');

  const todayView = document.getElementById('today');
  const historyView = document.getElementById('history');
  const goalsView = document.getElementById('view-goals');

  function switchTab(viewId: string) {
    [todayView, historyView, goalsView].forEach(v => v?.classList.remove('active-view'));
    [dashBtn, logsBtn].forEach(b => b?.classList.remove('active'));

    if (viewId === 'today') {
      todayView?.classList.add('active-view');
      dashBtn?.classList.add('active');
    } else if (viewId === 'history') {
      historyView?.classList.add('active-view');
      logsBtn?.classList.add('active');
      ensureScoresForDate(store.getState().selectedDate).then(() => {
        renderHistory(store.getState().todayLogs, scoresByDate);
      });
    } else if (viewId === 'view-goals') {
      goalsView?.classList.add('active-view');
    }
  }

  dashBtn?.addEventListener('click', () => switchTab('today'));
  logsBtn?.addEventListener('click', () => switchTab('history'));
  sysBtn?.addEventListener('click', () => switchTab('view-goals'));
}

function setupModals() {
  const openModal = (id: string) => document.getElementById(id)?.classList.add('active');
  const closeModal = (id: string) => document.getElementById(id)?.classList.remove('active');

  document.getElementById('btn-water-250')?.addEventListener('click', async () => {
    const date = store.getState().selectedDate;
    await waterRepo.insertWaterLog({ date, amount_ml: 250, source: 'explicit' });
    await refreshStateForDate(date);
    showToast('Logged +250ml Water');
  });

  document.getElementById('btn-water-500')?.addEventListener('click', async () => {
    const date = store.getState().selectedDate;
    await waterRepo.insertWaterLog({ date, amount_ml: 500, source: 'explicit' });
    await refreshStateForDate(date);
    showToast('Logged +500ml Water');
  });

  document.getElementById('btn-water-custom')?.addEventListener('click', () => openModal('numpad-modal'));
  document.getElementById('numpad-close')?.addEventListener('click', () => closeModal('numpad-modal'));

  document.getElementById('btn-open-journal')?.addEventListener('click', () => openModal('journal-modal'));
  document.getElementById('btn-close-journal')?.addEventListener('click', () => closeModal('journal-modal'));

  document.getElementById('btn-open-manual')?.addEventListener('click', () => openModal('manual-log-modal'));
  document.getElementById('btn-close-manual')?.addEventListener('click', () => closeModal('manual-log-modal'));

  document.getElementById('scan-btn')?.addEventListener('click', () => openModal('scanner-modal'));
  document.getElementById('btn-close-scanner')?.addEventListener('click', () => closeModal('scanner-modal'));

  document.getElementById('hub-btn-close')?.addEventListener('click', () => closeModal('action-hub-modal'));
  document.getElementById('btn-close-edit')?.addEventListener('click', () => closeModal('edit-modal'));
}

function setupActionHandlers() {
  document.getElementById('btn-save-goals')?.addEventListener('click', async () => {
    const newGoals = readGoalsForm();
    await goalRepo.createGoal({
      name: 'Updated Goal',
      start_date: getTodayDateString(),
      end_date: null,
      calories_target: newGoals.caloriesTarget,
      protein_target: newGoals.proteinTarget,
      carbs_target: newGoals.carbsTarget,
      fat_target: newGoals.fatTarget,
      water_target: newGoals.waterTarget
    });
    await refreshStateForDate(store.getState().selectedDate);
    showToast('Goal configuration saved!');
  });

  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const state = store.getState();
    const row = {
      date: state.selectedDate,
      goalName: 'Active Phase',
      ...state.todayGoals,
      caloriesActual: state.todayTotals.calories,
      proteinActual: state.todayTotals.proteinG,
      carbsActual: state.todayTotals.carbsG,
      fatActual: state.todayTotals.fatG,
      explicitWaterMl: state.todayHydration.explicit,
      drinkWaterMl: state.todayHydration.drink,
      foodWaterMl: state.todayHydration.food,
      effectiveWaterMl: state.todayHydration.effectiveTotal,
      scoreTier: state.currentScore?.scoreTier || 'neutral',
      scoreCode: state.currentScore?.scoreCode || '0',
      scoreResult: state.currentScore?.result || '',
      scoreReason: state.currentScore?.reason || '',
      lowAccuracy: false,
      dailyNote: ''
    };

    const csv = generateCSV([row]);
    downloadCSV(`EverydayFuel_Export_${getTodayDateString()}.csv`, csv);
    showToast('Exported CSV file');
  });

  document.getElementById('btn-save-manual')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('manual-name') as HTMLInputElement;
    const calInput = document.getElementById('manual-cal') as HTMLInputElement;
    const proInput = document.getElementById('manual-pro') as HTMLInputElement;
    const carbInput = document.getElementById('manual-carb') as HTMLInputElement;
    const fatInput = document.getElementById('manual-fat') as HTMLInputElement;
    const amtInput = document.getElementById('manual-amount') as HTMLInputElement;
    const noteInput = document.getElementById('manual-note') as HTMLInputElement;

    const name = nameInput?.value.trim() || 'Manual Entry';
    const calories = parseFloat(calInput?.value) || 0;
    const proteinG = parseFloat(proInput?.value) || 0;
    const carbsG = parseFloat(carbInput?.value) || 0;
    const fatG = parseFloat(fatInput?.value) || 0;
    const amountG = parseFloat(amtInput?.value) || 100;
    const note = noteInput?.value.trim();

    const food = await foodRepo.insert({
      canonical_name: name,
      normalized_name: name.toLowerCase(),
      calories_per_100g: (calories / amountG) * 100,
      protein_per_100g: (proteinG / amountG) * 100,
      carbs_per_100g: (carbsG / amountG) * 100,
      fat_per_100g: (fatG / amountG) * 100,
      water_per_100g: 0,
      nutrition_basis: 'per_100g',
      source_type: 'user_entered',
      confidence: 1.0
    });

    const date = store.getState().selectedDate;
    await logRepo.insertFoodLog({
      date,
      food_id: food.id,
      amount_g: amountG,
      calories,
      protein_g: proteinG,
      carbs_g: carbsG,
      fat_g: fatG,
      note
    });

    document.getElementById('manual-log-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast(`Logged "${name}" (${Math.round(calories)} kcal)`);
  });

  window.addEventListener('select-history-date', (e: any) => {
    const dateStr = e.detail;
    refreshStateForDate(dateStr);
  });

  window.addEventListener('quick-log-recent', (e: any) => {
    const item = e.detail;
    if (item?.id) quickLogFood(item.id);
  });
}

// ---------- Text Logging (Gemma interpretation -> FoodService pipeline) ----------

function isTextLogInput(text: string): boolean {
  return /\d+\s*(g|ml|grams|milliliters)/i.test(text) || /[,+&]| and /i.test(text);
}

async function logTextInput(rawText: string) {
  const date = store.getState().selectedDate;
  const items = await gemmaClient.interpretTextLog(rawText);

  if (!items || items.length === 0) {
    showToast('Could not interpret that text');
    return;
  }

  const results = await foodService.logTextInput(date, rawText, items);
  const totalCal = results.reduce((sum, r) => sum + r.nutrition.calories, 0);

  document.getElementById('journal-modal')?.classList.remove('active');
  const searchInput = document.getElementById('journal-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';

  await refreshStateForDate(date);
  showToast(`Logged ${results.length} item(s) · ${Math.round(totalCal)} kcal`);
}

// ---------- Journal Search & Quick-Log ----------

function renderJournalResults(foods: Food[]) {
  const container = document.getElementById('journal-results');
  if (!container) return;
  container.innerHTML = '';

  if (!foods || foods.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--text-dim)';
    empty.style.fontSize = '13px';
    empty.style.padding = '10px';
    empty.style.textAlign = 'center';
    empty.innerText = 'No foods found. Press Enter to log text like "250g chicken, 100g rice".';
    container.appendChild(empty);
    return;
  }

  foods.forEach(food => {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.dataset.foodId = food.id;

    const main = document.createElement('div');
    main.className = 'log-main';

    const name = document.createElement('span');
    name.className = 'log-name';
    name.innerText = food.canonical_name;

    const cal = document.createElement('span');
    cal.className = 'log-cal';
    cal.innerText = food.calories_per_100g ? `${Math.round(food.calories_per_100g)} kcal/100g` : 'no data';

    main.appendChild(name);
    main.appendChild(cal);
    item.appendChild(main);
    container.appendChild(item);
  });
}

async function quickLogFood(foodId: string) {
  const food = await foodRepo.findById(foodId);
  if (!food) {
    showToast('Food not found in library');
    return;
  }

  const ref = foodRepo.toFoodReference(food);
  const nutrition = calculateNutrition(ref, 100);
  const date = store.getState().selectedDate;

  const log = await logRepo.insertFoodLog({
    date,
    food_id: food.id,
    amount_g: 100,
    calories: nutrition.calories,
    protein_g: nutrition.proteinG,
    carbs_g: nutrition.carbsG,
    fat_g: nutrition.fatG,
    water_ml: nutrition.waterMl
  });

  if (nutrition.waterMl !== null && nutrition.waterMl > 0) {
    await waterRepo.insertWaterLog({
      date,
      amount_ml: nutrition.waterMl,
      source: classifyWaterSource(ref),
      food_log_id: log.id
    });
  }

  await refreshStateForDate(date);
  showToast(`Logged ${food.canonical_name} · ${Math.round(nutrition.calories)} kcal`);
}

function setupJournalHandlers() {
  const searchInput = document.getElementById('journal-search') as HTMLInputElement | null;

  searchInput?.addEventListener('input', async () => {
    const query = searchInput.value.trim();
    const results = await foodRepo.fuzzySearch(query, 20);
    renderJournalResults(results);
  });

  searchInput?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = searchInput.value.trim();
    if (!text) return;

    if (isTextLogInput(text)) {
      await logTextInput(text);
    } else {
      const results = await foodRepo.fuzzySearch(text, 20);
      renderJournalResults(results);
    }
  });

  document.getElementById('journal-results')?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.log-item') as HTMLElement | null;
    if (!target?.dataset.foodId) return;
    document.getElementById('journal-modal')?.classList.remove('active');
    const input = document.getElementById('journal-search') as HTMLInputElement | null;
    if (input) input.value = '';
    quickLogFood(target.dataset.foodId);
  });
}

// ---------- Numpad Custom Water ----------

function setupNumpadHandlers() {
  const display = document.getElementById('numpad-display');
  const updateDisplay = () => {
    if (display) display.innerText = numpadBuffer || '0';
  };

  document.querySelectorAll('.numpad-grid button[data-val]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = (btn as HTMLElement).dataset.val;
      if (val !== undefined && numpadBuffer.length < 6) numpadBuffer += val;
      updateDisplay();
    });
  });

  document.getElementById('numpad-del')?.addEventListener('click', () => {
    numpadBuffer = numpadBuffer.slice(0, -1);
    updateDisplay();
  });

  document.getElementById('numpad-enter')?.addEventListener('click', async () => {
    const amount = parseInt(numpadBuffer, 10);
    numpadBuffer = '';
    updateDisplay();

    if (!amount || amount <= 0) {
      showToast('Enter a valid water amount');
      return;
    }

    const date = store.getState().selectedDate;
    await waterRepo.insertWaterLog({ date, amount_ml: amount, source: 'explicit' });
    document.getElementById('numpad-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast(`Logged +${amount}ml Water`);
  });
}

// ---------- In-App Dialogs (WebView-safe replacement for window.prompt/confirm) ----------

let passwordPromptResolver: ((value: string | null) => void) | null = null;
let confirmPromptResolver: ((value: boolean) => void) | null = null;
let pwRequireConfirm = false;

function setupDialogModals() {
  document.getElementById('btn-pw-ok')?.addEventListener('click', () => {
    const pwEl = document.getElementById('pw-input') as HTMLInputElement | null;
    const confirmEl = document.getElementById('pw-confirm') as HTMLInputElement | null;
    const errorEl = document.getElementById('pw-error');
    const pw = pwEl?.value || '';

    if (!pw) {
      if (errorEl) errorEl.innerText = 'Password must not be empty';
      return;
    }
    if (pwRequireConfirm && confirmEl && confirmEl.value !== pw) {
      if (errorEl) errorEl.innerText = 'Passwords do not match';
      return;
    }

    document.getElementById('password-modal')?.classList.remove('active');
    const resolve = passwordPromptResolver;
    passwordPromptResolver = null;
    resolve?.(pw);
  });

  document.getElementById('btn-pw-cancel')?.addEventListener('click', () => {
    document.getElementById('password-modal')?.classList.remove('active');
    const resolve = passwordPromptResolver;
    passwordPromptResolver = null;
    resolve?.(null);
  });

  document.getElementById('pw-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (pwRequireConfirm) {
      (document.getElementById('pw-confirm') as HTMLInputElement | null)?.focus();
    } else {
      (document.getElementById('btn-pw-ok') as HTMLButtonElement | null)?.click();
    }
  });

  document.getElementById('pw-confirm')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('btn-pw-ok') as HTMLButtonElement | null)?.click();
  });

  document.getElementById('btn-confirm-ok')?.addEventListener('click', () => {
    document.getElementById('confirm-modal')?.classList.remove('active');
    const resolve = confirmPromptResolver;
    confirmPromptResolver = null;
    resolve?.(true);
  });

  document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => {
    document.getElementById('confirm-modal')?.classList.remove('active');
    const resolve = confirmPromptResolver;
    confirmPromptResolver = null;
    resolve?.(false);
  });
}

function requestPassword(title: string, requireConfirm: boolean): Promise<string | null> {
  pwRequireConfirm = requireConfirm;

  const titleEl = document.getElementById('pw-title');
  const pwEl = document.getElementById('pw-input') as HTMLInputElement | null;
  const confirmEl = document.getElementById('pw-confirm') as HTMLInputElement | null;
  const errorEl = document.getElementById('pw-error');

  if (titleEl) titleEl.innerText = title;
  if (pwEl) pwEl.value = '';
  if (confirmEl) {
    confirmEl.value = '';
    confirmEl.hidden = !requireConfirm;
  }
  if (errorEl) errorEl.innerText = '';

  document.getElementById('password-modal')?.classList.add('active');
  pwEl?.focus();

  return new Promise(resolve => { passwordPromptResolver = resolve; });
}

function requestConfirmation(title: string, message: string): Promise<boolean> {
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;

  document.getElementById('confirm-modal')?.classList.add('active');
  return new Promise(resolve => { confirmPromptResolver = resolve; });
}

// ---------- Scanner / Barcode ----------

function setupScannerHandlers() {
  const barcodeInput = document.getElementById('barcode-input') as HTMLInputElement | null;

  const doBarcodeLookup = async () => {
    const code = (barcodeInput?.value || '').trim();
    if (!code) {
      showToast('Enter a barcode number first');
      return;
    }

    const food = await barcodeRepo.lookupBarcode(code);
    if (!food) {
      showToast('Barcode not found in local library');
      document.getElementById('scanner-modal')?.classList.remove('active');
      document.getElementById('manual-log-modal')?.classList.add('active');
      return;
    }

    const ref = foodRepo.toFoodReference(food);
    const nutrition = calculateNutrition(ref, 100);
    const date = store.getState().selectedDate;

    const log = await logRepo.insertFoodLog({
      date,
      food_id: food.id,
      amount_g: 100,
      calories: nutrition.calories,
      protein_g: nutrition.proteinG,
      carbs_g: nutrition.carbsG,
      fat_g: nutrition.fatG,
      water_ml: nutrition.waterMl
    });

    if (nutrition.waterMl !== null && nutrition.waterMl > 0) {
      await waterRepo.insertWaterLog({
        date,
        amount_ml: nutrition.waterMl,
        source: classifyWaterSource(ref),
        food_log_id: log.id
      });
    }

    if (barcodeInput) barcodeInput.value = '';
    document.getElementById('scanner-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast(`Logged ${food.canonical_name} · ${Math.round(nutrition.calories)} kcal`);
  };

  document.getElementById('btn-decode-barcode')?.addEventListener('click', doBarcodeLookup);
  barcodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doBarcodeLookup();
  });

  document.getElementById('btn-decode-label')?.addEventListener('click', () => {
    document.getElementById('ai-file-input')?.click();
  });

  document.getElementById('ai-file-input')?.addEventListener('change', (e) => {
    (e.target as HTMLInputElement).value = '';
    showToast('Image label OCR needs the native ML Kit integration — paste the label text below instead');
  });

  document.getElementById('btn-parse-label-text')?.addEventListener('click', async () => {
    const textEl = document.getElementById('label-ocr-text') as HTMLTextAreaElement | null;
    const amountEl = document.getElementById('label-amount') as HTMLInputElement | null;
    const text = (textEl?.value || '').trim();
    const amount = parseFloat(amountEl?.value || '') || 100;

    if (!text) {
      showToast('Paste nutrition label text first');
      return;
    }

    const ocr = await gemmaClient.parseNutritionLabel(text);
    const date = store.getState().selectedDate;

    try {
      const result = await foodService.logLabelOcr(date, ocr, amount);
      if (textEl) textEl.value = '';
      document.getElementById('scanner-modal')?.classList.remove('active');
      await refreshStateForDate(date);
      showToast(`Logged "${ocr.foodName}" · ${Math.round(result.nutrition.calories)} kcal`);
    } catch (err) {
      console.error('Label OCR logging failed:', err);
      showToast('Could not parse that label text');
    }
  });
}

// ---------- Action Hub (Edit / Duplicate / Delete) ----------

function setupActionHubHandlers() {
  window.addEventListener('open-log-actions', (e: any) => {
    const log = e.detail;
    if (!log?.id) return;
    store.setState({ selectedLogForAction: log });
    document.getElementById('action-hub-modal')?.classList.add('active');
  });

  document.getElementById('hub-btn-edit')?.addEventListener('click', openEditModal);

  document.getElementById('hub-btn-duplicate')?.addEventListener('click', async () => {
    const log = store.getState().selectedLogForAction;
    if (!log) return;
    const date = store.getState().selectedDate;
    await logRepo.duplicateLog(log.id, date);
    document.getElementById('action-hub-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast('Log duplicated');
  });

  document.getElementById('hub-btn-delete')?.addEventListener('click', async () => {
    const log = store.getState().selectedLogForAction;
    if (!log) return;
    await logRepo.deleteLog(log.id);
    store.setState({ selectedLogForAction: null });
    document.getElementById('action-hub-modal')?.classList.remove('active');
    await refreshStateForDate(store.getState().selectedDate);
    showToast('Log deleted');
  });
}

// ---------- Edit Modal ----------

async function openEditModal() {
  const log = store.getState().selectedLogForAction;
  if (!log) return;

  const food = log.food_id ? await foodRepo.findById(log.food_id) : null;
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

  document.getElementById('action-hub-modal')?.classList.remove('active');
  document.getElementById('edit-modal')?.classList.add('active');
}

function setupEditModalHandlers() {
  document.getElementById('btn-save-edit')?.addEventListener('click', async () => {
    const idEl = document.getElementById('edit-log-id') as HTMLInputElement | null;
    const logId = idEl?.value;
    if (!logId) return;

    const read = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value || '';
    const name = read('edit-name').trim() || 'Logged Item';
    const date = read('edit-date') || store.getState().selectedDate;
    const note = read('edit-note').trim() || null;

    const baseAmount = parseFloat(read('base-amount')) || 100;
    const eatenAmount = parseFloat(read('eaten-amount')) || 0;
    const baseCal = parseFloat(read('base-cal')) || 0;
    const basePro = parseFloat(read('base-pro')) || 0;
    const baseCarb = parseFloat(read('base-carb')) || 0;
    const baseFat = parseFloat(read('base-fat')) || 0;

    // Amount multiplier: scale the stored base macros to the new eaten amount
    const multiplier = baseAmount > 0 && eatenAmount > 0 ? eatenAmount / baseAmount : 1;
    const calories = Math.round(baseCal * multiplier);
    const proteinG = Math.round(basePro * multiplier);
    const carbsG = Math.round(baseCarb * multiplier);
    const fatG = Math.round(baseFat * multiplier);

    const current = await logRepo.findById(logId);
    if (!current) {
      showToast('Log not found');
      return;
    }

    let foodId = current.food_id;
    const currentFood = current.food_id ? await foodRepo.findById(current.food_id) : null;
    if (currentFood && name !== currentFood.canonical_name) {
      let renamed = await foodRepo.findByNormalizedName(normalizeFoodName(name));
      if (!renamed) {
        const refAmount = current.amount_g || current.amount_ml || 100;
        renamed = await foodRepo.insert({
          canonical_name: name,
          normalized_name: normalizeFoodName(name),
          calories_per_100g: refAmount > 0 ? (current.calories / refAmount) * 100 : null,
          protein_per_100g: refAmount > 0 ? (current.protein_g / refAmount) * 100 : null,
          carbs_per_100g: refAmount > 0 ? (current.carbs_g / refAmount) * 100 : null,
          fat_per_100g: refAmount > 0 ? (current.fat_g / refAmount) * 100 : null,
          water_per_100g: 0,
          nutrition_basis: 'per_100g',
          source_type: 'user_entered',
          confidence: 1.0
        });
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

    await logRepo.updateLog(logId, updates);
    document.getElementById('edit-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast('Log updated');
  });
}

// ---------- CSV Import ----------

function setupImportHandlers() {
  document.getElementById('btn-import-csv')?.addEventListener('click', () => {
    document.getElementById('csv-file-input')?.click();
  });

  document.getElementById('csv-file-input')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    const { rows, errors } = parseCSV(text);

    if (rows.length === 0) {
      showToast(errors[0] || 'CSV import failed');
      return;
    }

    let inserted = 0;
    for (const row of rows) {
      const date = formatDateISO(row.date);
      const normalized = normalizeFoodName(row.foodName);
      let food = await foodRepo.findByNormalizedName(normalized);

      if (!food) {
        const refAmount = row.amountG || 100;
        food = await foodRepo.insert({
          canonical_name: row.foodName,
          normalized_name: normalized,
          calories_per_100g: refAmount > 0 ? (row.calories / refAmount) * 100 : 0,
          protein_per_100g: refAmount > 0 ? (row.proteinG / refAmount) * 100 : 0,
          carbs_per_100g: refAmount > 0 ? (row.carbsG / refAmount) * 100 : 0,
          fat_per_100g: refAmount > 0 ? (row.fatG / refAmount) * 100 : 0,
          water_per_100g: 0,
          nutrition_basis: 'per_100g',
          source_type: 'imported',
          confidence: 1.0
        });
      }

      const log = await logRepo.insertFoodLog({
        date,
        food_id: food.id,
        amount_g: row.amountG || 100,
        calories: row.calories,
        protein_g: row.proteinG,
        carbs_g: row.carbsG,
        fat_g: row.fatG,
        water_ml: row.waterMl ?? null
      });

      if (row.waterMl) {
        await waterRepo.insertWaterLog({
          date,
          amount_ml: row.waterMl,
          source: 'explicit',
          food_log_id: log.id
        });
      }

      inserted++;
    }

    await importRepo.recordImport({
      source_type: 'csv',
      filename: file.name,
      status: errors.length > 0 ? 'partial' : 'completed',
      row_count: rows.length,
      error_count: errors.length
    });

    input.value = '';
    await refreshStateForDate(store.getState().selectedDate);
    showToast(`Imported ${inserted} rows${errors.length > 0 ? ` (${errors.length} skipped)` : ''}`);
  });
}

// ---------- Backup ----------

function setupBackupHandler() {
  document.getElementById('btn-backup')?.addEventListener('click', async () => {
    const tables = [
      'foods', 'food_aliases', 'food_barcodes', 'food_observations', 'food_logs',
      'water_logs', 'combos', 'combo_items', 'daily_records', 'goals', 'app_settings', 'imports'
    ];

    const db = await dbManager.getConnection();
    const data: Record<string, any[]> = {};

    for (const table of tables) {
      const res = await db.query(`SELECT * FROM ${table}`);
      data[table] = res.values || [];
    }

    const archive = createBackupArchive(data);

    const password = await requestPassword('Set Backup Password', true);
    if (password === null) {
      showToast('Backup cancelled');
      return;
    }

    try {
      const encrypted = await encryptBackup(archive, password);
      downloadBackup(`EverydayFuel_Backup_${getTodayDateString()}.json`, encrypted);
      showToast('Encrypted backup archive exported');
    } catch (err) {
      console.error('Encryption failed:', err);
      showToast('Backup failed — could not encrypt');
    }
  });
}

// ---------- Restore from Backup ----------

function setupRestoreHandler() {
  document.getElementById('btn-restore')?.addEventListener('click', () => {
    document.getElementById('restore-file-input')?.click();
  });

  document.getElementById('restore-file-input')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();

    let backupText = text;
    if (isEncryptedBackup(text)) {
      const password = await requestPassword('Enter Backup Password', false);
      if (password === null) {
        input.value = '';
        return;
      }
      const decrypted = await decryptBackup(text, password);
      if (decrypted === null) {
        showToast('Wrong password or corrupted backup');
        input.value = '';
        return;
      }
      backupText = decrypted;
    }

    const archive = parseBackupArchive(backupText);
    if (!archive) {
      showToast('Invalid backup archive');
      input.value = '';
      return;
    }

    const validationErrors = validateBackupArchive(archive);
    if (validationErrors.length > 0) {
      showToast(validationErrors[0]);
      input.value = '';
      return;
    }

    const confirmed = await requestConfirmation(
      'Restore Backup',
      'Restore this backup? All current local data will be replaced.'
    );
    if (!confirmed) {
      input.value = '';
      return;
    }

    try {
      if (dbManager.isFallback()) {
        dbManager.replaceFallbackStore(archive.data);
      } else {
        const db = await dbManager.getConnection();
        const result = await restoreBackupArchive(db, archive);
        if (!result.ok) {
          showToast(result.errors[0] || 'Restore failed');
          input.value = '';
          return;
        }
      }

      lastComputedScoreDate = '';
      const date = store.getState().selectedDate;
      await refreshStateForDate(date);
      const rowCount = Object.values(archive.data).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
      showToast(`Restored backup · ${rowCount} rows`);
    } catch (err) {
      console.error('Restore failed:', err);
      showToast('Restore failed — check the backup file');
    } finally {
      input.value = '';
    }
  });
}

document.addEventListener('DOMContentLoaded', initApp);
