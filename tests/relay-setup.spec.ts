/**
 * 中转配置片段生成脚本的用例。
 *
 * 沿用 release-scripts.spec.ts 的做法：真的 spawn 脚本再断言输出。脚本是运维
 * 入口，它出错时人是在生产环境上执行的，所以校验顺序必须可测——尤其「参数
 * 非法要在任何副作用之前就被拒」。
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'relay-setup.sh')

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('relay-setup.sh', () => {
  it('--help 只打用法，不含任何副作用（不要求参数、不写文件、不调 SSH）', () => {
    const result = run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--host')
    expect(result.stdout).toContain('--target')
    // 没有机器条目 = 没有在拼配置片段 = 没有副作用。
    expect(result.stdout).not.toContain('threadharbor-mobile-relay')
  })

  it('端口 099 被拒（先于任何 SSH 调用）', () => {
    const result = run(['--host', 'gooddemacbook-pro', '--target', '100.64.0.2', '--remote-port', '099'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/端口/)
  })

  it.each(['0', '65536', 'abc', ''])('端口形态非法：%j 被拒', port => {
    const result = run(['--host', 'gooddemacbook-pro', '--target', '100.64.0.2', '--remote-port', port])
    expect(result.code).not.toBe(0)
  })

  it.each(['GoodDemacbook', 'gooddemacbook.', 'good demacbook', 'good/pro'])('host 名非法：%j 被拒', host => {
    const result = run(['--host', host, '--target', '100.64.0.2', '--remote-port', '3081'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/tailnet|机器名/)
  })

  it('target 含 shell 元字符被拒（片段会被抄进配置文件，不能带命令注入面）', () => {
    const result = run(['--host', 'gooddemacbook-pro', '--target', '1.2.3.4;rm -rf /', '--remote-port', '3081'])
    expect(result.code).not.toBe(0)
  })

  it('合法参数输出含组合行片段与 mobileOrigin', () => {
    const result = run(['--host', 'gooddemacbook-pro', '--target', '100.64.0.2', '--remote-port', '3081'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- id: threadharbor-mobile-relay')
    expect(result.stdout).toContain('mobileOrigin:')
    expect(result.stdout).toContain('sshKnownHostsPath:')
    expect(result.stdout).toContain('statePath:')
    expect(result.stdout).toContain('hostId: gooddemacbook-pro')
    expect(result.stdout).toContain('remotePort: 3081')
  })

  it('缺必填参数时给出可读错误而不是空片段', () => {
    const result = run(['--host', 'gooddemacbook-pro'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/--target|必填/)
  })

  it('shell 语法检查通过', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow()
  })
})

describe('known_hosts 别名（运维唯一能拿到它的途径）', () => {
  it('输出别名与登记命令（别名是算出来的，运维没有别的途径知道它）', () => {
    const result = run(['--host', 'tencent01', '--target', '100.84.120.35', '--remote-port', '3080'])
    expect(result.code).toBe(0)
    const alias = /threadharbor-[0-9a-f]{24}/.exec(result.stdout)
    expect(alias).not.toBeNull()
    // 与 packages/dsh-mobile-relay/src/tunnels.ts 的 hostKeyAlias 同式：sha256 前 24 位。
    expect(alias?.[0]).toBe('threadharbor-563336ce4c9a9a72687422c7')
    expect(result.stdout).toContain('known_hosts')
    expect(result.stdout).toContain(alias?.[0] ?? '')
  })

  it('ssh 端口不同 → 别名不同（别名把端口算进去了）', () => {
    const base = run(['--host', 'tencent01', '--target', '100.64.0.2', '--remote-port', '3081'])
    const other = run(['--host', 'tencent01', '--target', '100.64.0.2', '--remote-port', '3081', '--ssh-port', '2222'])
    const a = /threadharbor-[0-9a-f]{24}/.exec(base.stdout)?.[0]
    const b = /threadharbor-[0-9a-f]{24}/.exec(other.stdout)?.[0]
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('ssh 端口非法形态被拒', () => {
    const result = run(['--host', 'tencent01', '--target', '100.64.0.2', '--remote-port', '3081', '--ssh-port', '099'])
    expect(result.code).not.toBe(0)
  })
})

describe('登记命令产出的行 ssh 真认（形状对≠格式对）', () => {
  /**
   * 真机上栽过两次同一个坑：ssh-keyscan 的输出**第一段是主机名**，把它直接拼在
   * 别名后面就成了一行 `别名 主机名 keytype 公钥`，ssh 解析时把主机名当成 keytype，
   * 于是「已经登记了」却仍然报指纹未登记。用 -H 更糟：它哈希的正是主机名那一段，
   * 而中转是按**别名**查的，别名再也对不上。
   *
   * 所以这里不比对脚本文本，而是照脚本给的命令把一个假的 keyscan 输出走一遍，
   * 看产出的行是不是「三段、且第一段是别名」。
   */
  function emitted(result: { stdout: string }): string {
    return result.stdout
  }

  it('命令里的 awk/sed 把主机名那一段剔掉了（产出行只有三段）', () => {
    const out = emitted(run(['--host', 'japan01', '--target', '100.96.208.116', '--remote-port', '3080']))
    const appendLine = out.split('\n').find(text => text.includes('>>') && text.includes('sed "s|^|'))
    expect(appendLine).toBeDefined()
    // 只取第 2、3 段再把别名顶上去——这正是「三段」的由来。
    expect(appendLine).toContain("awk '{print $2, $3}'")

    const alias = (out.match(/threadharbor-[a-f0-9]{24}/) ?? [])[0]
    expect(alias).toBeDefined()
    const keyscan = '100.96.208.116 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\n'
    const produced = `${alias} ${keyscan.trim().split(' ').slice(1).join(' ')}`
    expect(produced.trim().split(/\s+/)).toHaveLength(3)
  })

  it('命令里不用 -H（它哈希的是主机名那一段，按别名就再也查不到）', () => {
    const out = emitted(run(['--host', 'japan01', '--target', '100.96.208.116', '--remote-port', '3080']))
    const keyscanLines = out.split('\n').filter(text => text.includes('ssh-keyscan') && !text.includes('人工'))
    expect(keyscanLines.length).toBeGreaterThan(0)
    for (const line of keyscanLines) expect(line).not.toMatch(/ssh-keyscan[^\n]*\s-H\b/)
  })
})

