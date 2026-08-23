/**
 * Multi-Lap Calorie Ring Component
 * Circumference = 2 * PI * 50 = 314.159px
 */

const CIRCUMFERENCE = 314.159;

/**
 * Gradient stops for the ring stroke based on how the day is going (§5d):
 * deep red while barely eating, amber approaching the target band, a green
 * sweep inside 85–115%, amber→red once over.
 */
function ringGradientColors(ratio: number): [string, string] {
  if (ratio > 1.15) return ['var(--fat)', 'var(--warn)'];
  if (ratio >= 0.85) return ['var(--score-pos-2)', 'var(--score-pos-5)'];
  if (ratio >= 0.5) return ['#d97706', 'var(--fat)'];
  return ['#b91c1c', 'var(--score-neg-2)'];
}

/** Create-once the SVG <linearGradient> backing the ring stroke. */
function ensureRingGradient(svg: SVGSVGElement): SVGLinearGradientElement | null {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.prepend(defs);
  }
  let grad = defs.querySelector('#ring-gradient') as SVGLinearGradientElement | null;
  if (!grad) {
    grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.id = 'ring-gradient';
    for (const offset of ['0%', '100%']) {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      grad.appendChild(stop);
    }
    defs.appendChild(grad);
  }
  return grad;
}

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

  // Gradient stroke while on the first lap (how the day is going); multi-lap
  // over-target states keep their dedicated class colors instead.
  if (lap === 0) {
    const svg = fillEl.ownerSVGElement;
    const grad = svg ? ensureRingGradient(svg) : null;
    if (grad) {
      const stops = grad.querySelectorAll('stop');
      const [from, to] = ringGradientColors(ratio);
      stops[0].setAttribute('stop-color', from);
      stops[1].setAttribute('stop-color', to);
      fillEl.style.stroke = 'url(#ring-gradient)';
    }
  } else {
    fillEl.style.stroke = ''; // class color takes over (lap-over-1/2/3)
  }

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
