import { build, type UserConfig } from 'tsdown'
import client from '../packages/dsh-client/tsdown.config.ts'
import zcode from '../packages/zcode-acp/tsdown.config.ts'
import plugin from '../tsdown.plugin.config.ts'

const builds: readonly [string, UserConfig | readonly UserConfig[]][] = [
  ['packages/dsh-client', client],
  // zcode-acp builds as a standalone shebanged executable: the preset's
  // command spawns it directly, so its artifact must exist before dispatch.
  ['packages/zcode-acp', zcode],
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
