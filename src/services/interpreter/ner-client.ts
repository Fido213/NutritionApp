/**
 * Lightweight multilingual FOOD NER — L12 ONNX with heuristic fallback.
 *
 * Locked choice: microsoft/Multilingual-MiniLM-L12-H384 fine-tuned B/I/O FOOD (INT8 vocab-pruned Latin+Arabic ~80MB)
 *   assets/ner_food_l12_qint8.onnx in "ai models/" (untracked) -> dist/assets/ via scripts/copy-models.mjs
 *
 * When ONNX not present (dev / fallback), uses deterministic span rules grounded in original text.
 * Never hallucinates — every span must be substring of input (langextract-style grounding).
 */

export interface FoodSpan {
  text: string;
  normalized: string;
  span: [number, number]; // char offsets in original
  confidence: number;
  isCompositeHint?: boolean;
}

let onnxSession: any | null = null;
let onnxAvailable: boolean | null = null;

async function tryLoadOnnx(): Promise<boolean> {
  if (onnxAvailable !== null) return onnxAvailable;
  try {
    // Dynamic import — only succeeds if onnxruntime and model present (native or web)
    // "ai models/ner_food_l12_qint8.onnx" copied to dist/assets/ at build
    const candidates = [
      '/assets/ner_food_l12_qint8.onnx',
      'assets/ner_food_l12_qint8.onnx',
      './assets/ner_food_l12_qint8.onnx',
      '/ai models/ner_food_l12_qint8.onnx'
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) {
          // Real ONNX load would happen here via onnxruntime-web/native
          // const ort = await import('onnxruntime-web');
          // onnxSession = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
          // For now mark available — actual inference shim below uses heuristic until runtime is added
          onnxAvailable = true;
          console.info('[NER] ONNX model found at', url, '(heuristic fallback until runtime wired)');
          return true;
        }
      } catch {}
    }
    onnxAvailable = false;
    return false;
  } catch {
    onnxAvailable = false;
    return false;
  }
}

// Deterministic heuristic fallback — grounded, no LLM
// Splits on quantity boundaries and extracts food words between quantities

const STOP_WORDS = new Set([
  'and', 'und', 'et', 'y', 'e', 'en', 'plus', 'with', 'mit', 'avec', 'con', 'contenant', 'containing',
  'of', 'the', 'a', 'an', 'de', 'du', 'des', 'la', 'le', 'les', 'der', 'die', 'das', 'el', 'para'
]);

const COMPOSITE_HINT_RE = /(?:containing|contenant|mit|with|consisting|including|and\s+\w+\s+oats)/i;

