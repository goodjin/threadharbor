/**
 * 「照抄脚本就能用」这条承诺的可执行版本。
 *
 * 脚本的唯一意义就是吐出那段配置；吐出来的东西过不了装载期校验，前面所有
 * 文档与脚本上的考据都等于零。这里把脚本的输出交回**真正的 Config** 判一次。
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Config } from '../src/index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'relay-setup.sh')

function run(args: string[]): string {
  return execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })
}

/** 从脚本输出里切出中转包那一段组合行（到「机器侧还要做」为止）。 */
function snippet(out: string): string {
  const lines = out.split('\n')
  const start = lines.findIndex(text => text.trim() === '- id: threadharbor-mobile-relay')
  expect(start, '脚本输出里没有中转包的组合行').toBeGreaterThan(-1)
  const end = lines.findIndex((text, index) => index > start && /^机器侧还要做/.test(text))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** 把那段 YAML 还原成对象：这里只认脚本自己会吐出的那几种形状。 */
function toConfig(source: string): Record<string, unknown> {
  return {
    mobileOrigin: /mobileOrigin:\s*(\S+)/.exec(source)?.[1],
    sshKnownHostsPath: /sshKnownHostsPath:\s*(\S+)/.exec(source)?.[1],
    statePath: /statePath:\s*(\S+)/.exec(source)?.[1],
    machines: [...source.matchAll(/- hostId:\s*(\S+)[\s\S]*?target:\s*(\S+)[\s\S]*?remotePort:\s*(\d+)[\s\S]*?logPath:\s*(\S+)/g)].map(m => ({
      hostId: m[1],
      target: m[2],
      remotePort: Number(m[3]),
      logPath: m[4],
    })),
  }
}

describe('脚本吐出来的配置装得上', () => {
  it('输出的片段能被真正的 Config 校验接受（把 YAML 还原成对象再过一遍 schema）', async () => {
    const out = run(['--host', 'japan01', '--target', '100.96.208.116', '--remote-port', '3080'])
    const config = toConfig(snippet(out))
    expect(config.machines).toHaveLength(1)
    // schemastery 自己的校验器；过不了就是「照抄装不上」。
    try {
      // 与宿主装载时同一套调用：schemastery 的 Schema 本身就是个校验函数。
      Config(config)
    } catch (error) {
      throw new Error(`照抄脚本的配置装载被拒：${JSON.stringify(config)} → ${String(error)}`)
    }
  })

})
