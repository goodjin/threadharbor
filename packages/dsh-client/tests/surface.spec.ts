/**
 * The glue between DSH's browser plugin and the roll-up.
 *
 * Owns the lifecycle — start the federation, keep the view fed, tear both down
 * when the plugin unloads — and hands a plain container to whoever draws it. It
 * deliberately does not render into DSH's slot system itself: that takes a JSX
 * component against their runtime, which is the one part of this that could not
 * be written and checked from here. The container and the renderer are both
 * ready for it.
 */

import { describe, expect, it } from 'vitest'
import { mountRollUpSurface, type RollUpSurfacePorts } from '../src/surface.ts'
import { startRollUpSection } from '../src/rollup-section.ts'
import { storageIdentitySettings } from '../src/settings-source.ts'
import type { FederationBus } from '@threadharbor/dsh-host-federation'

function ports(view = { hosts: [], empty: true, totalSessions: 0 }) {
  const published: number[] = []
  const mounted: { render(): void; dispose(): void }[] = []
  const list: RollUpSurfacePorts = {
    read: () => view,
    federation: {
      rollUp: () => view,
      identity: () => ({ hostId: 'alpha', hostTitle: 'Studio', derived: false }),
      publishSessions: () => { published.push(1) },
      tick: () => {},
      dispose: () => {},
    },
    mount(container, read) {
      const handle = { render: () => {}, dispose: () => {} }
      mounted.push(handle)
      void container
      void read
      return handle
    },
  }
  return { list, published, mounted }
}

describe('mountRollUpSurface', () => {
  it('mounts the view and says what this host holds', () => {
    // Otherwise this tab's own row is empty in every other tab, and a roll-up
    // that never hears from you looks like a roll-up that is broken.
    const { list, published, mounted } = ports()
    const surface = mountRollUpSurface(list)
    expect(mounted).toHaveLength(1)
    expect(published.length).toBeGreaterThan(0)
    surface.dispose()
  })

  it('says who it is', () => {
    const { list } = ports()
    expect(mountRollUpSurface(list).identity().hostId).toBe('alpha')
    mountRollUpSurface(list).dispose()
  })

  it('redraws when the roll-up changes', () => {
    let renders = 0
    const { list } = ports()
    const surface = mountRollUpSurface({
      ...list,
      mount: (_container, read) => { void read; return { render: () => { renders += 1 }, dispose: () => {} } },
    })
    const before = renders
    surface.refresh()
    expect(renders).toBeGreaterThan(before)
    surface.dispose()
  })

  it('releases the view and the federation together', () => {
    // A heartbeat left running after the plugin unloads would keep announcing a
    // host nobody is listening for.
    let disposedView = false
    let disposedFederation = false
    const surface = mountRollUpSurface({
      read: () => ({ hosts: [], empty: true, totalSessions: 0 }),
      federation: {
        rollUp: () => ({ hosts: [], empty: true, totalSessions: 0 }),
        identity: () => ({ hostId: 'alpha', hostTitle: 'Studio', derived: false }),
        publishSessions: () => {}, tick: () => {},
        dispose: () => { disposedFederation = true },
      },
      mount: () => ({ render: () => {}, dispose: () => { disposedView = true } }),
    })
    surface.dispose()
    expect(disposedView).toBe(true)
    expect(disposedFederation).toBe(true)
  })

  it('does nothing twice over after it is disposed', () => {
    const { list, published } = ports()
    const surface = mountRollUpSurface(list)
    const before = published.length
    surface.dispose()
    surface.refresh()
    surface.dispose()
    expect(published).toHaveLength(before)
  })
})

