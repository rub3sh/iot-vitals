#!/usr/bin/env bash
#
# iot-vitals — one script to run the whole local stack.
#
#   ./start.sh            start broker + server, open the dashboard
#   ./start.sh -d         start detached (no log tail, for scripts)
#   ./start.sh stop       stop the server and the broker
#   ./start.sh status     what is running, and what the sensor node reports
#   ./start.sh flash      build and upload the firmware
#   ./start.sh monitor    serial monitor for the node
#   ./start.sh logs       follow the server log
#
# Start runs in the foreground and tails the server log; Ctrl+C shuts it down.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$ROOT/.run"
LOG="$RUN/server.log"
PIDFILE="$RUN/server.pid"
PIO="${PIO:-$HOME/.platformio/penv/bin/pio}"
PORT="${PORT:-3000}"
SERIAL="${SERIAL:-/dev/ttyACM0}"
ENV_NAME="${ENV_NAME:-esp32dev}"

mkdir -p "$RUN"

# Colour only when attached to a terminal, so piping stays clean.
if [[ -t 1 ]]; then
  B=$'\e[1m'; DIM=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'
else
  B=''; DIM=''; G=''; Y=''; R=''; N=''
fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '  %s✗%s %s\n' "$R" "$N" "$1" >&2; exit 1; }
step() { printf '%s==>%s %s\n' "$B" "$N" "$1"; }

lan_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

port_open() {  # host port
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&-; return 0; }
  return 1
}

wait_for() {  # description command... — retries for ~20s
  local what="$1"; shift
  for _ in $(seq 1 40); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  warn "timed out waiting for $what"
  return 1
}

# Find the running server. The pidfile is the fast path, but it can be lost or
# truncated (a killed shell, a crash mid-write) and then the process is still
# holding the port while the script insists nothing is running — unable to stop
# it or start over. Fall back to matching the actual process.
# Real server processes only. A bare `pgrep -f src/index.js` also matches any
# shell whose command line merely mentions that path — including the one
# running this script, which turned a pkill into a self-kill. Requiring the
# cmdline to actually start with `node` excludes them.
find_server_pids() {
  local p cmd
  for p in $(pgrep -f 'src/index\.js' 2>/dev/null); do
    [[ "$p" == "$$" || "$p" == "${PPID:-}" ]] && continue
    cmd="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
    [[ "$cmd" == node\ * || "$cmd" == */node\ * ]] || continue
    echo "$p"
  done
}

