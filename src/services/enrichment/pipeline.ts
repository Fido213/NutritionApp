/**
 * E2 enrichment pipeline: silent, optional, never blocking.
 *
 * - Post-log trigger: fresh ai_estimate rows get one background attempt
 *   each (opt-in toggle + online required). Fire-and-forget behind the
 *   log toast — a failure is invisible, a success flips the chip on next
 *   render (no per-row toast; silence is the design).
 * - Toggle-on sweep: the library's ai_estimate rows only (a WHERE, never the
 *   whole 39k library through the bridge), newest first, sequential with a
 *   polite pause, bounded by row count AND wall-clock budget, re-checking the
 *   toggle as it goes so flipping it OFF actually stops the run. One summary
 *   toast at the end.
 * - Session guards: one COMPLETED attempt per row per session (in-memory set),
 *   so a miss is never retried in a loop; next session tries again (the row
 *   may have been user-corrected meanwhile — re-reads always win). An attempt
 *   that never reached the network (offline, timeout, HTTP error) is NOT
 *   counted, so reconnecting retries instead of looking dead until restart.
 * - Visible consequence of a merge (documented, not a bug): the row leaves
 *   the E4 estimated-review queue and stops counting toward a day's exported
 *   "Estimated Share", because both key on source_type === 'ai_estimate'.
 */
import { searchFoodsOnlineOutcome, matchOnlineHit } from './off-search';
import { enrichFood } from './enrich';
import type { FoodRepository } from '@data/repositories/food.repo';
import type { SettingsRepository } from '@data/repositories/settings.repo';

export interface EnrichDeps {
  foodRepo: Pick<FoodRepository, 'findById' | 'update'>;
  settingsRepo: Pick<SettingsRepository, 'getOnlineEnrichment'>;
  fetchImpl?: typeof fetch;
  sleepMs?: (ms: number) => Promise<void>;
  onToast?: (msg: string) => void;
  /** Bust a cached full row after upgrade (Index/foodCache freshness). */
  onUpgraded?: (foodId: string) => void;
  /** Connectivity probe (tests inject; default reads navigator.onLine). */
  isOnline?: () => boolean;
  /** Clock for the sweep budget (tests inject). */
  now?: () => number;
}

/** The sweep needs one extra repository read (estimate rows only). */
export interface SweepDeps extends EnrichDeps {
  foodRepo: Pick<FoodRepository, 'findById' | 'update' | 'getFoodsBySourceType'>;
}

/** Bound a sweep by rows and by wall clock, so the toggle can't trap the UI. */
export const SWEEP_MAX_ROWS = 200;
export const SWEEP_MAX_MS = 60_000;
/** How often the sweep re-reads the toggle. */
export const SWEEP_TOGGLE_CHECK_EVERY = 5;

export type SweepStop = 'done' | 'cap' | 'time' | 'toggle-off' | 'error';

const attemptedThisSession = new Set<string>();

/** Tests (and logout paths) reset the per-session attempt ledger. */
export function resetEnrichmentSession(): void {
  attemptedThisSession.clear();
}

/**
 * Offline pre-check: skip the network entirely when the platform says we have
 * none (each skipped row costs nothing instead of a 6 s timeout). Unknown
 * platform (Node tests) counts as online — the fetch is the real arbiter.
 */
function defaultIsOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine !== false;
}

type TryResult = 'enriched' | 'miss' | 'later';

async function tryOne(deps: EnrichDeps, foodId: string, name: string): Promise<TryResult> {
  if (attemptedThisSession.has(foodId)) return 'miss';
  if (!(deps.isOnline ?? defaultIsOnline)()) return 'later';
  const outcome = await searchFoodsOnlineOutcome(name, { fetchImpl: deps.fetchImpl });
  // A request that never completed is not an attempt: leave the row eligible.
  if (outcome.transportFailed) return 'later';
  attemptedThisSession.add(foodId);
  if (outcome.hits.length === 0) return 'miss';
  const match = matchOnlineHit(name, outcome.hits);
  if (!match) return 'miss';
  const updated = await enrichFood(deps.foodRepo, foodId, match);
  if (!updated) return 'miss';
  deps.onUpgraded?.(foodId);
  return 'enriched';
}

/** Post-log trigger: attempt each freshly-estimated row once, silently. */
export async function enrichFreshEstimates(
  deps: EnrichDeps,
  fresh: Array<{ id: string; name: string; sourceType: string }>,
): Promise<number> {
  let enabled = false;
  try {
    enabled = await deps.settingsRepo.getOnlineEnrichment();
  } catch { /* toggle unreadable: stay local, stay silent */ }
  if (!enabled) return 0;
  if (!(deps.isOnline ?? defaultIsOnline)()) return 0;
  let done = 0;
  for (const f of fresh) {
    if (f.sourceType !== 'ai_estimate') continue;
    try {
      if (await tryOne(deps, f.id, f.name) === 'enriched') done++;
    } catch { /* background only: never break logging */ }
  }
  return done;
}

/**
 * Toggle-on sweep: the library's ai_estimate rows, one polite attempt each,
 * bounded by SWEEP_MAX_ROWS and SWEEP_MAX_MS, stopping as soon as the toggle
 * is switched off. Summary toast only (never per-row).
 */
export async function sweepEstimates(
  deps: SweepDeps,
  opts: { maxRows?: number; maxMs?: number; toggleCheckEvery?: number } = {},
): Promise<{ tried: number; enriched: number; stopped: SweepStop }> {
  const maxRows = opts.maxRows ?? SWEEP_MAX_ROWS;
  const maxMs = opts.maxMs ?? SWEEP_MAX_MS;
  const checkEvery = Math.max(1, opts.toggleCheckEvery ?? SWEEP_TOGGLE_CHECK_EVERY);
  const now = deps.now ?? (() => Date.now());
  let rows: Array<{ id: string; canonical_name: string; source_type: string }> = [];
  try {
    rows = (await deps.foodRepo.getFoodsBySourceType('ai_estimate', maxRows)) as Array<{
      id: string; canonical_name: string; source_type: string;
    }>;
  } catch { return { tried: 0, enriched: 0, stopped: 'error' }; }

  const sleep = deps.sleepMs ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const started = now();
  let enriched = 0;
  let tried = 0;
  let stopped: SweepStop = rows.length >= maxRows ? 'cap' : 'done';

  for (const [i, row] of rows.entries()) {
    // The toggle is the user's stop button: honour it mid-run, not just at entry.
    if (i % checkEvery === 0) {
      let enabled = false;
      try { enabled = await deps.settingsRepo.getOnlineEnrichment(); } catch { /* treat as off */ }
      if (!enabled) { stopped = 'toggle-off'; break; }
    }
    if (i > 0 && now() - started >= maxMs) { stopped = 'time'; break; }
    tried++;
    try {
      if (await tryOne(deps, row.id, row.canonical_name) === 'enriched') enriched++;
    } catch { /* keep sweeping */ }
    await sleep(150);
  }

  const tail = stopped === 'toggle-off'
    ? ` — stopped after ${tried} (enrichment switched off)`
    : stopped === 'time' || stopped === 'cap'
      ? ` — ${tried} checked, run again to continue`
      : '';
  if (enriched > 0) {
    deps.onToast?.(`Enriched ${enriched} estimate${enriched === 1 ? '' : 's'} with online data${tail}`);
  } else if (tail) {
    deps.onToast?.(`Checked ${tried} estimate${tried === 1 ? '' : 's'}${tail}`);
  }
  return { tried, enriched, stopped };
}
