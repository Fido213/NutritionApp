/**
 * Script-based language routing (Phase 2 pre-step, deterministic slice).
 *
 * Decides the *script family* of a text span so later stages can dispatch
 * (lexicon bucket, tokenizer/model choice, per-script accuracy). Unicode
 * blocks separate AR/ZH/RU-vs-Latin with zero cost — the same class logic
 * as the CJK tokenizer fix. Digits, units and punctuation are script-neutral
 * and ignored, so "250g" never outvotes real words.
 *
 * Deliberately NOT a gate: mixed-script input ("250g دجاج grille") keeps
 * full cross-lexicon matching. The `script` hint travels on spans/results
 * for future dispatch; nothing today narrows matching by it. Statistical
 * Latin disambiguation (fastText ftz / franc) is deferred — flat lexicons
 * don't need it yet and there is no on-device runtime for it in the bundle.
 * See HANDOVER.md.
 */
export type ScriptTag = 'latin' | 'arabic' | 'cjk' | 'cyrillic' | 'mixed' | 'neutral';

const LATIN_RE = /[\u0041-\u005a\u0061-\u007a\u00c0-\u024f]/u;
const ARABIC_RE = /[\u0600-\u06ff]/u;
const CJK_RE = /[\u4e00-\u9fff]/u;
const CYRILLIC_RE = /[\u0400-\u04ff]/u;

/** Majority script of the letters in `text`, or mixed/neutral. Threshold 0.7. */
export function detectScript(text: string): ScriptTag {
  if (!text) return 'neutral';
  let latin = 0;
  let arabic = 0;
  let cjk = 0;
  let cyrillic = 0;
  for (const ch of text) {
    if (LATIN_RE.test(ch)) latin++;
    else if (ARABIC_RE.test(ch)) arabic++;
    else if (CJK_RE.test(ch)) cjk++;
    else if (CYRILLIC_RE.test(ch)) cyrillic++;
  }
  const total = latin + arabic + cjk + cyrillic;
  if (total === 0) return 'neutral';
  const top = Math.max(latin, arabic, cjk, cyrillic);
  if (top / total < 0.7) return 'mixed';
  if (top === latin) return 'latin';
  if (top === arabic) return 'arabic';
  if (top === cjk) return 'cjk';
  return 'cyrillic';
}
