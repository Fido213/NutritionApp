import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { defineCustomElements as jeepSqliteDefineCustomElements } from 'jeep-sqlite/loader';

// @ts-ignore
import v001InitSql from './migrations/v001__init.sql?raw';

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private sqlite: SQLiteConnection;
  private db: SQLiteDBConnection | null = null;
  private readonly DB_NAME = 'everydayfuel';
  private isWeb: boolean = false;
  private isFallbackMode: boolean = false;
  private fallbackStore: Map<string, any[]> = new Map();

  constructor() {
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
    this.isWeb = Capacitor.getPlatform() === 'web';
  }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  async initialize(): Promise<void> {
    try {
      if (this.isWeb) {
        await jeepSqliteDefineCustomElements(window);
        let jeepEl = document.querySelector('jeep-sqlite');
        if (!jeepEl) {
          jeepEl = document.createElement('jeep-sqlite');
          document.body.appendChild(jeepEl);
          await customElements.whenDefined('jeep-sqlite');
        }
        await this.sqlite.initWebStore();
      }

      this.db = await this.sqlite.createConnection(
        this.DB_NAME,
        false,
        'no-encryption',
        1,
        false
      );

      await this.db.open();
      await this.db.execute('PRAGMA foreign_keys = ON;');
      await this.runMigrations();

      if (this.isWeb) {
        await this.sqlite.saveToStore(this.DB_NAME);
      }
    } catch (error) {
      console.warn('SQLite initialization warning (falling back to web storage):', error);
      this.isFallbackMode = true;
      this.initFallbackStore();
    }
  }

  async getConnection(): Promise<SQLiteDBConnection> {
    if (this.isFallbackMode) {
      return this.createFallbackConnection();
    }
    if (!this.db) {
      await this.initialize();
    }
    return this.db || this.createFallbackConnection();
  }

  isFallback(): boolean {
    return this.isFallbackMode;
  }

  /**
   * Replace the entire fallback store with the given table data.
   * Used by restore in fallback mode, where the in-memory store is the whole database.
   */
  replaceFallbackStore(data: Record<string, any[]>): void {
    this.fallbackStore.clear();
    Object.entries(data).forEach(([table, rows]) => {
      this.fallbackStore.set(table, Array.isArray(rows) ? rows : []);
    });
    this.saveFallbackStore();
  }

  private initFallbackStore() {
    // Load from localStorage if present
    const saved = localStorage.getItem('everydayfuel_fallback_db');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        Object.keys(parsed).forEach(table => {
          this.fallbackStore.set(table, parsed[table]);
        });
      } catch (e) {
        console.warn('Failed to parse fallback database from localStorage:', e);
      }
    }
  }

  private saveFallbackStore() {
    const obj: Record<string, any[]> = {};
    this.fallbackStore.forEach((val, key) => {
      obj[key] = val;
    });
    localStorage.setItem('everydayfuel_fallback_db', JSON.stringify(obj));
  }

  private createFallbackConnection(): SQLiteDBConnection {
    return createFallbackConnection({
      getTable: (name) => this.fallbackStore.get(name) || [],
      setTable: (name, rows) => {
        this.fallbackStore.set(name, rows);
        this.saveFallbackStore();
      },
      save: () => this.saveFallbackStore()
    });
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;
    
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
      );
    `);

    const versionRes = await this.db.query(
      `SELECT value FROM app_settings WHERE key = 'schema_version'`
    );
    
    let currentVersion = 0;
    if (versionRes.values && versionRes.values.length > 0) {
      currentVersion = parseInt(versionRes.values[0].value, 10);
    }

    if (currentVersion < 1) {
      await this.db.execute(v001InitSql);
      await this.db.execute(
        `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '1');`
      );
    }
  }

  async saveWebStore(): Promise<void> {
    if (this.isWeb && this.db && !this.isFallbackMode) {
      await this.sqlite.saveToStore(this.DB_NAME);
    }
  }

  async beginTransaction(): Promise<void> {
    if (this.db && !this.isFallbackMode) await this.db.beginTransaction();
  }

  async commitTransaction(): Promise<void> {
    if (this.db && !this.isFallbackMode) await this.db.commitTransaction();
  }

  async rollbackTransaction(): Promise<void> {
    if (this.db && !this.isFallbackMode) await this.db.rollbackTransaction();
  }
}

/** Minimal table store contract used by the fallback SQL evaluator. */
export interface FallbackTableStore {
  getTable(name: string): any[];
  setTable(name: string, rows: any[]): void;
  save(): void;
}

/**
 * Minimal in-memory SQL evaluator covering the exact statement shapes the
 * repositories emit. It is a graceful-degradation path (used only when the
 * real SQLite engine fails to initialize) and is deliberately kept simple:
 * unknown statements degrade to no-ops rather than throwing.
 *
 * Exported as a factory so the evaluator itself is unit-testable without the
 * Capacitor/jeep-sqlite environment (see database-shim.test.ts).
 */
export function createFallbackConnection(store: FallbackTableStore): SQLiteDBConnection {
  const TABLE_PATTERNS: Array<[RegExp, string]> = [
    [/FROM food_logs/, 'food_logs'],
    [/FROM water_logs/, 'water_logs'],
    [/FROM goals/, 'goals'],
    [/FROM daily_records/, 'daily_records'],
    [/FROM combos/, 'combos'],
    [/FROM combo_items/, 'combo_items'],
    [/FROM food_observations/, 'food_observations'],
    [/FROM food_aliases/, 'food_aliases'],
    [/FROM food_barcodes/, 'food_barcodes'],
    [/FROM imports/, 'imports'],
    [/FROM app_settings/, 'app_settings'],
    [/FROM foods/, 'foods'],
    [/JOIN food_barcodes/, 'food_barcodes'],
    [/JOIN food_aliases/, 'food_aliases'],
    [/JOIN foods/, 'foods']
  ];

  const detectTable = (statement: string): string => {
    for (const [pattern, table] of TABLE_PATTERNS) {
      if (pattern.test(statement)) return table;
    }
    const dmlMatch = statement.match(/\b(?:INTO|UPDATE|DELETE FROM)\s+(\w+)/i);
    return dmlMatch ? dmlMatch[1] : 'foods';
  };

  /**
   * Parse a comma-separated SET / ON CONFLICT clause into a column -> value
   * map (every part carries an `=`). Literals (numbers, NULL, quoted strings)
   * are taken from the SQL text; `?` placeholders consume the bound values.
   */
  const parseAssignments = (clause: string, values?: any[]): Map<string, any> => {
    const rowValues = new Map<string, any>();
    let vi = 0;
    for (const part of clause.split(',')) {
      const [colRaw, valRaw] = part.split('=').map(p => p.trim());
      const col = colRaw.trim();
      if (valRaw === undefined) {
        rowValues.set(col, null);
        continue;
      }
      const val = valRaw.trim();
      if (val === '?') rowValues.set(col, values?.[vi++]);
      else if (/^NULL$/i.test(val)) rowValues.set(col, null);
      else if (/^-?\d+(\.\d+)?$/.test(val)) rowValues.set(col, Number(val));
      else if (/^'.*'$/.test(val)) rowValues.set(col, val.slice(1, -1));
      else rowValues.set(col, val);
    }
    return rowValues;
  };

  /** Parse a positional VALUES list (matches columns by index). */
  const parsePositionalValues = (clause: string, values?: any[]): any[] => {
    const out: any[] = [];
    let vi = 0;
    for (const part of clause.split(',')) {
      const val = part.trim();
      if (val === '?') out.push(values?.[vi++]);
      else if (/^NULL$/i.test(val)) out.push(null);
      else if (/^-?\d+(\.\d+)?$/.test(val)) out.push(Number(val));
      else if (/^'.*'$/.test(val)) out.push(val.slice(1, -1));
      else out.push(val);
    }
    return out;
  };

  const columnValue = (row: any, col: string): any => {
    const bare = col.trim().replace(/^[a-z]+\./i, '');
    return row[bare];
  };

  const applyOrderAndLimit = (rows: any[], statement: string, values?: any[]): any[] => {
    let result = [...rows];
    const orderMatch = statement.match(/ORDER BY\s+(.+?)(?:\s+LIMIT\s+(\d+|\?))?\s*$/i);
    if (orderMatch) {
      const clauses = orderMatch[1].split(',').map(p => {
        const [col, dir] = p.trim().split(/\s+/);
        return { col, desc: (dir || 'ASC').toUpperCase() === 'DESC' };
      });
      result.sort((a, b) => {
        for (const { col, desc } of clauses) {
          const av = columnValue(a, col);
          const bv = columnValue(b, col);
          if (av === bv) continue;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          const cmp = av < bv ? -1 : 1;
          return desc ? -cmp : cmp;
        }
        return 0;
      });
      if (orderMatch[2] !== undefined) {
        const limit = orderMatch[2] === '?' ? Number(values?.[values.length - 1]) : Number(orderMatch[2]);
        if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);
      }
    } else {
      const limitMatch = statement.match(/\bLIMIT\s+(\d+|\?)\s*$/i);
      if (limitMatch) {
        const limit = limitMatch[1] === '?' ? Number(values?.[values.length - 1]) : Number(limitMatch[1]);
        if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);
      }
    }
    return result;
  };

  return {
    query: async (statement: string, values?: any[]) => {
      statement = statement.trim();
      const table = detectTable(statement);

      // Barcode lookup: JOIN food_barcodes ... WHERE fb.barcode = ?
      if (statement.includes('JOIN food_barcodes') && statement.includes('WHERE fb.barcode = ?')) {
        const barcode = values?.[0];
        const match = store.getTable('food_barcodes').find(b => b.barcode === barcode);
        const food = match ? store.getTable('foods').find(f => f.id === match.food_id) : null;
        return { values: food ? [food] : [] };
      }

      // Alias lookup: JOIN food_aliases ... WHERE fa.normalized_alias = ?
      if (statement.includes('JOIN food_aliases') && statement.includes('WHERE fa.normalized_alias = ?')) {
        const alias = values?.[0];
        const match = store.getTable('food_aliases').find(a => a.normalized_alias === alias);
        const food = match ? store.getTable('foods').find(f => f.id === match.food_id) : null;
        return { values: food ? [food] : [] };
      }

      let rows = [...store.getTable(table)];
      let vi = 0;

      // WHERE clauses in the order the repositories emit them
      if (statement.includes('WHERE id = ?')) {
        const id = values?.[vi++];
        rows = rows.filter(r => r.id === id);
      }
      if (statement.includes('WHERE date = ?') || statement.includes('WHERE fl.date = ?')) {
        const date = values?.[vi++];
        rows = rows.filter(r => r.date === date);
      }
      if (statement.includes('WHERE date >= ? AND date <= ?')) {
        const start = values?.[vi++];
        const end = values?.[vi++];
        rows = rows.filter(r => r.date >= start && r.date <= end);
      }
      if (statement.includes('WHERE barcode = ?')) {
        const barcode = values?.[vi++];
        rows = rows.filter(r => r.barcode === barcode);
      }
      if (statement.includes('WHERE normalized_name = ?')) {
        const name = values?.[vi++];
        rows = rows.filter(r => r.normalized_name === name);
      }
      if (statement.includes('WHERE normalized_alias = ?') && !statement.includes('fa.normalized_alias')) {
        const alias = values?.[vi++];
        rows = rows.filter(r => r.normalized_alias === alias);
      }
      if (statement.includes('WHERE food_id = ?')) {
        const foodId = values?.[vi++];
        rows = rows.filter(r => r.food_id === foodId);
      }
      if (statement.includes('WHERE combo_id = ?')) {
        const comboId = values?.[vi++];
        rows = rows.filter(r => r.combo_id === comboId);
      }
      if (statement.includes('WHERE end_date IS NULL')) {
        rows = rows.filter(r => r.end_date === null || r.end_date === undefined);
      }
      if (statement.includes('start_date <= ?') && statement.includes('end_date >= ?')) {
        const start = values?.[vi++];
        const end = values?.[vi++];
        rows = rows.filter(r => r.start_date <= start && (r.end_date === null || r.end_date === undefined || r.end_date >= end));
      }
      if (statement.includes('LIKE ?')) {
        const term = String(values?.[vi++] || '').replace(/%/g, '').toLowerCase();
        rows = rows.filter(r =>
          String(r.canonical_name || '').toLowerCase().includes(term) ||
          String(r.normalized_name || '').toLowerCase().includes(term)
        );
      }

      // Aggregates
      if (statement.includes('SUM(calories)')) {
        const sumCal = rows.reduce((acc, curr) => acc + (curr.calories || 0), 0);
        const sumPro = rows.reduce((acc, curr) => acc + (curr.protein_g || 0), 0);
        const sumCarb = rows.reduce((acc, curr) => acc + (curr.carbs_g || 0), 0);
        const sumFat = rows.reduce((acc, curr) => acc + (curr.fat_g || 0), 0);
        const sumWater = rows.reduce((acc, curr) => acc + (curr.water_ml || 0), 0);
        return { values: [{ calories: sumCal, protein_g: sumPro, carbs_g: sumCarb, fat_g: sumFat, water_ml: sumWater }] };
      }
      if (statement.includes('SUM(amount_ml)') && statement.includes('GROUP BY source')) {
        const totals: Record<string, number> = {};
        for (const row of rows) {
          totals[row.source] = (totals[row.source] || 0) + (row.amount_ml || 0);
        }
        return { values: Object.entries(totals).map(([source, total]) => ({ source, total })) };
      }
      if (statement.includes('COUNT(*)')) {
        return { values: [{ count: rows.length }] };
      }
      if (statement.includes('MIN(date)') && statement.includes('MAX(date)')) {
        const dates = rows.map(r => r.date).filter(d => d !== undefined && d !== null);
        return {
          values: [{
            first_date: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
            last_date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null
          }]
        };
      }

      // JOIN foods enriches food_logs with the display name (history day view)
      if (statement.includes('JOIN foods') && table === 'food_logs') {
        const foods = store.getTable('foods');
        rows = rows.map(r => {
          const food = foods.find(f => f.id === r.food_id);
          return food ? { ...r, canonical_name: food.canonical_name, food_name: food.canonical_name } : r;
        });
      }

      rows = applyOrderAndLimit(rows, statement, values);
      return { values: rows };
    },

    run: async (statement: string, values?: any[]) => {
      statement = statement.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|PRAGMA|CREATE|ALTER|DROP)/i.test(statement)) {
        return { changes: { changes: 0, lastId: 0 } };
      }

      const table = detectTable(statement);

      if (statement.startsWith('INSERT')) {
        const colMatch = statement.match(/INSERT (?:OR REPLACE )?INTO \w+\s*\(([^)]+)\)/i);
        const valMatch = statement.match(/VALUES\s*\(([^)]+)\)/i);
        if (!colMatch || !valMatch) return { changes: { changes: 0, lastId: 0 } };
        const cols = colMatch[1].split(',').map(c => c.trim());
        const parsedValues = parsePositionalValues(valMatch[1], values);
        const newRow: any = {};
        cols.forEach((col, i) => { newRow[col] = parsedValues[i] ?? null; });

        const rows = store.getTable(table);
        const conflictMatch = statement.match(/ON CONFLICT\((\w+)\) DO UPDATE SET\s+(.+?)(?:\s*\)|\s*;|\s*$)/i);
        if (conflictMatch) {
          const key = conflictMatch[1];
          const existing = rows.find(r => r[key] === newRow[key]);
          if (existing) {
            const conflictValues = parseAssignments(conflictMatch[2], []);
            conflictValues.forEach((v, col) => {
              existing[col] = typeof v === 'string' && v.startsWith('excluded.') ? newRow[v.slice('excluded.'.length)] : v;
            });
            store.setTable(table, rows);
            store.save();
            return { changes: { changes: 1, lastId: 0 } };
          }
        }
        rows.push(newRow);
        store.setTable(table, rows);
        store.save();
        return { changes: { changes: 1, lastId: rows.length } };
      }

      if (statement.startsWith('UPDATE')) {
        const idMatch = statement.match(/WHERE id = \?/);
        const dateMatch = statement.match(/WHERE date = \?/);
        const setMatch = statement.match(/SET\s+(.+?)(?:\s+WHERE)/i);
        if (!setMatch) return { changes: { changes: 0, lastId: 0 } };
        const rowValues = parseAssignments(setMatch[1], values);
        const rows = store.getTable(table);
        const findRow = idMatch
          ? (r: any) => r.id === values?.[values.length - 1]
          : dateMatch
            ? (r: any) => r.date === values?.[values.length - 1]
            : () => false;
        const row = rows.find(findRow);
        if (row) {
          rowValues.forEach((v, col) => { row[col] = v; });
          store.setTable(table, rows);
          store.save();
        }
        return { changes: { changes: row ? 1 : 0, lastId: 0 } };
      }

      if (statement.startsWith('DELETE')) {
        const idMatch = statement.match(/WHERE id = \?/);
        const comboMatch = statement.match(/WHERE combo_id = \?/);
        const rows = store.getTable(table);
        let filtered = rows;
        if (idMatch) {
          const id = values?.[0];
          filtered = rows.filter(r => r.id !== id);
        } else if (comboMatch) {
          const comboId = values?.[0];
          filtered = rows.filter(r => r.combo_id !== comboId);
        }
        store.setTable(table, filtered);
        store.save();
        return { changes: { changes: rows.length - filtered.length, lastId: 0 } };
      }

      return { changes: { changes: 0, lastId: 0 } };
    },

    execute: async () => ({ changes: { changes: 0 } }),
    open: async () => {},
    close: async () => {},
    isOpened: async () => ({ result: true })
  } as unknown as SQLiteDBConnection;
}
