/**
 * ZCode as a model, not as an ACP agent.
 *
 * The native loop already reads files, runs commands, asks for approval,
 * cancels, and writes the session. This only answers the model request:
 * decrypt the local login, call GLM, and hand the text and tool calls back.
 */

import { streamGlm } from '@threadharbor/zcode-acp'
import type { GlmStreamChunk } from '@threadharbor/zcode-acp'
import type { CatalogTurnRequest } from './catalog.ts'
import type { PresetConfig } from './registry.ts'

export function zcodeModelStream(
  config: PresetConfig,
): (presetId: string, request: CatalogTurnRequest) => AsyncIterable<GlmStreamChunk> | undefined {
  return (presetId, request) => {
    if (config.presets[presetId]?.agent !== 'zcode') return undefined
    const tools = normalizeTools(request.tools)
    return streamGlm({
      model: request.model,
      messages: Array.isArray(request.messages) ? request.messages : [],
      ...(typeof request.reasoningEffort === 'string' && request.reasoningEffort !== ''
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
      ...(typeof request.system === 'string' ? { system: request.system } : {}),
      ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
      ...(request.signal instanceof AbortSignal ? { signal: request.signal } : {}),
      ...(tools === undefined ? {} : { tools }),
    })
  }
}

function normalizeTools(
  tools: CatalogTurnRequest['tools'],
): { name: string; description?: string; parameters?: Record<string, unknown> }[] | undefined {
  if (tools === undefined) return undefined
  return tools.flatMap(tool => {
    if (typeof tool?.name !== 'string' || tool.name === '') return []
    return [{
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined && typeof tool.parameters === 'object' ? { parameters: tool.parameters } : {}),
    }]
  })
}
