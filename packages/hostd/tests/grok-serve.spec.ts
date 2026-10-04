import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findTcpListenerPid,
  grokServeSecretFromCommandLine,
  grokServeSecretPath,
  looksLikeGrokAgentServe,
  probeGrokServe,
  readFileTail,
  resolveGrokServeSecret,
} from '../src/grok-serve.ts'
import { RemoteAgentHostd, type HostdOptions } from '../src/server.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostdOptions(dataDir: string, overrides: Partial<HostdOptions> = {}): HostdOptions {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    maxRequestBytes: 1024,
    operationTimeoutMs: 200,
    workerStartupTimeoutMs: 200,
    maxJournalEvents: 20,
    maxJournalBytes: 100_000,
    maxDirectoryEntries: 20,
    authTimeoutMs: 200,
    installTimeoutMs: 200,
    promptTimeoutMs: 60_000,
    holdIdleTimeoutMs: 0,
    agentConfigHome: dataDir,
    maxAgentConfigBytes: 4096,
    codexCliCommand: '/missing/codex',
    codexCommand: '/missing/codex-acp',
    codexArgs: [],
    claudeCommand: '/missing/claude',
    claudeAcpCommand: '/missing/claude-agent-acp',
    claudeAcpArgs: [],
    dshCommand: '/missing/dsh',
    dshArgs: [],
    grokCommand: process.execPath,
    grokServeHost: '127.0.0.1',
    grokServePort: 65_534,
    grokArgs: [],
    hostdHttpFallback: false,
    ...overrides,
  }
}

function listen(): Promise<Server & { port: number }> {
  return new Promise((resolveListen) => {
    const server = createServer() as Server & { port: number }
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no loopback port')
      server.port = address.port
      resolveListen(server)
    })
  })
}

describe('grok serve secret resolution', () => {
  it('persists an env secret and reuses the file after the env is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'th-grok-secret-'))
    roots.push(root)
    const first = resolveGrokServeSecret(root, 'a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d')
    expect(first).toBe('a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d')
    expect(existsSync(grokServeSecretPath(root))).toBe(true)
    const second = resolveGrokServeSecret(root, undefined)
    expect(second).toBe('a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d')
  })

  it('prefers the persisted file over a stale env secret', () => {
    const root = mkdtempSync(join(tmpdir(), 'th-grok-secret-file-'))
    roots.push(root)
    writeFileSync(grokServeSecretPath(root), '11111111-2222-4333-8444-555566667777\n', { mode: 0o600 })
    expect(resolveGrokServeSecret(root, '99999999-8888-4777-8666-555544443333')).toBe('11111111-2222-4333-8444-555566667777')
  })

  it('generates a plausible secret when nothing else provides one', () => {
    const root = mkdtempSync(join(tmpdir(), 'th-grok-secret-gen-'))
    roots.push(root)
    const secret = resolveGrokServeSecret(root, undefined)
    expect(secret.length).toBeGreaterThanOrEqual(36)
    expect(readFileSync(grokServeSecretPath(root), 'utf8').trim()).toBe(secret)
  })
})

describe('grok serve command line helpers', () => {
  const example = 'grok agent serve --bind 127.0.0.1:2419 --secret 5756bc5a-f361-40da-b0ba-2a32f5601e5f'

  it('recognizes grok agent serve listeners on the matching port', () => {
    expect(looksLikeGrokAgentServe(example, 2419)).toBe(true)
    expect(looksLikeGrokAgentServe(example, 9999)).toBe(false)
    expect(looksLikeGrokAgentServe('node server.mjs --port 2419', 2419)).toBe(false)
    expect(looksLikeGrokAgentServe(undefined, 2419)).toBe(false)
  })

  it('extracts --secret in separated and assigned forms', () => {
    expect(grokServeSecretFromCommandLine(example)).toBe('5756bc5a-f361-40da-b0ba-2a32f5601e5f')
    expect(grokServeSecretFromCommandLine(`grok agent serve --bind=127.0.0.1:2419 --secret=${'5756bc5a-f361-40da-b0ba-2a32f5601e5f'}`))
      .toBe('5756bc5a-f361-40da-b0ba-2a32f5601e5f')
    expect(grokServeSecretFromCommandLine('grok agent serve --bind 127.0.0.1:2419')).toBeUndefined()
  })
})

