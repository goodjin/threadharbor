/**
 * The session-side face of a finished agent switch.
 *
 * A switched-away turn used to end as a thrown error, so the session it left
 * showed 「处理失败」 for what had actually succeeded, and the user had to find
 * the new session by hand. Two facts fix that, one on each side of the wire:
 *
 * - The host no longer throws. The takeover's replacement step returns the
 *   switch's outcome as the turn's ending — a `agent-switch/handover` variant
 *   in the host's merge-extensible `TurnEndReasonMap` — so the loop records a
 *   neutral ending naming where the conversation went, and DSH's own reader
 *   rule for endings they do not own (fall through, ignore) keeps every stock
 *   client quiet about it.
 * - This module is the client that DOES know the kind. It registers one
 *   ConversationNodeDefinition — the same business-node seam DSH's chat uses
 *   for its turn-error and max-tokens notices — matching that ending, renders
 *   a neutral notice row in the old session, and opens the new session the
 *   same way the stock sidebar row does: the `uiWorkspace.openSession`
 *   service. The jump fires once per page per handover; returning to the old
 *   session later stays put and keeps the notice's button for going over
 *   manually.
 */

import type { ConversationLocation, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TurnEndReasonMap } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useEffect } from 'react'
import type { SwitchProgressSurface } from './switch-progress.ts'
import { NAMESPACE } from './locales.ts'
import styles from './handover.module.css'

/** The ending this plugin owns, merged into the host's ending union. */
declare module '@deepseek-ai/dsh-session/types' {
  interface TurnEndReasonMap {
    'agent-switch/handover': {
      readonly kind: 'agent-switch/handover'
      /** The preset the conversation moved to, without the `acp:` catalog prefix. */
      readonly target: string
      /** The session that now carries the conversation and the question. */
      readonly sessionId: string
      /** The user-facing sentence composed where the switch was made. */
      readonly note: string
    }
  }
}

/** The payload of this plugin's one Chat node kind. */
export interface AgentSwitchHandoverData {
  readonly turn: number
  /** Seq and time of the `turn/end` that carried the handover. */
  readonly seq: number
  readonly time: number
  readonly target: string
  readonly sessionId: string
  readonly note: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'agent-switch-handover': AgentSwitchHandoverData
  }
}

/** Per-turn fold of the Definition: the turn number plus its handover, once known. */
interface HandoverState {
  readonly turn: number
  readonly handover?: AgentSwitchHandoverData
}

/** Narrow one event to the handover ending, or say it is not one. */
function handoverOf(event: Parameters<ConversationNodeDefinition['match']>[0]): AgentSwitchHandoverData | undefined {
  if (event.type !== 'turn/end' || event.data.reason.kind !== 'agent-switch/handover') return undefined
  const reason = event.data.reason
  return {
    turn: event.data.turn,
    seq: event.seq,
    time: event.time,
    target: reason.target,
    sessionId: reason.sessionId,
    note: reason.note,
  }
}

/** Resolve one Context's best currently loaded event location. */
function locationOf(context: ConversationNodeContext<HandoverState>): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/**
 * The Chat business Definition for switched-away turns. Mirrors DSH's own
 * turn-error Definition: match the turn's opening for identity, match the
 * recognized ending for content, publish one node while the handover is
 * known.
 */
export const agentSwitchHandoverDefinition: ConversationNodeDefinition<HandoverState> = {
  kind: 'agent-switch-handover',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    // Test the discriminant here rather than `handoverOf(event) !== undefined`:
    // that call returns data and narrows nothing, so reading `event.data.turn`
    // right after it was only ever sound while the event union degraded to any.
    if (event.type === 'turn/end' && event.data.reason.kind === 'agent-switch/handover') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('agent-switch-handover start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: (context, match) => {
    const handover = handoverOf(match.event)
    return handover === undefined ? context.state : { ...context.state, handover }
  },
  buildViewNode: (context) => {
    const handover = context.state?.handover
    if (handover === undefined) return null
    return {
      key: context.key,
      kind: 'agent-switch-handover',
      id: context.id,
      target: 'chat',
      anchorSeq: handover.seq,
      location: locationOf(context),
      visibility: 'visible',
      data: handover,
    }
  },
}

