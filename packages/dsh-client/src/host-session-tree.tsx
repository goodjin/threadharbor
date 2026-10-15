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
import { useCallback, useEffect, useState } from 'react'
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
/** The native list's overflow cap: idle groups show this many, then 展开其余. */
const IDLE_SESSION_LIMIT = 5

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

  return (
    <div className={styles.tree} data-host-tree>
      {view.hosts.map(host => {
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
              const overflow = overflowOpen.includes(project.projectId)
              const hiddenCount = project.sessions.length - IDLE_SESSION_LIMIT
              const shown = overflow ? project.sessions : project.sessions.slice(0, IDLE_SESSION_LIMIT)
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
                      <span className={projectOpen ? styles.caretOpen : styles.caret}>▸</span>
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
                          onClick={event => { event.stopPropagation(); startSessionInProject(ctx, project.projectId) }}
                        >
                          ＋
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
                  </div>
                  {projectMenu
                    ? <div className={styles.menu} data-row-menu>
                        <button type="button" data-action="menu-new-session" className={styles.menuItem} onClick={() => { setMenu(null); startSessionInProject(ctx, project.projectId) }}>{t('panel.tree.newSession')}</button>
                        <button type="button" data-action="menu-rename-workspace" className={styles.menuItem} onClick={() => { setMenu(null); setRenaming({ kind: 'project', key: project.projectId, draft: project.label }) }}>{t('panel.tree.menuRenameWorkspace')}</button>
                        {confirmingDelete === project.projectId
                          ? <button type="button" data-action="menu-confirm-delete" className={styles.menuItemDanger} onClick={() => { setConfirmingDelete(null); void run(() => deleteWorkspace(ctx, project.projectId)) }}>{t('panel.tree.menuConfirmDelete')}</button>
                          : <button type="button" data-action="menu-delete-workspace" className={styles.menuItem} onClick={() => { setConfirmingDelete(project.projectId) }}>{t('panel.tree.menuDeleteWorkspace')}</button>}
                      </div>
                    : null}
                  {projectOpen ? [...shown].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map(session => {
                    const sessionMenu = menu?.kind === 'session' && menu.key === session.sessionId
                    return (
                      <div key={session.sessionId}>
                        <button
                          type="button"
                          className={styles.sessionRow}
                          data-session-row={session.sessionId}
                          data-active={currentSessionId === session.sessionId ? 'true' : undefined}
                          data-pinned={session.pinned === true ? 'true' : undefined}
                          onClick={() => {
                            if (host.self) setOpenFailed(openLocalSession(ctx, session.sessionId) === false)
                          }}
                        >
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
      {openFailed
        ? <p className={styles.error} data-open-failed>{t('panel.tree.openFailed')}</p>
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
