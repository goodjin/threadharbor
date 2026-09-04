import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteHostId, RemoteProjectId, RemoteSessionId } from '@threadharbor/protocol'
import { RemoteAgentStore, backendInventoryState, describeAgentInstallFailure, describeHostConnectFailure, describeSessionReconnectFailure, hostConnectionLabel, hostDeployment, parseAgentConfigDocument, parseHiddenItems, parseInstallPlan, parseOperation, parseRemoteAgentState } from '../src/client/store.ts'

const EMPTY = { pollIntervalMs: 60_000, hosts: [], projects: [], sessions: [], transcript: [], operations: [] }

beforeEach(() => {
  const session = new Map<string, string>()
  const local = new Map<string, string>()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => { session.set(key, value) },
    },
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value) },
      removeItem: (key: string) => { local.delete(key) },
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
    expect(parseOperation({
      operationId: 'op-agent', kind: 'agent-install', status: 'running', phase: 'installing',
      title: '部署 dsh', detail: '正在执行官方安装命令。', target: 'host:h:agent:dsh', cancellable: false,
      hostId: 'h', backend: 'dsh', startedAt: 'a', updatedAt: 'b',
    })).toMatchObject({ kind: 'agent-install', backend: 'dsh', phase: 'installing' })
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
      expect(calls.filter(method => method !== 'transcript.read')).toEqual(['state'])
      expect(calls).toContain('transcript.read')
      expect(store.getSnapshot()).toMatchObject({ phase: 'ready', currentSessionId: 's', pending: false })
      expect(store.getSnapshot().attachingSessionId).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('restores the last selected session instead of jumping to the first catalog row', async () => {
    const local = new Map<string, string>([['dsh.remote-agent.current-session-id', 's-keep']])
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      sessionStorage: { getItem: () => null, setItem: () => undefined },
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => { local.set(key, value) },
      },
    })
    const sessions = [
      {
        sessionId: 's-first', projectId: 'p', title: 'old', backend: 'codex',
        channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
        binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
      },
      {
        sessionId: 's-keep', projectId: 'p', title: 'keep', backend: 'grok',
        channelState: 'open', turnState: 'idle', createdAt: 'c', updatedAt: 'd',
        binding: { holdId: 'hold-2', generation: 'g2', state: 'active', lastSeq: 0 },
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      expect(store.getSnapshot().currentSessionId).toBe('s-keep')
      await store.selectSession(RemoteSessionId('s-first'))
      expect(local.get('dsh.remote-agent.current-session-id')).toBe('s-first')
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

  it('loads the opened session in pages and does not let catalog reloads replace transcript', async () => {
    const session = {
      sessionId: 's-page', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
      latestTranscriptSeq: 3,
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    const entries = [
      { transcriptId: 't0', sessionId: 's-page', seq: 0, role: 'user', kind: 'message', text: 'q', createdAt: 'a' },
      { transcriptId: 't1', sessionId: 's-page', seq: 1, role: 'assistant', kind: 'message', text: 'a1', createdAt: 'a' },
      { transcriptId: 't2', sessionId: 's-page', seq: 2, role: 'assistant', kind: 'message', text: 'a2', createdAt: 'a' },
      { transcriptId: 't3', sessionId: 's-page', seq: 3, role: 'assistant', kind: 'message', text: 'a3', createdAt: 'a' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      if (body.method === 'transcript.read') {
        const afterSeq = typeof body.params.afterSeq === 'number' ? body.params.afterSeq : undefined
        const beforeSeq = typeof body.params.beforeSeq === 'number' ? body.params.beforeSeq : undefined
        const pageSize = 2
        const page = afterSeq !== undefined
          ? entries.filter(entry => entry.seq > afterSeq).slice(0, pageSize)
          : beforeSeq !== undefined
            ? entries.filter(entry => entry.seq < beforeSeq).slice(-pageSize)
            : entries.slice(-pageSize)
        const remaining = afterSeq !== undefined
          ? entries.filter(entry => entry.seq > afterSeq).length
          : beforeSeq !== undefined
            ? entries.filter(entry => entry.seq < beforeSeq).length
            : entries.length
        return Response.json({
          id: body.id, ok: true,
          result: {
            sessionId: 's-page', entries: page, afterSeq: afterSeq ?? -1,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            fromSeq: page[0]?.seq ?? -1, toSeq: page.at(-1)?.seq ?? -1,
            latestSeq: 3, hasMore: remaining > page.length,
          },
        })
      }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: [session] } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      expect(store.getSnapshot().state.transcript.map(entry => entry.seq)).toEqual([2, 3])
      await store.selectSession(RemoteSessionId('s-page'))
      await vi.waitFor(() => {
        expect(store.getSnapshot().state.transcript.map(entry => entry.seq)).toEqual([0, 1, 2, 3])
      })
      store.consume({ type: 'host.changed' })
      await vi.waitFor(() => {
        expect(store.getSnapshot().state.transcript.map(entry => entry.seq)).toEqual([0, 1, 2, 3])
      })
    } finally {
      store.dispose()
    }
  })

  it('keeps catching up a running opened session after the first transcript page is empty', async () => {
    const session = {
      sessionId: 's-live', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'running', createdAt: 'a', updatedAt: 'b',
      latestTranscriptSeq: 1,
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 4 },
    }
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      if (body.method === 'transcript.read') {
        reads += 1
        const entries = reads === 1
          ? []
          : [{
            transcriptId: 't1', sessionId: 's-live', seq: 1, role: 'assistant', kind: 'message',
            text: 'late', createdAt: 'c',
          }]
        return Response.json({
          id: body.id, ok: true,
          result: {
            sessionId: 's-live', entries, afterSeq: -1, fromSeq: entries[0]?.seq ?? -1,
            toSeq: entries.at(-1)?.seq ?? -1, latestSeq: reads === 1 ? -1 : 1, hasMore: false,
          },
        })
      }
      return Response.json({
        id: body.id, ok: true,
        result: { ...EMPTY, pollIntervalMs: 20, sessions: [session] },
      })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await vi.waitFor(() => {
        expect(store.getSnapshot().state.transcript.map(entry => entry.text)).toEqual(['late'])
      })
      expect(reads).toBeGreaterThan(1)
    } finally {
      store.dispose()
    }
  })

  it('backs off transcript.read while a prompt is running and pages stay empty', async () => {
    const delays: number[] = []
    const sessionStore = new Map<string, string>()
    vi.stubGlobal('window', {
      setTimeout: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (typeof timeout === 'number' && timeout >= 250) delays.push(timeout)
        return globalThis.setTimeout(handler, timeout, ...args)
      },
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      sessionStorage: {
        getItem: (key: string) => sessionStore.get(key) ?? null,
        setItem: (key: string, value: string) => { sessionStore.set(key, value) },
      },
    })
    const session = {
      sessionId: 's-backoff', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'running', createdAt: 'a', updatedAt: 'b',
      latestTranscriptSeq: -1,
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      if (body.method === 'transcript.read') {
        return Response.json({
          id: body.id, ok: true,
          result: {
            sessionId: 's-backoff', entries: [], afterSeq: -1, fromSeq: -1, toSeq: -1, latestSeq: -1, hasMore: false,
          },
        })
      }
      return Response.json({
        id: body.id, ok: true,
        result: { ...EMPTY, sessions: [session] },
      })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await vi.waitFor(() => {
        expect(delays.slice(0, 4)).toEqual([250, 500, 1000, 2000])
      }, { timeout: 8_000 })
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

  it('parses a reviewable agent install plan', () => {
    expect(parseInstallPlan({
      component: 'dsh', version: 'deepseek-harness-runtime-bin==0.1.1rc1', alreadyInstalled: false,
      requiresConfirmation: true,
      steps: [{ title: 'Install DSH', command: 'python3 -m pip install --user --upgrade deepseek-harness-runtime-bin==0.1.1rc1' }],
    })).toMatchObject({ component: 'dsh', requiresConfirmation: true, steps: [{ command: expect.stringContaining('pip install') }] })
    expect(() => parseInstallPlan({
      component: 'dsh', version: 'x', alreadyInstalled: false, requiresConfirmation: false, steps: [],
    })).toThrow('require confirmation')
  })

  it('starts agent install as a confirmed background operation', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      const result = body.method === 'state' ? EMPTY : body.method === 'operation.start' ? {
        operationId: 'op-dsh', kind: 'agent-install', status: 'queued', phase: 'queued',
        title: '部署 dsh', detail: '已排队。', target: 'host:h:agent:dsh', cancellable: false,
        hostId: 'h', backend: 'dsh', startedAt: 'a', updatedAt: 'a',
      } : body.method === 'agent.install.plan' ? {
        component: 'dsh', version: 'deepseek-harness-runtime-bin==0.1.1rc1', alreadyInstalled: false,
        requiresConfirmation: true, steps: [{ title: 'Install DSH', command: 'python3 -m pip install --user x' }],
      } : {}
      return Response.json({ id: body.id, ok: true, result })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      const plan = await store.installPlan(RemoteHostId('h'), 'dsh')
      expect(plan.component).toBe('dsh')
      const operation = await store.installAgent(RemoteHostId('h'), 'dsh')
      expect(operation).toMatchObject({ kind: 'agent-install', backend: 'dsh' })
      expect(calls.find(call => call.method === 'operation.start')).toEqual({
        method: 'operation.start',
        params: { kind: 'agent-install', hostId: 'h', backend: 'dsh', confirm: true },
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

      expect(calls.map(call => call.method).filter(method => method !== 'transcript.read'))
        .toEqual(['state', 'session.rename', 'state'])
      expect(calls.find(call => call.method === 'session.rename')?.params).toEqual({ sessionId: 's-rename', title: '新名称' })
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
      expect(store.getSnapshot().state.sessions.map(entry => entry.sessionId)).toEqual(['s-new'])
      expect(calls.map(call => call.method).filter(method => method !== 'transcript.read'))
        .toEqual(['state', 'session.start', 'session.prompt', 'state'])
      expect(calls[1]?.params).toMatchObject({ projectId: 'p', backend: 'grok', title: 'first question' })
    } finally {
      store.dispose()
    }
  })

  it('inserts a newly created session from session.view.changed without reloading', async () => {
    const existing = {
      sessionId: 's-old', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    const created = {
      sessionId: 's-new', projectId: 'p', title: 'first question', backend: 'grok',
      channelState: 'connecting', turnState: 'idle', createdAt: 'c', updatedAt: 'd',
    }
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      calls.push(body.method)
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: [existing] } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      store.startSessionDraft(RemoteProjectId('p'))
      store.consume({ type: 'session.view.changed', session: created })

      expect(calls.filter(method => method !== 'transcript.read')).toEqual(['state'])
      expect(store.getSnapshot().draftSession).toEqual({ projectId: 'p', title: '新会话' })
      expect(store.getSnapshot().state.sessions.map(entry => entry.sessionId)).toEqual(['s-old', 's-new'])
      expect(store.getSnapshot().state.sessions[1]).toMatchObject({ sessionId: 's-new', channelState: 'connecting' })
    } finally {
      store.dispose()
    }
  })

  it('keeps the created session visible while waiting for the remote binding', async () => {
    const connecting = {
      sessionId: 's-new', projectId: 'p', title: 'first question', backend: 'grok',
      channelState: 'connecting', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
    }
    const opened = {
      ...connecting,
      channelState: 'open',
      turnState: 'running',
      updatedAt: 'c',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    let created = false
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      if (body.method === 'session.start') {
        created = true
        return Response.json({ id: body.id, ok: true, result: connecting })
      }
      return Response.json({
        id: body.id,
        ok: true,
        result: body.method === 'session.prompt' ? {} : { ...EMPTY, sessions: created ? [opened] : [] },
      })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      store.startSessionDraft(RemoteProjectId('p'))
      const pending = store.promptSessionDraft('grok', 'first question')
      await vi.waitFor(() => {
        expect(store.getSnapshot().currentSessionId).toBe('s-new')
      })
      expect(store.getSnapshot().draftSession).toBeUndefined()
      expect(store.getSnapshot().state.sessions).toEqual([expect.objectContaining({
        sessionId: 's-new', channelState: 'connecting',
      })])

      store.consume({
        type: 'transcript.append',
        sessionId: 's-other',
        seq: 1,
        entry: {
          transcriptId: 't-other', sessionId: 's-other', seq: 1, role: 'assistant', kind: 'message',
          text: 'unrelated', createdAt: 'a',
        },
      })
      expect(store.getSnapshot().state.sessions[0]?.channelState).toBe('connecting')

      store.consume({ type: 'session.view.changed', session: opened })
      await pending
      expect(store.getSnapshot().draftSession).toBeUndefined()
      expect(store.getSnapshot()).toMatchObject({
        currentSessionId: 's-new',
        state: { sessions: [{ sessionId: 's-new', channelState: 'open' }] },
      })
    } finally {
      store.dispose()
    }
  })

  it('does not let a stale catalog reload drop the in-flight new session', async () => {
    const existing = {
      sessionId: 's-old', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 0 },
    }
    const created = {
      sessionId: 's-new', projectId: 'p', title: 'first question', backend: 'grok',
      channelState: 'connecting', turnState: 'idle', createdAt: 'c', updatedAt: 'd',
    }
    let releaseStale: (() => void) | undefined
    const stale = new Promise<void>(resolve => { releaseStale = resolve })
    let stateCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      if (body.method === 'state') {
        stateCalls += 1
        if (stateCalls === 2) await stale
        return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: [existing] } })
      }
      return Response.json({ id: body.id, ok: true, result: { entries: [], latestSeq: -1, fromSeq: 0, toSeq: -1, hasMore: false } })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      store.consume({ type: 'host.changed', host: { hostId: 'h' } })
      store.consume({ type: 'session.view.changed', session: created })
      await store.selectSession(RemoteSessionId('s-new'))
      expect(store.getSnapshot().state.sessions.map(entry => entry.sessionId)).toEqual(['s-old', 's-new'])
      releaseStale?.()
      await vi.waitFor(() => { expect(stateCalls).toBe(2) })
      expect(store.getSnapshot().state.sessions.map(entry => entry.sessionId)).toEqual(['s-old', 's-new'])
      expect(store.getSnapshot().currentSessionId).toBe('s-new')
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

  it('pages transcript over HTTP after a reconnecting catalog rebuild', async () => {
    const session = {
      sessionId: 's-live', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'open', turnState: 'idle', createdAt: 'a', updatedAt: 'b',
      latestTranscriptSeq: 1,
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 4 },
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      if (body.method === 'transcript.read') {
        return Response.json({
          id: body.id, ok: true,
          result: {
            sessionId: 's-live',
            entries: [{
              transcriptId: 't1', sessionId: 's-live', seq: 1, role: 'assistant',
              kind: 'message', text: 'answer', createdAt: 'a',
            }],
            latestSeq: 1, fromSeq: 1, toSeq: 1, hasMore: false, afterSeq: -1,
          },
        })
      }
      return Response.json({ id: body.id, ok: true, result: { ...EMPTY, sessions: [session] } })
    }))
    const store = new RemoteAgentStore()
    try {
      store.setPhase('reconnecting')
      await store.start()
      await vi.waitFor(() => {
        expect(store.getSnapshot().state.transcript.some(entry => entry.text === 'answer')).toBe(true)
      })
      expect(store.getSnapshot().phase).toBe('reconnecting')
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
      store.consume({
        type: 'session.view.changed',
        session: { ...session, turnState: 'stopped', updatedAt: 'd' },
      })
      expect(store.getSnapshot().state.sessions[0]?.turnState).toBe('stopped')
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
    expect(hostDeployment({
      ...base,
      inventory: { protocolVersion: 1, hostdVersion: '0.1.0+aaaaaaaaaaaa', hostId: 'native', healthy: true, backends: [] },
    }, '0.1.0+bbbbbbbbbbbb')).toBe('outdated')
    expect(hostConnectionLabel({
      ...base,
      inventory: { protocolVersion: 1, hostdVersion: '0.1.0+aaaaaaaaaaaa', hostId: 'native', healthy: true, backends: [] },
    }, '0.1.0+bbbbbbbbbbbb')).toBe('已连接，待升级')
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
    expect(describeAgentInstallFailure('hostd does not implement method agent.install.plan'))
      .toBe('当前 hostd 过旧，还不支持 Agent 部署。请先在主机设置里升级 hostd，再点部署。')
    expect(describeAgentInstallFailure('DSH installer exited with status 1: error: externally-managed-environment'))
      .toBe('这台主机的 Python 由系统管理（例如 Homebrew），旧版 hostd 的 pip install --user 会被拒绝。请先升级并重启 hostd，再点部署。')
    expect(describeSessionReconnectFailure('Error: connect ECONNREFUSED /tmp/threadharbor-hostd-501/h-dead.sock'))
      .toBe('远程会话进程已停止。可以点「在当前会话重开」，系统会在当前会话上重启 Agent，对话记录会保留。')
    expect(describeSessionReconnectFailure('远程会话进程已停止。可以点「在当前会话重开」，系统会在当前会话上重启 Agent，对话记录会保留。'))
      .toBe('远程会话进程已停止。可以点「在当前会话重开」，系统会在当前会话上重启 Agent，对话记录会保留。')
  })

  it('re-attaches a reconnecting session without waiting for a later catalog reload', async () => {
    const session = {
      sessionId: 's-reconnect', projectId: 'p', title: 'work', backend: 'codex',
      channelState: 'reconnecting', turnState: 'failed', createdAt: 'a', updatedAt: 'b',
      binding: { holdId: 'hold', generation: 'g', state: 'active', lastSeq: 3 },
    }
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { id: string; method: string }
      calls.push(body.method)
      if (body.method === 'session.attach') {
        return Response.json({
          id: body.id, ok: true,
          result: { ...session, channelState: 'open', turnState: 'idle', updatedAt: 'c' },
        })
      }
      return Response.json({
        id: body.id, ok: true,
        result: { ...EMPTY, sessions: [{ ...session, channelState: 'open', turnState: 'idle' }] },
      })
    }))
    const store = new RemoteAgentStore()
    try {
      await store.start()
      await store.reconnectSession(RemoteSessionId('s-reconnect'))
      expect(calls.filter(method => method !== 'transcript.read')).toEqual(['state', 'session.attach', 'state'])
      expect(store.getSnapshot()).toMatchObject({
        currentSessionId: 's-reconnect',
        state: { sessions: [{ sessionId: 's-reconnect', channelState: 'open' }] },
      })
    } finally {
      store.dispose()
    }
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
      expect(calls.map(call => call.method).filter(method => method !== 'state' && method !== 'inventory' && method !== 'transcript.read')).toEqual([
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
