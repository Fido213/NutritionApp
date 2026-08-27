/**
 * Scanner flows (spec §7.3/§7.4): barcode lookup (local → Open Food Facts →
 * label-scan fallback), nutrition-label OCR logging, native camera capture
 * and the browser live-feed fallbacks.
 */
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { showToast } from '../components/toast';
import { closeModalLayer } from '../modal-layers';
import { requestGrams, requestName } from '../dialogs';
import { calculateNutrition } from '@domain/nutrition';
import { classifyWaterSource } from '@domain/hydration';
import { refreshStateForDate } from '../app-refresh';
import { store } from '../state';
import { DEFAULT_LABEL_PRODUCT_NAME } from '@services/ai/gemma-client';
import { lookupBarcodeOnline } from '@services/barcode/online-lookup';
import { getVisionPlugin, stripDataUrlPrefix, supportsBrowserBarcodeScan, startBrowserBarcodeScan } from '@services/vision/vision-client';
import type { ScanHandle } from '@services/vision/vision-client';
import { ctx } from '../context';
import { invalidateIndexCaches } from './index-screen';

/**
 * Spec §7.4 fallback chain: the barcode is missing from the local library,
 * so try the optional internet lookup (Open Food Facts). When it succeeds the
 * product is logged and saved locally for future scans; when the device is
 * offline or the product is not found online, fall back to scanning the
 * nutrition label (never silent manual entry).
 */
async function logBarcodeViaOnlineLookup(code: string) {
  const date = store.getState().selectedDate;
  showToast('Not in library — checking online…');

  const product = await lookupBarcodeOnline(code);
  if (product) {
    // HANDOVER §5a item 8: the grams the user enters are what THEY ate.
    const grams = await requestGrams(
      'How many grams did you eat?',
      `${product.productName} · ${Math.round(product.caloriesPer100g)} kcal per 100g`
    );
    if (grams === null) {
      showToast('Cancelled — nothing logged');
      return null;
    }
    try {
      const result = await ctx.foodService.logBarcodeLookup(date, product, code, grams);
      await ctx.barcodeRepo.saveBarcode(result.food.id, code, 'online');
      ctx.foodCache.delete(result.food.id);
      invalidateIndexCaches();
      await ctx.dbManager.saveWebStore();
      closeModalLayer('scanner-modal');
      await refreshStateForDate(date);
      showToast(`Logged "${product.productName}" · ${Math.round(result.nutrition.calories)} kcal`);
      return { id: result.food.id, canonical_name: product.productName };
    } catch (err) {
      console.error('Online barcode logging failed:', err);
      showToast('Could not save that product — scan the label instead');
      void triggerLabelScanFallback();
      return null;
    }
  }

  // Keep scanner open for fallback — don't close before triggering label scan
  showToast('Barcode not found online — scan the nutrition label instead');
  void triggerLabelScanFallback();
  return null;
}

/** Look up a barcode in the local library and log the product at the eaten amount. */
async function logBarcodeFood(code: string) {
  const food = await ctx.barcodeRepo.lookupBarcode(code);
  if (!food) return logBarcodeViaOnlineLookup(code);

  const ref = ctx.foodRepo.toFoodReference(food);

  // HANDOVER §5a item 8: the grams the user enters are what THEY ate.
  const per100 = food.calories_per_100g != null ? `${Math.round(food.calories_per_100g)} kcal` : 'no calories listed';
  const grams = await requestGrams(
    'How many grams did you eat?',
    `${food.canonical_name} · ${per100} per 100g`
  );
  if (grams === null) {
    showToast('Cancelled — nothing logged');
    return null;
  }

  try {
    const nutrition = calculateNutrition(ref, grams);
    const date = store.getState().selectedDate;

    const log = await ctx.logRepo.insertFoodLog({
      date,
      food_id: food.id,
      amount_g: grams,
      calories: nutrition.calories,
      protein_g: nutrition.proteinG,
      carbs_g: nutrition.carbsG,
      fat_g: nutrition.fatG,
      water_ml: nutrition.waterMl
    });

    if (nutrition.waterMl !== null && nutrition.waterMl > 0) {
      await ctx.waterRepo.insertWaterLog({
        date,
        amount_ml: nutrition.waterMl,
        source: classifyWaterSource(ref),
        food_log_id: log.id
      });
    }

    await ctx.dbManager.saveWebStore();
    closeModalLayer('scanner-modal');
    await refreshStateForDate(date);
    showToast(`Logged ${food.canonical_name} · ${Math.round(nutrition.calories)} kcal`);
    return food;
  } catch (err) {
    console.error('Local barcode logging failed:', err);
    showToast('Could not log that barcode — try again');
    return null;
  }
}

