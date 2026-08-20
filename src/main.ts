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
import { renderHistory, HistoryViewMode } from './ui/views/history';
import { renderGoals, readGoalsForm } from './ui/views/goals';
import { showToast } from './ui/components/toast';
import { calculateEffectiveHydration, classifyWaterSource } from '@domain/hydration';
import { calculateScore } from '@domain/scoring';
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName } from '@domain/logging';
import { getTodayDateString, formatDateISO } from '@utils/dates';
import { generateCSV, downloadCSV } from '@services/export/csv-export';
import { buildExportRows, datesBetween, goalPhaseRange, resolveExportDateRange, ExportRepos } from '@services/export/export-service';
import { parseCSV } from '@services/import/csv-import';
import { createBackupArchive, downloadBackup, parseBackupArchive, restoreBackupArchive, validateBackupArchive, collectAllTables } from '@services/backup/backup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '@services/backup/encryption';
import { GemmaClient } from '@services/ai/gemma-client';
import { FoodService } from '@services/food/food-service';
import { P2PTransferService } from '@services/transfer/transfer';
import { WebRTCTransport, DEFAULT_ICE_SERVERS } from '@services/transfer/webrtc-transport';
import { TransferPeer } from '@services/transfer/transport';
import { GoalTargets } from '@domain/types';
import { computeHistoryWindow, datesForRange, datesForMonth, datesForYear, mapGoalToTargets, HistoryDay } from '@services/history/history-window';
import { renderPairingCodeAsQR, supportsQrScanning, startQrScan } from '@services/transfer/qr-code';
import type { QrScanHandle } from '@services/transfer/qr-code';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { getVisionPlugin, stripDataUrlPrefix, supportsBrowserBarcodeScan, startBrowserBarcodeScan } from '@services/vision/vision-client';
import type { ScanHandle } from '@services/vision/vision-client';
import { lookupBarcodeOnline } from '@services/barcode/online-lookup';

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
let p2pService: P2PTransferService;
let p2pTransport: WebRTCTransport;

let historyWindow = new Map<string, HistoryDay>();
let historyView: HistoryViewMode = 'week';
let historyAnchor = getTodayDateString();
let historyWindowKey = '';
let numpadBuffer = '';

function loadP2PIceServers(): RTCIceServer[] {
  const servers = [...DEFAULT_ICE_SERVERS];
  try {
    const saved = localStorage.getItem('everydayfuel_p2p_turn');
    if (saved) {
      const cfg = JSON.parse(saved);
      const url = String(cfg.url || '').trim();
      if (/^turn(s)?:/i.test(url)) {
        servers.push({
          urls: url,
          username: String(cfg.username || '') || undefined,
          credential: String(cfg.password || '') || undefined
        });
      }
    }
  } catch {
    /* invalid saved config -> defaults only */
  }
  return servers;
}

function saveP2PTurnConfig(url: string, username: string, password: string) {
  if (!url.trim()) {
    localStorage.removeItem('everydayfuel_p2p_turn');
    return;
  }
  localStorage.setItem('everydayfuel_p2p_turn', JSON.stringify({ url: url.trim(), username: username.trim(), password }));
}

async function initApp() {
  console.log('Initializing EverydayFuel...');

  p2pTransport = new WebRTCTransport(loadP2PIceServers());
  p2pService = new P2PTransferService(p2pTransport);

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
    setupExportHandlers();
    setupActionHandlers();
    setupJournalHandlers();
    setupTextLogHandlers();
    setupNumpadHandlers();
    setupScannerHandlers();
    setupActionHubHandlers();
    setupEditModalHandlers();
    setupImportHandlers();
    setupBackupHandler();
    setupRestoreHandler();
    setupP2PHandlers();

    showToast('EverydayFuel loaded (Local SQLite)', 2500);

  } catch (err) {
    console.error('App init failed:', err);
    showToast('Offline Mode: Web storage fallback');
  }
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

  const historyViewEl = document.getElementById('history');
  if (historyViewEl?.classList.contains('active-view')) renderHistoryView();
}

/**
 * History window (spec §20): scores/totals are derived on demand from logs +
 * goals for the visible range and are never stored as a second dataset. The
 * window is anchored to `historyAnchor` and only recomputed when the anchor
 * or the view mode changes — selecting a day never re-anchors it.
 */
