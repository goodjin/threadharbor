/**
 * Tying host identity to the roll-up.
 *
 * The page reads its host identity from the host's settings form, and that value
 * can change while the page is open — an operator edits the title, or fixes an
 * id that was wrong. The roll-up then has to re-announce under the new identity;
 * merely swapping the label would leave the old entry present in every other
 * tab and add a second one for the same machine.
 */

import { HostFederation } from './federation.ts'
import type { FederationBus, HostRoll, HostSnapshot, RollUp } from './federation.ts'
import { resolveHostIdentity } from './identity.ts'
import type { HostIdentity, IdentitySources } from './identity.ts'

/** The part of the host's settings form this reads. */
export type IdentityForm = {
  getSnapshot(): { readonly base: unknown }
  subscribe(listener: () => void): () => void
}

/** Everything the page supplies about itself. */
export type SettingsSource = Omit<IdentitySources, 'configuredHostId' | 'configuredHostTitle'> & {
  listSessions?(hostId: string): readonly { projectId: string; sessionId: string; title: string }[]
  heartbeatMs: number
  staleMs: number
  now?(): number
  /** Called when the set of hosts changes, so a view can re-render. */
  onChange?(): void
}

export type HostView = {
  identity(): HostIdentity
  hosts(): readonly HostSnapshot[]
  foreignHosts(): readonly HostSnapshot[]
  rollUp(): RollUp
  /** One heartbeat tick; driven by a timer in the page. */
  tick(): void
  /** Drop hosts that have gone quiet. */
  expire(at: number): void
  dispose(): void
}

export function startHostView(form: IdentityForm, bus: FederationBus, source: SettingsSource): HostView {
  let identity = readIdentity(form, source)
  let federation = open(identity)

  // An id change means a different identity on the channel, so the old one has
  // to be retired before the new one is announced. A title change is not: same
  // machine, same id, and re-announcing would churn every other tab.
  const unsubscribe = form.subscribe(() => {
    const next = readIdentity(form, source)
    if (next.hostId === identity.hostId) {
      identity = next
      return
    }
    federation.dispose()
    identity = next
    federation = open(identity)
  })

  function open(next: HostIdentity): HostFederation {
    const created = new HostFederation(next, bus, {
      staleMs: source.staleMs,
      ...(source.listSessions === undefined ? {} : { listSessions: source.listSessions }),
      ...(source.now === undefined ? {} : { now: source.now }),
      ...(source.onChange === undefined ? {} : { onChange: source.onChange }),
    })
    created.start()
    return created
  }

  return {
    identity: () => identity,
    hosts: () => federation.hosts(),
    foreignHosts: () => federation.foreignHosts(),
    rollUp: () => federation.rollUp(),
    tick: () => { federation.emitHeartbeat() },
    expire: at => { federation.expire(at) },
    dispose: () => {
      unsubscribe()
      federation.dispose()
    },
  }
}

/**
 * Read identity out of the settings snapshot.
 *
 * A host document that cannot be read falls back to a derived identity rather
 * than throwing: taking the page's host view down would be worse than showing a
 * generated name the operator can then fix.
 */
function readIdentity(form: IdentityForm, source: SettingsSource): HostIdentity {
  const base = form.getSnapshot().base
  const record = typeof base === 'object' && base !== null ? (base as Record<string, unknown>) : {}
  return resolveHostIdentity({
    configuredHostId: typeof record['hostId'] === 'string' ? record['hostId'] : undefined,
    configuredHostTitle: typeof record['hostTitle'] === 'string' ? record['hostTitle'] : undefined,
    origin: source.origin,
    pathname: source.pathname,
    userAgent: source.userAgent,
  })
}

/** Re-exported so a page can render the roll-up without a second import. */
export type { HostRoll, RollUp }