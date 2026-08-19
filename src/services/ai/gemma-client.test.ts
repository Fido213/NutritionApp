import { describe, it, expect } from 'vitest';
import { GemmaClient } from './gemma-client';

describe('GemmaClient fallback text parser', () => {
  it('parses "250g chicken, 100g rice" into two items with gram amounts', async () => {
    const items = await new GemmaClient().interpretTextLog('250g chicken, 100g rice');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ canonicalName: 'chicken', amountG: 250, amountMl: null });
    expect(items[1]).toMatchObject({ canonicalName: 'rice', amountG: 100, amountMl: null });
  });

  it('parses ml amounts as milliliters', async () => {
    const items = await new GemmaClient().interpretTextLog('200 ml milk');
    expect(items).toHaveLength(1);
    expect(items[0].canonicalName).toBe('milk');
    expect(items[0].amountG).toBeNull();
    expect(items[0].amountMl).toBe(200);
  });

  it('parses quantity-last inputs like "chicken breast 150g"', async () => {
    const items = await new GemmaClient().interpretTextLog('chicken breast 150g');
    expect(items).toHaveLength(1);
    expect(items[0].canonicalName).toBe('chicken breast');
    expect(items[0].amountG).toBe(150);
  });

  it('handles "and" and "+" separators', async () => {
    const items = await new GemmaClient().interpretTextLog('50g oats and 20g chia + 120ml milk');
    expect(items).toHaveLength(3);
    expect(items[0].amountG).toBe(50);
    expect(items[1].amountG).toBe(20);
    expect(items[2].amountMl).toBe(120);
  });

  it('defaults to a 100g standard portion for plain names', async () => {
    const items = await new GemmaClient().interpretTextLog('apple');
    expect(items).toHaveLength(1);
    expect(items[0].canonicalName).toBe('apple');
    expect(items[0].amountG).toBe(100);
    expect(items[0].confidence).toBe(0.7);
  });

  it('returns an empty list for empty or whitespace input', async () => {
    expect(await new GemmaClient().interpretTextLog('')).toEqual([]);
    expect(await new GemmaClient().interpretTextLog('   ')).toEqual([]);
  });

  it('parses decimal quantities', async () => {
    const items = await new GemmaClient().interpretTextLog('12.5g salt');
    expect(items[0].amountG).toBe(12.5);
  });
});

describe('GemmaClient fallback label OCR parser', () => {
  it('extracts nutrition values from an English nutrition label', async () => {
    const parsed = await new GemmaClient().parseNutritionLabel(
      'Nutrition Facts\nCalories 250\nTotal Fat 8g\nCarbohydrate 30g\nProtein 10g'
    );
    expect(parsed.caloriesPer100g).toBe(250);
    expect(parsed.proteinPer100g).toBe(10);
    expect(parsed.carbsPer100g).toBe(30);
    expect(parsed.fatPer100g).toBe(8);
    expect(parsed.foodName).toBe('Scanned Label Product');
  });

  it('extracts values from a French label', async () => {
    const parsed = await new GemmaClient().parseNutritionLabel(
      'Valeurs nutritionnelles\nCalories 200\nProtéines 12\nGlucides 20\nLipides 5'
    );
    expect(parsed.caloriesPer100g).toBe(200);
    expect(parsed.proteinPer100g).toBe(12);
    expect(parsed.carbsPer100g).toBe(20);
    expect(parsed.fatPer100g).toBe(5);
  });

  it('returns zeros for an unparseable label', async () => {
    const parsed = await new GemmaClient().parseNutritionLabel('ingredients: sugar, water');
    expect(parsed.caloriesPer100g).toBe(0);
    expect(parsed.proteinPer100g).toBe(0);
    expect(parsed.carbsPer100g).toBe(0);
    expect(parsed.fatPer100g).toBe(0);
  });

  it('parses decimal values like 2.5g fat', async () => {
    const parsed = await new GemmaClient().parseNutritionLabel('Energy 152 kcal\nFat 2.5g');
    expect(parsed.caloriesPer100g).toBe(152);
    expect(parsed.fatPer100g).toBe(2.5);
  });
});