# iot-vitals

A local-first pulse oximetry dashboard: an **ESP32** reads an **MH-ET LIVE
MAX30102** over I²C, publishes over MQTT, and a Node server stores the history
and streams it to a live browser dashboard.

Two boards are supported; pick the matching PlatformIO env:

| Board | env | SDA | SCL |
|-------|-----|-----|-----|
| ESP32 DevKit V1 (default) | `esp32dev` | `GPIO21` | `GPIO22` |
| Seeed XIAO ESP32C3 | `seeed_xiao_esp32c3` | `D4` (GPIO6) | `D5` (GPIO7) |

> **Not a medical device.** The MAX30102 is a hobbyist optical sensor and these
> readings are uncalibrated. Use them to learn about photoplethysmography —
> never to make a health decision.

```
XIAO ESP32C3 ──I²C──> MAX30102          firmware/   Arduino, PlatformIO
     │                                              beat detection + SpO₂
     │ WiFi / MQTT (JSON)
     ▼
Mosquitto broker :1883                  broker/     Docker
     ▼
Node server ── SQLite ── WebSocket       server/     node:sqlite, mqtt, ws
     ▼
Browser dashboard :3000                 web/        no build step
```

## Wiring

| MAX30102 | ESP32 DevKit V1 | XIAO ESP32C3 |
|----------|-----------------|--------------|
| `VIN`    | `3V3`           | `3V3` |
| `GND`    | `GND`           | `GND` |
| `SDA`    | `GPIO21`        | `D4` (GPIO6) |
| `SCL`    | `GPIO22`        | `D5` (GPIO7) |

The MH-ET board regulates and level-shifts, so `3V3` is correct for both.

The module has its own pull-ups, so no extra resistors are needed. `INT`, `RD`
and `IRD` are left unconnected.

## Running it

```bash
./start.sh            # broker + server, opens the dashboard, tails the log
./start.sh status     # what is up, and what each node reports
./start.sh stop       # stops both
./start.sh flash      # build and upload firmware
./start.sh monitor    # serial monitor
```

`./start.sh` is idempotent — running it twice reports what is already up rather
than starting duplicates. It installs server dependencies on first use and
prints the broker's LAN address, which is the value `secrets.h` needs as
`MQTT_HOST`.

## Setup

### 1. Broker

```bash
docker compose up -d
```

Anonymous access on port 1883, fine for a trusted LAN. `broker/config/mosquitto.conf`
has the three steps to add a password if you want one.

### 2. Server + dashboard

```bash
cd server
npm install
npm start          # http://localhost:3000
```

Only two dependencies — history uses Node 24's built-in `node:sqlite`, so there
is nothing to compile. Config is optional: copy `.env.example` to `.env` to
change the port, broker URL or retention window.

### 3. Firmware

```bash
cd firmware
cp include/secrets.example.h include/secrets.h
$EDITOR include/secrets.h        # WiFi, broker IP, device id
~/.platformio/penv/bin/pio run -t upload
~/.platformio/penv/bin/pio device monitor
```

`MQTT_HOST` must be the **LAN address** of the machine running the broker
(`hostname -I`), not `localhost` — the ESP32 resolves it from the network.

PlatformIO isn't on your `PATH`. Either use the full path above, or add it:

```bash
echo 'export PATH="$HOME/.platformio/penv/bin:$PATH"' >> ~/.bashrc
```

### No hardware yet?

The simulator publishes exactly what the firmware does:

```bash
node tools/simulate.js              # a healthy finger on the sensor
node tools/simulate.js sim-02 --no-finger   # an idle node
```

Run several at once with different ids — the dashboard grows a device picker.

## MQTT contract

All topics are `vitals/<device-id>/…`, payloads are JSON except `status`.

