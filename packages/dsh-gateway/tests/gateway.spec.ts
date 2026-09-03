import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import {
  REMOTE_AGENT_GATEWAY_WS_PATH,
  RemoteHostId, RemoteProjectId, RemoteSessionId, type JsonValue, type RemoteControlRequest,
} from '@threadharbor/protocol'
import RemoteAgentGateway from '../src/index.ts'
import type { WebSocket } from 'ws'

const CONFIG = {
  maxRequestBytes: 1024 * 1024,
  hostdRequestTimeoutMs: 1000,
  pollIntervalMs: 25,
  maxTranscriptEntriesPerSession: 20,
  sshKnownHostsPath: `/tmp/threadharbor-test-known-hosts-${process.pid}`,
  sshConnectTimeoutMs: 1000,
  sshInstallTimeoutMs: 1000,
  hostdRemotePort: 3091,
  deploymentChannel: 'test',
}

interface HostdCall {
  readonly port: string
  readonly request: RemoteControlRequest
}

function paramString(request: RemoteControlRequest, key: string): string {
  const value = request.params[key]
  if (typeof value !== 'string') throw new Error(`expected string parameter ${key}`)
  return value
}

interface MockSocket extends EventEmitter {
  readyState: number
  send(payload: string): void
  close(code?: number, reason?: string): void
}

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

function makeMockSocket(onSend: (text: string) => string | undefined): MockSocket {
  const { EventEmitter } = require('node:events') as { EventEmitter: new () => EventEmitter }
  const emitter = new EventEmitter() as MockSocket
  emitter.readyState = CONNECTING
  emitter.send = function send(payload: string): void {
    const response = onSend(payload)
    if (response !== undefined) {
      this.emit('message', response)
    }
  }
  emitter.close = function close(code?: number, reason?: string): void {
    this.readyState = CLOSED
    void code
    void reason
    this.emit('close')
  }
  return emitter
}

const sockets: MockSocket[] = []

function respondToRequest(request: RemoteControlRequest, port: string, events: JsonValue[]): JsonValue {
  const sessionId = typeof request.params['sessionId'] === 'string' ? request.params['sessionId'] : 'none'
  switch (request.method) {
    case 'inventory':
      return {
        protocolVersion: 1, hostdVersion: 'test', hostId: `hostd-${port}`, healthy: true,
        backends: ['grok', 'codex', 'claude', 'dsh'].map(backend => ({
          backend, installed: true, authenticated: true, running: false, sessionCapable: backend !== 'claude',
        })),
      }
    case 'fs.list':
      return { path: paramString(request, 'path'), entries: [], truncated: false }
    case 'agent.config.get':
    case 'agent.config.set':
      return {
        backend: paramString(request, 'backend'), path: '/remote/.grok/config.toml', format: 'toml',
        exists: true, content: typeof request.params['content'] === 'string' ? request.params['content'] : '',
        revision: 'revision', maxBytes: 4096,
      }
    case 'session.start':
    case 'session.attach':
      return { holdId: `hold-${port}-${sessionId}`, nativeSessionId: `native-${port}-${sessionId}`, generation: 'g1', latestSeq: 0 }
    case 'session.adopt':
      return {
        holdId: `hold-${port}-shared`,
        nativeSessionId: paramString(request, 'nativeSessionId'),
        generation: 'g1',
        latestSeq: events.length,
      }
    case 'session.prompt':
      return { accepted: true, duplicate: false }
    case 'events.read':
      return {
        generation: 'g1', latestSeq: events.length, droppedThrough: 0, gap: false,
        events: events.map((frame, index) => ({ seq: index + 1, generation: 'g1', timestamp: '2026-08-28T00:00:00.000Z', frame })),
      }
    default:
      return { accepted: true }
  }
}

