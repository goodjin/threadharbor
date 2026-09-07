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
    // (a) look up the port-holder via lsof, (b) SIGTERM it, (c) wait for the
    // kernel to release the port, then (d) nohup the new process.
    const source = readFileSync(new URL('../src/ssh-manager.ts', import.meta.url), 'utf8')
    expect(source).toContain('lsof -nP -iTCP:')
    expect(source).toContain('-sTCP:LISTEN -t')
    expect(source).toContain('-sTCP:LISTEN >/dev/null')
    expect(source).toContain('sleep 0.5')
    // pid-file path must still run first — the lsof step is the *fallback* for
    // the case where the pid file is missing or stale.
    expect(source.indexOf('cat "$pid_file"')).toBeLessThan(source.indexOf('lsof -nP'))
    // systemd restart path is preserved for hosts that do have it.
    expect(source).toContain('systemctl --user restart "$service_name"')
  })

  it('post-deploy inventory failure surfaces the underlying reason', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('deployed hostd did not pass its inventory health check')
    expect(source).toContain('inventory health check')
    // The reason suffix must come from the host's inventoryError or healthy
    // flag, not a generic placeholder, so the user can act on it.
    expect(source).toContain('host.inventoryError')
  })
})
