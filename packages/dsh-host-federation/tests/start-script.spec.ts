import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildInstallScript } from '../src/ssh/manager.ts'
import { buildStartScript } from '../src/ssh/start-script.ts'

// Characterisation test: pins the exact bytes buildInstallScript emits so no
// edit can drop or alter a remote shell line silently. The expected text below
// is written out inline on purpose — it must not be regenerated from the
// implementation at test time. Regenerating it (as when the fragment joins
// changed from "; " to newlines for POSIX sh) is a deliberate, reviewed act.
describe('buildInstallScript', () => {
  it('builds the remote install script byte-for-byte for a fully specified host', () => {
    const script = buildInstallScript({
      channel: 'stable',
      releaseDir: '/srv/threadharbor/release',
      nodePath: '/usr/bin/node',
      remotePort: '3081',
      hostId: 'host-7f3a',
      hostTitle: 'Build Farm',
      upgrade: true,
      installFromGithub: true,
      remotePlugins: ['@threadharbor/plugin-a', '@threadharbor/plugin-b'],
      remoteAgentsPatch: 'agents:\n  - id: demo',
    })
    const expected = `set -eu
channel='stable'
release=/srv/threadharbor/release
node='/usr/bin/node'
port=3081
host_id='host-7f3a'
host_title='Build Farm'
node_dir="$(dirname "$node")"
common_path="$node_dir:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$common_path"
dsh_home="$HOME/.dsh-threadharbor-$channel"
state="$HOME/.local/state/threadharbor/$channel"
log_file="$state/dsh-web.log"
export DSH_HOME="$dsh_home"
if ! command -v dsh >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then echo "npm not found; install Node npm or place dsh on PATH" >&2; exit 1; fi
  npm install -g @deepseek-ai/dsh@">=0.2.0-rc.2 <0.3"
fi
plugin_specs='@threadharbor/plugin-a
@threadharbor/plugin-b'
printf '%s\\n' "$plugin_specs" | while IFS= read -r spec; do [ -z "$spec" ] && continue; dsh plugin --profile web add "$spec" || dsh plugin --profile web add "$spec"; done
agents_patch_yaml='agents:
  - id: demo'
agents_patch="$dsh_home/profiles/web/threadharbor-remote-agents.patch.yml"
mkdir -p "$(dirname "$agents_patch")"
printf '%s' "$agents_patch_yaml" > "$agents_patch"
bind_host="127.0.0.1"
identity_file="$dsh_home/profiles/web/threadharbor-identity.env"
printf 'DSH_HOST_ID=%s\\nDSH_HOST_TITLE=%s\\n' "$host_id" "$host_title" > "$identity_file"
case "$bind_host" in (0.0.0.0|"") echo "refusing wildcard bind" >&2; exit 1;; esac
dsh_bin="$(command -v dsh)"
dsh_args="--profile web --no-open --port $port --host $bind_host --patch $agents_patch"
service_name="threadharbor-dsh-web-$channel.service"
service="$HOME/.config/systemd/user/$service_name"
printf '%s\\n' '[Unit]' "Description=ThreadHarbor DSH Web ($channel)" 'After=network-online.target' '' '[Service]' "Environment=PATH=$common_path" "Environment=DSH_HOME=$dsh_home" "EnvironmentFile=-$identity_file" "ExecStart=$dsh_bin $dsh_args" 'Restart=on-failure' 'RestartSec=2' '' '[Install]' 'WantedBy=default.target' > "$service"
health_url() { printf 'http://%s:%s/' "$bind_host" "$port"; }
port_pids() { { if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:3081 -sTCP:LISTEN -t 2>/dev/null; elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :3081" 2>/dev/null | grep -o "pid=[0-9]*" | cut -d= -f2; elif command -v fuser >/dev/null 2>&1; then fuser 3081/tcp 2>/dev/null; fi; } | tr " " "\\n" | grep -E "^[0-9]+$" | sort -u; }
port_busy() { if command -v ss >/dev/null 2>&1; then [ -n "$(ss -ltnH "sport = :3081" 2>/dev/null)" ]; elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:3081 -sTCP:LISTEN >/dev/null 2>&1; elif command -v fuser >/dev/null 2>&1; then fuser 3081/tcp >/dev/null 2>&1; else return 1; fi; }
launch_url_from_log() {
  url=""
  if [ -f "$log_file" ]; then url="$(grep -E '^dsh web: ' "$log_file" | tail -1 | sed 's/^dsh web: //')"; fi
  if [ -z "$url" ] && command -v journalctl >/dev/null 2>&1; then url="$(journalctl --user -u "$service_name" -n 40 --no-pager 2>/dev/null | grep 'dsh web:' | tail -1 | sed 's/.*dsh web: //')"; fi
  printf '%s' "$url"
}
emit_success() {
  url="$(launch_url_from_log)"
  if [ -z "$url" ]; then echo "missing launch url in log" >&2; exit 1; fi
  echo "BIND_HOST=$bind_host"
  echo "LAUNCH_URL=$url"
  mkdir -p "$HOME/.local/state/threadharbor"
  PEER_URL="$url" PEER_BIND="$bind_host" PEER_PORT="$port" "$node" -e 'const fs=require("fs");const os=require("os");const path=require("path");const body={pluginsInstalled:true,listen:"loopback",port:Number(process.env.PEER_PORT),bindHost:process.env.PEER_BIND,launchUrl:process.env.PEER_URL};const file=path.join(os.homedir(),".local/state/threadharbor/peer.json");fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(body),{mode:384});'
  exit 0
}
already=0
if port_busy && command -v curl >/dev/null 2>&1; then code="$(curl -fsS -o /dev/null -w "%{http_code}" "$(health_url)" 2>/dev/null || true)"; case "$code" in 200|401) already=1;; esac; fi
if [ "$already" = "1" ]; then echo ALREADY_RUNNING=1; fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl --user daemon-reload && systemctl --user enable --now "$service_name" && systemctl --user restart "$service_name"
else
pid_file="$state/dsh-web.pid"
if [ -f "$pid_file" ]; then old_pid="$(cat "$pid_file")"; case "$old_pid" in (*[!0-9]*|"") ;; (*) kill "$old_pid" 2>/dev/null || true ;; esac; fi
for pid in $(port_pids); do kill "$pid" 2>/dev/null || true; done
for _ in 1 2 3 4 5 6 7 8 9 10; do port_busy || break; sleep 0.5; done
nohup $dsh_bin $dsh_args >>"$log_file" 2>&1 </dev/null & printf '%s\\n' "$!" > "$pid_file"
fi
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if command -v curl >/dev/null 2>&1; then code="$(curl -fsS -o /dev/null -w "%{http_code}" "$(health_url)" 2>/dev/null || true)"; case "$code" in 200|401) emit_success;; esac; fi
  sleep 1
done
echo "DSH Web did not become healthy" >&2
exit 1`
    expect(script).toBe(expected)
  })

  it('a reachable bind publishes that IP, trusts it, and records host-ip', () => {
    const script = buildInstallScript({
      channel: 'stable',
      releaseDir: '/srv/threadharbor/release',
      nodePath: '/usr/bin/node',
      remotePort: '3081',
      hostId: 'host-7f3a',
      hostTitle: 'Build Farm',
      upgrade: true,
      installFromGithub: true,
      remotePlugins: ['@threadharbor/plugin-a'],
      remoteAgentsPatch: 'agents:\n  - id: demo',
      bindHost: '192.168.1.10',
      listen: 'host-ip',
    })
    expect(script).toContain("bind_host='192.168.1.10'")
    expect(script).toContain('--trusted-host $bind_host')
    expect(script).toContain('--public-url $public_origin/')
    expect(script).toContain('listen:"host-ip"')
    expect(script).not.toContain('bind_host="127.0.0.1"')
  })
})

