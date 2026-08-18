import { store } from '../state';
import { getScoreColorClass } from '@domain/scoring';
import { formatDisplayDate, getDateRange } from '@utils/dates';

export function renderHistory(logsForSelectedDate: any[] = [], scoresByDate: Map<string, number> = new Map()) {
  const state = store.getState();
  const { selectedDate } = state;

  // 1. Trend Chart
  const chartEl = document.getElementById('weekly-chart');
  if (chartEl) {
    chartEl.innerHTML = '';
    const dateRange = getDateRange(selectedDate, 7);
    
    dateRange.forEach(dStr => {
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      const score = scoresByDate.get(dStr) || 0;
      const heightPct = Math.max(10, ((score + 4) / 9) * 100);
      bar.style.height = `${heightPct}%`;
      bar.title = `${dStr}: Score ${score}`;
      chartEl.appendChild(bar);
    });
  }

  // 2. Consistency Heatmap
  const calendarEl = document.getElementById('calendar-container');
  const scoreBadgeEl = document.getElementById('heatmap-score-badge');
  
  if (calendarEl) {
    calendarEl.innerHTML = '';
    calendarEl.className = 'heatmap heatmap-week';

    const dateRange = getDateRange(selectedDate, 28);
    dateRange.forEach(dStr => {
      const block = document.createElement('div');
      const score = scoresByDate.get(dStr);
      const colorClass = score !== undefined ? getScoreColorClass(score) : 'score-empty';
      
      block.className = `cal-block ${colorClass.replace('--', '')}`;
      if (dStr === selectedDate) block.classList.add('selected');

      const label = document.createElement('span');
      label.className = 'day-label';
      label.innerText = dStr.split('-')[2];
      block.appendChild(label);

      block.addEventListener('click', () => {
        const event = new CustomEvent('select-history-date', { detail: dStr });
        window.dispatchEvent(event);
      });

      calendarEl.appendChild(block);
    });
  }

  if (scoreBadgeEl) {
    const currentScoreVal = scoresByDate.get(selectedDate) ?? 0;
    scoreBadgeEl.innerText = `Score: ${currentScoreVal > 0 ? '+' : ''}${currentScoreVal}`;
  }

  // 3. Selected Day Log Breakdown List
  const dayContainerEl = document.getElementById('day-view-container');
  if (dayContainerEl) {
    dayContainerEl.innerHTML = '';

    const header = document.createElement('h3');
    header.style.margin = '16px 0 10px 0';
    header.style.color = 'var(--text-dim)';
    header.innerText = `Logs for ${formatDisplayDate(selectedDate)}`;
    dayContainerEl.appendChild(header);

    if (!logsForSelectedDate || logsForSelectedDate.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = 'var(--text-dim)';
      empty.style.fontSize = '14px';
      empty.innerText = 'No entries logged on this date.';
      dayContainerEl.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'log-list';

      logsForSelectedDate.forEach(log => {
        const item = document.createElement('div');
        item.className = 'log-item';

        const main = document.createElement('div');
        main.className = 'log-main';

        const name = document.createElement('span');
        name.className = 'log-name';
        name.innerText = log.food_name || log.canonical_name || log.food || 'Logged Item';

        const cal = document.createElement('span');
        cal.className = 'log-cal';
        cal.innerText = log.calories ? `${Math.round(log.calories)} kcal` : `${Math.round(log.amount_ml || 0)} ml`;

        main.appendChild(name);
        main.appendChild(cal);
        item.appendChild(main);

        if (log.calories) {
          const macros = document.createElement('div');
          macros.className = 'log-macros';
          macros.innerHTML = `
            <span style="color: var(--pro);">P: ${Math.round(log.protein_g || 0)}g</span>
            <span style="color: var(--carb);">C: ${Math.round(log.carbs_g || 0)}g</span>
            <span style="color: var(--fat);">F: ${Math.round(log.fat_g || 0)}g</span>
          `;
          item.appendChild(macros);
        }

        item.addEventListener('click', () => {
          const event = new CustomEvent('open-log-actions', { detail: log });
          window.dispatchEvent(event);
        });

        list.appendChild(item);
      });

      dayContainerEl.appendChild(list);
    }
  }
}
