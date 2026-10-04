#!/usr/bin/env bash
# Manage the local ThreadHarbor dev services.
#
# Usage:
#   dev.sh <start|stop|restart|status> [web|hostd|all] [options]
#
#   start    start a service (no-op when it is already running)
#   stop     stop a service (SIGTERM via its pid file, waits for the port)
#   restart  stop then start
#   status   show pid/log/port state (default target: all)
#
# Targets:
#   web    DSH Web for a channel (test by default -> http://127.0.0.1:3081)
#   hostd  local dev hostd (default port 62846; designed data dir per channel)
#   all    both (default target)
#
# Options:
#   --data-dir <path>   override the hostd data directory (holds + journal) [hostd]
#   --frame-log         start hostd with THREADHARBOR_FRAME_LOG=1 (new holds only)
#
# Environment overrides:
#   THREADHARBOR_DSH_BIN        dsh launcher (default: scripts/dsh-wrapper.sh)
#   THREADHARBOR_CHANNEL        stable | test        (default: test)
#   THREADHARBOR_WEB_PORT       web port             (default: 3081)
#   THREADHARBOR_DSH_HOME       DSH home per channel (default: ~/.dsh-threadharbor-<channel>)
#   THREADHARBOR_WEB_LOG        web log path         (default: $DSH_HOME/threadharbor-runtime/web.log)
#   THREADHARBOR_WEB_PID        web pid path         (default: .../web.pid)
#   THREADHARBOR_HOSTD_PORT     hostd listen port    (default: 62846)
#   THREADHARBOR_HOSTD_DATA_DIR hostd --data-dir     (default: the designed root below)
#   THREADHARBOR_HOSTD_LOG      hostd log path       (default: /tmp/threadharbor-hostd-$port.log)
#   THREADHARBOR_HOSTD_PID      hostd pid path       (default: /tmp/threadharbor-hostd-$port.pid)
#
# Notes:
#   - Killing or restarting hostd DOES stop the agents: they now run inside it,
#     one process per backend kind, instead of one detached worker per session.
#     Sessions are not lost — the first attach after the restart brings the
#     backend back and reopens the session.
#   - THREADHARBOR_FRAME_LOG only affects agents started after the restart
#     (each backend's agent reads it once at process start).
#   - The hostd data dir is a designed location, not a generated one:
#     ~/.local/state/threadharbor/<channel>/hostd, the same shape the gateway
#     deploys on SSH hosts. It holds sessions.json, host-id, the Grok serve
#     secret, holds/<id>/ journals and dsh-sessions/ history, and it must
#     survive restarts. Do not point --data-dir at /tmp or a mktemp -d path:
#     the OS clears those, which loses every session and re-rolls the Grok
#     secret into a mismatch with an already running `grok agent serve`.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- defaults / overrides ---------------------------------------------------
channel="${THREADHARBOR_CHANNEL:-test}"
web_port="${THREADHARBOR_WEB_PORT:-3081}"
dsh_home="${THREADHARBOR_DSH_HOME:-$HOME/.dsh-threadharbor-$channel}"
web_log="${THREADHARBOR_WEB_LOG:-$dsh_home/threadharbor-runtime/web.log}"
web_pid="${THREADHARBOR_WEB_PID:-$dsh_home/threadharbor-runtime/web.pid}"
hostd_port="${THREADHARBOR_HOSTD_PORT:-62846}"
hostd_log="${THREADHARBOR_HOSTD_LOG:-/tmp/threadharbor-hostd-$hostd_port.log}"
hostd_pid="${THREADHARBOR_HOSTD_PID:-/tmp/threadharbor-hostd-$hostd_port.pid}"
hostd_data="${THREADHARBOR_HOSTD_DATA_DIR:-$HOME/.local/state/threadharbor/$channel/hostd}"
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
  local patch="$root/deploy/channels/$channel.patch.yml"
  [[ -f "$patch" ]] || die "channel patch not found: $patch (channel=$channel)"
  mkdir -p "$(dirname "$web_log")" "$(dirname "$web_pid")"
  guard_orphan "$web_pid" "$web_port"
  if pid_alive "$web_pid"; then
    info "web already running: pid $(cat "$web_pid") http://127.0.0.1:$web_port"
    return 0
  fi
  info "starting web (channel=$channel port=$web_port home=$dsh_home)"
  (
    cd "$root"
    env DSH_HOME="$dsh_home" nohup "$dsh_bin" --profile web --patch "$patch" --port "$web_port" \
      >>"$web_log" 2>&1 < /dev/null &
    echo $! >"$web_pid"
  )
  wait_port_up "$web_port" 30 || { info "web not answering yet; log: $web_log"; tail -n 20 "$web_log" 2>/dev/null || true; return 1; }
  info "web up: http://127.0.0.1:$web_port (pid $(cat "$web_pid"), log $web_log)"
}

