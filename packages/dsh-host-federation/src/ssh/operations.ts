import { randomUUID } from 'node:crypto'
import type { SshDeployOperationView, SshDeployProgress, SshDeployResult } from './types.ts'

export class OperationStore {
  private readonly operations = new Map<string, SshDeployOperationView>()

  create(): SshDeployOperationView {
    const operationId = randomUUID()
    const view: SshDeployOperationView = {
      operationId,
      status: 'queued',
      progress: { phase: 'queued', detail: '等待开始……' },
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

  progress(operationId: string, progress: SshDeployProgress): void {
    const current = this.operations.get(operationId)
    if (current === undefined) return
    this.operations.set(operationId, {
      ...current,
      status: progress.phase === 'failed' ? 'failed' : progress.phase === 'succeeded' ? 'succeeded' : 'running',
      progress,
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

  fail(operationId: string, message: string, progress?: SshDeployProgress): void {
    this.update(operationId, {
      status: 'failed',
      progress: progress ?? { phase: 'failed', detail: message },
      error: message,
      finishedAt: Date.now(),
    })
  }
}
