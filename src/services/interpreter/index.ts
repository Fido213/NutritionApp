/**
 * Interpreter — deterministic qty + L12 NER spans -> hybrid retrieval -> canonical foods.
 *
 * Locked architecture: L12 NER extracts spans, mE5 retrieves, qty parser normalizes to grams.
 * Replaces Gemma interprets (GemmaClient) for base APK — strict offline, <300MB.
 *
 * Exposes both per-span (for logging) and per-input (for FoodService) helpers.
 */

import { parseQuantities, resolveBareCount } from './unit-parser';
import { extractFoodSpans, extractFoodSpansSync, type FoodSpan } from './ner-client';
import { hybridRetrieve, hybridRetrieveSync, buildBm25Index, addFoodsToIndex, type RetrievalHit } from './hybrid-retriever';
import { cacheFoodEmbeddings } from './faiss-bridge';
import { resolveVagueMarker, governedByNegation, stripReceiptTail } from './lexicon';
import { splitComboSegments, groundSegments, segmentResolves } from './combo-split';
import type { ScriptTag } from './language';
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
  /**
   * Phase 1 flagged-default: true when no quantity or vague marker was found
   * and `defaultGrams` was assumed. The UI must surface these as
   * "amount assumed — tap to correct", never as confident parses.
   */
  wasDefault: boolean;
  /** Script router hint, copied from the source span (future dispatch). */
  script?: ScriptTag;
  /**
   * E3 split group: the original span text when this span was split off a
   * quantity-less multi-food span ("eggs, bacon" -> "eggs" + "bacon" both
   * carry splitGroup "eggs, bacon"). Logging logs group members under one
   * shared combo-marker observation so the journal renders ONE collapsible
   * row (split for math, clustered for display). Absent otherwise.
   */
  splitGroup?: string;
}

let foodsCache: Food[] | null = null;
/** Library generation the cached BM25 index was built from (-1 = cold). */
let indexedVersion = -1;

export function setFoodsForInterpreter(foods: Food[], version?: number): void {
  // Version-gated rebuild: steady-state submits reuse the warm index (the
  // 39k-row refetch + rebuild every submit was the submit-path seconds).
  // Callers without a version (tests, one-shots) always rebuild.
  if (version !== undefined && version === indexedVersion && foodsCache) return;
  foodsCache = foods;
  if (version !== undefined) indexedVersion = version;
  buildBm25Index(foods);
}

/** Generation currently indexed (tests + submit-path decisions). */
export function getIndexedVersion(): number {
  return indexedVersion;
}

/**
 * Incrementally fold changed rows (usually 0–2 upserts from the submit that
 * just logged) into a WARM index: postings + embeddings update in place and
 * the cached array gains/replaces the rows, so every downstream reader
 * (BM25, hash channel, id lookups) stays complete. The array is mutated in
 * place deliberately — its identity is the faiss cache key.
 * Returns false when cold (caller falls back to a full fetch + setFoods).
 */
export function patchInterpreterFoods(changed: Food[], version: number): boolean {
  if (!foodsCache || indexedVersion === -1) return false;
  if (!addFoodsToIndex(changed)) return false;
  if (!cacheFoodEmbeddings(changed)) return false;
  for (const f of changed) {
    const at = foodsCache.findIndex(x => x.id === f.id);
    if (at === -1) foodsCache.push(f);
    else foodsCache[at] = f;
  }
  indexedVersion = version;
  return true;
}

interface ResolvedSpanAmount {
  amountG: number | null;
  amountMl: number | null;
  rawUnit: string | null;
  confidence: number;
  wasDefault: boolean;
}

/**
 * Single qty-resolution path shared by interpretText / interpretTextSync /
 * alignQuantities (Phase 1 merge semantics: grams wrong = qty bug).
 *
 * Order: nearest explicit qty → bare-count with food hint → vague-marker
 * lexicon estimate (visible, 0.70) → flagged default (visible, ≤0.65).
 * The parser itself never invents grams; only this function assumes, and it
 * always says so via `wasDefault`.
 */
function resolveSpanAmount(
  text: string,
  spanText: string,
  span: [number, number],
  spanConfidence: number,
  qtys: ReturnType<typeof parseQuantities>,
  defaultGrams: number,
): ResolvedSpanAmount {
  const qty = nearestQty(span, qtys);
  if (qty) {
    if (qty.amountG !== null || qty.amountMl !== null) {
      return {
        amountG: qty.amountG,
        amountMl: qty.amountMl,
        rawUnit: qty.unitText,
        confidence: Math.min(0.92, (spanConfidence + qty.confidence) / 2 + 0.05),
        wasDefault: false,
      };
    }
    // Bare count like "2 apples" — resolved via piece weights. A count of a
    // food with no known piece weight ("1 chicken") resolves to null: the
    // amount is unknown, so fall through to vague/flagged-default below
    // instead of faking grams.
    const resolved = resolveBareCount(qty, spanText);
    if (resolved) {
      return {
        amountG: resolved.amountG,
        amountMl: resolved.amountMl,
        rawUnit: resolved.unitText,
        confidence: 0.72,
        wasDefault: false,
      };
    }
  }
  // No explicit qty: vague marker in the span window ("a side of rice").
  const window = text.slice(Math.max(0, span[0] - 40), Math.min(text.length, span[1] + 40));
  const vague = resolveVagueMarker(window);
  if (vague) {
    return {
      amountG: vague.amountG,
      amountMl: vague.amountMl,
      rawUnit: `~${vague.id}`,
      confidence: 0.7,
      wasDefault: false,
    };
  }
  // Flagged default — visible assumption, capped confidence, never silent.
  return {
    amountG: defaultGrams,
    amountMl: null,
    rawUnit: null,
    confidence: Math.min(0.65, spanConfidence),
    wasDefault: true,
  };
}

