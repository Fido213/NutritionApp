/**
 * Deterministic multilingual quantity parser (Duckling-style, code-calculates).
 * Extracts grounded quantity spans from original text -> normalized grams/ml.
 *
 * Covers Europe/N-Africa/Americas/AU: en/fr/de/es/it/nl/pl/tr/ar/pt
 * No LLM — all rule-based, <5ms.
 *
 * Handles: 250g, 1.5kg, ½ cup, 12,5g, 2x150g, 2 apples, 100-150g→125g, 1 1/2 lb
 */

import { normalizeAmount, parseLocalizedNumber, resolveUnit } from '@domain/units';

export interface ParsedQuantity {
  /** original substring that is the quantity (e.g., "250g") */
  raw: string;
  /** char span [start, end) in original text */
  span: [number, number];
  /** normalized grams or ml (exactly one non-null) */
  amountG: number | null;
  amountMl: number | null;
  /** canonical grams (if ml, null; caller may convert via food density) */
  canonicalGrams: number | null;
  /** original numeric value before conversion */
  originalValue: number;
  /** unit text as in input */
  unitText: string | null;
  /** was range (100-150) and averaged */
  wasRange: boolean;
  /** was multiplier (2x150g) and already multiplied */
  wasMultiplier: boolean;
  /** confidence 0.9 explicit unit, 0.7 bare/count */
  confidence: number;
}

const FRACTION_CHARS = '½¼¾⅓⅔⅛';
const NUM_RE = `(?:\\d+(?:[.,]\\d+)?|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|[${FRACTION_CHARS}])`;
// Unit tokens: 1-2 letters plus known words (cup, tbsp, etc.) + Arabic, or piece words
const UNIT_RE = String.raw`(?:kg|kgs?|g|mg|oz|lbs?|lb|l|ml|cup|cups|tasse|tassen|taza|tazas|كوب|أكواب|ltr|liter|litre|liters|litres|لتر|مل|tbsp|tbsps?|tablespoon|tsp|teaspoon|el|tl|cc|piece|pieces|stück|morceau|قطعة|can|dose|boîte|علبة|egg|eggs|ei|eier|œuf|œufs|بيضة|slice|scheibe|tranche|شريحة)\.?`;

// Patterns in priority order
// 1) multiplier: 2x150g / 2 x 150 g
const MULT_RE = new RegExp(`(${NUM_RE})\\s*[xX×]\\s*(${NUM_RE})\\s*(${UNIT_RE})?`, 'giu');
// 2) range: 100-150g / 100 to 150 g
const RANGE_RE = new RegExp(`(${NUM_RE})\\s*(?:-|–|—|to|bis|à)\\s*(${NUM_RE})\\s*(${UNIT_RE})?`, 'giu');
// 3) qty+unit: 250g / 1.5 kg / ½ cup / 12,5g
const QTY_UNIT_RE = new RegExp(`(${NUM_RE})\\s*(${UNIT_RE})(?=\\b|\\s|$)`, 'giu');
// 4) bare count: 2 apples (digit + no unit, food word handled later) — extracted as fallback

