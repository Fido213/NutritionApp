/**
 * First-launch base seed (44k migration): bundle the cleaned corpus in the
 * APK and import it into SQLite once, when the library is empty.
 *
 * Runs exactly once per database: the empty-table guard skips every launch
 * after the first, and user data is never touched (no UPDATE/DELETE here —
 * only INSERTs into an empty table). Source CSV stays the cleaned file
 * (junk + punctuation dupes already removed); residual normalized_name
 * collisions dedupe to the most macro-complete row with deterministic
 * first-seen tie-breaks (same rule as the corpus cleanup).
 */
import { normalizeFoodName } from '@domain/logging';
import type { FoodRepository } from '@data/repositories/food.repo';
import type { InsertFood } from '@data/types';

export const SEED_ASSET_URLS = [
  'assets/unified_food_database_per100g_CLEANED.csv',
  './assets/unified_food_database_per100g_CLEANED.csv',
  '/assets/unified_food_database_per100g_CLEANED.csv',
];

export interface SeedCandidate {
  name: string;
  normalized: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  water: number | null;
  sourceRef: string | null;
}

export interface SeedResult {
  seeded: boolean;
  /** Machine reason for logs/tests: 'seeded' | 'non-empty' | 'no-asset' | 'bad-asset' | 'failed'. */
  reason: string;
  total: number;
  inserted: number;
  skipped: number;
  error?: string;
}

/** Minimal RFC4180 parser (quoted fields with commas/escaped quotes, CRLF). */
export function parseSeedCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* CRLF: \n handles the break */ }
    else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function numOrNull(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Map one CSV record (header + row) to a candidate; null when unusable. */
export function mapSeedRecord(header: string[], cols: string[]): SeedCandidate | null {
  const idx = (name: string) => header.indexOf(name);
  const at = (name: string) => (idx(name) === -1 ? undefined : cols[idx(name)]);
  const rawName = (at('food_name_en') ?? '').trim();
  if (!rawName || rawName.length < 2) return null;
  const normalized = normalizeFoodName(rawName);
  if (!normalized) return null;
  const db = (at('source_db') ?? '').trim();
  const sid = (at('source_id') ?? '').trim();
  return {
    name: rawName,
    normalized,
    calories: numOrNull(at('energy_kcal')),
    protein: numOrNull(at('protein_g')),
    carbs: numOrNull(at('carbohydrate_g')),
    fat: numOrNull(at('fat_g')),
    water: numOrNull(at('water_g')),
    sourceRef: db || sid ? `${db}:${sid}` : null,
  };
}

/** Header-aware map over all records; drops unusable rows. */
export function prepareSeedRows(records: string[][]): SeedCandidate[] {
  if (records.length < 2) return [];
  const header = records[0].map(h => h.trim());
  const out: SeedCandidate[] = [];
  for (let i = 1; i < records.length; i++) {
    const c = mapSeedRecord(header, records[i]);
    if (c) out.push(c);
  }
  return out;
}

export function seedCompleteness(c: SeedCandidate): number {
  return [c.calories, c.protein, c.carbs, c.fat, c.water].filter(v => v !== null).length;
}

/**
 * Dedupe on normalized name: keep the most macro-complete row, first-seen
 * wins ties (deterministic for a stable input order).
 */
export function dedupeSeedRows(cands: SeedCandidate[]): SeedCandidate[] {
  const best = new Map<string, SeedCandidate>();
  for (const c of cands) {
    const cur = best.get(c.normalized);
    if (!cur || seedCompleteness(c) > seedCompleteness(cur)) best.set(c.normalized, c);
  }
  return [...best.values()];
}

export function toInsertFood(c: SeedCandidate): InsertFood {
  return {
    canonical_name: c.name,
    normalized_name: c.normalized,
    calories_per_100g: c.calories,
    protein_per_100g: c.protein,
    carbs_per_100g: c.carbs,
    fat_per_100g: c.fat,
    water_per_100g: c.water,
    nutrition_basis: 'per_100g',
    source_type: 'imported',
    source_reference: c.sourceRef,
    confidence: null,
  } as InsertFood;
}

/**
 * Seed the library iff it is empty and the bundled asset exists. Never
 * throws for expected skips (non-empty / no asset / bad asset) — first
 * launch must never crash. Unexpected insert failures are reported, not
 * thrown: an empty table retries next launch.
 */
export async function seedFoodLibraryIfEmpty(
  foodRepo: Pick<FoodRepository, 'getAllFoods' | 'bulkInsert'>,
  fetchFn: typeof fetch = fetch,
): Promise<SeedResult> {
  const existing = await foodRepo.getAllFoods(1);
  if (existing.length > 0) return { seeded: false, reason: 'non-empty', total: 0, inserted: 0, skipped: 0 };

  let text: string | null = null;
  for (const url of SEED_ASSET_URLS) {
    try {
      const res = await fetchFn(url);
      if (res.ok) {
        const t = await res.text();
        if (t.includes('food_name_en')) { text = t; break; }
      }
    } catch { /* try next candidate */ }
  }
  if (!text) return { seeded: false, reason: 'no-asset', total: 0, inserted: 0, skipped: 0 };

  let records: string[][];
  try {
    records = parseSeedCsv(text);
  } catch (e: any) {
    return { seeded: false, reason: 'bad-asset', total: 0, inserted: 0, skipped: 0, error: String(e?.message || e) };
  }
  if (records.length < 2 || !records[0].map(h => h.trim()).includes('food_name_en')) {
    return { seeded: false, reason: 'bad-asset', total: 0, inserted: 0, skipped: 0 };
  }

  const prepared = prepareSeedRows(records);
  const deduped = dedupeSeedRows(prepared);
  try {
    const inserted = await foodRepo.bulkInsert(deduped.map(toInsertFood));
    console.log(`[seed] base library seeded: ${inserted} foods (${prepared.length - deduped.length} collision-dupes dropped)`);
    return { seeded: true, reason: 'seeded', total: prepared.length, inserted, skipped: prepared.length - deduped.length };
  } catch (e: any) {
    console.warn('[seed] bulk insert failed, will retry next launch:', e?.message || e);
    return { seeded: false, reason: 'failed', total: prepared.length, inserted: 0, skipped: 0, error: String(e?.message || e) };
  }
}
