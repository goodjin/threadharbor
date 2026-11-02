/**
 * 在会话区展开这一轮产出、交付、改动或输出里点名的文本文件。
 *
 * 挂在 `conversation.chat.turnTail` 上，排在官方改动卡片之后。官方卡片照旧
 * 打开右侧对比。Markdown 按文档排版，其它文本按原文显示。默认收起，点击才展开并读取。
 * 展开后路径栏与正文隔开。双击正文收回。路径栏右侧是打开方式下拉，最上面复制路径，最后一项打开文件夹。
 * 点开或收起时，路径栏留在点击时的视口位置。文件多于四篇时先只列出四篇。
 * 文件列表和每个文件框的右上、右下都用图标展开或收起。
 * 列表两端写着一共有多少个文件。
 * 路径文字在按钮外面，可以选中复制。
 * 助手正文里的本地文件链接也列在这里，用同一套下拉打开。链接上的点击由会话打开右侧。
 */

import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular, IconEditOutlineRegular, IconNewChatOutlineRegular, IconSendOutlineRegular, IconWarningOutlineRegular, MarkdownText, Toast, classifyFileType, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileOpenSplit } from './markdown-turn-open.tsx'
import { ActiveFileBar } from './markdown-turn-active-bar.tsx'
import { getFileState, setActiveFilePath, subscribeActiveFilePath, toggleFileEditing, toggleFileOpen } from './markdown-turn-active.ts'
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
  /** 发送/复制失败的提示出口。缺省时不提示。 */
  readonly onNotify?: (message: string) => void
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
  | { readonly kind: 'error'; readonly message?: string }
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
    {...(kind === undefined ? { 'data-expand-toggle': '' } : {})}
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

/** 正文块级元素的选择器：编译包 class 运行时哈希，靠标签名定位。 */
const MARKDOWN_BLOCK = ':is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)'

