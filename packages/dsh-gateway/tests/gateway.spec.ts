import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { hostdArtifactVersionFromDirectory } from '@threadharbor/hostd/version'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend, MemoryMediaPool } from './helpers/memory-backend.ts'
import {
  REMOTE_AGENT_GATEWAY_WS_PATH,
  RemoteHostId, RemoteProjectId, RemoteSessionId, type JsonValue, type RemoteControlRequest,
} from '@threadharbor/protocol'
import RemoteAgentGateway from '../src/index.ts'
import { remoteAgentLegacyDomainSpec } from '../src/spec.ts'
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

function respondToRequest(request: RemoteControlRequest, port: string, events: JsonValue[], startLatestSeq = 0): JsonValue {
  const sessionId = typeof request.params['sessionId'] === 'string' ? request.params['sessionId'] : 'none'
  switch (request.method) {
    case 'inventory':
      return {
        protocolVersion: 1, hostdVersion: process.env['TEST_HOSTD_VERSION'] ?? 'test', hostId: `hostd-${port}`, healthy: true,
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
    case 'session.restart':
      return {
        holdId: `hold-${port}-${sessionId}`, nativeSessionId: `native-${port}-${sessionId}`,
        generation: 'g1', latestSeq: startLatestSeq,
        // A real hostd reports where the model's context actually came from, and
        // reports `reconstructed` only when it was handed text to stand in for
        // an Agent session it could not reopen.
        contextSource: request.params['context'] === undefined ? 'resumed' : 'reconstructed',
      }
    case 'session.adopt':
      return {
        holdId: `hold-${port}-shared`,
        nativeSessionId: paramString(request, 'nativeSessionId'),
        generation: 'g1',
        latestSeq: events.length,
      }
    case 'session.prompt':
      return { accepted: true, duplicate: false }
    case 'session.native': {
      // The fake hold acknowledges any gateway-issued request by journaling a
      // bare `{}` result under the same JSON-RPC id, like `session/set_mode`.
      const frame = request.params['frame']
      const id = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame['id'] : undefined
      if (typeof id === 'string') events.push({ jsonrpc: '2.0', id, result: {} })
      return { accepted: true }
    }
    case 'events.read':
      return {
        generation: 'g1', latestSeq: events.length, droppedThrough: 0, gap: false,
        events: events.map((frame, index) => ({ seq: index + 1, generation: 'g1', timestamp: '2026-08-28T00:00:00.000Z', frame })),
      }
    default:
      return { accepted: true }
  }
}

async function harness(events: JsonValue[] = [], configOverride: Partial<typeof CONFIG> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const mediaPool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(mediaPool))
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
  const methodErrors = new Map<string, string>()
  /** Method@port pairs whose next hostd request is consumed but never answered. */
  const silenced = new Set<string>()
  /** Ports whose sockets never open, like a hostd that is not running. */
  const deadPorts = new Set<string>()
  /** Every live-port socket by port, so a port can be killed mid-test. */
  const socketsByPort = new Map<string, MockSocket[]>()
  let nextAttach: Record<string, JsonValue> | undefined
  /** Journal head a fake `session.start` reports; tests that inject bind-time
   *  frames (the session/new answer) set it so the gateway's window read sees them. */
  let nextStartLatestSeq: number | undefined
  /** Per-socket map of subscribed sessions for the WS push fan-out. */
  const subscriptionsBySocket = new WeakMap<MockSocket, Map<string, { generation: string; lastSeq: number }>>()
  let pushSeq = 0
  function socketFactory(url: string): MockSocket {
    const portMatch = /:(\d+)/.exec(url)
    const port = portMatch?.[1] ?? '0'
    if (deadPorts.has(port)) {
      // A refused connection: the socket errors out instead of hanging, so the
      // reconnect ladder keeps advancing exactly like a real ECONNREFUSED.
      const dead = makeMockSocket(() => undefined)
      dead.readyState = CONNECTING
      setImmediate(() => {
        dead.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:' + port))
        dead.emit('close')
      })
      return dead
    }
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
        if (silenced.delete(`${request.method}@${port}`)) return undefined
        const errorMessage = methodErrors.get(request.method)
        if (errorMessage !== undefined) {
          methodErrors.delete(request.method)
          return JSON.stringify({
            direction: 'response', id: request.id, ok: false,
            error: { code: 'HOSTD_ERROR', message: errorMessage },
          })
        }
        const result = request.method === 'session.attach' && nextAttach !== undefined
          ? { ...respondToRequest(request, port, events, nextStartLatestSeq ?? 0) as Record<string, JsonValue>, ...nextAttach }
          : respondToRequest(request, port, events, nextStartLatestSeq ?? 0)
        if (request.method === 'session.attach') nextAttach = undefined
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
    const tracked = socketsByPort.get(port) ?? []
    tracked.push(socket)
    socketsByPort.set(port, tracked)
    queueMicrotask(() => {
      socket.readyState = OPEN
      socket.emit('open')
    })
    void url
    return socket
  }

  /** Make one port's hostd unreachable: new sockets never open, and existing
   *  live sockets for the port die, like the daemon being stopped. */
  function killPort(port: string): void {
    deadPorts.add(port)
    for (const socket of socketsByPort.get(port) ?? []) {
      if (socket.readyState !== CLOSED) {
        socket.readyState = CLOSED
        socket.emit('close')
      }
    }
  }

  /** Bring one port's hostd back. */
  function revivePort(port: string): void {
    deadPorts.delete(port)
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

  const transcriptDir = mkdtempSync(join(tmpdir(), 'th-transcript-'))
  transcriptDirs.push(transcriptDir)
  await ctx.plugin(RemoteAgentGateway, { ...CONFIG, transcriptDir, ...configOverride }).await()
  ctx.remoteAgentGateway.setHostdSocketFactory(socketFactory as unknown as (url: string) => import('ws').WebSocket)
  return {
    ctx, gateway: ctx.remoteAgentGateway, calls, storageDomain, transcriptDir, mediaPool,
    failNext: () => { failing = true },
    failMethod: (method: string, message: string) => { methodErrors.set(method, message) },
    silenceMethod: (method: string, port: string) => { silenced.add(`${method}@${port}`) },
    killPort,
    revivePort,
    setNextAttach: (value: Record<string, JsonValue>) => { nextAttach = value },
    setNextStartLatestSeq: (value: number) => { nextStartLatestSeq = value },
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

// session.start waits for the hold outside the catalog lock, then returns the
// bound row. Tests that race follow/prompt against a delayed hostd still use
// waitForSessionBinding.
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

const transcriptDirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of transcriptDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RemoteAgentGateway', () => {
  it('registers the browser WebSocket route through webServer.registerUpgrade', async () => {
    const { ctx, upgradePath } = await harness()
    try {
      expect(upgradePath).toBe(REMOTE_AGENT_GATEWAY_WS_PATH)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the current hostd artifact digest so the web can offer upgrades', async () => {
    const { ctx, gateway } = await harness()
    try {
      const expected = hostdArtifactVersionFromDirectory(join(process.cwd(), 'packages/hostd/lib'))
      expect(gateway.state().hostdArtifactVersion).toBe(expected)
      expect(gateway.state().hostdArtifactVersion).toMatch(/^0\.1\.0(\+[0-9a-f]{12})?$/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stores the first user message, returns the connecting row, then binds the hold in the background', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4301' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'hello there', backend: 'codex',
        text: 'hello there', clientId: 'browser', requestId: 'first',
      })) as unknown as { sessionId: string; channelState: string; latestTranscriptSeq?: number }
      // The message is accepted in the same RPC: the gateway returns the
      // connecting row immediately and drives hold startup + first-message
      // delivery in the background (session.start no longer blocks on it).
      expect(session.channelState).toBe('connecting')
      expect(session.latestTranscriptSeq).toBe(0)
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries).toEqual([expect.objectContaining({
        sessionId: session.sessionId, role: 'user', kind: 'message', text: 'hello there', requestId: 'first',
      })])
      await waitForSessionBinding(gateway, session.sessionId)
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.binding?.state).toBe('active')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('auto-delivers the first message after the hold binds and emits session.progress stages', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4302' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const started = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'first', backend: 'codex',
        text: 'first message', clientId: 'browser', requestId: 'first-msg',
      })) as unknown as { sessionId: string; channelState: string }
      expect(started.channelState).toBe('connecting')
      // The browser performs a single RPC: the gateway must deliver the message
      // itself once the hold is up (no browser session.prompt required).
      await vi.waitFor(() => {
        expect(calls.some(call => call.request.method === 'session.prompt')).toBe(true)
      })
      await waitForSessionBinding(gateway, started.sessionId)
      const delivered = calls.filter(call => call.request.method === 'session.prompt')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.request.params['admission']).toMatchObject({ clientId: 'browser', requestId: 'first-msg' })
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(started.sessionId))?.turnState)
        .toBe('running')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to treat an SSH tunnel port as a local hostd upgrade target', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'box', endpoint: 'http://127.0.0.1:65534' })) as unknown as { hostId: string }
      await expect(gateway.dispatch(request('host.upgrade', { hostId: host.hostId, confirm: true })))
        .rejects.toThrow('找不到本机 hostd 进程')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers a Claude permission request with JSON-RPC id 0 and catches up the journal', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {
        title: 'Exit plan?',
        options: [{ optionId: 'bypassPermissions', name: 'Yes, and bypass permissions' }],
      } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4301' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.permission', {
        sessionId: session.sessionId, requestId: '0', outcome: { outcome: 'selected', optionId: 'bypassPermissions' },
      }))
      const forwarded = calls.find(call => call.request.method === 'session.permission')?.request
      expect(forwarded?.params['frame']).toMatchObject({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'bypassPermissions' } } })
      expect(calls.filter(call => call.request.method === 'events.read').length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a turn parked on an unanswered question while a background subagent keeps reporting', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: {
        mode: 'form', message: '任务 2 的分支从哪里创建？',
        requestedSchema: { type: 'object', properties: { base: { type: 'string', enum: ['dev', 'task-1'] } } },
      } },
      // Subagent output after the question: these used to flip the turn back to running.
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep foo' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4302' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const parked = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(parked?.turnState).toBe('waiting-permission')
      expect(parked?.pendingRequestIds).toEqual(['1'])

      await gateway.dispatch(request('session.permission', {
        sessionId: session.sessionId, requestId: '1', outcome: { outcome: 'selected', optionId: 'dev' },
      }))
      const answered = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(answered?.turnState).toBe('running')
      expect(answered?.pendingRequestIds).toBeUndefined()

      events.push({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const finished = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(finished?.turnState).toBe('idle')
      expect(finished?.pendingRequestIds).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a finished round idle when late subagent output streams in after prompt_complete', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep foo' } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4302' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState).toBe('idle')

      // A background subagent keeps reporting after the round already ended:
      // these frames used to flip the finished session back to `running`, and
      // no second prompt_complete ever arrives to idle it again.
      events.push(
        { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二个调查回来了，补充三点。' } } } },
        { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } },
      )
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState).toBe('idle')
      // The late content itself still lands in the transcript.
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.role === 'assistant' && entry.text.includes('第二个调查回来了'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a round that completes mid-page idle when later frames in the same page keep reporting', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep foo' } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '后台任务收尾。' } } } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4302' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('delivers a chat message as the free-text answer of an open AskUserQuestion instead of queueing it', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 4, method: 'elicitation/create', params: {
        mode: 'form', message: '分支从哪个基线建？',
        requestedSchema: { type: 'object', properties: {
          question_0: { type: 'string', title: '基线', oneOf: [{ const: '本地 dev', title: '本地 dev' }, { const: 'origin/dev', title: 'origin/dev' }] },
          question_0_custom: { type: 'string', title: 'Other', _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } } },
        } },
      } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4303' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.pendingRequestIds).toEqual(['4'])
      const promptsBefore = calls.filter(call => call.request.method === 'session.prompt').length

      const result = await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'r-answer', text: '从远程 dev 基线建',
      })) as unknown as { accepted: boolean; answeredRequestId?: string }
      expect(result).toMatchObject({ accepted: true, answeredRequestId: '4' })
      const answered = calls.filter(call => call.request.method === 'session.permission').at(-1)?.request
      expect(answered?.params['frame']).toEqual({
        jsonrpc: '2.0', id: 4, result: { action: 'accept', content: { question_0_custom: '从远程 dev 基线建' } },
      })
      // No session/prompt was queued behind the blocked turn.
      expect(calls.filter(call => call.request.method === 'session.prompt')).toHaveLength(promptsBefore)
      const view = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(view?.pendingRequestIds).toBeUndefined()
      expect(view?.turnState).toBe('running')
      const page = await gateway.dispatch(request('transcript.read', { sessionId: session.sessionId })) as unknown as { entries: Array<{ role: string; text: string }> }
      expect(page.entries.filter(row => row.role === 'user').map(row => row.text)).toContain('从远程 dev 基线建')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a chat message while a tool permission card is open, pointing the user at the card', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: {
        title: 'Run npm test?', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4304' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const promptsBefore = calls.filter(call => call.request.method === 'session.prompt').length
      await expect(gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'r-blocked', text: '继续',
      }))).rejects.toThrow('请先在卡片中回答')
      expect(calls.filter(call => call.request.method === 'session.prompt')).toHaveLength(promptsBefore)
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState).toBe('waiting-permission')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('captures backend-advertised settings from session/new and switches them through session.configure', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 'hostd-session-1', result: {
        sessionId: 'native-4301-x',
        configOptions: [
          { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', options: [
            { value: 'default', name: 'Manual' }, { value: 'bypassPermissions', name: 'Bypass Permissions' },
          ] },
          { id: 'model', name: 'Model', category: 'model', currentValue: 'default', options: [
            { value: 'default', name: 'Default' }, { value: 'sonnet', name: 'Sonnet' },
          ] },
        ],
      } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4301' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const announced = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(announced?.configOptions?.map(option => `${option.id}=${option.currentValue}`)).toEqual(['mode=default', 'model=default'])

      await expect(gateway.dispatch(request('session.configure', {
        sessionId: session.sessionId, configId: 'mode', value: 'nope',
      }))).rejects.toThrow(/不支持取值 nope/)
      await expect(gateway.dispatch(request('session.configure', {
        sessionId: session.sessionId, configId: 'effort', value: 'high',
      }))).rejects.toThrow(/尚未公布/)

      const switched = await gateway.dispatch(request('session.configure', {
        sessionId: session.sessionId, configId: 'mode', value: 'bypassPermissions',
      })) as unknown as { configOptions?: { id: string; currentValue: string }[] }
      const forwarded = calls.find(call => call.request.method === 'session.native')?.request
      expect(forwarded?.params['frame']).toMatchObject({
        jsonrpc: '2.0', method: 'session/set_config_option',
        params: { sessionId: `native-4301-${session.sessionId}`, configId: 'mode', value: 'bypassPermissions' },
      })
      expect(switched.configOptions?.find(option => option.id === 'mode')?.currentValue).toBe('bypassPermissions')
      const stored = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(stored?.configOptions?.find(option => option.id === 'mode')?.currentValue).toBe('bypassPermissions')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flattens grouped model options from the Harness ACP profile and switches them by opaque value', async () => {
    // The Harness acp profile groups every model under its provider route and
    // hands back an opaque encoded provider/model pair as the value. A flat read
    // of `options` would find no choices and drop the model selector entirely.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 'hostd-session-1', result: {
        sessionId: 'native-4302-x',
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select',
            currentValue: '["deepseek-official","deepseek-v4-flash"]',
            options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
              { value: '["deepseek-official","deepseek-v4-flash"]', name: 'DeepSeek-V4-Flash' },
              { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
            ] }] },
          { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
            currentValue: 'high', options: [{ value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] },
        ],
      } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4302' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'dsh' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const announced = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(announced?.configOptions?.map(option => option.id)).toEqual(['model', 'reasoning_effort'])
      expect(announced?.configOptions?.[0]?.options.map(choice => choice.name))
        .toEqual(['DeepSeek · DeepSeek-V4-Flash', 'DeepSeek · DeepSeek-V4-Pro'])

      const switched = await gateway.dispatch(request('session.configure', {
        sessionId: session.sessionId, configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]',
      })) as unknown as { configOptions?: { id: string; currentValue: string }[] }
      const forwarded = calls.filter(call => call.request.method === 'session.native').at(-1)?.request
      expect(forwarded?.params['frame']).toMatchObject({
        jsonrpc: '2.0', method: 'session/set_config_option',
        params: {
          sessionId: `native-4302-${session.sessionId}`,
          configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]',
        },
      })
      expect(switched.configOptions?.find(option => option.id === 'model')?.currentValue)
        .toBe('["deepseek-official","deepseek-v4-pro"]')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('delivers a DeepSeek Harness prompt in the ACP shape its acp profile expects', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4303' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'dsh' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dsh-acp-prompt', text: 'hello',
      }))
      const delivered = calls.filter(call => call.request.method === 'session.prompt')
      expect(delivered).toHaveLength(1)
      const admission = delivered[0]?.request.params['admission'] as Record<string, JsonValue>
      const frame = admission['frame'] as Record<string, JsonValue>
      expect(frame['method']).toBe('session/prompt')
      expect(frame['params']).toMatchObject({ prompt: [{ type: 'text', text: 'hello' }] })
      expect((frame['params'] as Record<string, JsonValue>)['contentBlocks']).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the settings a backend published during binding into the created session', async () => {
    // `initialize` and the `session/new` answer land in the hold journal before
    // the binding exists. The gateway must fold that window itself: the Harness
    // ACP profile only publishes its model catalog at handshake, so waiting for
    // a later journal sync would leave the composer with a built-in guess.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 'init-1', result: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 'new-1', result: {
        sessionId: 'native-4305-x',
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', currentValue: '["deepseek-official","deepseek-v4-pro"]',
            options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
              { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
              { value: '["zai-coding-cn","glm-5.3"]', name: 'GLM-5.3' },
            ] }] },
        ],
      } },
    ]
    const { ctx, gateway, setNextStartLatestSeq } = await harness(events)
    try {
      setNextStartLatestSeq(events.length)
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4305' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: '新会话', backend: 'dsh',
      })) as unknown as {
        sessionId: string
        configOptions?: { id: string; setter: string; options: { readonly name: string }[] }[]
      }
      expect(session.configOptions?.map(option => `${option.id}:${option.setter}`)).toEqual(['model:config'])
      expect(session.configOptions?.[0]?.options.map(choice => choice.name))
        .toEqual(['DeepSeek · DeepSeek-V4-Pro', 'DeepSeek · GLM-5.3'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names a session from its first message when the Agent was picked before the message existed', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4304' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      // Picking the Agent creates the session with the placeholder title so the
      // composer can offer the backend's own catalog before anything is sent.
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: '新会话', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const title = (): string | undefined => gateway.state().sessions
        .find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.title
      expect(title()).toBe('新会话')

      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'p1',
        text: '继续优化一下桌面版的交互\n第二行不该进标题',
      }))
      expect(title()).toBe('继续优化一下桌面版的交互')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers an elicitation form with ACP accept content instead of a permission outcome', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 4, method: 'elicitation/create', params: {
        mode: 'form', message: '选哪种方案？',
        requestedSchema: { type: 'object', properties: { strategy: { type: 'string', enum: ['a', 'b'] } } },
      } },
    ]
    const { ctx, gateway, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4301' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      await gateway.dispatch(request('session.permission', {
        sessionId: session.sessionId, requestId: '4', outcome: { action: 'accept', content: { strategy: 'b' } },
      }))
      const forwarded = calls.find(call => call.request.method === 'session.permission')?.request
      expect(forwarded?.params['frame']).toMatchObject({
        jsonrpc: '2.0', id: 4, result: { action: 'accept', content: { strategy: 'b' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not duplicate transcript when the same journal page is applied twice', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello ' } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'world' } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4302' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dup', text: 'hi',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const page = await readTranscript(gateway, session.sessionId)
      const assistant = page.entries.filter(entry => entry.role === 'assistant').map(entry => entry.text).join('')
      expect(assistant).toBe('hello world')
      expect(page.entries.filter(entry => entry.text === 'hello world' || entry.text === 'hello ' || entry.text === 'world').length)
        .toBeGreaterThan(0)
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

  it('short-circuits a re-deploy when the remote hostd already matches the gateway artifact version', async () => {
    const { ctx, gateway, calls } = await harness()
    const previous = process.env['TEST_HOSTD_VERSION']
    const previousArtifact = process.env['THREADHARBOR_TEST_HOSTD_DIR']
    try {
      const expected = hostdArtifactVersionFromDirectory(join(process.cwd(), 'packages/hostd/lib'))
      process.env['TEST_HOSTD_VERSION'] = expected
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4101',
      })) as unknown as { hostId: string }
      await vi.waitFor(() => {
        const inventory = gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)?.inventory
        if (inventory?.healthy !== true) throw new Error('inventory not healthy yet')
      }, { timeout: 2000, interval: 10 })
      expect(gateway.state().hostdArtifactVersion).toBe(expected)
      const started = await gateway.dispatch(request('operation.start', {
        kind: 'host-ssh-deploy',
        title: 'host',
        hostId: host.hostId,
        ssh: { target: '127.0.0.1', user: 'agent', identityFile: '/dev/null', hostKeyFingerprint: 'SHA256:fake' },
        confirm: true,
      })) as unknown as { operationId: string; status: string; detail: string }
      expect(started.status).toBe('succeeded')
      expect(started.detail).toMatch(/已是最新版本/)
      // No SSH deploy was enqueued: there should be no inventory refresh storm
      // and the test's mock socket never saw a deploy-related call.
      const inventoryCalls = calls.filter(call => call.request.method === 'inventory')
      expect(inventoryCalls.length).toBeLessThan(3)
      void previousArtifact
    } finally {
      if (previous === undefined) delete process.env['TEST_HOSTD_VERSION']
      else process.env['TEST_HOSTD_VERSION'] = previous
      if (previousArtifact === undefined) delete process.env['THREADHARBOR_TEST_HOSTD_DIR']
      else process.env['THREADHARBOR_TEST_HOSTD_DIR'] = previousArtifact
      await ctx.fiber.dispose()
    }
  })

  it('short-circuits a re-deploy when the remote hostd label differs but the artifact digest matches', async () => {
    // SSH-deployed hostd reports `unknown+<digest>` (no package.json beside the
    // uploaded artifacts) for the same bytes the gateway stamps `0.1.0+<digest>`.
    // Upgrade detection compares the digest after `+`, not the full string.
    const { ctx, gateway } = await harness()
    const previous = process.env['TEST_HOSTD_VERSION']
    try {
      const expected = hostdArtifactVersionFromDirectory(join(process.cwd(), 'packages/hostd/lib'))
      const digest = expected.includes('+') ? expected.slice(expected.indexOf('+') + 1) : expected
      process.env['TEST_HOSTD_VERSION'] = `unknown+${digest}`
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4102',
      })) as unknown as { hostId: string }
      await vi.waitFor(() => {
        const inventory = gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)?.inventory
        if (inventory?.healthy !== true) throw new Error('inventory not healthy yet')
      }, { timeout: 2000, interval: 10 })
      expect(gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)?.inventory?.hostdVersion)
        .toBe(`unknown+${digest}`)
      const started = await gateway.dispatch(request('operation.start', {
        kind: 'host-ssh-deploy',
        title: 'host',
        hostId: host.hostId,
        ssh: { target: '127.0.0.1', user: 'agent', identityFile: '/dev/null', hostKeyFingerprint: 'SHA256:fake' },
        confirm: true,
      })) as unknown as { status: string; detail: string }
      expect(started.status).toBe('succeeded')
      expect(started.detail).toMatch(/已是最新版本/)
    } finally {
      if (previous === undefined) delete process.env['TEST_HOSTD_VERSION']
      else process.env['TEST_HOSTD_VERSION'] = previous
      await ctx.fiber.dispose()
    }
  })

  it('still queues a re-deploy when the remote hostd version is behind the gateway artifact', async () => {
    const { ctx, gateway } = await harness()
    const previous = process.env['TEST_HOSTD_VERSION']
    try {
      process.env['TEST_HOSTD_VERSION'] = '0.0.0-stale'
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4101',
      })) as unknown as { hostId: string }
      await vi.waitFor(() => {
        const inventory = gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)?.inventory
        if (inventory?.healthy !== true) throw new Error('inventory not healthy yet')
      }, { timeout: 2000, interval: 10 })
      const started = await gateway.dispatch(request('operation.start', {
        kind: 'host-ssh-deploy',
        title: 'host',
        hostId: host.hostId,
        ssh: { target: '127.0.0.1', user: 'agent', identityFile: '/dev/null', hostKeyFingerprint: 'SHA256:fake' },
        confirm: true,
      })) as unknown as { operationId: string; status: string }
      expect(started.status).toBe('queued')
      // The deploy path will fail in this harness because there is no real SSH
      // host; we only assert that the operation entered the queue rather than
      // being short-circuited.
    } finally {
      if (previous === undefined) delete process.env['TEST_HOSTD_VERSION']
      else process.env['TEST_HOSTD_VERSION'] = previous
      await ctx.fiber.dispose()
    }
  })

  it('concludes a running turn that goes silent past the idle ceiling so it stops polling the tunnel forever', async () => {
    // No events are ever emitted for this session, so its journal never advances
    // and no completion frame arrives — the pre-fix zombie shape. The follow loop
    // must conclude the stuck turn instead of polling events.read forever.
    const { ctx, gateway, calls } = await harness([], { runningTurnIdleTimeoutMs: 150 })
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4360' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'stuck', backend: 'codex',
        text: 'hello?', clientId: 'c', requestId: 'r1',
      })) as unknown as { sessionId: string }
      // The turn goes running on delivery, then the idle backstop concludes it.
      await vi.waitFor(() => {
        const s = gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)
        if (s?.turnState !== 'failed') throw new Error(`turn state ${s?.turnState ?? 'missing'}`)
      }, { timeout: 4000, interval: 25 })
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('failed')
      // And once concluded (turnState no longer running, no followers), the loop
      // stops issuing events.read — the count stabilizes.
      const before = calls.filter(call => call.request.method === 'events.read').length
      await new Promise(resolve => setTimeout(resolve, 400))
      const after = calls.filter(call => call.request.method === 'events.read').length
      expect(after).toBe(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts a fresh silence clock per turn while a browser keeps the follow loop alive', async () => {
    // Session 8ccb9aa7 live: the follow loop had outlived an earlier turn (a
    // browser was following), so its stale "last progress" timestamp concluded
    // the *next* prompt as 长时间无响应 one second after it was sent.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events, { runningTurnIdleTimeoutMs: 200 })
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4361' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const browser = makeBrowserSocket()
      gateway.registerBrowserForTesting(browser as unknown as WebSocket, 'alice')
      await gateway.dispatch(request('session.follow', { browserId: 'alice', sessionId: session.sessionId }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('idle')
      // Let the followed-but-idle loop sit well past the ceiling.
      await new Promise(resolve => setTimeout(resolve, 500))
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'r-late', text: 'again',
      }))
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('running')
      // With no journal activity at all the ceiling still applies — from the
      // prompt, not from the previous turn.
      await vi.waitFor(() => {
        const s = gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)
        if (s?.turnState !== 'failed') throw new Error(`turn state ${s?.turnState ?? 'missing'}`)
      }, { timeout: 2000, interval: 25 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('catalogues an SSH host immediately and keeps it after a failed background deploy', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.ssh.add', {
        title: 'edge', ssh: { target: '127.0.0.1', user: 'agent', identityFile: '/dev/null' },
      })) as unknown as { hostId: string; deployState?: string; endpoint?: string }
      // Persisted before any SSH work: pending, no endpoint, already in state.
      expect(host.deployState).toBe('pending')
      expect(host.endpoint).toBeUndefined()
      expect(gateway.state().hosts.some(candidate => candidate.hostId === host.hostId)).toBe(true)
      // A background deploy operation was queued for it.
      expect(gateway.state().operations.some(operation =>
        operation.kind === 'host-ssh-deploy' && operation.hostId === host.hostId)).toBe(true)
      // The deploy fails in this harness (no real SSH host), but the host must
      // survive as 'failed' with an actionable reason — it must never vanish.
      await vi.waitFor(() => {
        const latest = gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)
        if (latest?.deployState !== 'failed') throw new Error(`deploy state ${latest?.deployState ?? 'missing'}`)
      }, { timeout: 5000, interval: 20 })
      const failed = gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)
      expect(failed?.deployError).toBeTruthy()
      expect(failed?.endpoint).toBeUndefined()
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

  it('returns newly created sessions at the top of the project list in state()', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4401' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const first = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'first', backend: 'codex' })) as unknown as { sessionId: string }
      // Spread the `updatedAt` timestamps so the sort has a stable ordering
      // even on hosts where `Date.now()` would otherwise tie within a single
      // millisecond.
      await new Promise(resolve => setTimeout(resolve, 5))
      const second = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'second', backend: 'codex' })) as unknown as { sessionId: string }
      await new Promise(resolve => setTimeout(resolve, 5))
      const third = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'third', backend: 'codex' })) as unknown as { sessionId: string }

      const state = gateway.state()
      // Most-recently created must be first so the sidebar shows the
      // just-created session at the top instead of at the bottom.
      expect(state.sessions.map(session => session.sessionId)).toEqual([
        RemoteSessionId(third.sessionId),
        RemoteSessionId(second.sessionId),
        RemoteSessionId(first.sessionId),
      ])
      // Sending to the oldest session moves it up: the user's own send is the
      // only thing that reorders the list.
      await waitForSessionBinding(gateway, first.sessionId)
      await new Promise(resolve => setTimeout(resolve, 5))
      await gateway.dispatch(request('session.prompt', {
        sessionId: first.sessionId, clientId: 'browser', requestId: 'r-first', text: 'again',
      }))
      expect(gateway.state().sessions.map(session => session.sessionId)).toEqual([
        RemoteSessionId(first.sessionId),
        RemoteSessionId(third.sessionId),
        RemoteSessionId(second.sessionId),
      ])
      // Agent-side activity on another session (journal catch-up, view
      // writes) bumps its `updatedAt` but must not shuffle the list.
      await waitForSessionBinding(gateway, second.sessionId)
      await new Promise(resolve => setTimeout(resolve, 5))
      await gateway.dispatch(request('events.read', { sessionId: second.sessionId }))
      await gateway.dispatch(request('session.rename', { sessionId: second.sessionId, title: 'renamed' }))
      expect(gateway.state().sessions.map(session => session.sessionId)).toEqual([
        RemoteSessionId(first.sessionId),
        RemoteSessionId(third.sessionId),
        RemoteSessionId(second.sessionId),
      ])
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

  it('keeps the native frame only on choice and plan rows, never on tool rows', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { title: 'Allow?', options: [] } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read_file', rawInput: { path: '/big' } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Read /big', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(2000) } }] } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'pending' }] } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4240' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', { sessionId: session.sessionId, clientId: 'browser', requestId: 'frame-1', text: 'hello' }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const transcript = (await readTranscript(gateway, session.sessionId)).entries as Array<{ role: string; kind: string; nativeFrame?: unknown }>
      const byKind = (role: string, kind: string) => transcript.filter(entry => entry.role === role && entry.kind === kind)
      expect(byKind('permission', 'permission').every(entry => entry.nativeFrame !== undefined)).toBe(true)
      expect(byKind('tool', 'tool-call')).toHaveLength(1)
      expect(byKind('tool', 'tool-result')).toHaveLength(1)
      expect(byKind('tool', 'tool-call')[0]?.nativeFrame).toBeUndefined()
      expect(byKind('tool', 'tool-result')[0]?.nativeFrame).toBeUndefined()
      const plan = transcript.find(entry => entry.role === 'system' && entry.kind === 'status' && (entry as { text: string }).text.includes('step one'))
      expect(plan?.nativeFrame).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('routes Claude subagent tool frames into a virtual child session and keeps the parent transcript continuous', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: '三处需' } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: '要改。' } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'Task', rawInput: { description: 'Test the fix' }, _meta: { claudeCode: { toolName: 'Agent', toolCallId: 'task-1', subagent: true } } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'sub-1', title: 'git diff', _meta: { claudeCode: { toolName: 'Bash', toolCallId: 'sub-1', parentToolUseId: 'task-1', title: 'Read production diff' } } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'sub-1', status: 'completed', _meta: { claudeCode: { toolName: 'Bash', toolCallId: 'sub-1', parentToolUseId: 'task-1' } } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4440' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      // The routing keys off the frame's `_meta.claudeCode` marker, not the
      // catalog backend field; the harness inventory cannot start claude
      // sessions, and the ACP projection path is shared by all ACP backends.
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', { sessionId: session.sessionId, clientId: 'browser', requestId: 'sub-1', text: 'hello' }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))

      const child = gateway.state().sessions.find(entry => entry.parentSessionId === session.sessionId)
      expect(child).toBeDefined()
      expect(child?.nativeChildKey).toBe('task-1')
      expect(child?.title).toBe('Test the fix')
      expect(child?.backend).toBe('codex')
      expect(child?.channelState).toBe('open')
      // The round ended (prompt_complete), so the projected child settles.
      expect(child?.turnState).toBe('idle')

      // The parent keeps its own narration (adjacent deltas merge), the Task
      // spawn card and the round status — never the subagent's tool frames.
      const parent = (await readTranscript(gateway, session.sessionId)).entries
      expect(parent.map(entry => [entry.role, entry.kind, entry.text])).toEqual([
        ['user', 'message', 'hello'],
        ['assistant', 'message', '三处需要改。'],
        ['tool', 'tool-call', 'Task'],
        ['system', 'status', '远程轮次完成'],
      ])

      // The subagent's activity lives in the child session's own transcript.
      const childTranscript = (await readTranscript(gateway, child!.sessionId)).entries
      expect(childTranscript.map(entry => [entry.role, entry.kind, entry.text])).toEqual([
        ['tool', 'tool-call', 'git diff'],
        ['tool', 'tool-result', '远程工具更新'],
      ])
      // Child rows keep the complete native frame — the parent's size rule
      // (choice/plan rows only) does not apply to the subagent's own record.
      const childFrames = (childTranscript as Array<{ nativeFrame?: Record<string, JsonValue> }>).map(entry => entry.nativeFrame)
      expect(childFrames[0]?.['params']).toMatchObject({ update: { sessionUpdate: 'tool_call', toolCallId: 'sub-1' } })
      expect(childFrames[1]?.['params']).toMatchObject({ update: { sessionUpdate: 'tool_call_update', toolCallId: 'sub-1' } })

      // Re-applying the same journal page (reconnect replay) creates neither
      // a second child session nor duplicate rows.
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.filter(entry => entry.parentSessionId === session.sessionId)).toHaveLength(1)
      expect((await readTranscript(gateway, child!.sessionId)).entries).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('imports transcript rows left in the storage domain once and drops tool frames on the way', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', storageDomain)
    ctx.reflect.provide('storageDomain', storageDomain)
    ctx.reflect.provide('webServer', { register: () => () => undefined, registerUpgrade: () => () => undefined })
    const transcriptDir = mkdtempSync(join(tmpdir(), 'th-transcript-'))
    transcriptDirs.push(transcriptDir)
    try {
      // Seed the unit the way the pre-store gateway wrote it: catalog plus a
      // transcript table carrying raw frames on every row.
      const legacy = await storageDomain.open(remoteAgentLegacyDomainSpec)
      const sessionId = RemoteSessionId('11111111-1111-4111-8111-111111111111')
      const projectId = RemoteProjectId('22222222-2222-4222-8222-222222222222')
      const hostId = RemoteHostId('33333333-3333-4333-8333-333333333333')
      const now = '2026-09-12T00:00:00.000Z'
      await legacy.table('hosts').put(hostId, { hostId, title: 'h', endpoint: 'http://127.0.0.1:1', createdAt: now, updatedAt: now })
      await legacy.table('projects').put(projectId, { projectId, hostId, title: 'p', cwd: '/repo', createdAt: now, updatedAt: now })
      await legacy.table('sessions').put(sessionId, {
        sessionId, projectId, title: 's', backend: 'codex', channelState: 'lost', turnState: 'idle', createdAt: now, updatedAt: now,
      })
      const toolFrame = { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read_file' } } }
      const permissionFrame = { jsonrpc: '2.0', id: 4, method: 'session/request_permission', params: { title: 'Allow?', options: [] } }
      await legacy.table('transcript').put('t-0' as never, {
        transcriptId: 't-0', sessionId, seq: 0, role: 'tool', kind: 'tool-call', text: 'read_file', createdAt: now, nativeFrame: toolFrame,
      } as never)
      await legacy.table('transcript').put('t-1' as never, {
        transcriptId: 't-1', sessionId, seq: 1, role: 'permission', kind: 'permission', text: 'Allow?', createdAt: now, nativeFrame: permissionFrame, requestId: '4',
      } as never)
      await legacy.global.set({ hostIds: [hostId], projectIds: [projectId], sessionIds: [sessionId], nextTranscriptSeq: { [sessionId]: 2 }, droppedThrough: {} })
      await legacy.close()

      await ctx.plugin(RemoteAgentGateway, { ...CONFIG, transcriptDir }).await()
      const gateway = ctx.remoteAgentGateway
      const page = await readTranscript(gateway, sessionId)
      expect(page.entries.map(entry => [entry.seq, entry.role, (entry as { nativeFrame?: unknown }).nativeFrame !== undefined])).toEqual([
        [0, 'tool', false],
        [1, 'permission', true],
      ])
      // The marker keeps a second start from re-reading the legacy table.
      expect(existsSync(join(transcriptDir, 'legacy-domain-imported'))).toBe(true)
      expect(existsSync(join(transcriptDir, `${sessionId}.jsonl`))).toBe(true)
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
      const currentTurn = await readTranscript(gateway, session.sessionId, { limit: 2 })
      expect(currentTurn.hasMore).toBe(true)
      expect(currentTurn.entries.map(entry => entry.text)).toEqual(['hello', 'Allow?'])
      const rest = await readTranscript(gateway, session.sessionId, { afterSeq: currentTurn.toSeq, limit: 2 })
      expect(rest.entries.map(entry => entry.text)).toEqual(['answer', '远程轮次完成'])
      expect(rest.hasMore).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records droppedThrough when the per-session ring deletes older entries', async () => {
    // 21 distinct tool_call events produce 21 transcript rows that won't merge;
    // combined with the single user row from `session.prompt` we exceed the
    // test config's `maxTranscriptEntriesPerSession: 20` so the oldest two
    // rows get rotated out, and the gateway must surface `droppedThrough` so
    // the browser can show a banner.
    const events: JsonValue[] = Array.from({ length: 21 }, (_, index) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: `call-${index}`, title: `Load skill ${index}` } },
    }))
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4220' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      // Pre-trim: no rotation has happened yet, so the projection omits the
      // optional field entirely (matches the optional schema in spec.ts).
      const beforeView = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(beforeView?.droppedThrough).toBeUndefined()

      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'trim-1', text: 'fill-the-ring',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))

      const page = await readTranscript(gateway, session.sessionId, { limit: 100 })
      // The ring keeps the most recent 20 entries; the oldest 2 (seq 0 and 1)
      // are gone from the projection.
      expect(page.entries[0]?.seq).toBe(2)
      expect(page.entries.at(-1)?.seq).toBe(page.latestSeq)

      // The session view now carries the highest deleted seq so the banner
      // can render. Lost-count in the UI is `droppedThrough + 1`.
      const afterView = gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))
      expect(afterView?.droppedThrough).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('default transcript.read starts at the latest user message when the turn is longer than the page', async () => {
    const events: JsonValue[] = Array.from({ length: 12 }, (_, index) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: `call-${index}`, title: `Load skill ${index}` } },
    }))
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4215' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'long-turn', text: '构建打包重启一下',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const page = await readTranscript(gateway, session.sessionId, { limit: 3 })
      expect(page.entries[0]).toMatchObject({ role: 'user', text: '构建打包重启一下' })
      expect(page.entries.some(entry => entry.role === 'tool')).toBe(true)
      expect(page.hasMore).toBe(true)
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

  it('keeps waiting-permission when elicitation arrives after prompt_complete', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4212' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'request-elicit', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState).toBe('idle')
      events.push({
        jsonrpc: '2.0', id: 0, method: 'elicitation/create',
        params: { mode: 'form', message: '选哪种方案？', requestedSchema: { type: 'object', properties: {} } },
      })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState)
        .toBe('waiting-permission')
      const transcript = (await readTranscript(gateway, session.sessionId)).entries
      expect(transcript.some(entry => entry.kind === 'permission' && entry.text === '选哪种方案？')).toBe(true)
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

  it('fails a running turn when the hold worker is unreachable', async () => {
    const { ctx, gateway, failNext } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4211',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dead-hold', text: 'hello',
      }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('running')
      failNext()
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)).toMatchObject({
        turnState: 'failed', channelState: 'reconnecting',
      })
      const page = await readTranscript(gateway, session.sessionId)
      // A bare connection refusal is the host being unreachable — the record
      // must not claim the Agent process died (that is the dead-socket case,
      // covered separately).
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text.includes('远程主机暂时联系不上'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a failed prompt delivery failed instead of stranding the turn at running', async () => {
    // The follow loop starts projecting the journal in the same breath as the
    // prompt call it races. Writes commit after I/O, so a projection reading
    // the row while the failure marker is still queued sees the old turnState
    // and writes it back over the marker — and the UI then showed 正在生成回复
    // for a turn that had already failed. The injected write latency widens
    // that real window instead of racing real timers for it.
    const { ctx, gateway, failMethod, mediaPool } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4231',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      mediaPool.writeDelayMs = 100
      failMethod('session.prompt', 'agent dsh could not reopen session native-1: Invalid params: session is already active: native-1')
      const failure = gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'undelivered', text: 'hello',
      })).catch(() => undefined)
      // Land a projection inside the window where the failure marker is
      // queued but not yet committed.
      await new Promise(resolveWait => setTimeout(resolveWait, 150))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      await failure
      mediaPool.writeDelayMs = 0
      await new Promise(resolveWait => setTimeout(resolveWait, 300))
      const find = (): string | undefined => gateway.state()
        .sessions.find(entry => entry.sessionId === RemoteSessionId(session.sessionId))?.turnState
      expect(find()).toBe('failed')
      // Later journal catchups must not resurrect the turn either.
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
      expect(find()).toBe('failed')
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text.includes('消息提交失败'))).toBe(true)
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

      expect(gateway.state().sessions.find(candidate => candidate.sessionId === session.sessionId)?.turnState).toBe('stopped')
      const cancelCall = calls.find(call => call.request.method === 'session.cancel')
      expect(cancelCall?.request.params).toMatchObject({
        sessionId: session.sessionId,
        frame: {
          jsonrpc: '2.0', method: 'session/cancel',
          params: { sessionId: `native-4203-${session.sessionId}` },
        },
      })
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '用户主动停止')).toBe(true)
      const pushed = browser.sent.map(payload => JSON.parse(payload) as {
        event?: { type?: string; session?: { turnState?: string } }
      })
      expect(pushed.some(frame => frame.event?.type === 'session.view.changed'
        && frame.event.session?.turnState === 'stopped')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops the waiting UI even when native cancel cannot reach hostd', async () => {
    const { ctx, gateway, failNext } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4212',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'stuck-cancel', text: 'hello',
      }))
      failNext()
      await expect(gateway.dispatch(request('session.cancel', { sessionId: session.sessionId }))).rejects.toThrow()
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('stopped')
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '用户主动停止')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the user-stopped marker when a late native end_turn arrives', async () => {
    const events: JsonValue[] = []
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4213',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'late-complete', text: 'hello',
      }))
      await gateway.dispatch(request('session.cancel', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('stopped')
      events.push({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('stopped')
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '用户主动停止')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a DSH user-stop and drops later native chunks from the dying turn', async () => {
    const events: JsonValue[] = []
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4214',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dsh-stop', text: 'hello',
      }))
      await gateway.dispatch(request('session.cancel', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('stopped')
      const nativeSessionId = `native-4214-${session.sessionId}`
      events.push({
        jsonrpc: '2.0', method: 'session.event',
        params: {
          sessionId: nativeSessionId,
          event: { type: 'assistant/chunk', data: { chunk: { type: 'text', text: 'still going' } } },
        },
      })
      events.push({
        jsonrpc: '2.0', method: 'session.status',
        params: { sessionId: nativeSessionId, status: 'running' },
      })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState).toBe('stopped')
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.text.includes('still going'))).toBe(false)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '用户主动停止')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flips a DSH turn to idle from the synthesized prompt_complete when the backend never sends session.status=idle', async () => {
    // Regression for the asymmetric end-of-turn detection: DSH backends (and
    // test fixtures like fake-dsh.mjs) sometimes return only the JSON-RPC
    // response followed by `session.status=running`, never `idle`. Hold worker
    // synthesizes `_x.ai/session/prompt_complete` for DSH so the gateway
    // projector can flip `turnState` back to `idle` without depending on a
    // follow-up notification the backend may skip.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session.event', params: {
        sessionId: 'native-4215', event: {
          type: 'assistant/chunk', data: { chunk: { type: 'text', text: 'done' } },
        },
      } },
      // Synthesized by hold-worker when the JSON-RPC prompt response arrives
      // and the backend never emits native `session.status=idle` / `turn/end`.
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4215',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dsh-complete', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves a completed round idle when the Agent process exits afterwards', async () => {
    // The Agent's own exit is a journal frame (`_dsh/transport_closed`), and the
    // projector paints it "远程 Agent 已停止（…）" with turnState=failed. When the
    // round already ended — the ordinary case, a backend that exits after the
    // turn, or a redeploy that SIGKILLs it — that late frame used to flip a
    // finished session back to failed, so the conversation kept a red banner and
    // "在当前会话重开" for a round that had actually completed.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
      { jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code: 0, signal: null } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4401',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'exit-after-turn', text: 'hello',
      }))
      // One page: the round ends, then the Agent's exit arrives.
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('idle')
      // The exit is still recorded — it just does not rewrite the round's outcome.
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '远程 Agent 已停止（code 0）'))
        .toBe(true)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '远程轮次完成'))
        .toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a user-stopped round stopped when the Agent exit arrives afterwards', async () => {
    // Same late frame against the other settled state: 用户主动停止 marks the
    // round over too. An exit the user never saw (redeploy SIGKILL, idle exit)
    // must not rewrite that verdict — "stopped" is what the user did, and the
    // prompt-complete/sticky rules already treat it as durable.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
      } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4405',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'stopped-exit', text: 'hello',
      }))
      await gateway.dispatch(request('session.cancel', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('stopped')
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('stopped')
      // The Agent exits long after the user's stop landed.
      events.push({ jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code: null, signal: 'SIGKILL' } })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('stopped')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves an idle session idle when the Agent exit arrives in a later page', async () => {
    // Second shape of the same late frame: the round is already projected and
    // the session has been idle for a while (the browser switched away, or the
    // hold kept living) when the Agent's exit lands in its own journal page.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4403',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'idle-exit', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('idle')
      // The Agent exits while the session sits idle.
      events.push({ jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code: 0, signal: null } })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still fails a turn whose Agent dies before reporting the round over', async () => {
    // The guard must not swallow the case it exists around: a transport that
    // dies mid-turn leaves the turn unfinished, and that has to read as failed.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half an ans' } },
      } },
      { jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code: null, signal: 'SIGKILL' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4404',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dies-mid-turn', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('failed')
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '远程 Agent 已停止（signal SIGKILL）'))
        .toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not let a late round failure rewrite a settled round', async () => {
    // 定调：迟到的「本轮失败」不能把已经结束的轮次改成失败。轮次真正的结局由
    // 开轮（发消息）到收轮（完成帧/停止/死亡）之间的证据决定；收轮之后到达的
    // 失败报告只是记录，不再改写状态。
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4406',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'late-failure', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('idle')
      // 同一轮次稍后报了个失败（重复的收轮帧 / 迟到的错误报告）。
      events.push({
        jsonrpc: '2.0', method: '_x.ai/session/prompt_complete',
        params: { stopReason: 'error', message: 'Internal error: turn failed' },
      })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('idle')
      // 状态不改，但事实照记。
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '远程轮次失败：Internal error: turn failed'))
        .toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the failed mark on reconnect with a visible notice', async () => {
    // 定调：失败是「待修」信号，重连修好后清掉，但要在记录里写明是哪个动作清的。
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half' } },
      } },
      { jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code: null, signal: 'SIGKILL' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4407',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const reattach = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, reattach.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: reattach.sessionId, clientId: 'browser', requestId: 'dies-mid-turn-2', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: reattach.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === reattach.sessionId)?.turnState)
        .toBe('failed')
      // 重连成功（同一个代际、hold 还在）：失败标记清掉，并写明是「重新连接」清的。
      await gateway.dispatch(request('session.attach', { sessionId: reattach.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === reattach.sessionId)?.turnState)
        .toBe('idle')
      const page = await readTranscript(gateway, reattach.sessionId)
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '重新连接会话，上一轮的失败标记已清除。'))
        .toBe(true)

      // 显式「结束进程并在当前会话重开」也是修复动作，同样写明是它清的。
      const restarted = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, restarted.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: restarted.sessionId, clientId: 'browser', requestId: 'dies-then-restart', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: restarted.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === restarted.sessionId)?.turnState)
        .toBe('failed')
      await gateway.dispatch(request('session.restart', { sessionId: restarted.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === restarted.sessionId)?.turnState)
        .toBe('idle')
      const restartedPage = await readTranscript(gateway, restarted.sessionId)
      expect(restartedPage.entries.some(entry => entry.kind === 'status' && entry.text === '结束进程并在当前会话重开，上一轮的失败标记已清除。'))
        .toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a reconnect does not rewrite a user-stopped round', async () => {
    // 「用户主动停止」是上一轮的结局，不是待修信号：重连不该改写它（下一次
    // 发消息才进入下一轮）。
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half' } },
      } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4410',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'dsh',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'stop-then-attach', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      await gateway.dispatch(request('session.cancel', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('stopped')
      await gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('stopped')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a parked turn whose channel died, instead of leaving it waiting for an answer', async () => {
    // 「等待你的确认」是本轮在途的一种：通道死了它也是死了，卡片没有可答的对象。
    // 原来只有 running 判失败，waiting-permission 会被留在原地挂着。
    const events: JsonValue[] = [
      {
        jsonrpc: '2.0', id: 9, method: 'session/request_permission',
        params: { title: 'Allow shell?', options: [{ optionId: 'once', name: 'Allow once' }] },
      },
    ]
    const { ctx, gateway, failMethod } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4408',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'parked-dies', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.turnState)
        .toBe('waiting-permission')
      // hostd 应答了「没有这个会话」，重建也失败：通道确认死亡。
      failMethod('session.attach', 'Error: unknown hostd session gone-2')
      failMethod('session.start', 'Error: backend will not start')
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))).rejects.toThrow()
      const view = gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)
      expect(view?.turnState).toBe('failed')
      expect(view?.pendingRequestIds ?? []).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not let late subagent frames reopen a settled child session', async () => {
    // 09-18 的漏网：父会话有「已收拢不复开」保护，子会话没有。父轮次已经结束
    // 之后到达的子 agent 输出，会把子会话永久翻回「进行中」。
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: {
        sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'Task',
        rawInput: { description: 'Test the fix' },
        _meta: { claudeCode: { toolName: 'Agent', toolCallId: 'task-1', subagent: true } },
      } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: {
        sessionUpdate: 'tool_call', toolCallId: 'sub-1', title: 'git diff',
        _meta: { claudeCode: { toolName: 'Bash', toolCallId: 'sub-1', parentToolUseId: 'task-1' } },
      } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4409',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'child-late', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const child = gateway.state().sessions.find(entry => entry.parentSessionId === session.sessionId)
      expect(child?.turnState).toBe('idle')
      // 父轮次结束后才到的子 agent 输出：内容照常进子会话，但不把子会话翻回进行中。
      events.push({ jsonrpc: '2.0', method: 'session/update', params: { update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'sub-1', status: 'completed',
        _meta: { claudeCode: { toolName: 'Bash', toolCallId: 'sub-1', parentToolUseId: 'task-1' } },
      } } })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === child?.sessionId)?.turnState)
        .toBe('idle')
      expect((await readTranscript(gateway, child!.sessionId)).entries).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not paint a session red when the host was only slow, and lets a stale red clear itself', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4402' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      // A host that is merely slow says nothing about the session: the record
      // is intact and the next call works. Resuming a large session over a
      // tunnel blows a 45s budget easily, and that must not read as "disconnected".
      failMethod('session.attach', 'Error: hostd request session.attach timed out')
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))).rejects.toThrow()
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState)
        .not.toBe('lost')

      // The slow moment is not a verdict: the next good call clears it, instead
      // of the session wearing the failure until someone reopens it by hand.
      await gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('open')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still marks a session lost when the host says it has no such record', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4402' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      // This one is real: hostd answered and reported the record missing, and
      // the recreate failed too. That is the case the red badge is for.
      failMethod('session.attach', 'Error: unknown hostd session gone-1')
      failMethod('session.start', 'Error: backend will not start')
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))).rejects.toThrow()
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('lost')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not clear a lost session from journal content — the repair call does that', async () => {
    // 回归守卫（钉住口径）：日志是 hostd 盘上的记录，Agent 通道死了照样读得到内容，
    // 所以「内容到了」不能证明通道活了。红条（含黄条）只认真正碰到通道的调用
    // （重连/重开/发消息成功）才清。红条期间内容也进不来：读取直接被拒。
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4411',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      // hostd 应答说 hold 进程的套接字没了：会话需要重开，记红。
      failMethod('session.attach', 'Error: connect ECONNREFUSED /tmp/threadharbor-hostd-501/h-dead.sock')
      await gateway.dispatch(request('session.attach', { sessionId: session.sessionId })).catch(() => undefined)
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState)
        .toBe('lost')

      // 红条期间内容进不来 —— 也不因任何内容而消。
      await expect(gateway.dispatch(request('events.read', { sessionId: session.sessionId })))
        .rejects.toThrow('no active remote binding')
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState)
        .toBe('lost')

      // 修复调用才清红。
      await gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState)
        .toBe('open')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('marks a message that never reached the host as a reconnecting channel, not a lost session', async () => {
    // 「连不上」和「记录没了」是两回事：前者自己会好，后者要重开。原来发不出去
    // 的消息一律把会话记成「丢失」，红条就是这么来的。
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4412',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      failMethod('session.prompt', 'connect ECONNREFUSED 127.0.0.1:4412')
      failMethod('session.attach', 'connect ECONNREFUSED 127.0.0.1:4412')
      await expect(gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'no-route', text: 'hi',
      }))).rejects.toThrow()
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState)
        .toBe('reconnecting')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a replaced generation as superseded, not lost', async () => {
    // 会话被新实例顶替时，旧绑定是「被取代」（superseded）：旧实例作废，不是
    // 会话丢了。原来一律记「丢失」，语义上是错的。
    const { ctx, gateway, setNextAttach } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4413',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      setNextAttach({ generation: 'g2' })
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId })))
        .rejects.toThrow('generation changed')
      const view = gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)
      expect(view?.binding?.state).toBe('superseded')
      expect(view?.channelState).toBe('lost')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('says in the record whether the Agent died or the host merely went unreachable', async () => {
    // 两种中断分开说：进程死了说进程死了，够不着说够不着。原来两种都写成
    // 「远程 Agent 进程已停止」，查问题时分不清是哪一环。
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'host', endpoint: 'http://127.0.0.1:4414',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }

      const unreachable = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, unreachable.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: unreachable.sessionId, clientId: 'browser', requestId: 'unreachable-turn', text: 'hi',
      }))
      failMethod('events.read', 'connect ECONNREFUSED 127.0.0.1:4414')
      await gateway.dispatch(request('events.read', { sessionId: unreachable.sessionId })).catch(() => undefined)
      await vi.waitFor(async () => {
        const page = await readTranscript(gateway, unreachable.sessionId)
        expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '远程主机暂时联系不上，本轮已中断'))
          .toBe(true)
      }, { timeout: 2000, interval: 10 })

      const agentGone = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, agentGone.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: agentGone.sessionId, clientId: 'browser', requestId: 'agent-gone-turn', text: 'hi',
      }))
      failMethod('events.read', 'Error: process is not running')
      await gateway.dispatch(request('events.read', { sessionId: agentGone.sessionId })).catch(() => undefined)
      await vi.waitFor(async () => {
        const page = await readTranscript(gateway, agentGone.sessionId)
        expect(page.entries.some(entry => entry.kind === 'status' && entry.text === '远程 Agent 进程已停止'))
          .toBe(true)
      }, { timeout: 2000, interval: 10 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rebuilds a reopen it cannot resume by handing hostd the conversation, and says which it got', async () => {
    // Real turns, as the gateway would have projected them: the user's question
    // and the answer. Both sides matter — an answer with no question behind it
    // tells a fresh model nothing.
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '聊天区已经改完了' } } } },
      { jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } },
    ]
    const { ctx, gateway, failMethod, calls } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4402' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      // The user side of a turn enters the transcript through the prompt, not
      // through an Agent frame — the Agent never echoes the question back.
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'r-1', text: '先把聊天区改完',
      }))
      // The answer arrives through the background follow loop; with scoped
      // dispatch chains that projection can land a few ticks after the prompt
      // RPC resolves, so wait for it instead of assuming the ordering.
      await vi.waitFor(async () => {
        const settled = await gateway.dispatch(request('transcript.read', { sessionId: session.sessionId })) as unknown as { entries: Array<{ role: string; text: string }> }
        expect(settled.entries.map(row => row.text).join('|')).toContain('聊天区已经改完了')
      }, { timeout: 2000, interval: 10 })
      // The Agent cannot reopen its own session.
      failMethod('session.attach', 'Error: agent codex could not reopen session native-old: gone')

      await gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))
      // The first attach could not resume; the retry must carry the conversation
      // both ways round, not just the agent's half.
      const attachCalls = calls.filter(call => call.request.method === 'session.attach')
      expect(attachCalls.length).toBe(2)
      expect(attachCalls[0]?.request.params['context']).toBeUndefined()
      const context = attachCalls[1]?.request.params['context'] as Record<string, JsonValue> | undefined
      expect(typeof context?.['transcript']).toBe('string')
      const transcript = String(context?.['transcript'])
      expect(transcript).toContain('聊天区已经改完了')
      expect(transcript).toContain('先把聊天区改完')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reattaches a reconnecting session when the browser follows it again', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4402' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.attach', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('open')
      const attached = calls.filter(call => call.request.method === 'session.attach')
      expect(attached.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('revives a dead hold and retries prompt delivery in place', async () => {
    const { ctx, gateway, failMethod, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4415' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      failMethod('session.prompt', 'Error: connect ENOENT /tmp/th-501/h-dead.sock')
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'revive-1', text: 'hello',
      }))
      expect(calls.filter(call => call.request.method === 'session.prompt')).toHaveLength(2)
      expect(calls.some(call => call.request.method === 'session.attach')).toBe(true)
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)).toMatchObject({
        channelState: 'open', turnState: 'running',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('marks a session lost with a reopen instruction when prompt cannot revive the hold', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4416' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      failMethod('session.prompt', 'Error: connect ENOENT /tmp/th-501/h-dead.sock')
      failMethod('session.attach', 'Error: connect ENOENT /tmp/th-501/h-dead.sock')
      await expect(gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'dead-1', text: 'hello',
      }))).rejects.toThrow('在当前会话重开')
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)).toMatchObject({
        channelState: 'lost', turnState: 'failed',
      })
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.text.includes('消息提交失败') && entry.text.includes('在当前会话重开'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears a stale failed turn when a later reopen attach succeeds', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4419' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      // Force the outage markers: prompt delivery fails and the inline attach
      // fallback cannot revive the (mock) hold either.
      failMethod('session.prompt', 'Error: connect ENOENT /tmp/th-501/h-dead.sock')
      failMethod('session.attach', 'Error: connect ENOENT /tmp/th-501/h-dead.sock')
      await expect(gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'stale-1', text: 'hello',
      }))).rejects.toThrow()
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)).toMatchObject({
        channelState: 'lost', turnState: 'failed',
      })
      // The next explicit reopen attach succeeds (mock error is one-shot):
      // the stale failed turn must not resurrect the reopen banner.
      const attached = await gateway.dispatch(request('session.attach', { sessionId: session.sessionId })) as unknown as {
        channelState: string
        turnState: string
      }
      expect(attached).toMatchObject({ channelState: 'open', turnState: 'idle' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('force-restarts a wedged session on session.restart and resets the running turn', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4420' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const restarted = await gateway.dispatch(request('session.restart', { sessionId: session.sessionId })) as unknown as {
        channelState: string
        turnState: string
      }
      expect(restarted).toMatchObject({ channelState: 'open', turnState: 'idle' })
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.text.includes('没有响应') && entry.text.includes('结束其进程'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not reopen a reconnecting channel when a later journal page is projected', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'stale' } } } },
    ]
    const { ctx, gateway, failMethod } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4417' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'stale-page', text: 'hello',
      }))
      failMethod('events.read', 'Error: connect ENOENT /tmp/th-501/h-dead.sock')
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId })).catch(() => undefined)
      await vi.waitFor(() => {
        expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState)
          .toBe('reconnecting')
      })
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('reconnecting')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('translates a dead hold socket into an in-place reopen instruction and marks the session lost', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4403' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      failMethod('session.attach', 'Error: connect ECONNREFUSED /tmp/threadharbor-hostd-501/h-dead.sock')
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId })))
        .rejects.toThrow('在当前会话重开')
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('lost')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes an actionable grok serve fix hint verbatim when attach fails on a hostd conflict', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4418' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const conflict = '[th-fix:grok-serve] 127.0.0.1:2419 上已有一个由旧 hostd 启动的 Grok 服务，密钥不一致。可点「接管现有服务」或「重启服务」。'
      failMethod('session.attach', `Error: ${conflict}`)
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId })))
        .rejects.toThrow('[th-fix:grok-serve]')
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('lost')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the same session and records a reopen marker when hostd recreates the native agent', async () => {
    const { ctx, gateway, setNextAttach } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4404' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      setNextAttach({ reopened: true, latestSeq: 9, nativeSessionId: 'native-reopened' })
      const attached = await gateway.dispatch(request('session.attach', { sessionId: session.sessionId })) as unknown as {
        sessionId: string
        channelState: string
        binding?: { nativeSessionId?: string; lastSeq: number }
      }
      expect(attached.sessionId).toBe(session.sessionId)
      expect(attached.channelState).toBe('open')
      expect(attached.binding?.nativeSessionId).toBe('native-reopened')
      expect(attached.binding?.lastSeq).toBe(9)
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.text.includes('已在当前会话上重新打开'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recreates the hold under the same session id when hostd no longer knows it and the browser reopens', async () => {
    const { ctx, gateway, failMethod, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4430' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const startsBefore = calls.filter(call => call.request.method === 'session.start').length
      // hostd lost its data directory: the session id is unknown to it now.
      failMethod('session.attach', `Error: unknown hostd session ${session.sessionId}`)
      const attached = await gateway.dispatch(request('session.attach', { sessionId: session.sessionId })) as unknown as {
        sessionId: string
        channelState: string
        turnState: string
      }
      expect(attached).toMatchObject({ sessionId: session.sessionId, channelState: 'open', turnState: 'idle' })
      const starts = calls.filter(call => call.request.method === 'session.start')
      expect(starts).toHaveLength(startsBefore + 1)
      expect(starts.at(-1)?.request.params).toMatchObject({ sessionId: session.sessionId, backend: 'codex', cwd: '/repo' })
      const page = await readTranscript(gateway, session.sessionId)
      expect(page.entries.some(entry => entry.text.includes('重新创建 Agent 进程'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recreates a hold hostd forgot and still delivers the prompt in place', async () => {
    const { ctx, gateway, failMethod, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4431' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      failMethod('session.prompt', `Error: unknown hostd session ${session.sessionId}`)
      failMethod('session.attach', `Error: unknown hostd session ${session.sessionId}`)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'forgot-1', text: 'hello',
      }))
      expect(calls.filter(call => call.request.method === 'session.prompt')).toHaveLength(2)
      expect(calls.filter(call => call.request.method === 'session.start')).toHaveLength(2)
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)).toMatchObject({
        channelState: 'open', turnState: 'running',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('explains a missing hostd record with a reopen hint when recreation itself fails', async () => {
    const { ctx, gateway, failMethod } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4432' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      failMethod('session.attach', `Error: unknown hostd session ${session.sessionId}`)
      failMethod('session.start', 'Error: ENOENT: no such file or directory, realpath \'/repo\'')
      await expect(gateway.dispatch(request('session.attach', { sessionId: session.sessionId })))
        .rejects.toThrow('realpath')
      expect(gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)?.channelState).toBe('lost')
      // Without recreation (background follow attach) the raw hostd error is
      // rewritten into the actionable reopen hint.
      failMethod('session.restart', `Error: unknown hostd session ${session.sessionId}`)
      failMethod('session.start', `Error: unknown hostd session ${session.sessionId}`)
      await expect(gateway.dispatch(request('session.restart', { sessionId: session.sessionId })))
        .rejects.toThrow('远程主机上已没有该会话的记录')
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

  it('replays the projected transcript tail when a browser follows after live pushes were dropped', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late answer' } } } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4411' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'replay-1', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const browser = makeBrowserSocket()
      gateway.registerBrowserForTesting(browser as unknown as WebSocket, 'alice')
      await gateway.dispatch(request('session.follow', { browserId: 'alice', sessionId: session.sessionId }))
      const frames = browser.sent.map(payload => JSON.parse(payload) as {
        event?: { type?: string; entries?: Array<{ text: string }>; entry?: { text: string } }
      })
      const texts = frames.flatMap(frame => {
        if (frame.event?.type === 'transcript.batch') return (frame.event.entries ?? []).map(entry => entry.text)
        if (frame.event?.type === 'transcript.append') return frame.event.entry?.text === undefined ? [] : [frame.event.entry.text]
        return []
      })
      expect(texts).toContain('hello')
      expect(texts).toContain('late answer')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hello reports missed transcript seqs and replays the tail to that browser', async () => {
    const events: JsonValue[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'missed' } } } },
    ]
    const { ctx, gateway } = await harness(events)
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4412' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      await gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'hello-miss', text: 'hello',
      }))
      await gateway.dispatch(request('events.read', { sessionId: session.sessionId }))
      const browser = makeBrowserSocket()
      gateway.registerBrowserForTesting(browser as unknown as WebSocket, 'alice')
      const hello = await gateway.dispatch(request('browser.hello', {
        browserId: 'alice', lastSeenSeqs: { [session.sessionId]: 0 },
      })) as unknown as { missed: Array<{ sessionId: string; fromSeq: number }> }
      expect(hello.missed).toEqual([{ sessionId: session.sessionId, fromSeq: 0 }])
      const frames = browser.sent.map(payload => JSON.parse(payload) as {
        event?: { type?: string; entries?: Array<{ text: string }>; toSeq?: number }
      })
      const batch = frames.find(frame => frame.event?.type === 'transcript.batch')
      expect(batch?.event?.entries?.some(entry => entry.text === 'missed')).toBe(true)
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

  it('keeps a hidden project\'s sessions archived even when the project is unhidden right away', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'dev-box', endpoint: 'http://127.0.0.1:4186' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      })) as unknown as { sessionId: string }

      await gateway.dispatch(request('project.hide', { projectId: project.projectId }))
      await gateway.dispatch(request('project.unhide', { projectId: project.projectId }))

      // The hide response returns as soon as the row is marked hidden, but the
      // session-archive sweep is queued on the shared mutation tail *before*
      // the unhide, so unhiding must not resurrect the sessions.
      expect(gateway.state().projects.map(entry => entry.projectId)).toEqual([project.projectId])
      expect(gateway.state().sessions).toEqual([])
      const hidden = await gateway.dispatch(request('hidden.list', {})) as unknown as {
        sessions: Array<{ sessionId: string; archivedAt?: string }>
      }
      expect(hidden.sessions.map(entry => entry.sessionId)).toEqual([session.sessionId])
      expect(hidden.sessions[0]?.archivedAt).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-registering a hidden directory restores the project instead of returning it hidden', async () => {
    const { ctx, gateway } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'mac-good', endpoint: 'http://127.0.0.1:4187' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'nexa-service', cwd: '/repo',
      })) as unknown as { projectId: string }
      await gateway.dispatch(request('project.hide', { projectId: project.projectId }))
      expect(gateway.state().projects).toEqual([])

      const again = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'nexa-service-2', cwd: '/repo',
      })) as unknown as { projectId: string; title: string; hiddenAt?: string }

      // Same directory on the same host must reuse the catalogue row, but it has
      // to come back visible and carry the freshly requested title.
      expect(again.projectId).toBe(project.projectId)
      expect(again.hiddenAt).toBeUndefined()
      expect(again.title).toBe('nexa-service-2')
      expect(gateway.state().projects.map(entry => entry.projectId)).toEqual([project.projectId])
      const hidden = await gateway.dispatch(request('hidden.list', {})) as unknown as { projects: Array<{ projectId: string }> }
      expect(hidden.projects).toEqual([])
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

  it('moves the pooled hostd connection to the new endpoint after a host endpoint change', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'loop', endpoint: 'http://127.0.0.1:4401',
      })) as unknown as { hostId: string }
      await vi.waitFor(() => {
        const inventory = gateway.state().hosts.find(candidate => candidate.hostId === host.hostId)?.inventory
        if (inventory?.healthy !== true) throw new Error('inventory not healthy')
      }, { timeout: 2000, interval: 10 })
      expect(calls.some(call => call.port === '4401' && call.request.method === 'inventory')).toBe(true)

      await gateway.dispatch(request('host.update', {
        hostId: host.hostId, title: 'loop', endpoint: 'http://127.0.0.1:4402',
      }))
      // updateHost refreshes through the same pooled connection, which must
      // have moved to the new endpoint instead of reconnecting to the dead one.
      expect(calls.some(call => call.port === '4402' && call.request.method === 'inventory')).toBe(true)
      await gateway.dispatch(request('inventory', { hostId: host.hostId }))
      const inventoryCalls = calls.filter(call => call.request.method === 'inventory')
      const ports = inventoryCalls.map(call => call.port)
      const firstOnNewPort = ports.indexOf('4402')
      const lastOnOldPort = ports.lastIndexOf('4401')
      expect(firstOnNewPort).toBeGreaterThan(-1)
      // Once the endpoint moved, no inventory may ever travel to the old port again.
      expect(lastOnOldPort).toBeLessThan(firstOnNewPort)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a session create fast and honestly when the host is already known unreachable', async () => {
    // The recorded 45-second "creating a session is slow" outage: hostd down,
    // every create sat out the whole request budget before a generic timeout.
    // The create must instead fail at the inventory gate, in about the connect
    // deadline, with the reason the refresh already recorded.
    const { ctx, gateway, killPort } = await harness([], {
      hostdRequestTimeoutMs: 5000, hostdConnectDeadlineMs: 50,
    })
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'mac-good', endpoint: 'http://127.0.0.1:4421',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      killPort('4421')
      // One refresh records the unreachable state the create should reuse.
      await gateway.dispatch(request('inventory', { hostId: host.hostId }))

      const startedAt = Date.now()
      await expect(gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
      }))).rejects.toThrow(/主机 mac-good 当前不可达：无法连接到 hostd/)
      // The connect deadline (50ms per refresh attempt) must dominate, not the
      // 5s request budget — two sequential failing refreshes stay well under a
      // tenth of it.
      expect(Date.now() - startedAt).toBeLessThan(1000)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('marks the host offline and records an honest failure when a create hits an unreachable hostd', async () => {
    const { ctx, gateway, killPort } = await harness([], {
      hostdRequestTimeoutMs: 5000, hostdConnectDeadlineMs: 50,
    })
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'mac-good', endpoint: 'http://127.0.0.1:4422',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      const browser = makeBrowserSocket()
      gateway.registerBrowserForTesting(browser as unknown as WebSocket, 'watcher')

      killPort('4422')
      // Create carries a first message, so the RPC returns while the hold
      // startup runs detached; its failure has to reach the row, the
      // transcript and the host badge without any manual refresh.
      const startedAt = Date.now()
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'work', backend: 'codex',
        text: 'hi', clientId: 'browser', requestId: 'r-dead-host',
      })) as unknown as { sessionId: string }
      const view = await vi.waitFor(() => {
        const row = gateway.state().sessions.find(entry => entry.sessionId === session.sessionId)
        if (row?.turnState !== 'failed') throw new Error(`turn state ${row?.turnState ?? 'missing'}`)
        return row
      }, { timeout: 3000, interval: 10 })
      // The host never answered: a link failure, self-healing on the next
      // successful call — not a `lost` create that asks for a reopen.
      expect(view.channelState).toBe('reconnecting')
      expect(Date.now() - startedAt).toBeLessThan(2000)

      const transcript = await readTranscript(gateway, session.sessionId)
      expect(transcript.entries.some(entry =>
        entry.role === 'system' && entry.text.includes('会话创建失败：无法连接到主机上的 hostd'))).toBe(true)

      // The sidebar's stale healthy badge is the other half of the outage: the
      // host row must flip to offline on its own, and say so over the push
      // channel so an open browser updates without a reload.
      await vi.waitFor(() => {
        const row = gateway.state().hosts.find(entry => entry.hostId === host.hostId)
        if (row?.inventoryError === undefined) throw new Error('host not marked offline')
      }, { timeout: 2000, interval: 10 })
      expect(browser.sent.join('\n')).toContain('"host.changed"')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the offline badge and creates sessions once hostd answers again', async () => {
    const { ctx, gateway, killPort, revivePort } = await harness([], {
      hostdRequestTimeoutMs: 5000, hostdConnectDeadlineMs: 50,
    })
    try {
      const host = await gateway.dispatch(request('host.add', {
        title: 'mac-good', endpoint: 'http://127.0.0.1:4423',
      })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', {
        hostId: host.hostId, title: 'repo', cwd: '/repo',
      })) as unknown as { projectId: string }
      killPort('4423')
      await gateway.dispatch(request('inventory', { hostId: host.hostId }))
      expect(gateway.state().hosts.find(entry => entry.hostId === host.hostId)?.inventoryError).toContain('无法连接到 hostd')

      revivePort('4423')
      // Let any in-flight dead socket error out so the next request opens a
      // live one instead of waiting on the reconnect ladder.
      await new Promise(resolve => setTimeout(resolve, 20))
      const session = await gateway.dispatch(request('session.start', {
        projectId: project.projectId, title: 'recovered', backend: 'codex',
      })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)
      const healed = gateway.state().hosts.find(entry => entry.hostId === host.hostId)
      expect(healed?.inventoryError).toBeUndefined()
      expect(healed?.inventory?.healthy).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs background operation work without waiting behind a slow browser RPC', async () => {
    const { ctx, gateway, silenceMethod } = await harness()
    try {
      const blocked = await gateway.dispatch(request('host.add', {
        title: 'blocked', endpoint: 'http://127.0.0.1:4403',
      })) as unknown as { hostId: string }
      const runner = await gateway.dispatch(request('host.add', {
        title: 'runner', endpoint: 'http://127.0.0.1:4404',
      })) as unknown as { hostId: string }
      await vi.waitFor(() => {
        const hosts = gateway.state().hosts
        if (hosts.find(candidate => candidate.hostId === blocked.hostId)?.inventory?.healthy !== true
          || hosts.find(candidate => candidate.hostId === runner.hostId)?.inventory?.healthy !== true) {
          throw new Error('inventory not healthy')
        }
      }, { timeout: 2000, interval: 10 })

      // Occupy the RPC mutation tail with an inventory RPC whose hostd never answers.
      silenceMethod('inventory', '4403')
      const slowRefresh = gateway.dispatch(request('inventory', { hostId: blocked.hostId }))
      const started = await gateway.dispatch(request('operation.start', {
        kind: 'agent-install', hostId: runner.hostId, backend: 'dsh', confirm: true,
      })) as unknown as { operationId: string }
      // The operation has its own work tail: it starts while slowRefresh is
      // still pending on the RPC tail (hostdRequestTimeoutMs is 1000ms here).
      await vi.waitFor(() => {
        const operation = gateway.state().operations.find(candidate => candidate.operationId === started.operationId)
        if (operation?.status !== 'running' && operation?.status !== 'succeeded') {
          throw new Error(`operation status ${operation?.status ?? 'missing'}`)
        }
      }, { timeout: 500, interval: 10 })
      // ... and still completes to success instead of being stranded behind the RPC.
      await vi.waitFor(() => {
        const operation = gateway.state().operations.find(candidate => candidate.operationId === started.operationId)
        if (operation?.status !== 'succeeded') throw new Error(`operation status ${operation?.status ?? 'missing'}`)
      }, { timeout: 3000, interval: 10 })
      // Let the parked RPC resolve (it times out and records inventoryError).
      const refreshed = await slowRefresh as unknown as { inventoryError?: string }
      expect(refreshed.inventoryError).toContain('hostd')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('tells hostd to release the hold when a session is deleted', async () => {
    const { ctx, gateway, calls } = await harness()
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:4412' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      await gateway.dispatch(request('session.delete', { sessionId: session.sessionId }))

      // The detached hold must actually be torn down: dropping only the local
      // row is the leak this covers.
      const releases = calls.filter(call => call.request.method === 'session.release')
      expect(releases.map(call => call.request.params['sessionId'])).toContain(session.sessionId)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never queues a prompt behind a stuck request on another host', async () => {
    // Regression shape of the real outage: one host's tunnel goes silent and a
    // request on it sits until its timeout; every RPC on the other host must
    // still go through immediately.
    const { ctx, gateway, silenceMethod } = await harness([], { hostdRequestTimeoutMs: 6000 })
    try {
      const stuck = await gateway.dispatch(request('host.add', { title: 'stuck', endpoint: 'http://127.0.0.1:5501' })) as unknown as { hostId: string }
      const healthy = await gateway.dispatch(request('host.add', { title: 'healthy', endpoint: 'http://127.0.0.1:5502' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: healthy.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const session = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'work', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, session.sessionId)

      silenceMethod('inventory', '5501')
      const parkedInventory = gateway.dispatch(request('inventory', { hostId: stuck.hostId })).catch(() => undefined)
      const prompt = gateway.dispatch(request('session.prompt', {
        sessionId: session.sessionId, clientId: 'browser', requestId: 'isolation-1', text: 'hi',
      }))
      const deadline = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('prompt queued behind the stuck host request')), 3000)
      })
      await Promise.race([prompt, deadline])
      await prompt
      // The parked request settles on its own timeout after the test; the
      // .catch above keeps that rejection handled.
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never queues one session behind a stuck request of another session on the same host', async () => {
    const { ctx, gateway, silenceMethod } = await harness([], { hostdRequestTimeoutMs: 6000 })
    try {
      const host = await gateway.dispatch(request('host.add', { title: 'host', endpoint: 'http://127.0.0.1:5503' })) as unknown as { hostId: string }
      const project = await gateway.dispatch(request('project.create', { hostId: host.hostId, title: 'repo', cwd: '/repo' })) as unknown as { projectId: string }
      const first = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'one', backend: 'codex' })) as unknown as { sessionId: string }
      const second = await gateway.dispatch(request('session.start', { projectId: project.projectId, title: 'two', backend: 'codex' })) as unknown as { sessionId: string }
      await waitForSessionBinding(gateway, first.sessionId)
      await waitForSessionBinding(gateway, second.sessionId)

      silenceMethod('session.attach', '5503')
      const parkedAttach = gateway.dispatch(request('session.attach', { sessionId: first.sessionId })).catch(() => undefined)
      const prompt = gateway.dispatch(request('session.prompt', {
        sessionId: second.sessionId, clientId: 'browser', requestId: 'isolation-2', text: 'hi',
      }))
      const deadline = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('prompt queued behind the stuck attach of another session')), 3000)
      })
      await Promise.race([prompt, deadline])
      await prompt
      // The parked attach settles on its own timeout after the test; the
      // .catch above keeps that rejection handled.
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
