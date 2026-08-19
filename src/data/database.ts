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
    const manager = this;

    return {
      query: async (statement: string, values?: any[]) => {
        statement = statement.trim();
        let tableName = 'foods';
        if (statement.includes('FROM food_logs')) tableName = 'food_logs';
        else if (statement.includes('FROM water_logs')) tableName = 'water_logs';
        else if (statement.includes('FROM goals')) tableName = 'goals';
        else if (statement.includes('FROM daily_records')) tableName = 'daily_records';
        else if (statement.includes('FROM combos')) tableName = 'combos';
        else if (statement.includes('FROM food_barcodes')) tableName = 'food_barcodes';
        else if (statement.includes('JOIN food_aliases')) tableName = 'foods';
        else if (statement.includes('FROM food_observations')) tableName = 'food_observations';
        else if (statement.includes('FROM food_aliases')) tableName = 'food_aliases';
        else if (statement.includes('FROM imports')) tableName = 'imports';
        else if (statement.includes('FROM app_settings')) tableName = 'app_settings';

        const rows = manager.fallbackStore.get(tableName) || [];
        let filtered = [...rows];

        if (values && values.length > 0) {
          if (statement.includes('WHERE date = ?') || statement.includes('WHERE fl.date = ?')) {
            filtered = filtered.filter(r => r.date === values[0]);
          } else if (statement.includes('WHERE id = ?')) {
            filtered = filtered.filter(r => r.id === values[0]);
          } else if (statement.includes('WHERE normalized_name = ?')) {
            filtered = filtered.filter(r => r.normalized_name === values[0]);
          } else if (statement.includes('WHERE normalized_alias = ?')) {
            filtered = filtered.filter(r => r.normalized_alias === values[0]);
          } else if (statement.includes('WHERE fa.normalized_alias = ?')) {
            const aliasRows = manager.fallbackStore.get('food_aliases') || [];
            const aliasMatch = aliasRows.find(r => r.normalized_alias === values[0]);
            filtered = aliasMatch ? filtered.filter(r => r.id === aliasMatch.food_id) : [];
          } else if (statement.includes('WHERE end_date IS NULL')) {
            filtered = filtered.filter(r => r.end_date === null);
          }
        }

        if (statement.includes('SUM(calories)')) {
          const sumCal = filtered.reduce((acc, curr) => acc + (curr.calories || 0), 0);
          const sumPro = filtered.reduce((acc, curr) => acc + (curr.protein_g || 0), 0);
          const sumCarb = filtered.reduce((acc, curr) => acc + (curr.carbs_g || 0), 0);
          const sumFat = filtered.reduce((acc, curr) => acc + (curr.fat_g || 0), 0);
          const sumWater = filtered.reduce((acc, curr) => acc + (curr.water_ml || 0), 0);

          return { values: [{ calories: sumCal, protein_g: sumPro, carbs_g: sumCarb, fat_g: sumFat, water_ml: sumWater }] };
        }

        return { values: filtered };
      },

      run: async (statement: string, values?: any[]) => {
        statement = statement.trim();
        let tableName = 'foods';
        if (statement.includes('INTO food_logs') || statement.includes('UPDATE food_logs') || statement.includes('DELETE FROM food_logs')) tableName = 'food_logs';
        else if (statement.includes('INTO water_logs') || statement.includes('UPDATE water_logs') || statement.includes('DELETE FROM water_logs')) tableName = 'water_logs';
        else if (statement.includes('INTO goals') || statement.includes('UPDATE goals')) tableName = 'goals';
        else if (statement.includes('INTO daily_records')) tableName = 'daily_records';
        else if (statement.includes('INTO combos')) tableName = 'combos';
        else if (statement.includes('INTO food_observations')) tableName = 'food_observations';
        else if (statement.includes('INTO food_aliases')) tableName = 'food_aliases';
        else if (statement.includes('INTO imports')) tableName = 'imports';

        const rows = manager.fallbackStore.get(tableName) || [];

        if (statement.startsWith('INSERT')) {
          const newRow: any = {};
          if (tableName === 'food_logs') {
            newRow.id = values?.[0];
            newRow.date = values?.[1];
            newRow.food_id = values?.[2];
            newRow.observation_id = values?.[3];
            newRow.amount_g = values?.[4];
            newRow.amount_ml = values?.[5];
            newRow.calories = values?.[6];
            newRow.protein_g = values?.[7];
            newRow.carbs_g = values?.[8];
            newRow.fat_g = values?.[9];
            newRow.water_ml = values?.[10];
            newRow.note = values?.[11];
            newRow.created_at = values?.[12];
          } else if (tableName === 'water_logs') {
            newRow.id = values?.[0];
            newRow.date = values?.[1];
            newRow.amount_ml = values?.[2];
            newRow.source = values?.[3];
          } else if (tableName === 'goals') {
            newRow.id = values?.[0];
            newRow.name = values?.[1];
            newRow.start_date = values?.[2];
            newRow.end_date = values?.[3];
            newRow.calories_target = values?.[4];
            newRow.protein_target = values?.[5];
            newRow.carbs_target = values?.[6];
            newRow.fat_target = values?.[7];
            newRow.water_target = values?.[8];
          } else if (tableName === 'food_observations') {
            newRow.id = values?.[0];
            newRow.food_id = values?.[1];
            newRow.source_type = values?.[2];
            newRow.estimated_amount = values?.[3];
            newRow.final_amount = values?.[4];
            newRow.amount_unit = values?.[5];
            newRow.confidence = values?.[6];
            newRow.raw_input = values?.[7];
            newRow.interpretation_json = values?.[8];
            newRow.user_corrected = values?.[9];
            newRow.created_at = values?.[10];
          } else if (tableName === 'food_aliases') {
            newRow.id = values?.[0];
            newRow.food_id = values?.[1];
            newRow.alias = values?.[2];
            newRow.normalized_alias = values?.[3];
            newRow.source = values?.[4];
            newRow.confidence = values?.[5];
            newRow.created_at = values?.[6];
          } else if (tableName === 'imports') {
            newRow.id = values?.[0];
            newRow.source_type = values?.[1];
            newRow.filename = values?.[2];
            newRow.imported_at = values?.[3];
            newRow.status = values?.[4];
            newRow.row_count = values?.[5];
            newRow.error_count = values?.[6];
          } else if (tableName === 'foods') {
            newRow.id = values?.[0];
            newRow.canonical_name = values?.[1];
            newRow.normalized_name = values?.[2];
            newRow.calories_per_100g = values?.[3];
            newRow.protein_per_100g = values?.[4];
            newRow.carbs_per_100g = values?.[5];
            newRow.fat_per_100g = values?.[6];
            newRow.water_per_100g = values?.[7];
          }
          rows.push(newRow);
          manager.fallbackStore.set(tableName, rows);
          manager.saveFallbackStore();
        } else if (statement.startsWith('DELETE')) {
          if (values && values.length > 0) {
            const filtered = rows.filter(r => r.id !== values[0]);
            manager.fallbackStore.set(tableName, filtered);
            manager.saveFallbackStore();
          }
        }

        return { changes: { changes: 1, lastId: 1 } };
      },

      execute: async () => ({ changes: { changes: 0 } }),
      open: async () => {},
      close: async () => {},
      isOpened: async () => ({ result: true })
    } as unknown as SQLiteDBConnection;
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
