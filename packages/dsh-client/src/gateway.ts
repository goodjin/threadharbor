/**
 * The one door from this page to the host: DSH's own Remote namespaces.
 *
 * Nothing here is a new interface — every call forwarded is one the rest of the
 * UI already drives. What this module owns is the honesty around them: a
 * namespace that is absent, half-loaded, or answering with something
 * unexpected reads as "missing" or "failed", so a panel click can say what
 * happened instead of throwing where nobody is looking.
 *
 * There are no casts in this file on purpose. Everything coming out of
 * `ctx.get` is `unknown` until a predicate below has checked it.
 */

/** How a forwarded call ended, including the "the answer made no sense" case. */
export type GatewayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** An agent this host could drive, as the model catalog describes it. */
export type AgentDescriptor = {
  readonly presetId: string
  readonly label: string
}

/** One event from a session's log, narrowed to what a probe needs to see. */
export type WireEvent = {
  readonly type: string
}

/**
 * The calls a browser-side probe needs, all of them DSH's own.
 *
 * The port exists so the orchestration can be tested without a host; the
 * implementation below is the only place wire shapes are written down.
 */
export type SessionGateway = {
  /** Providers whose catalog id starts with `acp:` — this host's driven agents. */
  listAgents(): Promise<GatewayResult<readonly AgentDescriptor[]>>
  /** Hear `api-session/error`; returns the unsubscribe function. */
  subscribeSessionErrors(listener: (sessionId: string, message: string) => void): () => void
  /** Create a session; the preset rides along, which is what mounts the agent. */
  createSession(request: { readonly agentPreset: string }): Promise<GatewayResult<{ readonly sessionId: string }>>
  /** One shortest message, queued. */
  sendPrompt(request: { readonly requestId: string; readonly sessionId: string; readonly text: string }): Promise<GatewayResult<unknown>>
  /** The session's log from the beginning, newest events included. */
  readRecentEvents(request: { readonly sessionId: string; readonly maxMessages: number }): Promise<GatewayResult<readonly WireEvent[]>>
  /**
   * End the session and its running work together.
   *
   * `stopActivity` is set unconditionally: a probe session whose turn is still
   * running must not keep running after the probe gives up on it.
   */
  archiveSession(request: { readonly sessionId: string }): Promise<GatewayResult<unknown>>
}

/** What opening the gateway found: a usable door, or the names it lacked. */
export type GatewayOpening = {
  /**
   * Undefined only when one of the required calls is missing — the probe
   * cannot run at all. Optional pieces (the error subscription, the agent
   * catalog) degrade instead, and are named in `missing`.
   */
  readonly gateway: SessionGateway | undefined
  /** Every absent name, required or optional — for the panel to show. */
  readonly missing: readonly string[]
  /**
   * The agent list on its own, when the catalog is reachable — even where the
   * probe is not. DSH's own model picker rides the same call, so "the picker
   * works" and "this exists" are the same statement.
   */
  readonly listAgents?: (() => Promise<GatewayResult<readonly AgentDescriptor[]>>) | undefined
}

