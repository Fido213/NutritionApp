/**
 * Settings repository: key-value app settings with honest defaults.
 * Fake connection (the SQL is trivially shaped; real-engine coverage would
 * add nothing over the query text asserted here).
 */
import { describe, it, expect } from 'vitest';
import { SettingsRepository, SHOW_SEED_LIBRARY_KEY } from './settings.repo';

function stubConn() {
  const store = new Map<string, string>();
  return {
    store,
    async query(statement: string, values?: any[]) {
      if (statement.includes('FROM app_settings')) {
        const v = values?.[0] != null ? store.get(String(values[0])) : undefined;
        return { values: v === undefined ? [] : [{ value: v }] };
      }
      return { values: [] };
    },
    async run(statement: string, values?: any[]) {
      if (statement.startsWith('INSERT OR REPLACE INTO app_settings')) {
        store.set(String(values?.[0]), String(values?.[1]));
      }
      return {};
    },
  };
}

describe('SettingsRepository', () => {
  it('reads back what it writes', async () => {
    const conn = stubConn();
    const repo = new SettingsRepository(conn as any);
    expect(await repo.get('missing')).toBeNull();
    await repo.set('k', 'v');
    expect(await repo.get('k')).toBe('v');
  });

  it('hides the seed library by default until explicitly enabled', async () => {
    const conn = stubConn();
    const repo = new SettingsRepository(conn as any);
    expect(await repo.getShowSeedLibrary()).toBe(false);
    await repo.setShowSeedLibrary(true);
    expect(await repo.getShowSeedLibrary()).toBe(true);
    expect(conn.store.get(SHOW_SEED_LIBRARY_KEY)).toBe('1');
    await repo.setShowSeedLibrary(false);
    expect(await repo.getShowSeedLibrary()).toBe(false);
  });
});