async function ensureHistoryWindow() {
  const key = `${historyView}|${historyAnchor}`;
  if (historyWindowKey === key) return;
  const dates = historyView === 'week'
    ? datesForRange(historyAnchor, 7)
    : historyView === 'month'
      ? datesForMonth(historyAnchor)
      : datesForYear(historyAnchor);
  historyWindow = await computeHistoryWindow(dates, { goal: goalRepo, log: logRepo, water: waterRepo });
  historyWindowKey = key;
}

function renderHistoryView() {
  const state = store.getState();
  renderHistory({
    days: historyWindow,
    view: historyView,
    anchor: historyAnchor,
    selectedDate: state.selectedDate,
    logsForSelectedDate: state.todayLogs
  });
}

function shiftHistoryAnchor(delta: number) {
  const d = new Date(historyAnchor + 'T00:00:00');
  if (historyView === 'week') d.setDate(d.getDate() + delta * 7);
  else if (historyView === 'month') d.setMonth(d.getMonth() + delta);
  else d.setFullYear(d.getFullYear() + delta);
  historyAnchor = formatDateISO(d);
}

function setHistoryView(view: HistoryViewMode) {
  historyView = view;
  historyAnchor = getTodayDateString();
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  const btn = view === 'week' ? 'btn-view-week' : view === 'month' ? 'btn-view-month' : 'btn-view-year';
  document.getElementById(btn)?.classList.add('active');
  ensureHistoryWindow().then(() => renderHistoryView());
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
      ensureHistoryWindow().then(() => renderHistoryView());
    } else if (viewId === 'view-goals') {
      goalsView?.classList.add('active-view');
    }
  }

  dashBtn?.addEventListener('click', () => switchTab('today'));
  logsBtn?.addEventListener('click', () => switchTab('history'));
  sysBtn?.addEventListener('click', () => switchTab('view-goals'));

  document.getElementById('btn-view-week')?.addEventListener('click', () => setHistoryView('week'));
  document.getElementById('btn-view-month')?.addEventListener('click', () => setHistoryView('month'));
  document.getElementById('btn-view-year')?.addEventListener('click', () => setHistoryView('year'));

  window.addEventListener('history-nav', (e: any) => {
    shiftHistoryAnchor(e.detail);
    ensureHistoryWindow().then(() => renderHistoryView());
  });
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

// ---------- Export (spec §21: all-time / date range / goal phase) ----------

async function openExportModal() {
  const select = document.getElementById('export-goal-phase') as HTMLSelectElement | null;
  if (select) {
    const goals = await goalRepo.getGoalsHistory();
    select.innerHTML = '';
    goals.forEach(goal => {
      const option = document.createElement('option');
      option.value = goal.id;
      option.textContent = `${goal.name} (${goal.start_date}${goal.end_date ? ' → ' + goal.end_date : ' → now'})`;
      select.appendChild(option);
    });
    if (select.options.length > 0) select.selectedIndex = 0;
  }

  const from = document.getElementById('export-from') as HTMLInputElement | null;
  const to = document.getElementById('export-to') as HTMLInputElement | null;
  if (from) from.value = store.getState().selectedDate;
  if (to) to.value = getTodayDateString();

  document.getElementById('export-modal')?.classList.add('active');
}

