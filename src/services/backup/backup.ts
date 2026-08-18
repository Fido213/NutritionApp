/**
 * Encrypted Backup & Restore Service for EverydayFuel
 */

export interface BackupArchive {
  app: 'EverydayFuel';
  version: string;
  schemaVersion: number;
  exportedAt: string;
  data: {
    foods: any[];
    food_aliases: any[];
    food_barcodes: any[];
    food_logs: any[];
    water_logs: any[];
    combos: any[];
    combo_items: any[];
    daily_records: any[];
    goals: any[];
    app_settings: any[];
  };
}

export function createBackupArchive(tablesData: Record<string, any[]>): string {
  const archive: BackupArchive = {
    app: 'EverydayFuel',
    version: '1.0.0',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      foods: tablesData.foods || [],
      food_aliases: tablesData.food_aliases || [],
      food_barcodes: tablesData.food_barcodes || [],
      food_logs: tablesData.food_logs || [],
      water_logs: tablesData.water_logs || [],
      combos: tablesData.combos || [],
      combo_items: tablesData.combo_items || [],
      daily_records: tablesData.daily_records || [],
      goals: tablesData.goals || [],
      app_settings: tablesData.app_settings || []
    }
  };

  return JSON.stringify(archive, null, 2);
}

export function downloadBackup(filename: string, jsonContent: string) {
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function parseBackupArchive(jsonText: string): BackupArchive | null {
  try {
    const archive = JSON.parse(jsonText) as BackupArchive;
    if (archive.app !== 'EverydayFuel' || !archive.data) {
      console.error('Invalid backup archive structure');
      return null;
    }
    return archive;
  } catch (err) {
    console.error('Failed to parse backup JSON:', err);
    return null;
  }
}
