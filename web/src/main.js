import { PpgTrace } from './ppg.js';
import { LineChart } from './chart.js';
import { PoincarePlot } from './poincare.js';
import { renderSparkline } from './sparkline.js';

const $ = (id) => document.getElementById(id);

// Short trend history behind each tile's sparkline. Live only — the charts
// below cover real history; this is just the shape of the last minute.
const TREND_MAX = 90;   // ~90 s of live trend behind the hero chart
const trend = { bpm: [], spo2: [], pi: [] };

function pushTrend(key, v) {
  const arr = trend[key];
  if (!Number.isFinite(v)) return;
  arr.push({ t: Date.now(), v });
  if (arr.length > TREND_MAX) arr.shift();
}
const trendValues = (key) => trend[key].map((p) => p.v);
function clearTrends() { for (const k of Object.keys(trend)) trend[k].length = 0; }

const state = {
  devices: new Map(),
  selected: null,
  range: '15m',
  view: 'live',
  ranges: ['5m', '15m', '1h', '6h', '24h'],
  history: [],
};

// ------------------------------------------------------------------- theme
const THEME_KEY = 'vitals-theme';
// This console is designed dark-first, so dark is the default and light is an
// explicit opt-in rather than something the OS setting decides.
try {
  document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || 'dark';
} catch { document.documentElement.dataset.theme = 'dark'; }

$('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* ignore */ }
  // Canvases read their colours from CSS custom properties at draw time, so
  // every one has to be repainted for a theme change to take.
  for (const c of [heroChart, bpmChart, spo2Chart, tachoChart, poincare]) c.draw();
});

// ------------------------------------------------------------------ charts
const ppg = new PpgTrace($('ppg-canvas'), 500);

const poincare = new PoincarePlot($('poincare-canvas'), $('poincare-tip'));
// Hero trend: the live BPM series as a glowing area, the console's focal point.
const heroChart = new LineChart($('hero-canvas'), $('hero-tip'),
  { color: '--series-1', decimals: 0, unit: ' bpm', padY: 0.25, area: true, glow: true });

const tachoChart = new LineChart($('tacho-canvas'), $('tacho-tip'),
  { color: '--series-1', decimals: 0, unit: ' ms', padY: 0.18 });

const bpmChart  = new LineChart($('bpm-canvas'),  $('bpm-tip'),
  { color: '--series-1', decimals: 0, unit: ' bpm' });
const spo2Chart = new LineChart($('spo2-canvas'), $('spo2-tip'),
  { color: '--series-2', decimals: 1, unit: '%', clampMax: 100 });

// ------------------------------------------------------------------- tiles
function setValue(el, text, idle) {
  const unit = el.querySelector('.unit');
  el.firstChild.nodeValue = text;
  el.classList.toggle('idle', idle);
  if (unit) el.appendChild(unit);
}

