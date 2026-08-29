import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigManager } from '../src/agent-config.ts'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function manager(): Promise<{ readonly root: string; readonly manager: AgentConfigManager }> {
  const root = await mkdtemp(join(tmpdir(), 'threadharbor-agent-config-'))
  roots.push(root)
  vi.stubEnv('CODEX_HOME', '')
  vi.stubEnv('GROK_HOME', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  return { root, manager: new AgentConfigManager({ homeDir: root, maxBytes: 4096 }) }
}

describe('AgentConfigManager', () => {
  it('reads and atomically writes only each Agent official user configuration path', async () => {
    const fixture = await manager()
    const codex = fixture.manager.read('codex')
    const grok = fixture.manager.read('grok')
    const claude = fixture.manager.read('claude')

    expect(codex).toMatchObject({ path: join(fixture.root, '.codex', 'config.toml'), format: 'toml', exists: false })
    expect(grok).toMatchObject({ path: join(fixture.root, '.grok', 'config.toml'), format: 'toml', exists: false })
    expect(claude).toMatchObject({ path: join(fixture.root, '.claude', 'settings.json'), format: 'json', exists: false })

    expect(fixture.manager.write('codex', 'model = "gpt-5"\n', codex.revision)).toMatchObject({
      exists: true, content: 'model = "gpt-5"\n',
    })
    expect(fixture.manager.write('grok', '[models]\ndefault = "grok-build"\n', grok.revision)).toMatchObject({
      exists: true, content: '[models]\ndefault = "grok-build"\n',
    })
    expect(fixture.manager.write('claude', '{"model":"sonnet"}\n', claude.revision)).toMatchObject({
      exists: true, content: '{"model":"sonnet"}\n',
    })
  })

  it('rejects invalid syntax, oversized content, and a stale editor revision', async () => {
    const fixture = await manager()
    const codex = fixture.manager.read('codex')
    expect(() => fixture.manager.write('codex', '[invalid', codex.revision)).toThrow()
    expect(() => fixture.manager.write('codex', 'x'.repeat(4097), codex.revision)).toThrow('4096-byte limit')

    const saved = fixture.manager.write('codex', 'model = "first"\n', codex.revision)
    expect(saved.revision).not.toBe(codex.revision)
    expect(() => fixture.manager.write('codex', 'model = "stale"\n', codex.revision)).toThrow('reload before saving')

    const claude = fixture.manager.read('claude')
    expect(() => fixture.manager.write('claude', '[]', claude.revision)).toThrow('JSON object')
  })
})
