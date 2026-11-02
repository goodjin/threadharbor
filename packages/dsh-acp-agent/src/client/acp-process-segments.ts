/** Presentation-only ACP segmentation. Durable messages and model history stay intact. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const ACP_PROCESS_DATA = 'threadharbor-acp-process'
export type ProseBlock = { readonly kind: 'text' | 'reasoning'; readonly text: string }
export type ProcessSegment = {
  readonly callId: string
  readonly anchorSeq: number
  readonly time: number
  readonly blocks: readonly ProseBlock[]
  readonly entries: readonly Pending[]
}
type Boundary = { readonly callId: string; readonly seq: number; readonly time: number; readonly beforeBlock?: number }
type Pending = { readonly index: number; readonly kind: ProseBlock['kind']; readonly text: string }
export type StepProse = {
  readonly acp: boolean
  readonly calls: readonly Boundary[]
  readonly boundaries: ReadonlyMap<string, number>
  readonly segments: readonly ProcessSegment[]
  readonly pending: readonly Pending[]
  readonly anchorSeq: number | undefined
  readonly time: number
  /** No trustworthy stream: leave the original message visible in full. */
  readonly usable: boolean
}
export type AcpProcessState = { readonly turn: number; readonly steps: ReadonlyMap<number, StepProse> }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap { 'threadharbor-acp-process': AcpProcessState }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
function emptyStep(): StepProse {
  return { acp: false, usable: true, calls: [], boundaries: new Map(), segments: [], pending: [], anchorSeq: undefined, time: 0 }
}
export function pendingBlocks(step: StepProse): readonly ProseBlock[] {
  return step.pending.map(({ kind, text }) => ({ kind, text }))
}
function appendDelta(entries: readonly Pending[], chunk: Record<string, unknown>): readonly Pending[] {
  const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
  const next = [...entries]
  const index = Number(chunk.index), text = String(chunk.text)
  const at = next.findIndex(entry => entry.index === index && entry.kind === kind)
  if (at < 0) next.push({ index, kind, text })
  else next[at] = { ...next[at]!, text: next[at]!.text + text }
  return next.sort((a, b) => a.index - b.index)
}
function completedSegment(call: Boundary, entries: readonly Pending[], time: number): ProcessSegment {
  return { callId: call.callId, anchorSeq: call.seq - 0.1, time, entries, blocks: entries.map(({ kind, text }) => ({ kind, text })) }
}
function delta(step: StepProse, chunk: Record<string, unknown>, time: number, seq: number): StepProse {
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return step
  if (typeof chunk.text !== 'string' || chunk.text === '' || typeof chunk.index !== 'number') return step
  // A queued earlier delta may reach the UI after its tool announcement.
  const call = step.calls.find(call => call.beforeBlock !== undefined && Number(chunk.index) < call.beforeBlock)
  if (call !== undefined) {
    const previous = step.segments.find(segment => segment.callId === call.callId)
    const segment = completedSegment(call, appendDelta(previous?.entries ?? [], chunk), previous?.time ?? time)
    return { ...step, segments: [...step.segments.filter(item => item.callId !== call.callId), segment].sort((a, b) => a.anchorSeq - b.anchorSeq) }
  }
  return { ...step, pending: appendDelta(step.pending, chunk), anchorSeq: step.anchorSeq ?? seq, time: step.pending.length === 0 ? time : step.time }
}

/**
 * Cards the ACP projection appends after the step's prose: its plan update
 * rides last as a synthetic settled `todo_write` call. Such a card owns no
 * prose, so it must never seal — otherwise the final answer ends up inside its
 * process segment and disappears when the turn's process is folded.
 */
const PROSE_FREE_CALL_IDS = new Set(['acp-plan'])
function seal(step: StepProse, call: Boundary): StepProse {
  if (PROSE_FREE_CALL_IDS.has(call.callId)) return step
  const entries = step.pending.filter(entry => call.beforeBlock === undefined || entry.index < call.beforeBlock)
  if (entries.length === 0) return step
  const pending = step.pending.filter(entry => !entries.includes(entry))
  return {
    ...step,
    segments: [...step.segments, completedSegment(call, entries, step.time)],
    pending, anchorSeq: pending.length === 0 ? undefined : call.seq + 0.1,
  }
}

