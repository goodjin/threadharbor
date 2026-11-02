import { describe, expect, it } from 'vitest'
import * as acp from '../src/index.ts'

describe('merged exports', () => {
  it('exports zcode symbols', () => {
    expect(typeof acp.decryptCredential).toBe('function')
    expect(typeof acp.streamGlm).toBe('function')
    expect(typeof acp.fetchCodingPlanQuota).toBe('function')
    expect(typeof acp.BIGMODEL_CODING_PLAN_BASE).toBe('string')
  })

  it('exports minimaxi symbols', () => {
    expect(typeof acp.resolveCredential).toBe('function')
    expect(typeof acp.streamMiniMax).toBe('function')
    expect(typeof acp.fetchMiniMaxQuota).toBe('function')
    expect(typeof acp.canDisableThinking).toBe('function')
  })

  it('disambiguates shared names with MiniMax prefix', () => {
    expect(typeof acp.miniMaxBuildAnthropicBody).toBe('function')
    expect(typeof acp.miniMaxReasoningFields).toBe('function')
    expect(typeof acp.miniMaxMessagesUrl).toBe('function')
    expect(typeof acp.defaultMaxTokens).toBe('function')
  })

  it('zcode exports remain un-prefixed', () => {
    expect(typeof acp.buildAnthropicBody).toBe('function')
    expect(typeof acp.reasoningFields).toBe('function')
    expect(typeof acp.messagesUrl).toBe('function')
  })
})
