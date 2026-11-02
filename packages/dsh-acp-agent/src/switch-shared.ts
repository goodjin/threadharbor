/**
 * What every mounted row of this plugin shares, in one place.
 *
 * A switch is a cross-row act: a session on the grok row picks a codex model,
 * and the session it continues in is driven by the codex row. The two halves
 * meet here, because rows cannot see each other's composition — a row is
 * mounted inside its own preset's scope, and the registry's leak audit rightly
 * forbids a row from providing services the others could read.
 *
 * Two facts make a process-global module the honest shape rather than a hack:
 * each DSH process hosts exactly one machine's preset registry (design doc
 * §2.7c — one preset registry per process, isolated across hosts by nature),
 * and every row of this plugin in the process imports one module instance.
 * A host restart clears both tables, which is correct: nothing links the old
 * process's handovers to the new one, and the presets remount from config.
 */

import type { AcpPresetConfig, PresetConfig } from './registry.ts'

/** How many characters of one tool result travel; the rest is cut. */
const TOOL_RESULT_LIMIT = 500

/** One rendered line of the replay text, tagged by what it came from. */
type ReplayLine = {
  readonly kind: 'user' | 'assistant' | 'tool' | 'result'
  readonly text: string
}

/** One content block's text, or nothing when it carries none. */
function blockTextOf(block: unknown): string {
  if (typeof block === 'string') return block
  const record = (typeof block === 'object' && block !== null ? block : {}) as { type?: unknown; text?: unknown }
  return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
}

/** Flatten one log message's content — a string or a block array — to its text. */
function messageTextOf(message: unknown): string {
  const record = (typeof message === 'object' && message !== null ? message : {}) as { content?: unknown }
  if (typeof record.content === 'string') return record.content
  if (!Array.isArray(record.content)) return ''
  return record.content.map(blockTextOf).filter(text => text !== '').join('\n')
}

