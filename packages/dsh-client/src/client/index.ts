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
 * What lives here now is one panel, registered into DSH's client slots:
 * an agent probe section on top (the probe walks DSH's own public session calls
 * — see gateway.ts and probe.ts), and the cross-host roll-up — whose settings
 * source this panel is — underneath.
 *
 * There is no restart control here, and that is not an omission: a restart
 * ordered from this page must travel through the channel that is hung. The
 * host-side plugin drops its own dead connections (registry.ts) and closes the
 * connection of any session whose work is stopped (plugin.ts), so the page's
 * job is to measure and to say what it found.
 */

// DSH 0.2 dropped `@deepseek-ai/dsh-client-runtime`: the client context is now
// the ordinary cordis context, and every plugin entry in DSH's own source says
// exactly this. Naming the 0.1 package here type-checked against an interface
// that no longer ships, which is how a plugin came to depend on a DSH that is
// two generations behind it.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls in ui-sidebar's SlotMap merge, which is what makes
// `sidebar.panellist` and `main` visible to the registry. Without it both slot
// names read as typos, which is the one thing a registration must never be.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the renderer contributes `ctx.slots` itself.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime, SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { openSessionGateway } from '../gateway.ts'
import type { AgentDescriptor, GatewayResult, SessionGateway } from '../gateway.ts'
import { runSessionProbe } from '../probe.ts'
import type { ProbeOutcome } from '../probe.ts'
import { storageIdentitySettings } from '../settings-source.ts'
import { startRollUpSection } from '../rollup-section.ts'
import { AgentPanel } from '../panel.tsx'
import type { AgentListPort, AgentPanelProps, ProbeStarter } from '../panel.tsx'
import { createElement } from 'react'

/** Required browser services. */
export const inject = ['slots']

export { mountRollUpSurface } from '../surface.ts'
export type { FederationPort, RollUpSurface, RollUpSurfacePorts } from '../surface.ts'
export { RollUpPanel } from './RollUpPanel.tsx'
// The panel's pieces are one published surface: the verify-build step reads
// every export under src/client and requires it in the built artifact, and a
// name that only tests import would silently drop out of the bundle.
export { describeVerdict } from '../verdict.ts'
export type { VerdictDisplay, VerdictTone } from '../verdict.ts'
export { openSessionGateway } from '../gateway.ts'
export type { AgentDescriptor, GatewayOpening, GatewayResult, SessionGateway, WireEvent } from '../gateway.ts'
export { runSessionProbe } from '../probe.ts'
export type { ProbeOutcome, ProbeRunOptions } from '../probe.ts'
export { IDENTITY_STORAGE_KEY, storageIdentitySettings } from '../settings-source.ts'
export type { ConfiguredIdentity, IdentitySettings, IdentityStorage } from '../settings-source.ts'
export { startRollUpSection } from '../rollup-section.ts'
export type { RollUpSection, RollUpSectionDeps, SectionSession } from '../rollup-section.ts'
export { AgentPanel, AgentRow, runProbe } from '../panel.tsx'
export type { AgentListPort, AgentPanelProps, ProbeRunState, ProbeStarter } from '../panel.tsx'

/** Shared identity of the sidebar entry and the body it mounts. */
const PANEL_ID = 'threadharbor-rollup'
const PANEL_LABEL = '各主机'
/** Row order in the global panel list; above 100 sits below DSH's own rows. */
const PANEL_ORDER = 100
/** How often this tab re-announces itself, and how long silence means gone. */
const HEARTBEAT_MS = 10_000
const STALE_MS = 30_000
/** Why the roll-up's rows may be empty; said on screen, not swallowed. */
const SESSION_SOURCE_NOTE =
  '会话来源未接：本页面拿不到 DSH 的会话列表（会话数据在主机进程里，浏览器侧没有读取接口），所以各主机的行目前是空的。'

/** One effect's worth of cleanup, as the slot host accepts it. */
type SlotEffect = (() => void) | Iterable<() => void, void, void>

/**
 * The narrow slot face this panel registers through: `inject` to wait for a
 * slot's declaration, `register` to land in it. The real `ctx.slots` satisfies
 * this structurally, and the mount tests stand one up over the real SlotCore —
 * which is what makes a wrong slot name, kind, or key a failing test instead
 * of a silently blank page.
 */
export type PanelSlotHost = {
  inject(key: keyof SlotMap & string, callback: () => SlotEffect): () => void
  register: SlotCore['register']
}

/** What apply() needs from the page's context, no more. */
export type ClientPanelContext = {
  logger(name: string): { info(message: string): void; warn(message: string): void }
  effect(callback: () => unknown, name?: string): unknown
  /** Any service name; absent names and absent services both read as undefined. */
  get(name: string): unknown
  slots: PanelSlotHost
}

/**
 * Register the panel: the sidebar row and the main body it opens, sharing one
 * panel id.
 *
 * Both registrations go through `inject`, which waits for the slot's
 * declaration instead of registering into a slot that may not exist yet —
 * `slots.inject` runs the callback synchronously once ui-layout and ui-sidebar
 * have declared their seats. This is the path a previous mount skipped, and
 * the panel came up blank on every load.
 * @param slots - the page's slot registry face.
 * @param face - what the panel body reads.
 */
