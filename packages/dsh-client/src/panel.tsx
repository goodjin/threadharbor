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

import { createElement, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { describeVerdict } from './verdict.ts'
import type { ProbeVerdict } from './verdict.ts'
import type { RollUpSection } from './rollup-section.ts'
import type { ConfiguredIdentity } from './settings-source.ts'
import type { AgentDescriptor, GatewayResult } from './gateway.ts'
import type { ProbeOutcome } from './probe.ts'
import { probeReach } from './reach.ts'
import type { ReachOutcome } from './reach.ts'
import { hostActions, hostStatus } from './host-state.ts'
import type { HostAction, HostFacts, HostReach, HostStatus, RemoteDeployment, RemoteLiveness } from './host-state.ts'
import type { HostIdentity, HostRegistration, HostSshInfo, PeerReport, PeerStatus, RegistrationResult, RemoteAgentDeploySelection, RemoteReport, SshConfigHostEntry, SshConnectionInput, SshDeployResult, SshHostKeyCandidate, SshLocalAssets } from '@threadharbor/dsh-host-federation'
import { REMOTE_DEPLOY_AGENT_SPECS, gatewayPagePath } from '@threadharbor/dsh-host-federation'
import type { HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { HostStorePosture } from './host-store.ts'
import {
  connectRemoteHost,
  checkRemotePeer,
  configureRemoteServe,
  controlRemoteService,
  inspectSshHost,
  probeSshDeployApi,
  readRemotePeer,
  listSshIdentityFiles,
  startSshDeploy,
  waitSshDeployOperation,
} from './ssh-deploy.ts'
import type { ServeFailure } from './ssh-deploy.ts'
import { loadSshLocalAssets, pickSshIdentityFile } from './ssh-local.ts'
import type { PeerCheckAction, PeerCheckReport, SshDeployOperationView, SshDeployProgress } from '@threadharbor/dsh-host-federation'
import { PeerCheckList } from './host-check.tsx'
import { buildOpsAiPrompt, hostContextFromSshInfo, type OpsAiHostContext } from './copy-for-ai.ts'
import { CopyForAiButton } from './copy-for-ai-button.tsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NAMESPACE } from './locales.ts'
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
    readonly ssh?: HostSshInfo
  }): RegistrationResult
  remove(hostId: string): boolean
  /** Persist one remote read for a host, in the remote-report.ts shape (readAt required). */
  recordRemote(hostId: string, report: RemoteReport): boolean
}

/** One remote read, as the panel consumes it: the report or the raw reason. */
export type RemoteReadResult =
  | { readonly ok: true; readonly report: PeerReport }
  | { readonly ok: false; readonly error: string }

/** One remote start, as the panel consumes it: the answering port or the raw reason. */
export type RemoteStartResult =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly error: string }

/**
 * 面板读/启对方部署体的口。凭据在调用方组装（已存、已批准指纹的形状），
 * 面板不碰 SSH 本身；缺了这个口，详情页就没有读数可显示，状态词退回
 * 只看连通性与登记。
 */
export type RemotePort = {
  read(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }): Promise<RemoteReadResult>
  start(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }, port: number): Promise<RemoteStartResult>
}

/** The `t` seat, as the framework synthesizes it for this plugin's namespace. */
export type PanelT = PropsLocale<typeof NAMESPACE>['t']

/** What the panel reads from the page wiring, without the framework shares. */
export type AgentPanelBusinessProps = {
  readonly agents: AgentListPort
  readonly probe: ProbeStarter
  /** The host-list section, owned by the wiring so the panel has no setup to do. */
  readonly rollUp: RollUpSection
  /** The registration list for other hosts; owned by the wiring. */
  readonly registry: HostRegistryPort
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
  /**
   * 读/启对方部署体的口。缺省（主机侧路由缺失）时详情页不发起读取，
   * 也不渲染读数事实区——状态词如实退回连通性与登记。
   */
  readonly remote?: RemotePort
  /** Storage events re-read the registry; injectable for tests. */
  listenStorage?(handler: () => void): () => void
  /** Whole-page navigation into another host's gateway; injectable for tests. */
  navigate?(url: string): void
  /** Said instead of an empty list, so "none listed" never reads as "none configured". */
  readonly agentsNote?: string | undefined
}

/**
 * What AgentPanel receives: the wiring's face plus the framework's `t` seat.
 * The seat exists because the `main` slot registration declares
 * `locale: NAMESPACE` (client/index.ts) — a component that renders copy but
 * has no `t` would silently ship hardcoded text instead.
 */
export type AgentPanelProps = PropsLocale<typeof NAMESPACE> & AgentPanelBusinessProps

/** How a storage posture reads on screen. */
export type StoragePostureDisplay = {
  readonly tone: 'ok' | 'info' | 'bad'
  readonly text: string
}

/**
 * The posture, in one honest sentence. Every state names where the data
 * stands — including the good one, so "saved on this machine" is visible and
 * its absence is a question a user knows to ask. The wording lives in the
 * locale dictionary; this is a plain function, so the caller's seat rides in.
 * @param posture - the storage's own account of itself.
 * @param t - the caller's locale seat.
 * @returns tone and text for the line.
 */
export function storagePostureLine(posture: HostStorePosture, t: PanelT): StoragePostureDisplay {
  switch (posture.kind) {
    case 'host':
      return { tone: 'ok', text: t('panel.posture.host') }
    case 'loading':
      return { tone: 'info', text: t('panel.posture.loading') }
    case 'memory':
      return posture.reason === 'remote-page'
        ? { tone: 'bad', text: t('panel.posture.memoryRemotePage') }
        : { tone: 'bad', text: t('panel.posture.memoryNoChannel') }
    case 'degraded':
      return { tone: 'bad', text: t('panel.posture.degraded', { detail: posture.detail }) }
  }
}

