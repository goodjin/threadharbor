/**
 * Pure helpers: map deploy / peer-check operations to checklist rows the UI can
 * render while work is in flight (pending → running → ok/fail).
 */

import type {
  PeerCheckAction,
  PeerCheckReport,
  PeerCheckStep,
  PeerCheckStepId,
  SshDeployOperationView,
  SshDeployPhase,
  SshDeployProgress,
} from '@threadharbor/dsh-host-federation'
import type { ClientLocaleKey, RuntimeT } from './locales.ts'

export const PEER_CHECK_STEP_ORDER: readonly PeerCheckStepId[] = [
  'ssh',
  'tailscale',
  'node',
  'dsh',
  'plugins',
  'running',
  'serve',
  'https',
]

/** User-visible deploy phases in order (tunnel step omitted when not used). */
export const DEPLOY_PHASE_ORDER: readonly SshDeployPhase[] = [
  'connecting',
  'preparing',
  'uploading',
  'installing',
  'starting',
  'opening-tunnel',
  'verifying',
]

export type StepVisualState = 'pending' | 'running' | 'ok' | 'fail' | 'skip' | 'warn'

export type DeployPhaseRow = {
  readonly phase: SshDeployPhase
  readonly label: string
  readonly state: StepVisualState
  readonly detail: string
}

export type BindFailureBanner = {
  readonly stepLabel: string
  readonly rawError: string
  readonly nextAction: string
}

const deployPhaseIndex = (phase: SshDeployPhase): number => {
  if (phase === 'queued') return -1
  if (phase === 'failed' || phase === 'succeeded') {
    return DEPLOY_PHASE_ORDER.length
  }
  const index = DEPLOY_PHASE_ORDER.indexOf(phase)
  return index >= 0 ? index : DEPLOY_PHASE_ORDER.length - 1
}

/** Last non-terminal phase seen in the progress log (used when status is failed). */
export function lastDeployWorkPhase(log: readonly SshDeployProgress[]): SshDeployPhase {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const phase = log[i]?.phase
    if (phase === undefined || phase === 'failed' || phase === 'succeeded' || phase === 'queued') continue
    return phase
  }
  return 'connecting'
}

export function deployPhaseRows(
  current: SshDeployPhase,
  log: readonly SshDeployProgress[],
  failed: boolean,
  t: RuntimeT,
): readonly DeployPhaseRow[] {
  const active = failed ? lastDeployWorkPhase(log) : current
  const activeIndex = deployPhaseIndex(active)
  const detailFor = (phase: SshDeployPhase): string => {
    for (let i = log.length - 1; i >= 0; i -= 1) {
      if (log[i]?.phase === phase) return log[i]?.detail ?? ''
    }
    return ''
  }
  const sawTunnel = log.some(line => line.phase === 'opening-tunnel')
  const hideTunnel = !sawTunnel && deployPhaseIndex(active) > deployPhaseIndex('installing') && active !== 'opening-tunnel'

  return DEPLOY_PHASE_ORDER.filter(phase => !(hideTunnel && phase === 'opening-tunnel')).map(phase => {
    const index = deployPhaseIndex(phase)
    let state: StepVisualState = 'pending'
    if (failed && index === activeIndex) state = 'fail'
    else if (index < activeIndex) state = 'ok'
    else if (index === activeIndex && !failed) state = 'running'
    return {
      phase,
      label: t(`panel.ssh.phase.${phase}` as ClientLocaleKey),
      state,
      detail: state === 'running' || state === 'fail' ? detailFor(phase) : '',
    }
  })
}

export function deployFailureBanner(
  log: readonly SshDeployProgress[],
  error: string,
  t: RuntimeT,
): BindFailureBanner {
  const phase = lastDeployWorkPhase(log)
  const stepLabel = t(`panel.ssh.phase.${phase}` as ClientLocaleKey)
  const nextKey = `panel.ssh.failNext.${phase}` as ClientLocaleKey
  const nextAction = t(nextKey)
  return {
    stepLabel,
    rawError: error,
    nextAction: nextAction.startsWith('panel.ssh.') ? t('panel.ssh.failNext.generic') : nextAction,
  }
}

