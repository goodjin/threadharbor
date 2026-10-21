import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/**
 * Refuse to package a `lib/` entry that is older than the `src/` it was
 * compiled from.
 *
 * The packaging configs (tsdown) take their entry from `lib/types/index.js` —
 * the *compiled* output, not `src/`. That is correct when `tsc` ran first, but
 * it fails silently when it did not:
 *
 *   - `tsc -b` is incremental. An edit to a `src/` file whose emitted `lib/`
 *     file is still newer than its `tsBuildInfoFile` leaves `lib/` stale, and
 *     `tsc` prints nothing.
 *   - Running the tsdown packaging on its own (no `tsc` beforehand) bundles
 *     whatever `lib/` happens to hold.
 *
 * In both cases the build exits 0 and ships yesterday's code. The `check`
 * script runs `tsc` before `build`, so the normal path is safe; this guard is
 * the backstop for every other way to invoke the packaging — and it is the
 * "fail loud" half of the stale-artifact problem (the other half is
 * `verify-build.mjs`, which checks the *contents* of the browser artifact).
 *
 * The guard walks the TypeScript imports reachable from each entry's source and
 * compares every emitted `.js` under `lib/types/` against its source. Only files
 * the entry actually pulls in are checked — the plugin entry is an empty
 * `apply()` that transitively imports almost nothing, so guarding all of `src/`
 * would flag files it legitimately never bundles.
 */

const ROOT = process.cwd()

/** `src/...` -> `lib/types/...`, mirroring each package tsconfig outDir. */
function emittedFor(sourceFile) {
  return sourceFile
    .replace(/\.tsx?$/, '.js')
    .replace(/^packages\/[^/]+\/src\//, (m) => m.replace('src/', 'lib/types/'))
}

function sourceImports(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  const patterns = [
    /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s*[^;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const base = join(dirname(file), spec)
      const candidates = /\.(ts|tsx)$/.test(base)
        ? [base]
        : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), `${base}.js`, join(base, 'index.js')]
      const hit = candidates.find((c) => existsSync(c))
      if (hit) out.push(hit)
    }
  }
  return out
}

/** Every source file reachable from `entrySource`, following relative imports. */
function reachableSources(entrySource) {
  const seen = new Set()
  const queue = [entrySource]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const next of sourceImports(file)) queue.push(next)
  }
  return [...seen]
}

const ENTRIES = [
  {
    name: 'plugin',
    entrySource: 'packages/dsh-client/src/index.ts',
    emitted: 'packages/dsh-client/lib/types/index.js',
  },
  {
    name: 'client',
    entrySource: 'packages/dsh-client/src/client/index.ts',
    emitted: 'packages/dsh-client/lib/types/client/index.js',
  },
]

const problems = []

for (const entry of ENTRIES) {
  if (!existsSync(entry.emitted)) {
    // Nothing compiled yet — `tsc` has not run in this tree. The packaging would
    // fail on its own; do not pre-empt it with a freshness complaint.
    continue
  }
  for (const source of reachableSources(entry.entrySource)) {
    if (!existsSync(source)) continue
    const emitted = emittedFor(source)
    if (!existsSync(emitted)) continue // not emitted (e.g. CSS, or a type-only path)
    // **每个源文件跟它自己的编译产物比**，不是跟入口的产物比。
    //
    // 入口比法（2026-10-20 之前）是错的：`tsc` 增量编译不重写内容没变的入口
    // 文件，于是「改了一个叶子文件」就会让入口的产物比那个叶子旧——门禁误报
    // 「产物过期」，逼人清库重建。清库期间 `lib/` 是空的：桌面版从磁盘现读现服务
    // 客户端包，那个窗口里刷新页面就会读到半成品，整个客户端插件装载失败
    // （2026-10-20 桌面版现场：输入框连模型都不见了）。
    //
    // 逐文件比才是这道门禁本来的意思：源比它自己的产物新，就是它没被编译过。
    // 入口自己的产物仍旧单独看一眼（它就是打包的输入）。
    const sourceMtime = statSync(source).mtimeMs
    if (sourceMtime > statSync(emitted).mtimeMs) {
      problems.push(
        `${relative(ROOT, source)} is newer than ${relative(ROOT, emitted)} — ` +
          `packaging would bundle stale code. Run \`pnpm build\` (tsc before tsdown).`,
      )
    }
  }
  const entrySourceMtime = statSync(entry.entrySource).mtimeMs
  if (entrySourceMtime > statSync(join(ROOT, entry.emitted)).mtimeMs) {
    problems.push(
      `${relative(ROOT, entry.entrySource)} is newer than ${relative(ROOT, entry.emitted)} — ` +
        `packaging would bundle stale code. Run \`pnpm build\` (tsc before tsdown).`,
    )
  }
}

if (problems.length > 0) {
  console.error('check-freshness: refusing to package stale lib/ output:\n  ' + problems.join('\n  '))
  process.exit(1)
}