/** 取一段正文的纯文本：块级元素去掉首尾多余空白。 */
function blockText(block: Element): string {
  return (block.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 找点击落在正文里的那个块级元素，没有返回 null。 */
function markdownBlockFrom(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest(MARKDOWN_BLOCK)
}

/** 把宿主底部输入框滚动挤出视口（方案 A：不改宿主，只滚动）。 */
function scrollComposerOutOfView(bar: HTMLElement | null): void {
  const scroller = conversationScroller(bar ?? document.body)
  if (scroller === null) return
  const composer = document.querySelector<HTMLElement>('[data-composer-seat], [data-conversation-region="composer"]')
  if (composer === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const composerRect = composer.getBoundingClientRect()
  if (composerRect.top < scrollerRect.bottom && composerRect.bottom > scrollerRect.top) {
    scroller.scrollTop += composerRect.bottom - scrollerRect.top + 8
  }
}

/** 把宿主底部输入框滚回视口（compose/评论发送后调用，与 scrollComposerOutOfView 对称）。 */
function scrollComposerIntoView(bar: HTMLElement | null): void {
  const scroller = conversationScroller(bar ?? document.body)
  if (scroller === null) return
  const composer = document.querySelector<HTMLElement>('[data-composer-seat], [data-conversation-region="composer"]')
  if (composer === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const composerRect = composer.getBoundingClientRect()
  if (composerRect.top < scrollerRect.top || composerRect.bottom > scrollerRect.bottom) {
    scroller.scrollTop -= scrollerRect.bottom - composerRect.top + 8
  }
}

/**
 * 把用户评论按文档顺序合进原文：每条评论挂在它所评的那段正文后，
 * 用引用块 + 一句说明标记。段落之间、评论与下一段之间各加一个换行。
 * @param source - 文档原文。
 * @param comments - 每条评论及其所评正文的纯文本。
 * @returns 合成后的文本。
 */
export function composeWithComments(source: string, comments: readonly { blockText: string; comment: string }[]): string {
  const note = '> 这是用户对此段话的评论：'
  let out = source
  // 记录上一次插入位置：同一段多条评论锚点相同，须排在前一条之后而非之前。
  let lastInsertAt = -1
  for (const { blockText, comment } of comments) {
    if (blockText === '' || comment.trim() === '') continue
    const at = out.indexOf(blockText)
    if (at < 0) continue
    let insertAt = at + blockText.length
    if (insertAt <= lastInsertAt) insertAt = lastInsertAt
    // 紧接所评正文后插入「换行 + 引用标记 + 评论」；段间原有的空行分隔自然保留。
    out = `${out.slice(0, insertAt)}\n\n${note}\n${comment.trim()}${out.slice(insertAt)}`
    lastInsertAt = insertAt + `\n\n${note}\n${comment.trim()}`.length
  }
  return out
}

/**
 * 把文档原文按评论锚点切成有序片段：每段后跟着挂在该处的评论。
 * 评论锚点是它在原文里那段正文的纯文本（与 composeWithComments 同一套 indexOf 匹配），
 * 据此定位插入点，使评论渲染在所评段之后，而非堆在文档底部。
 * @returns 按原文顺序排列的 { text, comments } 片段；comments 为该片段正文之后的评论。
 */
export function segmentWithComments(source: string, comments: readonly { id: number; blockText: string; comment: string }[]): { text: string; comments: { id: number; comment: string }[] }[] {
  const marks = comments
    .filter(c => c.blockText !== '' && c.comment.trim() !== '')
    .map(c => ({ offset: source.indexOf(c.blockText), len: c.blockText.length, id: c.id, comment: c.comment.trim() }))
    .filter(m => m.offset >= 0)
    .sort((a, b) => a.offset - b.offset)
  const segments: { text: string; comments: { id: number; comment: string }[] }[] = []
  let cursor = 0
  let bucket: { id: number; comment: string }[] = []
  for (const mark of marks){
    if (mark.offset < cursor) continue // 与已处理锚点重叠，跳过
    bucket.push({ id: mark.id, comment: mark.comment })
    segments.push({ text: source.slice(cursor, mark.offset + mark.len), comments: bucket })
    bucket = []
    cursor = mark.offset + mark.len
  }
  segments.push({ text: source.slice(cursor), comments: bucket })
  return segments
}

function MarkdownDocument({ sessionId, path, readers, t, onNotify }: {
  sessionId: string
  path: string
  readers: MarkdownTurnReaders
  t: RuntimeT
  onNotify?: (message: string) => void
}): ReactNode {
  // 展开/编辑态存共享 store（不是本地 useState）：顶部 ActiveFileBar 的编辑/展开
  // 按钮和这里的内联按钮改同一份，两处才能同步。按 path 取值，多个文件各自独立。
  const fileUi = useSyncExternalStore(subscribeActiveFilePath, () => getFileState(path), () => getFileState(path))
  const open = fileUi.open
  const editing = fileUi.editing
  const [attempt, setAttempt] = useState(0)
  const [body, setBody] = useState<DocumentBody>({ kind: 'loading' })
  const barRef = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef<Element | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const selBarRef = useRef<HTMLDivElement>(null)
  const [selBar, setSelBar] = useState<{ text: string } | null>(null)
  // 点「评论」那一刻快照所评块：此后聚焦输入框会塌缩文档选区，届时再读选区已拿不到锚点。
  const commentAnchorRef = useRef<string>('')
  const [commenting, setCommenting] = useState(false)
  const [comments, setComments] = useState<readonly { id: number; blockText: string; comment: string }[]>([])
  const commentIdRef = useRef(0)
  const [composeOpen, setComposeOpen] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string; ok: boolean } | null>(null)
  const toastSeq = useRef(0)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const labels = useMemo(() => labelsFor(t), [t])
  // 失败提示既走外部 onNotify（若接了宿主 toast），也在文档框内自消一条，确保发送/复制
  // 失败在生产里不会静默无反馈。
  const notify = (message: string, ok = false): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text: message, ok })
    onNotify?.(message)
  }
  const toggleOpen = (): void => {
    holdFileTop(barRef.current)
    if (!open) setActiveFilePath(path)
    toggleFileOpen(path)
  }
  const sendText = (text: string): void => {
    if (text === '') return
    void readers.sendToSession(sessionId, text)
      .catch(() => notify(t('markdownTurn.sendFailed')))
  }
  const sendToNewSession = (text: string): void => {
    if (text === '') return
    const prompt = `${t('markdownTurn.newSessionPromptHeader', { path })}\n\n${text}`
    void readers.createSession()
      .then(newId => readers.sendToSession(newId, prompt))
      .catch(() => notify(t('markdownTurn.newSessionFailed')))
  }
  const openCompose = (): void => {
    setComposeOpen(true)
    scrollComposerOutOfView(barRef.current)
  }
  const openComment = (): void => {
    // 此刻选区还在，快照选区所在块级元素的整段文本作为锚点（composeWithComments 按它在
    // body.text 里定位）。之后聚焦输入框会塌缩选区，selBar 会被清空，故必须此刻取。
    const sel = window.getSelection()
    const anchor = sel?.anchorNode ?? null
    const block = anchor === null ? null : markdownBlockFrom(anchor)
    commentAnchorRef.current = block === null ? (selBar?.text ?? '') : blockText(block)
    setCommenting(true)
  }
  useEffect(() => {
    if (!open) return
    const update = (): void => {
      const sel = window.getSelection()
      if (sel === null || sel.isCollapsed || sel.rangeCount === 0) { setSelBar(null); return }
      const node = sel.anchorNode
      const body = bodyRef.current
      if (node === null || body === null || !body.contains(node)) { setSelBar(null); return }
      // 只在真正落进正文块（.markdown 内）的选区才弹条，避开状态行、评论区、compose 区。
      const flow = body.querySelector('[data-markdown-flow]')
      const anchorEl = node instanceof Element ? node : node.parentElement
      const inFlow = flow !== null && anchorEl !== null && flow.contains(anchorEl)
      const inOverlay = anchorEl !== null && anchorEl.closest('[data-comment-flow],[data-comment-box],[data-compose-box]') !== null
      if (!inFlow || inOverlay) { setSelBar(null); return }
      const text = sel.toString().trim()
      setSelBar(text === '' ? null : { text })
    }
    const onDown = (event: MouseEvent): void => {
      if (selBarRef.current?.contains(event.target as Node)) return
      if ((event.target as Element)?.closest?.('[data-markdown-body]')) return
      setSelBar(null)
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open, editing])
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
    }).catch((error: unknown) => {
      if (cancelled || controller.signal.aborted) return
      const message = error instanceof Error && error.message.length > 0 ? error.message : undefined
      setBody(message === undefined ? { kind: 'error' } : { kind: 'error', message })
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
      <button
        type="button"
        className={css.iconButton}
        data-edit-toggle=""
        aria-label={t('markdownTurn.edit')}
        title={t('markdownTurn.edit')}
        onClick={() => {
          holdFileTop(barRef.current)
          if (!open) setActiveFilePath(path)
          // 编辑按钮在折叠态点也先把文档展开，再进编辑态（与内联按钮原行为一致）。
          if (!open) toggleFileOpen(path)
          toggleFileEditing(path)
        }}
      >
        <IconEditOutlineRegular size={16} />
      </button>
      <ExpandButton open={open} label={toggleLabel} onClick={toggleOpen} />
      <FileOpenSplit sessionId={sessionId} path={path} readers={readers} t={t} />
    </div>
    {open && <div
      className={css.body}
      data-markdown-body={path}
      data-markdown-interactive=""
      ref={bodyRef}
      style={BODY_STYLE}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-line-action]')
        if (button === null) return
        event.preventDefault()
        event.stopPropagation()
        const block = hoveredRef.current
        if (block === null) return
        const text = blockText(block)
        if (text === '') return
        const action = button.getAttribute('data-line-action')
        void readers.sendToSession(sessionId, text)
          .catch(() => notify(t('markdownTurn.sendFailed')))
      }}
      onMouseOver={(event) => {
        // 指针从正文移到工具条上时也会触发 mouseover；工具条是正文块的兄弟节点，
        // 在按钮/svg 上找不到块级祖先。此时保留最近一个正文块，否则点击前 hoveredRef 被清空。
        if ((event.target as Element).closest('[data-line-tools]') !== null) return
        const block = markdownBlockFrom(event.target)
        hoveredRef.current = block
      }}
      onDoubleClick={(event) => {
        const target = event.target
        if (target instanceof Element && target.closest('button, a')) return
        holdFileTop(barRef.current)
        if (open) toggleFileOpen(path)
      }}
    >
      {body.kind === 'loading' && <p className={css.status}>{t('markdownTurn.loading')}</p>}
      {body.kind === 'error' && <p className={css.status}>
        {t('markdownTurn.error')}
        {body.message !== undefined && body.message.length > 0 && <span className={css.statusDetail}>：{body.message}</span>}
        <button type="button" className={css.retry} onClick={() => {
          holdFileTop(barRef.current)
          setAttempt(value => value + 1)
        }}>
          {t('markdownTurn.retry')}
        </button>
      </p>}
      {body.kind === 'ready' && <>
        {body.truncated && <p className={css.status}>{t('markdownTurn.truncated')}</p>}
        {editing
          ? (
            <div className={css.editBox} data-editing="">
              <textarea
                ref={editRef}
                className={css.editInput}
                data-markdown-body=""
                defaultValue={body.text}
                style={{ minHeight: '50dvh' }}
                aria-label={t('markdownTurn.edit')}
              />
              <div className={css.editActions}>
                <button
                  type="button"
                  className={css.editCancel}
                  data-edit-cancel=""
                  aria-label={t('markdownTurn.cancel')}
                  title={t('markdownTurn.cancel')}
                  onClick={() => { if (editing) toggleFileEditing(path) }}
                >
                  <IconCloseOutlineRegular size={15} /> {t('markdownTurn.cancel')}
                </button>
                <button
                  type="button"
                  className={css.sendBtn}
                  data-edit-send=""
                  onClick={() => { sendText(editRef.current?.value ?? ''); if (editing) toggleFileEditing(path) }}
                >
                  <IconSendOutlineRegular size={15} /> {t('markdownTurn.send')}
                </button>
                <button
                  type="button"
                  className={css.editCancel}
                  data-edit-new-session=""
                  aria-label={t('markdownTurn.newSession')}
                  title={t('markdownTurn.newSession')}
                  onClick={() => { sendToNewSession(editRef.current?.value ?? ''); if (editing) toggleFileEditing(path) }}
                >
                  <IconNewChatOutlineRegular size={15} /> {t('markdownTurn.newSession')}
                </button>
              </div>
            </div>
          )
          : isMarkdownPath(path)
            ? <div className={css.markdownBody} data-markdown-flow="">
                {segmentWithComments(body.text, comments).map((seg, si) => (
                  <Fragment key={si}>
                    {seg.text !== '' && <MarkdownText text={seg.text} streaming={false} labels={labels} />}
                    {seg.comments.map(cm => (
                      <blockquote key={cm.id} className={css.comment} data-comment-flow="">
                        <span className={css.commentMark}>{t('markdownTurn.commentedAs')}</span>
                        <span className={css.commentText}>{cm.comment}</span>
                        <button type="button" className={css.commentRemove} data-comment-remove="" aria-label={t('markdownTurn.commentRemove')} onClick={() => setComments(cur => cur.filter(x => x.id !== cm.id))}>×</button>
                      </blockquote>
                    ))}
                  </Fragment>
                ))}
              </div>
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
        {!editing && <div className={css.lineTools} data-line-tools="" role="toolbar" aria-label={t('markdownTurn.sendToSession')}>
          <button type="button" className={css.lineTool} data-line-action="send" title={t('markdownTurn.sendToSession')} aria-label={t('markdownTurn.sendToSession')}><IconSendOutlineRegular size={15} /></button>
          <button type="button" className={css.lineTool} data-line-action="direct" title={t('markdownTurn.send')} aria-label={t('markdownTurn.send')}><IconEditOutlineRegular size={15} /></button>
        </div>}
        {!editing && selBar !== null && !commenting && (
          <div ref={selBarRef} className={css.selBar} data-selection-bar="" role="toolbar">
            <button type="button" className={css.selBtn} data-sel-action="add" onClick={() => { setCommenting(false); setSelBar(null); openCompose() }}>{t('markdownTurn.sendToSession')}</button>
            <button type="button" className={css.selBtn} data-sel-action="direct" onClick={() => { sendText(selBar.text); setSelBar(null) }}>{t('markdownTurn.send')}</button>
            <button type="button" className={css.selBtn} data-sel-action="comment" onClick={() => { openComment() }}>{t('markdownTurn.comment')}</button>
          </div>
        )}
        {!editing && commenting && (
          <div className={css.commentBox} data-comment-box="">
            <textarea className={css.commentInput} data-comment-input="" placeholder={t('markdownTurn.commentPlaceholder')} rows={3} />
            <div className={css.commentActions}>
              <button type="button" className={css.selBtn} data-comment-send="" onClick={() => {
                const ta = bodyRef.current?.querySelector('[data-comment-input]') as HTMLTextAreaElement | null
                const text = ta?.value.trim() ?? ''
                if (text !== '') setComments(cur => [...cur, { id: commentIdRef.current++, blockText: commentAnchorRef.current, comment: text }])
                setCommenting(false)
              }}>{t('markdownTurn.commentSend')}</button>
            </div>
          </div>
        )}
        {comments.length > 0 && (
          <div className={css.commentList} data-comments="">
            <button type="button" className={css.sendBtn} data-comments-send="" onClick={() => { sendText(composeWithComments(body.text, comments)); setComments([]) }}>
              <IconSendOutlineRegular size={15} /> {t('markdownTurn.send')}
            </button>
          </div>
        )}
        {composeOpen && (
          <div className={css.composeBox} data-compose-box="">
            <textarea className={css.composeInput} data-compose-input="" placeholder={t('markdownTurn.composePlaceholder')} rows={3} defaultValue={selBar?.text ?? ''} />
            <div className={css.composeActions}>
              <button type="button" className={css.sendBtn} data-compose-send="" onClick={() => {
                const ta = bodyRef.current?.querySelector('[data-compose-input]') as HTMLTextAreaElement | null
                sendText(ta?.value ?? '')
                setComposeOpen(false)
                scrollComposerIntoView(barRef.current)
              }}>
                <IconSendOutlineRegular size={15} /> {t('markdownTurn.send')}
              </button>
            </div>
          </div>
        )}
      </>}
    </div>}
    {open && <div className={css.foot}>
      <ExpandButton open={open} label={toggleLabel} onClick={toggleOpen} kind="foot" />
    </div>}
    {toast !== null && <Toast
      key={toast.seq}
      text={toast.text}
      icon={<IconWarningOutlineRegular />}
      onDone={() => { setToast(null) }}
    />}
  </section>
}

/**
 * 渲染这一轮的文本阅读区。没有文本文件、没有会话编号时不占位。
 * @param props - 轮次数据、会话编号、文案和读取口。
 * @returns 阅读区，或 null。
 */
export function MarkdownTurnTail({ sessionId, turn, t, readers, onNotify }: MarkdownTurnProps): ReactNode {
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
    {shown.length > 0 && <ActiveFileBar sessionId={id} paths={paths} readers={readers} t={translate} />}
    {shown.map(path => <MarkdownDocument key={path} sessionId={id} path={path} readers={readers} t={translate} {...(onNotify === undefined ? {} : { onNotify })} />)}
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
