/**
 * EverydayFuel — application composition root.
 *
 * Since the pass-21 decomposition, main.ts only:
 * 1. builds the shared AppContext (repositories + services),
 * 2. wires the global navigation (dock / gear / tab controller),
 * 3. registers the dashboard-level listeners (water quick buttons, manual
 *    log, score explainer, text bar, numpad),
 * 4. hands each feature area its own module under src/ui/features/.
 *
 * Feature logic lives in src/ui/features/*; dialogs + modal layer bridge in
 * src/ui/dialogs.ts + src/ui/modal-layers.ts; state refresh + history window
 * in src/ui/app-refresh.ts.
 */
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

import { store } from './ui/state';
import { ctx } from './ui/context';
import { renderDashboard } from './ui/views/dashboard';
import { renderGoals, readGoalsForm } from './ui/views/goals';
import {
  setupTabNavigation,
  initNavStack,
  initNativeBackButton,
  animateViewIn,
  tabDirection,
  ViewId
} from './ui/nav';
import { openModalLayer, closeModalLayer } from './ui/modal-layers';
import { setupDialogModals } from './ui/dialogs';
import { showToast } from './ui/components/toast';
import { getScoreColorClass } from '@domain/scoring';
import { getTodayDateString } from '@utils/dates';
import {
  refreshStateForDate,
  refreshVisibleHistoryWindow,
  setupHistoryViewHandlers
} from './ui/app-refresh';
import { Capacitor } from '@capacitor/core';
import { GemmaClient } from '@services/ai/gemma-client';
import { FoodService } from '@services/food/food-service';
import { logTextInput } from './ui/features/logging-actions';
import { setupIndexHandlers, renderIndex, invalidateIndexCaches } from './ui/features/index-screen';
import { setupComboBuilderHandlers } from './ui/features/combo-builder';
import { setupScannerHandlers } from './ui/features/scanner';
import { setupJournalHandlers } from './ui/features/journal';
import { setupEditHandlers } from './ui/features/edit-log';
import {
  openExportModal,
  setupExportHandlers,
  setupImportHandlers,
  setupBackupHandler,
  setupRestoreHandler,
  setupDeleteAllHandler
} from './ui/features/data-tools';

let numpadBuffer = '';

