/**
 * 对方状态检测清单：把 `/api/threadharbor.host-ssh.check` 的逐项结果画成
 * 一列状态行，每行带上能经 SSH 执行的动作按钮（部署、启动/重启、配置
 * tailscale serve、重新检测）。全部通过时给出「用 ts.net 地址保存」。
 *
 * 文案全部走 locale 字典（`panel.check.*`），本文件在 verify-client-ui-i18n
 * 的自检范围内（tests/ui-i18n.spec.ts）。
 */

import type { ReactNode } from 'react'
import type { PeerCheckAction, PeerCheckReport, PeerCheckStep, SshDeployOperationView } from '@threadharbor/dsh-host-federation'
import type { ClientLocaleKey, RuntimeT } from './locales.ts'
import type { ServeFailure } from './ssh-deploy.ts'
import type { OpsAiHostContext } from './copy-for-ai.ts'
import { buildPeerCheckAiPrompt } from './copy-for-ai.ts'
import { CopyForAiButton } from './copy-for-ai-button.tsx'
import {
  checkFailureFromReport,
  peerCheckVisualSteps,
  type CheckBusyKind,
} from './ssh-bind-progress.ts'
import { BindFailurePanel, CheckOperationHeadline } from './ssh-bind-progress-ui.tsx'
import styles from './panel.module.css'

/** One rendered row: localized label, state word, reason and the actions. */
export type PeerCheckRow = {
  readonly id: PeerCheckStep['id']
  readonly state: PeerCheckStep['state'] | 'pending' | 'running'
  readonly label: string
  readonly stateWord: string
  readonly note: string
  readonly actions: readonly { readonly action: PeerCheckAction; readonly label: string }[]
}

/**
 * Turn a report into display rows. Pure, so the copy mapping is testable.
 * `retry` is not repeated per row; the list has one global re-check button.
 */
export function peerCheckRows(report: PeerCheckReport, t: RuntimeT): readonly PeerCheckRow[] {
  return report.steps.map(step => rowFromStep(step, t))
}

function rowFromStep(step: PeerCheckStep, t: RuntimeT): PeerCheckRow {
  const reason = step.reason === undefined ? '' : t(`panel.check.reason.${step.reason}` as ClientLocaleKey)
  const note = [reason.startsWith('panel.check.') ? step.reason ?? '' : reason, step.detail ?? '']
    .filter(part => part !== '')
    .join(' · ')
  return {
    id: step.id,
    state: step.state,
    label: t(`panel.check.step.${step.id}` as ClientLocaleKey),
    stateWord: t(`panel.check.state.${step.state}` as ClientLocaleKey),
    note,
    actions: step.state === 'skip'
      ? []
      : step.actions
        .filter(action => action !== 'retry')
        .map(action => ({ action, label: t(`panel.check.action.${action}` as ClientLocaleKey) })),
  }
}

export function peerCheckRowsInFlight(
  report: PeerCheckReport | undefined,
  busy: CheckBusyKind,
  operation: SshDeployOperationView | undefined,
  t: RuntimeT,
): readonly PeerCheckRow[] {
  const visuals = peerCheckVisualSteps(report, busy, operation, t)
  return visuals.map(item => {
    if (item.step !== undefined) {
      const row = rowFromStep(item.step, t)
      if (item.state === 'running') return { ...row, state: 'running', stateWord: t('panel.check.state.running') }
      if (item.state === 'pending') return { ...row, state: 'pending', stateWord: t('panel.check.state.pending'), note: '', actions: [] }
      return row
    }
    return {
      id: item.id,
      state: item.state === 'running' ? 'running' : 'pending',
      label: t(`panel.check.step.${item.id}` as ClientLocaleKey),
      stateWord: t(`panel.check.state.${item.state === 'running' ? 'running' : 'pending'}` as ClientLocaleKey),
      note: '',
      actions: [],
    }
  })
}

const STATE_MARK: Record<string, string> = {
  ok: '●',
  fail: '●',
  warn: '●',
  skip: '○',
  pending: '○',
  running: '◐',
}

