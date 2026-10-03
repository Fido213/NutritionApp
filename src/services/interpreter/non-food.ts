/**
 * Narrow non-food detector for span text (measured, not guessed).
 *
 * Measured on the real user's own log (`ai models/results/prose_span_report*.json`,
 * production seed + production interpreter over 437 typed messages, 685 spans):
 * span EXTRACTION is fine — 91.7 % of spans are lexically anchored in the
 * library — but 10 messages / 24 spans of non-food text reach the retrieval
 * pipeline and, having no library match, would be upserted as foods:
 *
 *   "Speed 3, incline 2, time 30 minutes, treadmill" -> Cereals, CREAM OF WHEAT
 *   "I'm 68 kg"                                      -> adopted as a row name
 *   "3 speed 5 incline 20 minutes treadmill"         -> Hemp seed / Marsala wine
 *   "Try to approximate the calories to a degree"    -> an industrial fat row
 *
 * Those rows are permanent (they appear in Index, exports and future
 * retrieval), so the guard exists to stop them at the source.
 *
 * Deliberately narrow and used ONLY for spans the library cannot explain at
 * all (no accepted retrieval winner): a real food is never dropped, because a
 * food the library knows about never reaches this check. Every pattern here
 * has a receipt in the report above; OOV food words the probe surfaced
 * ("war2a 3enab", "cooked air fried steakhouse", "sheesh tawook") deliberately
 * do NOT match — those are foods the corpus lacks, which alias/estimate work
 * is supposed to handle, not discard.
 */

const ANTHRO = /\d+(?:[.,]\d+)?\s*(?:kg|kgs|kilo|kilos|lb|lbs|pound|pounds|cm|centimet\w*)/gi;
const TELEMETRY = /\b(?:treadmill|incline|speed|steps|workout|bpm|km\/h|minutes?)\b/i;
const INSTRUCTION = /^(?:try|estimate|approximate|approx|calc|calculate|log|add|count)\b/i;
const BARE_NON_FOOD: ReadonlySet<string> = new Set([
  'test', 'hi', 'hello', 'hey', 'thanks', 'thank', 'ok', 'okay', 'speed',
  'incline', 'took', 'them', 'this', 'that', 'it', 'dih',
]);

/**
 * Body measurements ONLY: "I'm 68 kg", "173 cm", "68 kg 173 cm height".
 * Deliberately span-level — "1 kg chicken" and "2 lb beef" are food, so a
 * measurement with any other word left over must not count.
 */
function isAnthropometricOnly(text: string): boolean {
  const hits = text.match(ANTHRO);
  if (!hits || hits.length === 0) return false;
  const residue = text.toLowerCase()
    .replace(/\b(?:i'?m|im|i|am|my|height|weight|and)\b/g, ' ')
    .replace(ANTHRO, ' ')
    .replace(/[\s,.;:/\-+()]+/g, '');
  return residue.length === 0;
}

/**
 * True when the text is plainly not a food. Used BEFORE retrieval, so it must
 * stay high-precision: every pattern here is either a span-level body
 * measurement, an instruction verb, or a pronoun/telemetry word that cannot
 * start a food name the library cares about.
 */
export function looksNonFood(spanText: string): boolean {
  const text = (spanText || '').trim();
  if (!text) return true;
  if (isAnthropometricOnly(text)) return true;
  if (INSTRUCTION.test(text)) return true;
  const words = text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 1 && BARE_NON_FOOD.has(words[0])) return true;
  return false;
}

/**
 * The wider check, for spans the library could NOT explain at all: adds
 * exercise telemetry, which is excluded from the pre-retrieval set because a
 * real product can carry those words ("Minute Maid" vs `minutes?`). Nothing is
 * lost by waiting: an unexplained span has no row to protect.
 */
export function looksNonFoodWhenUnexplained(spanText: string): boolean {
  if (looksNonFood(spanText)) return true;
  return TELEMETRY.test((spanText || '').trim());
}
