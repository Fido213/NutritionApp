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
import {
  renderDayDetail,
  type JournalGroup, type JournalEntry, type JournalFoodLog, type JournalWater, type ComboCluster
} from './ui/views/day-detail';
import { weekdayLabel, groupDateLabel } from './ui/views/day-detail';
import { renderGoals, readGoalsForm } from './ui/views/goals';
import { setupTabNavigation, pushLayer, closeLayer, initNavStack, initNativeBackButton, animateViewIn, tabDirection, ViewId } from './ui/nav';
import { showToast } from './ui/components/toast';
import { calculateEffectiveHydration, classifyWaterSource } from '@domain/hydration';
import { calculateScore, getScoreColorClass } from '@domain/scoring';
import { calculateNutrition } from '@domain/nutrition';
import { normalizeFoodName, expandCombo } from '@domain/logging';
import { getTodayDateString, formatDateISO, shiftDate } from '@utils/dates';
import { generateCSV, downloadCSV } from '@services/export/csv-export';
import { buildExportRows, datesBetween, goalPhaseRange, resolveExportDateRange, ExportRepos } from '@services/export/export-service';
import { parseCSV } from '@services/import/csv-import';
import { createBackupArchive, downloadBackup, parseBackupArchive, restoreBackupArchive, validateBackupArchive, collectAllTables, wipeAllData } from '@services/backup/backup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '@services/backup/encryption';
import { GemmaClient, DEFAULT_LABEL_PRODUCT_NAME } from '@services/ai/gemma-client';
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

/** Index sort keys (§5d): date created, kcal, every macro, confidence — both directions. */
type FoodSortKey =
  | 'created-desc' | 'created-asc'
  | 'kcal-desc' | 'kcal-asc'
  | 'protein-desc' | 'protein-asc'
  | 'carbs-desc' | 'carbs-asc'
  | 'fat-desc' | 'fat-asc'
  | 'confidence-desc' | 'confidence-asc';

type ComboSortKey =
  | 'created-desc' | 'created-asc'
  | 'kcal-desc' | 'kcal-asc'
  | 'items-desc' | 'name-asc';
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
let dataVersion = 0;
let numpadBuffer = '';

// Index screen state (§5d: the Journal modal became a dedicated INDEX tab):
// Foods / Combos sub-views, sort keys, fuzzy query, inline-expanded food row.
let indexTab: 'foods' | 'combos' = 'foods';
let indexSortFoods: FoodSortKey = 'created-desc';
let indexSortCombos: ComboSortKey = 'created-desc';
let indexRenderGen = 0;
let expandedIndexFoodId: string | null = null;
/** Library combo whose detail modal is open (§5d clean modal, image-2 layout). */
let openComboDetailId: string | null = null;

// Day-detail UI state (§5b: inline expand, multi-select; §5c/§5d: day groups,
// combo breakdowns, low-accuracy chip, per-group day notes, day ordering).
let journalWaters: JournalWater[] = [];
let expandedLogId: string | null = null;
const expandedComboKeys = new Set<string>();
let selectMode = false;
const selection = new Set<string>();
/** §5d: ONLY the selected day by default — no more scrolling into other days. */
let journalDaysShown = 1;
const JOURNAL_PAGE_DAYS = 14;
/** §5d: day-group ordering (Newest first ▾ / Oldest first ▴). */
let journalDayOrder: 'desc' | 'asc' = 'desc';
let journalRenderGen = 0;
let currentViewId: ViewId = 'today';
let tabController: ReturnType<typeof setupTabNavigation> | null = null;

// Combo builder state (§5d remake): full-screen editor with per-item amounts
// and live totals; a draft survives only while the view stays open.
let builderComboId: string | null = null;
let builderItems: Array<{ foodId: string; amountG: number }> = [];
const builderFoodCache = new Map<string, Food>();
let builderSearchGen = 0;
let builderTotalsGen = 0;

/**
 * Modal ↔ navigation-layer bridge: opening a modal pushes one history entry,
 * so Android BACK / swipe-back closes it instead of leaving the app.
 * `onClosed` runs for BOTH paths (BACK or programmatic close) so pending
 * prompt promises always settle.
 */
function openModalLayer(id: string, onClosed?: () => void) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  pushLayer(() => {
    el.classList.remove('active');
    onClosed?.();
  });
}

function closeModalLayer(id: string) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('active')) return;
  el.classList.remove('active');
  // The registered layer close re-runs hide + onClosed; hiding twice is safe.
  closeLayer();
}

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
    initNativeBackButton();
    setupModals();
    setupDialogModals();
    setupExportHandlers();
    setupActionHandlers();
    setupIndexHandlers();
    setupComboBuilderHandlers();
    setupWaterEditHandlers();
    setupDeleteAllHandler();
    setupDashboardTextBar();
    setupNumpadHandlers();
    setupScannerHandlers();
    setupEditHandlers();
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
  dataVersion++;
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
  journalWaters = await waterRepo.getWaterForDate(dateStr);

  // 1-Tap Recents query (HANDOVER §5a): kept as an agent-only debug hook.
  // Not shown anywhere in the UI — visible via WebView DevTools CDP console.
  const recents = await foodRepo.fuzzySearch('', 5);
  console.debug('[debug] recents (UI hidden):', recents.map(r => r.canonical_name).join(', '));

  store.setState({
    selectedDate: dateStr,
    todayTotals: totals,
    todayGoals: goal,
    todayHydration: hydration,
    todayLogs: logs,
    currentScore: score
  });

  const historyViewEl = document.getElementById('history');
  if (historyViewEl?.classList.contains('active-view')) {
    // Data changed (this refresh follows every log/water/delete/edit/goal
    // mutation): recompute the visible window (batch range queries, ~3 native
    // calls) and re-render so heatmap cells update automatically.
    ensureHistoryWindow().then(() => renderHistoryView());
  }
}

/**
 * History window (spec §20): scores/totals are derived on demand from logs +
 * goals for the visible range and are never stored as a second dataset. The
 * window is anchored to `historyAnchor` and only recomputed when the anchor
 * or the view mode changes — selecting a day never re-anchors it.
 */
