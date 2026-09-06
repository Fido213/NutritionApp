/**
 * Phase 1 flagged-default — ObservationRepository.markCorrected through the
 * real fallback connection (the path used when native SQLite is unavailable).
 */
import { describe, it, expect } from 'vitest';
import { createFallbackConnection } from '../database';
import { ObservationRepository } from './observation.repo';

function createStore(): any {
  const tables: Record<string, any[]> = {};
  return {
    getTable: (name: string) => tables[name] || [],
    setTable: (name: string, rows: any[]) => { tables[name] = rows; },
    save: () => {},
  };
}

describe('ObservationRepository.markCorrected', () => {
  it('sets user_corrected without touching other columns', async () => {
    const db = createFallbackConnection(createStore());
    const repo = new ObservationRepository(db as any);
    const obs = await repo.insert({
      food_id: 'f1',
      source_type: 'text',
      estimated_amount: 100,
      final_amount: 100,
      amount_unit: 'g',
      confidence: 0.65,
      raw_input: 'banana',
      interpretation_json: JSON.stringify({ canonicalName: 'banana', wasDefault: true }),
      user_corrected: 0,
    });
    expect(obs.user_corrected).toBe(0);
    await repo.markCorrected(obs.id);
    const reloaded = await repo.findById(obs.id);
    expect(reloaded?.user_corrected).toBe(1);
    expect(reloaded?.interpretation_json).toContain('wasDefault');
    expect(reloaded?.final_amount).toBe(100);
  });
});
