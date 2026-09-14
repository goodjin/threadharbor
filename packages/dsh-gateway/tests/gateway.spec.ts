import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { hostdArtifactVersionFromDirectory } from '@threadharbor/hostd/version'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
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

function respondToRequest(request: RemoteControlRequest, port: string, events: JsonValue[]): JsonValue {
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
  const methodErrors = new Map<string, string>()
  /** Method@port pairs whose next hostd request is consumed but never answered. */
  const silenced = new Set<string>()
  let nextAttach: Record<string, JsonValue> | undefined
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
          ? { ...respondToRequest(request, port, events) as Record<string, JsonValue>, ...nextAttach }
          : respondToRequest(request, port, events)
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

  const transcriptDir = mkdtempSync(join(tmpdir(), 'th-transcript-'))
  transcriptDirs.push(transcriptDir)
  await ctx.plugin(RemoteAgentGateway, { ...CONFIG, transcriptDir, ...configOverride }).await()
  ctx.remoteAgentGateway.setHostdSocketFactory(socketFactory as unknown as (url: string) => import('ws').WebSocket)
  return {
    ctx, gateway: ctx.remoteAgentGateway, calls, storageDomain, transcriptDir,
    failNext: () => { failing = true },
    failMethod: (method: string, message: string) => { methodErrors.set(method, message) },
    silenceMethod: (method: string, port: string) => { silenced.add(`${method}@${port}`) },
    setNextAttach: (value: Record<string, JsonValue>) => { nextAttach = value },
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
        sessionId, projectId, title: 's', backend: 'codex', channelState: 'closed', turnState: 'idle', createdAt: now, updatedAt: now,
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
      expect(page.entries.some(entry => entry.kind === 'status' && entry.text.includes('已停止'))).toBe(true)
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
})
