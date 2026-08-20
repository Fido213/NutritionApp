import { describe, it, expect } from 'vitest';
import { renderPairingCodeAsQR, supportsQrScanning, startQrScan } from './qr-code';

describe('qr-code pairing helpers', () => {
  it('renders a pairing code as a PNG data URL', async () => {
    const dataUrl = await renderPairingCodeAsQR('everydayfuel-pairing:demo-code-123');
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(200);
  });

  it('renders long pairing-code payloads (large SDP)', async () => {
    const big = 'code:' + 'a'.repeat(2400);
    const dataUrl = await renderPairingCodeAsQR(big);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects payloads too large for a scannable QR code', async () => {
    await expect(renderPairingCodeAsQR('code:' + 'a'.repeat(4000))).rejects.toThrow();
  });

  it('reports no native scanning support outside a browser', () => {
    expect(supportsQrScanning()).toBe(false);
  });

  it('fails gracefully when scanning is not supported', async () => {
    const container = { appendChild: () => {} } as unknown as HTMLElement;
    await expect(startQrScan(container, () => {})).rejects.toThrow(/not supported/i);
  });
});