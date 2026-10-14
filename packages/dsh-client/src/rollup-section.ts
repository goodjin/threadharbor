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
    ...(deps.onSelectSession === undefined ? {} : { onSelect: deps.onSelectSession }),
    mount: (container, read) => mountRollUp(container, read, {
      ...(deps.onSelectSession === undefined ? {} : { onSelect: deps.onSelectSession }),
      hostNote: host => {
        if (host.self) {
          const notes = deps.sourceNotes()
          return notes.length > 0 ? notes.join(' ') : undefined
        }
        return host.empty ? say('panel.rollup.emptySessions') : undefined
      },
    }),
  })
  onChange = () => { surface?.refresh() }

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
    onChange()
  }

  return {
    element: () => surface?.element() ?? document.createElement('div'),
    identity: () => identity,
    notices: () => [
      ...deps.sourceNotes(),
      say('panel.rollup.crossSourceNote'),
    ],
    setIdentity: value => {
      deps.settings.write(value)
      applyIdentity(resolveIdentity())
    },
    rereadIdentity: () => {
      applyIdentity(resolveIdentity())
    },
    hosts: () => federation.hosts(),
    onlineHostIds: () => federation.hosts().map(host => host.hostId),
    republish: () => {
      try {
        federation.publishSessions(deps.sessions())
      } catch (error: unknown) {
        deps.report(`session publish failed: ${messageOf(error)}`)
      }
      onChange()
    },
    dispose: () => {
      // The timer first: a heartbeat left running after the panel is gone
      // would keep announcing a host nobody is listening for.
      deps.clearInterval(timer)
      surface?.dispose()
      federation.dispose()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
