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
 * the host list (this host plus whoever announces on the same-origin channel —
 * 2026-10-11 用户决定只列主机，不再读取或显示会话与项目，DSH 的
 * workspace / session 投影也随之不再从这里读), this host's agent probes,
 * and the host registry whose settings source this panel is. One more
 * session-side surface rides here: a switched-away turn's neutral notice and
 * the automatic jump to the session that took over (handover-card.ts). Beside
 * the hosts panel sits a second sidebar section of the same registration face:
 * 手机配对 (pairing-panel.ts), which fetches the mobile pair-url over the
 * same origin and draws its QR — or the configuration guidance when the host
 * has no mobileOrigin. Under the composer rides one more row (quota-pill.ts):
 * GLM 套餐的两枚配额胶囊，读宿主侧 /threadharbor/zcode/quota，只在
 * 当前会话选的模型是 GLM 时出现（2026-10-16 用户拍板）。
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
// Type-only: ui-conversation merges the `uiConversation` service the switched-
// turn notice registers its Chat Definition through, and ui-chat declares the
// `conversation.chat.node` keyed slot that Definition's renderer lands in.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime, SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { openSessionGateway } from '../gateway.ts'
import type { GatewayOpening } from '../gateway.ts'
import type { AgentDescriptor, GatewayResult, SessionGateway } from '../gateway.ts'
import { runSessionProbe } from '../probe.ts'
import type { ProbeOutcome } from '../probe.ts'
import { layeredIdentitySettings, IDENTITY_STORAGE_KEY } from '../settings-source.ts'
import { maybeRegisterSidebarTree } from '../sidebar-tree.ts'
import { registerModelSeat } from '../model-seat.ts'
import { registerSessionIdBar } from '../session-id-bar.ts'
import { createQuotaPoller, registerQuotaDockPills, routeQuotaFetcher } from '../quota-pill.ts'
import { registerInterruptedTurnRecovery } from '../interrupted-turn-recovery.ts'
import { HOST_REGISTRY_KEY, HOST_STORE_ENTRY_ID, TAILSCALE_ERROR_KEY, TAILSCALE_PEERS_KEY, TAILSCALE_REFRESHED_KEY, TAILSCALE_REFRESH_KEY, hostRegistry } from '@threadharbor/dsh-host-federation'
import type { TailscalePeer } from '@threadharbor/dsh-host-federation'
import { startHostStore } from '../host-store.ts'
import type { HostStoreChannel, HostStoreDeps, StoreOp } from '../host-store.ts'
import { startRollUpSection } from '../rollup-section.ts'
import { startPairingSurface } from '../pairing-panel.ts'
import { AgentPanel } from '../panel.tsx'
import type { AgentListPort, AgentPanelBusinessProps, ProbeStarter, TailscalePeersResult, TailscalePort } from '../panel.tsx'
import { registerAgentSwitchHandoverSurface } from '../handover-card.ts'
import { createSwitchProgressStore, startSwitchProgressSurface } from '../switch-progress.ts'
import { NAMESPACE, en, fallbackT, zh } from '../locales.ts'
import type { ClientLocaleKey, RuntimeT } from '../locales.ts'
import { createElement } from 'react'

/** Required browser services. The remote namespace is the gateway's whole door
 *  to the host: without declaring it here, the context refuses every read of it
 *  with 「cannot get property without inject」, and the panel reports the host
 *  as having no remote services at all. `remote.settings` is declared the same
 *  way and for the same reason — the settings channel this panel's registry and
 *  default identity persist through — and declaring it also makes activation
 *  WAIT until api-remotes has mounted that namespace asynchronously, so the
 *  store never comes up memory-only merely for having applied too early.
 *  `uiConversation` and `uiWorkspace` feed the switched-turn notice: the
 *  conversation events register its Chat Definition, the workspace service is
 *  the stock jump-to-session action. `sessions` is the session object layer:
 *  the switch's progress reads the new session's first page through it, so
 *  the panel swaps onto content that is already there. `locale` is the
 *  dictionary registry: this entry registers its namespaces there and the
 *  slot registrations hand the framework-synthesized `t` seat to the
 *  surfaces whose copy they carry. */
