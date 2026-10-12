/**
 * Does this code actually run, or is it only tested?
 *
 * Every module here can be green on its own and still never execute in the
 * product. That happened eight times: a preset table that was built but never
 * installed, a permission bridge that existed but was wired to refuse, a
 * resolver that disagreed with the matcher, a build that pointed at a deleted
 * package, a streaming implementation nothing constructed, a model catalogue
 * registered from a module the loaded entry never imports.
 *
 * Each one presented the same way — no error, no log, and a test suite that
 * passed. The reason they survived is that "this module is correct" and "this
 * module runs" were never checked as different things.
 *
 * So they are checked as different things here.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PACKAGES = ['dsh-acp-agent', 'dsh-client', 'dsh-host-federation', 'dsh-preset-dispatch'] as const

/**
 * What the host actually loads.
 *
 * These are the entries DSH resolves: a plugin's `main`, or the browser half of
 * one. Anything not downstream of these does not run because someone opened the
 * product — it runs only because a test imported it.
 */
const ROOTS = [
  'packages/dsh-preset-dispatch/src/entry.ts',
  'packages/dsh-client/src/index.ts',
  'packages/dsh-client/src/client/index.ts',
]

/**
 * Code that is written, tested, and deliberately not mounted yet.
 *
 * Each entry has to say what would clear it. An exception with no reason is
 * just the bug it is meant to describe, given a longer life.
 */
const KNOWN_UNWIRED: Readonly<Record<string, string>> = {
  'packages/dsh-preset-dispatch/src/service.ts':
    '早期入口，职能与 entry.ts 重叠。模型目录注册已迁到真机路径（plugin.ts 挂载 registerCatalog），此文件只剩 barrel 导出与测试在用；接线检查把它列为配置字段消费方，删它必须先改那道检查。清掉条件：确认没有外部包再调用 attachAcpDispatch，并从配置消费检查的文件清单移除后整体删除。',
  'packages/dsh-host-federation/src/host-store.ts':
    '不是未接线：由 cordis.patch.yml 的组合条目 threadharbor-host-store 加载（宿主侧设置存储，浏览器经 remote.settings 读写）。静态可达性分析只扫代码 import，看不见组合登记。真机证据：启动日志出现 [threadharbor] host store mounted 行。清掉条件：组合登记进入本检查的根清单（加载路径可静态追溯）。',
}

function packageExports(pkg: string): Record<string, unknown> {
  const file = `packages/${pkg}/package.json`
  if (!existsSync(file)) return {}
  return (JSON.parse(readFileSync(file, 'utf8')) as { exports?: Record<string, unknown> }).exports ?? {}
}

/**
 * Resolve one import specifier to a file inside this repo, or null.
 *
 * Relative specifiers resolve against the importing file's own directory, and
 * `join` is what makes `./` and `../` both land right — a hand-stripped prefix
 * (slice(2)) silently broke every `../` hop, and resolving against `src/`
 * made subdirectory modules look reachable only through the barrel.
 */
function resolveSpecifier(pkg: string, spec: string, fromDir: string): string | null {
  if (spec.startsWith('.')) {
    const base = join(fromDir, spec)
    const candidates = /\.tsx?$/.test(base)
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
    return candidates.find(existsSync) ?? null
  }
  if (!spec.startsWith('@threadharbor/')) return null
  const [scope, name, sub] = spec.split('/')
  if (scope !== '@threadharbor' || !PACKAGES.includes(name as never)) return null
  const exports = packageExports(name)
  const entry = (sub === undefined ? exports['.'] : exports[`./${sub}`]) as
    | string | { default?: string } | undefined
  const target = typeof entry === 'string' ? entry : entry?.default
  return target === undefined ? null : join('packages', name, target)
}

/** Every module reachable from what the host loads. */
function reachableFromHost(): Set<string> {
  const seen = new Set<string>()
  const queue = [...ROOTS]
  const imports = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const pkg = file.split('/')[1]
    const fromDir = dirname(file)
    for (const match of readFileSync(file, 'utf8').matchAll(imports)) {
      const target = resolveSpecifier(pkg, match[1], fromDir)
      if (target !== null) queue.push(target)
    }
  }
  return seen
}

/** Every source module in a package. */
function allModules(pkg: string): string[] {
  const root = `packages/${pkg}/src`
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
    }
  }
  walk(root)
  return out
}

describe('代码真机上到不到', () => {
  it('除了登记在册的，每个模块都从宿主加载的入口可达', () => {
    const reachable = reachableFromHost()
    const unwired = PACKAGES.flatMap(allModules).filter(file => !reachable.has(file))

    // A barrel is a package's published surface, not a dead module: it exists
    // to be imported from outside, which reachability from the host cannot see.
    const ignored = unwired.filter(file => file.endsWith('/src/index.ts'))
    const unexplained = unwired.filter(file => !ignored.includes(file) && KNOWN_UNWIRED[file] === undefined)

    expect(
      unexplained,
      '这些模块真机上到不了，也没有登记。接上它们，或者登记进 KNOWN_UNWIRED 并写清由什么条件清掉。',
    ).toEqual([])
  })

  it('登记的例外都写清了由什么条件清掉', () => {
    for (const [file, reason] of Object.entries(KNOWN_UNWIRED)) {
      expect(existsSync(resolve(file)), `${file} 已不存在，从登记里删掉`).toBe(true)
      expect(reason.trim().length, `${file} 没写清由什么条件清掉`).toBeGreaterThan(4)
    }
  })

  it('登记的例外确实到不了——接上了就要从登记里拿掉', () => {
    const reachable = reachableFromHost()
    const nowReachable = Object.keys(KNOWN_UNWIRED).filter(file => reachable.has(file))
    expect(nowReachable, '这些已经接上了，请从登记里移除').toEqual([])
  })
})

describe('配置项配了有没有人读', () => {
  it('入口配置里每个字段都被生产代码读过', () => {
    const entry = readFileSync('packages/dsh-preset-dispatch/src/entry.ts', 'utf8')
    const start = entry.indexOf('export const Config')
    const end = entry.indexOf('\n})', start)
    const schema = entry.slice(start, end === -1 ? undefined : end)
    const fields = [...schema.matchAll(/^ {2}(\w+):/gm)].map(match => match[1])

    const consumers = ['entry.ts', 'plugin.ts', 'registry.ts', 'factory.ts', 'service.ts']
      .map(file => readFileSync(`packages/dsh-preset-dispatch/src/${file}`, 'utf8'))
      .join('\n')

    const unread = fields.filter(field => new RegExp(`config\\.${field}\\b`).test(consumers) === false)
    expect(unread, '这些配置字段没有任何代码读过，配了等于没配').toEqual([])
  })
})