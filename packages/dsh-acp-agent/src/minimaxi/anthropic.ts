/**
 * The MiniMax request, shaped the way MiniMax Code's own anthropic adapter
 * shapes it.
 *
 * The managed gateway speaks anthropic messages, so the envelope is the same one
 * GLM uses. Three things are MiniMax's own and are why this is not a shared
 * file: the depth ladder (`low|medium|high|xhigh|max`), the models that refuse to
 * be told to stop thinking, and the thinking signature that has to be handed
 * back byte for byte or the chain breaks.
 *
 * Reasoning follows the catalog: `thinking.type` is `adaptive` unless the caller
 * asked for none *and* the model allows it. Depth rides in `output_config.effort`.
 */

import { MINIMAX_MODELS, canDisableThinking } from './vendor/mcode-runtime/model-catalog.ts'

/** Output ceiling for a model the catalog does not carry. */
const FALLBACK_MAX_TOKENS = 32_000

/** Depth names MiniMax accepts. Anything else is mapped onto the nearest one. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export type AnthropicContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'redacted_thinking'; readonly data: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: true }

export type AnthropicMessage = {
  readonly role: 'user' | 'assistant'
  content: AnthropicContent[]
}

export type AnthropicTool = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export type AnthropicBody = {
  readonly model: string
  readonly max_tokens: number
  readonly stream: true
  readonly messages: readonly AnthropicMessage[]
  readonly system?: string
  readonly tools?: readonly AnthropicTool[]
  readonly thinking: { readonly type: 'disabled' } | { readonly type: 'adaptive' }
  readonly output_config?: { readonly effort: Effort }
}

export type PromptTool = {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

export type PromptInput = {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly tools?: readonly PromptTool[]
  readonly system?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** The output ceiling the model itself publishes. */
export function defaultMaxTokens(model: string): number {
  return MINIMAX_MODELS[model]?.limit.output ?? FALLBACK_MAX_TOKENS
}

/**
 * Map DSH's reasoning effort onto the two fields MiniMax reads.
 *
 * A request to stop thinking is honoured only where the model allows it: the
 * always-thinking models answer `disabled` with an error, so there the ask is
 * dropped and they go on thinking at their ordinary depth.
 */
export function reasoningFields(
  model: string,
  effort: string | undefined,
): Pick<AnthropicBody, 'thinking' | 'output_config'> {
  const level = (effort ?? 'high').trim().toLowerCase()
  const wantsNone = level === 'none' || level === 'disabled' || level === 'off'
  if (wantsNone) {
    return canDisableThinking(model) ? { thinking: { type: 'disabled' } } : { thinking: { type: 'adaptive' } }
  }
  return { thinking: { type: 'adaptive' }, output_config: { effort: mapEffort(level) } }
}

function mapEffort(level: string): Effort {
  if (level === 'minimal') return 'low'
  if (level === 'ultra') return 'max'
  const match = EFFORTS.find(effort => effort === level)
  return match ?? 'high'
}

/** The JSON body for one messages call. */
export function buildAnthropicBody(input: PromptInput): AnthropicBody {
  const systemParts: string[] = []
  if (input.system !== undefined && input.system.trim() !== '') systemParts.push(input.system)
  const messages = projectMessages(input.messages, systemParts)
  const tools = input.tools === undefined ? undefined : input.tools.map(toolSchema)
  const reasoning = reasoningFields(input.model, input.reasoningEffort)
  const ceiling = defaultMaxTokens(input.model)
  const maxTokens = typeof input.maxTokens === 'number' && input.maxTokens > 0
    ? Math.min(Math.floor(input.maxTokens), ceiling)
    : ceiling
  return {
    model: input.model,
    max_tokens: maxTokens,
    stream: true,
    messages,
    ...reasoning,
    ...(systemParts.length === 0 ? {} : { system: systemParts.join('\n\n') }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
  }
}

function toolSchema(tool: PromptTool): AnthropicTool {
  const parameters = isRecord(tool.parameters) ? { ...tool.parameters } : {}
  if (typeof parameters['type'] !== 'string') parameters['type'] = 'object'
  return { name: tool.name, description: tool.description ?? tool.name, input_schema: parameters }
}

function projectMessages(messages: readonly unknown[], systemParts: string[]): AnthropicMessage[] {
  const turns: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', content: AnthropicContent[]): void => {
    if (content.length === 0) return
    const last = turns[turns.length - 1]
    if (last !== undefined && last.role === role) {
      last.content.push(...content)
      return
    }
    turns.push({ role, content: [...content] })
  }
  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = message['role']
    if (role === 'system' || role === 'developer') {
      const text = textOf(message['content']).join('\n')
      if (text !== '') systemParts.push(text)
      continue
    }
    if (role === 'user') {
      push('user', userContent(message['content']))
      continue
    }
    if (role === 'assistant') {
      push('assistant', assistantContent(message))
      continue
    }
    if (role === 'tool') push('user', [toolResult(message)])
  }
  if (turns.length === 0 || turns[0]?.role === 'assistant') {
    turns.unshift({ role: 'user', content: [{ type: 'text', text: '.' }] })
  }
  return turns
}

