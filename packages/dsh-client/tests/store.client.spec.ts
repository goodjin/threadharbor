import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteHostId, RemoteProjectId, RemoteSessionId } from '@threadharbor/protocol'
import { RemoteAgentStore, backendInventoryState, describeHostConnectFailure, hostConnectionLabel, hostDeployment, parseAgentConfigDocument, parseHiddenItems, parseOperation, parseRemoteAgentState } from '../src/client/store.ts'

const EMPTY = { pollIntervalMs: 60_000, hosts: [], projects: [], sessions: [], transcript: [], operations: [] }

beforeEach(() => {
  const session = new Map<string, string>()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => { session.set(key, value) },
    },
  })
})

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a string request body')
  return init.body
}

afterEach(() => { vi.unstubAllGlobals() })

describe('RemoteAgentStore', () => {
  it('renders a running authenticated backend as ready instead of ongoing', () => {
    const host = parseRemoteAgentState({
      ...EMPTY,
      hosts: [{
        hostId: 'h', title: 'host', endpoint: 'http://127.0.0.1:1', createdAt: 'a', updatedAt: 'b',
        inventory: {
          protocolVersion: 1, hostdVersion: '0.1.0', hostId: 'native-h', healthy: true,
          backends: [
            { backend: 'grok', installed: true, authenticated: true, running: true, sessionCapable: true },
            { backend: 'claude', installed: true, authenticated: false, running: false, sessionCapable: true },
          ],
        },
      }],
    }).hosts[0]
    expect(host).toBeDefined()
    expect(backendInventoryState(host!, 'grok')).toBe('done')
    expect(backendInventoryState(host!, 'claude')).toBe('done')
    expect(backendInventoryState(host!, 'codex')).toBe('warning')
  })

  it('validates the full independent catalog projection', () => {
    expect(parseRemoteAgentState({
      pollIntervalMs: 1000,
      hosts: [{ hostId: 'h', title: 'host', endpoint: 'http://127.0.0.1:1', createdAt: 'a', updatedAt: 'b' }],
      projects: [{ projectId: 'p', hostId: 'h', title: 'repo', cwd: '/repo', createdAt: 'a', updatedAt: 'b' }],
      sessions: [{
        sessionId: 's', projectId: 'p', title: 'work', backend: 'codex', channelState: 'open', turnState: 'idle',
        createdAt: 'a', updatedAt: 'b', binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
      }],
      transcript: [{ transcriptId: 't', sessionId: 's', seq: 0, role: 'assistant', kind: 'message', text: 'hi', createdAt: 'a' }],
    })).toMatchObject({ sessions: [{ sessionId: 's', backend: 'codex' }], transcript: [{ text: 'hi' }] })
    expect(() => parseRemoteAgentState({ ...EMPTY, sessions: [{ backend: 'other' }] })).toThrow()
  })

  it('validates safe management operation states', () => {
    expect(parseOperation({
      operationId: 'op', kind: 'host-ssh-deploy', status: 'running', phase: 'uploading-hostd',
      title: '部署 hostd', detail: '正在上传 hostd。', target: 'host/h', cancellable: false, hostId: 'h',
      startedAt: 'a', updatedAt: 'b',
    })).toMatchObject({ operationId: 'op', status: 'running', hostId: 'h' })
    expect(() => parseOperation({
      operationId: 'op', kind: 'host-ssh-deploy', status: 'running', phase: 'shell-output',
      title: '部署', detail: 'raw', target: 'host/h', cancellable: false, startedAt: 'a', updatedAt: 'b',
    })).toThrow('operation.phase')
  })

  it('validates fixed-path Agent configuration documents', () => {
    expect(parseAgentConfigDocument({
      backend: 'grok', path: '/home/user/.grok/config.toml', format: 'toml', exists: true,
      content: '[models]\n', revision: 'revision', maxBytes: 4096,
    })).toMatchObject({ backend: 'grok', format: 'toml', content: '[models]\n' })
    expect(() => parseAgentConfigDocument({
      backend: 'dsh', path: '/tmp/config', format: 'toml', exists: false,
      content: '', revision: 'revision', maxBytes: 4096,
    })).toThrow('config backend')
  })

  it('attaches and reads native journal state when a session is selected', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      calls.push(body.method)
      const state = {
        ...EMPTY,
        sessions: [{
          sessionId: 's', projectId: 'p', title: 'work', backend: 'codex', channelState: 'open', turnState: 'idle',
          createdAt: 'a', updatedAt: 'b', binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
        }],
      }
      return Response.json({ id: body.id, ok: true, result: body.method === 'session.attach' ? state.sessions[0] : state })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.selectSession(RemoteSessionId('s'))
      expect(calls).toEqual(['state'])
      expect(store.getSnapshot()).toMatchObject({ phase: 'ready', currentSessionId: 's', pending: false })
      expect(store.getSnapshot().attachingSessionId).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('selects an existing session immediately without a blocking attach round-trip', async () => {
    const state = {
      ...EMPTY,
      sessions: [{
        sessionId: 's', projectId: 'p', title: 'work', backend: 'codex', channelState: 'open', turnState: 'idle',
        createdAt: 'a', updatedAt: 'b', binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      return Response.json({ id: body.id, ok: true, result: state })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.selectSession(RemoteSessionId('s'))
      expect(store.getSnapshot().currentSessionId).toBe('s')
      expect(store.getSnapshot().attachingSessionId).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('keeps operation panels browser-local and closes them when opening a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      const state = {
        ...EMPTY,
        sessions: [{
          sessionId: 's', projectId: 'p', title: 'work', backend: 'codex', channelState: 'open', turnState: 'idle',
          createdAt: 'a', updatedAt: 'b', binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
        }],
      }
      return Response.json({ id: body.id, ok: true, result: body.method === 'session.attach' ? state.sessions[0] : state })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      store.showPanel({ kind: 'add-host' })
      expect(store.getSnapshot()).toMatchObject({ panel: { kind: 'add-host' } })
      await store.selectSession(RemoteSessionId('s'))
      expect(store.getSnapshot().panel).toBeUndefined()
      expect(store.getSnapshot().currentSessionId).toBe('s')
    } finally {
      store.dispose()
    }
  })

  it('sends host settings through the update method for endpoint and SSH connections', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      const result = body.method === 'state' ? EMPTY : body.method === 'operation.start' ? {
        operationId: 'op-ssh', kind: 'host-ssh-deploy', status: 'queued', phase: 'queued',
        title: '重新部署 开发机', detail: '部署任务已排队。', target: 'host:h', cancellable: false, hostId: 'h',
        startedAt: 'a', updatedAt: 'a',
      } : {}
      return Response.json({ id: body.id, ok: true, result })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.updateHost(RemoteHostId('h'), '开发机', 'http://127.0.0.1:3091')
      await store.updateSshHost(RemoteHostId('h'), '开发机', {
        target: 'dev-box', user: 'good', hostKeyFingerprint: 'SHA256:test',
      })
      await store.updateHostTitle(RemoteHostId('h'), '主开发机')

      expect(calls.filter(call => call.method === 'host.update')).toEqual([
        {
          method: 'host.update',
          params: { hostId: 'h', title: '开发机', endpoint: 'http://127.0.0.1:3091' },
        },
        {
          method: 'host.update',
          params: { hostId: 'h', title: '主开发机' },
        },
      ])
      expect(calls.find(call => call.method === 'operation.start')).toEqual({
        method: 'operation.start',
        params: {
          kind: 'host-ssh-deploy', hostId: 'h', title: '开发机',
          ssh: { target: 'dev-box', user: 'good', hostKeyFingerprint: 'SHA256:test' }, confirm: true,
        },
      })
    } finally {
      store.dispose()
    }
  })

  it('sets a DSH API key without requesting the saved value back', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      return Response.json({ id: body.id, ok: true, result: body.method === 'state' ? EMPTY : { configured: true } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.setDshApiKey(RemoteHostId('h'), 'sk-browser-secret')
      expect(calls.map(call => call.method)).toEqual(['state', 'agent.credential.set', 'state'])
      expect(calls[1]?.params).toEqual({ hostId: 'h', apiKey: 'sk-browser-secret' })
    } finally {
      store.dispose()
    }
  })

  it('persists a session rename and reloads the updated catalog title', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let session = {
      sessionId: 's-rename', projectId: 'p', title: '旧名称', backend: 'codex',
      channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      if (body.method === 'session.rename') {
        session = { ...session, title: String(body.params.title), updatedAt: 'c' }
        return Response.json({ id: body.id, ok: true, result: session })
      }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: [session] } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.renameSession(RemoteSessionId('s-rename'), '新名称')

      expect(calls.map(call => call.method)).toEqual(['state', 'session.rename', 'state'])
      expect(calls[1]?.params).toEqual({ sessionId: 's-rename', title: '新名称' })
      expect(store.getSnapshot()).toMatchObject({
        phase: 'ready', pending: false, state: { sessions: [{ sessionId: 's-rename', title: '新名称' }] },
      })
    } finally {
      store.dispose()
    }
  })

  it('keeps a new session as a local placeholder and locks the Agent on first send', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const session = {
      sessionId: 's-new', projectId: 'p', title: 'first question', backend: 'grok',
      channelState: 'open', turnState: 'running', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    let created = false
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      const state = { ...EMPTY, sessions: created ? [session] : [] }
      if (body.method === 'session.start') {
        created = true
        // Gateway now returns the connecting row immediately and announces the
        // bound view via the WS push. Simulate that here so awaitSessionOpen
        // can observe the binding instead of waiting the full timeout.
        queueMicrotask(() => {
          store.consume({ type: 'session.view.changed', session })
        })
        return Response.json({ id: body.id, ok: true, result: session })
      }
      return Response.json({ id: body.id, ok: true, result: body.method === 'session.prompt' ? {} : state })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      store.startSessionDraft(RemoteProjectId('p'))
      expect(store.getSnapshot()).toMatchObject({ draftSession: { projectId: 'p', title: '新会话' } })
      expect(calls.map(call => call.method)).toEqual(['state'])

      await store.promptSessionDraft('grok', 'first question')

      expect(store.getSnapshot().draftSession).toBeUndefined()
      expect(store.getSnapshot().currentSessionId).toBe('s-new')
      expect(calls.map(call => call.method)).toEqual(['state', 'session.start', 'state', 'session.prompt', 'state'])
      expect(calls[1]?.params).toMatchObject({ projectId: 'p', backend: 'grok', title: 'first question' })
    } finally {
      store.dispose()
    }
  })

  it('does not reopen Agent selection after session creation when first prompt fails', async () => {
    const session = {
      sessionId: 's-created', projectId: 'p', title: 'question', backend: 'codex',
      channelState: 'open', turnState: 'failed', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    let store: RemoteAgentStore | undefined
    let created = false
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      if (body.method === 'session.start') {
        created = true
        // Mirror the gateway's optimistic create + WS push so the store can
        // observe the bound session before session.prompt is attempted.
        queueMicrotask(() => {
          store?.consume({ type: 'session.view.changed', session })
        })
        return Response.json({ id: body.id, ok: true, result: session })
      }
      if (body.method === 'session.prompt') {
        return Response.json({ id: body.id, ok: false, error: { message: 'prompt failed' } })
      }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: created ? [session] : [] } })
    }))
    store = new RemoteAgentStore()
    try {
      await store.start()
      store.startSessionDraft(RemoteProjectId('p'))
      await expect(store.promptSessionDraft('codex', 'question')).rejects.toThrow('prompt failed')
      expect(store.getSnapshot()).toMatchObject({ currentSessionId: 's-created', error: 'Error: prompt failed' })
      expect(store.getSnapshot().draftSession).toBeUndefined()
      await expect(store.promptSessionDraft('grok', 'retry')).rejects.toThrow('no new-session draft')
    } finally {
      store.dispose()
    }
  })

  it('rebuilds catalog over HTTP while reconnecting without looking live', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      calls.push(body.method)
      return Response.json({ id: body.id, ok: true, result: EMPTY })
    }))
    const store = new RemoteAgentStore()
    try {
      store.setPhase('reconnecting')
      await store.start()
      expect(store.getSnapshot().phase).toBe('reconnecting')
      expect(calls.every(method => method === 'state')).toBe(true)
    } finally {
      store.dispose()
    }
  })

  it('applies session.view.changed turnState without a full reload', async () => {
    const session = {
      sessionId: 's-view', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'running', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: [session] } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      expect(store.getSnapshot().state.sessions[0]?.turnState).toBe('running')
      store.consume({
        type: 'session.view.changed',
        session: { ...session, turnState: 'idle', updatedAt: 'c' },
      })
      expect(store.getSnapshot().state.sessions[0]?.turnState).toBe('idle')
    } finally {
      store.dispose()
    }
  })

  it('does not let a catalog reload clobber reconnecting phase', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string }
      return Response.json({ id: body.id, ok: true, result: EMPTY })
    }))
    const store = new RemoteAgentStore()
    try {
      store.setPhase('reconnecting')
      await store.start()
      expect(store.getSnapshot().phase).toBe('reconnecting')
    } finally {
      store.dispose()
    }
  })

  it('tracks sending and waiting until the first backend event arrives', async () => {
    const runningSession = {
      sessionId: 's-progress', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'running', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    let releasePrompt: (() => void) | undefined
    const promptAdmission = new Promise<void>((resolve) => { releasePrompt = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      if (body.method === 'session.prompt') {
        await promptAdmission
        return Response.json({ id: body.id, ok: true, result: { accepted: true } })
      }
      const state = {
        ...EMPTY,
        sessions: [runningSession],
        transcript: [],
      }
      return Response.json({ id: body.id, ok: true, result: state })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      const task = store.prompt(RemoteSessionId('s-progress'), 'hello')
      expect(store.getSnapshot().promptProgress).toMatchObject({ sessionId: 's-progress', phase: 'sending' })

      releasePrompt?.()
      await task
      expect(store.getSnapshot().promptProgress).toMatchObject({ sessionId: 's-progress', phase: 'waiting' })

      store.consume({
        type: 'transcript.append',
        sessionId: 's-progress',
        seq: 1,
        entry: {
          transcriptId: 't', sessionId: 's-progress', seq: 1, role: 'assistant', kind: 'reasoning',
          text: 'thinking', createdAt: '2026-08-30T00:00:00.000Z',
        },
      })
      expect(store.getSnapshot().promptProgress).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('applies transcript batch pushes in one snapshot update', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string }
      return Response.json({
        id: body.id,
        ok: true,
        result: {
          ...EMPTY,
          sessions: [{
            sessionId: 's-batch', projectId: 'p', title: 'batch', backend: 'codex',
            channelState: 'open', turnState: 'running', createdAt: 'a', updatedAt: 'b',
            binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
          }],
          transcript: [],
        },
      })
    }))
    const store = new RemoteAgentStore()
    let publishes = 0
    const unsubscribe = store.subscribe(() => { publishes += 1 })
    try {
      await store.start()
      publishes = 0
      store.consume({
        type: 'transcript.batch',
        sessionId: 's-batch',
        fromSeq: 1,
        toSeq: 2,
        entries: [
          {
            transcriptId: 't1', sessionId: 's-batch', seq: 1, role: 'assistant', kind: 'message',
            text: 'hello', createdAt: '2026-08-30T00:00:00.000Z',
          },
          {
            transcriptId: 't2', sessionId: 's-batch', seq: 2, role: 'assistant', kind: 'message',
            text: ' world', createdAt: '2026-08-30T00:00:00.000Z',
          },
        ],
      })
      expect(store.getSnapshot().state.transcript.map(entry => entry.text)).toEqual(['hello', ' world'])
      expect(publishes).toBe(1)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it('rejects a response that belongs to another browser request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'other', ok: true, result: EMPTY })))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      expect(store.getSnapshot()).toMatchObject({
        phase: 'error',
        error: 'Error: remote-agent response id did not match request',
      })
    } finally {
      store.dispose()
    }
  })

  it('classifies hostd liveness from inventory health and version', () => {
    const base = {
      hostId: 'h', title: 'box', endpoint: 'http://127.0.0.1:1', createdAt: 'a', updatedAt: 'b',
    } as const
    expect(hostDeployment({ ...base }, '1.0.0')).toBe('checking')
    expect(hostDeployment({ ...base, inventoryError: 'offline' }, '1.0.0')).toBe('missing')
    expect(hostDeployment({
      ...base,
      inventory: { protocolVersion: 1, hostdVersion: '0.9.0', hostId: 'native', healthy: false, backends: [] },
    }, '1.0.0')).toBe('missing')
    expect(hostDeployment({
      ...base,
      inventory: { protocolVersion: 1, hostdVersion: '0.9.0', hostId: 'native', healthy: true, backends: [] },
    }, '1.0.0')).toBe('outdated')
    expect(hostDeployment({
      ...base,
      inventory: { protocolVersion: 1, hostdVersion: '1.0.0', hostId: 'native', healthy: true, backends: [] },
    }, '1.0.0')).toBe('deployed')
    const stale = {
      ...base,
      inventoryError: 'fetch failed',
      inventory: { protocolVersion: 1 as const, hostdVersion: '0.1.0', hostId: 'native', healthy: true, backends: [] },
    }
    expect(hostDeployment(stale, '0.1.0')).toBe('missing')
    expect(hostConnectionLabel(stale, '0.1.0')).toBe('离线')
    expect(describeHostConnectFailure('fetch failed')).toBe('无法连接到 hostd。请确认远端服务已启动后再试。')
    expect(describeHostConnectFailure('Error: Failed to fetch')).toBe('无法连接到 hostd。请确认远端服务已启动后再试。')
    expect(describeHostConnectFailure('hostd response id did not match request')).toBe('hostd response id did not match request')
  })

  it('retries a host connection and fails when inventory is still unreachable', async () => {
    const host = {
      hostId: 'h', title: 'box', endpoint: 'http://127.0.0.1:3091', createdAt: 'a', updatedAt: 'b',
      inventoryError: 'fetch failed',
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, hosts: [host] } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await expect(store.reconnectHost(RemoteHostId('h'))).rejects.toThrow('fetch failed')
    } finally {
      store.dispose()
    }
  })

  it('hides, restores, and deletes catalog items through dedicated methods', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const initialState = {
      ...EMPTY,
      hosts: [{ hostId: 'h', title: 'box', endpoint: 'http://127.0.0.1:3091', createdAt: 'a', updatedAt: 'b' }],
      projects: [{ projectId: 'p', hostId: 'h', title: 'repo', cwd: '/repo', createdAt: 'a', updatedAt: 'b' }],
      sessions: [{
        sessionId: 's', projectId: 'p', title: 'work', backend: 'codex',
        channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      const result = body.method === 'hidden.list'
        ? {
          hosts: [{ ...initialState.hosts[0], hiddenAt: '2026-08-31T00:00:00.000Z' }],
          projects: [{ ...initialState.projects[0], hiddenAt: '2026-08-31T00:00:00.000Z' }],
          sessions: [{ ...initialState.sessions[0], archivedAt: '2026-08-31T00:00:00.000Z' }],
        }
        : initialState
      return Response.json({ id: body.id, ok: true, result })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.hideHost(RemoteHostId('h'))
      await store.unhideHost(RemoteHostId('h'))
      await store.deleteHost(RemoteHostId('h'))
      await store.hideProject(RemoteProjectId('p'))
      await store.unhideProject(RemoteProjectId('p'))
      await store.deleteProject(RemoteProjectId('p'))
      await store.renameProject(RemoteProjectId('p'), 'new-name')
      await store.unarchiveSession(RemoteSessionId('s'))
      await store.deleteSession(RemoteSessionId('s'))
      await store.loadHiddenItems()
      expect(parseHiddenItems({
        hosts: [{ ...initialState.hosts[0], hiddenAt: '2026-08-31T00:00:00.000Z' }],
        projects: [],
        sessions: [],
      }).hosts[0]?.hiddenAt).toBe('2026-08-31T00:00:00.000Z')
      expect(calls.map(call => call.method).filter(method => method !== 'state' && method !== 'inventory')).toEqual([
        'host.hide',
        'host.unhide',
        'host.delete',
        'project.hide',
        'project.unhide',
        'project.delete',
        'project.rename',
        'session.unarchive',
        'session.delete',
        'hidden.list',
      ])
      expect(store.getSnapshot().hiddenItems?.hosts[0]?.hiddenAt).toBe('2026-08-31T00:00:00.000Z')
    } finally {
      store.dispose()
    }
  })
})
