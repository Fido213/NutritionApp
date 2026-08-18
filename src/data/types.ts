export type NutritionBasis = 'per_100g' | 'per_100ml' | 'per_serving';
export type SourceType = 'ai_estimate' | 'barcode' | 'nutrition_label' | 'user_entered' | 'imported';
export type WaterSource = 'explicit' | 'drink' | 'food';
export type ObservationSource = 'text' | 'image' | 'label_ocr' | 'barcode';

export interface Food {
  id: string;
  canonical_name: string;
  normalized_name: string;
  calories_per_100g: number | null;
  protein_per_100g: number | null;
  carbs_per_100g: number | null;
  fat_per_100g: number | null;
  water_per_100g: number | null;
  nutrition_basis: NutritionBasis;
  source_type: SourceType;
  source_reference: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export type InsertFood = Omit<Food, 'id' | 'created_at' | 'updated_at' | 'source_reference'> & {
  source_reference?: string | null;
};
export type UpdateFood = Partial<InsertFood>;

export interface FoodAlias {
  id: string;
  food_id: string;
  alias: string;
  normalized_alias: string;
  source: string;
  confidence: number | null;
  created_at: string;
}

export interface FoodBarcode {
  id: string;
  food_id: string;
  barcode: string;
  source: string;
  verified: number;
  created_at: string;
}

export interface FoodObservation {
  id: string;
  food_id: string | null;
  source_type: ObservationSource;
  estimated_amount: number | null;
  final_amount: number | null;
  amount_unit: string;
  confidence: number | null;
  raw_input: string | null;
  interpretation_json: string | null;
  user_corrected: number;
  created_at: string;
}

export interface FoodLog {
  id: string;
  date: string;
  food_id: string;
  observation_id: string | null;
  amount_g: number | null;
  amount_ml: number | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  water_ml: number | null;
  note: string | null;
  created_at: string;
}

export type InsertFoodLog = Omit<FoodLog, 'id' | 'created_at' | 'observation_id' | 'amount_g' | 'amount_ml' | 'water_ml' | 'note'> & {
  observation_id?: string | null;
  amount_g?: number | null;
  amount_ml?: number | null;
  water_ml?: number | null;
  note?: string | null;
};
export type UpdateFoodLog = Partial<InsertFoodLog>;

export interface Combo {
  id: string;
  name: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComboItem {
  id: string;
  combo_id: string;
  food_id: string;
  amount_g: number | null;
  amount_ml: number | null;
}

export interface WaterLog {
  id: string;
  date: string;
  amount_ml: number;
  source: WaterSource;
  food_log_id: string | null;
  note: string | null;
  created_at: string;
}

export type InsertWaterLog = Omit<WaterLog, 'id' | 'created_at' | 'food_log_id' | 'note'> & {
  food_log_id?: string | null;
  note?: string | null;
};

export interface DailyRecord {
  date: string;
  low_accuracy: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  calories_target: number;
  protein_target: number;
  carbs_target: number;
  fat_target: number;
  water_target: number;
  created_at: string;
}

export type InsertGoal = Omit<Goal, 'id' | 'created_at'>;

export interface AppSetting {
  key: string;
  value: string;
}

export interface ImportRecord {
  id: string;
  source_type: string;
  filename: string | null;
  imported_at: string;
  status: string;
  row_count: number | null;
  error_count: number | null;
}
