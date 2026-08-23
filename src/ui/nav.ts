/**
 * In-app navigation stack (HANDOVER §5b item 3, reworked §5c-B).
 *
 * Android hardware back / predictive-back swipe is intercepted by the
 * @capacitor/app plugin's OnBackPressedCallback (Capacitor 8 core registers
 * NO back handling of its own — the History-API approach alone let the
 * gesture exit the app). When a `backButton` listener is registered the
 * native callback fires our JS handler instead of the system default.
 *
 * The History-API layer stack remains for browser/web back support: every UI
 * layer (tab switch, edit screen, open modal) pushes exactly one entry and
 * BACK pops layers LIFO inside the app; only the base layer exits (standard
 * Android behaviour).
 */
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export type ViewId = 'today' | 'index' | 'history' | 'view-goals';

interface Layer {
  close: () => void;
}

const layerStack: Layer[] = [];
let initialized = false;

/** Close the topmost layer programmatically WITHOUT popping a history entry. */
export function closeLayer() {
  const layer = layerStack.pop();
  if (layer) {
    if (history.state?.depth === layerStack.length + 1) {
      // Keep history state in sync when a layer closes itself (save/cancel).
      suppressNextPop = true;
      history.back();
    }
    layer.close();
  }
}

let suppressNextPop = false;

/** Push a layer: one history entry; BACK runs `close`. */
export function pushLayer(close: () => void) {
  if (!initialized) return;
  layerStack.push({ close });
  history.pushState({ depth: layerStack.length }, '');
}

function setupPopHandler() {
  window.addEventListener('popstate', () => {
    if (suppressNextPop) {
      suppressNextPop = false;
      return;
    }
    const layer = layerStack.pop();
    if (layer) layer.close();
  });
}

export function initNavStack() {
  if (initialized) return;
  initialized = true;
  history.replaceState({ depth: 0 }, '');
  setupPopHandler();
}

/**
 * Native back-button wiring (§5c item 7 / §5c-B): with a listener registered,
 * the plugin intercepts hardware back AND predictive-back swipes and hands
 * them to the layer stack; at the base layer the app exits as usual.
 */
export async function initNativeBackButton() {
  try {
    if (!Capacitor.isNativePlatform()) return;
    await App.addListener('backButton', () => {
      if (layerStack.length > 0) {
        closeLayer();
      } else {
        App.exitApp();
      }
    });
  } catch (err) {
    console.warn('Native backButton wiring failed:', err);
  }
}

/* ---------------- Tab switching with swipe support ---------------- */

export interface TabController {
  /** User-initiated switch: pushes a history layer so BACK returns here. */
  switchTab(viewId: ViewId): void;
  /** Programmatic restore (e.g. closing the edit screen): no history entry. */
  switchTabDirect(viewId: ViewId): void;
  currentView(): ViewId;
}

const TAB_ORDER: ViewId[] = ['today', 'index', 'history'];

/** Direction-aware entrance animation for tab switches / screen changes (§5c-7). */
export function animateViewIn(el: HTMLElement | null, direction: 'left' | 'right' | 'up') {
  if (!el) return;
  const cls = direction === 'left' ? 'view-enter-left' : direction === 'up' ? 'view-enter-up' : 'view-enter-right';
  el.classList.remove('view-enter-left', 'view-enter-right', 'view-enter-up');
  // Force a reflow so re-applying the class restarts the animation.
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), 260);
}

export function tabDirection(from: ViewId, to: ViewId): 'left' | 'right' {
  return TAB_ORDER.indexOf(to) > TAB_ORDER.indexOf(from) ? 'left' : 'right';
}

export function setupTabNavigation(
  switchTabInternal: (viewId: ViewId) => void,
  getCurrentView: () => ViewId
): TabController {
  initNavStack();

  let switching = false;
  const controller: TabController = {
    switchTab(viewId: ViewId) {
      if (switching || viewId === getCurrentView()) return;
      switching = true;
      try {
        const from = getCurrentView();
        pushLayer(() => controller.switchTabDirect(from));
        controller.switchTabDirect(viewId);
      } finally {
        switching = false;
      }
    },
    switchTabDirect(viewId: ViewId) {
      switchTabInternal(viewId);
    },
    currentView: getCurrentView
  };

  /* Swipe between tabs (§5b item 4): horizontal drag anywhere on <main>
     switches DASH ↔ LOGS ↔ GOALS. Vertical scrolling is unaffected: the
     gesture only fires when |dx| clearly dominates |dy|. */
  const main = document.getElementById('main-container');
  if (main) {
    let startX = 0, startY = 0, tracking = false;
    main.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.touches.length !== 1) { tracking = false; return; }
        if (document.querySelector('.modal.active')) { tracking = false; return; }
        if (document.body.classList.contains('edit-open')) { tracking = false; return; }
        if (document.body.classList.contains('builder-open')) { tracking = false; return; }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
      },
      { passive: true }
    );
    main.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
        const idx = TAB_ORDER.indexOf(getCurrentView());
        const nextIdx = dx < 0 ? Math.min(idx + 1, TAB_ORDER.length - 1) : Math.max(idx - 1, 0);
        controller.switchTab(TAB_ORDER[nextIdx]);
      },
      { passive: true }
    );
  }

  return controller;
}
