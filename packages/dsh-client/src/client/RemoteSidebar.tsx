/** DSH-style remote host → project → session → child-session browser. */

import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, IconEllipsisOutline16, IconFolderClose16,
  IconFolderOpen16, IconNewChatOutline16, IconPanelLeftOutline16,
  IconPlusOutline16, IconProjectAddOutline16, IconSearchOutline16, Input, Modal,
  IconSettingsOutline16, IconTreeCorner8x10, StateDot,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  RemoteHostView, RemoteOperationView, RemoteProjectView, RemoteSessionId, RemoteSessionView,
} from '@threadharbor/protocol'
import type { RemoteAgentStore } from './store.ts'
import { describeHostConnectFailure, hostConnectionLabel, hostDeploymentBadge, hostIpLabel } from './store.ts'
import css from './RemoteSurface.module.css'

/** Props injected by the sidebar slot registration. */
export interface RemoteSidebarInjected {
  readonly store: RemoteAgentStore
  readonly toggleSidebar: () => void
}

/** Full sidebar component props. */
export type RemoteSidebarProps = PropsRuntime<'sidebar'> & SidebarOwnerProps & RemoteSidebarInjected

function sessionState(session: RemoteSessionView): 'done' | 'warning' | 'ongoing' | 'error' {
  if (session.channelState === 'lost') return 'error'
  if (session.channelState === 'reconnecting') return 'warning'
  if (session.channelState === 'connecting') return 'ongoing'
  if (session.turnState === 'failed') return 'error'
  if (session.turnState === 'waiting-permission') return 'warning'
  if (session.turnState === 'running') return 'ongoing'
  return 'done'
}

/** Short status label shown next to the backend badge so users see lifecycle transitions. */
function sessionBadge(session: RemoteSessionView, attaching: boolean): string {
  if (attaching) return '连接中…'
  if (session.channelState === 'connecting') return '建立远端…'
  if (session.channelState === 'lost') return '已断开'
  if (session.channelState === 'reconnecting') return '重连中…'
  if (session.turnState === 'failed') return '本轮失败'
  if (session.turnState === 'waiting-permission') return '待确认'
  if (session.turnState === 'stopped') return '已停止'
  if (session.turnState === 'running') return '进行中'
  return session.backend
}

function hostState(host: RemoteHostView): 'done' | 'warning' | 'error' {
  if (host.inventoryError !== undefined) return 'error'
  if (host.inventory?.healthy === true) return 'done'
  return 'warning'
}

function operationState(operation: RemoteOperationView): 'done' | 'ongoing' | 'error' {
  if (operation.status === 'failed') return 'error'
  if (operation.status === 'succeeded') return 'done'
  return 'ongoing'
}

function OperationTray({ operations, hosts, store }: {
  operations: readonly RemoteOperationView[]
  hosts: readonly RemoteHostView[]
  store: RemoteAgentStore
}) {
  const active = operations.filter(operation => operation.status === 'queued' || operation.status === 'running')
  const latestFinished = operations.find(operation => operation.status === 'failed' || operation.status === 'succeeded')
  const visible = [...active, ...(latestFinished === undefined ? [] : [latestFinished])].slice(0, 3)
  if (visible.length === 0) return null
  return (
    <section className={css.operationTray} aria-label="后台操作" aria-live="polite">
      {visible.map(operation => {
        const hostExists = operation.hostId !== undefined && hosts.some(host => host.hostId === operation.hostId)
        return (
          <button
            key={operation.operationId}
            type="button"
            disabled={!hostExists}
            onClick={() => {
              if (operation.hostId !== undefined && hostExists) store.showPanel({ kind: 'host-settings', hostId: operation.hostId })
            }}
          >
            <StateDot state={operationState(operation)} />
            <span><strong>{operation.title}</strong><small>{operation.detail}</small></span>
          </button>
        )
      })}
    </section>
  )
}

function includesQuery(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query)
}

function sessionMatches(session: RemoteSessionView, sessions: readonly RemoteSessionView[], query: string): boolean {
  if (query === '' || includesQuery(session.title, query) || includesQuery(session.backend, query)) return true
  return sessions.some(candidate => candidate.parentSessionId === session.sessionId && sessionMatches(candidate, sessions, query))
}

