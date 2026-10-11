/**
 * The panel itself: one sidebar entry's worth of screen.
 *
 * Everything that decides what the user sees is plain and tested elsewhere —
 * the verdict wording, the probe orchestration, the host-list merge. What is
 * left here is React wiring over three cards:
 *
 * 1. 主机 — one row per host with its basic facts: name, id, 本机/在线/未连接
 *    badge, registered address, heartbeat age. 2026-10-11 用户决定：这个面板
 *    只列主机，不再显示会话与项目（覆盖设计文档 §8.3 原三层分组）——会话读
 *    取与树渲染的代码已随该决定移除。
 * 2. 本机 agent — this host's agents and their probes. This is host-level
 *    information in its own card: probe verdicts never ride other rows.
 * 3. 主机登记 — the operator's inventory of other hosts. Adding a host here
 *    records it and states the steps; it does not open a connection, because
 *    a page cannot reach across origins — the card says so in as many words.
 *
 * There is no restart control, on purpose. A restart ordered from this page
 * must travel through the very channel that is hung; the host drops its own
 * dead connections and rebuilds on the next turn.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { describeVerdict } from './verdict.ts'
import type { ProbeVerdict } from './verdict.ts'
import type { RollUpSection } from './rollup-section.ts'
import type { AgentDescriptor, GatewayResult } from './gateway.ts'
import type { ProbeOutcome } from './probe.ts'
import { probeReach } from './reach.ts'
import type { ReachOutcome } from './reach.ts'
import type { HostRegistration, RegistrationResult } from '@threadharbor/dsh-host-federation'
import type { HostSnapshot } from '@threadharbor/dsh-host-federation'
import styles from './panel.module.css'

/** What one probe attempt is doing, as the row shows it. */
export type ProbeRunState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'done'; readonly verdict: ProbeVerdict; readonly archiveNote?: string }
  | { readonly phase: 'error'; readonly message: string }

/** The agent list, as the page's context reports it. */
export type AgentListPort = {
  /** A snapshot for the first paint; taken once at mount. */
  current(): readonly AgentDescriptor[]
  /** Ask the host's model catalog again; resolves with the fresh list. */
  reload(): Promise<GatewayResult<readonly AgentDescriptor[]>>
}

/** One probe run against one preset, as the panel triggers it. */
export type ProbeStarter = (presetId: string) => Promise<ProbeOutcome>

/** The host registry, as the panel reads and edits it. */
export type HostRegistryPort = {
  list(): readonly HostRegistration[]
  add(input: { readonly hostId: string; readonly hostTitle: string; readonly address: string }): RegistrationResult
  remove(hostId: string): boolean
}

/** What the panel reads from the page wiring. */
export type AgentPanelProps = {
  readonly agents: AgentListPort
  readonly probe: ProbeStarter
  /** The host-list section, owned by the wiring so the panel has no setup to do. */
  readonly rollUp: RollUpSection
  /** The registration list for other hosts; owned by the wiring. */
  readonly registry: HostRegistryPort
  /** Storage events re-read the registry; injectable for tests. */
  listenStorage?(handler: () => void): () => void
  /** Said instead of an empty list, so "none listed" never reads as "none configured". */
  readonly agentsNote?: string | undefined
}

/**
 * Whether the agent list has been read from the host at least once.
 *
 * The first snapshot is always empty — the port fetches nothing until asked —
 * so "empty" and "not read yet" are different states, and showing the empty
 * note for the second is how this panel used to open on a false alarm.
 */
type LoadPhase =
  | { readonly stage: 'pristine' }
  | { readonly stage: 'loading' }
  | { readonly stage: 'loaded' }
  | { readonly stage: 'failed'; readonly message: string }

/**
 * One host row in the list, merged from the two sources that know about hosts:
 * the channel's presence (self + whoever announces) and the registration list
 * (the operator's inventory, which knows hosts that are not open right now).
 */
export type HostListRow = {
  readonly hostId: string
  /** What the row leads with: the operator's registered name, else the host's own. */
  readonly name: string
  readonly self: boolean
  /** Present on the channel right now. */
  readonly online: boolean
  /** When the host was last heard, in the page's clock; only when online. */
  readonly lastSeen?: number
  /** The address the operator registered; only when there is one. */
  readonly address?: string
}