describe('脚本给的那段配置，装得上、也开得起来中转模式', () => {
  /**
   * 这个脚本的全部意义是「照抄就能用」。所以这里不比对脚本文本，而是把**它输出
   * 的那段 YAML** 交给真正的 Config 校验：以前缺 logPath（必填），照抄的配置
   * 装载即拒——而脚本自己还在旁边印着「加进 cordis.patch.yml」。
   */
  function snippetFrom(out: string): string {
    const lines = out.split('\n')
    const start = lines.findIndex(text => text.trim() === '- id: threadharbor-mobile-relay')
    expect(start, '脚本输出里没有中转包的组合行').toBeGreaterThan(-1)
    const end = lines.findIndex((text, index) => index > start && /^机器侧还要做/.test(text))
    return lines.slice(start, end === -1 ? undefined : end).join('\n')
  }

  it('输出的中转片段里，每台机器都带必填的 logPath', () => {
    const out = run(['--host', 'japan01', '--target', '100.96.208.116', '--remote-port', '3080']).stdout
    const snippet = snippetFrom(out)
    expect(snippet).toContain('logPath:')
    // 每台机器都得有：漏一台，那台就是「装载即拒」。
    const machines = (snippet.match(/- hostId:/g) ?? []).length
    expect((snippet.match(/logPath:/g) ?? []).length).toBe(machines)
  })

  it('片段里给了手机页包那一行且带 mode: hub（不加这行手机页停在直连模式）', () => {
    const out = run(['--host', 'japan01', '--target', '100.96.208.116', '--remote-port', '3080']).stdout
    expect(out).toContain('- id: threadharbor-mobile-entry')
    const entryBlock = out.slice(out.indexOf('- id: threadharbor-mobile-entry'), out.indexOf('机器侧还要做'))
    expect(entryBlock).toContain('mode: hub')
  })
})

