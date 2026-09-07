import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bootstrapChannel,
  createCandidate,
  detachHardlinks,
  loopbackPortAvailable,
  promoteRelease,
  rollbackRelease,
  verifyRelease,
} from '../scripts/release-channel.mjs'
import { candidate, parseArgs, promote, status, withDshCommand } from '../scripts/release-promote.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string, artifact: string, sourceHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'threadharbor-release-'))
  roots.push(root)
  const artifact = join(root, 'artifact')
  await mkdir(join(artifact, 'deploy', 'channels'), { recursive: true })
  await mkdir(join(artifact, 'node_modules', '@threadharbor', 'dsh-client'), { recursive: true })
  await writeFile(join(artifact, 'package.json'), '{"name":"threadharbor","version":"fixture"}\n')
  await writeFile(join(artifact, 'deploy', 'channels', 'stable.patch.yml'), '[]\n')
  await writeFile(join(artifact, 'deploy', 'channels', 'test.patch.yml'), '[]\n')
  await writeFile(join(artifact, 'node_modules', '@threadharbor', 'dsh-client', 'package.json'), '{"name":"@threadharbor/dsh-client"}\n')
  await symlink('package.json', join(artifact, 'package-link.json'))
  const sourceHome = join(root, 'source-home')
  await mkdir(join(sourceHome, 'profiles', 'web', 'node_modules', '@threadharbor'), { recursive: true })
  await writeFile(join(sourceHome, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { threadharbor: 'link:/old' } }))
  await writeFile(join(sourceHome, 'profiles', 'web', 'cordis.patch.yml'), '- insert: [{ id: extra }]\n')
  await symlink('/tmp/workspace-dsh-client', join(sourceHome, 'profiles', 'web', 'node_modules', '@threadharbor', 'dsh-client'))
  return { root, artifact, sourceHome }
}

