import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildLivenessProbe, classifyLiveness, decidePeerReport } from '../src/ssh/liveness.ts'

describe('buildLivenessProbe', () => {
  it('probes the DSH web process on 127.0.0.1 at the given port', () => {
    const script = buildLivenessProbe(3081)
    expect(script).toContain('127.0.0.1')
    expect(script).toContain('3081')
  })

  it('tries curl first, then node, prints UNKNOWN when neither exists, and verdicts by exit code', () => {
    const script = buildLivenessProbe(3081)
    expect(script).toContain('command -v curl')
    expect(script).toContain('command -v node')
    expect(script.indexOf('command -v curl')).toBeLessThan(script.indexOf('command -v node'))
    expect(script.indexOf('command -v node')).toBeLessThan(script.lastIndexOf('UNKNOWN'))
    expect(script).toContain('RUNNING')
    expect(script).toContain('STOPPED')
  })

  it('never mentions tailscale', () => {
    expect(buildLivenessProbe(3081)).not.toContain('tailscale')
  })
})

describe('classifyLiveness', () => {
  it('reads exit 0 as running for any HTTP answer, including 401/403', () => {
    expect(classifyLiveness({ code: 0, stdout: '200' })).toEqual({ liveness: 'running' })
    expect(classifyLiveness({ code: 0, stdout: '401' })).toEqual({ liveness: 'running' })
    expect(classifyLiveness({ code: 0, stdout: '403' })).toEqual({ liveness: 'running' })
  })

  it('reads exit 7 (connection refused) as stopped', () => {
    expect(classifyLiveness({ code: 7, stdout: '000' })).toEqual({ liveness: 'stopped' })
  })

  it('never calls a timeout (exit 28) stopped and notes the exit code', () => {
    const verdict = classifyLiveness({ code: 28, stdout: '000' })
    expect(verdict.liveness).toBe('unknown')
    expect(verdict.note).toContain('28')
  })

  it('reads a remote UNKNOWN print (no curl, no node) as unknown', () => {
    expect(classifyLiveness({ code: 1, stdout: 'UNKNOWN' })).toEqual({ liveness: 'unknown' })
  })
})

describe('decidePeerReport', () => {
  it('reports undeployed with unknown liveness when plugins are not installed, whatever the probe says', () => {
    expect(decidePeerReport({ pluginsInstalled: false }, undefined))
      .toEqual({ pluginsInstalled: false, liveness: 'unknown' })
    expect(decidePeerReport({ pluginsInstalled: false }, { code: 0, stdout: 'RUNNING' }))
      .toEqual({ pluginsInstalled: false, liveness: 'unknown' })
  })

  it('keeps an installed record without a port deployed but unknown, noting the missing port', () => {
    const report = decidePeerReport({ pluginsInstalled: true }, undefined)
    expect(report.liveness).toBe('unknown')
    expect(report.livenessNote).toContain('端口')
  })

  it('lets the probe decide for an installed peer with a port', () => {
    expect(decidePeerReport({ pluginsInstalled: true, port: 3081 }, { code: 0, stdout: 'RUNNING' }))
      .toEqual({ pluginsInstalled: true, port: 3081, liveness: 'running' })
    expect(decidePeerReport({ pluginsInstalled: true, port: 3081 }, { code: 7, stdout: 'STOPPED' }))
      .toEqual({ pluginsInstalled: true, port: 3081, liveness: 'stopped' })
    expect(decidePeerReport({ pluginsInstalled: true, port: 3081 }, { code: 28, stdout: '000' }).liveness)
      .toBe('unknown')
  })
})

describe('readPeer budget', () => {
  it('caps the SSH read at 8 seconds so expiry reads as unknown with a timeout note, never stopped', () => {
    const source = readFileSync(new URL('../src/ssh/manager.ts', import.meta.url), 'utf8')
    expect(source).toContain('PEER_READ_BUDGET_MS = 8_000')
    expect(source).toContain('Math.min(this.handshakeBudgetMs(), PEER_READ_BUDGET_MS)')
    expect(source).toContain('读取超时')
  })
})
