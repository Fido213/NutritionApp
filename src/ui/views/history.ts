import { getScoreColorClass } from '@domain/scoring';
import { formatDateISO, getDaysInMonth, getFirstDayOfMonthOffset, getDateRange } from '@utils/dates';
import type { HistoryDay } from '@services/history/history-window';

export type HistoryViewMode = 'week' | 'month' | 'year';

export interface HistoryRenderArgs {
  days: Map<string, HistoryDay>;
  view: HistoryViewMode;
  anchor: string;
  selectedDate: string;
}

/**
 * Render the History view: navigation header (◀ ▶ paging), the consistency
 * heatmap (week / month / year grids, per the legacy app) and the calorie
 * trend chart. The selected-day breakdown lives in day-detail.ts.
 *
 * The window is anchored to `anchor` (independent of the selected date), so
 * clicking a day only moves the highlight and the detail list — it never
 * re-anchors the visible range.
 */
export function renderHistory(args: HistoryRenderArgs) {
  const { days, view, anchor, selectedDate } = args;

  const anchorDate = new Date(anchor + 'T00:00:00');
  const calendarEl = document.getElementById('calendar-container');
  const scoreBadgeEl = document.getElementById('heatmap-score-badge');

  const createBlock = (dateStr: string, isTiny = false): HTMLElement => {
    const day = days.get(dateStr);
    const colorClass = day?.hasData ? getScoreColorClass(day.score).replace('--', '') : 'score-empty';
    const block = document.createElement('div');
    block.className = `${isTiny ? 'day-dot' : 'cal-block'} ${colorClass}`;
    if (dateStr === selectedDate) block.classList.add('selected');

    if (!isTiny) {
      const label = document.createElement('span');
      label.className = 'day-label';
      label.innerText = dateStr.split('-')[2];
      block.appendChild(label);
    }

    block.addEventListener('click', () => {
      const event = new CustomEvent('select-history-date', { detail: dateStr });
      window.dispatchEvent(event);
    });
    return block;
  };

  if (calendarEl) {
    calendarEl.innerHTML = '';

    // 1. Navigation header (paging ◀ ▶ per legacy app)
    const navTitle = view === 'week'
      ? '7-Day Log'
      : view === 'month'
        ? anchorDate.toLocaleString('default', { month: 'long', year: 'numeric' })
        : String(anchorDate.getFullYear());

    const nav = document.createElement('div');
    nav.className = 'history-nav';
    const prev = document.createElement('button');
    prev.dataset.nav = '-1';
    prev.textContent = '◀';
    const next = document.createElement('button');
    next.dataset.nav = '1';
    next.textContent = '▶';
    const title = document.createElement('span');
    title.className = 'history-nav-title';
    title.textContent = navTitle;
    nav.append(prev, title, next);
    calendarEl.appendChild(nav);

    prev.addEventListener('click', () => window.dispatchEvent(new CustomEvent('history-nav', { detail: -1 })));
    next.addEventListener('click', () => window.dispatchEvent(new CustomEvent('history-nav', { detail: 1 })));

    // 2. Heatmap grid
    const grid = document.createElement('div');
    grid.className = `heatmap heatmap-${view}`;
    calendarEl.appendChild(grid);

    if (view === 'week') {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(anchorDate);
        d.setDate(d.getDate() - i);
        grid.appendChild(createBlock(formatDateISO(d)));
      }
    } else if (view === 'month') {
      const year = anchorDate.getFullYear();
      const month = anchorDate.getMonth();
      ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(day => {
        const header = document.createElement('div');
        header.style.textAlign = 'center';
        header.style.fontSize = '12px';
        header.style.color = 'var(--text-dim)';
        header.style.fontWeight = '800';
        header.textContent = day;
        grid.appendChild(header);
      });
      const firstDay = getFirstDayOfMonthOffset(year, month);
      for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement('div'));
      const count = getDaysInMonth(year, month);
      for (let d = 1; d <= count; d++) {
        grid.appendChild(createBlock(formatDateISO(new Date(year, month, d))));
      }
    } else {
      const year = anchorDate.getFullYear();
      for (let m = 0; m < 12; m++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'month-block';

        const monthTitle = document.createElement('div');
        monthTitle.className = 'month-title';
        monthTitle.textContent = new Date(year, m, 1).toLocaleString('default', { month: 'short' });

        const daysGrid = document.createElement('div');
        daysGrid.className = 'month-days';

        const count = getDaysInMonth(year, m);
        for (let d = 1; d <= count; d++) {
          daysGrid.appendChild(createBlock(formatDateISO(new Date(year, m, d)), true));
        }

        wrapper.appendChild(monthTitle);
        wrapper.appendChild(daysGrid);
        grid.appendChild(wrapper);
      }
    }
  }

  if (scoreBadgeEl) {
    const day = days.get(selectedDate);
    const currentScoreVal = day?.hasData ? day.score : 0;
    scoreBadgeEl.innerText = `Score: ${currentScoreVal > 0 ? '+' : ''}${currentScoreVal}`;
  }

  // 3. Trend chart (calorie ratio bars per visible data day; year view shows stats)
  const chartEl = document.getElementById('weekly-chart');
  if (chartEl) {
    chartEl.innerHTML = '';

    if (view === 'year') {
      chartEl.style.display = 'block';
      const year = anchorDate.getFullYear();
      let totalDays = 0, sumCal = 0, sumWater = 0;
      days.forEach((day, dateStr) => {
        if (dateStr.startsWith(String(year)) && day.hasData) {
          totalDays++;
          sumCal += day.totals.calories;
          sumWater += day.hydration.effectiveTotal;
        }
      });
      const avgCal = totalDays ? Math.round(sumCal / totalDays) : 0;
      const liters = (sumWater / 1000).toFixed(1);
      chartEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; width:100%; text-align:center; padding: 10px 5px;">
          <div><span style="font-size:22px; font-weight:800; color:var(--accent-glow);">${totalDays}</span><br><span style="font-size:11px; color:var(--text-dim); text-transform:uppercase;">Days Tracked</span></div>
          <div><span style="font-size:22px; font-weight:800; color:var(--pro);">${avgCal}</span><br><span style="font-size:11px; color:var(--text-dim); text-transform:uppercase;">Avg Kcal</span></div>
          <div><span style="font-size:22px; font-weight:800; color:var(--water);">${liters}L</span><br><span style="font-size:11px; color:var(--text-dim); text-transform:uppercase;">Total Hydration</span></div>
        </div>
      `;
    } else {
      chartEl.style.display = 'flex';
      const visibleDates = view === 'week'
        ? getDateRange(anchor, 7)
        : Array.from({ length: getDaysInMonth(anchorDate.getFullYear(), anchorDate.getMonth()) },
            (_, i) => formatDateISO(new Date(anchorDate.getFullYear(), anchorDate.getMonth(), i + 1)));
      visibleDates.forEach(dateStr => {
        const bar = document.createElement('div');
        bar.className = 'chart-bar';
        const day = days.get(dateStr);
        if (day?.hasData && day.targets.caloriesTarget > 0) {
          const pct = Math.min((day.totals.calories / day.targets.caloriesTarget) * 100, 100);
          bar.style.height = `${Math.max(pct, 3)}%`;
          bar.title = `${dateStr}: ${Math.round(day.totals.calories)} / ${day.targets.caloriesTarget} kcal`;
        } else {
          bar.style.height = '0%';
        }
        chartEl.appendChild(bar);
      });
      chartEl.style.gap = visibleDates.length > 20 ? '2px' : '8px';
    }
  }

  // The selected-day log breakdown (day-view-container) is rendered by
  // renderDayDetail in main.ts — it needs live water + note data.
}