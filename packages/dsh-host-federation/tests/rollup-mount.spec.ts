/**
 * Drawing the roll-up into a container.
 *
 * Plain DOM on purpose: this is the one part of the roll-up that has to survive
 * whatever the surrounding page does, and a hand-built tree is the version that
 * is easiest to read and to check. Re-rendering replaces the container's
 * children wholesale, which is cheap at this size and removes a whole class of
 * "the list still shows yesterday's hosts" bugs.
 *
 * The tree is host → project → session, and the host row is where status lives:
 * a badge, a one-line count, and a folded 说明. These specs pin that hierarchy —
 * a session row must never carry host status, and a host with nothing must say
 * so instead of drawing empty nodes.
 */

import { describe, expect, it } from 'vitest'
import { mountRollUp } from '../src/rollup-mount.ts'
import type { RollUpView } from '../src/rollup-view.ts'

/** A container just complete enough for the renderer. */
function container(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

const session = (sessionId: string, hostId: string, own: boolean) => ({
  sessionId, projectId: 'p1', title: `会话 ${sessionId}`, hostId, own,
})

const project = (label: string, sessions: ReturnType<typeof session>[]) => ({
  projectId: 'p1', label, baseLabel: label, sharedName: false, sessions,
})

const view = (overrides: Partial<RollUpView> = {}): RollUpView => ({
  empty: false,
  totalSessions: 2,
  hosts: [{
    hostId: 'alpha',
    label: 'Studio',
    self: true,
    lastSeen: 0,
    empty: false,
    sessionCount: 2,
    projects: [project('Web', [session('s1', 'alpha', true), session('s2', 'beta', false)])],
  }],
  ...overrides,
})

const text = (root: HTMLElement) => root.textContent ?? ''

describe('mountRollUp', () => {
  it('draws one section per host, with its projects and sessions', () => {
    const root = container()
    mountRollUp(root, () => view())
    expect(text(root)).toContain('Studio')
    expect(text(root)).toContain('Web')
    expect(text(root)).toContain('会话 s1')
  })

  it('puts the status badge on the host row, and only there', () => {
    const root = container()
    mountRollUp(root, () => view())
    const badges = root.querySelectorAll('[data-host-badge]')
    expect(badges.length).toBe(1)
    expect(badges[0]!.getAttribute('data-host-badge')).toBe('self')
    expect(badges[0]!.textContent).toBe('本机')
    // A session row carries a title, not status words.
    const sessionRow = root.querySelector('[data-session="s1"]')!
    expect(sessionRow.textContent).toBe('会话 s1')
  })

  it('summarizes a host in one count line', () => {
    const root = container()
    mountRollUp(root, () => view())
    expect(root.querySelector('[data-host-count]')?.textContent).toBe('1 个项目 · 2 个会话')
  })

  it('folds the host note and id into a details block', () => {
    const root = container()
    mountRollUp(root, () => view({
      hosts: [{ ...view().hosts[0]!, self: false }],
    }), { now: () => 65_000, hostNote: host => host.empty ? '没有会话' : undefined })
    const details = root.querySelector('[data-host-details]')!
    expect(details.querySelector('[data-host-note]')).toBeNull()
    expect(details.querySelector('[data-host-seen]')?.textContent).toContain('alpha')
    expect(details.querySelector('[data-host-seen]')?.textContent).toContain('1 分钟前')
    // The badge reads 在线 for a foreign host.
    expect(root.querySelector('[data-host-badge]')?.getAttribute('data-host-badge')).toBe('online')
  })

  it('gives a self host a details block only when it has something to say', () => {
    const root = container()
    mountRollUp(root, () => view())
    expect(root.querySelector('[data-host-details]')).toBeNull()
    const withNote = container()
    mountRollUp(withNote, () => view(), { hostNote: () => '会话来源失败：原因' })
    expect(withNote.querySelector('[data-host-note]')?.textContent).toBe('会话来源失败：原因')
  })

  it('says a host has nothing instead of drawing empty project nodes', () => {
    const root = container()
    mountRollUp(root, () => view({
      hosts: [{ ...view().hosts[0]!, projects: [], sessionCount: 0, empty: true }],
      totalSessions: 0,
    }))
    expect(root.querySelector('[data-host-empty]')?.textContent).toBe('本机还没有会话。')
    expect(root.querySelector('[data-project-block]')).toBeNull()
  })

  it('shows the qualified label for a shared project name', () => {
    const root = container()
    mountRollUp(root, () => view({
      hosts: [{ ...view().hosts[0]!, projects: [project('Web · Studio', [session('s1', 'alpha', true)])] }],
    }))
    const heading = root.querySelector('[data-project]')!
    expect(heading.textContent).toBe('Web · Studio')
    expect(heading.hasAttribute('data-project-shared')).toBe(false)
    const shared = container()
    mountRollUp(shared, () => view({
      hosts: [{ ...view().hosts[0]!, projects: [{ ...project('Web · Studio', [session('s1', 'alpha', true)]), sharedName: true }] }],
    }))
    expect(shared.querySelector('[data-project]')?.hasAttribute('data-project-shared')).toBe(true)
  })

  it('says so when no host is open anywhere', () => {
    const root = container()
    mountRollUp(root, () => view({ empty: true, hosts: [], totalSessions: 0 }))
    expect(text(root)).not.toBe('')
    expect(root.querySelector('[data-empty]')).not.toBeNull()
  })

  it('carries the ids a click needs on the row itself', () => {
    const root = container()
    mountRollUp(root, () => view())
    const row = root.querySelector('[data-session]')!
    expect(row.getAttribute('data-session')).toBe('s1')
    expect(row.getAttribute('data-host')).toBe('alpha')
    expect(row.getAttribute('data-project')).toBe('p1')
  })

  it('redraws when the view changes', () => {
    // A host that published again must replace what is on screen, not add to it:
    // a closed conversation still listed is the failure that makes a roll-up
    // untrustworthy.
    const root = container()
    let current = view()
    const handle = mountRollUp(root, () => current)
    expect(text(root)).toContain('会话 s1')

    current = view({ hosts: [{ ...view().hosts[0]!, label: 'Renamed', projects: [], sessionCount: 0, empty: true }], totalSessions: 0 })
    handle.render()
    expect(text(root)).toContain('Renamed')
    expect(text(root)).not.toContain('会话 s1')
  })

  it('drops a host that went away entirely', () => {
    const root = container()
    let current = view()
    const handle = mountRollUp(root, () => current)
    current = view({ hosts: [], empty: true, totalSessions: 0 })
    handle.render()
    expect(root.querySelector('[data-host-section]')).toBeNull()
    expect(root.querySelector('[data-empty]')).not.toBeNull()
  })

  it('stops answering clicks once unmounted', () => {
    // The listener outlives the nodes, so a stale click would otherwise resolve
    // against a view that is no longer on screen.
    const root = container()
    const picked: unknown[] = []
    const handle = mountRollUp(root, () => view(), { onSelect: target => picked.push(target) })
    const row = root.querySelector<HTMLElement>('[data-session="s1"]')!
    handle.dispose()
    row.click()
    expect(picked).toEqual([])
  })

  it('reports a session click with the host it lives on', () => {
    const root = container()
    const picked: unknown[] = []
    mountRollUp(root, () => view(), { onSelect: target => picked.push(target) })
    root.querySelector<HTMLElement>('[data-session="s2"]')!.click()
    expect(picked).toEqual([{ sessionId: 's2', projectId: 'p1', hostId: 'beta' }])
  })

  it('marks this tab’s own sessions so the view can style them apart', () => {
    const root = container()
    mountRollUp(root, () => view())
    expect(root.querySelector('[data-session="s1"]')?.getAttribute('data-own')).toBe('true')
    expect(root.querySelector('[data-session="s2"]')?.getAttribute('data-own')).toBe('false')
  })

  it('works with no click handler at all', () => {
    const root = container()
    mountRollUp(root, () => view())
    expect(() => root.querySelector<HTMLElement>('[data-session="s1"]')!.click()).not.toThrow()
  })

  it('empties the container when it is unmounted', () => {
    const root = container()
    const handle = mountRollUp(root, () => view())
    handle.dispose()
    expect(root.children.length).toBe(0)
  })
})