/** Expand only actual text deltas; block-end repeats the completed body and is never appended. */
function reconstructFromContent(step: StepProse, content: readonly unknown[], calls: readonly Boundary[], seq: number): StepProse {
  // Walk the persisted blocks in order. A tool-call seals the prose accumulated
  // before it; a trailing run of pure text/reasoning is left pending so the
  // answer card can claim it. The usable check in `replay` still guards against
  // any text the content holds that this walk fails to place.
  let next: StepProse = { ...step, pending: [], segments: [], anchorSeq: undefined, usable: true }
  const open: Pending[] = []
  const flush = (): void => {
    if (open.length === 0) return
    const call = calls.find(candidate => !PROSE_FREE_CALL_IDS.has(candidate.callId)
      && !next.segments.some(segment => segment.callId === candidate.callId))
    const segment = completedSegment(call ?? { callId: 'content', seq: seq + 0.1, time: next.time || seq }, open, next.time || seq)
    next = { ...next, segments: [...next.segments, segment], anchorSeq: undefined }
    open.length = 0
  }
  for (const value of content) {
    const block = record(value)
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = typeof block.text === 'string' ? block.text : ''
      if (text !== '') open.push({ index: open.length, kind: block.type, text })
    } else if (block.type === 'tool-call' && !PROSE_FREE_CALL_IDS.has(String(block.id))) {
      flush()
    }
  }
  next = { ...next, pending: [...open], anchorSeq: open.length === 0 ? undefined : seq + 0.1 }
  return next
}

