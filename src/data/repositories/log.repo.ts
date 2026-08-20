import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { FoodLog, UpdateFoodLog } from '../types';

export class LogRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID 
      ? crypto.randomUUID() 
      : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async insertFoodLog(log: any): Promise<FoodLog> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    const foodId = log.food_id || log.foodId;
    const observationId = log.observation_id || log.observationId || null;
    const amountG = log.amount_g || log.amountG || null;
    const amountMl = log.amount_ml || log.amountMl || null;
    const calories = log.calories || 0;
    const proteinG = log.protein_g || log.proteinG || 0;
    const carbsG = log.carbs_g || log.carbsG || 0;
    const fatG = log.fat_g || log.fatG || 0;
    const waterMl = log.water_ml || log.waterMl || null;

    await this.db.run(
      `INSERT INTO food_logs (
        id, date, food_id, observation_id, amount_g, amount_ml, 
        calories, protein_g, carbs_g, fat_g, water_ml, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, log.date, foodId, observationId, amountG, amountMl,
        calories, proteinG, carbsG, fatG, waterMl, log.note || null, now
      ]
    );

    const res = await this.db.query(`SELECT * FROM food_logs WHERE id = ?`, [id]);
    return res.values![0] as FoodLog;
  }

  async findById(id: string): Promise<FoodLog | null> {
    const res = await this.db.query(`SELECT * FROM food_logs WHERE id = ?`, [id]);
    return res.values && res.values.length > 0 ? (res.values[0] as FoodLog) : null;
  }

  async getLogsForDate(date: string): Promise<FoodLog[]> {
    const res = await this.db.query(
      `SELECT fl.*, f.canonical_name AS food_name FROM food_logs fl JOIN foods f ON f.id = fl.food_id WHERE fl.date = ? ORDER BY fl.created_at ASC`,
      [date]
    );
    return (res.values as FoodLog[]) || [];
  }

  async getLogsForRange(startDate: string, endDate: string): Promise<FoodLog[]> {
    const res = await this.db.query(
      `SELECT * FROM food_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC`,
      [startDate, endDate]
    );
    return (res.values as FoodLog[]) || [];
  }

  async deleteLog(id: string): Promise<void> {
    await this.db.run(`DELETE FROM food_logs WHERE id = ?`, [id]);
  }

  async duplicateLog(id: string, targetDate: string): Promise<FoodLog> {
    const res = await this.db.query(`SELECT * FROM food_logs WHERE id = ?`, [id]);
    if (!res.values || res.values.length === 0) throw new Error('Log not found');
    
    const existing = res.values[0] as FoodLog;
    return this.insertFoodLog({
      date: targetDate,
      food_id: existing.food_id,
      observation_id: existing.observation_id,
      amount_g: existing.amount_g,
      amount_ml: existing.amount_ml,
      calories: existing.calories,
      protein_g: existing.protein_g,
      carbs_g: existing.carbs_g,
      fat_g: existing.fat_g,
      water_ml: existing.water_ml,
      note: existing.note
    });
  }

  async updateLog(id: string, updates: UpdateFoodLog): Promise<FoodLog> {
    const setClauses: string[] = [];
    const values: any[] = [];
    
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
    
    if (setClauses.length > 0) {
      values.push(id);
      await this.db.run(`UPDATE food_logs SET ${setClauses.join(', ')} WHERE id = ?`, values);
    }
    
    const res = await this.db.query(`SELECT * FROM food_logs WHERE id = ?`, [id]);
    return res.values![0] as FoodLog;
  }

  async getFirstAndLastDate(): Promise<{ first: string | null; last: string | null }> {
    const res = await this.db.query(`SELECT MIN(date) as first_date, MAX(date) as last_date FROM food_logs`);
    const row = res.values?.[0];
    return { first: row?.first_date ?? null, last: row?.last_date ?? null };
  }

  async getDailyTotals(date: string): Promise<{ date: string; calories: number; proteinG: number; carbsG: number; fatG: number; waterMl: number }> {
    const res = await this.db.query(
      `SELECT 
        SUM(calories) as calories, 
        SUM(protein_g) as protein_g, 
        SUM(carbs_g) as carbs_g, 
        SUM(fat_g) as fat_g, 
        SUM(water_ml) as water_ml 
       FROM food_logs WHERE date = ?`,
      [date]
    );
    const row = res.values?.[0];
    return {
      date,
      calories: row?.calories || 0,
      proteinG: row?.protein_g || 0,
      carbsG: row?.carbs_g || 0,
      fatG: row?.fat_g || 0,
      waterMl: row?.water_ml || 0
    };
  }
}