function renderTiles(v) {
  const figure = $('bpm-figure');

  if (!v) {
    setValue($('bpm-value'), '\u2013\u2013', true);
    setValue($('spo2-value'), '\u2013\u2013', true);
    setValue($('pi-value'), '\u2013\u2013', true);
    setValue($('rssi-value'), '\u2013\u2013', true);
    $('bpm-foot').textContent = 'waiting for a device';
    setSignal(null, false);
    clearTrends();
    heroChart.setData([]);
    renderSparkline($('spo2-spark'), []);
    renderSparkline($('pi-spark'), []);
    $('bpm-badge').hidden = true;
    return;
  }

  const measuring = v.finger && v.bpm > 0 && !v.saturated;
  const hasSpo2 = v.finger && v.spo2 > 0 && !v.saturated;
  const hasPi = v.finger && v.pi > 0 && !v.saturated;

  setValue($('bpm-value'),  measuring ? v.bpm.toFixed(0) : '\u2013\u2013', !measuring);
  setValue($('spo2-value'), hasSpo2 ? v.spo2.toFixed(1) : '\u2013\u2013', !hasSpo2);
  setValue($('pi-value'),   hasPi ? v.pi.toFixed(2) : '\u2013\u2013', !hasPi);
  setValue($('rssi-value'), v.rssi != null ? String(v.rssi) : '\u2013\u2013', v.rssi == null);

  if (measuring) pushTrend('bpm', v.bpm);
  if (hasSpo2)   pushTrend('spo2', v.spo2);
  if (hasPi)     pushTrend('pi', v.pi);
  heroChart.setData(trend.bpm);
  renderSparkline($('spo2-spark'), trendValues('spo2'), { color: 'var(--series-2)' });
  renderSparkline($('pi-spark'),   trendValues('pi'),   { color: 'var(--series-1)' });

  // Badge shows movement against the start of the live window — the console
  // idiom, but anchored to a stated period rather than an arbitrary baseline.
  const badge = $('bpm-badge');
  if (measuring && trend.bpm.length >= 8) {
    const first = trend.bpm[0].v, last = trend.bpm.at(-1).v;
    const delta = Math.round(last - first);
    badge.hidden = false;
    // An arrow on a zero delta claims a direction that is not there.
    badge.textContent = delta === 0
      ? 'steady this minute'
      : `${delta > 0 ? '\u2191' : '\u2193'} ${Math.abs(delta)} bpm this minute`;
  } else {
    badge.hidden = true;
  }

  // One line that always says what the reading is doing and what to do next.
  $('bpm-foot').textContent =
    v.saturated ? 'signal clipped \u2014 ease off the sensor'
    : !v.finger  ? 'waiting for a finger'
    : measuring  ? 'measuring'
    : 'finger detected \u2014 hold still';

  setSignal(v.finger && !v.saturated ? (v.pi ?? 0) : null, Boolean(v.saturated));

  $('spo2-foot').textContent =
    hasSpo2 ? 'uncalibrated estimate'
    : v.finger ? 'needs a steady window'
    : 'uncalibrated';

  $('pi-foot').textContent =
    !v.finger ? 'pulse strength'
    : (v.pi ?? 0) >= 1.5 ? 'strong pulse'
    : (v.pi ?? 0) >= 0.5 ? 'usable pulse'
    : 'weak \u2014 press gently';

  $('uptime-foot').textContent =
    v.uptime != null ? `uptime ${formatUptime(v.uptime)}` : 'uptime \u2014';

  if (!v.finger) { figure.classList.remove('beat'); }
}

/**
 * Signal-quality meter. Perfusion index is the honest measure of whether any
 * of this is trustworthy, so it gets a visible bar rather than being buried in
 * a tile. Severity never rides on colour alone — the label states it too.
 */
function setSignal(pi, saturated) {
  const row = $('signal-row');
  const fill = $('signal-fill');
  const label = $('signal-label');

  if (saturated) {
    row.dataset.level = 'weak';
    fill.style.width = '100%';
    label.textContent = 'clipped';
    return;
  }
  if (pi == null) {
    row.dataset.level = 'none';
    fill.style.width = '0%';
    label.textContent = 'no signal';
    return;
  }
  // 3% perfusion is a strong fingertip reading; scale the bar against that.
  const pct = Math.max(4, Math.min(100, (pi / 3) * 100));
  fill.style.width = pct + '%';
  const level = pi >= 1.5 ? 'strong' : pi >= 0.5 ? 'usable' : 'weak';
  row.dataset.level = level;
  label.textContent = level;
}

/**
 * Tick the hero figure once per detected beat. It makes the reading legible as
 * a rhythm, and it is the fastest possible tell that beat detection is firing
 * at all — a number that sits still is ambiguous, one that pulses is not.
 */
let beatTimer = null;
function pulseHero(count = 1) {
  const el = $('bpm-figure');
  if (!el) return;
  let n = 0;
  const tick = () => {
    el.classList.remove('beat');
    void el.offsetWidth;            // restart the animation
    el.classList.add('beat');
    if (++n < Math.min(count, 3)) beatTimer = setTimeout(tick, 220);
  };
  clearTimeout(beatTimer);
  tick();
}

