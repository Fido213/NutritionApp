/**
 * Online barcode lookup via the public Open Food Facts API.
 *
 * Spec §7.4: SQLite lookup -> optional internet lookup -> save locally,
 * otherwise ask the user to scan the nutrition label.
 *
 * Every failure mode (offline, timeout, unknown product, no nutrition data,
 * malformed payload) resolves to `null` so callers fall back to label scanning.
 * Only products with usable nutrition data are returned.
 */

export interface OnlineBarcodeProduct {
  productName: string;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

export interface OnlineLookupOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const OPEN_FOOD_FACTS_BASE = 'https://world.openfoodfacts.org/api/v2/product';
export const DEFAULT_LOOKUP_TIMEOUT_MS = 6000;
export const KCAL_PER_KJ = 4.184;

interface OffProductResponse {
  status?: number;
  product?: {
    product_name?: string | null;
    product_name_en?: string | null;
    nutriments?: Record<string, unknown>;
  } | null;
}

function toFiniteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

function energyKcal(nutriments: Record<string, unknown>): number | null {
  const kcal = toFiniteNonNegative(nutriments['energy-kcal_100g']);
  if (kcal !== null) return kcal;
  const kj = toFiniteNonNegative(nutriments['energy_100g']);
  if (kj === null) return null;
  return Math.round((kj / KCAL_PER_KJ) * 10) / 10;
}

export async function lookupBarcodeOnline(
  barcode: string,
  opts: OnlineLookupOptions = {}
): Promise<OnlineBarcodeProduct | null> {
  const code = (barcode || '').trim();
  if (!/^\d{6,14}$/.test(code)) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(
      `${OPEN_FOOD_FACTS_BASE}/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,nutriments,status`,
      { signal: controller.signal, headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;

    const data: OffProductResponse = await res.json();
    if (data.status !== 1 || !data.product) return null;

    const name = (data.product.product_name || data.product.product_name_en || '').trim();
    if (!name) return null;

    const nutriments = data.product.nutriments ?? {};
    const caloriesPer100g = energyKcal(nutriments);
    const proteinPer100g = toFiniteNonNegative(nutriments['proteins_100g']);
    const carbsPer100g = toFiniteNonNegative(nutriments['carbohydrates_100g']);
    const fatPer100g = toFiniteNonNegative(nutriments['fat_100g']);

    const hasNutrition =
      caloriesPer100g !== null || proteinPer100g !== null || carbsPer100g !== null || fatPer100g !== null;
    if (!hasNutrition) return null;

    return {
      productName: name,
      caloriesPer100g: caloriesPer100g ?? 0,
      proteinPer100g: proteinPer100g ?? 0,
      carbsPer100g: carbsPer100g ?? 0,
      fatPer100g: fatPer100g ?? 0
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}