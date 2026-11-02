import { createElement, useCallback, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { acpProcessDefinition } from './acp-process-segments.ts'
import { wrapChatView } from './acp-process-view.ts'
import type { SegmentChatData } from './acp-process-view.ts'
import type { ProcessSegment } from './acp-process-segments.ts'
import { AnswerCard } from './answer-card.tsx'
import { createMarkdownTurnReaders } from './markdown-turn-sources.ts'
import type { MarkdownTurnReaders } from './markdown-turn-sources.ts'
import { NAMESPACE, fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import { defaultLinkOpenMode, httpLinkHref, openInBrowser } from './link-open.ts'
import styles from './acp-process.module.css'

/**
 * 文本块渲染结果：http(s) 链接 hover 时浮出「右侧打开 / 浏览器打开」两个按钮，
 * 单击链接走默认打开方式（存 localStorage，见 link-open.ts）。
 *
 * 编译包 `MarkdownText` 把 http(s) 渲染成普通 `<a target="_blank">`，无法注入 React，
 * 所以这里给容器叠 DOM 层：`mouseover` 识别指针下的链接并在其旁浮出工具条，`mouseout`
 * 离开后隐藏；`onClick` 在默认=浏览器时拦截并 `window.open`，默认=右侧时不拦截、让宿主
 * 右侧预览面板接管。
 */
function LinkTextBlock({ text, labels }: { readonly text: string; readonly labels: MarkdownLabels }) {
  const [hovered, setHovered] = useState<{ url: string; top: number; left: number } | null>(null)

  const hideTools = useCallback(() => setHovered(null), [])

  const onOver = useCallback((event: React.MouseEvent) => {
    const target = event.target as Element | null
    const anchor = target === null ? null : target.closest('a')
    if (anchor === null) return
    const url = httpLinkHref(anchor.getAttribute('href'))
    if (url === null) return
    const rect = anchor.getBoundingClientRect()
    setHovered({ url, top: rect.bottom + 4, left: rect.left })
  }, [])

  const onOut = useCallback((event: React.MouseEvent) => {
    // 指针移到工具条自身时不隐藏（工具条是容器兄弟，在容器外）。
    if ((event.relatedTarget as Element | null)?.closest?.('[data-link-tools]') !== null) return
    const from = event.target as Element | null
    const fromAnchor = from === null ? null : from.closest('a')
    const toAnchor = (event.relatedTarget as Element | null)?.closest('a') ?? null
    if (fromAnchor !== null && fromAnchor === toAnchor) return
    hideTools()
  }, [hideTools])

  const onClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as Element | null
    const anchor = target === null ? null : target.closest('a')
    if (anchor === null) return
    const url = httpLinkHref(anchor.getAttribute('href'))
    if (url === null) return
    if (defaultLinkOpenMode() !== 'browser') return
    event.preventDefault()
    openInBrowser(url)
    hideTools()
  }, [hideTools])

  useEffect(() => {
    if (hovered === null) return
    const onScrollOrResize = () => hideTools()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [hovered, hideTools])

  return (
    <div
      data-link-text-block=""
      onMouseOver={onOver}
      onMouseOut={onOut}
      onClick={onClick}
    >
      <MarkdownText text={text} streaming={false} labels={labels} />
      {hovered !== null && (
        <div className={styles.linkTools} data-link-tools={hovered.url} style={{ top: hovered.top, left: hovered.left }}>
          <button
            type="button"
            className={styles.linkTool}
            data-link-action="right"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); hideTools() }}
          >
            右侧打开
          </button>
          <button
            type="button"
            className={styles.linkTool}
            data-link-action="browser"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); openInBrowser(hovered.url); hideTools() }}
          >
            浏览器打开
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 当前会话编号。chat 节点的 view props 不带 sessionId，但会话根节点把它标在
 * `data-conversation-session` 上（和 markdown-turn 找滚动层同一套 DOM 读法）。
 * 拿不到返回 undefined，结果卡的编辑入口据此不放。
 */
function currentSessionIdFromDom(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const node = document.querySelector('[data-conversation-session]')
  const value = node?.getAttribute('data-conversation-session')
  return value === null || value === '' ? undefined : value
}

/** 绑定本插件词典的 t：宿主 locale 服务给出 bind，缺席则 undefined。 */
function localeBindOf(ctx: Surface): RuntimeT | undefined {
  const service = ctx.get('locale')
  if (service === null || typeof service !== 'object') return undefined
  const bind = (service as { bind?: unknown }).bind
  if (typeof bind !== 'function') return undefined
  try {
    const bound = (bind as (ns: string) => unknown)(NAMESPACE)
    return typeof bound === 'function' ? (bound as RuntimeT) : undefined
  } catch {
    return undefined
  }
}

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
      {block.kind === 'text'
        ? <LinkTextBlock text={block.text ?? ''} labels={labels} />
        : <MarkdownText text={block.text} streaming={false} labels={labels} />}
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
  // 结果卡的编辑功能复用文件阅读区那套 readers：发送到会话 / 新建会话都走这里。
  const readers: MarkdownTurnReaders = createMarkdownTurnReaders(() => ctx.get('remote'))
  // 结果卡文案（编辑/发送/取消/复制等）走本插件词典，不是 chat 节点自带的 t——
  // 后者不认 answerCard.* / markdownTurn.*，会把 key 原样显示出来。绑定本插件的
  // NAMESPACE，拿到能翻译这些键的 t；服务缺席时退化到词典原文（fallbackT）。
  const dshT: RuntimeT = localeBindOf(ctx) ?? fallbackT
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
            ? <AnswerCard blocks={props.node.data.blocks} sessionId={currentSessionIdFromDom()} readers={readers} t={dshT as (key: string) => string}>{native}</AnswerCard>
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
