import { describe, it, expect, afterEach } from 'vitest';
import {
  getVisionPlugin,
  stripDataUrlPrefix,
  FOOD_BARCODE_FORMATS,
  supportsBrowserBarcodeScan,
  startBrowserBarcodeScan
} from './vision-client';

const originalWindow = globalThis.window;

afterEach(() => {
  (globalThis as any).window = originalWindow;
});

describe('vision-client native plugin bridge', () => {
  it('returns null when running outside a browser (no window)', () => {
    delete (globalThis as any).window;
    expect(getVisionPlugin()).toBeNull();
  });

  it('returns null when the native VisionPlugin is absent', () => {
    (globalThis as any).window = { Capacitor: { Plugins: {} } };
    expect(getVisionPlugin()).toBeNull();
  });

  it('returns the native plugin when registered', () => {
    const stub = {
      scanBarcode: async () => ({ barcode: '5901234123457' }),
      ocrLabel: async () => ({ text: 'Energy 165 kcal' })
    };
    (globalThis as any).window = { Capacitor: { Plugins: { VisionPlugin: stub } } };
    expect(getVisionPlugin()).toBe(stub);
  });

  it('strips the data URL prefix before sending base64 to the native decoder', () => {
    expect(stripDataUrlPrefix('data:image/jpeg;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrlPrefix('data:image/png;base64,QUJD')).toBe('QUJD');
  });

  it('leaves plain base64 untouched', () => {
    expect(stripDataUrlPrefix('QUJD')).toBe('QUJD');
  });

  it('covers retail 1D formats plus QR', () => {
    expect(FOOD_BARCODE_FORMATS).toContain('ean_13');
    expect(FOOD_BARCODE_FORMATS).toContain('upc_a');
    expect(FOOD_BARCODE_FORMATS).toContain('code_128');
    expect(FOOD_BARCODE_FORMATS).toContain('qr_code');
  });
});

describe('vision-client browser scan', () => {
  it('reports no BarcodeDetector support outside a browser', () => {
    expect(supportsBrowserBarcodeScan()).toBe(false);
  });

  it('fails gracefully when scanning is not supported', async () => {
    const container = { appendChild: () => {} } as unknown as HTMLElement;
    await expect(startBrowserBarcodeScan(container, () => {})).rejects.toThrow(/not supported/i);
  });
});