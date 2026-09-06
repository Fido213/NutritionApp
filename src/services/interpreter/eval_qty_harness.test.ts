/**
 * Phase 0B — Qty regression harness (mechanical, runs in `npm test`).
 *
 * Dataset lives versioned at `ai models/eval/eval_qty.jsonl`; this runner
 * checks the DETERMINISTIC parser (`./unit-parser`) only — no retrieval,
 * no models.
 *
 * Contract per case type:
 *  - explicit/multiplier/range/fraction/comma-decimal/multilingual/
 *    qty-after-food/multi-span/far-qty/qty-span-align: every `expected` entry
 *    must be found (grams→amountG, ml→amountMl, count→bare qty).
 *  - vague/no-qty/clamp: parser must produce NO gram/ml qty (lexicon gaps and
 *    clamps stay silent here; the flagged-default path in `./index` owns them).
 *  - bare-count: at least one bare qty (amountG/amountMl null) with the
 *    expected originalValue, and NO gram qty.
 *  - negation-gap: qty assertions as above; negation dropping is asserted in
 *    the Phase 1 merge test, not here.
 *
 * Far-qty / span-attachment semantics (<30 chars rule, `./index:174`) are
 * asserted in the Phase 1 merge test via `interpretTextSync`, not here —
 * this file pins the parser half of the contract only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuantities } from './unit-parser';

interface QtyExpectation {
  grams?: number;
  ml?: number;
  count?: number;
}

interface QtyCase {
  id: string;
  input: string;
  expected: QtyExpectation[];
  type: string;
  lang?: string;
  notes?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
// Tracked dataset, single source (ai models/ is gitignored — see .gitignore).
const datasetPath = join(here, 'data', 'eval_qty.jsonl');
const raw = readFileSync(datasetPath, 'utf-8');
const cases: QtyCase[] = raw
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as QtyCase);

const GRAM_QTY_TYPES = new Set([
  'explicit',
  'multiplier',
  'range',
  'fraction',
  'comma-decimal',
  'multilingual',
  'qty-after-food',
  'multi-span',
  'far-qty',
  'qty-span-align',
  'negation-gap',
]);

function gramQty(qs: ReturnType<typeof parseQuantities>) {
  return qs.filter((q) => q.amountG !== null || q.amountMl !== null);
}

describe('eval_qty harness (Phase 0B)', () => {
  it('dataset loads with expected size', () => {
    expect(cases.length).toBeGreaterThanOrEqual(75);
  });

  for (const c of cases) {
    it(`${c.id} [${c.type}] ${c.input.slice(0, 48)}`, () => {
      const qs = parseQuantities(c.input);

      if (c.type === 'vague' || c.type === 'no-qty' || c.type === 'clamp') {
        // Parser must stay silent: no gram/ml qty invented.
        expect(
          gramQty(qs),
          `${c.id}: parser invented grams for ${c.type} input`,
        ).toHaveLength(0);
        return;
      }

      if (c.type === 'bare-count') {
        const bare = qs.filter((q) => q.amountG === null && q.amountMl === null);
        for (const e of c.expected) {
          if (e.count !== undefined) {
            expect(
              bare.some((q) => Math.abs(q.originalValue - e.count!) < 1e-9),
              `${c.id}: missing bare count ${e.count} in ${JSON.stringify(qs)}`,
            ).toBe(true);
          }
        }
        expect(
          gramQty(qs),
          `${c.id}: bare-count input must not produce gram qty`,
        ).toHaveLength(0);
        return;
      }

      if (!GRAM_QTY_TYPES.has(c.type)) {
        throw new Error(`${c.id}: unknown eval type ${c.type}`);
      }

      for (const e of c.expected) {
        if (e.grams !== undefined) {
          const hit = qs.some(
            (q) => q.amountG !== null && Math.abs(q.amountG - e.grams!) < 1.0,
          );
          expect(hit, `${c.id}: missing ~${e.grams}g in ${JSON.stringify(qs)}`).toBe(
            true,
          );
        }
        if (e.ml !== undefined) {
          const hit = qs.some(
            (q) => q.amountMl !== null && Math.abs(q.amountMl - e.ml!) < 1.0,
          );
          expect(hit, `${c.id}: missing ~${e.ml}ml in ${JSON.stringify(qs)}`).toBe(
            true,
          );
        }
        if (e.count !== undefined) {
          const hit = qs.some(
            (q) =>
              q.amountG === null &&
              q.amountMl === null &&
              Math.abs(q.originalValue - e.count!) < 1e-9,
          );
          expect(
            hit,
            `${c.id}: missing bare count ${e.count} in ${JSON.stringify(qs)}`,
          ).toBe(true);
        }
      }
    });
  }
});
