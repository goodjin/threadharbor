/**
 * The host list's source: who this tab is, and who else is on the channel.
 *
 * 2026-10-11 用户决定：各主机面板只列主机及其基本信息，不再显示会话与项目
 * （覆盖原「主机 → 项目 → 会话」三层分组，记录见
 * docs/design/dsh-multi-host-migration.md §8.3）。2026-10-14 再次执行：SSH
 * 部署分支曾把会话源、远端会话拉取和左侧会话树整体加回来，用户确认
 * 「这不是原先的设计」，这轮连代码一起撤掉——留下的只有身份解析、心跳
 * 和在场的过期清理。要看某台主机的会话，去那台主机自己的页面。
 *
 * Identity changes restart the federation: the old one says goodbye on
 * dispose, the new one announces under the new identity, and no stale host is
 * left behind in the other tabs.
 */

import { HostFederation, browserChannel, resolveHostIdentity } from '@threadharbor/dsh-host-federation'
import type { FederationBus, HostIdentity, HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { ConfiguredIdentity, IdentitySettings } from './settings-source.ts'
import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** Everything the section needs from the page around it. */
export type RollUpSectionDeps = {
  /** The panel's identity form: what this host is called and where it is kept. */
  settings: IdentitySettings
  /** Cross-tab channel; absent means the section opens a BroadcastChannel. */
  bus?: FederationBus
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
  /** Where failures are said out loud instead of swallowed. */
  report(message: string): void
  heartbeatMs: number
  staleMs: number
  /** Reads the section's notes in the active language; absent falls back to zh. */
  readonly t?: RuntimeT
}

/** The host list, as the panel renders it. */
export type RollUpSection = {
  /** Who this tab currently says it is. */
  identity(): HostIdentity
  /** Every host in sight: this tab, plus whoever is present on the channel. */
  hosts(): readonly HostSnapshot[]
  /** The hostIds currently present on the channel, this tab's included. */
  onlineHostIds(): readonly string[]
  /** Save a new identity; an id change re-announces under the new one. */
  setIdentity(value: ConfiguredIdentity): void
  /**
   * Re-read the identity from settings without writing. The settings can
   * change underneath the section — host-side settings hydrate asynchronously
   * after mount — and the section must take the configured identity the
   * moment it appears, retiring the derived one it started with.
   */
  rereadIdentity(): void
  /** The section's rendered rows; rebuilt per call from the live host list. */
  element(): HTMLElement
  /** Standing notes under the list. */
  notices(): readonly string[]
  /** Stop the heartbeat and say goodbye. */
  dispose(): void
}

/** The channel name one host list shares; one name means one list. */
const CHANNEL_NAME = 'dsh-host-federation'

/**
 * Start the host list section.
 * @param deps - the page-supplied ports; see {@link RollUpSectionDeps}.
 * @returns the section; dispose stops the heartbeat and says goodbye.
 */
export function startRollUpSection(deps: RollUpSectionDeps): RollUpSection {
  let identity = resolveIdentity()
  let federation = open(identity)
  // Announced up front: a tab that only said hello would leave its own row
  // empty in every other tab, and nothing is going to come and ask.
  federation.start()
  const timer = deps.setInterval(() => { beat() }, deps.heartbeatMs)

  function beat(): void {
    // Expiry first: a crashed tab never says goodbye, so silence past the
    // window is the only honest way for it to leave the list — and 「在线」
    // must not be a claim that can never become false.
    try {
      federation.expire(Date.now())
    } catch (error: unknown) {
      deps.report(`host expiry failed: ${messageOf(error)}`)
    }
    try {
      federation.emitHeartbeat()
    } catch (error: unknown) {
      deps.report(`host heartbeat failed: ${messageOf(error)}`)
    }
  }

  function resolveIdentity(): HostIdentity {
    let configured: ConfiguredIdentity
    try {
      configured = deps.settings.read()
    } catch (error: unknown) {
      // A settings read that fails is an ordinary not-configured-yet, not a
      // reason to take the host list down.
      configured = {}
      deps.report(`host settings could not be read: ${messageOf(error)}`)
    }
    return resolveHostIdentity({
      configuredHostId: configured.hostId,
      configuredHostTitle: configured.hostTitle,
      origin: typeof location === 'undefined' ? '' : location.origin,
      pathname: typeof location === 'undefined' ? '/' : location.pathname,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    })
  }

  function open(next: HostIdentity): HostFederation {
    const bus = deps.bus ?? openChannel()
    return new HostFederation(next, bus, { staleMs: deps.staleMs })
  }

  function openChannel(): FederationBus {
    const bus = browserChannel(CHANNEL_NAME)
    // The channel is how other tabs hear about this host at all; a page
    // without one must not look like a working host list that shows nobody.
    if (typeof BroadcastChannel === 'undefined') {
      deps.report('no BroadcastChannel on this page: the cross-tab host list stays empty and other hosts will not appear')
    }
    return bus
  }

  const say = (key: 'panel.rollup.emptySessions' | 'panel.rollup.crossSourceNote'): string =>
    deps.t !== undefined ? deps.t(key) : fallbackT(key)

  return {
    identity: () => identity,
    hosts: () => federation.hosts(),
    onlineHostIds: () => federation.hosts().map(host => host.hostId),
    /**
     * The section's rendered rows, rebuilt per call from the live list: a
     * foreign host that has not reported sessions yet carries the
     * 「还没有会话数据」 note on its row (`[data-host-note]`).
     */
    element: () => {
      const root = document.createElement('div')
      for (const host of federation.hosts()) {
        const row = document.createElement('div')
        row.setAttribute('data-host-row', host.hostId)
        if (!host.self) {
          const note = document.createElement('span')
          note.setAttribute('data-host-note', '')
          note.textContent = say('panel.rollup.emptySessions')
          row.append(note)
        }
        root.append(row)
      }
      return root
    },
    /** Standing notes under the list; today only the cross-source boundary. */
    notices: () => [say('panel.rollup.crossSourceNote')],
    setIdentity: value => {
      deps.settings.write(value)
      applyIdentity()
    },
    rereadIdentity: () => {
      applyIdentity()
    },
    dispose: () => {
      // The timer first: a heartbeat left running after the panel is gone
      // would keep announcing a host nobody is listening for.
      deps.clearInterval(timer)
      federation.dispose()
    },
  }

  /**
   * Take the identity settings now hold, whether because the operator saved
   * one or because the storage gained one behind the section's back (the
   * host-side settings hydrate after mount). An id change is a different
   * identity on the channel, so the old one retires (dispose says bye)
   * before the new one is announced; a same-id rename re-titles in place.
   */
  function applyIdentity(): void {
    const next = resolveIdentity()
    if (next.hostId === identity.hostId) {
      // Same id, new name: re-title in place so the list row (which reads
      // the presence snapshot) shows the saved name at once, and one
      // heartbeat tells other tabs — no bye/hello churn.
      if (next.hostTitle !== identity.hostTitle) {
        federation.renameSelf(next.hostTitle)
      }
      identity = next
      return
    }
    federation.dispose()
    identity = next
    federation = open(identity)
    federation.start()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