function TreeToggle({ open }: { open: boolean }) {
  return <span className={css.treeBar} data-open={open || undefined} aria-hidden="true" />
}

function SessionRows({
  parentSessionId, sessions, currentSessionId, attachingSessionId, query, depth = 0, onOpen, onRename, store,
}: {
  parentSessionId?: RemoteSessionId
  sessions: readonly RemoteSessionView[]
  currentSessionId: RemoteSessionId | undefined
  attachingSessionId: RemoteSessionId | undefined
  query: string
  depth?: number
  onOpen: (session: RemoteSessionView) => void
  onRename: (session: RemoteSessionView) => void
  store: RemoteAgentStore
}) {
  const rows = sessions.filter(session => session.parentSessionId === parentSessionId && sessionMatches(session, sessions, query))
  const [menuSessionId, setMenuSessionId] = useState<RemoteSessionId>()
  const [archivingSessionId, setArchivingSessionId] = useState<RemoteSessionId>()
  if (rows.length === 0) return null
  return (
    <div className={depth === 0 ? css.sessionList : css.childList} role="group">
      {rows.map(session => (
        <SessionRow
          key={session.sessionId}
          session={session}
          currentSessionId={currentSessionId}
          attachingSessionId={attachingSessionId}
          depth={depth}
          onOpen={onOpen}
          onRename={onRename}
          store={store}
          menuOpen={menuSessionId === session.sessionId}
          setMenuOpen={(open) => { setMenuSessionId(open ? session.sessionId : undefined) }}
          archiving={archivingSessionId === session.sessionId}
          setArchiving={(value) => { setArchivingSessionId(value ? session.sessionId : undefined) }}
          sessions={sessions}
          query={query}
        />
      ))}
    </div>
  )
}

function SessionRow({
  session, currentSessionId, attachingSessionId, depth, onOpen, onRename, store,
  menuOpen, setMenuOpen, archiving, setArchiving, sessions, query,
}: {
  session: RemoteSessionView
  currentSessionId: RemoteSessionId | undefined
  attachingSessionId: RemoteSessionId | undefined
  depth: number
  onOpen: (session: RemoteSessionView) => void
  onRename: (session: RemoteSessionView) => void
  store: RemoteAgentStore
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  archiving: boolean
  setArchiving: (archiving: boolean) => void
  sessions: readonly RemoteSessionView[]
  query: string
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(menuRef, menuOpen, () => { setMenuOpen(false) })
  return (
    <div ref={menuRef} className={css.sessionItem}>
      <button
        type="button"
        className={css.sessionRow}
        data-current={session.sessionId === currentSessionId || undefined}
        aria-current={session.sessionId === currentSessionId ? 'page' : undefined}
        title={session.title}
        onClick={() => { onOpen(session) }}
      >
        <span className={css.sessionLeading} aria-hidden="true">
          {depth > 0 && <IconTreeCorner8x10 />}
          <StateDot state={session.sessionId === attachingSessionId ? 'ongoing' : sessionState(session)} />
        </span>
        <span className={css.sessionTitle}>{session.title}</span>
        <span
          className={css.backendBadge}
          data-state={session.channelState === 'lost' || session.turnState === 'failed'
            ? 'failed'
            : session.channelState === 'connecting' ? 'connecting'
              : session.turnState === 'stopped' ? 'stopped' : undefined}
        >{sessionBadge(session, session.sessionId === attachingSessionId)}</span>
      </button>
      <button
        type="button"
        className={css.sessionMenuButton}
        aria-label={`${session.title} 操作`}
        aria-expanded={menuOpen}
        title="会话操作"
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen(!menuOpen)
        }}
      >
        <IconEllipsisOutline16 />
      </button>
      {menuOpen && (
        <div className={css.sessionMenu} role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              onRename(session)
            }}
          >重命名</button>
          <button
            type="button"
            role="menuitem"
            className={css.rowMenuDanger}
            disabled={archiving}
            onClick={() => {
              setArchiving(true)
              void store.archiveSession(session.sessionId)
                .then(() => { setMenuOpen(false) })
                .catch(() => undefined)
                .finally(() => { setArchiving(false) })
            }}
          >{archiving ? '归档中…' : '归档'}</button>
        </div>
      )}
      <SessionRows
        parentSessionId={session.sessionId}
        sessions={sessions}
        currentSessionId={currentSessionId}
        attachingSessionId={attachingSessionId}
        query={query}
        depth={depth + 1}
        onOpen={onOpen}
        onRename={onRename}
        store={store}
      />
    </div>
  )
}

