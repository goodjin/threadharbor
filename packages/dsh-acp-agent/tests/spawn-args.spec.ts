/**
 * What a stdio agent is launched with.
 *
 * These are the facts that decide whether the child speaks ACP at all: the
 * subcommand that turns an interactive CLI into a service, and the environment
 * that must not follow it in from an IDE.
 */

import { describe, expect, it } from 'vitest'
import { stdioArgsFor, stdioEnvFor } from '../src/spawn-args.ts'

describe('stdioArgsFor', () => {
  it('gives each binary the arguments that make it an ACP service', () => {
    expect(stdioArgsFor('cursor')).toEqual(['acp', '--trust'])
    expect(stdioArgsFor('qoder')).toEqual(['--acp'])
  })

  it('adds nothing for binaries that are the service already', () => {
    expect(stdioArgsFor('claude')).toEqual([])
    expect(stdioArgsFor('codex')).toEqual([])
    expect(stdioArgsFor(undefined)).toEqual([])
  })
})

describe('stdioEnvFor', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/Users/someone',
    QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts',
    QODER_SDK_AUTH_PAYLOAD_FILE: '/tmp/payload.json',
    QODER_CONFIG_DIR: '/Users/someone/Library/Application Support/Qoder',
    QODERCN_WORKSPACE: '/Users/someone/project',
    __QODER_PID: '42',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    VSCODE_IPC_HOOK: '/tmp/vscode.sock',
    __CFBundleIdentifier: 'com.qoder.ide',
    UNRELATED: 'kept',
  }

  it('strips the IDE/SDK variables that stop Qoder from starting headless', () => {
    // Measured 2026-10-20: with these inherited, `qoderclicn --acp` exits with
    // "sdk_invalid_args: Agent SDK entrypoint env is set but required flags are
    // missing" before it reads a frame.
    const env = stdioEnvFor('qoder', base)
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/someone', UNRELATED: 'kept' })
  })

  it('inherits the environment for agents whose IDE does not inject startup flags', () => {
    expect(stdioEnvFor('claude', base)).toBeUndefined()
    expect(stdioEnvFor('cursor', base)).toBeUndefined()
    expect(stdioEnvFor(undefined, base)).toBeUndefined()
  })
})
