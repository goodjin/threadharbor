/**
 * 在会话区展开这一轮产出、交付、改动或输出里点名的文本文件。
 *
 * 挂在 `conversation.chat.turnTail` 上，排在官方改动卡片之后。官方卡片照旧
 * 打开右侧对比。Markdown 按文档排版，其它文本按原文显示。默认收起，点击才展开并读取。
 * 展开后路径栏与正文隔开。双击正文收回。路径栏右侧是打开方式下拉，最后一项打开文件夹。
 * 点开或收起时，路径栏留在点击时的视口位置。文件多于四篇时先只列出四篇。
 * 文件列表和每个文件框的右上、右下都用图标展开或收起。
 * 列表两端写着一共有多少个文件。
 * 路径文字在按钮外面，可以选中复制。
 * 助手正文里的本地文件链接也列在这里，用同一套下拉打开。链接上的点击由会话打开右侧。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, MarkdownText, classifyFileType, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileOpenSplit } from './markdown-turn-open.tsx'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { fallbackT, NAMESPACE } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import {
  MARKDOWN_READ_LINE_CAP,
  isMarkdownPath,
  linkedFilePathsFromTurn,
  markdownSources,
  markdownPathsFromSummary,
  mergeMarkdownPaths,
  readMarkdownText,
} from './markdown-turn-sources.ts'
import type { MarkdownTurnReaders } from './markdown-turn-sources.ts'
import css from './markdown-turn.module.css'

/** 和官方改动列表一样，超过这个数量先只列出这些，其余折在「全部」后面。 */
export const FOLDED_FILE_COUNT = 4

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


const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

interface FileTopHold {
  readonly bar: HTMLElement
  release(): void
}

/** 后一次点击替换前一次，避免两篇文件同时抢滚动位置。 */
let activeFileTopHold: FileTopHold | null = null

/** 会话真正滚动的那一层。网页外壳标了 `data-conversation-scroll`，否则沿祖先找可滚动的盒子。 */
function conversationScroller(node: HTMLElement): HTMLElement | null {
  const marked = node.closest<HTMLElement>('[data-conversation-scroll]')
  if (marked !== null) return marked
  let current = node.parentElement
  while (current !== null && current !== document.body && current !== document.documentElement) {
    const overflow = getComputedStyle(current).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return current
    current = current.parentElement
  }
  return null
}

/**
 * 记下路径栏此刻的视口位置，这块文件变高或变矮之后放回去。
 *
 * 会话停在底部时，阅读区一变高，官方跟随就会把滚动拉到最底。
 * 变高发生在布局之后，所以要等这一帧的尺寸通知再改滚动。
 * 用户自己滚动会话区之后不再干涉。
 * @param bar - 要对齐的元素。
 * @param block - 只观察这块的尺寸。缺省时用路径栏所在的文件块。
 */
function holdFileTop(bar: HTMLElement | null, block?: HTMLElement | null): void {
  activeFileTopHold?.release()
  activeFileTopHold = null
  if (bar === null || typeof ResizeObserver === 'undefined') return
  const scroller = conversationScroller(bar)
  if (scroller === null) return
  const section = block ?? bar.closest('section') ?? bar
  const top = bar.getBoundingClientRect().top
  let generation = 0
  let writing = false
  const apply = (): void => {
    if (generation !== 0) return
    const delta = bar.getBoundingClientRect().top - top
    if (Math.abs(delta) < 1) return
    writing = true
    scroller.scrollTop += delta
    writing = false
  }
  const release = (): void => {
    if (generation !== 0) return
    generation = 1
    observer.disconnect()
    scroller.removeEventListener('scroll', onScroll)
    scroller.removeEventListener('wheel', onUser, true)
    scroller.removeEventListener('touchmove', onUser, true)
    scroller.removeEventListener('keydown', onUser, true)
    if (activeFileTopHold === hold) activeFileTopHold = null
  }
  const onUser = (event: Event): void => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return
      release()
      return
    }
    // 滚轮落在正文里时，会话本身未必动。只有会话滚动变了才放手。
    const before = scroller.scrollTop
    requestAnimationFrame(() => {
      if (generation !== 0) return
      if (scroller.scrollTop !== before) release()
    })
  }
  const onScroll = (): void => {
    if (writing || generation !== 0) return
    // 跟随底部造成的滚动会在同一帧被 apply 抵消；两帧后路径栏仍偏离，才是用户自己在滚。
    requestAnimationFrame(() => {
      if (generation !== 0) return
      requestAnimationFrame(() => {
        if (generation !== 0) return
        if (Math.abs(bar.getBoundingClientRect().top - top) >= 1) release()
      })
    })
  }
  const observer = new ResizeObserver(() => {
    apply()
    requestAnimationFrame(() => { apply() })
  })
  observer.observe(section)
  scroller.addEventListener('scroll', onScroll, { passive: true })
  scroller.addEventListener('wheel', onUser, { passive: true, capture: true })
  scroller.addEventListener('touchmove', onUser, { passive: true, capture: true })
  scroller.addEventListener('keydown', onUser, true)
  requestAnimationFrame(() => { apply() })
  const hold: FileTopHold = { bar, release }
  activeFileTopHold = hold
}

function releaseHeldFileTop(bar: HTMLElement | null): void {
  if (bar !== null && activeFileTopHold?.bar === bar) activeFileTopHold.release()
}

