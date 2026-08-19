import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { FoodObservation } from '../types';

export class ObservationRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async insert(observation: Omit<FoodObservation, 'id' | 'created_at'>): Promise<FoodObservation> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO food_observations (
        id, food_id, source_type, estimated_amount, final_amount, amount_unit,
        confidence, raw_input, interpretation_json, user_corrected, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        observation.food_id || null,
        observation.source_type,
        observation.estimated_amount ?? null,
        observation.final_amount ?? null,
        observation.amount_unit,
        observation.confidence ?? null,
        observation.raw_input ?? null,
        observation.interpretation_json ?? null,
        observation.user_corrected ?? 0,
        now
      ]
    );

    const res = await this.db.query(`SELECT * FROM food_observations WHERE id = ?`, [id]);
    return res.values![0] as FoodObservation;
  }

  async findById(id: string): Promise<FoodObservation | null> {
    const res = await this.db.query(`SELECT * FROM food_observations WHERE id = ?`, [id]);
    return res.values && res.values.length > 0 ? (res.values[0] as FoodObservation) : null;
  }
}