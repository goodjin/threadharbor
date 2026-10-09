/**
 * The cross-host roll-up, drawn into DSH's sidebar.
 *
 * The drawing is plain DOM rather than React: the grouping and ordering rules are
 * the part worth testing, and they are tested without a browser in `rollup-view`
 * and `rollup-mount`. This component's only job is to own a container, hand it to
 * that renderer, and tear it down when it goes away.
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { mountRollUp, type RollUpMount } from '@threadharbor/dsh-host-federation/rollup-mount'
import { rollUpView } from '@threadharbor/dsh-host-federation/rollup-view'
import type { HostFederationHandle } from '@threadharbor/dsh-host-federation'

export type RollUpPanelProps = {
  /** This tab's federation. Held by the plugin so the panel has no setup to do. */
  federation: HostFederationHandle
  /** Called with the row that was chosen, for the host to act on. */
  onSelect?(target: { sessionId: string; projectId: string; hostId: string }): void
}

/**
 * Render the roll-up.
 * @param props - the federation and the click handler.
 * @returns a container the renderer owns.
 */
export function RollUpPanel({ federation, onSelect }: RollUpPanelProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = host.current
    if (container === null) return undefined
    let mounted: RollUpMount | undefined
    mounted = mountRollUp(container, () => rollUpView(federation.rollUp() as never), {
      ...(onSelect === undefined ? {} : { onSelect }),
    })
    mounted.render()
    return () => {
      // The listener and the timers both outlive the nodes, so this has to be
      // here rather than left to the next render.
      mounted?.dispose()
    }
  }, [federation, onSelect])

  return <div ref={host} className="threadharbor-rollup" data-rollup-panel="" />
}
