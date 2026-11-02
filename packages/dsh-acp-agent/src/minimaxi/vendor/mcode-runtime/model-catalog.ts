/**
 * The MiniMax model catalog, copied from MiniMax Code's own first-run catalog.
 *
 * Upstream: `packages/config/src/minimax-model-catalog.ts` in
 * MiniMax-AI/minimax-code, which is derived from models.dev (MIT — the notice
 * is in NOTICE.md next to this file).
 *
 * The only change from upstream is the type import: upstream pulls `ModelConfig`
 * out of a 93 KB `config.ts` we do not vendor, so the two fields this plugin
 * reads are declared here instead. The values are untouched.
 *
 * `thinking_config.mode` is the fact that decides a request: `forced_on` models
 * reject `thinking: { type: 'disabled' }` outright, `switchable` models accept it.
 * `thinking.effortOptions` is the depth ladder such a model publishes.
 */

// Shared first-run catalog; an existing remote snapshot remains authoritative.
export type ModelCapabilitiesConfig = {
  support_files_api?: boolean
  files_api_upload_endpoint?: string
  max_image_bytes_inline?: number
  max_video_bytes_inline?: number
  max_request_body_bytes?: number
  max_attachments_count?: number
}

export type ModelConfig = {
  name: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  temperature: boolean
  modalities: { input: readonly string[]; output: readonly string[] }
  limit: { context: number; output: number }
  contextWindowOptions?: readonly number[]
  contextWindowOptionHints?: Readonly<Record<string, string>>
  options?: Readonly<Record<string, string>>
  thinking?: { effortOptions: readonly string[]; defaultEffort: string }
  thinking_config?: { mode: 'switchable' | 'forced_on'; default_value?: string }
  variants?: Readonly<Record<string, { thinking: { type: 'adaptive' | 'disabled' } }>>
  capabilities?: ModelCapabilitiesConfig
}

const MINIMAX_M3_FILE_API_CAPABILITIES: ModelCapabilitiesConfig = {
  support_files_api: true,
  files_api_upload_endpoint: '/v1/files/upload',
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: 67_108_864,
  max_attachments_count: 4,
}

export const MINIMAX_MODELS: Record<string, ModelConfig> = {
  'MiniMax-M3': {
    name: 'MiniMax-M3',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { '1000000': 'higher_usage' },
    options: { reasoningSummary: 'auto' },
    thinking_config: { mode: 'switchable', default_value: 'true' },
    variants: {
      'none-thinking': { thinking: { type: 'disabled' } },
      thinking: { thinking: { type: 'adaptive' } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
  'MiniMax-M3.1-Flash': {
    name: 'M3.1-Flash',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { '1000000': 'higher_usage' },
    options: { reasoningSummary: 'auto' },
    thinking: {
      effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'default',
    },
    thinking_config: { mode: 'forced_on' },
    variants: {
      'none-thinking': { thinking: { type: 'disabled' } },
      thinking: { thinking: { type: 'adaptive' } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
  'MiniMax-M2.7-highspeed': {
    name: 'MiniMax-M2.7-highspeed',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 200000, output: 128000 },
  },
  'MiniMax-M2.7': {
    name: 'MiniMax-M2.7',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 200000, output: 128000 },
  },
}

/**
 * Whether a model may be asked not to think.
 *
 * `forced_on` models answer `thinking: { type: 'disabled' }` with an error, so
 * the request has to leave the switch alone for them. A model the catalog does
 * not carry is treated as switchable — the published models that cannot be
 * switched off are the ones that say so.
 */
export function canDisableThinking(model: string): boolean {
  return MINIMAX_MODELS[model]?.thinking_config?.mode !== 'forced_on'
}
