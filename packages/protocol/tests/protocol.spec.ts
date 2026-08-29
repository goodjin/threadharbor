import { describe, expect, it } from 'vitest'
import { parseRemoteControlRequest, remoteAgentBackend, remoteAgentConfigBackend } from '../src/index.ts'

describe('remote-agent control protocol', () => {
  it('parses JSON request envelopes and branded backend values', () => {
    expect(parseRemoteControlRequest({ id: 'r1', method: 'state', params: {} })).toEqual({
      id: 'r1', method: 'state', params: {},
    })
    expect(remoteAgentBackend('codex')).toBe('codex')
    expect(remoteAgentBackend('claude')).toBe('claude')
    expect(remoteAgentConfigBackend('grok')).toBe('grok')
  })

  it('rejects non-JSON params and unknown backend values at wire boundaries', () => {
    expect(() => parseRemoteControlRequest({ id: 'r1', method: 'state', params: { bad: Number.NaN } }))
      .toThrow('control request must be a JSON object')
    expect(() => remoteAgentBackend('other')).toThrow('backend must be one of grok, codex, claude, dsh')
    expect(() => remoteAgentConfigBackend('dsh')).toThrow('config backend must be one of grok, codex, claude')
  })
})
