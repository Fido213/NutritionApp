/**
 * Curated aliases: idempotent boot application that never overwrites.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyCuratedAliases, curatedAliasEntries } from './curated-aliases';

function stubs(foods: Record<string, { id: string }> = {}, aliases: Record<string, unknown> = {}) {
  return {
    foodRepo: {
      findByNormalizedName: vi.fn(async (n: string) => foods[n] ?? null),
    },
    aliasRepo: {
      findByNormalized: vi.fn(async (n: string) => aliases[n] ?? null),
      create: vi.fn(async (a: unknown) => a),
    },
  };
}

describe('curatedAliasEntries', () => {
  it('loads a 1:1 alias list with usable phrases', () => {
    const entries = curatedAliasEntries();
    expect(entries.length).toBeGreaterThan(10);
    const norms = entries.map(e => e.alias.trim().toLowerCase());
    expect(new Set(norms).size).toBe(norms.length);
    expect(entries.some(e => e.alias === 'white rice')).toBe(true);
  });
});

describe('applyCuratedAliases', () => {
  it('creates mappings for known foods', async () => {
    const { foodRepo, aliasRepo } = stubs({ 'rice cooked nfs': { id: 'f1' } });
    // Narrow the working set via module data is fixed; assert behavior on a
    // stub that only knows one food: known → created, rest skipped silently.
    const r = await applyCuratedAliases(foodRepo as any, aliasRepo as any);
    expect(aliasRepo.create).toHaveBeenCalledTimes(1);
    expect(aliasRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ food_id: 'f1', normalized_alias: 'white rice', source: 'curated' })
    );
    expect(r.applied).toBe(1);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('never overwrites existing mappings (user pins win)', async () => {
    const { foodRepo, aliasRepo } = stubs(
      { 'rice cooked nfs': { id: 'f1' } },
      { 'white rice': { id: 'old' } },
    );
    const r = await applyCuratedAliases(foodRepo as any, aliasRepo as any);
    expect(aliasRepo.create).not.toHaveBeenCalled();
    expect(r.applied).toBe(0);
  });

  it('survives repo errors without throwing', async () => {
    const foodRepo = { findByNormalizedName: vi.fn(async () => { throw new Error('down'); }) };
    const aliasRepo = { findByNormalized: vi.fn(async () => null), create: vi.fn() };
    const r = await applyCuratedAliases(foodRepo as any, aliasRepo as any);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
  });
});
