import { describe, expect, it } from 'vitest'
import type { PeerCheckReport, SshDeployProgress } from '@threadharbor/dsh-host-federation'
import {
  deployFailureBanner,
  deployPhaseRows,
  lastDeployWorkPhase,
  peerCheckVisualSteps,
} from '../src/ssh-bind-progress.ts'
import { en, fallbackT } from '../src/locales.ts'

const enT = (key: keyof typeof en): string => en[key]

describe('deploy phase rows', () => {
  const log: readonly SshDeployProgress[] = [
    { phase: 'connecting', detail: 'connecting…' },
    { phase: 'installing', detail: 'installing…' },
  ]

  it('marks earlier phases ok and the active phase running', () => {
    const rows = deployPhaseRows('installing', log, false, fallbackT)
    const connecting = rows.find(row => row.phase === 'connecting')
    const installing = rows.find(row => row.phase === 'installing')
    const verifying = rows.find(row => row.phase === 'verifying')
    expect(connecting?.state).toBe('ok')
    expect(installing?.state).toBe('running')
    expect(verifying?.state).toBe('pending')
  })

  it('marks the last work phase failed when deploy failed', () => {
    expect(lastDeployWorkPhase(log)).toBe('installing')
    const banner = deployFailureBanner(log, 'tar: EOF', enT)
    expect(banner.stepLabel).toBe(en['panel.ssh.phase.installing'])
    expect(banner.rawError).toContain('tar: EOF')
    expect(banner.nextAction).toContain('install log')
  })
})

describe('peer check visual steps while operation runs', () => {
  const partial = {
    ready: false,
    facts: {} as PeerCheckReport['facts'],
    steps: [
      { id: 'ssh', state: 'ok', actions: [] },
      { id: 'tailscale', state: 'ok', actions: [] },
      { id: 'node', state: 'fail', reason: 'not-installed', actions: ['retry'] },
    ],
  } as PeerCheckReport

  it('lights https while the host probes ts.net', () => {
    const visuals = peerCheckVisualSteps(partial, 'check', {
      operationId: 'x',
      kind: 'check',
      status: 'running',
      progress: { phase: 'check-https', detail: 'probing' },
      startedAt: 1,
    }, fallbackT)
    expect(visuals.find(row => row.id === 'ssh')?.state).toBe('ok')
    expect(visuals.find(row => row.id === 'https')?.state).toBe('running')
  })
})
