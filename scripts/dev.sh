#!/usr/bin/env bash
# Manage the local ThreadHarbor dev services.
#
# Usage:
#   dev.sh <start|stop|restart|status> [web|all] [options]
#
#   start    start a service (no-op when it is already running)
#   stop     stop a service (SIGTERM via its pid file, waits for the port)
#   restart  stop then start
#   status   show pid/log/port state (default target: all)
#
# Targets:
#   web    DSH Web for a channel (test by default -> http://127.0.0.1:3081)
#   all    the web target (default)
#
# Options:
#   --frame-log         start web with THREADHARBOR_FRAME_LOG=1
#
# Environment overrides:
#   THREADHARBOR_DSH_BIN        dsh launcher (default: scripts/dsh-wrapper.sh)
#   THREADHARBOR_CHANNEL        stable | test        (default: test)
#   THREADHARBOR_WEB_PORT       web port             (default: 3081)
#   THREADHARBOR_DSH_HOME       DSH home per channel (default: ~/.dsh-threadharbor-<channel>)
#   THREADHARBOR_WEB_LOG        web log path         (default: $DSH_HOME/threadharbor-runtime/web.log)
#   THREADHARBOR_WEB_PID        web pid path         (default: .../web.pid)
#
# Notes:
#   - There is no separate hostd process any more (migration phase 6). The ACP
#     and preset plugins run in-process inside the web host, so agents are
#     started and stopped with it and there is nothing else to supervise here.
#   - THREADHARBOR_FRAME_LOG only affects agents started after a restart
#     (each backend's agent reads it once at process start).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- defaults / overrides ---------------------------------------------------
channel="${THREADHARBOR_CHANNEL:-test}"
web_port="${THREADHARBOR_WEB_PORT:-3081}"
dsh_home="${THREADHARBOR_DSH_HOME:-$HOME/.dsh-threadharbor-$channel}"
web_log="${THREADHARBOR_WEB_LOG:-$dsh_home/threadharbor-runtime/web.log}"
web_pid="${THREADHARBOR_WEB_PID:-$dsh_home/threadharbor-runtime/web.pid}"
frame_log=0

if [[ -n "${THREADHARBOR_DSH_BIN:-}" ]]; then
  dsh_bin="$THREADHARBOR_DSH_BIN"
elif [[ -x "$root/scripts/dsh-wrapper.sh" ]]; then
  dsh_bin="$root/scripts/dsh-wrapper.sh"
else
  echo "dev: no dsh launcher; set THREADHARBOR_DSH_BIN or restore scripts/dsh-wrapper.sh" >&2
  exit 1
fi
node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || { echo "dev: node not found on PATH" >&2; exit 1; }

# ---- helpers ----------------------------------------------------------------
die() { echo "dev: $*" >&2; exit 1; }
info() { echo "dev: $*"; }

port_busy() {
  # macOS /bin/bash 3.2 has no /dev/tcp; prefer lsof, fall back to nc.
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}

pid_alive() { [[ -f "$1" ]] && local pid && pid="$(cat "$1" 2>/dev/null || true)" && [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }

wait_port_gone() { # $1 port, $2 seconds
  local port=$1 limit=$2 waited=0
  while port_busy "$port" && ((waited < limit * 2)); do sleep 0.5; ((waited += 1)); done
  port_busy "$port" && return 1 || return 0
}

wait_port_up() { # $1 port, $2 seconds
  local port=$1 limit=$2 waited=0
  while ! port_busy "$port" && ((waited < limit * 2)); do sleep 0.5; ((waited += 1)); done
  port_busy "$port" && return 0 || return 1
}

# Refuse to manage a port held by a process we do not have a pid file for.
guard_orphan() { # $1 pid file, $2 port
  if [[ ! -f "$1" ]] && port_busy "$2"; then
    info "no pid file ($1), but port $2 is busy"
    die "refusing to touch an unmanaged process; stop it manually or set THREADHARBOR_*_PID/LOG to its files"
  fi
}

stop_pid() { # $1 pid file, $2 port
  local pidfile=$1 port=$2
  if pid_alive "$pidfile"; then
    local pid
    pid="$(cat "$pidfile")"
    info "stopping pid $pid (port $port)"
    kill -TERM "$pid" 2>/dev/null || true
    wait_port_gone "$port" 15 || { kill -KILL "$pid" 2>/dev/null || true; wait_port_gone "$port" 5 || true; }
  fi
  rm -f "$pidfile"
  if port_busy "$port"; then
    info "port $port still busy; waiting for it to free"
    wait_port_gone "$port" 10 || die "port $port did not free"
  fi
}

# ---- web --------------------------------------------------------------------
web_start() {
  # The per-channel patch files went away with the hostd deployment (phase 6).
  # The plugin is composed by the profile now, so a patch is optional: use one
  # if it is there, and otherwise start on the profile's own composition.
  local patch="$root/deploy/channels/$channel.patch.yml"
  local patch_arg=()
  if [[ -f "$patch" ]]; then patch_arg=(--patch "$patch"); fi
  mkdir -p "$(dirname "$web_log")" "$(dirname "$web_pid")"
  guard_orphan "$web_pid" "$web_port"
  if pid_alive "$web_pid"; then
    info "web already running: pid $(cat "$web_pid") http://127.0.0.1:$web_port"
    return 0
  fi
  info "starting web (channel=$channel port=$web_port home=$dsh_home)"
  (
    cd "$root"
    env DSH_HOME="$dsh_home" nohup "$dsh_bin" --profile web "${patch_arg[@]}" --port "$web_port" \
      >>"$web_log" 2>&1 < /dev/null &
    echo $! >"$web_pid"
  )
  wait_port_up "$web_port" 30 || { info "web not answering yet; log: $web_log"; tail -n 20 "$web_log" 2>/dev/null || true; return 1; }
  info "web up: http://127.0.0.1:$web_port (pid $(cat "$web_pid"), log $web_log)"
}

# ---- dispatch ---------------------------------------------------------------
run() { # $1 action, $2 target
  local action=$1 target=$2
  case "$target" in
    web)
      case "$action" in
        start) web_start ;;
        stop) guard_orphan "$web_pid" "$web_port"; stop_pid "$web_pid" "$web_port" ;;
        restart) guard_orphan "$web_pid" "$web_port"; stop_pid "$web_pid" "$web_port"; web_start ;;
        status) web_status ;;
      esac
      ;;
    all)
      case "$action" in
        start|restart) web_start ;;
        stop) guard_orphan "$web_pid" "$web_port"; stop_pid "$web_pid" "$web_port" ;;
        status) web_status ;;
      esac
      ;;
    *) die "unknown target: $target (web|all)" ;;
  esac
}

# ---- arg parsing ------------------------------------------------------------
action=""
target="all"
declare -a positional=()
while (($# > 0)); do
  case "$1" in
    --frame-log) frame_log=1 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    start|stop|restart|status) positional+=("$1") ;;
    web|all) positional+=("$1") ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

action="${positional[0]:-}"
if [[ -n "${positional[1]:-}" ]]; then target="${positional[1]}"; fi
case "$action" in
  start|stop|restart|status) run "$action" "$target" ;;
  *) sed -n '2,34p' "$0"; exit 1 ;;
esac
