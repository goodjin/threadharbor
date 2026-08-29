/** Remote host → project → session tree and creation controls. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  RemoteAgentBackend, RemoteAuthChallenge, RemoteDirectoryListing, RemoteHostView, RemoteInstallPlan,
  RemoteProjectView, RemoteSessionId, RemoteSessionView, RemoteSshInspection,
} from '@threadharbor/protocol'
import { RemoteHostId } from '@threadharbor/protocol'
import { BACKEND_ORDER, type RemoteAgentStore } from './store.ts'
import css from './RemoteSurface.module.css'

/** Props injected by the slot registration. */
export interface RemoteSidebarInjected {
  readonly store: RemoteAgentStore
  readonly toggleSidebar: () => void
}

/** Full sidebar component props. */
export type RemoteSidebarProps = PropsRuntime<'sidebar'> & SidebarOwnerProps & RemoteSidebarInjected

function availableBackends(host: RemoteHostView): RemoteAgentBackend[] {
  return BACKEND_ORDER.filter((backend) => {
    const entry = host.inventory?.backends.find(candidate => candidate.backend === backend)
    return Boolean(entry?.installed && entry.authenticated && entry.sessionCapable)
  })
}

function AgentSetup({ host, store }: { host: RemoteHostView; store: RemoteAgentStore }) {
  const [plan, setPlan] = useState<RemoteInstallPlan>()
  const [auth, setAuth] = useState<RemoteAuthChallenge>()
  const [response, setResponse] = useState('')
  useEffect(() => {
    if (auth === undefined || !['starting', 'waiting-user'].includes(auth.status)) return
    const timer = window.setTimeout(() => {
      void store.authStatus(host.hostId, auth.flowId).then((next) => {
        setAuth(next)
        if (next.status === 'succeeded') void store.refreshInventory(host.hostId)
      }).catch(() => { /* RemoteAgentStore owns the visible request failure. */ })
    }, 1000)
    return () => { window.clearTimeout(timer) }
  }, [auth, host.hostId, store])

  const install = (backend: RemoteAgentBackend): void => {
    void store.installPlan(host.hostId, backend).then(setPlan)
      .catch(() => { /* RemoteAgentStore owns the visible request failure. */ })
  }
  const login = (backend: RemoteAgentBackend): void => {
    setPlan(undefined)
    void store.startAuth(host.hostId, backend).then(setAuth)
      .catch(() => { /* RemoteAgentStore owns the visible request failure. */ })
  }

  return (
    <div className={css.agentSetup}>
      {BACKEND_ORDER.map((backend) => {
        const entry = host.inventory?.backends.find(candidate => candidate.backend === backend)
        return (
          <div key={backend} className={css.agentRow}>
            <span><StateDot state={backendState(host, backend)} />{backend}</span>
            <span className={css.agentActions}>
              {!entry?.installed && <button type="button" onClick={() => { install(backend) }}>安装</button>}
              {entry?.installed && !entry.authenticated && backend !== 'dsh' && (
                <button type="button" onClick={() => { login(backend) }}>登录</button>
              )}
              {entry?.installed && entry.authenticated && <span>已登录</span>}
            </span>
            {entry?.detail !== undefined && <small>{entry.detail}</small>}
          </div>
        )
      })}
      {plan !== undefined && (
        <div className={css.setupCard}>
          <strong>安装 {plan.component}</strong>
          <span>{plan.version}</span>
          {plan.steps.map(step => <code key={step.command} title={step.title}>{step.command}</code>)}
          {plan.unavailableReason !== undefined
            ? <p className={css.error}>{plan.unavailableReason}</p>
            : plan.alreadyInstalled
              ? <p>目标已经安装。</p>
              : <Button size="sm" variant="outline" onClick={() => {
                  if (plan.component === 'hostd') return
                  void store.installAgent(host.hostId, plan.component).then(() => {
                    setPlan(undefined)
                    void store.refreshInventory(host.hostId)
                  })
                }}>确认安装</Button>}
          <button type="button" onClick={() => { setPlan(undefined) }}>关闭</button>
        </div>
      )}
      {auth !== undefined && (
        <div className={css.setupCard}>
          <strong>{auth.backend} 登录</strong>
          <p>{auth.message}</p>
          {(auth.verificationUriComplete ?? auth.verificationUri) !== undefined && (
            <a href={auth.verificationUriComplete ?? auth.verificationUri} target="_blank" rel="noreferrer">打开登录授权页面</a>
          )}
          {auth.userCode !== undefined && <code>{auth.userCode}</code>}
          {auth.status === 'waiting-user' && auth.userCode === undefined && (
            <div className={css.inlineCreate}>
              <input aria-label="登录返回码" value={response} placeholder="需要时粘贴返回码" onChange={(event) => { setResponse(event.target.value) }} />
              <button type="button" disabled={response === ''} onClick={() => {
                void store.respondAuth(host.hostId, auth.flowId, response).then(() => { setResponse('') })
              }}>提交</button>
            </div>
          )}
          {['starting', 'waiting-user'].includes(auth.status) && (
            <button type="button" onClick={() => { void store.cancelAuth(host.hostId, auth.flowId).then(() => { setAuth(undefined) }) }}>取消登录</button>
          )}
          {!['starting', 'waiting-user'].includes(auth.status) && <button type="button" onClick={() => { setAuth(undefined) }}>关闭</button>}
        </div>
      )}
    </div>
  )
}