/** The one thing this module needs from the context. */
export type ServiceLookup = {
  /** Any service name; absent names and absent services both read as undefined. */
  get(name: string): unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type AnyFn = (...args: unknown[]) => unknown

const isFunction = (value: unknown): value is AnyFn => typeof value === 'function'

/** The named method of a service, if the service really has one. */
function methodOf(holder: unknown, name: string): AnyFn | undefined {
  if (!isRecord(holder)) return undefined
  const value = holder[name]
  return isFunction(value) ? value : undefined
}

/** Read `service.method` off the context, or say it was missing. */
function lookup(
  ctx: ServiceLookup,
  service: string,
  method: string | undefined,
): { readonly fn: AnyFn | undefined; readonly missing?: string } {
  // `remote.session` answers to two spellings across hosts: one flat service
  // name, or the `remote` namespace with `session` under it. Try the flat name
  // first — the shape the tests stand up — then walk the namespace.
  let holder: unknown
  try {
    holder = ctx.get(service)
  } catch {
    holder = undefined
  }
  if (holder === undefined) {
    const segments = service.split('.')
    const root = segments[0]
    if (root !== undefined) {
      let namespace: unknown
      try {
        namespace = ctx.get(root)
      } catch {
        namespace = undefined
      }
      // Some contributions are plain properties of the context rather than
      // services (`remote` is one), so a bare get can miss them.
      if (namespace === undefined) {
        namespace = (ctx as unknown as Record<string, unknown>)[root]
      }
      for (const segment of segments.slice(1)) {
        namespace = isRecord(namespace) ? namespace[segment] : undefined
      }
      holder = namespace
    }
  }
  if (method === undefined) {
    return isFunction(holder) || isRecord(holder) ? { fn: undefined } : { fn: undefined, missing: service }
  }
  const fn = methodOf(holder, method)
  return fn === undefined ? { fn: undefined, missing: `${service}.${method}` } : { fn }
}

/** Wait for a call that may not even return a promise. */
async function awaited(value: unknown): Promise<unknown> {
  return await value
}

/** Turn whatever a forwarded call returned into a checked result. */
function resultOf<T>(
  raw: unknown,
  check: (value: unknown) => T | undefined,
  what: string,
): GatewayResult<T> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: 'gateway/shape', message: `${what}: 主机没有按约定返回对象` } }
  }
  if (raw['ok'] === true) {
    const value = check(raw['value'])
    if (value === undefined) {
      return { ok: false, error: { code: 'gateway/shape', message: `${what}: 返回值不符合预期` } }
    }
    return { ok: true, value }
  }
  if (raw['ok'] === false) {
    const error = raw['error']
    if (isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
      return { ok: false, error: { code: error['code'], message: error['message'] } }
    }
    return { ok: false, error: { code: 'remote/failed', message: `${what}: ${JSON.stringify(error)}` } }
  }
  return { ok: false, error: { code: 'gateway/shape', message: `${what}: 返回值缺少 ok 字段` } }
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined

const sessionValue = (value: unknown): { readonly sessionId: string } | undefined => {
  const record = objectValue(value)
  const sessionId = record?.['sessionId']
  return typeof sessionId === 'string' ? { sessionId } : undefined
}

const eventsValue = (value: unknown): readonly WireEvent[] | undefined => {
  const record = objectValue(value)
  const records = record?.['records']
  if (!Array.isArray(records)) return undefined
  const events: WireEvent[] = []
  for (const item of records) {
    const event = objectValue(item)?.['event']
    const type = objectValue(event)?.['type']
    if (typeof type !== 'string') return undefined
    events.push({ type })
  }
  return events
}

const acpPrefix = 'acp:'

/** Split an `acp:<presetId>` catalog id, or say it is not one of ours. */
function acpIdOf(id: unknown): string | undefined {
  return typeof id === 'string' && id.startsWith(acpPrefix) ? id.slice(acpPrefix.length) : undefined
}

/** A display label that never repeats the `acp:` wire prefix at the user. */
function labelOf(id: string, name: unknown): string {
  if (typeof name === 'string' && name !== '') {
    return name.startsWith(acpPrefix) ? name.slice(acpPrefix.length) : name
  }
  return id
}

const agentsValue = (value: unknown): readonly AgentDescriptor[] | undefined => {
  const record = objectValue(value)
  const groups = record?.['groups']
  const failures = record?.['failures']
  if (!Array.isArray(groups) || !Array.isArray(failures)) return undefined
  const agents: AgentDescriptor[] = []
  for (const group of groups) {
    const entry = objectValue(group)
    const presetId = acpIdOf(entry?.['id'])
    if (presetId === undefined) continue
    agents.push({ presetId, label: labelOf(presetId, entry?.['name']) })
  }
  for (const failure of failures) {
    const entry = objectValue(failure)
    const presetId = acpIdOf(entry?.['id'])
    // A failed lookup is exactly the agent worth probing, so it stays listed;
    // only duplicates fall away.
    if (presetId === undefined || agents.some(agent => agent.presetId === presetId)) continue
    agents.push({ presetId, label: labelOf(presetId, entry?.['name']) })
  }
  return agents
}

/**
 * Open the gateway over the context's Remote namespaces.
 *
 * Never throws: whatever is missing is named in `missing`, and the caller
 * shows that instead of pretending the probe ran.
 */
