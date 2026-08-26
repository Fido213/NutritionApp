/**
 * History "Logs" list (§5c-D redesign; §5d selected-day isolation).
 *
 * Chronological entries with the TIME shown per item, grouped under day
 * headers (weekday + date + running day-total kcal) and a per-item kcal +
 * P/C/F profile.
 *
 * - §5d: ONLY the selected date's group renders — picking Saturday never
 *   shows Friday below it, and there is no multi-day paging. A header toggle
 *   sorts day groups Newest-first / Oldest-first.
 * - Tapping a food log expands it inline with Edit / Duplicate / Delete.
 * - §5d: Water entries share the exact same UI — tap expands inline with
 *   Duplicate / Edit (amount + date ONLY) / Delete.
 * - Logged combos (ingredient logs sharing one combo observation) render as
 *   one collapsible row — tap to expand/collapse, NO dedicated close button
 *   (pass 22c) — with total macros on the row and a NOURISHMENT BREAKDOWN
 *   card: Duplicate (re-log every ingredient same day) / "Edit Combo" (opens
 *   the full-screen builder) / Delete All.
 * - Log notes render under the item name; day notes + the low-accuracy flag
 *   are editable per group header (§5c-3 / §5c-F).
 * - Multi-select mode supports Change Date / Duplicate / Delete — explicitly
 *   NO bulk edit. Selecting a combo selects all of its ingredient logs, and a
 *   pass-22 "All" button selects everything currently loaded.
 */

export interface JournalFoodLog {
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
  created_at?: string;
  observation_id?: string | null;
}

export interface JournalWater {
  id: string;
  date: string;
  amount_ml: number;
  source: string;
  note?: string | null;
  created_at?: string;
}

export interface ComboCluster {
  kind: 'combo';
  /** Unique render key (`combo:<observation_id>`). */
  key: string;
  comboId: string | null;
  name: string;
  logs: JournalFoodLog[];
  totalCalories: number;
  createdAt?: string;
}

export type JournalEntry =
  | ({ kind: 'food' } & JournalFoodLog)
  | ({ kind: 'water' } & JournalWater)
  | ComboCluster;

export interface JournalGroup {
  date: string;
  weekday: string;
  displayDate: string;
  isSelected: boolean;
  totalKcal: number;
  note: string | null;
  lowAccuracy: boolean;
  entries: JournalEntry[];
}

export interface DayDetailArgs {
  container: HTMLElement;
  selectedDate: string;
  groups: JournalGroup[];
  /** Day-group ordering: 'desc' = newest first (default), 'asc' = oldest first (§5d). */
  dayOrder: 'desc' | 'asc';
  expandedLogId: string | null;
  expandedComboKeys: Set<string>;
  selection: Set<string>;
  selectMode: boolean;
  onToggleExpand(logId: string): void;
  onEdit(log: JournalFoodLog): void;
  onDuplicate(log: JournalFoodLog): void;
  onDeleteFood(log: JournalFoodLog): void;
  onDeleteWater(water: JournalWater): void;
  onDuplicateWater(water: JournalWater): void;
  onEditWater(water: JournalWater): void;
  onToggleDayOrder(): void;
  onEditDayNote(date: string): void;
  onToggleLowAccuracy(date: string, current: boolean): void;
  onToggleSelectMode(): void;
  onToggleSelect(id: string): void;
  onSelectMany(ids: string[]): void;
  /** Pass 22: force-select every loaded entry (foods, water, combo members). */
  onSelectAll(ids: string[]): void;
  /** Pass 22: duplicate a logged combo — every ingredient log re-logged same day. */
  onDuplicateCombo(cluster: ComboCluster): void;
  onBulkChangeDate(ids: string[]): void;
  onBulkDuplicate(ids: string[]): void;
  onBulkDelete(ids: string[]): void;
  onToggleCombo(key: string): void;
  onDeleteComboLogs(cluster: ComboCluster): void;
  onEditComboTemplate(comboId: string): void;
}