async function harness(events: JsonValue[] = []) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.reflect.provide('storageDomain', storageDomain)
  let upgradePath: string | undefined
  ctx.reflect.provide('webServer', {
    register: () => () => undefined,
    registerUpgrade: (route: { path: string }) => {
      upgradePath = route.path
      return () => { upgradePath = undefined }
    },
  })
  const calls: HostdCall[] = []
  const subscribeEvents: { port: string; sessionId: string; generation: string }[] = []

  let failing = false
  /** Per-socket map of subscribed sessions for the WS push fan-out. */
  const subscriptionsBySocket = new WeakMap<MockSocket, Map<string, { generation: string; lastSeq: number }>>()
  let pushSeq = 0
  function socketFactory(url: string): MockSocket {
    const portMatch = /:(\d+)/.exec(url)
    const port = portMatch?.[1] ?? '0'
    let socket!: MockSocket
    socket = makeMockSocket((text: string) => {
      if (failing) throw new TypeError('fetch failed')
      if (text === '') return undefined
      let frame: { direction: string } & Record<string, unknown>
      try { frame = JSON.parse(text) as { direction: string } & Record<string, unknown> } catch { return undefined }
      if (frame.direction === 'ping') return JSON.stringify({ direction: 'pong' })
      if (frame.direction === 'request') {
        const request = {
          id: String(frame['id']),
          method: String(frame['method']) as RemoteControlRequest['method'],
          params: (frame['params'] as Record<string, JsonValue>) ?? {},
        }
        calls.push({ port, request })
        const result = respondToRequest(request, port, events)
        return JSON.stringify({ direction: 'response', id: request.id, ok: true, result })
      }
      if (frame.direction === 'subscribe') {
        const subs = subscriptionsBySocket.get(socket) ?? new Map<string, { generation: string; lastSeq: number }>()
        const sessionId = String(frame['sessionId'] ?? '')
        subs.set(sessionId, {
          generation: String(frame['generation'] ?? 'g1'),
          lastSeq: Number(frame['lastSeq'] ?? 0),
        })
        subscriptionsBySocket.set(socket, subs)
        subscribeEvents.push({ port, sessionId, generation: String(frame['generation'] ?? 'g1') })
        return undefined
      }
      if (frame.direction === 'unsubscribe') {
        subscriptionsBySocket.get(socket)?.delete(String(frame['sessionId'] ?? ''))
        return undefined
      }
      return undefined
    })
    sockets.push(socket)
    queueMicrotask(() => {
      socket.readyState = OPEN
      socket.emit('open')
    })
    void url
    return socket
  }

  /** Push one journal page to every socket subscribed to this session. */
  function pushJournalPage(sessionId: string, frames: readonly JsonValue[]): void {
    if (frames.length === 0) return
    for (const socket of sockets) {
      const subs = subscriptionsBySocket.get(socket)
      if (subs === undefined) continue
      const sub = subs.get(sessionId)
      if (sub === undefined) continue
      const page = {
        generation: sub.generation,
        latestSeq: sub.lastSeq + frames.length,
        droppedThrough: 0,
        gap: false,
        events: frames.map((frame, index) => ({
          seq: sub.lastSeq + index + 1,
          generation: sub.generation,
          timestamp: '2026-08-28T00:00:00.000Z',
          frame,
        })),
      }
      const wsFrame = {
        direction: 'push',
        seq: ++pushSeq,
        event: { type: 'journal.page', sessionId, page, subscribers: 1 },
      }
      socket.emit('message', JSON.stringify(wsFrame))
      sub.lastSeq = page.latestSeq
    }
  }

  await ctx.plugin(RemoteAgentGateway, CONFIG).await()
  ctx.remoteAgentGateway.setHostdSocketFactory(socketFactory as unknown as (url: string) => import('ws').WebSocket)
  return {
    ctx, gateway: ctx.remoteAgentGateway, calls,
    failNext: () => { failing = true },
    pushJournalPage,
    subscribeEvents,
    upgradePath,
  }
}

const WS_OPEN = 1

function makeBrowserSocket(): { readyState: number; sent: string[]; on(event: string, listener: (...args: unknown[]) => void): void; send(payload: string): void } {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    readyState: WS_OPEN,
    sent: [],
    on(event, listener) { (listeners[event] ??= []).push(listener) },
    send(payload) { this.sent.push(payload) },
  }
}

let nextRequest = 0
function request(method: RemoteControlRequest['method'], params: Record<string, JsonValue>): RemoteControlRequest {
  return { id: `${method}-${++nextRequest}`, method, params }
}