async function ensureHistoryWindow() {
  // dataVersion bumps on every refresh (which follows every data mutation),
  // so the cached window is invalidated and recomputed after any change —
  // heatmap cells update automatically without switching views. The batch
  // range queries keep each recompute at ~3 native calls.
  const key = `${historyView}|${historyAnchor}|${dataVersion}`;
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
    selectedDate: state.selectedDate
  });
  renderJournalIfVisible();
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
  const indexBtn = document.getElementById('nav-btn-index');
  const logsBtn = document.getElementById('nav-btn-logs');
  const sysBtn = document.getElementById('sys-btn-top');

  const todayView = document.getElementById('today');
  const indexView = document.getElementById('view-index');
  const historyView = document.getElementById('history');
  const goalsView = document.getElementById('view-goals');

  function switchTabInternal(viewId: ViewId) {
    const previousView = currentViewId;
    [todayView, indexView, historyView, goalsView].forEach(v => v?.classList.remove('active-view'));
    [dashBtn, indexBtn, logsBtn].forEach(b => b?.classList.remove('active'));

    let target: HTMLElement | null = null;
    if (viewId === 'today') {
      todayView?.classList.add('active-view');
      dashBtn?.classList.add('active');
      target = todayView;
    } else if (viewId === 'index') {
      indexView?.classList.add('active-view');
      indexBtn?.classList.add('active');
      target = indexView;
      renderIndex();
    } else if (viewId === 'history') {
      historyView?.classList.add('active-view');
      logsBtn?.classList.add('active');
      target = historyView;
      ensureHistoryWindow().then(() => renderHistoryView());
    } else if (viewId === 'view-goals') {
      goalsView?.classList.add('active-view');
      target = goalsView;
    }
    // Assign BEFORE the data loads below — renderIndex/renderJournalIfVisible
    // guard on currentViewId.
    currentViewId = viewId;
    if (viewId === 'index') renderIndex();
    // Direction-aware entrance animation for tab swipes / dock taps (§5c-7).
    if (target && previousView !== viewId) animateViewIn(target, tabDirection(previousView, viewId));
  }

  initNavStack();
  tabController = setupTabNavigation(switchTabInternal, () => currentViewId);

  dashBtn?.addEventListener('click', () => tabController!.switchTab('today'));
  indexBtn?.addEventListener('click', () => tabController!.switchTab('index'));
  logsBtn?.addEventListener('click', () => tabController!.switchTab('history'));
  sysBtn?.addEventListener('click', () => tabController!.switchTab('view-goals'));

  document.getElementById('btn-view-week')?.addEventListener('click', () => setHistoryView('week'));
  document.getElementById('btn-view-month')?.addEventListener('click', () => setHistoryView('month'));
  document.getElementById('btn-view-year')?.addEventListener('click', () => setHistoryView('year'));

  window.addEventListener('history-nav', (e: any) => {
    shiftHistoryAnchor(e.detail);
    ensureHistoryWindow().then(() => renderHistoryView());
  });
}

function setupModals() {
  const openModal = (id: string) => openModalLayer(id);
  const closeModal = (id: string) => closeModalLayer(id);

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

  // §5d: "Journal" is now the dedicated INDEX screen — switch to it as a tab.
  document.getElementById('btn-open-index')?.addEventListener('click', () => {
    tabController?.switchTab('index');
  });

  document.getElementById('btn-open-manual')?.addEventListener('click', () => openModal('manual-log-modal'));
  document.getElementById('btn-close-manual')?.addEventListener('click', () => closeModal('manual-log-modal'));

  document.getElementById('scan-btn')?.addEventListener('click', () => openModal('scanner-modal'));
  document.getElementById('btn-close-scanner')?.addEventListener('click', () => closeModal('scanner-modal'));

  // §5d: tapping the dashboard score explains what it is and how it's computed.
  document.getElementById('dash-score-badge')?.addEventListener('click', () => {
    const state = store.getState();
    const valueEl = document.getElementById('score-modal-value');
    const reasonEl = document.getElementById('score-modal-reason');
    const compEl = document.getElementById('score-components');
    const score = state.currentScore;
    if (valueEl) {
      const s = score?.score ?? 0;
      valueEl.innerText = `${s > 0 ? '+' : ''}${s}`;
      valueEl.style.color = `var(${getScoreColorClass(s)})`;
    }
    if (reasonEl) reasonEl.innerText = score?.reason || 'Nothing logged for this day yet.';
    if (compEl) {
      compEl.innerHTML = '';
      const c = score?.components;
      const rows: Array<[string, number]> = c ? [
        ['Calories in 85–115% of target (−1 above)', c.calories],
        ['Protein at ≥90% of target', c.protein],
        ['Carbs in 85–115% of target (−1 above)', c.carbs],
        ['Fat in 85–115% of target (−1 above)', c.fat],
        ['Hydration at ≥80% of target', c.hydration]
      ] : [];
      for (const [label, val] of rows) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;background:var(--surface-light);border-radius:8px;padding:7px 10px;font-size:12px;';
        const name = document.createElement('span');
        name.style.color = 'var(--text-dim)';
        name.textContent = label;
        const pts = document.createElement('span');
        pts.style.fontWeight = '800';
        pts.style.color = val > 0 ? 'var(--accent-glow)' : val < 0 ? 'var(--warn)' : 'var(--text-dim)';
        pts.textContent = `${val > 0 ? '+' : ''}${val}`;
        row.append(name, pts);
        compEl.appendChild(row);
      }
      if (!c) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:12px;color:var(--text-dim);text-align:center;padding:4px;';
        empty.textContent = 'Log something to see the breakdown.';
        compEl.appendChild(empty);
      }
    }
    openModalLayer('score-modal');
  });
  document.getElementById('btn-score-close')?.addEventListener('click', () => closeModalLayer('score-modal'));

  setupDayNoteHandlers();
  setupBulkDateHandlers();
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

  openModalLayer('export-modal');
}

