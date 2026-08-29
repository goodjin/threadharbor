/** ThreadHarbor replaces only the stock Web surfaces and mounts its two owners. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('remote Web bundle', () => {
  it('declares a standard out-of-tree bundle and leaves the Harness runtime mounted', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@threadharbor/dsh-client': 'workspace:^',
      '@threadharbor/dsh-gateway': 'workspace:^',
    })

    const patch = readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8')
    for (const localOwner of ['ui-sidebar', 'ui-conversation']) {
      expect(patch).toContain(`- id: ${localOwner}\n  disabled: true`)
    }
    for (const runtimeOwner of ['agent-loop', 'workspace', 'cordis-host-runner']) {
      expect(patch).not.toContain(`- id: ${runtimeOwner}\n  disabled: true`)
    }
    expect(patch).toContain("- id: threadharbor-gateway\n      name: '@threadharbor/dsh-gateway'")
    expect(patch).toContain("- id: threadharbor-client\n      name: '@threadharbor/dsh-client'")
  })
})
