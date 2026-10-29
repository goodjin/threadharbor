/**
 * 在会话区展开这一轮产出、交付或改动过的文本文件。
 *
 * 挂在 `conversation.chat.turnTail` 上，排在官方改动卡片之后。官方卡片照旧
 * 打开右侧对比。Markdown 按文档排版，其它文本按原文显示。默认收起，点击才展开并读取。
 * 展开后路径栏与正文隔开。双击正文收回。路径栏右侧可打开所在文件夹。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { FileTypeIcon, MarkdownText, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { fallbackT, NAMESPACE } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import {
  MARKDOWN_READ_LINE_CAP,
  isMarkdownPath,
  markdownSources,
  markdownPathsFromSummary,
  mergeMarkdownPaths,
  readMarkdownText,
} from './markdown-turn-sources.ts'
import type { MarkdownTurnReaders } from './markdown-turn-sources.ts'
import css from './markdown-turn.module.css'

/** turnTail 座位条目的 id。order 在官方卡片（默认 0）之后、找回入口（10）之前。 */
export const MARKDOWN_TAIL_ID = 'threadharbor-markdown-turn'
export const MARKDOWN_TAIL_ORDER = 5

/** 展开后的正文区：一屏高，再长就在这块里面滚动。 */
const BODY_STYLE = { maxHeight: '100dvh', overflow: 'auto' } as const

interface MarkdownTurnProps {
  readonly sessionId?: string
  readonly turn?: { readonly data: { get(key: string): unknown } }
  readonly t?: RuntimeT
  readonly readers: MarkdownTurnReaders
}

type SummaryExtra = readonly string[]

type DocumentBody =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly text: string; readonly truncated: boolean }

function labelsFor(t: RuntimeT): MarkdownLabels {
  return {
    code: {
      copyLabel: t('markdownTurn.copy'),
      copiedLabel: t('markdownTurn.copied'),
      toolbarLabels: {
        codeLabel: t('markdownTurn.code'),
        wrapLabel: t('markdownTurn.wrap'),
        unwrapLabel: t('markdownTurn.unwrap'),
      },
    },
    footnotes: t('markdownTurn.footnotes'),
  }
}

