/**
 * 「读远端启动网址」的行为测试。
 *
 * 不连真 SSH：manager 走真的 spawn('ssh')，我们在 PATH 前面放一个假 ssh
 * 可执行文件充当远端执行面（manager 的 exec 面是 private 的，没有注入点）。
 * 假 ssh 把收到的参数记账到 argv.txt，然后按用例二选一产出结果——
 * 回放给定 stdout（解析行为），或把收到的远端脚本交给真 sh 执行
 * （拼装行为：~ 展开与引号处理必须在真 shell 里成立，单引号包 ~ 的坑
 * 阶段 0 已实测过）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshSshManager } from '../src/ssh/manager.ts'
import type { SshConnectionConfig } from '../src/ssh/types.ts'

const roots: string[] = []
const savedPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = savedPath
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type FakeSshPlan = {
  /** 原样回放为远端 stdout 的内容。 */
  readonly stdout?: string
  /** 假 ssh 的退出码，默认 0。 */
  readonly code?: number
  /** 给定时：把收到的最后一段参数（远端脚本）交给真 sh 执行，HOME 指向该目录。 */
  readonly remoteHome?: string
}

async function installFakeSsh(root: string, plan: FakeSshPlan): Promise<void> {
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  if (plan.stdout !== undefined) await writeFile(join(root, 'stdout.txt'), plan.stdout)
  if (plan.remoteHome !== undefined) await mkdir(plan.remoteHome, { recursive: true })
  const lines = [
    '#!/bin/sh',
    '# 假 ssh：记账收到的 argv，再按用例回放 stdout/退出码，或真跑收到的远端脚本。',
    `printf '%s\\n' "$@" > '${root}/argv.txt'`,
  ]
  if (plan.remoteHome !== undefined) {
    lines.push(
      'for last in "$@"; do :; done',
      `export HOME='${plan.remoteHome}'`,
      'exec sh -c "$last"',
    )
  }
  if (plan.stdout !== undefined) lines.push(`cat '${root}/stdout.txt'`)
  lines.push(`exit ${plan.code ?? 0}`)
  await writeFile(join(bin, 'ssh'), `${lines.join('\n')}\n`, { mode: 0o755 })
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
}

function makeManager(root: string): DshSshManager {
  return new DshSshManager({
    knownHostsPath: join(root, 'known_hosts'),
    connectTimeoutMs: 100,
    installTimeoutMs: 100,
    deploymentChannel: 'test',
    defaultRemoteWebPort: 3081,
  })
}

const config: SshConnectionConfig = { target: 'fake-remote.test', hostKeyFingerprint: 'unapproved' }

/** 收进 argv.txt 的最后一段参数＝发给远端的脚本本身。 */
async function remoteScriptOf(root: string): Promise<string> {
  const argv = (await readFile(join(root, 'argv.txt'), 'utf8')).split('\n').filter(line => line !== '')
  return argv.at(-1) ?? ''
}

describe('DshSshManager.readLaunchUrl', () => {
  it('多行标记取最后一行（部署侧会在服务启动后回写新的启动 URL）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-launch-'))
    roots.push(root)
    await installFakeSsh(root, {
      stdout: [
        'some boot noise',
        'LAUNCH_URL=http://127.0.0.1:3080/?token=stale',
        'more service output',
        'LAUNCH_URL=http://127.0.0.1:3080/?token=fresh',
      ].join('\n'),
    })
    const manager = makeManager(root)
    try {
      const url = await manager.readLaunchUrl(config, '~/.local/state/threadharbor/stable/dsh-web.log')
      expect(url).toBe('http://127.0.0.1:3080/?token=fresh')
    } finally {
      manager.close()
    }
  })

  it('日志里还没有 LAUNCH_URL= 标记时返回 undefined 而不抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-launch-'))
    roots.push(root)
    await installFakeSsh(root, { stdout: 'ALREADY_RUNNING=1\n' })
    const manager = makeManager(root)
    try {
      const url = await manager.readLaunchUrl(config, '~/.local/state/threadharbor/stable/dsh-web.log')
      expect(url).toBeUndefined()
    } finally {
      manager.close()
    }
  })

  it('远端没有输出（含日志文件不存在）时返回 undefined 而不抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-launch-'))
    roots.push(root)
    await installFakeSsh(root, { stdout: '' })
    const manager = makeManager(root)
    try {
      const url = await manager.readLaunchUrl(config, '~/.local/state/threadharbor/stable/dsh-web.log')
      expect(url).toBeUndefined()
    } finally {
      manager.close()
    }
  })

  it('远端命令非零退出时不采用输出，返回 undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-launch-'))
    roots.push(root)
    await installFakeSsh(root, {
      stdout: 'LAUNCH_URL=http://127.0.0.1:3080/?token=stale\n',
      code: 1,
    })
    const manager = makeManager(root)
    try {
      const url = await manager.readLaunchUrl(config, '~/.local/state/threadharbor/stable/dsh-web.log')
      expect(url).toBeUndefined()
    } finally {
      manager.close()
    }
  })

  it('~/ 开头的日志路径经远端 shell 真实展开（~ 不能包进单引号），取到最后一行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-launch-'))
    roots.push(root)
    const home = join(root, 'home')
    const log = join(home, '.local/state/threadharbor/stable/dsh-web.log')
    await mkdir(dirname(log), { recursive: true })
    await writeFile(log, [
      'some boot noise',
      'LAUNCH_URL=http://127.0.0.1:3080/?token=stale',
      'service output after the first marker',
      'LAUNCH_URL=http://127.0.0.1:3080/?token=fresh',
    ].join('\n'))
    await installFakeSsh(root, { remoteHome: home })
    const manager = makeManager(root)
    try {
      const url = await manager.readLaunchUrl(config, '~/.local/state/threadharbor/stable/dsh-web.log')
      expect(url).toBe('http://127.0.0.1:3080/?token=fresh')
      // 远端命令形状是简报钉死的契约：逐行筛标记后取最后一行。
      const script = await remoteScriptOf(root)
      expect(script).toContain(`grep -h '^LAUNCH_URL='`)
      expect(script).toContain('| tail -1')
    } finally {
      manager.close()
    }
  })

  it('绝对路径日志同样经远端 shell 取到最后一行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-launch-'))
    roots.push(root)
    const home = join(root, 'home')
    const log = join(home, '.local/state/threadharbor/stable/dsh-web.log')
    await mkdir(dirname(log), { recursive: true })
    await writeFile(log, [
      'LAUNCH_URL=http://127.0.0.1:3080/?token=stale',
      'LAUNCH_URL=http://127.0.0.1:3080/?token=fresh',
    ].join('\n'))
    await installFakeSsh(root, { remoteHome: home })
    const manager = makeManager(root)
    try {
      const url = await manager.readLaunchUrl(config, log)
      expect(url).toBe('http://127.0.0.1:3080/?token=fresh')
    } finally {
      manager.close()
    }
  })
})