/**
 * Beats carry no wall-clock time of their own, but each interval *is* the gap
 * to the previous beat — so walking the series backwards from now reconstructs
 * when each one landed. That gives a real time axis rather than a beat index.
 */
function tachogramPoints(rr) {
  if (!Array.isArray(rr) || rr.length < 2) return [];
  const total = rr.reduce((a, b) => a + b, 0);
  let t = Date.now() - total;
  return rr.map((v) => { t += v; return { t, v }; });
}

function renderHrv(hrv, pairs, rr) {
  poincare.setData(pairs ?? [], hrv ?? null);

  const n = tachoChart.setData(tachogramPoints(rr));
  $('tacho-empty').hidden = n > 0;
  $('tacho-canvas').hidden = n === 0;

  const set = (id, val, digits) =>
    setValue($(id), val == null ? '\u2013\u2013' : val.toFixed(digits), val == null);

  if (!hrv || !hrv.ready) {
    set('rmssd-value', null); set('sdnn-value', null);
    set('pnn50-value', null); set('sdratio-value', null);
    $('sdratio-foot').textContent = 'shape of the cloud';
    const beats = hrv?.beats ?? 0;
    const needed = hrv?.needed ?? 20;
    $('hrv-note').textContent = beats
      ? `collecting \u2014 ${beats} of ${needed} beats`
      : 'waiting for beats';
    setValue($('beats-value'), beats ? String(beats) : '\u2013\u2013', !beats);
    $('beats-foot').textContent = beats ? `need ${needed}` : 'collected';
    return;
  }

  set('rmssd-value', hrv.rmssd, 0);
  set('sdnn-value',  hrv.sdnn, 0);
  set('pnn50-value', hrv.pnn50, 1);
  set('sdratio-value', hrv.ratio, 2);

  // The ratio describes the cloud a reader is looking at, so name the shape
  // rather than leaving a bare number to interpret.
  const r = hrv.ratio ?? 0;
  $('sdratio-foot').textContent =
    r >= 3 ? 'elongated \u2014 slow drift dominates'
    : r >= 1.5 ? 'oval \u2014 typical resting pattern'
    : 'round \u2014 beat-to-beat change dominates';

  const rejected = hrv.rejected
    ? ` \u00b7 ${hrv.rejected} artefact${hrv.rejected === 1 ? '' : 's'} rejected` : '';
  $('hrv-note').textContent = `${hrv.beats} beats${rejected}`;
  setValue($('beats-value'), String(hrv.beats), false);
  $('beats-foot').textContent = hrv.rejected ? `${hrv.rejected} rejected` : 'collected';
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec / 3600) % 24;
  const m = Math.floor(sec / 60) % 60, s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function setStatus(el, textEl, stateName, label) {
  el.dataset.state = stateName;
  textEl.textContent = label;
}

// ------------------------------------------------------------------ devices
function refreshDevicePicker() {
  const picker = $('device-picker');
  const ids = [...state.devices.keys()].sort();

  // Device ids arrive in MQTT topic names, so anything on the network can
  // choose them. Build the options as DOM nodes — never as an HTML string.
  picker.replaceChildren(...(ids.length ? ids : ['']).map((id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id || 'no devices';
    return opt;
  }));
  picker.hidden = ids.length < 2;
  if (state.selected) picker.value = state.selected;
}

function selectDevice(id) {
  if (state.selected === id) return;
  state.selected = id;
  $('device-name').textContent = id ? `· ${id}` : '—';
  ppg.clear();
  const d = state.devices.get(id);
  if (d) {
    if (d.ppg?.length) ppg.push(d.ppg);
    ppg.setFingerOn(d.vitals?.finger);
    renderTiles(d.vitals);
    renderHrv(d.hrv, d.poincare, d.rr);
    setStatus($('node-status'), $('node-text'),
              d.online ? 'online' : 'offline', d.online ? 'device online' : 'device offline');
  }
  refreshDevicePicker();
  loadHistory();
}