function backendState(host: RemoteHostView, backend: RemoteAgentBackend): 'done' | 'warning' | 'ongoing' | 'error' {
  const entry = host.inventory?.backends.find(candidate => candidate.backend === backend)
  if (host.inventoryError !== undefined) return 'error'
  if (entry?.running) return 'ongoing'
  if (entry?.installed && entry.authenticated) return 'done'
  return 'warning'
}

function SessionRows({
  parentSessionId, sessions, currentSessionId, onOpen,
}: {
  parentSessionId?: RemoteSessionId
  sessions: readonly RemoteSessionView[]
  currentSessionId: RemoteSessionId | undefined
  onOpen: (session: RemoteSessionView) => void
}) {
  const rows = sessions.filter(session => session.parentSessionId === parentSessionId)
  if (rows.length === 0) return null
  return (
    <div className={parentSessionId === undefined ? css.sessionList : css.childList}>
      {rows.map(session => (
        <div key={session.sessionId}>
          <div className={css.sessionRow} data-current={session.sessionId === currentSessionId || undefined}>
            <button type="button" className={css.sessionOpen} onClick={() => { onOpen(session) }}>
              <StateDot state={session.turnState === 'running' ? 'ongoing' : session.channelState === 'lost' ? 'error' : 'done'} />
              <span className={css.sessionTitle}>{session.title}</span>
              <span className={css.backendBadge}>{session.backend}</span>
            </button>
          </div>
          <SessionRows
            parentSessionId={session.sessionId}
            sessions={sessions}
            currentSessionId={currentSessionId}
            onOpen={onOpen}
          />
        </div>
      ))}
    </div>
  )
}

