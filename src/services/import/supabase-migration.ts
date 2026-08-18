/**
 * Supabase Data Migration Service for EverydayFuel
 * Migrates legacy Supabase tables (foodinfo_personal, logs_personal, goals_personal) into local SQLite tables.
 */

import { FoodRepository } from '@data/repositories/food.repo';
import { LogRepository } from '@data/repositories/log.repo';
import { GoalRepository } from '@data/repositories/goal.repo';
import { WaterRepository } from '@data/repositories/water.repo';
import { formatDateISO } from '@utils/dates';

export interface LegacyFoodInfo {
  name: string;
  cal: number;
  protein: number;
  carb: number;
  fat: number;
}

export interface LegacyLog {
  id?: string;
  type: 'food' | 'water' | 'exercise';
  food: string;
  cal_burned?: number;
  water_ml?: number;
  confidence?: number;
  created_at: string;
}

export interface LegacyGoal {
  cal: number;
  pro: number;
  carb: number;
  fat: number;
  water: number;
  effective_date: string;
}

export interface LegacyExportPayload {
  foodinfo_personal?: LegacyFoodInfo[];
  logs_personal?: LegacyLog[];
  goals_personal?: LegacyGoal[];
}

export async function migrateSupabaseData(
  payload: LegacyExportPayload,
  foodRepo: FoodRepository,
  logRepo: LogRepository,
  goalRepo: GoalRepository,
  waterRepo: WaterRepository
): Promise<{ foodCount: number; logCount: number; goalCount: number }> {
  let foodCount = 0;
  let logCount = 0;
  let goalCount = 0;

  // 1. Migrate Food Reference Library
  if (payload.foodinfo_personal && Array.isArray(payload.foodinfo_personal)) {
    for (const item of payload.foodinfo_personal) {
      if (!item.name) continue;
      const normalized = item.name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
      
      await foodRepo.insert({
        canonical_name: item.name,
        normalized_name: normalized,
        calories_per_100g: item.cal || 0,
        protein_per_100g: item.protein || 0,
        carbs_per_100g: item.carb || 0,
        fat_per_100g: item.fat || 0,
        water_per_100g: 0,
        nutrition_basis: 'per_100g',
        source_type: 'imported',
        confidence: 1.0
      });
      foodCount++;
    }
  }

  // 2. Migrate Goals History
  if (payload.goals_personal && Array.isArray(payload.goals_personal)) {
    for (const g of payload.goals_personal) {
      await goalRepo.createGoal({
        name: 'Imported Goal',
        start_date: g.effective_date ? formatDateISO(g.effective_date) : formatDateISO(new Date()),
        end_date: null,
        calories_target: g.cal || 2500,
        protein_target: g.pro || 150,
        carbs_target: g.carb || 250,
        fat_target: g.fat || 80,
        water_target: g.water || 4000
      });
      goalCount++;
    }
  }

  // 3. Migrate Daily Event Logs
  if (payload.logs_personal && Array.isArray(payload.logs_personal)) {
    for (const log of payload.logs_personal) {
      const date = log.created_at ? formatDateISO(log.created_at) : formatDateISO(new Date());

      if (log.type === 'water') {
        await waterRepo.insertWaterLog({
          date,
          amount_ml: log.water_ml || 250,
          source: 'explicit'
        });
        logCount++;
      } else if (log.type === 'food') {
        const normalized = (log.food || 'Food').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
        let food = await foodRepo.findByNormalizedName(normalized);
        if (!food) {
          food = await foodRepo.insert({
            canonical_name: log.food || 'Food Item',
            normalized_name: normalized,
            calories_per_100g: 200,
            protein_per_100g: 10,
            carbs_per_100g: 25,
            fat_per_100g: 5,
            water_per_100g: 0,
            nutrition_basis: 'per_100g',
            source_type: 'imported',
            confidence: log.confidence ? log.confidence / 100 : 0.8
          });
        }

        await logRepo.insertFoodLog({
          date,
          food_id: food.id,
          amount_g: 100,
          calories: food.calories_per_100g || 0,
          protein_g: food.protein_per_100g || 0,
          carbs_g: food.carbs_per_100g || 0,
          fat_g: food.fat_per_100g || 0
        });
        logCount++;
      }
    }
  }

  return { foodCount, logCount, goalCount };
}