function setupExportHandlers() {
  const closeModal = () => closeModalLayer('export-modal');

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
    // §5c-12: saving updates the ACTIVE goal in place instead of closing it
    // and creating a fresh phase on every save (start/end dates and history
    // stay intact; the goal list no longer fills with "Updated Goal" rows).
    const current = await goalRepo.getCurrentGoal();
    if (current) {
      await goalRepo.updateGoalTargets(current.id, {
        calories_target: newGoals.caloriesTarget,
        protein_target: newGoals.proteinTarget,
        carbs_target: newGoals.carbsTarget,
        fat_target: newGoals.fatTarget,
        water_target: newGoals.waterTarget
      });
    } else {
      await goalRepo.createGoal({
        name: 'Initial Goal',
        start_date: getTodayDateString(),
        end_date: null,
        calories_target: newGoals.caloriesTarget,
        protein_target: newGoals.proteinTarget,
        carbs_target: newGoals.carbsTarget,
        fat_target: newGoals.fatTarget,
        water_target: newGoals.waterTarget
      });
    }
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
    const dateStr = e.detail as string;
    if (dateStr !== store.getState().selectedDate) journalDaysShown = 1; // §5d: one day at a time
    refreshStateForDate(dateStr);
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

  const textInput = document.getElementById('dash-text-input') as HTMLInputElement | null;
  if (textInput) {
    textInput.value = '';
    textInput.closest('.text-bar')?.classList.remove('has-text');
  }

  await refreshStateForDate(date);
  showToast(`Logged ${results.length} item(s) · ${Math.round(totalCal)} kcal`);
}

// ---------- Quick-log helpers (shared by the Index screen) ----------