/** Drop food spans governed by a negation marker, pre-retrieval. */
function dropNegatedSpans<T extends { span: [number, number] }>(text: string, spans: T[]): T[] {
  return spans.filter((s) => !governedByNegation(text, s.span[0]));
}

/**
 * Main entry — text like "250g poulet, 100g riz" (any lang) -> spans with amounts.
 * Amounts are aligned to NER spans by proximity (nearest qty).
 */
export async function interpretText(
  rawInput: string,
  foods: Food[] | null = foodsCache,
  opts: { defaultGrams?: number; counts?: Map<string, number> } = {}
): Promise<InterpretedSpan[]> {
  if (!rawInput || rawInput.trim().length === 0) return [];
  // Receipt pastes ("... 110 kcal | 240ml Hydration ... Acc: 95%") parse the
  // food phrase only — macro numbers must never become quantities. Tail-cut
  // preserves offsets, so spans stay valid against the raw input.
  const text = stripReceiptTail(rawInput).normalize('NFKC');
  if (text.trim().length === 0) return [];
  const qtys = parseQuantities(text);
  const spans = dropNegatedSpans(text, await extractFoodSpans(text, qtys));

  if (spans.length === 0) return [];
  if (!foods || foods.length === 0) {
    // No foods loaded yet — return spans with amounts but no retrieval score
    return alignQuantities(text, spans, qtys, opts.defaultGrams ?? 100);
  }

  // E3 combo split: one quantity-less span that is really several known
  // foods ("Sweet Potato, Eggs, Ham, Cheese") logs one item per segment.
  // Fires only when EVERY segment resolves (exact key or same concept
  // head — segmentResolves); a single miss vetoes the split and the span
  // logs whole, exactly as today. Quantity-led inputs never reach here —
  // each qty already owns its span. Pre-retrieved best hits are reused by
  // the main loop below (no double retrieval cost on the fire path).
  let work: FoodSpan[] = spans;
  const preRetrieved = new Map<string, RetrievalHit>();
  if (qtys.length === 0 && spans.length === 1) {
    const parts = splitComboSegments(spans[0].text);
    const grounded = parts ? groundSegments(text, spans[0].span[0], parts, spans[0].script) : null;
    if (grounded && grounded.every(g => segmentResolves(foods, g.text))) {
      const gated: FoodSpan[] = [];
      for (const g of grounded) {
        const hit = (await hybridRetrieve(g.text, foods, { topK: 1, counts: opts.counts }))[0];
        if (!hit) { gated.length = 0; break; }
        preRetrieved.set(g.text, hit);
        gated.push({
          text: g.text,
          normalized: g.text.toLowerCase().normalize('NFKC').trim(),
          span: g.span,
          confidence: spans[0].confidence,
          isCompositeHint: spans[0].isCompositeHint,
          script: g.script,
          splitGroup: spans[0].text,
        });
      }
      if (gated.length === grounded.length) work = gated;
      else preRetrieved.clear();
    }
  }

  const out: InterpretedSpan[] = [];
  for (const span of work) {
    const hybrid = preRetrieved.get(span.text) ? [preRetrieved.get(span.text)!] : await hybridRetrieve(span.text, foods, { topK: 3, counts: opts.counts });
    const best = hybrid[0];
    // Validate threshold: cos>0.72 or BM25>6/10 normalized >0.6
    // If below, mark low confidence but still return span text as canonical (will upsert as new food)
    const retrievalScore = best?.score ?? 0;
    const method = best?.method ?? 'hybrid';
    const amt = resolveSpanAmount(text, span.text, span.span, span.confidence, qtys, opts.defaultGrams ?? 100);
    const amountG = amt.amountG;
    const amountMl = amt.amountMl;

    // Clamp 0-5000
    const g = amountG ?? amountMl ?? 0;
    if (g < 0 || g > 5000) continue;

    out.push({
      canonicalName: best ? best.food.canonical_name : span.text,
      amountG,
      amountMl,
      confidence: retrievalScore < 0.4 ? Math.min(amt.confidence, 0.68) : amt.confidence,
      isComposite: !!span.isCompositeHint,
      span: span.span,
      retrievalScore,
      method,
      rawUnit: amt.rawUnit,
      wasDefault: amt.wasDefault,
      script: span.script,
      splitGroup: span.splitGroup,
    });
  }

  return out;
}

