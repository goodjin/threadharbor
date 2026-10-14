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
    throw new Error(scrub(error instanceof Error ? error.message : String(error), apiKey))
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
    throw new Error(scrub(error instanceof Error ? error.message : String(error), apiKey))
  }
}

async function resolveApiKey(request: GlmRequest): Promise<string> {
  if (request.apiKey !== undefined && request.apiKey !== '') return request.apiKey
  const configured = request.credentialsFile ?? process.env[CREDENTIALS_ENV]
  const file = configured !== undefined && configured !== ''
    ? configured
    : `${homedir()}/.zcode/v2/credentials.json`
  return loadApiKey(file)
}

function resolveEndpoint(override: string | undefined): string {
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
