import type { ReactNode } from 'react'
import type { SshDeployOperationView, SshDeployProgress } from '@threadharbor/dsh-host-federation'
import type { RuntimeT } from './locales.ts'
import {
  deployFailureBanner,
  deployPhaseRows,
  stickyOperationHeadline,
  type BindFailureBanner,
  type DeployPhaseRow,
  type StepVisualState,
} from './ssh-bind-progress.ts'
import { CopyForAiButton } from './copy-for-ai-button.tsx'
import styles from './panel.module.css'

const STATE_MARK: Record<StepVisualState, string> = {
  ok: '●',
  fail: '●',
  warn: '●',
  skip: '○',
  pending: '○',
  running: '◐',
}

function rowClass(state: StepVisualState): string {
  const base = styles.stateLine ?? ''
  if (state === 'fail') return styles.stateBad ?? base
  if (state === 'running') return styles.progressRunning ?? base
  return base
}

export function BindFailurePanel(props: {
  readonly banner: BindFailureBanner
  readonly title: string
  readonly retryLabel?: string
  readonly onRetry?: () => void
  readonly retryDisabled?: boolean
  readonly dataMarker?: string
  readonly copyForAiPrompt?: string | undefined
  readonly onAiCopied?: (() => void) | undefined
  readonly onAiCopyFailed?: (() => void) | undefined
  readonly t?: RuntimeT
}): ReactNode {
  return (
    <div data-bind-failure={props.dataMarker ?? ''} className={styles.bindFailureBox}>
      <p className={styles.stateBad}>{props.title}</p>
      <p className={styles.stateLine}>
        <strong>{props.banner.stepLabel}</strong>
      </p>
      <code className={styles.launchUrlText}>{props.banner.rawError}</code>
      <p className={styles.bindNextAction}>{props.banner.nextAction}</p>
      {props.onRetry !== undefined || props.copyForAiPrompt !== undefined
        ? (
            <div className={styles.formActions}>
              {props.copyForAiPrompt !== undefined && props.t !== undefined
                ? (
                    <CopyForAiButton
                      prompt={props.copyForAiPrompt}
                      t={props.t}
                      dataAction="ssh-copy-for-ai"
                      onCopied={props.onAiCopied}
                      onCopyFailed={props.onAiCopyFailed}
                    />
                  )
                : undefined}
              {props.onRetry !== undefined
                ? (
                    <button type="button" className={styles.action} data-action="ssh-deploy-retry" disabled={props.retryDisabled === true} onClick={props.onRetry}>
                      {props.retryLabel ?? ''}
                    </button>
                  )
                : undefined}
            </div>
          )
        : undefined}
    </div>
  )
}

export function DeployProgressBoard(props: {
  readonly running: boolean
  readonly failed: boolean
  readonly progress: SshDeployProgress | undefined
  readonly log: readonly SshDeployProgress[]
  readonly error?: string | undefined
  readonly onRetry?: () => void
  readonly retryDisabled?: boolean
  readonly copyForAiPrompt?: string | undefined
  readonly onAiCopied?: (() => void) | undefined
  readonly onAiCopyFailed?: (() => void) | undefined
  readonly t: RuntimeT
}): ReactNode {
  if (!props.running && props.log.length === 0 && !props.failed) return undefined
  const current = props.progress?.phase ?? props.log[props.log.length - 1]?.phase ?? 'connecting'
  const rows = deployPhaseRows(current, props.log, props.failed, props.t)
  const headline = stickyOperationHeadline('deploy', props.progress, props.running ? 'deploy' : undefined, props.t)
  const failure = props.failed && props.error !== undefined ? deployFailureBanner(props.log, props.error, props.t) : undefined

  return (
    <div data-ssh-deploy-progress="" data-ssh-progress-log="" className={styles.bindProgressSticky}>
      <p className={styles.summary}>{props.t('panel.ssh.progressBoardTitle')}</p>
      <p data-ssh-progress-current="" className={styles.progressCurrent}>{headline}</p>
      {rows.map(row => (
        <PhaseRow key={row.phase} row={row} />
      ))}
      {failure !== undefined
        ? (
            <div data-ssh-error="">
              <BindFailurePanel
                banner={failure}
                title={props.t('panel.ssh.failedTitle')}
                retryLabel={props.t('panel.ssh.retry')}
                {...(props.onRetry === undefined ? {} : { onRetry: props.onRetry })}
                {...(props.retryDisabled === undefined ? {} : { retryDisabled: props.retryDisabled })}
                copyForAiPrompt={props.copyForAiPrompt}
                onAiCopied={props.onAiCopied}
                onAiCopyFailed={props.onAiCopyFailed}
                t={props.t}
                dataMarker="deploy"
              />
            </div>
          )
        : undefined}
      {props.log.length > 0
        ? (
            <details className={styles.progressLogDetails}>
              <summary>{props.t('panel.ssh.progressLogTitle')}</summary>
              {props.log.map((line, index) => (
                <p key={index} className={styles.stateLine} data-ssh-progress-line={line.phase}>{line.detail}</p>
              ))}
            </details>
          )
        : undefined}
    </div>
  )
}

function PhaseRow(props: { readonly row: DeployPhaseRow }): ReactNode {
  const { row } = props
  return (
    <div data-ssh-deploy-phase={row.phase} data-state={row.state} className={styles.sshKeyRow}>
      <span className={rowClass(row.state)}>
        {STATE_MARK[row.state]} {row.label}
        {row.detail === '' ? '' : ` — ${row.detail}`}
      </span>
    </div>
  )
}

export function CheckOperationHeadline(props: {
  readonly operation: SshDeployOperationView | undefined
  readonly busy: 'check' | undefined
  readonly t: RuntimeT
}): ReactNode {
  if (props.operation === undefined && props.busy === undefined) return undefined
  const text = stickyOperationHeadline('check', props.operation?.progress, props.busy ?? (props.operation?.status === 'running' ? 'check' : undefined), props.t)
  return (
    <p data-peer-check-current="" className={styles.progressCurrent}>{text}</p>
  )
}
