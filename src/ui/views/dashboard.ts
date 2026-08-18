import { store } from '../state';
import { renderCalorieRing } from '../components/ring';
import { renderMacroBar } from '../components/macro-bar';
import { formatWater } from '@utils/format';

export function renderDashboard() {
  const state = store.getState();
  const { todayTotals, todayGoals, todayHydration, recents } = state;

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

  // 4. 1-Tap Recents
  const recentsContainer = document.getElementById('recents-container');
  if (recentsContainer) {
    recentsContainer.innerHTML = '';
    if (!recents || recents.length === 0) {
      recentsContainer.innerHTML = '<span style="color: var(--text-dim); font-size: 12px;">No recents logged yet.</span>';
    } else {
      recents.slice(0, 5).forEach((item: any) => {
        const pill = document.createElement('button');
        pill.className = 'pill';
        pill.innerText = item.canonical_name || item.canonicalName || item.name;
        pill.addEventListener('click', () => {
          // Trigger quick log for recent food
          const event = new CustomEvent('quick-log-recent', { detail: item });
          window.dispatchEvent(event);
        });
        recentsContainer.appendChild(pill);
      });
    }
  }
}
