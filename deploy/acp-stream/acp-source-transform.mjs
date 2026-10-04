/** Source transform that adds live streaming to the ACP bridge.
 *
 * Two injections, both anchored on single unique lines, so an upstream release
 * that moves the code makes the patch *fail loudly* (and the entry falls back to
 * the stock module) instead of silently half-applying:
 *
 *   1. right after the bridge's ACP client is created, hand the client to the
 *      relay so live chunks can be forwarded through the same connection;
 *   2. where a committed block is forwarded to the client, route it through the
 *      relay first, which drops it when the live stream already sent that text.
 *
 * @module
 */

/** Marks a patched copy; also used to refuse to patch an already patched file. */
export const PATCH_MARKER = 'threadharbor-acp-stream'

/** The one line in dsh-acp that forwards a session/update to the client. */
export const NOTIFY_ANCHOR =
  'await conn.notify(methods.client.session.update, notification);'

/** Structural guard: the function the anchor must live in. */
export const NOTIFY_CONTEXT = 'const notify = async (notification) => {'

/** The one line where the bridge's client end of the connection is available. */
export const BRIDGE_ANCHOR = 'const conn = connection.client;'

/** Bumped whenever the injected call changes, to invalidate cached copies. */
export const TRANSFORM_VERSION = 2

const IMPORT_LINE = (helperUrl) =>
  `import { installBridge as __threadharborBridge, notifyThroughBridge as __threadharborNotify }`
  + ` from ${JSON.stringify(helperUrl)};`

const REPLACEMENT_LINE =
  'await __threadharborNotify(notification,'
  + ' (sliced) => conn.notify(methods.client.session.update, sliced));'

/** Keeps the injected line at whatever indentation upstream used. */
const BRIDGE_ANCHOR_PATTERN = new RegExp(`^(\\s*)${BRIDGE_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Rewrite one dsh-acp source file so it streams live and de-duplicates commits.
 *
 * @param source - verbatim contents of the upstream `dsh-acp` entry module.
 * @param helperUrl - absolute file URL of the relay module to import.
 * @returns `{ code, applied, reason }`; `code` is the input when not applied.
 */
export function transformAcpSource(source, helperUrl) {
  if (typeof source !== 'string' || source === '') {
    return { code: source, applied: false, reason: 'empty source' }
  }
  if (source.includes(PATCH_MARKER)) {
    return { code: source, applied: false, reason: 'source is already patched' }
  }
  if (!source.includes(NOTIFY_CONTEXT)) {
    return { code: source, applied: false, reason: 'notify() shape changed' }
  }
  if (!source.includes(BRIDGE_ANCHOR)) {
    return { code: source, applied: false, reason: 'connection setup changed' }
  }
  const anchors = countOccurrences(source, NOTIFY_ANCHOR)
  if (anchors !== 1) {
    return { code: source, applied: false, reason: `expected 1 notify anchor, found ${anchors}` }
  }
  const bridges = countOccurrences(source, BRIDGE_ANCHOR)
  if (bridges !== 1) {
    return { code: source, applied: false, reason: `expected 1 bridge anchor, found ${bridges}` }
  }

  // Keep a shebang on the first line; everything else can be prepended freely.
  const body = source.startsWith('#!')
    ? `${source.slice(0, source.indexOf('\n') + 1)}${IMPORT_LINE(helperUrl)}\n${source.slice(source.indexOf('\n') + 1)}`
    : `${IMPORT_LINE(helperUrl)}\n${source}`

  const marker = `\n/* ${PATCH_MARKER}: v${TRANSFORM_VERSION} */`
  const patched = body
    .replace(NOTIFY_ANCHOR, `${REPLACEMENT_LINE}${marker}`)
    .replace(BRIDGE_ANCHOR_PATTERN, (match, indent) =>
      `${match}\n${indent}__threadharborBridge(conn, methods);`)
  return { code: patched, applied: true, reason: 'patched' }
}