function setupExportHandlers() {
  const closeModal = () => document.getElementById('export-modal')?.classList.remove('active');

  document.getElementById('btn-export-close')?.addEventListener('click', closeModal);
  document.getElementById('export-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('export-modal')) closeModal();
  });

  document.querySelectorAll<HTMLInputElement>('input[name="export-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = document.querySelector<HTMLInputElement>('input[name="export-mode"]:checked')?.value || 'day';
      const rangeFields = document.getElementById('export-range-fields');
      const phaseField = document.getElementById('export-phase-field');
      if (rangeFields) rangeFields.style.display = mode === 'range' ? '' : 'none';
      if (phaseField) phaseField.style.display = mode === 'phase' ? '' : 'none';
    });
  });

  document.getElementById('btn-export-do')?.addEventListener('click', async () => {
    const mode = document.querySelector<HTMLInputElement>('input[name="export-mode"]:checked')?.value || 'day';
    const repos: ExportRepos = { goal: goalRepo, log: logRepo, water: waterRepo, dailyRecord: dailyRecordRepo };

    let dates: string[] = [];
    let label = '';

    if (mode === 'day') {
      const day = store.getState().selectedDate;
      dates = [day];
      label = day;
    } else if (mode === 'all') {
      const range = await resolveExportDateRange(repos);
      dates = datesBetween(range.startDate, range.endDate);
      label = range.startDate + '_' + range.endDate;
    } else if (mode === 'range') {
      const from = (document.getElementById('export-from') as HTMLInputElement | null)?.value || '';
      const to = (document.getElementById('export-to') as HTMLInputElement | null)?.value || '';
      if (!from || !to || from > to) {
        showToast('Pick a valid date range (From ≤ To)');
        return;
      }
      dates = datesBetween(from, to);
      label = from + '_' + to;
    } else {
      const goalId = (document.getElementById('export-goal-phase') as HTMLSelectElement | null)?.value;
      const goals = await goalRepo.getGoalsHistory();
      const goal = goals.find(g => g.id === goalId);
      if (!goal) {
        showToast('No goal phase selected');
        return;
      }
      const range = goalPhaseRange(goal);
      dates = datesBetween(range.startDate, range.endDate);
      label = `${goal.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${range.startDate}_${range.endDate}`;
    }

    const rows = await buildExportRows(dates, repos);
    if (rows.length === 0) {
      showToast('No data in this range to export');
      return;
    }

    const csv = generateCSV(rows);
    downloadCSV(`EverydayFuel_Export_${label}.csv`, csv);
    closeModal();
    showToast(`Exported ${rows.length} day(s) to CSV`);
  });
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
    openExportModal();
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

