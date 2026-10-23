import { randomUUID } from 'node:crypto'
import type { PeerCheckReport } from './peer-check.ts'
import type { SshDeployOperationView, SshDeployProgress, SshDeployResult, SshOperationKind } from './types.ts'

export class OperationStore {
  private readonly operations = new Map<string, SshDeployOperationView>()

  create(kind: SshOperationKind = 'deploy'): SshDeployOperationView {
    const operationId = randomUUID()
    const view: SshDeployOperationView = {
      operationId,
      kind,
      status: 'queued',
      progress: { phase: 'queued', detail: kind === 'check' ? '等待开始检测……' : '等待开始……' },
      startedAt: Date.now(),
    }
    this.operations.set(operationId, view)
    return view
  }

  get(operationId: string): SshDeployOperationView | undefined {
    return this.operations.get(operationId)
  }

  list(): readonly SshDeployOperationView[] {
    return [...this.operations.values()].sort((left, right) => right.startedAt - left.startedAt)
  }

  update(operationId: string, patch: Partial<SshDeployOperationView>): SshDeployOperationView {
    const current = this.operations.get(operationId)
    if (current === undefined) throw new Error(`unknown operation ${operationId}`)
    const next = { ...current, ...patch }
    this.operations.set(operationId, next)
    return next
  }

  progress(operationId: string, progress: SshDeployProgress, checkReport?: PeerCheckReport): void {
    const current = this.operations.get(operationId)
    if (current === undefined) return
    this.operations.set(operationId, {
      ...current,
      status: progress.phase === 'failed' ? 'failed' : progress.phase === 'succeeded' ? 'succeeded' : 'running',
      progress,
      ...(checkReport === undefined ? {} : { checkReport }),
    })
  }

  succeed(operationId: string, result: SshDeployResult): void {
    this.update(operationId, {
      status: 'succeeded',
      progress: { phase: 'succeeded', detail: '部署完成。' },
      result,
      finishedAt: Date.now(),
    })
  }

  succeedCheck(operationId: string, report: PeerCheckReport): void {
    this.update(operationId, {
      status: 'succeeded',
      progress: { phase: 'succeeded', detail: '检测完成。' },
      checkReport: report,
      finishedAt: Date.now(),
    })
  }

  fail(operationId: string, message: string, progress?: SshDeployProgress, checkReport?: PeerCheckReport): void {
    this.update(operationId, {
      status: 'failed',
      progress: progress ?? { phase: 'failed', detail: message },
      error: message,
      ...(checkReport === undefined ? {} : { checkReport }),
      finishedAt: Date.now(),
    })
  }
}
