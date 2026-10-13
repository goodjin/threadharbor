import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseSshInput } from '../src/ssh/parse.ts'

describe('parseSshInput', () => {
  it('requires authentication material', () => {
    expect(() => parseSshInput({ target: 'example.test' }, false)).toThrow(/authentication/)
  })

  it('accepts identity file paths on the web host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'th-ssh-'))
    const identityFile = join(dir, 'id')
    writeFileSync(identityFile, 'key\n', { mode: 0o600 })
    expect(parseSshInput({
      target: 'example.test',
      identityFile,
    }, false).target).toBe('example.test')
  })

  it('requires fingerprint when approved', () => {
    expect(() => parseSshInput({
      target: 'example.test',
      identityPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    }, true)).toThrow(/hostKeyFingerprint/)
  })
})
