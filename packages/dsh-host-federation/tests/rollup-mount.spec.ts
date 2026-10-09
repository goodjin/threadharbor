/**
 * Drawing the roll-up into a container.
 *
 * Plain DOM on purpose: this is the one part of the roll-up that has to survive
 * whatever the surrounding page does, and a hand-built tree is the version that
 * is easiest to read and to check. Re-rendering replaces the container's
 * children wholesale, which is cheap at this size and removes a whole class of
 * "the list still shows yesterday's hosts" bugs.
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

const view = (overrides: Partial<RollUpView> = {}): RollUpView => ({
  empty: false,
  totalSessions: 2,
  hosts: [{
    hostId: 'alpha',
    label: 'Studio',
    self: true,
    lastSeen: 0,
    empty: false,
    projects: [{ projectId: 'p1', label: 'Web', sessions: [session('s1', 'alpha', true), session('s2', 'beta', false)] }],
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

    current = view({ hosts: [{ ...view().hosts[0]!, label: 'Renamed', projects: [] }], totalSessions: 0 })
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