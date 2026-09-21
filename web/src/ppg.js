// Scrolling photoplethysmogram trace.
//
// The incoming samples are already baseline-removed by the firmware, so all
// this needs to do is autoscale and draw. The scale itself is smoothed: a
// single motion spike would otherwise flatten the whole trace for a second.

const CSS = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class PpgTrace {
  constructor(canvas, capacity = 500) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.capacity = capacity;
    this.samples = [];
    this.lo = -1000;        // smoothed bounds of the visible window
    this.hi = 1000;
    this.fingerOn = false;
    this.running = false;

    // Capture the design height ONCE. Assigning canvas.height writes the
    // content attribute, so re-reading it in #resize would multiply the
    // already-scaled value by dpr again on every resize, compounding until
    // allocation fails. Invisible at dpr=1, catastrophic on a HiDPI display.
    this.cssHeight = Number(canvas.getAttribute('height')) || 340;

    const resize = () => this.#resize();
    new ResizeObserver(resize).observe(canvas);
    resize();
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.canvas.clientWidth || 600;
    const h = this.cssHeight;
    this.canvas.style.height = h + 'px';
    this.canvas.width  = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  /** Re-measure — call when this trace's view becomes visible. */
  refresh() { this.#resize(); }

  push(values) {
    this.samples.push(...values);
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity);
    }
  }

  clear() { this.samples.length = 0; }

  /**
   * Without a finger the trace is just dark-current noise a few counts wide.
   * Autoscaling that fills the frame with something that looks like a signal,
   * so gate the trace on actual contact and prompt instead.
   */
  setFingerOn(on) { this.fingerOn = Boolean(on); }

  start() {
    if (this.running) return;
    this.running = true;
    const frame = () => {
      if (!this.running) return;
      this.#draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop() { this.running = false; }

  #draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // Recessive grid: enough to judge amplitude, never competing with the trace.
    ctx.strokeStyle = CSS('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = Math.round((h / 4) * i) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();

    if (this.samples.length < 2 || !this.fingerOn) {
      ctx.fillStyle = CSS('--muted');
      ctx.font = '13px ' + CSS('--font');
      ctx.textAlign = 'center';
      ctx.fillText('Place a fingertip on the sensor', w / 2, h / 2);
      return;
    }

    // Autoscale to the window's actual bounds, eased so the trace breathes
    // instead of jumping. A PPG is strongly asymmetric — sharp systolic peaks
    // over a flat baseline — so scaling around min/max rather than +/-peak is
    // what keeps it filling the frame instead of hugging the centre line.
    let lo = Infinity, hi = -Infinity;
    for (const v of this.samples) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 120) { const m = (hi + lo) / 2; lo = m - 60; hi = m + 60; }
    this.lo += (lo - this.lo) * 0.06;
    this.hi += (hi - this.hi) * 0.06;

    const padY = 14;
    const span = Math.max(this.hi - this.lo, 1);
    const yOf = (v) => padY + ((this.hi - v) / span) * (h - padY * 2);
    const step = w / (this.capacity - 1);
    // Right-align: a partially filled buffer grows in from the left edge.
    const x0 = w - (this.samples.length - 1) * step;

    ctx.strokeStyle = CSS('--series-1');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = CSS('--series-1');   // soft bloom, matching the console look
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i < this.samples.length; i++) {
      const x = x0 + i * step;
      const y = yOf(this.samples[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Leading dot marks "now" — the data end, anchored to the trace.
    const lastY = yOf(this.samples.at(-1));
    ctx.fillStyle = CSS('--series-1');
    ctx.beginPath();
    ctx.arc(w - 1, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
