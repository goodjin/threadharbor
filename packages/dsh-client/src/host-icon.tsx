import { createElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Row order in the sidebar's global panel list: 100 is the hosts section,
 * 101 the phone pairing. The host icon follows the pairing icon.
 */
export const HOST_ICON_PANEL_ORDER = 102

/**
 * The hosts icon in the sidebar's panel row.
 *
 * It is a picture, not a control: the sidebar draws the whole row as a button
 * and that button is what switches the main column to the hosts panel. A
 * click handler here would nest a button inside the sidebar's button, so the
 * icon carries the `data-host-switcher` marker instead — that is how the
 * gateway's injected "back to this machine" entry knows a page already has a
 * host icon of its own.
 */
export function HostIcon(props: PropsRuntime<'sidebar.panellist'>): ReturnType<typeof createElement> {
  return createElement(
    'svg',
    {
      width: props.size,
      height: props.size,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      'data-host-switcher': '',
      style: { opacity: props.active ? 1 : 0.75 },
    },
    createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 8, rx: 1.5, stroke: 'currentColor' }),
    createElement('line', { x1: 5, y1: 13.5, x2: 11, y2: 13.5, stroke: 'currentColor', strokeLinecap: 'round' }),
  )
}