async function logTextInput(rawText: string) {
  const date = store.getState().selectedDate;
  const items = await gemmaClient.interpretTextLog(rawText);

  if (!items || items.length === 0) {
    showToast('Could not interpret that text');
    return;
  }

  const results = await foodService.logTextInput(date, rawText, items);
  const totalCal = results.reduce((sum, r) => sum + r.nutrition.calories, 0);

  document.getElementById('text-log-modal')?.classList.remove('active');
  const textInput = document.getElementById('text-log-input') as HTMLInputElement | null;
  if (textInput) textInput.value = '';

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
    empty.innerText = 'No foods found in your library. Use the +TEXT button to log meals by description.';
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
    const results = await foodRepo.fuzzySearch(text, 20);
    renderJournalResults(results);
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

// ---------- Text Log Modal (dedicated, separate from journal/library) ----------

function setupTextLogHandlers() {
  const modal = document.getElementById('text-log-modal');
  const input = document.getElementById('text-log-input') as HTMLInputElement | null;

  document.getElementById('btn-open-text')?.addEventListener('click', () => {
    if (input) input.value = '';
    modal?.classList.add('active');
    setTimeout(() => input?.focus(), 30);
  });

  modal?.querySelector('.close')?.addEventListener('click', () => modal.classList.remove('active'));
  document.getElementById('btn-close-text')?.addEventListener('click', () => modal?.classList.remove('active'));
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (document.getElementById('btn-log-text') as HTMLButtonElement | null)?.click();
    }
  });

  document.getElementById('btn-log-text')?.addEventListener('click', async () => {
    const rawText = input?.value.trim();
    if (!rawText) {
      showToast('Type a meal description, e.g. "250g chicken breast, 100g rice"');
      return;
    }
    await logTextInput(rawText);
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

// ---------- Scanner / Barcode / Label OCR ----------

/**
 * Spec §7.4 fallback chain: the barcode is missing from the local library,
 * so try the optional internet lookup (Open Food Facts). When it succeeds the
 * product is logged and saved locally for future scans; when the device is
 * offline or the product is not found online, fall back to scanning the
 * nutrition label (never silent manual entry).
 */
async function logBarcodeViaOnlineLookup(code: string) {
  const date = store.getState().selectedDate;
  showToast('Not in library — checking online…');

  const product = await lookupBarcodeOnline(code);
  if (product) {
    try {
      const result = await foodService.logBarcodeLookup(date, product, code);
      await barcodeRepo.saveBarcode(result.food.id, code, 'online');
      document.getElementById('scanner-modal')?.classList.remove('active');
      await refreshStateForDate(date);
      showToast(`Logged "${product.productName}" · ${Math.round(result.nutrition.calories)} kcal`);
      return { id: result.food.id, canonical_name: product.productName };
    } catch (err) {
      console.error('Online barcode logging failed:', err);
      showToast('Could not save that product — scan the label instead');
      triggerLabelScanFallback();
      return null;
    }
  }

  document.getElementById('scanner-modal')?.classList.remove('active');
  showToast('Barcode not found online — scan the nutrition label instead');
  triggerLabelScanFallback();
  return null;
}

/** Look up a barcode in the local library and log the product at 100 g. */
async function logBarcodeFood(code: string) {
  const food = await barcodeRepo.lookupBarcode(code);
  if (!food) return logBarcodeViaOnlineLookup(code);

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

  document.getElementById('scanner-modal')?.classList.remove('active');
  await refreshStateForDate(date);
  showToast(`Logged ${food.canonical_name} · ${Math.round(nutrition.calories)} kcal`);
  return food;
}

/** Run the shared label-text pipeline (parse → interpret → log) on OCR'd text. */
async function logLabelOcrText(text: string, amount: number) {
  const ocr = await gemmaClient.parseNutritionLabel(text);
  const date = store.getState().selectedDate;

  try {
    const result = await foodService.logLabelOcr(date, ocr, amount);
    document.getElementById('scanner-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast(`Logged "${ocr.foodName}" · ${Math.round(result.nutrition.calories)} kcal`);
  } catch (err) {
    console.error('Label OCR logging failed:', err);
    showToast('Could not parse that label text');
  }
}

/**
 * Capture a photo (camera or an existing gallery image) via the system
 * chooser; returns a content URI or null when cancelled. Gallery picks keep
 * the saved-photo OCR/barcode paths reachable in the APK (the browser-only
 * `#ai-file-input` path is otherwise dead code on native).
 */
async function capturePhotoUri(): Promise<string | null> {
  try {
    const photo = await Camera.getPhoto({
      quality: 90,
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      correctOrientation: true
    });
    return photo.path || null;
  } catch (err: any) {
    if (err && typeof err.message === 'string' && err.message.toLowerCase().includes('cancel')) {
      return null;
    }
    throw err;
  }
}

function stopLiveScan(handle: ScanHandle | null) {
  if (handle) {
    handle.stop();
    const container = document.getElementById('barcode-scan-container');
    if (container) container.style.display = 'none';
  }
}

/**
 * Native label scan: camera/gallery capture -> ML Kit OCR -> interpret + log.
 * Returns true when the flow started (photo taken and processed).
 */
async function scanLabelFromScanner(): Promise<boolean> {
  const plugin = getVisionPlugin();
  if (!plugin) return false;

  try {
    const path = await capturePhotoUri();
    if (!path) return false;
    const result = await plugin.ocrLabel({ imagePath: path });
    const text = (result.text || '').trim();
    if (!text) {
      showToast('No label text found in the photo — paste it below instead');
      return false;
    }
    await logLabelOcrText(text, 100);
    return true;
  } catch (err) {
    console.error('Label OCR failed:', err);
    showToast('Label scan failed — paste the label text below instead');
    return false;
  }
}

/** Kick off the label-scan fallback (native capture, or the file picker on web). */
function triggerLabelScanFallback() {
  if (!scanLabelFromScanner() && !getVisionPlugin()) {
    document.getElementById('ai-file-input')?.click();
  }
}

function setupScannerHandlers() {
  const barcodeInput = document.getElementById('barcode-input') as HTMLInputElement | null;
  let liveScan: ScanHandle | null = null;

  const doBarcodeLookup = async () => {
    const code = (barcodeInput?.value || '').trim();
    if (!code) {
      showToast('Enter a barcode number first');
      return;
    }
    stopLiveScan(liveScan);
    liveScan = null;
    const food = await logBarcodeFood(code);
    if (food && barcodeInput) barcodeInput.value = '';
  };

  const doBarcodeScan = async () => {
    const plugin = getVisionPlugin();

    if (plugin) {
      // Native ML Kit: camera capture → decode on-device
      try {
        const path = await capturePhotoUri();
        if (!path) return;
        const result = await plugin.scanBarcode({ imagePath: path });
        if (!result.barcode) {
          showToast('No barcode found in the photo — try again or type the number');
          return;
        }
        const food = await logBarcodeFood(result.barcode);
        if (food && barcodeInput) barcodeInput.value = '';
      } catch (err) {
        console.error('Barcode scan failed:', err);
        showToast('Barcode scan failed — type the number instead');
      }
      return;
    }

    if (supportsBrowserBarcodeScan()) {
      // Browser fallback: live BarcodeDetector feed inside the scanner modal
      const container = document.getElementById('barcode-scan-container');
      if (!container) return;
      stopLiveScan(liveScan);
      container.style.display = 'block';
      try {
        liveScan = await startBrowserBarcodeScan(container, async (code) => {
          stopLiveScan(liveScan);
          liveScan = null;
          await logBarcodeFood(code);
        });
      } catch (err) {
        container.style.display = 'none';
        showToast(err instanceof Error ? err.message : 'Could not start the camera.');
      }
      return;
    }

    showToast('Camera scanning needs the native app — type the barcode number instead');
    barcodeInput?.focus();
  };

  const doLabelScan = async () => {
    if (await scanLabelFromScanner()) return;

    // Browser: file picker (native APK also keeps this as a gallery path)
    document.getElementById('ai-file-input')?.click();
  };

  document.getElementById('btn-scan-barcode')?.addEventListener('click', doBarcodeScan);
  document.getElementById('btn-decode-barcode')?.addEventListener('click', doBarcodeLookup);
  barcodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doBarcodeLookup();
  });

  document.getElementById('btn-close-scanner')?.addEventListener('click', () => {
    stopLiveScan(liveScan);
    liveScan = null;
  });

  document.getElementById('btn-decode-label')?.addEventListener('click', doLabelScan);

  document.getElementById('ai-file-input')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) return;

    const plugin = getVisionPlugin();
    if (!plugin) {
      showToast('Image label OCR needs the native ML Kit integration — paste the label text below instead');
      return;
    }

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(stripDataUrlPrefix(String(reader.result || '')));
        reader.onerror = () => reject(new Error('Could not read the selected image'));
        reader.readAsDataURL(file);
      });
      const result = await plugin.ocrLabel({ imageBase64: base64 });
      const text = (result.text || '').trim();
      if (!text) {
        showToast('No label text found in the image — paste it below instead');
        return;
      }
      await logLabelOcrText(text, 100);
    } catch (err) {
      console.error('Label OCR failed:', err);
      showToast('Label scan failed — paste the label text below instead');
    }
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

    await logLabelOcrText(text, amount);
    if (textEl) textEl.value = '';
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
    const db = await dbManager.getConnection();
    const data = await collectAllTables(db);
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

      historyWindowKey = '';
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

