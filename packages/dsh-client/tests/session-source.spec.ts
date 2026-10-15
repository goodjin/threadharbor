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
import { buildHostSessions, currentSessionId, readSessionSources } from '../src/session-source.ts'

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

  it('置顶/归档/最近更新/进行中穿层不丢（回归：最终映射曾剥掉它们）', () => {
    const service = {
      list: {
        getSnapshot: () => ({
          ids: ['s1', 's2'],
          byId: {
            s1: { displayTitle: '置顶的', updatedAt: 100, running: true },
            s2: { displayTitle: '归档的', updatedAt: 200 },
          },
        }),
        subscribe: () => () => {},
      },
    }
    const workspaces = {
      items: [{ workspaceId: 'w1', title: '研究', path: '/a/研究', sessionIds: ['s1', 's2'] }],
      archivedSessionIds: ['s2'],
      pinnedSessionIds: ['s1'],
      state: 'idle',
    }
    const read = buildHostSessions(workspaces, readSessionSources({ sessions: service }).sessions)
    const rows = read.ok ? read.sessions : []
    expect(rows.find(r => r.sessionId === 's1')).toMatchObject({ pinned: true, updatedAt: 100, running: true })
    expect(rows.find(r => r.sessionId === 's2')).toMatchObject({ archived: true, updatedAt: 200 })
    expect(rows.find(r => r.sessionId === 's2')).not.toHaveProperty('running')
  })

  it('当前会话判定：主视图占用的行胜出（原生同款规则）', () => {
    const service = {
      list: {
        getSnapshot: () => ({
          ids: ['s1', 's2'],
          byId: {
            s1: { displayTitle: '甲', retainedBy: { mainView: 3 } },
            s2: { displayTitle: '乙', retainedBy: {} },
          },
        }),
        subscribe: () => () => {},
      },
    }
    const sources = readSessionSources({ sessions: service })
    expect(currentSessionId(sources.sessions)).toBe('s1')
    expect(currentSessionId(undefined)).toBeUndefined()
  })

  it('旧格式空白会话：无 blank 标记但无原始标题、展示名等于项目名或路径基名 → 丢弃', () => {
    // 旧格式会话运行时行可能缺 blank；展示名是收窄层给的目录名回退。
    const read = buildHostSessions(
      {
        items: [{ workspaceId: 'w1', title: 'signalscout', path: '/Users/good/dsh/signalscout', sessionIds: ['s1', 's9', 's10'] }],
        archivedSessionIds: [],
        state: 'idle',
      },
      {
        ids: ['s1', 's9', 's10'],
        byId: {
          s1: { displayTitle: '真实会话' },
          s9: { displayTitle: 'signalscout' },
          s10: { displayTitle: 'signalscout', title: 'signalscout' },
        },
      },
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      // s9 无 title → 空白回退形状，丢弃；s10 有 title（改名/起过名）→ 保留。
      expect(read.sessions.map(row => row.sessionId)).toEqual(['s1', 's10'])
    }
  })

  it('经完整服务形状读取：blank/origin 字段透传到过滤（回归：收窄层曾把它们丢掉）', () => {
    const service = {
      list: {
        getSnapshot: () => ({
          ids: ['s1', 's9', 's10'],
          byId: {
            s1: { displayTitle: '修登录', blank: false },
            s9: { displayTitle: 'Web', blank: true },
            s10: { displayTitle: '子代理', origin: 'subagent' },
          },
        }),
        subscribe: () => () => {},
      },
    }
    const sources = readSessionSources({ sessions: service })
    expect(sources.sessions?.subscribe).toBeTypeOf('function')
    const read = buildHostSessions(
      { items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1', 's9', 's10'] }], archivedSessionIds: [], state: 'idle' },
      sources.sessions,
    )
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.sessions.map(row => row.sessionId)).toEqual(['s1'])
  })

  it('空白会话与子代理会话不进树（对齐原生列表的可见性规则）', () => {
    const read = buildHostSessions(
      {
        items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1', 's9', 's10', 's11'] }],
        archivedSessionIds: [],
        state: 'idle',
      },
      {
        ids: ['s1', 's9', 's10', 's11'],
        byId: {
          s1: { displayTitle: '修登录' },
          s9: { title: 'Web', blank: true },
          s10: { displayTitle: '子代理跑的活', origin: 'subagent' },
          s11: { displayTitle: '正常' },
        },
      },
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.sessions.map(row => row.sessionId)).toEqual(['s1', 's11'])
    }
  })

  it('归档的会话带标记随行：可见性由树的筛选选项决定，数据面只标记', () => {
    const read = buildHostSessions(
      {
        items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1', 's2'] }],
        archivedSessionIds: ['s2'],
        state: 'idle',
      },
      { ids: ['s1', 's2'], byId: { s1: { displayTitle: '修登录' }, s2: { displayTitle: '旧会话' } } },
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.sessions.map(row => row.sessionId)).toEqual(['s1', 's2'])
      expect(read.sessions.find(row => row.sessionId === 's2')).toMatchObject({ archived: true })
    }
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
