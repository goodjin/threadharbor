import { createElement, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RollUpSection } from './rollup-section.ts'
import type { HostRegistration } from '@goodjin2/dsh-host-federation'
import { gatewayPagePath } from '@goodjin2/dsh-host-federation'
import { NAMESPACE } from './locales.ts'
import styles from './panel.module.css'

/**
 * The sidebar's host switcher: a resident control at the foot of the sidebar
 * (the `sidebar.footer.action` slot) that lists every registered host and
 * switches the whole page to the picked one.
 *
 * Why a switcher here, when the hosts panel already lists them: the panel is
 * reached through the "hosts" sidebar row and lives in the main column — to
 * change machine you click the row, scan a list, pick one. The switcher puts
 * that one tap at the sidebar's foot, always visible. Switching is the same
 * act the panel's "open" does: a whole-page navigate to the host's gateway
 * path, so the picked machine runs its own native sidebar and conversation.
 *
 * The remote (gateway-proxied) page already injects a `#th-host-bar` at its
 * top with the same picker — see host-gateway-path.ts. That bar lives in the
 * *remote* frame; this switcher lives in *this* machine's sidebar. They are
 * complements, not duplicates: the remote frame never shows this sidebar.
 *
 * The icon carries `data-host-switcher` so the injected bar yields to a page
 * that renders its own switcher of this kind (same marker the panel's row
 * icon uses) instead of stacking two pickers.
 */
export type HostSwitcherFace = {
  /** The host roll-up: who is on the channel, who is this machine. */
  readonly rollUp: RollUpSection
  /** The registration list, for the launch URL that decides switchability. */
  readonly registry: { readonly list: () => readonly HostRegistration[] }
  /** Whole-page navigation into another host's gateway; falls back to assign. */
  readonly navigate?: (url: string) => void
  /** Open the hosts panel on its add view (the "＋ add host" entry). */
  readonly openAddHost?: () => void
}

type HostSwitcherProps = PropsLocale<typeof NAMESPACE> & HostSwitcherFace & {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  readonly wide: boolean
}

/** The host id the page is currently showing, from the gateway path; undefined for this machine. */
function currentHostId(): string | undefined {
  // No window in SSR / node tests: nothing is "current" beyond the default.
  if (typeof window === 'undefined') return undefined
  const match = /^\/threadharbor\/gateway\/([^/]+)/.exec(window.location.pathname)
  if (match === null) return undefined
  try { return decodeURIComponent(match[1] ?? '') } catch { return undefined }
}

/** The gateway path to switch to a host, or undefined when it is not switchable yet. */
function switchPath(hostId: string, self: boolean, registration: HostRegistration | undefined): string | undefined {
  if (self) return '/'
  return registration?.launchUrl === undefined ? undefined : gatewayPagePath(hostId)
}

export function HostSwitcher(props: HostSwitcherProps): ReturnType<typeof createElement> {
  const { wide, t } = props
  const [open, setOpen] = useState(false)
  // Bumped on storage events so the menu re-reads the registry; the rows are
  // derived from props on each render, so the bump is what refreshes them.
  const [, setRevision] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = currentHostId()

  // Re-read the registry when storage changes (another tab added/removed a host),
  // so the picker never lists a stale set.
  useEffect(() => {
    const handler = (): void => { setRevision(rev => rev + 1) }
    window.addEventListener('storage', handler)
    return () => { window.removeEventListener('storage', handler) }
  }, [])

  // Click outside closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  const navigate = props.navigate ?? ((url: string): void => { window.location.assign(url) })
  const identity = props.rollUp.identity()
  const hosts = props.rollUp.hosts()
  const registrations = props.registry.list()
  const registrationFor = (hostId: string): HostRegistration | undefined => registrations.find(entry => entry.hostId === hostId)

  const switchTo = (hostId: string, self: boolean): void => {
    setOpen(false)
    const path = switchPath(hostId, self, registrationFor(hostId))
    if (path !== undefined) navigate(path)
  }

  const rows = hosts.map(host => ({
    hostId: host.hostId,
    name: host.hostTitle.trim() === '' ? host.hostId : host.hostTitle,
    self: host.hostId === identity.hostId,
    current: host.hostId === current,
  }))
  // The currently-shown host leads, then this machine, then the rest by id.
  rows.sort((a, b) => {
    const rank = (row: typeof a): number => (row.current ? 0 : row.self ? 1 : 2)
    return rank(a) - rank(b) || a.hostId.localeCompare(b.hostId)
  })

  const addHost = (): void => {
    setOpen(false)
    props.openAddHost?.()
  }

  const triggerLabel = t('switcher.label')

  // The menu is always in the DOM (hidden when closed) so structure tests can
  // assert its rows without driving a click, and screen readers see the items
  // exist. `hidden` + inert tab stops when closed keep it out of the tab order.
  const menu = createElement('div', {
    ref: menuRef,
    className: styles.hostSwitcherMenu,
    role: 'listbox',
    hidden: !open,
    'data-open': open ? '' : undefined,
  },
    rows.map(row => createElement('button', {
      key: row.hostId,
      type: 'button',
      role: 'option',
      className: styles.hostSwitcherItem,
      'aria-selected': row.current ? 'true' : 'false',
      'data-current': row.current ? '' : undefined,
      'data-self': row.self ? '' : undefined,
      tabIndex: open ? 0 : -1,
      onClick: () => { switchTo(row.hostId, row.self) },
    },
      createElement('span', { className: styles.hostSwitcherItemLabel }, row.name),
      row.self ? createElement('span', { className: styles.hostSwitcherItemTag }, t('switcher.local')) : null,
      row.current ? createElement('span', { className: styles.hostSwitcherItemTag }, t('switcher.current')) : null,
    )),
    createElement('div', { className: styles.hostSwitcherSeparator, role: 'separator' }),
    createElement('button', {
      type: 'button',
      className: styles.hostSwitcherItem,
      'data-add': '',
      tabIndex: open ? 0 : -1,
      onClick: addHost,
    }, t('switcher.addHost')),
  )

  return createElement('div', { className: styles.hostSwitcher, 'data-host-switcher': '' },
    createElement('button', {
      type: 'button',
      className: styles.hostSwitcherTrigger,
      'aria-label': triggerLabel,
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      'data-wide': wide ? '' : undefined,
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { className: styles.hostSwitcherIcon, 'aria-hidden': 'true' },
        createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
          createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 8, rx: 1.5, stroke: 'currentColor' }),
          createElement('line', { x1: 5, y1: 13.5, x2: 11, y2: 13.5, stroke: 'currentColor', strokeLinecap: 'round' }),
        ),
      ),
      wide
        ? createElement('span', { className: styles.hostSwitcherTriggerLabel }, triggerLabel)
        : null,
    ),
    menu,
  )
}
