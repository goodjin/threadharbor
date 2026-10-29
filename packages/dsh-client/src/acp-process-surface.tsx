import { createElement } from 'react'
import type { ComponentType } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { acpProcessDefinition } from './acp-process-segments.ts'
import { wrapChatView } from './acp-process-view.ts'
import type { SegmentChatData } from './acp-process-view.ts'
import type { ProcessSegment } from './acp-process-segments.ts'
import { AnswerCard } from './answer-card.tsx'
import styles from './acp-process.module.css'

/** The segment is one presentation unit; individual deltas never create separate rows. */
export function AcpProcessBlock({ segment, t }: { readonly segment: ProcessSegment; readonly t: ChatNodeViewProps<'assistant-step'>['t'] }) {
  // The running host adds these shared Chat labels after the pinned 0.2.0 types.
  const translate = t as (key: string) => string
  const labels = {
    code: { copyLabel: translate('copy'), copiedLabel: translate('copied'), toolbarLabels: { codeLabel: translate('codeBlock.title'), wrapLabel: translate('codeBlock.wrap'), unwrapLabel: translate('codeBlock.unwrap') } },
    footnotes: translate('markdown.footnotes'),
  }
  return <div className={styles.segment} data-acp-process-segment={segment.callId}>
    {segment.blocks.map((block, index) => <div key={index} className={block.kind === 'reasoning' ? styles.reasoning : undefined}>
      <MarkdownText text={block.text} streaming={false} labels={labels} />
    </div>)}
  </div>
}

type Surface = {
  readonly slots: unknown
  get(name: string): unknown
  effect(callback: () => (() => void), name?: string): unknown
}
type Registry = {
  views: { entries(): readonly ConversationViewDefinition[]; subscribe(fn: () => void): () => void }
  events: { register(definition: ConversationNodeDefinition): () => void }
}

/** Reuse the registered native renderer and all its injected hooks for ordinary messages. */
export function registerAcpProcessSurface(ctx: Surface): void {
  const ui = ctx.get('uiConversation') as Registry | undefined
  const slots = ctx.slots as Pick<SlotCore, 'entries' | 'subscribe'> & {
    register(options: { name: string; key: string; priority: number; locale?: string; inject?: StoredEntry['inject'] }, component: unknown): () => void
  }
  if (typeof ui?.views?.entries !== 'function' || typeof ui.views.subscribe !== 'function'
    || typeof ui.events?.register !== 'function' || typeof slots?.entries !== 'function'
    || typeof slots.subscribe !== 'function' || typeof slots.register !== 'function') return
  ctx.effect(() => {
    let active: ConversationViewDefinition | undefined
    let restore: (() => void) | undefined
    let removeDefinition: (() => void) | undefined
    const attachView = (): void => {
      const view = ui.views.entries().find(candidate => candidate.target === 'chat')
      if (view === undefined || view === active) return
      restore?.()
      active = view
      restore = wrapChatView(view)
      // Registration invalidates existing builders too, including already open tabs.
      removeDefinition?.()
      removeDefinition = ui.events.register(acpProcessDefinition as ConversationNodeDefinition)
    }
    const unsubscribeView = ui.views.subscribe(attachView)
    attachView()
    let removeRenderer: (() => void) | undefined
    let originalComponent: unknown
    let installing = false
    const attachRenderer = (): void => {
      if (installing) return
      const entry = slots.entries('conversation.chat.node').find(candidate => candidate.options.key === 'assistant-step' && (candidate.options.priority ?? 0) >= 0)
      if (entry === undefined || entry.component === originalComponent) return
      installing = true
      try {
        removeRenderer?.()
        originalComponent = entry.component
        const Native = entry.component as ComponentType<ChatNodeViewProps<'assistant-step'>>
        const Renderer = (props: ChatNodeViewProps<'assistant-step'>) => {
          const segment = (props.node.data as SegmentChatData).acpProcessSegment
          if (segment !== undefined) return <AcpProcessBlock segment={segment} t={props.t} />
          // The turn-process projection marks the finalized answer step. Wrapping it
          // here boxes the final answer for every session type (plain DSH and ACP);
          // thinking stays inside and keeps its native fold/expand behavior.
          const answerStep = props.turnProcess?.spec.answerStep
          const isAnswer = answerStep != null && answerStep === props.node.data.step
          const native = createElement(Native, props)
          if (!isAnswer) return native
          const hasProse = props.node.data.blocks.some(block =>
            (block.kind === 'text' || block.kind === 'reasoning') &&
            (block.text?.trim() ?? '') !== '')
          return hasProse
            ? <AnswerCard blocks={props.node.data.blocks} t={props.t as (key: string) => string}>{native}</AnswerCard>
            : native
        }
        removeRenderer = slots.register({
          name: 'conversation.chat.node', key: 'assistant-step', priority: -20,
          ...(entry.locale === undefined ? {} : { locale: entry.locale }),
          ...(entry.inject === undefined ? {} : { inject: entry.inject }),
        }, Renderer)
      } finally { installing = false }
    }
    const unsubscribeRenderer = slots.subscribe('conversation.chat.node', attachRenderer)
    attachRenderer()
    return () => {
      unsubscribeView(); unsubscribeRenderer()
      restore?.(); removeDefinition?.(); removeRenderer?.()
    }
  }, 'threadharbor ACP process segments')
}
