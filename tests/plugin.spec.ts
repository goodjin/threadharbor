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
    // Every @threadharbor package the composition names must be declared here:
    // a linked install resolves the patch's rows through these dependencies,
    // and configureProfile mirrors this same scoped set into the profile —
    // an undeclared package loads nowhere and the pruning deletes its link.
    expect(manifest.dependencies).toEqual({
      '@threadharbor/dsh-client': 'workspace:^',
      '@threadharbor/dsh-host-federation': 'workspace:^',
      '@threadharbor/dsh-mobile-entry': 'workspace:^',
      '@threadharbor/dsh-mobile-relay': 'workspace:^',
      '@threadharbor/dsh-preset-dispatch': 'workspace:^',
    })

    // The stock sidebar stays enabled. It used to be disabled, because the
    // hostd-backed sidebar replaced it; with hostd gone the ACP sessions are
    // ordinary DSH sessions, and the stock surface is the correct one for them.
    // ui-conversation must stay enabled since dsh 0.1.5: the stock chat, goal,
    // trajectory, deliverables and workflow-run panels consume its
    // `uiConversation` service and never activate when it is disabled.
    const patch = readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8')
    expect(patch).not.toContain('- id: ui-sidebar\n  disabled: true')
    expect(patch).not.toContain('- id: ui-conversation\n  disabled: true')
    for (const runtimeOwner of ['agent-loop', 'workspace', 'cordis-host-runner']) {
      expect(patch).not.toContain(`- id: ${runtimeOwner}\n  disabled: true`)
    }
    expect(patch).toContain("- id: threadharbor-client\n      name: '@threadharbor/dsh-client'")
    expect(patch).toContain("threadharbor-ssh-deploy")
    expect(patch).toContain("threadharbor-mobile-relay")

    // Phase 6 removed the hostd gateway. Agents run as in-process ACP plugins
    // on the machine serving the page, so there is no remote host to proxy to
    // and nothing for a host plugin to register. Both halves of that are
    // asserted so the old wiring cannot quietly come back.
    expect(patch).not.toContain('threadharbor-gateway')
    // Configuration, not the word: the file explains in a comment why the
    // gateway is gone, and a comment is not wiring.
    for (const hostdSetting of ['hostdRequestTimeoutMs', 'hostdRemotePort', 'sshKnownHostsPath']) {
      expect(patch).not.toContain(hostdSetting)
    }
  })
})