describe('buildStartScript', () => {
  const input = {
    channel: 'stable',
    nodePath: '/usr/bin/node',
    remotePort: '3081',
    hostId: 'host-7f3a',
    hostTitle: 'Build Farm',
    remoteAgentsPatch: 'agents:\n  - id: demo',
  }

  it('parses under POSIX sh (syntax check only, nothing executes)', () => {
    // A peer machine only promises a POSIX shell, not zsh. Syntax check both
    // scripts with `sh -n` so a fragment joined onto a block-opening keyword
    // (`{`, `do`, `then`, `else`) can never ship again.
    expect(spawnSync('sh', ['-n'], {
      input: buildInstallScript({
        channel: 'stable',
        releaseDir: '/srv/threadharbor/release',
        nodePath: '/usr/bin/node',
        remotePort: '3081',
        hostId: 'host-7f3a',
        hostTitle: 'Build Farm',
        upgrade: true,
        installFromGithub: true,
        remotePlugins: ['@threadharbor/plugin-a', '@threadharbor/plugin-b'],
        remoteAgentsPatch: 'agents:\n  - id: demo',
      }),
    }).status).toBe(0)
    expect(spawnSync('sh', ['-n'], { input: buildStartScript(input) }).status).toBe(0)
  })

  it('keeps the systemd branch with systemctl --user enable --now', () => {
    expect(buildStartScript(input)).toContain('systemctl --user enable --now')
  })

  it('keeps the nohup fallback branch with its dsh-web.pid file', () => {
    const script = buildStartScript(input)
    expect(script).toContain('nohup')
    expect(script).toContain('dsh-web.pid')
  })

  it('treats a port answer as success through the health wait loop', () => {
    const script = buildStartScript(input)
    expect(script).toContain('for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do')
    expect(script).toContain('case "$code" in 200|401) emit_success;; esac')
    expect(script).toContain('sleep 1')
  })

  it('binds 127.0.0.1 and never a wildcards or tailscale address', () => {
    const script = buildStartScript(input)
    expect(script).toContain('bind_host="127.0.0.1"')
    expect(script).toContain('case "$bind_host" in (0.0.0.0|"")')
    expect(script).not.toContain('tailscale ip')
  })

  it('does not reinstall plugins', () => {
    const script = buildStartScript(input)
    expect(script).not.toContain('npm install -g')
    expect(script).not.toContain('dsh plugin')
  })

  it('writes the systemd unit for the DSH web profile', () => {
    const script = buildStartScript(input)
    expect(script).toContain('threadharbor-dsh-web-$channel.service')
    expect(script).toContain('--profile web')
  })

  it('leaves the peer profile files untouched when profile writes are skipped', () => {
    // The start path cannot know the peer's real hostId / hostTitle / agent
    // selection, so it must not rewrite either profile file: doing so blanks a
    // real identity (which the systemd restart then reloads) and resets the
    // operator's remote-agent selection. Skipping the writes must remove the
    // payload assignment and both redirections — and nothing else.
    const script = buildStartScript({ ...input, skipProfileWrites: true })
    expect(script).not.toContain('agents_patch_yaml=')
    expect(script).not.toContain('> "$agents_patch"')
    expect(script).not.toContain('> "$identity_file"')
  })

  it('still reads the deployed profile files when profile writes are skipped', () => {
    // Skipping the writes must not drop the references: dsh still applies the
    // patch file and the systemd unit still loads the identity file the
    // original deploy wrote.
    const script = buildStartScript({ ...input, skipProfileWrites: true })
    expect(script).toContain('--patch $agents_patch')
    expect(script).toContain('EnvironmentFile=-$identity_file')
  })

  it('still parses under POSIX sh when profile writes are skipped', () => {
    // Removing lines from the middle of a fragment can unbalance the script;
    // check the emitted text rather than assuming the removals are inert.
    expect(spawnSync('sh', ['-n'], {
      input: buildStartScript({ ...input, skipProfileWrites: true }),
    }).status).toBe(0)
  })

  it('still writes both profile files on the deploy path', () => {
    // Guard so a later change cannot quietly suppress the writes everywhere:
    // only the start path may skip them.
    const script = buildInstallScript({
      channel: 'stable',
      releaseDir: '/srv/threadharbor/release',
      nodePath: '/usr/bin/node',
      remotePort: '3081',
      hostId: 'host-7f3a',
      hostTitle: 'Build Farm',
      upgrade: true,
      installFromGithub: true,
      remotePlugins: ['@threadharbor/plugin-a', '@threadharbor/plugin-b'],
      remoteAgentsPatch: 'agents:\n  - id: demo',
    })
    expect(script).toContain('printf \'%s\' "$agents_patch_yaml" > "$agents_patch"')
    expect(script).toContain('printf \'DSH_HOST_ID=%s\\nDSH_HOST_TITLE=%s\\n\' "$host_id" "$host_title" > "$identity_file"')
  })
})
