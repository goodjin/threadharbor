/** Forward the agent's per-chunk model stream into ACP notifications as it arrives.
 *
 * The DSH agent loop already publishes every provider chunk on the cordis bus as
 * `agent/assistant-stream` (this is the event the official session controller
 * subscribes to for live GUI rendering). The ACP bridge does not: it only reads
 * committed `assistant/message` events, so a long reasoning block reaches the
 * client in one frame after the whole thing has been generated. This module
 * closes that gap from outside the package, and suppresses the committed copy of
 * any block it already streamed live so the text appears exactly once.
 *
 * Whatever the relay cannot stream (tool calls, other message kinds, a turn that
 * produced no live frames) still leaves through the pacer, so a committed block
 * is never delivered as one unreadable blob.
 */

import { pacedSessionUpdate } from './stream-pacer.mjs'

const REASONING = 'reasoning'
const TEXT = 'text'
const SESSION_UPDATE = {
  [REASONING]: 'agent_thought_chunk',
  [TEXT]: 'agent_message_chunk',
}
const MAX_TRACKED_SESSIONS = 64

/**
 * Process-wide wiring, armed by the entry module before the bridge applies.
 *
 * The bridge calls `installBridge` from inside its own `apply`, which is the
 * first moment its ACP client and method table exist.
 */
let armed = null

export function armBridge(wiring) {
  armed = wiring
}

/** Called by the patched bridge once its ACP client exists. */
export function installBridge(conn, methods) {
  armed?.onBridge?.(conn, methods)
}

/**
 * Where the patched bridge forwards every committed session/update.
 *
 * A block the relay already streamed live is dropped here, so the text reaches
 * the client once. Everything else — tool calls, message kinds the relay does
 * not stream, a turn with no live stream at all — still goes through the pacer,
 * so a committed block is never delivered as one unreadable blob.
 */
export async function notifyThroughBridge(notification, send) {
  const relay = armed?.relay
  if (relay === undefined) return pacedSessionUpdate(notification, send)
  const filtered = filterCommitted(relay, notification.sessionId, notification)
  if (filtered === null) return 0
  if (filtered !== notification) {
    await send(filtered)
    return 1
  }
  return pacedSessionUpdate(notification, send)
}

function kindOfBlockType(blockType) {
  if (blockType === REASONING) return REASONING
  if (blockType === TEXT) return TEXT
  return undefined
}

function kindOfSessionUpdate(sessionUpdate) {
  if (sessionUpdate === SESSION_UPDATE[REASONING]) return REASONING
  if (sessionUpdate === SESSION_UPDATE[TEXT]) return TEXT
  return undefined
}

export function liveMessageId(attemptId) {
  return `live-${String(attemptId).replace(/[^A-Za-z0-9._-]/g, '-')}`
}

export function createRelay() {
  return { sessions: new Map(), framesSeen: 0, notificationsSent: 0, droppedCommits: 0 }
}

function forget(relay, sessionId, state) {
  if (state.blocks.size === 0) relay.sessions.delete(sessionId)
}

function stateFor(relay, sessionId, attemptId) {
  const existing = relay.sessions.get(sessionId)
  if (existing !== undefined && existing.attemptId === attemptId) return existing
  if (relay.sessions.size >= MAX_TRACKED_SESSIONS) {
    const oldest = relay.sessions.keys().next().value
    if (oldest !== undefined) relay.sessions.delete(oldest)
  }
  const state = { attemptId, messageId: liveMessageId(attemptId), blocks: new Map() }
  relay.sessions.set(sessionId, state)
  return state
}

function blockFor(state, index, kind) {
  const existing = state.blocks.get(index)
  if (existing !== undefined && existing.kind === kind) return existing
  const entry = { kind, text: '' }
  state.blocks.set(index, entry)
  return entry
}

/** An ACP session/update params object, the same shape the bridge itself sends. */
function notification(sessionId, messageId, kind, text) {
  return {
    sessionId,
    update: { sessionUpdate: SESSION_UPDATE[kind], messageId, content: { type: 'text', text } },
  }
}

/**
 * Consume one live frame. Returns the notifications it produced so callers can
 * send them; `send` receives each one as it happens, which is the whole point.
 */
export function acceptFrame(relay, sessionId, frame, send) {
  if (frame === null || typeof frame !== 'object') return 0
  relay.framesSeen += 1

  if (frame.type === 'start') {
    stateFor(relay, sessionId, frame.attemptId)
    return 0
  }
  if (frame.type === 'end') {
    // A committed attempt is followed by the durable copy of the same text, so
    // keep the state to suppress it. An abandoned one (cancel, retry) commits
    // nothing, and its partial text has already been sent.
    if (frame.outcome?.kind === 'abandoned') relay.sessions.delete(sessionId)
    return 0
  }
  if (frame.type !== 'chunk') return 0

  const chunk = frame.chunk
  if (chunk === null || typeof chunk !== 'object') return 0
  const state = relay.sessions.get(sessionId)
  if (state === undefined) return 0

  if (chunk.type === 'block-start') {
    const kind = kindOfBlockType(chunk.blockType)
    if (kind !== undefined) blockFor(state, chunk.index, kind)
    return 0
  }
  const kind = chunk.type === 'reasoning-delta'
    ? REASONING
    : chunk.type === 'text-delta' ? TEXT : undefined
  if (kind === undefined) return 0
  const text = typeof chunk.text === 'string' ? chunk.text : ''
  if (text === '') return 0

  const entry = blockFor(state, chunk.index, kind)
  entry.text += text
  relay.notificationsSent += 1
  send(notification(sessionId, state.messageId, kind, text))
  return 1
}

/**
 * Decide what to do with a committed block the bridge is about to send.
 *
 * Returns `null` when the live stream already delivered exactly this text, the
 * remaining tail when it delivered a prefix, and the notification unchanged when
 * nothing was streamed for it (tool calls, other message kinds, or a live stream
 * that never started).
 */
export function filterCommitted(relay, sessionId, params) {
  const state = relay.sessions.get(sessionId)
  if (state === undefined) return params
  const kind = kindOfSessionUpdate(params?.update?.sessionUpdate)
  if (kind === undefined) return params
  const text = params?.update?.content?.text
  if (typeof text !== 'string' || text === '') return params

  for (const [index, entry] of [...state.blocks]) {
    // A match is a committed block that starts with what was streamed live;
    // the remainder (possibly nothing) is the part the client still needs.
    if (entry.kind !== kind || entry.text === '') continue
    if (!text.startsWith(entry.text)) continue
    state.blocks.delete(index)
    forget(relay, sessionId, state)
    relay.droppedCommits += 1
    const tail = text.slice(entry.text.length)
    if (tail === '') return null
    return {
      ...params,
      update: { ...params.update, content: { ...params.update.content, text: tail } },
    }
  }
  return params
}

/** Subscribe a context to the live stream. Returns a disposer. */
export function followAssistantStream(ctx, relay, send) {
  return ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    try {
      acceptFrame(relay, sessionId, frame, send)
    } catch {
      // A live-forwarding failure must never disturb the agent loop.
    }
  }, { global: true })
}