/** Sync variant for tests / fallback shim. */
export function interpretTextSync(rawInput: string, foods: Food[] | null = foodsCache, opts: { defaultGrams?: number; counts?: Map<string, number> } = {}): InterpretedSpan[] {
  if (!rawInput || rawInput.trim().length === 0) return [];
  const text = stripReceiptTail(rawInput).normalize('NFKC');
  if (text.trim().length === 0) return [];
  const qtys = parseQuantities(text);
  const spans = dropNegatedSpans(text, extractFoodSpansSync(text, qtys));
  if (spans.length === 0) return [];
  if (!foods || foods.length === 0) return alignQuantities(text, spans, qtys, opts.defaultGrams ?? 100);

  // E3 combo split (sync mirror of the async path above — same gate).
  let work: FoodSpan[] = spans;
  const preRetrieved = new Map<string, RetrievalHit>();
  if (qtys.length === 0 && spans.length === 1) {
    const parts = splitComboSegments(spans[0].text);
    const grounded = parts ? groundSegments(text, spans[0].span[0], parts, spans[0].script) : null;
    if (grounded && grounded.every(g => segmentResolves(foods, g.text))) {
      const gated: FoodSpan[] = [];
      for (const g of grounded) {
        const hit = hybridRetrieveSync(g.text, foods, 1, opts.counts)[0];
        if (!hit) { gated.length = 0; break; }
        preRetrieved.set(g.text, hit);
        gated.push({
          text: g.text,
          normalized: g.text.toLowerCase().normalize('NFKC').trim(),
          span: g.span,
          confidence: spans[0].confidence,
          isCompositeHint: spans[0].isCompositeHint,
          script: g.script,
          splitGroup: spans[0].text,
        });
      }
      if (gated.length === grounded.length) work = gated;
      else preRetrieved.clear();
    }
  }

  const out: InterpretedSpan[] = [];
  for (const span of work) {
    const hybrid = preRetrieved.get(span.text) ? [preRetrieved.get(span.text)!] : hybridRetrieveSync(span.text, foods, 3, opts.counts);
    const best = hybrid[0];
    const retrievalScore = best?.score ?? 0;
    const method = best?.method ?? 'hybrid';
    const amt = resolveSpanAmount(text, span.text, span.span, span.confidence, qtys, opts.defaultGrams ?? 100);
    const g = amt.amountG ?? amt.amountMl ?? 0;
    if (g < 0 || g > 5000) continue;
    out.push({
      canonicalName: best ? best.food.canonical_name : span.text,
      amountG: amt.amountG, amountMl: amt.amountMl,
      confidence: retrievalScore < 0.4 ? Math.min(amt.confidence, 0.68) : amt.confidence,
      isComposite: !!span.isCompositeHint,
      span: span.span,
      retrievalScore, method, rawUnit: amt.rawUnit,
      wasDefault: amt.wasDefault,
      script: span.script,
      splitGroup: span.splitGroup,
    });
  }
  return out;
}

/** Nearest qty to a span (≤30 chars), preferring qty-before-span. Exported for the merge harness. */
export function nearestQty(span: [number, number], qtys: ReturnType<typeof parseQuantities>): ReturnType<typeof parseQuantities>[number] | null {
  if (qtys.length === 0) return null;
  // Prefer qty that ends just before span starts (e.g., "250g chicken")
  let best: ReturnType<typeof parseQuantities>[number] | null = null;
  let bestDist = Infinity;
  for (const q of qtys) {
    // Distance: if qty immediately before span, distance = span[0]-q.span[1] (small positive)
    // If qty after span, small penalty (food-first order: "chicken 250g").
    // The penalty preserves before-preference on ties ("chicken 100g rice"
    // still binds the qty forward to rice) without vetoing food-first logs.
    let dist: number;
    if (q.span[1] <= span[0]) dist = span[0] - q.span[1];
    else if (q.span[0] >= span[1]) dist = q.span[0] - span[1] + 10;
    else dist = 0; // overlap
    // Prefer used once — track but simple nearest
    if (dist < bestDist) { bestDist = dist; best = q; }
  }
  // Only align if reasonably close (<30 chars)
  if (bestDist > 30) return null;
  return best;
}

function alignQuantities(
  text: string,
  spans: ReturnType<typeof extractFoodSpansSync>,
  qtys: ReturnType<typeof parseQuantities>,
  defaultGrams: number
): InterpretedSpan[] {
  return spans.map(span => {
    const amt = resolveSpanAmount(text, span.text, span.span, span.confidence, qtys, defaultGrams);
    return {
      canonicalName: span.text,
      amountG: amt.amountG, amountMl: amt.amountMl,
      confidence: amt.confidence,
      isComposite: !!span.isCompositeHint,
      span: span.span,
      retrievalScore: 0,
      method: 'hybrid' as const,
      rawUnit: amt.rawUnit,
      wasDefault: amt.wasDefault,
      script: span.script,
      splitGroup: span.splitGroup,
    };
  });
}
