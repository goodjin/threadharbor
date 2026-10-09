/**
 * The glue between DSH's browser plugin and the roll-up.
 *
 * Owns the lifecycle — start the federation, keep the view fed, tear both down
 * when the plugin unloads — and hands a plain container to whoever draws it.
 * It deliberately does not render into DSH's slot system itself: that takes a
 * JSX component against their runtime, the one part of this that could not be
 * written and checked from here. The container, the renderer and the view model
 * are all ready for it.
 */

import { rollUpView } from '@threadharbor/dsh-host-federation/rollup-view'
import { mountRollUp } from '@threadharbor/dsh-host-federation/rollup-mount'
import type { RollUpMount } from '@threadharbor/dsh-host-federation/rollup-mount'
import type { RollUpView } from '@threadharbor/dsh-host-federation/rollup-view'
import type { HostIdentity } from '@threadharbor/dsh-host-federation'

/** The parts of the federation this surface needs. */
export type FederationPort = {
  rollUp(): { hosts: readonly never[] }
  identity(): HostIdentity
  publishSessions(): void
  tick(): void
  dispose(): void
}

export type RollUpSurfacePorts = {
  /** The view to draw, if the caller already has one. */
  read?(): RollUpView
  federation: FederationPort
  /** Draw the view into a container; defaults to the plain-DOM renderer. */
  mount?(container: HTMLElement, read: () => RollUpView): RollUpMount
  onSelect?(target: { sessionId: string; projectId: string; hostId: string }): void
}

export type RollUpSurface = {
  /** The element the roll-up is drawn into. */
  element(): HTMLElement
  identity(): HostIdentity
  /** Draw the current roll-up again. */
  refresh(): void
  dispose(): void
}

/**
 * Start the roll-up for one tab.
 *
 * Publishing happens immediately: a tab that only said hello would leave its
 * own row empty in every other tab, and nothing is going to come and ask.
 */
export function mountRollUpSurface(ports: RollUpSurfacePorts, container?: HTMLElement): RollUpSurface {
  let disposed = false
  const read = ports.read ?? (() => rollUpView(ports.federation.rollUp()))

  ports.federation.publishSessions()

  // Always has something to draw into. A caller that wants the view on screen
  // passes its own element; one that only wants the lifecycle can read
  // `element` and place it wherever it likes.
  const element = container ?? document.createElement('div')
  const mounted = (ports.mount ?? ((target, source) => mountRollUp(target, source, {
    ...(ports.onSelect === undefined ? {} : { onSelect: ports.onSelect }),
  })))(element, read)
  mounted.render()

  return {
    element: () => element,
    identity: () => ports.federation.identity(),
    refresh: () => {
      // A heartbeat left ticking after the plugin unloads would keep announcing
      // a host nobody is listening for.
      if (disposed) return
      mounted?.render()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      mounted?.dispose()
      ports.federation.dispose()
    },
  }
}