function ProjectSection({
  project, host, sessions, currentSessionId, store,
}: {
  project: RemoteProjectView
  host: RemoteHostView
  sessions: readonly RemoteSessionView[]
  currentSessionId: RemoteSessionId | undefined
  store: RemoteAgentStore
}) {
  const backends = availableBackends(host)
  const [backend, setBackend] = useState<RemoteAgentBackend | ''>(backends[0] ?? '')
  const [title, setTitle] = useState('')
  useEffect(() => {
    if (backend === '' || !backends.includes(backend)) setBackend(backends[0] ?? '')
  }, [backend, backends])
  const createRoot = (): void => {
    if (backend === '') return
    void store.createSession({ projectId: project.projectId, title: title || '新会话', backend })
    setTitle('')
  }
  return (
    <section className={css.projectSection}>
      <div className={css.projectHeading}>
        <span>{project.title}</span>
        <span className={css.cwd} title={project.cwd}>{project.cwd}</span>
      </div>
      <div className={css.inlineCreate}>
        <input aria-label="会话标题" value={title} placeholder="新会话" onChange={(event) => { setTitle(event.target.value) }} />
        <select aria-label="后端" value={backend} onChange={(event) => { setBackend(event.target.value as RemoteAgentBackend) }}>
          {backends.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="button" disabled={backend === ''} onClick={createRoot}>新建</button>
      </div>
      {backends.length === 0 && <p className={css.muted}>这台主机没有已安装且已认证的后端。</p>}
      <SessionRows
        sessions={sessions}
        currentSessionId={currentSessionId}
        onOpen={(session) => { void store.selectSession(session.sessionId) }}
      />
    </section>
  )
}

/** Render the complete remote navigation column. */
export function RemoteSidebar({ collapsed, store, toggleSidebar }: RemoteSidebarProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [hostTitle, setHostTitle] = useState('本机')
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:3091')
  const [hostMode, setHostMode] = useState<'ssh' | 'endpoint'>('ssh')
  const [sshTarget, setSshTarget] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [proxyJump, setProxyJump] = useState('')
  const [sshInspection, setSshInspection] = useState<RemoteSshInspection>()
  const [projectHost, setProjectHost] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const [listing, setListing] = useState<RemoteDirectoryListing>()
  const state = snapshot.state
  const [selectedHostId, setSelectedHostId] = useState('')
  useEffect(() => {
    if (!state.hosts.some(host => host.hostId === selectedHostId)) {
      const first = state.hosts[0]?.hostId ?? ''
      setSelectedHostId(first)
      setProjectHost(first)
    }
  }, [selectedHostId, state.hosts])
  const selectedHost = state.hosts.find(host => host.hostId === selectedHostId)
  const browse = (path: string): void => {
    if (projectHost === '') return
    void store.listDirectory(RemoteHostId(projectHost), path).then((value) => {
      setListing(value)
      setCwd(value.path)
    }).catch(() => { /* RemoteAgentStore owns the visible request failure. */ })
  }

  if (collapsed) {
    return (
      <div className={css.rail}>
        <button type="button" title="展开远程 Agent" onClick={toggleSidebar}>远</button>
        {state.sessions.filter(session => session.parentSessionId === undefined).map(session => (
          <button key={session.sessionId} type="button" title={session.title} onClick={() => { void store.selectSession(session.sessionId) }}>
            <StateDot state={session.turnState === 'running' ? 'ongoing' : session.channelState === 'lost' ? 'error' : 'done'} />
          </button>
        ))}
      </div>
    )
  }

  return (
    <aside className={css.sidebar}>
      <header className={css.sidebarHeader}>
        <div><strong>远程 Agent</strong><span>hostd 会话</span></div>
        <button type="button" aria-label="收起侧栏" onClick={toggleSidebar}>‹</button>
      </header>

      <details className={css.addPanel}>
        <summary>添加主机</summary>
        <input aria-label="主机名称" value={hostTitle} onChange={(event) => { setHostTitle(event.target.value) }} />
        <select aria-label="主机连接方式" value={hostMode} onChange={(event) => { setHostMode(event.target.value as 'ssh' | 'endpoint') }}>
          <option value="ssh">SSH 自动部署</option>
          <option value="endpoint">已有 hostd 地址</option>
        </select>
        {hostMode === 'endpoint' ? (
          <>
            <input aria-label="hostd 地址" value={endpoint} onChange={(event) => { setEndpoint(event.target.value) }} />
            <Button size="sm" variant="outline" disabled={snapshot.pending} onClick={() => { void store.addHost(hostTitle, endpoint) }}>连接</Button>
          </>
        ) : (
          <>
            <input aria-label="SSH 主机" value={sshTarget} placeholder="host.example.com" onChange={(event) => { setSshTarget(event.target.value); setSshInspection(undefined) }} />
            <div className={css.inlineCreate}>
              <input aria-label="SSH 用户" value={sshUser} placeholder="user" onChange={(event) => { setSshUser(event.target.value); setSshInspection(undefined) }} />
              <input aria-label="SSH 端口" value={sshPort} inputMode="numeric" onChange={(event) => { setSshPort(event.target.value); setSshInspection(undefined) }} />
            </div>
            <input aria-label="SSH 私钥路径" value={identityFile} placeholder="Web 服务主机上的私钥绝对路径（可选）" onChange={(event) => { setIdentityFile(event.target.value); setSshInspection(undefined) }} />
            <input aria-label="SSH 跳板机" value={proxyJump} placeholder="ProxyJump（可选）" onChange={(event) => { setProxyJump(event.target.value); setSshInspection(undefined) }} />
            {sshInspection === undefined ? (
              <Button size="sm" variant="ghost" disabled={sshTarget === '' || snapshot.pending} onClick={() => {
                const port = Number(sshPort)
                void store.inspectSsh({
                  target: sshTarget,
                  ...(Number.isSafeInteger(port) ? { port } : {}),
                  ...(sshUser === '' ? {} : { user: sshUser }),
                  ...(identityFile === '' ? {} : { identityFile }),
                  ...(proxyJump === '' ? {} : { proxyJump }),
                }).then(setSshInspection)
              }}>检查主机密钥</Button>
            ) : (
              <div className={css.setupCard}>
                <strong>确认 SSH 主机密钥</strong>
                <code>{sshInspection.algorithm} {sshInspection.hostKeyFingerprint}</code>
                <p>请与主机管理员提供的指纹核对。确认后会部署并启动 threadharbor-hostd。</p>
                <Button size="sm" variant="outline" disabled={snapshot.pending} onClick={() => {
                  const port = Number(sshPort)
                  void store.deploySshHost(hostTitle, {
                    target: sshTarget,
                    ...(Number.isSafeInteger(port) ? { port } : {}),
                    ...(sshUser === '' ? {} : { user: sshUser }),
                    ...(identityFile === '' ? {} : { identityFile }),
                    ...(proxyJump === '' ? {} : { proxyJump }),
                    hostKeyFingerprint: sshInspection.hostKeyFingerprint,
                  }).then(() => { setSshInspection(undefined) })
                }}>指纹正确，部署 hostd</Button>
              </div>
            )}
          </>
        )}
      </details>

      {state.hosts.length > 0 && (
        <details className={css.addPanel}>
          <summary>添加项目</summary>
          <select aria-label="项目主机" value={projectHost} onChange={(event) => { setProjectHost(event.target.value) }}>
            <option value="">选择主机</option>
            {state.hosts.map(host => <option key={host.hostId} value={host.hostId}>{host.title}</option>)}
          </select>
          <input aria-label="项目名称" value={projectTitle} placeholder="项目名称" onChange={(event) => { setProjectTitle(event.target.value) }} />
          <input aria-label="远程目录" value={cwd} placeholder="/path/to/project" onChange={(event) => { setCwd(event.target.value) }} />
          <Button size="sm" variant="ghost" disabled={projectHost === '' || snapshot.pending} onClick={() => { browse(cwd || '/') }}>浏览</Button>
          {listing !== undefined && (
            <div className={css.directoryList}>
              {listing.parent !== undefined && <button type="button" onClick={() => { browse(listing.parent ?? listing.path) }}>..</button>}
              {listing.entries.filter(entry => entry.kind === 'directory').map(entry => (
                <button key={entry.path} type="button" onClick={() => { browse(entry.path) }}>{entry.name}/</button>
              ))}
            </div>
          )}
          <Button size="sm" variant="outline" disabled={projectHost === '' || cwd === '' || snapshot.pending} onClick={() => {
            void store.createProject(RemoteHostId(projectHost), projectTitle || cwd.split('/').at(-1) || cwd, cwd)
          }}>登记</Button>
        </details>
      )}

      <div className={css.tree}>
        <div className={css.hostTabs}>
          {state.hosts.map(host => (
            <button
              key={host.hostId}
              type="button"
              data-current={host.hostId === selectedHostId || undefined}
              onClick={() => {
                setSelectedHostId(host.hostId)
                setProjectHost(host.hostId)
                setListing(undefined)
              }}
            >{host.title}</button>
          ))}
        </div>
        {selectedHost !== undefined && (
          <section key={selectedHost.hostId} className={css.hostSection}>
            <div className={css.hostHeading}>
              <div><strong>{selectedHost.title}</strong><span>{selectedHost.endpoint}</span></div>
              <button type="button" aria-label="刷新库存" onClick={() => { void store.refreshInventory(selectedHost.hostId) }}>↻</button>
            </div>
            <div className={css.inventory}>
              {BACKEND_ORDER.map(backend => (
                <span key={backend}><StateDot state={backendState(selectedHost, backend)} />{backend}</span>
              ))}
            </div>
            <AgentSetup host={selectedHost} store={store} />
            {selectedHost.inventoryError !== undefined && <p className={css.error}>{selectedHost.inventoryError}</p>}
            {state.projects.filter(project => project.hostId === selectedHost.hostId).map(project => (
              <ProjectSection
                key={project.projectId}
                project={project}
                host={selectedHost}
                sessions={state.sessions.filter(session => session.projectId === project.projectId)}
                currentSessionId={snapshot.currentSessionId}
                store={store}
              />
            ))}
          </section>
        )}
        {state.hosts.length === 0 && <p className={css.empty}>添加 SSH 主机后，ThreadHarbor 会自动部署并通过隧道连接 hostd。</p>}
      </div>
      {snapshot.error !== undefined && <div className={css.globalError}>{snapshot.error}</div>}
    </aside>
  )
}