/**
 * Run the shared label-text pipeline (parse → interpret → log) on OCR'd text.
 * When `askGrams` is set (camera/gallery scans) the user is asked how many
 * grams they ate; the dev-only paste-text path keeps its own amount field.
 */
async function logLabelOcrText(text: string, amount: number, askGrams = true) {
  let ocr: any;
  try {
    ocr = await ctx.gemmaClient.parseNutritionLabel(text);
  } catch (err) {
    console.error('Label parse failed:', err);
    showToast('Could not parse that label text');
    return;
  }
  const date = store.getState().selectedDate;

  // HANDOVER §5a item 7: never log the "Scanned Label Product" placeholder —
  // use the name read from the label text, or ask the user for one.
  if (!ocr.foodName || ocr.foodName === DEFAULT_LABEL_PRODUCT_NAME) {
    const name = await requestName(
      'Name this product',
      "We couldn't read the product name from the label — what is it?"
    );
    if (name === null) {
      showToast('Cancelled — nothing logged');
      return;
    }
    ocr.foodName = name;
  }

  let grams = amount;
  if (askGrams) {
    const per100 = ocr.caloriesPer100g != null ? `${Math.round(ocr.caloriesPer100g)} kcal` : 'no calories listed';
    const g = await requestGrams(
      'How many grams did you eat?',
      `${ocr.foodName} · ${per100} per 100g`
    );
    if (g === null) {
      showToast('Cancelled — nothing logged');
      return;
    }
    grams = g;
  } else {
    // Paste path validates amount explicitly
    if (!(grams > 0)) {
      showToast('Enter a positive amount in grams');
      return;
    }
  }

  try {
    const result = await ctx.foodService.logLabelOcr(date, ocr, grams);
    if (result.food?.id) ctx.foodCache.delete(result.food.id);
    invalidateIndexCaches();
    await ctx.dbManager.saveWebStore();
    closeModalLayer('scanner-modal');
    await refreshStateForDate(date);
    showToast(`Logged "${ocr.foodName}" · ${Math.round(result.nutrition.calories)} kcal`);
  } catch (err) {
    console.error('Label OCR logging failed:', err);
    showToast('Could not parse that label text');
  }
}

/**
 * Capture a photo (camera or an existing gallery image) via the system
 * chooser; returns a content URI or null when cancelled. Gallery picks keep
 * the saved-photo OCR/barcode paths reachable in the APK (the browser-only
 * `#ai-file-input` path is otherwise dead code on native).
 */
async function capturePhotoUri(): Promise<string | null> {
  try {
    const photo = await Camera.getPhoto({
      quality: 90,
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      correctOrientation: true
    });
    return (photo as any).path || (photo as any).webPath || null;
  } catch (err: any) {
    if (err && typeof err.message === 'string' && err.message.toLowerCase().includes('cancel')) {
      return null;
    }
    throw err;
  }
}

function stopLiveScan(handle: ScanHandle | null) {
  if (handle) {
    handle.stop();
    const container = document.getElementById('barcode-scan-container');
    if (container) container.style.display = 'none';
  }
}

/**
 * Native label scan: camera/gallery capture -> ML Kit OCR -> interpret + log.
 * Returns true when the flow started (photo taken and processed).
 */
async function scanLabelFromScanner(): Promise<boolean> {
  const plugin = getVisionPlugin();
  if (!plugin) return false;

  try {
    const path = await capturePhotoUri();
    if (!path) return false;
    const result = await plugin.ocrLabel({ imagePath: path });
    const text = (result.text || '').trim();
    if (!text) {
      showToast('No label text found in the photo — paste it below instead');
      return false;
    }
    await logLabelOcrText(text, 100);
    return true;
  } catch (err) {
    console.error('Label OCR failed:', err);
    showToast('Label scan failed — paste the label text below instead');
    return false;
  }
}