async function initApp() {
  console.log('Initializing EverydayFuel...');

  try {
    // 1. Initialize SQLite Database
    const dbManager = DatabaseManager.getInstance();
    await dbManager.initialize();
    const db = await dbManager.getConnection();

    ctx.dbManager = dbManager;
    ctx.foodRepo = new FoodRepository(db);
    ctx.logRepo = new LogRepository(db);
    ctx.goalRepo = new GoalRepository(db);
    ctx.waterRepo = new WaterRepository(db);
    ctx.dailyRecordRepo = new DailyRecordRepository(db);
    ctx.comboRepo = new ComboRepository(db);
    ctx.barcodeRepo = new BarcodeRepository(db);
    ctx.observationRepo = new ObservationRepository(db);
    ctx.importRepo = new ImportRepository(db);
    ctx.gemmaClient = new GemmaClient();
    ctx.foodService = new FoodService(ctx.foodRepo, ctx.logRepo, ctx.observationRepo, ctx.waterRepo);

    console.log('SQLite database ready', {
      dailyRecordRepo: ctx.dailyRecordRepo,
      comboRepo: ctx.comboRepo,
      barcodeRepo: ctx.barcodeRepo
    });

    // 2. Load active goal
    let currentGoal = await ctx.goalRepo.getCurrentGoal();
    if (!currentGoal) {
      currentGoal = await ctx.goalRepo.createGoal({
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

    // 3. Subscribe store listeners to re-render views. Pass-22c perf: only
    // the ACTIVE view re-renders (hidden views cost DOM time for nothing);
    // each view renders itself when switched to.
    store.subscribe(() => {
      const isActive = (id: string) => document.getElementById(id)?.classList.contains('active-view');
      if (isActive('today')) renderDashboard();
      if (isActive('view-goals')) renderGoals();
    });

    // 4. Load initial state for selected date
    await refreshStateForDate(getTodayDateString());

    // 5. Setup UI Event Listeners & Navigation
    setupNavigation();
    void initNativeBackButton();
    setupModals();
    setupDialogModals();
    setupHistoryViewHandlers();
    setupExportHandlers();
    setupActionHandlers();
    setupIndexHandlers();
    setupComboBuilderHandlers();
    setupJournalHandlers();
    setupDeleteAllHandler();
    setupDashboardTextBar();
    setupNumpadHandlers();
    setupScannerHandlers();
    setupEditHandlers();
    setupImportHandlers();
    setupBackupHandler();
    setupRestoreHandler();

    // PWA installability (low#9): register minimal SW on web only.
    if ('serviceWorker' in navigator) {
      try {
        if (!Capacitor.isNativePlatform()) {
          navigator.serviceWorker.register('/sw.js').catch(() => {});
        }
      } catch { /* ignore */ }
    }

    showToast('EverydayFuel loaded (Local SQLite)', 2500);

  } catch (err) {
    console.error('App init failed:', err);
    showToast('Offline Mode: Web storage fallback');
  }
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
    const previousView = ctx.currentViewId;
    [todayView, indexView, historyView, goalsView].forEach(v => v?.classList.remove('active-view'));
    [dashBtn, indexBtn, logsBtn].forEach(b => b?.classList.remove('active'));

    let target: HTMLElement | null = null;
    if (viewId === 'today') {
      todayView?.classList.add('active-view');
      dashBtn?.classList.add('active');
      target = todayView;
      renderDashboard();
    } else if (viewId === 'index') {
      indexView?.classList.add('active-view');
      indexBtn?.classList.add('active');
      target = indexView;
    } else if (viewId === 'history') {
      historyView?.classList.add('active-view');
      logsBtn?.classList.add('active');
      target = historyView;
      refreshVisibleHistoryWindow();
    } else if (viewId === 'view-goals') {
      goalsView?.classList.add('active-view');
      target = goalsView;
      renderGoals();
    }
    // Assign BEFORE the data loads below — renderIndex/renderJournalIfVisible
    // guard on currentViewId.
    ctx.currentViewId = viewId;
    if (viewId === 'index') void renderIndex();
    // Direction-aware entrance animation for tab swipes / dock taps (§5c-7).
    if (target && previousView !== viewId) animateViewIn(target, tabDirection(previousView, viewId));
  }

  initNavStack();
  ctx.tabController = setupTabNavigation(switchTabInternal, () => ctx.currentViewId);

  dashBtn?.addEventListener('click', () => ctx.tabController!.switchTab('today'));
  indexBtn?.addEventListener('click', () => ctx.tabController!.switchTab('index'));
  logsBtn?.addEventListener('click', () => ctx.tabController!.switchTab('history'));
  sysBtn?.addEventListener('click', () => ctx.tabController!.switchTab('view-goals'));
}

function setupModals() {
  const openModal = (id: string) => openModalLayer(id);
  const closeModal = (id: string) => closeModalLayer(id);

  document.getElementById('btn-water-250')?.addEventListener('click', async () => {
    const date = store.getState().selectedDate;
    await ctx.waterRepo.insertWaterLog({ date, amount_ml: 250, source: 'explicit' });
    await ctx.dbManager.saveWebStore();
    await refreshStateForDate(date);
    showToast('Logged +250ml Water');
  });

  document.getElementById('btn-water-500')?.addEventListener('click', async () => {
    const date = store.getState().selectedDate;
    await ctx.waterRepo.insertWaterLog({ date, amount_ml: 500, source: 'explicit' });
    await ctx.dbManager.saveWebStore();
    await refreshStateForDate(date);
    showToast('Logged +500ml Water');
  });

  document.getElementById('btn-water-custom')?.addEventListener('click', () => openModal('numpad-modal'));
  document.getElementById('numpad-close')?.addEventListener('click', () => closeModal('numpad-modal'));

  // §5d: "Journal" is now the dedicated INDEX screen — switch to it as a tab.
  document.getElementById('btn-open-index')?.addEventListener('click', () => {
    ctx.tabController?.switchTab('index');
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
}

function setupActionHandlers() {
  document.getElementById('btn-save-goals')?.addEventListener('click', async () => {
    const newGoals = readGoalsForm();
    // §5c-12: saving updates the ACTIVE goal in place instead of closing it
    // and creating a fresh phase on every save (start/end dates and history
    // stay intact; the goal list no longer fills with "Updated Goal" rows).
    const current = await ctx.goalRepo.getCurrentGoal();
    if (current) {
      await ctx.goalRepo.updateGoalTargets(current.id, {
        calories_target: newGoals.caloriesTarget,
        protein_target: newGoals.proteinTarget,
        carbs_target: newGoals.carbsTarget,
        fat_target: newGoals.fatTarget,
        water_target: newGoals.waterTarget
      });
    } else {
      await ctx.goalRepo.createGoal({
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
    void openExportModal();
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

    const food = await ctx.foodRepo.insert({
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
    await ctx.logRepo.insertFoodLog({
      date,
      food_id: food.id,
      amount_g: amountG,
      calories,
      protein_g: proteinG,
      carbs_g: carbsG,
      fat_g: fatG,
      note
    });
    ctx.foodCache.set(food.id, food);
    invalidateIndexCaches();
    await ctx.dbManager.saveWebStore();

    document.getElementById('manual-log-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast(`Logged "${name}" (${Math.round(calories)} kcal)`);
  });

  window.addEventListener('select-history-date', (e: any) => {
    void refreshStateForDate(e.detail as string);
  });
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
      void submit();
    }
  });

  document.getElementById('btn-dash-text-log')?.addEventListener('click', () => { void submit(); });
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
    await ctx.waterRepo.insertWaterLog({ date, amount_ml: amount, source: 'explicit' });
    await ctx.dbManager.saveWebStore();
    document.getElementById('numpad-modal')?.classList.remove('active');
    await refreshStateForDate(date);
    showToast(`Logged +${amount}ml Water`);
  });
}

document.addEventListener('DOMContentLoaded', () => { void initApp(); });
