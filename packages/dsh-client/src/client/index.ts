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
 * the host → project → session tree (fed by DSH's own workspace and session
 * projections — the same sources the stock sidebar reads), this host's agent
 * probes, and the host registry whose settings source this panel is.
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
// Type-only: these two merge `workspaces` and `sessions` into the Context
// interface — the projections this panel's tree reads, typed at the same
// boundary DSH's own sidebar reads them.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime, SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { openSessionGateway } from '../gateway.ts'
import type { GatewayOpening } from '../gateway.ts'
import type { AgentDescriptor, GatewayResult, SessionGateway } from '../gateway.ts'
import { runSessionProbe } from '../probe.ts'
import type { ProbeOutcome } from '../probe.ts'
import { layeredIdentitySettings } from '../settings-source.ts'
import { buildHostSessions, readSessionSources } from '../session-source.ts'
import type { SessionRead } from '../session-source.ts'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import { startRollUpSection } from '../rollup-section.ts'
import type { SectionSession } from '../rollup-section.ts'
import { AgentPanel } from '../panel.tsx'
import type { AgentListPort, AgentPanelProps, ProbeStarter } from '../panel.tsx'
import { createElement } from 'react'

/** Required browser services. The remote namespace is the gateway's whole door
 *  to the host: without declaring it here, the context refuses every read of it
 *  with 「cannot get property without inject」, and the panel reports the host
 *  as having no remote services at all. `workspaces` and `sessions` are the
 *  same story — the workspace and session projections this panel's tree reads;
 *  undeclared, every read throws, and the tree stays empty behind a note that
 *  blames a missing service. */
export const inject = ['slots', 'remote', 'workspaces', 'sessions']

export { mountRollUpSurface } from '../surface.ts'
export type { FederationPort, RollUpSurface, RollUpSurfacePorts } from '../surface.ts'
export { RollUpPanel } from './RollUpPanel.tsx'
// The panel's pieces are one published surface: the verify-build step reads
// every export under src/client and requires it in the built artifact, and a
// name that only tests import would silently drop out of the bundle.
export { describeVerdict } from '../verdict.ts'
export type { VerdictDisplay, VerdictTone } from '../verdict.ts'
export { openSessionGateway } from '../gateway.ts'
export type { AgentDescriptor, GatewayOpening, GatewayResult, SessionGateway } from '../gateway.ts'
export { runSessionProbe } from '../probe.ts'
export type { ProbeOutcome, ProbeRunOptions } from '../probe.ts'
export {
  IDENTITY_STORAGE_KEY,
  IDENTITY_TAB_STORAGE_KEY,
  layeredIdentitySettings,
  storageIdentitySettings,
} from '../settings-source.ts'
export type { ConfiguredIdentity, IdentitySettings, IdentityStorage } from '../settings-source.ts'
export { buildHostSessions, readSessionSources } from '../session-source.ts'
export type { SessionRead, SessionListSource, SourceSession, WorkspaceListSource } from '../session-source.ts'
export { startRollUpSection } from '../rollup-section.ts'
export type { RollUpSection, RollUpSectionDeps, SectionSession } from '../rollup-section.ts'
export { AgentPanel, AgentRow, runProbe } from '../panel.tsx'
export type { AgentListPort, AgentPanelProps, HostRegistryPort, ProbeRunState, ProbeStarter } from '../panel.tsx'

/** Shared identity of the sidebar entry and the body it mounts. */
const PANEL_ID = 'threadharbor-rollup'
const PANEL_LABEL = '各主机'
/** Row order in the global panel list; above 100 sits below DSH's own rows. */
const PANEL_ORDER = 100
/** How often this tab re-announces itself, and how long silence means gone. */
const HEARTBEAT_MS = 10_000
const STALE_MS = 30_000

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
  /**
   * Service reads through the context proxy — how DSH's own client packages
   * reach sibling services (`ctx.workspaces.list`, `ctx.sessions.list`).
   * Both are declared in this plugin's `inject`, so the reads resolve; a
   * context that has not granted one yet throws, which callers treat as
   * "not yet". Declared `unknown` here: the values cross a dynamic boundary
   * and are narrowed by predicates before use, never trusted as-is.
   */
  readonly workspaces: unknown
  readonly sessions: unknown
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
 * The gateway is opened per reload, not once at mount: the host's remote
 * services are provided by other client packages that may still be arriving
 * when this module applies, and a gateway captured too early would report the
 * host as missing services it actually has. A missing read retries a few times
 * across a short window before it gives up and names what is missing.
 * @param openGateway - opens the gateway now, against the current graph.
 * @param delay - waits between retries; injected so tests stay instant.
 * @returns the port the panel renders from.
 */
export function agentListPort(
  openGateway: () => GatewayOpening,
  delay: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) }),
): AgentListPort {
  let agents: readonly AgentDescriptor[] = []
  const read = async (): Promise<GatewayResult<readonly AgentDescriptor[]>> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const opening = openGateway()
        const list = opening.gateway?.listAgents ?? opening.listAgents
        if (list !== undefined) return await list()
      } catch {
        // A context that has not granted the namespace yet throws on read;
        // that is "not yet", not "never" — retry.
      }
      await delay(1500)
    }
    try {
      const opening = openGateway()
      const list = opening.gateway?.listAgents ?? opening.listAgents
      if (list !== undefined) return await list()
      return {
        ok: false as const,
        error: { code: 'gateway/missing', message: `主机服务缺失：${opening.missing.join('、')}` },
      }
    } catch (error) {
      return {
        ok: false as const,
        error: { code: 'gateway/missing', message: `主机服务未就绪：${String(error)}` },
      }
    }
  }
  return {
    current: () => agents,
    reload: async () => {
      const result = await read()
      if (result.ok) agents = result.value
      return result
    },
  }
}