// ---------- P2P Transfer (Phase 9) ----------

let p2pRole: 'send' | 'receive' | null = null;
let p2pPeer: TransferPeer | null = null;
let p2pBusy = false;
let qrScanHandle: QrScanHandle | null = null;

function setP2PStatus(text: string) {
  const el = document.getElementById('p2p-status');
  if (el) el.innerText = text;
}

function setP2PSection(showOut: boolean, showIn: boolean) {
  const out = document.getElementById('p2p-out-section');
  const inn = document.getElementById('p2p-in-section');
  if (out) out.style.display = showOut ? '' : 'none';
  if (inn) inn.style.display = showIn ? '' : 'none';
}

function stopQrScan() {
  qrScanHandle?.stop();
  qrScanHandle = null;
  const container = document.getElementById('qr-scan-container');
  if (container) container.innerHTML = '';
}

function resetP2PModal() {
  const codeOut = document.getElementById('p2p-code-out') as HTMLTextAreaElement | null;
  const codeIn = document.getElementById('p2p-code-in') as HTMLTextAreaElement | null;
  const qrImg = document.getElementById('p2p-qr-code') as HTMLImageElement | null;
  if (codeOut) codeOut.value = '';
  if (codeIn) codeIn.value = '';
  if (qrImg) qrImg.removeAttribute('src');
  setP2PStatus('');
  p2pBusy = false;
}

function closeP2PModal() {
  stopQrScan();
  document.getElementById('qr-scan-modal')?.classList.remove('active');
  if (p2pPeer) {
    try {
      p2pPeer.close();
    } catch {
      /* ignore */
    }
    p2pPeer = null;
  }
  p2pTransport.dispose();
  p2pRole = null;
  resetP2PModal();
  document.getElementById('p2p-modal')?.classList.remove('active');
}

async function onP2PScan() {
  if (p2pBusy || qrScanHandle) return;
  document.getElementById('qr-scan-modal')?.classList.add('active');
  const container = document.getElementById('qr-scan-container');
  if (!container) return;

  try {
    qrScanHandle = await startQrScan(container, (code) => {
      const input = document.getElementById('p2p-code-in') as HTMLTextAreaElement | null;
      if (input) input.value = code;
      stopQrScan();
      document.getElementById('qr-scan-modal')?.classList.remove('active');
      onP2PConnect();
    });
  } catch (err) {
    console.error('QR scan failed:', err);
    document.getElementById('qr-scan-modal')?.classList.remove('active');
    setP2PStatus(err instanceof Error ? err.message : 'Could not start the camera.');
  }
}

