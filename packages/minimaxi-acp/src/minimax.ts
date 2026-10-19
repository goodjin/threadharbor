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
    throw new Error(scrub(error instanceof Error ? error.message : String(error), credential.accessToken))
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
    throw new Error(scrub(error instanceof Error ? error.message : String(error), credential.accessToken))
  }
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
