import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import {
  RemoteHostId, RemoteProjectId, RemoteSessionId, type JsonValue, type RemoteControlRequest,
} from '@threadharbor/protocol'
import RemoteAgentGateway from '../src/index.ts'

const CONFIG = {
  maxRequestBytes: 1024 * 1024,
  hostdRequestTimeoutMs: 1000,
  pollIntervalMs: 25,
  maxTranscriptEntriesPerSession: 20,
  sshKnownHostsPath: `/tmp/threadharbor-test-known-hosts-${process.pid}`,
  sshConnectTimeoutMs: 1000,
  sshInstallTimeoutMs: 1000,
  hostdRemotePort: 3091,
}

interface HostdCall {
  readonly port: string
  readonly request: RemoteControlRequest
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a string request body')
  return init.body
}

function paramString(request: RemoteControlRequest, key: string): string {
  const value = request.params[key]
  if (typeof value !== 'string') throw new Error(`expected string parameter ${key}`)
  return value
}

async function harness(events: JsonValue[] = []) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.reflect.provide('storageDomain', storageDomain)
  ctx.reflect.provide('webServer', { register: () => () => undefined })
  const calls: HostdCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const request = JSON.parse(requestBody(init)) as RemoteControlRequest
    calls.push({ port: url.port, request })
    const sessionId = typeof request.params['sessionId'] === 'string' ? request.params['sessionId'] : 'none'
    let result: JsonValue
    switch (request.method) {
      case 'inventory':
        result = {
          protocolVersion: 1, hostdVersion: 'test', hostId: `hostd-${url.port}`, healthy: true,
          backends: ['grok', 'codex', 'claude', 'dsh'].map(backend => ({
            backend, installed: true, authenticated: true, running: false, sessionCapable: backend !== 'claude',
          })),
        }
        break
      case 'fs.list':
        result = { path: paramString(request, 'path'), entries: [], truncated: false }
        break
      case 'agent.config.get':
      case 'agent.config.set':
        result = {
          backend: paramString(request, 'backend'), path: '/remote/.grok/config.toml', format: 'toml',
          exists: true, content: typeof request.params['content'] === 'string' ? request.params['content'] : '',
          revision: 'revision', maxBytes: 4096,
        }
        break
      case 'session.start':
      case 'session.attach':
        result = { holdId: `hold-${url.port}-${sessionId}`, nativeSessionId: `native-${url.port}-${sessionId}`, generation: 'g1', latestSeq: 0 }
        break
      case 'session.adopt':
        result = {
          holdId: `hold-${url.port}-shared`,
          nativeSessionId: paramString(request, 'nativeSessionId'),
          generation: 'g1',
          latestSeq: events.length,
        }
        break
      case 'session.prompt':
        result = { accepted: true, duplicate: false }
        break
      case 'events.read':
        result = {
          generation: 'g1', latestSeq: events.length, droppedThrough: 0, gap: false,
          events: events.map((frame, index) => ({ seq: index + 1, generation: 'g1', timestamp: '2026-08-28T00:00:00.000Z', frame })),
        }
        break
      default:
        result = { accepted: true }
    }
    return Response.json({ id: request.id, ok: true, result })
  })
  await ctx.plugin(RemoteAgentGateway, CONFIG).await()
  return { ctx, gateway: ctx.remoteAgentGateway, calls }
}

