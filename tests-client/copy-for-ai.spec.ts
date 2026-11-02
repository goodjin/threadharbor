import { describe, expect, it } from 'vitest'
import {
  THREADHARBOR_OPS_DOC_PATH,
  buildOpsAiPrompt,
  buildPeerCheckAiPrompt,
} from '../src/copy-for-ai.ts'

describe('copy-for-ai prompts', () => {
  it('names the stable ops doc and omits secrets from host context', () => {
    const text = buildOpsAiPrompt({
      scenario: 'ssh-deploy',
      rawError: 'tar: Unexpected EOF',
      failedStep: 'installing',
      failedStepDetail: '正在安装',
      host: {
        hostId: 'bench',
        target: 'mini.example.ts.net',
        user: 'good',
        authMode: 'identityFile',
        identityFile: '/home/good/.ssh/id_ed25519',
      },
    })
    expect(text).toContain(THREADHARBOR_OPS_DOC_PATH)
    expect(text).toContain('tar: Unexpected EOF')
    expect(text).toContain('mini.example.ts.net')
    expect(text).not.toMatch(/password|BEGIN PRIVATE KEY/i)
  })

  it('builds peer-check prompt when a step failed', () => {
    const prompt = buildPeerCheckAiPrompt({
      ready: false,
      facts: {
        sshOk: false,
        tailscaleInstalled: false,
        peer: { pluginsInstalled: false, listen: 'loopback', port: 3081 },
        healthCode: 0,
        serveOther: false,
        port: 3081,
      },
      steps: [
        { id: 'ssh', state: 'fail', reason: 'auth', detail: 'Permission denied', actions: ['retry'] },
        { id: 'node', state: 'skip', actions: [] },
      ],
    }, undefined, { hostId: 'x', target: 'host' })
    expect(prompt).toBeDefined()
    expect(prompt).toContain('ssh')
    expect(prompt).toContain(THREADHARBOR_OPS_DOC_PATH)
  })
})
