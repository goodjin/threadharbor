import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { build, type UserConfig } from 'tsdown'
import client from '../packages/dsh-client/tsdown.config.ts'
import plugin from '../tsdown.plugin.config.ts'

/**
 * The packaged outputs, and what they cost when their timestamp moves.
 *
 * The Host serves the client bundle straight from disk and watches it by
 * timestamp: a change makes it re-bundle the client graph, and that work blocks
 * its event loop for a moment. Every open page then loses its connection, and a
 * turn running on that page is marked interrupted (2026-10-21: a long turn
 * died while the bundle was being rebuilt).
 *
 * So a rebuild that does not actually change the bundle must not move its
 * timestamp: the content is compared, and an unchanged file keeps its old
 * mtime. Only a bundle whose *content* changed makes the Host redo its work —
 * which is the one time that cost is real.
 */
const PACKAGED_OUTPUTS = [
  'packages/dsh-client/lib/client.js',
  'packages/dsh-client/lib/client.js.map',
  'packages/dsh-client/lib/index.js',
  'lib/index.js',
] as const

type Stamp = { readonly hash: string; readonly atimeMs: number; readonly mtimeMs: number }

/** Content hash and timestamps of one file, if it is there. */
function stampOf(path: string): Stamp | undefined {
  if (!existsSync(path)) return undefined
  const stat = statSync(path)
  return {
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    atimeMs: stat.atimeMs,
    mtimeMs: stat.mtimeMs,
  }
}

/** Put back the timestamps of the outputs whose content did not change. */
function restoreUnchangedTimestamps(before: ReadonlyMap<string, Stamp>): void {
  for (const [path, stamp] of before) {
    const now = stampOf(path)
    if (now === undefined || now.hash !== stamp.hash) continue
    utimesSync(path, stamp.atimeMs / 1000, stamp.mtimeMs / 1000)
  }
}

const builds: readonly [string, UserConfig | readonly UserConfig[]][] = [
  ['packages/dsh-client', client],
  ['.', plugin],
]

const before = new Map<string, Stamp>()
for (const path of PACKAGED_OUTPUTS) {
  const stamp = stampOf(path)
  if (stamp !== undefined) before.set(path, stamp)
}

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

restoreUnchangedTimestamps(before)
