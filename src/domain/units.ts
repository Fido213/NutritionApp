/**
 * Unit normalization table for deterministic quantity parsing.
 * Covers Europe / N-Africa / Americas / AU — grams is canonical internal unit (per spec §8).
 * Ml kept distinct for liquids; piece-based foods resolved via per-piece weights (USDA avg).
 *
 * No LLM required — all conversions are code-calculated (spec §3.2).
 */

export type NormalizedUnit = 'g' | 'ml';

export interface UnitDef {
  /** canonical grams/ml factor (multiply amount) */
  factor: number;
  kind: NormalizedUnit;
  /** aliases in all supported langs (lowercased, NFKC) */
  aliases: string[];
}

/**
 * Weight units — canonical g.
 * 1 kg = 1000g, 1 mg = 0.001g, 1 oz = 28.3495g, 1 lb = 453.592g
 */
const WEIGHT_UNITS: UnitDef[] = [
  { factor: 1000, kind: 'g', aliases: ['kg', 'kgs', 'kilogram', 'kilograms', 'kilogramm', 'kilogramme', 'kilogrammes', 'كيلو', 'كيلوغرام', 'kg.'] },
  { factor: 1, kind: 'g', aliases: ['g', 'g.', 'gram', 'grams', 'gramm', 'gramme', 'grammes', 'gr', 'gr.', 'غرام', 'جرام', 'جم'] },
  { factor: 0.001, kind: 'g', aliases: ['mg', 'milligram', 'milligrams', 'milligramm'] },
  { factor: 28.3495, kind: 'g', aliases: ['oz', 'ounce', 'ounces', 'unze', 'onza', 'onces'] },
  { factor: 453.592, kind: 'g', aliases: ['lb', 'lbs', 'pound', 'pounds', 'pfund', 'livre', 'libra'] },
];

/**
 * Volume units — canonical ml.
 * 1 l = 1000ml, 1 cup ≈ 240ml (US), 1 tbsp = 15ml, 1 tsp = 5ml
 * For foods where weight is more useful (e.g., rice), the parser returns ml but the caller
 * may convert via food-specific density — here we keep ml as canonical for liquids.
 */
const VOLUME_UNITS: UnitDef[] = [
  { factor: 1000, kind: 'ml', aliases: ['l', 'l.', 'liter', 'liters', 'litre', 'litres', 'لتر', 'ltr'] },
  { factor: 1, kind: 'ml', aliases: ['ml', 'ml.', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'مل', 'ملليلتر'] },
  { factor: 240, kind: 'ml', aliases: ['cup', 'cups', 'tasse', 'tassen', 'taza', 'tazas', 'coupe', 'coupes', 'كوب', 'أكواب'] },
  { factor: 15, kind: 'ml', aliases: ['tbsp', 'tbsps', 'tablespoon', 'tablespoons', 'el', 'eßl', 'càs', 'cuillère à soupe', 'ملعقة كبيرة'] },
  { factor: 5, kind: 'ml', aliases: ['tsp', 'tsps', 'teaspoon', 'teaspoons', 'tl', 'cc', 'cuillère à café', 'ملعقة صغيرة'] },
];

/**
 * Piece/count units — resolved to grams via average food weights (USDA).
 * Used when amount is given as count without weight: "2 apples", "1 egg".
 * The unit parser returns grams directly via perPieceGrams lookup; the NER span provides food identity.
 */
export const PER_PIECE_GRAMS: Record<string, number> = {
  // normalized food token -> grams per 1 piece
  'apple': 182, 'apfel': 182, 'pomme': 182, 'تفاحة': 182,
  'banana': 118, 'banane': 118, 'موز': 118,
  'egg': 50, 'eggs': 50, 'ei': 50, 'eier': 50, 'œuf': 50, 'œufs': 50, 'بيضة': 50, 'بيض': 50,
  'slice': 30, 'scheibe': 30, 'tranche': 30, 'شريحة': 30,
  'piece': 40, 'pieces': 40, 'stück': 40, 'morceau': 40, 'قطعة': 40,
  'can': 400, 'dose': 400, 'boîte': 400, 'علبة': 400,
  'cup rice': 180, 'reis': 180, 'riz': 180, 'أرز': 180,
  // fallback for unknown piece
  '__default_piece': 40,
};

