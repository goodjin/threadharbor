import { createElement, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { gatewayPagePath } from '@threadharbor/dsh-host-federation'
import type { HostRegistration } from '@threadharbor/dsh-host-federation'
import type { HostListRow } from './panel.tsx'
import type { HostStatus } from './host-state.ts'
import { sharedHostSwitcherStore } from './host-switcher-store.ts'
import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import styles from './host-switcher.module.css'

/**
 * 一条可切换主机：切换器渲染的行，也是纯函数与 store 交换的最小形状。
 * `path` 对本机是空串（点击回根路径），对远端是网关路径；能否跳转由
 * `launchable` 单独说话，与 `path` 无关——没有打开地址的主机仍出现在
 * 列表里，只是点了不导航。
 */
export type SwitchEntry = {
  readonly hostId: string
  readonly label: string
  readonly self: boolean
  readonly online: boolean
  readonly launchable: boolean
  readonly status: HostStatus
  readonly path: string
}

/**
 * 把主机行合成切换条目：本机排第一，其余按 `rows` 原序；`launchable` 对
 * 本机恒为真，对远端取登记里的 `launchUrl` 是否非空。
 * @param rows - `mergeHostRows` 产出的行。
 * @param registrations - 登记簿原表，用来查 `launchUrl`。
 */
export function switchEntries(
  rows: readonly HostListRow[],
  registrations: readonly HostRegistration[],
): readonly SwitchEntry[] {
  const byId = new Map(registrations.map(registration => [registration.hostId, registration]))
  const toEntry = (row: HostListRow): SwitchEntry => {
    const registration = byId.get(row.hostId)
    const launchable = row.self || (registration?.launchUrl !== undefined && registration.launchUrl !== '')
    return {
      hostId: row.hostId,
      label: row.name,
      self: row.self,
      online: row.online,
      launchable,
      status: row.connection,
      path: row.self ? '' : gatewayPagePath(row.hostId),
    }
  }
  const self = rows.filter(row => row.self)
  const others = rows.filter(row => !row.self)
  return [...self, ...others].map(toEntry)
}

/** 组件的 props：槽位 owner 给的 `wide`，加框架合成（或测试回落）的 `t` 座位。 */
export type HostSwitcherProps = {
  readonly wide: boolean
  readonly t?: RuntimeT
}

/**
 * 侧栏底脚的主机切换器。`wide` 为真时渲染一个可展开的按钮 + 列表：点可用
 * 远端项整页 `window.location.assign` 到网关路径，点本机回根路径，点不可用
 * 项不导航。`wide` 为假（56px 窄轨）时只渲染一个图标按钮，不展开列表。
 * 根元素带 `data-host-switcher`，网关注入方靠它避免在已装本插件的页面上
 * 重复插入回本机入口。
 */
export function HostSwitcher({ wide, t = fallbackT }: HostSwitcherProps): ReactNode {
  const store = sharedHostSwitcherStore()
  const entries = useSyncExternalStore(store.subscribe, store.entries, store.entries)
  const [expanded, setExpanded] = useState(false)

  const open = (entry: SwitchEntry): void => {
    if (!entry.launchable) return
    window.location.assign(entry.path === '' ? '/' : entry.path)
  }

  if (!wide) {
    return (
      <div data-host-switcher className={styles.root}>
        <button
          type="button"
          className={styles.trigger}
          aria-label={t('panel.switch.label')}
          data-host-switcher-trigger
          onClick={() => setExpanded(value => !value)}
        >
          <SwitchIcon />
        </button>
      </div>
    )
  }

  return (
    <div data-host-switcher className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        aria-label={t('panel.switch.label')}
        aria-expanded={expanded}
        data-host-switcher-trigger
        onClick={() => setExpanded(value => !value)}
      >
        <SwitchIcon />
        <span className={styles.triggerLabel}>{t('panel.switch.current')}</span>
      </button>
      {expanded && (
        <ul className={styles.list} data-host-switcher-list>
          {entries.map(entry => {
            const note = entryNote(entry, t)
            return (
              <li key={entry.hostId} className={styles.item}>
                <button
                  type="button"
                  className={styles.row}
                  aria-disabled={entry.launchable ? undefined : 'true'}
                  data-host-switcher-entry={entry.hostId}
                  onClick={() => open(entry)}
                >
                  <span className={styles.rowLabel}>{entry.label}</span>
                  {note !== undefined && <span className={styles.rowNote}>{note}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 行尾的注记：不可用给「未部署 / 没有打开地址」，可用但离线给「离线」，其余给「在这台主机上打开」。 */
function entryNote(entry: SwitchEntry, t: RuntimeT): string | undefined {
  if (entry.self) return undefined
  if (!entry.launchable) {
    return entry.status === 'undeployed' || entry.status === 'stopped' || entry.status === 'unknown'
      ? t('panel.switch.unreachable')
      : t('panel.switch.noLaunchUrl')
  }
  if (!entry.online) return t('panel.switch.offline')
  return t('panel.switch.open')
}

/** 切换图形：左右双向箭头，自绘不依赖图标集。 */
function SwitchIcon(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 5h8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      <path d="m12 5-2-2m2 2-2 2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 11H4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      <path d="m4 11 2-2m-2 2 2 2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
