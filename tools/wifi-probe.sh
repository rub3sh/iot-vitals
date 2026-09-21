#!/usr/bin/env bash
# Flash the radio-only power probe and report a verdict.
# Use it to test a USB cable or port in about a minute:
#     tools/wifi-probe.sh
set -u
PIO="${PIO:-$HOME/.platformio/penv/bin/pio}"
PORT="${PORT:-/dev/ttyACM0}"
cd "$(dirname "$0")/../firmware" || exit 1

echo "==> flashing radio probe to $PORT"
"$PIO" run -e wifi_probe -t upload --upload-port "$PORT" 2>&1 \
  | grep -E "SUCCESS|FAILED|fatal error" | tail -2

echo "==> watching for 30s"
"$(dirname "$PIO")/python" - "$PORT" <<'PY'
import serial, time, os, sys, re
port = sys.argv[1]
end = time.time() + 30
p1 = p2 = p3 = boots = 0
NOISE = ('ESP-ROM:','Build:','Saved PC','SPIWP','mode:DIO','load:','entry ','rst:0x')
while time.time() < end:
    if not os.path.exists(port):
        time.sleep(0.2); continue
    try:
        s = serial.Serial(); s.port = port; s.baudrate = 115200; s.timeout = 1
        s.dtr = False; s.rts = False; s.open()
    except Exception:
        time.sleep(0.2); continue
    try:
        while time.time() < end:
            line = s.readline().decode('utf-8', 'replace').rstrip()
            if not line or line.startswith(NOISE):
                continue
            if line.startswith('[boot]'):   boots += 1
            if '[phase 1] OK' in line:      p1 += 1
            if '[phase 2] OK' in line:      p2 += 1
            if 'SURVIVED' in line:
                p3 += 1; print("   ", line)
            if re.match(r'^\s+\d+\)', line): print(line)
    except Exception:
        pass
    finally:
        try: s.close()
        except Exception: pass
    time.sleep(0.2)

print(f"\n  restarts={boots}  radio-off-ok={p1}  radio-on-ok={p2}  scans={p3}")
if p3 >= 2 and boots <= 1:
    print("  VERDICT: PASS — this cable/port sustains the radio.")
elif p2 and not p3:
    print("  VERDICT: MARGINAL — radio powers up but dies under scan load.")
elif p1 and not p2:
    print("  VERDICT: FAIL — dies the instant the radio powers up.")
    print("           Data path is fine; the supply cannot deliver the inrush.")
else:
    print("  VERDICT: INCONCLUSIVE — board never reached the radio-off baseline.")
PY
