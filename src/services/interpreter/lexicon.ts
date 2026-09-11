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

/**
 * Light singularization so plurals reach singular rows and vice versa
 * ("apples" → "apple"). Applied identically to queries and docs, so it
 * can only merge variants, never split them. Non-Latin tokens are
 * unaffected (they never end in U+0073).
 */
export function singularBM25(tok: string): string {
  if (tok.length > 4 && tok.endsWith('ies')) return tok.slice(0, -3) + 'y';
  if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss')) return tok.slice(0, -1);
  return tok;
}

/**
 * BM25 tokenizer (single home — hybrid-retriever, rerank, and the eval sims
 * in `ai models/eval/` must all mirror this keep-set and the singular step,
 * or local numbers stop meaning anything). CJK Unified Ideographs included:
 * without them Chinese queries AND Chinese alias rows strip to empty and
 * can never match lexically, no matter how many aliases get seeded.
 */
export function tokenizeBM25(text: string): string[] {
  return text.toLowerCase().normalize('NFKC')
    .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/).filter(Boolean).map(singularBM25);
}

/**
 * Concept head of a canonical name: pre-comma tokens (USDA convention —
 * "Chicken, breast, ..." is chicken; "Almond Chicken" is a dish).
 */
export function headOf(canonicalName: string): string[] {
  return tokenizeBM25(canonicalName.split(',')[0]);
}

/**
 * Display convention for library names (unit-tested; render sites use the
 * returned string, storage keeps the raw canonical). Reference rows shout
 * ("CHICKEN", "RICE, WHITE"); users should read sentence case. Only
 * unambiguous casings are touched — all-caps becomes sentence case,
 * all-lower gets a capital; mixed case (brands, USDA title case) is left
 * exactly alone so nothing readable can regress.
 */
export function displayFoodName(name: string | null | undefined): string {
  if (!name) return '';
  if (/[a-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4e00-\u9fff]/.test(name)) {
    // Has lowercase/non-Latin-cased content: mixed or all-lower.
    if (name === name.toLowerCase()) return name.charAt(0).toUpperCase() + name.slice(1);
    return name;
  }
  const lower = name.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * UI alias for a canonical name: USDA "Head, attr, ..." becomes a natural
 * phrase ("Chicken, breast, boiled, sliced" → "Boiled Sliced Chicken
 * Breast"; "RICE, WHITE" → "White Rice"). Preparation words move before
 * the head phrase; a lone variety adjective fronts it; everything else
 * keeps its relative order. Single-segment names just get display casing.
 * Pure and total: never throws, never returns empty for non-empty input.
 */
/**
 * Variety adjectives that read naturally BEFORE the head ("white rice",
 * not "rice white"). Applies only to two-segment names with a single-word
 * attribute, so cuts ("Chicken, breast" → "Chicken Breast") and longer
 * USDA rows ("Grains, rice, white, glutinous, cooked") keep existing order.
 */
const VARIETY_ADJECTIVES: ReadonlySet<string> = new Set([
  'white', 'brown', 'black', 'red', 'green', 'yellow', 'wild',
]);

/** Small words stay lowercase past the lead (title-case convention). */
const SMALL_WORDS: ReadonlySet<string> = new Set(
  ['a', 'an', 'the', 'and', 'or', 'of', 'with', 'for', 'to', 'in', 'on', 'at', 'by', 'vs'],
);

/**
 * Title-case a composed phrase (ours — safe to shape). ALL-CAPS tokens
 * lower first; mixed-case words (brands) are never lowered.
 */
function titleCase(words: string[]): string {
  return words
    .map(w => (/[A-Z]/.test(w) && w === w.toUpperCase() ? w.toLowerCase() : w))
    .map((w, i) => {
      const low = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(low)) return low;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function friendlyFoodName(canonical: string | null | undefined): string {
  if (!canonical || !canonical.trim()) return '';
  const segments = canonical.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length < 2) return displayFoodName(canonical.trim());
  const head = segments[0].split(/\s+/).filter(Boolean);
  // "Rice, white" reads as "White Rice": a lone variety adjective fronts the
  // head. Cuts and longer rows keep head-first order ("Chicken Breast").
  if (segments.length === 2) {
    const attr = segments[1].split(/\s+/).filter(Boolean);
    if (attr.length === 1 && VARIETY_ADJECTIVES.has(attr[0].toLowerCase())) {
      return titleCase([...attr, ...head]);
    }
  }
  // USDA bookkeeping tokens ("NFS" = not further specified) carry no meaning
  // for users and never survive into the alias.
  const attrs = segments.slice(1).join(' ').split(/\s+/).filter(Boolean)
    .filter(w => !/^(nfs|ns)$/i.test(w));
  const prep: string[] = [];
  const variety: string[] = [];
  const rest: string[] = [];
  for (const w of attrs) {
    const low = w.toLowerCase();
    if (PREP_WORDS.has(low)) prep.push(w);
    else if (VARIETY_ADJECTIVES.has(low)) variety.push(w);
    else rest.push(w);
  }
  return titleCase([...prep, ...variety, ...head, ...rest]);
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
