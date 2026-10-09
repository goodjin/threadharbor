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

/** Required browser services. */
export const inject = ['slots', 'layout']

export { mountRollUpSurface } from '../surface.ts'
export type { FederationPort, RollUpSurface, RollUpSurfacePorts } from '../surface.ts'

/**
 * Mount the roll-up once layout declares its slot.
 *
 * The slot registry takes a JSX component against DSH's client runtime; the
 * roll-up renders through plain DOM instead, so the surface hands back the
 * element it drew into for that component to place. Writing and checking that
 * component needs a running browser page, which is the one thing this could not
 * do — so the surface is exported and mounted by hand for now rather than
 * registered into the slot system on a guess.
 */
export function apply(ctx: ClientContext): void {
  void ctx
}