export function checkFailureFromReport(report: PeerCheckReport, t: RuntimeT): BindFailureBanner | undefined {
  const failed = report.steps.find(step => step.state === 'fail')
  if (failed === undefined) return undefined
  const label = t(`panel.check.step.${failed.id}` as ClientLocaleKey)
  const reason = failed.reason === undefined ? '' : t(`panel.check.reason.${failed.reason}` as ClientLocaleKey)
  const raw = [reason.startsWith('panel.check.') ? failed.reason ?? '' : reason, failed.detail ?? ''].filter(part => part !== '').join(' · ')
  const action = failed.actions[0]
  const nextAction = action === undefined
    ? t('panel.check.failNext.generic')
    : t(`panel.check.failNext.${action}` as ClientLocaleKey)
  return { stepLabel: label, rawError: raw === '' ? t('panel.check.state.fail') : raw, nextAction }
}

export type CheckBusyKind = 'check' | PeerCheckAction | 'deploy' | undefined

/** Merge a (possibly partial) report with in-flight operation progress for the checklist. */
export function peerCheckVisualSteps(
  report: PeerCheckReport | undefined,
  busy: CheckBusyKind,
  operation: SshDeployOperationView | undefined,
  t: RuntimeT,
): readonly { readonly id: PeerCheckStepId; readonly state: StepVisualState; readonly step: PeerCheckStep | undefined }[] {
  const fromReport = new Map<PeerCheckStepId, PeerCheckStep>()
  for (const step of report?.steps ?? []) fromReport.set(step.id, step)

  const runningCheck = busy === 'check' || (operation?.kind === 'check' && operation.status === 'running')
  const checkPhase = operation?.progress.phase

  return PEER_CHECK_STEP_ORDER.map(id => {
    const step = fromReport.get(id)
    if (step !== undefined && !runningCheck) {
      const state: StepVisualState = step.state === 'ok' ? 'ok' : step.state === 'fail' ? 'fail' : step.state === 'warn' ? 'warn' : 'skip'
      return { id, state, step }
    }
    if (!runningCheck) return { id, state: 'pending' as StepVisualState, step: undefined }

    if (checkPhase === 'connecting' && id === 'ssh') return { id, state: 'running', step }
    if (checkPhase === 'check-remote' && id !== 'https') {
      if (step !== undefined && step.state !== 'skip') {
        const state: StepVisualState = step.state === 'ok' ? 'ok' : step.state === 'fail' ? 'fail' : step.state === 'warn' ? 'warn' : 'running'
        return { id, state, step }
      }
      if (id === 'ssh') return { id, state: 'running', step }
      return { id, state: 'pending', step }
    }
    if (checkPhase === 'check-https') {
      if (step !== undefined && step.id !== 'https') {
        const state: StepVisualState = step.state === 'ok' ? 'ok' : step.state === 'fail' ? 'fail' : step.state === 'warn' ? 'warn' : 'skip'
        return { id, state, step }
      }
      return { id, state: id === 'https' ? 'running' : (fromReport.get(id)?.state === 'ok' ? 'ok' : 'pending'), step }
    }
    if (id === 'ssh') return { id, state: 'running', step }
    return { id, state: 'pending', step }
  })
}

export function stickyOperationHeadline(
  kind: 'deploy' | 'check',
  progress: SshDeployProgress | undefined,
  busy: CheckBusyKind,
  t: RuntimeT,
): string {
  if (progress?.detail !== undefined && progress.detail !== '') return progress.detail
  if (kind === 'check') {
    if (busy === 'check') return t('panel.check.running')
    if (busy !== undefined && busy !== 'deploy') return t('panel.check.busyAction')
  }
  if (busy === 'deploy') return t('panel.ssh.deploying')
  return kind === 'check' ? t('panel.check.running') : t('panel.ssh.deploying')
}

export function operationFailed(view: SshDeployOperationView | undefined): boolean {
  return view?.status === 'failed'
}
