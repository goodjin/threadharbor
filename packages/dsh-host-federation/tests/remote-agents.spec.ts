import { describe, expect, it } from 'vitest'
import {
  buildRemoteAgentsPatchYaml,
  enabledRemotePresetIds,
  parseRemoteAgentSelection,
} from '../src/ssh/remote-agents.ts'

describe('remote agent deploy selection', () => {
  it('defaults to all presets enabled', () => {
    expect(enabledRemotePresetIds()).toEqual(['acp-codex', 'acp-claude', 'acp-grok', 'acp-cursor'])
  })

  it('parses boolean map and preset id list', () => {
    expect(parseRemoteAgentSelection({ codex: true, claude: false })).toEqual({ codex: true, claude: false })
    expect(parseRemoteAgentSelection(['acp-grok', 'cursor'])).toEqual({
      codex: false,
      claude: false,
      grok: true,
      cursor: true,
    })
  })

  it('writes disable rows and PATH commands into the remote patch', () => {
    const yaml = buildRemoteAgentsPatchYaml({ claude: false, grok: false })
    expect(yaml).toContain('- id: acp-claude')
    expect(yaml).toContain('disabled: true')
    expect(yaml).toContain('command: codex-acp')
    expect(yaml).toContain('hideFromRoster: true')
    expect(yaml).toContain('command: cursor-agent')
    expect(yaml).not.toContain('command: claude-agent-acp')
  })
})
