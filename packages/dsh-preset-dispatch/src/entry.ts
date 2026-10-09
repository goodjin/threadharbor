/**
 * The row that DSH actually loads.
 *
 * A preset is a composition, so an external agent's behaviour has to come from a
 * row inside that composition — this is it. One row per agent, configured with
 * that agent's transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted alongside it, so
 * a session on another preset is never seen here and keeps its own behaviour
 * with nothing to undo.
 *
 * Two constraints from the preset registry shape this entry:
 *
 * - `presetId` has to be written out. The registry knows which preset it is
 *   mounting but does not put that on the context, so a row cannot discover it.
 * - A row must not leak services. The registry audits mounted rows and fails the
 *   whole preset if one does (`mountPreset`, the `leakedServices` check). Event
 *   listeners are not services, so listening is fine; providing one is not.
 *
 * No imports from the DSH runtime packages: the published versions lag far
 * behind what runs, and the classes involved cannot be imported at all. So the
 * shapes this needs are structural, and the caller adapts.
 */

import Schema from '@deepseek-ai/schemastery'
import { applyAcpPlugin } from './plugin.ts'
import { installAcpDispatch } from './dispatch.ts'
import { makeContentWriter } from './content-writer.ts'
import type { AcpPresetConfig } from './registry.ts'
import type { AcpPresetBinding, AgentLike, ContentEvent } from './dispatch.ts'
import type { PermissionDecision } from '@threadharbor/dsh-acp-agent'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
import { projectStepContent } from '@threadharbor/dsh-acp-agent'

export const name = 'threadharbor-acp'

/** One model an agent serves, as offered in the picker. */
const Model = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().required(),
  description: Schema.string(),
})

export const Config: Schema<Config> = Schema.object({
  /**
   * The preset this row belongs to.
   *
   * Required: the registry does not put the preset on the context, so without
   * it the row cannot tell whether a session is actually one of its own — and
   * would take over every session it can see.
   */
  presetId: Schema.string().required(),
  /** Which agent this is; picks the frame dialect. */
  agent: Schema.string().required(),
  url: Schema.string(),
  command: Schema.string(),
  model: Schema.string(),
  mode: Schema.string(),
  cwd: Schema.string(),
  models: Schema.array(Model),
  hosts: Schema.array(Schema.string()),
})

export type Config = {
  presetId: string
  agent: string
  url?: string
  command?: string
  model?: string
  mode?: string
  cwd?: string
  models?: { id: string; name: string; description?: string }[]
  hosts?: string[]
}

/**
 * Take over ACP-backed sessions in this row's scope.
 *
 * `write` and `askApproval` are the two ports back into the host. They are
 * resolved lazily on first use, so this row can be loaded before the services it
 * depends on are up — a preset is mounted during registry activation, which can
 * run before the rest of the host has settled.
 */