/**
 * The probe as the panel triggers it: one preset id in, one outcome out.
 * The gateway is opened at click time for the same reason the list is: what
 * the host provides may settle after mount.
 * @param openGateway - opens the gateway now, against the current graph.
 * @returns the starter the panel rows call.
 */
export function panelProbe(openGateway: () => GatewayOpening): ProbeStarter {
  return presetId => {
    let opening: GatewayOpening
    try {
      opening = openGateway()
    } catch (error) {
      return Promise.resolve({ verdict: { kind: 'unreachable', reason: `主机服务未就绪：${String(error)}` } })
    }
    return opening.gateway === undefined
      ? Promise.resolve({ verdict: { kind: 'unreachable', reason: `主机服务缺失：${opening.missing.join('、')}` } })
      : runSessionProbe(opening.gateway, presetId)
  }
}

/**
 * This host's session source, read from DSH's own client projections.
 *
 * The services are read per call, not captured at apply time: like the remote
 * namespaces, the workspace and session controllers may still be arriving, and
 * a source captured too early would freeze the tree at "missing" forever.
 * @param ctx - the page's context.
 * @returns the reader the section publishes through.
 */
export function hostSessionSource(ctx: ClientPanelContext): {
  sessions(): readonly SectionSession[]
  sourceNotes(): readonly string[]
} {
  let lastRead: SessionRead | undefined
  const read = (): SessionRead => {
    const { workspaces, sessions } = readSessionSources(ctx)
    return buildHostSessions(workspaces, sessions)
  }
  return {
    sessions: () => {
      lastRead = read()
      return lastRead.ok
        ? lastRead.sessions.map(row => ({
            projectId: row.projectId,
            sessionId: row.sessionId,
            title: row.title,
            projectTitle: row.projectTitle,
          }))
        : []
    },
    sourceNotes: () => {
      // Re-read only when nothing was read yet, so the note matches the rows
      // actually published instead of drifting ahead of them.
      if (lastRead === undefined) lastRead = read()
      return lastRead.ok ? [] : [lastRead.note]
    },
  }
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
 * namespaces are missing, the panel still mounts and says what is missing; the
 * session source names what it could not read, on screen, per host.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  applyToClientPanel(ctx)
}

/** The same wiring, typed by the narrow face the panel actually uses. */
function applyToClientPanel(ctx: ClientPanelContext): void {
  const log = ctx.logger('threadharbor-client')
  // Identity is layered: this tab's claim (sessionStorage) outranks the
  // origin's default (localStorage), so two tabs of one DSH can claim two
  // hosts without collapsing on the next reload.
  const settings = layeredIdentitySettings(window.sessionStorage, window.localStorage)
  const sessions = hostSessionSource(ctx)
  const section = startRollUpSection({
    settings,
    storage: browserStorage(),
    sessions: sessions.sessions,
    sourceNotes: sessions.sourceNotes,
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

  // Live sources republish: a session opened or closed here reaches the other
  // tabs on the source's own change, not on the next heartbeat. The shapes
  // were validated in readSessionSources, so subscribe is either absent or a
  // real bound function.
  const { workspaces, sessions: sessionList } = readSessionSources(ctx)
  for (const source of [workspaces, sessionList]) {
    const subscribe = source?.subscribe
    if (subscribe === undefined) continue
    try {
      const detach = subscribe(() => { section.republish() })
      ctx.effect(() => () => { detach() }, 'threadharbor: session source subscription')
    } catch (error) {
      log.warn(`session source subscription failed: ${String(error)} — the heartbeat still republishes`)
    }
  }

  const openGateway = (): GatewayOpening => openSessionGateway(ctx)
  // A mount-time read, purely for the self-report: what the host provides may
  // settle later, so absence here is a log line, never a functional gate.
  const mountOpening = openGateway()
  if (mountOpening.gateway === undefined) {
    log.warn(`probe unavailable at mount: missing host services [${mountOpening.missing.join(', ')}] — the panel mounts, opens the gateway per use, and says so on screen`)
  }
  const face: AgentPanelProps = {
    agents: agentListPort(openGateway),
    probe: panelProbe(openGateway),
    rollUp: section,
    registry: hostRegistry(browserJsonStorage()),
    listenStorage: handler => {
      window.addEventListener('storage', handler)
      return () => { window.removeEventListener('storage', handler) }
    },
  }
  registerPanelSlots(ctx.slots, face)

  // Self-report at mount. This panel is easy to mistake for a plugin that
  // never loaded; these lines are how anyone can tell the difference.
  const identity = section.identity()
  log.info(`panel registered: id=${PANEL_ID}, slots=main+sidebar.panellist, order=${PANEL_ORDER}`)
  log.info(`probe gateway: ${mountOpening.gateway === undefined ? `not open at mount (missing ${mountOpening.missing.join(', ')}); retried per use` : 'open'}`)
  log.info(`roll-up identity: ${identity.hostId}${identity.derived ? ' (derived from page origin; configure it in the panel)' : ''}; session source: DSH workspace/session projections, failures said on screen`)
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

/** localStorage behind the shape the federation announcements read. */
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

/** localStorage behind the registry's read/write face. */
function browserJsonStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  return {
    getItem: key => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    setItem: (key, value) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // A full or blocked storage must not stop the panel; the registry
        // re-reads on the next action.
      }
    },
  }
}
