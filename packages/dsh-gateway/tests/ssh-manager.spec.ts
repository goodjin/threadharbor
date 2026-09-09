import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SshManager } from '../src/ssh-manager.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
describe('SshManager configuration', () => {
  it('keeps identity bytes server-side and requires fingerprint approval before deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-ssh-'))
    roots.push(root)
    const identityFile = join(root, 'identity')
    await writeFile(identityFile, 'not-a-real-key\n', { mode: 0o600 })
    const manager = new SshManager({
      knownHostsPath: join(root, 'known_hosts'),
      connectTimeoutMs: 100,
      installTimeoutMs: 100,
      hostdRemotePort: 3091,
      deploymentChannel: 'test',
      hostdArtifactDirectory: join(root, 'hostd'),
    })
    try {
      expect(manager.parseInspectionConfig({ target: 'example.test', user: 'agent', identityFile }))
        .toMatchObject({ target: 'example.test', user: 'agent', identityFile, hostKeyFingerprint: 'unapproved' })
      expect(() => manager.parseApprovedConfig({ target: 'example.test', identityFile }))
        .toThrow('hostKeyFingerprint is required')
      expect(() => manager.parseInspectionConfig({ target: 'example.test', identityFile: 'relative/key' }))
        .toThrow('existing absolute path')
    } finally {
      manager.close()
    }
  })

  it('starts hostd with common user-level Agent directories on PATH', () => {
    const source = readFileSync(new URL('../src/ssh-manager.ts', import.meta.url), 'utf8')
    expect(source).toContain('node_dir="$(dirname "$node")"')
    expect(source).toContain('$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin')
    expect(source).toContain('PATH="$common_path" nohup')
    expect(source).toContain('EnvironmentFile=-$state/hostd.env')
    expect(source).toContain('https_proxy')
    expect(source).not.toContain('agent-bundle')
  })

  it('reclaims the hostd port on macOS / non-systemd hosts before nohup', () => {
    // macOS lacks `systemctl --user`, so the fallback path can run into an
    // orphaned listener holding the target port (manual launch, missing pid
    // file, older deploy). Without reclaim the new hostd exits on EADDRINUSE
    // and the post-deploy inventory check silently fails. The script must
    // (a) look up the port-holder with whatever socket tool exists, (b) SIGTERM
    // it, (c) wait for the kernel to release the port, then (d) nohup the new
    // process.
    const source = readFileSync(new URL('../src/ssh-manager.ts', import.meta.url), 'utf8')
    // Portable listener lookup: lsof, then ss (iproute2), then fuser — a minimal
    // Debian container ships no lsof. The kill sweep needs `ss -p` to name the
    // holder; the busy probe must NOT use `-p` so it still works where the pid
    // column is hidden.
    expect(source).toContain('lsof -nP -iTCP:')
    expect(source).toContain('-sTCP:LISTEN -t')
    expect(source).toContain('ss -ltnpH')
    expect(source).toContain('ss -ltnH')
    expect(source).toContain('fuser')
    expect(source).toContain('port_pids()')
    expect(source).toContain('port_busy()')
    // The release wait must be UNCONDITIONAL (not nested inside the lsof branch),
    // otherwise lsof-less hosts skip it and race nohup into EADDRINUSE.
    expect(source).toContain('port_busy || break')
    expect(source).toContain('sleep 0.5')
    // pid-file path must still run first — the port sweep is the *fallback* for
    // the case where the pid file is missing or stale.
    expect(source.indexOf('cat "$pid_file"')).toBeLessThan(source.indexOf('port_pids()'))
    // systemd restart path is preserved for hosts that do have it.
    expect(source).toContain('systemctl --user restart "$service_name"')
    // ...but it must be gated on systemd actually running as init, not merely
    // on the systemctl binary existing. Container hosts (tini/OpenVZ) ship the
    // binary yet have no user bus, so an unguarded `command -v systemctl` sends
    // them down the systemd branch and aborts the whole deploy.
    expect(source).toContain('command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]')
  })

  it('post-deploy inventory failure surfaces the underlying reason', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('deployed hostd did not pass its inventory health check')
    expect(source).toContain('inventory health check')
    // The reason suffix must come from the host's inventoryError or healthy
    // flag, not a generic placeholder, so the user can act on it.
    expect(source).toContain('host.inventoryError')
  })

  it('reuses the live tunnel on redeploy instead of replacing it on every deploy', () => {
    // A redeploy restarts the remote hostd on the SAME port, so the existing
    // local forward stays valid. Replacing the tunnel here would kill the
    // endpoint the persistent connection uses and make the post-deploy health
    // check time out against a dead port.
    const source = readFileSync(new URL('../src/ssh-manager.ts', import.meta.url), 'utf8')
    const opening = source.indexOf("onProgress({ phase: 'opening-tunnel'")
    expect(opening).toBeGreaterThan(-1)
    const nextMethod = source.indexOf('async ensureTunnel(', opening)
    const openingBlock = source.slice(opening, nextMethod === -1 ? source.length : nextMethod)
    expect(openingBlock).toContain('return await this.ensureTunnel(config)')
    expect(openingBlock).not.toContain('freePort')
  })

  it('serializes tunnel opening per host alias', () => {
    // Concurrent callers (a deploy and per-request pool probes) must never open
    // two replacement tunnels for one host: opening is chained per alias.
    const source = readFileSync(new URL('../src/ssh-manager.ts', import.meta.url), 'utf8')
    expect(source).toContain('private readonly tunnelOps')
    const signature = source.indexOf('async ensureTunnel(')
    expect(signature).toBeGreaterThan(-1)
    const ensure = source.slice(signature, signature + 600)
    expect(ensure).toContain('const prior = this.tunnelOps.get(key) ?? Promise.resolve()')
  })

  it('stamps the hostd package version on the remote during deploy', () => {
    // The SSH deploy uploads only bin.js/hold-worker.js, so without a version
    // manifest the remote hostd reports `unknown+<digest>` (its version reader
    // looks at `here/../package.json`) while the gateway stamps `0.1.0+<digest>`.
    // Deploy must also write package.json beside the release directory so both
    // sides report the same version label for identical artifact bytes.
    const source = readFileSync(new URL('../src/ssh-manager.ts', import.meta.url), 'utf8')
    expect(source).toContain('import { readHostdPackageVersion } from \'@threadharbor/hostd/version\'')
    expect(source).toContain('here/../package.json')
    const manifest = source.indexOf("cat > \"$dir/package.json\"")
    expect(manifest).toBeGreaterThan(-1)
    const region = source.slice(manifest - 300, manifest + 200)
    expect(region).toContain('version: hostdVersion')
  })

  it('no longer releases the tunnel on a failed inventory refresh', () => {
    // refreshHostInventory used to kill the shared SSH tunnel and retry; that
    // churned local ports and stranded the persistent connection. The pool now
    // re-resolves the tunnel per request, so failure handling must not destroy it.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const start = source.indexOf('private async refreshHostInventory(')
    const next = source.indexOf('\n  private async ', start + 10)
    const method = source.slice(start, next === -1 ? source.length : next)
    expect(method).not.toContain('releaseTunnel')
  })
})