export function openSessionGateway(ctx: ServiceLookup): GatewayOpening {
  const missing: string[] = []
  const note = (name: string): undefined => {
    missing.push(name)
    return undefined
  }

  // Required: the four calls the probe itself is made of.
  const sessionCreate = lookup(ctx, 'remote.session', 'create').fn ?? note('remote.session.create')
  const sessionPrompt = lookup(ctx, 'remote.session', 'prompt').fn ?? note('remote.session.prompt')
  const sessionPage = lookup(ctx, 'remote.session', 'page').fn ?? note('remote.session.page')
  const archiveSession = lookup(ctx, 'remote.workspace', 'archiveSession').fn ?? note('remote.workspace.archiveSession')
  // Optional: without the error event the probe cannot tell 连不上 from 卡住
  // and says so; without the catalog the agent list is a failure, not a crash.
  const remoteOn = lookup(ctx, 'remote', '$on').fn
  if (remoteOn === undefined) note('remote')
  const modelCatalog = lookup(ctx, 'remote.session', 'modelCatalog').fn
  if (modelCatalog === undefined) note('remote.session.modelCatalog')

  // Listing the agents rides the catalog alone: DSH's own model picker uses
  // exactly this call, so a deployment that can show the picker can name its
  // agents, even where the probe's four calls do not exist.
  const listAgents: (() => Promise<GatewayResult<readonly AgentDescriptor[]>>) | undefined = modelCatalog === undefined
    ? undefined
    : async () => {
        try {
          const raw: unknown = await modelCatalog()
          return resultOf(raw, agentsValue, 'session.modelCatalog')
        } catch (error) {
          return { ok: false as const, error: { code: 'gateway/call', message: `session.modelCatalog: ${String(error)}` } }
        }
      }

  const gateway: SessionGateway | undefined = sessionCreate !== undefined
    && sessionPrompt !== undefined && sessionPage !== undefined && archiveSession !== undefined
    ? {
        listAgents: async () => {
          if (modelCatalog === undefined) {
            return { ok: false as const, error: { code: 'gateway/missing', message: '主机上没有 remote.session.modelCatalog，列不出 agent' } }
          }
          try {
            const raw: unknown = await modelCatalog()
            return resultOf(raw, agentsValue, 'session.modelCatalog')
          } catch (error) {
            return { ok: false as const, error: { code: 'gateway/call', message: `session.modelCatalog: ${String(error)}` } }
          }
        },
        subscribeSessionErrors: listener => {
          if (remoteOn === undefined) return () => {}
          const dispose = remoteOn('api-session/error', listener)
          return isFunction(dispose) ? dispose : () => {}
        },
        createSession: async request => {
          try {
            const raw: unknown = await awaited(sessionCreate!(request))
            return resultOf(raw, sessionValue, 'session.create')
          } catch (error) {
            return { ok: false as const, error: { code: 'gateway/call', message: `session.create: ${String(error)}` } }
          }
        },
        sendPrompt: async request => {
          const payload = {
            requestId: request.requestId,
            sessionId: request.sessionId,
            mode: 'queue' as const,
            content: [{ type: 'text' as const, text: request.text }],
          }
          try {
            const raw: unknown = await awaited(sessionPrompt!(payload))
            return resultOf(raw, objectValue, 'session.prompt')
          } catch (error) {
            return { ok: false as const, error: { code: 'gateway/call', message: `session.prompt: ${String(error)}` } }
          }
        },
        readRecentEvents: async request => {
          const payload = {
            address: { kind: 'session' as const, sessionId: request.sessionId },
            // The probe session is brand new; reading from the beginning is the
            // whole history, and -1 is how the client asks for it.
            throughSeq: -1,
            maxMessages: request.maxMessages,
          }
          try {
            const raw: unknown = await awaited(sessionPage!(payload))
            return resultOf(raw, eventsValue, 'session.page')
          } catch (error) {
            return { ok: false as const, error: { code: 'gateway/call', message: `session.page: ${String(error)}` } }
          }
        },
        archiveSession: async request => {
          try {
            const raw: unknown = await awaited(archiveSession!({ sessionId: request.sessionId, stopActivity: true }))
            return resultOf(raw, objectValue, 'workspace.archiveSession')
          } catch (error) {
            return { ok: false as const, error: { code: 'gateway/call', message: `workspace.archiveSession: ${String(error)}` } }
          }
        },
      }
    : undefined

  return { gateway, missing, ...(listAgents === undefined ? {} : { listAgents }) }
}