/** Read one logged event into a replay line, or nothing when it carries none. */
function replayLineOf(event: unknown): ReplayLine | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as { type?: unknown; data?: unknown }
  const data = (typeof record.data === 'object' && record.data !== null ? record.data : {}) as {
    message?: unknown
    name?: unknown
  }
  switch (record.type) {
    case 'user/message': {
      const text = messageTextOf(record.data)
      return text === '' ? undefined : { kind: 'user', text }
    }
    case 'assistant/message': {
      const text = messageTextOf(data.message)
      return text === '' ? undefined : { kind: 'assistant', text }
    }
    case 'tool/call':
      return typeof data.name === 'string' && data.name !== '' ? { kind: 'tool', text: data.name } : undefined
    case 'tool/result': {
      const text = messageTextOf(data.message)
      if (text === '') return undefined
      return { kind: 'result', text: text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}…` : text }
    }
    default:
      return undefined
  }
}

/** The label each replay line carries, named so a model reads the exchange. */
const LABEL_OF: Readonly<Record<ReplayLine['kind'], string>> = {
  user: '【用户】',
  assistant: '【助手】',
  tool: '【工具】',
  result: '【工具结果】',
}

/**
 * Render the transcript into the replay text.
 *
 * Every finished turn travels whole — only a single tool result is cut, at
 * `TOOL_RESULT_LIMIT`. The trailing user messages are dropped: the dispatch
 * writes the opening turn's question to the log before its step runs, so those
 * trailing messages are the question the prompt itself carries, and keeping
 * them here would read the same words to the agent twice.
 */
function renderReplay(events: readonly unknown[]): string | undefined {
  const lines: ReplayLine[] = []
  for (const event of events) {
    const line = replayLineOf(event)
    if (line !== undefined) lines.push(line)
  }
  let end = lines.length
  while (end > 0 && lines[end - 1]!.kind === 'user') end -= 1
  const kept = lines.slice(0, end)
  if (kept.length === 0) return undefined
  return kept.map(line => `${LABEL_OF[line.kind]}${line.text}`).join('\n')
}

/**
 * The transcript events of one host session, read structurally.
 *
 * A live session exposes a snapshot read; a query lease exposes the events
 * array directly. Whatever shape answers, an unreadable one is absence — the
 * caller replays nothing rather than failing the turn.
 */
function sessionEvents(session: unknown): readonly unknown[] | undefined {
  const record = session as { snapshotEvents?: unknown; ownEvents?: unknown; events?: unknown }
  for (const read of [record.snapshotEvents, record.ownEvents]) {
    if (typeof read !== 'function') continue
    try {
      const events = (read as (this: unknown) => unknown).call(session)
      if (Array.isArray(events)) return events
    } catch {
      // Fall through to the next reader; absence is handled below.
    }
  }
  return Array.isArray(record.events) ? record.events : undefined
}

/** One model a mounted preset serves, with what planning needs to know about it. */
export type MountedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * The target's context window in tokens, when the configuration declares one.
   *
   * Declared, never probed: the planner may refuse a switch only on a number
   * the target actually claims, and the catalog is deliberately built without
   * opening the agent. An absent number means "unknown", and the handover
   * then never refuses on size.
   */
  readonly contextWindow?: number
}

/** The switch one source session already made, so a repeat points instead of duplicating. */
export type SwitchRecord = { readonly target: string; readonly sessionId: string }

/** What one row registers about itself at mount, for the other rows' switches. */
export type SwitchShared = {
  /** Add one mounted preset with the models it offers here. */
  registerPreset(presetId: string, preset: AcpPresetConfig, models: readonly MountedModel[]): void
  /** Every mounted preset, as the planner's view of what this host can switch to. */
  config(): PresetConfig
  /** The models one mounted preset serves here; empty for an unknown preset. */
  modelsOf(presetId: string): readonly MountedModel[]
  /** The declared window of one exact model, when its configuration names one. */
  contextWindowOf(presetId: string, modelId: string): number | undefined
  /** Whether a session id is still a live session on this host. */
  sessionExists(sessionId: string): boolean
  /** Give the host's session service to the liveness check; the entry wires this at mount. */
  wireSessions(reader: ((sessionId: string) => unknown) | undefined): void

  /** Store the text that primes a new conversation's first model request. */
  primeHandover(sessionId: string, text: string): void
  /** Take the priming text for a session, removing it — the first attempt owns it. */
  takeHandover(sessionId: string): string | undefined
  /** Put a priming text back after its first attempt failed to deliver it. */
  restoreHandover(sessionId: string, text: string): void

  /**
   * The session's earlier conversation, rendered as previous-conversation text.
   *
   * Read from the host's own transcript, so a fresh external conversation can
   * pick the history back up after the connection that held it is gone.
   * `undefined` when the session cannot be read or carries nothing before the
   * question now being asked — there is then nothing to replay, and the first
   * request stays exactly the question.
   */
  replayPrimer(sessionId: string): string | undefined

  /** Remember the switch a source session already made. */
  recordSwitch(sourceSessionId: string, record: SwitchRecord): void
  /** The switch a source session already made, while its new session still exists. */
  switchFor(sourceSessionId: string): SwitchRecord | undefined
}

export function makeSwitchShared(reads: {
  /** Read a live session by id; absent when the host exposes none. */
  sessionById?(sessionId: string): unknown
} = {}): SwitchShared {
  const presets = new Map<string, { preset: AcpPresetConfig; models: readonly MountedModel[] }>()
  const primed = new Map<string, string>()
  const switched = new Map<string, SwitchRecord>()
  let sessionById = reads.sessionById
  return {
    registerPreset(presetId, preset, models): void {
      presets.set(presetId, { preset, models })
    },
    config(): PresetConfig {
      const entries: Record<string, AcpPresetConfig> = {}
      for (const [presetId, mounted] of presets) entries[presetId] = mounted.preset
      return { presets: entries }
    },
    modelsOf(presetId): readonly MountedModel[] {
      return presets.get(presetId)?.models ?? []
    },
    contextWindowOf(presetId, modelId): number | undefined {
      const found = presets.get(presetId)?.models.find(model => model.id === modelId)
      const window = found?.contextWindow
      return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined
    },
    sessionExists(sessionId): boolean {
      if (sessionById === undefined) return true
      return sessionById(sessionId) !== undefined
    },
    wireSessions(reader): void {
      sessionById = reader
    },
    primeHandover(sessionId, text): void {
      primed.set(sessionId, text)
    },
    takeHandover(sessionId): string | undefined {
      const text = primed.get(sessionId)
      if (text !== undefined) primed.delete(sessionId)
      return text
    },
    restoreHandover(sessionId, text): void {
      primed.set(sessionId, text)
    },
    replayPrimer(sessionId): string | undefined {
      let session: unknown
      try {
        session = sessionById?.(sessionId)
      } catch {
        // An unreadable session replays nothing; the first request stays the
        // question alone rather than failing the turn over a display read.
        return undefined
      }
      if (session === undefined || session === null) return undefined
      const events = sessionEvents(session)
      if (events === undefined) return undefined
      return renderReplay(events)
    },
    recordSwitch(sourceSessionId, record): void {
      switched.set(sourceSessionId, record)
    },
    switchFor(sourceSessionId): SwitchRecord | undefined {
      const record = switched.get(sourceSessionId)
      if (record === undefined) return undefined
      // A switch whose new session is gone (deleted, or the host restarted and
      // forgot it) no longer points anywhere: fall through and let the switch
      // be made again rather than naming a session that is not there.
      if (!this.sessionExists(record.sessionId)) return undefined
      return record
    },
  }
}

/**
 * The process-wide fabric every mounted row shares.
 *
 * Session liveness reads through the host's own session service when one is
 * injected (the entry wires it); standalone tests register without it, where
 * "still exists" means "not proven gone".
 */
export const switchShared: SwitchShared = makeSwitchShared()
