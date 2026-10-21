import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'

/**
 * Refuse to package a `lib/` that does not correspond to the `src/` it was
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
 * **The verdict comes from `tsc` itself, not from file timestamps.**
 *
 * A timestamp comparison looks right and is wrong in both directions:
 *   - it cries wolf when a file was rewritten with the *same* content
 *     (`git checkout`, an editor saving unchanged text, a stash round trip):
 *     `tsc` sees the identical content and correctly emits nothing, but the
 *     source's mtime is newer than its (identical) output — the guard then
 *     demands a rebuild, and the only way to satisfy it is to wipe every
 *     package's `lib/` and rebuild from scratch. During that wipe `lib/` is
 *     empty, and the desktop app serves the client bundle straight from disk:
 *     a page refreshed inside that window loads half a bundle and the whole
 *     client plugin set fails to load (2026-10-20 desktop: the composer's model
 *     entry vanished, with nothing but a 404 in the console).
 *   - it stays quiet when the *content* differs but the timestamp does not
 *     (a checkout that restores an older revision of a file), which is the
 *     case the guard exists for.
 *
 * `tsc -b --dry` answers exactly the question the guard is asking: it compares
 * the content hashes it recorded in the build info and prints
 * "A non-dry build would build project ..." for the projects whose outputs no
 * longer match their sources. That is the same judgement `tsc` itself will act
 * on, so the guard and the compiler can never disagree.
 */

const ROOT = process.cwd()

/** The compiler whose verdict we take. */
const TSC = join(ROOT, 'node_modules/.bin/tsc')

/** The compiled entries the packaging takes as its input. */
const PACKAGED_ENTRIES = [
  'packages/dsh-client/lib/types/index.js',
  'packages/dsh-client/lib/types/client/index.js',
]

const problems = []

for (const entry of PACKAGED_ENTRIES) {
  if (!existsSync(join(ROOT, entry))) {
    problems.push(`${entry} is missing — nothing was compiled in this tree.`)
  }
}

if (problems.length === 0) {
  const dry = spawnSync(TSC, ['-b', 'tsconfig.json', '--dry'], { cwd: ROOT, encoding: 'utf8' })
  if (dry.status !== 0) {
    problems.push(`tsc could not report the build state:\n${(dry.stderr || dry.stdout || '').trim()}`)
  } else {
    const output = `${dry.stdout ?? ''}\n${dry.stderr ?? ''}`
    for (const line of output.split('\n')) {
      if (!line.includes('would build')) continue
      const project = /would build project '([^']+)'/.exec(line)?.[1]
      problems.push(
        project === undefined
          ? line.trim()
          : `${relative(ROOT, project)} is out of date — packaging would bundle stale code. Run \`pnpm build\` (tsc before tsdown).`,
      )
    }
  }
}

if (problems.length > 0) {
  console.error('check-freshness: refusing to package stale lib/ output:\n  ' + problems.join('\n  '))
  process.exit(1)
}
