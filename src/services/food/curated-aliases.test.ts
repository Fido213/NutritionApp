/**
 * Curated aliases: idempotent boot application that never overwrites.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyCuratedAliases, curatedAliasEntries } from './curated-aliases';
import { normalizeFoodName } from '@domain/logging';

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

  it('keeps one canonical per phrase on the NORMALIZED key (the boot dedupe key)', () => {
    const entries = curatedAliasEntries();
    const keys = entries.map(e => normalizeFoodName(e.alias));
    expect(keys.every(k => k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carries verified translations whose scripts survive normalization', () => {
    // The boot path keys on normalizeFoodName(alias); a phrase stripped to an
    // empty key is skipped, so a translation would silently do nothing. Guard
    // each script that actually appears in the list.
    const entries = curatedAliasEntries();
    const arabic = entries.filter(e => /[\u0600-\u06FF]/.test(e.alias));
    const cjk = entries.filter(e => /[\u4e00-\u9fff]/.test(e.alias));
    const accented = entries.filter(e => /[\u00c0-\u024f]/.test(e.alias));
    expect(arabic.length).toBeGreaterThanOrEqual(5);
    expect(cjk.length).toBeGreaterThanOrEqual(1);
    expect(accented.length).toBeGreaterThanOrEqual(3);
    for (const e of [...arabic, ...cjk, ...accented]) {
      expect(normalizeFoodName(e.alias).length).toBeGreaterThan(0);
    }
    expect(arabic.every(e => /[\u0600-\u06FF]/.test(normalizeFoodName(e.alias)))).toBe(true);
    expect(cjk.every(e => /[\u4e00-\u9fff]/.test(normalizeFoodName(e.alias)))).toBe(true);
    // Translation coverage: one food reachable from several languages.
    expect(entries.filter(e => e.canonical === 'olive oil').length).toBeGreaterThanOrEqual(3);
    expect(entries.filter(e => e.canonical === 'cod').length).toBeGreaterThanOrEqual(3);
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
