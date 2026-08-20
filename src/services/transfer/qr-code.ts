/**
 * QR-code pairing for EverydayFuel P2P transfer (spec §23: pairing code
 * "shown as text/QR"). Replaces the clunky copy-paste step of the manual
 * flow: the receiver's code is rendered as a QR image; the sender scans it
 * with the camera and the app auto-fills + auto-connects.
 *
 * Generation uses the small `qrcode` package (pure JS, no WASM/native).
 * Scanning uses the browser's built-in BarcodeDetector API (Chrome/Edge and
 * the Capacitor Android WebView) — zero extra dependencies; browsers without
 * it fall back to the manual paste path.
 */
import QRCode from 'qrcode';

/** Render a pairing code as a PNG data URL for <img src>. */
export async function renderPairingCodeAsQR(code: string): Promise<string> {
  return QRCode.toDataURL(code, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 320
  });
}

/** True when the platform can scan QR codes with the built-in detector. */
export function supportsQrScanning(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

export interface QrScanHandle {
  stop: () => void;
}

/**
 * Open the camera and scan for a QR code. `videoContainer` receives the
 * <video> element; `onDetected(code)` fires with the decoded payload
 * (resolves the promise). Rejects with a user-facing message when the
 * camera is unavailable or the platform cannot scan.
 */
export async function startQrScan(
  videoContainer: HTMLElement,
  onDetected: (code: string) => void
): Promise<QrScanHandle> {
  if (!supportsQrScanning()) {
    throw new Error('QR scanning is not supported in this browser — paste the code manually instead.');
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

  const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
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