export function registerPanelSlots(slots: PanelSlotHost, face: AgentPanelProps): void {
  // Both registrations share PANEL_ID: the sidebar row resolves its active
  // state and the main slot addresses its occupant by the same id.
  slots.inject('main', () => slots.register(
    { name: 'main', key: PANEL_ID, inject: () => face },
    AgentPanel,
  ))
  slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: PANEL_LABEL },
    PanelIcon,
  ))
}

/**
 * The agent list as one port over the gateway: a snapshot for the first paint,
 * and a reload that asks the host's model catalog again.
 *
 * When the gateway is absent, reload fails with the missing names instead of
 * pretending the host has no agents.
 * @param opening - what opening the gateway found.
 * @returns the port and the names that were missing, for the panel to say.
 */
export function agentListPort(opening: { readonly gateway: SessionGateway | undefined; readonly missing: readonly string[] }): AgentListPort {
  let agents: readonly AgentDescriptor[] = []
  return {
    current: () => agents,
    reload: async () => {
      if (opening.gateway === undefined) {
        return { ok: false as const, error: { code: 'gateway/missing', message: `主机服务缺失：${opening.missing.join('、')}` } }
      }
      const result = await opening.gateway.listAgents()
      if (result.ok) agents = result.value
      return result
    },
  }
}

/**
 * The probe as the panel triggers it: one preset id in, one outcome out.
 * A missing gateway reads as 连不上 with the missing names — the honest
 * reading of "this page cannot reach the host".
 * @param opening - what opening the gateway found.
 * @returns the starter the panel rows call.
 */
export function panelProbe(opening: { readonly gateway: SessionGateway | undefined; readonly missing: readonly string[] }): ProbeStarter {
  return presetId => opening.gateway === undefined
    ? Promise.resolve({ verdict: { kind: 'unreachable', reason: `主机服务缺失：${opening.missing.join('、')}` } })
    : runSessionProbe(opening.gateway, presetId)
}

/**
 * Register the panel: the sidebar row and the main body it opens, sharing one
 * panel id.
 *
 * Every dependency is real by the time this runs: `ctx.slots` comes from the
 * renderer, and both slot declarations come from ui-layout and ui-sidebar —
 * `slots.inject` waits for the declaration instead of registering into a
 * slot that may not exist yet, which is the failure mode that killed the
 * previous mount of this panel.
 *
 * What this page cannot have is said, not hidden: if the host's remote
 * namespaces are missing, the panel still mounts and says what is missing;
 * the roll-up's session source is likewise not wired (see
 * SESSION_SOURCE_NOTE), and the panel carries that sentence on screen.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  applyToClientPanel(ctx)
}

/** The same wiring, typed by the narrow face the panel actually uses. */
function applyToClientPanel(ctx: ClientPanelContext): void {
  const log = ctx.logger('threadharbor-client')
  const settings = storageIdentitySettings(window.localStorage)
  const section = startRollUpSection({
    settings,
    storage: browserStorage(),
    sessions: () => [],
    sessionSourceNote: SESSION_SOURCE_NOTE,
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: handle => { window.clearInterval(handle) },
    report: message => { log.warn(message) },
    heartbeatMs: HEARTBEAT_MS,
    staleMs: STALE_MS,
  })
  // The heartbeat announces this host for the plugin's lifetime, not just
  // while the panel is open: a tab that never opens the panel would otherwise
  // leave its own row empty in every other tab.
  ctx.effect(() => () => { section.dispose() }, 'threadharbor: roll-up section')

  const opening = openSessionGateway(ctx)
  if (opening.gateway === undefined) {
    log.warn(`probe unavailable: missing host services [${opening.missing.join(', ')}] — the panel mounts and says so`)
  }
  const face: AgentPanelProps = {
    agents: agentListPort(opening),
    probe: panelProbe(opening),
    rollUp: section,
  }
  registerPanelSlots(ctx.slots, face)

  // Self-report at mount. This panel is easy to mistake for a plugin that
  // never loaded; these lines are how anyone can tell the difference.
  const identity = section.identity()
  log.info(`panel registered: id=${PANEL_ID}, slots=main+sidebar.panellist, order=${PANEL_ORDER}`)
  log.info(`probe gateway: ${opening.gateway === undefined ? `unavailable (missing ${opening.missing.join(', ')})` : 'open'}`)
  log.info(`roll-up identity: ${identity.hostId}${identity.derived ? ' (derived from page origin; configure it in the panel)' : ''}; session source: not wired — said on screen`)
}

/** The glyph the sidebar draws. Self-contained so the panel needs no icon set. */
function PanelIcon(props: PropsRuntime<'sidebar.panellist'>): ReturnType<typeof createElement> {
  return createElement(
    'svg',
    {
      width: props.size,
      height: props.size,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      style: { opacity: props.active ? 1 : 0.75 },
    },
    createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 4, rx: 1, stroke: 'currentColor' }),
    createElement('rect', { x: 1.5, y: 9.5, width: 13, height: 4, rx: 1, stroke: 'currentColor' }),
  )
}

/** localStorage behind the shape the federation reads. */
function browserStorage(): { get(key: string): unknown; set(key: string, value: unknown): void } {
  return {
    get: key => {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? undefined : JSON.parse(raw)
      } catch {
        return undefined
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // A full or blocked storage must not stop the roll-up; the channel is
        // what carries the live data and it does not go through here.
      }
    },
  }
}