function assistantContent(message: Record<string, unknown>): AnthropicContent[] {
  const blocks = Array.isArray(message['content']) ? message['content'] : []
  const replay = replayBlocks(message)
  const content: AnthropicContent[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!isRecord(block)) continue
    const meta = replayEntry(replay, index)
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      content.push({ type: 'text', text: block['text'] })
      continue
    }
    if (block['type'] === 'reasoning') {
      if (typeof meta['redactedData'] === 'string') {
        content.push({ type: 'redacted_thinking', data: meta['redactedData'] })
        continue
      }
      content.push({
        type: 'thinking',
        thinking: typeof block['text'] === 'string' ? block['text'] : '',
        signature: typeof meta['signature'] === 'string' ? meta['signature'] : '',
      })
      continue
    }
    if (block['type'] === 'tool-call') {
      content.push({
        type: 'tool_use',
        id: typeof block['id'] === 'string' && block['id'] !== '' ? block['id'] : `call-${String(index)}`,
        name: typeof block['name'] === 'string' && block['name'] !== '' ? block['name'] : 'tool',
        input: parseInput(block['arguments']),
      })
    }
  }
  return content
}

function userContent(content: unknown): AnthropicContent[] {
  // A bare string is a real shape DSH can hand over. Without this branch it
  // would project to nothing and the turn would silently start with the '.'
  // placeholder below — a wrong answer that looks like a model problem.
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  const blocks = Array.isArray(content) ? content : []
  const projected: AnthropicContent[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      projected.push({ type: 'text', text: block['text'] })
      continue
    }
    if (block['type'] === 'image') projected.push({ type: 'text', text: '[image attached]' })
    if (block['type'] === 'file') projected.push({ type: 'text', text: '[file attached]' })
  }
  return projected
}

function toolResult(message: Record<string, unknown>): AnthropicContent {
  const source = isRecord(message['source']) ? message['source'] : undefined
  const fromSource = source?.['callId']
  const id = typeof message['toolCallId'] === 'string' && message['toolCallId'] !== ''
    ? message['toolCallId']
    : typeof fromSource === 'string' && fromSource !== ''
      ? fromSource
      : 'call'
  const text = textOf(message['content']).join('\n')
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: text,
    ...(message['isError'] === true ? { is_error: true } : {}),
  }
}

function textOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      texts.push(block['text'])
    }
  }
  return texts
}

function replayBlocks(message: Record<string, unknown>): readonly unknown[] | undefined {
  const source = message['source']
  if (!isRecord(source)) return undefined
  const replay = source['replayState']
  if (!isRecord(replay) || !Array.isArray(replay['blocks'])) return undefined
  return replay['blocks']
}

function replayEntry(blocks: readonly unknown[] | undefined, index: number): Record<string, unknown> {
  const entry = blocks?.[index]
  return isRecord(entry) ? entry : {}
}

function parseInput(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.trim() === '') return {}
    try {
      return JSON.parse(value) as unknown
    } catch {
      return { raw: value }
    }
  }
  if (isRecord(value) || Array.isArray(value)) return value
  return {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