export function apply(ctx: unknown, config: Config): void {
  const host = ctx as {
    on(event: 'agent/created', handler: (payload: { agent: unknown }) => void): unknown
    /** Optional: a row that injects it would refuse to mount without it. */
    get?(key: 'approval'): { request(request: unknown): Promise<unknown> } | undefined
    sessionProjections?: { stateOf(session: unknown, key: string): unknown }
    logger?: { info(message: string): void; warn(message: string): void }
  }

  const preset: AcpPresetConfig = {
    agent: config.agent,
    ...(config.url === undefined ? {} : { url: config.url }),
    ...(config.command === undefined ? {} : { command: config.command }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.mode === undefined ? {} : { mode: config.mode }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.hosts === undefined ? {} : { hosts: config.hosts }),
  }

  // Say so at mount. This row is invisible by design — it only ever speaks
  // through the sessions it takes over — so without this a preset that loaded
  // the row but never matched a session would look exactly like a plugin that
  // was never installed.
  const summary = `acp row mounted: preset=${config.presetId} agent=${config.agent} `
    + `transport=${config.url === undefined ? 'process' : 'websocket'} `
    + `preset-reading=${readProjection(host) === undefined ? 'header-only' : 'projection'} `
    + `approvals=${host.get?.('approval') === undefined ? 'refuse-all' : 'host'}`
  host.logger?.info(summary)
  // Also to stderr: this row is silent by design, and whether it mounted at all
  // is the first question anyone asks when no session is taken over. The host's
  // log level is not ours to raise.
  process.stderr.write(`[threadharbor] ${summary}\n`)

  // Where a permission request goes. The row must not answer these itself:
  // deciding on the agent's behalf is how an external agent ends up able to do
  // nothing, with nothing on screen to say why.
  //
  // The agent is looked up by session rather than captured: several sessions can
  // be live at once, and a permission request names the session it belongs to.
  const agents = new Map<string, unknown>()
  // Opportunistic, like the native tool layer: injecting it would mean the row
  // refuses to mount on a host that has no approval service, and taking every
  // session with it.
  const approval = host.get?.('approval')
  const ask = approval === undefined ? undefined : async (request: unknown): Promise<PermissionDecision> => {
    const described = describeRequest(request)
    const sessionId = sessionIdOfRequest(request)
    const outcome = await approval.request({
      agent: sessionId === undefined ? undefined : agents.get(sessionId),
      ...described,
    })
    // Only `allowed-once` means yes. Rejected, cancelled, unavailable and any
    // value invented later all mean no — a bridge that guessed the other way
    // would hand out permission nobody agreed to.
    return outcome === ALLOWED_ONCE ? { outcome: 'allow' } : { outcome: 'reject' }
  }

  applyAcpPlugin(host, config.presetId, preset, {
    ...(readProjection(host) === undefined ? {} : { presetOf: readProjection(host) }),
    ...(ask === undefined ? {} : { answerPermission: ask }),
    report: message => {
      host.logger?.warn(message)
      process.stderr.write(`[threadharbor] ${message}\n`)
    },
    install: (agent, presetId, dialect, table) => {
      const line = `acp takeover: session=${String(sessionIdOf(agent) ?? '?')} preset=${presetId} dialect=${dialect.id}`
      const sessionId = sessionIdOf(agent)
      if (sessionId !== undefined) agents.set(sessionId, agent)
      host.logger?.info(line)
      process.stderr.write(`[threadharbor] ${line}\n`)

      // Replace the session's step so the external agent drives the turn. This is
      // the whole point of the row: reporting a takeover without doing it leaves
      // a session that loads, matches, announces itself, and then answers with
      // nothing — the quietest failure there is.
      const append = appendOf(agent)
      if (append === undefined) {
        host.logger?.warn(`acp takeover: ${line} has no session log to write to; leaving it native`)
        return
      }
      const write = makeContentWriter((type, payload, intent) => append(type, payload, intent))
      const installed = installAcpDispatch(agent as AgentLike & object, table, {
        ...(readProjection(host) === undefined ? {} : { presetOf: readProjection(host) }),
        // Turn and step numbers are zero here on purpose: the surrounding native
        // loop owns both, and the replaced step supplies content only. They are
        // corrected where the events are written.
        produce: result => projectStepContent(result.frames, { turn: 0, step: 0, dialect }),
        append: event => { write([event]) },
      } as Parameters<typeof installAcpDispatch>[2])
      if (!installed) host.logger?.warn(`acp takeover: ${line} could not be installed`)
    },
  })
}

/**
 * Read a session's current preset from the projection.
 *
 * The header records the preset a session was *created* with, and a blank
 * session can change afterwards, so the header alone would take over a session
 * that has since moved on — or run a native session as though it were ours.
 * DSH reads the projection for exactly this reason.
 */
/** The session id, from wherever this agent shape happens to carry it. */
/** The session log's append, if this agent has one. */
function appendOf(agent: { readonly session?: unknown }): ((type: string, payload: unknown, intent?: unknown) => { seq: number }) | undefined {
  const session = agent.session as { append?: unknown } | undefined
  if (typeof session?.append !== 'function') return undefined
  return session.append.bind(session)
}

function sessionIdOf(agent: { readonly id?: unknown; readonly session?: unknown }): string | undefined {
  if (typeof agent.id === 'string') return agent.id
  const session = agent.session as { readonly id?: unknown } | undefined
  return typeof session?.id === 'string' ? session.id : undefined
}

function readProjection(host: { sessionProjections?: { stateOf(session: unknown, key: string): unknown } }): ((agent: { session?: unknown }) => string | undefined) | undefined {
  const projections = host.sessionProjections
  if (projections === undefined) return undefined
  return (agent: { session?: unknown }) => {
    const value = projections.stateOf(agent.session, 'agentPreset')
    const record = (typeof value === 'object' && value !== null ? value : {}) as { agentPreset?: unknown }
    return typeof record['agentPreset'] === 'string' ? record['agentPreset'] : undefined
  }
}

/** Kept so the dialect type stays referenced from the entry. */
export type { AcpDialect }

/** Only this exact value is a grant; everything else is a refusal. */
const ALLOWED_ONCE = 'allowed-once'

function sessionIdOfRequest(request: unknown): string | undefined {
  const sessionId = (request as { sessionId?: unknown } | undefined)?.sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * What the host needs to describe a permission prompt.
 *
 * A prompt that says only "allow?" tells the operator nothing about what they
 * are agreeing to, so the tool's own name and arguments travel with it.
 */
function describeRequest(request: unknown): { toolName: string; callId?: string; reason?: string } {
  const raw = (request ?? {}) as { toolName?: unknown; title?: unknown; rawInput?: unknown; reason?: unknown; callId?: unknown }
  const toolName = typeof raw.title === 'string' && raw.title !== ''
    ? raw.title
    : typeof raw.toolName === 'string' && raw.toolName !== '' ? raw.toolName : 'unknown'
  const callId = typeof raw.callId === 'string' ? raw.callId : undefined
  const reason = typeof raw.reason === 'string' ? raw.reason
    : raw.rawInput === undefined ? undefined : JSON.stringify(raw.rawInput).slice(0, 200)
  return { toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }) }
}
