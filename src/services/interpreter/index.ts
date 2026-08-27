/**
 * Interpreter — deterministic qty + L12 NER spans -> hybrid retrieval -> canonical foods.
 *
 * Locked architecture: L12 NER extracts spans, mE5 retrieves, qty parser normalizes to grams.
 * Replaces Gemma interprets (GemmaClient) for base APK — strict offline, <300MB.
 *
 * Exposes both per-span (for logging) and per-input (for FoodService) helpers.
 */

import { parseQuantities, resolveBareCount } from './unit-parser';
import { extractFoodSpans, extractFoodSpansSync } from './ner-client';
import { hybridRetrieve, hybridRetrieveSync, buildBm25Index } from './hybrid-retriever';
import type { Food } from '@data/types';

export interface InterpretedSpan {
  canonicalName: string; // English span text (grounded in original)
  amountG: number | null;
  amountMl: number | null;
  confidence: number;
  isComposite: boolean;
  span: [number, number];
  retrievalScore: number;
  method: 'exact' | 'alias' | 'hybrid';
  rawUnit: string | null;
}

let foodsCache: Food[] | null = null;

export function setFoodsForInterpreter(foods: Food[]): void {
  foodsCache = foods;
  buildBm25Index(foods);
}

/**
 * Main entry — text like "250g poulet, 100g riz" (any lang) -> spans with amounts.
 * Amounts are aligned to NER spans by proximity (nearest qty).
 */
export async function interpretText(
  rawInput: string,
  foods: Food[] | null = foodsCache,
  opts: { defaultGrams?: number } = {}
): Promise<InterpretedSpan[]> {
  if (!rawInput || rawInput.trim().length === 0) return [];
  const text = rawInput.normalize('NFKC');
  const qtys = parseQuantities(text);
  const spans = await extractFoodSpans(text, qtys);

  if (spans.length === 0) return [];
  if (!foods || foods.length === 0) {
    // No foods loaded yet — return spans with amounts but no retrieval score
    return alignQuantities(spans, qtys, opts.defaultGrams ?? 100);
  }

  const out: InterpretedSpan[] = [];
  for (const span of spans) {
    const hybrid = await hybridRetrieve(span.text, foods, { topK: 3 });
    const best = hybrid[0];
    // Validate threshold: cos>0.72 or BM25>6/10 normalized >0.6
    // If below, mark low confidence but still return span text as canonical (will upsert as new food)
    const retrievalScore = best?.score ?? 0;
    const method = best?.method ?? 'hybrid';
    // Align qty: nearest qty to span
    const qty = nearestQty(span.span, qtys);
    let amountG: number | null = null;
    let amountMl: number | null = null;
    let rawUnit: string | null = null;
    let conf = span.confidence;
    if (qty) {
      rawUnit = qty.unitText;
      if (qty.amountG !== null || qty.amountMl !== null) {
        amountG = qty.amountG;
        amountMl = qty.amountMl;
        conf = Math.min(0.92, (span.confidence + qty.confidence) / 2 + 0.05);
      } else {
        // Bare count like "2 apples"
        const resolved = resolveBareCount(qty, span.text);
        amountG = resolved.amountG;
        amountMl = resolved.amountMl;
        rawUnit = resolved.unitText;
        conf = 0.72;
      }
    } else {
      amountG = opts.defaultGrams ?? 100;
      conf = Math.max(0.65, span.confidence - 0.1);
    }

    // Clamp 0-5000
    const g = amountG ?? amountMl ?? 0;
    if (g < 0 || g > 5000) continue;

    out.push({
      canonicalName: best ? best.food.canonical_name : span.text,
      amountG,
      amountMl,
      confidence: retrievalScore < 0.4 ? Math.min(conf, 0.68) : conf,
      isComposite: !!span.isCompositeHint,
      span: span.span,
      retrievalScore,
      method,
      rawUnit,
    });
  }

  return out;
}

