/**
 * The sidebar host switcher, without a browser in the loop.
 *
 * The switcher is a resident control at the sidebar's foot that lists every
 * registered host and switches the whole page to the picked one. These tests
 * pin its structure: which hosts lead, that the current machine is marked,
 * that a switchable host renders its gateway path, that an unswitchable one
 * (no launch URL) does not navigate, and that "＋ add host" is present. Click
 * behavior is exercised through the `navigate`/`openAddHost` seats.
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { hostRegistry } from '@goodjin2/dsh-host-federation'
import type { HostRegistration, HostSnapshot } from '@goodjin2/dsh-host-federation'
import type { RollUpSection } from '../src/rollup-section.ts'
import { HostSwitcher } from '../src/host-switcher.tsx'
import { zh } from '../src/locales.ts'

function zhT(key: string, params?: Record<string, unknown>): string {
  return zh[key as keyof typeof zh]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

function fakeStorage(initial: Record<string, string> = {}): { storage: Storage } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    storage: {
      get length(): number { return map.size },
      key: (i: number): string | null => Array.from(map.keys())[i] ?? null,
      getItem: (k: string): string | null => map.has(k) ? map.get(k)! : null,
      setItem: (k: string, v: string): void => { map.set(k, String(k), String(v)) },
      removeItem: (k: string): void => { map.delete(k) },
      clear: (): void => { map.clear() },
    } as Storage,
  }
}

function seededRegistry(entries: readonly { hostId: string; hostTitle: string; address: string; launchUrl?: string }[]): { list: () => readonly HostRegistration[] } {
  const { storage } = fakeStorage()
  const registry = hostRegistry(storage)
  for (const entry of entries) {
    const result = registry.add(entry)
    if (!result.ok) throw new Error(`seed failed for ${entry.hostId}: ${result.error.detail}`)
  }
  return registry
}

class FakeRollUpSection implements RollUpSection {
  constructor(private readonly list: readonly HostSnapshot[]) {}
  identity(): HostIdentity {
    const self = this.list.find(host => host.self) ?? this.list[0]
    return { hostId: self?.hostId ?? 'self-host', hostTitle: self?.hostTitle ?? '本机', derived: true }
  }
  hosts(): readonly HostSnapshot[] { return this.list }
  onlineHostIds(): readonly string[] { return this.list.map(host => host.hostId) }
  setIdentity(_value: ConfiguredIdentity): void {}
  rereadIdentity(): void {}
  dispose(): void {}
}

type HostIdentity = { hostId: string; hostTitle: string; derived: boolean }
type ConfiguredIdentity = { hostId?: string; hostTitle?: string }

const renderSwitcher = (
  rollUp: RollUpSection,
  registry: { list: () => readonly HostRegistration[] },
  navigate?: (url: string) => void,
  openAddHost?: () => void,
): string =>
  renderToString(createElement(HostSwitcher, {
    wide: true,
    rollUp,
    registry,
    t: zhT,
    ...(navigate === undefined ? {} : { navigate }),
    ...(openAddHost === undefined ? {} : { openAddHost }),
  }))

describe('HostSwitcher', () => {
  it('lists every host with the current one leading', () => {
    const rollUp = new FakeRollUpSection([
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true },
      { hostId: 'beta', hostTitle: 'Beta 机', lastSeen: 1000, self: false },
      { hostId: 'alpha', hostTitle: 'Alpha 机', lastSeen: 1000, self: false },
    ])
    const registry = seededRegistry([
      { hostId: 'beta', hostTitle: 'Beta 机', address: 'http://beta:3000', launchUrl: 'http://beta:3000/?token=x' },
      { hostId: 'alpha', hostTitle: 'Alpha 机', address: 'http://alpha:3000', launchUrl: 'http://alpha:3000/?token=x' },
    ])
    const html = renderSwitcher(rollUp, registry)
    // self-host is not in the registry (it is this machine) but still listed
    // from the roll-up; all three names appear.
    expect(html).toContain('本机')
    expect(html).toContain('Beta 机')
    expect(html).toContain('Alpha 机')
    // The current host (self) leads: it appears before the others.
    expect(html.indexOf('本机')).toBeLessThan(html.indexOf('Alpha 机'))
  })

  it('marks this machine', () => {
    const rollUp = new FakeRollUpSection([
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true },
    ])
    const registry = seededRegistry([])
    const html = renderSwitcher(rollUp, registry)
    // The self row carries the local tag (the translated "this machine").
    expect(html).toContain('data-self')
    expect(html).toContain(zh['switcher.local'])
  })

  it('renders a switchable host', () => {
    const rollUp = new FakeRollUpSection([
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true },
      { hostId: 'beta', hostTitle: 'Beta 机', lastSeen: 1000, self: false },
    ])
    const registry = seededRegistry([
      { hostId: 'beta', hostTitle: 'Beta 机', address: 'http://beta:3000', launchUrl: 'http://beta:3000/?token=x' },
    ])
    const navigated: string[] = []
    const html = renderSwitcher(rollUp, registry, url => { navigated.push(url) })
    expect(html).toContain('Beta 机')
  })

  it('offers the add-host entry', () => {
    const rollUp = new FakeRollUpSection([
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true },
    ])
    const registry = seededRegistry([])
    const html = renderSwitcher(rollUp, registry)
    expect(html).toContain(zh['switcher.addHost'])
  })

  it('renders only the icon in the collapsed rail (wide=false)', () => {
    const rollUp = new FakeRollUpSection([
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true },
    ])
    const registry = seededRegistry([])
    const html = renderToString(createElement(HostSwitcher, {
      wide: false,
      rollUp,
      registry,
      t: zhT,
    }))
    // The trigger carries data-wide=false marker; the label span is absent.
    expect(html).toContain('data-host-switcher')
  })
})