/** The one posture line, shared by every page that edits stored data. */
function StoragePostureLine(props: { readonly posture: HostStorePosture | undefined; readonly t: PanelT }): ReactNode {
  if (props.posture === undefined) return undefined
  const display = storagePostureLine(props.posture, props.t)
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
export type HostListRow = {
  readonly hostId: string
  /** What the row leads with: the operator's registered name, else the host's own. */
  readonly name: string
  readonly self: boolean
  /** Present on the channel right now. */
  readonly online: boolean
  /** hostStatus 推出的那个状态词：这一行显示什么词、给不给探测按钮都由它说话。 */
  readonly connection: HostStatus
  /** When the host was last heard, in the page's clock; only when online. */
  readonly lastSeen?: number
  /** The address the operator registered; only when there is one. */
  readonly address?: string
  readonly launchUrl?: string
}

/**
 * 存下的 SSH 信息够不够面板自己去读这台机器：只有密钥文件方式、钥匙路径和
 * 已批准的指纹齐了才成立。密码、粘贴的私钥刻意不落盘，这类主机不可读，
 * 也就没有部署事实可看——读不读得动由这里一个地方说了算。
 * 类型收窄成带必填钥匙与指纹的形状，重连路径直接复用同一把尺子。
 */
function storedSshUsable(info: HostSshInfo | undefined): info is HostSshInfo & { readonly hostKeyFingerprint: string; readonly identityFile: string } {
  return info !== undefined
    && info.authMode === 'identityFile'
    && info.hostKeyFingerprint !== undefined
    && info.identityFile !== undefined
}

/**
 * 面板手头的探测结果读成 host-state 的 HostReach：没探过是 unchecked，
 * 探测在途是 checking，探完按结论。
 */
function hostReachOf(reach: ReachOutcome | 'probing' | undefined): HostReach {
  if (reach === undefined) return 'unchecked'
  if (reach === 'probing') return 'checking'
  return reach.kind === 'reachable' ? 'reachable' : 'unreachable'
}

/**
 * 一台主机的事实装配，只此一处：是不是本机、频道在不在场（对方回连）、
 * 登记簿里存下的远端读数、探测结果、凭据读不读得动。装配只如实搬运——
 * 读数里缺什么记 unknown，哪个事实算数由 hostStatus 的分支顺序决定。
 * @param self - 这一行是不是本机。
 * @param online - 这台机器的频道此刻是否在场（即对方回连可见）。
 * @param registration - 登记簿条目；路过未登记的主机没有。
 * @param reach - 对登记地址的探测结果；从未探测时没有。
 * @returns 推导状态词所需的全部事实。
 */
function hostFactsFor(
  self: boolean,
  online: boolean,
  registration: HostRegistration | undefined,
  reach: ReachOutcome | 'probing' | undefined,
): HostFacts {
  const remote = registration?.remote
  return {
    self,
    readable: storedSshUsable(registration?.ssh),
    // 评审裁定 1 在展示层的闸：读数若说「未部署」却带着存活附注，说明机器
    // 没能在预算内答话（记录超时也是这么报的），不是真的没装——按未知呈现，
    // 否则面板会劝操作者往一台已经装好的机器上再部署一遍。只看附注在不在，
    // 绝不比对附注的文字。
    deployment: remote?.deployment === 'undeployed' && remote.livenessNote !== undefined
      ? 'unknown'
      : remote?.deployment ?? 'unknown',
    liveness: remote?.liveness ?? 'unknown',
    reach: hostReachOf(reach),
    reported: online,
  }
}

/**
 * 一次读取的回信折算成登记簿的读数。裁定 1 的另一半闸在落库这一侧：
 * 记录说没装、却带着存活附注，是降级读取（机器没来得及答话），部署事实
 * 按 unknown 落库——「未部署」只留给没有附注、真的没有记录的那次回答。
 * @param report - 对方的读数原样。
 * @param readAt - 读取发生的时刻（页面时钟）。
 * @returns 可以交给 recordRemote 的读数。
 */
function remoteRecordOf(report: PeerReport, readAt: number): RemoteReport {
  const deployment: RemoteDeployment = report.pluginsInstalled
    ? 'deployed'
    : report.livenessNote !== undefined ? 'unknown' : 'undeployed'
  return {
    deployment,
    liveness: report.liveness,
    ...(report.livenessNote === undefined ? {} : { livenessNote: report.livenessNote }),
    ...(report.port === undefined ? {} : { port: report.port }),
    ...(report.launchUrl === undefined ? {} : { launchUrl: report.launchUrl }),
    readAt,
  }
}

/** 部署事实的取值词；缺「已部署」一词，facts 键就地补，其余复用状态词。 */
function deploymentWord(deployment: RemoteDeployment, t: PanelT): string {
  if (deployment === 'deployed') return t('panel.facts.deployed')
  if (deployment === 'undeployed') return t('panel.status.undeployed')
  return t('panel.status.unknown')
}

/** 存活事实的取值词；缺「运行中」一词，facts 键就地补，其余复用状态词。 */
function livenessWord(liveness: RemoteLiveness, t: PanelT): string {
  if (liveness === 'running') return t('panel.facts.running')
  if (liveness === 'stopped') return t('panel.status.stopped')
  return t('panel.status.unknown')
}

/**
 * 状态行动作标识符的按钮文案。host-state 只产出标识符，人话在这里查表；
 * approve-and-read 是面板自有的一条（指纹未批准时的读取路径），不在
 * host-state 的词表里。
 */
function actionLabel(action: HostAction | 'approve-and-read', t: PanelT): string {
  switch (action) {
    case 'deploy': return t('panel.deploy.expand')
    case 'read-peer': return t('panel.button.readPeer')
    case 'start-peer': return t('panel.button.startPeer')
    case 'redeploy': return t('panel.button.redeploy')
    case 'open-page': return t('panel.use.open')
    case 'connect-open': return t('panel.use.connect')
    case 'check-reach': return t('panel.button.checkReach')
    case 'fill-ssh': return t('panel.use.fillSsh')
    case 'retry-read': return t('panel.button.retryRead')
    case 'approve-and-read': return t('panel.button.approveAndRead')
  }
}

/**
 * HostStatus 的九个词各查一个 locale 键。词与词不重叠，键与词一一对应，
 * 这里不留兜底：加状态词先加键。
 */
export function connectionStatusLabel(status: HostStatus, t: PanelT): string {
  switch (status) {
    case 'self': return t('panel.status.self')
    case 'reading': return t('panel.status.checking')
    case 'undeployed': return t('panel.status.undeployed')
    case 'stopped': return t('panel.status.stopped')
    case 'connected': return t('panel.status.connected')
    case 'reachable': return t('panel.status.reachableUnsynced')
    case 'disconnected': return t('panel.status.offline')
    case 'unchecked': return t('panel.status.unchecked')
    case 'unknown': return t('panel.status.unknown')
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
  reading?: ReadonlySet<string>,
): readonly HostListRow[] {
  const byId = new Map<string, HostListRow>()
  const registered = new Map(registrations.map(entry => [entry.hostId, entry]))
  // 读取在途（探测或远端读取）交给 hostStatus 说「读取中」，不抢答。
  const readingNow = (hostId: string, reach: ReachOutcome | 'probing' | undefined): boolean =>
    reach === 'probing' || reading?.has(hostId) === true
  for (const host of hosts) {
    const reach = reaches?.get(host.hostId)
    const base = {
      hostId: host.hostId,
      name: nonEmpty(host.hostTitle) ?? host.hostId,
      self: host.self,
      online: true,
      lastSeen: host.lastSeen,
    }
    byId.set(host.hostId, {
      ...base,
      // 探测在途交给 hostStatus 说「读取中」，不抢答；事实装配只在 hostFactsFor。
      connection: hostStatus(hostFactsFor(host.self, true, registered.get(host.hostId), reach), readingNow(host.hostId, reach)),
    })
  }
  for (const registration of registrations) {
    const reach = reaches?.get(registration.hostId)
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
        connection: hostStatus(hostFactsFor(false, false, registration, reach), readingNow(registration.hostId, reach)),
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
        connection: hostStatus(hostFactsFor(merged.self, merged.online, registration, reach), readingNow(registration.hostId, reach)),
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

export function deriveHostIdFromAddress(value: string): string {
  const raw = addressFromHostPart(value)
  if (raw === '') return ''
  let host = raw
  try {
    host = new URL(raw).hostname
  } catch {
    // Not parseable as a URL: sanitize what was typed.
  }
  return host.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/**
 * Split what the IP field holds into the registry's origin and, when the
 * operator pasted a running service's `?token=` URL, the launch URL.
 * The registry drops query strings from the address, so the token has to be
 * lifted out here or the gateway cannot open the host.
 * @param value - an IP, host[:port], or a full URL, with or without a token.
 * @returns the origin to store, plus launchUrl only when a token is present.
 */
export function registrationAddress(value: string): { readonly address: string; readonly launchUrl?: string } {
  const raw = addressFromHostPart(value)
  if (raw === '') return { address: '' }
  try {
    const url = new URL(raw)
    const token = url.searchParams.get('token')
    if (token !== null && token !== '') return { address: url.origin, launchUrl: url.toString() }
    return { address: url.origin }
  } catch {
    return { address: raw }
  }
}

/**
 * How long since the host was last heard, in words. The wording lives in the
 * locale dictionary; this is a plain function, so the caller's seat rides in.
 * @param lastSeen - the page-clock time of the last announcement.
 * @param now - the page clock; defaults to Date.now, injected for tests.
 * @param t - the caller's locale seat.
 * @returns panel.time.justNow / secondsAgo / minutesAgo / hoursAgo.
 */
export function heartbeatWord(lastSeen: number, now: number = Date.now(), t: PanelT): string {
  const seconds = Math.max(0, Math.floor((now - lastSeen) / 1000))
  if (seconds < 5) return t('panel.time.justNow')
  if (seconds < 60) return t('panel.time.secondsAgo', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('panel.time.minutesAgo', { n: minutes })
  return t('panel.time.hoursAgo', { n: Math.floor(minutes / 60) })
}

/**
 * What an operator fills in for one host: its name and where it lives. The
 * name is the hostId — 2026-10-13 用户决定：主机只有这两个字段，显示名撤销，
 * 主机标识改名「名称」并兼任显示名（登记时 hostTitle 落库留空，存储层回落
 * 到 hostId，列表显示的就是名称）。The address is the full origin the
 * registry stores; the form's IP field shows it without the scheme
 * （hostPartOfAddress / addressFromHostPart 在边界上互转）. A pasted
 * `?token=` URL also carries launchUrl so the gateway can open it.
 */
export type HostFormValues = {
  readonly hostId: string
  readonly address: string
  readonly launchUrl?: string
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
  readonly hostTitle?: string
  readonly launchUrl?: string
  readonly ssh?: HostSshInfo
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
 * is simply an add. Facts the input does not mention carry over from the
 * previous entry (title, launchUrl, ssh); a launchUrl that no longer matches
 * the new address is dropped rather than erroring — the connect flow
 * regenerates it. 显示名已撤销（2026-10-13），旧登记里不一样的 hostTitle 在
 * 下一次保存时被名称取代.
 * @param registry - the registry port as the wiring provides it.
 * @param previousId - which registration to replace.
 * @param input - the new name (omit to keep the old one) and address, plus any
 *   facts to refresh (launchUrl from a connect, ssh from a deploy).
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
    return registry.add({ hostId: nextId, hostTitle: input.hostTitle ?? '', address: input.address })
  }
  const restore = (): void => {
    registry.add({
      hostId: previous.hostId,
      hostTitle: previous.hostTitle,
      address: previous.address,
      ...(previous.launchUrl === undefined ? {} : { launchUrl: previous.launchUrl }),
      ...(previous.ssh === undefined ? {} : { ssh: previous.ssh }),
    })
  }
  let launchUrl = input.launchUrl ?? previous.launchUrl
  if (launchUrl !== undefined) {
    try {
      if (new URL(launchUrl).origin !== new URL(input.address).origin) launchUrl = undefined
    } catch {
      launchUrl = undefined
    }
  }
  const ssh = input.ssh ?? previous.ssh
  registry.remove(previousId)
  const result = registry.add({
    hostId: nextId,
    hostTitle: input.hostTitle ?? '',
    address: input.address,
    ...(launchUrl === undefined ? {} : { launchUrl }),
    ...(ssh === undefined ? {} : { ssh }),
  })
  if (!result.ok) restore()
  return result
}

/**
 * Save a peer that passed the status checklist under its `tailscale serve`
 * URL: the address becomes the ts.net origin and the launch URL carries the
 * token, so the host is reached over HTTPS on the tailnet — no SSH tunnel.
 * An existing registration with the same id is updated in place (keeping its
 * title), otherwise a new one is added.
 * @param registry - the registry port.
 * @param hostId - the id to save under.
 * @param hostTitle - display title for a new entry ('' falls back to the id).
 * @param launchUrl - `https://<host>.<tailnet>.ts.net/?token=…`.
 * @param ssh - the non-secret ssh facts, kept for later SSH actions.
 * @returns the registry's result.
 */
export function saveServeRegistration(
  registry: HostRegistryPort,
  hostId: string,
  hostTitle: string,
  launchUrl: string,
  ssh: HostSshInfo,
): RegistrationResult {
  const address = new URL(launchUrl).origin
  if (registry.list().some(entry => entry.hostId === hostId)) {
    return applyRegistrationEdit(registry, hostId, { address, launchUrl, ssh })
  }
  return registry.add({ hostId, hostTitle, address, launchUrl, ssh })
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
  /** The locale seat, threaded from the panel. */
  readonly t: PanelT
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
        >{props.t('panel.button.probe')}</button>
      </div>
      <VerdictLine state={verdict} t={props.t} />
    </div>
  )
}

/** The verdict line under one row: state word first, evidence second, advice folded away. */
function VerdictLine(props: {
  readonly state?: ProbeRunState | undefined
  readonly t: PanelT
}): ReactNode {
  const { state } = props
  if (state?.phase === 'running') {
    return <p data-probe-state="running" className={styles.stateLine}>{props.t('panel.probe.running')}</p>
  }
  if (state?.phase === 'error') {
    return <p data-probe-state="error" className={styles.stateBad}>{props.t('panel.probe.error', { message: state.message })}</p>
  }
  if (state?.phase === 'done') {
    const display = describeVerdict(state.verdict, props.t)
    return (
      <div data-probe-state={display.tone} className={styles.verdictLine} data-verdict-tone={display.tone}>
        <span data-verdict-word="" className={styles.verdictWord} data-verdict-tone={display.tone}>{display.headline}</span>
        <span data-verdict-detail="" className={styles.verdictDetail}>{display.detail}</span>
        <details className={styles.verdictMore}>
          <summary className={styles.summary}>{props.t('panel.verdict.advice')}</summary>
          <p className={styles.verdictAdvice}>{display.advice}</p>
          {state.archiveNote === undefined ? undefined : <p data-archive-note="" className={styles.verdictAdvice}>{state.archiveNote}</p>}
        </details>
      </div>
    )
  }
  return <p data-probe-state="idle" className={styles.stateLine}>{props.t('panel.probe.idle')}</p>
}

/**
 * One host row in the list. The row is a line in a table — name, status, IP,
 * settings — and the main hit area opens the host (its own page when a launch
 * URL exists, otherwise this host's settings page); the trailing settings
 * button always goes to the settings page. Every row is one fixed height so
 * the list reads as a table.
 * @param props - the merged row and the open/settings handlers.
 * @returns the row.
 */
export function HostRow(props: {
  readonly row: HostListRow
  /** Set when the row opens another host's page; absent means settings. */
  readonly href?: string | undefined
  readonly onOpen: () => void
  readonly onSettings: () => void
  /** The locale seat, threaded from the panel. */
  readonly t: PanelT
}): ReactNode {
  const { row } = props
  // 本机没有登记地址（它的地址就是这个标签页自己的 URL），IP 列以 — 占位，
  // 不硬塞内部标识充数。
  const ip = hostOf(row.address)
  // 词只从状态词查表来（connectionStatusLabel），圆点的三色才是这里的取舍：
  // 本机一色，说得通连上的（已连接/可达未同步）一色，其余一律置灰。
  const word = connectionStatusLabel(row.connection, props.t)
  const tone = row.self
    ? 'self' as const
    : row.connection === 'connected' || row.connection === 'reachable'
      ? 'online' as const
      : 'offline' as const
  const content = (
    <>
      <span className={styles.hostNameCell}>
        <span
          data-host-status={tone}
          className={styles.hostStatusDot}
          title={word}
          aria-label={word}
          role="img"
        />
        <strong data-host-name="" className={styles.hostName}>{row.name}</strong>
      </span>
      <span data-host-connection="" className={styles.hostConnection} title={word}>{word}</span>
      <span data-host-ip="" className={styles.hostIp} title={ip ?? undefined}>{ip ?? '—'}</span>
    </>
  )
  return (
    <div data-host-row={row.hostId} className={styles.hostRow}>
      <div className={styles.hostRowLine}>
        {/* 有入口的主机用链接：整页切过去（可中键/新标签打开），没有入口的
            主机与「设置」都走面板内的详情页。 */}
        {props.href === undefined
          ? (
              <button
                type="button"
                data-host-open={row.hostId}
                className={styles.hostRowButton}
                onClick={props.onOpen}
              >{content}</button>
            )
          : (
              <a
                data-host-open={row.hostId}
                className={styles.hostRowButton}
                href={props.href}
              >{content}</a>
            )}
        <button
          type="button"
          data-host-settings=""
          className={styles.rowSettings}
          onClick={props.onSettings}
        >{props.t('panel.button.settings')}</button>
      </div>
    </div>
  )
}

type SshAuthMode = 'identityFile' | 'identityPem' | 'password'

/**
 * 把一句翻译文案里的 `{…}` 段渲染回行内元素（`t` 返回的是字符串，行内样式
 * 只能在这一头补回）。带行内元素的句子（ssh 部署说明、访问方式标签）是一个
 * 键一句：命令样式（`?token=`、`http://<主机IP>:<端口>` 这类词）留在句子的
 * 字符串里，用 `{…}` 标记哪段是行内元素。这里调 `t` 一律不带参数：宿主无参
 * 时模板原样返回，记号不会被占位符替换碰坏，只在这一个出口拆开成
 * `<code>`/`<strong>`。记号优先用带非 `\w` 字符的（如 `{?token=}`、
 * `{http://…}`）最稳，纯 `\w` 记号会撞占位符替换的形状。
 * @param template - `t` 读出的整句，`{…}` 段原样保留。
 * @param tag - 段落包成的行内元素（命令用 code，强调用 strong）。
 * @returns 文本与行内元素交错的子节点列表。
 */
export function richSegments(template: string, tag: 'code' | 'strong'): ReactNode[] {
  return template.split(/\{([^{}]+)\}/g).map((part, index) =>
    index % 2 === 0 ? part : createElement(tag, { key: index }, part))
}

/** The non-secret ssh facts a deploy can hand its caller for the registry. */
export type SshSeedFacts = {
  readonly target: string
  readonly port?: number
  readonly user?: string
  readonly proxyJump?: string
  readonly authMode: SshAuthMode
  readonly identityFile?: string
  readonly hostKeyFingerprint?: string
  readonly remoteWebPort?: number
}

/**
 * A host id for a peer found through the checklist when the operator typed none:
 * the MagicDNS short name (`box` of `box.tail1234.ts.net`), else the SSH target.
 * @param magicDnsName - the peer's MagicDNS name, if known.
 * @param target - the SSH target as typed.
 * @returns a lower-case `[a-z0-9-]` id, or `''` when nothing usable is left.
 */
export function derivePeerHostId(magicDnsName: string | undefined, target: string): string {
  const source = magicDnsName?.split('.')[0] ?? target.trim().replace(/^[^@]*@/, '').split('.')[0] ?? ''
  return source.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

function SshComboField(props: {
  readonly label: ReactNode
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string | undefined
  readonly options: readonly string[]
  readonly listId: string
  readonly dataSshTarget?: boolean | undefined
  readonly dataSshIdentityFile?: boolean | undefined
  readonly dataSshIdentityOptions?: boolean | undefined
  readonly trailingAction?: ReactNode
}): ReactNode {
  return (
    <label className={styles.field}>
      {props.label}
      <div className={styles.comboRow}>
        <input
          list={props.listId}
          data-ssh-combo=""
          {...(props.dataSshTarget === true ? { 'data-ssh-target': '' } : {})}
          {...(props.dataSshIdentityFile === true ? { 'data-ssh-identity-file': '' } : {})}
          className={styles.input}
          value={props.value}
          onChange={event => { props.onChange(event.target.value) }}
          placeholder={props.placeholder}
        />
        <datalist id={props.listId} {...(props.dataSshIdentityOptions === true ? { 'data-ssh-identity-options': '' } : {})}>
          {props.options.map(option => (
            <option key={option} value={option} />
          ))}
        </datalist>
        {props.trailingAction}
      </div>
    </label>
  )
}

function applyConfigHost(entry: SshConfigHostEntry): {
  readonly target: string
  readonly user?: string
  readonly port?: string
  readonly identityFile?: string
} {
  const target = entry.hostName ?? entry.alias
  return {
    target,
    ...(entry.user === undefined ? {} : { user: entry.user }),
    ...(entry.port === undefined ? {} : { port: String(entry.port) }),
    ...(entry.identityFile === undefined ? {} : { identityFile: entry.identityFile }),
  }
}

function configHostForAlias(assets: SshLocalAssets | undefined, alias: string): SshConfigHostEntry | undefined {
  if (assets === undefined) return undefined
  const trimmed = alias.trim()
  return assets.configHosts.find(entry => entry.alias === trimmed)
}

function SshDeploySection(props: {
  readonly hostId: string
  readonly hostTitle: string
  readonly onHostIdChange: (value: string) => void
  readonly onHostTitleChange: (value: string) => void
  readonly onDeployed: (result: SshDeployResult, sshFacts: SshSeedFacts) => void
  readonly onError: (message: string) => void
  /** Pre-fill from a stored registration (detail page); absent on first add. */
  readonly initial?: SshSeedFacts | undefined
  /**
   * 选择器带进来的 SSH 目标初值（AgentPanel 的 sshTargetDraft）：挂载这一次
   * 落进 target；已存的登记凭据（initial.target）优先于它，不被草稿盖掉。
   */
  readonly initialTarget?: string | undefined
  /**
   * 详情页显式选点的一次性覆盖：只在该次重挂里当 target 初值，压过已存的
   * initial.target。没有它时优先级不变——已存凭据仍优先于草稿初值。
   */
  readonly pickedTarget?: string | undefined
  /** Detail page locks the host identity: no hostId/hostTitle inputs. */
  readonly lockHost?: boolean | undefined
  /** When provided, a connect-without-redeploy button joins the actions. */
  readonly onConnect?: ((ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }, facts: SshSeedFacts) => void) | undefined
  /**
   * 批准并读取路径的后半段：认下一把主机密钥后，把带该指纹的凭据交回
   * 详情页接着读（approve-and-read 的「读取」就发生在这次回调里）。
   */
  readonly onApproved?: ((ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }) => void) | undefined
  /** 打开区块即自动检查一次主机密钥（approve-and-read 的前半段，挂载时一次性）。 */
  readonly autoInspect?: boolean | undefined
  /**
   * When provided, the peer status checklist (tailscale serve flow) is shown
   * and its save button hands back the ts.net launch URL plus the host id to use.
   */
  readonly onServeReady?: ((launchUrl: string, facts: SshSeedFacts, hostId: string) => void) | undefined
  /** Add-host flow: primary action copy matches the wireframe. */
  readonly fromAddHost?: boolean | undefined
  /** Brief confirmation after「复制给 AI」; failure uses onError. */
  readonly onAiCopyOk?: (() => void) | undefined
  /** The locale seat, threaded from the panel. */
  readonly t: PanelT
}): ReactNode {
  const configHostsListId = useId()
  const identityFilesListId = useId()
  const [target, setTarget] = useState(props.pickedTarget ?? props.initial?.target ?? props.initialTarget ?? '')
  const [localAssets, setLocalAssets] = useState<SshLocalAssets | undefined>(undefined)
  const [port, setPort] = useState(props.initial?.port === undefined ? '22' : String(props.initial.port))
  const [user, setUser] = useState(props.initial?.user ?? '')
  const [proxyJump, setProxyJump] = useState(props.initial?.proxyJump ?? '')
  const [authMode, setAuthMode] = useState<SshAuthMode>(props.initial?.authMode ?? 'identityFile')
  const [identityFile, setIdentityFile] = useState(props.initial?.identityFile ?? '')
  const [identityPem, setIdentityPem] = useState('')
  const [password, setPassword] = useState('')
  const [remoteWebPort, setRemoteWebPort] = useState(props.initial?.remoteWebPort === undefined ? '3081' : String(props.initial.remoteWebPort))
  const [upgrade, setUpgrade] = useState(false)
  const [accessMode, setAccessMode] = useState<'host-ip' | 'tunnel'>('host-ip')
  const [bindHost, setBindHost] = useState('')
  const [keys, setKeys] = useState<readonly SshHostKeyCandidate[]>([])
  // 已存的「未批准」标记不是批准：照原样种进来，读取/只连接/部署三个按钮
  // 都靠「指纹非空」放行，操作者没认过指纹就撞上主机端口的生英文错误。
  // 未批准按没批准处理，入口只有检查主机密钥那套审批交互。
  const [approvedFingerprint, setApprovedFingerprint] = useState(
    props.initial?.hostKeyFingerprint === 'unapproved' ? '' : props.initial?.hostKeyFingerprint ?? '',
  )
  const [busy, setBusy] = useState<'inspect' | 'peer' | 'deploy' | undefined>(undefined)
  // 部署过程逐行留痕：不是只显示最后一行，每一阶段的原话都留在面上。
  const [progressLog, setProgressLog] = useState<readonly SshDeployProgress[]>([])
  const [opError, setOpError] = useState<string | undefined>(undefined)
  const [deployOperationId, setDeployOperationId] = useState<string | undefined>(undefined)
  const [peer, setPeer] = useState<PeerStatus | undefined>(undefined)
  const [deployed, setDeployed] = useState<SshDeployResult | undefined>(undefined)
  const [remoteAgents, setRemoteAgents] = useState<RemoteAgentDeploySelection>(() => (
    Object.fromEntries(REMOTE_DEPLOY_AGENT_SPECS.map(spec => [spec.key, true])) as RemoteAgentDeploySelection
  ))

  const [checkReport, setCheckReport] = useState<PeerCheckReport | undefined>(undefined)
  const [checkBusy, setCheckBusy] = useState<'check' | PeerCheckAction | undefined>(undefined)
  const [serveFailure, setServeFailure] = useState<ServeFailure | undefined>(undefined)

  useEffect(() => {
    void loadSshLocalAssets(props.t).then(result => {
      if (!result.ok) {
        setLocalAssets({ configHosts: [], identityFiles: [] })
        return
      }
      setLocalAssets(result.value)
    })
  }, [props.t])

  useEffect(() => {
    let cancelled = false
    void listSshIdentityFiles(props.t).then(paths => {
      if (!cancelled) setIdentityOptions(paths)
    })
    return () => { cancelled = true }
  }, [props.t])

  const configHostAliases = localAssets?.configHosts?.map(entry => entry.alias) ?? []
  // 私钥路径的建议列表：读一次本机 ~/.ssh（host-ssh.keys）。读不到就是空清单——
  // 输入框照样能接受手填的绝对路径，不在部署框里添一条无关的报错。
  const [identityOptions, setIdentityOptions] = useState<readonly string[]>([])

  const pickConfigHost = (value: string): void => {
    setTarget(value)
    const entry = configHostForAlias(localAssets, value)
    if (entry === undefined) return
    const applied = applyConfigHost(entry)
    setTarget(applied.target)
    if (applied.user !== undefined) setUser(applied.user)
    if (applied.port !== undefined) setPort(applied.port)
    if (applied.identityFile !== undefined) setIdentityFile(applied.identityFile)
  }

  const requireUser = (): boolean => {
    if (user.trim() !== '') return true
    props.onError(props.t('panel.ssh.userRequired'))
    return false
  }

  const browseIdentityFile = (): void => {
    void pickSshIdentityFile(props.t).then(result => {
      if (!result.ok) {
        props.onError(result.error)
        return
      }
      if (result.value.cancelled || result.value.path === undefined) return
      setIdentityFile(result.value.path)
      setAuthMode('identityFile')
    })
  }

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

  /** 批准一把钥匙：既记下指纹，也在 approve-and-read 路径里接着往下走。 */
  const approve = (fingerprint: string): void => {
    setApprovedFingerprint(fingerprint)
    if (fingerprint !== '' && fingerprint !== 'unapproved') {
      props.onApproved?.({ ...sshPayload(), hostKeyFingerprint: fingerprint })
    }
  }

  const runInspect = (): void => {
    if (!requireUser()) return
    setBusy('inspect')
    setKeys([])
    setApprovedFingerprint('')
    void inspectSshHost(sshPayload(), props.t).then(result => {
      setBusy(undefined)
      if (!result.ok) {
        props.onError(result.error)
        return
      }
      setKeys(result.value.keys)
      const only = result.value.keys[0]
      if (result.value.keys.length === 1 && only !== undefined) {
        // 只有一把主机密钥时自动走下一步：approve-and-read 优先——认指纹
        // 交回详情页接着读；没有该流程时才是 serve 流程的逐项检测。
        if (props.onApproved !== undefined) approve(only.hostKeyFingerprint)
        else if (props.onServeReady !== undefined) runCheck(only.hostKeyFingerprint)
      }
    })
  }

  // approve-and-read 路径：区块一打开就自动检查一次主机密钥，操作者只需要
  // 认指纹（唯一钥匙时自动批准并接着读取）。只在挂载这一刻跑一次。
  useEffect(() => {
    if (props.autoInspect === true) runInspect()
    // 只在挂载这一刻自动检查；表单草稿的变化不该反复发起检查。
  }, [])

  const runReadPeer = (): void => {
    if (!requireUser()) return
    if (approvedFingerprint === '') {
      props.onError(props.t('panel.ssh.approveFingerprintFirst'))
      return
    }
    setBusy('peer')
    void readRemotePeer({ ...sshPayload(), hostKeyFingerprint: approvedFingerprint }, props.t).then(result => {
      setBusy(undefined)
      if (!result.ok) {
        props.onError(result.error)
        return
      }
      setPeer(result.value)
    })
  }

  const remotePortValue = (): number | undefined => remoteWebPort.trim() === '' ? undefined : Number(remoteWebPort)

  /** 检测清单要用的主机名：填了就用填的，否则取 MagicDNS 短名或 SSH 目标。 */
  const effectiveHostId = (): string => {
    const typed = props.hostId.trim()
    if (typed !== '') return typed
    return derivePeerHostId(checkReport?.facts.magicDnsName, target)
  }

  const runCheck = (fingerprint: string = approvedFingerprint): void => {
    if (!requireUser()) return
    if (fingerprint === '') {
      props.onError(props.t('panel.ssh.approveFingerprintFirst'))
      return
    }
    setCheckBusy('check')
    void checkRemotePeer({ ...sshPayload(), hostKeyFingerprint: fingerprint }, remotePortValue(), props.t).then(result => {
      setCheckBusy(undefined)
      if (!result.ok) {
        props.onError(result.error)
        return
      }
      setCheckReport(result.value)
    })
  }

  const runCheckAction = (action: PeerCheckAction): void => {
    if (action === 'retry') {
      runCheck()
      return
    }
    if (action === 'deploy') {
      runDeploy({ upgrade: true, fromCheck: true })
      return
    }
    const ssh = { ...sshPayload(), hostKeyFingerprint: approvedFingerprint }
    setCheckBusy(action)
    if (action === 'start' || action === 'restart') {
      // 轻量：systemctl start/restart 已部署的服务，并从日志回读令牌写回 peer.json。
      void controlRemoteService(ssh, action, remotePortValue(), props.t).then(result => {
        setCheckBusy(undefined)
        if (!result.ok) {
          props.onError(result.error)
          return
        }
        setCheckReport(result.value.report)
      })
      return
    }
    setServeFailure(undefined)
    void configureRemoteServe(ssh, remotePortValue(), props.t).then(result => {
      setCheckBusy(undefined)
      if (!result.ok) {
        props.onError(result.error)
        return
      }
      setCheckReport(result.value.report)
      setServeFailure(result.value.failure)
    })
  }

  const runDeploy = (options: { readonly upgrade?: boolean; readonly fromCheck?: boolean } = {}): void => {
    if (!requireUser()) return
    if (approvedFingerprint === '') {
      props.onError(props.t('panel.ssh.approveFingerprintFirst'))
      return
    }
    const fromCheck = options.fromCheck === true
    const hostId = fromCheck ? effectiveHostId() : props.hostId.trim()
    if (hostId === '') {
      props.onError(props.t('panel.ssh.hostIdRequired'))
      return
    }
    setBusy('deploy')
    if (fromCheck) setCheckBusy('deploy')
    setProgressLog([])
    setOpError(undefined)
    setDeployOperationId(undefined)
    const finishCheck = (): void => {
      if (!fromCheck) return
      setCheckBusy(undefined)
      runCheck()
    }
    void startSshDeploy({
      hostId,
      hostTitle: props.hostTitle.trim() === '' ? hostId : props.hostTitle.trim(),
      ssh: { ...sshPayload(), hostKeyFingerprint: approvedFingerprint },
      ...(remoteWebPort.trim() === '' ? {} : { remoteWebPort: Number(remoteWebPort) }),
      upgrade: options.upgrade ?? upgrade,
      // 检测清单仍走 ts.net。面板默认按可达 IP 直连，不建隧道、不要求 Tailscale。
      accessMode: fromCheck ? 'serve' : accessMode,
      ...(!fromCheck && accessMode === 'host-ip' && bindHost.trim() !== '' ? { bindHost: bindHost.trim() } : {}),
      remoteAgents,
    }, props.t).then(started => {
      if (!started.ok) {
        setBusy(undefined)
        if (fromCheck) setCheckBusy(undefined)
        setOpError(started.error)
        props.onError(started.error)
        return
      }
      setDeployOperationId(started.value.operationId)
      void waitSshDeployOperation(started.value.operationId, view => {
        // 逐行留痕：同一阶段的重复心跳只留一条，阶段一换就另起一行。
        setProgressLog(log => {
          const last = log[log.length - 1]
          return last !== undefined && last.phase === view.progress.phase && last.detail === view.progress.detail
            ? log
            : [...log, view.progress]
        })
      }, undefined, props.t).then(done => {
        setBusy(undefined)
        finishCheck()
        if (!done.ok) {
          setOpError(done.error)
          props.onError(done.error)
          return
        }
        if (done.value.status !== 'succeeded' || done.value.result === undefined) {
          setOpError(done.value.error ?? props.t('panel.ssh.deployFailed'))
          return
        }
        setOpError(undefined)
        // 检测清单里触发的部署只是修复一步：登记等清单全部通过后用 ts.net 地址做。
        if (fromCheck) return
        setDeployed(done.value.result)
        props.onDeployed(done.value.result, seedFacts())
      })
    })
  }

  /** What a successful deploy should remember in the registry: no secrets. */
  const seedFacts = (): SshSeedFacts => ({
    target: target.trim(),
    ...(port.trim() === '' ? {} : { port: Number(port) }),
    ...(user.trim() === '' ? {} : { user: user.trim() }),
    ...(proxyJump.trim() === '' ? {} : { proxyJump: proxyJump.trim() }),
    authMode,
    ...(authMode === 'identityFile' && identityFile.trim() !== '' ? { identityFile: identityFile.trim() } : {}),
    hostKeyFingerprint: approvedFingerprint,
    ...(remoteWebPort.trim() === '' ? {} : { remoteWebPort: Number(remoteWebPort) }),
  })

  const copyLaunchUrl = (): void => {
    if (deployed === undefined) return
    void navigator.clipboard.writeText(deployed.launchUrl)
  }

  const lastDeployProgress = progressLog[progressLog.length - 1]
  const deployCopyPrompt = opError === undefined
    ? undefined
    : buildOpsAiPrompt({
      scenario: 'ssh-deploy',
      rawError: opError,
      ...(lastDeployProgress === undefined
        ? {}
        : { failedStep: lastDeployProgress.phase, failedStepDetail: lastDeployProgress.detail }),
      suggestedAction: props.t('panel.copyForAi.hint.deployRetry'),
      ...(deployOperationId === undefined ? {} : { operationId: deployOperationId }),
      host: {
        hostId: effectiveHostId(),
        target: target.trim(),
        ...(user.trim() === '' ? {} : { user: user.trim() }),
        ...(port.trim() === '' ? {} : { port: Number(port) }),
        ...(proxyJump.trim() === '' ? {} : { proxyJump: proxyJump.trim() }),
        authMode,
        ...(authMode === 'identityFile' && identityFile.trim() !== '' ? { identityFile: identityFile.trim() } : {}),
        ...(approvedFingerprint !== '' ? { hostKeyFingerprint: approvedFingerprint } : {}),
        ...(remoteWebPort.trim() === '' ? {} : { remoteWebPort: Number(remoteWebPort) }),
      },
    })

  const aiHostContextForCheck = (): OpsAiHostContext => ({
    hostId: effectiveHostId(),
    target: target.trim(),
    ...(user.trim() === '' ? {} : { user: user.trim() }),
    ...(port.trim() === '' ? {} : { port: Number(port) }),
    ...(proxyJump.trim() === '' ? {} : { proxyJump: proxyJump.trim() }),
    authMode,
    ...(authMode === 'identityFile' && identityFile.trim() !== '' ? { identityFile: identityFile.trim() } : {}),
    ...(approvedFingerprint !== '' ? { hostKeyFingerprint: approvedFingerprint } : {}),
    ...(remoteWebPort.trim() === '' ? {} : { remoteWebPort: Number(remoteWebPort) }),
  })

  const reportCopyFailure = (): void => {
    props.onError(props.t('panel.copyForAi.failed'))
  }

  return (
    <div data-ssh-deploy="" className={styles.sshSection}>
      <p className={styles.note}>
        {richSegments(props.t('panel.ssh.intro'), 'strong')}
      </p>
      <div className={styles.formGrid}>
        <SshComboField
          label={props.t('panel.ssh.targetLabel')}
          listId={configHostsListId}
          value={target}
          onChange={pickConfigHost}
          placeholder={props.t('panel.ssh.targetComboPlaceholder')}
          options={configHostAliases}
          dataSshTarget={true}
        />
        <label className={styles.field}>
          {props.t('panel.ssh.portLabel')}
          <input className={styles.input} value={port} onChange={event => { setPort(event.target.value) }} />
        </label>
        <label className={styles.field}>
          {props.t('panel.ssh.userRequiredLabel')}
          <input
            data-ssh-user=""
            className={styles.input}
            value={user}
            onChange={event => { setUser(event.target.value) }}
            placeholder={props.t('panel.ssh.userRequiredPlaceholder')}
            required={true}
          />
          <span className={styles.note}>{props.t('panel.ssh.userRequiredHint')}</span>
        </label>
        <label className={styles.field}>
          {props.t('panel.ssh.proxyJumpLabel')}
          <input className={styles.input} value={proxyJump} onChange={event => { setProxyJump(event.target.value) }} />
        </label>
        {authMode === 'identityFile'
          ? (
              <SshComboField
                label={props.t('panel.ssh.identityFileLabel')}
                listId={identityFilesListId}
                value={identityFile}
                onChange={setIdentityFile}
                placeholder={props.t('panel.ssh.identityFileComboPlaceholder')}
                options={identityOptions}
                dataSshIdentityFile={true}
                dataSshIdentityOptions={true}
                trailingAction={(
                  <button type="button" className={styles.action} data-action="ssh-browse-identity" onClick={browseIdentityFile}>
                    {props.t('panel.ssh.browseIdentityFile')}
                  </button>
                )}
              />
            )
          : undefined}
        <div className={styles.field}>
          <span className={styles.summary}>{props.t('panel.ssh.authModeLabel')}</span>
          <div className={styles.segmented} data-ssh-auth-mode="">
            <button
              type="button"
              className={authMode === 'identityFile' ? styles.segmentedActive : styles.segmentedItem}
              data-ssh-auth="identityFile"
              onClick={() => { setAuthMode('identityFile') }}
            >{props.t('panel.ssh.authIdentityShort')}</button>
            <button
              type="button"
              className={authMode === 'identityPem' ? styles.segmentedActive : styles.segmentedItem}
              data-ssh-auth="identityPem"
              onClick={() => { setAuthMode('identityPem') }}
            >{props.t('panel.ssh.authIdentityPemShort')}</button>
            <button
              type="button"
              className={authMode === 'password' ? styles.segmentedActive : styles.segmentedItem}
              data-ssh-auth="password"
              onClick={() => { setAuthMode('password') }}
            >{props.t('panel.ssh.authPasswordShort')}</button>
          </div>
        </div>
        {authMode === 'identityPem'
          ? (
              <label className={styles.field}>
                {props.t('panel.ssh.identityPemLabel')}
                <textarea className={styles.textarea} value={identityPem} onChange={event => { setIdentityPem(event.target.value) }} rows={4} />
              </label>
            )
          : authMode === 'password'
            ? (
                <label className={styles.field}>
                  {props.t('panel.ssh.passwordLabel')}
                  <input type="password" className={styles.input} value={password} onChange={event => { setPassword(event.target.value) }} autoComplete="off" />
                </label>
              )
            : undefined}
        <label className={styles.field}>
          {props.t('panel.ssh.remotePortLabel')}
          <input className={styles.input} value={remoteWebPort} onChange={event => { setRemoteWebPort(event.target.value) }} />
        </label>
      </div>
      <fieldset className={styles.accessModes} data-ssh-access-mode="">
        <legend className={styles.summary}>{props.t('panel.ssh.accessMode')}</legend>
        <label className={styles.sshKeyRow}>
          <input
            type="radio"
            name="ssh-access-mode"
            data-ssh-access="host-ip"
            checked={accessMode === 'host-ip'}
            onChange={() => { setAccessMode('host-ip') }}
          />
          <span>{richSegments(props.t('panel.ssh.accessHostIp'), 'code')}</span>
        </label>
        <label className={styles.sshKeyRow}>
          <input
            type="radio"
            name="ssh-access-mode"
            data-ssh-access="tunnel"
            checked={accessMode === 'tunnel'}
            onChange={() => { setAccessMode('tunnel') }}
          />
          <span>{props.t('panel.ssh.accessTunnel')}</span>
        </label>
        {accessMode === 'host-ip'
          ? (
              <label className={styles.field}>
                {props.t('panel.ssh.bindHostLabel')}
                <input
                  data-ssh-bind-host=""
                  className={styles.input}
                  value={bindHost}
                  onChange={event => { setBindHost(event.target.value) }}
                  placeholder={props.t('panel.ssh.bindHostPlaceholder')}
                />
              </label>
            )
          : undefined}
      </fieldset>
      <label className={styles.sshKeyRow}>
        <input
          type="checkbox"
          data-ssh-upgrade=""
          checked={upgrade}
          onChange={event => { setUpgrade(event.target.checked) }}
        />
        <span>{props.t('panel.ssh.upgrade')}</span>
      </label>
      <fieldset className={styles.accessModes} data-ssh-remote-agents="">
        <legend className={styles.summary}>{props.t('panel.ssh.remoteAgentsLegend')}</legend>
        <p className={styles.note}>
          {props.t('panel.ssh.remoteAgentsNote')}
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
        <button type="button" className={styles.action} data-action="ssh-inspect" disabled={busy !== undefined} onClick={runInspect}>
          {busy === 'inspect' ? props.t('panel.ssh.inspecting') : props.t('panel.ssh.inspect')}
        </button>
        <button type="button" className={styles.action} data-action="ssh-peer" disabled={busy !== undefined} onClick={runReadPeer}>
          {busy === 'peer' ? props.t('panel.ssh.readingPeer') : props.t('panel.ssh.readPeer')}
        </button>
        {props.onConnect !== undefined
          ? (
              <button
                type="button"
                className={styles.action}
                data-action="ssh-connect"
                disabled={busy !== undefined || approvedFingerprint === ''}
                onClick={() => { props.onConnect?.({ ...sshPayload(), hostKeyFingerprint: approvedFingerprint }, seedFacts()) }}
              >{props.t('panel.ssh.connectOnly')}</button>
            )
          : undefined}
        <button type="button" className={styles.actionPrimary} data-action="ssh-deploy" disabled={busy !== undefined} onClick={() => { runDeploy() }}>
          {busy === 'deploy'
            ? props.t('panel.ssh.deploying')
            : props.fromAddHost === true
              ? props.t('panel.ssh.startDeploy')
              : props.t('panel.ssh.deploy')}
        </button>
      </div>
      {keys.length > 0
        ? (
            <div data-ssh-keys="" className={styles.sshKeys}>
              <p className={styles.stateLine}>{props.t('panel.ssh.pickKeyPrompt')}</p>
              {keys.map(key => (
                <label key={key.hostKeyFingerprint} data-ssh-key-row="" className={styles.sshKeyRow}>
                  <input
                    type="radio"
                    name="ssh-host-key"
                    checked={approvedFingerprint === key.hostKeyFingerprint}
                    onChange={() => { approve(key.hostKeyFingerprint) }}
                  />
                  <span>{key.algorithm} · {key.hostKeyFingerprint}</span>
                </label>
              ))}
            </div>
          )
        : undefined}
      {props.onServeReady !== undefined && approvedFingerprint !== ''
        ? (
            <PeerCheckList
              report={checkReport}
              busy={checkBusy}
              serveFailure={serveFailure}
              disabled={busy !== undefined && checkBusy === undefined}
              onCheck={() => { runCheck() }}
              onAction={runCheckAction}
              onSave={launchUrl => { props.onServeReady?.(launchUrl, seedFacts(), effectiveHostId()) }}
              aiHostContext={aiHostContextForCheck()}
              onCopied={props.onAiCopyOk}
              onCopyFailed={reportCopyFailure}
              t={props.t}
            />
          )
        : undefined}
      {peer !== undefined
        ? (
            <p data-ssh-peer="" className={styles.stateLine}>
              {peer.pluginsInstalled
                ? peer.listen === 'loopback'
                  ? `${props.t('panel.ssh.peerLoopback')}${peer.launchUrl ?? ''}`
                  : props.t('panel.ssh.peerNotLoopback')
                : props.t('panel.ssh.peerMissing')}
            </p>
          )
        : undefined}
      {progressLog.length > 0
        ? (
            <div data-ssh-progress-log="" className={styles.sshKeys}>
              <p className={styles.summary}>{props.t('panel.ssh.progressLogTitle')}</p>
              {progressLog.map((line, index) => (
                <p key={index} className={styles.stateLine} data-ssh-progress-line={line.phase}>{line.detail}</p>
              ))}
            </div>
          )
        : undefined}
      {opError !== undefined
        ? (
            <div data-ssh-error="" className={styles.launchUrlBox}>
              <p className={styles.stateBad}>{props.t('panel.ssh.failedTitle')}</p>
              <code className={styles.launchUrlText}>{opError}</code>
              <div className={styles.formActions}>
                {deployCopyPrompt !== undefined
                  ? (
                      <CopyForAiButton
                        prompt={deployCopyPrompt}
                        t={props.t}
                        dataAction="ssh-copy-for-ai"
                        onCopied={props.onAiCopyOk}
                        onCopyFailed={reportCopyFailure}
                      />
                    )
                  : undefined}
                <button type="button" className={styles.action} data-action="ssh-deploy-retry" disabled={busy !== undefined} onClick={() => { runDeploy() }}>{props.t('panel.ssh.retry')}</button>
              </div>
            </div>
          )
        : undefined}
      {deployed !== undefined
        ? (
            <div data-ssh-launch-url="" className={styles.launchUrlBox}>
              <p className={styles.stateLine}>{props.t('panel.ssh.launchUrlPrompt')}</p>
              <code className={styles.launchUrlText}>{deployed.launchUrl}</code>
              <div className={styles.formActions}>
                <button type="button" className={styles.action} data-action="copy-launch-url" onClick={copyLaunchUrl}>{props.t('panel.button.copyLink')}</button>
                <a className={styles.actionPrimary} data-action="open-launch-url" href={gatewayPagePath(effectiveHostId())} target="_blank" rel="noreferrer">{props.t('panel.ssh.open')}</a>
              </div>
            </div>
          )
        : undefined}
      {props.lockHost === true
        ? undefined
        : (
            <>
              <label className={styles.field}>
                {props.t('panel.ssh.hostIdLabel')}
                <input data-ssh-hostid="" className={styles.input} value={props.hostId} onChange={event => { props.onHostIdChange(event.target.value) }} />
              </label>
              <label className={styles.field}>
                {props.t('panel.form.fieldTitle')}
                <input className={styles.input} value={props.hostTitle} onChange={event => { props.onHostTitleChange(event.target.value) }} />
              </label>
            </>
          )}
    </div>
  )
}

/**
 * 「使用这台主机」：把登记里的连接方式变成一跳可达的操作。状态如实：
 * 隧道在线/未连通/未检查三种说法各配各的按钮；连接失败给原文和重试。
 * 密码/粘贴私钥无法免输入重连，如实说明并指到部署区块。
 */
function HostUseSection(props: {
  readonly hostId: string
  readonly sshInfo: HostSshInfo | undefined
  readonly launchUrl: string | undefined
  readonly tunnel: 'unknown' | 'checking' | 'online' | 'offline'
  readonly connecting: boolean
  readonly error: string | undefined
  readonly onConnect: () => void
  readonly onOpenDeploy: () => void
  readonly onAiCopyOk?: (() => void) | undefined
  readonly onCopyFailed?: (() => void) | undefined
  readonly t: PanelT
}): ReactNode {
  const { sshInfo, launchUrl } = props
  const connectCopyPrompt = props.error === undefined
    ? undefined
    : buildOpsAiPrompt({
      scenario: 'ssh-connect',
      rawError: props.error,
      suggestedAction: props.t('panel.copyForAi.hint.connectRetry'),
      host: hostContextFromSshInfo(props.hostId, sshInfo),
    })
  // 连接一族要已批准的指纹：未批准时不给连接按钮（裁定 5，与按钮表同一道
  // 闸），说明行也不拿「没存凭据」搪塞——真实原因是密钥还没认。
  const keyUnapproved = sshInfo?.hostKeyFingerprint === 'unapproved'
  const canAutoConnect = sshInfo !== undefined && sshInfo.authMode === 'identityFile'
    && sshInfo.hostKeyFingerprint !== undefined && !keyUnapproved
  const tunnelWord = props.t(`panel.use.tunnel.${props.tunnel}`)
  return (
    <section data-use-section="" className={styles.sshSection}>
      <h3 className={styles.summary}>{props.t('panel.use.title')}</h3>
      {sshInfo === undefined
        ? (
            <>
              <p className={styles.stateLine}>{props.t('panel.use.noSsh')}</p>
              <div className={styles.formActions}>
                <button type="button" className={styles.actionPrimary} data-action="open-deploy" onClick={props.onOpenDeploy}>{props.t('panel.use.fillSsh')}</button>
              </div>
            </>
          )
        : (
            <>
              <p data-use-tunnel={props.tunnel} className={styles.stateLine}>{tunnelWord}</p>
              <div className={styles.formActions}>
                {launchUrl !== undefined
                  ? <a className={styles.action} data-action="open-page" href={gatewayPagePath(props.hostId)} target="_blank" rel="noreferrer">{props.t('panel.use.open')}</a>
                  : undefined}
                {/* 「检查隧道」并进了详情页按钮表的 check-reach（都问登记里
                    那个地址）；这里只留状态行与打开/连接两个动作。 */}
                {canAutoConnect
                  ? (
                      <button type="button" className={styles.actionPrimary} data-action="connect-open" disabled={props.connecting} onClick={props.onConnect}>
                        {props.connecting ? props.t('panel.use.connecting') : props.t(props.tunnel === 'online' ? 'panel.use.reconnect' : 'panel.use.connect')}
                      </button>
                    )
                  : <p className={styles.stateLine}>{props.t(keyUnapproved ? 'panel.button.keyNotApproved' : 'panel.use.secretHint')}</p>}
              </div>
            </>
          )}
      {props.error !== undefined
        ? (
            <div data-use-error="" className={styles.launchUrlBox}>
              <p className={styles.stateBad}>{props.t('panel.use.failedTitle')}</p>
              <code className={styles.launchUrlText}>{props.error}</code>
              <div className={styles.formActions}>
                {connectCopyPrompt !== undefined
                  ? (
                      <CopyForAiButton
                        prompt={connectCopyPrompt}
                        t={props.t}
                        dataAction="connect-copy-for-ai"
                        onCopied={props.onAiCopyOk}
                        onCopyFailed={props.onCopyFailed}
                      />
                    )
                  : undefined}
                {canAutoConnect
                  ? (
                      <button type="button" className={styles.action} data-action="connect-retry" disabled={props.connecting} onClick={props.onConnect}>{props.t('panel.use.retry')}</button>
                    )
                  : undefined}
              </div>
            </div>
          )
        : undefined}
    </section>
  )
}

/** First step when adding a host: pick URL registration, SSH deploy, or Tailscale. */
function AddHostChooser(props: {
  readonly tailscale?: TailscalePort | undefined
  readonly onChooseManual: () => void
  readonly onChooseSsh: () => void
  readonly onPickedPeer: (peer: TailscalePeer) => void
  readonly onCancel: () => void
  readonly postureNote?: ReactNode
  readonly t: PanelT
}): ReactNode {
  const [picker, setPicker] = useState<{ open: boolean; result?: TailscalePeersResult | undefined }>({ open: false })
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
    props.onPickedPeer(peer)
    setPicker({ open: false })
  }
  return (
    <div data-panel-page="add-chooser" className={styles.formPage}>
      <div className={styles.formNav}>
        <button type="button" className={styles.action} onClick={props.onCancel}>{props.t('panel.button.back')}</button>
      </div>
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>{props.t('panel.title.addHost')}</h2>
          <span className={styles.managementTag}>{props.t('panel.add.methodPrompt')}</span>
        </div>
        {props.postureNote}
        <div className={styles.addMethodList}>
          <button type="button" data-action="add-method-manual" className={styles.addMethodCard} onClick={props.onChooseManual}>
            <span className={styles.addMethodTitle}>{props.t('panel.add.methodUrl')}</span>
            <span className={styles.note}>{props.t('panel.add.methodUrlHint')}</span>
          </button>
          <button type="button" data-action="add-method-ssh" className={styles.addMethodCard} onClick={props.onChooseSsh}>
            <span className={styles.addMethodTitle}>{props.t('panel.add.methodSsh')}</span>
            <span className={styles.note}>{props.t('panel.add.methodSshHint')}</span>
          </button>
          {props.tailscale === undefined
            ? (
                <p className={styles.note}>{props.t('panel.add.methodTailscaleUnavailable')}</p>
              )
            : !picker.open
              ? (
                  <button type="button" data-action="add-method-tailscale" className={styles.addMethodCard} onClick={() => { void openPicker() }}>
                    <span className={styles.addMethodTitle}>{props.t('panel.add.methodTailscale')}</span>
                    <span className={styles.note}>{props.t('panel.add.methodTailscaleHint')}</span>
                  </button>
                )
              : (
                  <div data-tailscale-picker="" className={styles.tailscalePicker}>
                    <div className={styles.tailscalePickerBar}>
                      <span className={styles.tailscalePickerTitle}>{props.t('panel.tailscale.pickTitle')}</span>
                      <span className={styles.spacer} />
                      <button type="button" data-action="tailscale-refresh" className={styles.action} onClick={() => { void refreshPicker() }}>{props.t('panel.button.refresh')}</button>
                      <button type="button" data-action="tailscale-close" className={styles.action} onClick={() => { setPicker({ open: false }) }}>{props.t('panel.tailscale.collapse')}</button>
                    </div>
                    {picker.result === undefined
                      ? <p data-tailscale-state="loading" className={styles.stateLine}>{props.t('panel.tailscale.loading')}</p>
                      : picker.result.ok === false
                        ? <p data-tailscale-state="failed" className={styles.stateBad}>{picker.result.message}</p>
                        : (
                            <>
                              {picker.result.note !== undefined
                                ? <p data-tailscale-note="" className={styles.note}>{picker.result.note}</p>
                                : undefined}
                              {picker.result.peers.length === 0
                                ? <p data-tailscale-state="empty" className={styles.stateLine}>{props.t('panel.tailscale.empty')}</p>
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
                                            <span className={styles.tailscalePeerMeta}>{props.t('panel.tailscale.peerMeta', { ip: peer.ip, status: peer.online ? props.t('panel.status.online') : props.t('panel.status.offline') })}</span>
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
      </section>
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
  /** 卡片右上角的操作区：渲染在标题与管理标签之后、表单之前（如删除登记）。 */
  readonly headActions?: ReactNode
  /** The storage posture line; the page renders it under the form. */
  readonly postureNote?: ReactNode
  readonly onConfirm: (values: HostFormValues) => boolean
  /**
   * Add page: called after a successful confirm so the panel can open the new
   * host's settings (deploy lives there). Absent → fall back to onCancel.
   */
  readonly onSaved?: (values: HostFormValues) => void
  readonly onCancel: () => void
  /** 从 Tailscale 选的口（表单前面的入口）；缺省就不显示那个按钮。 */
  readonly tailscale?: TailscalePort | undefined
  /** 添加页若已用连接方式选择器，则不再在表单前重复 Tailscale 入口。 */
  readonly showTailscalePicker?: boolean | undefined
  /** 面板持有的 SSH 目标草稿：添加页的目标输入框显示它，选择器往里写。 */
  readonly sshTargetDraft?: string | undefined
  readonly onSshTargetChange?: (value: string) => void
  /** 选中一台对端：面板把 IP 落进 sshTargetDraft（添加页顺带切到 SSH 部署区）。 */
  readonly onPickedPeer?: (peer: TailscalePeer) => void
  /** The locale seat, threaded from the panel. */
  readonly t: PanelT
}): ReactNode {
  const [idDraft, setIdDraft] = useState(props.values.hostId)
  // IP 字段里放的是去协议的主机（可带端口）；入库前补协议，出库时剥掉。
  const [ipDraft, setIpDraft] = useState(hostPartOfAddress(props.values.address))
  const [localError, setLocalError] = useState<string | undefined>(undefined)
  const { reported } = props
  const fields = props.mode === 'new' ? ALL_FIELDS : props.fields ?? ALL_FIELDS
  // 详情页默认只读（2026-10-21 用户要求）：靠「编辑」按钮进可改界面，保存/取消再退回只读。
  // 添加页一进来就可改。editable 决定字段是输入框还是只读文本。
  const [editing, setEditing] = useState(props.mode === 'new')
  const editable = props.mode === 'new' || editing
  const canEdit = fields.id || fields.address
  const resetDrafts = (): void => {
    setIdDraft(props.values.hostId)
    setIpDraft(hostPartOfAddress(props.values.address))
    setLocalError(undefined)
  }
  const confirm = (): void => {
    // 名称留空就由 IP 推出一个主机标识（2026-10-21 用户要求：填好 IP 就能保存）。
    const parsed = registrationAddress(ipDraft)
    if (fields.address && parsed.address === '') {
      setLocalError(props.t('panel.form.addressRequired'))
      return
    }
    setLocalError(undefined)
    const values: HostFormValues = {
      hostId: idDraft.trim() !== '' ? idDraft.trim() : deriveHostIdFromAddress(ipDraft),
      address: parsed.address,
      ...(parsed.launchUrl === undefined ? {} : { launchUrl: parsed.launchUrl }),
    }
    // onConfirm 回 true＝保存成功：添加页由 onSaved 带去设置页；否则回列表。
    if (!props.onConfirm(values)) return
    if (props.mode === 'new') {
      if (props.onSaved !== undefined) props.onSaved(values)
      else props.onCancel()
      return
    }
    props.onCancel()
  }
  // 自报标识与填写的名称当场比对（跟着输入走），不一致就明说，两边都保留。
  const idMatch = reported?.reportedId === undefined ? undefined : reported.reportedId === idDraft.trim()
  const addressHidden = props.mode === 'view' && !fields.address && props.values.address === ''
  const message = localError !== undefined
    ? { tone: 'bad' as const, text: localError }
    : props.message

  // 从 Tailscale 选（表单前面的入口）：点开→读清单→列出；选一台→名称填上、
  // IP 交给 SSH 目标＋收起（地址栏不动）；刷新让主机侧重跑一次；收起只关不填。
  const [picker, setPicker] = useState<{ open: boolean; result?: TailscalePeersResult | undefined }>({ open: false })
  const canPickAddress = props.showTailscalePicker !== false && props.tailscale !== undefined && fields.address
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
    // 选中只填两处：名称栏填 peer 名，IP 交给面板的 SSH 目标草稿
    // （onPickedPeer）；地址栏不动。Tailscale 在这里只是一条 SSH 路径，
    // 用来部署插件；打开地址由部署绑到可达 IP 后写回，或由操作者粘贴。
    setIdDraft(peer.name)
    props.onPickedPeer?.(peer)
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
        >{props.t('panel.button.back')}</button>
      </div>
      <section data-form-card="" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>{props.heading}</h2>
          {/* 点开每一台主机都进这里：标题点明这是「主机管理」设置界面，
              下面的主机信息（自报标识、状态、登记字段）是其中一个栏目。 */}
          <span data-host-management-heading="" className={styles.managementTag}>{props.t('panel.title.management')}</span>
          <span className={styles.spacer} />
          {props.mode === 'view' && canEdit && !editing
            ? (
                <button
                  type="button"
                  data-action="edit-host"
                  className={styles.action}
                  onClick={() => { resetDrafts(); setEditing(true) }}
                >{props.t('panel.button.edit')}</button>
              )
            : undefined}
          {props.headActions}
        </div>
        {reported === undefined
          ? undefined
          : (
              <div data-reported-facts="" className={styles.reportedFacts}>
                {reported.self
                  ? <p className={styles.stateLine}>{props.t('panel.facts.selfLine')}</p>
                  : undefined}
                <p data-fact-online="" className={styles.stateLine}>
                  {props.t('panel.facts.status', { status: reported.online ? props.t('panel.status.online') : props.t('panel.status.offline') })}
                  {reported.online && reported.lastSeen !== undefined
                    ? <span data-fact-heartbeat="">{props.t('panel.facts.heartbeat', { age: heartbeatWord(reported.lastSeen, undefined, props.t) })}</span>
                    : undefined}
                </p>
                {!reported.online && !reported.self
                  ? (
                      <p data-fact-offline-note="" className={styles.stateLine}>
                        {props.t('panel.facts.offlineNote')}
                        {reported.onlineIds.length > 0
                          ? <>{props.t('panel.facts.offlineIdsPrefix')}<span data-fact-online-ids="">{reported.onlineIds.join(props.t('panel.facts.onlineIdsSeparator'))}</span></>
                          : null}
                        {props.t('panel.facts.offlineEnd')}
                      </p>
                    )
                  : undefined}
                {reported.reportedId !== undefined
                  ? (
                      <p data-fact-reported-id="" className={styles.stateLine}>
                        {props.t('panel.facts.reportedTitle', { name: reported.reportedId })}
                        {idMatch === true
                          ? <span data-fact-id-match="">{props.t('panel.facts.match')}</span>
                          : <span data-fact-id-mismatch="" className={styles.mismatch}>{props.t('panel.facts.idMismatch')}</span>}
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
                        {props.t('panel.button.pickFromTailscale')}
                      </button>
                    )
                  : (
                      <div data-tailscale-picker="" className={styles.tailscalePicker}>
                        <div className={styles.tailscalePickerBar}>
                          <span className={styles.tailscalePickerTitle}>{props.t('panel.tailscale.pickTitle')}</span>
                          <span className={styles.spacer} />
                          <button type="button" data-action="tailscale-refresh" className={styles.action} onClick={() => { void refreshPicker() }}>{props.t('panel.button.refresh')}</button>
                          <button type="button" data-action="tailscale-close" className={styles.action} onClick={() => { setPicker({ open: false }) }}>{props.t('panel.tailscale.collapse')}</button>
                        </div>
                        {picker.result === undefined
                          ? <p data-tailscale-state="loading" className={styles.stateLine}>{props.t('panel.tailscale.loading')}</p>
                          : picker.result.ok === false
                            ? <p data-tailscale-state="failed" className={styles.stateBad}>{picker.result.message}</p>
                            : (
                                <>
                                  {picker.result.note !== undefined
                                    ? <p data-tailscale-note="" className={styles.note}>{picker.result.note}</p>
                                    : undefined}
                                  {picker.result.peers.length === 0
                                    ? <p data-tailscale-state="empty" className={styles.stateLine}>{props.t('panel.tailscale.empty')}</p>
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
                                                <span className={styles.tailscalePeerMeta}>{props.t('panel.tailscale.peerMeta', { ip: peer.ip, status: peer.online ? props.t('panel.status.online') : props.t('panel.status.offline') })}</span>
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
            {props.t('panel.form.fieldName')}
            {editable && fields.id
              ? (
                  <input
                    value={idDraft}
                    data-form-field-id=""
                    className={styles.input}
                    onChange={event => { setIdDraft(event.target.value); setLocalError(undefined) }}
                    placeholder={props.mode === 'new' ? props.t('panel.form.fieldNamePlaceholder') : undefined}
                  />
                )
              : <span data-form-field-id="" className={styles.readonlyValue}>{props.values.hostId}</span>}
          </label>
          {addressHidden
            ? undefined
            : (
                <label className={styles.field}>
                  {props.t('panel.form.fieldIp')}
                  {editable && fields.address
                    ? <span data-address-empty-note="" className={styles.note}>{props.t('panel.form.addressEmptyNote')}</span>
                    : undefined}
                  {editable && fields.address
                    ? (
                        <input
                          value={ipDraft}
                          data-form-field-address=""
                          className={styles.input}
                          onChange={event => { setIpDraft(event.target.value); setLocalError(undefined) }}
                          placeholder={props.t('panel.form.ipPlaceholder')}
                        />
                      )
                    : fields.address
                      ? <span data-form-field-address="" className={styles.readonlyValue}>{hostPartOfAddress(props.values.address)}</span>
                      : undefined}
                </label>
              )}
        </form>
        {/* 添加页的 SSH 目标输入：选择器写的草稿在这里显示，也供人手填；
            部署区挂载时以它为初值（initialTarget）。放在 host form 外面——
            主机的登记字段只有名称和地址两个（表单字段的钉子测试守着这条），
            SSH 目标是部署区的草稿，不是登记字段。详情页不渲染——那里的部署
            区有自己的初值来源（登记凭据）。 */}
        {message === undefined
          ? undefined
          : <p data-form-message={message.tone} className={message.tone === 'ok' ? styles.stateLine : styles.stateBad}>{message.text}</p>}
        {props.postureNote}
        <div className={styles.formActions}>
          {editable && (props.mode === 'new' || fields.id || fields.address)
            ? (
                <button type="button" data-form-confirm="" className={styles.actionPrimary} onClick={confirm}>
                  {props.mode === 'new' ? props.t('panel.button.add') : props.t('panel.button.save')}
                </button>
              )
            : undefined}
          <button type="button" data-form-cancel-bottom="" className={styles.action} onClick={props.onCancel}>
            {props.mode === 'new' ? props.t('panel.button.cancel') : props.t('panel.button.backToList')}
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
  const navigate = props.navigate ?? ((url: string): void => { window.location.assign(url) })
  const [, setIdentityRevision] = useState(0)
  const [registryRevision, setRegistryRevision] = useState(0)
  const [formMessage, setFormMessage] = useState<{ readonly tone: 'ok' | 'bad'; readonly text: string } | undefined>(undefined)
  const notifyAiCopyOk = (): void => { setFormMessage({ tone: 'ok', text: props.t('panel.copyForAi.copied') }) }
  const [addMode, setAddMode] = useState<'chooser' | 'manual' | 'ssh'>('chooser')
  const [addIdDraft, setAddIdDraft] = useState('')
  const [addTitleDraft, setAddTitleDraft] = useState('')
  const [addAddressDraft, setAddAddressDraft] = useState('')
  // 选择器写、部署区读的 SSH 目标草稿：一份在面板手里，添加页的输入框和
  // 部署区的初值都从它来（选中的对端只是 SSH 目标，地址留给部署/连接写）。
  const [sshTargetDraft, setSshTargetDraft] = useState('')
  const [sshDeployAvailable, setSshDeployAvailable] = useState(false)
  useEffect(() => {
    void probeSshDeployApi().then(setSshDeployAvailable)
  }, [])
  // The sidebar tree's stage-L bridge lands here: a host row clicked in the
  // shadowed workspace list switches to this panel (selectPanel) and this
  // event says which host's detail page to open.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [reaches, setReaches] = useState<ReadonlyMap<string, ReachOutcome | 'probing'>>(new Map())
  // 远端读取的在途与失败：在途喂给 hostStatus 说「读取中」，失败把原因挂在
  // 该主机上、上次读到的话留在页面上（评审裁定 6）。
  const [readingId, setReadingId] = useState<string | undefined>(undefined)
  const [readFailures, setReadFailures] = useState<ReadonlyMap<string, string>>(new Map())
  // 启动失败单记一处：启动的失败用自己的话说，不借读取失败的留痕冒充。
  const [startFailures, setStartFailures] = useState<ReadonlyMap<string, string>>(new Map())
  // approve-and-read 进行中的那台主机：部署区为此打开并自动检查密钥。
  const [approveAndReadId, setApproveAndReadId] = useState<string | undefined>(undefined)
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
    setApproveAndReadId(undefined)
    setAddMode('chooser')
    setView({ page: 'list' })
  }
  const openDetail = (hostId: string): void => {
    setFormMessage(undefined)
    setConfirmingRemove(false)
    setApproveAndReadId(undefined)
    setView({ page: 'detail', hostId })
  }
  // 登记里带了入口的主机整页切过去（本机网关代理那台自己的界面，顶部有主机
  // 切换器，换到别台不用回这一页）；没有入口——本机、路过的标签页、还没部署
  // 的登记——就进设置页，那里是补地址、部署、连接的地方。
  const launchHref = (row: HostListRow): string | undefined => {
    if (row.self) return undefined
    const registration = props.registry.list().find(entry => entry.hostId === row.hostId)
    return registration?.launchUrl === undefined ? undefined : gatewayPagePath(row.hostId)
  }
  const enterHost = (row: HostListRow): void => {
    const href = launchHref(row)
    if (href !== undefined) {
      navigate(href)
      return
    }
    openDetail(row.hostId)
  }
  const openAdd = (): void => {
    setFormMessage(undefined)
    setAddMode(sshDeployAvailable ? 'chooser' : 'manual')
    setView({ page: 'add' })
  }
  const confirmAdd = (values: HostFormValues): boolean => {
    // 显示名已撤销（2026-10-13）：hostTitle 落库留空，存储层回落到 hostId，
    // 列表显示的就是名称本身。
    const result = props.registry.add({
      hostId: values.hostId,
      hostTitle: '',
      address: values.address,
      ...(values.launchUrl === undefined ? {} : { launchUrl: values.launchUrl }),
    })
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
      ...(values.launchUrl === undefined ? {} : { launchUrl: values.launchUrl }),
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
    void probeReach((input, init) => fetch(input, init), registration.address, 5000, props.t).then(outcome => {
      setReaches(previous => new Map(previous).set(registration.hostId, outcome))
    })
  }

  // 「使用这台主机」的状态：隧道检查按主机分开记（列表里点进点出互不串台），
  // 连接一次只跑一条，错误跟着主机走，原文照登。
  const [tunnelChecks, setTunnelChecks] = useState<ReadonlyMap<string, 'checking' | 'online' | 'offline'>>(new Map())
  const [connectBusyId, setConnectBusyId] = useState<string | undefined>(undefined)
  const [connectError, setConnectError] = useState<{ readonly hostId: string; readonly text: string } | undefined>(undefined)
  // 部署信息默认展开（2026-10-21 用户要求：部署就在设置界面里）；折叠是
  // 操作者的选择，approve-and-read 这类显式流程会把它重新打开。
  const [deployCollapsed, setDeployCollapsed] = useState<ReadonlySet<string>>(new Set())
  // 详情页选点的一次性覆盖：详情页换目标部署是受支持的动作（目标栏可编辑、
  // 部署成功就改写登记），显式选点必须赢过已存目标。只记「哪台主机、第几次
  // 选点、选了什么」：序号进部署区的 key 推动重挂，目标作为该次挂载的初值
  // 压过已存凭据。它与 sshTargetDraft（面板级草稿）刻意分开——草稿不翻转
  // 优先级，添加页留下的旧草稿盖不掉已存的好凭据；部署区收起或离开详情页即作废。
  const [deployPick, setDeployPick] = useState<{ readonly hostId: string; readonly serial: number; readonly target: string } | undefined>(undefined)
  const openDeploy = (hostId: string): void => {
    setDeployCollapsed(previous => {
      if (!previous.has(hostId)) return previous
      const next = new Set(previous)
      next.delete(hostId)
      return next
    })
  }
  const toggleDeploy = (hostId: string): void => {
    setDeployCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(hostId)) next.delete(hostId)
      else next.add(hostId)
      return next
    })
  }

  const storedSshInput = (info: HostSshInfo): (SshConnectionInput & { readonly hostKeyFingerprint: string }) | undefined => {
    // 可读性与事实装配同一把尺子（storedSshUsable）：密码/粘贴私钥不落盘。
    if (!storedSshUsable(info)) return undefined
    return {
      target: info.target,
      ...(info.port === undefined ? {} : { port: info.port }),
      ...(info.user === undefined ? {} : { user: info.user }),
      ...(info.proxyJump === undefined ? {} : { proxyJump: info.proxyJump }),
      identityFile: info.identityFile,
      hostKeyFingerprint: info.hostKeyFingerprint,
    }
  }

  /** 用给定凭据读一次对方状态：读数落进登记簿，失败把原因挂在该主机上。 */
  const readPeerWith = (registration: HostRegistration, ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }): void => {
    if (props.remote === undefined) return
    setReadingId(registration.hostId)
    void props.remote.read(ssh).then(result => {
      setReadingId(previous => previous === registration.hostId ? undefined : previous)
      if (!result.ok) {
        // 失败不动已存的读数：上次读到的话留在屏幕上，原因挂在旁边（裁定 6）。
        setReadFailures(previous => new Map(previous).set(registration.hostId, result.error))
        return
      }
      setReadFailures(previous => {
        const next = new Map(previous)
        next.delete(registration.hostId)
        return next
      })
      // 裁定 1 在落库侧的闸（remoteRecordOf）：降级读取不落成「未部署」。
      if (props.registry.recordRemote(registration.hostId, remoteRecordOf(result.report, Date.now()))) {
        setRegistryRevision(revision => revision + 1)
      }
    })
  }

  /**
   * 读一次对方状态。入口闸与可读性是同一把尺子：凭据没存（密码/粘贴私钥）
   * 或指纹还没批准的登记不读（裁定 4/5）——前者面板已明说读不了，后者的
   * 入口是「批准并读取」。
   */
  const readPeer = (registration: HostRegistration): void => {
    const stored = registration.ssh
    if (stored === undefined || stored.hostKeyFingerprint === 'unapproved') return
    const ssh = storedSshInput(stored)
    if (ssh === undefined) return
    readPeerWith(registration, ssh)
  }

  /**
   * 启动对方 DSH：入口闸与 readPeer 同一把尺子（凭据没存、指纹没批准都不发，
   * 裁定 4/5），成功后立即重读，屏幕上摆的是读回来的存活，不是假设。
   * 启动的失败记在启动自己名下（startFailures），不与读取失败的留痕混写。
   */
  const startPeer = (registration: HostRegistration): void => {
    const stored = registration.ssh
    if (stored === undefined || stored.hostKeyFingerprint === 'unapproved') return
    const ssh = storedSshInput(stored)
    if (ssh === undefined || props.remote === undefined) return
    void props.remote.start(ssh, stored.remoteWebPort ?? 3081).then(result => {
      if (!result.ok) {
        setStartFailures(previous => new Map(previous).set(registration.hostId, result.error))
        return
      }
      // 这次启动成了，上次启动失败的留痕随之作废。
      setStartFailures(previous => {
        const next = new Map(previous)
        next.delete(registration.hostId)
        return next
      })
      readPeer(registration)
    })
  }

  /**
   * 批准并读取：打开既有部署区（密钥批准交互只有这一套，裁定 5），自动
   * 检查一次主机密钥；操作者认完指纹（唯一钥匙时自动批准）就接着读。
   */
  const approveAndRead = (registration: HostRegistration): void => {
    setApproveAndReadId(registration.hostId)
    openDeploy(registration.hostId)
  }

  /** 详情页按钮表的统一出口：动作标识符到既有流程的映射，不新增流程。 */
  const runDetailAction = (registration: HostRegistration, action: HostAction | 'approve-and-read'): void => {
    switch (action) {
      case 'deploy':
      case 'redeploy':
      case 'fill-ssh':
        openDeploy(registration.hostId)
        break
      case 'read-peer':
      case 'retry-read':
        readPeer(registration)
        break
      case 'start-peer':
        startPeer(registration)
        break
      case 'open-page':
      case 'connect-open':
        runConnect(registration)
        break
      case 'check-reach':
        startReach(registration)
        break
      case 'approve-and-read':
        approveAndRead(registration)
        break
    }
  }

  // 进入详情页即读一次对方状态（有口、有已存凭据、指纹已批准才有得读；
  // 裁定 5：未批准的登记不自动读）。只在切换到某台主机时触发，登记的
  // 后续变化不反复发起读取。
  useEffect(() => {
    if (view.page !== 'detail') return
    const registration = props.registry.list().find(entry => entry.hostId === view.hostId)
    if (registration !== undefined) readPeer(registration)
  }, [view])

  // 选点覆盖只用这一程：离开详情页就作废，下次进页面仍是已存优先。
  useEffect(() => {
    if (deployPick === undefined) return
    if (view.page !== 'detail') setDeployPick(undefined)
  }, [view, deployPick])

  const runConnect = (
    registration: HostRegistration,
    sshInput?: SshConnectionInput & { readonly hostKeyFingerprint: string },
    facts?: SshSeedFacts | undefined,
  ): void => {
    const stored = registration.ssh
    // 入口闸与 readPeer/startPeer 同一把尺子（裁定 5）：指纹没批准的已存凭据
    // 不发——连过去只会撞回主机端口的一条生英文错误，正路是「批准并读取」。
    // 部署区现填的凭据（sshInput 在场）刚走过区块自己的批准交互，不受这道闸。
    if (sshInput === undefined && stored?.hostKeyFingerprint === 'unapproved') return
    const ssh = sshInput ?? (stored === undefined ? undefined : storedSshInput(stored))
    if (ssh === undefined) {
      // 没有可直接复用的凭据（未存方式，或密码/私钥）：如实说明并指去部署区块。
      setConnectError({ hostId: registration.hostId, text: props.t('panel.use.noCredential') })
      openDeploy(registration.hostId)
      return
    }
    setConnectBusyId(registration.hostId)
    setConnectError(previous => previous?.hostId === registration.hostId ? undefined : previous)
    void connectRemoteHost(ssh, stored?.remoteWebPort, props.t).then(result => {
      setConnectBusyId(undefined)
      if (!result.ok) {
        setTunnelChecks(previous => new Map(previous).set(registration.hostId, 'offline'))
        setConnectError({ hostId: registration.hostId, text: result.error })
        return
      }
      setTunnelChecks(previous => new Map(previous).set(registration.hostId, 'online'))
      setConnectError(previous => previous?.hostId === registration.hostId ? undefined : previous)
      const edit = applyRegistrationEdit(props.registry, registration.hostId, {
        address: result.value.endpoint,
        launchUrl: result.value.launchUrl,
        ...(facts === undefined ? {} : { ssh: facts }),
      })
      if (edit.ok) setRegistryRevision(revision => revision + 1)
      window.open(gatewayPagePath(registration.hostId), '_blank', 'noopener')
    })
  }

  const identity = props.rollUp.identity()
  const registrations = props.registry.list()
  // Re-read on every render: presence and the registry both change out from
  // under this component.
  const presence = props.rollUp.hosts()
  // 读取在途的那台喂给行推导：现在读数真实存在，「检测中」不再只代表探测。
  const hostRows = mergeHostRows(
    presence,
    registrations,
    reaches,
    readingId === undefined ? undefined : new Set([readingId]),
  )

  if (view.page === 'add') {
    if (sshDeployAvailable && addMode === 'chooser') {
      return (
        <div data-threadharbor-panel="" className={styles.root}>
          <AddHostChooser
            tailscale={props.tailscale}
            postureNote={<StoragePostureLine posture={props.hostStore?.posture()} t={props.t} />}
            onCancel={openList}
            onChooseManual={() => { setAddMode('manual'); setFormMessage(undefined) }}
            onChooseSsh={() => { setAddMode('ssh'); setFormMessage(undefined) }}
            onPickedPeer={peer => {
              // 添加页选中：带名字（主机 id）并展开部署区。在线主机走 MagicDNS，
              // 目标栏留空等操作者定；离线主机 ts.net 不可达，直接把 IP 填进目标。
              setAddIdDraft(peer.name)
              if (!peer.online) setSshTargetDraft(peer.ip)
              setAddMode('ssh')
            }}
            t={props.t}
          />
        </div>
      )
    }
    if (sshDeployAvailable && addMode === 'ssh') {
      return (
        <div data-threadharbor-panel="" className={styles.root}>
          <section data-panel-page="add-ssh" className={styles.card}>
            <div className={styles.cardHead}>
              <button type="button" className={styles.action} onClick={() => { setAddMode('chooser'); setFormMessage(undefined) }}>{props.t('panel.button.back')}</button>
              <h2 className={styles.title}>{props.t('panel.add.methodSsh')}</h2>
              <span className={styles.spacer} />
            </div>
            <StoragePostureLine posture={props.hostStore?.posture()} t={props.t} />
            {formMessage !== undefined
              ? <p data-form-message={formMessage.tone} className={formMessage.tone === 'ok' ? styles.stateLine : styles.stateBad}>{formMessage.text}</p>
              : undefined}
            <SshDeploySection
              hostId={addIdDraft}
              hostTitle={addTitleDraft}
              onHostIdChange={setAddIdDraft}
              onHostTitleChange={setAddTitleDraft}
              initialTarget={sshTargetDraft}
              onError={message => { setFormMessage({ tone: 'bad', text: message }) }}
              onDeployed={(deployResult, sshFacts) => {
                const result = props.registry.add({
                  hostId: addIdDraft.trim(),
                  hostTitle: addTitleDraft.trim(),
                  address: deployResult.endpoint,
                  launchUrl: deployResult.launchUrl,
                  ssh: sshFacts,
                })
                if (!result.ok) {
                  setFormMessage({ tone: 'bad', text: result.error.detail })
                  return
                }
                setRegistryRevision(revision => revision + 1)
                setFormMessage({
                  tone: 'ok',
                  text: props.t('panel.ssh.registered', { endpoint: deployResult.endpoint }),
                })
              }}
              onServeReady={(launchUrl, sshFacts, hostId) => {
                const saved = saveServeRegistration(props.registry, hostId, addTitleDraft.trim(), launchUrl, sshFacts)
                if (!saved.ok) {
                  setFormMessage({ tone: 'bad', text: saved.error.detail })
                  return
                }
                setRegistryRevision(revision => revision + 1)
                setFormMessage({ tone: 'ok', text: props.t('panel.check.saved', { url: new URL(launchUrl).origin }) })
              }}
              fromAddHost={true}
              onAiCopyOk={notifyAiCopyOk}
              t={props.t}
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
          heading={props.t('panel.title.addHost')}
          values={{ hostId: addIdDraft, address: addAddressDraft }}
          message={formMessage}
          postureNote={<StoragePostureLine posture={props.hostStore?.posture()} t={props.t} />}
          showTailscalePicker={false}
          onConfirm={values => {
            setAddIdDraft(values.hostId)
            setAddAddressDraft(values.address)
            return confirmAdd(values)
          }}
          onSaved={values => { setFormMessage(undefined); setView({ page: 'detail', hostId: values.hostId }) }}
          onCancel={() => { sshDeployAvailable ? setAddMode('chooser') : openList() }}
          tailscale={props.tailscale}
          t={props.t}
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
      // 详情页按钮表：状态词查表得动作（主按钮在前），两处按事实裁决——
      // 指纹未批准（裁定 5）与已部署但存活读不出（裁定 2 的唯一例外）。
      // 未批准时 retry-read 与 start-peer 都不出：读取和启动都要已批准的
      // 凭据；open-page 与 connect-open 同理不出——连接一族走的是同一条
      // 已存凭据的路，入口只有批准并读取。都返回新数组：hostActions 的表
      // 是共享实例，只渲染、不改动（裁定 3）。
      const statusActions = hostActions(row.connection)
      const detailActions: readonly (HostAction | 'approve-and-read')[] =
        registration !== undefined && registration.ssh?.hostKeyFingerprint === 'unapproved'
          ? ['approve-and-read', ...statusActions.filter(action => action !== 'retry-read' && action !== 'start-peer' && action !== 'open-page' && action !== 'connect-open')]
          : row.connection === 'unknown' && storedSshUsable(registration?.ssh) && registration?.remote?.deployment === 'deployed'
            ? ['retry-read', ...statusActions.filter(action => action !== 'retry-read')]
            : statusActions
      const readFailure = readFailures.get(row.hostId)
      const startFailure = startFailures.get(row.hostId)
      const storedRead = registration?.remote
      // 本机详情页在场的选点覆盖（deployPick 只服务这一台）：不是本机的选点
      // 一律不带，重挂与初值都轮不到别人家的。
      const pickedDeploy = deployPick !== undefined && deployPick.hostId === row.hostId ? deployPick : undefined
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
            headActions={registration !== undefined
              ? (!confirmingRemove
                  ? (
                      <button type="button" data-registry-remove-ask="" className={styles.action} onClick={() => { setConfirmingRemove(true) }}>{props.t('panel.button.deleteRegistration')}</button>
                    )
                  : (
                      <span data-registry-confirm="" className={styles.confirmBox}>
                        {props.t('panel.registry.removeNote')}
                        <button type="button" data-registry-remove-confirm="" className={styles.action} onClick={() => { removeRegistration(row.hostId); openList() }}>{props.t('panel.button.confirmRemove')}</button>
                        <button type="button" data-registry-remove-cancel="" className={styles.action} onClick={() => { setConfirmingRemove(false) }}>{props.t('panel.button.cancel')}</button>
                      </span>
                    ))
              : undefined}
            postureNote={<StoragePostureLine posture={props.hostStore?.posture()} t={props.t} />}
            onConfirm={values => row.self ? confirmSelf(values) : confirmEdit(view.hostId, values)}
            onCancel={openList}
            tailscale={props.tailscale}
            onPickedPeer={peer => {
              // 详情页选中：IP 只落进草稿，登记的地址与名称都不动——这里不切
              // 模式。选点是显式意图：展开部署区并重挂一次（序号进 key），让
              // 选中的地址成为这次挂载的目标初值，已存凭据的旧目标不压它。
              setSshTargetDraft(peer.ip)
              openDeploy(row.hostId)
              setDeployPick(previous => ({
                hostId: row.hostId,
                serial: (previous?.serial ?? 0) + 1,
                target: peer.ip,
              }))
            }}
            t={props.t}
            footer={registration !== undefined
              ? (
                  <>
                    <div data-registry-actions="" className={styles.registryActions}>
                      <p data-host-connection="" className={styles.stateLine}>
                        {props.t('panel.facts.status', { status: connectionStatusLabel(row.connection, props.t) })}
                        {/* 检测可达的动作并进了下面的按钮表（check-reach），
                            状态行只说话，不再带按钮。 */}
                      </p>
                      {reach !== undefined && reach !== 'probing' && reach.kind !== 'reachable'
                        ? <p className={styles.stateBad}>{reach.kind === 'timeout' ? props.t('panel.reach.probeTimeout', { ms: reach.ms }) : reach.reason}</p>
                        : undefined}
                      {registration.launchUrl !== undefined
                        ? (
                            <p data-registry-launch="" className={styles.stateLine}>
                              <a className={styles.actionPrimary} data-action="open-registry" href={gatewayPagePath(registration.hostId)} target="_blank" rel="noreferrer">{props.t('panel.registry.launchLink')}</a>
                              <button
                                type="button"
                                className={styles.action}
                                onClick={() => { void navigator.clipboard.writeText(registration.launchUrl ?? '') }}
                              >{props.t('panel.button.copyLink')}</button>
                            </p>
                          )
                        : undefined}
                    </div>
                    {!row.self
                      ? (
                          <>
                            {/* 详情页按钮表：hostActions 按状态词给出动作，主按钮在前。
                                密码认证的主机在旁边明说读不了（裁定 4）。 */}
                            <div data-host-actions="" className={styles.formActions}>
                              {detailActions.map((action, index) => (
                                <button
                                  key={action}
                                  type="button"
                                  data-action={action}
                                  className={index === 0 ? styles.actionPrimary : styles.action}
                                  onClick={() => { runDetailAction(registration, action) }}
                                >{actionLabel(action, props.t)}</button>
                              ))}
                            </div>
                            {registration.ssh !== undefined && !storedSshUsable(registration.ssh)
                              ? <p data-note-password-auth="" className={styles.stateLine}>{props.t('panel.notes.passwordAuth')}</p>
                              : undefined}
                            {registration.ssh?.hostKeyFingerprint === 'unapproved'
                              ? <p data-note-key-unapproved="" className={styles.stateLine}>{props.t('panel.button.keyNotApproved')}</p>
                              : undefined}
                            {/* 读取失败的留痕（裁定 6）：原因与上次读到的同时在场。 */}
                            {readFailure !== undefined
                              ? <p data-read-failed="" className={styles.stateBad}>{props.t('panel.notes.readFailed', { reason: readFailure })}</p>
                              : undefined}
                            {/* 启动失败的留痕：它说「没能启动」，不借读取失败的话。 */}
                            {startFailure !== undefined
                              ? <p data-start-failed="" className={styles.stateBad}>{props.t('panel.notes.startFailed', { reason: startFailure })}</p>
                              : undefined}
                            {readFailure !== undefined && storedRead !== undefined
                              ? (
                                  <p data-last-read="" className={styles.stateLine}>
                                    {props.t('panel.notes.lastRead', {
                                      summary: `${deploymentWord(storedRead.deployment, props.t)} · ${livenessWord(storedRead.liveness, props.t)}`,
                                      at: new Date(storedRead.readAt).toLocaleString(),
                                    })}
                                  </p>
                                )
                              : undefined}
                            {storedRead !== undefined
                              ? (
                                  <div data-remote-facts="" className={styles.reportedFacts}>
                                    <p data-fact-deployment="" className={styles.stateLine}>{props.t('panel.facts.deployment')}{'：'}{deploymentWord(storedRead.deployment, props.t)}</p>
                                    <p data-fact-liveness="" className={styles.stateLine}>{props.t('panel.facts.liveness')}{'：'}{livenessWord(storedRead.liveness, props.t)}</p>
                                    <p data-fact-entry="" className={styles.stateLine}>{props.t('panel.facts.entry')}{'：'}{registration.launchUrl ?? storedRead.launchUrl ?? '—'}</p>
                                    <p data-fact-reported="" className={styles.stateLine}>{props.t('panel.facts.reported')}{'：'}{row.online ? props.t('panel.status.online') : props.t('panel.status.offline')}</p>
                                    <p data-fact-read-at="" className={styles.stateLine}>{props.t('panel.facts.readAt')}{'：'}{new Date(storedRead.readAt).toLocaleString()}</p>
                                  </div>
                                )
                              : undefined}
                          </>
                        )
                      : undefined}
                    {!row.self
                      ? (
                          <HostUseSection
                            hostId={registration.hostId}
                            sshInfo={registration.ssh}
                            launchUrl={registration.launchUrl}
                            tunnel={tunnelChecks.get(row.hostId) ?? 'unknown'}
                            connecting={connectBusyId === row.hostId}
                            error={connectError?.hostId === row.hostId ? connectError.text : undefined}
                            onConnect={() => { runConnect(registration) }}
                            onOpenDeploy={() => { openDeploy(row.hostId) }}
                            onAiCopyOk={notifyAiCopyOk}
                            onCopyFailed={() => { setFormMessage({ tone: 'bad', text: props.t('panel.copyForAi.failed') }) }}
                            t={props.t}
                          />
                        )
                      : undefined}
                    {sshDeployAvailable && !row.self
                      ? (
                          <section data-deploy-section="" className={styles.sshSection}>
                            <div className={styles.sectionHead}>
                              <h3 className={styles.sectionTitle}>{props.t('panel.title.deployInfo')}</h3>
                              <span className={styles.spacer} />
                              <button
                                type="button"
                                className={deployCollapsed.has(row.hostId) ? styles.actionPrimary : styles.action}
                                data-action={deployCollapsed.has(row.hostId) ? 'open-deploy' : 'close-deploy'}
                                onClick={() => { toggleDeploy(row.hostId) }}
                              >{deployCollapsed.has(row.hostId) ? props.t('panel.deploy.expand') : props.t('panel.deploy.collapse')}</button>
                            </div>
                            {!deployCollapsed.has(row.hostId)
                              ? (
                                  <SshDeploySection
                                    // key 带上 approve-and-read 标记：从「批准并读取」
                                    // 打开时重挂一次，自动检查密钥的 effect 才会跑。
                                    // 末段是选点序号：只由详情页选点推动，选点重挂
                                    // 一次带上新目标；不挂草稿值，免得输入被冲掉。
                                    key={`deploy-${row.hostId}-${approveAndReadId === row.hostId}-${pickedDeploy === undefined ? 0 : pickedDeploy.serial}`}
                                    hostId={row.hostId}
                                    hostTitle={row.name}
                                    lockHost
                                    initial={registration.ssh}
                                    initialTarget={sshTargetDraft}
                                    pickedTarget={pickedDeploy?.target}
                                    autoInspect={approveAndReadId === row.hostId}
                                    onApproved={approveAndReadId === row.hostId
                                      ? ssh => {
                                          // 认完指纹接着读：approve-and-read 的后半段，
                                          // 用的就是这次批准的指纹。
                                          readPeerWith(registration, ssh)
                                        }
                                      : undefined}
                                    onHostIdChange={() => undefined}
                                    onHostTitleChange={() => undefined}
                                    onDeployed={(result, facts) => {
                                      const edit = applyRegistrationEdit(props.registry, row.hostId, {
                                        address: result.endpoint,
                                        launchUrl: result.launchUrl,
                                        ssh: facts,
                                      })
                                      if (!edit.ok) {
                                        setFormMessage({ tone: 'bad', text: edit.error.detail })
                                        return
                                      }
                                      setRegistryRevision(revision => revision + 1)
                                      setTunnelChecks(previous => new Map(previous).set(row.hostId, 'online'))
                                      setFormMessage(undefined)
                                    }}
                                    onConnect={(ssh, facts) => { runConnect(registration, ssh, facts) }}
                                    onServeReady={(launchUrl, facts) => {
                                      const saved = saveServeRegistration(props.registry, row.hostId, '', launchUrl, facts)
                                      if (!saved.ok) {
                                        setFormMessage({ tone: 'bad', text: saved.error.detail })
                                        return
                                      }
                                      setRegistryRevision(revision => revision + 1)
                                      setTunnelChecks(previous => new Map(previous).set(row.hostId, 'online'))
                                      setFormMessage({ tone: 'ok', text: props.t('panel.check.saved', { url: new URL(launchUrl).origin }) })
                                    }}
                                    onError={() => undefined}
                                    onAiCopyOk={notifyAiCopyOk}
                                    t={props.t}
                                  />
                                )
                              : undefined}
                          </section>
                        )
                      : undefined}
                  </>
                )
              : undefined}
            agents={row.self
              ? (
                  <div data-agent-section="" className={styles.agentSection}>
                    <div className={styles.sectionHead}>
                      <h3 className={styles.sectionTitle}>{props.t('panel.title.selfAgents')}</h3>
                      <span className={styles.spacer} />
                      <button type="button" data-action="refresh-agents" className={styles.action} onClick={refreshAgents}>{props.t('panel.button.refresh')}</button>
                    </div>
                    {load.stage === 'loading'
                      ? <p data-agents-loading="" className={styles.stateLine}>{props.t('panel.agents.loading')}</p>
                      : load.stage === 'failed'
                        ? <p data-agents-failed="" className={styles.stateBad}>{props.t('panel.agents.failed', { message: load.message })}</p>
                        : agents.length === 0
                          ? (
                              <p data-agents-empty="" className={styles.stateLine}>
                                {props.agentsNote ?? props.t('panel.agents.empty')}
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
                                    t={props.t}
                                  />
                                ))}
                              </div>
                            )}
                    <details data-self-heal-note="" className={styles.noteDetails}>
                      <summary className={styles.summary}>{props.t('panel.title.connectionCare')}</summary>
                      <p className={styles.note}>
                        {props.t('panel.notes.selfHeal')}
                      </p>
                    </details>
                  </div>
                )
              : undefined}
            notes={(
              <details className={styles.noteDetails}>
                <summary className={styles.summary}>{props.t('panel.title.notes')}</summary>
                <ul data-panel-notices="" className={styles.notices}>
                  <li>{props.t('panel.notes.onlineMeaning')}</li>
                  <li>{props.t('panel.notes.otherSource')}</li>
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
      {/* 2026-10-14 用户确认：面板回到单区域——没有左侧会话树（2026-10-11
          §8.3 的决定），要看某台主机的会话，去那台主机自己的页面。 */}
      <div data-panel-page="list">
        <div className={styles.pageHead}>
          <h2 className={styles.title}>{props.t('panel.title.hosts')}</h2>
          <span className={styles.spacer} />
          <button
            type="button"
            data-action="add-host"
            className={styles.actionPrimary}
            onClick={openAdd}
          >{props.t('panel.title.addHost')}</button>
        </div>
        <StoragePostureLine posture={props.hostStore?.posture()} t={props.t} />
        <div data-host-list="" className={styles.hostList}>
          <div data-host-list-head="" className={styles.hostListHead} aria-hidden="true">
            <span className={styles.hostListHeadLabel}>{props.t('panel.form.fieldName')}</span>
            <span className={styles.hostListHeadLabel}>{props.t('panel.form.fieldStatus')}</span>
            <span className={styles.hostListHeadLabel}>{props.t('panel.form.fieldIp')}</span>
            <span className={styles.hostListHeadLabel} />
          </div>
          {hostRows.length === 0
            ? <p data-host-list-empty="" className={styles.hostListEmpty}>{props.t('panel.list.empty')}</p>
            : hostRows.map(row => (
                <HostRow
                  key={row.hostId}
                  row={row}
                  href={launchHref(row)}
                  onOpen={() => { enterHost(row) }}
                  onSettings={() => { openDetail(row.hostId) }}
                  t={props.t}
                />
              ))}
        </div>
      </div>
    </div>
  )
}
