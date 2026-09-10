/**
 * Boot/loading card: staged modal over startup or cold-submit jank windows.
 * Pure DOM construction (no listeners, no state) so any feature can show
 * one around awaited work and always remove it afterwards.
 */
export interface LoadingCard {
  setStage: (label: string, done?: number, total?: number) => void;
  done: () => void;
}

/** Staged card: determinate bar while counts are reported, pulsing otherwise. */
export function createBootOverlay(): LoadingCard {
  const overlay = document.createElement('div');
  overlay.id = 'boot-progress';
  overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,12,16,0.94);z-index:9999;';
  overlay.innerHTML =
    '<style>@keyframes bootpulse { 0%,100% { opacity: 0.45; } 50% { opacity: 1; } }</style>' +
    '<div style="width:min(320px,84vw);background:var(--surface,#161b22);border:1px solid var(--border,#2a3139);border-radius:16px;padding:24px 20px;text-align:center;">' +
    '<div style="font-size:17px;font-weight:700;margin-bottom:4px;">EverydayFuel</div>' +
    '<div id="boot-progress-label" style="font-size:12px;color:var(--text-dim,#8b949e);margin-bottom:14px;min-height:16px;"></div>' +
    '<div style="height:8px;border-radius:99px;background:var(--surface-light,#21262d);overflow:hidden;">' +
    '<div id="boot-progress-bar" style="height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,#2ea043,#3fb950);transition:width 0.2s;animation:bootpulse 1.2s ease-in-out infinite;"></div></div></div>';
  document.body.appendChild(overlay);
  const bar = overlay.querySelector('#boot-progress-bar') as HTMLElement | null;
  const label = overlay.querySelector('#boot-progress-label') as HTMLElement | null;
  return {
    setStage(text: string, done?: number, total?: number) {
      if (label) label.textContent = text;
      if (bar) {
        if (done !== undefined && total) {
          bar.style.animation = 'none';
          bar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
        } else {
          bar.style.animation = '';
          bar.style.width = '100%';
        }
      }
    },
    done() { overlay.remove(); },
  };
}
