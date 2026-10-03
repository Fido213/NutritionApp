import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { FoodAlias } from '../types';

export class AliasRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async create(alias: Omit<FoodAlias, 'id' | 'created_at'>): Promise<FoodAlias> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO food_aliases (
        id, food_id, alias, normalized_alias, source, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        alias.food_id,
        alias.alias,
        alias.normalized_alias,
        alias.source,
        alias.confidence ?? null,
        now
      ]
    );

    const res = await this.db.query(`SELECT * FROM food_aliases WHERE id = ?`, [id]);
    return res.values![0] as FoodAlias;
  }

  async findByNormalized(normalizedAlias: string): Promise<FoodAlias | null> {
    const res = await this.db.query(`SELECT * FROM food_aliases WHERE normalized_alias = ?`, [normalizedAlias]);
    return res.values && res.values.length > 0 ? (res.values[0] as FoodAlias) : null;
  }

  async getAliasesForFood(foodId: string): Promise<FoodAlias[]> {
    const res = await this.db.query(`SELECT * FROM food_aliases WHERE food_id = ? ORDER BY created_at ASC`, [foodId]);
    return (res.values as FoodAlias[]) || [];
  }

  /**
   * Every alias row, for the interpreter's boot warm: the retriever indexes
   * alias phrases so a curated or user-pinned name can influence RANKING
   * (previously aliases were only consulted after retrieval, where they can
   * override a wrong pick but never compete with it). Small table — a few
   * curated rows plus one per user pin.
   */
  async getAllAliases(): Promise<FoodAlias[]> {
    const res = await this.db.query(`SELECT * FROM food_aliases ORDER BY created_at ASC`);
    return (res.values as FoodAlias[]) || [];
  }

  /**
   * Delete every alias row for a normalized phrase (any food). User defaults
   * move: re-pinning a phrase must not leave a stale mapping behind for the
   * reader (findByNormalized takes the first match) to trip over.
   */
  async deleteByNormalized(normalizedAlias: string): Promise<void> {
    await this.db.run(`DELETE FROM food_aliases WHERE normalized_alias = ?`, [normalizedAlias]);
  }
}