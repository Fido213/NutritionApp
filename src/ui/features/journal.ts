/**
 * Day logs / journal (§5c-D day-grouped list; §5d: selected-day-only window,
 * newest/oldest day ordering, full water-row actions) + the supporting modals:
 * day notes (§5b item 5), water edit (§5d amount+date only) and bulk date move.
 */
import { store } from '../state';
import { showToast } from '../components/toast';
import { openModalLayer, closeModalLayer } from '../modal-layers';
import { requestConfirmation } from '../dialogs';
import { renderDayDetail, weekdayLabel, groupDateLabel } from '@ui/views/day-detail';
import type { JournalGroup, JournalEntry, JournalFoodLog, JournalWater, ComboCluster } from '@ui/views/day-detail';
import { refreshStateForDate, bumpDataVersion, invalidateHistoryWindow } from '../app-refresh';
import { getTodayDateString } from '@utils/dates';
import { ctx } from '../context';
import { openEditView } from './edit-log';
import { openComboBuilderView } from './combo-builder';

let journalWaters: JournalWater[] = [];
let expandedLogId: string | null = null;
const expandedComboKeys = new Set<string>();
let selectMode = false;
const selection = new Set<string>();
let journalDayOrder: 'desc' | 'asc' = 'desc';
let journalRenderGen = 0;

/** Log-id → log map for the last fetched journal window (bulk duplicate targets). */
let journalLogsById = new Map<string, JournalFoodLog>();

let pendingBulkIds: string[] = [];

/** Called by refreshStateForDate so the bulk handlers can distinguish food vs water ids. */
export function setJournalWaters(waters: JournalWater[]) {
  journalWaters = waters.map(w => ({ ...w }));
}

/**
 * Build the log groups for the visible window. §5d: the window is JUST the
 * selected date — picking Saturday never shows Friday below it.
 */
