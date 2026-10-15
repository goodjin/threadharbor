import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { portListening } from '../src/ssh/port.ts'
import type { SshConnectionConfig } from '../src/ssh/types.ts'
import { DshSshManager } from '../src/ssh/manager.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DshSshManager', () => {
  it('keeps identity bytes server-side and requires fingerprint approval before deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-ssh-'))
    roots.push(root)
    const identityFile = join(root, 'identity')
    await writeFile(identityFile, 'not-a-real-key\n', { mode: 0o600 })
    const manager = new DshSshManager({
      knownHostsPath: join(root, 'known_hosts'),
      connectTimeoutMs: 100,
      installTimeoutMs: 100,
      deploymentChannel: 'test',
      defaultRemoteWebPort: 3081,
      releaseDirectory: root,
    })
    try {
      expect(manager.parseInspectionConfig({ target: 'example.test', user: 'agent', identityFile }))
        .toMatchObject({ target: 'example.test', user: 'agent', identityFile, hostKeyFingerprint: 'unapproved' })
      expect(() => manager.parseApprovedConfig({ target: 'example.test', identityFile }))
        .toThrow('hostKeyFingerprint is required')
    } finally {
      manager.close()
    }
  })

  it('the operation route answers HEAD so the availability probe can see it', () => {
    const source = readFileSync(new URL('../src/ssh-deploy.ts', import.meta.url), 'utf8')
    expect(source).toContain("methods: ['GET', 'HEAD']")
    expect(source).toContain("request.method === 'HEAD'")
  })

  it('includes portable port reclaim and DSH web health wait in the remote install script', () => {
    // The install script is composed from manager.ts plus the start-script.ts
    // fragments, so its source now spans both files; every asserted string
    // below must still exist verbatim in one of them.
    const source = [
      readFileSync(new URL('../src/ssh/manager.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/ssh/start-script.ts', import.meta.url), 'utf8'),
    ].join('\n')
    expect(source).toContain('port_pids()')
    expect(source).toContain('port_busy')
    expect(source).toContain('dsh plugin --profile web add')
    expect(source).toContain('threadharbor-dsh-web')
    expect(source).toContain('bind_host="127.0.0.1"')
    expect(source).not.toContain('tailscale ip')
    expect(source).toContain('LAUNCH_URL=')
    expect(source).toContain('peer.json')
    expect(source).toContain('threadharbor-remote-agents.patch.yml')
    expect(source).toContain('--patch $agents_patch')
    expect(source).not.toContain('hostd')
  })

  it('still assembles both the systemd and nohup branches into the install script', () => {
    const source = readFileSync(new URL('../src/ssh/manager.ts', import.meta.url), 'utf8')
    expect(source).toContain('buildRemoteEnv(')
    expect(source).toContain('buildStartBranch(')
  })

  it('judges a tunnel by its local port', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      expect(await portListening(port)).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    expect(await portListening(port, 2)).toBe(false)
  })

  describe('connect — reach an already-deployed peer without redeploying', () => {
    const makeManager = (): DshSshManager => new DshSshManager({
      knownHostsPath: '/dev/null',
      connectTimeoutMs: 10,
      installTimeoutMs: 10,
      deploymentChannel: 'test',
      defaultRemoteWebPort: 3081,
      releaseDirectory: '/dev/null',
    })
    const approved = { target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }

    it('tunnels a loopback peer and composes the tokenized launch URL', async () => {
      const manager = makeManager()
      const readPeer = vi.spyOn(manager, 'readPeer').mockResolvedValue({
        pluginsInstalled: true, listen: 'loopback', port: 3081, liveness: 'unknown',
        launchUrl: 'http://127.0.0.1:3081/?token=secret',
      })
      const ensureTunnel = vi.spyOn(manager, 'ensureTunnel').mockResolvedValue('http://127.0.0.1:45555')
      try {
        const result = await manager.connect(approved)
        expect(ensureTunnel).toHaveBeenCalledWith(approved, 3081)
        expect(result).toEqual({
          endpoint: 'http://127.0.0.1:45555',
          launchUrl: 'http://127.0.0.1:45555/?token=secret',
          mode: 'tunnel',
          peer: { pluginsInstalled: true, listen: 'loopback', port: 3081, liveness: 'unknown', launchUrl: 'http://127.0.0.1:3081/?token=secret' },
        })
        expect(readPeer).toHaveBeenCalled()
      } finally {
        manager.close()
      }
    })

    it('refuses to connect when nothing is installed, without touching the tunnel', async () => {
      const manager = makeManager()
      vi.spyOn(manager, 'readPeer').mockResolvedValue({ pluginsInstalled: false, liveness: 'unknown' })
      const ensureTunnel = vi.spyOn(manager, 'ensureTunnel').mockResolvedValue('http://127.0.0.1:1')
      try {
        await expect(manager.connect(approved)).rejects.toThrow('远端还没有 ThreadHarbor 部署记录')
        expect(ensureTunnel).not.toHaveBeenCalled()
      } finally {
        manager.close()
      }
    })

    it('opens a legacy direct-listening peer as-is, no tunnel', async () => {
      const manager = makeManager()
      vi.spyOn(manager, 'readPeer').mockResolvedValue({
        pluginsInstalled: true, listen: 'tailscale', port: 3081, liveness: 'unknown',
        bindHost: '100.64.0.2', launchUrl: 'http://100.64.0.2:3081/?token=s',
      })
      const ensureTunnel = vi.spyOn(manager, 'ensureTunnel').mockResolvedValue('http://127.0.0.1:1')
      try {
        const result = await manager.connect(approved)
        expect(result.mode).toBe('direct')
        expect(result.endpoint).toBe('http://100.64.0.2:3081')
        expect(result.launchUrl).toBe('http://100.64.0.2:3081/?token=s')
        expect(ensureTunnel).not.toHaveBeenCalled()
      } finally {
        manager.close()
      }
    })

    it('passes a raw SSH failure through untouched', async () => {
      const manager = makeManager()
      vi.spyOn(manager, 'readPeer').mockRejectedValue(new Error('ssh: connect to host mini.ts.net port 22: Connection refused'))
      try {
        await expect(manager.connect(approved)).rejects.toThrow('Connection refused')
      } finally {
        manager.close()
      }
    })
  })

  describe('readPeer — degraded reads stay distinguishable', () => {
    // Pins the load-bearing split between "the machine was too slow to read"
    // and "the machine has no record": the timeout path carries a 读取超时
    // note, a genuinely absent record carries none. Downstream (the panel and
    // planConnection, which refuses to connect on pluginsInstalled: false)
    // must be able to tell a slow deployed host from an undeployed one.
    const makeManager = (): DshSshManager => new DshSshManager({
      knownHostsPath: '/dev/null',
      connectTimeoutMs: 10,
      installTimeoutMs: 10,
      deploymentChannel: 'test',
      defaultRemoteWebPort: 3081,
      releaseDirectory: '/dev/null',
    })
    const approved = { target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }
    type Internals = {
      scan: () => Promise<readonly { hostKeyFingerprint: string; knownHostLine: string }[]>
      remoteExec: () => Promise<{ code: number; stdout: string; stderr: string }>
    }
    const scanResult = [{ hostKeyFingerprint: 'SHA256:abc', knownHostLine: 'mini.ts.net ssh-ed25519 AAAA' }]

    it('answers a record read that outlives the budget with unknown plus a timeout note, never stopped', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      vi.spyOn(internals, 'scan').mockResolvedValue(scanResult)
      vi.spyOn(internals, 'remoteExec').mockRejectedValue(new Error('ssh timed out after 8000ms'))
      try {
        const report = await manager.readPeer(approved)
        expect(report.liveness).toBe('unknown')
        expect(report.livenessNote).toBe('读取超时')
      } finally {
        manager.close()
      }
    })

    it('keeps an installed record intact when only the liveness probe times out, noting the timeout', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      vi.spyOn(internals, 'scan').mockResolvedValue(scanResult)
      vi.spyOn(internals, 'remoteExec')
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ pluginsInstalled: true, listen: 'loopback', port: 3081 }), stderr: '' })
        .mockRejectedValueOnce(new Error('ssh timed out after 8000ms'))
      try {
        const report = await manager.readPeer(approved)
        expect(report).toEqual({
          pluginsInstalled: true, listen: 'loopback', port: 3081,
          liveness: 'unknown', livenessNote: '读取超时',
        })
      } finally {
        manager.close()
      }
    })

    it('leaves a genuinely absent record without a note so absence stays distinguishable from a timeout', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      vi.spyOn(internals, 'scan').mockResolvedValue(scanResult)
      vi.spyOn(internals, 'remoteExec').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
      try {
        const report = await manager.readPeer(approved)
        expect(report).toEqual({ pluginsInstalled: false, liveness: 'unknown' })
      } finally {
        manager.close()
      }
    })
  })

  describe('startPeer — restart the DSH web on an approved, deployed peer', () => {
    const makeManager = (): DshSshManager => new DshSshManager({
      knownHostsPath: '/dev/null',
      connectTimeoutMs: 10,
      installTimeoutMs: 10,
      deploymentChannel: 'test',
      defaultRemoteWebPort: 3081,
      releaseDirectory: '/dev/null',
    })
    const approved = { target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }
    type Internals = {
      scan: () => Promise<readonly { hostKeyFingerprint: string; knownHostLine: string }[]>
      remoteExec: (config: unknown, script: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
    }
    const scanResult = [{ hostKeyFingerprint: 'SHA256:abc', knownHostLine: 'mini.ts.net ssh-ed25519 AAAA' }]
    const nodeFound = { code: 0, stdout: '/usr/local/bin/node\n', stderr: '' }

    it('refuses before any I/O when the config carries no approved fingerprint', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      const scan = vi.spyOn(internals, 'scan')
      const remoteExec = vi.spyOn(internals, 'remoteExec')
      try {
        await expect(manager.startPeer({ target: 'mini.ts.net' } as SshConnectionConfig, 3081))
          .rejects.toThrow('hostKeyFingerprint is required')
        await expect(manager.startPeer({ target: 'mini.ts.net', hostKeyFingerprint: 'unapproved' }, 3081))
          .rejects.toThrow('hostKeyFingerprint is required')
        // Behavioural ordering proof: the refusal happened at the very top of
        // startPeer, before the scan (the first I/O of the fingerprint gate)
        // and before any remote exec.
        expect(scan).not.toHaveBeenCalled()
        expect(remoteExec).not.toHaveBeenCalled()
      } finally {
        manager.close()
      }
    })

    it('reports ok only when the port answers after the start script runs', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      vi.spyOn(internals, 'scan').mockResolvedValue(scanResult)
      const remoteExec = vi.spyOn(internals, 'remoteExec')
        .mockResolvedValueOnce(nodeFound)
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: 'RUNNING\n', stderr: '' })
      try {
        const result = await manager.startPeer(approved, 3081)
        expect(result).toEqual({ ok: true, port: 3081 })
        expect(remoteExec).toHaveBeenCalledTimes(3)
        // The verdict comes from the liveness probe on the requested port,
        // not from the start script's own stdout.
        expect(remoteExec.mock.calls[2]?.[1]).toContain('http://127.0.0.1:3081/')
      } finally {
        manager.close()
      }
    })

    it('reports failure with the remote stderr when the port stays down', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      vi.spyOn(internals, 'scan').mockResolvedValue(scanResult)
      vi.spyOn(internals, 'remoteExec')
        .mockResolvedValueOnce(nodeFound)
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'DSH Web did not become healthy\n' })
        .mockResolvedValueOnce({ code: 7, stdout: 'STOPPED\n', stderr: '' })
      try {
        const result = await manager.startPeer(approved, 3081)
        expect(result).toEqual({ ok: false, reason: 'DSH Web did not become healthy' })
      } finally {
        manager.close()
      }
    })

    it('emits a start script that defines emit_success and parses as shell', async () => {
      const manager = makeManager()
      const internals = manager as unknown as Internals
      vi.spyOn(internals, 'scan').mockResolvedValue(scanResult)
      const remoteExec = vi.spyOn(internals, 'remoteExec')
        .mockResolvedValueOnce(nodeFound)
        .mockResolvedValue({ code: 0, stdout: 'RUNNING\n', stderr: '' })
      try {
        await manager.startPeer(approved, 3081)
        const script = remoteExec.mock.calls[1]?.[1] ?? ''
        // The start branch calls emit_success but the fragments never define
        // it; the start script must supply the no-op definition itself.
        expect(script).toContain('emit_success() { exit 0; }')
        // Syntax check only — nothing executes. A peer machine only promises
        // a POSIX shell, not zsh: an earlier version of this check preferred
        // zsh and so accepted `{;` / `do;` / `else;` joins that sh rejects.
        // Parse under sh, the least capable shell that must run these scripts.
        expect(spawnSync('sh', ['-n'], { input: script }).status).toBe(0)
      } finally {
        manager.close()
      }
    })
  })
})
