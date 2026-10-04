/** Loader entry that runs a live-streaming copy of `@deepseek-ai/dsh-acp`.
 *
 * Point the `acp` loader entry's `name` at this file. It resolves the real
 * upstream module, rewrites two call sites, imports the cached rewrite and
 * re-exports the upstream surface.
 *
 * What the rewrite buys:
 * - the agent loop publishes every provider chunk on `agent/assistant-stream`;
 *   the bridge only reads committed events, so the relay forwards those chunks
 *   to the ACP client as they arrive, which is the difference between text
 *   appearing during generation and appearing all at once at the end;
 * - the committed copy of a block already streamed live is dropped, so text
 *   appears exactly once;
 * - whatever the relay cannot stream (tool calls, other message kinds) still
 *   goes through the pacer, so a committed block is never delivered as one
 *   unreadable blob.
 *
 * Safety rules:
 * - the rewrite is anchored on single unique lines, so an upstream release that
 *   moves the code makes the patch refuse rather than half-apply;
 * - on any problem the stock module is imported unchanged, so the worst case is
 *   today's behaviour (one big chunk), never a crash and never a stale copy;
 * - the cache is keyed by the upstream source hash, so a DSH upgrade can never
 *   leave an outdated copy running.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TRANSFORM_VERSION, transformAcpSource } from './acp-source-transform.mjs'
import { armBridge, createRelay, followAssistantStream } from './live-stream.mjs'

const HELPER_URL = import.meta.resolve('./live-stream.mjs')
const UPSTREAM = '@deepseek-ai/dsh-acp'
/** The upstream entry only exports these today; a change is worth shouting about. */
const EXPECTED_EXPORTS = ['Config', 'apply', 'inject', 'name']

function warn(message) {
  process.stderr.write(`threadharbor-acp-stream: ${message}\n`)
}

function liveEnabled() {
  return process.env['THREADHARBOR_ACP_STREAM_LIVE'] !== '0'
}

/** Bases to try when resolving the upstream package, most specific first. */
function resolutionBases() {
  const bases = []
  const argvEntry = process.argv[1]
  if (typeof argvEntry === 'string' && argvEntry !== '' && argvEntry.startsWith('/')) bases.push(argvEntry)
  // A global npm/pnpm install keeps the package next to the node binary.
  const execRoot = dirname(dirname(process.execPath))
  bases.push(join(execRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  bases.push(import.meta.url)
  return bases
}

/** Absolute path of the upstream entry module, or undefined when unreachable. */
function resolveUpstreamEntry() {
  for (const base of resolutionBases()) {
    try {
      return createRequire(base).resolve(UPSTREAM)
    } catch {
      // Try the next base.
    }
  }
  return undefined
}

function cacheDirectory() {
  const configured = process.env['THREADHARBOR_ACP_STREAM_CACHE']
  return configured !== undefined && configured !== ''
    ? configured
    : join(tmpdir(), 'threadharbor-acp-stream')
}

/**
 * Make the cache resolvable from the upstream package.
 *
 * The rewritten module keeps upstream's bare imports (`@deepseek-ai/*`), which
 * Node resolves by walking up from the file. A cache directory outside the
 * package tree therefore fails to import, so the cache gets a `node_modules`
 * symlink to the one the upstream entry itself resolves against.
 */
function linkResolutionRoot(cache, entryPath) {
  let directory = dirname(entryPath)
  while (directory !== dirname(directory)) {
    if (directory.endsWith(`${sep}node_modules`)) {
      const link = join(cache, 'node_modules')
      if (existsSync(link)) return
      try {
        symlinkSync(directory, link, 'dir')
      } catch (error) {
        warn(`could not link ${link} -> ${directory} (${String(error)})`)
      }
      return
    }
    directory = dirname(directory)
  }
  warn(`no node_modules root above ${entryPath}; the patched copy may not import`)
}

function hashSource(source) {
  return createHash('sha256').update(`${TRANSFORM_VERSION}\n${source}`).digest('hex').slice(0, 16)
}

/** Write the rewritten module into the cache and return its URL. */
function materialise(entryPath, source) {
  const directory = cacheDirectory()
  mkdirSync(directory, { recursive: true })
  linkResolutionRoot(directory, entryPath)
  const target = join(directory, `dsh-acp.${hashSource(source)}.mjs`)
  writeFileSync(target, source, { mode: 0o600 })
  return pathToFileURL(target).href
}

async function loadUpstream() {
  const entryPath = resolveUpstreamEntry()
  if (entryPath === undefined) {
    warn(`could not resolve ${UPSTREAM}; running the stock bridge`)
    return { module: await import(UPSTREAM), patched: false }
  }

  const source = readFileSync(entryPath, 'utf8')
  const { code, applied, reason } = transformAcpSource(source, HELPER_URL)
  if (!applied) {
    warn(`upstream ${UPSTREAM} is not patchable (${reason}); running the stock bridge`)
    return { module: await import(pathToFileURL(entryPath).href), patched: false }
  }

  try {
    const url = materialise(entryPath, code)
    const module = await import(url)
    warn(`patched ${UPSTREAM} loaded (cache ${dirname(url)})`)
    return { module, patched: true }
  } catch (error) {
    warn(`patched copy failed to load (${String(error)}); running the stock bridge`)
    return { module: await import(pathToFileURL(entryPath).href), patched: false }
  }
}

const loaded = await loadUpstream()
const relay = createRelay()
const live = loaded.patched && liveEnabled()

const missing = EXPECTED_EXPORTS.filter((key) => loaded.module[key] === undefined)
const extra = Object.keys(loaded.module).filter((key) => !EXPECTED_EXPORTS.includes(key))
if (missing.length > 0 || extra.length > 0) {
  warn(`upstream export surface changed (missing=${missing.join(',') || 'none'}`
    + ` extra=${extra.join(',') || 'none'}); this shim only forwards ${EXPECTED_EXPORTS.join(',')}`)
}

export const Config = loaded.module.Config
export const inject = loaded.module.inject
export const name = loaded.module.name ?? 'acp'

/**
 * Hand the bridge's ACP client to the relay.
 *
 * Every forwarded frame goes through one promise chain: the relay and the bridge
 * share a single connection, and a commit that lands while deltas are still
 * draining must not overtake them.
 */
function attachToBridge(ctx, conn, methods) {
  const update = methods?.client?.session?.update ?? 'session/update'
  let tail = Promise.resolve()
  const send = (notification) => {
    tail = tail.then(() => conn.notify(update, notification)).catch(() => {})
  }
  followAssistantStream(ctx, relay, send)
  warn(`live streaming attached (${update})`)
}

export function apply(ctx, config) {
  if (live) {
    // The patched bridge calls back into the relay from inside its own apply,
    // which is the first point where its connection and method table exist.
    armBridge({
      relay,
      onBridge: (conn, methods) => attachToBridge(ctx, conn, methods),
    })
  }
  return loaded.module.apply(ctx, config)
}
