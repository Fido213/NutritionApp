/**
 * Estimation v1 (P2): concept-head median fallback for unknown foods.
 *
 * When the app meets a food with no reference, the flat
 * DEFAULT_NUTRIENT_ESTIMATE (200/10/25/5) is the floor — but when the local
 * library holds >= MIN_FALLBACK_SUPPORT rows under the same concept head
 * ("chicken" in "Chicken, breast, grilled"), their per-nutrient medians are
 * a better guess. Deterministic, offline, no new dependencies: the head and
 * prep machinery is the same lexicon the ranker already trusts.
 *
 * Gated before wiring (pre-registered bar: pooled kcal MAE win + no macro
 * regression >2%): EN-91 + 661-personal replay (workbench-only, nothing
 * ships) gave pooled kcal -2.1%, protein -4.7%, carbs -5.4%, fat -4.1% vs
 * flat; wins concentrate in the ~10% of OOV with head support, the rest
 * take the flat floor unchanged. Report:
 * `ai models/results/eval_fallback_report.json` (gitignored workbench).
 *
 * Pure + total: same candidates in, same estimate out. Returns null when
 * there is no head support (caller keeps the flat floor) or when the query
 * names no concept at all.
 */
import { tokenizeBM25, splitConceptPrep, headOf } from '@services/interpreter/lexicon';
import type { Food } from '@data/types';

/** Minimum head supporters before the median is trusted over the flat floor. */
export const MIN_FALLBACK_SUPPORT = 5;

export interface FallbackNutrients {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface FallbackEstimate {
  nutrients: FallbackNutrients;
  level: 'L1p' | 'L1';
  support: number;
  /** Display-only, fixed formula (matches the gated eval script). */
  confidence: number;
}

function medianOf(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianNutrients(rows: Food[]): FallbackNutrients | null {
  const pick = (get: (f: Food) => number | null): number | null => {
    const vals = rows.map(get).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return medianOf(vals);
  };
  const kcal = pick(f => f.calories_per_100g);
  const protein = pick(f => f.protein_per_100g);
  const carbs = pick(f => f.carbs_per_100g);
  const fat = pick(f => f.fat_per_100g);
  if (kcal === null || protein === null || carbs === null || fat === null) return null;
  return { kcal, protein, carbs, fat };
}

/** Fixed support-based confidence: 0.4 at floor support, saturating at 0.6. */
export function fallbackConfidence(support: number): number {
  return Math.min(0.6, 0.4 + 0.02 * Math.min(support, 10));
}

export function medianFallbackEstimate(
  candidates: Food[],
  queryName: string,
  excludeNormalized: string | null = null,
): FallbackEstimate | null {
  const { concept, prep } = splitConceptPrep(tokenizeBM25(queryName));
  if (concept.length === 0) return null;
  const pool = candidates.filter(f => {
    if (excludeNormalized && f.normalized_name === excludeNormalized) return false;
    const head = headOf(f.canonical_name);
    return head.length === concept.length && head.every((t, i) => t === concept[i]);
  });
  // Specific first: supporters carrying every queried prep word.
  if (prep.length > 0) {
    const prepped = pool.filter(f => {
      const toks = new Set(tokenizeBM25(f.canonical_name));
      return prep.every(p => toks.has(p));
    });
    if (prepped.length >= MIN_FALLBACK_SUPPORT) {
      const nutrients = medianNutrients(prepped);
      if (nutrients) {
        return { nutrients, level: 'L1p', support: prepped.length, confidence: fallbackConfidence(prepped.length) };
      }
    }
  }
  if (pool.length >= MIN_FALLBACK_SUPPORT) {
    const nutrients = medianNutrients(pool);
    if (nutrients) {
      return { nutrients, level: 'L1', support: pool.length, confidence: fallbackConfidence(pool.length) };
    }
  }
  return null;
}