$('device-picker').addEventListener('change', (e) => selectDevice(e.target.value));

// ------------------------------------------------------------------ history
async function loadHistory() {
  if (!state.selected) {
    state.history = [];
    renderHistory();
    return;
  }
  try {
    const res = await fetch(
      `/api/history?device=${encodeURIComponent(state.selected)}&range=${state.range}`);
    const body = await res.json();
    state.history = body.points ?? [];
  } catch {
    state.history = [];
  }
  renderHistory();
}

function renderHistory() {
  const pts = state.history;

  const nBpm = bpmChart.setData(pts.map((p) => ({ t: p.t, v: p.bpm, n: p.n })));
  const nSpo2 = spo2Chart.setData(pts.map((p) => ({ t: p.t, v: p.spo2, n: p.n })));

  $('bpm-empty').hidden  = nBpm > 0;
  $('spo2-empty').hidden = nSpo2 > 0;
  $('bpm-canvas').hidden  = nBpm === 0;
  $('spo2-canvas').hidden = nSpo2 === 0;

  $('history-note').textContent = pts.length
    ? `${pts.length} bucket${pts.length === 1 ? '' : 's'} · history is recorded only while a finger is detected`
    : '';

  $('table-body').innerHTML = pts.length
    ? pts.slice().reverse().map((p) => `<tr>
        <td>${new Date(p.t).toLocaleString()}</td>
        <td>${p.bpm  != null ? p.bpm.toFixed(0)  : '–'}</td>
        <td>${p.spo2 != null ? p.spo2.toFixed(1) : '–'}</td>
        <td>${p.pi   != null ? p.pi.toFixed(2)   : '–'}</td>
        <td>${p.n}</td></tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">No data in this range</td></tr>';
}

function buildRangePicker() {
  $('range-picker').innerHTML = state.ranges
    .map((r) => `<option value="${r}"${r === state.range ? ' selected' : ''}>last ${r}</option>`)
    .join('');
}

$('range-picker').addEventListener('change', (e) => {
  state.range = e.target.value;
  loadHistory();
});

$('table-toggle').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  $('table-view').hidden = !on;
});

// No point refetching history for a view nobody is looking at.
setInterval(() => { if (state.view === 'history') loadHistory(); }, 10_000);

// ---------------------------------------------------------------- websocket
let ws, retry = 1000;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 1000;
    setStatus($('link-status'), $('link-text'), 'online', 'live');
  };

  ws.onclose = () => {
    setStatus($('link-status'), $('link-text'), 'offline', 'reconnecting');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15_000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'snapshot') {
      state.ranges = msg.ranges?.length ? msg.ranges : state.ranges;
      buildRangePicker();
buildRangePicker();

      // The snapshot is authoritative. Drop anything the server no longer
      // knows about, so a device deleted between sessions stops haunting the
      // picker instead of lingering as a dead entry.
      const live = new Set(msg.devices.map((d) => d.id));
      for (const id of [...state.devices.keys()]) {
        if (!live.has(id)) state.devices.delete(id);
      }
      for (const d of msg.devices) state.devices.set(d.id, d);

      // If the device we were showing has vanished, fall back to a real one
      // rather than rendering an empty dashboard against a dead selection.
      if (state.selected && !live.has(state.selected)) {
        state.selected = null;
        ppg.clear();
      }
      refreshDevicePicker();

      if (!state.selected && msg.devices.length) {
        selectDevice(msg.devices[0].id);
      } else if (!state.selected) {
        setStatus($('node-status'), $('node-text'), 'waiting', 'no device yet');
        renderTiles(null);
      } else {
        // Same device across a reconnect: re-seed from the snapshot so the
        // trace and tiles are populated immediately rather than after the
        // next publish.
        const d = state.devices.get(state.selected);
        if (d) {
          ppg.clear();
          if (d.ppg?.length) ppg.push(d.ppg);
          ppg.setFingerOn(d.vitals?.finger);
          renderTiles(d.vitals);
          renderHrv(d.hrv, d.poincare, d.rr);
          setStatus($('node-status'), $('node-text'),
                    d.online ? 'online' : 'offline',
                    d.online ? 'device online' : 'device offline');
        }
      }
      return;
    }

    const d = state.devices.get(msg.device) ?? { id: msg.device, ppg: [], online: true };
    state.devices.set(msg.device, d);
    if (!state.selected) selectDevice(msg.device);
    else refreshDevicePicker();

    if (msg.type === 'vitals') {
      d.vitals = msg;
      d.online = true;
      if (msg.device === state.selected) {
        ppg.setFingerOn(msg.finger);
        renderTiles(msg);
        setStatus($('node-status'), $('node-text'), 'online', 'device online');
      }
    } else if (msg.type === 'ibi') {
      d.hrv = msg.hrv;
      d.poincare = msg.poincare;
      d.rr = msg.rr ?? d.rr;
      if (msg.device === state.selected) {
        renderHrv(msg.hrv, msg.poincare, d.rr);
        pulseHero(msg.intervals?.length ?? 1);
      }

    } else if (msg.type === 'ppg') {
      if (msg.device === state.selected) ppg.push(msg.ppg);
    } else if (msg.type === 'status') {
      d.online = msg.online;
      if (msg.device === state.selected) {
        setStatus($('node-status'), $('node-text'),
                  msg.online ? 'online' : 'offline',
                  msg.online ? 'device online' : 'device offline');
        if (!msg.online) { ppg.clear(); renderTiles(d.vitals); }
      }
    }
  };
}

// --------------------------------------------------------------- sidebar nav
{
  const links = [...document.querySelectorAll('#nav a')];
  const sections = links
    .map((a) => document.getElementById(a.dataset.section))
    .filter(Boolean);

  for (const a of links) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.section)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Highlight whichever section is nearest the top of the viewport. An
  // IntersectionObserver alone flickers when two sections are both visible, so
  // pick the single best candidate on each change.
  const spy = new IntersectionObserver(() => {
    let best = null, bestTop = Infinity;
    for (const s of sections) {
      const top = Math.abs(s.getBoundingClientRect().top - 90);
      if (top < bestTop) { bestTop = top; best = s; }
    }
    for (const a of links) a.classList.toggle('active', a.dataset.section === best?.id);
  }, { threshold: [0, 0.25, 0.5], rootMargin: '-80px 0px -60% 0px' });
  for (const s of sections) spy.observe(s);
}

// ------------------------------------------------------------------- router
// Each nav entry is its own view rather than an anchor on one long page. The
// hash drives it, so views are linkable and the back button works.
const VIEWS = {
  live:    () => { ppg.refresh(); ppg.start(); heroChart.refresh(); },
  hrv:     () => { poincare.refresh(); tachoChart.refresh(); },
  history: () => { bpmChart.refresh(); spo2Chart.refresh(); loadHistory(); },
};

function showView(name) {
  const id = Object.hasOwn(VIEWS, name) ? name : 'live';

  for (const key of Object.keys(VIEWS)) {
    const el = $(key);
    if (el) el.hidden = key !== id;
  }
  for (const a of document.querySelectorAll('#nav a')) {
    const on = a.dataset.section === id;
    a.classList.toggle('active', on);
    a.setAttribute('aria-current', on ? 'page' : 'false');
  }

  // The waveform animates continuously; there is no reason to keep painting it
  // into a hidden view.
  if (id !== 'live') ppg.stop();

  // Canvases in a hidden container measure zero wide, so anything in the view
  // being shown has to re-measure before it can paint correctly.
  VIEWS[id]();
  state.view = id;
}

for (const a of document.querySelectorAll('#nav a')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = a.dataset.section;
  });
}
addEventListener('hashchange', () => showView(location.hash.slice(1)));

buildRangePicker();
renderTiles(null);
renderHrv(null, [], []);
showView(location.hash.slice(1) || 'live');
connect();