/**
 * `remote.session` 的来由不是本面板自己要用它：输入框模型入口的占用者在渲染
 * 时调 `models.directoryFor(sessionId)`，而 cordis 把服务内部用的上下文换成
 * 调用方这份（traceable：side effects bind to caller）。ModelDirectoryResolver
 * 声明的 inject 是 ['sessions','remote','remote.session']，那些读因此落在本入口
 * 头上——少声明一个，真实页面会在占用者里炸（cannot get property
 * "remote.session" without inject），而官方那几处用到它的入口全都声明了它。
 */
export const inject = ['slots', 'remote', 'remote.settings', 'remote.session', 'uiConversation', 'uiWorkspace', 'sessions', 'locale']

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
export { startRollUpSection } from '../rollup-section.ts'
export type { RollUpSection, RollUpSectionDeps } from '../rollup-section.ts'
export { PAIRING_PANEL_ID, PAIRING_PANEL_ORDER, PAIR_URL_PATH, PairingIcon, PairingPanel, createPairingStore, requestPairUrl, startPairingSurface } from '../pairing-panel.ts'
export type { PairingPanelProps, PairingSlotHost, PairingState, PairingStore, PairingStoreWriter, PairingSurface, PairingSurfaceParams, PairQrRenderer, PairUrlOutcome, SameOriginFetch } from '../pairing-panel.ts'
export { mergeHostRows, heartbeatWord, richSegments } from '../panel.tsx'
export type { HostListRow, PanelT } from '../panel.tsx'
export { AgentPanel, AgentRow, runProbe } from '../panel.tsx'
export type { AgentListPort, AgentPanelBusinessProps, AgentPanelProps, HostRegistryPort, ProbeRunState, ProbeStarter } from '../panel.tsx'
export {
  registerAgentSwitchHandoverSurface,
  agentSwitchHandoverDefinition,
  AgentSwitchHandoverCard,
} from '../handover-card.ts'
export type {
  AgentSwitchHandoverData,
  HandoverCardProps,
  HandoverSlotHost,
  HandoverSurfaceContext,
} from '../handover-card.ts'
export {
  SwitchProgressLayer,
  createSwitchProgressStore,
  startSwitchProgressSurface,
} from '../switch-progress.ts'
export type {
  SwitchProgress,
  SwitchProgressActions,
  SwitchProgressContext,
  SwitchProgressLayerProps,
  SwitchProgressPhase,
  SwitchProgressSlotHost,
  SwitchProgressState,
  SwitchProgressStore,
  SwitchProgressSurface,
} from '../switch-progress.ts'

/** Shared identity of the sidebar entry and the body it mounts. */
const PANEL_ID = 'threadharbor-rollup'
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