/**
 * Handovers this page has already followed, keyed by the ending event's time
 * and seq. The set is what makes the automatic jump a once-per-handover act:
 * the first mount after the switch follows it; any later mount of the same
 * notice — navigating back to the old session — stays put and leaves the
 * button for going over manually. It is deliberately page-lifetime memory,
 * not storage: a fresh page keeps the follow, a reload that restores the old
 * session as the current one follows once more, and nothing outlives the tab.
 */
const followedHandovers = new Set<string>()

/** Component props: the framework runtime share, the locale `t` seat, and the navigation callbacks. */
export type HandoverCardProps = PropsRuntime<'conversation.chat.node', 'agent-switch-handover'>
  & PropsLocale<typeof NAMESPACE>
  & {
    openSession: ((sessionId: string) => void) | undefined
    /**
     * Put the switch's progress on screen and load the new session's first
     * page. Absent when the page has no preload to offer; the jump then runs
     * on its own settle delay alone.
     */
    prepare: (((target: { readonly sessionId: string; readonly target: string }) => Promise<void>) | undefined)
  }

/**
 * The neutral notice a switched-away turn shows. Not an error row — the
 * switch worked; this turn ended because its conversation moved.
 */
export function AgentSwitchHandoverCard(props: HandoverCardProps): ReturnType<typeof createElement> {
  const data = props.node.data
  const open = props.openSession
  const prepare = props.prepare
  useEffect(() => {
    if (open === undefined) return
    const key = `${data.time}:${data.seq}`
    if (followedHandovers.has(key)) return
    followedHandovers.add(key)
    // The progress and the new session's first page start now, while this
    // ending is still settling: they are the slow half of the switch, and the
    // jump is going to wait for them anyway.
    const loaded = prepare === undefined
      ? Promise.resolve()
      : prepare({ sessionId: data.sessionId, target: data.target })
    // Navigate after the switched-away turn has settled: the switch just wrote
    // this session's ending, and the workspace is still committing the state
    // that ending produced. Leaving through the workspace in the same tick
    // tears down this session's views while that commit is in flight, and the
    // session's reference is then found released by every later open. The jump
    // waits for that settle AND for the new session's first page, so the panel
    // swaps onto content that is already there.
    const timer = setTimeout(() => {
      const jump = (): void => { open(data.sessionId) }
      void loaded.then(jump, jump)
    }, 1200)
    return () => {
      // Re-arm on unmount: a settled view that remounts this card must still
      // follow; the guard only stops repeats within one mounted life.
      clearTimeout(timer)
      followedHandovers.delete(key)
    }
  }, [open, prepare, data.time, data.seq, data.sessionId, data.target])
  return createElement(
    'div',
    { className: styles.handoverRow, role: 'status' },
    createElement(
      'div',
      { className: styles.handoverCopy },
      createElement(
        'span',
        { className: styles.handoverTitle },
        props.t('handover.title', { target: data.target }),
      ),
      createElement('span', { className: styles.handoverNote }, data.note),
    ),
    open === undefined ? null : createElement(
      'button',
      {
        type: 'button',
        className: styles.handoverOpen,
        onClick: () => { open(data.sessionId) },
      },
      props.t('handover.open'),
    ),
  )
}

/** The slot face the surface registers through, as the panel's mount uses it. */
export type HandoverSlotHost = {
  inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
  register: SlotCore['register']
}

