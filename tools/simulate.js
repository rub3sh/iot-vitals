// Fake sensor node: publishes the exact topics and payloads the firmware does,
// so the server and dashboard can be developed without the board attached.
//
//   node tools/simulate.js [deviceId] [--no-finger]
//
// Uses the mqtt package installed in server/, so run it from the repo root.

import mqtt from '../server/node_modules/mqtt/build/index.js';

const deviceId = process.argv[2]?.startsWith('--') ? 'sim-01' : (process.argv[2] ?? 'sim-01');
const noFinger = process.argv.includes('--no-finger');
const url = process.env.MQTT_URL ?? 'mqtt://localhost:1883';

const base_ = `vitals/${deviceId}`;
const FS = 50;               // waveform rate, matching the firmware
const BATCH = 25;            // samples per message
const started = Date.now();

let phase = 0;
let bpm = 72;
let spo2 = 97.4;

// Beat scheduling for HRV. Real intervals are not constant: respiratory sinus
// arrhythmia speeds the heart on inhalation and slows it on exhalation, which
// is most of what short-term HRV measures. Modelling it gives the Poincare
// plot the elongated shape a real resting recording has, rather than a
// meaningless round blob.
let nextBeatAt = Date.now() + 800;
let breathPhase = 0;
const BREATH_HZ = 0.25;          // 15 breaths per minute

/** One cardiac cycle: sharp systolic upstroke, dicrotic notch, slow decay. */
function ppgSample(p) {
  const systolic = Math.exp(-Math.pow((p - 0.18) / 0.075, 2)) * 1.0;
  const dicrotic = Math.exp(-Math.pow((p - 0.42) / 0.10, 2)) * 0.32;
  return (systolic + dicrotic - 0.28) * 2600;
}

const client = mqtt.connect(url, {
  clientId: `sim-${deviceId}-${process.pid}`,
  will: { topic: `${base_}/status`, payload: 'offline', qos: 1, retain: true },
});

client.on('connect', () => {
  console.log(`[sim] ${deviceId} connected to ${url}${noFinger ? ' (idle, no finger)' : ''}`);
  client.publish(`${base_}/status`, 'online', { retain: true });

  setInterval(() => {
    const ppg = [];
    for (let i = 0; i < BATCH; i++) {
      phase += bpm / 60 / FS;
      if (phase >= 1) phase -= 1;
      const noise = (Math.random() - 0.5) * 90;
      ppg.push(noFinger ? Math.round(noise * 0.3) : Math.round(ppgSample(phase) + noise));
    }
    client.publish(`${base_}/ppg`, JSON.stringify({ t: Date.now() - started, fs: FS, ppg }));
  }, (BATCH / FS) * 1000);

  // Emit beat intervals as they fall due, the way the firmware does.
  setInterval(() => {
    if (noFinger) return;
    const now = Date.now();
    if (now < nextBeatAt) return;

    const base = 60000 / bpm;
    breathPhase = (breathPhase + BREATH_HZ * (base / 1000)) % 1;
    const rsa = Math.sin(breathPhase * 2 * Math.PI) * 28;   // ms
    const jitter = (Math.random() - 0.5) * 12;
    const rr = Math.max(300, Math.min(2000, Math.round(base + rsa + jitter)));

    nextBeatAt = now + rr;
    client.publish(`${base_}/ibi`, JSON.stringify({ t: now - started, ibi: [rr] }));
  }, 50);

  setInterval(() => {
    // Gentle random walk so the history chart shows something lifelike.
    bpm = Math.min(96, Math.max(54, bpm + (Math.random() - 0.5) * 2.2));
    spo2 = Math.min(99.5, Math.max(94, spo2 + (Math.random() - 0.5) * 0.35));

    const payload = noFinger
      ? { t: Date.now() - started, bpm: 0, spo2: 0, pi: 0, finger: false, ir: 1200, rssi: -55,
          up: Math.floor((Date.now() - started) / 1000) }
      : { t: Date.now() - started, bpm: +bpm.toFixed(1), spo2: +spo2.toFixed(1),
          pi: +(1.4 + Math.random() * 0.8).toFixed(2), finger: true, ir: 98000, rssi: -55,
          up: Math.floor((Date.now() - started) / 1000) };

    client.publish(`${base_}/vitals`, JSON.stringify(payload));
  }, 1000);
});

client.on('error', (e) => { console.error('[sim] error:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    client.publish(`${base_}/status`, 'offline', { retain: true }, () => {
      client.end(true, () => process.exit(0));
    });
  });
}
