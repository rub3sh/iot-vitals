import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Ranges the dashboard can request, with the bucket size used to downsample
// each one to a few hundred points — enough resolution to read, small enough
// to send over the wire without thinking about it.
const RANGES = {
  '5m':  { ms: 5 * 60_000,        bucket: 1_000 },
  '15m': { ms: 15 * 60_000,       bucket: 5_000 },
  '1h':  { ms: 60 * 60_000,       bucket: 15_000 },
  '6h':  { ms: 6 * 60 * 60_000,   bucket: 60_000 },
  '24h': { ms: 24 * 60 * 60_000,  bucket: 300_000 },
};

export const RANGE_KEYS = Object.keys(RANGES);

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;

    CREATE TABLE IF NOT EXISTS readings (
      id     INTEGER PRIMARY KEY,
      device TEXT    NOT NULL,
      ts     INTEGER NOT NULL,   -- server-side epoch ms
      bpm    REAL,
      spo2   REAL,
      pi     REAL,
      rssi   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_readings_device_ts ON readings(device, ts);

    -- One row per heartbeat. HRV is computed from the spacing between
    -- individual beats, so unlike the 1 Hz summaries these cannot be averaged
    -- before storage without destroying the thing being measured.
    CREATE TABLE IF NOT EXISTS beats (
      id     INTEGER PRIMARY KEY,
      device TEXT    NOT NULL,
      ts     INTEGER NOT NULL,   -- server receipt time, epoch ms
      rr     INTEGER NOT NULL    -- interval to the previous beat, ms
    );
    CREATE INDEX IF NOT EXISTS idx_beats_device_ts ON beats(device, ts);
  `);

  const insertStmt = db.prepare(
    `INSERT INTO readings (device, ts, bpm, spo2, pi, rssi) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const devicesStmt = db.prepare(
    `SELECT device, MAX(ts) AS lastTs, COUNT(*) AS samples
       FROM readings GROUP BY device ORDER BY lastTs DESC`
  );
  const pruneStmt = db.prepare(`DELETE FROM readings WHERE ts < ?`);
  const insertBeatStmt = db.prepare(`INSERT INTO beats (device, ts, rr) VALUES (?, ?, ?)`);
  const beatsStmt = db.prepare(
    `SELECT ts, rr FROM beats WHERE device = ? AND ts >= ? ORDER BY ts ASC`);
  const pruneBeatsStmt = db.prepare(`DELETE FROM beats WHERE ts < ?`);

  return {
    /** Persist one summary reading. Only called for valid measurements. */
    insert({ device, ts, bpm, spo2, pi, rssi }) {
      insertStmt.run(device, ts, bpm ?? null, spo2 ?? null, pi ?? null, rssi ?? null);
    },

    /**
     * Bucketed averages over a range. Gaps between measurement sessions come
     * back as absent buckets rather than zeros, so the chart can break the
     * line instead of drawing a misleading dive to the axis.
     */
    history(device, rangeKey = '15m') {
      const range = RANGES[rangeKey] ?? RANGES['15m'];
      const since = Date.now() - range.ms;
      const bucket = Math.floor(range.bucket);

      return db.prepare(`
        SELECT (ts / ${bucket}) * ${bucket} AS t,
               AVG(bpm)  AS bpm,
               AVG(spo2) AS spo2,
               AVG(pi)   AS pi,
               COUNT(*)  AS n
          FROM readings
         WHERE device = ? AND ts >= ?
         GROUP BY ts / ${bucket}
         ORDER BY t ASC
      `).all(device, since);
    },

    /** Persist a batch of intervals that arrived together. */
    insertBeats(device, ts, intervals) {
      for (const rr of intervals) insertBeatStmt.run(device, ts, Math.round(rr));
    },

    /** Raw intervals for an HRV window, oldest first. */
    beatsSince(device, sinceMs) {
      return beatsStmt.all(device, Date.now() - sinceMs).map((r) => r.rr);
    },

    knownDevices() {
      return devicesStmt.all();
    },

    /** Drop history past the retention window. Returns rows removed. */
    prune(retentionDays) {
      const cutoff = Date.now() - retentionDays * 86_400_000;
      return pruneStmt.run(cutoff).changes + pruneBeatsStmt.run(cutoff).changes;
    },

    close() { db.close(); },
  };
}
