// Inline sparklines for stat tiles: a 12-ish point trend line, drawn as SVG so
// it stays crisp at any density without a canvas or a resize observer.
//
// Per the tile contract the history sits in a de-emphasised hue and only the
// current value carries the accent — the sparkline is context, not the reading.

const MAX_POINTS = 24;

export function renderSparkline(el, values, { color = 'var(--series-1)' } = {}) {
  if (!el) return;
  const pts = (values ?? []).filter((v) => Number.isFinite(v) && v > 0).slice(-MAX_POINTS);

  if (pts.length < 2) {
    el.innerHTML = '';
    return;
  }

  const w = 100, h = 28, pad = 2;
  let lo = Math.min(...pts), hi = Math.max(...pts);
  // A flat series would divide by zero and draw nothing; give it a band so the
  // line sits sensibly in the middle instead of vanishing.
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }

  const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);

  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const lastX = x(pts.length - 1).toFixed(1);
  const lastY = y(pts.at(-1)).toFixed(1);

  el.innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"` +
        ` stroke-linejoin="round" stroke-linecap="round" opacity="0.4"` +
        ` vector-effect="non-scaling-stroke"/>` +
      `<circle cx="${lastX}" cy="${lastY}" r="2" fill="${color}"/>` +
    `</svg>`;
}
