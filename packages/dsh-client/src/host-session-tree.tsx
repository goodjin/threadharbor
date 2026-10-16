/**
 * The left sidebar's host → project → session tree.
 *
 * Pure rendering plus dispatch: no fetching happens here (the shadow component
 * that owns polling feeds this one a ready `RollUpView`), so every row's
 * behavior is click-verifiable without network stubs. Honesty rules: an
 * undeployed host says so instead of showing an empty-but-true-looking list,
 * and a failed fetch shows its raw reason verbatim.
 *
 * Project and session rows keep the native list's whole action set (2026-10-15
 * 用户要求：原先的项目元素功能都要保留）： collapse per project, the
 * 展开其余 overflow cap, workspace rename/delete, session rename/archive/
 * pin/fork — each dispatching through the same services the native list uses.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { RollUpView } from '@threadharbor/dsh-host-federation'
import {
  archiveSession, deleteWorkspace, forkSession, openLocalSession, pinSession,
  renameSession, renameWorkspace, startSessionInProject, unpinSession,
} from './session-actions.ts'
import type { RuntimeT } from './locales.ts'
import styles from './host-session-tree.module.css'

export type SessionActionsCtx = { get(name: string): unknown }

const EXPANDED_KEY = 'threadharbor.tree.expanded'
const COLLAPSED_KEY = 'threadharbor.tree.projects'
const VIEW_KEY = 'threadharbor.tree.view'
/** The native list's overflow cap: idle groups show this many, then 展开其余. */
const IDLE_SESSION_LIMIT = 5
/** History-search debounce and result cap, mirroring the native list's feel. */
const SEARCH_DEBOUNCE_MS = 200
const SEARCH_RESULT_LIMIT = 20

type OrderBy = 'manual' | 'updated'
type FilterBy = 'hide' | 'show' | 'only'
type RemoteSearch = { readonly status: 'idle' | 'pending' | 'ready'; readonly items: readonly { sessionId: string; title: string }[]; readonly hasMore: boolean }

type SessionsSearchHost = {
  readonly search?: (query: string, signal?: AbortSignal) => Promise<{ ok: boolean; value?: { items: { sessionId: string; title?: string }[]; hasMore?: boolean }; error?: { message?: string } }>
}

/**
 * Order per the tree's view option.
 *
 * Pinned rows lead (native seating). In 最近更新 mode, active rows then lead
 * the rest — a turn in flight (`running`) or a pending interaction
 * (`pendingInteraction`) — so a session that is working or waiting on you stays
 * at the top of its project regardless of its last prompt time. The recency
 * sort alone would bury it under any session you messaged more recently, and
 * `updatedAt` only advances on a user prompt (the host stamps
 * `api-session/activity` on `user/message`, never on streaming tokens), so a
 * long-running turn does not keep bumping itself. Pending interaction outranks
 * a running turn, the amber-over-green precedence the row marker already uses.
 * 手动 mode keeps the saved order and only lets pinned lead, so an explicit
 * manual order is never re-sorted under the cursor.
 */
