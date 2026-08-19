/**
 * Encrypted Backup & Restore Service for EverydayFuel
 */

import { SQLiteDBConnection } from '@capacitor-community/sqlite';

export const CURRENT_SCHEMA_VERSION = 1;

export const BACKUP_TABLES = [
  'foods', 'food_aliases', 'food_barcodes', 'food_observations', 'food_logs',
  'water_logs', 'combos', 'combo_items', 'daily_records', 'goals', 'app_settings', 'imports'
] as const;

export interface BackupArchive {
  app: 'EverydayFuel';
  version: string;
  schemaVersion: number;
  exportedAt: string;
  data: {
    foods: any[];
    food_aliases: any[];
    food_barcodes: any[];
    food_observations: any[];
    food_logs: any[];
    water_logs: any[];
    combos: any[];
    combo_items: any[];
    daily_records: any[];
    goals: any[];
    app_settings: any[];
    imports: any[];
  };
}

export interface RestoreResult {
  ok: boolean;
  tables: string[];
  totalRows: number;
  errors: string[];
}

/**
 * Canonical column lists per backup table (mirrors the v001 schema).
 * Used to build parameterized INSERT statements that only reference
 * columns actually present in a row, so partial/legacy rows restore safely.
 */
const TABLE_COLUMNS: Record<string, string[]> = {
  foods: ['id', 'canonical_name', 'normalized_name', 'calories_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'water_per_100g', 'nutrition_basis', 'source_type', 'source_reference', 'confidence', 'created_at', 'updated_at'],
  food_aliases: ['id', 'food_id', 'alias', 'normalized_alias', 'source', 'confidence', 'created_at'],
  food_barcodes: ['id', 'food_id', 'barcode', 'source', 'verified', 'created_at'],
  food_observations: ['id', 'food_id', 'source_type', 'estimated_amount', 'final_amount', 'amount_unit', 'confidence', 'raw_input', 'interpretation_json', 'user_corrected', 'created_at'],
  food_logs: ['id', 'date', 'food_id', 'observation_id', 'amount_g', 'amount_ml', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'water_ml', 'note', 'created_at'],
  water_logs: ['id', 'date', 'amount_ml', 'source', 'food_log_id', 'note', 'created_at'],
  combos: ['id', 'name', 'note', 'created_at', 'updated_at'],
  combo_items: ['id', 'combo_id', 'food_id', 'amount_g', 'amount_ml'],
  daily_records: ['date', 'low_accuracy', 'note', 'created_at', 'updated_at'],
  goals: ['id', 'name', 'start_date', 'end_date', 'calories_target', 'protein_target', 'carbs_target', 'fat_target', 'water_target', 'created_at'],
  app_settings: ['key', 'value'],
  imports: ['id', 'source_type', 'filename', 'imported_at', 'status', 'row_count', 'error_count']
};

/**
 * Children must be cleared before their parents (FK constraints).
 */
const CLEAR_ORDER = [
  'water_logs', 'food_logs', 'combo_items', 'food_observations',
  'food_aliases', 'food_barcodes', 'combos', 'daily_records', 'goals', 'imports', 'app_settings', 'foods'
];

/**
 * Parents must be inserted before their children (FK constraints).
 */
const INSERT_ORDER = [
  'foods', 'combos', 'daily_records', 'goals', 'app_settings', 'imports',
  'food_aliases', 'food_barcodes', 'food_observations', 'combo_items', 'food_logs', 'water_logs'
];

/**
 * Read every backup table from the database into a plain object of row arrays.
 * Shared by the file-backup handler and the P2P send flow so both produce
 * identical archives.
 */
export async function collectAllTables(db: SQLiteDBConnection): Promise<Record<string, any[]>> {
  const data: Record<string, any[]> = {};
  for (const table of BACKUP_TABLES) {
    const res = await db.query(`SELECT * FROM ${table}`);
    data[table] = res.values || [];
  }
  return data;
}

export function createBackupArchive(tablesData: Record<string, any[]>): string {
  const archive: BackupArchive = {
    app: 'EverydayFuel',
    version: '1.0.0',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      foods: tablesData.foods || [],
      food_aliases: tablesData.food_aliases || [],
      food_barcodes: tablesData.food_barcodes || [],
      food_observations: tablesData.food_observations || [],
      food_logs: tablesData.food_logs || [],
      water_logs: tablesData.water_logs || [],
      combos: tablesData.combos || [],
      combo_items: tablesData.combo_items || [],
      daily_records: tablesData.daily_records || [],
      goals: tablesData.goals || [],
      app_settings: tablesData.app_settings || [],
      imports: tablesData.imports || []
    }
  };

  return JSON.stringify(archive, null, 2);
}

