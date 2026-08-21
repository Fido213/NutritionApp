/**
 * History "selected day" breakdown (HANDOVER §5b items 1, 5, 6, 8 + water deletion).
 *
 * - Tapping a food log expands it inline with its actions (Edit / Duplicate /
   Delete) — replaces the old action-hub modal.
 * - Water entries are listed alongside food logs and can be deleted inline.
 * - Log notes render under the item name.
 * - A day-note row (daily_records.note) sits above the list; tap to edit.
 * - Multi-select mode supports Change Date / Duplicate / Delete — explicitly
 *   NO bulk edit.
 */
import { formatDisplayDate } from '@utils/dates';

export interface DayDetailLog {
  id: string;
  date: string;
  food_id?: string | null;
  food_name?: string;
  canonical_name?: string;
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  amount_g?: number | null;
  amount_ml?: number | null;
  note?: string | null;
  kind: 'food';
}

export interface DayDetailWater {
  id: string;
  date: string;
  amount_ml: number;
  source: string;
  note?: string | null;
  kind: 'water';
}

export interface DayDetailArgs {
  container: HTMLElement;
  selectedDate: string;
  logs: DayDetailLog[];
  waters: DayDetailWater[];
  dayNote: string | null;
  expandedLogId: string | null;
  selection: Set<string>;
  selectMode: boolean;
  onToggleExpand(logId: string): void;
  onEdit(log: DayDetailLog): void;
  onDuplicate(log: DayDetailLog): void;
  onDeleteFood(log: DayDetailLog): void;
  onDeleteWater(water: DayDetailWater): void;
  onEditDayNote(): void;
  onToggleSelectMode(): void;
  onToggleSelect(id: string): void;
  onBulkChangeDate(ids: string[]): void;
  onBulkDuplicate(ids: string[]): void;
  onBulkDelete(ids: string[]): void;
}

export function renderDayDetail(args: DayDetailArgs) {
  const {
    container, selectedDate, logs, waters, dayNote, expandedLogId, selection, selectMode,
    onToggleExpand, onEdit, onDuplicate, onDeleteFood, onDeleteWater,
    onEditDayNote, onToggleSelectMode, onToggleSelect, onBulkChangeDate, onBulkDuplicate, onBulkDelete
  } = args;

  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'day-detail-header';
  const title = document.createElement('h3');
  title.innerText = `Logs for ${formatDisplayDate(selectedDate)}`;
  header.appendChild(title);

  const selectBtn = document.createElement('button');
  selectBtn.className = 'day-detail-select-btn' + (selectMode ? ' active' : '');
  selectBtn.textContent = selectMode ? 'Cancel' : 'Select';
  selectBtn.addEventListener('click', onToggleSelectMode);
  header.appendChild(selectBtn);
  container.appendChild(header);

  // Day note row (§5b item 5)
  const noteRow = document.createElement('div');
  noteRow.className = 'day-note-row';
  const noteText = document.createElement('span');
  noteText.className = 'day-note-text' + (dayNote ? '' : ' empty');
  noteText.textContent = dayNote || '+ Add day note';
  noteRow.appendChild(noteText);

  if (!selectMode) {
    const noteBtn = document.createElement('button');
    noteBtn.className = 'day-note-btn';
    noteBtn.textContent = '✎';
    noteBtn.addEventListener('click', onEditDayNote);
    noteRow.appendChild(noteBtn);
  }
  container.appendChild(noteRow);

  type Row = DayDetailLog | DayDetailWater;
  const rows: Row[] = [
    ...logs,
    ...waters.map<DayDetailWater>(w => ({ ...w, kind: 'water' }))
  ];

  if (selectMode && selection.size > 0) {
    const bulkBar = document.createElement('div');
    bulkBar.className = 'bulk-bar';

    const ids = [...selection];
    const selectedRows = rows.filter(r => selection.has(r.id));
    const anyFood = selectedRows.some(r => r.kind === 'food');

    const mkBtn = (label: string, enabled: boolean, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.className = ('bulk-btn ' + cls).trim();
      b.textContent = label;
      b.disabled = !enabled;
      if (enabled) b.addEventListener('click', fn);
      bulkBar.appendChild(b);
    };
    mkBtn('Change Date', anyFood, () => onBulkChangeDate(ids));
    mkBtn('Duplicate', anyFood, () => onBulkDuplicate(ids));
    mkBtn('Delete', true, () => onBulkDelete(ids), 'danger');
    container.appendChild(bulkBar);
  }

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'day-detail-empty';
    empty.textContent = 'No entries logged on this date.';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'log-list';

  for (const row of rows) {
    if (row.kind === 'water') {
      list.appendChild(buildWaterRow(row, selectMode, selection.has(row.id), onToggleSelect, onDeleteWater));
    } else {
      list.appendChild(buildFoodRow(
        row, selectMode, selection.has(row.id), row.id === expandedLogId,
        onToggleSelect, onToggleExpand, onEdit, onDuplicate, onDeleteFood
      ));
    }
  }

  container.appendChild(list);
}

