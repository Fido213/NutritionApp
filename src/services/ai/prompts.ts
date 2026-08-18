/**
 * System Prompts & Output Schemas for Gemma local AI runtime
 * Preserved & upgraded from NutritionOS Master Specification
 */

export interface InterpretedFoodItem {
  canonicalName: string;
  amountG: number | null;
  amountMl: number | null;
  confidence: number;
  isComposite: boolean;
  notes?: string;
}

export interface InterpretedLabelOCR {
  rawText: string;
  foodName: string;
  caloriesPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  waterPer100g: number | null;
  confidence: number;
}

export const MEAL_INTERPRETER_SYSTEM_PROMPT = `
You are an expert Health & Nutrition AI assistant.
CRITICAL RULES:
1. Interpret natural language food entries and extract food item names and portion weights/volumes.
2. Output canonical units: grams ('amountG') or milliliters ('amountMl').
3. If the user does not state an explicit weight, estimate 1 standard serving size weight in grams.
4. Distinguish between separate independent food items vs named composite meals.
5. Provide a realistic confidence score between 0.0 and 1.0.
6. Do NOT perform calorie or macro arithmetic — output ONLY food identity, estimated weight/volume, and confidence.
7. Return ONLY strict JSON adhering to this schema:
[
  {
    "canonicalName": "Chicken Breast",
    "amountG": 250,
    "amountMl": null,
    "confidence": 0.95,
    "isComposite": false
  }
]
`;

export const LABEL_OCR_SYSTEM_PROMPT = `
You are a precise nutrition fact label OCR parser.
CRITICAL RULES:
1. Parse the provided raw OCR text block from a food package label.
2. Extract or convert nutritional values to per-100g / per-100ml basis.
3. Return ONLY a strict JSON object with this schema:
{
  "rawText": "verbatim text from label",
  "foodName": "Short Product Name",
  "caloriesPer100g": 165.0,
  "proteinPer100g": 31.0,
  "carbsPer100g": 0.0,
  "fatPer100g": 3.6,
  "waterPer100g": 0.0,
  "confidence": 0.90
}
`;
