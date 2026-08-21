/**
 * In-app navigation stack (HANDOVER §5b item 3).
 *
 * The Android hardware back button / gesture drives WebView history. Every UI
 * layer (tab switch, edit screen, open modal) pushes exactly one history
 * entry, so BACK pops layers LIFO inside the app instead of exiting; only the
 * base layer exits (standard Android behaviour).
 */

export type ViewId = 'today' | 'history' | 'view-goals';

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

/* ---------------- Tab switching with swipe support ---------------- */

export interface TabController {
  /** User-initiated switch: pushes a history layer so BACK returns here. */
  switchTab(viewId: ViewId): void;
  /** Programmatic restore (e.g. closing the edit screen): no history entry. */
  switchTabDirect(viewId: ViewId): void;
  currentView(): ViewId;
}

const TAB_ORDER: ViewId[] = ['today', 'history', 'view-goals'];

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
