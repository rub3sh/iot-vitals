// Single-series time-series line chart with a crosshair tooltip.
//
// Deliberately one series per chart: heart rate and SpO2 live on completely
// different scales, and putting them on two y-axes in one frame is the fastest
// way to make a chart lie. Two charts, one axis each.

const CSS = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const PAD = { top: 14, right: 18, bottom: 26, left: 46 };

function niceTicks(min, max, count = 4) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Math.round(v * 1000) / 1000);
  }
  return out;
}

const fmtClock = (ts, span) =>
  new Date(ts).toLocaleTimeString([], span > 6 * 3600_000
    ? { hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export class LineChart {
  /** @param opts {color, decimals, unit, padY, clampMax} */
  constructor(canvas, tooltip, opts = {}) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    // area: gradient fill under the line. glow: a soft bloom on the stroke.
    // Both are decoration on a single-series chart — they never encode anything,
    // and the grid and axes stay recessive underneath.
    this.opts = { color: '--series-1', decimals: 0, unit: '', padY: 0.12,
                  area: false, glow: false, ...opts };
    this.points = [];
    this.hover = -1;
    this.ctx = canvas.getContext('2d');

    // See ppg.js: read the design height once, never from the mutated
    // attribute, or dpr compounds on every resize.
    this.cssHeight = Number(canvas.getAttribute('height')) || 380;

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
    const w = this.canvas.clientWidth || 480;
    const h = this.cssHeight;
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  /** points: [{t, v}] sorted ascending. Missing buckets are simply absent. */
  /** Re-measure and repaint — call when this chart's view becomes visible. */
  refresh() { this.#resize(); this.draw(); }

  setData(points) {
    this.points = points.filter((p) => p.v != null && isFinite(p.v));
    this.hover = -1;
    this.draw();
    return this.points.length;
  }

  #geom() {
    const pts = this.points;
    const x0 = PAD.left, x1 = this.w - PAD.right;
    const y0 = PAD.top,  y1 = this.h - PAD.bottom;
    const tMin = pts[0].t, tMax = pts.at(-1).t;
    const tSpan = Math.max(tMax - tMin, 1);

    let vMin = Infinity, vMax = -Infinity;
    for (const p of pts) { vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v); }
    const pad = Math.max((vMax - vMin) * this.opts.padY, vMax * 0.02, 1);
    vMin -= pad; vMax += pad;
    if (this.opts.clampMax != null) vMax = Math.min(vMax, this.opts.clampMax);

    return {
      x0, x1, y0, y1, tMin, tSpan, vMin, vMax,
      X: (t) => x0 + ((t - tMin) / tSpan) * (x1 - x0),
      Y: (v) => y1 - ((v - vMin) / (vMax - vMin || 1)) * (y1 - y0),
    };
  }

  // A bucket much wider than typical means the sensor was idle: break the line
  // rather than drawing a straight run across time nothing was measured.
  #gapLimit() {
    const pts = this.points;
    if (pts.length < 3) return Infinity;
    const gaps = [];
    for (let i = 1; i < pts.length; i++) gaps.push(pts[i].t - pts[i - 1].t);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] * 2.5;
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (this.points.length === 0) return;

    const g = this.#geom();
    const color = CSS(this.opts.color);
    const single = this.points.length === 1;

    // --- grid + y axis ----------------------------------------------------
    ctx.font = '11px ' + CSS('--font');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const tick of niceTicks(g.vMin, g.vMax)) {
      const y = Math.round(g.Y(tick)) + 0.5;
      if (y < g.y0 - 1 || y > g.y1 + 1) continue;
      ctx.strokeStyle = CSS('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.x0, y); ctx.lineTo(g.x1, y); ctx.stroke();
      ctx.fillStyle = CSS('--muted');
      ctx.fillText(tick.toFixed(this.opts.decimals), g.x0 - 8, y);
    }

    // --- x axis -----------------------------------------------------------
    ctx.strokeStyle = CSS('--axis');
    ctx.beginPath();
    ctx.moveTo(g.x0, Math.round(g.y1) + 0.5);
    ctx.lineTo(g.x1, Math.round(g.y1) + 0.5);
    ctx.stroke();

    ctx.fillStyle = CSS('--muted');
    ctx.textBaseline = 'top';
    const labels = single ? 1 : 3;
    for (let i = 0; i < labels; i++) {
      const t = g.tMin + (g.tSpan * i) / Math.max(labels - 1, 1);
      const x = g.X(t);
      ctx.textAlign = i === 0 ? 'left' : i === labels - 1 ? 'right' : 'center';
      ctx.fillText(fmtClock(t, g.tSpan), x, g.y1 + 7);
    }

    // --- the line ---------------------------------------------------------
    const limit = this.#gapLimit();

    // Area fill first, so the stroke sits on top of it.
    if (this.opts.area && this.points.length > 1) {
      const grad = ctx.createLinearGradient(0, g.y0, 0, g.y1);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = grad;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i];
        const x = g.X(p.t), y = g.Y(p.v);
        if (!started) { ctx.moveTo(x, g.y1); ctx.lineTo(x, y); started = true; }
        else if (p.t - this.points[i - 1].t > limit) {
          // Close the run at the gap rather than filling across dead time.
          ctx.lineTo(g.X(this.points[i - 1].t), g.y1);
          ctx.moveTo(x, g.y1); ctx.lineTo(x, y);
        } else ctx.lineTo(x, y);
      }
      ctx.lineTo(g.X(this.points.at(-1).t), g.y1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    if (this.opts.glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const x = g.X(p.t), y = g.Y(p.v);
      if (!open || p.t - this.points[i - 1].t > limit) { ctx.moveTo(x, y); open = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // A lone reading has no line to draw, so give it a mark of its own.
    if (single) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(g.X(this.points[0].t), g.Y(this.points[0].v), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- one direct label, on the latest value ----------------------------
    const last = this.points.at(-1);
    const lx = g.X(last.t), ly = g.Y(last.v);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = CSS('--surface');   // 2px ring keeps the dot off the line
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.stroke();

    ctx.font = '600 12px ' + CSS('--font');
    ctx.textBaseline = 'bottom';
    ctx.textAlign = lx > g.x1 - 40 ? 'right' : 'left';
    const label = last.v.toFixed(this.opts.decimals);
    const labelX = lx + (lx > g.x1 - 40 ? -7 : 7);
    // Halo in the surface colour so the label stays readable where it has to
    // sit over the line it is labelling.
    ctx.strokeStyle = CSS('--surface');
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(label, labelX, ly - 5);
    ctx.fillStyle = CSS('--ink');         // value ink, not the series colour
    ctx.fillText(label, labelX, ly - 5);

    // --- crosshair --------------------------------------------------------
    if (this.hover >= 0 && this.hover < this.points.length) {
      const p = this.points[this.hover];
      const hx = g.X(p.t), hy = g.Y(p.v);
      // Solid hairline: dashing reads as "threshold" when it is just a pointer.
      ctx.strokeStyle = CSS('--axis');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, g.y0);
      ctx.lineTo(Math.round(hx) + 0.5, g.y1);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = CSS('--surface');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  #onMove(e) {
    if (!this.points.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const g = this.#geom();

    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = Math.abs(g.X(this.points[i].t) - mx);
      if (d < bestD) { bestD = d; best = i; }
    }
    // Generous hit target: anywhere in the plot snaps to the nearest point.
    if (bestD > 40) {
      this.hover = -1;
      this.tooltip.style.opacity = '0';
      this.draw();
      return;
    }

    this.hover = best;
    const p = this.points[best];
    this.tooltip.innerHTML =
      `<span class="t-time">${new Date(p.t).toLocaleString([], {
         month: 'short', day: 'numeric', hour: '2-digit',
         minute: '2-digit', second: '2-digit' })}</span>` +
      `<span class="t-val">${p.v.toFixed(this.opts.decimals)}${this.opts.unit}</span>` +
      (p.n ? ` <span style="color:var(--muted)">&middot; ${p.n} samples</span>` : '');

    const px = g.X(p.t), py = g.Y(p.v);
    this.tooltip.style.opacity = '1';
    const tw = this.tooltip.offsetWidth;
    this.tooltip.style.left = Math.min(Math.max(px - tw / 2, 4), this.w - tw - 4) + 'px';
    this.tooltip.style.top = Math.max(py - this.tooltip.offsetHeight - 12, 4) + 'px';
    this.draw();
  }
}
