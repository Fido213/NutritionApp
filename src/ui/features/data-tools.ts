/**
 * Data & backup tools (Settings): CSV export modal (spec §21 scopes), CSV
 * import, encrypted file backup/restore and the Danger-Zone delete-all wipe.
 */
import { showToast } from '../components/toast';
import { openModalLayer, closeModalLayer } from '../modal-layers';
import { requestPassword, requestConfirmation } from '../dialogs';
import { getTodayDateString, formatDateISO } from '@utils/dates';
import { normalizeFoodName } from '@domain/logging';
import { generateCSV, downloadCSV } from '@services/export/csv-export';
import { buildExportRows, datesBetween, goalPhaseRange, resolveExportDateRange, ExportRepos } from '@services/export/export-service';
import { parseCSV } from '@services/import/csv-import';
import {
  createBackupArchive,
  downloadBackup,
  parseBackupArchive,
  restoreBackupArchive,
  validateBackupArchive,
  collectAllTables,
  wipeAllData
} from '@services/backup/backup';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '@services/backup/encryption';
import { refreshStateForDate, invalidateHistoryWindow } from '../app-refresh';
import { store } from '../state';
import { ctx } from '../context';
import { renderIndex, invalidateIndexCaches } from './index-screen';

// ---------- Export (spec §21: all-time / date range / goal phase) ----------

export async function openExportModal() {
  const select = document.getElementById('export-goal-phase') as HTMLSelectElement | null;
  if (select) {
    const goals = await ctx.goalRepo.getGoalsHistory();
    select.innerHTML = '';
    goals.forEach(goal => {
      const option = document.createElement('option');
      option.value = goal.id;
      option.textContent = `${goal.name} (${goal.start_date}${goal.end_date ? ' → ' + goal.end_date : ' → now'})`;
      select.appendChild(option);
    });
    if (select.options.length > 0) select.selectedIndex = 0;
  }

  const from = document.getElementById('export-from') as HTMLInputElement | null;
  const to = document.getElementById('export-to') as HTMLInputElement | null;
  if (from) from.value = store.getState().selectedDate;
  if (to) to.value = getTodayDateString();

  openModalLayer('export-modal');
}

export function setupExportHandlers() {
  const closeModal = () => closeModalLayer('export-modal');

  document.getElementById('btn-export-close')?.addEventListener('click', closeModal);
  document.getElementById('export-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('export-modal')) closeModal();
  });

  document.querySelectorAll<HTMLInputElement>('input[name="export-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = document.querySelector<HTMLInputElement>('input[name="export-mode"]:checked')?.value || 'day';
      const rangeFields = document.getElementById('export-range-fields');
      const phaseField = document.getElementById('export-phase-field');
      if (rangeFields) rangeFields.style.display = mode === 'range' ? '' : 'none';
      if (phaseField) phaseField.style.display = mode === 'phase' ? '' : 'none';
    });
  });

  document.getElementById('btn-export-do')?.addEventListener('click', async () => {
    const mode = document.querySelector<HTMLInputElement>('input[name="export-mode"]:checked')?.value || 'day';
    const repos: ExportRepos = { goal: ctx.goalRepo, log: ctx.logRepo, water: ctx.waterRepo, dailyRecord: ctx.dailyRecordRepo };

    let dates: string[] = [];
    let label = '';

    if (mode === 'day') {
      const day = store.getState().selectedDate;
      dates = [day];
      label = day;
    } else if (mode === 'all') {
      const range = await resolveExportDateRange(repos);
      dates = datesBetween(range.startDate, range.endDate);
      label = range.startDate + '_' + range.endDate;
    } else if (mode === 'range') {
      const from = (document.getElementById('export-from') as HTMLInputElement | null)?.value || '';
      const to = (document.getElementById('export-to') as HTMLInputElement | null)?.value || '';
      if (!from || !to || from > to) {
        showToast('Pick a valid date range (From ≤ To)');
        return;
      }
      dates = datesBetween(from, to);
      label = from + '_' + to;
    } else {
      const goalId = (document.getElementById('export-goal-phase') as HTMLSelectElement | null)?.value;
      const goals = await ctx.goalRepo.getGoalsHistory();
      const goal = goals.find(g => g.id === goalId);
      if (!goal) {
        showToast('No goal phase selected');
        return;
      }
      const range = goalPhaseRange(goal);
      dates = datesBetween(range.startDate, range.endDate);
      label = `${goal.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${range.startDate}_${range.endDate}`;
    }

    const rows = await buildExportRows(dates, repos);
    if (rows.length === 0) {
      showToast('No data in this range to export');
      return;
    }

    const csv = generateCSV(rows);
    downloadCSV(`EverydayFuel_Export_${label}.csv`, csv);
    closeModal();
    showToast(`Exported ${rows.length} day(s) to CSV`);
  });
}

