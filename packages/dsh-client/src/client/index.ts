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

/** Register the roll-up once layout declares its slot. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    inject: () => ({}),
  }, () => null))
}