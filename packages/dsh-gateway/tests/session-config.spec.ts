import { describe, expect, it } from 'vitest'
import type { JsonValue, RemoteSessionConfigOption } from '@threadharbor/protocol'
import { applyConfigFrame, configOptionsFromResult, configSwitchRequest, withSwitchedValue } from '../src/session-config.ts'

const CLAUDE_NEW_RESULT: JsonValue = {
  sessionId: 'native-1',
  modes: {
    currentModeId: 'default',
    availableModes: [{ id: 'default', name: 'Manual' }, { id: 'bypassPermissions', name: 'Bypass Permissions' }],
  },
  configOptions: [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Manual', description: 'Standard behavior, prompts for dangerous operations' },
        { value: 'acceptEdits', name: 'Accept Edits' },
        { value: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    },
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Default (recommended)', description: 'Opus (1M context)' },
        { value: 'opus[1m]', name: 'Opus (1M context)' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    },
    { id: 'broken', name: 'No choices', currentValue: 'x', options: [] },
  ],
}

const CODEX_NEW_RESULT: JsonValue = {
  sessionId: 'native-2',
  modes: {
    currentModeId: 'agent',
    availableModes: [
      { id: 'read-only', name: 'Ask for approval' },
      { id: 'agent', name: 'Approve for me' },
      { id: 'agent-full-access', name: 'Full access' },
    ],
  },
  models: {
    currentModelId: 'gpt-5.6-terra[medium]',
    availableModels: [
      { modelId: 'gpt-5.6-terra[low]', name: 'GPT-5.6-Terra (low)' },
      { modelId: 'gpt-5.6-terra[medium]', name: 'GPT-5.6-Terra (medium)' },
    ],
  },
}

describe('session config projection', () => {
  it('prefers native ACP configOptions and drops options without choices', () => {
    const options = configOptionsFromResult(CLAUDE_NEW_RESULT)
    expect(options?.map(option => option.id)).toEqual(['mode', 'model'])
    expect(options?.[0]).toMatchObject({ id: 'mode', category: 'mode', currentValue: 'default', setter: 'config' })
    expect(options?.[0]?.options[0]).toEqual({
      value: 'default', name: 'Manual', description: 'Standard behavior, prompts for dangerous operations',
    })
    expect(options?.[1]?.options.map(choice => choice.value)).toEqual(['default', 'opus[1m]', 'sonnet'])
  })

  it('synthesizes mode/model options from the older ACP modes/models blocks', () => {
    const options = configOptionsFromResult(CODEX_NEW_RESULT)
    expect(options).toEqual([
      {
        id: 'mode', name: 'Mode', category: 'mode', currentValue: 'agent', setter: 'mode',
        options: [
          { value: 'read-only', name: 'Ask for approval' },
          { value: 'agent', name: 'Approve for me' },
          { value: 'agent-full-access', name: 'Full access' },
        ],
      },
      {
        id: 'model', name: 'Model', category: 'model', currentValue: 'gpt-5.6-terra[medium]', setter: 'model',
        options: [
          { value: 'gpt-5.6-terra[low]', name: 'GPT-5.6-Terra (low)' },
          { value: 'gpt-5.6-terra[medium]', name: 'GPT-5.6-Terra (medium)' },
        ],
      },
    ])
    expect(configOptionsFromResult({ sessionId: 'plain' })).toBeUndefined()
    expect(configOptionsFromResult('nope')).toBeUndefined()
  })

  it('folds journal frames: session/new responses, config_option_update, current_mode_update', () => {
    const fromNew = applyConfigFrame(undefined, { jsonrpc: '2.0', id: 'hostd-session-1', result: CLAUDE_NEW_RESULT })
    expect(fromNew?.map(option => option.currentValue)).toEqual(['default', 'default'])
    const irrelevant = applyConfigFrame(fromNew, { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } })
    expect(irrelevant).toBe(fromNew)
    const modeSwitched = applyConfigFrame(fromNew, { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' } } })
    expect(modeSwitched?.[0]?.currentValue).toBe('bypassPermissions')
    expect(modeSwitched?.[1]).toBe(fromNew?.[1])
    const unchanged = applyConfigFrame(modeSwitched, { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' } } })
    expect(unchanged).toBe(modeSwitched)
    const replaced = applyConfigFrame(modeSwitched, {
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'config_option_update', configOptions: [
        { id: 'model', name: 'Model', category: 'model', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet' }] },
      ] } },
    })
    expect(replaced?.map(option => `${option.id}=${option.currentValue}`)).toEqual(['model=sonnet'])
    // A response without settings (e.g. a prompt result) leaves the list alone.
    expect(applyConfigFrame(replaced, { jsonrpc: '2.0', id: 'p1', result: { stopReason: 'end_turn' } })).toBe(replaced)
  })

  it('builds the native switch request for each setter', () => {
    const [mode, model] = configOptionsFromResult(CODEX_NEW_RESULT) as RemoteSessionConfigOption[]
    const [config] = configOptionsFromResult(CLAUDE_NEW_RESULT) as RemoteSessionConfigOption[]
    expect(configSwitchRequest(config as RemoteSessionConfigOption, 'n1', 'bypassPermissions', 'rpc-1')).toEqual({
      jsonrpc: '2.0', id: 'rpc-1', method: 'session/set_config_option',
      params: { sessionId: 'n1', configId: 'mode', value: 'bypassPermissions' },
    })
    expect(configSwitchRequest(mode as RemoteSessionConfigOption, 'n2', 'agent-full-access', 'rpc-2')).toEqual({
      jsonrpc: '2.0', id: 'rpc-2', method: 'session/set_mode', params: { sessionId: 'n2', modeId: 'agent-full-access' },
    })
    expect(configSwitchRequest(model as RemoteSessionConfigOption, 'n2', 'gpt-5.6-terra[low]', 'rpc-3')).toEqual({
      jsonrpc: '2.0', id: 'rpc-3', method: 'session/set_model', params: { sessionId: 'n2', modelId: 'gpt-5.6-terra[low]' },
    })
    const switched = withSwitchedValue([mode as RemoteSessionConfigOption, model as RemoteSessionConfigOption], 'model', 'gpt-5.6-terra[low]')
    expect(switched[1]?.currentValue).toBe('gpt-5.6-terra[low]')
    expect(switched[0]).toBe(mode)
  })
})