# ---- hostd ------------------------------------------------------------------
hostd_start() {
  [[ -n "$hostd_data" ]] || die "hostd needs a data dir (--data-dir PATH or THREADHARBOR_HOSTD_DATA_DIR)"
  case "$hostd_data" in
    /tmp/*|/private/tmp/*|/var/folders/*)
      info "warning: $hostd_data is a temporary path the OS may clear; sessions, journals and the Grok serve secret would be lost."
      info "warning: the designed root is $HOME/.local/state/threadharbor/$channel/hostd — pass nothing to use it."
      ;;
  esac
  [[ -d "$hostd_data" ]] || info "created data dir: $hostd_data"
  mkdir -p "$hostd_data" "$(dirname "$hostd_log")"
  guard_orphan "$hostd_pid" "$hostd_port"
  if pid_alive "$hostd_pid"; then
    info "hostd already running: pid $(cat "$hostd_pid") port $hostd_port"
    return 0
  fi
  info "starting hostd (port=$hostd_port data=$hostd_data frameLog=$frame_log)"
  (
    cd "$root"
    if ((frame_log)); then
      env THREADHARBOR_FRAME_LOG=1 THREADHARBOR_FRAME_LOG_MAX=262144 nohup "$node_bin" "$root/packages/hostd/lib/bin.js" --port "$hostd_port" --data-dir "$hostd_data" \
        >>"$hostd_log" 2>&1 < /dev/null &
    else
      nohup "$node_bin" "$root/packages/hostd/lib/bin.js" --port "$hostd_port" --data-dir "$hostd_data" \
        >>"$hostd_log" 2>&1 < /dev/null &
    fi
    echo $! >"$hostd_pid"
  )
  wait_port_up "$hostd_port" 15 || { info "hostd not answering yet; log: $hostd_log"; tail -n 20 "$hostd_log" 2>/dev/null || true; return 1; }
  info "hostd up: port $hostd_port (pid $(cat "$hostd_pid"), log $hostd_log)"
}

# ---- status ----------------------------------------------------------------
web_status() {
  if pid_alive "$web_pid"; then
    if port_busy "$web_port"; then state="listening"; else state="pid alive, port $web_port free"; fi
    info "web: pid $(cat "$web_pid") port $web_port ($state) log $web_log"
  elif port_busy "$web_port"; then
    # The port is serving but no pid file points at it: something started this
    # outside dev.sh. Reporting "not running" here is what lets a stale build
    # keep answering for hours while every check says everything is fine.
    info "web: UNMANAGED process on port $web_port (no pid file $web_pid) — restart it manually to pick up a new build"
  else
    info "web: not running (pid file $web_pid)"
  fi
}
hostd_status() {
  if pid_alive "$hostd_pid"; then
    if port_busy "$hostd_port"; then state="listening"; else state="pid alive, port $hostd_port free"; fi
    info "hostd: pid $(cat "$hostd_pid") port $hostd_port ($state) data $hostd_data log $hostd_log"
  elif port_busy "$hostd_port"; then
    info "hostd: UNMANAGED process on port $hostd_port (no pid file $hostd_pid) — restart it manually to pick up a new build"
  else
    info "hostd: not running (pid file $hostd_pid, data $hostd_data)"
  fi
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
    hostd)
      case "$action" in
        start) hostd_start ;;
        stop) guard_orphan "$hostd_pid" "$hostd_port"; stop_pid "$hostd_pid" "$hostd_port" ;;
        restart) guard_orphan "$hostd_pid" "$hostd_port"; stop_pid "$hostd_pid" "$hostd_port"; hostd_start ;;
        status) hostd_status ;;
      esac
      ;;
    all)
      case "$action" in
        start) hostd_start; web_start ;;
        stop) guard_orphan "$hostd_pid" "$hostd_port"; stop_pid "$hostd_pid" "$hostd_port"; guard_orphan "$web_pid" "$web_port"; stop_pid "$web_pid" "$web_port" ;;
        restart) guard_orphan "$hostd_pid" "$hostd_port"; stop_pid "$hostd_pid" "$hostd_port"; guard_orphan "$web_pid" "$web_port"; stop_pid "$web_pid" "$web_port"; hostd_start; web_start ;;
        status) hostd_status; web_status ;;
      esac
      ;;
    *) die "unknown target: $target (web|hostd|all)" ;;
  esac
}

# ---- arg parsing ------------------------------------------------------------
action=""
target="all"
declare -a positional=()
while (($# > 0)); do
  case "$1" in
    --data-dir) shift; [[ $# -gt 0 ]] || die "--data-dir needs a path"; hostd_data="$1" ;;
    --frame-log) frame_log=1 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    start|stop|restart|status) positional+=("$1") ;;
    web|hostd|all) positional+=("$1") ;;
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