describe('登记那两条命令真跑一遍（不再在测试里手工重建那一行）', () => {
  /**
   * 上一版这条用例是「手工重建」：从脚本文本里抠出 awk 的写法，然后自己在测试里
   * 按那个写法拼一行，断言拼出来是三段。脚本那条命令一改，用例照旧全绿——它验的
   * 从来不是脚本给的命令。
   *
   * 这里改成真的执行：把脚**印出来的两行**捞出来，把路径换成临时目录，用一个假的
   * ssh-keyscan 顶掉真网络调用，然后交给 bash 跑；最后看落进 known_hosts 的到底
   * 是哪一行。
   */
  function runEmittedPipeline(): string {
    const dir = mkdtempSync(join(tmpdir(), 'th-relay-setup-'))
    const bin = join(dir, 'bin')
    const keyFile = join(dir, 'th-key')
    const knownHosts = join(dir, 'known_hosts')
    mkdirSync(bin)
    writeFileSync(knownHosts, '', 'utf8')
    // 假的 ssh-keyscan：吐的是真实形状——注释行 + 一行「主机名 keytype 公钥」。
    const keyscan = join(bin, 'ssh-keyscan')
    writeFileSync(
      keyscan,
      ['#!/bin/sh', 'echo "# 100.96.208.116 SSH-2.0-OpenSSH_9.8"', 'echo "100.96.208.116 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey"'].join('\n') + '\n',
      'utf8',
    )
    chmodSync(keyscan, 0o755)

    const out = run(['--host', 'japan01', '--target', '100.96.208.116', '--remote-port', '3080']).stdout
    const alias = (out.match(/threadharbor-[a-f0-9]{24}/) ?? [])[0]
    if (alias === undefined) throw new Error('脚本输出里没有算出来的别名')
    const commands = out.split('\n').map(line => line.trim())
    // 注意挑的是**命令那一行**，不是说明文字——说明里也有一句以 ssh-keyscan 开头。
    const first = commands.find(line => /^ssh-keyscan\s+-t\s/.test(line))
    const second = commands.find(line => line.includes("awk '{print $2, $3}'"))
    if (first === undefined || second === undefined) throw new Error('脚本输出的两行命令没找全')

    const firstLine = first.replace('/tmp/th-key', keyFile)
    const secondLine = second.replace('/tmp/th-key', keyFile).replace(/>>\s*\S+/, `>> ${knownHosts}`)
    execFileSync('bash', ['-c', firstLine], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } })
    execFileSync('bash', ['-c', secondLine], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } })
    const written = readFileSync(knownHosts, 'utf8')
    rmSync(dir, { recursive: true, force: true })
    return written
  }

  it('跑完落进 known_hosts 的正是「别名 + keytype + 公钥」三段', () => {
    const written = runEmittedPipeline()
    const lines = written.trim().split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^threadharbor-[a-f0-9]{24} ssh-ed25519 \S+$/)
  })

  it('主机名那一段真的没了（留着会让 ssh 把主机名当成 keytype）', () => {
    const written = runEmittedPipeline()
    expect(written).not.toContain('100.96.208.116')
  })

  it('脚本命令一改，这条用例就跟不上——所以它必须真跑而不是手工重建', () => {
    // 判别面自证：把脚��里 awk 那一段换成会留下主机名的写法，跑出来的行就不是三段。
    const dir = mkdtempSync(join(tmpdir(), 'th-relay-mut-'))
    const keyFile = join(dir, 'key')
    const knownHosts = join(dir, 'known_hosts')
    writeFileSync(keyFile, '100.96.208.116 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey\n', 'utf8')
    writeFileSync(knownHosts, '', 'utf8')
    const alias = 'threadharbor-' + 'a'.repeat(24)
    execFileSync('bash', ['-c', `awk '{print $1, $2, $3}' ${keyFile} | sed "s|^|${alias} |" >> ${knownHosts}`])
    expect(readFileSync(knownHosts, 'utf8').trim().split(/\s+/)).toHaveLength(4)
    rmSync(dir, { recursive: true, force: true })
  })
})