function MarkdownDocument({ sessionId, path, readers, t }: {
  sessionId: string
  path: string
  readers: MarkdownTurnReaders
  t: RuntimeT
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [body, setBody] = useState<DocumentBody>({ kind: 'loading' })
  const [revealError, setRevealError] = useState(false)
  const labels = useMemo(() => labelsFor(t), [t])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let cancelled = false
    setBody({ kind: 'loading' })
    void readMarkdownText(
      offset => readers.readPage(sessionId, path, offset, controller.signal),
      MARKDOWN_READ_LINE_CAP,
    ).then(result => {
      if (!cancelled) setBody({ kind: 'ready', text: result.text, truncated: result.truncated })
    }).catch(() => {
      if (!cancelled && !controller.signal.aborted) setBody({ kind: 'error' })
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [open, sessionId, path, readers, attempt])
  return <section className={css.document} data-markdown-path={path}>
    <div className={css.bar} data-path-bar="" {...(open ? { 'data-expanded': '' } : {})}>
      <button
        type="button"
        className={css.toggle}
        aria-expanded={open}
        aria-label={t(open ? 'markdownTurn.collapseAria' : 'markdownTurn.expandAria', { name: path })}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.identity}>
          <span className={css.icon} data-file-icon={classifyFileType(path)}>
            <FileTypeIcon path={path} size={16} />
          </span>
          <span className={css.name} title={path}>{path}</span>
        </span>
        <span className={css.action}>{t(open ? 'markdownTurn.collapse' : 'markdownTurn.expand')}</span>
      </button>
      <button
        type="button"
        className={css.reveal}
        aria-label={t('markdownTurn.reveal')}
        {...(revealError ? { 'data-reveal-error': '' } : {})}
        title={revealError ? t('markdownTurn.revealError') : t('markdownTurn.reveal')}
        onClick={() => {
          setRevealError(false)
          void readers.revealFile(sessionId, path).catch(() => { setRevealError(true) })
        }}
      >
        {revealError ? t('markdownTurn.revealError') : t('markdownTurn.reveal')}
      </button>
    </div>
    {open && <div
      className={css.body}
      data-markdown-body={path}
      style={BODY_STYLE}
      onDoubleClick={(event) => {
        const target = event.target
        if (target instanceof Element && target.closest('button, a')) return
        setOpen(false)
      }}
    >
      {body.kind === 'loading' && <p className={css.status}>{t('markdownTurn.loading')}</p>}
      {body.kind === 'error' && <p className={css.status}>
        {t('markdownTurn.error')}
        <button type="button" className={css.retry} onClick={() => { setAttempt(value => value + 1) }}>
          {t('markdownTurn.retry')}
        </button>
      </p>}
      {body.kind === 'ready' && <>
        {body.truncated && <p className={css.status}>{t('markdownTurn.truncated')}</p>}
        {isMarkdownPath(path)
          ? <MarkdownText text={body.text} streaming={false} labels={labels} />
          : <pre className={css.plain} data-markdown-plain={path}>{body.text}</pre>}
      </>}
    </div>}
  </section>
}

/**
 * 渲染这一轮的文本阅读区。没有文本文件、没有会话编号时不占位。
 * @param props - 轮次数据、会话编号、文案和读取口。
 * @returns 阅读区，或 null。
 */
export function MarkdownTurnTail({ sessionId, turn, t, readers }: MarkdownTurnProps): ReactNode {
  const sources = markdownSources(turn?.data.get('deliverables'))
  const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
  const changesSeq = sources?.changesSeq
  const translate = t ?? fallbackT
  const [extra, setExtra] = useState<SummaryExtra>([])
  useEffect(() => {
    if (id === undefined || changesSeq === undefined) {
      setExtra(current => current.length === 0 ? current : [])
      return
    }
    const controller = new AbortController()
    let cancelled = false
    void readers.loadSummary(id, changesSeq, controller.signal).then(value => {
      if (cancelled) return
      const parsed = markdownPathsFromSummary(value)
      const paths = parsed === 'invalid' ? [] : parsed
      setExtra(current => samePaths(current, paths) ? current : paths)
    }).catch(() => {
      if (!cancelled && !controller.signal.aborted) {
        setExtra(current => current.length === 0 ? current : [])
      }
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id, changesSeq, readers])
  if (id === undefined || sources === null) return null
  const paths = mergeMarkdownPaths(sources.paths, extra)
  if (paths.length === 0) return null
  return <div className={css.root} data-markdown-turn="">
    {paths.map(path => <MarkdownDocument key={path} sessionId={id} path={path} readers={readers} t={translate} />)}
  </div>
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

/** turnTail 座位宿主的结构类型（与找回入口同一写法）。 */
interface TailSlotHost {
  inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
  }, component: unknown): () => void
}

/**
 * 把阅读区挂进轮次结尾的列表座位。
 *
 * `slots.inject` 等 ui-chat 声明这个座位。声明方消失时贡献随之回收。
 * @param slots - 座位宿主（`ctx.slots`）。
 * @param readers - 读文件和读改动摘要的口子。
 * @returns 注册的清理函数。
 */
export function registerMarkdownTurn(slots: TailSlotHost, readers: MarkdownTurnReaders): () => void {
  return slots.inject('conversation.chat.turnTail', () => slots.register(
    {
      name: 'conversation.chat.turnTail',
      id: MARKDOWN_TAIL_ID,
      order: MARKDOWN_TAIL_ORDER,
      locale: NAMESPACE,
    },
    (props: { readonly sessionId?: string; readonly turn?: MarkdownTurnProps['turn']; readonly t?: RuntimeT }) => (
      <MarkdownTurnTail
        readers={readers}
        {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        {...(props.turn === undefined ? {} : { turn: props.turn })}
        {...(props.t === undefined ? {} : { t: props.t })}
      />
    ),
  )) as () => void
}
