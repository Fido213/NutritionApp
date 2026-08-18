import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { ImportRecord } from '../types';

export class ImportRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async recordImport(importData: Omit<ImportRecord, 'id' | 'imported_at'>): Promise<ImportRecord> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO imports (
        id, source_type, filename, imported_at, status, row_count, error_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, importData.source_type, importData.filename || null, now,
        importData.status, importData.row_count || 0, importData.error_count || 0
      ]
    );

    const res = await this.db.query(`SELECT * FROM imports WHERE id = ?`, [id]);
    return res.values![0] as ImportRecord;
  }

  async getImportHistory(): Promise<ImportRecord[]> {
    const res = await this.db.query(`SELECT * FROM imports ORDER BY imported_at DESC`);
    return (res.values as ImportRecord[]) || [];
  }
}
