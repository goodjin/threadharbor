/**
 * The same-origin channel that carries announcements between tabs.
 *
 * `BroadcastChannel` is used when available because it never touches storage —
 * unlike a `localStorage` fallback, an announcement cannot outlive the tab that
 * made it, so a crash cannot leave a stale host behind in storage.
 */

import type { FederationBus } from './federation.ts'

/** Build a bus over the browser's cross-tab channel. */
export function browserChannel(name: string): FederationBus {
  if (typeof BroadcastChannel === 'undefined') {
    // Without it there is no cross-tab roll-up, but the single host this tab
    // represents must still work. A no-op bus keeps that path intact.
    return { post: () => {}, subscribe: () => {} }
  }
  const channel = new BroadcastChannel(name)
  return {
    post: message => { channel.postMessage(message) },
    subscribe: listener => {
      channel.onmessage = event => { listener(event.data) }
    },
  }
}
