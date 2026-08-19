/**
 * Tracker CSV Importer for EverydayFuel
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

export function parseCSV(csvText: string): { rows: ParsedImportRow[]; errors: string[] } {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], errors: ['CSV file is empty or missing headers'] };

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/"/g, ''));
  
  const dateIdx = headers.findIndex(h => h.includes('date'));
  const nameIdx = headers.findIndex(h => h.includes('food') || h.includes('name') || h.includes('item'));
  const calIdx = headers.findIndex(h => h.includes('cal'));
  const proIdx = headers.findIndex(h => h.includes('pro'));
  const carbIdx = headers.findIndex(h => h.includes('carb'));
  const fatIdx = headers.findIndex(h => h.includes('fat'));
  const amtIdx = headers.findIndex(h => h.includes('amount') || h.includes('gram') || h.includes('weight'));

  if (dateIdx === -1 || calIdx === -1) {
    return { rows: [], errors: ['CSV must contain at least "Date" and "Calories" columns'] };
  }

  const rows: ParsedImportRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.length <= dateIdx) continue;

    const dateStr = cols[dateIdx];
    const foodName = nameIdx !== -1 && cols[nameIdx] ? cols[nameIdx] : 'Imported Item';
    const cal = parseFloat(cols[calIdx]) || 0;
    const pro = proIdx !== -1 ? parseFloat(cols[proIdx]) || 0 : 0;
    const carb = carbIdx !== -1 ? parseFloat(cols[carbIdx]) || 0 : 0;
    const fat = fatIdx !== -1 ? parseFloat(cols[fatIdx]) || 0 : 0;
    const amt = amtIdx !== -1 ? parseFloat(cols[amtIdx]) || 100 : 100;

    if (!dateStr || isNaN(new Date(dateStr).getTime())) {
      errors.push(`Row ${i + 1}: Invalid date "${dateStr}"`);
      continue;
    }

    rows.push({
      date: dateStr,
      foodName,
      calories: cal,
      proteinG: pro,
      carbsG: carb,
      fatG: fat,
      amountG: amt
    });
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