export async function renderJournalIfVisible() {
  if (ctx.currentViewId !== 'history') return;
  const container = document.getElementById('day-view-container');
  if (!container) return;

  const gen = ++journalRenderGen;
  const selDate = store.getState().selectedDate;
  const start = selDate;

  try {
    const [logs, waters, totalsByDate, records] = await Promise.all([
      ctx.logRepo.getLogsForRange(start, selDate),
      ctx.waterRepo.getWaterForRange(start, selDate),
      ctx.logRepo.getDailyTotalsForRange(start, selDate),
      ctx.dailyRecordRepo.getForRange(start, selDate)
    ]);
    setJournalWaters(waters);

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
      const obs = await ctx.observationRepo.findById(obsId);
      if (!obs || obs.source_type !== 'combo') continue;
      let meta: { comboId?: string; comboName?: string } = {};
      try { meta = JSON.parse(obs.interpretation_json || '{}'); } catch { /* unparseable */ }
      let name = String(meta.comboName || '').trim();
      if (!name && meta.comboId) {
        const tpl = await ctx.comboRepo.getCombo(meta.comboId).catch(() => null);
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
      dayOrder: journalDayOrder,
      expandedLogId,
      expandedComboKeys,
      selection,
      selectMode,
      onToggleExpand(id) {
        expandedLogId = expandedLogId === id ? null : id;
        void renderJournalIfVisible();
      },
      onEdit: openEditView,
      onDuplicate: async (log) => {
        await ctx.logRepo.duplicateLog(log.id, log.date);
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast('Log duplicated');
      },
      onDeleteFood: async (log) => {
        const ok = await requestConfirmation('Delete Log', `Delete "${log.food_name || 'this entry'}" from ${log.date}?`);
        if (!ok) return;
        await ctx.logRepo.deleteLog(log.id);
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast('Log deleted');
      },
      onDeleteWater: async (water) => {
        const ok = await requestConfirmation('Delete Water', `Delete this ${Math.round(water.amount_ml)}ml water entry?`);
        if (!ok) return;
        await ctx.waterRepo.deleteWaterLog(water.id);
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Deleted ${Math.round(water.amount_ml)}ml water entry`);
      },
      onDuplicateWater: async (water) => {
        // §5d: water duplicates exactly like food — same amount, same day.
        await ctx.waterRepo.insertWaterLog({
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
        void renderJournalIfVisible();
      },
      onEditDayNote: (date) => openDayNoteModal(date),
      onToggleLowAccuracy: async (date, current) => {
        await ctx.dailyRecordRepo.setLowAccuracy(date, !current);
        bumpDataVersion();
        await renderJournalIfVisible();
        showToast(!current ? 'Day flagged low accuracy' : 'Low-accuracy flag cleared');
      },
      onToggleSelectMode() {
        selectMode = !selectMode;
        if (!selectMode) selection.clear();
        void renderJournalIfVisible();
      },
      onToggleSelect(id) {
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
        void renderJournalIfVisible();
      },
      onSelectMany(ids) {
        const allSelected = ids.every(id => selection.has(id));
        for (const id of ids) {
          if (allSelected) selection.delete(id);
          else selection.add(id);
        }
        void renderJournalIfVisible();
      },
      onSelectAll(ids) {
        // Pass 22: force-select everything loaded (foods + waters + combo members).
        for (const id of ids) selection.add(id);
        void renderJournalIfVisible();
      },
      onDuplicateCombo: async (cluster) => {
        // Pass 22b fix: duplicating must produce its OWN combo log entry.
        // The old approach (duplicateLog per member) copied the original
        // observation_id, so the journal re-clustered everything into ONE
        // bigger group instead of creating a second standalone combo row.
        const marker = await ctx.observationRepo.insert({
          food_id: null,
          source_type: 'combo',
          estimated_amount: null,
          final_amount: null,
          amount_unit: 'g',
          confidence: null,
          raw_input: cluster.name,
          interpretation_json: JSON.stringify({ kind: 'combo', comboId: cluster.comboId ?? null, comboName: cluster.name }),
          user_corrected: 0
        });
        for (const log of cluster.logs) {
          await ctx.logRepo.insertFoodLog({
            date: log.date,
            food_id: log.food_id ?? null,
            observation_id: marker.id,
            amount_g: log.amount_g ?? null,
            amount_ml: log.amount_ml ?? null,
            calories: log.calories ?? 0,
            protein_g: log.protein_g ?? 0,
            carbs_g: log.carbs_g ?? 0,
            fat_g: log.fat_g ?? 0,
            note: log.note ?? undefined
          });
        }
        expandedComboKeys.delete(cluster.key);
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Duplicated "${cluster.name}"`);
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
          await ctx.logRepo.duplicateLog(id, target);
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
          if (journalWaters.some(w => w.id === id)) await ctx.waterRepo.deleteWaterLog(id);
          else await ctx.logRepo.deleteLog(id);
        }
        selectMode = false;
        selection.clear();
        expandedLogId = null;
        await refreshStateForDate(store.getState().selectedDate);
        showToast(`Deleted ${ids.length} item(s)`);
      },
      onToggleCombo(key) {
        if (expandedComboKeys.has(key)) expandedComboKeys.delete(key);
        else expandedComboKeys.add(key);
        void renderJournalIfVisible();
      },
      onDeleteComboLogs: async (cluster) => {
        const ok = await requestConfirmation(
          'Delete Combo',
          `Delete all ${cluster.logs.length} items of "${cluster.name}" from the logs?`
        );
        if (!ok) return;
        for (const log of cluster.logs) await ctx.logRepo.deleteLog(log.id);
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

/* ----- Day notes (§5b item 5 / §5c-F): editable per journal day-group header. ----- */

let noteTargetDate = getTodayDateString();

function openDayNoteModal(date: string) {
  noteTargetDate = date;
  const input = document.getElementById('day-note-input') as HTMLTextAreaElement | null;
  if (input) input.value = '';
  openModalLayer('note-modal');
  ctx.dailyRecordRepo.getForRange(date, date).then(([rec]) => {
    if (input) input.value = rec?.note || '';
    input?.focus();
  });
}

/* ----- Water edit (§5d: amount + date ONLY — no macros, they make no sense) ----- */

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

/* ----- Bulk date move (multi-select → Change Date) ----- */

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
      await ctx.logRepo.updateLog(id, { date: target } as any);
    }
    const moved = pendingBulkIds.length;
    pendingBulkIds = [];
    selectMode = false;
    selection.clear();
    closeModalLayer('bulk-date-modal');
    invalidateHistoryWindow();
    await refreshStateForDate(target);
    showToast(`Moved ${moved} item(s) to ${target}`);
  });
}

/** All journal-support listeners (day notes + bulk date + water edit). */
export function setupJournalHandlers() {
  document.getElementById('btn-note-ok')?.addEventListener('click', async () => {
    const input = document.getElementById('day-note-input') as HTMLTextAreaElement | null;
    if (!input) return;
    const noteDate = noteTargetDate;
    await ctx.dailyRecordRepo.setNote(noteDate, input.value.trim() || null);

    closeModalLayer('note-modal');
    bumpDataVersion();
    if (store.getState().selectedDate === noteDate) {
      await refreshStateForDate(noteDate);
    } else {
      await renderJournalIfVisible();
    }
    showToast('Day note saved');
  });

  document.getElementById('btn-note-cancel')?.addEventListener('click', () => closeModalLayer('note-modal'));

  setupBulkDateHandlers();

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

    const current = await ctx.waterRepo.getWaterById(id);
    await ctx.waterRepo.updateWaterLog(id, { amount_ml: amount, date });

    closeModalLayer('water-edit-modal');
    expandedLogId = null;
    invalidateHistoryWindow();
    await refreshStateForDate(date);
    if (current && current.date !== date) {
      await refreshStateForDate(current.date);
    }
    showToast(`Water entry updated · ${Math.round(amount)}ml on ${date}`);
  });
}
