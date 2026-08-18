import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Goal, InsertGoal } from '../types';

export class GoalRepository {
  constructor(private db: SQLiteDBConnection) {}

  private generateUUID(): string {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  async getCurrentGoal(): Promise<Goal | null> {
    const res = await this.db.query(`SELECT * FROM goals WHERE end_date IS NULL ORDER BY start_date DESC LIMIT 1`);
    return res.values && res.values.length > 0 ? (res.values[0] as Goal) : null;
  }

  async getGoalForDate(date: string): Promise<Goal | null> {
    const res = await this.db.query(
      `SELECT * FROM goals 
       WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?) 
       ORDER BY start_date DESC LIMIT 1`,
      [date, date]
    );
    return res.values && res.values.length > 0 ? (res.values[0] as Goal) : null;
  }

  async createGoal(goal: InsertGoal): Promise<Goal> {
    const current = await this.getCurrentGoal();
    if (current) {
      // Set end_date of previous current goal to just before the new one starts
      const endDate = new Date(new Date(goal.start_date).getTime() - 86400000).toISOString().split('T')[0];
      await this.db.run(`UPDATE goals SET end_date = ? WHERE id = ?`, [endDate, current.id]);
    }

    const id = this.generateUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO goals (
        id, name, start_date, end_date, calories_target, protein_target, 
        carbs_target, fat_target, water_target, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, goal.name, goal.start_date, goal.end_date || null, goal.calories_target,
        goal.protein_target, goal.carbs_target, goal.fat_target, goal.water_target, now
      ]
    );

    const res = await this.db.query(`SELECT * FROM goals WHERE id = ?`, [id]);
    return res.values![0] as Goal;
  }

  async getGoalsHistory(): Promise<Goal[]> {
    const res = await this.db.query(`SELECT * FROM goals ORDER BY start_date DESC`);
    return (res.values as Goal[]) || [];
  }

  async validateNoOverlap(startDate: string, endDate: string | null): Promise<boolean> {
    if (!endDate) {
       const res = await this.db.query(`SELECT COUNT(*) as count FROM goals WHERE end_date IS NULL OR end_date >= ?`, [startDate]);
       return res.values![0].count === 0;
    }
    const res = await this.db.query(
      `SELECT COUNT(*) as count FROM goals 
       WHERE (start_date <= ? AND (end_date IS NULL OR end_date >= ?))`,
      [endDate, startDate]
    );
    return res.values![0].count === 0;
  }
}