// ---------- CSV Import ----------

export function setupImportHandlers() {
  document.getElementById('btn-import-csv')?.addEventListener('click', () => {
    document.getElementById('csv-file-input')?.click();
  });

  document.getElementById('csv-file-input')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    const { rows, errors } = parseCSV(text);

    if (rows.length === 0) {
      showToast(errors[0] || 'CSV import failed');
      return;
    }

    // Pass 22: progress modal — the loop can take a while on phone-sized
    // datasets; show real per-row progress. Not dismissable mid-run.
    const progressModal = document.getElementById('import-progress-modal');
    const progressFill = document.getElementById('import-progress-fill');
    const progressLabel = document.getElementById('import-progress-label');
    const setProgress = (done: number, total: number) => {
      if (progressFill) progressFill.style.width = `${Math.round((done / total) * 100)}%`;
      if (progressLabel) progressLabel.textContent = `${done} / ${total} rows${errors.length > 0 ? ` · ${errors.length} skipped` : ''}`;
    };
    progressModal?.classList.add('active');
    setProgress(0, rows.length);

    let inserted = 0;
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
      const date = formatDateISO(row.date);
      const normalized = normalizeFoodName(row.foodName);
      let food = await ctx.foodRepo.findByNormalizedName(normalized);

      if (!food) {
        const refAmount = row.amountG || 100;
        food = await ctx.foodRepo.insert({
          canonical_name: row.foodName,
          normalized_name: normalized,
          calories_per_100g: refAmount > 0 ? (row.calories / refAmount) * 100 : 0,
          protein_per_100g: refAmount > 0 ? (row.proteinG / refAmount) * 100 : 0,
          carbs_per_100g: refAmount > 0 ? (row.carbsG / refAmount) * 100 : 0,
          fat_per_100g: refAmount > 0 ? (row.fatG / refAmount) * 100 : 0,
          water_per_100g: 0,
          nutrition_basis: 'per_100g',
          source_type: 'imported',
          confidence: row.estimatedSplit ? 0.5 : 1.0
        });
      }

      const log = await ctx.logRepo.insertFoodLog({
        date,
        food_id: food.id,
        amount_g: row.amountG || 100,
        calories: row.calories,
        protein_g: row.proteinG,
        carbs_g: row.carbsG,
        fat_g: row.fatG,
        water_ml: row.waterMl ?? null
      });

      if (row.waterMl) {
        await ctx.waterRepo.insertWaterLog({
          date,
          amount_ml: row.waterMl,
          source: 'explicit',
          food_log_id: log.id
        });
      }

      // §5d feedback: imported days are NOT auto-flagged low-accuracy anymore
      // (split rows keep their 0.5 library confidence as the estimate marker).

      inserted++;
        setProgress(i + 1, rows.length);
        // Yield to the renderer so the bar actually paints between rows on the
        // WebView (plugin bridge calls alone don't guarantee a frame).
        if (i % 5 === 4) await new Promise(r => setTimeout(r));
      }
    } finally {
      progressModal?.classList.remove('active');
    }

    await ctx.importRepo.recordImport({
      source_type: 'csv',
      filename: file.name,
      status: errors.length > 0 ? 'partial' : 'completed',
      row_count: rows.length,
      error_count: errors.length
    });

    input.value = '';
    await ctx.dbManager.saveWebStore();
    invalidateIndexCaches();
    await refreshStateForDate(store.getState().selectedDate);
    showToast(`Imported ${inserted} rows${errors.length > 0 ? ` (${errors.length} skipped)` : ''}`);
  });
}