function ProjectSection({
  project, sessions, currentSessionId, attachingSessionId, draftCurrent, query, open, onToggle, onRename, store, onHideProject, onRenameProject, active,
}: {
  project: RemoteProjectView
  sessions: readonly RemoteSessionView[]
  currentSessionId: RemoteSessionId | undefined
  attachingSessionId: RemoteSessionId | undefined
  draftCurrent: boolean
  query: string
  open: boolean
  onToggle: () => void
  onRename: (session: RemoteSessionView) => void
  onRenameProject: (project: RemoteProjectView) => void
  onHideProject: (project: RemoteProjectView) => void
  store: RemoteAgentStore
  active: boolean
}) {
  const queryMatchesProject = query === '' || includesQuery(project.title, query) || includesQuery(project.cwd, query)
  const visibleSessions = queryMatchesProject ? sessions : sessions.filter(session => sessionMatches(session, sessions, query))
  if (query !== '' && !queryMatchesProject && visibleSessions.length === 0) return null
  const expanded = query === '' ? open : true
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(menuRef, menuOpen, () => { setMenuOpen(false) })
  return (
    <section className={css.projectSection} data-active={active || undefined}>
      <div className={css.treeRow} data-level="project">
        <button
          type="button"
          className={css.treeRowMain}
          aria-expanded={expanded}
          aria-current={active ? 'page' : undefined}
          title={project.cwd}
          onClick={onToggle}
        >
          <span className={css.treeBarCell}><TreeToggle open={expanded} /></span>
          <span className={css.folderIcon} aria-hidden="true">{expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}</span>
          <span className={css.treeLabel}>{project.title}</span>
        </button>
        <div className={css.treeRowActions}>
          <button
            type="button"
            aria-label={`在 ${project.title} 中新建会话`}
            title="新建会话"
            onClick={() => { store.startSessionDraft(project.projectId) }}
          >
            <IconNewChatOutline16 />
          </button>
          <div ref={menuRef} className={css.rowMenuAnchor}>
            <button
              type="button"
              className={css.menuButton}
              aria-label={`项目 ${project.title} 操作`}
              aria-expanded={menuOpen}
              title="项目操作"
              onClick={(event) => { event.stopPropagation(); setMenuOpen(value => !value) }}
            >
              <IconEllipsisOutline16 />
            </button>
            {menuOpen && (
              <div className={css.rowMenu} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onRenameProject(project)
                  }}
                >重命名</button>
                <button
                  type="button"
                  role="menuitem"
                  className={css.rowMenuDanger}
                  onClick={() => {
                    setMenuOpen(false)
                    onHideProject(project)
                  }}
                >隐藏</button>
              </div>
            )}
          </div>
        </div>
        <span className={css.projectPathTooltip} role="tooltip">{project.cwd}</span>
      </div>
      {expanded && (
        <div className={css.projectChildren}>
          {draftCurrent && (
            <button type="button" className={css.sessionRow} data-current aria-current="page" onClick={() => { store.startSessionDraft(project.projectId) }}>
              <span className={css.sessionLeading}><span className={css.draftDot} aria-hidden="true" /></span>
              <span className={css.sessionTitle}>新会话</span>
              <span className={css.backendBadge}>待选择</span>
            </button>
          )}
          <SessionRows
            sessions={visibleSessions}
            currentSessionId={currentSessionId}
            attachingSessionId={attachingSessionId}
            query={queryMatchesProject ? '' : query}
            onOpen={(session) => { void store.selectSession(session.sessionId).catch(() => undefined) }}
            onRename={onRename}
            store={store}
          />
          {!draftCurrent && visibleSessions.filter(session => session.parentSessionId === undefined).length === 0 && (
            <button type="button" className={css.emptyTreeAction} onClick={() => { store.startSessionDraft(project.projectId) }}>
              <IconPlusOutline16 /> 新建会话
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function HostSection({
  host, projects, sessions, currentSessionId, attachingSessionId, draftProjectId, query,
  open, onToggle, projectOpen, onToggleProject, onRename, store, artifactVersion, active,
  activeProjectId, onRenameHost, onHideHost, onRenameProject, onHideProject,
}: {
  host: RemoteHostView
  projects: readonly RemoteProjectView[]
  sessions: readonly RemoteSessionView[]
  currentSessionId: RemoteSessionId | undefined
  attachingSessionId: RemoteSessionId | undefined
  draftProjectId: string | undefined
  query: string
  open: boolean
  onToggle: () => void
  projectOpen: (projectId: string) => boolean
  onToggleProject: (projectId: string) => void
  onRename: (session: RemoteSessionView) => void
  onRenameHost: (host: RemoteHostView) => void
  onHideHost: (host: RemoteHostView) => void
  onRenameProject: (project: RemoteProjectView) => void
  onHideProject: (project: RemoteProjectView) => void
  store: RemoteAgentStore
  artifactVersion: string | undefined
  active: boolean
  activeProjectId: string | undefined
}) {
  const hostMatchesQuery = query === '' || includesQuery(host.title, query) || includesQuery(host.endpoint, query)
  const visibleProjects = hostMatchesQuery ? projects : projects.filter(project => {
    if (includesQuery(project.title, query) || includesQuery(project.cwd, query)) return true
    return sessions.some(session => session.projectId === project.projectId && sessionMatches(session, sessions, query))
  })
  if (query !== '' && !hostMatchesQuery && visibleProjects.length === 0) return null
  const expanded = query === '' ? open : true
  const badge = hostDeploymentBadge(host, artifactVersion)
  const [menuOpen, setMenuOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string>()
  const menuRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(menuRef, menuOpen, () => { setMenuOpen(false) })
  const offline = host.inventoryError !== undefined
  const connect = (): void => {
    setConnecting(true)
    setConnectError(undefined)
    void store.reconnectHost(host.hostId)
      .then(() => { setConnectError(undefined) })
      .catch((error: unknown) => { setConnectError(describeHostConnectFailure(error)) })
      .finally(() => { setConnecting(false) })
  }
  return (
    <section className={css.hostSection} data-active={active || undefined}>
      <div className={css.treeRow} data-level="host">
        <button
          type="button"
          className={css.treeRowMain}
          aria-expanded={expanded}
          aria-current={active ? 'page' : undefined}
          title={host.endpoint}
          onClick={onToggle}
        >
          <span className={css.treeBarCell}><TreeToggle open={expanded} /></span>
          <StateDot state={hostState(host)} />
          <span className={css.treeLabel}>
            <span>
              {host.title}
              {badge !== undefined && (
                <span
                  className={`${css.hostBadge} ${badge.tone === 'warn' ? css.hostBadgeWarn : badge.tone === 'error' ? css.hostBadgeError : css.hostBadgeMuted}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${badge.label} ${host.title} 的 hostd`}
                  title={`${badge.label} hostd`}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void store.refreshInventory(host.hostId).catch(() => undefined)
                    store.showPanel({ kind: 'host-settings', hostId: host.hostId })
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    event.stopPropagation()
                    store.showPanel({ kind: 'host-settings', hostId: host.hostId })
                  }}
                >{badge.label}</span>
              )}
            </span>
            <small className={css.hostEndpoint}>
              {hostIpLabel(host)} · {hostConnectionLabel(host, artifactVersion)}
            </small>
          </span>
        </button>
        <div className={css.treeRowActions}>
          <button
            type="button"
            aria-label={`设置主机 ${host.title}`}
            title="主机设置"
            onClick={() => {
              void store.refreshInventory(host.hostId).catch(() => undefined)
              store.showPanel({ kind: 'host-settings', hostId: host.hostId })
            }}
          ><IconSettingsOutline16 /></button>
          <button
            type="button"
            aria-label={`在 ${host.title} 添加项目`}
            title="添加项目"
            onClick={() => { store.showPanel({ kind: 'add-project', hostId: host.hostId }) }}
          ><IconProjectAddOutline16 /></button>
          <div ref={menuRef} className={css.rowMenuAnchor}>
            <button
              type="button"
              className={css.menuButton}
              aria-label={`主机 ${host.title} 操作`}
              aria-expanded={menuOpen}
              title="主机操作"
              onClick={(event) => { event.stopPropagation(); setMenuOpen(value => !value) }}
            >
              <IconEllipsisOutline16 />
            </button>
            {menuOpen && (
              <div className={css.rowMenu} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onRenameHost(host)
                  }}
                >重命名</button>
                <button
                  type="button"
                  role="menuitem"
                  className={css.rowMenuDanger}
                  onClick={() => {
                    setMenuOpen(false)
                    onHideHost(host)
                  }}
                >隐藏</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {offline && (
        <div className={css.hostOffline}>
          <Button size="sm" variant="outline" disabled={connecting} onClick={connect}>
            {connecting ? '连接中…' : '连接'}
          </Button>
          {connectError !== undefined && <p className={css.treeError}>{connectError}</p>}
        </div>
      )}
      {expanded && (
        <div className={css.hostChildren}>
          {visibleProjects.map(project => (
            <ProjectSection
              key={project.projectId}
              project={project}
              sessions={sessions.filter(session => session.projectId === project.projectId)}
              currentSessionId={currentSessionId}
              attachingSessionId={attachingSessionId}
              draftCurrent={draftProjectId === project.projectId}
              query={hostMatchesQuery ? '' : query}
              open={projectOpen(project.projectId)}
              onToggle={() => { onToggleProject(project.projectId) }}
              onRename={onRename}
              onRenameProject={onRenameProject}
              onHideProject={onHideProject}
              active={activeProjectId === project.projectId}
              store={store}
            />
          ))}
          {visibleProjects.length === 0 && (
            <button type="button" className={css.emptyTreeAction} onClick={() => { store.showPanel({ kind: 'add-project', hostId: host.hostId }) }}>
              <IconPlusOutline16 /> 添加项目
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function RenameSessionDialog({ session, store, onClose }: {
  session: RemoteSessionView
  store: RemoteAgentStore
  onClose: () => void
}) {
  return (
    <RenameDialog
      title="重命名会话"
      description="输入一个便于识别的会话名称。"
      label="会话名称"
      closeLabel="关闭重命名会话"
      initial={session.title}
      onClose={onClose}
      onSubmit={(next) => { return store.renameSession(session.sessionId, next) }}
    />
  )
}

function RenameHostDialog({ host, store, onClose }: {
  host: RemoteHostView
  store: RemoteAgentStore
  onClose: () => void
}) {
  return (
    <RenameDialog
      title="重命名主机"
      description="主机名称只影响 Web 端的展示，不会重命名远端服务器。"
      label="主机名称"
      closeLabel="关闭重命名主机"
      initial={host.title}
      onClose={onClose}
      onSubmit={(next) => { return store.updateHostTitle(host.hostId, next) }}
    />
  )
}

function RenameProjectDialog({ project, store, onClose }: {
  project: RemoteProjectView
  store: RemoteAgentStore
  onClose: () => void
}) {
  return (
    <RenameDialog
      title="重命名项目"
      description="项目名称只影响 Web 端的展示，不会重命名远端目录。"
      label="项目名称"
      closeLabel="关闭重命名项目"
      initial={project.title}
      onClose={onClose}
      onSubmit={(next) => { return store.renameProject(project.projectId, next) }}
    />
  )
}

function RenameDialog({ title, description, label, closeLabel, initial, onSubmit, onClose }: {
  title: string
  description: string
  label: string
  closeLabel: string
  initial: string
  onSubmit: (next: string) => Promise<unknown>
  onClose: () => void
}) {
  const formId = useId()
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const close = (): void => {
    if (!pending) onClose()
  }
  const submit = (): void => {
    const next = value.trim()
    if (next === '') {
      setError('名称不能为空。')
      return
    }
    if (next === initial) {
      onClose()
      return
    }
    setPending(true)
    setError('')
    void onSubmit(next)
      .then(() => { setPending(false); onClose() })
      .catch((reason: unknown) => { setError(String(reason)); setPending(false) })
  }
  return (
    <Modal
      open
      title={title}
      closeLabel={closeLabel}
      description={description}
      onClose={close}
      footer={(
        <>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={close}>取消</Button>
          <Button type="submit" form={formId} size="sm" variant="primary" disabled={pending || value.trim() === ''}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      <form id={formId} className={css.renameForm} onSubmit={(event) => { event.preventDefault(); submit() }}>
        <label htmlFor={`${formId}-value`}>{label}</label>
        <Input
          id={`${formId}-value`}
          className={css.renameInput ?? ''}
          value={value}
          autoFocus
          disabled={pending}
          aria-invalid={error !== '' || undefined}
          aria-describedby={error === '' ? undefined : `${formId}-error`}
          onChange={(event) => { setValue(event.target.value); setError('') }}
        />
        {error !== '' && <p id={`${formId}-error`} className={css.renameError}>{error}</p>}
      </form>
    </Modal>
  )
}

type HideTarget =
  | { readonly kind: 'host'; readonly host: RemoteHostView }
  | { readonly kind: 'project'; readonly project: RemoteProjectView }

function HideConfirmDialog({ target, store, onClose }: {
  target: HideTarget
  store: RemoteAgentStore
  onClose: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const isHost = target.kind === 'host'
  const host = isHost ? target.host : undefined
  const project = isHost ? undefined : target.project
  const title = isHost ? `隐藏主机 ${host?.title}` : `隐藏项目 ${project?.title}`
  const body = isHost
    ? `隐藏后，主机 ${host?.title} 及其所有项目与会话会从侧栏消失；可在"隐藏的主机与项目"中恢复或永久删除。`
    : `隐藏后，项目 ${project?.title} 的会话会归档，主机 ${host?.title ?? ''} 仍可见；可在"隐藏的主机与项目"中恢复或永久删除。`
  const confirm = (): void => {
    setPending(true)
    setError('')
    const task = isHost
      ? store.hideHost(host!.hostId)
      : store.hideProject(project!.projectId)
    void task
      .then(() => { setPending(false); onClose() })
      .catch((reason: unknown) => { setError(String(reason)); setPending(false) })
  }
  return (
    <Modal
      open
      title={title}
      closeLabel="关闭隐藏确认"
      description={body}
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { if (!pending) onClose() }}>取消</Button>
          <Button type="button" size="sm" variant="primary" disabled={pending} onClick={confirm}>
            {pending ? '隐藏中…' : '隐藏'}
          </Button>
        </>
      )}
    >
      {error !== '' && <p className={css.renameError}>{error}</p>}
    </Modal>
  )
}

function toggleSet(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Render the complete remote navigation column. */
export function RemoteSidebar({ collapsed, store, toggleSidebar }: RemoteSidebarProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const state = snapshot.state
  const [query, setQuery] = useState('')
  const [closedHosts, setClosedHosts] = useState<ReadonlySet<string>>(() => new Set())
  const [closedProjects, setClosedProjects] = useState<ReadonlySet<string>>(() => new Set())
  const [renameSession, setRenameSession] = useState<RemoteSessionView>()
  const [renameHost, setRenameHost] = useState<RemoteHostView>()
  const [renameProject, setRenameProject] = useState<RemoteProjectView>()
  const [hideTarget, setHideTarget] = useState<HideTarget>()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const currentSession = state.sessions.find(session => session.sessionId === snapshot.currentSessionId)
  const newSessionProject = snapshot.draftSession?.projectId ?? currentSession?.projectId ?? state.projects[0]?.projectId
  const panel = snapshot.panel
  const activeHostId = panel === undefined
    ? undefined
    : panel.kind === 'host-settings'
      ? panel.hostId
      : panel.kind === 'add-project' && panel.hostId !== undefined
        ? panel.hostId
        : undefined
  const activeProjectId = undefined
  const startNewSession = (): void => {
    if (newSessionProject !== undefined) {
      store.startSessionDraft(newSessionProject)
      return
    }
    const firstHost = state.hosts[0]
    store.showPanel(firstHost === undefined ? { kind: 'add-host' } : { kind: 'add-project', hostId: firstHost.hostId })
  }

  const visibleHostCount = useMemo(() => state.hosts.filter(host => {
    if (normalizedQuery === '' || includesQuery(host.title, normalizedQuery) || includesQuery(host.endpoint, normalizedQuery)) return true
    return state.projects.some(project => project.hostId === host.hostId && (
      includesQuery(project.title, normalizedQuery)
      || includesQuery(project.cwd, normalizedQuery)
      || state.sessions.some(session => session.projectId === project.projectId && sessionMatches(session, state.sessions, normalizedQuery))
    ))
  }).length, [normalizedQuery, state.hosts, state.projects, state.sessions])

  if (collapsed) {
    return (
      <div className={css.rail}>
        <button type="button" className={css.railBrand} title="展开 ThreadHarbor" onClick={toggleSidebar}>TH</button>
        <button type="button" title="新建会话" onClick={startNewSession}><IconNewChatOutline16 /></button>
        <span className={css.railSpacer} />
        <button type="button" title="添加主机" onClick={() => { store.showPanel({ kind: 'add-host' }) }}><IconPlusOutline16 /></button>
      </div>
    )
  }

  return (
    <aside className={css.sidebar}>
      <header className={css.sidebarHeader}>
        <button type="button" className={css.brand} title="新建会话" onClick={startNewSession}>
          <span className={css.brandMark}>TH</span>
          <span className={css.brandText}><strong>ThreadHarbor</strong><small>Remote Agents</small></span>
        </button>
        <button type="button" className={css.iconButton} aria-label="收起侧栏" onClick={toggleSidebar}><IconPanelLeftOutline16 /></button>
      </header>

      {(state.projects.length > 0 || state.sessions.length > 0) && (
        <label className={css.sidebarSearch}>
          <IconSearchOutline16 aria-hidden="true" />
          <input value={query} placeholder="搜索项目和会话" aria-label="搜索项目和会话" onChange={(event) => { setQuery(event.target.value) }} />
        </label>
      )}

      <div className={css.tree}>
        {state.hosts.map(host => (
          <HostSection
            key={host.hostId}
            host={host}
            projects={state.projects.filter(project => project.hostId === host.hostId)}
            sessions={state.sessions}
            currentSessionId={snapshot.currentSessionId}
            attachingSessionId={snapshot.attachingSessionId}
            draftProjectId={snapshot.draftSession?.projectId}
            query={normalizedQuery}
            open={!closedHosts.has(host.hostId)}
            onToggle={() => { setClosedHosts(current => toggleSet(current, host.hostId)) }}
            projectOpen={(projectId) => !closedProjects.has(projectId)}
            onToggleProject={(projectId) => { setClosedProjects(current => toggleSet(current, projectId)) }}
            onRename={setRenameSession}
            onRenameHost={setRenameHost}
            onHideHost={(target) => { setHideTarget({ kind: 'host', host: target }) }}
            onRenameProject={setRenameProject}
            onHideProject={(target) => { setHideTarget({ kind: 'project', project: target }) }}
            store={store}
            artifactVersion={state.hostdArtifactVersion}
            active={activeHostId === host.hostId}
            activeProjectId={activeProjectId}
          />
        ))}
        {state.hosts.length === 0 && <p className={css.empty}>添加一台已命名的主机，然后选择项目目录开始会话。</p>}
        {state.hosts.length > 0 && normalizedQuery !== '' && visibleHostCount === 0 && <p className={css.empty}>没有匹配的项目或会话。</p>}
      </div>

      <OperationTray operations={state.operations} hosts={state.hosts} store={store} />
      {snapshot.error !== undefined && <div className={css.globalError}>{snapshot.error}</div>}
      <footer className={css.sidebarFooter}>
        <button type="button" className={css.sidebarFooterPrimary} onClick={() => { store.showPanel({ kind: 'add-host' }) }}>
          <IconPlusOutline16 /><span>添加主机</span>
        </button>
        <button
          type="button"
          className={css.sidebarFooterIcon}
          aria-label="设置：查看全部主机、项目和会话"
          title="设置：查看全部主机、项目和会话"
          onClick={() => { store.showPanel({ kind: 'hidden' }) }}
        ><IconSettingsOutline16 /></button>
      </footer>
      {renameSession !== undefined && (
        <RenameSessionDialog session={renameSession} store={store} onClose={() => { setRenameSession(undefined) }} />
      )}
      {renameHost !== undefined && (
        <RenameHostDialog host={renameHost} store={store} onClose={() => { setRenameHost(undefined) }} />
      )}
      {renameProject !== undefined && (
        <RenameProjectDialog project={renameProject} store={store} onClose={() => { setRenameProject(undefined) }} />
      )}
      {hideTarget !== undefined && (
        <HideConfirmDialog target={hideTarget} store={store} onClose={() => { setHideTarget(undefined) }} />
      )}
    </aside>
  )
}
