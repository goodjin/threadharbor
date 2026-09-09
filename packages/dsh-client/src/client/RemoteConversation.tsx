/** Active remote transcript, permissions, prompt, and cancel controls. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconAgentPresetOutline16, IconCheckOutline16, IconChevronDownOutline14,
  IconChevronRightOutline14, IconCodeOutline16, IconCopyOutline16, IconEnhanceOutline16,
  IconLinkOutline16, IconRefreshOutline16, IconSendOutline16, IconStopFill16, IconThinkOutline16,
  IconTrashOutline16, MarkdownText, MessageText, StateDot, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  JsonValue, RemoteAgentBackend, RemoteAgentConfigBackend, RemoteAgentConfigDocument, RemoteAuthChallenge,
  RemoteDirectoryListing, RemoteHostView, RemoteInstallPlan, RemoteOperationView, RemoteProjectView, RemoteSshConfig,
  RemoteSessionView, RemoteSshInspection, RemoteTranscriptEntry,
} from '@threadharbor/protocol'
import { RemoteHostId, RemoteProjectId, RemoteSessionId, isRemoteBackendSessionReady } from '@threadharbor/protocol'
import {
  BACKEND_ORDER, backendInventoryState, describeAgentInstallFailure, describeHostConnectFailure,
  canUpgradeHostd, hostConnectionLabel, hostDeployment, hostIpLabel, parseReopenFailure,
  type RemoteAgentPanel, type RemoteAgentStore, type RemotePromptProgress,
  type ReopenFailureIssue,
} from './store.ts'
import {
  autoApproveOptionId, browsableDirectories, buildTranscriptNodes, choiceCancelOutcome, choiceSubmitOutcome,
  conversationPresentation,
  isAutoApprovablePermission, isNearScrollBottom, parseChoicePrompt, parsePlanItems, pendingPermissionEntry,
  permissionRequestId, preferredProjectBackend, shouldAutoApprovePermissions, shouldPinPendingPermission,
  toolDisclosurePresentation,
  type ChoicePrompt, type ConversationStage, type RemoteTranscriptNode,
} from './conversation-model.ts'
import css from './RemoteSurface.module.css'
import {
  MAX_AUTO_HIDE_AFTER_DAYS,
  MAX_SESSIONS_PER_PROJECT_LIMIT,
  readDisplayPreferences,
  subscribeDisplayPreferences,
} from './display-preferences.ts'
import { TranscriptGapBanner } from './transcript-gap-banner.tsx'
import { ConversationStatsLine } from './conversation-stats-line.tsx'

/** Props injected by the conversation slot registration. */
export interface RemoteConversationInjected {
  readonly store: RemoteAgentStore
}

/** Full conversation component props. */
export type RemoteConversationProps = PropsRuntime<'conversation'> & ConvOwnerProps & RemoteConversationInjected

/** Advisory threshold: a running turn with no backend frames for this long is
 *  flagged as possibly unresponsive and offered a force-restart action. The
 *  agent may still legitimately be busy (e.g. a long build), so the action is
 *  user-confirmed rather than automatic. */
const STALLED_AGENT_BANNER_MS = 5 * 60_000
const FORCE_RESTART_ARM_MS = 10_000

function PlanCard({ items }: { items: readonly { content: string; status: string; priority?: string }[] }) {
  return (
    <article className={css.planCard}>
      <strong>执行计划</strong>
      <ol className={css.planList}>
        {items.map((item, index) => (
          <li key={`${index}:${item.content}`} data-status={item.status}>
            <span className={css.planStatus}>
              {item.status === 'completed' ? '完成' : item.status === 'in_progress' ? '进行中' : '待办'}
            </span>
            <span className={css.planContent}>{item.content}</span>
            {item.priority !== undefined && <small>{item.priority === 'high' ? '高' : item.priority === 'low' ? '低' : '中'}</small>}
          </li>
        ))}
      </ol>
    </article>
  )
}

function ChoiceCard({ prompt, pending, onSubmit }: {
  prompt: ChoicePrompt
  pending: boolean
  onSubmit: (outcome: JsonValue) => void
}) {
  const immediate = prompt.questions.length <= 1 && prompt.questions[0]?.multiSelect !== true
  const [answers, setAnswers] = useState<Record<string, string | readonly string[]>>({})
  const toggle = (questionId: string, optionId: string, multiSelect: boolean): void => {
    setAnswers((current) => {
      if (!multiSelect) return { ...current, [questionId]: optionId }
      const existing = current[questionId]
      const selected = Array.isArray(existing) ? [...existing] : existing === undefined ? [] : [existing]
      const next = selected.includes(optionId) ? selected.filter(value => value !== optionId) : [...selected, optionId]
      return { ...current, [questionId]: next }
    })
  }
  const ready = prompt.questions.every((question) => {
    const selected = answers[question.id]
    return Array.isArray(selected) ? selected.length > 0 : selected !== undefined && selected !== ''
  })
  return (
    <article className={css.choiceCard} data-kind={prompt.kind}>
      <strong>{prompt.kind === 'question' ? '需要你的选择' : '权限请求'}</strong>
      <p>{prompt.detail ?? prompt.title}</p>
      {prompt.questions.map(question => (
        <div key={question.id} className={css.choiceQuestion}>
          {(prompt.questions.length > 1 || question.prompt !== prompt.title) && <span>{question.prompt}</span>}
          <div className={css.permissionActions}>
            {question.options.map(option => {
              const selected = answers[question.id]
              const active = Array.isArray(selected) ? selected.includes(option.id) : selected === option.id
              return (
                <Button
                  key={option.id}
                  size="sm"
                  variant={active ? 'primary' : 'outline'}
                  disabled={pending}
                  title={option.description}
                  onClick={() => {
                    if (immediate) onSubmit(choiceSubmitOutcome(prompt, { [question.id]: option.id }))
                    else toggle(question.id, option.id, question.multiSelect)
                  }}
                >{pending && immediate ? '提交中…' : option.label}</Button>
              )
            })}
          </div>
        </div>
      ))}
      <div className={css.permissionActions}>
        {!immediate && (
          <Button size="sm" variant="primary" disabled={pending || !ready} onClick={() => {
            onSubmit(choiceSubmitOutcome(prompt, answers))
          }}>{pending ? '提交中…' : '提交选择'}</Button>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
          onSubmit(choiceCancelOutcome(prompt))
        }}>{pending ? '提交中…' : prompt.kind === 'question' ? '跳过' : '拒绝'}</Button>
      </div>
    </article>
  )
}

function ReasoningNode({ entry, active }: { entry: RemoteTranscriptEntry; active: boolean }) {
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const open = active || pinnedOpen
  const summary = active ? latestLine(entry.text) : firstLine(entry.text)
  const summaryRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = active ? element.scrollWidth - element.clientWidth : 0
  }, [active, summary])
  return (
    <div className={css.reasoningMessage} data-state={active ? 'running' : 'ok'}>
      <button
        type="button"
        className={css.reasoningRow}
        aria-expanded={open}
        disabled={!active && entry.text === ''}
        onClick={() => { if (active || entry.text !== '') setPinnedOpen(value => !value) }}
      >
        <span className={css.reasoningLeading} aria-hidden><IconThinkOutline16 /></span>
        <span className={css.reasoningTitle}>{active ? '正在思考' : '思考过程'}</span>
        <span className={css.reasoningSeparator} aria-hidden />
        <span
          ref={summaryRef}
          className={css.nodeHint}
          data-follow-end={active || undefined}
          title={summary}
        >
          {summary === '' ? ' ' : summary}
        </span>
        <IconChevronDownOutline14 className={css.reasoningChevron} data-open={open || undefined} aria-hidden />
      </button>
      {open && <div className={css.reasoningBody}><MarkdownText text={entry.text} streaming={active} /></div>}
    </div>
  )
}

