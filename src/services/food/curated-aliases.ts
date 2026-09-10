/**
 * Curated aliases (`data/curated_aliases.json`): human phrases for confusing
 * reference rows ("white rice" → "Rice, cooked, NFS"). Applied idempotently
 * at boot — existing mappings (user pins included) are never overwritten,
 * missing foods are skipped (corpus-drift-proof), so already-seeded installs
 * converge with no wipe and the list can grow freely in git.
 */
import { normalizeFoodName } from '@domain/logging';
import type { FoodRepository } from '@data/repositories/food.repo';
import type { AliasRepository } from '@data/repositories/alias.repo';
import curated from './data/curated_aliases.json';

export interface CuratedAliasEntry {
  alias: string;
  canonical: string;
}

export function curatedAliasEntries(): CuratedAliasEntry[] {
  return (curated as { aliases: CuratedAliasEntry[] }).aliases;
}

export async function applyCuratedAliases(
  foodRepo: Pick<FoodRepository, 'findByNormalizedName'>,
  aliasRepo: Pick<AliasRepository, 'findByNormalized' | 'create'>,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  for (const { alias, canonical } of curatedAliasEntries()) {
    const normalized = normalizeFoodName(alias);
    if (!normalized) { skipped++; continue; }
    try {
      if (await aliasRepo.findByNormalized(normalized)) { skipped++; continue; }
      const food = await foodRepo.findByNormalizedName(normalizeFoodName(canonical));
      if (!food) { skipped++; continue; }
      await aliasRepo.create({
        food_id: food.id,
        alias: alias.trim(),
        normalized_alias: normalized,
        source: 'curated',
        confidence: 1,
      });
      applied++;
    } catch {
      skipped++;
    }
  }
  return { applied, skipped };
}
