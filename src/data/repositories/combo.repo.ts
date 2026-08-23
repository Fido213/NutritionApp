import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Combo, ComboItem } from '../types';

export class ComboRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID 
      ? crypto.randomUUID() 
      : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  /**
   * Run statements inside a manual transaction, tolerating connections that
   * cannot HOLD one across separate run() calls (jeep-sqlite WEB/WASM applies
   * each write immediately and reports "no transaction is active" on COMMIT —
   * the exact false-failure users saw on every combo save). Same contract as
   * restoreBackupArchive (pass 18): benign COMMIT state is warned and treated
   * as committed; a real mid-flight error rolls back best-effort and rethrows.
   */
  private async withTransaction(statements: () => Promise<void>): Promise<void> {
    let began = false;
    try {
      await this.db.run('BEGIN TRANSACTION');
      began = true;
    } catch {
      began = false; // connection manages its own transactions
    }

    try {
      await statements();
      if (!began) return;
      try {
        await this.db.run('COMMIT');
      } catch (commitErr) {
        const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
        if (!/no transaction is active/i.test(msg)) throw commitErr;
        console.warn('comboRepo: COMMIT found no active transaction; writes were already applied.');
      }
    } catch (e) {
      if (began) {
        try { await this.db.run('ROLLBACK'); } catch { /* nothing to roll back */ }
      }
      throw e;
    }
  }

  async createCombo(name: string, items: Omit<ComboItem, 'id' | 'combo_id'>[]): Promise<Combo & { items: ComboItem[] }> {
    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.withTransaction(async () => {
      await this.db.run(
        `INSERT INTO combos (id, name, note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
        [id, name, now, now]
      );

      for (const item of items) {
        await this.db.run(
          `INSERT INTO combo_items (id, combo_id, food_id, amount_g, amount_ml) VALUES (?, ?, ?, ?, ?)`,
          [this.generateUUID(), id, item.food_id, item.amount_g || null, item.amount_ml || null]
        );
      }
    });

    const combo = await this.getCombo(id);
    if (!combo) throw new Error('Failed to retrieve created combo');
    return combo;
  }

  async getCombo(id: string): Promise<(Combo & { items: ComboItem[] }) | null> {
    const comboRes = await this.db.query(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!comboRes.values || comboRes.values.length === 0) return null;

    const combo = comboRes.values[0] as Combo;
    const itemsRes = await this.db.query(`SELECT * FROM combo_items WHERE combo_id = ?`, [id]);
    
    return {
      ...combo,
      items: (itemsRes.values as ComboItem[]) || []
    };
  }

  async getAllCombos(): Promise<(Combo & { items: ComboItem[] })[]> {
    const combosRes = await this.db.query(`SELECT * FROM combos ORDER BY name ASC`);
    if (!combosRes.values) return [];
    
    const combos = combosRes.values as (Combo & { items: ComboItem[] })[];
    for (const combo of combos) {
      const itemsRes = await this.db.query(`SELECT * FROM combo_items WHERE combo_id = ?`, [combo.id]);
      combo.items = (itemsRes.values as ComboItem[]) || [];
    }
    
    return combos;
  }

  async updateCombo(id: string, name: string, items: Omit<ComboItem, 'id' | 'combo_id'>[]): Promise<Combo & { items: ComboItem[] }> {
    const now = new Date().toISOString();
    await this.withTransaction(async () => {
      await this.db.run(`UPDATE combos SET name = ?, updated_at = ? WHERE id = ?`, [name, now, id]);
      await this.db.run(`DELETE FROM combo_items WHERE combo_id = ?`, [id]);

      for (const item of items) {
        await this.db.run(
          `INSERT INTO combo_items (id, combo_id, food_id, amount_g, amount_ml) VALUES (?, ?, ?, ?, ?)`,
          [this.generateUUID(), id, item.food_id, item.amount_g || null, item.amount_ml || null]
        );
      }
    });

    const combo = await this.getCombo(id);
    if (!combo) throw new Error('Failed to retrieve updated combo');
    return combo;
  }

  async deleteCombo(id: string): Promise<void> {
    await this.db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  }
}
