/**
 * Turning a host's workspaces into the sessions a roll-up lists.
 *
 * DSH's own workspace store keeps sessions whose directory has gone as
 * *ungrouped* rather than deleting them — `packages/workspace/workspace/src/entity.ts:3-13`.
 * A roll-up that quietly dropped them would show a shorter conversation list
 * than the host itself, with nothing to say why.
 */

import { describe, expect, it } from 'vitest'
import { sessionsFromWorkspaces } from '../src/workspace-map.ts'
import type { WorkspaceLike, SessionLike } from '../src/workspace-map.ts'

const WORKSPACES: WorkspaceLike[] = [
  { workspaceId: 'w1', title: 'ThreadHarbor', path: '/src/threadharbor', sessionIds: ['s1', 's2'] },
  { workspaceId: 'w2', title: 'DSH', path: '/src/dsh', sessionIds: ['s3'] },
]

const SESSIONS: SessionLike[] = [
  { sessionId: 's1', title: '迁移第一阶段', archived: false },
  { sessionId: 's2', title: '', archived: false },
  { sessionId: 's3', title: '取证', archived: false },
  { sessionId: 's9', title: '目录没了的会话', archived: false },
  { sessionId: 's8', title: '归档了的', archived: true },
]

const map = (extra: Partial<Parameters<typeof sessionsFromWorkspaces>[1]> = {}) =>
  sessionsFromWorkspaces(WORKSPACES, { sessions: SESSIONS, ...extra })

describe('sessionsFromWorkspaces', () => {
  it('lists a session under its workspace', () => {
    expect(map().find(s => s.sessionId === 's1')).toMatchObject({
      projectId: 'w1', sessionId: 's1', title: '迁移第一阶段',
    })
  })

  it('keeps a session whose directory is gone instead of dropping it', () => {
    // The host still lists it; a roll-up that showed less than the host would
    // have no way to explain the difference.
    expect(map().map(s => s.sessionId)).toContain('s9')
  })

  it('puts such a session in the ungrouped bucket rather than under a workspace', () => {
    // Putting it under a real workspace would imply it belongs to a directory
    // that is not there.
    expect(map().find(s => s.sessionId === 's9')?.projectId).toBe('ungrouped')
  })

  it('leaves out an archived session', () => {
    expect(map().map(s => s.sessionId)).not.toContain('s8')
  })

  it('gives a session with no title something readable', () => {
    expect(map().find(s => s.sessionId === 's2')?.title.length).toBeGreaterThan(0)
  })

  it('gives every session a distinct entry when two workspaces claim it', () => {
    // A session listed under two workspaces would appear twice in the roll-up,
    // and clicking either would look like two different conversations.
    const shared: WorkspaceLike[] = [
      { workspaceId: 'w1', title: 'A', path: '/a', sessionIds: ['s1'] },
      { workspaceId: 'w2', title: 'B', path: '/b', sessionIds: ['s1'] },
    ]
    const entries = sessionsFromWorkspaces(shared, { sessions: SESSIONS })
      .filter(s => s.sessionId === 's1')
    expect(entries).toHaveLength(1)
  })

  it('lists nothing when the host reports no sessions', () => {
    expect(sessionsFromWorkspaces(WORKSPACES, { sessions: [] })).toEqual([])
  })

  it('skips a workspace entry that names no title or id', () => {
    // A half-built workspace must not become a group with nothing in it.
    // With no usable workspace, every session the host still lists belongs in
    // the ungrouped bucket — the point is that none of them is lost.
    const broken: WorkspaceLike[] = [{ workspaceId: '', title: '', path: '', sessionIds: [] }]
    const entries = sessionsFromWorkspaces(broken, { sessions: SESSIONS })
    expect(new Set(entries.map(s => s.projectId))).toEqual(new Set(['ungrouped']))
    expect(entries.map(s => s.sessionId).sort()).toEqual(['s1', 's2', 's3', 's9'])
  })

  it('carries the workspace path so a group can show where it lives', () => {
    const group = sessionsFromWorkspaces(WORKSPACES, { sessions: SESSIONS })
    expect(group.find(s => s.sessionId === 's1')?.projectPath).toBe('/src/threadharbor')
  })

  it('shows archived sessions when asked to', () => {
    expect(map({ includeArchived: true }).map(s => s.sessionId)).toContain('s8')
  })
})