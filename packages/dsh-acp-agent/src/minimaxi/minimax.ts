/**
 * One turn against MiniMax's managed gateway.
 *
 * The credential comes from the local MiniMax Code login and stays in memory;
 * nothing here writes it, and every failure message is scrubbed before it can
 * reach a log. Reading files, running commands, approval, cancellation and the
 * session transcript stay with DSH's own loop — this only answers the model
 * request, exactly as the GLM plugin does.
 */

import { buildAnthropicBody } from './anthropic.ts'
import type { PromptInput, PromptTool } from './anthropic.ts'
import { messagesUrl } from './credential.ts'
import type { CredentialOverrides, MiniMaxCredential } from './credential.ts'
import { resolveCredential } from './credential.ts'
import { chunksFromEvents, readSseEvents } from './sse.ts'
import type { MiniMaxStreamChunk } from './sse.ts'

export type MiniMaxRequest = PromptInput & {
  readonly credential?: MiniMaxCredential
  /** Everything `resolveCredential` takes; tests pass overrides so no real login is needed. */
  readonly credentialOverrides?: CredentialOverrides
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** Stream one turn. Cancellation rejects the iterator; the text already sent stays. */
export async function* streamMiniMax(request: MiniMaxRequest): AsyncGenerator<MiniMaxStreamChunk> {
  const credential = request.credential ?? await resolveCredential(request.credentialOverrides ?? {})
  const url = messagesUrl(credential.baseUrl)
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
        authorization: `Bearer ${credential.accessToken}`,
      },
      body: JSON.stringify(body),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (isAbort(error) || request.signal?.aborted === true) throw error
    yield transportFailure(error, credential.accessToken)
    return
  }
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), credential.accessToken).slice(0, 500)
    throw new Error(
      `MiniMax request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`
      + (response.status === 401 || response.status === 403
        ? ' — the local MiniMax Code login was rejected; open MiniMax Code and log in again'
        : ''),
    )
  }
  if (response.body === null) throw new Error('MiniMax request returned no body')
  try {
    for await (const chunk of chunksFromEvents(readSseEvents(response.body))) {
      yield scrubChunk(chunk, credential.accessToken)
    }
  } catch (error) {
    if (isAbort(error) || request.signal?.aborted === true) throw error
    yield transportFailure(error, credential.accessToken)
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
 * in the cause chain, so that is what the message names. The token never
 * reaches it: the message is scrubbed like every other one.
 */
function transportFailure(error: unknown, secret: string): MiniMaxStreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: scrub(`MiniMax request failed: ${describeTransportFailure(error)}`, secret),
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

/** Drop the token from anything that might be shown. A short or empty secret is left alone. */
export function scrub(text: string, secret: string): string {
  if (secret.length < 8) return text
  return text.split(secret).join('[redacted]')
}

function scrubChunk(chunk: MiniMaxStreamChunk, secret: string): MiniMaxStreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: scrub(chunk.reason.failure.message, secret), code: chunk.reason.failure.code },
    },
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export type { PromptTool }
