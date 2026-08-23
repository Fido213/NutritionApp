import { store } from '../state';
import { renderCalorieRing } from '../components/ring';
import { renderMacroBar } from '../components/macro-bar';
import { formatWater } from '@utils/format';
import { getScoreColorClass } from '@domain/scoring';

export function renderDashboard() {
  const state = store.getState();
  const { todayTotals, todayGoals, todayHydration, currentScore, selectedDate } = state;

  // 0. Date + day-score header above the ring card (§5b items 10–11 / §5c-E / §5d:
  //    the real date instead of "Today", and the bare tier-colored score number).
  const dateEl = document.getElementById('dash-date');
  if (dateEl) dateEl.innerText = formatDashboardDate(selectedDate);

  const scoreBadge = document.getElementById('dash-score-badge');
  if (scoreBadge) {
    const score = currentScore?.score ?? 0;
    scoreBadge.innerText = `${score > 0 ? '+' : ''}${score}`;
    // Tier colour drives the text; no border (§5d feedback).
    scoreBadge.style.color = `var(${getScoreColorClass(score)})`;
  }

  // 1. Calorie Ring
  renderCalorieRing(todayTotals.calories, todayGoals.caloriesTarget);

  // 2. Macro Progress Bars
  renderMacroBar('bar-pro', 'ui-pro-text', 'ui-pro-delta', todayTotals.proteinG, todayGoals.proteinTarget, 'g', true);
  renderMacroBar('bar-carb', 'ui-carb-text', 'ui-carb-delta', todayTotals.carbsG, todayGoals.carbsTarget, 'g', false);
  renderMacroBar('bar-fat', 'ui-fat-text', 'ui-fat-delta', todayTotals.fatG, todayGoals.fatTarget, 'g', false);

  // 3. Hydration Card & Gating Breakdown
  const waterBarEl = document.getElementById('bar-water');
  const waterTextEl = document.getElementById('ui-water-text');
  const waterDeltaEl = document.getElementById('ui-water-delta');

  const expValEl = document.getElementById('w-exp-val');
  const drkValEl = document.getElementById('w-drk-val');
  const fdValEl = document.getElementById('w-fd-val');

  if (expValEl) expValEl.innerText = Math.round(todayHydration.explicit).toString();
  if (drkValEl) drkValEl.innerText = Math.round(todayHydration.drink).toString();
  if (fdValEl) fdValEl.innerText = Math.round(todayHydration.food).toString();

  const waterRatio = todayGoals.waterTarget > 0 ? todayHydration.effectiveTotal / todayGoals.waterTarget : 0;
  const waterPct = Math.round(waterRatio * 100);

  if (waterTextEl) {
    waterTextEl.innerText = `${formatWater(todayHydration.effectiveTotal)} / ${formatWater(todayGoals.waterTarget)} (${waterPct}%)`;
  }

  if (waterBarEl) {
    waterBarEl.style.width = `${Math.min(waterRatio * 100, 100)}%`;
  }

  if (waterDeltaEl) {
    waterDeltaEl.classList.remove('under', 'on-target', 'over');
    if (waterRatio < 0.80) {
      waterDeltaEl.innerText = '↓';
      waterDeltaEl.classList.add('under');
    } else {
      waterDeltaEl.innerText = '✓';
      waterDeltaEl.classList.add('on-target');
    }
  }
}

/** The actual date, always: "Sat, Aug 23" (§5d — no more "Today" label). */
function formatDashboardDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