const ALL_UNITS: UnitDef[] = [...WEIGHT_UNITS, ...VOLUME_UNITS];

const ALIAS_TO_DEF = new Map<string, UnitDef>();
for (const def of ALL_UNITS) {
  for (const a of def.aliases) ALIAS_TO_DEF.set(normalizeAlias(a), def);
}

function normalizeAlias(s: string): string {
  return s.toLowerCase().normalize('NFKC').trim().replace(/\.$/, '');
}

/** Resolve a unit string (any lang, with/without dot, plural) to canonical definition. */
export function resolveUnit(aliasRaw: string): UnitDef | null {
  if (!aliasRaw) return null;
  const key = normalizeAlias(aliasRaw);
  if (ALIAS_TO_DEF.has(key)) return ALIAS_TO_DEF.get(key)!;
  // Try without trailing s
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  if (ALIAS_TO_DEF.has(singular)) return ALIAS_TO_DEF.get(singular)!;
  return null;
}

/** For quantity like "250g" split into value+unit, normalize to {grams or ml}. */
export function normalizeAmount(value: number, unitRaw: string | null, foodHint?: string): { amountG: number | null; amountMl: number | null } {
  if (!unitRaw) return { amountG: value, amountMl: null }; // bare number -> grams (fallback)
  const def = resolveUnit(unitRaw);
  if (!def) {
    // Check piece-based
    const hint = (foodHint || '').toLowerCase().normalize('NFKC').trim();
    const pieceKey = Object.keys(PER_PIECE_GRAMS).find(k => hint.includes(k));
    if (pieceKey || PER_PIECE_GRAMS[unitRaw.toLowerCase()]) {
      const grams = PER_PIECE_GRAMS[pieceKey || unitRaw.toLowerCase()] ?? PER_PIECE_GRAMS['__default_piece'];
      return { amountG: value * grams, amountMl: null };
    }
    return { amountG: value, amountMl: null };
  }
  const scaled = value * def.factor;
  if (def.kind === 'g') return { amountG: scaled, amountMl: null };
  return { amountG: null, amountMl: scaled };
}

/** Fractions map for deterministic parsing (includes NFKC decomposed forms like 1⁄2). */
export const FRACTION_MAP: Record<string, number> = {
  '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1/3, '⅔': 2/3, '⅛': 0.125,
  '1/2': 0.5, '1/4': 0.25, '3/4': 0.75, '1/3': 1/3, '2/3': 2/3,
  '1⁄2': 0.5, '1⁄4': 0.25, '3⁄4': 0.75, '1⁄3': 1/3, '2⁄3': 2/3, // NFKC (U+2044 fraction slash)
};

/** Normalize a numeric token (handles comma decimal 12,5 and fractions). */
export function parseLocalizedNumber(raw: string): number | null {
  const t = raw.trim().normalize('NFKC').replace(/\u2044/g, '/'); // NFKC fraction slash -> /
  if (FRACTION_MAP[t] !== undefined) return FRACTION_MAP[t];
  // Mixed fraction like "1 1/2" handled by caller
  // Comma decimal: 12,5 -> 12.5
  let norm = t.replace(',', '.');
  // Handle mixed "1 1/2" — split and sum
  if (norm.includes(' ') && norm.includes('/')) {
    const parts = norm.split(/\s+/);
    let sum = 0;
    for (const p of parts) {
      if (FRACTION_MAP[p] !== undefined) sum += FRACTION_MAP[p];
      else {
        const v = parseFloat(p);
        if (!Number.isFinite(v)) return null;
        sum += v;
      }
    }
    return sum;
  }
  if (norm.includes('/')) {
    const [num, den] = norm.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
    return null;
  }
  const v = parseFloat(norm);
  return Number.isFinite(v) ? v : null;
}