/** Kick off the label-scan fallback (native capture, or the file picker on web). */
async function triggerLabelScanFallback() {
  const didScan = await scanLabelFromScanner().catch(() => false);
  if (!didScan && !getVisionPlugin()) {
    document.getElementById('ai-file-input')?.click();
  }
}

export function setupScannerHandlers() {
  const barcodeInput = document.getElementById('barcode-input') as HTMLInputElement | null;
  let liveScan: ScanHandle | null = null;

  const doBarcodeLookup = async () => {
    const code = (barcodeInput?.value || '').trim();
    if (!code) {
      showToast('Enter a barcode number first');
      return;
    }
    stopLiveScan(liveScan);
    liveScan = null;
    const food = await logBarcodeFood(code);
    if (food && barcodeInput) barcodeInput.value = '';
  };

  const doBarcodeScan = async () => {
    const plugin = getVisionPlugin();

    if (plugin) {
      // Native ML Kit: camera capture → decode on-device
      try {
        const path = await capturePhotoUri();
        if (!path) return;
        const result = await plugin.scanBarcode({ imagePath: path });
        if (!result.barcode) {
          showToast('No barcode found in the photo — try again or type the number');
          return;
        }
        const food = await logBarcodeFood(result.barcode);
        if (food && barcodeInput) barcodeInput.value = '';
      } catch (err) {
        console.error('Barcode scan failed:', err);
        showToast('Barcode scan failed — type the number instead');
      }
      return;
    }

    if (supportsBrowserBarcodeScan()) {
      // Browser fallback: live BarcodeDetector feed inside the scanner modal
      const container = document.getElementById('barcode-scan-container');
      if (!container) return;
      stopLiveScan(liveScan);
      container.style.display = 'block';
      try {
        liveScan = await startBrowserBarcodeScan(container, async (code) => {
          stopLiveScan(liveScan);
          liveScan = null;
          await logBarcodeFood(code);
        });
      } catch (err) {
        container.style.display = 'none';
        showToast(err instanceof Error ? err.message : 'Could not start the camera.');
      }
      return;
    }

    showToast('Camera scanning needs the native app — type the barcode number instead');
    barcodeInput?.focus();
  };

  const doLabelScan = async () => {
    if (await scanLabelFromScanner()) return;

    // Browser: file picker (native APK also keeps this as a gallery path)
    document.getElementById('ai-file-input')?.click();
  };

  document.getElementById('btn-scan-barcode')?.addEventListener('click', doBarcodeScan);
  document.getElementById('btn-decode-barcode')?.addEventListener('click', () => { void doBarcodeLookup(); });
  barcodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doBarcodeLookup();
  });

  document.getElementById('btn-close-scanner')?.addEventListener('click', () => {
    stopLiveScan(liveScan);
    liveScan = null;
  });

  document.getElementById('btn-decode-label')?.addEventListener('click', doLabelScan);

  document.getElementById('ai-file-input')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) return;

    const plugin = getVisionPlugin();
    if (!plugin) {
      showToast('Image label OCR needs the native ML Kit integration — paste the label text below instead');
      return;
    }

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(stripDataUrlPrefix(String(reader.result || '')));
        reader.onerror = () => reject(new Error('Could not read the selected image'));
        reader.readAsDataURL(file);
      });
      const result = await plugin.ocrLabel({ imageBase64: base64 });
      const text = (result.text || '').trim();
      if (!text) {
        showToast('No label text found in the image — paste it below instead');
        return;
      }
      await logLabelOcrText(text, 100);
    } catch (err) {
      console.error('Label OCR failed:', err);
      showToast('Label scan failed — paste the label text below instead');
    }
  });

  document.getElementById('btn-parse-label-text')?.addEventListener('click', async () => {
    const textEl = document.getElementById('label-ocr-text') as HTMLTextAreaElement | null;
    const amountEl = document.getElementById('label-amount') as HTMLInputElement | null;
    const text = (textEl?.value || '').trim();
    const amount = parseFloat(amountEl?.value || '') || 100;

    if (!text) {
      showToast('Paste nutrition label text first');
      return;
    }

    // Dev-only path (never shipped): the paste-text area keeps its own amount field.
    await logLabelOcrText(text, amount, false);
    if (textEl) textEl.value = '';
  });
}
