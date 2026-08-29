import { mkdtemp, rm } from 'node:fs/promises'
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
    installPrefix: join(dataDir, 'install'),
    installTimeoutMs: 100,
    authTimeoutMs: 100,
    agentConfigHome: dataDir,
    maxAgentConfigBytes: 4096,
    codexCliCommand: '/missing/codex',
    codexCommand: '/missing/codex-acp',
    codexArgs: [],
    claudeCommand: '/missing/claude',
    dshCommand: '/missing/dsh-jsonrpc-agent',
    dshArgs: [],
    dshProvider: 'deepseek-official',
    dshModel: 'test',
    grokCommand: process.execPath,
    grokServeHost: '127.0.0.1',
    grokServePort: 65_534,
    grokArgs: [],
    workerScript: '/missing/hold-worker.js',
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
    vi.stubEnv('CODEX_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-inventory-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(options(root))

    expect((await hostd.inventory()).backends).toEqual([
      { backend: 'grok', installed: true, authenticated: false, running: false, sessionCapable: true },
      { backend: 'codex', installed: false, authenticated: false, running: false, sessionCapable: true },
      {
        backend: 'claude', installed: false, authenticated: false, running: false, sessionCapable: false,
        detail: 'Claude Code installation and login are supported; a native session adapter is not configured yet.',
      },
      { backend: 'dsh', installed: false, authenticated: false, running: false, sessionCapable: true },
    ])

    const codex = new RemoteAgentHostd(options(join(root, 'codex-host'), {
      codexCliCommand: process.execPath,
      codexCommand: process.execPath,
    }))
    expect((await codex.inventory()).backends.find(entry => entry.backend === 'codex'))
      .toMatchObject({ installed: true, authenticated: false, running: false })
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
})
