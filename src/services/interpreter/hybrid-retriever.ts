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
import { splitConceptPrep, PREP_WORDS, tokenizeBM25, headOf } from './lexicon';
import { rerankTop } from './rerank';
import { reciprocalRankFusion } from './mE5-client';
import { faissSearch, faissSearchSync, faissSearchRestricted, faissSearchSyncRestricted, invalidateFaissCache } from './faiss-bridge';

/**
 * BM25 shortlist size for the semantic channel. The hash cosine runs only
 * over these instead of all 39k rows per span (the steady-state submit
 * cost). An empty shortlist (e.g. typo queries with zero lexical hits)
 * falls back to the full hash search so typo recovery survives.
 */
export const LEX_SHORTLIST = 200;

export interface RetrievalHit {
  food: Food;
  score: number; // fused 0-1
  lexicalScore: number;
  semanticScore: number;
  method: 'exact' | 'alias' | 'hybrid';
  rank: number;
}

// In-memory BM25 fallback when SQLite FTS5 not available (web)
interface Bm25Doc { id: string; terms: Map<string, number>; len: number; head: string[] }
let bm25Index: {
  docFreq: Map<string, number>;
  docs: Bm25Doc[];
  /** Inverted postings: term -> indexes into docs. Queries score only docs
   *  containing a query term instead of scanning all 39k rows per submit. */
  postings: Map<string, number[]>;
  byId: Map<string, Food>;
  avgLen: number;
  N: number;
  totalLen: number;
} | null = null;

export function buildBm25Index(foods: Food[]): void {
  const docs: Bm25Doc[] = [];
  const docFreq = new Map<string, number>();
  const postings = new Map<string, number[]>();
  const byId = new Map<string, Food>();
  let totalLen = 0;
  for (const f of foods) {
    const text = `${f.canonical_name} ${f.normalized_name}`;
    const terms = tokenizeBM25(text);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    const idx = docs.length;
    for (const t of tf.keys()) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
      let list = postings.get(t);
      if (!list) { list = []; postings.set(t, list); }
      list.push(idx);
    }
    docs.push({ id: f.id, terms: tf, len: terms.length, head: headOf(f.canonical_name) });
    byId.set(f.id, f);
    totalLen += terms.length;
  }
  bm25Index = { docFreq, docs, postings, byId, avgLen: foods.length ? totalLen / foods.length : 1, N: foods.length, totalLen };
}

/** Average doc length, kept incrementally (see addFoodsToIndex). */
function recomputeAvg(): void {
  if (!bm25Index) return;
  bm25Index.avgLen = bm25Index.N ? bm25Index.totalLen / bm25Index.N : 1;
}

function removeDocFromIndex(idx: number): void {
  if (!bm25Index) return;
  const old = bm25Index.docs[idx];
  if (!old) return;
  for (const t of old.terms.keys()) {
    const df = (bm25Index.docFreq.get(t) || 1) - 1;
    if (df <= 0) {
      bm25Index.docFreq.delete(t);
      bm25Index.postings.delete(t);
    } else {
      bm25Index.docFreq.set(t, df);
      const list = bm25Index.postings.get(t);
      if (list) {
        const at = list.indexOf(idx);
        if (at !== -1) list.splice(at, 1);
      }
    }
  }
  bm25Index.totalLen -= old.len;
  bm25Index.N -= 1;
}

function appendDocToIndex(food: Food): void {
  if (!bm25Index) return;
  const text = `${food.canonical_name} ${food.normalized_name}`;
  const terms = tokenizeBM25(text);
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
  const idx = bm25Index.docs.length;
  for (const t of tf.keys()) {
    bm25Index.docFreq.set(t, (bm25Index.docFreq.get(t) || 0) + 1);
    let list = bm25Index.postings.get(t);
    if (!list) { list = []; bm25Index.postings.set(t, list); }
    list.push(idx);
  }
  bm25Index.docs.push({ id: food.id, terms: tf, len: terms.length, head: headOf(food.canonical_name) });
  bm25Index.byId.set(food.id, food);
  bm25Index.totalLen += terms.length;
  bm25Index.N += 1;
}

/**
 * Incrementally add or update foods in a WARM index (the base library is
 * static; growth is a row here and there). Add-or-update by id, so renames
 * replace the old posting entries instead of duplicating. Scores stay
 * bit-identical to a full rebuild (same formula over the same multiset —
 * covered by the parity test). No-op (false) when cold: caller falls back
 * to a full fetch + setFoodsForInterpreter.
 */
