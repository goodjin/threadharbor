/**
 * 会话区文件操作区顶部的共享文件操作栏。
 *
 * turnTail 里每个文档各自展开，但「打开方式」那套按钮（默认打开 / 复制路径 /
 * 选应用 / 在文件夹里显示）原本只在每个文档自己的路径栏上，且右侧预览标题栏
 * 也各有一份。这里把同一套 `FileOpenSplit` 提到文件列表顶部一条共享栏上：显示
 * 最近点开/激活的那个文件，所有操作都停在会话区，不用再去右侧。
 *
 * 激活文件来自 `markdown-turn-active` 的共享状态：点开某个文档时写入，本栏订阅
 * 它跟着换。没有激活过（或激活的文件不在当前列表里）时兜底用列表第一个，保证
 * 栏不会空着没对象。
 *
 * 编辑/展开这两个动作也挂到本栏：它们改的是同一份「当前作用文件」的展开/编辑
 * 状态（存在同一共享 store 里），所以本栏按钮和文档自己的内联按钮始终同步、
 * 不会各改各的。订阅 store 还能让展开图标跟着实际状态翻。
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { FileTypeIcon, IconEditOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileOpenSplit } from './markdown-turn-open.tsx'
import { getActiveFilePath, getFileState, subscribeActiveFilePath, toggleFileEditing, toggleFileOpen } from './markdown-turn-active.ts'
import type { MarkdownTurnReaders } from './markdown-turn-sources.ts'
import type { RuntimeT } from './locales.ts'
import css from './markdown-turn.module.css'

export function ActiveFileBar({ sessionId, paths, readers, t }: {
  sessionId: string
  paths: readonly string[]
  readers: MarkdownTurnReaders
  t: RuntimeT
}): ReactNode {
  const active = useSyncExternalStore(subscribeActiveFilePath, getActiveFilePath, () => null)
  // 激活的文件还在当前列表里就对它作用；否则兜底第一个，保证栏始终有对象。
  const current = active !== null && paths.includes(active) ? active : (paths[0] ?? null)
  // 订阅 store：当前文件的展开态跟着变，展开按钮的图标/标签才对得上。
  const state = useSyncExternalStore(subscribeActiveFilePath, () => getFileState(current ?? ''), () => getFileState(current ?? ''))
  const open = current !== null && state.open
  if (current === null) return null
  return <div className={css.activeBar} data-active-file-bar="" data-active-path={current}>
    <span className={css.icon} data-file-icon={classifyFileType(current)}>
      <FileTypeIcon path={current} size={16} />
    </span>
    <span className={css.name} data-active-path={current} title={current}>{current}</span>
    <button
      type="button"
      className={css.iconButton}
      data-active-edit=""
      aria-label={t('markdownTurn.edit')}
      title={t('markdownTurn.edit')}
      onClick={() => {
        // 折叠态点编辑也先把文档展开，再进编辑态（与文档内联按钮一致）。
        if (!open) toggleFileOpen(current)
        toggleFileEditing(current)
      }}
    >
      <IconEditOutlineRegular size={16} />
    </button>
    <button
      type="button"
      className={css.iconButton}
      data-active-expand=""
      aria-expanded={open}
      aria-label={t(open ? 'markdownTurn.collapseAria' : 'markdownTurn.expandAria', { name: current })}
      title={t(open ? 'markdownTurn.collapseAria' : 'markdownTurn.expandAria', { name: current })}
      onClick={() => toggleFileOpen(current)}
    >
      {open ? <IconChevronUpOutlineRegular size={16} /> : <IconChevronDownOutlineRegular size={16} />}
    </button>
    <FileOpenSplit sessionId={sessionId} path={current} readers={readers} t={t} />
  </div>
}