| Topic | Rate | Payload |
|-------|------|---------|
| `…/vitals` | 1 Hz | `{t, bpm, spo2, pi, finger, ir, rssi, up}` |
| `…/ppg` | 2 Hz | `{t, fs, ppg: [25 int16]}` — baseline-removed IR, 50 Hz |
| `…/ibi` | per beat | `{t, ibi: [ms, …]}` — intervals between accepted beats |
| `…/status` | on change | `online` / `offline`, retained, `offline` is the MQTT last will |

`t` is **milliseconds since boot**, not wall clock. The server stamps everything
with its own time and keeps `up` as an uptime readout.

## How the numbers are produced

**Heart rate** — the SparkFun library's `checkForBeat()` runs a DC filter and a
low-pass over the IR channel and reports peaks. Intervals outside 300–2000 ms
(30–200 bpm) are discarded as motion artefacts, and the readout is the mean of
the last 8 accepted intervals, published only once 3 beats agree.

**SpO₂** — ratio-of-ratios over a 2-second window:

```
R = (AC_red / DC_red) / (AC_ir / DC_ir)
SpO₂ = -45.060·R² + 30.354·R + 94.845
```

Oxygenated and deoxygenated haemoglobin absorb 660 nm and 880 nm light
differently, so `R` tracks saturation. AC is the RMS of the mean-removed signal;
DC is the window mean. The polynomial is Maxim's empirical curve for this sensor
family — good for trends, not traceable to a calibrated reference.

**Perfusion index** — `AC_ir / DC_ir × 100`, the honest quality signal. Below
~0.5 % the dashboard says the SpO₂ number is low-confidence instead of showing
it plainly.

**History** is written only while a finger is detected, so the charts show real
measurement sessions rather than long flat runs of zeros. Gaps between sessions
break the line instead of being drawn through.

**Heart rate variability** comes from the intervals between individual beats,
which are published as they occur on `…/ibi` rather than averaged away. HRV
measures autonomic state rather than cardiac output — two people at the same
bpm can differ enormously.

| Metric | What it is |
|--------|------------|
| RMSSD | root mean square of successive differences; the standard short-term measure |
| SDNN | standard deviation of the intervals; longer-term variability |
| pNN50 | share of consecutive pairs differing by more than 50 ms |
| SD1 / SD2 | Poincaré spread across and along the line of identity |

A missed beat doubles an interval and a double-counted one halves it, and RMSSD
is a difference measure so it is hypersensitive to exactly that. Intervals more
than 20% from the running median are rejected before any metric is computed, and
the count of rejects is shown so a noisy recording is visible rather than
silently averaged. Nothing is reported below 20 clean beats.

The **Poincaré plot** draws each interval against the next. Shape is the
reading: a tight cluster on the diagonal is low variability, a wide cloud is
high, and ectopic beats land as satellites off the diagonal that no single
number reveals. Both axes share one scale so the geometry is not distorted.

## API

| Route | Returns |
|-------|---------|
| `GET /api/health` | broker connection, device and client counts |
| `GET /api/devices` | live devices plus everything ever recorded |
| `GET /api/history?device=<id>&range=5m\|15m\|1h\|6h\|24h` | bucketed averages |
| `GET /api/hrv?device=<id>&minutes=5` | HRV metrics and Poincaré pairs |
| `WS /ws` | `snapshot`, then `vitals` / `ppg` / `status` frames |

## Troubleshooting

**`[max30102] not found` on boot** — the firmware runs an I²C scan first; check
the monitor for `device at 0x57`. Nothing at all usually means SDA/SCL swapped
or the module on 5 V with no common ground.

**Board doesn't appear as a serial port** — hold `BOOT`, tap `RESET`, release
`BOOT` to force the bootloader. Your user is already in `dialout`.

**Dashboard says "device offline"** — check `docker compose logs mosquitto`, and
confirm `MQTT_HOST` in `secrets.h` is the broker machine's LAN IP.

**Readings jump around** — cover the sensor fully, rest your hand on the table,
and watch the perfusion index; under ~0.5 % nothing downstream is reliable.
