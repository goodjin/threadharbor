/**
 * 中转配置片段生成脚本的用例。
 *
 * 沿用 release-scripts.spec.ts 的做法：真的 spawn 脚本再断言输出。脚本是运维
 * 入口，它出错时人是在生产环境上执行的，所以校验顺序必须可测——尤其「参数
 * 非法要在任何副作用之前就被拒」。
 */

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
