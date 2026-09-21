import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import mqtt from 'mqtt';

import { config } from './config.js';
import { openDb, RANGE_KEYS } from './db.js';
import { computeHrv, poincarePairs, cleanIntervals } from './hrv.js';
import { serveStatic } from './static.js';

const here    = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');
const db      = openDb(join(here, '..', 'data', 'vitals.db'));

// ---------------------------------------------------------------- device state
/**
 * Live view of every board we have heard from. The firmware's own `t` is
 * milliseconds since boot, so everything stored or charted is stamped with
 * server time instead; the device clock is kept only as an uptime readout.
 */
const devices = new Map();

function device(id) {
  let d = devices.get(id);
  if (!d) {
    d = { id, online: false, lastSeen: 0, vitals: null, ppg: [], fs: 50, rr: [] };
    devices.set(id, d);
    console.log(`[device] first contact: ${id}`);
  }
  return d;
}

function publicDevice(d) {
  return {
    id: d.id, online: d.online, lastSeen: d.lastSeen,
    vitals: d.vitals, fs: d.fs, ppg: d.ppg,
    // Send the cleaned series, not the raw one: the Poincare plot and every
    // metric are computed from cleaned intervals, so plotting raw beside them
    // made the two panels disagree about the same beats.
    rr: cleanIntervals(d.rr),
    hrv: computeHrv(d.rr),
    poincare: poincarePairs(d.rr),
  };
}

// ------------------------------------------------------------------- websocket
const clients = new Set();

function broadcast(frame) {
  const msg = JSON.stringify(frame);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// ------------------------------------------------------------------ mqtt ingest
const mqttClient = mqtt.connect(config.mqttUrl, {
  username: config.mqttUser,
  password: config.mqttPass,
  reconnectPeriod: 2000,
  clientId: `vitals-server-${process.pid}`,
});

mqttClient.on('connect', () => {
  console.log(`[mqtt] connected to ${config.mqttUrl}`);
  mqttClient.subscribe(`${config.topicRoot}/+/+`, (err) => {
    if (err) console.error('[mqtt] subscribe failed:', err.message);
    else console.log(`[mqtt] subscribed to ${config.topicRoot}/+/+`);
  });
});

mqttClient.on('error',   (e) => console.error('[mqtt] error:', e.message));
mqttClient.on('offline', ()  => console.warn('[mqtt] offline, retrying'));

mqttClient.on('message', (topic, buf) => {
  const [root, id, kind] = topic.split('/');
  if (root !== config.topicRoot || !id || !kind) return;

  const d = device(id);
  const now = Date.now();

  if (kind === 'status') {
    // Retained/last-will message: plain text, not JSON.
    d.online = buf.toString() === 'online';
    d.lastSeen = now;
    broadcast({ type: 'status', device: id, online: d.online });
    console.log(`[device] ${id} ${d.online ? 'online' : 'offline'}`);
    return;
  }

  let msg;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    console.warn(`[mqtt] unparseable payload on ${topic}`);
    return;
  }

  d.lastSeen = now;
  if (!d.online) {
    d.online = true;
    broadcast({ type: 'status', device: id, online: true });
  }

  if (kind === 'vitals') {
    const v = {
      ts:     now,
      bpm:    msg.bpm  ?? 0,
      spo2:   msg.spo2 ?? 0,
      pi:     msg.pi   ?? 0,
      finger: Boolean(msg.finger),
      rssi:   msg.rssi ?? null,
      uptime: msg.up   ?? null,
    };
    d.vitals = v;

    // Only real measurements reach the database. Storing the idle stream of
    // zeros would bloat history and drag every average toward nothing.
    if (v.finger && v.bpm > 0) {
      db.insert({ device: id, ts: now, bpm: v.bpm, spo2: v.spo2 || null, pi: v.pi, rssi: v.rssi });
    }
    broadcast({ type: 'vitals', device: id, ...v });

  } else if (kind === 'ibi') {
    const intervals = Array.isArray(msg.ibi) ? msg.ibi.filter((n) => Number.isFinite(n)) : [];
    if (!intervals.length) return;

    d.rr.push(...intervals);
    // Keep roughly the last five minutes of beats. HRV is defined over a
    // window, and an unbounded buffer would silently widen it over time.
    if (d.rr.length > config.rrWindowBeats) {
      d.rr.splice(0, d.rr.length - config.rrWindowBeats);
    }
    db.insertBeats(id, now, intervals);

    broadcast({
      type: 'ibi',
      device: id,
      intervals,
      rr: cleanIntervals(d.rr),
      hrv: computeHrv(d.rr),
      poincare: poincarePairs(d.rr),
    });

  } else if (kind === 'ppg') {
    const samples = Array.isArray(msg.ppg) ? msg.ppg : [];
    if (!samples.length) return;
    d.fs = msg.fs ?? d.fs;
    d.ppg.push(...samples);
    if (d.ppg.length > config.ppgBufferSamples) {
      d.ppg.splice(0, d.ppg.length - config.ppgBufferSamples);
    }
    broadcast({ type: 'ppg', device: id, fs: d.fs, ppg: samples });
  }
});

// A board yanked from USB never sends its last will, so fall back to silence.
setInterval(() => {
  const now = Date.now();
  for (const d of devices.values()) {
    if (d.online && now - d.lastSeen > config.staleAfterMs) {
      d.online = false;
      broadcast({ type: 'status', device: d.id, online: false });
      console.log(`[device] ${d.id} went quiet`);
    }
  }
}, 2000);

setInterval(() => {
  const removed = db.prune(config.retentionDays);
  if (removed) console.log(`[db] pruned ${removed} rows older than ${config.retentionDays}d`);
}, 3600_000);

// ----------------------------------------------------------------- http + api
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/devices') {
    const live = [...devices.values()].map(publicDevice);
    const seen = db.knownDevices();
    return json(res, { devices: live, history: seen, ranges: RANGE_KEYS });
  }

  if (url.pathname === '/api/history') {
    const id = url.searchParams.get('device');
    if (!id) return json(res, { error: 'device parameter required' }, 400);
    const range = url.searchParams.get('range') ?? '15m';
    return json(res, { device: id, range, points: db.history(id, range) });
  }

  if (url.pathname === '/api/hrv') {
    const id = url.searchParams.get('device');
    if (!id) return json(res, { error: 'device parameter required' }, 400);
    const minutes = Math.min(Number(url.searchParams.get('minutes') ?? 5), 60);
    // Prefer stored beats so a freshly started server can still answer, and
    // fall back to the live buffer when nothing has been written yet.
    const stored = db.beatsSince(id, minutes * 60_000);
    const rr = stored.length ? stored : (devices.get(id)?.rr ?? []);
    return json(res, {
      device: id, minutes,
      hrv: computeHrv(rr),
      poincare: poincarePairs(rr),
    });
  }

  if (url.pathname === '/api/health') {
    return json(res, {
      ok: true,
      mqtt: mqttClient.connected,
      devices: devices.size,
      clients: clients.size,
    });
  }

  return serveStatic(webRoot, url.pathname, res);
});

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  // Seed the dashboard with current state so it renders populated on load
  // rather than waiting up to a second for the next MQTT message.
  ws.send(JSON.stringify({
    type: 'snapshot',
    devices: [...devices.values()].map(publicDevice),
    ranges: RANGE_KEYS,
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(config.port, () => {
  console.log(`[http] dashboard on http://localhost:${config.port}`);
});

// -------------------------------------------------------------------- shutdown
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log('\n[shutdown] closing...');
    mqttClient.end(true);
    wss.close();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
