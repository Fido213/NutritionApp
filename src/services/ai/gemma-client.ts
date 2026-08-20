import { safeJsonParse } from '@utils/sanitize';
import { 
  MEAL_INTERPRETER_SYSTEM_PROMPT, 
  LABEL_OCR_SYSTEM_PROMPT, 
  InterpretedFoodItem, 
  InterpretedLabelOCR 
} from './prompts';

/**
 * Placeholder used when a nutrition label does not reveal a product name.
 * The UI asks the user for a real name before logging (HANDOVER §5a item 7).
 */
export const DEFAULT_LABEL_PRODUCT_NAME = 'Scanned Label Product';

const LABEL_HEADING_RE = /(?:nutrition facts|nutrition information|valeurs nutritionnelles|informations nutritionnelles|informaci[oó]n nutricional|n[aä]hrwert|valori nutrizionali)/i;
const LABEL_KEYWORD_LINE_RE = /^(?:serving size|servings?|per (?:100 ?g|100 ?ml|serving)|contains?|ingredients?|allergens?|storage|best before|net (?:weight|wt)|weight|calories?|energy|protein|carbohydrates?|carbs?|fat|sugars?|fibre|fiber|salt|sodium)/i;

export class GemmaClient {
  private isModelLoaded: boolean = false;

  constructor() {
    this.checkNativeBridge();
  }

  private checkNativeBridge() {
    // Check if native Capacitor Gemma plugin is available
    if (typeof window !== 'undefined' && (window as any).Capacitor?.Plugins?.GemmaPlugin) {
      this.isModelLoaded = true;
    }
  }

  /**
   * Interpret text food logging input (e.g., "250g chicken breast, 100g rice")
   */
  async interpretTextLog(userInput: string): Promise<InterpretedFoodItem[]> {
    if (!userInput || userInput.trim().length === 0) return [];

    if (this.isModelLoaded) {
      try {
        const prompt = `${MEAL_INTERPRETER_SYSTEM_PROMPT}\nUser Input: "${userInput}"`;
        const rawResponse = await (window as any).Capacitor.Plugins.GemmaPlugin.generateResponse({ prompt });
        const parsed = safeJsonParse<InterpretedFoodItem[]>(rawResponse.value, []);
        if (parsed.length > 0) return this.validateItems(parsed);
      } catch (err) {
        console.warn('Gemma native inference failed, resorting to fallback parser:', err);
      }
    }

    // Fallback: Deterministic Regex / Heuristic Parser
    return this.fallbackParseTextLog(userInput);
  }

  /**
   * Parse raw OCR text from nutrition fact labels
   */
  async parseNutritionLabel(ocrRawText: string): Promise<InterpretedLabelOCR> {
    if (this.isModelLoaded) {
      try {
        const prompt = `${LABEL_OCR_SYSTEM_PROMPT}\nOCR Text:\n"${ocrRawText}"`;
        const rawResponse = await (window as any).Capacitor.Plugins.GemmaPlugin.generateResponse({ prompt });
        const parsed = safeJsonParse<InterpretedLabelOCR | null>(rawResponse.value, null);
        if (parsed) return parsed;
      } catch (err) {
        console.warn('Gemma native label OCR parsing failed, resorting to regex fallback:', err);
      }
    }

    // Fallback: Deterministic Regex Label Parser (Preserved from old app index.py)
    return this.fallbackParseNutritionLabel(ocrRawText);
  }

  private validateItems(items: InterpretedFoodItem[]): InterpretedFoodItem[] {
    return items.filter(item => {
      if (!item.canonicalName || typeof item.canonicalName !== 'string') return false;
      const amt = item.amountG ?? item.amountMl ?? 0;
      return amt >= 0 && amt <= 5000;
    });
  }