function orderSessions<T extends { pinned?: boolean; updatedAt?: number; running?: boolean; pendingInteraction?: 'approval' | 'plan-review' | 'question' }>(sessions: readonly T[], orderBy: OrderBy): T[] {
  const pinnedFirst = (a: T, b: T): number => Number(b.pinned === true) - Number(a.pinned === true)
  const activeRank = (session: T): number => session.pendingInteraction !== undefined ? 2 : session.running === true ? 1 : 0
  if (orderBy !== 'updated') return [...sessions].sort((a, b) => pinnedFirst(a, b))
  return [...sessions].sort((a, b) => pinnedFirst(a, b) || activeRank(b) - activeRank(a) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}


/** Native live marker: pending interaction outranks a running turn (sidebar amber > green). */
type LiveKind = 'running' | 'approval' | 'plan-review' | 'question'

/**
 * Pin the running spinner's CSS animations to document time zero, the way
 * native's StateDot does: a CSS animation starts when its element is inserted,
 * so running sessions that begin at different moments would otherwise rotate
 * out of phase. One shared start keeps every visible spinner in step. jsdom (the
 * unit lane) implements no Web Animations, so the optional call leaves it alone.
 */
function syncLiveMotion(element: SVGSVGElement | null): void {
  if (element === null) return
  const svg = element as { getAnimations?: () => { startTime: number }[] }
  for (const animation of svg.getAnimations?.() ?? []) animation.startTime = 0
}

function liveKind(session: {
  readonly running?: boolean
  readonly pendingInteraction?: 'approval' | 'plan-review' | 'question'
}): LiveKind | undefined {
  const pending = session.pendingInteraction
  if (pending === 'approval' || pending === 'plan-review' || pending === 'question') return pending
  if (session.running === true) return 'running'
  return undefined
}

function liveLabelKey(kind: LiveKind): 'panel.tree.sessionRunning' | 'panel.tree.sessionWaitingApproval' | 'panel.tree.sessionPlanReview' | 'panel.tree.sessionWaitingAnswer' {
  if (kind === 'approval') return 'panel.tree.sessionWaitingApproval'
  if (kind === 'plan-review') return 'panel.tree.sessionPlanReview'
  if (kind === 'question') return 'panel.tree.sessionWaitingAnswer'
  return 'panel.tree.sessionRunning'
}

/**
 * The leading live marker. A running turn shows the native ongoing spinner — a
 * quiet ring behind a breathing arc that sweeps — so the row reads as alive;
 * a pending interaction shows a breathing amber dot, the "waiting on you"
 * counterpart that deliberately does not spin. Both are aria-hidden: the
 * title/aria-label carries the text for assistive tech.
 */
function SessionLive({ kind, label, t }: {
  readonly kind: LiveKind
  readonly label: string
  readonly t: RuntimeT
}) {
  if (kind === 'running') {
    return (
      <span className={styles.sessionLive} data-session-live={kind} data-kind={kind} title={label}>
        <svg
          ref={syncLiveMotion}
          className={styles.sessionSpinner}
          data-live-spinner="true"
          width={14}
          height={14}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <g className={styles.sessionSpinnerMotion}>
            <circle className={styles.sessionSpinnerTrack} cx="12" cy="12" r="9.5" />
            <circle className={styles.sessionSpinnerArc} cx="12" cy="12" r="9.5" />
          </g>
        </svg>
      </span>
    )
  }
  return <span className={styles.sessionLive} data-session-live={kind} data-kind={kind} title={label} aria-label={label} />
}
/** The tree's archived filter: the native list's three sight modes. */
function passesFilter(session: { archived?: boolean }, filterBy: FilterBy): boolean {
  if (filterBy === 'show') return true
  if (filterBy === 'only') return session.archived === true
  return session.archived !== true
}

function readViewOptions(): { orderBy: OrderBy; filterBy: FilterBy } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return { orderBy: 'updated', filterBy: 'hide' }
    const orderBy = (parsed as { orderBy?: unknown }).orderBy
    const filterBy = (parsed as { filterBy?: unknown }).filterBy
    return {
      // Default 最近更新: updatedAt is last human prompt (or createdAt).
      orderBy: orderBy === 'manual' ? 'manual' : 'updated',
      filterBy: filterBy === 'show' || filterBy === 'only' ? filterBy : 'hide',
    }
  } catch {
    return { orderBy: 'updated', filterBy: 'hide' }
  }
}

type Props = {
  readonly view: RollUpView
  readonly ctx: SessionActionsCtx
  readonly initialExpanded?: readonly string[]
  /** The open session's id; its row renders selected while the conversation owns main. */
  readonly currentSessionId?: string | undefined
  readonly t: RuntimeT
}

