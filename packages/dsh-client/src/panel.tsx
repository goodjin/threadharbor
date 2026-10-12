/**
 * The panel itself: one sidebar entry's worth of screen.
 *
 * 2026-10-12 用户反馈定下的形状：三个界面，列表页之外都是独立的页面——
 *
 * 1. 列表页：上方一个「添加新主机」按钮，下面是主机行。行是摘要（名字、
 *    简短标识、徽标），点行进详情页，不就地展开；列表页宽度固定，别的
 *    什么都不放。
 * 2. 详情页：与添加页共用同一套表单（HostFormPage 的 view 模式）——用户填
 *    的字段（主机标识、显示名、地址）是表单，主机自己报的事实（在线状态、
 *    心跳、自报的标识和名字）只在详情模式出现。本机的 agent 列表属于本机
 *    的详情页，不再单独占一张卡。
 * 3. 添加页：同一套表单的 new 模式，表单在上，下面「确定」「取消」。
 *
 * 主机标识两边可能不一样（人填的 vs 机器自报的）：详情页把两个值都摆出来
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
import type { HostIdentity, HostRegistration, RegistrationResult } from '@threadharbor/dsh-host-federation'
import type { HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { HostStorePosture } from './host-store.ts'
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
 * What an operator fills in for one host: the identifier, the name, and where
 * it lives. The same three values drive the add page and the detail page.
 */
export type HostFormValues = {
  readonly hostId: string
  readonly hostTitle: string
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
  /** The name the host itself announces; absent while it is not heard. */
  readonly reportedTitle?: string
  /** Every identifier actually announcing right now — the real cross-check. */
  readonly onlineIds: readonly string[]
}

/** Which form fields a view-mode page lets the operator edit; the rest read out. */
export type HostFormFieldPolicy = {
  readonly id: boolean
  readonly title: boolean
  readonly address: boolean
}

const ALL_FIELDS: HostFormFieldPolicy = { id: true, title: true, address: true }

/** What an operator edits on one registration: id (optional), name, address. */
export type RegistrationEditInput = {
  readonly hostId?: string
  readonly hostTitle: string
  readonly address: string
}

/**
 * Edit one registration through the registry's add/remove face.
 *
 * The registry has no update, and the wiring passes it as-is — so an edit is
 * remove-then-add, with one safety rail: if the new entry is refused (a bad
 * address, an id somebody else already holds), the previous entry goes back
 * in, because a failed edit must not silently delete the operator's record.
 * The identifier is editable too — that is exactly how a filled-in id gets
 * corrected to the one the machine actually announces. A row that is present
 * but never registered (another same-origin tab) has nothing to edit, so this
 * is simply an add.
 * @param registry - the registry port as the wiring provides it.
 * @param previousId - which registration to replace.
 * @param input - the new id (omit to keep the old one), name, and address.
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
    return registry.add({ hostId: nextId, hostTitle: input.hostTitle, address: input.address })
  }
  registry.remove(previousId)
  const result = registry.add({ hostId: nextId, hostTitle: input.hostTitle, address: input.address })
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
 * One host row in the list. The row is a summary — name, the short id, the
 * badge — and the whole row is the button that opens the host's detail page.
 * Nothing else rides on it: details live on the detail page.
 * @param props - the merged row and the open handler.
 * @returns the row.
 */
export function HostRow(props: {
  readonly row: HostListRow
  readonly onOpen: () => void
}): ReactNode {
  const { row } = props
  const badge = row.self
    ? { word: '本机', tone: 'self' as const }
    : row.online
      ? { word: '在线', tone: 'online' as const }
      : { word: '未连接', tone: 'offline' as const }
  return (
    <div data-host-row={row.hostId} className={styles.hostRow}>
      <button
        type="button"
        data-host-open={row.hostId}
        className={styles.hostRowButton}
        onClick={props.onOpen}
      >
        <strong data-host-name="" className={styles.hostName}>{row.name}</strong>
        <span data-host-id-label="" className={styles.hostIdShort} title={row.hostId}>{row.hostId}</span>
        <span data-host-badge={badge.tone} className={styles.hostBadge}>{badge.word}</span>
        <span className={styles.spacer} />
        <span className={styles.chevron} aria-hidden="true">▸</span>
      </button>
    </div>
  )
}

