/**
 * Hybrid retriever — exact alias -> BM25 (TF-IDF) -> mE5 semantic -> RRF fusion -> canonical.
 *
 * Locked order per spec §9.2: exact canonical -> exact alias -> lexical (fuzzy LIKE historically) -> semantic (mE5) -> fusion.
 * Now lexical upgrades from LIKE to BM25 FTS5, semantic uses L12 NER spans via faiss-bridge FP16.
 *
 * BM25 built from foods.normalized_name + canonical_name (diacritics stripped NFKC) for lexical recall.
 * Exact before semantic where lexical outperforms E5 on verbatim matches (your eval).
 */

import { Food } from '@data/types';
import { normalizeFoodName } from '@domain/logging';
import { splitConceptPrep, PREP_WORDS } from './lexicon';
import { reciprocalRankFusion } from './mE5-client';
import { faissSearch, faissSearchSync, invalidateFaissCache } from './faiss-bridge';

export interface RetrievalHit {
  food: Food;
  score: number; // fused 0-1
  lexicalScore: number;
  semanticScore: number;
  method: 'exact' | 'alias' | 'hybrid';
  rank: number;
}

// In-memory BM25 fallback when SQLite FTS5 not available (web)
let bm25Index: { docFreq: Map<string, number>; docs: Array<{ id: string; terms: Map<string, number>; len: number; head: string[] }>; avgLen: number; N: number } | null = null;

/** Light singularization so plurals reach singular rows and vice versa
 *  ("apples" → "apple"). Applied identically to queries and docs, so it
 *  can only merge variants, never split them. Non-Latin tokens are
 *  unaffected (they never end in U+0073). */
function singularBM25(tok: string): string {
  if (tok.length > 4 && tok.endsWith('ies')) return tok.slice(0, -3) + 'y';
  if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss')) return tok.slice(0, -1);
  return tok;
}

function tokenizeBM25(text: string): string[] {
  // Keep-set must mirror the eval sim (eval_retrieval_colab.py) or local
  // numbers stop meaning anything. CJK Unified Ideographs included:
  // without them Chinese queries AND Chinese alias rows strip to empty and
  // can never match lexically, no matter how many aliases get seeded.
  return text.toLowerCase().normalize('NFKC')
    .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/).filter(Boolean).map(singularBM25);
}

/** Concept head of a canonical name: pre-comma tokens (USDA convention —
 *  "Chicken, breast, ..." is chicken; "Almond Chicken" is a dish). */
function headOf(canonicalName: string): string[] {
  return tokenizeBM25(canonicalName.split(',')[0]);
}

export function buildBm25Index(foods: Food[]): void {
  const docs: Array<{ id: string; terms: Map<string, number>; len: number; head: string[] }> = [];
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const f of foods) {
    const text = `${f.canonical_name} ${f.normalized_name}`;
    const terms = tokenizeBM25(text);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    docs.push({ id: f.id, terms: tf, len: terms.length, head: headOf(f.canonical_name) });
    totalLen += terms.length;
  }
  bm25Index = { docFreq, docs, avgLen: foods.length ? totalLen / foods.length : 1, N: foods.length };
}

export function bm25Search(query: string, foods: Food[], topK = 8): Array<{ food: Food; score: number; rank: number }> {
  if (!bm25Index) buildBm25Index(foods);
  const qTerms = tokenizeBM25(query);
  if (qTerms.length === 0 || !bm25Index) return [];
  // Concept-head rule (validated probe 3): a generic query denotes the
  // CONCEPT carried by the candidate's head segment. Head equality doubles
  // the score; when the query names a preparation, candidates carrying all
  // of them get a further 1.5x ("boiled chicken" → boiled-headed chicken,
  // never "Chicken egg boiled").
  const { concept, prep } = splitConceptPrep(qTerms);
  const byId = new Map(bm25Index.docs.map(d => [d.id, d]));
  const k1 = 1.2, b = 0.75;
  const scores = new Map<string, number>();
  for (const q of qTerms) {
    const df = bm25Index.docFreq.get(q) || 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (bm25Index.N - df + 0.5) / (df + 0.5));
    for (const doc of bm25Index.docs) {
      const tf = doc.terms.get(q) || 0;
      if (tf === 0) continue;
      const denom = tf + k1 * (1 - b + b * (doc.len / bm25Index.avgLen));
      const s = idf * (tf * (k1 + 1)) / denom;
      scores.set(doc.id, (scores.get(doc.id) || 0) + s);
    }
  }
  const hits = [...scores.entries()]
    .map(([id, score]) => {
      const doc = byId.get(id)!;
      let boosted = score;
      if (concept.length > 0 && doc.head.length === concept.length && doc.head.every((t, i) => t === concept[i])) {
        boosted *= 2;
      }
      if (prep.length > 0 && prep.every(p => doc.terms.has(p))) boosted *= 1.5;
      // Unrequested preservation/state words change nutrition substantially
      // ("Apple, dried" is 10x the kcal of raw). When the query names no
      // preparation, candidates carrying one are demoted — never boosted away
      // entirely, just stopped from outranking the plain row on brevity.
      if (prep.length === 0) {
        const docPrep = [...doc.terms.keys()].filter(t => PREP_WORDS.has(t));
        if (docPrep.length > 0) boosted *= 0.6;
      }
      return { food: foods.find(f => f.id === id)!, score: boosted, rank: 0 };
    })
    .filter(h => h.food)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  hits.forEach((h, i) => h.rank = i + 1);
  // Normalize 0-1 by max
  const max = hits[0]?.score || 1;
  return hits.map(h => ({ ...h, score: max ? h.score / max : 0 }));
}

