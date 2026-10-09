/**
 * ThreadHarbor's browser assembly.
 *
 * This used to replace DSH's sidebar and conversation with a surface that spoke
 * to hostd over a WebSocket. That host is gone (migration phase 6): agents run
 * as in-process ACP plugins on the machine serving the page, so their sessions
 * are ordinary DSH sessions and DSH's own sidebar, conversation and model picker
 * already show them correctly — the ACP presets register into the shared model
 * catalog, which is what that picker reads.
 *
 * What is left here is the multi-host roll-up: the sidebar and conversation
 * surfaces belong to DSH, and this plugin only adds the view across hosts.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { applyHostFederation } from '@threadharbor/dsh-host-federation'
import { createElement } from 'react'
import { RollUpPanel } from './RollUpPanel.tsx'

/** Required browser services. */
export const inject = ['slots']

export { mountRollUpSurface } from '../surface.ts'
export type { FederationPort, RollUpSurface, RollUpSurfacePorts } from '../surface.ts'
/** Shared identity of the sidebar entry and the body it mounts. */
const PANEL_ID = 'threadharbor-rollup'
const PANEL_LABEL = '各主机'

export { RollUpPanel } from './RollUpPanel.tsx'

/**
 * Put the roll-up in DSH's sidebar.
 *
 * The panel is registered inside the sidebar slot rather than in place of it, so
 * a deployment that composes no sidebar loses this view and nothing else. The
 * federation starts here, once per tab, and is shared by the panel and anything
 * else that wants to read the roll-up.
 */
export function apply(ctx: ClientContext): void {
  const federation = applyHostFederation(
    { settings: readSettings(), storage: browserStorage() } as never,
    { heartbeatMs: 5_000, staleMs: 30_000 },
  )
  // Said out loud on purpose: on a machine whose cross-tab channel is blocked
  // this panel is simply empty, and "nothing appears" is otherwise
  // indistinguishable from "the plugin was never installed".
  if (federation.foreignHosts().length === 0) {
    ctx.logger?.info?.('[threadharbor] roll-up mounted; no other host has answered yet')
  }
  const face = { federation }

  // The sidebar entry and the body share one panel id: the sidebar draws the
  // button, and selecting it is what mounts the body in the main area.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 100,
      label: () => PANEL_LABEL,
    } as never,
    // Written as createElement: this entry is a `.ts` file, and renaming it
    // would move the built artifact's path for no gain.
    ((props: { size?: number }) => createElement(RollUpIcon, props)) as never,
  ))

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, inject: () => face } as never,
    ((props: object) => createElement(RollUpPanel, { federation, ...props })) as never,
  ))

  ctx.effect(() => () => {
    // A heartbeat left running after unload would keep announcing a host nobody
    // is listening for.
    federation.dispose()
  }, 'threadharbor: roll-up')
}

/** The glyph the sidebar draws. Self-contained so the panel needs no icon set. */
function RollUpIcon({ size = 16 }: { size?: number }): ReturnType<typeof createElement> {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 4, rx: 1, stroke: 'currentColor' }),
    createElement('rect', { x: 1.5, y: 9.5, width: 13, height: 4, rx: 1, stroke: 'currentColor' }),
  )
}

/**
 * This tab's host identity.
 *
 * Unset is normal: a host with no id is still counted and still announced, it
 * just cannot be told apart from another one that also left it unset.
 */
function readSettings(): { get(): { hostId?: string; hostTitle?: string } } {
  return {
    get: () => {
      const configured = { hostId: 'local', hostTitle: '本机' }
      return configured
    },
  }
}

/** localStorage behind the shape the federation reads. */
function browserStorage(): { get(key: string): unknown; set(key: string, value: unknown): void } {
  return {
    get: key => {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? undefined : JSON.parse(raw)
      } catch {
        return undefined
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // A full or blocked storage must not stop the roll-up; the channel is
        // what carries the live data and it does not go through here.
      }
    },
  }
}