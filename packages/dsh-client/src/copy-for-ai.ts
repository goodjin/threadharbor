/**
 * Build clipboard prompts for AI-assisted ops troubleshooting.
 * Stable doc path is quoted in the panel and in docs/ops.zh.md.
 */

import type { HostSshInfo } from '@threadharbor/dsh-host-federation'
import type { PeerCheckReport, PeerCheckStep } from '@threadharbor/dsh-host-federation'
import type { ServeFailure } from './ssh-deploy.ts'

/** Repository-relative path; keep in sync with docs/ops.zh.md title block. */
export const THREADHARBOR_OPS_DOC_PATH = 'docs/ops.zh.md'

export type OpsAiScenario = 'ssh-deploy' | 'ssh-connect' | 'peer-check' | 'peer-serve'

export type OpsAiHostContext = {
  readonly hostId?: string
  readonly target?: string
  readonly user?: string
  readonly port?: number | string
  readonly proxyJump?: string
  readonly authMode?: HostSshInfo['authMode'] | string
  readonly identityFile?: string
  readonly hostKeyFingerprint?: string
  readonly remoteWebPort?: number | string
}

export type OpsAiFailureInput = {
  readonly scenario: OpsAiScenario
  readonly rawError?: string | undefined
  readonly failedStep?: string | undefined
  readonly failedStepDetail?: string | undefined
  readonly suggestedAction?: string | undefined
  readonly operationId?: string | undefined
  readonly host: OpsAiHostContext
}

const SCENARIO_LABEL: Record<OpsAiScenario, string> = {
  'ssh-deploy': 'SSH 部署失败',
  'ssh-connect': 'SSH 连接并打开失败',
  'peer-check': '对方状态检测（check 清单）失败',
  'peer-serve': '配置 tailscale serve 失败',
}

function authModeLabel(mode: string | undefined): string | undefined {
  if (mode === undefined || mode === '') return undefined
  if (mode === 'identityFile') return '私钥文件'
  if (mode === 'identityPem') return '粘贴私钥'
  if (mode === 'password') return '密码'
  return mode
}

function hostLines(host: OpsAiHostContext): string[] {
  const lines: string[] = []
  const push = (label: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return
    lines.push(`- ${label}: ${String(value)}`)
  }
  push('hostId', host.hostId)
  push('SSH 目标', host.target)
  push('用户名', host.user)
  push('端口', host.port)
  push('ProxyJump', host.proxyJump)
  const auth = authModeLabel(typeof host.authMode === 'string' ? host.authMode : undefined)
  push('认证方式', auth)
  push('私钥路径', host.identityFile)
  if (host.hostKeyFingerprint !== undefined && host.hostKeyFingerprint !== '' && host.hostKeyFingerprint !== 'unapproved') {
    push('已批准主机密钥指纹', host.hostKeyFingerprint)
  }
  push('远端 Web 端口', host.remoteWebPort)
  return lines.length === 0 ? ['- （面板未提供主机字段）'] : lines
}

export function buildOpsAiPrompt(input: OpsAiFailureInput): string {
  const parts: string[] = [
    `请先阅读仓库文档 \`${THREADHARBOR_OPS_DOC_PATH}\`，再帮我排查 ThreadHarbor 主机运维问题。`,
    '',
    '## 场景',
    SCENARIO_LABEL[input.scenario],
  ]
  if (input.failedStep !== undefined && input.failedStep !== '') {
    parts.push('', '## 失败阶段', input.failedStepDetail === undefined || input.failedStepDetail === ''
      ? input.failedStep
      : `${input.failedStep} — ${input.failedStepDetail}`)
  }
  if (input.rawError !== undefined && input.rawError !== '') {
    parts.push('', '## 原始错误', input.rawError)
  }
  if (input.suggestedAction !== undefined && input.suggestedAction !== '') {
    parts.push('', '## 界面建议', input.suggestedAction)
  }
  if (input.operationId !== undefined && input.operationId !== '') {
    parts.push('', '## 操作 ID', input.operationId)
  }
  parts.push('', '## 主机上下文（不含密码、私钥内容与 launch token）', ...hostLines(input.host))
  return parts.join('\n')
}

export function hostContextFromSshInfo(hostId: string, ssh: HostSshInfo | undefined): OpsAiHostContext {
  if (ssh === undefined) return { hostId }
  return {
    hostId,
    target: ssh.target,
    ...(ssh.user === undefined ? {} : { user: ssh.user }),
    ...(ssh.port === undefined ? {} : { port: ssh.port }),
    ...(ssh.proxyJump === undefined ? {} : { proxyJump: ssh.proxyJump }),
    authMode: ssh.authMode,
    ...(ssh.identityFile === undefined ? {} : { identityFile: ssh.identityFile }),
    ...(ssh.hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint: ssh.hostKeyFingerprint }),
    ...(ssh.remoteWebPort === undefined ? {} : { remoteWebPort: ssh.remoteWebPort }),
  }
}

export function buildPeerCheckAiPrompt(
  report: PeerCheckReport | undefined,
  serveFailure: ServeFailure | undefined,
  host: OpsAiHostContext,
): string | undefined {
  const failedSteps = report?.steps.filter(step => step.state === 'fail') ?? []
  if (failedSteps.length === 0 && serveFailure === undefined) return undefined
  const first = failedSteps[0]
  const stepSummary = failedSteps.length === 0
    ? undefined
    : failedSteps.map(step => `${step.id} (${step.reason ?? 'fail'}${step.detail === undefined ? '' : `: ${step.detail}`})`).join('; ')
  const rawError = serveFailure?.error
    ?? (failedSteps.length === 0 ? undefined : stepSummary)
  return buildOpsAiPrompt({
    scenario: serveFailure === undefined ? 'peer-check' : 'peer-serve',
    ...(rawError === undefined ? {} : { rawError }),
    ...(first === undefined ? {} : { failedStep: first.id, failedStepDetail: first.detail ?? first.reason }),
    suggestedAction: serveFailure?.manualCommands === undefined
      ? '可在面板对失败项点对应动作或「重新检测」。'
      : '界面已列出需在对方手动执行的命令；执行后点「重新检测」。',
    host,
  })
}

export function failedPeerSteps(report: PeerCheckReport | undefined): readonly PeerCheckStep[] {
  return report?.steps.filter(step => step.state === 'fail') ?? []
}

export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
