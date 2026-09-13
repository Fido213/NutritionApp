/**
 * Stage-2 rerank: a small linear model over the top-40 fused pool.
 *
 * Stage-1 (BM25-postings + hash-200 + RRF) is recall-oriented; stage-2 spends
 * a few microseconds per candidate on features that are too fine-grained for
 * index time: concept-head equality, prep recall, token coverage and order,
 * both RRF channels, and the unrequested-prep penalty. Exact matches never
 * reach this module (score-1 shortcut upstream).
 *
 * Weights are pasted constants from the offline fitter
 * (`ai models/eval/fit_rerank.py`, provenance below) — static bundle, no
 * runtime loading. Deterministic and total: same inputs, same order.
 */
import { splitConceptPrep, PREP_WORDS, tokenizeBM25 } from './lexicon';

export interface RerankWeights {
  headExact: number;
  prepRecall: number;
  coverage: number;
  orderKept: number;
  lexRR: number;
  semRR: number;
  extraPrep: number;
  /**
   * Personal prior: RESERVED for the offline fitter, always 0 in the app.
   * History (2026-09-13, device-verified): 0.01 here flipped real rankings —
   * RRF rank-compression collapses BM25 score gaps to ~0.0005, so a "tiny"
   * additive prior overruled lexical evidence ("Shawarma chicken" lost to
   * generic Chicken off 4 personal logs). The prior now applies ONLY as a
   * post-score tiebreak in rerankTop (your foods win exact ties, nothing
   * else moves). The fitter may re-tune this weight with evidence; the app
   * ignores it until then.
   */
  priorCount: number;
}

/**
 * Provenance: STARTER weights (lexRR=semRR=1 reproduce stage-1 RRF order
 * exactly). The offline fitter (`ai models/eval/fit_rerank.py`, EN-91) found
 * no constrained improvement over starter (58.2% → 58.2%, must-pass held) —
 * see fit_rerank_report.json — so starter ships. The small coverage/order
 * nudges from a mismatched-slice fit run were reverted, not shipped. Refit
 * when the eval grows; never hand-tune these numbers without rerunning
 * the gate.
 *
 * priorCount is 0 here by device-verified necessity (see field doc):
 * personalization lives in the rerankTop tiebreak below, not the score.
 */
export const RERANK_WEIGHTS: RerankWeights = {
  headExact: 0,
  prepRecall: 0,
  coverage: 0,
  orderKept: 0,
  lexRR: 1,
  semRR: 1,
  extraPrep: 0,
  priorCount: 0,
};

export interface RerankCandidate {
  id: string;
  /** Full token sequence (ordered, stemmed) for coverage/order features. */
  toks: string[];
  /** Concept head segment for the equality feature. */
  head: string[];
  lexRank: number | null;
  semRank: number | null;
  /** Times the user logged this food (personal prior, 0 = unknown). */
  logCount?: number | null;
}

/** Feature vector [headExact, prepRecall, coverage, orderKept, lexRR, semRR, extraPrep, priorCount]. */
export function rerankFeatures(
  qToks: string[],
  concept: string[],
  prep: string[],
  cand: RerankCandidate,
): [number, number, number, number, number, number, number, number] {
  const tset = new Set(cand.toks);
  const headExact =
    concept.length > 0 &&
    cand.head.length === concept.length &&
    cand.head.every((t, i) => t === concept[i])
      ? 1
      : 0;
  const prepRecall =
    prep.length > 0 ? prep.filter(p => tset.has(p)).length / prep.length : 0;
  const coverage =
    qToks.length > 0 ? qToks.filter(t => tset.has(t)).length / qToks.length : 0;
  const firstPos = new Map<string, number>();
  cand.toks.forEach((t, i) => {
    if (!firstPos.has(t)) firstPos.set(t, i);
  });
  let prev = -1;
  let ordered = 0;
  for (const t of qToks) {
    const p = firstPos.get(t);
    if (p !== undefined && p > prev) {
      prev = p;
      ordered++;
    }
  }
  const orderKept = qToks.length > 0 ? ordered / qToks.length : 0;
  const lexRR = cand.lexRank != null ? 1 / (60 + cand.lexRank) : 0;
  const semRR = cand.semRank != null ? 1 / (60 + cand.semRank) : 0;
  const extraPrep =
    prep.length === 0 && [...tset].some(t => PREP_WORDS.has(t) && !prep.includes(t)) ? 1 : 0;
  const logged = cand.logCount ?? 0;
  const priorCount = logged > 0 ? logged / (logged + 5) : 0;
  return [headExact, prepRecall, coverage, orderKept, lexRR, semRR, extraPrep, priorCount];
}

export function rerankScore(
  features: [number, number, number, number, number, number, number, number],
  weights: RerankWeights = RERANK_WEIGHTS,
): number {
  const w = [weights.headExact, weights.prepRecall, weights.coverage, weights.orderKept, weights.lexRR, weights.semRR, weights.extraPrep, weights.priorCount];
  return features.reduce((sum, f, i) => sum + f * w[i], 0);
}

export interface Stage2Item {
  id: string;
  /** Canonical + normalized text (tokenized inside, once per item). */
  text: string;
  head: string[];
  lexRank: number | null;
  semRank: number | null;
  /** Times the user logged this food (personal prior, default 0). */
  logCount?: number | null;
}

/**
 * Rerank up to ~40 fused candidates. Returns ids ordered best-first.
 * Ordering: score desc, then personal log-count desc (YOUR foods win exact
 * ties — the only influence history has), then input order (stable).
 * With starter weights and zero counts this reproduces stage-1 order
 * exactly; with counts it can never overturn a score gap of any size.
 */
export function rerankTop(
  query: string,
  items: Stage2Item[],
  weights: RerankWeights = RERANK_WEIGHTS,
): string[] {
  const qToks = tokenizeBM25(query);
  const { concept, prep } = splitConceptPrep(qToks);
  return items
    .map((item, index) => {
      const toks = tokenizeBM25(item.text);
      const logCount = item.logCount ?? 0;
      const score = rerankScore(
        rerankFeatures(qToks, concept, prep, {
          id: item.id,
          toks,
          head: item.head,
          lexRank: item.lexRank,
          semRank: item.semRank,
          logCount,
        }),
        weights,
      );
      return { id: item.id, score, logCount, index };
    })
    .sort((a, b) => b.score - a.score || b.logCount - a.logCount || a.index - b.index)
    .map(h => h.id);
}