type MenuState = { readonly kind: 'project' | 'session'; readonly key: string } | null
type RenameState = { readonly kind: 'project' | 'session'; readonly key: string; readonly draft: string } | null

function readJsonArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function HostSessionTree({ view, ctx, initialExpanded, currentSessionId, t }: Props) {
  const [openFailed, setOpenFailed] = useState(false)
  const [menu, setMenu] = useState<MenuState>(null)
  const [renaming, setRenaming] = useState<RenameState>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [expanded, setExpanded] = useState<readonly string[]>(() => {
    const stored = readJsonArray(EXPANDED_KEY)
    return stored.length > 0 || initialExpanded === undefined ? stored : [...initialExpanded]
  })
  /** Projects the user folded shut; everything renders open until then. */
  const [collapsedProjects, setCollapsedProjects] = useState<readonly string[]>(() => readJsonArray(COLLAPSED_KEY))
  /** Projects whose 展开其余 footer is currently open; transient like the native list's. */
  const [overflowOpen, setOverflowOpen] = useState<readonly string[]>([])
  /** View options (排序/归档筛选), remembered like the native list remembers its own. */
  const [{ orderBy, filterBy }, setViewOptions] = useState(readViewOptions)
  const [optionsOpen, setOptionsOpen] = useState(false)
  /** The search box's live text; a non-empty query swaps the tree for flat results. */
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<RemoteSearch>({ status: 'idle', items: [], hasMore: false })
  const [searchError, setSearchError] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ orderBy, filterBy }))
    } catch {
      // Convenience-only, same as the other view memories.
    }
  }, [orderBy, filterBy])

  // History search: debounced, abortable, honest about rejection. The native
  // list debounces the same way against the same controller method.
  useEffect(() => {
    const normalized = query.trim()
    if (normalized === '') {
      setRemote({ status: 'idle', items: [], hasMore: false })
      setSearchError(null)
      return
    }
    const controller = new AbortController()
    setRemote({ status: 'pending', items: [], hasMore: false })
    const timer = window.setTimeout(() => {
      const host = (() => {
        try {
          return ctx.get('sessions') as SessionsSearchHost | undefined
        } catch {
          return undefined
        }
      })()
      if (typeof host?.search !== 'function') {
        setRemote({ status: 'ready', items: [], hasMore: false })
        return
      }
      host.search(normalized, controller.signal).then(result => {
        if (controller.signal.aborted) return
        if (result.ok !== true) {
          setSearchError(result.error?.message ?? '会话历史搜索被拒绝')
          setRemote({ status: 'ready', items: [], hasMore: false })
          return
        }
        setSearchError(null)
        setRemote({
          status: 'ready',
          items: (result.value?.items ?? []).map(item => ({ sessionId: item.sessionId, title: item.title ?? '' })),
          hasMore: result.value?.hasMore === true,
        })
      }, (reason: unknown) => {
        if (controller.signal.aborted) return
        setSearchError(reason instanceof Error ? reason.message : String(reason))
        setRemote({ status: 'ready', items: [], hasMore: false })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [ctx, query])

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
    } catch {
      // Expanded-state memory is a convenience; a failing store must not take the tree down.
    }
  }, [expanded])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedProjects))
    } catch {
      // Same convenience-only contract as the host expansion memory.
    }
  }, [collapsedProjects])

  const toggle = useCallback((hostId: string) => {
    setExpanded(current => current.includes(hostId) ? current.filter(id => id !== hostId) : [...current, hostId])
  }, [])

  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjects(current => current.includes(projectId) ? current.filter(id => id !== projectId) : [...current, projectId])
  }, [])

  const toggleOverflow = useCallback((projectId: string) => {
    setOverflowOpen(current => current.includes(projectId) ? current.filter(id => id !== projectId) : [...current, projectId])
  }, [])

  // 贴底上翻：菜单渲染后量一次，视口里放不下就翻到锚行上方（原生同款）。
  useLayoutEffect(() => {
    if (menu === null && !optionsOpen) return
    const popup = document.querySelector('[data-row-menu], [data-view-options-menu]')
    if (!(popup instanceof HTMLElement)) return
    const rect = popup.getBoundingClientRect()
    if (rect.bottom > window.innerHeight - 8) {
      popup.style.top = 'auto'
      popup.style.bottom = '100%'
    }
  }, [menu, optionsOpen])

  // Floating menus (2026-10-16 用户反馈)：行尾 ⋯ 与 ⚙ 的选择框是浮层下拉，
  // 不占列表的排版空间；点外部或按 Esc 收起，和原生一致。
  useEffect(() => {
    if (menu === null && !optionsOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-row-menu], [data-view-options-menu], [data-action="row-menu"], [data-action="view-options"]') === null) {
        setMenu(null)
        setOptionsOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
        setOptionsOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu, optionsOpen])

  /** Run one row action; a rejection lands on the tree verbatim, never silently. */
  const run = useCallback(async (dispatch: () => Promise<string | undefined>) => {
    setMenu(null)
    const error = await dispatch()
    setActionError(error ?? null)
  }, [])

  const commitRename = useCallback(() => {
    const state = renaming
    if (state === null || state.draft.trim() === '') return
    setRenaming(null)
    void run(() => state.kind === 'project'
      ? renameWorkspace(ctx, state.key, state.draft.trim())
      : renameSession(ctx, state.key, state.draft.trim()))
  }, [ctx, renaming, run])

  const normalizedQuery = query.trim()
  // Flat search results: local title matches first, then history hits, deduped.
  const localMatches = normalizedQuery === '' ? [] : view.hosts.find(host => host.self)?.projects
    .flatMap(project => project.sessions
      .filter(session => passesFilter(session, filterBy) && session.title.toLowerCase().includes(normalizedQuery.toLowerCase()))
      .map(session => ({ sessionId: session.sessionId, title: session.title, projectId: project.projectId })))
    ?? []
  const seen = new Set(localMatches.map(row => row.sessionId))
  const historyMatches = remote.items.filter(row => !seen.has(row.sessionId)).map(row => ({ ...row, projectId: undefined as string | undefined }))
  const allResults = [...localMatches, ...historyMatches].slice(0, SEARCH_RESULT_LIMIT)
  const resultCount = localMatches.length + historyMatches.length

  return (
    <div className={styles.tree} data-host-tree>
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          data-search-input
          type="text"
          value={query}
          placeholder={t('panel.tree.searchPlaceholder')}
          onChange={event => { setQuery(event.target.value) }}
        />
        {query !== ''
          ? <button type="button" className={styles.searchClear} data-action="search-clear" title={t('panel.tree.searchClear')} onClick={() => { setQuery('') }}>✕</button>
          : null}
        <button
          type="button"
          className={styles.rowMenu}
          data-action="view-options"
          title={t('panel.tree.viewOptions')}
          onClick={() => { setOptionsOpen(current => !current) }}
        >
          ⚙
        </button>
        {/* 菜单必须是 searchBar 的子元素：absolute 才锚住这一条（做兄弟时
            会锚到外层大容器，弹到主区右缘去）。 */}
        {optionsOpen
          ? <div className={styles.menu} data-view-options-menu>
              <button type="button" className={styles.menuItem} data-action="order-manual" data-checked={orderBy === 'manual' ? 'true' : undefined} onClick={() => { setViewOptions({ orderBy: 'manual', filterBy }) }}>{t('panel.tree.orderManual')}</button>
              <button type="button" className={styles.menuItem} data-action="order-updated" data-checked={orderBy === 'updated' ? 'true' : undefined} onClick={() => { setViewOptions({ orderBy: 'updated', filterBy }) }}>{t('panel.tree.orderUpdated')}</button>
              <button type="button" className={styles.menuItem} data-action="filter-hide-archived" data-checked={filterBy === 'hide' ? 'true' : undefined} onClick={() => { setViewOptions({ orderBy, filterBy: 'hide' }) }}>{t('panel.tree.filterHideArchived')}</button>
              <button type="button" className={styles.menuItem} data-action="filter-show-archived" data-checked={filterBy === 'show' ? 'true' : undefined} onClick={() => { setViewOptions({ orderBy, filterBy: 'show' }) }}>{t('panel.tree.filterShowArchived')}</button>
              <button type="button" className={styles.menuItem} data-action="filter-only-archived" data-checked={filterBy === 'only' ? 'true' : undefined} onClick={() => { setViewOptions({ orderBy, filterBy: 'only' }) }}>{t('panel.tree.filterOnlyArchived')}</button>
            </div>
          : null}
      </div>
      {normalizedQuery !== ''
        ? (
          <div className={styles.searchResults} data-search-results>
            {allResults.map(row => (
              <button
                key={row.sessionId}
                type="button"
                className={styles.sessionRow}
                data-search-result={row.sessionId}
                data-active={currentSessionId === row.sessionId ? 'true' : undefined}
                onClick={() => { setOpenFailed(openLocalSession(ctx, row.sessionId) === false) }}
              >
                <span className={styles.sessionTitle}>{row.title === '' ? row.sessionId : row.title}</span>
              </button>
            ))}
            {remote.status === 'pending' ? <p className={styles.note} data-search-pending>{t('panel.tree.searchPending')}</p> : null}
            {searchError !== null ? <p className={styles.error} data-search-error>{t('panel.tree.searchFailed')}{searchError}</p> : null}
            {remote.status === 'ready' && resultCount === 0 && searchError === null ? <p className={styles.note} data-search-empty>{t('panel.tree.searchNoMatches')}</p> : null}
            {remote.hasMore && resultCount > SEARCH_RESULT_LIMIT ? <p className={styles.note}>{t('panel.tree.searchHasMore', { n: SEARCH_RESULT_LIMIT })}</p> : null}
          </div>
          )
        : view.hosts.map(host => {
        const open = host.self || expanded.includes(host.hostId)
        return (
          <section
            key={host.hostId}
            className={host.undeployed === true ? styles.hostUndeployed : styles.host}
            data-host-node={host.hostId}
            data-undeployed={host.undeployed === true ? 'true' : undefined}
          >
            <button
              type="button"
              className={styles.hostRow}
              data-host-toggle
              onClick={() => {
                // An undeployed host has nothing to expand; the note under it
                // says where the deploy flow lives (设置 → 各主机).
                if (host.undeployed !== true) toggle(host.hostId)
              }}
            >
              <span className={styles.hostDot} data-host-online={host.self || host.empty === false ? 'true' : 'false'} />
              <span className={styles.hostLabel}>{host.label}</span>
              <span className={styles.hostCount}>{host.empty ? '' : host.sessionCount}</span>
            </button>
            {host.undeployed === true
              ? <p className={styles.note} data-undeployed-note>{t('panel.tree.undeployedNote')}</p>
              : null}
            {host.note !== undefined
              ? host.self
                ? <p className={styles.note} data-local-note>{host.note}</p>
                : <p className={styles.error} data-host-error>{t('panel.tree.fetchFailedTitle')}{host.note}</p>
              : null}
            {open && !host.self && host.projects.length === 0 && host.undeployed !== true
              ? <p className={styles.note}>{t('panel.tree.noSessions')}</p>
              : null}
            {open ? host.projects.map(project => {
              const projectOpen = !collapsedProjects.includes(project.projectId)
              const visible = orderSessions(project.sessions.filter(session => passesFilter(session, filterBy)), orderBy)
              const overflow = overflowOpen.includes(project.projectId)
              const hiddenCount = visible.length - IDLE_SESSION_LIMIT
              const shown = overflow ? visible : visible.slice(0, IDLE_SESSION_LIMIT)
              const projectMenu = menu?.kind === 'project' && menu.key === project.projectId
              return (
                <div key={project.projectId} className={styles.project} data-project-group={project.projectId}>
                  <div className={styles.projectRow}>
                    <button
                      type="button"
                      className={styles.projectToggle}
                      data-project-toggle
                      title={project.label}
                      onClick={() => { toggleProject(project.projectId) }}
                    >
                      <span className={styles.caretSlot} data-caret={projectOpen ? 'open' : 'closed'}>
                        <svg className={styles.caretIcon} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M5.5 3.5 L11.5 8 L5.5 12.5 Z" fill="currentColor" />
                        </svg>
                      </span>
                      <span className={styles.projectLabel}>
                        {renaming?.kind === 'project' && renaming.key === project.projectId
                          ? <input
                              className={styles.renameInput}
                              data-rename-input
                              value={renaming.draft}
                              autoFocus
                              onChange={event => { setRenaming({ kind: 'project', key: project.projectId, draft: event.target.value }) }}
                              onKeyDown={event => {
                                if (event.key === 'Enter') commitRename()
                                if (event.key === 'Escape') setRenaming(null)
                              }}
                            />
                          : project.label}
                      </span>
                    </button>
                    {host.self
                      ? <button
                          type="button"
                          className={styles.newSession}
                          title={t('panel.tree.newSession')}
                          data-action="tree-new-session"
                          onClick={event => { event.stopPropagation(); void run(() => startSessionInProject(ctx, project.projectId)) }}
                        >
                          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M13.5 7.2 V12 a1.5 1.5 0 0 1 -1.5 1.5 H5 L2.5 15.5 V3 A1.5 1.5 0 0 1 4 1.5 h4.3" />
                            <path d="M11.5 1.5 v4 M9.5 3.5 h4" />
                          </svg>
                        </button>
                      : null}
                    <button
                      type="button"
                      className={styles.rowMenu}
                      data-action="row-menu"
                      title={t('panel.tree.menuTitle')}
                      onClick={event => {
                        event.stopPropagation()
                        setMenu(current => current?.kind === 'project' && current.key === project.projectId ? null : { kind: 'project', key: project.projectId })
                      }}
                    >
                      ⋯
                    </button>
                    {/* 菜单锚在 projectRow（按钮所在的这一行），不是整个项目块：
                        锚到块上会落到整组会话的下方，离按钮隔十几行。 */}
                    {projectMenu
                      ? <div className={styles.menu} data-row-menu>
                          {/* 新会话不进菜单（2026-10-16 用户决定）：行尾加号图标就是唯一入口。 */}
                          <button type="button" data-action="menu-rename-workspace" className={styles.menuItem} onClick={() => { setMenu(null); setRenaming({ kind: 'project', key: project.projectId, draft: project.label }) }}>{t('panel.tree.menuRenameWorkspace')}</button>
                          {confirmingDelete === project.projectId
                            ? <button type="button" data-action="menu-confirm-delete" className={styles.menuItemDanger} onClick={() => { setConfirmingDelete(null); void run(() => deleteWorkspace(ctx, project.projectId)) }}>{t('panel.tree.menuConfirmDelete')}</button>
                            : <button type="button" data-action="menu-delete-workspace" className={styles.menuItem} onClick={() => { setConfirmingDelete(project.projectId) }}>{t('panel.tree.menuDeleteWorkspace')}</button>}
                        </div>
                      : null}
                  </div>
                  {projectOpen ? shown.map(session => {
                    const sessionMenu = menu?.kind === 'session' && menu.key === session.sessionId
                    const kind = liveKind(session)
                    const liveLabel = kind === undefined ? undefined : t(liveLabelKey(kind))
                    return (
                      <div key={session.sessionId} className={styles.sessionWrap}>
                        <button
                          type="button"
                          className={styles.sessionRow}
                          data-session-row={session.sessionId}
                          data-active={currentSessionId === session.sessionId ? 'true' : undefined}
                          data-pinned={session.pinned === true ? 'true' : undefined}
                          data-running={session.running === true ? 'true' : undefined}
                          data-pending={session.pendingInteraction}
                          data-live={kind}
                          onClick={() => {
                            if (host.self) setOpenFailed(openLocalSession(ctx, session.sessionId) === false)
                          }}
                        >
                          {kind !== undefined && liveLabel !== undefined
                            ? <SessionLive kind={kind} label={liveLabel} t={t} />
                            : null}
                          {session.pinned === true ? <span className={styles.sessionPin} data-session-pinned>📌</span> : null}
                          <span className={styles.sessionTitle}>
                            {renaming?.kind === 'session' && renaming.key === session.sessionId
                              ? <input
                                  className={styles.renameInput}
                                  data-rename-input
                                  value={renaming.draft}
                                  autoFocus
                                  onChange={event => { setRenaming({ kind: 'session', key: session.sessionId, draft: event.target.value }) }}
                                  onKeyDown={event => {
                                    if (event.key === 'Enter') commitRename()
                                    if (event.key === 'Escape') setRenaming(null)
                                  }}
                                />
                              : session.title}
                          </span>
                          <span
                            role="button"
                            tabIndex={-1}
                            className={styles.rowMenu}
                            data-action="row-menu"
                            title={t('panel.tree.menuTitle')}
                            onClick={event => {
                              event.stopPropagation()
                              setMenu(current => current?.kind === 'session' && current.key === session.sessionId ? null : { kind: 'session', key: session.sessionId })
                            }}
                          >
                            ⋯
                          </span>
                        </button>
                        {sessionMenu
                          ? <div className={styles.menu} data-row-menu>
                              <button type="button" data-action="menu-rename-session" className={styles.menuItem} onClick={() => { setMenu(null); setRenaming({ kind: 'session', key: session.sessionId, draft: session.title }) }}>{t('panel.tree.menuRenameSession')}</button>
                              <button type="button" data-action="menu-archive-session" className={styles.menuItem} onClick={() => { void run(() => archiveSession(ctx, session.sessionId)) }}>{t('panel.tree.menuArchiveSession')}</button>
                              {session.pinned === true
                                ? <button type="button" data-action="menu-unpin-session" className={styles.menuItem} onClick={() => { void run(() => unpinSession(ctx, session.sessionId)) }}>{t('panel.tree.menuUnpinSession')}</button>
                                : <button type="button" data-action="menu-pin-session" className={styles.menuItem} onClick={() => { void run(() => pinSession(ctx, session.sessionId)) }}>{t('panel.tree.menuPinSession')}</button>}
                              <button type="button" data-action="menu-fork-session" className={styles.menuItem} onClick={() => { void run(() => forkSession(ctx, session.sessionId)) }}>{t('panel.tree.menuForkSession')}</button>
                            </div>
                          : null}
                      </div>
                    )
                  }) : null}
                  {projectOpen && hiddenCount > 0
                    ? overflow
                      ? <button type="button" className={styles.overflowToggle} data-action="tree-collapse-sessions" onClick={() => { toggleOverflow(project.projectId) }}>{t('panel.tree.collapseSessions')}</button>
                      : <button type="button" className={styles.overflowToggle} data-action="tree-expand-more" onClick={() => { toggleOverflow(project.projectId) }}>{t('panel.tree.expandMore', { n: hiddenCount })}</button>
                    : null}
                </div>
              )
            }) : null}
          </section>
        )
      })}
      {openFailed        ? <p className={styles.error} data-open-failed>{t('panel.tree.openFailed')}</p>
        : null}
      {actionError !== null
        ? <p className={styles.error} data-tree-action-error>{t('panel.tree.actionFailed')}{actionError}</p>
        : null}
      {view.hosts.length === 0
        ? <p className={styles.note}>{t('panel.tree.noHosts')}</p>
        : null}
    </div>
  )
}