function heuristicSpans(text: string, quantities: Array<{ span: [number, number] }>): FoodSpan[] {
  const spans: FoodSpan[] = [];
  const isComposite = COMPOSITE_HINT_RE.test(text);

  // Build segments between quantities
  // Example: "250g chicken breast, 100g rice" -> qty [0,4] "250g", [17,21] "100g" => food "chicken breast" between, "rice" after
  const sortedQty = [...quantities].sort((a, b) => a.span[0] - b.span[0]);

  // Helper to extract clean food text from a raw segment
  const extractFood = (raw: string, offset: number): FoodSpan | null => {
    let s = raw.trim();
    // Remove leading quantity residue and punctuation
    s = s.replace(/^[\s,;+\-]+/, '').replace(/[\s,;+\-]+$/, '');
    // Remove leading unit remnants that parser missed (e.g., "g chicken")
    s = s.replace(/^\s*(g|kg|ml|l|cup|tbsp|tsp)\b\s*/i, '');
    if (!s) return null;
    // Strip stop words at start
    let words = s.split(/\s+/);
    while (words.length && STOP_WORDS.has(words[0].toLowerCase())) words.shift();
    while (words.length && STOP_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
    if (!words.length) return null;
    // Heuristic: food phrase is 1-4 words, filter single letters
    words = words.slice(0, 4);
    const textClean = words.join(' ');
    if (textClean.length < 2 || textClean.length > 60) return null;
    // Allow Arabic/CJK etc.
    if (/^\d+$/.test(textClean)) return null;
    // Find exact case-preserving span in original
    const startInRaw = raw.indexOf(words[0]);
    if (startInRaw === -1) return null;
    const start = offset + (raw.indexOf(textClean) !== -1 ? raw.indexOf(textClean) : startInRaw);
    const end = start + textClean.length;
    // Verify substring matches original (grounding)
    const grounded = text.slice(start, end);
    if (grounded.toLowerCase().normalize('NFKC') !== textClean.toLowerCase().normalize('NFKC')) {
      // fallback to raw slice verification — ensure span text appears in original near offset
      const slice = text.slice(offset, offset + raw.length);
      if (!slice.toLowerCase().includes(textClean.toLowerCase())) return null;
    }
    return {
      text: textClean,
      normalized: textClean.toLowerCase().normalize('NFKC').trim().replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\s]/g, '').replace(/\s+/g, ' '),
      span: [start, end],
      confidence: isComposite ? 0.85 : 0.88,
      isCompositeHint: isComposite,
    };
  };

  if (sortedQty.length === 0) {
    // No quantities — whole input is one food span (e.g., "apple")
    const whole = text.trim().replace(/^[^A-Za-z\u00C0-\u024F\u0600-\u06FF0-9]+|[^A-Za-z\u00C0-\u024F\u0600-\u06FF0-9]+$/g, '');
    if (whole.length >= 2 && whole.length <= 60) {
      const start = text.indexOf(whole);
      if (start !== -1) {
        spans.push({
          text: whole,
          normalized: whole.toLowerCase().normalize('NFKC').trim().replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\s]/g, '').replace(/\s+/g, ' '),
          span: [start, start + whole.length],
          confidence: 0.75,
          isCompositeHint: isComposite,
        });
      }
    }
    return spans;
  }

  // Before first qty
  const first = sortedQty[0];
  if (first.span[0] > 0) {
    const seg = text.slice(0, first.span[0]);
    const f = extractFood(seg, 0);
    // Usually quantity is before food ("250g chicken") so before-first rarely food — skip unless no other
    if (f && sortedQty.length === 1 && seg.trim().length < 20) spans.push(f);
  }

  // Between qtys and after last qty
  for (let i = 0; i < sortedQty.length; i++) {
    const q = sortedQty[i];
    const nextStart = sortedQty[i + 1]?.span[0] ?? text.length;
    const seg = text.slice(q.span[1], nextStart);
    const f = extractFood(seg, q.span[1]);
    if (f) spans.push(f);
    else if (seg.trim().length > 0 && seg.trim().length < 40) {
      // Fallback: if segment is like "and" etc., skip; otherwise treat as potential food without clean words
      const trimmed = seg.replace(/^[,\s;+\-]+|[,\s;+\-]+$/g, '').trim();
      if (trimmed.length >= 2 && !STOP_WORDS.has(trimmed.toLowerCase())) {
        const start = text.indexOf(trimmed, q.span[1]);
        if (start !== -1) {
          spans.push({
            text: trimmed,
            normalized: trimmed.toLowerCase().normalize('NFKC').replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\s]/g, '').replace(/\s+/g, ' ').trim(),
            span: [start, start + trimmed.length],
            confidence: 0.72,
            isCompositeHint: isComposite,
          });
        }
      }
    }
  }

  // Dedupe by normalized
  const seen = new Set<string>();
  return spans.filter(s => {
    if (!s.normalized) return false;
    if (seen.has(s.normalized)) return false;
    seen.add(s.normalized);
    return true;
  });
}

export async function extractFoodSpans(text: string, quantities: Array<{ span: [number, number] }>): Promise<FoodSpan[]> {
  if (!text || text.trim().length === 0) return [];

  const hasOnnx = await tryLoadOnnx();
  if (hasOnnx && onnxSession) {
    try {
      // Real ONNX inference path — tokenization + BIO decode
      // Placeholder: when runtime is added, replace heuristic with:
      // const tokens = tokenize(text) -> ort session run -> BIO tags -> spans
      // For now fall through to heuristic with log
      console.debug('[NER] ONNX session ready — would run L12 inference');
    } catch (e) {
      console.warn('[NER] ONNX inference failed, fallback heuristic', e);
    }
  }

  // Heuristic grounded extraction (always available, <5ms, strict offline, <300MB)
  return heuristicSpans(text, quantities);
}

/** Synchronous heuristic for tests / fallback. */
export function extractFoodSpansSync(text: string, quantities: Array<{ span: [number, number] }>): FoodSpan[] {
  return heuristicSpans(text, quantities);
}
