import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hostdArtifactVersionFromDirectory,
  hostdVersionFromFiles,
  readHostdPackageVersion,
} from '../src/version.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hostd artifact version', () => {
  it('stays on the package version when no artifact files exist', () => {
    expect(hostdVersionFromFiles('0.1.0', ['/missing/bin.js'])).toBe('0.1.0')
  })

  it('changes when shipped JS changes so the web can show an upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-version-'))
    roots.push(root)
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ version: '0.1.0' })}\n`)
    const lib = join(root, 'lib')
    await mkdir(lib)
    await writeFile(join(lib, 'bin.js'), 'first\n')
    await writeFile(join(lib, 'hold-worker.js'), 'worker\n')
    const first = hostdArtifactVersionFromDirectory(lib)
    expect(first).toMatch(/^0\.1\.0\+[0-9a-f]{12}$/)
    expect(readHostdPackageVersion(join(root, 'package.json'))).toBe('0.1.0')

    await writeFile(join(lib, 'bin.js'), 'second\n')
    const second = hostdArtifactVersionFromDirectory(lib)
    expect(second).toMatch(/^0\.1\.0\+[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
  })
})
