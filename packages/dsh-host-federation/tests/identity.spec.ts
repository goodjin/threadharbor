/**
 * Working out which host this tab is.
 *
 * The load-bearing requirement is stability: two tabs opened on the same machine
 * must resolve to the same id, or the roll-up treats one machine as two and
 * every session under it appears twice. A random or per-tab id would break
 * exactly the case this layer exists to handle.
 */

import { describe, expect, it } from 'vitest'
import { resolveHostIdentity } from '../src/identity.ts'
import type { IdentitySources } from '../src/identity.ts'

const ALPHA = (over: Partial<IdentitySources> = {}): IdentitySources => ({
  configuredHostId: 'alpha',
  configuredHostTitle: 'Alpha box',
  origin: 'http://127.0.0.1:8080',
  pathname: '/',
  userAgent: 'test',
  ...over,
})

describe('resolveHostIdentity', () => {
  it('uses the configured id when there is one', () => {
    expect(resolveHostIdentity(ALPHA()).hostId).toBe('alpha')
  })

  it('uses the configured title', () => {
    expect(resolveHostIdentity(ALPHA()).hostTitle).toBe('Alpha box')
  })

  it('gives two tabs on the same machine the same id', () => {
    // The whole point of the layer. A per-tab id would list one machine twice.
    const one = resolveHostIdentity(ALPHA({ configuredHostId: undefined, configuredHostTitle: undefined }))
    const two = resolveHostIdentity(ALPHA({ configuredHostId: undefined, configuredHostTitle: undefined }))
    expect(one.hostId).toBe(two.hostId)
  })

  it('gives different machines different ids', () => {
    const one = resolveHostIdentity(ALPHA({ configuredHostId: undefined, origin: 'http://a.example:8080' }))
    const two = resolveHostIdentity(ALPHA({ configuredHostId: undefined, origin: 'http://b.example:8080' }))
    expect(one.hostId).not.toBe(two.hostId)
  })

  it('replaces an unusable configured id rather than using it', () => {
    // An empty id would make every unconfigured host collapse into one entry.
    for (const bad of ['', '   ', 'a/b', 'x'.repeat(200)]) {
      const resolved = resolveHostIdentity(ALPHA({ configuredHostId: bad }))
      expect(resolved.hostId.length).toBeGreaterThan(0)
      expect(resolved.hostId).not.toBe(bad.trim())
    }
  })

  it('derives an id that survives a reload', () => {
    // Nothing time-varying may go in: a reload that changed the id would make
    // the host look like it had gone away and come back.
    const first = resolveHostIdentity(ALPHA({ configuredHostId: undefined }))
    const again = resolveHostIdentity(ALPHA({ configuredHostId: undefined }))
    expect(first.hostId).toBe(again.hostId)
  })

  it('falls back to a readable title when none is configured', () => {
    const resolved = resolveHostIdentity(ALPHA({ configuredHostTitle: undefined }))
    expect(resolved.hostTitle.length).toBeGreaterThan(0)
  })

  it('replaces a blank title with something readable', () => {
    expect(resolveHostIdentity(ALPHA({ configuredHostTitle: '  ' })).hostTitle.length).toBeGreaterThan(0)
  })

  it('says the identity is only derived when no id was configured', () => {
    expect(resolveHostIdentity(ALPHA()).derived).toBe(false)
    expect(resolveHostIdentity(ALPHA({ configuredHostId: undefined })).derived).toBe(true)
  })

  it('reports a derived identity even when a configured one was unusable', () => {
    // Otherwise a bad configured id would read as an operator's choice and go
    // unnoticed.
    expect(resolveHostIdentity(ALPHA({ configuredHostId: '' })).derived).toBe(true)
  })

  it('still resolves when everything is missing', () => {
    const bare = resolveHostIdentity({
      configuredHostId: undefined,
      configuredHostTitle: undefined,
      origin: '',
      pathname: '',
      userAgent: '',
    })
    expect(bare.hostId.length).toBeGreaterThan(0)
    expect(bare.hostTitle.length).toBeGreaterThan(0)
  })
})