/** Expand only actual text deltas; block-end repeats the completed body and is never appended. */
function replay(step: StepProse, stream: readonly unknown[], content: readonly unknown[], seq: number): StepProse {
  let next: StepProse = { ...step, pending: [], segments: [], anchorSeq: undefined, usable: true }
  let cursor = 0
  const calls = [...step.calls].sort((a, b) => a.time - b.time || a.seq - b.seq)
  const feed = (chunk: Record<string, unknown>, time: number): void => {
    if (!Number.isFinite(time) || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return
    // Older logs lack the block marker. Millisecond timestamps are the best
    // available ordering there; newer logs use explicit block boundaries.
    while (cursor < calls.length) {
      const call = calls[cursor]!
      if (!(call.beforeBlock === undefined ? call.time < time : Number(chunk.index) >= call.beforeBlock)) break
      next = seal(next, call); cursor++
    }
    next = delta(next, chunk, time, calls[cursor - 1]?.seq === undefined ? seq : calls[cursor - 1]!.seq + 0.1)
  }
  const timed: { chunk: Record<string, unknown>; time: number }[] = []
  for (const value of stream) {
    const run = record(value)
    if (run.type === 'chunk') timed.push({ chunk: record(run.chunk), time: Number(run.time) })
    else if ((run.type === 'text-chunks' || run.type === 'reasoning-chunks') && Array.isArray(run.texts)) {
      let time = Number(run.time0)
      const dt = Array.isArray(run.dt) ? run.dt : []
      for (let i = 0; i < run.texts.length; i++) {
        if (i > 0) time += Number(dt[i - 1])
        timed.push({ chunk: { type: run.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: run.index, text: run.texts[i] }, time })
      }
    }
  }
  for (const token of timed.sort((a, b) => a.time - b.time)) feed(token.chunk, token.time)
  while (cursor < calls.length) next = seal(next, calls[cursor++]!)
  // Historical logs (qoder and friends) persist the final message as the raw
  // block sequence — reasoning and text as separate, un-merged blocks — but no
  // replayable chunk stream. Replay cannot order prose against tool boundaries
  // there, so fall back to the content block order itself: each tool-call seals
  // the prose before it into its own segment, and a trailing run of pure
  // text/reasoning stays pending for the answer card to claim. This keeps the
  // final answer out of the native reasoning fold on old sessions. The
  // discriminator is the block shape: a truncated live stream merges each kind
  // into a single block (one reasoning + one text, no separators); a real
  // history keeps the raw alternation, so some kind recurs or a tool-call
  // separates blocks. Either signal means the content is reconstructable; the
  // merged shape keeps the usable:false fallback to the stock card.
  const blocks = content.map(record)
  const hasToolCall = blocks.some(block => block.type === 'tool-call')
  const kindCount = (type: string): number => blocks.filter(block => block.type === type).length
  const isRawSequence = hasToolCall || kindCount('reasoning') > 1 || kindCount('text') > 1
  if (timed.length === 0 && stream.length === 0 && isRawSequence) next = reconstructFromContent(next, content, calls, seq)
  // Refuse partial/mismatched stream reconstruction; never hide unreconstructed text.
  const reconstructed = [...next.segments.flatMap(segment => segment.blocks), ...pendingBlocks(next)]
  for (const kind of ['text', 'reasoning'] as const) {
    const expected = content.map(record).filter(block => block.type === kind).map(block => block.text).join('')
    if (reconstructed.filter(block => block.kind === kind).map(block => block.text).join('') !== expected) {
      return { ...step, usable: false }
    }
  }
  return next
}

/** Fold the same events the stock conversation sees, for live output and history reload. */
export function foldAcpProcess(state: AcpProcessState, event: unknown): AcpProcessState {
  const row = record(event), data = record(row.data)
  if (typeof data.step !== 'number') return state
  const previous = state.steps.get(data.step) ?? emptyStep()
  let step = previous
  const seq = Number(row.seq), time = Number(row.time)
  if (row.type === 'llm/retry') step = emptyStep()
  else if (row.type === 'assistant/live-chunk') step = delta(step, record(data.chunk), time, seq)
  else if (row.type === 'assistant/message') {
    const message = record(data.message), source = record(message.source)
    const provider = typeof source.provider === 'string' ? source.provider : ''
    if (provider.startsWith('acp:') || (provider.startsWith('acp-') && provider !== 'acp-raw-output')) step = { ...step, acp: true }
    const content = Array.isArray(message.content) ? message.content : []
    const marker = record(record(record(source.replayState).response).threadharborAcpBoundary)
    if (step.acp && marker.version === 1 && Number.isInteger(marker.beforeBlock) && Number(marker.beforeBlock) >= 0) {
      const boundaries = new Map(step.boundaries)
      for (const value of content) {
        const block = record(value)
        if (block.type === 'tool-call' && typeof block.id === 'string') boundaries.set(block.id, Number(marker.beforeBlock))
      }
      step = { ...step, boundaries }
    }
    if (content.some(value => ['text', 'reasoning'].includes(String(record(value).type)))) {
      step = replay(step, Array.isArray(data.stream) ? data.stream : [], content, seq)
    }
  } else if (row.type === 'tool/call' && typeof data.callId === 'string'
    && !String(data.name).startsWith('外部输出') && !step.calls.some(call => call.callId === data.callId)) {
    const beforeBlock = step.boundaries.get(data.callId)
    const call = { callId: data.callId, seq, time, ...(beforeBlock === undefined ? {} : { beforeBlock }) }
    step = seal({ ...step, calls: [...step.calls, call] }, call)
  }
  if (step === previous) return state
  const steps = new Map(state.steps)
  steps.set(data.step, step)
  return { ...state, steps }
}

export const acpProcessDefinition: ConversationNodeDefinition<AcpProcessState> = {
  kind: ACP_PROCESS_DATA,
  match: event => {
    if (!['turn/start', 'assistant/live-chunk', 'assistant/message', 'tool/call', 'llm/retry'].includes(event.type)) return null
    const data = record(event.data)
    return typeof data.turn === 'number' ? { id: String(data.turn), role: 'start' } : null
  },
  start: (_context, match) => foldAcpProcess({ turn: Number(record(match.event.data).turn), steps: new Map() }, match.event),
  update: (context, match) => foldAcpProcess(context.state, match.event),
  publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate',
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.value === context.state) return previous
    return { kind: 'turn', turn: context.state.turn, key: ACP_PROCESS_DATA, value: context.state }
  },
}
