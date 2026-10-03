import { describe, it, expect, beforeEach } from 'vitest';
import { enrichFreshEstimates, sweepEstimates, resetEnrichmentSession } from './pipeline';

const OFF_PAYLOAD = {
  products: [
    {
      code: '5001', product_name: 'Chicken Shawarma',
      nutriments: { 'energy-kcal_100g': 165, proteins_100g: 20, carbohydrates_100g: 5, fat_100g: 7 },
    },
  ],
};

const stubFetchOk = async () => ({ ok: true, json: async () => OFF_PAYLOAD }) as any;
const stubFetchFail = async () => { throw new Error('offline'); };

function setup(rows: any[], enabled = true) {
  const foods = new Map<string, any>(rows.map(r => [r.id, { ...r }]));
  const toasts: string[] = [];
  const upgraded: string[] = [];
  const deps: any = {
    foodRepo: {
      async findById(id: string) { return foods.get(id) ?? null; },
      async update(id: string, u: any) {
        const cur = foods.get(id);
        if (!cur) return null;
        const next = { ...cur, ...u };
        foods.set(id, next);
        return next;
      },
      async getFoodsBySourceType(type: string, limit: number) {
        return [...foods.values()].filter(f => f.source_type === type).slice(0, limit);
      },
    },
    settingsRepo: { async getOnlineEnrichment() { return enabled; } },
    fetchImpl: stubFetchOk,
    sleepMs: async () => {},
    onToast: (m: string) => { toasts.push(m); },
    onUpgraded: (id: string) => { upgraded.push(id); },
  };
  return { deps, foods, toasts, upgraded };
}

const estRow = (id: string, name = 'Chicken Shawarma') => ({
  id, canonical_name: name, normalized_name: 'chickenshawarma',
  calories_per_100g: 200, protein_per_100g: 10, carbs_per_100g: 25, fat_per_100g: 5,
  source_type: 'ai_estimate', confidence: 0.5,
});

beforeEach(() => { resetEnrichmentSession(); });

describe('enrichFreshEstimates', () => {
  it('upgrades fresh estimates silently when opted in', async () => {
    const { deps, foods, toasts } = setup([estRow('e1')]);
    const done = await enrichFreshEstimates(deps, [{ id: 'e1', name: 'Chicken Shawarma', sourceType: 'ai_estimate' }]);
    expect(done).toBe(1);
    expect(foods.get('e1').source_type).toBe('online_match');
    expect(foods.get('e1').calories_per_100g).toBe(165);
    expect(toasts).toEqual([]); // silence by design
  });

  it('stays local when opted out, offline, or already attempted', async () => {
    const off = setup([estRow('e-off')], false);
    expect(await enrichFreshEstimates(off.deps, [{ id: 'e-off', name: 'X', sourceType: 'ai_estimate' }])).toBe(0);
    expect(off.foods.get('e-off').source_type).toBe('ai_estimate');

    const { deps } = setup([estRow('e-fail')]);
    deps.fetchImpl = stubFetchFail;
    expect(await enrichFreshEstimates(deps, [{ id: 'e-fail', name: 'X', sourceType: 'ai_estimate' }])).toBe(0);

    // The session ledger is keyed by food id: a COMPLETED attempt in THIS
    // session (including a genuine no-match miss) is never retried. Distinct
    // ids isolate. (A request that never reached the network is different —
    // see the reconnect test below.)
    const twice = setup([estRow('e-twice')]);
    const fresh = [{ id: 'e-twice', name: 'Chicken Shawarma', sourceType: 'ai_estimate' }];
    expect(await enrichFreshEstimates(twice.deps, fresh)).toBe(1);
    expect(await enrichFreshEstimates(twice.deps, fresh)).toBe(0); // ledger
  });

  it('skips non-estimates without a network call', async () => {
    let called = false;
    const { deps } = setup([estRow('e1', 'Chicken')]);
    deps.fetchImpl = (async () => { called = true; throw new Error('x'); }) as any;
    expect(await enrichFreshEstimates(deps, [{ id: 'e1', name: 'Chicken', sourceType: 'user_entered' }])).toBe(0);
    expect(called).toBe(false);
  });
});