/**
 * Merge presence and registrations into one list, self first.
 *
 * Both sources are real data, neither is trusted to be complete: presence
 * knows nothing of hosts whose tab is closed, registrations know nothing of
 * hosts nobody registered. A hostId in both carries the registered name and
 * address on the live row.
 * @param hosts - the hosts present on the channel, self included.
 * @param registrations - the operator's registered hosts.
 * @returns one row per known host, self first, then by id.
 */
export function mergeHostRows(
  hosts: readonly HostSnapshot[],
  registrations: readonly HostRegistration[],
): readonly HostListRow[] {
  const byId = new Map<string, HostListRow>()
  for (const host of hosts) {
    byId.set(host.hostId, {
      hostId: host.hostId,
      name: nonEmpty(host.hostTitle) ?? host.hostId,
      self: host.self,
      online: true,
      lastSeen: host.lastSeen,
    })
  }
  for (const registration of registrations) {
    const existing = byId.get(registration.hostId)
    const address = nonEmpty(registration.address)
    if (existing === undefined) {
      byId.set(registration.hostId, {
        hostId: registration.hostId,
        name: nonEmpty(registration.hostTitle) ?? registration.hostId,
        self: false,
        online: false,
        ...(address === undefined ? {} : { address }),
      })
    } else {
      byId.set(registration.hostId, {
        ...existing,
        // 登记的名字是这台机器的操作者起的，优先于主机自报的派生名。
        name: nonEmpty(registration.hostTitle) ?? existing.name,
        ...(address === undefined ? {} : { address }),
      })
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1
    return a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0
  })
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * How long since the host was last heard, in words.
 * @param lastSeen - the page-clock time of the last announcement.
 * @param now - the page clock; defaults to Date.now, injected for tests.
 * @returns 刚刚 / N 秒前 / N 分钟前 / N 小时前.
 */
export function heartbeatWord(lastSeen: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - lastSeen) / 1000))
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.floor(minutes / 60)} 小时前`
}

/**
 * Drive one probe and report each phase.
 * @param probe - the wired probe, one preset per call.
 * @param presetId - the agent to ask.
 * @param onPhase - called with the running state and then the outcome.
 * @returns when the probe settled.
 */
export async function runProbe(probe: ProbeStarter, presetId: string, onPhase: (state: ProbeRunState) => void): Promise<void> {
  onPhase({ phase: 'running' })
  try {
    const outcome = await probe(presetId)
    onPhase({
      phase: 'done',
      verdict: outcome.verdict,
      ...(outcome.archiveNote === undefined ? {} : { archiveNote: outcome.archiveNote }),
    })
  } catch (error: unknown) {
    // The wired probe promises not to throw; a wiring that breaks its promise
    // must not take the panel with it.
    onPhase({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * One agent's row: name, the probe button, the verdict.
 *
 * The verdict is the row's payload, so it leads: a colored state word and the
 * measured number, with the advice one click away instead of printed under
 * everything. @param props - the agent, the current probe state, and the handler.
 * @returns the row.
 */
export function AgentRow(props: {
  readonly presetId: string
  readonly label: string
  readonly verdict?: ProbeRunState | undefined
  readonly onProbe: (presetId: string) => void
}): ReactNode {
  const { presetId, label, verdict } = props
  return (
    <div data-agent={presetId} className={styles.agentRow}>
      <div className={styles.agentHead}>
        <strong data-agent-name="" className={styles.agentName}>{label}</strong>
        <span className={styles.agentId}>{presetId}</span>
        <span className={styles.spacer} />
        <button
          type="button"
          data-action="probe"
          className={styles.action}
          onClick={() => { props.onProbe(presetId) }}
        >探测</button>
      </div>
      <VerdictLine state={verdict} />
    </div>
  )
}

/** The verdict line under one row: state word first, evidence second, advice folded away. */
function VerdictLine(props: {
  readonly state?: ProbeRunState | undefined
}): ReactNode {
  const { state } = props
  if (state?.phase === 'running') {
    return <p data-probe-state="running" className={styles.stateLine}>探测中……（最多等一分钟）</p>
  }
  if (state?.phase === 'error') {
    return <p data-probe-state="error" className={styles.stateBad}>探测出错：{state.message}</p>
  }
  if (state?.phase === 'done') {
    const display = describeVerdict(state.verdict)
    return (
      <div data-probe-state={display.tone} className={styles.verdictLine} data-verdict-tone={display.tone}>
        <span data-verdict-word="" className={styles.verdictWord} data-verdict-tone={display.tone}>{display.headline}</span>
        <span data-verdict-detail="" className={styles.verdictDetail}>{display.detail}</span>
        <details className={styles.verdictMore}>
          <summary className={styles.summary}>建议</summary>
          <p className={styles.verdictAdvice}>{display.advice}</p>
          {state.archiveNote === undefined ? undefined : <p data-archive-note="" className={styles.verdictAdvice}>{state.archiveNote}</p>}
        </details>
      </div>
    )
  }
  return <p data-probe-state="idle" className={styles.stateLine}>未探测</p>
}

/** The identity line above the list: this tab's claim, visible at a glance. */
function IdentityLine(props: { readonly section: RollUpSection }): ReactNode {
  const identity = props.section.identity()
  return (
    <span data-identity-line="" className={styles.identityLine}>
      本机身份：{identity.hostTitle}（{identity.hostId}）{identity.derived ? ' · 未配置，按页面来源自动生成' : ''}
    </span>
  )
}

/** One host's row: name and id, the badge, the quiet second line. */
function HostRow(props: { readonly row: HostListRow }): ReactNode {
  const { row } = props
  const badge = row.self
    ? { word: '本机', tone: 'self' as const }
    : row.online
      ? { word: '在线', tone: 'online' as const }
      : { word: '未连接', tone: 'offline' as const }
  return (
    <div data-host-row={row.hostId} className={styles.hostRow}>
      <div className={styles.hostHead}>
        <strong data-host-name="" className={styles.hostName}>{row.name}</strong>
        <span className={styles.agentId}>{row.hostId}</span>
        <span data-host-badge={badge.tone} className={styles.hostBadge}>{badge.word}</span>
        <span className={styles.spacer} />
      </div>
      <p data-host-meta="" className={styles.stateLine}>
        {row.address === undefined
          ? undefined
          : <span data-host-address="">{row.address} · </span>}
        {row.online && row.lastSeen !== undefined
          ? <span data-host-heartbeat="">最近心跳 {heartbeatWord(row.lastSeen)}</span>
          : undefined}
      </p>
    </div>
  )
}

/**
 * The panel body: the host list on top, this host's agents and the host
 * registry under it.
 * @param props - the injected face.
 * @returns the panel.
 */
export function AgentPanel(props: AgentPanelProps): ReactNode {
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>(() => props.agents.current())
  const [load, setLoad] = useState<LoadPhase>(
    () => props.agents.current().length > 0 ? { stage: 'loaded' } : { stage: 'pristine' },
  )
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeRunState>>(new Map())
  const [hostIdDraft, setHostIdDraft] = useState('')
  const [hostTitleDraft, setHostTitleDraft] = useState('')
  const [identityRevision, setIdentityRevision] = useState(0)
  // The registry card re-reads on its own actions, on another tab's storage
  // write, and on reachability answers.
  const [registryRevision, setRegistryRevision] = useState(0)
  const [addressDraft, setAddressDraft] = useState('')
  const [regIdDraft, setRegIdDraft] = useState('')
  const [regTitleDraft, setRegTitleDraft] = useState('')
  const [registryMessage, setRegistryMessage] = useState<{ readonly tone: 'ok' | 'bad'; readonly text: string } | undefined>(undefined)
  const [confirmingRemove, setConfirmingRemove] = useState<string | undefined>(undefined)
  const [reaches, setReaches] = useState<ReadonlyMap<string, ReachOutcome | 'probing'>>(new Map())
  // The host list lives in the section, not in React state; this tick is what
  // re-reads it — presence changes and heartbeat ages both arrive without one.
  const [, setListTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => { setListTick(tick => tick + 1) }, 3000)
    return () => { window.clearInterval(timer) }
  }, [])

  // A fresh mount reads the catalog once instead of waiting for a click: the
  // panel used to open on "没有列出任何 acp agent" for a host that was serving
  // one, purely because nobody had pressed 刷新 yet.
  useEffect(() => {
    // Runs once per mount: reloading on every phase change would cancel the
    // very read the phase change belongs to (the effect's own setLoad
    // re-triggers it), which is exactly the frozen spinner this used to be.
    let cancelled = false
    setLoad(previous => previous.stage === 'loaded' ? previous : { stage: 'loading' })
    void props.agents.reload().then(result => {
      if (cancelled) return
      if (result.ok) {
        setAgents(result.value)
        setLoad({ stage: 'loaded' })
      } else {
        setLoad({ stage: 'failed', message: result.error.message })
      }
    })
    return () => { cancelled = true }
  }, [props.agents])

  useEffect(() => props.listenStorage?.(() => { setRegistryRevision(revision => revision + 1) }), [props.listenStorage])

  const startProbe = (presetId: string): void => {
    void runProbe(props.probe, presetId, state => {
      setProbes(previous => new Map(previous).set(presetId, state))
    })
  }
  const refreshAgents = (): void => {
    setLoad({ stage: 'loading' })
    void props.agents.reload().then(result => {
      if (result.ok) {
        setAgents(result.value)
        setLoad({ stage: 'loaded' })
      } else {
        setLoad({ stage: 'failed', message: result.error.message })
      }
    })
  }
  const saveIdentity = (): void => {
    const hostId = hostIdDraft.trim()
    const hostTitle = hostTitleDraft.trim()
    props.rollUp.setIdentity({
      ...(hostId === '' ? {} : { hostId }),
      ...(hostTitle === '' ? {} : { hostTitle }),
    })
    // The section's identity is read at render time; this bump is what makes
    // the panel show the new one.
    setIdentityRevision(revision => revision + 1)
  }
  const addRegistration = (): void => {
    const result = props.registry.add({ hostId: regIdDraft, hostTitle: regTitleDraft, address: addressDraft })
    if (result.ok) {
      setAddressDraft('')
      setRegIdDraft('')
      setRegTitleDraft('')
      setRegistryMessage({
        tone: 'ok',
        text: `已登记 ${result.value.hostTitle}。它现在显示为「未连接」——这一页不会主动连上它，按下面的步骤在那台机器上启动并打开它。`,
      })
    } else {
      setRegistryMessage({ tone: 'bad', text: result.error.detail })
    }
    setRegistryRevision(revision => revision + 1)
  }
  const removeRegistration = (hostId: string): void => {
    props.registry.remove(hostId)
    setConfirmingRemove(undefined)
    setRegistryRevision(revision => revision + 1)
  }
  const startReach = (registration: HostRegistration): void => {
    setReaches(previous => new Map(previous).set(registration.hostId, 'probing'))
    void probeReach((input, init) => fetch(input, init), registration.address, 5000).then(outcome => {
      setReaches(previous => new Map(previous).set(registration.hostId, outcome))
    })
  }

  const identity = props.rollUp.identity()
  const onlineIds = props.rollUp.onlineHostIds()
  const registrations = props.registry.list()
  // Re-read on every render, including every list tick: presence and the
  // registry both change out from under this component.
  const hostRows = mergeHostRows(props.rollUp.hosts(), registrations)
  const onlineCount = hostRows.filter(row => row.online).length
  return (
    <div data-threadharbor-panel="" className={styles.root}>
      <section data-panel-section="hosts" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>主机</h2>
          <span className={styles.spacer} />
          <span data-host-count="" className={styles.stateLine}>共 {hostRows.length} 台 · 在线 {onlineCount} 台</span>
          <IdentityLine key={identityRevision} section={props.rollUp} />
        </div>
        <div data-host-list="" className={styles.hostList}>
          {hostRows.map(row => <HostRow key={row.hostId} row={row} />)}
        </div>
        <details className={styles.noteDetails}>
          <summary className={styles.summary}>主机身份与说明</summary>
          <form
            data-identity-form=""
            className={styles.identityForm}
            onSubmit={event => {
              event.preventDefault()
              saveIdentity()
            }}
          >
            <label className={styles.field}>
              主机 id
              <input
                value={hostIdDraft}
                data-identity-host-id=""
                className={styles.input}
                onChange={event => { setHostIdDraft(event.target.value) }}
                placeholder="留空则自动生成"
              />
            </label>
            <label className={styles.field}>
              名称
              <input
                value={hostTitleDraft}
                data-identity-host-title=""
                className={styles.input}
                onChange={event => { setHostTitleDraft(event.target.value) }}
                placeholder="如：工作室主机"
              />
            </label>
            <button type="submit" data-identity-save="" className={styles.actionPrimary}>保存身份</button>
          </form>
          <ul data-panel-notices="" className={styles.notices}>
            <li>「在线」= 这台机器的页面在同一个浏览器的同源标签页里开着并按心跳报数；关闭或崩溃的页面过了静默窗口会自动转为未列出。</li>
            <li>另一台机器（另一个源）的页面不在这个频道里；要让一台主机出现在这里，登记它（下方第三张卡）并在那台机器上打开它自己的页面。</li>
            <li>会话与项目不再在此列出（2026-10-11 决定）：要看某台主机的会话，去那台主机自己的页面。</li>
          </ul>
        </details>
      </section>

      <section data-panel-section="agents" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>本机 agent</h2>
          <span className={styles.spacer} />
          <button type="button" data-action="refresh-agents" className={styles.action} onClick={refreshAgents}>刷新</button>
        </div>
        {load.stage === 'loading'
          ? <p data-agents-loading="" className={styles.stateLine}>正在读取本机 agent……</p>
          : load.stage === 'failed'
            ? <p data-agents-failed="" className={styles.stateBad}>读取失败：{load.message}</p>
            : agents.length === 0
              ? (
                  <p data-agents-empty="" className={styles.stateLine}>
                    {props.agentsNote ?? '这台主机没有列出任何 acp agent——可能没有配置预设，或模型目录读取失败；点"刷新"再试。'}
                  </p>
                )
              : (
                  <div className={styles.agentList}>
                    {agents.map(agent => (
                      <AgentRow
                        key={agent.presetId}
                        presetId={agent.presetId}
                        label={agent.label}
                        verdict={probes.get(agent.presetId)}
                        onProbe={startProbe}
                      />
                    ))}
                  </div>
                )}
        <details data-self-heal-note="" className={styles.noteDetails}>
          <summary className={styles.summary}>连接由谁照看</summary>
          <p className={styles.note}>
            连接由主机自己照看：发现断了会自动丢弃并在下一次对话时自动重连，无需在这里操作。
          </p>
        </details>
      </section>

      <section data-panel-section="registry" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>主机登记</h2>
          <span className={styles.spacer} />
          <span data-registry-count="" className={styles.stateLine}>已登记 {registrations.length} 台</span>
        </div>
        <p data-registry-posture="" className={styles.note}>
          在这里添加主机＝登记地址和步骤，<strong>不是建立连接</strong>：本页无法跨源读取另一台主机的接口，也听不到它标签页的频道；
          每台主机用它自己的页面打开，那一个标签页有自己的面板。
        </p>
        {registrations.length === 0
          ? <p data-registry-empty="" className={styles.stateLine}>还没有登记任何主机。展开「添加一台主机需要什么」看完整步骤。</p>
          : (
              <ul data-registry-list="" className={styles.registryList}>
                {registrations.map(registration => (
                  <RegistrationRow
                    key={registration.hostId}
                    registration={registration}
                    self={registration.hostId === identity.hostId}
                    online={onlineIds.includes(registration.hostId)}
                    reach={reaches.get(registration.hostId)}
                    confirming={confirmingRemove === registration.hostId}
                    onReach={() => { startReach(registration) }}
                    onRemoveAsk={() => { setConfirmingRemove(registration.hostId) }}
                    onRemoveConfirm={() => { removeRegistration(registration.hostId) }}
                    onRemoveCancel={() => { setConfirmingRemove(undefined) }}
                  />
                ))}
              </ul>
            )}
        {registryMessage === undefined
          ? undefined
          : <p data-registry-message={registryMessage.tone} className={registryMessage.tone === 'ok' ? styles.stateLine : styles.stateBad}>{registryMessage.text}</p>}
        <details className={styles.noteDetails}>
          <summary className={styles.summary}>添加一台主机需要什么</summary>
          <ol className={styles.steps}>
            <li>
              在那台机器上启动：<code>dsh web --port &lt;端口&gt;</code>。DSH 只监听本机 127.0.0.1——
              <code>0.0.0.0</code> 被启动器以安全理由直接拒绝（会把远程代码执行暴露给网络），
              绑具体内网地址也会被配置校验拒绝（只认 127.0.0.1 / 0.0.0.0 两个值）。这是当前版本（0.2.0-rc.2）的事实。
            </li>
            <li>
              跨机器访问靠端口转发：在浏览这台页面的机器上执行
              <code>ssh -L &lt;本地端口&gt;:127.0.0.1:&lt;端口&gt; &lt;那台机器&gt;</code>，
              然后访问 <code>http://127.0.0.1:&lt;本地端口&gt;</code>。转发后的 Host 仍是 127.0.0.1，不需要 <code>--trusted-host</code>；
              只有把页面放到反向代理后面、换了地址时，才要在那台机器上配 <code>--trusted-host &lt;代理后的地址&gt;</code>
              （写 <code>IP</code> 匹配任意端口，写 <code>IP:端口</code> 精确匹配，格式写错插件会加载失败）。
              这一步没有界面能替你做。
            </li>
            <li>
              打开：token 以那台机器 <code>dsh web</code> 打印的 <code>?token=…</code> 为准，
              不保存在这台机器上（凭证留在主机侧）。
            </li>
            <li>
              打开之前想清楚安全代价：端口转发和反向代理把那台机器的远程代码执行面带进你的网络路径，
              谁能连到转发端口，谁就可能在那台机器上执行命令；跨机器转发的事件不做脱敏，
              一台主机的数据会原样显示在连着它的浏览器里。
            </li>
          </ol>
        </details>
        <form
          data-registry-form=""
          className={styles.identityForm}
          onSubmit={event => {
            event.preventDefault()
            addRegistration()
          }}
        >
          <label className={styles.field}>
            地址（含 http 和端口）
            <input
              value={addressDraft}
              data-registry-address=""
              className={styles.input}
              onChange={event => { setAddressDraft(event.target.value) }}
              placeholder="http://192.168.1.10:3081"
            />
          </label>
          <label className={styles.field}>
            主机标识
            <input
              value={regIdDraft}
              data-registry-host-id=""
              className={styles.input}
              onChange={event => { setRegIdDraft(event.target.value) }}
              placeholder="那台机器面板里配置的 hostId"
            />
          </label>
          <label className={styles.field}>
            显示名
            <input
              value={regTitleDraft}
              data-registry-host-title=""
              className={styles.input}
              onChange={event => { setRegTitleDraft(event.target.value) }}
              placeholder="如：测试机"
            />
          </label>
          <button type="submit" data-registry-add="" className={styles.actionPrimary}>登记这台主机</button>
        </form>
      </section>
    </div>
  )
}

/** One registered host: identity, honest status, reachability, removal. */
function RegistrationRow(props: {
  readonly registration: HostRegistration
  readonly self: boolean
  readonly online: boolean
  readonly reach?: ReachOutcome | 'probing' | undefined
  readonly confirming: boolean
  onReach(): void
  onRemoveAsk(): void
  onRemoveConfirm(): void
  onRemoveCancel(): void
}): ReactNode {
  const { registration } = props
  const status = props.self
    ? { word: '本机', detail: '这就是当前标签页的身份。', tone: 'ok' as const }
    : props.online
      ? { word: '已连接', detail: '同一源的一个标签页正以这个身份在线。', tone: 'ok' as const }
      : { word: '未连接', detail: '这个页面听不到其他源的标签页，也无法读取它的接口；用浏览器打开它的地址才能看到它。', tone: 'bad' as const }
  return (
    <li data-registry-row={registration.hostId} className={styles.registryRow}>
      <div className={styles.registryHead}>
        <strong data-registry-title="">{registration.hostTitle}</strong>
        <span className={styles.agentId}>{registration.hostId}</span>
        <span data-registry-status={status.tone} className={styles.registryStatus} data-tone={status.tone}>{status.word}</span>
        <span className={styles.spacer} />
        {!props.confirming
          ? (
              <button type="button" data-registry-remove-ask="" className={styles.action} onClick={props.onRemoveAsk}>删除</button>
            )
          : (
              <span data-registry-confirm="" className={styles.confirmBox}>
                只从这台机器的登记列表里移除，不动远端那台机器。确定？
                <button type="button" data-registry-remove-confirm="" className={styles.action} onClick={props.onRemoveConfirm}>确定删除</button>
                <button type="button" data-registry-remove-cancel="" className={styles.action} onClick={props.onRemoveCancel}>取消</button>
              </span>
            )}
      </div>
      <p className={styles.stateLine}>
        <span data-registry-address-label="">{registration.address}</span>
        {' · '}
        {status.detail}
      </p>
      {!props.self && !props.online
        ? (
            <p data-registry-reach="" className={styles.stateLine}>
              {props.reach === undefined
                ? (
                    <button type="button" data-registry-reach-try="" className={styles.action} onClick={props.onReach}>测网络可达</button>
                  )
                : props.reach === 'probing'
                  ? '正在测……'
                  : props.reach.kind === 'reachable'
                    ? `网络可达（${props.reach.ms} ms 内有应答）。这只是端口上有东西回应，不能确认是 DSH，也不校验 token。`
                    : props.reach.kind === 'timeout'
                      ? `测不通：${props.reach.ms} ms 内无应答（超时）。`
                      : `测不通：${props.reach.reason}。`}
            </p>
          )
        : undefined}
    </li>
  )
}
