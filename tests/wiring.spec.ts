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

const PACKAGES = ['dsh-acp-agent', 'dsh-client', 'dsh-host-federation', 'dsh-mobile-entry', 'dsh-mobile-relay', 'dsh-preset-dispatch'] as const

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
 * The composition file the profile loads.
 *
 * A plugin the host mounts this way is a root the static import walk below
 * cannot see: the composition row names a package by its `@threadharbor/...`
 * specifier, not by a relative import, so reachability from `ROOTS` alone
 * misses it. The host-store half of the federation package is the case that
 * motivated this — it is loaded only through `cordis.patch.yml`.
 */
const COMPOSITION = 'cordis.patch.yml'

/**
 * Package specifiers named as composition entries.
 *
 * Pulled from the `name:` fields of the composition file. Only `@threadharbor/`
 * specifiers resolve to a package in this repo; everything else (DSH's own
 * `@deepseek-ai/...` presets) is out of scope. Nested rows are captured too —
 * the ACP preset bindings point at `@threadharbor/dsh-preset-dispatch`.
 */
function compositionSpecifiers(): string[] {
  if (!existsSync(COMPOSITION)) return []
  const text = readFileSync(COMPOSITION, 'utf8')
  const specs = new Set<string>()
  for (const match of text.matchAll(/name:\s*['"](@threadharbor\/[^'"]+)['"]/g)) {
    specs.add(match[1] as string)
  }
  return [...specs]
}

/**
 * Code that is written, tested, and deliberately not mounted yet.
 *
 * Each entry has to say what would clear it. An exception with no reason is
 * just the bug it is meant to describe, given a longer life.
 */
const KNOWN_UNWIRED: Readonly<Record<string, string>> = {
  'packages/dsh-preset-dispatch/src/service.ts':
    '早期入口，职能与 entry.ts 重叠。模型目录注册已迁到真机路径（plugin.ts 挂载 registerCatalog），此文件只剩 barrel 导出与测试在用；接线检查把它列为配置字段消费方，删它必须先改那道检查。清掉条件：确认没有外部包再调用 attachAcpDispatch，并从配置消费检查的文件清单移除后整体删除。',
  'packages/dsh-mobile-entry/src/wire.ts':
    '线上协议常量记录（Task 6 探针钉死的端点/mux 帧字面量），手机端用的是把值逐条硬编码进去的 mobile/wire.js（静态页不能 import TS），包内只有 tests/wire.spec.ts 在 import 它——测试引用不算产品接线，这正是本登记要说的：它当前是记录，不是被装载的代码。清掉条件：mobile 侧改为从包 src（经构建产物）消费这些常量、或协议常量改由构建步骤生成进 mobile/wire.js 时接上并从登记移除；若常量记录被删除，登记随之删。',
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
  // Composition entries: the host loads these by package specifier, not by a
  // relative import, so resolve each to the file the package exports (its main
  // or the named subpath) and seed that as a root. This is what lets the walk
  // see a half that no in-repo module imports — the federation package's
  // host-store entry is loaded only through cordis.patch.yml.
  for (const spec of compositionSpecifiers()) {
    const target = resolveSpecifier('@threadharbor/threadharbor', spec, '.')
    if (target !== null) queue.push(target)
  }
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