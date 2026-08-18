/**
 * Sanitization & JSON parsing utilities for NutritionOS / EverydayFuel
 */

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Safely parse JSON output from AI or local files.
 * Automatically strips markdown code fences (```json ... ```)
 */
export function safeJsonParse<T>(input: string, fallback: T): T {
  if (!input || typeof input !== 'string') return fallback;
  
  try {
    let clean = input.trim();
    // Strip markdown fences
    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(clean) as T;
  } catch (err) {
    console.warn('safeJsonParse failed:', err, 'Input:', input);
    return fallback;
  }
}
