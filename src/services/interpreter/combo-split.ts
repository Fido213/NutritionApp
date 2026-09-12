/**
 * Estimation v1 (E3): precision-first combo splitting for quantity-less spans.
 *
 * The OOV path turns "Sweet Potato, Eggs, Ham, Cheese" (no quantities
 * anywhere) into ONE upserted food with a flat guess. When the text is
 * really several known foods, it must log several items instead.
 *
 * Frozen, workbench-gated rule (`ai models/eval/eval_combosplit.py`):
 * 22/22 personal fires read as legitimate splits; 35 qty-carrying + 54
 * unresolvable + 550 single-segment inputs abstain.
 *
 * A segment "resolves" iff it exact-matches a library key (normalized or
 * legacy stripped form — the same keys resolveFood looks up) OR some
 * library row carries its concept as head (the app's own concept rule from
 * lexicon.ts — the exact criterion the workbench gate measured). One
 * unresolved segment vetoes the whole split and the span logs whole,
 * exactly as today. Deliberately NOT score-based: fused RRF scores for
 * non-exact matches sit at ~0.016, so any score line either vetoes
 * everything or waves everything through.
 */
import { normalizeFoodName } from '@domain/logging';
import { tokenizeBM25, splitConceptPrep, headOf } from './lexicon';
import type { ScriptTag } from './language';
import type { Food } from '@data/types';

/** Delimiters that join separately-loggable foods (mirrors the eval script). */
const SPLIT_RE = /\s*(?:,|&|\+|\bwith\b|\band\b|\bplus\b)\s*/i;

/**
 * Split span text into candidate food segments. Returns null when the text
 * is a single segment (normal food name — the common case, fast out).
 * Quantity policing lives with the caller: it only offers quantity-less
 * spans (the qty parser owns everything with explicit amounts).
 */
export function splitComboSegments(spanText: string): string[] | null {
  if (!spanText) return null;
  const parts = spanText
    .split(SPLIT_RE)
    .map(p => p.trim().replace(/^[.,;]+|[.,;]+$/g, ''))
    .filter(p => p.length >= 2);
  return parts.length >= 2 ? parts : null;
}

export interface SplitSegment {
  text: string;
  span: [number, number];
  script?: ScriptTag;
}

/**
 * Ground each part back to char offsets in the raw input (sequential
 * indexOf from the span start — parts came from this span, so a miss means
 * the text shifted under us and the split must abort). Sub-spans keep the
 * "Default for '…'" pinning working per ingredient.
 */
export function groundSegments(
  rawText: string,
  spanStart: number,
  parts: string[],
  script?: ScriptTag,
): SplitSegment[] | null {
  let cursor = spanStart;
  const out: SplitSegment[] = [];
  for (const part of parts) {
    const at = rawText.indexOf(part, cursor);
    if (at === -1) return null;
    out.push({ text: part, span: [at, at + part.length], script });
    cursor = at + part.length;
  }
  return out;
}

/**
 * True when a segment identifies a library food: exact key hit, or a
 * same-concept-head row exists (head equality is order- and
 * attribute-insensitive — "eggs" reaches "Egg, whole, raw, fresh" the same
 * way the ranker's concept rule does). Linear scan, but only ever runs on
 * the rare single-qty-less-span path that already split into parts.
 */
export function segmentResolves(foods: Food[], segment: string): boolean {
  const norm = normalizeFoodName(segment);
  const stripped = segment.toLowerCase().replace(/[^a-z0-9]/g, '');
  const { concept } = splitConceptPrep(tokenizeBM25(segment));
  if (concept.length === 0) return false;
  for (const f of foods) {
    if (norm && f.normalized_name === norm) return true;
    if (stripped && f.normalized_name === stripped) return true;
    const head = headOf(f.canonical_name);
    if (head.length === concept.length && head.every((t, i) => t === concept[i])) return true;
  }
  return false;
}
