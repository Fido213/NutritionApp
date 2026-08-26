/**
 * Shared application context (pass-21 decomposition of the old main.ts).
 *
 * One mutable object holding the database connection's repositories, the
 * services, and the few genuinely global UI bindings. `initApp()` in main.ts
 * populates everything BEFORE any listener can fire; feature modules import
 * `ctx` and read properties at call time, so late assignment is safe.
 *
 * Feature-owned state (index tab/sort, builder draft, journal expansion,
 * history window cache …) deliberately does NOT live here — it stays
 * module-private in its owning file under src/ui/features/.
 */
import type { DatabaseManager } from '@data/database';
import type { FoodRepository } from '@data/repositories/food.repo';
import type { LogRepository } from '@data/repositories/log.repo';
import type { GoalRepository } from '@data/repositories/goal.repo';
import type { WaterRepository } from '@data/repositories/water.repo';
import type { DailyRecordRepository } from '@data/repositories/daily-record.repo';
import type { ComboRepository } from '@data/repositories/combo.repo';
import type { BarcodeRepository } from '@data/repositories/barcode.repo';
import type { ObservationRepository } from '@data/repositories/observation.repo';
import type { ImportRepository } from '@data/repositories/import.repo';
import type { GemmaClient } from '@services/ai/gemma-client';
import type { FoodService } from '@services/food/food-service';
import type { Food } from '@data/types';
import type { TabController, ViewId } from './nav';

export interface AppContext {
  /* Data + services (assigned once during initApp) */
  dbManager: DatabaseManager;
  foodRepo: FoodRepository;
  logRepo: LogRepository;
  goalRepo: GoalRepository;
  waterRepo: WaterRepository;
  dailyRecordRepo: DailyRecordRepository;
  comboRepo: ComboRepository;
  barcodeRepo: BarcodeRepository;
  observationRepo: ObservationRepository;
  importRepo: ImportRepository;
  gemmaClient: GemmaClient;
  foodService: FoodService;

  /* Global UI bindings */
  currentViewId: ViewId;
  tabController: TabController | null;

  /** One lookup per food id per session — shared by index/detail/builder. */
  foodCache: Map<string, Food>;
}

export const ctx: AppContext = {
  currentViewId: 'today',
  tabController: null,
  foodCache: new Map<string, Food>(),
} as unknown as AppContext; // repositories/services assigned by initApp() before any listener runs

/** Resolve a food through the shared cache (one DB lookup per id ever). */
export async function resolveFoodCached(foodId: string): Promise<Food | null> {
  const cached = ctx.foodCache.get(foodId);
  if (cached) return cached;
  const food = await ctx.foodRepo.findById(foodId);
  if (food) ctx.foodCache.set(foodId, food);
  return food;
}