// ---------- Backup ----------

export function setupBackupHandler() {
  document.getElementById('btn-backup')?.addEventListener('click', async () => {
    const db = await ctx.dbManager.getConnection();
    const data = await collectAllTables(db);
    const archive = createBackupArchive(data);

    const password = await requestPassword('Set Backup Password', true);
    if (password === null) {
      showToast('Backup cancelled');
      return;
    }

    try {
      const encrypted = await encryptBackup(archive, password);
      downloadBackup(`EverydayFuel_Backup_${getTodayDateString()}.json`, encrypted);
      showToast('Encrypted backup archive exported');
    } catch (err) {
      console.error('Encryption failed:', err);
      showToast('Backup failed — could not encrypt');
    }
  });
}

// ---------- Restore from Backup ----------

export function setupRestoreHandler() {
  document.getElementById('btn-restore')?.addEventListener('click', () => {
    document.getElementById('restore-file-input')?.click();
  });

  document.getElementById('restore-file-input')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();

    let backupText = text;
    if (isEncryptedBackup(text)) {
      const password = await requestPassword('Enter Backup Password', false);
      if (password === null) {
        input.value = '';
        return;
      }
      const decrypted = await decryptBackup(text, password);
      if (decrypted === null) {
        showToast('Wrong password or corrupted backup');
        input.value = '';
        return;
      }
      backupText = decrypted;
    }

    const archive = parseBackupArchive(backupText);
    if (!archive) {
      showToast('Invalid backup archive');
      input.value = '';
      return;
    }

    const validationErrors = validateBackupArchive(archive);
    if (validationErrors.length > 0) {
      showToast(validationErrors[0]);
      input.value = '';
      return;
    }

    const confirmed = await requestConfirmation(
      'Restore Backup',
      'Restore this backup? All current local data will be replaced.'
    );
    if (!confirmed) {
      input.value = '';
      return;
    }

    try {
      if (ctx.dbManager.isFallback()) {
        ctx.dbManager.replaceFallbackStore(archive.data);
      } else {
        const db = await ctx.dbManager.getConnection();
        const result = await restoreBackupArchive(db, archive);
        if (!result.ok) {
          showToast(result.errors[0] || 'Restore failed');
          input.value = '';
          return;
        }
        await ctx.dbManager.saveWebStore();
      }

      invalidateHistoryWindow();
      invalidateIndexCaches();
      ctx.foodCache.clear();
      const date = store.getState().selectedDate;
      await refreshStateForDate(date);
      const rowCount = Object.values(archive.data).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
      showToast(`Restored backup · ${rowCount} rows`);
    } catch (err) {
      console.error('Restore failed:', err);
      showToast('Restore failed — check the backup file');
    } finally {
      input.value = '';
    }
  });
}

// ---------- Delete All Data (§5d: complete local wipe, double-guarded) ----------

export function setupDeleteAllHandler() {
  document.getElementById('btn-delete-all')?.addEventListener('click', async () => {
    const ok = await requestConfirmation(
      'Delete All Data',
      'This permanently erases EVERYTHING — foods, logs, water entries, combos, goals and settings — from this device. It cannot be undone. Export a backup first! Continue?'
    );
    if (!ok) return;

    try {
      if (ctx.dbManager.isFallback()) {
        ctx.dbManager.replaceFallbackStore({});
      } else {
        const db = await ctx.dbManager.getConnection();
        await wipeAllData(db);
        await ctx.dbManager.saveWebStore();
      }

      invalidateHistoryWindow();
      ctx.foodCache.clear();
      invalidateIndexCaches();
      await refreshStateForDate(store.getState().selectedDate);
      await renderIndex();
      showToast('All data deleted');
    } catch (err) {
      console.error('Delete all failed:', err);
      showToast('Could not delete all data — try again');
    }
  });
}