function buildWaterRow(
  w: DayDetailWater, selectMode: boolean, selected: boolean,
  onToggleSelect: (id: string) => void, onDelete: (w: DayDetailWater) => void
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'log-item water-item' + (selected ? ' selected' : '');

  if (selectMode) {
    item.appendChild(buildCheckbox(selected, () => onToggleSelect(w.id)));
    item.classList.add('selectable');
  }

  const main = document.createElement('div');
  main.className = 'log-main';
  const name = document.createElement('span');
  name.className = 'log-name water-name';
  name.textContent = `💧 Water (${w.source})`;
  const amt = document.createElement('span');
  amt.className = 'log-water';
  amt.textContent = `${Math.round(w.amount_ml)} ml`;
  main.append(name, amt);
  item.appendChild(main);

  if (!selectMode) {
    const actions = document.createElement('div');
    actions.className = 'log-actions';
    const del = document.createElement('button');
    del.className = 'log-action-btn danger';
    del.textContent = 'Delete';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(w); });
    actions.appendChild(del);
    item.appendChild(actions);
  }
  return item;
}

function buildFoodRow(
  log: DayDetailLog, selectMode: boolean, selected: boolean, expanded: boolean,
  onToggleSelect: (id: string) => void, onToggleExpand: (id: string) => void,
  onEdit: (l: DayDetailLog) => void, onDuplicate: (l: DayDetailLog) => void, onDelete: (l: DayDetailLog) => void
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'log-item' + (expanded ? ' expanded' : '') + (selected ? ' selected' : '');

  if (selectMode) {
    item.appendChild(buildCheckbox(selected, () => onToggleSelect(log.id)));
    item.classList.add('selectable');
  }

  const main = document.createElement('div');
  main.className = 'log-main';
  const name = document.createElement('span');
  name.className = 'log-name';
  name.textContent = log.food_name || log.canonical_name || 'Logged Item';
  const cal = document.createElement('span');
  cal.className = 'log-cal';
  cal.textContent = log.calories ? `${Math.round(log.calories)} kcal` : `${Math.round(log.amount_ml || log.amount_g || 0)} ml`;
  main.append(name, cal);
  item.appendChild(main);

  if (log.note) {
    const noteLine = document.createElement('div');
    noteLine.className = 'log-note-line';
    noteLine.textContent = log.note;
    item.appendChild(noteLine);
  }

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

  if (expanded) {
    const actions = document.createElement('div');
    actions.className = 'log-actions';
    const edit = document.createElement('button');
    edit.className = 'log-action-btn';
    edit.textContent = 'Edit';
    edit.addEventListener('click', (e) => { e.stopPropagation(); onEdit(log); });
    const dup = document.createElement('button');
    dup.className = 'log-action-btn blue';
    dup.textContent = 'Duplicate';
    dup.addEventListener('click', (e) => { e.stopPropagation(); onDuplicate(log); });
    const del = document.createElement('button');
    del.className = 'log-action-btn danger';
    del.textContent = 'Delete';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(log); });
    actions.append(edit, dup, del);
    item.appendChild(actions);
  }

  item.addEventListener('click', () => {
    if (selectMode) onToggleSelect(log.id);
    else onToggleExpand(log.id);
  });
  return item;
}

function buildCheckbox(checked: boolean, onToggle: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'select-box' + (checked ? ' checked' : '');
  box.textContent = checked ? '✓' : '';
  box.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  return box;
}
