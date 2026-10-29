/** Adapt the existing Chat builder; native rendering, tool cards and grouping remain its owners. */
import type {
  ConversationTimelineSnapshot, ConversationViewBuilder, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantChatData, ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ACP_PROCESS_DATA, pendingBlocks } from './acp-process-segments.ts'
import type { AcpProcessState, ProcessSegment, StepProse } from './acp-process-segments.ts'

export type SegmentChatData = AssistantChatData & { readonly acpProcessSegment?: ProcessSegment }
function traceOf(node: ChatNode, timeline: ConversationTimelineSnapshot): StepProse | undefined {
  if (node.kind !== 'assistant-step') return undefined
  const state: AcpProcessState | undefined = timeline.turns.get(node.data.turn)?.data.get(ACP_PROCESS_DATA)
  const step = state?.steps.get(node.data.step)
  return step?.acp && step.usable && step.segments.length > 0 ? step : undefined
}

/** One completed prose group, placed immediately before its first tool. */
function segmentNode(parent: ChatNode<'assistant-step'>, segment: ProcessSegment): ChatNode<'assistant-step'> {
  const data: SegmentChatData = {
    turn: parent.data.turn, step: parent.data.step, status: 'settled', time: segment.time,
    // A single renderable unit keeps the stock grouper from peeling reasoning
    // away from the text in this segment. The renderer uses the typed originals.
    blocks: [{ kind: 'text', text: segment.blocks.map(block => block.text).join('\n\n') }],
    acpProcessSegment: segment,
  }
  return {
    ...parent, key: `${parent.key}:acp-process:${segment.callId}`, id: `${parent.id}:${segment.callId}`,
    anchorSeq: segment.anchorSeq, visibility: 'visible', data,
  }
}
function tailNode(node: ChatNode<'assistant-step'>, step: StepProse): ChatNode<'assistant-step'> {
  const blocks = pendingBlocks(step)
  const running = node.location.kind === 'step' && node.location.step.status === 'open'
  const finalNode = node.data.finalNode === undefined ? undefined : { ...node.data.finalNode, blocks }
  const { finalNode: _oldFinal, ...data } = node.data
  return {
    ...node,
    anchorSeq: (!running ? finalNode?.seq : undefined) ?? step.anchorSeq ?? node.anchorSeq,
    visibility: blocks.some(block => block.text.trim() !== '') ? 'visible' : 'hidden',
    data: {
      ...data, blocks, status: running ? 'running' : node.data.status,
      ...(!running && finalNode !== undefined ? { finalNode } : {}),
    },
  }
}

/** Session-local transform, including hidden tombstones for retry/window replacement. */
export class AcpProcessNodes {
  private originals = new Map<string, ChatNode>()
  private rendered = new Map<string, ChatNode>()
  private cache = new WeakMap<object, { step: StepProse; nodes: readonly ChatNode[] }>()
  replace(nodes: readonly ChatNode[], timeline: ConversationTimelineSnapshot): readonly ChatNode[] {
    this.originals.clear()
    this.rendered.clear()
    for (const node of nodes) this.originals.set(node.key, node)
    const out = this.project(timeline)
    this.rendered = new Map(out.map(node => [node.key, node]))
    return out
  }
  apply(nodes: readonly ChatNode[], timeline: ConversationTimelineSnapshot): readonly ChatNode[] {
    for (const node of nodes) this.originals.set(node.key, node)
    const projected = this.project(timeline)
    const next = new Map(projected.map(node => [node.key, node]))
    const changed = projected.filter(node => this.rendered.get(node.key) !== node)
    for (const [key, node] of this.rendered) {
      if (!next.has(key)) changed.push({ ...node, visibility: 'hidden' })
    }
    this.rendered = next
    return changed
  }
  private project(timeline: ConversationTimelineSnapshot): ChatNode[] {
    const out: ChatNode[] = []
    for (const node of this.originals.values()) {
      const step = traceOf(node, timeline)
      if (node.kind !== 'assistant-step' || step === undefined) { out.push(node); continue }
      const cached = this.cache.get(node)
      if (cached?.step === step) { out.push(...cached.nodes); continue }
      const nodes = [...step.segments.map(segment => segmentNode(node, segment)), tailNode(node, step)]
      this.cache.set(node, { step, nodes })
      out.push(...nodes)
    }
    return out
  }
}

/** Preserve every builder method's receiver, especially groupInput and publish. */
export function withAcpProcessNodes<Snapshot>(builder: ConversationViewBuilder<ChatNode, Snapshot>): ConversationViewBuilder<ChatNode, Snapshot> {
  const nodes = new AcpProcessNodes()
  return {
    empty: builder.empty,
    replace: input => builder.replace({ ...input, nodes: nodes.replace(input.nodes, input.timeline) }),
    apply: input => builder.apply({ ...input, upserts: nodes.apply(input.upserts, input.timeline) }),
    ...(builder.groupInput === undefined ? {} : { groupInput: () => builder.groupInput!() }),
    ...(builder.publish === undefined ? {} : { publish: () => builder.publish!() }),
  }
}

/** Restore only our own factory; a later owner is never overwritten on disposal. */
export function wrapChatView(definition: ConversationViewDefinition): () => void {
  const original = definition.create
  const create = () => withAcpProcessNodes(original.call(definition) as ConversationViewBuilder<ChatNode, unknown>)
  definition.create = create
  return () => { if (definition.create === create) definition.create = original }
}
