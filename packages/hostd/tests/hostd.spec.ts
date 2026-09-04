import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteAgentHostd, type HostdOptions } from '../src/server.ts'

const roots: string[] = []

function options(dataDir: string, overrides: Partial<HostdOptions> = {}): HostdOptions {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    maxRequestBytes: 1024,
    operationTimeoutMs: 100,
    workerStartupTimeoutMs: 100,
    maxJournalEvents: 20,
    maxJournalBytes: 100_000,
    maxDirectoryEntries: 20,
    authTimeoutMs: 100,
    installTimeoutMs: 100,
    agentConfigHome: dataDir,
    maxAgentConfigBytes: 4096,
    codexCliCommand: '/missing/codex',
    codexCommand: '/missing/codex-acp',
    codexArgs: [],
    claudeCommand: '/missing/claude',
    claudeAcpCommand: '/missing/claude-agent-acp',
    claudeAcpArgs: [],
    dshCommand: '/missing/dsh-jsonrpc-agent',
    dshArgs: [],
    pythonCommand: '/missing/python',
    dshProvider: 'deepseek-official',
    dshModel: 'test',
    grokCommand: process.execPath,
    grokServeHost: '127.0.0.1',
    grokServePort: 65_534,
    grokArgs: [],
    workerScript: '/missing/hold-worker.js',
    hostdHttpFallback: false,
    ...overrides,
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RemoteAgentHostd inventory', () => {
  it('reports installation and authentication independently without starting backends', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', '')
    vi.stubEnv('GROK_HOME', '')
    vi.stubEnv('CODEX_HOME', '')
    vi.stubEnv('CODEX_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-inventory-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))

    const inventory = await hostd.inventory()
    expect(inventory.hostdVersion).toMatch(/^0\.1\.0(\+[0-9a-f]{12})?$/)
    expect(inventory.backends).toEqual([
      { backend: 'grok', installed: true, authenticated: false, running: false, sessionCapable: true },
      { backend: 'codex', installed: false, authenticated: false, running: false, sessionCapable: true },
      { backend: 'claude', installed: false, authenticated: false, running: false, sessionCapable: false },
      { backend: 'dsh', installed: false, authenticated: false, running: false, sessionCapable: true },
    ])

    const codex = new RemoteAgentHostd(options(join(root, 'codex-host'), {
      codexCliCommand: process.execPath,
      codexCommand: process.execPath,
    }))
    expect((await codex.inventory()).backends.find(entry => entry.backend === 'codex'))
      .toMatchObject({ installed: true, authenticated: false, running: false })

    const claude = new RemoteAgentHostd(options(join(root, 'claude-host'), {
      claudeCommand: process.execPath,
      claudeAcpCommand: process.execPath,
    }))
    expect((await claude.inventory()).backends.find(entry => entry.backend === 'claude'))
      .toMatchObject({ installed: true, authenticated: true, running: false, sessionCapable: true })
  })

  it('reports Codex as authenticated from auth.json without launching the CLI', async () => {
    vi.stubEnv('CODEX_HOME', '')
    vi.stubEnv('CODEX_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-codex-auth-'))
    roots.push(root)
    const marker = join(root, 'spawned')
    const cli = join(root, 'codex')
    await writeFile(cli, ['#!/bin/sh', `printf spawned > '${marker}'`, 'exit 0', ''].join('\n'))
    await chmod(cli, 0o700)
    await mkdir(join(root, '.codex'), { mode: 0o700 })
    await writeFile(join(root, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'at', refresh_token: 'rt' },
    }))
    const hostd = new RemoteAgentHostd(options(root, {
      agentConfigHome: root,
      codexCliCommand: cli,
      codexCommand: cli,
    }))
    expect((await hostd.inventory()).backends.find(entry => entry.backend === 'codex'))
      .toMatchObject({ installed: true, authenticated: true, running: false })
    expect(existsSync(marker)).toBe(false)
  })

  it('stores a DSH API key in an owner-only file and never returns the secret', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-dsh-key-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root, { dshCommand: process.execPath }))
    expect(await hostd.dispatch({ id: '1', method: 'agent.credential.status', params: {} }))
      .toEqual({ configured: false })
    expect(await hostd.dispatch({ id: '2', method: 'agent.credential.set', params: { apiKey: 'sk-test' } }))
      .toEqual({ configured: true })
    expect(await hostd.dispatch({ id: '3', method: 'agent.credential.status', params: {} }))
      .toEqual({ configured: true })
    const saved = await stat(join(root, 'threadharbor', 'dsh-api-key'))
    expect(saved.mode & 0o777).toBe(0o600)
    const inventory = await hostd.inventory()
    expect(inventory.backends.find(entry => entry.backend === 'dsh')).toMatchObject({
      installed: true, authenticated: true,
    })
  })

  it('can retry startup after its configured port was occupied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-start-'))
    roots.push(root)
    const owner = new RemoteAgentHostd(options(join(root, 'owner')))
    await owner.start()
    const retrying = new RemoteAgentHostd(options(join(root, 'retrying'), { port: owner.port }))
    try {
      await expect(retrying.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      await owner.close()
      await retrying.start()
      expect(retrying.port).toBeGreaterThan(0)
    } finally {
      await Promise.all([owner.close(), retrying.close()])
    }
  })

  it('routes fixed Agent configuration reads and validated writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-config-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))
    const opened = await hostd.dispatch({
      id: 'config-get', method: 'agent.config.get', params: { backend: 'grok' },
    }) as unknown as { revision: string; path: string }
    expect(opened.path).toBe(join(root, '.grok', 'config.toml'))
    const saved = await hostd.dispatch({
      id: 'config-set', method: 'agent.config.set',
      params: { backend: 'grok', content: '[models]\ndefault = "grok-build"\n', expectedRevision: opened.revision },
    })
    expect(saved).toMatchObject({ exists: true, format: 'toml' })
  })

  it('returns an agent install plan and requires confirm: true before mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-install-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))
    const plan = await hostd.dispatch({
      id: 'plan', method: 'agent.install.plan', params: { backend: 'dsh' },
    }) as { component: string; requiresConfirmation: boolean }
    expect(plan).toMatchObject({ component: 'dsh', requiresConfirmation: true })
    await expect(hostd.dispatch({
      id: 'install', method: 'agent.install', params: { backend: 'dsh' },
    })).rejects.toThrow('confirm')
  })
})

