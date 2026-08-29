import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentManager, type AgentManagerOptions, requireInstallConfirmation } from '../src/agent-manager.ts'

const roots: string[] = []

function options(root: string, command: string): AgentManagerOptions {
  return {
    installPrefix: join(root, 'install'),
    installTimeoutMs: 1000,
    authTimeoutMs: 3000,
    codexCliCommand: command,
    codexAcpCommand: command,
    codexPackage: '@openai/codex@test',
    codexAcpPackage: '@agentclientprotocol/codex-acp@test',
    claudeCommand: command,
    claudePackage: '@anthropic-ai/claude-code@test',
    grokCommand: command,
    dshCommand: '/missing/dsh',
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('AgentManager', () => {
  it('returns fixed reviewable recipes and refuses an unconfigured Grok distribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-plan-'))
    roots.push(root)
    const manager = new AgentManager(options(root, '/missing/agent'))

    expect(manager.installPlan('codex')).toMatchObject({
      component: 'codex', requiresConfirmation: true, alreadyInstalled: false,
      steps: [{ command: expect.stringContaining('@openai/codex@test') }],
    })
    expect(manager.installPlan('grok')).toMatchObject({ steps: [], unavailableReason: expect.any(String) })
    expect(() => requireInstallConfirmation(false)).toThrow('confirm: true')
  })

  it('keeps a device login worker alive and exposes only its URL, code, and status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-auth-'))
    roots.push(root)
    const executable = join(root, 'fake-agent')
    await writeFile(executable, [
      '#!/bin/sh',
      "printf '%s\\n' 'Open https://accounts.x.ai/device and enter confirmation code ABCD-EFGH'",
      'sleep 1',
      '',
    ].join('\n'))
    await chmod(executable, 0o700)
    const manager = new AgentManager(options(root, executable))

    const started = manager.startAuth('grok')
    for (let attempt = 0; attempt < 20 && manager.authStatus(started.flowId).status === 'starting'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const challenge = manager.authStatus(started.flowId)
    expect(challenge).toMatchObject({
      verificationUri: 'https://accounts.x.ai/device',
      userCode: 'ABCD-EFGH',
    })
    expect(['waiting-user', 'succeeded']).toContain(challenge.status)
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(manager.authStatus(started.flowId)).toMatchObject({ status: 'succeeded' })
  })
})
