/**
 * Copy built AI models from "ai models/" (untracked) to dist/assets/
 * Space in folder name requires quoting. Falls back gracefully if models not yet built.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = 'ai models';
const DEST_DIR = 'dist/assets';
const FILES = [
  'mE5_qint8_opt2.onnx',
  'ner_food_l12_qint8.onnx',
  'faiss_fp16.index',
  'tokenizer.json',
  'config.json'
];

if (!existsSync(SRC_DIR)) {
  console.log(`[copy-models] "${SRC_DIR}" not found — skipping (using fallback pipeline)`);
  process.exit(0);
}

mkdirSync(DEST_DIR, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const src = join(SRC_DIR, f);
  const dest = join(DEST_DIR, f);
  if (existsSync(src)) {
    try {
      cpSync(src, dest);
      const sizeMB = (readdirSync(SRC_DIR).length && (await import('node:fs')).statSync(src).size / 1024 / 1024).toFixed(1);
      console.log(`[copy-models] ${f} -> ${dest} (${sizeMB}MB)`);
      copied++;
    } catch (e) {
      console.warn(`[copy-models] failed ${f}:`, e.message);
    }
  }
}

// Also copy tokenizer/config if present under subfolders
try {
  const entries = readdirSync(SRC_DIR);
  for (const e of entries) {
    if (e.endsWith('.json') && !FILES.includes(e)) {
      const src = join(SRC_DIR, e);
      const dest = join(DEST_DIR, e);
      cpSync(src, dest);
      console.log(`[copy-models] ${e} -> ${dest}`);
      copied++;
    }
  }
} catch {}

if (copied === 0) console.log('[copy-models] no model files found in "ai models/" — build will use heuristic fallbacks');
else console.log(`[copy-models] copied ${copied} file(s) to ${DEST_DIR}`);

// Base food-library seed (44k migration): bundle the cleaned corpus so a
// fresh install seeds SQLite offline on first launch. Skipped when absent
// (fresh clones without the workbench simply start with an empty library).
const SEED_SRC = join(SRC_DIR, 'results', 'unified_food_database_per100g_CLEANED.csv');
const SEED_DEST = join(DEST_DIR, 'unified_food_database_per100g_CLEANED.csv');
try {
  if (existsSync(SEED_SRC)) {
    cpSync(SEED_SRC, SEED_DEST);
    const sizeMB = ((await import('node:fs')).statSync(SEED_SRC).size / 1024 / 1024).toFixed(1);
    console.log(`[copy-models] seed corpus -> ${SEED_DEST} (${sizeMB}MB)`);
  } else {
    console.log('[copy-models] no seed corpus in "ai models/results/" — first launch starts empty');
  }
} catch (e) {
  console.warn('[copy-models] seed copy failed:', e.message);
}
