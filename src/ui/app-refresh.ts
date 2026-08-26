/**
 * Deterministic state refresh + History window derivation.
 *
 * `refreshStateForDate` runs after EVERY data mutation (log/water/delete/
 * edit/goal/import/restore): it bumps `dataVersion`, recomputes the selected
 * day's totals/score/hydration through the domain pipeline, pushes them into
 * the store, and refreshes the visible history window so heatmap cells update
 * automatically.
 *
 * The history window (spec §20) is derived on demand — never stored as a
 * second dataset — and cached per `view|anchor|dataVersion`.
 */
import { store } from './state';
import { renderHistory, HistoryViewMode } from '@ui/views/history';
import { renderJournalIfVisible, setJournalWaters } from './features/journal';
import { calculateEffectiveHydration } from '@domain/hydration';
import { calculateScore } from '@domain/scoring';
import { GoalTargets } from '@domain/types';
import { getTodayDateString, formatDateISO } from '@utils/dates';
import {
  computeHistoryWindow,
  datesForRange,
  datesForMonth,
  datesForYear,
  mapGoalToTargets,
  HistoryDay
} from '@services/history/history-window';
import { ctx } from './context';

let historyWindow = new Map<string, HistoryDay>();
let historyView: HistoryViewMode = 'week';
let historyAnchor = getTodayDateString();
let historyWindowKey = '';
let dataVersion = 0;

export function bumpDataVersion() {
  dataVersion++;
}

/** Invalidate the cached window (bulk moves / restores change other days). */
export function invalidateHistoryWindow() {
  historyWindowKey = '';
}

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
  historyWindow = await computeHistoryWindow(dates, { goal: ctx.goalRepo, log: ctx.logRepo, water: ctx.waterRepo });
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

/** Wire the history view-mode buttons + paging events (called once by main.ts). */
export function setupHistoryViewHandlers() {
  document.getElementById('btn-view-week')?.addEventListener('click', () => setHistoryView('week'));
  document.getElementById('btn-view-month')?.addEventListener('click', () => setHistoryView('month'));
  document.getElementById('btn-view-year')?.addEventListener('click', () => setHistoryView('year'));

  window.addEventListener('history-nav', (e: any) => {
    shiftHistoryAnchor(e.detail);
    ensureHistoryWindow().then(() => renderHistoryView());
  });
}

/** Exposed for setupNavigation's tab switcher (switching to LOGS re-renders it). */
export function refreshVisibleHistoryWindow() {
  ensureHistoryWindow().then(() => renderHistoryView());
}

export async function refreshStateForDate(dateStr: string) {
  bumpDataVersion();
  // Pass-22c perf: these five reads are independent — run them as one
  // parallel batch instead of six sequential bridge round-trips (this runs
  // after EVERY action, so serial latency here was every tap's lag).
  const [goalRecord, totals, waterTotals, logs, waters] = await Promise.all([
    ctx.goalRepo.getGoalForDate(dateStr),
    ctx.logRepo.getDailyTotals(dateStr),
    ctx.waterRepo.getWaterTotalsBySource(dateStr),
    ctx.logRepo.getLogsForDate(dateStr),
    ctx.waterRepo.getWaterForDate(dateStr)
  ]);

  const goal: GoalTargets = goalRecord
    ? mapGoalToTargets(goalRecord)
    : { caloriesTarget: 2500, proteinTarget: 150, carbsTarget: 250, fatTarget: 80, waterTarget: 4000 };

  const hydration = calculateEffectiveHydration(
    waterTotals.explicit,
    waterTotals.drink,
    waterTotals.food,
    goal.waterTarget
  );

  const score = calculateScore(totals, goal, hydration);

  setJournalWaters(waters);

  // 1-Tap Recents query (HANDOVER §5a): agent-only debug hook, gated behind
  // window.__EF_DEBUG__ so production taps never pay for a console.debug.
  if ((window as any).__EF_DEBUG__ === true) {
    const recents = await ctx.foodRepo.fuzzySearch('', 5);
    console.debug('[debug] recents (UI hidden):', recents.map(r => r.canonical_name).join(', '));
  }

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
