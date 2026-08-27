/**
 * Date utility functions for NutritionOS / EverydayFuel
 */

/**
 * Get current date as YYYY-MM-DD string in local timezone
 */
export function getTodayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format ISO date string or Date object to YYYY-MM-DD
 */
export function formatDateISO(date: Date | string): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // Already YYYY-MM-DD — validate without timezone shift
    const v = new Date(date + 'T00:00:00');
    if (!isNaN(v.getTime())) return date;
  }
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date;
  if (isNaN(d.getTime())) return getTodayDateString();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format YYYY-MM-DD for human display (e.g., "Monday, Aug 18")
 */
export function formatDisplayDate(dateStr: string): string {
  const today = getTodayDateString();
  if (dateStr === today) return 'Today';
  
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === formatDateISO(yesterday)) return 'Yesterday';

  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Get array of date strings for the past N days leading up to endDate
 */
export function getDateRange(endDateStr: string, days: number): string[] {
  const dates: string[] = [];
  const end = new Date(endDateStr + 'T00:00:00');
  
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dates.push(formatDateISO(d));
  }
  
  return dates;
}

/**
 * Shift date string by N days (+N or -N)
 */
export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return formatDateISO(d);
}

/**
 * Get days in month for calendar heatmap grid
 */
export function getDaysInMonth(year: number, monthZeroIndexed: number): number {
  return new Date(year, monthZeroIndexed + 1, 0).getDate();
}

/**
 * Get day of week for 1st of month (0 = Sun, 1 = Mon, ...)
 */
export function getFirstDayOfMonthOffset(year: number, monthZeroIndexed: number): number {
  return new Date(year, monthZeroIndexed, 1).getDay();
}
