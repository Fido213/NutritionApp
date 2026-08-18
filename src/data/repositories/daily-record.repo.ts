import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { DailyRecord } from '../types';

export class DailyRecordRepository {
  constructor(private db: SQLiteDBConnection) {}

  async getOrCreate(date: string): Promise<DailyRecord> {
    const res = await this.db.query(`SELECT * FROM daily_records WHERE date = ?`, [date]);
    if (res.values && res.values.length > 0) {
      return res.values[0] as DailyRecord;
    }

    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO daily_records (date, low_accuracy, note, created_at, updated_at) VALUES (?, 0, NULL, ?, ?)`,
      [date, now, now]
    );

    const created = await this.db.query(`SELECT * FROM daily_records WHERE date = ?`, [date]);
    return created.values![0] as DailyRecord;
  }

  async setLowAccuracy(date: string, flag: boolean): Promise<DailyRecord> {
    await this.getOrCreate(date);
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE daily_records SET low_accuracy = ?, updated_at = ? WHERE date = ?`,
      [flag ? 1 : 0, now, date]
    );
    const res = await this.db.query(`SELECT * FROM daily_records WHERE date = ?`, [date]);
    return res.values![0] as DailyRecord;
  }

  async setNote(date: string, note: string | null): Promise<DailyRecord> {
    await this.getOrCreate(date);
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE daily_records SET note = ?, updated_at = ? WHERE date = ?`,
      [note, now, date]
    );
    const res = await this.db.query(`SELECT * FROM daily_records WHERE date = ?`, [date]);
    return res.values![0] as DailyRecord;
  }

  async getForRange(startDate: string, endDate: string): Promise<DailyRecord[]> {
    const res = await this.db.query(
      `SELECT * FROM daily_records WHERE date >= ? AND date <= ? ORDER BY date ASC`,
      [startDate, endDate]
    );
    return (res.values as DailyRecord[]) || [];
  }
}
