import { SQLiteDBConnection } from '@capacitor-community/sqlite';

/** Index shows the 39k reference library only when explicitly enabled. */
export const SHOW_SEED_LIBRARY_KEY = 'show_seed_library';

export class SettingsRepository {
  constructor(private db: SQLiteDBConnection) {}

  async get(key: string): Promise<string | null> {
    const res = await this.db.query(`SELECT value FROM app_settings WHERE key = ?`, [key]);
    const row = res.values?.[0] as { value?: unknown } | undefined;
    if (!row || row.value === null || row.value === undefined) return null;
    return typeof row.value === 'string' ? row.value : String(row.value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
  }

  /**
   * Seed library visible in the Index? Default OFF — the base library stays
   * out of sight until explicitly asked, so the index reads as the user's
   * own library first (used/made/scanned), then truly personalizes as seeded
   * rows get logged (logged rows always show).
   */
  async getShowSeedLibrary(): Promise<boolean> {
    return (await this.get(SHOW_SEED_LIBRARY_KEY)) === '1';
  }

  async setShowSeedLibrary(on: boolean): Promise<void> {
    await this.set(SHOW_SEED_LIBRARY_KEY, on ? '1' : '0');
  }
}
