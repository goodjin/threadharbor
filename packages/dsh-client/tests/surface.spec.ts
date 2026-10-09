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