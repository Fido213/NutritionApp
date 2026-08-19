import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Food, InsertFood, UpdateFood } from '../types';
import { FoodReference } from '@domain/types';

export class FoodRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID 
      ? crypto.randomUUID() 
      : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  toFoodReference(food: Food): FoodReference {
    return {
      id: food.id,
      canonicalName: food.canonical_name,
      caloriesPer100g: food.calories_per_100g,
      proteinPer100g: food.protein_per_100g,
      carbsPer100g: food.carbs_per_100g,
      fatPer100g: food.fat_per_100g,
      waterPer100g: food.water_per_100g,
      nutritionBasis: food.nutrition_basis,
      confidence: food.confidence,
      sourceType: food.source_type
    };
  }

  async findById(id: string): Promise<Food | null> {
    const res = await this.db.query(`SELECT * FROM foods WHERE id = ?`, [id]);
    return res.values && res.values.length > 0 ? (res.values[0] as Food) : null;
  }

  async findByNormalizedName(name: string): Promise<Food | null> {
    const res = await this.db.query(`SELECT * FROM foods WHERE normalized_name = ?`, [name]);
    return res.values && res.values.length > 0 ? (res.values[0] as Food) : null;
  }

  async findByAlias(alias: string): Promise<Food | null> {
    const res = await this.db.query(
      `SELECT f.* FROM foods f
       JOIN food_aliases fa ON f.id = fa.food_id
       WHERE fa.normalized_alias = ?`,
      [alias]
    );
    return res.values && res.values.length > 0 ? (res.values[0] as Food) : null;
  }

  async fuzzySearch(query: string, limit: number = 20): Promise<Food[]> {
    const searchTerm = `%${query}%`;
    const res = await this.db.query(
      `SELECT * FROM foods 
       WHERE canonical_name LIKE ? OR normalized_name LIKE ? 
       LIMIT ?`,
      [searchTerm, searchTerm, limit]
    );
    return (res.values as Food[]) || [];
  }

  async insert(food: InsertFood): Promise<Food> {
    const id = this.generateUUID();
    const now = new Date().toISOString();
    
    await this.db.run(
      `INSERT INTO foods (
        id, canonical_name, normalized_name, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, water_per_100g,
        nutrition_basis, source_type, source_reference, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, food.canonical_name, food.normalized_name, food.calories_per_100g, food.protein_per_100g, 
        food.carbs_per_100g, food.fat_per_100g, food.water_per_100g ?? 0, food.nutrition_basis || 'per_100g', 
        food.source_type || 'user_entered', food.source_reference || null, food.confidence ?? 1.0, now, now
      ]
    );
    
    return (await this.findById(id))!;
  }

  async update(id: string, updates: UpdateFood): Promise<Food | null> {
    const setClauses: string[] = [];
    const values: any[] = [];
    
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
    
    if (setClauses.length === 0) return this.findById(id);
    
    setClauses.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    values.push(id);
    
    await this.db.run(`UPDATE foods SET ${setClauses.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }

  async upsertFromAI(canonicalName: string, nutrients: Partial<InsertFood>, confidence: number): Promise<Food> {
    const normalized = canonicalName.toLowerCase().replace(/[^a-z0-9]/g, '');
    let existing = await this.findByNormalizedName(normalized);
    
    if (existing) {
      if (confidence > (existing.confidence || 0)) {
        await this.update(existing.id, {
          ...nutrients,
          confidence,
          source_type: 'ai_estimate'
        });
      }
      return (await this.findById(existing.id))!;
    }
    
    return this.insert({
      canonical_name: canonicalName,
      normalized_name: normalized,
      calories_per_100g: nutrients.calories_per_100g || null,
      protein_per_100g: nutrients.protein_per_100g || null,
      carbs_per_100g: nutrients.carbs_per_100g || null,
      fat_per_100g: nutrients.fat_per_100g || null,
      water_per_100g: nutrients.water_per_100g || null,
      nutrition_basis: 'per_100g',
      source_type: 'ai_estimate',
      source_reference: null,
      confidence,
    });
  }
}
