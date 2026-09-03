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