export function addFoodsToIndex(newFoods: Food[]): boolean {
  if (!bm25Index) return false;
  const idxById = new Map<string, number>();
  bm25Index.docs.forEach((d, i) => idxById.set(d.id, i));
  for (const food of newFoods) {
    const at = idxById.get(food.id);
    if (at !== undefined) removeDocFromIndex(at);
    // NOTE: removal shifts no indexes (docs array is append-only; removed
    // slots keep a stale entry that postings no longer reference — see below).
    appendDocToIndex(food);
    idxById.set(food.id, bm25Index.docs.length - 1);
  }
  recomputeAvg();
  return true;
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
  // Docs by id for scoring internals (head/terms live here, not on Food).
  const docById = new Map(bm25Index.docs.map(d => [d.id, d]));
  const foodById = bm25Index.byId;
  const k1 = 1.2, b = 0.75;
  const scores = new Map<string, number>();
  for (const q of qTerms) {
    const df = bm25Index.docFreq.get(q) || 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (bm25Index.N - df + 0.5) / (df + 0.5));
    // Postings: only docs containing this term can score (identical scores
    // to the old full scan, which skipped tf==0 docs anyway).
    for (const di of bm25Index.postings.get(q) || []) {
      const doc = bm25Index.docs[di];
      const tf = doc.terms.get(q) || 0;
      if (tf === 0) continue;
      const denom = tf + k1 * (1 - b + b * (doc.len / bm25Index.avgLen));
      const s = idf * (tf * (k1 + 1)) / denom;
      scores.set(doc.id, (scores.get(doc.id) || 0) + s);
    }
  }
  const hits = [...scores.entries()]
    .map(([id, score]) => {
      const doc = docById.get(id)!;
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
      return { food: foodById.get(id)!, score: boosted, rank: 0 };
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
 * Stage-2 finish: exact matches keep their rank untouched; the top-40 fused
 * rest are rescored by the fitted linear model and reordered. Pure reorder
 * of an already-fused pool — BM25/hash/RRF/exact logic above is frozen.
 */
function finishWithStage2(
  spanText: string,
  out: RetrievalHit[],
  lexHits: Array<{ food: Food; rank: number }>,
  semHits: Array<{ food: Food; rank: number }>,
  topK: number,
): RetrievalHit[] {
  const exact = out.filter(h => h.method === 'exact');
  const rest = out.filter(h => h.method !== 'exact').slice(0, 40);
  if (rest.length === 0) {
    const all = [...exact];
    all.forEach((h, i) => h.rank = i + 1);
    return all.slice(0, topK);
  }
  const lexRanks = new Map(lexHits.map(h => [h.food.id, h.rank]));
  const semRanks = new Map(semHits.map(h => [h.food.id, h.rank]));
  const order = rerankTop(
    spanText,
    rest.map(h => ({
      id: h.food.id,
      text: `${h.food.canonical_name} ${h.food.normalized_name}`,
      head: headOf(h.food.canonical_name),
      lexRank: lexRanks.get(h.food.id) ?? null,
      semRank: semRanks.get(h.food.id) ?? null,
    })),
  );
  const byId = new Map(rest.map(h => [h.food.id, h]));
  const reranked = order.map(id => byId.get(id)!).filter(Boolean);
  const final = [...exact, ...reranked];
  final.forEach((h, i) => h.rank = i + 1);
  return final.slice(0, topK);
}
export async function hybridRetrieve(
  spanText: string,
  foods: Food[],
  opts: { topK?: number; lexicalWeight?: number; semanticWeight?: number } = {}
): Promise<RetrievalHit[]> {
  const topK = opts.topK ?? 5;
  // One BM25 call serves both roles: its head (topK*2, as before) feeds the
  // fusion ranks; the wider shortlist only bounds the hash channel's work.
  // Slicing — not re-querying — keeps fusion-set membership identical to the
  // pre-shortlist behavior (a penalized row stays out of the lex side).
  const pool = bm25Search(spanText, foods, LEX_SHORTLIST);
  const lexHits = pool.slice(0, topK * 2);
  const shortlist = new Set(pool.map(h => h.food.id));
  const semHits = shortlist.size > 0
    ? await faissSearchRestricted(spanText, foods, shortlist, topK * 2)
    : await faissSearch(spanText, foods, topK * 2);

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
  return finishWithStage2(spanText, out, lexHits, semHits, topK);
}

export function hybridRetrieveSync(spanText: string, foods: Food[], topK = 5): RetrievalHit[] {
  const pool = bm25Search(spanText, foods, LEX_SHORTLIST);
  const lexHits = pool.slice(0, topK * 2);
  const shortlist = new Set(pool.map(h => h.food.id));
  const semHits = shortlist.size > 0
    ? faissSearchSyncRestricted(spanText, foods, shortlist, topK * 2)
    : faissSearchSync(spanText, foods, topK * 2);
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
  return finishWithStage2(spanText, out, lexHits, semHits, topK);
}
