/**
 * One GLM Coding Plan call.
 *
 * The key is the desktop app's coding-plan credential, decrypted in memory.
 * The request goes to the anthropic messages URL with both `x-api-key` and
 * `Authorization: Bearer`, which is how ZCode's adapter authenticates that
 * gateway. Nothing here writes the key, and a failure message has it stripped
 * before it can reach a log.
 */

import { homedir } from 'node:os'
import { BIGMODEL_CODING_PLAN_BASE, buildAnthropicBody, messagesUrl } from './anthropic.ts'
import type { PromptInput } from './anthropic.ts'
import { loadApiKey } from './credential.ts'
import { chunksFromEvents, readSseEvents } from './sse.ts'
import type { GlmStreamChunk } from './sse.ts'

export type GlmRequest = PromptInput & {
  readonly signal?: AbortSignal
  /** Overrides the decrypted key. Tests pass one so they never touch a real login. */
  readonly apiKey?: string
  /** Overrides `ZCODE_ACP_CREDENTIALS_FILE` and `~/.zcode/v2/credentials.json`. */
  readonly credentialsFile?: string
  /** Full messages URL, or a coding-plan base (`…/api/anthropic`). */
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
}

/** The key/endpoint override face `streamGlm` and the quota call share. */
export type GlmKeyedRequest = {
  readonly apiKey?: string
  readonly credentialsFile?: string
  readonly endpoint?: string
}

const CREDENTIALS_ENV = 'ZCODE_ACP_CREDENTIALS_FILE'
const ENDPOINT_ENV = 'ZCODE_GLM_BASE_URL'

/** Stream one turn. Cancellation rejects the iterator; the loop keeps the text already sent. */
export async function* streamGlm(request: GlmRequest): AsyncGenerator<GlmStreamChunk> {
  const apiKey = await resolveApiKey(request)
  const url = resolveEndpoint(request.endpoint)
  const body = buildAnthropicBody(request)
  const fetchImpl = request.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (isAbort(error) || request.signal?.aborted === true) throw error
    yield transportFailure(error, apiKey)
    return
  }
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), apiKey).slice(0, 500)
    throw new Error(`GLM request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  if (response.body === null) throw new Error('GLM request returned no body')
  try {
    for await (const chunk of chunksFromEvents(readSseEvents(response.body))) {
      yield scrubChunk(chunk, apiKey)
    }
  } catch (error) {
    if (isAbort(error) || request.signal?.aborted === true) throw error
    yield transportFailure(error, apiKey)
    return
  }
}

/**
 * The failure code the host retries on its own.
 *
 * A connection that dies is not a wrong answer, it is a moment lost: the host
 * retries TRANSPORT failures itself, so a proxy hiccup costs a second instead
 * of the turn. Any other code ends the turn outright.
 */
const TRANSPORT_CODE = 'TRANSPORT'

/**
 * The terminal chunk for a network failure.
 *
 * Undici names these only "fetch failed"; the reason that matters — the proxy
 * that went away, the refused connection, the name that did not resolve — sits
 * in the cause chain, so that is what the message names. The key never reaches
 * it: the message is scrubbed like every other one.
 */
function transportFailure(error: unknown, apiKey: string): GlmStreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: scrub(`GLM request failed: ${describeTransportFailure(error)}`, apiKey),
        code: TRANSPORT_CODE,
      },
    },
  }
}

/** The one-line reason for a network failure: the deepest cause that says why. */
function describeTransportFailure(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error)
  let detail = ''
  let current: unknown = (error as { cause?: unknown } | null | undefined)?.cause
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const message = current instanceof Error
      ? current.message
      : typeof current === 'string' ? current : ''
    if (message !== '' && message !== base) detail = message
    current = (current as { cause?: unknown }).cause
  }
  return detail === '' ? base : detail
}

/** The decrypted coding-plan key of a request's overrides (exported for the quota call). */
export async function resolveApiKey(request: GlmKeyedRequest): Promise<string> {
  if (request.apiKey !== undefined && request.apiKey !== '') return request.apiKey
  const configured = request.credentialsFile ?? process.env[CREDENTIALS_ENV]
  const file = configured !== undefined && configured !== ''
    ? configured
    : `${homedir()}/.zcode/v2/credentials.json`
  return loadApiKey(file)
}

/** The messages URL of a request's endpoint override, or the configured default. */
export function resolveEndpoint(override: string | undefined): string {
  const configured = override ?? process.env[ENDPOINT_ENV]
  const base = configured !== undefined && configured.trim() !== ''
    ? configured.trim()
    : BIGMODEL_CODING_PLAN_BASE
  return base.endsWith('/messages') ? base : messagesUrl(base)
}

function scrubChunk(chunk: GlmStreamChunk, secret: string): GlmStreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: scrub(chunk.reason.failure.message, secret), code: chunk.reason.failure.code },
    },
  }
}

/** Drop the key from anything that might be shown. A short or empty secret is left alone. */
export function scrub(text: string, secret: string): string {
  if (secret.length < 8) return text
  return text.split(secret).join('[redacted]')
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
