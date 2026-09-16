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
  /**
   * Medoid (gated workbench `eval_novel.py`: tracks the median within ~1%
   * on all four nutrients): id of the real pool row closest to the macro
   * medians. Stored values are that row's measured macros (Atwater kcal
   * derived) — no synthetic medians enter storage; the upserted row points
   * back here via `source_reference`. Provenance upgrade, not accuracy fix.
   */
  supporterId: string;
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
  // Macros medianned independently; kcal DERIVED (Atwater 4/4/9) so the
  // estimate stays coherent. Gated: independent kcal medians decouple from
  // macros on prep pools (L1p kcal +4% before, -62% after).
  const protein = pick(f => f.protein_per_100g);
  const carbs = pick(f => f.carbs_per_100g);
  const fat = pick(f => f.fat_per_100g);
  if (protein === null || carbs === null || fat === null) return null;
  return { kcal: 4 * protein + 4 * carbs + 9 * fat, protein, carbs, fat };
}

/**
 * Medoid snap: the complete pool row closest to the macro medians (mean
 * relative distance over P/C/F). Rows with any missing macro are skipped;
 * null when no complete row exists (caller keeps the flat floor).
 */
function medoidOf(rows: Food[], medians: FallbackNutrients): Food | null {
  let best: Food | null = null;
  let bestDist = Infinity;
  for (const f of rows) {
    const p = f.protein_per_100g;
    const c = f.carbs_per_100g;
    const g = f.fat_per_100g;
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    if (typeof g !== 'number' || !Number.isFinite(g)) continue;
    const dist =
      (Math.abs(p - medians.protein) / (Math.abs(medians.protein) + 1) +
        Math.abs(c - medians.carbs) / (Math.abs(medians.carbs) + 1) +
        Math.abs(g - medians.fat) / (Math.abs(medians.fat) + 1)) / 3;
    if (dist < bestDist) {
      bestDist = dist;
      best = f;
    }
  }
  return best;
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
      const snapped = snapMedoid(prepped, 'L1p');
      if (snapped) return snapped;
    }
  }
  if (pool.length >= MIN_FALLBACK_SUPPORT) {
    const snapped = snapMedoid(pool, 'L1');
    if (snapped) return snapped;
  }
  return null;
}

/**
 * Medians locate the pool's center; the medoid (closest real row) supplies
 * the stored values, so storage never holds synthetic medians. Returns null
 * when the pool has no usable macros or no complete row to snap to.
 */
function snapMedoid(rows: Food[], level: 'L1p' | 'L1'): FallbackEstimate | null {
  const medians = medianNutrients(rows);
  if (!medians) return null;
  const medoid = medoidOf(rows, medians);
  if (!medoid) return null;
  const protein = medoid.protein_per_100g as number;
  const carbs = medoid.carbs_per_100g as number;
  const fat = medoid.fat_per_100g as number;
  return {
    nutrients: { kcal: 4 * protein + 4 * carbs + 9 * fat, protein, carbs, fat },
    level,
    support: rows.length,
    confidence: fallbackConfidence(rows.length),
    supporterId: medoid.id,
  };
}
