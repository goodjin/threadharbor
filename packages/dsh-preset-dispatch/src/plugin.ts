/**
 * The plugin that actually runs inside a preset.
 *
 * An agent preset is a composition: selecting one mounts its rows. So an
 * external agent's behaviour has to come from a row inside that composition —
 * which is what this entry is. One row per agent, configured with that agent's
 * transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted alongside it, so
 * a session on some other preset is never seen here and keeps its own behaviour
 * with nothing to undo.
 *
 * No imports from the DSH runtime packages, for the reason the rest of this
 * package avoids them: the published versions lag far behind what runs, and the
 * classes involved cannot be imported at all. So this states the one event it
 * listens for and the shape it needs, and the caller adapts.
 */

import { holdsAcpDispatch, presetIdOf } from './dispatch.ts'
import type { AgentLike, PresetResolver } from './dispatch.ts'
import type { PermissionDecision, PermissionRequest } from '@threadharbor/dsh-acp-agent'
import { buildPresetTable, openSessionsOf, sessionsRegistry } from './registry.ts'
import type { AcpPresetConfig, PresetConfig } from './registry.ts'
import { makeSessionFactory } from './factory.ts'
import { modelsOfPreset, registerCatalog } from './catalog-registration.ts'
import { mountSwitchOnForeignModelRequest } from './switch-mount.ts'
import type { CatalogDeps } from './catalog.ts'
import type { AcpPresetBinding } from './dispatch.ts'
import type { AcpDialect, AcpTransport } from '@threadharbor/dsh-acp-agent'

/** The part of a Cordis context this entry touches. */
export type AcpPluginContext = {
  on(event: 'agent/created', handler: (payload: { agent: unknown }) => void): unknown
  /**
   * The session event stream. A preset chosen after the agent exists — the
   * interface's preset selector on a blank session — only rebinds the agent's
   * scope and appends `agent-preset/selected`; `agent/created` never fires
   * again, so this event is the only signal a takeover can pick up.
   */
  on(event: 'session/event', handler: (
    session: unknown,
    event: { readonly type: unknown; readonly data: unknown },
  ) => void): unknown
  /**
   * The Workspace registry's stop request for one session's work — dispatched
   * when a session is archived with its activity still running, among other
   * callers. The row listens so the external connection does not outlive the
   * session that stopped.
   */
  on(event: 'workspace/session-stop', handler: (payload: { sessionId: unknown }) => void): unknown
  /**
   * Read a host service by name; how this row reaches the model registry and
   * the switch services. Optional: a host offering neither still mounts, and
   * the pieces that need them say so loudly when they are asked.
   */
  get?(key: string): unknown
}

/** What the caller supplies, since the DSH-facing pieces stay behind ports. */
export type AcpPluginDeps = {
  /**
   * Take the session over: patch its step so the external agent drives it.
   *
   * Handed the dialect that was resolved, so the caller need not re-derive it.
   */
  install(agent: AgentLike, presetId: string, dialect: AcpDialect, table: ReadonlyMap<string, AcpPresetBinding>): void
  /**
   * Ask the host whether an action is allowed.
   *
   * Omitted when the host has nowhere to ask, in which case every request is
   * refused.
   */
  answerPermission?(request: PermissionRequest): Promise<PermissionDecision>
  /**
   * Say what went wrong on a session this row claimed.
   *
   * Optional because most callers only care that a session was or was not taken
   * over — but a row that cannot report is a row that fails quietly.
   */
  report?(message: string): void
  /**
   * Which preset a session is on right now.
   *
   * The header records the preset a session was *created* with, so reading it
   * can take over a session that has since moved on, or run a native session
   * as though it were ours. DSH reads the projection; supply that when it is
   * available and the header only as a fallback.
   */
  presetOf?: PresetResolver | undefined
  /**
   * Build the transport a preset connects over.
   *
   * Optional and aimed at tests: the default is the preset's own URL or
   * command, which is what every real deployment wants.
   */
  transport?(preset: { url?: string; command?: string }): AcpTransport
}

/**
 * Take over ACP-backed sessions in this plugin's scope.
 *
 * One session failing must not take the rest with it: `agent/created` is awaited
 * before the agent reaches the loop, so a throw here would strand that one
 * session with no step at all.
 */
