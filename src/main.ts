import { DatabaseManager } from '@data/database';
import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { GoalRepository } from '@data/repositories/goal.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { DailyRecordRepository } from '@data/repositories/daily-record.repo';
import { ComboRepository } from '@data/repositories/combo.repo';
import { BarcodeRepository } from '@data/repositories/barcode.repo';

import { store } from './ui/state';
import { renderDashboard } from './ui/views/dashboard';
import { renderHistory } from './ui/views/history';
import { renderGoals, readGoalsForm } from './ui/views/goals';
import { showToast } from './ui/components/toast';
import { calculateEffectiveHydration } from '@domain/hydration';
import { calculateScore } from '@domain/scoring';
import { getTodayDateString } from '@utils/dates';
import { generateCSV, downloadCSV } from '@services/export/csv-export';
import { GoalTargets } from '@domain/types';

let dbManager: DatabaseManager;
let foodRepo: FoodRepository;
let logRepo: LogRepository;
let goalRepo: GoalRepository;
let waterRepo: WaterRepository;
let dailyRecordRepo: DailyRecordRepository;
let comboRepo: ComboRepository;
let barcodeRepo: BarcodeRepository;

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
    setupActionHandlers();

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

  const scoresMap = new Map<string, number>();
  scoresMap.set(dateStr, score.score);
  renderHistory(logs, scoresMap);
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
}

document.addEventListener('DOMContentLoaded', initApp);