async function openP2PModal(role: 'send' | 'receive') {
  if (p2pBusy || p2pRole !== null) return;
  p2pRole = role;
  resetP2PModal();

  try {
    const saved = localStorage.getItem('everydayfuel_p2p_turn');
    if (saved) {
      const cfg = JSON.parse(saved);
      const urlInput = document.getElementById('p2p-turn-url') as HTMLInputElement | null;
      const userInput = document.getElementById('p2p-turn-user') as HTMLInputElement | null;
      const passInput = document.getElementById('p2p-turn-pass') as HTMLInputElement | null;
      if (urlInput) urlInput.value = cfg.url || '';
      if (userInput) userInput.value = cfg.username || '';
      if (passInput) passInput.value = cfg.password || '';
    }
  } catch {
    /* ignore malformed saved config */
  }

  const title = document.getElementById('p2p-title');
  const outLabel = document.getElementById('p2p-out-label');
  const inLabel = document.getElementById('p2p-in-label');

  document.getElementById('p2p-modal')?.classList.add('active');

  if (role === 'receive') {
    if (title) title.innerText = 'Receive Backup (P2P)';
    if (outLabel) outLabel.innerText = 'Step 1 — Send this code to the sending device:';
    if (inLabel) inLabel.innerText = 'Step 2 — Paste the sending device\'s response code:';
    setP2PSection(true, false);
    setP2PStatus('Generating pairing code…');

    try {
      const code = await p2pService.createPairingCode();
      const codeOut = document.getElementById('p2p-code-out') as HTMLTextAreaElement | null;
      if (codeOut) codeOut.value = code;
      renderPairingCodeAsQR(code)
        .then(dataUrl => {
          const qrImg = document.getElementById('p2p-qr-code') as HTMLImageElement | null;
          if (qrImg) qrImg.src = dataUrl;
        })
        .catch(err => {
          console.error('QR render failed (text fallback remains):', err);
          setP2PStatus('QR rendering failed — use "Copy code as text instead".');
        });
      setP2PStatus('Show the QR code to the other device (or copy it as text).');
    } catch (err) {
      console.error('P2P pairing code failed:', err);
      setP2PStatus('Could not generate a pairing code.');
    }
  } else {
    if (title) title.innerText = 'Send Backup (P2P)';
    if (outLabel) outLabel.innerText = 'Step 2 — Send this response code back to the receiving device:';
    if (inLabel) inLabel.innerText = 'Step 1 — Scan (or paste) the receiving device\'s pairing code:';
    setP2PSection(false, true);
    const scanBtn = document.getElementById('btn-p2p-scan');
    if (scanBtn) scanBtn.style.display = supportsQrScanning() ? '' : 'none';
    setP2PStatus(supportsQrScanning() ? 'Tap "Scan QR Code" and point the camera at the other device.' : 'QR scanning is not supported here — paste the pairing code manually.');
  }
}

