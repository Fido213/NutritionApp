/**
 * FAISS FP16 bridge — 44,536 x384 index (35MB FP16, 18MB PQ fallback).
 * "ai models/faiss_fp16.index" -> dist/assets/ via scripts/copy-models.mjs
 *
 * When index not present (dev), falls back to in-memory cosine over cached food embeddings
 * built from food_repo at first launch (deterministic, offline, <300MB).
 */

import { cosineSimilarity, embedTextSync } from './mE5-client';
import type { Food } from '@data/types';

export interface FaissHit {
  food: Food;
  score: number; // cosine 0-1
  rank: number;
}

let faissAvailable: boolean | null = null;
let faissIndex: any | null = null;
let cachedFoods: Food[] | null = null;
let cachedEmbeds: Map<string, Float32Array> | null = null;

async function tryLoadFaiss(): Promise<boolean> {
  if (faissAvailable !== null) return faissAvailable;
  const candidates = [
    '/assets/faiss_fp16.index',
    'assets/faiss_fp16.index',
    './assets/faiss_fp16.index',
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        console.info('[FAISS] Index found at', url, '(fallback in-mem until native bridge wired)');
        faissAvailable = true;
        return true;
      }
    } catch {}
  }
  faissAvailable = false;
  return false;
}

function ensureCache(foods: Food[]) {
  if (cachedFoods === foods && cachedEmbeds) return;
  cachedFoods = foods;
  cachedEmbeds = new Map();
  for (const f of foods) {
    // Cache hash embeddings for fallback (until real mE5 FP16 index)
    const key = `${f.canonical_name} ${f.normalized_name}`;
    cachedEmbeds.set(f.id, embedTextSync(key, 384).values);
  }
}

/**
 * Incrementally embed added/updated foods into a WARM cache (companion to
 * addFoodsToIndex). Updates overwrite by id. No-op (false) when cold —
 * caller falls back to ensureCache via the normal search path.
 */
export function cacheFoodEmbeddings(newFoods: Food[]): boolean {
  if (!cachedEmbeds) return false;
  for (const f of newFoods) {
    const key = `${f.canonical_name} ${f.normalized_name}`;
    cachedEmbeds.set(f.id, embedTextSync(key, 384).values);
  }
  return true;
}

/**
 * Search for nearest foods by semantic embedding.
 * When FAISS native index present, delegates to it; otherwise brute-force cosine over cached foods.
 */
export async function faissSearch(
  queryText: string,
  foods: Food[],
  topK = 8
): Promise<FaissHit[]> {
  if (!queryText || foods.length === 0) return [];
  const useFaiss = await tryLoadFaiss();
  if (useFaiss && faissIndex) {
    // Native path: await faissIndex.search(embedQuery, topK)
    // Placeholder — falls through to brute-force until native bridge added
  }

  // Fallback: brute-force hash cosine (offline, deterministic, <30ms for 44k)
  ensureCache(foods);
  return rankFoods(queryText, foods, topK);
}

/**
 * Candidate-restricted variant: cosine only over the given ids (the BM25
 * shortlist). Same scoring as faissSearch, a fraction of the work — the
 * 39k-wide brute force per span was the steady-state submit cost.
 * Callers fall back to full faissSearch when the BM25 shortlist is empty
 * (e.g. typo queries with zero lexical hits — the hash channel alone
 * still recovers those).
 */
export async function faissSearchRestricted(
  queryText: string,
  foods: Food[],
  ids: Set<string>,
  topK = 8
): Promise<FaissHit[]> {
  if (!queryText || foods.length === 0 || ids.size === 0) return [];
  await tryLoadFaiss();
  ensureCache(foods);
  return rankFoods(queryText, foods.filter(f => ids.has(f.id)), topK);
}

function rankFoods(queryText: string, candidates: Food[], topK: number): FaissHit[] {
  const q = embedTextSync(queryText, 384).values;
  const hits: FaissHit[] = [];
  for (const f of candidates) {
    const emb = cachedEmbeds!.get(f.id);
    if (!emb) continue;
    const score = cosineSimilarity(q, emb);
    hits.push({ food: f, score, rank: 0 });
  }
  hits.sort((a, b) => b.score - a.score);
  // Assign ranks
  hits.forEach((h, i) => h.rank = i + 1);
  return hits.slice(0, topK);
}

export function faissSearchSync(queryText: string, foods: Food[], topK = 8): FaissHit[] {
  if (!queryText || foods.length === 0) return [];
  ensureCache(foods);
  return rankFoods(queryText, foods, topK);
}

export function faissSearchSyncRestricted(queryText: string, foods: Food[], ids: Set<string>, topK = 8): FaissHit[] {
  if (!queryText || foods.length === 0 || ids.size === 0) return [];
  ensureCache(foods);
  return rankFoods(queryText, foods.filter(f => ids.has(f.id)), topK);
}

/** Invalidate cache when foods change (e.g., after DB restore). */
export function invalidateFaissCache(): void {
  cachedFoods = null;
  cachedEmbeds = null;
  faissAvailable = null;
}
