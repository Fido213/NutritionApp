/**
 * Native bridge for SaveFilePlugin (MediaStore Downloads).
 * The Android WebView silently drops blob-anchor downloads, so CSV/backup
 * exports route through here on native; browsers keep the anchor path.
 */

interface SaveFilePluginInterface {
  saveDownload(options: { fileName: string; base64: string; mime: string }): Promise<{ saved: boolean; uri: string }>;
}

export function getSaveFilePlugin(): SaveFilePluginInterface | null {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.Plugins?.SaveFilePlugin ?? null;
}

/** Save text content to the public Downloads folder on native. Returns false when not native or the save failed. */
export async function saveDownloadNative(fileName: string, content: string, mime: string): Promise<boolean> {
  const plugin = getSaveFilePlugin();
  if (!plugin) return false;
  try {
    const base64 = utf8ToBase64(content);
    await plugin.saveDownload({ fileName, base64, mime });
    return true;
  } catch (err) {
    console.error('saveDownload failed:', err);
    return false;
  }
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
