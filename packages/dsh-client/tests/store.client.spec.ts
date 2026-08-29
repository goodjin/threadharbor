// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSessionId } from '@threadharbor/protocol'
import { RemoteAgentStore, parseAgentConfigDocument, parseRemoteAgentState } from '../src/client/store.ts'

const EMPTY = { pollIntervalMs: 60_000, hosts: [], projects: [], sessions: [], transcript: [] }

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a string request body')
  return init.body
}

afterEach(() => { vi.unstubAllGlobals() })

describe('RemoteAgentStore', () => {
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
      expect(calls).toEqual(['state', 'session.attach', 'events.read'])
      expect(store.getSnapshot()).toMatchObject({ phase: 'ready', currentSessionId: 's', pending: false })
    } finally {
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
})
