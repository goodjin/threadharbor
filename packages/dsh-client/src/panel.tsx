/**
 * The panel itself: one sidebar entry's worth of screen.
 *
 * 2026-10-13 用户反馈定下的形状（覆盖 2026-10-12 的三界面骨架）：三个界面，
 * 列表页之外都是独立的页面——
 *
 * 1. 列表页：一张正常的表。「名称 / 状态 / IP / 设置」四列，一行一台主机、
 *    行高一致；名称旁仍保留状态圆点，状态列显示文字。点行或行尾的设置按钮
 *    进那台主机的设置页；上方一个「添加
 *    新主机」按钮，别的什么都不放。
 * 2. 详情页：与添加页共用同一套表单（HostFormPage 的 view 模式）。主机只有
 *    「名称」「IP」两个字段（显示名撤销：主机标识改名「名称」并兼任显示名，
 *    登记存储里 hostTitle 留空、落库回落到 hostId）。主机自己报的事实（在线
 *    状态、心跳、自报的标识）只在详情模式出现。本机的 agent 列表属于本机
 *    的详情页。
 * 3. 添加页：返回按钮在表单方框外面；「从 Tailscale 选」放在表单前面，
 *    选中一台就把名称和 IP 一起填上；「确定」「取消」收尾，按钮下面不再
 *    放说明文字。
 *
 * 名称两边可能不一样（人填的 vs 机器自报的）：详情页把两个值都摆出来
 * 并标明不一致，不悄悄用其中一个覆盖另一个。
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
import type { ConfiguredIdentity } from './settings-source.ts'
import type { AgentDescriptor, GatewayResult } from './gateway.ts'
import type { ProbeOutcome } from './probe.ts'
import { probeReach } from './reach.ts'
import type { ReachOutcome } from './reach.ts'
import type { HostIdentity, HostRegistration, RegistrationResult, RemoteAgentDeploySelection, SshAccessMode, SshConnectionInput, SshDeployResult, SshHostKeyCandidate } from '@threadharbor/dsh-host-federation'
import { REMOTE_DEPLOY_AGENT_SPECS } from '@threadharbor/dsh-host-federation'
import type { HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { HostStorePosture } from './host-store.ts'
import {
  inspectSshHost,
  probeSshDeployApi,
  startSshDeploy,
  waitSshDeployOperation,
} from './ssh-deploy.ts'
import type { SshDeployOperationView } from '@threadharbor/dsh-host-federation'
import styles from './panel.module.css'

/**
 * 去重：各 agent 下面的模型相同则不重复展示。
 *
 * 用户 2026-10-12 反馈：「各 Agent 下面的模型如果相同则去重，不要展示多个」。
 * 去重发生在 agent 粒度——同一个 preset 在目录里可能出现多次（一个 provider
 * 列在 groups 里、又在 failures 里因运行时解析失败被再列一次），列表只该有
 * 一个入口。按 presetId 去重，保留首次出现的那条：groups 先于 failures，所以
 * 留下的是 provider 那条，不是失败兜底那条。探针按 presetId 触发，重复的
 * presetId 指向同一个 agent，去掉重复不丢任何能力。
 * @param agents - 目录给出的 agent 列表，可能含重复 preset。
 * @returns 去掉重复 preset 后的列表，首次出现的顺序不变。
 */
export function dedupeAgents(agents: readonly AgentDescriptor[]): readonly AgentDescriptor[] {
  const seen = new Set<string>()
  const out: AgentDescriptor[] = []
  for (const agent of agents) {
    if (seen.has(agent.presetId)) continue
    seen.add(agent.presetId)
    out.push(agent)
  }
  return out
}

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
  add(input: {
    readonly hostId: string
    readonly hostTitle: string
    readonly address: string
    readonly launchUrl?: string
  }): RegistrationResult
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
  /** Pull remote host session trees via the management server's API. */
  readonly remoteSessions?: {
    refresh(registrations: readonly HostRegistration[]): void
    subscribe(listener: () => void): () => void
  }
  /**
   * Where the registry and the default identity are stored right now, plus a
   * subscription to its changes. The panel renders the posture as-is: where
   * settings live, and — when the machine's storage cannot be reached — that
   * they did not get saved. A silent fallback is the one failure this panel
   * is never allowed to make.
   */
  readonly hostStore?: {
    posture(): HostStorePosture
    subscribe(listener: () => void): () => void
  } | undefined

  /**
   * 从 Tailscale 选主机地址的口。缺省表示这台机器没有这个桥
   * （主机侧插件没装、或设置通道缺失），地址旁就不出现那个按钮。
   */
  readonly tailscale?: TailscalePort
  /** Storage events re-read the registry; injectable for tests. */
  listenStorage?(handler: () => void): () => void
  /** Said instead of an empty list, so "none listed" never reads as "none configured". */
  readonly agentsNote?: string | undefined
}

/** How a storage posture reads on screen. */
export type StoragePostureDisplay = {
  readonly tone: 'ok' | 'info' | 'bad'
  readonly text: string
}

/**
 * The posture, in one honest sentence. Every state names where the data
 * stands — including the good one, so "saved on this machine" is visible and
 * its absence is a question a user knows to ask.
 * @param posture - the storage's own account of itself.
 * @returns tone and text for the line.
 */
export function storagePostureLine(posture: HostStorePosture): StoragePostureDisplay {
  switch (posture.kind) {
    case 'host':
      return { tone: 'ok', text: '登记与本机名称保存在这台机器上：换浏览器、换标签页、清缓存都不会丢。' }
    case 'loading':
      return { tone: 'info', text: '正在从这台机器读取已保存的登记……' }
    case 'memory':
      return posture.reason === 'remote-page'
        ? { tone: 'bad', text: '这个页面由远程机器提供：登记与本机名称只保存在本页内存里，关闭页面就没有了。' }
        : { tone: 'bad', text: '这台机器没有提供设置存储通道（remote.settings）：登记与本机名称只保存在本页内存里，关闭页面就没有了。' }
    case 'degraded':
      return { tone: 'bad', text: `这台机器上的存储出了问题：${posture.detail}。名单还在本页里；真正存进去之前，换浏览器或清缓存会丢。` }
  }
}

