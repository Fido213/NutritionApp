/**
 * Vision input client (spec §7): bridges the web layer to the native ML Kit
 * plugin and provides a browser-side live-scan fallback via the built-in
 * BarcodeDetector API (same zero-dependency approach as the QR pairing scan).
 *
 * Native path (Android APK):
 *   camera capture / file picker → image → VisionPlugin.scanBarcode / ocrLabel
 *
 * Browser path (npm run dev):
 *   BarcodeDetector live video scan for barcodes; label OCR falls back to the
 *   paste-text flow (the native plugin does not exist in a plain browser).
 *
 * Barcodes are identifiers only — nutrition data always comes from the local
 * product record or the scanned label (spec §7.4).
 */

export interface VisionPluginApi {
  scanBarcode(opts: {
    imagePath?: string;
    imageBase64?: string;
  }): Promise<{ barcode: string | null; format?: number | null }>;
  ocrLabel(opts: {
    imagePath?: string;
    imageBase64?: string;
  }): Promise<{ text: string }>;
}

/** The native Capacitor ML Kit plugin, or null when running in a plain browser. */
export function getVisionPlugin(): VisionPluginApi | null {
  if (typeof window !== 'undefined' && (window as any).Capacitor?.Plugins?.VisionPlugin) {
    return (window as any).Capacitor.Plugins.VisionPlugin as VisionPluginApi;
  }
  return null;
}

/** Strip a `data:image/...;base64,` prefix so only raw base64 reaches the native decoder. */
export function stripDataUrlPrefix(dataUrl: string): string {
  if (/^data:[^,]+;base64/i.test(dataUrl)) {
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  }
  return dataUrl;
}

/** 1D retail codes plus QR (QR kept so the P2P code still scans through this path). */
export const FOOD_BARCODE_FORMATS = [
  'qr_code',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'codabar',
  'data_matrix'
] as const;

export interface ScanHandle {
  stop: () => void;
}

/** True when the browser can run a live camera scan with the built-in detector. */
export function supportsBrowserBarcodeScan(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

/**
 * Live camera barcode scan for browsers with BarcodeDetector (the Android
 * WebView ships Chromium, so this also works inside the APK). `onDetected`
 * fires once with the raw value; the returned handle stops the camera.
 * Rejects with a user-facing message when unsupported or the camera is denied.
 */
export async function startBrowserBarcodeScan(
  videoContainer: HTMLElement,
  onDetected: (barcode: string) => void
): Promise<ScanHandle> {
  if (!supportsBrowserBarcodeScan()) {
    throw new Error('Barcode scanning is not supported in this browser — type the number instead.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }
  });
  if (!stream) throw new Error('Could not access the camera.');

  const video = document.createElement('video');
  video.style.width = '100%';
  video.style.maxHeight = '280px';
  video.style.borderRadius = '12px';
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  video.muted = true;
  video.srcObject = stream;
  videoContainer.appendChild(video);

  await video.play().catch(() => { /* muted autoplay is normally allowed */ });

  const detector = new (window as any).BarcodeDetector({ formats: [...FOOD_BARCODE_FORMATS] });
  let stopped = false;
  let frame = 0;

  const loop = async () => {
    if (stopped) return;
    frame++;
    // Detect every ~4th frame so decoding doesn't starve the video pipeline.
    if (frame % 4 === 0 && video.readyState >= 2) {
      try {
        const codes = await detector.detect(video);
        const code = codes?.find((c: any) => typeof c?.rawValue === 'string' && c.rawValue);
        if (code) {
          onDetected(code.rawValue);
          return;
        }
      } catch {
        /* transient detection errors are ignored */
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const stop = () => {
    stopped = true;
    stream.getTracks().forEach(t => t.stop());
    video.remove();
  };

  return { stop };
}