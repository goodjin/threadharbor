/** Remote-agent browser assembly: object layer plus exclusive layout occupants. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { RemoteAgentStore } from './store.ts'
import { RemoteSidebar, type RemoteSidebarInjected } from './RemoteSidebar.tsx'
import { RemoteConversation, type RemoteConversationInjected } from './RemoteConversation.tsx'

/** Required browser services. */
export const inject = ['slots', 'layout']

/** Register the remote-agent sidebar and conversation once layout declares their slots. */
export function apply(ctx: ClientContext): void {
  const store = new RemoteAgentStore()
  ctx.effect(() => {
    void store.start()
    return () => { store.dispose() }
  }, 'ui-remote-agent: object layer')
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    inject: (): RemoteSidebarInjected => ({
      store,
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
    }),
  }, RemoteSidebar))
  ctx.slots.inject('conversation', () => ctx.slots.register({
    name: 'conversation',
    inject: (): RemoteConversationInjected => ({ store }),
  }, RemoteConversation))
}

export { RemoteAgentStore, parseRemoteAgentState } from './store.ts'
export type { RemoteAgentSnapshot } from './store.ts'
