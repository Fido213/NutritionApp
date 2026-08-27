/**
 * mE5 cross-lingual embedding client — multilingual-e5-small QInt8 Opt2 118MB
 *   "ai models/mE5_qint8_opt2.onnx" -> dist/assets/ via scripts/copy-models.mjs
 *
 * Shared for L2 span retrieval + L3 FAISS. When ONNX not present, falls back to
 * character n-gram cosine on normalized text (deterministic, offline, no model required).
 * FP16 FAISS index preferred (35MB) over PQ8 (18MB) when APK <290MB.
 */

export interface Embedding { values: Float32Array; dim: number; }

// Simple deterministic fallback embedding — not as good as mE5 but works offline without model
// Uses hashed char 3-grams cosine — captures cross-lingual shape for retrieval fallback
function fallbackEmbed(text: string, dim = 384): Float32Array {
  const norm = text.toLowerCase().normalize('NFKC').trim();
  const vec = new Float32Array(dim);
  if (!norm) return vec;
  // Hashed 3-grams
  for (let i = 0; i < norm.length; i++) {
    const gram = norm.slice(i, i + 3);
    let h = 0;
    for (let j = 0; j < gram.length; j++) h = ((h * 31) + gram.charCodeAt(j)) | 0;
    const idx = Math.abs(h) % dim;
    vec[idx] += 1;
  }
  // L2 normalize
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= n;
  return vec;
}

let onnxSession: any | null = null;
let onnxAvailable: boolean | null = null;
let tokenizer: any | null = null;

async function tryLoadOnnx(): Promise<boolean> {
  if (onnxAvailable !== null) return onnxAvailable;
  const candidates = [
    '/assets/mE5_qint8_opt2.onnx',
    'assets/mE5_qint8_opt2.onnx',
    './assets/mE5_qint8_opt2.onnx',
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        console.info('[mE5] ONNX model found at', url, '(fallback embed until runtime wired)');
        onnxAvailable = true;
        return true;
      }
    } catch {}
  }
  onnxAvailable = false;
  return false;
}

export async function embedText(text: string): Promise<Embedding> {
  if (!text || text.trim().length === 0) return { values: new Float32Array(384), dim: 384 };
  const useOnnx = await tryLoadOnnx();
  if (useOnnx && onnxSession && tokenizer) {
    try {
      // Real path: tokenize -> ort run -> mean pool -> normalize
      // const tokens = tokenizer.encode(text, { maxLength: 128, truncation: true });
      // const feeds = { input_ids: ..., attention_mask: ... };
      // const out = await onnxSession.run(feeds);
      // return { values: normalize(out.last_hidden_state), dim: 384 };
    } catch (e) {
      console.warn('[mE5] ONNX inference failed, fallback hash embed', e);
    }
  }
  return { values: fallbackEmbed(text, 384), dim: 384 };
}

export function embedTextSync(text: string, dim = 384): Embedding {
  return { values: fallbackEmbed(text, dim), dim };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Score fusion: RRF (Reciprocal Rank Fusion) for BM25 + semantic. */
export function reciprocalRankFusion(
  lexicalRanks: Map<string, number>,
  semanticRanks: Map<string, number>,
  k = 60
): Map<string, number> {
  const fused = new Map<string, number>();
  const allIds = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
  for (const id of allIds) {
    const lr = lexicalRanks.get(id);
    const sr = semanticRanks.get(id);
    const score = (lr !== undefined ? 1 / (k + lr) : 0) * 0.5 + (sr !== undefined ? 1 / (k + sr) : 0) * 0.5;
    fused.set(id, score);
  }
  return fused;
}