/** Local HH:MM from a stored ISO timestamp ('' when unknown). */
export function formatLogTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function entryTime(entry: JournalEntry): number {
  const iso = entry.kind === 'combo' ? entry.createdAt : entry.created_at;
  const t = iso ? new Date(iso).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

export function renderDayDetail(args: DayDetailArgs) {
  const {
    container, groups, dayOrder, expandedLogId, expandedComboKeys,
    selection, selectMode,
    onToggleExpand, onEdit, onDuplicate, onDeleteFood, onDeleteWater,
    onDuplicateWater, onEditWater, onToggleDayOrder,
    onEditDayNote, onToggleLowAccuracy, onToggleSelectMode, onToggleSelect, onSelectMany, onSelectAll,
    onBulkChangeDate, onBulkDuplicate, onBulkDelete,
    onToggleCombo, onDeleteComboLogs, onEditComboTemplate, onDuplicateCombo
  } = args;

  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'day-detail-header';
  const title = document.createElement('h3');
  title.innerText = 'Logs';
  header.appendChild(title);

  const headerBtns = document.createElement('div');
  headerBtns.style.cssText = 'display:flex;gap:6px;align-items:center;';

  // §5d: day-group ordering — newest first (default) or oldest first.
  const orderBtn = document.createElement('button');
  orderBtn.className = 'day-order-btn' + (dayOrder === 'asc' ? ' active' : '');
  orderBtn.title = dayOrder === 'desc'
    ? 'Showing newest days first — tap to sort oldest first'
    : 'Showing oldest days first — tap to sort newest first';
  orderBtn.textContent = dayOrder === 'desc' ? 'Newest ▾' : 'Oldest ▴';
  orderBtn.addEventListener('click', onToggleDayOrder);
  headerBtns.appendChild(orderBtn);

  // Pass 22: every loaded entry id — foods, waters, and all combo member logs
  // (deduped) — for the select-mode "All" shortcut.
  const allLoadedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const g of groups) {
    for (const e of g.entries) {
      const ids = e.kind === 'combo' ? e.logs.map(l => l.id) : [e.id];
      for (const id of ids) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allLoadedIds.push(id);
        }
      }
    }
  }

  const selectBtn = document.createElement('button');
  selectBtn.className = 'day-detail-select-btn' + (selectMode ? ' active' : '');
  selectBtn.textContent = selectMode ? 'Cancel' : 'Select';
  selectBtn.addEventListener('click', onToggleSelectMode);
  headerBtns.appendChild(selectBtn);

  if (selectMode && allLoadedIds.length > 0) {
    const allBtn = document.createElement('button');
    allBtn.className = 'day-order-btn';
    allBtn.title = 'Select everything currently loaded';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => onSelectAll(allLoadedIds));
    headerBtns.appendChild(allBtn);
  }
  header.appendChild(headerBtns);
  container.appendChild(header);

  if (selectMode && selection.size > 0) {
    const bulkBar = document.createElement('div');
    bulkBar.className = 'bulk-bar';

    const ids = [...selection];
    // Water ids cannot move/duplicate — the callers filter them via journalWaters.
    const mkBtn = (label: string, enabled: boolean, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.className = ('bulk-btn ' + cls).trim();
      b.textContent = label;
      b.disabled = !enabled;
      if (enabled) b.addEventListener('click', fn);
      bulkBar.appendChild(b);
    };
    mkBtn('Change Date', true, () => onBulkChangeDate(ids));
    mkBtn('Duplicate', true, () => onBulkDuplicate(ids));
    mkBtn('Delete', true, () => onBulkDelete(ids), 'danger');
    container.appendChild(bulkBar);
  }

  if (groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'day-detail-empty';
    empty.textContent = 'Nothing logged in this period yet.';
    container.appendChild(empty);
  }

  // §5d: honour the day ordering — newest-first (default) or oldest-first.
  const ordered = [...groups].sort((a, b) =>
    dayOrder === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)
  );

  for (const group of ordered) {
    container.appendChild(buildGroup(group));
  }

  /* ---------- builders ---------- */

  function buildGroup(group: JournalGroup): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'journal-group' + (group.isSelected ? ' selected-day' : '');

    const head = document.createElement('div');
    head.className = 'group-header';

    const dateCol = document.createElement('div');
    dateCol.className = 'group-date';
    const weekday = document.createElement('span');
    weekday.className = 'group-weekday';
    weekday.textContent = group.weekday;
    const sub = document.createElement('span');
    sub.className = 'group-sub';
    sub.textContent = group.note
      ? `${group.displayDate} · 📝 ${group.note}`
      : group.displayDate;
    dateCol.append(weekday, sub);
    head.appendChild(dateCol);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '6px';

    if (!selectMode) {
      const lowacc = document.createElement('button');
      lowacc.className = 'lowacc-chip' + (group.lowAccuracy ? ' active' : '');
      lowacc.title = 'Marks this day as estimated / low accuracy (also shown in exports)';
      lowacc.textContent = group.lowAccuracy ? '⚠ Low Accuracy' : '⚠';
      lowacc.addEventListener('click', (e) => { e.stopPropagation(); onToggleLowAccuracy(group.date, group.lowAccuracy); });
      right.appendChild(lowacc);

      const noteBtn = document.createElement('button');
      noteBtn.className = 'day-note-btn';
      noteBtn.textContent = '✎';
      noteBtn.title = 'Day note';
      noteBtn.addEventListener('click', (e) => { e.stopPropagation(); onEditDayNote(group.date); });
      right.appendChild(noteBtn);
    }

    const kcal = document.createElement('span');
    kcal.className = 'group-kcal';
    kcal.textContent = `${Math.round(group.totalKcal)} kcal`;
    right.appendChild(kcal);

    head.appendChild(right);
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'log-list';

    // §5d/pass-22c: the window is a single selected day, so Newest/Oldest
    // orders the ENTRIES within the day (chronological ⇄ newest-first).
    const sorted = [...group.entries].sort((a, b) =>
      dayOrder === 'asc' ? entryTime(a) - entryTime(b) : entryTime(b) - entryTime(a)
    );
    for (const entry of sorted) {
      if (entry.kind === 'water') {
        list.appendChild(buildWaterRow(entry, group.date));
      } else if (entry.kind === 'combo') {
        list.appendChild(buildComboRow(entry));
      } else {
        list.appendChild(buildFoodRow(entry));
      }
    }

    if (sorted.length > 0) wrap.appendChild(list);
    return wrap;
  }

  function appendCheckbox(item: HTMLElement, checked: boolean, onToggle: () => void) {
    item.appendChild(buildCheckbox(checked, onToggle));
    item.classList.add('selectable');
  }

  /** Water rows share the exact food-log UI (§5d): tap to expand inline with
   *  Duplicate / Edit (amount + date only) / Delete. */
  function buildWaterRow(w: JournalWater, _date: string): HTMLElement {
    const expanded = w.id === expandedLogId;
    const item = document.createElement('div');
    item.className = 'log-item water-item' + (expanded ? ' expanded' : '') + (selection.has(w.id) ? ' selected' : '');
    if (selectMode) appendCheckbox(item, selection.has(w.id), () => onToggleSelect(w.id));

    const main = document.createElement('div');
    main.className = 'log-main';
    const time = formatLogTime(w.created_at);
    if (time) {
      const t = document.createElement('span');
      t.className = 'item-time';
      t.textContent = time;
      main.appendChild(t);
    }
    const name = document.createElement('span');
    name.className = 'log-name water-name';
    name.textContent = '💧 Water';
    main.appendChild(name);
    const amt = document.createElement('span');
    amt.className = 'log-water';
    amt.textContent = `${Math.round(w.amount_ml)} ml`;
    main.appendChild(amt);
    item.appendChild(main);

    const srcLine = document.createElement('div');
    srcLine.style.cssText = 'font-size:11px;color:var(--text-dim);padding-left:2px;';
    srcLine.textContent = `Source: ${w.source}`;
    item.appendChild(srcLine);

    if (expanded && !selectMode) {
      const actions = document.createElement('div');
      actions.className = 'log-actions';
      const dup = document.createElement('button');
      dup.className = 'log-action-btn blue';
      dup.textContent = 'Duplicate';
      dup.addEventListener('click', (e) => { e.stopPropagation(); onDuplicateWater(w); });
      const edit = document.createElement('button');
      edit.className = 'log-action-btn';
      edit.textContent = 'Edit';
      edit.addEventListener('click', (e) => { e.stopPropagation(); onEditWater(w); });
      const del = document.createElement('button');
      del.className = 'log-action-btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteWater(w); });
      actions.append(dup, edit, del);
      item.appendChild(actions);
    }

    item.addEventListener('click', () => {
      if (selectMode) onToggleSelect(w.id);
      else onToggleExpand(w.id);
    });
    return item;
  }

  function buildFoodRow(log: JournalFoodLog): HTMLElement {
    const expanded = log.id === expandedLogId;
    const item = document.createElement('div');
    item.className = 'log-item' + (expanded ? ' expanded' : '') + (selection.has(log.id) ? ' selected' : '');
    if (selectMode) appendCheckbox(item, selection.has(log.id), () => onToggleSelect(log.id));

    const main = document.createElement('div');
    main.className = 'log-main';
    const time = formatLogTime(log.created_at);
    if (time) {
      const t = document.createElement('span');
      t.className = 'item-time';
      t.textContent = time;
      main.appendChild(t);
    }
    const name = document.createElement('span');
    name.className = 'log-name';
    name.textContent = log.food_name || log.canonical_name || 'Logged Item';
    main.appendChild(name);
    const cal = document.createElement('span');
    cal.className = 'log-cal';
    cal.textContent = log.calories ? `${Math.round(log.calories)} kcal` : `${Math.round(log.amount_ml || log.amount_g || 0)} ml`;
    main.appendChild(cal);
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
      del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteFood(log); });
      actions.append(edit, dup, del);
      item.appendChild(actions);
    }

    item.addEventListener('click', () => {
      if (selectMode) onToggleSelect(log.id);
      else onToggleExpand(log.id);
    });
    return item;
  }

  function buildComboRow(cluster: ComboCluster): HTMLElement {
    const expanded = expandedComboKeys.has(cluster.key);
    const item = document.createElement('div');
    item.className = 'combo-row' + (expanded ? ' expanded' : '');
    if (selectMode) {
      const memberIds = cluster.logs.map(l => l.id);
      const allSelected = memberIds.every(id => selection.has(id)) && memberIds.length > 0;
      appendCheckbox(item, allSelected, () => onSelectMany(memberIds));
    }

    const main = document.createElement('div');
    main.className = 'log-main';
    const time = formatLogTime(cluster.createdAt);
    if (time) {
      const t = document.createElement('span');
      t.className = 'item-time';
      t.textContent = time;
      main.appendChild(t);
    }
    const name = document.createElement('span');
    name.className = 'log-name';
    name.textContent = `🍱 ${cluster.name}`;
    main.appendChild(name);
    const cal = document.createElement('span');
    cal.className = 'log-cal';
    cal.textContent = `${Math.round(cluster.totalCalories)} kcal`;
    main.appendChild(cal);
    item.appendChild(main);

    const countLine = document.createElement('div');
    countLine.style.cssText = 'font-size:11px;color:var(--text-dim);padding-left:2px;';
    countLine.textContent = `Combo · ${cluster.logs.length} items`;
    item.appendChild(countLine);

    // Pass 22c: total macros right on the combo row — same profile as any
    // normal food log (P/C/F next to the kcal).
    const totP = cluster.logs.reduce((s, l) => s + (l.protein_g || 0), 0);
    const totC = cluster.logs.reduce((s, l) => s + (l.carbs_g || 0), 0);
    const totF = cluster.logs.reduce((s, l) => s + (l.fat_g || 0), 0);
    const macros = document.createElement('div');
    macros.className = 'log-macros';
    macros.innerHTML = `
      <span style="color: var(--pro);">P: ${Math.round(totP)}g</span>
      <span style="color: var(--carb);">C: ${Math.round(totC)}g</span>
      <span style="color: var(--fat);">F: ${Math.round(totF)}g</span>
    `;
    item.appendChild(macros);

    if (expanded) {
      const breakdown = document.createElement('div');
      breakdown.className = 'combo-breakdown';

      const title = document.createElement('div');
      title.className = 'combo-breakdown-title';
      title.textContent = 'Nourishment Breakdown';
      breakdown.appendChild(title);

      for (const log of cluster.logs) {
        const row = document.createElement('div');
        row.className = 'combo-ingredient';
        const left = document.createElement('div');
        left.style.cssText = 'display:flex;flex-direction:column;min-width:0;';
        const nm = document.createElement('span');
        nm.className = 'combo-ing-name';
        nm.textContent = log.food_name || log.canonical_name || 'Ingredient';
        const mac = document.createElement('span');
        mac.className = 'combo-ing-macros';
        mac.textContent =
          `${Math.round(log.amount_g ?? log.amount_ml ?? 0)}${log.amount_ml != null ? 'ml' : 'g'} · ` +
          `P ${Math.round(log.protein_g || 0)} C ${Math.round(log.carbs_g || 0)} F ${Math.round(log.fat_g || 0)}`;
        left.append(nm, mac);
        const kcalEl = document.createElement('span');
        kcalEl.className = 'combo-ing-kcal';
        kcalEl.textContent = `${Math.round(log.calories || 0)} kcal`;
        row.append(left, kcalEl);
        breakdown.appendChild(row);
      }

      const totalRow = document.createElement('div');
      totalRow.className = 'combo-total-row';
      totalRow.innerHTML = `<span>Total</span><span style="color: var(--accent-glow);">${Math.round(cluster.totalCalories)} kcal</span>`;
      breakdown.appendChild(totalRow);

      if (!selectMode) {
        const actions = document.createElement('div');
        actions.className = 'combo-actions';
        // Pass 22c: NO "Close" button — tapping the row collapses it, same as
        // every other log item (a dedicated close was dumb UX).
        const dupCombo = document.createElement('button');
        dupCombo.className = 'log-action-btn blue';
        dupCombo.textContent = 'Duplicate';
        dupCombo.addEventListener('click', (e) => { e.stopPropagation(); onDuplicateCombo(cluster); });
        actions.appendChild(dupCombo);
        if (cluster.comboId) {
          const editTpl = document.createElement('button');
          editTpl.className = 'log-action-btn blue';
          editTpl.textContent = 'Edit Combo';
          editTpl.addEventListener('click', (e) => { e.stopPropagation(); onEditComboTemplate(cluster.comboId!); });
          actions.appendChild(editTpl);
        }
        const del = document.createElement('button');
        del.className = 'log-action-btn danger';
        del.textContent = 'Delete All';
        del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteComboLogs(cluster); });
        actions.appendChild(del);
        breakdown.appendChild(actions);
      }

      item.appendChild(breakdown);
    }

    item.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;
      if (selectMode) return;
      onToggleCombo(cluster.key);
    });
    return item;
  }
}

function buildCheckbox(checked: boolean, onToggle: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'select-box' + (checked ? ' checked' : '');
  box.textContent = checked ? '✓' : '';
  box.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  return box;
}

/** Weekday label for a YYYY-MM-DD date (long form, e.g. "Saturday"). */
export function weekdayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

/** Group-header date label: Today / Yesterday / "Aug 22". */
export function groupDateLabel(dateStr: string): string {
  const today = getTodayLocal();
  if (dateStr === today) return 'Today';
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yestIso = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`;
  if (dateStr === yestIso) return 'Yesterday';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Local import-free duplicate of getTodayDateString to keep this view pure DOM.
function getTodayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