describe('sweepEstimates', () => {
  it('sweeps every estimate once with a single summary toast', async () => {
    const { deps, foods, toasts } = setup([estRow('e1'), estRow('e2', 'Basterma'), estRow('e3')]);
    const res = await sweepEstimates(deps);
    expect(res.tried).toBe(3);
    // 'Basterma' matches no OFF hit name -> stays estimated; others upgrade.
    expect(foods.get('e1').source_type).toBe('online_match');
    expect(foods.get('e2').source_type).toBe('ai_estimate');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('2 estimate');
  });
});

describe('E2 safety: offline, transport failures, bounded sweep', () => {
  it('does not burn a session attempt when the request never completed', async () => {
    const { deps, foods } = setup([estRow('e-net')]);
    const fresh = [{ id: 'e-net', name: 'Chicken Shawarma', sourceType: 'ai_estimate' }];
    deps.fetchImpl = stubFetchFail;            // offline / timeout / HTTP error
    expect(await enrichFreshEstimates(deps, fresh)).toBe(0);
    // Reconnect: the row was never marked attempted, so the upgrade lands.
    deps.fetchImpl = stubFetchOk;
    expect(await enrichFreshEstimates(deps, fresh)).toBe(1);
    expect(foods.get('e-net').source_type).toBe('online_match');
  });

  it('skips the network entirely when the platform reports offline', async () => {
    let called = false;
    const { deps } = setup([estRow('e-off')]);
    deps.isOnline = () => false;
    deps.fetchImpl = (async () => { called = true; return { ok: true, json: async () => OFF_PAYLOAD }; }) as any;
    const fresh = [{ id: 'e-off', name: 'Chicken Shawarma', sourceType: 'ai_estimate' }];
    expect(await enrichFreshEstimates(deps, fresh)).toBe(0);
    expect(called).toBe(false);              // no wasted 6 s timeout per row
    deps.isOnline = () => true;
    expect(await enrichFreshEstimates(deps, fresh)).toBe(1);
    expect(called).toBe(true);
  });

  it('stops a sweep mid-run when the toggle is switched off', async () => {
    const { deps, foods } = setup([estRow('s1'), estRow('s2'), estRow('s3')]);
    deps.settingsRepo = { async getOnlineEnrichment() { return false; } };
    const res = await sweepEstimates(deps, { toggleCheckEvery: 1 });
    expect(res.stopped).toBe('toggle-off');
    expect(res.tried).toBe(0);               // OFF before the first attempt
    expect(foods.get('s1').source_type).toBe('ai_estimate');

    // ON for the first check, OFF for the second: one row goes through.
    const second = setup([estRow('t1'), estRow('t2'), estRow('t3')]);
    let n = 0;
    second.deps.settingsRepo = { async getOnlineEnrichment() { n++; return n === 1; } };
    const res2 = await sweepEstimates(second.deps, { toggleCheckEvery: 1 });
    expect(res2.stopped).toBe('toggle-off');
    expect(res2.tried).toBe(1);
    expect(second.foods.get('t1').source_type).toBe('online_match');
  });

  it('bounds a sweep by rows and by wall clock, and says which', async () => {
    const capped = setup([estRow('c1'), estRow('c2'), estRow('c3'), estRow('c4')]);
    const res = await sweepEstimates(capped.deps, { maxRows: 2 });
    expect(res.tried).toBe(2);
    expect(res.stopped).toBe('cap');
    expect(capped.toasts[0]).toContain('run again');

    const timed = setup([estRow('d1'), estRow('d2'), estRow('d3')]);
    const res2 = await sweepEstimates(timed.deps, { maxMs: 0 });
    expect(res2.tried).toBe(1);              // at least one row, then the budget trips
    expect(res2.stopped).toBe('time');
  });

  it('queries only the estimate rows, never the whole library', async () => {
    const { deps } = setup([estRow('q1'), estRow('q2')]);
    const asked: Array<[string, number]> = [];
    deps.foodRepo.getFoodsBySourceType = async (type: string, limit: number) => {
      asked.push([type, limit]);
      return [{ id: 'q1', canonical_name: 'Chicken Shawarma', source_type: 'ai_estimate' }];
    };
    const res = await sweepEstimates(deps);
    expect(asked).toEqual([['ai_estimate', 200]]);
    expect(res.tried).toBe(1);
  });
});