export function PeerCheckList(props: {
  readonly report: PeerCheckReport | undefined
  readonly busy: CheckBusyKind
  readonly checkOperation?: SshDeployOperationView | undefined
  readonly checkError?: string | undefined
  /** serve 配置被拒（普通用户与 sudo -n 都不行）：列出需在对方手动执行的命令。 */
  readonly serveFailure?: ServeFailure | undefined
  readonly disabled: boolean
  readonly onCheck: () => void
  readonly onAction: (action: PeerCheckAction) => void
  readonly onSave: (launchUrl: string) => void
  readonly aiHostContext?: OpsAiHostContext | undefined
  readonly onCopied?: (() => void) | undefined
  readonly onCopyFailed?: (() => void) | undefined
  readonly t: RuntimeT
}): ReactNode {
  const { report, t } = props
  const inFlight = props.busy === 'check' || props.checkOperation?.status === 'running'
  const rows = inFlight
    ? peerCheckRowsInFlight(report, props.busy, props.checkOperation, t)
    : report?.steps === undefined ? [] : peerCheckRows(report, t)
  const failure = props.checkError !== undefined
    ? {
      stepLabel: t('panel.check.failNext.stepRequest'),
      rawError: props.checkError,
      nextAction: t('panel.check.failNext.generic'),
    }
    : report === undefined ? undefined : checkFailureFromReport(report, t)
  const aiPrompt = buildPeerCheckAiPrompt(report, props.serveFailure, props.aiHostContext ?? {})
  return (
    <div data-peer-check="" className={styles.bindProgressSticky}>
      <p className={styles.summary}>{t('panel.check.title')}</p>
      <p className={styles.note}>{t('panel.check.intro')}</p>
      <CheckOperationHeadline operation={props.checkOperation} busy={props.busy === 'check' ? 'check' : undefined} t={t} />
      {failure !== undefined && !inFlight
        ? (
            <BindFailurePanel
              banner={failure}
              title={t('panel.check.failedTitle')}
              retryLabel={t('panel.check.action.retry')}
              onRetry={props.onCheck}
              retryDisabled={props.disabled || props.busy !== undefined}
              dataMarker="check"
            />
          )
        : undefined}
      {rows.map(row => (
        <div key={row.id} data-peer-check-step={row.id} data-state={row.state} className={styles.sshKeyRow}>
          <span className={row.state === 'fail' ? styles.stateBad : row.state === 'running' ? styles.progressRunning : styles.stateLine}>
            {STATE_MARK[row.state] ?? '○'} {row.label} — {row.stateWord}{row.note === '' ? '' : `（${row.note}）`}
          </span>
          {row.actions.map(item => (
            <button
              key={item.action}
              type="button"
              className={row.state === 'fail' ? styles.actionPrimary : styles.action}
              data-action={`peer-${item.action}`}
              disabled={props.disabled || props.busy !== undefined}
              onClick={() => { props.onAction(item.action) }}
            >{props.busy === item.action ? t('panel.check.busyAction') : item.label}</button>
          ))}
        </div>
      ))}
      {props.serveFailure !== undefined
        ? (
            <div data-peer-serve-failure="" className={styles.launchUrlBox}>
              <p className={styles.stateBad}>{props.serveFailure.error}</p>
              {props.serveFailure.manualCommands !== undefined
                ? (
                    <>
                      <p className={styles.stateLine}>{t('panel.check.manualHint')}</p>
                      {props.serveFailure.manualCommands.map(command => (
                        <div key={command} className={styles.formActions}>
                          <code data-peer-manual-command="" className={styles.launchUrlText}>{command}</code>
                          <button
                            type="button"
                            className={styles.action}
                            data-action="peer-copy-command"
                            onClick={() => { void navigator.clipboard.writeText(command) }}
                          >{t('panel.check.copy')}</button>
                        </div>
                      ))}
                    </>
                  )
                : undefined}
            </div>
          )
        : undefined}
      <div className={styles.formActions}>
        {aiPrompt !== undefined
          ? (
              <CopyForAiButton
                prompt={aiPrompt}
                t={t}
                dataAction="peer-copy-for-ai"
                onCopied={props.onCopied}
                onCopyFailed={props.onCopyFailed}
              />
            )
          : undefined}
        <button
          type="button"
          className={styles.action}
          data-action="peer-check"
          disabled={props.disabled || props.busy !== undefined}
          onClick={props.onCheck}
        >{props.busy === 'check' ? t('panel.check.running') : report === undefined ? t('panel.check.run') : t('panel.check.action.retry')}</button>
        {report?.ready === true && report.serveLaunchUrl !== undefined
          ? (
              <button
                type="button"
                className={styles.actionPrimary}
                data-action="peer-save-serve"
                disabled={props.busy !== undefined}
                onClick={() => { props.onSave(report.serveLaunchUrl ?? '') }}
              >{t('panel.check.save')}</button>
            )
          : undefined}
      </div>
      {report !== undefined && !report.ready && !inFlight
        ? <p className={styles.stateLine}>{t('panel.check.notReady')}</p>
        : undefined}
    </div>
  )
}