describe('grok serve probe', () => {
  it('opens with a matching secret and is rejected with the wrong one', async () => {
    const expected = '5756bc5a-f361-40da-b0ba-2a32f5601e5f'
    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verifyClient: (info: any, done: (ok: boolean, code?: number) => void) => {
        done((String((info as { req?: { url?: string } }).req?.url ?? '')).includes(`server-key=${expected}`), 401)
      },
    })
    await new Promise<void>((resolveListen) => { server.once('listening', () => { resolveListen() }) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no ws port')
      expect(await probeGrokServe('127.0.0.1', address.port, expected, 2_000)).toBe(true)
      expect(await probeGrokServe('127.0.0.1', address.port, 'abcdabcd-abcd-4bcd-8cde-0123456789ab', 2_000)).toBe(false)
    } finally {
      await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
    }
  })

  it('returns false for a plain TCP listener that is not a Grok serve', async () => {
    const plain = await listen()
    // Respond with a non-WebSocket HTTP reply so the probe fails fast instead
    // of waiting out its timeout against a silent socket.
    plain.on('connection', (socket) => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n')
      })
    })
    try {
      expect(await probeGrokServe('127.0.0.1', plain.port, 'abcdefab-cdef-4abc-9def-0123456789ab', 2_000)).toBe(false)
    } finally {
      await new Promise<void>((resolveClose) => { plain.close(() => { resolveClose() }) })
    }
  })
})

describe('process introspection', () => {
  it.skipIf(process.platform === 'win32')('finds the pid listening on a TCP port', async () => {
    const server = await listen()
    try {
      const pid = await findTcpListenerPid(server.port)
      expect(pid).toBe(process.pid)
    } finally {
      await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
    }
  })
})

describe('worker log tail', () => {
  it('reads a bounded tail of the worker log file', () => {
    const root = mkdtempSync(join(tmpdir(), 'th-grok-tail-'))
    roots.push(root)
    const path = join(root, 'worker.log')
    writeFileSync(path, `${'x'.repeat(5000)}\nboom-line\n`)
    const tail = readFileTail(path, 200)
    expect(tail).not.toBeUndefined()
    expect(tail?.endsWith('boom-line')).toBe(true)
    expect(tail!.length).toBeLessThanOrEqual(200)
  })
})

describe('RemoteAgentHostd grok serve repair guards', () => {
  it('refuses to adopt a listener that is not a grok agent serve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-hostd-adopt-'))
    roots.push(root)
    const server = await listen()
    try {
      const hostd = new RemoteAgentHostd(hostdOptions(root, { grokServePort: server.port }))
      await expect(hostd.dispatch({ id: 'a', method: 'grok.serve.adopt', params: {} }))
        .rejects.toThrow(/不是 Grok agent serve/)
    } finally {
      await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
    }
  })

  it('inspects an idle grok port without spawning anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-hostd-inspect-'))
    roots.push(root)
    const hostd = new RemoteAgentHostd(hostdOptions(root, { grokServePort: 65_533 }))
    const result = await hostd.dispatch({ id: 'i', method: 'grok.serve.inspect', params: {} }) as Record<string, unknown>
    expect(result.listening).toBe(false)
    expect(result.reachable).toBe(false)
  })

  it('includes the Agent stderr tail when a backend fails to start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-hostd-spawn-'))
    roots.push(root)
    const failing = join(root, 'failing-agent.mjs')
    writeFileSync(failing, 'process.stderr.write("boom-agent-start\\n")\nprocess.exit(2)\n')
    const project = await mkdtemp(join(tmpdir(), 'th-hostd-spawn-cwd-'))
    roots.push(project)
    const hostd = new RemoteAgentHostd(hostdOptions(root, { codexCommand: process.execPath, codexArgs: [failing] }))
    await expect(hostd.dispatch({
      id: 's', method: 'session.start',
      params: { sessionId: 's-fail', backend: 'codex', cwd: project },
    })).rejects.toThrow(/Agent 日志尾部：boom-agent-start/)
  })
})
