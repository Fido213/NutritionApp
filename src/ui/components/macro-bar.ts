/**
 * Macro Progress Bar Component
 */

export function renderMacroBar(
  barId: string,
  textId: string,
  deltaId: string,
  current: number,
  target: number,
  unit: string = 'g',
  isProtein: boolean = false
) {
  const barEl = document.getElementById(barId);
  const textEl = document.getElementById(textId);
  const deltaEl = document.getElementById(deltaId);

  if (!barEl || !textEl) return;

  const ratio = target > 0 ? current / target : 0;
  const pct = Math.round(ratio * 100);

  textEl.innerText = `${Math.round(current)} / ${target}${unit} (${pct}%)`;

  // Width capped at 100% for the bar element itself
  const widthPct = Math.min(ratio * 100, 100);
  barEl.style.width = `${widthPct}%`;

  // Apply glow & bleed states
  barEl.classList.remove('success', 'bleed');

  if (isProtein) {
    if (ratio >= 0.90) barEl.classList.add('success');
  } else {
    if (ratio >= 0.85 && ratio <= 1.15) barEl.classList.add('success');
    else if (ratio > 1.15) barEl.classList.add('bleed');
  }

  // Delta indicators
  if (deltaEl) {
    deltaEl.classList.remove('under', 'on-target', 'over');
    if (isProtein) {
      if (ratio < 0.90) {
        deltaEl.innerText = '↓';
        deltaEl.classList.add('under');
      } else {
        deltaEl.innerText = '✓';
        deltaEl.classList.add('on-target');
      }
    } else {
      if (ratio < 0.85) {
        deltaEl.innerText = '↓';
        deltaEl.classList.add('under');
      } else if (ratio <= 1.15) {
        deltaEl.innerText = '✓';
        deltaEl.classList.add('on-target');
      } else {
        deltaEl.innerText = '↑';
        deltaEl.classList.add('over');
      }
    }
  }
}