export function applyAcpPlugin(
  ctx: AcpPluginContext,
  presetId: string,
  config: AcpPresetConfig,
  deps: AcpPluginDeps,
): void {
  const presets: PresetConfig = { presets: { [presetId]: config } }
  const factory = makeSessionFactory(presets, {
    // Refusing without asking is the safe default and the honest one when there
    // is nowhere to ask. Where there IS a host that answers, use it — a row
    // that decides every permission for itself makes a capable agent look
    // untrustworthy, and leaves nothing on screen to explain why.
    answerPermission: request => (deps.answerPermission === undefined
      ? Promise.resolve({ outcome: 'reject' })
      : deps.answerPermission(request)),
    ...(deps.transport === undefined ? {} : { transport: deps.transport }),
  })
  const dialect = factory.dialectFor(presetId, config)
  // An unknown agent is a configuration mistake. Taking sessions over anyway
  // would hand them to a dialect that does not exist; better to leave them on
  // the native agent, where they still work.
  if (dialect === undefined) return
  const sessions = sessionsRegistry()
  const table = buildPresetTable(presets, factory, sessions, {
    // A connection death dropping its cached session is the host healing on
    // its own; said here so a self-heal is visible in the row's report instead
    // of being indistinguishable from nothing having happened.
    onDropped: ({ sessionId, reason }) => {
      deps.report?.(`acp ${presetId}: session ${sessionId}'s connection died (${reason}) — dropped; the next turn opens a fresh one`)
    },
  })
  // What makes the external agent's models appear in the host's own model
  // picker: the catalog is global to this Host generation and already read by
  // it. Mounted here rather than left to the standalone entry, because this is
  // the function the loaded entry actually calls — a registration anywhere
  // else is the catalogue bug again. Silent when the host has no registry; the
  // picker then simply shows nothing of ours.
  const catalogDeps: CatalogDeps = {
    modelsOf: presetId => modelsOfPreset(presets, factory, presetId),
    dialectOf: presetId => table.get(presetId)?.dialect,
  }
  // A model request landing on one of these routes for a session this row does
  // not drive is a switch request; the chain (judge → plan → hand over →
  // apply) runs there and always says how it ended.
  catalogDeps.onForeignModelRequest = mountSwitchOnForeignModelRequest(
    ctx,
    presets,
    catalogDeps,
    message => { deps.report?.(message) },
  )
  registerCatalog(ctx, presets, catalogDeps)
  // A session whose work was stopped — archived with its turn running, most
  // visibly — must not leave its external connection open behind it. The stop
  // request ends the session's work; this closes the socket or child process
  // that work was running on, and the dropped cache entry means the session's
  // next turn, if it ever has one, opens fresh. This is also what keeps the
  // probe's small sessions from leaking one connection per probe: the probe
  // archives its session when it is done, and the archive is the stop.
  ctx.on('workspace/session-stop', payload => {
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string') return
    const opened = sessions.get(presetId)
    const entry = openSessionsOf(sessions, presetId).get(sessionId)
    if (opened === undefined || entry === undefined) return
    opened.delete(sessionId)
    entry.close()
    deps.report?.(`acp ${presetId}: session ${sessionId} was stopped — its external connection was closed`)
  })

  ctx.on('agent/created', payload => {
    try {
      const agent = payload.agent as AgentLike
      if (presetIdOf(agent, deps.presetOf) !== presetId) return
      const binding = table.get(presetId)
      if (binding === undefined) return
      if (holdsAcpDispatch(agent, binding)) return
      deps.install(agent, presetId, dialect, table)
    } catch (error) {
      // Left alone: whatever this session is, it keeps a working step. Said out
      // loud, though — a takeover that loads, matches, announces itself and then
      // throws here is indistinguishable from working, from the outside.
      deps.report?.(`acp takeover failed: ${String(error)}`)
    }
  })

  // A preset chosen after the agent exists never fires `agent/created` again:
  // the interface's selector rebinds the agent's scope to the new composition
  // and appends `agent-preset/selected`, and the turn sent right after that
  // would otherwise run the native agent with no error anywhere. The scope
  // filter delivers exactly the sessions this preset now drives, so the event
  // is both the signal and the filter.
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'agent-preset/selected') return
      const data = event.data
      if (typeof data !== 'object' || data === null || !('agentPreset' in data)) return
      if ((data as { agentPreset: unknown }).agentPreset !== presetId) return
      const binding = table.get(presetId)
      const sessionId = sessionIdentifier(session)
      if (binding === undefined || sessionId === undefined) return
      const registry = ctx.get?.('agents')
      if (typeof registry !== 'object' || registry === null
        || typeof (registry as { get?: unknown }).get !== 'function') {
        // `select` resolves the agent before it can append the event, so a host
        // that could select at all always has the registry here. Silence would
        // make a takeover that never happens look exactly like one that did.
        deps.report?.(`acp ${presetId}: preset selected for session ${sessionId} but this host exposes no agents registry — the takeover cannot reach the live agent`)
        return
      }
      const agent = liveAgentOf(registry, sessionId)
      // A cold session has no live agent, which is normal.
      if (agent === undefined) return
      if (holdsAcpDispatch(agent, binding)) return
      deps.install(agent, presetId, dialect, table)
    } catch (error) {
      // Same contract as the `agent/created` path: this session keeps its
      // working step, and what happened is said out loud instead.
      deps.report?.(`acp takeover failed: ${String(error)}`)
    }
  })
}

/** The session id off the event's session argument, if it carries one. */
function sessionIdentifier(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The live agent for a session, through the registry the host exposes by name.
 *
 * The caller has already checked the registry's structure; a missing entry is a
 * cold session, which is a normal state and stays quiet.
 */
function liveAgentOf(registry: object, sessionId: string): AgentLike | undefined {
  const get = (registry as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  const found = (get as (candidate: string) => unknown).call(registry, sessionId)
  // The registry answers whatever it answers; anything object-shaped is an
  // agent this module can read (`AgentLike` takes everything optionally).
  if (typeof found !== 'object' || found === null) return undefined
  return found as AgentLike
}