async function onP2PConnect() {
  if (p2pBusy) return;
  const codeIn = (document.getElementById('p2p-code-in') as HTMLTextAreaElement | null)?.value.trim();
  if (!codeIn) {
    setP2PStatus('Paste the other device\'s code first.');
    return;
  }

  p2pBusy = true;
  setP2PStatus('Connecting…');

  try {
    if (p2pRole === 'receive') {
      const peer = await p2pService.acceptConnection(codeIn);
      p2pPeer = peer;
      setP2PSection(false, false);
      setP2PStatus('Connected — waiting for the backup…');

      const transfer = await p2pService.receiveBackup(peer, (p) => {
        const pct = p.totalBytes > 0 ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0;
        setP2PStatus(`Receiving… ${pct}%`);
      });

      const password = await requestPassword('Enter Backup Password', false);
      if (password === null) {
        setP2PStatus('Transfer received but not restored — no password entered.');
        return;
      }

      const decrypted = await decryptBackup(transfer.payload, password);
      if (decrypted === null) {
        setP2PStatus('Wrong password or corrupted transfer.');
        return;
      }

      const archive = parseBackupArchive(decrypted);
      if (!archive) {
        setP2PStatus('Received data is not a valid EverydayFuel backup.');
        return;
      }

      const validationErrors = validateBackupArchive(archive);
      if (validationErrors.length > 0) {
        setP2PStatus(validationErrors[0]);
        return;
      }

      const confirmed = await requestConfirmation(
        'Receive Backup',
        'Receive this backup? All current local data will be replaced.'
      );
      if (!confirmed) {
        setP2PStatus('Transfer cancelled — nothing was changed.');
        return;
      }

      if (dbManager.isFallback()) {
        dbManager.replaceFallbackStore(archive.data);
      } else {
        const db = await dbManager.getConnection();
        const result = await restoreBackupArchive(db, archive);
        if (!result.ok) {
          setP2PStatus(result.errors[0] || 'Restore failed');
          return;
        }
      }

      historyWindowKey = '';
      const date = store.getState().selectedDate;
      await refreshStateForDate(date);
      const rowCount = Object.values(archive.data).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
      showToast(`Backup received and restored · ${rowCount} rows`);
      closeP2PModal();
    } else {
      const { peer, answerCode } = await p2pService.connect(codeIn);
      p2pPeer = peer;
      const codeOut = document.getElementById('p2p-code-out') as HTMLTextAreaElement | null;
      if (codeOut) codeOut.value = answerCode;
      setP2PSection(true, false);
      setP2PStatus('Send Step 2 back to the receiving device — waiting for connection…');

      const password = await requestPassword('Set Backup Password', true);
      if (password === null) {
        setP2PStatus('Send cancelled.');
        return;
      }

      setP2PStatus('Building backup archive…');
      const db = await dbManager.getConnection();
      const archive = createBackupArchive(await collectAllTables(db));

      setP2PStatus('Encrypting backup…');
      const encrypted = await encryptBackup(archive, password);

      setP2PStatus('Sending encrypted backup…');
      await p2pService.sendBackup(peer, encrypted, `EverydayFuel_Backup_${getTodayDateString()}.json`, (p) => {
        const pct = p.totalBytes > 0 ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0;
        setP2PStatus(`Sending… ${pct}%`);
      });

      showToast('Backup sent to the other device');
      closeP2PModal();
    }
  } catch (err) {
    console.error('P2P transfer failed:', err);
    setP2PStatus(err instanceof Error ? err.message : 'Transfer failed.');
  } finally {
    p2pBusy = false;
  }
}

function setupP2PHandlers() {
  document.getElementById('btn-p2p-receive')?.addEventListener('click', () => openP2PModal('receive'));
  document.getElementById('btn-p2p-send')?.addEventListener('click', () => openP2PModal('send'));
  document.getElementById('btn-p2p-connect')?.addEventListener('click', onP2PConnect);
  document.getElementById('btn-p2p-scan')?.addEventListener('click', onP2PScan);
  document.getElementById('btn-qr-scan-close')?.addEventListener('click', () => {
    stopQrScan();
    document.getElementById('qr-scan-modal')?.classList.remove('active');
  });
  document.getElementById('btn-p2p-close')?.addEventListener('click', closeP2PModal);

  document.getElementById('btn-p2p-save-turn')?.addEventListener('click', () => {
    const url = (document.getElementById('p2p-turn-url') as HTMLInputElement | null)?.value ?? '';
    const user = (document.getElementById('p2p-turn-user') as HTMLInputElement | null)?.value ?? '';
    const pass = (document.getElementById('p2p-turn-pass') as HTMLInputElement | null)?.value ?? '';

    if (url.trim() && !/^turn(s)?:/i.test(url.trim())) {
      setP2PStatus('TURN URL must start with "turn:" or "turns:".');
      return;
    }

    saveP2PTurnConfig(url, user, pass);
    p2pTransport.dispose();
    p2pTransport = new WebRTCTransport(loadP2PIceServers());
    p2pService = new P2PTransferService(p2pTransport);
    setP2PStatus(url.trim() ? 'TURN settings saved — generate a fresh pairing code.' : 'TURN settings cleared — default STUN only.');
  });

  document.getElementById('btn-p2p-copy')?.addEventListener('click', async () => {
    const el = document.getElementById('p2p-code-out') as HTMLTextAreaElement | null;
    if (!el || !el.value) return;
    try {
      await navigator.clipboard.writeText(el.value);
    } catch {
      el.select();
      document.execCommand('copy');
    }
    showToast('Pairing code copied');
  });
}

document.addEventListener('DOMContentLoaded', initApp);
