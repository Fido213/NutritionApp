/**
 * Tracker CSV Importer for EverydayFuel
 *
 * Supports two shapes:
 * 1. Per-item tracker exports (Date, Food, Calories, Protein, Carbs, Fat[, Amount]).
 * 2. The old app's daily-aggregate export (exportexample.csv shape — one row
 *    per day with Target + Total columns, "Pure Water (ml)" and a "Logs"
 *    column). Total columns are preferred over Target columns so the actual
 *    values are imported, never the targets.
 */

export interface ParsedImportRow {
  date: string;
  foodName: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  amountG?: number;
  waterMl?: number;
}

/** First header index matching the first key that matches any header (case-insensitive). */
function findColumn(headers: string[], keys: string[]): number {
  for (const key of keys) {
    const idx = headers.findIndex(h => h.includes(key));
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parseCSV(csvText: string): { rows: ParsedImportRow[]; errors: string[] } {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], errors: ['CSV file is empty or missing headers'] };

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/"/g, ''));

  const dateIdx = headers.findIndex(h => h.includes('date'));
  // Per-item exports name the food; the legacy daily export has no food column,
  // so fall back to its "Logs" column (first food of the day's list).
  let nameIdx = findColumn(headers, ['food', 'name', 'item']);
  const logsIdx = headers.findIndex(h => h.trim() === 'logs');
  if (nameIdx === -1) nameIdx = logsIdx;
  // Total/actual columns take precedence over Target columns (legacy export).
  const calIdx = findColumn(headers, ['total cal', 'cal']);
  const proIdx = findColumn(headers, ['total pro', 'pro']);
  const carbIdx = findColumn(headers, ['total carb', 'carb']);
  const fatIdx = findColumn(headers, ['total fat', 'fat']);
  const waterIdx = findColumn(headers, ['pure water', 'water']);
  const amtIdx = findColumn(headers, ['amount', 'gram', 'weight']);

  if (dateIdx === -1 || calIdx === -1) {
    return { rows: [], errors: ['CSV must contain at least "Date" and "Calories" columns'] };
  }

  const rows: ParsedImportRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.length <= dateIdx) continue;

    const dateStr = cols[dateIdx];
    let foodName = 'Imported Item';
    if (nameIdx !== -1 && cols[nameIdx]) {
      foodName = cols[nameIdx].split('|')[0].trim();
    }
    const cal = parseFloat(cols[calIdx]) || 0;
    const pro = proIdx !== -1 ? parseFloat(cols[proIdx]) || 0 : 0;
    const carb = carbIdx !== -1 ? parseFloat(cols[carbIdx]) || 0 : 0;
    const fat = fatIdx !== -1 ? parseFloat(cols[fatIdx]) || 0 : 0;
    const amt = amtIdx !== -1 ? parseFloat(cols[amtIdx]) || 100 : 100;
    const waterMl = waterIdx !== -1 ? parseFloat(cols[waterIdx]) || 0 : undefined;

    if (!dateStr || isNaN(new Date(dateStr).getTime())) {
      errors.push(`Row ${i + 1}: Invalid date "${dateStr}"`);
      continue;
    }

    const row: ParsedImportRow = {
      date: dateStr,
      foodName,
      calories: cal,
      proteinG: pro,
      carbsG: carb,
      fatG: fat,
      amountG: amt
    };
    if (waterMl !== undefined) row.waterMl = waterMl;

    rows.push(row);
  }

  return { rows, errors };
}

/**
 * Split a single CSV line into fields, honoring double-quoted fields
 * (so "Chicken, Grilled" stays one field). Adjacent quotes inside a
 * quoted field are unescaped per the CSV convention.
 */
function splitCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  cols.push(current);
  return cols;
}