type DocumentBody =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly text: string; readonly truncated: boolean }

function ExpandButton({ open, label, onClick, kind, caption }: {
  open: boolean
  label: string
  onClick: () => void
  kind?: 'more' | 'foot'
  caption?: string
}): ReactNode {
  return <button
    type="button"
    className={caption === undefined ? css.iconButton : `${css.iconButton} ${css.withCount}`}
    aria-expanded={open}
    aria-label={label}
    title={label}
    onClick={onClick}
    {...(kind === 'more' ? { 'data-markdown-more': '' } : {})}
    {...(kind === 'foot' ? { 'data-path-foot': '' } : {})}
  >
    {caption !== undefined && <span>{caption}</span>}
    {open ? <IconChevronUpOutlineRegular size={16} /> : <IconChevronDownOutlineRegular size={16} />}
  </button>
}

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
  const barRef = useRef<HTMLDivElement>(null)
  const labels = useMemo(() => labelsFor(t), [t])
  const toggleOpen = (): void => {
    holdFileTop(barRef.current)
    setOpen(value => !value)
  }
  useEffect(() => () => { releaseHeldFileTop(barRef.current) }, [])
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
  const toggleLabel = t(open ? 'markdownTurn.collapseAria' : 'markdownTurn.expandAria', { name: path })
  return <section className={css.document} data-markdown-path={path}>
    <div ref={barRef} className={css.bar} data-path-bar="" {...(open ? { 'data-expanded': '' } : {})}>
      <span className={css.icon} data-file-icon={classifyFileType(path)}>
        <FileTypeIcon path={path} size={16} />
      </span>
      <span
        className={css.name}
        data-path={path}
        title={path}
        onCopy={(event) => {
          const board = event.clipboardData
          if (board === null) return
          board.setData('text/plain', path)
          event.preventDefault()
        }}
      >{path}</span>
      <ExpandButton open={open} label={toggleLabel} onClick={toggleOpen} />
      <FileOpenSplit sessionId={sessionId} path={path} readers={readers} t={t} />
    </div>
    {open && <div
      className={css.body}
      data-markdown-body={path}
      style={BODY_STYLE}
      onDoubleClick={(event) => {
        const target = event.target
        if (target instanceof Element && target.closest('button, a')) return
        holdFileTop(barRef.current)
        setOpen(false)
      }}
    >
      {body.kind === 'loading' && <p className={css.status}>{t('markdownTurn.loading')}</p>}
      {body.kind === 'error' && <p className={css.status}>
        {t('markdownTurn.error')}
        <button type="button" className={css.retry} onClick={() => {
          holdFileTop(barRef.current)
          setAttempt(value => value + 1)
        }}>
          {t('markdownTurn.retry')}
        </button>
      </p>}
      {body.kind === 'ready' && <>
        {body.truncated && <p className={css.status}>{t('markdownTurn.truncated')}</p>}
        {isMarkdownPath(path)
          ? <MarkdownText text={body.text} streaming={false} labels={labels} />
          : <CodeBlock
              code={body.text}
              lang={languageForPath(path)}
              streaming={false}
              copyLabel={t('markdownTurn.copy')}
              copiedLabel={t('markdownTurn.copied')}
              toolbarLabels={{
                codeLabel: t('markdownTurn.code'),
                wrapLabel: t('markdownTurn.wrap'),
                unwrapLabel: t('markdownTurn.unwrap'),
              }}
            />}
      </>}
    </div>}
    {open && <div className={css.foot}>
      <ExpandButton open={open} label={toggleLabel} onClick={toggleOpen} kind="foot" />
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
  const linked = linkedFilePathsFromTurn(turn)
  const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
  const changesSeq = sources?.changesSeq
  const translate = t ?? fallbackT
  const rootRef = useRef<HTMLDivElement>(null)
  const [extra, setExtra] = useState<SummaryExtra>([])
  const [listOpen, setListOpen] = useState(false)
  useEffect(() => () => { releaseHeldFileTop(rootRef.current) }, [])
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
  if (id === undefined) return null
  const paths = mergeMarkdownPaths(mergeMarkdownPaths(sources?.paths ?? [], extra), linked)
  if (paths.length === 0) return null
  const folded = paths.length > FOLDED_FILE_COUNT && !listOpen
  const shown = folded ? paths.slice(0, FOLDED_FILE_COUNT) : paths
  const listLabel = translate(listOpen ? 'markdownTurn.filesCollapseAria' : 'markdownTurn.filesAllAria', { count: String(paths.length) })
  const listCount = translate(listOpen ? 'markdownTurn.collapse' : 'markdownTurn.filesAll', { count: String(paths.length) })
  const toggleList = (): void => {
    holdFileTop(rootRef.current, rootRef.current)
    setListOpen(value => !value)
  }
  return <div ref={rootRef} className={css.root} data-markdown-turn="" {...(folded ? { 'data-markdown-folded': '' } : {})}>
    {shown.map(path => <MarkdownDocument key={path} sessionId={id} path={path} readers={readers} t={translate} />)}
    {paths.length > FOLDED_FILE_COUNT && <div className={css.edge}>
      <ExpandButton open={listOpen} label={listLabel} caption={listCount} onClick={toggleList} kind="more" />
    </div>}
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