/** What `registerAgentSwitchHandoverSurface` needs from the page's context. */
export type HandoverSurfaceContext = {
  logger(name: string): { info(message: string): void; warn(message: string): void }
  effect(callback: () => unknown, name?: string): unknown
  /** Any service name; absent names and absent services both read as undefined. */
  get(name: string): unknown
  slots: HandoverSlotHost
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Read one declared service off the context, tolerating a refusing read.
 *
 * `uiConversation` and `uiWorkspace` are declared in this entry's `inject`
 * export, so the context guarantees both by the time apply runs — the same
 * shape DSH's own ui-chat and ui-user-questions declare. The try/catch keeps
 * an unexpectedly refused read (a stripped harness, a future DSH that drops a
 * service) on the degrade path instead of failing the fiber.
 */
function serviceNow(ctx: HandoverSurfaceContext, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** The one method this surface calls on the workspace service, bound to it. */
type OpenSessionFace = (sessionId: string) => void

/**
 * Bind `uiWorkspace.openSession` to its owner, or say it is missing.
 *
 * The stock sidebar opens a session through exactly this service method, so
 * the jump here rides the same navigation path a row click takes — selection,
 * persistence, and main-panel reveal included.
 */
function openSessionFaceOf(uiWorkspace: Record<string, unknown>): OpenSessionFace | undefined {
  const value = uiWorkspace['openSession']
  if (typeof value !== 'function') return undefined
  const bound = (value as (this: unknown, target: string) => void).bind(uiWorkspace)
  return sessionId => { bound(sessionId) }
}

/**
 * Take the conversation registry's `register` bound to its owner.
 *
 * Detached, it dies on `this` — a prototype method over the registry's
 * definition ledger — and that detached call is exactly what failed the entry
 * fiber on the page (2026-10-11): apply threw 「Cannot read properties of
 * undefined (reading 'registerDefinition')」 before the panel ever mounted.
 */
function conversationRegisterOf(uiConversation: Record<string, unknown>): ((definition: unknown) => () => void) | undefined {
  const events = uiConversation['events']
  if (!isRecord(events)) return undefined
  const register = events['register']
  if (typeof register !== 'function') return undefined
  const bound = (register as (this: unknown, definition: unknown) => () => void).bind(events)
  return definition => bound(definition)
}

/** Land the Definition and the keyed renderer once both services are at hand. */
function install(
  ctx: HandoverSurfaceContext,
  uiWorkspace: Record<string, unknown>,
  register: (definition: unknown) => () => void,
  prepare: SwitchProgressSurface['prepare'] | undefined,
): void {
  const openSession = openSessionFaceOf(uiWorkspace)
  if (openSession === undefined) {
    ctx.logger('threadharbor-client').warn('agent-switch handover: uiWorkspace.openSession unavailable — the notice renders, without the automatic jump')
  }
  // The registry manages its own lifetime through the owning context, exactly
  // as ui-user-questions registers its Definition: one call, no extra wrap.
  register(agentSwitchHandoverDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    // `locale` puts the framework-synthesized `t` seat on the card's props;
    // the dictionaries themselves register in the entry (locales.ts owns them).
    { name: 'conversation.chat.node', key: 'agent-switch-handover', locale: NAMESPACE, inject: () => ({ openSession, prepare }) },
    AgentSwitchHandoverCard,
  ))
}

/**
 * Register the switched-turn surface: the Chat business Definition plus the
 * keyed renderer for its one node kind.
 *
 * Both go through the seams DSH's own chat notices use — `uiConversation`
 * events for the Definition, the `conversation.chat.node` keyed slot for the
 * renderer — and `slots.inject` waits for ui-chat's declaration the same way
 * the panel mount waits for its slots. A service that arrives shaped
 * differently than expected degrades to one log line, never a failed fiber.
 * @param ctx - the browser plugin context.
 * @param progress - the switch's progress surface; its `prepare` loads the new
 *   session before the card jumps, and is absent only when the page never
 *   started one.
 */
export function registerAgentSwitchHandoverSurface(
  ctx: HandoverSurfaceContext,
  progress?: SwitchProgressSurface | undefined,
): void {
  const uiWorkspace = serviceNow(ctx, 'uiWorkspace')
  const uiConversation = serviceNow(ctx, 'uiConversation')
  const register = uiConversation !== undefined && isRecord(uiConversation)
    ? conversationRegisterOf(uiConversation)
    : undefined
  if (!isRecord(uiWorkspace) || register === undefined) {
    ctx.logger('threadharbor-client').warn('agent-switch handover: uiConversation/uiWorkspace unavailable — switched-away turns keep their ending visible only as data; no notice, no automatic jump')
    return
  }
  install(ctx, uiWorkspace, register, progress?.prepare)
}
