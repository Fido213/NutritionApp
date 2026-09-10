import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Food, InsertFood, UpdateFood } from '../types';
import { FoodReference } from '@domain/types';

export class FoodRepository {
  constructor(private db: SQLiteDBConnection) {}

  /**
   * In-memory library generation counter. The interpreter caches its BM25 /
   * embedding indexes across submits and rebuilds only when this changes —
   * every mutation below bumps it, so the cache can never serve a stale
   * library (the 1000-newest-rows window that hid 97% of the seed is gone).
   * Raw-SQL paths that bypass this repo (backup restore, wipe) must call
   * bumpVersion() after committing.
   */
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  bumpVersion(): void {
    this.version++;
  }

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

  /** Every library food (Index screen) — newest first; sorted in the UI layer. */
  async getAllFoods(limit: number = 500, opts?: { includeSeed?: boolean }): Promise<Food[]> {
    // Personal-first index: without includeSeed, bulk-imported rows surface
    // only once the user has logged them (the 39k seed stays out of sight
    // until explicitly enabled or actually used).
    if (opts?.includeSeed === false) {
      const res = await this.db.query(
        `SELECT * FROM foods WHERE source_type != 'imported'
         OR id IN (SELECT DISTINCT food_id FROM food_logs WHERE food_id IS NOT NULL)
         ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );
      return (res.values as Food[]) || [];
    }
    const res = await this.db.query(`SELECT * FROM foods ORDER BY created_at DESC LIMIT ?`, [limit]);
    return (res.values as Food[]) || [];
  }

  async fuzzySearch(query: string, limit: number = 20, opts?: { includeSeed?: boolean }): Promise<Food[]> {
    const searchTerm = `%${query}%`;
    if (opts?.includeSeed === false) {
      const res = await this.db.query(
        `SELECT * FROM foods
         WHERE (canonical_name LIKE ? OR normalized_name LIKE ?)
         AND (source_type != 'imported' OR id IN (SELECT DISTINCT food_id FROM food_logs WHERE food_id IS NOT NULL))
         LIMIT ?`,
        [searchTerm, searchTerm, limit]
      );
      return (res.values as Food[]) || [];
    }
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
    
    this.bumpVersion();
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
    this.bumpVersion();
    return this.findById(id);
  }

  /**
   * Bulk insert for the first-launch base seed (44k migration). Chunked
   * multi-row INSERTs inside one manual transaction — 39k single-row bridge
   * round-trips would take minutes; ~800 chunked statements take seconds.
   * Chunk of 50 keeps bound params (50×14=700) under SQLite's 999 limit.
   * Mirrors combo.repo's transaction tolerance (fallback connections that
   * auto-commit report "no transaction is active" on COMMIT).
   */
  async bulkInsert(rows: InsertFood[]): Promise<number> {
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    const cols = [
      'id', 'canonical_name', 'normalized_name', 'calories_per_100g', 'protein_per_100g',
      'carbs_per_100g', 'fat_per_100g', 'water_per_100g', 'nutrition_basis', 'source_type',
      'source_reference', 'confidence', 'created_at', 'updated_at'
    ];
    const CHUNK = 50;
    let began = false;
    try {
      try {
        await this.db.run('BEGIN TRANSACTION');
        began = true;
      } catch { began = false; }
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
        const values: any[] = [];
        for (const r of chunk) {
          values.push(
            this.generateUUID(), r.canonical_name, r.normalized_name,
            r.calories_per_100g ?? null, r.protein_per_100g ?? null, r.carbs_per_100g ?? null,
            r.fat_per_100g ?? null, r.water_per_100g ?? null, r.nutrition_basis || 'per_100g',
            r.source_type || 'imported', (r as any).source_reference || null,
            (r as any).confidence ?? null, now, now
          );
        }
        await this.db.run(`INSERT INTO foods (${cols.join(', ')}) VALUES ${placeholders}`, values);
        inserted += chunk.length;
      }
      if (began) {
        try {
          await this.db.run('COMMIT');
        } catch (commitErr: any) {
          const msg = String(commitErr?.message || commitErr);
          // Native plugin auto-commits each run() and reports either wording.
          if (!/no transaction is active|no current transaction/i.test(msg)) throw commitErr;
          console.warn('foodRepo.bulkInsert: COMMIT found no active transaction; writes were already applied.');
        }
      }
      this.bumpVersion();
      return inserted;
    } catch (e) {
      if (began) {
        try { await this.db.run('ROLLBACK'); } catch { /* best effort */ }
      }
      throw e;
    }
  }

  /**
   * Delete every food (seed-failure self-heal only: the seed runs solely on
   * an empty table, so a failed run's partial rows are all ours — clearing
   * leaves a clean empty table for next launch's retry instead of a stuck
   * partial library that the empty-guard would skip forever).
   */
  async clearAll(): Promise<void> {
    await this.db.run(`DELETE FROM foods`);
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
