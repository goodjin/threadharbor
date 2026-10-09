/**
 * Settings that belong to one host.
 *
 * With one tab per host, a single shared key means whichever host the user
 * visits last overwrites the others. Each host therefore gets its own slot,
 * and reading one host's settings must never show another's — a page that
 * shows host A's settings while connected to host B is worse than no settings.
 */

import { describe, expect, it } from 'vitest'
import { hostScopedSettings } from '../src/settings.ts'
import type { SettingStorage } from '../src/settings.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  const storage: SettingStorage = {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
  }
  return { storage, map }
}

/** Widened on purpose: a frozen literal would pin the shape to these values. */
const DEFAULTS: { theme: string; columns: number } = Object.freeze({ theme: 'dark', columns: 2 })

describe('hostScopedSettings', () => {
  it('starts from the defaults for a host with nothing stored', () => {
    const { storage } = fakeStorage()
    expect(hostScopedSettings('alpha', storage, DEFAULTS).read()).toEqual(DEFAULTS)
  })

  it('keeps one host’s settings out of another host’s', () => {
    const { storage } = fakeStorage()
    hostScopedSettings('alpha', storage, DEFAULTS).write({ theme: 'light', columns: 3 })
    expect(hostScopedSettings('beta', storage, DEFAULTS).read()).toEqual(DEFAULTS)
  })

  it('reads back what it wrote for the same host', () => {
    const { storage } = fakeStorage()
    hostScopedSettings('alpha', storage, DEFAULTS).write({ theme: 'light', columns: 3 })
    expect(hostScopedSettings('alpha', storage, DEFAULTS).read()).toEqual({ theme: 'light', columns: 3 })
  })

  it('falls back to defaults when the stored value is not readable', () => {
    // Corrupt storage must not leave a host permanently broken.
    const { storage } = fakeStorage({ 'dsh.host-settings.alpha': '{not json' })
    expect(hostScopedSettings('alpha', storage, DEFAULTS).read()).toEqual(DEFAULTS)
  })

  it('fills in individual defaults for a partially stored value', () => {
    const { storage } = fakeStorage({ 'dsh.host-settings.alpha': JSON.stringify({ theme: 'light' }) })
    expect(hostScopedSettings('alpha', storage, DEFAULTS).read()).toEqual({ theme: 'light', columns: 2 })
  })

  it('keeps hosts apart even when their ids share a prefix', () => {
    // `alpha` must not read `alpha-2`'s slot.
    const { storage } = fakeStorage()
    hostScopedSettings('alpha-2', storage, DEFAULTS).write({ theme: 'light', columns: 9 })
    expect(hostScopedSettings('alpha', storage, DEFAULTS).read()).toEqual(DEFAULTS)
  })

  it('tells one host when its own settings changed', () => {
    const { storage } = fakeStorage()
    const alpha = hostScopedSettings('alpha', storage, DEFAULTS)
    const seen: number[] = []
    alpha.subscribe(value => { seen.push(value.columns) })

    alpha.write({ theme: 'light', columns: 4 })
    expect(seen).toEqual([4])
  })

  it('does not tell a host about another host’s change', () => {
    const { storage } = fakeStorage()
    const alpha = hostScopedSettings('alpha', storage, DEFAULTS)
    const seen: unknown[] = []
    alpha.subscribe(value => { seen.push(value) })

    hostScopedSettings('beta', storage, DEFAULTS).write({ theme: 'light', columns: 4 })
    expect(seen).toEqual([])
  })

  it('ignores a stored value of the wrong shape', () => {
    const { storage } = fakeStorage({ 'dsh.host-settings.alpha': JSON.stringify(['a', 'b']) })
    expect(hostScopedSettings('alpha', storage, DEFAULTS).read()).toEqual(DEFAULTS)
  })
})