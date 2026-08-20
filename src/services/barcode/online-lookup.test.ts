import { describe, it, expect } from 'vitest';
import { lookupBarcodeOnline, OPEN_FOOD_FACTS_BASE } from './online-lookup';

function offResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

describe('lookupBarcodeOnline', () => {
  it('parses a product with kcal nutrition data', async () => {
    const fetchImpl: any = async (url: string) => {
      expect(String(url)).toContain(`${OPEN_FOOD_FACTS_BASE}/3017620422003.json`);
      return offResponse({
        status: 1,
        product: {
          product_name: 'Nutella',
          nutriments: {
            'energy-kcal_100g': 539,
            'proteins_100g': 6.3,
            'carbohydrates_100g': 57.5,
            'fat_100g': 30.9
          }
        }
      });
    };

    const product = await lookupBarcodeOnline('3017620422003', { fetchImpl });
    expect(product).toEqual({
      productName: 'Nutella',
      caloriesPer100g: 539,
      proteinPer100g: 6.3,
      carbsPer100g: 57.5,
      fatPer100g: 30.9
    });
  });

  it('converts kJ-only energy to kcal', async () => {
    const fetchImpl: any = async () =>
      offResponse({
        status: 1,
        product: {
          product_name: 'Drink',
          nutriments: { energy_100g: 500, proteins_100g: 1, carbohydrates_100g: 10, fat_100g: 2 }
        }
      });

    const product = await lookupBarcodeOnline('1234567890123', { fetchImpl });
    expect(product?.caloriesPer100g).toBe(119.5); // 500 kJ / 4.184
  });

  it('falls back to the English product name', async () => {
    const fetchImpl: any = async () =>
      offResponse({
        status: 1,
        product: { product_name: null, product_name_en: 'Some Product', nutriments: { 'energy-kcal_100g': 100 } }
      });

    const product = await lookupBarcodeOnline('1234567890123', { fetchImpl });
    expect(product?.productName).toBe('Some Product');
  });

  it('returns null when the product does not exist', async () => {
    const fetchImpl: any = async () => offResponse({ status: 0, status_verbose: 'product not found', product: null });
    expect(await lookupBarcodeOnline('0000000000000', { fetchImpl })).toBeNull();
  });

  it('returns null when the payload has no product object', async () => {
    const fetchImpl: any = async () => offResponse({ status: 1 });
    expect(await lookupBarcodeOnline('1234567890123', { fetchImpl })).toBeNull();
  });

  it('returns null when the product has no nutrition data at all', async () => {
    const fetchImpl: any = async () =>
      offResponse({ status: 1, product: { product_name: 'Diagnostic Test Product', nutriments: {} } });
    expect(await lookupBarcodeOnline('4006381333931', { fetchImpl })).toBeNull();
  });

  it('accepts zero-calorie products that still carry nutrition data', async () => {
    const fetchImpl: any = async () =>
      offResponse({
        status: 1,
        product: { product_name: 'Diet Drink', nutriments: { 'energy-kcal_100g': 0, 'carbohydrates_100g': 0 } }
      });

    const product = await lookupBarcodeOnline('1234567890123', { fetchImpl });
    expect(product?.caloriesPer100g).toBe(0);
  });

  it('returns null on network failure', async () => {
    const fetchImpl: any = async () => {
      throw new TypeError('Network request failed');
    };
    expect(await lookupBarcodeOnline('1234567890123', { fetchImpl })).toBeNull();
  });

  it('returns null on non-OK HTTP responses', async () => {
    const fetchImpl: any = async () => ({ ok: false, status: 404 }) as Response;
    expect(await lookupBarcodeOnline('1234567890123', { fetchImpl })).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const fetchImpl: any = async () =>
      ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) as unknown as Response;
    expect(await lookupBarcodeOnline('1234567890123', { fetchImpl })).toBeNull();
  });

  it('returns null for malformed or non-numeric barcodes without calling the API', async () => {
    let called = false;
    const fetchImpl: any = async () => {
      called = true;
      throw new Error('should not be called');
    };
    expect(await lookupBarcodeOnline('abc', { fetchImpl })).toBeNull();
    expect(await lookupBarcodeOnline('', { fetchImpl })).toBeNull();
    expect(await lookupBarcodeOnline('12345', { fetchImpl })).toBeNull();
    expect(called).toBe(false);
  });

  it('aborts the request after the timeout', async () => {
    let aborted = false;
    const fetchImpl: any = async (_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('AbortError'));
        });
      });

    const product = await lookupBarcodeOnline('1234567890123', { fetchImpl, timeoutMs: 10 });
    expect(product).toBeNull();
    expect(aborted).toBe(true);
  });

  it('ignores non-numeric or negative nutrient values', async () => {
    const fetchImpl: any = async () =>
      offResponse({
        status: 1,
        product: {
          product_name: 'Weird Product',
          nutriments: {
            'energy-kcal_100g': '539',
            'proteins_100g': -2,
            'carbohydrates_100g': NaN,
            'fat_100g': 5.55
          }
        }
      });

    const product = await lookupBarcodeOnline('1234567890123', { fetchImpl });
    expect(product).toEqual({
      productName: 'Weird Product',
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 5.6
    });
  });
});