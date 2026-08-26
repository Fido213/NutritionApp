/**
 * In-app dialog modals (WebView-safe replacements for window.prompt/confirm).
 * Each requestX opens its modal as a navigation layer and returns a promise
 * that settles with the entered value — or null/false when cancelled via
 * BACK, programmatic close, or the cancel button. `onClosed` runs for both
 * paths so pending promises never hang.
 */
import { openModalLayer, closeModalLayer } from './modal-layers';

let passwordPromptResolver: ((value: string | null) => void) | null = null;
let confirmPromptResolver: ((value: boolean) => void) | null = null;
let gramsPromptResolver: ((value: number | null) => void) | null = null;
let namePromptResolver: ((value: string | null) => void) | null = null;
let pwRequireConfirm = false;

export function setupDialogModals() {
  document.getElementById('btn-pw-ok')?.addEventListener('click', () => {
    const pwEl = document.getElementById('pw-input') as HTMLInputElement | null;
    const confirmEl = document.getElementById('pw-confirm') as HTMLInputElement | null;
    const errorEl = document.getElementById('pw-error');
    const pw = pwEl?.value || '';

    if (!pw) {
      if (errorEl) errorEl.innerText = 'Password must not be empty';
      return;
    }
    if (pwRequireConfirm && confirmEl && confirmEl.value !== pw) {
      if (errorEl) errorEl.innerText = 'Passwords do not match';
      return;
    }

    passwordPromptResolver?.(pw);
    closeModalLayer('password-modal');
  });

  document.getElementById('btn-pw-cancel')?.addEventListener('click', () => {
    closeModalLayer('password-modal');
  });

  document.getElementById('pw-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (pwRequireConfirm) {
      (document.getElementById('pw-confirm') as HTMLInputElement | null)?.focus();
    } else {
      (document.getElementById('btn-pw-ok') as HTMLButtonElement | null)?.click();
    }
  });

  document.getElementById('pw-confirm')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('btn-pw-ok') as HTMLButtonElement | null)?.click();
  });

  document.getElementById('btn-confirm-ok')?.addEventListener('click', () => {
    confirmPromptResolver?.(true);
    closeModalLayer('confirm-modal');
  });

  document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => {
    closeModalLayer('confirm-modal');
  });

  // Grams modal (label + barcode scans — HANDOVER §5a item 8)
  document.getElementById('btn-grams-ok')?.addEventListener('click', () => {
    const input = document.getElementById('grams-input') as HTMLInputElement | null;
    const errorEl = document.getElementById('grams-error');
    const value = parseFloat(input?.value || '');
    if (!(value > 0)) {
      if (errorEl) errorEl.innerText = 'Enter a positive amount';
      return;
    }
    gramsPromptResolver?.(value);
    closeModalLayer('grams-modal');
  });

  document.getElementById('btn-grams-cancel')?.addEventListener('click', () => {
    closeModalLayer('grams-modal');
  });

  document.getElementById('grams-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('btn-grams-ok') as HTMLButtonElement | null)?.click();
  });

  // Name modal (label scan when the product name can't be read — item 7)
  document.getElementById('btn-name-ok')?.addEventListener('click', () => {
    const input = document.getElementById('name-input') as HTMLInputElement | null;
    const errorEl = document.getElementById('name-error');
    const value = input?.value.trim() || '';
    if (!value) {
      if (errorEl) errorEl.innerText = 'Name must not be empty';
      return;
    }
    namePromptResolver?.(value);
    closeModalLayer('name-modal');
  });

  document.getElementById('btn-name-cancel')?.addEventListener('click', () => {
    closeModalLayer('name-modal');
  });

  document.getElementById('name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (document.getElementById('btn-name-ok') as HTMLButtonElement | null)?.click();
  });
}

export function requestPassword(title: string, requireConfirm: boolean): Promise<string | null> {
  pwRequireConfirm = requireConfirm;

  const titleEl = document.getElementById('pw-title');
  const pwEl = document.getElementById('pw-input') as HTMLInputElement | null;
  const confirmEl = document.getElementById('pw-confirm') as HTMLInputElement | null;
  const errorEl = document.getElementById('pw-error');

  if (titleEl) titleEl.innerText = title;
  if (pwEl) pwEl.value = '';
  if (confirmEl) {
    confirmEl.value = '';
    confirmEl.hidden = !requireConfirm;
  }
  if (errorEl) errorEl.innerText = '';

  openModalLayer('password-modal', () => {
    const resolve = passwordPromptResolver;
    passwordPromptResolver = null;
    resolve?.(null);
  });
  pwEl?.focus();

  return new Promise(resolve => { passwordPromptResolver = resolve; });
}

export function requestConfirmation(title: string, message: string): Promise<boolean> {
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;

  openModalLayer('confirm-modal', () => {
    const resolve = confirmPromptResolver;
    confirmPromptResolver = null;
    resolve?.(false);
  });
  return new Promise(resolve => { confirmPromptResolver = resolve; });
}

/** Ask how many grams the user actually ate (per-100g values are scaled to it). */
export function requestGrams(title: string, sub: string, defaultValue = 100): Promise<number | null> {
  const titleEl = document.getElementById('grams-title');
  const subEl = document.getElementById('grams-sub');
  const input = document.getElementById('grams-input') as HTMLInputElement | null;
  const errorEl = document.getElementById('grams-error');

  if (titleEl) titleEl.innerText = title;
  if (subEl) subEl.innerText = sub;
  if (input) input.value = String(defaultValue);
  if (errorEl) errorEl.innerText = '';

  openModalLayer('grams-modal', () => {
    const resolve = gramsPromptResolver;
    gramsPromptResolver = null;
    resolve?.(null);
  });
  input?.focus();
  if (input) input.select();

  return new Promise(resolve => { gramsPromptResolver = resolve; });
}

/** Ask the user for a product name when the label text doesn't reveal one. */
export function requestName(title: string, sub: string, defaultValue = ''): Promise<string | null> {
  const titleEl = document.getElementById('name-title');
  const subEl = document.getElementById('name-sub');
  const input = document.getElementById('name-input') as HTMLInputElement | null;
  const errorEl = document.getElementById('name-error');

  if (titleEl) titleEl.innerText = title;
  if (subEl) subEl.innerText = sub;
  if (input) input.value = defaultValue;
  if (errorEl) errorEl.innerText = '';

  openModalLayer('name-modal', () => {
    const resolve = namePromptResolver;
    namePromptResolver = null;
    resolve?.(null);
  });
  input?.focus();

  return new Promise(resolve => { namePromptResolver = resolve; });
}
