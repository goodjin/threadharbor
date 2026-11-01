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
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { FileTypeIcon, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileOpenSplit } from './markdown-turn-open.tsx'
import { getActiveFilePath, subscribeActiveFilePath } from './markdown-turn-active.ts'
import type { MarkdownTurnReaders } from './markdown-turn-sources.ts'
import type { RuntimeT } from './locales.ts'
import css from './markdown-turn.module.css'

/** 订阅共享激活文件状态；SSR 下没有 window，退回 null。 */
function useActiveFilePath(): string | null {
  return useSyncExternalStore(
    subscribeActiveFilePath,
    getActiveFilePath,
    () => null,
  )
}

export function ActiveFileBar({ sessionId, paths, readers, t }: {
  sessionId: string
  paths: readonly string[]
  readers: MarkdownTurnReaders
  t: RuntimeT
}): ReactNode {
  const active = useActiveFilePath()
  // 激活的文件还在当前列表里就对它作用；否则兜底第一个，保证栏始终有对象。
  const current = active !== null && paths.includes(active) ? active : (paths[0] ?? null)
  if (current === null) return null
  return <div className={css.activeBar} data-active-file-bar="" data-active-path={current}>
    <span className={css.icon} data-file-icon={classifyFileType(current)}>
      <FileTypeIcon path={current} size={16} />
    </span>
    <span className={css.name} data-active-path={current} title={current}>{current}</span>
    <FileOpenSplit sessionId={sessionId} path={current} readers={readers} t={t} />
  </div>
}