/** Log a library food at an exact gram amount on the selected date. */
async function logFoodAtAmount(food: Food, grams: number) {
  const ref = foodRepo.toFoodReference(food);
  const nutrition = calculateNutrition(ref, grams);
  const date = store.getState().selectedDate;

  const log = await logRepo.insertFoodLog({
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

/** One-tap log at 100 g (the classic library quick-log, kept intact). */
async function quickLogFood(foodId: string) {
  const food = await foodRepo.findById(foodId);
  if (!food) {
    showToast('Food not found in library');
    return;
  }
  await logFoodAtAmount(food, 100);
}

// ---------- Index screen (§5d: the Journal modal became a dedicated tab) ----------
//
// Two sub-views — FOODS (the library) and COMBOS — behind one fuzzy search bar
// and a sort selector covering date created, kcal, every macro and confidence,
// each in both directions ("highest and lowest of x, or newest/oldest").

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
  const select = document.getElementById('index-sort') as HTMLSelectElement | null;
  if (!select) return;
  const options = indexTab === 'foods' ? FOOD_SORT_OPTIONS : COMBO_SORT_OPTIONS;
  const current = indexTab === 'foods' ? indexSortFoods : indexSortCombos;
  select.innerHTML = '';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    select.appendChild(o);
  }
  select.value = current;
}

function setIndexTab(tab: 'foods' | 'combos') {
  indexTab = tab;
  document.getElementById('btn-index-foods')?.classList.toggle('active', tab === 'foods');
  document.getElementById('btn-index-combos')?.classList.toggle('active', tab === 'combos');
  expandedIndexFoodId = null;
  populateIndexSort();
  renderIndex();
}

function setupIndexHandlers() {
  document.getElementById('btn-index-foods')?.addEventListener('click', () => setIndexTab('foods'));
  document.getElementById('btn-index-combos')?.addEventListener('click', () => setIndexTab('combos'));
  populateIndexSort();

  // Fuzzy search retained (§5d) — semantic matching stays a future upgrade.
  const search = document.getElementById('index-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => renderIndex());
  search?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    renderIndex();
  });

  (document.getElementById('index-sort') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    if (indexTab === 'foods') indexSortFoods = val as FoodSortKey;
    else indexSortCombos = val as ComboSortKey;
    renderIndex();
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
}

async function renderIndex() {
  if (currentViewId !== 'index') return;
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

function confidenceLabel(confidence: number | null | undefined): string {
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
  const foods = query
    ? await foodRepo.fuzzySearch(query, 300)
    : await foodRepo.getAllFoods(500);
  if (gen !== indexRenderGen) return;
  foods.sort(FOOD_CMP[indexSortFoods]);

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
    <span class="conf-chip">${confidenceLabel(food.confidence)}</span>
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
    actions.append(quick, custom);
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

/** Resolve a food through the shared builder cache (one lookup per id ever). */
async function resolveFoodCached(foodId: string): Promise<Food | null> {
  const cached = builderFoodCache.get(foodId);
  if (cached) return cached;
  const food = await foodRepo.findById(foodId);
  if (food) builderFoodCache.set(foodId, food);
  return food;
}

async function loadComboViews(): Promise<IndexComboView[]> {
  const combos = await comboRepo.getAllCombos();
  const views: IndexComboView[] = [];
  for (const combo of combos) {
    let kcal = 0, pro = 0, carb = 0, fat = 0;
    for (const ci of combo.items) {
      const food = await resolveFoodCached(ci.food_id);
      if (!food) continue;
      const n = calculateNutrition(foodRepo.toFoodReference(food), ci.amount_g ?? ci.amount_ml ?? 100);
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
    const n = calculateNutrition(foodRepo.toFoodReference(food), amount);
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
    await comboRepo.deleteCombo(combo.id);
    openComboDetailId = null;
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
        ` · ${confidenceLabel(ing.food.confidence)} (${ing.food.source_type})`;
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

/* ----- Combo creation remake (§5d: full-screen builder with real amounts) ----- */

function currentComboQuery(): string {
  return (document.getElementById('combo-item-search') as HTMLInputElement | null)?.value.trim() || '';
}

function openComboBuilderView(editComboId: string | null) {
  builderComboId = editComboId;
  builderItems = [];

  const previousView = currentViewId;
  pushLayer(() => closeComboBuilderView(previousView));

  document.body.classList.add('builder-open');
  document.querySelectorAll('main section.view').forEach(v => v.classList.remove('active-view'));
  const view = document.getElementById('view-combo-builder');
  const titleEl = document.getElementById('combo-builder-title');
  if (titleEl) titleEl.textContent = editComboId ? 'Edit Combo' : 'New Combo';
  const nameInput = document.getElementById('combo-name-input') as HTMLInputElement | null;
  if (nameInput) nameInput.value = '';

  if (editComboId) {
    comboRepo.getCombo(editComboId).then(async (combo) => {
      if (!combo) {
        showToast('That combo no longer exists');
        closeLayer();
        return;
      }
      if (nameInput) nameInput.value = combo.name;
      builderItems = combo.items.map(i => ({ foodId: i.food_id, amountG: i.amount_g ?? i.amount_ml ?? 100 }));
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
  }

  if (view) {
    view.classList.add('active-view');
    animateViewIn(view, 'up');
  }
}

function closeComboBuilderView(previousView: ViewId) {
  document.body.classList.remove('builder-open');
  document.getElementById('view-combo-builder')?.classList.remove('active-view');
  tabController?.switchTabDirect(previousView);
  builderComboId = null;
  builderItems = [];
}

function setupComboBuilderHandlers() {
  document.getElementById('btn-combo-back')?.addEventListener('click', () => closeLayer());

  const search = document.getElementById('combo-item-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => renderComboSearchResults(search.value.trim()));

  document.getElementById('btn-save-combo')?.addEventListener('click', saveComboFromBuilder);
}

async function renderComboSearchResults(query: string) {
  const container = document.getElementById('combo-search-results');
  if (!container) return;

  const gen = ++builderSearchGen;
  const results = query
    ? await foodRepo.fuzzySearch(query, 40)
    : await foodRepo.getAllFoods(60);
  if (gen !== builderSearchGen) return;

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

    row.addEventListener('click', () => addComboBuilderItem(food.id));
    frag.appendChild(row);
  }
  container.appendChild(frag);
}

async function addComboBuilderItem(foodId: string) {
  if (builderItems.some(i => i.foodId === foodId)) return;
  builderItems.push({ foodId, amountG: 100 });
  await Promise.all([
    renderComboBuilderItems(),
    refreshComboBuilderTotals(),
    renderComboSearchResults(currentComboQuery())
  ]);
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
    const food = builderFoodCache.get(item.foodId);
    const ref = food ? foodRepo.toFoodReference(food) : null;
    const nutrition = ref ? calculateNutrition(ref, item.amountG) : null;

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
    remove.textContent = '×';
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      builderItems.splice(idx, 1);
      await Promise.all([
        renderComboBuilderItems(),
        refreshComboBuilderTotals(),
        renderComboSearchResults(currentComboQuery())
      ]);
    });
    main.append(name, remove);
    row.appendChild(main);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:8px;padding-left:2px;';
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.step = 'any';
    amount.value = String(item.amountG);
    amount.className = 'combo-amount-input';
    amount.addEventListener('change', async () => {
      const v = parseFloat(amount.value);
      item.amountG = v > 0 ? v : 100;
      if (!(v > 0)) amount.value = '100';
      await refreshComboBuilderTotals();
      await renderComboBuilderItems();
    });
    const unit = document.createElement('span');
    unit.style.cssText = 'font-size:11px;color:var(--text-dim);font-weight:700;';
    unit.textContent = 'g/ml';
    const kcal = document.createElement('span');
    kcal.className = 'combo-row-kcal';
    kcal.textContent = nutrition ? `${Math.round(nutrition.calories)} kcal` : '—';
    controls.append(amount, unit, kcal);
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
    const n = calculateNutrition(foodRepo.toFoodReference(food), item.amountG);
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
  const nameInput = document.getElementById('combo-name-input') as HTMLInputElement | null;
  const name = nameInput?.value.trim() || '';
  if (!name || builderItems.length === 0) {
    showToast('Give the combo a name and at least one ingredient');
    return;
  }
  const items = builderItems.map(i => ({ food_id: i.foodId, amount_g: i.amountG, amount_ml: null }));
  try {
    if (builderComboId) {
      await comboRepo.updateCombo(builderComboId, name, items);
      showToast(`Updated combo "${name}"`);
    } else {
      await comboRepo.createCombo(name, items);
      showToast(`Saved combo "${name}"`);
    }
    closeLayer();
    await renderIndex();
  } catch (err) {
    console.error('Combo save failed:', err);
    showToast('Could not save the combo — try again');
  }
}

/** Expand a combo through the deterministic domain path and log every ingredient.
 *  All ingredient logs share ONE combo observation so the journal can collapse
 *  them into a single expandable breakdown card. */
async function logCombo(combo: Awaited<ReturnType<ComboRepository['getAllCombos']>>[number]) {
  const date = store.getState().selectedDate;
  const items: Array<{ foodId: string; food: any; amountG: number | null; amountMl: number | null }> = [];
  for (const ci of combo.items) {
    const food = await foodRepo.findById(ci.food_id);
    if (!food) continue;
    items.push({ foodId: food.id, food: foodRepo.toFoodReference(food), amountG: ci.amount_g ?? 100, amountMl: ci.amount_ml });
  }
  if (items.length === 0) {
    showToast('Combo ingredients missing from library');
    return;
  }

  const markerObservation = await observationRepo.insert({
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
    const log = await logRepo.insertFoodLog({
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
      await waterRepo.insertWaterLog({
        date,
        amount_ml: nutrition.waterMl,
        source: classifyWaterSource(entry.food),
        food_log_id: log.id
      });
    }
  }

  closeModalLayer('combo-detail-modal');
  await refreshStateForDate(date);
  showToast(`Logged combo "${combo.name}" · ${Math.round(totalCal)} kcal`);
}

// ---------- Dashboard Text Bar (always-visible text logging, HANDOVER §5a item 2) ----------

function setupDashboardTextBar() {
  const input = document.getElementById('dash-text-input') as HTMLInputElement | null;
  const textBar = input?.closest('.text-bar') as HTMLElement | null;

  const syncLogButton = () => {
    textBar?.classList.toggle('has-text', (input?.value.trim().length ?? 0) > 0);
  };

  const submit = async () => {
    const rawText = input?.value.trim();
    if (!rawText) {
      showToast('Type a meal description, e.g. "250g chicken breast, 100g rice"');
      return;
    }
    await logTextInput(rawText);
  };

  input?.addEventListener('input', syncLogButton);

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  document.getElementById('btn-dash-text-log')?.addEventListener('click', submit);
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
let gramsPromptResolver: ((value: number | null) => void) | null = null;
let namePromptResolver: ((value: string | null) => void) | null = null;
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

    passwordPromptResolver?.(pw);
    closeModalLayer('password-modal');
  });

  document.getElementById('btn-pw-cancel')?.addEventListener('click', () => {
    closeModalLayer('password-modal');
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
    confirmPromptResolver?.(true);
    closeModalLayer('confirm-modal');
  });

  document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => {
    closeModalLayer('confirm-modal');
  });

  // Grams modal (label + barcode scans — HANDOVER §5a item 8)
  document.getElementById('btn-grams-ok')?.addEventListener('click', () => {
    const input = document.getElementById('grams-input') as HTMLInputElement | null;
    const errorEl = document.getElementById('grams-error');
    const value = parseFloat(input?.value || '');
    if (!(value > 0)) {
      if (errorEl) errorEl.innerText = 'Enter a positive amount';
      return;
    }
    gramsPromptResolver?.(value);
    closeModalLayer('grams-modal');
  });

  document.getElementById('btn-grams-cancel')?.addEventListener('click', () => {
    closeModalLayer('grams-modal');
  });

  document.getElementById('grams-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('btn-grams-ok') as HTMLButtonElement | null)?.click();
  });

  // Name modal (label scan when the product name can't be read — item 7)
  document.getElementById('btn-name-ok')?.addEventListener('click', () => {
    const input = document.getElementById('name-input') as HTMLInputElement | null;
    const errorEl = document.getElementById('name-error');
    const value = input?.value.trim() || '';
    if (!value) {
      if (errorEl) errorEl.innerText = 'Name must not be empty';
      return;
    }
    namePromptResolver?.(value);
    closeModalLayer('name-modal');
  });

  document.getElementById('btn-name-cancel')?.addEventListener('click', () => {
    closeModalLayer('name-modal');
  });

  document.getElementById('name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('btn-name-ok') as HTMLButtonElement | null)?.click();
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

  openModalLayer('password-modal', () => {
    const resolve = passwordPromptResolver;
    passwordPromptResolver = null;
    resolve?.(null);
  });
  pwEl?.focus();

  return new Promise(resolve => { passwordPromptResolver = resolve; });
}

function requestConfirmation(title: string, message: string): Promise<boolean> {
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;

  openModalLayer('confirm-modal', () => {
    const resolve = confirmPromptResolver;
    confirmPromptResolver = null;
    resolve?.(false);
  });
  return new Promise(resolve => { confirmPromptResolver = resolve; });
}

/** Ask how many grams the user actually ate (per-100g values are scaled to it). */
function requestGrams(title: string, sub: string, defaultValue = 100): Promise<number | null> {
  const titleEl = document.getElementById('grams-title');
  const subEl = document.getElementById('grams-sub');
  const input = document.getElementById('grams-input') as HTMLInputElement | null;
  const errorEl = document.getElementById('grams-error');

  if (titleEl) titleEl.innerText = title;
  if (subEl) subEl.innerText = sub;
  if (input) input.value = String(defaultValue);
  if (errorEl) errorEl.innerText = '';

  openModalLayer('grams-modal', () => {
    const resolve = gramsPromptResolver;
    gramsPromptResolver = null;
    resolve?.(null);
  });
  input?.focus();
  if (input) input.select();

  return new Promise(resolve => { gramsPromptResolver = resolve; });
}

/** Ask the user for a product name when the label text doesn't reveal one. */
function requestName(title: string, sub: string, defaultValue = ''): Promise<string | null> {
  const titleEl = document.getElementById('name-title');
  const subEl = document.getElementById('name-sub');
  const input = document.getElementById('name-input') as HTMLInputElement | null;
  const errorEl = document.getElementById('name-error');

  if (titleEl) titleEl.innerText = title;
  if (subEl) subEl.innerText = sub;
  if (input) input.value = defaultValue;
  if (errorEl) errorEl.innerText = '';

  openModalLayer('name-modal', () => {
    const resolve = namePromptResolver;
    namePromptResolver = null;
    resolve?.(null);
  });
  input?.focus();

  return new Promise(resolve => { namePromptResolver = resolve; });
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
    // HANDOVER §5a item 8: the grams the user enters are what THEY ate.
    const grams = await requestGrams(
      'How many grams did you eat?',
      `${product.productName} · ${Math.round(product.caloriesPer100g)} kcal per 100g`
    );
    if (grams === null) {
      showToast('Cancelled — nothing logged');
      return null;
    }
    try {
      const result = await foodService.logBarcodeLookup(date, product, code, grams);
      await barcodeRepo.saveBarcode(result.food.id, code, 'online');
      closeModalLayer('scanner-modal');
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

  closeModalLayer('scanner-modal');
  showToast('Barcode not found online — scan the nutrition label instead');
  triggerLabelScanFallback();
  return null;
}

/** Look up a barcode in the local library and log the product at the eaten amount. */
async function logBarcodeFood(code: string) {
  const food = await barcodeRepo.lookupBarcode(code);
  if (!food) return logBarcodeViaOnlineLookup(code);

  const ref = foodRepo.toFoodReference(food);

  // HANDOVER §5a item 8: the grams the user enters are what THEY ate.
  const per100 = food.calories_per_100g != null ? `${Math.round(food.calories_per_100g)} kcal` : 'no calories listed';
  const grams = await requestGrams(
    'How many grams did you eat?',
    `${food.canonical_name} · ${per100} per 100g`
  );
  if (grams === null) {
    showToast('Cancelled — nothing logged');
    return null;
  }

  const nutrition = calculateNutrition(ref, grams);
  const date = store.getState().selectedDate;

  const log = await logRepo.insertFoodLog({
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
    await waterRepo.insertWaterLog({
      date,
      amount_ml: nutrition.waterMl,
      source: classifyWaterSource(ref),
      food_log_id: log.id
    });
  }

  closeModalLayer('scanner-modal');
  await refreshStateForDate(date);
  showToast(`Logged ${food.canonical_name} · ${Math.round(nutrition.calories)} kcal`);
  return food;
}

/**
 * Run the shared label-text pipeline (parse → interpret → log) on OCR'd text.
 * When `askGrams` is set (camera/gallery scans) the user is asked how many
 * grams they ate; the dev-only paste-text path keeps its own amount field.
 */
async function logLabelOcrText(text: string, amount: number, askGrams = true) {
  const ocr = await gemmaClient.parseNutritionLabel(text);
  const date = store.getState().selectedDate;

  // HANDOVER §5a item 7: never log the "Scanned Label Product" placeholder —
  // use the name read from the label text, or ask the user for one.
  if (!ocr.foodName || ocr.foodName === DEFAULT_LABEL_PRODUCT_NAME) {
    const name = await requestName(
      'Name this product',
      "We couldn't read the product name from the label — what is it?"
    );
    if (name === null) {
      showToast('Cancelled — nothing logged');
      return;
    }
    ocr.foodName = name;
  }

  let grams = amount;
  if (askGrams) {
    const per100 = ocr.caloriesPer100g ? `${Math.round(ocr.caloriesPer100g)} kcal` : 'no calories listed';
    const g = await requestGrams(
      'How many grams did you eat?',
      `${ocr.foodName} · ${per100} per 100g`
    );
    if (g === null) {
      showToast('Cancelled — nothing logged');
      return;
    }
    grams = g;
  }

  try {
    const result = await foodService.logLabelOcr(date, ocr, grams);
    closeModalLayer('scanner-modal');
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

    // Dev-only path (never shipped): the paste-text area keeps its own amount field.
    await logLabelOcrText(text, amount, false);
    if (textEl) textEl.value = '';
  });
}

// ---------- Day logs (§5c-D day-grouped list; §5d: selected-day-only window,
//            newest/oldest day ordering, full water-row actions) ----------

/**
 * Build the log groups for the visible window. §5d: the window is JUST the
 * selected date by default — picking Saturday never shows Friday below it —
 * and "Load Older Days" pages the window back 14 days at a time.
 */
async function renderJournalIfVisible() {
  if (currentViewId !== 'history') return;
  const container = document.getElementById('day-view-container');
  if (!container) return;

  const gen = ++journalRenderGen;
  const selDate = store.getState().selectedDate;
  const start = shiftDate(selDate, -(journalDaysShown - 1));

  try {
    const [logs, waters, totalsByDate, records] = await Promise.all([
      logRepo.getLogsForRange(start, selDate),
      waterRepo.getWaterForRange(start, selDate),
      logRepo.getDailyTotalsForRange(start, selDate),
      dailyRecordRepo.getForRange(start, selDate)
    ]);
    journalWaters = waters.map(w => ({ ...w }));

    const recordByDate = new Map(records.map(r => [r.date, r]));
    const logsByDate = new Map<string, JournalFoodLog[]>();
    journalLogsById = new Map();
    for (const log of logs as unknown as JournalFoodLog[]) {
      const arr = logsByDate.get(log.date) || [];
      arr.push(log);
      logsByDate.set(log.date, arr);
      journalLogsById.set(log.id, log);
    }

    // Combo clusters: ≥2 logs sharing an observation_id whose observation is
    // a combo marker (duplicated single items share ids too — verify first).
    const candidateGroups = new Map<string, JournalFoodLog[]>();
    for (const log of logs) {
      if (!log.observation_id) continue;
      const arr = candidateGroups.get(log.observation_id) || [];
      arr.push(log);
      candidateGroups.set(log.observation_id, arr);
    }
    const comboByObsId = new Map<string, ComboCluster>();
    for (const [obsId, members] of candidateGroups) {
      if (members.length < 2) continue;
      const obs = await observationRepo.findById(obsId);
      if (!obs || obs.source_type !== 'combo') continue;
      let meta: { comboId?: string; comboName?: string } = {};
      try { meta = JSON.parse(obs.interpretation_json || '{}'); } catch { /* unparseable */ }
      let name = String(meta.comboName || '').trim();
      if (!name && meta.comboId) {
        const tpl = await comboRepo.getCombo(meta.comboId).catch(() => null);
        name = tpl?.name || 'Combo';
      }
      if (!name) name = 'Combo';
      comboByObsId.set(obsId, {
        kind: 'combo',
        key: `combo:${obsId}`,
        comboId: meta.comboId ?? null,
        name,
        logs: [...members].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')),
        totalCalories: members.reduce((sum, l) => sum + (l.calories || 0), 0),
        createdAt: members[0]?.created_at
      });
    }

    // Groups newest-first; entries chronological within the day.
    const datesDesc = Array.from(new Set([...logsByDate.keys(), ...waters.map(w => w.date)])).sort((a, b) => b.localeCompare(a));
    const groups: JournalGroup[] = [];
    for (const date of datesDesc) {
      const dayLogs = logsByDate.get(date) || [];
      const entries: JournalEntry[] = [];
      for (const log of dayLogs) {
        const cluster = log.observation_id ? comboByObsId.get(log.observation_id) : null;
        if (cluster) continue; // represented by the combo row
        entries.push({ ...log, kind: 'food' });
      }
      for (const cluster of comboByObsId.values()) {
        if (cluster.logs.some(l => l.date === date)) entries.push(cluster);
      }
      const dayWaters = waters.filter(w => w.date === date);
      for (const w of dayWaters) entries.push({ ...w, kind: 'water' });

      groups.push({
        date,
        weekday: weekdayLabel(date),
        displayDate: groupDateLabel(date),
        isSelected: date === selDate,
        totalKcal: totalsByDate[date]?.calories ?? dayLogs.reduce((s, l) => s + (l.calories || 0), 0),
        note: recordByDate.get(date)?.note ?? null,
        lowAccuracy: recordByDate.get(date)?.low_accuracy === 1,
        entries
      });
    }

    if (gen !== journalRenderGen) return; // a newer render superseded this one

    renderDayDetail({
      container,
      selectedDate: selDate,
      groups,
      hasMoreDays: true,
      dayOrder: journalDayOrder,
      expandedLogId,
      expandedComboKeys,
      selection,
      selectMode,
      onToggleExpand(id) {
        expandedLogId = expandedLogId === id ? null : id;
        renderJournalIfVisible();
      },
      onEdit: openEditView,
      onDuplicate: async (log) => {
        await logRepo.duplicateLog(log.id, log.date);
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast('Log duplicated');
      },
      onDeleteFood: async (log) => {
        const ok = await requestConfirmation('Delete Log', `Delete "${log.food_name || 'this entry'}" from ${log.date}?`);
        if (!ok) return;
        await logRepo.deleteLog(log.id);
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast('Log deleted');
      },
      onDeleteWater: async (water) => {
        const ok = await requestConfirmation('Delete Water', `Delete this ${Math.round(water.amount_ml)}ml water entry?`);
        if (!ok) return;
        await waterRepo.deleteWaterLog(water.id);
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Deleted ${Math.round(water.amount_ml)}ml water entry`);
      },
      onDuplicateWater: async (water) => {
        // §5d: water duplicates exactly like food — same amount, same day.
        await waterRepo.insertWaterLog({
          date: water.date,
          amount_ml: water.amount_ml,
          source: water.source as any,
          note: water.note ?? undefined
        });
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Duplicated +${Math.round(water.amount_ml)}ml water`);
      },
      onEditWater: (water) => openWaterEditModal(water),
      onToggleDayOrder() {
        journalDayOrder = journalDayOrder === 'desc' ? 'asc' : 'desc';
        renderJournalIfVisible();
      },
      onEditDayNote: (date) => openDayNoteModal(date),
      onToggleLowAccuracy: async (date, current) => {
        await dailyRecordRepo.setLowAccuracy(date, !current);
        dataVersion++;
        await renderJournalIfVisible();
        showToast(!current ? 'Day flagged low accuracy' : 'Low-accuracy flag cleared');
      },
      onToggleSelectMode() {
        selectMode = !selectMode;
        if (!selectMode) selection.clear();
        renderJournalIfVisible();
      },
      onToggleSelect(id) {
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
        renderJournalIfVisible();
      },
      onSelectMany(ids) {
        const allSelected = ids.every(id => selection.has(id));
        for (const id of ids) {
          if (allSelected) selection.delete(id);
          else selection.add(id);
        }
        renderJournalIfVisible();
      },
      onBulkChangeDate(ids) {
        const input = document.getElementById('bulk-date-input') as HTMLInputElement | null;
        const countEl = document.getElementById('bulk-date-count');
        if (input) input.value = store.getState().selectedDate;
        if (countEl) countEl.textContent = `${ids.length} item(s) will move to a different date.`;
        pendingBulkIds = ids.filter(id => !journalWaters.some(w => w.id === id));
        openModalLayer('bulk-date-modal');
      },
      onBulkDuplicate: async (ids) => {
        const foodIds = ids.filter(id => !journalWaters.some(w => w.id === id));
        const date = store.getState().selectedDate;
        for (const id of foodIds) {
          const target = journalLogsById.get(id)?.date ?? date;
          await logRepo.duplicateLog(id, target);
        }
        selectMode = false;
        selection.clear();
        await refreshStateForDate(date);
        showToast(`Duplicated ${foodIds.length} item(s)`);
      },
      onBulkDelete: async (ids) => {
        const ok = await requestConfirmation('Delete Items', `Delete ${ids.length} selected item(s)? This cannot be undone.`);
        if (!ok) return;
        for (const id of ids) {
          if (journalWaters.some(w => w.id === id)) await waterRepo.deleteWaterLog(id);
          else await logRepo.deleteLog(id);
        }
        selectMode = false;
        selection.clear();
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Deleted ${ids.length} item(s)`);
      },
      onLoadMore() {
        journalDaysShown += JOURNAL_PAGE_DAYS;
        renderJournalIfVisible();
      },
      onToggleCombo(key) {
        if (expandedComboKeys.has(key)) expandedComboKeys.delete(key);
        else expandedComboKeys.add(key);
        renderJournalIfVisible();
      },
      onDeleteComboLogs: async (cluster) => {
        const ok = await requestConfirmation(
          'Delete Combo',
          `Delete all ${cluster.logs.length} items of "${cluster.name}" from the logs?`
        );
        if (!ok) return;
        for (const log of cluster.logs) await logRepo.deleteLog(log.id);
        expandedComboKeys.delete(cluster.key);
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Deleted combo "${cluster.name}"`);
      },
      onEditComboTemplate: (comboId) => {
        // §5d: editing now opens the full-screen combo builder.
        openComboBuilderView(comboId);
      }
    });
  } catch (err) {
    console.error('Journal render failed:', err);
  }
}

/** Log-id → log map for the last fetched journal window (bulk duplicate targets). */
let journalLogsById = new Map<string, JournalFoodLog>();

let pendingBulkIds: string[] = [];

/** Day notes (§5b item 5 / §5c-F): editable per journal day-group header. */
function setupDayNoteHandlers() {
  document.getElementById('btn-note-ok')?.addEventListener('click', async () => {
    const input = document.getElementById('day-note-input') as HTMLTextAreaElement | null;
    if (!input) return;
    const noteDate = noteTargetDate;
    await dailyRecordRepo.setNote(noteDate, input.value.trim() || null);
    closeModalLayer('note-modal');
    dataVersion++;
    if (store.getState().selectedDate === noteDate) {
      await refreshStateForDate(noteDate);
    } else {
      await renderJournalIfVisible();
    }
    showToast('Day note saved');
  });

  document.getElementById('btn-note-cancel')?.addEventListener('click', () => closeModalLayer('note-modal'));
}

let noteTargetDate = getTodayDateString();

// ---------- Water edit (§5d: amount + date ONLY — no macros, they make no sense) ----------

function openWaterEditModal(water: JournalWater) {
  const idEl = document.getElementById('water-edit-id') as HTMLInputElement | null;
  const amountEl = document.getElementById('water-edit-amount') as HTMLInputElement | null;
  const dateEl = document.getElementById('water-edit-date') as HTMLInputElement | null;
  if (!idEl || !amountEl || !dateEl) return;
  idEl.value = water.id;
  amountEl.value = String(Math.round(water.amount_ml));
  dateEl.value = water.date;
  openModalLayer('water-edit-modal');
}

function setupWaterEditHandlers() {
  document.getElementById('btn-water-edit-cancel')?.addEventListener('click', () => closeModalLayer('water-edit-modal'));

  document.getElementById('btn-water-edit-ok')?.addEventListener('click', async () => {
    const idEl = document.getElementById('water-edit-id') as HTMLInputElement | null;
    const amountEl = document.getElementById('water-edit-amount') as HTMLInputElement | null;
    const dateEl = document.getElementById('water-edit-date') as HTMLInputElement | null;
    const id = idEl?.value;
    const amount = parseFloat(amountEl?.value || '');
    const date = dateEl?.value;

    if (!id) return;
    if (!(amount > 0)) {
      showToast('Enter a valid water amount');
      return;
    }
    if (!date) {
      showToast('Pick a date');
      return;
    }

    const current = await waterRepo.getWaterById(id);
    await waterRepo.updateWaterLog(id, { amount_ml: amount, date });

    closeModalLayer('water-edit-modal');
    expandedLogId = null;
    historyWindowKey = '';
    await refreshStateForDate(date);
    if (current && current.date !== date) {
      await refreshStateForDate(current.date);
    }
    showToast(`Water entry updated · ${Math.round(amount)}ml on ${date}`);
  });
}

// ---------- Delete All Data (§5d: complete local wipe, double-guarded) ----------

function setupDeleteAllHandler() {
  document.getElementById('btn-delete-all')?.addEventListener('click', async () => {
    const ok = await requestConfirmation(
      'Delete All Data',
      'This permanently erases EVERYTHING — foods, logs, water entries, combos, goals and settings — from this device. It cannot be undone. Export a backup first! Continue?'
    );
    if (!ok) return;

    try {
      if (dbManager.isFallback()) {
        dbManager.replaceFallbackStore({});
      } else {
        const db = await dbManager.getConnection();
        await wipeAllData(db);
        await dbManager.saveWebStore();
      }

      historyWindowKey = '';
      builderFoodCache.clear();
      await refreshStateForDate(store.getState().selectedDate);
      await renderIndex();
      showToast('All data deleted');
    } catch (err) {
      console.error('Delete all failed:', err);
      showToast('Could not delete all data — try again');
    }
  });
}

function openDayNoteModal(date: string) {
  noteTargetDate = date;
  const input = document.getElementById('day-note-input') as HTMLTextAreaElement | null;
  if (input) input.value = '';
  openModalLayer('note-modal');
  dailyRecordRepo.getForRange(date, date).then(([rec]) => {
    if (input) input.value = rec?.note || '';
    input?.focus();
  });
}

function setupBulkDateHandlers() {
  document.getElementById('btn-bulk-date-cancel')?.addEventListener('click', () => closeModalLayer('bulk-date-modal'));
  document.getElementById('btn-bulk-date-ok')?.addEventListener('click', async () => {
    const input = document.getElementById('bulk-date-input') as HTMLInputElement | null;
    const target = input?.value;
    if (!target || pendingBulkIds.length === 0) {
      closeModalLayer('bulk-date-modal');
      return;
    }
    for (const id of pendingBulkIds) {
      await logRepo.updateLog(id, { date: target } as any);
    }
    const moved = pendingBulkIds.length;
    pendingBulkIds = [];
    selectMode = false;
    selection.clear();
    closeModalLayer('bulk-date-modal');
    historyWindowKey = '';
    await refreshStateForDate(target);
    showToast(`Moved ${moved} item(s) to ${target}`);
  });
}

// ---------- Edit screen (§5b item 2 — dedicated view; §5c-A real full-screen) ----------

async function openEditView(log: JournalFoodLog) {
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

  const editView = document.getElementById('view-edit');
  const previousView = currentViewId;
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
  tabController?.switchTabDirect(viewId);
}

function setupEditHandlers() {
  document.getElementById('btn-edit-back')?.addEventListener('click', () => closeLayer());

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

    const previousDate = current.date;
    historyWindowKey = '';
    closeLayer();
    await refreshStateForDate(date);
    if (date !== previousDate) {
      await refreshStateForDate(previousDate);
    }
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
    const splitDays = new Set<string>();
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
          confidence: row.estimatedSplit ? 0.5 : 1.0
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

      // §5c-4: days reconstructed from equal-split legacy aggregates are
      // estimates — flag them so the new low-accuracy UI/export shows it.
      if (row.estimatedSplit) splitDays.add(date);

      inserted++;
    }

    for (const date of splitDays) {
      await dailyRecordRepo.setLowAccuracy(date, true);
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

function teardownP2P() {
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
}

function closeP2PModal() {
  const modal = document.getElementById('p2p-modal');
  const wasOpen = modal?.classList.contains('active') ?? false;
  teardownP2P();
  if (wasOpen) closeModalLayer('p2p-modal');
}

async function onP2PScan() {
  if (p2pBusy || qrScanHandle) return;
  openModalLayer('qr-scan-modal', () => stopQrScan());
  const container = document.getElementById('qr-scan-container');
  if (!container) return;

  try {
    qrScanHandle = await startQrScan(container, (code) => {
      const input = document.getElementById('p2p-code-in') as HTMLTextAreaElement | null;
      if (input) input.value = code;
      stopQrScan();
      closeModalLayer('qr-scan-modal');
      onP2PConnect();
    });
  } catch (err) {
    console.error('QR scan failed:', err);
    closeModalLayer('qr-scan-modal');
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

  openModalLayer('p2p-modal', () => teardownP2P());

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
    closeModalLayer('qr-scan-modal');
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
