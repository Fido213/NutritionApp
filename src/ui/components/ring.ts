/**
 * Multi-Lap Calorie Ring Component
 * Circumference = 2 * PI * 50 = 314.159px
 *
 * Pass 22b: ONE color at a time. The whole ring reads as a single hue that
 * shifts with the kcal ratio — never a multi-color sweep (that read as a
 * rainbow and got scrapped). Anchors walked by the ratio:
 *   deep red (empty) → lighter red → amber (~50%) → green entering the band
 *   → deep green through the target → red past it → violet → purple that
 *   intensifies the further over the day runs.
 * The stroke is set directly (not via gradient) so the existing CSS
 * `transition: stroke` smooths every shift between renders.
 */

const CIRCUMFERENCE = 314.159;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function lerpColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const mix = ca.map((ch, i) => Math.round(ch + (cb[i] - ch) * t));
  return `#${mix.map(ch => ch.toString(16).padStart(2, '0')).join('')}`;
}

/** Palette anchors along the eaten fraction of the target. Purple is held
 *  back until the ring has run nearly a FULL extra circle past the target
 *  (~1.75x blend start, fully violet just after 2x) per user review. */
const PALETTE: Array<[number, string]> = [
  [0.0, '#7f1d1d'], // deep red — barely eating
  [0.35, '#dc2626'], // red lifting as the day fills
  [0.6, '#ea9d06'], // amber approaching the band
  [0.85, '#65d96a'], // green entering the target band
  [1.05, '#22a94e'], // deep green through the target
  [1.2, '#ef4444'], // red takes over past the band…
  [1.75, '#ef4444'], // …and HOLDS pure red until well past a full circle
  [2.05, '#a855f7'], // violet arrives around the completed extra lap
  [2.5, '#8b2fd6'], // purple intensifying
  [3.0, '#5b1e9e'] // saturated deep purple far over
];

/** Continuous single color for any ratio ≥ 0 (clamped at the last anchor). */
export function ringColor(ratio: number): string {
  const r = Math.max(0, ratio);
  if (r <= PALETTE[0][0]) return PALETTE[0][1];
  for (let i = 1; i < PALETTE.length; i++) {
    if (r <= PALETTE[i][0]) {
      const [r0, c0] = PALETTE[i - 1];
      const [r1, c1] = PALETTE[i];
      return lerpColor(c0, c1, (r - r0) / (r1 - r0));
    }
  }
  return PALETTE[PALETTE.length - 1][1];
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

  // Multi-lap calculation — at exactly 1.0 / 2.0 etc the lap is complete,
  // so the foreground must read FULL, not empty (0% vs 100% were indistinguishable).
  let lapOffset = ratio % 1;
  if (ratio > 0 && (lapOffset === 0 || Math.abs(lapOffset - 1) < 1e-9)) lapOffset = 1;
  const strokeDashoffset = CIRCUMFERENCE * (1 - lapOffset);

  fillEl.style.strokeDasharray = `${CIRCUMFERENCE}`;
  fillEl.style.strokeDashoffset = `${strokeDashoffset}`;

  // One hue for the whole ring; CSS `transition: stroke` smooths shifts.
  fillEl.style.stroke = ringColor(ratio);

  fillEl.className.baseVal = 'ring-fill';
  if (bgEl) bgEl.className.baseVal = 'ring-bg';

  // Track (background ring) reflects how many laps the day has run.
  if (bgEl) {
    const lap = Math.floor(ratio);
    if (lap === 1) bgEl.classList.add('bg-success');
    else if (lap === 2) bgEl.classList.add('bg-over-1');
    else if (lap >= 3) bgEl.classList.add('bg-over-2');
  }
}
