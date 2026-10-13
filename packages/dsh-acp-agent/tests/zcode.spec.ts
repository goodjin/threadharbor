/**
 * The zcode dialect, over frames the adapter itself emits.
 *
 * The fixtures inline the shapes `packages/zcode-acp` produces (they follow
 * the codex/grok conventions on purpose); the point under test is that the
 * dialect reads them back exactly — the model list, the latched tool
 * identity, the empty tool output, the reply usage, and the chatter filter.
 */

import { describe, expect, it } from 'vitest'
import { zcodeDialect } from '../src/dialects/zcode.ts'

const sessionNewReply = {
  sessionId: 'sess_1',
  modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] },
  models: {
    currentModelId: 'GLM-5.3',
    availableModels: [
      { modelId: 'GLM-5.3', name: 'GLM 5.3', description: 'GLM Coding Plan via the local ZCode app' },
      { modelId: 'GLM-5.3-Flash', name: 'GLM 5.3-Flash' },
      { modelId: 'GLM-5.2', name: 'GLM 5.2' },
    ],
  },
}

const toolOpen = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_w1',
  title: 'Write',
  kind: 'edit',
  status: 'pending',
  rawInput: {},
  content: [],
}

const toolDone = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_w1',
  title: 'Write',
  status: 'completed',
  content: [],
}

describe('zcode dialect', () => {
  it('reads the model list from models.availableModels', () => {
    expect(zcodeDialect.readModels(sessionNewReply)).toEqual([
      { id: 'GLM-5.3', name: 'GLM 5.3', description: 'GLM Coding Plan via the local ZCode app' },
      { id: 'GLM-5.3-Flash', name: 'GLM 5.3-Flash' },
      { id: 'GLM-5.2', name: 'GLM 5.2' },
    ])
  })

  it('latches the tool name from title across the call\'s frames', () => {
    const opened = zcodeDialect.foldTool(undefined, toolOpen)
    expect(opened).toMatchObject({ callId: 'call_w1', name: 'Write', status: 'pending', output: '' })
    const done = zcodeDialect.foldTool(opened, toolDone)
    expect(done).toMatchObject({ callId: 'call_w1', name: 'Write', status: 'completed', output: '' })
  })

  it('folds tool output out of the nested content array', () => {
    expect(zcodeDialect.toolOutput(toolDone)).toBe('')
    expect(zcodeDialect.toolOutput({ ...toolDone, content: [{ type: 'text', text: { type: 'text', text: 'ok' } }] })).toBe('')
    // the adapter sends double-nested text the way grok/claude do
    expect(zcodeDialect.toolOutput({
      sessionUpdate: 'tool_call_update',
      content: [{ content: { type: 'text', text: 'done' } }],
    })).toBe('done')
  })

  it('reads the reply usage with the renamed buckets', () => {
    expect(zcodeDialect.readReplyUsage({
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, thoughtTokens: 2 },
    })).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 2 })
    // an unreported usage stays undefined rather than a fabricated zero
    expect(zcodeDialect.readReplyUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(zcodeDialect.readReplyUsage({ stopReason: 'end_turn', usage: { outputTokens: 5 } })).toBeUndefined()
  })

  it('treats content frames as content and chatter as chatter', () => {
    expect(zcodeDialect.isContent({ sessionUpdate: 'agent_message_chunk' })).toBe(true)
    expect(zcodeDialect.isContent({ sessionUpdate: 'agent_thought_chunk' })).toBe(true)
    expect(zcodeDialect.isContent({ sessionUpdate: 'tool_call' })).toBe(true)
    expect(zcodeDialect.isContent({ sessionUpdate: 'usage_update', used: 1, size: 10 })).toBe(false)
    expect(zcodeDialect.isContent({ sessionUpdate: 'available_commands_update' })).toBe(false)
  })

  it('declares the capabilities the adapter was measured to have', () => {
    expect(zcodeDialect.capabilities).toMatchObject({
      cancelsTurns: true,
      acceptsImageContent: false,
      toolFrameShape: 'two_frame',
      commandVia: 'tool_frame',
    })
  })

  it('maps ZCode tool names onto the DSH short names', () => {
    expect(zcodeDialect.capabilities.toolNameMap['Write']).toBe('write')
    expect(zcodeDialect.capabilities.toolNameMap['Edit']).toBe('edit')
    expect(zcodeDialect.capabilities.toolNameMap['Read']).toBe('read')
    expect(zcodeDialect.capabilities.toolNameMap['Bash']).toBe('bash')
    expect(zcodeDialect.capabilities.toolNameMap['Grep']).toBe('grep')
    expect(zcodeDialect.capabilities.toolNameMap['Glob']).toBe('glob')
  })
})