// session.start now returns a connecting row immediately while the gateway
// finishes talking to hostd in the background. Tests that need the binding
// (or a failed terminal state) before issuing session.prompt / events.read
// must wait for the inflight completion to settle first.
async function readTranscript(gateway: RemoteAgentGateway, sessionId: string, extra: Record<string, JsonValue> = {}) {
  return await gateway.dispatch(request('transcript.read', { sessionId, ...extra })) as {
    sessionId: string
    entries: Array<{ sessionId: string; role: string; kind: string; text: string; seq: number }>
    latestSeq: number
    fromSeq: number
    toSeq: number
    hasMore: boolean
    afterSeq: number
  }
}

async function waitForSessionBinding(
  gateway: RemoteAgentGateway,
  sessionId: string,
): Promise<{ binding?: { state?: string }; channelState: string; turnState: string }> {
  return await vi.waitFor(() => {
    const view = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(sessionId))
    if (!view) throw new Error(`session ${sessionId} disappeared`)
    if (view.channelState === 'connecting' && view.turnState !== 'failed') {
      throw new Error('session still connecting')
    }
    return view
  }, { timeout: 2000, interval: 10 })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('RemoteAgentGateway', () => {
  it('registers the browser WebSocket route through webServer.registerUpgrade', async () => {
    const { ctx, upgradePath } = await harness()
    try {
      expect(upgradePath).toBe(REMOTE_AGENT_GATEWAY_WS_PATH)
    } finally {
      await ctx.fiber.dispose()
    }
  })

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

  it('starts an agent-install operation and forwards agent.install to hostd', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4101',
      })) as unknown as { hostId: string }
      const started = await gateway.dispatch(request('operation.start', {
        kind: 'agent-install', hostId: host.hostId, backend: 'dsh', confirm: true,
      })) as unknown as { operationId: string; kind: string; backend?: string }
      expect(started).toMatchObject({ kind: 'agent-install', backend: 'dsh' })
      await vi.waitFor(() => {
        const latest = gateway.state().operations.find(operation => operation.operationId === started.operationId)
        if (latest?.status !== 'succeeded') throw new Error(`install status ${latest?.status ?? 'missing'}`)
        return latest
      }, { timeout: 2000, interval: 10 })
      expect(calls.some(call => call.request.method === 'agent.install')).toBe(true)
      const forwarded = calls.find(call => call.request.method === 'agent.install')?.request
      expect(forwarded?.params).toMatchObject({ backend: 'dsh', confirm: true })
      expect(forwarded?.params).not.toHaveProperty('hostId')
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
      await waitForSessionBinding(gateway, session.sessionId)
      const params = { sessionId: session.sessionId, clientId: 'browser', requestId: 'request-1', text: 'hello' }
      await gateway.dispatch(request('session.prompt', params))
      await gateway.dispatch(request('session.prompt', params))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))

      const promptCalls = calls.filter(call => call.request.method === 'session.prompt')
      expect(promptCalls).toHaveLength(2)
      expect(promptCalls[0]?.request.params['admission']).toEqual(promptCalls[1]?.request.params['admission'])
      expect(gateway.state().transcript).toEqual([])
      const transcript = (await readTranscript(gateway, session.sessionId)).entries
      expect(transcript.filter(entry => entry.role === 'user')).toHaveLength(1)
      expect(transcript.map(entry => [entry.role, entry.kind, entry.text])).toEqual([
        ['user', 'message', 'hello'],
        ['permission', 'permission', 'Allow?'],
        ['assistant', 'message', 'answer'],
        ['system', 'status', '远程轮次完成'],
      ])
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.latestTranscriptSeq)
        .toBe(transcript.at(-1)?.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('pages transcript.read from the tail and older cursor without dumping the catalog', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { title: 'Allow?', options: [] } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4210' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'page-1', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().transcript).toEqual([])
      const tail = await readTranscript(gateway, session.sessionId, { limit: 2 })
      expect(tail.hasMore).toBe(true)
      expect(tail.entries.map(entry => entry.text)).toEqual(['answer', '远程轮次完成'])
      const older = await readTranscript(gateway, session.sessionId, { beforeSeq: tail.fromSeq, limit: 2 })
      expect(older.entries.map(entry => entry.text)).toEqual(['hello', 'Allow?'])
      expect(older.hasMore).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('broadcasts session.view.changed when a prompt starts and journal completes', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4202' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const browser = makeBrowserSocket()
      gateway.registerBrowserForTesting(browser as unknown as WebSocket, 'alice')
      await gateway.dispatch(request('session.follow', { browserId: 'alice', sessionId: session.sessionId }))
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'request-view', text: 'hello',
      }))
      const afterPrompt = browser.sent.map(payload => JSON.parse(payload) as { event?: { type?: string; session?: { turnState?: string } } })
      expect(afterPrompt.some(frame => frame.event?.type === 'session.view.changed' && frame.event.session?.turnState === 'running')).toBe(true)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const afterJournal = browser.sent.map(payload => JSON.parse(payload) as { event?: { type?: string; session?: { turnState?: string } } })
      expect(afterJournal.some(frame => frame.event?.type === 'session.view.changed' && frame.event.session?.turnState === 'idle')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects journal events pushed via the hostd WebSocket into the local transcript', async () => {
    const events: JsonValue[] = []
    const { ctx, gateway, calls, pushJournalPage, subscribeEvents } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4204',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'request-poll', text: 'hello',
      }))
      // The catchup `events.read` runs before the gateway subscribes; wait
      // until the WS subscribe frame has been observed so we know the push
      // listener is wired up before we start emitting frames.
      await vi.waitFor(() => {
        expect(calls.some(call => call.request.method === 'events.read')).toBe(true)
        expect(subscribeEvents.some(entry => entry.sessionId === session.sessionId)).toBe(true)
      })

      pushJournalPage(session.sessionId, [
        { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late answer' } } } },
        { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
      ])

      await vi.waitFor(() => {
        expect(gateway.state().sessions.find(candidate => candidate.sessionId === session.sessionId)?.turnState).toBe('idle')
      })
      expect((await readTranscript(gateway, session.sessionId)).entries.some(entry => entry.text === 'late answer')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('settles a running session immediately after hostd accepts cancellation', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4203',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const browser = makeBrowserSocket()
      gateway.registerBrowserForTesting(browser as unknown as WebSocket, 'alice')
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'request-cancel', text: 'hello',
      }))
      expect(gateway.state().sessions.find(candidate => candidate.sessionId === session.sessionId)?.turnState).toBe('running')

      await gateway.dispatch(request('session.cancel', { sessionId: session.sessionId }))

      expect(gateway.state().sessions.find(candidate => candidate.sessionId === session.sessionId)?.turnState).toBe('idle')
      const cancelCall = calls.find(call => call.request.method === 'session.cancel')
      expect(cancelCall?.request.params).toMatchObject({
        sessionId: session.sessionId,
        frame: {
          jsonrpc: '2.0', method: 'session/cancel',
          params: { sessionId: `native-4203-${session.sessionId}` },
        },
      })
      const pushed = browser.sent.map(payload => JSON.parse(payload) as {
        event?: { type?: string; session?: { turnState?: string } }
      })
      expect(pushed.some(frame => frame.event?.type === 'session.view.changed'
        && frame.event.session?.turnState === 'idle')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('follow / unfollow / hello only touch the local broadcaster and require no hostd call', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4401' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      const callsBefore = calls.length
      const followed = await gateway.dispatch(request('session.follow', { browserId: 'alice', sessionId: session.sessionId })) as unknown as { sessionId: string; fromSeq: number }
      expect(followed.sessionId).toBe(session.sessionId)
      expect(followed.fromSeq).toBeTypeOf('number')
      await vi.waitFor(() => {
        expect(calls.slice(callsBefore).some(call => call.request.method === 'events.read')).toBe(true)
      })
      const unfollowed = await gateway.dispatch(request('session.unfollow', { browserId: 'alice', sessionId: session.sessionId })) as unknown as { sessionId: string }
      expect(unfollowed.sessionId).toBe(session.sessionId)
      const hello = await gateway.dispatch(request('browser.hello', { browserId: 'alice', lastSeenSeqs: { [session.sessionId]: 0 } })) as unknown as { missed: unknown[] }
      expect(hello.missed).toEqual([])
      expect(calls.slice(callsBefore).every(call => call.request.method === 'events.read' || call.request.method === 'session.attach')).toBe(true)
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
      await waitForSessionBinding(gateway, parent.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: parent.sessionId }))
      const child = gateway.state().sessions.find(session => session.parentSessionId === RemoteSessionId(parent.sessionId))
      expect(child).toMatchObject({ backend: 'codex', title: 'Inspect tests' })
      expect(calls.some(call => call.request.method === 'session.adopt'
        && call.request.params['nativeSessionId'] === 'native-child')).toBe(true)
      expect(gateway.state().transcript).toEqual([])
      expect((await readTranscript(gateway, parent.sessionId)).entries).toEqual([])

      await gateway.dispatch(request('events.read', { sessionId: child!.sessionId }))
      expect((await readTranscript(gateway, child!.sessionId)).entries.map(entry => [entry.sessionId, entry.text]))
        .toEqual([[child!.sessionId, 'child answer']])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hides, restores, and deletes hosts, projects, and archived sessions', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'dev-box', endpoint: 'http://127.0.0.1:4186' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }

      await gateway.dispatch(request('host.hide', { hostId: host.hostId }))
      expect(gateway.state().hosts).toEqual([])
      expect(gateway.state().projects).toEqual([])
      expect(gateway.state().sessions).toEqual([])
      const hidden = await gateway.dispatch(request('hidden.list', {})) as unknown as {
        hosts: Array<{ hostId: string; hiddenAt?: string }>
        projects: Array<{ projectId: string; hiddenAt?: string }>
        sessions: Array<{ sessionId: string; archivedAt?: string }>
      }
      expect(hidden.hosts.map(entry => entry.hostId)).toEqual([host.hostId])
      expect(hidden.projects.map(entry => entry.projectId)).toEqual([project.projectId])
      expect(hidden.sessions.map(entry => entry.sessionId)).toEqual([session.sessionId])

      await expect(gateway.dispatch(request('project.unhide', { projectId: project.projectId }))).rejects.toThrow('请先恢复所属主机')
      await gateway.dispatch(request('host.unhide', { hostId: host.hostId }))
      expect(gateway.state().hosts.map(entry => entry.hostId)).toEqual([host.hostId])
      expect(gateway.state().projects.map(entry => entry.projectId)).toEqual([project.projectId])
      expect(gateway.state().sessions).toEqual([])

      await gateway.dispatch(request('session.unarchive', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.map(entry => entry.sessionId)).toEqual([session.sessionId])

      const renamed = await gateway.dispatch(request('project.rename', {
        projectId: project.projectId, title: 'renamed',
      })) as unknown as { title: string }
      expect(renamed.title).toBe('renamed')

      await gateway.dispatch(request('project.hide', { projectId: project.projectId }))
      expect(gateway.state().projects).toEqual([])
      await gateway.dispatch(request('project.unhide', { projectId: project.projectId }))
      expect(gateway.state().projects.map(entry => entry.title)).toEqual(['renamed'])

      await gateway.dispatch(request('session.delete', { sessionId: session.sessionId }))
      expect(gateway.state().sessions).toEqual([])
      const leftover = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'other', cwd: '/other',
      })) as unknown as { projectId: string }
      await gateway.dispatch(request('host.delete', { hostId: host.hostId }))
      expect(gateway.state().hosts).toEqual([])
      expect(gateway.state().projects.map(entry => entry.projectId)).not.toContain(leftover.projectId)
      await expect(gateway.dispatch(request('hidden.list', {}))).resolves.toEqual({ hosts: [], projects: [], sessions: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops last-known inventory when hostd becomes unreachable', async () => {
    const { ctx, gateway, failNext } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'mac-mini', endpoint: 'http://127.0.0.1:4188',
      })) as unknown as { hostId: string; inventory?: { healthy: boolean }; inventoryError?: string }
      expect(host.inventory?.healthy).toBe(true)
      expect(host.inventoryError).toBeUndefined()

      failNext()
      const refreshed = await gateway.dispatch(request('inventory', { hostId: host.hostId })) as unknown as {
        inventory?: { healthy: boolean }
        inventoryError?: string
      }
      expect(refreshed.inventory).toBeUndefined()
      expect(refreshed.inventoryError).toContain('无法连接到 hostd')
      expect(gateway.state().hosts[0]?.inventory).toBeUndefined()
      expect(gateway.state().hosts[0]?.inventoryError).toContain('无法连接到 hostd')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