describe('RemoteAgentHostd fs.list', () => {
  it('returns the host home directory when path is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-fs-list-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))
    const listing = await hostd.dispatch({
      id: 'fs1', method: 'fs.list', params: {},
    }) as { path: string; entries: readonly unknown[] }
    expect(listing.path).toBe(process.env['HOME'] ?? require('node:os').homedir())
    expect(Array.isArray(listing.entries)).toBe(true)
  })

  it('treats an empty path the same as a missing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-fs-list-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))
    const listing = await hostd.dispatch({
      id: 'fs2', method: 'fs.list', params: { path: '   ' },
    }) as { path: string }
    expect(listing.path).toBe(process.env['HOME'] ?? require('node:os').homedir())
  })

  it('lists an explicit absolute directory and exposes a parent link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-fs-list-'))
    roots.push(root)
    const projectDir = join(root, 'projects', 'demo')
    await mkdir(projectDir, { recursive: true, mode: 0o700 })
    await writeFile(join(projectDir, 'README.md'), '# demo')
    const hostd = new RemoteAgentHostd(options(root))
    const listing = await hostd.dispatch({
      id: 'fs3', method: 'fs.list', params: { path: projectDir },
    }) as {
      path: string
      parent: string
      entries: readonly { name: string; kind: string; path: string }[]
    }
    // macOS resolves /var → /private/var inside tmpdir; hostd normalises via realpathSync.
    const { realpathSync } = await import('node:fs')
    const resolvedProjectDir = realpathSync(projectDir)
    expect(listing.path).toBe(resolvedProjectDir)
    expect(listing.parent).toBe(realpathSync(join(root, 'projects')))
    expect(listing.entries).toEqual([
      { name: 'README.md', kind: 'file', path: join(resolvedProjectDir, 'README.md') },
    ])
  })

  it('propagates fs errors with the requested path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-fs-list-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))
    const missing = join(root, 'does-not-exist')
    await expect(hostd.dispatch({
      id: 'fs4', method: 'fs.list', params: { path: missing },
    })).rejects.toThrow(missing)
  })
})
