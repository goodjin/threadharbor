/**
 * Named fragments of the remote shell script the SSH manager runs on a peer.
 *
 * `buildInstallScript` in `manager.ts` composes its byte-stable install script
 * from these pieces: the remote environment first (with the install lines it
 * owns spliced in at their fixed position), then the success emission and
 * already-running detection, then the start branch. The same environment and
 * start branch pair is meant to later assemble a standalone "start the remote
 * DSH" script, so every shell line here is copied verbatim from the script
 * that shipped first — a single changed byte would break deployment of freshly
 * provisioned machines.
 */

import { shellQuote } from './parse.ts'

/**
 * Environment and helper definitions every remote DSH script needs before it
 * starts anything: header variables, `PATH`, `dsh_home` / `state` /
 * `log_file`, the agents patch file, the identity file, the wildcard-bind
 * guard, `dsh_bin` / `dsh_args`, the systemd unit, and the `health_url` /
 * `port_pids` / `port_busy` / `launch_url_from_log` helpers.
 *
 * `installLines` are spliced after the `DSH_HOME` export, the position the
 * install script has always used (a start script omits them); `releaseDir`
 * adds the `release=` header variable the install script needs to install the
 * local plugin.
 */
export function buildRemoteEnv(input: {
  readonly channel: string
  readonly nodePath: string
  readonly remotePort: string
  readonly hostId: string
  readonly hostTitle: string
  readonly remoteAgentsPatch: string
  readonly releaseDir?: string
  readonly installLines?: readonly string[]
}): string {
  const { channel, nodePath, remotePort, hostId, hostTitle, remoteAgentsPatch, releaseDir, installLines } = input
  return [
    'set -eu',
    `channel=${shellQuote(channel)}`,
    ...(releaseDir === undefined ? [] : [`release=${releaseDir}`]),
    `node=${shellQuote(nodePath)}`,
    `port=${remotePort}`,
    `host_id=${shellQuote(hostId)}`,
    `host_title=${shellQuote(hostTitle)}`,
    'node_dir="$(dirname "$node")"',
    'common_path="$node_dir:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
    'export PATH="$common_path"',
    'dsh_home="$HOME/.dsh-threadharbor-$channel"',
    'state="$HOME/.local/state/threadharbor/$channel"',
    'log_file="$state/dsh-web.log"',
    'export DSH_HOME="$dsh_home"',
    ...(installLines ?? []),
    `agents_patch_yaml=${shellQuote(remoteAgentsPatch)}`,
    'agents_patch="$dsh_home/profiles/web/threadharbor-remote-agents.patch.yml"',
    'mkdir -p "$(dirname "$agents_patch")"',
    'printf \'%s\' "$agents_patch_yaml" > "$agents_patch"',
    'bind_host="127.0.0.1"',
    'identity_file="$dsh_home/profiles/web/threadharbor-identity.env"',
    'printf \'DSH_HOST_ID=%s\\nDSH_HOST_TITLE=%s\\n\' "$host_id" "$host_title" > "$identity_file"',
    'case "$bind_host" in (0.0.0.0|"") echo "refusing wildcard bind" >&2; exit 1;; esac',
    'dsh_bin="$(command -v dsh)"',
    'dsh_args="--profile web --no-open --port $port --host $bind_host --patch $agents_patch"',
    'service_name="threadharbor-dsh-web-$channel.service"',
    'service="$HOME/.config/systemd/user/$service_name"',
    'printf \'%s\\n\' \'[Unit]\' "Description=ThreadHarbor DSH Web ($channel)" \'After=network-online.target\' \'\' \'[Service]\' "Environment=PATH=$common_path" "Environment=DSH_HOME=$dsh_home" "EnvironmentFile=-$identity_file" "ExecStart=$dsh_bin $dsh_args" \'Restart=on-failure\' \'RestartSec=2\' \'\' \'[Install]\' \'WantedBy=default.target\' > "$service"',
    'health_url() { printf \'http://%s:%s/\' "$bind_host" "$port"; }',
    'port_pids() { { if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:' + remotePort + ' -sTCP:LISTEN -t 2>/dev/null; elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :' + remotePort + '" 2>/dev/null | grep -o "pid=[0-9]*" | cut -d= -f2; elif command -v fuser >/dev/null 2>&1; then fuser ' + remotePort + '/tcp 2>/dev/null; fi; } | tr " " "\\n" | grep -E "^[0-9]+$" | sort -u; }',
    'port_busy() { if command -v ss >/dev/null 2>&1; then [ -n "$(ss -ltnH "sport = :' + remotePort + '" 2>/dev/null)" ]; elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:' + remotePort + ' -sTCP:LISTEN >/dev/null 2>&1; elif command -v fuser >/dev/null 2>&1; then fuser ' + remotePort + '/tcp >/dev/null 2>&1; else return 1; fi; }',
    'launch_url_from_log() {',
    '  url=""',
    '  if [ -f "$log_file" ]; then url="$(grep -E \'^dsh web: \' "$log_file" | tail -1 | sed \'s/^dsh web: //\')"; fi',
    '  if [ -z "$url" ] && command -v journalctl >/dev/null 2>&1; then url="$(journalctl --user -u "$service_name" -n 40 --no-pager 2>/dev/null | grep \'dsh web:\' | tail -1 | sed \'s/.*dsh web: //\')"; fi',
    '  printf \'%s\' "$url"',
    '}',
  ].filter(line => line !== '').join('; ')
}

/**
 * The start branch: systemd user service when systemd is present, otherwise
 * kill whatever holds the port and relaunch under `nohup` with a pid file —
 * then the health wait loop that declares success or gives up.
 */
export function buildStartBranch(input: {
  readonly channel: string
  readonly remotePort: string
}): string {
  return [
    'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl --user daemon-reload && systemctl --user enable --now "$service_name" && systemctl --user restart "$service_name"',
    'else',
    'pid_file="$state/dsh-web.pid"',
    'if [ -f "$pid_file" ]; then old_pid="$(cat "$pid_file")"; case "$old_pid" in (*[!0-9]*|"") ;; (*) kill "$old_pid" 2>/dev/null || true ;; esac; fi',
    'for pid in $(port_pids); do kill "$pid" 2>/dev/null || true; done',
    'for _ in 1 2 3 4 5 6 7 8 9 10; do port_busy || break; sleep 0.5; done',
    'nohup $dsh_bin $dsh_args >>"$log_file" 2>&1 </dev/null & printf \'%s\\n\' "$!" > "$pid_file"',
    'fi',
    'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
    '  if command -v curl >/dev/null 2>&1; then code="$(curl -fsS -o /dev/null -w "%{http_code}" "$(health_url)" 2>/dev/null || true)"; case "$code" in 200|401) emit_success;; esac; fi',
    '  sleep 1',
    'done',
    'echo "DSH Web did not become healthy" >&2',
    'exit 1',
  ].filter(line => line !== '').join('; ')
}

/** The standalone start script: remote environment followed by the start branch. */
export function buildStartScript(input: {
  readonly channel: string
  readonly nodePath: string
  readonly remotePort: string
  readonly hostId: string
  readonly hostTitle: string
  readonly remoteAgentsPatch: string
}): string {
  return [buildRemoteEnv(input), buildStartBranch(input)].join('; ')
}
