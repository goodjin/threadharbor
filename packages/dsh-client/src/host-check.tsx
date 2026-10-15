/**
 * 对方状态检测清单：把 `/api/threadharbor.host-ssh.check` 的逐项结果画成
 * 一列状态行，每行带上能经 SSH 执行的动作按钮（部署、启动/重启、配置
 * tailscale serve、重新检测）。全部通过时给出「用 ts.net 地址保存」。
 *
 * 文案全部走 locale 字典（`panel.check.*`），本文件在 verify-client-ui-i18n
 * 的自检范围内（tests/ui-i18n.spec.ts）。
 */

import type { ReactNode } from 'react'
import type { PeerCheckAction, PeerCheckReport, PeerCheckStep } from '@threadharbor/dsh-host-federation'
import type { ClientLocaleKey, RuntimeT } from './locales.ts'
import type { ServeFailure } from './ssh-deploy.ts'
import styles from './panel.module.css'

/** One rendered row: localized label, state word, reason and the actions. */
export type PeerCheckRow = {
  readonly id: PeerCheckStep['id']
  readonly state: PeerCheckStep['state']
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
  return report.steps.map(step => {
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
  })
}

const STATE_MARK: Record<PeerCheckStep['state'], string> = { ok: '●', fail: '●', warn: '●', skip: '○' }

export function PeerCheckList(props: {
  readonly report: PeerCheckReport | undefined
  readonly busy: 'check' | PeerCheckAction | undefined
  /** serve 配置被拒（普通用户与 sudo -n 都不行）：列出需在对方手动执行的命令。 */
  readonly serveFailure?: ServeFailure | undefined
  readonly disabled: boolean
  readonly onCheck: () => void
  readonly onAction: (action: PeerCheckAction) => void
  readonly onSave: (launchUrl: string) => void
  readonly t: RuntimeT
}): ReactNode {
  const { report, t } = props
  const rows = report === undefined ? [] : peerCheckRows(report, t)
  return (
    <div data-peer-check="" className={styles.sshKeys}>
      <p className={styles.summary}>{t('panel.check.title')}</p>
      <p className={styles.note}>{t('panel.check.intro')}</p>
      {rows.map(row => (
        <div key={row.id} data-peer-check-step={row.id} data-state={row.state} className={styles.sshKeyRow}>
          <span className={row.state === 'fail' ? styles.stateBad : styles.stateLine}>
            {STATE_MARK[row.state]} {row.label} — {row.stateWord}{row.note === '' ? '' : `（${row.note}）`}
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
      {report !== undefined && !report.ready
        ? <p className={styles.stateLine}>{t('panel.check.notReady')}</p>
        : undefined}
    </div>
  )
}