/** The pieces a section test needs, all fake where the browser would be real. */
function sectionDeps(overrides: {
  bus?: FederationBus
} = {}) {
  const stored = new Map<string, string>()
  const posted: { kind: string; hostId: string }[] = []
  const warnings: string[] = []
  const timers: { handle: number; handler: () => void }[] = []
  let nextHandle = 1
  const bus: FederationBus = overrides.bus ?? {
    post: message => { posted.push(message as { kind: string; hostId: string }) },
    subscribe: () => () => {},
  }
  return {
    deps: {
      settings: storageIdentitySettings({
        getItem: key => stored.get(key) ?? null,
        setItem: (key, value) => { stored.set(key, value) },
      }),
      storage: {
        get: key => stored.get(key),
        set: (key, value) => { stored.set(key, JSON.stringify(value)) },
      },
      sessions: () => [],
      sourceNotes: () => ['会话来源未接：浏览器侧拿不到 DSH 的会话列表。'],
      bus,
      setInterval: (handler: () => void) => {
        const handle = nextHandle++
        timers.push({ handle, handler })
        return handle
      },
      clearInterval: handle => {
        const index = timers.findIndex(timer => timer.handle === handle)
        if (index !== -1) timers.splice(index, 1)
      },
      report: message => { warnings.push(message) },
      heartbeatMs: 10_000,
      staleMs: 30_000,
    },
    posted,
    warnings,
    /** Fire every live heartbeat, the way the page's clock would. */
    beat: () => { for (const timer of [...timers]) timer.handler() },
    liveTimers: () => timers.length,
  }
}

describe('面板里的汇总区块', () => {
  it('起得来：有元素，通道上按派生身份打过招呼并发布过会话', () => {
    const { deps, posted } = sectionDeps()
    const section = startRollUpSection(deps)
    expect(section.element().tagName.toLowerCase()).toBe('div')
    expect(section.identity().derived).toBe(true)
    expect(posted.map(message => message.kind)).toEqual(['hello', 'sessions'])
    section.dispose()
  })

  it('汇总真的画进了元素里（这台机器的行在，只是没有会话可列）', () => {
    const { deps } = sectionDeps()
    const section = startRollUpSection(deps)
    const drawn = section.element()
    expect(drawn.querySelector('[data-rollup]')).not.toBeNull()
    expect(drawn.textContent).toContain('本机还没有会话。')
    section.dispose()
  })

  it('把会话来源的缺失如实写在界面上，而不是装作一切正常', () => {
    const { deps } = sectionDeps()
    const section = startRollUpSection(deps)
    expect(section.notices().some(notice => notice.includes('会话来源未接'))).toBe(true)
    section.dispose()
  })

  it('同源限制也写在界面上：别的机器不在这个频道里', () => {
    const { deps } = sectionDeps()
    const section = startRollUpSection(deps)
    expect(section.notices().some(notice => notice.includes('同源'))).toBe(true)
    section.dispose()
  })

  it('改身份会写设置、旧身份道别、新身份重新打招呼', () => {
    const { deps, posted } = sectionDeps()
    const section = startRollUpSection(deps)
    const derivedId = section.identity().hostId
    section.setIdentity({ hostId: 'studio', hostTitle: '工作室' })
    expect(section.identity()).toEqual({ hostId: 'studio', hostTitle: '工作室', derived: false })
    const kinds = posted.map(message => `${message.kind}:${message.hostId}`)
    expect(kinds).toContain(`bye:${derivedId}`)
    expect(kinds).toContain('hello:studio')
    section.dispose()
  })

  it('配置过的身份在重启后保持', () => {
    const { deps } = sectionDeps()
    const section = startRollUpSection(deps)
    section.setIdentity({ hostId: 'studio' })
    section.dispose()
    const reopened = startRollUpSection(deps)
    expect(reopened.identity().hostId).toBe('studio')
    reopened.dispose()
  })

  it('dispose 收掉心跳，之后不再向通道发任何消息', () => {
    const { deps, posted, liveTimers } = sectionDeps()
    const section = startRollUpSection(deps)
    expect(liveTimers()).toBe(1)
    section.dispose()
    expect(liveTimers()).toBe(0)
    const before = posted.length
    section.dispose()
    expect(posted).toHaveLength(before)
  })

  it('会话来源给得出数据时，自己的行就有内容', () => {
    const stored = new Map<string, string>()
    const posted: { kind: string }[] = []
    const section = startRollUpSection({
      ...sectionDeps().deps,
      sessions: () => [{ projectId: 'p1', sessionId: 's1', title: '修登录页' }],
      bus: {
        post: message => { posted.push(message as { kind: string }) },
        subscribe: () => () => {},
      },
      settings: storageIdentitySettings({
        getItem: key => stored.get(key) ?? null,
        setItem: (key, value) => { stored.set(key, value) },
      }),
    })
    section.setIdentity({ hostId: 'studio' })
    expect(section.element().textContent).toContain('修登录页')
    section.dispose()
  })
})