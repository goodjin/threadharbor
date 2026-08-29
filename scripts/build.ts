import { build, type UserConfig } from 'tsdown'
import protocol from '../packages/protocol/tsdown.config.ts'
import hostd from '../packages/hostd/tsdown.config.ts'
import gateway from '../packages/dsh-gateway/tsdown.config.ts'
import client from '../packages/dsh-client/tsdown.config.ts'
import plugin from '../tsdown.plugin.config.ts'

const builds: readonly [string, UserConfig | readonly UserConfig[]][] = [
  ['packages/protocol', protocol],
  ['packages/hostd', hostd],
  ['packages/dsh-gateway', gateway],
  ['packages/dsh-client', client],
  ['.', plugin],
]

for (const [cwd, value] of builds) {
  const configs = Array.isArray(value) ? value : [value]
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    for (const config of configs) await build({ ...config, config: false })
  } finally {
    process.chdir(previous)
  }
}