let nextRequest = 0
function request(method: RemoteControlRequest['method'], params: Record<string, JsonValue>): RemoteControlRequest {
  return { id: `${method}-${++nextRequest}`, method, params }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('RemoteAgentGateway', () => {
  it('keeps credentials out of persisted loopback host endpoints', async () => {
    const { ctx, gateway } = await harness()
    try {
      await expect(gateway.dispatch(request('host.add', {
        title: 'bad', endpoint: 'http://user:secret@127.0.0.1:4101',
      }))).rejects.toThrow('must not contain credentials')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards Agent configuration operations without forwarding the Web catalog host id', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4101',
      })) as unknown as { hostId: string }
      await gateway.dispatch(request('agent.config.get', { hostId: host.hostId, backend: 'grok' }))
      const forwarded = calls.at(-1)?.request
      expect(forwarded).toMatchObject({ method: 'agent.config.get', params: { backend: 'grok' } })
      expect(forwarded?.params).not.toHaveProperty('hostId')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps equal cwd projects and sessions distinct by host and enforces child backend inheritance', async () => {
    const { ctx, gateway } = await harness()
    try {
      const first = await gateway.dispatch(request('host.add', { title: 'first', endpoint: 'http://127.0.0.1:4101' })) as unknown as { hostId: string }
      const second = await gateway.dispatch(request('host.add', { title: 'second', endpoint: 'http://127.0.0.1:4102' })) as unknown as { hostId: string }
      const p1 = await gateway.dispatch(request('project.create', { hostId: first.hostId, title: 'repo', cwd: '/same/repo' })) as unknown as { projectId: string }
      const p2 = await gateway.dispatch(request('project.create', { hostId: second.hostId, title: 'repo', cwd: '/same/repo' })) as unknown as { projectId: string }
      const root = await gateway.dispatch(request('session.start', { projectId: p1.projectId, title: 'root', backend: 'codex' })) as unknown as { sessionId: string }
      await gateway.dispatch(request('session.start', { projectId: p2.projectId, title: 'other', backend: 'codex' }))
      const child = await gateway.dispatch(request('session.start', { projectId: p1.projectId, title: 'child', parentSessionId: root.sessionId })) as unknown as { backend: string }

      expect(child.backend).toBe('codex')
      await expect(gateway.dispatch(request('session.start', {
        projectId: p1.projectId, title: 'bad', parentSessionId: root.sessionId, backend: 'grok',
      }))).rejects.toThrow('backend is immutable')
      const state = gateway.state()
      expect(new Set(state.projects.map(project => project.hostId)))
        .toEqual(new Set([RemoteHostId(first.hostId), RemoteHostId(second.hostId)]))
      expect(state.projects.map(project => project.cwd)).toEqual(['/same/repo', '/same/repo'])
      expect(new Set(state.sessions.map(session => session.projectId)))
        .toEqual(new Set([RemoteProjectId(p1.projectId), RemoteProjectId(p2.projectId)]))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses stable prompt admissions and projects native ACP journal entries into its own transcript', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { title: 'Allow?', options: [] } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4201' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      const params = { sessionId: session.sessionId, clientId: 'browser', requestId: 'request-1', text: 'hello' }
      await gateway.dispatch(request('session.prompt', params))
      await gateway.dispatch(request('session.prompt', params))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))

      const promptCalls = calls.filter(call => call.request.method === 'session.prompt')
      expect(promptCalls).toHaveLength(2)
      expect(promptCalls[0]?.request.params['admission']).toEqual(promptCalls[1]?.request.params['admission'])
      const transcript = gateway.state().transcript.filter(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(transcript.filter(entry => entry.role === 'user')).toHaveLength(1)
      expect(transcript.map(entry => [entry.role, entry.kind, entry.text])).toEqual([
        ['user', 'message', 'hello'],
        ['permission', 'permission', 'Allow?'],
        ['assistant', 'message', 'answer'],
        ['system', 'status', '远程轮次完成'],
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('adopts product-emitted child sessions without projecting their frames into the parent', async () => {
    const events: JsonValue[] = [
      {
        jsonrpc: '2.0', method: 'session/update', params: {
          update: {
            sessionUpdate: 'subagent_spawned', child_session_id: 'native-child',
            description: 'Inspect tests', status: 'running',
          },
        },
      },
      {
        jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'native-child',
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'child answer' } },
        },
      },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4301' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const parent = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await gateway.dispatch(request('events.read', { sessionId: parent.sessionId }))
      const child = gateway.state().sessions.find(session => session.parentSessionId === RemoteSessionId(parent.sessionId))
      expect(child).toMatchObject({ backend: 'codex', title: 'Inspect tests' })
      expect(calls.some(call => call.request.method === 'session.adopt'
        && call.request.params['nativeSessionId'] === 'native-child')).toBe(true)
      expect(gateway.state().transcript).toHaveLength(0)

      await gateway.dispatch(request('events.read', { sessionId: child!.sessionId }))
      expect(gateway.state().transcript.map(entry => [entry.sessionId, entry.text]))
        .toEqual([[child!.sessionId, 'child answer']])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
