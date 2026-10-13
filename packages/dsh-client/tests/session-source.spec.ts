/**
 * This host's sessions, read from DSH's own projections.
 *
 * The rule under test: a read either produces placed rows or names why there
 * are none — never an empty list that looks caught up. Placement rules
 * themselves live in the federation's workspace-map and are tested there; what
 * is tested here is the narrowing of untrusted service reads and the honest
 * failure notes.
 */

import { describe, expect, it } from 'vitest'
import { buildHostSessions, readSessionSources } from '../src/session-source.ts'

/** A service face narrow enough to stand in for DSH's own projections. */
function service(snapshot: unknown, options: { subscribe?: boolean } = {}): unknown {
  return {
    getSnapshot: () => snapshot,
    ...(options.subscribe === true ? { subscribe: (listener: () => void) => { listener(); return () => {} } } : {}),
  }
}

const workspacesSnapshot = {
  items: [
    { workspaceId: 'w1', title: 'Web', path: '/home/me/web', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', title: 'Bench', path: '/home/me/bench', sessionIds: ['s3'] },
  ],
  archivedSessionIds: ['s2'],
  state: 'idle',
}

const sessionsSnapshot = {
  ids: ['s1', 's2', 's3', 's4'],
  byId: {
    s1: { displayTitle: '修登录', title: '修登录' },
    s2: { displayTitle: '旧会话' },
    s3: {},
  },
}

describe('buildHostSessions', () => {
  it('places sessions under their workspace with real titles', () => {
    const read = buildHostSessions(
      { items: workspacesSnapshot.items as never, archivedSessionIds: [], state: 'idle' },
      { ids: ['s1', 's3'], byId: { s1: { displayTitle: '修登录' }, s3: {} } },
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.sessions).toEqual([
        { projectId: 'w1', sessionId: 's1', title: '修登录', projectTitle: 'Web' },
        { projectId: 'w2', sessionId: 's3', title: '会话 s3', projectTitle: 'Bench' },
      ])
    }
  })

  it('filters archived sessions the host has set aside', () => {
    const read = buildHostSessions(
      {
        items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1', 's2'] }],
        archivedSessionIds: ['s2'],
        state: 'idle',
      },
      { ids: ['s1', 's2'], byId: { s1: { displayTitle: '修登录' }, s2: { displayTitle: '旧会话' } } },
    )
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.sessions.map(row => row.sessionId)).toEqual(['s1'])
  })

  it('keeps a session no workspace claims under 未归组', () => {
    const read = buildHostSessions(
      { items: [], archivedSessionIds: [], state: 'idle' },
      { ids: ['s9'], byId: { s9: { displayTitle: '漂着' } } },
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.sessions).toEqual([
        { projectId: 'ungrouped', sessionId: 's9', title: '漂着', projectTitle: '未归组' },
      ])
    }
  })

  it('without the session projection, workspace ids still place rows with id titles', () => {
    const read = buildHostSessions(
      {
        items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1'] }],
        archivedSessionIds: [],
        state: 'idle',
      },
      undefined,
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.sessions).toEqual([
        { projectId: 'w1', sessionId: 's1', title: '会话 s1', projectTitle: 'Web' },
      ])
    }
  })

  it('says why there is nothing when a projection is missing', () => {
    const missing = buildHostSessions(undefined, undefined)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.note).toContain('workspaces')
  })

  it('says why there is nothing while the workspace list is loading or failed', () => {
    const loading = buildHostSessions(
      { items: [], archivedSessionIds: [], state: 'loading' },
      { ids: [], byId: {} },
    )
    expect(loading.ok).toBe(false)
    if (!loading.ok) expect(loading.note).toContain('加载')

    const failed = buildHostSessions(
      { items: [], archivedSessionIds: [], state: 'error' },
      { ids: [], byId: {} },
    )
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.note).toContain('失败')
  })
})

describe('readSessionSources', () => {
  it('narrows real-shaped services and drops shapeless ones', () => {
    const good = readSessionSources({
      workspaces: service(workspacesSnapshot, { subscribe: true }),
      sessions: service(sessionsSnapshot),
    })
    expect(good.workspaces?.items).toHaveLength(2)
    expect(good.workspaces?.subscribe).toBeTypeOf('function')
    expect(good.sessions?.ids).toEqual(['s1', 's2', 's3', 's4'])

    const bad = readSessionSources({
      workspaces: { noSnapshot: true },
      sessions: 42,
    })
    expect(bad.workspaces).toBeUndefined()
    expect(bad.sessions).toBeUndefined()
  })

  it('reads a throwing service as absent, not as a crash', () => {
    const sources = readSessionSources({
      get workspaces() { throw new Error('cannot get property "workspaces" without inject') },
      get sessions() { throw new Error('cannot get property "sessions" without inject') },
    })
    expect(sources.workspaces).toBeUndefined()
    expect(sources.sessions).toBeUndefined()
  })
})
