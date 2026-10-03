/**
 * E2 enrichment: Open Food Facts full-text search (structured API, keyless).
 *
 * Same contract spirit as the barcode lookup: every failure mode (offline,
 * timeout, no match, malformed payload) resolves to an empty list / null so
 * callers keep the local estimate. Only products with usable nutrition data
 * are returned (max PAGE_SIZE, already trimmed).
 *
 * Good citizenship: read-only, per-food queries only (the merge layer
 * caches every hit locally forever, so each food is asked about once),
 * polite timeout, JSON fields restricted to what we store.
 */
import { toFiniteNonNegative, energyKcal, DEFAULT_LOOKUP_TIMEOUT_MS } from '@services/barcode/online-lookup';
import type { OnlineBarcodeProduct, OnlineLookupOptions } from '@services/barcode/online-lookup';
import { tokenizeBM25, splitConceptPrep } from '@services/interpreter/lexicon';

export interface OnlineSearchHit extends OnlineBarcodeProduct {
  /** OFF product code (stored as source_reference on merge). */
  code: string;
}

/**
 * Result of a search with the failure mode preserved. Callers that keep a
 * per-session attempt ledger need the distinction: a COMPLETED search that
 * found nothing is a genuine miss (don't ask again this session), while a
 * transport failure (offline, timeout, HTTP error) is an attempt that never
 * happened — burning the ledger on it makes a reconnect look like "enabled
 * but nothing happens" until the app restarts.
 */
export interface OnlineSearchOutcome {
  hits: OnlineSearchHit[];
  transportFailed: boolean;
}

const OFF_SEARCH_BASE = 'https://world.openfoodfacts.org/api/v2/search';
const SEARCH_PAGE_SIZE = 10;

interface OffSearchResponse {
  products?: Array<{
    code?: string | null;
    product_name?: string | null;
    product_name_en?: string | null;
    nutriments?: Record<string, unknown>;
  } | null> | null;
}

function toHit(p: NonNullable<NonNullable<OffSearchResponse['products']>[number]>): OnlineSearchHit | null {
  const code = (p.code || '').trim();
  const name = (p.product_name || p.product_name_en || '').trim();
  if (!code || !name) return null;
  const nutriments = p.nutriments ?? {};
  const caloriesPer100g = energyKcal(nutriments);
  const proteinPer100g = toFiniteNonNegative(nutriments['proteins_100g']);
  const carbsPer100g = toFiniteNonNegative(nutriments['carbohydrates_100g']);
  const fatPer100g = toFiniteNonNegative(nutriments['fat_100g']);
  const hasNutrition =
    caloriesPer100g !== null || proteinPer100g !== null || carbsPer100g !== null || fatPer100g !== null;
  if (!hasNutrition) return null;
  return {
    code,
    productName: name,
    caloriesPer100g: caloriesPer100g ?? 0,
    proteinPer100g: proteinPer100g ?? 0,
    carbsPer100g: carbsPer100g ?? 0,
    fatPer100g: fatPer100g ?? 0,
  };
}

export async function searchFoodsOnline(
  query: string,
  opts: OnlineLookupOptions = {}
): Promise<OnlineSearchHit[]> {
  return (await searchFoodsOnlineOutcome(query, opts)).hits;
}

/** Same search, but reports whether the request itself failed. */
export async function searchFoodsOnlineOutcome(
  query: string,
  opts: OnlineLookupOptions = {}
): Promise<OnlineSearchOutcome> {
  const q = (query || '').trim();
  if (q.length < 2) return { hits: [], transportFailed: false };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url =
      `${OFF_SEARCH_BASE}?search_terms=${encodeURIComponent(q)}` +
      `&fields=code,product_name,product_name_en,nutriments&page_size=${SEARCH_PAGE_SIZE}`;
    // NOTE: browsers/WebViews forbid overriding User-Agent via fetch, so the
    // default UA applies; good citizenship comes from caching (one query per
    // food, ever) instead of header tweaks.
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { hits: [], transportFailed: true };
    const data: OffSearchResponse = await res.json();
    const out: OnlineSearchHit[] = [];
    for (const p of data.products || []) {
      if (!p) continue;
      const hit = toHit(p);
      if (hit) out.push(hit);
    }
    return { hits: out, transportFailed: false };
  } catch {
    return { hits: [], transportFailed: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * E2 candidate matcher: accept the hit whose name covers every query
 * concept token (order-free; "Chicken Shawarma" matches "Shawarma, Chicken,
 * Spicy" but never "Chicken Kebab"). Exact normalized equality short-
 * circuits first. One winner max — ambiguity abstains (keep the estimate).
 * Pure — unit-tested. Deliberately strict: a wrong merge poisons a library
 * row permanently, so near-misses stay local.
 */
export function matchOnlineHit(query: string, hits: OnlineSearchHit[]): OnlineSearchHit | null {
  const qNorm = query.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const { concept } = splitConceptPrep(tokenizeBM25(query));
  if (concept.length === 0) return null;
  for (const hit of hits) {
    if (hit.productName.toLowerCase().replace(/[^a-z0-9]/g, '') === qNorm) return hit;
  }
  for (const hit of hits) {
    const toks = new Set(tokenizeBM25(hit.productName));
    if (concept.every(t => toks.has(t))) return hit;
  }
  return null;
}