/** The one posture line, shared by every page that edits stored data. */
function StoragePostureLine(props: { readonly posture: HostStorePosture | undefined }): ReactNode {
  if (props.posture === undefined) return undefined
  const display = storagePostureLine(props.posture)
  return (
    <p
      data-storage-posture={props.posture.kind}
      className={display.tone === 'bad' ? styles.stateBad : styles.stateLine}
    >{display.text}</p>
  )
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
export type HostConnectionStatus = 'connected' | 'reachable' | 'disconnected' | 'checking'

export type HostListRow = {
  readonly hostId: string
  /** What the row leads with: the operator's registered name, else the host's own. */
  readonly name: string
  readonly self: boolean
  /** Present on the channel right now. */
  readonly online: boolean
  readonly connection: HostConnectionStatus
  /** When the host was last heard, in the page's clock; only when online. */
  readonly lastSeen?: number
  /** The address the operator registered; only when there is one. */
  readonly address?: string
  readonly launchUrl?: string
}

export function deriveHostConnection(
  row: Pick<HostListRow, 'self' | 'online'>,
  reach?: ReachOutcome | 'probing',
): HostConnectionStatus {
  if (reach === 'probing') return 'checking'
  if (row.self || row.online) return 'connected'
  if (reach?.kind === 'reachable') return 'reachable'
  return 'disconnected'
}

export function connectionStatusLabel(status: HostConnectionStatus): string {
  switch (status) {
    case 'connected': return '已连接'
    case 'reachable': return '可达未同步'
    case 'checking': return '检测中'
    case 'disconnected': return '未连接'
  }
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
  reaches?: ReadonlyMap<string, ReachOutcome | 'probing'>,
): readonly HostListRow[] {
  const byId = new Map<string, HostListRow>()
  for (const host of hosts) {
    const base = {
      hostId: host.hostId,
      name: nonEmpty(host.hostTitle) ?? host.hostId,
      self: host.self,
      online: true,
      lastSeen: host.lastSeen,
    }
    byId.set(host.hostId, {
      ...base,
      connection: deriveHostConnection({ self: base.self, online: true }, reaches?.get(host.hostId)),
    })
  }
  for (const registration of registrations) {
    const existing = byId.get(registration.hostId)
    const address = nonEmpty(registration.address)
    const launchUrl = nonEmpty(registration.launchUrl)
    if (existing === undefined) {
      const row = {
        hostId: registration.hostId,
        name: nonEmpty(registration.hostTitle) ?? registration.hostId,
        self: false,
        online: false,
        ...(address === undefined ? {} : { address }),
        ...(launchUrl === undefined ? {} : { launchUrl }),
      }
      byId.set(registration.hostId, {
        ...row,
        connection: deriveHostConnection(row, reaches?.get(registration.hostId)),
      })
    } else {
      const merged = {
        ...existing,
        name: nonEmpty(registration.hostTitle) ?? existing.name,
        ...(address === undefined ? {} : { address }),
        ...(launchUrl === undefined ? {} : { launchUrl }),
      }
      byId.set(registration.hostId, {
        ...merged,
        connection: deriveHostConnection(merged, reaches?.get(registration.hostId)),
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
 * The host part of a registered address — the IP or MagicDNS name the operator
 * typed — pulled out for display, so the row and the detail page can show the
 * IP beside the name. Returns undefined when there is no parseable address.
 */
export function hostOf(address: string | undefined): string | undefined {
  const trimmed = address?.trim() ?? ''
  if (trimmed === '') return undefined
  try {
    return new URL(trimmed).hostname
  } catch {
    return undefined
  }
}

/**
 * The stored origin as the IP field shows it: the scheme comes off, the host
 * (and the port, when there is one) stays. `http://192.168.1.20:3081` reads
 * `192.168.1.20:3081`; a value without a scheme passes through unchanged, so
 * round-tripping never invents or eats anything the operator typed.
 * @param address - the registry's stored address.
 * @returns what the IP field holds.
 */
export function hostPartOfAddress(address: string): string {
  return address.trim().replace(/^https?:\/\//i, '')
}

/**
 * The IP field's value as the registry stores it: `http://` goes on when the
 * scheme is missing (the browser needs an absolute URL; guessing https would
 * send the operator somewhere they did not mean), an explicit scheme is
 * respected, and an empty value stays empty so the registry can say so.
 * @param value - what the IP field holds: an IP, host[:port], or a full URL.
 * @returns the address to hand to the registry.
 */
export function addressFromHostPart(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
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
 * What an operator fills in for one host: its name and where it lives. The
 * name is the hostId — 2026-10-13 用户决定：主机只有这两个字段，显示名撤销，
 * 主机标识改名「名称」并兼任显示名（登记时 hostTitle 落库留空，存储层回落
 * 到 hostId，列表显示的就是名称）。The address is the full origin the
 * registry stores; the form's IP field shows it without the scheme
 * （hostPartOfAddress / addressFromHostPart 在边界上互转）.
 */
export type HostFormValues = {
  readonly hostId: string
  readonly address: string
}

/**
 * What the host itself reports, as the detail page shows it. Never collected
 * on the add page: an operator cannot fill in a heartbeat.
 */
export type HostReportedFacts = {
  readonly self: boolean
  readonly online: boolean
  /** When the host was last heard; only when online. */
  readonly lastSeen?: number
  /** The identifier the host itself announces; absent while it is not heard. */
  readonly reportedId?: string
  /** Every identifier actually announcing right now — the real cross-check. */
  readonly onlineIds: readonly string[]
}

/** Which form fields a view-mode page lets the operator edit; the rest read out. */
export type HostFormFieldPolicy = {
  readonly id: boolean
  readonly address: boolean
}

/** 一台 Tailscale 节点：选择器要显示的名字、IP、在线状态。 */
export type TailscalePeer = {
  readonly name: string
  readonly ip: string
  readonly online: boolean
}

/**
 * 读清单的结果：成功带 peers（可附主机侧报的 note），失败带原因。
 * 失败的原因是人话（「没提供设置通道」），面板原样说在面上，不藏。
 */
export type TailscalePeersResult =
  | { readonly ok: true; readonly peers: readonly TailscalePeer[]; readonly note?: string }
  | { readonly ok: false; readonly message: string }

/** 面板读 Tailscale 清单的口：loadPeers 读一次，refresh 让主机侧重跑一次。 */
export type TailscalePort = {
  loadPeers(): Promise<TailscalePeersResult>
  refresh(): Promise<TailscalePeersResult>
}

const ALL_FIELDS: HostFormFieldPolicy = { id: true, address: true }

/** What an operator edits on one registration: the name (the id), and the address. */
export type RegistrationEditInput = {
  readonly hostId?: string
  readonly address: string
}

/**
 * Edit one registration through the registry's add/remove face.
 *
 * The registry has no update, and the wiring passes it as-is — so an edit is
 * remove-then-add, with one safety rail: if the new entry is refused (a bad
 * address, an id somebody else already holds), the previous entry goes back
 * in, because a failed edit must not silently delete the operator's record.
 * The name is editable too — that is exactly how a filled-in name gets
 * corrected to the one the machine actually announces. A row that is present
 * but never registered (another same-origin tab) has nothing to edit, so this
 * is simply an add. The stored hostTitle is left empty on every write: the
 * storage layer falls it back to the hostId, which is the name — 显示名已
 * 撤销（2026-10-13），旧登记里不一样的 hostTitle 在下一次保存时被名称取代.
 * @param registry - the registry port as the wiring provides it.
 * @param previousId - which registration to replace.
 * @param input - the new name (omit to keep the old one) and address.
 * @returns the add's result, whatever it was.
 */
export function applyRegistrationEdit(
  registry: HostRegistryPort,
  previousId: string,
  input: RegistrationEditInput,
): RegistrationResult {
  const previous = registry.list().find(entry => entry.hostId === previousId)
  const nextId = input.hostId !== undefined && input.hostId.trim() !== '' ? input.hostId.trim() : previousId
  if (previous === undefined) {
    return registry.add({ hostId: nextId, hostTitle: '', address: input.address })
  }
  registry.remove(previousId)
  const result = registry.add({ hostId: nextId, hostTitle: '', address: input.address })
  if (!result.ok) {
    registry.add({ hostId: previous.hostId, hostTitle: previous.hostTitle, address: previous.address })
  }
  return result
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

/**
 * One host row in the list. The row is a line in a table — name, status, IP,
 * settings — and the whole row is the button that opens the host's detail page;
 * every row is one fixed height so the list reads as a table.
 * @param props - the merged row and the open handler.
 * @returns the row.
 */
export function HostRow(props: {
  readonly row: HostListRow
  readonly onOpen: () => void
}): ReactNode {
  const { row } = props
  // 本机没有登记地址（它的地址就是这个标签页自己的 URL），IP 列以 — 占位，
  // 不硬塞内部标识充数。
  const ip = hostOf(row.address)
  const status = row.self
    ? { word: '本机', tone: 'self' as const }
    : row.connection === 'connected'
      ? { word: '已连接', tone: 'online' as const }
      : row.connection === 'reachable'
        ? { word: connectionStatusLabel('reachable'), tone: 'online' as const }
        : row.connection === 'checking'
          ? { word: connectionStatusLabel('checking'), tone: 'offline' as const }
          : { word: connectionStatusLabel('disconnected'), tone: 'offline' as const }
  const connection = row.self ? '本机' : connectionStatusLabel(row.connection)
  return (
    <div data-host-row={row.hostId} className={styles.hostRow}>
      <button
        type="button"
        data-host-open={row.hostId}
        className={styles.hostRowButton}
        onClick={props.onOpen}
      >
        <span className={styles.hostNameCell}>
          <span
            data-host-status={status.tone}
            className={styles.hostStatusDot}
            title={status.word}
            aria-label={status.word}
            role="img"
          />
          <strong data-host-name="" className={styles.hostName}>{row.name}</strong>
        </span>
        <span data-host-connection="" className={styles.hostConnection} title={status.word}>{connection}</span>
        <span data-host-ip="" className={styles.hostIp} title={ip ?? undefined}>{ip ?? '—'}</span>
        {/* 设置按钮是这一行的动作（打开主机的设置页）。整行都是这个按钮，
            这里的 span 是它的第三列外观，不是又一个独立控件。 */}
        <span data-host-settings="" className={styles.rowSettings} aria-hidden="true">设置</span>
      </button>
    </div>
  )
}

type SshAuthMode = 'identityFile' | 'identityPem' | 'password'

function SshDeploySection(props: {
  readonly hostId: string
  readonly hostTitle: string
  readonly onHostIdChange: (value: string) => void
  readonly onHostTitleChange: (value: string) => void
  readonly onDeployed: (result: SshDeployResult) => void
  readonly onError: (message: string) => void
}): ReactNode {
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [proxyJump, setProxyJump] = useState('')
  const [authMode, setAuthMode] = useState<SshAuthMode>('identityFile')
  const [identityFile, setIdentityFile] = useState('')
  const [identityPem, setIdentityPem] = useState('')
  const [password, setPassword] = useState('')
  const [remoteWebPort, setRemoteWebPort] = useState('3081')
  const [keys, setKeys] = useState<readonly SshHostKeyCandidate[]>([])
  const [approvedFingerprint, setApprovedFingerprint] = useState('')
  const [busy, setBusy] = useState<'inspect' | 'deploy' | undefined>(undefined)
  const [progress, setProgress] = useState<SshDeployOperationView | undefined>(undefined)
  const [accessMode, setAccessMode] = useState<SshAccessMode>('host-ip')
  const [bindHost, setBindHost] = useState('')
  const [trustedHost, setTrustedHost] = useState('')
  const [deployed, setDeployed] = useState<SshDeployResult | undefined>(undefined)
  const [remoteAgents, setRemoteAgents] = useState<RemoteAgentDeploySelection>(() => (
    Object.fromEntries(REMOTE_DEPLOY_AGENT_SPECS.map(spec => [spec.key, true])) as RemoteAgentDeploySelection
  ))

  const sshPayload = (): SshConnectionInput => {
    const base: SshConnectionInput = { target: target.trim() }
    const withPort = port.trim() === '' ? base : { ...base, port: Number(port) }
    const withUser = user.trim() === '' ? withPort : { ...withPort, user: user.trim() }
    const withJump = proxyJump.trim() === '' ? withUser : { ...withUser, proxyJump: proxyJump.trim() }
    if (authMode === 'identityFile' && identityFile.trim() !== '') return { ...withJump, identityFile: identityFile.trim() }
    if (authMode === 'identityPem' && identityPem.trim() !== '') return { ...withJump, identityPem: identityPem.trim() }
    if (authMode === 'password' && password !== '') return { ...withJump, password }
    return withJump
  }

  const runInspect = (): void => {
    setBusy('inspect')
    setKeys([])
    setApprovedFingerprint('')
    void inspectSshHost(sshPayload()).then(result => {
      setBusy(undefined)
      if (!result.ok) {
        props.onError(result.error)
        return
      }
      setKeys(result.value.keys)
      const only = result.value.keys[0]
      if (result.value.keys.length === 1 && only !== undefined) setApprovedFingerprint(only.hostKeyFingerprint)
    })
  }

  const runDeploy = (): void => {
    if (approvedFingerprint === '') {
      props.onError('请先检查并批准 SSH 主机密钥指纹')
      return
    }
    if (!props.hostId.trim()) {
      props.onError('请填写主机标识')
      return
    }
    setBusy('deploy')
    setProgress(undefined)
    void startSshDeploy({
      hostId: props.hostId.trim(),
      hostTitle: props.hostTitle.trim() === '' ? props.hostId.trim() : props.hostTitle.trim(),
      ssh: { ...sshPayload(), hostKeyFingerprint: approvedFingerprint },
      ...(remoteWebPort.trim() === '' ? {} : { remoteWebPort: Number(remoteWebPort) }),
      accessMode,
      ...(bindHost.trim() === '' ? {} : { bindHost: bindHost.trim() }),
      ...(trustedHost.trim() === '' ? {} : { trustedHost: trustedHost.trim() }),
      remoteAgents,
    }).then(started => {
      if (!started.ok) {
        setBusy(undefined)
        props.onError(started.error)
        return
      }
      void waitSshDeployOperation(started.value.operationId, view => { setProgress(view) }).then(done => {
        setBusy(undefined)
        if (!done.ok) {
          props.onError(done.error)
          return
        }
        if (done.value.status !== 'succeeded' || done.value.result === undefined) {
          props.onError(done.value.error ?? '部署失败')
          return
        }
        setDeployed(done.value.result)
        props.onDeployed(done.value.result)
      })
    })
  }

  const copyLaunchUrl = (): void => {
    if (deployed === undefined) return
    void navigator.clipboard.writeText(deployed.launchUrl)
  }

  return (
    <div data-ssh-deploy="" className={styles.sshSection}>
      <p className={styles.note}>
        SSH 自动部署在本机（提供 Web 页面的那台机器）上执行：私钥路径指<strong>这台机器</strong>上的绝对路径；
        粘贴私钥或密码只发给本机 DSH 进程，不会写入日志。非 loopback 绑定不会使用 0.0.0.0，仍依赖 DSH 的 <code>?token=</code> 换 cookie。
      </p>
      <fieldset className={styles.accessModes}>
        <legend className={styles.summary}>访问方式</legend>
        <label className={styles.sshKeyRow}>
          <input type="radio" name="access-mode" checked={accessMode === 'host-ip'} onChange={() => { setAccessMode('host-ip') }} />
          <span>主机 IP（默认：远端自动检测 IP 并绑定，登记 <code>http://&lt;主机IP&gt;:&lt;端口&gt;</code>，不建 SSH 隧道）</span>
        </label>
        <label className={styles.sshKeyRow}>
          <input type="radio" name="access-mode" checked={accessMode === 'tunnel'} onChange={() => { setAccessMode('tunnel') }} />
          <span>本机 SSH 隧道（远端 127.0.0.1 + 本地端口转发）</span>
        </label>
      </fieldset>
      {accessMode === 'host-ip'
        ? (
            <label className={styles.field}>
              绑定地址（可选，留空则远端自动检测 Tailscale / 网卡 IP）
              <input className={styles.input} value={bindHost} onChange={event => { setBindHost(event.target.value) }} placeholder="192.168.x.x 或 100.x.x.x" />
            </label>
          )
        : undefined}
      {accessMode !== 'tunnel'
        ? (
            <label className={styles.field}>
              --trusted-host（可选，MagicDNS 名）
              <input className={styles.input} value={trustedHost} onChange={event => { setTrustedHost(event.target.value) }} placeholder="mybox.tail1234.ts.net" />
            </label>
          )
        : undefined}
      <div className={styles.formGrid}>
        <label className={styles.field}>
          SSH 主机
          <input className={styles.input} value={target} onChange={event => { setTarget(event.target.value) }} placeholder="192.168.1.10" />
        </label>
        <label className={styles.field}>
          端口
          <input className={styles.input} value={port} onChange={event => { setPort(event.target.value) }} />
        </label>
        <label className={styles.field}>
          用户
          <input className={styles.input} value={user} onChange={event => { setUser(event.target.value) }} placeholder="deploy" />
        </label>
        <label className={styles.field}>
          ProxyJump（可选）
          <input className={styles.input} value={proxyJump} onChange={event => { setProxyJump(event.target.value) }} />
        </label>
        <label className={styles.field}>
          认证方式
          <select className={styles.input} value={authMode} onChange={event => { setAuthMode(event.target.value as SshAuthMode) }}>
            <option value="identityFile">本机私钥路径</option>
            <option value="identityPem">粘贴私钥 PEM</option>
            <option value="password">密码（需本机安装 sshpass）</option>
          </select>
        </label>
        {authMode === 'identityFile'
          ? (
              <label className={styles.field}>
                私钥路径（Web 服务主机上）
                <input className={styles.input} value={identityFile} onChange={event => { setIdentityFile(event.target.value) }} placeholder="/home/me/.ssh/id_ed25519" />
              </label>
            )
          : authMode === 'identityPem'
            ? (
                <label className={styles.field}>
                  私钥 PEM
                  <textarea className={styles.textarea} value={identityPem} onChange={event => { setIdentityPem(event.target.value) }} rows={4} />
                </label>
              )
            : (
                <label className={styles.field}>
                  SSH 密码
                  <input type="password" className={styles.input} value={password} onChange={event => { setPassword(event.target.value) }} autoComplete="off" />
                </label>
              )}
        <label className={styles.field}>
          远端 DSH Web 端口
          <input className={styles.input} value={remoteWebPort} onChange={event => { setRemoteWebPort(event.target.value) }} />
        </label>
      </div>
      <fieldset className={styles.accessModes} data-ssh-remote-agents="">
        <legend className={styles.summary}>远端 Agent（ACP preset）</legend>
        <p className={styles.note}>
          勾选的 agent 会在远端 DSH 组合中启用（命令走 PATH，需目标机已安装对应二进制）；未勾选的将在部署后禁用。
        </p>
        {REMOTE_DEPLOY_AGENT_SPECS.map(spec => (
          <label key={spec.key} className={styles.sshKeyRow}>
            <input
              type="checkbox"
              checked={remoteAgents[spec.key] !== false}
              onChange={event => { setRemoteAgents(prev => ({ ...prev, [spec.key]: event.target.checked })) }}
            />
            <span>{spec.label}（<code>{spec.presetId}</code>）</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.formActions}>
        <button type="button" className={styles.action} disabled={busy !== undefined} onClick={runInspect}>
          {busy === 'inspect' ? '正在检查……' : '检查 SSH 主机密钥'}
        </button>
        <button type="button" className={styles.actionPrimary} disabled={busy !== undefined} onClick={runDeploy}>
          {busy === 'deploy' ? '正在部署……' : '部署 DSH 并登记'}
        </button>
      </div>
      {keys.length > 0
        ? (
            <div data-ssh-keys="" className={styles.sshKeys}>
              <p className={styles.stateLine}>请核对指纹后选择要信任的那把钥匙：</p>
              {keys.map(key => (
                <label key={key.hostKeyFingerprint} className={styles.sshKeyRow}>
                  <input
                    type="radio"
                    name="ssh-host-key"
                    checked={approvedFingerprint === key.hostKeyFingerprint}
                    onChange={() => { setApprovedFingerprint(key.hostKeyFingerprint) }}
                  />
                  <span>{key.algorithm} · {key.hostKeyFingerprint}</span>
                </label>
              ))}
            </div>
          )
        : undefined}
      {progress !== undefined
        ? (
            <p data-ssh-progress="" className={styles.stateLine}>
              {progress.progress.detail}
              {progress.status === 'failed' && progress.error !== undefined ? `（${progress.error}）` : ''}
            </p>
          )
        : undefined}
      {deployed !== undefined
        ? (
            <div data-ssh-launch-url="" className={styles.launchUrlBox}>
              <p className={styles.stateLine}>打开链接即可换 cookie 上线（已写入登记）：</p>
              <code className={styles.launchUrlText}>{deployed.launchUrl}</code>
              <div className={styles.formActions}>
                <button type="button" className={styles.action} data-action="copy-launch-url" onClick={copyLaunchUrl}>复制链接</button>
                <a className={styles.actionPrimary} data-action="open-launch-url" href={deployed.launchUrl} target="_blank" rel="noreferrer">打开</a>
              </div>
            </div>
          )
        : undefined}
      <label className={styles.field}>
        主机标识（部署后登记用）
        <input className={styles.input} value={props.hostId} onChange={event => { props.onHostIdChange(event.target.value) }} />
      </label>
      <label className={styles.field}>
        显示名
        <input className={styles.input} value={props.hostTitle} onChange={event => { props.onHostTitleChange(event.target.value) }} />
      </label>
    </div>
  )
}

/**
 * The form page both adding and viewing share — one component, two modes, so
 * a field changes in one place. Mode `new` collects the two operator-filled
 * fields (名称、IP) over 确定/取消, with 「从 Tailscale 选」 sitting before
 * the form to fill both at once. Mode `view` shows the same fields (minus the
 * ones this page has no business editing) plus the facts the host itself
 * reports — status, heartbeat, and the id the host announces, laid beside
 * what was filled in, with mismatches named out loud instead of silently
 * resolved. The back button lives outside the card: the card frames the
 * form, navigation is not part of it (2026-10-13 用户反馈).
 *
 * @param props - mode, initial values, field policy, the reported facts
 *   (view only), confirm/cancel handlers, and optional sections.
 * @returns the page.
 */
export function HostFormPage(props: {
  readonly mode: 'new' | 'view'
  readonly heading: string
  readonly values: HostFormValues
  readonly fields?: HostFormFieldPolicy | undefined
  readonly reported?: HostReportedFacts | undefined
  readonly message?: { readonly tone: 'ok' | 'bad'; readonly text: string } | undefined
  readonly agents?: ReactNode
  readonly footer?: ReactNode
  readonly notes?: ReactNode
  /** The storage posture line; the page renders it under the form. */
  readonly postureNote?: ReactNode
  readonly onConfirm: (values: HostFormValues) => boolean
  readonly onCancel: () => void
  /** 从 Tailscale 选的口（表单前面的入口）；缺省就不显示那个按钮。 */
  readonly tailscale?: TailscalePort | undefined
}): ReactNode {
  const [idDraft, setIdDraft] = useState(props.values.hostId)
  // IP 字段里放的是去协议的主机（可带端口）；入库前补协议，出库时剥掉。
  const [ipDraft, setIpDraft] = useState(hostPartOfAddress(props.values.address))
  const { reported } = props
  const fields = props.mode === 'new' ? ALL_FIELDS : props.fields ?? ALL_FIELDS
  const confirm = (): void => {
    // onConfirm 回 true＝保存成功，页面关掉回列表（列表本身就是保存结果的
    // 反馈：新行以「未连接」出现、名字换成新的）；回 false＝留在本页看错误。
    const close = props.onConfirm({ hostId: idDraft.trim(), address: addressFromHostPart(ipDraft) })
    if (close) props.onCancel()
  }
  // 自报标识与填写的名称当场比对（跟着输入走），不一致就明说，两边都保留。
  const idMatch = reported?.reportedId === undefined ? undefined : reported.reportedId === idDraft.trim()
  const addressHidden = props.mode === 'view' && !fields.address && props.values.address === ''

  // 从 Tailscale 选（表单前面的入口）：点开→读清单→列出；选一台→名称和 IP
  // 一起填上＋收起；刷新让主机侧重跑一次；收起只关不填。
  const [picker, setPicker] = useState<{ open: boolean; result?: TailscalePeersResult | undefined }>({ open: false })
  const canPickAddress = props.tailscale !== undefined && fields.address
  const openPicker = async (): Promise<void> => {
    if (props.tailscale === undefined) return
    setPicker({ open: true, result: undefined })
    const result = await props.tailscale.loadPeers()
    setPicker({ open: true, result })
  }
  const refreshPicker = async (): Promise<void> => {
    if (props.tailscale === undefined) return
    setPicker({ open: true, result: undefined })
    const result = await props.tailscale.refresh()
    setPicker({ open: true, result })
  }
  const pickPeer = (peer: TailscalePeer): void => {
    // 选中即填两个字段：名称用 peer 名，IP 用它的 tailnet 地址；端口不一样
    // 的在 IP 里自己补（如 100.101.1.7:3081）。
    setIdDraft(peer.name)
    setIpDraft(peer.ip)
    setPicker({ open: false })
  }
  return (
    <div data-panel-page={props.mode === 'new' ? 'add' : 'detail'} className={styles.formPage}>
      {/* 返回在方框外面（2026-10-13 用户反馈）：框住的是表单，导航不是表单
          的一部分。 */}
      <div className={styles.formNav}>
        <button
          type="button"
          data-form-cancel=""
          className={styles.action}
          onClick={props.onCancel}
        >‹ 返回</button>
      </div>
      <section data-form-card="" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>{props.heading}</h2>
          {/* 点开每一台主机都进这里：标题点明这是「主机管理」设置界面，
              下面的主机信息（自报标识、状态、登记字段）是其中一个栏目。 */}
          <span data-host-management-heading="" className={styles.managementTag}>主机管理</span>
          <span className={styles.spacer} />
        </div>
        {reported === undefined
          ? undefined
          : (
              <div data-reported-facts="" className={styles.reportedFacts}>
                {reported.self
                  ? <p className={styles.stateLine}>这就是本机：这里显示和编辑的是这个标签页自己声明的身份。</p>
                  : undefined}
                <p data-fact-online="" className={styles.stateLine}>
                  状态：{reported.online ? '在线' : '未连接'}
                  {reported.online && reported.lastSeen !== undefined
                    ? <span data-fact-heartbeat=""> · 最近心跳 {heartbeatWord(reported.lastSeen)}</span>
                    : undefined}
                </p>
                {!reported.online && !reported.self
                  ? (
                      <p data-fact-offline-note="" className={styles.stateLine}>
                        频道上没有这台主机的报数
                        {reported.onlineIds.length > 0
                          ? <>；现在在线的名称：<span data-fact-online-ids="">{reported.onlineIds.join('、')}</span></>
                          : null}
                        。
                      </p>
                    )
                  : undefined}
                {reported.reportedId !== undefined
                  ? (
                      <p data-fact-reported-id="" className={styles.stateLine}>
                        主机自报名称：{reported.reportedId}
                        {idMatch === true
                          ? <span data-fact-id-match="">（与填写一致）</span>
                          : <span data-fact-id-mismatch="" className={styles.mismatch}>（与填写的不一样；两边都保留，把名称改成它，两边就对上了）</span>}
                      </p>
                    )
                  : undefined}
              </div>
            )}
        {canPickAddress
          ? (
              <div data-tailscale-section="" className={styles.tailscaleSection}>
                {!picker.open
                  ? (
                      <button
                        type="button"
                        data-action="tailscale-pick"
                        className={styles.action}
                        onClick={() => { void openPicker() }}
                      >
                        从 Tailscale 选
                      </button>
                    )
                  : (
                      <div data-tailscale-picker="" className={styles.tailscalePicker}>
                        <div className={styles.tailscalePickerBar}>
                          <span className={styles.tailscalePickerTitle}>从 Tailscale 选一台</span>
                          <span className={styles.spacer} />
                          <button type="button" data-action="tailscale-refresh" className={styles.action} onClick={() => { void refreshPicker() }}>刷新</button>
                          <button type="button" data-action="tailscale-close" className={styles.action} onClick={() => { setPicker({ open: false }) }}>收起</button>
                        </div>
                        {picker.result === undefined
                          ? <p data-tailscale-state="loading" className={styles.stateLine}>正在读取清单……</p>
                          : picker.result.ok === false
                            ? <p data-tailscale-state="failed" className={styles.stateBad}>{picker.result.message}</p>
                            : (
                                <>
                                  {picker.result.note !== undefined
                                    ? <p data-tailscale-note="" className={styles.note}>{picker.result.note}</p>
                                    : undefined}
                                  {picker.result.peers.length === 0
                                    ? <p data-tailscale-state="empty" className={styles.stateLine}>清单是空的——只有本机，或还没登录 Tailscale。</p>
                                    : (
                                        <ul className={styles.tailscalePeerList}>
                                          {picker.result.peers.map(peer => (
                                            <li key={peer.name}>
                                              <button
                                                type="button"
                                                data-tailscale-peer={peer.name}
                                                data-tailscale-online={peer.online ? 'true' : 'false'}
                                                className={peer.online ? styles.tailscalePeer : styles.tailscalePeerOffline}
                                                onClick={() => { pickPeer(peer) }}
                                              >
                                                <span className={styles.tailscalePeerName}>{peer.name}</span>
                                                <span className={styles.tailscalePeerMeta}>{peer.ip} · {peer.online ? '在线' : '未连接'}</span>
                                              </button>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                </>
                              )}
                      </div>
                    )}
              </div>
            )
          : undefined}
        <form
          data-host-form=""
          className={styles.formGrid}
          onSubmit={event => {
            event.preventDefault()
            confirm()
          }}
        >
          <label className={styles.field}>
            名称
            {fields.id
              ? (
                  <input
                    value={idDraft}
                    data-form-field-id=""
                    className={styles.input}
                    onChange={event => { setIdDraft(event.target.value) }}
                    placeholder={props.mode === 'new' ? '如：mac-mini' : undefined}
                  />
                )
              : <span data-form-field-id="" className={styles.readonlyValue}>{props.values.hostId}</span>}
          </label>
          {addressHidden
            ? undefined
            : (
                <label className={styles.field}>
                  IP
                  {fields.address
                    ? (
                        <input
                          value={ipDraft}
                          data-form-field-address=""
                          className={styles.input}
                          onChange={event => { setIpDraft(event.target.value) }}
                          placeholder="100.101.1.7，可带端口：100.101.1.7:3081"
                        />
                      )
                    : <span data-form-field-address="" className={styles.readonlyValue}>{hostPartOfAddress(props.values.address)}</span>}
                </label>
              )}
        </form>
        {props.message === undefined
          ? undefined
          : <p data-form-message={props.message.tone} className={props.message.tone === 'ok' ? styles.stateLine : styles.stateBad}>{props.message.text}</p>}
        {props.postureNote}
        <div className={styles.formActions}>
          {props.mode === 'new' || fields.id || fields.address
            ? (
                <button type="button" data-form-confirm="" className={styles.actionPrimary} onClick={confirm}>
                  {props.mode === 'new' ? '确定' : '保存'}
                </button>
              )
            : undefined}
          <button type="button" data-form-cancel-bottom="" className={styles.action} onClick={props.onCancel}>
            {props.mode === 'new' ? '取消' : '返回列表'}
          </button>
        </div>
        {props.footer}
        {props.agents}
        {props.notes}
      </section>
    </div>
  )
}

/** Which page the panel is showing; the three never share a screen. */
type PanelView =
  | { readonly page: 'list' }
  | { readonly page: 'add' }
  | { readonly page: 'detail'; readonly hostId: string }

/**
 * The panel body: a list page, an add page, and a detail page per host —
 * three views of the same small state machine, never on screen at once.
 * @param props - the injected face.
 * @returns the panel.
 */
export function AgentPanel(props: AgentPanelProps): ReactNode {
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>(() => props.agents.current())
  const [load, setLoad] = useState<LoadPhase>(
    () => props.agents.current().length > 0 ? { stage: 'loaded' } : { stage: 'pristine' },
  )
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeRunState>>(new Map())
  const [view, setView] = useState<PanelView>({ page: 'list' })
  const [, setIdentityRevision] = useState(0)
  const [registryRevision, setRegistryRevision] = useState(0)
  const [formMessage, setFormMessage] = useState<{ readonly tone: 'ok' | 'bad'; readonly text: string } | undefined>(undefined)
  const [addMode, setAddMode] = useState<'manual' | 'ssh'>('manual')
  const [addIdDraft, setAddIdDraft] = useState('')
  const [addTitleDraft, setAddTitleDraft] = useState('')
  const [addAddressDraft, setAddAddressDraft] = useState('')
  const [sshDeployAvailable, setSshDeployAvailable] = useState(false)
  useEffect(() => {
    void probeSshDeployApi().then(setSshDeployAvailable)
  }, [])
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [reaches, setReaches] = useState<ReadonlyMap<string, ReachOutcome | 'probing'>>(new Map())
  // The host list lives in the section, not in React state; this tick is what
  // re-reads it — presence changes and heartbeat ages both arrive without one.
  const [, setListTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => { setListTick(tick => tick + 1) }, 3000)
    return () => { window.clearInterval(timer) }
  }, [])

  // A fresh mount reads the catalog once instead of waiting for a click: the
  // agent section must not open on "没有列出任何 acp agent" for a host that is
  // serving one, purely because nobody had pressed 刷新 yet.
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

  // The storage posture changes on its own schedule: the first read of the
  // machine's document lands after mount, and a write can fail later. Either
  // way the line on screen must move with it, and the list and the identity
  // header re-read too — hydration fills both.
  useEffect(() => props.hostStore?.subscribe(() => {
    setRegistryRevision(revision => revision + 1)
    setIdentityRevision(revision => revision + 1)
  }), [props.hostStore])

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
  const openList = (): void => {
    setFormMessage(undefined)
    setConfirmingRemove(false)
    setView({ page: 'list' })
  }
  const confirmAdd = (values: HostFormValues): boolean => {
    // 显示名已撤销（2026-10-13）：hostTitle 落库留空，存储层回落到 hostId，
    // 列表显示的就是名称本身。
    const result = props.registry.add({ hostId: values.hostId, hostTitle: '', address: values.address })
    // 成功不留在本页：关闭后的列表里那行「未连接」就是结果。只把失败留在页面上。
    if (!result.ok) {
      setFormMessage({ tone: 'bad', text: result.error.detail })
    }
    setRegistryRevision(revision => revision + 1)
    return result.ok
  }
  const confirmEdit = (previousId: string, values: HostFormValues): boolean => {
    const result = applyRegistrationEdit(props.registry, previousId, {
      ...(values.hostId === '' || values.hostId === previousId ? {} : { hostId: values.hostId }),
      address: values.address,
    })
    if (!result.ok) {
      setFormMessage({ tone: 'bad', text: result.error.detail })
    }
    setRegistryRevision(revision => revision + 1)
    return result.ok
  }
  const confirmSelf = (values: HostFormValues): boolean => {
    // 名称同时写 id 和 title：id 是频道上认账的键，title 是列表显示的名。
    // 只写 id 的话，本机行的显示会退回派生名（如 127.0.0.1），名称就白改了。
    props.rollUp.setIdentity({
      ...(values.hostId === '' ? {} : { hostId: values.hostId, hostTitle: values.hostId }),
    })
    // The section's identity is read at render time; this bump is what makes
    // the panel show the new one.
    setIdentityRevision(revision => revision + 1)
    return true
  }
  const removeRegistration = (hostId: string): void => {
    props.registry.remove(hostId)
    setConfirmingRemove(false)
    setRegistryRevision(revision => revision + 1)
  }
  const startReach = (registration: HostRegistration): void => {
    setReaches(previous => new Map(previous).set(registration.hostId, 'probing'))
    void probeReach((input, init) => fetch(input, init), registration.address, 5000).then(outcome => {
      setReaches(previous => new Map(previous).set(registration.hostId, outcome))
    })
  }

  const identity = props.rollUp.identity()
  const registrations = props.registry.list()
  // Re-read on every render, including every list tick: presence and the
  // registry both change out from under this component.
  const presence = props.rollUp.hosts()
  const hostRows = mergeHostRows(presence, registrations, reaches)

  useEffect(() => {
    props.remoteSessions?.refresh(registrations)
    const timer = window.setInterval(() => { props.remoteSessions?.refresh(registrations) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [props.remoteSessions, registryRevision, registrations])

  useEffect(() => props.remoteSessions?.subscribe(() => { setListTick(tick => tick + 1) }) ?? (() => undefined), [props.remoteSessions])

  if (view.page === 'add') {
    if (sshDeployAvailable && addMode === 'ssh') {
      return (
        <div data-threadharbor-panel="" className={styles.root}>
          <section data-panel-page="add-ssh" className={styles.card}>
            <div className={styles.cardHead}>
              <button type="button" className={styles.action} onClick={openList}>‹ 返回</button>
              <h2 className={styles.title}>SSH 自动部署</h2>
              <span className={styles.spacer} />
              <button type="button" className={styles.action} onClick={() => { setAddMode('manual'); setFormMessage(undefined) }}>手动登记</button>
            </div>
            <StoragePostureLine posture={props.hostStore?.posture()} />
            {formMessage !== undefined
              ? <p data-form-message={formMessage.tone} className={formMessage.tone === 'ok' ? styles.stateLine : styles.stateBad}>{formMessage.text}</p>
              : undefined}
            <SshDeploySection
              hostId={addIdDraft}
              hostTitle={addTitleDraft}
              onHostIdChange={setAddIdDraft}
              onHostTitleChange={setAddTitleDraft}
              onError={message => { setFormMessage({ tone: 'bad', text: message }) }}
              onDeployed={deployResult => {
                const result = props.registry.add({
                  hostId: addIdDraft.trim(),
                  hostTitle: addTitleDraft.trim(),
                  address: deployResult.endpoint,
                  launchUrl: deployResult.launchUrl,
                })
                if (!result.ok) {
                  setFormMessage({ tone: 'bad', text: result.error.detail })
                  return
                }
                setRegistryRevision(revision => revision + 1)
                setFormMessage({
                  tone: 'ok',
                  text: `已登记 ${deployResult.endpoint}。点「打开」在新标签页完成 token 交换后，跨标签页频道会显示在线。`,
                })
              }}
            />
          </section>
        </div>
      )
    }
    return (
      <div data-threadharbor-panel="" className={styles.root}>
        <HostFormPage
          key="add"
          mode="new"
          heading="添加新主机"
          values={{ hostId: addIdDraft, address: addAddressDraft }}
          message={formMessage}
          postureNote={<StoragePostureLine posture={props.hostStore?.posture()} />}
          footer={sshDeployAvailable
            ? (
                <p className={styles.note}>
                  也可以在远端自动安装 DSH 与 ThreadHarbor：
                  <button type="button" data-action="add-host-ssh" className={styles.action} onClick={() => { setAddMode('ssh'); setFormMessage(undefined) }}>SSH 自动部署</button>
                </p>
              )
            : undefined}
          onConfirm={values => {
            setAddIdDraft(values.hostId)
            setAddAddressDraft(values.address)
            return confirmAdd(values)
          }}
          onCancel={openList}
          tailscale={props.tailscale}
        />
      </div>
    )
  }

  if (view.page === 'detail') {
    const row = hostRows.find(candidate => candidate.hostId === view.hostId)
    // 详情指向的主机不在了（删除、改名）：回列表，不渲染空页。
    if (row !== undefined) {
      const registration = registrations.find(entry => entry.hostId === row.hostId)
      const reported: HostReportedFacts = {
        self: row.self,
        online: row.online,
        ...(row.lastSeen === undefined ? {} : { lastSeen: row.lastSeen }),
        ...(row.online ? { reportedId: row.hostId } : {}),
        onlineIds: props.rollUp.onlineHostIds(),
      }
      const values: HostFormValues = {
        hostId: row.self ? identity.hostId : row.hostId,
        address: row.address ?? '',
      }
      // 本机的名称是本机身份，可编辑；地址是登记簿的东西，只读展示。
      // 外来主机登记过就能整行改；只是路过（同源另一标签页）也一样开放
      // 填写，保存即登记。
      const fields = row.self
        ? { id: true, address: false }
        : { id: true, address: true }
      const reach = reaches.get(row.hostId)
      return (
        <div data-threadharbor-panel="" className={styles.root}>
          {/* Key on the row's id only: a background identity re-read (the
              storage notifying after a registry write) must not remount this
              form — a remount re-seeds the drafts and throws away what the
              operator is typing. When hydration changes the identity's id the
              key still changes, so the form re-seeds exactly then. */}
          <HostFormPage
            key={`detail-${row.hostId}`}
            mode="view"
            heading={row.name}
            values={values}
            fields={fields}
            reported={reported}
            message={formMessage}
            postureNote={<StoragePostureLine posture={props.hostStore?.posture()} />}
            onConfirm={values => row.self ? confirmSelf(values) : confirmEdit(view.hostId, values)}
            onCancel={openList}
            tailscale={props.tailscale}
            footer={registration !== undefined
              ? (
                  <div data-registry-actions="" className={styles.registryActions}>
                    <p data-host-connection="" className={styles.stateLine}>
                      状态：{connectionStatusLabel(row.connection)}
                      {row.connection === 'disconnected' || row.connection === 'reachable'
                        ? (
                            <>
                              {' '}
                              <button type="button" data-registry-reach-try="" className={styles.action} onClick={() => { startReach(registration) }}>检测可达</button>
                            </>
                          )
                        : undefined}
                    </p>
                    {reach !== undefined && reach !== 'probing' && reach.kind !== 'reachable'
                      ? <p className={styles.stateBad}>{reach.kind === 'timeout' ? `检测超时（${reach.ms} ms）` : reach.reason}</p>
                      : undefined}
                    {registration.launchUrl !== undefined
                      ? (
                          <p data-registry-launch="" className={styles.stateLine}>
                            <a className={styles.actionPrimary} href={registration.launchUrl} target="_blank" rel="noreferrer">连接（打开含 token 的页面）</a>
                            <button
                              type="button"
                              className={styles.action}
                              onClick={() => { void navigator.clipboard.writeText(registration.launchUrl ?? '') }}
                            >复制链接</button>
                          </p>
                        )
                      : undefined}
                    {sshDeployAvailable && !row.self
                      ? (
                          <p className={styles.stateLine}>
                            <button
                              type="button"
                              data-action="redeploy-ssh"
                              className={styles.actionPrimary}
                              onClick={() => {
                                setAddIdDraft(registration.hostId)
                                setAddTitleDraft(registration.hostTitle)
                                setAddMode('ssh')
                                setFormMessage(undefined)
                                setView({ page: 'add' })
                              }}
                            >重新部署 DSH</button>
                          </p>
                        )
                      : undefined}
                    {!confirmingRemove
                      ? (
                          <button type="button" data-registry-remove-ask="" className={styles.action} onClick={() => { setConfirmingRemove(true) }}>删除登记</button>
                        )
                      : (
                          <span data-registry-confirm="" className={styles.confirmBox}>
                            只从这台机器的登记列表里移除，不动远端那台机器。确定？
                            <button type="button" data-registry-remove-confirm="" className={styles.action} onClick={() => { removeRegistration(row.hostId); openList() }}>确定删除</button>
                            <button type="button" data-registry-remove-cancel="" className={styles.action} onClick={() => { setConfirmingRemove(false) }}>取消</button>
                          </span>
                        )}
                  </div>
                )
              : undefined}
            agents={row.self
              ? (
                  <div data-agent-section="" className={styles.agentSection}>
                    <div className={styles.sectionHead}>
                      <h3 className={styles.sectionTitle}>本机 agent</h3>
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
                              <div data-agent-list="" className={styles.agentList}>
                                {dedupeAgents(agents).map(agent => (
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
                  </div>
                )
              : undefined}
            notes={(
              <details className={styles.noteDetails}>
                <summary className={styles.summary}>说明</summary>
                <ul data-panel-notices="" className={styles.notices}>
                  <li>「在线」= 这台机器的页面在同一个浏览器的同源标签页里开着并按心跳报数；关闭或崩溃的页面过了静默窗口会自动转为未列出。</li>
                  <li>另一台机器（另一个源）的页面不在这个频道里；它的行以「未连接」出现，靠的是登记。</li>
                  <li>左侧树按主机列出项目与会话：本机来自 DSH 投影；远端登记主机通过 launchUrl 由管理端拉取（失败时请点「连接」打开远端页面）。</li>
                </ul>
              </details>
            )}
          />
        </div>
      )
    }
  }

  return (
    <div data-threadharbor-panel="" className={styles.root}>
      <section data-panel-page="list" className={styles.listLayout}>
        <div data-session-tree="" className={styles.sessionTreePane}>
          <h2 className={styles.title}>会话（按主机）</h2>
          <div ref={attachRollUpMount(props.rollUp)} data-rollup-host="" className={styles.rollupHost} />
        </div>
        <div data-host-pane="" className={styles.hostPane}>
          <div className={styles.pageHead}>
            <h2 className={styles.title}>主机</h2>
            <span className={styles.spacer} />
            <button
              type="button"
              data-action="add-host"
              className={styles.actionPrimary}
              onClick={() => { setFormMessage(undefined); setView({ page: 'add' }) }}
            >添加新主机</button>
          </div>
          <StoragePostureLine posture={props.hostStore?.posture()} />
          <div data-host-list="" className={styles.hostList}>
            <div data-host-list-head="" className={styles.hostListHead} aria-hidden="true">
              <span className={styles.hostListHeadLabel}>名称</span>
              <span className={styles.hostListHeadLabel}>状态</span>
              <span className={styles.hostListHeadLabel}>IP</span>
              <span className={styles.hostListHeadLabel} />
            </div>
            {hostRows.length === 0
              ? <p data-host-list-empty="" className={styles.hostListEmpty}>还没有主机。点「添加新主机」登记第一台。</p>
              : hostRows.map(row => (
                  <HostRow
                    key={row.hostId}
                    row={row}
                    onOpen={() => { setFormMessage(undefined); setConfirmingRemove(false); setView({ page: 'detail', hostId: row.hostId }) }}
                  />
                ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function attachRollUpMount(section: RollUpSection): (node: HTMLDivElement | null) => void {
  return node => {
    if (node === null) return
    node.replaceChildren(section.element())
  }
}
