/** Paced slicing for oversized ACP text updates.
 *
 * The upstream bridge converts one *committed* assistant message into exactly
 * one `agent_thought_chunk` / `agent_message_chunk` frame, so a long reasoning
 * block reaches the client as a single multi-kilobyte write. Clients then show
 * nothing at all for the whole time the model spent generating it.
 *
 * This module re-sends such a frame as a short series of appended slices with a
 * small delay between them. Ordering is the caller's contract: `send` is awaited
 * for every slice, so the upstream serialised output queue keeps messages,
 * usage updates and tool calls in their original order.
 */

/** Characters per slice. Below this an update is forwarded untouched. */
export const DEFAULT_SLICE_CHARS = 800
/** Floor for the gap between two slices. */
export const DEFAULT_MIN_INTERVAL_MS = 60
/** Ceiling for the gap between two slices. */
export const DEFAULT_MAX_INTERVAL_MS = 250
/** Replay of one oversized block should not take longer than this. */
export const DEFAULT_MAX_TOTAL_MS = 15000
/** Update kinds whose text is sliced. Tool titles and plan rows are small. */
export const DEFAULT_SLICE_KINDS = 'agent_thought_chunk,agent_message_chunk'

const ENV_PREFIX = 'THREADHARBOR_ACP_STREAM'

function readInt(env, key, fallback, minimum) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fallback
  return parsed
}

/** Resolve pacer settings from the environment, falling back to safe defaults. */
export function pacerOptionsFromEnv(env = process.env) {
  const enabled = env[`${ENV_PREFIX}_ENABLED`]
  const sliceKinds = env[`${ENV_PREFIX}_KINDS`] ?? DEFAULT_SLICE_KINDS
  return {
    enabled: enabled === undefined ? true : enabled !== '0' && enabled !== 'false',
    sliceChars: readInt(env, `${ENV_PREFIX}_SLICE_CHARS`, DEFAULT_SLICE_CHARS, 1),
    minIntervalMs: readInt(env, `${ENV_PREFIX}_MIN_INTERVAL_MS`, DEFAULT_MIN_INTERVAL_MS, 0),
    maxIntervalMs: readInt(env, `${ENV_PREFIX}_MAX_INTERVAL_MS`, DEFAULT_MAX_INTERVAL_MS, 0),
    maxTotalMs: readInt(env, `${ENV_PREFIX}_MAX_TOTAL_MS`, DEFAULT_MAX_TOTAL_MS, 0),
    sliceKinds: new Set(
      sliceKinds.split(',').map((kind) => kind.trim()).filter((kind) => kind !== ''),
    ),
  }
}

/** The carried text of an ACP session/update notification, or undefined. */
export function updateText(notification) {
  if (notification === null || typeof notification !== 'object') return undefined
  const update = notification.update
  if (update === null || typeof update !== 'object') return undefined
  const content = update.content
  if (content === null || typeof content !== 'object') return undefined
  const text = content.text
  return typeof text === 'string' ? text : undefined
}

/** Whether this notification's kind is one the pacer splits. */
export function isSliceable(notification, options) {
  if (notification === null || typeof notification !== 'object') return false
  const kind = notification.update?.sessionUpdate
  return typeof kind === 'string' && options.sliceKinds.has(kind)
}

/** Split `text` into slices and pick the gap that keeps the replay bounded. */
export function planSlices(text, options) {
  const sliceChars = Math.max(1, options.sliceChars)
  const count = Math.max(1, Math.ceil(text.length / sliceChars))
  const slices = []
  for (let start = 0; start < text.length; start += sliceChars) {
    slices.push(text.slice(start, start + sliceChars))
  }
  const low = Math.max(0, options.minIntervalMs)
  const high = Math.max(low, options.maxIntervalMs)
  const budgeted = options.maxTotalMs > 0 ? options.maxTotalMs / slices.length : low
  const intervalMs = Math.min(high, Math.max(low, Math.floor(budgeted)))
  return { slices, intervalMs }
}

/** One sliced notification: same envelope, only the carried text is shorter. */
export function sliceNotification(notification, text) {
  return {
    ...notification,
    update: { ...notification.update, content: { ...notification.update.content, text } },
  }
}

function delay(ms) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Report one line per split frame; stderr is free because stdout is ACP's. */
function report(notification, charCount, sliceCount, intervalMs) {
  process.stderr.write(
    `threadharbor-acp-stream: session=${notification.sessionId ?? '?'}`
    + ` kind=${notification.update?.sessionUpdate ?? '?'} chars=${charCount}`
    + ` slices=${sliceCount} intervalMs=${intervalMs}\n`,
  )
}

/**
 * Forward one ACP session/update, slicing oversized text on the way out.
 *
 * @param notification - the notification upstream is about to send.
 * @param send - sends one (possibly sliced) notification; awaited per slice.
 * @param options - pacer settings; defaults to the environment.
 * @returns the number of notifications actually sent.
 */
export async function pacedSessionUpdate(notification, send, options = pacerOptionsFromEnv()) {
  const text = options.enabled === true ? updateText(notification) : undefined
  if (text === undefined || text.length <= options.sliceChars || !isSliceable(notification, options)) {
    await send(notification)
    return 1
  }
  const { slices, intervalMs } = planSlices(text, options)
  report(notification, text.length, slices.length, intervalMs)
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]
    if (slice === undefined) continue
    if (index > 0) await delay(intervalMs)
    await send(sliceNotification(notification, slice))
  }
  return slices.length
}
