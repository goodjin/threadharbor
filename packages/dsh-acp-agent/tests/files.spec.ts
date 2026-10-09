/**
 * Serving the ACP file sub-protocol.
 *
 * Declaring a capability we do not serve is worse than not declaring it: the
 * agent picks the tool, spends a turn on it, and only then finds out. grok does
 * exactly this — it reaches for the file API first, and only falls back to a
 * shell command once the first attempt fails. Answering with a clear error is
 * what lets it move on.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsService } from '../src/files.ts'

const service = () => new FsService()

describe('FsService', () => {
  it('reads a text file', async () => {
    const path = `/tmp/fs-spec-${String(process.pid)}.txt`
    await writeFile(path, 'hello')
    expect(await service().readTextFile({ path })).toBe('hello')
  })

  it('writes a text file, making the directory it needs', async () => {
    // Agents write into a workspace they were just given, so the parent may not
    // exist yet; failing here is a failure the agent cannot work around.
    const path = `/tmp/fs-spec-${String(process.pid)}/nested/out.txt`
    await service().writeTextFile({ path, content: 'hi' })
    expect(await readFile(path, 'utf8')).toBe('hi')
  })

  it('says what went wrong instead of failing blankly', async () => {
    // The agent reads this text and decides what to do next, so "no such file"
    // is useful and an empty string is not.
    await expect(service().readTextFile({ path: '/tmp/does-not-exist-xyz' }))
      .rejects.toThrow(/does-not-exist-xyz/)
  })

  it('reports a missing path rather than reading nothing', async () => {
    await expect(service().readTextFile({} as { path: string })).rejects.toThrow()
  })

  it('creates the parent directory only as deep as the file needs', async () => {
    const path = `/tmp/fs-spec-${String(process.pid)}-deep/a/b/c.txt`
    await service().writeTextFile({ path, content: 'x' })
    expect(await readFile(path, 'utf8')).toBe('x')
  })
})