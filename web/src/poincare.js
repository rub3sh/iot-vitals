// Poincare plot: each beat interval against the one that follows it.
//
// The shape is the point. A tight cluster hugging the identity line means one
// beat closely predicts the next (low variability); a wide cloud means it does
// not. SD1 is the spread perpendicular to that line — beat-to-beat change —
// and SD2 the spread along it, longer-term drift. Ectopic beats land as
// distinct satellites off the diagonal, which no single HRV number reveals.

const CSS = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const PAD = { top: 16, right: 16, bottom: 30, left: 46 };

export class PoincarePlot {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.ctx = canvas.getContext('2d');
    this.pairs = [];
    this.hrv = null;
    this.hover = -1;

    // See ppg.js: capture the design height once, never the mutated attribute.
    this.cssHeight = Number(canvas.getAttribute('height')) || 320;

    const resize = () => { this.#resize(); this.draw(); };
    new ResizeObserver(resize).observe(canvas);
    resize();

    canvas.addEventListener('pointermove', (e) => this.#onMove(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.tooltip.style.opacity = '0';
      this.draw();
    });
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.canvas.clientWidth || 420;
    const h = this.cssHeight;
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  /** Re-measure and repaint — call when this chart's view becomes visible. */
  refresh() { this.#resize(); this.draw(); }

  setData(pairs, hrv) {
    this.pairs = Array.isArray(pairs) ? pairs : [];
    this.hrv = hrv ?? null;
    this.hover = -1;
    this.draw();
    return this.pairs.length;
  }

  // Both axes are the same quantity, so they must share one scale — otherwise
  // the identity line is not at 45 degrees and the cloud's shape, which is the
  // whole point of the plot, is distorted.
  #geom() {
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of this.pairs) {
      lo = Math.min(lo, a, b);
      hi = Math.max(hi, a, b);
    }
    if (!isFinite(lo)) { lo = 700; hi = 900; }
    const pad = Math.max((hi - lo) * 0.15, 20);
    lo -= pad; hi += pad;

    const y1 = this.h - PAD.bottom;
    // Square plotting area, so one millisecond is the same distance on each
    // axis — the cloud's shape is the reading, and unequal scales distort it.
    const avail = this.w - PAD.left - PAD.right;
    const side = Math.min(avail, y1 - PAD.top);
    // Centre the square: left-aligning it in a wide card leaves a dead gap
    // that reads as a rendering fault rather than a deliberate aspect ratio.
    const x0 = PAD.left + Math.max(0, (avail - side) / 2);
    const x1 = x0 + side, y0 = y1 - side;

    return {
      lo, hi, x0, x1, y0, y1, side,
      X: (v) => x0 + ((v - lo) / (hi - lo)) * side,
      Y: (v) => y1 - ((v - lo) / (hi - lo)) * side,
      scale: side / (hi - lo),
    };
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    if (this.pairs.length < 3) {
      ctx.fillStyle = CSS('--muted');
      ctx.font = '13px ' + CSS('--font');
      ctx.textAlign = 'center';
      const msg = this.hrv && this.hrv.beats
        ? `Collecting beats — ${this.hrv.beats} of ${this.hrv.needed ?? 20}`
        : 'Place a fingertip to collect beats';
      ctx.fillText(msg, w / 2, h / 2);
      return;
    }

    const g = this.#geom();
    const color = CSS('--series-1');

    // --- frame + ticks ------------------------------------------------------
    ctx.strokeStyle = CSS('--grid');
    ctx.lineWidth = 1;
    ctx.strokeRect(g.x0 + 0.5, g.y0 + 0.5, g.side, g.side);

    ctx.font = '11px ' + CSS('--font');
    ctx.fillStyle = CSS('--muted');
    const ticks = [g.lo + (g.hi - g.lo) * 0.2, g.lo + (g.hi - g.lo) * 0.8];
    for (const t of ticks) {
      const v = Math.round(t);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(v), g.x0 - 6, g.Y(v));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(v), g.X(v), g.y1 + 6);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('RR\u2099 (ms)', g.x0 + g.side / 2, g.y1 + 18);

    ctx.save();                       // y axis label, rotated
    ctx.translate(g.x0 - 34, g.y0 + g.side / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RR\u2099\u208a\u2081 (ms)', 0, 0);
    ctx.restore();

    // --- line of identity ---------------------------------------------------
    ctx.strokeStyle = CSS('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.X(g.lo), g.Y(g.lo));
    ctx.lineTo(g.X(g.hi), g.Y(g.hi));
    ctx.stroke();

    // --- SD1/SD2 ellipse ----------------------------------------------------
    // Centred on the mean interval, rotated onto the identity line: the semi-
    // axis along it is SD2, the one across it SD1.
    if (this.hrv?.ready && this.hrv.sd1 != null && this.hrv.sd2 != null) {
      const cx = g.X(this.hrv.meanRr), cy = g.Y(this.hrv.meanRr);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, this.hrv.sd2 * g.scale, this.hrv.sd1 * g.scale,
                  -Math.PI / 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Name the two axes on the plot itself. SD1 across the identity line,
      // SD2 along it — the geometry is the explanation, so label it in place
      // rather than making the reader map numbers from a tile onto a shape.
      const sd2px = this.hrv.sd2 * g.scale, sd1px = this.hrv.sd1 * g.scale;
      ctx.fillStyle = CSS('--muted');
      ctx.font = '10px ' + CSS('--font');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SD2', cx + sd2px * 0.78, cy - sd2px * 0.78);
      ctx.fillText('SD1', cx - sd1px * 0.95, cy - sd1px * 0.95);
    }

    // --- points -------------------------------------------------------------
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;          // overlap reads as density
    for (const [a, b] of this.pairs) {
      ctx.beginPath();
      ctx.arc(g.X(a), g.Y(b), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // --- hovered point ------------------------------------------------------
    if (this.hover >= 0 && this.hover < this.pairs.length) {
      const [a, b] = this.pairs[this.hover];
      ctx.beginPath();
      ctx.arc(g.X(a), g.Y(b), 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = CSS('--surface');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  #onMove(e) {
    if (this.pairs.length < 3) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const g = this.#geom();

    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.pairs.length; i++) {
      const [a, b] = this.pairs[i];
      const dx = g.X(a) - mx, dy = g.Y(b) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }

    // Generous hit radius — a 2.5px dot is not a target anyone can land on.
    if (Math.sqrt(bestD) > 18) {
      this.hover = -1;
      this.tooltip.style.opacity = '0';
      this.draw();
      return;
    }

    this.hover = best;
    const [a, b] = this.pairs[best];
    const delta = b - a;
    this.tooltip.innerHTML =
      `<span class="t-time">beat pair</span>` +
      `<span class="t-val">${Math.round(a)} &rarr; ${Math.round(b)} ms</span>` +
      ` <span style="color:var(--muted)">${delta >= 0 ? '+' : ''}${Math.round(delta)}</span>`;

    this.tooltip.style.opacity = '1';
    const tw = this.tooltip.offsetWidth;
    this.tooltip.style.left = Math.min(Math.max(g.X(a) - tw / 2, 4), this.w - tw - 4) + 'px';
    this.tooltip.style.top = Math.max(g.Y(b) - this.tooltip.offsetHeight - 12, 4) + 'px';
    this.draw();
  }
}