/**
 * The form page both adding and viewing share — one component, two modes, so
 * a field changes in one place. Mode `new` collects the three operator-filled
 * fields over 确定/取消. Mode `view` shows the same fields (minus the ones
 * this page has no business editing) plus the facts the host itself reports —
 * status, heartbeat, and the id and name the host announces, laid beside what
 * was filled in, with mismatches named out loud instead of silently resolved.
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
}): ReactNode {
  const [idDraft, setIdDraft] = useState(props.values.hostId)
  const [titleDraft, setTitleDraft] = useState(props.values.hostTitle)
  const [addressDraft, setAddressDraft] = useState(props.values.address)
  const { reported } = props
  const fields = props.mode === 'new' ? ALL_FIELDS : props.fields ?? ALL_FIELDS
  const confirm = (): void => {
    // onConfirm 回 true＝保存成功，页面关掉回列表（列表本身就是保存结果的
    // 反馈：新行以「未连接」出现、名字换成新的）；回 false＝留在本页看错误。
    const close = props.onConfirm({ hostId: idDraft.trim(), hostTitle: titleDraft.trim(), address: addressDraft.trim() })
    if (close) props.onCancel()
  }
  // 自报值与填写值当场比对（跟着输入走），不一致就明说，两边都保留。
  const idMatch = reported?.reportedId === undefined ? undefined : reported.reportedId === idDraft.trim()
  const titleMatch = reported?.reportedTitle === undefined ? undefined : reported.reportedTitle === titleDraft.trim()
  const addressHidden = props.mode === 'view' && !fields.address && props.values.address === ''
  return (
    <section data-panel-page={props.mode === 'new' ? 'add' : 'detail'} className={styles.card}>
      <div className={styles.cardHead}>
        <button
          type="button"
          data-form-cancel=""
          className={styles.action}
          onClick={props.onCancel}
        >‹ 返回</button>
        <h2 className={styles.title}>{props.heading}</h2>
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
                      频道上没有这个标识的报数
                      {reported.onlineIds.length > 0
                        ? <>；现在在线的标识：<span data-fact-online-ids="">{reported.onlineIds.join('、')}</span></>
                        : null}
                      。
                    </p>
                  )
                : undefined}
              {reported.reportedId !== undefined
                ? (
                    <p data-fact-reported-id="" className={styles.stateLine}>
                      主机自报标识：{reported.reportedId}
                      {idMatch === true
                        ? <span data-fact-id-match="">（与填写一致）</span>
                        : <span data-fact-id-mismatch="" className={styles.mismatch}>（与填写的不一样；两边都保留，把上面的标识改成它，两边就对上了）</span>}
                    </p>
                  )
                : undefined}
              {reported.reportedTitle !== undefined
                ? (
                    <p data-fact-reported-title="" className={styles.stateLine}>
                      主机自报名字：{reported.reportedTitle}
                      {titleMatch === true
                        ? <span data-fact-title-match="">（与填写一致）</span>
                        : <span data-fact-title-mismatch="" className={styles.mismatch}>（与填写的不一样；列表显示的是登记名）</span>}
                    </p>
                  )
                : undefined}
            </div>
          )}
      <form
        data-host-form=""
        className={styles.formGrid}
        onSubmit={event => {
          event.preventDefault()
          confirm()
        }}
      >
        <label className={styles.field}>
          主机标识
          {fields.id
            ? (
                <input
                  value={idDraft}
                  data-form-field-id=""
                  className={styles.input}
                  onChange={event => { setIdDraft(event.target.value) }}
                  placeholder={props.mode === 'new' ? '那台机器面板里配置的 hostId' : undefined}
                />
              )
            : <span data-form-field-id="" className={styles.readonlyValue}>{props.values.hostId}</span>}
        </label>
        <label className={styles.field}>
          显示名
          {fields.title
            ? (
                <input
                  value={titleDraft}
                  data-form-field-title=""
                  className={styles.input}
                  onChange={event => { setTitleDraft(event.target.value) }}
                  placeholder="如：测试机"
                />
              )
            : <span data-form-field-title="" className={styles.readonlyValue}>{props.values.hostTitle}</span>}
        </label>
        {addressHidden
          ? undefined
          : (
              <label className={styles.field}>
                地址（含 http 和端口）
                {fields.address
                  ? (
                      <input
                        value={addressDraft}
                        data-form-field-address=""
                        className={styles.input}
                        onChange={event => { setAddressDraft(event.target.value) }}
                        placeholder="http://192.168.1.10:3081"
                      />
                    )
                  : <span data-form-field-address="" className={styles.readonlyValue}>{props.values.address}</span>}
              </label>
            )}
      </form>
      {props.message === undefined
        ? undefined
        : <p data-form-message={props.message.tone} className={props.message.tone === 'ok' ? styles.stateLine : styles.stateBad}>{props.message.text}</p>}
      {props.postureNote}
      <div className={styles.formActions}>
        {props.mode === 'new' || fields.id || fields.title || fields.address
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
      {props.mode === 'new'
        ? (
            <div data-add-notes="" className={styles.addNotes}>
              <p data-registry-posture="" className={styles.note}>
                添加主机＝登记它的地址和打开步骤，<strong>不是建立连接</strong>：本页无法跨源读取另一台主机的接口，也听不到它标签页的频道；
                每台主机用它自己的页面打开，那一个标签页有自己的面板。
              </p>
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
            </div>
          )
        : undefined}
      {props.notes}
    </section>
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
  const confirmAdd = (values: { readonly hostId: string; readonly hostTitle: string; readonly address: string }): boolean => {
    const result = props.registry.add(values)
    // 成功不留在本页：关闭后的列表里那行「未连接」就是结果。只把失败留在页面上。
    if (!result.ok) {
      setFormMessage({ tone: 'bad', text: result.error.detail })
    }
    setRegistryRevision(revision => revision + 1)
    return result.ok
  }
  const confirmEdit = (previousId: string, values: { readonly hostId: string; readonly hostTitle: string; readonly address: string }): boolean => {
    const result = applyRegistrationEdit(props.registry, previousId, {
      ...(values.hostId === '' || values.hostId === previousId ? {} : { hostId: values.hostId }),
      hostTitle: values.hostTitle,
      address: values.address,
    })
    if (!result.ok) {
      setFormMessage({ tone: 'bad', text: result.error.detail })
    }
    setRegistryRevision(revision => revision + 1)
    return result.ok
  }
  const confirmSelf = (values: { readonly hostId: string; readonly hostTitle: string; readonly address: string }): boolean => {
    props.rollUp.setIdentity({
      ...(values.hostId === '' ? {} : { hostId: values.hostId }),
      ...(values.hostTitle === '' ? {} : { hostTitle: values.hostTitle }),
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
  const hostRows = mergeHostRows(presence, registrations)

  if (view.page === 'add') {
    return (
      <div data-threadharbor-panel="" className={styles.root}>
        <HostFormPage
          key="add"
          mode="new"
          heading="添加新主机"
          values={{ hostId: '', hostTitle: '', address: '' }}
          message={formMessage}
          postureNote={<StoragePostureLine posture={props.hostStore?.posture()} />}
          onConfirm={values => confirmAdd(values)}
          onCancel={openList}
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
        ...(row.online
          ? {
              reportedId: row.hostId,
              // 自报的名字取主机自己的快照，不是合并后的显示名：两者不同正是要摆出来的事。
              reportedTitle: row.self
                ? identity.hostTitle
                : presence.find(host => host.hostId === row.hostId)?.hostTitle ?? row.name,
            }
          : {}),
        onlineIds: props.rollUp.onlineHostIds(),
      }
      const values: HostFormValues = {
        hostId: row.self ? identity.hostId : row.hostId,
        hostTitle: row.self ? identity.hostTitle : row.name,
        address: row.address ?? '',
      }
      // 本机的标识与名字是本机身份，可编辑；地址是登记簿的东西，只读展示。
      // 外来主机登记过就能整行改；只是路过（同源另一标签页）就没有可填的。
      const fields = row.self
        ? { id: true, title: true, address: false }
        : registration !== undefined
          ? { id: true, title: true, address: true }
          : { id: false, title: false, address: false }
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
            footer={registration !== undefined
              ? (
                  <div data-registry-actions="" className={styles.registryActions}>
                    {!row.online
                      ? (
                          <p data-registry-reach="" className={styles.stateLine}>
                            {reach === undefined
                              ? (
                                  <button type="button" data-registry-reach-try="" className={styles.action} onClick={() => { startReach(registration) }}>测网络可达</button>
                                )
                              : reach === 'probing'
                                ? '正在测……'
                                : reach.kind === 'reachable'
                                  ? `网络可达（${reach.ms} ms 内有应答）。这只是端口上有东西回应，不能确认是 DSH，也不校验 token。`
                                  : reach.kind === 'timeout'
                                    ? `测不通：${reach.ms} ms 内无应答（超时）。`
                                    : `测不通：${reach.reason}。`}
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
                  </div>
                )
              : undefined}
            notes={(
              <details className={styles.noteDetails}>
                <summary className={styles.summary}>说明</summary>
                <ul data-panel-notices="" className={styles.notices}>
                  <li>「在线」= 这台机器的页面在同一个浏览器的同源标签页里开着并按心跳报数；关闭或崩溃的页面过了静默窗口会自动转为未列出。</li>
                  <li>另一台机器（另一个源）的页面不在这个频道里；它的行以「未连接」出现，靠的是登记。</li>
                  <li>会话与项目不再在此列出（2026-10-11 决定）：要看某台主机的会话，去那台主机自己的页面。</li>
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
      <section data-panel-page="list" className={styles.card}>
        <div className={styles.cardHead}>
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
          {hostRows.map(row => (
            <HostRow
              key={row.hostId}
              row={row}
              onOpen={() => { setFormMessage(undefined); setConfirmingRemove(false); setView({ page: 'detail', hostId: row.hostId }) }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
