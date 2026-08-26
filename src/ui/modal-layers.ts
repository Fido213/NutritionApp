/**
 * Modal ↔ navigation-layer bridge: opening a modal pushes one history entry,
 * so Android BACK / swipe-back closes it instead of leaving the app.
 * `onClosed` runs for BOTH paths (BACK or programmatic close) so pending
 * prompt promises always settle.
 */
import { pushLayer, closeLayer } from './nav';

export function openModalLayer(id: string, onClosed?: () => void) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  pushLayer(() => {
    el.classList.remove('active');
    onClosed?.();
  });
}

export function closeModalLayer(id: string) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('active')) return;
  el.classList.remove('active');
  // The registered layer close re-runs hide + onClosed; hiding twice is safe.
  closeLayer();
}
