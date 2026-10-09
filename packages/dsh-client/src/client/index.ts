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

// DSH 0.2 dropped `@deepseek-ai/dsh-client-runtime`: the client context is now
// the ordinary cordis context, and every plugin entry in DSH's own source says
// exactly this. Naming the 0.1 package here type-checked against an interface
// that no longer ships, which is how a plugin came to depend on a DSH that is
// two generations behind it.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls in ui-sidebar's SlotMap merge, which is what makes
// `sidebar.panellist` and `main` visible to the registry. Without it both slot
// names read as typos, which is the one thing a registration must never be.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the renderer contributes `ctx.slots` itself.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
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
 * The roll-up is not mounted yet, and this is a deliberate state.
 *
 * The panel was registered here once and threw on every load: the federation
 * needs a host-settings source, a session source, a clock and a way to report
 * errors, and this entry supplied two of the four. The cast that let it compile
 * hid exactly that, which is why it went unnoticed until a full audit.
 *
 * The library underneath is finished and tested — identity, grouping, the
 * renderer and its lifecycle. What is missing is the assembly: a settings source
 * that reads real configuration instead of a hardcoded placeholder, and a
 * session source fed from DSH's own store. Until both exist there is nothing
 * honest to register, and a panel that throws is worse than no panel.
 *
 * Reinstating it means deleting this comment and calling the federation with all
 * four members, with no cast between them.
 */
export function apply(ctx: ClientContext): void {
  ctx.logger?.info?.('[threadharbor] client loaded; cross-host roll-up not mounted yet')
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