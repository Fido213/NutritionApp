import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { WaterLog, InsertWaterLog } from '../types';

export class WaterRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async insertWaterLog(log: InsertWaterLog): Promise<WaterLog> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO water_logs (
        id, date, amount_ml, source, food_log_id, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, log.date, log.amount_ml, log.source, log.food_log_id || null, log.note || null, now
      ]
    );

    const res = await this.db.query(`SELECT * FROM water_logs WHERE id = ?`, [id]);
    return res.values![0] as WaterLog;
  }

  async getWaterForDate(date: string): Promise<WaterLog[]> {
    const res = await this.db.query(`SELECT * FROM water_logs WHERE date = ? ORDER BY created_at ASC`, [date]);
    return (res.values as WaterLog[]) || [];
  }

  /** All water entries in a range (journal view) — one batched query. */
  async getWaterForRange(startDate: string, endDate: string): Promise<WaterLog[]> {
    const res = await this.db.query(
      `SELECT * FROM water_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC`,
      [startDate, endDate]
    );
    return (res.values as WaterLog[]) || [];
  }

  async getFirstAndLastDate(): Promise<{ first: string | null; last: string | null }> {
    const res = await this.db.query(`SELECT MIN(date) as first_date, MAX(date) as last_date FROM water_logs`);
    const row = res.values?.[0];
    return { first: row?.first_date ?? null, last: row?.last_date ?? null };
  }

  async getWaterTotalsBySource(date: string): Promise<Record<string, number>> {
    const res = await this.db.query(
      `SELECT source, SUM(amount_ml) as total FROM water_logs WHERE date = ? GROUP BY source`,
      [date]
    );
    const totals: Record<string, number> = { explicit: 0, drink: 0, food: 0 };
    if (res.values) {
      for (const row of res.values) {
        totals[row.source] = row.total || 0;
      }
    }
    return totals;
  }

  /** Per-date, per-source water totals for a range — one query instead of one per date (history views). */
  async getWaterTotalsBySourceForRange(startDate: string, endDate: string): Promise<Record<string, Record<string, number>>> {
    const res = await this.db.query(
      `SELECT date, source, SUM(amount_ml) as total FROM water_logs WHERE date >= ? AND date <= ? GROUP BY date, source`,
      [startDate, endDate]
    );
    const out: Record<string, Record<string, number>> = {};
    for (const row of res.values || []) {
      out[row.date] = out[row.date] || { explicit: 0, drink: 0, food: 0 };
      out[row.date][row.source] = row.total || 0;
    }
    return out;
  }

  async deleteWaterLog(id: string): Promise<void> {
    await this.db.run(`DELETE FROM water_logs WHERE id = ?`, [id]);
  }
}