export function downloadBackup(filename: string, jsonContent: string) {
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function parseBackupArchive(jsonText: string): BackupArchive | null {
  try {
    const archive = JSON.parse(jsonText) as BackupArchive;
    if (archive.app !== 'EverydayFuel' || !archive.data) {
      console.error('Invalid backup archive structure');
      return null;
    }
    return archive;
  } catch (err) {
    console.error('Failed to parse backup JSON:', err);
    return null;
  }
}

/**
 * Validate an archive without touching the database.
 * Returns a list of human-readable errors (empty means valid).
 */
export function validateBackupArchive(archive: unknown): string[] {
  const errors: string[] = [];
  if (!archive || typeof archive !== 'object') {
    return ['Backup archive is not an object'];
  }
  const a = archive as Record<string, any>;
  if (a.app !== 'EverydayFuel') errors.push(`Not an EverydayFuel backup (app = "${a.app}")`);
  if (!a.data || typeof a.data !== 'object') errors.push('Backup archive is missing its data section');
  const schemaVersion = typeof a.schemaVersion === 'number' ? a.schemaVersion : (typeof a.schemaVersion === 'string' ? parseInt(a.schemaVersion, 10) : NaN);
  if (isNaN(schemaVersion)) errors.push('Backup archive is missing a numeric schemaVersion');
  else if (schemaVersion > CURRENT_SCHEMA_VERSION) errors.push(`Backup schema v${schemaVersion} is newer than supported schema v${CURRENT_SCHEMA_VERSION}`);
  return errors;
}

/**
 * Restore a full backup archive into the database.
 *
 * A restore is a complete replacement: every backup table is cleared and
 * re-populated from the archive (in FK-safe order). When the connection
 * supports transactions the whole restore is atomic — any failure rolls
 * back and leaves the database untouched.
 *
 * The caller decides how to handle the degraded fallback connection:
 * pass a real connection here, or replace the fallback store wholesale.
 */
export async function restoreBackupArchive(
  db: SQLiteDBConnection,
  archive: BackupArchive
): Promise<RestoreResult> {
  const errors = validateBackupArchive(archive);
  if (errors.length > 0) {
    return { ok: false, tables: [], totalRows: 0, errors };
  }

  const data = archive.data as Record<string, any[]>;
  for (const table of BACKUP_TABLES) {
    if (data[table] !== undefined && !Array.isArray(data[table])) {
      return { ok: false, tables: [], totalRows: 0, errors: [`Backup table "${table}" is not an array`] };
    }
  }

  const hasTransaction = typeof (db as any).beginTransaction === 'function';
  if (hasTransaction) await (db as any).beginTransaction();

  try {
    for (const table of CLEAR_ORDER) {
      await db.run(`DELETE FROM ${table}`);
    }

    let totalRows = 0;
    for (const table of INSERT_ORDER) {
      const rows = data[table] || [];
      if (rows.length === 0) continue;
      const columns = TABLE_COLUMNS[table];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const present = columns.filter(c => (row as Record<string, unknown>)[c] !== undefined);
        if (present.length === 0) continue;
        const placeholders = present.map(() => '?').join(', ');
        const values = present.map(c => (row as Record<string, unknown>)[c]);
        await db.run(`INSERT INTO ${table} (${present.join(', ')}) VALUES (${placeholders})`, values);
        totalRows++;
      }
    }

    if (hasTransaction) await (db as any).commitTransaction();
    return { ok: true, tables: [...BACKUP_TABLES], totalRows, errors: [] };
  } catch (err) {
    if (hasTransaction) {
      try { await (db as any).rollbackTransaction(); } catch { /* ignore */ }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, tables: [], totalRows: 0, errors: [`Restore failed: ${message}`] };
  }
}
