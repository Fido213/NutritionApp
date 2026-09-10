/**
 * Phase 1 lexicon access — single-source wrappers over `data/*.json`.
 *
 * - Vague portion markers (Tier 1+3 static matrix) → gram/ml estimates.
 * - Negation markers → pre-retrieval span filtering.
 *
 * Matching uses Unicode-aware boundary lookarounds so short markers never
 * fire inside longer words (`no` ≠ `noodles`, `sem` ≠ `semolina`, `some` ≠
 * `handsome`). Latin matching is case-insensitive; Arabic-script matching
 * uses the same path (no case to fold, whitespace-delimited).
 */
import vagueUnits from './data/vague_units.json';
import negationPatterns from './data/negation_patterns.json';
import prepMethods from './data/prep_methods.json';

export interface VagueMatch {
  id: string;
  amountG: number | null;
  amountMl: number | null;
  matched: string;
}

interface FlatPattern {
  re: RegExp;
  id: string;
  amountG: number | null;
  amountMl: number | null;
  matched: string;
}

function toBoundaryRe(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'iu');
}

interface VagueMarker {
  id: string;
  grams?: number | null;
  ml?: number | null;
  patterns: Record<string, string[]>;
}

const VAGUE: FlatPattern[] = (
  (vagueUnits as { markers: VagueMarker[] }).markers.flatMap((m) =>
    Object.values(m.patterns)
      .flat()
      .map((p) => ({
        re: toBoundaryRe(p),
        id: m.id,
        amountG: m.grams ?? null,
        amountMl: m.ml ?? null,
        matched: p,
      })),
  )
).sort((a, b) => b.matched.length - a.matched.length);

const NEGATION_RES: RegExp[] = (
  negationPatterns as { markers: Array<{ lang: string; patterns: string[] }> }
).markers
  .flatMap((m) => m.patterns)
  // Trim: boundary lookarounds subsume trailing spaces ("no " would otherwise
  // require a non-letter AFTER the space and never match "no sauce").
  .map((p) => toBoundaryRe(p.trim()));

/**
 * Preparation/state words for concept-head retrieval (single-source from
 * `data/prep_methods.json`). A generic query denotes a CONCEPT carried by
 * the candidate's head segment; a shared prep word confirms the variant
 * ("boiled chicken" → boiled-headed chicken rows, not "Chicken egg boiled").
 */
export const PREP_WORDS: ReadonlySet<string> = new Set(
  (prepMethods as { methods: string[] }).methods.map((m) => m.toLowerCase()),
);

/** Split query tokens into concept (dish identity) vs prep/state words. */
export function splitConceptPrep(tokens: string[]): { concept: string[]; prep: string[] } {
  const concept: string[] = [];
  const prep: string[] = [];
  for (const t of tokens) {
    if (PREP_WORDS.has(t)) prep.push(t);
    else concept.push(t);
  }
  return { concept, prep };
}
/** Single-token negation words for span truncation / leading-strip in NER. */
const NEGATION_TOKENS: ReadonlySet<string> = new Set(
  (
    negationPatterns as { markers: Array<{ lang: string; patterns: string[] }> }
  ).markers
    .flatMap((m) => m.patterns)
    .filter((p) => !p.includes(' '))
    .map((p) => p.toLowerCase().normalize('NFKC').trim()),
);

/**
 * Find the first vague portion marker in a text window (e.g. the ±40 chars
 * around a food span). Longest-pattern-first so "a side of" wins over "side".
 * Returns null when nothing matches OR when the marker carries no safe
 * estimate (grams:null → caller takes the flagged-default path).
 */
export function resolveVagueMarker(windowText: string): VagueMatch | null {
  if (!windowText) return null;
  const text = windowText.normalize('NFKC');
  for (const entry of VAGUE) {
    if (entry.re.test(text)) {
      if (entry.amountG === null && entry.amountMl === null) return null;
      return {
        id: entry.id,
        amountG: entry.amountG,
        amountMl: entry.amountMl,
        matched: entry.matched,
      };
    }
  }
  return null;
}

/** True if a whole token is a negation word (`without`, `sans`, `بدون`, …). */
export function isNegationToken(word: string): boolean {
  if (!word) return false;
  return NEGATION_TOKENS.has(word.toLowerCase().normalize('NFKC').trim());
}

/**
 * True if a negation marker governs the position where a food span starts —
 * i.e. a marker occurs in the `lookbehind` chars immediately before it.
 * Belt-and-braces behind NER truncation; catches multi-word markers
 * (`hold the fries`) that token truncation cannot see.
 */
export function governedByNegation(
  fullText: string,
  spanStart: number,
  lookbehind = 20,
): boolean {
  if (spanStart <= 0) return false;
  const window = fullText
    .slice(Math.max(0, spanStart - lookbehind), spanStart)
    .normalize('NFKC');
  return NEGATION_RES.some((re) => re.test(window));
}