export function invalidateBm25Cache(): void {
  bm25Index = null;
  invalidateFaissCache();
}

/**
 * Main hybrid retrieval for one food span.
 * 1) exact alias/name already handled by caller (FoodService) — here we do BM25 + semantic fallback
 * 2) If BM25 top score >0.9, lexical wins alone; else fuse
 */
export async function hybridRetrieve(
  spanText: string,
  foods: Food[],
  opts: { topK?: number; lexicalWeight?: number; semanticWeight?: number } = {}
): Promise<RetrievalHit[]> {
  const topK = opts.topK ?? 5;
  const lexHits = bm25Search(spanText, foods, topK * 2);
  const semHits = await faissSearch(spanText, foods, topK * 2);

  // Build rank maps for RRF
  const lexRanks = new Map(lexHits.map(h => [h.food.id, h.rank]));
  const semRanks = new Map(semHits.map(h => [h.food.id, h.rank]));
  const fused = reciprocalRankFusion(lexRanks, semRanks, 60);

  // Merge scores 0.5/0.5, but lexicalScore/semanticScore retained for thresholding
  const lexBy = new Map(lexHits.map(h => [h.food.id, h.score]));
  const semBy = new Map(semHits.map(h => [h.food.id, h.score]));

  const out: RetrievalHit[] = [];
  for (const [id, fScore] of fused.entries()) {
    const food = foods.find(f => f.id === id)!;
    if (!food) continue;
    const l = lexBy.get(id) ?? 0;
    const s = semBy.get(id) ?? 0;
    // Exact match boost: if normalized equals span normalized, force hybrid rank 1
    const normSpan = normalizeFoodName(spanText);
    const isExact = food.normalized_name === normSpan;
    const finalScore = isExact ? 1 : fScore;
    out.push({
      food,
      score: finalScore,
      lexicalScore: l,
      semanticScore: s,
      method: isExact ? 'exact' : 'hybrid',
      rank: 0,
    });
  }
  out.sort((a, b) => b.score - a.score);
  out.forEach((h, i) => h.rank = i + 1);
  return out.slice(0, topK);
}

export function hybridRetrieveSync(spanText: string, foods: Food[], topK = 5): RetrievalHit[] {
  const lexHits = bm25Search(spanText, foods, topK * 2);
  const semHits = faissSearchSync(spanText, foods, topK * 2);
  const lexRanks = new Map(lexHits.map(h => [h.food.id, h.rank]));
  const semRanks = new Map(semHits.map(h => [h.food.id, h.rank]));
  const fused = reciprocalRankFusion(lexRanks, semRanks, 60);
  const lexBy = new Map(lexHits.map(h => [h.food.id, h.score]));
  const semBy = new Map(semHits.map(h => [h.food.id, h.score]));
  const out: RetrievalHit[] = [];
  for (const [id, fScore] of fused.entries()) {
    const food = foods.find(f => f.id === id)!;
    if (!food) continue;
    const l = lexBy.get(id) ?? 0;
    const s = semBy.get(id) ?? 0;
    const normSpan = normalizeFoodName(spanText);
    const isExact = food.normalized_name === normSpan;
    out.push({
      food,
      score: isExact ? 1 : fScore,
      lexicalScore: l,
      semanticScore: s,
      method: isExact ? 'exact' : 'hybrid',
      rank: 0,
    });
  }
  out.sort((a, b) => b.score - a.score);
  out.forEach((h, i) => h.rank = i + 1);
  return out.slice(0, topK);
}