export function parseQuantities(text: string): ParsedQuantity[] {
  const out: ParsedQuantity[] = [];
  const seen = new Set<string>(); // dedupe by span key

  const add = (p: ParsedQuantity) => {
    const key = `${p.span[0]}-${p.span[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Clamp 0-5000 (spec §28 validateItems)
    const g = p.amountG ?? p.amountMl ?? 0;
    if (g < 0 || g > 5000) return;
    out.push(p);
  };

  // 1) Multipliers 2x150g
  for (const m of text.matchAll(MULT_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const end = start + raw.length;
    const mult = parseLocalizedNumber(m[1]);
    const val = parseLocalizedNumber(m[2]);
    const unit = m[3] || null;
    if (mult === null || val === null) continue;
    const total = mult * val;
    const { amountG, amountMl } = normalizeAmount(total, unit);
    add({
      raw, span: [start, end],
      amountG, amountMl,
      canonicalGrams: amountG,
      originalValue: total, unitText: unit,
      wasRange: false, wasMultiplier: true,
      confidence: unit ? 0.9 : 0.7,
    });
  }

  // 2) Ranges 100-150g -> avg
  for (const m of text.matchAll(RANGE_RE)) {
    const raw = m[0];
    // Skip if already consumed by multiplier (overlap)
    const start = m.index ?? 0;
    const end = start + raw.length;
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    const a = parseLocalizedNumber(m[1]);
    const b = parseLocalizedNumber(m[2]);
    const unit = m[3] || null;
    if (a === null || b === null) continue;
    const avg = (a + b) / 2;
    const { amountG, amountMl } = normalizeAmount(avg, unit);
    add({
      raw, span: [start, end],
      amountG, amountMl,
      canonicalGrams: amountG,
      originalValue: avg, unitText: unit,
      wasRange: true, wasMultiplier: false,
      confidence: unit ? 0.85 : 0.65,
    });
  }

  // 3) Normal qty+unit
  for (const m of text.matchAll(QTY_UNIT_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const end = start + raw.length;
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    // Skip if inside already captured range/multiplier
    if ([...seen].some(k => {
      const [s, e] = k.split('-').map(Number);
      return start >= s && end <= e;
    })) continue;
    const val = parseLocalizedNumber(m[1]);
    const unit = m[2] || null;
    if (val === null) continue;
    // Filter false positives where unit is actually a food word (apple) without number semantics
    // Keep piece units, else require resolveUnit to exist
    if (unit && !resolveUnit(unit) && !/^(piece|pieces|stück|morceau|قطعة|can|dose|egg|eggs|ei|eier|œuf|slice)$/i.test(unit)) {
      // Might be food word like "chicken" — skip, will be bare number fallback if needed
      // But "1 chicken" should be piece; we allow bare count path
      continue;
    }
    const { amountG, amountMl } = normalizeAmount(val, unit);
    add({
      raw, span: [start, end],
      amountG, amountMl,
      canonicalGrams: amountG,
      originalValue: val, unitText: unit,
      wasRange: false, wasMultiplier: false,
      confidence: unit ? 0.9 : 0.7,
    });
  }

  // 4) Bare numbers that are likely counts (e.g., "2 apples") — only if no qty yet near that position
  // We extract standalone numbers 1-20 that are followed by a word and not already captured
  const BARE_RE = new RegExp(`\\b(${NUM_RE})\\b(?=\\s+[A-Za-z\\p{L}]{2,})`, 'gu');
  for (const m of text.matchAll(BARE_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const end = start + raw.length;
    // skip if overlap with existing qty
    const overlaps = out.some(p => !(end <= p.span[0] || start >= p.span[1]));
    if (overlaps) continue;
    const val = parseLocalizedNumber(m[1]);
    if (val === null || val <= 0 || val > 20) continue; // only 1-20 bare counts are plausible food counts
    // Must be followed by a plausible food context (heuristic: not already a weight)
    // Keep low confidence — the NER+retriever will decide if it's a food count
    add({
      raw, span: [start, end],
      amountG: null, amountMl: null, // bare count — resolved later with food hint via PER_PIECE
      canonicalGrams: null,
      originalValue: val, unitText: null,
      wasRange: false, wasMultiplier: false,
      confidence: 0.6,
    });
  }

  // Sort by span
  out.sort((a, b) => a.span[0] - b.span[0]);
  return out;
}

/** Helper to resolve bare count once food hint is known (piece weight). */
export function resolveBareCount(qty: ParsedQuantity, foodHint: string): ParsedQuantity {
  if (qty.amountG !== null || qty.amountMl !== null) return qty;
  const { amountG } = normalizeAmount(qty.originalValue, null, foodHint);
  // Re-normalize with food hint via PER_PIECE
  const { amountG: g } = normalizeAmount(qty.originalValue, foodHint ? foodHint : 'piece', foodHint);
  return { ...qty, amountG: g ?? amountG, canonicalGrams: g ?? amountG, confidence: 0.65 };
}
