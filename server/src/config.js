const env = process.env;

export const config = {
  port:          Number(env.PORT ?? 3000),
  mqttUrl:       env.MQTT_URL ?? 'mqtt://localhost:1883',
  mqttUser:      env.MQTT_USER || undefined,
  mqttPass:      env.MQTT_PASS || undefined,
  retentionDays: Number(env.RETENTION_DAYS ?? 7),

  // Topics the firmware publishes to: vitals/<device>/{vitals,ppg,status}
  topicRoot: 'vitals',

  // ~10 s of 50 Hz waveform held in memory so a browser that connects
  // mid-measurement sees a populated trace immediately.
  ppgBufferSamples: 500,

  // Beats retained in memory for the live HRV window. ~5 minutes at 70 bpm,
  // which is the usual short-term HRV horizon.
  rrWindowBeats: 350,

  // A device that goes quiet for this long is shown as stale, even without
  // an MQTT last-will (e.g. the broker restarted).
  staleAfterMs: 5000,
};
