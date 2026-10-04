import { describe, expect, it } from 'vitest'

import {
  BACKUP_SUFFIX,
  BLOCK_BEGIN,
  BLOCK_END,
  PATCHED_ENTRY_ID,
  managedBlock,
  parseScalar,
  readEntry,
  stripManagedBlock,
  withManagedBlock,
} from '../deploy/acp-stream/install.mjs'

const STOCK_DUMP = `# == @deepseek-ai/dsh-acp-app
- id: acp-app-startup
  name: '@deepseek-ai/dsh-acp-app'
# == @deepseek-ai/dsh-acp-app
- id: acp
  name: '@deepseek-ai/dsh-acp'
  inject:
    - acpAppStartup
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
# == somewhere/else
- id: tail
  name: '@deepseek-ai/dsh-llm'
`

const FRESH_PROFILE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists, \`!!js\` expressions allowed).
[]
`

describe('dump scalar parsing', () => {
  it('reads YAML single quotes, JSON double quotes and bare values', () => {
    expect(parseScalar("'@deepseek-ai/dsh-acp'")).toBe('@deepseek-ai/dsh-acp')
    expect(parseScalar('"a b"')).toBe('a b')
    expect(parseScalar('42')).toBe('42')
    expect(parseScalar(undefined)).toBe('')
  })

  it('unescapes doubled single quotes', () => {
    expect(parseScalar("'it''s'")).toBe("it's")
  })
})

describe('reading the stock acp entry out of a dump', () => {
  it('captures name, inject list and config map', () => {
    const entry = readEntry(STOCK_DUMP, 'acp')
    expect(entry).toEqual({
      id: 'acp',
      name: '@deepseek-ai/dsh-acp',
      inject: ['acpAppStartup'],
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
  })

  it('joins a folded scalar, which is how long module paths come back', () => {
    const dump = `- id: ${PATCHED_ENTRY_ID}
  name: >-
    file:///tmp/home/profiles/acp/threadharbor-acp-stream/acp-stream-entry.mjs
  inject:
    - acpAppStartup
`
    expect(readEntry(dump, PATCHED_ENTRY_ID).name)
      .toBe('file:///tmp/home/profiles/acp/threadharbor-acp-stream/acp-stream-entry.mjs')
  })

  it('stops at the next entry and at the next section header', () => {
    const entry = readEntry(STOCK_DUMP, 'acp')
    expect(entry.config).not.toHaveProperty('name')
  })

  it('throws rather than guessing for a missing entry', () => {
    expect(() => readEntry(STOCK_DUMP, 'nope')).toThrow(/not in the dump/)
  })

  it('throws on a top-level key it does not understand', () => {
    const dump = "- id: acp\n  name: 'x'\n  surprise: true\n"
    expect(() => readEntry(dump, 'acp')).toThrow(/unrecognised dump key/)
  })

  it('throws on a nested line it cannot place', () => {
    const dump = "- id: acp\n  name: 'x'\n  config:\n      deeper: 1\n"
    expect(() => readEntry(dump, 'acp')).toThrow(/unrecognised dump line/)
  })

  it('accepts the real keys a dump entry can carry', () => {
    const dump = "- id: acp\n  name: 'x'\n  disabled: true\n  group: true\n"
    expect(() => readEntry(dump, 'acp')).not.toThrow()
  })
})

describe('managed block', () => {
  const stock = readEntry(STOCK_DUMP, 'acp')
  const block = managedBlock(stock, './threadharbor-acp-stream/acp-stream-entry.mjs')

  it('disables the stock entry and inserts the replacement with mirrored options', () => {
    expect(block).toContain('- id: acp\n  disabled: true')
    expect(block).toContain(`- id: ${PATCHED_ENTRY_ID}`)
    expect(block).toContain('name: "./threadharbor-acp-stream/acp-stream-entry.mjs"')
    expect(block).toContain('inject: [acpAppStartup]')
    expect(block).toContain('config:')
    expect(block).toContain('provider: "deepseek-official"')
    expect(block).toContain('model: "deepseek-v4-flash"')
  })

  it('drops the config section when the stock entry has none', () => {
    const bare = managedBlock({ id: 'acp', name: '@deepseek-ai/dsh-acp', inject: [], config: {} }, './x.mjs')
    expect(bare).not.toContain('config:')
    expect(bare).not.toContain('inject:')
  })
})

describe('profile file composition', () => {
  const block = managedBlock(
    readEntry(STOCK_DUMP, 'acp'),
    './threadharbor-acp-stream/acp-stream-entry.mjs',
  )

  it('keeps the profile header and drops only the bare []', () => {
    const composed = withManagedBlock(FRESH_PROFILE, block)
    expect(composed).toContain('# Your patch layer for this dsh profile')
    expect(composed).not.toMatch(/^\[\]$/m)
    expect(composed.split('\n').filter((line) => line.trim() === '- id: acp')).toHaveLength(1)
  })

  it('keeps real entries from a profile that already has some', () => {
    const existing = "- id: session-title-llm\n  disabled: true\n"
    const composed = withManagedBlock(existing, block)
    expect(composed).toContain('- id: session-title-llm')
    expect(composed).toContain(BLOCK_BEGIN)
  })

  it('is idempotent: reinstalling replaces the block instead of stacking it', () => {
    const once = withManagedBlock(FRESH_PROFILE, block)
    const twice = withManagedBlock(once, block)
    expect(twice).toBe(once)
    expect(twice.split(BLOCK_BEGIN)).toHaveLength(2)
  })

  it('leaves only the original header behind once the block is removed', () => {
    const composed = withManagedBlock(FRESH_PROFILE, block)
    const stripped = stripManagedBlock(composed)
    expect(stripped).not.toContain(BLOCK_BEGIN)
    expect(stripped).toContain('# Your patch layer for this dsh profile')
    // Uninstall restores the byte-exact original from the .bak instead; the
    // stripped form is the fallback when no backup exists.
    expect(stripped.replace(/\n+$/, '')).toBe(FRESH_PROFILE.replace(/^\[\]\n/m, '').replace(/\n+$/, ''))
  })

  it('leaves an unpatched file untouched', () => {
    expect(stripManagedBlock(FRESH_PROFILE)).toBe(FRESH_PROFILE)
  })

  it('removes the block even when the file was edited around it', () => {
    const edited = `# hand edit\n${block}\n- id: later\n  name: 'x'\n`
    expect(stripManagedBlock(edited)).toBe('# hand edit\n\n- id: later\n  name: \'x\'\n')
  })

  it('names a backup suffix that cannot collide with a real patch file', () => {
    expect(BACKUP_SUFFIX).toBe('.th-acp-stream.bak')
    expect(BLOCK_END).toContain('threadharbor')
  })
})