/** Format an ISO timestamp as the local HH:MM (with seconds once it crosses a minute). */
function formatEntryTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return ''
  const date = new Date(parsed)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function ToolNode({ node, active }: { node: Extract<RemoteTranscriptNode, { kind: 'tool' }>; active: boolean }) {
  const hasResult = node.entries.some(entry => entry.kind === 'tool-result')
  const presentation = toolDisclosurePresentation(hasResult, active)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  // running => open, finished without result => open, finished with result => collapsed unless pinned
  const open = active || !hasResult || pinnedOpen
  const liveText = node.entries.at(-1)?.text ?? ''
  const summary = active ? latestLine(liveText) : firstLine(node.title)
  const summaryRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = active ? element.scrollWidth - element.clientWidth : 0
  }, [active, summary])
  return (
    <div className={css.toolMessage} data-state={active ? 'running' : hasResult ? 'ok' : 'pending'}>
      <button
        type="button"
        className={css.toolRow}
        aria-expanded={open}
        onClick={() => { setPinnedOpen(value => !value) }}
      >
        <span className={css.toolLeading} aria-hidden><IconCodeOutline16 /></span>
        <span className={css.toolTitle}>{node.title}</span>
        <span className={css.toolSeparator} aria-hidden />
        <span
          ref={summaryRef}
          className={css.nodeHint}
          data-follow-end={active || undefined}
          title={summary}
        >
          {summary === '' ? presentation.status : summary}
        </span>
        <IconChevronDownOutline14 className={css.toolChevron} data-open={open || undefined} aria-hidden />
      </button>
      {open && (
        <div className={css.toolBody}>
          {node.entries.map(entry => (
            <div key={entry.transcriptId} className={css.toolPart}>
              <span>{entry.kind === 'tool-call' ? '调用' : '结果'}</span>
              <pre>{entry.text}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** First line of `text`, or the whole thing if there's no newline. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Last non-empty line of `text`, used while streaming so the chip follows the
 *  latest output rather than the first sentence. */
function latestLine(text: string): string {
  const visible = text.trimEnd()
  if (visible === '') return ''
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/** Show the current session id with a copy-to-clipboard affordance. */
function CopyIconButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])
  const onCopy = (): void => {
    if (text === '') return
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }
  return (
    <button
      type="button"
      className={css.messageAction}
      data-copied={copied || undefined}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
      disabled={text === ''}
      onClick={(event) => { event.stopPropagation(); onCopy() }}
    >
      {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
    </button>
  )
}

function SessionIdChip({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])
  const onCopy = () => {
    void writeClipboard(sessionId).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }
  return (
    <span
      className={css.sessionIdChip}
      role="group"
      aria-label="会话 ID"
      title={sessionId}
    >
      <IconLinkOutline16 className={css.sessionIdIcon} aria-hidden />
      <span className={css.sessionIdLabel}>会话 ID</span>
      <code>{sessionId}</code>
      <button
        type="button"
        className={css.sessionIdCopy}
        data-copied={copied || undefined}
        aria-label={copied ? '已复制' : '复制会话 ID'}
        onClick={(event) => { event.stopPropagation(); onCopy() }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      </button>
    </span>
  )
}

function TranscriptRow({ node, active, onPermission, onResend, resendDisabled = false, permissionPending = false }: {
  node: RemoteTranscriptNode
  active: boolean
  onPermission: (requestId: string, outcome: JsonValue) => void
  onResend?: (text: string) => void
  resendDisabled?: boolean
  permissionPending?: boolean
}) {
  if (node.kind === 'tool') return <ToolNode node={node} active={active} />
  const entry = node.entry
  const planItems = parsePlanItems(entry)
  if (planItems !== undefined) return <PlanCard items={planItems} />
  if (entry.role === 'permission') {
    const prompt = parseChoicePrompt(entry)
    const requestId = permissionRequestId(entry)
    if (prompt === undefined || requestId === undefined) {
      return (
        <article className={css.choiceCard}>
          <strong>权限请求</strong>
          <p>{entry.text}</p>
        </article>
      )
    }
    return (
      <ChoiceCard
        prompt={prompt}
        pending={permissionPending}
        onSubmit={(outcome) => { onPermission(requestId, outcome) }}
      />
    )
  }
  if (entry.role === 'user') {
    return (
      <article className={css.userTurn}>
        <div className={css.userBubble}>
          <span className={css.entryTimestamp} title={entry.createdAt}>
            {formatEntryTime(entry.createdAt)}
          </span>
          <MessageText text={entry.text} />
        </div>
        <div className={css.messageActions}>
          <CopyIconButton text={entry.text} label="复制" />
          <button
            type="button"
            className={css.messageAction}
            aria-label="重新发送"
            title="重新发送"
            disabled={resendDisabled || entry.text.trim() === ''}
            onClick={() => { onResend?.(entry.text) }}
          >
            <IconRefreshOutline16 />
          </button>
        </div>
      </article>
    )
  }
  if (entry.role === 'assistant') {
    if (entry.kind === 'reasoning') return <ReasoningNode entry={entry} active={active} />
    return (
      <article className={css.assistantMessage}>
        <span className={css.entryTimestamp} title={entry.createdAt}>
          {formatEntryTime(entry.createdAt)}
        </span>
        <MarkdownText text={entry.text} streaming={active} />
        <div className={css.messageActions}>
          <CopyIconButton text={entry.text} label="复制全文" />
        </div>
      </article>
    )
  }
  return <div className={css.statusRow}>{entry.text}</div>
}

function ConversationActivity({ stage, action }: {
  stage: ConversationStage
  action?: { readonly label: string; readonly pendingLabel?: string; readonly pending?: boolean; readonly onClick: () => void }
}) {
  if (!stage.visible) return null
  return (
    <div className={css.conversationActivity} data-state={stage.state} role="status" aria-live="polite">
      <StateDot state={stage.state} />
      <div>
        <strong>{stage.label}</strong>
        <p>{stage.detail}</p>
        {action !== undefined && (
          <div className={css.activityActions}>
            <Button size="sm" variant="outline" disabled={action.pending === true} onClick={action.onClick}>
              {action.pending === true ? (action.pendingLabel ?? '重连中…') : action.label}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function OperationProgress({ operation }: { operation: RemoteOperationView }) {
  const state = operation.status === 'failed' ? 'error'
    : operation.status === 'succeeded' ? 'done' : 'ongoing'
  return (
    <div className={css.operationProgress} data-status={operation.status} role="status" aria-live="polite">
      <StateDot state={state} />
      <div>
        <strong>{operation.title}</strong>
        <p>{operation.detail}</p>
        {operation.current !== undefined && operation.total !== undefined && (
          <progress value={operation.current} max={operation.total} aria-label={`${operation.title}进度`} />
        )}
      </div>
    </div>
  )
}

/** Failed-reopen banner: real reason plus user-confirmed repair buttons. */
function ReopenFailureBanner({ issue, busy, restartArmed, enabled, onRetry, onAdopt, onRestartClick, onOpenHostSettings }: {
  issue: ReopenFailureIssue
  busy: 'adopt' | 'restart' | undefined
  restartArmed: boolean
  enabled: boolean
  onRetry: () => void
  onAdopt: () => void
  onRestartClick: () => void
  onOpenHostSettings: () => void
}) {
  return (
    <div className={css.conversationActivity} data-state="error" role="status" aria-live="polite">
      <StateDot state="error" />
      <div>
        <strong>在当前会话重开失败</strong>
        <p>{issue.reason}</p>
        <div className={css.activityActions}>
          {issue.fix === 'grok-serve' && (
            <>
              <Button size="sm" variant="outline" disabled={!enabled || busy !== undefined} onClick={onAdopt}>
                {busy === 'adopt' ? '接管中…' : '接管现有 Grok 服务并重试'}
              </Button>
              <Button size="sm" variant="outline" disabled={!enabled || busy !== undefined} onClick={onRestartClick}>
                {busy === 'restart'
                  ? '重启中…'
                  : restartArmed
                    ? '再次点击确认：重启会中断该主机正在运行的 Grok 会话'
                    : '重启 Grok 服务'}
              </Button>
            </>
          )}
          {issue.fix === 'agent-missing' && (
            <Button size="sm" variant="outline" disabled={!enabled} onClick={onOpenHostSettings}>
              去主机设置安装/登录
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!enabled || busy !== undefined} onClick={onRetry}>
            重试重开
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Long-idle running turn: Agent stopped producing frames. Offer a
 *  user-confirmed "end process and reopen" plus the normal stop action. */
function UnresponsiveAgentBanner({ idleMinutes, armed, busy, enabled, onStop, onArmRestart }: {
  idleMinutes: number
  armed: boolean
  busy: boolean
  enabled: boolean
  onStop: () => void
  onArmRestart: () => void
}) {
  return (
    <div className={css.conversationActivity} data-state="warning" role="status" aria-live="polite">
      <StateDot state="warning" />
      <div>
        <strong>Agent 长时间没有响应</strong>
        <p>
          已约 {idleMinutes} 分钟没有任何新内容。可能仍在后台工作，也可以先「停止」；
          若确认进程卡住，可以结束它的进程并在当前会话重新打开，对话记录会保留。
        </p>
        <div className={css.activityActions}>
          <Button size="sm" variant="outline" disabled={!enabled || busy} onClick={onStop}>
            停止本轮
          </Button>
          <Button size="sm" variant="outline" disabled={!enabled || busy} onClick={onArmRestart}>
            {busy
              ? '结束并重开中…'
              : armed
                ? '再次点击确认：将结束 Agent 进程并在当前会话重开'
                : '结束进程并重开'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function useActivityClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [active])
  return now
}

function PanelShell({ title, subtitle, children, onClose }: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <main className={css.operationSurface}>
      <section className={css.operationPanel}>
        <header className={css.operationHeader}>
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </header>
        {children}
      </section>
    </main>
  )
}

function parseOptionalPort(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const port = Number(value)
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

function sshInput(target: string, portText: string, user: string, identityFile: string, proxyJump: string): Omit<RemoteSshConfig, 'hostKeyFingerprint'> {
  const port = parseOptionalPort(portText)
  return {
    target,
    ...(port === undefined ? {} : { port }),
    ...(user.trim() === '' ? {} : { user: user.trim() }),
    ...(identityFile.trim() === '' ? {} : { identityFile: identityFile.trim() }),
    ...(proxyJump.trim() === '' ? {} : { proxyJump: proxyJump.trim() }),
  }
}

function HostPanel({ host, store, operations, onClose, artifactVersion }: {
  host?: RemoteHostView
  store: RemoteAgentStore
  operations: readonly RemoteOperationView[]
  onClose: () => void
  artifactVersion: string | undefined
}) {
  const [hostTitle, setHostTitle] = useState(host?.title ?? '')
  const [endpoint, setEndpoint] = useState(host?.endpoint ?? 'http://127.0.0.1:3091')
  const [hostMode, setHostMode] = useState<'ssh' | 'endpoint'>(host?.ssh === undefined && host !== undefined ? 'endpoint' : 'ssh')
  const [sshTarget, setSshTarget] = useState(host?.ssh?.target ?? '')
  const [sshPort, setSshPort] = useState(host?.ssh?.port === undefined ? '' : String(host.ssh.port))
  const [sshUser, setSshUser] = useState(host?.ssh?.user ?? '')
  const [identityFile, setIdentityFile] = useState(host?.ssh?.identityFile ?? '')
  const [proxyJump, setProxyJump] = useState(host?.ssh?.proxyJump ?? '')
  const [sshInspection, setSshInspection] = useState<RemoteSshInspection>()
  const [localError, setLocalError] = useState('')
  const [success, setSuccess] = useState('')
  const [operationId, setOperationId] = useState<string>()
  const [busy, setBusy] = useState<'inspect' | 'deploy' | 'save-title' | 'save-host' | 'connect'>()
  const deploymentState = host === undefined ? 'checking' : hostDeployment(host, artifactVersion)
  const [connectionOpen, setConnectionOpen] = useState(
    host === undefined || deploymentState === 'outdated' || deploymentState === 'missing',
  )
  const ipLabel = host === undefined ? '' : hostIpLabel(host)
  const statusLabel = host === undefined ? '' : hostConnectionLabel(host, artifactVersion)
  const live = host !== undefined && host.inventoryError === undefined
  const versionLabel = live ? host.inventory?.hostdVersion : undefined
  const artifactLabel = artifactVersion === undefined || artifactVersion === '' || artifactVersion === 'unknown'
    ? undefined
    : artifactVersion
  const showHostdAction = host !== undefined && canUpgradeHostd(host, artifactVersion)
  const hostdActionLabel = deploymentState === 'outdated' ? '升级 hostd' : '部署 hostd'
  const hostdActionDetail = deploymentState === 'outdated'
    ? `远端 hostd ${versionLabel ?? '未知版本'} 落后于当前 ${artifactLabel ?? 'gateway'}，升级后会重启服务并重建隧道。`
    : 'hostd 未在运行或无法连通。部署会上传当前 ThreadHarbor hostd，并重建本机隧道。'
  const deployOperation = operations.find(operation => operation.operationId === operationId)
    ?? operations.find(operation => operation.kind === 'host-ssh-deploy'
      && operation.hostId === host?.hostId
      && (operation.status === 'queued' || operation.status === 'running'))
  const deploying = deployOperation?.status === 'queued' || deployOperation?.status === 'running'
  const resetInspection = (): void => {
    setSshInspection(undefined)
    setLocalError('')
    setSuccess('')
  }
  const inspect = (): void => {
    setBusy('inspect')
    setLocalError('')
    setSuccess('')
    void store.inspectSsh(sshInput(sshTarget.trim(), sshPort, sshUser, identityFile, proxyJump))
      .then(setSshInspection)
      .catch((error: unknown) => { setLocalError(String(error)) })
      .finally(() => { setBusy(undefined) })
  }
  const connectionMatchesHost = host?.ssh !== undefined
    && hostMode === 'ssh'
    && sshTarget.trim() === host.ssh.target
    && parseOptionalPort(sshPort) === host.ssh.port
    && (sshUser.trim() || undefined) === host.ssh.user
    && (identityFile.trim() || undefined) === host.ssh.identityFile
    && (proxyJump.trim() || undefined) === host.ssh.proxyJump
  const deploy = (): void => {
    const fingerprint = sshInspection?.hostKeyFingerprint
      ?? (connectionMatchesHost ? host.ssh?.hostKeyFingerprint : undefined)
    if (fingerprint === undefined) return
    setBusy('deploy')
    const approved = {
      ...sshInput(sshTarget.trim(), sshPort, sshUser, identityFile, proxyJump),
      hostKeyFingerprint: fingerprint,
    }
    setLocalError('')
    setSuccess('')
    const task = host === undefined
      ? store.deploySshHost(hostTitle.trim(), approved)
      : store.updateSshHost(host.hostId, hostTitle.trim(), approved)
    void task
      .then((operation) => { setOperationId(operation.operationId) })
      .catch((error: unknown) => { setLocalError(String(error)) })
      .finally(() => { setBusy(undefined) })
  }
  const addSsh = (): void => {
    setBusy('deploy')
    setLocalError('')
    setSuccess('')
    // Confirm = add. Connectivity and deploy run in the background afterwards
    // (trust-on-first-use), so a failed deploy never blocks the add — the host
    // lands in the sidebar and can be retried from its settings.
    void store.addSshHost(hostTitle.trim(), sshInput(sshTarget.trim(), sshPort, sshUser, identityFile, proxyJump))
      .then(() => { onClose() })
      .catch((error: unknown) => { setLocalError(String(error)) })
      .finally(() => { setBusy(undefined) })
  }
  const retryDeploy = (): void => {
    if (host === undefined) return
    setBusy('deploy')
    setLocalError('')
    setSuccess('')
    void store.redeploySshHost(host.hostId)
      .then((operation) => { setOperationId(operation.operationId) })
      .catch((error: unknown) => { setLocalError(String(error)) })
      .finally(() => { setBusy(undefined) })
  }
  const reconnect = (): void => {
    if (host === undefined) return
    setBusy('connect')
    setLocalError('')
    setSuccess('')
    void store.reconnectHost(host.hostId)
      .then(() => { setSuccess('已连接到 hostd') })
      .catch((error: unknown) => { setLocalError(describeHostConnectFailure(error)) })
      .finally(() => { setBusy(undefined) })
  }
  const upgradeHostd = (): void => {
    if (host === undefined) return
    setBusy('deploy')
    setLocalError('')
    setSuccess('')
    void store.upgradeHostd(host.hostId)
      .then((operation) => {
        if (operation !== undefined) setOperationId(operation.operationId)
        else setSuccess('已升级并重启本机 hostd')
      })
      .catch((error: unknown) => { setLocalError(String(error)) })
      .finally(() => { setBusy(undefined) })
  }
  const saveTitle = (): void => {
    if (host === undefined) return
    setBusy('save-title')
    setLocalError('')
    setSuccess('')
    void store.updateHostTitle(host.hostId, hostTitle.trim())
      .then(() => { setSuccess(`已保存主机名称：${hostTitle.trim()}`) })
      .catch((error: unknown) => { setLocalError(String(error)) })
      .finally(() => { setBusy(undefined) })
  }
  return (
    <PanelShell
      title={host === undefined ? '添加主机' : '主机设置'}
      subtitle={host === undefined ? '为每台主机设置可辨认的名称，再选择已有 hostd 地址或 SSH 自动部署。' : `编辑 ${host.title} 的名称与连接方式。`}
      onClose={onClose}
    >
      <section id={host === undefined ? undefined : `host-panel-${host.hostId}`} className={css.connectionSection} data-open={connectionOpen || undefined}>
        {host !== undefined && (
          <button type="button" className={css.connectionHeader} aria-expanded={connectionOpen} onClick={() => { setConnectionOpen(value => !value) }}>
            <span className={css.agentRowChevron} aria-hidden="true">
              {connectionOpen ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
            </span>
            <span>
              <strong>{host.title}</strong>
              <small>
                {ipLabel || (hostMode === 'ssh' ? (sshTarget.trim() || 'SSH 自动部署') : (endpoint.trim() || '已有 hostd 地址'))}
                {statusLabel === '' ? '' : ` · ${statusLabel}`}
                {versionLabel === undefined ? '' : ` · hostd ${versionLabel}`}
              </small>
            </span>
          </button>
        )}
        {connectionOpen && (
          <div className={css.formGrid}>
            <label>
              <span>主机名称</span>
              <input value={hostTitle} placeholder="例如：工作室 Mac" onChange={(event) => { setHostTitle(event.target.value) }} />
            </label>
            <label>
              <span>连接方式</span>
              <select value={hostMode} onChange={(event) => {
                const nextMode = event.target.value as 'ssh' | 'endpoint'
                setHostMode(nextMode)
                if (nextMode === 'endpoint' && host?.ssh !== undefined && endpoint === host.endpoint) {
                  setEndpoint('http://127.0.0.1:3091')
                }
                resetInspection()
              }}>
                <option value="ssh">SSH 自动部署</option>
                <option value="endpoint">已有 hostd 地址</option>
              </select>
            </label>
            {hostMode === 'endpoint' ? (
              <>
                <label className={css.fullWidth}>
                  <span>hostd 地址</span>
                  <input value={endpoint} placeholder="http://127.0.0.1:3091" onChange={(event) => { setEndpoint(event.target.value) }} />
                </label>
                <div className={css.panelActions}>
                  <Button size="sm" variant="primary" disabled={busy !== undefined || hostTitle.trim() === '' || endpoint.trim() === ''} onClick={() => {
                    setBusy('save-host')
                    setLocalError('')
                    setSuccess('')
                    const task = host === undefined
                      ? store.addHost(hostTitle.trim(), endpoint.trim())
                      : store.updateHost(host.hostId, hostTitle.trim(), endpoint.trim())
                    void task
                      .then(() => { setSuccess(host === undefined ? `已添加 ${hostTitle.trim()}` : `已保存 ${hostTitle.trim()}`) })
                      .catch((error: unknown) => { setLocalError(String(error)) })
                      .finally(() => { setBusy(undefined) })
                  }}>{busy === 'save-host' ? (host === undefined ? '连接中…' : '保存中…') : '确认'}</Button>
                </div>
                {host !== undefined && (
                  <div className={`${css.setupCard} ${css.fullWidth}`}>
                    <strong>hostd 状态：{statusLabel}</strong>
                    <p>
                      {live && deploymentState === 'deployed'
                        ? `远端 hostd 正在运行${versionLabel === undefined ? '' : `（${versionLabel}）`}，与当前版本一致。`
                        : live && deploymentState === 'outdated'
                          ? host.ssh === undefined
                            ? `本机 hostd ${versionLabel ?? '未知版本'} 落后于当前 ${artifactLabel ?? 'gateway'}。升级会用当前制品重启本机进程，会话 hold 会按设计继续存活。`
                            : hostdActionDetail
                          : '当前连不上 hostd。请先点连接再探测；失败后会显示原因。'}
                    </p>
                    {host.inventoryError !== undefined && (
                      <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={reconnect}>
                        {busy === 'connect' ? '连接中…' : '连接'}
                      </Button>
                    )}
                    {showHostdAction && (
                      <Button size="sm" variant="outline" disabled={busy !== undefined || deploying || hostTitle.trim() === ''} onClick={upgradeHostd}>
                        {busy === 'deploy' || deploying ? '部署中…' : hostdActionLabel}
                      </Button>
                    )}
                    {deployOperation !== undefined && <OperationProgress operation={deployOperation} />}
                  </div>
                )}
              </>
            ) : (
              <>
                <label className={css.fullWidth}>
                  <span>SSH 主机</span>
                  <input value={sshTarget} placeholder="us-box 或 host.example.com" onChange={(event) => { setSshTarget(event.target.value); resetInspection() }} />
                </label>
                <label>
                  <span>SSH 用户</span>
                  <input value={sshUser} placeholder="留空则使用 ssh config" onChange={(event) => { setSshUser(event.target.value); resetInspection() }} />
                </label>
                <label>
                  <span>SSH 端口</span>
                  <input value={sshPort} inputMode="numeric" placeholder="留空或 22" onChange={(event) => { setSshPort(event.target.value); resetInspection() }} />
                </label>
                <label className={css.fullWidth}>
                  <span>SSH 私钥路径</span>
                  <input value={identityFile} placeholder="Web 服务主机上的绝对路径，可选" onChange={(event) => { setIdentityFile(event.target.value); resetInspection() }} />
                </label>
                <label className={css.fullWidth}>
                  <span>ProxyJump</span>
                  <input value={proxyJump} placeholder="可选，例如 bastion" onChange={(event) => { setProxyJump(event.target.value); resetInspection() }} />
                </label>
                <div className={css.panelActions}>
                  {host !== undefined && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== undefined || hostTitle.trim() === '' || hostTitle.trim() === host.title}
                      onClick={saveTitle}
                    >{busy === 'save-title' ? '保存中…' : '保存名称'}</Button>
                  )}
                  {host === undefined ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== undefined || sshTarget.trim() === '' || hostTitle.trim() === ''}
                      onClick={addSsh}
                    >{busy === 'deploy' ? '添加中…' : '确认'}</Button>
                  ) : (!connectionMatchesHost && (
                    <Button size="sm" variant="outline" disabled={busy !== undefined || sshTarget.trim() === ''} onClick={inspect}>{busy === 'inspect' ? '检查中…' : '1. 检查主机密钥'}</Button>
                  ))}
                </div>
                {host !== undefined && connectionMatchesHost && sshInspection === undefined && (
                  host.deployState === 'failed' && !deploying ? (
                    <div className={`${css.setupCard} ${css.fullWidth}`}>
                      <strong>部署失败</strong>
                      <p>{host.deployError ?? '上次部署未成功。请检查主机连接和远端服务日志后重试。'}</p>
                      <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={retryDeploy}>
                        {busy === 'deploy' ? '部署中…' : '重试部署'}
                      </Button>
                    </div>
                  ) : host.deployState === 'pending' || host.deployState === 'deploying' || deploying ? (
                    <div className={`${css.setupCard} ${css.fullWidth}`}>
                      <strong>正在后台部署 hostd…</strong>
                      <p>已加入主机列表，正在验证连接并上传启动远端 hostd。部署完成后即可使用。</p>
                    </div>
                  ) : (
                    <div className={`${css.setupCard} ${css.fullWidth}`}>
                      <strong>hostd 状态：{statusLabel}</strong>
                      <p>
                        {live && deploymentState === 'deployed'
                          ? `远端 hostd 正在运行${versionLabel === undefined ? '' : `（${versionLabel}）`}，与当前版本一致。`
                          : live && deploymentState === 'outdated'
                            ? hostdActionDetail
                            : host.inventoryError !== undefined
                              ? '当前连不上 hostd。请先点连接再探测；失败后会显示原因。'
                              : hostdActionDetail}
                      </p>
                      {host.inventoryError !== undefined && (
                        <Button size="sm" variant="outline" disabled={busy !== undefined || deploying} onClick={reconnect}>
                          {busy === 'connect' ? '连接中…' : '连接'}
                        </Button>
                      )}
                      {showHostdAction && (
                        <Button size="sm" variant="outline" disabled={busy !== undefined || deploying || hostTitle.trim() === ''} onClick={upgradeHostd}>
                          {busy === 'deploy' || deploying ? '部署中…' : hostdActionLabel}
                        </Button>
                      )}
                    </div>
                  )
                )}
                {sshInspection !== undefined && (
                  <div className={`${css.setupCard} ${css.fullWidth}`}>
                    <strong>检查结果：请确认 SSH 主机密钥</strong>
                    <p>目标：{sshInspection.target}</p>
                    <code>{sshInspection.algorithm} {sshInspection.hostKeyFingerprint}</code>
                    <p>确认后会上传并启动远端 threadharbor-hostd，同时建立本机 loopback tunnel。</p>
                    <Button size="sm" variant="primary" disabled={busy !== undefined || deploying || hostTitle.trim() === ''} onClick={deploy}>
                      {busy === 'deploy' || deploying ? '部署中…' : '确认'}
                    </Button>
                  </div>
                )}
                {deployOperation !== undefined && <div className={css.fullWidth}><OperationProgress operation={deployOperation} /></div>}
              </>
            )}
            {localError !== '' && <p className={`${css.error} ${css.fullWidth}`}>{localError}</p>}
            {success !== '' && <p className={`${css.success} ${css.fullWidth}`}>{success}</p>}
          </div>
        )}
      </section>
      {host !== undefined && (
        <section className={css.settingsSection}>
          <header className={css.settingsSectionHeader}>
            <h2>Agent</h2>
            <p>查看、部署、登录或编辑这台主机上的 Agent。</p>
          </header>
          <AgentSetupPanel host={host} store={store} operations={operations} embedded />
        </section>
      )}
    </PanelShell>
  )
}

function AddProjectPanel({ store, hosts, initialHostId, onClose }: {
  store: RemoteAgentStore
  hosts: readonly RemoteHostView[]
  initialHostId: string | undefined
  onClose: () => void
}) {
  const [projectHost, setProjectHost] = useState(initialHostId ?? hosts[0]?.hostId ?? '')
  const [projectTitle, setProjectTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const [listing, setListing] = useState<RemoteDirectoryListing>()
  const [localError, setLocalError] = useState('')
  const [success, setSuccess] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [creating, setCreating] = useState(false)
  const browseSerialRef = useRef(0)
  const browse = (path: string, hostId = projectHost): void => {
    if (hostId === '') return
    const serial = ++browseSerialRef.current
    setBrowsing(true)
    setLocalError('')
    setSuccess('')
    void store.listDirectory(RemoteHostId(hostId), path)
      .then((value) => {
        if (serial !== browseSerialRef.current) return
        setListing(value)
        setCwd(value.path)
      })
      .catch((error: unknown) => {
        if (serial === browseSerialRef.current) setLocalError(String(error))
      })
      .finally(() => {
        if (serial === browseSerialRef.current) setBrowsing(false)
      })
  }
  useEffect(() => {
    if (projectHost === '') return
    setListing(undefined)
    setCwd('')
    setLocalError('')
    browse('', projectHost)
    return () => { browseSerialRef.current += 1 }
  }, [projectHost, store])
  return (
    <PanelShell title="添加项目" subtitle="项目目录是目标主机上的绝对路径；可先浏览远端目录再登记。" onClose={onClose}>
      <div className={css.formGrid}>
        <label>
          <span>目标主机</span>
          <select value={projectHost} onChange={(event) => {
            setProjectHost(event.target.value)
          }}>
            <option value="">选择主机</option>
            {hosts.map(host => <option key={host.hostId} value={host.hostId}>{host.title}</option>)}
          </select>
        </label>
        <label>
          <span>项目名称</span>
          <input value={projectTitle} placeholder="默认使用目录名" onChange={(event) => { setProjectTitle(event.target.value) }} />
        </label>
        <label className={css.fullWidth}>
          <span>远端目录</span>
          <input value={cwd} placeholder="/path/to/project" onChange={(event) => { setCwd(event.target.value) }} />
        </label>
        <div className={css.panelActions}>
          <Button size="sm" variant="outline" disabled={projectHost === '' || browsing} onClick={() => { browse(cwd) }}>{browsing ? '浏览中…' : '浏览目录'}</Button>
          <Button size="sm" variant="primary" disabled={projectHost === '' || cwd.trim() === '' || creating} onClick={() => {
            const title = projectTitle.trim() || cwd.split('/').filter(Boolean).at(-1) || cwd
            setCreating(true)
            setLocalError('')
            setSuccess('')
            void store.createProject(RemoteHostId(projectHost), title, cwd.trim())
              .then(() => { setSuccess(`已登记项目 ${title}`) })
              .catch((error: unknown) => { setLocalError(String(error)) })
              .finally(() => { setCreating(false) })
          }}>{creating ? '登记中…' : '登记项目'}</Button>
        </div>
        {listing !== undefined && (
          <div className={`${css.directoryList} ${css.fullWidth}`}>
            {listing.parent !== undefined && <button type="button" disabled={browsing} onClick={() => { browse(listing.parent ?? listing.path) }}>..</button>}
            {browsableDirectories(listing.entries).map(entry => (
              <button key={entry.path} type="button" disabled={browsing} onClick={() => { browse(entry.path) }}>{entry.name}/</button>
            ))}
            {browsing && <p className={css.muted} role="status">正在读取远端目录…</p>}
            {listing.truncated && <p className={css.muted}>结果已截断，请输入更具体的路径。</p>}
          </div>
        )}
        {localError !== '' && <p className={`${css.error} ${css.fullWidth}`}>{localError}</p>}
        {success !== '' && <p className={`${css.success} ${css.fullWidth}`}>{success}</p>}
      </div>
    </PanelShell>
  )
}

function availableBackends(host: RemoteHostView): RemoteAgentBackend[] {
  return BACKEND_ORDER.filter((backend) => {
    const entry = host.inventory?.backends.find(candidate => candidate.backend === backend)
    return entry !== undefined && isRemoteBackendSessionReady(entry)
  })
}

type SessionOptionKey = 'permissionMode' | 'collaborationMode' | 'model' | 'thinking' | 'acceleration' | 'approvalChoice'
type SessionPreferences = Record<SessionOptionKey, string>

interface SessionOptionSpec {
  readonly key: SessionOptionKey
  readonly label: string
  readonly title: string
  readonly options: readonly { readonly value: string; readonly label: string }[]
}

const SESSION_OPTION_SPECS: Record<RemoteAgentBackend, readonly SessionOptionSpec[]> = {
  codex: [
    {
      key: 'permissionMode', label: '权限', title: '权限模式',
      options: [
        { value: 'ask', label: '询问' },
        { value: 'read-only', label: '只读' },
        { value: 'workspace-write', label: '工作区' },
        { value: 'full-access', label: '完全访问' },
      ],
    },
    {
      key: 'collaborationMode', label: '协作', title: '协作模式',
      options: [{ value: 'default', label: '默认' }, { value: 'plan', label: '计划' }],
    },
    {
      key: 'model', label: '模型', title: '模型',
      options: [
        { value: 'default', label: '默认' },
        { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
        { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
        { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
        { value: 'gpt-5.5', label: 'gpt-5.5' },
        { value: 'gpt-5.4', label: 'gpt-5.4' },
      ],
    },
    {
      key: 'thinking', label: '思考', title: '思考强度',
      options: [
        { value: 'auto', label: '自动' },
        { value: 'none', label: '无' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'xhigh', label: '极高' },
        { value: 'max', label: '最大' },
      ],
    },
    {
      key: 'acceleration', label: '加速', title: '加速',
      options: [{ value: 'standard', label: '标准' }, { value: 'fast', label: '快速' }],
    },
    {
      key: 'approvalChoice', label: '批准', title: '批准选择',
      options: [{ value: 'ask', label: '每次询问' }, { value: 'on-failure', label: '失败时询问' }, { value: 'auto', label: '自动批准' }],
    },
  ],
  claude: [
    {
      key: 'permissionMode', label: '权限', title: '权限模式',
      options: [{ value: 'ask', label: '询问' }, { value: 'edit', label: '可编辑' }, { value: 'bypass', label: '跳过确认' }],
    },
    {
      key: 'collaborationMode', label: '协作', title: '协作模式',
      options: [{ value: 'default', label: '默认' }, { value: 'plan', label: '计划' }],
    },
    {
      key: 'model', label: '模型', title: '模型',
      options: [
        { value: 'default', label: '默认' },
        { value: 'sonnet', label: 'sonnet' },
        { value: 'opus', label: 'opus' },
        { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
        { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
        { value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5' },
        { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5' },
      ],
    },
    {
      key: 'thinking', label: '思考', title: '思考',
      options: [{ value: 'auto', label: '自动' }, { value: 'on', label: '开启' }, { value: 'off', label: '关闭' }],
    },
    {
      key: 'approvalChoice', label: '批准', title: '批准选择',
      options: [{ value: 'ask', label: '每次询问' }, { value: 'trusted', label: '信任编辑' }, { value: 'auto', label: '自动批准' }],
    },
  ],
  grok: [
    {
      key: 'permissionMode', label: '权限', title: '权限模式',
      options: [{ value: 'ask', label: '询问' }, { value: 'workspace-write', label: '工作区' }],
    },
    {
      key: 'model', label: '模型', title: '模型',
      options: [
        { value: 'default', label: '默认' },
        { value: 'grok-build', label: 'grok-build' },
        { value: 'grok-build-0.1', label: 'grok-build-0.1' },
        { value: 'grok-4.6', label: 'grok-4.6' },
      ],
    },
    {
      key: 'thinking', label: '思考', title: '思考',
      options: [{ value: 'auto', label: '自动' }, { value: 'none', label: '无' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }],
    },
    {
      key: 'acceleration', label: '加速', title: '加速',
      options: [{ value: 'standard', label: '标准' }, { value: 'fast', label: '快速' }],
    },
    {
      key: 'approvalChoice', label: '批准', title: '批准选择',
      options: [{ value: 'ask', label: '每次询问' }, { value: 'auto', label: '自动批准' }],
    },
  ],
  dsh: [
    {
      key: 'model', label: '模型', title: '模型',
      options: [{ value: 'default', label: '默认' }, { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }, { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }],
    },
    {
      key: 'thinking', label: '思考', title: '思考',
      options: [{ value: 'auto', label: '自动' }, { value: 'off', label: '关闭' }, { value: 'max', label: '最大' }],
    },
    {
      key: 'acceleration', label: '加速', title: '加速',
      options: [{ value: 'standard', label: '标准' }, { value: 'fast', label: '快速' }],
    },
  ],
}

function defaultSessionPreferences(backend: RemoteAgentBackend): SessionPreferences {
  const values: SessionPreferences = {
    permissionMode: 'default',
    collaborationMode: 'default',
    model: 'default',
    thinking: 'auto',
    acceleration: 'standard',
    approvalChoice: 'ask',
  }
  for (const spec of SESSION_OPTION_SPECS[backend]) values[spec.key] = spec.options[0]?.value ?? values[spec.key]
  return values
}

function normalizeSessionPreferences(backend: RemoteAgentBackend, current: SessionPreferences): SessionPreferences {
  const next = { ...current }
  for (const spec of SESSION_OPTION_SPECS[backend]) {
    if (!spec.options.some(option => option.value === next[spec.key])) next[spec.key] = spec.options[0]?.value ?? 'default'
  }
  return next
}

const SESSION_PREFERENCES_STORAGE_KEY = 'dsh.remote-agent.session-preferences'

/** Hard ceiling on how long "立即清理过期会话" can leave the panel on
 *  "清理中…". The store already caps a single sweep at 60 s; this outer
 *  guard catches whatever the sweep budget missed. */
const ARCHIVE_TIMEOUT_MS = 90_000

function readPersistedSessionPreferences(): Record<string, SessionPreferences> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(SESSION_PREFERENCES_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, SessionPreferences>
  } catch {
    return {}
  }
}

function writePersistedSessionPreferences(map: Record<string, SessionPreferences>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_PREFERENCES_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / disabled storage
  }
}

/** Last observed scroll position for a remote session. */
import type { TranscriptScrollMemory } from './transcript-scroll-memory.ts'
import { readTranscriptScrollMemory, writeTranscriptScrollMemory } from './transcript-scroll-memory.ts'
export type { TranscriptScrollMemory } from './transcript-scroll-memory.ts'

function sessionPreferencesKey(hostId: string, backend: RemoteAgentBackend): string {
  return `${hostId}-${backend}`
}

function resolveSessionPreferences(
  backend: RemoteAgentBackend,
  memory: Record<string, SessionPreferences>,
  sessionId?: string,
  hostId?: string,
): SessionPreferences {
  const stored = { ...readPersistedSessionPreferences(), ...memory }
  const fromSession = sessionId === undefined ? undefined : stored[sessionId]
  const fromHost = hostId === undefined ? undefined : stored[sessionPreferencesKey(hostId, backend)]
  return normalizeSessionPreferences(backend, fromSession ?? fromHost ?? defaultSessionPreferences(backend))
}

function SessionControls({ backend, preferences, disabled, onChange }: {
  backend: RemoteAgentBackend
  preferences: SessionPreferences
  disabled?: boolean
  onChange: (preferences: SessionPreferences) => void
}) {
  const specs = SESSION_OPTION_SPECS[backend]
  if (specs.length === 0) return null
  return (
    <div className={css.sessionControls} aria-label={`${backend} 会话选项`}>
      <span className={css.sessionControlsIcon} title="会话选项"><IconEnhanceOutline16 /></span>
      {specs.map(spec => (
        <label key={spec.key} className={css.sessionControl} title={spec.title}>
          <span>{spec.label}</span>
          <select
            value={preferences[spec.key]}
            disabled={disabled}
            onChange={(event) => { onChange({ ...preferences, [spec.key]: event.target.value }) }}
          >
            {spec.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      ))}
    </div>
  )
}

/** Host settings “Agent” section. One row per backend (dsh, grok, codex,
 *  claude), each rendered by its own `AgentSetupRow` so expand/collapse and
 *  all transient payloads (deploy plan, install progress, config editor,
 *  login flow, DSH key form, errors) stay independent: opening or closing one
 *  Agent — or deploying it — never collapses another row or resets what it
 *  shows. */
function AgentSetupPanel({ host, store, operations = [], onClose, embedded = false }: {
  host: RemoteHostView
  store: RemoteAgentStore
  operations?: readonly RemoteOperationView[]
  onClose?: () => void
  embedded?: boolean
}) {
  useEffect(() => {
    void store.refreshInventory(host.hostId).catch(() => undefined)
  }, [host.hostId, store])
  const content = (
    <div className={css.agentSetupWide}>
      {BACKEND_ORDER.map(backend => (
        <AgentSetupRow key={backend} backend={backend} host={host} store={store} operations={operations} />
      ))}
    </div>
  )
  if (embedded) return content
  return <PanelShell title={`管理 ${host.title} 的 Agent`} subtitle={host.endpoint ?? host.ssh?.target ?? ''} onClose={onClose ?? (() => undefined)}>{content}</PanelShell>
}

/** One expandable Agent row inside `AgentSetupPanel`. Every piece of transient
 *  UI state for that backend lives in this component — expansion, deployment
 *  plan, install operation id and progress, config editor, login flow, DSH key
 *  form, busy flags and errors — so a sibling Agent row can never observe or
 *  overwrite it. Collapsing keeps the state, so reopening the same row resumes
 *  where the user left off while other rows stay untouched. */
function AgentSetupRow({ backend, host, store, operations }: {
  backend: RemoteAgentBackend
  host: RemoteHostView
  store: RemoteAgentStore
  operations: readonly RemoteOperationView[]
}) {
  const [open, setOpen] = useState(false)
  const [auth, setAuth] = useState<RemoteAuthChallenge>()
  const [config, setConfig] = useState<RemoteAgentConfigDocument>()
  const [configContent, setConfigContent] = useState('')
  const [configOpen, setConfigOpen] = useState(true)
  const [configSaved, setConfigSaved] = useState(false)
  const [dshInitialized, setDshInitialized] = useState(false)
  const [dshApiKey, setDshApiKey] = useState('')
  const [dshSaved, setDshSaved] = useState(false)
  const [dshEditing, setDshEditing] = useState(false)
  const [plan, setPlan] = useState<RemoteInstallPlan>()
  const [operationId, setOperationId] = useState<string>()
  const [response, setResponse] = useState('')
  const [localError, setLocalError] = useState('')
  const [busyAction, setBusyAction] = useState<string>()
  const busy = busyAction !== undefined
  const tracked = async <T,>(action: string, work: () => Promise<T>): Promise<T> => {
    setBusyAction(action)
    try {
      return await work()
    } finally {
      setBusyAction(current => current === action ? undefined : current)
    }
  }
  const entry = host.inventory?.backends.find(candidate => candidate.backend === backend)
  const deployOperation = operations.find(operation => operation.operationId === operationId && operation.backend === backend)
    ?? operations.find(operation => operation.kind === 'agent-install'
      && operation.hostId === host.hostId
      && operation.backend === backend
      && (operation.status === 'queued' || operation.status === 'running'))
  const deploying = deployOperation?.status === 'queued' || deployOperation?.status === 'running'
  const statusText = entry?.detail
    ?? (!entry?.installed
      ? '未安装'
      : backend === 'claude'
        ? '已安装，可通过配置提供凭据'
        : backend === 'dsh'
          ? entry.authenticated ? '已安装，API Key 已配置' : '已安装，未配置 API Key'
          : entry.authenticated ? '已安装并已认证' : '已安装，未登录')

  // Once the install operation started by this row succeeds, drop the plan
  // card and pull a fresh inventory so the row header reflects the change.
  // The ref keeps the refresh one-shot: the finished operation stays in the
  // gateway operation list, and without the guard every later snapshot change
  // would restart the inventory refresh.
  const settledOperationRef = useRef<string>()
  useEffect(() => {
    if (operationId === undefined) return
    const finished = operations.find(operation => operation.operationId === operationId)
    if (finished === undefined || finished.status !== 'succeeded') return
    if (settledOperationRef.current === operationId) return
    settledOperationRef.current = operationId
    setPlan(undefined)
    void store.refreshInventory(host.hostId).catch(() => undefined)
  }, [operations, operationId, host.hostId, store])

  // Poll the device/browser login flow started from this row until it settles.
  useEffect(() => {
    if (auth === undefined || !['starting', 'waiting-user'].includes(auth.status)) return
    const timer = window.setTimeout(() => {
      void store.authStatus(host.hostId, auth.flowId).then((next) => {
        setAuth(next)
        if (next.status === 'succeeded') void store.refreshInventory(host.hostId).catch(() => undefined)
      }).catch((error: unknown) => { setLocalError(String(error)) })
    }, 1000)
    return () => { window.clearTimeout(timer) }
  }, [auth, host.hostId, store])

  const toggle = (): void => {
    setLocalError('')
    if (open) {
      // Collapsing only affects this row; the transient state is kept so
      // reopening resumes here without disturbing the sibling rows.
      setOpen(false)
      return
    }
    setOpen(true)
    if (entry?.installed !== true) return
    if (backend === 'dsh') {
      if (!dshInitialized) {
        setDshInitialized(true)
        setDshApiKey('')
        setDshSaved(entry?.authenticated === true)
        setDshEditing(entry?.authenticated !== true)
      }
      return
    }
    if (config === undefined) configure()
  }
  const login = (): void => {
    setOpen(true)
    setConfig(undefined)
    setLocalError('')
    void tracked('login', () => store.startAuth(host.hostId, backend)).then(setAuth)
      .catch((error: unknown) => { setLocalError(String(error)) })
  }
  const configure = (): void => {
    setOpen(true)
    setAuth(undefined)
    setConfigSaved(false)
    setConfigOpen(true)
    setLocalError('')
    // Only grok/codex/claude reach configure; dsh is handled separately above.
    void tracked('config-load', () => store.readAgentConfig(host.hostId, backend as RemoteAgentConfigBackend)).then((document) => {
      setConfig(document)
      setConfigContent(document.content)
    }).catch((error: unknown) => { setLocalError(String(error)) })
  }
  const loadPlan = (): void => {
    setOpen(true)
    setAuth(undefined)
    setConfig(undefined)
    setLocalError('')
    void tracked('plan', () => store.installPlan(host.hostId, backend)).then(setPlan)
      .catch((error: unknown) => { setLocalError(describeAgentInstallFailure(error)) })
  }
  const deployAgent = (component: RemoteAgentBackend): void => {
    setLocalError('')
    void tracked('install-start', () => store.installAgent(host.hostId, component)).then((operation) => {
      setOperationId(operation.operationId)
    }).catch((error: unknown) => { setLocalError(describeAgentInstallFailure(error)) })
  }
  return (
    <div className={css.agentRowWide} data-open={open || undefined}>
      <div className={css.agentRowHeader}>
        <button type="button" className={css.agentRowToggle} onClick={toggle}>
          <span className={css.agentRowChevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
          <span>
            <strong><StateDot state={backendInventoryState(host, backend)} />{backend}</strong>
            <p>{statusText}</p>
          </span>
        </button>
        <div className={css.panelActions}>
          {entry !== undefined && entry.installed !== true && (
            <Button size="sm" variant="outline" disabled={busy || deploying} onClick={loadPlan}>
              {busyAction === 'plan' ? '读取中…' : deploying ? '部署中…' : '部署'}
            </Button>
          )}
          {entry?.installed && !entry.authenticated && (backend === 'grok' || backend === 'codex') && (
            <Button size="sm" variant="outline" disabled={busy} onClick={login}>{busyAction === 'login' ? '启动登录…' : '登录'}</Button>
          )}
        </div>
      </div>
      {open && (
        <div className={css.agentRowBody}>
          {!entry?.installed && plan === undefined && localError === '' && (
            <p className={css.muted}>
              {busyAction === 'plan' ? '正在读取部署计划…' : '点击部署后会在这台主机上执行官方安装命令。'}
            </p>
          )}
          {entry?.installed && backend !== 'dsh' && auth === undefined && config === undefined && localError === '' && (
            <p className={css.muted}>{busyAction === 'config-load' ? '正在读取配置…' : '正在打开配置文件。'}</p>
          )}
          {plan !== undefined && (
            <div className={css.setupCard}>
              <strong>部署 {plan.component}</strong>
              <span>{plan.version}</span>
              {plan.steps.map(step => <code key={step.command} title={step.title}>{step.command}</code>)}
              {plan.unavailableReason !== undefined
                ? <p className={css.error}>{plan.unavailableReason}</p>
                : plan.alreadyInstalled
                  ? <p>目标已经安装。</p>
                  : (
                    <Button size="sm" variant="primary" disabled={busy || deploying} onClick={() => {
                      if (plan.component === 'hostd') return
                      deployAgent(plan.component)
                    }}>{busyAction === 'install-start' || deploying ? '部署中…' : '确认部署'}</Button>
                  )}
            </div>
          )}
          {deployOperation !== undefined && <OperationProgress operation={deployOperation} />}
          {entry?.installed && backend === 'dsh' && localError === '' && (
            dshSaved && !dshEditing
              ? (
                <div className={`${css.setupCard} ${css.setupCardSuccess}`}>
                  <strong>DSH API Key 已配置</strong>
                  <p>密钥已保存在远程主机，不会回传到浏览器。之后新建的 DSH 会话会使用该密钥。</p>
                  <Button size="sm" variant="outline" onClick={() => { setDshEditing(true); setDshApiKey('') }}>修改</Button>
                </div>
              )
              : (
                <div className={css.setupCard}>
                  <strong>DSH API Key</strong>
                  <p>密钥保存在远程主机的 hostd 私有凭据文件中，不会再回传到浏览器；对之后新建的 DSH 会话生效。</p>
                  <div className={css.inlineCreate}>
                    <input
                      type="password"
                      aria-label="DSH API Key"
                      autoComplete="off"
                      value={dshApiKey}
                      placeholder={entry?.authenticated ? '输入新密钥以替换现有配置' : '输入 DeepSeek API Key'}
                      onChange={(event) => { setDshApiKey(event.target.value) }}
                    />
                    <Button size="sm" variant="primary" disabled={busy || dshApiKey.trim() === ''} onClick={() => {
                      void tracked('credential-save', () => store.setDshApiKey(host.hostId, dshApiKey)).then(() => {
                        setDshApiKey('')
                        setDshSaved(true)
                        setDshEditing(false)
                        void store.refreshInventory(host.hostId).catch(() => undefined)
                      }).catch((error: unknown) => { setLocalError(String(error)) })
                    }}>{busyAction === 'credential-save' ? '保存中…' : '保存 API Key'}</Button>
                    {entry?.authenticated === true && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDshEditing(false); setDshApiKey('') }}>取消</Button>
                    )}
                  </div>
                </div>
              )
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
                  <button type="button" className={css.nativeButton} disabled={response === '' || busy} onClick={() => {
                    void tracked('auth-response', () => store.respondAuth(host.hostId, auth.flowId, response)).then(() => { setResponse('') })
                      .catch((error: unknown) => { setLocalError(String(error)) })
                  }}>{busyAction === 'auth-response' ? '提交中…' : '提交'}</button>
                </div>
              )}
              {['starting', 'waiting-user'].includes(auth.status) && (
                <button type="button" className={css.nativeButton} disabled={busy} onClick={() => {
                  void tracked('auth-cancel', () => store.cancelAuth(host.hostId, auth.flowId)).then(() => { setAuth(undefined) })
                    .catch((error: unknown) => { setLocalError(String(error)) })
                }}>{busyAction === 'auth-cancel' ? '取消中…' : '取消登录'}</button>
              )}
            </div>
          )}
          {config !== undefined && (
            <div className={`${css.setupCard} ${css.configCard}`} data-open={configOpen || undefined}>
              <button
                type="button"
                className={css.configCardHeader}
                aria-expanded={configOpen}
                onClick={() => { setConfigOpen(value => !value) }}
              >
                <span className={css.agentRowChevron} aria-hidden="true">
                  {configOpen ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                </span>
                <span className={css.configCardTitle}>
                  <strong>{config.backend} 配置</strong>
                  <small>{config.path} · {config.format.toUpperCase()} · 最大 {config.maxBytes} 字节</small>
                </span>
              </button>
              {configOpen && (
                <>
                  <p>这里编辑的是远程主机上的完整用户配置。不要写入明文密钥；优先引用远程环境变量。</p>
                  <textarea
                    className={css.configEditor}
                    aria-label={`${config.backend} 配置内容`}
                    spellCheck={false}
                    value={configContent}
                    onChange={(event) => {
                      setConfigContent(event.target.value)
                      setConfigSaved(false)
                    }}
                  />
                  {new TextEncoder().encode(configContent).length > config.maxBytes && (
                    <p className={css.error}>配置超过 {config.maxBytes} 字节限制。</p>
                  )}
                  {configSaved && <p className={css.success}>已保存并通过 {config.format.toUpperCase()} 语法校验。</p>}
                  <div className={css.configActions}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={configContent === config.content || new TextEncoder().encode(configContent).length > config.maxBytes || busy}
                      onClick={() => {
                        void tracked('config-save', () => store.writeAgentConfig(
                          host.hostId, config.backend, configContent, config.revision,
                        )).then((saved) => {
                          setConfig(saved)
                          setConfigContent(saved.content)
                          setConfigSaved(true)
                        }).catch((error: unknown) => { setLocalError(String(error)) })
                      }}
                    >{busyAction === 'config-save' ? '保存中…' : '保存配置'}</Button>
                  </div>
                </>
              )}
            </div>
          )}
          {localError !== '' && open && <p className={css.error}>{localError}</p>}
        </div>
      )}
    </div>
  )
}

function OperationPanel({ panel, store, snapshot }: {
  panel: RemoteAgentPanel
  store: RemoteAgentStore
  snapshot: ReturnType<RemoteAgentStore['getSnapshot']>
}) {
  const close = (): void => { store.closePanel() }
  if (panel.kind === 'add-host') {
    return <HostPanel store={store} operations={snapshot.state.operations} onClose={close} artifactVersion={snapshot.state.hostdArtifactVersion} />
  }
  if (panel.kind === 'add-project') {
    return <AddProjectPanel store={store} hosts={snapshot.state.hosts} initialHostId={panel.hostId} onClose={close} />
  }
  if (panel.kind === 'host-settings') {
    const host = snapshot.state.hosts.find(candidate => candidate.hostId === panel.hostId)
    if (host !== undefined) {
      return <HostPanel
        key={host.hostId}
        host={host}
        store={store}
        operations={snapshot.state.operations}
        onClose={close}
        artifactVersion={snapshot.state.hostdArtifactVersion}
      />
    }
  }
  if (panel.kind === 'hidden') {
    return <CatalogPanel store={store} snapshot={snapshot} onClose={close} />
  }
  return (
    <PanelShell title="操作不可用" subtitle="目标对象不存在，可能已被其他窗口删除或刷新。" onClose={close}>
      <p className={css.error}>请关闭面板后重新选择主机或项目。</p>
    </PanelShell>
  )
}

function CatalogRow({ title, detail, badge, busy, onReveal, onHide, onDelete }: {
  title: string
  detail: string
  badge?: string | undefined
  busy: boolean
  onReveal?: (() => void) | undefined
  onHide?: (() => void) | undefined
  onDelete: () => void
}) {
  return (
    <div className={css.hiddenItem}>
      <span className={css.hiddenItemMain}>
        <strong>
          {title}
          {badge !== undefined && <span className={css.catalogBadge}>{badge}</span>}
        </strong>
        <small>{detail}</small>
      </span>
      <span className={css.hiddenItemActions}>
        {onReveal !== undefined && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onReveal}>取消隐藏</Button>
        )}
        {onHide !== undefined && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onHide}>隐藏</Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}><IconTrashOutline16 />删除</Button>
      </span>
    </div>
  )
}

function CatalogSessionTree({
  session, sessions, pending, onReveal, onHide, onDelete,
}: {
  session: RemoteSessionView
  sessions: readonly RemoteSessionView[]
  pending: string | undefined
  onReveal: (session: RemoteSessionView) => void
  onHide: (session: RemoteSessionView) => void
  onDelete: (session: RemoteSessionView) => void
}) {
  const children = sessions.filter(candidate => candidate.parentSessionId === session.sessionId)
  return (
    <div className={css.catalogNode}>
      <CatalogRow
        title={session.title}
        detail={`${session.backend}${session.archivedAt === undefined ? '' : ` · 归档于 ${session.archivedAt.slice(0, 10)}`}`}
        badge={session.archivedAt === undefined ? undefined : '已归档'}
        busy={pending !== undefined}
        onReveal={session.archivedAt === undefined ? undefined : () => { onReveal(session) }}
        onHide={session.archivedAt === undefined ? () => { onHide(session) } : undefined}
        onDelete={() => { onDelete(session) }}
      />
      {children.length > 0 && (
        <div className={css.catalogChildren}>
          {children.map(child => (
            <CatalogSessionTree
              key={child.sessionId}
              session={child}
              sessions={sessions}
              pending={pending}
              onReveal={onReveal}
              onHide={onHide}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Editor for the two sidebar display preferences. The component is purely
 *  client-side: every change writes through `writeDisplayPreferences` and
 *  reruns the auto-archive job, so the sidebar re-renders without waiting on
 *  any server round-trip. The companion `ArchiveNowButton` surfaces the
 *  outcome of a manual cleanup so the user knows how many sessions retired. */
function DisplayPreferencesSection({ store }: { store: RemoteAgentStore }) {
  const prefs = useSyncExternalStore(subscribeDisplayPreferences, readDisplayPreferences, readDisplayPreferences)
  const [limitDraft, setLimitDraft] = useState(String(prefs.sessionsPerProjectLimit))
  const [daysDraft, setDaysDraft] = useState(String(prefs.autoHideSessionsAfterDays))
  const [limitError, setLimitError] = useState('')
  const [daysError, setDaysError] = useState('')
  const [sweepStatus, setSweepStatus] = useState<{ readonly state: 'idle' | 'running' | 'done' | 'error'; readonly message: string }>({ state: 'idle', message: '' })
  // When the preferences change externally (e.g. another tab or a manual save),
  // keep the controlled inputs in sync so the user never sees stale numbers.
  useEffect(() => {
    setLimitDraft(String(prefs.sessionsPerProjectLimit))
    setDaysDraft(String(prefs.autoHideSessionsAfterDays))
  }, [prefs.sessionsPerProjectLimit, prefs.autoHideSessionsAfterDays])

  const commitLimit = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      setLimitError('请输入 1 到 64 之间的整数。')
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_SESSIONS_PER_PROJECT_LIMIT) {
      setLimitError(`请输入 1 到 ${MAX_SESSIONS_PER_PROJECT_LIMIT} 之间的整数。`)
      return
    }
    setLimitError('')
    store.updateDisplayPreferences({ sessionsPerProjectLimit: Math.floor(parsed) })
  }

  const commitDays = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      setDaysError('请输入 0 到 365 之间的整数；0 表示关闭自动归档。')
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_AUTO_HIDE_AFTER_DAYS) {
      setDaysError(`请输入 0 到 ${MAX_AUTO_HIDE_AFTER_DAYS} 之间的整数。`)
      return
    }
    setDaysError('')
    store.updateDisplayPreferences({ autoHideSessionsAfterDays: Math.floor(parsed) })
  }

  const runArchive = (): void => {
    setSweepStatus({ state: 'running', message: '' })
    const work = store.archiveStaleSessions()
    void Promise.race([
      work,
      new Promise<number>((resolve) => {
        window.setTimeout(() => { resolve(-1) }, ARCHIVE_TIMEOUT_MS)
      }),
    ])
      .then((archived) => {
        if (archived === -1) {
          setSweepStatus({ state: 'error', message: '归档请求超时，未完成的会话会在下次自动清理时再试。' })
          return
        }
        setSweepStatus({
          state: 'done',
          message: archived === 0
            ? '没有需要归档的过期会话。'
            : `已归档 ${archived} 个过期会话。`,
        })
      })
      .catch((reason: unknown) => {
        setSweepStatus({ state: 'error', message: String(reason) })
      })
  }

  const daysHelp = prefs.autoHideSessionsAfterDays === 0
    ? '自动归档已关闭。'
    : `最后更新时间超过 ${prefs.autoHideSessionsAfterDays} 天的未归档会话将被自动归档。`

  return (
    <section className={css.settingsSection}>
      <header className={css.settingsSectionHeader}>
        <h2>列表显示与自动归档</h2>
        <p>调整侧栏每个项目默认展示的会话数量，并按会话最后更新时间自动归档长期不活跃的会话。</p>
      </header>
      <div className={css.settingsForm}>
        <label className={css.settingsField}>
          <span>每个项目默认显示的会话数量</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SESSIONS_PER_PROJECT_LIMIT}
            step={1}
            value={limitDraft}
            aria-invalid={limitError !== '' || undefined}
            onChange={(event) => { setLimitDraft(event.target.value); setLimitError('') }}
            onBlur={(event) => { commitLimit(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitLimit((event.target as HTMLInputElement).value)
              }
            }}
          />
          <small>超出该数量的会话会被折叠，仅在当前项目内可见。</small>
          {limitError !== '' && <small className={css.error}>{limitError}</small>}
        </label>
        <label className={css.settingsField}>
          <span>自动隐藏会话的时间阈值（天）</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_AUTO_HIDE_AFTER_DAYS}
            step={1}
            value={daysDraft}
            aria-invalid={daysError !== '' || undefined}
            onChange={(event) => { setDaysDraft(event.target.value); setDaysError('') }}
            onBlur={(event) => { commitDays(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitDays((event.target as HTMLInputElement).value)
              }
            }}
          />
          <small>{daysHelp}</small>
          {daysError !== '' && <small className={css.error}>{daysError}</small>}
        </label>
        <div className={css.settingsField}>
          <span>立即清理</span>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={sweepStatus.state === 'running'}
              onClick={runArchive}
            >{sweepStatus.state === 'running' ? '清理中…' : '立即清理过期会话'}</Button>
            {sweepStatus.state === 'done' && sweepStatus.message !== '' && (
              <p className={css.success}>{sweepStatus.message}</p>
            )}
            {sweepStatus.state === 'error' && sweepStatus.message !== '' && (
              <p className={css.error}>{sweepStatus.message}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/** Settings catalog: visible + hidden hosts/projects and archived sessions as a tree. */
function CatalogPanel({ store, snapshot, onClose }: {
  store: RemoteAgentStore
  snapshot: ReturnType<RemoteAgentStore['getSnapshot']>
  onClose: () => void
}) {
  const hidden = snapshot.hiddenItems
  const hosts = [
    ...snapshot.state.hosts,
    ...(hidden?.hosts ?? []).filter(host => !snapshot.state.hosts.some(visible => visible.hostId === host.hostId)),
  ]
  const projects = [
    ...snapshot.state.projects,
    ...(hidden?.projects ?? []).filter(project => !snapshot.state.projects.some(visible => visible.projectId === project.projectId)),
  ]
  const sessions = [
    ...snapshot.state.sessions,
    ...(hidden?.sessions ?? []).filter(session => !snapshot.state.sessions.some(visible => visible.sessionId === session.sessionId)),
  ]
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const refresh = (): void => {
    void store.loadHiddenItems()
      .then(() => { setError('') })
      .catch((reason: unknown) => { setError(String(reason)) })
  }
  useEffect(() => { refresh() }, [])
  const act = (key: string, action: () => Promise<void>, successMessage: string): void => {
    setPending(key)
    setError('')
    setSuccess('')
    // The watchdog stops blocking the UI after ARCHIVE_TIMEOUT_MS even if
    // `action()` itself never settles (e.g. an IndexedDB hang on the
    // archive-then-select path). The store still keeps its own promise
    // alive and will publish a fresh snapshot when it eventually resolves.
    let settled = false
    const work = action()
    work.then(() => { settled = true })
    void Promise.race([
      work,
      new Promise<void>((resolve) => {
        window.setTimeout(() => { resolve() }, ARCHIVE_TIMEOUT_MS)
      }),
    ])
      .then(() => {
        if (settled) {
          setSuccess(successMessage)
          refresh()
        }
      })
      .catch((reason: unknown) => { setError(String(reason)) })
      .finally(() => { setPending(undefined) })
  }
  const revealProject = async (project: RemoteProjectView): Promise<void> => {
    const host = hosts.find(candidate => candidate.hostId === project.hostId)
    if (host?.hiddenAt !== undefined) await store.unhideHost(host.hostId)
    if (project.hiddenAt !== undefined) await store.unhideProject(RemoteProjectId(project.projectId))
  }
  const revealSession = async (session: RemoteSessionView): Promise<void> => {
    const project = projects.find(candidate => candidate.projectId === session.projectId)
    if (project !== undefined) await revealProject(project)
    if (session.archivedAt !== undefined) await store.unarchiveSession(RemoteSessionId(session.sessionId))
  }
  return (
    <PanelShell
      title="设置"
      subtitle="按主机 → 项目 → 会话查看全部条目，包括已隐藏的。取消隐藏会话时会一并恢复其所属主机和项目。"
      onClose={onClose}
    >
      <DisplayPreferencesSection store={store} />
      <section className={css.settingsSection}>
        <header className={css.settingsSectionHeader}>
          <h2>主机、项目和会话</h2>
          <p>侧栏只显示未隐藏的层级。这里按树查看全部条目，并可以取消隐藏或永久删除。</p>
        </header>
        {hosts.length === 0
          ? <p className={css.muted}>还没有主机。</p>
          : (
            <div className={css.catalogTree}>
              {hosts.map(host => {
                const hostProjects = projects.filter(project => project.hostId === host.hostId)
                return (
                  <div key={host.hostId} className={css.catalogNode}>
                    <CatalogRow
                      title={host.title}
                      detail={`${hostIpLabel(host)}${host.hiddenAt === undefined ? '' : ` · 隐藏于 ${host.hiddenAt.slice(0, 10)}`}`}
                      badge={host.hiddenAt === undefined ? undefined : '已隐藏'}
                      busy={pending !== undefined}
                      onReveal={host.hiddenAt === undefined ? undefined : () => {
                        act(`host:${host.hostId}`, () => store.unhideHost(host.hostId), `已恢复主机 ${host.title}`)
                      }}
                      onHide={host.hiddenAt === undefined ? () => {
                        act(`host:${host.hostId}`, () => store.hideHost(host.hostId), `已隐藏主机 ${host.title}`)
                      } : undefined}
                      onDelete={() => {
                        act(`host:${host.hostId}`, () => store.deleteHost(host.hostId), `已删除主机 ${host.title}`)
                      }}
                    />
                    {hostProjects.length > 0 && (
                      <div className={css.catalogChildren}>
                        {hostProjects.map(project => {
                          const projectSessions = sessions.filter(session => session.projectId === project.projectId)
                          const roots = projectSessions.filter(session => session.parentSessionId === undefined)
                          return (
                            <div key={project.projectId} className={css.catalogNode}>
                              <CatalogRow
                                title={project.title}
                                detail={`${project.cwd}${project.hiddenAt === undefined ? '' : ` · 隐藏于 ${project.hiddenAt.slice(0, 10)}`}`}
                                badge={project.hiddenAt === undefined ? undefined : '已隐藏'}
                                busy={pending !== undefined}
                                onReveal={project.hiddenAt === undefined && host.hiddenAt === undefined ? undefined : () => {
                                  act(`project:${project.projectId}`, () => revealProject(project), `已恢复项目 ${project.title}`)
                                }}
                                onHide={project.hiddenAt === undefined ? () => {
                                  act(`project:${project.projectId}`, () => store.hideProject(RemoteProjectId(project.projectId)), `已隐藏项目 ${project.title}`)
                                } : undefined}
                                onDelete={() => {
                                  act(`project:${project.projectId}`, () => store.deleteProject(RemoteProjectId(project.projectId)), `已删除项目 ${project.title}`)
                                }}
                              />
                              {roots.length > 0 && (
                                <div className={css.catalogChildren}>
                                  {roots.map(session => (
                                    <CatalogSessionTree
                                      key={session.sessionId}
                                      session={session}
                                      sessions={projectSessions}
                                      pending={pending}
                                      onReveal={(target) => {
                                        act(`session:${target.sessionId}`, () => revealSession(target), `已恢复会话 ${target.title}`)
                                      }}
                                      onHide={(target) => {
                                        act(`session:${target.sessionId}`, () => store.archiveSession(RemoteSessionId(target.sessionId)), `已归档会话 ${target.title}`)
                                      }}
                                      onDelete={(target) => {
                                        act(`session:${target.sessionId}`, () => store.deleteSession(RemoteSessionId(target.sessionId)), `已删除会话 ${target.title}`)
                                      }}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
      </section>
      {error !== '' && <p className={`${css.error} ${css.fullWidth}`}>{error}</p>}
      {success !== '' && <p className={`${css.success} ${css.fullWidth}`}>{success}</p>}
    </PanelShell>
  )
}

function DraftConversation({ project, host, projectSessions, store, error, promptProgress }: {
  project: RemoteProjectView
  host: RemoteHostView
  projectSessions: readonly RemoteSessionView[]
  store: RemoteAgentStore
  error: string | undefined
  promptProgress: RemotePromptProgress | undefined
}) {
  const backends = availableBackends(host)
  const preferredBackend = preferredProjectBackend(backends, projectSessions)
  const backendSignature = backends.join(',')
  const [backend, setBackend] = useState<RemoteAgentBackend | ''>(() => preferredBackend)
  const [preferences, setPreferences] = useState<SessionPreferences>(() =>
    preferredBackend === ''
      ? defaultSessionPreferences('codex')
      : resolveSessionPreferences(preferredBackend, {}, undefined, host.hostId))
  const [draft, setDraft] = useState('')
  useEffect(() => {
    setBackend(current => current !== '' && backends.includes(current) ? current : preferredBackend)
  }, [backendSignature, preferredBackend])
  useEffect(() => {
    if (backends.length > 0 || host.inventory !== undefined) return
    void store.refreshInventory(host.hostId).catch(() => undefined)
  }, [backends.length, host.hostId, host.inventory, store])
  useEffect(() => {
    if (backend === '') return
    setPreferences(resolveSessionPreferences(backend, {}, undefined, host.hostId))
  }, [backend, host.hostId])
  const progress = promptProgress?.projectId === project.projectId && promptProgress.sessionId === undefined
    ? promptProgress
    : undefined
  // Only block this draft while ITS OWN create RPC is in flight. The store's
  // global `pending` covers every in-flight RPC — including one for a draft
  // the user has since abandoned — and applying it here would leave a newly
  // opened draft with a disabled Agent picker and send button.
  const draftBusy = progress !== undefined && progress.phase !== 'failed'
  const draftStage: ConversationStage = progress?.phase === 'failed'
    ? {
      kind: /timeout|timed out|超时/i.test(progress.message ?? '') ? 'timeout' : 'failed',
      label: /timeout|timed out|超时/i.test(progress.message ?? '') ? '连接超时' : '会话创建失败',
      detail: progress.message ?? error ?? '无法创建远程会话。', state: 'error', visible: true,
    }
    : progress === undefined
      ? { kind: 'idle', label: '尚未发送', detail: '选择 Agent 后发送第一条消息。', state: 'done', visible: false }
      : {
        kind: 'connecting',
        label: progress.phase === 'sending' ? '正在连接 Agent' : '正在创建远程会话',
        detail: progress.message ?? '正在创建远程会话并建立通信通道。',
        state: 'ongoing', visible: true,
      }
  const send = (): void => {
    const text = draft.trim()
    if (text === '' || backend === '' || draftBusy) return
    void store.promptSessionDraft(backend, text).catch(() => undefined)
  }
  return (
    <main className={css.conversation}>
      <header className={css.conversationHeader}>
        <div>
          <h1>新会话</h1>
          <p>{host.title}<span aria-hidden="true"> / </span>{project.title}</p>
        </div>
        <div className={css.sessionState}>
          <StateDot state={draftStage.state} />
          <span>{draftStage.label}</span>
        </div>
      </header>
      <div className={css.transcriptShell}>
        <div className={css.transcript}>
          <div className={css.blankConversation}>
            <span className={css.blankIcon}><IconAgentPresetOutline16 size={22} /></span>
            <strong>开始一个新会话</strong>
            <p>第一次发送时创建远程会话并锁定 Agent。</p>
            <ConversationActivity stage={draftStage} />
          </div>
        </div>
      </div>
      <div className={css.composerDock}>
        <div className={css.composer}>
          {error !== undefined && <div className={css.composerError}>{error}</div>}
          {backend !== '' && (
            <SessionControls
              backend={backend}
              preferences={preferences}
              disabled={draftBusy}
              onChange={(next) => {
                setPreferences(next)
                const updated = {
                  ...readPersistedSessionPreferences(),
                  [sessionPreferencesKey(host.hostId, backend)]: normalizeSessionPreferences(backend, next),
                }
                writePersistedSessionPreferences(updated)
              }}
            />
          )}
          <textarea
            aria-label="发送给远程 Agent"
            value={draft}
            placeholder="输入第一条消息"
            disabled={draftBusy}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <div className={css.composerActions}>
            <label className={css.agentPicker}>
              <IconAgentPresetOutline16 />
              <select
                aria-label="选择 Agent"
                value={backend}
                disabled={draftBusy || backends.length === 0}
                onChange={(event) => { setBackend(event.target.value as RemoteAgentBackend) }}
              >
                <option value="">{backends.length === 0 ? '没有可用 Agent，请检查远端安装和登录状态' : '选择 Agent'}</option>
                {backends.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <span>首次发送后不可更改</span>
            <Button size="sm" variant="primary" icon={<IconSendOutline16 />} aria-label="发送" disabled={backend === '' || draft.trim() === '' || draftBusy} onClick={send} />
          </div>
        </div>
      </div>
    </main>
  )
}

/** Render the selected remote session. */
export function RemoteConversation({ store }: RemoteConversationProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [draft, setDraft] = useState('')
  const [sessionAction, setSessionAction] = useState<string>()
  const [sessionPreferences, setSessionPreferences] = useState<Record<string, SessionPreferences>>(readPersistedSessionPreferences)
  // Last failed reopen: reason to show and (when hostd offered one) the repair
  // the user can confirm. Keyed by session so switching sessions hides it.
  const [reopenFailure, setReopenFailure] = useState<{ sessionId: string; issue: ReopenFailureIssue } | undefined>()
  const [reopenBusy, setReopenBusy] = useState<'adopt' | 'restart' | undefined>()
  const [restartArmed, setRestartArmed] = useState(false)
  const restartArmedTimerRef = useRef<number | undefined>(undefined)
  // Unresponsive-agent detection: banner + user-confirmed force restart.
  const [forceRestartArmed, setForceRestartArmed] = useState(false)
  const [forceRestartBusy, setForceRestartBusy] = useState(false)
  const forceRestartArmTimerRef = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const transcriptColumnRef = useRef<HTMLDivElement | null>(null)
  const followBottomRef = useRef(true)
  const observedTopRef = useRef(0)
  const lastSessionIdRef = useRef<string>()
  const followSignatureRef = useRef('')
  const persistTimerRef = useRef<number | undefined>(undefined)
  const answeredPermissionsRef = useRef(new Set<string>())
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const session = snapshot.state.sessions.find(candidate => candidate.sessionId === snapshot.currentSessionId)
  const sessionProject = snapshot.state.projects.find(candidate => candidate.projectId === session?.projectId)
  const sessionHost = snapshot.state.hosts.find(candidate => candidate.hostId === sessionProject?.hostId)
  const sessionEntries = useMemo(
    () => snapshot.state.transcript.filter(entry => entry.sessionId === session?.sessionId),
    [snapshot.state.transcript, session?.sessionId],
  )
  const transcript = useMemo(() => buildTranscriptNodes(sessionEntries), [sessionEntries])
  const activityClock = useActivityClock(
    snapshot.promptProgress !== undefined
    || session?.turnState === 'running'
    || session?.turnState === 'waiting-permission'
    || snapshot.phase === 'reconnecting',
  )
  // Unresponsive detection: a live turn with no transcript activity for a long
  // time. Uses entry timestamps as the last backend heartbeat; falls back to
  // the prompt start so a never-answered first request is also covered.
  const lastEntryAtMs = useMemo(() => {
    let latest = -1
    for (const entry of sessionEntries) {
      const parsed = Date.parse(entry.createdAt)
      if (Number.isFinite(parsed) && parsed > latest) latest = parsed
    }
    return latest
  }, [sessionEntries])
  const activeProgress = snapshot.promptProgress !== undefined
    && snapshot.promptProgress.sessionId === session?.sessionId
    ? snapshot.promptProgress
    : undefined
  const promptActive = activeProgress !== undefined
    && (activeProgress.phase === 'waiting' || activeProgress.phase === 'sending')
  const promptStartMs = activeProgress?.startedAt
  const lastActivityAtMs = lastEntryAtMs >= 0 ? lastEntryAtMs : promptStartMs
  const agentIdleMs = lastActivityAtMs === undefined ? 0 : Math.max(0, activityClock - lastActivityAtMs)
  const agentStalled = session !== undefined
    && session.channelState === 'open'
    && (session.turnState === 'running' || promptActive)
    && snapshot.promptProgress?.phase !== 'failed'
    && agentIdleMs >= STALLED_AGENT_BANNER_MS
  const presentation = session === undefined
    ? undefined
    : conversationPresentation({
      session,
      entries: sessionEntries,
      ...(snapshot.promptProgress === undefined ? {} : { progress: snapshot.promptProgress }),
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
      now: activityClock,
      transportPhase: snapshot.phase,
      pending: snapshot.pending,
    })
  const stage = presentation?.turn
  const lastNode = transcript.at(-1)
  const pendingPermission = session?.turnState === 'waiting-permission'
    ? pendingPermissionEntry(sessionEntries)
    : undefined
  const pinPendingPermission = shouldPinPendingPermission(
    session?.turnState ?? 'idle',
    pendingPermission,
    lastNode?.kind === 'entry' ? lastNode.entry.transcriptId : lastNode?.id,
  )
  const nodeSignature = lastNode === undefined
    ? 'empty'
    : lastNode.kind === 'tool'
      ? `${lastNode.id}:${lastNode.entries.length}:${lastNode.entries.at(-1)?.text.length ?? 0}`
      : `${lastNode.id}:${lastNode.entry.text.length}`
  const followSignature = `${nodeSignature}:${stage?.kind ?? 'none'}:${pinPendingPermission ? pendingPermission?.transcriptId ?? 'pin' : 'none'}`
  const pendingRestoreRef = useRef<TranscriptScrollMemory | undefined>(undefined)
  const scrollToBottom = (element: HTMLDivElement): void => {
    element.scrollTop = element.scrollHeight
    observedTopRef.current = element.scrollTop
    followBottomRef.current = true
    setShowJumpToLatest(false)
    if (session !== undefined) {
      writeTranscriptScrollMemory(session.sessionId, {
        scrollTop: element.scrollTop,
        followBottom: true,
      })
    }
  }
  useLayoutEffect(() => {
    const element = scrollRef.current
    const sessionId = session?.sessionId
    const sessionChanged = lastSessionIdRef.current !== sessionId
    const tipMoved = followSignatureRef.current !== followSignature
    lastSessionIdRef.current = sessionId
    followSignatureRef.current = followSignature
    if (element === null || sessionId === undefined) return
    if (sessionChanged) {
      pendingRestoreRef.current = readTranscriptScrollMemory(sessionId)
    }
    if (pendingRestoreRef.current !== undefined) {
      const memory = pendingRestoreRef.current
      const floor = Math.max(0, element.scrollHeight - element.clientHeight)
      const ready = memory.followBottom || floor >= memory.scrollTop
      if (ready) {
        if (memory.followBottom) {
          element.scrollTop = element.scrollHeight
          observedTopRef.current = element.scrollTop
          followBottomRef.current = true
          setShowJumpToLatest(false)
        } else {
          element.scrollTop = memory.scrollTop
          observedTopRef.current = element.scrollTop
          followBottomRef.current = false
          setShowJumpToLatest(true)
        }
        pendingRestoreRef.current = undefined
        return
      }
      // Transcript shorter than the saved offset: defer restoration until more content renders.
      return
    }
    if (tipMoved && followBottomRef.current) {
      scrollToBottom(element)
    } else if (tipMoved && transcript.length > 0) {
      setShowJumpToLatest(true)
    }
  }, [followSignature, session?.sessionId, transcript.length])
  useEffect(() => {
    const column = transcriptColumnRef.current
    const element = scrollRef.current
    if (column === null || element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) scrollToBottom(element)
    })
    observer.observe(column)
    return () => { observer.disconnect() }
  }, [session?.sessionId])
  useEffect(() => () => {
    if (persistTimerRef.current !== undefined) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = undefined
    }
    if (restartArmedTimerRef.current !== undefined) {
      window.clearTimeout(restartArmedTimerRef.current)
      restartArmedTimerRef.current = undefined
    }
    if (forceRestartArmTimerRef.current !== undefined) {
      window.clearTimeout(forceRestartArmTimerRef.current)
      forceRestartArmTimerRef.current = undefined
    }
  }, [])
  useEffect(() => {
    // A successful reopen (channel back to open) retires any failure banner.
    if (session?.channelState === 'open') {
      setReopenFailure(undefined)
      setRestartArmed(false)
      setReopenBusy(undefined)
      setForceRestartArmed(false)
      setForceRestartBusy(false)
    }
  }, [session?.channelState, session?.sessionId])
  const preferences = session === undefined
    ? undefined
    : resolveSessionPreferences(
      session.backend,
      sessionPreferences,
      session.sessionId,
      sessionHost?.hostId,
    )
  useEffect(() => {
    if (session === undefined || session.turnState !== 'waiting-permission') return
    if (!shouldAutoApprovePermissions(preferences?.approvalChoice, preferences?.permissionMode)) return
    const entry = pendingPermissionEntry(sessionEntries)
    const requestId = entry === undefined ? undefined : permissionRequestId(entry)
    if (entry === undefined || requestId === undefined || !isAutoApprovablePermission(entry)) return
    const action = `permission:${session.sessionId}:${requestId}`
    if (sessionAction !== undefined || answeredPermissionsRef.current.has(action)) return
    const optionId = autoApproveOptionId(parseChoicePrompt(entry), {
      ...(preferences?.approvalChoice === undefined ? {} : { approvalChoice: preferences.approvalChoice }),
      ...(preferences?.permissionMode === undefined ? {} : { permissionMode: preferences.permissionMode }),
    })
    answeredPermissionsRef.current.add(action)
    setSessionAction(action)
    void store.permission(
      session.sessionId,
      requestId,
      optionId === undefined ? { outcome: 'selected' } : { outcome: 'selected', optionId },
    )
      .catch(() => { answeredPermissionsRef.current.delete(action) })
      .finally(() => { setSessionAction(current => current === action ? undefined : current) })
  }, [
    session,
    sessionEntries,
    preferences?.approvalChoice,
    preferences?.permissionMode,
    sessionAction,
    store,
  ])

  if (snapshot.panel !== undefined) {
    return <OperationPanel panel={snapshot.panel} store={store} snapshot={snapshot} />
  }

  if (snapshot.draftSession !== undefined && snapshot.currentSessionId === undefined) {
    const project = snapshot.state.projects.find(candidate => candidate.projectId === snapshot.draftSession?.projectId)
    const host = project === undefined ? undefined : snapshot.state.hosts.find(candidate => candidate.hostId === project.hostId)
    if (project !== undefined && host !== undefined) {
      return (
        <DraftConversation
          key={project.projectId}
          project={project}
          host={host}
          projectSessions={snapshot.state.sessions.filter(candidate => candidate.projectId === project.projectId)}
          store={store}
          error={snapshot.error}
          promptProgress={snapshot.promptProgress}
        />
      )
    }
  }

  if (session === undefined && snapshot.currentSessionId !== undefined) {
    return (
      <main className={css.hero}>
        <div className={css.heroMark}>话</div>
        <h1>正在打开会话</h1>
        <p>远程会话已创建，正在同步到会话列表。</p>
      </main>
    )
  }

  if (session === undefined) {
    const firstHost = snapshot.state.hosts[0]
    const firstProject = snapshot.state.projects[0]
    if (firstHost !== undefined && firstProject === undefined) {
      return (
        <main className={css.hero}>
          <div className={css.heroMark}>项</div>
          <h1>添加项目后开始 Grok 会话</h1>
          <p>主机已经连接，Grok 也已就绪。接下来选择这台主机上的项目目录，之后就可以新建会话。</p>
          <Button size="sm" variant="primary" onClick={() => { store.showPanel({ kind: 'add-project', hostId: firstHost.hostId }) }}>添加项目</Button>
        </main>
      )
    }
    if (firstProject !== undefined) {
      return (
        <main className={css.hero}>
          <div className={css.heroMark}>话</div>
          <h1>从项目新建 Agent 会话</h1>
          <p>主机和项目已经准备好。先打开会话占位，首次发送前再选择 Agent。</p>
          <Button size="sm" variant="primary" onClick={() => { store.startSessionDraft(firstProject.projectId) }}>新建会话</Button>
        </main>
      )
    }
    return (
      <main className={css.hero}>
        <div className={css.heroMark}>远</div>
        <h1>连接一个远程 Agent 会话</h1>
        <p>在左侧点击“添加主机”开始。已有 hostd 可直接连接，远端主机也可通过 SSH 自动部署并建立隧道。</p>
        <Button size="sm" variant="primary" onClick={() => { store.showPanel({ kind: 'add-host' }) }}>添加主机</Button>
      </main>
    )
  }

  const visibleStage = stage ?? {
    kind: 'idle', label: '已就绪', detail: '可以发送新的请求。', state: 'done', visible: false,
  } satisfies ConversationStage
  const actions = presentation?.actions
  const channelStage = presentation?.channel
  const setPreferences = (next: SessionPreferences): void => {
    if (session === undefined) return
    const normalized = normalizeSessionPreferences(session.backend, next)
    setSessionPreferences((current) => {
      const updated = {
        ...current,
        [session.sessionId]: normalized,
        ...(sessionHost === undefined ? {} : { [sessionPreferencesKey(sessionHost.hostId, session.backend)]: normalized }),
      }
      writePersistedSessionPreferences(updated)
      return updated
    })
  }
  const send = (): void => {
    const text = draft.trim()
    if (text === '') return
    if (actions?.canSend === true) {
      followBottomRef.current = true
      setDraft('')
      void store.prompt(session.sessionId, text).catch(() => { setDraft(text) })
      return
    }
    // turnBusy / waiting / connecting / permission → park locally and let the
    // browser auto-drain once the live turn settles.
    if (snapshot.queuedPrompt?.sessionId === session.sessionId) return
    followBottomRef.current = true
    setDraft('')
    store.enqueuePrompt(session.sessionId, text)
  }
  const cancelQueued = (): void => {
    if (session === undefined) return
    if (snapshot.queuedPrompt?.sessionId !== session.sessionId) return
    const text = snapshot.queuedPrompt.text
    store.cancelQueuedPrompt()
    setDraft(text)
    followBottomRef.current = true
  }
  const resend = (text: string): void => {
    const payload = text.trim()
    if (payload === '' || sessionAction !== undefined || actions?.canResend !== true) return
    followBottomRef.current = true
    void store.prompt(session.sessionId, payload).catch(() => undefined)
  }
  const submitPermission = (requestId: string, outcome: JsonValue): void => {
    if (sessionAction !== undefined) return
    const action = `permission:${session.sessionId}:${requestId}`
    answeredPermissionsRef.current.add(action)
    setSessionAction(action)
    void store.permission(session.sessionId, requestId, outcome)
      .catch(() => { answeredPermissionsRef.current.delete(action) })
      .finally(() => { setSessionAction(current => current === action ? undefined : current) })
  }
  const stop = (): void => {
    if (sessionAction !== undefined) return
    const action = `stop:${session.sessionId}`
    setSessionAction(action)
    void store.cancel(session.sessionId)
      .catch(() => undefined)
      .finally(() => { setSessionAction(current => current === action ? undefined : current) })
  }
  const jumpToLatest = (): void => {
    const element = scrollRef.current
    if (element === null) return
    scrollToBottom(element)
  }
  const reconnect = (): void => {
    if (sessionAction !== undefined) return
    const action = `reconnect:${session.sessionId}`
    setReopenFailure(undefined)
    setRestartArmed(false)
    setSessionAction(action)
    void store.reconnectSession(session.sessionId)
      .then(() => { setReopenFailure(undefined) })
      .catch((error: unknown) => {
        setReopenFailure({ sessionId: session.sessionId, issue: parseReopenFailure(error) })
      })
      .finally(() => { setSessionAction(current => current === action ? undefined : current) })
  }
  /** User-confirmed repair: run the hostd fix then reopen automatically. */
  const runReopenFix = (kind: 'adopt' | 'restart'): void => {
    if (sessionAction !== undefined || reopenBusy !== undefined) return
    const action = `reconnect:${session.sessionId}`
    setReopenFailure(undefined)
    setRestartArmed(false)
    setReopenBusy(kind)
    // The repair RPC itself is quick; reuse the reconnect pending guard while
    // the whole fix-then-reopen sequence runs so nothing double-fires.
    setSessionAction(action)
    void store.repairGrokServe(session.sessionId, kind)
      .then(() => { setReopenFailure(undefined) })
      .catch((error: unknown) => {
        setReopenFailure({ sessionId: session.sessionId, issue: parseReopenFailure(error) })
      })
      .finally(() => {
        setReopenBusy(undefined)
        setSessionAction(current => current === action ? undefined : current)
      })
  }
  const armRestart = (): void => {
    if (restartArmed) {
      runReopenFix('restart')
      return
    }
    setRestartArmed(true)
    if (restartArmedTimerRef.current !== undefined) window.clearTimeout(restartArmedTimerRef.current)
    restartArmedTimerRef.current = window.setTimeout(() => { setRestartArmed(false) }, 10_000)
  }
  /** Unresponsive-agent action: arm (10 s), then confirm -> force restart. */
  const armForceRestart = (): void => {
    if (session === undefined || sessionAction !== undefined || forceRestartBusy) return
    if (forceRestartArmed) {
      if (forceRestartArmTimerRef.current !== undefined) window.clearTimeout(forceRestartArmTimerRef.current)
      setForceRestartArmed(false)
      setForceRestartBusy(true)
      const action = `force-restart:${session.sessionId}`
      setSessionAction(action)
      void store.forceRestartSession(session.sessionId)
        .catch((error: unknown) => {
          setReopenFailure({ sessionId: session.sessionId, issue: parseReopenFailure(error) })
        })
        .finally(() => {
          setForceRestartBusy(false)
          setSessionAction(current => current === action ? undefined : current)
        })
      return
    }
    setForceRestartArmed(true)
    if (forceRestartArmTimerRef.current !== undefined) window.clearTimeout(forceRestartArmTimerRef.current)
    forceRestartArmTimerRef.current = window.setTimeout(() => { setForceRestartArmed(false) }, FORCE_RESTART_ARM_MS)
  }
  const currentReopenFailure = reopenFailure !== undefined && reopenFailure.sessionId === session.sessionId
    ? reopenFailure.issue
    : undefined
  const reconnectAction = actions?.canReconnect === true
    ? {
      label: session.channelState === 'reconnecting' ? '重新连接' : '在当前会话重开',
      pendingLabel: session.channelState === 'reconnecting' ? '重连中…' : '重开中…',
      pending: sessionAction === `reconnect:${session.sessionId}`,
      onClick: reconnect,
    }
    : undefined
  const reconnectOnChannel = reconnectAction !== undefined
    && channelStage?.visible === true
    && (session.channelState === 'reconnecting' || session.channelState === 'lost')
  const reconnectOnTurn = reconnectAction !== undefined && !reconnectOnChannel
    && visibleStage.visible
    && (visibleStage.kind === 'failed' || visibleStage.kind === 'timeout')
  return (
    <main className={css.conversation}>
      <header className={css.conversationHeader}>
        <div>
          <h1>{session.title}</h1>
          <p>{sessionHost === undefined ? '' : `${sessionHost.title} / `}{sessionProject?.title ?? ''}<span className={css.headerBackend}>{session.backend}</span></p>
        </div>
        <div className={css.sessionMeta}>
          <SessionIdChip sessionId={session.sessionId} />
          <div className={css.sessionState}>
            <StateDot state={presentation?.headerState ?? visibleStage.state} />
            <span>{presentation?.headerLabel ?? visibleStage.label}</span>
          </div>
        </div>
      </header>
      <div className={css.transcriptShell}>
        <div
          ref={scrollRef}
          className={css.transcript}
          onScroll={(event) => {
            const element = event.currentTarget
            const floor = Math.max(0, element.scrollHeight - element.clientHeight)
            const deliveredTop = Math.min(observedTopRef.current, floor)
            const movedByReader = Math.abs(element.scrollTop - deliveredTop) > 0.5
            const follows = movedByReader ? isNearScrollBottom(element) : followBottomRef.current
            followBottomRef.current = follows
            setShowJumpToLatest(!follows)
            observedTopRef.current = element.scrollTop
            const persistSessionId = session.sessionId
            const persistTop = element.scrollTop
            if (persistTimerRef.current !== undefined) window.clearTimeout(persistTimerRef.current)
            persistTimerRef.current = window.setTimeout(() => {
              persistTimerRef.current = undefined
              writeTranscriptScrollMemory(persistSessionId, {
                scrollTop: persistTop,
                followBottom: follows,
              })
            }, 200)
          }}
        >
          <div ref={transcriptColumnRef} className={css.transcriptColumn}>
            {session.droppedThrough !== undefined && session.droppedThrough >= 0
              ? <TranscriptGapBanner session={session} />
              : null}
            {transcript.map((node, index) => (
              <TranscriptRow
                key={node.id}
                node={node}
                active={index === transcript.length - 1 && session.turnState === 'running'}
                permissionPending={node.kind === 'entry' && permissionRequestId(node.entry) !== undefined
                  && sessionAction === `permission:${session.sessionId}:${permissionRequestId(node.entry)}`}
                resendDisabled={actions?.canResend !== true || sessionAction !== undefined}
                onPermission={submitPermission}
                onResend={resend}
              />
            ))}
            {snapshot.queuedPrompt !== undefined && snapshot.queuedPrompt.sessionId === session.sessionId && (
              <article className={`${css.userTurn} ${css.queuedTurn}`} aria-label="排队中的消息">
                <div className={`${css.userBubble} ${css.queuedBubble}`}>
                  <span className={css.queuedBadge} title="上一轮还未结束，这条消息会在它结束后自动发送">排队中</span>
                  <MessageText text={snapshot.queuedPrompt.text} />
                </div>
                <div className={css.messageActions}>
                  <button
                    type="button"
                    className={css.messageAction}
                    aria-label="取消排队"
                    title="取消排队，把消息放回输入框"
                    onClick={cancelQueued}
                  >
                    <IconTrashOutline16 />
                  </button>
                </div>
              </article>
            )}
            {pinPendingPermission && pendingPermission !== undefined && (
              <TranscriptRow
                key={`pending:${pendingPermission.transcriptId}`}
                node={{ kind: 'entry', id: `pending:${pendingPermission.transcriptId}`, entry: pendingPermission }}
                active={false}
                permissionPending={permissionRequestId(pendingPermission) !== undefined
                  && sessionAction === `permission:${session.sessionId}:${permissionRequestId(pendingPermission)}`}
                resendDisabled
                onPermission={submitPermission}
              />
            )}
            {channelStage?.visible === true && (
              <ConversationActivity
                stage={channelStage}
                {...(reconnectOnChannel !== true || reconnectAction === undefined ? {} : { action: reconnectAction })}
              />
            )}
            {visibleStage.visible && (
              <ConversationActivity
                stage={visibleStage}
                {...(reconnectOnTurn !== true || reconnectAction === undefined ? {} : { action: reconnectAction })}
              />
            )}
            {currentReopenFailure !== undefined && (
              <ReopenFailureBanner
                issue={currentReopenFailure}
                busy={reopenBusy}
                restartArmed={restartArmed}
                enabled={sessionAction === undefined}
                onRetry={reconnect}
                onAdopt={() => runReopenFix('adopt')}
                onRestartClick={armRestart}
                onOpenHostSettings={() => {
                  if (sessionHost !== undefined) store.showPanel({ kind: 'host-settings', hostId: sessionHost.hostId })
                }}
              />
            )}
            {agentStalled && (
              <UnresponsiveAgentBanner
                idleMinutes={Math.max(1, Math.floor(agentIdleMs / 60_000))}
                armed={forceRestartArmed}
                busy={forceRestartBusy}
                enabled={sessionAction === undefined}
                onStop={() => { setForceRestartArmed(false); stop() }}
                onArmRestart={armForceRestart}
              />
            )}
            {transcript.length === 0 && !visibleStage.visible && channelStage?.visible !== true && (
              <p className={css.emptyTranscript}>远程会话已连接。发送一条消息开始。</p>
            )}
          </div>
        </div>
        {showJumpToLatest && (
          <button type="button" className={css.jumpToLatest} aria-label="回到最新消息" title="回到最新" onClick={jumpToLatest}><IconChevronDownOutline14 /></button>
        )}
      </div>
      <div className={css.composerDock}>
        <div className={css.composer}>
          {snapshot.error !== undefined && <div className={css.composerError}>{snapshot.error}</div>}
          {preferences !== undefined && session.parentSessionId === undefined && (
            <SessionControls
              backend={session.backend}
              preferences={preferences}
              disabled={actions?.canChangePreferences !== true}
              onChange={setPreferences}
            />
          )}
          <textarea
            aria-label="发送给远程 Agent"
            value={draft}
            placeholder={`发送给 ${session.backend}`}
            disabled={actions?.canCompose !== true}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <div className={css.composerActions}>
            <span>{session.parentSessionId === undefined ? `${session.backend} · Enter 发送，Shift+Enter 换行` : '子会话由远端 Agent 管理'}</span>
            {actions?.canStop === true && (
              <Button size="sm" variant="toolbar" icon={<IconStopFill16 />} disabled={sessionAction !== undefined} onClick={stop}>{sessionAction === `stop:${session.sessionId}` ? '停止中…' : '停止'}</Button>
            )}
            <Button size="sm" variant="primary" icon={<IconSendOutline16 />} aria-label="发送" disabled={actions?.canSend !== true || draft.trim() === ''} onClick={send} />
          </div>
        </div>
        <ConversationStatsLine entries={sessionEntries} />
      </div>
    </main>
  )
}