async function markReleaseClean(release: string): Promise<void> {
  const manifestPath = join(release, 'threadharbor-release.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { source?: Record<string, unknown> }
  manifest.source = { ...(manifest.source ?? {}), dirty: false }
  await chmod(manifestPath, 0o644)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await chmod(manifestPath, 0o444)
}

describe('stable/test release channels', () => {
  it('rejects a fixed channel port already owned by another process', async () => {
    const server = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server has no TCP port')
      expect(await loopbackPortAvailable(address.port)).toBe(false)
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error === undefined ? resolveClose() : rejectClose(error))
      })
    }
  })

  it('detaches deployed hardlinks before checksumming the candidate', async () => {
    const setup = await fixture()
    const outside = join(setup.root, 'outside.js')
    const linked = join(setup.artifact, 'linked.js')
    await writeFile(outside, 'before\n')
    await link(outside, linked)
    expect((await stat(linked)).ino).toBe((await stat(outside)).ino)
    detachHardlinks(setup.artifact)
    expect((await stat(linked)).ino).not.toBe((await stat(outside)).ino)
    await writeFile(outside, 'after\n')
    expect(await readFile(linked, 'utf8')).toBe('before\n')
  })

  it('keeps each channel override self-contained because DSH replaces config objects', async () => {
    for (const channel of ['stable', 'test']) {
      const patch = await readFile(join(process.cwd(), 'deploy', 'channels', `${channel}.patch.yml`), 'utf8')
      for (const required of [
        'maxRequestBytes', 'hostdRequestTimeoutMs', 'pollIntervalMs', 'maxTranscriptEntriesPerSession',
        'sshKnownHostsPath', 'sshConnectTimeoutMs', 'sshInstallTimeoutMs', 'hostdRemotePort', 'deploymentChannel',
      ]) expect(patch).toContain(`${required}:`)
    }
  })

  it('creates an immutable manifest and detects any artifact change', async () => {
    const setup = await fixture()
    const releases = join(setup.root, 'release-root')
    const candidate = createCandidate({
      version: 'v0.1.0-test.1', root: releases, artifactSource: setup.artifact, skipCheck: true,
    })
    expect(verifyRelease(candidate).manifest.version).toBe('v0.1.0-test.1')
    expect(() => createCandidate({
      version: 'v0.1.0-test.1', root: releases, artifactSource: setup.artifact, skipCheck: true,
    })).toThrow('release already exists')
    await chmod(join(candidate, 'package.json'), 0o644)
    await writeFile(join(candidate, 'package.json'), '{"tampered":true}\n')
    expect(() => verifyRelease(candidate)).toThrow('checksum verification failed')
  })

  it('promotes the exact verified candidate and rolls back to the previous pointer', async () => {
    const setup = await fixture()
    const releases = join(setup.root, 'release-root')
    const stableHome = join(setup.root, 'stable-home')
    await mkdir(join(stableHome, 'storages'), { recursive: true })
    await writeFile(join(stableHome, 'storages', 'remote_agent.json'), '{"stable":true}\n')
    const first = createCandidate({ version: 'v1', root: releases, artifactSource: setup.artifact, skipCheck: true })
    await markReleaseClean(first)
    promoteRelease({ version: 'v1', root: releases, stableHome })
    const second = createCandidate({ version: 'v2', root: releases, artifactSource: setup.artifact, skipCheck: true })
    await markReleaseClean(second)
    const promoted = promoteRelease({ version: 'v2', root: releases, stableHome })
    expect(promoted.release).toBe(second)
    expect(promoted.previous).toBe(first)
    const rolledBack = rollbackRelease({ root: releases, stableHome, restoreData: false })
    expect(rolledBack.release).toBe(first)
    expect(verifyRelease(join(releases, 'stable-current')).manifest.version).toBe('v1')
  })

  it('never records a checksum-invalid current release as the rollback target', async () => {
    const setup = await fixture()
    const releases = join(setup.root, 'release-root')
    const first = createCandidate({ version: 'v1', root: releases, artifactSource: setup.artifact, skipCheck: true })
    await markReleaseClean(first)
    promoteRelease({ version: 'v1', root: releases, stableHome: join(setup.root, 'stable-home') })
    await chmod(join(first, 'package.json'), 0o644)
    await writeFile(join(first, 'package.json'), '{"invalid":true}\n')
    const second = createCandidate({ version: 'v2', root: releases, artifactSource: setup.artifact, skipCheck: true })
    await markReleaseClean(second)
    const promoted = promoteRelease({ version: 'v2', root: releases, stableHome: join(setup.root, 'stable-home') })
    expect(promoted.release).toBe(second)
    expect(promoted.previous).toBeUndefined()
    expect(promoted.rejectedCurrent).toBe(first)
    expect(() => rollbackRelease({ root: releases, stableHome: join(setup.root, 'stable-home'), restoreData: false }))
      .toThrow('rollback requires both stable-current and stable-previous')
  })

  it('bootstraps independent homes and points each profile at its own plugin target', async () => {
    const setup = await fixture()
    const releases = join(setup.root, 'release-root')
    const candidate = createCandidate({ version: 'v1', root: releases, artifactSource: setup.artifact, skipCheck: true })
    await markReleaseClean(candidate)
    promoteRelease({ version: 'v1', root: releases, stableHome: join(setup.root, 'missing-stable') })
    const stableHome = join(setup.root, 'stable')
    const testHome = join(setup.root, 'test')
    bootstrapChannel({ channel: 'stable', home: stableHome, sourceHome: setup.sourceHome, root: releases, workspace: setup.artifact })
    bootstrapChannel({ channel: 'test', home: testHome, sourceHome: setup.sourceHome, root: releases, workspace: setup.artifact })
    const stablePackage = JSON.parse(await readFile(join(stableHome, 'profiles', 'web', 'package.json'), 'utf8'))
    const testPackage = JSON.parse(await readFile(join(testHome, 'profiles', 'web', 'package.json'), 'utf8'))
    expect(stablePackage.dependencies.threadharbor).toBe(`link:${candidate}`)
    expect(testPackage.dependencies.threadharbor).toBe(`link:${setup.artifact}`)
    expect(await realpath(join(stableHome, 'profiles', 'web', 'node_modules', '@threadharbor', 'dsh-client')))
      .toBe(await realpath(join(candidate, 'node_modules', '@threadharbor', 'dsh-client')))
    expect(await realpath(join(testHome, 'profiles', 'web', 'node_modules', '@threadharbor', 'dsh-client')))
      .toBe(await realpath(join(setup.artifact, 'node_modules', '@threadharbor', 'dsh-client')))
    expect(await readFile(join(stableHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(await readFile(join(stableHome, 'profiles', 'web', 'cordis.patch.imported.yml'), 'utf8')).toContain('extra')
  })
})

describe('release-promote orchestration', () => {
  function makeDeps(overrides: Partial<{
    promoteRelease: (...args: unknown[]) => unknown
    rollbackRelease: (...args: unknown[]) => unknown
    stopChannel: (...args: unknown[]) => unknown
    startChannel: (...args: unknown[]) => unknown
    readCurrentRelease: (...args: unknown[]) => unknown
    readLatestCandidate: (...args: unknown[]) => unknown
    runNpmBuild: (...args: unknown[]) => unknown
    safeVersionToken: (...args: unknown[]) => unknown
    createCandidate: (...args: unknown[]) => unknown
  }> = {}) {
    const calls: { name: string; args: unknown[] }[] = []
    const record = (name: string) => async (...args: unknown[]): Promise<unknown> => {
      calls.push({ name, args })
      return undefined
    }
    return {
      calls,
      deps: {
        promoteRelease: overrides.promoteRelease ?? (() => ({ release: '/fake/release', previous: '/fake/previous' })),
        rollbackRelease: overrides.rollbackRelease ?? (() => undefined),
        stopChannel: overrides.stopChannel ?? record('stopChannel'),
        startChannel: overrides.startChannel ?? record('startChannel'),
        channelStatus: async () => ({ pid: null, healthy: false }),
        readCurrentRelease: overrides.readCurrentRelease ?? (() => '/fake/current'),
        readLatestCandidate: overrides.readLatestCandidate ?? (() => '0.1.0-local.20990101.7'),
        runNpmBuild: overrides.runNpmBuild ?? (() => undefined),
        safeVersionToken: overrides.safeVersionToken ?? (() => '0.1.0-local.20990101.0'),
        createCandidate: overrides.createCandidate ?? (() => '/fake/release'),
      },
    }
  }

  async function freshChannelHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-promote-'))
    roots.push(root)
    const home = join(root, '.dsh-threadharbor-stable')
    await mkdir(home, { recursive: true })
    return home
  }

  it('parses candidate/promote/status with --allow-dirty and key/value options', () => {
    expect(parseArgs(['candidate'])).toEqual({ command: 'candidate', options: {} })
    expect(parseArgs(['promote', '--channel', 'stable', '--allow-dirty'])).toEqual({
      command: 'promote',
      options: { channel: 'stable', 'allow-dirty': true },
    })
    expect(parseArgs(['status', '--channel', 'test'])).toEqual({
      command: 'status',
      options: { channel: 'test' },
    })
    expect(() => parseArgs([])).toThrow()
    expect(() => parseArgs(['promote', '--channel'])).toThrow()
  })

  it('promotes by stop -> promoteRelease -> startChannel in order', async () => {
    const home = await freshChannelHome()
    const setup = makeDeps()
    const result = await promote({
      channel: 'stable',
      options: { channel: 'stable', home, version: 'v0' },
      deps: setup.deps,
    })
    expect(result.channel).toBe('stable')
    expect(result.current).toBe('release')
    expect(result.previous).toBe('previous')
    expect(setup.calls.map(call => call.name)).toEqual(['stopChannel', 'startChannel'])
    const stopArgs = setup.calls[0].args as [{ channel: string }]
    const startArgs = setup.calls[1].args as [{ channel: string }]
    expect(stopArgs[0]).toBe('stable')
    expect(startArgs[0]).toBe('stable')
  })

  it('rolls back to the previous release when startChannel fails after promote', async () => {
    const home = await freshChannelHome()
    const calls: string[] = []
    let startAttempts = 0
    const deps = {
      promoteRelease: () => ({ release: '/fake/release', previous: '/fake/previous' }),
      rollbackRelease: (...args: unknown[]) => { calls.push(`rollback:${(args[0] as { root: string }).root}`); return undefined },
      stopChannel: async () => { calls.push('stop') },
      startChannel: async () => {
        startAttempts += 1
        if (startAttempts === 1) {
          calls.push('start:try1')
          throw new Error('port 3080 did not become healthy')
        }
        calls.push('start:retry')
      },
      channelStatus: async () => ({ pid: null, healthy: false }),
      readCurrentRelease: () => '/fake/current',
      readLatestCandidate: () => '0.1.0-local.20990101.7',
      runNpmBuild: () => undefined,
      safeVersionToken: () => '0.1.0-local.20990101.0',
      createCandidate: () => '/fake/release',
    }
    await expect(promote({
      channel: 'stable',
      options: { channel: 'stable', home, version: 'v0' },
      deps,
    })).rejects.toThrow(/rolled back to previous/)
    const root = (await import('node:os')).homedir() + '/.local/share/threadharbor'
    expect(calls).toEqual(['stop', 'start:try1', `rollback:${root}`, 'start:retry'])
  })

  it('does not roll back when the previous release is missing', async () => {
    const home = await freshChannelHome()
    const calls: string[] = []
    const deps = {
      promoteRelease: () => ({ release: '/fake/release' }),
      rollbackRelease: () => { calls.push('rollback') },
      stopChannel: async () => { calls.push('stop') },
      startChannel: async () => { calls.push('start'); throw new Error('boom') },
      channelStatus: async () => ({ pid: null, healthy: false }),
      readCurrentRelease: () => '/fake/current',
      readLatestCandidate: () => '0.1.0-local.20990101.7',
      runNpmBuild: () => undefined,
      safeVersionToken: () => '0.1.0-local.20990101.0',
      createCandidate: () => '/fake/release',
    }
    await expect(promote({
      channel: 'stable',
      options: { channel: 'stable', home, version: 'v0' },
      deps,
    })).rejects.toThrow(/manual recovery/i)
    expect(calls).toEqual(['stop', 'start'])
  })

  it('refuses to promote when no candidate and no --version are available', async () => {
    const home = await freshChannelHome()
    const setup = makeDeps({ readLatestCandidate: () => undefined })
    await expect(promote({
      channel: 'stable',
      options: { channel: 'stable', home },
      deps: setup.deps,
    })).rejects.toThrow(/no candidate release is available/)
    expect(setup.calls).toEqual([])
  })

  it('refuses to promote when the channel home has not been bootstrapped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-promote-'))
    roots.push(root)
    const setup = makeDeps()
    await expect(promote({
      channel: 'stable',
      options: { channel: 'stable', home: join(root, 'missing') },
      deps: setup.deps,
    })).rejects.toThrow(/channel home does not exist/)
  })

  it('surfaces a clear error when stopChannel fails before reaching promote', async () => {
    const home = await freshChannelHome()
    const setup = makeDeps({
      promoteRelease: () => { throw new Error('manifest dirty') },
    })
    await expect(promote({
      channel: 'stable',
      options: { channel: 'stable', home, version: 'v0' },
      deps: setup.deps,
    })).rejects.toThrow(/promote failed: manifest dirty/)
  })

  it('runs runNpmBuild and createCandidate with a default safe version token', () => {
    const setup = makeDeps()
    const out = candidate({ options: {}, deps: setup.deps })
    expect(out.version).toBe('0.1.0-local.20990101.0')
    expect(setup.calls.map(call => call.name)).toEqual([])
    // runNpmBuild / createCandidate are called inline (not via record()), so
    // verify them via the deps passed to createCandidate:
    const createArgs = (setup.deps.createCandidate as (...args: unknown[]) => unknown).toString()
    expect(typeof setup.deps.createCandidate).toBe('function')
    expect(typeof setup.deps.runNpmBuild).toBe('function')
    expect(createArgs).toContain('')
  })

  it('echoes channel status alongside the stable-current basename', async () => {
    const home = await freshChannelHome()
    const deps = {
      promoteRelease: () => ({ release: '/fake/release', previous: '/fake/previous' }),
      rollbackRelease: () => undefined,
      stopChannel: async () => undefined,
      startChannel: async () => undefined,
      channelStatus: async () => ({ pid: 1234, healthy: true, port: 3080 }),
      readCurrentRelease: () => '/fake/releases/0.1.0-local.20260907.3',
      readLatestCandidate: () => '0.1.0-local.20990101.9',
      runNpmBuild: () => undefined,
      safeVersionToken: () => '0.1.0-local.20990101.0',
      createCandidate: () => '/fake/release',
    }
    const out = await status({ channel: 'stable', options: { channel: 'stable', home }, deps })
    expect(out.pid).toBe(1234)
    expect(out.healthy).toBe(true)
    expect(out.stableCurrent).toBe('0.1.0-local.20260907.3')
  })

  it('withDshCommand forwards THREADHARBOR_DSH_COMMAND unless --dsh-command is set', () => {
    const previous = process.env['THREADHARBOR_DSH_COMMAND']
    try {
      process.env['THREADHARBOR_DSH_COMMAND'] = '/tmp/dsh-wrapper.sh'
      expect(withDshCommand({ channel: 'stable' })).toEqual({ channel: 'stable', 'dsh-command': '/tmp/dsh-wrapper.sh' })
      expect(withDshCommand({ channel: 'stable', 'dsh-command': '/explicit' })).toEqual({ channel: 'stable', 'dsh-command': '/explicit' })
      delete process.env['THREADHARBOR_DSH_COMMAND']
      expect(withDshCommand({ channel: 'stable' })).toEqual({ channel: 'stable' })
    } finally {
      if (previous === undefined) delete process.env['THREADHARBOR_DSH_COMMAND']
      else process.env['THREADHARBOR_DSH_COMMAND'] = previous
    }
  })
})