server_pid() {
  local pid
  if [[ -f "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; return 0; fi
  fi
  pid="$(find_server_pids | head -1)"
  if [[ -n "$pid" ]]; then
    echo "$pid" >"$PIDFILE"
    echo "$pid"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------- preflight
preflight() {
  command -v docker >/dev/null || die "docker not found"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
  command -v node >/dev/null   || die "node not found"
  docker info >/dev/null 2>&1  || die "docker daemon not reachable — is it running?"

  if [[ ! -d "$ROOT/server/node_modules" ]]; then
    step "installing server dependencies (first run)"
    (cd "$ROOT/server" && npm install --silent) || die "npm install failed"
  fi

  if [[ ! -f "$ROOT/firmware/include/secrets.h" ]]; then
    warn "firmware/include/secrets.h missing — copy secrets.example.h and fill it in"
  fi
}

# -------------------------------------------------------------------- start
start_broker() {
  step "broker"
  if port_open 127.0.0.1 1883; then
    ok "mosquitto already listening on 1883"
  else
    (cd "$ROOT" && docker compose up -d) >/dev/null 2>&1 || die "failed to start mosquitto"
    wait_for "mosquitto" port_open 127.0.0.1 1883 && ok "mosquitto up on 1883"
  fi
}

start_server() {
  step "server"
  if server_pid >/dev/null; then
    ok "already running (pid $(server_pid))"
    return
  fi
  if port_open 127.0.0.1 "$PORT"; then
    warn "port $PORT is already in use by something else"
    return
  fi
  # Launch node directly rather than through `npm start`. npm inserts two extra
  # processes (npm -> sh -c -> node) which keep their own pipes open, so a
  # piped `./start.sh | grep ...` never saw EOF and hung — and the pidfile
  # pointed at the npm wrapper instead of the server. setsid plus a closed
  # stdin detaches what remains.
  # --fork matters: plain setsid execs in place, leaving node a direct child of
  # this script, so bash waits on it and a piped invocation never returns.
  # Forking first reparents the server to init and detaches it for real.
  local launcher=""
  command -v setsid >/dev/null && launcher="setsid --fork"
  (cd "$ROOT/server" && PORT="$PORT" $launcher \
      node --env-file-if-exists=.env src/index.js >"$LOG" 2>&1 </dev/null &
   echo $! >"$PIDFILE") 2>/dev/null
  # setsid --fork means $! is the forker, not the server, so resolve the real
  # pid once it is up.
  sleep 0.4
  find_server_pids | head -1 >"$PIDFILE" 
  wait_for "server" curl -sf "http://localhost:$PORT/api/health" \
    && ok "listening on http://localhost:$PORT" \
    || { warn "server did not come up — last lines:"; tail -n 15 "$LOG"; }
}

open_dashboard() {
  local url="http://localhost:$PORT"
  command -v xdg-open >/dev/null && (xdg-open "$url" >/dev/null 2>&1 &) && ok "opened $url"
}

banner() {
  local ip; ip="$(lan_ip)"
  printf '\n%s  iot-vitals%s  %sready%s\n' "$B" "$N" "$G" "$N"
  printf '  %sdashboard%s  http://localhost:%s\n' "$DIM" "$N" "$PORT"
  [[ -n "$ip" ]] && printf '  %sbroker   %s  %s:1883  %s(use this as MQTT_HOST in secrets.h)%s\n' \
      "$DIM" "$N" "$ip" "$DIM" "$N"
  printf '  %slog      %s  %s\n' "$DIM" "$N" "${LOG/#$HOME/\~}"
  printf '\n  %sCtrl+C stops the server. Broker keeps running; ./start.sh stop ends both.%s\n\n' "$DIM" "$N"
}

cmd_start() {
  local detach=0 open=1
  for arg in "$@"; do
    case "$arg" in
      -d|--detach) detach=1; open=0 ;;
      --no-open)   open=0 ;;
    esac
  done

  preflight
  start_broker
  start_server
  (( open )) && open_dashboard
  banner

  # Detached: leave everything running and return, for scripts and CI.
  (( detach )) && return 0

  # Foreground: follow the log until interrupted, then shut the server down.
  trap 'printf "\n"; step "stopping server"; stop_server; exit 0' INT TERM
  tail -n 0 -f "$LOG" &
  wait $!
}

# --------------------------------------------------------------------- stop
stop_server() {
  local pid
  if pid="$(server_pid)"; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null
    for extra in $(find_server_pids); do kill -9 "$extra" 2>/dev/null; done
    ok "server stopped"
  else
    ok "server not running"
  fi
  rm -f "$PIDFILE"
}

# Foreground runs leave a `tail -f` behind if their shell was killed before the
# trap could fire. Reap any that are still following our log.
reap_tails() {
  local p cmd n=0
  for p in $(pgrep -f "tail .*$LOG" 2>/dev/null); do
    [[ "$p" == "$$" || "$p" == "${PPID:-}" ]] && continue
    cmd="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
    [[ "$cmd" == tail\ * || "$cmd" == */tail\ * ]] || continue
    kill -9 "$p" 2>/dev/null && n=$((n+1))
  done
  (( n > 0 )) && ok "reaped $n stray log tail(s)"
  return 0
}

cmd_stop() {
  step "stopping"
  stop_server
  reap_tails
  (cd "$ROOT" && docker compose down) >/dev/null 2>&1 && ok "broker stopped"
}

# ------------------------------------------------------------------- status
cmd_status() {
  step "services"
  port_open 127.0.0.1 1883 && ok "broker   listening on 1883" || warn "broker   down"
  if server_pid >/dev/null; then
    ok "server   running (pid $(server_pid)) on :$PORT"
  else
    port_open 127.0.0.1 "$PORT" && warn "server   port $PORT busy, not started by this script" \
                                || warn "server   down"
  fi
  [[ -e "$SERIAL" ]] && ok "serial   $SERIAL present" || warn "serial   $SERIAL absent (board unplugged?)"

  if curl -sf "http://localhost:$PORT/api/devices" >/dev/null 2>&1; then
    step "nodes"
    curl -s "http://localhost:$PORT/api/devices" | python3 -c '
import json, sys
d = json.load(sys.stdin)
devs = d.get("devices", [])
if not devs:
    print("  (none seen yet)")
for x in devs:
    v = x.get("vitals") or {}
    did = x.get("id", "?")
    state = "online " if x.get("online") else "offline"
    finger = "finger" if v.get("finger") else "no finger"
    bpm = v.get("bpm") or 0
    spo2 = v.get("spo2") or 0
    pi = v.get("pi") or 0
    print("  %-12s %s  %-9s  bpm=%3.0f  spo2=%4.1f  pi=%.2f%%"
          % (did, state, finger, bpm, spo2, pi))
' 2>&1 || true
  fi
}

# -------------------------------------------------------------- firmware ops
cmd_flash() {
  [[ -x "$PIO" ]] || die "platformio not found at $PIO (set PIO=/path/to/pio)"
  [[ -e "$SERIAL" ]] || die "$SERIAL not present — is the board plugged in?"
  step "building and uploading ($ENV_NAME)"
  "$PIO" run -d "$ROOT/firmware" -e "$ENV_NAME" -t upload --upload-port "$SERIAL"
}

cmd_monitor() {
  [[ -x "$PIO" ]] || die "platformio not found at $PIO"
  [[ -e "$SERIAL" ]] || die "$SERIAL not present — is the board plugged in?"
  step "serial monitor ($SERIAL) — Ctrl+C to exit"
  "$PIO" device monitor --port "$SERIAL" --baud 115200
}

cmd_logs() {
  [[ -f "$LOG" ]] || die "no log yet — start the stack first"
  tail -n 50 -f "$LOG"
}

# Normalise: a bare flag (./start.sh --no-open) still means "start".
CMD="start"
if [[ $# -gt 0 && "$1" != -* ]]; then CMD="$1"; shift; fi

case "$CMD" in
  start)   cmd_start "${1:-}" ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; sleep 1; cmd_start "$@" ;;
  status)  cmd_status ;;
  flash)   cmd_flash ;;
  monitor) cmd_monitor ;;
  logs)    cmd_logs ;;
  -h|--help|help)
    awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" ;;
  *) die "unknown command: $CMD  (try: start stop restart status flash monitor logs)" ;;
esac
