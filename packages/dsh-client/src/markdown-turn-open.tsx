/**
 * 文件路径栏上的打开方式。
 *
 * 和右侧文档预览标题栏的分体按钮同一套动作：主按钮打开默认应用，
 * 下拉列出已注册的应用，最后一项在文件管理器里打开文件夹。
 * 右侧预览仍写「显示文件位置」；这里的最后一项写「打开文件夹」。
 * 主机报没有桌面时不渲染，和右侧预览一样。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconRightUpOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  Toast,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RuntimeT } from './locales.ts'
import type { MarkdownFileApplication, MarkdownFileOpen, MarkdownTurnReaders } from './markdown-turn-sources.ts'
import css from './markdown-turn.module.css'

function ApplicationIcon({ source, size = 14 }: { source: string | null; size?: number }): ReactNode {
  const [failed, setFailed] = useState(false)
  return source === null || failed
    ? <IconRightUpOutlineRegular size={size} />
    : <img src={source} width={size} height={size} className={css.openIcon} alt="" draggable={false} onError={() => { setFailed(true) }} />
}

/**
 * 路径栏右侧的分体按钮。
 * @param props - 会话、路径、打开口和文案。
 * @returns 按钮，或在没有桌面时不占位。
 */
export function FileOpenSplit({ sessionId, path, readers, t }: {
  sessionId: string
  path: string
  readers: MarkdownTurnReaders
  t: RuntimeT
}): ReactNode {
  const [desktop, setDesktop] = useState<boolean | null>(null)
  const [applications, setApplications] = useState<readonly MarkdownFileApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const inFlight = useRef(false)
  const toastSeq = useRef(0)
  const alive = useRef(true)
  const queryAbort = useRef<AbortController | null>(null)

  useEffect(() => () => {
    alive.current = false
    queryAbort.current?.abort()
  }, [])

  const queryApps = useCallback((): void => {
    queryAbort.current?.abort()
    const controller = new AbortController()
    queryAbort.current = controller
    const settle = (apps: readonly MarkdownFileApplication[] | null): void => {
      if (!alive.current || controller.signal.aborted) return
      if (apps === null) {
        setFailed(true)
        setApplications([])
      } else {
        setFailed(false)
        setApplications(apps)
      }
      setLoading(false)
    }
    void readers.fileApplications(sessionId, path, controller.signal).then(settle, () => { settle(null) })
  }, [readers, sessionId, path])

  useEffect(() => {
    let cancelled = false
    void readers.canOpenFiles().then(ok => {
      if (cancelled || !alive.current) return
      if (!ok) {
        setDesktop(false)
        return
      }
      setDesktop(true)
      setApplications([])
      setFailed(false)
      setLoading(true)
      queryApps()
    })
    return () => {
      cancelled = true
      queryAbort.current?.abort()
    }
  }, [readers, queryApps])

  const show = (text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  const act = (action: MarkdownFileOpen): void => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setMenuOpen(false)
    void readers.openFile(sessionId, path, action).then(() => {}, () => {
      if (alive.current) show(t(action.kind === 'reveal' ? 'markdownTurn.revealError' : 'markdownTurn.openError'))
    }).finally(() => {
      inFlight.current = false
      if (alive.current) setPending(false)
    })
  }

  if (desktop !== true) return null

  const marked = applications.find(app => app.default)
  const preferred = marked ?? applications[0]
  const disabled = pending || loading
  const hasMenu = loading || failed || applications.length > 0
  const revealDefault = preferred === undefined && !loading
  const primaryLabel = preferred === undefined
    ? t('markdownTurn.openFolder')
    : t('markdownTurn.openTitle', { app: preferred.name })
  const icon = loading && preferred === undefined
    ? <span className={css.openSkeleton} data-open-target-skeleton="" aria-hidden="true" />
    : revealDefault
      ? <IconFolderOpenOutlineRegular size={13} />
      : <ApplicationIcon key={preferred?.icon} source={preferred?.icon ?? null} size={13} />
  const folderLabel = revealDefault
    ? t('markdownTurn.openDefault', { app: t('markdownTurn.openFolder') })
    : t('markdownTurn.openFolder')

  return <>
    <Menu
      className={css.openMenu}
      open={menuOpen && !disabled && hasMenu}
      autoFocus
      portal
      dense
      align="end"
      onClose={() => { setMenuOpen(false) }}
      items={[
        ...applications.map(app => ({
          id: `app:${app.id}`,
          icon: <ApplicationIcon key={app.icon} source={app.icon} />,
          label: app.id === preferred?.id
            ? t('markdownTurn.openDefault', { app: app.name })
            : app.name,
        })),
        ...(failed ? [{ id: 'unavailable', label: t('markdownTurn.openAppsError'), disabled: true }] : []),
      ]}
      footer={[{
        id: 'reveal',
        icon: <IconFolderOpenOutlineRegular />,
        label: folderLabel,
      }]}
      onSelect={(id) => {
        if (id === 'reveal') act({ kind: 'reveal' })
        else if (id.startsWith('app:')) act({ kind: 'application', id: id.slice(4) })
      }}
      anchor={(
        <div className={css.openSplit} data-open-path="" data-open-path-state={loading ? 'loading' : 'ready'}>
          <Tooltip portal label={primaryLabel} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.openMain}
              disabled={disabled}
              aria-label={primaryLabel}
              data-open-path-open=""
              onClick={() => {
                if (revealDefault) { act({ kind: 'reveal' }); return }
                if (preferred !== undefined && preferred.id !== marked?.id) {
                  act({ kind: 'application', id: preferred.id })
                  return
                }
                act({ kind: 'default' })
              }}
            >
              {icon}
            </button>
          </Tooltip>
          {hasMenu && <button
            type="button"
            className={css.openChevron}
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={menuOpen && !disabled}
            aria-label={t('markdownTurn.openMore')}
            data-open-path-more=""
            onClick={() => {
              if (!menuOpen) queryApps()
              setMenuOpen(value => !value)
            }}
          >
            <IconChevronDownOutlineRegular size={10} />
          </button>}
        </div>
      )}
    />
    {toast !== null && <Toast
      key={toast.seq}
      text={toast.text}
      icon={<IconWarningOutlineRegular />}
      onDone={() => { setToast(null) }}
    />}
  </>
}