/** The settings dialog declares its slots in packages this one does not reference. */
type SettingsSlotHost = {
  inject(key: string, callback: () => SlotEffect): () => void
  register(options: {
    name: string
    id?: string
    order?: number
    label?: () => string
    locale?: string
    inject?: () => unknown
  }, component: unknown): () => void
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
 * @param label - the sidebar row's label, re-read per render so it follows the
 * active locale without re-registering (SlotLabel's thunk form).
 */
export function registerPanelSlots(slots: PanelSlotHost, face: AgentPanelBusinessProps, label: () => string): void {
  // The hosts surface lives in the settings dialog as one section (its sidebar
  // row and main-panel seat are gone): `settings.section` is the list the
  // dialog's rail renders from, and `inject` hands the section its business
  // face. `locale` keeps the framework-synthesized `t` seat flowing.
  const settingsSlots = slots as unknown as SettingsSlotHost
  settingsSlots.inject('settings.section', () => settingsSlots.register(
    { name: 'settings.section', id: PANEL_ID, order: PANEL_ORDER, label, locale: NAMESPACE, inject: () => face },
    AgentPanel,
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
 * @param t - reads the failure copy in the active language; absent (tests,
 * no locale service) it falls back to the dictionary's source text.
 * @returns the port the panel renders from.
 */
export function agentListPort(
  openGateway: () => GatewayOpening,
  delay: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) }),
  t?: RuntimeT,
): AgentListPort {
  const say = t ?? fallbackT
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
        error: { code: 'gateway/missing', message: say('panel.gateway.missing', { missing: opening.missing.join(say('panel.facts.onlineIdsSeparator')) }) },
      }
    } catch (error) {
      return {
        ok: false as const,
        error: { code: 'gateway/missing', message: say('panel.gateway.notReady', { error: String(error) }) },
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
 * @param t - reads the failure copy in the active language; absent (tests,
 * no locale service) it falls back to the dictionary's source text.
 * @returns the starter the panel rows call.
 */
export function panelProbe(openGateway: () => GatewayOpening, t?: RuntimeT): ProbeStarter {
  const say = t ?? fallbackT
  return presetId => {
    let opening: GatewayOpening
    try {
      opening = openGateway()
    } catch (error) {
      return Promise.resolve({ verdict: { kind: 'unreachable', reason: say('panel.gateway.notReady', { error: String(error) }) } })
    }
    return opening.gateway === undefined
      ? Promise.resolve({ verdict: { kind: 'unreachable', reason: say('panel.gateway.missing', { missing: opening.missing.join(say('panel.facts.onlineIdsSeparator')) }) } })
      : runSessionProbe(opening.gateway, presetId)
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
 * namespaces are missing, the panel still mounts and says what is missing.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  applyToClientPanel(ctx)
}

/** The same wiring, typed by the narrow face the panel actually uses. */
function applyToClientPanel(ctx: ClientPanelContext): void {
  const log = ctx.logger('threadharbor-client')
  // The dictionaries this plugin owns register with the host's locale service;
  // the slot registrations (progress layer, handover card) declare the
  // namespace, and the framework synthesizes their typed `t` seat from it.
  // The sidebar row's label re-reads through a bound `t` so it follows the
  // active language without re-registering. A missing service degrades to one
  // log line and the dictionaries' source text — the surfaces keep working.
  const locale = localeFaceOf(ctx)
  if (locale === undefined) {
    log.warn('locale service unavailable — copy renders in the dictionary source language; progress bar, handover card and panel label keep working')
  } else {
    ctx.effect(() => locale.register(NAMESPACE, { zh, en }), 'threadharbor: locale dictionary')
  }
  // The runtime layer's copy (port failures, ssh-deploy HTTP errors) reads
  // through this same seat: it threads into the ports below and the
  // ssh-deploy calls, so a live bind follows the active language, and the
  // fallback reads the dictionary's source text so the ports work unchanged
  // without a locale service.
  const t: RuntimeT = locale?.bind(NAMESPACE) ?? fallbackT
  // The registry and the default identity follow the machine (2026-10-12
  // 用户要求：名单当然应该跟着本机的设置走): both go through ONE host-backed
  // storage — `isLoopback ? 'host' : 'memory'`, per the design doc — so the
  // two can never drift apart again. This tab's own claim stays in
  // sessionStorage: that per-tab override is what lets two tabs of one DSH
  // claim two hosts, and it is not a bug to fix.
  const hostStoreDepsResult = hostStoreDeps(ctx, message => { log.warn(message) })
  const hostStore = startHostStore(hostStoreDepsResult.deps, t)
  const tailscale = tailscalePort(ctx, hostStoreDepsResult.channel, message => { log.warn(message) }, t)
  const settings = layeredIdentitySettings(window.sessionStorage, hostStore.storage)
  const registry = hostRegistry(hostStore.storage)
  log.info(`roll-up identity: ${identity.hostId}${identity.derived ? ' (derived from page origin; configure it in the panel)' : ''}; session tree: DSH projections + remote pull via launchUrl`)
}

/**
 * This host's session source over DSH's projections.
 * @param ctx - the browser plugin context.
 * @param t - reads the not-ready notes in the active language; absent
 * (tests, no locale service) it falls back to the dictionary's source text.
 */
export function hostSessionSource(ctx: ClientPanelContext, t?: RuntimeT): {
  sessions(): readonly SectionSession[]
  sourceNotes(): readonly string[]
} {
  let lastRead: SessionRead | undefined
  const read = (): SessionRead => {
    const { workspaces, sessions } = readSessionSources({
      workspaces: safeContextService(ctx, 'workspaces'),
      sessions: safeContextService(ctx, 'sessions'),
    })
    return buildHostSessions(workspaces, sessions, t)
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
      if (lastRead === undefined) lastRead = read()
      return lastRead.ok ? [] : [lastRead.note]
    },
  }
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

/** Whatever `ctx.get(name)` yields, without ever throwing or inventing one. */
function readService(ctx: ClientPanelContext, name: string): unknown {
  try {
    const service = ctx.get(name)
    if (service !== undefined) return service
  } catch {
    // A context that refuses undeclared reads lands here; the property walk
    // below is how gateway.ts reaches the same service.
  }
  return (ctx as unknown as Record<string, unknown>)[name]
}

/**
 * The locale service, narrowed to the two calls this entry makes.
 *
 * `register` puts this plugin's dictionaries into the host's locale registry
 * (both shipped languages, or the registration is refused); `bind` returns the
 * translate function registration-time text reads through.
 */
type LocaleFace = {
  register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
}

/** Read the locale service, or say it is not there. */
function localeFaceOf(ctx: ClientPanelContext): LocaleFace | undefined {
  const service = readService(ctx, 'locale')
  if (!isRecord(service)) return undefined
  const { register, bind } = service as Record<string, unknown>
  if (typeof register !== 'function' || typeof bind !== 'function') return undefined
  return service as LocaleFace
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function'

/** A property read that survives a context proxy refusing an undeclared path. */
function propertyOf(holder: unknown, name: string): unknown {
  if (!isRecord(holder)) return undefined
  try {
    return holder[name]
  } catch {
    return undefined
  }
}

/** A named method of a holder, bound to it — detached calls die on `this`. */
function boundMethod(holder: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  const value = propertyOf(holder, name)
  return isFunction(value) ? value.bind(holder) : undefined
}

/** Whether a value is a plain record whose every value is a string. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') return undefined
  }
  return value as Record<string, string>
}

/** The registry entry id a stored list entry merges by. */
function hostIdOfEntry(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined
  const hostId = entry['hostId']
  return typeof hostId === 'string' ? hostId : undefined
}

/** The localStorage the data used to live in, read-only and failure-tolerant. */
function legacyBrowserStorage(): { getItem(key: string): string | null } {
  return {
    getItem: key => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
  }
}

/**
 * The settings-channel face the host-backed storage drives, read off the
 * context structurally: `remote.$host` for the loopback fact, and the
 * `remote.settings` namespace for the document reads and per-key edits. Both
 * methods are bound before use — a method called detached from its namespace
 * dies on `this`, which is how a whole page once went down.
 */
function hostStoreDeps(ctx: ClientPanelContext, log: (message: string) => void): { channel: HostStoreChannel | undefined; deps: HostStoreDeps } {
  const remote = readService(ctx, 'remote')
  const host = propertyOf(remote, '$host')
  const loopback = isRecord(host) && host['isLoopback'] === true
  const settingsNamespace = propertyOf(remote, 'settings')
  const describe = boundMethod(settingsNamespace, 'describe')
  const mutate = boundMethod(settingsNamespace, 'mutate')
  const channel: HostStoreChannel | undefined = describe !== undefined && mutate !== undefined
    ? {
        // The remote channel wraps results as { ok, value }; the value is
        // either the bare descriptor list (what the settings service returns)
        // or a view wrapping it under `namespaces`. Accept both shapes.
        async loadDocument() {
          const described: unknown = await describe()
          const answered = isRecord(described) && typeof described['ok'] === 'boolean' ? described['value'] : described
          const namespaces = Array.isArray(answered)
            ? answered as unknown[]
            : isRecord(answered) && Array.isArray(answered['namespaces'])
              ? answered['namespaces'] as unknown[]
              : []
          const view = namespaces.find(entry => isRecord(entry) && entry['ns'] === HOST_STORE_ENTRY_ID)
          if (!isRecord(view)) return undefined
          const data = isRecord(view['value']) ? view['value']['data'] : undefined
          return stringRecord(data)
        },
        // A refused write must read as a failure here, or the storage would
        // believe a key landed that the machine never accepted.
        async mutateDocument(ops: readonly StoreOp[]) {
          const response: unknown = await mutate(HOST_STORE_ENTRY_ID, ops.map(op => op.kind === 'set'
            ? { op: 'set', path: ['data', op.key], value: op.value }
            : { op: 'unset', path: ['data', op.key] }), undefined)
          const answered = isRecord(response) && typeof response['ok'] === 'boolean' ? response : undefined
          if (answered !== undefined && !answered.ok) {
            const error = isRecord(answered['error']) ? answered['error'] : undefined
            const detail = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : 'settings channel refused the write'
            throw new Error(detail)
          }
        },
      }
    : undefined
  if (loopback && channel === undefined) {
    log('host store: this page is on the serving machine but remote.settings is missing — the registry cannot persist')
  }
  return {
    channel,
    deps: {
      loopback: () => loopback,
      channel,
      listKeys: [{ key: HOST_REGISTRY_KEY, idOf: hostIdOfEntry }],
      migrateFrom: legacyBrowserStorage(),
      migrateKeys: [HOST_REGISTRY_KEY, IDENTITY_STORAGE_KEY],
      log,
    },
  }
}

/**
 * The Tailscale picker's port, over the SAME settings channel the registry
 * uses — there is no other host-side door from the browser. `loadPeers` reads
 * the `dsh.tailscale.peers` key the host-side bridge writes; `refresh` drops a
 * demand timestamp and polls until the bridge answers it, so 「已重跑」 is told
 * apart from 「没人应答」 by the `dsh.tailscale.refreshed` marker.
 * @param ctx - the browser plugin context.
 * @param channel - the host-store settings channel, or undefined when this host offers none.
 * @param log - where a refused read/write is reported, never thrown at the page.
 * @param t - reads the picker's failure copy in the active language; absent
 * (tests, no locale service) it falls back to the dictionary's source text.
 * @returns the port the panel's 「从 Tailscale 选」 button drives.
 */
function tailscalePort(ctx: ClientPanelContext, channel: HostStoreChannel | undefined, log: (message: string) => void, t?: RuntimeT): TailscalePort {
  const say = t ?? fallbackT
  const noChannel = (): TailscalePeersResult => ({ ok: false, message: say('panel.tailscale.noChannel') })
  const readKey = async (key: string): Promise<string | undefined> => {
    if (channel === undefined) return undefined
    try {
      const data = await channel.loadDocument()
      return data?.[key]
    } catch (error) {
      log(`tailscale: 读清单失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  const readPeers = async (): Promise<TailscalePeersResult> => {
    if (channel === undefined) return noChannel()
    const raw = await readKey(TAILSCALE_PEERS_KEY)
    if (raw === undefined) return { ok: true, peers: [] }
    try {
      const peers = JSON.parse(raw) as TailscalePeer[]
      const note = await readKey(TAILSCALE_ERROR_KEY)
      return { ok: true, peers, ...(note === undefined ? {} : { note }) }
    } catch {
      return { ok: false, message: say('panel.tailscale.badList') }
    }
  }
  return {
    loadPeers: readPeers,
    refresh: async () => {
      if (channel === undefined) return noChannel()
      const demand = String(Date.now())
      try {
        await channel.mutateDocument([{ kind: 'set', key: TAILSCALE_REFRESH_KEY, value: demand }])
      } catch (error) {
        return { ok: false, message: say('panel.tailscale.refreshDenied', { error: error instanceof Error ? error.message : String(error) }) }
      }
      // 轮询：等主机侧把 refreshed 写成我们的 demand；超时也读一次当前清单（可能是旧的），不当作失败。
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise(resolve => { setTimeout(resolve, 300) })
        if (await readKey(TAILSCALE_REFRESHED_KEY) === demand) return readPeers()
      }
      return readPeers()
    },
  }
}

/** Re-read the host storage when this document changes elsewhere (another tab). */
function settingsInvalidation(ctx: ClientPanelContext, refresh: () => void): () => void {
  const remote = readService(ctx, 'remote')
  const $on = boundMethod(remote, '$on')
  if ($on === undefined) return () => {}
  return $on('settings/document-updated', (...args: unknown[]) => {
    if (args[0] === HOST_STORE_ENTRY_ID) refresh()
  }) as () => void
}