/** Sync variant for tests / fallback shim. */
export function interpretTextSync(rawInput: string, foods: Food[] | null = foodsCache, opts: { defaultGrams?: number } = {}): InterpretedSpan[] {
  if (!rawInput || rawInput.trim().length === 0) return [];
  const text = rawInput.normalize('NFKC');
  const qtys = parseQuantities(text);
  const spans = extractFoodSpansSync(text, qtys);
  if (spans.length === 0) return [];
  if (!foods || foods.length === 0) return alignQuantities(spans, qtys, opts.defaultGrams ?? 100);

  const out: InterpretedSpan[] = [];
  for (const span of spans) {
    const hybrid = hybridRetrieveSync(span.text, foods, 3);
    const best = hybrid[0];
    const retrievalScore = best?.score ?? 0;
    const method = best?.method ?? 'hybrid';
    const qty = nearestQty(span.span, qtys);
    let amountG: number | null = null;
    let amountMl: number | null = null;
    let rawUnit: string | null = null;
    let conf = span.confidence;
    if (qty) {
      rawUnit = qty.unitText;
      if (qty.amountG !== null || qty.amountMl !== null) {
        amountG = qty.amountG;
        amountMl = qty.amountMl;
        conf = Math.min(0.92, (span.confidence + qty.confidence) / 2 + 0.05);
      } else {
        const resolved = resolveBareCount(qty, span.text);
        amountG = resolved.amountG;
        amountMl = resolved.amountMl;
        rawUnit = resolved.unitText;
        conf = 0.72;
      }
    } else {
      amountG = opts.defaultGrams ?? 100;
      conf = Math.max(0.65, span.confidence - 0.1);
    }
    const g = amountG ?? amountMl ?? 0;
    if (g < 0 || g > 5000) continue;
    out.push({
      canonicalName: best ? best.food.canonical_name : span.text,
      amountG, amountMl,
      confidence: retrievalScore < 0.4 ? Math.min(conf, 0.68) : conf,
      isComposite: !!span.isCompositeHint,
      span: span.span,
      retrievalScore, method, rawUnit,
    });
  }
  return out;
}

function nearestQty(span: [number, number], qtys: ReturnType<typeof parseQuantities>): ReturnType<typeof parseQuantities>[number] | null {
  if (qtys.length === 0) return null;
  // Prefer qty that ends just before span starts (e.g., "250g chicken")
  let best: ReturnType<typeof parseQuantities>[number] | null = null;
  let bestDist = Infinity;
  for (const q of qtys) {
    // Distance: if qty immediately before span, distance = span[0]-q.span[1] (small positive)
    // If qty after span, larger penalty
    let dist: number;
    if (q.span[1] <= span[0]) dist = span[0] - q.span[1];
    else if (q.span[0] >= span[1]) dist = q.span[0] - span[1] + 50; // after is less likely
    else dist = 0; // overlap
    // Prefer used once — track but simple nearest
    if (dist < bestDist) { bestDist = dist; best = q; }
  }
  // Only align if reasonably close (<30 chars)
  if (bestDist > 30) return null;
  return best;
}

function alignQuantities(
  spans: ReturnType<typeof extractFoodSpansSync>,
  qtys: ReturnType<typeof parseQuantities>,
  defaultGrams: number
): InterpretedSpan[] {
  return spans.map(span => {
    const q = nearestQty(span.span, qtys);
    let amountG: number | null = null;
    let amountMl: number | null = null;
    let rawUnit: string | null = null;
    if (q) {
      if (q.amountG !== null || q.amountMl !== null) {
        amountG = q.amountG;
        amountMl = q.amountMl;
        rawUnit = q.unitText;
      } else {
        const r = resolveBareCount(q, span.text);
        amountG = r.amountG;
        rawUnit = r.unitText;
      }
    } else amountG = defaultGrams;
    return {
      canonicalName: span.text,
      amountG, amountMl,
      confidence: span.confidence,
      isComposite: !!span.isCompositeHint,
      span: span.span,
      retrievalScore: 0,
      method: 'hybrid' as const,
      rawUnit,
    };
  });
}