  /**
   * Fallback deterministic parser for text log entries
   */
  private fallbackParseTextLog(input: string): InterpretedFoodItem[] {
    const items: InterpretedFoodItem[] = [];
    const parts = input.split(/,|and|\+/i);

    for (const part of parts) {
      const clean = part.trim();
      if (!clean) continue;

      // Match patterns like "250g chicken", "100 ml milk", "chicken breast 200g"
      const match = clean.match(/^(\d+(?:\.\d+)?)\s*(g|ml|grams|milliliters)?\s+(.+)$/i) ||
                    clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(g|ml|grams|milliliters)?$/i);

      if (match) {
        const isQtyFirst = !isNaN(parseFloat(match[1]));
        const qty = parseFloat(isQtyFirst ? match[1] : match[2]);
        const unit = (isQtyFirst ? match[2] : match[3])?.toLowerCase();
        const name = (isQtyFirst ? match[3] : match[1]).trim();

        const isMl = unit === 'ml' || unit === 'milliliters';

        items.push({
          canonicalName: name,
          amountG: isMl ? null : qty,
          amountMl: isMl ? qty : null,
          confidence: 0.9,
          isComposite: false
        });
      } else {
        items.push({
          canonicalName: clean,
          amountG: 100, // Default standard portion estimate
          amountMl: null,
          confidence: 0.7,
          isComposite: false
        });
      }
    }

    return items;
  }

  /**
   * Best-effort product name extraction from raw label OCR text (deterministic):
   * an explicit "product name:" prefix wins; otherwise the first clean line
   * before the nutrition-facts heading (typical label layout). Returns the
   * placeholder when nothing usable is found — the UI then asks the user.
   */
  private extractLabelProductName(rawText: string): string {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    const prefixed = lines.find(l => /^(?:product\s*name|product)\s*:/i.test(l));
    if (prefixed) {
      const value = prefixed.replace(/^(?:product\s*name|product)\s*:\s*/i, '');
      const clean = this.sanitizeLabelName(value);
      if (clean) return clean;
    }

    const headingIndex = lines.findIndex(l => LABEL_HEADING_RE.test(l));
    if (headingIndex > 0) {
      for (let i = 0; i < headingIndex; i++) {
        const clean = this.sanitizeLabelName(lines[i]);
        if (clean) return clean;
      }
    }

    return DEFAULT_LABEL_PRODUCT_NAME;
  }

  private sanitizeLabelName(raw: string): string {
    let name = raw
      .replace(/[“”"']/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*(?:g|ml|grams?|grammes?|millilitres?)\b/gi, ' ')
      .replace(/\s*\d+(?:\.\d+)?\s*%?\s*$/g, '')
      .trim()
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');

    if (!name || name.length < 2 || name.length > 60) return '';
    if (LABEL_KEYWORD_LINE_RE.test(name)) return '';
    return name;
  }

  /**
   * Fallback deterministic regex parser for nutrition facts label OCR
   */
  private fallbackParseNutritionLabel(rawText: string): InterpretedLabelOCR {
    const calMatch = rawText.match(/(?:calories|energy|kcal)[^\d]*(\d+(?:\.\d+)?)/i);
    const proMatch = rawText.match(/(?:protein|protéines)[^\d]*(\d+(?:\.\d+)?)/i);
    const carbMatch = rawText.match(/(?:carbohydrate|carbs|glucides)[^\d]*(\d+(?:\.\d+)?)/i);
    const fatMatch = rawText.match(/(?:fat|lipid|graisses)[^\d]*(\d+(?:\.\d+)?)/i);

    return {
      rawText,
      foodName: this.extractLabelProductName(rawText),
      caloriesPer100g: calMatch ? parseFloat(calMatch[1]) : 0,
      proteinPer100g: proMatch ? parseFloat(proMatch[1]) : 0,
      carbsPer100g: carbMatch ? parseFloat(carbMatch[1]) : 0,
      fatPer100g: fatMatch ? parseFloat(fatMatch[1]) : 0,
      waterPer100g: 0,
      confidence: 0.85
    };
  }
}
