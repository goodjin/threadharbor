import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentManager, type AgentManagerOptions } from '../src/agent-manager.ts'

const roots: string[] = []

function options(root: string, command: string): AgentManagerOptions {
  return {
    installTimeoutMs: 3000,
    authTimeoutMs: 3000,
    agentConfigHome: root,
    maxAgentConfigBytes: 4096,
    codexCliCommand: command,
    codexAcpCommand: command,
    claudeCommand: command,
    claudeAcpCommand: command,
    grokCommand: command,
    dshCommand: '/missing/dsh',
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('AgentManager', () => {
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

  it('returns a reviewable online install plan and runs the official npm -g recipe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-npm-'))
    roots.push(root)
    const npm = join(root, 'npm')
    await writeFile(npm, [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync, chmodSync } = require('node:fs')",
      "const { join } = require('node:path')",
      'const args = process.argv.slice(2)',
      `const prefix = ${JSON.stringify(root)}`,
      "if (args[0] === 'prefix') { process.stdout.write(prefix + '\\n'); process.exit(0) }",
      "const bin = join(prefix, 'bin')",
      'mkdirSync(bin, { recursive: true, mode: 0o700 })',
      "if (!args.includes('-g') && !args.includes('--global')) process.exit(3)",
      "if (!args.some(arg => arg.startsWith('@xai-official/grok'))) process.exit(2)",
      "const dest = join(bin, 'threadharbor-test-grok')",
      "writeFileSync(dest, '#!/bin/sh\\n')",
      'chmodSync(dest, 0o700)',
      '',
    ].join('\n'))
    await chmod(npm, 0o700)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      grokCommand: 'threadharbor-test-grok',
      npmCommand: [process.execPath, npm],
    })

    const plan = manager.installPlan('grok')
    expect(plan).toMatchObject({
      component: 'grok', alreadyInstalled: false, requiresConfirmation: true,
    })
    expect(plan.unavailableReason).toBeUndefined()
    expect(plan.steps[0]?.command).toBe('npm install -g @xai-official/grok@1.0.5')
    expect(plan.steps[0]?.command).not.toContain('--prefix')
    expect(plan.steps[0]?.command).not.toContain('--offline')

    const installed = await manager.install('grok')
    expect(installed.alreadyInstalled).toBe(true)
  })

  it('does not spawn an installer when the agent is already on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-skip-'))
    roots.push(root)
    const npm = join(root, 'npm')
    await writeFile(npm, '#!/bin/sh\nexit 9\n')
    await chmod(npm, 0o700)
    const manager = new AgentManager({
      ...options(root, process.execPath),
      grokCommand: process.execPath,
      npmCommand: [npm],
    })
    const plan = manager.installPlan('grok')
    expect(plan.alreadyInstalled).toBe(true)
    await expect(manager.install('grok')).resolves.toMatchObject({ alreadyInstalled: true })
  })

  it('installs DSH with the official pip --user command and discovers it in the pip scripts directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-dsh-'))
    roots.push(root)
    const scripts = join(root, 'scripts')
    await mkdir(scripts)
    const python = join(root, 'python')
    await writeFile(python, [
      '#!/bin/sh',
      'if [ "$1" = "-m" ]; then',
      `  printf '%s\\n' '#!/bin/sh' > '${scripts}/dsh-jsonrpc-agent'`,
      `  chmod 700 '${scripts}/dsh-jsonrpc-agent'`,
      '  exit 0',
      'fi',
      'if [ "$1" = "-c" ]; then',
      `  printf '%s\\n' '${scripts}'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'))
    await chmod(python, 0o700)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      dshCommand: 'dsh-jsonrpc-agent',
      pythonCommand: python,
    })
    const plan = manager.installPlan('dsh')
    expect(plan.version).toBe('deepseek-harness-runtime-bin==0.1.1rc1')
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.command).toContain('pip install --user --upgrade')
    const installed = await manager.install('dsh')
    expect(installed.alreadyInstalled).toBe(true)
  })
})
