/**
 * Serving the ACP file sub-protocol.
 *
 * Declaring a capability we do not serve is worse than not declaring it: the
 * agent picks the tool, spends a turn on it, and only then finds out. grok does
 * exactly this — it reaches for the file API first and only falls back to a
 * shell command once the first attempt fails. Answering with a clear error is
 * what lets it move on; a blank failure is what makes it look stuck.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ReadTextFileRequest = { readonly path?: string; readonly line?: number; readonly limit?: number }
export type WriteTextFileRequest = { readonly path?: string; readonly content?: string }

export class FsService {
  /**
   * Read a file, optionally a window of it.
   *
   * The window is honoured in lines, because that is how the protocol counts;
   * without it an agent reading a large log pays for the whole file.
   */
  async readTextFile(request: ReadTextFileRequest): Promise<string> {
    const path = require_(request.path, 'fs/read_text_file path')
    const text = await readFile(path, 'utf8')
    const { line, limit } = request
    if (line === undefined && limit === undefined) return text
    // Both bounds count lines, and `line` is 1-based as the protocol defines it.
    const from = Math.max(0, (line ?? 1) - 1)
    const to = limit === undefined ? undefined : from + limit
    return text.split('\n').slice(from, to).join('\n')
  }

  /** Write a file, creating the directories it needs. */
  async writeTextFile(request: WriteTextFileRequest): Promise<void> {
    const path = require_(request.path, 'fs/write_text_file path')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, request.content ?? '', 'utf8')
  }
}

function require_(value: string | undefined, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is required`)
  return value
}