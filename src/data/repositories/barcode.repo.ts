import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Food, FoodBarcode } from '../types';

export class BarcodeRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async lookupBarcode(barcode: string): Promise<Food | null> {
    const res = await this.db.query(
      `SELECT f.* FROM foods f
       JOIN food_barcodes fb ON f.id = fb.food_id
       WHERE fb.barcode = ?`,
      [barcode]
    );
    return res.values && res.values.length > 0 ? (res.values[0] as Food) : null;
  }

  async saveBarcode(foodId: string, barcode: string, source: string): Promise<FoodBarcode> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO food_barcodes (id, food_id, barcode, source, verified, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(barcode) DO UPDATE SET food_id = excluded.food_id, source = excluded.source`,
      [id, foodId, barcode, source, now]
    );

    const res = await this.db.query(`SELECT * FROM food_barcodes WHERE barcode = ?`, [barcode]);
    return res.values![0] as FoodBarcode;
  }

  async markVerified(id: string): Promise<void> {
    await this.db.run(`UPDATE food_barcodes SET verified = 1 WHERE id = ?`, [id]);
  }
}
