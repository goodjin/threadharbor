import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** npm stub: reports <root> as the global prefix, records a marker, and links codex/codex-acp. */
async function fakeNpm(root: string): Promise<string> {
  const npm = join(root, 'npm')
  await writeFile(npm, [
    '#!/usr/bin/env node',
    "const { mkdirSync, writeFileSync, chmodSync, rmSync } = require('node:fs')",
    "const { join } = require('node:path')",
    'const args = process.argv.slice(2)',
    `const prefix = ${JSON.stringify(root)}`,
    "if (args[0] === 'prefix') { process.stdout.write(prefix + '\\n'); process.exit(0) }",
    "const bin = join(prefix, 'bin')",
    'mkdirSync(bin, { recursive: true, mode: 0o700 })',
    "writeFileSync(join(prefix, 'npm-ran.marker'), 'ran\\n')",
    "for (const name of ['codex', 'codex-acp']) {",
    '  const dest = join(bin, name)',
    '  rmSync(dest, { force: true })',
    "  writeFileSync(dest, '#!/bin/sh\\n')",
    '  chmodSync(dest, 0o700)',
    '}',
    '',
  ].join('\n'))
  await chmod(npm, 0o700)
  return npm
}

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
    let challenge = manager.authStatus(started.flowId)
    for (let attempt = 0; attempt < 50 && challenge.verificationUri === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      challenge = manager.authStatus(started.flowId)
    }
    expect(challenge).toMatchObject({
      verificationUri: 'https://accounts.x.ai/device',
      userCode: 'ABCD-EFGH',
    })
    expect(['waiting-user', 'succeeded']).toContain(challenge.status)
    for (let attempt = 0; attempt < 40 && manager.authStatus(started.flowId).status !== 'succeeded'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
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

    const plan = await manager.installPlan('grok')
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
    const plan = await manager.installPlan('grok')
    expect(plan.alreadyInstalled).toBe(true)
    await expect(manager.install('grok')).resolves.toMatchObject({ alreadyInstalled: true })
  })

  it('plans and runs the official npm recipe for the DeepSeek Harness CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-dsh-npm-'))
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
      "if (!args.some(arg => arg.startsWith('@deepseek-ai/dsh@'))) process.exit(2)",
      "const dest = join(bin, 'threadharbor-test-dsh')",
      "writeFileSync(dest, '#!/bin/sh\\n')",
      'chmodSync(dest, 0o700)',
      '',
    ].join('\n'))
    await chmod(npm, 0o700)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      dshCommand: 'threadharbor-test-dsh',
      npmCommand: [process.execPath, npm],
    })

    const plan = await manager.installPlan('dsh')
    expect(plan).toMatchObject({ component: 'dsh', alreadyInstalled: false, requiresConfirmation: true })
    expect(plan.unavailableReason).toBeUndefined()
    expect(plan.steps[0]?.command).toBe('npm install -g @deepseek-ai/dsh@0.1.5-rc.1')
    expect(plan.steps[0]?.command).not.toContain('pip')

    const installed = await manager.install('dsh')
    expect(installed.alreadyInstalled).toBe(true)
    await expect(manager.resolvedDshLaunch()).resolves.toBe(join(root, 'bin', 'threadharbor-test-dsh'))
  })

  it('treats an installed DeepSeek Harness CLI as session-ready without a hostd-stored key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-dsh-ready-'))
    roots.push(root)
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const binDir = join(root, 'bin')
    await mkdir(binDir)
    const dsh = join(binDir, 'threadharbor-test-dsh')
    await writeFile(dsh, '#!/bin/sh\n')
    await chmod(dsh, 0o700)
    const npm = join(root, 'npm')
    await writeFile(npm, [
      '#!/usr/bin/env node',
      `if (process.argv[2] === 'prefix') { process.stdout.write(${JSON.stringify(root)} + '\\n'); process.exit(0) }`,
      'process.exit(9)',
      '',
    ].join('\n'))
    await chmod(npm, 0o700)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      dshCommand: 'threadharbor-test-dsh',
      npmCommand: [process.execPath, npm],
    })

    // Models and credentials belong to the host user's own DSH configuration, so
    // the CLI alone is what makes the backend ready: an absent hostd-stored key
    // must not gate session creation or report the backend as unauthenticated.
    const entry = (await manager.inventory(new Set())).find(candidate => candidate.backend === 'dsh')
    expect(entry).toMatchObject({ installed: true, authenticated: true, sessionCapable: true })
    expect(entry?.detail).toContain('DSH 配置')
    expect(manager.dshCredentialStatus()).toEqual({ configured: false })
    await expect(manager.installPlan('dsh')).resolves.toMatchObject({ alreadyInstalled: true })
    await expect(manager.resolvedDshLaunch()).resolves.toBe(dsh)
  })

  it('reads Codex and Grok login from local auth files without launching the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-auth-files-'))
    roots.push(root)
    vi.stubEnv('CODEX_HOME', '')
    vi.stubEnv('GROK_HOME', '')
    vi.stubEnv('CODEX_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    const marker = join(root, 'spawned')
    const executable = join(root, 'fake-cli')
    await writeFile(executable, ['#!/bin/sh', `printf spawned > '${marker}'`, 'exit 0', ''].join('\n'))
    await chmod(executable, 0o700)
    const manager = new AgentManager(options(root, executable))

    expect((await manager.inventory(new Set())).find(entry => entry.backend === 'codex'))
      .toMatchObject({ installed: true, authenticated: false })
    expect((await manager.inventory(new Set())).find(entry => entry.backend === 'grok'))
      .toMatchObject({ installed: true, authenticated: false })
    expect(existsSync(marker)).toBe(false)

    await mkdir(join(root, '.codex'), { mode: 0o700 })
    await writeFile(join(root, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'at', refresh_token: 'rt' },
    }))
    expect((await manager.inventory(new Set())).find(entry => entry.backend === 'codex'))
      .toMatchObject({ installed: true, authenticated: true })

    await mkdir(join(root, '.grok'), { mode: 0o700 })
    await writeFile(join(root, '.grok', 'auth.json'), JSON.stringify({
      'https://auth.x.ai::example': { refresh_token: 'rt', key: 'k' },
    }))
    expect((await manager.inventory(new Set())).find(entry => entry.backend === 'grok'))
      .toMatchObject({ installed: true, authenticated: true })
    expect(existsSync(marker)).toBe(false)
  })

  it('treats CODEX_API_KEY as Codex authentication without launching the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-codex-env-'))
    roots.push(root)
    vi.stubEnv('CODEX_HOME', '')
    vi.stubEnv('CODEX_API_KEY', 'sk-test')
    vi.stubEnv('OPENAI_API_KEY', '')
    const marker = join(root, 'spawned')
    const executable = join(root, 'fake-cli')
    await writeFile(executable, ['#!/bin/sh', `printf spawned > '${marker}'`, 'exit 0', ''].join('\n'))
    await chmod(executable, 0o700)
    const manager = new AgentManager(options(root, executable))
    expect((await manager.inventory(new Set())).find(entry => entry.backend === 'codex'))
      .toMatchObject({ installed: true, authenticated: true })
    expect(existsSync(marker)).toBe(false)
  })

  it('moves a foreign global bin aside and completes the install so one deploy click suffices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-eexist-relocate-'))
    roots.push(root)
    // Isolate from agent binaries that may exist on this host's PATH.
    vi.stubEnv('PATH', join(root, 'empty-path'))
    // A foreign package (codex-cli, as seen on jin's Mac mini) already owns the `codex` bin name.
    const foreign = join(root, 'lib', 'node_modules', 'codex-cli', 'bin', 'codex')
    await mkdir(dirname(foreign), { recursive: true })
    await writeFile(foreign, '#!/bin/sh\n')
    await chmod(foreign, 0o700)
    const bin = join(root, 'bin')
    await mkdir(bin)
    await symlink(foreign, join(bin, 'codex'))
    const npm = await fakeNpm(root)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      codexCliCommand: 'codex',
      codexAcpCommand: 'codex-acp',
      npmCommand: [process.execPath, npm],
    })

    // The reviewable plan previews the relocation step before the npm command.
    const plan = await manager.installPlan('codex')
    const backupPath = join(bin, 'codex.threadharbor-backup')
    expect(plan.steps[0]?.command).toBe(`mv '${join(bin, 'codex')}' '${backupPath}'`)
    expect(plan.steps[1]?.command).toContain('npm install -g @openai/codex')

    // One install call: the conflict is moved aside, npm installs the pinned
    // packages, and the agent ends fully installed instead of failing EEXIST.
    const installed = await manager.install('codex')
    expect(installed.alreadyInstalled).toBe(true)
    expect(existsSync(join(root, 'npm-ran.marker'))).toBe(true)
    // The foreign tool keeps its file at the backup name; npm now owns `codex`.
    expect(existsSync(backupPath)).toBe(true)
    expect(existsSync(join(bin, 'codex'))).toBe(true)
  })

  it('restores a moved foreign bin when npm itself still fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-eexist-restore-'))
    roots.push(root)
    // Isolate from agent binaries that may exist on this host's PATH.
    vi.stubEnv('PATH', join(root, 'empty-path'))
    const foreign = join(root, 'lib', 'node_modules', 'codex-cli', 'bin', 'codex')
    await mkdir(dirname(foreign), { recursive: true })
    await writeFile(foreign, '#!/bin/sh\n')
    await chmod(foreign, 0o700)
    const bin = join(root, 'bin')
    await mkdir(bin)
    await symlink(foreign, join(bin, 'codex'))
    const npm = join(root, 'npm')
    await writeFile(npm, [
      '#!/usr/bin/env node',
      "const { join } = require('node:path')",
      'const args = process.argv.slice(2)',
      `const prefix = ${JSON.stringify(root)}`,
      "if (args[0] === 'prefix') { process.stdout.write(prefix + '\\n'); process.exit(0) }",
      "process.stderr.write('boom\\n')",
      'process.exit(1)',
      '',
    ].join('\n'))
    await chmod(npm, 0o700)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      codexCliCommand: 'codex',
      codexAcpCommand: 'codex-acp',
      npmCommand: [process.execPath, npm],
    })

    const error = await manager.install('codex').then(() => undefined, (value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('installer exited with status 1')
    // The foreign shim is put back so the host is not left half-moved.
    expect(existsSync(join(bin, 'codex'))).toBe(true)
    expect(existsSync(join(bin, 'codex.threadharbor-backup'))).toBe(false)
  })

  it('allows an existing npm link that already targets the package being installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-eexist-own-link-'))
    roots.push(root)
    // Isolate from agent binaries that may exist on this host's PATH.
    vi.stubEnv('PATH', join(root, 'empty-path'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    // Prior hostd installs link into the same pinned packages; these must not block a reinstall.
    await symlink(join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(bin, 'codex'))
    await symlink(
      join(root, 'lib', 'node_modules', '@agentclientprotocol', 'codex-acp', 'bin', 'codex-acp.js'),
      join(bin, 'codex-acp'),
    )
    const npm = await fakeNpm(root)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      codexCliCommand: 'codex',
      codexAcpCommand: 'codex-acp',
      npmCommand: [process.execPath, npm],
    })

    const installed = await manager.install('codex')
    expect(installed.alreadyInstalled).toBe(true)
    expect(existsSync(join(root, 'npm-ran.marker'))).toBe(true)
  })

  it('translates a residual npm EEXIST failure when no conflict existed at preflight time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-eexist-fallback-'))
    roots.push(root)
    // Isolate from agent binaries that may exist on this host's PATH.
    vi.stubEnv('PATH', join(root, 'empty-path'))
    const npm = join(root, 'npm')
    await writeFile(npm, [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      'const args = process.argv.slice(2)',
      `const prefix = ${JSON.stringify(root)}`,
      "if (args[0] === 'prefix') { process.stdout.write(prefix + '\\n'); process.exit(0) }",
      // No `bin/codex` exists yet, so the preflight passes; npm itself then hits the conflict.
      "const bin = join(prefix, 'bin')",
      'mkdirSync(bin, { recursive: true })',
      "writeFileSync(join(bin, 'codex'), '#!/bin/sh\\n')",
      "process.stderr.write('npm error code EEXIST\\n')",
      "process.stderr.write('npm error path ' + join(bin, 'codex') + '\\n')",
      "process.stderr.write('npm error EEXIST: file already exists\\n')",
      'process.exit(1)',
      '',
    ].join('\n'))
    await chmod(npm, 0o700)
    const manager = new AgentManager({
      ...options(root, '/missing/agent'),
      codexCliCommand: 'codex',
      codexAcpCommand: 'codex-acp',
      npmCommand: [process.execPath, npm],
    })

    const error = await manager.install('codex').then(() => undefined, (value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('EEXIST')
    expect(message).toContain(join(root, 'bin', 'codex'))
    expect(message).toContain("mv '")
    expect(message).not.toContain('installer exited with status')
  })
})
