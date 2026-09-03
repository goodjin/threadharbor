import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue, RemoteControlRequest, RemoteJournalPage } from '@threadharbor/protocol'
import { RemoteAgentHostd, type HostdOptions } from '../src/server.ts'

const roots: string[] = []
const servers: Server[] = []

function request(method: RemoteControlRequest['method'], params: Record<string, JsonValue>): RemoteControlRequest {
  return { id: `${method}-test`, method, params }
}

async function listenLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake Grok server did not bind')
  servers.push(server)
  return { server, port: address.port }
}

async function shutdownHolds(dataDir: string): Promise<void> {
  const holdsDir = join(dataDir, 'holds')
  for (const holdId of await readdir(holdsDir)) {
    const config = JSON.parse(await readFile(join(holdsDir, holdId, 'config.json'), 'utf8')) as { socketPath?: unknown }
    const socketPath = typeof config.socketPath === 'string'
      ? config.socketPath
      : process.platform === 'win32'
        ? `\\\\.\\pipe\\threadharbor-hostd-${holdId}`
        : join(holdsDir, holdId, 'control.sock')
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath)
      socket.once('connect', () => { socket.write('{"operation":"shutdown"}\n') })
      socket.once('error', reject)
      socket.once('end', resolve)
      socket.resume()
    })
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RemoteAgentHostd session control', () => {
  it('runs all backend frame lanes and reattaches held sessions after hostd restarts', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    vi.stubEnv('DEEPSEEK_API_KEY', 'host-only-dsh-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-integration-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-project-'))
    roots.push(project)
    const grok = await listenLoopback()
    const options: HostdOptions = {
      host: '127.0.0.1', port: 0, dataDir: root,
      maxRequestBytes: 1024 * 1024, operationTimeoutMs: 1000, workerStartupTimeoutMs: 3000,
      maxJournalEvents: 100, maxJournalBytes: 100_000, maxDirectoryEntries: 100,
      authTimeoutMs: 1000,
      agentConfigHome: root, maxAgentConfigBytes: 4096,
      codexCliCommand: process.execPath,
      codexCommand: process.execPath, codexArgs: [],
      claudeCommand: '/missing/claude',
      claudeAcpCommand: '/missing/claude-agent-acp', claudeAcpArgs: [],
      dshCommand: process.execPath, dshArgs: [], dshProvider: 'deepseek-official', dshModel: 'test',
      grokCommand: process.execPath, grokServeHost: '127.0.0.1', grokServePort: grok.port, grokArgs: [],
      workerScript: new URL('./fixtures/fake-hold-worker.mjs', import.meta.url).pathname,
      hostdHttpFallback: false,
    }
    const first = new RemoteAgentHostd(options)
    await first.start()
    const attachments = new Map<string, { generation: string; nativeSessionId?: string }>()
    try {
      for (const backend of ['grok', 'codex', 'dsh'] as const) {
        const sessionId = `${backend}-session`
        const attached = await first.dispatch(request('session.start', { sessionId, backend, cwd: project })) as unknown as {
          generation: string
          nativeSessionId?: string
        }
        attachments.set(sessionId, {
          generation: attached.generation,
          ...(attached.nativeSessionId === undefined ? {} : { nativeSessionId: attached.nativeSessionId }),
        })
        const nativeSessionId = attached.nativeSessionId ?? sessionId
        const frame = backend === 'dsh'
          ? { jsonrpc: '2.0', id: `${backend}-prompt`, method: 'session/prompt', params: { sessionId: nativeSessionId, contentBlocks: [{ type: 'text', text: 'hello' }] } }
          : { jsonrpc: '2.0', id: `${backend}-prompt`, method: 'session/prompt', params: { sessionId: nativeSessionId, prompt: [{ type: 'text', text: 'hello' }] } }
        await first.dispatch(request('session.prompt', {
          sessionId,
          admission: { clientId: 'browser', requestId: `${backend}-prompt`, frame },
        }))
        const page = await first.dispatch(request('events.read', {
          sessionId, afterSeq: 0, generation: attached.generation,
        })) as unknown as RemoteJournalPage
        expect(JSON.stringify(page.events)).toContain(`${backend} reply`)
        expect(JSON.stringify(page.events)).toContain(backend === 'dsh' ? 'turn/end' : 'prompt_complete')
      }
    } finally {
      await first.close()
    }

    const restarted = new RemoteAgentHostd(options)
    await restarted.start()
    try {
      for (const [sessionId, original] of attachments) {
        const attached = await restarted.dispatch(request('session.attach', { sessionId })) as unknown as {
          generation: string
          nativeSessionId?: string
        }
        expect(attached).toMatchObject(original)
      }
    } finally {
      await restarted.close()
      await shutdownHolds(root)
    }
  })
})
