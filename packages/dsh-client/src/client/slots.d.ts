/**
 * The two slots this plugin registers into, declared locally.
 *
 * `sidebar.panellist` and `main` are declared by ui-sidebar, which is not among
 * this package's installable dependencies — DSH supplies it at runtime, but there
 * is no package to take types from. Declaring the shape here is what lets a typo
 * in a slot name fail the build instead of the page. The runtime check is the
 * other half: DSH resolves slots by name, so a wrong name registers nothing and
 * the panel simply does not appear.
 */
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The sidebar's main-panel list: an icon per panel, in the given order. */
    'sidebar.panellist': {
      options: {
        name: 'sidebar.panellist'
        id: string
        order?: number
        label?: string | (() => string)
        locale?: string
      }
      component: (props: { size?: number }) => unknown
    }
    /** The main area; a panel body is mounted under the sidebar entry's id. */
    'main': {
      options: {
        name: 'main'
        key: string
        locale?: string
        inject?: () => Record<string, unknown>
      }
      component: (props: Record<string, unknown>) => unknown
    }
  }
}
