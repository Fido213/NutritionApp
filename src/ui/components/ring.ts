/**
 * Multi-Lap Calorie Ring Component
 * Circumference = 2 * PI * 50 = 314.159px
 */

const CIRCUMFERENCE = 314.159;

export function renderCalorieRing(current: number, target: number) {
  const fillEl = document.getElementById('cal-ring') as SVGCircleElement | null;
  const bgEl = document.getElementById('cal-ring-bg') as SVGCircleElement | null;
  const currentEl = document.getElementById('ui-cal-current');
  const targetEl = document.getElementById('ui-cal-target');
  const pctEl = document.getElementById('ui-cal-pct');

  if (!fillEl || !currentEl || !targetEl) return;

  currentEl.innerText = Math.round(current).toLocaleString();
  targetEl.innerText = Math.round(target).toLocaleString();

  const ratio = target > 0 ? current / target : 0;
  const pct = Math.round(ratio * 100);

  if (pctEl) {
    pctEl.innerHTML = `${pct}% <span id="ui-cal-delta" class="delta-indicator"></span>`;
    const newDelta = document.getElementById('ui-cal-delta');
    if (newDelta) {
      if (ratio < 0.85) {
        newDelta.innerText = '↓';
        newDelta.style.color = '#3b82f6';
      } else if (ratio <= 1.15) {
        newDelta.innerText = '✓';
        newDelta.style.color = 'var(--accent-glow)';
      } else {
        newDelta.innerText = '↑';
        newDelta.style.color = 'var(--warn)';
      }
    }
  }

  // Multi-lap calculation
  const lap = Math.floor(ratio);
  const lapOffset = ratio % 1;
  const strokeDashoffset = CIRCUMFERENCE * (1 - lapOffset);

  fillEl.style.strokeDasharray = `${CIRCUMFERENCE}`;
  fillEl.style.strokeDashoffset = `${strokeDashoffset}`;

  fillEl.className.baseVal = 'ring-fill';
  if (bgEl) bgEl.className.baseVal = 'ring-bg';

  if (lap === 0) {
    if (ratio >= 0.85 && ratio <= 1.15) fillEl.classList.add('success');
    else if (ratio > 1.15) fillEl.classList.add('bleed');
  } else if (lap === 1) {
    fillEl.classList.add('lap-over-1');
    if (bgEl) bgEl.classList.add('bg-success');
  } else if (lap === 2) {
    fillEl.classList.add('lap-over-2');
    if (bgEl) bgEl.classList.add('bg-over-1');
  } else {
    fillEl.classList.add('lap-over-3');
    if (bgEl) bgEl.classList.add('bg-over-2');
  }
}
